BEGIN;
SET LOCAL lock_timeout='2s';
LOCK TABLE public."Member" IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN IF current_database()<>'srvf_staging' OR has_any_column_privilege('srvf_dp_acceptance_runtime','public."Member"','UPDATE') THEN RAISE EXCEPTION 'baseline drift'; END IF; END $$;
GRANT UPDATE ("updatedAt") ON public."Member" TO srvf_dp_acceptance_runtime;
SELECT json_build_object('grantor',pg_get_userbyid(x.grantor),'grantee',pg_get_userbyid(x.grantee),'column',a.attname,'privilege',x.privilege_type,'grantable',x.is_grantable) FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid='public."Member"'::regclass AND a.attname='updatedAt' AND x.grantee='srvf_dp_acceptance_runtime'::regrole AND x.privilege_type='UPDATE';
COMMIT;
