import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { MemberStatus, Prisma, Role } from '@prisma/client';
import request from 'supertest';
import appConfig from '../../src/config/app.config';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityAuditRecorder } from '../../src/modules/activities/activity-audit-recorder';
import { ActivityCreationEmergency } from '../../src/modules/activities/activity-creation-emergency';
import { ActivityAccessService } from '../../src/modules/activities/activity-access.service';
import { ActivityDraftService } from '../../src/modules/activities/activity-draft.service';
import { ActivityNotificationProducer } from '../../src/modules/activities/activity-notification-producer';
import { ActivityPublishProposalV2Service } from '../../src/modules/activities/activity-publish-proposal-v2.service';
import {
  buildProposalSnapshot,
  lockActivity,
} from '../../src/modules/activities/activity-publish-review-access';
import * as followUps from '../../src/modules/activities/activity-emergency-follow-up';
import * as recipientFreeze from '../../src/modules/activities/activity-recipient-freeze';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const ROOT = '/api/app/v1/my/managed-activities';
const START = '2099-09-01T08:00:00.000Z';
const END = '2099-09-01T12:00:00.000Z';
const META = { requestId: 'b6-emergency-e2e', ip: null, ua: 'jest' };
type CreationResult = {
  activity: { activityId: string; createdAt: string; createdStatusCode: string };
  mode: string;
  replayed: boolean;
  followUpItems: { itemCode: string; statusCode: string }[];
};
type CreationResponse = { code: number; data: CreationResult };

