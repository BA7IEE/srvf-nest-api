import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import * as allocationLocks from './activity-allocation-locks';
import { ActivityAllocationService } from './activity-allocation.service';
import type { FreedAllocationSlot, PromotionWaitlistCandidate } from './activity-allocation.types';

const currentUser = {
  id: 'actor-1',
  username: 'actor',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'actor-member',
};
const auditMeta = { requestId: 'promotion-test', ip: null, ua: null };
const now = new Date('2026-11-13T02:00:00.000Z');

function slot(id: string, sessionId: string): FreedAllocationSlot {
  return {
    participationIdentityId: id,
    sessionId,
    positionId: 'position-1',
    allocationBatchId: null,
    priorSourceCode: 'self',
    priorRequestKey: 'request-1',
    currentStatusCode: 'cancelled',
    currentRevisionStatusCode: 'cancelled',
    currentPositionId: null,
    capacityReservationId: null,
    populationIncluded: false,
  };
}

function fixture(options: { hideRequested?: boolean; slots?: FreedAllocationSlot[] } = {}) {
  const oldSlot = slot('identity-old', 'session-old');
  const newSlot = slot('identity-new', 'session-new');
  const slots = options.slots ?? [oldSlot, newSlot];
  const queryRaw = jest.fn<Promise<unknown[]>, [Prisma.Sql]>().mockImplementation((sql) => {
    if (sql.sql.includes('FROM "Activity"')) {
      return Promise.resolve([
        { id: 'activity-1', title: '活动', allocationModeCode: 'first_come' },
      ]);
    }
    if (sql.sql.includes('FROM "ActivityParticipationIdentity"')) {
      if (options.hideRequested) return Promise.resolve([]);
      // Simulate the database filter: a query without an identity predicate returns both the
      // current and an earlier cancelled slot for the same permanent registration.
      return Promise.resolve(
        sql.sql.includes('i."id" IN')
          ? slots.filter((item) => sql.values.includes(item.participationIdentityId))
          : slots,
      );
    }
    if (sql.sql.includes('FROM "Member"')) {
      return Promise.resolve([{ id: 'candidate-member' }]);
    }
    throw new Error('unexpected query');
  });
  const tx = {
    $queryRaw: queryRaw,
    member: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'candidate-member', status: MemberStatus.ACTIVE }),
    },
    capacityReservation: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'person-reservation',
          bucketId: 'person-bucket',
          reservationType: 'activity_person',
          identityId: null,
        },
        {
          id: 'session-reservation',
          bucketId: 'session-bucket',
          reservationType: 'session_participation',
          identityId: 'candidate-identity',
        },
        {
          id: 'position-reservation',
          bucketId: 'position-bucket',
          reservationType: 'position_participation',
          identityId: 'candidate-identity',
        },
      ]),
    },
    activityParticipationRevision: { create: jest.fn().mockResolvedValue({ id: 'next-revision' }) },
    activityParticipationIdentity: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([{ currentStatusCode: 'pass' }]),
    },
    activityRegistration: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const capacity = {
    reserveInTransactionTrusted: jest.fn().mockResolvedValue({
      outcome: 'reserved',
      activityPersonReservationId: 'person-reservation',
      identities: [
        {
          identityId: 'candidate-identity',
          sessionReservationId: 'session-reservation',
          positionReservationId: 'position-reservation',
        },
      ],
    }),
  };
  const lifecycle = {
    incrementPopulationRevisionInTransactionTrusted: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { logAllocationPromotion: jest.fn().mockResolvedValue(undefined) };
  const notifications = { enqueueAllocationPromotion: jest.fn().mockResolvedValue(undefined) };
  const service = new ActivityAllocationService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    capacity as never,
    lifecycle as never,
    audit as never,
    notifications as never,
    {} as never,
  );
  return { service, tx, capacity, oldSlot, newSlot, queryRaw, lifecycle, audit, notifications };
}

