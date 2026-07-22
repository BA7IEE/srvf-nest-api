import { loadJwtConfig } from './jwt.config';

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
