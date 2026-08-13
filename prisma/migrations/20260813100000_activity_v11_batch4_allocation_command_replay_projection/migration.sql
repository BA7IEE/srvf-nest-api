-- 活动业务改造 v1.1 第 4 批⑭：prepare / commit / void 的精确回执、作废事实，
-- 以及 committed 后的不可变应用投影。
--
-- 纯 DDL。D85 仍没有任何 AllocationBatch / AllocationCandidate writer；为避免把未知
-- 历史猜成新合同，本迁移只接受相关事实为空。零业务 DML、零回填、零 endpoint/runtime。

BEGIN;

-- 固定父→子锁序，先取得所有将被 DDL 或新复合 FK 触及的表锁。未来 runtime writer
-- 必须在 deploy 前 drain；这把 D 刀不引入 writer。
LOCK TABLE "User" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "Activity" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivitySession" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivitySessionPosition" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivityParticipationIdentity" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivityParticipationRevision" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivityCapacityBucket" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "CapacityReservation" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivityAllocationBatch" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivityAllocationCandidate" IN ACCESS EXCLUSIVE MODE;

-- D85 承诺 batch/candidate 仍无生产 writer。若未来部署前已有相关事实，不猜、不回填，
-- 只报告 count；不得在错误文本泄露业务 id。
DO $allocation_d86_preflight$
DECLARE
  batch_count BIGINT;
  candidate_count BIGINT;
  revision_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO batch_count FROM "ActivityAllocationBatch";
  SELECT COUNT(*) INTO candidate_count FROM "ActivityAllocationCandidate";
  SELECT COUNT(*) INTO revision_count
  FROM "ActivityParticipationRevision"
  WHERE "allocationBatchId" IS NOT NULL;

  IF batch_count <> 0 OR candidate_count <> 0 OR revision_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'activity allocation command replay foundation guard: related facts must be empty (batches=%s, candidates=%s, revisions=%s)',
        batch_count,
        candidate_count,
        revision_count
      );
  END IF;
END
$allocation_d86_preflight$;

ALTER TABLE "ActivityAllocationBatch"
  ADD COLUMN "voidReason" TEXT,
  ADD COLUMN "voidedAt" TIMESTAMP(3);

-- allocation-d86:void-shape:begin
ALTER TABLE "ActivityAllocationBatch"
  ADD CONSTRAINT "activity_allocation_batch_void_shape_check"
  CHECK (
    ("statusCode" = 'voided'
      AND "voidReason" IS NOT NULL
      AND btrim("voidReason") <> ''
      AND char_length("voidReason") <= 500
      AND "voidedAt" IS NOT NULL)
    OR
    ("statusCode" IN ('preparing', 'committed')
      AND "voidReason" IS NULL
      AND "voidedAt" IS NULL)
  );
-- allocation-d86:void-shape:end

-- PostgreSQL 的复合 FK 必须有完全同序的被引用 unique。id 单列主键不能替代这些
-- 业务锚点；以下均为 expand-only 约束，不修改既有行。
ALTER TABLE "ActivityAllocationBatch"
  ADD CONSTRAINT "activity_allocation_batch_id_activity_unique"
  UNIQUE ("id", "activityId"),
  ADD CONSTRAINT "activity_allocation_batch_id_activity_session_unique"
  UNIQUE ("id", "activityId", "sessionId");

ALTER TABLE "ActivityAllocationCandidate"
  ADD CONSTRAINT "activity_allocation_candidate_id_batch_identity_unique"
  UNIQUE ("id", "allocationBatchId", "participationIdentityId");

ALTER TABLE "ActivityParticipationIdentity"
  -- committed projection 固定 identity 的 member/activity/session；不能把同场次的
  -- 另一 member 拼进来。
  ADD CONSTRAINT "activity_participation_identity_id_activity_session_member_key"
  UNIQUE ("id", "activityId", "sessionId", "memberId");

