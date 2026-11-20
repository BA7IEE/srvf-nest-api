BEGIN READ ONLY;
SELECT a.id, r."requestVersion", r.status, r."requestType", a."statusCode", a."workflowRevision",
       r.snapshot->'base'->'activity'->>'title' <> r.snapshot->'activity'->>'title' AS title_changed,
       r.snapshot->'base'->'activity'->>'description' IS DISTINCT FROM r.snapshot->'activity'->>'description' AS description_changed,
       a.title = r.snapshot->'activity'->>'title' AS current_title_matches,
       a.description = r.snapshot->'activity'->>'description' AS current_description_matches,
       (r."submittedByUserId" <> r."reviewedByUserId") AS reviewer_independent,
       (SELECT count(*) FROM activity_publish_reviews q WHERE q."activityId"=a.id AND q."requestType"='initial') AS initial_count
  FROM "Activity" a JOIN activity_publish_reviews r ON r."activityId"=a.id
 WHERE r."requestType"='change' ORDER BY a.id;
ROLLBACK;
