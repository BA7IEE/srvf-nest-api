import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import appConfig from '../../config/app.config';
import type { PrismaService } from '../../database/prisma.service';
import {
  deriveSmsCodePepperKey,
  hashSmsVerificationCode,
  SmsCodePepperUnavailableError,
} from './sms-code-hash.util';
import { deriveSmsIssueLockKeys } from './sms-issue-lock';
import type { SmsProviderRouter } from './sms-provider.router';
import { SmsCodeService } from './sms-code.service';
import { SMS_DEV_STUB_FIXED_CODE } from './sms.constants';
import { SmsChannelUnavailableError, SmsProviderSendError } from './sms.types';

// SMS 基础设施 T3:sms-code.service 单元测试(评审稿 §10;mock prisma + router,
// 沿 users.service.spec mock 范式;时序/竞态全链交给 e2e sms-throttle 组)。

const TEST_ENV_SECRET = 'test-sms-code-pepper-key-32-characters-long';

function hmacCode(
  phone: string,
  purpose: string,
  code: string,
  envSecret = TEST_ENV_SECRET,
): string {
  return hashSmsVerificationCode({ phone, purpose, code }, deriveSmsCodePepperKey(envSecret));
}

interface PrismaMockShape {
  smsVerificationCode: {
    findFirst: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  smsSendLog: { create: jest.Mock };
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
}

function makePrismaMock(): PrismaMockShape {
  const prisma: PrismaMockShape = {
    smsVerificationCode: {
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    smsSendLog: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ locked: '' }]),
    $transaction: jest.fn(),
  };
  // $transaction(cb) 直接以 prisma 自身充当 tx(单测不验隔离性)
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
  return prisma;
}

interface RouterMockShape {
  resolveRoute: jest.Mock;
  route: {
    providerType: 'DEV_STUB' | 'TENCENT_SMS';
    prepareVerifyCode: jest.Mock;
  };
  prepareVerifyCode: jest.Mock;
  invoke: jest.Mock;
}

function makeRouterMock(opts: {
  providerType?: 'DEV_STUB' | 'TENCENT_SMS';
  resolveError?: Error;
  prepareError?: Error;
  sendError?: Error;
  providerMsgId?: string | null;
}): RouterMockShape {
  const providerType = opts.providerType ?? 'DEV_STUB';
  const invoke = opts.sendError
    ? jest.fn().mockRejectedValue(opts.sendError)
    : jest.fn().mockResolvedValue({ providerMsgId: opts.providerMsgId ?? null });
  const prepared = { providerType, invoke };
  const prepareError = opts.prepareError;
  const prepareVerifyCode = prepareError
    ? jest.fn().mockImplementation(() => {
        throw prepareError;
      })
    : jest.fn().mockReturnValue(prepared);
  const route = { providerType, prepareVerifyCode };
  const resolveRoute = opts.resolveError
    ? jest.fn().mockRejectedValue(opts.resolveError)
    : jest.fn().mockResolvedValue(route);
  return { resolveRoute, route, prepareVerifyCode, invoke };
}

function makeService(
  prisma: PrismaMockShape,
  router: ReturnType<typeof makeRouterMock>,
  encryptionKey = TEST_ENV_SECRET,
): SmsCodeService {
  return new SmsCodeService(
    prisma as unknown as PrismaService,
    router as unknown as SmsProviderRouter,
    { sms: { encryptionKey } } as ConfigType<typeof appConfig>,
  );
}

// 类型安全取 jest.Mock 第 idx 次调用的首个实参(规避 no-unsafe-* 对 mock.calls any 的告警)
function firstArgOf<T>(mock: jest.Mock, idx = 0): T {
  return (mock.mock.calls as Array<[unknown]>)[idx][0] as T;
}

const ISSUE_INPUT = {
  phone: '13800001234',
  purpose: 'PHONE_BIND' as const,
  userId: 'user-1',
  ip: '127.0.0.1',
};

