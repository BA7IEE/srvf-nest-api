import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode, type BizCodeEntry } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityDraftService } from '../../src/modules/activities/activity-draft.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * 第 3 批第一刀的独立红测入口。它不复用旧 ActivityPosition 面，所有岗位都必须
 * 经过 ActivitySessionPosition 的嵌套路径。
 */
describe('Activity batch3 slice1 draft foundation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let drafts: ActivityDraftService;
  let organizationId: string;
  let activityTypeCode: string;
  let attendanceRoleCode: string;
  let sequence = 0;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    drafts = app.get(ActivityDraftService);
    await seedActivityResponsibilitySystemRoles(app);

    const root = await prisma.organization.create({
      data: { name: 'B3 Draft Root', nodeTypeCode: 'b3-draft-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: { name: 'B3 Draft Team', nodeTypeCode: 'b3-draft-team', parentId: root.id },
      select: { id: true },
    });
    organizationId = organization.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: organization.id, depth: 1 },
        { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
      ],
    });

    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    activityTypeCode = 'b3-draft-training';
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '草稿训练' },
    });
    const attendanceRole = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    attendanceRoleCode = 'b3-draft-member';
    await prisma.dictItem.create({
      data: { typeId: attendanceRole.id, code: attendanceRoleCode, label: '草稿成员' },
    });
  });

  afterAll(async () => {
    await app.close();
    delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  });

  const WRITE_METHODS = new Set([
    'create',
    'createMany',
    'delete',
    'deleteMany',
    'update',
    'updateMany',
    'upsert',
  ]);
  const REVISION_FIELDS = new Set([
    'currentEvidenceRevision',
    'currentPopulationRevision',
    'currentClosureRevision',
  ]);

  async function createManager(label: string, role: Role = Role.USER) {
    sequence += 1;
    const member = await prisma.member.create({
      data: {
        memberNo: `b3-draft-${label}-${sequence}`,
        displayName: `B3 Draft ${label} ${sequence}`,
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const user = await createTestUser(app, {
      username: `b3-draft-${label}-${sequence}`,
      role,
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId },
    });
    return {
      memberId: member.id,
      userId: user.id,
      auth: (await loginAs(app, user.username)).authHeader,
    };
  }

  /**
   * 第 ⑨a 刀同款 transaction spy：记录的是实际 delegate 写调用中是否携带三枚
   * revision 字段，以及草稿创建是否误碰责任表；不是事后比较行值的弱断言。
   */
  function observeDraftInvariantWrites(
    tx: Prisma.TransactionClient,
    onRevisionWrite: () => void,
    onResponsibilityWrite: () => void,
  ): Prisma.TransactionClient {
    return new Proxy(tx, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'activity' && property !== 'activityResponsibilityAssignment') {
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return new Proxy(value as object, {
          get(delegate, method, delegateReceiver) {
            const methodValue = Reflect.get(delegate, method, delegateReceiver);
            if (typeof method === 'string' && WRITE_METHODS.has(method)) {
              return (...args: unknown[]) => {
                if (property === 'activityResponsibilityAssignment') {
                  onResponsibilityWrite();
                } else {
                  const firstArg = args[0] as { data?: Record<string, unknown> } | undefined;
                  const data = firstArg?.data;
                  if (
                    data !== undefined &&
                    [...REVISION_FIELDS].some((field) =>
                      Object.prototype.hasOwnProperty.call(data, field),
                    )
                  ) {
                    onRevisionWrite();
                  }
                }
                return Reflect.apply(
                  methodValue as (...callArgs: unknown[]) => unknown,
                  delegate,
                  args,
                );
              };
            }
            return typeof methodValue === 'function' ? methodValue.bind(delegate) : methodValue;
          },
        });
      },
    });
  }

  async function countDraftInvariantWrites<T>(operation: () => Promise<T>) {
    type TransactionInvoker = <Result>(
      callback: (tx: Prisma.TransactionClient) => Promise<Result>,
      options?: unknown,
    ) => Promise<Result>;
    const holder = prisma as unknown as { $transaction: TransactionInvoker };
    const original = holder.$transaction;
    const invokeOriginal = original.bind(prisma);
    let revisionWrites = 0;
    let responsibilityWrites = 0;
    holder.$transaction = async <Result>(
      callback: (tx: Prisma.TransactionClient) => Promise<Result>,
      options?: unknown,
    ): Promise<Result> =>
      await invokeOriginal(
        async (tx) =>
          callback(
            observeDraftInvariantWrites(
              tx,
              () => (revisionWrites += 1),
              () => (responsibilityWrites += 1),
            ),
          ),
        options,
      );
    try {
      return {
        result: await operation(),
        revisionWrites,
        responsibilityWrites,
      };
    } finally {
      holder.$transaction = original;
    }
  }

  function draftPayload(title: string) {
    return {
      title,
      activityTypeCode,
      organizationId,
      startAt: '2099-10-01T01:00:00.000Z',
      endAt: '2099-10-01T08:00:00.000Z',
      location: '深圳',
      registrationModeCode: 'open_apply',
      visibilityCode: 'internal',
      defaultLocationRequired: false,
      archiveWaitingDays: 7,
    };
  }

  function sessionPayload() {
    return {
      code: 'morning',
      name: '上午场',
      startAt: '2099-10-01T02:00:00.000Z',
      endAt: '2099-10-01T05:00:00.000Z',
      locationText: '集合点',
      capacity: 12,
      checkInOpenAt: '2099-10-01T01:30:00.000Z',
      checkInCloseAt: '2099-10-01T02:30:00.000Z',
      checkOutOpenAt: '2099-10-01T04:00:00.000Z',
      checkOutCloseAt: '2099-10-01T05:30:00.000Z',
      locationRequired: false,
      radiusMeters: null,
    };
  }

  async function createDraft(
    manager: Awaited<ReturnType<typeof createManager>>,
    title: string,
  ): Promise<string> {
    const response = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', manager.auth)
      .send(draftPayload(title));
    expect(response.status).toBe(201);
    return response.body.data.activity.id as string;
  }

  async function createSession(
    manager: Awaited<ReturnType<typeof createManager>>,
    activityId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    sequence += 1;
    const response = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', manager.auth)
      .send({
        ...sessionPayload(),
        code: `session-${sequence}`,
        name: `草稿场次 ${sequence}`,
        ...overrides,
      });
    expect(response.status).toBe(201);
    return response.body.data.sessionId as string;
  }

  async function createPosition(
    manager: Awaited<ReturnType<typeof createManager>>,
    activityId: string,
    sessionId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    sequence += 1;
    const response = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions`)
      .set('Authorization', manager.auth)
      .send({
        code: `position-${sequence}`,
        name: `草稿岗位 ${sequence}`,
        attendanceRoleCode,
        capacity: 2,
        startAt: '2099-10-01T02:00:00.000Z',
        endAt: '2099-10-01T05:00:00.000Z',
        ...overrides,
      });
    expect(response.status).toBe(201);
    return response.body.data.positionId as string;
  }

  it('red-first: creates a v1.1 draft then manages a session and its new-table position', async () => {
    const manager = await createManager('owner');
    const created = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', manager.auth)
      .send(draftPayload('B3 草稿地基'));

    // 实现前此处应真实 HTTP 红：现有 DTO 不认识 v1.1 草稿字段。
    expect(created.status).toBe(201);
    const activityId = created.body.data.activity.id as string;

    const session = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', manager.auth)
      .send(sessionPayload());
    expect(session.status).toBe(201);
    const sessionId = session.body.data.sessionId as string;

    const position = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions`)
      .set('Authorization', manager.auth)
      .send({
        code: 'guide',
        name: '引导岗',
        attendanceRoleCode,
        capacity: 2,
        startAt: '2099-10-01T02:00:00.000Z',
        endAt: '2099-10-01T05:00:00.000Z',
      });
    expect(position.status).toBe(201);
  });

  it('writes one correctly anchored draft, accepts duplicate submission, and never writes a responsibility row or revision counter', async () => {
    const manager = await createManager('transaction-owner');
    let activityId = '';
    let sessionId = '';
    let positionId = '';
    const observed = await countDraftInvariantWrites(async () => {
      const create = await request(httpServer(app))
        .post('/api/app/v1/my/managed-activities')
        .set('Authorization', manager.auth)
        .send(draftPayload('B3 事务锚定草稿'));
      expect(create.status).toBe(201);
      activityId = create.body.data.activity.id as string;

      const duplicate = await request(httpServer(app))
        .post('/api/app/v1/my/managed-activities')
        .set('Authorization', manager.auth)
        .send(draftPayload('B3 事务锚定草稿'));
      expect(duplicate.status).toBe(201);
      expect(duplicate.body.data.activity.id).not.toBe(activityId);

      const rootPatch = await request(httpServer(app))
        .patch(`/api/app/v1/my/managed-activities/${activityId}`)
        .set('Authorization', manager.auth)
        .send({ title: 'B3 事务锚定草稿（已改）' });
      expect(rootPatch.status).toBe(200);

      sessionId = await createSession(manager, activityId);
      const sessionPatch = await request(httpServer(app))
        .patch(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}`)
        .set('Authorization', manager.auth)
        .send({ name: '草稿场次 已改' });
      expect(sessionPatch.status).toBe(200);

      positionId = await createPosition(manager, activityId, sessionId);
      const positionPatch = await request(httpServer(app))
        .patch(
          `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions/${positionId}`,
        )
        .set('Authorization', manager.auth)
        .send({ name: '草稿岗位 已改' });
      expect(positionPatch.status).toBe(200);

      expect(
        await request(httpServer(app))
          .delete(
            `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions/${positionId}`,
          )
          .set('Authorization', manager.auth),
      ).toHaveProperty('status', 200);
      expect(
        await request(httpServer(app))
          .delete(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}`)
          .set('Authorization', manager.auth),
      ).toHaveProperty('status', 200);
      expect(
        await request(httpServer(app))
          .delete(`/api/app/v1/my/managed-activities/${activityId}`)
          .set('Authorization', manager.auth),
      ).toHaveProperty('status', 200);
    });

    expect(observed.revisionWrites).toBe(0);
    expect(observed.responsibilityWrites).toBe(0);
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: {
          statusCode: true,
          initiatorMemberId: true,
          registrationModeCode: true,
          visibilityCode: true,
          currentEvidenceRevision: true,
          currentPopulationRevision: true,
          currentClosureRevision: true,
        },
      }),
    ).resolves.toEqual({
      statusCode: 'draft',
      initiatorMemberId: manager.memberId,
      registrationModeCode: 'open_apply',
      visibilityCode: 'internal',
      currentEvidenceRevision: 0,
      currentPopulationRevision: 0,
      currentClosureRevision: null,
    });
    await expect(
      prisma.activityResponsibilityAssignment.count({ where: { activityId } }),
    ).resolves.toBe(0);

    // 正对照：注入一次实际 delegate 写调用，两个 spy 都必须恰好命中一次。
    const positive = await countDraftInvariantWrites(
      async () =>
        await prisma.$transaction(async (tx) => {
          await tx.activity.updateMany({
            where: { id: 'b3-nonexistent-revision-probe' },
            data: { currentEvidenceRevision: { increment: 1 } },
          });
          await tx.activityResponsibilityAssignment.updateMany({
            where: { activityId: 'b3-nonexistent-responsibility-probe' },
            data: { endedAt: new Date('2099-01-01T00:00:00.000Z') },
          });
        }),
    );
    expect(positive.revisionWrites).toBe(1);
    expect(positive.responsibilityWrites).toBe(1);
  });

  it('keeps the delegated creator and the real formal initiator distinct while anchoring the draft on the latter', async () => {
    const delegatedCreator = await createManager('delegated-creator', Role.SUPER_ADMIN);
    const realInitiator = await createManager('real-initiator');
    const created = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', delegatedCreator.auth)
      .send({ ...draftPayload('B3 管理员代建'), initiatorMemberId: realInitiator.memberId });
    expect(created.status).toBe(201);
    const activityId = created.body.data.id as string;
    expect(created.body.data.initiatorMemberId).toBe(realInitiator.memberId);
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { resourceType: 'activity', resourceId: activityId, event: 'activity.publish' },
        select: { actorUserId: true },
      }),
    ).resolves.toEqual({ actorUserId: delegatedCreator.userId });
    await expect(
      prisma.activityResponsibilityAssignment.count({ where: { activityId } }),
    ).resolves.toBe(0);
  });

  it('has no operationKey/templateId input and persists closed-set defaults for protected legacy App payloads', async () => {
    const manager = await createManager('dto-boundary');
    const legacyPayload = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', manager.auth)
      .send({
        ...draftPayload('B3 缺 registrationMode'),
        registrationModeCode: undefined,
        visibilityCode: undefined,
        defaultLocationRequired: undefined,
      });
    expect(legacyPayload.status).toBe(201);
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: legacyPayload.body.data.activity.id as string },
        select: { registrationModeCode: true, visibilityCode: true, defaultLocationRequired: true },
      }),
    ).resolves.toEqual({
      registrationModeCode: 'open_apply',
      visibilityCode: 'internal',
      defaultLocationRequired: false,
    });

    const badVisibility = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', manager.auth)
      .send({ ...draftPayload('B3 闭集'), visibilityCode: 'public' });
    expectBizError(badVisibility, BizCode.BAD_REQUEST, { strictMessage: false });

    const nullMode = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', manager.auth)
      .send({ ...draftPayload('B3 空闭集'), registrationModeCode: null });
    expectBizError(nullMode, BizCode.BAD_REQUEST, { strictMessage: false });

    const operationKey = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', manager.auth)
      .send({ ...draftPayload('B3 不收 operationKey'), operationKey: 'must-not-be-accepted' });
    expectBizError(operationKey, BizCode.BAD_REQUEST, { strictMessage: false });

    const templateId = await request(httpServer(app))
      .post('/api/app/v1/my/managed-activities')
      .set('Authorization', manager.auth)
      .send({ ...draftPayload('B3 不收 templateId'), templateId: 'template-not-in-slice' });
    expectBizError(templateId, BizCode.BAD_REQUEST, { strictMessage: false });

    const activityId = await createDraft(manager, 'B3 嵌套不收 operationKey');
    const nestedOperationKey = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', manager.auth)
      .send({ ...sessionPayload(), operationKey: 'must-not-be-accepted' });
    expectBizError(nestedOperationKey, BizCode.BAD_REQUEST, { strictMessage: false });
    const nestedTemplateId = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', manager.auth)
      .send({ ...sessionPayload(), templateId: 'template-not-in-slice' });
    expectBizError(nestedTemplateId, BizCode.BAD_REQUEST, { strictMessage: false });

    const ambiguousEmptyPoint = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', manager.auth)
      .send({ ...sessionPayload(), meetingPoint: '' });
    expectBizError(ambiguousEmptyPoint, BizCode.BAD_REQUEST, { strictMessage: false });

    const locatedSession = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', manager.auth)
      .send({
        ...sessionPayload(),
        code: 'coordinate-private',
        name: '坐标不回传',
        locationRequired: true,
        radiusMeters: 100,
        longitude: 114.0579,
        latitude: 22.5431,
      });
    expect(locatedSession.status).toBe(201);
    expect(locatedSession.body.data).not.toHaveProperty('longitude');
    expect(locatedSession.body.data).not.toHaveProperty('latitude');
  });

  it('uses the literal draft whitelist for every direct write and preserves the published semantic code', async () => {
    const owner = await createManager('published-owner');
    const activityId = await createDraft(owner, 'B3 已发布拒写');
    const sessionId = await createSession(owner, activityId);
    const positionId = await createPosition(owner, activityId, sessionId);
    await prisma.activity.update({ where: { id: activityId }, data: { statusCode: 'published' } });

    const publishedWrites = [
      request(httpServer(app))
        .patch(`/api/app/v1/my/managed-activities/${activityId}`)
        .set('Authorization', owner.auth)
        .send({ title: '不能直改' }),
      request(httpServer(app))
        .patch(`/api/app/v1/my/managed-activities/${activityId}`)
        .set('Authorization', owner.auth)
        .send({ archiveWaitingDays: 999 }),
      request(httpServer(app))
        .delete(`/api/app/v1/my/managed-activities/${activityId}`)
        .set('Authorization', owner.auth),
      request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
        .set('Authorization', owner.auth)
        .send(sessionPayload()),
      request(httpServer(app))
        .patch(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}`)
        .set('Authorization', owner.auth)
        .send({ name: '不能直改场次' }),
      request(httpServer(app))
        .delete(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}`)
        .set('Authorization', owner.auth),
      request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions`)
        .set('Authorization', owner.auth)
        .send({ code: 'published-write', name: '不能新增', attendanceRoleCode }),
      request(httpServer(app))
        .patch(
          `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions/${positionId}`,
        )
        .set('Authorization', owner.auth)
        .send({ name: '不能直改岗位' }),
      request(httpServer(app))
        .delete(
          `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions/${positionId}`,
        )
        .set('Authorization', owner.auth),
    ];
    for (const response of await Promise.all(publishedWrites)) {
      expectBizError(response, BizCode.ACTIVITY_CHANGE_REVIEW_REQUIRED);
    }

    await prisma.activity.update({ where: { id: activityId }, data: { statusCode: 'cancelled' } });
    const cancelledRootPatch = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}`)
      .set('Authorization', owner.auth)
      .send({ description: '已取消活动也不能直改展示字段' });
    expectBizError(cancelledRootPatch, BizCode.ACTIVITY_STATUS_INVALID);

    const cancelledWrite = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', owner.auth)
      .send(sessionPayload());
    expectBizError(cancelledWrite, BizCode.ACTIVITY_STATUS_INVALID);

    await prisma.activity.update({ where: { id: activityId }, data: { statusCode: 'completed' } });
    const completedRootPatch = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityId}`)
      .set('Authorization', owner.auth)
      .send({ description: '已完成活动也不能直改展示字段' });
    expectBizError(completedRootPatch, BizCode.ACTIVITY_STATUS_INVALID);
  });

  it('hides every ownership-chain miss as ACTIVITY_NOT_FOUND and still admits the SUPER_ADMIN fallback', async () => {
    const ownerA = await createManager('chain-a');
    const ownerB = await createManager('chain-b');
    const outsider = await createManager('chain-outsider');
    const superAdmin = await createManager('chain-super', Role.SUPER_ADMIN);
    const activityA = await createDraft(ownerA, 'B3 链 A');
    const sessionA = await createSession(ownerA, activityA);
    const positionA = await createPosition(ownerA, activityA, sessionA);
    const sessionA2 = await createSession(ownerA, activityA);
    const positionA2 = await createPosition(ownerA, activityA, sessionA2);
    const activityB = await createDraft(ownerB, 'B3 链 B');
    const sessionB = await createSession(ownerB, activityB);
    const positionB = await createPosition(ownerB, activityB, sessionB);

    const outsiderRequests = [
      request(httpServer(app))
        .get(`/api/app/v1/my/managed-activities/${activityA}/sessions?page=1&pageSize=10`)
        .set('Authorization', outsider.auth),
      request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityA}/sessions`)
        .set('Authorization', outsider.auth)
        .send(sessionPayload()),
      request(httpServer(app))
        .patch(`/api/app/v1/my/managed-activities/${activityA}`)
        .set('Authorization', outsider.auth)
        .send({ title: '枚举不能见' }),
      request(httpServer(app))
        .delete(`/api/app/v1/my/managed-activities/${activityA}`)
        .set('Authorization', outsider.auth),
    ];
    for (const response of await Promise.all(outsiderRequests)) {
      expectBizError(response, BizCode.ACTIVITY_NOT_FOUND);
    }

    const crossSession = await request(httpServer(app))
      .get(
        `/api/app/v1/my/managed-activities/${activityA}/sessions/${sessionB}/positions?page=1&pageSize=10`,
      )
      .set('Authorization', ownerA.auth);
    expectBizError(crossSession, BizCode.ACTIVITY_NOT_FOUND);

    const crossPosition = await request(httpServer(app))
      .patch(
        `/api/app/v1/my/managed-activities/${activityA}/sessions/${sessionA}/positions/${positionA2}`,
      )
      .set('Authorization', ownerA.auth)
      .send({ name: '不能跨场次' });
    expectBizError(crossPosition, BizCode.ACTIVITY_NOT_FOUND);

    const crossActivityPosition = await request(httpServer(app))
      .patch(
        `/api/app/v1/my/managed-activities/${activityA}/sessions/${sessionA}/positions/${positionB}`,
      )
      .set('Authorization', ownerA.auth)
      .send({ name: '不能跨活动' });
    expectBizError(crossActivityPosition, BizCode.ACTIVITY_NOT_FOUND);

    const ownPositionUnderForeignSession = await request(httpServer(app))
      .delete(
        `/api/app/v1/my/managed-activities/${activityA}/sessions/${sessionB}/positions/${positionA}`,
      )
      .set('Authorization', ownerA.auth);
    expectBizError(ownPositionUnderForeignSession, BizCode.ACTIVITY_NOT_FOUND);

    const superPatch = await request(httpServer(app))
      .patch(`/api/app/v1/my/managed-activities/${activityA}`)
      .set('Authorization', superAdmin.auth)
      .send({ title: 'SUPER_ADMIN 兜底编辑' });
    expect(superPatch.status).toBe(200);
    const superPositionPatch = await request(httpServer(app))
      .patch(
        `/api/app/v1/my/managed-activities/${activityA}/sessions/${sessionA}/positions/${positionA}`,
      )
      .set('Authorization', superAdmin.auth)
      .send({ name: 'SUPER_ADMIN 兜底岗位' });
    expect(superPositionPatch.status).toBe(200);
  });

  it('normalizes every §3.2/§3.3 CHECK and live unique violation to a stable business code', async () => {
    const owner = await createManager('constraint-owner');
    const activityId = await createDraft(owner, 'B3 CHECK 映射');

    async function sessionError(overrides: Record<string, unknown>, code: BizCodeEntry) {
      sequence += 1;
      const response = await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
        .set('Authorization', owner.auth)
        .send({
          ...sessionPayload(),
          code: `invalid-session-${sequence}`,
          name: `非法场次 ${sequence}`,
          ...overrides,
        });
      expectBizError(response, code);
    }

    await sessionError({ capacity: 0 }, BizCode.ACTIVITY_SESSION_CAPACITY_INVALID);
    await sessionError(
      { startAt: '2099-10-01T05:00:00.000Z', endAt: '2099-10-01T05:00:00.000Z' },
      BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID,
    );
    await sessionError(
      { startAt: '2099-10-01T00:00:00.000Z' },
      BizCode.ACTIVITY_SESSION_TIME_RANGE_INVALID,
    );
    await sessionError(
      { checkInOpenAt: '2099-10-01T03:00:00.000Z', checkInCloseAt: '2099-10-01T02:00:00.000Z' },
      BizCode.ACTIVITY_SESSION_WINDOW_INVALID,
    );
    await sessionError(
      { checkOutOpenAt: '2099-10-01T06:00:00.000Z', checkOutCloseAt: '2099-10-01T05:00:00.000Z' },
      BizCode.ACTIVITY_SESSION_WINDOW_INVALID,
    );
    await sessionError(
      { preparationStartAt: '2099-10-01T02:30:00.000Z' },
      BizCode.ACTIVITY_SESSION_WINDOW_INVALID,
    );
    await sessionError({ lateGraceMinutes: 61 }, BizCode.ACTIVITY_SESSION_WINDOW_INVALID);
    await sessionError(
      { longitude: 114.1, latitude: null },
      BizCode.ACTIVITY_SESSION_LOCATION_POLICY_INVALID,
    );
    await sessionError(
      { locationRequired: true, radiusMeters: null },
      BizCode.ACTIVITY_SESSION_LOCATION_POLICY_INVALID,
    );
    await sessionError(
      { locationRequired: false, radiusMeters: 50 },
      BizCode.ACTIVITY_SESSION_LOCATION_POLICY_INVALID,
    );

    const sessionId = await createSession(owner, activityId, {
      code: 'duplicate-session-code',
      name: '重复场次名',
    });
    const duplicateSessionCode = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', owner.auth)
      .send({ ...sessionPayload(), code: 'duplicate-session-code', name: '另一个名字' });
    expectBizError(duplicateSessionCode, BizCode.ACTIVITY_SESSION_CODE_ALREADY_EXISTS);
    const duplicateSessionName = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
      .set('Authorization', owner.auth)
      .send({ ...sessionPayload(), code: 'another-session-code', name: '重复场次名' });
    expectBizError(duplicateSessionName, BizCode.ACTIVITY_SESSION_NAME_ALREADY_EXISTS);

    async function positionError(overrides: Record<string, unknown>, code: BizCodeEntry) {
      sequence += 1;
      const response = await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions`)
        .set('Authorization', owner.auth)
        .send({
          code: `invalid-position-${sequence}`,
          name: `非法岗位 ${sequence}`,
          attendanceRoleCode,
          ...overrides,
        });
      expectBizError(response, code);
    }

    await positionError({ capacity: 0 }, BizCode.ACTIVITY_SESSION_POSITION_CAPACITY_INVALID);
    await positionError(
      { startAt: '2099-10-01T02:00:00.000Z', endAt: null },
      BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID,
    );
    await positionError(
      { startAt: '2099-10-01T05:00:00.000Z', endAt: '2099-10-01T06:00:00.000Z' },
      BizCode.ACTIVITY_SESSION_POSITION_TIME_RANGE_INVALID,
    );
    await positionError(
      { locationRequired: false, radiusMeters: 50 },
      BizCode.ACTIVITY_SESSION_POSITION_LOCATION_POLICY_INVALID,
    );
    await positionError(
      { locationRequired: null, radiusMeters: 49 },
      BizCode.ACTIVITY_SESSION_POSITION_LOCATION_POLICY_INVALID,
    );

    await createPosition(owner, activityId, sessionId, {
      code: 'duplicate-position-code',
      name: '重复岗位名',
    });
    const duplicatePositionCode = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions`)
      .set('Authorization', owner.auth)
      .send({ code: 'duplicate-position-code', name: '另一个岗位', attendanceRoleCode });
    expectBizError(duplicatePositionCode, BizCode.ACTIVITY_SESSION_POSITION_CODE_ALREADY_EXISTS);
    const duplicatePositionName = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions`)
      .set('Authorization', owner.auth)
      .send({ code: 'another-position-code', name: '重复岗位名', attendanceRoleCode });
    expectBizError(duplicatePositionName, BizCode.ACTIVITY_SESSION_POSITION_NAME_ALREADY_EXISTS);
  });

  it('maps a physical PostgreSQL CHECK violation to its stable domain code when prevalidation is bypassed', async () => {
    const owner = await createManager('physical-check-owner');
    const activityId = await createDraft(owner, 'B3 物理 CHECK 映射');
    const validator = drafts as unknown as {
      assertSessionValid: (...args: unknown[]) => void;
    };
    const bypass = jest.spyOn(validator, 'assertSessionValid').mockImplementation(() => undefined);
    try {
      const response = await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
        .set('Authorization', owner.auth)
        .send({ ...sessionPayload(), capacity: 0 });
      expectBizError(response, BizCode.ACTIVITY_SESSION_CAPACITY_INVALID);
    } finally {
      bypass.mockRestore();
    }
  });

  it('soft-deletes nested rows and deletes only fact-free, review-free drafts', async () => {
    const owner = await createManager('delete-owner');
    const nestedActivityId = await createDraft(owner, 'B3 嵌套软删');
    const nestedSessionId = await createSession(owner, nestedActivityId, {
      code: 'reusable-session',
      name: '可复用场次',
    });
    const nestedPositionId = await createPosition(owner, nestedActivityId, nestedSessionId, {
      code: 'reusable-position',
      name: '可复用岗位',
    });
    const deletedPosition = await request(httpServer(app))
      .delete(
        `/api/app/v1/my/managed-activities/${nestedActivityId}/sessions/${nestedSessionId}/positions/${nestedPositionId}`,
      )
      .set('Authorization', owner.auth);
    expect(deletedPosition.status).toBe(200);
    const emptyPositions = await request(httpServer(app))
      .get(
        `/api/app/v1/my/managed-activities/${nestedActivityId}/sessions/${nestedSessionId}/positions?page=1&pageSize=10`,
      )
      .set('Authorization', owner.auth);
    expect(emptyPositions.status).toBe(200);
    expect(emptyPositions.body.data.items).toEqual([]);
    const reusedPosition = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${nestedActivityId}/sessions/${nestedSessionId}/positions`,
      )
      .set('Authorization', owner.auth)
      .send({ code: 'reusable-position', name: '可复用岗位', attendanceRoleCode });
    expect(reusedPosition.status).toBe(201);

    const deletedSession = await request(httpServer(app))
      .delete(`/api/app/v1/my/managed-activities/${nestedActivityId}/sessions/${nestedSessionId}`)
      .set('Authorization', owner.auth);
    expect(deletedSession.status).toBe(200);
    const emptySessions = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${nestedActivityId}/sessions?page=1&pageSize=10`)
      .set('Authorization', owner.auth);
    expect(emptySessions.status).toBe(200);
    expect(emptySessions.body.data.items).toEqual([]);
    const reusedSession = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${nestedActivityId}/sessions`)
      .set('Authorization', owner.auth)
      .send({ ...sessionPayload(), code: 'reusable-session', name: '可复用场次' });
    expect(reusedSession.status).toBe(201);

    const reviewedActivityId = await createDraft(owner, 'B3 审核事实阻删');
    await prisma.activityPublishReview.create({
      data: {
        activityId: reviewedActivityId,
        requestType: 'initial',
        requestVersion: 1,
        baseRevision: 0,
        status: 'pending',
        snapshot: { schemaVersion: 1 },
        submittedByUserId: owner.userId,
      },
    });
    const reviewedDelete = await request(httpServer(app))
      .delete(`/api/app/v1/my/managed-activities/${reviewedActivityId}`)
      .set('Authorization', owner.auth);
    expectBizError(reviewedDelete, BizCode.ACTIVITY_STATUS_INVALID);

    const participatedActivityId = await createDraft(owner, 'B3 参与事实阻删');
    await prisma.activityRegistration.create({
      data: {
        activityId: participatedActivityId,
        memberId: owner.memberId,
        statusCode: 'pending',
      },
    });
    const participatedDelete = await request(httpServer(app))
      .delete(`/api/app/v1/my/managed-activities/${participatedActivityId}`)
      .set('Authorization', owner.auth);
    expectBizError(participatedDelete, BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN);

    const removableActivityId = await createDraft(owner, 'B3 可删草稿');
    const deleted = await request(httpServer(app))
      .delete(`/api/app/v1/my/managed-activities/${removableActivityId}`)
      .set('Authorization', owner.auth);
    expect(deleted.status).toBe(200);
    await expect(
      prisma.activity.findUniqueOrThrow({
        where: { id: removableActivityId },
        select: { deletedAt: true },
      }),
    ).resolves.toEqual({ deletedAt: expect.any(Date) });
    const listAfterDelete = await request(httpServer(app))
      .get('/api/app/v1/my/managed-activities?page=1&pageSize=100')
      .set('Authorization', owner.auth);
    expect(listAfterDelete.status).toBe(200);
    expect(listAfterDelete.body.data.items.map((item: { id: string }) => item.id)).not.toContain(
      removableActivityId,
    );
    const detailAfterDelete = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${removableActivityId}`)
      .set('Authorization', owner.auth);
    expectBizError(detailAfterDelete, BizCode.ACTIVITY_NOT_FOUND);
  });
});
