import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  generatePhoneVerificationToken,
  hashPhoneVerificationToken,
} from './recruitment.constants';
import { RecruitmentIdentityService } from './recruitment-identity.service';

// 招新四期 S4a 单测:聚焦 token helpers 纯函数 + 会话校验/消费的时间/并发分支
// (过期 / 已消费 / 轮次不符 / 手机不符 / 原子消费竞态)—— e2e 难以稳定构造的边界,单测补齐。

describe('phoneVerificationToken helpers', () => {
  it('generatePhoneVerificationToken 返 64 字符 hex,且每次不同', () => {
    const a = generatePhoneVerificationToken();
    const b = generatePhoneVerificationToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('hashPhoneVerificationToken 确定性 + 64 字符 hex + 不等于明文(入库存 hash)', () => {
    const raw = generatePhoneVerificationToken();
    const h1 = hashPhoneVerificationToken(raw);
    const h2 = hashPhoneVerificationToken(raw);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).not.toBe(raw);
  });
});

describe('RecruitmentIdentityService.assertPhoneSessionValid', () => {
  const NOW = new Date('2026-06-24T00:00:00.000Z');
  const FUTURE = new Date('2026-06-24T00:20:00.000Z');
  const PAST = new Date('2026-06-23T23:00:00.000Z');
  const CYCLE = 'cyc1';
  const PHONE = '13900000001';
  const TOKEN = generatePhoneVerificationToken();

  function buildService(session: unknown) {
    const prisma = {
      recruitmentIdentitySession: { findUnique: jest.fn().mockResolvedValue(session) },
    };
    const svc = new RecruitmentIdentityService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never, // F7:storage(本组不触上传)
    );
    return { svc, prisma };
  }

  async function expectBiz(p: Promise<unknown>, code: (typeof BizCode)[keyof typeof BizCode]) {
    try {
      await p;
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(BizException);
      expect((e as BizException).biz).toEqual(code);
    }
  }

  it('合法会话(未过期/未消费/轮次一致/手机一致)→ 不抛', async () => {
    const { svc } = buildService({
      phone: PHONE,
      cycleId: CYCLE,
      consumedAt: null,
      expiresAt: FUTURE,
    });
    await expect(svc.assertPhoneSessionValid(TOKEN, CYCLE, PHONE, NOW)).resolves.toBeUndefined();
  });

  it('token 不存在 → 28050', async () => {
    const { svc } = buildService(null);
    await expectBiz(
      svc.assertPhoneSessionValid(TOKEN, CYCLE, PHONE, NOW),
      BizCode.RECRUITMENT_IDENTITY_SESSION_INVALID,
    );
  });

  it('已过期 → 28050', async () => {
    const { svc } = buildService({
      phone: PHONE,
      cycleId: CYCLE,
      consumedAt: null,
      expiresAt: PAST,
    });
    await expectBiz(
      svc.assertPhoneSessionValid(TOKEN, CYCLE, PHONE, NOW),
      BizCode.RECRUITMENT_IDENTITY_SESSION_INVALID,
    );
  });

  it('已消费 → 28050', async () => {
    const { svc } = buildService({
      phone: PHONE,
      cycleId: CYCLE,
      consumedAt: PAST,
      expiresAt: FUTURE,
    });
    await expectBiz(
      svc.assertPhoneSessionValid(TOKEN, CYCLE, PHONE, NOW),
      BizCode.RECRUITMENT_IDENTITY_SESSION_INVALID,
    );
  });

  it('轮次不一致 → 28050', async () => {
    const { svc } = buildService({
      phone: PHONE,
      cycleId: 'other',
      consumedAt: null,
      expiresAt: FUTURE,
    });
    await expectBiz(
      svc.assertPhoneSessionValid(TOKEN, CYCLE, PHONE, NOW),
      BizCode.RECRUITMENT_IDENTITY_SESSION_INVALID,
    );
  });

  it('手机与提交不一致 → 40000(防「验 A 号 token 报 B 号」)', async () => {
    const { svc } = buildService({
      phone: '13900000002',
      cycleId: CYCLE,
      consumedAt: null,
      expiresAt: FUTURE,
    });
    await expectBiz(svc.assertPhoneSessionValid(TOKEN, CYCLE, PHONE, NOW), BizCode.BAD_REQUEST);
  });
});

