-- #1295: additive pending inputs and durable count receipts. No historical backfill.
BEGIN;

CREATE TABLE "CorrectionPendingSegmentRevision" (
  "id" TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applicationId" TEXT NOT NULL,
  "activityId" TEXT NOT NULL,
  "participationIdentityId" TEXT NOT NULL,
  "segmentKey" TEXT NOT NULL,
  "baseRevisionId" TEXT NOT NULL,
  "baseRevisionNumber" INTEGER NOT NULL,
  "targetRevisionNumber" INTEGER NOT NULL,
  "checkInAt" TIMESTAMP(3) NOT NULL,
  "checkOutAt" TIMESTAMP(3) NOT NULL,
  "resultCode" TEXT NOT NULL,
  "serviceHours" DECIMAL(5,2) NOT NULL,
  "sourceCheckInEventId" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  CONSTRAINT "CorrectionPendingSegmentRevision_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "CorrectionApplication"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CorrectionPendingSegmentRevision_participationIdentityId_fkey" FOREIGN KEY ("participationIdentityId") REFERENCES "ActivityParticipationIdentity"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CorrectionPendingSegmentRevision_baseRevisionId_fkey" FOREIGN KEY ("baseRevisionId") REFERENCES "ParticipantServiceSegmentRevision"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "CorrectionPendingSegmentRevision_sourceCheckInEventId_fkey" FOREIGN KEY ("sourceCheckInEventId") REFERENCES "AttendancePunchEvent"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT correction_pending_shape CHECK (
    "baseRevisionNumber" >= 0 AND "targetRevisionNumber" = "baseRevisionNumber" + 1
    AND "checkOutAt" >= "checkInAt" AND "serviceHours" BETWEEN 0 AND 24
    AND "resultCode" IN ('valid', 'early_departure_zero', 'voided', 'replaced')
    AND "payloadHash" ~ '^[0-9a-f]{64}$' AND length("segmentKey") > 0
  )
);
CREATE UNIQUE INDEX correction_pending_application_identity_segment_key ON "CorrectionPendingSegmentRevision"("applicationId", "participationIdentityId", "segmentKey");
CREATE INDEX correction_pending_base_idx ON "CorrectionPendingSegmentRevision"("baseRevisionId");

CREATE TABLE "CorrectionSegmentPreparationReceipt" (
  "applicationId" TEXT PRIMARY KEY,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "preparedSegmentCount" INTEGER NOT NULL,
  "preparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CorrectionSegmentPreparationReceipt_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "CorrectionApplication"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT correction_preparation_receipt_shape CHECK ("schemaVersion" = 1 AND "preparedSegmentCount" >= 0)
);
CREATE TABLE "CorrectionSegmentCleanupReceipt" (
  "applicationId" TEXT PRIMARY KEY,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "preparedSegmentCount" INTEGER NOT NULL,
  "deletedSegmentCount" INTEGER NOT NULL,
  "cleanedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "databasePrincipal" TEXT NOT NULL,
  "authorizationReference" TEXT NOT NULL,
  CONSTRAINT "CorrectionSegmentCleanupReceipt_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "CorrectionApplication"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT correction_cleanup_receipt_shape CHECK (
    "schemaVersion" = 1 AND "preparedSegmentCount" BETWEEN 0 AND 2000
    AND "deletedSegmentCount" = "preparedSegmentCount"
    AND "authorizationReference" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND length("databasePrincipal") > 0
  )
);

CREATE FUNCTION correction_segment_receipt_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'correction segment receipt is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER correction_preparation_receipt_immutable BEFORE UPDATE OR DELETE
ON "CorrectionSegmentPreparationReceipt" FOR EACH ROW EXECUTE FUNCTION correction_segment_receipt_immutable();
CREATE TRIGGER correction_cleanup_receipt_immutable BEFORE UPDATE OR DELETE
ON "CorrectionSegmentCleanupReceipt" FOR EACH ROW EXECUTE FUNCTION correction_segment_receipt_immutable();

