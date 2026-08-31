import { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ServicePrincipalsService } from '../../src/modules/service-principals/service-principals.service';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

type CredentialFixture = {
  servicePrincipalId: string;
  credentialId: string;
  clientId: string;
  clientSecret: string;
};

describe('Integration Credential & Logging Hardening —— Client Credentials 失败归一', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let servicePrincipals: ServicePrincipalsService;
  let actor: CurrentUserPayload;

  const auditMeta = { requestId: 'integration-credential-hardening-e2e', ip: null, ua: 'jest' };

  beforeAll(async () => {
    process.env.INTEGRATION_API_ENABLED = 'true';
    process.env.INTEGRATION_JWT_SECRET = 'e2e-integration-secret-at-least-32-chars-ok!!';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    servicePrincipals = app.get(ServicePrincipalsService);

    const user = await prisma.user.create({
      data: {
        username: 'integration-credential-hardening-admin',
        passwordHash: TEST_PASSWORD_HASH,
        role: Role.SUPER_ADMIN,
      },
    });
    actor = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      memberId: user.memberId,
    };
  });

  afterAll(async () => {
    delete process.env.INTEGRATION_API_ENABLED;
    delete process.env.INTEGRATION_JWT_SECRET;
    await app.close();
  });

  async function createCredentialFixture(name: string): Promise<CredentialFixture> {
    const principal = await servicePrincipals.create({ name }, actor, auditMeta);
    const credential = await servicePrincipals.createCredential(principal.id, actor, auditMeta);
    return {
      servicePrincipalId: principal.id,
      credentialId: credential.id,
      clientId: principal.clientId,
      clientSecret: credential.clientSecret,
    };
  }

  async function expectCredentialInvalid(clientId: string, clientSecret: string): Promise<void> {
    const response = await request(httpServer(app))
      .post('/api/auth/v1/service-token')
      .auth(clientId, clientSecret, { type: 'basic' })
      .send();

    expect(response.status).toBe(BizCode.SERVICE_CREDENTIAL_INVALID.httpStatus);
    expect(response.body).toMatchObject({
      code: BizCode.SERVICE_CREDENTIAL_INVALID.code,
      message: BizCode.SERVICE_CREDENTIAL_INVALID.message,
      data: null,
    });
    expect(JSON.stringify(response.body)).not.toContain(clientSecret);
  }

  it('成功签发仍走原有 HTTP 契约，且不创建 refresh row', async () => {
    const fixture = await createCredentialFixture('PR-B 成功签发探针');
    const refreshBefore = await prisma.refreshToken.count();

    const response = await request(httpServer(app))
      .post('/api/auth/v1/service-token')
      .auth(fixture.clientId, fixture.clientSecret, { type: 'basic' })
      .send();

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ tokenType: 'Bearer' });
    expect(typeof response.body.data.accessToken).toBe('string');
    expect(response.body.data.expiresIn).toBeGreaterThan(0);
    expect(await prisma.refreshToken.count()).toBe(refreshBefore);
  });

  it('不存在的 clientId 统一返回 37010', async () => {
    const fixture = await createCredentialFixture('PR-B 不存在 clientId 探针');
    await expectCredentialInvalid(`${fixture.clientId}-missing`, fixture.clientSecret);
  });

  it('错误的 Secret 统一返回 37010', async () => {
    const fixture = await createCredentialFixture('PR-B 错误 Secret 探针');
    await expectCredentialInvalid(fixture.clientId, `${fixture.clientSecret}!`);
  });

  it('SUSPENDED 的 Service Principal 统一返回 37010', async () => {
    const fixture = await createCredentialFixture('PR-B SUSPENDED 探针');
    await servicePrincipals.updateStatus(fixture.servicePrincipalId, 'SUSPENDED', actor, auditMeta);
    await expectCredentialInvalid(fixture.clientId, fixture.clientSecret);
  });

  it('软删除的 Service Principal 统一返回 37010', async () => {
    const fixture = await createCredentialFixture('PR-B 软删除探针');
    await prisma.servicePrincipal.update({
      where: { id: fixture.servicePrincipalId },
      data: { deletedAt: new Date() },
    });
    await expectCredentialInvalid(fixture.clientId, fixture.clientSecret);
  });

  it('已撤销的 Credential 统一返回 37010', async () => {
    const fixture = await createCredentialFixture('PR-B 撤销凭据探针');
    await servicePrincipals.revokeCredential(
      fixture.servicePrincipalId,
      fixture.credentialId,
      actor,
      auditMeta,
    );
    await expectCredentialInvalid(fixture.clientId, fixture.clientSecret);
  });

  it('已过期的 Credential 统一返回 37010', async () => {
    const fixture = await createCredentialFixture('PR-B 过期凭据探针');
    await prisma.servicePrincipalCredential.update({
      where: { id: fixture.credentialId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await expectCredentialInvalid(fixture.clientId, fixture.clientSecret);
  });
});
