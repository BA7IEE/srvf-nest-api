BEGIN;

-- The ordinary proof is a projection of the frozen legacy result version.
-- Both time revisions reference that version, so a remaining settlement draft cannot supply
-- any hours or replace the approved content hash during repair.
CREATE FUNCTION astr_ordinary_root_allowed(activity_id TEXT, version_id TEXT, actor_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "AttendanceSettlementVersion" v
    JOIN "AttendanceSettlementRun" r ON r.id = v."settlementRunId"
    JOIN "Activity" a ON a.id = r."activityId"
    WHERE v.id = version_id AND a.id = activity_id AND v."contributionRegimeCode" = 'legacy'
      AND EXISTS (SELECT 1 FROM "ActivityTimeCutoverReceipt" WHERE id = 'activity-time-v1')
      AND a."currentTimePolicySelectionRevisionId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "ActivityRuleSnapshot" s
        WHERE s."activityId" = a.id AND s."workflowRevision" = v."workflowRevision"
          AND s."timePolicySelectionRevisionId" IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM "ParticipantTimeAllocationRevision" t WHERE t."activityId" = a.id)
      AND NOT EXISTS (SELECT 1 FROM "CorrectionApplication" c WHERE c."newSettlementVersionId" = v.id)
      AND (
        (r."statusCode" = 'drafting' AND v."statusCode" = 'submitted'
          AND v."createdByUserId" = actor_id AND v."submittedAt" IS NOT NULL
          AND v.version = (SELECT max(latest.version) FROM "AttendanceSettlementVersion" latest
            WHERE latest."settlementRunId" = r.id))
        OR
        (r."statusCode" = 'posting' AND v."statusCode" = 'approved'
          AND r."currentSubmittedVersion" = v.version
          AND (SELECT count(*) FROM "SettlementReviewAction" d
            WHERE d."settlementVersionId" = v.id AND d."stageCode" = 'final') = 1
          AND EXISTS (SELECT 1 FROM "SettlementReviewAction" d
            WHERE d."settlementVersionId" = v.id AND d."stageCode" = 'final'
              AND d."actionCode" = 'approve'
              AND EXISTS (SELECT 1 FROM "LedgerPostingBatch" b
                WHERE b."settlementVersionId" = v.id AND b."settlementRunId" = r.id
                AND b."committedAt" IS NULL
                AND ((b."statusCode" = 'preparing' AND v."createdByUserId" = actor_id)
                  OR (b."statusCode" = 'ready' AND d."actorUserId" = actor_id))
                AND NOT EXISTS (SELECT 1 FROM "CorrectionApplication" c WHERE c."newPostingBatchId" = b.id))))
      )
  );
$$;

-- The receipt guard below independently validates policy-free nonzero buckets against the
-- frozen result. Allocation-backed buckets keep their original shape checks.
ALTER TABLE "ParticipantSettlementTimeBucket" DROP CONSTRAINT "pstb_shape_check";
ALTER TABLE "ParticipantSettlementTimeBucket" ADD CONSTRAINT "pstb_shape_check" CHECK ((
  "categoryCode" IN ('volunteer_service', 'training', 'organization', 'non_creditable')
  AND "recognizedSeconds" >= 0 AND ("calculatedSeconds" IS NULL OR "calculatedSeconds" >= 0)
  AND "rawRecognizedMilliseconds" >= 0
  AND ("rawCalculatedMilliseconds" IS NULL OR "rawCalculatedMilliseconds" >= 0)
  AND (("calculatedSeconds" IS NULL) = ("rawCalculatedMilliseconds" IS NULL))
  AND ("adjustmentReason" IS NULL OR (jsonb_typeof("adjustmentReason") = 'array'
    AND jsonb_array_length("adjustmentReason") BETWEEN 1 AND 10000))
  AND ((num_nonnulls("timePolicyVersionId", "definitionHash", "evaluatorVersion", "quantumSeconds") = 0
    AND "calculatedSeconds" IS NOT NULL
    AND ("categoryCode" = 'volunteer_service' OR ("recognizedSeconds" = 0 AND "calculatedSeconds" = 0))
    AND "rawRecognizedMilliseconds" = "recognizedSeconds"::BIGINT * 1000
    AND "rawCalculatedMilliseconds" = "calculatedSeconds"::BIGINT * 1000
    AND "adjustmentReason" IS NULL)
  OR (num_nonnulls("timePolicyVersionId", "definitionHash", "evaluatorVersion", "quantumSeconds") = 4
    AND "definitionHash" ~ '^[0-9a-f]{64}$' AND "evaluatorVersion" > 0
    AND "quantumSeconds" BETWEEN 1 AND 3600
    AND "recognizedSeconds" = ("rawRecognizedMilliseconds" / ("quantumSeconds"::BIGINT * 1000)) * "quantumSeconds"
    AND ("rawCalculatedMilliseconds" IS NULL OR "calculatedSeconds" =
      ("rawCalculatedMilliseconds" / ("quantumSeconds"::BIGINT * 1000)) * "quantumSeconds")))
  AND (("rawCalculatedMilliseconds" IS NOT DISTINCT FROM "rawRecognizedMilliseconds")
    OR "adjustmentReason" IS NOT NULL OR "timePolicyVersionId" IS NULL)
) IS TRUE);

