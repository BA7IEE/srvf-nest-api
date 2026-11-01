import assert from 'node:assert/strict';
import { R5_FUNCTION_STATS_CONTROL_SQL } from './r5-main-function-stats';

/** Reuse the candidate's exact catalog predicate without enabling tracking,
 * calibrating functions, changing roles or assigning an XID. The caller owns
 * the original experiment lease and an explicitly READ ONLY transaction.
 * This proves the schema at check time; it does not hold a DDL lock.
 */
export async function readR5E4RowDomainReadiness(tx: object) {
  const query: unknown = Reflect.get(tx, '$queryRawUnsafe');
  assert(typeof query === 'function', 'original read-only catalog seam required');
  const rows: unknown = await Reflect.apply(query, tx, [R5_FUNCTION_STATS_CONTROL_SQL]);
  assert(Array.isArray(rows) && rows.length === 1);
  const row: unknown = rows[0];
  assert(row && typeof row === 'object');
  const proof: unknown = Reflect.get(row, 'observation');
  assert(proof && typeof proof === 'object');
  assert.equal(Reflect.get(proof, 'database'), 'app_test_r5_setmat_20261029_q1');
  assert.equal(Reflect.get(proof, 'databaseOid'), 1998913);
  assert.equal(Reflect.get(proof, 'cluster'), '7695840193603043362');
  assert.equal(Reflect.get(proof, 'role'), 'postgres');
  assert.equal(Reflect.get(proof, 'sessionUser'), 'postgres');
  assert.equal(Reflect.get(proof, 'readOnly'), 'on');
  assert.equal(Reflect.get(proof, 'xid'), null, 'readiness must not force a write transaction');
  assert.equal(Reflect.get(proof, 'rowDomainProof'), 1, 'E4 typed-row equivalence domain failed');
  const pid: unknown = Reflect.get(proof, 'pid');
  assert(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0);
  return { kind: 'E4_ROW_DOMAIN_READONLY_PREFLIGHT', ready: true, proof };
}
