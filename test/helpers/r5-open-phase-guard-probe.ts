import type { Prisma } from '@prisma/client';
import * as writePhase from '../../src/modules/activities/correction-write-phase';

/** For a fresh V3 prepared target, run guard assertions after the real,
 * authorized phase begins and abort that transaction even when they pass.
 * A result without entering this phase is a failure, not rollback evidence. */
export async function probeOpenCorrectionCommit(
  applicationId: string,
  commit: () => Promise<unknown>,
  probe: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  const original = writePhase.beginCorrectionWritePhase;
  const finished = new Error('R5_GUARD_PROBE_ROLLBACK_ONLY');
  let entered = false;
  const observation = jest
    .spyOn(writePhase, 'beginCorrectionWritePhase')
    .mockImplementation(async (tx, id, phase) => {
      await original(tx, id, phase);
      if (id === applicationId && phase === 'commit') {
        if (entered) throw new Error('R5_GUARD_PROBE_REENTERED');
        entered = true;
        await probe(tx);
        throw finished;
      }
    });
  try {
    try {
      await commit();
    } catch (error) {
      if (entered && error === finished) return;
      throw error;
    }
    throw new Error('R5_GUARD_PROBE_UNEXPECTED_COMMIT_RESULT');
  } finally {
    observation.mockRestore();
  }
}
