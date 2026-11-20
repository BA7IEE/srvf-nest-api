SELECT count(*) AS active_v3_plus FROM public."ActivityTemplate" WHERE "statusCode"='active' AND "schemaVersion">=3 AND "familyId" IS NOT NULL;
SELECT count(*) AS creation_permission FROM public.permissions WHERE code='activity.create.record';
