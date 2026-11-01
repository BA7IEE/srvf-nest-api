import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withR5CapacityFixture } from '../helpers/r5-setmat-capacity.fixture';
import {
  measureR5CapacityComponent,
  measureR5CapacityFull,
} from '../helpers/r5-setmat-capacity.measurement';
import {
  assertCapacityAdmission,
  capacityConfig,
  claimCapacityAttempt,
  type CapacityConfig,
  type CapacityComponentResult,
} from '../helpers/r5-setmat-capacity.protocol';

// Only the explicit standalone config loads this entry. No standard global
// setup, reset, migration, DB creation, permission write or consumed fixture.
it('runs exactly one newly dispatched R5 capacity phase', async () => {
  const file = process.env.SRVF_R5_CAPACITY_CONFIG_FILE;
  assert(file);
  const decoded: CapacityConfig = JSON.parse(readFileSync(file, 'utf8'));
  const config = capacityConfig(decoded);
  if (process.env.SRVF_R5_MAIN_PREPARE_PROFILE_ONLY === 'true') {
    assert.equal(config.mode, 'component1000');
    claimCapacityAttempt(config);
    const result = await withR5CapacityFixture<unknown>(
      config,
      () =>
        Promise.reject(
          new Error('MAIN_PREPARE-only diagnostic must never enter correction capacity'),
        ),
      {
        finish: (receipt, profile) => ({
          schema: 'srvf-r5-main-prepare-diagnostic-only/v1',
          diagnosticComplete: profile.complete,
          nativeMainSucceeded: true,
          sourceCount: 10000,
          receipt,
          identity: profile.identity,
          independentServer: profile.independentServer,
          mainSubmitExecuted: false,
          ledgerExecuted: false,
          correctionCapacityExecuted: false,
        }),
      },
    );
    writeFileSync(
      join(config.outputDirectory, 'MAIN_PREPARE_PROFILE_RESULT.json'),
      JSON.stringify(result, null, 2) + '\n',
      { flag: 'wx' },
    );
    return;
  }
  if (config.mode === 'full10000') {
    assert(config.componentResultPath && config.admissionPath);
    const bytes = readFileSync(config.componentResultPath);
    const component: CapacityComponentResult = JSON.parse(bytes.toString());
    const admission: Parameters<typeof assertCapacityAdmission>[1] = JSON.parse(
      readFileSync(config.admissionPath, 'utf8'),
    );
    assertCapacityAdmission(component, admission, bytes, config.safetyControl.actualCommitMaxMs);
  }
  type Result = CapacityComponentResult | Awaited<ReturnType<typeof measureR5CapacityFull>>;
  claimCapacityAttempt(config);
  const result = await withR5CapacityFixture<Result>(config, (fixture) =>
    config.mode === 'component1000'
      ? measureR5CapacityComponent(fixture, config)
      : measureR5CapacityFull(fixture, config),
  );
  writeFileSync(
    join(config.outputDirectory, 'RESULT.json'),
    JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx' },
  );
}, 600000);
