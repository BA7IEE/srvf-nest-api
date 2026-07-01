-- 终态 scoped-authz PR4「任职」(2026-07-01 goal;冻结稿 §3.4 / §7.3 / §4.3 / R2 / §11 PR4)。
-- 纯加一空表 + 一枚举 + 索引 + 3 FK(Restrict)+ 末尾手写 1 partial unique:无回填、无不可逆。
-- 单人独占(position.allowMultiple=false)由 service 层按 position 属性判(allowMultiple 在 position 上、
-- 无法直接进部分索引);此处 partial unique 只做"同人同组织同职务不重复 active"防重底线
-- (P2002 → ASSIGNMENT_ALREADY_EXISTS)。任职历史 = 软删行 + ENDED/REVOKED 行全保留,可追溯。
-- **本表 = 数据 + 任命校验:绝不被任何判权路径读**(判权是 PR8;RoleBinding 是 PR6)。

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('ACTIVE', 'ENDED', 'REVOKED');

-- CreateTable
CREATE TABLE "organization_position_assignments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "appointedByUserId" TEXT,
    "revokedByUserId" TEXT,
    "appointmentSource" TEXT,
    "isConcurrent" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "organization_position_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organization_position_assignments_organizationId_idx" ON "organization_position_assignments"("organizationId");

-- CreateIndex
CREATE INDEX "organization_position_assignments_positionId_idx" ON "organization_position_assignments"("positionId");

-- CreateIndex
CREATE INDEX "organization_position_assignments_memberId_idx" ON "organization_position_assignments"("memberId");

-- CreateIndex
CREATE INDEX "organization_position_assignments_organizationId_status_idx" ON "organization_position_assignments"("organizationId", "status");

-- CreateIndex
CREATE INDEX "organization_position_assignments_status_idx" ON "organization_position_assignments"("status");

-- CreateIndex
CREATE INDEX "organization_position_assignments_deletedAt_idx" ON "organization_position_assignments"("deletedAt");

-- AddForeignKey
ALTER TABLE "organization_position_assignments" ADD CONSTRAINT "organization_position_assignments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_position_assignments" ADD CONSTRAINT "organization_position_assignments_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "organization_positions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_position_assignments" ADD CONSTRAINT "organization_position_assignments_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 手写 partial unique index(Prisma DSL 至 6.x 不支持带 WHERE 的部分唯一索引;
-- 沿 member_org_membership_active_unique / activity_registrations_*_active_unique 范式)。
-- 同人同组织同职务至多一条 active(P2002 → ASSIGNMENT_ALREADY_EXISTS,32020)。
CREATE UNIQUE INDEX "organization_position_assignments_active_unique"
ON "organization_position_assignments"("organizationId", "positionId", "memberId")
WHERE "deletedAt" IS NULL AND "status" = 'ACTIVE';
