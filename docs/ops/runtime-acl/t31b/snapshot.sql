BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT current_database(),system_identifier FROM pg_control_system();
WITH t(r,p) AS (VALUES ('activity-owner','activity.update.record'),('activity-publish-reviewer','activity.publish.record'),('attendance-final-reviewer','activity.settlement-final-review.record'))
SELECT t.r,t.p,r.id,p.id,m.id,(SELECT string_agg(a.id,',') FROM public.audit_logs a WHERE a."resourceId"=m.id AND a.event='ops.activity-catalog.apply' AND a.context->>'roleId'=r.id AND a.context->>'permissionId'=p.id) FROM t LEFT JOIN public.roles r ON r.code=t.r LEFT JOIN public.permissions p ON p.code=t.p LEFT JOIN public.role_permissions m ON m."roleId"=r.id AND m."permissionId"=p.id ORDER BY 1;
SELECT 'other_roles',count(*),md5(string_agg(md5(to_jsonb(r)::text),',' ORDER BY id)) FROM public.roles r WHERE code NOT IN ('activity-owner','activity-publish-reviewer','attendance-final-reviewer');
SELECT 'bindings',count(*),md5(string_agg(md5(to_jsonb(b)::text),',' ORDER BY id)) FROM public.role_bindings b;
SELECT 'totals',(SELECT count(*) FROM public.roles),(SELECT count(*) FROM public.permissions),(SELECT count(*) FROM public.role_permissions),(SELECT count(*) FROM public.audit_logs WHERE event='ops.activity-catalog.apply');
COMMIT;
