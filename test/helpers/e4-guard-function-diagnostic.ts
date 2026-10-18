import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Prisma, PrismaClient } from '@prisma/client';
import { guardPlanDiagnosticEnabled } from './e4-guard-plan-diagnostic';

const BODY_MD5 = '21fe9ecf6df989a3f8fa5878df40b93c';
export const GUARD_FUNCTION_ROLES = [
  'BUCKET_HASH',
  'CANONICAL',
  'COMPLETE',
  'DAY_POINTS',
  'DOCUMENT',
  'ENVELOPE_HASH',
  'EVALUATION_GUARD',
  'EXPECTED',
  'FROZEN_SELECTION',
  'HASH',
  'REVISION_GUARD',
  'SOURCE_ROWS',
  'VERSION_CONTENT_HASH',
  'VERSION_V1_HASH',
] as const;
type Counter = {
  role: (typeof GUARD_FUNCTION_ROLES)[number];
  calls: number;
  totalMs: number;
  selfMs: number;
};
const SNAPSHOT_SQL = `WITH required(role,name) AS (VALUES
  ('BUCKET_HASH','astr_bucket_content_hash'),('CANONICAL','astr_canonical_json'),
  ('COMPLETE','e4_assert_complete'),('DAY_POINTS','e4_day_points'),
  ('DOCUMENT','e4_evaluation_document'),('ENVELOPE_HASH','e4_envelope_hash'),
  ('EVALUATION_GUARD','e4_evaluation_set_guard'),('EXPECTED','e4_expected_evaluations'),
  ('FROZEN_SELECTION','e4_assert_frozen_selection'),('HASH','e4_hash'),
  ('REVISION_GUARD','e4_revision_complete_guard'),('SOURCE_ROWS','e4_source_rows'),
  ('VERSION_CONTENT_HASH','e4_version_content_hash'),('VERSION_V1_HASH','e4_version_v1_hash'))
SELECT pg_backend_pid() AS backend, current_setting('track_functions')='none' AS disabled,
  has_parameter_privilege(current_user,'track_functions','SET') AS allowed,
  (SELECT count(*)=1 AND bool_and(md5(p.prosrc)='21fe9ecf6df989a3f8fa5878df40b93c')
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='e4_assert_complete') AS "catalogMatches",
  (SELECT jsonb_agg(jsonb_build_object('role',r.role,'calls',coalesce(s.calls,0)::text,
    'totalMs',coalesce(s.total_time,0),'selfMs',coalesce(s.self_time,0)) ORDER BY r.role)
   FROM required r JOIN pg_proc p ON p.proname=r.name
   JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
   LEFT JOIN pg_stat_user_functions s ON s.funcid=p.oid) AS counters`;

export function guardFunctionDiagnosticEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (env.SRVF_E4_GUARD_FUNCTION_DIAGNOSTIC !== '1') return false;
  if (env.SRVF_E4_GUARD_PLAN_DIAGNOSTIC === '1' || env.SRVF_E4_W98 !== '1')
    throw new Error('GUARD_FUNCTION_MODE');
  return guardPlanDiagnosticEnabled({ ...env, SRVF_E4_GUARD_PLAN_DIAGNOSTIC: '1' });
}

