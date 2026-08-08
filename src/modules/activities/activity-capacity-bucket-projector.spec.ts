import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityCapacityBucketProjector } from './activity-capacity-bucket-projector';

interface LockedBucketInput {
  id: string;
  activityId?: string;
  scopeTypeCode: string;
  scopeId: string;
  capacity: number | null;
  occupied: number;
  version: number;
}

function createTx(input: {
  activityCapacity: number | null;
  sessions?: Array<{ id: string; capacity: number | null }>;
  positions?: Array<{ id: string; capacity: number | null }>;
  buckets?: LockedBucketInput[];
  activeReservationCounts?: Array<{ bucketId: string; count: number }>;
  updateCount?: number;
}) {
  const activityCapacityBucket = {
    create: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue({ count: input.updateCount ?? 1 }),
  };
  return {
    tx: {
      activity: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ capacity: input.activityCapacity }),
      },
      activitySession: { findMany: jest.fn().mockResolvedValue(input.sessions ?? []) },
      activitySessionPosition: { findMany: jest.fn().mockResolvedValue(input.positions ?? []) },
      activityCapacityBucket,
      capacityReservation: {
        groupBy: jest.fn().mockResolvedValue(
          (input.activeReservationCounts ?? []).map(({ bucketId, count }) => ({
            bucketId,
            _count: { _all: count },
          })),
        ),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValue(
          (input.buckets ?? []).map((bucket) => ({ activityId: 'activity-1', ...bucket })),
        ),
    },
    activityCapacityBucket,
  };
}

