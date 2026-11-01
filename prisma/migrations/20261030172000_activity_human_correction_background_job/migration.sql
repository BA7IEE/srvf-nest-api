-- DRAFT ONLY. Maintainer redzone grant and explicit DB-owner installation required.
-- Extends only the existing closed type CHECK; no table/column/role/ACL changes.
-- One ALTER statement validates existing rows atomically under its ordinary DDL lock.
ALTER TABLE "ActivityBatchJob"
  DROP CONSTRAINT "activity_batch_job_type_code_check",
  ADD CONSTRAINT "activity_batch_job_type_code_check"
  CHECK ("jobTypeCode" IN (
    'settlement_prepare', 'bulk_proxy', 'import_preview', 'import_execute',
    'export', 'notification_expand', 'reconciliation', 'human_correction_commit'
  ));
