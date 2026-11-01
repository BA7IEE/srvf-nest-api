import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import manifest from './r5-setmat-table-manifest.json';

export const R5_SETMAT_TABLES: readonly string[] = Object.freeze([...manifest.tables]);
export const R5_SETMAT_SCHEMA_SHA256 = manifest.sourceSchemaSha256;

/** Explicitly approved auxiliary-only candidate; default callers retain 30 seconds. */
export const R5_AUXILIARY_SNAPSHOT120_POLICY = Object.freeze({
  schema: 'srvf-r5-auxiliary-snapshot120/v1',
  approvalReference: 'Sentinel_45b8c058c60881918a1a96da3c933920',
  transactionMs: 120000,
  statementMs: 30000,
  readOnly: true,
  isolationLevel: 'RepeatableRead',
  automaticRetry: false,
});

export function assertR5TableManifest(actual: readonly string[]) {
  assert.deepEqual([...actual].sort(), R5_SETMAT_TABLES);
  assert.equal(new Set(actual).size, actual.length, 'duplicate table names are invalid');
}

/** Complete frozen table set and all columns/rows; emit hashes, never row data. */
export async function snapshotR5SetmatTables(
  observer: PrismaClient,
  onReport?: (report: R5TableSnapshotReport) => void,
  auxiliaryPolicy?: typeof R5_AUXILIARY_SNAPSHOT120_POLICY,
) {
  if (auxiliaryPolicy !== undefined)
    assert.deepEqual(auxiliaryPolicy, R5_AUXILIARY_SNAPSHOT120_POLICY);
  const transactionMs = auxiliaryPolicy === undefined ? 30000 : 120000;
  const started = performance.now();
  const measurements: R5TableSnapshotReport['tables'] = [];
  let callbackStarted = 0;
  let failed = false,
    failure: unknown;
  let result:
    | {
        schemaSha256: string;
        tables: string[];
        rows: { name: string; count: string; hash: string }[];
        hash: string;
      }
    | undefined;
  try {
    result = await observer.$transaction(
      async (tx) => {
        callbackStarted = performance.now();
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$executeRaw`SET LOCAL statement_timeout='30s'`;
        const actual = await tx.$queryRaw<{ name: string }[]>`
      SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname COLLATE "C"
    `;
        assertR5TableManifest(actual.map((row) => row.name));
        const rows = [];
        for (const name of R5_SETMAT_TABLES) {
          const quoted = '"' + name.replaceAll('"', '""') + '"';
          // PG16 jsonb array text uses comma-space separators. Keep the same bytes,
          // NULL sort order and duplicates without constructing the full jsonb array.
          const timing: R5TableSnapshotReport['tables'][number] = {
            name,
            ordinal: measurements.length,
            startedAfterCallbackMs: performance.now() - callbackStarted,
            promiseElapsedMs: 0,
            status: 'PENDING',
          };
          measurements.push(timing);
          const queryStarted = performance.now();
          let values: { count: string; hash: string }[];
          try {
            values = await tx.$queryRawUnsafe<{ count: string; hash: string }[]>(
              `SELECT count(*)::text AS count, encode(sha256(convert_to('[' || coalesce(string_agg(coalesce(c.row_text,'null'), ', ' ORDER BY c.row_text COLLATE "C"), '') || ']', 'UTF8')), 'hex') AS hash FROM (SELECT to_jsonb(t)::text AS row_text FROM public.${quoted} t OFFSET 0) c`,
            );
            timing.status = 'FULFILLED';
          } catch (error) {
            timing.status = 'REJECTED';
            throw error;
          } finally {
            timing.promiseElapsedMs = performance.now() - queryStarted;
          }
          assert.equal(values.length, 1);
          timing.count = values[0].count;
          rows.push({ name, ...values[0] });
        }
        return {
          schemaSha256: R5_SETMAT_SCHEMA_SHA256,
          tables: [...R5_SETMAT_TABLES],
          rows,
          hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: transactionMs, maxWait: 2_000 },
    );
  } catch (error) {
    failed = true;
    failure = error;
  }
  let reportFailed = false,
    reportFailure: unknown;
  try {
    onReport?.({
      kind: 'R5_COMPLETE_TABLE_SNAPSHOT_TIMING',
      status: failed ? 'REJECTED' : 'FULFILLED',
      transactionPromiseElapsedMs: performance.now() - started,
      configuredTransactionMs: transactionMs,
      configuredStatementMs: 30000,
      auxiliaryApprovalReference: auxiliaryPolicy?.approvalReference ?? null,
      isolationLevel: 'RepeatableRead',
      readOnly: true,
      tables: measurements,
      expectedTables: R5_SETMAT_TABLES.length,
      timingBoundary: 'CLIENT_TABLE_QUERY_PROMISE_NOT_SERVER_EXECUTION',
      databaseOutcome: 'NOT_INFERRED_FROM_CLIENT_RESULT',
    });
  } catch (error) {
    reportFailed = true;
    reportFailure = error;
  }
  if (failed) throw failure; // A reporting failure must never replace the original rejection.
  if (reportFailed) throw reportFailure;
  assert(result);
  return result;
}

export interface R5TableSnapshotReport {
  kind: 'R5_COMPLETE_TABLE_SNAPSHOT_TIMING';
  status: 'FULFILLED' | 'REJECTED';
  transactionPromiseElapsedMs: number;
  configuredTransactionMs: 30000 | 120000;
  configuredStatementMs: 30000;
  auxiliaryApprovalReference: string | null;
  isolationLevel: 'RepeatableRead';
  readOnly: true;
  tables: {
    name: string;
    ordinal: number;
    startedAfterCallbackMs: number;
    promiseElapsedMs: number;
    status: 'PENDING' | 'FULFILLED' | 'REJECTED';
    count?: string;
  }[];
  expectedTables: number;
  timingBoundary: 'CLIENT_TABLE_QUERY_PROMISE_NOT_SERVER_EXECUTION';
  databaseOutcome: 'NOT_INFERRED_FROM_CLIENT_RESULT';
}
