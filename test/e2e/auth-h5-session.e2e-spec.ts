import type { INestApplication } from '@nestjs/common';
import type { Express } from 'express';
import request, { type Response } from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { hashRefreshToken } from '../../src/modules/auth/refresh-token.util';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { createTestApp } from '../setup/test-app';

const host = 'h5.example.test';
const origin = `https://${host}`;
const cookieName = '__Host-srvf_h5_refresh';
const credentials = { username: 'h5sessiontest', password: 'Passw0rd1!' };
const expiryOf = (header: string) => Date.parse(/(?:^|; )Expires=([^;]+)/.exec(header)?.[1] ?? '');

function cookieOf(response: Response): { header: string; pair: string; raw: string } {
  const header = (response.headers['set-cookie'] as string[] | undefined)?.[0] ?? '';
  const pair = header.split(';')[0];
  return { header, pair, raw: pair.slice(cookieName.length + 1) };
}

function expectCleared(response: Response): void {
  const { header, pair } = cookieOf(response);
  expect(pair === `${cookieName}=`).toBe(true);
  expect(expiryOf(header)).toBe(0);
}

describe('same-origin HTTPS H5 sessions', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const post = (action: string, requestOrigin = origin, scheme = 'https') =>
    request(httpServer(app))
      .post(`/api/auth/v1/h5/${action}`)
      .set('Host', host)
      .set('Origin', requestOrigin)
      .set('X-Forwarded-Proto', scheme);

  beforeAll(async () => {
    app = await createTestApp();
    // Model a local trusted TLS terminator without changing the production trust config.
    (app.getHttpAdapter().getInstance() as Express).set('trust proxy', 'loopback');
    prisma = app.get(PrismaService);
    await createTestUser(app, { username: credentials.username });
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ['cross-origin login', 'login', 'https://other.example.test', 'https', 'same-site'],
    ['cross-origin refresh', 'refresh', 'https://other.example.test', 'https', 'same-site'],
    ['cross-origin logout', 'logout', 'https://other.example.test', 'https', 'same-site'],
    ['HTTP', 'login', origin, 'http', 'same-origin'],
    ['opaque Origin', 'refresh', 'null', 'https', 'same-origin'],
    ['wrong port', 'refresh', `${origin}:8443`, 'https', 'same-origin'],
    ['cross-site fetch metadata', 'logout', origin, 'https', 'cross-site'],
  ])('rejects %s without touching cookies', async (_case, action, from, scheme, site) => {
    const response = await post(action, from, scheme)
      .set('Sec-Fetch-Site', site)
      .send(action === 'login' ? credentials : undefined);
    expectBizError(response, BizCode.FORBIDDEN);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('rejects missing Origin and does not trust X-Forwarded-Host', async () => {
    const missing = await post('logout').unset('Origin');
    const forwardedHost = await post('logout', 'https://other.example.test').set(
      'X-Forwarded-Host',
      'other.example.test',
    );
    expectBizError(missing, BizCode.FORBIDDEN);
    expectBizError(forwardedHost, BizCode.FORBIDDEN);
  });

  it('rotates a persistent cookie at the original family deadline and revokes on logout', async () => {
    const login = await post('login').send(credentials).expect(200);
    const first = cookieOf(login);
    expect(Object.keys(login.body.data as object).sort()).toEqual([
      'accessToken',
      'expiresIn',
      'tokenType',
    ]);
    expect(login.headers['cache-control']).toBe('no-store');
    expect(first.pair.startsWith(`${cookieName}=`)).toBe(true);
    expect(
      first.header
        .split('; ')
        .slice(1)
        .filter((part) => !part.startsWith('Expires=')),
    ).toEqual(expect.arrayContaining(['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']));
    expect(/;\s*Domain=/i.test(first.header)).toBe(false);
    const firstRow = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(first.raw) },
    });
    expect(expiryOf(first.header)).toBe(Math.floor(firstRow.expiresAt.getTime() / 1000) * 1000);

    const refresh = await post('refresh').set('Cookie', first.pair).expect(200);
    const second = cookieOf(refresh);
    expect(Object.keys(refresh.body.data as object).sort()).toEqual([
      'accessToken',
      'expiresIn',
      'tokenType',
    ]);
    expect(second.pair === first.pair).toBe(false);
    expect(expiryOf(second.header)).toBe(expiryOf(first.header));

    const rejectedLogout = await post('logout', 'https://other.example.test').set(
      'Cookie',
      second.pair,
    );
    expectBizError(rejectedLogout, BizCode.FORBIDDEN);
    const activeRow = await prisma.refreshToken.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(second.raw) },
    });
    expect(activeRow.revokedAt).toBeNull();
    expect(activeRow.familyId).toBe(firstRow.familyId);

    // A stale but identifiable ancestor still revokes its active successor.
    const logout = await post('logout').set('Cookie', first.pair).expect(200);
    expect(logout.body.data).toBeNull();
    expectCleared(logout);
    expectCleared(await post('logout').expect(200));
    const afterLogout = await post('refresh').set('Cookie', second.pair);
    expectBizError(afterLogout, BizCode.REFRESH_TOKEN_INVALID);
    expectCleared(afterLogout);
  });

  it('keeps JSON clients compatible and rejects body-only H5 refresh and logout', async () => {
    const legacy = (action: string) => request(httpServer(app)).post(`/api/auth/v1/${action}`);
    const login = await legacy('login').send(credentials).expect(200);
    expect(login.headers['set-cookie']).toBeUndefined();
    expect(Object.keys(login.body.data as object).sort()).toEqual([
      'accessToken',
      'expiresIn',
      'refreshExpiresAt',
      'refreshToken',
      'tokenType',
    ]);
    const refreshToken = login.body.data.refreshToken as string;
    const bodyOnly = await post('refresh').send({ refreshToken });
    expectBizError(bodyOnly, BizCode.REFRESH_TOKEN_INVALID);
    expectCleared(bodyOnly);
    expectCleared(await post('logout').send({ refreshToken }).expect(200));
    const refreshed = await legacy('refresh').send({ refreshToken }).expect(200);
    expect(refreshed.headers['set-cookie']).toBeUndefined();
    expect(refreshed.body.data.refreshExpiresAt).toBe(login.body.data.refreshExpiresAt);
    await legacy('logout').send({ refreshToken: refreshed.body.data.refreshToken }).expect(200);
  });

  it('rejects an expired family and clears its cookie', async () => {
    const issued = cookieOf(await post('login').send(credentials).expect(200));
    await prisma.refreshToken.update({
      where: { tokenHash: hashRefreshToken(issued.raw) },
      data: { expiresAt: new Date(0) },
    });
    const response = await post('refresh').set('Cookie', issued.pair);
    expectBizError(response, BizCode.REFRESH_TOKEN_INVALID);
    expectCleared(response);
  });

  it('replay through the Cookie transport revokes the rotated successor', async () => {
    const first = cookieOf(await post('login').send(credentials).expect(200));
    const second = cookieOf(await post('refresh').set('Cookie', first.pair).expect(200));
    const replay = await post('refresh').set('Cookie', first.pair);
    expectBizError(replay, BizCode.REFRESH_TOKEN_INVALID);
    expectCleared(replay);
    const successor = await post('refresh').set('Cookie', second.pair);
    expectBizError(successor, BizCode.REFRESH_TOKEN_INVALID);
    expectCleared(successor);
  });
});