CREATE OR REPLACE FUNCTION astr_parent_anchor_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_row RECORD;
  version_row RECORD;
  source_row RECORD;
  previous_row RECORD;
  seal_row RECORD;
  state_row RECORD;
  current_workflow INTEGER;
  ordinary_root BOOLEAN;
BEGIN
  SELECT "workflowRevision" INTO current_workflow FROM "Activity"
    WHERE id = NEW."activityId" FOR UPDATE;
  SELECT * INTO run_row FROM "AttendanceSettlementRun"
    WHERE id = NEW."settlementRunId" AND "activityId" = NEW."activityId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'astr_run_guard',
      MESSAGE = 'classified settlement run is unavailable';
  END IF;
  SELECT * INTO version_row FROM "AttendanceSettlementVersion"
    WHERE id = NEW."settlementVersionId" AND "settlementRunId" = run_row.id FOR SHARE;
  IF NOT FOUND OR version_row."evidenceSealId" IS DISTINCT FROM NEW."evidenceSealId"
    OR version_row."evidenceRevision" IS DISTINCT FROM NEW."evidenceRevision"
    OR version_row."populationRevision" IS DISTINCT FROM NEW."populationRevision"
    OR version_row."workflowRevision" IS DISTINCT FROM NEW."workflowRevision"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astr_version_guard',
      MESSAGE = 'classified settlement version proof mismatch';
  END IF;
  SELECT * INTO previous_row FROM "ActivitySettlementTimeRevision"
    WHERE "settlementRunId" = run_row.id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision IS DISTINCT FROM coalesce(previous_row.revision, 0) + 1
    OR NEW."previousTimeRevisionId" IS DISTINCT FROM previous_row.id
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astr_previous_guard',
      MESSAGE = 'classified settlement predecessor must be the latest same-run revision';
  END IF;
  ordinary_root := NEW."sourceCount" = 0
    AND NEW."draftContentHash" = version_row."contentHash"
    AND astr_ordinary_root_allowed(NEW."activityId", version_row.id, NEW."createdByUserId")
    AND NOT EXISTS (SELECT 1 FROM "ActivitySettlementTimeRevision" r
      WHERE r."settlementVersionId" = version_row.id AND r."kindCode" = 'submitted');
  IF NEW."kindCode" = 'draft' THEN
    IF NOT ordinary_root AND (run_row."statusCode" <> 'drafting' OR version_row."statusCode" <> 'draft'
      OR version_row.version IS DISTINCT FROM run_row."currentDraftVersion"
      OR version_row."contentHash" IS DISTINCT FROM NEW."draftContentHash")
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astr_current_draft_guard',
        MESSAGE = 'classified settlement requires the current draft';
    END IF;
  ELSE
    SELECT * INTO source_row FROM "ActivitySettlementTimeRevision"
      WHERE id = NEW."sourceDraftTimeRevisionId" AND "settlementRunId" = run_row.id
        AND "activityId" = NEW."activityId";
    IF NOT FOUND OR source_row."kindCode" <> 'draft'
      OR source_row.id IS DISTINCT FROM previous_row.id
      OR NEW."draftContentHash" IS DISTINCT FROM source_row."draftContentHash"
      OR NEW."sourceSetHash" IS DISTINCT FROM source_row."sourceSetHash"
      OR NEW."bucketContentHash" IS DISTINCT FROM source_row."bucketContentHash"
      OR NEW."bucketCount" IS DISTINCT FROM source_row."bucketCount"
      OR NEW."sourceCount" IS DISTINCT FROM source_row."sourceCount"
      OR NEW."evidenceSealId" IS DISTINCT FROM source_row."evidenceSealId"
      OR NEW."evidenceRevision" IS DISTINCT FROM source_row."evidenceRevision"
      OR NEW."populationRevision" IS DISTINCT FROM source_row."populationRevision"
      OR NEW."workflowRevision" IS DISTINCT FROM source_row."workflowRevision"
      OR (
        (ordinary_root AND source_row."settlementVersionId" = version_row.id
          AND source_row."createdByUserId" = NEW."createdByUserId")
        OR (version_row."statusCode" = 'submitted'
          AND source_row."settlementVersionId" <> version_row.id
          AND run_row."statusCode" IN ('drafting', 'pending_first_review')
          AND EXISTS (SELECT 1 FROM "AttendanceSettlementVersion" d
            WHERE d.id = source_row."settlementVersionId" AND d.version = run_row."currentDraftVersion"
              AND d."contentHash" = source_row."draftContentHash" AND d."statusCode" = 'draft'))
      ) IS NOT TRUE
    THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astr_submitted_copy_guard',
        MESSAGE = 'classified submission must copy the current prepared draft in the submit transaction';
    END IF;
  END IF;
  SELECT * INTO seal_row FROM "EvidenceSeal" WHERE id = NEW."evidenceSealId" FOR SHARE;
  SELECT * INTO state_row FROM "ActivityEvidenceState" WHERE "activityId" = NEW."activityId" FOR SHARE;
  IF seal_row.id IS NULL OR seal_row."statusCode" <> 'active'
    OR seal_row."evidenceRevision" IS DISTINCT FROM coalesce(state_row."evidenceRevision", 0)
    OR seal_row."populationRevision" IS DISTINCT FROM coalesce(state_row."populationRevision", 0)
    OR seal_row."workflowRevision" IS DISTINCT FROM current_workflow
    OR seal_row."openSegmentCount" <> 0 OR seal_row."manualReviewPendingCount" <> 0
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astr_current_seal_guard',
      MESSAGE = 'classified settlement seal is not current and closed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION astr_receipt_complete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_row RECORD;
  version_row RECORD;
  draft_id TEXT;
  actual_buckets BIGINT;
  actual_sources BIGINT;
  ordinary_root BOOLEAN;
