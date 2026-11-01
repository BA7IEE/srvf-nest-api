import assert from 'node:assert/strict';
import { runR5HumanCorrectionAsyncSmoke } from '../helpers/r5-human-correction-async-driver';

// Both explicit tiny bootstraps are excluded from their shared inventory to
// avoid a self-hash cycle. The external reviewed manifest binds each one's bytes.
const FROZEN_SOURCE_BINDING_SHA256 =
  'ebc7ef4c9ad4da52e504c717046662a1adb35aea632fd1b1f3dab6e5e0c90f30';

describe('one explicitly approved fresh Human async publication', () => {
  it('accepts over HTTP, uses the real worker graph and proves one real native COMMIT', async () => {
    const manifest = process.env.SRVF_R5_ASYNC_MANIFEST_FILE;
    assert(manifest, 'explicit frozen async manifest is required; no default DB run');
    await runR5HumanCorrectionAsyncSmoke(manifest, FROZEN_SOURCE_BINDING_SHA256);
  }, 600_000);
});
