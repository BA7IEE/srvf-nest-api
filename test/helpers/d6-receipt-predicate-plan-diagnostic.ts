import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { types } from 'node:util';
import { deriveTestDbName } from '../setup/worktree-db';

export type D6PredicateLabel = 'SOURCE_READY' | 'BUCKET_SOURCE' | 'BUCKET_TOTAL';
const labels: D6PredicateLabel[] = ['SOURCE_READY', 'BUCKET_SOURCE', 'BUCKET_TOTAL'];
export type D6PredicatePlanClient = Pick<PrismaClient, '$transaction'>;
type Options = { env?: NodeJS.ProcessEnv; source?: string };
const bodyHash = 'b4f874b7fe90738bac9df353e0c0fbaa20e3cbc1090d025b643591e6332cae67';
const migration =
  'prisma/migrations/20260913090000_activity_os_r4_d4_time_bucket_settlement/migration.sql';

export const D6_PREDICATE_SQL = Object.freeze({
  readOnly: 'SET TRANSACTION READ ONLY',
  timeout: "SET LOCAL statement_timeout='2000ms'",
  metadata: `SELECT pg_catalog.jsonb_build_object(
    'database',current_database()=$1 AND NOT pg_catalog.pg_is_in_recovery(),
    'sameRole',current_user=session_user,
    'readOnly',current_setting('transaction_read_only')='on',
    'repeatableRead',current_setting('transaction_isolation')='repeatable read',
    'backend',pg_catalog.pg_backend_pid(),
    'virtual',(SELECT virtualxid FROM pg_catalog.pg_locks
      WHERE pid=pg_catalog.pg_backend_pid() AND locktype='virtualxid'
        AND mode='ExclusiveLock' AND granted),
    'planCacheMode',current_setting('plan_cache_mode'),
    'guard',(SELECT pg_catalog.jsonb_build_object(
      'oid',oid::BIGINT,'version',xmin::TEXT,
      'pinned',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(prosrc,'UTF8')),'hex')=$3)
      FROM pg_catalog.pg_proc WHERE oid=pg_catalog.to_regprocedure('public.astr_receipt_complete_guard()')),
    'sealed',EXISTS(SELECT 1 FROM public."ActivitySettlementTimeRevision" p
      JOIN public."ActivitySettlementTimeCommandReceipt" r ON r."timeRevisionId"=p.id
        AND r."activityId"=p."activityId"
      WHERE p.id=$2 AND p."kindCode"='draft' AND r."operationCode"='prepare_time_settlement')
  ) AS observation`,
});

function requireValue(value: unknown): asserts value {
  if (!value) throw new Error('D6 post-prepare plan observation unavailable');
}
function own(value: unknown, key: string, optional = false): unknown {
  requireValue(value && typeof value === 'object' && !types.isProxy(value));
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor && optional) return undefined;
  requireValue(descriptor && 'value' in descriptor);
  return descriptor.value as unknown;
}
function array(value: unknown, maximum: number): unknown[] {
  requireValue(!types.isProxy(value) && Array.isArray(value) && value.length <= maximum);
  return value as unknown[];
}
function number(value: unknown): number {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e12);
  return value;
}
function metric(value: unknown, key: string): number | null {
  const result = own(value, key, true);
  return result === undefined ? null : number(result);
}

/** Only the pinned repository predicates can become executable diagnostic SQL. */
function pinnedPredicates(source: string): Record<D6PredicateLabel, string> {
  const matches = [
    ...source.matchAll(
      /CREATE FUNCTION astr_receipt_complete_guard\(\) RETURNS trigger LANGUAGE plpgsql AS \$\$(.*?)\$\$;/gs,
    ),
  ];
  requireValue(matches.length === 1);
  const body = matches[0][1];
  requireValue(createHash('sha256').update(body).digest('hex') === bodyHash);
  const markers = {
    SOURCE_READY: '\n    WITH source_counts AS MATERIALIZED (',
    BUCKET_SOURCE: '\n    WITH source_facts AS (',
    BUCKET_TOTAL:
      '\n    -- Keep this bounded aggregate single-evaluation even before fresh-table statistics exist.',
  };
  const queries = {} as Record<D6PredicateLabel, string>;
  for (const label of labels) {
    const start = body.indexOf('  IF EXISTS (' + markers[label]);
    requireValue(start >= 0);
    const end = body.indexOf(
      `  ) THEN\n    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'astcr_${label.toLowerCase()}_guard',`,
      start,
    );
    requireValue(end > start);
    let predicate = body
      .slice(start + '  IF EXISTS ('.length, end)
      .replaceAll('draft_id', 'parent_row."settlementVersionId"');
    for (const table of Object.keys(relations))
      predicate = predicate.replaceAll(`"${table}"`, `public."${table}"`);
    queries[label] = predicate;
  }
  return queries;
}
function explainPredicate(predicate: string): string {
  // A zero-row verdict is not accepted as a fast success.
  return `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
WITH verdict AS MATERIALIZED (
  SELECT NOT EXISTS (${predicate}) AS valid
  FROM public."ActivitySettlementTimeRevision" parent_row
  WHERE parent_row.id=$1 AND parent_row."kindCode"='draft'
) SELECT 1 FROM verdict WHERE valid`;
}
export function d6ReceiptPredicateAuthority(source: string): Record<D6PredicateLabel, string> {
  const predicates = pinnedPredicates(source);
  return {
    SOURCE_READY: explainPredicate(predicates.SOURCE_READY),
    BUCKET_SOURCE: explainPredicate(predicates.BUCKET_SOURCE),
    BUCKET_TOTAL: explainPredicate(predicates.BUCKET_TOTAL),
  };
}

