import type { INestApplication } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 招新三期(入队)T3 App 自助面 e2e(冻结评审稿 docs/archive/reviews/recruitment-phase3-review.md §7)。
// 覆盖:准入(unlinked/INACTIVE → 403)/ 发起申请(open 轮 + 未入队 + 候选 org 存在 ACTIVE + 防重)/
// 查进度(self-scope,gate 实况 + 实时贡献值)/ 改候选部门(仅本人 + joining 态)/ audit submit + update-targets。

const APPS = '/api/app/v1/me/team-join/applications';
const CURRENT = '/api/app/v1/me/team-join/applications/current';
const CYCLE_YEAR = 2026;
const BEFORE_CUTOFF = new Date('2026-01-15T00:00:00Z');
const LOCK_OBSERVE_TIMEOUT_MS = 4_000;
const HTTP_TIMEOUT_MS = 8_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const BLOCKER_TIMEOUT_MS = 20_000;

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settleAllWithTimeout(promises: Promise<unknown>[], label: string): Promise<void> {
  const results = await withTimeout(Promise.allSettled(promises), label, CLEANUP_TIMEOUT_MS);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (rejected) throw rejected.reason;
}

function preservePrimaryFailure(primary: unknown, cleanup: unknown): void {
  if (primary instanceof Error) {
    Object.defineProperty(primary, 'cause', { value: cleanup, configurable: true });
  }
}

function throwFailure(failure: unknown): never {
  if (failure instanceof Error) throw failure;
  throw new Error('non-Error test failure', { cause: failure });
}

interface LinkedUser {
  userId: string;
  memberId: string;
  authHeader: string;
}

