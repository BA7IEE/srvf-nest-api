-- Maintainer-only ACL setup, not an automatic migration or approval authority.
-- Execute inside BEGIN, with SET LOCAL srvf.shadow_acl_database = exact database
-- and srvf.shadow_acl_action = bootstrap | bind | close. Bind additionally takes
-- srvf.shadow_registration_authority: the independently reviewed exact JSON.
-- The GUC is consumed by trusted DDL to install a literal function body. Runtime
-- callers changing the GUC cannot change that function or confer approval.
-- This script creates NOLOGIN roles and never supplies passwords or enables LOGIN.
DO $shadow_acl$
DECLARE
  target TEXT := current_setting('srvf.shadow_acl_database',TRUE);
  action TEXT := current_setting('srvf.shadow_acl_action',TRUE);
  owner_role TEXT := 'srvf_shadow_registration_owner';
  registrar_role TEXT := 'srvf_shadow_registrar';
  runtime_role TEXT := 'srvf_shadow_runtime';
  authority JSONB; signature TEXT; table_name TEXT; role_name TEXT;
BEGIN
  IF target IS DISTINCT FROM current_database() OR action IS NULL OR
    action NOT IN ('bootstrap','bind','close') THEN
    RAISE EXCEPTION 'shadow ACL explicit target and action required';
  END IF;
  -- Fixed isolated names are only accepted in the explicitly authorized w98 DB.
  IF current_database() = 'app_test_w98' THEN
    owner_role := 'srvf_shadow_owner_w98_fixture';
    registrar_role := 'srvf_shadow_registrar_w98_fixture';
    runtime_role := 'srvf_shadow_runtime_w98_fixture';
  END IF;
  IF action = 'bootstrap' THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ANY(ARRAY[owner_role,registrar_role,runtime_role])) THEN
      RAISE EXCEPTION 'shadow ACL roles already exist; no implicit reuse or replacement';
    END IF;
    FOREACH role_name IN ARRAY ARRAY[owner_role,registrar_role,runtime_role] LOOP
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',role_name);
    END LOOP;
    EXECUTE format('GRANT USAGE,CREATE ON SCHEMA public TO %I',owner_role);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I,%I',registrar_role,runtime_role);
    -- Only the NOLOGIN definer can read/check the full registration references.
    EXECUTE format('GRANT SELECT(id,role,status,"deletedAt") ON public."User" TO %I',owner_role);
    EXECUTE format('GRANT SELECT ON public.role_bindings,public.roles,
      public.role_permissions,public.permissions,public."Activity",public."ActivitySession",
      public."ActivitySessionPosition",public."ContributionPolicyVersion",
      public."ContributionShadowMappingApproval",public."ContributionShadowMappingRegistrationReceipt",
      public."ContributionShadowLegacySourceAnchor",public."ContributionShadowObservationWindow",
      public."ActivityContributionPolicySelectionRevision",public."ActivityContributionPolicySelectionItem",
      public."AttendanceSheet",public."ContributionShadowMappingApplication",
      public."ContributionShadowAttemptReceipt",public."ContributionShadowComparisonReceipt",
      public."ContributionShadowTerminalReceipt",
      public.audit_logs TO %I',owner_role);
    EXECUTE format('GRANT INSERT ON public.audit_logs TO %I',owner_role);
    -- FOR SHARE requires UPDATE on at least one column. No SQL in this package
    -- updates these keys; no login role may assume this definer identity.
    FOREACH table_name IN ARRAY ARRAY['User','role_bindings','roles','role_permissions','permissions',
      'Activity','ActivitySession','ActivitySessionPosition','ContributionPolicyVersion',
      'AttendanceSheet','audit_logs','ContributionShadowObservationWindow',
      'ContributionShadowAttemptReceipt','ActivityContributionPolicySelectionItem'] LOOP
      EXECUTE format('GRANT UPDATE(id) ON public.%I TO %I',table_name,owner_role);
    END LOOP;
    FOREACH table_name IN ARRAY ARRAY['ContributionShadowMappingApproval','ContributionShadowMappingRegistrationReceipt'] LOOP
      EXECUTE format('ALTER TABLE public.%I OWNER TO %I',table_name,owner_role);
    END LOOP;
    FOREACH signature IN ARRAY ARRAY['csm_registration_authority_fn()',
      'csm_assert_registration_authority_fn(jsonb,text)','csm_assert_registration_human_fn(text)',
      'csm_register_mapping_fn(jsonb,text,text,text,jsonb)','csm_pending_insert_guard_fn()',
      'csm_approval_receipt_closure_fn()','csm_runtime_authority_fn()',
      'csm_application_insert_guard_fn()','csm_assert_runtime_fn()',
      'csm_application_set_guard_fn()','cscr_insert_set_guard_fn()',
      'csar_insert_guard_fn()','cscr_insert_guard_fn()','cstr_insert_guard_fn()'] LOOP
      EXECUTE format('ALTER FUNCTION public.%s OWNER TO %I',signature,owner_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,%I,%I',signature,registrar_role,runtime_role);
    END LOOP;
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I',owner_role);
    -- Runtime authority is distinct from a single registrar manifest. Closing
    -- registrar EXECUTE does not erase already registered immutable approvals.
    authority := jsonb_build_object('databaseName',target,'ownerRole',owner_role,
      'registrarRole',registrar_role,'runtimeRole',runtime_role);
    EXECUTE format('CREATE OR REPLACE FUNCTION public.csm_runtime_authority_fn() RETURNS JSONB
      LANGUAGE sql STABLE SET search_path = pg_catalog,public,pg_temp AS %L',
      'SELECT ' || quote_literal(authority::TEXT) || '::JSONB');
    EXECUTE format('GRANT INSERT,SELECT ON public."ContributionShadowMappingApplication" TO %I',runtime_role);
    EXECUTE format('GRANT INSERT,SELECT ON public."ContributionShadowAttemptReceipt",
      public."ContributionShadowComparisonReceipt",public."ContributionShadowTerminalReceipt" TO %I',runtime_role);
    -- Current-user / GLOBAL RBAC reads only. No password hash or contact fields.
    EXECUTE format('GRANT SELECT(id,username,role,status,"memberId","deletedAt") ON public."User" TO %I',registrar_role);
    EXECUTE format('GRANT SELECT(id,"roleId","principalType","principalId","scopeType",status,
      "startedAt","endedAt","deletedAt") ON public.role_bindings TO %I',registrar_role);
    EXECUTE format('GRANT SELECT(id,"deletedAt") ON public.roles TO %I',registrar_role);
    EXECUTE format('GRANT SELECT(id,"roleId","permissionId") ON public.role_permissions TO %I',registrar_role);
    EXECUTE format('GRANT SELECT(id,code) ON public.permissions TO %I',registrar_role);
    -- Immutable source tuple only: IDs, frozen numeric inputs and digest. Raw
    -- AuditLog snapshots/contact fields remain unreadable by the runtime role.
    EXECUTE format('GRANT SELECT ON public."ContributionShadowMappingApproval",
      public."ContributionShadowLegacySourceAnchor" TO %I',runtime_role);
    RETURN;
  END IF;
  IF (SELECT count(*) FROM pg_roles WHERE rolname = ANY(ARRAY[owner_role,registrar_role,runtime_role])) <> 3 OR
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ANY(ARRAY[owner_role,registrar_role,runtime_role]) AND
      (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) OR
    (SELECT rolcanlogin FROM pg_roles WHERE rolname = owner_role) OR
    pg_has_role(registrar_role,owner_role,'MEMBER') OR pg_has_role(runtime_role,owner_role,'MEMBER') OR
    pg_has_role(runtime_role,registrar_role,'MEMBER') OR pg_has_role(registrar_role,runtime_role,'MEMBER') OR
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('ContributionShadowMappingApproval',
        'ContributionShadowMappingRegistrationReceipt') AND pg_get_userbyid(c.relowner) <> owner_role) OR
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN ('csm_registration_authority_fn',
        'csm_assert_registration_authority_fn','csm_assert_registration_human_fn',
        'csm_register_mapping_fn','csm_pending_insert_guard_fn','csm_approval_receipt_closure_fn',
        'csm_runtime_authority_fn','csm_application_insert_guard_fn','csm_assert_runtime_fn',
        'csm_application_set_guard_fn','cscr_insert_set_guard_fn',
        'csar_insert_guard_fn','cscr_insert_guard_fn','cstr_insert_guard_fn') AND
        pg_get_userbyid(p.proowner) <> owner_role) THEN
    RAISE EXCEPTION 'shadow ACL role or owner isolation invalid';
  END IF;
  IF action = 'close' THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION public.csm_register_mapping_fn(jsonb,text,text,text,jsonb) FROM %I',registrar_role);
    EXECUTE format('ALTER ROLE %I NOLOGIN',registrar_role);
    EXECUTE 'CREATE OR REPLACE FUNCTION public.csm_registration_authority_fn() RETURNS JSONB
      LANGUAGE sql STABLE SET search_path = pg_catalog,public,pg_temp AS ''SELECT NULL::JSONB''';
    RETURN;
  END IF;
  authority := current_setting('srvf.shadow_registration_authority',TRUE)::JSONB;
  IF NOT coalesce(public.csm_exact_keys_fn(authority,ARRAY['databaseName','manifestHash','actorUserId',
    'approvalReference','ownerRole','registrarRole','runtimeRole','manifest']),FALSE) OR
    authority->>'databaseName' IS DISTINCT FROM target OR
    authority->>'ownerRole' IS DISTINCT FROM owner_role OR
    authority->>'registrarRole' IS DISTINCT FROM registrar_role OR
    authority->>'runtimeRole' IS DISTINCT FROM runtime_role OR
    authority->>'approvalReference' IS DISTINCT FROM authority->'manifest'->>'approvalReference' OR
    authority->>'manifestHash' IS DISTINCT FROM public.csm_manifest_hash_fn(authority->'manifest') THEN
    RAISE EXCEPTION 'shadow ACL trusted single-manifest binding invalid';
  END IF;
  PERFORM public.csm_assert_registration_human_fn(authority->>'actorUserId');
  -- %L quotes data; caller data is never concatenated as SQL syntax.
  EXECUTE format('CREATE OR REPLACE FUNCTION public.csm_registration_authority_fn() RETURNS JSONB
    LANGUAGE sql STABLE SET search_path = pg_catalog,public,pg_temp AS %L',
    'SELECT ' || quote_literal(authority::TEXT) || '::JSONB');
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.csm_register_mapping_fn(jsonb,text,text,text,jsonb) TO %I',registrar_role);
END
$shadow_acl$;
