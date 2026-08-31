import { BizCode } from '../../common/exceptions/biz-code.constant';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ServicePrincipalsService } from '../service-principals/service-principals.service';
import { PrismaService } from '../../database/prisma.service';
import { IntegrationAuthGate } from './integration-auth.gate';
import { ServiceTokenService } from './service-token.service';

type CredentialLookup = {
  where: {
    secretHash: string;
    revokedAt: null;
    OR: [{ expiresAt: null }, { expiresAt: { gt: Date } }];
    servicePrincipal: {
      is: { clientId: string; deletedAt: null; status: 'ACTIVE' };
    };
  };
  select: { id: true; servicePrincipalId: true };
};

type CredentialRow = { id: string; servicePrincipalId: string };

function buildService(options: { enabled?: boolean; credential?: CredentialRow | null } = {}) {
  const credentialFindFirst = jest
    .fn<Promise<CredentialRow | null>, [CredentialLookup]>()
    .mockResolvedValue(options.credential ?? null);
  const servicePrincipalFindFirst = jest.fn(() => {
    throw new Error('authenticateClientCredentials must not split into a ServicePrincipal lookup');
  });
  const prisma = {
    servicePrincipalCredential: { findFirst: credentialFindFirst },
    servicePrincipal: { findFirst: servicePrincipalFindFirst },
  };
  const gate = {
    isEnabled: jest.fn(() => options.enabled ?? true),
    jwtSecret: 'unit-test-integration-jwt-secret-at-least-32-chars',
  };
  const service = new ServiceTokenService(
    prisma as unknown as PrismaService,
    gate as unknown as IntegrationAuthGate,
    {} as ServicePrincipalsService,
    {} as AuditLogsService,
  );

  return { service, credentialFindFirst, servicePrincipalFindFirst, gate };
}

function expectCanonicalCredentialLookup(
  args: CredentialLookup,
  clientId: string,
  secretHash: string,
): void {
  expect(args.where.secretHash).toBe(secretHash);
  expect(args.where.revokedAt).toBeNull();
  expect(args.where.OR[0]).toEqual({ expiresAt: null });
  expect(args.where.OR[1].expiresAt.gt).toBeInstanceOf(Date);
  expect(args.where.servicePrincipal).toEqual({
    is: { clientId, deletedAt: null, status: 'ACTIVE' },
  });
  expect(args.select).toEqual({ id: true, servicePrincipalId: true });
}

describe('ServiceTokenService.authenticateClientCredentials — PR-B 凭据失败归一', () => {
  afterEach(() => jest.restoreAllMocks());

  it('五类 37010 失败都执行 hash，并只走一条 Credential→ServicePrincipal 关联查询', async () => {
    const { service, credentialFindFirst, servicePrincipalFindFirst } = buildService();
    const hashClientSecret = jest
      .spyOn(ServicePrincipalsService, 'hashClientSecret')
      .mockImplementation((value) => `hash:${value}`);
    const failureInputs = [
      { clientId: 'srvf_sp_missing', clientSecret: 'missing-client' },
      { clientId: 'srvf_sp_active', clientSecret: 'wrong-secret' },
      { clientId: 'srvf_sp_suspended', clientSecret: 'suspended-secret' },
      { clientId: 'srvf_sp_revoked', clientSecret: 'revoked-secret' },
      { clientId: 'srvf_sp_expired', clientSecret: 'expired-secret' },
    ] as const;

    for (const input of failureInputs) {
      await expect(
        service.authenticateClientCredentials(input.clientId, input.clientSecret),
      ).rejects.toMatchObject({
        biz: {
          code: BizCode.SERVICE_CREDENTIAL_INVALID.code,
          message: BizCode.SERVICE_CREDENTIAL_INVALID.message,
          httpStatus: BizCode.SERVICE_CREDENTIAL_INVALID.httpStatus,
        },
      });
    }

    expect(hashClientSecret).toHaveBeenCalledTimes(failureInputs.length);
    expect(credentialFindFirst).toHaveBeenCalledTimes(failureInputs.length);
    expect(servicePrincipalFindFirst).not.toHaveBeenCalled();
    failureInputs.forEach((input, index) => {
      expect(hashClientSecret).toHaveBeenNthCalledWith(index + 1, input.clientSecret);
      expectCanonicalCredentialLookup(
        credentialFindFirst.mock.calls[index]?.[0],
        input.clientId,
        `hash:${input.clientSecret}`,
      );
    });
  });

  it('唯一关联查询命中时仍返回原有的主体与凭据事实', async () => {
    const { service, credentialFindFirst } = buildService({
      credential: { id: 'credential-1', servicePrincipalId: 'principal-1' },
    });
    const hashClientSecret = jest
      .spyOn(ServicePrincipalsService, 'hashClientSecret')
      .mockReturnValue('known-hash');

    await expect(
      service.authenticateClientCredentials('srvf_sp_valid', 'valid-client-secret'),
    ).resolves.toEqual({ servicePrincipalId: 'principal-1', credentialId: 'credential-1' });
    expect(hashClientSecret).toHaveBeenCalledWith('valid-client-secret');
    expectCanonicalCredentialLookup(
      credentialFindFirst.mock.calls[0]?.[0],
      'srvf_sp_valid',
      'known-hash',
    );
  });

  it('Gate 关闭仍优先返回 37030，不进入凭据 hash 或查询路径', async () => {
    const { service, credentialFindFirst } = buildService({ enabled: false });
    const hashClientSecret = jest.spyOn(ServicePrincipalsService, 'hashClientSecret');

    await expect(
      service.authenticateClientCredentials('srvf_sp_disabled', 'ignored-while-gate-is-off'),
    ).rejects.toMatchObject({
      biz: {
        code: BizCode.INTEGRATION_API_DISABLED.code,
        message: BizCode.INTEGRATION_API_DISABLED.message,
        httpStatus: BizCode.INTEGRATION_API_DISABLED.httpStatus,
      },
    });
    expect(hashClientSecret).not.toHaveBeenCalled();
    expect(credentialFindFirst).not.toHaveBeenCalled();
  });
});
