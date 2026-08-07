-- 活动改造 v1.1 第 4 批 Form 前置微刀 D-FORM-0(第 79 migration)。
--
-- 维护者 2026-08-07 按推荐拍板:
-- - RegistrationFormField.visibilityCode 只可为 self_and_registration_staff /
--   self_and_owner / self_only;
-- - RegistrationUploadSession.statusCode 只可为 active / consumed / revoked，过期由
--   expiresAt 在读取时推导，不新增 cron;
-- - 一个 registration-upload-session owner 至多一条附件。
--
-- expand-only:零数据修改、回填、删除、默认值、列变更或 rename。既有脏值 / 重复附件
-- 不清洗，约束或 unique index 在部署时发现它们会 fail-closed。AI 不执行生产迁移。

-- visibilityCode 是敏感表单题目的读面边界；闭集由 2026-08-07 拍板，NULL 边界由列的
-- NOT NULL 承担，因此 IN 表达式恒为二值。
ALTER TABLE "RegistrationFormField"
ADD CONSTRAINT "registration_form_field_visibility_code_check"
CHECK ("visibilityCode" IN (
  'self_and_registration_staff',
  'self_and_owner',
  'self_only'
));

-- 上传会话的持久化状态闭集。过期不是第四个 statusCode：以 expiresAt 推导，避免 cron。
ALTER TABLE "RegistrationUploadSession"
ADD CONSTRAINT "registration_upload_session_status_code_check"
CHECK ("statusCode" IN ('active', 'consumed', 'revoked'));

-- 生命周期必须双向一致。保留第 72 migration 的既有
-- registration_upload_session_consumed_shape_check，不 DROP / 不回改历史 migration；
-- 本条补上其无法表达的反向半边(consumed 必有 consumedAt)。两个操作数都是二值谓词，
-- 因而 CHECK 不会借 NULL 静默放行。
ALTER TABLE "RegistrationUploadSession"
ADD CONSTRAINT "registration_upload_session_lifecycle_shape_check"
CHECK (("statusCode" = 'consumed') = ("consumedAt" IS NOT NULL));

-- 一个完成附件只可归属同一报名上传会话一次。其它 ownerType 仍维持原有多附件语义；
-- Prisma DSL 无法表示 partial predicate，故仅手写该 DB 兜底。已有重复会使建索引失败，
-- 不做清洗或回填。
CREATE UNIQUE INDEX "attachments_registration_upload_session_owner_unique"
ON "attachments" ("ownerId")
WHERE "ownerType" = 'registration-upload-session';
