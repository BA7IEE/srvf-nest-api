import { Role, UserStatus } from '@prisma/client';
import type { ConfigType } from '@nestjs/config';
import type appConfig from '../../config/app.config';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import { ActivitySimpleDraftService } from './activity-simple-draft.service';
import { computeActivityTemplateDefinitionHash } from './activity-template-definition';
import type { ActivityAccessService } from './activity-access.service';
import type { ActivityCreationService } from './activity-creation.service';
import type { ActivityMetricSelectionAccess } from './activity-metric-selection-access';
import type { ActivityInitiationPolicy } from './activity-initiation-policy';
import type { ActivityFromTemplateService } from './activity-from-template.service';
import type { ActivityTimePolicySelectionAccess } from './activity-time-policy-selection-access';
import type { ActivityTimePolicySelectionService } from './activity-time-policy-selection.service';
import type { ActivityContributionPolicySelectionAccess } from './activity-contribution-policy-selection-access';
import type { ActivityContributionPolicySelectionService } from './activity-contribution-policy-selection.service';
import type { ActivityDraftAuditRecorder } from './activity-draft-audit-recorder';
import type { AppManagedActivitiesService } from './app-managed-activities.service';
import type { ActivityPublishReviewSubmitService } from './activity-publish-review-submit.service';

