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

describe('RecruitmentIdentityService.uploadCertificateImages · FOR UPDATE 后合并写', () => {
  const dto = {
    category: 'first_aid',
    issuingOrg: '深圳市红十字会',
    issuedAt: '2026-07-01',
    wechatCode: 'wx-code',
  };
  const file = {
    buffer: Buffer.from('new-image'),
    mimetype: 'image/png',
    size: 9,
  } as never;

  function buildUploadService(lockedOverrides: Record<string, unknown> = {}) {
    const initial = {
      id: 'app-1',
      cycleId: 'cycle-1',
      statusCode: 'verified',
      deletedAt: null,
      certificateImages: { first_aid: ['stale-old.png'] },
      certificateReviewStatus: null,
      certificateIssuanceInfo: null,
    };
    const locked = {
      ...initial,
      certificateImages: {
        first_aid: ['locked-old.png'],
        bsafe: ['concurrent-bsafe.png'],
      },
      certificateIssuanceInfo: {
        bsafe: { issuingOrg: '并发写入机构', issuedAt: '2026-06-01' },
      },
      ...lockedOverrides,
    };
    let updatedData: Record<string, Record<string, unknown>> | null = null;
    const update = jest
      .fn()
      .mockImplementation(({ data }: { data: Record<string, Record<string, unknown>> }) => {
        updatedData = data;
        return Promise.resolve({});
      });
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: initial.id }]),
      recruitmentApplication: {
        findFirst: jest.fn().mockResolvedValue(locked),
        update,
      },
    };
    const prisma = {
      recruitmentApplication: { findFirst: jest.fn().mockResolvedValue(initial) },
      $transaction: jest.fn((cb: (arg: unknown) => unknown) => cb(tx)),
    };
    const storage = {
      putObject: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
    };
    const service = new RecruitmentIdentityService(
      prisma as never,
      {} as never,
      { code2session: jest.fn().mockResolvedValue({ openid: 'openid-1' }) } as never,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      storage as never,
    );
    return { service, update, storage, getUpdatedData: () => updatedData };
  }

  it('A4:合并写以锁后最新行值为基,保留并发新增类别并删除锁后旧图', async () => {
    const { service, storage, getUpdatedData } = buildUploadService();
    await expect(service.uploadCertificateImages(dto, [file], {} as never)).resolves.toMatchObject({
      category: 'first_aid',
      imageCount: 1,
    });
    const data = getUpdatedData();
    expect(data).not.toBeNull();
    if (data === null) throw new Error('expected update data');
    expect(data.certificateImages.bsafe).toEqual(['concurrent-bsafe.png']);
    expect(data.certificateIssuanceInfo.bsafe).toEqual({
      issuingOrg: '并发写入机构',
      issuedAt: '2026-06-01',
    });
    expect(data.certificateIssuanceInfo.first_aid).toEqual({
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-07-01',
    });
    expect(storage.deleteObject).toHaveBeenCalledWith('locked-old.png');
    expect(storage.deleteObject).not.toHaveBeenCalledWith('stale-old.png');
  });

  it('A2/A4:落图窗口内变为 approved → 28054 且补偿删除本批新 blob', async () => {
    const { service, update, storage } = buildUploadService({
      certificateReviewStatus: {
        first_aid: { status: 'approved', at: '2026-07-13T00:00:00.000Z', by: 'admin-1' },
      },
    });
    await expect(service.uploadCertificateImages(dto, [file], {} as never)).rejects.toMatchObject({
      biz: BizCode.RECRUITMENT_CERTIFICATE_ALREADY_APPROVED,
    });
    expect(update).not.toHaveBeenCalled();
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });
});
