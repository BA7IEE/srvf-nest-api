-- 活动业务改造 v1.1 第 4 批⑬：可重放分配合同与候选冻结地基。
-- 当前生产代码没有 AllocationBatch / AllocationCandidate writer；为避免把未知历史
-- 猜成新合同，部署前要求两表为空。整刀只做 DDL 与 count-only fail-fast，零业务 DML。

BEGIN;

-- 稳定父→子顺序取得最终 DDL 锁；部署时必须先 drain 未来 allocation writer。
LOCK TABLE "ActivityParticipationIdentity" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivityRegistrationRevision" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivityAllocationBatch" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivityAllocationCandidate" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  batch_count BIGINT;
  candidate_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO batch_count FROM "ActivityAllocationBatch";
  SELECT COUNT(*) INTO candidate_count FROM "ActivityAllocationCandidate";

  IF batch_count <> 0 OR candidate_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'activity allocation determinism guard: tables must be empty (batches=%s, candidates=%s)',
        batch_count,
        candidate_count
      );
  END IF;
END
$$;

ALTER TABLE "ActivityAllocationBatch"
  ADD COLUMN "algorithmVersionCode" TEXT NOT NULL,
  ADD COLUMN "randomSeedReveal" TEXT;

ALTER TABLE "ActivityAllocationCandidate"
  ADD COLUMN "registrationId" TEXT NOT NULL,
  ADD COLUMN "registrationRevisionId" TEXT NOT NULL,
  ADD COLUMN "acceptedAt" TIMESTAMP(3) NOT NULL,
  ADD COLUMN "qualificationSnapshotHash" TEXT NOT NULL,
  ALTER COLUMN "explanation" SET NOT NULL;

-- PostgreSQL 复合 FK 要求被引用列具有完全同序的 unique；id 单列主键不能替代。
ALTER TABLE "ActivityParticipationIdentity"
  ADD CONSTRAINT "activity_participation_identity_id_registration_id_unique"
  UNIQUE ("id", "registrationId");

ALTER TABLE "ActivityAllocationCandidate"
  DROP CONSTRAINT "ActivityAllocationCandidate_participationIdentityId_fkey";