describe('RecruitmentIdentityService.consumePhoneSession', () => {
  const NOW = new Date('2026-06-24T00:00:00.000Z');
  const FUTURE = new Date('2026-06-24T00:20:00.000Z');
  const CYCLE = 'cyc1';
  const TOKEN = generatePhoneVerificationToken();

  function buildTx(session: unknown, updateCount: number) {
    return {
      recruitmentIdentitySession: {
        findUnique: jest.fn().mockResolvedValue(session),
        updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
      },
    };
  }

  it('原子消费成功 → 返手机身份;updateMany 命中 consumedAt:null', async () => {
    const svc = new RecruitmentIdentityService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const verifiedAt = new Date('2026-06-24T00:00:00.000Z');
    const tx = buildTx(
      {
        id: 's1',
        phone: '13900000001',
        cycleId: CYCLE,
        consumedAt: null,
        expiresAt: FUTURE,
        phoneVerifiedAt: verifiedAt,
        phoneVerificationMethod: 'sms',
        openid: null,
      },
      1,
    );
    const result = await svc.consumePhoneSession(tx as never, TOKEN, CYCLE, NOW);
    expect(result).toEqual({
      phone: '13900000001',
      phoneVerifiedAt: verifiedAt,
      phoneVerificationMethod: 'sms',
      openid: null,
    });
    expect(tx.recruitmentIdentitySession.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', consumedAt: null },
      data: { consumedAt: NOW },
    });
  });

  it('并发竞态:updateMany 命中 0 行(已被另一请求抢消费)→ 28050', async () => {
    const svc = new RecruitmentIdentityService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const tx = buildTx(
      {
        id: 's1',
        phone: '13900000001',
        cycleId: CYCLE,
        consumedAt: null,
        expiresAt: FUTURE,
        phoneVerifiedAt: NOW,
        phoneVerificationMethod: 'sms',
        openid: null,
      },
      0,
    );
    await expect(svc.consumePhoneSession(tx as never, TOKEN, CYCLE, NOW)).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_IDENTITY_SESSION_INVALID,
    });
  });
});

// 证书标准库 PR-4a-2:`uploadCertificateImages · FOR UPDATE 后合并写` 整组随该方法退役
// (§13.3 一证一行取代按类别整组覆盖 —— 没有「合并写」这回事了:每条 Claim 独立一行,
//  重传只换自己那一行的图,不需要把别的类别读出来再合并回去)。
//
// 它守的三条不变量各自的新归属:
//   ① 「锁后复读最新行再判」→ 新公开三端点都在 lockApplication 之后才 resolveOwnClaim;
//   ② 「28054 已通过类别不可覆盖」→ 语义消失(APPROVED 的 Claim 由 assertApplicantMayMutate
//      拒改,回 28057;不再有「类别」这一层可被整组覆盖);
//   ③ 「落图失败删本批新 key、不动旧图」→ putClaimImages 的 catch 分支,
//      e2e 覆盖(见 test/e2e/recruitment-certificate-claims.e2e-spec.ts)。

