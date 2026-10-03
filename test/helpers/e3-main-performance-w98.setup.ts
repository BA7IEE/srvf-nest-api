import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { deriveWorkerTestDbName, deriveTestDbName } from '../setup/worktree-db';
import { assertNamedTestDatabaseScope } from '../setup/test-run-scope';

// Opt-in local runner only: not wired into the shared Jest configuration.
if (process.env.SRVF_E3_MAIN_PERF_W98 !== '1') {
  throw new Error('E3 performance verification requires explicit w98 mode');
}
assertNamedTestDatabaseScope([deriveWorkerTestDbName(98)]);
process.env.JEST_WORKER_ID = '98';
loadTestEnv();
if (deriveTestDbName() !== deriveWorkerTestDbName(98))
  throw new Error('unexpected E3 test database');
assertTestDatabaseUrl(process.env.DATABASE_URL);
process.env.STORAGE_LOCAL_ROOT = './tmp/storage-w98';
