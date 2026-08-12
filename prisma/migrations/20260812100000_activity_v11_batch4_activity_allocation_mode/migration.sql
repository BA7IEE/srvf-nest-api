-- 活动改造 v1.1 第 4 批⑫前置 D84：活动唯一权威分配方式地基。
-- default first_come 仅作旧 server / 存量兼容桥；新活动显式选择由下一 C 刀完成。
-- 本 migration 零业务 DML、零业务数据修复，不触碰既有分配批次结构。

BEGIN;

ALTER TABLE "Activity"
  ADD COLUMN "allocationModeCode" TEXT NOT NULL DEFAULT 'first_come';

-- allocation-mode-84:check:begin
ALTER TABLE "Activity"
  ADD CONSTRAINT "activity_allocation_mode_code_ck"
  CHECK ("allocationModeCode" IN ('first_come', 'qualification_rank', 'lottery'));
-- allocation-mode-84:check:end

COMMIT;