export function guardFunctionCounters(value: unknown): Counter[] {
  if (!Array.isArray(value) || value.length !== GUARD_FUNCTION_ROLES.length)
    throw new Error('GUARD_COUNTERS');
  return GUARD_FUNCTION_ROLES.map((role) => {
    const rows = value.filter(
      (row: unknown) =>
        row && typeof row === 'object' && (row as Record<string, unknown>).role === role,
    );
    if (rows.length !== 1) throw new Error('GUARD_COUNTER_ROLE');
    const row = rows[0] as Record<string, unknown>;
    if (typeof row.calls !== 'string' || !/^[0-9]+$/u.test(row.calls))
      throw new Error('GUARD_COUNTER_CALLS');
    const calls = Number(row.calls);
    if (!Number.isSafeInteger(calls) || calls < 0 || calls > 5000000)
      throw new Error('GUARD_COUNTER_CALLS');
    for (const name of ['totalMs', 'selfMs'])
      if (
        typeof row[name] !== 'number' ||
        !Number.isFinite(row[name]) ||
        row[name] < 0 ||
        row[name] > 600000
      )
        throw new Error('GUARD_COUNTER_TIME');
    if ((row.selfMs as number) > (row.totalMs as number)) throw new Error('GUARD_COUNTER_TIME');
    return { role, calls, totalMs: row.totalMs as number, selfMs: row.selfMs as number };
  });
}
export function guardFunctionDelta(before: Counter[], after: Counter[]): Counter[] {
  if (before.length !== GUARD_FUNCTION_ROLES.length || after.length !== before.length)
    throw new Error('GUARD_DELTA_SHAPE');
  return before.map((row, index) => {
    const next = after[index];
    if (row.role !== GUARD_FUNCTION_ROLES[index] || next.role !== row.role)
      throw new Error('GUARD_DELTA_ROLE');
    const delta = {
      role: row.role,
      calls: next.calls - row.calls,
      totalMs: next.totalMs - row.totalMs,
      selfMs: next.selfMs - row.selfMs,
    };
    if (delta.calls < 0 || delta.totalMs < 0 || delta.selfMs < 0)
      throw new Error('GUARD_COUNTER_RESET');
    return delta;
  });
}

