-- 活动通知按**组织**定向(AC-066 的组织那一格;维护者 2026-08-25 拍板)。
--
-- expand-only:`activity_publish_reviews` 加**一列**可空 JSONB,与同表 `audienceTagCodes`
-- (20260817100000)逐字同形。零 default、零回填、零 DROP、零 RENAME、零既有行重解释 ——
-- 存量 review 一律取 NULL,运行时读作「未按组织定向」,与本刀之前的行为逐字相同。
--
-- 语义(运行时,不落 DB 执行位):`null` = 不按组织定向;`[]` = 该维度不设限;
-- 非空 = 收件人须在这些组织**或其后代**中有有效任职,并与 `audienceTagCodes` **取交集**。
-- 「含下级」由 `organization_closure` 真子树查询承担,不是编码前缀匹配。
--
-- 刻意零 CHECK:JSONB 的「必须是 string[]」在 PG 侧要写成 jsonb_typeof + 逐元素断言,
-- 而同表姊妹列 `audienceTagCodes` 的同一约束也没有 DB 执行位 —— 执行位在
-- `readActivityPublishReviewAudienceOrganizationIds`(形状不对即抛,不 filter 后静默继续)。
-- 单独给新列加 CHECK 会造出「两列同形状却一严一松」的第二份真相。
--
-- 回滚:ALTER TABLE "activity_publish_reviews" DROP COLUMN "audienceOrganizationIds";

BEGIN;

-- AlterTable
ALTER TABLE "activity_publish_reviews"
ADD COLUMN "audienceOrganizationIds" JSONB;

COMMIT;
