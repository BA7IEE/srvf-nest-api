-- ============================================================================
-- V2 第一阶段批次 4-A:contribution_rules + AttendanceSheet 终审字段
-- ----------------------------------------------------------------------------
-- 详见:
--   docs/批次4_贡献值业务规则_schema草案评审决议表.md v1.0
--   docs/批次4_贡献值业务规则_字典扩展决议表.md v1.0
--
-- 改动范围:
-- 1. 新增 enum ContributionRuleStatus(ACTIVE / INACTIVE,沿 v0.4.0 风格)
-- 2. 新增 ContributionRule 表(D14 5.B 预填规则承载)+ 审计字段 + 6 索引
-- 3. AttendanceSheet 加 3 字段(finalReviewer*,D5 候选 B 终审)+ 1 索引 + 1 FK
-- 4. 末尾追加 partial unique index "contribution_rules_active_unique"
--    (Prisma DSL 至 6.x 不支持 @@unique 内表达 WHERE 子句的部分唯一约束,
--     沿 v0.2.0 MemberDepartment / v0.4.0 ActivityRegistration 范式手动追加)
-- ============================================================================

-- CreateEnum
CREATE TYPE "ContributionRuleStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "AttendanceSheet" ADD COLUMN     "finalReviewNote" TEXT,
ADD COLUMN     "finalReviewedAt" TIMESTAMP(3),
ADD COLUMN     "finalReviewerUserId" TEXT;

-- CreateTable
CREATE TABLE "ContributionRule" (
    "id" TEXT NOT NULL,
    "activityTypeCode" TEXT NOT NULL,
    "attendanceRoleCode" TEXT NOT NULL,
    "durationThreshold" DECIMAL(5,2),
    "pointsBelow" DECIMAL(5,2) NOT NULL,
    "pointsAbove" DECIMAL(5,2),
    "dailyCap" DECIMAL(5,2),
    "status" "ContributionRuleStatus" NOT NULL DEFAULT 'ACTIVE',
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "deletedByUserId" TEXT,

    CONSTRAINT "ContributionRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContributionRule_activityTypeCode_idx" ON "ContributionRule"("activityTypeCode");

-- CreateIndex
CREATE INDEX "ContributionRule_attendanceRoleCode_idx" ON "ContributionRule"("attendanceRoleCode");

-- CreateIndex
CREATE INDEX "ContributionRule_activityTypeCode_attendanceRoleCode_idx" ON "ContributionRule"("activityTypeCode", "attendanceRoleCode");

-- CreateIndex
CREATE INDEX "ContributionRule_status_idx" ON "ContributionRule"("status");

-- CreateIndex
CREATE INDEX "ContributionRule_deletedAt_idx" ON "ContributionRule"("deletedAt");

-- CreateIndex
CREATE INDEX "ContributionRule_createdAt_idx" ON "ContributionRule"("createdAt");

-- CreateIndex
CREATE INDEX "AttendanceSheet_finalReviewerUserId_idx" ON "AttendanceSheet"("finalReviewerUserId");

-- AddForeignKey
ALTER TABLE "AttendanceSheet" ADD CONSTRAINT "AttendanceSheet_finalReviewerUserId_fkey" FOREIGN KEY ("finalReviewerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionRule" ADD CONSTRAINT "ContributionRule_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionRule" ADD CONSTRAINT "ContributionRule_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributionRule" ADD CONSTRAINT "ContributionRule_deletedByUserId_fkey" FOREIGN KEY ("deletedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 手动追加: ContributionRule 唯一约束 partial unique index (D-D5 / D-S4)
-- ----------------------------------------------------------------------------
-- 同 (activityTypeCode, attendanceRoleCode, durationThreshold) 在 deletedAt IS NULL
-- AND status = 'ACTIVE' 范围内最多 1 条规则;软删或停用记录不参与唯一性判定。
--
-- Prisma DSL 至 6.x 不支持在 @@unique 中表达 WHERE 子句的部分唯一约束,故
-- schema.prisma 中仅声明普通 @@index([activityTypeCode, attendanceRoleCode]),
-- 由本 migration 末尾手动追加 partial unique index 落地业务约束。
--
-- 注意 PostgreSQL 中 NULL 在唯一索引内的特殊行为:durationThreshold 为 NULL 时
-- 在多列唯一索引里两条 NULL 不视为相等,可能允许多条 (typeCode, roleCode, NULL)
-- 并存。沿 batch 3 ActivityRegistration partial unique 既有处理:由业务层
-- 兜底校验"无档位规则唯一性"(运营后台维护时由人工把关 + service 查表预填取
-- 最早一条)。本批次不通过 COALESCE 转换 NULL 为占位值,避免引入魔术值。
--
-- 沿 v0.2.0 MemberDepartment / v0.4.0 ActivityRegistration 范式;详见
-- prisma/migrations/20260507181930_v2_foundation/migration.sql 与
-- prisma/migrations/20260510193742_v2_batch3_activities_attendances/migration.sql。
-- ============================================================================

CREATE UNIQUE INDEX "contribution_rules_activity_role_threshold_active_unique"
ON "ContributionRule" ("activityTypeCode", "attendanceRoleCode", "durationThreshold")
WHERE "deletedAt" IS NULL AND "status" = 'ACTIVE';
