import { BizCode } from '../../common/exceptions/biz-code.constant';
import { RecruitmentApplicationsQueryService } from './recruitment-applications-query.service';

// god-service 拆分(2026-06-28):admin 读面脱敏 + CSV 导出 characterization 随方法从
// RecruitmentApplicationsService 迁来(断言不变,仅构造目标类改为 QueryService)。

// 招新闭环优化 S3(评审稿 recruitment-phase4-loop-optimization-review.md §11.1 / Q-P4-10):
// RBAC 敏感字段分级判权矩阵(单测;mock rbac.can 按码返值,隔离 masking 随码逻辑)。
// - 详情:入口闸 read.record;持 read.sensitive → 明文证件号/手机,仅 read.record → 脱敏(响应字段集不变,只 masking 随码)。
// - 证件照 signed-URL:闸从 read.record 收紧为 read.sensitive。
// - 无码 → RBAC_FORBIDDEN(30100)。
describe('RecruitmentApplicationsQueryService · S3 敏感字段分级判权', () => {
  const RAW_ID = '110101199003070038';
  const RAW_PHONE = '13900000001';
  const RECORD = 'recruitment-application.read.record';
  const SENSITIVE = 'recruitment-application.read.sensitive';

  // toAdminApplicationDto / isPromotable / allThresholdsComplete 读到的字段全集(verified 在途态)
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
      readObjectPrefix: jest.fn(),
    };
    const service = new RecruitmentApplicationsQueryService(
      prisma as never,
      rbac as never,
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
// goal DoD#5「导出 read.record 脱敏 vs read.sensitive 明文」+「脱敏复用 toAdminApplicationDto 口径(零第二套)」。
describe('RecruitmentApplicationsQueryService.exportApplicationsCsv · S3 脱敏分级 + 筛选', () => {
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
    const service = new RecruitmentApplicationsQueryService(
      prisma as never,
      rbac as never,
      {} as never,
    );
    return { service, findMany };
  }

  async function collectCsv(source: AsyncIterable<string>): Promise<string> {
    let result = '';
    for await (const chunk of source) result += chunk;
    return result;
  }

  it('持 read.sensitive → CSV 明文列(id_card_number/phone 原值)', async () => {
    const { service } = buildExportService({ [RECORD]: true, [SENSITIVE]: true }, [row()]);
    const csv = await collectCsv(await service.exportApplicationsCsv({}, ADMIN_USER));
    const [header, line1] = csv.split('\n');
    expect(header.split(',')).toContain('id_card_number');
    expect(header.split(',')).toContain('is_non_mainland_document');
    expect(header.split(',')).not.toContain('is_foreigner');
    expect(line1).toContain(RAW_ID); // 明文
    expect(line1).toContain(RAW_PHONE);
  });

  it('仅 read.record(无 sensitive)→ CSV 脱敏列(掩码,绝不出明文)', async () => {
    const { service } = buildExportService({ [RECORD]: true, [SENSITIVE]: false }, [row()]);
    const csv = await collectCsv(await service.exportApplicationsCsv({}, ADMIN_USER));
    expect(csv).not.toContain(RAW_ID); // 明文绝不泄露
    expect(csv).not.toContain(RAW_PHONE);
    expect(csv).toContain('*'); // 掩码(复用 toAdminApplicationDto)
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
    await collectCsv(
      await service.exportApplicationsCsv({ filter: 'manual', cycleId: 'cyc-9' }, ADMIN_USER),
    );
    expect(whereOfCall(findMany)).toMatchObject({
      deletedAt: null,
      cycleId: 'cyc-9',
      statusCode: 'manual_review',
    });

    findMany.mockClear();
    await collectCsv(await service.exportApplicationsCsv({}, ADMIN_USER));
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
    const csv = await collectCsv(
      await service.exportApplicationsCsv({ filter: 'threshold-incomplete' }, ADMIN_USER),
    );
    // DB where 仍按 verified 取(post-filter 在内存)
    expect(whereOfCall(findMany)).toMatchObject({ statusCode: 'verified' });
    expect(csv).toContain('incomplete');
    expect(csv).not.toContain('done'); // 门槛已齐被滤除
  });

  it('findings #13/#14:500 行后以 id cursor 继续,查询保持 select 投影', async () => {
    const { service, findMany } = buildExportService({ [RECORD]: true }, []);
    findMany
      .mockReset()
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, index) => row({ id: `app-${index}` })))
      .mockResolvedValueOnce([row({ id: 'app-tail' })]);

    const csv = await collectCsv(await service.exportApplicationsCsv({}, ADMIN_USER));

    expect(findMany).toHaveBeenCalledTimes(2);
    const calls = findMany.mock.calls as unknown as Array<
      [{ cursor?: { id: string }; skip?: number; take: number; select: unknown }]
    >;
    expect(calls[1][0]).toMatchObject({ cursor: { id: 'app-499' }, skip: 1, take: 500 });
    expect(calls[1][0].select).toBeDefined();
    expect(csv).toContain('app-tail');
  });
});
