import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role } from '@prisma/client';
import request from 'supertest';

import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// ===== 第 2 批第 ⑨a 刀：负责人结算工作台 =====
//
// 这份 spec 的红集按不变量拆开：每次变异只应打红自己的集合。尤其 PATCH 的
// `SettlementVersion` 写计数是 transaction client 上的运行时 spy，不以「字段没变」
// 这种易随实现漂移的行为断言代替结构判据。

const SESSION_START = new Date('2020-03-01T00:00:00.000Z');
const SESSION_END = new Date('2020-03-01T04:00:00.000Z');
const SETTLEMENT_DRAFT_UPDATE_EXPECTED_DRAFT_VERSION_MISMATCH = 20119;
const SETTLEMENT_DRAFT_UPDATE_RUN_STATUS_INVALID = 20128;

interface FixtureParticipant {
  identityId: string;
  memberId: string;
  sessionId: string;
  memberNo: string;
}

interface SettlementFixture {
  activityId: string;
  draftVersionId: string;
  draftVersion: number;
  evidenceSealId: string;
  participants: FixtureParticipant[];
  submittedVersionId: string | null;
}

const SETTLEMENT_VERSION_WRITE_METHODS = new Set([
  'create',
  'createMany',
  'delete',
  'deleteMany',
  'update',
  'updateMany',
  'upsert',
]);

