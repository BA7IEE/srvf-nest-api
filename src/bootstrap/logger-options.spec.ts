import type { AppConfig } from '../config/app.config';
import { createServer, type IncomingMessage } from 'node:http';
import pino, { type LoggerOptions } from 'pino';
import pinoHttp from 'pino-http';
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
  trustedProxyCidrs: [],
  swaggerEnabled: true,
  logLevel: 'info',
  loginThrottle: { limit: 5, ttlSeconds: 60 },
  // P0-D PR-3 / P0-E PR-3:新增独立 throttler 配置(沿 LoginThrottleConfig 结构);
  // 本 unit test 不关心限流参数,仅满足 AppConfig 接口字段。
  passwordChangeThrottle: { limit: 5, ttlSeconds: 60 },
  refreshThrottle: { limit: 30, ttlSeconds: 60 },
  // 终态 scoped-authz PR9:AppConfig 新增必填字段;本 unit test 不关心终审约束,仅满足接口
  attendance: {
    allowSameReviewer: false,
    windowToleranceHours: 2,
    checkInRadiusMeters: 500,
    feedbackWindowDays: 30,
  },
  insurance: { enforcementEnabled: false },
  activityResponsibilityWorkflow: { enabled: false },
  storage: { encryptionKey: '', localRoot: './tmp/storage', consistencyMode: 'JIT' },
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
  recruitmentOcr: { dailyIpLimit: 30 },
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

function serializeWithConfiguredRedaction(
  value: Record<string, unknown>,
  serializers?: LoggerOptions['serializers'],
): Record<string, unknown> {
  const params = buildLoggerModuleParams(fakeAppCfg);
  const redact =
    params.pinoHttp && 'redact' in params.pinoHttp ? params.pinoHttp.redact : undefined;
  let output = '';
  const logger = pino(
    {
      base: null,
      timestamp: false,
      redact,
      serializers,
    },
    { write: (chunk: string) => (output += chunk) },
  );
  logger.info(value);
  return JSON.parse(output) as Record<string, unknown>;
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
    'req.body.stepUpToken',
    '*.password',
    '*.newPassword',
    '*.passwordHash',
    '*.token',
    '*.accessToken',
    '*.refreshToken',
    '*.stepUpToken',
    '*.secret',
  ])('包含 v1 既有项 %s', (field) => {
    expect(paths).toContain(field);
  });
});

describe('LOG_REDACT_PATHS — client IP identity', () => {
  const paths = getRedactPaths();

  it.each([
    'req.headers["x-forwarded-for"]',
    'req.headers.forwarded',
    'req.headers["x-real-ip"]',
    'req.ip',
    'req.ips',
    'req.remoteAddress',
    'req.remotePort',
    'req.socket.remoteAddress',
    'req.socket.remotePort',
    'req.connection.remoteAddress',
    'req.connection.remotePort',
  ])('包含精确 HTTP request 路径 %s', (field) => {
    expect(paths).toContain(field);
  });

  it('redacts proxy headers and pino standard req serializer remote peer fields in actual output', () => {
    const serialized = serializeWithConfiguredRedaction(
      {
        req: {
          method: 'GET',
          url: '/api/system/v1/health',
          headers: {
            host: 'localhost',
            'x-forwarded-for': '203.0.113.10',
            forwarded: 'for=203.0.113.11',
            'x-real-ip': '203.0.113.12',
          },
          socket: { remoteAddress: '198.51.100.20', remotePort: 43123 },
        },
      },
      { req: pino.stdSerializers.req },
    );
    const req = serialized.req as {
      headers: Record<string, unknown>;
      remoteAddress: unknown;
      remotePort: unknown;
    };

    expect(req.headers['x-forwarded-for']).toBe('[REDACTED]');
    expect(req.headers.forwarded).toBe('[REDACTED]');
    expect(req.headers['x-real-ip']).toBe('[REDACTED]');
    expect(req.remoteAddress).toBe('[REDACTED]');
    expect(req.remotePort).toBe('[REDACTED]');
    expect(JSON.stringify(serialized)).not.toContain('203.0.113.10');
    expect(JSON.stringify(serialized)).not.toContain('198.51.100.20');
    expect(JSON.stringify(serialized)).not.toContain('43123');
  });

  it('redacts explicitly logged Express identity getters and socket aliases', () => {
    const serialized = serializeWithConfiguredRedaction({
      req: {
        ip: '203.0.113.20',
        ips: ['203.0.113.20', '198.51.100.20'],
        remoteAddress: '198.51.100.20',
        remotePort: 43124,
        socket: { remoteAddress: '198.51.100.21', remotePort: 43125 },
        connection: { remoteAddress: '198.51.100.22', remotePort: 43126 },
      },
    });
    const req = serialized.req as Record<string, unknown>;

    expect(req.ip).toBe('[REDACTED]');
    expect(req.ips).toBe('[REDACTED]');
    expect(req.remoteAddress).toBe('[REDACTED]');
    expect(req.remotePort).toBe('[REDACTED]');
    expect(req.socket).toEqual({ remoteAddress: '[REDACTED]', remotePort: '[REDACTED]' });
    expect(req.connection).toEqual({ remoteAddress: '[REDACTED]', remotePort: '[REDACTED]' });
    expect(JSON.stringify(serialized)).not.toMatch(/203\.0\.113|198\.51\.100|4312[4-6]/);
  });
});

