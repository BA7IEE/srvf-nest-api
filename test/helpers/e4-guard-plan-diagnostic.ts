import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Prisma } from '@prisma/client';

const BODY_MD5 = '21fe9ecf6df989a3f8fa5878df40b93c';
const TYPES = new Set([
  'Result',
  'Nested Loop',
  'Seq Scan',
  'Index Scan',
  'Index Only Scan',
  'Bitmap Heap Scan',
  'Bitmap Index Scan',
  'Hash Join',
  'Merge Join',
  'Hash',
  'Sort',
  'Aggregate',
  'Materialize',
  'CTE Scan',
  'Subquery Scan',
  'Limit',
]);
const RELATIONS = new Map([
  ['ParticipantSettlementTimeBucketSource', 'SOURCES'],
  ['ParticipantTimeAllocationRevision', 'ALLOCATIONS'],
  ['ParticipantSettlementTimeBucket', 'BUCKETS'],
  ['ParticipantSettlementResultRevision', 'RESULTS'],
]);
type Root = {
  timeRevisionId: string;
  ruleSnapshotId: string;
  ruleSnapshotHash: string;
  activityId: string;
  settlementVersionId: string;
  kindCode: string;
  sourceKindCode: string;
};

export function sourceGuardPlanSql(migration: string) {
  const bodies = [
    ...migration.matchAll(/CREATE FUNCTION e4_assert_complete\([^]*? AS \$\$([^]*?)\$\$;/gu),
  ];
  if (bodies.length !== 1 || createHash('md5').update(bodies[0][1]).digest('hex') !== BODY_MD5)
    throw new Error('GUARD_SOURCE_PIN');
  const matches = [
    ...bodies[0][1].matchAll(
      / {4}IF (EXISTS \(\n {6}SELECT 1 FROM "ParticipantSettlementTimeBucketSource"[^]*?) THEN RAISE EXCEPTION 'contribution source population mismatch'/gu,
    ),
  ];
  if (matches.length !== 1) throw new Error('GUARD_EXPRESSION');
  let expression = matches[0][1];
  const bindings = [
    ['time_row.id', '$1'],
    ['root."ruleSnapshotId"', '$2'],
    ['root."ruleSnapshotHash"', '$3'],
    ['root."activityId"', '$4'],
    ['root."settlementVersionId"', '$5'],
  ] as const;
  for (const [name, placeholder] of bindings) expression = expression.split(name).join(placeholder);
  if (/\b(?:root|time_row)\./u.test(expression) || expression.includes(';'))
    throw new Error('GUARD_BINDING');
  return {
    sql: 'EXPLAIN (FORMAT JSON) SELECT (' + expression + ') AS mismatch',
    bodyMd5: BODY_MD5,
  };
}

export function projectGuardPlan(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    typeof value[0] !== 'object' ||
    value[0] === null
  )
    throw new Error('GUARD_PLAN_ROOT');
  const documents = (value[0] as Record<string, unknown>)['QUERY PLAN'];
  if (
    !Array.isArray(documents) ||
    documents.length !== 1 ||
    typeof documents[0] !== 'object' ||
    documents[0] === null
  )
    throw new Error('GUARD_PLAN_DOCUMENT');
  const plan = (documents[0] as Record<string, unknown>).Plan;
  const nodes: {
    parent: number | null;
    type: string;
    relation: string;
    rows: number;
    width: number;
    startupCost: number;
    totalCost: number;
  }[] = [];
  function visit(input: unknown, parent: number | null) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || nodes.length >= 128)
      throw new Error('GUARD_PLAN_NODE');
    const node = input as Record<string, unknown>;
    const numeric = (name: string) => {
      const v = node[name];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
        throw new Error('GUARD_PLAN_NUMBER');
      return v;
    };
    const index = nodes.length;
    nodes.push({
      parent,
      type:
        typeof node['Node Type'] === 'string' && TYPES.has(node['Node Type'])
          ? node['Node Type']
          : 'OTHER',
      relation:
        typeof node['Relation Name'] === 'string'
          ? (RELATIONS.get(node['Relation Name']) ?? 'OTHER')
          : 'OTHER',
      rows: numeric('Plan Rows'),
      width: numeric('Plan Width'),
      startupCost: numeric('Startup Cost'),
      totalCost: numeric('Total Cost'),
    });
    if (node.Plans !== undefined) {
      if (!Array.isArray(node.Plans)) throw new Error('GUARD_PLAN_CHILDREN');
      for (const child of node.Plans) visit(child, index);
    }
  }
  visit(plan, null);
  if (Buffer.byteLength(JSON.stringify(nodes)) > 16384) throw new Error('GUARD_PLAN_BYTES');
  return nodes;
}

