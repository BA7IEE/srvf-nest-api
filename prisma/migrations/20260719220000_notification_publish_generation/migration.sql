BEGIN;

ALTER TABLE "notifications"
  ADD COLUMN "publishGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "notifications_publish_generation_nonnegative_check"
  CHECK ("publishGeneration" >= 0);

COMMIT;
