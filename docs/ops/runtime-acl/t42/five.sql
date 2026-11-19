BEGIN READ ONLY;
SELECT json_build_object('version',r."requestVersion",'id',r.id,'review_status',r.status,
 'activity_metric',a."metricRequirementCode",'template',t.code,'template_hash',t."definitionHash",
 'set',ms.code,'set_version',ms.version,'set_hash', ms."definitionHash",
 'matches',r.snapshot#>>'{metricSetPointer,id}'=ms.id AND r.snapshot#>>'{metricSetPointer,definitionHash}'=ms."definitionHash"
 AND r.snapshot->'metricSetPointer'=r.snapshot#>'{base,metricSetPointer}'
 AND a."selectedMetricSetDefinitionHash"=ms."definitionHash" AND t."definitionJson"#>>'{metricSelection,metricSetPointer,definitionHash}'=ms."definitionHash",
 'required_kinds',(SELECT json_agg(json_build_array(d."kindCode",i.required) ORDER BY i."sortOrder")
 FROM "ActivityMetricSetItem" i JOIN "ActivityMetricDefinition" d ON d.id=i."metricDefinitionId" WHERE i."setVersionId"=ms.id))
FROM "Activity" a JOIN activity_publish_reviews r ON r."activityId"=a.id
JOIN "ActivityMetricSetVersion" ms ON ms.id=a."selectedMetricSetVersionId"
JOIN "ActivityTemplate" t ON t.id=r.snapshot->>'selectedTemplateVersionId'
WHERE a.id=:'target' ORDER BY r."requestVersion";
ROLLBACK;
