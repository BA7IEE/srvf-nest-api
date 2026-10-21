-- Keep the original canonical fields, null rendering and both orderings.
-- Aggregate the bucket/source join once, rather than starting one aggregate per bucket.
-- No data, guard, privilege, configuration or budget changes.
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
      || ',"sources":' || coalesce('[' || b.source_items || ']','[]')
      || ',"timePolicyVersionId":' || coalesce(to_jsonb(b."timePolicyVersionId")::TEXT,'null')
      || '}',
      ',' ORDER BY b."participationIdentityId" COLLATE "C", CASE b."categoryCode"
        WHEN 'volunteer_service' THEN 1 WHEN 'training' THEN 2 WHEN 'organization' THEN 3 ELSE 4 END
    ) || ']','[]') || ',"domain":"activity-time-settlement-buckets-v1"}',
    'UTF8')), 'hex')
  FROM (
    SELECT b."adjustmentReason", b."calculatedSeconds", b."categoryCode", b."definitionHash", b."evaluatorVersion", b."participationIdentityId", b."quantumSeconds", b."rawCalculatedMilliseconds", b."rawRecognizedMilliseconds", b."recognizedSeconds", b."timePolicyVersionId", string_agg(
      '{"allocationRevisionId":' || coalesce(to_jsonb(s."allocationRevisionId")::TEXT,'null')
      || ',"rawCalculatedMilliseconds":' || coalesce(to_jsonb(s."rawCalculatedMilliseconds"::TEXT)::TEXT,'null')
      || ',"rawRecognizedMilliseconds":' || coalesce(to_jsonb(s."rawRecognizedMilliseconds"::TEXT)::TEXT,'null')
      || ',"sourceSegmentId":' || coalesce(to_jsonb(s."sourceSegmentId")::TEXT,'null')
      || ',"sourceSegmentRevision":' || coalesce(to_jsonb(s."sourceSegmentRevision")::TEXT,'null')
      || '}',
      ',' ORDER BY s."allocationRevisionId" COLLATE "C")
      FILTER (WHERE s."timeRevisionId" = revision_id) AS source_items
    FROM "ParticipantSettlementTimeBucket" b
    LEFT JOIN "ParticipantSettlementTimeBucketSource" s ON s."bucketId" = b.id AND s."timeRevisionId" = revision_id
    WHERE b."timeRevisionId" = revision_id
    GROUP BY b.id
  ) b;
$$;