function observeSettlementVersionWrites(
  tx: Prisma.TransactionClient,
  onWrite: () => void,
): Prisma.TransactionClient {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === 'attendanceSettlementVersion') {
        return new Proxy(target.attendanceSettlementVersion, {
          get(delegate, method, delegateReceiver) {
            const value = Reflect.get(delegate, method, delegateReceiver);
            if (typeof method === 'string' && SETTLEMENT_VERSION_WRITE_METHODS.has(method)) {
              return (...args: unknown[]) => {
                onWrite();
                return Reflect.apply(value as (...callArgs: unknown[]) => unknown, delegate, args);
              };
            }
            return typeof value === 'function' ? value.bind(delegate) : value;
          },
        });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('第 2 批第 ⑨a 刀 —— App 负责人结算工作台', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let actorAuthHeader: string;
  let actorUserId: string;
  let sequence = 0;

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const organization = await prisma.organization.create({
      data: { name: '第 ⑨a 刀结算工作台组织', nodeTypeCode: 'activity-batch2-9a-team' },
      select: { id: true },
    });
    organizationId = organization.id;

    const actor = await createTestUser(app, {
      username: 'activity-batch2-9a-owner',
      role: Role.SUPER_ADMIN,
    });
    const actorMember = await prisma.member.create({
      data: {
        memberNo: 'activity-batch2-9a-owner-member',
        ...memberIdentityData('第 ⑨a 刀负责人'),
        gradeCode: 'level-2',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: actor.id }, data: { memberId: actorMember.id } });
    actorUserId = actor.id;
    actorAuthHeader = (await loginAs(app, actor.username)).authHeader;
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await app.close();
  });

  async function createSettlementFixture(
    options: {
      runStatus?: string;
      submittedStatus?: 'submitted' | 'returned';
      participants?: ReadonlyArray<{
        sessionKey: string;
        resultCode: string;
        memberNo: string;
        realName: string;
        recognizedServiceHours?: number;
        recognizedContributionPoints?: number;
      }>;
    } = {},
  ): Promise<SettlementFixture> {
    sequence += 1;
    const tag = `batch2-9a-${sequence}`;
    const participants = options.participants ?? [
      {
        sessionKey: 's1',
        resultCode: 'present',
        memberNo: `${tag}-member-1`,
        ...memberIdentityData(`${tag} 队员一`),
      },
    ];

    const activity = await prisma.activity.create({
      data: {
        title: `第 ⑨a 刀结算活动 ${sequence}`,
        activityTypeCode: `${tag}-type`,
        organizationId,
        startAt: SESSION_START,
        endAt: SESSION_END,
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });

    const sessions = new Map<string, string>();
    for (const participant of participants) {
      if (sessions.has(participant.sessionKey)) continue;
      const session = await prisma.activitySession.create({
        data: {
          activityId: activity.id,
          code: `${tag}-${participant.sessionKey}`,
          name: `${tag} ${participant.sessionKey}`,
          startAt: SESSION_START,
          endAt: SESSION_END,
          locationText: '深圳',
          checkInOpenAt: new Date(SESSION_START.getTime() - 3600_000),
          checkInCloseAt: new Date(SESSION_START.getTime() + 3600_000),
          checkOutOpenAt: new Date(SESSION_START.getTime() + 2 * 3600_000),
          checkOutCloseAt: new Date('2020-03-01T08:00:00.000Z'),
          locationRequired: false,
          locationPolicySourceCode: 'session',
          statusCode: 'scheduled',
          sortOrder: sessions.size,
        },
        select: { id: true },
      });
      sessions.set(participant.sessionKey, session.id);
    }

    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: new Date('2020-03-01T08:00:00.000Z'),
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: participants.length,
        populationCountBySession: {},
        contentHash: `${tag}-seal`,
        statusCode: 'active',
        sealedByUserId: actorUserId,
        sealedAt: new Date('2020-03-01T09:00:00.000Z'),
      },
      select: { id: true },
    });

    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        statusCode: options.runStatus ?? 'drafting',
        currentDraftVersion: 1,
        currentSubmittedVersion: options.submittedStatus === undefined ? null : 2,
      },
      select: { id: true },
    });
    const draft = await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: `${tag}-draft`,
        personCount: participants.length,
        sessionParticipationCount: participants.length,
        serviceSegmentCount: 0,
        createdByUserId: actorUserId,
        statusCode: 'draft',
      },
      select: { id: true, version: true },
    });

    const fixtureParticipants: FixtureParticipant[] = [];
    for (const participant of participants) {
      const member = await prisma.member.create({
        data: {
          memberNo: participant.memberNo,
          ...memberIdentityData(participant.realName),
          gradeCode: 'level-2',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      });
      const registration = await prisma.activityRegistration.create({
        data: { activityId: activity.id, memberId: member.id, statusCode: 'approved' },
        select: { id: true },
      });
      const identity = await prisma.activityParticipationIdentity.create({
        data: {
          activityId: activity.id,
          sessionId: sessions.get(participant.sessionKey)!,
          registrationId: registration.id,
          memberId: member.id,
          currentStatusCode: 'pass',
          populationIncluded: true,
        },
        select: { id: true },
      });
      const recognizedServiceHours = participant.recognizedServiceHours ?? 2;
      const recognizedContributionPoints = participant.recognizedContributionPoints ?? 3;
      await prisma.participantSettlementResultRevision.create({
        data: {
          settlementVersionId: draft.id,
          participationIdentityId: identity.id,
          revision: 1,
          resultCode: participant.resultCode,
          recognizedServiceHours,
          recognizedContributionPoints,
          calculatedServiceHours: recognizedServiceHours,
          calculatedContributionPoints: recognizedContributionPoints,
          statusCode: 'draft',
        },
      });
      fixtureParticipants.push({
        identityId: identity.id,
        memberId: member.id,
        sessionId: sessions.get(participant.sessionKey)!,
        memberNo: participant.memberNo,
      });
    }

    const submitted =
      options.submittedStatus === undefined
        ? null
        : await prisma.attendanceSettlementVersion.create({
            data: {
              settlementRunId: run.id,
              version: 2,
              evidenceSealId: seal.id,
              evidenceRevision: 0,
              populationRevision: 0,
              workflowRevision: 0,
              contentHash: `${tag}-submitted`,
              personCount: participants.length,
              sessionParticipationCount: participants.length,
              serviceSegmentCount: 0,
              createdByUserId: actorUserId,
              submittedAt: new Date('2020-03-01T09:30:00.000Z'),
              statusCode: options.submittedStatus,
              returnFromStage: options.submittedStatus === 'returned' ? 'first' : null,
              returnReason: options.submittedStatus === 'returned' ? '请补正明细' : null,
            },
            select: { id: true },
          });

    return {
      activityId: activity.id,
      draftVersionId: draft.id,
      draftVersion: draft.version,
      evidenceSealId: seal.id,
      participants: fixtureParticipants,
      submittedVersionId: submitted?.id ?? null,
    };
  }

  async function countSettlementVersionWrites<T>(
    operation: () => Promise<T>,
  ): Promise<{ result: T; writes: number }> {
    type TransactionInvoker = <Result>(
      callback: (tx: Prisma.TransactionClient) => Promise<Result>,
      options?: unknown,
    ) => Promise<Result>;
    const holder = prisma as unknown as { $transaction: TransactionInvoker };
    const original = holder.$transaction;
    const invokeOriginal = original.bind(prisma);
    let writes = 0;
    holder.$transaction = async <Result>(
      callback: (tx: Prisma.TransactionClient) => Promise<Result>,
      options?: unknown,
    ): Promise<Result> =>
      await invokeOriginal(
        async (tx) => callback(observeSettlementVersionWrites(tx, () => (writes += 1))),
        options,
      );
    try {
      return { result: await operation(), writes };
    } finally {
      holder.$transaction = original;
    }
  }

  function patchDraftItem(
    fixture: SettlementFixture,
    identityId: string,
    expectedDraftVersion = fixture.draftVersion,
  ) {
    return request(httpServer(app))
      .patch(
        `/api/app/v1/my/managed-activities/${fixture.activityId}/settlement/items/${identityId}`,
      )
      .set('Authorization', actorAuthHeader)
      .send({
        expectedDraftVersion,
        resultCode: 'present',
        recognizedServiceHours: 1,
        recognizedContributionPoints: 2,
        reason: '负责人核对后的调整',
      });
  }

  async function createFilterFixture(): Promise<SettlementFixture> {
    const tag = `filter-${sequence + 1}`;
    return await createSettlementFixture({
      participants: [
        {
          sessionKey: 'session-a',
          resultCode: 'present',
          memberNo: `${tag}-session-only`,
          realName: 'Session Filter',
        },
        {
          sessionKey: 'session-b',
          resultCode: 'leave',
          memberNo: `${tag}-result-only`,
          realName: 'Result Filter',
        },
        {
          sessionKey: 'session-c',
          resultCode: 'absent',
          memberNo: `${tag}-query-only`,
          realName: 'Query Filter',
        },
      ],
    });
  }

  it('GET settlement 返回 run、seal、当前版本指针和缺口摘要', async () => {
    const fixture = await createSettlementFixture({ submittedStatus: 'returned' });

    const response = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${fixture.activityId}/settlement`)
      .set('Authorization', actorAuthHeader);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      activityId: fixture.activityId,
      run: { currentDraftVersion: fixture.draftVersion },
      seal: { id: fixture.evidenceSealId, statusCode: 'active' },
      draft: { id: fixture.draftVersionId, statusCode: 'draft' },
      submitted: { id: fixture.submittedVersionId, statusCode: 'returned' },
      posted: null,
      closure: null,
      gaps: expect.any(Array),
    });
  });

  it('PATCH working item 的 transaction 内 SettlementVersion 写次数恒为 0', async () => {
    const fixture = await createSettlementFixture({ submittedStatus: 'submitted' });
    const submittedBefore = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: fixture.submittedVersionId! },
      select: { id: true, statusCode: true, contentHash: true, updatedAt: true },
    });

    const measured = await countSettlementVersionWrites(() =>
      patchDraftItem(fixture, fixture.participants[0].identityId),
    );

    expect(measured.result.status).toBe(200);
    expect(measured.writes).toBe(0);
    await expect(
      prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: fixture.submittedVersionId! },
        select: { id: true, statusCode: true, contentHash: true, updatedAt: true },
      }),
    ).resolves.toEqual(submittedBefore);
  });

  it.each(['submitted', 'posted', 'closed'] as const)(
    'PATCH 在下游态 %s 被明确锁定',
    async (runStatus) => {
      const fixture = await createSettlementFixture({ runStatus });

      const response = await patchDraftItem(fixture, fixture.participants[0].identityId);

      expect(response.status).toBe(409);
      expect(response.body.code).toBe(SETTLEMENT_DRAFT_UPDATE_RUN_STATUS_INVALID);
    },
  );

  it('PATCH 的 expectedDraftVersion 不匹配返回专属 CAS 冲突码', async () => {
    const fixture = await createSettlementFixture();

    const response = await patchDraftItem(
      fixture,
      fixture.participants[0].identityId,
      fixture.draftVersion + 1,
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(SETTLEMENT_DRAFT_UPDATE_EXPECTED_DRAFT_VERSION_MISMATCH);
  });

  it('items 的 session 过滤器只命中 session 红集', async () => {
    const fixture = await createFilterFixture();
    const sessionOnly = fixture.participants[0];

    const response = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${fixture.activityId}/settlement/items`)
      .query({ page: 1, pageSize: 20, session: sessionOnly.sessionId })
      .set('Authorization', actorAuthHeader);

    expect(response.status).toBe(200);
    expect(response.body.data.items.map((item: { identityId: string }) => item.identityId)).toEqual(
      [sessionOnly.identityId],
    );
  });

  it('items 的 result 过滤器只命中 result 红集', async () => {
    const fixture = await createFilterFixture();
    const resultOnly = fixture.participants[1];

    const response = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${fixture.activityId}/settlement/items`)
      .query({ page: 1, pageSize: 20, result: 'leave' })
      .set('Authorization', actorAuthHeader);

    expect(response.status).toBe(200);
    expect(response.body.data.items.map((item: { identityId: string }) => item.identityId)).toEqual(
      [resultOnly.identityId],
    );
  });

  it('items 的 q 过滤器只命中 q 红集', async () => {
    const fixture = await createFilterFixture();
    const queryOnly = fixture.participants[2];

    const response = await request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${fixture.activityId}/settlement/items`)
      .query({ page: 1, pageSize: 20, q: queryOnly.memberNo })
      .set('Authorization', actorAuthHeader);

    expect(response.status).toBe(200);
    expect(response.body.data.items.map((item: { identityId: string }) => item.identityId)).toEqual(
      [queryOnly.identityId],
    );
  });

  it('GET immutable version 返回详情、差异和 seal revisions', async () => {
    const fixture = await createSettlementFixture({ submittedStatus: 'returned' });

    const response = await request(httpServer(app))
      .get(
        `/api/app/v1/my/managed-activities/${fixture.activityId}/settlement/versions/${fixture.submittedVersionId}`,
      )
      .set('Authorization', actorAuthHeader);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      version: { id: fixture.submittedVersionId, statusCode: 'returned' },
      diff: expect.anything(),
      sealRevisions: [expect.objectContaining({ id: fixture.evidenceSealId, sealRevision: 1 })],
    });
  });

  it('resubmit 在 returned 后创建新的 SettlementVersion，而不是复活旧版', async () => {
    const fixture = await createSettlementFixture({ submittedStatus: 'returned' });
    const before = await prisma.attendanceSettlementVersion.count({
      where: { settlementRun: { activityId: fixture.activityId } },
    });

    const response = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${fixture.activityId}/settlement/versions/${fixture.submittedVersionId}/resubmit`,
      )
      .set('Authorization', actorAuthHeader)
      .send({
        operationKey: `batch2-9a-resubmit-${sequence}`,
        expectedDraftVersion: fixture.draftVersion,
        evidenceSealId: fixture.evidenceSealId,
        confirmation: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.data.settlementVersionId).not.toBe(fixture.submittedVersionId);
    await expect(
      prisma.attendanceSettlementVersion.count({
        where: { settlementRun: { activityId: fixture.activityId } },
      }),
    ).resolves.toBe(before + 1);
  });
});
