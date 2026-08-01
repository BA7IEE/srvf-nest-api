import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DictItemStatus, DictTypeStatus, Prisma, Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { parseExpandQuery } from '../../common/dto/expand-query.util';
import { eventPlaceholder } from '../../common/event/event-placeholder';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import {
  lockMembersForWrite,
  runMemberLinearizedTransaction,
} from '../../common/prisma/member-advisory-lock.util';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityParticipationPolicy } from '../activities/activity-participation-policy';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import { OrganizationsService } from '../organizations/organizations.service';
import { RbacService } from '../permissions/rbac.service';
// 跨轴只读(2026-06-23):复用 team-join 贡献值封顶核(单一真相源;生涯累计 cutoff=null)。
// 纯函数调用,非 DI provider → 无 AttendancesModule → TeamJoinModule 依赖;team-join 不反向
// import attendances(team-join.constants 自洽),无循环。
import { computeCappedContribution } from '../team-join/team-join-progress';
import { AttendanceAuditRecorder } from './attendance-audit-recorder';
import { AttendanceNotificationProducer } from './attendance-notification-producer';
import { AttendancePresenter } from './attendance-presenter';
import { AttendanceSheetStateMachine } from './attendance-sheet-state-machine';
import { ContributionCalculator } from './contribution-calculator';
import { TimeOverlapPolicy } from './time-overlap-policy';
import {
  AdminAttendanceSheetListItemDto,
  AdminMemberAttendanceRecordDto,
  ApproveAttendanceSheetDto,
  ATTENDANCE_SHEET_STATUS,
  AttendanceRecordInputDto,
  AttendanceRecordResponseDto,
  AttendanceSheetActivitySummaryDto,
  AttendanceSheetListItemDto,
  AttendanceSheetResponseDto,
  AttendanceSheetReviewDetailDto,
  CreateAttendanceSheetDto,
  FinalApproveAttendanceSheetDto,
  FinalRejectAttendanceSheetDto,
  ListAttendanceSheetsQueryDto,
  MemberContributionSummaryDto,
  MyAttendanceRecordsQueryDto,
  ReopenAttendanceSheetDto,
  ResubmitAttendanceSheetDto,
  RejectAttendanceSheetDto,
  ReturnAttendanceSheetDto,
  UpdateAttendanceSheetDto,
} from './attendances.dto';

// F2/B2(admin-api-fe-integration-roadmap.md §4 B2;D6 拍板):expand 白名单,仅
// listAllSheetsForAdmin(admin/v1/attendance-sheets 全局横扫)消费。类型由 parseExpandQuery
// 的泛型从此白名单字面量推导,无需单独导出 key 类型(镜像本文件其余「不为已推导类型再起别名」惯例)。
const ATTENDANCE_EXPAND_WHITELIST = ['activity'] as const;

// V2 第一阶段批次 3B attendances service(批次 4-B 升级:终审 / D14 预填；D11 推动已由 D2-a 撤销)。
// 详见 docs:
//   - 批次3_API前评审决议表.md v1.0 §1.8 / §1.9 / §1.14
//   - 批次3_schema草案_activities_attendances.md v0.5 §13 / §15 / §16 / §19
//   - 批次4_贡献值业务规则前评审决议表 v1.0(D5 候选 B 终审 / D11 历史项已由 D2-a 撤销 / D14 5.B 预填)
//   - 批次4_贡献值业务规则_schema草案评审决议表 v1.0(D-S5 / D-S6 / D-S7 / D-S8 / D-S10 / D-S11)
//   - 批次4_贡献值业务规则_API草案 v1.0(D-A1 ~ D-A13)
//   - 批次4_贡献值业务规则_实现前业务规则说明 v1.0
//
// 关键约定:
// - 状态机闭集 6 态(v0.61.0 +returned):
//   pending / pending_final_review / returned / approved / rejected / final_rejected
//   字符串常量集中维护在 attendances.dto.ts 的 ATTENDANCE_SHEET_STATUS;
//   service 内部 SHEET_STATUS_* 别名仅作可读性兜底,**禁止**手写裸字符串。
//   其中 **approved 业务语义 = 终审通过**(从 v0.4.0 "APD 通过" 升级);
//   pending_final_review = APD 一级已审,等终审;
//   final_rejected = 终审驳回(终态,records 跟随软删,沿 D8 主路径)。
//   注:终审业务角色为"APD 部门部长 / 副部长";终态 scoped-authz PR9(2026-07-02)起终审两方法
//   判权走 AuthzService(biz-admin 全局码保留〔B 方案〕+ scoped RoleBinding 通路 + 自审/同人约束),
//   终审身份由 role-bindings 配置行决定,代码不含部门字面量门控(BD-2)。
// - submit:事务内一次性 create Sheet + N records;activity statusCode != cancelled
//   批次 4-B 新增:**D14 5.B 系统预填** contributionPoints(根据 ContributionRule 查表)+
//   **D2-a 当前规则**:submit 不写 Activity.statusCode，completed 仅由 activities.complete 推进。
// - edit:pending → pending 或 returned → returned;后端生成 previousSnapshot(R28 / Q-S16);version+1;
//   旧 records 软删 + 新 records 创建(D38);重跑全部校验。
//   批次 4-B:pending_final_review / final_rejected 也不可 edit(沿 22030 / 22043)。
// - delete:仅 pending → 软删 + 级联软删 records(R20)
// - approve(APD 一级):**批次 4-B 升级:pending → pending_final_review**(从 v0.4.0 → approved 升级);
//   所有 records.contributionPoints 必填(R31,沿 D-S8 在 APD approve 时校验);
//   写 reviewerUserId/At/Note;**不再触发** attendance.recorded(沿 D-S7);触发位置移到 final-approve。
// - reject(APD 一级):仅 pending → rejected;reviewNote 必填;**records 跟随软删**(F4 #399:
//   对称 final_rejected,释放 time-overlap 窗口,解一级驳回同窗无法重交的死锁)
// - final-approve(批次 4-B 新增,沿 D-S5):pending_final_review → approved;
//   写 finalReviewer*;**同事务内触发** eventPlaceholder('attendance.recorded')(沿 D-S7);
//   audit:attendance-sheet.final-review。终审不重校验逐条 records(沿 D-S8)。
// - final-reject(批次 4-B 新增,沿 D-S5):pending_final_review → final_rejected;
//   finalReviewNote 必填(22046);records 跟随软删;**不触发** attendance.recorded(沿 D-S7);
//   audit:attendance-sheet.final-review。
// - 时间不重叠:同 memberId × [checkInAt, checkOutAt) 左闭右开;跨 Sheet / 跨 Activity 全局
//   (R16 / Q-S15);service 层校验(不做 PG EXCLUDE 约束)
// - serviceHours:未传自动 (checkOutAt-checkInAt)/3600;>0 且 ≤ 跨度(D14 / D45 / D51 / D46)
// - contributionPoints:不接受输入值;submit/edit 均由 ContributionRule 权威计算,无规则保守为 0。
// - registrationId 跨表:非空时 registration.activityId/memberId/statusCode(pass) 必须与 record 一致;
//   requiresInsurance=true 时必填;该校验不证明报名创建时已开启保险门槛,也不独立核验保险。
// - registrationId Restrict:删除 registration 时被 FK 阻断(Q-S21;不破坏历史追溯)
// - audit:submit / edit / delete / read.other / review(approve+reject) / final-review(批次 4-B)
// - event:**attendance.recorded 触发位置移到 final-approve**(沿 D-S7);submit / edit / delete /
//   approve / reject / final-reject 均不触发。
//
// V2 批次 6 PR #6(第二波最后一批):8 处 write hook 从 `auditPlaceholder` 迁移到
// `AuditLogsService.log()` 同事务落库;5 个事件名(`attendance-sheet.{submit, edit, delete, review, final-review}`)
// 共承担 8 处 operation,通过 `extra.operation` / `extra.action` 区分(沿 PR #4 / PR #5 范式,
// D2 同值挪字符串);resourceType 固定 `attendance_sheet`;C-2 起 3 处 read.other 在查询完成后
// 经 AttendanceAuditRecorder fail-closed 落库,extra 仅保留 operation/count/filterFields。
// **`eventPlaceholder('attendance.recorded')` 与 audit 是两套独立机制,不动**(沿 D-S7)。
// ⚠️ 原注释曾称「audit 写失败 → 事务回滚 → 业务事件随之回滚,由 DB 事务原子性保证」——
// 这是**错的**,已于并发审计 S5 收口(2026-07-31)改正:`eventPlaceholder` 只是一次
// 立即执行的 Logger 输出(见 `common/event/event-placeholder.ts`),日志一旦写出,
// 数据库回滚撤不回它。真正随事务回滚的只有 audit 与业务写这两类**库内**副作用。
// 需要「可回滚的事件」时,唯一正确落点是 notification outbox intent(同事务落库、
// commit 后才由 worker 执行 Effect),不是本函数。
// records 全字段快照入 audit context:submit / edit × 2 / softDelete / finalReject / **reject**
// (F4 #399:reject 也软删 records,审计含软删前快照,对称 finalReject)必含;
// approve / finalApprove 只放 sheet 快照,`extra.recordsCount` 元数据(records 不变)。
// 字段非敏感(打码矩阵未命中,沿 PR #3 / PR #4 / PR #5 不打码范式)。

