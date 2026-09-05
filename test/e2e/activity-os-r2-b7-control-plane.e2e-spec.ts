import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Role } from '@prisma/client';
import request from 'supertest';
import appConfig from '../../src/config/app.config';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { computeActivityTemplateDefinitionHash } from '../../src/modules/activities/activity-template-definition';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const ROOT = '/api/app/v1/my/managed-activities';
const START = '2099-09-01T08:00:00.000Z';
const END = '2099-09-01T12:00:00.000Z';
type Created = {
  code: number;
  data: {
    activity: { activityId: string; createdStatusCode: string };
    mode: string;
    replayed: boolean;
  };
};

describe.each([
  ['off', 'unavailable'],
  ['shadow', 'pilot'],
  ['active', 'enabled'],
] as const)('B7 %s: real HTTP and PostgreSQL', (mode, availability) => {
  let app: INestApplication;
  let prisma: PrismaService;
  let config: ConfigType<typeof appConfig>;
  let auth: string;
  let plainAuth: string;
  let noMemberAuth: string;
  let memberId: string;
  let plainMemberId: string;
  let organizationId: string;
  let templateVersionId: string;
  let sequence = 0;
  const previousResponsibility = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  const previousMode = process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
  const unique = (label: string) => `b7-${mode}-${label}-${++sequence}`;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = mode;
    app = await createTestApp();
    prisma = app.get(PrismaService);
    config = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
    await resetDb(app);
    const root = await prisma.organization.create({
      data: { name: unique('root'), nodeTypeCode: 'root' },
    });
    const org = await prisma.organization.create({
      data: { name: unique('org'), nodeTypeCode: 'team', parentId: root.id },
    });
    organizationId = org.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: org.id, depth: 1 },
        { ancestorId: org.id, descendantId: org.id, depth: 0 },
      ],
    });
    async function account(role: Role, linked: boolean) {
      const user = await createTestUser(app, { username: unique('user'), role });
      let id = '';
      if (linked) {
        const member = await prisma.member.create({
          data: {
            memberNo: unique('member'),
            ...memberIdentityData('B7 测试成员'),
            gradeCode: 'level-3',
          },
        });
        id = member.id;
        await prisma.user.update({ where: { id: user.id }, data: { memberId: id } });
        await prisma.memberOrganizationMembership.create({
          data: { memberId: id, organizationId },
        });
      }
      return { auth: (await loginAs(app, user.username)).authHeader, memberId: id };
    }
    const operator = await account(Role.SUPER_ADMIN, true);
    auth = operator.auth;
    memberId = operator.memberId;
    const plain = await account(Role.USER, true);
    plainAuth = plain.auth;
    plainMemberId = plain.memberId;
    noMemberAuth = (await account(Role.SUPER_ADMIN, false)).auth;
    const type = await prisma.dictType.create({ data: { code: 'activity_type', label: '类型' } });
    await prisma.dictItem.create({ data: { typeId: type.id, code: 'b7-training', label: '训练' } });
    const definition = {
      activity: { allocationModeCode: 'first_come', capacity: 10 },
      sessions: [
        {
          code: 'morning',
          name: '上午',
          startOffsetMinutes: 0,
          endOffsetMinutes: 120,
          locationText: '模板集合点',
          capacity: 10,
          checkInOpenOffsetMinutes: 0,
          checkInCloseOffsetMinutes: 30,
          checkOutOpenOffsetMinutes: -30,
          checkOutCloseOffsetMinutes: 0,
          locationRequired: false,
          lateGraceMinutes: 10,
          earlyLeaveThresholdMinutes: 10,
          sortOrder: 0,
          positions: [],
        },
      ],
    };
    const family = await prisma.activityTemplateFamily.create({
      data: {
        code: unique('family'),
        name: 'B7 模板族',
        categoryCode: 'training',
        scopeTypeCode: 'organization',
        statusCode: 'inventory',
      },
    });
    const template = await prisma.activityTemplate.create({
      data: {
        code: unique('template'),
        name: 'B7 模板',
        activityTypeCode: 'b7-training',
        version: 1,
        familyId: family.id,
        statusCode: 'draft',
        schemaVersion: 1,
        definitionJson: definition,
        definitionHash: computeActivityTemplateDefinitionHash({ schemaVersion: 1, definition }),
        effectiveFrom: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    await prisma.activityTemplate.update({
      where: { id: template.id },
      data: { statusCode: 'active' },
    });
    templateVersionId = template.id;
  });
  afterEach(() => {
    config.activityOsControlPlane.mode = mode;
    config.activityResponsibilityWorkflow.enabled = true;
  });
  afterAll(async () => {
    if (app) await app.close();
    if (previousResponsibility === undefined)
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousResponsibility;
    if (previousMode === undefined) delete process.env.ACTIVITY_OS_CONTROL_PLANE_MODE;
    else process.env.ACTIVITY_OS_CONTROL_PLANE_MODE = previousMode;
  });

  function base() {
    return {
      operationKey: unique('operation'),
      title: 'B7 创建',
      organizationId,
      startAt: START,
      endAt: END,
      location: '粗略集合点',
    };
  }
  function input(path: string) {
    if (path === 'from-template')
      return { ...base(), templateVersionId, defaultPlaceVisibilityCode: 'staff' };
    if (path === 'emergency')
      return {
        ...base(),
        initiatorMemberId: memberId,
        activityTypeCode: 'b7-training',
        allocationModeCode: 'first_come',
        memberIds: [memberId],
      };
    return {
      ...base(),
      activityTypeCode: 'b7-training',
      allocationModeCode: 'first_come',
      sessions: [
        {
          session: {
            code: 'morning',
            name: '上午',
            startAt: START,
            endAt: END,
            locationText: '集合点',
            checkInOpenAt: START,
            checkInCloseAt: START,
            checkOutOpenAt: END,
            checkOutCloseAt: END,
            locationRequired: false,
          },
          positions: [],
        },
      ],
    };
  }
  const post = (path: string, body: object, authorization = auth) =>
    request(httpServer(app)).post(`${ROOT}/${path}`).set('Authorization', authorization).send(body);
  const status = (authorization = plainAuth) =>
    request(httpServer(app))
      .get(`${ROOT}/control-plane/status`)
      .set('Authorization', authorization);
  async function counts() {
    return Promise.all([
      prisma.activity.count(),
      prisma.activitySession.count(),
      prisma.activitySessionPosition.count(),
      prisma.activityPlace.count(),
      prisma.registrationFormVersion.count(),
      prisma.activityQualificationRuleSet.count(),
      prisma.activityCreationCommandReceipt.count(),
      prisma.activityEmergencyInitiation.count(),
      prisma.activityEmergencyFollowUpItem.count(),
      prisma.auditLog.count({ where: { event: 'activity.publish' } }),
      prisma.notificationOutboxIntent.count(),
      prisma.participationLedgerEntry.count(),
      prisma.activityPublishReview.count(),
    ]);
  }

  it('status requires only live App membership, exposes exactly two fields and makes no business writes', async () => {
    const before = await counts();
    const response = await status().expect(200);
    expect(response.body).toEqual({
      code: 0,
      message: 'ok',
      data: {
        mode,
        creationAvailability: availability,
      },
    });
    expect(await counts()).toEqual(before);
    config.activityResponsibilityWorkflow.enabled = false;
    expect((await status().expect(200)).body).toEqual(response.body);
    expectBizError(await status(noMemberAuth), BizCode.FORBIDDEN);
    await request(httpServer(app)).get(`${ROOT}/control-plane/status`).expect(401);
  });

  it('membership changes take effect on the next status request', async () => {
    await status().expect(200);
    await prisma.member.update({ where: { id: plainMemberId }, data: { status: 'INACTIVE' } });
    try {
      expectBizError(await status(), BizCode.FORBIDDEN);
    } finally {
      await prisma.member.update({ where: { id: plainMemberId }, data: { status: 'ACTIVE' } });
    }
  });

  it.each(['from-template', 'professional', 'emergency'])(
    '%s retains original permission denial',
    async (path) => {
      const before = await counts();
      expectBizError(await post(path, input(path), plainAuth), BizCode.RBAC_FORBIDDEN);
      expect(await counts()).toEqual(before);
    },
  );

  it.each(['from-template', 'professional', 'emergency'])(
    '%s retains responsibility gate refusal',
    async (path) => {
      config.activityResponsibilityWorkflow.enabled = false;
      const before = await counts();
      expectBizError(await post(path, input(path)), BizCode.ACTIVITY_STATUS_INVALID);
      expect(await counts()).toEqual(before);
    },
  );

  it.each(['from-template', 'professional', 'emergency'])(
    '%s enforces mode before writes and preserves draft replay',
    async (path) => {
      const body = input(path);
      const before = await counts();
      if (mode === 'off') {
        expectBizError(await post(path, body), BizCode.ACTIVITY_CONTROL_PLANE_UNAVAILABLE);
        expect(await counts()).toEqual(before);
        return;
      }
      const response = await post(path, body).expect(201);
      const created = (response.body as Created).data;
      const id = created.activity.activityId;
      expect((response.body as Created).code).toBe(0);
      expect(created.activity.createdStatusCode).toBe('draft');
      expect(await prisma.activity.findUniqueOrThrow({ where: { id } })).toMatchObject({
        statusCode: 'draft',
        publishedAt: null,
      });
      const after = await counts();
      expect(after[0] - before[0]).toBe(1);
      expect(after.slice(-2)).toEqual(before.slice(-2)); // no ledger or publish review
      if (path === 'emergency') {
        expect(after[6] - before[6]).toBe(1);
        expect(after[7] - before[7]).toBe(1);
        expect(after[8] - before[8]).toBe(7);
        expect(after[9] - before[9]).toBe(2);
        expect(after[10] - before[10]).toBe(1);
        expectBizError(await post(`${id}/direct-publish`, {}), BizCode.ACTIVITY_STATUS_INVALID);
      }
      const replay = await post(path, body).expect(201);
      expect((replay.body as Created).data).toMatchObject({
        activity: created.activity,
        replayed: true,
      });
      expect(await counts()).toEqual(after);
      config.activityOsControlPlane.mode = 'off';
      expectBizError(await post(path, body), BizCode.ACTIVITY_CONTROL_PLANE_UNAVAILABLE);
      expect(await counts()).toEqual(after);
    },
  );

  it('the legacy generic draft creation and its detail remain available with B7 off', async () => {
    config.activityOsControlPlane.mode = 'off';
    const response = await request(httpServer(app))
      .post(ROOT)
      .set('Authorization', auth)
      .send({
        title: '原有泛化创建',
        organizationId,
        activityTypeCode: 'b7-training',
        startAt: START,
        endAt: END,
        location: '原集合点',
        allocationModeCode: 'first_come',
      })
      .expect(201);
    const id = (response.body as { data: { activity: { id: string } } }).data.activity.id;
    expect(typeof id).toBe('string');
    await request(httpServer(app)).get(`${ROOT}/${id}`).set('Authorization', auth).expect(200);
  });
});
