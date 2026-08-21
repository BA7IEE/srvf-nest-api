-- 业务复合锚点闭合(第六轮评审 A-2 + B-03)
--
-- 背景:多张表同时保存多个业务锚点(activity / session / member / identity /
-- position / registration),但只有部分关系用了复合外键 —— 数据库因此只证明这些 ID
-- **各自存在**,不证明它们属于**同一条业务主链**。committed 账本分录是服务时长与
-- 贡献值的正式真相、关账与更正的基线;脏组合一旦写进去,后续冲正逻辑会把它当作可信
-- 基线继续记账,形成难以修复的跨活动污染。
--
-- 本 migration 做两件事:
--   * 22 条单列 / 窄复合外键升级为复合外键。列集扩展会让 PostgreSQL 约束改名,故
--     每条都是先 DROP 再 ADD;**onDelete / onUpdate 逐条原样保留**(升级前后动作
--     分布实测一致:20 × RESTRICT/CASCADE + 2 × RESTRICT/RESTRICT)。
--   * 12 条被引用侧 unique 锚点。PostgreSQL 复合外键要求被引用列上存在**精确匹配**
--     的 unique 约束,id 单列主键不能替代。因 id 本就是主键,任何含 id 的列集天然
--     唯一 ⇒ 这些 unique **仅作 FK 靶点,不新增任何业务约束**。
--
-- ⚠️ expand-only:零回填、零删列、零既有行重解释,不切任何读写路径。
--
-- ⚠️ **fail-closed 是期望行为**。若存量库已有跨锚点脏组合,ADD CONSTRAINT 会以
--    23503 失败并整体回滚 —— 这正是本刀要的结果,**不得**在本 migration 内回填或
--    删除数据来"修好"它。脏组合的识别与清理方法见配套 PR body。
--
-- 刻意**不**闭合的 4 处例外(CapacityReservation 族,详见配套判据的白名单与理由):
--   CapacityReservation.identity / .bucket
--   ActivityAllocationApplicationProjection.sessionReservation / .positionReservation
-- 第 78 migration(20260807154000)已拍板:CapacityReservation 的 memberId /
-- activityId 只对 active 且 activity_person 的行必填,session / position reservation
-- 保持可空、零回填。因此闭合它们要么被 Prisma 拒绝(必填关系不得含可空标量列),
-- 要么让指向 session / position reservation 的投影行恒定 23503 —— 两者都要求先改
-- 业务语义,超出本刀范围。

-- DropForeignKey
ALTER TABLE "ActivityAllocationApplicationProjection" DROP CONSTRAINT "activity_allocation_app_projection_candidate_anchor_fkey";

-- DropForeignKey
ALTER TABLE "ActivityAllocationBatch" DROP CONSTRAINT "ActivityAllocationBatch_positionId_fkey";

-- DropForeignKey
ALTER TABLE "ActivityAllocationBatch" DROP CONSTRAINT "ActivityAllocationBatch_ruleSnapshotId_fkey";

-- DropForeignKey
ALTER TABLE "ActivityAllocationCandidate" DROP CONSTRAINT "activity_allocation_candidate_identity_registration_fkey";

-- DropForeignKey
ALTER TABLE "ActivityInvitation" DROP CONSTRAINT "ActivityInvitation_positionId_fkey";

-- DropForeignKey
ALTER TABLE "ActivityParticipationIdentity" DROP CONSTRAINT "ActivityParticipationIdentity_currentPositionId_fkey";

-- DropForeignKey
ALTER TABLE "ActivityParticipationIdentity" DROP CONSTRAINT "ActivityParticipationIdentity_registrationId_fkey";

-- DropForeignKey
ALTER TABLE "ActivityRegistration" DROP CONSTRAINT "ActivityRegistration_activityPositionId_fkey";

-- DropForeignKey
ALTER TABLE "ActivityRegistration" DROP CONSTRAINT "ActivityRegistration_currentFormVersionId_fkey";

-- DropForeignKey
ALTER TABLE "AttendancePunchEvent" DROP CONSTRAINT "AttendancePunchEvent_participationIdentityId_fkey";

-- DropForeignKey
ALTER TABLE "AttendancePunchEvent" DROP CONSTRAINT "AttendancePunchEvent_positionId_fkey";

-- DropForeignKey
ALTER TABLE "AttendancePunchEvent" DROP CONSTRAINT "AttendancePunchEvent_qrCredentialId_fkey";

