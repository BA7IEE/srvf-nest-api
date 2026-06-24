import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RecruitmentApplicationsService } from './recruitment-applications.service';
import type { RecruitmentSubmitPayloadDto } from './recruitment.dto';
import type { UploadedImageFile } from './recruitment-applications.service';

// 系统性审查 R1 · FM-B 回归(单测;OCR 改造后单事务结构):
// 证件照 putObject 成功、但建终态事务($transaction)失败时,必须 best-effort 补偿删除刚落的孤儿 blob
// ——否则留存 SOP 按库行 idCardImageKey 删 blob 清不到无库行的孤儿,证件照永久滞留。
// OCR 改造(2026-06-22):付费 OCR(recognize)已挪到唯一事务之前——故 mainland 报名在事务失败前
// **已调用一次 recognize**(下方断言锁定该新顺序);孤儿补偿仍由 safeDeleteOrphanImage 兜底。
// e2e 难确定性触发(去重 precheck 在 putObject 前已挡掉多数重复;P2002 路径需真并发竞态),
// 故以单测精确锁定:mock storage + 令 $transaction 抛错 → 断言 deleteObject 被调。

describe('RecruitmentApplicationsService · FM-B 孤儿 blob 补偿删', () => {
  const VALID_MAINLAND_ID = '110101199003070038'; // GB11643 有效校验位 + 36 岁(2026 基准)

  function buildPayload(): RecruitmentSubmitPayloadDto {
    return {
      wechatCode: 'code-x',
      realName: '张三',
      idCardNumber: VALID_MAINLAND_ID,
      documentTypeCode: 'mainland_id',
      phone: '13900000001',
      detailedAddress: '北京市朝阳区某街道 1 号',
      cityDistrict: '北京市朝阳区',
      sourceChannel: 'wechat_moments',
      emergencyContacts: [
        { name: '李四', relation: '父亲', phone: '13900000002' },
        { name: '王五', relation: '母亲', phone: '13900000003' },
      ],
    };
  }

  const image: UploadedImageFile = {
    buffer: Buffer.from('fake-id-card-bytes'),
    mimetype: 'image/jpeg',
    size: 100,
  };
  const meta: AuditMeta = { requestId: 'r1', ip: null, ua: null };
  const now = new Date('2026-06-18T00:00:00.000Z');

  function buildService(txError: unknown) {
    const storage = {
      putObject: jest.fn().mockResolvedValue({ key: 'k', etag: null }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      generateUploadUrl: jest.fn(),
      generateDownloadUrl: jest.fn(),
      headObject: jest.fn(),
    };
    const prisma = {
      // resolveOpenCycleOrThrow:存在 open 轮、不限容量(跳过 count)
      recruitmentCycle: {
        findFirst: jest.fn().mockResolvedValue({ id: 'cyc1', capacity: null, year: 2026 }),
      },
      // 同轮去重 precheck:无重复
      recruitmentApplication: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      // F3:relation 字典校验(assertEmergencyRelationCodeValid)→ 命中 ACTIVE 项(校验通过)
      dictItem: {
        findFirst: jest.fn().mockResolvedValue({ id: 'rel1' }),
      },
      // tx1:建库事务失败(putObject 已成功 → blob 成孤儿)
      $transaction: jest.fn().mockRejectedValue(txError),
    };
    const wechat = { code2session: jest.fn().mockResolvedValue({ openid: 'op1' }) };
    // OCR 改造:mainland 报名提交端重识别(分叉②);桩返「清晰+匹配」,createStatus=verified(但事务被 mock 拒)
    const realname = {
      recognize: jest.fn().mockResolvedValue({
        recognized: true,
        name: '张三',
        idCardNumber: VALID_MAINLAND_ID,
        warnings: [],
      }),
    };
    const rbac = { can: jest.fn() };
    const auditLogs = { log: jest.fn() };

    // S4a:identity service(本组测试走 wechatCode 路径,hasToken=false,故 assert/consume 不被调用)
    const identity = { assertPhoneSessionValid: jest.fn(), consumePhoneSession: jest.fn() };
    const service = new RecruitmentApplicationsService(
      prisma as never,
      rbac as never,
      auditLogs as never,
      wechat as never,
      realname as never,
      identity as never,
      storage,
    );
    return { service, storage, prisma, realname };
  }

  it('单事务普通错误失败 → 补偿删孤儿 blob + 原错上抛;OCR 已在事务前调一次', async () => {
    const { service, storage, realname } = buildService(new Error('tx boom'));

    await expect(service.submit(buildPayload(), image, meta, now)).rejects.toThrow('tx boom');

    expect(storage.putObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledWith(
      expect.stringContaining('recruitment/id-card/cyc1/'),
    );
    // OCR 改造:付费 OCR 在唯一事务之前 → mainland 报名已调一次 recognize(锁新顺序)
    expect(realname.recognize).toHaveBeenCalledTimes(1);
  });

  it('单事务撞 partial unique(P2002)→ 补偿删孤儿 blob + 转 28003', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const { service, storage } = buildService(p2002);

    await expect(service.submit(buildPayload(), image, meta, now)).rejects.toMatchObject({
      biz: { code: BizCode.RECRUITMENT_DUPLICATE_APPLICATION.code },
    });
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledWith(
      expect.stringContaining('recruitment/id-card/cyc1/'),
    );
  });

  it('补偿删失败仅吞掉告警,不掩盖原错(原错仍上抛)', async () => {
    const { service, storage } = buildService(new Error('tx1 boom'));
    storage.deleteObject.mockRejectedValueOnce(new Error('storage down'));

    // deleteObject 抛错被 safeDeleteOrphanImage 吞掉 → 仍以原 tx1 错误结束
    await expect(service.submit(buildPayload(), image, meta, now)).rejects.toThrow('tx1 boom');
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });

  it('BizException 形态正确(P2002 → 28003 的 httpStatus 一致)', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const { service } = buildService(p2002);
    await service.submit(buildPayload(), image, meta, now).catch((e) => {
      expect(e).toBeInstanceOf(BizException);
      expect((e as BizException).biz).toEqual(BizCode.RECRUITMENT_DUPLICATE_APPLICATION);
    });
  });
});

