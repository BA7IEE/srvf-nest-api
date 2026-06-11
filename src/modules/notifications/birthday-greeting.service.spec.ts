import { BirthdayGreetingService } from './birthday-greeting.service';
import { SmsProviderSendError } from '../sms/sms.types';
import type { PrismaService } from '../../database/prisma.service';
import type { SmsProviderRouter } from '../sms/sms-provider.router';
import type { SmsSettingsService } from '../sms/sms-settings.service';

// 生日祝福 job unit(queue-b 评审稿 §7;mock prisma + router + settings):
// 锁定选取六条件逐一反例 / 2-29 闰年判定 / UTC+8 日界换算 / 单条失败继续 /
// 前置检查跳过 / 幂等跳过 / 日志掩码——e2e(notifications-birthday)覆盖真实 DB 链路。

type CandidateRow = {
  birthDate: Date;
  member: {
    user: { phone: string | null; status: 'ACTIVE' | 'DISABLED'; deletedAt: Date | null } | null;
  };
};

function activeUser(phone: string | null): CandidateRow['member']['user'] {
  return { phone, status: 'ACTIVE', deletedAt: null };
}

// 固定测试时刻:2026-06-11 12:00 UTC+8(= 04:00 UTC)
const NOW = new Date('2026-06-11T04:00:00.000Z');

function bd(month: number, day: number, year = 1990): Date {
  // 出生日按 UTC+8 正午落点构造,月日在 UTC+8 视角下稳定
  return new Date(Date.UTC(year, month - 1, day, 4, 0, 0));
}

