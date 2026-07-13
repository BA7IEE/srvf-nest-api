import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, BindingStatus, PrincipalType, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { httpServer } from '../helpers/http-server';
import { PrismaService } from '../../src/database/prisma.service';
import { UserRolesService } from '../../src/modules/permissions/user-roles.service';
import { UsersService } from '../../src/modules/users/users.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// finding 4：last-SUPER_ADMIN 与 last-ops-admin 共锁事务保护。
// 并发用 service + 真 PostgreSQL 事务，模拟两个请求均已通过 JwtStrategy 后同时进入业务层；
// HTTP 正向用例继续锁定既有端点契约。
describe('最后管理员事务保护', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let usersService: UsersService;
  let userRolesService: UserRolesService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    usersService = app.get(UsersService);
    userRolesService = app.get(UserRolesService);
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  function currentUserPayload(user: {
    id: string;
    username: string;
    role: Role;
    status: UserStatus;
    memberId: string | null;
  }): CurrentUserPayload {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      memberId: user.memberId,
    };
  }

  async function createOpsAdminRole() {
    return prisma.rbacRole.create({
      data: { code: 'ops-admin', displayName: 'Ops Admin Test Role' },
      select: { id: true },
    });
  }

  async function bindOpsAdmin(userId: string, roleId: string): Promise<void> {
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: userId,
        roleId,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
      },
    });
  }

  async function countActiveOpsAdminHolders(roleId: string): Promise<number> {
    const bindings = await prisma.roleBinding.findMany({
      where: {
        roleId,
        principalType: PrincipalType.USER,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        deletedAt: null,
      },
      select: { principalId: true },
    });
    const ids = bindings
      .map(({ principalId }) => principalId)
      .filter((id): id is string => id !== null);
    return prisma.user.count({
      where: { id: { in: ids }, status: UserStatus.ACTIVE, deletedAt: null },
    });
  }

  function expectOneSuccessOneProtected(
    results: PromiseSettledResult<unknown>[],
    code: typeof BizCode.LAST_SUPER_ADMIN_PROTECTED | typeof BizCode.LAST_OPS_ADMIN_PROTECTED,
  ): void {
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<unknown> => result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toEqual(new BizException(code));
  }

  it('A 软删另一个 SUPER_ADMIN B(db 中还有 C 作为后备) → 200,B 状态正确,剩余仍 ≥ 1', async () => {
    await createTestUser(app, { username: 'lsadel1a', role: Role.SUPER_ADMIN });
    const b = await createTestUser(app, { username: 'lsadel1b', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'lsadel1c', role: Role.SUPER_ADMIN });
    const { authHeader } = await loginAs(app, 'lsadel1a');

    const res = await request(httpServer(app))
      .delete(`/api/admin/v1/users/${b.id}`)
      .set('Authorization', authHeader);

    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);

    const dbB = await prisma.user.findUnique({ where: { id: b.id } });
    expect(dbB?.deletedAt).not.toBeNull();
    expect(dbB?.status).toBe(UserStatus.DISABLED);

    // db 中应还有 ≥ 1 个 active SUPER_ADMIN(A 与 C)
    const remaining = await prisma.user.count({
      where: { role: Role.SUPER_ADMIN, status: UserStatus.ACTIVE, deletedAt: null },
    });
    expect(remaining).toBeGreaterThanOrEqual(1);
  });

  it('A 把另一个 SUPER_ADMIN B 改 status=DISABLED(db 中还有 C) → 200', async () => {
    await createTestUser(app, { username: 'lsadis1a', role: Role.SUPER_ADMIN });
    const b = await createTestUser(app, { username: 'lsadis1b', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'lsadis1c', role: Role.SUPER_ADMIN });
    const { authHeader } = await loginAs(app, 'lsadis1a');

    const res = await request(httpServer(app))
      .patch(`/api/admin/v1/users/${b.id}/status`)
      .set('Authorization', authHeader)
      .send({ status: 'DISABLED' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe(UserStatus.DISABLED);

    const dbB = await prisma.user.findUnique({ where: { id: b.id } });
    expect(dbB?.status).toBe(UserStatus.DISABLED);
  });

  it('A 把另一个 SUPER_ADMIN B 降级为 ADMIN(db 中还有 C) → 200', async () => {
    await createTestUser(app, { username: 'lsarole1a', role: Role.SUPER_ADMIN });
    const b = await createTestUser(app, { username: 'lsarole1b', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'lsarole1c', role: Role.SUPER_ADMIN });
    const { authHeader } = await loginAs(app, 'lsarole1a');

    const res = await request(httpServer(app))
      .patch(`/api/admin/v1/users/${b.id}/role`)
      .set('Authorization', authHeader)
      .send({ role: Role.ADMIN });

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe(Role.ADMIN);

    const dbB = await prisma.user.findUnique({ where: { id: b.id } });
    expect(dbB?.role).toBe(Role.ADMIN);
  });

  it('并发互禁仅存的两个 SUPER_ADMIN → 恰一成功、一方 10103，最终仍有 1 名', async () => {
    const a = await createTestUser(app, { username: 'lsa-concurrent-a', role: Role.SUPER_ADMIN });
    const b = await createTestUser(app, { username: 'lsa-concurrent-b', role: Role.SUPER_ADMIN });

    const results = await Promise.allSettled([
      usersService.updateStatus(
        currentUserPayload(a),
        b.id,
        { status: UserStatus.DISABLED },
        { requestId: 'last-sa-concurrency-a', ip: '127.0.0.1', ua: 'jest' },
      ),
      usersService.updateStatus(
        currentUserPayload(b),
        a.id,
        { status: UserStatus.DISABLED },
        { requestId: 'last-sa-concurrency-b', ip: '127.0.0.1', ua: 'jest' },
      ),
    ]);

    expectOneSuccessOneProtected(results, BizCode.LAST_SUPER_ADMIN_PROTECTED);
    expect(
      await prisma.user.count({
        where: { role: Role.SUPER_ADMIN, status: UserStatus.ACTIVE, deletedAt: null },
      }),
    ).toBe(1);
  });

  it('禁用唯一 ops-admin 持有人 → 30101，用户与绑定均保持 ACTIVE', async () => {
    const actor = await createTestUser(app, {
      username: 'ops-guard-actor',
      role: Role.SUPER_ADMIN,
    });
    const target = await createTestUser(app, { username: 'ops-guard-target', role: Role.USER });
    const role = await createOpsAdminRole();
    await bindOpsAdmin(target.id, role.id);

    await expect(
      usersService.updateStatus(
        currentUserPayload(actor),
        target.id,
        {
          status: UserStatus.DISABLED,
        },
        { requestId: 'last-ops-disable', ip: '127.0.0.1', ua: 'jest' },
      ),
    ).rejects.toEqual(new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED));
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).status).toBe(
      UserStatus.ACTIVE,
    );
    expect(await countActiveOpsAdminHolders(role.id)).toBe(1);
  });

  it('软删唯一 ops-admin 持有人 → 30101，用户未软删', async () => {
    const actor = await createTestUser(app, {
      username: 'ops-delete-actor',
      role: Role.SUPER_ADMIN,
    });
    const target = await createTestUser(app, { username: 'ops-delete-target', role: Role.USER });
    const role = await createOpsAdminRole();
    await bindOpsAdmin(target.id, role.id);

    await expect(
      usersService.softDelete(currentUserPayload(actor), target.id, {
        requestId: 'last-ops-delete',
        ip: '127.0.0.1',
        ua: 'jest',
      }),
    ).rejects.toEqual(new BizException(BizCode.LAST_OPS_ADMIN_PROTECTED));
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).deletedAt,
    ).toBeNull();
  });

  it('两名 ops-admin 时禁用其中一名 → 允许，仍保留 1 名 ACTIVE 持有人', async () => {
    const actor = await createTestUser(app, { username: 'ops-two-actor', role: Role.SUPER_ADMIN });
    const first = await createTestUser(app, { username: 'ops-two-first', role: Role.USER });
    const second = await createTestUser(app, { username: 'ops-two-second', role: Role.USER });
    const role = await createOpsAdminRole();
    await bindOpsAdmin(first.id, role.id);
    await bindOpsAdmin(second.id, role.id);

    await expect(
      usersService.updateStatus(
        currentUserPayload(actor),
        first.id,
        {
          status: UserStatus.DISABLED,
        },
        { requestId: 'two-ops-disable', ip: '127.0.0.1', ua: 'jest' },
      ),
    ).resolves.toMatchObject({ id: first.id, status: UserStatus.DISABLED });
    expect(await countActiveOpsAdminHolders(role.id)).toBe(1);
  });

  it('跨路径并发：users.disable(A) 与 user-roles.revoke(B) 同削最后两名 ops-admin → 恰一成功、一方 30101', async () => {
    const actor = await createTestUser(app, {
      username: 'ops-concurrent-actor',
      role: Role.SUPER_ADMIN,
    });
    const a = await createTestUser(app, { username: 'ops-concurrent-a', role: Role.USER });
    const b = await createTestUser(app, { username: 'ops-concurrent-b', role: Role.USER });
    const role = await createOpsAdminRole();
    await bindOpsAdmin(a.id, role.id);
    await bindOpsAdmin(b.id, role.id);
    const actorPayload = currentUserPayload(actor);

    const results = await Promise.allSettled([
      usersService.updateStatus(
        actorPayload,
        a.id,
        { status: UserStatus.DISABLED },
        { requestId: 'last-ops-concurrency-disable', ip: '127.0.0.1', ua: 'jest' },
      ),
      userRolesService.revoke(actorPayload, b.id, role.id, {
        requestId: 'last-ops-admin-concurrency',
        ip: '127.0.0.1',
        ua: 'jest',
      }),
    ]);

    expectOneSuccessOneProtected(results, BizCode.LAST_OPS_ADMIN_PROTECTED);
    expect(await countActiveOpsAdminHolders(role.id)).toBe(1);
  });
});
