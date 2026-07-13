import { Prisma } from '@prisma/client';

import { BizCode } from '../exceptions/biz-code.constant';
import { claimAtStatus, type StatusClaimTarget } from './claim-at-status.util';

describe('claimAtStatus', () => {
  const targets: Array<{
    target: StatusClaimTarget;
    delegate: StatusClaimTarget;
    statusField: 'statusCode' | 'certStatusCode';
  }> = [
    { target: 'activity', delegate: 'activity', statusField: 'statusCode' },
    {
      target: 'activityRegistration',
      delegate: 'activityRegistration',
      statusField: 'statusCode',
    },
    { target: 'attendanceSheet', delegate: 'attendanceSheet', statusField: 'statusCode' },
    { target: 'certificate', delegate: 'certificate', statusField: 'certStatusCode' },
    {
      target: 'recruitmentApplication',
      delegate: 'recruitmentApplication',
      statusField: 'statusCode',
    },
    {
      target: 'teamJoinApplication',
      delegate: 'teamJoinApplication',
      statusField: 'statusCode',
    },
  ];

  function createTx(count: number) {
    const updateMany = jest.fn().mockResolvedValue({ count });
    const delegates = Object.fromEntries(
      targets.map(({ delegate }) => [delegate, { updateMany }]),
    ) as Record<StatusClaimTarget, { updateMany: typeof updateMany }>;
    return { tx: delegates as unknown as Prisma.TransactionClient, updateMany };
  }

  it.each(targets)('$target uses one no-op CAS with the model status field', async (entry) => {
    const { tx, updateMany } = createTx(1);

    await claimAtStatus(tx, {
      target: entry.target,
      id: 'row-1',
      expectedStatus: 'pending',
      invalidStatusBiz: BizCode.BAD_REQUEST,
    });

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', [entry.statusField]: 'pending', deletedAt: null },
      data: { [entry.statusField]: 'pending' },
    });
  });

  it('rejects a lost claim with the caller-provided existing BizCode', async () => {
    const { tx } = createTx(0);

    await expect(
      claimAtStatus(tx, {
        target: 'certificate',
        id: 'row-1',
        expectedStatus: 'pending',
        invalidStatusBiz: BizCode.CERTIFICATE_INVALID_STATE_TRANSITION,
      }),
    ).rejects.toMatchObject({ biz: BizCode.CERTIFICATE_INVALID_STATE_TRANSITION });
  });
});