const kinds = new Set([
  'Result',
  'Aggregate',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'Seq Scan',
  'Nested Loop',
  'Hash Join',
  'Merge Join',
  'Sort',
  'Incremental Sort',
  'Materialize',
  'CTE Scan',
  'Subquery Scan',
  'Hash',
  'Append',
  'Limit',
  'WindowAgg',
  'Unique',
  'Gather',
  'Gather Merge',
  'Memoize',
  'Function Scan',
  'ProjectSet',
  'SetOp',
  'Values Scan',
  'Group',
]);
const relations: Record<string, string> = Object.assign(Object.create(null) as object, {
  ActivitySettlementTimeRevision: 'PARENT',
  ParticipantSettlementTimeBucketSource: 'BUCKET_SOURCE',
  ParticipantSettlementTimeBucket: 'BUCKET',
  ParticipantTimeAllocationRevision: 'ALLOCATION',
  ParticipantServiceSegmentRevision: 'SEGMENT',
  ActivityParticipationIdentity: 'PARTICIPATION',
  ParticipantSettlementResultRevision: 'SETTLEMENT_RESULT',
  ParticipantTimeAllocationSlice: 'SLICE',
  TimePolicyVersion: 'POLICY',
  ActivityRuleSnapshot: 'SNAPSHOT',
});
function buffers(value: unknown) {
  return {
    hit: metric(value, 'Shared Hit Blocks'),
    read: metric(value, 'Shared Read Blocks'),
    tempRead: metric(value, 'Temp Read Blocks'),
    tempWritten: metric(value, 'Temp Written Blocks'),
  };
}
type WorkNode = {
  kind: string;
  relation: string | null;
  estimatedRows: number;
  rows: number;
  loops: number;
  removed: number | null;
  joinRemoved: number | null;
  buffers: ReturnType<typeof buffers>;
};
function work(node: WorkNode): number {
  return Math.max(1, node.rows + (node.removed ?? 0) + (node.joinRemoved ?? 0)) * node.loops;
}
export type D6PredicatePlanSummary = {
  executionMs: number;
  planningMs: number;
  rootRows: number;
  rootLoops: number;
  rootBuffers: ReturnType<typeof buffers>;
  parsedNodes: number;
  topWorkNodes: WorkNode[];
};

/** Never enumerate/stringify raw plans: forbidden fields may contain values or accessors. */
function inspectPredicatePlan(rows: unknown) {
  const first = own(array(rows, 1), '0');
  const document = own(array(own(first, 'QUERY PLAN'), 1), '0');
  const root = own(document, 'Plan');
  const stack = [{ node: root, depth: 0 }];
  const nodes: WorkNode[] = [];
  while (stack.length) {
    const item = stack.pop()!;
    requireValue(item.depth <= 32 && nodes.length < 256);
    const kind = own(item.node, 'Node Type');
    const relation = own(item.node, 'Relation Name', true);
    requireValue(
      typeof kind === 'string' && (relation === undefined || typeof relation === 'string'),
    );
    const rows = number(own(item.node, 'Actual Rows'));
    const loops = number(own(item.node, 'Actual Loops'));
    requireValue(Number.isSafeInteger(rows * loops));
    nodes.push({
      kind: kinds.has(kind) ? kind : 'OTHER',
      relation: relation === undefined ? null : (relations[relation] ?? 'OTHER'),
      estimatedRows: number(own(item.node, 'Plan Rows')),
      rows,
      loops,
      removed: metric(item.node, 'Rows Removed by Filter'),
      joinRemoved: metric(item.node, 'Rows Removed by Join Filter'),
      buffers: buffers(item.node),
    });
    const children = own(item.node, 'Plans', true);
    if (children !== undefined) {
      const values = array(children, 32);
      for (let i = values.length - 1; i >= 0; i--)
        stack.push({ node: own(values, String(i)), depth: item.depth + 1 });
    }
  }
  const plan: D6PredicatePlanSummary = {
    executionMs: number(own(document, 'Execution Time')),
    planningMs: number(own(document, 'Planning Time')),
    rootRows: number(own(root, 'Actual Rows')),
    rootLoops: number(own(root, 'Actual Loops')),
    rootBuffers: buffers(root),
    parsedNodes: nodes.length,
    topWorkNodes: nodes.sort((a, b) => work(b) - work(a)).slice(0, 6),
  };
  const sliceScans = nodes.filter((node) => node.relation === 'SLICE');
  return { plan, sliceScans };
}
export function summarizeD6PredicatePlan(rows: unknown): D6PredicatePlanSummary {
  return inspectPredicatePlan(rows).plan;
}

