BEGIN READ ONLY;
SELECT json_build_object(
 'activity',a.id,'review',r.id,'type',r."requestType",'review_status',r.status,
 'request_version',r."requestVersion",'activity_status',a."statusCode",'workflow_revision',a."workflowRevision",
 'schema',(r.snapshot->>'schemaVersion')::int,'requirement',a."metricRequirementCode",'metric_set',s.code,
 'metric_set_version',s.version,'metric_count',(SELECT count(*) FROM "ActivityMetricSetItem" i WHERE i."setVersionId"=s.id),
 'all_items_required',(SELECT bool_and(i.required) FROM "ActivityMetricSetItem" i WHERE i."setVersionId"=s.id),
 'frozen_metrics_match',
 (r.snapshot->'base'->'metricSetPointer' = r.snapshot->'metricSetPointer' AND r.snapshot->'metricSetPointer'->>'id'=s.id
 AND r.snapshot->'metricSetPointer'->>'definitionHash'=s."definitionHash"
 AND a."selectedMetricSetDefinitionHash"=s."definitionHash"),
 'both_ordinary',(u.role::text='USER' AND v.role::text='USER'),'independent',u.id<>v.id,
 'changed_title',r.snapshot->'base'->'activity'->>'title' IS DISTINCT FROM r.snapshot->'activity'->>'title',
 'changed_description',r.snapshot->'base'->'activity'->>'description' IS DISTINCT FROM r.snapshot->'activity'->>'description',
 'current_matches_target',a.title=r.snapshot->'activity'->>'title' AND a.description=r.snapshot->'activity'->>'description')
FROM activity_publish_reviews r JOIN "Activity" a ON a.id=r."activityId"
JOIN "ActivityMetricSetVersion" s ON s.id=a."selectedMetricSetVersionId"
JOIN "User" u ON u.id=r."submittedByUserId" JOIN "User" v ON v.id=r."reviewedByUserId"
WHERE s.code IN ('t36_set','t37_full_set') ORDER BY s.code,r."requestVersion";
ROLLBACK;
