import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';

import type { IntegrationAuthConfig } from '../../src/config/integration-auth.config';
import integrationAuthConfig from '../../src/config/integration-auth.config';

const ENV_KEYS = [
  'APP_ENV',
  'JWT_SECRET',
  'INTEGRATION_API_ENABLED',
  'INTEGRATION_JWT_SECRET',
  'INTEGRATION_SERVICE_TOKEN_EXPIRES_IN',
  'INTEGRATION_DELEGATED_TOKEN_EXPIRES_IN',
  'ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED',
  'ACTIVITY_V11_WORKFLOW_ENABLED',
] as const;

const HUMAN_JWT_SECRET = 'h'.repeat(48);
const INTEGRATION_JWT_SECRET = 'i'.repeat(48);

describe('Integration auth production config assembly', () => {
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
  });

  beforeEach(() => {
    process.env.APP_ENV = 'production';
    process.env.JWT_SECRET = HUMAN_JWT_SECRET;
    process.env.INTEGRATION_API_ENABLED = 'false';
    process.env.INTEGRATION_JWT_SECRET = INTEGRATION_JWT_SECRET;
    delete process.env.INTEGRATION_SERVICE_TOKEN_EXPIRES_IN;
    delete process.env.INTEGRATION_DELEGATED_TOKEN_EXPIRES_IN;
    // 自建 production-like 装配必须设满既有显式 Gate，避免预期的 Integration 配置错误
    // 被活动 Gate 的 fail-fast 顶替(C7 结构判据同样守这条)。
    process.env.ACTIVITY_AUDIENCE_TAGS_HTTP_ENABLED = 'false';
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'false';
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function assemble(): Promise<TestingModule> {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          ignoreEnvFile: true,
          load: [integrationAuthConfig],
        }),
      ],
    }).compile();
  }

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['invalid', 'TRUE'],
  ] as const)(
    'production %s Gate:ConfigModule 装配在应用启动前 fail-fast',
    async (_label, value) => {
      if (value === undefined) delete process.env.INTEGRATION_API_ENABLED;
      else process.env.INTEGRATION_API_ENABLED = value;

      await expect(assemble()).rejects.toThrow(/INTEGRATION_API_ENABLED/);
    },
  );

  it.each([
    ['missing', undefined],
    ['too short', 'i'.repeat(47)],
    ['same as human JWT', HUMAN_JWT_SECRET],
  ] as const)(
    'production %s Integration secret:ConfigModule 装配在应用启动前 fail-fast',
    async (_label, value) => {
      if (value === undefined) delete process.env.INTEGRATION_JWT_SECRET;
      else process.env.INTEGRATION_JWT_SECRET = value;

      await expect(assemble()).rejects.toThrow(/INTEGRATION_JWT_SECRET/);
    },
  );

  it('smoke explicit false:ConfigModule 可装配，TTL 的 10m 保持 600 秒', async () => {
    process.env.APP_ENV = 'smoke';
    process.env.INTEGRATION_API_ENABLED = 'false';
    process.env.INTEGRATION_SERVICE_TOKEN_EXPIRES_IN = '10m';
    process.env.INTEGRATION_DELEGATED_TOKEN_EXPIRES_IN = '10m';
    const moduleRef = await assemble();
    try {
      const config = moduleRef.get(ConfigService).get<IntegrationAuthConfig>('integrationAuth');
      expect(config).toMatchObject({
        enabled: false,
        serviceTokenTtlSeconds: 10 * 60,
        delegatedTokenTtlSeconds: 10 * 60,
      });
    } finally {
      await moduleRef.close();
    }
  });
});
