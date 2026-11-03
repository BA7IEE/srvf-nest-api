import type { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { Role, UserStatus, type Prisma } from '@prisma/client';
import type { IncomingMessage } from 'node:http';
import request from 'supertest';

import { applyGlobalSetup } from '../../bootstrap/apply-global-setup';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { AuthzDeclarationGuard } from '../../common/guards/authz-declaration.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ThrottlerBizGuard } from '../../common/guards/throttler-biz.guard';
import { RolePermissionStepUpProofService } from '../../common/security/role-permission-step-up-proof';
import appConfig from '../../config/app.config';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { DelegatedTokenService } from '../integration-auth/delegated-token.service';
import { IntegrationJwtAuthGuard } from '../integration-auth/integration-jwt-auth.guard';
import { ServiceClientCredentialsGuard } from '../integration-auth/service-client-credentials.guard';
import { ServiceTokenService } from '../integration-auth/service-token.service';
import { httpServer } from '../../../test/helpers/http-server';
import { ServicePrincipalsModule } from './service-principals.module';
import { ServicePrincipalsService } from './service-principals.service';

const STOP = 'STOP_BEFORE_CLIENT_SECRET_GENERATION';
const user: CurrentUserPayload = {
  id: 'synthetic-user',
  username: 'synthetic-user',
  role: Role.USER,
  status: UserStatus.ACTIVE,
  memberId: null,
};
const date = new Date('2026-01-01T00:00:00.000Z');
const principal = {
  id: 'synthetic-principal',
  clientId: 'synthetic-client-id',
  name: 'Synthetic principal',
  description: null,
  status: 'ACTIVE',
  ownerOrganizationId: null,
  createdAt: date,
  updatedAt: date,
  deletedAt: null,
};
const credential = {
  id: 'synthetic-credential-metadata',
  servicePrincipalId: principal.id,
  createdAt: date,
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
};

// Authentication is deliberately synthetic. The real JwtAuthGuard still delegates to
// Passport; this test neither issues nor verifies a token and never creates credentials.
class SyntheticAuthenticationBoundary {
  success!: (actor: CurrentUserPayload) => void;
  fail!: (status: number) => void;

  authenticate(req: IncomingMessage): void {
    if (req.headers.authorization !== undefined) throw new Error('TOKENS_FORBIDDEN_IN_TEST');
    if (req.headers['x-synthetic-user'] === 'present') this.success({ ...user });
    else this.fail(401);
  }
}
class SyntheticJwtStrategy extends PassportStrategy(SyntheticAuthenticationBoundary, 'jwt') {
  validate(): never {
    throw new Error('REAL_TOKEN_VALIDATION_FORBIDDEN_IN_TEST');
  }
}

interface RouteCase {
  name: string;
  method: 'get' | 'post' | 'patch';
  path: string;
  permission: string;
  status: number;
  body?: Record<string, string>;
  stopsBeforeSecret?: boolean;
}
const prefix = '/api/system/v1/service-principals';
const routes: RouteCase[] = [
  {
    name: 'create',
    method: 'post',
    path: prefix,
    permission: 'service-principal.create.record',
    body: { name: 'Synthetic principal' },
    status: 201,
  },
  {
    name: 'list',
    method: 'get',
    path: prefix,
    permission: 'service-principal.read.record',
    status: 200,
  },
  {
    name: 'detail',
    method: 'get',
    path: `${prefix}/${principal.id}`,
    permission: 'service-principal.read.record',
    status: 200,
  },
  {
    name: 'update',
    method: 'patch',
    path: `${prefix}/${principal.id}`,
    permission: 'service-principal.update.record',
    body: { name: 'Synthetic changed' },
    status: 200,
  },
  {
    name: 'status',
    method: 'patch',
    path: `${prefix}/${principal.id}/status`,
    permission: 'service-principal.update.status',
    body: { status: 'SUSPENDED' },
    status: 200,
  },
  {
    name: 'create credential',
    method: 'post',
    path: `${prefix}/${principal.id}/credentials`,
    permission: 'service-principal.create.credential',
    status: 500,
    stopsBeforeSecret: true,
  },
  {
    name: 'list credentials',
    method: 'get',
    path: `${prefix}/${principal.id}/credentials`,
    permission: 'service-principal.read.record',
    status: 200,
  },
  {
    name: 'revoke credential',
    method: 'post',
    path: `${prefix}/${principal.id}/credentials/${credential.id}/revoke`,
    permission: 'service-principal.revoke.credential',
    status: 201,
  },
];

function responseCode(input: unknown): number {
  if (
    input === null ||
    typeof input !== 'object' ||
    !('code' in input) ||
    typeof input.code !== 'number'
  ) {
    throw new Error('INVALID_RESPONSE_ENVELOPE');
  }
  return input.code;
}

function responseMessage(input: unknown): string | undefined {
  if (input === null || typeof input !== 'object') throw new Error('INVALID_RESPONSE_ENVELOPE');
  return 'message' in input && typeof input.message === 'string' ? input.message : undefined;
}

describe('ServicePrincipals control-plane HTTP permission contracts without credentials', () => {
  let app: INestApplication;
  let currentCodes: string[] = [];
  const forbidden = jest.fn((): never => {
    throw new Error('REAL_DATABASE_AND_CRYPTO_FORBIDDEN');
  });
  const audit = jest.fn(() => Promise.resolve(undefined));
  const query = jest.fn(() => Promise.resolve([principal]));
  const principalCreate = jest.fn(() => Promise.resolve(principal));
  const principalUpdate = jest.fn(() => Promise.resolve({ ...principal, status: 'SUSPENDED' }));
  const principalRead = jest.fn(() => Promise.resolve(principal));
  const principalList = jest.fn(() => Promise.resolve([principal]));
  const principalCount = jest.fn(() => Promise.resolve(1));
  const credentialList = jest.fn(() => Promise.resolve([credential]));
  const credentialRead = jest.fn(() => Promise.resolve(credential));
  const credentialUpdate = jest.fn(() => Promise.resolve({ ...credential, revokedAt: date }));
  const credentialCount = jest.fn(() => Promise.resolve(0));
  const roleBindings = jest.fn((query: Prisma.RoleBindingFindManyArgs) => {
    if (
      query.where?.principalId !== user.id ||
      query.where.principalType !== 'USER' ||
      query.where.scopeType !== 'GLOBAL'
    )
      throw new Error('UNEXPECTED_PERMISSION_QUERY');
    return Promise.resolve([
      { role: { rolePermissions: currentCodes.map((code) => ({ permission: { code } })) } },
    ]);
  });
  const tx = {
    $queryRaw: query,
    servicePrincipal: {
      create: principalCreate,
      update: principalUpdate,
      findFirst: principalRead,
      findMany: principalList,
      count: principalCount,
    },
    servicePrincipalCredential: {
      create: forbidden,
      findMany: credentialList,
      findFirst: credentialRead,
      update: credentialUpdate,
      count: credentialCount,
    },
  };
  const transaction = jest.fn(
    async (work: ((client: typeof tx) => Promise<unknown>) | Array<Promise<unknown>>) =>
      typeof work === 'function' ? work(tx) : Promise.all(work),
  );
  const business = [
    query,
    principalCreate,
    principalUpdate,
    principalRead,
    principalList,
    principalCount,
    credentialList,
    credentialRead,
    credentialUpdate,
    credentialCount,
    transaction,
    audit,
  ];
  let generateSecret: jest.SpyInstance;
  let generateId: jest.SpyInstance;

  beforeAll(async () => {
    jest.replaceProperty(process, 'env', {
      NODE_ENV: 'test',
      APP_ENV: 'test',
      APP_PORT: '3001',
      APP_TRUSTED_PROXY_CIDRS: 'none',
      APP_CORS_ORIGIN: 'http://localhost',
    });
    generateSecret = jest
      .spyOn(ServicePrincipalsService, 'generateClientSecret')
      .mockImplementation((): never => {
        throw new Error(STOP);
      });
    generateId = jest
      .spyOn(ServicePrincipalsService, 'generateClientId')
      .mockReturnValue('synthetic-client-id');
    jest.spyOn(ServicePrincipalsService, 'hashClientSecret').mockImplementation(forbidden);
    const module = await Test.createTestingModule({
      imports: [
        ServicePrincipalsModule,
        PassportModule.register({ session: false }),
        ThrottlerModule.forRoot([{ ttl: 60000, limit: 1000 }]),
      ],
      providers: [
        SyntheticJwtStrategy,
        {
          provide: ServiceTokenService,
          useValue: {
            authenticateClientCredentials: forbidden,
            resolvePrincipal: forbidden,
            issueToken: forbidden,
            issueTokenForAuthenticatedClient: forbidden,
          },
        },
        { provide: DelegatedTokenService, useValue: { resolvePrincipal: forbidden } },
        ...[
          ThrottlerBizGuard,
          JwtAuthGuard,
          ServiceClientCredentialsGuard,
          IntegrationJwtAuthGuard,
          AuthzDeclarationGuard,
          RolesGuard,
        ].map((guard) => ({ provide: APP_GUARD, useClass: guard })),
      ],
    })
      .overrideProvider(PrismaService)
      .useValue({
        ...tx,
        $transaction: transaction,
        roleBinding: { findMany: roleBindings },
        $connect: forbidden,
        $executeRaw: forbidden,
        $executeRawUnsafe: forbidden,
        $queryRawUnsafe: forbidden,
      })
      .overrideProvider(AuditLogsService)
      .useValue({ log: audit })
      // Unused role-permission proof operations must not derive keys or sign tokens here.
      .overrideProvider(RolePermissionStepUpProofService)
      .useValue({ sign: forbidden, verify: forbidden })
      .compile();
    app = module.createNestApplication();
    app.useLogger(false);
    applyGlobalSetup(app, appConfig());
    await app.init();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    currentCodes = [];
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      jest.restoreAllMocks();
    }
  });

  function call(route: RouteCase, authenticated: boolean) {
    const req = request(httpServer(app))[route.method](route.path);
    if (authenticated) req.set('x-synthetic-user', 'present');
    if (route.body) req.send(route.body);
    return req;
  }
  function expectNoBusinessCalls(): void {
    for (const operation of business) expect(operation).not.toHaveBeenCalled();
    expect(generateId).not.toHaveBeenCalled();
    expect(generateSecret).not.toHaveBeenCalled();
    expect(forbidden).not.toHaveBeenCalled();
  }

  it('first proves secret generation is intercepted before the real function', () => {
    expect(() => ServicePrincipalsService.generateClientSecret()).toThrow(STOP);
    expect(generateSecret).toHaveBeenCalledTimes(1);
    expect(forbidden).not.toHaveBeenCalled();
  });

  it.each(routes)('$name: anonymous is 401 before any business operation', async (route) => {
    const res = await call(route, false);
    expect(res.status).toBe(401);
    expect(responseCode(res.body)).toBe(BizCode.UNAUTHORIZED.code);
    expect(roleBindings).not.toHaveBeenCalled();
    expectNoBusinessCalls();
  });

  it.each(routes)(
    '$name: a USER without the declared permission is 403 before work',
    async (route) => {
      const res = await call(route, true);
      expect(res.status).toBe(403);
      expect(responseCode(res.body)).toBe(BizCode.RBAC_FORBIDDEN.code);
      expectNoBusinessCalls();
    },
  );

  it.each(routes)('$name: another control-plane permission is insufficient', async (route) => {
    currentCodes = [
      route.permission === 'service-principal.read.record'
        ? 'service-principal.create.record'
        : 'service-principal.read.record',
    ];
    const res = await call(route, true);
    expect(res.status).toBe(403);
    expect(responseCode(res.body)).toBe(BizCode.RBAC_FORBIDDEN.code);
    expectNoBusinessCalls();
  });

  it.each(routes)(
    '$name: its exact permission admits only the isolated business path',
    async (route) => {
      currentCodes = [route.permission];
      const res = await call(route, true);
      expect(res.status).toBe(route.status);
      expect(roleBindings.mock.calls[0]?.[0].where).toMatchObject({
        principalId: user.id,
        principalType: 'USER',
        scopeType: 'GLOBAL',
      });
      if (route.stopsBeforeSecret) {
        expect(responseCode(res.body)).toBe(BizCode.INTERNAL_ERROR.code);
        expect(responseMessage(res.body)).toBe(STOP);
        expect(generateSecret).toHaveBeenCalledTimes(1);
        for (const operation of business) expect(operation).not.toHaveBeenCalled();
      } else {
        expect(responseCode(res.body)).toBe(0);
        expect(generateSecret).not.toHaveBeenCalled();
      }
      expect(forbidden).not.toHaveBeenCalled();
    },
  );
});
