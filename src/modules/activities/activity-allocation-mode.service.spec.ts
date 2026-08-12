import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityAllocationModeService } from './activity-allocation-mode.service';

describe('ActivityAllocationModeService', () => {
  const service = new ActivityAllocationModeService();

  it('checks every historical batch status after the caller has locked Activity', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'preparing', modeCode: 'first_come', statusCode: 'preparing' },
      { id: 'committed', modeCode: 'first_come', statusCode: 'committed' },
      { id: 'voided', modeCode: 'first_come', statusCode: 'voided' },
    ]);
    await expect(
      service.assertLockedActivityConsistent({ activityAllocationBatch: { findMany } } as never, {
        id: 'activity-1',
        allocationModeCode: 'first_come',
      }),
    ).resolves.toBeUndefined();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { activityId: 'activity-1' } }),
    );
  });

  it('fails closed when even a voided batch differs', async () => {
    const error = await service
      .assertLockedActivityConsistent(
        {
          activityAllocationBatch: {
            findMany: jest
              .fn()
              .mockResolvedValue([{ id: 'voided', modeCode: 'lottery', statusCode: 'voided' }]),
          },
        } as never,
        { id: 'activity-1', allocationModeCode: 'first_come' },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BizException);
    expect((error as BizException).biz.code).toBe(
      BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT.code,
    );
  });
});
