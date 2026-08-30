import {
  SERVICE_TOKEN_DEFAULT_TTL_SECONDS,
  SERVICE_TOKEN_MAX_TTL_SECONDS,
  loadIntegrationAuthConfig,
} from './integration-auth.config';

const HUMAN_JWT_SECRET = 'h'.repeat(48);
const INTEGRATION_JWT_SECRET = 'i'.repeat(48);

function configEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'production',
    JWT_SECRET: HUMAN_JWT_SECRET,
    INTEGRATION_API_ENABLED: 'false',
    INTEGRATION_JWT_SECRET,
    ...overrides,
  };
}

describe('Integration auth startup configuration', () => {
  it('normalizes documented duration values to seconds', () => {
    const result = loadIntegrationAuthConfig(
      configEnv({
        INTEGRATION_SERVICE_TOKEN_EXPIRES_IN: '10m',
        INTEGRATION_DELEGATED_TOKEN_EXPIRES_IN: '30m',
      }),
    );

    expect(result.serviceTokenTtlSeconds).toBe(10 * 60);
    expect(result.delegatedTokenTtlSeconds).toBe(SERVICE_TOKEN_MAX_TTL_SECONDS);
  });

  it('keeps existing pure-second TTL values compatible', () => {
    const result = loadIntegrationAuthConfig(
      configEnv({
        INTEGRATION_SERVICE_TOKEN_EXPIRES_IN: '600',
        INTEGRATION_DELEGATED_TOKEN_EXPIRES_IN: '1799',
      }),
    );

    expect(result.serviceTokenTtlSeconds).toBe(600);
    expect(result.delegatedTokenTtlSeconds).toBe(1799);
  });

  it.each([
    ['INTEGRATION_SERVICE_TOKEN_EXPIRES_IN', '10x'],
    ['INTEGRATION_SERVICE_TOKEN_EXPIRES_IN', '0s'],
    ['INTEGRATION_SERVICE_TOKEN_EXPIRES_IN', '1801s'],
    ['INTEGRATION_DELEGATED_TOKEN_EXPIRES_IN', '-1m'],
    ['INTEGRATION_DELEGATED_TOKEN_EXPIRES_IN', '31m'],
  ] as const)('rejects invalid %s before application startup', (name, value) => {
    expect(() => loadIntegrationAuthConfig(configEnv({ [name]: value }))).toThrow(name);
  });

  it.each([
    ['production', undefined],
    ['production', ''],
    ['production', 'TRUE'],
    ['smoke', undefined],
    ['smoke', ''],
    ['smoke', 'TRUE'],
  ] as const)('%s requires an explicit strict Integration Gate', (appEnv, enabled) => {
    expect(() =>
      loadIntegrationAuthConfig(configEnv({ APP_ENV: appEnv, INTEGRATION_API_ENABLED: enabled })),
    ).toThrow('INTEGRATION_API_ENABLED');
  });

  it.each([
    ['production', undefined],
    ['production', 'i'.repeat(47)],
    ['smoke', undefined],
    ['smoke', 'i'.repeat(47)],
  ] as const)('%s rejects a missing or short Integration secret', (appEnv, integrationSecret) => {
    expect(() =>
      loadIntegrationAuthConfig(
        configEnv({ APP_ENV: appEnv, INTEGRATION_JWT_SECRET: integrationSecret }),
      ),
    ).toThrow('INTEGRATION_JWT_SECRET');
  });

  it('rejects reusing the human JWT secret whenever an Integration secret is configured', () => {
    expect(() =>
      loadIntegrationAuthConfig(
        configEnv({
          APP_ENV: 'development',
          INTEGRATION_API_ENABLED: 'false',
          INTEGRATION_JWT_SECRET: HUMAN_JWT_SECRET,
        }),
      ),
    ).toThrow('不得与 JWT_SECRET 相同');
  });

  it('keeps disabled development and test environments fail-closed without an Integration secret', () => {
    for (const appEnv of ['development', 'test']) {
      const result = loadIntegrationAuthConfig(
        configEnv({
          APP_ENV: appEnv,
          INTEGRATION_API_ENABLED: undefined,
          INTEGRATION_JWT_SECRET: undefined,
        }),
      );
      expect(result.enabled).toBe(false);
      expect(result.jwtSecret).toBe('');
      expect(result.serviceTokenTtlSeconds).toBe(SERVICE_TOKEN_DEFAULT_TTL_SECONDS);
      expect(result.delegatedTokenTtlSeconds).toBe(SERVICE_TOKEN_DEFAULT_TTL_SECONDS);
    }
  });
});
