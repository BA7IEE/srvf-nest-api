-- 招新可用性收口 F5(2026-07-11;评审稿 recruitment-usability-closeout-review.md §2.8 R5):
-- 知情同意留痕 + 签名图(全 additive 可空列;无回填 / 无不可逆 / 无 enum)。
-- recruitment_applications:+privacyConsentAcceptedAt / +privacyConsentVersion / +signatureImageKey;
-- MemberProfile:+signatureImageKey(promote 搬运长期留存,镜像 idCardImageKey/MP-32 范式)。

-- AlterTable
ALTER TABLE "recruitment_applications" ADD COLUMN "privacyConsentAcceptedAt" TIMESTAMP(3),
ADD COLUMN "privacyConsentVersion" TEXT,
ADD COLUMN "signatureImageKey" TEXT;

-- AlterTable
ALTER TABLE "MemberProfile" ADD COLUMN "signatureImageKey" TEXT;
