-- 招新可用性收口 F7(2026-07-11;评审稿 recruitment-usability-closeout-review.md §2.9 R6):
-- 证书图上传与长期档案(全 additive 可空列;无回填 / 无不可逆 / 无 enum)。
-- recruitment_applications:+certificateImages Json(按类别分组的 storage keys 暂存位);
-- Certificate:+imageKeys Json(promote 按类别建 pending 行时搬入,blob 单一属主=certificate)。

-- AlterTable
ALTER TABLE "recruitment_applications" ADD COLUMN "certificateImages" JSONB;

-- AlterTable
ALTER TABLE "Certificate" ADD COLUMN "imageKeys" JSONB;
