-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "archiveWaitingDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "cancelOperationKey" TEXT,
ADD COLUMN     "currentClosureRevision" INTEGER,
ADD COLUMN     "currentEvidenceRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "currentPopulationRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "defaultCheckInRadiusMeters" INTEGER,
ADD COLUMN     "defaultLocationRequired" BOOLEAN,
ADD COLUMN     "registrationModeCode" TEXT,
ADD COLUMN     "terminatedAt" TIMESTAMP(3),
ADD COLUMN     "terminatedByUserId" TEXT,
ADD COLUMN     "terminationReason" TEXT,
ADD COLUMN     "visibilityCode" TEXT;

-- CreateTable
CREATE TABLE "ActivitySession" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "activityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "locationText" TEXT NOT NULL,
    "meetingPoint" TEXT,
    "executionPoint" TEXT,
    "evacuationPoint" TEXT,
    "longitude" DECIMAL(10,7),
    "latitude" DECIMAL(10,7),
    "capacity" INTEGER,
    "checkInOpenAt" TIMESTAMP(3) NOT NULL,
    "checkInCloseAt" TIMESTAMP(3) NOT NULL,
    "checkOutOpenAt" TIMESTAMP(3) NOT NULL,
    "checkOutCloseAt" TIMESTAMP(3) NOT NULL,
    "preparationStartAt" TIMESTAMP(3),
    "locationRequired" BOOLEAN NOT NULL,
    "radiusMeters" INTEGER,
    "locationPolicySourceCode" TEXT NOT NULL,
    "accuracyWarningMeters" INTEGER NOT NULL DEFAULT 100,
    "lateGraceMinutes" INTEGER NOT NULL DEFAULT 15,
    "earlyLeaveThresholdMinutes" INTEGER NOT NULL DEFAULT 15,
    "terminationCheckOutDeadline" TIMESTAMP(3),
    "statusCode" TEXT NOT NULL,
    "workflowRevision" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ActivitySession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivitySessionPosition" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "activityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "attendanceRoleCode" TEXT NOT NULL,
    "capacity" INTEGER,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "genderRequirementCode" TEXT,
    "locationRequired" BOOLEAN,
    "radiusMeters" INTEGER,
    "leaderMemberId" TEXT,
    "description" TEXT,
    "equipmentNotes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ActivitySessionPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityParticipationIdentity" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "currentRevision" INTEGER NOT NULL DEFAULT 0,
    "currentStatusCode" TEXT NOT NULL,
    "currentPositionId" TEXT,
    "capacityReservationId" TEXT,
    "populationIncluded" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ActivityParticipationIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityParticipationRevision" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "identityId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "statusCode" TEXT NOT NULL,
    "positionId" TEXT,
    "preferenceSnapshot" JSONB,
    "waitlistRank" INTEGER,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "cancelledByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" TEXT,
    "sourceCode" TEXT NOT NULL,
    "requestKey" TEXT,
    "requestHash" TEXT,

    CONSTRAINT "ActivityParticipationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityCapacityBucket" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activityId" TEXT NOT NULL,
    "scopeTypeCode" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "capacity" INTEGER,
    "occupied" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ActivityCapacityBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacityReservation" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "identityId" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "reservationType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releaseReason" TEXT,

    CONSTRAINT "CapacityReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivitySession_activityId_idx" ON "ActivitySession"("activityId");

-- CreateIndex
CREATE INDEX "ActivitySession_statusCode_idx" ON "ActivitySession"("statusCode");

-- CreateIndex
CREATE INDEX "ActivitySession_startAt_idx" ON "ActivitySession"("startAt");

-- CreateIndex
CREATE INDEX "ActivitySession_endAt_idx" ON "ActivitySession"("endAt");

-- CreateIndex
CREATE INDEX "ActivitySession_checkOutCloseAt_idx" ON "ActivitySession"("checkOutCloseAt");

-- CreateIndex
CREATE INDEX "ActivitySession_activityId_sortOrder_idx" ON "ActivitySession"("activityId", "sortOrder");

-- CreateIndex
CREATE INDEX "ActivitySession_deletedAt_idx" ON "ActivitySession"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivitySession_activityId_id_key" ON "ActivitySession"("activityId", "id");

