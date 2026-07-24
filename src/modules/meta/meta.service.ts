import { Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { DashboardSummaryResponseDto, ResolveLabelsDto } from './meta.dto';

// F1/A7(路线图 §4 A7;架构映射 §7):跨资源批量 id→label 解析。**只读、无 audit、无
// schema**;不复用其它模块的 service(镜像 authz/resource-resolver.service.ts 的自包含
// switch-per-type 范式),避免把 MetaModule 变成反向依赖一堆业务模块的 grab-bag。
//
// 两层权限(D5):① 入口码 meta.resolve.label(绑 ops-admin,诊断类通用码,门控"能否
// 调用本工具");② per-type 读权限(D2,复用各资源既有 .read.* 码,门控"能解析哪些
// type")——ops-admin 未必持有全部业务 .read.record(如 member.read.record 绑
// biz-admin),这是刻意的分层,不是缺口:入口码只保证"可用本诊断工具",具体能读到
// 什么仍由各资源自己的读权限决定。
//
// 每种 type 的最小回显字段集与对应资源的 /options 投影保持一致(同一份"轻量展示"约定,
// 非巧合)。resolveLabels 只做只读查询 + 权限过滤,不进任何判权路径。

type ResolvedLabelEntry = { label: string } & Record<string, unknown>;
type ResolveLabelsResult = Record<string, Record<string, ResolvedLabelEntry>>;

// per-type 读权限码(D2:复用各资源既有 .read.* 码,不新增);activity 现状无专属读码
// ——list/findOne 均无码仅登录(RBAC_MAP §2.4 BD-3 已决 won't-do 新增 activity.read.*:
// 活动详情 login-only 天然可读,新增读码属收紧而非 additive),故此处 null = 仅要求已登录
// (controller 入口 JwtAuthGuard 已保证),不额外调用 rbac.can。
const TYPE_READ_PERMISSION: Record<string, string | null> = {
  member: 'member.read.record',
  user: 'user.read.account',
  organization: 'org.read.node',
  role: 'rbac.role.read',
  position: 'position.read.definition',
  activity: null,
};

// 镜像 activities.service.ts 的 USER_VISIBLE_STATUS_CODES(Q-A7);不跨模块导入两个
// 字符串字面量,字典值一致性由 activities 自己的 e2e 覆盖。
const ACTIVITY_USER_VISIBLE_STATUS_CODES = ['published', 'completed'] as const;

// GAP-003 工作台/首页待办汇总(D5 同源静默省略,见 meta.dto.ts 头注):字典码字面量不跨
// 模块导入(镜像上一条 ACTIVITY_USER_VISIBLE_STATUS_CODES 的既有惯例),与 registrations
// (activity-registration.read.record)/attendance-sheets(attendance.read.sheet)两个扁平
// 跨轴列表(admin/v1/registrations · admin/v1/attendance-sheets)的 statusCode 过滤同值,
// 字典一致性由各自模块 e2e + 本端点的 count-vs-list-total 对账 e2e 双重覆盖。
const DASHBOARD_REGISTRATION_STATUS_PENDING = 'pending';
const DASHBOARD_REGISTRATION_STATUS_WAITLISTED = 'waitlisted';
const DASHBOARD_ATTENDANCE_SHEET_STATUS_PENDING = 'pending';
const DASHBOARD_ATTENDANCE_SHEET_STATUS_PENDING_FINAL_REVIEW = 'pending_final_review';
const DASHBOARD_ACTIVITY_STATUS_PUBLISHED = 'published';
const DASHBOARD_ACTIVITY_PUBLISH_REVIEW_STATUS_PENDING = 'pending';

@Injectable()
export class MetaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly authz: AuthzService,
  ) {}

  // per-type(非 per-record)读权限过滤 + 静默省略(D5/R13 防枚举):调用者对某 type
  // 无权 → 整个 type 跳过;某 id 不存在/软删 → 该 id 不出现在结果里。两者都不报错。
  async resolveLabels(
    user: CurrentUserPayload,
    dto: ResolveLabelsDto,
  ): Promise<ResolveLabelsResult> {
    if (!(await this.rbac.can(user, 'meta.resolve.label'))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    const idsByType = new Map<string, Set<string>>();
    for (const ref of dto.refs) {
      const set = idsByType.get(ref.type) ?? new Set<string>();
      set.add(ref.id);
      idsByType.set(ref.type, set);
    }

    const result: ResolveLabelsResult = {};
    for (const [type, idSet] of idsByType) {
      const requiredCode = TYPE_READ_PERMISSION[type];
      if (requiredCode === undefined) continue; // 白名单外(防御性;DTO @IsIn 已挡)
      if (requiredCode !== null && !(await this.rbac.can(user, requiredCode))) continue;

      const entries = await this.resolveType(type, [...idSet], user);
      if (Object.keys(entries).length > 0) result[type] = entries;
    }
    return result;
  }

  // GAP-003 + 活动责任闭环 PR-9:四块可省略聚合,块/字段权限裁剪(
  // registrations/attendanceSheets 兼容字段凭对应读码,pendingFirstReview 与
  // activityPublishReviews 分别凭一级审核/发布审核 action,
  // 并通过 getVisibleOrganizationScope 汇合 GLOBAL / 职务 / 分管三源,按 activity.organizationId
  // 下推与两个扁平跨轴列表完全相同的可见范围)。有码但无组织范围时保留块并返回零值；无码
  // 时整块省略、不报错。activities 无码(沿 activities list/detail/options 现状,任意已登录用户
  // 可见),响应恒 200(镜像 resolve-labels 静默省略哲学,唯一差异:本端点字段形状固定)。
  //
  // 先并发解析四码的三源组织范围，再并发执行最多 8 个 count(结构性零 N+1,无缓存/无物化——
  // 当前规模即时算)。GLOBAL / SUPER_ADMIN 不下推 activity where,保持旧全量计数逐字一致。
  async dashboardSummary(user: CurrentUserPayload): Promise<DashboardSummaryResponseDto> {
    const [registrationScope, attendanceScope, attendanceFirstReviewScope, publishReviewScope] =
      await Promise.all([
        this.authz.getVisibleOrganizationScope(user, 'activity-registration.read.record'),
        this.authz.getVisibleOrganizationScope(user, 'attendance.read.sheet'),
        this.authz.getVisibleOrganizationScope(user, 'attendance.approve.sheet'),
        this.authz.getVisibleOrganizationScope(user, 'activity-review.read.request'),
      ]);
    const registrationActivityScope = registrationScope.global
      ? {}
      : { activity: { organizationId: { in: registrationScope.organizationIds } } };
    const attendanceActivityScope = attendanceScope.global
      ? {}
      : { activity: { organizationId: { in: attendanceScope.organizationIds } } };
    const attendanceFirstReviewActivityScope = attendanceFirstReviewScope.global
      ? {}
      : { activity: { organizationId: { in: attendanceFirstReviewScope.organizationIds } } };
    const publishReviewActivityWhere = publishReviewScope.global
      ? {}
      : { organizationId: { in: publishReviewScope.organizationIds } };

    const [
      registrationsPending,
      registrationsWaitlisted,
      attendanceSheetsPending,
      attendanceSheetsPendingFirstReview,
      attendanceSheetsPendingFinalReview,
      activityPublishReviewsPending,
      activitiesPublished,
      activitiesPendingCompletion,
    ] = await Promise.all([
      this.prisma.activityRegistration.count({
        where: notDeletedWhere({
          statusCode: DASHBOARD_REGISTRATION_STATUS_PENDING,
          ...registrationActivityScope,
        }),
      }),
      this.prisma.activityRegistration.count({
        where: notDeletedWhere({
          statusCode: DASHBOARD_REGISTRATION_STATUS_WAITLISTED,
          ...registrationActivityScope,
        }),
      }),
      this.prisma.attendanceSheet.count({
        where: notDeletedWhere({
          statusCode: DASHBOARD_ATTENDANCE_SHEET_STATUS_PENDING,
          ...attendanceActivityScope,
        }),
      }),
      attendanceFirstReviewScope.hasPermission
        ? this.prisma.attendanceSheet.count({
            where: notDeletedWhere({
              statusCode: DASHBOARD_ATTENDANCE_SHEET_STATUS_PENDING,
              ...attendanceFirstReviewActivityScope,
            }),
          })
        : Promise.resolve(0),
      this.prisma.attendanceSheet.count({
        where: notDeletedWhere({
          statusCode: DASHBOARD_ATTENDANCE_SHEET_STATUS_PENDING_FINAL_REVIEW,
          ...attendanceActivityScope,
        }),
      }),
      publishReviewScope.hasPermission
        ? this.prisma.activityPublishReview.count({
            where: {
              status: DASHBOARD_ACTIVITY_PUBLISH_REVIEW_STATUS_PENDING,
              activity: {
                deletedAt: null,
                ...publishReviewActivityWhere,
              },
            },
          })
        : Promise.resolve(0),
      this.prisma.activity.count({
        where: notDeletedWhere({ statusCode: DASHBOARD_ACTIVITY_STATUS_PUBLISHED }),
      }),
      this.prisma.activity.count({
        where: notDeletedWhere({
          statusCode: DASHBOARD_ACTIVITY_STATUS_PUBLISHED,
          endAt: { lt: new Date() },
        }),
      }),
    ]);

    return {
      ...(registrationScope.hasPermission
        ? {
            registrations: {
              pending: registrationsPending,
              waitlisted: registrationsWaitlisted,
            },
          }
        : {}),
      ...(attendanceScope.hasPermission
        ? {
            attendanceSheets: {
              pending: attendanceSheetsPending,
              ...(attendanceFirstReviewScope.hasPermission
                ? { pendingFirstReview: attendanceSheetsPendingFirstReview }
                : {}),
              pendingFinalReview: attendanceSheetsPendingFinalReview,
            },
          }
        : {}),
      ...(publishReviewScope.hasPermission
        ? {
            activityPublishReviews: {
              pending: activityPublishReviewsPending,
            },
          }
        : {}),
      activities: {
        published: activitiesPublished,
        pendingCompletion: activitiesPendingCompletion,
      },
    };
  }

  private async resolveType(
    type: string,
    ids: string[],
    user: CurrentUserPayload,
  ): Promise<Record<string, ResolvedLabelEntry>> {
    switch (type) {
      case 'member':
        return this.resolveMembers(ids);
      case 'user':
        return this.resolveUsers(ids);
      case 'organization':
        return this.resolveOrganizations(ids);
      case 'role':
        return this.resolveRoles(ids);
      case 'position':
        return this.resolvePositions(ids);
      case 'activity':
        return this.resolveActivities(ids, user);
      default:
        return {};
    }
  }

  private async resolveMembers(ids: string[]): Promise<Record<string, ResolvedLabelEntry>> {
    const rows = await this.prisma.member.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, displayName: true, memberNo: true, gradeCode: true },
    });
    return Object.fromEntries(
      rows.map((r) => [
        r.id,
        { label: r.displayName, memberNo: r.memberNo, gradeCode: r.gradeCode },
      ]),
    );
  }

  private async resolveUsers(ids: string[]): Promise<Record<string, ResolvedLabelEntry>> {
    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, username: true, nickname: true },
    });
    return Object.fromEntries(
      rows.map((r) => [r.id, { label: r.nickname ?? r.username, username: r.username }]),
    );
  }

  private async resolveOrganizations(ids: string[]): Promise<Record<string, ResolvedLabelEntry>> {
    const rows = await this.prisma.organization.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, name: true, code: true, nodeTypeCode: true, parentId: true },
    });
    return Object.fromEntries(
      rows.map((r) => [
        r.id,
        { label: r.name, code: r.code, nodeTypeCode: r.nodeTypeCode, parentId: r.parentId },
      ]),
    );
  }

  private async resolveRoles(ids: string[]): Promise<Record<string, ResolvedLabelEntry>> {
    const rows = await this.prisma.rbacRole.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, displayName: true, code: true },
    });
    return Object.fromEntries(rows.map((r) => [r.id, { label: r.displayName, code: r.code }]));
  }

  private async resolvePositions(ids: string[]): Promise<Record<string, ResolvedLabelEntry>> {
    const rows = await this.prisma.organizationPosition.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, name: true, categoryCode: true },
    });
    return Object.fromEntries(
      rows.map((r) => [r.id, { label: r.name, categoryCode: r.categoryCode }]),
    );
  }

  // Q-A7 同口径(镜像 activities.service.ts):USER 强制只见 published/completed,
  // 防止 draft/cancelled 活动经本端点向普通队员泄漏存在性。
  private async resolveActivities(
    ids: string[],
    user: CurrentUserPayload,
  ): Promise<Record<string, ResolvedLabelEntry>> {
    const rows = await this.prisma.activity.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
        ...(user.role === Role.USER
          ? { statusCode: { in: [...ACTIVITY_USER_VISIBLE_STATUS_CODES] } }
          : {}),
      },
      select: { id: true, title: true, startAt: true, statusCode: true },
    });
    return Object.fromEntries(
      rows.map((r) => [r.id, { label: r.title, startAt: r.startAt, statusCode: r.statusCode }]),
    );
  }
}
