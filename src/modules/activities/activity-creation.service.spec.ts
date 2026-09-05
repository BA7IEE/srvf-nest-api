import { Role, UserStatus } from '@prisma/client';
import type { ConfigType } from '@nestjs/config';
import type appConfig from '../../config/app.config';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { ActivityAccessService } from './activity-access.service';
import type { AppManagedActivitiesService } from './app-managed-activities.service';
import type { ActivityFromTemplateService } from './activity-from-template.service';
import type { ActivityCreationQuick } from './activity-creation-quick';
import type { ActivityCreationProfessional } from './activity-creation-professional';
import type { ActivityCreationEmergency } from './activity-creation-emergency';
import type { ActivityAuditRecorder } from './activity-audit-recorder';
import { ActivityCreationService } from './activity-creation.service';
import { ActivityControlPlaneGate } from './activity-control-plane.gate';
import type { ActivityControlPlaneMode } from '../../config/app.config';
import {
  mapEmergencyCreation,
  mapProfessionalCreation,
  mapQuickCreation,
} from './activity-creation-command';

const actor: CurrentUserPayload = {
  id: 'actor-0001',
  username: 'creator',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member-0001',
};
const auditMeta = { requestId: 'b6-access-test', ip: null, ua: null };
const base = {
  operationKey: 'b6-operation-0001',
  title: '创建活动',
  organizationId: 'organization-0001',
  startAt: '2099-09-01T08:00:00.000Z',
  endAt: '2099-09-01T12:00:00.000Z',
  location: '集合点',
};
const commands = {
  quick: mapQuickCreation({
    ...base,
    templateVersionId: 'template-0001',
    defaultPlaceVisibilityCode: 'staff',
  }),
  professional: mapProfessionalCreation({
    ...base,
    activityTypeCode: 'training',
    allocationModeCode: 'first_come',
    sessions: [
      {
        session: {
          code: 'morning',
          name: '上午场',
          startAt: base.startAt,
          endAt: base.endAt,
          locationText: base.location,
          checkInOpenAt: base.startAt,
          checkInCloseAt: base.startAt,
          checkOutOpenAt: base.endAt,
          checkOutCloseAt: base.endAt,
          locationRequired: false,
        },
        positions: [],
      },
    ],
  }),
  emergency: mapEmergencyCreation({
    ...base,
    initiatorMemberId: actor.memberId!,
    activityTypeCode: 'training',
    allocationModeCode: 'first_come',
    memberIds: ['member-0002'],
  }),
};

function makeHarness(enabled = true, controlMode: ActivityControlPlaneMode = 'active') {
  // The positive controls must reach this sentinel. No database or creation primitive is run.
  const transactionReached = new Error('root transaction reached');
  const transaction = jest
    .fn<Promise<unknown>, [unknown, unknown?]>()
    .mockRejectedValue(transactionReached);
  const assertCanOrThrow = jest
    .fn<
      ReturnType<ActivityAccessService['assertCanOrThrow']>,
      Parameters<ActivityAccessService['assertCanOrThrow']>
    >()
    .mockResolvedValue(undefined);
  const service = new ActivityCreationService(
    { $transaction: transaction } as unknown as PrismaService,
    { assertCanOrThrow } as unknown as ActivityAccessService,
    {} as AppManagedActivitiesService,
    {
      isCreationOperationKeyConflict: jest.fn().mockReturnValue(false),
    } as unknown as ActivityFromTemplateService,
    {} as ActivityCreationQuick,
    {} as ActivityCreationProfessional,
    {} as ActivityCreationEmergency,
    {} as ActivityAuditRecorder,
    { activityResponsibilityWorkflow: { enabled } } as ConfigType<typeof appConfig>,
    new ActivityControlPlaneGate({
      activityOsControlPlane: { mode: controlMode },
    } as ConfigType<typeof appConfig>),
  );
  const invoke = (mode: keyof typeof commands, user = actor) => {
    if (mode === 'quick') return service.createQuick(commands.quick, user, auditMeta);
    if (mode === 'professional')
      return service.createProfessional(commands.professional, user, auditMeta);
    return service.createEmergency(commands.emergency, user, auditMeta);
  };
  return { service, invoke, assertCanOrThrow, transaction, transactionReached };
}

