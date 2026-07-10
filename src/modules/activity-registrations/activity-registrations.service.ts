import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { auditPlaceholder } from '../../common/audit/audit-placeholder';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { parseExpandQuery } from '../../common/dto/expand-query.util';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_TYPE_ACTIVITY_REMINDER,
} from '../notifications/notification.constants';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { OrganizationsService } from '../organizations/organizations.service';
import { RbacService } from '../permissions/rbac.service';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import { ActivityRegistrationStateMachine } from './activity-registration-state-machine';
import {
  ActivityRegistrationListItemDto,
  ActivityRegistrationResponseDto,
  AdminRegistrationListItemDto,
  ApproveRegistrationDto,
  CancelRegistrationDto,
  CreateMyRegistrationDto,
  CreateRegistrationDto,
  ExportRegistrationsQueryDto,
  ListMyRegistrationsQueryDto,
  ListRegistrationsQueryDto,
  RejectRegistrationDto,
} from './activity-registrations.dto';

// F2/B1(admin-api-fe-integration-roadmap.md §4 B1;D6 拍板):expand 白名单,仅
// listAllForAdmin(admin/v1/registrations 全局横扫)消费。
const REGISTRATION_EXPAND_WHITELIST = ['member', 'activity'] as const;
type RegistrationExpandKey = (typeof REGISTRATION_EXPAND_WHITELIST)[number];

// V2 第一阶段批次 3A activity-registrations service。
// 详见 docs:
//   - 批次3_API前评审决议表.md v1.0 §1.1 / §1.3 / §1.6 / §1.15
//   - 批次3_schema草案_activities_attendances.md v0.5
//
// 关键约定:
// - 状态机闭集 4 态:pending / pass / reject / cancelled
// - approve: pending → pass(capacity 复核;只 pass 占名额)
// - reject:  pending → reject(reviewNote 必填)
// - cancel:  pending|pass → cancelled(cancelled 释放名额)
// - Q-A3:USER 自助 vs ADMIN 代报名拆开;USER 路径 memberId 强制注入 currentUser.user.memberId
// - 报名前校验:activity 存在 + 未取消 + 公开报名 + capacity 未满
// - partial unique:同 activity 同 member active 报名唯一(deletedAt IS NULL AND statusCode != 'cancelled');
//   P2002 兜底 → ACTIVITY_REGISTRATION_ALREADY_EXISTS(21002)
// - USER 越权访问他人 registration → 404(沿 §1.7 风格,避免存在性泄漏)
// - audit:create / review(approve/reject/cancel)hook
//
// Q-A6 CSV export:
// - 不引入 csv-stringify(no new deps);手写 escapeCsvField
// - 默认 scope=pass;可选 scope=all
// - 输出 UTF-8 + BOM(让 Excel 自动识别中文)
// - 不写库 / 不落 export_logs / 不生成 AttendanceRecord(Q-A6 三条副作用禁止)
//
// V2 批次 6 PR #5(第二波第三步):6 处 write hook 从 `auditPlaceholder` 迁移到
// `AuditLogsService.log()` 同事务落库;2 个事件名 `registration.create` / `registration.review`
// 共用 6 个 operation,通过 `extra.viaPath` / `extra.action` 区分(沿 batch3 草案 §20.2 A2 / A3
// 有意设计,D2 同值挪字符串);resourceType 固定 `activity_registration`,字段全部非敏感
// (打码矩阵未命中,与 PR #3 / PR #4 范式一致;extras 字段是用户自定义 JSON,本次纯迁移
// 不引入打码,若后续业务认为含敏感字段需独立批次评审)。
// **`exportCsv` 的 `auditPlaceholder('registration.review', ...)` 调用保持 pino-only 不迁移**
// (read/export 行为,无 DB mutation,沿 Q1=A 当前阶段不记录查看行为)。

const ACTIVITY_STATUS_CANCELLED = 'cancelled';
const ACTIVITY_STATUS_COMPLETED = 'completed';
const REGISTRATION_STATUS_PENDING = 'pending';
const REGISTRATION_STATUS_PASS = 'pass';
const REGISTRATION_STATUS_CANCELLED = 'cancelled';

