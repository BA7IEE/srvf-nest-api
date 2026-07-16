-- 活动岗位与时段 F1：纯加一张空表 + ActivityRegistration 一个 nullable FK 列。
-- 另含 2 FK(Restrict) + 6 普通索引 + 1 手写 partial unique；无回填、无数据删除、
-- 无 enum / seed / 既有列类型变化，既有报名 active partial unique 逐字不动。

-- AlterTable
ALTER TABLE "ActivityRegistration" ADD COLUMN     "activityPositionId" TEXT;

-- CreateTable
CREATE TABLE "activity_positions" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "activityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "attendanceRoleCode" TEXT NOT NULL,
    "capacity" INTEGER,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "genderRequirementCode" TEXT,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "activity_positions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_positions_activityId_idx" ON "activity_positions"("activityId");

-- CreateIndex
CREATE INDEX "activity_positions_attendanceRoleCode_idx" ON "activity_positions"("attendanceRoleCode");

-- CreateIndex
CREATE INDEX "activity_positions_deletedAt_idx" ON "activity_positions"("deletedAt");

-- CreateIndex
CREATE INDEX "activity_positions_createdAt_idx" ON "activity_positions"("createdAt");

-- CreateIndex
CREATE INDEX "activity_positions_sortOrder_idx" ON "activity_positions"("sortOrder");

-- CreateIndex
CREATE INDEX "ActivityRegistration_activityPositionId_idx" ON "ActivityRegistration"("activityPositionId");

-- AddForeignKey
ALTER TABLE "activity_positions" ADD CONSTRAINT "activity_positions_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityRegistration" ADD CONSTRAINT "ActivityRegistration_activityPositionId_fkey" FOREIGN KEY ("activityPositionId") REFERENCES "activity_positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma DSL 6.x 无法表达带 WHERE 的唯一索引；只约束同活动内未软删岗位名称。
CREATE UNIQUE INDEX "activity_positions_activity_name_active_unique"
ON "activity_positions" ("activityId", "name")
WHERE "deletedAt" IS NULL;
