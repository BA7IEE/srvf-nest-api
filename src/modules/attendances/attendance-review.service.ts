import { Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { eventPlaceholder } from '../../common/event/event-placeholder';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { claimAtStatus } from '../../common/prisma/claim-at-status.util';
import {
  lockMembersForWrite,
  runMemberLinearizedTransaction,
} from '../../common/prisma/member-advisory-lock.util';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { AttendanceAccessService, sheetSafeSelect } from './attendance-access.service';
import { AttendanceAuditRecorder } from './attendance-audit-recorder';
import { AttendanceNotificationProducer } from './attendance-notification-producer';
import { AttendancePresenter } from './attendance-presenter';
import { recordWithMemberSelect } from './attendance-sheet-query.service';
import { AttendanceSheetStateMachine } from './attendance-sheet-state-machine';
import type {
  ApproveAttendanceSheetDto,
  AttendanceSheetResponseDto,
  FinalApproveAttendanceSheetDto,
  FinalRejectAttendanceSheetDto,
  RejectAttendanceSheetDto,
  ReopenAttendanceSheetDto,
  ResubmitAttendanceSheetDto,
  ReturnAttendanceSheetDto,
} from './attendances.dto';

/*
 * 考勤单据的**审批流转族**(Phase 6-B 第三域第一刀 stage2,§3.2)。
 *
 * 八式同构:approve / firstReturn / reject(初审三式)· finalApprove / finalReturn / finalReject
 * (终审三式)· resubmit / reopen(回流两式)。每一式的骨架都是
 *   判权 → 取 Activity 聚合根锁 → 锁内回读 Sheet → 复核分离 → 状态机裁决 → 落库 → 审计 → 通知 intent
 * 抽出来的理由不是"它们长得像",而是它们**共享同一组不变量**:
 * 初审/终审的自审与同人限制、`claimAtStatus` 的乐观并发、以及审计与通知必须与业务写同事务。
 *
 * ⚠️ 两个 review-only 的判定随族迁来,**没有下放到 AttendanceAccessService**:
 * `assertFinalReviewAuthzOrThrow` 与 `assertLockedReviewSeparation` 只被本族调用,
 * 放进共享层会让它们看起来像"三段都该过的前置",而它们不是 —— 共享层只装真正三段共用的东西。
 *
 * ⚠️ 判权仍在**各自方法体内**调用(this.access.* / 本类的两个 assert),不接受任何
 * 「上游已判过」的入参。把判权结果当跨类入参传,漏传一个 = 一条判权凭空消失,
 * 而全仓单测可以零红(6-B 第三域实测踩过)。这条约束是本次拆分形态的决定性理由。
 *
 * ⚠️ 锁序:本族是**被调用方**,`AttendancesService` 的薄委托是唯一入口。
 * Activity 聚合根锁必须在读 Sheet 之前取 —— 顺序即锁序,挪动调用位置会静默破坏它
 * 且不会有任何编译错或单测失败。全局次序见 AttendancesService 的锁序说明。
 */
@Injectable()
export class AttendanceReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AttendanceAccessService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly sheetStateMachine: AttendanceSheetStateMachine,
    private readonly attendancePresenter: AttendancePresenter,
    private readonly attendanceAuditRecorder: AttendanceAuditRecorder,
    private readonly attendanceNotificationProducer: AttendanceNotificationProducer,
    // 活动 v1.1 cutover gate —— 旧写路径的判闸依据(合同 §16.2 单轨)。
    private readonly activityWorkflowGate: ActivityWorkflowGate,
  ) {}

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

  // - audit:沿 attendance-sheet.review,action='approve';nextStatusCode 升级为 pending_final_review
  async approve(
    id: string,
    dto: ApproveAttendanceSheetDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AttendanceSheetResponseDto> {
    // 活动 v1.1 单一 cutover gate(合同 §16.2):闸**开**后本实例已切到 v1.1,
    // 旧考勤写入口永久关闭 —— 拒绝在此判,避免与新链并写形成合同禁止的混合态。
    this.activityWorkflowGate.assertLegacyWriteAllowed();
    await this.access.assertCanOrThrow(currentUser, 'attendance.approve.sheet', {
      type: 'attendance_sheet',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.access.findSheetOrThrow(id, tx);

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
      const lockedSheet = await this.access.findSheetOrThrow(id, tx);
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
    // 活动 v1.1 单一 cutover gate(合同 §16.2):闸**开**后本实例已切到 v1.1,
    // 旧考勤写入口永久关闭 —— 拒绝在此判,避免与新链并写形成合同禁止的混合态。
    this.activityWorkflowGate.assertLegacyWriteAllowed();
    const returnNote = dto.returnNote.trim();
    if (!returnNote) throw new BizException(BizCode.ATTENDANCE_RETURN_NOTE_REQUIRED);
    await this.access.assertCanOrThrow(currentUser, 'attendance.return.sheet', {
      type: 'attendance_sheet',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.access.findSheetOrThrow(id, tx);
      const transition = this.sheetStateMachine.decide('firstReturn', sheet.statusCode);
      if (!transition.allowed) throw new BizException(transition.biz);

      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id: sheet.id,
        expectedStatus: sheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
      });
      const lockedSheet = await this.access.findSheetOrThrow(id, tx);
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
    // 活动 v1.1 单一 cutover gate(合同 §16.2):闸**开**后本实例已切到 v1.1,
    // 旧考勤写入口永久关闭 —— 拒绝在此判,避免与新链并写形成合同禁止的混合态。
    this.activityWorkflowGate.assertLegacyWriteAllowed();
    await this.access.assertCanOrThrow(currentUser, 'attendance.reject.sheet', {
      type: 'attendance_sheet',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.access.findSheetOrThrow(id, tx);

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
      const lockedSheet = await this.access.findSheetOrThrow(id, tx);
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
    // 活动 v1.1 单一 cutover gate(合同 §16.2):闸**开**后本实例已切到 v1.1,
    // 旧考勤写入口永久关闭 —— 拒绝在此判,避免与新链并写形成合同禁止的混合态。
    this.activityWorkflowGate.assertLegacyWriteAllowed();
    await this.assertFinalReviewAuthzOrThrow(currentUser, 'attendance.final-approve.sheet', id);
    // M3:本事务内会取队员线性化键 ⇒ 必须显式 ReadCommitted + 有界锁等待(见 util 注释)。
    return runMemberLinearizedTransaction(this.prisma, async (tx) => {
      const sheet = await this.access.findSheetOrThrow(id, tx);

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
      const lockedSheet = await this.access.findSheetOrThrow(id, tx);
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
    // 活动 v1.1 单一 cutover gate(合同 §16.2):闸**开**后本实例已切到 v1.1,
    // 旧考勤写入口永久关闭 —— 拒绝在此判,避免与新链并写形成合同禁止的混合态。
    this.activityWorkflowGate.assertLegacyWriteAllowed();
    const returnNote = dto.returnNote.trim();
    if (!returnNote) throw new BizException(BizCode.ATTENDANCE_RETURN_NOTE_REQUIRED);
    await this.assertFinalReviewAuthzOrThrow(currentUser, 'attendance.final-return.sheet', id);
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.access.findSheetOrThrow(id, tx);
      const transition = this.sheetStateMachine.decide('finalReturn', sheet.statusCode);
      if (!transition.allowed) throw new BizException(transition.biz);

      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id: sheet.id,
        expectedStatus: sheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID,
      });
      const lockedSheet = await this.access.findSheetOrThrow(id, tx);
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
    // 活动 v1.1 单一 cutover gate(合同 §16.2):闸**开**后本实例已切到 v1.1,
    // 旧考勤写入口永久关闭 —— 拒绝在此判,避免与新链并写形成合同禁止的混合态。
    this.activityWorkflowGate.assertLegacyWriteAllowed();
    await this.assertFinalReviewAuthzOrThrow(currentUser, 'attendance.final-reject.sheet', id);
    return this.prisma.$transaction(async (tx) => {
      const sheet = await this.access.findSheetOrThrow(id, tx);

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
      const lockedSheet = await this.access.findSheetOrThrow(id, tx);
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
    // 活动 v1.1 单一 cutover gate(合同 §16.2):闸**开**后本实例已切到 v1.1,
    // 旧考勤写入口永久关闭 —— 拒绝在此判,避免与新链并写形成合同禁止的混合态。
    this.activityWorkflowGate.assertLegacyWriteAllowed();
    await this.access.assertCanOrThrow(currentUser, 'attendance.update.sheet', {
      type: 'attendance_sheet',
      id,
    });
    return this.prisma.$transaction(async (tx) => {
      const initialSheet = await this.access.findSheetOrThrow(id, tx);
      this.access.assertManagedSheetActivity(initialSheet.activityId, managedActivityId);

      await this.access.lockActivityForAttendanceWrite(initialSheet.activityId, tx);
      if (currentUser.role !== Role.SUPER_ADMIN) {
        await this.access.assertManagedAttendanceAccess(initialSheet.activityId, currentUser, tx);
      }

      const transition = this.sheetStateMachine.decide('resubmit', initialSheet.statusCode);
      if (!transition.allowed) throw new BizException(transition.biz);
      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id,
        expectedStatus: initialSheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
      });
      const lockedSheet = await this.access.findSheetOrThrow(id, tx);
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
    // 活动 v1.1 单一 cutover gate(合同 §16.2):闸**开**后本实例已切到 v1.1,
    // 旧考勤写入口永久关闭 —— 拒绝在此判,避免与新链并写形成合同禁止的混合态。
    this.activityWorkflowGate.assertLegacyWriteAllowed();
    await this.assertFinalReviewAuthzOrThrow(currentUser, 'attendance.reopen.sheet', id);
    const reason = dto.reason.trim();
    if (reason.length === 0) throw new BizException(BizCode.BAD_REQUEST);

    // M3:本事务内会取队员线性化键 ⇒ 必须显式 ReadCommitted + 有界锁等待(见 util 注释)。
    return runMemberLinearizedTransaction(this.prisma, async (tx) => {
      const sheet = await this.access.findSheetOrThrow(id, tx);
      const reopenTransition = this.sheetStateMachine.decide('reopen', sheet.statusCode);
      if (!reopenTransition.allowed) throw new BizException(reopenTransition.biz);

      await claimAtStatus(tx, {
        target: 'attendanceSheet',
        id: sheet.id,
        expectedStatus: sheet.statusCode,
        invalidStatusBiz: BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
      });
      const lockedSheet = await this.access.findSheetOrThrow(id, tx);

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
}
