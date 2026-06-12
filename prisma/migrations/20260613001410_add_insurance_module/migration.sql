-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "requiresInsurance" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "member_insurances" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "memberId" TEXT NOT NULL,
    "insurerName" TEXT NOT NULL,
    "policyNumber" TEXT NOT NULL,
    "coverageStart" TIMESTAMP(3),
    "coverageEnd" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_insurances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_insurance_policies" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "insurerName" TEXT NOT NULL,
    "policyNumber" TEXT NOT NULL,
    "coverageStart" TIMESTAMP(3) NOT NULL,
    "coverageEnd" TIMESTAMP(3) NOT NULL,
    "note" TEXT,

    CONSTRAINT "team_insurance_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_insurance_coverages" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "policyId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,

    CONSTRAINT "team_insurance_coverages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "member_insurances_memberId_idx" ON "member_insurances"("memberId");

-- CreateIndex
CREATE INDEX "member_insurances_coverageEnd_idx" ON "member_insurances"("coverageEnd");

-- CreateIndex
CREATE INDEX "member_insurances_deletedAt_idx" ON "member_insurances"("deletedAt");

-- CreateIndex
CREATE INDEX "member_insurances_createdAt_idx" ON "member_insurances"("createdAt");

-- CreateIndex
CREATE INDEX "team_insurance_policies_coverageEnd_idx" ON "team_insurance_policies"("coverageEnd");

-- CreateIndex
CREATE INDEX "team_insurance_policies_deletedAt_idx" ON "team_insurance_policies"("deletedAt");

-- CreateIndex
CREATE INDEX "team_insurance_policies_createdAt_idx" ON "team_insurance_policies"("createdAt");

-- CreateIndex
CREATE INDEX "team_insurance_coverages_policyId_idx" ON "team_insurance_coverages"("policyId");

-- CreateIndex
CREATE INDEX "team_insurance_coverages_memberId_idx" ON "team_insurance_coverages"("memberId");

-- CreateIndex
CREATE INDEX "team_insurance_coverages_deletedAt_idx" ON "team_insurance_coverages"("deletedAt");

-- CreateIndex
CREATE INDEX "team_insurance_coverages_createdAt_idx" ON "team_insurance_coverages"("createdAt");

-- AddForeignKey
ALTER TABLE "member_insurances" ADD CONSTRAINT "member_insurances_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_insurance_coverages" ADD CONSTRAINT "team_insurance_coverages_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "team_insurance_policies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_insurance_coverages" ADD CONSTRAINT "team_insurance_coverages_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================
-- 手动追加:覆盖名单 partial unique(沿 ActivityRegistration / MemberDepartment 范式)
-- Prisma DSL 至 6.x 不支持 @@unique 内表达带 WHERE 的 partial unique index。
-- 语义:同一队保单内同一队员仅一条"活跃"覆盖行;软删(移除)后允许重新加入;
-- service 层 P2002 兜底转 BizCode 26004(评审稿 insurance-module-review.md E-3/E-16)。
-- =============================================================================
CREATE UNIQUE INDEX "team_insurance_coverages_policy_member_active_unique"
ON "team_insurance_coverages" ("policyId", "memberId")
WHERE "deletedAt" IS NULL;
