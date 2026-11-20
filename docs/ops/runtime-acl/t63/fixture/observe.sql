-- Disposable observation only. Emits role and operation metadata into this lab's server log.
CREATE SCHEMA t63_observe;
REVOKE ALL ON SCHEMA t63_observe FROM PUBLIC;
CREATE FUNCTION t63_observe.receipt() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog AS $fn$
DECLARE data jsonb := to_jsonb(NEW); old_status text;
BEGIN
  IF TG_OP='UPDATE' THEN old_status:=to_jsonb(OLD)->>'statusCode'; END IF;
  RAISE LOG 'T63_OBSERVATION %', json_build_object('relation',TG_TABLE_NAME,'op',TG_OP,'role',current_user,
    'login',session_user,'pid',pg_backend_pid(),'xid',txid_current()::text,'id',data->>'id',
    'from',old_status,'to',data->>'statusCode','type',data->>'jobTypeCode','batch',data->>'postingBatchId',
    'attempts',data->>'attempts','generation',data->>'leaseGeneration','leaseOwner',data->>'leaseOwner',
    'committedBy',data->>'committedByUserId','actor',data->>'closedByUserId');
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION t63_observe.receipt() FROM PUBLIC;
CREATE TRIGGER t63_observe_job AFTER INSERT OR UPDATE ON public."ActivityBatchJob" FOR EACH ROW EXECUTE FUNCTION t63_observe.receipt();
CREATE TRIGGER t63_observe_batch AFTER INSERT OR UPDATE ON public."LedgerPostingBatch" FOR EACH ROW EXECUTE FUNCTION t63_observe.receipt();
CREATE TRIGGER t63_observe_entry AFTER INSERT ON public."ParticipationLedgerEntry" FOR EACH ROW EXECUTE FUNCTION t63_observe.receipt();
CREATE TRIGGER t63_observe_close AFTER INSERT ON public."ActivitySettlementClosureRevision" FOR EACH ROW EXECUTE FUNCTION t63_observe.receipt();
