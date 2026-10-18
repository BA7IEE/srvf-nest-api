-- Preserve the original fixed bucket/source canonical bytes and ordering.
-- Nullable scalars use PostgreSQL JSON rendering; adjustment JSON retains the original
-- recursive canonicalizer. No data, permissions, locks or query predicates change.
CREATE OR REPLACE FUNCTION astr_bucket_content_hash(revision_id TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(
    '{"definition":' || coalesce('[' || string_agg(
      '{"adjustmentReason":' || coalesce(astr_canonical_json(b."adjustmentReason"),'null')
      || ',"calculatedSeconds":' || coalesce(to_jsonb(b."calculatedSeconds")::TEXT,'null')
      || ',"categoryCode":' || coalesce(to_jsonb(b."categoryCode")::TEXT,'null')
      || ',"definitionHash":' || coalesce(to_jsonb(b."definitionHash")::TEXT,'null')
      || ',"emptyReasonCode":' || coalesce(to_jsonb(CASE WHEN b."timePolicyVersionId" IS NULL THEN 'no_valid_segment' ELSE NULL END)::TEXT,'null')
      || ',"evaluatorVersion":' || coalesce(to_jsonb(b."evaluatorVersion")::TEXT,'null')
      || ',"participationIdentityId":' || coalesce(to_jsonb(b."participationIdentityId")::TEXT,'null')
      || ',"quantumSeconds":' || coalesce(to_jsonb(b."quantumSeconds")::TEXT,'null')
      || ',"rawCalculatedMilliseconds":' || coalesce(to_jsonb(b."rawCalculatedMilliseconds"::TEXT)::TEXT,'null')
      || ',"rawRecognizedMilliseconds":' || coalesce(to_jsonb(b."rawRecognizedMilliseconds"::TEXT)::TEXT,'null')
      || ',"recognizedSeconds":' || coalesce(to_jsonb(b."recognizedSeconds")::TEXT,'null')
      || ',"sources":' || coalesce('[' || s.items || ']','[]')
      || ',"timePolicyVersionId":' || coalesce(to_jsonb(b."timePolicyVersionId")::TEXT,'null')
      || '}',
      ',' ORDER BY b."participationIdentityId" COLLATE "C", CASE b."categoryCode"
        WHEN 'volunteer_service' THEN 1 WHEN 'training' THEN 2 WHEN 'organization' THEN 3 ELSE 4 END
    ) || ']','[]') || ',"domain":"activity-time-settlement-buckets-v1"}',
    'UTF8')), 'hex')
  FROM "ParticipantSettlementTimeBucket" b
  -- Keep source lookup bounded by this bucket even when fresh-revision statistics estimate
  -- one row. The existing (bucketId, allocationRevisionId) index bounds the lookup;
  -- do not repeatedly join the entire revision's grouped sources under a nested-loop plan.
  LEFT JOIN LATERAL (
    SELECT string_agg(
      '{"allocationRevisionId":' || coalesce(to_jsonb("allocationRevisionId")::TEXT,'null')
      || ',"rawCalculatedMilliseconds":' || coalesce(to_jsonb("rawCalculatedMilliseconds"::TEXT)::TEXT,'null')
      || ',"rawRecognizedMilliseconds":' || coalesce(to_jsonb("rawRecognizedMilliseconds"::TEXT)::TEXT,'null')
      || ',"sourceSegmentId":' || coalesce(to_jsonb("sourceSegmentId")::TEXT,'null')
      || ',"sourceSegmentRevision":' || coalesce(to_jsonb("sourceSegmentRevision")::TEXT,'null')
      || '}',
      ',' ORDER BY "allocationRevisionId" COLLATE "C")
      FILTER (WHERE "timeRevisionId" = revision_id) AS items
    FROM "ParticipantSettlementTimeBucketSource"
    -- Retain the revision filter in the aggregate, not as a competing scan key: a fresh
    -- revision estimated as one row must not select pstbs_revision_idx once per bucket.
    WHERE "bucketId" = b.id
  ) s ON true WHERE b."timeRevisionId" = revision_id;
$$;
