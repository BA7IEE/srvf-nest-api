import { Prisma, Role, UserStatus } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { PrismaService } from '../../database/prisma.service';
import type { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import type { SmsCodeService } from '../sms/sms-code.service';
import type { WechatService } from '../wechat/wechat.service';
import type { AuthService } from './auth.service';
import { LoginWechatService } from './login-wechat.service';

// 微信小程序登录 review 收口(2026-06-12 增量审计⑬):bind ⑥ 绑定事务的 P2002 兜底
// catch(含 §5 数组判断铁律)此前零触达——并发竞绑 e2e 有 CI 抖动风险刻意舍弃,
// 兜底分支由本 unit 锁定;七步顺序 / 防枚举 / audit 掩码由 auth-wechat e2e 锁定。
// 纯构造器注入 mock,不起 Nest、不连库(沿 users.service.spec 范式)。

const META: AuditMeta = { requestId: 'req-lw-1', ip: '127.0.0.1', ua: 'jest' };

type ActiveRow = {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  deletedAt: Date | null;
};

function makeP2002(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target },
  });
}

function makeMocks() {
  const user = {
    findFirst: jest.fn<Promise<ActiveRow | null>, [unknown]>(), // ② resolveActiveUserByPhone
    findUnique: jest.fn<Promise<{ id: string } | null>, [unknown]>(), // ④ openid 占用
    findUniqueOrThrow: jest.fn<Promise<{ openid: string | null }>, [unknown]>(), // ⑥ me.openid
    update: jest.fn<Promise<{ id: string }>, [unknown]>(), // ⑥ tx.user.update
  };
  const $transaction = jest.fn<Promise<unknown>, [unknown]>();
  const prisma = { user, $transaction };
  // 回调式把 prisma mock 自身当 tx 传入(沿 users.service.spec 双模范式)
  $transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof prisma) => Promise<unknown>)(prisma)
      : Promise.all(arg as Array<Promise<unknown>>),
  );
  const wechat = { code2session: jest.fn<Promise<{ openid: string }>, [string]>() };
  const smsCode = {
    assertValid: jest.fn<Promise<void>, [unknown]>(),
    verifyAndConsume: jest.fn<Promise<{ codeId: string }>, [unknown]>(),
    issue: jest.fn<Promise<{ expiresInSeconds: number }>, [unknown]>(),
  };
  const auth = { createSession: jest.fn<Promise<unknown>, [unknown, unknown, unknown, unknown]>() };
  const auditLogs = { log: jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined) };
  return { prisma, wechat, smsCode, auth, auditLogs };
}

type Mocks = ReturnType<typeof makeMocks>;

function makeService(m: Mocks): LoginWechatService {
  return new LoginWechatService(
    m.prisma as unknown as PrismaService,
    m.wechat as unknown as WechatService,
    m.smsCode as unknown as SmsCodeService,
    m.auth as unknown as AuthService,
    m.auditLogs as unknown as AuditLogsService,
  );
}

// 七步走到 ⑥ 事务前的最小桩:①-⑤ 全通过,⑥ 首绑(me.openid=null)
function primeHappyBindUntilTx(m: Mocks): void {
  m.wechat.code2session.mockResolvedValue({ openid: 'o-target-1234567890' });
  m.prisma.user.findFirst.mockResolvedValue({
    id: 'u-1',
    username: 'alice',
    role: Role.USER,
    status: UserStatus.ACTIVE,
    deletedAt: null,
  });
  m.smsCode.assertValid.mockResolvedValue(undefined);
  m.prisma.user.findUnique.mockResolvedValue(null); // ④ 占用预检未命中(竞态窗口)
  m.smsCode.verifyAndConsume.mockResolvedValue({ codeId: 'code-1' });
  m.prisma.user.findUniqueOrThrow.mockResolvedValue({ openid: null });
}

describe('LoginWechatService.bind — ⑥ P2002 兜底(增量审计⑬)', () => {
  const dto = { code: 'wx-c', phone: '13900000001', smsCode: '888888' };

  it('事务撞 User_openid_key(target 含 openid)→ 25002,且 ⑦ 不签发', async () => {
    const m = makeMocks();
    primeHappyBindUntilTx(m);
    m.prisma.user.update.mockRejectedValue(makeP2002(['openid']));
    const service = makeService(m);

    await expect(service.bind(dto, META)).rejects.toEqual(
      new BizException(BizCode.WECHAT_ALREADY_BOUND),
    );
    expect(m.auth.createSession).not.toHaveBeenCalled();
  });

  it('P2002 但 target 不含 openid → 原样上抛(§5 数组判断铁律,不误吞他键冲突)', async () => {
    const m = makeMocks();
    primeHappyBindUntilTx(m);
    const phoneConflict = makeP2002(['phone']);
    m.prisma.user.update.mockRejectedValue(phoneConflict);
    const service = makeService(m);

    await expect(service.bind(dto, META)).rejects.toBe(phoneConflict);
    expect(m.auth.createSession).not.toHaveBeenCalled();
  });
});
