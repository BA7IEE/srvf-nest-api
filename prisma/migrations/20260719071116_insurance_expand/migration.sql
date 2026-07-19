-- D-INSURANCE v3 PR1:expand-only schema/default/backfill。
-- 兼容窗口内不启用审核、verified-only consumer、evidence 写入或 Team Join 保险闸；
-- exactly-one、kind 对齐、区间、同 member、全局单 owner 与 immutable 约束留给 PR4。

BEGIN;

-- AlterTable
ALTER TABLE "member_insurances"
ADD COLUMN "reviewStatusCode" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reviewedByUserId" TEXT,
ADD COLUMN "reviewedAt" TIMESTAMP(3);

-- 所有 legacy self（包含软删历史）统一 pending/v0/null reviewer；绝不猜测 verified。
-- insurance-expand:legacy-backfill:begin
UPDATE "member_insurances"
SET
  "reviewStatusCode" = 'pending',
  "version" = 0,
  "reviewedByUserId" = NULL,
  "reviewedAt" = NULL
WHERE
  "reviewStatusCode" <> 'pending'
  OR "version" <> 0
  OR "reviewedByUserId" IS NOT NULL
  OR "reviewedAt" IS NOT NULL;
-- insurance-expand:legacy-backfill:end

-- AlterTable
ALTER TABLE "team_join_cycles"
ADD COLUMN "requiresInsurance" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "insurance_eligibility_evidences" (
    "id" TEXT NOT NULL,
    "sourceKind" TEXT,
    "memberInsuranceId" TEXT,
    "teamInsuranceCoverageId" TEXT,
    "ownerKind" TEXT,
    "activityRegistrationId" TEXT,
    "teamJoinApplicationId" TEXT,
    "sourceRevision" INTEGER,
    "sourceReviewedByUserId" TEXT,
    "sourceReviewedAt" TIMESTAMP(3),
    "requiredFrom" TIMESTAMP(3),
    "requiredThrough" TIMESTAMP(3),
    "sourceCoverageStart" TIMESTAMP(3),
    "sourceCoverageEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insurance_eligibility_evidences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "member_insurances_reviewStatusCode_idx" ON "member_insurances"("reviewStatusCode");

-- CreateIndex
CREATE INDEX "member_insurances_reviewedByUserId_idx" ON "member_insurances"("reviewedByUserId");

-- CreateIndex
CREATE INDEX "insurance_eligibility_evidences_memberInsuranceId_idx" ON "insurance_eligibility_evidences"("memberInsuranceId");

-- CreateIndex
CREATE INDEX "insurance_eligibility_evidences_teamInsuranceCoverageId_idx" ON "insurance_eligibility_evidences"("teamInsuranceCoverageId");

-- CreateIndex
CREATE INDEX "insurance_eligibility_evidences_activityRegistrationId_idx" ON "insurance_eligibility_evidences"("activityRegistrationId");

-- CreateIndex
CREATE INDEX "insurance_eligibility_evidences_teamJoinApplicationId_idx" ON "insurance_eligibility_evidences"("teamJoinApplicationId");

-- CreateIndex
CREATE INDEX "insurance_eligibility_evidences_sourceReviewedByUserId_idx" ON "insurance_eligibility_evidences"("sourceReviewedByUserId");

-- CreateIndex
CREATE INDEX "insurance_eligibility_evidences_createdAt_idx" ON "insurance_eligibility_evidences"("createdAt");

-- AddForeignKey
ALTER TABLE "member_insurances" ADD CONSTRAINT "member_insurances_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_eligibility_evidences" ADD CONSTRAINT "insurance_eligibility_evidences_memberInsuranceId_fkey" FOREIGN KEY ("memberInsuranceId") REFERENCES "member_insurances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_eligibility_evidences" ADD CONSTRAINT "insurance_eligibility_evidences_teamInsuranceCoverageId_fkey" FOREIGN KEY ("teamInsuranceCoverageId") REFERENCES "team_insurance_coverages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_eligibility_evidences" ADD CONSTRAINT "insurance_eligibility_evidences_activityRegistrationId_fkey" FOREIGN KEY ("activityRegistrationId") REFERENCES "ActivityRegistration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_eligibility_evidences" ADD CONSTRAINT "insurance_eligibility_evidences_teamJoinApplicationId_fkey" FOREIGN KEY ("teamJoinApplicationId") REFERENCES "team_join_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_eligibility_evidences" ADD CONSTRAINT "insurance_eligibility_evidences_sourceReviewedByUserId_fkey" FOREIGN KEY ("sourceReviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
