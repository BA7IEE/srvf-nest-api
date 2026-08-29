import { INestApplication } from '@nestjs/common';
import { BindingScopeType, Role } from '@prisma/client';
import request from 'supertest';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import { DelegationGrantRuntimeService } from '../../src/modules/delegation-grants/delegation-grant-runtime.service';
import { DelegationGrantsService } from '../../src/modules/delegation-grants/delegation-grants.service';
import { DelegatedTokenService } from '../../src/modules/integration-auth/delegated-token.service';
import { ServiceTokenService } from '../../src/modules/integration-auth/service-token.service';
import { ServicePrincipalsService } from '../../src/modules/service-principals/service-principals.service';
import { loginAs } from '../fixtures/auth.fixture';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

/**
 * Integration Foundation v1 PR5(规格书 §14/§19/§22–§26/§36/§61/§65.5):
 * - SP/User/Grant 三腿权限与范围交集；任一腿失效下一请求拒绝；
 * - Delegated Token subject 只能来自 Grant，且 expiry 不超过 Grant/Credential；
 * - 控制面创建/撤销与双主体 audit；Body 不能注入 subjectUserId；
 * - Audit 四种主体组合由 DB CHECK 与 read DTO 共同覆盖。
 */
describe('Integration Foundation v1 PR5 —— Delegation + Delegated Token + 双主体 Audit', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let runtime: DelegationGrantRuntimeService;
  let grantService: DelegationGrantsService;
  let servicePrincipals: ServicePrincipalsService;
  let serviceToken: ServiceTokenService;
  let delegatedToken: DelegatedTokenService;
  let auditLogs: AuditLogsService;

  let admin: CurrentUserPayload;
  let adminAuth: string;
  let subject: CurrentUserPayload;
  let servicePrincipalId: string;
  let credentialId: string;
  let clientId: string;
  let clientSecret: string;
  let otherServicePrincipalId: string;
  let otherCredentialId: string;
  let roleId: string;
  let permissionId: string;
  let organizationId: string;
  let outsideOrganizationId: string;
  let grantId: string;

  const action = 'pr5.test.read';
  const auditMeta = { requestId: 'if-pr5-e2e', ip: null, ua: 'jest' };

  beforeAll(async () => {
    process.env.INTEGRATION_API_ENABLED = 'true';
    process.env.INTEGRATION_JWT_SECRET = 'e2e-integration-secret-at-least-32-chars-ok!!';
    process.env.INTEGRATION_DELEGATED_TOKEN_EXPIRES_IN = '600';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    runtime = app.get(DelegationGrantRuntimeService);
    grantService = app.get(DelegationGrantsService);
    servicePrincipals = app.get(ServicePrincipalsService);
    serviceToken = app.get(ServiceTokenService);
    delegatedToken = app.get(DelegatedTokenService);
    auditLogs = app.get(AuditLogsService);

    const adminRow = await prisma.user.create({
      data: {
        username: 'if-pr5-admin',
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
    adminAuth = (await loginAs(app, adminRow.username)).authHeader;
    const subjectRow = await prisma.user.create({
      data: { username: 'if-pr5-subject', passwordHash: 'probe', role: Role.USER },
    });
    subject = {
      id: subjectRow.id,
      username: subjectRow.username,
      role: subjectRow.role,
      status: subjectRow.status,
      memberId: subjectRow.memberId,
    };

    const organization = await prisma.organization.create({
      data: { name: 'PR5 授权组织', nodeTypeCode: 'functional-dept' },
    });
    organizationId = organization.id;
    const outsideOrganization = await prisma.organization.create({
      data: { name: 'PR5 范围外组织', nodeTypeCode: 'functional-dept' },
    });
    outsideOrganizationId = outsideOrganization.id;

    const permission = await prisma.permission.create({
      data: {
        code: action,
        module: 'pr5',
        action: 'test',
        resourceType: 'read',
        servicePrincipalAllowed: true,
        delegatedAccessAllowed: true,
      },
    });
    permissionId = permission.id;
    const role = await prisma.rbacRole.create({
      data: { code: 'pr5-delegated-role', displayName: 'PR5 委托角色' },
    });
    roleId = role.id;
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });

    const servicePrincipal = await servicePrincipals.create(
      { name: 'PR5 探针系统' },
      admin,
      auditMeta,
    );
    servicePrincipalId = servicePrincipal.id;
    clientId = servicePrincipal.clientId;
    const credential = await servicePrincipals.createCredential(
      servicePrincipal.id,
      admin,
      auditMeta,
    );
    credentialId = credential.id;
    clientSecret = credential.clientSecret;

    const otherServicePrincipal = await servicePrincipals.create(
      { name: 'PR5 错主体探针' },
      admin,
      auditMeta,
    );
    otherServicePrincipalId = otherServicePrincipal.id;
    const otherCredential = await servicePrincipals.createCredential(
      otherServicePrincipal.id,
      admin,
      auditMeta,
    );
    otherCredentialId = otherCredential.id;

    // SP 与 Subject User 都只有同一个 ORGANIZATION 范围的角色绑定。
    await prisma.roleBinding.createMany({
      data: [
        {
          principalType: 'SERVICE_PRINCIPAL',
          principalId: servicePrincipalId,
          roleId,
          scopeType: BindingScopeType.ORGANIZATION,
          scopeOrgId: organizationId,
          status: 'ACTIVE',
          startedAt: new Date('2000-01-01T00:00:00.000Z'),
          createdByUserId: admin.id,
        },
        {
          principalType: 'SERVICE_PRINCIPAL',
          principalId: otherServicePrincipalId,
          roleId,
          scopeType: BindingScopeType.ORGANIZATION,
          scopeOrgId: organizationId,
          status: 'ACTIVE',
          startedAt: new Date('2000-01-01T00:00:00.000Z'),
          createdByUserId: admin.id,
        },
        {
          principalType: 'USER',
          principalId: subject.id,
          roleId,
          scopeType: BindingScopeType.ORGANIZATION,
          scopeOrgId: organizationId,
          status: 'ACTIVE',
          startedAt: new Date('2000-01-01T00:00:00.000Z'),
          createdByUserId: admin.id,
        },
      ],
    });

    const grant = await createGrant();
    grantId = grant.id;
  });

  afterAll(async () => {
    delete process.env.INTEGRATION_API_ENABLED;
    delete process.env.INTEGRATION_JWT_SECRET;
    delete process.env.INTEGRATION_DELEGATED_TOKEN_EXPIRES_IN;
    await app.close();
  });

  async function createGrant(
    overrides: Partial<{
      scopeType: Exclude<BindingScopeType, 'SELF'>;
      scopeOrgId: string | undefined;
      scopeActivityId: string | undefined;
      scopeResourceType: string | undefined;
      scopeResourceId: string | undefined;
      startedAt: string;
      endedAt: string;
    }> = {},
  ) {
    return grantService.create(
      admin,
      {
        servicePrincipalId,
        subjectUserId: subject.id,
        permissionCodes: [action],
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: organizationId,
        startedAt: '2000-01-01T00:00:00.000Z',
        ...overrides,
      },
      auditMeta,
    );
  }

  const judge = (overrides: Record<string, unknown> = {}) =>
    runtime.judgeDelegated({
      servicePrincipalId,
      credentialId,
      delegationGrantId: grantId,
      action,
      resourceRef: { type: 'organization', id: organizationId },
      ...overrides,
    });

  it('全交集通过：SP、Subject User、Grant 都覆盖解析后的真实资源', async () => {
    await expect(judge()).resolves.toMatchObject({ allowed: true, reason: 'allowed' });
  });

  it('Subject User 当前 Authz 失去范围后拒绝，不退化为 GLOBAL-only RBAC', async () => {
    await prisma.roleBinding.updateMany({
      where: { principalType: 'USER', principalId: subject.id },
      data: { status: 'SUSPENDED' },
    });
    await expect(judge()).resolves.toMatchObject({ allowed: false, reason: 'user-no-permission' });
    await prisma.roleBinding.updateMany({
      where: { principalType: 'USER', principalId: subject.id },
      data: { status: 'ACTIVE' },
    });
  });

  it('SP direct binding 失效后拒绝', async () => {
    await prisma.roleBinding.updateMany({
      where: { principalType: 'SERVICE_PRINCIPAL', principalId: servicePrincipalId },
      data: { status: 'SUSPENDED' },
    });
    await expect(judge()).resolves.toMatchObject({ allowed: false, reason: 'sp-no-permission' });
    await prisma.roleBinding.updateMany({
      where: { principalType: 'SERVICE_PRINCIPAL', principalId: servicePrincipalId },
      data: { status: 'ACTIVE' },
    });
  });

  it('Grant 未列入权限码时拒绝', async () => {
    await expect(judge({ action: 'pr5.test.ungranted' })).resolves.toMatchObject({
      allowed: false,
      reason: 'permission-not-in-grant',
    });
  });

  it('Grant 范围不覆盖真实资源时拒绝', async () => {
    const scopedGrant = await createGrant({
      scopeType: BindingScopeType.RESOURCE,
      scopeOrgId: undefined,
      scopeResourceType: 'organization',
      scopeResourceId: outsideOrganizationId,
    });
    await expect(judge({ delegationGrantId: scopedGrant.id })).resolves.toMatchObject({
      allowed: false,
      reason: 'grant-scope-not-covering',
    });
  });

  it('过期 Grant 下一请求立即拒绝', async () => {
    const expiredGrant = await createGrant({
      startedAt: '2000-01-01T00:00:00.000Z',
      endedAt: '2001-01-01T00:00:00.000Z',
    });
    await expect(judge({ delegationGrantId: expiredGrant.id })).resolves.toMatchObject({
      allowed: false,
      reason: 'grant-expired',
    });
  });

  it('尚未生效 Grant 下一请求立即拒绝', async () => {
    const futureGrant = await createGrant({ startedAt: '2099-01-01T00:00:00.000Z' });
    await expect(judge({ delegationGrantId: futureGrant.id })).resolves.toMatchObject({
      allowed: false,
      reason: 'grant-expired',
    });
  });

  it('撤销 Grant 后下一请求立即拒绝', async () => {
    const revocableGrant = await createGrant();
    await grantService.revoke(admin, revocableGrant.id, { reason: 'e2e revoke' }, auditMeta);
    await expect(judge({ delegationGrantId: revocableGrant.id })).resolves.toMatchObject({
      allowed: false,
      reason: 'grant-revoked',
    });
  });

  it('Subject User 停用或软删后拒绝', async () => {
    await prisma.user.update({ where: { id: subject.id }, data: { status: 'DISABLED' } });
    await expect(judge()).resolves.toMatchObject({ allowed: false, reason: 'user-inactive' });
    await prisma.user.update({ where: { id: subject.id }, data: { status: 'ACTIVE' } });

    await prisma.user.update({ where: { id: subject.id }, data: { deletedAt: new Date() } });
    await expect(judge()).resolves.toMatchObject({ allowed: false, reason: 'user-inactive' });
    await prisma.user.update({ where: { id: subject.id }, data: { deletedAt: null } });
  });

  it('SP 停用或软删后拒绝', async () => {
    await prisma.servicePrincipal.update({
      where: { id: servicePrincipalId },
      data: { status: 'SUSPENDED' },
    });
    await expect(judge()).resolves.toMatchObject({ allowed: false, reason: 'sp-suspended' });
    await prisma.servicePrincipal.update({
      where: { id: servicePrincipalId },
      data: { status: 'ACTIVE' },
    });

    await prisma.servicePrincipal.update({
      where: { id: servicePrincipalId },
      data: { deletedAt: new Date() },
    });
    await expect(judge()).resolves.toMatchObject({ allowed: false, reason: 'sp-not-found' });
    await prisma.servicePrincipal.update({
      where: { id: servicePrincipalId },
      data: { deletedAt: null },
    });
  });

  it('Credential 撤销或到期后拒绝', async () => {
    await prisma.servicePrincipalCredential.update({
      where: { id: credentialId },
      data: { revokedAt: new Date() },
    });
    await expect(judge()).resolves.toMatchObject({ allowed: false, reason: 'credential-invalid' });
    await prisma.servicePrincipalCredential.update({
      where: { id: credentialId },
      data: { revokedAt: null },
    });

    await prisma.servicePrincipalCredential.update({
      where: { id: credentialId },
      data: { expiresAt: new Date('2001-01-01T00:00:00.000Z') },
    });
    await expect(judge()).resolves.toMatchObject({ allowed: false, reason: 'credential-invalid' });
    await prisma.servicePrincipalCredential.update({
      where: { id: credentialId },
      data: { expiresAt: null },
    });
  });

  it('同一有效 Credential 换成另一个 SP 时，Grant 归属检查拒绝', async () => {
    await expect(
      judge({ servicePrincipalId: otherServicePrincipalId, credentialId: otherCredentialId }),
    ).resolves.toMatchObject({ allowed: false, reason: 'grant-wrong-sp' });
  });

  it('delegatedAccessAllowed 关闭后拒绝，且不违反 delegated ⇒ service 检查', async () => {
    await prisma.permission.update({
      where: { id: permissionId },
      data: { servicePrincipalAllowed: false, delegatedAccessAllowed: false },
    });
    await expect(judge()).resolves.toMatchObject({
      allowed: false,
      reason: 'permission-not-delegatable',
    });
    await prisma.permission.update({
      where: { id: permissionId },
      data: { servicePrincipalAllowed: true, delegatedAccessAllowed: true },
    });
  });

  it('Delegated Token 的 subject 只能来自 Grant，且 expiry 不超过 Grant', async () => {
    const shortGrant = await createGrant({
      endedAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const issued = await delegatedToken.issueToken(servicePrincipalId, credentialId, shortGrant.id);
    const payload = delegatedToken.verifyToken(issued.accessToken);
    expect(payload.tokenUse).toBe('delegated');
    expect(payload.sub).toBe(subject.id);
    expect(payload.act.sub).toBe(servicePrincipalId);
    expect(payload.delegationGrantId).toBe(shortGrant.id);
    expect(issued.expiresIn).toBeGreaterThan(0);
    expect(issued.expiresIn).toBeLessThanOrEqual(120);
  });

  it('HTTP Body 多传 subjectUserId 被拒，合法 Body 不会回显或接受该字段', async () => {
    const service = await serviceToken.issueToken(clientId, clientSecret);
    const injected = await request(httpServer(app))
      .post('/api/auth/v1/delegated-token')
      .set('Authorization', `Bearer ${service.accessToken}`)
      .send({ delegationGrantId: grantId, subjectUserId: admin.id });
    expect(injected.status).toBe(BizCode.BAD_REQUEST.httpStatus);
    expect(injected.body.code).toBe(BizCode.BAD_REQUEST.code);

    const valid = await request(httpServer(app))
      .post('/api/auth/v1/delegated-token')
      .set('Authorization', `Bearer ${service.accessToken}`)
      .send({ delegationGrantId: grantId });
    expect(valid.status).toBe(201);
    expect(valid.body.data).toMatchObject({ tokenType: 'Bearer' });
  });

  it('控制面 HTTP create/list/detail/revoke 与直接主体 Audit 一致', async () => {
    const created = await request(httpServer(app))
      .post('/api/system/v1/delegation-grants')
      .set('Authorization', adminAuth)
      .send({
        servicePrincipalId,
        subjectUserId: subject.id,
        permissionCodes: [action],
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: organizationId,
        startedAt: '2000-01-01T00:00:00.000Z',
      });
    expect(created.status).toBe(201);
    const controlGrant = created.body.data as { id: string; permissionCodes: string[] };
    expect(controlGrant.permissionCodes).toEqual([action]);

    const page = await request(httpServer(app))
      .get('/api/system/v1/delegation-grants?page=1&pageSize=100')
      .set('Authorization', adminAuth);
    expect(page.status).toBe(200);
    expect(page.body.data.items.map((item: { id: string }) => item.id)).toContain(controlGrant.id);

    const detail = await request(httpServer(app))
      .get(`/api/system/v1/delegation-grants/${controlGrant.id}`)
      .set('Authorization', adminAuth);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ id: controlGrant.id, permissionCodes: [action] });

    const revoked = await request(httpServer(app))
      .post(`/api/system/v1/delegation-grants/${controlGrant.id}/revoke`)
      .set('Authorization', adminAuth)
      .send({ reason: 'audit probe' });
    expect(revoked.status).toBe(200);
    expect(revoked.body.data.status).toBe('REVOKED');

    const createAudit = await prisma.auditLog.findFirstOrThrow({
      where: { event: 'delegation-grant.create', resourceId: controlGrant.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(createAudit.actorUserId).toBe(admin.id);
    expect(createAudit.actorServicePrincipalId).toBeNull();
    expect(createAudit.actorCredentialId).toBeNull();
    expect(createAudit.onBehalfOfUserId).toBeNull();
    expect(createAudit.onBehalfOfRoleSnap).toBeNull();
  });

  it('Audit writer/read DTO 区分机器自身与机器代人，DB CHECK 拦截全部非法主体组合', async () => {
    const service = await serviceToken.issueToken(clientId, clientSecret);
    const delegated = await delegatedToken.issueToken(servicePrincipalId, credentialId, grantId);
    expect(service.accessToken).not.toBe('');
    expect(delegated.accessToken).not.toBe('');

    const serviceAudit = await prisma.auditLog.findFirstOrThrow({
      where: { event: 'auth.service-token', actorCredentialId: credentialId },
      orderBy: { createdAt: 'desc' },
    });
    expect(serviceAudit.actorUserId).toBeNull();
    expect(serviceAudit.actorServicePrincipalId).toBe(servicePrincipalId);
    expect(serviceAudit.actorCredentialId).toBe(credentialId);
    expect(serviceAudit.onBehalfOfUserId).toBeNull();

    const delegatedAudit = await prisma.auditLog.findFirstOrThrow({
      where: { event: 'auth.delegated-token', resourceId: grantId },
      orderBy: { createdAt: 'desc' },
    });
    const response = await auditLogs.findOne(delegatedAudit.id, admin);
    expect(response.actorUserId).toBeNull();
    expect(response.actorServicePrincipalId).toBe(servicePrincipalId);
    expect(response.actorCredentialId).toBe(credentialId);
    expect(response.onBehalfOfUserId).toBe(subject.id);
    expect(response.onBehalfOfRoleSnap).toBe(Role.USER);

    await prisma.auditLog.create({
      data: {
        actorUserId: null,
        actorRoleSnap: null,
        actorServicePrincipalId: null,
        actorCredentialId: null,
        onBehalfOfUserId: null,
        onBehalfOfRoleSnap: null,
        resourceType: 'system',
        resourceId: null,
        event: 'system.pr5-probe',
        context: { requestId: 'if-pr5-system', ip: null, ua: null },
      },
    });
    await expect(
      prisma.auditLog.create({
        data: {
          actorUserId: admin.id,
          actorRoleSnap: admin.role,
          actorServicePrincipalId: servicePrincipalId,
          resourceType: 'delegation-grant',
          resourceId: grantId,
          event: 'auth.delegated-token',
          context: { requestId: 'if-pr5-invalid', ip: null, ua: null },
        },
      }),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      prisma.auditLog.create({
        data: {
          resourceType: 'system',
          resourceId: null,
          event: 'system.pr5-probe',
          context: { requestId: 'if-pr5-invalid-on-behalf', ip: null, ua: null },
          onBehalfOfUserId: subject.id,
        },
      }),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      prisma.auditLog.create({
        data: {
          resourceType: 'system',
          resourceId: null,
          event: 'system.pr5-probe',
          context: { requestId: 'if-pr5-invalid-credential', ip: null, ua: null },
          actorCredentialId: credentialId,
        },
      }),
    ).rejects.toThrow(/check constraint/i);
    await expect(
      prisma.auditLog.create({
        data: {
          resourceType: 'system',
          resourceId: null,
          event: 'system.pr5-probe',
          context: { requestId: 'if-pr5-invalid-role', ip: null, ua: null },
          onBehalfOfRoleSnap: Role.USER,
        },
      }),
    ).rejects.toThrow(/check constraint/i);
  });
});