// Sheet 状态机闭集别名(单一来源:ATTENDANCE_SHEET_STATUS,定义在 attendances.dto.ts)。
const SHEET_STATUS_PENDING = ATTENDANCE_SHEET_STATUS.PENDING;
const SHEET_STATUS_APPROVED = ATTENDANCE_SHEET_STATUS.APPROVED;

const DICT_TYPE_ATTENDANCE_ROLE = 'attendance_role';
const DICT_TYPE_ATTENDANCE_STATUS = 'attendance_status';

// Sheet 简化 select(不含 records 数组 + 不含 previousSnapshot)。
// 批次 4-B 新增 finalReviewer* 3 字段(D-S5;UserResponseDto 同步,沿 baseline §11.3 可选字段)。
const sheetSafeSelect = {
  id: true,
  activityId: true,
  submitterUserId: true,
  submittedAt: true,
  statusCode: true,
  reviewerUserId: true,
  reviewedAt: true,
  reviewNote: true,
  finalReviewerUserId: true,
  finalReviewedAt: true,
  finalReviewNote: true,
  lastSubmittedByUserId: true,
  lastSubmittedAt: true,
  returnedByUserId: true,
  returnedAt: true,
  returnNote: true,
  returnedFromStageCode: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.AttendanceSheetSelect;

// Sheet 列表精简 select。
const sheetListSelect = {
  id: true,
  activityId: true,
  submitterUserId: true,
  submittedAt: true,
  statusCode: true,
  reviewedAt: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.AttendanceSheetSelect;

// Record + Member 嵌套 select(review-detail / /me 列表共用)。
const recordWithMemberSelect = {
  id: true,
  sheetId: true,
  memberId: true,
  roleCode: true,
  checkInAt: true,
  checkOutAt: true,
  serviceHours: true,
  attendanceStatusCode: true,
  note: true,
  registrationId: true,
  contributionPoints: true,
  createdAt: true,
  updatedAt: true,
  member: {
    select: {
      id: true,
      memberNo: true,
      displayName: true,
    },
  },
} as const satisfies Prisma.AttendanceRecordSelect;

// Sheet 完整 select(含 previousSnapshot,用于 edit 事务内读取上一版本快照)。
const sheetFullSelect = {
  ...sheetSafeSelect,
  previousSnapshot: true,
  activityId: true,
} as const satisfies Prisma.AttendanceSheetSelect;

// 跨轴只读 select(2026-06-23):
// - adminSheetListSelect:Sheet 列表精简 select + activity{id,title}(跨活动横扫上下文,审批工作台)。
// - adminMemberRecordSelect:Record + Member 嵌套 + sheet{activityId, activity{title}}(队员 360 考勤记录上下文)。
// 活动标题经 Prisma 嵌套关系一次取(无 N+1);activity.deletedAt 不过滤(FK onDelete=Restrict 保证行存在,
// 软删态字段仍可读,不暴露 deletedAt)。
// F2/B2(D6 拍板,2026-07-04):activity 子 select 扩至 expand 展开所需的最小字段集
// (+startAt+organizationId)——activity 是既有 Prisma 嵌套关系,一次 JOIN 单查询取回(非二次查询,
// 天然满足 D6"禁 N+1");是否投影进响应完全由 listAllSheetsForAdmin 的 expand 参数决定。
const adminSheetListSelect = {
  ...sheetListSelect,
  activity: {
    select: {
      id: true,
      title: true,
      startAt: true,
      organizationId: true,
    },
  },
} as const satisfies Prisma.AttendanceSheetSelect;

const adminMemberRecordSelect = {
  ...recordWithMemberSelect,
  sheet: {
    select: {
      activityId: true,
      activity: {
        select: {
          title: true,
        },
      },
    },
  },
} as const satisfies Prisma.AttendanceRecordSelect;

// 行类型(SheetSafeRow / SheetListRow / RecordWithMemberRow)已随序列化方法迁往
// `attendance-presenter.ts`(P1-4 第一刀);presenter 侧用最小结构性入参类型,
// 本文件的 GetPayload 行按结构子类型直接传入,select 常量(查询策略)留在本文件。
type PrismaTx = Prisma.TransactionClient;
export type AttendanceAuthorization = 'authz' | 'managed';

@Injectable()
export class AttendancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendanceAuditRecorder: AttendanceAuditRecorder,
    private readonly contributionCalculator: ContributionCalculator,
    private readonly timeOverlapPolicy: TimeOverlapPolicy,
    private readonly sheetStateMachine: AttendanceSheetStateMachine,
    private readonly attendancePresenter: AttendancePresenter,
    private readonly rbac: RbacService,
    // 终态 scoped-authz PR9(2026-07-02)起统一判权大脑;终审两方法见 assertFinalReviewAuthzOrThrow。
    // PR12(2026-07-02;冻结稿 §11 逐面迁移第一批)起其余 6 管理端动作(create/read×多/update/delete/
    // approve/reject)也切 authz.explain,见 assertCanOrThrow。
    private readonly authz: AuthzService,
    // PR-L4:考勤退回/终审通知 intent 与业务、audit 同事务落库；provider Effect 由既有
    // NotificationOutboxWorker 在 commit 后执行并负责 lease/fence/retry。
    private readonly attendanceNotificationProducer: AttendanceNotificationProducer,
    // F2/B2(路线图 §4;D7 拍板):供 queryDescendantOrgIds() 只读 helper 展开 includeDescendants
    // (closure 非判权,镜像 F1/A6 activities.service.ts 用法)。
    private readonly organizations: OrganizationsService,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
    private readonly activityParticipationPolicy: ActivityParticipationPolicy,
  ) {}

  // Slow-4 T3(2026-06-11,评审稿 §3.7 / D-S4-8)起点;终态 scoped-authz PR12(2026-07-02;
  // 冻结稿 §11 + 决断①②)升级:判权走 authz.explain,ref 矩阵——
  //   - submit(create.sheet)/ list(嵌套 :activityId)传 {type:'activity', id: activityId}
  //   - findOne / reviewDetail / edit / softDelete / approve / reject 传 {type:'attendance_sheet', id}
  //     (点动作)
  //   - listAllSheetsForAdmin 通过 getVisibleOrganizationScope 下推活动所属组织范围
  //   - listRecordsForMemberAdmin / getMemberContributionSummary 传 {type:'member', id: memberId}
  // NOT_FOUND 回退沿 assertFinalReviewAuthzOrThrow 同范式:resource_not_found 时退回 rbac.can 全局码
  // 判定——持码者 return(交回调用方后续 assertActivityExists / findSheetOrThrow 抛既有 NOT_FOUND,
  // 「先判权后查资源」行为锁不变),无码者 30100 防枚举。8 个管理端方法(不含终审两方法)第一条语句
  // 调用;list / findOne / reviewDetail / listAllSheetsForAdmin / listRecordsForMemberAdmin /
  // getMemberContributionSummary 共用 read(D4=A 判例)。终审两码独立走 assertFinalReviewAuthzOrThrow
  // (`attendance.final-approve.sheet` / `attendance.final-reject.sheet`,PR9 起,自审/同人约束)。
  private async assertCanOrThrow(
    user: CurrentUserPayload,
    action: string,
    ref?: ResourceRef,
  ): Promise<void> {
    const decision = await this.authz.explain(user, action, ref);
    if (decision.allow) return;
    if (
      decision.reason === 'self_approval_forbidden' &&
      (action === 'attendance.approve.sheet' ||
        action === 'attendance.reject.sheet' ||
        action === 'attendance.return.sheet')
    ) {
      throw new BizException(BizCode.ATTENDANCE_SELF_FIRST_REVIEW_FORBIDDEN);
    }
    if (ref && decision.reason === 'resource_not_found' && (await this.rbac.can(user, action))) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

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

  // 终态 scoped-authz PR9(2026-07-02;冻结稿 §5.2/§5.3 + BD-2):终审与 v0.47.0 reopen
  // 判权共用此 AuthzService 入口。带 ref 判权 = attendance-final-reviewer scoped 三源
  // (如 POSITION_ASSIGNMENT 主体 RoleBinding —— 终审中枢经 role-bindings 配置行决定,
  // 绝不 hardcode 部门)+ SUPER_ADMIN 兜底;biz-admin 不持终审/reopen 三码。
  // ActionConstraint 对 finalApprove / finalReject / finalReturn 咬合自审与同人限制。
  //
  // deny 映射(goal 决断①):
  // - self_approval_forbidden → 22074 / same_reviewer_forbidden → 22075(域不变量否决,非权限不足)
  // - resource_not_found → 行为锁:旧序是「先判码后查单」——持全局码者放行,进事务由
  //   findSheetOrThrow 抛 ATTENDANCE_SHEET_NOT_FOUND(22001)如旧;无码者仍 30100(防枚举)
  // - 其余一切 deny(no_permission / out_of_scope / expired_grant 等)→ 30100 不变(权限拒绝面契约零变)
  private async assertFinalReviewAuthzOrThrow(
    user: CurrentUserPayload,
    action: string,
    sheetId: string,
  ): Promise<void> {
    const decision = await this.authz.explain(user, action, {
      type: 'attendance_sheet',
      id: sheetId,
    });
    if (decision.allow) return;
    switch (decision.reason) {
      case 'self_approval_forbidden':
        throw new BizException(BizCode.ATTENDANCE_SELF_FINAL_REVIEW_FORBIDDEN);
      case 'same_reviewer_forbidden':
        throw new BizException(BizCode.ATTENDANCE_SAME_REVIEWER_FORBIDDEN);
      case 'resource_not_found':
        if (await this.rbac.can(user, action)) return;
        throw new BizException(BizCode.RBAC_FORBIDDEN);
      default:
        throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private assertLockedReviewSeparation(
    stage: 'first' | 'final',
    sheet: {
      submitterUserId: string;
      lastSubmittedByUserId: string | null;
      reviewerUserId: string | null;
    },
    currentUser: CurrentUserPayload,
  ): void {
    if (
      sheet.submitterUserId === currentUser.id ||
      sheet.lastSubmittedByUserId === currentUser.id
    ) {
      throw new BizException(
        stage === 'first'
          ? BizCode.ATTENDANCE_SELF_FIRST_REVIEW_FORBIDDEN
          : BizCode.ATTENDANCE_SELF_FINAL_REVIEW_FORBIDDEN,
      );
    }
    if (stage === 'final' && sheet.reviewerUserId === currentUser.id) {
      throw new BizException(BizCode.ATTENDANCE_SAME_REVIEWER_FORBIDDEN);
    }
  }

  // 考勤写路径的 Activity 聚合锁。**任何 surface 都必须取**(并发审计 K1 / 第七种形状 S7):
  // 把它挂在 `authorization === 'managed'` / `managedActivityId !== undefined` 这类判权分支上,
  // 会让另一条 surface 对 Activity 与 Registration 完全裸奔,单读该方法看不出来。
  // 名字里刻意不再带 "Managed" —— 它不是 managed 面的专属物。
  private async lockActivityForAttendanceWrite(activityId: string, tx: PrismaTx): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    if (rows.length === 0) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }

  private async assertManagedAttendanceAccess(
    activityId: string,
    currentUser: CurrentUserPayload,
    tx?: PrismaTx,
  ): Promise<void> {
    if (!currentUser.memberId) throw new BizException(BizCode.RBAC_FORBIDDEN);
    const assignment = await (tx ?? this.prisma).activityResponsibilityAssignment.findFirst({
      where: {
        activityId,
        memberId: currentUser.memberId,
        status: 'active',
        canManageAttendance: true,
      },
      select: { id: true },
    });
    if (!assignment) throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private assertManagedSheetActivity(
    sheetActivityId: string,
    managedActivityId: string | undefined,
  ): void {
    if (managedActivityId !== undefined && sheetActivityId !== managedActivityId) {
      throw new BizException(BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    }
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

  // 找 Sheet 完整数据(含 previousSnapshot,用于 edit 路径)。
  private async findSheetOrThrow(
    id: string,
    tx: PrismaTx,
  ): Promise<Prisma.AttendanceSheetGetPayload<{ select: typeof sheetFullSelect }>> {
    const sheet = await tx.attendanceSheet.findFirst({
      where: notDeletedWhere({ id }),
      select: sheetFullSelect,
    });
    if (!sheet) throw new BizException(BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    return sheet;
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

  // ============ helpers:Record 字段计算 / 校验 ============

  // 计算服务时长(小时,Decimal(5,2) 精度);D14 / D45 / D46 / D51。
  private spanHours(checkInAt: Date, checkOutAt: Date): number {
    const ms = checkOutAt.getTime() - checkInAt.getTime();
    return Math.round((ms / 3_600_000) * 100) / 100; // 保留 2 位小数
  }

  // 规范化一条 record:校验时间 + 自动计算 / 校验 serviceHours。
  // 返回 normalize 后的入库形态(serviceHours 显式 number,后续在创建时转 Decimal)。
  //
  private normalizeRecord(input: AttendanceRecordInputDto): {
    memberId: string;
    roleCode: string;
    checkInAt: Date;
    checkOutAt: Date;
    serviceHours: number;
    attendanceStatusCode: string;
    note: string | null;
    registrationId: string | null;
  } {
    const checkInAt = new Date(input.checkInAt);
    const checkOutAt = new Date(input.checkOutAt);
    if (!(checkOutAt.getTime() > checkInAt.getTime())) {
      throw new BizException(BizCode.CHECK_OUT_BEFORE_CHECK_IN);
    }
    const spanHours = this.spanHours(checkInAt, checkOutAt);

    let serviceHours: number;
    if (input.serviceHours === undefined) {
      serviceHours = spanHours;
      if (serviceHours <= 0) {
        // 极端罕见:跨度极短,四舍五入到 0;视作 invalid
        throw new BizException(BizCode.ATTENDANCE_SERVICE_HOURS_INVALID);
      }
    } else {
      serviceHours = input.serviceHours;
      if (serviceHours <= 0) {
        throw new BizException(BizCode.ATTENDANCE_SERVICE_HOURS_INVALID);
      }
      if (serviceHours > spanHours) {
        throw new BizException(BizCode.ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN);
      }
    }

    return {
      memberId: input.memberId,
      roleCode: input.roleCode,
      checkInAt,
      checkOutAt,
      serviceHours,
      attendanceStatusCode: input.attendanceStatusCode,
      note: input.note ?? null,
      registrationId: input.registrationId ?? null,
    };
  }

  private assertRecordWithinActivityWindow(
    record: ReturnType<AttendancesService['normalizeRecord']>,
    activity: { startAt: Date; endAt: Date },
  ): void {
    const toleranceMs = this.config.attendance.windowToleranceHours * 3_600_000;
    if (
      record.checkInAt.getTime() < activity.startAt.getTime() - toleranceMs ||
      record.checkOutAt.getTime() > activity.endAt.getTime() + toleranceMs
    ) {
      throw new BizException(BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW);
    }
  }

  // F1/F3/F4:一个 records 请求固定用 3 次 IN 预取字典项、队员与报名行；随后按原输入顺序
  // 复现错误优先级并完成 normalize。查询次数不随 records 数增长，且 registrationId 同时校验
  // activityId、memberId 与 pass 状态。
  private async validateAndNormalizeRecordsBatch(
    inputs: AttendanceRecordInputDto[],
    activity: { id: string; startAt: Date; endAt: Date; requiresInsurance: boolean },
    now: Date,
    tx: PrismaTx,
  ): Promise<Array<ReturnType<AttendancesService['normalizeRecord']>>> {
    // `@IsOptional()` 会放行运行时 null；contract 仍保持 string optional，但 service
    // 在共享批校验入口将 null 规范化为“未传”，避免 null 进入 Prisma `in` 查询，
    // 并确保 submit/edit 对保险活动使用同一缺失报名语义。
    const canonicalInputs = inputs.map((input) => ({
      ...input,
      registrationId: input.registrationId ?? undefined,
    }));
    const roleCodes = [...new Set(canonicalInputs.map((input) => input.roleCode))];
    const attendanceStatusCodes = [...new Set(inputs.map((input) => input.attendanceStatusCode))];
    const memberIds = [...new Set(inputs.map((input) => input.memberId))];
    const registrationIds = [
      ...new Set(
        canonicalInputs
          .map((input) => input.registrationId)
          .filter((id): id is string => id !== undefined),
      ),
    ];

    const [dictItems, members, registrations] = await Promise.all([
      tx.dictItem.findMany({
        where: {
          status: DictItemStatus.ACTIVE,
          deletedAt: null,
          OR: [
            {
              code: { in: roleCodes },
              type: {
                code: DICT_TYPE_ATTENDANCE_ROLE,
                status: DictTypeStatus.ACTIVE,
                deletedAt: null,
              },
            },
            {
              code: { in: attendanceStatusCodes },
              type: {
                code: DICT_TYPE_ATTENDANCE_STATUS,
                status: DictTypeStatus.ACTIVE,
                deletedAt: null,
              },
            },
          ],
        },
        select: { code: true, type: { select: { code: true } } },
      }),
      tx.member.findMany({
        where: notDeletedWhere({ id: { in: memberIds } }),
        select: { id: true },
      }),
      tx.activityRegistration.findMany({
        where: notDeletedWhere({ id: { in: registrationIds } }),
        select: {
          id: true,
          activityId: true,
          memberId: true,
          statusCode: true,
          activityPosition: {
            select: {
              startAt: true,
              endAt: true,
            },
          },
        },
      }),
    ]);

    const dictKeys = new Set(dictItems.map((item) => `${item.type.code}:${item.code}`));
    const existingMemberIds = new Set(members.map((member) => member.id));
    const registrationById = new Map(
      registrations.map((registration) => [registration.id, registration]),
    );

    return canonicalInputs.map((input) => {
      if (!dictKeys.has(`${DICT_TYPE_ATTENDANCE_ROLE}:${input.roleCode}`)) {
        throw new BizException(BizCode.ATTENDANCE_ROLE_CODE_INVALID);
      }
      if (!dictKeys.has(`${DICT_TYPE_ATTENDANCE_STATUS}:${input.attendanceStatusCode}`)) {
        throw new BizException(BizCode.ATTENDANCE_STATUS_CODE_INVALID);
      }
      if (!existingMemberIds.has(input.memberId)) {
        throw new BizException(BizCode.MEMBER_NOT_FOUND);
      }
      const registration =
        input.registrationId === undefined ? undefined : registrationById.get(input.registrationId);
      if (activity.requiresInsurance && input.registrationId === undefined) {
        throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
      }
      if (input.registrationId !== undefined) {
        if (!registration || registration.activityId !== activity.id) {
          throw new BizException(BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH);
        }
        if (registration.memberId !== input.memberId || registration.statusCode !== 'pass') {
          throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
        }
      }

      const normalized = this.normalizeRecord(input);
      const activityPosition = registration?.activityPosition;
      const schedule =
        activityPosition !== undefined &&
        activityPosition !== null &&
        activityPosition.startAt !== null &&
        activityPosition.endAt !== null
          ? { startAt: activityPosition.startAt, endAt: activityPosition.endAt }
          : activity;
      this.assertRecordWithinActivityWindow(normalized, schedule);
      if (normalized.checkOutAt.getTime() > now.getTime()) {
        throw new BizException(BizCode.ATTENDANCE_CHECK_OUT_IN_FUTURE);
      }
      return normalized;
    });
  }

  // submit / edit 在普通批量校验后，以公共 CAS 原语锁住全部 pass registration，
  // **并在锁后复读复判**。排序去重保持多报名批次锁序稳定；并发 cancel 必须等到本事务提交，
  // 再由既有 21033 参与证据守卫拒绝，不能留下 cancelled registration + live record。
  //
  // 为什么 claim 之后还要复读(并发审计 B-Y1 / S1):`claimAtStatus` 只保证「锁到手时
  // statusCode 仍是 pass」,records 依赖的其余事实 —— 报名归属哪个活动、归属哪个队员、
  // 岗位时段 —— 全部来自 claim **之前**那次普通读。它们当前不可达是因为改这些字段的
  // 写方都得先拿 Activity 根锁,而调用方已持有它;但这份安全寄生在别处,不写在这里。
  // 锁后按同一批 id 复读一次并重跑校验,这条路径就自洽了。
  private async claimAndRecheckRegistrations(
    normalized: ReadonlyArray<ReturnType<AttendancesService['normalizeRecord']>>,
    activity: { id: string; startAt: Date; endAt: Date },
    tx: PrismaTx,
  ): Promise<void> {
    const registrationIds = [
      ...new Set(
        normalized
          .map((record) => record.registrationId)
          .filter((registrationId): registrationId is string => registrationId !== null),
      ),
    ].sort();
    if (registrationIds.length === 0) return;

    for (const registrationId of registrationIds) {
      await claimAtStatus(tx, {
        target: 'activityRegistration',
        id: registrationId,
        expectedStatus: 'pass',
        invalidStatusBiz: BizCode.ATTENDANCE_REGISTRATION_INVALID,
      });
    }

    const lockedRegistrations = await tx.activityRegistration.findMany({
      where: notDeletedWhere({ id: { in: registrationIds } }),
      select: {
        id: true,
        activityId: true,
        memberId: true,
        statusCode: true,
        activityPosition: { select: { startAt: true, endAt: true } },
      },
    });
    const lockedById = new Map(
      lockedRegistrations.map((registration) => [registration.id, registration]),
    );

    for (const record of normalized) {
      if (record.registrationId === null) continue;
      const registration = lockedById.get(record.registrationId);
      if (!registration || registration.activityId !== activity.id) {
        throw new BizException(BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH);
      }
      if (registration.memberId !== record.memberId || registration.statusCode !== 'pass') {
        throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
      }
      const position = registration.activityPosition;
      const schedule =
        position !== null && position.startAt !== null && position.endAt !== null
          ? { startAt: position.startAt, endAt: position.endAt }
          : activity;
      this.assertRecordWithinActivityWindow(record, schedule);
    }
  }

  // 时间不重叠校验(R16 / Q-S15)已抽至 `time-overlap-policy.ts` 的 `TimeOverlapPolicy`
  // (refactor PR;沿 PR #179 9 个 characterization case 锁定的现状行为零变化)。
  // submit(...) / edit(...) 内通过 `this.timeOverlapPolicy.assertNoInternalOverlap(...)` +
  // `this.timeOverlapPolicy.assertNoTimeOverlap(...)` 委托,事务边界保持在
  // `this.prisma.$transaction(...)` 内(tx 透传;excludeSheetId 语义不变)。

  // ============ submit(POST 提交 Sheet)============

  // 批次 4-B 升级:
  // - contributionPoints 不接受客户端输入,submit/edit 统一由 ContributionRule 计算。
  //   规则匹配维度:activityType × attendanceRole；每个 pair 至多一条 ACTIVE，
  //   数据库漂移返回多条时 calculator fail-closed，绝不按排序任取一条；
  //   无匹配规则 → service 保守落 0,不抛错(沿 D-S11 22048 不开)。
  // - D2-a:提交只创建 pending Sheet，不再隐式推动 Activity.completed。
  async submit(
    activityId: string,
    dto: CreateAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: AttendanceAuthorization = 'authz',
  ): Promise<AttendanceSheetResponseDto> {
    await this.assertCanOrThrow(currentUser, 'attendance.create.sheet', {
      type: 'activity',
      id: activityId,
    });
    // M3:本事务内会取队员线性化键 ⇒ 必须显式 ReadCommitted + 有界锁等待(见 util 注释)。
    return runMemberLinearizedTransaction(this.prisma, async (tx) => {
      // 1. 与 pass cancel / GPS check-in 统一 Activity → Registration 锁序。
      // managed 以 FOR UPDATE 与责任撤销/移交串行并锁后重读 capability；Admin 默认仍用 FOR SHARE。
      if (authorization === 'managed') {
        await this.lockActivityForAttendanceWrite(activityId, tx);
        await this.assertManagedAttendanceAccess(activityId, currentUser, tx);
      } else {
        const lockedActivity = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Activity"
          WHERE id = ${activityId} AND "deletedAt" IS NULL
          FOR SHARE
        `;
        if (lockedActivity.length === 0) {
          throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
        }
      }

      // 2. activity 存在 + 参与状态合法；同时取 activityTypeCode 与时间窗。
      const activity = await this.findActivityForSubmissionFull(activityId, tx);

      // 3. 固定 3 次 IN 批量预取 + 按输入顺序完成字典/队员/报名/时间窗/时长校验。
      const now = new Date();
      const normalized = await this.validateAndNormalizeRecordsBatch(
        dto.records,
        activity,
        now,
        tx,
      );
      await this.claimAndRecheckRegistrations(normalized, activity, tx);

      // 4. 数组内部时间不重叠 + 与已有跨 Sheet 全局不重叠
      // 抽出至 TimeOverlapPolicy(refactor PR;算法 / 边界 / excludeSheetId 语义零变化)。
      this.timeOverlapPolicy.assertNoInternalOverlap(normalized);
      await this.timeOverlapPolicy.lockMembersForOverlapCheck(
        normalized.map((record) => record.memberId),
        tx,
      );
      await this.timeOverlapPolicy.assertNoTimeOverlapForRecords(normalized, undefined, tx);

      // 5. contributionPoints 由 ContributionRule 权威计算;无匹配规则保守为 0。
      const prefilled = await this.contributionCalculator.applyContributionRulePrefill(
        normalized,
        activity.activityTypeCode,
        tx,
      );

      // 6. 事务内一次性 create Sheet + N records
      const created = await tx.attendanceSheet.create({
        data: {
          activityId,
          submitterUserId: currentUser.id,
          lastSubmittedByUserId: currentUser.id,
          lastSubmittedAt: now,
          statusCode: SHEET_STATUS_PENDING,
          version: 1,
          records: {
            create: prefilled.map((r) => ({
              memberId: r.memberId,
              roleCode: r.roleCode,
              checkInAt: r.checkInAt,
              checkOutAt: r.checkOutAt,
              serviceHours: r.serviceHours,
              attendanceStatusCode: r.attendanceStatusCode,
              note: r.note,
              registrationId: r.registrationId,
              contributionPoints: r.contributionPoints,
            })),
          },
        },
        select: sheetSafeSelect,
      });

      // D2-a:completed 仅由管理端 complete 动作推进；字段保留供审计契约兼容且恒 false。
      const activityPushedToCompleted = false;

      // PR #6 audit:after 含 sheet + records 完整快照(records 创建后回查一次取完整字段)
      const createdRecords = await tx.attendanceRecord.findMany({
        where: { sheetId: created.id, deletedAt: null },
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });
      await this.attendanceAuditRecorder.logSubmit({
        sheetId: created.id,
        sheet: created,
        records: createdRecords,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        activityId,
        recordsCount: createdRecords.length,
        activityPushedToCompleted,
        auditMeta,
        tx,
      });

      return this.attendancePresenter.toSheetResponseDto(created);
    });
  }

  // 返回预填所需 activityTypeCode、参与状态与考勤时间窗。
  private async findActivityForSubmissionFull(
    activityId: string,
    tx: PrismaTx,
  ): Promise<{
    id: string;
    statusCode: string;
    activityTypeCode: string;
    startAt: Date;
    endAt: Date;
    requiresInsurance: boolean;
  }> {
    const act = await tx.activity.findFirst({
      where: notDeletedWhere({ id: activityId }),
      select: {
        id: true,
        statusCode: true,
        activityTypeCode: true,
        startAt: true,
        endAt: true,
        requiresInsurance: true,
      },
    });
    if (!act) {
      throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    }
    const decision = this.activityParticipationPolicy.canSubmitAttendance(act);
    if (!decision.allowed) throw new BizException(decision.biz);
    return act;
  }

  private async findActivityWindowOrThrow(
    activityId: string,
    tx: PrismaTx,
  ): Promise<{
    id: string;
    statusCode: string;
    activityTypeCode: string;
    startAt: Date;
    endAt: Date;
    requiresInsurance: boolean;
  }> {
    const activity = await tx.activity.findFirst({
      where: notDeletedWhere({ id: activityId }),
      select: {
        id: true,
        // A-R2 方案乙:edit 的 records 分支要按活动状态判增量闸,故此处补取 statusCode。
        statusCode: true,
        activityTypeCode: true,
        startAt: true,
        endAt: true,
        requiresInsurance: true,
      },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  // 批次 4-B D14 5.B contribution prefill 已抽至 `contribution-calculator.ts` 的
  // `ContributionCalculator`(refactor PR;沿 D-S4 / D-A8 / D-S11 / §3.1)。
  // submit(...) 内通过 `this.contributionCalculator.applyContributionRulePrefill(...)` 委托,
  // 事务边界保持在 `this.prisma.$transaction(...)` 内(tx 透传)。

  // ============ list(GET 列表)============

  async list(
    activityId: string,
    query: ListAttendanceSheetsQueryDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    authorization: AttendanceAuthorization = 'authz',
  ): Promise<PageResultDto<AttendanceSheetListItemDto>> {
    await this.assertCanOrThrow(currentUser, 'attendance.read.sheet', {
      type: 'activity',
      id: activityId,
    });
    if (authorization === 'managed') {
      await this.assertManagedAttendanceAccess(activityId, currentUser);
    }
    await this.prisma.$transaction(async (tx) => {
      await this.assertActivityExists(activityId, tx);
    });

    const { page, pageSize, statusCode } = query;
    const filters: Prisma.AttendanceSheetWhereInput = { activityId };
    if (statusCode !== undefined) filters.statusCode = statusCode;
    const where = notDeletedWhere(filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendanceSheet.findMany({
        where,
        select: sheetListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attendanceSheet.count({ where }),
    ]);

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
    const {
      page,
      pageSize,
      statusCode,
      q,
      activityQ,
      organizationId,
      includeDescendants,
      dateFrom,
      dateTo,
      expand,
    } = query;
    const visibleOrganizationIds = await this.resolveVisibleOrganizationIds(
      currentUser,
      organizationId,
      includeDescendants,
    );
    const expandSet = parseExpandQuery(expand, ATTENDANCE_EXPAND_WHITELIST);

    const filters: Prisma.AttendanceSheetWhereInput = {};
    if (statusCode !== undefined) filters.statusCode = statusCode;
    if (dateFrom !== undefined || dateTo !== undefined) {
      filters.submittedAt = {
        ...(dateFrom !== undefined ? { gte: new Date(dateFrom) } : {}),
        ...(dateTo !== undefined ? { lte: new Date(dateTo) } : {}),
      };
    }

    // activity 关联过滤累加(activityQ + organizationId/includeDescendants 可共存)。
    const activityWhere: Prisma.ActivityWhereInput = {};
    if (activityQ !== undefined) {
      activityWhere.title = { contains: activityQ, mode: 'insensitive' };
    }
    if (visibleOrganizationIds !== undefined) {
      activityWhere.organizationId = { in: visibleOrganizationIds };
    }
    if (Object.keys(activityWhere).length > 0) filters.activity = activityWhere;

    // q:跨 activity(title)+ submitter(username+nickname)全局模糊命中。
    if (q !== undefined) {
      filters.OR = [
        { activity: { title: { contains: q, mode: 'insensitive' } } },
        { submitter: { username: { contains: q, mode: 'insensitive' } } },
        { submitter: { nickname: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const where = notDeletedWhere(filters);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendanceSheet.findMany({
        where,
        select: adminSheetListSelect,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attendanceSheet.count({ where }),
    ]);

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
    await this.assertCanOrThrow(currentUser, 'attendance.read.sheet', {
      type: 'member',
      id: memberId,
    });
    // 队员存在性守卫(不存在 / 软删 → 15001,镜像 admin-member-insurances inline 检查)。
    const member = await this.prisma.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);

    const { page, pageSize } = query;
    const where = notDeletedWhere({
      memberId,
      sheet: { statusCode: ATTENDANCE_SHEET_STATUS.APPROVED, deletedAt: null },
    });

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.findMany({
        where,
        select: adminMemberRecordSelect,
        orderBy: { checkInAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);

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
    await this.assertCanOrThrow(currentUser, 'attendance.read.sheet', {
      type: 'member',
      id: memberId,
    });
    const member = await this.prisma.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);

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
    await this.assertCanOrThrow(currentUser, 'attendance.read.sheet', {
      type: 'attendance_sheet',
      id,
    });
    if (managedActivityId !== undefined) {
      await this.assertManagedAttendanceAccess(managedActivityId, currentUser);
    }
    const sheet = await this.prisma.$transaction(async (tx) => this.findSheetOrThrow(id, tx));
    this.assertManagedSheetActivity(sheet.activityId, managedActivityId);

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
    await this.assertCanOrThrow(currentUser, 'attendance.read.sheet', {
      type: 'attendance_sheet',
      id,
    });
    if (managedActivityId !== undefined) {
      await this.assertManagedAttendanceAccess(managedActivityId, currentUser);
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);
      this.assertManagedSheetActivity(sheet.activityId, managedActivityId);

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

  // ============ edit(PATCH 编辑 pending/returned Sheet)============

  // D38 路径:
  // 1. 校验当前 statusCode === pending(approved → 22040;rejected → 22041)
  // 2. 生成 previousSnapshot(Q-S16 结构:Sheet 主字段 + records 全字段快照)
  // 3. version + 1
  // 4. 旧 records 软删 + 新 records 创建
  // 5. 重跑全部字典 / 时间 / serviceHours / registrationId 跨表校验
  async edit(
    id: string,
    dto: UpdateAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    managedActivityId?: string,
  ): Promise<AttendanceSheetResponseDto> {
    await this.assertCanOrThrow(currentUser, 'attendance.update.sheet', {
      type: 'attendance_sheet',
      id,
    });
    // M3:本事务内会取队员线性化键 ⇒ 必须显式 ReadCommitted + 有界锁等待(见 util 注释)。
    return runMemberLinearizedTransaction(this.prisma, async (tx) => {
      // K1(S7 收口):Activity 聚合锁**两条 surface 都取**,不再只有 managed 分支取。
      // managed 面必须在暴露 Sheet 存在性之前先判权,所以它按 managedActivityId 先锁再判权;
      // Admin 面没有这道前置,读到 Sheet 后按其 activityId 取同一把锁。
      // `assertManagedSheetActivity` 保证 managed 时两个 id 相等 —— 锁的是同一行。
      const lockedByManagedBranch = managedActivityId !== undefined;
      if (managedActivityId !== undefined) {
        await this.lockActivityForAttendanceWrite(managedActivityId, tx);
        await this.assertManagedAttendanceAccess(managedActivityId, currentUser, tx);
      }
      const sheet = await this.findSheetOrThrow(id, tx);
      this.assertManagedSheetActivity(sheet.activityId, managedActivityId);
      if (!lockedByManagedBranch) {
        await this.lockActivityForAttendanceWrite(sheet.activityId, tx);
      }

      const editTransition = this.sheetStateMachine.decide('edit', sheet.statusCode);
      if (!editTransition.allowed) {
        throw new BizException(editTransition.biz);
      }

      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id: sheet.id,
        expectedStatus: sheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
      });
      const lockedSheet = await this.findSheetOrThrow(id, tx);
      // 没有 records 字段 → 等同于 no-op(不动 records,仍生成 snapshot + version+1)
      if (dto.records === undefined) {
        // 仅 version+1 + snapshot 保存当前状态
        const currentRecords = await tx.attendanceRecord.findMany({
          where: notDeletedWhere({ sheetId: id }),
          select: recordWithMemberSelect,
        });
        const snapshot = this.attendanceAuditRecorder.buildPreviousSnapshot(
          lockedSheet,
          currentRecords,
        );
        const updated = await tx.attendanceSheet.update({
          where: { id: lockedSheet.id },
          data: {
            version: lockedSheet.version + 1,
            previousSnapshot: snapshot as Prisma.InputJsonValue,
          },
          select: sheetSafeSelect,
        });
        await this.attendanceAuditRecorder.logEditNoRecords({
          sheetId: id,
          beforeSheet: lockedSheet,
          afterSheet: updated,
          records: currentRecords,
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          recordsCount: currentRecords.length,
          newVersion: updated.version,
          auditMeta,
          tx,
        });
        return this.attendancePresenter.toSheetResponseDto(updated);
      }

      // 1. 校验新 records；edit 同样按所属活动时间窗复核。
      const activity = await this.findActivityWindowOrThrow(lockedSheet.activityId, tx);
      // A-R2 拍板(2026-07-31,方案乙):活动取消后**掐断增量** —— 已存在的考勤单可以走完
      // 审批并结算,但不得再改写 records(那是贡献值的唯一另一条增量来源)。
      // 这次读在 K1 的 Activity `FOR UPDATE` 之内,所以并发 cancel 不能从这道闸旁边挤进去。
      const recordsChangeDecision =
        this.activityParticipationPolicy.canChangeAttendanceRecords(activity);
      if (!recordsChangeDecision.allowed) {
        throw new BizException(recordsChangeDecision.biz);
      }
      const now = new Date();
      const normalized = await this.validateAndNormalizeRecordsBatch(
        dto.records,
        activity,
        now,
        tx,
      );
      // K1:与 submit 逐字对齐 —— 引用到的 pass 报名必须在本事务内认领并锁后复判,
      // 否则并发取消会在「读到 pass」与「写 record」之间挤进来。
      await this.claimAndRecheckRegistrations(normalized, activity, tx);

      // 抽出至 TimeOverlapPolicy(refactor PR;edit 路径透传 excludeSheetId=id 语义不变)。
      this.timeOverlapPolicy.assertNoInternalOverlap(normalized);
      await this.timeOverlapPolicy.lockMembersForOverlapCheck(
        normalized.map((record) => record.memberId),
        tx,
      );
      // edit 路径:排除本 Sheet 旧 records(它们将被软删)
      await this.timeOverlapPolicy.assertNoTimeOverlapForRecords(normalized, id, tx);

      const computed = await this.contributionCalculator.applyContributionRulePrefill(
        normalized,
        activity.activityTypeCode,
        tx,
      );

      // 2. 生成 previousSnapshot(在旧 records 软删之前抓取)
      const currentRecords = await tx.attendanceRecord.findMany({
        where: notDeletedWhere({ sheetId: id }),
        select: recordWithMemberSelect,
      });
      const snapshot = this.attendanceAuditRecorder.buildPreviousSnapshot(
        lockedSheet,
        currentRecords,
      );

      // 3. 软删旧 records + 创建新 records(D38)
      await tx.attendanceRecord.updateMany({
        where: { sheetId: id, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.attendanceRecord.createMany({
        data: computed.map((r) => ({
          sheetId: id,
          memberId: r.memberId,
          roleCode: r.roleCode,
          checkInAt: r.checkInAt,
          checkOutAt: r.checkOutAt,
          serviceHours: r.serviceHours,
          attendanceStatusCode: r.attendanceStatusCode,
          note: r.note,
          registrationId: r.registrationId,
          contributionPoints: r.contributionPoints,
        })),
      });

      // 4. 更新 Sheet:version+1 + previousSnapshot
      const updated = await tx.attendanceSheet.update({
        where: { id: lockedSheet.id },
        data: {
          version: lockedSheet.version + 1,
          previousSnapshot: snapshot as Prisma.InputJsonValue,
        },
        select: sheetSafeSelect,
      });

      // PR #6 audit:after 含新 records 完整快照(createMany 不返 id,回查一次)
      const newRecords = await tx.attendanceRecord.findMany({
        where: { sheetId: id, deletedAt: null },
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });
      await this.attendanceAuditRecorder.logEdit({
        sheetId: id,
        beforeSheet: lockedSheet,
        beforeRecords: currentRecords,
        afterSheet: updated,
        afterRecords: newRecords,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        oldRecordsCount: currentRecords.length,
        newRecordsCount: newRecords.length,
        newVersion: updated.version,
        auditMeta,
        tx,
      });

      return this.attendancePresenter.toSheetResponseDto(updated);
    });
  }

  // ============ softDelete(DELETE)============

  async softDelete(
    id: string,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    managedActivityId?: string,
  ): Promise<AttendanceSheetResponseDto> {
    await this.assertCanOrThrow(currentUser, 'attendance.delete.sheet', {
      type: 'attendance_sheet',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      // K1 / A-Y1:与 edit 同一形状 —— 两条 surface 都取 Activity 聚合锁。
      // softDelete 的方向是移除考勤证据,最坏后果止于并发取消误报 21033;但让
      // edit / softDelete / resubmit 收敛成同一种写法,比记住"这条为什么可以不锁"更省。
      const lockedByManagedBranch = managedActivityId !== undefined;
      if (managedActivityId !== undefined) {
        await this.lockActivityForAttendanceWrite(managedActivityId, tx);
        await this.assertManagedAttendanceAccess(managedActivityId, currentUser, tx);
      }
      const sheet = await this.findSheetOrThrow(id, tx);
      this.assertManagedSheetActivity(sheet.activityId, managedActivityId);
      if (!lockedByManagedBranch) {
        await this.lockActivityForAttendanceWrite(sheet.activityId, tx);
      }

      const deleteTransition = this.sheetStateMachine.decide('softDelete', sheet.statusCode);
      if (!deleteTransition.allowed) {
        throw new BizException(deleteTransition.biz);
      }

      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id: sheet.id,
        expectedStatus: sheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
      });
      const lockedSheet = await this.findSheetOrThrow(id, tx);
      // PR #6 audit:before 需要 records 完整快照(软删之前抓取)
      const currentRecords = await tx.attendanceRecord.findMany({
        where: { sheetId: id, deletedAt: null },
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });

      const now = new Date();
      await tx.attendanceRecord.updateMany({
        where: { sheetId: id, deletedAt: null },
        data: { deletedAt: now },
      });
      const removed = await tx.attendanceSheet.update({
        where: { id: lockedSheet.id },
        data: { deletedAt: now },
        select: sheetSafeSelect,
      });

      await this.attendanceAuditRecorder.logDelete({
        sheetId: id,
        beforeSheet: lockedSheet,
        beforeRecords: currentRecords,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: lockedSheet.statusCode,
        recordsCount: currentRecords.length,
        auditMeta,
        tx,
      });

      return this.attendancePresenter.toSheetResponseDto(removed);
    });
  }

  // ============ approve(PATCH;APD 一级)============

  // 批次 4-B 状态机升级(沿 D-A1 / D-S6 / D-S7 / D-S8):
  // - 状态机:pending → **pending_final_review**(原 v0.4.0 是 → approved 终态)
  // - R31 仍在此校验:所有 records.contributionPoints !== null;否则 22072(沿 D-S8)
  // - 写 reviewerUserId / reviewedAt / reviewNote(APD 一级审核责任人)
  // - **不再触发** eventPlaceholder('attendance.recorded')(沿 D-S7;触发位置移到 finalApprove)
  // - audit:沿 attendance-sheet.review,action='approve';nextStatusCode 升级为 pending_final_review
  async approve(
    id: string,
    dto: ApproveAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    await this.assertCanOrThrow(currentUser, 'attendance.approve.sheet', {
      type: 'attendance_sheet',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      const approveTransition = this.sheetStateMachine.decide('approve', sheet.statusCode);
      if (!approveTransition.allowed) {
        throw new BizException(approveTransition.biz);
      }

      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id: sheet.id,
        expectedStatus: sheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
      });
      const lockedSheet = await this.findSheetOrThrow(id, tx);
      this.assertLockedReviewSeparation('first', lockedSheet, currentUser);

      // R31:所有 records contributionPoints 必填(沿 D-S8;APD 一级 approve 时校验)
      const recordsForCheck = await tx.attendanceRecord.findMany({
        where: notDeletedWhere({ sheetId: id }),
        select: { id: true, contributionPoints: true },
      });
      if (recordsForCheck.some((r) => r.contributionPoints === null)) {
        throw new BizException(BizCode.ATTENDANCE_RECORD_CONTRIBUTION_POINTS_REQUIRED);
      }
      const reviewedAt = new Date();
      const updated = await tx.attendanceSheet.update({
        where: { id: lockedSheet.id },
        data: {
          statusCode: approveTransition.nextStatusCode,
          reviewerUserId: currentUser.id,
          reviewedAt,
          reviewNote: dto.reviewNote ?? null,
        },
        select: sheetSafeSelect,
      });

      await this.attendanceAuditRecorder.logReview({
        sheetId: id,
        beforeSheet: lockedSheet,
        afterSheet: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'approve',
        priorStatusCode: lockedSheet.statusCode,
        nextStatusCode: approveTransition.nextStatusCode,
        recordsCount: recordsForCheck.length,
        auditMeta,
        tx,
      });

      return this.attendancePresenter.toSheetResponseDto(updated);
    });
  }

  // ============ return(POST;独立一审退回修改)============

  async firstReturn(
    id: string,
    dto: ReturnAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    const returnNote = dto.returnNote.trim();
    if (!returnNote) throw new BizException(BizCode.ATTENDANCE_RETURN_NOTE_REQUIRED);
    await this.assertCanOrThrow(currentUser, 'attendance.return.sheet', {
      type: 'attendance_sheet',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);
      const transition = this.sheetStateMachine.decide('firstReturn', sheet.statusCode);
      if (!transition.allowed) throw new BizException(transition.biz);

      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id: sheet.id,
        expectedStatus: sheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
      });
      const lockedSheet = await this.findSheetOrThrow(id, tx);
      this.assertLockedReviewSeparation('first', lockedSheet, currentUser);
      const recordsCount = await tx.attendanceRecord.count({
        where: notDeletedWhere({ sheetId: id }),
      });
      const returnedAt = new Date();
      const updated = await tx.attendanceSheet.update({
        where: { id: lockedSheet.id },
        data: {
          statusCode: transition.nextStatusCode,
          reviewerUserId: currentUser.id,
          reviewedAt: returnedAt,
          returnedByUserId: currentUser.id,
          returnedAt,
          returnNote,
          returnedFromStageCode: 'first',
        },
        select: sheetSafeSelect,
      });

      await this.attendanceAuditRecorder.logReview({
        sheetId: id,
        beforeSheet: lockedSheet,
        afterSheet: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'return',
        priorStatusCode: lockedSheet.statusCode,
        nextStatusCode: transition.nextStatusCode,
        recordsCount,
        auditMeta,
        tx,
      });

      await this.attendanceNotificationProducer.enqueueReturned(tx, {
        sheetId: id,
        activityId: updated.activityId,
        returnedAt,
        returnNote,
        submitterUserIds: [
          updated.submitterUserId,
          ...(updated.lastSubmittedByUserId ? [updated.lastSubmittedByUserId] : []),
        ],
      });

      return this.attendancePresenter.toSheetResponseDto(updated);
    });
  }

  // ============ reject(PATCH;APD 一级)============

  async reject(
    id: string,
    dto: RejectAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    await this.assertCanOrThrow(currentUser, 'attendance.reject.sheet', {
      type: 'attendance_sheet',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      const rejectTransition = this.sheetStateMachine.decide('reject', sheet.statusCode);
      if (!rejectTransition.allowed) {
        throw new BizException(rejectTransition.biz);
      }

      // F4(#399):一级 reject 的 records **跟随软删**(对称 final_rejected;沿 softDelete / finalReject
      // 范式)。原先 rejected 的 records 仍 deletedAt IS NULL → 永久占用 time-overlap 窗口
      // (overlap 只过 deletedAt),致该队员同窗无法重交(死锁)。软删后窗口释放,可重新提交。
      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id: sheet.id,
        expectedStatus: sheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
      });
      const lockedSheet = await this.findSheetOrThrow(id, tx);
      this.assertLockedReviewSeparation('first', lockedSheet, currentUser);

      // 软删前抓 records 全字段快照入 audit(对称 finalReject;沿 §audit records 必含组)。
      const currentRecords = await tx.attendanceRecord.findMany({
        where: { sheetId: id, deletedAt: null },
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });

      const reviewedAt = new Date();
      await tx.attendanceRecord.updateMany({
        where: { sheetId: id, deletedAt: null },
        data: { deletedAt: reviewedAt },
      });

      const updated = await tx.attendanceSheet.update({
        where: { id: lockedSheet.id },
        data: {
          statusCode: rejectTransition.nextStatusCode,
          reviewerUserId: currentUser.id,
          reviewedAt,
          reviewNote: dto.reviewNote,
        },
        select: sheetSafeSelect,
      });

      await this.attendanceAuditRecorder.logReview({
        sheetId: id,
        beforeSheet: lockedSheet,
        beforeRecords: currentRecords,
        afterSheet: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'reject',
        priorStatusCode: lockedSheet.statusCode,
        nextStatusCode: rejectTransition.nextStatusCode,
        recordsCount: currentRecords.length,
        auditMeta,
        tx,
      });

      return this.attendancePresenter.toSheetResponseDto(updated);
    });
  }

  // ============ final-approve(PATCH;批次 4-B 新增 — 终审通过)============

  // 沿 D-S5 / D-S7 / D-A2:
  // - 状态机:pending_final_review → approved(贡献值正式生效)
  // - 状态非 pending_final_review 抛 **22045** ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID
  //   (终态 approved / rejected / final_rejected 再次调用一律走此码)
  // - 写 finalReviewerUserId / finalReviewedAt / finalReviewNote
  // - **触发** eventPlaceholder('attendance.recorded')(approved-only;同事务内;沿 D-S7)
  // - audit:attendance-sheet.final-review(action='final-approve');沿 D-S11 / 业务规则文档 §8.4
  // - **不重校验**逐条 records.contributionPoints(沿 D-S8;R31 在 APD 一级已校验)
  // - 权限(终态 scoped-authz PR9 起):走 authz.explain('attendance.final-approve.sheet', ref)
  //   —— biz-admin 全局终审保留(B 方案;摘码 = PR12 显式项)+ scoped RoleBinding 通路
  //   + 自审禁止(22074,SUPER_ADMIN 亦拒)/ 同人默认禁止(22075,env 可配);
  //   判权不足仍走 RBAC_FORBIDDEN(30100),22044 模块码维持不开。
  async finalApprove(
    id: string,
    dto: FinalApproveAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    await this.assertFinalReviewAuthzOrThrow(currentUser, 'attendance.final-approve.sheet', id);
    // M3:本事务内会取队员线性化键 ⇒ 必须显式 ReadCommitted + 有界锁等待(见 util 注释)。
    return runMemberLinearizedTransaction(this.prisma, async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      const finalApproveTransition = this.sheetStateMachine.decide(
        'finalApprove',
        sheet.statusCode,
      );
      if (!finalApproveTransition.allowed) {
        throw new BizException(finalApproveTransition.biz);
      }

      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id: sheet.id,
        expectedStatus: sheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID,
      });
      const lockedSheet = await this.findSheetOrThrow(id, tx);
      this.assertLockedReviewSeparation('final', lockedSheet, currentUser);

      const recordsForEvent = await tx.attendanceRecord.findMany({
        where: notDeletedWhere({ sheetId: id }),
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });
      // K3(B-F2 write skew):入队贡献值里程碑的判定依据是**跨 Sheet** 的 member 聚合,
      // 而本事务只锁住了自己这一张 Sheet。缺共同键时两张 Sheet 同时终审会各读 before=3、
      // 各算 after=4,谁都不跨 5 分、谁都不尝试 enqueue —— outbox 唯一键兜不住「两边都没插」,
      // 通知就此永久丢失(同 application + 门槛只有一次首跨机会)。
      // 取键位置固定在 **Sheet claim 之后**,与 submit/edit 的「聚合行锁在前、member 键在后」
      // 同向;取在 claim 之前会与 edit 反向,凑出 40P01。
      await lockMembersForWrite(
        tx,
        recordsForEvent.map((record) => record.memberId),
      );
      const contributionThresholdSnapshots =
        await this.attendanceNotificationProducer.prepareContributionThresholdSnapshots(
          tx,
          recordsForEvent,
        );

      const finalReviewedAt = new Date();
      const updated = await tx.attendanceSheet.update({
        where: { id: lockedSheet.id },
        data: {
          statusCode: finalApproveTransition.nextStatusCode,
          finalReviewerUserId: currentUser.id,
          finalReviewedAt,
          finalReviewNote: dto.finalReviewNote ?? null,
        },
        select: sheetSafeSelect,
      });

      // 触发 attendance.recorded(批次 4-B 移到终审通过时;沿 D-S7;Q-S13 context schema 沿用)
      eventPlaceholder('attendance.recorded', {
        activityId: updated.activityId,
        sheetId: updated.id,
        // context 沿 v0.4.0 Q-S13 schema;新增 finalReviewerUserId / finalReviewedAt 兼容字段
        reviewerUserId: updated.reviewerUserId,
        reviewedAt: updated.reviewedAt?.toISOString() ?? null,
        finalReviewerUserId: currentUser.id,
        finalReviewedAt: finalReviewedAt.toISOString(),
        records: recordsForEvent.map((r) => ({
          recordId: r.id,
          memberId: r.memberId,
          roleCode: r.roleCode,
          attendanceStatusCode: r.attendanceStatusCode,
          checkInAt: r.checkInAt.toISOString(),
          checkOutAt: r.checkOutAt.toISOString(),
          serviceHours: r.serviceHours.toString(),
          contributionPoints: this.attendancePresenter.decimalToString(r.contributionPoints),
          registrationId: r.registrationId,
        })),
      });

      await this.attendanceAuditRecorder.logFinalReview({
        sheetId: id,
        beforeSheet: lockedSheet,
        afterSheet: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'final-approve',
        priorStatusCode: lockedSheet.statusCode,
        nextStatusCode: finalApproveTransition.nextStatusCode,
        recordsCount: recordsForEvent.length,
        eventTriggered: true,
        auditMeta,
        tx,
      });

      await this.attendanceNotificationProducer.enqueueFinalApproved(tx, {
        sheetId: id,
        activityId: updated.activityId,
        finalReviewedAt,
        records: recordsForEvent.map((r) => ({
          id: r.id,
          memberId: r.memberId,
          contributionPoints: this.attendancePresenter.decimalToString(r.contributionPoints),
        })),
        contributionThresholdSnapshots,
      });

      return this.attendancePresenter.toSheetResponseDto(updated);
    });
  }

  // ============ final-return(POST;独立终审退回修改)============

  async finalReturn(
    id: string,
    dto: ReturnAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    const returnNote = dto.returnNote.trim();
    if (!returnNote) throw new BizException(BizCode.ATTENDANCE_RETURN_NOTE_REQUIRED);
    await this.assertFinalReviewAuthzOrThrow(currentUser, 'attendance.final-return.sheet', id);
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);
      const transition = this.sheetStateMachine.decide('finalReturn', sheet.statusCode);
      if (!transition.allowed) throw new BizException(transition.biz);

      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id: sheet.id,
        expectedStatus: sheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID,
      });
      const lockedSheet = await this.findSheetOrThrow(id, tx);
      this.assertLockedReviewSeparation('final', lockedSheet, currentUser);
      const recordsCount = await tx.attendanceRecord.count({
        where: notDeletedWhere({ sheetId: id }),
      });
      const returnedAt = new Date();
      const updated = await tx.attendanceSheet.update({
        where: { id: lockedSheet.id },
        data: {
          statusCode: transition.nextStatusCode,
          finalReviewerUserId: currentUser.id,
          finalReviewedAt: returnedAt,
          returnedByUserId: currentUser.id,
          returnedAt,
          returnNote,
          returnedFromStageCode: 'final',
        },
        select: sheetSafeSelect,
      });

      await this.attendanceAuditRecorder.logFinalReview({
        sheetId: id,
        beforeSheet: lockedSheet,
        afterSheet: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'final-return',
        priorStatusCode: lockedSheet.statusCode,
        nextStatusCode: transition.nextStatusCode,
        recordsCount,
        auditMeta,
        tx,
      });

      await this.attendanceNotificationProducer.enqueueReturned(tx, {
        sheetId: id,
        activityId: updated.activityId,
        returnedAt,
        returnNote,
        submitterUserIds: [
          updated.submitterUserId,
          ...(updated.lastSubmittedByUserId ? [updated.lastSubmittedByUserId] : []),
        ],
      });

      return this.attendancePresenter.toSheetResponseDto(updated);
    });
  }

  // ============ final-reject(PATCH;批次 4-B 新增 — 终审驳回)============

  // 沿 D-S5 / D-S7 / D-A2:
  // - 状态机:pending_final_review → final_rejected
  // - 状态非 pending_final_review 抛 **22045**
  // - finalReviewNote 必填(沿 RejectDto 模式;DTO 层 class-validator 已校验;此处仅作冗余日志兜底,
  //   仍由 service 拒空字符串通过 22046)
  // - 写 finalReviewerUserId / finalReviewedAt / finalReviewNote
  // - records **跟随软删**(沿 D8 主路径)
  // - **不触发** attendance.recorded(沿 D-S7;子项候选 C)
  // - audit:attendance-sheet.final-review(action='final-reject')
  // - 权限同 finalApprove(PR9 起走 authz；scoped 通路 + SUPER_ADMIN 兜底)；
  //   活动责任闭环起 final-reject 同样严格执行自审 / 同人约束。
  async finalReject(
    id: string,
    dto: FinalRejectAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    await this.assertFinalReviewAuthzOrThrow(currentUser, 'attendance.final-reject.sheet', id);
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      const finalRejectTransition = this.sheetStateMachine.decide('finalReject', sheet.statusCode);
      if (!finalRejectTransition.allowed) {
        throw new BizException(finalRejectTransition.biz);
      }

      // DTO 层 @MinLength(1) 已确保非空;此处冗余校验防绕过(沿 RejectDto reviewNote 风格)
      if (dto.finalReviewNote.trim().length === 0) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_NOTE_REQUIRED);
      }

      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id: sheet.id,
        expectedStatus: sheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID,
      });
      const lockedSheet = await this.findSheetOrThrow(id, tx);
      this.assertLockedReviewSeparation('final', lockedSheet, currentUser);

      // PR #6 audit:before 需要 records 完整快照(records 跟随软删之前抓取)
      const currentRecords = await tx.attendanceRecord.findMany({
        where: { sheetId: id, deletedAt: null },
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });

      const finalReviewedAt = new Date();
      // records 跟随软删(沿 D8 主路径)
      await tx.attendanceRecord.updateMany({
        where: { sheetId: id, deletedAt: null },
        data: { deletedAt: finalReviewedAt },
      });

      const updated = await tx.attendanceSheet.update({
        where: { id: lockedSheet.id },
        data: {
          statusCode: finalRejectTransition.nextStatusCode,
          finalReviewerUserId: currentUser.id,
          finalReviewedAt,
          finalReviewNote: dto.finalReviewNote,
        },
        select: sheetSafeSelect,
      });

      await this.attendanceAuditRecorder.logFinalReview({
        sheetId: id,
        beforeSheet: lockedSheet,
        beforeRecords: currentRecords,
        afterSheet: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'final-reject',
        priorStatusCode: lockedSheet.statusCode,
        nextStatusCode: finalRejectTransition.nextStatusCode,
        recordsCount: currentRecords.length,
        finalReviewNote: dto.finalReviewNote,
        auditMeta,
        tx,
      });

      return this.attendancePresenter.toSheetResponseDto(updated);
    });
  }

  // ============ resubmit(POST;returned → pending)============

  async resubmit(
    id: string,
    _dto: ResubmitAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
    managedActivityId?: string,
  ): Promise<AttendanceSheetResponseDto> {
    await this.assertCanOrThrow(currentUser, 'attendance.update.sheet', {
      type: 'attendance_sheet',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const initialSheet = await this.findSheetOrThrow(id, tx);
      this.assertManagedSheetActivity(initialSheet.activityId, managedActivityId);

      await this.lockActivityForAttendanceWrite(initialSheet.activityId, tx);
      if (currentUser.role !== Role.SUPER_ADMIN) {
        await this.assertManagedAttendanceAccess(initialSheet.activityId, currentUser, tx);
      }

      const transition = this.sheetStateMachine.decide('resubmit', initialSheet.statusCode);
      if (!transition.allowed) throw new BizException(transition.biz);
      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id,
        expectedStatus: initialSheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
      });
      const lockedSheet = await this.findSheetOrThrow(id, tx);
      const records = await tx.attendanceRecord.findMany({
        where: notDeletedWhere({ sheetId: id }),
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });
      const submittedAt = new Date();
      const updated = await tx.attendanceSheet.update({
        where: { id },
        data: {
          statusCode: transition.nextStatusCode,
          reviewerUserId: null,
          reviewedAt: null,
          reviewNote: null,
          finalReviewerUserId: null,
          finalReviewedAt: null,
          finalReviewNote: null,
          returnedByUserId: null,
          returnedAt: null,
          returnNote: null,
          returnedFromStageCode: null,
          lastSubmittedByUserId: currentUser.id,
          lastSubmittedAt: submittedAt,
          version: lockedSheet.version + 1,
        },
        select: sheetSafeSelect,
      });
      await this.attendanceAuditRecorder.logResubmit({
        sheetId: id,
        beforeSheet: lockedSheet,
        afterSheet: updated,
        records,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        auditMeta,
        tx,
      });
      return this.attendancePresenter.toSheetResponseDto(updated);
    });
  }

  // ============ reopen(POST;撤回终审通过)============

  // v0.47.0 F2:
  // - 状态机仅允许 approved → pending,不增加新状态;
  // - 保留所有 records / previousSnapshot / version,只清空一审+终审责任字段;
  // - 终审已生效的贡献值依赖 approved 读模型,回 pending 后自然不再计入;
  // - 同事务写 attendance-sheet.reopen before/after 全快照;
  // - 本动作不发通知;后续再次 finalApprove 依既有路径正常发通知。
  async reopen(
    id: string,
    dto: ReopenAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    await this.assertFinalReviewAuthzOrThrow(currentUser, 'attendance.reopen.sheet', id);
    const reason = dto.reason.trim();
    if (reason.length === 0) throw new BizException(BizCode.BAD_REQUEST);

    // M3:本事务内会取队员线性化键 ⇒ 必须显式 ReadCommitted + 有界锁等待(见 util 注释)。
    return runMemberLinearizedTransaction(this.prisma, async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);
      const reopenTransition = this.sheetStateMachine.decide('reopen', sheet.statusCode);
      if (!reopenTransition.allowed) throw new BizException(reopenTransition.biz);

      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id: sheet.id,
        expectedStatus: sheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
      });
      const lockedSheet = await this.findSheetOrThrow(id, tx);

      const records = await tx.attendanceRecord.findMany({
        where: { sheetId: id, deletedAt: null },
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });
      // K3:reopen 把 approved 撤回 pending,等于**下调**这些队员的生效贡献值 ——
      // 它和 finalApprove 是同一个跨 Sheet 聚合的两个写方,必须共享同一把 member 键,
      // 否则并发的终审会基于一份正在被撤回的 before 判里程碑。取键位置与 finalApprove 一致。
      await lockMembersForWrite(
        tx,
        records.map((record) => record.memberId),
      );
      const updated = await tx.attendanceSheet.update({
        where: { id: lockedSheet.id },
        data: {
          statusCode: reopenTransition.nextStatusCode,
          reviewerUserId: null,
          reviewedAt: null,
          reviewNote: null,
          finalReviewerUserId: null,
          finalReviewedAt: null,
          finalReviewNote: null,
        },
        select: sheetSafeSelect,
      });

      await this.attendanceAuditRecorder.logReopen({
        sheetId: id,
        beforeSheet: lockedSheet,
        afterSheet: updated,
        records,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        reason,
        priorStatusCode: lockedSheet.statusCode,
        nextStatusCode: reopenTransition.nextStatusCode,
        auditMeta,
        tx,
      });

      return this.attendancePresenter.toSheetResponseDto(updated);
    });
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

    const { page, pageSize, activityId } = query;
    const sheetWhere: Prisma.AttendanceSheetWhereInput = {
      statusCode: SHEET_STATUS_APPROVED,
      deletedAt: null,
    };
    if (activityId !== undefined) sheetWhere.activityId = activityId;

    const where = notDeletedWhere({ memberId, sheet: sheetWhere });

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attendanceRecord.findMany({
        where,
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.attendanceRecord.count({ where }),
    ]);

    return {
      items: rows.map((r) => this.attendancePresenter.toRecordResponseDto(r)),
      total,
      page,
      pageSize,
    };
  }
}