type Mode = 'auto' | 'force_generic_plan' | 'force_custom_plan';
type Reason =
  | 'NONE'
  | 'ENVIRONMENT'
  | 'WORKER'
  | 'REFERENCE'
  | 'AUTHORITY'
  | 'TRANSACTION'
  | 'READ_ONLY'
  | 'METADATA'
  | 'PLAN_SQL'
  | 'PLAN_TIMEOUT'
  | 'TRANSACTION_BUDGET'
  | 'PLAN_SHAPE'
  | 'IDENTITY'
  | 'POST_PREPARE_DATA_CHANGED'
  | 'COUNTEREXAMPLES'
  | 'OUTPUT';
type Row = {
  label: D6PredicateLabel;
  status: 'CAPTURED' | 'UNKNOWN';
  reason: Reason;
  sameBackend: boolean | null;
  sameVirtualTransaction: boolean | null;
  readOnly: boolean | null;
  functionPinned: boolean | null;
  parentSealed: boolean | null;
  planCacheMode: Mode | null;
  plan: D6PredicatePlanSummary | null;
};
function empty(label: D6PredicateLabel, reason: Reason): Row {
  return {
    label,
    status: 'UNKNOWN',
    reason,
    sameBackend: null,
    sameVirtualTransaction: null,
    readOnly: null,
    functionPinned: null,
    parentSealed: null,
    planCacheMode: null,
    plan: null,
  };
}
function snapshot(
  status: 'DISABLED' | 'UNKNOWN' | 'PARTIAL' | 'OBSERVED',
  reason: Reason,
  rows: Row[] = [],
  transactions = 0,
  statements = 0,
) {
  return {
    status,
    reason,
    purpose: 'POST_PREPARE_PLAN_SAMPLE_NOT_NATIVE_GUARD_OR_PLAN_CACHE_PROOF',
    scope: 'EACH_PREDICATE_SEPARATE_READ_ONLY_TRANSACTION_AFTER_NATIVE_SUCCESS',
    effects: 'EXTRA_READS_MAY_WARM_CACHES_LATER_WORKER_TIMINGS_INSTRUMENTED',
    work: 'ROOT_AND_TOP_SIX_ROW_FILTER_LOOP_PROXY_NOT_CPU_OR_COMPLETE_PLAN',
    buffers: 'INCLUSIVE_NODE_BUFFERS_DO_NOT_SUM_PARENT_CHILDREN',
    missing: 'MISSING_METRICS_ARE_NULL_NOT_ZERO',
    transactionBudgetMs: 5000,
    statementBudgetMs: 2000,
    transactions,
    explicitObserverStatements: statements,
    rows,
  };
}
export type D6PredicatePlanSnapshot = ReturnType<typeof snapshot>;

type Metadata = {
  backend: number;
  virtual: string;
  mode: Mode;
  oid: number;
  version: string;
};
function metadata(rows: unknown): Metadata {
  const value = own(own(array(rows, 1), '0'), 'observation');
  for (const key of ['database', 'sameRole', 'readOnly', 'sealed'])
    requireValue(own(value, key) === true);
  const guard = own(value, 'guard');
  requireValue(own(guard, 'pinned') === true);
  const backend = number(own(value, 'backend'));
  const oid = number(own(guard, 'oid'));
  const version = own(guard, 'version');
  const virtual = own(value, 'virtual');
  const mode = own(value, 'planCacheMode');
  requireValue(
    Number.isSafeInteger(backend) && backend > 0 && Number.isSafeInteger(oid) && oid > 0,
  );
  requireValue(typeof version === 'string' && /^[1-9][0-9]{0,19}$/u.test(version));
  requireValue(typeof virtual === 'string' && /^[1-9][0-9]{0,9}\/[1-9][0-9]{0,12}$/u.test(virtual));
  requireValue(mode === 'auto' || mode === 'force_generic_plan' || mode === 'force_custom_plan');
  return { backend, oid, version, virtual, mode };
}
function failureReason(error: unknown, fallback: Reason): Reason {
  try {
    const code = own(error, 'code', true);
    if (code === 'P2028') return 'TRANSACTION_BUDGET';
    if (code === 'P2010' && own(own(error, 'meta'), 'code') === '57014') return 'PLAN_TIMEOUT';
  } catch {
    // Unknown/error accessors are not part of the diagnostic protocol.
  }
  return fallback;
}