function candidate(): PromotionWaitlistCandidate {
  return {
    participationIdentityId: 'candidate-identity',
    registrationId: 'candidate-registration',
    memberId: 'candidate-member',
    sessionId: 'session-new',
    positionId: 'position-1',
    allocationBatchId: null,
    waitlistRank: 1,
    acceptedAt: now,
    preferenceSnapshot: null,
    identityRevision: 3,
    identityVersion: 2,
    currentStatusCode: 'waitlisted',
    currentPositionId: null,
    capacityReservationId: null,
    populationIncluded: false,
  };
}

describe('promotion after a registration cancellation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('only considers slots released by this cancellation, not earlier cancelled sessions', async () => {
    const f = fixture();
    const queue = jest.spyOn(allocationLocks, 'lockFirstComeWaitlistHead').mockResolvedValue(null);
    await f.service.promoteAfterCancellationInTransactionTrusted(f.tx as never, {
      activityId: 'activity-1',
      registrationId: 'registration-1',
      releasedIdentityIds: ['identity-new'],
      actorUser: currentUser,
      promotedAt: now,
      auditMeta,
    });
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledWith(f.tx, 'activity-1', f.newSlot);
    expect(f.capacity.reserveInTransactionTrusted).not.toHaveBeenCalled();
  });

  it('does not reuse earlier slots when this cancellation releases no identity', async () => {
    const f = fixture();
    const queue = jest.spyOn(allocationLocks, 'lockFirstComeWaitlistHead').mockResolvedValue(null);
    await expect(
      f.service.promoteAfterCancellationInTransactionTrusted(f.tx as never, {
        activityId: 'activity-1',
        registrationId: 'registration-1',
        releasedIdentityIds: [],
        actorUser: currentUser,
        promotedAt: now,
        auditMeta,
      }),
    ).resolves.toMatchObject({ handled: false, promoted: [] });
    expect(queue).not.toHaveBeenCalled();
  });

  it.each(['admin', 'onsite'])(
    'preserves the existing fallback for a first-come pass written by %s',
    async (priorSourceCode) => {
      const released = {
        ...slot('identity-new', 'session-new'),
        priorSourceCode,
        priorRequestKey: null,
      };
      const f = fixture({ slots: [slot('identity-old', 'session-old'), released] });
      const queue = jest
        .spyOn(allocationLocks, 'lockFirstComeWaitlistHead')
        .mockResolvedValue(null);
      await expect(
        f.service.promoteAfterCancellationInTransactionTrusted(f.tx as never, {
          activityId: 'activity-1',
          registrationId: 'registration-1',
          releasedIdentityIds: ['identity-new'],
          actorUser: currentUser,
          promotedAt: now,
          auditMeta,
        }),
      ).resolves.toMatchObject({ handled: false, promoted: [] });
      expect(queue).not.toHaveBeenCalled();
    },
  );

  it('promotes one live candidate for the newly released session and position in the same client', async () => {
    const released = slot('identity-new', 'session-new');
    const f = fixture({ slots: [released] });
    jest.spyOn(allocationLocks, 'lockFirstComeWaitlistHead').mockResolvedValue(candidate());
    const result = await f.service.promoteAfterCancellationInTransactionTrusted(f.tx as never, {
      activityId: 'activity-1',
      registrationId: 'registration-1',
      releasedIdentityIds: ['identity-new'],
      actorUser: currentUser,
      promotedAt: now,
      auditMeta,
    });
    expect(result.promoted).toEqual([
      { registrationId: 'candidate-registration', memberId: 'candidate-member' },
    ]);
    expect(f.tx.member.findFirst).toHaveBeenCalledTimes(1);
    expect(f.capacity.reserveInTransactionTrusted).toHaveBeenCalledWith(f.tx, {
      activityId: 'activity-1',
      memberId: 'candidate-member',
      selections: [{ identityId: 'candidate-identity', positionId: 'position-1' }],
    });
    expect(f.tx.activityParticipationRevision.create).toHaveBeenCalledTimes(1);
    expect(f.tx.activityParticipationIdentity.updateMany).toHaveBeenCalledTimes(1);
    expect(f.lifecycle.incrementPopulationRevisionInTransactionTrusted).toHaveBeenCalledWith(
      f.tx,
      'activity-1',
      now,
    );
    expect(f.audit.logAllocationPromotion).toHaveBeenCalledTimes(1);
    expect(f.notifications.enqueueAllocationPromotion).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        participationIdentityId: 'candidate-identity',
        promotionKey: 'first-come:4',
      }) as unknown,
    );
  });

  it('does not reserve, write, or enqueue for an inactive candidate', async () => {
    const f = fixture();
    f.tx.member.findFirst.mockResolvedValue({
      id: 'candidate-member',
      status: MemberStatus.INACTIVE,
    });
    jest.spyOn(allocationLocks, 'lockFirstComeWaitlistHead').mockResolvedValue(candidate());
    await f.service.promoteAfterCancellationInTransactionTrusted(f.tx as never, {
      activityId: 'activity-1',
      registrationId: 'registration-1',
      releasedIdentityIds: ['identity-new'],
      actorUser: currentUser,
      promotedAt: now,
      auditMeta,
    });
    expect(f.capacity.reserveInTransactionTrusted).not.toHaveBeenCalled();
    expect(f.tx.activityParticipationRevision.create).not.toHaveBeenCalled();
    expect(f.notifications.enqueueAllocationPromotion).not.toHaveBeenCalled();
  });

  it('fails closed when a supposedly released identity cannot be matched to the registration', async () => {
    const f = fixture({ hideRequested: true });
    await expect(
      f.service.promoteAfterCancellationInTransactionTrusted(f.tx as never, {
        activityId: 'activity-1',
        registrationId: 'registration-1',
        releasedIdentityIds: ['identity-new'],
        actorUser: currentUser,
        promotedAt: now,
        auditMeta,
      }),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    expect(f.capacity.reserveInTransactionTrusted).not.toHaveBeenCalled();
  });

  it('rejects duplicate released identity ids rather than promoting the same slot twice', async () => {
    const f = fixture();
    await expect(
      f.service.promoteAfterCancellationInTransactionTrusted(f.tx as never, {
        activityId: 'activity-1',
        registrationId: 'registration-1',
        releasedIdentityIds: ['identity-new', 'identity-new'],
        actorUser: currentUser,
        promotedAt: now,
        auditMeta,
      }),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    expect(f.capacity.reserveInTransactionTrusted).not.toHaveBeenCalled();
  });

  it('rejects duplicate database rows even if their count matches the requested count', async () => {
    const f = fixture({
      slots: [slot('identity-new', 'session-new'), slot('identity-new', 'session-new')],
    });
    await expect(
      f.service.promoteAfterCancellationInTransactionTrusted(f.tx as never, {
        activityId: 'activity-1',
        registrationId: 'registration-1',
        releasedIdentityIds: ['identity-new', 'identity-missing'],
        actorUser: currentUser,
        promotedAt: now,
        auditMeta,
      }),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    expect(f.capacity.reserveInTransactionTrusted).not.toHaveBeenCalled();
  });

  it('handles more than one query chunk without processing any slot twice', async () => {
    const slots = Array.from({ length: 501 }, (_, index) =>
      slot(`identity-${index.toString().padStart(3, '0')}`, `session-${index}`),
    );
    const f = fixture({ slots });
    const queue = jest.spyOn(allocationLocks, 'lockFirstComeWaitlistHead').mockResolvedValue(null);
    await f.service.promoteAfterCancellationInTransactionTrusted(f.tx as never, {
      activityId: 'activity-1',
      registrationId: 'registration-1',
      releasedIdentityIds: slots.map((item) => item.participationIdentityId),
      actorUser: currentUser,
      promotedAt: now,
      auditMeta,
    });
    const slotQueries = f.queryRaw.mock.calls.filter(([query]) =>
      query.sql.includes('FROM "ActivityParticipationIdentity"'),
    );
    expect(slotQueries).toHaveLength(2);
    expect(queue).toHaveBeenCalledTimes(501);
    expect(new Set(queue.mock.calls.map(([, , item]) => item.participationIdentityId)).size).toBe(
      501,
    );
  });
});
