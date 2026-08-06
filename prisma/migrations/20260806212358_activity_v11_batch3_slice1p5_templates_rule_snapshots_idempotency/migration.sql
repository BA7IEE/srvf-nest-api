-- 活动业务改造 v1.1 第 3 批①.5(D 档 schema 小刀):模板两表 + 幂等列补齐。
--
-- 骨架由隔离测试库上的 `prisma migrate diff --from-migrations ... --to-schema-datamodel`
-- 生成；其中两条与本刀无关的存量 RenameIndex 已逐字剥离，保留内容只来自本刀 schema。
--
-- 范围:两张净新空表、ActivityAllocationBatch.ruleSnapshotId 可空 FK、§10.3 闭集动作的
-- 可空幂等列及索引；零 seed / 零回填 / 零删数 / 零 DROP / RENAME / ALTER COLUMN。
--
-- ActivityTemplate.statusCode 的取值集尚未被合同定义:只存 String，不加 CHECK(缺口 #13)。

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "cancelRequestHash" TEXT,
ADD COLUMN     "terminateOperationKey" TEXT,
ADD COLUMN     "terminateRequestHash" TEXT;

-- AlterTable
ALTER TABLE "ActivityAllocationBatch" ADD COLUMN     "ruleSnapshotId" TEXT;

-- AlterTable
ALTER TABLE "activity_publish_reviews" ADD COLUMN     "operationKey" TEXT,
ADD COLUMN     "requestHash" TEXT,
ADD COLUMN     "reviewOperationKey" TEXT,
ADD COLUMN     "reviewRequestHash" TEXT;

-- CreateTable
CREATE TABLE "ActivityTemplate" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "activityTypeCode" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "defaultRegistrationModeCode" TEXT,
    "defaultLocationRequired" BOOLEAN,
    "defaultCheckInRadiusMeters" INTEGER,
    "checkInOpenOffsetMinutes" INTEGER,
    "checkInCloseOffsetMinutes" INTEGER,
    "checkOutOpenOffsetMinutes" INTEGER,
    "checkOutCloseOffsetMinutes" INTEGER,
    "defaultLateGraceMinutes" INTEGER,
    "defaultEarlyLeaveThresholdMinutes" INTEGER,
    "defaultArchiveWaitingDays" INTEGER,
    "commonPositionTemplates" JSONB,

    CONSTRAINT "ActivityTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityRuleSnapshot" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activityId" TEXT NOT NULL,
    "workflowRevision" INTEGER NOT NULL,
    "templateVersionId" TEXT NOT NULL,
    "resolvedConfig" JSONB NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "createdByReviewId" TEXT NOT NULL,

    CONSTRAINT "ActivityRuleSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityTemplate_activityTypeCode_idx" ON "ActivityTemplate"("activityTypeCode");

-- CreateIndex
CREATE INDEX "ActivityTemplate_statusCode_idx" ON "ActivityTemplate"("statusCode");

-- 模板按 (code, version) 版本化；同 code 的新版本合法、同版本重复不合法。
CREATE UNIQUE INDEX "ActivityTemplate_code_version_key" ON "ActivityTemplate"("code", "version");

-- CreateIndex
CREATE INDEX "ActivityRuleSnapshot_templateVersionId_idx" ON "ActivityRuleSnapshot"("templateVersionId");

-- 同活动同 workflow revision 的最终解析配置只能有一份。
CREATE UNIQUE INDEX "ActivityRuleSnapshot_activityId_workflowRevision_key" ON "ActivityRuleSnapshot"("activityId", "workflowRevision");

-- §10.3 取消:既有 key 原先没有 unique，补 hash 时一并把「operationKey 唯一」落入 DB。
CREATE UNIQUE INDEX "activity_cancel_operation_key_key" ON "Activity"("cancelOperationKey");

-- §10.3 提前终止:同 key 不能对应不同 payload。
CREATE UNIQUE INDEX "activity_terminate_operation_key_key" ON "Activity"("terminateOperationKey");

-- CreateIndex
CREATE INDEX "activity_allocation_batch_rule_snapshot_idx" ON "ActivityAllocationBatch"("ruleSnapshotId");

-- §10.3 发布提交:同活动可有多次提交，但每次 operationKey 全局唯一。
CREATE UNIQUE INDEX "activity_publish_review_operation_key_key" ON "activity_publish_reviews"("operationKey");

-- §10.3 审核通过／退回:同一审核动作 key 只能消费一次。
CREATE UNIQUE INDEX "activity_publish_review_review_operation_key_key" ON "activity_publish_reviews"("reviewOperationKey");

-- AddForeignKey
ALTER TABLE "ActivityRuleSnapshot" ADD CONSTRAINT "ActivityRuleSnapshot_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRuleSnapshot" ADD CONSTRAINT "ActivityRuleSnapshot_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "ActivityTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRuleSnapshot" ADD CONSTRAINT "ActivityRuleSnapshot_createdByReviewId_fkey" FOREIGN KEY ("createdByReviewId") REFERENCES "activity_publish_reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityAllocationBatch" ADD CONSTRAINT "ActivityAllocationBatch_ruleSnapshotId_fkey" FOREIGN KEY ("ruleSnapshotId") REFERENCES "ActivityRuleSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- §3.4:审核通过后的解析配置是不可变快照。DSL 只能描述列 / FK / 索引，
-- UPDATE / DELETE 的 DB 执行位必须用 trigger 落地。
--
-- ⚠️ 行级 trigger 不响应 TRUNCATE；test/setup/reset-db.ts 依赖 TRUNCATE ... CASCADE
-- 清库，故这条 trigger 不会堵死 e2e 地基。配套 spec 必须验证 INSERT 放行、
-- UPDATE 拒、DELETE 拒、TRUNCATE 放行且 trigger 仍存活四件事。
CREATE FUNCTION activity_rule_snapshot_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $activity_rule_snapshot_append_only$
BEGIN
  RAISE EXCEPTION 'activity rule snapshot is append-only'
    USING ERRCODE = '55000',
          CONSTRAINT = 'activity_rule_snapshot_append_only';
  RETURN NULL;
END;
$activity_rule_snapshot_append_only$;

CREATE TRIGGER trg_activity_rule_snapshot_10_append_only
BEFORE UPDATE OR DELETE ON "ActivityRuleSnapshot"
FOR EACH ROW EXECUTE FUNCTION activity_rule_snapshot_append_only_guard();