describe('SmsCodeService.issue', () => {
  it('间隔内再发 → SMS_SEND_INTERVAL_LIMIT;通道先解析但不触发写入/发送', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 10_000), // 10s 前
    });
    prisma.smsVerificationCode.count.mockResolvedValue(1);
    const router = makeRouterMock({});
    const svc = makeService(prisma, router);

    await expect(svc.issue(ISSUE_INPUT)).rejects.toEqual(
      new BizException(BizCode.SMS_SEND_INTERVAL_LIMIT),
    );
    expect(router.resolveRoute).toHaveBeenCalledTimes(1);
    expect(prisma.smsVerificationCode.count).toHaveBeenCalledTimes(1);
    expect(prisma.smsVerificationCode.updateMany).not.toHaveBeenCalled();
    expect(router.prepareVerifyCode).not.toHaveBeenCalled();
    expect(router.invoke).not.toHaveBeenCalled();
  });

  it('日限命中 → SMS_PHONE_DAILY_LIMIT;通道已解析但不写 code / 不发送', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(null);
    prisma.smsVerificationCode.count.mockResolvedValue(10);
    const router = makeRouterMock({});
    const svc = makeService(prisma, router);

    await expect(svc.issue(ISSUE_INPUT)).rejects.toEqual(
      new BizException(BizCode.SMS_PHONE_DAILY_LIMIT),
    );
    expect(router.resolveRoute).toHaveBeenCalledTimes(1);
    expect(prisma.smsVerificationCode.updateMany).not.toHaveBeenCalled();
    expect(router.prepareVerifyCode).not.toHaveBeenCalled();
    expect(router.invoke).not.toHaveBeenCalled();
  });

  it('通道不可用 → SMS_CHANNEL_NOT_CONFIGURED;不建 code 行(不产生计数占用)', async () => {
    const prisma = makePrismaMock();
    const router = makeRouterMock({ resolveError: new SmsChannelUnavailableError('未配置') });
    const svc = makeService(prisma, router);

    await expect(svc.issue(ISSUE_INPUT)).rejects.toEqual(
      new BizException(BizCode.SMS_CHANNEL_NOT_CONFIGURED),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.smsVerificationCode.create).not.toHaveBeenCalled();
  });

  it('dev/test env secret 缺失 → 运行时显式失败且不建 code 行', async () => {
    const prisma = makePrismaMock();
    const svc = makeService(prisma, makeRouterMock({ providerType: 'DEV_STUB' }), '');

    await expect(svc.issue(ISSUE_INPUT)).rejects.toThrow(SmsCodePepperUnavailableError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.smsVerificationCode.create).not.toHaveBeenCalled();
  });

  it('DEV_STUB 成功:固定码 888888 入 hash / 旧活码 superseded / send_log SENT 关联 codeId / 返 300s', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(null);
    prisma.smsVerificationCode.count.mockResolvedValue(0);
    prisma.smsVerificationCode.updateMany.mockResolvedValue({ count: 1 });
    prisma.smsVerificationCode.create.mockResolvedValue({ id: 'code-1' });
    const router = makeRouterMock({ providerType: 'DEV_STUB' });
    const svc = makeService(prisma, router);

    const result = await svc.issue(ISSUE_INPUT);

    expect(result).toEqual({ expiresInSeconds: 300 });
    // 单活码:同 phone+purpose 未消费未作废旧码标 supersededAt(E-9)
    const updateManyArg = firstArgOf<{ where: Record<string, unknown> }>(
      prisma.smsVerificationCode.updateMany,
    );
    expect(updateManyArg.where).toMatchObject({
      phone: ISSUE_INPUT.phone,
      purpose: 'PHONE_BIND',
      consumedAt: null,
      supersededAt: null,
    });
    // 明文码不入库:只存 phone+purpose+code 域分离后的 HMAC-SHA256 hex;DEV_STUB 固定码(E-29)
    const createArg = firstArgOf<{ data: { codeHash: string; userId: string; ip: string } }>(
      prisma.smsVerificationCode.create,
    );
    expect(createArg.data.codeHash).toBe(
      hmacCode(ISSUE_INPUT.phone, ISSUE_INPUT.purpose, SMS_DEV_STUB_FIXED_CODE),
    );
    expect(createArg.data.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(createArg.data.userId).toBe('user-1');
    // 本测试杀死：删 phone 锁 / 删 purpose 锁 / 反序加锁 / 改 session lock。
    const lockKeys = deriveSmsIssueLockKeys(ISSUE_INPUT.phone, ISSUE_INPUT.purpose);
    const rawCalls = prisma.$queryRaw.mock.calls as Array<[TemplateStringsArray, bigint]>;
    expect(rawCalls.map(([, key]) => key)).toEqual([lockKeys.phone, lockKeys.phonePurpose]);
    for (const [sql] of rawCalls) {
      const query = Array.from(sql).join('?');
      expect(query).toContain('pg_advisory_xact_lock');
      expect(query).not.toMatch(/pg_advisory_lock\s*\(/);
    }
    // provider resolve 必须在事务前；锁必须在 latest/count/旧码作废/create 之前。
    expect(router.resolveRoute.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$transaction.mock.invocationCallOrder[0],
    );
    expect(prisma.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      prisma.smsVerificationCode.findFirst.mock.invocationCallOrder[0],
    );
    expect(prisma.smsVerificationCode.count.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.smsVerificationCode.updateMany.mock.invocationCallOrder[0],
    );
    expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      router.prepareVerifyCode.mock.invocationCallOrder[0],
    );
    expect(router.prepareVerifyCode.mock.invocationCallOrder[0]).toBeLessThan(
      router.invoke.mock.invocationCallOrder[0],
    );
    expect(router.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.smsSendLog.create.mock.invocationCallOrder[0],
    );
    // provider 收到明文码 + ttl 分钟
    expect(router.prepareVerifyCode).toHaveBeenCalledWith({
      phone: ISSUE_INPUT.phone,
      code: SMS_DEV_STUB_FIXED_CODE,
      ttlMinutes: 5,
    });
    expect(router.invoke).toHaveBeenCalledTimes(1);
    // send_log SENT + codeId 关联
    const sentLogArg = firstArgOf<{ data: Record<string, unknown> }>(prisma.smsSendLog.create);
    expect(sentLogArg.data).toMatchObject({
      providerType: 'DEV_STUB',
      status: 'SENT',
      codeId: 'code-1',
    });
  });

  it('事务期间 router 当前配置改变：已取得 DEV route 仍固定码 / invoke / evidence 全为 DEV', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(null);
    prisma.smsVerificationCode.count.mockResolvedValue(0);
    prisma.smsVerificationCode.updateMany.mockResolvedValue({ count: 0 });
    prisma.smsVerificationCode.create.mockResolvedValue({ id: 'code-stable-route' });
    const router = makeRouterMock({ providerType: 'DEV_STUB' });
    const nextRouter = makeRouterMock({ providerType: 'TENCENT_SMS' });
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => {
      router.resolveRoute.mockResolvedValue(nextRouter.route);
      return cb(prisma);
    });
    const svc = makeService(prisma, router);

    await expect(svc.issue(ISSUE_INPUT)).resolves.toEqual({ expiresInSeconds: 300 });

    expect(router.resolveRoute).toHaveBeenCalledTimes(1);
    expect(router.prepareVerifyCode).toHaveBeenCalledWith({
      phone: ISSUE_INPUT.phone,
      code: SMS_DEV_STUB_FIXED_CODE,
      ttlMinutes: 5,
    });
    expect(router.invoke).toHaveBeenCalledTimes(1);
    expect(nextRouter.prepareVerifyCode).not.toHaveBeenCalled();
    const createArg = firstArgOf<{ data: { codeHash: string } }>(prisma.smsVerificationCode.create);
    expect(createArg.data.codeHash).toBe(
      hmacCode(ISSUE_INPUT.phone, ISSUE_INPUT.purpose, SMS_DEV_STUB_FIXED_CODE),
    );
    const sentLogArg = firstArgOf<{ data: Record<string, unknown> }>(prisma.smsSendLog.create);
    expect(sentLogArg.data).toMatchObject({
      providerType: 'DEV_STUB',
      status: 'SENT',
      codeId: 'code-stable-route',
    });
  });

  it('TENCENT route：同一六位码用于 hash / prepare send / SENT evidence', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(null);
    prisma.smsVerificationCode.count.mockResolvedValue(0);
    prisma.smsVerificationCode.updateMany.mockResolvedValue({ count: 0 });
    prisma.smsVerificationCode.create.mockResolvedValue({ id: 'code-tencent' });
    const router = makeRouterMock({ providerType: 'TENCENT_SMS', providerMsgId: 'tx-msg-1' });
    const svc = makeService(prisma, router);

    await expect(svc.issue(ISSUE_INPUT)).resolves.toEqual({ expiresInSeconds: 300 });

    const sendInput = firstArgOf<{ phone: string; code: string; ttlMinutes: number }>(
      router.prepareVerifyCode,
    );
    expect(sendInput).toMatchObject({ phone: ISSUE_INPUT.phone, ttlMinutes: 5 });
    expect(sendInput.code).toMatch(/^\d{6}$/);
    const createArg = firstArgOf<{ data: { codeHash: string } }>(prisma.smsVerificationCode.create);
    expect(createArg.data.codeHash).toBe(
      hmacCode(ISSUE_INPUT.phone, ISSUE_INPUT.purpose, sendInput.code),
    );
    expect(router.invoke).toHaveBeenCalledTimes(1);
    const sentLogArg = firstArgOf<{ data: Record<string, unknown> }>(prisma.smsSendLog.create);
    expect(sentLogArg.data).toMatchObject({
      providerType: 'TENCENT_SMS',
      status: 'SENT',
      providerMsgId: 'tx-msg-1',
      codeId: 'code-tencent',
    });
  });

  it('TENCENT prepare 通道失败 → code 行保留 + FAILED evidence + 24030', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(null);
    prisma.smsVerificationCode.count.mockResolvedValue(0);
    prisma.smsVerificationCode.updateMany.mockResolvedValue({ count: 0 });
    prisma.smsVerificationCode.create.mockResolvedValue({ id: 'code-prepare-failed' });
    const router = makeRouterMock({
      providerType: 'TENCENT_SMS',
      prepareError: new SmsChannelUnavailableError('credentialStatus=missing'),
    });
    const svc = makeService(prisma, router);

    await expect(svc.issue(ISSUE_INPUT)).rejects.toEqual(
      new BizException(BizCode.SMS_CHANNEL_NOT_CONFIGURED),
    );

    expect(prisma.smsVerificationCode.create).toHaveBeenCalledTimes(1);
    expect(router.prepareVerifyCode).toHaveBeenCalledTimes(1);
    expect(router.invoke).not.toHaveBeenCalled();
    const failedLogArg = firstArgOf<{ data: Record<string, unknown> }>(prisma.smsSendLog.create);
    expect(failedLogArg.data).toMatchObject({
      providerType: 'TENCENT_SMS',
      status: 'FAILED',
      errCode: 'CHANNEL_UNAVAILABLE',
      codeId: 'code-prepare-failed',
    });
    warnSpy.mockRestore();
  });

  it('TENCENT_SMS 发送失败 → send_log FAILED(errCode/errMsg)+ SMS_SEND_FAILED;code 行保留', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(null);
    prisma.smsVerificationCode.count.mockResolvedValue(0);
    prisma.smsVerificationCode.updateMany.mockResolvedValue({ count: 0 });
    prisma.smsVerificationCode.create.mockResolvedValue({ id: 'code-2' });
    const router = makeRouterMock({
      providerType: 'TENCENT_SMS',
      sendError: new SmsProviderSendError('LimitExceeded', 'provider daily limit'),
    });
    const svc = makeService(prisma, router);

    await expect(svc.issue(ISSUE_INPUT)).rejects.toEqual(new BizException(BizCode.SMS_SEND_FAILED));
    const failedLogArg = firstArgOf<{ data: Record<string, unknown> }>(prisma.smsSendLog.create);
    expect(failedLogArg.data).toMatchObject({
      providerType: 'TENCENT_SMS',
      status: 'FAILED',
      errCode: 'LimitExceeded',
      errMsg: 'provider daily limit',
      codeId: 'code-2',
    });
    expect(router.prepareVerifyCode).toHaveBeenCalledTimes(1);
    expect(router.invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(TEST_ENV_SECRET);
    warnSpy.mockRestore();
  });
});