-- allocation-d85:identity-registration-fk:begin
ALTER TABLE "ActivityAllocationCandidate"
  ADD CONSTRAINT "activity_allocation_candidate_identity_registration_fkey"
  FOREIGN KEY ("participationIdentityId", "registrationId")
  REFERENCES "ActivityParticipationIdentity" ("id", "registrationId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- allocation-d85:identity-registration-fk:end

-- allocation-d85:registration-revision-fk:begin
ALTER TABLE "ActivityAllocationCandidate"
  ADD CONSTRAINT "activity_allocation_candidate_registration_revision_fkey"
  FOREIGN KEY ("registrationId", "registrationRevisionId")
  REFERENCES "ActivityRegistrationRevision" ("registrationId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- allocation-d85:registration-revision-fk:end

ALTER TABLE "ActivityAllocationBatch"
  ADD CONSTRAINT "activity_allocation_batch_algorithm_version_code_check"
  CHECK (
    "algorithmVersionCode" IS NOT NULL
    AND char_length("algorithmVersionCode") BETWEEN 1 AND 64
  ),
  ADD CONSTRAINT "activity_allocation_batch_candidate_snapshot_hash_check"
  CHECK (
    "candidateSnapshotHash" IS NOT NULL
    AND "candidateSnapshotHash" ~ '^[0-9a-f]{64}$'
  );

-- allocation-d85:lottery-seed-shape:begin
ALTER TABLE "ActivityAllocationBatch"
  ADD CONSTRAINT "activity_allocation_batch_lottery_seed_shape_check"
  CHECK (
    (
      "modeCode" = 'lottery'
      AND "randomCommitment" IS NOT NULL
      AND "randomCommitment" ~ '^[0-9a-f]{64}$'
      AND (
        ("statusCode" = 'preparing' AND "randomSeedReveal" IS NULL)
        OR (
          "statusCode" = 'committed'
          AND "randomSeedReveal" IS NOT NULL
          AND "randomSeedReveal" ~ '^[0-9a-f]{64}$'
        )
        OR (
          "statusCode" = 'voided'
          AND (
            "randomSeedReveal" IS NULL
            OR "randomSeedReveal" ~ '^[0-9a-f]{64}$'
          )
        )
      )
    )
    OR (
      "modeCode" IN ('first_come', 'qualification_rank')
      AND "randomCommitment" IS NULL
      AND "randomSeedReveal" IS NULL
    )
  );
-- allocation-d85:lottery-seed-shape:end

ALTER TABLE "ActivityAllocationBatch"
  ADD CONSTRAINT "activity_allocation_batch_status_committed_at_check"
  CHECK (
    "statusCode" IS NOT NULL
    AND (
      ("statusCode" = 'preparing' AND "committedAt" IS NULL)
      OR ("statusCode" = 'committed' AND "committedAt" IS NOT NULL)
      OR "statusCode" = 'voided'
    )
  );

ALTER TABLE "ActivityAllocationCandidate"
  ADD CONSTRAINT "activity_allocation_candidate_qualification_snapshot_hash_check"
  CHECK (
    "qualificationSnapshotHash" IS NOT NULL
    AND "qualificationSnapshotHash" ~ '^[0-9a-f]{64}$'
  );

-- allocation-d85:result-score-shape:begin
ALTER TABLE "ActivityAllocationCandidate"
  ADD CONSTRAINT "activity_allocation_candidate_qualification_score_range_check"
  CHECK (
    "qualificationScore" IS NULL
    OR "qualificationScore" BETWEEN 0 AND 100
  ),
  ADD CONSTRAINT "activity_allocation_candidate_result_rank_shape_check"
  CHECK (
    ("resultCode" IS NULL AND "waitlistRank" IS NULL)
    OR ("resultCode" IN ('allocated', 'not_selected') AND "waitlistRank" IS NULL)
    OR ("resultCode" = 'waitlisted' AND "waitlistRank" IS NOT NULL)
  );
-- allocation-d85:result-score-shape:end

ALTER TABLE "ActivityAllocationCandidate"
  ADD CONSTRAINT "activity_allocation_candidate_lottery_order_one_based_check"
  CHECK ("lotteryOrder" IS NULL OR "lotteryOrder" >= 1),
  ADD CONSTRAINT "activity_allocation_candidate_waitlist_rank_one_based_check"
  CHECK ("waitlistRank" IS NULL OR "waitlistRank" >= 1),
  ADD CONSTRAINT "activity_allocation_candidate_tie_break_key_nonempty_check"
  CHECK ("tieBreakKey" IS NOT NULL AND char_length("tieBreakKey") >= 1),
  ADD CONSTRAINT "activity_allocation_candidate_explanation_object_check"
  CHECK ("explanation" IS NOT NULL AND jsonb_typeof("explanation") = 'object'),
  ADD CONSTRAINT "activity_allocation_candidate_batch_tie_break_key"
  UNIQUE ("allocationBatchId", "tieBreakKey");

-- allocation-d85:rank-order-unique:begin
CREATE UNIQUE INDEX "activity_allocation_candidate_batch_lottery_order_unique"
ON "ActivityAllocationCandidate" ("allocationBatchId", "lotteryOrder")
WHERE "lotteryOrder" IS NOT NULL;

CREATE UNIQUE INDEX "activity_allocation_candidate_batch_waitlist_rank_unique"
ON "ActivityAllocationCandidate" ("allocationBatchId", "waitlistRank")
WHERE "waitlistRank" IS NOT NULL;
-- allocation-d85:rank-order-unique:end

CREATE INDEX "activity_allocation_candidate_registration_revision_idx"
ON "ActivityAllocationCandidate" ("registrationId", "registrationRevisionId");

COMMIT;
