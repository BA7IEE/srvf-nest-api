import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { deriveTemplateTestDbName, deriveTestDbName } from '../setup/worktree-db';

// Opt-in local runner only: not wired into the shared Jest configuration.
if (process.env.SRVF_E3_MAIN_PERF_W98 !== '1' || deriveTemplateTestDbName() !== 'app_test') {
  throw new Error('E3 performance verification requires explicit primary-worktree w98 mode');
}
process.env.JEST_WORKER_ID = '98';
loadTestEnv();
if (deriveTestDbName() !== 'app_test_w98') throw new Error('unexpected E3 test database');
assertTestDatabaseUrl(process.env.DATABASE_URL);
process.env.STORAGE_LOCAL_ROOT = './tmp/storage-w98';
