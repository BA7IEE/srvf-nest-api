import { Injectable } from '@nestjs/common';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { parseExpandQuery } from '../../common/dto/expand-query.util';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { AttendanceAccessService, type PrismaTx } from './attendance-access.service';
import { AttendanceAuditRecorder } from './attendance-audit-recorder';
import { AttendancePresenter } from './attendance-presenter';
import {
  AttendanceSheetQueryService,
  recordWithMemberSelect,
} from './attendance-sheet-query.service';
import { computeCappedContribution } from '../team-join/team-join-progress';
import {
  type AdminAttendanceSheetListItemDto,
  type AdminMemberAttendanceRecordDto,
  type AttendanceRecordResponseDto,
  type AttendanceSheetActivitySummaryDto,
  type AttendanceSheetListItemDto,
  type AttendanceSheetResponseDto,
  type AttendanceSheetReviewDetailDto,
  type ListAttendanceSheetsQueryDto,
  type MemberContributionSummaryDto,
  type MyAttendanceRecordsQueryDto,
} from './attendances.dto';
import type { AttendanceAuthorization } from './attendances.service';

/*
 * 考勤的**读 surface 族**(Phase 6-B 第三域第一刀 stage3,§3.2)。
 *
 * 七条读路径:list(按活动)· listAllSheetsForAdmin(跨活动工作台)· listRecordsForMemberAdmin
 * (队员 360)· getMemberContributionSummary · findOne · reviewDetail · listMyRecords(队员端)。
 * 形态同构:**判权 → 交给 QueryService 取数 → 审计 logRead → presenter 序列化**。
 *
 * ⚠️ 与 attendance-sheet-query.service.ts 的分工是**刻意**的两层,不要合并:
 *   · QueryService 只管 where / select / orderBy / 分页的**查询构造**,不判权、不写审计;
 *   · 本层持有**判权腿**与**审计腿** —— 组织可见范围由 resolveVisibleOrganizationIds 在这里算好,
 *     作为入参传给 QueryService。合并两层就等于把判权下放进查询构造,
 *     那时任何新增查询方法都可能悄悄绕开判权(members #1008 先例)。
 *
 * ⚠️ 判权仍在各方法体内调用(this.access.assertCanOrThrow / 本类的 resolveVisibleOrganizationIds),
 * 不接受任何「上游已判过」的入参 —— 漏传即漏判权,而全仓单测可以零红。
 */
// expand 白名单:仅 listAllSheetsForAdmin 使用,随本族迁来(此前在 AttendancesService 模块级)。
const ATTENDANCE_EXPAND_WHITELIST = ['activity'] as const;

