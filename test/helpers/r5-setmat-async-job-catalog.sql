-- READ-ONLY TEMPLATE; not executed. Run with search_path=pg_catalog after authorization.
WITH relations AS (
 SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname=ANY(ARRAY['ActivityBatchJob','ActivityBatchJobItem','ActivityInvitation','ActivitySession'])
), f AS (
 SELECT p.* FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.prokind IN ('f','p','w')
), table_rows AS (
 SELECT c.relname,jsonb_build_object(
  'name',c.relname,'kind',c.relkind,'owner',pg_catalog.pg_get_userbyid(c.relowner),
  'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'acl',c.relacl::text,
  'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'number',a.attnum,'name',a.attname,'type',a.atttypid::regtype::text,'typmod',a.atttypmod,
    'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
    'collation',a.attcollation::regcollation::text,'acl',a.attacl::text,
    'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid,false)) ORDER BY a.attnum)
    FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb),
  'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name',k.conname,'type',k.contype,'validated',k.convalidated,
    'deferrable',k.condeferrable,'initiallyDeferred',k.condeferred,
    'definition',pg_catalog.pg_get_constraintdef(k.oid,false)) ORDER BY k.conname)
    FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),'[]'::jsonb),
  'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name',t.tgname,'enabled',t.tgenabled,'function',t.tgfoid::regprocedure::text,
    'type',t.tgtype,'deferrable',t.tgdeferrable,'initiallyDeferred',t.tginitdeferred,
    'definition',pg_catalog.pg_get_triggerdef(t.oid,false)) ORDER BY t.tgname)
    FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'[]'::jsonb),
  'rules',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name',r.rulename,'enabled',r.ev_enabled,'definition',pg_catalog.pg_get_ruledef(r.oid,false)) ORDER BY r.rulename)
    FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid),'[]'::jsonb),
  'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name',ic.relname,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,
    'unique',i.indisunique,'expression',pg_catalog.pg_get_expr(i.indexprs,i.indrelid,false),
    'predicate',pg_catalog.pg_get_expr(i.indpred,i.indrelid,false),
    'definition',pg_catalog.pg_get_indexdef(i.indexrelid,0,false)) ORDER BY ic.relname)
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
    WHERE i.indrelid=c.oid),'[]'::jsonb),
  'policies',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
    'roles',p.polroles::text,'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid,false),
    'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,false)) ORDER BY p.polname)
    FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid),'[]'::jsonb)
 ) value FROM relations c
), function_rows AS (
 SELECT p.oid::regprocedure::text signature,jsonb_build_object(
  'signature',p.oid::regprocedure::text,'owner',pg_catalog.pg_get_userbyid(p.proowner),
  'language',l.lanname,'kind',p.prokind,'definer',p.prosecdef,'config',p.proconfig,
  'acl',p.proacl::text,'volatility',p.provolatile,'strict',p.proisstrict,
  'leakproof',p.proleakproof,'parallel',p.proparallel,'set',p.proretset,
  'returnType',p.prorettype::regtype::text,'argNames',p.proargnames,'argModes',p.proargmodes,
  'allArgTypes',p.proallargtypes::text,'defaults',pg_catalog.pg_get_function_arguments(p.oid),
  -- Avoid a self-referential hash. Preflight ownership and INVOKER attributes
  -- are checked independently; its exact offline source is an installer pin.
  'bodyHash',CASE WHEN p.proname='r5_correction_boundary_preflight' THEN 'INSTALLER_SOURCE_PIN'
    ELSE pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex') END,
  'sqlBody',p.prosqlbody::text) value FROM f p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
)
SELECT jsonb_build_object(
 'database',current_database(),'databaseOid',(SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=current_database()),
 'namespace',(SELECT jsonb_build_object('owner',pg_catalog.pg_get_userbyid(nspowner),'acl',nspacl::text)
   FROM pg_catalog.pg_namespace WHERE nspname='public'),
 'tables',(SELECT jsonb_agg(value ORDER BY relname) FROM table_rows),
 'functions',(SELECT jsonb_agg(value ORDER BY signature) FROM function_rows),
 'enumTypes',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',t.oid::regtype::text,
   'owner',pg_catalog.pg_get_userbyid(t.typowner),'labels',(SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
   FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid)) || CASE WHEN t.typname=ANY(ARRAY['AssignmentStatus','Role','StorageProviderType','UserStatus']) THEN jsonb_build_object('definition',jsonb_build_object('typlen',t.typlen,'typbyval',t.typbyval,'typtype',t.typtype,'typcategory',t.typcategory,'typispreferred',t.typispreferred,'typisdefined',t.typisdefined,'typdelim',t.typdelim,'typinput',t.typinput::regproc::text,'typoutput',t.typoutput::regproc::text,'typreceive',t.typreceive::regproc::text,'typsend',t.typsend::regproc::text,'typmodin',t.typmodin::regproc::text,'typmodout',t.typmodout::regproc::text,'typanalyze',t.typanalyze::regproc::text,'typsubscript',t.typsubscript::regproc::text,'typelem',t.typelem::text,'typrelid',t.typrelid::text,'typalign',t.typalign,'typstorage',t.typstorage,'typnotnull',t.typnotnull,'typbasetype',t.typbasetype::text,'typtypmod',t.typtypmod,'typndims',t.typndims,'typcollation',t.typcollation::text,'typdefault',t.typdefault,'typdefaultbin',t.typdefaultbin::text,'typacl',t.typacl::text)) ELSE '{}'::jsonb END ORDER BY t.typname)
   FROM pg_catalog.pg_type t WHERE t.typtype='e' AND t.oid IN
    (SELECT a.atttypid FROM pg_catalog.pg_attribute a JOIN relations r ON r.oid=a.attrelid
      WHERE a.attnum>0 AND NOT a.attisdropped)),'[]'::jsonb));
