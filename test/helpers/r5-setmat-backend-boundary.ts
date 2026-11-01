import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';

export type R5BackendPolicy = 'STRICT_ALL' | 'CLONE_AUTOVACUUM_ONLY';
export interface R5BackendRow {
  pid: number;
  databaseOid: number;
  backendType: string | null;
  backendStart: string | null;
  leaderPid: number | null;
  state: string | null;
  transactionStart: string | null;
  queryStart: string | null;
  stateChange: string | null;
  waitType: string | null;
  waitEvent: string | null;
}
export interface R5OwnedBackend {
  pid: number;
  databaseOid: number;
  backendStart: string;
}
export interface R5BoundaryReport {
  observedAt: string;
  observerPid: number;
  backends: R5BackendRow[];
  prepared: number;
  leaseHeld: boolean;
}
export function classifyR5Backends(
  report: R5BoundaryReport,
  owned: readonly R5OwnedBackend[],
  policy: R5BackendPolicy = 'STRICT_ALL',
) {
  assert(['STRICT_ALL', 'CLONE_AUTOVACUUM_ONLY'].includes(policy));
  assert.equal(new Set(owned.map((x) => x.pid)).size, owned.length);
  assert(owned.some((x) => x.pid === report.observerPid));
  const seen = new Set<number>(),
    block: R5BackendRow[] = [],
    maintenance: R5BackendRow[] = [];
  for (const row of report.backends) {
    assert(Number.isInteger(row.pid) && row.pid > 0 && !seen.has(row.pid));
    seen.add(row.pid);
    assert([1713092, 1971161, 1998913].includes(row.databaseOid));
    const owner = owned.find((x) => x.pid === row.pid);
    if (owner) {
      assert.equal(owner.databaseOid, 1998913);
      assert.equal(row.databaseOid, owner.databaseOid);
      assert.equal(row.backendType, 'client backend');
      assert(typeof row.backendStart === 'string' && row.backendStart === owner.backendStart);
    } else if (
      policy === 'CLONE_AUTOVACUUM_ONLY' &&
      row.databaseOid === 1998913 &&
      row.backendType === 'autovacuum worker'
    )
      maintenance.push(row);
    else block.push(row);
  }
  for (const owner of owned)
    assert(seen.has(owner.pid), 'owned backend missing: no PID-only exemption');
  assert(Number.isInteger(report.prepared) && report.prepared >= 0);
  return {
    block,
    maintenance,
    pass: block.length === 0 && report.prepared === 0 && report.leaseHeld === true,
  };
}
export async function readR5OwnedBackend(client: PrismaClient): Promise<R5OwnedBackend> {
  const rows = await client.$queryRaw<(R5OwnedBackend & { backendType: string })[]>`
    SELECT pid,datid::int AS "databaseOid",backend_start::text AS "backendStart",backend_type AS "backendType"
    FROM pg_stat_activity WHERE pid=pg_backend_pid()`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].databaseOid, 1998913);
  assert.equal(rows[0].backendType, 'client backend');
  assert(typeof rows[0].backendStart === 'string');
  return { pid: rows[0].pid, databaseOid: rows[0].databaseOid, backendStart: rows[0].backendStart };
}
/** One materialized activity sample; no SQL text/user names/tokens are emitted.
 * Default policy preserves the old all-backend exclusion. The only alternative
 * is a separately approved test policy, never inferred from activity statistics.
 */
export async function assertR5BackendBoundary(
  observer: PrismaClient,
  app: R5OwnedBackend | undefined,
  leasePid: number | undefined,
  policy: R5BackendPolicy,
  persist: (value: unknown) => string,
  label: string,
) {
  const self = await readR5OwnedBackend(observer);
  const rows = await observer.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout='2s'`;
      return await tx.$queryRaw<R5BoundaryReport[]>`
      WITH a AS MATERIALIZED (
        SELECT pid,datid::int AS "databaseOid",backend_type AS "backendType",backend_start::text AS "backendStart",
          leader_pid AS "leaderPid",state,xact_start::text AS "transactionStart",query_start::text AS "queryStart",
          state_change::text AS "stateChange",wait_event_type AS "waitType",wait_event AS "waitEvent"
        FROM pg_stat_activity WHERE datid IN(1713092,1971161,1998913)
      ) SELECT clock_timestamp()::text AS "observedAt",pg_backend_pid() AS "observerPid",
        coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY pid) FROM a),'[]'::jsonb) AS backends,
        (SELECT count(*)::int FROM pg_prepared_xacts WHERE database IN('app_test_r5_setmat_20261029_q1','app_test_r5_native_capacity_20261027_b8a9cd_w1','app_test_r5_native_capacity_20261027_b8a9cd_w95')) AS prepared,
        CASE WHEN ${leasePid ?? null}::int IS NULL THEN true ELSE EXISTS(SELECT 1 FROM pg_locks WHERE pid=${leasePid ?? null} AND locktype='advisory' AND granted
          AND database=(SELECT oid FROM pg_database WHERE datname='postgres') AND objsubid=1
          AND classid::bigint=((hashtextextended('SRVF:test:D3:app_test_w98',0)>>32)&4294967295)
          AND objid::bigint=(hashtextextended('SRVF:test:D3:app_test_w98',0)&4294967295)) END AS "leaseHeld"`;
    },
    { timeout: 3000, maxWait: 1000 },
  );
  // Persist BEFORE any assertion, including malformed identities or blockers.
  persist({
    kind: 'R5_BACKEND_BOUNDARY_SAMPLE',
    label,
    policy,
    leaseRequired: leasePid !== undefined,
    owned: app ? [self, app] : [self],
    rows,
  });
  assert.equal(rows.length, 1);
  const result = classifyR5Backends(rows[0], app ? [self, app] : [self], policy);
  persist({ kind: 'R5_BACKEND_BOUNDARY_CLASSIFICATION', label, policy, ...result });
  assert(
    result.pass,
    'foreign backend/prepared transaction/or exact lease violation; detailed sample retained',
  );
  return result;
}