export async function observeD6ReceiptPredicatePlans(
  client: D6PredicatePlanClient,
  reference: unknown,
  options: Options = {},
): Promise<D6PredicatePlanSnapshot> {
  let phase: Reason = 'ENVIRONMENT';
  let expected: string;
  let queries: Record<D6PredicateLabel, string>;
  try {
    const env = options.env ?? process.env;
    if (
      env.GITHUB_ACTIONS !== 'true' ||
      env.GITHUB_WORKFLOW !== 'CI' ||
      env.GITHUB_JOB !== 'slow' ||
      env.GITHUB_EVENT_NAME !== 'pull_request'
    )
      return snapshot('DISABLED', 'ENVIRONMENT');
    phase = 'WORKER';
    requireValue(/^[1-9][0-9]?$/u.test(process.env.JEST_WORKER_ID ?? ''));
    expected = deriveTestDbName();
    phase = 'REFERENCE';
    requireValue(typeof reference === 'string' && /^[A-Za-z0-9_:-]{1,200}$/u.test(reference));
    phase = 'AUTHORITY';
    queries = d6ReceiptPredicateAuthority(
      options.source ?? readFileSync(resolve(__dirname, '../..', migration), 'utf8'),
    );
  } catch {
    return snapshot('UNKNOWN', phase);
  }
  const rows: Row[] = [];
  let transactions = 0;
  let statements = 0;
  for (const label of labels) {
    let stage: Reason = 'TRANSACTION';
    let active = true;
    try {
      transactions++;
      const row = await client.$transaction(
        async (tx): Promise<Row> => {
          const execute = (sql: string) => {
            requireValue(active);
            statements++;
            return tx.$executeRawUnsafe(sql);
          };
          const query = (sql: string, ...values: unknown[]) => {
            requireValue(active);
            statements++;
            return tx.$queryRawUnsafe(sql, ...values);
          };
          stage = 'READ_ONLY';
          await execute(D6_PREDICATE_SQL.readOnly);
          await execute(D6_PREDICATE_SQL.timeout);
          stage = 'METADATA';
          const before = metadata(
            await query(D6_PREDICATE_SQL.metadata, expected, reference, bodyHash),
          );
          stage = 'PLAN_SQL';
          const raw = await query(queries[label], reference);
          stage = 'PLAN_SHAPE';
          const plan = summarizeD6PredicatePlan(raw);
          stage = 'POST_PREPARE_DATA_CHANGED';
          requireValue(plan.rootRows === 1 && plan.rootLoops === 1);
          stage = 'METADATA';
          const after = metadata(
            await query(D6_PREDICATE_SQL.metadata, expected, reference, bodyHash),
          );
          stage = 'IDENTITY';
          requireValue(
            before.backend === after.backend &&
              before.virtual === after.virtual &&
              before.oid === after.oid &&
              before.version === after.version &&
              before.mode === after.mode,
          );
          return {
            label,
            status: 'CAPTURED',
            reason: 'NONE',
            sameBackend: true,
            sameVirtualTransaction: true,
            readOnly: true,
            functionPinned: true,
            parentSealed: true,
            planCacheMode: before.mode,
            plan,
          };
        },
        { maxWait: 1000, timeout: 5000 },
      );
      rows.push(row);
    } catch (error) {
      rows.push(empty(label, failureReason(error, stage)));
      if (['READ_ONLY', 'METADATA', 'TRANSACTION'].includes(stage)) {
        for (const rest of labels.slice(rows.length)) rows.push(empty(rest, stage));
        break;
      }
    } finally {
      active = false;
    }
  }
  const captured = rows.filter((row) => row.status === 'CAPTURED').length;
  const result = snapshot(
    captured === 3 ? 'OBSERVED' : captured ? 'PARTIAL' : 'UNKNOWN',
    captured === 3 ? 'NONE' : rows.find((row) => row.reason !== 'NONE')!.reason,
    rows,
    transactions,
    statements,
  );
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= 8192) return result;
  return snapshot(
    'UNKNOWN',
    'OUTPUT',
    labels.map((label) => empty(label, 'OUTPUT')),
    transactions,
    statements,
  );
}

export const D6_SLICE_COMPARISON_READ_ONLY =
  'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY';
