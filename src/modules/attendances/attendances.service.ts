import { Injectable, Logger } from '@nestjs/common';
import { DictItemStatus, DictTypeStatus, Prisma } from '@prisma/client';
import { auditPlaceholder } from '../../common/audit/audit-placeholder';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto, PaginationQueryDto } from '../../common/dto/pagination.dto';
import { parseExpandQuery } from '../../common/dto/expand-query.util';
import { eventPlaceholder } from '../../common/event/event-placeholder';
import { BizCode, type BizCodeEntry } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  NOTIFICATION_CHANNEL_IN_APP,
  NOTIFICATION_TYPE_ACTIVITY_REMINDER,
  NOTIFICATION_TYPE_RECRUITMENT,
} from '../notifications/notification.constants';
import { AuthzService } from '../authz/authz.service';
import type { ResourceRef } from '../authz/authz.types';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { OrganizationsService } from '../organizations/organizations.service';
import { RbacService } from '../permissions/rbac.service';
// 跨轴只读(2026-06-23):复用 team-join 贡献值封顶核(单一真相源;生涯累计 cutoff=null)。
// 纯函数调用,非 DI provider → 无 AttendancesModule → TeamJoinModule 依赖;team-join 不反向
// import attendances(team-join.constants 自洽),无循环。
// 十项收口刀F(2026-07-11):终审 Effect 内再复用 computeContribution(入队年 cutoff 口径)判
// 「贡献值达标」定向提醒——仍是纯函数 import,依赖形状不变。
import { computeCappedContribution, computeContribution } from '../team-join/team-join-progress';
import {
  APP_STATUS_JOINING as TEAM_JOIN_APP_STATUS_JOINING,
  CONTRIBUTION_THRESHOLD,
} from '../team-join/team-join.constants';
import { AttendanceAuditRecorder } from './attendance-audit-recorder';
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
  RejectAttendanceSheetDto,
  UpdateAttendanceSheetDto,
} from './attendances.dto';

// F2/B2(admin-api-fe-integration-roadmap.md §4 B2;D6 拍板):expand 白名单,仅
// listAllSheetsForAdmin(admin/v1/attendance-sheets 全局横扫)消费。类型由 parseExpandQuery
// 的泛型从此白名单字面量推导,无需单独导出 key 类型(镜像本文件其余「不为已推导类型再起别名」惯例)。
const ATTENDANCE_EXPAND_WHITELIST = ['activity'] as const;

// V2 第一阶段批次 3B attendances service(批次 4-B 升级:终审 / D14 预填 / D11 推动)。
// 详见 docs:
//   - 批次3_API前评审决议表.md v1.0 §1.8 / §1.9 / §1.14
//   - 批次3_schema草案_activities_attendances.md v0.5 §13 / §15 / §16 / §19
//   - 批次4_贡献值业务规则前评审决议表 v1.0(D5 候选 B 终审 / D11 推动 / D14 5.B 预填)
//   - 批次4_贡献值业务规则_schema草案评审决议表 v1.0(D-S5 / D-S6 / D-S7 / D-S8 / D-S10 / D-S11)
//   - 批次4_贡献值业务规则_API草案 v1.0(D-A1 ~ D-A13)
//   - 批次4_贡献值业务规则_实现前业务规则说明 v1.0
//
// 关键约定:
// - 状态机闭集 5 态(批次 4-B 扩展;沿 D-S6):
//   pending / pending_final_review / approved / rejected / final_rejected
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
//   **D11 推动** Activity.statusCode = 'completed'(若当前 published)。
// - edit:仅 pending → pending;后端生成 previousSnapshot(R28 / Q-S16);version+1;
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
// - contributionPoints(批次 4-B 升级):**仅在 record.contributionPoints === null 时**由 ContributionRule
//   预填;调用方传值不覆盖(沿 D-A8)。无匹配规则时 service 兜底 null(不抛错;沿 D-S11 22048 不开)。
// - registrationId 跨表:非空时 registration.activityId === sheet.activityId(R23)
// - registrationId Restrict:删除 registration 时被 FK 阻断(Q-S21;不破坏历史追溯)
// - audit:submit / edit / delete / read.other / review(approve+reject) / final-review(批次 4-B)
// - event:**attendance.recorded 触发位置移到 final-approve**(沿 D-S7);submit / edit / delete /
//   approve / reject / final-reject 均不触发。
//
// V2 批次 6 PR #6(第二波最后一批):8 处 write hook 从 `auditPlaceholder` 迁移到
// `AuditLogsService.log()` 同事务落库;5 个事件名(`attendance-sheet.{submit, edit, delete, review, final-review}`)
// 共承担 8 处 operation,通过 `extra.operation` / `extra.action` 区分(沿 PR #4 / PR #5 范式,
// D2 同值挪字符串);resourceType 固定 `attendance_sheet`;**3 处 read.other 调用保持 pino-only
// 不迁移**(沿 Q1=A 当前阶段不记录查看行为);**`eventPlaceholder('attendance.recorded')` 与
// audit 是两套独立机制,不动**(沿 D-S7;final-approve 同事务触发业务事件,audit 同事务记录;
// 若 audit 写失败 → 整个事务回滚 → 业务事件随之回滚,由 DB 事务原子性保证)。
// records 全字段快照入 audit context:submit / edit × 2 / softDelete / finalReject / **reject**
// (F4 #399:reject 也软删 records,审计含软删前快照,对称 finalReject)必含;
// approve / finalApprove 只放 sheet 快照,`extra.recordsCount` 元数据(records 不变)。
// 字段非敏感(打码矩阵未命中,沿 PR #3 / PR #4 / PR #5 不打码范式)。

