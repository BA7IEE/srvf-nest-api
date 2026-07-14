import type { INestApplication } from '@nestjs/common';
import {
  BindingScopeType,
  OrganizationStatus,
  PrincipalType,
  Role,
  SupervisionScopeMode,
} from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { AuthzService } from '../../src/modules/authz/authz.service';
import { loginAs } from '../fixtures/auth.fixture';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

// v0.49 部门数据范围:AuthzService 三源 grant → 可见组织集合 + 前端有效权限出口。
// 真 seed 锁定副职只读投影；旧 rbac/me/permissions 保持只读 GLOBAL USER-binding 的既有语义。

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
  SUPER_ADMIN_USERNAME: 'v049-authz-su',
};

function runSeed(): void {
  const envForChild: NodeJS.ProcessEnv = { ...process.env, ...SEED_ENV };
  assertTestDatabaseUrl(envForChild.DATABASE_URL);
  execSync('pnpm tsx prisma/seed.ts', {
    env: envForChild,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

interface TestPerson {
  payload: CurrentUserPayload;
  memberId: string;
  authHeader: string;
}

describe('v0.49 Authz visible organization scope + effective permissions', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authz: AuthzService;
  let sectId: string;
  let sectChildId: string;
  let inactiveOrgId: string;
  let vice: TestPerson;
  let empty: TestPerson;
  let directGlobal: TestPerson;
  let selfScoped: TestPerson;
  let expiredScoped: TestPerson;
  let inactiveScoped: TestPerson;
  let supervised: TestPerson;
  let superAdminAuth: string;

  async function mkPerson(tag: string): Promise<TestPerson> {
    const member = await prisma.member.create({
      data: { memberNo: `v049-authz-${tag}`, displayName: `v0.49 ${tag}` },
      select: { id: true },
    });
    const user = await prisma.user.create({
      data: {
        username: `v049-authz-${tag}`,
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.USER,
        memberId: member.id,
      },
      select: { id: true, username: true, role: true, status: true, memberId: true },
    });
    const authHeader = (await loginAs(app, user.username)).authHeader;
    return {
      payload: {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        memberId: user.memberId,
      },
      memberId: member.id,
      authHeader,
    };
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    runSeed();
    prisma = app.get(PrismaService);
    authz = app.get(AuthzService);

    sectId = (
      await prisma.organization.findFirstOrThrow({ where: { code: 'SECT' }, select: { id: true } })
    ).id;
    const sectChild = await prisma.organization.create({
      data: { name: 'v0.49 SECT 子组', nodeTypeCode: 'group', parentId: sectId },
      select: { id: true },
    });
    sectChildId = sectChild.id;
    const sectAncestors = await prisma.organizationClosure.findMany({
      where: { descendantId: sectId },
      select: { ancestorId: true, depth: true },
    });
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: sectChildId, descendantId: sectChildId, depth: 0 },
        ...sectAncestors.map((row) => ({
          ancestorId: row.ancestorId,
          descendantId: sectChildId,
          depth: row.depth + 1,
        })),
      ],
    });

    inactiveOrgId = (
      await prisma.organization.create({
        data: {
          name: 'v0.49 已停用组织',
          nodeTypeCode: 'functional-dept',
          status: OrganizationStatus.INACTIVE,
        },
        select: { id: true },
      })
    ).id;
    await prisma.organizationClosure.create({
      data: { ancestorId: inactiveOrgId, descendantId: inactiveOrgId, depth: 0 },
    });

    vice = await mkPerson('vice');
    empty = await mkPerson('empty');
    directGlobal = await mkPerson('global');
    selfScoped = await mkPerson('self');
    expiredScoped = await mkPerson('expired');
    inactiveScoped = await mkPerson('inactive');
    supervised = await mkPerson('supervised');
    superAdminAuth = (await loginAs(app, SEED_ENV.SUPER_ADMIN_USERNAME)).authHeader;

    const viceCaptain = await prisma.organizationPosition.findFirstOrThrow({
      where: { code: 'vice-captain', deletedAt: null },
      select: { id: true },
    });
    await prisma.organizationPositionAssignment.create({
      data: {
        memberId: vice.memberId,
        organizationId: sectId,
        positionId: viceCaptain.id,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    const orgReadonly = await prisma.rbacRole.findFirstOrThrow({
      where: { code: 'org-readonly', deletedAt: null },
      select: { id: true },
    });
    await prisma.roleBinding.createMany({
      data: [
        {
          principalType: PrincipalType.USER,
          principalId: directGlobal.payload.id,
          roleId: orgReadonly.id,
          scopeType: BindingScopeType.GLOBAL,
        },
        {
          principalType: PrincipalType.USER,
          principalId: selfScoped.payload.id,
          roleId: orgReadonly.id,
          scopeType: BindingScopeType.SELF,
        },
        {
          principalType: PrincipalType.USER,
          principalId: inactiveScoped.payload.id,
          roleId: orgReadonly.id,
          scopeType: BindingScopeType.ORGANIZATION_TREE,
          scopeOrgId: inactiveOrgId,
        },
        {
          principalType: PrincipalType.USER,
          principalId: expiredScoped.payload.id,
          roleId: orgReadonly.id,
          scopeType: BindingScopeType.ORGANIZATION_TREE,
          scopeOrgId: sectId,
          startedAt: new Date('2019-01-01T00:00:00.000Z'),
          endedAt: new Date('2020-01-01T00:00:00.000Z'),
        },
      ],
    });
    await prisma.organizationSupervisionAssignment.create({
      data: {
        supervisorMemberId: supervised.memberId,
        organizationId: sectId,
        scopeMode: SupervisionScopeMode.TREE,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('副职 position policy 的 TREE scope 展开根与后代，且不含兄弟组织', async () => {
    const scope = await authz.getVisibleOrganizationScope(vice.payload, 'member.read.record');
    const expected = await prisma.organizationClosure.findMany({
      where: { ancestorId: sectId },
      select: { descendantId: true },
      orderBy: { descendantId: 'asc' },
    });
    expect(scope).toEqual({
      hasPermission: true,
      global: false,
      organizationIds: expected.map((row) => row.descendantId),
    });
    expect(scope.organizationIds).toContain(sectId);
    expect(scope.organizationIds).toContain(sectChildId);
  });

  it('GLOBAL passthrough；无码与有效非组织 scope 分别返回 forbidden 语义和保守空集', async () => {
    await expect(
      authz.getVisibleOrganizationScope(directGlobal.payload, 'member.read.record'),
    ).resolves.toEqual({ hasPermission: true, global: true, organizationIds: [] });
    await expect(
      authz.getVisibleOrganizationScope(empty.payload, 'member.read.record'),
    ).resolves.toEqual({ hasPermission: false, global: false, organizationIds: [] });
    await expect(
      authz.getVisibleOrganizationScope(expiredScoped.payload, 'member.read.record'),
    ).resolves.toEqual({ hasPermission: false, global: false, organizationIds: [] });
    await expect(
      authz.getVisibleOrganizationScope(selfScoped.payload, 'member.read.record'),
    ).resolves.toEqual({ hasPermission: true, global: false, organizationIds: [] });
  });

  it('有效 permission 绑定到 INACTIVE root 时保留 hasPermission，但组织集合为空', async () => {
    await expect(
      authz.getVisibleOrganizationScope(inactiveScoped.payload, 'member.read.record'),
    ).resolves.toEqual({ hasPermission: true, global: false, organizationIds: [] });
  });

  it('分管三源同样展开 TREE 可见范围', async () => {
    const scope = await authz.getVisibleOrganizationScope(supervised.payload, 'member.read.record');
    expect(scope.hasPermission).toBe(true);
    expect(scope.global).toBe(false);
    expect(scope.organizationIds).toEqual(expect.arrayContaining([sectId, sectChildId]));
  });

  it('derived-only 副职的新出口非空只读；旧 me/permissions 仍为空', async () => {
    const effective = await request(httpServer(app))
      .get('/api/system/v1/authz/me/effective-permissions')
      .set('Authorization', vice.authHeader);
    expect(effective.status).toBe(200);
    expect(effective.body.data.permissions.length).toBeGreaterThan(0);
    expect(effective.body.data.permissions).toEqual([...effective.body.data.permissions].sort());
    expect(
      effective.body.data.permissions.every(
        (code: string) =>
          !code.endsWith('.read.sensitive') &&
          (code.includes('.read.') || code.startsWith('attachment.view.')),
      ),
    ).toBe(true);

    const legacy = await request(httpServer(app))
      .get('/api/system/v1/rbac/me/permissions')
      .set('Authorization', vice.authHeader);
    expect(legacy.status).toBe(200);
    expect(legacy.body.data).toEqual({ permissions: [], effectiveRoles: [] });
  });

  it('effective permission 聚合同时覆盖 direct RoleBinding 与 supervision 来源', async () => {
    const directCodes = await authz.getEffectivePermissionCodes(selfScoped.payload);
    const supervisionCodes = await authz.getEffectivePermissionCodes(supervised.payload);
    expect(directCodes).toContain('member.read.record');
    expect(supervisionCodes).toContain('member.read.record');
    await expect(authz.getEffectivePermissionCodes(empty.payload)).resolves.toEqual([]);
  });

  it('SUPER_ADMIN 新出口返回 Permission.code 全集且未登录请求为 401', async () => {
    const expected = (
      await prisma.permission.findMany({ select: { code: true }, orderBy: { code: 'asc' } })
    ).map((row) => row.code);
    const res = await request(httpServer(app))
      .get('/api/system/v1/authz/me/effective-permissions')
      .set('Authorization', superAdminAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toEqual(expected);

    const unauthorized = await request(httpServer(app)).get(
      '/api/system/v1/authz/me/effective-permissions',
    );
    expectBizError(unauthorized, BizCode.UNAUTHORIZED);
  });
});
