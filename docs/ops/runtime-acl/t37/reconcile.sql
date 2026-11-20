\pset null '(null)'
BEGIN READ ONLY;
SELECT a.id, a."metricRequirementCode", a."metricSelectionRevision", a."statusCode", a."workflowRevision",
       a.title LIKE '% 修订' AS has_approved_title,
       a."selectedMetricSetDefinitionHash"=v."definitionHash" AS pointer_matches,
       v.version AS metric_set_version, m."memberNo"='lab' AS fixture_initiator
 FROM "Activity" a JOIN "Member" m ON m.id=a."initiatorMemberId"
 LEFT JOIN "ActivityMetricSetVersion" v ON v.id=a."selectedMetricSetVersionId"
 ORDER BY a."createdAt";
SELECT r."activityId",r.id,r."requestType",r."requestVersion",r.status,r.snapshot->>'schemaVersion' AS snapshot_version,
       u.username AS submitter,d.username AS reviewer,
       r.snapshot->'activity'->>'title'=a.title AS target_matches_current_title
 FROM activity_publish_reviews r JOIN "Activity" a ON r."activityId"=a.id
 JOIN "User" u ON r."submittedByUserId"=u.id
 LEFT JOIN "User" d ON r."reviewedByUserId"=d.id ORDER BY r."createdAt";
SELECT u.username,u.role FROM "User" u WHERE username IN ('lab','reviewer');
SELECT rol.code,b."scopeType",b."principalType",b.status,count(*) FROM role_bindings b JOIN roles rol ON rol.id=b."roleId" GROUP BY 1,2,3,4 ORDER BY 1,2;
SELECT a.event,a."actorRoleSnap",u.username,a.success,a.context->>'requestId' AS request_id FROM audit_logs a LEFT JOIN "User" u ON a."actorUserId"=u.id WHERE u.username IN ('lab','reviewer') AND a.event LIKE 'activity%' ORDER BY a."createdAt";
SELECT r."eventType",r.status,r.attempts,count(*) FROM notification_outbox_intents r GROUP BY 1,2,3 ORDER BY 1,2;
SELECT count(*) AS migrations FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SELECT count(*) AS unscheduled_higher_privilege FROM "User" WHERE role::text <> 'USER';
ROLLBACK;