const actor: CurrentUserPayload = {
  id: 'actor-0001',
  username: 'publisher',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: 'member-0001',
};
const meta = { requestId: 'simple-draft-test', ip: null, ua: null };
function fixture(explicitPosition = false) {
  const startAt = new Date('2099-09-01T00:00:00Z'),
    endAt = new Date('2099-09-01T02:00:00Z');
  const definition = {
    activity: { allocationModeCode: 'first_come', capacity: 2 },
    sessions: [
      {
        code: 'main',
        name: '场次',
        startOffsetMinutes: 0,
        endOffsetMinutes: 120,
        locationText: '地点',
        capacity: 2,
        checkInOpenOffsetMinutes: 0,
        checkInCloseOffsetMinutes: 10,
        checkOutOpenOffsetMinutes: -10,
        checkOutCloseOffsetMinutes: 0,
        locationRequired: false,
        lateGraceMinutes: 0,
        earlyLeaveThresholdMinutes: 0,
        sortOrder: 0,
        positions: [
          {
            code: 'participant',
            name: '参与',
            attendanceRoleCode: 'volunteer',
            ...(explicitPosition ? { startOffsetMinutes: 0, endOffsetMinutes: 120 } : {}),
            capacity: 2,
            sortOrder: 0,
          },
        ],
      },
    ],
  };
  const template = {
    id: 'template-0001',
    familyId: 'family-0001',
    schemaVersion: 1,
    statusCode: 'active',
    definitionJson: definition,
    definitionHash: computeActivityTemplateDefinitionHash({ schemaVersion: 1, definition }),
    family: {
      id: 'family-0001',
      statusCode: 'active',
      scopeTypeCode: 'global',
      ownerOrganizationId: null,
    },
  };
  const activity = {
    id: 'activity-0001',
    title: '原草稿',
    organizationId: 'organization-0001',
    activityTypeCode: 'training',
    startAt,
    endAt,
    location: '地点',
    capacity: 2,
    description: null,
    registrationNotes: null,
    registrationDeadline: null,
    statusCode: 'draft',
    initiatorMemberId: actor.memberId,
    selectedTemplateVersionId: template.id,
    allocationModeCode: 'first_come',
    timePolicySelectionRevision: 0,
    currentTimePolicySelectionRevisionId: null,
    contributionPolicySelectionRevision: 0,
    currentContributionPolicySelectionRevisionId: null,
    metricRequirementCode: null,
    updatedAt: startAt,
  };
  const session = {
    id: 'session-0001',
    activityId: activity.id,
    code: 'main',
    name: '场次',
    startAt,
    endAt,
    locationText: '地点',
    capacity: 2,
    statusCode: 'scheduled',
    deletedAt: null,
    checkInOpenAt: startAt,
    checkInCloseAt: new Date(startAt.getTime() + 10 * 60000),
    checkOutOpenAt: new Date(endAt.getTime() - 10 * 60000),
    checkOutCloseAt: endAt,
    preparationStartAt: null,
  };
  const position = {
    id: 'position-0001',
    activityId: activity.id,
    sessionId: session.id,
    code: 'participant',
    name: '参与',
    attendanceRoleCode: 'volunteer',
    capacity: 2,
    startAt: explicitPosition ? startAt : null,
    endAt: explicitPosition ? endAt : null,
    qualificationRuleSetId: null,
    deletedAt: null,
  };
  const places = [null, session.id].map((sessionId, index) => ({
    id: `place-000${index}`,
    activityId: activity.id,
    sessionId,
    roleCode: 'primary',
    visibilityCode: 'staff',
    name: '地点',
    addressText: '地点',
    instruction: null,
    longitude: null,
    latitude: null,
    coordinateSystemCode: null,
    providerCode: null,
    providerPlaceId: null,
    checkInEligible: false,
    radiusMeters: null,
    sourcePresetId: null,
    workflowRevision: 0,
  }));
  let review: { id: string; status: string; requestType: string } | null = null;
  const update = <T extends object>(target: T) =>
    jest.fn(({ data }: { data: Partial<T> }) => {
      Object.assign(target, data);
      return Promise.resolve({ ...target });
    });
  const tx = {
    $queryRaw: jest.fn(() => Promise.resolve([{ id: activity.id }])),
    activity: {
      findFirst: jest.fn(() => Promise.resolve({ ...activity })),
      update: update(activity),
    },
    activityTemplate: { findFirst: jest.fn(() => Promise.resolve(template)) },
    activitySession: {
      findMany: jest.fn(() => Promise.resolve([{ ...session }])),
      update: update(session),
    },
    activitySessionPosition: {
      findMany: jest.fn(() => Promise.resolve([{ ...position }])),
      update: update(position),
    },
    activityPlace: {
      findMany: jest.fn(() => Promise.resolve(places.map((p) => ({ ...p })))),
      update: jest.fn(
        ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const place = places.find((p) => p.id === where.id)!;
          Object.assign(place, data);
          return Promise.resolve({ ...place });
        },
      ),
    },
    registrationFormVersion: { findMany: jest.fn(() => Promise.resolve([])) },
    activityPublishReview: { findFirst: jest.fn(() => Promise.resolve(review)) },
  };
  const prisma = {
    $transaction: jest.fn((callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
  };
  const identities = { current: jest.fn(() => Promise.resolve(actor)) };
  const access = {
    assertCanOrThrow: jest.fn(() => Promise.resolve(undefined)),
    assertStartEndValid: jest.fn(),
    assertRegistrationDeadlineValid: jest.fn(),
  };
  const initiation = { resolveInitiator: jest.fn(() => Promise.resolve(actor.memberId!)) };
  const templates = {
    simpleDraftTemplateWithinTransaction: jest.fn(
      async (_tx: unknown, _id: unknown, revalidate: () => Promise<void>) => {
        await revalidate();
        return { definition, definitionHash: template.definitionHash };
      },
    ),
  };
  const time = {
    assertCurrentForDraftWithinTransaction: jest.fn(
      (_tx: unknown, _activity: unknown, revalidate: () => Promise<void>) => revalidate(),
    ),
  };
  const contribution = {
    assertCurrentForDraftWithinTransaction: jest.fn(
      (_tx: unknown, _activity: unknown, revalidate: () => Promise<void>) => revalidate(),
    ),
  };
  const audit = { log: jest.fn(() => Promise.resolve(undefined)) };
  const service = new ActivitySimpleDraftService(
    prisma as unknown as PrismaService,
    {} as ActivityCreationService,
    access as unknown as ActivityAccessService,
    identities as unknown as ActivityMetricSelectionAccess,
    initiation as unknown as ActivityInitiationPolicy,
    templates as unknown as ActivityFromTemplateService,
    {} as ActivityTimePolicySelectionAccess,
    time as unknown as ActivityTimePolicySelectionService,
    {} as ActivityContributionPolicySelectionAccess,
    contribution as unknown as ActivityContributionPolicySelectionService,
    audit as unknown as ActivityDraftAuditRecorder,
    {} as AppManagedActivitiesService,
    {} as ActivityPublishReviewSubmitService,
    { activityResponsibilityWorkflow: { enabled: true } } as ConfigType<typeof appConfig>,
  );
  const input = async () => ({
    title: '新安排',
    organizationId: activity.organizationId,
    startAt: '2099-09-02T00:00:00Z',
    endAt: '2099-09-02T03:00:00Z',
    location: '新地点',
    expectedDraftHash: ((await service.get(activity.id, actor)) as { draftHash: string }).draftHash,
    instance: {
      capacity: 4,
      registrationDeadline: null,
      description: '本次说明',
      registrationNotes: null,
    },
    places: [
      {
        roleCode: 'primary' as const,
        visibilityCode: 'staff' as const,
        inline: { name: '新地点', addressText: '新地点', checkInEligible: false },
      },
    ],
  });
  return {
    service,
    input,
    tx,
    prisma,
    activity,
    session,
    position,
    places,
    identities,
    audit,
    access,
    time,
    templates,
    setReview: (value: typeof review) => {
      review = value;
    },
  };
}

describe('simple draft root transaction and authorization boundaries (no database)', () => {
  it('keeps an approved explicit full-session duty explicit when the whole simple schedule moves', async () => {
    const h = fixture(true),
      input = await h.input();
    await h.service.save(h.activity.id, input, actor, meta);
    expect(h.position.startAt?.toISOString()).toBe('2099-09-02T00:00:00.000Z');
    expect(h.position.endAt?.toISOString()).toBe('2099-09-02T03:00:00.000Z');
  });

  it.each([
    [
      'shortened duty',
      (h: ReturnType<typeof fixture>) => {
        Object.assign(h.position, {
          startAt: new Date('2099-09-01T00:30:00Z'),
          endAt: new Date('2099-09-01T01:30:00Z'),
        });
      },
    ],
    [
      'changed inheritance',
      (h: ReturnType<typeof fixture>) => {
        Object.assign(h.position, { startAt: h.activity.startAt, endAt: h.activity.endAt });
      },
    ],
    [
      'different check-in window',
      (h: ReturnType<typeof fixture>) => {
        h.session.checkInCloseAt = new Date('2099-09-01T00:25:00Z');
      },
    ],
    [
      'different check-out window',
      (h: ReturnType<typeof fixture>) => {
        h.session.checkOutOpenAt = new Date('2099-09-01T01:30:00Z');
      },
    ],
  ] as const)('rejects current professional %s without overwriting it', async (_label, change) => {
    const h = fixture(),
      input = await h.input();
    change(h);
    await expect(h.service.get(h.activity.id, actor)).rejects.toMatchObject({
      biz: BizCode.BAD_REQUEST,
    });
    await expect(h.service.save(h.activity.id, input, actor, meta)).rejects.toMatchObject({
      biz: BizCode.BAD_REQUEST,
    });
    expect(h.tx.activity.update).not.toHaveBeenCalled();
    expect(h.tx.activitySession.update).not.toHaveBeenCalled();
    expect(h.tx.activitySessionPosition.update).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });

  it('uses the same tx for parent, child, places, interval checks and audit; returns final facts', async () => {
    const h = fixture(),
      input = await h.input();
    h.prisma.$transaction.mockClear();
    const result = (await h.service.save(h.activity.id, input, actor, meta)) as {
      title: string;
      instance: { capacity: number };
      session: { endAt: string };
      draftHash: string;
    };
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.title).toBe('新安排');
    expect(result.instance.capacity).toBe(4);
    expect(result.session.endAt).toBe('2099-09-02T03:00:00.000Z');
    expect(result.draftHash).not.toBe(input.expectedDraftHash);
    expect(h.time.assertCurrentForDraftWithinTransaction.mock.calls[0][0]).toBe(h.tx);
    expect(h.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: h.tx,
        operation: 'simple-draft-update',
        actorUserId: actor.id,
      }),
    );
    expect(h.places.map((p) => p.addressText)).toEqual(['新地点', '新地点']);
  });
  it('rejects a concurrent child edit before any business write', async () => {
    const h = fixture(),
      input = await h.input();
    h.position.name = '另一人修改';
    await expect(h.service.save(h.activity.id, input, actor, meta)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_SIMPLE_DRAFT_STALE,
    });
    expect(h.tx.activity.update).not.toHaveBeenCalled();
    expect(h.audit.log).not.toHaveBeenCalled();
  });
  it('freezes pending reviews without relying on a UI or workflow revision', async () => {
    const h = fixture(),
      input = await h.input();
    h.setReview({ id: 'review-0001', status: 'pending', requestType: 'initial' });
    expect(await h.service.get(h.activity.id, actor)).toMatchObject({
      editable: false,
      review: { status: 'pending' },
    });
    await expect(h.service.save(h.activity.id, input, actor, meta)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING,
    });
    expect(h.tx.activity.update).not.toHaveBeenCalled();
  });
  it('rechecks current authorization after waiting on child locks', async () => {
    const h = fixture(),
      input = await h.input();
    h.identities.current.mockClear();
    h.identities.current
      .mockResolvedValueOnce(actor)
      .mockRejectedValueOnce(new BizException(BizCode.UNAUTHORIZED));
    await expect(h.service.save(h.activity.id, input, actor, meta)).rejects.toMatchObject({
      biz: BizCode.UNAUTHORIZED,
    });
    expect(h.tx.activity.update).not.toHaveBeenCalled();
  });
  it('cannot use SUPER_ADMIN to impersonate the draft initiator', async () => {
    const h = fixture();
    h.identities.current.mockResolvedValue({
      ...actor,
      role: Role.SUPER_ADMIN,
      memberId: 'member-other',
    });
    await expect(h.service.get(h.activity.id, actor)).rejects.toMatchObject({
      biz: BizCode.ACTIVITY_NOT_FOUND,
    });
  });
  it('propagates retained-policy and audit failures out of the root transaction', async () => {
    for (const boundary of ['policy', 'audit']) {
      const h = fixture(),
        input = await h.input(),
        error = new Error(boundary);
      if (boundary === 'policy')
        h.time.assertCurrentForDraftWithinTransaction.mockRejectedValueOnce(error);
      else h.audit.log.mockRejectedValueOnce(error);
      await expect(h.service.save(h.activity.id, input, actor, meta)).rejects.toBe(error);
      if (boundary === 'policy') expect(h.audit.log).not.toHaveBeenCalled();
    }
  });
});
