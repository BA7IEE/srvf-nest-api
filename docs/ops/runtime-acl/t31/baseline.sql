BEGIN READ ONLY;
WITH targets(role_code,permission_code) AS (VALUES ('activity-owner','activity.update.record'),('activity-publish-reviewer','activity.publish.record'),('attendance-final-reviewer','activity.settlement-final-review.record'))
SELECT t.role_code,t.permission_code,r.id IS NOT NULL,p.id IS NOT NULL,rp.id IS NOT NULL FROM targets t LEFT JOIN public.roles r ON r.code=t.role_code LEFT JOIN public.permissions p ON p.code=t.permission_code LEFT JOIN public.role_permissions rp ON rp."roleId"=r.id AND rp."permissionId"=p.id ORDER BY 1;
ROLLBACK;
