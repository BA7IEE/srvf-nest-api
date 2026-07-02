-- 终态 scoped-authz PR7「职务→角色 policy」(2026-07-01 goal;冻结稿 §3.7 / §11 PR7)。
-- 纯加一空表 + 一枚举 + 索引 + 唯一约束 + 2 FK(Restrict):无回填、无不可逆、无 partial unique
-- (positionId,roleId 为普通唯一,Prisma DSL 直生成;3 管理角色 + 3 条默认 policy 由 prisma/seed.ts
--  幂等 upsert,不落 migration)。**本刀纯配置映射,绝不被任何判权路径读**(消费方是 PR8 AuthzService)。

-- CreateEnum
CREATE TYPE "PolicyScopeMode" AS ENUM ('EXACT', 'TREE');

-- CreateTable
CREATE TABLE "organization_position_role_policies" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "scopeMode" "PolicyScopeMode" NOT NULL DEFAULT 'TREE',
    "conditionJson" JSONB,
    "status" "PolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "organization_position_role_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_position_role_policies_positionId_idx" ON "organization_position_role_policies"("positionId");

-- CreateIndex
CREATE INDEX "organization_position_role_policies_roleId_idx" ON "organization_position_role_policies"("roleId");

-- CreateIndex
CREATE INDEX "organization_position_role_policies_deletedAt_idx" ON "organization_position_role_policies"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "organization_position_role_policies_positionId_roleId_key" ON "organization_position_role_policies"("positionId", "roleId");

-- AddForeignKey
ALTER TABLE "organization_position_role_policies" ADD CONSTRAINT "organization_position_role_policies_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "organization_positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_position_role_policies" ADD CONSTRAINT "organization_position_role_policies_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
