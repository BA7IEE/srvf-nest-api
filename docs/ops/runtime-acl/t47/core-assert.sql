BEGIN READ ONLY;
SELECT json_build_object('registration_count',count(*),'ordinary_owner',bool_and(r."memberId"=u."memberId")) FROM "ActivityRegistration" r JOIN "User" u ON u.username='t47-member' WHERE r."activityId"=:'target';
SELECT json_build_object('event',event,'request_id',context->>'requestId','success',success) FROM audit_logs WHERE context->>'requestId' IN (:'registration',:'punch');
SELECT json_build_object('test_users_with_explicit_member_role',count(*)) FROM role_bindings b JOIN "User" u ON u.username='t47-member' AND b."principalId" IN (u.id,u."memberId");
SELECT json_build_object('rotation_rows',count(*) FILTER (WHERE r."replacedById" IS NOT NULL),'rotation_kept_deadline',bool_and(r."expiresAt"=next."expiresAt"),'families',count(DISTINCT r."familyId")) FROM refresh_tokens r JOIN "User" u ON u.id=r."userId" LEFT JOIN refresh_tokens next ON next.id=r."replacedById" WHERE u.username='t47-member';
SELECT json_build_object('applied_migrations',count(*)) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
COMMIT;
