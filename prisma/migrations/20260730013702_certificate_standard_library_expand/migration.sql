-- CreateEnum
CREATE TYPE "CertificateStandardKind" AS ENUM ('FAMILY', 'CREDENTIAL');

-- CreateEnum
CREATE TYPE "CertificateStandardStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "CertificateRecognitionPolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "CertificateIssuerPolicy" AS ENUM ('FIXED', 'ALLOWLIST', 'FREE_TEXT');

-- CreateEnum
CREATE TYPE "CertificateValidityMode" AS ENUM ('PERMANENT', 'FIXED_MONTHS', 'EXPLICIT_REQUIRED', 'EXPLICIT_OPTIONAL');

-- CreateEnum
CREATE TYPE "CertificateNumberMode" AS ENUM ('REQUIRED', 'OPTIONAL', 'NONE');

-- CreateEnum
CREATE TYPE "CertificateSource" AS ENUM ('ADMIN', 'RECRUITMENT');

-- CreateEnum
CREATE TYPE "RecruitmentCertificateClaimStatus" AS ENUM ('SUBMITTED', 'NEEDS_INFO', 'APPROVED', 'REJECTED', 'PROMOTED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "Certificate" ADD COLUMN     "recognitionIssuerId" TEXT,
ADD COLUMN     "recognitionPolicyId" TEXT,
ADD COLUMN     "sourceClaimId" TEXT,
ADD COLUMN     "sourceCode" "CertificateSource",
ADD COLUMN     "standardId" TEXT;

-- CreateTable
CREATE TABLE "CertificateStandard" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" "CertificateStandardKind" NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "levelCode" TEXT,
    "parentId" TEXT,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "status" "CertificateStandardStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "activatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CertificateStandard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CertificateRecognitionPolicy" (
    "id" TEXT NOT NULL,
    "standardId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "CertificateRecognitionPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "issuerPolicy" "CertificateIssuerPolicy" NOT NULL,
    "validityMode" "CertificateValidityMode" NOT NULL,
    "validityMonths" INTEGER,
    "certNumberMode" "CertificateNumberMode" NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CertificateRecognitionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CertificateRecognitionIssuer" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CertificateRecognitionIssuer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentCertificateClaim" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "status" "RecruitmentCertificateClaimStatus" NOT NULL DEFAULT 'SUBMITTED',
    "categoryHintCode" TEXT NOT NULL,
    "rawCertificateName" TEXT,
    "suggestedStandardId" TEXT,
    "standardId" TEXT,
    "recognitionPolicyId" TEXT,
    "recognitionIssuerId" TEXT,
    "issuingOrg" TEXT,
    "certNumber" TEXT,
    "issuedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "imageKeys" JSONB,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "promotedAt" TIMESTAMP(3),
    "sensitivePurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RecruitmentCertificateClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CertificateStandard_code_key" ON "CertificateStandard"("code");

-- CreateIndex
CREATE INDEX "CertificateStandard_kind_idx" ON "CertificateStandard"("kind");

-- CreateIndex
CREATE INDEX "CertificateStandard_categoryCode_idx" ON "CertificateStandard"("categoryCode");

-- CreateIndex
CREATE INDEX "CertificateStandard_levelCode_idx" ON "CertificateStandard"("levelCode");

-- CreateIndex
CREATE INDEX "CertificateStandard_parentId_idx" ON "CertificateStandard"("parentId");

-- CreateIndex
CREATE INDEX "CertificateStandard_status_idx" ON "CertificateStandard"("status");

-- CreateIndex
CREATE INDEX "CertificateStandard_sortOrder_idx" ON "CertificateStandard"("sortOrder");

-- CreateIndex
CREATE INDEX "CertificateStandard_deletedAt_idx" ON "CertificateStandard"("deletedAt");

-- CreateIndex
CREATE INDEX "CertificateStandard_createdAt_idx" ON "CertificateStandard"("createdAt");

-- CreateIndex
CREATE INDEX "CertificateRecognitionPolicy_standardId_idx" ON "CertificateRecognitionPolicy"("standardId");

-- CreateIndex
CREATE INDEX "CertificateRecognitionPolicy_status_idx" ON "CertificateRecognitionPolicy"("status");

-- CreateIndex
CREATE INDEX "CertificateRecognitionPolicy_deletedAt_idx" ON "CertificateRecognitionPolicy"("deletedAt");

-- CreateIndex
CREATE INDEX "CertificateRecognitionPolicy_createdAt_idx" ON "CertificateRecognitionPolicy"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CertificateRecognitionPolicy_standardId_version_key" ON "CertificateRecognitionPolicy"("standardId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "CertificateRecognitionPolicy_id_standardId_key" ON "CertificateRecognitionPolicy"("id", "standardId");

-- CreateIndex
CREATE INDEX "CertificateRecognitionIssuer_policyId_idx" ON "CertificateRecognitionIssuer"("policyId");

-- CreateIndex
CREATE INDEX "CertificateRecognitionIssuer_sortOrder_idx" ON "CertificateRecognitionIssuer"("sortOrder");

-- CreateIndex
CREATE INDEX "CertificateRecognitionIssuer_deletedAt_idx" ON "CertificateRecognitionIssuer"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CertificateRecognitionIssuer_id_policyId_key" ON "CertificateRecognitionIssuer"("id", "policyId");

-- CreateIndex
CREATE INDEX "RecruitmentCertificateClaim_applicationId_idx" ON "RecruitmentCertificateClaim"("applicationId");

-- CreateIndex
CREATE INDEX "RecruitmentCertificateClaim_status_idx" ON "RecruitmentCertificateClaim"("status");

-- CreateIndex
CREATE INDEX "RecruitmentCertificateClaim_standardId_idx" ON "RecruitmentCertificateClaim"("standardId");

-- CreateIndex
CREATE INDEX "RecruitmentCertificateClaim_recognitionPolicyId_idx" ON "RecruitmentCertificateClaim"("recognitionPolicyId");

-- CreateIndex
CREATE INDEX "RecruitmentCertificateClaim_deletedAt_idx" ON "RecruitmentCertificateClaim"("deletedAt");

-- CreateIndex
CREATE INDEX "RecruitmentCertificateClaim_createdAt_idx" ON "RecruitmentCertificateClaim"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_sourceClaimId_key" ON "Certificate"("sourceClaimId");

-- CreateIndex
CREATE INDEX "Certificate_standardId_idx" ON "Certificate"("standardId");

-- CreateIndex
CREATE INDEX "Certificate_recognitionPolicyId_idx" ON "Certificate"("recognitionPolicyId");

-- CreateIndex
CREATE INDEX "Certificate_sourceCode_idx" ON "Certificate"("sourceCode");

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "CertificateStandard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_recognitionPolicyId_standardId_fkey" FOREIGN KEY ("recognitionPolicyId", "standardId") REFERENCES "CertificateRecognitionPolicy"("id", "standardId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_recognitionIssuerId_recognitionPolicyId_fkey" FOREIGN KEY ("recognitionIssuerId", "recognitionPolicyId") REFERENCES "CertificateRecognitionIssuer"("id", "policyId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_sourceClaimId_fkey" FOREIGN KEY ("sourceClaimId") REFERENCES "RecruitmentCertificateClaim"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CertificateStandard" ADD CONSTRAINT "CertificateStandard_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CertificateStandard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CertificateRecognitionPolicy" ADD CONSTRAINT "CertificateRecognitionPolicy_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "CertificateStandard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CertificateRecognitionIssuer" ADD CONSTRAINT "CertificateRecognitionIssuer_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "CertificateRecognitionPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentCertificateClaim" ADD CONSTRAINT "RecruitmentCertificateClaim_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "recruitment_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentCertificateClaim" ADD CONSTRAINT "RecruitmentCertificateClaim_suggestedStandardId_fkey" FOREIGN KEY ("suggestedStandardId") REFERENCES "CertificateStandard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentCertificateClaim" ADD CONSTRAINT "RecruitmentCertificateClaim_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "CertificateStandard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentCertificateClaim" ADD CONSTRAINT "RecruitmentCertificateClaim_recognitionPolicyId_standardId_fkey" FOREIGN KEY ("recognitionPolicyId", "standardId") REFERENCES "CertificateRecognitionPolicy"("id", "standardId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentCertificateClaim" ADD CONSTRAINT "RecruitmentCertificateClaim_recognitionIssuerId_recognitio_fkey" FOREIGN KEY ("recognitionIssuerId", "recognitionPolicyId") REFERENCES "CertificateRecognitionIssuer"("id", "policyId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- 以下为手写段(Prisma DSL 表达不了,冻结稿 §5.3 / §5.4 / §5.5 逐条要求)。
-- 本 migration 为 expand-only:4 张净新空表 + Certificate 5 个 nullable 列;
-- 零回填、零 DROP、零 default 变更、零不可逆操作。
-- ============================================================================

-- §5.3 / D-CERT-006:每个 Standard 同时至多一个 ACTIVE RecognitionPolicy。
-- 为什么必须落到 DB:激活流程是「锁 Standard → RETIRE 旧 ACTIVE → 激活新版」,
-- 在 READ COMMITTED 下两个并发激活可以互相穿透,只靠 service 检查会双 ACTIVE。
-- partial unique 是最终兜底;service 侧把 P2002 显式转成业务错误(§5.3 第 7 步)。
CREATE UNIQUE INDEX "certificate_recognition_policy_one_active_per_standard"
  ON "CertificateRecognitionPolicy" ("standardId")
  WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL;

-- §5.4:同一 Policy 下认可机构去重(仅未软删行参与)。
-- normalizedName 只用于 DRAFT 内去重,不做模糊匹配;实例认可靠 issuer id(D-CERT-021)。
CREATE UNIQUE INDEX "certificate_recognition_issuer_active_name_unique"
  ON "CertificateRecognitionIssuer" ("policyId", "normalizedName")
  WHERE "deletedAt" IS NULL;

-- §5.5:Claim 状态与标准化字段的一致性。APPROVED / PROMOTED 是「已完成标准化」的
-- 承诺,缺任何一项就说明审核结论不完整 —— 让 DB 直接拒绝,而不是等发号时才炸。
ALTER TABLE "RecruitmentCertificateClaim"
  ADD CONSTRAINT "recruitment_certificate_claim_approved_complete_check"
  CHECK (
    "status" <> 'APPROVED'
    OR (
      "standardId" IS NOT NULL
      AND "recognitionPolicyId" IS NOT NULL
      AND "issuingOrg" IS NOT NULL
      AND "issuedAt" IS NOT NULL
    )
  );

-- PROMOTED 允许在成功搬运后清空重复标量(§5.5 / §8.5 第 11 步),
-- 所以这里只要求 Standard / Policy / promotedAt 仍在,不要求 issuingOrg / issuedAt。
ALTER TABLE "RecruitmentCertificateClaim"
  ADD CONSTRAINT "recruitment_certificate_claim_promoted_complete_check"
  CHECK (
    "status" <> 'PROMOTED'
    OR (
      "standardId" IS NOT NULL
      AND "recognitionPolicyId" IS NOT NULL
      AND "promotedAt" IS NOT NULL
    )
  );

-- 日期区间:与 Certificate 同一语义(§10.1 expiredAt = 最后有效日,可等于 issuedAt)。
ALTER TABLE "RecruitmentCertificateClaim"
  ADD CONSTRAINT "recruitment_certificate_claim_date_range_check"
  CHECK (
    "expiredAt" IS NULL
    OR "issuedAt" IS NULL
    OR "expiredAt" >= "issuedAt"
  );

-- version 是申请人重传与管理员审核之间的 CAS 计数,不可为负。
ALTER TABLE "RecruitmentCertificateClaim"
  ADD CONSTRAINT "recruitment_certificate_claim_version_nonneg_check"
  CHECK ("version" >= 0);
