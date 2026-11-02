import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import jwtConfig, { loadJwtConfig, type JwtConfig } from './jwt.config';

const SECRET = 'unit-test-jwt-secret-with-at-least-32-characters';

function configEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'production',
    JWT_SECRET: SECRET,
    JWT_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '90d',
    ...overrides,
  };
}

function documentedSecret(file: '.env.example' | '.env.test'): string {
  const match = /^JWT_SECRET=(?:"([^"]*)"|'([^']*)'|([^\r\n#]*))/m.exec(
    readFileSync(resolve(__dirname, '../..', file), 'utf8'),
  );
  const secret = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!secret) throw new Error('JWT config fixture is missing its documented input');
  return secret;
}

async function loadRegisteredConfig(overrides: NodeJS.ProcessEnv) {
  const env = configEnv(overrides);
  jest.replaceProperty(process, 'env', { ...process.env, ...env });
  let module: TestingModule | undefined;
  try {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ ignoreEnvFile: true, load: [jwtConfig] })],
    }).compile();
    const config = module.get(ConfigService).getOrThrow<JwtConfig>('jwt');
    return {
      matchesConfiguredInput: config.secret === env.JWT_SECRET,
      expiresInSeconds: config.expiresInSeconds,
      refreshExpiresInMs: config.refreshExpiresInMs,
    };
  } finally {
    await module?.close();
    jest.restoreAllMocks();
  }
}

describe('JWT TTL startup validation', () => {
  it('normalizes valid access and refresh durations at config load time', () => {
    const result = loadJwtConfig(configEnv());
    expect(result).toEqual({
      secret: SECRET,
      expiresIn: '15m',
      expiresInSeconds: 15 * 60,
      refreshExpiresInMs: 90 * 24 * 60 * 60 * 1000,
    });
    expect(Number.isFinite(new Date(Date.now() + result.refreshExpiresInMs).getTime())).toBe(true);
  });

  it.each([
    ['JWT_EXPIRES_IN', undefined],
    ['JWT_EXPIRES_IN', ''],
    ['JWT_EXPIRES_IN', '   '],
    ['JWT_EXPIRES_IN', '0s'],
    ['JWT_EXPIRES_IN', '-1m'],
    ['JWT_EXPIRES_IN', '120'],
    ['JWT_EXPIRES_IN', 'abc'],
    ['JWT_EXPIRES_IN', '59s'],
    ['JWT_EXPIRES_IN', '25h'],
    ['JWT_EXPIRES_IN', '999999999999999999999999999999999999d'],
    ['JWT_REFRESH_EXPIRES_IN', undefined],
    ['JWT_REFRESH_EXPIRES_IN', ''],
    ['JWT_REFRESH_EXPIRES_IN', '0d'],
    ['JWT_REFRESH_EXPIRES_IN', '-1d'],
    ['JWT_REFRESH_EXPIRES_IN', '120'],
    ['JWT_REFRESH_EXPIRES_IN', 'abc'],
    ['JWT_REFRESH_EXPIRES_IN', '23h'],
    ['JWT_REFRESH_EXPIRES_IN', '366d'],
    ['JWT_REFRESH_EXPIRES_IN', '999999999999999999999999999999999999d'],
  ] as const)('rejects invalid %s=%j before application startup', (name, value) => {
    expect(() => loadJwtConfig(configEnv({ [name]: value }))).toThrow(name);
  });

  it.each([
    ['1m', '1d', 60, 24 * 60 * 60 * 1000],
    ['24h', '365d', 24 * 60 * 60, 365 * 24 * 60 * 60 * 1000],
  ] as const)(
    'accepts inclusive boundaries access=%s refresh=%s',
    (access, refresh, accessSeconds, refreshMs) => {
      const result = loadJwtConfig(
        configEnv({ JWT_EXPIRES_IN: access, JWT_REFRESH_EXPIRES_IN: refresh }),
      );
      expect(result.expiresInSeconds).toBe(accessSeconds);
      expect(result.refreshExpiresInMs).toBe(refreshMs);
    },
  );
});

describe('JWT public fixture startup rejection', () => {
  it.each(['.env.example', '.env.test'] as const)(
    'rejects the documented %s value in production',
    (file) => {
      const secret = documentedSecret(file);
      const load = () => loadJwtConfig(configEnv({ JWT_SECRET: secret }));
      expect(load).toThrow('JWT_SECRET');
      try {
        load();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(secret);
      }
    },
  );

  it('rejects the public test value through the registered ConfigModule in production', async () => {
    const secret = documentedSecret('.env.test');
    const loading = loadRegisteredConfig({ APP_ENV: 'production', JWT_SECRET: secret });
    await expect(loading).rejects.toThrow('JWT_SECRET');
    await expect(loading).rejects.not.toThrow(secret);
  });

  it.each(['test', 'smoke'])(
    'retains the documented test input for the %s fixture environment',
    async (environment) => {
      await expect(
        loadRegisteredConfig({ APP_ENV: environment, JWT_SECRET: documentedSecret('.env.test') }),
      ).resolves.toEqual({
        matchesConfiguredInput: true,
        expiresInSeconds: 15 * 60,
        refreshExpiresInMs: 90 * 24 * 60 * 60 * 1000,
      });
    },
  );

  it('loads a distinct explicitly configured value in production', async () => {
    await expect(
      loadRegisteredConfig({ APP_ENV: 'production', JWT_SECRET: SECRET }),
    ).resolves.toEqual({
      matchesConfiguredInput: true,
      expiresInSeconds: 15 * 60,
      refreshExpiresInMs: 90 * 24 * 60 * 60 * 1000,
    });
  });
});
