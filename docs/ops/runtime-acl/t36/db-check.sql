\pset null '(null)'
SELECT count(*) AS applied_migrations FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SELECT a.id,a."metricRequirementCode",a."statusCode",a."workflowRevision",a."metricSelectionRevision",
       (m."memberNo"='lab') AS initiated_by_lab,(v."definitionHash"=a."selectedMetricSetDefinitionHash") AS pointer_matches,
       v.version AS set_version,v."statusCode" AS set_status
FROM "Activity" a JOIN "Member" m ON m.id=a."initiatorMemberId" LEFT JOIN "ActivityMetricSetVersion" v ON v.id=a."selectedMetricSetVersionId" ORDER BY a."createdAt";
SELECT a."metricRequirementCode",r.id,r."requestVersion",r."requestType",r.status,u.username AS submitter,v.username AS reviewer
FROM activity_publish_reviews r JOIN "Activity" a ON a.id=r."activityId" JOIN "User" u ON u.id=r."submittedByUserId"
LEFT JOIN "User" v ON v.id=r."reviewedByUserId" ORDER BY r."createdAt";
SELECT u.role, u.username FROM "User" u WHERE u.username IN ('lab','reviewer');
SELECT r.code,b."scopeType",b."principalType",b.status,count(*) FROM role_bindings b JOIN roles r ON r.id=b."roleId" GROUP BY 1,2,3,4 ORDER BY 1,2;
SELECT a.event,a."actorRoleSnap",u.username,a.success,a.context->>'requestId' AS request_id FROM audit_logs a LEFT JOIN "User" u ON a."actorUserId"=u.id WHERE u.username IN ('lab','reviewer') AND a.event LIKE 'activity%' ORDER BY a."createdAt";
