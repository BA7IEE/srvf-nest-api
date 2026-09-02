-- Activity OS Release 1 / A6：从模板创建活动的持久化幂等锚。
--
-- 纯 forward expand：只为成功 Activity 追加 operationKey / requestHash 两列及唯一索引。
-- 零 default / 零 UPDATE / 零回填 / 零 seed / 零删除；历史 Activity 保持 NULL，普通创建
-- 与既有 lifecycle operationKey 不受影响。数据库不在此 migration 发明模板选择语义，
-- Version 是否可选仍由 A6 事务内的显式行锁和服务校验负责。

BEGIN;

-- AlterTable
ALTER TABLE "Activity"
  ADD COLUMN "createFromTemplateOperationKey" TEXT,
  ADD COLUMN "createFromTemplateRequestHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "activity_create_from_template_operation_key_key"
  ON "Activity"("createFromTemplateOperationKey");

COMMIT;