describe('SMS issue advisory-lock protocol', () => {
  it('固定 namespace + SHA-256 前 64 bit signed bigint golden vector', () => {
    expect(deriveSmsIssueLockKeys('13800001234', 'PHONE_BIND')).toEqual({
      phone: -5576935995228336407n,
      phonePurpose: -1392771664796476507n,
    });
  });

  it('锁 key 只接受既有 DTO/User 链保证的 canonical 11 位手机号', () => {
    expect(() => deriveSmsIssueLockKeys(' 13800001234', 'PHONE_BIND')).toThrow(TypeError);
  });
});

describe('SmsCodeService.verifyAndConsume', () => {
  const ACTIVE = {
    id: 'code-9',
    codeHash: hmacCode('13800001234', 'PHONE_BIND', '654321'),
    userId: 'user-1',
  };
  const VERIFY_INPUT = {
    phone: '13800001234',
    purpose: 'PHONE_BIND' as const,
    code: '654321',
    userId: 'user-1',
  };

  it.each([
    ['活码不存在', []],
    ['DB 时钟已过期', []],
    ['错 5 次已作废', []],
    ['归属不符(E-8)', [{ ...ACTIVE, userId: 'user-2' }]],
  ])('%s → 统一 SMS_CODE_INVALID(防枚举)', async (_label, rows) => {
    const prisma = makePrismaMock();
    prisma.$queryRaw.mockResolvedValue(rows);
    const svc = makeService(prisma, makeRouterMock({}));

    await expect(svc.verifyAndConsume(VERIFY_INPUT)).rejects.toEqual(
      new BizException(BizCode.SMS_CODE_INVALID),
    );
    // 这些路径不产生 attempts 计数写
    expect(prisma.smsVerificationCode.update).not.toHaveBeenCalled();
  });

  it('码值不符 → attempts+1 独立提交 + SMS_CODE_INVALID', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([ACTIVE]).mockResolvedValueOnce([{ id: 'code-9' }]);
    const svc = makeService(prisma, makeRouterMock({}));

    await expect(svc.verifyAndConsume({ ...VERIFY_INPUT, code: '000000' })).rejects.toEqual(
      new BizException(BizCode.SMS_CODE_INVALID),
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    const rawCalls = prisma.$queryRaw.mock.calls as Array<[TemplateStringsArray, ...unknown[]]>;
    const [sql, codeId, maxAttempts] = rawCalls[1];
    const query = Array.from(sql).join('?');
    expect([codeId, maxAttempts]).toEqual(['code-9', 5]);
    expect(query).toContain('locked_code AS MATERIALIZED');
    expect(query).toContain('FOR UPDATE');
    expect(query).toContain('FROM locked_code');
    expect(query.indexOf('FOR UPDATE')).toBeLessThan(query.indexOf('clock_timestamp()'));
    expect(query).toContain('SET "attempts" = target."attempts" + 1');
    expect(query).toContain('target."expiresAt" > db_clock.captured_at');
    expect(prisma.smsVerificationCode.update).not.toHaveBeenCalled();
  });

  it('命中 → 参数化单条 UPDATE ... RETURNING 以同一 DB UTC 时钟重查并消费', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([ACTIVE]).mockResolvedValueOnce([{ id: 'code-9' }]);
    const svc = makeService(prisma, makeRouterMock({}));

    await expect(svc.verifyAndConsume(VERIFY_INPUT)).resolves.toEqual({ codeId: 'code-9' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    const rawCalls = prisma.$queryRaw.mock.calls as Array<[TemplateStringsArray, ...unknown[]]>;
    const [precheckSql, phone, purpose, precheckMaxAttempts] = rawCalls[0];
    const precheckQuery = Array.from(precheckSql).join('?');
    expect([phone, purpose, precheckMaxAttempts]).toEqual([VERIFY_INPUT.phone, 'PHONE_BIND', 5]);
    expect(precheckQuery).toContain('latest_code AS MATERIALIZED');
    expect(precheckQuery).toContain('candidate."purpose" = CAST(? AS "SmsPurpose")');
    expect(precheckQuery).toContain('ORDER BY candidate."createdAt" DESC');
    expect(precheckQuery).toContain('LIMIT 1');
    expect(precheckQuery).toContain('latest_code."attempts" < ?');
    expect(precheckQuery).toContain('latest_code."expiresAt" > db_clock.captured_at');
    expect(precheckQuery).toContain("clock_timestamp() AT TIME ZONE 'UTC'");

    const [sql, codeId, maxAttempts] = rawCalls[1];
    const query = Array.from(sql).join('?');
    expect([codeId, maxAttempts]).toEqual(['code-9', 5]);
    expect(query).toContain('locked_code AS MATERIALIZED');
    expect(query).toContain('WHERE candidate."id" = ?');
    expect(query).toContain('FOR UPDATE');
    expect(query).toContain('FROM locked_code');
    expect(query.indexOf('FOR UPDATE')).toBeLessThan(query.indexOf('clock_timestamp()'));
    expect(query).toContain('UPDATE "sms_verification_codes" AS target');
    expect(query).toContain('SET "consumedAt" = db_clock.captured_at');
    expect(query).toContain('target."consumedAt" IS NULL');
    expect(query).toContain('target."supersededAt" IS NULL');
    expect(query).toContain('target."attempts" < ?');
    expect(query).toContain('target."expiresAt" > db_clock.captured_at');
    expect(query).toContain('RETURNING target."id" AS "id"');
    expect(query.match(/clock_timestamp\(\)/g)).toHaveLength(1);
    expect(query).toContain("clock_timestamp() AT TIME ZONE 'UTC'");
    expect(prisma.smsVerificationCode.updateMany).not.toHaveBeenCalled();
  });

  it('最终 UPDATE ... RETURNING 0 行 → 统一 SMS_CODE_INVALID', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([ACTIVE]).mockResolvedValueOnce([]);
    const svc = makeService(prisma, makeRouterMock({}));

    await expect(svc.verifyAndConsume(VERIFY_INPUT)).rejects.toEqual(
      new BizException(BizCode.SMS_CODE_INVALID),
    );
  });
});

