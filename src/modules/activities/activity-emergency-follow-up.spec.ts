import type { Prisma } from '@prisma/client';
import {
  createEmergencyFollowUps,
  emergencyFollowUpStatuses,
  reconcileEmergencyFollowUps,
} from './activity-emergency-follow-up';

describe('B6 emergency follow-up facts', () => {
  it('never mistakes equipment notes or unmodelled incident/outcome for fulfilment', () => {
    expect(
      emergencyFollowUpStatuses({ session: true, position: true, detailedLocation: true }),
    ).toEqual({
      session: 'verified',
      position: 'verified',
      detailed_location: 'verified',
      equipment: 'unrepresentable',
      attendance: 'pending',
      outcome: 'unrepresentable',
      incident_relation: 'unrepresentable',
    });
  });

  it('creates exactly seven obligations with consistent resolver metadata', async () => {
    type CreatedItem = {
      statusCode: string;
      resolvedAt: Date | null;
      resolvedByUserId: string | null;
    };
    const tx = {
      activityEmergencyFollowUpItem: {
        createMany: jest.fn<Promise<unknown>, [{ data: CreatedItem[] }]>(),
      },
    };
    const at = new Date('2099-09-01T08:00:00.000Z');
    await createEmergencyFollowUps(
      tx as unknown as Prisma.TransactionClient,
      'origin-1',
      'actor-1',
      at,
    );
    const rows = tx.activityEmergencyFollowUpItem.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.resolvedAt).toEqual(row.statusCode === 'pending' ? null : at);
      expect(row.resolvedByUserId).toEqual(row.statusCode === 'pending' ? null : 'actor-1');
    }
  });

  it('does no follow-up writes or child reads for an ordinary activity', async () => {
    const tx = {
      activityEmergencyInitiation: { findUnique: jest.fn().mockResolvedValue(null) },
      activitySession: { findMany: jest.fn() },
      activityEmergencyFollowUpItem: { updateMany: jest.fn() },
    };
    await reconcileEmergencyFollowUps(
      tx as unknown as Prisma.TransactionClient,
      'activity-1',
      'actor-1',
    );
    expect(tx.activitySession.findMany).not.toHaveBeenCalled();
    expect(tx.activityEmergencyFollowUpItem.updateMany).not.toHaveBeenCalled();
  });

  it('reverts a vanished session/position/location fact to pending without resolver metadata', async () => {
    const tx = {
      activityEmergencyInitiation: { findUnique: jest.fn().mockResolvedValue({ id: 'origin-1' }) },
      activitySession: { findMany: jest.fn().mockResolvedValue([]) },
      activitySessionPosition: { findMany: jest.fn().mockResolvedValue([]) },
      activityPlace: { count: jest.fn().mockResolvedValue(0) },
      activityEmergencyFollowUpItem: { updateMany: jest.fn() },
    };
    await reconcileEmergencyFollowUps(
      tx as unknown as Prisma.TransactionClient,
      'activity-1',
      'actor-1',
    );
    expect(tx.activityEmergencyFollowUpItem.updateMany).toHaveBeenCalledTimes(3);
    for (const itemCode of ['session', 'position', 'detailed_location']) {
      expect(tx.activityEmergencyFollowUpItem.updateMany).toHaveBeenCalledWith({
        where: { emergencyInitiationId: 'origin-1', itemCode, statusCode: { not: 'pending' } },
        data: { statusCode: 'pending', resolvedAt: null, resolvedByUserId: null },
      });
    }
    expect(tx.activitySessionPosition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          activityId: 'activity-1',
          deletedAt: null,
          session: { statusCode: 'scheduled', deletedAt: null },
        },
      }),
    );
  });
});
