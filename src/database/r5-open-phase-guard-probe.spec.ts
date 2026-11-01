import type { Prisma } from '@prisma/client';
import * as writePhase from '../modules/activities/correction-write-phase';
import { probeOpenCorrectionCommit } from '../../test/helpers/r5-open-phase-guard-probe';

describe('rollback-only guard probe preserves real phase setup and original errors', () => {
  function transport(order: string[], error?: Error) {
    return {
      $queryRaw: jest.fn(() => {
        order.push('real-phase-query');
        if (error) return Promise.reject(error);
        return Promise.resolve([
          {
            applicationId: 'app',
            phase: 'commit',
            state: 'OPEN',
            protocolVersion: 1,
            batchId: 'b',
          },
        ]);
      }),
    } as unknown as Prisma.TransactionClient;
  }
  it('executes the real SQL setup first and probes the identical transaction before rollback', async () => {
    const order: string[] = [];
    const tx = transport(order);
    const original = writePhase.beginCorrectionWritePhase;
    let businessReached = false;
    await probeOpenCorrectionCommit(
      'app',
      async () => {
        await writePhase.beginCorrectionWritePhase(tx, 'app', 'commit');
        businessReached = true;
      },
      (received) => {
        expect(received).toBe(tx);
        order.push('probe');
        return Promise.resolve();
      },
    );
    expect(order).toEqual(['real-phase-query', 'probe']);
    expect(businessReached).toBe(false);
    expect(writePhase.beginCorrectionWritePhase).toBe(original);
  });
  it.each(['phase', 'assertion'] as const)('preserves the original %s rejection', async (where) => {
    const failure = new Error(where);
    const tx = transport([], where === 'phase' ? failure : undefined);
    const original = writePhase.beginCorrectionWritePhase;
    await expect(
      probeOpenCorrectionCommit(
        'app',
        () => writePhase.beginCorrectionWritePhase(tx, 'app', 'commit'),
        () => Promise.reject(failure),
      ),
    ).rejects.toBe(failure);
    expect(writePhase.beginCorrectionWritePhase).toBe(original);
  });
  it('refuses a commit result that never entered the target phase', async () => {
    const probe = jest.fn();
    await expect(
      probeOpenCorrectionCommit('app', () => Promise.resolve('committed'), probe),
    ).rejects.toThrow('R5_GUARD_PROBE_UNEXPECTED_COMMIT_RESULT');
    expect(probe).not.toHaveBeenCalled();
  });
});