const ACTIVITY_STATUS_PUBLISHED = 'published';
const ACTIVITY_STATUS_CANCELLED = 'cancelled';
const ACTIVITY_STATUS_COMPLETED = 'completed';

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

@Injectable()
export class AttendancesService {
  private readonly logger = new Logger(AttendancesService.name);

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
    // 统一通知 S4(评审稿 §6.4):考勤终审通过 → 本人考勤结果/贡献值定向通知派发器(producer → notifications
    // 单向直调,commit 后事务外、try-catch 永不抛;防环:本服务绝不被通知模块回调)。
    private readonly notificationDispatcher: NotificationDispatcher,
    // F2/B2(路线图 §4;D7 拍板):供 queryDescendantOrgIds() 只读 helper 展开 includeDescendants
    // (closure 非判权,镜像 F1/A6 activities.service.ts 用法)。
    private readonly organizations: OrganizationsService,
  ) {}

  // Slow-4 T3(2026-06-11,评审稿 §3.7 / D-S4-8)起点;终态 scoped-authz PR12(2026-07-02;
  // 冻结稿 §11 + 决断①②)升级:判权走 authz.explain,ref 矩阵——
  //   - submit(create.sheet)/ list(嵌套 :activityId)传 {type:'activity', id: activityId}
  //   - findOne / reviewDetail / edit / softDelete / approve / reject 传 {type:'attendance_sheet', id}
  //     (点动作)
  //   - listAllSheetsForAdmin(扁平跨轴)/ listRecordsForMemberAdmin / getMemberContributionSummary
  //     (队员轴跨活动)无 ref(no-ref = GLOBAL-only,行为锁天然成立)
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
    if (ref && decision.reason === 'resource_not_found' && (await this.rbac.can(user, action))) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  // 终态 scoped-authz PR9(2026-07-02;冻结稿 §5.2/§5.3 + BD-2):终审两方法判权切 AuthzService,
  // 本仓**首个 authz 消费者**。带 ref 判权 = GLOBAL 绑定(biz-admin 终审两码保留,B 方案,ADMIN
  // 全局终审契约照旧)∪ scoped 三源(如 POSITION_ASSIGNMENT 主体 RoleBinding —— 终审中枢经
  // role-bindings 配置行决定,绝不 hardcode 部门)+ ActionConstraint 否决(自审禁止,SUPER_ADMIN
  // 亦拒;同人默认禁止,env ATTENDANCE_ALLOW_SAME_REVIEWER 可放开)。
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

  // ============ helpers:序列化 ============
  // 已抽至 `attendance-presenter.ts` 的 `AttendancePresenter`(P1-4 第一刀,2026-06-10
  // 方案 A 拍板;仅"搬家",字段映射 / Decimal 序列化语义零变化)。
  // 各路径通过 `this.attendancePresenter.toSheetResponseDto(...)` /
  // `.toSheetListItemDto(...)` / `.toRecordResponseDto(...)` / `.decimalToString(...)` 委托;
  // 事务边界与查询 select 策略不随迁,仍由本 service 持有。

  // ============ helpers:字典校验 ============

  private async assertDictItemValid(
    typeCode: string,
    code: string,
    biz: BizCodeEntry,
    tx: PrismaTx,
  ): Promise<void> {
    const item = await tx.dictItem.findFirst({
      where: {
        code,
        status: DictItemStatus.ACTIVE,
        deletedAt: null,
        type: {
          code: typeCode,
          status: DictTypeStatus.ACTIVE,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!item) throw new BizException(biz);
  }

  // ============ helpers:Activity / Sheet / Member 查找 ============

  // 批次 4-B 重构:findActivityForSubmission 旧版返回 {id, statusCode} 已被 findActivityForSubmissionFull
  // (返回 {id, statusCode, activityTypeCode})替代,用于 D14 预填 + D11 推动;旧函数删除。

  private async assertActivityExists(activityId: string, tx: PrismaTx): Promise<void> {
    const act = await tx.activity.findFirst({
      where: notDeletedWhere({ id: activityId }),
      select: { id: true },
    });
    if (!act) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }

  private async assertMemberExists(memberId: string, tx: PrismaTx): Promise<void> {
    const m = await tx.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!m) throw new BizException(BizCode.MEMBER_NOT_FOUND);
  }

  // R23 跨表校验:registrationId 非空时 registration.activityId === sheet.activityId。
  // 找不到 registration → MISMATCH(沿 §1.7 风格,USER 越权一律 mismatch / 404)。
  private async assertRegistrationMatchesActivity(
    registrationId: string,
    activityId: string,
    tx: PrismaTx,
  ): Promise<void> {
    const reg = await tx.activityRegistration.findFirst({
      where: notDeletedWhere({ id: registrationId }),
      select: { activityId: true },
    });
    if (!reg || reg.activityId !== activityId) {
      throw new BizException(BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH);
    }
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
  // contributionPoints 入参三态(沿 D-A8 / D14 5.B):
  //   omit / undefined → normalized 为 undefined → 走 ContributionRule 系统预填
  //   显式 null        → normalized 为 null      → 跳过预填,落库为 null,APD 在 approve 前现场填入
  //   number           → normalized 为 number    → 调用方已传值,不预填,不覆盖
  private normalizeRecord(input: AttendanceRecordInputDto): {
    memberId: string;
    roleCode: string;
    checkInAt: Date;
    checkOutAt: Date;
    serviceHours: number;
    attendanceStatusCode: string;
    note: string | null;
    registrationId: string | null;
    contributionPoints: number | null | undefined;
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
      // 保留三态:undefined / null / number;由 applyContributionRulePrefill 区分处理。
      contributionPoints: input.contributionPoints,
    };
  }

  // 时间不重叠校验(R16 / Q-S15)已抽至 `time-overlap-policy.ts` 的 `TimeOverlapPolicy`
  // (refactor PR;沿 PR #179 9 个 characterization case 锁定的现状行为零变化)。
  // submit(...) / edit(...) 内通过 `this.timeOverlapPolicy.assertNoInternalOverlap(...)` +
  // `this.timeOverlapPolicy.assertNoTimeOverlap(...)` 委托,事务边界保持在
  // `this.prisma.$transaction(...)` 内(tx 透传;excludeSheetId 语义不变)。

  // ============ submit(POST 提交 Sheet)============

  // 批次 4-B 升级:
  // - D14 5.B 系统预填 contributionPoints(若 record 未传值;沿 D-A8)
  //   规则匹配维度:activityType × attendanceRole × durationThreshold;
  //   NULL durationThreshold 多条规则按 createdAt ASC LIMIT 1(明确选取策略,沿 §3.1 复核报告);
  //   无匹配规则 → service 兜底 null,不抛错(沿 D-S11 22048 不开)。
  // - D11 推动:Activity.statusCode = 'published' → 'completed'(沿 D-S10);
  //   多 Sheet 场景下,后续 Sheet 创建时已是 completed,update 不再生效(幂等)。
  async submit(
    activityId: string,
    dto: CreateAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    await this.assertCanOrThrow(currentUser, 'attendance.create.sheet', {
      type: 'activity',
      id: activityId,
    });
    return this.prisma.$transaction(async (tx) => {
      // 1. activity 存在 + 非 cancelled;同时取 activityTypeCode + statusCode 用于 D14 预填 + D11 推动
      const activity = await this.findActivityForSubmissionFull(activityId, tx);

      // 2. 逐条 record 字典校验 + 时间规范化 + serviceHours 校验
      const normalized: ReturnType<AttendancesService['normalizeRecord']>[] = [];
      for (const input of dto.records) {
        await this.assertDictItemValid(
          DICT_TYPE_ATTENDANCE_ROLE,
          input.roleCode,
          BizCode.ATTENDANCE_ROLE_CODE_INVALID,
          tx,
        );
        await this.assertDictItemValid(
          DICT_TYPE_ATTENDANCE_STATUS,
          input.attendanceStatusCode,
          BizCode.ATTENDANCE_STATUS_CODE_INVALID,
          tx,
        );
        await this.assertMemberExists(input.memberId, tx);
        if (input.registrationId !== undefined) {
          await this.assertRegistrationMatchesActivity(input.registrationId, activityId, tx);
        }
        normalized.push(this.normalizeRecord(input));
      }

      // 3. 数组内部时间不重叠 + 与已有跨 Sheet 全局不重叠
      // 抽出至 TimeOverlapPolicy(refactor PR;算法 / 边界 / excludeSheetId 语义零变化)。
      this.timeOverlapPolicy.assertNoInternalOverlap(normalized);
      await this.timeOverlapPolicy.lockMembersForOverlapCheck(
        normalized.map((record) => record.memberId),
        tx,
      );
      for (const r of normalized) {
        await this.timeOverlapPolicy.assertNoTimeOverlap(
          r.memberId,
          r.checkInAt,
          r.checkOutAt,
          undefined,
          tx,
        );
      }

      // 4. D14 5.B 预填:仅当 record.contributionPoints === null 时按规则查表预填;
      //    传值不覆盖(沿 D-A8);无匹配规则保持 null。
      // 抽出至 ContributionCalculator(refactor PR;算法 / 三态 / cap / 排序均零行为变化)。
      const prefilled = await this.contributionCalculator.applyContributionRulePrefill(
        normalized,
        activity.activityTypeCode,
        tx,
      );

      // 5. 事务内一次性 create Sheet + N records
      const created = await tx.attendanceSheet.create({
        data: {
          activityId,
          submitterUserId: currentUser.id,
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

      // 6. D11 推动:首张 Sheet 创建 → Activity.completed(沿 D-S10);
      //    幂等:若已是 completed,update 不会改 statusCode(但走一次写减少负担,故先判定 published 才动)。
      //    cancelled 在 step 1 已拒绝;publish 状态机 draft → published → completed 单向。
      const activityPushedToCompleted = activity.statusCode === ACTIVITY_STATUS_PUBLISHED;
      if (activityPushedToCompleted) {
        await tx.activity.update({
          where: { id: activityId },
          data: { statusCode: ACTIVITY_STATUS_COMPLETED },
        });
      }

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

  // 批次 4-B 新增:findActivityForSubmissionFull,返回 activityTypeCode + statusCode(用于 D14 + D11)。
  // 与 findActivityForSubmission 复用 22001 / 20122 校验路径,只是 select 字段更多。
  private async findActivityForSubmissionFull(
    activityId: string,
    tx: PrismaTx,
  ): Promise<{ id: string; statusCode: string; activityTypeCode: string }> {
    const act = await tx.activity.findFirst({
      where: notDeletedWhere({ id: activityId }),
      select: { id: true, statusCode: true, activityTypeCode: true },
    });
    if (!act) {
      throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    }
    if (act.statusCode === ACTIVITY_STATUS_CANCELLED) {
      throw new BizException(BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN);
    }
    return act;
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
  ): Promise<PageResultDto<AttendanceSheetListItemDto>> {
    await this.assertCanOrThrow(currentUser, 'attendance.read.sheet', {
      type: 'activity',
      id: activityId,
    });
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

    auditPlaceholder('attendance-sheet.read.other', {
      operatorUserId: currentUser.id,
      activityId,
      operation: 'list',
      rowsCount: rows.length,
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
    await this.assertCanOrThrow(currentUser, 'attendance.read.sheet');

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
    if (organizationId !== undefined) {
      activityWhere.organizationId = includeDescendants
        ? { in: await this.organizations.queryDescendantOrgIds(organizationId) }
        : organizationId;
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
    await this.assertCanOrThrow(currentUser, 'attendance.read.sheet');
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
  // computeCappedContribution(approved sheet + 全局每日封顶 1.5,生涯无 cutoff);**禁裸 SUM**
  // ——绕过封顶会算多。MEMBER_NOT_FOUND 守卫;判权复用 attendance.read.sheet。
  async getMemberContributionSummary(
    memberId: string,
    currentUser: CurrentUserPayload,
  ): Promise<MemberContributionSummaryDto> {
    await this.assertCanOrThrow(currentUser, 'attendance.read.sheet');
    const member = await this.prisma.member.findFirst({
      where: notDeletedWhere({ id: memberId }),
      select: { id: true },
    });
    if (!member) throw new BizException(BizCode.MEMBER_NOT_FOUND);

    const points = await computeCappedContribution(this.prisma, memberId, null);
    return { memberId, contributionPoints: points.toString() };
  }

  // ============ findOne(GET Sheet 简化详情)============

  async findOne(id: string, currentUser: CurrentUserPayload): Promise<AttendanceSheetResponseDto> {
    await this.assertCanOrThrow(currentUser, 'attendance.read.sheet', {
      type: 'attendance_sheet',
      id,
    });
    const sheet = await this.prisma.$transaction(async (tx) => this.findSheetOrThrow(id, tx));

    auditPlaceholder('attendance-sheet.read.other', {
      operatorUserId: currentUser.id,
      sheetId: id,
      operation: 'detail',
    });

    return this.attendancePresenter.toSheetResponseDto(sheet);
  }

  // ============ reviewDetail(GET 完整审核视图;R25)============

  async reviewDetail(
    id: string,
    currentUser: CurrentUserPayload,
  ): Promise<AttendanceSheetReviewDetailDto> {
    await this.assertCanOrThrow(currentUser, 'attendance.read.sheet', {
      type: 'attendance_sheet',
      id,
    });
    const result = await this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

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

    auditPlaceholder('attendance-sheet.read.other', {
      operatorUserId: currentUser.id,
      sheetId: id,
      operation: 'review-detail',
    });

    return {
      activity: result.activity satisfies AttendanceSheetActivitySummaryDto,
      sheet: this.attendancePresenter.toSheetResponseDto(result.sheet),
      records: result.records.map((r) => this.attendancePresenter.toRecordResponseDto(r)),
    };
  }

  // ============ edit(PATCH 编辑 pending Sheet)============

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
  ): Promise<AttendanceSheetResponseDto> {
    await this.assertCanOrThrow(currentUser, 'attendance.update.sheet', {
      type: 'attendance_sheet',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

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
      // 没有 records 字段 → 等同于 no-op(不动 records,仍生成 snapshot + version+1)
      if (dto.records === undefined) {
        // 仅 version+1 + snapshot 保存当前状态
        const currentRecords = await tx.attendanceRecord.findMany({
          where: notDeletedWhere({ sheetId: id }),
          select: recordWithMemberSelect,
        });
        const snapshot = this.attendanceAuditRecorder.buildPreviousSnapshot(sheet, currentRecords);
        const updated = await tx.attendanceSheet.update({
          where: { id: sheet.id },
          data: {
            version: sheet.version + 1,
            previousSnapshot: snapshot as Prisma.InputJsonValue,
          },
          select: sheetSafeSelect,
        });
        await this.attendanceAuditRecorder.logEditNoRecords({
          sheetId: id,
          beforeSheet: sheet,
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

      // 1. 校验新 records
      const normalized: ReturnType<AttendancesService['normalizeRecord']>[] = [];
      for (const input of dto.records) {
        await this.assertDictItemValid(
          DICT_TYPE_ATTENDANCE_ROLE,
          input.roleCode,
          BizCode.ATTENDANCE_ROLE_CODE_INVALID,
          tx,
        );
        await this.assertDictItemValid(
          DICT_TYPE_ATTENDANCE_STATUS,
          input.attendanceStatusCode,
          BizCode.ATTENDANCE_STATUS_CODE_INVALID,
          tx,
        );
        await this.assertMemberExists(input.memberId, tx);
        if (input.registrationId !== undefined) {
          await this.assertRegistrationMatchesActivity(input.registrationId, sheet.activityId, tx);
        }
        normalized.push(this.normalizeRecord(input));
      }

      // 抽出至 TimeOverlapPolicy(refactor PR;edit 路径透传 excludeSheetId=id 语义不变)。
      this.timeOverlapPolicy.assertNoInternalOverlap(normalized);
      await this.timeOverlapPolicy.lockMembersForOverlapCheck(
        normalized.map((record) => record.memberId),
        tx,
      );
      for (const r of normalized) {
        // edit 路径:排除本 Sheet 旧 records(它们将被软删)
        await this.timeOverlapPolicy.assertNoTimeOverlap(
          r.memberId,
          r.checkInAt,
          r.checkOutAt,
          id,
          tx,
        );
      }

      // 2. 生成 previousSnapshot(在旧 records 软删之前抓取)
      const currentRecords = await tx.attendanceRecord.findMany({
        where: notDeletedWhere({ sheetId: id }),
        select: recordWithMemberSelect,
      });
      const snapshot = this.attendanceAuditRecorder.buildPreviousSnapshot(sheet, currentRecords);

      // 3. 软删旧 records + 创建新 records(D38)
      const now = new Date();
      await tx.attendanceRecord.updateMany({
        where: { sheetId: id, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.attendanceRecord.createMany({
        data: normalized.map((r) => ({
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
        where: { id: sheet.id },
        data: {
          version: sheet.version + 1,
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
        beforeSheet: sheet,
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
  ): Promise<AttendanceSheetResponseDto> {
    await this.assertCanOrThrow(currentUser, 'attendance.delete.sheet', {
      type: 'attendance_sheet',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

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
        where: { id: sheet.id },
        data: { deletedAt: now },
        select: sheetSafeSelect,
      });

      await this.attendanceAuditRecorder.logDelete({
        sheetId: id,
        beforeSheet: sheet,
        beforeRecords: currentRecords,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        priorStatusCode: sheet.statusCode,
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

      // R31:所有 records contributionPoints 必填(沿 D-S8;APD 一级 approve 时校验)
      const recordsForCheck = await tx.attendanceRecord.findMany({
        where: notDeletedWhere({ sheetId: id }),
        select: { id: true, contributionPoints: true },
      });
      if (recordsForCheck.some((r) => r.contributionPoints === null)) {
        throw new BizException(BizCode.ATTENDANCE_RECORD_CONTRIBUTION_POINTS_REQUIRED);
      }

      const reviewedAt = new Date();
      const claimed = await tx.attendanceSheet.updateMany({
        where: { id: sheet.id, statusCode: sheet.statusCode, deletedAt: null },
        data: { statusCode: sheet.statusCode },
      });
      if (claimed.count === 0) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
      }
      const updated = await tx.attendanceSheet.update({
        where: { id: sheet.id },
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
        beforeSheet: sheet,
        afterSheet: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'approve',
        priorStatusCode: sheet.statusCode,
        nextStatusCode: approveTransition.nextStatusCode,
        recordsCount: recordsForCheck.length,
        auditMeta,
        tx,
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

      const reviewedAt = new Date();

      // F4(#399):一级 reject 的 records **跟随软删**(对称 final_rejected;沿 softDelete / finalReject
      // 范式)。原先 rejected 的 records 仍 deletedAt IS NULL → 永久占用 time-overlap 窗口
      // (overlap 只过 deletedAt),致该队员同窗无法重交(死锁)。软删后窗口释放,可重新提交。
      // 软删前抓 records 全字段快照入 audit(对称 finalReject;沿 §audit records 必含组)。
      const currentRecords = await tx.attendanceRecord.findMany({
        where: { sheetId: id, deletedAt: null },
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });

      // Findings #4/#6:先用期望状态原子占有 Sheet；并发败者在任何明细软删前 abort。
      const claimed = await tx.attendanceSheet.updateMany({
        where: { id: sheet.id, statusCode: sheet.statusCode, deletedAt: null },
        data: { statusCode: sheet.statusCode },
      });
      if (claimed.count === 0) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_STATUS_INVALID);
      }
      await tx.attendanceRecord.updateMany({
        where: { sheetId: id, deletedAt: null },
        data: { deletedAt: reviewedAt },
      });

      const updated = await tx.attendanceSheet.update({
        where: { id: sheet.id },
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
        beforeSheet: sheet,
        beforeRecords: currentRecords,
        afterSheet: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'reject',
        priorStatusCode: sheet.statusCode,
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
    const result = await this.prisma.$transaction(async (tx) => {
      const sheet = await this.findSheetOrThrow(id, tx);

      const finalApproveTransition = this.sheetStateMachine.decide(
        'finalApprove',
        sheet.statusCode,
      );
      if (!finalApproveTransition.allowed) {
        throw new BizException(finalApproveTransition.biz);
      }

      const finalReviewedAt = new Date();
      const claimed = await tx.attendanceSheet.updateMany({
        where: { id: sheet.id, statusCode: sheet.statusCode, deletedAt: null },
        data: { statusCode: sheet.statusCode },
      });
      if (claimed.count === 0) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID);
      }
      const updated = await tx.attendanceSheet.update({
        where: { id: sheet.id },
        data: {
          statusCode: finalApproveTransition.nextStatusCode,
          finalReviewerUserId: currentUser.id,
          finalReviewedAt,
          finalReviewNote: dto.finalReviewNote ?? null,
        },
        select: sheetSafeSelect,
      });

      // 触发 attendance.recorded(批次 4-B 移到终审通过时;沿 D-S7;Q-S13 context schema 沿用)
      const recordsForEvent = await tx.attendanceRecord.findMany({
        where: notDeletedWhere({ sheetId: id }),
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });
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
        beforeSheet: sheet,
        afterSheet: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'final-approve',
        priorStatusCode: sheet.statusCode,
        nextStatusCode: finalApproveTransition.nextStatusCode,
        recordsCount: recordsForEvent.length,
        eventTriggered: true,
        auditMeta,
        tx,
      });

      // 携带通知收件人(逐 record 本人 memberId + 本次贡献值)出事务;dto 仍为对外返回体。
      return {
        dto: this.attendancePresenter.toSheetResponseDto(updated),
        activityId: updated.activityId,
        recipients: recordsForEvent.map((r) => ({
          memberId: r.memberId,
          contributionPoints: this.attendancePresenter.decimalToString(r.contributionPoints),
        })),
      };
    });

    // 考勤结果/贡献值定向通知(统一通知 S4;评审稿 §6.4 / §6.2):**事务 commit 之后、事务外**逐 record 派给本人。
    // **绝不破坏 finalApprove + 贡献值生效行为锁**(pending_final_review → approved + attendance.recorded 已在事务内
    // commit);派发失败只记日志,不阻断、不回滚。
    await this.dispatchAttendanceNotifications(result.activityId, result.recipients);

    // 十项收口刀F(#8 拍板「只发达标提醒,不动状态机」):本次终审使入队贡献值跨过阈值者,追发一条
    // 「贡献值已达标」站内提醒(同为 commit 后事务外 additive Effect,失败只记日志)。
    await this.dispatchTeamJoinContributionMetNotifications(result.recipients);

    return result.dto;
  }

  // 派发「考勤结果/贡献值」定向通知(仅站内,goal:S4 站内为主、微信 opt-in 延后)。收件人 = 该 sheet 终审通过的
  // 逐条 record 本人(record→member;payload 含活动名 + 本次贡献值)。一人多 record(多时段)→ 多条,各自独立
  // (每条 = 一次考勤结果)。**整体 try-catch + 单条各自吞**:任一失败只记日志,不阻断其余、不破坏已 commit 的终审。
  private async dispatchAttendanceNotifications(
    activityId: string,
    recipients: Array<{ memberId: string; contributionPoints: string | null }>,
  ): Promise<void> {
    if (recipients.length === 0) return;
    try {
      const activity = await this.prisma.activity.findUnique({
        where: { id: activityId },
        select: { title: true },
      });
      const activityTitle = activity?.title ?? '活动';
      for (const r of recipients) {
        try {
          await this.notificationDispatcher.dispatchTargeted({
            recipientMemberId: r.memberId,
            notificationTypeCode: NOTIFICATION_TYPE_ACTIVITY_REMINDER,
            title: '考勤结果已确认',
            body: `您在「${activityTitle}」的考勤已终审通过,本次贡献值 ${r.contributionPoints ?? '0'}。`,
            channels: [NOTIFICATION_CHANNEL_IN_APP],
          });
        } catch (err) {
          this.logger.error(
            `attendance result notification dispatch failed (activity=${activityId}, member=${r.memberId}): ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `attendance result notification fan-out failed (activity=${activityId}): ${(err as Error).message}`,
      );
    }
  }

  // 十项收口刀F(#8;拍板「只发达标提醒,不动状态机」):考勤终审 commit 后,对持 joining 态入队
  // 申请、且本次终审使贡献值跨过阈值(before<5≤after)的队员,发「入队贡献值已达标」站内定向通知。
  // **纯 additive Effect**:整体+单条 try-catch 永不抛,不改任何状态(推进仍走 admin 重标 gate 的
  // 既有自愈通道);复用 team-join 纯函数直连 prisma(本模块既有先例),不引 service 防环。
  // 跨阈判定:before 下界 = after − 本 sheet 未封顶增量(封顶/超 cutoff 记录可致少数重复提醒,
  // 可接受——已推进者不再命中 joining,天然收敛)。
  private async dispatchTeamJoinContributionMetNotifications(
    recipients: Array<{ memberId: string; contributionPoints: string | null }>,
  ): Promise<void> {
    if (recipients.length === 0) return;
    try {
      // 按 member 聚合本 sheet 增量(一人多时段多 record)
      const deltas = new Map<string, Prisma.Decimal>();
      for (const r of recipients) {
        const prev = deltas.get(r.memberId) ?? new Prisma.Decimal(0);
        deltas.set(r.memberId, prev.add(r.contributionPoints ?? 0));
      }
      for (const [memberId, delta] of deltas) {
        try {
          const app = await this.prisma.teamJoinApplication.findFirst({
            where: { memberId, statusCode: TEAM_JOIN_APP_STATUS_JOINING, deletedAt: null },
            orderBy: { createdAt: 'desc' },
            select: { cycle: { select: { year: true } } },
          });
          if (!app) continue;
          const after = await computeContribution(this.prisma, memberId, app.cycle.year);
          // 未达标,或扣除本次增量后本就达标(存量已达标者)→ 不提醒
          if (!after.satisfied || after.points.minus(delta).gte(CONTRIBUTION_THRESHOLD)) {
            continue;
          }
          await this.notificationDispatcher.dispatchTargeted({
            recipientMemberId: memberId,
            notificationTypeCode: NOTIFICATION_TYPE_RECRUITMENT,
            title: '入队贡献值已达标',
            body: `您的贡献值已达到入队要求(当前 ${after.points.toString()} 分)。管理员核对门槛后将安排综合评估,请留意后续通知。`,
            channels: [NOTIFICATION_CHANNEL_IN_APP],
          });
        } catch (err) {
          this.logger.error(
            `team-join contribution-met notification failed (member=${memberId}): ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`team-join contribution-met fan-out failed: ${(err as Error).message}`);
    }
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
  // - 权限同 finalApprove(PR9 起走 authz;B 方案 biz-admin 保留 + scoped 通路);注意
  //   ActionConstraint 注册表(PR8 冻结)只咬合 final-approve —— final-reject 无自审/同人约束。
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

      // PR #6 audit:before 需要 records 完整快照(records 跟随软删之前抓取)
      const currentRecords = await tx.attendanceRecord.findMany({
        where: { sheetId: id, deletedAt: null },
        select: recordWithMemberSelect,
        orderBy: { checkInAt: 'asc' },
      });

      const finalReviewedAt = new Date();
      // Findings #5/#6:终审状态守卫先于明细软删；并发败者不再破坏 winner 的 records。
      const claimed = await tx.attendanceSheet.updateMany({
        where: { id: sheet.id, statusCode: sheet.statusCode, deletedAt: null },
        data: { statusCode: sheet.statusCode },
      });
      if (claimed.count === 0) {
        throw new BizException(BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID);
      }
      // records 跟随软删(沿 D8 主路径)
      await tx.attendanceRecord.updateMany({
        where: { sheetId: id, deletedAt: null },
        data: { deletedAt: finalReviewedAt },
      });

      const updated = await tx.attendanceSheet.update({
        where: { id: sheet.id },
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
        beforeSheet: sheet,
        beforeRecords: currentRecords,
        afterSheet: updated,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        action: 'final-reject',
        priorStatusCode: sheet.statusCode,
        nextStatusCode: finalRejectTransition.nextStatusCode,
        recordsCount: currentRecords.length,
        finalReviewNote: dto.finalReviewNote,
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
