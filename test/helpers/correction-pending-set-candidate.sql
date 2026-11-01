-- LOCAL, UNINSTALLED CANDIDATE. Not a migration, guard replacement or acceptance.
-- Only the approved-input membership predicates are represented here. Existing
-- chain, row immutability, policy, evidence and cleanup checks remain required.
-- $1: application id; $2: full attempted rows, including would-be conflicts.
-- Output is ordinals only; duplicate matches must not multiply attempted rows.
-- Do not execute this file as part of the normal E2E entrypoint.
--
-- These statements expose the proposed relation shape before any DDL/ACL work.
-- A materialized CTE is statement-local, not a reusable validation certificate.
-- Real PG differential tests are still required for invalid conversion ordering,
-- NULL vs missing fields, duplicate documents, and a verified bounded join plan.
-- AFTER transition tables alone cannot supply all ON CONFLICT attempted rows.

WITH source AS MATERIALIZED (
  SELECT request."requestedChangeJson" AS document
  FROM "CorrectionApplication" application
  JOIN "AttendanceCorrectionRequest" request
    ON request.id = application."correctionRequestId"
  WHERE application.id = $1::text
), approved AS MATERIALIZED (
  SELECT item.value
  FROM source CROSS JOIN LATERAL jsonb_array_elements(document->'segments') item(value)
), attempted AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset($2::jsonb) AS input(
    ordinal bigint, "participationIdentityId" text, "segmentKey" text,
    "resultCode" text, "serviceHours" numeric,
    "checkInAt" timestamp, "checkOutAt" timestamp
  )
)
SELECT attempted.ordinal AS rejected_ordinal
FROM attempted
WHERE NOT EXISTS (
  SELECT 1 FROM approved
  WHERE value->>'participationIdentityId' = attempted."participationIdentityId"
    AND value->>'segmentKey' = attempted."segmentKey"
    AND value->>'resultCode' = attempted."resultCode"
    AND (value->>'serviceHours')::numeric = attempted."serviceHours"
    AND (value->>'checkInAt')::timestamptz = attempted."checkInAt" AT TIME ZONE 'UTC'
    AND (value->>'checkOutAt')::timestamptz = attempted."checkOutAt" AT TIME ZONE 'UTC'
)
ORDER BY attempted.ordinal;

WITH source AS MATERIALIZED (
  SELECT request."requestedChangeJson" AS document
  FROM "CorrectionApplication" application
  JOIN "AttendanceCorrectionRequest" request
    ON request.id = application."correctionRequestId"
  WHERE application.id = $1::text
), approved AS MATERIALIZED (
  SELECT item.value
  FROM source CROSS JOIN LATERAL jsonb_array_elements(document->'allocations') item(value)
), attempted AS MATERIALIZED (
  SELECT * FROM jsonb_to_recordset($2::jsonb) AS input(
    ordinal bigint, "participationIdentityId" text, "segmentKey" text,
    "baseSegmentRevisionId" text, "baseAllocationRevisionId" text,
    "recognitionModeCode" text, "manualReason" text, "sliceCount" integer
  )
)
SELECT attempted.ordinal AS rejected_ordinal
FROM attempted
WHERE NOT EXISTS (
  SELECT 1 FROM approved
  WHERE value->>'participationIdentityId' = attempted."participationIdentityId"
    AND value->>'segmentKey' = attempted."segmentKey"
    AND value->>'baseSegmentRevisionId' = attempted."baseSegmentRevisionId"
    AND value->>'baseAllocationRevisionId' = attempted."baseAllocationRevisionId"
    AND value->>'recognitionModeCode' = attempted."recognitionModeCode"
    AND value->'manualReason' IS NOT DISTINCT FROM
      COALESCE(to_jsonb(attempted."manualReason"), 'null'::jsonb)
    AND jsonb_typeof(value->'slices') = 'array'
    AND (
      (attempted."recognitionModeCode" = 'automatic' AND jsonb_array_length(value->'slices') = 0)
      OR (attempted."recognitionModeCode" = 'manual'
        AND jsonb_array_length(value->'slices') = attempted."sliceCount")
    )
)
ORDER BY attempted.ordinal;
