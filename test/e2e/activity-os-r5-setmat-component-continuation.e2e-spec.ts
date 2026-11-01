import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withR5CapacityFixture } from '../helpers/r5-setmat-capacity.fixture';
import { measureR5CapacityComponent } from '../helpers/r5-setmat-capacity.measurement';
import {
  capacityConfig,
  claimCapacityAttempt,
  type CapacityConfig,
} from '../helpers/r5-setmat-capacity.protocol';
import { R5_COMPONENT_ORIGIN } from '../helpers/r5-setmat-component-continuation';
import { writeR5DurableReceipt } from '../helpers/r5-setmat-durable-receipt';

it('measures the exact retained unstarted component once, without preparing or committing it', async () => {
  const file = process.env.SRVF_R5_CAPACITY_CONFIG_FILE;
  assert(file);
  const config = capacityConfig(JSON.parse(readFileSync(file, 'utf8')) as CapacityConfig);
  assert(config.continuation);
  assert.equal(config.mode, 'component1000');
  assert.notEqual(process.env.SRVF_R5_MAIN_PREPARE_PROFILE_ONLY, 'true');
  claimCapacityAttempt(config);
  const component = await withR5CapacityFixture(config, (f) =>
    measureR5CapacityComponent(f, config),
  );
  // This is a new component-only observation, never a rewrite of the closed
  // end-to-end FAIL and never a full10000 admission/result.
  writeR5DurableReceipt(join(config.outputDirectory, 'RESULT.json'), {
    schema: 'srvf-r5-capacity-component-continuation-result/v1',
    outcome: 'PASS',
    origin: R5_COMPONENT_ORIGIN,
    component,
    originalWholePhaseVerdict: 'FAIL_OR_UNKNOWN_STOP_NOT_CAPACITY_PASS',
    prepareReplayed: false,
    actualHumanCommit: false,
    full10000Admission: false,
    includedRealCommit: false,
    includedDeferredTerminalChecks: false,
  });
}, 600000);
