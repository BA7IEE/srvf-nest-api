import { readR5E4RowDomainReadiness } from './r5-e4-row-domain-readiness';
import { R5_FUNCTION_STATS_CONTROL_SQL } from './r5-main-function-stats';

// Protocol tests only. The native SQL domain check still requires PostgreSQL.
const proof = () => ({
  database: 'app_test_r5_setmat_20261029_q1',
  databaseOid: 1998913,
  cluster: '7695840193603043362',
  role: 'postgres',
  sessionUser: 'postgres',
  readOnly: 'on',
  xid: null,
  pid: 55,
  rowDomainProof: 1,
});

it('uses exactly the existing read-only predicate without tracking setup or business SQL', async () => {
  const value = proof();
  const query = jest.fn(async () => [{ observation: value }]);
  await expect(readR5E4RowDomainReadiness({ $queryRawUnsafe: query })).resolves.toEqual({
    kind: 'E4_ROW_DOMAIN_READONLY_PREFLIGHT',
    ready: true,
    proof: value,
  });
  expect(query.mock.calls).toEqual([[R5_FUNCTION_STATS_CONTROL_SQL]]);
});

it.each([
  ['database', 'postgres'],
  ['databaseOid', 1971161],
  ['cluster', '7695840193603043363'],
  ['role', 'r5_boundary_caller_h7c6'],
  ['sessionUser', 'other'],
  ['readOnly', 'off'],
  ['xid', '158146'],
  ['pid', 0],
  ['rowDomainProof', 0],
  ['rowDomainProof', undefined],
  ['rowDomainProof', '1'],
])('rejects an incompatible or absent %s before fixture creation', async (key, value) => {
  const query = jest.fn(async () => [{ observation: { ...proof(), [key]: value } }]);
  await expect(readR5E4RowDomainReadiness({ $queryRawUnsafe: query })).rejects.toThrow();
  expect(query).toHaveBeenCalledTimes(1);
});

it('preserves a native predicate rejection and never retries', async () => {
  const failure = new Error('native row-domain predicate rejected');
  const query = jest.fn(() => Promise.reject(failure));
  await expect(readR5E4RowDomainReadiness({ $queryRawUnsafe: query })).rejects.toBe(failure);
  expect(query).toHaveBeenCalledTimes(1);
});