export function projectGuardPhysicalCounts(value: unknown) {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object')
    throw new Error('GUARD_PHYSICAL_ROOT');
  const row = value[0] as Record<string, unknown>;
  const expected = { sources: 40000, allocations: 10000, buckets: 8000, results: 2000 } as const;
  for (const [name, count] of Object.entries(expected)) {
    if (row[name] !== count) throw new Error('GUARD_PHYSICAL_POPULATION');
  }
  return {
    sources: row.sources as number,
    allocations: row.allocations as number,
    buckets: row.buckets as number,
    results: row.results as number,
  };
}

export function guardPlanDiagnosticEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.SRVF_E4_GUARD_PLAN_DIAGNOSTIC !== '1') return false;
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== 'BA7IEE/srvf-nest-api' ||
    env.GITHUB_REF !== 'refs/heads/codex/activity-os-r5-e4-github-validation' ||
    env.SRVF_E4_GITHUB_ISOLATED !== '1' ||
    env.GITHUB_RUN_ATTEMPT !== '1' ||
    !/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? '') ||
    !/^[0-9]+$/u.test(env.GITHUB_RUN_ID ?? '')
  )
    throw new Error('GUARD_PLAN_CLOUD_ONLY');
  return true;
}

/** Opt-in cloud diagnostic: one non-executing plan read in the original transaction. */
export class E4GuardPlanDiagnostic {
  private readonly descriptor: PropertyDescriptor | undefined;
  private readonly original: (...args: unknown[]) => unknown;
  private readonly wrapper: (...args: unknown[]) => unknown;
  private readonly binding: { head: string; run: string; attempt: number };
  private status: 'NOT_RUN' | 'OBSERVED' | 'UNKNOWN' = 'NOT_RUN';
  private reason: 'NONE' | 'CAPTURE' | 'OWNERSHIP' | 'OUTPUT' = 'NONE';
  private plan: ReturnType<typeof projectGuardPlan> = [];
  private counts = { evaluationUnits: 0, sourceReferences: 0 };
  private physical: ReturnType<typeof projectGuardPhysicalCounts> | null = null;
  private attempted = false;
  private restored = false;
  constructor(
    private readonly target: object,
    private readonly output: string,
  ) {
    if (!guardPlanDiagnosticEnabled()) throw new Error('GUARD_PLAN_DISABLED');
    if (resolve(output) !== resolve(process.cwd(), 'tmp/e4-guard-plan-evidence/guard-plan.json'))
      throw new Error('GUARD_PLAN_DESTINATION');
    this.binding = { head: process.env.GITHUB_SHA!, run: process.env.GITHUB_RUN_ID!, attempt: 1 };
    this.descriptor = Object.getOwnPropertyDescriptor(target, 'insertEvaluations');
    const original: unknown = Reflect.get(target, 'insertEvaluations');
    if (typeof original !== 'function') throw new Error('GUARD_PLAN_METHOD');
    this.original = original as (...args: unknown[]) => unknown;
    const invoke = (receiver: unknown, args: unknown[]) => this.invoke(receiver, args);
    this.wrapper = function (this: unknown, ...args: unknown[]) {
      return invoke(this, args);
    };
    Object.defineProperty(target, 'insertEvaluations', {
      configurable: true,
      writable: true,
      value: this.wrapper,
    });
  }
  private async invoke(receiver: unknown, args: unknown[]) {
    if (receiver !== this.target) throw new Error('GUARD_PLAN_RECEIVER');
    if (!this.attempted) {
      this.attempted = true;
      try {
        const [tx, root, evaluations] = args as [
          Prisma.TransactionClient,
          Root,
          readonly { sourceRefsJson: readonly unknown[] }[],
        ];
        if (
          !root ||
          root.kindCode !== 'draft' ||
          root.sourceKindCode !== 'time_revision' ||
          !Array.isArray(evaluations) ||
          evaluations.length !== 8000
        )
          throw new Error('GUARD_PLAN_ORIGINAL_CASE');
        const names = [
          'timeRevisionId',
          'ruleSnapshotId',
          'ruleSnapshotHash',
          'activityId',
          'settlementVersionId',
        ] as const;
        if (names.some((name) => typeof root[name] !== 'string' || !root[name]))
          throw new Error('GUARD_PLAN_ROOT_VALUES');
        this.counts = {
          evaluationUnits: evaluations.length,
          sourceReferences: evaluations.reduce((sum, e) => sum + e.sourceRefsJson.length, 0),
        };
        if (this.counts.sourceReferences !== 50000)
          throw new Error('GUARD_PLAN_ORIGINAL_REFERENCES');
        const migration = readFileSync(
          resolve(
            __dirname,
            '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
          ),
          'utf8',
        );
        const { sql } = sourceGuardPlanSql(migration);
        this.physical = projectGuardPhysicalCounts(
          await tx.$queryRawUnsafe(
            `SELECT
            (SELECT count(*)::int FROM "ParticipantSettlementTimeBucketSource" WHERE "timeRevisionId"=$1) AS sources,
            (SELECT count(*)::int FROM "ParticipantTimeAllocationRevision" WHERE "ruleSnapshotId"=$2 AND "ruleSnapshotHash"=$3 AND "activityId"=$4) AS allocations,
            (SELECT count(*)::int FROM "ParticipantSettlementTimeBucket" WHERE "timeRevisionId"=$1) AS buckets,
            (SELECT count(*)::int FROM "ParticipantSettlementResultRevision" WHERE "settlementVersionId"=$5) AS results`,
            ...names.map((name) => root[name]),
          ),
        );
        const result: unknown = await tx.$queryRawUnsafe(sql, ...names.map((name) => root[name]));
        this.plan = projectGuardPlan(result);
        this.status = 'OBSERVED';
      } catch {
        this.status = 'UNKNOWN';
        this.reason = 'CAPTURE';
        throw new Error('E4_GUARD_PLAN_UNKNOWN');
      }
    }
    return Reflect.apply(this.original, receiver, args);
  }
  restore() {
    if (this.restored) return;
    if (Reflect.get(this.target, 'insertEvaluations') !== this.wrapper) {
      this.status = 'UNKNOWN';
      this.reason = 'OWNERSHIP';
    } else if (this.descriptor)
      Object.defineProperty(this.target, 'insertEvaluations', this.descriptor);
    else Reflect.deleteProperty(this.target, 'insertEvaluations');
    this.restored = true;
  }
  emit() {
    try {
      const record = {
        schema: 'e4-guard-plan/v1',
        binding: this.binding,
        status: this.status,
        reason: this.reason,
        kind: 'ESTIMATED_ONLY',
        acceptance: 'NOT_AN_ACCEPTANCE_RESULT',
        bodyMd5: BODY_MD5,
        dataset: this.counts,
        physical: this.physical,
        mismatch: 'NOT_MEASURED',
        actualLoops: 'NOT_MEASURED',
        nodes: this.plan,
      };
      const encoded = JSON.stringify(record);
      if (Buffer.byteLength(encoded) > 32768) throw new Error('GUARD_PLAN_OUTPUT_BYTES');
      writeFileSync(this.output, encoded + '\n', { mode: 0o600, flag: 'wx' });
      return true;
    } catch {
      this.status = 'UNKNOWN';
      this.reason = 'OUTPUT';
      return false;
    }
  }
}
