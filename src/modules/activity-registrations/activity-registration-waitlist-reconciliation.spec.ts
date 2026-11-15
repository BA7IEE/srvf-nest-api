import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityRegistrationLifecycleService } from './activity-registration-lifecycle.service';

const identity = {
  id: 'identity-1',
  activityId: 'activity-1',
  sessionId: 'session-1',
  currentRevision: 2,
  currentStatusCode: 'waitlisted',
  currentPositionId: null,
};

function fixture(
  overrides: {
    revision?: number;
    statusCode?: string;
    positionId?: string | null;
    waitlistRank?: number | null;
    position?: { activityId: string; sessionId: string } | null;
  } = {},
) {
  const row = {
    identityId: 'identity-1',
    revision: 2,
    statusCode: 'waitlisted',
    positionId: 'position-1',
    waitlistRank: 1,
    ...overrides,
  };
  const position =
    overrides.position === undefined
      ? { id: 'position-1', activityId: 'activity-1', sessionId: 'session-1' }
      : overrides.position === null
        ? null
        : { id: 'position-1', ...overrides.position };
  const tx = {
    activityParticipationRevision: { findMany: jest.fn().mockResolvedValue([row]) },
    activitySessionPosition: { findMany: jest.fn().mockResolvedValue(position ? [position] : []) },
  };
  const service = new ActivityRegistrationLifecycleService({} as never);
  const reconcile: (
    tx: never,
    identities: (typeof identity)[],
    options?: { allowScopedWaitlistPosition?: boolean },
  ) => Promise<void> =
    service.assertParticipationRevisionsReconciledInTransactionTrusted.bind(service);
  return { reconcile, tx };
}

describe('waitlist position reconciliation', () => {
  it('accepts a ranked position in the immutable revision while the identity has no occupied position', async () => {
    const { reconcile, tx } = fixture();
    await expect(reconcile(tx as never, [identity])).rejects.toEqual(
      new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED),
    );
    await expect(
      reconcile(tx as never, [identity], {
        allowScopedWaitlistPosition: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('preserves the existing acceptance of a positionless waitlist revision', async () => {
    const { reconcile, tx } = fixture({ positionId: null, position: null, waitlistRank: null });
    await expect(
      reconcile(tx as never, [identity], {
        allowScopedWaitlistPosition: true,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ['another activity', { position: { activityId: 'activity-2', sessionId: 'session-1' } }],
    ['another session', { position: { activityId: 'activity-1', sessionId: 'session-2' } }],
    ['missing position', { position: null }],
    ['missing rank', { waitlistRank: null }],
    ['zero rank', { waitlistRank: 0 }],
    ['wrong revision', { revision: 1 }],
    ['wrong status', { statusCode: 'pending' }],
  ] as const)(
    'rejects %s without treating it as a valid waiting position',
    async (_label, overrides) => {
      const { reconcile, tx } = fixture(overrides);
      await expect(
        reconcile(tx as never, [identity], { allowScopedWaitlistPosition: true }),
      ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
    },
  );

  it('still rejects a position mismatch for a pending identity', async () => {
    const { reconcile, tx } = fixture({ statusCode: 'pending' });
    await expect(
      reconcile(tx as never, [{ ...identity, currentStatusCode: 'pending' }], {
        allowScopedWaitlistPosition: true,
      }),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED));
  });
});
