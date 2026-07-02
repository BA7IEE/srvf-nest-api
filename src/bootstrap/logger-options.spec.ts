import type { AppConfig } from '../config/app.config';
import { buildLoggerModuleParams } from './logger-options';

// V2 A4-1:logger redact 清单单元测试。
// 黑盒断言 buildLoggerModuleParams 返回的 pinoHttp.redact.paths 包含
// docs/srvf-foundation-baseline.md §8.2 各类敏感字段。
//
// 不启动 NestJS、不连数据库、不调用 pino 实例,仅静态断言常量集合。

const fakeAppCfg: AppConfig = {
  env: 'development',
  port: 3000,
  corsOrigin: ['http://localhost:3000'],
  swaggerEnabled: true,
  logLevel: 'info',
  loginThrottle: { limit: 5, ttlSeconds: 60 },
  // P0-D PR-3 / P0-E PR-3:新增独立 throttler 配置(沿 LoginThrottleConfig 结构);
  // 本 unit test 不关心限流参数,仅满足 AppConfig 接口字段。
  passwordChangeThrottle: { limit: 5, ttlSeconds: 60 },
  refreshThrottle: { limit: 30, ttlSeconds: 60 },
  rbacCache: { ttlSeconds: 1800 },
  // 终态 scoped-authz PR9:AppConfig 新增必填字段;本 unit test 不关心终审约束,仅满足接口
  attendance: { allowSameReviewer: false },
  storage: { encryptionKey: '', localRoot: './tmp/storage' },
  // SMS 基础设施 T2/T3:AppConfig 新增必填字段;本 unit test 不关心 SMS,仅满足接口
  sms: { encryptionKey: '' },
  // 微信小程序登录 T2:AppConfig 新增必填字段;本 unit test 不关心微信,仅满足接口
  wechat: { encryptionKey: '' },
  // 招新一期 · 实名核验通道 T2:AppConfig 新增必填字段;本 unit test 不关心实名核验,仅满足接口
  realname: { encryptionKey: '' },
  smsSendThrottle: { limit: 5, ttlSeconds: 60 },
  smsVerifyThrottle: { limit: 10, ttlSeconds: 60 },
  // 找回密码 T2:AppConfig 新增必填字段;本 unit test 不关心限流参数,仅满足接口
  passwordResetThrottle: { limit: 3, ttlSeconds: 60 },
  loginSmsThrottle: { limit: 5, ttlSeconds: 60 },
  loginWechatThrottle: { limit: 5, ttlSeconds: 60 },
  recruitmentThrottle: { limit: 10, ttlSeconds: 3600 },
  contentPublicThrottle: { limit: 60, ttlSeconds: 60 },
};

function getRedactPaths(): readonly string[] {
  const params = buildLoggerModuleParams(fakeAppCfg);
  const redact =
    params.pinoHttp && 'redact' in params.pinoHttp ? params.pinoHttp.redact : undefined;
  if (!redact || typeof redact !== 'object' || !('paths' in redact)) {
    throw new Error('pinoHttp.redact.paths not found');
  }
  return (redact as { paths: readonly string[] }).paths;
}

describe('LOG_REDACT_PATHS — v1 既有清单兜底', () => {
  const paths = getRedactPaths();

  it.each([
    'req.headers.authorization',
    'req.headers.cookie',
    'res.headers["set-cookie"]',
    'req.body.password',
    'req.body.newPassword',
    'req.body.token',
    'req.body.accessToken',
    'req.body.refreshToken',
    '*.password',
    '*.newPassword',
    '*.passwordHash',
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.secret',
  ])('包含 v1 既有项 %s', (field) => {
    expect(paths).toContain(field);
  });
});

describe('LOG_REDACT_PATHS — V2 baseline §8.2 预扩展字段', () => {
  const paths = getRedactPaths();

  describe('个人身份证类', () => {
    it.each(['*.idCard', '*.idCardNumber', '*.idNumber', '*.nationalId'])('包含 %s', (field) => {
      expect(paths).toContain(field);
    });
  });

  describe('联系方式类', () => {
    it.each([
      '*.phone',
      '*.phoneNumber',
      '*.mobile',
      '*.mobileNumber',
      '*.tel',
      '*.emergencyContact',
      '*.emergencyContactName',
      '*.emergencyContactPhone',
      '*.emergencyContactRelation',
    ])('包含 %s', (field) => {
      expect(paths).toContain(field);
    });
  });

  describe('医疗健康类', () => {
    it.each([
      '*.medicalInfo',
      '*.medicalHistory',
      '*.medicalNotes',
      '*.allergies',
      '*.chronicDiseases',
      '*.bloodType',
      '*.remarksSensitive',
    ])('包含 %s', (field) => {
      expect(paths).toContain(field);
    });
  });

  describe('财务类(防御性)', () => {
    it.each([
      '*.bankAccount',
      '*.bankCard',
      '*.bankCardNumber',
      '*.cardNumber',
      '*.creditCard',
      '*.cvv',
    ])('包含 %s', (field) => {
      expect(paths).toContain(field);
    });
  });

  describe('地址类', () => {
    it.each(['*.homeAddress', '*.address', '*.residenceAddress'])('包含 %s', (field) => {
      expect(paths).toContain(field);
    });
  });

  describe('出生 / 身份信息类', () => {
    it.each(['*.dateOfBirth', '*.dob', '*.birthDate'])('包含 %s', (field) => {
      expect(paths).toContain(field);
    });
  });

  describe('第三方账号 / 凭证标识类', () => {
    it.each([
      '*.wechat',
      '*.wechatId',
      '*.openId',
      '*.unionId',
      '*.certificateNo',
      '*.licenseNo',
      '*.policyNo',
    ])('包含 %s', (field) => {
      expect(paths).toContain(field);
    });
  });
});

describe('LOG_REDACT_PATHS — 落表拼写对齐(2026-06-12 增量审计⑧)', () => {
  it('包含 *.openid(User.openid 落表实际拼写;redact 路径大小写敏感,openId 预留拼写不命中)', () => {
    expect(getRedactPaths()).toContain('*.openid');
  });
});

describe('LOG_REDACT_PATHS — 整体属性', () => {
  const paths = getRedactPaths();

  it('清单内无重复项', () => {
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('清单元素全部为字符串', () => {
    paths.forEach((p) => expect(typeof p).toBe('string'));
  });

  it('清单元素无空字符串', () => {
    paths.forEach((p) => expect(p.length).toBeGreaterThan(0));
  });

  it('censor 配置为 [REDACTED] 字面量(不能改成长度截断)', () => {
    const params = buildLoggerModuleParams(fakeAppCfg);
    const redact =
      params.pinoHttp && 'redact' in params.pinoHttp ? params.pinoHttp.redact : undefined;
    expect((redact as { censor: string }).censor).toBe('[REDACTED]');
  });
});
