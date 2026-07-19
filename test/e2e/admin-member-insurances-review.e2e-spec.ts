import type { INestApplication } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import request, { type Response } from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import {
  AuditLogsService,
  type AuditLogInput,
} from '../../src/modules/audit-logs/audit-logs.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// D-INSURANCE v3 PR2 唯一 admin review route；并发段使用两套独立 Nest app / Prisma pool，
// 共用同一派生 app_test_* PostgreSQL，并以事务内 audit barrier + pg_stat_activity wait_event
// 锁定真实交错。
// 本 spec 自行 seed 唯一新权限码，避免修改共享 biz-admin fixture 写集；测试覆盖：
// - rbac.can 前置防枚举；有权后的 member/insurance 组合 26001；
// - expectedVersion 优先于状态机；NOWAIT 55P03 快速映射 26011；
// - mutation + 最小 audit 同事务，audit fail 整体回滚；
// - DTO 只允许 decision + expectedVersion，响应不泄露 reviewer。

interface ResBody {
  code: number;
  message: string;
  data: Record<string, unknown>;
}

interface BackendIdentity {
  pid: number;
  databaseName: string;
}

interface BackendWaitState {
  pid: number;
  state: string;
  waitEventType: string | null;
  waitEvent: string | null;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readBackendIdentity(prisma: PrismaService): Promise<BackendIdentity> {
  const [identity] = await prisma.$queryRaw<BackendIdentity[]>(Prisma.sql`
    SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"
  `);
  if (!identity) throw new Error('PostgreSQL backend identity missing');
  return identity;
}

async function waitForPausedTransaction(
  prisma: PrismaService,
  backendPid: number,
): Promise<BackendWaitState> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [state] = await prisma.$queryRaw<BackendWaitState[]>(Prisma.sql`
      SELECT
        pid,
        state,
        wait_event_type AS "waitEventType",
        wait_event AS "waitEvent"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid = CAST(${backendPid} AS integer)
    `);
    if (
      state?.state === 'idle in transaction' &&
      state.waitEventType === 'Client' &&
      state.waitEvent === 'ClientRead'
    ) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`backend ${backendPid} did not reach idle-in-transaction audit barrier`);
}

