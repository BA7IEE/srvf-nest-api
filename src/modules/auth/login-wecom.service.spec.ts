import { UserStatus } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { SmsCodeService } from '../sms/sms-code.service';
import type { WecomAuthAttemptService } from '../wecom/wecom-auth-attempt.service';
import type { WecomService } from '../wecom/wecom.service';
import type { AuthService } from './auth.service';
import { LoginWecomService } from './login-wecom.service';
import {
  WECOM_LOGIN_FAILURE_FLOOR_MS,
  WECOM_LOGIN_FAILURE_JITTER_MS,
  WecomLoginFailureGate,
} from './wecom-login-failure.gate';

// P1-27 第一刀 B3(2026-08-03):36010 **分支 instrumentation**。
//
// 为什么是单测而不是 e2e:goal 明令不写毫秒阈值 e2e —— 那种断言既脆弱(CI 机器抖动)
// 又只能证明"这一次跑得差不多快",证明不了"每一条分支都真的经过了归一化出口"。
// 这里把出口换成 spy,逐分支断言它**恰好被调用一次**,并且抛出的确实是 36010。
// 判据因此是结构性的:将来新增一条 36010 分支,只要它绕过出口,这张表就红。
//
// 分支清单直接对着修前取证探针实测的那四条 + B1 新增的一条:
//   A state 无效(含 B1 的"浏览器不匹配")· B code 本地格式无效
//   C 上游拒绝 code · D 身份指向 DISABLED / 软删 User

const META: AuditMeta = { requestId: 'req-1', ip: '127.0.0.1', ua: 'jest' };
const VALID_STATE = 'a'.repeat(64);
const VALID_CODE = 'wecom-oauth-code';
const NONCE = 'b'.repeat(64);

type AttemptRow = {
  id: string;
  purpose: 'login';
  returnPath: string;
  subjectUserId: string | null;
};

const ATTEMPT: AttemptRow = {
  id: 'attempt-1',
  purpose: 'login',
  returnPath: '/activities',
  subjectUserId: null,
};

function makeHarness() {
  const prisma = {
    wecomIdentity: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const wecom = {
    resolveLoginContext: jest.fn().mockResolvedValue({ provider: {}, corpId: 'ww-corp-1' }),
    exchangeOAuthCode: jest.fn().mockResolvedValue({ wecomUserId: 'zhangsan' }),
    getAuthorizeContext: jest.fn(),
  };
  const attempts = {
    consumeState: jest.fn().mockResolvedValue(ATTEMPT),
    issueBindingTicket: jest.fn().mockResolvedValue({
      bindingTicket: 'ticket-1',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    }),
    markFailed: jest.fn().mockResolvedValue(undefined),
    markCompleted: jest.fn().mockResolvedValue(undefined),
    createAttempt: jest.fn(),
    findValidBinding: jest.fn(),
    consumeBindingTicket: jest.fn(),
  };
  const smsCode = { issue: jest.fn(), assertValid: jest.fn(), verifyAndConsume: jest.fn() };
  const auth = { createSession: jest.fn() };
  const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };

  // 真出口的行为(补齐 + 抛)在 gate 自己的用例里验;这里换成 spy,
  // 让"每条分支都经过它"成为可断言的事实,同时把 150ms 的等待从单测里拿掉。
  const failures = {
    reject: jest.fn<Promise<never>, [number]>(async (): Promise<never> => {
      await Promise.resolve();
      throw new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID);
    }),
  };

  const service = new LoginWecomService(
    prisma as unknown as PrismaService,
    wecom as unknown as WecomService,
    attempts as unknown as WecomAuthAttemptService,
    smsCode as unknown as SmsCodeService,
    auth as unknown as AuthService,
    auditLogs as unknown as AuditLogsService,
    failures,
  );
  return { service, prisma, wecom, attempts, failures };
}

type Harness = ReturnType<typeof makeHarness>;