describe('ActivityCapacityBucketProjector', () => {
  it('creates exactly the activity, scheduled-session, and live-position targets at zero occupancy', async () => {
    const { tx, activityCapacityBucket } = createTx({
      activityCapacity: 6,
      sessions: [
        { id: 'session-b', capacity: null },
        { id: 'session-a', capacity: 4 },
      ],
      positions: [
        { id: 'position-b', capacity: null },
        { id: 'position-a', capacity: 2 },
      ],
    });

    await new ActivityCapacityBucketProjector().apply(tx as never, 'activity-1');

    expect(activityCapacityBucket.create).toHaveBeenCalledTimes(5);
    const createdBucketData = activityCapacityBucket.create.mock.calls.map(
      ([call]) => (call as { data: unknown }).data,
    );
    expect(createdBucketData).toEqual([
      {
        activityId: 'activity-1',
        scopeTypeCode: 'activity_person',
        scopeId: 'activity-1',
        capacity: 6,
        occupied: 0,
        version: 0,
      },
      {
        activityId: 'activity-1',
        scopeTypeCode: 'position_participation',
        scopeId: 'position-a',
        capacity: 2,
        occupied: 0,
        version: 0,
      },
      {
        activityId: 'activity-1',
        scopeTypeCode: 'position_participation',
        scopeId: 'position-b',
        capacity: null,
        occupied: 0,
        version: 0,
      },
      {
        activityId: 'activity-1',
        scopeTypeCode: 'session_participation',
        scopeId: 'session-a',
        capacity: 4,
        occupied: 0,
        version: 0,
      },
      {
        activityId: 'activity-1',
        scopeTypeCode: 'session_participation',
        scopeId: 'session-b',
        capacity: null,
        occupied: 0,
        version: 0,
      },
    ]);
    expect(activityCapacityBucket.updateMany).not.toHaveBeenCalled();
  });

  it('leaves an unchanged, reconciled target untouched', async () => {
    const { tx, activityCapacityBucket } = createTx({
      activityCapacity: 3,
      buckets: [
        {
          id: 'bucket-activity',
          scopeTypeCode: 'activity_person',
          scopeId: 'activity-1',
          capacity: 3,
          occupied: 2,
          version: 7,
        },
      ],
      activeReservationCounts: [{ bucketId: 'bucket-activity', count: 2 }],
    });

    await new ActivityCapacityBucketProjector().apply(tx as never, 'activity-1');

    expect(activityCapacityBucket.create).not.toHaveBeenCalled();
    expect(activityCapacityBucket.updateMany).not.toHaveBeenCalled();
  });

  it('changes capacity through a one-row CAS and increments version exactly once', async () => {
    const { tx, activityCapacityBucket } = createTx({
      activityCapacity: 4,
      buckets: [
        {
          id: 'bucket-activity',
          scopeTypeCode: 'activity_person',
          scopeId: 'activity-1',
          capacity: 5,
          occupied: 2,
          version: 7,
        },
      ],
      activeReservationCounts: [{ bucketId: 'bucket-activity', count: 2 }],
    });

    await new ActivityCapacityBucketProjector().apply(tx as never, 'activity-1');

    expect(activityCapacityBucket.updateMany).toHaveBeenCalledWith({
      where: { id: 'bucket-activity', version: 7, occupied: { lte: 4 } },
      data: { capacity: 4, version: { increment: 1 } },
    });
  });

  it('rejects a capacity reduction below occupied after a valid reservation-count control', async () => {
    const { tx, activityCapacityBucket } = createTx({
      activityCapacity: 1,
      buckets: [
        {
          id: 'bucket-activity',
          scopeTypeCode: 'activity_person',
          scopeId: 'activity-1',
          capacity: 2,
          occupied: 2,
          version: 1,
        },
      ],
      activeReservationCounts: [{ bucketId: 'bucket-activity', count: 2 }],
    });

    await expect(
      new ActivityCapacityBucketProjector().apply(tx as never, 'activity-1'),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    expect(activityCapacityBucket.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an occupied-versus-active-reservation drift before changing any bucket', async () => {
    const { tx, activityCapacityBucket } = createTx({
      activityCapacity: 3,
      buckets: [
        {
          id: 'bucket-activity',
          scopeTypeCode: 'activity_person',
          scopeId: 'activity-1',
          capacity: 3,
          occupied: 1,
          version: 1,
        },
      ],
      activeReservationCounts: [{ bucketId: 'bucket-activity', count: 0 }],
    });

    await expect(
      new ActivityCapacityBucketProjector().apply(tx as never, 'activity-1'),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    expect(activityCapacityBucket.create).not.toHaveBeenCalled();
    expect(activityCapacityBucket.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a target scope that is already incorrectly anchored to another activity', async () => {
    const { tx, activityCapacityBucket } = createTx({
      activityCapacity: 3,
      buckets: [
        {
          id: 'bucket-wrong-anchor',
          activityId: 'other-activity',
          scopeTypeCode: 'activity_person',
          scopeId: 'activity-1',
          capacity: 3,
          occupied: 0,
          version: 0,
        },
      ],
    });

    await expect(
      new ActivityCapacityBucketProjector().apply(tx as never, 'activity-1'),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    expect(activityCapacityBucket.create).not.toHaveBeenCalled();
    expect(activityCapacityBucket.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a no-longer-target historical bucket with active occupancy even when its facts reconcile', async () => {
    const { tx, activityCapacityBucket } = createTx({
      activityCapacity: 3,
      buckets: [
        {
          id: 'bucket-historical',
          scopeTypeCode: 'session_participation',
          scopeId: 'cancelled-session',
          capacity: 3,
          occupied: 1,
          version: 4,
        },
      ],
      activeReservationCounts: [{ bucketId: 'bucket-historical', count: 1 }],
    });

    await expect(
      new ActivityCapacityBucketProjector().apply(tx as never, 'activity-1'),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    expect(activityCapacityBucket.create).not.toHaveBeenCalled();
    expect(activityCapacityBucket.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a lost CAS instead of accepting a capacity update without one exact affected row', async () => {
    const { tx } = createTx({
      activityCapacity: 4,
      buckets: [
        {
          id: 'bucket-activity',
          scopeTypeCode: 'activity_person',
          scopeId: 'activity-1',
          capacity: 5,
          occupied: 0,
          version: 2,
        },
      ],
      updateCount: 0,
    });

    await expect(
      new ActivityCapacityBucketProjector().apply(tx as never, 'activity-1'),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
  });
});
