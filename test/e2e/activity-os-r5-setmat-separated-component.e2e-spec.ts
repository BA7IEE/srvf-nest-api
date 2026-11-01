import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withR5CapacityFixture } from '../helpers/r5-setmat-capacity.fixture';
import {
  capacityConfig,
  claimCapacityAttempt,
  type CapacityConfig,
} from '../helpers/r5-setmat-capacity.protocol';
import { measureR5SeparatedComponent } from '../helpers/r5-setmat-separated-component';
import { writeR5DurableReceipt } from '../helpers/r5-setmat-durable-receipt';

it('separates authorized correctness diagnostics from original15s candidate timing on the retained application', async () => {
  const file = process.env.SRVF_R5_CAPACITY_CONFIG_FILE;
  assert(file);
  const config = capacityConfig(JSON.parse(readFileSync(file, 'utf8')) as CapacityConfig);
  assert(config.separatedComponent && !config.continuation);
  assert.notEqual(process.env.SRVF_R5_MAIN_PREPARE_PROFILE_ONLY, 'true');
  claimCapacityAttempt(config);
  const result = await withR5CapacityFixture(config, (f) => measureR5SeparatedComponent(f, config));
  writeR5DurableReceipt(join(config.outputDirectory, 'RESULT.json'), result);
}, 600000);
