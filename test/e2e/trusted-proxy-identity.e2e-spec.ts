import { Controller, Get, Req, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getStorageToken, type ThrottlerStorage } from '@nestjs/throttler';
import { createHash } from 'node:crypto';
import { createServer, request as createUpstreamRequest, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { Request as ExpressRequest } from 'express';
import request, { type Response } from 'supertest';

import { applyGlobalSetup, canonicalizeClientIp } from '../../src/bootstrap/apply-global-setup';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { AppConfig } from '../../src/config/app.config';
import { PrismaService } from '../../src/database/prisma.service';
import { TEST_PASSWORD, createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { devStubOcrImage } from '../helpers/file-fixtures';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { deriveTestDbName } from '../setup/worktree-db';

const PROBE_PATH = '/api/system/v1/trusted-proxy-probe';
const LOGIN_PATH = '/api/auth/v1/login';
const LOGIN_SMS_SEND_PATH = '/api/auth/v1/login-sms/send-code';
const OCR_PATH = '/api/open/v1/recruitment/applications/recognize';
const TEST_CLIENT_IP_HEADER = 'x-test-client-ip';

const CLIENT_A = '203.0.113.10';
const CLIENT_B = '203.0.113.11';
const CLIENT_C = '203.0.113.12';
const EDGE_PROXY = '198.51.100.20';
const FORGED_CLIENT = '192.0.2.99';

interface ProbeResponse {
  ip: string | undefined;
  ips: string[];
  remoteAddress: string | undefined;
}

@Controller('system/v1/trusted-proxy-probe')
class TrustedProxyProbeController {
  @Get()
  probe(@Req() req: ExpressRequest): ProbeResponse {
    return {
      ip: req.ip,
      ips: req.ips,
      remoteAddress: req.socket.remoteAddress,
    };
  }
}

function appConfigForProbe(trustedProxyCidrs: string[]): AppConfig {
  return {
    env: 'test',
    port: 3000,
    corsOrigin: [],
    trustedProxyCidrs,
    swaggerEnabled: false,
    logLevel: 'debug',
    loginThrottle: { limit: 5, ttlSeconds: 60 },
    passwordChangeThrottle: { limit: 5, ttlSeconds: 60 },
    refreshThrottle: { limit: 30, ttlSeconds: 60 },
    attendance: {
      allowSameReviewer: false,
      windowToleranceHours: 2,
      checkInRadiusMeters: 500,
      feedbackWindowDays: 30,
    },
    insurance: { enforcementEnabled: false },
    storage: { encryptionKey: '', localRoot: './tmp/storage', consistencyMode: 'JIT' },
    sms: { encryptionKey: '' },
    wechat: { encryptionKey: '' },
    realname: { encryptionKey: '' },
    smsSendThrottle: { limit: 5, ttlSeconds: 60 },
    smsVerifyThrottle: { limit: 10, ttlSeconds: 60 },
    passwordResetThrottle: { limit: 3, ttlSeconds: 60 },
    loginSmsThrottle: { limit: 5, ttlSeconds: 60 },
    loginWechatThrottle: { limit: 5, ttlSeconds: 60 },
    recruitmentThrottle: { limit: 10, ttlSeconds: 3600 },
    recruitmentOcr: { dailyIpLimit: 30 },
    contentPublicThrottle: { limit: 60, ttlSeconds: 60 },
  };
}

function preferredNonLoopbackIpv4(): string {
  const candidates = Object.entries(networkInterfaces())
    .flatMap(([name, addresses]) =>
      (addresses ?? [])
        .filter(
          (address) =>
            address.family === 'IPv4' &&
            !address.internal &&
            !address.address.startsWith('169.254.'),
        )
        .map((address) => ({ name, address: address.address })),
    )
    .sort((left, right) => {
      const score = (name: string) =>
        name === 'en0' || name === 'eth0' || name.startsWith('ens') ? 0 : 1;
      return score(left.name) - score(right.name);
    });
  const selected = candidates[0]?.address;
  if (!selected) {
    throw new Error('trusted proxy socket probe requires one non-loopback IPv4 interface');
  }
  return selected;
}

function serverPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP server is not listening');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

type ProxyMode = 'preserve' | 'edge-overwrite' | 'append-peer';

async function startProxy(
  backend: Server,
  backendHost: string,
  mode: ProxyMode,
  options: { listenHost?: string; observedPeers?: string[] } = {},
): Promise<Server> {
  const proxy = createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers };
    delete headers.host;

    const requestedClientIp = headers[TEST_CLIENT_IP_HEADER];
    delete headers[TEST_CLIENT_IP_HEADER];
    if (mode === 'edge-overwrite') {
      const clientIp = Array.isArray(requestedClientIp) ? requestedClientIp[0] : requestedClientIp;
      if (!clientIp) {
        outgoing.statusCode = 400;
        outgoing.end('missing test client identity');
        return;
      }
      // 模拟真实 edge 的安全职责：丢弃外部传入的 XFF，仅写入 edge 观察到的 client。
      headers['x-forwarded-for'] = clientIp;
    } else if (mode === 'append-peer') {
      const peer = incoming.socket.remoteAddress;
      if (!peer) {
        outgoing.statusCode = 502;
        outgoing.end('missing direct peer address');
        return;
      }
      options.observedPeers?.push(peer);
      const prior = headers['x-forwarded-for'];
      const priorText = Array.isArray(prior) ? prior.join(', ') : prior;
      headers['x-forwarded-for'] = priorText ? `${priorText}, ${peer}` : peer;
    }

    const upstream = createUpstreamRequest(
      {
        host: backendHost,
        localAddress: backendHost,
        family: 4,
        port: serverPort(backend),
        method: incoming.method,
        path: incoming.url,
        headers,
      },
      (upstreamResponse) => {
        outgoing.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(outgoing);
      },
    );
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      proxy.once('error', onError);
      proxy.listen(0, options.listenHost ?? '127.0.0.1', () => {
        proxy.off('error', onError);
        resolve();
      });
    });
  } catch (error) {
    await closeServer(proxy);
    throw error;
  }
  return proxy;
}