-- Validate one immutable input against the approved request and exact base chain.
CREATE FUNCTION correction_pending_segment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE approved JSONB; app_status TEXT; request_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'pending segment is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "CorrectionSegmentCleanupReceipt" WHERE "applicationId" = OLD."applicationId") THEN
      RAISE EXCEPTION 'pending deletion requires cleanup receipt' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT r."requestedChangeJson", a."statusCode", r."statusCode"
    INTO approved, app_status, request_status
    FROM "CorrectionApplication" a JOIN "AttendanceCorrectionRequest" r ON r.id = a."correctionRequestId"
    JOIN "ActivityParticipationIdentity" i ON i.id = NEW."participationIdentityId" AND i."activityId" = r."activityId"
    JOIN "ParticipantServiceSegmentRevision" b ON b.id = NEW."baseRevisionId"
      AND b."participationIdentityId" = i.id AND b."segmentKey" = NEW."segmentKey"
      AND b.revision = NEW."baseRevisionNumber" AND b."statusCode" = 'committed'
      AND b."sourceCheckInEventId" = NEW."sourceCheckInEventId"
    JOIN "AttendancePunchEvent" e ON e.id = NEW."sourceCheckInEventId"
      AND e."participationIdentityId" = i.id AND e."activityId" = r."activityId"
    WHERE a.id = NEW."applicationId" AND r."activityId" = NEW."activityId";
  IF NOT FOUND OR app_status <> 'preparing' OR request_status NOT IN ('approved', 'applying')
     OR EXISTS (SELECT 1 FROM "CorrectionSegmentCleanupReceipt" WHERE "applicationId" = NEW."applicationId") THEN
    RAISE EXCEPTION 'invalid pending segment chain or lifecycle' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(approved->'segments') c
    WHERE c->>'participationIdentityId' = NEW."participationIdentityId"
      AND c->>'segmentKey' = NEW."segmentKey" AND c->>'resultCode' = NEW."resultCode"
      AND (c->>'serviceHours')::numeric = NEW."serviceHours"
      AND (c->>'checkInAt')::timestamptz = NEW."checkInAt" AT TIME ZONE 'UTC'
      AND (c->>'checkOutAt')::timestamptz = NEW."checkOutAt" AT TIME ZONE 'UTC'
  ) THEN
    RAISE EXCEPTION 'pending segment differs from approved input' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER correction_pending_segment_guard BEFORE INSERT OR UPDATE OR DELETE
ON "CorrectionPendingSegmentRevision" FOR EACH ROW EXECUTE FUNCTION correction_pending_segment_guard();

-- Deferred checks observe the complete prepare/cleanup transaction, not row order.
CREATE FUNCTION correction_segment_lifecycle_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE app_id TEXT; prepared INTEGER; remaining INTEGER; cleaned INTEGER; expected INTEGER;
BEGIN
  IF TG_TABLE_NAME = 'CorrectionApplication' THEN app_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN app_id := OLD."applicationId";
  ELSE app_id := NEW."applicationId"; END IF;
  SELECT "preparedSegmentCount" INTO prepared FROM "CorrectionSegmentPreparationReceipt" WHERE "applicationId" = app_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'new application requires preparation receipt' USING ERRCODE = '23514'; END IF;
  SELECT jsonb_array_length(r."requestedChangeJson"->'segments') INTO expected
    FROM "CorrectionApplication" a JOIN "AttendanceCorrectionRequest" r ON r.id = a."correctionRequestId" WHERE a.id = app_id;
  SELECT count(*) INTO remaining FROM "CorrectionPendingSegmentRevision" WHERE "applicationId" = app_id;
  SELECT "deletedSegmentCount" INTO cleaned FROM "CorrectionSegmentCleanupReceipt" WHERE "applicationId" = app_id;
  IF prepared IS DISTINCT FROM expected OR
     (cleaned IS NULL AND remaining <> prepared) OR
     (cleaned IS NOT NULL AND (cleaned <> prepared OR remaining <> 0)) THEN
    RAISE EXCEPTION 'inconsistent pending segment lifecycle counts' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER correction_application_preparation_receipt_required
AFTER INSERT ON "CorrectionApplication" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION correction_segment_lifecycle_check();
CREATE CONSTRAINT TRIGGER correction_pending_lifecycle_check
AFTER INSERT OR DELETE ON "CorrectionPendingSegmentRevision" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION correction_segment_lifecycle_check();
CREATE CONSTRAINT TRIGGER correction_preparation_lifecycle_check
AFTER INSERT ON "CorrectionSegmentPreparationReceipt" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION correction_segment_lifecycle_check();
CREATE CONSTRAINT TRIGGER correction_cleanup_lifecycle_check
AFTER INSERT ON "CorrectionSegmentCleanupReceipt" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION correction_segment_lifecycle_check();

