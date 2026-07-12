-- 招新证书审核闭环 + 入队轮候选部门配置（全 additive；无 rename/drop）。
ALTER TABLE "recruitment_applications"
ADD COLUMN "certificateReviewStatus" JSONB;

ALTER TABLE "team_join_cycles"
ADD COLUMN "openOrganizationIds" JSONB,
ADD COLUMN "maxTargetOrgs" INTEGER;