describe('RecruitmentIdentityService.withdraw · status claim 后权威重读', () => {
  it('微信身份锁后仍一致 → audit 使用锁后行并写 withdrawn', async () => {
    const base = {
      id: 'app-withdraw-1',
      cycleId: 'cycle-1',
      statusCode: 'manual_review',
      deletedAt: null,
      openid: 'stale-openid-before-lock',
      phone: '13900000001',
      thresholdMarks: null,
      tempNo: null,
      promotedMemberId: null,
      riskLevel: null,
      certificateImages: null,
      certificateReviewStatus: null,
    };
    const locked = { ...base };
    const updated = { ...locked, statusCode: 'withdrawn' };
    const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
    // 第 3 次读来自 PR-4a-2 的门槛重算(同事务、锁内);回落到 locked 而不是 undefined,
    // 否则重算会走 `if (!app) return` 静默空转,这条用例就测不到它真的跑了。
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce(locked)
      .mockResolvedValue(locked);
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: base.id }]),
      recruitmentApplication: {
        findFirst,
        update: jest.fn().mockResolvedValue(updated),
      },
      // PR-4a-2(§8.4 末段):整份撤销级联未 PROMOTED 的 Claim → WITHDRAWN,
      // 随后重算派生门槛。本组无 Claim → updateMany 0 条、重算无改动。
      recruitmentCertificateClaim: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const prisma = {
      $transaction: jest.fn((cb: (client: unknown) => unknown) => cb(tx)),
      recruitmentCycle: {
        findFirstOrThrow: jest
          .fn()
          .mockResolvedValue({ meetingInfo: null, qqGroup: null, notifyTemplate: null }),
      },
      dictItem: { findMany: jest.fn().mockResolvedValue([]) },
      // 证书标准库 PR-4a-2:进度模型的证书段改由 Claim 行组装(loadProgressClaims)。
      // 本组守的是「锁后权威重读」,与证书无关 → 空数组。
      recruitmentCertificateClaim: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new RecruitmentIdentityService(
      prisma as never,
      {} as never,
      { code2session: jest.fn().mockResolvedValue({ openid: base.openid }) } as never,
      auditLogs as never,
      {} as never,
      {} as never,
    );

    await expect(service.withdraw({ wechatCode: 'wx-code' }, {} as never)).resolves.toMatchObject({
      stage: 'withdrawn',
    });

    // 2 次是「锁前定位 + 锁后权威重读」(本用例的原意);
    // 第 3 次是 PR-4a-2 新增的门槛重算在同一事务、同一锁内的读 —— 刻意加的,不是回归。
    expect(findFirst).toHaveBeenCalledTimes(3);
    expect(tx.recruitmentApplication.update).toHaveBeenCalledWith({
      where: { id: locked.id },
      data: { statusCode: 'withdrawn' },
    });
    expect(auditLogs.log).toHaveBeenCalledWith(
      expect.objectContaining({
        before: { statusCode: locked.statusCode },
        // PR-4a-2:extra 多一个 withdrawnClaimCount(级联撤了几条证书申报)。
        // 断言写全集而不是放宽成 objectContaining —— 这一格的意义正是「只记条数,
        // 不记 claim id / 编号 / key」,放宽就测不到「没多记别的」。
        extra: { channel: 'wechat', openid: 'stal****lock', withdrawnClaimCount: 0 },
        tx,
      }),
    );
    // 级联真的发生了(哪怕本组 0 条):少了这一句,把 updateMany 整段删掉也不会红。
    expect(tx.recruitmentCertificateClaim.updateMany).toHaveBeenCalledTimes(1);
  });

  it('微信身份在 claim 等待期间漂移 → 泛化 NOT_FOUND 且零 update/audit', async () => {
    const base = {
      id: 'app-withdraw-wechat-drift',
      statusCode: 'manual_review',
      deletedAt: null,
      openid: 'openid-before-lock',
      phone: '13900000001',
    };
    const locked = { ...base, openid: 'openid-after-lock' };
    const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: base.id }]),
      recruitmentApplication: {
        findFirst: jest.fn().mockResolvedValueOnce(base).mockResolvedValueOnce(locked),
        update: jest.fn(),
      },
    };
    const prisma = { $transaction: jest.fn((cb: (client: unknown) => unknown) => cb(tx)) };
    const service = new RecruitmentIdentityService(
      prisma as never,
      {} as never,
      { code2session: jest.fn().mockResolvedValue({ openid: base.openid }) } as never,
      auditLogs as never,
      {} as never,
      {} as never,
    );

    await expect(service.withdraw({ wechatCode: 'wx-code' }, {} as never)).rejects.toEqual(
      new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND),
    );
    expect(tx.recruitmentApplication.update).not.toHaveBeenCalled();
    expect(auditLogs.log).not.toHaveBeenCalled();
  });

  it('手机身份在 claim 等待期间漂移 → 泛化 NOT_FOUND 且零 update/audit', async () => {
    const base = {
      id: 'app-withdraw-phone-drift',
      statusCode: 'manual_review',
      deletedAt: null,
      openid: null,
      phone: '13900000001',
    };
    const locked = { ...base, phone: '13900000002' };
    const auditLogs = { log: jest.fn().mockResolvedValue(undefined) };
    const smsCode = { verifyAndConsume: jest.fn().mockResolvedValue(undefined) };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: base.id }]),
      recruitmentApplication: {
        findFirst: jest.fn().mockResolvedValueOnce(base).mockResolvedValueOnce(locked),
        update: jest.fn(),
      },
    };
    const prisma = { $transaction: jest.fn((cb: (client: unknown) => unknown) => cb(tx)) };
    const service = new RecruitmentIdentityService(
      prisma as never,
      smsCode as never,
      {} as never,
      auditLogs as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.withdraw({ phone: base.phone, code: '888888' }, {} as never),
    ).rejects.toEqual(new BizException(BizCode.RECRUITMENT_APPLICATION_NOT_FOUND));
    expect(smsCode.verifyAndConsume).toHaveBeenCalledTimes(1);
    expect(tx.recruitmentApplication.update).not.toHaveBeenCalled();
    expect(auditLogs.log).not.toHaveBeenCalled();
  });
});
