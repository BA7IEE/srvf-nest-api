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
import {
  AttendanceAccessService,
  sheetFullSelect,
  sheetSafeSelect,
} from './attendance-access.service';
import { AttendanceAuditRecorder } from './attendance-audit-recorder';
import { AttendanceNotificationProducer } from './attendance-notification-producer';
import {
  assertRecordAgainstLockedRegistration,
  canonicalizeRecordInputs,
  DICT_TYPE_ATTENDANCE_ROLE,
  DICT_TYPE_ATTENDANCE_STATUS,
  type NormalizedAttendanceRecord,
  validateAndNormalizeRecord,
} from './attendance-record.policy';
import { AttendancePresenter } from './attendance-presenter';
import { AttendanceReviewService } from './attendance-review.service';
import {
  AttendanceSheetQueryService,
  recordWithMemberSelect,
} from './attendance-sheet-query.service';
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

// **写侧** `sheetSafeSelect` / `sheetFullSelect` 刻意留在本文件:它们服务写路径回读与
// §4「loading the aggregate root」,不是读侧查询构造。
type PrismaTx = Prisma.TransactionClient;
export type AttendanceAuthorization = 'authz' | 'managed';

@Injectable()
export class AttendancesService {
  constructor(
    private readonly prisma: PrismaService,
    // Phase 6-B 第三域第一刀:submit / edit / softDelete / 审批八式 / 读侧**三段共用**的前置
    // (判权、managed 校验、Activity 聚合根锁、Sheet 回读)。判权调用仍在各自方法体内 ——
    // 不把判权**结果**当跨类入参传,那会开出「漏传即漏判权」的新失败面。
    private readonly access: AttendanceAccessService,
    // stage2:审批八式的实现持有者;本 service 仅保留同名薄委托作为唯一对外入口。
    private readonly review: AttendanceReviewService,
    private readonly attendanceAuditRecorder: AttendanceAuditRecorder,
    private readonly contributionCalculator: ContributionCalculator,
    private readonly timeOverlapPolicy: TimeOverlapPolicy,
    private readonly sheetStateMachine: AttendanceSheetStateMachine,
    private readonly attendancePresenter: AttendancePresenter,
    // Phase 6-B 第二域第一刀(§3.2):四条列表 surface 的读侧查询构造。**不下放判权腿** ——
    // 组织可见范围仍由本 service 的 resolveVisibleOrganizationIds() 算好后作为入参传入。
    private readonly attendanceSheetQuery: AttendanceSheetQueryService,
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

  // ============ helpers:Record 字段计算 / 校验 ============
  //
  // 域校验与 normalize 已抽至 `attendance-record.policy.ts`(Phase 6-B 第二域第二刀,§3.3):
  // `normalizeRecord` / `spanHours` / `assertRecordWithinActivityWindow` / `resolveScheduleWindow` /
  // `assertRegistrationConsistent` / `validateAndNormalizeRecord` / `assertRecordAgainstLockedRegistration`。
  // **3 次 IN 预取与锁后复读留在本 service**(它们是查询,不是判定),查询**结果**当入参传进去 ——
  // policy 用点号命名,命中 eslint 规则 (j),结构上不可能 import prisma。

  // F1/F3/F4:一个 records 请求固定用 3 次 IN 预取字典项、队员与报名行；随后按原输入顺序
  // 复现错误优先级并完成 normalize。查询次数不随 records 数增长，且 registrationId 同时校验
  // activityId、memberId 与 pass 状态。
  private async validateAndNormalizeRecordsBatch(
    inputs: AttendanceRecordInputDto[],
    activity: { id: string; startAt: Date; endAt: Date; requiresInsurance: boolean },
    now: Date,
    tx: PrismaTx,
  ): Promise<NormalizedAttendanceRecord[]> {
    const canonicalInputs = canonicalizeRecordInputs(inputs);
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

    return canonicalInputs.map((input) =>
      validateAndNormalizeRecord(input, {
        activity,
        dictKeys,
        existingMemberIds,
        registrationById,
        now,
        windowToleranceHours: this.config.attendance.windowToleranceHours,
      }),
    );
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
    normalized: ReadonlyArray<NormalizedAttendanceRecord>,
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
      assertRecordAgainstLockedRegistration(
        record,
        lockedById.get(record.registrationId),
        activity,
        this.config.attendance.windowToleranceHours,
      );
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
    await this.access.assertCanOrThrow(currentUser, 'attendance.create.sheet', {
      type: 'activity',
      id: activityId,
    });
    // M3:本事务内会取队员线性化键 ⇒ 必须显式 ReadCommitted + 有界锁等待(见 util 注释)。
    return runMemberLinearizedTransaction(this.prisma, async (tx) => {
      // 1. 与 pass cancel / GPS check-in 统一 Activity → Registration 锁序。
      // managed 以 FOR UPDATE 与责任撤销/移交串行并锁后重读 capability；Admin 默认仍用 FOR SHARE。
      if (authorization === 'managed') {
        await this.access.lockActivityForAttendanceWrite(activityId, tx);
        await this.access.assertManagedAttendanceAccess(activityId, currentUser, tx);
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
    const sheet = await this.prisma.$transaction(async (tx) => this.access.findSheetOrThrow(id, tx));
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
    await this.access.assertCanOrThrow(currentUser, 'attendance.update.sheet', {
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
        await this.access.lockActivityForAttendanceWrite(managedActivityId, tx);
        await this.access.assertManagedAttendanceAccess(managedActivityId, currentUser, tx);
      }
      const sheet = await this.access.findSheetOrThrow(id, tx);
      this.access.assertManagedSheetActivity(sheet.activityId, managedActivityId);
      if (!lockedByManagedBranch) {
        await this.access.lockActivityForAttendanceWrite(sheet.activityId, tx);
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
      const lockedSheet = await this.access.findSheetOrThrow(id, tx);
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
    await this.access.assertCanOrThrow(currentUser, 'attendance.delete.sheet', {
      type: 'attendance_sheet',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      // K1 / A-Y1:与 edit 同一形状 —— 两条 surface 都取 Activity 聚合锁。
      // softDelete 的方向是移除考勤证据,最坏后果止于并发取消误报 21033;但让
      // edit / softDelete / resubmit 收敛成同一种写法,比记住"这条为什么可以不锁"更省。
      const lockedByManagedBranch = managedActivityId !== undefined;
      if (managedActivityId !== undefined) {
        await this.access.lockActivityForAttendanceWrite(managedActivityId, tx);
        await this.access.assertManagedAttendanceAccess(managedActivityId, currentUser, tx);
      }
      const sheet = await this.access.findSheetOrThrow(id, tx);
      this.access.assertManagedSheetActivity(sheet.activityId, managedActivityId);
      if (!lockedByManagedBranch) {
        await this.access.lockActivityForAttendanceWrite(sheet.activityId, tx);
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
      const lockedSheet = await this.access.findSheetOrThrow(id, tx);
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

  // ============ 审批流转:八式薄委托(Phase 6-B 第三域第一刀 stage2)============
  //
  // 实现已迁至 `attendance-review.service.ts` 的 `AttendanceReviewService`(仅"搬家",
  // 判权 / 锁序 / 状态机裁决 / 审计 / 通知 intent 逐字不变)。本 service 仍是本模块**唯一**
  // 对外入口 —— 三个 controller 与薄壳 service 的调用面因此逐字不变。
  // ⚠️ 委托必须原样透传全部实参:少传一个 currentUser / auditMeta 就是少一条判权或少一条审计,
  // 而那种缺失在类型上可能仍然合法(可选参数)。

  async approve(...args: Parameters<AttendanceReviewService['approve']>) {
    return this.review.approve(...args);
  }

  async firstReturn(...args: Parameters<AttendanceReviewService['firstReturn']>) {
    return this.review.firstReturn(...args);
  }

  async reject(...args: Parameters<AttendanceReviewService['reject']>) {
    return this.review.reject(...args);
  }

  async finalApprove(...args: Parameters<AttendanceReviewService['finalApprove']>) {
    return this.review.finalApprove(...args);
  }

  async finalReturn(...args: Parameters<AttendanceReviewService['finalReturn']>) {
    return this.review.finalReturn(...args);
  }

  async finalReject(...args: Parameters<AttendanceReviewService['finalReject']>) {
    return this.review.finalReject(...args);
  }

  async resubmit(...args: Parameters<AttendanceReviewService['resubmit']>) {
    return this.review.resubmit(...args);
  }

  async reopen(...args: Parameters<AttendanceReviewService['reopen']>) {
    return this.review.reopen(...args);
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
