import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 并发审计 K4(B-F3):`cancelMy` 用**锁前**的活动快照写 durable intent。
//
// 取消 pass 报名会先取 Activity 根锁,但活动标题/发布人是在取锁**之前**读的。
// 并发的活动改名先提交后,本事务醒来照旧用旧标题落 intent —— 通知一旦落库,
// worker 没有任何办法把正确快照找回来;同一次取消甚至能同时产出「旧标题的取消通知」
// 与「新标题的候补递补通知」(递补 helper 是锁后复读的),两条自相矛盾。
//
// 这条不需要猜时序:取消 pass 报名必经 Activity `FOR UPDATE`,blocker 占住它,
// 改名就发生在被测事务的「读」与「写 intent」之间 —— 修复前后都停在同一个点。

const META: AuditMeta = {
  requestId: 'registration-cancel-my-locked-snapshot',
  ip: '127.0.0.1',
  ua: 'jest/registration-cancel-my-locked-snapshot',
};
const LOCK_WAIT_TIMEOUT_MS = 3_000;
const CASE_TIMEOUT_MS = 60_000;
const OLD_TITLE = '周末巡山(旧标题)';
const NEW_TITLE = '周末巡山(改名后)';

describe('cancelMy 锁后快照并发(K4 · B-F3)', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let registrationsB: ActivityRegistrationsService;
  let publisherMemberId: string;
  let publisherUserId: string;
  let organizationId: string;
  let seq = 0;

  async function countActivityRowLockWaiters(): Promise<number> {
    const [row] = await prismaB.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FROM "Activity"%FOR UPDATE%'
    `);
    return row?.n ?? 0;
  }

  /** 占住 Activity 行锁 → 放行后**在同一事务内**改名并提交,让被测事务醒来时看到新值。 */
  function renameAfterLock(activityId: string): {
    ready: Promise<void>;
    release: () => void;
    done: Promise<void>;
  } {
    let signalReady!: () => void;
    let doRelease!: () => void;
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      doRelease = resolve;
    });
    const done = prismaA.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${activityId} FOR UPDATE`;
        signalReady();
        await gate;
        await tx.$executeRaw`UPDATE "Activity" SET "title" = ${NEW_TITLE} WHERE id = ${activityId}`;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );
    return { ready, release: () => doRelease(), done };
  }

  async function seedCase(): Promise<{
    activityId: string;
    registrationId: string;
    member: CurrentUserPayload;
  }> {
    seq += 1;
    const member = await prismaA.member.create({
      data: {
        memberNo: `RCM${String(seq).padStart(3, '0')}`,
        displayName: `取消并发${seq}`,
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const user = await prismaA.user.create({
      data: {
        username: `rcm-member-${seq}`,
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: member.id,
      },
      select: { id: true, username: true },
    });
    const activity = await prismaA.activity.create({
      data: {
        title: OLD_TITLE,
        activityTypeCode: 'rcm-act',
        organizationId,
        startAt: new Date('2099-12-01T01:00:00.000Z'),
        endAt: new Date('2099-12-01T05:00:00.000Z'),
        location: '深圳',
        statusCode: 'published',
        isPublicRegistration: true,
        publishedBy: publisherUserId,
      },
      select: { id: true },
    });
    const registration = await prismaA.activityRegistration.create({
      data: { activityId: activity.id, memberId: member.id, statusCode: 'pass' },
      select: { id: true },
    });
    return {
      activityId: activity.id,
      registrationId: registration.id,
      member: {
        id: user.id,
        username: user.username,
        role: Role.USER,
        status: UserStatus.ACTIVE,
        memberId: member.id,
      },
    };
  }

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    registrationsB = appB.get(ActivityRegistrationsService);

    organizationId = (
      await prismaA.organization.create({
        data: { name: 'RCM Org', nodeTypeCode: 'rcm-node' },
        select: { id: true },
      })
    ).id;
    const publisherMember = await prismaA.member.create({
      data: { memberNo: 'RCM-OWNER', displayName: '活动发布人', status: MemberStatus.ACTIVE },
      select: { id: true },
    });
    publisherMemberId = publisherMember.id;
    const publisherUser = await prismaA.user.create({
      data: {
        username: 'rcm-publisher',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.ADMIN,
        status: UserStatus.ACTIVE,
        memberId: publisherMember.id,
      },
      select: { id: true },
    });
    publisherUserId = publisherUser.id;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  it('两个 app 确实是两条独立连接(否则下面的锁等待全是自欺)', async () => {
    expect(prismaA).not.toBe(prismaB);
    const [[a], [b]] = await Promise.all([
      prismaA.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
      prismaB.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`,
    ]);
    expect(a?.pid).not.toBe(b?.pid);
  });

  it(
    '取消 pass 报名 vs 活动改名:durable intent 必须写锁后的标题,不能写锁前快照',
    async () => {
      const { activityId, registrationId, member } = await seedCase();

      const barrier = renameAfterLock(activityId);
      await barrier.ready;

      const cancelling = registrationsB.cancelMy(
        registrationId,
        { cancelReason: '临时有事' },
        member,
        META,
      );
      cancelling.catch(() => undefined);
      try {
        const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
        let waiters = 0;
        while (Date.now() < deadline && waiters === 0) {
          waiters = await countActivityRowLockWaiters();
          if (waiters === 0) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        // 取消 pass 报名必经 Activity FOR UPDATE —— 等不到就是前提不成立,先让它红。
        expect(waiters).toBeGreaterThanOrEqual(1);
      } finally {
        barrier.release();
        await barrier.done;
      }
      await cancelling;

      const intents = await prismaA.notificationOutboxIntent.findMany({
        where: { aggregateId: registrationId, destinationRef: publisherMemberId },
        select: { eventKey: true, payload: true },
      });
      expect(intents).toHaveLength(1);
      const payload = intents[0].payload as { body?: string };
      // 修复前:标题在取锁**之前**读,改名提交后本事务照旧用旧值落 intent。
      expect(payload.body).toContain(NEW_TITLE);
      expect(payload.body).not.toContain(OLD_TITLE);

      expect(
        (
          await prismaA.activityRegistration.findUniqueOrThrow({
            where: { id: registrationId },
            select: { statusCode: true },
          })
        ).statusCode,
      ).toBe('cancelled');
    },
    CASE_TIMEOUT_MS,
  );
});
