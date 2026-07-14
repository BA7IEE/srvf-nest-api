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
    $transaction: jest.fn(),
  };
  // $transaction(cb) 直接以 prisma 自身充当 tx(单测不验隔离性)
  prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb(prisma));
  return prisma;
}

function makeRouterMock(opts: {
  providerType?: 'DEV_STUB' | 'TENCENT_SMS';
  resolveError?: Error;
  sendError?: Error;
  providerMsgId?: string | null;
}): { resolveProviderType: jest.Mock; sendVerifyCode: jest.Mock } {
  const resolveProviderType = opts.resolveError
    ? jest.fn().mockRejectedValue(opts.resolveError)
    : jest.fn().mockResolvedValue(opts.providerType ?? 'DEV_STUB');
  const sendVerifyCode = opts.sendError
    ? jest.fn().mockRejectedValue(opts.sendError)
    : jest.fn().mockResolvedValue({ providerMsgId: opts.providerMsgId ?? null });
  return { resolveProviderType, sendVerifyCode };
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
  it('间隔内再发 → SMS_SEND_INTERVAL_LIMIT;不触发后续步骤', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 10_000), // 10s 前
    });
    const router = makeRouterMock({});
    const svc = makeService(prisma, router);

    await expect(svc.issue(ISSUE_INPUT)).rejects.toEqual(
      new BizException(BizCode.SMS_SEND_INTERVAL_LIMIT),
    );
    expect(prisma.smsVerificationCode.count).not.toHaveBeenCalled();
    expect(router.sendVerifyCode).not.toHaveBeenCalled();
  });

  it('日限命中 → SMS_PHONE_DAILY_LIMIT;不解析通道', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(null);
    prisma.smsVerificationCode.count.mockResolvedValue(10);
    const router = makeRouterMock({});
    const svc = makeService(prisma, router);

    await expect(svc.issue(ISSUE_INPUT)).rejects.toEqual(
      new BizException(BizCode.SMS_PHONE_DAILY_LIMIT),
    );
    expect(router.resolveProviderType).not.toHaveBeenCalled();
  });

  it('通道不可用 → SMS_CHANNEL_NOT_CONFIGURED;不建 code 行(不产生计数占用)', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(null);
    prisma.smsVerificationCode.count.mockResolvedValue(0);
    const router = makeRouterMock({ resolveError: new SmsChannelUnavailableError('未配置') });
    const svc = makeService(prisma, router);

    await expect(svc.issue(ISSUE_INPUT)).rejects.toEqual(
      new BizException(BizCode.SMS_CHANNEL_NOT_CONFIGURED),
    );
    expect(prisma.smsVerificationCode.create).not.toHaveBeenCalled();
  });

  it('dev/test env secret 缺失 → 运行时显式失败且不建 code 行', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(null);
    prisma.smsVerificationCode.count.mockResolvedValue(0);
    prisma.smsVerificationCode.updateMany.mockResolvedValue({ count: 0 });
    const svc = makeService(prisma, makeRouterMock({ providerType: 'DEV_STUB' }), '');

    await expect(svc.issue(ISSUE_INPUT)).rejects.toThrow(SmsCodePepperUnavailableError);
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
    // provider 收到明文码 + ttl 分钟
    expect(router.sendVerifyCode).toHaveBeenCalledWith({
      phone: ISSUE_INPUT.phone,
      code: SMS_DEV_STUB_FIXED_CODE,
      ttlMinutes: 5,
    });
    // send_log SENT + codeId 关联
    const sentLogArg = firstArgOf<{ data: Record<string, unknown> }>(prisma.smsSendLog.create);
    expect(sentLogArg.data).toMatchObject({ status: 'SENT', codeId: 'code-1' });
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
      status: 'FAILED',
      errCode: 'LimitExceeded',
      errMsg: 'provider daily limit',
      codeId: 'code-2',
    });
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(TEST_ENV_SECRET);
    warnSpy.mockRestore();
  });
});

