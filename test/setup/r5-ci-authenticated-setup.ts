import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { closeR5CiRuntime } from '../helpers/r5-ci-authenticated-runtime';
import { registerR5CiStdin, R5_CI_AUTHENTICATED_FILES } from './r5-ci-instance-scope';

// One complete file per process and fresh driver-owned database. Never invoke
// normal template/worker clone setup or load .env.test into process.env here.
const selected = process.argv.filter((argument) => argument.endsWith('.e2e-spec.ts'));
if (
  process.argv.some((argument) =>
    argument.endsWith('jest-r5-ci-authenticated-historical.config.ts'),
  ) &&
  process.env.SRVF_R5_CI_HISTORICAL_CAPACITY_APPROVED !== '1'
)
  throw new Error('R5_CI_HISTORICAL_CAPACITY_REQUIRES_SEPARATE_APPROVAL');
if (
  selected.length !== 1 ||
  !R5_CI_AUTHENTICATED_FILES.includes(basename(selected[0])) ||
  !process.argv.includes('--runInBand') ||
  process.env.DATABASE_URL !== undefined ||
  process.env.HUMAN_CORRECTION_DATABASE_URL !== undefined ||
  [
    'SRVF_E4_W98',
    'SRVF_E4_N1_LIFECYCLE',
    'SRVF_E4_GITHUB_ISOLATED',
    'SRVF_D7_2_W98',
    'SRVF_D7_NATIVE_CHAIN_DIAGNOSTIC',
    'SRVF_D7_GUARD_INTERNAL_DIAGNOSTIC',
  ].some((name) => process.env[name] !== undefined) ||
  existsSync(resolve('.env'))
)
  throw new Error('R5_CI_ISOLATED_PROCESS_REQUIRED');
registerR5CiStdin();
process.env.APP_ENV = 'test';
process.env.LOGIN_THROTTLE_LIMIT = '1000';
const storage = mkdtempSync(join(tmpdir(), 'srvf-r5-ci-storage-'));
process.env.STORAGE_LOCAL_ROOT = storage;
afterAll(async () => {
  await closeR5CiRuntime();
  rmSync(storage, { recursive: true });
});