// 招新闭环优化 S3(评审稿 recruitment-phase4-loop-optimization-review.md §11.1 / Q-P4-10):
// RBAC 敏感字段分级判权矩阵(单测;mock rbac.can 按码返值,隔离 masking 随码逻辑)。
// - 详情:入口闸 read.record;持 read.sensitive → 明文证件号/手机,仅 read.record → 脱敏(响应字段集不变,只 masking 随码)。
// - 证件照 signed-URL:闸从 read.record 收紧为 read.sensitive。
// - 无码 → RBAC_FORBIDDEN(30100)。
describe('RecruitmentApplicationsService · S3 敏感字段分级判权', () => {
  const RAW_ID = '110101199003070038';
  const RAW_PHONE = '13900000001';
  const RECORD = 'recruitment-application.read.record';
  const SENSITIVE = 'recruitment-application.read.sensitive';

  // toAdminDto / isPromotable / allThresholdsComplete 读到的字段全集(verified 在途态)
  const ROW = {
    id: 'app-1',
    cycleId: 'cyc-1',
    statusCode: 'verified',
    tempNo: 'T20260001',
    realName: '张三',
    idCardNumber: RAW_ID,
    phone: RAW_PHONE,
    documentTypeCode: 'mainland_id',
    isForeigner: false,
    birthDate: new Date('1990-03-07T00:00:00.000Z'),
    genderCode: 'male',
    ageGroup: null,
    cityDistrict: '北京市朝阳区',
    verifyOutcome: null,
    eliminationStage: null,
    idCardImageKey: 'recruitment/id-card/cyc-1/app-1.jpg',
    thresholdMarks: null,
    evaluationNote: null,
    promotedMemberId: null,
    openid: 'op-1',
    createdAt: new Date('2026-06-18T00:00:00.000Z'),
  };

  const ADMIN_USER = {
    id: 'admin-1',
    username: 'admin',
    role: 'ADMIN',
    memberId: null,
  } as never;

  function buildReadService(canMap: Record<string, boolean>) {
    const prisma = {
      recruitmentApplication: { findFirst: jest.fn().mockResolvedValue(ROW) },
    };
    const rbac = {
      can: jest.fn((_user: unknown, code: string) => Promise.resolve(canMap[code] ?? false)),
    };
    const storage = {
      putObject: jest.fn(),
      deleteObject: jest.fn(),
      generateUploadUrl: jest.fn(),
      generateDownloadUrl: jest
        .fn()
        .mockResolvedValue({ url: 'https://signed-url', expiresAt: new Date() }),
      headObject: jest.fn(),
    };
    const service = new RecruitmentApplicationsService(
      prisma as never,
      rbac as never,
      { log: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never, // S4a:identity service(本组判权测试不触提交链)
      storage,
    );
    return { service, rbac, storage };
  }

  // ── 详情:read.record + read.sensitive → 明文 ──
  it('详情 · 持 read.record + read.sensitive → 明文证件号/手机', async () => {
    const { service } = buildReadService({ [RECORD]: true, [SENSITIVE]: true });
    const dto = await service.detailForAdmin('app-1', ADMIN_USER);
    expect(dto.idCardNumber).toBe(RAW_ID);
    expect(dto.phone).toBe(RAW_PHONE);
  });

  // ── 详情:仅 read.record(无 read.sensitive)→ 脱敏(字段集不变,值掩码)──
  it('详情 · 仅 read.record(无 sensitive)→ 脱敏证件号/手机,字段集不变', async () => {
    const { service } = buildReadService({ [RECORD]: true, [SENSITIVE]: false });
    const dto = await service.detailForAdmin('app-1', ADMIN_USER);
    expect(dto.idCardNumber).not.toBe(RAW_ID);
    expect(dto.idCardNumber).toContain('*');
    expect(dto.phone).not.toBe(RAW_PHONE);
    expect(dto.phone).toContain('*');
    // 字段集不变:脱敏 DTO 仍含明文态的同名键(realName / tempNo / hasIdCardImage 等)
    expect(dto.realName).toBe('张三');
    expect(dto.tempNo).toBe('T20260001');
    expect(dto.hasIdCardImage).toBe(true);
  });

  // ── 详情:无 read.record → 30100(闸优先,sensitive 不影响)──
  it('详情 · 无 read.record → RBAC_FORBIDDEN(30100)', async () => {
    const { service } = buildReadService({ [RECORD]: false, [SENSITIVE]: true });
    await expect(service.detailForAdmin('app-1', ADMIN_USER)).rejects.toMatchObject({
      biz: { code: BizCode.RBAC_FORBIDDEN.code },
    });
  });

  // ── 证件照 signed-URL:持 read.sensitive → 200 url ──
  it('证件照 signed-URL · 持 read.sensitive → 返 url + expiresAt', async () => {
    const { service, storage } = buildReadService({ [RECORD]: true, [SENSITIVE]: true });
    const res = await service.getIdCardImageUrl('app-1', ADMIN_USER);
    expect(res.url).toBe('https://signed-url');
    expect(res.expiresAt).toBeDefined();
    expect(storage.generateDownloadUrl).toHaveBeenCalledTimes(1);
  });

  // ── 证件照 signed-URL:仅 read.record(无 sensitive)→ 30100(闸已从 read.record 收紧为 read.sensitive)──
  it('证件照 signed-URL · 仅 read.record(无 sensitive)→ RBAC_FORBIDDEN(30100)', async () => {
    const { service, storage } = buildReadService({ [RECORD]: true, [SENSITIVE]: false });
    await expect(service.getIdCardImageUrl('app-1', ADMIN_USER)).rejects.toMatchObject({
      biz: { code: BizCode.RBAC_FORBIDDEN.code },
    });
    expect(storage.generateDownloadUrl).not.toHaveBeenCalled();
  });
});

// ===== 招新闭环优化 S6(评审稿 §8.1):批量导出 CSV 脱敏分级 =====
// goal DoD#5「导出 read.record 脱敏 vs read.sensitive 明文」+「脱敏复用 S3 toAdminDto 口径(零第二套)」。
describe('RecruitmentApplicationsService.exportApplicationsCsv · S3 脱敏分级 + 筛选', () => {
  const RAW_ID = '110101199003070038';
  const RAW_PHONE = '13900000001';
  const RECORD = 'recruitment-application.read.record';
  const SENSITIVE = 'recruitment-application.read.sensitive';
  const ADMIN_USER = { id: 'admin-1', username: 'admin', role: 'ADMIN', memberId: null } as never;

  function row(over: Record<string, unknown> = {}) {
    return {
      id: 'app-1',
      cycleId: 'cyc-1',
      statusCode: 'verified',
      tempNo: 'T20260001',
      realName: '张三',
      idCardNumber: RAW_ID,
      phone: RAW_PHONE,
      documentTypeCode: 'mainland_id',
      isForeigner: false,
      birthDate: new Date('1990-03-07T00:00:00.000Z'),
      genderCode: 'male',
      ageGroup: null,
      cityDistrict: '北京市朝阳区',
      verifyOutcome: null,
      riskLevel: null,
      manualReviewReason: null,
      eliminationStage: null,
      idCardImageKey: null,
      thresholdMarks: null,
      evaluationNote: null,
      promotedMemberId: null,
      openid: 'op-1',
      createdAt: new Date('2026-06-18T00:00:00.000Z'),
      ...over,
    };
  }

  function buildExportService(canMap: Record<string, boolean>, rows: Record<string, unknown>[]) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const prisma = { recruitmentApplication: { findMany } };
    const rbac = {
      can: jest.fn((_u: unknown, code: string) => Promise.resolve(canMap[code] ?? false)),
    };
    const service = new RecruitmentApplicationsService(
      prisma as never,
      rbac as never,
      { log: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, findMany };
  }

  it('持 read.sensitive → CSV 明文列(id_card_number/phone 原值)', async () => {
    const { service } = buildExportService({ [RECORD]: true, [SENSITIVE]: true }, [row()]);
    const csv = await service.exportApplicationsCsv({}, ADMIN_USER);
    const [header, line1] = csv.split('\n');
    expect(header.split(',')).toContain('id_card_number');
    expect(line1).toContain(RAW_ID); // 明文
    expect(line1).toContain(RAW_PHONE);
  });

  it('仅 read.record(无 sensitive)→ CSV 脱敏列(掩码,绝不出明文)', async () => {
    const { service } = buildExportService({ [RECORD]: true, [SENSITIVE]: false }, [row()]);
    const csv = await service.exportApplicationsCsv({}, ADMIN_USER);
    expect(csv).not.toContain(RAW_ID); // 明文绝不泄露
    expect(csv).not.toContain(RAW_PHONE);
    expect(csv).toContain('*'); // 掩码(复用 toAdminDto)
    expect(csv).toContain('张三'); // 非敏感列照常(realName 在 record 级)
  });

  it('无 read.record → RBAC_FORBIDDEN(不触库)', async () => {
    const { service, findMany } = buildExportService({ [RECORD]: false }, [row()]);
    await expect(service.exportApplicationsCsv({}, ADMIN_USER)).rejects.toMatchObject({
      biz: { code: BizCode.RBAC_FORBIDDEN.code },
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  // 取某次 findMany 调用的 where(显式收紧类型,避免 mock.calls 的 any 漂入断言)。
  const whereOfCall = (findMany: jest.Mock, callIndex = 0): Record<string, unknown> => {
    const calls = findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>;
    return calls[callIndex][0].where;
  };

  it('filter=manual → where.statusCode=manual_review;filter 缺省 all → 无 statusCode 约束', async () => {
    const { service, findMany } = buildExportService({ [RECORD]: true }, []);
    await service.exportApplicationsCsv({ filter: 'manual', cycleId: 'cyc-9' }, ADMIN_USER);
    expect(whereOfCall(findMany)).toMatchObject({
      deletedAt: null,
      cycleId: 'cyc-9',
      statusCode: 'manual_review',
    });

    findMany.mockClear();
    await service.exportApplicationsCsv({}, ADMIN_USER);
    expect(whereOfCall(findMany).statusCode).toBeUndefined(); // all:无态约束
  });

  it('filter=threshold-incomplete → 取 verified 后内存过滤掉门槛已齐行', async () => {
    const complete = {
      patrol1: { at: 'x', by: 'u' },
      patrol2: { at: 'x', by: 'u' },
      training: { at: 'x', by: 'u' },
      redCross: { at: 'x', by: 'u' },
      bsafe: { at: 'x', by: 'u' },
    };
    const { service, findMany } = buildExportService({ [RECORD]: true }, [
      row({ id: 'incomplete', thresholdMarks: { patrol1: { at: 'x', by: 'u' } } }),
      row({ id: 'done', thresholdMarks: complete }),
    ]);
    const csv = await service.exportApplicationsCsv({ filter: 'threshold-incomplete' }, ADMIN_USER);
    // DB where 仍按 verified 取(post-filter 在内存)
    expect(whereOfCall(findMany)).toMatchObject({ statusCode: 'verified' });
    expect(csv).toContain('incomplete');
    expect(csv).not.toContain('done'); // 门槛已齐被滤除
  });
});

// ===== 招新闭环优化 S6(评审稿 §8.1):批量标门槛编排(复用单行 markThreshold + 逐行容错)=====
// goal DoD#5「批量标门槛 matched/unmatched/逐行容错」。matching 纯函数另见 recruitment-batch-matching.spec.ts;
// 本组锁编排:① 复用单行 markThreshold(spy 验调用);② 逐行容错(某行抛 BizException 记 failed 不整批断);
// ③ 匹配不上记 unmatched;④ 自动推进计数;⑤ 批次汇总。
describe('RecruitmentApplicationsService.batchMarkThreshold · 编排(复用单行 markThreshold + 逐行容错)', () => {
  const meta: AuditMeta = { requestId: 'r1', ip: null, ua: null };
  const now = new Date('2026-06-24T00:00:00.000Z');
  const user = { id: 'admin1', role: 'SUPER_ADMIN' } as never;

  function buildBatchService(candidates: Record<string, unknown>[]) {
    const prisma = {
      recruitmentApplication: { findMany: jest.fn().mockResolvedValue(candidates) },
    };
    const rbac = { can: jest.fn().mockResolvedValue(true) };
    const service = new RecruitmentApplicationsService(
      prisma as never,
      rbac as never,
      { log: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service };
  }

  const dto = (over: Record<string, unknown> = {}) => ({
    thresholdCode: 'patrol1',
    completed: true,
    matches: [{ tempNo: 'T20260001' }, { tempNo: 'T20260002' }, { tempNo: 'T99999999' }],
    ...over,
  });

  it('matched 行逐行复用单行 markThreshold;unmatched 行不调;失败行记 failed 不整批断;汇总正确', async () => {
    const { service } = buildBatchService([
      { id: 'a1', tempNo: 'T20260001', phone: null, realName: null },
      { id: 'a2', tempNo: 'T20260002', phone: null, realName: null },
      // T99999999 无候选 → unmatched(no-match)
    ]);

    // spy 单行 markThreshold:a1 成功(末次完成→pending_evaluation 自动推进)、a2 抛 28041 状态非法
    // (返回/拒绝 Promise,不用 async 关键字以免 require-await;逐行容错路径靠 a2 的 reject 触发)
    const spy = jest.spyOn(service, 'markThreshold').mockImplementation((id: string) => {
      if (id === 'a1') {
        return Promise.resolve({
          statusCode: 'pending_evaluation',
          thresholdsComplete: true,
        } as never);
      }
      return Promise.reject(new BizException(BizCode.RECRUITMENT_APPLICATION_WRONG_STATE));
    });

    const res = await service.batchMarkThreshold(dto(), user, meta, now);

    // ① 仅对 matched 的 a1/a2 调单行 markThreshold(零第二套);unmatched 不调
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith(
      'a1',
      { thresholdCode: 'patrol1', completed: true },
      user,
      meta,
      now,
    );

    // ② 逐行结果 + 汇总(逐行容错:a2 failed 不影响 a1 marked / T9 unmatched)
    expect(res.total).toBe(3);
    expect(res.marked).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.unmatched).toBe(1);
    expect(res.autoAdvanced).toBe(1); // a1 末次完成自动推进

    const a1 = res.results.find((r) => r.applicationId === 'a1');
    expect(a1).toMatchObject({
      status: 'marked',
      statusCode: 'pending_evaluation',
      matchedBy: 'tempNo',
    });
    const a2 = res.results.find((r) => r.applicationId === 'a2');
    expect(a2).toMatchObject({
      status: 'failed',
      errorCode: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE.code,
    });
    const unmatched = res.results.find((r) => r.status === 'unmatched');
    expect(unmatched).toMatchObject({ index: 2, unmatchedReason: 'no-match', applicationId: null });
  });

  it('RBAC 拒绝 → RBAC_FORBIDDEN(入口快速失败,不触候选查询)', async () => {
    const prisma = { recruitmentApplication: { findMany: jest.fn() } };
    const rbac = { can: jest.fn().mockResolvedValue(false) };
    const service = new RecruitmentApplicationsService(
      prisma as never,
      rbac as never,
      { log: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(service.batchMarkThreshold(dto() as never, user, meta, now)).rejects.toMatchObject(
      {
        biz: { code: BizCode.RBAC_FORBIDDEN.code },
      },
    );
    expect(prisma.recruitmentApplication.findMany).not.toHaveBeenCalled();
  });
});
