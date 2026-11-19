BEGIN READ ONLY;
SELECT json_build_object(
 'activity_time',json_build_array(a."startAt",a."endAt"),'activity_location',a.location,
 'session_time',json_build_array(s."startAt",s."endAt"),'session_location',s."locationText",
 'position_time',json_build_array(p."startAt",p."endAt"),
 'session_windows',json_build_array(s."checkInOpenAt",s."checkInCloseAt",s."checkOutOpenAt",s."checkOutCloseAt",s."preparationStartAt"),
 'actual_capacity',json_build_array(a.capacity,s.capacity,p.capacity),
 'frozen_windows_match', (r.snapshot#>>'{sessions,0,checkInOpenAt}')::timestamptz=s."checkInOpenAt" AND
  (r.snapshot#>>'{sessions,0,checkInCloseAt}')::timestamptz=s."checkInCloseAt" AND
  (r.snapshot#>>'{sessions,0,checkOutOpenAt}')::timestamptz=s."checkOutOpenAt" AND
  (r.snapshot#>>'{sessions,0,checkOutCloseAt}')::timestamptz=s."checkOutCloseAt",
 'position_matches_snapshot', (r.snapshot#>>'{sessions,0,positions,0,startAt}')::timestamptz IS NOT DISTINCT FROM p."startAt" AND
  (r.snapshot#>>'{sessions,0,positions,0,endAt}')::timestamptz IS NOT DISTINCT FROM p."endAt",
 'structured_place_match',NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.snapshot->'activityPlaces') e LEFT JOIN "ActivityPlace" pl ON pl.id=e->>'id' WHERE pl.id IS NULL OR pl."addressText" IS DISTINCT FROM e->>'addressText'))
FROM "Activity" a JOIN "ActivitySession" s ON s."activityId"=a.id JOIN "ActivitySessionPosition" p ON p."sessionId"=s.id
JOIN activity_publish_reviews r ON r."activityId"=a.id AND r."requestVersion"=3 WHERE a.id=:'target';
ROLLBACK;
