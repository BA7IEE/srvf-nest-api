import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';

import appConfig from '../../src/config/app.config';

const BUSINESS_PROBE = Symbol('INSURANCE_BUSINESS_PROBE');
interface BusinessProbe {
  readonly enforcementEnabled: boolean;
  readonly trustedProxyCidrs: string[];
  onModuleInit(): void;
}
const ENV_KEYS = [
  'APP_ENV',
  'APP_PORT',
  'APP_CORS_ORIGIN',
  'APP_TRUSTED_PROXY_CIDRS',
  'ENABLE_SWAGGER',
  'LOG_LEVEL',
  'STORAGE_CONSISTENCY_MODE',
  'STORAGE_ENCRYPTION_KEY',
  'SMS_ENCRYPTION_KEY',
  'WECHAT_ENCRYPTION_KEY',
  'REALNAME_ENCRYPTION_KEY',
  'INSURANCE_ENFORCEMENT_ENABLED',
] as const;

describe('INSURANCE_ENFORCEMENT_ENABLED production config assembly', () => {
  const originalEnv = new Map<string, string | undefined>();
  let businessServiceStarted = false;

  beforeAll(() => {
    for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);
  });

  beforeEach(() => {
    businessServiceStarted = false;
    process.env.APP_ENV = 'production';
    process.env.APP_PORT = '3000';
    process.env.APP_CORS_ORIGIN = 'https://insurance-config.example.test';
    process.env.APP_TRUSTED_PROXY_CIDRS = 'none';
    process.env.ENABLE_SWAGGER = 'false';
    delete process.env.LOG_LEVEL;
    process.env.STORAGE_CONSISTENCY_MODE = 'STRICT';
    process.env.STORAGE_ENCRYPTION_KEY = 's'.repeat(32);
    process.env.SMS_ENCRYPTION_KEY = 'm'.repeat(32);
    process.env.WECHAT_ENCRYPTION_KEY = 'w'.repeat(32);
    process.env.REALNAME_ENCRYPTION_KEY = 'r'.repeat(32);
    process.env.INSURANCE_ENFORCEMENT_ENABLED = 'false';
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
          load: [appConfig],
        }),
      ],
      providers: [
        {
          provide: BUSINESS_PROBE,
          inject: [appConfig.KEY],
          useFactory: (config: ConfigType<typeof appConfig>): BusinessProbe => ({
            get enforcementEnabled() {
              return config.insurance.enforcementEnabled;
            },
            get trustedProxyCidrs() {
              return config.trustedProxyCidrs;
            },
            onModuleInit() {
              businessServiceStarted = true;
            },
          }),
        },
      ],
    }).compile();
  }

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['invalid', 'TRUE'],
  ] as const)(
    'production %s:config 装配在 listen/业务 service 前 fail-fast',
    async (_label, value) => {
      if (value === undefined) delete process.env.INSURANCE_ENFORCEMENT_ENABLED;
      else process.env.INSURANCE_ENFORCEMENT_ENABLED = value;

      await expect(assemble()).rejects.toThrow(/INSURANCE_ENFORCEMENT_ENABLED/);
      expect(businessServiceStarted).toBe(false);
    },
  );

  it('production explicit false:config 与业务 provider 可装配，未静默启用', async () => {
    process.env.INSURANCE_ENFORCEMENT_ENABLED = 'false';
    const moduleRef = await assemble();
    try {
      await moduleRef.init();
      expect(moduleRef.get<BusinessProbe>(BUSINESS_PROBE).enforcementEnabled).toBe(false);
      expect(businessServiceStarted).toBe(true);
    } finally {
      await moduleRef.close();
    }
  });

  it.each([
    ['production', 'missing', undefined],
    ['production', 'empty', ''],
    ['production', 'blank', '   '],
    ['smoke', 'missing', undefined],
    ['smoke', 'empty', ''],
    ['smoke', 'blank', '   '],
  ] as const)(
    '%s APP_TRUSTED_PROXY_CIDRS %s:config 装配在 listen/业务 service 前 fail-fast',
    async (env, _label, value) => {
      process.env.APP_ENV = env;
      if (value === undefined) delete process.env.APP_TRUSTED_PROXY_CIDRS;
      else process.env.APP_TRUSTED_PROXY_CIDRS = value;

      await expect(assemble()).rejects.toThrow(/APP_TRUSTED_PROXY_CIDRS/);
      expect(businessServiceStarted).toBe(false);
    },
  );

  it.each(['production', 'smoke'] as const)(
    '%s explicit none:config 与业务 provider 可装配，信任集合为空',
    async (env) => {
      process.env.APP_ENV = env;
      process.env.APP_TRUSTED_PROXY_CIDRS = 'none';
      const moduleRef = await assemble();
      try {
        await moduleRef.init();
        expect(moduleRef.get<BusinessProbe>(BUSINESS_PROBE).trustedProxyCidrs).toEqual([]);
        expect(businessServiceStarted).toBe(true);
      } finally {
        await moduleRef.close();
      }
    },
  );
});
