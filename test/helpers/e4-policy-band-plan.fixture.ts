import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const POLICY_BAND_145 = 'b03a7298e625b703fa2f011c0fbcc6c0';
export const POLICY_BAND_146 = '40b56bac5a571c56e589cbc549419bfa';

export function policyBandCompleteBody(version: 145 | 146) {
  const name =
    version === 145
      ? '20261015010000_activity_contribution_evaluation_join_key'
      : '20261015221000_activity_contribution_policy_band_planning';
  const sql = readFileSync(
    resolve(__dirname, '../../prisma/migrations', name, 'migration.sql'),
    'utf8',
  );
  const body = sql.split('$$')[1];
  if (
    createHash('md5').update(body).digest('hex') !==
    (version === 145 ? POLICY_BAND_145 : POLICY_BAND_146)
  )
    throw new Error('E4 policy-band complete body differs');
  return body;
}

/** Complete functions, with only test storage redirected. All validation remains present.
 * The typed shadow tables have real column types and unique/check constraints; no triggers
 * or production rows are changed. Every mutation is rolled back before the next case. */
export function policyBandControlsSql(rootId: string, negatives = true) {
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(rootId)) throw new Error('E4 policy-band root refused');
  const baseline = policyBandCompleteBody(145),
    candidate = policyBandCompleteBody(146);
  if (
    candidate.replace('policy_bands AS NOT MATERIALIZED', 'policy_bands AS MATERIALIZED') !==
    baseline
  )
    throw new Error('E4 policy-band change exceeds one planning keyword');
  const frozen = readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
    ),
    'utf8',
  );
  const selection = frozen.match(
    /CREATE FUNCTION e4_assert_frozen_selection\([^]*?AS \$\$([^]*?)\$\$;/u,
  )?.[1];
  if (!selection || selection.split('FROM "ContributionPolicyVersion"').length !== 2)
    throw new Error('E4 policy-band frozen selection source refused');
  const shadow = (body: string) =>
    body
      .replaceAll('FROM "ActivitySettlementContributionRevision"', 'FROM pg_temp.e4_pb_roots')
      .replaceAll('"ParticipantContributionEvaluation"', 'pg_temp.e4_pb_evaluations')
      .replace('SELECT * FROM e4_source_rows(root.id)', 'SELECT * FROM pg_temp.e4_pb_sources')
      .replaceAll('"ContributionPolicyVersion"', 'pg_temp.e4_pb_policies')
      .replace('PERFORM e4_assert_frozen_selection(root)', 'PERFORM pg_temp.e4_pb_selection(root)')
      .replaceAll(
        'e4_evaluation_document(e)',
        'e4_evaluation_document(ROW(e.*)::public."ParticipantContributionEvaluation")',
      );
  const create = (name: string, body: string) =>
    `CREATE FUNCTION pg_temp.${name}(revision_id TEXT,validate_version BOOLEAN DEFAULT TRUE) RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $pb$${body}$pb$;`;
  const cases: [string, string, string, string][] = [
    [
      'MISSING',
      'DELETE FROM pg_temp.e4_pb_evaluations WHERE id=(SELECT min(id COLLATE "C") FROM pg_temp.e4_pb_evaluations)',
      '23514',
      'e4_evaluation_guard',
    ],
    [
      'EXTRA',
      `INSERT INTO pg_temp.e4_pb_evaluations SELECT altered.* FROM (SELECT * FROM pg_temp.e4_pb_evaluations ORDER BY id COLLATE "C" LIMIT 1) e CROSS JOIN LATERAL jsonb_populate_record(NULL::public."ParticipantContributionEvaluation",to_jsonb(e)||jsonb_build_object('id',md5('extra'||e.id),'evaluationUnitKey',repeat('f',64))) altered`,
      '23514',
      'e4_evaluation_guard',
    ],
    [
      'TAMPERED',
      `UPDATE pg_temp.e4_pb_evaluations SET "explanationCode"='pb_tampered' WHERE id=(SELECT min(id COLLATE "C") FROM pg_temp.e4_pb_evaluations)`,
      '23514',
      'e4_evaluation_guard',
    ],
    [
      'DUPLICATE',
      `INSERT INTO pg_temp.e4_pb_evaluations SELECT altered.* FROM (SELECT * FROM pg_temp.e4_pb_evaluations ORDER BY id COLLATE "C" LIMIT 1) e CROSS JOIN LATERAL jsonb_populate_record(NULL::public."ParticipantContributionEvaluation",to_jsonb(e)||jsonb_build_object('id',md5('duplicate'||e.id))) altered`,
      '23505',
      '',
    ],
    [
      'SOURCE_PRIORITY',
      `UPDATE pg_temp.e4_pb_sources SET item_id=NULL WHERE ctid=(SELECT ctid FROM pg_temp.e4_pb_sources LIMIT 1); UPDATE pg_temp.e4_pb_evaluations SET "explanationCode"='pb_tampered'; UPDATE pg_temp.e4_pb_roots SET "evaluationCount"="evaluationCount"+1`,
      '23514',
      'e4_source_guard',
    ],
    [
      'ROOT',
      'UPDATE pg_temp.e4_pb_roots SET "evaluationCount"="evaluationCount"+1',
      '23514',
      'e4_complete_guard',
    ],
    [
      'INVALID_UNSELECTED_POLICY',
      `UPDATE pg_temp.e4_pb_policies SET "definitionJson"=jsonb_set("definitionJson",'{roleRules}',("definitionJson"->'roleRules')||jsonb_build_array(jsonb_build_object('attendanceRoleCode','pb_unselected','categoryRules',jsonb_build_array(jsonb_build_object('timeCategoryCode','volunteer_service','durationBands','[]'::jsonb))))) WHERE id=(SELECT min(policy_version_id COLLATE "C") FROM pg_temp.e4_pb_sources)`,
      '23514',
      '',
    ],
  ];
  const digest = `(SELECT md5(jsonb_build_object('roots',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id COLLATE "C") FROM pg_temp.e4_pb_roots r),'evaluations',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id COLLATE "C") FROM pg_temp.e4_pb_evaluations e),'sources',(SELECT jsonb_agg(to_jsonb(s) ORDER BY to_jsonb(s)::TEXT COLLATE "C") FROM pg_temp.e4_pb_sources s),'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id COLLATE "C") FROM pg_temp.e4_pb_policies p))::TEXT))`;
  return `BEGIN;
SET LOCAL statement_timeout='20s';
CREATE TEMP TABLE e4_pb_roots ON COMMIT DROP AS SELECT * FROM public."ActivitySettlementContributionRevision" WHERE id='${rootId}';
CREATE TEMP TABLE e4_pb_sources ON COMMIT DROP AS SELECT * FROM public.e4_source_rows('${rootId}');
CREATE TEMP TABLE e4_pb_evaluations (LIKE public."ParticipantContributionEvaluation" INCLUDING ALL) ON COMMIT DROP;
INSERT INTO e4_pb_evaluations SELECT * FROM public."ParticipantContributionEvaluation" WHERE "contributionRevisionId"='${rootId}';
CREATE TEMP TABLE e4_pb_policies ON COMMIT DROP AS SELECT * FROM public."ContributionPolicyVersion";
ANALYZE e4_pb_roots; ANALYZE e4_pb_sources; ANALYZE e4_pb_evaluations; ANALYZE e4_pb_policies;
CREATE FUNCTION pg_temp.e4_pb_selection(root public."ActivitySettlementContributionRevision") RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $selection$${selection.replace('FROM "ContributionPolicyVersion"', 'FROM pg_temp.e4_pb_policies').replace('csm_policy_fingerprint_fn(p)', 'csm_policy_fingerprint_fn(ROW(p.*)::public."ContributionPolicyVersion")')}$selection$;
${create('e4_pb_145', shadow(baseline))}
${create('e4_pb_146', shadow(candidate))}
DO $positive$ BEGIN
  PERFORM pg_temp.e4_pb_145('${rootId}'); PERFORM pg_temp.e4_pb_146('${rootId}');
  RAISE NOTICE 'E4_PB_CONTROL %',json_build_object('case','POSITIVE','versions',ARRAY[145,146],'completeFunction',true)::TEXT;
END $positive$;
${(negatives ? cases : [])
  .flatMap(([kind, mutation, state, guard]) =>
    [145, 146].map(
      (version) => `
DO $negative$ DECLARE original TEXT; actual_state TEXT; actual_guard TEXT; mutation_passed BOOLEAN:=FALSE;
BEGIN
  original:=${digest};
  BEGIN
    ${mutation}; mutation_passed:=TRUE;
    PERFORM pg_temp.e4_pb_${version}('${rootId}');
    RAISE EXCEPTION 'policy-band negative accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state=RETURNED_SQLSTATE,actual_guard=CONSTRAINT_NAME;
    IF actual_state<>'${state}' ${guard ? `OR actual_guard<>'${guard}'` : kind === 'DUPLICATE' ? '' : "OR coalesce(actual_guard,'')<>''"}
      OR mutation_passed IS DISTINCT FROM ${kind === 'DUPLICATE' ? 'FALSE' : 'TRUE'} THEN
      RAISE EXCEPTION 'policy-band control % version %: state %, guard %, mutation %','${kind}',${version},actual_state,actual_guard,mutation_passed;
    END IF;
  END;
  IF original IS DISTINCT FROM ${digest} THEN RAISE EXCEPTION 'policy-band mutation leaked'; END IF;
  RAISE NOTICE 'E4_PB_CONTROL %',json_build_object('case','${kind}','version',${version},'state',actual_state,'guard',actual_guard,'mutationPassed',mutation_passed,'rolledBack',true,'completeFunction',${kind !== 'DUPLICATE'})::TEXT;
END $negative$;`,
    ),
  )
  .join('\n')}
ROLLBACK;
`;
}
