import type { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { mapCreationPlace } from './activity-creation-command';
import { writeSimpleDraftPlaces } from './activity-place-writer';

it('reauthorizes immediately after a preset lock wait and before any local place or compatibility write', async () => {
  const error = new BizException(BizCode.RBAC_FORBIDDEN);
  const events: string[] = [];
  const tx = {
    activityPlace: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'place-0001', sessionId: null, roleCode: 'primary' }]),
      update: jest.fn(),
      create: jest.fn(),
    },
    $queryRaw: jest.fn().mockImplementation(() => {
      events.push('lock');
      return Promise.resolve([{ id: 'preset-0001' }]);
    }),
    placePreset: { findUnique: jest.fn() },
    activity: { update: jest.fn() },
    activitySession: { update: jest.fn() },
  };
  await expect(
    writeSimpleDraftPlaces(tx as unknown as Prisma.TransactionClient, {
      activityId: 'activity-0001',
      sessions: [],
      places: [
        mapCreationPlace({ roleCode: 'primary', visibilityCode: 'staff', presetId: 'preset-0001' }),
      ],
      revalidate: () => {
        events.push('reauthorize');
        return Promise.reject(error);
      },
    }),
  ).rejects.toBe(error);
  expect(events).toEqual(['lock', 'reauthorize']);
  expect(tx.placePreset.findUnique).not.toHaveBeenCalled();
  expect(tx.activityPlace.update).not.toHaveBeenCalled();
  expect(tx.activityPlace.create).not.toHaveBeenCalled();
  expect(tx.activity.update).not.toHaveBeenCalled();
  expect(tx.activitySession.update).not.toHaveBeenCalled();
});