describe('B6 emergency creation: frozen calls, real facts and publication refusal', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let config: ConfigType<typeof appConfig>;
  let auth: string;
  let otherAuth: string;
  let ordinaryAuth: string;
  let ordinary: CurrentUserPayload;
  let actor: CurrentUserPayload;
  let organizationId: string;
  let childId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const previousControlMode = process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
  const unique = (label: string) => `b6-emergency-${label}-${++sequence}`;

  async function member(orgId: string, status: MemberStatus = MemberStatus.ACTIVE) {
    const result = await prisma.member.create({
      data: {
        memberNo: unique('member'),
        ...memberIdentityData('B6 紧急测试'),
        gradeCode: 'level-3',
        status,
      },
    });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: result.id, organizationId: orgId },
    });
    return result;
  }

  async function user(role: Role) {
    const person = await member(organizationId);
    const account = await createTestUser(app, { username: unique('user'), role });
    await prisma.user.update({ where: { id: account.id }, data: { memberId: person.id } });
    const payload: CurrentUserPayload = {
      id: account.id,
      username: account.username,
      role,
      status: 'ACTIVE',
      memberId: person.id,
    };
    return { payload, auth: (await loginAs(app, account.username)).authHeader };
  }

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = 'active';
    app = await createTestApp();
    prisma = app.get(PrismaService);
    config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
    await resetDb(app);
    const root = await prisma.organization.create({
      data: { name: unique('root'), nodeTypeCode: 'root' },
    });
    const org = await prisma.organization.create({
      data: { name: unique('team'), nodeTypeCode: 'team', parentId: root.id },
    });
    const child = await prisma.organization.create({
      data: { name: unique('child'), nodeTypeCode: 'team', parentId: org.id },
    });
    organizationId = org.id;
    childId = child.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: org.id, depth: 1 },
        { ancestorId: root.id, descendantId: child.id, depth: 2 },
        { ancestorId: org.id, descendantId: org.id, depth: 0 },
        { ancestorId: org.id, descendantId: child.id, depth: 1 },
        { ancestorId: child.id, descendantId: child.id, depth: 0 },
      ],
    });
    const creator = await user(Role.SUPER_ADMIN);
    actor = creator.payload;
    auth = creator.auth;
    otherAuth = (await user(Role.SUPER_ADMIN)).auth;
    const standard = await user(Role.USER);
    ordinary = standard.payload;
    ordinaryAuth = standard.auth;
    const permissions = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, ordinary.id, permissions.bizAdminRoleId);
    const type = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
    });
    await prisma.dictItem.create({
      data: { typeId: type.id, code: 'b6-emergency', label: '紧急活动' },
    });
    const role = await prisma.dictType.create({ data: { code: 'attendance_role', label: '岗位' } });
    await prisma.dictItem.create({ data: { typeId: role.id, code: 'b6-support', label: '保障' } });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    config.activityResponsibilityWorkflow.enabled = true;
  });
  afterAll(async () => {
    await app.close();
    if (previousGate === undefined) delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousGate;
    if (previousControlMode === undefined) delete process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
    else process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = previousControlMode;
  });

  const input = () => ({
    operationKey: unique('command'),
    title: '紧急呼叫测试',
    organizationId,
    initiatorMemberId: actor.memberId!,
    activityTypeCode: 'b6-emergency',
    allocationModeCode: 'first_come',
    startAt: START,
    endAt: END,
    location: '粗略集合区域',
  });
  const post = (body: object, authorization = auth) =>
    request(httpServer(app))
      .post(`${ROOT}/emergency`)
      .set('Authorization', authorization)
      .send(body);
  async function create() {
    const body = { ...input(), memberIds: [actor.memberId!] };
    const response = await post(body).expect(201);
    return { body, result: (response.body as CreationResponse).data };
  }
  async function counts() {
    return Promise.all([
      prisma.activity.count(),
      prisma.activityCreationCommandReceipt.count(),
      prisma.activityEmergencyInitiation.count(),
      prisma.activityEmergencyFollowUpItem.count(),
      prisma.notificationOutboxIntent.count(),
      prisma.auditLog.count({ where: { event: 'activity.publish' } }),
    ]);
  }

  it('creates only a draft, seven obligations, a scoped emergency call and two minimal audits atomically', async () => {
    const recipients = [await member(organizationId), await member(childId)];
    const body = { ...input(), memberIds: recipients.map((m) => m.id) };
    const before = await counts();
    const response = await post(body).expect(201);
    expect((response.body as CreationResponse).code).toBe(0);
    const result = (response.body as CreationResponse).data;
    const id = result.activity.activityId;
    expect(result).toMatchObject({
      mode: 'emergency',
      replayed: false,
      activity: { createdStatusCode: 'draft' },
    });
    expect((await counts()).map((n, i) => n - before[i])).toEqual([1, 1, 1, 7, 2, 2]);
    expect(await prisma.activity.findUniqueOrThrow({ where: { id } })).toMatchObject({
      statusCode: 'draft',
      publishedAt: null,
    });
    const receipt = await prisma.activityCreationCommandReceipt.findUniqueOrThrow({
      where: { activityId: id },
    });
    expect(receipt.commandCode).toBe('create_emergency');
    const origin = await prisma.activityEmergencyInitiation.findUniqueOrThrow({
      where: { activityId: id },
    });
    expect(origin.creationReceiptId).toBe(receipt.id);
    expect(origin.callQueuedAt).toBeInstanceOf(Date);
    const statuses = Object.fromEntries(
      result.followUpItems.map((item) => [item.itemCode, item.statusCode]),
    );
    expect(statuses).toEqual({
      session: 'pending',
      position: 'pending',
      detailed_location: 'pending',
      equipment: 'unrepresentable',
      attendance: 'pending',
      outcome: 'unrepresentable',
      incident_relation: 'unrepresentable',
    });
    const outbox = await prisma.notificationOutboxIntent.findMany({ where: { aggregateId: id } });
    expect(outbox.map((row) => row.destinationRef).sort()).toEqual(body.memberIds.slice().sort());
    for (const row of outbox) {
      expect(row.destinationType).toBe('member');
      expect(row.payload).toMatchObject({
        notificationTypeCode: 'emergency',
        channels: ['in-app'],
        recipientFreeze: { cohortSize: 2, basisRef: [receipt.requestHash] },
      });
    }
    const audits = await prisma.auditLog.findMany({ where: { resourceId: id } });
    expect(
      audits.map((row) => (row.context as { extra: { operation: string } }).extra.operation).sort(),
    ).toEqual(['create_emergency', 'emergency_call']);
    for (const forbidden of [
      ...body.memberIds,
      body.operationKey,
      body.location,
      'recipientMemberId',
      'signedUrl',
    ]) {
      expect(JSON.stringify(result)).not.toContain(forbidden);
      expect(JSON.stringify(audits)).not.toContain(forbidden);
    }
  });

  it('concurrent retries create one receipt and one frozen outbox cohort; later audience changes do not resend', async () => {
    const recipient = await member(childId);
    const body = { ...input(), memberIds: [recipient.id] };
    const before = await counts();
    const service = app.get(ActivityCreationEmergency);
    const original = service.createDraft.bind(service);
    let arrivals = 0;
    let release!: () => void;
    const bothMissedReceipt = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(service, 'createDraft').mockImplementation(async (...args) => {
      if (++arrivals === 2) release();
      await bothMissedReceipt;
      return original(...args);
    });
    const responses = await Promise.all([post(body), post(body)]);
    expect(arrivals).toBe(2);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const results = responses.map((r) => (r.body as CreationResponse).data);
    expect(results[0].activity).toEqual(results[1].activity);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect((await counts()).map((n, i) => n - before[i])).toEqual([1, 1, 1, 7, 1, 2]);
    await prisma.member.update({ where: { id: recipient.id }, data: { deletedAt: new Date() } });
    const after = await counts();
    const replay = await post(body).expect(201);
    expect((replay.body as CreationResponse).data).toEqual({ ...results[0], replayed: true });
    expect(await counts()).toEqual(after);
    expectBizError(await post({ ...body, title: '不同意图' }), BizCode.BAD_REQUEST);
    expect(await counts()).toEqual(after);
  });

  it('organization mode includes real descendants and filters ended memberships and inactive members', async () => {
    const valid = await member(childId);
    const inactive = await member(childId, MemberStatus.INACTIVE);
    const ended = await member(childId);
    await prisma.memberOrganizationMembership.updateMany({
      where: { memberId: ended.id },
      data: { status: 'ENDED', endedAt: new Date() },
    });
    const response = await post({ ...input(), organizationIds: [organizationId] }).expect(201);
    const outbox = await prisma.notificationOutboxIntent.findMany({
      where: { aggregateId: (response.body as CreationResponse).data.activity.activityId },
    });
    const ids = outbox.map((row) => row.destinationRef);
    expect(ids).toContain(valid.id);
    expect(ids).not.toContain(inactive.id);
    expect(ids).not.toContain(ended.id);
  });

  it.each(['missing', 'both', 'empty'] as const)(
    'rejects %s audience with no partial creation',
    async (kind) => {
      const audience =
        kind === 'both'
          ? { memberIds: [actor.memberId!], organizationIds: [organizationId] }
          : kind === 'empty'
            ? { memberIds: [] }
            : {};
      const before = await counts();
      expectBizError(await post({ ...input(), ...audience }), BizCode.BAD_REQUEST, {
        strictMessage: kind !== 'empty',
      });
      expect(await counts()).toEqual(before);
    },
  );

  it.each(['missing', 'inactive', 'deleted', 'ended', 'future'] as const)(
    'rejects %s explicit recipient without revealing which recipient failed',
    async (kind) => {
      const person = await member(childId);
      let id = person.id;
      if (kind === 'missing') id = 'nonexistent-member-id';
      if (kind === 'inactive')
        await prisma.member.update({ where: { id }, data: { status: MemberStatus.INACTIVE } });
      if (kind === 'deleted')
        await prisma.member.update({ where: { id }, data: { deletedAt: new Date() } });
      if (kind === 'ended')
        await prisma.memberOrganizationMembership.updateMany({
          where: { memberId: id },
          data: { status: 'ENDED', endedAt: new Date() },
        });
      if (kind === 'future')
        await prisma.memberOrganizationMembership.updateMany({
          where: { memberId: id },
          data: { startedAt: new Date('2099-01-01T00:00:00.000Z') },
        });
      const before = await counts();
      expectBizError(
        await post({ ...input(), memberIds: [actor.memberId!, id] }),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(await counts()).toEqual(before);
    },
  );

  it('requires emergency permission even when ordinary creation permission is present', async () => {
    await expect(
      app.get(ActivityAccessService).assertCanOrThrow(ordinary, 'activity.create.record'),
    ).resolves.toBeUndefined();
    const before = await counts();
    expectBizError(
      await post(
        { ...input(), initiatorMemberId: ordinary.memberId, memberIds: [actor.memberId!] },
        ordinaryAuth,
      ),
      BizCode.RBAC_FORBIDDEN,
    );
    expect(await counts()).toEqual(before);
  });

  it('freezer treats authorized organizations as an exact upper bound, including explicit members', async () => {
    const candidate = await member(childId);
    await expect(
      prisma.$transaction((tx) =>
        recipientFreeze.freezeEmergencyCall(tx, {
          activityId: 'new-activity',
          initiationId: 'new-initiation',
          requestHash: 'a'.repeat(64),
          at: new Date(),
          authorizedOrganizationIds: [organizationId],
          memberIds: [candidate.id],
        }),
      ),
    ).rejects.toEqual(new BizException(BizCode.RBAC_FORBIDDEN));
  });

  it.each(['obligations', 'freeze', 'outbox', 'audit'] as const)(
    'rolls everything back when %s fails after its real work',
    async (stage) => {
      const reached: string[] = [];
      const fail = async <T>(work: Promise<T>): Promise<T> => {
        await work;
        reached.push(stage);
        throw new Error('B6 injected rollback');
      };
      if (stage === 'obligations') {
        const original = followUps.createEmergencyFollowUps;
        jest
          .spyOn(followUps, 'createEmergencyFollowUps')
          .mockImplementationOnce((...args) => fail(original(...args)));
      } else if (stage === 'freeze') {
        const original = recipientFreeze.freezeEmergencyCall;
        jest
          .spyOn(recipientFreeze, 'freezeEmergencyCall')
          .mockImplementationOnce((...args) => fail(original(...args)));
      } else if (stage === 'outbox') {
        const service = app.get(ActivityNotificationProducer),
          original = service.enqueueEmergencyCall.bind(service);
        jest
          .spyOn(service, 'enqueueEmergencyCall')
          .mockImplementationOnce((...args) => fail(original(...args)));
      } else {
        const service = app.get(ActivityAuditRecorder),
          original = service.logCreationCommand.bind(service);
        jest
          .spyOn(service, 'logCreationCommand')
          .mockImplementationOnce((...args) => fail(original(...args)));
      }
      const before = await counts();
      await post({ ...input(), memberIds: [actor.memberId!] }).expect(500);
      expect(reached).toEqual([stage]);
      expect(await counts()).toEqual(before);
    },
  );

  it('existing draft commands verify only current facts and deletion reopens obligations', async () => {
    const { body, result } = await create();
    const id = result.activity.activityId;
    const drafts = app.get(ActivityDraftService);
    const session = await drafts.createSession(
      id,
      {
        code: 'one',
        name: '场次',
        startAt: START,
        endAt: END,
        locationText: '明细地点',
        checkInOpenAt: START,
        checkInCloseAt: START,
        checkOutOpenAt: END,
        checkOutCloseAt: END,
        longitude: 120.1,
        latitude: 30.2,
        locationRequired: false,
      },
      actor,
      META,
    );
    const position = await drafts.createPosition(
      id,
      session.sessionId,
      { code: 'one', name: '岗位', attendanceRoleCode: 'b6-support' },
      actor,
      META,
    );
    const read = async () => {
      const response = await post(body).expect(201);
      return Object.fromEntries(
        (response.body as CreationResponse).data.followUpItems.map((item) => [
          item.itemCode,
          item.statusCode,
        ]),
      );
    };
    expect(await read()).toEqual({
      session: 'verified',
      position: 'verified',
      detailed_location: 'verified',
      equipment: 'unrepresentable',
      attendance: 'pending',
      outcome: 'unrepresentable',
      incident_relation: 'unrepresentable',
    });
    await drafts.deletePosition(id, session.sessionId, position.positionId, actor, META);
    await drafts.deleteSession(id, session.sessionId, actor, META);
    expect(await read()).toEqual(
      Object.fromEntries(result.followUpItems.map((item) => [item.itemCode, item.statusCode])),
    );
    const pending = await prisma.activityEmergencyFollowUpItem.findMany({
      where: { emergencyInitiation: { activityId: id }, statusCode: 'pending' },
    });
    for (const item of pending)
      expect(item).toMatchObject({ resolvedAt: null, resolvedByUserId: null });
  });

  it.each(['publish-reviews', 'submit-publish-review', 'direct-publish'])(
    'App %s refuses emergency formal publication with no side effects',
    async (path) => {
      const { result } = await create();
      const id = result.activity.activityId;
      const before = await counts();
      const response = await request(httpServer(app))
        .post(`${ROOT}/${id}/${path}`)
        .set('Authorization', auth)
        .send(
          path === 'publish-reviews' ? { operationKey: unique('publish'), confirmation: true } : {},
        );
      expectBizError(response, BizCode.ACTIVITY_STATUS_INVALID);
      expect(await counts()).toEqual(before);
      expect(await prisma.activityPublishReview.count({ where: { activityId: id } })).toBe(0);
      expect((await prisma.activity.findUniqueOrThrow({ where: { id } })).statusCode).toBe('draft');
    },
  );

  it.each(['publish-reviews', 'submit-publish-review'])(
    'App %s preserves hidden ownership before disclosing emergency origin',
    async (path) => {
      const { result } = await create();
      const response = await request(httpServer(app))
        .post(`${ROOT}/${result.activity.activityId}/${path}`)
        .set('Authorization', otherAuth)
        .send(
          path === 'publish-reviews' ? { operationKey: unique('hidden'), confirmation: true } : {},
        );
      expectBizError(response, BizCode.ACTIVITY_NOT_FOUND);
    },
  );

  it.each([
    [true, 'publish'],
    [true, 'publish-with-audience-tags'],
    [false, 'publish'],
    [false, 'publish-with-audience-tags'],
  ] as const)('Admin workflow=%s %s refuses emergency publication', async (enabled, path) => {
    const { result } = await create();
    const id = result.activity.activityId;
    config.activityResponsibilityWorkflow.enabled = enabled;
    config.activityAudienceTags.httpEnabled = true;
    const before = await counts();
    const response = await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${id}/${path}`)
      .set('Authorization', auth)
      .send({
        requiresInsuranceConfirmed: true,
        ...(path === 'publish-with-audience-tags' ? { audienceTagCodes: [] } : {}),
      });
    expectBizError(response, BizCode.ACTIVITY_STATUS_INVALID);
    expect(await counts()).toEqual(before);
    expect((await prisma.activity.findUniqueOrThrow({ where: { id } })).statusCode).toBe('draft');
  });

  it.each(['legacy', 'v6'] as const)(
    'Admin approval rejects a pre-existing %s review of an emergency draft',
    async (kind) => {
      const { result } = await create();
      const id = result.activity.activityId;
      const snapshot = await prisma.$transaction(async (tx) => {
        await lockActivity(id, tx);
        return kind === 'legacy'
          ? buildProposalSnapshot(id, tx)
          : app.get(ActivityPublishProposalV2Service).buildInitial(tx, id);
      });
      const review = await prisma.activityPublishReview.create({
        data: {
          activityId: id,
          requestType: 'initial',
          requestVersion: 1,
          baseRevision: 0,
          status: 'pending',
          snapshot: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
          submittedByUserId: actor.id,
        },
      });
      const before = await counts();
      const response = await request(httpServer(app))
        .post(`/api/admin/v1/activity-publish-reviews/${review.id}/approve`)
        .set('Authorization', otherAuth)
        .send({ requiresInsuranceConfirmed: true, operationKey: unique('approve') });
      expectBizError(response, BizCode.ACTIVITY_STATUS_INVALID);
      expect(await counts()).toEqual(before);
      expect(
        (await prisma.activityPublishReview.findUniqueOrThrow({ where: { id: review.id } })).status,
      ).toBe('pending');
      expect((await prisma.activity.findUniqueOrThrow({ where: { id } })).statusCode).toBe('draft');
    },
  );

  it('proposal application refuses emergency publication at the final write boundary', async () => {
    const { result } = await create();
    const id = result.activity.activityId;
    const service = app.get(ActivityPublishProposalV2Service);
    const before = await counts();
    await expect(
      prisma.$transaction(async (tx) => {
        await lockActivity(id, tx);
        const snapshot = await service.buildInitial(tx, id);
        return service.apply(tx, id, snapshot, {
          publish: true,
          publishedByUserId: actor.id,
          publishedByUserRole: actor.role,
          at: new Date(),
          versionKey: unique('apply'),
          auditMeta: META,
        });
      }),
    ).rejects.toEqual(new BizException(BizCode.ACTIVITY_STATUS_INVALID));
    expect(await counts()).toEqual(before);
  });
});
