-- Run with psql -X -v ON_ERROR_STOP=1 -v runtime_role=ROLE -f preflight.sql.
-- Checks the reviewed Member create, lock and bound-user authorization prerequisites.
BEGIN READ ONLY;
WITH required(rel,priv,cols) AS (VALUES
 ('Member','INSERT',ARRAY['id','memberNo','realName','nickname','memberSinceDate','memberOriginCode','gradeCode','status','createdAt','updatedAt']),
 ('Member','UPDATE',ARRAY['updatedAt']),
 ('organization_position_assignments','SELECT',ARRAY['id','organizationId','positionId','status','startedAt','endedAt','memberId','deletedAt']),
 ('organization_supervision_assignments','SELECT',ARRAY['id','organizationId','scopeMode','status','startedAt','endedAt','supervisorMemberId','deletedAt']))
SELECT NOT EXISTS (
 SELECT FROM required CROSS JOIN LATERAL unnest(cols) col
 WHERE NOT has_column_privilege(:'runtime_role',format('public.%I',rel),col,priv)
) AS required_present \gset
ROLLBACK;
\if :required_present
\echo PASS reviewed member and authorization prerequisites
\else
\echo FAIL reviewed member and authorization prerequisites
DO $$ BEGIN RAISE EXCEPTION 'required runtime ACL missing'; END $$;
\endif