async function withProxy<T>(
  backend: Server,
  backendHost: string,
  mode: ProxyMode,
  run: (proxy: Server) => Promise<T>,
  options: { listenHost?: string; observedPeers?: string[] } = {},
): Promise<T> {
  let proxy: Server | undefined;
  try {
    proxy = await startProxy(backend, backendHost, mode, options);
    return await run(proxy);
  } finally {
    if (proxy) await closeServer(proxy);
  }
}

async function createProbeApp(trustedProxyCidrs: string[]): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [TrustedProxyProbeController],
  }).compile();
  const app = moduleRef.createNestApplication();
  try {
    app.useLogger(false);
    applyGlobalSetup(app, appConfigForProbe(trustedProxyCidrs));
    // IPv6 wildcard listener makes an IPv4 proxy socket observable as ::ffff:a.b.c.d.
    await app.listen(0, '::');
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

function probeData(response: Response): ProbeResponse {
  expect(response.status).toBe(200);
  return response.body.data as ProbeResponse;
}

function loginBucketKey(ip: string): string {
  return createHash('sha256').update(`AuthController-login-default-${ip}`).digest('hex');
}

function throughEdge(proxy: Server, path: string, clientIp: string): request.Test {
  return request(proxy).post(path).set(TEST_CLIENT_IP_HEADER, clientIp);
}

describe('trusted proxy identity — Express real socket boundary (no DB)', () => {
  const backendHost = preferredNonLoopbackIpv4();

  it('none ignores forged X-Forwarded-For and keeps the direct socket identity', async () => {
    const app = await createProbeApp([]);
    try {
      const result = probeData(
        await request(httpServer(app)).get(PROBE_PATH).set('x-forwarded-for', FORGED_CLIENT),
      );
      expect(result.ip).toBe(canonicalizeClientIp(result.remoteAddress));
      expect(result.ip).not.toBe(FORGED_CLIENT);
      expect(result.ips).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('an untrusted direct proxy cannot make a forged XFF effective', async () => {
    const app = await createProbeApp(['198.51.100.200/32']);
    try {
      await withProxy(app.getHttpServer() as Server, backendHost, 'preserve', async (proxy) => {
        const result = probeData(
          await request(proxy).get(PROBE_PATH).set('x-forwarded-for', FORGED_CLIENT),
        );
        expect(result.ip).toBe(canonicalizeClientIp(result.remoteAddress));
        expect(result.ip).not.toBe(FORGED_CLIENT);
      });
    } finally {
      await app.close();
    }
  });

  it('a trusted proxy with missing or empty XFF fails closed instead of becoming the client', async () => {
    const app = await createProbeApp([`${backendHost}/32`]);
    try {
      await withProxy(app.getHttpServer() as Server, backendHost, 'preserve', async (proxy) => {
        const missing = await request(proxy).get(PROBE_PATH);
        const empty = await request(proxy).get(PROBE_PATH).set('x-forwarded-for', '');
        expectBizError(missing, BizCode.BAD_REQUEST);
        expectBizError(empty, BizCode.BAD_REQUEST);
      });
    } finally {
      await app.close();
    }
  });

  it('a chain containing only trusted proxy identities fails closed', async () => {
    const app = await createProbeApp([`${backendHost}/32`, `${EDGE_PROXY}/32`]);
    try {
      await withProxy(app.getHttpServer() as Server, backendHost, 'preserve', async (proxy) => {
        const response = await request(proxy).get(PROBE_PATH).set('x-forwarded-for', EDGE_PROXY);
        expectBizError(response, BizCode.BAD_REQUEST);
      });
    } finally {
      await app.close();
    }
  });

  it('single trusted proxy resolves client IP and matches IPv4 CIDR against mapped socket form', async () => {
    const app = await createProbeApp([`${backendHost}/32`]);
    try {
      await withProxy(app.getHttpServer() as Server, backendHost, 'preserve', async (proxy) => {
        const result = probeData(
          await request(proxy).get(PROBE_PATH).set('x-forwarded-for', CLIENT_A),
        );
        expect(result.remoteAddress).toBe(`::ffff:${backendHost}`);
        expect(result.ip).toBe(CLIENT_A);
        expect(result.ips).toEqual([CLIENT_A]);
      });
    } finally {
      await app.close();
    }
  });

  it('canonicalizes native IPv4, IPv4-mapped, and IPv6 client tokens before the controller', async () => {
    const app = await createProbeApp([`${backendHost}/32`]);
    try {
      await withProxy(app.getHttpServer() as Server, backendHost, 'preserve', async (proxy) => {
        const nativeIpv4 = probeData(
          await request(proxy).get(PROBE_PATH).set('x-forwarded-for', CLIENT_A),
        );
        const mappedIpv4 = probeData(
          await request(proxy).get(PROBE_PATH).set('x-forwarded-for', `::ffff:${CLIENT_A}`),
        );
        const ipv6 = probeData(
          await request(proxy).get(PROBE_PATH).set('x-forwarded-for', '2001:0DB8:0:0:0:0:0:1'),
        );

        expect(nativeIpv4.ip).toBe(CLIENT_A);
        expect(nativeIpv4.ips).toEqual([CLIENT_A]);
        expect(mappedIpv4.ip).toBe(CLIENT_A);
        expect(mappedIpv4.ips).toEqual([CLIENT_A]);
        expect(ipv6.ip).toBe('2001:db8::1');
        expect(ipv6.ips).toEqual(['2001:db8::1']);
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    '203.0.113.10:443',
    '[2001:db8::1]',
    'fe80::1%eth0',
    'not-an-ip',
    '203.0.113.10, bogus',
    'bogus, 198.51.100.20',
  ])(
    'rejects invalid resolved client chain before the probe controller: %s',
    async (forwardedFor) => {
      const app = await createProbeApp([`${backendHost}/32`, '198.51.100.20/32']);
      try {
        await withProxy(app.getHttpServer() as Server, backendHost, 'preserve', async (proxy) => {
          const response = await request(proxy)
            .get(PROBE_PATH)
            .set('x-forwarded-for', forwardedFor);
          expectBizError(response, BizCode.BAD_REQUEST);
          expect(response.headers['x-content-type-options']).toBe('nosniff');
          expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
        });
      } finally {
        await app.close();
      }
    },
  );

  it('uses two real proxy servers:edge overwrites and internal appends its actual socket peer', async () => {
    const app = await createProbeApp([`${backendHost}/32`]);
    const observedInternalPeers: string[] = [];
    try {
      await withProxy(
        app.getHttpServer() as Server,
        backendHost,
        'append-peer',
        async (internalProxy) =>
          withProxy(internalProxy, backendHost, 'edge-overwrite', async (edgeProxy) => {
            const result = probeData(
              await request(edgeProxy)
                .get(PROBE_PATH)
                .set(TEST_CLIENT_IP_HEADER, CLIENT_A)
                .set('x-forwarded-for', FORGED_CLIENT),
            );
            expect(result.ip).toBe(CLIENT_A);
            expect(result.ip).not.toBe(FORGED_CLIENT);
            expect(result.ips).toEqual([CLIENT_A, backendHost]);
          }),
        { listenHost: backendHost, observedPeers: observedInternalPeers },
      );
      expect(observedInternalPeers).toEqual([backendHost]);
    } finally {
      await app.close();
    }
  });

  it('truncates at the first untrusted edge when that exact CIDR is missing', async () => {
    const app = await createProbeApp([`${backendHost}/32`]);
    try {
      await withProxy(app.getHttpServer() as Server, backendHost, 'preserve', async (proxy) => {
        const result = probeData(
          await request(proxy).get(PROBE_PATH).set('x-forwarded-for', `${CLIENT_A}, ${EDGE_PROXY}`),
        );
        expect(result.ip).toBe(EDGE_PROXY);
        expect(result.ip).not.toBe(CLIENT_A);
        expect(result.ips).toEqual([EDGE_PROXY]);
      });
    } finally {
      await app.close();
    }
  });

  it('edge overwrite removes an external forged XFF before the trusted backend hop', async () => {
    const app = await createProbeApp([`${backendHost}/32`]);
    try {
      await withProxy(
        app.getHttpServer() as Server,
        backendHost,
        'edge-overwrite',
        async (proxy) => {
          const result = probeData(
            await request(proxy)
              .get(PROBE_PATH)
              .set(TEST_CLIENT_IP_HEADER, CLIENT_B)
              .set('x-forwarded-for', FORGED_CLIENT),
          );
          expect(result.ip).toBe(CLIENT_B);
          expect(result.ip).not.toBe(FORGED_CLIENT);
          expect(result.ips).toEqual([CLIENT_B]);
        },
      );
    } finally {
      await app.close();
    }
  });
});

describe('trusted proxy identity — current business consumers (PostgreSQL)', () => {
  const backendHost = preferredNonLoopbackIpv4();
  const ENV_KEYS = [
    'APP_TRUSTED_PROXY_CIDRS',
    'LOGIN_THROTTLE_LIMIT',
    'LOGIN_THROTTLE_TTL_SECONDS',
    'LOGIN_SMS_THROTTLE_LIMIT',
    'RECRUITMENT_THROTTLE_LIMIT',
  ] as const;
  const originalEnv = new Map<string, string | undefined>();
  let appA: INestApplication | undefined;
  let appB: INestApplication | undefined;
  let prisma: PrismaService;
  let prismaB: PrismaService;
  let storageA: ThrottlerStorage;
  let storageB: ThrottlerStorage;

  function restoreEnv(): void {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  function primaryApp(): INestApplication {
    if (!appA) throw new Error('primary trusted proxy test app is not available');
    return appA;
  }

  function secondaryApp(): INestApplication {
    if (!appB) throw new Error('secondary trusted proxy test app is not available');
    return appB;
  }

  beforeAll(async () => {
    for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
    process.env.APP_TRUSTED_PROXY_CIDRS = `${backendHost}/32`;
    process.env.LOGIN_THROTTLE_LIMIT = '1';
    process.env.LOGIN_THROTTLE_TTL_SECONDS = '60';
    process.env.LOGIN_SMS_THROTTLE_LIMIT = '100';
    process.env.RECRUITMENT_THROTTLE_LIMIT = '100';
    try {
      appA = await createTestApp();
      appB = await createTestApp();
      prisma = appA.get(PrismaService);
      prismaB = appB.get(PrismaService);
      storageA = appA.get<ThrottlerStorage>(getStorageToken());
      storageB = appB.get<ThrottlerStorage>(getStorageToken());
    } catch (error) {
      try {
        if (appB) await appB.close();
      } finally {
        try {
          if (appA) await appA.close();
        } finally {
          restoreEnv();
        }
      }
      throw error;
    }
  });

  beforeEach(async () => {
    await resetDb(primaryApp());
  });

  afterAll(async () => {
    try {
      if (appB) await appB.close();
    } finally {
      try {
        if (appA) await appA.close();
      } finally {
        restoreEnv();
      }
    }
  });

  it('two clients behind one trusted proxy receive independent login buckets', async () => {
    const app = primaryApp();
    await createTestUser(app, { username: 'proxy-bucket-split' });
    await withProxy(app.getHttpServer() as Server, backendHost, 'edge-overwrite', async (proxy) => {
      const firstA = await throughEdge(proxy, LOGIN_PATH, CLIENT_A).send({
        username: 'proxy-bucket-split',
        password: 'WrongPwd1!',
      });
      const firstB = await throughEdge(proxy, LOGIN_PATH, CLIENT_B).send({
        username: 'proxy-bucket-split',
        password: 'WrongPwd1!',
      });
      expectBizError(firstA, BizCode.LOGIN_FAILED);
      expectBizError(firstB, BizCode.LOGIN_FAILED);

      const blockedA = await throughEdge(proxy, LOGIN_PATH, CLIENT_A).send({
        username: 'proxy-bucket-split',
        password: 'WrongPwd1!',
      });
      expectBizError(blockedA, BizCode.TOO_MANY_REQUESTS);
    });
  });

  it('the same client shares one PostgreSQL login quota across two Nest instances', async () => {
    const firstApp = primaryApp();
    const secondApp = secondaryApp();
    await createTestUser(firstApp, { username: 'proxy-shared-bucket' });
    await withProxy(
      firstApp.getHttpServer() as Server,
      backendHost,
      'edge-overwrite',
      async (proxyA) =>
        withProxy(
          secondApp.getHttpServer() as Server,
          backendHost,
          'edge-overwrite',
          async (proxyB) => {
            const first = await throughEdge(proxyA, LOGIN_PATH, CLIENT_C).send({
              username: 'proxy-shared-bucket',
              password: 'WrongPwd1!',
            });
            expectBizError(first, BizCode.LOGIN_FAILED);

            const blocked = await throughEdge(proxyB, LOGIN_PATH, CLIENT_C).send({
              username: 'proxy-shared-bucket',
              password: 'WrongPwd1!',
            });
            expectBizError(blocked, BizCode.TOO_MANY_REQUESTS);
          },
        ),
    );
  });

  it('canonical-equivalent native/mapped IPv4 and expanded/compressed IPv6 share PostgreSQL buckets across instances', async () => {
    const firstApp = primaryApp();
    const secondApp = secondaryApp();
    const user = await createTestUser(firstApp, { username: 'proxy-canonical-bucket' });
    const loginPayload = { username: user.username, password: 'WrongPwd1!' };
    expect(prisma).not.toBe(prismaB);
    expect(storageA).not.toBe(storageB);
    const [databaseA] = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT current_database() AS name
    `;
    const [databaseB] = await prismaB.$queryRaw<Array<{ name: string }>>`
      SELECT current_database() AS name
    `;
    expect(databaseA?.name).toBe(deriveTestDbName());
    expect(databaseB?.name).toBe(databaseA?.name);

    await withProxy(firstApp.getHttpServer() as Server, backendHost, 'preserve', async (proxyA) =>
      withProxy(secondApp.getHttpServer() as Server, backendHost, 'preserve', async (proxyB) => {
        const nativeIpv4 = await request(proxyA)
          .post(LOGIN_PATH)
          .set('x-forwarded-for', CLIENT_A)
          .send(loginPayload);
        expectBizError(nativeIpv4, BizCode.LOGIN_FAILED);
        const mappedIpv4 = await request(proxyB)
          .post(LOGIN_PATH)
          .set('x-forwarded-for', `::ffff:${CLIENT_A}`)
          .send(loginPayload);
        expectBizError(mappedIpv4, BizCode.TOO_MANY_REQUESTS);
        const ipv4Buckets = await prisma.throttlerBucket.findMany({
          where: { throttlerName: 'default' },
        });
        expect(ipv4Buckets).toHaveLength(1);
        expect(ipv4Buckets[0]?.key).toBe(loginBucketKey(CLIENT_A));
        expect(ipv4Buckets[0]?.key).not.toBe(loginBucketKey(`::ffff:${CLIENT_A}`));

        const expandedIpv6 = await request(proxyA)
          .post(LOGIN_PATH)
          .set('x-forwarded-for', '2001:0DB8:0:0:0:0:0:44')
          .send(loginPayload);
        expectBizError(expandedIpv6, BizCode.LOGIN_FAILED);
        const compressedIpv6 = await request(proxyB)
          .post(LOGIN_PATH)
          .set('x-forwarded-for', '2001:db8::44')
          .send(loginPayload);
        expectBizError(compressedIpv6, BizCode.TOO_MANY_REQUESTS);
        const allBuckets = await prisma.throttlerBucket.findMany({
          where: { throttlerName: 'default' },
          orderBy: { key: 'asc' },
        });
        const keys = allBuckets.map(({ key }) => key);
        expect(allBuckets).toHaveLength(2);
        expect(keys).toEqual(
          expect.arrayContaining([loginBucketKey(CLIENT_A), loginBucketKey('2001:db8::44')]),
        );
        expect(keys).not.toContain(loginBucketKey('2001:0DB8:0:0:0:0:0:44'));
        keys.forEach((key) => {
          expect(key).toMatch(/^[a-f0-9]{64}$/);
          expect(key).not.toMatch(/203\.0\.113|::ffff|2001:db8/i);
        });
      }),
    );
  });

  it('invalid client tokens fail before throttler, audit, login, SMS, or OCR persistence', async () => {
    const app = primaryApp();
    const phone = '13910000990';
    const user = await createTestUser(app, { username: 'invalid-client-ip' });
    await prisma.user.update({ where: { id: user.id }, data: { phone } });
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prisma.realnameVerificationSettings.create({
      data: { providerType: 'DEV_STUB', enabled: true },
    });
    await prisma.recruitmentCycle.create({
      data: { year: 2098, name: 'Invalid client IP probe', statusCode: 'open' },
    });

    await withProxy(app.getHttpServer() as Server, backendHost, 'preserve', async (proxy) => {
      const responses = [
        await request(proxy)
          .post(LOGIN_PATH)
          .set('x-forwarded-for', '203.0.113.10:443')
          .send({ username: user.username, password: TEST_PASSWORD }),
        await request(proxy)
          .post(LOGIN_SMS_SEND_PATH)
          .set('x-forwarded-for', '[2001:db8::1]')
          .send({ phone }),
        await request(proxy)
          .post(OCR_PATH)
          .set('x-forwarded-for', 'fe80::1%eth0')
          .field('documentTypeCode', 'mainland_id')
          .attach(
            'idCardImage',
            devStubOcrImage({
              name: '张三',
              idCardNumber: '110101199003070038',
              clarity: true,
              warnings: [],
            }),
            { filename: 'id.jpg', contentType: 'image/jpeg' },
          ),
        await request(proxy)
          .post(LOGIN_PATH)
          .set('x-forwarded-for', 'not-an-ip')
          .send({ username: user.username, password: TEST_PASSWORD }),
      ];
      responses.forEach((response) => expectBizError(response, BizCode.BAD_REQUEST));
    });

    await expect(prisma.throttlerBucket.count()).resolves.toBe(0);
    await expect(prisma.auditLog.count()).resolves.toBe(0);
    await expect(prisma.refreshToken.count()).resolves.toBe(0);
    await expect(prisma.smsVerificationCode.count()).resolves.toBe(0);
    await expect(prisma.recruitmentOcrDailyCounter.count()).resolves.toBe(0);
  });

  it('login evidence, SMS code, and OCR counter all persist the resolved client IP', async () => {
    const loginClient = '203.0.113.40';
    const smsClient = '203.0.113.41';
    const ocrClient = '203.0.113.42';
    const phone = '13910000991';
    const app = primaryApp();
    const user = await createTestUser(app, { username: 'proxy-consumer-user' });
    await prisma.user.update({ where: { id: user.id }, data: { phone } });
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prisma.realnameVerificationSettings.create({
      data: { providerType: 'DEV_STUB', enabled: true },
    });
    await prisma.recruitmentCycle.create({
      data: { year: 2099, name: 'Trusted proxy OCR probe', statusCode: 'open' },
    });

    await withProxy(app.getHttpServer() as Server, backendHost, 'edge-overwrite', async (proxy) => {
      const login = await throughEdge(proxy, LOGIN_PATH, loginClient).send({
        username: user.username,
        password: TEST_PASSWORD,
      });
      expect(login.status).toBe(200);

      const refresh = await prisma.refreshToken.findFirstOrThrow({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(refresh.ipFirstSeen).toBe(loginClient);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'auth.login', resourceId: user.id },
      });
      expect((audit.context as { ip?: unknown }).ip).toBe(loginClient);

      const sms = await throughEdge(proxy, LOGIN_SMS_SEND_PATH, smsClient).send({ phone });
      expect(sms.status).toBe(200);
      const code = await prisma.smsVerificationCode.findFirstOrThrow({
        where: { phone, purpose: 'LOGIN' },
      });
      expect(code.ip).toBe(smsClient);

      const ocr = await request(proxy)
        .post(OCR_PATH)
        .set(TEST_CLIENT_IP_HEADER, ocrClient)
        .field('documentTypeCode', 'mainland_id')
        .attach(
          'idCardImage',
          devStubOcrImage({
            name: '张三',
            idCardNumber: '110101199003070038',
            clarity: true,
            warnings: [],
          }),
          { filename: 'id.jpg', contentType: 'image/jpeg' },
        );
      expect(ocr.status).toBe(200);
      const counter = await prisma.recruitmentOcrDailyCounter.findFirstOrThrow();
      expect(counter.ip).toBe(ocrClient);
    });
  });
});
