import type { INestApplication } from '@nestjs/common';
import {
  BindingScopeType,
  BindingStatus,
  MemberStatus,
  PrincipalType,
  Role,
  UserStatus,
} from '@prisma/client';
import request, { type Response } from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { LAST_OPS_ADMIN_LOCK_KEY } from '../../src/modules/permissions/last-admin-protection.policy';
import { loginAs } from '../fixtures/auth.fixture';
import { seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

describe('PR-C ops-admin 任期真值与常驻兜底不变量', () => {
  type DelegationEntryPermissionCode =
    | 'rbac.user-role.create'
    | 'rbac.user-role.delete'
    | 'role-binding.create.record'
    | 'role-binding.read.record';

  let appA: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let barrierPrisma: PrismaService;
  let superAdminAuth: string;
  let opsAdminRoleId: string;
  let sequence = 0;

  beforeAll(async () => {
    appA = await createTestApp();
    appB = await createTestApp();
    prisma = appA.get(PrismaService);
    barrierPrisma = new PrismaService();
    await barrierPrisma.$connect();
  });

  beforeEach(async () => {
    await resetDb(appA);
    sequence += 1;
    await createTestUser(appA, {
      username: `ops-term-sa-${sequence}`,
      role: Role.SUPER_ADMIN,
    });
    superAdminAuth = (await loginAs(appA, `ops-term-sa-${sequence}`)).authHeader;
    opsAdminRoleId = (await seedRbacPermissionsAndOpsAdmin(appA)).opsAdminRoleId;
  });

  afterAll(async () => {
    await Promise.all([appA.close(), appB.close(), barrierPrisma.$disconnect()]);
  });

  async function createHolder(
    label: string,
    term: { startedAt: Date; endedAt: Date | null },
  ): Promise<{ userId: string; bindingId: string }> {
    const user = await createTestUser(appA, {
      username: `ops-term-${label}-${sequence}`,
      role: Role.USER,
    });
    const binding = await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: user.id,
        roleId: opsAdminRoleId,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        startedAt: term.startedAt,
        endedAt: term.endedAt,
      },
      select: { id: true },
    });
    return { userId: user.id, bindingId: binding.id };
  }

  async function currentHolderCounts(referenceNow: Date): Promise<{
    effective: number;
    permanent: number;
  }> {
    const bindings = await prisma.roleBinding.findMany({
      where: {
        principalType: PrincipalType.USER,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        deletedAt: null,
        roleId: opsAdminRoleId,
        role: { code: 'ops-admin', deletedAt: null },
      },
      select: { principalId: true, startedAt: true, endedAt: true },
    });
    const current = bindings.filter(
      ({ principalId, startedAt, endedAt }) =>
        principalId !== null &&
        startedAt.getTime() <= referenceNow.getTime() &&
        (endedAt === null || endedAt.getTime() >= referenceNow.getTime()),
    );
    const activeUsers = await prisma.user.findMany({
      where: {
        id: {
          in: current
            .map(({ principalId }) => principalId)
            .filter((id): id is string => id !== null),
        },
        status: UserStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true },
    });
    const activeIds = new Set(activeUsers.map(({ id }) => id));
    return {
      effective: new Set(
        current
          .map(({ principalId }) => principalId)
          .filter((id): id is string => id !== null && activeIds.has(id)),
      ).size,
      permanent: new Set(
        current
          .filter(({ endedAt }) => endedAt === null)
          .map(({ principalId }) => principalId)
          .filter((id): id is string => id !== null && activeIds.has(id)),
      ).size,
    };
  }

  function deleteBinding(bindingId: string, targetApp: INestApplication = appA) {
    return request(httpServer(targetApp))
      .delete(`/api/admin/v1/role-bindings/${bindingId}`)
      .set('Authorization', superAdminAuth);
  }

  function disableUser(userId: string, targetApp: INestApplication = appA) {
    return request(httpServer(targetApp))
      .patch(`/api/admin/v1/users/${userId}/status`)
      .set('Authorization', superAdminAuth)
      .send({ status: UserStatus.DISABLED });
  }

  function patchBinding(
    bindingId: string,
    body: Record<string, unknown>,
    targetApp: INestApplication = appA,
  ) {
    return request(httpServer(targetApp))
      .patch(`/api/admin/v1/role-bindings/${bindingId}`)
      .set('Authorization', superAdminAuth)
      .send(body);
  }

  function deleteUserRole(userId: string, roleId: string, targetApp: INestApplication = appA) {
    return request(httpServer(targetApp))
      .delete(`/api/system/v1/users/${userId}/roles/${roleId}`)
      .set('Authorization', superAdminAuth);
  }

  async function createDelegationScenario(
    _label: string,
    entryPermissionCode: DelegationEntryPermissionCode | DelegationEntryPermissionCode[],
    actorTerm: { startedAt: Date; endedAt: Date | null },
  ): Promise<{
    actorId: string;
    actorAuth: string;
    targetId: string;
    ordinaryRole: { id: string; code: string };
  }> {
    const actorUsername = `od-a-${sequence}`;
    const actor = await createTestUser(appA, {
      username: actorUsername,
      role: Role.ADMIN,
    });
    const fallback = await createTestUser(appA, {
      username: `od-f-${sequence}`,
      role: Role.USER,
    });
    const target = await createTestUser(appA, {
      username: `od-t-${sequence}`,
      role: Role.USER,
    });
    const entryPermissionCodes = Array.isArray(entryPermissionCode)
      ? entryPermissionCode
      : [entryPermissionCode];
    const entryPermissions = await Promise.all(
      entryPermissionCodes.map(async (code) => {
        const [module, resourceType, action] = code.startsWith('rbac.user-role.')
          ? ['rbac', 'user-role', code.endsWith('.delete') ? 'delete' : 'create']
          : ['role-binding', 'record', code.endsWith('.read.record') ? 'read' : 'create'];
        return prisma.permission.upsert({
          where: { code },
          update: {},
          create: { code, module, action, resourceType },
          select: { id: true },
        });
      }),
    );
    const entryRole = await prisma.rbacRole.create({
      data: {
        code: `od-e-${sequence}`,
        displayName: '委派入口测试角色',
        rolePermissions: {
          create: entryPermissions.map(({ id }) => ({ permissionId: id })),
        },
      },
      select: { id: true },
    });
    const ordinaryRole = await prisma.rbacRole.create({
      data: {
        code: `od-o-${sequence}`,
        displayName: '普通非特权角色',
      },
      select: { id: true, code: true },
    });
    await prisma.roleBinding.createMany({
      data: [
        {
          principalType: PrincipalType.USER,
          principalId: fallback.id,
          roleId: opsAdminRoleId,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
        },
        {
          principalType: PrincipalType.USER,
          principalId: actor.id,
          roleId: entryRole.id,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
        },
        {
          principalType: PrincipalType.USER,
          principalId: actor.id,
          roleId: opsAdminRoleId,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
          startedAt: actorTerm.startedAt,
          endedAt: actorTerm.endedAt,
        },
      ],
    });
    return {
      actorId: actor.id,
      actorAuth: (await loginAs(appA, actorUsername)).authHeader,
      targetId: target.id,
      ordinaryRole,
    };
  }

  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
  } {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  }

  function isTransitivelyBlockedBy(
    waiterPid: number,
    blockerPid: number,
    blockersByPid: ReadonlyMap<number, readonly number[]>,
    visited: Set<number> = new Set(),
  ): boolean {
    if (visited.has(waiterPid)) return false;
    visited.add(waiterPid);
    const direct = blockersByPid.get(waiterPid) ?? [];
    return direct.some(
      (pid) =>
        pid === blockerPid ||
        isTransitivelyBlockedBy(pid, blockerPid, blockersByPid, new Set(visited)),
    );
  }

  async function waitForOpsInvariantWaiters(
    blockerPid: number,
    expected: number,
  ): Promise<Array<{ pid: number; query: string; blockingPids: number[] }>> {
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
      const waiters = await prisma.$queryRaw<
        Array<{ pid: number; query: string; blockingPids: number[] }>
      >`
        SELECT
          pid,
          query,
          pg_blocking_pids(pid) AS "blockingPids"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND state = 'active'
          AND wait_event_type = 'Lock'
        ORDER BY query_start, pid
      `;
      const blockersByPid = new Map(
        waiters.map(({ pid, blockingPids }) => [pid, blockingPids] as const),
      );
      const blocked = waiters.filter(
        ({ pid, query }) =>
          query.includes('pg_advisory_xact_lock') &&
          isTransitivelyBlockedBy(pid, blockerPid, blockersByPid),
      );
      if (blocked.length >= expected) return blocked;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(
      `expected ${expected} ops-admin advisory waiter(s) blocked by pid ${blockerPid}`,
    );
  }

  async function holdOpsInvariantLock(): Promise<{
    blockerPid: number;
    release: () => void;
    done: Promise<void>;
  }> {
    const ready = deferred<number>();
    const release = deferred<void>();
    const done = barrierPrisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(hashtext(${LAST_OPS_ADMIN_LOCK_KEY}))::text AS locked
        `;
        const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid()::integer AS pid
        `;
        if (!backend) throw new Error('ops-admin advisory barrier backend pid missing');
        ready.resolve(backend.pid);
        await release.promise;
      },
      { maxWait: 5_000, timeout: 25_000 },
    );
    void done.catch((error: unknown) => ready.reject(error));
    return {
      blockerPid: await ready.promise,
      release: () => release.resolve(),
      done,
    };
  }

  async function runTwoOpsInvariantRequests(
    firstRequest: () => PromiseLike<Response>,
    secondRequest: () => PromiseLike<Response>,
  ): Promise<Response[]> {
    const barrier = await holdOpsInvariantLock();
    const attempts: Array<Promise<Response>> = [];
    let waitError: unknown;
    try {
      const first = Promise.resolve(firstRequest());
      attempts.push(first);
      void first.catch(() => undefined);
      expect(await waitForOpsInvariantWaiters(barrier.blockerPid, 1)).toHaveLength(1);

      const second = Promise.resolve(secondRequest());
      attempts.push(second);
      void second.catch(() => undefined);
      expect(await waitForOpsInvariantWaiters(barrier.blockerPid, 2)).toHaveLength(2);
    } catch (error) {
      waitError = error;
    } finally {
      barrier.release();
      await barrier.done;
    }
    const responses = await Promise.all(attempts);
    if (waitError instanceof Error) throw waitError;
    if (waitError !== undefined) {
      throw new Error('ops-admin advisory waiter assertion failed', { cause: waitError });
    }
    return responses;
  }

  function expectOneSuccessOneProtected(responses: Response[]): void {
    expect(responses.filter(({ status }) => status === 200)).toHaveLength(1);
    const protectedResponses = responses.filter(
      ({ body }) => body.code === BizCode.LAST_OPS_ADMIN_PROTECTED.code,
    );
    expect(protectedResponses).toHaveLength(1);
    expectBizError(protectedResponses[0], BizCode.LAST_OPS_ADMIN_PROTECTED);
  }

  it('red 1：future backup 不能让当前唯一有效且常驻 holder 被删除', async () => {
    const setupNow = new Date();
    const current = await createHolder('future-current', {
      startedAt: new Date(setupNow.getTime() - 60_000),
      endedAt: null,
    });
    await createHolder('future-backup', {
      startedAt: new Date(setupNow.getTime() + 60 * 60_000),
      endedAt: null,
    });

    const res = await deleteBinding(current.bindingId);
    const counts = await currentHolderCounts(new Date());

    expect({
      status: res.status,
      code: res.body.code,
      currentEffectiveOpsAdminCount: counts.effective,
      currentPermanentOpsAdminCount: counts.permanent,
    }).toEqual({
      status: BizCode.LAST_OPS_ADMIN_PROTECTED.httpStatus,
      code: BizCode.LAST_OPS_ADMIN_PROTECTED.code,
      currentEffectiveOpsAdminCount: 1,
      currentPermanentOpsAdminCount: 1,
    });
  });

  it('red 2：expired backup 不能让当前唯一有效且常驻 holder 被停用', async () => {
    const setupNow = new Date();
    const current = await createHolder('expired-current', {
      startedAt: new Date(setupNow.getTime() - 60_000),
      endedAt: null,
    });
    await createHolder('expired-backup', {
      startedAt: new Date(setupNow.getTime() - 2 * 60 * 60_000),
      endedAt: new Date(setupNow.getTime() - 60 * 60_000),
    });

    const res = await disableUser(current.userId);
    const counts = await currentHolderCounts(new Date());

    expect({
      status: res.status,
      code: res.body.code,
      currentEffectiveOpsAdminCount: counts.effective,
      currentPermanentOpsAdminCount: counts.permanent,
    }).toEqual({
      status: BizCode.LAST_OPS_ADMIN_PROTECTED.httpStatus,
      code: BizCode.LAST_OPS_ADMIN_PROTECTED.code,
      currentEffectiveOpsAdminCount: 1,
      currentPermanentOpsAdminCount: 1,
    });
  });

  it.each([
    [
      'future',
      (now: Date) => ({
        startedAt: new Date(now.getTime() + 60 * 60_000),
        endedAt: null,
      }),
    ],
    [
      'expired',
      (now: Date) => ({
        startedAt: new Date(now.getTime() - 2 * 60 * 60_000),
        endedAt: new Date(now.getTime() - 60 * 60_000),
      }),
    ],
  ])(
    'red 3：%s ops-admin actor 不能经真实 user-role 入口委派普通角色',
    async (label, termFactory) => {
      const actor = await createTestUser(appA, {
        username: `ops-term-delegator-${label}-${sequence}`,
        role: Role.ADMIN,
      });
      const fallback = await createTestUser(appA, {
        username: `ops-term-fallback-${label}-${sequence}`,
        role: Role.USER,
      });
      const target = await createTestUser(appA, {
        username: `ops-term-target-${label}-${sequence}`,
        role: Role.USER,
      });
      await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: fallback.id,
          roleId: opsAdminRoleId,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
        },
      });

      const entryPermission = await prisma.permission.findUniqueOrThrow({
        where: { code: 'rbac.user-role.create' },
        select: { id: true },
      });
      const entryRole = await prisma.rbacRole.create({
        data: {
          code: `ops-term-entry-${label}-${sequence}`,
          displayName: '委派入口测试角色',
          rolePermissions: { create: { permissionId: entryPermission.id } },
        },
        select: { id: true },
      });
      const ordinaryRole = await prisma.rbacRole.create({
        data: {
          code: `ops-term-ordinary-${label}-${sequence}`,
          displayName: '普通非特权角色',
        },
        select: { code: true },
      });
      await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: actor.id,
          roleId: entryRole.id,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
        },
      });
      const referenceNow = new Date();
      const term = termFactory(referenceNow);
      await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: actor.id,
          roleId: opsAdminRoleId,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
          startedAt: term.startedAt,
          endedAt: term.endedAt,
        },
      });
      const actorAuth = (await loginAs(appA, `ops-term-delegator-${label}-${sequence}`)).authHeader;

      const res = await request(httpServer(appA))
        .post(`/api/system/v1/users/${target.id}/roles`)
        .set('Authorization', actorAuth)
        .send({ roleCode: ordinaryRole.code });

      expectBizError(res, BizCode.CANNOT_ASSIGN_HIGHER_ROLE);
    },
  );

  it.each([
    [
      'future',
      (now: Date) => ({
        startedAt: new Date(now.getTime() + 60 * 60_000),
        endedAt: null,
      }),
    ],
    [
      'expired',
      (now: Date) => ({
        startedAt: new Date(now.getTime() - 2 * 60 * 60_000),
        endedAt: new Date(now.getTime() - 60 * 60_000),
      }),
    ],
  ])('red 4：唯一 %s ACTIVE 但无效的绑定可以正常清理', async (label, termFactory) => {
    const referenceNow = new Date();
    const invalid = await createHolder(`cleanup-${label}`, termFactory(referenceNow));

    const res = await deleteBinding(invalid.bindingId);
    const stored = await prisma.roleBinding.findUniqueOrThrow({
      where: { id: invalid.bindingId },
      select: { status: true, deletedAt: true },
    });

    expect(res.status).toBe(200);
    expect(stored.status).toBe(BindingStatus.ENDED);
    expect(stored.deletedAt).not.toBeNull();
  });

  it('当前有效临时 ops-admin 在有效期内仍可委派普通角色', async () => {
    const referenceNow = new Date();
    const actor = await createTestUser(appA, {
      username: `ops-term-current-delegator-${sequence}`,
      role: Role.ADMIN,
    });
    const fallback = await createTestUser(appA, {
      username: `ops-term-current-fallback-${sequence}`,
      role: Role.USER,
    });
    const target = await createTestUser(appA, {
      username: `ops-term-current-target-${sequence}`,
      role: Role.USER,
    });
    const ordinaryRole = await prisma.rbacRole.create({
      data: {
        code: `ops-term-current-ordinary-${sequence}`,
        displayName: '当前临时委派普通角色',
      },
      select: { code: true },
    });
    await prisma.roleBinding.createMany({
      data: [
        {
          principalType: PrincipalType.USER,
          principalId: fallback.id,
          roleId: opsAdminRoleId,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
        },
        {
          principalType: PrincipalType.USER,
          principalId: actor.id,
          roleId: opsAdminRoleId,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
          startedAt: new Date(referenceNow.getTime() - 60 * 60_000),
          endedAt: new Date(referenceNow.getTime() + 60 * 60_000),
        },
      ],
    });
    const actorAuth = (await loginAs(appA, `ops-term-current-delegator-${sequence}`)).authHeader;

    const res = await request(httpServer(appA))
      .post(`/api/system/v1/users/${target.id}/roles`)
      .set('Authorization', actorAuth)
      .send({ roleCode: ordinaryRole.code });

    expect(res.status).toBe(201);
  });

  it.each([
    {
      label: 'future actor × 不存在 target',
      actorTerm: (now: Date) => ({
        startedAt: new Date(now.getTime() + 60 * 60_000),
        endedAt: null,
      }),
      duplicate: false,
    },
    {
      label: 'expired actor × duplicate slot',
      actorTerm: (now: Date) => ({
        startedAt: new Date(now.getTime() - 2 * 60 * 60_000),
        endedAt: new Date(now.getTime() - 60 * 60_000),
      }),
      duplicate: true,
    },
  ])('$label 始终先返 30102，不泄露 target 存在性或重复槽位', async (testCase) => {
    const scenario = await createDelegationScenario(
      `priority-${testCase.duplicate ? 'duplicate' : 'missing'}`,
      'rbac.user-role.create',
      testCase.actorTerm(new Date()),
    );
    if (testCase.duplicate) {
      await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: scenario.targetId,
          roleId: scenario.ordinaryRole.id,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
        },
      });
    }

    const res = await request(httpServer(appA))
      .post(
        `/api/system/v1/users/${
          testCase.duplicate ? scenario.targetId : 'nonexistent000000000000000000'
        }/roles`,
      )
      .set('Authorization', scenario.actorAuth)
      .send({ roleCode: scenario.ordinaryRole.code });

    expectBizError(res, BizCode.CANNOT_ASSIGN_HIGHER_ROLE);
  });

  it.each([
    [
      'future',
      (now: Date) => ({
        startedAt: new Date(now.getTime() + 60 * 60_000),
        endedAt: null,
      }),
    ],
    [
      'expired',
      (now: Date) => ({
        startedAt: new Date(now.getTime() - 2 * 60 * 60_000),
        endedAt: new Date(now.getTime() - 60 * 60_000),
      }),
    ],
  ])(
    '%s actor 在 create/batch/preview/revoke 均先返 30102，不能枚举 target',
    async (_label, termFactory) => {
      const scenario = await createDelegationScenario(
        'all-entry-priority',
        ['rbac.user-role.delete', 'role-binding.create.record', 'role-binding.read.record'],
        termFactory(new Date()),
      );
      await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: scenario.targetId,
          roleId: scenario.ordinaryRole.id,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
        },
      });
      const before = await prisma.roleBinding.count();
      const missingId = 'nonexistent000000000000000000';
      const createBody = (principalId: string) => ({
        principalType: PrincipalType.USER,
        principalId,
        roleId: scenario.ordinaryRole.id,
        scopeType: BindingScopeType.GLOBAL,
      });

      const createResponse = await request(httpServer(appA))
        .post('/api/admin/v1/role-bindings')
        .set('Authorization', scenario.actorAuth)
        .send(createBody(missingId));
      expectBizError(createResponse, BizCode.CANNOT_ASSIGN_HIGHER_ROLE);

      const batchResponse = await request(httpServer(appA))
        .post('/api/admin/v1/role-bindings/batch')
        .set('Authorization', scenario.actorAuth)
        .send({
          items: [createBody(missingId), createBody(scenario.targetId)],
        });
      expect(batchResponse.status).toBe(200);
      expect(batchResponse.body.data.items).toEqual([
        expect.objectContaining({
          index: 0,
          outcome: 'blocked',
          bizCode: BizCode.CANNOT_ASSIGN_HIGHER_ROLE.code,
        }),
        expect.objectContaining({
          index: 1,
          outcome: 'blocked',
          bizCode: BizCode.CANNOT_ASSIGN_HIGHER_ROLE.code,
        }),
      ]);

      for (const principalId of [missingId, scenario.targetId]) {
        const previewResponse = await request(httpServer(appA))
          .get('/api/admin/v1/role-bindings/preview')
          .set('Authorization', scenario.actorAuth)
          .query(createBody(principalId));
        expect(previewResponse.status).toBe(200);
        expect(previewResponse.body.data.conflicts).toEqual([
          expect.objectContaining({ bizCode: BizCode.CANNOT_ASSIGN_HIGHER_ROLE.code }),
        ]);
      }

      for (const targetId of [missingId, scenario.targetId]) {
        const revokeResponse = await request(httpServer(appA))
          .delete(`/api/system/v1/users/${targetId}/roles/${scenario.ordinaryRole.id}`)
          .set('Authorization', scenario.actorAuth);
        expectBizError(revokeResponse, BizCode.CANNOT_ASSIGN_HIGHER_ROLE);
      }

      expect(await prisma.roleBinding.count()).toBe(before);
    },
  );

  it.each([
    ['把 endedAt=null 改为有限任期', () => ({ endedAt: new Date(Date.now() + 60 * 60_000) })],
    ['把 startedAt 移到未来', () => ({ startedAt: new Date(Date.now() + 60 * 60_000) })],
  ])('唯一常驻 holder 不可%s', async (_label, mutationFactory) => {
    const referenceNow = new Date();
    const current = await createHolder('patch-sole-permanent', {
      startedAt: new Date(referenceNow.getTime() - 60_000),
      endedAt: null,
    });
    const mutation = mutationFactory();
    const body = Object.fromEntries(
      Object.entries(mutation).map(([key, value]) => [key, value.toISOString()]),
    );

    const res = await patchBinding(current.bindingId, body);
    expectBizError(res, BizCode.LAST_OPS_ADMIN_PROTECTED);

    const stored = await prisma.roleBinding.findUniqueOrThrow({
      where: { id: current.bindingId },
      select: { startedAt: true, endedAt: true, status: true },
    });
    expect(stored.status).toBe(BindingStatus.ACTIVE);
    expect(stored.endedAt).toBeNull();
    expect(stored.startedAt.getTime()).toBeLessThanOrEqual(referenceNow.getTime());
  });

  it('存在另一常驻 holder 时，可把其中一条 permanent 改为有限任期', async () => {
    const referenceNow = new Date();
    const target = await createHolder('patch-with-backup-target', {
      startedAt: new Date(referenceNow.getTime() - 60_000),
      endedAt: null,
    });
    await createHolder('patch-with-backup-permanent', {
      startedAt: new Date(referenceNow.getTime() - 60_000),
      endedAt: null,
    });

    const res = await patchBinding(target.bindingId, {
      endedAt: new Date(referenceNow.getTime() + 60 * 60_000).toISOString(),
    });

    expect(res.status).toBe(200);
    expect(await currentHolderCounts(new Date())).toEqual({ effective: 2, permanent: 1 });
  });

  it.each(['disable', 'soft-delete'])(
    'User %s：当前临时 backup 不能替代唯一常驻 holder',
    async (operation) => {
      const referenceNow = new Date();
      const current = await createHolder(`user-${operation}-permanent`, {
        startedAt: new Date(referenceNow.getTime() - 60_000),
        endedAt: null,
      });
      await createHolder(`user-${operation}-temporary`, {
        startedAt: new Date(referenceNow.getTime() - 60 * 60_000),
        endedAt: new Date(referenceNow.getTime() + 60 * 60_000),
      });

      const res =
        operation === 'disable'
          ? await disableUser(current.userId)
          : await request(httpServer(appA))
              .delete(`/api/admin/v1/users/${current.userId}`)
              .set('Authorization', superAdminAuth);

      expectBizError(res, BizCode.LAST_OPS_ADMIN_PROTECTED);
      expect(await currentHolderCounts(new Date())).toEqual({ effective: 2, permanent: 1 });
    },
  );

  it.each(['member-status', 'account-status', 'offboard', 'reopen'])(
    'Member %s：当前临时 backup 不能绕过唯一常驻 holder 保护',
    async (operation) => {
      const member = await prisma.member.create({
        data: {
          memberNo: `OPS-TERM-${operation}-${sequence}`,
          displayName: `Ops term ${operation}`,
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      });
      const user = await createTestUser(appA, {
        username: `ops-term-member-${operation}-${sequence}`,
        role: Role.USER,
      });
      await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
      const referenceNow = new Date();
      await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: user.id,
          roleId: opsAdminRoleId,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
          startedAt: new Date(referenceNow.getTime() - 60_000),
        },
      });
      await createHolder(`member-${operation}-temporary`, {
        startedAt: new Date(referenceNow.getTime() - 60 * 60_000),
        endedAt: new Date(referenceNow.getTime() + 60 * 60_000),
      });

      let res: Response;
      if (operation === 'member-status') {
        res = await request(httpServer(appA))
          .patch(`/api/admin/v1/members/${member.id}/status`)
          .set('Authorization', superAdminAuth)
          .send({ status: MemberStatus.INACTIVE });
      } else if (operation === 'account-status') {
        res = await request(httpServer(appA))
          .patch(`/api/admin/v1/members/${member.id}/account/status`)
          .set('Authorization', superAdminAuth)
          .send({ status: UserStatus.DISABLED });
      } else if (operation === 'offboard') {
        res = await request(httpServer(appA))
          .post(`/api/admin/v1/members/${member.id}/offboard`)
          .set('Authorization', superAdminAuth);
      } else {
        res = await request(httpServer(appA))
          .post(`/api/admin/v1/members/${member.id}/account/reopen`)
          .set('Authorization', superAdminAuth)
          .send({ phone: `1381000${String(sequence).padStart(4, '0')}` });
      }

      expectBizError(res, BizCode.LAST_OPS_ADMIN_PROTECTED);
      expect(await currentHolderCounts(new Date())).toEqual({ effective: 2, permanent: 1 });
      expect(
        await prisma.user.findFirst({
          where: { id: user.id, status: UserStatus.ACTIVE, deletedAt: null },
          select: { id: true },
        }),
      ).not.toBeNull();
    },
  );

  it('legacy GET 只返回当前有效角色，不展示 future/expired ACTIVE slot', async () => {
    const target = await createTestUser(appA, {
      username: `ops-term-legacy-list-${sequence}`,
      role: Role.USER,
    });
    const futureRole = await prisma.rbacRole.create({
      data: { code: `ops-term-future-role-${sequence}`, displayName: 'Future role' },
      select: { id: true },
    });
    const expiredRole = await prisma.rbacRole.create({
      data: { code: `ops-term-expired-role-${sequence}`, displayName: 'Expired role' },
      select: { id: true },
    });
    const referenceNow = new Date();
    await prisma.roleBinding.createMany({
      data: [
        {
          principalType: PrincipalType.USER,
          principalId: target.id,
          roleId: futureRole.id,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
          startedAt: new Date(referenceNow.getTime() + 60 * 60_000),
        },
        {
          principalType: PrincipalType.USER,
          principalId: target.id,
          roleId: expiredRole.id,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
          startedAt: new Date(referenceNow.getTime() - 2 * 60 * 60_000),
          endedAt: new Date(referenceNow.getTime() - 60 * 60_000),
        },
      ],
    });

    const res = await request(httpServer(appA))
      .get(`/api/system/v1/users/${target.id}/roles`)
      .set('Authorization', superAdminAuth);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it.each([
    [
      'future',
      (now: Date) => ({
        startedAt: new Date(now.getTime() + 60 * 60_000),
        endedAt: null,
      }),
    ],
    [
      'expired',
      (now: Date) => ({
        startedAt: new Date(now.getTime() - 2 * 60 * 60_000),
        endedAt: new Date(now.getTime() - 60 * 60_000),
      }),
    ],
  ])('legacy revoke 可清理 %s ops-admin ACTIVE slot', async (label, termFactory) => {
    const invalid = await createHolder(`legacy-cleanup-${label}`, termFactory(new Date()));

    const res = await deleteUserRole(invalid.userId, opsAdminRoleId);

    expect(res.status).toBe(200);
    expect(
      await prisma.roleBinding.findUniqueOrThrow({
        where: { id: invalid.bindingId },
        select: { status: true, deletedAt: true },
      }),
    ).toMatchObject({ status: BindingStatus.ENDED, deletedAt: expect.any(Date) });
  });

  it('role-bindings page 默认排除 future，includeExpired=true 仍可管理查看', async () => {
    const target = await createTestUser(appA, {
      username: `ops-term-page-target-${sequence}`,
      role: Role.USER,
    });
    const role = await prisma.rbacRole.create({
      data: { code: `ops-term-page-role-${sequence}`, displayName: 'Page future role' },
      select: { id: true, code: true },
    });
    const future = await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: target.id,
        roleId: role.id,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        startedAt: new Date(Date.now() + 60 * 60_000),
      },
      select: { id: true },
    });

    const current = await request(httpServer(appA))
      .get('/api/admin/v1/role-bindings/page')
      .query({ roleCode: role.code })
      .set('Authorization', superAdminAuth);
    const all = await request(httpServer(appA))
      .get('/api/admin/v1/role-bindings/page')
      .query({ roleCode: role.code, includeExpired: 'true' })
      .set('Authorization', superAdminAuth);

    expect(current.status).toBe(200);
    expect(current.body.data.items).toEqual([]);
    expect(all.body.data.items.map(({ id }: { id: string }) => id)).toContain(future.id);
  });

  it('非 ops-admin 普通 RoleBinding 删除行为不变', async () => {
    const target = await createTestUser(appA, {
      username: `ops-term-plain-delete-${sequence}`,
      role: Role.USER,
    });
    const role = await prisma.rbacRole.create({
      data: { code: `ops-term-plain-role-${sequence}`, displayName: 'Plain role' },
      select: { id: true },
    });
    const binding = await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: target.id,
        roleId: role.id,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
      },
      select: { id: true },
    });

    expect((await deleteBinding(binding.id)).status).toBe(200);
  });

  it('两套 Nest app 使用不同 PostgreSQL backend / pool', async () => {
    const [[a], [b]] = await Promise.all([
      prisma.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::integer AS pid`,
      appB.get(PrismaService).$queryRaw<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid()::integer AS pid`,
    ]);
    expect(a?.pid).toBeDefined();
    expect(b?.pid).toBeDefined();
    expect(a?.pid).not.toBe(b?.pid);
  });

  it('真实 advisory barrier：RoleBinding delete × User disable 并发最多一个成功', async () => {
    const referenceNow = new Date();
    const bindingAxis = await createHolder('concurrent-binding-axis', {
      startedAt: new Date(referenceNow.getTime() - 60_000),
      endedAt: null,
    });
    const userAxis = await createHolder('concurrent-user-axis', {
      startedAt: new Date(referenceNow.getTime() - 60_000),
      endedAt: null,
    });

    const responses = await runTwoOpsInvariantRequests(
      () => deleteBinding(bindingAxis.bindingId, appA),
      () => disableUser(userAxis.userId, appB),
    );

    expectOneSuccessOneProtected(responses);
    expect(await currentHolderCounts(new Date())).toEqual({ effective: 1, permanent: 1 });
  });

  it('真实 advisory barrier：Member offboard × RoleBinding delete 并发最多一个成功', async () => {
    const member = await prisma.member.create({
      data: {
        memberNo: `OPS-CONCURRENT-${sequence}`,
        displayName: 'Ops concurrent member',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const memberUser = await createTestUser(appA, {
      username: `ops-concurrent-member-${sequence}`,
      role: Role.USER,
    });
    await prisma.user.update({ where: { id: memberUser.id }, data: { memberId: member.id } });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: memberUser.id,
        roleId: opsAdminRoleId,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
      },
    });
    const bindingAxis = await createHolder('concurrent-member-binding-axis', {
      startedAt: new Date(Date.now() - 60_000),
      endedAt: null,
    });

    const responses = await runTwoOpsInvariantRequests(
      () =>
        request(httpServer(appA))
          .post(`/api/admin/v1/members/${member.id}/offboard`)
          .set('Authorization', superAdminAuth),
      () => deleteBinding(bindingAxis.bindingId, appB),
    );

    expectOneSuccessOneProtected(responses);
    expect(await currentHolderCounts(new Date())).toEqual({ effective: 1, permanent: 1 });
  });

  it('真实 advisory barrier：actor ops revoke 先线性化后，legacy assign 必须拒绝', async () => {
    const scenario = await createDelegationScenario(
      'concurrent-revoke-assign',
      'rbac.user-role.create',
      { startedAt: new Date(Date.now() - 60_000), endedAt: null },
    );

    const responses = await runTwoOpsInvariantRequests(
      () => deleteUserRole(scenario.actorId, opsAdminRoleId, appA),
      () =>
        request(httpServer(appB))
          .post(`/api/system/v1/users/${scenario.targetId}/roles`)
          .set('Authorization', scenario.actorAuth)
          .send({ roleCode: scenario.ordinaryRole.code }),
    );

    expect(responses[0].status).toBe(200);
    expectBizError(responses[1], BizCode.CANNOT_ASSIGN_HIGHER_ROLE);
    expect(
      await prisma.roleBinding.count({
        where: {
          principalType: PrincipalType.USER,
          principalId: scenario.targetId,
          roleId: scenario.ordinaryRole.id,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
      }),
    ).toBe(0);
  });

  it('真实 advisory barrier：actor disable 先线性化后，RoleBinding create 必须拒绝', async () => {
    const scenario = await createDelegationScenario(
      'concurrent-disable-create',
      'role-binding.create.record',
      { startedAt: new Date(Date.now() - 60_000), endedAt: null },
    );

    const responses = await runTwoOpsInvariantRequests(
      () => disableUser(scenario.actorId, appA),
      () =>
        request(httpServer(appB))
          .post('/api/admin/v1/role-bindings')
          .set('Authorization', scenario.actorAuth)
          .send({
            principalType: PrincipalType.USER,
            principalId: scenario.targetId,
            roleId: scenario.ordinaryRole.id,
            scopeType: BindingScopeType.GLOBAL,
          }),
    );

    expect(responses[0].status).toBe(200);
    expectBizError(responses[1], BizCode.CANNOT_ASSIGN_HIGHER_ROLE);
    expect(
      await prisma.roleBinding.count({
        where: {
          principalType: PrincipalType.USER,
          principalId: scenario.targetId,
          roleId: scenario.ordinaryRole.id,
          scopeType: BindingScopeType.GLOBAL,
          status: BindingStatus.ACTIVE,
          deletedAt: null,
        },
      }),
    ).toBe(0);
  });
});
