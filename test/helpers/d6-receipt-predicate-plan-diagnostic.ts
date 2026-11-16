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
export function d6ReceiptPredicateAuthority(source: string): Record<D6PredicateLabel, string> {
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
    // A materialized verdict exposes stale/violating data as zero root rows without
    // printing the predicate result or folding the predicate into a different join.
    queries[label] = `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)
WITH verdict AS MATERIALIZED (
  SELECT NOT EXISTS (${predicate}) AS valid
  FROM public."ActivitySettlementTimeRevision" parent_row
  WHERE parent_row.id=$1 AND parent_row."kindCode"='draft'
) SELECT 1 FROM verdict WHERE valid`;
  }
  return queries;
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
export function summarizeD6PredicatePlan(rows: unknown): D6PredicatePlanSummary {
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
  return {
    executionMs: number(own(document, 'Execution Time')),
    planningMs: number(own(document, 'Planning Time')),
    rootRows: number(own(root, 'Actual Rows')),
    rootLoops: number(own(root, 'Actual Loops')),
    rootBuffers: buffers(root),
    parsedNodes: nodes.length,
    topWorkNodes: nodes.sort((a, b) => work(b) - work(a)).slice(0, 6),
  };
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
