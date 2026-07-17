import type { INestApplication } from '@nestjs/common';
import { ContributionRuleStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const URL = '/api/system/v1/contribution-rules';
const ACTIVITY_TYPE_CODE = 'cr-concurrency-type';
const ATTENDANCE_ROLE_CODE = 'cr-concurrency-role';

async function waitForTwoBlockedInsertLocks(prisma: PrismaService): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ waitingCount: number }>>`
      SELECT count(*)::int AS "waitingCount"
      FROM pg_locks AS lock
      JOIN pg_class AS relation ON relation.oid = lock.relation
      WHERE relation.relname = 'ContributionRule'
        AND lock.mode = 'RowExclusiveLock'
        AND lock.granted = false
    `;
    if ((row?.waitingCount ?? 0) >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('two ContributionRule INSERT transactions did not reach the shared DB lock');
}

// D-RULE-1 真并发行为锁：两套独立 Nest app / Prisma pool 共用同一派生 app_test_* PostgreSQL。
// 外部 SHARE table lock 只用于测试编排，让两条 HTTP 事务都完成 service 预检查后阻塞在 INSERT；
// 释放锁后必须由 pair partial unique 分流。该测试会杀死：移除 DB unique、把 threshold 重新纳入
// unique、或漏掉 P2002 → 23002 映射中的任一回归。
describe('ContributionRule ACTIVE pair concurrent create', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let adminAuth: string;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);

    const admin = await createTestUser(appA, {
      username: 'cr-concurrency-admin',
      role: Role.ADMIN,
    });
    const seed = await seedRbacPermissionsAndOpsAdmin(appA);
    await grantOpsAdminToUser(appA, admin.id, seed.opsAdminRoleId);
    adminAuth = (await loginAs(appA, 'cr-concurrency-admin')).authHeader;

    const activityType = await prismaA.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    await prismaA.dictItem.create({
      data: { typeId: activityType.id, code: ACTIVITY_TYPE_CODE, label: '并发活动类型' },
    });
    const attendanceRole = await prismaA.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    await prismaA.dictItem.create({
      data: { typeId: attendanceRole.id, code: ATTENDANCE_ROLE_CODE, label: '并发考勤角色' },
    });
  });

  beforeEach(async () => {
    await prismaA.contributionRule.deleteMany({});
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  function createVia(app: INestApplication, durationThreshold: number): request.Test {
    return request(httpServer(app)).post(URL).set('Authorization', adminAuth).send({
      activityTypeCode: ACTIVITY_TYPE_CODE,
      attendanceRoleCode: ATTENDANCE_ROLE_CODE,
      durationThreshold,
      pointsBelow: 1,
      pointsAbove: 2,
    });
  }

  it('两个独立 app 同 pair 不同 threshold 真并发 → 恰一 201 / 一 23002 / DB 恰一 ACTIVE', async () => {
    expect(prismaA).not.toBe(prismaB);
    expect(appA.getHttpServer()).not.toBe(appB.getHttpServer());

    let signalBlockerReady!: () => void;
    let releaseBlocker!: () => void;
    const blockerReady = new Promise<void>((resolve) => {
      signalBlockerReady = resolve;
    });
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = prismaA.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE "ContributionRule" IN SHARE MODE');
      signalBlockerReady();
      await blockerRelease;
    });

    await blockerReady;
    const attempts = Promise.all([createVia(appA, 1), createVia(appB, 2)]);
    let interleavingError: unknown;
    try {
      await waitForTwoBlockedInsertLocks(prismaB);
    } catch (error) {
      interleavingError = error;
    } finally {
      releaseBlocker();
      await blocker;
    }

    const results = await attempts;
    if (interleavingError instanceof Error) throw interleavingError;
    if (interleavingError !== undefined) {
      throw new Error('non-Error value thrown while waiting for the concurrent INSERT lock');
    }
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    const loser = results.find((result) => result.status !== 201);
    expect(loser).toBeDefined();
    expectBizError(loser!, BizCode.CONTRIBUTION_RULE_ACTIVE_DUPLICATE);

    const active = await prismaA.contributionRule.findMany({
      where: {
        activityTypeCode: ACTIVITY_TYPE_CODE,
        attendanceRoleCode: ATTENDANCE_ROLE_CODE,
        status: ContributionRuleStatus.ACTIVE,
        deletedAt: null,
      },
      select: { durationThreshold: true },
    });
    expect(active).toHaveLength(1);
    expect([1, 2]).toContain(Number(active[0].durationThreshold));
  });
});