-- Called only through a separately approved operator session. No privilege elevation.
CREATE FUNCTION correction_segment_cleanup_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE activity_id TEXT; run_id TEXT; request_id TEXT; batch_id TEXT; prepared INTEGER; actual INTEGER;
BEGIN
  SELECT r."activityId", r."settlementRunId", r.id INTO activity_id, run_id, request_id
  FROM "CorrectionApplication" a JOIN "AttendanceCorrectionRequest" r ON r.id = a."correctionRequestId"
  WHERE a.id = NEW."applicationId";
  IF NOT FOUND THEN RAISE EXCEPTION 'cleanup application missing' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM "Activity" WHERE id = activity_id FOR UPDATE;
  PERFORM 1 FROM "AttendanceSettlementRun" WHERE id = run_id FOR UPDATE;
  PERFORM 1 FROM "AttendanceCorrectionRequest" WHERE id = request_id FOR UPDATE;
  SELECT "newPostingBatchId" INTO batch_id FROM "CorrectionApplication"
    WHERE id = NEW."applicationId" AND "statusCode" = 'committed' FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM "LedgerPostingBatch" WHERE id = batch_id AND "statusCode" = 'committed') THEN
    RAISE EXCEPTION 'cleanup requires successful application and batch' USING ERRCODE = '23514';
  END IF;
  SELECT "preparedSegmentCount" INTO prepared FROM "CorrectionSegmentPreparationReceipt" WHERE "applicationId" = NEW."applicationId";
  SELECT count(*) INTO actual FROM "CorrectionPendingSegmentRevision" WHERE "applicationId" = NEW."applicationId";
  IF prepared IS NULL OR prepared <> actual OR prepared <> NEW."preparedSegmentCount"
    OR NEW."deletedSegmentCount" <> prepared OR NEW."databasePrincipal" <> session_user THEN
    RAISE EXCEPTION 'cleanup receipt count or operator mismatch' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "CorrectionPendingSegmentRevision" p WHERE p."applicationId" = NEW."applicationId"
    AND NOT EXISTS (
      SELECT 1 FROM "ParticipantServiceSegmentRevision" s
      JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
      WHERE s."baseRevisionId" = p."baseRevisionId" AND s.revision = p."targetRevisionNumber"
        AND s."participationIdentityId" = p."participationIdentityId" AND s."segmentKey" = p."segmentKey"
        AND s."effectiveBatchId" = batch_id AND s."statusCode" IN ('committed', 'superseded')
        AND i."activityId" = activity_id AND p."activityId" = activity_id
        AND s."sourceCheckInEventId" = p."sourceCheckInEventId"
        AND s."checkInAt" = p."checkInAt" AND s."checkOutAt" = p."checkOutAt"
        AND s."resultCode" = p."resultCode" AND s."serviceHours" = p."serviceHours"
    )
  ) THEN RAISE EXCEPTION 'cleanup lacks exact materialized history' USING ERRCODE = '23514'; END IF;
  NEW."cleanedAt" := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER correction_cleanup_guard BEFORE INSERT ON "CorrectionSegmentCleanupReceipt"
FOR EACH ROW EXECUTE FUNCTION correction_segment_cleanup_guard();

CREATE FUNCTION cleanup_correction_pending_segment(application_id TEXT, authorization_reference TEXT)
RETURNS TABLE ("preparedSegmentCount" INTEGER, "deletedSegmentCount" INTEGER, "replayed" BOOLEAN)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $$
DECLARE activity_id TEXT; run_id TEXT; request_id TEXT; prepared INTEGER; deleted INTEGER;
BEGIN
  IF application_id IS NULL OR application_id !~ '^[A-Za-z0-9_-]{1,128}$'
    OR authorization_reference IS NULL OR authorization_reference !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
    RAISE EXCEPTION 'explicit application and authorization reference required' USING ERRCODE = '23514';
  END IF;
  SELECT r."activityId", r."settlementRunId", r.id INTO activity_id, run_id, request_id
    FROM "CorrectionApplication" a JOIN "AttendanceCorrectionRequest" r ON r.id = a."correctionRequestId"
    WHERE a.id = application_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'cleanup application missing' USING ERRCODE = '23514'; END IF;
  PERFORM 1 FROM "Activity" WHERE id = activity_id FOR UPDATE;
  PERFORM 1 FROM "AttendanceSettlementRun" WHERE id = run_id FOR UPDATE;
  PERFORM 1 FROM "AttendanceCorrectionRequest" WHERE id = request_id FOR UPDATE;
  PERFORM 1 FROM "CorrectionApplication" WHERE id = application_id FOR UPDATE;
  SELECT r."preparedSegmentCount", r."deletedSegmentCount" INTO prepared, deleted
    FROM "CorrectionSegmentCleanupReceipt" r WHERE r."applicationId" = application_id;
  IF FOUND THEN
    IF EXISTS (SELECT 1 FROM "CorrectionPendingSegmentRevision" WHERE "applicationId" = application_id)
      OR NOT EXISTS (SELECT 1 FROM "CorrectionSegmentPreparationReceipt" r WHERE r."applicationId" = application_id AND r."preparedSegmentCount" = prepared) THEN
      RAISE EXCEPTION 'corrupt cleanup replay' USING ERRCODE = '23514';
    END IF;
    RETURN QUERY SELECT prepared, deleted, true;
    RETURN;
  END IF;
  SELECT r."preparedSegmentCount" INTO prepared FROM "CorrectionSegmentPreparationReceipt" r WHERE r."applicationId" = application_id;
  IF NOT FOUND OR prepared > 2000 THEN RAISE EXCEPTION 'missing receipt or cleanup limit exceeded' USING ERRCODE = '23514'; END IF;
  INSERT INTO "CorrectionSegmentCleanupReceipt" (
    "applicationId", "preparedSegmentCount", "deletedSegmentCount", "databasePrincipal", "authorizationReference"
  ) VALUES (application_id, prepared, prepared, session_user, authorization_reference);
  DELETE FROM "CorrectionPendingSegmentRevision" WHERE "applicationId" = application_id;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  IF deleted <> prepared THEN RAISE EXCEPTION 'cleanup delete count mismatch' USING ERRCODE = '23514'; END IF;
  RETURN QUERY SELECT prepared, deleted, false;
END;
$$;

COMMIT;
