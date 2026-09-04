-- Activity OS R2 / B6 D1：专业 / 紧急创建的数据地基（第 109 条 migration）。
--
-- 纯 additive：新增三张空表、受控词表 CHECK、同活动复合外键、唯一锚点与查询索引；
-- 零回填、零 DML、零 rename、零删除。既有 Activity 与既有 A6 快速创建字段完全不动。
-- D1 不创建 API、DTO、通知、审计、发布行为或事故域；AI 不执行生产 migration。

BEGIN;

CREATE TABLE "ActivityCreationCommandReceipt" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorUserId" TEXT NOT NULL,
  "commandCode" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,

  CONSTRAINT "ActivityCreationCommandReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityEmergencyInitiation" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activityId" TEXT NOT NULL,
  "creationReceiptId" TEXT NOT NULL,
  "callQueuedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ActivityEmergencyInitiation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ActivityEmergencyFollowUpItem" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "emergencyInitiationId" TEXT NOT NULL,
  "itemCode" TEXT NOT NULL,
  "statusCode" TEXT NOT NULL DEFAULT 'pending',
  "resolvedAt" TIMESTAMP(3),
  "resolvedByUserId" TEXT,

  CONSTRAINT "ActivityEmergencyFollowUpItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "activity_creation_command_receipt_activity_id_key"
  ON "ActivityCreationCommandReceipt"("activityId");
CREATE UNIQUE INDEX "activity_creation_command_receipt_actor_command_key"
  ON "ActivityCreationCommandReceipt"("actorUserId", "commandCode", "operationKey");
CREATE UNIQUE INDEX "activity_creation_command_receipt_id_activity_key"
  ON "ActivityCreationCommandReceipt"("id", "activityId");
CREATE INDEX "activity_creation_command_receipt_actor_created_idx"
  ON "ActivityCreationCommandReceipt"("actorUserId", "createdAt");

CREATE UNIQUE INDEX "activity_emergency_initiation_activity_id_key"
  ON "ActivityEmergencyInitiation"("activityId");
CREATE UNIQUE INDEX "activity_emergency_initiation_receipt_id_key"
  ON "ActivityEmergencyInitiation"("creationReceiptId");
CREATE UNIQUE INDEX "activity_emergency_initiation_receipt_activity_key"
  ON "ActivityEmergencyInitiation"("creationReceiptId", "activityId");

CREATE UNIQUE INDEX "activity_emergency_follow_up_item_initiation_code_key"
  ON "ActivityEmergencyFollowUpItem"("emergencyInitiationId", "itemCode");
CREATE INDEX "activity_emergency_follow_up_item_status_idx"
  ON "ActivityEmergencyFollowUpItem"("statusCode");

ALTER TABLE "ActivityCreationCommandReceipt"
  ADD CONSTRAINT "activity_creation_command_receipt_command_code_check"
  CHECK ("commandCode" IN ('create_professional', 'create_emergency'));

ALTER TABLE "ActivityEmergencyFollowUpItem"
  ADD CONSTRAINT "activity_emergency_follow_up_item_code_check"
  CHECK ("itemCode" IN (
    'session',
    'position',
    'detailed_location',
    'equipment',
    'attendance',
    'outcome',
    'incident_relation'
  ));

ALTER TABLE "ActivityEmergencyFollowUpItem"
  ADD CONSTRAINT "activity_emergency_follow_up_item_status_check"
  CHECK ("statusCode" IN ('pending', 'verified', 'unrepresentable'));

-- 非法状态先由独立词表 CHECK 唯一拒绝；合法状态的两支均由 IS NULL / IS NOT NULL 组成，
-- 避免 SQL 三值逻辑让半填的处理事实静默通过，也避免同一非法值被两条 CHECK 模糊归因。
ALTER TABLE "ActivityEmergencyFollowUpItem"
  ADD CONSTRAINT "activity_emergency_follow_up_item_resolution_shape_check"
  CHECK (
    "statusCode" NOT IN ('pending', 'verified', 'unrepresentable')
    OR
    (
      "statusCode" = 'pending'
      AND "resolvedAt" IS NULL
      AND "resolvedByUserId" IS NULL
    )
    OR
    (
      "statusCode" IN ('verified', 'unrepresentable')
      AND "resolvedAt" IS NOT NULL
      AND "resolvedByUserId" IS NOT NULL
    )
  );

ALTER TABLE "ActivityCreationCommandReceipt"
  ADD CONSTRAINT "activity_creation_command_receipt_activity_fkey"
  FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ActivityCreationCommandReceipt"
  ADD CONSTRAINT "activity_creation_command_receipt_actor_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivityEmergencyInitiation"
  ADD CONSTRAINT "activity_emergency_initiation_activity_fkey"
  FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ActivityEmergencyInitiation"
  ADD CONSTRAINT "activity_emergency_initiation_receipt_activity_fkey"
  FOREIGN KEY ("creationReceiptId", "activityId")
  REFERENCES "ActivityCreationCommandReceipt"("id", "activityId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ActivityEmergencyFollowUpItem"
  ADD CONSTRAINT "activity_emergency_follow_up_item_initiation_fkey"
  FOREIGN KEY ("emergencyInitiationId") REFERENCES "ActivityEmergencyInitiation"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ActivityEmergencyFollowUpItem"
  ADD CONSTRAINT "activity_emergency_follow_up_item_resolved_by_fkey"
  FOREIGN KEY ("resolvedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

COMMIT;