// 找回密码 T2(2026-06-11):只验不消费预检(评审稿 password-reset-by-sms-review.md E-5/E-6;
// 校验链与 verifyAndConsume 共用 loadValidActiveCodeOrThrow,错码 attempts+1 语义一致)。
describe('SmsCodeService.assertValid(只验不消费;PASSWORD_RESET 接线)', () => {
  const ACTIVE = {
    id: 'code-pr-1',
    codeHash: hmacCode('13800001234', 'PASSWORD_RESET', '654321'),
    userId: 'user-1',
  };
  const INPUT = {
    phone: '13800001234',
    purpose: 'PASSWORD_RESET' as const,
    code: '654321',
    userId: 'user-1',
  };

  it('有效码 → resolve 且**不**消费(零 updateMany / 零 update)', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([ACTIVE]);
    const svc = makeService(prisma, makeRouterMock({}));

    await expect(svc.assertValid(INPUT)).resolves.toBeUndefined();
    expect(prisma.smsVerificationCode.updateMany).not.toHaveBeenCalled();
    expect(prisma.smsVerificationCode.update).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const [[sql, phone, purpose, maxAttempts]] = prisma.$queryRaw.mock.calls as Array<
      [TemplateStringsArray, string, string, number]
    >;
    const query = Array.from(sql).join('?');
    expect([phone, purpose, maxAttempts]).toEqual([INPUT.phone, 'PASSWORD_RESET', 5]);
    expect(query).toContain('latest_code AS MATERIALIZED');
    expect(query).toContain('latest_code."attempts" < ?');
    expect(query).toContain('latest_code."expiresAt" > db_clock.captured_at');
    expect(prisma.smsVerificationCode.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['活码不存在', [], INPUT],
    ['DB 已过期的错码(不增加 attempts)', [], { ...INPUT, code: '000000' }],
    ['错 5 次已作废', [], INPUT],
    ['归属不符(E-8)', [{ ...ACTIVE, userId: 'user-2' }], INPUT],
  ])('%s → 统一 SMS_CODE_INVALID(防枚举,与 verifyAndConsume 一致)', async (_label, rows, input) => {
    const prisma = makePrismaMock();
    prisma.$queryRaw.mockResolvedValue(rows);
    const svc = makeService(prisma, makeRouterMock({}));

    await expect(svc.assertValid(input)).rejects.toEqual(
      new BizException(BizCode.SMS_CODE_INVALID),
    );
    expect(prisma.smsVerificationCode.update).not.toHaveBeenCalled();
    expect(prisma.smsVerificationCode.updateMany).not.toHaveBeenCalled();
  });

  it('码值不符 → attempts+1 独立提交(防爆破不因预检弱化)+ SMS_CODE_INVALID;仍不消费', async () => {
    const prisma = makePrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([ACTIVE]).mockResolvedValueOnce([{ id: 'code-pr-1' }]);
    const svc = makeService(prisma, makeRouterMock({}));

    await expect(svc.assertValid({ ...INPUT, code: '000000' })).rejects.toEqual(
      new BizException(BizCode.SMS_CODE_INVALID),
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    const rawCalls = prisma.$queryRaw.mock.calls as Array<[TemplateStringsArray, ...unknown[]]>;
    const [sql, codeId, maxAttempts] = rawCalls[1];
    const query = Array.from(sql).join('?');
    expect([codeId, maxAttempts]).toEqual(['code-pr-1', 5]);
    expect(query).toContain('SET "attempts" = target."attempts" + 1');
    expect(query.indexOf('FOR UPDATE')).toBeLessThan(query.indexOf('clock_timestamp()'));
    expect(prisma.smsVerificationCode.update).not.toHaveBeenCalled();
    expect(prisma.smsVerificationCode.updateMany).not.toHaveBeenCalled();
  });
});

describe('SMS code HMAC pepper boundary', () => {
  it('同 code 在不同 phone / purpose 下产生不同 hash', () => {
    const byPhone = hmacCode('13800001234', 'PHONE_BIND', '654321');
    const otherPhone = hmacCode('13900001234', 'PHONE_BIND', '654321');
    const otherPurpose = hmacCode('13800001234', 'PASSWORD_RESET', '654321');

    expect(byPhone).toMatch(/^[0-9a-f]{64}$/);
    expect(otherPhone).not.toBe(byPhone);
    expect(otherPurpose).not.toBe(byPhone);
  });

  it('不同 env secret 派生的 pepper key 产生不同 hash', () => {
    const first = hmacCode('13800001234', 'PHONE_BIND', '654321');
    const second = hmacCode(
      '13800001234',
      'PHONE_BIND',
      '654321',
      'another-test-sms-pepper-key-32-characters-long',
    );

    expect(second).not.toBe(first);
  });

  it('env secret 缺失时显式失败且错误信息不包含任何 secret', () => {
    expect(() => deriveSmsCodePepperKey('')).toThrow(SmsCodePepperUnavailableError);
    expect(() => deriveSmsCodePepperKey('')).toThrow(
      'SMS_CODE_PEPPER_UNAVAILABLE: SMS code hashing key is not configured',
    );
  });
});
