-- Expected denial only. This does NOT bind pins or authenticate a P/U login.
-- Keep the real frozen NULL guard; no replacement function or write fallback.
BEGIN READ ONLY;
SET LOCAL search_path=pg_catalog;
SET LOCAL ROLE "r5_boundary_caller_h7c6";
DO $expected_denial$
BEGIN
  PERFORM public.r5_correction_boundary_preflight();
  RAISE EXCEPTION 'R5 default preflight unexpectedly accepted' USING ERRCODE='XX000';
EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM <> 'materialization catalog pins are not bound' THEN RAISE; END IF;
END
$expected_denial$;
ROLLBACK;
