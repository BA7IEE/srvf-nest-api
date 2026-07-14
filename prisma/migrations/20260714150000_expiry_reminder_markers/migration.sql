-- 第 50 migration:v0.47.0 保险到期提醒幂等 marker。
--
-- 两列均 additive / nullable / 无回填：
-- - 首次到期扫描会覆盖既有已进入 30 天窗口（含已过期）的保险记录；
-- - null 表示尚未派发，非 null 表示该记录已 claim；
-- - 不保存保单号、凭证或任何通知正文。

-- AlterTable
ALTER TABLE "member_insurances"
ADD COLUMN "expireNotifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "team_insurance_policies"
ADD COLUMN "expireNotifiedAt" TIMESTAMP(3);
