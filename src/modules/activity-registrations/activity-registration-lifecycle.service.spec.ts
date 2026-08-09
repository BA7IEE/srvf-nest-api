import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityRegistrationLifecycleService } from './activity-registration-lifecycle.service';
import type { CapacityReservationService } from './capacity-reservation.service';

describe('ActivityRegistrationLifecycleService', () => {
  const cancelledAt = new Date('2026-08-09T12:00:00.000Z');

  function setup(options?: {
    pointer?: string | null;
    populationIncluded?: boolean;
    statusCode?: string;
    activeSessionReservation?: boolean;
    currentPositionId?: string | null;
    reservationScopeId?: string;
    reservationScopeTypeCode?: string;
    revisionPresent?: boolean;
    revisionStatusCode?: string;
  }) {
    const pointer = options?.pointer === undefined ? 'session-reservation-1' : options.pointer;
    const populationIncluded = options?.populationIncluded ?? true;
    const statusCode = options?.statusCode ?? 'pass';
    const activeSessionReservation = options?.activeSessionReservation ?? true;
    const currentPositionId =
      options?.currentPositionId === undefined ? 'position-1' : options.currentPositionId;
    const revisionStatusCode = options?.revisionStatusCode ?? statusCode;
    const activeReservations = activeSessionReservation
      ? [
          {
            id: 'activity-reservation-1',
            identityId: 'identity-1',
            reservationType: 'activity_person',
            memberId: 'member-1',
            activityId: 'activity-1',
            bucketActivityId: 'activity-1',
            bucketScopeTypeCode: 'activity_person',
            scopeId: 'activity-1',
            bucketOccupied: 1,
            bucketActiveCount: 1,
            identityActivityId: 'activity-1',
            identityMemberId: 'member-1',
            identitySessionId: 'session-1',
            positionActivityId: null,
            positionSessionId: null,
          },
          {
            id: 'session-reservation-1',
            identityId: 'identity-1',
            reservationType: 'session_participation',
            memberId: null,
            activityId: null,
            bucketActivityId: 'activity-1',
            bucketScopeTypeCode: options?.reservationScopeTypeCode ?? 'session_participation',
            scopeId: options?.reservationScopeId ?? 'session-1',
            bucketOccupied: 1,
            bucketActiveCount: 1,
            identityActivityId: 'activity-1',
            identityMemberId: 'member-1',
            identitySessionId: 'session-1',
            positionActivityId: null,
            positionSessionId: null,
          },
          ...(currentPositionId === null
            ? []
            : [
                {
                  id: 'position-reservation-1',
                  identityId: 'identity-1',
                  reservationType: 'position_participation',
                  memberId: null,
                  activityId: null,
                  bucketActivityId: 'activity-1',
                  bucketScopeTypeCode: 'position_participation',
                  scopeId: currentPositionId,
                  bucketOccupied: 1,
                  bucketActiveCount: 1,
                  identityActivityId: 'activity-1',
                  identityMemberId: 'member-1',
                  identitySessionId: 'session-1',
                  positionActivityId: 'activity-1',
                  positionSessionId: 'session-1',
                },
              ]),
        ]
      : [];
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'registration-1',
            activityId: 'activity-1',
            memberId: 'member-1',
            currentRevision: 1,
            currentFormVersionId: null,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'identity-1',
            activityId: 'activity-1',
            memberId: 'member-1',
            sessionId: 'session-1',
            currentRevision: 1,
            currentStatusCode: statusCode,
            currentPositionId,
            capacityReservationId: pointer,
            populationIncluded,
            version: 4,
          },
        ])
        .mockResolvedValueOnce(activeReservations)
        .mockResolvedValueOnce([{ id: 'population-state-1', version: 8 }]),
      activityParticipationIdentity: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      activityRegistrationRevision: {
        findFirst: jest.fn().mockResolvedValue({ id: 'registration-revision-1' }),
        create: jest.fn().mockResolvedValue({ id: 'registration-revision-2' }),
      },
      activityParticipationRevision: {
        findMany: jest.fn().mockResolvedValue(
          options?.revisionPresent === false
            ? []
            : [
                {
                  identityId: 'identity-1',
                  revision: 1,
                  statusCode: revisionStatusCode,
                  positionId: currentPositionId,
                },
              ],
        ),
        create: jest.fn().mockResolvedValue({ id: 'participation-revision-2' }),
      },
      activityRegistration: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      activityEvidenceState: {
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const capacity = {
      releaseInTransactionTrusted: jest.fn().mockResolvedValue({
        outcome: 'released',
        releasedReservationIds: ['activity-reservation-1', 'session-reservation-1'],
      }),
    };
    const service = new ActivityRegistrationLifecycleService(
      capacity as unknown as CapacityReservationService,
    );
    return { service, tx, capacity };
  }

  it('releases capacity, appends both immutable revisions and advances all current projections', async () => {
    const { service, tx, capacity } = setup();

    await service.cancelInTransactionTrusted(tx as never, {
      activityId: 'activity-1',
      registrationId: 'registration-1',
      memberId: 'member-1',
      actorUserId: 'user-1',
      sourceCode: 'admin',
      cancelReason: 'cannot attend',
      cancelledAt,
    });

    expect(capacity.releaseInTransactionTrusted).toHaveBeenCalledWith(tx, {
      activityId: 'activity-1',
      memberId: 'member-1',
      identityIds: ['identity-1'],
      releaseReason: 'registration_cancelled',
    });
    expect(tx.activityRegistrationRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        registrationId: 'registration-1',
        revision: 2,
        priorRevisionId: 'registration-revision-1',
        sourceCode: 'admin',
      }) as unknown,
    });
    expect(tx.activityParticipationRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        identityId: 'identity-1',
        revision: 2,
        statusCode: 'cancelled',
        positionId: 'position-1',
      }) as unknown,
    });
    expect(tx.activityParticipationIdentity.updateMany).toHaveBeenCalledWith({
      where: { id: 'identity-1', currentRevision: 1, version: 4 },
      data: expect.objectContaining({
        currentRevision: 2,
        currentStatusCode: 'cancelled',
        currentPositionId: null,
        capacityReservationId: null,
        populationIncluded: false,
      }) as unknown,
    });
    expect(tx.activityRegistration.updateMany).toHaveBeenCalledWith({
      where: { id: 'registration-1', currentRevision: 1 },
      data: expect.objectContaining({
        statusCode: 'cancelled',
        currentRevision: 2,
        statusSummaryCode: 'cancelled',
      }) as unknown,
    });
    expect(tx.activityEvidenceState.updateMany).toHaveBeenCalledTimes(1);
  });

  it('rejects an occupied pass identity by releasing capacity and advancing only participation state', async () => {
    const { service, tx, capacity } = setup();

    await service.rejectInTransactionTrusted(tx as never, {
      activityId: 'activity-1',
      registrationId: 'registration-1',
      memberId: 'member-1',
      actorUserId: 'reviewer-1',
      reviewNote: 'not eligible',
      reviewedAt: cancelledAt,
    });

    expect(capacity.releaseInTransactionTrusted).toHaveBeenCalledWith(tx, {
      activityId: 'activity-1',
      memberId: 'member-1',
      identityIds: ['identity-1'],
      releaseReason: 'registration_rejected',
    });
    expect(tx.activityParticipationRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        identityId: 'identity-1',
        revision: 2,
        statusCode: 'rejected',
        positionId: 'position-1',
        reviewedByUserId: 'reviewer-1',
        reviewNote: 'not eligible',
      }) as unknown,
    });
    expect(tx.activityParticipationIdentity.updateMany).toHaveBeenCalledWith({
      where: { id: 'identity-1', currentRevision: 1, version: 4 },
      data: expect.objectContaining({
        currentRevision: 2,
        currentStatusCode: 'rejected',
        currentPositionId: null,
        capacityReservationId: null,
        populationIncluded: false,
      }) as unknown,
    });
    expect(tx.activityEvidenceState.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.activityRegistrationRevision.create).not.toHaveBeenCalled();
    expect(tx.activityRegistration.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a coherent pending identity without capacity release or population change', async () => {
    const { service, tx, capacity } = setup({
      statusCode: 'pending',
      pointer: null,
      populationIncluded: false,
      activeSessionReservation: false,
      currentPositionId: null,
    });

    await service.rejectInTransactionTrusted(tx as never, {
      activityId: 'activity-1',
      registrationId: 'registration-1',
      memberId: 'member-1',
      actorUserId: 'reviewer-1',
      reviewNote: 'not eligible',
      reviewedAt: cancelledAt,
    });

    expect(capacity.releaseInTransactionTrusted).not.toHaveBeenCalled();
    expect(tx.activityParticipationRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ statusCode: 'rejected', positionId: null }) as unknown,
    });
    expect(tx.activityEvidenceState.updateMany).not.toHaveBeenCalled();
  });

  it('reopens a coherent rejected identity by appending pending without registration revision or evidence writes', async () => {
    const { service, tx, capacity } = setup({
      statusCode: 'rejected',
      pointer: null,
      populationIncluded: false,
      activeSessionReservation: false,
      currentPositionId: null,
    });

    await service.reopenInTransactionTrusted(tx as never, {
      activityId: 'activity-1',
      registrationId: 'registration-1',
      memberId: 'member-1',
      actorUserId: 'reviewer-1',
      reopenedAt: cancelledAt,
    });

    expect(capacity.releaseInTransactionTrusted).not.toHaveBeenCalled();
    expect(tx.activityParticipationRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        identityId: 'identity-1',
        revision: 2,
        statusCode: 'pending',
        positionId: null,
      }) as unknown,
    });
    expect(tx.activityParticipationIdentity.updateMany).toHaveBeenCalledWith({
      where: { id: 'identity-1', currentRevision: 1, version: 4 },
      data: expect.objectContaining({
        currentRevision: 2,
        currentStatusCode: 'pending',
        currentPositionId: null,
        capacityReservationId: null,
        populationIncluded: false,
      }) as unknown,
    });
    expect(tx.activityRegistrationRevision.create).not.toHaveBeenCalled();
    expect(tx.activityRegistration.updateMany).not.toHaveBeenCalled();
    expect(tx.activityEvidenceState.updateMany).not.toHaveBeenCalled();
  });

  it('fails closed before release when the shortcut pointer does not match session truth', async () => {
    const { service, tx, capacity } = setup({ pointer: null });

    await expect(
      service.cancelInTransactionTrusted(tx as never, {
        activityId: 'activity-1',
        registrationId: 'registration-1',
        memberId: 'member-1',
        actorUserId: 'user-1',
        sourceCode: 'self',
        cancelReason: null,
        cancelledAt,
      }),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    expect(capacity.releaseInTransactionTrusted).not.toHaveBeenCalled();
    expect(tx.activityRegistrationRevision.create).not.toHaveBeenCalled();
  });

  it('fails closed before release when the session reservation points at another session bucket', async () => {
    const { service, tx, capacity } = setup({ reservationScopeId: 'session-2' });

    await expect(
      service.cancelInTransactionTrusted(tx as never, {
        activityId: 'activity-1',
        registrationId: 'registration-1',
        memberId: 'member-1',
        actorUserId: 'user-1',
        sourceCode: 'self',
        cancelReason: null,
        cancelledAt,
      }),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    expect(capacity.releaseInTransactionTrusted).not.toHaveBeenCalled();
  });

  it('fails closed when a session reservation is attached to a non-session bucket type', async () => {
    const { service, tx, capacity } = setup({
      reservationScopeTypeCode: 'position_participation',
    });

    await expect(
      service.cancelInTransactionTrusted(tx as never, {
        activityId: 'activity-1',
        registrationId: 'registration-1',
        memberId: 'member-1',
        actorUserId: 'user-1',
        sourceCode: 'self',
        cancelReason: null,
        cancelledAt,
      }),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    expect(capacity.releaseInTransactionTrusted).not.toHaveBeenCalled();
  });

  it.each(['activity_person', 'position_participation'])(
    'fails closed on an orphan active %s reservation without a session projection',
    async (reservationType) => {
      const service = new ActivityRegistrationLifecycleService({} as CapacityReservationService);
      const isActivityPerson = reservationType === 'activity_person';
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'orphan-reservation',
            identityId: 'identity-1',
            reservationType,
            memberId: isActivityPerson ? 'member-1' : null,
            activityId: isActivityPerson ? 'activity-1' : null,
            bucketActivityId: 'activity-1',
            bucketScopeTypeCode: reservationType,
            scopeId: isActivityPerson ? 'activity-1' : 'position-1',
            bucketOccupied: 1,
            bucketActiveCount: 1,
            identityActivityId: 'activity-1',
            identityMemberId: 'member-1',
            identitySessionId: 'session-1',
            positionActivityId: isActivityPerson ? null : 'activity-1',
            positionSessionId: isActivityPerson ? null : 'session-1',
          },
        ]),
      };

      await expect(
        service.assertCapacityPointersReconciledInTransactionTrusted(
          tx as never,
          [
            {
              id: 'identity-1',
              activityId: 'activity-1',
              memberId: 'member-1',
              sessionId: 'session-1',
              currentStatusCode: 'rejected',
              currentPositionId: null,
              capacityReservationId: null,
              populationIncluded: false,
            },
          ],
          { activityId: 'activity-1', memberId: 'member-1' },
        ),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    },
  );

  it('fails closed on a direct activity-person anchor when the permanent head has no identity', async () => {
    const service = new ActivityRegistrationLifecycleService({} as CapacityReservationService);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'foreign-anchor-reservation',
          identityId: 'foreign-identity',
          reservationType: 'activity_person',
          memberId: 'member-1',
          activityId: 'activity-1',
          bucketActivityId: 'activity-1',
          bucketScopeTypeCode: 'activity_person',
          scopeId: 'activity-1',
          bucketOccupied: 1,
          bucketActiveCount: 1,
          identityActivityId: 'activity-1',
          identityMemberId: 'foreign-member',
          identitySessionId: 'session-1',
          positionActivityId: null,
          positionSessionId: null,
        },
      ]),
    };

    await expect(
      service.assertCapacityPointersReconciledInTransactionTrusted(tx as never, [], {
        activityId: 'activity-1',
        memberId: 'member-1',
      }),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
  });

  it.each(['attended', 'settled'])(
    'fails closed when a participating %s identity falls out of the population',
    async (currentStatusCode) => {
      const service = new ActivityRegistrationLifecycleService({} as CapacityReservationService);
      const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };

      await expect(
        service.assertCapacityPointersReconciledInTransactionTrusted(
          tx as never,
          [
            {
              id: 'identity-1',
              activityId: 'activity-1',
              memberId: 'member-1',
              sessionId: 'session-1',
              currentStatusCode,
              currentPositionId: null,
              capacityReservationId: null,
              populationIncluded: false,
            },
          ],
          { activityId: 'activity-1', memberId: 'member-1' },
        ),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    },
  );

  it('accepts the member activity-person anchor on a released identity while another session stays active', async () => {
    const service = new ActivityRegistrationLifecycleService({} as CapacityReservationService);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'activity-reservation-1',
          identityId: 'identity-1',
          reservationType: 'activity_person',
          memberId: 'member-1',
          activityId: 'activity-1',
          bucketActivityId: 'activity-1',
          bucketScopeTypeCode: 'activity_person',
          scopeId: 'activity-1',
          bucketOccupied: 1,
          bucketActiveCount: 1,
          identityActivityId: 'activity-1',
          identityMemberId: 'member-1',
          identitySessionId: 'session-1',
          positionActivityId: null,
          positionSessionId: null,
        },
        {
          id: 'session-reservation-2',
          identityId: 'identity-2',
          reservationType: 'session_participation',
          memberId: null,
          activityId: null,
          bucketActivityId: 'activity-1',
          bucketScopeTypeCode: 'session_participation',
          scopeId: 'session-2',
          bucketOccupied: 1,
          bucketActiveCount: 1,
          identityActivityId: 'activity-1',
          identityMemberId: 'member-1',
          identitySessionId: 'session-2',
          positionActivityId: null,
          positionSessionId: null,
        },
      ]),
    };

    await expect(
      service.assertCapacityPointersReconciledInTransactionTrusted(
        tx as never,
        [
          {
            id: 'identity-1',
            activityId: 'activity-1',
            memberId: 'member-1',
            sessionId: 'session-1',
            currentStatusCode: 'rejected',
            currentPositionId: null,
            capacityReservationId: null,
            populationIncluded: false,
          },
          {
            id: 'identity-2',
            activityId: 'activity-1',
            memberId: 'member-1',
            sessionId: 'session-2',
            currentStatusCode: 'pass',
            currentPositionId: null,
            capacityReservationId: 'session-reservation-2',
            populationIncluded: true,
          },
        ],
        { activityId: 'activity-1', memberId: 'member-1' },
      ),
    ).resolves.toBeUndefined();
  });

  it('fails closed before release when the projected current participation revision is missing', async () => {
    const { service, tx, capacity } = setup({ revisionPresent: false });

    await expect(
      service.cancelInTransactionTrusted(tx as never, {
        activityId: 'activity-1',
        registrationId: 'registration-1',
        memberId: 'member-1',
        actorUserId: 'user-1',
        sourceCode: 'self',
        cancelReason: null,
        cancelledAt,
      }),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    expect(capacity.releaseInTransactionTrusted).not.toHaveBeenCalled();
  });

  it('does not advance population when cancellation changes no included identity', async () => {
    const { service, tx } = setup({
      statusCode: 'pending',
      pointer: null,
      populationIncluded: false,
      activeSessionReservation: false,
      currentPositionId: null,
    });

    await service.cancelInTransactionTrusted(tx as never, {
      activityId: 'activity-1',
      registrationId: 'registration-1',
      memberId: 'member-1',
      actorUserId: 'user-1',
      sourceCode: 'self',
      cancelReason: null,
      cancelledAt,
    });

    expect(tx.activityEvidenceState.updateMany).not.toHaveBeenCalled();
  });

  it('fails closed when a pass identity loses its population projection', async () => {
    const { service, tx, capacity } = setup({ populationIncluded: false });

    await expect(
      service.cancelInTransactionTrusted(tx as never, {
        activityId: 'activity-1',
        registrationId: 'registration-1',
        memberId: 'member-1',
        actorUserId: 'user-1',
        sourceCode: 'self',
        cancelReason: null,
        cancelledAt,
      }),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    expect(capacity.releaseInTransactionTrusted).not.toHaveBeenCalled();
    expect(tx.activityParticipationRevision.create).not.toHaveBeenCalled();
    expect(tx.activityRegistrationRevision.create).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'rejected', 'not_selected'])(
    'keeps the terminal %s identity immutable while cancelling only the header',
    async (statusCode) => {
      const { service, tx, capacity } = setup({
        statusCode,
        pointer: null,
        populationIncluded: false,
        activeSessionReservation: false,
        currentPositionId: null,
      });

      await service.cancelInTransactionTrusted(tx as never, {
        activityId: 'activity-1',
        registrationId: 'registration-1',
        memberId: 'member-1',
        actorUserId: 'user-1',
        sourceCode: 'admin',
        cancelReason: null,
        cancelledAt,
      });

      expect(capacity.releaseInTransactionTrusted).not.toHaveBeenCalled();
      expect(tx.activityParticipationRevision.create).not.toHaveBeenCalled();
      expect(tx.activityParticipationIdentity.updateMany).not.toHaveBeenCalled();
      expect(tx.activityRegistrationRevision.create).toHaveBeenCalledTimes(1);
      expect(tx.activityRegistration.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.activityEvidenceState.updateMany).not.toHaveBeenCalled();
    },
  );

  it('fails closed instead of releasing capacity behind a terminal noop identity', async () => {
    const { service, tx, capacity } = setup({ statusCode: 'rejected' });

    await expect(
      service.cancelInTransactionTrusted(tx as never, {
        activityId: 'activity-1',
        registrationId: 'registration-1',
        memberId: 'member-1',
        actorUserId: 'user-1',
        sourceCode: 'admin',
        cancelReason: null,
        cancelledAt,
      }),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    expect(capacity.releaseInTransactionTrusted).not.toHaveBeenCalled();
    expect(tx.activityRegistrationRevision.create).not.toHaveBeenCalled();
    expect(tx.activityParticipationRevision.create).not.toHaveBeenCalled();
  });

  it.each(['attended', 'settled', 'cancellation_requested', 'invitation_expired'])(
    'fails closed before release for the non-cancellable %s identity state',
    async (statusCode) => {
      const { service, tx, capacity } = setup({
        statusCode,
        pointer: null,
        populationIncluded: false,
        activeSessionReservation: false,
        currentPositionId: null,
      });

      await expect(
        service.cancelInTransactionTrusted(tx as never, {
          activityId: 'activity-1',
          registrationId: 'registration-1',
          memberId: 'member-1',
          actorUserId: 'user-1',
          sourceCode: 'admin',
          cancelReason: null,
          cancelledAt,
        }),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
      expect(capacity.releaseInTransactionTrusted).not.toHaveBeenCalled();
      expect(tx.activityRegistrationRevision.create).not.toHaveBeenCalled();
      expect(tx.activityParticipationRevision.create).not.toHaveBeenCalled();
    },
  );
});
