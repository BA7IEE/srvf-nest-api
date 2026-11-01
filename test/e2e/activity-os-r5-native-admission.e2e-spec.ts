import { strict as assert } from 'node:assert';
import { PrismaClient } from '@prisma/client';
import appConfig from '../../src/config/app.config';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import {
  closeE13Fixture,
  createE4Fixture,
  installE4ValidationDatabase,
  type E4Fixture,
} from '../helpers/activity-contribution-policy.fixture';
import {
  runNativeLaunchCapacityBoundary,
  assertNativeCapacityPostConditions,
  runNativeLaunchSmallAdmission,
  type NativeAdmissionResult,
} from '../helpers/native-launch-admission.cases';
import { createNativeCapacityCorrectionCases } from '../helpers/native-capacity-corrections.cases';
import type { NativeLaunchStage } from '../helpers/native-launch-live.fixture';
import { r5CiOwnerClient } from '../helpers/r5-ci-authenticated-runtime';

let f: E4Fixture | undefined;
let observer: PrismaClient | undefined;
let pending = 0;
let unknown = false;
let started = 0;
let capacityPhase = 0;
let capacity: Awaited<ReturnType<typeof runNativeLaunchCapacityBoundary>> | undefined;
let correctionCases: Awaited<ReturnType<typeof createNativeCapacityCorrectionCases>> | undefined;
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
  console.info(
    'NATIVE_LAUNCH_STAGE_BEGIN',
    JSON.stringify({ label, elapsedMs: performance.now() - started }),
  );
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
stage.snapshot = (label, fingerprint) =>
  console.info('NATIVE_LAUNCH_FINGERPRINT', JSON.stringify({ label, ...fingerprint }));

describe('active native full capacity: applicable business boundaries, original guards and budgets', () => {
  beforeEach(async () => {
    assert(!unknown && pending === 0);
    started = performance.now();
    // One private fixture is retained across these explicitly ordered acceptances.
    // Each original600s envelope and every business/SQL timeout remain unchanged.
    if (capacityPhase > 0 && capacityPhase < 3) {
      assert(f && observer);
      return;
    }
    assert(!f && !observer);
    pending++;
    try {
      // This fixture publishes an owner and writes the real v1.1 seal/settlement chain.
      // Match the native runner's two gates, then restore the caller exactly.
      const previousResponsibility = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
      const previousV11 = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
      process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
      try {
        f = await createE4Fixture();
      } finally {
        if (previousResponsibility === undefined)
          delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
        else process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousResponsibility;
        if (previousV11 === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
        else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousV11;
      }
      const workflowGate = f.app.get(ActivityWorkflowGate);
      assert.equal(workflowGate.isV11Enabled(), true);
      assert.equal(workflowGate.isReadonlyMaintenance(), false);
      assert.equal(
        f.app.get<ReturnType<typeof appConfig>>(appConfig.KEY).activityResponsibilityWorkflow
          .enabled,
        true,
      );
      assert.equal(
        f.app.get<ReturnType<typeof appConfig>>(appConfig.KEY).contributionSettlementMode,
        'active',
      );
      observer = r5CiOwnerClient({
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
      assert(performance.now() - started < 600_000);
      if (!unknown && capacityPhase > 0 && capacityPhase < 3) return;
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
  it('native2000 main accepts2000/10000/50000/8000, rejects2001/10001/50001 with all196 rollback and actual ledger COMMIT', async () => {
    assert(f && observer);
    pending++;
    try {
      capacity = await runNativeLaunchCapacityBoundary(f, observer, stage, emit);
      capacityPhase = 1;
    } catch (error) {
      unknown = true;
      throw error;
    } finally {
      pending--;
    }
  }, 600_000);

  it('native2000 complete formal readback and unchanged_time copy/replay', async () => {
    assert(f && observer && capacity && capacityPhase === 1);
    pending++;
    try {
      await assertNativeCapacityPostConditions(f, observer, stage, emit, capacity);
      correctionCases = await createNativeCapacityCorrectionCases(
        f,
        observer,
        stage,
        emit,
        capacity.source,
        capacity.submitted,
        capacity.posted,
      );
      await correctionCases.unchanged();
      capacityPhase = 2;
    } catch (error) {
      unknown = true;
      throw error;
    } finally {
      pending--;
    }
  }, 600_000);

  it('native2000 correction_time_proof full HumanV3 and exact replay with original15s commit', async () => {
    assert(correctionCases && capacityPhase === 2);
    pending++;
    try {
      await correctionCases.timeChanged();
      capacityPhase = 3;
    } catch (error) {
      unknown = true;
      throw error;
    } finally {
      pending--;
    }
  }, 600_000);

  it('rejects one-person policy/bytes and approved long-source correction, and completes real unchanged/V3 gate paths', async () => {
    assert(f && observer);
    pending++;
    try {
      await runNativeLaunchSmallAdmission(f, observer, stage, emit);
    } catch (error) {
      unknown = true;
      throw error;
    } finally {
      pending--;
    }
  }, 600_000);
  afterAll(async () => {
    if (pending) {
      unknown = true;
      throw new Error('Native acceptance still pending; close refused');
    }
    await observer?.$disconnect();
    observer = undefined;
    await closeE13Fixture(f);
    f = undefined;
  }, 90_000);
});
