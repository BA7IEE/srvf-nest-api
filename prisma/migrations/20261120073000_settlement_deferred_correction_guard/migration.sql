CREATE OR REPLACE FUNCTION public.ctsp_lifecycle_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public', 'pg_temp'
    AS $$
DECLARE
  batch_id TEXT;
  batch_status TEXT;
  application_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'LedgerPostingBatch' THEN
    batch_id := NEW.id;
    batch_status := NEW."statusCode";
  ELSIF TG_TABLE_NAME = 'CorrectionTimeSourceProof' THEN
    batch_id := NEW."postingBatchId";
  ELSIF TG_TABLE_NAME = 'CorrectionTimeAllocationBinding' THEN
    SELECT "postingBatchId" INTO batch_id FROM "CorrectionTimeSourceProof" WHERE id = NEW."proofId";
  ELSIF TG_TABLE_NAME = 'CorrectionPendingTimeAllocation' THEN
    SELECT a."newPostingBatchId" INTO batch_id FROM "CorrectionApplication" a WHERE a.id = NEW."applicationId";
  ELSE
    SELECT a."newPostingBatchId" INTO batch_id
      FROM "CorrectionPendingTimeAllocation" p JOIN "CorrectionApplication" a ON a.id = p."applicationId"
      WHERE p.id = NEW."pendingAllocationId";
  END IF;
  IF batch_id IS NULL THEN RETURN NULL; END IF;
  IF batch_status IS NULL THEN
    SELECT "statusCode" INTO batch_status FROM "LedgerPostingBatch" WHERE id = batch_id;
  END IF;
  SELECT id INTO application_id FROM public."CorrectionApplication" WHERE "newPostingBatchId"=batch_id;
  -- Plan the restricted function call only for a batch tied to a correction.
  IF application_id IS NOT NULL THEN
    IF public.r5_correction_phase_deferred_registered(application_id) THEN RETURN NULL; END IF;
  END IF;
  PERFORM ctsp_assert_complete(batch_id, batch_status = 'committed');
  RETURN NULL;
END;
$$;