describe('SmsCodeService.verifyAndConsume', () => {
  const ACTIVE = {
    id: 'code-9',
    codeHash: hmacCode('13800001234', 'PHONE_BIND', '654321'),
    userId: 'user-1',
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
  };
  const VERIFY_INPUT = {
    phone: '13800001234',
    purpose: 'PHONE_BIND' as const,
    code: '654321',
    userId: 'user-1',
  };

  it.each([
    ['活码不存在', null, VERIFY_INPUT],
    ['已过期', { ...ACTIVE, expiresAt: new Date(Date.now() - 1000) }, VERIFY_INPUT],
    ['错 5 次已作废', { ...ACTIVE, attempts: 5 }, VERIFY_INPUT],
    ['归属不符(E-8)', { ...ACTIVE, userId: 'user-2' }, VERIFY_INPUT],
  ])('%s → 统一 SMS_CODE_INVALID(防枚举)', async (_label, row, input) => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(row);
    const svc = makeService(prisma, makeRouterMock({}));

    await expect(svc.verifyAndConsume(input)).rejects.toEqual(
      new BizException(BizCode.SMS_CODE_INVALID),
    );
    // 这些路径不产生 attempts 计数写
    expect(prisma.smsVerificationCode.update).not.toHaveBeenCalled();
  });

  it('码值不符 → attempts+1 独立提交 + SMS_CODE_INVALID', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(ACTIVE);
    prisma.smsVerificationCode.update.mockResolvedValue({});
    const svc = makeService(prisma, makeRouterMock({}));

    await expect(svc.verifyAndConsume({ ...VERIFY_INPUT, code: '000000' })).rejects.toEqual(
      new BizException(BizCode.SMS_CODE_INVALID),
    );
    expect(prisma.smsVerificationCode.update).toHaveBeenCalledWith({
      where: { id: 'code-9' },
      data: { attempts: { increment: 1 } },
    });
  });

  it('命中 → 原子抢占消费(consumedAt: null 条件)并返 codeId', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(ACTIVE);
    prisma.smsVerificationCode.updateMany.mockResolvedValue({ count: 1 });
    const svc = makeService(prisma, makeRouterMock({}));

    await expect(svc.verifyAndConsume(VERIFY_INPUT)).resolves.toEqual({ codeId: 'code-9' });
    expect(prisma.smsVerificationCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'code-9', consumedAt: null } }),
    );
  });

  it('并发重放输家(updateMany count=0)→ SMS_CODE_INVALID', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(ACTIVE);
    prisma.smsVerificationCode.updateMany.mockResolvedValue({ count: 0 });
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
    expiresAt: new Date(Date.now() + 60_000),
    attempts: 0,
  };
  const INPUT = {
    phone: '13800001234',
    purpose: 'PASSWORD_RESET' as const,
    code: '654321',
    userId: 'user-1',
  };

  it('有效码 → resolve 且**不**消费(零 updateMany / 零 update)', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(ACTIVE);
    const svc = makeService(prisma, makeRouterMock({}));

    await expect(svc.assertValid(INPUT)).resolves.toBeUndefined();
    expect(prisma.smsVerificationCode.updateMany).not.toHaveBeenCalled();
    expect(prisma.smsVerificationCode.update).not.toHaveBeenCalled();
    // purpose 透传进 where(PHONE_BIND / PASSWORD_RESET 活码互不可见);
    // toHaveBeenCalledWith 深度严格相等(不嵌套 objectContaining,规避 no-unsafe-assignment)
    expect(prisma.smsVerificationCode.findFirst).toHaveBeenCalledWith({
      where: {
        phone: INPUT.phone,
        purpose: 'PASSWORD_RESET',
        consumedAt: null,
        supersededAt: null,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, codeHash: true, userId: true, expiresAt: true, attempts: true },
    });
  });

  it.each([
    ['活码不存在', null],
    ['已过期', { ...ACTIVE, expiresAt: new Date(Date.now() - 1000) }],
    ['错 5 次已作废', { ...ACTIVE, attempts: 5 }],
    ['归属不符(E-8)', { ...ACTIVE, userId: 'user-2' }],
  ])('%s → 统一 SMS_CODE_INVALID(防枚举,与 verifyAndConsume 一致)', async (_label, row) => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(row);
    const svc = makeService(prisma, makeRouterMock({}));

    await expect(svc.assertValid(INPUT)).rejects.toEqual(
      new BizException(BizCode.SMS_CODE_INVALID),
    );
    expect(prisma.smsVerificationCode.update).not.toHaveBeenCalled();
    expect(prisma.smsVerificationCode.updateMany).not.toHaveBeenCalled();
  });

  it('码值不符 → attempts+1 独立提交(防爆破不因预检弱化)+ SMS_CODE_INVALID;仍不消费', async () => {
    const prisma = makePrismaMock();
    prisma.smsVerificationCode.findFirst.mockResolvedValue(ACTIVE);
    prisma.smsVerificationCode.update.mockResolvedValue({});
    const svc = makeService(prisma, makeRouterMock({}));

    await expect(svc.assertValid({ ...INPUT, code: '000000' })).rejects.toEqual(
      new BizException(BizCode.SMS_CODE_INVALID),
    );
    expect(prisma.smsVerificationCode.update).toHaveBeenCalledWith({
      where: { id: 'code-pr-1' },
      data: { attempts: { increment: 1 } },
    });
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