describe('LoginWecomService — 36010 单一出口(B3 分支 instrumentation)', () => {
  beforeEach(() => jest.clearAllMocks());

  // 每一条 = 一个真实可达的 36010 分支 + 把 harness 摆成那个分支的最小改动。
  const branches: Array<{ label: string; arrange: (h: Harness) => void }> = [
    {
      // B1 把"浏览器不匹配"也折进了同一个 null 返回 —— 它是最廉价的分支,
      // 恰恰最需要归一化(不归一就等于告诉攻击者"这个 state 我方认得")。
      label: 'A1 state 无效 / 已消费 / 过期 / purpose 不符',
      arrange: (h) => h.attempts.consumeState.mockResolvedValue(null),
    },
    {
      label: 'A2 浏览器关联 nonce 不匹配(B1 新增)',
      arrange: (h) => h.attempts.consumeState.mockResolvedValue(null),
    },
    {
      label: 'B code 本地格式无效(不打上游)',
      arrange: () => undefined, // 由下面的 code 入参触发
    },
    {
      label: 'C 上游拒绝 code / 外部成员 / 跨企业(深层抛同码)',
      arrange: (h) =>
        h.wecom.exchangeOAuthCode.mockRejectedValue(
          new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID),
        ),
    },
    {
      label: 'D 绑定指向已软删 User',
      arrange: (h) => {
        h.prisma.wecomIdentity.findFirst.mockResolvedValue({ id: 'id-1', userId: 'user-1' });
        h.prisma.user.findUnique.mockResolvedValue({
          id: 'user-1',
          status: UserStatus.ACTIVE,
          deletedAt: new Date(),
        });
      },
    },
    {
      label: 'D2 绑定指向 DISABLED User',
      arrange: (h) => {
        h.prisma.wecomIdentity.findFirst.mockResolvedValue({ id: 'id-1', userId: 'user-1' });
        h.prisma.user.findUnique.mockResolvedValue({
          id: 'user-1',
          status: UserStatus.DISABLED,
          deletedAt: null,
        });
      },
    },
    {
      label: 'E 未绑定但 binding ticket 签发失败(attempt 状态已被抢走)',
      arrange: (h) => h.attempts.issueBindingTicket.mockResolvedValue(null),
    },
  ];

  it.each(branches)('$label —— 经过归一化出口且抛 36010', async ({ label, arrange }) => {
    const h = makeHarness();
    arrange(h);
    const code = label.startsWith('B') ? 'x'.repeat(600) : VALID_CODE;
    const nonce = label.startsWith('A2') ? null : NONCE;

    await expect(h.service.login({ code, state: VALID_STATE }, nonce, META)).rejects.toThrow(
      new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID),
    );
    expect(h.failures.reject).toHaveBeenCalledTimes(1);
  });

  it('归一化出口拿到的是**请求起点**,不是失败发生的那一刻', async () => {
    const h = makeHarness();
    h.attempts.consumeState.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return null;
    });
    const before = Date.now();
    await expect(
      h.service.login({ code: VALID_CODE, state: VALID_STATE }, NONCE, META),
    ).rejects.toThrow(new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID));

    const startedAt = h.failures.reject.mock.calls[0][0];
    // 起点必须在"慢查询"开始之前 —— 若写成失败点起算,它会晚 30ms,
    // 而那 30ms 正是各分支之间要抹平的差异本身。
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThan(before + 25);
  });

  it('非 36010 的错误码**不**进归一化出口(36030 / 36031 本就可区分,拖慢只有坏处)', async () => {
    for (const code of [BizCode.WECOM_CHANNEL_NOT_CONFIGURED, BizCode.WECOM_API_FAILED]) {
      const h = makeHarness();
      h.wecom.exchangeOAuthCode.mockRejectedValue(new BizException(code));
      await expect(
        h.service.login({ code: VALID_CODE, state: VALID_STATE }, NONCE, META),
      ).rejects.toThrow(new BizException(code));
      expect(h.failures.reject).not.toHaveBeenCalled();
    }
  });

  it('成功路径不碰归一化出口', async () => {
    const h = makeHarness();
    await expect(
      h.service.login({ code: VALID_CODE, state: VALID_STATE }, NONCE, META),
    ).resolves.toMatchObject({ bindingRequired: true, bindingTicket: 'ticket-1' });
    expect(h.failures.reject).not.toHaveBeenCalled();
  });

  it('B1:浏览器 nonce 一路透传到 consumeState(不是在 service 里被丢掉)', async () => {
    const h = makeHarness();
    await h.service.login({ code: VALID_CODE, state: VALID_STATE }, NONCE, META);
    expect(h.attempts.consumeState).toHaveBeenCalledWith({
      state: VALID_STATE,
      purpose: 'login',
      browserNonce: NONCE,
    });
  });
});

describe('WecomLoginFailureGate', () => {
  it('补齐到有界最小时长后抛 36010', async () => {
    const gate = new WecomLoginFailureGate();
    const startedAt = Date.now();
    await expect(gate.reject(startedAt)).rejects.toThrow(
      new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID),
    );
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(WECOM_LOGIN_FAILURE_FLOOR_MS);
    // 上界留足调度余量:这里断言的是"有界",不是精确时长(精确时长必然 flake)。
    expect(elapsed).toBeLessThan(
      WECOM_LOGIN_FAILURE_FLOOR_MS + WECOM_LOGIN_FAILURE_JITTER_MS + 2000,
    );
  });

  it('已经超过 floor 的分支不再额外等(不给按耗时放大的杠杆)', async () => {
    const gate = new WecomLoginFailureGate();
    const longAgo = Date.now() - (WECOM_LOGIN_FAILURE_FLOOR_MS + WECOM_LOGIN_FAILURE_JITTER_MS);
    const startedAt = Date.now();
    await expect(gate.reject(longAgo)).rejects.toThrow(
      new BizException(BizCode.WECOM_LOGIN_CREDENTIAL_INVALID),
    );
    expect(Date.now() - startedAt).toBeLessThan(WECOM_LOGIN_FAILURE_FLOOR_MS);
  });

  it('floor 必须显著高于本地分支耗时上界(实测 33ms),否则等于没归一', () => {
    expect(WECOM_LOGIN_FAILURE_FLOOR_MS).toBeGreaterThanOrEqual(100);
    expect(WECOM_LOGIN_FAILURE_JITTER_MS).toBeGreaterThan(0);
  });
});
