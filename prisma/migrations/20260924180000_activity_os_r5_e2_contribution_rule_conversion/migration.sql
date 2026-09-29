-- Activity OS R5 / E2 first layer: additive, immutable conversion provenance only.
-- No old ContributionRule rows are changed or copied by this migration.
BEGIN;

CREATE TABLE "ContributionRuleConversionReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sourceRuleId" TEXT NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "converterVersion" INTEGER NOT NULL,
  "mappingFingerprint" TEXT NOT NULL,
  "batchFingerprint" TEXT NOT NULL,
  "sourceSnapshotJson" JSONB NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "versionId" TEXT NOT NULL,
  "definitionHash" TEXT NOT NULL,
  "evaluatorVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT crcr_source_fk FOREIGN KEY ("sourceRuleId") REFERENCES "ContributionRule"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT crcr_actor_fk FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT crcr_policy_fk FOREIGN KEY ("policyId") REFERENCES "ContributionPolicy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT crcr_version_anchor_fk FOREIGN KEY ("versionId", "policyId", "definitionHash", "evaluatorVersion") REFERENCES "ContributionPolicyVersion"("id", "policyId", "definitionHash", "evaluatorVersion") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT crcr_hashes_check CHECK (
    "sourceFingerprint" ~ '^[a-f0-9]{64}$' AND
    "mappingFingerprint" ~ '^[a-f0-9]{64}$' AND
    "batchFingerprint" ~ '^[a-f0-9]{64}$' AND
    "definitionHash" ~ '^[a-f0-9]{64}$' AND
    "converterVersion" = 1 AND "evaluatorVersion" = 1
  ),
  CONSTRAINT crcr_snapshot_shape_check CHECK ((
    jsonb_typeof("sourceSnapshotJson") = 'object' AND
    "sourceSnapshotJson" ?& ARRAY['id','activityTypeCode','attendanceRoleCode','durationThreshold','pointsBelow','pointsAbove','status','deletedAt','updatedAt'] AND
    "sourceSnapshotJson" - ARRAY['id','activityTypeCode','attendanceRoleCode','durationThreshold','pointsBelow','pointsAbove','status','deletedAt','updatedAt'] = '{}'::jsonb AND
    "sourceSnapshotJson"->>'id' = "sourceRuleId" AND
    "sourceSnapshotJson"->>'status' = 'ACTIVE' AND
    "sourceSnapshotJson"->'deletedAt' = 'null'::jsonb
  ) IS TRUE)
);

CREATE UNIQUE INDEX crcr_source_revision_key ON "ContributionRuleConversionReceipt"("sourceRuleId", "sourceFingerprint", "converterVersion");
CREATE INDEX crcr_policy_idx ON "ContributionRuleConversionReceipt"("policyId");
CREATE INDEX crcr_version_idx ON "ContributionRuleConversionReceipt"("versionId");
CREATE INDEX crcr_actor_idx ON "ContributionRuleConversionReceipt"("actorUserId");

CREATE FUNCTION crcr_immutable_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'contribution rule conversion receipt is immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER crcr_immutable_guard BEFORE UPDATE OR DELETE ON "ContributionRuleConversionReceipt"
FOR EACH ROW EXECUTE FUNCTION crcr_immutable_guard_fn();
CREATE TRIGGER crcr_no_truncate BEFORE TRUNCATE ON "ContributionRuleConversionReceipt"
FOR EACH STATEMENT EXECUTE FUNCTION crcr_immutable_guard_fn();

COMMIT;
