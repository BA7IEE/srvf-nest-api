import { strict as assert } from 'node:assert';
import { PrismaClient } from '@prisma/client';
import appConfig from '../../src/config/app.config';
import {
  closeE13Fixture,
  createE4Fixture,
  installE4ValidationDatabase,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import {
  runNativeLaunch500Boundary,
  runNativeLaunchSmallAdmission,
  type NativeAdmissionResult,
} from '../helpers/native-launch-admission.cases';
import type { NativeLaunchStage } from '../helpers/native-launch-live.fixture';

let f: E4Fixture | undefined;
let observer: PrismaClient | undefined;
let pending = 0;
let unknown = false;
let started = 0;
const previousDatabaseUrl = process.env.DATABASE_URL;
if (previousDatabaseUrl) {
  const url = new URL(previousDatabaseUrl);
  url.searchParams.set('connection_limit', '1');
  process.env.DATABASE_URL = url.toString();
}
installE4ValidationDatabase({
  settlementMode: 'active',
  boundMigrationProcesses: true,
  assertReadyToFinalize: () => {
    if (unknown || pending || f || observer)
      throw new Error('Native launch case resources UNKNOWN; DROP refused');
  },
});
// Restore the caller URL after the installer's outer finalizer and lease release.
afterAll(() => {
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});
const stage: NativeLaunchStage = async (label, work) => {
  const available = 510_000 - (performance.now() - started);
  if (available < 30_000 || (label.startsWith('PUBLICATION_') && available < 90_000))
    throw new Error('Native launch 600-second window cleanup reserve reached');
  pending++;
  try {
    return await work();
  } finally {
    pending--;
    console.info(
      'NATIVE_LAUNCH_STAGE',
      JSON.stringify({ label, elapsedMs: performance.now() - started }),
    );
  }
};
const emit = (result: NativeAdmissionResult) =>
  console.info('NATIVE_LAUNCH_CASE', JSON.stringify(result));
stage.observe = (event) => console.info('NATIVE_LAUNCH_OBSERVATION', JSON.stringify(event));

describe('active native limited launch: applicable business boundaries, original guards and budgets', () => {
  beforeEach(async () => {
    assert(!unknown && pending === 0 && !f && !observer);
    started = performance.now();
    pending++;
    try {
      f = await createE4Fixture();
      assert.equal(
        f.app.get<ReturnType<typeof appConfig>>(appConfig.KEY).contributionSettlementMode,
        'active',
      );
      observer = new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL } },
        transactionOptions: { timeout: 30_000, maxWait: 2_000 },
      });
      await observer.$connect();
      await observer.$executeRawUnsafe("SET statement_timeout='30s'");
    } catch (error) {
      unknown = true;
      throw error;
    } finally {
      pending--;
    }
  }, 120_000);
  afterEach(async () => {
    if (pending) {
      unknown = true;
      throw new Error('Native launch body pending; cleanup refused');
    }
    try {
      await observer?.$disconnect();
      observer = undefined;
      await closeE13Fixture(f);
      f = undefined;
      assert(performance.now() - started < 600_000);
    } catch (error) {
      unknown = true;
      throw error;
    }
  }, 90_000);
  it('accepts 500/500/2500/2000 and rejects501/501/2501 with all196 rollback, frozen oracle and actual ledger COMMIT', async () => {
    assert(f && observer);
    pending++;
    try {
      await runNativeLaunch500Boundary(f, observer, stage, emit);
    } finally {
      pending--;
    }
  }, 600_000);

  it('rejects one-person policy/bytes and approved long-source correction, and completes real unchanged/V3 gate paths', async () => {
    assert(f && observer);
    pending++;
    try {
      await runNativeLaunchSmallAdmission(f, observer, stage, emit);
    } finally {
      pending--;
    }
  }, 600_000);
});
