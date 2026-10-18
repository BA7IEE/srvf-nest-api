-- Migration147: require the correction source hash before the composite proof FK can apply.
-- Validates existing rows atomically. No backfill, historical edits or function/ACL changes.
BEGIN;
ALTER TABLE "ActivitySettlementContributionRevision"
  ADD CONSTRAINT e4_revision_correction_source_hash_required
  CHECK ("sourceKindCode" <> 'correction_time_proof' OR "correctionSourceSetHash" IS NOT NULL);
COMMIT;
