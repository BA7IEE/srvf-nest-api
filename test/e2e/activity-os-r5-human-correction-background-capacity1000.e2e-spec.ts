import assert from 'node:assert/strict';
import { runR5HumanCorrectionAsyncCapacity1000 } from '../helpers/r5-human-correction-async-driver';

// Both tiny bootstraps are excluded from their shared inventory to avoid a
// self-hash cycle. The external packet manifest binds each one's exact bytes.
const FROZEN_SOURCE_BINDING_SHA256 =
  'ebc7ef4c9ad4da52e504c717046662a1adb35aea632fd1b1f3dab6e5e0c90f30';

describe('one explicitly approved N10000/delta1000 Human async publication mode', () => {
  it('proves its frozen native COMMIT budget and reports remaining gates separately', async () => {
    const manifest = process.env.SRVF_R5_ASYNC_MANIFEST_FILE;
    assert(manifest, 'explicit frozen capacity manifest is required; no default DB run');
    await runR5HumanCorrectionAsyncCapacity1000(manifest, FROZEN_SOURCE_BINDING_SHA256);
  }, 600_000);
});
