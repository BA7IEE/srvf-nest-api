-- 招新/入队十三项收口 PR-1 刀B(2026-07-12):
-- 同轮 active 报名的 openid / phone 防重由 service 预检升级为 DB partial unique 兜底。
-- 前置只读核查已确认现存 active 重复组 openid=0、phone=0；全 additive、无回填、无不可逆。

CREATE UNIQUE INDEX "recruitment_applications_cycle_openid_active_unique"
ON "recruitment_applications" ("cycleId", "openid")
WHERE "deletedAt" IS NULL
  AND "statusCode" NOT IN ('rejected', 'withdrawn')
  AND "openid" IS NOT NULL;

CREATE UNIQUE INDEX "recruitment_applications_cycle_phone_active_unique"
ON "recruitment_applications" ("cycleId", "phone")
WHERE "deletedAt" IS NULL
  AND "statusCode" NOT IN ('rejected', 'withdrawn')
  AND "phone" IS NOT NULL;
