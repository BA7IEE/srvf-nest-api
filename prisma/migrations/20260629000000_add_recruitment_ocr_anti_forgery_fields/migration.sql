-- OCR 鉴伪版充分利用(2026-06-29;评审稿 recruitment-ocr-anti-forgery-enrichment-review.md §3.1)。
-- recruitment_applications 加 6 列(全 additive 可空 TEXT,纯加列无破坏,无 enum、无默认、无回填、无不可逆动作):
--   仅 mainland_id RecognizeValidIDCardOCR 充分利用:
--     ocrAddress / ocrNation / ocrAuthority / ocrValidDate —— OCR 扩展字段顾问式存档(非权威);
--     idCardCropImageKey / idCardPortraitImageKey —— 主体框/头像裁剪图 storage key。
-- 既有行自动取 NULL;既有列与值不动;gender/birth 仍由身份证号推导(本组不参与派生)。

-- AlterTable(recruitment_applications OCR 鉴伪版扩展 6 列;全可空 additive)
ALTER TABLE "recruitment_applications" ADD COLUMN     "ocrAddress" TEXT,
ADD COLUMN     "ocrNation" TEXT,
ADD COLUMN     "ocrAuthority" TEXT,
ADD COLUMN     "ocrValidDate" TEXT,
ADD COLUMN     "idCardCropImageKey" TEXT,
ADD COLUMN     "idCardPortraitImageKey" TEXT;
