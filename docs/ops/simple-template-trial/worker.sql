BEGIN READ ONLY;
SELECT 'outbox',count(*),count(*) FILTER(WHERE status='pending'),count(*) FILTER(WHERE status='processing'),count(*) FILTER(WHERE "leaseExpiresAt">now()),max("completedAt") FROM notification_outbox_intents;
SELECT 'activity_jobs',count(*),max("completedAt") FROM "ActivityBatchJob";
ROLLBACK;