const registrationSafeSelect = {
  id: true,
  activityId: true,
  memberId: true,
  statusCode: true,
  registeredAt: true,
  reviewedBy: true,
  reviewedAt: true,
  reviewNote: true,
  extras: true,
  cancelledByUserId: true,
  cancelledAt: true,
  cancelReason: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ActivityRegistrationSelect;

// 列表精简 select:仅必要字段 + Member 摘要(memberNo / displayName)。
const registrationListSelect = {
  id: true,
  activityId: true,
  memberId: true,
  statusCode: true,
  registeredAt: true,
  reviewedAt: true,
  cancelledAt: true,
  createdAt: true,
  member: {
    select: {
      memberNo: true,
      displayName: true,
    },
  },
} as const satisfies Prisma.ActivityRegistrationSelect;

// 跨轴只读列表 select(2026-06-23):列表精简 select + activity{id,title} 上下文。
// 跨活动 / 跨队员横扫时 item 脱离 :activityId 路径段,经 Prisma 嵌套关系一次取活动标题(无 N+1);
// activity.deletedAt 不过滤:FK onDelete=Restrict 保证 activity 行存在,软删态字段仍可读,不暴露 deletedAt。
// F2/B1(D6 拍板,2026-07-04):member/activity 子 select 扩至 expand 展开所需的最小字段集
// (member +id+gradeCode;activity +startAt+organizationId)——member/activity 均是既有 Prisma
// 嵌套关系,一次 JOIN 单查询取回(非二次查询,天然满足 D6"禁 N+1");是否投影进响应完全由
// toAdminListItemDto 的 expand 参数决定(默认不展开,select 多取的字段不出现在响应里)。
const registrationAdminListSelect = {
  ...registrationListSelect,
  member: {
    select: {
      id: true,
      memberNo: true,
      displayName: true,
      gradeCode: true,
    },
  },
  activity: {
    select: {
      id: true,
      title: true,
      startAt: true,
      organizationId: true,
    },
  },
} as const satisfies Prisma.ActivityRegistrationSelect;

type RegistrationFullRow = Prisma.ActivityRegistrationGetPayload<{
  select: typeof registrationSafeSelect;
}>;
type RegistrationListRow = Prisma.ActivityRegistrationGetPayload<{
  select: typeof registrationListSelect;
}>;
type RegistrationAdminListRow = Prisma.ActivityRegistrationGetPayload<{
  select: typeof registrationAdminListSelect;
}>;
type PrismaTx = Prisma.TransactionClient;

@Injectable()
export class ActivityRegistrationsService {
  private readonly logger = new Logger(ActivityRegistrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registrationAuditRecorder: ActivityRegistrationAuditRecorder,
    private readonly registrationStateMachine: ActivityRegistrationStateMachine,
    private readonly rbac: RbacService,
    // 终态 scoped-authz PR12(2026-07-02;冻结稿 §11 逐面迁移第一批):统一判权大脑,管理端
    // 判权从 rbac.can 切 authz.explain(见 assertCanOrThrow)。
    private readonly authz: AuthzService,
    // 保险 T3:报名门槛(跨模块单向依赖 activity-registration → insurances,评审稿 E-13)
    private readonly insuranceRequirement: InsuranceRequirementService,
    // 统一通知 S4(评审稿 §6.4):审批结果定向通知派发器(producer → notifications 单向直调,
    // commit 后事务外、try-catch 永不抛;防环:本服务绝不被通知模块回调)。
    private readonly notificationDispatcher: NotificationDispatcher,
    // F2/B1(路线图 §4;D7 拍板):供 queryDescendantOrgIds() 只读 helper 展开 includeDescendants
    // (closure 非判权,镜像 F1/A6 activities.service.ts 用法)。
    private readonly organizations: OrganizationsService,
  ) {}

  // ============ helpers ============

  // Slow-4 T3(2026-06-11,评审稿 §3.6 / D-S4-8)起点;终态 scoped-authz PR12(2026-07-02;
  // 冻结稿 §11 + 决断①②)升级:判权走 authz.explain,ref 矩阵——
  //   - list / exportCsv(嵌套 :activityId)传 {type:'activity', id: activityId} 父 ref
  //   - approve / reject / cancelAdmin 传 {type:'activity_registration', id}(点动作)
  //   - create(代报名)/ listAllForAdmin(扁平跨轴)/ listForMemberAdmin(队员轴跨活动)无 ref
  //     (no-ref = GLOBAL-only,行为锁天然成立;不在冻结稿①点动作枚举内,DoD scoped e2e 亦未列)
  // NOT_FOUND 回退沿 PR9 范式:resource_not_found 时退回 rbac.can 全局码判定——持码者 return
  // (交回调用方后续 findActivityOrThrow / findRegistrationOrThrow 抛既有 NOT_FOUND,「先判权后查
  // 资源」行为锁不变),无码者 30100 防枚举。管理端 8 端点第一条语句调用;list / exportCsv 共用 read
  // (D4=A 判例)。App 自助端点(createMy/listMy/findMy/cancelMy)不走本 helper,self-scope 不变。
  private async assertCanOrThrow(
    user: CurrentUserPayload,
    action: string,
    ref?: ResourceRef,
  ): Promise<void> {
    const decision = await this.authz.explain(user, action, ref);
    if (decision.allow) return;
    if (ref && decision.reason === 'resource_not_found' && (await this.rbac.can(user, action))) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private jsonAsObject(v: Prisma.JsonValue | null): Record<string, unknown> | null {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  }

  private toResponseDto(row: RegistrationFullRow): ActivityRegistrationResponseDto {
    return {
      id: row.id,
      activityId: row.activityId,
      memberId: row.memberId,
      statusCode: row.statusCode,
      registeredAt: row.registeredAt,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      reviewNote: row.reviewNote,
      extras: this.jsonAsObject(row.extras),
      cancelledByUserId: row.cancelledByUserId,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toListItemDto(row: RegistrationListRow): ActivityRegistrationListItemDto {
    return {
      id: row.id,
      activityId: row.activityId,
      memberId: row.memberId,
      memberNo: row.member?.memberNo ?? null,
      memberDisplayName: row.member?.displayName ?? null,
      statusCode: row.statusCode,
      registeredAt: row.registeredAt,
      reviewedAt: row.reviewedAt,
      cancelledAt: row.cancelledAt,
      createdAt: row.createdAt,
    };
  }

  // 跨轴只读列表项映射(2026-06-23):复用 toListItemDto 同字段集 + activityTitle 上下文。
  // F2/B1(D6 拍板):expand 参数由调用方显式传入(listAllForAdmin 传解析后的集合;
  // listForMemberAdmin 恒传空集 —— 本 goal 范围仅 B1/admin/v1/registrations 支持 expand)。
  private toAdminListItemDto(
    row: RegistrationAdminListRow,
    expand: ReadonlySet<RegistrationExpandKey>,
  ): AdminRegistrationListItemDto {
    return {
      id: row.id,
      activityId: row.activityId,
      activityTitle: row.activity?.title ?? null,
      memberId: row.memberId,
      memberNo: row.member?.memberNo ?? null,
      memberDisplayName: row.member?.displayName ?? null,
      statusCode: row.statusCode,
      registeredAt: row.registeredAt,
      reviewedAt: row.reviewedAt,
      cancelledAt: row.cancelledAt,
      createdAt: row.createdAt,
      ...(expand.has('member') && row.member
        ? {
            member: {
              id: row.member.id,
              memberNo: row.member.memberNo,
              displayName: row.member.displayName,
              gradeCode: row.member.gradeCode,
            },
          }
        : {}),
      ...(expand.has('activity') && row.activity
        ? {
            activity: {
              id: row.activity.id,
              title: row.activity.title,
              startAt: row.activity.startAt,
              organizationId: row.activity.organizationId,
            },
          }
        : {}),
    };
  }

  // 找 activity 并校验存在(创建报名 / 列表 / 导出 / capacity 复核共用)。
  // 保险 T3:select 扩展 requiresInsurance / startAt / endAt 三字段供报名门槛断言复用
  // (不另发查询;评审稿 insurance-module-review.md §4 第 3 条),既有调用方语义不变(返回超集)。
  private async findActivityOrThrow(
    activityId: string,
    tx?: PrismaTx,
  ): Promise<{
    id: string;
    statusCode: string;
    isPublicRegistration: boolean;
    capacity: number | null;
    requiresInsurance: boolean;
    startAt: Date;
    endAt: Date;
    registrationDeadline: Date | null;
  }> {
    const client = tx ?? this.prisma;
    const act = await client.activity.findFirst({
      where: notDeletedWhere({ id: activityId }),
      select: {
        id: true,
        statusCode: true,
        isPublicRegistration: true,
        capacity: true,
        requiresInsurance: true,
        startAt: true,
        endAt: true,
        // 活动闭环硬化(2026-06-21):报名截止闸取数(assertActivityRegistrable 读;
        // approve 不读,既有调用方零回归,返回超集)。
        registrationDeadline: true,
      },
    });
    if (!act) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return act;
  }

  // 找 registration 并校验存在(管理端 approve / reject / cancel 共用)。
  private async findRegistrationOrThrow(
    activityId: string,
    id: string,
    tx?: PrismaTx,
  ): Promise<RegistrationFullRow> {
    const client = tx ?? this.prisma;
    const reg = await client.activityRegistration.findFirst({
      where: notDeletedWhere({ id }),
      select: registrationSafeSelect,
    });
    if (!reg || reg.activityId !== activityId) {
      // 沿 §1.7 风格:跨 activity 访问 → 404(避免存在性泄漏)
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
    }
    return reg;
  }

  // 找队员端 USER 的 memberId(必须绑定,否则视作"无队员身份")。
  private async resolveUserMemberIdOrThrow(userId: string, tx?: PrismaTx): Promise<string> {
    const client = tx ?? this.prisma;
    const u = await client.user.findFirst({
      where: notDeletedWhere({ id: userId }),
      select: { memberId: true },
    });
    if (!u || u.memberId === null) {
      // 用户未关联队员:沿 v2 通用语义,返 MEMBER_NOT_FOUND(15001)。
      throw new BizException(BizCode.MEMBER_NOT_FOUND);
    }
    return u.memberId;
  }

  // 校验 member 存在(ADMIN 代报名);USER 路径走 resolveUserMemberIdOrThrow。
  private async assertMemberExists(memberId: string, tx: PrismaTx): Promise<void> {
    const m = await tx.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!m) throw new BizException(BizCode.MEMBER_NOT_FOUND);
  }

  // 报名前的 Activity 状态 / 公开性 / 名额校验。
  private async assertActivityRegistrable(
    activityId: string,
    tx: PrismaTx,
  ): Promise<{
    id: string;
    capacity: number | null;
    requiresInsurance: boolean;
    startAt: Date;
    endAt: Date;
  }> {
    const act = await this.findActivityOrThrow(activityId, tx);
    if (act.statusCode === ACTIVITY_STATUS_CANCELLED) {
      throw new BizException(BizCode.ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN);
    }
    if (!act.isPublicRegistration) {
      throw new BizException(BizCode.ACTIVITY_NOT_PUBLIC_REGISTRATION);
    }
    // 活动闭环硬化(2026-06-21):报名截止时刻生效。两路公共闸——create 代报名 + createMy 自助
    // (App createMyForApp 经 createMy)都经此。registrationDeadline 为 null = 不设截止;精确时刻
    // 比较 now > deadline,不做北京日归一(T0 确认)。approve 不经此闸 → 截止前已报 pending 仍可批。
    if (act.registrationDeadline !== null && new Date() > act.registrationDeadline) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED);
    }
    // 保险 T3:透传门槛三字段给 create()/createMy() 的 assertMemberInsuredForActivity(E-10)
    return {
      id: act.id,
      capacity: act.capacity,
      requiresInsurance: act.requiresInsurance,
      startAt: act.startAt,
      endAt: act.endAt,
    };
  }

  // capacity 复核(create / approve 共用)。pass 占名额(决议表 Q-D17)。
  private async assertCapacityNotExceeded(
    activityId: string,
    capacity: number | null,
    tx: PrismaTx,
  ): Promise<void> {
    if (capacity === null) return; // 不限名额
    const passCount = await tx.activityRegistration.count({
      where: notDeletedWhere({ activityId, statusCode: REGISTRATION_STATUS_PASS }),
    });
    if (passCount >= capacity) {
      throw new BizException(BizCode.ACTIVITY_CAPACITY_EXCEEDED);
    }
  }

  // partial unique 预检查:同 activity 同 member 已有 active(deletedAt=null AND
  // statusCode != 'cancelled')报名 → 21002。
  private async assertNoActiveRegistration(
    activityId: string,
    memberId: string,
    tx: PrismaTx,
  ): Promise<void> {
    const existing = await tx.activityRegistration.findFirst({
      where: {
        activityId,
        memberId,
        deletedAt: null,
        statusCode: { not: REGISTRATION_STATUS_CANCELLED },
      },
      select: { id: true },
    });
    if (existing) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS);
    }
  }

  // 参与域生命周期收口⑦(v0.40.0):已考勤报名禁取消守卫。cancelAdmin + cancelMy 两路共用。
  // 直连 prisma 查 AttendanceRecord.registrationId 反向引用(未软删)——**不引 attendances service**
  // (防跨模块环:attendances → activity-registration 是既有单向依赖,反向会成环)。存在即拒;
  // 不做贡献值回滚(贡献值属考勤域;撤销参与先走考勤面处理记录,报名取消自然解锁)。
  private async assertNoAttendanceRecords(registrationId: string, tx: PrismaTx): Promise<void> {
    const attendanceCount = await tx.attendanceRecord.count({
      where: { registrationId, deletedAt: null },
    });
    if (attendanceCount > 0) {
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE);
    }
  }

  // P2002 兜底(partial unique index name:activity_registrations_activity_member_active_unique)。
  private async runWithUniqueConstraintGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS);
      }
      throw err;
    }
  }

  // ============ 管理端:list ============

  async list(
    activityId: string,
    query: ListRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityRegistrationListItemDto>> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.read.record', {
      type: 'activity',
      id: activityId,
    });
    // activity 存在性校验(管理员看不存在的活动 → 404)。
    await this.findActivityOrThrow(activityId);

    const { page, pageSize, statusCode } = query;
    const filters: Prisma.ActivityRegistrationWhereInput = { activityId };
    if (statusCode !== undefined) filters.statusCode = statusCode;
    const where = notDeletedWhere(filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activityRegistration.findMany({
        where,
        select: registrationListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activityRegistration.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toListItemDto(r)),
      total,
      page,
      pageSize,
    };
  }

  // ============ 跨轴只读:跨活动报名横扫(Tier2 审批工作台)============

  // 2026-06-23 跨轴只读(GET admin/v1/registrations):脱离 :activityId 路径段,按 statusCode
  // 跨所有活动横扫报名(审批工作台「待我审批的」)。判权复用 read 码;item 自带 activity 上下文。
  // 既有 `list(activityId, ...)` 行为零变更——此为新增只读方法,不动旧路径。
  // F2/B1(admin-api-fe-integration-roadmap.md §4 B1;D1/D6/D7 拍板,2026-07-04):+可选
  // q/memberQ/activityQ/memberId/activityId/organizationId/includeDescendants/dateFrom/dateTo/
  // expand。全部省略时行为逐字不变(additive)。
  async listAllForAdmin(
    query: ListRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminRegistrationListItemDto>> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.read.record');

    const {
      page,
      pageSize,
      statusCode,
      q,
      memberQ,
      activityQ,
      memberId,
      activityId,
      organizationId,
      includeDescendants,
      dateFrom,
      dateTo,
      expand,
    } = query;
    const expandSet = parseExpandQuery(expand, REGISTRATION_EXPAND_WHITELIST);

    const filters: Prisma.ActivityRegistrationWhereInput = {};
    if (statusCode !== undefined) filters.statusCode = statusCode;
    if (memberId !== undefined) filters.memberId = memberId;
    if (activityId !== undefined) filters.activityId = activityId;
    if (dateFrom !== undefined || dateTo !== undefined) {
      filters.registeredAt = {
        ...(dateFrom !== undefined ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo !== undefined ? { lte: new Date(dateTo) } : {}),
      };
    }

    // activity 关联过滤累加(activityQ + organizationId/includeDescendants 可共存)。
    const activityWhere: Prisma.ActivityWhereInput = {};
    if (activityQ !== undefined) {
      activityWhere.title = { contains: activityQ, mode: 'insensitive' };
    }
    if (organizationId !== undefined) {
      activityWhere.organizationId = includeDescendants
        ? { in: await this.organizations.queryDescendantOrgIds(organizationId) }
        : organizationId;
    }
    if (Object.keys(activityWhere).length > 0) filters.activity = activityWhere;

    // member 关联过滤(memberQ)。
    if (memberQ !== undefined) {
      filters.member = {
        OR: [
          { memberNo: { contains: memberQ, mode: 'insensitive' } },
          { displayName: { contains: memberQ, mode: 'insensitive' } },
        ],
      };
    }

    // q:跨 member(memberNo+displayName)+ activity(title)全局模糊命中。
    if (q !== undefined) {
      filters.OR = [
        { member: { memberNo: { contains: q, mode: 'insensitive' } } },
        { member: { displayName: { contains: q, mode: 'insensitive' } } },
        { activity: { title: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const where = notDeletedWhere(filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activityRegistration.findMany({
        where,
        select: registrationAdminListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activityRegistration.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toAdminListItemDto(r, expandSet)),
      total,
      page,
      pageSize,
    };
  }

  // ============ 跨轴只读:某队员报名履历(Tier3 队员 360)============

  // 2026-06-23 跨轴只读(GET admin/v1/members/:memberId/registrations):某队员跨活动报名履历
  // (队员 360「活动履历」tab)。镜像 admin-member-insurances 结构 + MEMBER_NOT_FOUND 守卫;
  // 判权复用 read 码;item 自带 activity 上下文。可选 statusCode 过滤。
  // F2/B1 范围仅覆盖 admin/v1/registrations(listAllForAdmin);本方法不消费 query 内新增的
  // q/memberQ/activityQ/memberId/activityId/organizationId/includeDescendants/dateFrom/dateTo/
  // expand 字段(DTO 共享导致的溢出,沿路线图拍板可接受),toAdminListItemDto 恒传空 expand 集,
  // 响应形状逐字不变。
  async listForMemberAdmin(
    memberId: string,
    query: ListRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminRegistrationListItemDto>> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.read.record');
    // 队员存在性守卫(不存在 / 软删 → 15001,镜像 admin-member-insurances inline 检查)。
    const member = await this.prisma.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);

    const { page, pageSize, statusCode } = query;
    const filters: Prisma.ActivityRegistrationWhereInput = { memberId };
    if (statusCode !== undefined) filters.statusCode = statusCode;
    const where = notDeletedWhere(filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activityRegistration.findMany({
        where,
        select: registrationAdminListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activityRegistration.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toAdminListItemDto(r, new Set())),
      total,
      page,
      pageSize,
    };
  }

  // ============ 管理端:create(ADMIN 代报名)============

  async create(
    activityId: string,
    dto: CreateRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.create.record');
    return this.prisma.$transaction(async (tx) => {
      const act = await this.assertActivityRegistrable(activityId, tx);
      await this.assertMemberExists(dto.memberId, tx);
      await this.assertCapacityNotExceeded(activityId, act.capacity, tx);
      await this.assertNoActiveRegistration(activityId, dto.memberId, tx);
      // 保险 T3 报名门槛(admin 代报名同样拦截,C015 无旁路;requiresInsurance=false 零查询,
      // 既有断言零回归;评审稿 §4 / E-10:位于 assertNoActiveRegistration 之后、create 之前)
      await this.insuranceRequirement.assertMemberInsuredForActivity(dto.memberId, act, tx);

      const created = await this.runWithUniqueConstraintGuard(() =>
        tx.activityRegistration.create({
          data: {
            activityId,
            memberId: dto.memberId,
            statusCode: REGISTRATION_STATUS_PENDING,
            ...(dto.extras !== undefined ? { extras: dto.extras as Prisma.InputJsonValue } : {}),
          },
          select: registrationSafeSelect,
        }),
      );

      await this.registrationAuditRecorder.logCreate({
        created,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        viaPath: 'admin',
        activityId,
        targetMemberId: dto.memberId,
        auditMeta,
        tx,
      });

      return this.toResponseDto(created);
    });
  }

  // ============ 队员端:createMy(USER 自助)============

  async createMy(
    activityId: string,
    dto: CreateMyRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const memberId = await this.resolveUserMemberIdOrThrow(currentUser.id, tx);
      const act = await this.assertActivityRegistrable(activityId, tx);
      await this.assertCapacityNotExceeded(activityId, act.capacity, tx);
      await this.assertNoActiveRegistration(activityId, memberId, tx);
      // 保险 T3 报名门槛(自助路径;App createMyForApp 薄壳经此同样拦截;评审稿 §4 / E-10)
      await this.insuranceRequirement.assertMemberInsuredForActivity(memberId, act, tx);

      const created = await this.runWithUniqueConstraintGuard(() =>
        tx.activityRegistration.create({
          data: {
            activityId,
            memberId,
            statusCode: REGISTRATION_STATUS_PENDING,
            ...(dto.extras !== undefined ? { extras: dto.extras as Prisma.InputJsonValue } : {}),
          },
          select: registrationSafeSelect,
        }),
      );

      await this.registrationAuditRecorder.logCreate({
        created,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        viaPath: 'self',
        activityId,
        targetMemberId: memberId,
        auditMeta,
        tx,
      });

      return this.toResponseDto(created);
    });
  }

  // ============ 管理端:approve ============

  async approve(
    activityId: string,
    id: string,
    dto: ApproveRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.approve.record', {
      type: 'activity_registration',
      id,
    });
    const result = await this.prisma.$transaction(async (tx) => {
      const reg = await this.findRegistrationOrThrow(activityId, id, tx);

      const transition = this.registrationStateMachine.decide('approve', reg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }

      // capacity 复核(approve 转 pass 占名额)。F11(#399):READ COMMITTED 下普通 COUNT 复核无行锁,
      // 两并发 approve 互不可见对方未提交写 → 双双过闸 → pass 超 capacity(原注释「事务内重新计数避免
      // race」不成立)。对 activity 行加 FOR UPDATE 排他锁,令同一 activity 的并发 approve 串行化:后到者
      // 阻塞至前者提交,再 COUNT 即见已提交 pass → 正确拒。仅限名额活动需锁(capacity=null 不限名额免锁)。
      const act = await this.findActivityOrThrow(activityId, tx);
      // 参与域生命周期收口①(v0.40.0):取消 / 完结活动禁批报名。活动 statusCode ∈ {cancelled, completed}
      // → 拒 approve(reject / cancelAdmin 刻意不拦,留作清理残留待审队列的手段;见 cancelAdmin / reject 无此闸)。
      if (
        act.statusCode === ACTIVITY_STATUS_CANCELLED ||
        act.statusCode === ACTIVITY_STATUS_COMPLETED
      ) {
        throw new BizException(BizCode.ACTIVITY_ENDED_OR_CANCELLED_APPROVE_FORBIDDEN);
      }
      if (act.capacity !== null) {
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${activityId} FOR UPDATE`;
      }
      await this.assertCapacityNotExceeded(activityId, act.capacity, tx);

      const updated = await tx.activityRegistration.update({
        where: { id: reg.id },
        data: {
          statusCode: transition.nextStatusCode,
          reviewedBy: currentUser.id,
          reviewedAt: new Date(),
          reviewNote: dto.reviewNote ?? null,
        },
        select: registrationSafeSelect,
      });

      await this.registrationAuditRecorder.logReview({
        registrationId: reg.id,
        before: reg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'approve',
        priorStatusCode: reg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        activityId,
        targetMemberId: reg.memberId,
        auditMeta,
        tx,
      });

      // 携带通知收件人(报名本人 memberId)出事务;dto 仍为对外返回体。
      return { dto: this.toResponseDto(updated), memberId: updated.memberId };
    });

    // 报名审批结果定向通知(统一通知 S4;评审稿 §6.4 / §6.2):**事务 commit 之后、事务外**派给报名本人。
    // **绝不破坏审批行为锁**(pending→pass 状态机 / capacity FOR UPDATE 串行化已在事务内 commit);派发失败只记日志。
    await this.dispatchReviewNotification(
      result.memberId,
      activityId,
      'approved',
      dto.reviewNote ?? null,
    );

    return result.dto;
  }

  // ============ 管理端:reject ============

  async reject(
    activityId: string,
    id: string,
    dto: RejectRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.reject.record', {
      type: 'activity_registration',
      id,
    });
    const result = await this.prisma.$transaction(async (tx) => {
      const reg = await this.findRegistrationOrThrow(activityId, id, tx);

      const transition = this.registrationStateMachine.decide('reject', reg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }

      const updated = await tx.activityRegistration.update({
        where: { id: reg.id },
        data: {
          statusCode: transition.nextStatusCode,
          reviewedBy: currentUser.id,
          reviewedAt: new Date(),
          reviewNote: dto.reviewNote,
        },
        select: registrationSafeSelect,
      });

      await this.registrationAuditRecorder.logReview({
        registrationId: reg.id,
        before: reg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'reject',
        priorStatusCode: reg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        activityId,
        targetMemberId: reg.memberId,
        auditMeta,
        tx,
      });

      // 携带通知收件人(报名本人 memberId)出事务;dto 仍为对外返回体。
      return { dto: this.toResponseDto(updated), memberId: updated.memberId };
    });

    // 报名审批结果定向通知(统一通知 S4;评审稿 §6.4 / §6.2):**事务 commit 之后、事务外**派给报名本人。
    // **绝不破坏审批行为锁**(pending→reject 状态机已在事务内 commit);派发失败只记日志。
    await this.dispatchReviewNotification(result.memberId, activityId, 'rejected', dto.reviewNote);

    return result.dto;
  }

  // 派发「报名审批结果」定向通知(仅站内,§9.1 渠道倾向 + goal:S4 站内为主、微信 opt-in 延后)。
  // **try-catch 永不抛**:派发失败(含 dispatcher 内部异常 / 活动查不到)只记日志,绝不回滚 / 阻断已 commit
  // 的审批(行为锁)。收件人 = 报名本人 memberId(registration→member);payload:活动名 + 通过/驳回 + 理由(若有)。
  private async dispatchReviewNotification(
    memberId: string,
    activityId: string,
    outcome: 'approved' | 'rejected',
    reviewNote: string | null,
  ): Promise<void> {
    try {
      const activity = await this.prisma.activity.findUnique({
        where: { id: activityId },
        select: { title: true },
      });
      const activityTitle = activity?.title ?? '活动';
      const passed = outcome === 'approved';
      const reasonSuffix = reviewNote ? ` 理由:${reviewNote}` : '';
      await this.notificationDispatcher.dispatchTargeted({
        recipientMemberId: memberId,
        notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_REMINDER,
        title: passed ? '报名已通过' : '报名未通过',
        body: passed
          ? `您报名的「${activityTitle}」已通过审核。${reasonSuffix}`
          : `您报名的「${activityTitle}」未通过审核。${reasonSuffix}`,
        channels: [NOTIFICATION_CHANNEL_IN_APP],
      });
    } catch (err) {
      this.logger.error(
        `registration review notification dispatch failed (member=${memberId}, activity=${activityId}): ${(err as Error).message}`,
      );
    }
  }

  // ============ 管理端:cancel(代取消)============

  async cancelAdmin(
    activityId: string,
    id: string,
    dto: CancelRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.cancel.record', {
      type: 'activity_registration',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const reg = await this.findRegistrationOrThrow(activityId, id, tx);

      const transition = this.registrationStateMachine.decide('cancel', reg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }

      // 参与域生命周期收口⑦(v0.40.0):已考勤报名禁取消(状态机放行后、写库前拦)。
      await this.assertNoAttendanceRecords(reg.id, tx);

      const updated = await tx.activityRegistration.update({
        where: { id: reg.id },
        data: {
          statusCode: transition.nextStatusCode,
          cancelledByUserId: currentUser.id,
          cancelledAt: new Date(),
          cancelReason: dto.cancelReason ?? null,
        },
        select: registrationSafeSelect,
      });

      await this.registrationAuditRecorder.logCancel({
        registrationId: reg.id,
        before: reg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: reg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        cancelledByPath: 'admin',
        cancelReason: dto.cancelReason ?? null,
        activityId,
        targetMemberId: reg.memberId,
        auditMeta,
        tx,
      });

      return this.toResponseDto(updated);
    });
  }

  // ============ 管理端:reopen(审批后悔药:reject → pending)============

  // 参与域生命周期收口②(v0.40.0):撤销驳回、回待审。状态机新边 reject → pending;其余态
  // ACTIVITY_REGISTRATION_STATUS_INVALID。置 pending 同时清空 reviewedBy / reviewedAt / reviewNote
  // (回到"从未审过"形态);**刻意不开 reject → pass 直通**(改判必须重走审批)。audit 复用
  // registration.review 事件、extra.action='reopen'(不发通知——后续 approve/reject 才发结果);
  // reopen 不占 capacity(pending 不计数)。判权沿 approve 范式带 ref {type:'activity_registration', id}。
  async reopen(
    activityId: string,
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.reopen.record', {
      type: 'activity_registration',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const reg = await this.findRegistrationOrThrow(activityId, id, tx);

      const transition = this.registrationStateMachine.decide('reopen', reg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }

      const updated = await tx.activityRegistration.update({
        where: { id: reg.id },
        data: {
          statusCode: transition.nextStatusCode,
          reviewedBy: null,
          reviewedAt: null,
          reviewNote: null,
        },
        select: registrationSafeSelect,
      });

      await this.registrationAuditRecorder.logReview({
        registrationId: reg.id,
        before: reg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'reopen',
        priorStatusCode: reg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        activityId,
        targetMemberId: reg.memberId,
        auditMeta,
        tx,
      });

      return this.toResponseDto(updated);
    });
  }

  // ============ 队员端:listMy ============

  async listMy(
    query: ListMyRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityRegistrationListItemDto>> {
    const memberId = await this.resolveUserMemberIdOrThrow(currentUser.id);

    const { page, pageSize, statusCode } = query;
    const filters: Prisma.ActivityRegistrationWhereInput = { memberId };
    if (statusCode !== undefined) filters.statusCode = statusCode;
    const where = notDeletedWhere(filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activityRegistration.findMany({
        where,
        select: registrationListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.activityRegistration.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.toListItemDto(r)),
      total,
      page,
      pageSize,
    };
  }

  // ============ 队员端:findMy ============

  async findMy(
    id: string,
    currentUser: CurrentUserPayload,
  ): Promise<ActivityRegistrationResponseDto> {
    const memberId = await this.resolveUserMemberIdOrThrow(currentUser.id);

    const reg = await this.prisma.activityRegistration.findFirst({
      where: notDeletedWhere({ id }),
      select: registrationSafeSelect,
    });
    if (!reg || reg.memberId !== memberId) {
      // 沿 §1.7 风格:USER 越权 → 404
      throw new BizException(BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
    }
    return this.toResponseDto(reg);
  }

  // ============ 队员端:cancelMy ============

  async cancelMy(
    id: string,
    dto: CancelRegistrationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityRegistrationResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      const memberId = await this.resolveUserMemberIdOrThrow(currentUser.id, tx);

      const reg = await tx.activityRegistration.findFirst({
        where: notDeletedWhere({ id }),
        select: registrationSafeSelect,
      });
      if (!reg || reg.memberId !== memberId) {
        throw new BizException(BizCode.ACTIVITY_REGISTRATION_NOT_FOUND);
      }

      const transition = this.registrationStateMachine.decide('cancel', reg.statusCode);
      if (!transition.allowed) {
        throw new BizException(transition.biz);
      }

      // 参与域生命周期收口⑦(v0.40.0):已考勤报名禁取消(队员自助路径同样拦)。
      await this.assertNoAttendanceRecords(reg.id, tx);

      const updated = await tx.activityRegistration.update({
        where: { id: reg.id },
        data: {
          statusCode: transition.nextStatusCode,
          cancelledByUserId: currentUser.id,
          cancelledAt: new Date(),
          cancelReason: dto.cancelReason ?? null,
        },
        select: registrationSafeSelect,
      });

      await this.registrationAuditRecorder.logCancel({
        registrationId: reg.id,
        before: reg,
        after: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: reg.statusCode,
        nextStatusCode: transition.nextStatusCode,
        cancelledByPath: 'self',
        cancelReason: dto.cancelReason ?? null,
        activityId: reg.activityId,
        targetMemberId: reg.memberId,
        auditMeta,
        tx,
      });

      return this.toResponseDto(updated);
    });
  }

  // ============ 管理端:CSV export(Q-A6)============

  // 返回纯字符串(BOM + CSV);controller 包成 StreamableFile。
  // **不写库 / 不落 export_logs / 不生成 AttendanceRecord**(Q-A6 三条副作用禁止)。
  async exportCsv(
    activityId: string,
    query: ExportRegistrationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<string> {
    await this.assertCanOrThrow(currentUser, 'activity-registration.read.record', {
      type: 'activity',
      id: activityId,
    });
    await this.findActivityOrThrow(activityId);

    const scope = query.scope ?? 'pass';
    const filters: Prisma.ActivityRegistrationWhereInput = { activityId };
    if (scope === 'pass') {
      filters.statusCode = REGISTRATION_STATUS_PASS;
    }
    const where = notDeletedWhere(filters);

    const rows = await this.prisma.activityRegistration.findMany({
      where,
      select: {
        id: true,
        memberId: true,
        statusCode: true,
        registeredAt: true,
        reviewedAt: true,
        reviewNote: true,
        cancelledAt: true,
        cancelReason: true,
        member: { select: { memberNo: true, displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    auditPlaceholder('registration.review', {
      operatorUserId: currentUser.id,
      activityId,
      operation: 'export',
      scope,
      rowsCount: rows.length,
    });

    return this.formatRowsAsCsv(rows);
  }

  // 简单 CSV encoder(沿"不引入新依赖"):双引号转义 + 含逗号/换行/双引号字段用双引号包裹。
  private formatRowsAsCsv(
    rows: Array<{
      id: string;
      memberId: string;
      statusCode: string;
      registeredAt: Date;
      reviewedAt: Date | null;
      reviewNote: string | null;
      cancelledAt: Date | null;
      cancelReason: string | null;
      member: { memberNo: string; displayName: string } | null;
    }>,
  ): string {
    const HEADERS = [
      'registration_id',
      'member_id',
      'member_no',
      'display_name',
      'status_code',
      'registered_at',
      'reviewed_at',
      'review_note',
      'cancelled_at',
      'cancel_reason',
    ];
    // 入参类型显式收紧为标量(string / Date / null),避免落 Object.toString 的
    // '[object Object]' 默认序列化(@typescript-eslint/no-base-to-string)。
    const escapeField = (value: string | Date | null): string => {
      if (value === null) return '';
      const s = value instanceof Date ? value.toISOString() : value;
      if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const lines: string[] = [HEADERS.join(',')];
    for (const r of rows) {
      lines.push(
        [
          escapeField(r.id),
          escapeField(r.memberId),
          escapeField(r.member?.memberNo ?? null),
          escapeField(r.member?.displayName ?? null),
          escapeField(r.statusCode),
          escapeField(r.registeredAt),
          escapeField(r.reviewedAt),
          escapeField(r.reviewNote),
          escapeField(r.cancelledAt),
          escapeField(r.cancelReason),
        ].join(','),
      );
    }
    return lines.join('\n');
  }
}
