import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import { EvidenceSealService } from '../../src/modules/activities/evidence-seal.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// ===== 活动改造 v1.1 第 2 批第一刀:封场并发(goal DoD 4)=====
//
// 判据:两个并发 `seal(同一 activityId)` **只能成功一个**,且败者以**具名业务码**收场。
//
// ⚠️ 这里刻意**不用** `Promise.all(两个 service 调用)` —— 那是假并发:
//    Node 单线程 + Prisma 交互事务,两条调用极可能先后串行走完,谁都不会真的排队,
//    用例即使在没有任何锁的实现上也会绿(空绿)。
// 真构造 = 两套 Nest / Prisma pool + 第三个事务当**闸门**:先由 blocker 事务把
// Activity 行锁攥住,让 A、B 双双堵在 §5.8 ① 的 `FOR UPDATE` 上(用 pg_stat_activity
// 的 `wait_event_type='Lock'` **正面证明**它们真的在等锁),再放闸。
// 谁先拿到锁不确定,但先到者写下 active seal 之后,后到者在 ⑤-b 必然读到吻合版本。
async function waitForSealLockWaiters(prisma: PrismaService, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  let observed = 0;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ waitingCount: number }>>`
      SELECT count(*)::int AS "waitingCount"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%authoritativeNow%'
    `;
    observed = row?.waitingCount ?? 0;
    if (observed >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `expected at least ${expected} EvidenceSeal Activity row-lock waiter(s), saw ${observed}`,
  );
}

describe('evidence seal multi-instance concurrency', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let serviceA: EvidenceSealService;
  let serviceB: EvidenceSealService;
  let actor: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'evidence-seal-concurrency', ip: null, ua: null };
  const PAST = new Date('2020-03-01T00:00:00.000Z');

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    serviceA = appA.get(EvidenceSealService);
    serviceB = appB.get(EvidenceSealService);

    const user = await createTestUser(appA, {
      username: 'evidence-seal-concurrency-actor',
      role: Role.SUPER_ADMIN,
    });
    actor = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const organization = await prismaA.organization.create({
      data: { name: '封场并发组织', nodeTypeCode: 'evidence-seal-concurrency-team' },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await Promise.all([appA.close(), appB.close()]);
  });

  async function createSealableActivity(): Promise<string> {
    sequence += 1;
    const activity = await prismaA.activity.create({
      data: {
        title: `封场并发活动 ${sequence}`,
        activityTypeCode: 'evidence-seal-concurrency-type',
        organizationId,
        startAt: PAST,
        endAt: new Date(PAST.getTime() + 4 * 3600_000),
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });
    const session = await prismaA.activitySession.create({
      data: {
        activityId: activity.id,
        code: `seal-conc-${sequence}`,
        name: `封场并发场次 ${sequence}`,
        startAt: PAST,
        endAt: new Date(PAST.getTime() + 4 * 3600_000),
        locationText: '深圳',
        checkInOpenAt: new Date(PAST.getTime() - 3600_000),
        checkInCloseAt: new Date(PAST.getTime() + 3600_000),
        checkOutOpenAt: new Date(PAST.getTime() + 2 * 3600_000),
        checkOutCloseAt: new Date('2020-03-01T08:00:00.000Z'),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const member = await prismaA.member.create({
      data: {
        memberNo: `seal-conc-${sequence}`,
        ...memberIdentityData(`并发封场队员 ${sequence}`),
        gradeCode: 'level-2',
      },
      select: { id: true },
    });
    const registration = await prismaA.activityRegistration.create({
      data: { activityId: activity.id, memberId: member.id, statusCode: 'approved' },
      select: { id: true },
    });
    await prismaA.activityParticipationIdentity.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        registrationId: registration.id,
        memberId: member.id,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
    });
    return activity.id;
  }

  it('两套 Nest 实例被同一把 PostgreSQL Activity 行锁串起来 → 恰好一张 active seal', async () => {
    expect(prismaA).not.toBe(prismaB);
    expect(appA.getHttpServer()).not.toBe(appB.getHttpServer());
    const [[backendA], [backendB]] = await Promise.all([
      prismaA.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(backendA?.pid).not.toBe(backendB?.pid);

    const activityId = await createSealableActivity();

    let signalBlockerReady!: () => void;
    let releaseBlocker!: () => void;
    const blockerReady = new Promise<void>((resolve) => {
      signalBlockerReady = resolve;
    });
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = prismaA.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${activityId} FOR UPDATE`;
      signalBlockerReady();
      await blockerRelease;
    });

    await blockerReady;
    const sealA = serviceA.seal(activityId, actor, { ...auditMeta, requestId: 'seal-a' });
    const sealB = serviceB.seal(activityId, actor, { ...auditMeta, requestId: 'seal-b' });

    let barrierError: unknown;
    try {
      await waitForSealLockWaiters(prismaB, 2);
    } catch (error) {
      barrierError = error;
    } finally {
      releaseBlocker();
      await blocker;
    }
    const results = await Promise.allSettled([sealA, sealB]);
    if (barrierError instanceof Error) throw barrierError;
    if (barrierError !== undefined) {
      throw new Error('non-Error value thrown while forcing seal interleaving');
    }

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toBeDefined();
    // 败者必须是**具名业务码**,不是未映射的 500 / P2028。
    expect(rejected?.reason).toBeInstanceOf(BizException);
    expect((rejected?.reason as BizException).biz).toBe(BizCode.EVIDENCE_SEAL_ALREADY_ACTIVE);

    const seals = await prismaA.evidenceSeal.findMany({
      where: { activityId },
      select: { sealRevision: true, statusCode: true },
    });
    expect(seals).toStrictEqual([{ sealRevision: 1, statusCode: 'active' }]);
    // audit 也只该有一条 —— 败者是干净拒绝,不留半张章、不留半条日志。
    await expect(
      prismaA.auditLog.count({ where: { resourceType: 'activity', resourceId: activityId } }),
    ).resolves.toBe(1);
  });
});