-- DropForeignKey
ALTER TABLE "AttendancePunchEvent" DROP CONSTRAINT "AttendancePunchEvent_supersedesEventId_fkey";

-- DropForeignKey
ALTER TABLE "OfflinePackage" DROP CONSTRAINT "OfflinePackage_ruleSnapshotId_fkey";

-- DropForeignKey
ALTER TABLE "OfflinePackageParticipant" DROP CONSTRAINT "OfflinePackageParticipant_identity_fkey";

-- DropForeignKey
ALTER TABLE "OfflinePackageParticipant" DROP CONSTRAINT "OfflinePackageParticipant_position_fkey";

-- DropForeignKey
ALTER TABLE "OfflinePunchReviewItem" DROP CONSTRAINT "OfflinePunchReviewItem_formal_event_fkey";

-- DropForeignKey
ALTER TABLE "OfflinePunchReviewItem" DROP CONSTRAINT "OfflinePunchReviewItem_identity_fkey";

-- DropForeignKey
ALTER TABLE "ParticipationLedgerEntry" DROP CONSTRAINT "ParticipationLedgerEntry_participationIdentityId_fkey";

-- DropForeignKey
ALTER TABLE "ParticipationLedgerEntry" DROP CONSTRAINT "ParticipationLedgerEntry_reversesEntryId_fkey";

-- DropForeignKey
ALTER TABLE "RegistrationUploadSession" DROP CONSTRAINT "RegistrationUploadSession_formVersionId_fkey";

-- DropForeignKey
ALTER TABLE "activity_check_ins" DROP CONSTRAINT "activity_check_ins_registrationId_fkey";

