BEGIN;
SET LOCAL lock_timeout='2s';
LOCK TABLE public."Member" IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
IF current_database() <> 'srvf_staging' OR has_any_column_privilege('srvf_dp_acceptance_runtime','public."Member"','INSERT') THEN RAISE EXCEPTION 'target or baseline drift'; END IF;
END $$;
GRANT INSERT ("id","memberNo","realName","nickname","memberSinceDate","memberOriginCode","gradeCode","status","createdAt","updatedAt") ON public."Member" TO srvf_dp_acceptance_runtime;
DO $$ BEGIN IF (SELECT array_agg(attname::text ORDER BY attname::text) FROM pg_attribute WHERE attrelid='public."Member"'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('srvf_dp_acceptance_runtime',attrelid,attnum,'INSERT')) IS DISTINCT FROM ARRAY['createdAt','gradeCode','id','memberNo','memberOriginCode','memberSinceDate','nickname','realName','status','updatedAt']::text[] OR has_table_privilege('srvf_dp_acceptance_runtime','public."Member"','INSERT') THEN RAISE EXCEPTION 'unexpected ACL'; END IF; END $$;
COMMIT;
