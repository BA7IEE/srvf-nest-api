BEGIN READ ONLY;
SELECT json_build_object('state','aggregate','hash',md5(concat_ws('|',
 (SELECT md5(string_agg(to_jsonb(a)::text,'|' ORDER BY a.id)) FROM "Activity" a WHERE a."id"=:'target'),
 (SELECT md5(string_agg(to_jsonb(s)::text,'|' ORDER BY s.id)) FROM "ActivitySession" s WHERE s."activityId"=:'target'),
 (SELECT md5(string_agg(to_jsonb(p)::text,'|' ORDER BY p.id)) FROM "ActivitySessionPosition" p WHERE p."activityId"=:'target'),
 (SELECT md5(string_agg(to_jsonb(p)::text,'|' ORDER BY p.id)) FROM "ActivityPlace" p WHERE p."activityId"=:'target'))),
 'buckets',(SELECT json_agg(json_build_array("scopeTypeCode",capacity,occupied,version) ORDER BY "scopeTypeCode") FROM "ActivityCapacityBucket" WHERE "activityId"=:'target'),
 'active_reservations',(SELECT count(*) FROM "CapacityReservation" WHERE status='active' AND "bucketId" IN (SELECT id FROM "ActivityCapacityBucket" WHERE "activityId"=:'target')));
SELECT json_build_object('kind',r."requestType",'version',r."requestVersion",'status',r.status,
 'id',r.id,'submitted_role',u.role,'reviewed_role',v.role,'independent',u.id<>v.id,
 'activity_target',r.snapshot->'activity'->'capacity','session_target',r.snapshot#>'{sessions,0,capacity}',
 'position_target',r.snapshot#>'{sessions,0,positions,0,capacity}',
 'activity_start',r.snapshot#>>'{activity,startAt}','activity_location',r.snapshot#>>'{activity,location}',
 'schedule_consistent',r.snapshot#>>'{activity,startAt}'=r.snapshot#>>'{sessions,0,startAt}' AND r.snapshot#>>'{activity,endAt}'=r.snapshot#>>'{sessions,0,endAt}',
 'places_unchanged',r.snapshot->'activityPlaces'=r.snapshot#>'{base,activityPlaces}')
FROM activity_publish_reviews r JOIN "User" u ON u.id=r."submittedByUserId" LEFT JOIN "User" v ON v.id=r."reviewedByUserId" WHERE r."activityId"=:'target' ORDER BY r."requestVersion";
SELECT json_build_object('event',event,'reqId',coalesce(context->>'requestId',context->>'reqId')) FROM audit_logs WHERE coalesce(context->>'requestId',context->>'reqId') IS NOT NULL ORDER BY "createdAt";
ROLLBACK;
