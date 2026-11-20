\set ON_ERROR_STOP on
BEGIN READ ONLY;
WITH member AS (SELECT id,"memberId" FROM "User" WHERE username='t48-member'),
event_chain AS (
 SELECT a.context->>'requestId' rid, e.id, s.id segment FROM audit_logs a
 JOIN "AttendancePunchEvent" e ON e.id=a.context->'extra'->>'eventId' AND e."activityId"=a."resourceId"
 JOIN member m ON m.id=a."actorUserId" AND m.id=e."operatorUserId" AND e."memberId"=m."memberId" AND e."operatorMemberId"=m."memberId"
 JOIN "ParticipantServiceSegmentRevision" s ON s."sourceCheckInEventId"=e.id AND s."checkInAt"=e."occurredAt"
 JOIN "ActivityParticipationIdentity" i ON i.id=s."participationIdentityId" AND i."activityId"=e."activityId" AND i."memberId"=m."memberId"
 WHERE a.success AND a.context->'extra'->>'operation'='attendance-punch.create'
 AND e."sourceCode"='self_qr' AND e."eventTypeCode"='check_in' AND s."checkOutAt" IS NULL AND s."statusCode"='draft'
), signup AS (
 SELECT a.event FROM audit_logs a JOIN member m ON a."actorUserId"=m.id
 WHERE a.context->>'requestId' = :'signup' AND a.success AND a.event IN ('registration.create','registration.review')
), evidence AS (
 SELECT e."sourceKind" src, e."activityRegistrationRevisionId" rev FROM insurance_eligibility_evidences e
 JOIN "ActivityRegistration" r ON r.id=e."activityRegistrationId" JOIN member m ON m."memberId"=r."memberId"
 JOIN team_insurance_coverages c ON c.id=e."teamInsuranceCoverageId" AND c."memberId"=m."memberId"
)
SELECT json_build_object('punchReqId',:'punch','signupReqId',:'signup',
'complete_join',(SELECT count(*) FROM event_chain WHERE rid=:'punch'),
'wrong_request',(SELECT count(*) FROM event_chain WHERE rid='t48-never-issued'),
'registration_audits',(SELECT json_agg(event ORDER BY event) FROM signup),
'team_evidence',(SELECT count(*) FROM evidence WHERE rev IS NOT NULL),
'source_kind',(SELECT min(src) FROM evidence),
'migrations',(SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
'bindings',(SELECT count(*) FROM role_bindings b JOIN member m ON b."principalId" IN (m.id,m."memberId")),
'outbox_pending',(SELECT count(*) FROM notification_outbox_intents WHERE status NOT IN ('succeeded','sent','completed')),
'activity_state',(SELECT "statusCode" FROM "Activity" WHERE title='T48 联验班次'));
COMMIT;