async function waitForBlockedBackend(
  prisma: PrismaService,
  blockerPid: number,
  mutation: Promise<unknown>,
  queryPattern: string,
): Promise<BackendWaitState> {
  let settled = false;
  void mutation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (settled) throw new Error('mutation settled before the expected PostgreSQL lock wait');
    const [state] = await prisma.$queryRaw<BackendWaitState[]>(Prisma.sql`
      SELECT
        pid,
        state,
        wait_event_type AS "waitEventType",
        wait_event AS "waitEvent"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> CAST(${blockerPid} AS integer)
        AND wait_event_type = 'Lock'
        AND CAST(${blockerPid} AS integer) = ANY(pg_blocking_pids(pid))
        AND query LIKE ${queryPattern}
      LIMIT 1
    `);
    if (state) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no PostgreSQL lock waiter observed for blocker ${blockerPid}`);
}

function pauseAuditInTransaction(
  auditLogs: AuditLogsService,
  event: AuditLogInput['event'],
  resourceId: string,
): {
  reached: Promise<number>;
  release: () => void;
  restore: () => void;
} {
  const reached = deferred<number>();
  const release = deferred<void>();
  const originalLog = auditLogs.log.bind(auditLogs);
  let paused = false;
  const spy = jest.spyOn(auditLogs, 'log').mockImplementation(async (input) => {
    if (!paused && input.event === event && input.resourceId === resourceId) {
      if (!input.tx) throw new Error(`${event} audit must receive its mutation transaction`);
      paused = true;
      const [backend] = await input.tx.$queryRaw<Array<{ pid: number }>>(Prisma.sql`
        SELECT pg_backend_pid() AS pid
      `);
      if (!backend) throw new Error(`${event} audit transaction backend missing`);
      reached.resolve(backend.pid);
      await release.promise;
    }
    return originalLog(input);
  });
  return {
    reached: reached.promise,
    release: () => release.resolve(undefined),
    restore: () => spy.mockRestore(),
  };
}

const REVIEW_PERMISSION = 'member-insurance.review.record';
const ADMIN_INSURANCE_RESPONSE_KEYS = [
  'coverageEnd',
  'coverageStart',
  'createdAt',
  'id',
  'insurerName',
  'memberId',
  'policyNumber',
  'reviewedAt',
  'reviewStatusCode',
  'updatedAt',
  'version',
].sort();

describe('POST /api/admin/v1/members/:memberId/insurances/:insuranceId/review', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let prismaB: PrismaService;
  let auditLogs: AuditLogsService;
  let auditLogsB: AuditLogsService;
  let reviewerAId: string;
  let reviewerAuthA: string;
  let reviewerAuthB: string;
  let plainAdminAuth: string;
  let seq = 0;

  const nextSeq = (): string => `${++seq}-${Math.random().toString(36).slice(2, 7)}`;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prisma = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    auditLogs = appA.get(AuditLogsService);
    auditLogsB = appB.get(AuditLogsService);

    const permission = await prisma.permission.create({
      data: {
        code: REVIEW_PERMISSION,
        module: 'member-insurance',
        action: 'review',
        resourceType: 'record',
      },
      select: { id: true },
    });
    const reviewerRole = await prisma.rbacRole.create({
      data: { code: 'insurance-reviewer-e2e', displayName: 'Insurance Reviewer E2E' },
      select: { id: true },
    });
    await prisma.rolePermission.create({
      data: { roleId: reviewerRole.id, permissionId: permission.id },
    });

    const reviewerA = await createTestUser(appA, {
      username: 'insurance-reviewer-a-e2e',
      role: Role.ADMIN,
    });
    const reviewerB = await createTestUser(appA, {
      username: 'insurance-reviewer-b-e2e',
      role: Role.ADMIN,
    });
    reviewerAId = reviewerA.id;
    for (const principalId of [reviewerA.id, reviewerB.id]) {
      await prisma.roleBinding.create({
        data: {
          principalType: 'USER',
          principalId,
          roleId: reviewerRole.id,
          scopeType: 'GLOBAL',
          status: 'ACTIVE',
        },
      });
    }
    await createTestUser(appA, { username: 'insurance-review-plain', role: Role.ADMIN });

    reviewerAuthA = (await loginAs(appA, 'insurance-reviewer-a-e2e')).authHeader;
    reviewerAuthB = (await loginAs(appA, 'insurance-reviewer-b-e2e')).authHeader;
    plainAdminAuth = (await loginAs(appA, 'insurance-review-plain')).authHeader;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close()]);
  });

  async function createMember(deletedAt: Date | null = null): Promise<{ id: string }> {
    return prisma.member.create({
      data: {
        memberNo: `REVIEW-${nextSeq()}`,
        displayName: 'Insurance Review Target',
        deletedAt,
      },
      select: { id: true },
    });
  }

  async function createInsurance(memberId: string): Promise<{ id: string }> {
    return prisma.memberInsurance.create({
      data: {
        memberId,
        insurerName: `Insurer-${nextSeq()}`,
        policyNumber: `POLICY-${nextSeq()}`,
        coverageStart: new Date('2026-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2026-12-31T00:00:00.000Z'),
      },
      select: { id: true },
    });
  }

  async function setupLinkedAppUser(username: string): Promise<{
    userId: string;
    memberId: string;
    authHeader: string;
  }> {
    const user = await createTestUser(appA, { username, role: Role.USER });
    const member = await createMember();
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const { authHeader } = await loginAs(appA, username);
    return { userId: user.id, memberId: member.id, authHeader };
  }

  function reviewVia(
    targetApp: INestApplication,
    auth: string,
    memberId: string,
    insuranceId: string,
    body: Record<string, unknown> = { decision: 'verified', expectedVersion: 0 },
  ): request.Test {
    return request(httpServer(targetApp))
      .post(`/api/admin/v1/members/${memberId}/insurances/${insuranceId}/review`)
      .set('Authorization', auth)
      .send(body);
  }

  function review(
    auth: string,
    memberId: string,
    insuranceId: string,
    body: Record<string, unknown> = { decision: 'verified', expectedVersion: 0 },
  ): request.Test {
    return reviewVia(appA, auth, memberId, insuranceId, body);
  }

  function patchVia(
    targetApp: INestApplication,
    auth: string,
    insuranceId: string,
    body: Record<string, unknown>,
  ): request.Test {
    return request(httpServer(targetApp))
      .patch(`/api/app/v1/me/insurances/${insuranceId}`)
      .set('Authorization', auth)
      .send(body);
  }

  function deleteVia(
    targetApp: INestApplication,
    auth: string,
    insuranceId: string,
    expectedVersion: number,
  ): request.Test {
    return request(httpServer(targetApp))
      .delete(`/api/app/v1/me/insurances/${insuranceId}?expectedVersion=${expectedVersion}`)
      .set('Authorization', auth);
  }

  it('DTO 白名单:expectedVersion 必填 Int；decision 仅 verified|rejected；note/reason 禁止', async () => {
    const member = await createMember();
    const insurance = await createInsurance(member.id);
    const invalidBodies: Array<Record<string, unknown>> = [
      { decision: 'verified' },
      { decision: 'approved', expectedVersion: 0 },
      { decision: 'rejected', expectedVersion: '0' },
      { decision: 'verified', expectedVersion: 0, note: 'forbidden' },
      { decision: 'verified', expectedVersion: 0, reason: 'forbidden' },
    ];

    for (const body of invalidBodies) {
      const res = await review(reviewerAuthA, member.id, insurance.id, body);
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    }

    const row = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
    expect(row.reviewStatusCode).toBe('pending');
    expect(row.version).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { event: 'member-insurance.review', resourceId: insurance.id },
      }),
    ).toBe(0);
  });

  it('无权限在存在/不存在/跨 member 三类目标上恒 30100，不做存在性探针', async () => {
    const memberA = await createMember();
    const memberB = await createMember();
    const insuranceB = await createInsurance(memberB.id);

    const cases = [
      [memberB.id, insuranceB.id],
      [memberB.id, 'cl000000000000000missing'],
      [memberA.id, insuranceB.id],
    ] as const;
    for (const [memberId, insuranceId] of cases) {
      const res = await review(plainAdminAuth, memberId, insuranceId);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    }
  });

  it('有权限时 missing/deleted member 与 missing/deleted/cross-member insurance 恒 26001', async () => {
    const liveA = await createMember();
    const liveB = await createMember();
    const deletedMember = await createMember(new Date());
    const insuranceB = await createInsurance(liveB.id);
    const deletedInsurance = await createInsurance(liveA.id);
    await prisma.memberInsurance.update({
      where: { id: deletedInsurance.id },
      data: { deletedAt: new Date() },
    });

    const cases = [
      ['cl000000000000000missing', insuranceB.id],
      [deletedMember.id, insuranceB.id],
      [liveA.id, 'cl000000000000000missing'],
      [liveA.id, deletedInsurance.id],
      [liveA.id, insuranceB.id],
    ] as const;
    for (const [memberId, insuranceId] of cases) {
      const res = await review(reviewerAuthA, memberId, insuranceId);
      expectBizError(res, BizCode.MEMBER_INSURANCE_NOT_FOUND);
    }
  });

  it.each(['verified', 'rejected'] as const)(
    'pending 审核为 %s：v+1、写 reviewer/time，response additive 且 audit context 严格最小',
    async (decision) => {
      const member = await createMember();
      const insurance = await createInsurance(member.id);
      const original = await prisma.memberInsurance.findUniqueOrThrow({
        where: { id: insurance.id },
      });

      const res = await review(reviewerAuthA, member.id, insurance.id, {
        decision,
        expectedVersion: 0,
      }).expect(200);
      const data = (res.body as ResBody).data;
      expect(data).toMatchObject({
        id: insurance.id,
        memberId: member.id,
        reviewStatusCode: decision,
        version: 1,
      });
      expect(data.reviewedAt).toEqual(expect.any(String));
      expect(Object.keys(data).sort()).toEqual(ADMIN_INSURANCE_RESPONSE_KEYS);
      expect(data).not.toHaveProperty('reviewedByUserId');
      expect(data).not.toHaveProperty('reviewer');

      const row = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
      expect(row.reviewStatusCode).toBe(decision);
      expect(row.version).toBe(1);
      expect(row.reviewedByUserId).toBe(reviewerAId);
      expect(row.reviewedAt).not.toBeNull();

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'member-insurance.review', resourceId: insurance.id },
      });
      const context = audit.context as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        extra: Record<string, unknown>;
      };
      expect(context.before).toEqual({ reviewStatusCode: 'pending', version: 0 });
      expect(context.after).toEqual({ reviewStatusCode: decision, version: 1 });
      expect(context.extra).toEqual({
        memberId: member.id,
        insuranceId: insurance.id,
        decision,
      });
      expect(Object.keys(context.before).sort()).toEqual(['reviewStatusCode', 'version']);
      expect(Object.keys(context.after).sort()).toEqual(['reviewStatusCode', 'version']);
      expect(Object.keys(context.extra).sort()).toEqual(['decision', 'insuranceId', 'memberId']);
      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain(original.insurerName);
      expect(serialized).not.toContain(original.policyNumber);
      expect(serialized).not.toContain('note');
      expect(serialized).not.toContain('image');
      expect(serialized).not.toContain('url');
    },
  );

  it('版本比较先于状态：stale + 非 pending → 26011；current + 非 pending → 26012', async () => {
    const member = await createMember();
    const insurance = await createInsurance(member.id);
    await prisma.memberInsurance.update({
      where: { id: insurance.id },
      data: {
        reviewStatusCode: 'verified',
        version: 3,
        reviewedByUserId: reviewerAId,
        reviewedAt: new Date(),
      },
    });

    const stale = await review(reviewerAuthA, member.id, insurance.id, {
      decision: 'rejected',
      expectedVersion: 2,
    });
    expectBizError(stale, BizCode.MEMBER_INSURANCE_VERSION_CONFLICT);

    const current = await review(reviewerAuthA, member.id, insurance.id, {
      decision: 'rejected',
      expectedVersion: 3,
    });
    expectBizError(current, BizCode.MEMBER_INSURANCE_REVIEW_STATE_INVALID);

    const row = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
    expect(row.reviewStatusCode).toBe('verified');
    expect(row.version).toBe(3);
    expect(
      await prisma.auditLog.count({
        where: { event: 'member-insurance.review', resourceId: insurance.id },
      }),
    ).toBe(0);
  });

  it('双 Nest review↔review：Member-first 真排队，败方锁内重读 stale=26011，最终仅一 mutation/audit', async () => {
    expect(prisma).not.toBe(prismaB);
    expect(auditLogs).not.toBe(auditLogsB);
    expect(appA.getHttpServer()).not.toBe(appB.getHttpServer());
    const [identityA, identityB] = await Promise.all([
      readBackendIdentity(prisma),
      readBackendIdentity(prismaB),
    ]);
    expect(identityA.databaseName).toBe(identityB.databaseName);
    expect(identityA.databaseName).toMatch(/^app_test(?:_|$)/);
    expect(identityA.pid).not.toBe(identityB.pid);

    const member = await createMember();
    const insurance = await createInsurance(member.id);
    const barrier = pauseAuditInTransaction(auditLogs, 'member-insurance.review', insurance.id);
    const winnerPromise = reviewVia(appA, reviewerAuthA, member.id, insurance.id, {
      decision: 'verified',
      expectedVersion: 0,
    }).then((response) => response);
    let loserPromise: Promise<Response> | undefined;

    try {
      const winnerPid = await withTimeout(barrier.reached, 'review winner audit barrier');
      const paused = await waitForPausedTransaction(prismaB, winnerPid);
      expect(paused).toMatchObject({
        pid: winnerPid,
        state: 'idle in transaction',
        waitEventType: 'Client',
        waitEvent: 'ClientRead',
      });

      loserPromise = reviewVia(appB, reviewerAuthB, member.id, insurance.id, {
        decision: 'rejected',
        expectedVersion: 0,
      }).then((response) => response);
      const waiting = await waitForBlockedBackend(
        prismaB,
        winnerPid,
        loserPromise,
        '%FROM "Member"%FOR UPDATE%',
      );
      expect(waiting.state).toBe('active');
      expect(waiting.waitEventType).toBe('Lock');
      expect(waiting.waitEvent).not.toBeNull();
    } finally {
      barrier.release();
      await Promise.allSettled([
        winnerPromise,
        ...(loserPromise === undefined ? [] : [loserPromise]),
      ]);
      barrier.restore();
    }

    if (loserPromise === undefined) throw new Error('review loser request was not started');
    const winner = await winnerPromise;
    const loser = await loserPromise;
    expect(winner.status).toBe(200);
    expectBizError(loser, BizCode.MEMBER_INSURANCE_VERSION_CONFLICT);

    const row = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
    expect(row.reviewStatusCode).toBe('verified');
    expect(row.version).toBe(1);
    expect(row.reviewedByUserId).toBe(reviewerAId);
    expect(row.reviewedAt).not.toBeNull();
    const audits = await prisma.auditLog.findMany({
      where: { event: 'member-insurance.review', resourceId: insurance.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorUserId).toBe(reviewerAId);
    expect(audits[0].context).toEqual(
      expect.objectContaining({
        before: { reviewStatusCode: 'pending', version: 0 },
        after: { reviewStatusCode: 'verified', version: 1 },
      }),
    );
  });

  it('双 Nest App PATCH→review：保险锁持有时 review NOWAIT 快速 26011；PATCH v+1/reset 生效', async () => {
    const owner = await setupLinkedAppUser('insurance-review-app-winner');
    const insurance = await createInsurance(owner.memberId);
    const previousReviewedAt = new Date('2026-06-01T01:02:03.000Z');
    await prisma.memberInsurance.update({
      where: { id: insurance.id },
      data: {
        reviewStatusCode: 'verified',
        version: 3,
        reviewedByUserId: reviewerAId,
        reviewedAt: previousReviewedAt,
      },
    });

    const barrier = pauseAuditInTransaction(
      auditLogsB,
      'member-insurance.update.self',
      insurance.id,
    );
    const patchPromise = patchVia(appB, owner.authHeader, insurance.id, {
      insurerName: '并发 PATCH 新保险公司',
      expectedVersion: 3,
    }).then((response) => response);
    let reviewPromise: Promise<Response> | undefined;
    let reviewResponse: Response | undefined;
    try {
      const patchPid = await withTimeout(barrier.reached, 'App PATCH audit barrier');
      expect(await waitForPausedTransaction(prisma, patchPid)).toMatchObject({
        pid: patchPid,
        state: 'idle in transaction',
        waitEventType: 'Client',
        waitEvent: 'ClientRead',
      });

      // 杀死 Insurance `FOR UPDATE NOWAIT` → 普通 `FOR UPDATE`：review 必须在 PATCH
      // 事务释放前快速落 26011，而不是进入 Lock wait。
      reviewPromise = reviewVia(appA, reviewerAuthA, owner.memberId, insurance.id, {
        decision: 'rejected',
        expectedVersion: 3,
      }).then((response) => response);
      reviewResponse = await withTimeout(reviewPromise, 'review NOWAIT response');
      expectBizError(reviewResponse, BizCode.MEMBER_INSURANCE_VERSION_CONFLICT);
    } finally {
      barrier.release();
      await Promise.allSettled([
        patchPromise,
        ...(reviewPromise === undefined ? [] : [reviewPromise]),
      ]);
      barrier.restore();
    }

    if (reviewResponse === undefined) throw new Error('review NOWAIT response missing');
    const patchResponse = await patchPromise;
    expect(patchResponse.status).toBe(200);
    const row = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
    expect(row.reviewStatusCode).toBe('pending');
    expect(row.version).toBe(4);
    expect(row.reviewedByUserId).toBeNull();
    expect(row.reviewedAt).toBeNull();
    expect(row.insurerName).toBe('并发 PATCH 新保险公司');
    expect(
      await prisma.auditLog.count({
        where: { event: 'member-insurance.update.self', resourceId: insurance.id },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { event: 'member-insurance.review', resourceId: insurance.id },
      }),
    ).toBe(0);
  });

  it('双 Nest review→App PATCH：PATCH 在保险行锁 wait 后重读 stale=26011，不得覆盖审核赢家', async () => {
    const owner = await setupLinkedAppUser('insurance-review-admin-winner');
    const insurance = await createInsurance(owner.memberId);
    const barrier = pauseAuditInTransaction(auditLogs, 'member-insurance.review', insurance.id);
    const reviewPromise = reviewVia(appA, reviewerAuthA, owner.memberId, insurance.id, {
      decision: 'verified',
      expectedVersion: 0,
    }).then((response) => response);
    let patchPromise: Promise<Response> | undefined;

    try {
      const reviewPid = await withTimeout(barrier.reached, 'admin review audit barrier');
      expect(await waitForPausedTransaction(prismaB, reviewPid)).toMatchObject({
        pid: reviewPid,
        state: 'idle in transaction',
        waitEventType: 'Client',
        waitEvent: 'ClientRead',
      });

      patchPromise = patchVia(appB, owner.authHeader, insurance.id, {
        insurerName: '不得覆盖审核赢家',
        expectedVersion: 0,
      }).then((response) => response);
      const waiting = await waitForBlockedBackend(
        prismaB,
        reviewPid,
        patchPromise,
        '%FROM "member_insurances"%FOR UPDATE%',
      );
      expect(waiting.state).toBe('active');
      expect(waiting.waitEventType).toBe('Lock');
      expect(waiting.waitEvent).not.toBeNull();
    } finally {
      barrier.release();
      await Promise.allSettled([
        reviewPromise,
        ...(patchPromise === undefined ? [] : [patchPromise]),
      ]);
      barrier.restore();
    }

    if (patchPromise === undefined) throw new Error('App PATCH contender was not started');
    const reviewResponse = await reviewPromise;
    const patchResponse = await patchPromise;
    expect(reviewResponse.status).toBe(200);
    expectBizError(patchResponse, BizCode.MEMBER_INSURANCE_VERSION_CONFLICT);

    const row = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
    expect(row.reviewStatusCode).toBe('verified');
    expect(row.version).toBe(1);
    expect(row.reviewedByUserId).toBe(reviewerAId);
    expect(row.reviewedAt).not.toBeNull();
    expect(row.insurerName).not.toBe('不得覆盖审核赢家');
    expect(
      await prisma.auditLog.count({
        where: { event: 'member-insurance.review', resourceId: insurance.id },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { event: 'member-insurance.update.self', resourceId: insurance.id },
      }),
    ).toBe(0);
  });

  it('双 Nest App DELETE→review：delete 持保险锁时 review NOWAIT 快速 26011', async () => {
    const owner = await setupLinkedAppUser('insurance-review-delete-winner');
    const insurance = await createInsurance(owner.memberId);
    const barrier = pauseAuditInTransaction(
      auditLogsB,
      'member-insurance.delete.self',
      insurance.id,
    );
    const deletePromise = deleteVia(appB, owner.authHeader, insurance.id, 0).then(
      (response) => response,
    );
    let reviewPromise: Promise<Response> | undefined;
    let reviewResponse: Response | undefined;

    try {
      const deletePid = await withTimeout(barrier.reached, 'App DELETE audit barrier');
      expect(await waitForPausedTransaction(prisma, deletePid)).toMatchObject({
        pid: deletePid,
        state: 'idle in transaction',
        waitEventType: 'Client',
        waitEvent: 'ClientRead',
      });

      reviewPromise = reviewVia(appA, reviewerAuthA, owner.memberId, insurance.id, {
        decision: 'verified',
        expectedVersion: 0,
      }).then((response) => response);
      reviewResponse = await withTimeout(reviewPromise, 'delete versus review NOWAIT response');
      expectBizError(reviewResponse, BizCode.MEMBER_INSURANCE_VERSION_CONFLICT);
    } finally {
      barrier.release();
      await Promise.allSettled([
        deletePromise,
        ...(reviewPromise === undefined ? [] : [reviewPromise]),
      ]);
      barrier.restore();
    }

    expect((await deletePromise).status).toBe(200);
    const row = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.version).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { event: 'member-insurance.delete.self', resourceId: insurance.id },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { event: 'member-insurance.review', resourceId: insurance.id },
      }),
    ).toBe(0);
  });

  it('双 Nest review→App DELETE：DELETE 等待保险锁后重读 stale=26011', async () => {
    const owner = await setupLinkedAppUser('insurance-review-delete-loser');
    const insurance = await createInsurance(owner.memberId);
    const barrier = pauseAuditInTransaction(auditLogs, 'member-insurance.review', insurance.id);
    const reviewPromise = reviewVia(appA, reviewerAuthA, owner.memberId, insurance.id, {
      decision: 'verified',
      expectedVersion: 0,
    }).then((response) => response);
    let deletePromise: Promise<Response> | undefined;

    try {
      const reviewPid = await withTimeout(barrier.reached, 'review before DELETE barrier');
      expect(await waitForPausedTransaction(prismaB, reviewPid)).toMatchObject({
        pid: reviewPid,
        state: 'idle in transaction',
        waitEventType: 'Client',
        waitEvent: 'ClientRead',
      });

      deletePromise = deleteVia(appB, owner.authHeader, insurance.id, 0).then(
        (response) => response,
      );
      const waiting = await waitForBlockedBackend(
        prismaB,
        reviewPid,
        deletePromise,
        '%FROM "member_insurances"%FOR UPDATE%',
      );
      expect(waiting.state).toBe('active');
      expect(waiting.waitEventType).toBe('Lock');
    } finally {
      barrier.release();
      await Promise.allSettled([
        reviewPromise,
        ...(deletePromise === undefined ? [] : [deletePromise]),
      ]);
      barrier.restore();
    }

    if (deletePromise === undefined) throw new Error('App DELETE contender was not started');
    expect((await reviewPromise).status).toBe(200);
    expectBizError(await deletePromise, BizCode.MEMBER_INSURANCE_VERSION_CONFLICT);
    const row = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
    expect(row.deletedAt).toBeNull();
    expect(row.reviewStatusCode).toBe('verified');
    expect(row.version).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { event: 'member-insurance.review', resourceId: insurance.id },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: { event: 'member-insurance.delete.self', resourceId: insurance.id },
      }),
    ).toBe(0);
  });

  it('AuditLogsService.log 失败会回滚 review mutation，业务行与 audit row 均不变', async () => {
    const member = await createMember();
    const insurance = await createInsurance(member.id);
    const logSpy = jest
      .spyOn(auditLogs, 'log')
      .mockRejectedValueOnce(new Error('simulated review audit failure'));

    try {
      await review(reviewerAuthA, member.id, insurance.id).expect(500);
      expect(logSpy).toHaveBeenCalledTimes(1);
    } finally {
      logSpy.mockRestore();
    }

    const row = await prisma.memberInsurance.findUniqueOrThrow({ where: { id: insurance.id } });
    expect(row.reviewStatusCode).toBe('pending');
    expect(row.version).toBe(0);
    expect(row.reviewedByUserId).toBeNull();
    expect(row.reviewedAt).toBeNull();
    expect(
      await prisma.auditLog.count({
        where: { event: 'member-insurance.review', resourceId: insurance.id },
      }),
    ).toBe(0);
  });
});
