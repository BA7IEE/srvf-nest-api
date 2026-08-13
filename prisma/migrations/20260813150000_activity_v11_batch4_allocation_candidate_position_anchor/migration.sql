-- 活动业务改造 v1.1 第 4 批⑮（D87）：候补队列按场次岗位锚定。
--
-- 纯 DDL、单事务。ActivityAllocationCandidate 尚无生产 writer；新增的 activityId /
-- sessionId 是必填列，不能猜旧事实或做业务回填，因此只接受 Candidate 空表。

BEGIN;

-- 固定父→子锁序。锁住 referenced roots 后再锁 Candidate，保证 count-only preflight
-- 与后续 NOT NULL / FK / 索引替换之间没有 writer 窗口。
LOCK TABLE "Activity" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivitySession" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivitySessionPosition" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivityAllocationBatch" IN ACCESS EXCLUSIVE MODE;
LOCK TABLE "ActivityAllocationCandidate" IN ACCESS EXCLUSIVE MODE;

-- 必须位于任何 DDL 前；只报告计数，不泄露业务 id，不猜、不回填。
DO $allocation_d87_preflight$
DECLARE
  candidate_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO candidate_count FROM "ActivityAllocationCandidate";

  IF candidate_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'activity allocation candidate position anchor guard: candidate table must be empty (candidates=%s)',
        candidate_count
      );
  END IF;
END
$allocation_d87_preflight$;

ALTER TABLE "ActivityAllocationCandidate"
  ADD COLUMN "activityId" TEXT NOT NULL,
  ADD COLUMN "sessionId" TEXT NOT NULL,
  ADD COLUMN "waitlistPositionId" TEXT;

-- 单列 batch FK 无法证明 Candidate 的活动/场次与 Batch 同锚；D86 已提供完全同序的
-- (id, activityId, sessionId) unique，本刀改成完整复合 FK。
ALTER TABLE "ActivityAllocationCandidate"
  DROP CONSTRAINT "ActivityAllocationCandidate_allocationBatchId_fkey";

-- allocation-d87:batch-anchor:begin
ALTER TABLE "ActivityAllocationCandidate"
  ADD CONSTRAINT "activity_allocation_candidate_batch_anchor_fkey"
  FOREIGN KEY ("allocationBatchId", "activityId", "sessionId")
  REFERENCES "ActivityAllocationBatch" ("id", "activityId", "sessionId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- allocation-d87:batch-anchor:end

-- allocation-d87:position-anchor:begin
ALTER TABLE "ActivityAllocationCandidate"
  ADD CONSTRAINT "activity_allocation_candidate_waitlist_position_fkey"
  FOREIGN KEY ("activityId", "sessionId", "waitlistPositionId")
  REFERENCES "ActivitySessionPosition" ("activityId", "sessionId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- allocation-d87:position-anchor:end

-- D85 的旧 CHECK 只闭合 result/rank；D87 将候补岗位纳入同一两值逻辑闭集。
-- 外层 resultCode IS NOT NULL 守卫防止 NULL 比较把非法 preparing 残留塌成
-- PostgreSQL CHECK 会放行的 UNKNOWN。
-- allocation-d87:result-shape:begin
ALTER TABLE "ActivityAllocationCandidate"
  DROP CONSTRAINT "activity_allocation_candidate_result_rank_shape_check",
  ADD CONSTRAINT "activity_allocation_candidate_result_rank_shape_check"
  CHECK (
    ("resultCode" IS NULL
      AND "waitlistRank" IS NULL
      AND "waitlistPositionId" IS NULL)
    OR
    ("resultCode" IS NOT NULL AND (
      ("resultCode" IN ('allocated', 'not_selected')
        AND "waitlistRank" IS NULL
        AND "waitlistPositionId" IS NULL)
      OR
      ("resultCode" = 'waitlisted'
        AND "waitlistRank" IS NOT NULL
        AND "waitlistPositionId" IS NOT NULL)
    ))
  );
-- allocation-d87:result-shape:end

-- 保留 lotteryOrder 与 tieBreakKey 的全 batch 不变量；只把候补 rank 改为按岗位分区。
-- 变异测试会刻意保留旧全 batch unique，证明同 batch 两岗位各 rank=1 会被错误拒绝。
-- allocation-d87:old-global-waitlist-unique-drop:begin
DROP INDEX "activity_allocation_candidate_batch_waitlist_rank_unique";
-- allocation-d87:old-global-waitlist-unique-drop:end

CREATE UNIQUE INDEX "activity_allocation_candidate_batch_position_rank_unique"
ON "ActivityAllocationCandidate" ("allocationBatchId", "waitlistPositionId", "waitlistRank")
WHERE "waitlistRank" IS NOT NULL;

DROP INDEX "activity_allocation_candidate_batch_rank_idx";

CREATE INDEX "activity_allocation_candidate_batch_position_rank_idx"
ON "ActivityAllocationCandidate" ("allocationBatchId", "waitlistPositionId", "waitlistRank");

COMMIT;