-- CreateIndex
CREATE INDEX "ActivitySessionPosition_activityId_idx" ON "ActivitySessionPosition"("activityId");

-- CreateIndex
CREATE INDEX "ActivitySessionPosition_sessionId_idx" ON "ActivitySessionPosition"("sessionId");

-- CreateIndex
CREATE INDEX "ActivitySessionPosition_attendanceRoleCode_idx" ON "ActivitySessionPosition"("attendanceRoleCode");

-- CreateIndex
CREATE INDEX "ActivitySessionPosition_leaderMemberId_idx" ON "ActivitySessionPosition"("leaderMemberId");

-- CreateIndex
CREATE INDEX "ActivitySessionPosition_sessionId_sortOrder_idx" ON "ActivitySessionPosition"("sessionId", "sortOrder");

-- CreateIndex
CREATE INDEX "ActivitySessionPosition_deletedAt_idx" ON "ActivitySessionPosition"("deletedAt");

-- CreateIndex
CREATE INDEX "ActivityParticipationIdentity_activityId_idx" ON "ActivityParticipationIdentity"("activityId");

-- CreateIndex
CREATE INDEX "ActivityParticipationIdentity_sessionId_idx" ON "ActivityParticipationIdentity"("sessionId");

-- CreateIndex
CREATE INDEX "ActivityParticipationIdentity_memberId_idx" ON "ActivityParticipationIdentity"("memberId");

-- CreateIndex
CREATE INDEX "ActivityParticipationIdentity_registrationId_idx" ON "ActivityParticipationIdentity"("registrationId");

-- CreateIndex
CREATE INDEX "ActivityParticipationIdentity_currentStatusCode_idx" ON "ActivityParticipationIdentity"("currentStatusCode");

-- CreateIndex
CREATE INDEX "ActivityParticipationIdentity_currentPositionId_idx" ON "ActivityParticipationIdentity"("currentPositionId");

-- CreateIndex
CREATE INDEX "ActivityParticipationIdentity_activityId_populationIncluded_idx" ON "ActivityParticipationIdentity"("activityId", "populationIncluded");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityParticipationIdentity_activityId_sessionId_memberId_key" ON "ActivityParticipationIdentity"("activityId", "sessionId", "memberId");

-- CreateIndex
CREATE INDEX "ActivityParticipationRevision_identityId_idx" ON "ActivityParticipationRevision"("identityId");

-- CreateIndex
CREATE INDEX "ActivityParticipationRevision_statusCode_idx" ON "ActivityParticipationRevision"("statusCode");

-- CreateIndex
CREATE INDEX "ActivityParticipationRevision_positionId_idx" ON "ActivityParticipationRevision"("positionId");

-- CreateIndex
CREATE INDEX "ActivityParticipationRevision_effectiveAt_idx" ON "ActivityParticipationRevision"("effectiveAt");

-- CreateIndex
CREATE INDEX "ActivityParticipationRevision_requestKey_idx" ON "ActivityParticipationRevision"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityParticipationRevision_identityId_revision_key" ON "ActivityParticipationRevision"("identityId", "revision");

-- CreateIndex
CREATE INDEX "ActivityCapacityBucket_activityId_idx" ON "ActivityCapacityBucket"("activityId");

-- CreateIndex
CREATE INDEX "ActivityCapacityBucket_scopeTypeCode_idx" ON "ActivityCapacityBucket"("scopeTypeCode");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityCapacityBucket_scopeTypeCode_scopeId_key" ON "ActivityCapacityBucket"("scopeTypeCode", "scopeId");

-- CreateIndex
CREATE INDEX "CapacityReservation_identityId_idx" ON "CapacityReservation"("identityId");

-- CreateIndex
CREATE INDEX "CapacityReservation_bucketId_idx" ON "CapacityReservation"("bucketId");

-- CreateIndex
CREATE INDEX "CapacityReservation_status_idx" ON "CapacityReservation"("status");