describe('招新三期(入队)App 自助面 e2e', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let prismaB: PrismaService;
  let volA: LinkedUser;
  let volB: LinkedUser;
  let unlinkedAuth: string;
  let inactiveAuth: string;
  let adminAuth: string;
  let orgSeq = 0;

  async function makeLinked(
    username: string,
    memberStatus: 'ACTIVE' | 'INACTIVE',
  ): Promise<LinkedUser> {
    const user = await createTestUser(app, { username, role: Role.USER });
    const member = await prisma.member.create({
      data: { memberNo: `TJA-${username}`, displayName: username, status: memberStatus },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const { authHeader } = await loginAs(app, username);
    return { userId: user.id, memberId: member.id, authHeader };
  }

  async function openCycle(over: Record<string, unknown> = {}): Promise<string> {
    // 十项收口刀B:DB 级「至多一个 open 轮」partial unique 落地——夹具先关旧 open 再开新
    // (此前夹具可堆多个 open 轮,靠"最新创建"侥幸;现与生产语义一致)。
    await prisma.teamJoinCycle.updateMany({
      where: { statusCode: 'open' },
      data: { statusCode: 'closed', closedAt: new Date() },
    });
    const c = await prisma.teamJoinCycle.create({
      data: {
        year: CYCLE_YEAR,
        name: '2026 年度入队',
        statusCode: 'open',
        openedAt: new Date(),
        ...over,
      },
    });
    return c.id;
  }

  async function makeOrg(status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE'): Promise<string> {
    orgSeq += 1;
    const org = await prisma.organization.create({
      data: { name: `目标部门${orgSeq}`, nodeTypeCode: 'demo-node-type-1', status },
    });
    return org.id;
  }

  function submit(auth: string, targetOrganizationIds: string[]): request.Test {
    return request(httpServer(app))
      .post(APPS)
      .set('Authorization', auth)
      .send({ targetOrganizationIds });
  }

  async function addContribution(memberId: string, points: string): Promise<void> {
    const org = await makeOrg();
    const activity = await prisma.activity.create({
      data: {
        title: '考勤',
        activityTypeCode: 'demo-act',
        organizationId: org,
        startAt: BEFORE_CUTOFF,
        endAt: BEFORE_CUTOFF,
        location: '深圳',
        statusCode: 'completed',
      },
    });
    const sheet = await prisma.attendanceSheet.create({
      data: { activityId: activity.id, submitterUserId: volA.userId, statusCode: 'approved' },
    });
    // 活动闭环硬化(2026-06-21;上限于 v0.48.0 调整为 3):把 points 摊到多个不同北京日
    // (每日 ≤ 3,各日不触顶 → 封顶后汇总 = points);单条大分值已不现实(单北京日最多计 3)。
    let cents = Math.round(Number(points) * 100);
    let dayOffset = 0;
    while (cents > 0) {
      const take = Math.min(cents, 300);
      const checkInAt = new Date(BEFORE_CUTOFF.getTime() - dayOffset * 86_400_000);
      await prisma.attendanceRecord.create({
        data: {
          sheetId: sheet.id,
          memberId,
          roleCode: 'member',
          checkInAt,
          checkOutAt: new Date(checkInAt.getTime() + 4 * 3600_000),
          serviceHours: '4.00',
          attendanceStatusCode: 'present',
          contributionPoints: (take / 100).toFixed(2),
        },
      });
      cents -= take;
      dayOffset += 1;
    }
  }

  beforeAll(async () => {
    app = await createTestApp();
    appB = await createTestApp();
    prisma = app.get(PrismaService);
    prismaB = appB.get(PrismaService);
    await resetDb(app);
    volA = await makeLinked('tja_vol_a', 'ACTIVE');
    volB = await makeLinked('tja_vol_b', 'ACTIVE');
    await createTestUser(app, { username: 'tja_unlinked', role: Role.USER });
    unlinkedAuth = (await loginAs(app, 'tja_unlinked')).authHeader;
    inactiveAuth = (await makeLinked('tja_inactive', 'INACTIVE')).authHeader;
    await createTestUser(app, { username: 'tja_admin', role: Role.SUPER_ADMIN });
    adminAuth = (await loginAs(app, 'tja_admin')).authHeader;
  });

  afterAll(async () => {
    await settleAllWithTimeout([app.close(), appB.close()], 'team-join app surface shutdown');
  });

  beforeEach(async () => {
    await prisma.attendanceRecord.deleteMany({});
    await prisma.attendanceSheet.deleteMany({});
    await prisma.activity.deleteMany({});
    await prisma.teamJoinApplication.deleteMany({});
    await prisma.memberOrganizationMembership.deleteMany({});
    await prisma.teamJoinCycle.deleteMany({});
    await prisma.organization.deleteMany({});
    // 复位 volA/volB 的入队相关身份(gradeCode 清空;部门已随 memberDepartment 清)
    await prisma.member.updateMany({
      where: { id: { in: [volA.memberId, volB.memberId] } },
      data: { gradeCode: null },
    });
    await prisma.auditLog.deleteMany({ where: { resourceType: 'team_join_application' } });
  });

  // ===== 准入 =====
  it('① unlinked(无 member)→ submit 403;INACTIVE member → 403', async () => {
    const org = await makeOrg();
    await openCycle();
    expectBizError(await submit(unlinkedAuth, [org]), BizCode.FORBIDDEN);
    expectBizError(await submit(inactiveAuth, [org]), BizCode.FORBIDDEN);
  });

  // ===== 发起申请 =====
  it('② 发起入队申请成功:201 joining + 候选部门 + 12 gate 实况 + 实时贡献值', async () => {
    await openCycle();
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    await addContribution(volA.memberId, '6.00');
    const res = await submit(volA.authHeader, [orgA, orgB]).expect(201);
    expect(res.body.data.statusCode).toBe('joining');
    expect(res.body.data.targetOrganizationIds).toEqual([orgA, orgB]);
    expect(res.body.data.gates).toHaveLength(12);
    expect(res.body.data.contributionPoints).toBe('6');
    expect(res.body.data.contributionSatisfied).toBe(true);
    expect(res.body.data.generalGatesSatisfied).toBe(false); // 尚未标 gate
    // 永不返回 L3 / memberId 不在 self DTO
    expect(res.body.data.memberId).toBeUndefined();
  });

  it('②b【S5】新志愿者(volunteer + VOL 部门)发起入队申请:门禁双兼容不拦,201 joining', async () => {
    await openCycle();
    const target = await makeOrg();
    // 转「新志愿者」状态(S5 后 promote 产物):gradeCode='volunteer' + 1 条 VOL 归口部门
    const volOrg = await prisma.organization.create({
      data: { name: '志愿者', code: 'VOL', nodeTypeCode: 'volunteer', status: 'ACTIVE' },
    });
    await prisma.member.update({ where: { id: volA.memberId }, data: { gradeCode: 'volunteer' } });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: volA.memberId, organizationId: volOrg.id },
    });

    const res = await submit(volA.authHeader, [target]).expect(201);
    expect(res.body.data.statusCode).toBe('joining');
  });

  it('③ 无 open 入队轮 → CYCLE_NOT_OPEN', async () => {
    const org = await makeOrg();
    expectBizError(await submit(volA.authHeader, [org]), BizCode.TEAM_JOIN_CYCLE_NOT_OPEN);
  });

  it('④ 已入队(member 有级别)→ MEMBER_ALREADY_ENROLLED', async () => {
    await openCycle();
    const org = await makeOrg();
    await prisma.member.update({ where: { id: volA.memberId }, data: { gradeCode: 'level-1' } });
    expectBizError(await submit(volA.authHeader, [org]), BizCode.TEAM_JOIN_MEMBER_ALREADY_ENROLLED);
  });

  it('⑤ 候选部门不存在 → ORGANIZATION_NOT_FOUND;INACTIVE → ORGANIZATION_INACTIVE', async () => {
    await openCycle();
    expectBizError(
      await submit(volA.authHeader, ['nonexistent-org']),
      BizCode.ORGANIZATION_NOT_FOUND,
    );
    const inactiveOrg = await makeOrg('INACTIVE');
    expectBizError(await submit(volA.authHeader, [inactiveOrg]), BizCode.ORGANIZATION_INACTIVE);
  });

  it('H 本轮开放清单/候选上限:发起与改候选均拒清单外或超上限,合法候选回显有效配置', async () => {
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const outside = await makeOrg();
    await openCycle({ openOrganizationIds: [orgA, orgB], maxTargetOrgs: 1 });

    expectBizError(
      await submit(volA.authHeader, [outside]),
      BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE,
    );
    expectBizError(
      await submit(volA.authHeader, [orgA, orgB]),
      BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE,
    );
    const created = await submit(volA.authHeader, [orgA]).expect(201);
    expect(created.body.data.openOrganizationIds).toEqual([orgA, orgB]);
    expect(created.body.data.maxTargetOrgs).toBe(1);

    const id = created.body.data.id as string;
    for (const targets of [[outside], [orgA, orgB]]) {
      const res = await request(httpServer(app))
        .patch(`${APPS}/${id}/targets`)
        .set('Authorization', volA.authHeader)
        .send({ targetOrganizationIds: targets });
      expectBizError(res, BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE);
    }
  });

  it('H2 旧轮 maxTargetOrgs>2:App 回显钳制为 2,历史三部门申请保留,新提交三部门 → 40000', async () => {
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const orgC = await makeOrg();
    const cycleId = await openCycle({
      openOrganizationIds: [orgA, orgB, orgC],
      maxTargetOrgs: 8,
    });
    // 直连 Prisma 模拟上限收紧前已存在的旧轮与已提交三部门申请;生产不做数据订正。
    await prisma.teamJoinApplication.create({
      data: {
        cycleId,
        memberId: volA.memberId,
        statusCode: 'joining',
        targetOrganizationIds: [orgA, orgB, orgC],
      },
    });

    const current = await request(httpServer(app))
      .get(CURRENT)
      .set('Authorization', volA.authHeader)
      .expect(200);
    expect(current.body.data.maxTargetOrgs).toBe(2);
    expect(current.body.data.targetOrganizationIds).toEqual([orgA, orgB, orgC]);

    const rejected = await submit(volB.authHeader, [orgA, orgB, orgC]);
    expectBizError(rejected, BizCode.BAD_REQUEST, { strictMessage: false });
  });

  it('⑥ 空候选 → 400(ArrayMinSize)', async () => {
    await openCycle();
    const res = await request(httpServer(app))
      .post(APPS)
      .set('Authorization', volA.authHeader)
      .send({ targetOrganizationIds: [] });
    expect(res.status).toBe(BizCode.BAD_REQUEST.httpStatus);
  });

  it('⑦ 同轮重复发起 → DUPLICATE_APPLICATION', async () => {
    await openCycle();
    const org = await makeOrg();
    await submit(volA.authHeader, [org]).expect(201);
    expectBizError(await submit(volA.authHeader, [org]), BizCode.TEAM_JOIN_DUPLICATE_APPLICATION);
  });

  // ===== 查进度 =====
  it('⑧ 查进度:无申请 → 404;有申请 → 返本人当前 + 贡献值', async () => {
    await openCycle();
    const noneRes = await request(httpServer(app))
      .get(CURRENT)
      .set('Authorization', volA.authHeader);
    expectBizError(noneRes, BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND);
    const org = await makeOrg();
    await addContribution(volA.memberId, '5.00');
    await submit(volA.authHeader, [org]).expect(201);
    const cur = await request(httpServer(app))
      .get(CURRENT)
      .set('Authorization', volA.authHeader)
      .expect(200);
    expect(cur.body.data.statusCode).toBe('joining');
    expect(cur.body.data.contributionPoints).toBe('5');
    expect(cur.body.data.cycleYear).toBe(CYCLE_YEAR);
  });

  // ===== 改候选 + self-scope(防 IDOR)=====
  it('⑨ 改候选部门(joining 态)成功;非本人申请 → 404', async () => {
    await openCycle();
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const created = await submit(volA.authHeader, [orgA]).expect(201);
    const appId = created.body.data.id as string;
    const updated = await request(httpServer(app))
      .patch(`${APPS}/${appId}/targets`)
      .set('Authorization', volA.authHeader)
      .send({ targetOrganizationIds: [orgA, orgB] })
      .expect(200);
    expect(updated.body.data.targetOrganizationIds).toEqual([orgA, orgB]);
    // volB 改 volA 的申请 → 404(self-scope 锁 memberId 防 IDOR)
    const idor = await request(httpServer(app))
      .patch(`${APPS}/${appId}/targets`)
      .set('Authorization', volB.authHeader)
      .send({ targetOrganizationIds: [orgB] });
    expectBizError(idor, BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND);
  });

  it('⑩ 改候选:非 joining 态(fixture 直建 pending_evaluation)→ WRONG_STATE', async () => {
    const cycleId = await openCycle();
    const orgA = await makeOrg();
    const appRow = await prisma.teamJoinApplication.create({
      data: {
        cycleId,
        memberId: volA.memberId,
        statusCode: 'pending_evaluation',
        targetOrganizationIds: [orgA],
      },
    });
    const res = await request(httpServer(app))
      .patch(`${APPS}/${appRow.id}/targets`)
      .set('Authorization', volA.authHeader)
      .send({ targetOrganizationIds: [orgA] });
    expectBizError(res, BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
  });

  async function waitForDirectTeamJoinWaiter(
    directBlockerPid: number,
    operation: Promise<request.Response>,
    excludedPids: number[] = [],
  ): Promise<{ pid: number; databaseName: string; blockingPids: number[] }> {
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const deadline = Date.now() + LOCK_OBSERVE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (settled) throw new Error('team-join app operation settled before expected lock wait');
      const rows = await withTimeout(
        prismaB.$queryRaw<Array<{ pid: number; databaseName: string; blockingPids: number[] }>>(
          Prisma.sql`
            SELECT pid, datname AS "databaseName", pg_blocking_pids(pid) AS "blockingPids"
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND CAST(${directBlockerPid} AS integer) = ANY(pg_blocking_pids(pid))
              AND query LIKE '%FROM "team_join_applications"%FOR NO KEY UPDATE%'
              AND NOT (pid = ANY(${excludedPids}::integer[]))
            LIMIT 1
          `,
        ),
        'team-join app lock observer query',
        LOCK_OBSERVE_TIMEOUT_MS,
      );
      if (rows[0]) return rows[0];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`team-join app direct waiter missing blocker=${directBlockerPid}`);
  }

  async function runUpdateTargetsRejectLinearization(
    firstAction: 'reject' | 'update',
  ): Promise<void> {
    await openCycle();
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const created = await submit(volA.authHeader, [orgA]).expect(201);
    const appId = created.body.data.id as string;
    const notificationCountBefore = await prisma.notification.count();
    const outboxCountBefore = await prisma.notificationOutboxIntent.count();
    const poolIds = await Promise.all(
      [prisma, prismaB].map(async (client) => {
        const rows = await client.$queryRaw<
          Array<{ pid: number; databaseName: string }>
        >(Prisma.sql`
          SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"
        `);
        return rows[0];
      }),
    );
    expect(poolIds[0].databaseName).toBe(poolIds[1].databaseName);
    expect(poolIds[0].pid).not.toBe(poolIds[1].pid);

    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let root!: { pid: number; databaseName: string };
    let reached!: () => void;
    const reachedPromise = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let mutate!: () => void;
    const mutatePromise = new Promise<void>((resolve) => {
      mutate = resolve;
    });
    let mutated!: () => void;
    const mutatedPromise = new Promise<void>((resolve) => {
      mutated = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number; databaseName: string }>>(Prisma.sql`
        SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"
        FROM "team_join_applications"
        WHERE "id" = ${appId}
        FOR UPDATE
      `);
        root = rows[0];
        reached();
        if (firstAction === 'update') {
          await mutatePromise;
          await tx.teamJoinApplication.update({
            where: { id: appId },
            data: { targetOrganizationIds: [orgA, orgB] },
          });
          mutated();
        }
        await releasePromise;
      },
      { timeout: BLOCKER_TIMEOUT_MS },
    );

    let rejectRequest: Promise<request.Response> | undefined;
    let updateRequest: Promise<request.Response> | undefined;
    let primaryFailure: unknown;
    let cleanupFailure: unknown;
    try {
      await withTimeout(reachedPromise, 'team-join app root blocker', BLOCKER_TIMEOUT_MS);
      const reject = () =>
        Promise.resolve(
          request(httpServer(firstAction === 'reject' ? app : appB))
            .post(`/api/admin/v1/team-join/applications/${appId}/evaluate`)
            .set('Authorization', adminAuth)
            .send({ approved: false })
            .timeout({ deadline: HTTP_TIMEOUT_MS }),
        );
      const update = () =>
        Promise.resolve(
          request(httpServer(firstAction === 'update' ? app : appB))
            .patch(`${APPS}/${appId}/targets`)
            .set('Authorization', volA.authHeader)
            .send({ targetOrganizationIds: [orgB] })
            .timeout({ deadline: HTTP_TIMEOUT_MS }),
        );
      const first =
        firstAction === 'reject' ? (rejectRequest = reject()) : (updateRequest = update());
      const firstWaiter = await waitForDirectTeamJoinWaiter(root.pid, first);
      expect(firstWaiter.databaseName).toBe(root.databaseName);
      expect(firstWaiter.blockingPids).toContain(root.pid);
      if (firstAction === 'update') {
        mutate();
        await withTimeout(mutatedPromise, 'team-join app root mutation', HTTP_TIMEOUT_MS);
      }
      const second =
        firstAction === 'reject' ? (updateRequest = update()) : (rejectRequest = reject());
      const secondWaiter = await waitForDirectTeamJoinWaiter(firstWaiter.pid, second, [root.pid]);
      expect(secondWaiter.pid).not.toBe(firstWaiter.pid);
      expect(secondWaiter.databaseName).toBe(root.databaseName);
      expect(secondWaiter.blockingPids).toContain(firstWaiter.pid);
      release();
      if (!rejectRequest || !updateRequest) {
        throw new Error('both team-join operations must be started');
      }
      const [rejectResponse, updateResponse] = await withTimeout(
        Promise.all([rejectRequest, updateRequest]),
        'team-join app competing operations',
        HTTP_TIMEOUT_MS,
      );
      expect(rejectResponse.status).toBe(200);
      expect(JSON.stringify([rejectResponse.body, updateResponse.body])).not.toContain('40P01');
      if (firstAction === 'reject') {
        expectBizError(updateResponse, BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE);
      } else {
        expect(updateResponse.status).toBe(200);
      }
      expect(
        await prisma.teamJoinApplication.findUniqueOrThrow({
          where: { id: appId },
          select: { statusCode: true, targetOrganizationIds: true },
        }),
      ).toEqual({
        statusCode: 'rejected',
        targetOrganizationIds: firstAction === 'reject' ? [orgA] : [orgB],
      });
      expect(
        await prisma.auditLog.count({
          where: { resourceId: appId, event: 'team-join-application.evaluate' },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: { resourceId: appId, event: 'team-join-application.update-targets' },
        }),
      ).toBe(firstAction === 'reject' ? 0 : 1);
      if (firstAction === 'update') {
        const updateAudit = await prisma.auditLog.findFirstOrThrow({
          where: { resourceId: appId, event: 'team-join-application.update-targets' },
          select: { context: true },
        });
        expect(updateAudit.context).toMatchObject({ before: { targetCount: 2 } });
      }
      expect(await prisma.notification.count()).toBe(notificationCountBefore);
      expect(await prisma.notificationOutboxIntent.count()).toBe(outboxCountBefore);
      expect(
        await prisma.insuranceEligibilityEvidence.count({
          where: { teamJoinApplicationId: appId },
        }),
      ).toBe(0);
    } catch (error) {
      primaryFailure = error;
    } finally {
      mutate();
      release();
      try {
        await settleAllWithTimeout(
          [
            blocker,
            ...(rejectRequest ? [rejectRequest] : []),
            ...(updateRequest ? [updateRequest] : []),
          ],
          'team-join app linearization cleanup',
        );
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
    }
    if (primaryFailure !== undefined) {
      if (cleanupFailure !== undefined) preservePrimaryFailure(primaryFailure, cleanupFailure);
      throwFailure(primaryFailure);
    }
    if (cleanupFailure !== undefined) throwFailure(cleanupFailure);
  }

  it('reject-first:root → reject direct waiter → updateTargets soft waiter，后者零副作用', async () => {
    await runUpdateTargetsRejectLinearization('reject');
  });

  it('updateTargets-first:root → update direct waiter → reject soft waiter；同态更新后 reject 合法', async () => {
    await runUpdateTargetsRejectLinearization('update');
  });

  // ===== audit =====
  it('⑪ audit:发起与改候选分别落 submit/update-targets(actorUserId = 本人)', async () => {
    await openCycle();
    const orgA = await makeOrg();
    const orgB = await makeOrg();
    const created = await submit(volA.authHeader, [orgA]).expect(201);
    await request(httpServer(app))
      .patch(`${APPS}/${created.body.data.id}/targets`)
      .set('Authorization', volA.authHeader)
      .send({ targetOrganizationIds: [orgA, orgB] })
      .expect(200);
    const logs = await prisma.auditLog.findMany({
      where: {
        event: {
          in: ['team-join-application.submit', 'team-join-application.update-targets'],
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs.map((log) => log.event)).toEqual([
      'team-join-application.submit',
      'team-join-application.update-targets',
    ]);
    expect(logs.every((l) => l.actorUserId === volA.userId)).toBe(true);
  });
});
