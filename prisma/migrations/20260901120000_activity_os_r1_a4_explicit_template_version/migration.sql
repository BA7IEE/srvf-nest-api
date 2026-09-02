-- Activity OS Release 1 / A4：Activity 显式 Template Version 指针。
--
-- 纯 forward expand：仅增加一个可空列、单列索引和 Restrict FK。
-- 零 default / 零 UPDATE / 零回填 / 零 seed；既有 Activity 继续保持 NULL，沿既有
-- activityTypeCode 的 legacy resolver 路径工作。本 migration 不修改 ActivityTemplate、
-- 不切换读写路径，也不定义「只能选择 active / Family Version」等未来 writer 语义。

BEGIN;

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN "selectedTemplateVersionId" TEXT;

-- CreateIndex
CREATE INDEX "Activity_selectedTemplateVersionId_idx" ON "Activity"("selectedTemplateVersionId");

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_selectedTemplateVersionId_fkey" FOREIGN KEY ("selectedTemplateVersionId") REFERENCES "ActivityTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
