BEGIN;
DO $$ BEGIN IF current_database()<>'srvf_staging' OR (SELECT system_identifier::text FROM pg_control_system())<>'7709931013666021418' THEN RAISE EXCEPTION 'wrong disposable target'; END IF; END $$;
INSERT INTO public.organization_closure ("ancestorId","descendantId",depth) SELECT a."organizationId",a."organizationId",0 FROM public."Activity" a WHERE a.id=:'target' ON CONFLICT DO NOTHING;
CREATE TEMP TABLE t44_digest AS SELECT count(*) n,md5(string_agg(format('%s|%s|%s',"ancestorId","descendantId",depth),',' ORDER BY "ancestorId","descendantId")) h FROM public.organization_closure;
SET LOCAL ROLE srvf_dp_acceptance_runtime;
DO $$
DECLARE locked integer;
BEGIN
 SELECT count(*) INTO locked FROM (SELECT depth FROM public.organization_closure LIMIT 1 FOR SHARE) q;
 IF locked<>1 THEN RAISE EXCEPTION 'expected one lock'; END IF;
 BEGIN UPDATE public.organization_closure SET depth=depth+1 WHERE "ancestorId"="descendantId"; RAISE EXCEPTION 'missing guard';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM <> 'trial registration role cannot update organization closure' THEN RAISE; END IF; END;
 BEGIN UPDATE public.organization_closure SET depth=depth WHERE false; RAISE EXCEPTION 'missing guard on zero rows';
 EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM <> 'trial registration role cannot update organization closure' THEN RAISE; END IF; END;
END $$;
RESET ROLE;
UPDATE public.organization_closure SET depth=depth WHERE false;
SELECT json_build_object('lock_on_existing_row',true,'direct_update_existing_roots','42501','direct_update_zero_rows','42501','owner_zero_row_update','00000','closure_row_count',d.n,'unchanged',d.n=s.n AND d.h=s.h) FROM t44_digest d CROSS JOIN (SELECT count(*) n,md5(string_agg(format('%s|%s|%s',"ancestorId","descendantId",depth),',' ORDER BY "ancestorId","descendantId")) h FROM public.organization_closure) s;
ROLLBACK;