-- CreateIndex
CREATE INDEX "CapacityReservation_bucketId_status_idx" ON "CapacityReservation"("bucketId", "status");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_terminatedByUserId_fkey" FOREIGN KEY ("terminatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySession" ADD CONSTRAINT "ActivitySession_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySessionPosition" ADD CONSTRAINT "ActivitySessionPosition_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySessionPosition" ADD CONSTRAINT "ActivitySessionPosition_activityId_sessionId_fkey" FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySessionPosition" ADD CONSTRAINT "ActivitySessionPosition_leaderMemberId_fkey" FOREIGN KEY ("leaderMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityParticipationIdentity" ADD CONSTRAINT "ActivityParticipationIdentity_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityParticipationIdentity" ADD CONSTRAINT "ActivityParticipationIdentity_activityId_sessionId_fkey" FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityParticipationIdentity" ADD CONSTRAINT "ActivityParticipationIdentity_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "ActivityRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityParticipationIdentity" ADD CONSTRAINT "ActivityParticipationIdentity_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityParticipationIdentity" ADD CONSTRAINT "ActivityParticipationIdentity_currentPositionId_fkey" FOREIGN KEY ("currentPositionId") REFERENCES "ActivitySessionPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityParticipationRevision" ADD CONSTRAINT "ActivityParticipationRevision_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "ActivityParticipationIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityParticipationRevision" ADD CONSTRAINT "ActivityParticipationRevision_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "ActivitySessionPosition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityParticipationRevision" ADD CONSTRAINT "ActivityParticipationRevision_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityParticipationRevision" ADD CONSTRAINT "ActivityParticipationRevision_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityParticipationRevision" ADD CONSTRAINT "ActivityParticipationRevision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityCapacityBucket" ADD CONSTRAINT "ActivityCapacityBucket_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityReservation" ADD CONSTRAINT "CapacityReservation_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "ActivityParticipationIdentity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityReservation" ADD CONSTRAINT "CapacityReservation_bucketId_fkey" FOREIGN KEY ("bucketId") REFERENCES "ActivityCapacityBucket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ############################################################################
-- 以下全部为**手写**约束(Prisma DSL 6.x 表达不了 CHECK,也表达不了 partial unique
-- 的 WHERE 子句)。沿既有范式:
--   prisma/migrations/20260707130528_user_memberid_partial_unique/migration.sql
--   prisma/migrations/20260801093000_wecom_identity_foundation/migration.sql
--
-- 合同:docs/archive/reviews/activity-business-overhaul-v1.1/
--       SRVF_活动业务全流程改造_详细开发文档_v1.1.md §3.1 / §3.2 / §3.3 / §3.8 / §3.9 / §3.10
--
-- 本 migration 是 **expand-only**:零 DROP、零 RENAME、零既有列语义变更、零回填、
-- 零删数。对既有表 "Activity" 只 ADD COLUMN(全部可空或带 default)与只对**新列**
-- 生效的 CHECK —— 存量行在这些 CHECK 下恒真,不可能让既有行为变红。
-- ############################################################################

-- ===== ① 既有表 "Activity" 的约束(§3.1)=====
--
-- ⚠️ 唯一一条落在**既有列**上的约束是 capacity —— 加它之前已核:
--   (a) 应用层 DTO 早已拒 capacity < 1(test/e2e/activities.e2e-spec.ts「capacity < 1 → 400」);
--   (b) 开发库实测 `SELECT count(*) FROM "Activity" WHERE capacity IS NOT NULL AND capacity < 1` = 0。
-- 故本 CHECK 与既有行为一致,不是新的红。
ALTER TABLE "Activity"
ADD CONSTRAINT "activity_capacity_positive_check"
CHECK ("capacity" IS NULL OR "capacity" >= 1);

-- §3.1:默认 7,范围 0..365。新列带 DEFAULT 7 ⇒ 存量行读作 7,恒满足。
ALTER TABLE "Activity"
ADD CONSTRAINT "activity_archive_waiting_days_range_check"
CHECK ("archiveWaitingDays" BETWEEN 0 AND 365);

-- §3.1:两个修订号初始 0,只增不减。
ALTER TABLE "Activity"
ADD CONSTRAINT "activity_current_revision_non_negative_check"
CHECK ("currentEvidenceRevision" >= 0 AND "currentPopulationRevision" >= 0);

-- §3.1 闭集。两列本刀可空(null = 尚未解析,见 schema.prisma 注释),
-- 故 CHECK 必须放行 NULL —— 后续 contract 刀连同真回填一起收紧为 NOT NULL。
ALTER TABLE "Activity"
ADD CONSTRAINT "activity_registration_mode_code_check"
CHECK ("registrationModeCode" IS NULL
       OR "registrationModeCode" IN ('open_apply', 'invitation_only', 'admin_only', 'paused'));

ALTER TABLE "Activity"
ADD CONSTRAINT "activity_visibility_code_check"
CHECK ("visibilityCode" IS NULL OR "visibilityCode" IN ('internal', 'invitation'));

-- §3.1:「terminatedAt 只在 statusCode='terminated' 时有值」。
-- ⚠️ 合同同句还要求「cancelledAt 只在 cancelled 时有值」—— 那半条落在**既有列**
-- cancelledAt/statusCode 上,属既有行为的收紧,不在本 expand 刀范围(goal ①),
-- 留给 contract 阶段连同 statusCode 闭集调整一起做。
-- 本条只守新列:存量行 terminatedAt 恒 NULL ⇒ 恒真。
ALTER TABLE "Activity"
ADD CONSTRAINT "activity_termination_shape_check"
CHECK ("terminatedAt" IS NULL OR "statusCode" = 'terminated');

-- ===== ② "ActivitySession"(§3.2)=====

ALTER TABLE "ActivitySession"
ADD CONSTRAINT "activity_session_capacity_positive_check"
CHECK ("capacity" IS NULL OR "capacity" >= 1);

ALTER TABLE "ActivitySession"
ADD CONSTRAINT "activity_session_time_range_check"
CHECK ("startAt" < "endAt");

-- §3.2:四个窗口必须满足 checkInOpenAt <= checkInCloseAt <= checkOutCloseAt。
-- 允许签到与签退窗口**重叠**(合同明写),故这里不禁 checkOutOpenAt < checkInCloseAt。
ALTER TABLE "ActivitySession"
ADD CONSTRAINT "activity_session_checkin_window_check"
CHECK ("checkInOpenAt" <= "checkInCloseAt" AND "checkInCloseAt" <= "checkOutCloseAt");

ALTER TABLE "ActivitySession"
ADD CONSTRAINT "activity_session_checkout_window_check"
CHECK ("checkOutOpenAt" <= "checkOutCloseAt");

-- §3.2:准备时段不得晚于场次开始。
ALTER TABLE "ActivitySession"
ADD CONSTRAINT "activity_session_preparation_start_check"
CHECK ("preparationStartAt" IS NULL OR "preparationStartAt" <= "startAt");

-- §3.2:坐标成对(同空或同有值)。
ALTER TABLE "ActivitySession"
ADD CONSTRAINT "activity_session_coordinate_pair_check"
CHECK (("longitude" IS NULL) = ("latitude" IS NULL));

-- §3.2:「locationRequired=true 时坐标与半径必填,半径 50..10000;
--        false 时半径必须 null,但坐标可保留作导航」。
--
-- ⚠️ `"radiusMeters" IS NOT NULL` 这一条**不是冗余**,删掉它约束就漏:
-- CHECK 在表达式求值为 **NULL 时判通过**(SQL 三值逻辑),而
-- `NULL BETWEEN 50 AND 10000` = NULL ⇒ 第二个分支整体为 NULL ⇒
-- `false OR NULL` = NULL ⇒ "locationRequired=true 却没填半径"会被**静默放行**。
-- 加了 IS NOT NULL 之后该分支塌成 false,整条 OR 才真的为假。
-- 这个洞是配套 spec 的拒绝用例实测抓出来的(初版写法在真库上确实放行了)。
ALTER TABLE "ActivitySession"
ADD CONSTRAINT "activity_session_location_policy_check"
CHECK (
  ("locationRequired" = false AND "radiusMeters" IS NULL)
  OR
  ("locationRequired" = true
   AND "radiusMeters" IS NOT NULL
   AND "radiusMeters" BETWEEN 50 AND 10000
   AND "longitude" IS NOT NULL
   AND "latitude" IS NOT NULL)
);

-- §3.2 状态闭集(进行中／结束按时间派生,不入闭集)。
ALTER TABLE "ActivitySession"
ADD CONSTRAINT "activity_session_status_code_check"
CHECK ("statusCode" IN ('scheduled', 'cancelled', 'terminated'));

-- §3.2:仅说明最终值来源。
ALTER TABLE "ActivitySession"
ADD CONSTRAINT "activity_session_location_policy_source_check"
CHECK ("locationPolicySourceCode" IN ('system', 'template', 'activity', 'session', 'position'));

-- §3.2:迟到／早退阈值默认 15,可在 0..60。
ALTER TABLE "ActivitySession"
ADD CONSTRAINT "activity_session_grace_minutes_range_check"
CHECK ("lateGraceMinutes" BETWEEN 0 AND 60 AND "earlyLeaveThresholdMinutes" BETWEEN 0 AND 60);

-- §3.2:live (activityId, code) 与 (activityId, name) 唯一。
-- partial(WHERE deletedAt IS NULL)是关键 —— 草稿软删后必须能复用同一 code/name。
CREATE UNIQUE INDEX "activity_session_activity_code_live_unique"
ON "ActivitySession" ("activityId", "code")
WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "activity_session_activity_name_live_unique"
ON "ActivitySession" ("activityId", "name")
WHERE "deletedAt" IS NULL;

-- ===== ③ "ActivitySessionPosition"(§3.3)=====

ALTER TABLE "ActivitySessionPosition"
ADD CONSTRAINT "activity_session_position_capacity_positive_check"
CHECK ("capacity" IS NULL OR "capacity" >= 1);

-- §3.3:startAt/endAt「有值时必须同空同有」;有值时先后有序。
-- 「且位于 session 内」是跨行判据,单表 CHECK 表达不了,由 service 保证(见 schema 注释)。
ALTER TABLE "ActivitySessionPosition"
ADD CONSTRAINT "activity_session_position_time_pair_check"
CHECK (
  ("startAt" IS NULL) = ("endAt" IS NULL)
  AND ("startAt" IS NULL OR "startAt" < "endAt")
);

-- §3.3:locationRequired/radiusMeters 可空覆盖 session。
-- 守两件事:显式 false 时不得带半径;半径一旦有值必须落在与 session 同一域 50..10000。
-- 不禁「locationRequired IS NULL 但 radiusMeters 有值」—— 岗位允许只覆盖半径而继承
-- session 的 locationRequired(合同称两者各自「可空覆盖」)。
ALTER TABLE "ActivitySessionPosition"
ADD CONSTRAINT "activity_session_position_location_policy_check"
CHECK (
  ("locationRequired" IS DISTINCT FROM false OR "radiusMeters" IS NULL)
  AND ("radiusMeters" IS NULL OR "radiusMeters" BETWEEN 50 AND 10000)
);

-- §3.3:live (sessionId, code)、live (sessionId, name) 唯一。
CREATE UNIQUE INDEX "activity_session_position_session_code_live_unique"
ON "ActivitySessionPosition" ("sessionId", "code")
WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "activity_session_position_session_name_live_unique"
ON "ActivitySessionPosition" ("sessionId", "name")
WHERE "deletedAt" IS NULL;

-- ===== ④ "ActivityParticipationIdentity"(§3.8)=====
--
-- (activityId, sessionId, memberId) 的**普通** unique 已由 Prisma @@unique 生成
-- (见上文 CreateIndex)——§3.8 原话「不带删除条件」:取消重报只追加 Revision
-- 并改当前指针,永不再建身份行。这里不再手写。

ALTER TABLE "ActivityParticipationIdentity"
ADD CONSTRAINT "activity_participation_identity_counter_check"
CHECK ("currentRevision" >= 0 AND "version" >= 0);

-- §3.9 的 14 态闭集;identity 的当前状态投影与 revision 共用同一闭集。
ALTER TABLE "ActivityParticipationIdentity"
ADD CONSTRAINT "activity_participation_identity_status_code_check"
CHECK ("currentStatusCode" IN (
  'pending', 'pass', 'waitlisted', 'not_selected', 'rejected', 'cancelled',
  'cancellation_requested', 'invitation_pending', 'invitation_declined',
  'invitation_expired', 'review_expired', 'waitlist_expired', 'attended', 'settled'
));

-- ===== ⑤ "ActivityParticipationRevision"(§3.9)=====

ALTER TABLE "ActivityParticipationRevision"
ADD CONSTRAINT "activity_participation_revision_number_check"
CHECK ("revision" >= 0);

ALTER TABLE "ActivityParticipationRevision"
ADD CONSTRAINT "activity_participation_revision_status_code_check"
CHECK ("statusCode" IN (
  'pending', 'pass', 'waitlisted', 'not_selected', 'rejected', 'cancelled',
  'cancellation_requested', 'invitation_pending', 'invitation_declined',
  'invitation_expired', 'review_expired', 'waitlist_expired', 'attended', 'settled'
));

-- ===== ⑥ "ActivityCapacityBucket"(§3.10)=====

ALTER TABLE "ActivityCapacityBucket"
ADD CONSTRAINT "activity_capacity_bucket_scope_type_code_check"
CHECK ("scopeTypeCode" IN (
  'activity_person', 'session_participation', 'position_participation', 'reserve_group'
));

ALTER TABLE "ActivityCapacityBucket"
ADD CONSTRAINT "activity_capacity_bucket_capacity_positive_check"
CHECK ("capacity" IS NULL OR "capacity" >= 1);

-- §3.10:occupied >= 0 且不大于 capacity(capacity 为 null 时不设上限)。
-- 这条是"超卖"在 DB 层的最后一道闸 —— 占位事务的 CAS 之外的兜底。
ALTER TABLE "ActivityCapacityBucket"
ADD CONSTRAINT "activity_capacity_bucket_occupancy_check"
CHECK ("occupied" >= 0 AND ("capacity" IS NULL OR "occupied" <= "capacity"));

ALTER TABLE "ActivityCapacityBucket"
ADD CONSTRAINT "activity_capacity_bucket_version_check"
CHECK ("version" >= 0);

-- ===== ⑦ "CapacityReservation"(§3.10)=====

ALTER TABLE "CapacityReservation"
ADD CONSTRAINT "capacity_reservation_status_check"
CHECK ("status" IN ('active', 'released'));

-- 释放形状:active ⇔ releasedAt IS NULL。沿 wecom_identity_revocation_shape_check 同形。
-- 防的是"状态说 active、却带着释放时间"和"状态说 released、却查不到什么时候释放的"。
-- ⚠️ 与 wecom 同一坑:非法 status 会让本 CHECK 的两个分支**同时为假**,
-- 于是它在 INSERT 路径上**覆盖** status_check —— 配套 spec 对非法 status 只断言
-- SQLSTATE 23514,不断言命中哪条约束(断言具体约束名会是假绿)。
ALTER TABLE "CapacityReservation"
ADD CONSTRAINT "capacity_reservation_release_shape_check"
CHECK (
  ("status" = 'active' AND "releasedAt" IS NULL)
  OR
  ("status" = 'released' AND "releasedAt" IS NOT NULL)
);

-- §3.10:「partial unique 保证一个 identity 对一个 bucket 至多一条 active reservation」。
-- partial 是关键 —— released 历史行必须能重复,否则"释放后重新占位"会被永久挡死。
--
-- ⚠️ 合同 §3.10 同句还要求第二条:「一个 member／activity 至多一条 active
-- activity-person reservation」。但 §3.10 自己的字段表只给了
-- identityId/bucketId/reservationType/status/createdAt/releasedAt/releaseReason,
-- **没有 memberId / activityId 两列**,该索引无从建起;goal DoD 5 也只列了第一条。
-- 本刀实现第一条,第二条作为**合同内部不一致上报维护者**,不自行发明列去补(AGENTS §2)。
CREATE UNIQUE INDEX "capacity_reservation_identity_bucket_active_unique"
ON "CapacityReservation" ("identityId", "bucketId")
WHERE "status" = 'active';
