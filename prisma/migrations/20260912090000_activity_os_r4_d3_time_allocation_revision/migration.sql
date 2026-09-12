-- Activity OS R4 / D3: immutable participant time-allocation revisions.
--
-- Pure expand migration #120.  It adds a new interpretation layer over existing D2 segments and
-- D1 selection snapshots only.  There is no backfill, no DML against retained business facts and
-- no production operation implied by this file.
BEGIN;

CREATE TABLE "ParticipantTimeAllocationRevision" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activityId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "participationIdentityId" TEXT NOT NULL,
  "segmentKey" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "previousAllocationRevisionId" TEXT,
  "sourceSegmentId" TEXT NOT NULL,
  "sourceSegmentRevision" INTEGER NOT NULL,
  "sourcePositionId" TEXT,
  "ruleSnapshotId" TEXT NOT NULL,
  "ruleSnapshotHash" TEXT NOT NULL,
  "timePolicySelectionRevisionId" TEXT NOT NULL,
  "selectionHash" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "policyVersionId" TEXT NOT NULL,
  "definitionHash" TEXT NOT NULL,
  "evaluatorVersion" INTEGER NOT NULL,
  "recognitionModeCode" TEXT NOT NULL,
  "manualReason" TEXT,
  "allocationJson" JSONB NOT NULL,
  "allocationHash" TEXT NOT NULL,
  "sliceCount" INTEGER NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  CONSTRAINT "ParticipantTimeAllocationRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ParticipantTimeAllocationSlice" (
  "id" TEXT NOT NULL,
  "allocationRevisionId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "categoryCode" TEXT NOT NULL,
  "intervalKindCode" TEXT NOT NULL,
  "startAt" TIMESTAMP(3) NOT NULL,
  "endAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ParticipantTimeAllocationSlice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ParticipantTimeAllocationEvidence" (
  "id" TEXT NOT NULL,
  "allocationRevisionId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "attachmentId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  CONSTRAINT "ParticipantTimeAllocationEvidence_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ParticipantTimeAllocationCommandReceipt" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "operationCode" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "allocationRevisionId" TEXT NOT NULL,
  "resultJson" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ParticipantTimeAllocationCommandReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ptar_identity_segment_revision_key"
  ON "ParticipantTimeAllocationRevision"("participationIdentityId", "segmentKey", "revision");
CREATE UNIQUE INDEX "ptar_id_activity_key"
  ON "ParticipantTimeAllocationRevision"("id", "activityId");
CREATE UNIQUE INDEX "ptar_id_activity_session_member_key"
  ON "ParticipantTimeAllocationRevision"("id", "activityId", "sessionId", "memberId");
CREATE INDEX "ptar_activity_created_idx"
  ON "ParticipantTimeAllocationRevision"("activityId", "createdAt");
CREATE INDEX "ptar_source_segment_idx"
  ON "ParticipantTimeAllocationRevision"("sourceSegmentId");
CREATE INDEX "ptar_snapshot_idx"
  ON "ParticipantTimeAllocationRevision"("ruleSnapshotId");
CREATE INDEX "ptar_selection_idx"
  ON "ParticipantTimeAllocationRevision"("timePolicySelectionRevisionId");
CREATE INDEX "ptar_policy_version_idx"
  ON "ParticipantTimeAllocationRevision"("policyVersionId");
CREATE INDEX "ptar_previous_idx"
  ON "ParticipantTimeAllocationRevision"("previousAllocationRevisionId");

CREATE UNIQUE INDEX "ptas_revision_ordinal_key"
  ON "ParticipantTimeAllocationSlice"("allocationRevisionId", "ordinal");
CREATE INDEX "ptas_activity_idx"
  ON "ParticipantTimeAllocationSlice"("activityId");

CREATE UNIQUE INDEX "ptae_revision_attachment_key"
  ON "ParticipantTimeAllocationEvidence"("allocationRevisionId", "attachmentId");
CREATE UNIQUE INDEX "ptae_revision_ordinal_key"
  ON "ParticipantTimeAllocationEvidence"("allocationRevisionId", "ordinal");
CREATE INDEX "ptae_activity_idx"
  ON "ParticipantTimeAllocationEvidence"("activityId");
CREATE INDEX "ptae_attachment_idx"
  ON "ParticipantTimeAllocationEvidence"("attachmentId");

CREATE UNIQUE INDEX "ptacr_actor_operation_key"
  ON "ParticipantTimeAllocationCommandReceipt"("actorUserId", "operationCode", "operationKey");
CREATE UNIQUE INDEX "ptacr_revision_activity_key"
  ON "ParticipantTimeAllocationCommandReceipt"("allocationRevisionId", "activityId");
CREATE INDEX "ptacr_activity_created_idx"
  ON "ParticipantTimeAllocationCommandReceipt"("activityId", "createdAt");

ALTER TABLE "ParticipantTimeAllocationRevision"
  ADD CONSTRAINT "ptar_activity_fkey"
    FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptar_session_fkey"
    FOREIGN KEY ("activityId", "sessionId") REFERENCES "ActivitySession"("activityId", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptar_member_fkey"
    FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptar_identity_fkey"
    FOREIGN KEY ("participationIdentityId", "activityId", "sessionId", "memberId")
    REFERENCES "ActivityParticipationIdentity"("id", "activityId", "sessionId", "memberId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptar_source_segment_fkey"
    FOREIGN KEY ("sourceSegmentId", "participationIdentityId")
    REFERENCES "ParticipantServiceSegmentRevision"("id", "participationIdentityId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptar_source_position_fkey"
    FOREIGN KEY ("sourcePositionId", "activityId", "sessionId")
    REFERENCES "ActivitySessionPosition"("id", "activityId", "sessionId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptar_snapshot_fkey"
    FOREIGN KEY ("ruleSnapshotId", "activityId")
    REFERENCES "ActivityRuleSnapshot"("id", "activityId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptar_selection_fkey"
    FOREIGN KEY ("timePolicySelectionRevisionId", "activityId")
    REFERENCES "ActivityTimePolicySelectionRevision"("id", "activityId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptar_policy_fkey"
    FOREIGN KEY ("policyId") REFERENCES "TimePolicy"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptar_policy_version_fkey"
    FOREIGN KEY ("policyVersionId", "policyId", "definitionHash")
    REFERENCES "TimePolicyVersion"("id", "policyId", "definitionHash")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptar_previous_fkey"
    FOREIGN KEY ("previousAllocationRevisionId", "activityId", "sessionId", "memberId")
    REFERENCES "ParticipantTimeAllocationRevision"("id", "activityId", "sessionId", "memberId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptar_creator_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ParticipantTimeAllocationSlice"
  ADD CONSTRAINT "ptas_revision_fkey"
    FOREIGN KEY ("allocationRevisionId", "activityId")
    REFERENCES "ParticipantTimeAllocationRevision"("id", "activityId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ParticipantTimeAllocationEvidence"
  ADD CONSTRAINT "ptae_revision_fkey"
    FOREIGN KEY ("allocationRevisionId", "activityId")
    REFERENCES "ParticipantTimeAllocationRevision"("id", "activityId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptae_attachment_fkey"
    FOREIGN KEY ("attachmentId") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ParticipantTimeAllocationCommandReceipt"
  ADD CONSTRAINT "ptacr_actor_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptacr_activity_fkey"
    FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ptacr_revision_fkey"
    FOREIGN KEY ("allocationRevisionId", "activityId")
    REFERENCES "ParticipantTimeAllocationRevision"("id", "activityId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ParticipantTimeAllocationRevision"
  ADD CONSTRAINT "ptar_shape_check" CHECK ((
    "revision" > 0
    AND "sourceSegmentRevision" > 0
    AND "ruleSnapshotHash" ~ '^[0-9a-f]{64}$'
    AND "selectionHash" ~ '^[0-9a-f]{64}$'
    AND "definitionHash" ~ '^[0-9a-f]{64}$'
    AND "allocationHash" ~ '^[0-9a-f]{64}$'
    AND "evaluatorVersion" > 0
    AND "sliceCount" BETWEEN 1 AND 500
    AND (
      ("recognitionModeCode" = 'automatic' AND "manualReason" IS NULL)
      OR
      ("recognitionModeCode" = 'manual' AND length(btrim("manualReason")) BETWEEN 1 AND 1024
        AND "manualReason" !~ '[[:cntrl:]]')
    )
    AND jsonb_typeof("allocationJson") = 'object'
    AND "allocationJson" ?& ARRAY['schemaVersion', 'slices']
    AND "allocationJson" - ARRAY['schemaVersion', 'slices'] = '{}'::jsonb
    AND "allocationJson"->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof("allocationJson"->'slices') = 'object'
  ) IS TRUE);

ALTER TABLE "ParticipantTimeAllocationSlice"
  ADD CONSTRAINT "ptas_shape_check" CHECK ((
    "ordinal" BETWEEN 0 AND 499
    AND "categoryCode" IN ('volunteer_service', 'training', 'organization', 'non_creditable')
    AND "intervalKindCode" = 'service_segment'
    AND "startAt" < "endAt"
  ) IS TRUE);

ALTER TABLE "ParticipantTimeAllocationEvidence"
  ADD CONSTRAINT "ptae_shape_check" CHECK (("ordinal" BETWEEN 0 AND 499) IS TRUE);

ALTER TABLE "ParticipantTimeAllocationCommandReceipt"
  ADD CONSTRAINT "ptacr_shape_check" CHECK ((
    "operationCode" = 'recognize_time_allocation'
    AND length("operationKey") BETWEEN 8 AND 128
    AND "operationKey" ~ '[^[:space:]]'
    AND "operationKey" !~ '[[:cntrl:]]'
    AND "requestHash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("resultJson") = 'object'
    AND "resultJson" ?& ARRAY[
      'schemaVersion', 'activityId', 'allocationRevisionId', 'revision',
      'sourceSegmentId', 'sourceSegmentRevision', 'recognitionModeCode',
      'allocationHash', 'sliceCount', 'evidenceCount', 'createdAt'
    ]
    AND "resultJson" - ARRAY[
      'schemaVersion', 'activityId', 'allocationRevisionId', 'revision',
      'sourceSegmentId', 'sourceSegmentRevision', 'recognitionModeCode',
      'allocationHash', 'sliceCount', 'evidenceCount', 'createdAt'
    ] = '{}'::jsonb
    AND "resultJson"->'schemaVersion' = '1'::jsonb
    AND jsonb_typeof("resultJson"->'activityId') = 'string'
    AND jsonb_typeof("resultJson"->'allocationRevisionId') = 'string'
    AND jsonb_typeof("resultJson"->'revision') = 'number'
    AND "resultJson"->>'revision' ~ '^[1-9][0-9]{0,9}$'
    AND jsonb_typeof("resultJson"->'sourceSegmentId') = 'string'
    AND jsonb_typeof("resultJson"->'sourceSegmentRevision') = 'number'
    AND "resultJson"->>'sourceSegmentRevision' ~ '^[1-9][0-9]{0,9}$'
    AND "resultJson"->>'recognitionModeCode' IN ('automatic', 'manual')
    AND "resultJson"->>'allocationHash' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("resultJson"->'sliceCount') = 'number'
    AND "resultJson"->>'sliceCount' ~ '^[1-9][0-9]{0,2}$'
    AND jsonb_typeof("resultJson"->'evidenceCount') = 'number'
    AND "resultJson"->>'evidenceCount' ~ '^(0|[1-9][0-9]{0,2})$'
    AND jsonb_typeof("resultJson"->'createdAt') = 'string'
    AND "resultJson"->>'createdAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  ) IS TRUE);

CREATE FUNCTION ptar_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    CONSTRAINT = TG_NAME,
    MESSAGE = 'participant time allocation history is immutable';
END;
$$;

CREATE TRIGGER ptar_revision_immutable
BEFORE UPDATE OR DELETE ON "ParticipantTimeAllocationRevision"
FOR EACH ROW EXECUTE FUNCTION ptar_reject_mutation();
CREATE TRIGGER ptar_slice_immutable
BEFORE UPDATE OR DELETE ON "ParticipantTimeAllocationSlice"
FOR EACH ROW EXECUTE FUNCTION ptar_reject_mutation();
CREATE TRIGGER ptar_evidence_immutable
BEFORE UPDATE OR DELETE ON "ParticipantTimeAllocationEvidence"
FOR EACH ROW EXECUTE FUNCTION ptar_reject_mutation();
CREATE TRIGGER ptar_receipt_immutable
BEFORE UPDATE OR DELETE ON "ParticipantTimeAllocationCommandReceipt"
FOR EACH ROW EXECUTE FUNCTION ptar_reject_mutation();

-- The parent has all historical anchors, so they are checked before a child row can exist.  In
-- particular, only a V8 snapshot whose frozen selection resolves to this exact policy triple can
-- start a D3 chain.  A retired but otherwise immutable historical TimePolicyVersion is legal.
CREATE FUNCTION ptar_parent_anchor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_row RECORD;
  snapshot_row RECORD;
  selection_row RECORD;
  version_row RECORD;
  pointer_row RECORD;
  checkin_position_id TEXT;
  previous_row RECORD;
BEGIN
  SELECT segment.*, identity."activityId", identity."sessionId", identity."memberId"
    INTO source_row
    FROM "ParticipantServiceSegmentRevision" segment
    JOIN "ActivityParticipationIdentity" identity ON identity.id = segment."participationIdentityId"
    WHERE segment.id = NEW."sourceSegmentId"
      AND segment."participationIdentityId" = NEW."participationIdentityId"
    FOR SHARE OF segment, identity;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'ptar_source_anchor_guard',
      MESSAGE = 'time allocation source segment is unavailable';
  END IF;
  IF source_row."activityId" IS DISTINCT FROM NEW."activityId"
    OR source_row."sessionId" IS DISTINCT FROM NEW."sessionId"
    OR source_row."memberId" IS DISTINCT FROM NEW."memberId"
    OR source_row."segmentKey" IS DISTINCT FROM NEW."segmentKey"
    OR source_row.revision IS DISTINCT FROM NEW."sourceSegmentRevision"
    OR source_row."statusCode" <> 'committed'
    OR source_row."resultCode" <> 'valid'
    OR source_row."checkOutAt" IS NULL
    OR source_row."checkOutAt" <= source_row."checkInAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_source_anchor_guard',
      MESSAGE = 'time allocation source segment is not a closed valid current fact';
  END IF;

  SELECT "positionId" INTO checkin_position_id
    FROM "AttendancePunchEvent"
    WHERE id = source_row."sourceCheckInEventId";
  IF checkin_position_id IS DISTINCT FROM NEW."sourcePositionId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_source_position_guard',
      MESSAGE = 'time allocation source position differs from the source check-in';
  END IF;

  SELECT * INTO snapshot_row
    FROM "ActivityRuleSnapshot"
    WHERE id = NEW."ruleSnapshotId" AND "activityId" = NEW."activityId"
    FOR SHARE;
  IF NOT FOUND
    OR snapshot_row."timePolicySelectionRevisionId" IS NULL
    OR snapshot_row."timePolicySelectionRevisionId" IS DISTINCT FROM NEW."timePolicySelectionRevisionId"
    OR snapshot_row."snapshotHash" IS DISTINCT FROM NEW."ruleSnapshotHash"
    OR snapshot_row."createdAt" > source_row."checkInAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_snapshot_guard',
      MESSAGE = 'time allocation requires a prior V8 rule snapshot';
  END IF;

  -- A selection pointer alone is not enough: it must be resolved against the same historical
  -- session/position graph that the snapshot froze.  Do not substitute today's SessionPosition
  -- rows here, because a later activity edit must not change the policy basis of this allocation.
  IF jsonb_typeof(snapshot_row."resolvedConfig"->'sessions') <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_snapshot_target_guard',
      MESSAGE = 'time allocation snapshot has no historical session graph';
  END IF;
  IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(snapshot_row."resolvedConfig"->'sessions') AS snapshot_session
      WHERE snapshot_session->>'sessionId' = NEW."sessionId"
        AND (
          NEW."sourcePositionId" IS NULL
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(snapshot_session->'positions') = 'array'
                THEN snapshot_session->'positions' ELSE '[]'::jsonb END
            ) AS snapshot_position
            WHERE snapshot_position->>'positionId' = NEW."sourcePositionId"
          )
        )
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_snapshot_target_guard',
      MESSAGE = 'time allocation source is absent from the frozen rule snapshot';
  END IF;

  SELECT * INTO selection_row
    FROM "ActivityTimePolicySelectionRevision"
    WHERE id = NEW."timePolicySelectionRevisionId" AND "activityId" = NEW."activityId"
    FOR SHARE;
  IF NOT FOUND OR selection_row."selectionHash" IS DISTINCT FROM NEW."selectionHash" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_selection_guard',
      MESSAGE = 'time allocation selection anchor mismatch';
  END IF;

  SELECT item."policyId", item."versionId", item."definitionHash"
    INTO pointer_row
    FROM "ActivityTimePolicySelectionItem" item
    WHERE item."selectionRevisionId" = NEW."timePolicySelectionRevisionId"
      AND item."activityId" = NEW."activityId"
      AND item.mode = 'explicit'
      AND (
        (item."layerCode" = 'position' AND NEW."sourcePositionId" IS NOT NULL
          AND item."sessionId" = NEW."sessionId" AND item."positionId" = NEW."sourcePositionId")
        OR (item."layerCode" = 'session' AND item."sessionId" = NEW."sessionId"
          AND item."positionId" IS NULL)
        OR (item."layerCode" = 'activity' AND item."sessionId" IS NULL
          AND item."positionId" IS NULL)
        OR (item."layerCode" = 'template' AND item."sessionId" IS NULL
          AND item."positionId" IS NULL)
      )
    ORDER BY CASE item."layerCode"
      WHEN 'position' THEN 4 WHEN 'session' THEN 3 WHEN 'activity' THEN 2 WHEN 'template' THEN 1 END DESC
    LIMIT 1;
  IF NOT FOUND
    OR pointer_row."policyId" IS DISTINCT FROM NEW."policyId"
    OR pointer_row."versionId" IS DISTINCT FROM NEW."policyVersionId"
    OR pointer_row."definitionHash" IS DISTINCT FROM NEW."definitionHash"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_selection_pointer_guard',
      MESSAGE = 'time allocation policy does not match the frozen selection';
  END IF;

  SELECT * INTO version_row
    FROM "TimePolicyVersion"
    WHERE id = NEW."policyVersionId"
      AND "policyId" = NEW."policyId"
      AND "definitionHash" = NEW."definitionHash"
    FOR SHARE;
  IF NOT FOUND
    OR version_row."schemaVersion" <> 1
    OR version_row."statusCode" NOT IN ('active', 'retired')
    OR version_row."evaluatorVersion" IS DISTINCT FROM NEW."evaluatorVersion"
    OR version_row."effectiveFrom" > source_row."checkInAt"
    OR (version_row."effectiveUntil" IS NOT NULL
      AND version_row."effectiveUntil" < source_row."checkOutAt")
    OR jsonb_typeof(version_row."definitionJson") <> 'object'
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_policy_anchor_guard',
      MESSAGE = 'time allocation policy is unavailable for the source interval';
  END IF;
  IF NEW."recognitionModeCode" = 'manual'
    AND (version_row."definitionJson"->'manualAdjustment'->>'enabled') IS DISTINCT FROM 'true'
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_manual_policy_guard',
      MESSAGE = 'manual time allocation is not enabled by the policy';
  END IF;
  IF NEW."recognitionModeCode" = 'automatic'
    AND (
      (version_row."definitionJson"->'evidence'->>'requireManualRecognition') = 'true'
      OR EXISTS (
        SELECT 1
        FROM jsonb_each(version_row."definitionJson"->'specialIntervals') interval_item
        WHERE interval_item.value->>'mode' IS DISTINCT FROM 'exclude'
      )
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_automatic_policy_guard',
      MESSAGE = 'policy requires manual time allocation';
  END IF;

  IF NEW.revision = 1 THEN
    IF NEW."previousAllocationRevisionId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_revision_chain_guard',
        MESSAGE = 'first time allocation revision cannot have a predecessor';
    END IF;
  ELSE
    IF NEW."previousAllocationRevisionId" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_revision_chain_guard',
        MESSAGE = 'later time allocation revision requires a predecessor';
    END IF;
    SELECT * INTO previous_row
      FROM "ParticipantTimeAllocationRevision"
      WHERE id = NEW."previousAllocationRevisionId"
      FOR SHARE;
    IF NOT FOUND
      OR previous_row."participationIdentityId" IS DISTINCT FROM NEW."participationIdentityId"
      OR previous_row."segmentKey" IS DISTINCT FROM NEW."segmentKey"
      OR previous_row.revision <> NEW.revision - 1
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_revision_chain_guard',
        MESSAGE = 'time allocation predecessor is not the immediately prior same segment revision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ptar_parent_anchor_guard
BEFORE INSERT ON "ParticipantTimeAllocationRevision"
FOR EACH ROW EXECUTE FUNCTION ptar_parent_anchor_guard();

-- Children must be part of the parent canonical manifest and may be inserted only before the
-- command receipt seals the parent.  The application owns SHA-256 canonicalization; PostgreSQL
-- deliberately compares parsed JSON shape instead of claiming jsonb text rendering is canonical.
CREATE FUNCTION ptar_slice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_row RECORD;
  source_row RECORD;
  manifest_slice JSONB;
  expected_slice JSONB;
  total_seconds NUMERIC;
BEGIN
  SELECT * INTO parent_row
    FROM "ParticipantTimeAllocationRevision"
    WHERE id = NEW."allocationRevisionId" AND "activityId" = NEW."activityId"
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'ptas_parent_guard',
      MESSAGE = 'time allocation parent is unavailable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ParticipantTimeAllocationCommandReceipt"
    WHERE "allocationRevisionId" = parent_row.id AND "activityId" = parent_row."activityId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptas_parent_sealed_guard',
      MESSAGE = 'cannot append time allocation slices to a sealed revision';
  END IF;
  IF NEW.ordinal >= parent_row."sliceCount" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptas_manifest_guard',
      MESSAGE = 'time allocation slice ordinal exceeds the parent manifest';
  END IF;
  SELECT * INTO source_row
    FROM "ParticipantServiceSegmentRevision"
    WHERE id = parent_row."sourceSegmentId"
      AND "participationIdentityId" = parent_row."participationIdentityId"
    FOR SHARE;
  IF NOT FOUND
    OR NEW."startAt" < source_row."checkInAt"
    OR NEW."endAt" > source_row."checkOutAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptas_source_interval_guard',
      MESSAGE = 'time allocation slice lies outside the source segment';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ParticipantTimeAllocationSlice" existing
    WHERE existing."allocationRevisionId" = NEW."allocationRevisionId"
      AND tsrange(existing."startAt", existing."endAt", '[)') &&
          tsrange(NEW."startAt", NEW."endAt", '[)')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptas_overlap_guard',
      MESSAGE = 'time allocation slices overlap';
  END IF;
  SELECT COALESCE(sum(EXTRACT(EPOCH FROM ("endAt" - "startAt"))), 0) INTO total_seconds
    FROM "ParticipantTimeAllocationSlice"
    WHERE "allocationRevisionId" = NEW."allocationRevisionId";
  IF total_seconds + EXTRACT(EPOCH FROM (NEW."endAt" - NEW."startAt")) >
      EXTRACT(EPOCH FROM (source_row."checkOutAt" - source_row."checkInAt"))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptas_total_guard',
      MESSAGE = 'time allocation slices exceed the source segment duration';
  END IF;
  manifest_slice := parent_row."allocationJson"->'slices'->(NEW.ordinal::TEXT);
  expected_slice := jsonb_build_object(
    'categoryCode', NEW."categoryCode",
    'endAt', to_char(NEW."endAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'intervalKindCode', NEW."intervalKindCode",
    'ordinal', NEW.ordinal,
    'startAt', to_char(NEW."startAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  IF manifest_slice IS NULL OR manifest_slice IS DISTINCT FROM expected_slice THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptas_manifest_guard',
      MESSAGE = 'time allocation slice differs from the immutable manifest';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ptas_manifest_guard
BEFORE INSERT ON "ParticipantTimeAllocationSlice"
FOR EACH ROW EXECUTE FUNCTION ptar_slice_guard();

CREATE FUNCTION ptar_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_row RECORD;
  attachment_row RECORD;
BEGIN
  SELECT * INTO parent_row
    FROM "ParticipantTimeAllocationRevision"
    WHERE id = NEW."allocationRevisionId" AND "activityId" = NEW."activityId"
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'ptae_parent_guard',
      MESSAGE = 'time allocation parent is unavailable';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "ParticipantTimeAllocationCommandReceipt"
    WHERE "allocationRevisionId" = parent_row.id AND "activityId" = parent_row."activityId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptae_parent_sealed_guard',
      MESSAGE = 'cannot append evidence to a sealed time allocation revision';
  END IF;
  SELECT * INTO attachment_row FROM "attachments" WHERE id = NEW."attachmentId" FOR SHARE;
  IF NOT FOUND
    OR attachment_row."ownerType" IS DISTINCT FROM 'activity'
    OR attachment_row."ownerId" IS DISTINCT FROM parent_row."activityId"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptae_owner_guard',
      MESSAGE = 'time allocation evidence is not owned by the activity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ptae_owner_guard
BEFORE INSERT ON "ParticipantTimeAllocationEvidence"
FOR EACH ROW EXECUTE FUNCTION ptar_evidence_guard();

CREATE FUNCTION ptar_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_row RECORD;
  source_row RECORD;
  version_row RECORD;
  slice_total INTEGER;
  evidence_total INTEGER;
  manifest_total INTEGER;
  allow_split BOOLEAN;
  requires_attachment BOOLEAN;
  manual_evidence_required BOOLEAN;
BEGIN
  SELECT * INTO parent_row
    FROM "ParticipantTimeAllocationRevision"
    WHERE id = NEW."allocationRevisionId" AND "activityId" = NEW."activityId"
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'ptacr_parent_guard',
      MESSAGE = 'time allocation receipt parent is unavailable';
  END IF;
  IF parent_row."createdByUserId" IS DISTINCT FROM NEW."actorUserId"
    OR parent_row."createdAt" IS DISTINCT FROM NEW."createdAt"
    OR NEW."resultJson"->>'activityId' IS DISTINCT FROM NEW."activityId"
    OR NEW."resultJson"->>'allocationRevisionId' IS DISTINCT FROM NEW."allocationRevisionId"
    OR NEW."resultJson"->>'revision' IS DISTINCT FROM parent_row.revision::TEXT
    OR NEW."resultJson"->>'sourceSegmentId' IS DISTINCT FROM parent_row."sourceSegmentId"
    OR NEW."resultJson"->>'sourceSegmentRevision' IS DISTINCT FROM parent_row."sourceSegmentRevision"::TEXT
    OR NEW."resultJson"->>'recognitionModeCode' IS DISTINCT FROM parent_row."recognitionModeCode"
    OR NEW."resultJson"->>'allocationHash' IS DISTINCT FROM parent_row."allocationHash"
    OR NEW."resultJson"->>'sliceCount' IS DISTINCT FROM parent_row."sliceCount"::TEXT
    OR NEW."resultJson"->>'createdAt' IS DISTINCT FROM
      to_char(NEW."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_result_guard',
      MESSAGE = 'time allocation receipt differs from its created revision';
  END IF;
  SELECT count(*) INTO slice_total
    FROM "ParticipantTimeAllocationSlice"
    WHERE "allocationRevisionId" = parent_row.id AND "activityId" = parent_row."activityId";
  SELECT count(*) INTO evidence_total
    FROM "ParticipantTimeAllocationEvidence"
    WHERE "allocationRevisionId" = parent_row.id AND "activityId" = parent_row."activityId";
  SELECT count(*) INTO manifest_total
    FROM jsonb_object_keys(parent_row."allocationJson"->'slices');
  IF slice_total <> parent_row."sliceCount"
    OR manifest_total <> parent_row."sliceCount"
    OR evidence_total > 500
    OR NEW."resultJson"->>'evidenceCount' IS DISTINCT FROM evidence_total::TEXT
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_complete_guard',
      MESSAGE = 'time allocation receipt has incomplete or excessive children';
  END IF;
  SELECT * INTO source_row
    FROM "ParticipantServiceSegmentRevision"
    WHERE id = parent_row."sourceSegmentId"
      AND "participationIdentityId" = parent_row."participationIdentityId";
  SELECT * INTO version_row
    FROM "TimePolicyVersion"
    WHERE id = parent_row."policyVersionId"
      AND "policyId" = parent_row."policyId"
      AND "definitionHash" = parent_row."definitionHash";
  IF NOT FOUND OR source_row."checkOutAt" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_complete_guard',
      MESSAGE = 'time allocation receipt anchors are unavailable';
  END IF;
  allow_split := (version_row."definitionJson"->>'allowSplit')::BOOLEAN;
  requires_attachment := (version_row."definitionJson"->'evidence'->'requiredSources') ? 'attachment';
  manual_evidence_required := parent_row."recognitionModeCode" = 'manual'
    AND (version_row."definitionJson"->'manualAdjustment'->>'evidenceRequired') = 'true';
  IF (requires_attachment OR manual_evidence_required) AND evidence_total < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_evidence_guard',
      MESSAGE = 'time allocation policy requires attachment evidence';
  END IF;
  IF NOT allow_split AND NOT EXISTS (
    SELECT 1 FROM "ParticipantTimeAllocationSlice"
    WHERE "allocationRevisionId" = parent_row.id
      AND "activityId" = parent_row."activityId"
      AND "startAt" = source_row."checkInAt"
      AND "endAt" = source_row."checkOutAt"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_allow_split_guard',
      MESSAGE = 'non-split time allocation must cover the complete source interval';
  END IF;
  IF NOT allow_split AND slice_total <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptacr_allow_split_guard',
      MESSAGE = 'non-split time allocation must have exactly one slice';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ptacr_receipt_guard
BEFORE INSERT ON "ParticipantTimeAllocationCommandReceipt"
FOR EACH ROW EXECUTE FUNCTION ptar_receipt_guard();

-- A parent created without its first and only command receipt must fail at transaction commit.
-- Subsequent child inserts are already prevented by the child seal guards above.
CREATE FUNCTION ptar_parent_complete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "ParticipantTimeAllocationCommandReceipt"
    WHERE "allocationRevisionId" = NEW.id AND "activityId" = NEW."activityId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ptar_complete_guard',
      MESSAGE = 'time allocation revision requires a command receipt';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER ptar_parent_complete_guard
AFTER INSERT ON "ParticipantTimeAllocationRevision"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION ptar_parent_complete_guard();

COMMIT;
