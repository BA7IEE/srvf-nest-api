import { Controller, Get, Logger, Req, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';

import { BizCode } from '../common/exceptions/biz-code.constant';
import type { AppConfig } from '../config/app.config';
import { applyGlobalSetup, canonicalizeClientIp } from './apply-global-setup';
import { buildLoggerModuleParams } from './logger-options';
import { genReqId } from './request-id';

@Controller('system/v1/client-identity-probe')
class ClientIdentityProbeController {
  static calls = 0;

  @Get()
  probe(@Req() req: Request): { ip: string | undefined; ips: string[] } {
    ClientIdentityProbeController.calls += 1;
    return { ip: req.ip, ips: req.ips };
  }
}

function fakeConfig(trustedProxyCidrs: string[]): AppConfig {
  return {
    env: 'test',
    port: 3000,
    corsOrigin: ['http://localhost:5173'],
    trustedProxyCidrs,
    swaggerEnabled: true,
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
    activityResponsibilityWorkflow: { enabled: false },
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

function fakeApplication(events: string[]): {
  app: INestApplication;
  expressSet: jest.Mock;
  settings: Map<string, unknown>;
} {
  const settings = new Map<string, unknown>();
  const compiledTrustProxy = jest.fn(() => false);
  const expressApp = {
    set: jest.fn((name: string, value: unknown) => {
      events.push(`express.set:${name}`);
      settings.set(name, value);
      if (name === 'trust proxy' && Array.isArray(value)) {
        settings.set('trust proxy fn', compiledTrustProxy);
      }
    }),
    get: jest.fn((name: string) => settings.get(name)),
  };
  return {
    app: {
      getHttpAdapter: jest.fn(() => ({ getInstance: () => expressApp })),
      use: jest.fn(() => events.push('app.use')),
      setGlobalPrefix: jest.fn(() => events.push('app.setGlobalPrefix')),
      useGlobalPipes: jest.fn(() => events.push('app.useGlobalPipes')),
      useGlobalFilters: jest.fn(() => events.push('app.useGlobalFilters')),
      useGlobalInterceptors: jest.fn(() => events.push('app.useGlobalInterceptors')),
      enableCors: jest.fn(() => events.push('app.enableCors')),
    } as unknown as INestApplication,
    expressSet: expressApp.set,
    settings,
  };
}

describe('applyGlobalSetup trusted proxy ordering', () => {
  it('maps none to boolean false before registering any middleware/pipe/filter', () => {
    const events: string[] = [];
    const { app, expressSet, settings } = fakeApplication(events);

    applyGlobalSetup(app, fakeConfig([]));

    expect(expressSet).toHaveBeenCalledTimes(1);
    expect(expressSet).toHaveBeenCalledWith('trust proxy', false);
    expect(settings.get('trust proxy')).toBe(false);
    expect(events[0]).toBe('express.set:trust proxy');
    expect(events.slice(1)).toContain('app.use');
    expect(events.slice(1)).toContain('app.useGlobalPipes');
    expect(events.slice(1)).toContain('app.useGlobalFilters');
  });

  it('passes the validated CIDR list directly to Express without boolean/hop conversion', () => {
    const events: string[] = [];
    const { app, expressSet, settings } = fakeApplication(events);
    const cidrs = ['192.0.2.10/32', '2001:db8::/48'];

    applyGlobalSetup(app, fakeConfig(cidrs));

    expect(expressSet).toHaveBeenCalledTimes(1);
    expect(expressSet).toHaveBeenCalledWith('trust proxy', cidrs);
    expect(expressSet).not.toHaveBeenCalledWith('trust proxy', true);
    expect(settings.get('trust proxy')).toBe(cidrs);
    expect(events[0]).toBe('express.set:trust proxy');
  });
});

describe('canonical client identity', () => {
  it.each([
    ['203.0.113.10', '203.0.113.10'],
    ['::ffff:203.0.113.10', '203.0.113.10'],
    ['::FFFF:CB00:710A', '203.0.113.10'],
    ['2001:0DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['2001:db8:0:1:0:0:0:1', '2001:db8:0:1::1'],
  ])('canonicalizes %s to %s', (raw, expected) => {
    expect(canonicalizeClientIp(raw)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    123,
    '',
    ' ',
    ' 203.0.113.10',
    '203.0.113.10 ',
    '203.0.113.10:443',
    '[2001:db8::1]',
    'fe80::1%eth0',
    'not-an-ip',
  ])('rejects non-IP token %p', (raw) => {
    expect(canonicalizeClientIp(raw)).toBeNull();
  });

  async function createRealProbe(
    trustedProxyCidrs = ['127.0.0.1/32', '198.51.100.20/32'],
  ): Promise<{
    app: INestApplication;
    observedByLaterMiddleware: Array<string | undefined>;
    observedRequestIds: Array<{ established: unknown; reused: string }>;
  }> {
    const config = fakeConfig(trustedProxyCidrs);
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerModule.forRoot(buildLoggerModuleParams(config))],
      controllers: [ClientIdentityProbeController],
    }).compile();
    const app = moduleRef.createNestApplication();
    try {
      app.useLogger(false);
      applyGlobalSetup(app, config);
      const observedByLaterMiddleware: Array<string | undefined> = [];
      const observedRequestIds: Array<{ established: unknown; reused: string }> = [];
      app.use((req: Request, res: Response, next: () => void) => {
        observedByLaterMiddleware.push(req.ip);
        const established = (req as Request & { id?: unknown }).id;
        const reused = genReqId(req, res);
        observedRequestIds.push({ established, reused });
        next();
      });
      await app.init();
      await app.listen(0, '127.0.0.1');
      return { app, observedByLaterMiddleware, observedRequestIds };
    } catch (error) {
      await app.close();
      throw error;
    }
  }

  it('real Nest socket exposes one canonical identity to later middleware and controller', async () => {
    const { app, observedByLaterMiddleware, observedRequestIds } = await createRealProbe();
    ClientIdentityProbeController.calls = 0;
    try {
      const ipv4 = await request(app.getHttpServer() as Server)
        .get('/api/system/v1/client-identity-probe')
        .set('x-request-id', 'trusted-proxy-valid-id')
        .set('x-forwarded-for', '203.0.113.10');
      const mapped = await request(app.getHttpServer() as Server)
        .get('/api/system/v1/client-identity-probe')
        .set('x-forwarded-for', '::ffff:203.0.113.10');
      const ipv6 = await request(app.getHttpServer() as Server)
        .get('/api/system/v1/client-identity-probe')
        .set('x-forwarded-for', '2001:0DB8:0:0:0:0:0:1');

      expect(JSON.parse(ipv4.text) as unknown).toEqual({
        code: 0,
        message: 'ok',
        data: { ip: '203.0.113.10', ips: ['203.0.113.10'] },
      });
      expect(JSON.parse(mapped.text) as unknown).toEqual({
        code: 0,
        message: 'ok',
        data: { ip: '203.0.113.10', ips: ['203.0.113.10'] },
      });
      expect(JSON.parse(ipv6.text) as unknown).toEqual({
        code: 0,
        message: 'ok',
        data: { ip: '2001:db8::1', ips: ['2001:db8::1'] },
      });
      expect(observedByLaterMiddleware).toEqual(['203.0.113.10', '203.0.113.10', '2001:db8::1']);
      expect(ipv4.headers['x-request-id']).toBe('trusted-proxy-valid-id');
      expect(observedRequestIds[0]).toEqual({
        established: 'trusted-proxy-valid-id',
        reused: 'trusted-proxy-valid-id',
      });
      observedRequestIds.forEach(({ established, reused }) => expect(reused).toBe(established));
      expect(ClientIdentityProbeController.calls).toBe(3);
    } finally {
      await app.close();
    }
  });

  it.each([undefined, 'invalid request id with spaces'])(
    'real LoggerModule request generates one safe stable id for missing/invalid input %p',
    async (requestId) => {
      const { app, observedRequestIds } = await createRealProbe();
      try {
        let probe = request(app.getHttpServer() as Server)
          .get('/api/system/v1/client-identity-probe')
          .set('x-forwarded-for', '203.0.113.10');
        if (requestId !== undefined) probe = probe.set('x-request-id', requestId);
        const response = await probe;
        const responseRequestId: unknown = response.headers['x-request-id'];

        expect(response.status).toBe(200);
        expect(responseRequestId).toEqual(expect.stringMatching(/^[A-Za-z0-9_.-]{1,128}$/));
        expect(responseRequestId).not.toBe(requestId);
        expect(observedRequestIds).toEqual([
          { established: responseRequestId, reused: responseRequestId },
        ]);
      } finally {
        await app.close();
      }
    },
  );

  it.each([undefined, '', '198.51.100.20'])(
    'fails closed when a trusted socket has no untrusted client identity: %p',
    async (forwardedFor) => {
      const { app, observedByLaterMiddleware } = await createRealProbe();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      try {
        let probe = request(app.getHttpServer() as Server).get(
          '/api/system/v1/client-identity-probe',
        );
        if (forwardedFor !== undefined) probe = probe.set('x-forwarded-for', forwardedFor);
        const response = await probe;

        expect(response.status).toBe(BizCode.BAD_REQUEST.httpStatus);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(observedByLaterMiddleware).toEqual([]);
      } finally {
        warnSpy.mockRestore();
        await app.close();
      }
    },
  );

  it('keeps none/direct socket semantics valid without requiring XFF', async () => {
    const { app, observedByLaterMiddleware } = await createRealProbe([]);
    try {
      const response = await request(app.getHttpServer() as Server).get(
        '/api/system/v1/client-identity-probe',
      );

      expect(response.status).toBe(200);
      expect(observedByLaterMiddleware).toEqual(['127.0.0.1']);
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
    'real Nest socket rejects invalid resolved chain %s before later middleware/controller and keeps Helmet headers',
    async (forwardedFor) => {
      const { app, observedByLaterMiddleware } = await createRealProbe();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      ClientIdentityProbeController.calls = 0;
      try {
        const requestId = 'invalid-client-identity-id';
        const response = await request(app.getHttpServer() as Server)
          .get('/api/system/v1/client-identity-probe')
          .set('origin', 'http://localhost:5173')
          .set('x-request-id', requestId)
          .set('x-forwarded-for', forwardedFor);

        expect(response.status).toBe(BizCode.BAD_REQUEST.httpStatus);
        expect(JSON.parse(response.text) as unknown).toEqual({
          code: BizCode.BAD_REQUEST.code,
          message: BizCode.BAD_REQUEST.message,
          data: null,
        });
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
        expect(response.headers['x-request-id']).toBe(requestId);
        expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
        expect(response.headers.vary).toContain('Origin');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith({
          event: 'client_identity_rejected',
          reqId: requestId,
        });
        const logged = JSON.stringify(warnSpy.mock.calls);
        expect(logged).not.toContain(forwardedFor);
        expect(logged).not.toMatch(/x-forwarded-for|user-agent|\/api\//i);
        expect(observedByLaterMiddleware).toEqual([]);
        expect(ClientIdentityProbeController.calls).toBe(0);
      } finally {
        warnSpy.mockRestore();
        await app.close();
      }
    },
  );

  it('does not grant CORS to an unallowed Origin on an invalid identity response', async () => {
    const { app, observedByLaterMiddleware } = await createRealProbe();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      const response = await request(app.getHttpServer() as Server)
        .get('/api/system/v1/client-identity-probe')
        .set('origin', 'https://evil.example')
        .set('x-forwarded-for', 'not-an-ip');

      expect(response.status).toBe(BizCode.BAD_REQUEST.httpStatus);
      expect(response.headers).not.toHaveProperty('access-control-allow-origin');
      expect(response.headers.vary).toContain('Origin');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(observedByLaterMiddleware).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it('sets Vary Origin on an invalid identity response without an Origin header', async () => {
    const { app, observedByLaterMiddleware } = await createRealProbe();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      const response = await request(app.getHttpServer() as Server)
        .get('/api/system/v1/client-identity-probe')
        .set('x-forwarded-for', 'not-an-ip');

      expect(response.status).toBe(BizCode.BAD_REQUEST.httpStatus);
      expect(response.headers).not.toHaveProperty('access-control-allow-origin');
      expect(response.headers.vary).toContain('Origin');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(observedByLaterMiddleware).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      await app.close();
    }
  });

  it('rejects an invalid-identity CORS preflight before default CORS can short-circuit it', async () => {
    const { app, observedByLaterMiddleware } = await createRealProbe();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      const response = await request(app.getHttpServer() as Server)
        .options('/api/system/v1/client-identity-probe')
        .set('origin', 'http://localhost:5173')
        .set('access-control-request-method', 'GET')
        .set('x-forwarded-for', 'not-an-ip');

      expect(response.status).toBe(BizCode.BAD_REQUEST.httpStatus);
      expect(response.status).not.toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(response.headers.vary).toContain('Origin');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(observedByLaterMiddleware).toEqual([]);
    } finally {
      warnSpy.mockRestore();
      await app.close();
    }
  });
});