export class E4GuardFunctionDiagnostic {
  private readonly descriptor: PropertyDescriptor | undefined;
  private readonly original: (...args: unknown[]) => unknown;
  private readonly wrapper: (...args: unknown[]) => unknown;
  private readonly binding: { head: string; run: string; attempt: number };
  private status: 'NOT_RUN' | 'OBSERVED' | 'UNKNOWN' = 'NOT_RUN';
  private reason: 'NONE' | 'CAPTURE' | 'COLLECT' | 'OWNERSHIP' | 'OUTPUT' = 'NONE';
  private before: Counter[] = [];
  private counters: Counter[] = [];
  private backend = 0;
  private attempted = false;
  private restored = false;
  private sameBackend: boolean | null = null;
  private settingRestored: boolean | null = null;
  private counts = { evaluationUnits: 0, sourceReferences: 0 };
  constructor(
    private readonly target: object,
    private readonly output: string,
  ) {
    if (!guardFunctionDiagnosticEnabled()) throw new Error('GUARD_FUNCTION_DISABLED');
    if (
      resolve(output) !== resolve(process.cwd(), 'tmp/e4-guard-functions-evidence/functions.json')
    )
      throw new Error('GUARD_FUNCTION_DESTINATION');
    this.binding = { head: process.env.GITHUB_SHA!, run: process.env.GITHUB_RUN_ID!, attempt: 1 };
    this.descriptor = Object.getOwnPropertyDescriptor(target, 'insertEvaluations');
    const original: unknown = Reflect.get(target, 'insertEvaluations');
    if (typeof original !== 'function') throw new Error('GUARD_FUNCTION_METHOD');
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
    if (receiver !== this.target || this.attempted) throw new Error('GUARD_FUNCTION_ONCE');
    this.attempted = true;
    try {
      const [tx, root, evaluations] = args as [
        Prisma.TransactionClient,
        { kindCode: string; sourceKindCode: string },
        readonly { sourceRefsJson: readonly unknown[] }[],
      ];
      if (
        root?.kindCode !== 'draft' ||
        root.sourceKindCode !== 'time_revision' ||
        !Array.isArray(evaluations) ||
        evaluations.length !== 8000
      )
        throw new Error('GUARD_FUNCTION_CASE');
      this.counts = {
        evaluationUnits: evaluations.length,
        sourceReferences: evaluations.reduce((sum, row) => sum + row.sourceRefsJson.length, 0),
      };
      if (this.counts.sourceReferences !== 50000) throw new Error('GUARD_FUNCTION_REFERENCES');
      const migration = readFileSync(
        resolve(
          __dirname,
          '../../prisma/migrations/20261003000000_activity_contribution_settlement/migration.sql',
        ),
        'utf8',
      );
      const bodies = [
        ...migration.matchAll(/CREATE FUNCTION e4_assert_complete\([^]*? AS \$\$([^]*?)\$\$;/gu),
      ];
      if (bodies.length !== 1 || createHash('md5').update(bodies[0][1]).digest('hex') !== BODY_MD5)
        throw new Error('GUARD_FUNCTION_SOURCE');
      const rows = await tx.$queryRawUnsafe<
        {
          backend: number;
          disabled: boolean;
          allowed: boolean;
          catalogMatches: boolean;
          counters: unknown;
        }[]
      >(SNAPSHOT_SQL);
      if (
        rows.length !== 1 ||
        !Number.isInteger(rows[0].backend) ||
        rows[0].backend <= 0 ||
        rows[0].disabled !== true ||
        rows[0].allowed !== true ||
        rows[0].catalogMatches !== true
      )
        throw new Error('GUARD_FUNCTION_PRECONDITION');
      this.backend = rows[0].backend;
      this.before = guardFunctionCounters(rows[0].counters);
      const enabled = await tx.$queryRawUnsafe<{ enabled: boolean }[]>(
        "SELECT set_config('track_functions','all',true)='all' AS enabled",
      );
      if (enabled.length !== 1 || enabled[0].enabled !== true)
        throw new Error('GUARD_FUNCTION_SETTING');
    } catch {
      this.status = 'UNKNOWN';
      this.reason = 'CAPTURE';
      throw new Error('E4_GUARD_FUNCTION_UNKNOWN');
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
  async collect(observer: Pick<PrismaClient, '$transaction'>) {
    if (!this.attempted || this.status === 'UNKNOWN') return;
    try {
      const rows = await observer.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5000ms'");
          return tx.$queryRawUnsafe<
            { backend: number; disabled: boolean; catalogMatches: boolean; counters: unknown }[]
          >(SNAPSHOT_SQL);
        },
        { maxWait: 5000, timeout: 5000 },
      );
      if (rows.length !== 1 || rows[0].catalogMatches !== true)
        throw new Error('GUARD_FUNCTION_POSTCONDITION');
      this.sameBackend = rows[0].backend === this.backend;
      this.settingRestored = this.sameBackend && rows[0].disabled === true;
      this.counters = guardFunctionDelta(this.before, guardFunctionCounters(rows[0].counters));
      if (
        !this.settingRestored ||
        this.counters.find((row) => row.role === 'EVALUATION_GUARD')?.calls !== 1 ||
        this.counters.find((row) => row.role === 'COMPLETE')?.calls === 0
      )
        throw new Error('GUARD_FUNCTION_COMPLETION');
      this.status = 'OBSERVED';
    } catch {
      this.status = 'UNKNOWN';
      this.reason = 'COLLECT';
    }
  }
  emit() {
    try {
      const record = {
        schema: 'e4-guard-functions/v1',
        binding: this.binding,
        status: this.status,
        reason: this.reason,
        acceptance: 'NOT_AN_ACCEPTANCE_RESULT',
        kind: 'CUMULATIVE_FUNCTION_DELTA_FROM_E4_WRITE_TO_TX_END',
        bodyMd5: BODY_MD5,
        dataset: this.counts,
        sameBackend: this.sameBackend,
        settingRestored: this.settingRestored,
        timing: 'MILLISECONDS_NESTED_TOTALS_DO_NOT_SUM',
        inlinedFunctions: 'NOT_TRACKED',
        counters: this.counters,
      };
      const encoded = JSON.stringify(record);
      if (Buffer.byteLength(encoded) > 8192) throw new Error('GUARD_FUNCTION_OUTPUT');
      writeFileSync(this.output, encoded + '\n', { mode: 0o600, flag: 'wx' });
      return true;
    } catch {
      this.status = 'UNKNOWN';
      this.reason = 'OUTPUT';
      return false;
    }
  }
}
