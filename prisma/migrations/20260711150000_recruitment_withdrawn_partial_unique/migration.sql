-- 招新可用性收口 F6(2026-07-11;评审稿 recruitment-usability-closeout-review.md §3 R4):
-- 自助撤销新增 statusCode='withdrawn' 终态(String 态无 enum)。同轮防重 partial unique 的
-- 排除集由 <> 'rejected' 重建为 NOT IN ('rejected','withdrawn') —— 撤销后允许同轮(及下轮)重报。
-- 纯索引重建(先删后建;无数据回填/无不可逆;现存数据必然满足更宽松的新谓词,零冲突)。

-- DropIndex
DROP INDEX "recruitment_applications_cycle_idcard_active_unique";

-- CreateIndex
CREATE UNIQUE INDEX "recruitment_applications_cycle_idcard_active_unique"
ON "recruitment_applications" ("cycleId", "idCardNumber")
WHERE "deletedAt" IS NULL AND "statusCode" NOT IN ('rejected', 'withdrawn');