-- CreateIndex
CREATE UNIQUE INDEX "activity_allocation_candidate_id_batch_identity_act_sess_key" ON "ActivityAllocationCandidate"("id", "allocationBatchId", "participationIdentityId", "activityId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_participation_identity_id_activity_session_key" ON "ActivityParticipationIdentity"("id", "activityId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_participation_identity_id_reg_act_sess_key" ON "ActivityParticipationIdentity"("id", "registrationId", "activityId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_registration_id_activity_member_key" ON "ActivityRegistration"("id", "activityId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_rule_snapshot_id_activity_key" ON "ActivityRuleSnapshot"("id", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_punch_event_id_activity_session_member_key" ON "AttendancePunchEvent"("id", "activityId", "sessionId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_punch_event_id_activity_session_key" ON "AttendancePunchEvent"("id", "activityId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_qr_credential_id_activity_session_key" ON "AttendanceQrCredential"("id", "activityId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "offline_review_item_formal_punch_event_activity_session_key" ON "OfflinePunchReviewItem"("formalPunchEventId", "activityId", "sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "participation_ledger_entry_id_activity_session_member_key" ON "ParticipationLedgerEntry"("id", "activityId", "sessionId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "registration_form_version_id_activity_key" ON "RegistrationFormVersion"("id", "activityId");

-- CreateIndex
CREATE UNIQUE INDEX "activity_position_id_activity_key" ON "activity_positions"("id", "activityId");

-- AddForeignKey
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_activityPositionId_activityId_fkey" FOREIGN KEY ("activityPositionId", "activityId") REFERENCES "activity_positions"("id", "activityId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_currentFormVersionId_activityId_fkey" FOREIGN KEY ("currentFormVersionId", "activityId") REFERENCES "RegistrationFormVersion"("id", "activityId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_check_ins" ADD CONSTRAINT "activity_check_ins_registrationId_activityId_memberId_fkey" FOREIGN KEY ("registrationId", "activityId", "memberId") REFERENCES "ActivityRegistration"("id", "activityId", "memberId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityParticipationIdentity" ADD CONSTRAINT "ActivityParticipationIdentity_registrationId_activityId_me_fkey" FOREIGN KEY ("registrationId", "activityId", "memberId") REFERENCES "ActivityRegistration"("id", "activityId", "memberId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityParticipationIdentity" ADD CONSTRAINT "ActivityParticipationIdentity_currentPositionId_activityId_fkey" FOREIGN KEY ("currentPositionId", "activityId", "sessionId") REFERENCES "ActivitySessionPosition"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegistrationUploadSession" ADD CONSTRAINT "RegistrationUploadSession_formVersionId_activityId_fkey" FOREIGN KEY ("formVersionId", "activityId") REFERENCES "RegistrationFormVersion"("id", "activityId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityInvitation" ADD CONSTRAINT "ActivityInvitation_positionId_activityId_sessionId_fkey" FOREIGN KEY ("positionId", "activityId", "sessionId") REFERENCES "ActivitySessionPosition"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_positionId_activityId_sessionId_fkey" FOREIGN KEY ("positionId", "activityId", "sessionId") REFERENCES "ActivitySessionPosition"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_participationIdentityId_activityId_se_fkey" FOREIGN KEY ("participationIdentityId", "activityId", "sessionId", "memberId") REFERENCES "ActivityParticipationIdentity"("id", "activityId", "sessionId", "memberId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_qrCredentialId_activityId_sessionId_fkey" FOREIGN KEY ("qrCredentialId", "activityId", "sessionId") REFERENCES "AttendanceQrCredential"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendancePunchEvent" ADD CONSTRAINT "AttendancePunchEvent_supersedesEventId_activityId_sessionI_fkey" FOREIGN KEY ("supersedesEventId", "activityId", "sessionId", "memberId") REFERENCES "AttendancePunchEvent"("id", "activityId", "sessionId", "memberId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipationLedgerEntry" ADD CONSTRAINT "ParticipationLedgerEntry_participationIdentityId_activityI_fkey" FOREIGN KEY ("participationIdentityId", "activityId", "sessionId", "memberId") REFERENCES "ActivityParticipationIdentity"("id", "activityId", "sessionId", "memberId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipationLedgerEntry" ADD CONSTRAINT "ParticipationLedgerEntry_reversesEntryId_activityId_sessio_fkey" FOREIGN KEY ("reversesEntryId", "activityId", "sessionId", "memberId") REFERENCES "ParticipationLedgerEntry"("id", "activityId", "sessionId", "memberId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflinePackage" ADD CONSTRAINT "OfflinePackage_ruleSnapshotId_activityId_fkey" FOREIGN KEY ("ruleSnapshotId", "activityId") REFERENCES "ActivityRuleSnapshot"("id", "activityId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_participationIdentityId_activity_fkey" FOREIGN KEY ("participationIdentityId", "activityId", "sessionId", "memberId") REFERENCES "ActivityParticipationIdentity"("id", "activityId", "sessionId", "memberId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflinePackageParticipant" ADD CONSTRAINT "OfflinePackageParticipant_positionId_activityId_sessionId_fkey" FOREIGN KEY ("positionId", "activityId", "sessionId") REFERENCES "ActivitySessionPosition"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflinePunchReviewItem" ADD CONSTRAINT "OfflinePunchReviewItem_participationIdentityId_activityId__fkey" FOREIGN KEY ("participationIdentityId", "activityId", "sessionId") REFERENCES "ActivityParticipationIdentity"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflinePunchReviewItem" ADD CONSTRAINT "OfflinePunchReviewItem_formalPunchEventId_activityId_sessi_fkey" FOREIGN KEY ("formalPunchEventId", "activityId", "sessionId") REFERENCES "AttendancePunchEvent"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityAllocationBatch" ADD CONSTRAINT "ActivityAllocationBatch_positionId_activityId_sessionId_fkey" FOREIGN KEY ("positionId", "activityId", "sessionId") REFERENCES "ActivitySessionPosition"("id", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityAllocationBatch" ADD CONSTRAINT "ActivityAllocationBatch_ruleSnapshotId_activityId_fkey" FOREIGN KEY ("ruleSnapshotId", "activityId") REFERENCES "ActivityRuleSnapshot"("id", "activityId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityAllocationCandidate" ADD CONSTRAINT "activity_allocation_candidate_identity_registration_fkey" FOREIGN KEY ("participationIdentityId", "registrationId", "activityId", "sessionId") REFERENCES "ActivityParticipationIdentity"("id", "registrationId", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ActivityAllocationApplicationProjection" ADD CONSTRAINT "activity_allocation_app_projection_candidate_anchor_fkey" FOREIGN KEY ("allocationCandidateId", "allocationBatchId", "participationIdentityId", "activityId", "sessionId") REFERENCES "ActivityAllocationCandidate"("id", "allocationBatchId", "participationIdentityId", "activityId", "sessionId") ON DELETE RESTRICT ON UPDATE RESTRICT;
