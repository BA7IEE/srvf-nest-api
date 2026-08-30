import { INestApplication } from '@nestjs/common';
import { BindingScopeType, Role } from '@prisma/client';
import request from 'supertest';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { DelegationGrantsService } from '../../src/modules/delegation-grants/delegation-grants.service';
import { DelegatedTokenService } from '../../src/modules/integration-auth/delegated-token.service';
import { ServiceTokenService } from '../../src/modules/integration-auth/service-token.service';
import {
  defineIntegrationOperation,
  IntegrationIdempotencyService,
} from '../../src/modules/integration-idempotency/integration-idempotency.service';
import { ServicePrincipalsService } from '../../src/modules/service-principals/service-principals.service';
import { loginAs } from '../fixtures/auth.fixture';
import { TEST_PASSWORD_HASH } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const CREATE_PROBE = defineIntegrationOperation('pr6.probe.create');
const CONCURRENT_PROBE = defineIntegrationOperation('pr6.probe.concurrent');
const FAILURE_PROBE = defineIntegrationOperation('pr6.probe.failure');
const SENSITIVE_PROBE = defineIntegrationOperation('pr6.probe.sensitive-snapshot');
const ISOLATION_PROBE_A = defineIntegrationOperation('pr6.probe.isolation-a');
const ISOLATION_PROBE_B = defineIntegrationOperation('pr6.probe.isolation-b');

