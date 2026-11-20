BEGIN READ ONLY;
SELECT json_build_object('activity',a.id, 'public',a."isPublicRegistration", 'registration_mode',a."registrationModeCode",
 'headers',(SELECT coalesce(json_agg(json_build_array(reg."statusCode",reg.id) ORDER BY reg.id),'[]') FROM "ActivityRegistration" reg WHERE reg."activityId"=a.id AND reg."deletedAt" IS NULL),
 'identities',(SELECT count(*) FROM "ActivityParticipationIdentity" i WHERE i."activityId"=a.id),
 'revisions',(SELECT count(*) FROM "ActivityRegistrationRevision" v JOIN "ActivityRegistration" reg ON reg.id=v."registrationId" WHERE reg."activityId"=a.id),
 'buckets',(SELECT json_agg(json_build_array(b."scopeTypeCode",b.occupied,b.version) ORDER BY b."scopeTypeCode") FROM "ActivityCapacityBucket" b WHERE b."activityId"=a.id))
FROM "Activity" a WHERE a.id=:'target';
ROLLBACK;
