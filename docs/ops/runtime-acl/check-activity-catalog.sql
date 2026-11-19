-- psql -X -f check-activity-catalog.sql against the target database.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
WITH required(code,role_code) AS (VALUES
 ('activity.update.record','activity-owner'),
 ('activity.publish.record','activity-publish-reviewer'),
 ('activity.settlement-final-review.record','attendance-final-reviewer')
), observed AS (
 SELECT q.*, p.id IS NOT NULL AS catalog_present, r.id IS NOT NULL AS role_present,
        rp.id IS NOT NULL AS mapping_present
 FROM required q
 LEFT JOIN public.permissions p ON p.code=q.code
 LEFT JOIN public.roles r ON r.code=q.role_code AND r."deletedAt" IS NULL
 LEFT JOIN public.role_permissions rp ON rp."permissionId"=p.id AND rp."roleId"=r.id
)
SELECT bool_and(mapping_present) AS ready,
       json_agg(observed ORDER BY code)::text AS evidence FROM observed \gset
\echo :evidence
ROLLBACK;
\if :ready
\echo PASS
\else
DO $$ BEGIN RAISE EXCEPTION 'required activity permission catalog or binding missing'; END $$;
\endif