describe('Integration Foundation v1 PR6 —— 第六 Surface + /me + 幂等地基', () => {
  let app: INestApplication;
  let disabledApp: INestApplication;
  let prisma: PrismaService;
  let servicePrincipals: ServicePrincipalsService;
  let serviceTokens: ServiceTokenService;
  let delegatedTokens: DelegatedTokenService;
  let delegationGrants: DelegationGrantsService;
  let idempotency: IntegrationIdempotencyService;

  let admin: CurrentUserPayload;
  let humanAuth: string;
  let servicePrincipalId: string;
  let credentialId: string;
  let clientId: string;
  let clientSecret: string;
  let otherServicePrincipalId: string;
  let otherCredentialId: string;
  let subjectUserId: string;
  let grantId: string;

  const auditMeta = { requestId: 'if-pr6-e2e', ip: null, ua: 'jest' };

  beforeAll(async () => {
    process.env.INTEGRATION_JWT_SECRET = 'e2e-integration-secret-at-least-32-chars-ok!!';

    process.env.INTEGRATION_API_ENABLED = 'false';
    disabledApp = await createTestApp();

    process.env.INTEGRATION_API_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    servicePrincipals = app.get(ServicePrincipalsService);
    serviceTokens = app.get(ServiceTokenService);
    delegatedTokens = app.get(DelegatedTokenService);
    delegationGrants = app.get(DelegationGrantsService);
    idempotency = app.get(IntegrationIdempotencyService);

    const adminRow = await prisma.user.create({
      data: {
        username: 'if-pr6-admin',
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

    const subject = await prisma.user.create({
      data: { username: 'if-pr6-subject', passwordHash: 'probe', role: Role.USER },
    });
    subjectUserId = subject.id;

    const principal = await servicePrincipals.create({ name: 'PR6 探针系统' }, admin, auditMeta);
    servicePrincipalId = principal.id;
    clientId = principal.clientId;
    const credential = await servicePrincipals.createCredential(principal.id, admin, auditMeta);
    credentialId = credential.id;
    clientSecret = credential.clientSecret;

    const other = await servicePrincipals.create({ name: 'PR6 隔离探针' }, admin, auditMeta);
    otherServicePrincipalId = other.id;
    const otherCredential = await servicePrincipals.createCredential(other.id, admin, auditMeta);
    otherCredentialId = otherCredential.id;

    const permission = await prisma.permission.create({
      data: {
        code: 'pr6.test.delegate',
        module: 'pr6',
        action: 'test',
        resourceType: 'probe',
        servicePrincipalAllowed: true,
        delegatedAccessAllowed: true,
      },
    });
    const grant = await delegationGrants.create(
      admin,
      {
        servicePrincipalId,
        subjectUserId,
        permissionCodes: [permission.code],
        scopeType: BindingScopeType.GLOBAL,
      },
      auditMeta,
    );
    grantId = grant.id;
  });

  afterAll(async () => {
    delete process.env.INTEGRATION_API_ENABLED;
    delete process.env.INTEGRATION_JWT_SECRET;
    await app.close();
    await disabledApp.close();
  });

  async function issueServiceTokenOverHttp(): Promise<string> {
    const response = await request(httpServer(app))
      .post('/api/auth/v1/service-token')
      .auth(clientId, clientSecret, { type: 'basic' })
      .send();
    expect(response.status).toBe(201);
    return response.body.data.accessToken as string;
  }

  it('/me 对 Service 与 Delegated 只返最小身份，Human Token 与错主体均拒绝', async () => {
    const refreshBefore = await prisma.refreshToken.count();
    const serviceToken = await issueServiceTokenOverHttp();
    const serviceMe = await request(httpServer(app))
      .get('/api/integration/v1/me')
      .set('Authorization', `Bearer ${serviceToken}`);
    expect(serviceMe.status).toBe(200);
    expect(serviceMe.body.data).toEqual({
      principalKind: 'SERVICE',
      servicePrincipal: { clientId, name: 'PR6 探针系统' },
      delegated: false,
    });

    const delegated = await request(httpServer(app))
      .post('/api/auth/v1/delegated-token')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ delegationGrantId: grantId });
    expect(delegated.status).toBe(201);
    const delegatedToken = delegated.body.data.accessToken as string;
    const delegatedMe = await request(httpServer(app))
      .get('/api/integration/v1/me')
      .set('Authorization', `Bearer ${delegatedToken}`);
    expect(delegatedMe.status).toBe(200);
    expect(delegatedMe.body.data).toEqual({
      principalKind: 'DELEGATED',
      servicePrincipal: { clientId, name: 'PR6 探针系统' },
      delegated: true,
    });
    expect(JSON.stringify(delegatedMe.body.data)).not.toMatch(
      /permission|roleBinding|secret|hash|username|phone|subject/i,
    );

    const human = await request(httpServer(app))
      .get('/api/integration/v1/me')
      .set('Authorization', humanAuth);
    expect(human.status).toBe(BizCode.INTEGRATION_TOKEN_INVALID.httpStatus);
    expect(human.body.code).toBe(BizCode.INTEGRATION_TOKEN_INVALID.code);

    const wrongKind = await request(httpServer(app))
      .post('/api/auth/v1/delegated-token')
      .set('Authorization', `Bearer ${delegatedToken}`)
      .send({ delegationGrantId: grantId });
    expect(wrongKind.status).toBe(BizCode.PRINCIPAL_KIND_FORBIDDEN.httpStatus);
    expect(wrongKind.body.code).toBe(BizCode.PRINCIPAL_KIND_FORBIDDEN.code);

    const refreshAfter = await prisma.refreshToken.count();
    expect(refreshAfter).toBe(refreshBefore);
  });

  it('Integration Token 不能进入既有 Human route，撤销事实在下一请求生效', async () => {
    const serviceToken = await issueServiceTokenOverHttp();
    const humanOnly = await request(httpServer(app))
      .get('/api/admin/v1/me')
      .set('Authorization', `Bearer ${serviceToken}`);
    expect(humanOnly.status).toBe(BizCode.UNAUTHORIZED.httpStatus);
    expect(humanOnly.body.code).toBe(BizCode.UNAUTHORIZED.code);

    await prisma.servicePrincipalCredential.update({
      where: { id: credentialId },
      data: { revokedAt: new Date() },
    });
    const revoked = await request(httpServer(app))
      .get('/api/integration/v1/me')
      .set('Authorization', `Bearer ${serviceToken}`);
    expect(revoked.status).toBe(BizCode.INTEGRATION_TOKEN_INVALID.httpStatus);
    expect(revoked.body.code).toBe(BizCode.INTEGRATION_TOKEN_INVALID.code);
    await prisma.servicePrincipalCredential.update({
      where: { id: credentialId },
      data: { revokedAt: null },
    });
  });

  it('Gate=false 时 token 签发与 Integration surface 都 fail-closed 为 37030', async () => {
    const issuance = await request(httpServer(disabledApp))
      .post('/api/auth/v1/service-token')
      .auth('srvf_sp_disabled', 'invalid-secret', { type: 'basic' })
      .send();
    expect(issuance.status).toBe(BizCode.INTEGRATION_API_DISABLED.httpStatus);
    expect(issuance.body.code).toBe(BizCode.INTEGRATION_API_DISABLED.code);

    const surface = await request(httpServer(disabledApp))
      .get('/api/integration/v1/me')
      .set('Authorization', 'Bearer invalid-token');
    expect(surface.status).toBe(BizCode.INTEGRATION_API_DISABLED.httpStatus);
    expect(surface.body.code).toBe(BizCode.INTEGRATION_API_DISABLED.code);
  });

  it('Integration Token 验证只接受签发约定的 HS256', () => {
    const serviceToken = serviceTokens['jwtService'].sign(
      { tokenUse: 'service', credentialId },
      {
        algorithm: 'HS512',
        subject: servicePrincipalId,
        issuer: 'srvf-dp',
        audience: 'srvf-integration',
        jwtid: 'pr6-hs512-service',
        expiresIn: 60,
      },
    );
    const delegatedToken = delegatedTokens['jwt'].sign(
      {
        tokenUse: 'delegated',
        credentialId,
        delegationGrantId: grantId,
        act: { sub: servicePrincipalId },
      },
      {
        algorithm: 'HS512',
        subject: subjectUserId,
        issuer: 'srvf-dp',
        audience: 'srvf-integration',
        jwtid: 'pr6-hs512-delegated',
        expiresIn: 60,
      },
    );

    const expectInvalidToken = (verify: () => unknown): void => {
      let caught: unknown;
      try {
        verify();
      } catch (error) {
        caught = error;
      }
      expect((caught as { biz?: { code?: number } })?.biz?.code).toBe(
        BizCode.INTEGRATION_TOKEN_INVALID.code,
      );
    };
    expectInvalidToken(() => serviceTokens.verifyToken(serviceToken));
    expectInvalidToken(() => delegatedTokens.verifyToken(delegatedToken));
  });

  it('幂等首次成功、同 hash 重放、不同 hash 冲突', async () => {
    let executions = 0;
    const invoke = (requestBody: { value: number }) =>
      idempotency.execute({
        principal: { servicePrincipalId, credentialId },
        operation: CREATE_PROBE,
        idempotencyKey: 'pr6-first-replay',
        request: requestBody,
        command: async (tx) => {
          executions++;
          const row = await tx.organization.create({
            data: { name: 'PR6 首次/重放业务行', nodeTypeCode: 'functional-dept' },
          });
          return { response: { id: row.id }, resourceType: 'organization', resourceId: row.id };
        },
      });

    const first = await invoke({ value: 1 });
    const replay = await invoke({ value: 1 });
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ response: first.response, replayed: true });
    expect(executions).toBe(1);
    await expect(invoke({ value: 2 })).rejects.toMatchObject({
      biz: BizCode.IDEMPOTENCY_KEY_CONFLICT,
    });
  });

  it('20 个并发同请求只执行一次领域写、只留一条 receipt', async () => {
    let executions = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        idempotency.execute({
          principal: { servicePrincipalId, credentialId },
          operation: CONCURRENT_PROBE,
          idempotencyKey: 'pr6-concurrent-20',
          request: { value: 'same' },
          command: async (tx) => {
            executions++;
            const row = await tx.organization.create({
              data: { name: 'PR6 并发唯一业务行', nodeTypeCode: 'functional-dept' },
            });
            return { response: { id: row.id }, resourceType: 'organization', resourceId: row.id };
          },
        }),
      ),
    );
    expect(executions).toBe(1);
    expect(results.filter((item) => item.replayed)).toHaveLength(19);
    expect(
      await prisma.integrationCommandReceipt.count({
        where: { servicePrincipalId, operation: CONCURRENT_PROBE },
      }),
    ).toBe(1);
    expect(await prisma.organization.count({ where: { name: 'PR6 并发唯一业务行' } })).toBe(1);
  });

  it('领域命令失败时业务与 receipt 同事务回滚', async () => {
    await expect(
      idempotency.execute({
        principal: { servicePrincipalId, credentialId },
        operation: FAILURE_PROBE,
        idempotencyKey: 'pr6-failure-rollback',
        request: { value: 'rollback' },
        command: async (tx) => {
          await tx.organization.create({
            data: { name: 'PR6 应回滚业务行', nodeTypeCode: 'functional-dept' },
          });
          throw new Error('expected probe failure');
        },
      }),
    ).rejects.toThrow('expected probe failure');
    expect(
      await prisma.integrationCommandReceipt.count({
        where: { servicePrincipalId, operation: FAILURE_PROBE },
      }),
    ).toBe(0);
    expect(await prisma.organization.count({ where: { name: 'PR6 应回滚业务行' } })).toBe(0);
  });

  it('首次写与重放两侧都拒绝含敏感键的 response snapshot', async () => {
    await expect(
      idempotency.execute({
        principal: { servicePrincipalId, credentialId },
        operation: SENSITIVE_PROBE,
        idempotencyKey: 'pr6-sensitive-write',
        request: { value: 'unsafe' },
        command: async () => ({ response: { accessToken: 'redacted-probe' } }),
      }),
    ).rejects.toThrow('forbidden sensitive field');
    expect(
      await prisma.integrationCommandReceipt.count({
        where: {
          servicePrincipalId,
          operation: SENSITIVE_PROBE,
          idempotencyKey: 'pr6-sensitive-write',
        },
      }),
    ).toBe(0);

    await expect(
      idempotency.execute({
        principal: { servicePrincipalId, credentialId },
        operation: SENSITIVE_PROBE,
        idempotencyKey: 'pr6-pii-write',
        request: { value: 'unsafe-pii' },
        command: async () => ({
          response: { subjectUser: { username: 'redacted-probe' } },
        }),
      }),
    ).rejects.toThrow('forbidden sensitive field');
    expect(
      await prisma.integrationCommandReceipt.count({
        where: {
          servicePrincipalId,
          operation: SENSITIVE_PROBE,
          idempotencyKey: 'pr6-pii-write',
        },
      }),
    ).toBe(0);

    let executions = 0;
    const invoke = () =>
      idempotency.execute({
        principal: { servicePrincipalId, credentialId },
        operation: SENSITIVE_PROBE,
        idempotencyKey: 'pr6-sensitive-replay',
        request: { value: 'same' },
        command: async () => {
          executions++;
          return { response: { ok: true } };
        },
      });
    await invoke();
    await prisma.integrationCommandReceipt.update({
      where: {
        servicePrincipalId_operation_idempotencyKey: {
          servicePrincipalId,
          operation: SENSITIVE_PROBE,
          idempotencyKey: 'pr6-sensitive-replay',
        },
      },
      data: { responseSnapshot: { accessToken: 'redacted-probe' } },
    });
    await expect(invoke()).rejects.toThrow('forbidden sensitive field');
    expect(executions).toBe(1);
  });

  it('相同 key 在不同 SP 或同 SP 不同 operation 下互不影响', async () => {
    let executions = 0;
    const run = (principalId: string, credId: string, operation: typeof ISOLATION_PROBE_A) =>
      idempotency.execute({
        principal: { servicePrincipalId: principalId, credentialId: credId },
        operation,
        idempotencyKey: 'pr6-isolation-key',
        request: { value: 'same' },
        command: async () => {
          executions++;
          return { response: { sequence: executions } };
        },
      });

    await run(servicePrincipalId, credentialId, ISOLATION_PROBE_A);
    await run(otherServicePrincipalId, otherCredentialId, ISOLATION_PROBE_A);
    await run(servicePrincipalId, credentialId, ISOLATION_PROBE_B);
    expect(executions).toBe(3);
  });

  it('Delegated receipt 把 Grant/Subject 纳入 hash，但 Credential 轮换不分裂幂等域', async () => {
    const issued = await delegatedTokens.issueToken(servicePrincipalId, credentialId, grantId);
    const delegated = await delegatedTokens.resolvePrincipal(issued.accessToken);
    expect(delegated.subjectUser.id).toBe(subjectUserId);

    const rotated = await servicePrincipals.createCredential(servicePrincipalId, admin, auditMeta);
    let executions = 0;
    const run = (credId: string, effectiveGrantId: string, effectiveSubjectId: string) =>
      idempotency.execute({
        principal: {
          servicePrincipalId,
          credentialId: credId,
          delegationGrantId: effectiveGrantId,
          subjectUserId: effectiveSubjectId,
        },
        operation: defineIntegrationOperation('pr6.probe.delegated'),
        idempotencyKey: 'pr6-delegated-context',
        request: { value: 'same' },
        command: async () => {
          executions++;
          return { response: { ok: true } };
        },
      });

    await run(credentialId, grantId, subjectUserId);
    const replay = await run(rotated.id, grantId, subjectUserId);
    expect(replay.replayed).toBe(true);
    expect(executions).toBe(1);
    await expect(run(rotated.id, 'different-grant', subjectUserId)).rejects.toMatchObject({
      biz: BizCode.IDEMPOTENCY_KEY_CONFLICT,
    });
  });
});
