-- CreateEnum
CREATE TYPE "RealnameProviderType" AS ENUM ('DEV_STUB', 'TENCENT_CLOUD');

-- CreateTable
CREATE TABLE "recruitment_cycles" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "year" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "capacity" INTEGER,
    "tempNoSeq" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "meetingInfo" TEXT,
    "qqGroup" TEXT,
    "notifyTemplate" JSONB,

    CONSTRAINT "recruitment_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recruitment_applications" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "cycleId" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "tempNo" TEXT,
    "openid" TEXT,
    "realName" TEXT,
    "idCardNumber" TEXT,
    "birthDate" TIMESTAMP(3),
    "phone" TEXT,
    "detailedAddress" TEXT,
    "idCardImageKey" TEXT,
    "emergencyContacts" JSONB,
    "profileExtra" JSONB,
    "documentTypeCode" TEXT NOT NULL,
    "isForeigner" BOOLEAN NOT NULL DEFAULT false,
    "genderCode" TEXT,
    "ageGroup" TEXT,
    "cityDistrict" TEXT,
    "sourceChannel" TEXT,
    "eliminationStage" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifyOutcome" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "sensitivePurgedAt" TIMESTAMP(3),

    CONSTRAINT "recruitment_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "realname_verification_settings" (
    "id" TEXT NOT NULL,
    "providerType" "RealnameProviderType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "region" TEXT,
    "secretIdEncrypted" TEXT,
    "secretKeyEncrypted" TEXT,
    "credentialConfigured" BOOLEAN NOT NULL DEFAULT false,
    "remarks" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realname_verification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recruitment_cycles_year_idx" ON "recruitment_cycles"("year");

-- CreateIndex
CREATE INDEX "recruitment_cycles_statusCode_idx" ON "recruitment_cycles"("statusCode");

-- CreateIndex
CREATE INDEX "recruitment_cycles_deletedAt_idx" ON "recruitment_cycles"("deletedAt");

-- CreateIndex
CREATE INDEX "recruitment_cycles_createdAt_idx" ON "recruitment_cycles"("createdAt");

-- CreateIndex
CREATE INDEX "recruitment_applications_cycleId_idx" ON "recruitment_applications"("cycleId");

-- CreateIndex
CREATE INDEX "recruitment_applications_statusCode_idx" ON "recruitment_applications"("statusCode");

-- CreateIndex
CREATE INDEX "recruitment_applications_openid_idx" ON "recruitment_applications"("openid");

-- CreateIndex
CREATE INDEX "recruitment_applications_deletedAt_idx" ON "recruitment_applications"("deletedAt");

-- CreateIndex
CREATE INDEX "recruitment_applications_createdAt_idx" ON "recruitment_applications"("createdAt");

-- AddForeignKey
ALTER TABLE "recruitment_applications" ADD CONSTRAINT "recruitment_applications_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "recruitment_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- 手动追加:招新报名 partial unique ×2(沿 ActivityRegistration / 保险覆盖名单范式)
-- Prisma DSL 至 6.x 不支持 @@unique 内表达带 WHERE 的 partial unique index。
-- 评审稿 recruitment-phase1-review.md E-R-9/E-R-10。
-- =============================================================================

-- ① 防重复报名(同轮同人):同一轮次内同一身份证仅一条"活跃且非未通过"报名行;
--    允许 rejected 后同轮重试(实名错填可纠);service 层 P2002 兜底转 BizCode 28003。
CREATE UNIQUE INDEX "recruitment_applications_cycle_idcard_active_unique"
ON "recruitment_applications" ("cycleId", "idCardNumber")
WHERE "deletedAt" IS NULL AND "statusCode" <> 'rejected';

-- ② 临时编号同轮唯一:配合 recruitment_cycles.tempNoSeq 行级原子自增,兜底并发发号;
--    仅 tempNo 非空(= 已发号的 verified 行)参与唯一。
CREATE UNIQUE INDEX "recruitment_applications_cycle_tempno_unique"
ON "recruitment_applications" ("cycleId", "tempNo")
WHERE "tempNo" IS NOT NULL;
