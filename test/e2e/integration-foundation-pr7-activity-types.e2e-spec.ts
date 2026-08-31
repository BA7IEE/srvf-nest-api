import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, PrincipalType, Role } from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { DelegationGrantsService } from '../../src/modules/delegation-grants/delegation-grants.service';
import { DelegatedTokenService } from '../../src/modules/integration-auth/delegated-token.service';
import { isControlPlanePermissionCode } from '../../src/modules/permissions/role-delegation.policy';
import { RbacRolesService } from '../../src/modules/permissions/rbac-roles.service';
import { RoleBindingsService } from '../../src/modules/role-bindings/role-bindings.service';
import { ServicePrincipalsService } from '../../src/modules/service-principals/service-principals.service';
import { loginAs } from '../fixtures/auth.fixture';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';

interface SeedRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runSeed(envOverrides: Record<string, string>): SeedRunResult {
  const envForChild = { ...process.env, ...envOverrides };
  assertTestDatabaseUrl(envForChild.DATABASE_URL);
  try {
    const stdout = execSync('pnpm tsx prisma/seed.ts', {
      env: envForChild,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as {
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      code: failed.status ?? -1,
      stdout: typeof failed.stdout === 'string' ? failed.stdout : (failed.stdout?.toString() ?? ''),
      stderr: typeof failed.stderr === 'string' ? failed.stderr : (failed.stderr?.toString() ?? ''),
    };
  }
}

describe('Integration Foundation v1 PR7 —— 首批机器权限资格门', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('seed 只开放 dict.read.item 给 Service，明确关闭 Delegated', async () => {
    const result = runSeed({
      APP_ENV: 'test',
      SUPER_ADMIN_USERNAME: 'if-pr7-seed-su',
      SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
      SUPER_ADMIN_EMAIL: '',
      RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
    });
    expect(result.code).toBe(0);

    expect(isControlPlanePermissionCode('dict.read.item')).toBe(false);
    await expect(
      prisma.permission.findMany({
        where: { servicePrincipalAllowed: true },
        select: { code: true, delegatedAccessAllowed: true },
        orderBy: { code: 'asc' },
      }),
    ).resolves.toEqual([{ code: 'dict.read.item', delegatedAccessAllowed: false }]);
    await expect(
      prisma.permission.findMany({
        where: { delegatedAccessAllowed: true },
        select: { code: true },
      }),
    ).resolves.toEqual([]);
  }, 180_000);
});

describe('Integration Foundation v1 PR7 —— 活动类型只读业务接入', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let servicePrincipals: ServicePrincipalsService;
  let delegatedTokens: DelegatedTokenService;
  let delegationGrants: DelegationGrantsService;
  let rbacRoles: RbacRolesService;
  let roleBindings: RoleBindingsService;

  let admin: CurrentUserPayload;
  let humanAuth: string;
  let permissionId: string;
  let roleId: string;
  let organizationId: string;
  let servicePrincipalId: string;
  let credentialId: string;
  let clientId: string;
  let clientSecret: string;
  let serviceToken: string;
  let servicePrincipalSequence = 0;

  const auditMeta = { requestId: 'if-pr7-e2e', ip: null, ua: 'jest' };

  beforeAll(async () => {
    process.env.INTEGRATION_API_ENABLED = 'true';
    process.env.INTEGRATION_JWT_SECRET = 'e2e-integration-secret-at-least-32-chars-ok!!';

    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    servicePrincipals = app.get(ServicePrincipalsService);
    delegatedTokens = app.get(DelegatedTokenService);
    delegationGrants = app.get(DelegationGrantsService);
    rbacRoles = app.get(RbacRolesService);
    roleBindings = app.get(RoleBindingsService);

    const adminRow = await prisma.user.create({
      data: {
        username: 'if-pr7-admin',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.SUPER_ADMIN,
      },
    });
    admin = {
      id: adminRow.id,
      username: adminRow.username,
      role: adminRow.role,
      status: adminRow.status,
      memberId: adminRow.memberId,
    };
    humanAuth = (await loginAs(app, adminRow.username)).authHeader;

    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: activityType.id, code: 'rescue', label: '救援', sortOrder: 20 },
        { typeId: activityType.id, code: 'medical', label: '医疗', sortOrder: 20 },
        { typeId: activityType.id, code: 'training', label: '培训', sortOrder: 10 },
        {
          typeId: activityType.id,
          code: 'retired',
          label: '已停用类型',
          sortOrder: 0,
          status: 'INACTIVE',
        },
      ],
    });

    const permission = await prisma.permission.create({
      data: {
        code: 'dict.read.item',
        module: 'dict',
        action: 'read',
        resourceType: 'item',
        servicePrincipalAllowed: true,
        delegatedAccessAllowed: false,
      },
    });
    permissionId = permission.id;
    const role = await prisma.rbacRole.create({
      data: { code: 'if-pr7-activity-type-reader', displayName: 'PR7 活动类型读取' },
    });
    roleId = role.id;
    await prisma.rolePermission.create({ data: { roleId, permissionId } });

    const organization = await prisma.organization.create({
      data: { name: 'PR7 范围探针组织', nodeTypeCode: 'functional-dept' },
    });
    organizationId = organization.id;

    const principal = await createServicePrincipal(BindingScopeType.GLOBAL);
    servicePrincipalId = principal.id;
    credentialId = principal.credentialId;
    clientId = principal.clientId;
    clientSecret = principal.clientSecret;
    serviceToken = await issueServiceToken(clientId, clientSecret);
  });

  afterAll(async () => {
    delete process.env.INTEGRATION_API_ENABLED;
    delete process.env.INTEGRATION_JWT_SECRET;
    await app.close();
  });

  async function createServicePrincipal(
    scopeType: BindingScopeType | null,
  ): Promise<{ id: string; credentialId: string; clientId: string; clientSecret: string }> {
    const principal = await servicePrincipals.create(
      { name: `PR7 读取系统 ${++servicePrincipalSequence}` },
      admin,
      auditMeta,
    );
    const credential = await servicePrincipals.createCredential(principal.id, admin, auditMeta);
    if (scopeType !== null) {
      await prisma.roleBinding.create({
        data: {
          principalType: PrincipalType.SERVICE_PRINCIPAL,
          principalId: principal.id,
          roleId,
          scopeType,
          scopeOrgId: scopeType === BindingScopeType.ORGANIZATION ? organizationId : null,
          createdByUserId: admin.id,
        },
      });
    }
    return {
      id: principal.id,
      credentialId: credential.id,
      clientId: principal.clientId,
      clientSecret: credential.clientSecret,
    };
  }

  async function issueServiceToken(id: string, secret: string): Promise<string> {
    const response = await request(httpServer(app))
      .post('/api/auth/v1/service-token')
      .auth(id, secret, { type: 'basic' })
      .send();
    expect(response.status).toBe(201);
    return response.body.data.accessToken as string;
  }

  it('只返回 ACTIVE 活动类型的最小字段集，并执行标准分页', async () => {
    const response = await request(httpServer(app))
      .get('/api/integration/v1/reference/activity-types')
      .query({ page: 1, pageSize: 1 })
      .set('Authorization', `Bearer ${serviceToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({
      items: [{ code: 'training', label: '培训', sortOrder: 10 }],
      total: 3,
      page: 1,
      pageSize: 1,
    });
    const firstItem = response.body.data.items[0] as Record<string, unknown>;
    expect(Object.keys(firstItem).sort()).toEqual(['code', 'label', 'sortOrder']);
  });

  it('没有 Body subject 输入，也不为纯 GET 写入审计', async () => {
    const auditBefore = await prisma.auditLog.count();
    const response = await request(httpServer(app))
      .get('/api/integration/v1/reference/activity-types')
      .query({ page: 1, pageSize: 20 })
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ subjectUserId: 'caller-controlled-but-unused' });

    expect(response.status).toBe(200);
    expect(response.body.data.items).toEqual([
      { code: 'training', label: '培训', sortOrder: 10 },
      { code: 'medical', label: '医疗', sortOrder: 20 },
      { code: 'rescue', label: '救援', sortOrder: 20 },
    ]);
    expect(await prisma.auditLog.count()).toBe(auditBefore);
  });

  it('无 direct binding、或只有局部 scope 的 Service 均被拒绝', async () => {
    const unbound = await createServicePrincipal(null);
    const unboundResponse = await request(httpServer(app))
      .get('/api/integration/v1/reference/activity-types')
      .set(
        'Authorization',
        `Bearer ${await issueServiceToken(unbound.clientId, unbound.clientSecret)}`,
      );
    expect(unboundResponse.status).toBe(BizCode.RBAC_FORBIDDEN.httpStatus);
    expect(unboundResponse.body.code).toBe(BizCode.RBAC_FORBIDDEN.code);

    const localScope = await createServicePrincipal(BindingScopeType.ORGANIZATION);
    const localScopeResponse = await request(httpServer(app))
      .get('/api/integration/v1/reference/activity-types')
      .set(
        'Authorization',
        `Bearer ${await issueServiceToken(localScope.clientId, localScope.clientSecret)}`,
      );
    expect(localScopeResponse.status).toBe(BizCode.RBAC_FORBIDDEN.httpStatus);
    expect(localScopeResponse.body.code).toBe(BizCode.RBAC_FORBIDDEN.code);
  });

  it('servicePrincipalAllowed 在每次请求运行时复核', async () => {
    await prisma.permission.update({
      where: { id: permissionId },
      data: { servicePrincipalAllowed: false, delegatedAccessAllowed: false },
    });
    try {
      const response = await request(httpServer(app))
        .get('/api/integration/v1/reference/activity-types')
        .set('Authorization', `Bearer ${serviceToken}`);
      expect(response.status).toBe(BizCode.RBAC_FORBIDDEN.httpStatus);
      expect(response.body.code).toBe(BizCode.RBAC_FORBIDDEN.code);
    } finally {
      await prisma.permission.update({
        where: { id: permissionId },
        data: { servicePrincipalAllowed: true, delegatedAccessAllowed: false },
      });
    }
  });

  it('Delegated 与 Human bearer 都不能进入 Service-only 业务面', async () => {
    const subject = await prisma.user.create({
      data: { username: 'if-pr7-delegated-subject', passwordHash: TEST_PASSWORD_HASH },
    });
    const delegatedPermission = await prisma.permission.create({
      data: {
        code: 'if-pr7.delegated.probe',
        module: 'if-pr7',
        action: 'delegated',
        resourceType: 'probe',
        servicePrincipalAllowed: true,
        delegatedAccessAllowed: true,
      },
    });
    const grant = await delegationGrants.create(
      admin,
      {
        servicePrincipalId,
        subjectUserId: subject.id,
        permissionCodes: [delegatedPermission.code],
        scopeType: BindingScopeType.GLOBAL,
      },
      auditMeta,
    );
    const delegated = await delegatedTokens.issueToken(servicePrincipalId, credentialId, grant.id);

    const delegatedResponse = await request(httpServer(app))
      .get('/api/integration/v1/reference/activity-types')
      .set('Authorization', `Bearer ${delegated.accessToken}`);
    expect(delegatedResponse.status).toBe(BizCode.PRINCIPAL_KIND_FORBIDDEN.httpStatus);
    expect(delegatedResponse.body.code).toBe(BizCode.PRINCIPAL_KIND_FORBIDDEN.code);

    const humanResponse = await request(httpServer(app))
      .get('/api/integration/v1/reference/activity-types')
      .set('Authorization', humanAuth);
    expect(humanResponse.status).toBe(BizCode.INTEGRATION_TOKEN_INVALID.httpStatus);
    expect(humanResponse.body.code).toBe(BizCode.INTEGRATION_TOKEN_INVALID.code);
  });

  it('历史脏状态下，已签发 Service Token 的下一次业务请求必须 fail-closed 且零副作用', async () => {
    const injectedDeletedAt = new Date('2026-08-31T12:34:56.000Z');
    const before = await request(httpServer(app))
      .get('/api/integration/v1/reference/activity-types')
      .set('Authorization', `Bearer ${serviceToken}`);
    expect(before.status).toBe(200);

    const binding = await prisma.roleBinding.findFirstOrThrow({
      where: {
        principalType: PrincipalType.SERVICE_PRINCIPAL,
        principalId: servicePrincipalId,
        roleId,
        deletedAt: null,
      },
      select: { id: true },
    });
    const auditBefore = await prisma.auditLog.count();
    try {
      // 只构造历史脏状态；正常生产删除必须先显式撤销 Binding，再走 RbacRolesService。
      await prisma.rbacRole.update({
        where: { id: roleId },
        data: { deletedAt: injectedDeletedAt },
      });

      const denied = await request(httpServer(app))
        .get('/api/integration/v1/reference/activity-types')
        .set('Authorization', `Bearer ${serviceToken}`);
      expect(denied.status).toBe(BizCode.RBAC_FORBIDDEN.httpStatus);
      expect(denied.body.code).toBe(BizCode.RBAC_FORBIDDEN.code);

      const [observedRole, observedBinding, auditAfter] = await Promise.all([
        prisma.rbacRole.findUnique({ where: { id: roleId }, select: { deletedAt: true } }),
        prisma.roleBinding.findUnique({ where: { id: binding.id }, select: { deletedAt: true } }),
        prisma.auditLog.count(),
      ]);
      expect(observedRole).toEqual({ deletedAt: injectedDeletedAt });
      expect(observedBinding).toEqual({ deletedAt: null });
      expect(auditAfter).toBe(auditBefore);
    } finally {
      await prisma.rbacRole.update({ where: { id: roleId }, data: { deletedAt: null } });
    }

    const restored = await request(httpServer(app))
      .get('/api/integration/v1/reference/activity-types')
      .set('Authorization', `Bearer ${serviceToken}`);
    expect(restored.status).toBe(200);
  });

  it('显式撤销全部服务主体 Binding 再软删角色后，同一 Service Token 的下一次业务授权请求拒绝', async () => {
    const before = await request(httpServer(app))
      .get('/api/integration/v1/reference/activity-types')
      .set('Authorization', `Bearer ${serviceToken}`);
    expect(before.status).toBe(200);

    const bindings = await prisma.roleBinding.findMany({
      where: {
        principalType: PrincipalType.SERVICE_PRINCIPAL,
        roleId,
        deletedAt: null,
      },
      select: { id: true },
    });
    for (const binding of bindings) {
      await roleBindings.remove(admin, binding.id, auditMeta);
    }
    await rbacRoles.softDelete(admin, roleId, auditMeta);

    const after = await request(httpServer(app))
      .get('/api/integration/v1/reference/activity-types')
      .set('Authorization', `Bearer ${serviceToken}`);
    expect(after.status).toBe(BizCode.RBAC_FORBIDDEN.httpStatus);
    expect(after.body.code).toBe(BizCode.RBAC_FORBIDDEN.code);
  });
});