describe('LOG_REDACT_PATHS — pre-go-live readiness review v0.35.0 §4 F-1 补洞(2026-07-04)', () => {
  const paths = getRedactPaths();

  it.each(['req.body.oldPassword', '*.oldPassword'])(
    '包含本人改密 %s(ChangeMyPasswordDto.oldPassword;文档一直声称存在、代码此前从未覆盖)',
    (field) => {
      expect(paths).toContain(field);
    },
  );

  describe('证件 OCR 识别中间字段(RecruitmentOcrDetailDto / RealnameOcrField 同构兄弟字段;address 已由既有 *.address 覆盖)', () => {
    it.each(['*.sex', '*.nation', '*.birth', '*.authority', '*.validDate'])('包含 %s', (field) => {
      expect(paths).toContain(field);
    });
  });

  describe('证件号 / 姓名结构性缺口', () => {
    it.each(['*.documentNumber', '*.realName'])('包含 %s', (field) => {
      expect(paths).toContain(field);
    });
  });

  describe('命名口径纠偏(落表真实字段名;旧 *.certificateNo / *.policyNo 保留不删)', () => {
    it.each(['*.certNumber', '*.policyNumber'])('包含 %s', (field) => {
      expect(paths).toContain(field);
    });
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

describe('LOG_REDACT_PATHS — 活动自助 GPS 签到位置轨迹(F1,2026-07-15)', () => {
  const paths = getRedactPaths();

  it.each([
    'req.body.longitude',
    'req.body.latitude',
    '*.longitude',
    '*.latitude',
    '*.checkInLongitude',
    '*.checkInLatitude',
    '*.checkOutLongitude',
    '*.checkOutLatitude',
  ])('包含原始位置字段 %s', (field) => {
    expect(paths).toContain(field);
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

describe('HTTP request serializer — query values never enter automatic logs', () => {
  it('captures method/pathname/status/responseTime/reqId/userId without query or originalUrl', async () => {
    const lines: string[] = [];
    const params = buildLoggerModuleParams({
      ...fakeAppCfg,
      env: 'production',
    });
    if (
      !params.pinoHttp ||
      typeof params.pinoHttp !== 'object' ||
      !('genReqId' in params.pinoHttp)
    ) {
      throw new Error('pinoHttp options not found');
    }
    const middleware = pinoHttp(params.pinoHttp, {
      write: (line: string) => lines.push(line),
    });
    const server = createServer((req, res) => {
      const requestWithIdentity = req as IncomingMessage & {
        id: string;
        user: { id: string };
      };
      requestWithIdentity.id = 'req-log-query-redaction';
      requestWithIdentity.user = { id: 'user-log-query-redaction' };
      middleware(req, res, () => {
        res.statusCode = 204;
        res.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP test server has no port');
    try {
      const query = new URLSearchParams({
        q: '13800138000',
        email: 'person@example.com',
        name: '敏感姓名',
      });
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/admin/v1/users?${query.toString()}`,
      );
      expect(response.status).toBe(204);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const completed = records.find((record) => record.msg === 'request completed');
    expect(completed).toBeDefined();
    expect(completed).toMatchObject({
      req: { method: 'GET', url: '/api/admin/v1/users' },
      res: { statusCode: 204 },
      reqId: 'req-log-query-redaction',
      userId: 'user-log-query-redaction',
    });
    expect(typeof completed?.responseTime).toBe('number');
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('13800138000');
    expect(serialized).not.toContain('person@example.com');
    expect(serialized).not.toContain('敏感姓名');
    expect(serialized).not.toContain('q=');
    expect(serialized).not.toContain('originalUrl');
    expect((completed?.req as Record<string, unknown>).query).toBeUndefined();
  });
});
