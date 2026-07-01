-- 终态 scoped-authz PR3「职务定义」(2026-07-01 goal;冻结稿 §3.2 / §3.3 / §11 PR3)。
-- 纯加两空表 + 两枚举 + 索引 + 唯一约束 + FK(Restrict):无回填、无不可逆、无 partial unique
-- (code / (nodeTypeCode, positionId) 均为普通唯一,Prisma DSL 直生成;6 领导职务 + 30 规则由
--  prisma/seed.ts 幂等 upsert,不落 migration)。**本刀纯配置定义,绝不被任何判权路径读**
-- (assignment=PR4 / policy=PR7 / authz=PR8)。

-- CreateEnum
CREATE TYPE "PositionCategory" AS ENUM ('LEADER', 'DEPUTY', 'STAFF');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "organization_positions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryCode" "PositionCategory" NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "isLeadership" BOOLEAN NOT NULL DEFAULT false,
    "allowMultiple" BOOLEAN NOT NULL DEFAULT false,
    "allowConcurrent" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "PolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "organization_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_position_rules" (
    "id" TEXT NOT NULL,
    "nodeTypeCode" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "minCount" INTEGER,
    "maxCount" INTEGER,
    "requireMembership" BOOLEAN NOT NULL DEFAULT true,
    "allowConcurrent" BOOLEAN NOT NULL DEFAULT true,
    "status" "PolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "organization_position_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_positions_code_key" ON "organization_positions"("code");

-- CreateIndex
CREATE INDEX "organization_positions_categoryCode_idx" ON "organization_positions"("categoryCode");

-- CreateIndex
CREATE INDEX "organization_positions_status_idx" ON "organization_positions"("status");

-- CreateIndex
CREATE INDEX "organization_positions_deletedAt_idx" ON "organization_positions"("deletedAt");

-- CreateIndex
CREATE INDEX "organization_position_rules_positionId_idx" ON "organization_position_rules"("positionId");

-- CreateIndex
CREATE INDEX "organization_position_rules_deletedAt_idx" ON "organization_position_rules"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "organization_position_rules_nodeTypeCode_positionId_key" ON "organization_position_rules"("nodeTypeCode", "positionId");

-- AddForeignKey
ALTER TABLE "organization_position_rules" ADD CONSTRAINT "organization_position_rules_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "organization_positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