ALTER TABLE "ActivityParticipationRevision"
  ADD CONSTRAINT "activity_participation_revision_id_batch_identity_unique"
  UNIQUE ("id", "allocationBatchId", "identityId");

ALTER TABLE "ActivityCapacityBucket"
  ADD CONSTRAINT "activity_capacity_bucket_id_activity_unique"
  UNIQUE ("id", "activityId");

ALTER TABLE "CapacityReservation"
  ADD CONSTRAINT "capacity_reservation_id_identity_bucket_unique"
  UNIQUE ("id", "identityId", "bucketId"),
  -- activity_person 由既有容量内核按 member/activity 复用；它不能错误地按某个
  -- session identity 锚定。session / position reservation 仍使用上一条 identity 锚。
  ADD CONSTRAINT "capacity_reservation_id_member_activity_bucket_unique"
  UNIQUE ("id", "memberId", "activityId", "bucketId");

-- 精确回执的 JSON 只能是固定 v1 安全传输信封。CHECK 不能含子查询，故封为 IMMUTABLE
-- 函数；它不读表，不承担 allocation/void 真值，也不会泄露或容纳未揭示 seed。
-- `responseHash` 的唯一口径：runtime 对 UTF-8 的 canonical payload serialization 作
-- SHA-256；payload 排除 `responseHash`，字段顺序恰为 activityId、allocationBatchId、
-- batchStatusCode、commandCode、responseSchemaVersion。JSONB 对象本身不承诺键顺序，
-- 本 CHECK 只校验安全 shape 与列值对应，不把它当作哈希输入的保序载体。
CREATE FUNCTION activity_allocation_command_receipt_response_valid(
  input_value JSONB,
  expected_activity_id TEXT,
  expected_batch_id TEXT,
  expected_command_code TEXT,
  expected_schema_version TEXT,
  expected_response_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $activity_allocation_command_receipt_response_valid$
DECLARE
  key_name TEXT;
  batch_status_code TEXT;
BEGIN
  IF jsonb_typeof(input_value) <> 'object'
     OR NOT (input_value ?& ARRAY[
       'activityId',
       'allocationBatchId',
       'commandCode',
       'batchStatusCode',
       'responseSchemaVersion',
       'responseHash'
     ]) THEN
    RETURN FALSE;
  END IF;

  FOR key_name IN SELECT jsonb_object_keys(input_value)
  LOOP
    IF key_name NOT IN (
      'activityId',
      'allocationBatchId',
      'commandCode',
      'batchStatusCode',
      'responseSchemaVersion',
      'responseHash'
    ) THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  IF jsonb_typeof(input_value -> 'activityId') <> 'string'
     OR jsonb_typeof(input_value -> 'allocationBatchId') <> 'string'
     OR jsonb_typeof(input_value -> 'commandCode') <> 'string'
     OR jsonb_typeof(input_value -> 'batchStatusCode') <> 'string'
     OR jsonb_typeof(input_value -> 'responseSchemaVersion') <> 'string'
     OR jsonb_typeof(input_value -> 'responseHash') <> 'string'
     OR input_value ->> 'activityId' <> expected_activity_id
     OR input_value ->> 'allocationBatchId' <> expected_batch_id
     OR input_value ->> 'commandCode' <> expected_command_code
     OR input_value ->> 'responseSchemaVersion' <> expected_schema_version
     OR input_value ->> 'responseHash' <> expected_response_hash THEN
    RETURN FALSE;
  END IF;

  batch_status_code := input_value ->> 'batchStatusCode';
  RETURN (
    (expected_command_code = 'prepare' AND batch_status_code = 'preparing')
    OR (expected_command_code = 'commit' AND batch_status_code = 'committed')
    OR (expected_command_code = 'void' AND batch_status_code = 'voided')
  );
END;
$activity_allocation_command_receipt_response_valid$;

CREATE TABLE "ActivityAllocationCommandReceipt" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activityId" TEXT NOT NULL,
  "allocationBatchId" TEXT NOT NULL,
  "commandCode" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "responseSchemaVersion" TEXT NOT NULL,
  "responseHash" TEXT NOT NULL,
  "responseReceipt" JSONB NOT NULL,
  "actorUserId" TEXT NOT NULL,

  CONSTRAINT "ActivityAllocationCommandReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "activity_allocation_command_receipt_command_code_check"
    CHECK ("commandCode" IN ('prepare', 'commit', 'void')),
  CONSTRAINT "activity_allocation_command_receipt_operation_key_shape_check"
    CHECK (btrim("operationKey") <> '' AND char_length("operationKey") <= 128),
  CONSTRAINT "activity_allocation_command_receipt_request_hash_check"
    CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "activity_allocation_cmd_receipt_response_schema_version_check"
    CHECK ("responseSchemaVersion" = 'allocation-command-response-v1'),
  CONSTRAINT "activity_allocation_command_receipt_response_hash_check"
    CHECK ("responseHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "activity_allocation_command_receipt_response_shape_check"
    CHECK (activity_allocation_command_receipt_response_valid(
      "responseReceipt",
      "activityId",
      "allocationBatchId",
      "commandCode",
      "responseSchemaVersion",
      "responseHash"
    ))
);

-- allocation-d86:receipt-key-unique:begin
ALTER TABLE "ActivityAllocationCommandReceipt"
  ADD CONSTRAINT "activity_allocation_command_receipt_activity_command_key"
  UNIQUE ("activityId", "commandCode", "operationKey"),
  ADD CONSTRAINT "activity_allocation_command_receipt_batch_command_key"
  UNIQUE ("allocationBatchId", "commandCode");
-- allocation-d86:receipt-key-unique:end

-- allocation-d86:receipt-batch-anchor:begin
ALTER TABLE "ActivityAllocationCommandReceipt"
  ADD CONSTRAINT "activity_allocation_command_receipt_batch_anchor_fkey"
  FOREIGN KEY ("allocationBatchId", "activityId")
  REFERENCES "ActivityAllocationBatch" ("id", "activityId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- allocation-d86:receipt-batch-anchor:end

ALTER TABLE "ActivityAllocationCommandReceipt"
  ADD CONSTRAINT "activity_allocation_command_receipt_actor_fkey"
  FOREIGN KEY ("actorUserId")
  REFERENCES "User" ("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "activity_allocation_command_receipt_batch_idx"
ON "ActivityAllocationCommandReceipt" ("allocationBatchId");

CREATE INDEX "activity_allocation_command_receipt_actor_created_idx"
ON "ActivityAllocationCommandReceipt" ("actorUserId", "createdAt");

-- 每 candidate 只有一条 committed 应用投影。allocated / waitlisted / not_selected 的
-- 可表达形状由多个独立 CHECK 钉死；跨表的 Batch 当前状态、Candidate/Revision 内容、
-- reservationType 与 Identity live pointer 仍由后续 Activity 根锁命令同事务复核。
-- memberId 冻结 identity 事实：activity_person reservation 以 member/activity/bucket
-- 同锚，允许同一 member 的跨 session identity 复用；session / position 继续以
-- identity/bucket 同锚。
CREATE TABLE "ActivityAllocationApplicationProjection" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedAt" TIMESTAMP(3) NOT NULL,
  "activityId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "allocationBatchId" TEXT NOT NULL,
  "allocationCandidateId" TEXT NOT NULL,
  "participationIdentityId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "appliedParticipationRevisionId" TEXT NOT NULL,
  "appliedResultCode" TEXT NOT NULL,
  "appliedStatusCode" TEXT NOT NULL,
  "positionId" TEXT,
  "populationIncluded" BOOLEAN NOT NULL,
  "expectedIdentityCapacityReservationId" TEXT,
  "activityPersonReservationId" TEXT,
  "activityPersonBucketId" TEXT,
  "sessionReservationId" TEXT,
  "sessionBucketId" TEXT,
  "positionReservationId" TEXT,
  "positionBucketId" TEXT,

  CONSTRAINT "ActivityAllocationApplicationProjection_pkey" PRIMARY KEY ("id")
);

-- allocation-d86:projection-one-to-one:begin
ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_application_projection_candidate_key"
  UNIQUE ("allocationCandidateId"),
  ADD CONSTRAINT "activity_allocation_application_projection_batch_identity_key"
  UNIQUE ("allocationBatchId", "participationIdentityId");
-- allocation-d86:projection-one-to-one:end

-- allocation-d86:projection-result-status:begin
ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_result_status_check"
  CHECK (
    ("appliedResultCode" = 'allocated'
      AND "appliedStatusCode" = 'pass'
      AND "populationIncluded" = TRUE)
    OR
    ("appliedResultCode" = 'waitlisted'
      AND "appliedStatusCode" = 'waitlisted'
      AND "populationIncluded" = FALSE)
    OR
    ("appliedResultCode" = 'not_selected'
      AND "appliedStatusCode" = 'not_selected'
      AND "populationIncluded" = FALSE)
  );
-- allocation-d86:projection-result-status:end

-- allocation-d86:projection-active-reservation-shape:begin
ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_active_res_shape_check"
  CHECK (
    "appliedResultCode" <> 'allocated'
    OR (
      "expectedIdentityCapacityReservationId" IS NOT NULL
      AND "sessionReservationId" IS NOT NULL
      AND "expectedIdentityCapacityReservationId" = "sessionReservationId"
      AND "activityPersonReservationId" IS NOT NULL
      AND "activityPersonBucketId" IS NOT NULL
      AND "sessionBucketId" IS NOT NULL
    )
  );
-- allocation-d86:projection-active-reservation-shape:end

-- allocation-d86:projection-inactive-clear-shape:begin
ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_inactive_clear_check"
  CHECK (
    "appliedResultCode" = 'allocated'
    OR (
      "positionId" IS NULL
      AND "expectedIdentityCapacityReservationId" IS NULL
      AND "activityPersonReservationId" IS NULL
      AND "activityPersonBucketId" IS NULL
      AND "sessionReservationId" IS NULL
      AND "sessionBucketId" IS NULL
      AND "positionReservationId" IS NULL
      AND "positionBucketId" IS NULL
    )
  );
-- allocation-d86:projection-inactive-clear-shape:end

-- allocation-d86:projection-position-shape:begin
ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_position_shape_check"
  CHECK (
    ("positionId" IS NULL
      AND "positionReservationId" IS NULL
      AND "positionBucketId" IS NULL)
    OR
    ("positionId" IS NOT NULL
      AND "positionReservationId" IS NOT NULL
      AND "positionBucketId" IS NOT NULL)
  );
-- allocation-d86:projection-position-shape:end

ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_application_projection_batch_anchor_fkey"
  FOREIGN KEY ("allocationBatchId", "activityId", "sessionId")
  REFERENCES "ActivityAllocationBatch" ("id", "activityId", "sessionId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- allocation-d86:projection-candidate-anchor:begin
ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_candidate_anchor_fkey"
  FOREIGN KEY ("allocationCandidateId", "allocationBatchId", "participationIdentityId")
  REFERENCES "ActivityAllocationCandidate" ("id", "allocationBatchId", "participationIdentityId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- allocation-d86:projection-candidate-anchor:end

-- allocation-d86:projection-identity-member-anchor:begin
ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_identity_anchor_fkey"
  FOREIGN KEY ("participationIdentityId", "activityId", "sessionId", "memberId")
  REFERENCES "ActivityParticipationIdentity" ("id", "activityId", "sessionId", "memberId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- allocation-d86:projection-identity-member-anchor:end

ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_revision_anchor_fkey"
  FOREIGN KEY ("appliedParticipationRevisionId", "allocationBatchId", "participationIdentityId")
  REFERENCES "ActivityParticipationRevision" ("id", "allocationBatchId", "identityId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_position_anchor_fkey"
  FOREIGN KEY ("activityId", "sessionId", "positionId")
  REFERENCES "ActivitySessionPosition" ("activityId", "sessionId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- allocation-d86:projection-activity-person-reservation-anchor:begin
ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_activity_reservation_fkey"
  FOREIGN KEY ("activityPersonReservationId", "memberId", "activityId", "activityPersonBucketId")
  REFERENCES "CapacityReservation" ("id", "memberId", "activityId", "bucketId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- allocation-d86:projection-activity-person-reservation-anchor:end

-- allocation-d86:projection-session-reservation-anchor:begin
ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_session_reservation_fkey"
  FOREIGN KEY ("sessionReservationId", "participationIdentityId", "sessionBucketId")
  REFERENCES "CapacityReservation" ("id", "identityId", "bucketId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- allocation-d86:projection-session-reservation-anchor:end

ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_position_reservation_fkey"
  FOREIGN KEY ("positionReservationId", "participationIdentityId", "positionBucketId")
  REFERENCES "CapacityReservation" ("id", "identityId", "bucketId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_activity_bucket_fkey"
  FOREIGN KEY ("activityPersonBucketId", "activityId")
  REFERENCES "ActivityCapacityBucket" ("id", "activityId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_session_bucket_fkey"
  FOREIGN KEY ("sessionBucketId", "activityId")
  REFERENCES "ActivityCapacityBucket" ("id", "activityId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivityAllocationApplicationProjection"
  ADD CONSTRAINT "activity_allocation_app_projection_position_bucket_fkey"
  FOREIGN KEY ("positionBucketId", "activityId")
  REFERENCES "ActivityCapacityBucket" ("id", "activityId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE INDEX "activity_allocation_application_projection_batch_idx"
ON "ActivityAllocationApplicationProjection" ("allocationBatchId");

CREATE INDEX "activity_allocation_application_projection_identity_idx"
ON "ActivityAllocationApplicationProjection" ("participationIdentityId");

CREATE INDEX "activity_allocation_application_projection_revision_idx"
ON "ActivityAllocationApplicationProjection" ("appliedParticipationRevisionId");

CREATE FUNCTION activity_allocation_command_receipt_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $activity_allocation_command_receipt_immutable$
BEGIN
  RAISE EXCEPTION 'activity allocation command receipt is immutable'
  USING
    ERRCODE = '55000',
    CONSTRAINT = 'activity_allocation_command_receipt_immutable';
  RETURN NULL;
END;
$activity_allocation_command_receipt_immutable$;

CREATE TRIGGER trg_activity_allocation_command_receipt_10_immutable
BEFORE UPDATE OR DELETE ON "ActivityAllocationCommandReceipt"
FOR EACH ROW EXECUTE FUNCTION activity_allocation_command_receipt_immutable_guard();

CREATE FUNCTION activity_allocation_application_projection_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $activity_allocation_application_projection_immutable$
BEGIN
  RAISE EXCEPTION 'activity allocation application projection is immutable'
  USING
    ERRCODE = '55000',
    CONSTRAINT = 'activity_allocation_application_projection_immutable';
  RETURN NULL;
END;
$activity_allocation_application_projection_immutable$;

-- allocation-d86:projection-immutable-trigger:begin
CREATE TRIGGER trg_activity_allocation_application_projection_10_immutable
BEFORE UPDATE OR DELETE ON "ActivityAllocationApplicationProjection"
FOR EACH ROW EXECUTE FUNCTION activity_allocation_application_projection_immutable_guard();
-- allocation-d86:projection-immutable-trigger:end

COMMIT;
