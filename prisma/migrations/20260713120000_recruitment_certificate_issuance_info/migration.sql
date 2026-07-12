-- 招新证书上传采集发证机构/日期；按类别 JSON 暂存，promote 后搬入 Certificate 并清空。
ALTER TABLE "recruitment_applications"
ADD COLUMN "certificateIssuanceInfo" JSONB;