describe.each(['quick', 'professional', 'emergency'] as const)(
  'B6 %s access checks precede every root transaction',
  (mode) => {
    it('B7 off denies an authorized actor without opening a root transaction', async () => {
      const h = makeHarness(true, 'off');
      await expect(h.invoke(mode)).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_CONTROL_PLANE_UNAVAILABLE,
      });
      expect(h.assertCanOrThrow.mock.calls).toEqual([
        [actor, 'activity.create.record'],
        ...(mode === 'emergency' ? [[actor, 'activity.create.emergency.record']] : []),
      ]);
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('B7 off preserves permission denial ahead of mode rejection', async () => {
      const h = makeHarness(true, 'off');
      const denied = new BizException(BizCode.RBAC_FORBIDDEN);
      h.assertCanOrThrow.mockRejectedValueOnce(denied);
      await expect(h.invoke(mode)).rejects.toBe(denied);
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('B7 shadow reaches the same B6 root transaction', async () => {
      const h = makeHarness(true, 'shadow');
      await expect(h.invoke(mode)).rejects.toBe(h.transactionReached);
      expect(h.transaction).toHaveBeenCalledTimes(1);
    });

    it('refuses actors without a member identity before checking permissions or opening a transaction', async () => {
      const h = makeHarness();
      await expect(h.invoke(mode, { ...actor, memberId: null })).rejects.toMatchObject({
        biz: BizCode.FORBIDDEN,
      });
      expect(h.assertCanOrThrow).not.toHaveBeenCalled();
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('refuses a disabled responsibility workflow before checking permissions or opening a transaction', async () => {
      const h = makeHarness(false);
      await expect(h.invoke(mode)).rejects.toMatchObject({ biz: BizCode.ACTIVITY_STATUS_INVALID });
      expect(h.assertCanOrThrow).not.toHaveBeenCalled();
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('requires ordinary creation permission independently of the requested creation mode', async () => {
      const h = makeHarness();
      const denied = new BizException(BizCode.RBAC_FORBIDDEN);
      h.assertCanOrThrow.mockRejectedValueOnce(denied);
      await expect(h.invoke(mode)).rejects.toBe(denied);
      expect(h.assertCanOrThrow.mock.calls).toEqual([[actor, 'activity.create.record']]);
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('fails closed when the authorization lookup itself fails', async () => {
      const h = makeHarness();
      const unavailable = new Error('authorization unavailable');
      h.assertCanOrThrow.mockRejectedValueOnce(unavailable);
      await expect(h.invoke(mode)).rejects.toBe(unavailable);
      expect(h.assertCanOrThrow).toHaveBeenCalledTimes(1);
      expect(h.transaction).not.toHaveBeenCalled();
    });

    it('positive control reaches the root transaction only after all required permissions pass', async () => {
      const h = makeHarness();
      await expect(h.invoke(mode)).rejects.toBe(h.transactionReached);
      expect(h.assertCanOrThrow.mock.calls).toEqual([
        [actor, 'activity.create.record'],
        ...(mode === 'emergency' ? [[actor, 'activity.create.emergency.record']] : []),
      ]);
      expect(h.transaction).toHaveBeenCalledTimes(1);
    });
  },
);

it('B6 emergency permission denial stops the transaction after ordinary permission has passed', async () => {
  const h = makeHarness();
  const denied = new BizException(BizCode.RBAC_FORBIDDEN);
  h.assertCanOrThrow.mockResolvedValueOnce(undefined).mockRejectedValueOnce(denied);
  await expect(h.invoke('emergency')).rejects.toBe(denied);
  expect(h.assertCanOrThrow.mock.calls).toEqual([
    [actor, 'activity.create.record'],
    [actor, 'activity.create.emergency.record'],
  ]);
  expect(h.transaction).not.toHaveBeenCalled();
});
