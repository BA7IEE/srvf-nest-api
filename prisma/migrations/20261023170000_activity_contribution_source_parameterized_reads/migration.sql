-- Forward153: parameterized slice and result reads.
-- Preserve all outer equalities, both branches, multiplicity, weights and function attributes.
BEGIN;

CREATE OR REPLACE FUNCTION e4_source_rows(revision_id TEXT)
RETURNS TABLE(identity_id TEXT, member_id TEXT, session_id TEXT, snapshot_id TEXT,
  item_id TEXT, policy_id TEXT, policy_version_id TEXT, definition_hash TEXT, evaluator_version INTEGER,
  role_code TEXT, category_code TEXT, source_ref JSONB)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
WITH root AS MATERIALIZED (
  SELECT r.*, s."resolvedConfig" FROM "ActivitySettlementContributionRevision" r
  JOIN "ActivityRuleSnapshot" s ON s.id=r."ruleSnapshotId" AND s."activityId"=r."activityId"
  WHERE r.id=revision_id
), raw_sources AS MATERIALIZED (
  SELECT b.id AS bucket_key, b."recognizedSeconds" AS recognized_seconds,
    b."rawRecognizedMilliseconds" AS raw_ms,
    a."participationIdentityId" AS identity_id, a."memberId" AS member_id, a."sessionId" AS session_id,
    a."ruleSnapshotId" AS snapshot_id, a."ruleSnapshotHash" AS snapshot_hash, a."sourcePositionId" AS position_id,
    a.id AS allocation_id, a."allocationHash" AS allocation_hash,
    a."sourceSegmentId" AS segment_id, a."sourceSegmentRevision" AS segment_revision,
    s.id AS slice_key, s."categoryCode" AS category_code, s."startAt" AS starts_at, s."endAt" AS ends_at,
    NULL::JSONB AS correction_source
  FROM root r JOIN "ParticipantSettlementTimeBucket" b ON b."timeRevisionId"=r."timeRevisionId" AND b."activityId"=r."activityId"
  JOIN LATERAL (
    SELECT bs0."bucketId",bs0."activityId",bs0."timeRevisionId",bs0."allocationRevisionId",bs0."sourceSegmentId",bs0."sourceSegmentRevision"
    FROM "ParticipantSettlementTimeBucketSource" bs0
    WHERE bs0."bucketId"=b.id
    OFFSET 0
  ) bs ON bs."bucketId"=b.id AND bs."activityId"=b."activityId" AND bs."timeRevisionId"=b."timeRevisionId"
  JOIN "ParticipantTimeAllocationRevision" a ON a.id=bs."allocationRevisionId" AND a."activityId"=bs."activityId"
    AND a."participationIdentityId"=b."participationIdentityId" AND a."sourceSegmentId"=bs."sourceSegmentId" AND a."sourceSegmentRevision"=bs."sourceSegmentRevision"
  JOIN LATERAL (
    SELECT s0.id,s0."allocationRevisionId",s0."activityId",s0."categoryCode",s0."startAt",s0."endAt"
    FROM "ParticipantTimeAllocationSlice" s0
    WHERE s0."allocationRevisionId"=a.id AND s0."activityId"=a."activityId" AND s0."categoryCode"=b."categoryCode"
    OFFSET 0
  ) s ON s."allocationRevisionId"=a.id AND s."activityId"=a."activityId" AND s."categoryCode"=b."categoryCode"
  JOIN LATERAL (
    SELECT rr0."settlementVersionId",rr0."participationIdentityId",rr0."resultCode"
    FROM "ParticipantSettlementResultRevision" rr0
    WHERE rr0."settlementVersionId"=r."settlementVersionId" AND rr0."participationIdentityId"=a."participationIdentityId" AND rr0."resultCode"='present'
    OFFSET 0
  ) rr ON rr."settlementVersionId"=r."settlementVersionId" AND rr."participationIdentityId"=a."participationIdentityId"
  WHERE r."sourceKindCode"='time_revision' AND rr."resultCode"='present'
  UNION ALL
  SELECT bucket->>'rootEntryId', (bucket->>'recognizedSeconds')::INTEGER,
    NULL::BIGINT, a."participationIdentityId", a."memberId", a."sessionId", a."ruleSnapshotId",a."ruleSnapshotHash",a."sourcePositionId",
    source->>'allocationRevisionId',source->>'allocationHash',source->>'sourceSegmentId',(source->>'sourceSegmentRevision')::INTEGER,
    (source->>'allocationRevisionId') || ':' || (slice->>'ordinal'),slice->>'categoryCode',
    (slice->>'startAt')::TIMESTAMPTZ AT TIME ZONE 'UTC',(slice->>'endAt')::TIMESTAMPTZ AT TIME ZONE 'UTC',
    jsonb_build_object('proofId',p.id,'pendingAllocationId',source->'pendingAllocationId','sourceHash',source->>'sourceHash','sliceOrdinal',slice->'ordinal')
  FROM root r JOIN "CorrectionTimeSourceProof" p ON p.id=r."correctionTimeSourceProofId"
  CROSS JOIN LATERAL jsonb_array_elements(p."sourceSnapshotJson") source
  JOIN "ParticipantTimeAllocationRevision" a ON a.id=source->>'baseAllocationRevisionId' AND a."activityId"=r."activityId"
    AND a."participationIdentityId"=source->>'participationIdentityId'
  CROSS JOIN LATERAL jsonb_array_elements(source->'slices') slice
  JOIN LATERAL jsonb_array_elements(p."calculatedBucketsJson") bucket ON bucket->>'participationIdentityId'=a."participationIdentityId"
    AND bucket->>'categoryCode'=slice->>'categoryCode'
  JOIN "ParticipantSettlementResultRevision" rr ON rr."settlementVersionId"=r."settlementVersionId" AND rr."participationIdentityId"=a."participationIdentityId"
  WHERE r."sourceKindCode"='correction_time_proof' AND rr."resultCode"='present'
), weighted AS MATERIALIZED (
  SELECT x.*, (extract(epoch FROM (ends_at-starts_at))*1000)::BIGINT AS milliseconds,
    row_number() OVER (PARTITION BY bucket_key ORDER BY allocation_id COLLATE "C",slice_key COLLATE "C") AS source_ordinal,
    sum((extract(epoch FROM (ends_at-starts_at))*1000)::BIGINT) OVER (PARTITION BY bucket_key) AS weight_sum
  FROM raw_sources x
), fractions AS MATERIALIZED (
  SELECT w.*, CASE WHEN weight_sum > 0 THEN (recognized_seconds::DOUBLE PRECISION * milliseconds::DOUBLE PRECISION)/weight_sum::DOUBLE PRECISION
    WHEN source_ordinal=1 THEN recognized_seconds::DOUBLE PRECISION ELSE 0::DOUBLE PRECISION END AS exact_seconds
  FROM weighted w
), split AS (
  SELECT f.*, floor(exact_seconds)::INTEGER
      + CASE WHEN row_number() OVER (PARTITION BY bucket_key ORDER BY exact_seconds-floor(exact_seconds) DESC,source_ordinal)
          <= recognized_seconds-sum(floor(exact_seconds)::INTEGER) OVER (PARTITION BY bucket_key) THEN 1 ELSE 0 END AS duration_seconds
  FROM fractions f
), pointers AS MATERIALIZED (
  SELECT r.id, p AS pointer FROM root r CROSS JOIN LATERAL jsonb_array_elements(r."resolvedConfig"->'contributionPolicyPointers'->'resolved') p
)
SELECT x.identity_id,x.member_id,x.session_id,x.snapshot_id,coalesce(position_item.id,activity_item.id),
  p.pointer->'pointer'->>'policyId',p.pointer->'pointer'->>'versionId',p.pointer->'pointer'->>'definitionHash',(p.pointer->'pointer'->>'evaluatorVersion')::INTEGER,
  CASE WHEN x.position_id IS NULL THEN 'member' ELSE role.value->>'attendanceRoleCode' END,
  x.category_code,
  jsonb_build_object('selectionItemId',coalesce(position_item.id,activity_item.id),'allocationRevisionId',x.allocation_id,'sliceId',x.slice_key,
    'sourceSegmentId',x.segment_id,'sourceSegmentRevision',x.segment_revision,'allocationHash',x.allocation_hash,
    'durationSeconds',x.duration_seconds,'startsAt',to_char(x.starts_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt',to_char(x.ends_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    || CASE WHEN x.correction_source IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('correctionSource',x.correction_source) END
FROM split x CROSS JOIN root r
LEFT JOIN pointers p ON p.id=r.id AND (
  (x.position_id IS NULL AND p.pointer->'scope'->>'layerCode'='activity')
  OR (x.position_id IS NOT NULL AND p.pointer->'scope'->>'layerCode'='position'
    AND p.pointer->'scope'->>'sessionId'=x.session_id AND p.pointer->'scope'->>'positionId'=x.position_id))
LEFT JOIN "ActivityContributionPolicySelectionItem" activity_item ON activity_item."selectionRevisionId"=r."selectionRevisionId"
  AND activity_item."activityId"=r."activityId" AND activity_item."layerCode"='activity'
LEFT JOIN "ActivityContributionPolicySelectionItem" position_item ON position_item."selectionRevisionId"=r."selectionRevisionId"
  AND position_item."activityId"=r."activityId" AND position_item."layerCode"='position'
  AND position_item."sessionId"=x.session_id AND position_item."positionId"=x.position_id
LEFT JOIN LATERAL (
  SELECT pos.value FROM jsonb_array_elements(r."resolvedConfig"->'sessions') sess(value)
  CROSS JOIN LATERAL jsonb_array_elements(sess.value->'positions') pos(value)
  WHERE sess.value->>'sessionId'=x.session_id AND pos.value->>'positionId'=x.position_id LIMIT 1
) role ON TRUE
WHERE x.snapshot_id=r."ruleSnapshotId" AND x.snapshot_hash=r."ruleSnapshotHash"
$$;

COMMIT;
