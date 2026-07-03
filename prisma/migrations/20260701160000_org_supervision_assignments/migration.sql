-- 终态 scoped-authz PR5「分管」(2026-07-01 goal;冻结稿 §3.5 / §7.4 / §4.3 / §11 PR5)。
-- 纯加一空表 + 2 枚举 + 4 索引 + 2 FK(Restrict)+ 末尾手写 1 partial unique:无回填、无不可逆。
-- 分管 = 与职务(§3.4 assignment)**正交**的独立范围监督关系(副队长乙分管 SECT、SSD = 两行,与其「副队长」职务互不为前提)。
-- 此处 partial unique 做「同人对同组织不重复 active」防重底线(P2002 → SUPERVISION_ALREADY_EXISTS,33002)。
-- 分管历史 = 软删行 + ENDED/REVOKED 行全保留,可追溯。
-- **本表 = 数据 + 展示:绝不被任何判权路径读**(判权是 PR8 才把分管推导成只读监督 scope;RoleBinding 是 PR6)。

-- CreateEnum
CREATE TYPE "SupervisionScopeMode" AS ENUM ('EXACT', 'TREE');

-- CreateEnum
CREATE TYPE "SupervisionStatus" AS ENUM ('ACTIVE', 'ENDED', 'REVOKED');

-- CreateTable
CREATE TABLE "organization_supervision_assignments" (
    "id" TEXT NOT NULL,
    "supervisorMemberId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "scopeMode" "SupervisionScopeMode" NOT NULL DEFAULT 'TREE',
    "status" "SupervisionStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "appointedByUserId" TEXT,
    "revokedByUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "organization_supervision_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_supervision_assignments_supervisorMemberId_idx" ON "organization_supervision_assignments"("supervisorMemberId");

-- CreateIndex
CREATE INDEX "organization_supervision_assignments_organizationId_idx" ON "organization_supervision_assignments"("organizationId");

-- CreateIndex
CREATE INDEX "organization_supervision_assignments_supervisorMemberId_sta_idx" ON "organization_supervision_assignments"("supervisorMemberId", "status");

-- CreateIndex
CREATE INDEX "organization_supervision_assignments_deletedAt_idx" ON "organization_supervision_assignments"("deletedAt");

-- AddForeignKey
ALTER TABLE "organization_supervision_assignments" ADD CONSTRAINT "organization_supervision_assignments_supervisorMemberId_fkey" FOREIGN KEY ("supervisorMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_supervision_assignments" ADD CONSTRAINT "organization_supervision_assignments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 手写 partial unique index(Prisma DSL 至 6.x 不支持带 WHERE 的部分唯一索引;
-- 沿 organization_position_assignments_active_unique / member_org_membership_active_unique 范式)。
-- 同人对同组织至多一条 active 分管(P2002 → SUPERVISION_ALREADY_EXISTS,33002)。
CREATE UNIQUE INDEX "organization_supervision_assignments_active_unique"
ON "organization_supervision_assignments"("supervisorMemberId", "organizationId")
WHERE "deletedAt" IS NULL AND "status" = 'ACTIVE';
