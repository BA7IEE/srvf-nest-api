-- Maintainer-only DDL. BEGIN; SET LOCAL srvf.d3_acl_database = exact target;
-- SET LOCAL srvf.d3_acl_action = bootstrap | bind | close; execute this file.
-- bind additionally consumes srvf.d3_authority JSON, including an independently
-- approved manifest, exact LOGIN identity and expiry. Runtime GUCs grant nothing.
-- This file never creates LOGINs or passwords and never modifies old mapping ACL.
DO $d3_acl$
DECLARE target TEXT := current_setting('srvf.d3_acl_database',TRUE);
  action TEXT := current_setting('srvf.d3_acl_action',TRUE);
  owner_role TEXT := 'srvf_d3_owner'; registrar_role TEXT := 'srvf_d3_registrar';
  reader_role TEXT := 'srvf_d3_reader'; authority JSONB; signature TEXT; role_name TEXT; table_name TEXT;
BEGIN
  IF target IS DISTINCT FROM current_database() OR action IS NULL OR action NOT IN ('bootstrap','bind','close') THEN
    RAISE EXCEPTION 'D3 ACL explicit target and action required';
  END IF;
  IF target = 'app_test_w98' THEN
    owner_role := 'srvf_d3_owner_w98_fixture'; registrar_role := 'srvf_d3_registrar_w98_fixture';
    reader_role := 'srvf_d3_reader_w98_fixture';
  END IF;
  IF action = 'bootstrap' THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ANY(ARRAY[owner_role,registrar_role,reader_role])) THEN
      RAISE EXCEPTION 'D3 roles already exist; reuse or replacement forbidden';
    END IF;
    FOREACH role_name IN ARRAY ARRAY[owner_role,registrar_role,reader_role] LOOP
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
    END LOOP;
    EXECUTE format('GRANT USAGE,CREATE ON SCHEMA public TO %I',owner_role);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I,%I',registrar_role,reader_role);
    EXECUTE format('GRANT SELECT ON public."User",public.role_bindings,public.roles,public.role_permissions,public.permissions,
      public."ContributionShadowObservationWindow",public."ContributionShadowWindowRegistrationReceipt",
      public."ContributionShadowDispositionApprovalReceipt",public."ContributionShadowDispositionReceipt",
      public."ContributionShadowAttemptReceipt",public."ContributionShadowTerminalReceipt",
      public."ContributionShadowComparisonReceipt",public."ContributionShadowMappingApproval",
      public."ContributionShadowMappingApplication",public.audit_logs TO %I',owner_role);
    EXECUTE format('REVOKE SELECT ON public."User" FROM %I',owner_role);
    EXECUTE format('GRANT SELECT(id,role,status,"deletedAt") ON public."User" TO %I',owner_role);
    EXECUTE format('GRANT INSERT ON public."ContributionShadowObservationWindow",public."ContributionShadowWindowRegistrationReceipt",
      public."ContributionShadowDispositionApprovalReceipt",public."ContributionShadowDispositionReceipt",public.audit_logs TO %I',owner_role);
    FOREACH table_name IN ARRAY ARRAY['User','role_bindings','roles','role_permissions','permissions',
      'audit_logs','ContributionShadowObservationWindow','ContributionShadowDispositionReceipt','ContributionShadowAttemptReceipt'] LOOP
      EXECUTE format('GRANT UPDATE(id) ON public.%I TO %I',table_name,owner_role);
    END LOOP;
    -- Ownership is limited to the two new receipt tables and D3 functions.
    FOREACH table_name IN ARRAY ARRAY['ContributionShadowWindowRegistrationReceipt','ContributionShadowDispositionApprovalReceipt'] LOOP
      EXECUTE format('ALTER TABLE public.%I OWNER TO %I',table_name,owner_role);
    END LOOP;
    FOREACH signature IN ARRAY ARRAY['csd3_hash_fn(text,jsonb)','csd3_manifest_hash_fn(jsonb)',
      'csd3_candidate_evidence_fn(text,text)','csd3_assert_human_fn(text,text)','csd3_authority_fn()',
      'csd3_assert_authority_fn(jsonb,text)','csd3_assert_decision_fn(jsonb,text)',
      'csd3_window_insert_guard_fn()','csd3_approval_insert_guard_fn()','csd3_approval_closure_fn()',
      'csd3_register_fn(jsonb,text,text,text,text)','csd3_read_candidates_fn(text)',
      'csd3_read_candidate_fn(text,text)','csd3_read_summary_fn(text)','csd3_authorize_read_fn(text)'] LOOP
      EXECUTE format('ALTER FUNCTION public.%s OWNER TO %I',signature,owner_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,%I,%I',signature,registrar_role,reader_role);
    END LOOP;
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',owner_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.csd3_read_candidates_fn(text) TO %I',reader_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.csd3_read_summary_fn(text) TO %I',reader_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.csd3_read_candidate_fn(text,text) TO %I',reader_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.csd3_authorize_read_fn(text) TO %I',reader_role);
    -- Registrar can authenticate and recheck explicit current GLOBAL codes only.
    EXECUTE format('GRANT SELECT(id,username,role,status,"memberId","deletedAt") ON public."User" TO %I',registrar_role);
    EXECUTE format('GRANT SELECT(id,"roleId","principalType","principalId","scopeType",status,"startedAt","endedAt","deletedAt") ON public.role_bindings TO %I',registrar_role);
    EXECUTE format('GRANT SELECT(id,"deletedAt") ON public.roles TO %I',registrar_role);
    EXECUTE format('GRANT SELECT(id,"roleId","permissionId") ON public.role_permissions TO %I',registrar_role);
    EXECUTE format('GRANT SELECT(id,code) ON public.permissions TO %I',registrar_role);
    -- Reader cannot inspect raw audit context, candidateEvidence or credentials.
    EXECUTE format('GRANT SELECT ON public."ContributionShadowObservationWindow",public."ContributionShadowWindowRegistrationReceipt" TO %I',reader_role);
    EXECUTE format('GRANT SELECT(id,"windowId","auditLogId","attemptId",revision,"previousDispositionId","decisionCode",
      "operationCode","basisCode","approvalReference","signedByUserId","candidateEvidenceHash","createdAt")
      ON public."ContributionShadowDispositionApprovalReceipt" TO %I',reader_role);
    RETURN;
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname = ANY(ARRAY[owner_role,registrar_role,reader_role])
    AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) <> 3 OR
    pg_has_role(registrar_role,owner_role,'MEMBER') OR pg_has_role(reader_role,owner_role,'MEMBER') OR
    pg_has_role(reader_role,registrar_role,'MEMBER') OR pg_has_role(registrar_role,reader_role,'MEMBER') OR
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
      AND p.proname LIKE 'csd3\_%' ESCAPE '\' AND pg_get_userbyid(p.proowner) <> owner_role) OR
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
      AND c.relname IN ('ContributionShadowWindowRegistrationReceipt','ContributionShadowDispositionApprovalReceipt')
      AND pg_get_userbyid(c.relowner) <> owner_role) THEN
    RAISE EXCEPTION 'D3 ACL ownership or role isolation invalid';
  END IF;
  IF action = 'close' THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.csd3_register_fn(jsonb,text,text,text,text) FROM %I',registrar_role);
    EXECUTE 'CREATE OR REPLACE FUNCTION public.csd3_authority_fn() RETURNS JSONB LANGUAGE sql STABLE
      SET search_path = pg_catalog,public,pg_temp AS ''SELECT NULL::JSONB''';
    RETURN;
  END IF;
  authority := current_setting('srvf.d3_authority',TRUE)::JSONB;
  IF NOT coalesce(public.csm_exact_keys_fn(authority,ARRAY['databaseName','manifestHash','operation','actorUserId',
    'approvalReference','ownerRole','registrarRole','readerRole','loginRole','expiresAt','manifest']),FALSE) OR
    authority->>'databaseName' IS DISTINCT FROM target OR authority->>'ownerRole' IS DISTINCT FROM owner_role OR
    authority->>'registrarRole' IS DISTINCT FROM registrar_role OR authority->>'readerRole' IS DISTINCT FROM reader_role OR
    authority->>'manifestHash' IS DISTINCT FROM public.csd3_manifest_hash_fn(authority->'manifest') OR
    authority->>'operation' IS DISTINCT FROM authority->'manifest'->>'operation' OR
    authority->>'approvalReference' IS DISTINCT FROM authority->'manifest'->>'approvalReference' OR
    NOT coalesce(public.csm_manifest_instant_fn(authority->'expiresAt'),FALSE) OR
    (authority->>'expiresAt')::TIMESTAMPTZ <= clock_timestamp() OR NOT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = authority->>'loginRole' AND rolcanlogin AND
        NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) OR
    NOT pg_has_role(authority->>'loginRole',registrar_role,'MEMBER') OR
    pg_has_role(authority->>'loginRole',owner_role,'MEMBER') OR pg_has_role(authority->>'loginRole',reader_role,'MEMBER') THEN
    RAISE EXCEPTION 'D3 trusted single-command binding invalid';
  END IF;
  PERFORM public.csd3_assert_human_fn(authority->>'actorUserId',CASE authority->>'operation'
    WHEN 'register_window' THEN 'contribution-shadow.register.window' ELSE 'contribution-shadow.sign.disposition' END);
  EXECUTE format('CREATE OR REPLACE FUNCTION public.csd3_authority_fn() RETURNS JSONB LANGUAGE sql STABLE
    SET search_path = pg_catalog,public,pg_temp AS %L','SELECT ' || quote_literal(authority::TEXT) || '::JSONB');
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.csd3_register_fn(jsonb,text,text,text,text) TO %I',registrar_role);
END
$d3_acl$;
