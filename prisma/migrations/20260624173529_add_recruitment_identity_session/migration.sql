-- 招新四期 S4a(H5 + 手机身份链;评审稿 §3.3 / §3.4)。
-- ① 净新建报名前身份会话表(临时凭证;不进 recruitment_applications,不参与去重/统计/容量)。
-- ② recruitment_applications 加 6 个手机身份链可空列(全 additive,纯加列无破坏)。
-- 不使用上一 migration 新增的 RECRUITMENT_BIND 枚举值(无 default / 无 INSERT 引用),避免同事务用新值。

-- CreateTable
CREATE TABLE "recruitment_identity_sessions" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cycleId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phoneVerifiedAt" TIMESTAMP(3) NOT NULL,
    "phoneVerificationMethod" TEXT NOT NULL,
    "phoneVerificationTokenHash" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "openid" TEXT,
    "ocrAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastOcrOutcome" TEXT,
    "requiresRetake" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "recruitment_identity_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_identity_sessions_phoneVerificationTokenHash_key" ON "recruitment_identity_sessions"("phoneVerificationTokenHash");

-- CreateIndex
CREATE INDEX "recruitment_identity_sessions_phone_cycleId_idx" ON "recruitment_identity_sessions"("phone", "cycleId");

-- CreateIndex
CREATE INDEX "recruitment_identity_sessions_cycleId_idx" ON "recruitment_identity_sessions"("cycleId");

-- CreateIndex
CREATE INDEX "recruitment_identity_sessions_expiresAt_idx" ON "recruitment_identity_sessions"("expiresAt");

-- AddForeignKey
ALTER TABLE "recruitment_identity_sessions" ADD CONSTRAINT "recruitment_identity_sessions_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "recruitment_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable(recruitment_applications 手机身份链 6 列;全可空 additive)
ALTER TABLE "recruitment_applications" ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "phoneVerificationMethod" TEXT,
ADD COLUMN     "phoneChangedAt" TIMESTAMP(3),
ADD COLUMN     "phoneChangeReason" TEXT,
ADD COLUMN     "phoneBindingHistory" JSONB,
ADD COLUMN     "phoneRiskFlag" TEXT;
