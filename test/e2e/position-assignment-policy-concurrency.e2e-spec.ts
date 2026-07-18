import type { INestApplication } from '@nestjs/common';
import { Role, type Prisma } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

async function waitForLockWaiters(prisma: PrismaService, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ waitingCount: number }>>`
      SELECT count(*)::int AS "waitingCount"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
    `;
    if ((row?.waitingCount ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected at least ${expected} PostgreSQL lock waiter(s)`);
}

// D-POSITION-RULE 真并发行为锁：两套独立 Nest app / Prisma pool 共用同一 PostgreSQL。
// 前两例持 SHARE table lock 强制两个 HTTP 请求交错，锁定人数/同人生命周期聚合重算。
// 后两例分别持有未提交的 Position / Rule 配置更新，任命必须在对应 FOR UPDATE 等待，提交后读取
// 更严格新事实并拒绝；两条 barrier 分别杀死单删 Position 锁与单删 Rule 锁的变异。
describe('PositionAssignment policy multi-instance concurrency', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let superAdminAuth: string;
  let organizationId: string;
  let maxPositionId: string;
  let concurrentPositionAId: string;
  let concurrentPositionBId: string;
  let positionBarrierId: string;
  let ruleBarrierId: string;
  let memberSeq = 0;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);

    await createTestUser(appA, {
      username: 'pa-policy-concurrency-su',
      role: Role.SUPER_ADMIN,
    });
    superAdminAuth = (await loginAs(appA, 'pa-policy-concurrency-su')).authHeader;

    const organization = await prismaA.organization.create({
      data: { name: 'PA policy concurrency org', nodeTypeCode: 'rescue-team' },
      select: { id: true },
    });
    organizationId = organization.id;

    const [maxPosition, concurrentA, concurrentB, positionBarrier, ruleBarrier] = await Promise.all(
      [
        prismaA.organizationPosition.create({
          data: {
            code: 'pa-policy-max',
            name: '人数上限职务',
            categoryCode: 'LEADER',
            allowMultiple: true,
            allowConcurrent: true,
          },
          select: { id: true },
        }),
        prismaA.organizationPosition.create({
          data: {
            code: 'pa-policy-concurrent-a',
            name: '兼任限制职务 A',
            categoryCode: 'LEADER',
            allowMultiple: true,
            allowConcurrent: true,
          },
          select: { id: true },
        }),
        prismaA.organizationPosition.create({
          data: {
            code: 'pa-policy-concurrent-b',
            name: '兼任限制职务 B',
            categoryCode: 'DEPUTY',
            allowMultiple: true,
            allowConcurrent: true,
          },
          select: { id: true },
        }),
        prismaA.organizationPosition.create({
          data: {
            code: 'pa-policy-position-barrier',
            name: 'Position 配置锁职务',
            categoryCode: 'STAFF',
            allowMultiple: true,
            allowConcurrent: true,
          },
          select: { id: true },
        }),
        prismaA.organizationPosition.create({
          data: {
            code: 'pa-policy-rule-barrier',
            name: 'Rule 配置锁职务',
            categoryCode: 'STAFF',
            allowMultiple: true,
            allowConcurrent: true,
          },
          select: { id: true },
        }),
      ],
    );
    maxPositionId = maxPosition.id;
    concurrentPositionAId = concurrentA.id;
    concurrentPositionBId = concurrentB.id;
    positionBarrierId = positionBarrier.id;
    ruleBarrierId = ruleBarrier.id;

    await prismaA.organizationPositionRule.createMany({
      data: [
        {
          nodeTypeCode: 'rescue-team',
          positionId: maxPositionId,
          requireMembership: false,
          maxCount: 1,
        },
        {
          nodeTypeCode: 'rescue-team',
          positionId: concurrentPositionAId,
          requireMembership: false,
          allowConcurrent: false,
        },
        {
          nodeTypeCode: 'rescue-team',
          positionId: concurrentPositionBId,
          requireMembership: false,
          allowConcurrent: false,
        },
        {
          nodeTypeCode: 'rescue-team',
          positionId: positionBarrierId,
          requireMembership: false,
        },
        {
          nodeTypeCode: 'rescue-team',
          positionId: ruleBarrierId,
          requireMembership: false,
        },
      ],
    });
  });

  beforeEach(async () => {
    await prismaA.organizationPositionAssignment.deleteMany({});
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  async function newMember(tag: string): Promise<string> {
    memberSeq += 1;
    const member = await prismaA.member.create({
      data: {
        memberNo: `pa-policy-${tag}-${memberSeq}`,
        displayName: `PA policy ${tag} ${memberSeq}`,
      },
      select: { id: true },
    });
    return member.id;
  }

  function appoint(app: INestApplication, positionId: string, memberId: string): request.Test {
    return request(httpServer(app))
      .post(`/api/admin/v1/organizations/${organizationId}/position-assignments`)
      .set('Authorization', superAdminAuth)
      .send({
        positionId,
        memberId,
        startedAt: '2026-07-18T00:00:00.000Z',
      });
  }

  async function forceInterleaving(first: () => request.Test, second: () => request.Test) {
    let signalBlockerReady!: () => void;
    let releaseBlocker!: () => void;
    const blockerReady = new Promise<void>((resolve) => {
      signalBlockerReady = resolve;
    });
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = prismaA.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "organization_position_assignments" IN SHARE MODE');
      signalBlockerReady();
      await blockerRelease;
    });

    await blockerReady;
    const firstAttempt = Promise.all([first()]).then(([response]) => response);
    let secondAttempt: Promise<request.Response> | undefined;
    let interleavingError: unknown;
    try {
      await waitForLockWaiters(prismaB, 1);
      secondAttempt = Promise.all([second()]).then(([response]) => response);
      await waitForLockWaiters(prismaB, 2);
    } catch (error) {
      interleavingError = error;
    } finally {
      releaseBlocker();
      await blocker;
    }

    const firstResult = await firstAttempt;
    const secondResult = secondAttempt ? await secondAttempt : undefined;
    if (interleavingError instanceof Error) throw interleavingError;
    if (interleavingError !== undefined) {
      throw new Error('non-Error value thrown while forcing assignment interleaving');
    }
    if (!secondResult) throw new Error('second assignment request did not start');
    return [firstResult, secondResult] as const;
  }

  async function forceConfigUpdateInterleaving(
    update: (tx: Prisma.TransactionClient) => Promise<void>,
    attempt: () => request.Test,
  ): Promise<request.Response> {
    let signalUpdateReady!: () => void;
    let releaseUpdate!: () => void;
    const updateReady = new Promise<void>((resolve) => {
      signalUpdateReady = resolve;
    });
    const updateRelease = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const blocker = prismaA.$transaction(async (tx) => {
      await update(tx);
      signalUpdateReady();
      await updateRelease;
    });

    await updateReady;
    const attemptPromise = Promise.all([attempt()]).then(([response]) => response);
    let interleavingError: unknown;
    try {
      await waitForLockWaiters(prismaB, 1);
    } catch (error) {
      interleavingError = error;
    } finally {
      releaseUpdate();
      await blocker;
    }

    const response = await attemptPromise;
    if (interleavingError instanceof Error) throw interleavingError;
    if (interleavingError !== undefined) {
      throw new Error('non-Error value thrown while forcing config update interleaving');
    }
    return response;
  }

  // 杀死“maxCount 只做 count 后裸写”与“只锁 Member、不锁 Position aggregate”的变异。
  it('两个 app 不同成员抢 maxCount=1 → 恰一成功，DB 恰一 active', async () => {
    expect(prismaA).not.toBe(prismaB);
    expect(appA.getHttpServer()).not.toBe(appB.getHttpServer());
    const [memberA, memberB] = await Promise.all([newMember('max-a'), newMember('max-b')]);

    const results = await forceInterleaving(
      () => appoint(appA, maxPositionId, memberA),
      () => appoint(appB, maxPositionId, memberB),
    );

    expect(results.filter(({ status }) => status === 201)).toHaveLength(1);
    const loser = results.find(({ status }) => status !== 201);
    expect(loser).toBeDefined();
    expectBizError(loser!, BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER);
    await expect(
      prismaA.organizationPositionAssignment.count({
        where: {
          organizationId,
          positionId: maxPositionId,
          status: 'ACTIVE',
          deletedAt: null,
        },
      }),
    ).resolves.toBe(1);
  });

  // 杀死“Rule.allowConcurrent 未执行”与“同 Member 两请求未在生命周期锁后重算”的变异。
  it('两个 app 为同一成员并发任两个 rule 禁兼任职务 → 恰一成功', async () => {
    const memberId = await newMember('concurrent');

    const results = await forceInterleaving(
      () => appoint(appA, concurrentPositionAId, memberId),
      () => appoint(appB, concurrentPositionBId, memberId),
    );

    expect(results.filter(({ status }) => status === 201)).toHaveLength(1);
    const loser = results.find(({ status }) => status !== 201);
    expect(loser).toBeDefined();
    expectBizError(loser!, BizCode.POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN);
    await expect(
      prismaA.organizationPositionAssignment.count({
        where: { memberId, status: 'ACTIVE', deletedAt: null },
      }),
    ).resolves.toBe(1);
  });

  // 杀死“单删 Position FOR UPDATE，仍被 Rule 锁掩盖”的变异：这里只持有 Position 更新锁。
  it('Position 收紧 allowMultiple 与任命交错 → 任命等待提交并按新上限拒绝', async () => {
    const holderId = await newMember('position-barrier-holder');
    const challengerId = await newMember('position-barrier-challenger');
    const first = await appoint(appA, positionBarrierId, holderId);
    expect(first.status).toBe(201);

    const result = await forceConfigUpdateInterleaving(
      async (tx) => {
        await tx.organizationPosition.update({
          where: { id: positionBarrierId },
          data: { allowMultiple: false },
        });
      },
      () => appoint(appB, positionBarrierId, challengerId),
    );

    expectBizError(result, BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER);
    await expect(
      prismaA.organizationPositionAssignment.count({
        where: {
          organizationId,
          positionId: positionBarrierId,
          status: 'ACTIVE',
          deletedAt: null,
        },
      }),
    ).resolves.toBe(1);
  });

  // 杀死“单删 Rule FOR UPDATE，仍被 Position 锁掩盖”的变异：这里只持有 Rule 更新锁。
  it('Rule 收紧 maxCount 与任命交错 → 任命等待提交并按新上限拒绝', async () => {
    const holderId = await newMember('rule-barrier-holder');
    const challengerId = await newMember('rule-barrier-challenger');
    const first = await appoint(appA, ruleBarrierId, holderId);
    expect(first.status).toBe(201);

    const result = await forceConfigUpdateInterleaving(
      async (tx) => {
        await tx.organizationPositionRule.updateMany({
          where: { nodeTypeCode: 'rescue-team', positionId: ruleBarrierId },
          data: { maxCount: 1 },
        });
      },
      () => appoint(appB, ruleBarrierId, challengerId),
    );

    expectBizError(result, BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER);
    await expect(
      prismaA.organizationPositionAssignment.count({
        where: {
          organizationId,
          positionId: ruleBarrierId,
          status: 'ACTIVE',
          deletedAt: null,
        },
      }),
    ).resolves.toBe(1);
  });
});
