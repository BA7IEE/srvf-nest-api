-- CreateEnum
CREATE TYPE "MembershipType" AS ENUM ('PRIMARY', 'SECONDARY', 'TEMPORARY', 'SUPPORT');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'ENDED', 'SUSPENDED');

-- CreateTable
CREATE TABLE "member_organization_memberships" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "membershipType" "MembershipType" NOT NULL DEFAULT 'PRIMARY',
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdByUserId" TEXT,
    "endedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "member_organization_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "member_organization_memberships_memberId_idx" ON "member_organization_memberships"("memberId");

-- CreateIndex
CREATE INDEX "member_organization_memberships_organizationId_idx" ON "member_organization_memberships"("organizationId");

-- CreateIndex
CREATE INDEX "member_organization_memberships_memberId_status_idx" ON "member_organization_memberships"("memberId", "status");

-- CreateIndex
CREATE INDEX "member_organization_memberships_deletedAt_idx" ON "member_organization_memberships"("deletedAt");

-- CreateIndex
CREATE INDEX "member_organization_memberships_createdAt_idx" ON "member_organization_memberships"("createdAt");

-- AddForeignKey
ALTER TABLE "member_organization_memberships" ADD CONSTRAINT "member_organization_memberships_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_organization_memberships" ADD CONSTRAINT "member_organization_memberships_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- 手写 partial unique index(Prisma DSL 至 6.x 不支持带 WHERE 的部分唯一索引;
-- 沿 MemberDepartment_memberId_active_key / contribution_rules_..._active_unique 已验证范式,
-- 枚举列与字面量比较 "status" = 'ACTIVE' 亦沿 contribution_rules 既有写法)。
-- 冻结稿 §3.1:
--   (a) 一人至多一个 active 主归属(只约束 PRIMARY = 旧"单部门"语义的升级);
--   (b) 同一(人, 组织, 类型)不重复 active(P2002 → MEMBERSHIP_ALREADY_EXISTS);
--       PRIMARY 行同时被 (a) 与 (b) 覆盖,SECONDARY/TEMPORARY/SUPPORT 可并存多条(仅受 (b) 约束)。
-- ============================================================================
CREATE UNIQUE INDEX "member_org_membership_primary_active_unique"
ON "member_organization_memberships" ("memberId")
WHERE "deletedAt" IS NULL AND "status" = 'ACTIVE' AND "membershipType" = 'PRIMARY';

CREATE UNIQUE INDEX "member_org_membership_active_unique"
ON "member_organization_memberships" ("memberId", "organizationId", "membershipType")
WHERE "deletedAt" IS NULL AND "status" = 'ACTIVE';

-- ============================================================================
-- 回填(冻结稿 §8.1):每条 active MemberDepartment → PRIMARY / ACTIVE membership。
--   - 复用旧 id(cuid,1:1 可追溯);
--   - startedAt = 源 createdAt(任期起 = 原归属生效时间);
--   - createdAt / updatedAt 原样保留(重指向后旧端点 findCurrent 返回的 createdAt/updatedAt
--     与迁移前逐字一致 = 行为锁);
--   - membershipType / status 用列默认值(PRIMARY / ACTIVE);endedAt/reason/*ByUserId/deletedAt NULL。
-- 旧 MemberDepartment_memberId_active_key 唯一约束保证 ≤1 active/member,故回填按构造 1:1、
-- 不可能撞新 PRIMARY partial unique(无 >1 active/member 脏数据);若存在脏数据则本 migration
-- 会因 (a) 唯一冲突而失败告警(fail-loud,优于静默污染)。
-- 已有库:一次回填全部现有 active 归属;全新库:MemberDepartment 为空 → 插 0 行
-- (seed 不建 Member,故 seed 阶段亦无归属可回填)。新表本 migration 内刚建、无并发写入,
-- INSERT 一次执行,无需 ON CONFLICT。
-- 自证:迁移后 count(active MemberDepartment) == count(active PRIMARY membership)。
-- ============================================================================
INSERT INTO "member_organization_memberships" (
    "id", "memberId", "organizationId", "startedAt", "createdAt", "updatedAt"
)
SELECT
    "id", "memberId", "organizationId", "createdAt", "createdAt", "updatedAt"
FROM "MemberDepartment"
WHERE "deletedAt" IS NULL;
