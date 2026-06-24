-- 招新四期 S4b(OCR 六分流 + 重拍计数;评审稿 recruitment-phase4-loop-optimization-review.md §2)。
-- recruitment_applications 加 4 列(全 additive,纯加列无破坏,无 enum、无不可逆动作):
--   manualReviewReason / riskLevel / lastOcrOutcome 可空 TEXT;applicantConfirmedOcrWrong BOOLEAN NOT NULL DEFAULT false。
-- 既有行自动取 NULL / false;verifyOutcome 既有列与值不动(复用扩展)。重拍计数落 recruitment_identity_sessions 预建列(S4a)。

-- AlterTable(recruitment_applications OCR 六分流 4 列;全可空/有默认 additive)
ALTER TABLE "recruitment_applications" ADD COLUMN     "manualReviewReason" TEXT,
ADD COLUMN     "riskLevel" TEXT,
ADD COLUMN     "applicantConfirmedOcrWrong" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastOcrOutcome" TEXT;