BEGIN
  SELECT * INTO parent_row FROM "ActivitySettlementTimeRevision"
    WHERE id = NEW."timeRevisionId" AND "activityId" = NEW."activityId" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'astcr_parent_guard',
      MESSAGE = 'classified settlement receipt parent is unavailable';
  END IF;
  SELECT * INTO version_row FROM "AttendanceSettlementVersion" WHERE id = parent_row."settlementVersionId";
  IF parent_row."createdByUserId" IS DISTINCT FROM NEW."actorUserId"
    OR parent_row."createdAt" IS DISTINCT FROM NEW."createdAt"
    OR (parent_row."kindCode" = 'draft' AND NEW."operationCode" <> 'prepare_time_settlement')
    OR (parent_row."kindCode" = 'submitted' AND NEW."operationCode" <> 'submit_time_settlement')
    OR NEW."resultJson" IS DISTINCT FROM jsonb_build_object(
      'schemaVersion', 1, 'activityId', parent_row."activityId", 'timeRevisionId', parent_row.id,
      'revision', parent_row.revision, 'kindCode', parent_row."kindCode",
      'settlementRunId', parent_row."settlementRunId", 'settlementVersionId', parent_row."settlementVersionId",
      'settlementVersion', version_row.version, 'contentHash', version_row."contentHash",
      'bucketContentHash', parent_row."bucketContentHash", 'bucketCount', parent_row."bucketCount",
      'sourceCount', parent_row."sourceCount",
      'createdAt', to_char(parent_row."createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_result_guard',
      MESSAGE = 'classified settlement receipt operation or result does not match its parent';
  END IF;
  draft_id := parent_row."settlementVersionId";
  IF parent_row."kindCode" = 'submitted' THEN
    SELECT "settlementVersionId" INTO draft_id FROM "ActivitySettlementTimeRevision"
      WHERE id = parent_row."sourceDraftTimeRevisionId";
  END IF;
  ordinary_root := draft_id = version_row.id AND version_row."statusCode" <> 'draft';
  IF ordinary_root AND (parent_row."sourceCount" <> 0
    OR NOT astr_ordinary_root_allowed(parent_row."activityId", version_row.id, parent_row."createdByUserId"))
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_ordinary_root_guard',
      MESSAGE = 'ordinary classified time root is unavailable for this settlement version';
  END IF;
  SELECT count(*) INTO actual_buckets FROM "ParticipantSettlementTimeBucket" WHERE "timeRevisionId" = parent_row.id;
  SELECT count(*) INTO actual_sources FROM "ParticipantSettlementTimeBucketSource" WHERE "timeRevisionId" = parent_row.id;
  IF actual_buckets <> parent_row."bucketCount" OR actual_sources <> parent_row."sourceCount"
    OR parent_row."sourceSetHash" IS DISTINCT FROM astr_source_set_hash(parent_row."activityId", draft_id)
    OR parent_row."bucketContentHash" IS DISTINCT FROM astr_bucket_content_hash(parent_row.id)
    OR actual_buckets <> 4 * (SELECT count(*) FROM "ActivityParticipationIdentity"
      WHERE "activityId" = parent_row."activityId" AND "populationIncluded" = true)
    OR EXISTS (SELECT 1 FROM "ActivityParticipationIdentity" i
      WHERE i."activityId" = parent_row."activityId" AND i."populationIncluded" = true
      AND (4 <> (SELECT count(*) FROM "ParticipantSettlementTimeBucket" b
        WHERE b."timeRevisionId" = parent_row.id AND b."participationIdentityId" = i.id)
        OR NOT EXISTS (SELECT 1 FROM "ParticipantSettlementResultRevision" r
          WHERE r."settlementVersionId" = draft_id AND r."participationIdentityId" = i.id
          AND CASE WHEN jsonb_typeof(r."exceptionFlagsJson"->'blockers') = 'array'
            THEN jsonb_array_length(r."exceptionFlagsJson"->'blockers') = 0 ELSE true END)))
    OR EXISTS (SELECT 1 FROM "ParticipantSettlementTimeBucket" b
      JOIN "ActivityParticipationIdentity" i ON i.id = b."participationIdentityId"
      WHERE b."timeRevisionId" = parent_row.id AND i."populationIncluded" <> true)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_complete_guard',
      MESSAGE = 'classified settlement population, source fingerprint, child count or bucket hash mismatch';
  END IF;

  -- Every current population source must be closed. Excluded facts contribute no duration but
  -- were already included in sourceSetHash. Latest revision is checked by segment key, not by
  -- filtering old allocations until a convenient earlier proof happens to match.
  IF EXISTS (
    WITH source_counts AS MATERIALIZED (
      SELECT "allocationRevisionId", count(*) AS sources
      FROM "ParticipantSettlementTimeBucketSource"
      WHERE "timeRevisionId" = parent_row.id GROUP BY "allocationRevisionId"
    )
    SELECT 1 FROM "ParticipantServiceSegmentRevision" s
    JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
    LEFT JOIN LATERAL (SELECT a.* FROM "ParticipantTimeAllocationRevision" a
      WHERE a."participationIdentityId" = i.id AND a."segmentKey" = s."segmentKey"
      ORDER BY a.revision DESC LIMIT 1) a ON true
    WHERE i."activityId" = parent_row."activityId" AND i."populationIncluded" = true
      AND s."statusCode" <> 'superseded'
      AND (s."checkOutAt" IS NULL OR s."statusCode" NOT IN ('draft', 'committed')
        OR s."resultCode" NOT IN ('valid', 'voided', 'replaced', 'early_departure_zero')
        OR (s."resultCode" = 'valid' AND (
          s."checkOutAt" <= s."checkInAt" OR (NOT ordinary_root AND (
          a.id IS NULL OR a."sourceSegmentId" <> s.id
          OR a."sourceSegmentRevision" <> s.revision
          OR (s."statusCode" = 'draft' AND (
            a."settlementDraftVersionId" IS DISTINCT FROM draft_id
            OR a."settlementEvidenceSealId" IS DISTINCT FROM parent_row."evidenceSealId"
            OR a."settlementEvidenceRevision" IS DISTINCT FROM parent_row."evidenceRevision"
            OR a."settlementPopulationRevision" IS DISTINCT FROM parent_row."populationRevision"
            OR a."settlementWorkflowRevision" IS DISTINCT FROM parent_row."workflowRevision"
            OR a."settlementDraftContentHash" IS DISTINCT FROM parent_row."draftContentHash"))
          OR (s."statusCode" = 'committed' AND a."settlementDraftVersionId" IS NOT NULL)
          -- Allocation IDs are NOT NULL. Membership in this once-grouped set is exactly
          -- equivalent to the old correlated count = 4, including a missing source group.
          OR a.id NOT IN (SELECT "allocationRevisionId" FROM source_counts WHERE sources = 4)
        )))))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_source_ready_guard',
      MESSAGE = 'classified settlement requires all latest applicable closed source allocations';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (SELECT i."memberId", s."checkInAt",
      max(s."checkOutAt") OVER (PARTITION BY i."memberId" ORDER BY s."checkInAt", s.id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior_end
      FROM "ParticipantServiceSegmentRevision" s
      JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
      WHERE i."activityId" = parent_row."activityId" AND i."populationIncluded" = true
        AND s."statusCode" <> 'superseded' AND s."resultCode" = 'valid'
    ) intervals WHERE "checkInAt" < prior_end
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_overlap_guard',
      MESSAGE = 'classified settlement sources overlap for the same member';
  END IF;

  -- Derive each source's raw recognized interval sum and frozen automatic baseline independently
  -- of caller-supplied seconds. The allocation index bounds slice visits: the readiness guard
  -- requires exactly four sources per allocation, so at most four visits per applicable slice.
  -- Do not join an unindexed all-allocation aggregate back to every source on cold statistics.
  IF EXISTS (
    WITH source_facts AS (
      SELECT bs.*, b."participationIdentityId", b."categoryCode", b."timePolicyVersionId",
        b."definitionHash" AS bucket_hash, b."evaluatorVersion" AS bucket_evaluator, b."quantumSeconds",
        a."participationIdentityId" AS allocation_identity, a."policyVersionId", a."definitionHash",
        a."evaluatorVersion", a."sessionId", a."sourcePositionId", a."revision" AS allocation_revision,
        a."segmentKey", segment."statusCode", segment."resultCode", segment."checkInAt", segment."checkOutAt",
        policy."definitionJson",
        (SELECT coalesce(sum(extract(epoch FROM (slice."endAt" - slice."startAt")) * 1000), 0)
          FROM "ParticipantTimeAllocationSlice" slice
          WHERE slice."allocationRevisionId" = a.id AND slice."categoryCode" = b."categoryCode"
        ) AS expected_recognized,
        (SELECT position_item->>'attendanceRoleCode'
          FROM jsonb_array_elements(snapshot."resolvedConfig"->'sessions') session_item,
            jsonb_array_elements(session_item->'positions') position_item
          WHERE session_item->>'sessionId' = a."sessionId"
            AND position_item->>'positionId' = a."sourcePositionId") AS role_code
      FROM "ParticipantSettlementTimeBucketSource" bs
      JOIN "ParticipantSettlementTimeBucket" b ON b.id = bs."bucketId"
      JOIN "ParticipantTimeAllocationRevision" a ON a.id = bs."allocationRevisionId"
      JOIN "ParticipantServiceSegmentRevision" segment ON segment.id = a."sourceSegmentId"
      JOIN "TimePolicyVersion" policy ON policy.id = a."policyVersionId"
      JOIN "ActivityRuleSnapshot" snapshot ON snapshot.id = a."ruleSnapshotId"
      WHERE bs."timeRevisionId" = parent_row.id
    )
    SELECT 1 FROM source_facts f
    WHERE f."participationIdentityId" <> f.allocation_identity
      OR f."timePolicyVersionId" IS DISTINCT FROM f."policyVersionId"
      OR f.bucket_hash IS DISTINCT FROM f."definitionHash"
      OR f.bucket_evaluator IS DISTINCT FROM f."evaluatorVersion"
      OR f."quantumSeconds" IS DISTINCT FROM (f."definitionJson"->'rounding'->>'quantumSeconds')::INTEGER
      OR f."statusCode" = 'superseded' OR f."resultCode" <> 'valid' OR f."checkOutAt" IS NULL
      OR f."rawRecognizedMilliseconds" IS DISTINCT FROM f.expected_recognized
      OR f."rawCalculatedMilliseconds" IS DISTINCT FROM (
        CASE WHEN (f."definitionJson"->'evidence'->>'requireManualRecognition')::BOOLEAN
          OR EXISTS (SELECT 1 FROM jsonb_each(f."definitionJson"->'specialIntervals') item
            WHERE item.value->>'mode' IS DISTINCT FROM 'exclude') THEN NULL
        WHEN f."categoryCode" = coalesce((SELECT item->>'category'
          FROM jsonb_array_elements(f."definitionJson"->'roleMappings') item
          WHERE item->>'attendanceRoleCode' = f.role_code), f."definitionJson"->>'defaultCategory')
          THEN extract(epoch FROM (f."checkOutAt" - f."checkInAt")) * 1000
        ELSE 0 END)
      OR EXISTS (SELECT 1 FROM "ParticipantTimeAllocationRevision" newer
        WHERE newer."participationIdentityId" = f.allocation_identity
          AND newer."segmentKey" = f."segmentKey" AND newer.revision > f.allocation_revision)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_bucket_source_guard',
      MESSAGE = 'classified bucket source, frozen policy or derived duration mismatch';
  END IF;

  IF ordinary_root THEN
    -- The complete population check above already requires four buckets per included identity.
    -- The bucket unique key and closed category set ensure one row per category.
    IF EXISTS (
      SELECT 1 FROM "ParticipantSettlementResultRevision" r
      JOIN "ActivityParticipationIdentity" i ON i.id = r."participationIdentityId"
      WHERE r."settlementVersionId" = version_row.id
        AND (i."activityId" <> parent_row."activityId" OR r."statusCode" <> 'draft'
          OR r."correctionRequestId" IS NOT NULL)
    ) OR EXISTS (
      SELECT 1 FROM "ParticipantSettlementTimeBucket" b
      JOIN "ParticipantSettlementResultRevision" r ON r."settlementVersionId" = version_row.id
        AND r."participationIdentityId" = b."participationIdentityId"
      WHERE b."timeRevisionId" = parent_row.id
        AND (b."timePolicyVersionId" IS NOT NULL
          OR b."recognizedSeconds" IS DISTINCT FROM
            CASE WHEN b."categoryCode" = 'volunteer_service' THEN r."recognizedServiceHours" * 3600 ELSE 0 END
          OR b."calculatedSeconds" IS DISTINCT FROM
            CASE WHEN b."categoryCode" = 'volunteer_service' THEN r."calculatedServiceHours" * 3600 ELSE 0 END)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_ordinary_bucket_guard',
        MESSAGE = 'ordinary classified time buckets differ from the frozen settlement results';
    END IF;
  ELSIF EXISTS (
    -- Keep this bounded aggregate single-evaluation even before fresh-table statistics exist.
    WITH totals AS MATERIALIZED (
      SELECT s."bucketId", count(*) AS sources,
        sum(s."rawRecognizedMilliseconds") AS recognized,
        CASE WHEN bool_or(s."rawCalculatedMilliseconds" IS NULL) THEN NULL
          ELSE sum(s."rawCalculatedMilliseconds") END AS calculated,
        jsonb_agg(jsonb_build_object('allocationRevisionId', a.id, 'manualReason', a."manualReason")
          ORDER BY a.id COLLATE "C") FILTER (WHERE a."recognitionModeCode" = 'manual') AS reasons
      FROM "ParticipantSettlementTimeBucketSource" s
      JOIN "ParticipantTimeAllocationRevision" a ON a.id = s."allocationRevisionId"
      WHERE s."timeRevisionId" = parent_row.id GROUP BY s."bucketId"
    ), expected AS (
      SELECT t."bucketId", true AS has_policy, t.recognized, t.calculated, t.reasons FROM totals t
      UNION ALL
      SELECT b.id, false, 0::NUMERIC, 0::NUMERIC, NULL::JSONB
      FROM "ParticipantSettlementTimeBucket" b
      WHERE b."timeRevisionId" = parent_row.id AND NOT EXISTS (
        SELECT 1 FROM "ParticipantSettlementTimeBucketSource" s WHERE s."bucketId" = b.id
      )
    )
    -- EXCEPT compares NULLs as equal, preserving the IS DISTINCT FROM checks above without
    -- repeatedly traversing an unindexed aggregate for every bucket. IDs make each row unique.
    SELECT b.id, b."timePolicyVersionId" IS NOT NULL,
      b."rawRecognizedMilliseconds"::NUMERIC, b."rawCalculatedMilliseconds"::NUMERIC,
      b."adjustmentReason"
    FROM "ParticipantSettlementTimeBucket" b WHERE b."timeRevisionId" = parent_row.id
    EXCEPT
    SELECT "bucketId", has_policy, recognized, calculated, reasons FROM expected
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_bucket_total_guard',
      MESSAGE = 'classified bucket totals or retained manual reasons mismatch';
  END IF;
  IF (SELECT count(*) FROM "ParticipantTimeAllocationSlice" WHERE "allocationRevisionId" IN
      (SELECT "allocationRevisionId" FROM "ParticipantSettlementTimeBucketSource" WHERE "timeRevisionId" = parent_row.id)) > 50000
    OR (SELECT count(*) FROM "ParticipantServiceSegmentRevision" s
      JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
      WHERE i."activityId" = parent_row."activityId" AND s."statusCode" <> 'superseded') > 10000
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_scale_guard',
      MESSAGE = 'classified settlement source scale exceeds the approved bound';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION ptl_manifest_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM b."id" FROM "LedgerPostingBatch" b
    JOIN (SELECT DISTINCT "postingBatchId" FROM ptl_new_manifests) n ON n."postingBatchId" = b."id"
    ORDER BY b."id" FOR UPDATE OF b;
  IF EXISTS (
    SELECT 1 FROM ptl_new_manifests m
    JOIN "LedgerPostingBatch" b ON b."id" = m."postingBatchId"
    JOIN "ActivitySettlementTimeRevision" r ON r."id" = m."timeRevisionId"
    WHERE b."committedAt" IS NOT NULL OR NOT (b."statusCode" = 'preparing' OR (b."statusCode" = 'ready'
        AND EXISTS (SELECT 1 FROM "ActivitySettlementTimeRevision" d
          WHERE d.id = r."sourceDraftTimeRevisionId"
            AND d."settlementVersionId" = b."settlementVersionId")
        AND astr_ordinary_root_allowed(r."activityId", r."settlementVersionId", r."createdByUserId"))) OR r."kindCode" <> 'submitted'
      OR r."bucketContentHash" <> m."bucketContentHash" OR r."sourceSetHash" <> m."sourceSetHash"
      OR r."bucketCount" <> m."expectedEntryCount"
      OR (SELECT count(*) FROM "ParticipantSettlementTimeBucket" s WHERE s."timeRevisionId" = r."id") <> m."expectedEntryCount"
      OR (SELECT COALESCE(sum(s."recognizedSeconds"), 0) FROM "ParticipantSettlementTimeBucket" s WHERE s."timeRevisionId" = r."id") <> m."recognizedSecondsTotal"
  ) THEN
    RAISE EXCEPTION 'invalid classified time ledger source' USING ERRCODE = '23514', CONSTRAINT = 'ptlm_source_guard';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION ptl_entry_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM b."id" FROM "LedgerPostingBatch" b
    JOIN (SELECT DISTINCT "postingBatchId" FROM ptl_new_entries) n ON n."postingBatchId" = b."id"
    ORDER BY b."id" FOR UPDATE OF b;
  IF EXISTS (
    SELECT 1
    FROM (SELECT DISTINCT "postingBatchId", "manifestId" FROM ptl_new_entries) e
    JOIN "LedgerPostingBatch" b ON b.id = e."postingBatchId"
    JOIN "ParticipationTimeLedgerManifest" m ON m.id = e."manifestId"
    JOIN "ActivitySettlementTimeRevision" r ON r.id = m."timeRevisionId"
    WHERE b."committedAt" IS NOT NULL OR NOT (b."statusCode" = 'preparing' OR (b."statusCode" = 'ready'
        AND EXISTS (SELECT 1 FROM "ActivitySettlementTimeRevision" d
          WHERE d.id = r."sourceDraftTimeRevisionId"
            AND d."settlementVersionId" = b."settlementVersionId")
        AND astr_ordinary_root_allowed(r."activityId", r."settlementVersionId", r."createdByUserId")))
  ) THEN
    RAISE EXCEPTION 'classified time ledger batch does not accept entries' USING ERRCODE = '23514', CONSTRAINT = 'ptle_batch_guard';
  END IF;
  RETURN NULL;
END;
$$;

COMMIT;