export const D6_SLICE_CASES = Object.freeze([
  'UNCHANGED',
  'FORGED_DURATION',
  'EMPTY_CATEGORY',
  'EMPTY_CATEGORY_ZERO',
  'NULL_VS_ZERO',
  'NULL_BASELINE',
  'FORGED_QUANTUM',
  'MISSING_SOURCE',
] as const);
type SliceCase = (typeof D6_SLICE_CASES)[number];
type SliceVariant = 'ORIGINAL' | 'ONCE_PER_ALLOCATION';
type SliceControl = {
  label: SliceCase;
  originalRejected: boolean;
  candidateRejected: boolean;
  sameRejectSet: boolean;
  readinessRejected: boolean;
  sourceRows: number;
  sliceRows: number;
};
type SliceSample = {
  order: 'AB' | 'BA';
  variant: SliceVariant;
  executionMs: number;
  planningMs: number;
  rootRows: number;
  rootLoops: number;
  rootBuffers: ReturnType<typeof buffers>;
  maxWorkNode: WorkNode | null;
  sliceScans: WorkNode[];
};
type SliceIdentity = {
  phase: 'CONTROLS' | 'AB' | 'BA';
  sameBackend: true;
  sameVirtualTransaction: true;
  repeatableRead: true;
  readOnly: true;
  functionPinned: true;
  parentSealed: true;
  planCacheMode: Mode;
};
type SliceFailure = {
  phase: SliceIdentity['phase'] | null;
  variant: SliceVariant | null;
  stage: Reason;
};
function sliceSnapshot(
  status: 'DISABLED' | 'UNKNOWN' | 'PARTIAL' | 'OBSERVED',
  reason: string,
  controls: SliceControl[] = [],
  samples: SliceSample[] = [],
  identities: SliceIdentity[] = [],
  transactions = 0,
  statements = 0,
  equivalent: boolean | null = null,
  failure: SliceFailure | null = null,
) {
  return {
    status,
    reason,
    purpose: 'READ_ONLY_SHADOW_AB_NOT_NATIVE_GUARD_OR_PERFORMANCE_ACCEPTANCE',
    scope: 'SAME_REPEATABLE_READ_SNAPSHOT_WITHIN_EACH_PAIR_NOT_ACROSS_PAIRS',
    candidate: 'CURRENT_REVISION_ALLOCATION_LOCAL_NUMERIC_TOTALS_AND_SOURCE_IDS',
    oracle: 'NORMAL_INPUT_BOTH_EMPTY_REJECT_SETS_PLUS_BIDIRECTIONAL_PROJECTION_COUNTEREXAMPLES',
    oracleScope: 'ONLY_SOURCE_READY_AND_BUCKET_SOURCE_NOT_COMPLETE_GUARD_ACCEPTANCE',
    completeness: 'ORIGINAL_SOURCE_READY_UNCHANGED_AND_TESTED_FOR_MISSING_SOURCE',
    effects: 'EXTRA_READS_MAY_WARM_CACHES_NO_FORCED_PLAN_MODE_OR_STATISTICS_UPDATE',
    buffers: 'INCLUSIVE_NODE_BUFFERS_DO_NOT_SUM_PARENT_CHILDREN',
    work: 'ROW_LOOP_PROXY_NOT_NODE_TIME_OR_CPU',
    rows: 'POSTGRES_ROUNDED_PER_LOOP_AVERAGES_NOT_EXACT_TUPLE_TOTALS',
    transactionBudgetMs: 5000,
    statementBudgetMs: 2000,
    transactions,
    explicitObserverStatements: statements,
    equivalent,
    failure,
    controls,
    samples,
    identities,
  };
}
export type D6SliceComparisonSnapshot = ReturnType<typeof sliceSnapshot>;
export function d6ReceiptSliceComparisonAuthority(source: string) {
  const predicates = pinnedPredicates(source);
  const original = predicates.BUCKET_SOURCE;
  const start = original.indexOf(
    '(SELECT coalesce(sum(extract(epoch FROM (slice."endAt" - slice."startAt")) * 1000), 0)',
  );
  const suffix = ') AS expected_recognized';
  const end = original.indexOf(suffix, start) + suffix.length;
  requireValue(start >= 0 && end > start);
  const categories = ['volunteer_service', 'training', 'organization', 'non_creditable'];
  const expected = `CASE b."categoryCode" ${categories
    .map((category) => `WHEN '${category}' THEN d6_totals."${category}"`)
    .join(' ')} ELSE 0::NUMERIC END AS expected_recognized`;
  let scoped = original.slice(0, start) + expected + original.slice(end);
  const sums = categories
    .map(
      (category) => `coalesce(sum(extract(epoch FROM
        (slice."endAt" - slice."startAt")) * 1000)
        FILTER (WHERE slice."categoryCode" = '${category}'), 0) AS "${category}"`,
    )
    .join(',\n');
  // Keep this lateral subquery correlated: its materialized scope is one small
  // allocation packet, not an unindexed all-allocation aggregate-to-source join.
  scoped = scoped.replace(
    'WITH source_facts AS (',
    `WITH d6_source_scope AS MATERIALIZED (
      SELECT d6_totals."allocationRevisionId" AS id, d6_totals.source_ids
    ), source_facts AS (`,
  );
  scoped = scoped.replace(
    'WHERE bs."timeRevisionId" = parent_row.id',
    `CROSS JOIN d6_source_scope
      WHERE bs."timeRevisionId" = parent_row.id
        AND bs."allocationRevisionId" = d6_source_scope.id
        AND bs.id = ANY(d6_source_scope.source_ids)`,
  );
  requireValue(scoped.includes('CROSS JOIN d6_source_scope'));
  const rejectIds = (predicate: string) => {
    requireValue(predicate.includes('SELECT 1 FROM source_facts f'));
    return predicate.replace(
      'SELECT 1 FROM source_facts f',
      'SELECT f.id AS id FROM source_facts f',
    );
  };
  const candidate = `WITH d6_allocation_ids AS MATERIALIZED (
      SELECT "allocationRevisionId", array_agg(id ORDER BY id COLLATE "C") AS source_ids
      FROM public."ParticipantSettlementTimeBucketSource"
      WHERE "timeRevisionId" = parent_row.id
      GROUP BY "allocationRevisionId"
    ), d6_allocation_totals AS MATERIALIZED (
      SELECT ids."allocationRevisionId", ids.source_ids, per_allocation.*
      FROM d6_allocation_ids ids
      CROSS JOIN LATERAL (
        SELECT ${sums}
        FROM public."ParticipantTimeAllocationSlice" slice
        WHERE slice."allocationRevisionId" = ids."allocationRevisionId"
      ) per_allocation
    )
    SELECT d6_rejections.id AS id
    FROM d6_allocation_totals d6_totals
    CROSS JOIN LATERAL (${rejectIds(scoped)}) d6_rejections`;
  const difference = `d6_difference AS (
    (SELECT id FROM d6_original EXCEPT SELECT id FROM d6_candidate)
    UNION ALL
    (SELECT id FROM d6_candidate EXCEPT SELECT id FROM d6_original)
  )`;
  const project = (predicate: string) => {
    for (const [relation, replacement] of [
      ['ParticipantSettlementTimeBucketSource', 'd6_source'],
      ['ParticipantSettlementTimeBucket', 'd6_bucket'],
      ['ParticipantTimeAllocationSlice', 'd6_slice'],
      ['TimePolicyVersion', 'd6_policy'],
    ])
      predicate = predicate.replaceAll(`public."${relation}"`, replacement);
    return predicate;
  };
  const readiness = predicates.SOURCE_READY.replaceAll(
    'public."ParticipantSettlementTimeBucketSource"',
    'd6_ready_source',
  );
  const cases = D6_SLICE_CASES.map((label, ordinal) => `(${ordinal},'${label}')`).join(',');
  // Projection-only counterexamples exercise these two source stages, not acceptance
  // by the complete receipt guard. Actual guard forgery E2E tests remain unchanged.
  const counterexamples = `SELECT c.label, proof.*
  FROM public."ActivitySettlementTimeRevision" parent_row
  CROSS JOIN (VALUES ${cases}) c(ordinal,label)
  CROSS JOIN LATERAL (
    WITH d6_sample_allocation AS MATERIALIZED (
      SELECT "allocationRevisionId" AS id
      FROM public."ParticipantSettlementTimeBucketSource"
      WHERE "timeRevisionId"=parent_row.id
      GROUP BY "allocationRevisionId" HAVING count(*)=4
      ORDER BY "allocationRevisionId" COLLATE "C" LIMIT 1
    ), d6_sample_source AS MATERIALIZED (
      SELECT s.* FROM public."ParticipantSettlementTimeBucketSource" s
      JOIN d6_sample_allocation a ON a.id=s."allocationRevisionId"
      WHERE s."timeRevisionId"=parent_row.id
    ), d6_source AS MATERIALIZED (
      SELECT s.id,s."bucketId",s."timeRevisionId",s."activityId",s."allocationRevisionId",
        s."sourceSegmentId",s."sourceSegmentRevision",
        CASE WHEN c.label='NULL_BASELINE' OR
          (c.label='NULL_VS_ZERO' AND b."categoryCode"='training')
          THEN NULL::BIGINT ELSE s."rawCalculatedMilliseconds" END AS "rawCalculatedMilliseconds",
        CASE WHEN c.label='FORGED_DURATION' THEN s."rawRecognizedMilliseconds"+1
          WHEN c.label='EMPTY_CATEGORY_ZERO' AND b."categoryCode"='training' THEN 0::BIGINT
          ELSE s."rawRecognizedMilliseconds" END AS "rawRecognizedMilliseconds"
      FROM d6_sample_source s JOIN public."ParticipantSettlementTimeBucket" b ON b.id=s."bucketId"
      WHERE NOT(c.label='MISSING_SOURCE' AND b."categoryCode"='training')
    ), d6_bucket AS MATERIALIZED (
      SELECT b.id,b."participationIdentityId",b."categoryCode",b."timePolicyVersionId",
        b."definitionHash",b."evaluatorVersion",
        b."quantumSeconds"+CASE WHEN c.label='FORGED_QUANTUM' THEN 1 ELSE 0 END AS "quantumSeconds"
      FROM public."ParticipantSettlementTimeBucket" b
      WHERE b.id IN (SELECT "bucketId" FROM d6_sample_source)
    ), d6_slice AS MATERIALIZED (
      SELECT s.* FROM public."ParticipantTimeAllocationSlice" s
      JOIN d6_sample_allocation a ON a.id=s."allocationRevisionId"
      WHERE NOT(c.label IN ('EMPTY_CATEGORY','EMPTY_CATEGORY_ZERO') AND s."categoryCode"='training')
    ), d6_policy AS MATERIALIZED (
      SELECT p.id,CASE WHEN c.label='NULL_BASELINE'
        THEN jsonb_set(p."definitionJson",'{evidence,requireManualRecognition}','true'::jsonb,false)
        ELSE p."definitionJson" END AS "definitionJson"
      FROM public."TimePolicyVersion" p WHERE p.id IN (
        SELECT a."policyVersionId" FROM public."ParticipantTimeAllocationRevision" a
        JOIN d6_sample_allocation sample ON sample.id=a.id)
    ), d6_ready_source AS MATERIALIZED (
      SELECT s.* FROM public."ParticipantSettlementTimeBucketSource" s
      WHERE s."timeRevisionId"=parent_row.id AND NOT(c.label='MISSING_SOURCE' AND s.id IN (
        SELECT sample.id FROM d6_sample_source sample
        JOIN public."ParticipantSettlementTimeBucket" b ON b.id=sample."bucketId"
        WHERE b."categoryCode"='training'))
    ), d6_original AS MATERIALIZED (${rejectIds(project(original))}),
      d6_candidate AS MATERIALIZED (${project(candidate)}),
      d6_readiness AS MATERIALIZED (SELECT EXISTS(${readiness}) AS rejected),
      ${difference}
    SELECT (EXISTS(SELECT 1 FROM d6_original) OR d6_readiness.rejected) AS "originalRejected",
      (EXISTS(SELECT 1 FROM d6_candidate) OR d6_readiness.rejected) AS "candidateRejected",
      NOT EXISTS(SELECT 1 FROM d6_difference) AS "sameRejectSet",
      d6_readiness.rejected AS "readinessRejected",
      (SELECT count(*)::INTEGER FROM d6_source) AS "sourceRows",
      (SELECT count(*)::INTEGER FROM d6_slice) AS "sliceRows"
    FROM d6_readiness
  ) proof WHERE parent_row.id=$1 AND parent_row."kindCode"='draft' ORDER BY c.ordinal`;
  return {
    original: explainPredicate(original),
    candidate: explainPredicate(candidate),
    counterexamples,
  };
}
export async function observeD6ReceiptSliceComparison(
  client: D6PredicatePlanClient,
  reference: unknown,
  options: Options = {},
): Promise<D6SliceComparisonSnapshot> {
  let phase: Reason = 'ENVIRONMENT';
  let expected: string;
  let sql: ReturnType<typeof d6ReceiptSliceComparisonAuthority>;
  try {
    const env = options.env ?? process.env;
    if (
      env.GITHUB_ACTIONS !== 'true' ||
      env.GITHUB_WORKFLOW !== 'CI' ||
      env.GITHUB_JOB !== 'slow' ||
      env.GITHUB_EVENT_NAME !== 'pull_request'
    )
      return sliceSnapshot('DISABLED', 'ENVIRONMENT');
    phase = 'WORKER';
    requireValue(/^[1-9][0-9]?$/u.test(process.env.JEST_WORKER_ID ?? ''));
    expected = deriveTestDbName();
    phase = 'REFERENCE';
    requireValue(typeof reference === 'string' && /^[A-Za-z0-9_:-]{1,200}$/u.test(reference));
    phase = 'AUTHORITY';
    sql = d6ReceiptSliceComparisonAuthority(
      options.source ?? readFileSync(resolve(__dirname, '../..', migration), 'utf8'),
    );
  } catch {
    return sliceSnapshot('UNKNOWN', phase);
  }
  let transactions = 0;
  let statements = 0;
  let equivalent: boolean | null = null;
  let controls: SliceControl[] = [];
  const samples: SliceSample[] = [];
  const identities: SliceIdentity[] = [];
  const current: { phase: SliceIdentity['phase'] | null; variant: SliceVariant | null } = {
    phase: null,
    variant: null,
  };
  const stage: { current: Reason } = { current: 'TRANSACTION' };
  type Query = (text: string, ...values: unknown[]) => Promise<unknown>;
  const readMetadata = (rows: unknown) => {
    const result = metadata(rows);
    requireValue(own(own(own(array(rows, 1), '0'), 'observation'), 'repeatableRead') === true);
    return result;
  };
  const attempt = async <T>(
    name: SliceIdentity['phase'],
    run: (query: Query) => Promise<T>,
  ): Promise<T> => {
    current.phase = name;
    current.variant = null;
    stage.current = 'TRANSACTION';
    transactions++;
    let active = true;
    try {
      const result = await client.$transaction(
        async (tx) => {
          const query: Query = (text, ...values) => {
            requireValue(active);
            statements++;
            return tx.$queryRawUnsafe(text, ...values);
          };
          const execute = (text: string) => {
            requireValue(active);
            statements++;
            return tx.$executeRawUnsafe(text);
          };
          stage.current = 'READ_ONLY';
          await execute(D6_SLICE_COMPARISON_READ_ONLY);
          await execute(D6_PREDICATE_SQL.timeout);
          stage.current = 'METADATA';
          const before = readMetadata(
            await query(D6_PREDICATE_SQL.metadata, expected, reference, bodyHash),
          );
          const value = await run(query);
          stage.current = 'METADATA';
          const after = readMetadata(
            await query(D6_PREDICATE_SQL.metadata, expected, reference, bodyHash),
          );
          stage.current = 'IDENTITY';
          requireValue(
            before.backend === after.backend &&
              before.virtual === after.virtual &&
              before.oid === after.oid &&
              before.version === after.version &&
              before.mode === after.mode,
          );
          stage.current = 'TRANSACTION';
          return { value, mode: before.mode };
        },
        { maxWait: 1000, timeout: 5000 },
      );
      identities.push({
        phase: name,
        sameBackend: true,
        sameVirtualTransaction: true,
        repeatableRead: true,
        readOnly: true,
        functionPinned: true,
        parentSealed: true,
        planCacheMode: result.mode,
      });
      return result.value;
    } finally {
      // A driver timeout can settle before its callback: never issue late SQL.
      active = false;
    }
  };
  let reason: Reason = 'NONE';
  let failure: SliceFailure | null = null;
  try {
    controls = await attempt('CONTROLS', async (query) => {
      stage.current = 'COUNTEREXAMPLES';
      const rows = array(await query(sql.counterexamples, reference), D6_SLICE_CASES.length);
      requireValue(rows.length === D6_SLICE_CASES.length);
      return D6_SLICE_CASES.map((label, index): SliceControl => {
        const row = own(rows, String(index));
        const rejects = [
          'FORGED_DURATION',
          'EMPTY_CATEGORY',
          'NULL_VS_ZERO',
          'FORGED_QUANTUM',
          'MISSING_SOURCE',
        ].includes(label);
        const readinessRejected = label === 'MISSING_SOURCE';
        const sourceRows = readinessRejected ? 3 : 4;
        const sliceRows = label.startsWith('EMPTY_CATEGORY') ? 4 : 5;
        requireValue(
          own(row, 'label') === label &&
            own(row, 'originalRejected') === rejects &&
            own(row, 'candidateRejected') === rejects &&
            own(row, 'sameRejectSet') === true &&
            own(row, 'readinessRejected') === readinessRejected &&
            own(row, 'sourceRows') === sourceRows &&
            own(row, 'sliceRows') === sliceRows,
        );
        return {
          label,
          originalRejected: rejects,
          candidateRejected: rejects,
          sameRejectSet: true,
          readinessRejected,
          sourceRows,
          sliceRows,
        };
      });
    });
    for (const order of ['AB', 'BA'] as const) {
      const variants: SliceVariant[] =
        order === 'AB' ? ['ORIGINAL', 'ONCE_PER_ALLOCATION'] : ['ONCE_PER_ALLOCATION', 'ORIGINAL'];
      const pair = await attempt(order, async (query) => {
        const result: SliceSample[] = [];
        for (const variant of variants) {
          current.variant = variant;
          stage.current = 'PLAN_SQL';
          const raw = await query(variant === 'ORIGINAL' ? sql.original : sql.candidate, reference);
          stage.current = 'PLAN_SHAPE';
          const { plan, sliceScans } = inspectPredicatePlan(raw);
          stage.current = 'POST_PREPARE_DATA_CHANGED';
          requireValue(plan.rootRows === 1 && plan.rootLoops === 1);
          requireValue(
            sliceScans.length > 0 &&
              sliceScans.length <= 4 &&
              sliceScans.every(
                (scan) =>
                  scan.loops > 0 &&
                  ['Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'].includes(scan.kind),
              ),
          );
          result.push({
            order,
            variant,
            executionMs: plan.executionMs,
            planningMs: plan.planningMs,
            rootRows: plan.rootRows,
            rootLoops: plan.rootLoops,
            rootBuffers: plan.rootBuffers,
            maxWorkNode: plan.topWorkNodes[0] ?? null,
            sliceScans,
          });
        }
        return result;
      });
      samples.push(...pair);
      // Both NOT EXISTS verdicts are true in this pair's snapshot: their complete
      // reject sets are empty. Do not run the expensive pair again just to count zero.
      equivalent = true;
    }
  } catch (error) {
    reason = failureReason(error, stage.current);
    failure = {
      phase: current.phase,
      variant: ['PLAN_SQL', 'PLAN_SHAPE', 'POST_PREPARE_DATA_CHANGED'].includes(stage.current)
        ? current.variant
        : null,
      stage: stage.current,
    };
  }
  const result = sliceSnapshot(
    samples.length === 4 ? 'OBSERVED' : samples.length ? 'PARTIAL' : 'UNKNOWN',
    reason,
    controls,
    samples,
    identities,
    transactions,
    statements,
    equivalent,
    failure,
  );
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= 8192) return result;
  return sliceSnapshot('UNKNOWN', 'OUTPUT', [], [], [], transactions, statements);
}