describe('BirthdayGreetingService.runOnce(直调;mock 依赖)', () => {
  let candidates: CandidateRow[];
  let sendLogRows: Array<Record<string, unknown>>;
  let alreadySentCount: number;
  let sendImpl: (input: { phone: string }) => Promise<{ providerMsgId: string | null }>;
  let settingsResolved: { enabled: boolean; templateIdBirthday: string | null } | null;

  // 裸 jest.fn 引用供断言(避免穿过类型 cast 触发 unbound-method;沿 tencent-sms.provider.spec 范式)
  const findManyMock = jest.fn(() => Promise.resolve(candidates));
  const sendLogCountMock = jest.fn(() => Promise.resolve(alreadySentCount));
  const sendLogCreateMock = jest.fn((args: { data: Record<string, unknown> }) => {
    sendLogRows.push(args.data);
    return Promise.resolve(args.data);
  });
  const resolveProviderTypeMock = jest.fn(() => Promise.resolve('DEV_STUB' as const));
  const sendBirthdayGreetingMock = jest.fn((input: { phone: string }) => sendImpl(input));
  const getActiveSettingsMock = jest.fn(() => Promise.resolve(settingsResolved));

  const prisma = {
    memberProfile: { findMany: findManyMock },
    smsSendLog: { count: sendLogCountMock, create: sendLogCreateMock },
  } as unknown as PrismaService;

  const router = {
    resolveProviderType: resolveProviderTypeMock,
    sendBirthdayGreeting: sendBirthdayGreetingMock,
  } as unknown as SmsProviderRouter;

  const settings = {
    getActiveSettings: getActiveSettingsMock,
  } as unknown as SmsSettingsService;

  let service: BirthdayGreetingService;

  beforeEach(() => {
    candidates = [];
    sendLogRows = [];
    alreadySentCount = 0;
    sendImpl = () => Promise.resolve({ providerMsgId: null });
    settingsResolved = { enabled: true, templateIdBirthday: 'tpl-birthday' };
    service = new BirthdayGreetingService(prisma, router, settings);
    jest.clearAllMocks();
  });

  it('前置检查:settings 缺失 / 未启用 / templateIdBirthday 空 → 整批跳过零行', async () => {
    const scenarios: Array<typeof settingsResolved> = [
      null,
      { enabled: false, templateIdBirthday: 'tpl' },
      { enabled: true, templateIdBirthday: null },
    ];
    for (const s of scenarios) {
      settingsResolved = s;
      const summary = await service.runOnce(NOW);
      expect(summary).toEqual({ selected: 0, sent: 0, skippedIdempotent: 0, failed: 0 });
    }
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('选取:月日命中 + 全链 ACTIVE + 绑 phone → 发送;六条件反例逐一不选', async () => {
    candidates = [
      { birthDate: bd(6, 11), member: { user: activeUser('13900000001') } }, // 命中
      { birthDate: bd(6, 12), member: { user: activeUser('13900000002') } }, // 月日不符
      { birthDate: bd(6, 11), member: { user: activeUser(null) } }, // 无 phone
      { birthDate: bd(6, 11), member: { user: null } }, // 未绑 user
      {
        birthDate: bd(6, 11),
        member: { user: { phone: '13900000005', status: 'DISABLED', deletedAt: null } },
      }, // user DISABLED
      {
        birthDate: bd(6, 11),
        member: { user: { phone: '13900000006', status: 'ACTIVE', deletedAt: new Date() } },
      }, // user 软删
    ];
    const summary = await service.runOnce(NOW);
    expect(summary).toEqual({ selected: 1, sent: 1, skippedIdempotent: 0, failed: 0 });
    expect(sendBirthdayGreetingMock).toHaveBeenCalledTimes(1);
    expect(sendBirthdayGreetingMock).toHaveBeenCalledWith({ phone: '13900000001' });
    expect(sendLogRows[0]).toMatchObject({
      phone: '13900000001',
      templateKey: 'birthday-greeting',
      status: 'SENT',
    });
    // member INACTIVE / profile 软删由 findMany where 排除(断言 where 形状)
    const findArgs = (findManyMock.mock.calls as unknown[][])[0]?.[0] as
      | { where?: { deletedAt: Date | null; member: { status: string; deletedAt: Date | null } } }
      | undefined;
    expect(findArgs?.where?.deletedAt).toBeNull();
    expect(findArgs?.where?.member).toEqual({ status: 'ACTIVE', deletedAt: null });
  });

  it('2/29 生日仅闰年当天发:非闰年 2/28 与 3/1 均不选(不顺延)', async () => {
    candidates = [{ birthDate: bd(2, 29, 2000), member: { user: activeUser('13900000007') } }];
    // 2026 非闰年:2/28 与 3/1 都不发
    const on228 = await service.runOnce(new Date('2026-02-28T04:00:00.000Z'));
    expect(on228.selected).toBe(0);
    const on301 = await service.runOnce(new Date('2026-03-01T04:00:00.000Z'));
    expect(on301.selected).toBe(0);
    // 2028 闰年 2/29 当天发
    const on229 = await service.runOnce(new Date('2028-02-29T04:00:00.000Z'));
    expect(on229).toEqual({ selected: 1, sent: 1, skippedIdempotent: 0, failed: 0 });
  });

  it('UTC+8 日界:UTC 晚 23 点(=UTC+8 次日早 7 点)按次日月日匹配', async () => {
    candidates = [{ birthDate: bd(6, 12), member: { user: activeUser('13900000008') } }];
    // 2026-06-11T23:00Z = UTC+8 2026-06-12 07:00 → 6/12 生日命中
    const summary = await service.runOnce(new Date('2026-06-11T23:00:00.000Z'));
    expect(summary.selected).toBe(1);
    expect(summary.sent).toBe(1);
  });

  it('幂等:当日已有 SENT 行 → skippedIdempotent,不再发送', async () => {
    candidates = [{ birthDate: bd(6, 11), member: { user: activeUser('13900000009') } }];
    alreadySentCount = 1;
    const summary = await service.runOnce(NOW);
    expect(summary).toEqual({ selected: 1, sent: 0, skippedIdempotent: 1, failed: 0 });
    expect(sendBirthdayGreetingMock).not.toHaveBeenCalled();
  });

  it('单条失败:写 FAILED 行后继续下一人,不重试不阻断;日志掩码不输出完整号码', async () => {
    candidates = [
      { birthDate: bd(6, 11), member: { user: activeUser('13911110001') } },
      { birthDate: bd(6, 11), member: { user: activeUser('13911110002') } },
    ];
    sendImpl = (input) =>
      input.phone === '13911110001'
        ? Promise.reject(new SmsProviderSendError('LimitExceeded', 'provider limit'))
        : Promise.resolve({ providerMsgId: 'sn-2' });

    const warnSpy = jest.spyOn(
      (service as unknown as { logger: { warn: (msg: string) => void } }).logger,
      'warn',
    );
    const summary = await service.runOnce(NOW);
    expect(summary).toEqual({ selected: 2, sent: 1, skippedIdempotent: 0, failed: 1 });
    expect(sendLogRows).toHaveLength(2);
    expect(sendLogRows[0]).toMatchObject({
      phone: '13911110001',
      status: 'FAILED',
      errCode: 'LimitExceeded',
    });
    expect(sendLogRows[1]).toMatchObject({ phone: '13911110002', status: 'SENT' });
    const warned = warnSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(warned).toContain('139****0001');
    expect(warned).not.toContain('13911110001');
  });

  it('通道整体不可用:resolveProviderType 抛 → 剩余整批跳过,零 FAILED 行', async () => {
    candidates = [
      { birthDate: bd(6, 11), member: { user: activeUser('13911110003') } },
      { birthDate: bd(6, 11), member: { user: activeUser('13911110004') } },
    ];
    resolveProviderTypeMock.mockRejectedValue(new Error('SMS_CHANNEL_UNAVAILABLE: 运维已关闭'));
    const summary = await service.runOnce(NOW);
    expect(summary).toEqual({ selected: 2, sent: 0, skippedIdempotent: 0, failed: 0 });
    expect(sendLogRows).toHaveLength(0);
  });
});