@Injectable()
export class AttendanceReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AttendanceAccessService,
    private readonly authz: AuthzService,
    private readonly organizations: OrganizationsService,
    private readonly attendanceSheetQuery: AttendanceSheetQueryService,
    private readonly attendancePresenter: AttendancePresenter,
    private readonly attendanceAuditRecorder: AttendanceAuditRecorder,
  ) {}

  // v0.49:扁平考勤工作台按 activity.organizationId 下推授权范围；用户显式组织筛选
  // 与授权组织集合取交集。GLOBAL 且无筛选时保持旧查询，不额外加 where。
  private async resolveVisibleOrganizationIds(
    currentUser: CurrentUserPayload,
    organizationId: string | undefined,
    includeDescendants: boolean | undefined,
  ): Promise<string[] | undefined> {
    const authScope = await this.authz.getVisibleOrganizationScope(
      currentUser,
      'attendance.read.sheet',
    );
    if (!authScope.hasPermission) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    const requestedOrgIds =
      organizationId === undefined
        ? undefined
        : includeDescendants
          ? await this.organizations.queryDescendantOrgIds(organizationId)
          : [organizationId];

    if (authScope.global) return requestedOrgIds;
    if (requestedOrgIds === undefined) return authScope.organizationIds;

    const visibleOrgIds = new Set(authScope.organizationIds);
    return requestedOrgIds.filter((id) => visibleOrgIds.has(id));
  }

  // ============ helpers:序列化 ============
  // 已抽至 `attendance-presenter.ts` 的 `AttendancePresenter`(P1-4 第一刀,2026-06-10
  // 方案 A 拍板;仅"搬家",字段映射 / Decimal 序列化语义零变化)。
  // 各路径通过 `this.attendancePresenter.toSheetResponseDto(...)` /
  // `.toSheetListItemDto(...)` / `.toRecordResponseDto(...)` / `.decimalToString(...)` 委托;
  // 事务边界与查询 select 策略不随迁,仍由本 service 持有。

  // ============ helpers:Activity / Sheet / Member 查找 ============

  // 批次 4-B 重构:findActivityForSubmission 旧版返回 {id, statusCode} 已被 findActivityForSubmissionFull
  // (返回 activityType/status/time-window)替代，用于 D14 预填与参与状态/时间窗校验；旧函数删除。

  private async assertActivityExists(activityId: string, tx: PrismaTx): Promise<void> {
    const act = await tx.activity.findFirst({
      where: notDeletedWhere({ id: activityId }),
      select: { id: true },
    });
    if (!act) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }

  // 队员端 currentUser → memberId(沿批次 3A `resolveUserMemberIdOrThrow` 范式)。
  private async resolveUserMemberIdOrThrow(userId: string, tx: PrismaTx): Promise<string> {
    const u = await tx.user.findFirst({
      where: notDeletedWhere({ id: userId }),
      select: { memberId: true },
    });
    if (!u || u.memberId === null) {
      throw new BizException(BizCode.MEMBER_NOT_FOUND);
    }
    return u.memberId;
  }

  // ============ list(GET 列表)============

  async list(
    activityId: string,
    query: ListAttendanceSheetsQueryDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: AttendanceAuthorization = 'authz',
  ): Promise<PageResultDto<AttendanceSheetListItemDto>> {
    await this.access.assertCanOrThrow(currentUser, 'attendance.read.sheet', {
      type: 'activity',
      id: activityId,
    });
    if (authorization === 'managed') {
      await this.access.assertManagedAttendanceAccess(activityId, currentUser);
    }
    await this.prisma.$transaction(async (tx) => {
      await this.assertActivityExists(activityId, tx);
    });

    const { page, pageSize, statusCode } = query;
    const { items: rows, total } = await this.attendanceSheetQuery.listSheetsByActivity(
      activityId,
      query,
    );

    await this.attendanceAuditRecorder.logRead({
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'activity',
      resourceId: activityId,
      operation: 'list',
      count: rows.length,
      filterFields: statusCode === undefined ? [] : ['statusCode'],
      auditMeta,
    });

    return {
      items: rows.map((r) => this.attendancePresenter.toSheetListItemDto(r)),
      total,
      page,
      pageSize,
    };
  }

  // ============ 跨轴只读:跨活动考勤单据横扫(Tier2 审批工作台)============

  // 2026-06-23 跨轴只读(GET admin/v1/attendance-sheets):脱离 :activityId 路径段,按 statusCode
  // 跨所有活动横扫考勤单据(审批工作台)。判权复用 read 码;item 自带 activity 上下文。
  // 序列化复用 presenter.toSheetListItemDto + activityTitle;既有 list(activityId,...) 行为零变更。
  // F2/B2(admin-api-fe-integration-roadmap.md §4 B2;D1/D6/D7 拍板,2026-07-04):+可选
  // q/activityQ/organizationId/includeDescendants/dateFrom/dateTo/expand。全部省略时行为逐字
  // 不变(additive)。q/submitter 搜索命中提交人 User.username/nickname(AttendanceSheet 本身无
  // 提交人姓名冗余字段,经既有 submitter 关联 join 过滤,零新 select 字段、零 N+1)。
  async listAllSheetsForAdmin(
    query: ListAttendanceSheetsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminAttendanceSheetListItemDto>> {
    const { page, pageSize, organizationId, includeDescendants, expand } = query;
    const visibleOrganizationIds = await this.resolveVisibleOrganizationIds(
      currentUser,
      organizationId,
      includeDescendants,
    );
    const expandSet = parseExpandQuery(expand, ATTENDANCE_EXPAND_WHITELIST);

    const { items: rows, total } = await this.attendanceSheetQuery.listSheetsForAdmin(
      query,
      visibleOrganizationIds,
    );

    return {
      items: rows.map((r) => ({
        ...this.attendancePresenter.toSheetListItemDto(r),
        activityTitle: r.activity?.title ?? null,
        ...(expandSet.has('activity') && r.activity
          ? {
              activity: {
                id: r.activity.id,
                title: r.activity.title,
                startAt: r.activity.startAt,
                organizationId: r.activity.organizationId,
              },
            }
          : {}),
      })),
      total,
      page,
      pageSize,
    };
  }

  // ============ 跨轴只读:某队员考勤记录(Tier3 队员 360)============

  // 2026-06-23 跨轴只读(GET admin/v1/members/:memberId/attendance-records):某队员跨 sheet
  // 考勤记录(队员 360「考勤记录」tab)。仅返 approved Sheet 内 records(镜像 app /me Q-A14:
  // 已生效记录,不暴露 pending / rejected);MEMBER_NOT_FOUND 守卫;判权复用 read 码;
  // 序列化复用 presenter.toRecordResponseDto + activityId/activityTitle 跨轴上下文。
  async listRecordsForMemberAdmin(
    memberId: string,
    query: PaginationQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminMemberAttendanceRecordDto>> {
    await this.access.assertCanOrThrow(currentUser, 'attendance.read.sheet', {
      type: 'member',
      id: memberId,
    });
    // 队员存在性守卫(不存在 / 软删 → 15001,镜像 admin-member-insurances inline 检查)。
    if (!(await this.attendanceSheetQuery.memberExists(memberId))) {
      throw new BizException(BizCode.MEMBER_NOT_FOUND);
    }

    const { page, pageSize } = query;
    const { items: rows, total } = await this.attendanceSheetQuery.listApprovedRecordsForMember(
      memberId,
      query,
    );

    return {
      items: rows.map((r) => ({
        ...this.attendancePresenter.toRecordResponseDto(r),
        activityId: r.sheet.activityId,
        activityTitle: r.sheet.activity?.title ?? null,
      })),
      total,
      page,
      pageSize,
    };
  }

  // ============ 跨轴只读:某队员贡献值生涯累计(Tier3 队员 360)============

  // 2026-06-23 跨轴只读(GET admin/v1/members/:memberId/contribution-summary):某队员贡献值
  // 生涯累计 capped 总分(队员 360「贡献值」tab)。实时算不落库,复用 team-join 封顶核
  // computeCappedContribution(approved sheet + 全局每日封顶 3,生涯无 cutoff);**禁裸 SUM**
  // ——绕过封顶会算多。MEMBER_NOT_FOUND 守卫;判权复用 attendance.read.sheet。
  async getMemberContributionSummary(
    memberId: string,
    currentUser: CurrentUserPayload,
  ): Promise<MemberContributionSummaryDto> {
    await this.access.assertCanOrThrow(currentUser, 'attendance.read.sheet', {
      type: 'member',
      id: memberId,
    });
    if (!(await this.attendanceSheetQuery.memberExists(memberId))) {
      throw new BizException(BizCode.MEMBER_NOT_FOUND);
    }

    const points = await computeCappedContribution(this.prisma, memberId, null);
    return { memberId, contributionPoints: points.toString() };
  }

  // ============ findOne(GET Sheet 简化详情)============

  async findOne(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    managedActivityId?: string,
  ): Promise<AttendanceSheetResponseDto> {
    await this.access.assertCanOrThrow(currentUser, 'attendance.read.sheet', {
      type: 'attendance_sheet',
      id,
    });
    if (managedActivityId !== undefined) {
      await this.access.assertManagedAttendanceAccess(managedActivityId, currentUser);
    }
    const sheet = await this.prisma.$transaction(async (tx) =>
      this.access.findSheetOrThrow(id, tx),
    );
    this.access.assertManagedSheetActivity(sheet.activityId, managedActivityId);

    await this.attendanceAuditRecorder.logRead({
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'attendance_sheet',
      resourceId: id,
      operation: 'detail',
      auditMeta,
    });

    return this.attendancePresenter.toSheetResponseDto(sheet);
  }

  // ============ reviewDetail(GET 完整审核视图;R25)============

  async reviewDetail(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    managedActivityId?: string,
  ): Promise<AttendanceSheetReviewDetailDto> {
    await this.access.assertCanOrThrow(currentUser, 'attendance.read.sheet', {
      type: 'attendance_sheet',
      id,
    });
    if (managedActivityId !== undefined) {
      await this.access.assertManagedAttendanceAccess(managedActivityId, currentUser);
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const sheet = await this.access.findSheetOrThrow(id, tx);
      this.access.assertManagedSheetActivity(sheet.activityId, managedActivityId);

      const activity = await tx.activity.findFirst({
        where: notDeletedWhere({ id: sheet.activityId }),
        select: {
          id: true,
          title: true,
          activityTypeCode: true,
          organizationId: true,
          startAt: true,
          endAt: true,
          location: true,
          statusCode: true,
        },
      });
      if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

      const records = await tx.attendanceRecord.findMany({
        where: notDeletedWhere({ sheetId: id }),
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });

      return { sheet, activity, records };
    });

    await this.attendanceAuditRecorder.logRead({
      actorUserId: currentUser.id,
      actorRoleSnap: currentUser.role,
      resourceType: 'attendance_sheet',
      resourceId: id,
      operation: 'review-detail',
      count: result.records.length,
      auditMeta,
    });

    return {
      activity: result.activity satisfies AttendanceSheetActivitySummaryDto,
      sheet: this.attendancePresenter.toSheetResponseDto(result.sheet),
      records: result.records.map((r) => this.attendancePresenter.toRecordResponseDto(r)),
    };
  }

  // ============ 队员端:listMyRecords(GET /me/attendance-records)============

  // Q-A14 / R29 / R33:仅返 approved Sheet 内 records。
  async listMyRecords(
    query: MyAttendanceRecordsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AttendanceRecordResponseDto>> {
    const memberId = await this.prisma.$transaction(async (tx) =>
      this.resolveUserMemberIdOrThrow(currentUser.id, tx),
    );

    const { page, pageSize } = query;
    const { items: rows, total } = await this.attendanceSheetQuery.listApprovedRecordsForSelf(
      memberId,
      query,
    );

    return {
      items: rows.map((r) => this.attendancePresenter.toRecordResponseDto(r)),
      total,
      page,
      pageSize,
    };
  }
}
