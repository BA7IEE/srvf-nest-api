import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuthzService } from '../authz/authz.service';
import type { InsuranceRequirementService } from '../insurances/insurance-requirement.service';
import type { RbacService } from '../permissions/rbac.service';
import type { AppIdentityResolver } from '../users/app-identity.resolver';
import type { ActivityRegistrationAuditRecorder } from './activity-registration-audit-recorder';
import type { ActivityRegistrationLifecycleService } from './activity-registration-lifecycle.service';
import type { CapacityReservationService } from './capacity-reservation.service';
import {
  OnsiteParticipationCommandService,
  selectOnsiteCanonicalHeader,
  type OnsiteLockedIdentity,
} from './onsite-participation-command.service';

const identity = (registrationId: string): OnsiteLockedIdentity => ({
  id: 'identity-1',
  activityId: 'activity-1',
  memberId: 'member-1',
  registrationId,
  sessionId: 'session-1',
  currentRevision: 1,
  currentStatusCode: 'pending',
  currentPositionId: null,
  capacityReservationId: null,
  populationIncluded: false,
  version: 1,
});

describe('OnsiteParticipationCommandService canonical-header boundary', () => {
  it('reuses the one cancelled live header when every permanent identity belongs to it', () => {
    expect(
      selectOnsiteCanonicalHeader(
        [{ id: 'cancelled-header', statusCode: 'cancelled', currentRevision: 4 }],
        [identity('cancelled-header')],
      ),
    ).toEqual({ id: 'cancelled-header', statusCode: 'cancelled', currentRevision: 4 });
  });

  it('fails closed rather than relinking an identity from a historical header', () => {
    expect(() =>
      selectOnsiteCanonicalHeader(
        [{ id: 'live-header', statusCode: 'pending', currentRevision: 2 }],
        [identity('historic-header')],
      ),
    ).toThrow(BizException);
    try {
      selectOnsiteCanonicalHeader(
        [{ id: 'live-header', statusCode: 'pending', currentRevision: 2 }],
        [identity('historic-header')],
      );
    } catch (error) {
      expect(error).toMatchObject({
        biz: BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
      });
    }
  });

  it('fails closed when multiple current heads make the aggregate irreconcilable', () => {
    expect(() =>
      selectOnsiteCanonicalHeader(
        [
          { id: 'live-header-a', statusCode: 'pending', currentRevision: 2 },
          { id: 'live-header-b', statusCode: 'waitlisted', currentRevision: 3 },
        ],
        [],
      ),
    ).toThrow(BizException);
  });
});

describe('OnsiteParticipationCommandService transaction budget', () => {
  it('gives a 100-request Activity-root convoy an explicit bounded transaction budget', async () => {
    const transactionFailure = new Error('transaction-budget-probe');
    const transaction = jest.fn().mockRejectedValue(transactionFailure);
    const service = new OnsiteParticipationCommandService(
      { $transaction: transaction } as unknown as PrismaService,
      {
        resolve: jest.fn().mockResolvedValue({
          canUseApp: true,
          member: { id: 'actor-member' },
        }),
      } as unknown as AppIdentityResolver,
      {
        explain: jest.fn().mockResolvedValue({ allow: true }),
      } as unknown as AuthzService,
      {} as RbacService,
      {} as InsuranceRequirementService,
      {} as CapacityReservationService,
      {} as ActivityRegistrationLifecycleService,
      {} as ActivityRegistrationAuditRecorder,
    );
    const currentUser: CurrentUserPayload = {
      id: 'actor-user',
      username: 'actor',
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
      memberId: 'actor-member',
    };

    await expect(
      service.create(
        'activity-1',
        {
          operationKey: 'onsite-transaction-budget-probe',
          memberId: 'target-member',
          sessionId: 'session-1',
          reason: 'transaction budget probe',
        },
        currentUser,
        { requestId: 'request-1', ip: null, ua: null },
      ),
    ).rejects.toBe(transactionFailure);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 15_000,
    });
  });
});
