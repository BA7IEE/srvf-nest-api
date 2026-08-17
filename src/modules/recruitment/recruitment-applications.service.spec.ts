import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RecruitmentApplicationProgressService } from './recruitment-application-progress.service';
import { RecruitmentCycleAccessService } from './recruitment-cycle-access.service';
import { RecruitmentOcrService } from './recruitment-ocr.service';
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
//
// god-service 拆分(2026-06-28):admin 读面脱敏 / CSV 导出 characterization 迁至
// recruitment-applications-query.service.spec.ts;批量标门槛编排迁至
// recruitment-application-review.service.spec.ts(随方法搬家,断言不变)。本 spec 保留公开 submit 链 FM-B。

describe('RecruitmentApplicationsService · FM-B 孤儿 blob 补偿删', () => {
  const VALID_MAINLAND_ID = '110101199003070038'; // GB11643 有效校验位 + 36 岁(2026 基准)

  function buildPayload(): RecruitmentSubmitPayloadDto {
    return {
      wechatCode: 'code-x',
      phoneVerificationToken: 'token-x',
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
      privacyConsentAccepted: true, // F5 契约收紧:submit 必填
    };
  }

  const image: UploadedImageFile = {
    buffer: Buffer.from('fake-id-card-bytes'),
    mimetype: 'image/jpeg',
    size: 100,
  };
  const signatureImage: UploadedImageFile = {
    buffer: Buffer.from('fake-signature-bytes'),
    mimetype: 'image/png',
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
      readObjectPrefix: jest.fn(),
    };
    const prisma = {
      // resolveOpenCycleOrThrow:存在 open 轮、不限容量(跳过 count)
      recruitmentCycle: {
        findFirst: jest.fn().mockResolvedValue({ id: 'cyc1', capacity: null, year: 2026 }),
      },
      // 同轮去重 precheck(身份证号 + F1 openid/phone):无重复
      recruitmentApplication: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      // F3:relation 字典校验(assertEmergencyRelationCodeValid)→ 命中 ACTIVE 项(校验通过)
      dictItem: {
        findFirst: jest.fn().mockResolvedValue({ id: 'rel1' }),
      },
      // F1 OCR 日封顶计数(mainland 付费 OCR 前 upsert increment;未超限)
      recruitmentOcrDailyCounter: {
        upsert: jest.fn().mockResolvedValue({ count: 1 }),
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

    const identity = {
      assertPhoneSessionValid: jest.fn(),
      consumePhoneSession: jest.fn(),
      readOcrAttemptState: jest.fn().mockResolvedValue(null),
      writeOcrAttempt: jest.fn().mockResolvedValue(undefined),
    };
    // Phase 6-B 第三域第四刀:三个新类全部传**真实实例**并喂同一组 mock ——
    // OCR 配额闸、裁剪图存取与补偿删除、周期容量预检的行为锁必须走真实实现。
    // mock 掉它们等于把本 spec 的「补偿删孤儿 blob」「OCR 只调一次」等断言变成自说自话。
    const cycles = new RecruitmentCycleAccessService(prisma as never);
    const ocr = new RecruitmentOcrService(
      prisma as never,
      cycles,
      realname as never,
      { validateFromBuffer: jest.fn() } as never,
      storage,
      { recruitmentOcr: { dailyIpLimit: 30 } } as never,
    );
    const service = new RecruitmentApplicationsService(
      cycles,
      ocr,
      new RecruitmentApplicationProgressService(prisma as never, wechat as never),
      prisma as never,
      rbac as never,
      auditLogs as never,
      wechat as never,
      realname as never,
      identity as never,
      { validateFromBuffer: jest.fn() } as never,
      storage,
      { recruitmentOcr: { dailyIpLimit: 30 } } as never, // F1:OCR 日封顶 config
    );
    // ⚠️ 第三域第四刀:ocr 一并返回 —— safeDeleteOrphanImage / 配额闸的**观测点**随族迁走了,
    // spy 必须打在真正执行那段代码的实例上(打在主 service 上 spy 不会被触发,而断言会红得莫名其妙)。
    return { service, storage, prisma, realname, ocr };
  }

  it('单事务普通错误失败 → 补偿删孤儿 blob + 原错上抛;OCR 已在事务前调一次', async () => {
    const { service, storage, realname } = buildService(new Error('tx boom'));

    await expect(service.submit(buildPayload(), image, signatureImage, meta, now)).rejects.toThrow(
      'tx boom',
    );

    expect(storage.putObject).toHaveBeenCalledTimes(2);
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
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
      meta: { target: ['idCardNumber'] },
    });
    const { service, storage } = buildService(p2002);

    await expect(
      service.submit(buildPayload(), image, signatureImage, meta, now),
    ).rejects.toMatchObject({
      biz: { code: BizCode.RECRUITMENT_DUPLICATE_APPLICATION.code },
    });
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
    expect(storage.deleteObject).toHaveBeenCalledWith(
      expect.stringContaining('recruitment/id-card/cyc1/'),
    );
  });

  it('补偿删失败仅写固定安全分类且不掩盖原错', async () => {
    const { service, ocr, storage } = buildService(new Error('tx1 boom'));
    const rawProviderMessage =
      'COS bucket=private-bucket secret=credential-value url=https://cos.example/raw-key';
    storage.deleteObject.mockRejectedValueOnce(new Error(rawProviderMessage));
    const warnSpy = jest
      .spyOn((ocr as unknown as { logger: { warn(message: unknown): void } }).logger, 'warn')
      .mockImplementation(() => undefined);

    // deleteObject 抛错被 safeDeleteOrphanImage 吞掉 → 仍以原 tx1 错误结束
    await expect(service.submit(buildPayload(), image, signatureImage, meta, now)).rejects.toThrow(
      'tx1 boom',
    );
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith({
      event: 'recruitment.storage-cleanup.failed',
      operation: 'delete-orphan-id-card-image',
      safeErrorCategory: 'storage-delete-failed',
      retryable: true,
      manualCleanupRequired: true,
    });
    const serialized = JSON.stringify(warnSpy.mock.calls);
    expect(serialized).not.toContain('recruitment/id-card/');
    expect(serialized).not.toContain('private-bucket');
    expect(serialized).not.toContain('credential-value');
    expect(serialized).not.toContain('https://cos.example');
    expect(serialized).not.toContain(rawProviderMessage);
  });

  it('OCR defer 运维日志不写明文或掩码手机号', async () => {
    const { service, realname, storage, prisma } = buildService(new Error('must not transact'));
    realname.recognize.mockRejectedValueOnce(new BizException(BizCode.REALNAME_API_FAILED));
    const logSpy = jest
      .spyOn((service as unknown as { logger: { log(message: unknown): void } }).logger, 'log')
      .mockImplementation(() => undefined);

    await expect(
      service.submit(buildPayload(), image, signatureImage, meta, now),
    ).resolves.toBeDefined();
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith({
      event: 'recruitment.ocr-submit.deferred',
      operation: 'submit',
      requestId: 'r1',
    });
    const serialized = JSON.stringify(logSpy.mock.calls);
    expect(serialized).not.toContain('13900000001');
    expect(serialized).not.toContain('139****0001');
  });

  it('BizException 形态正确(P2002 → 28003 的 httpStatus 一致)', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['recruitment_applications_cycle_idcard_active_unique'] },
    });
    const { service } = buildService(p2002);
    await service.submit(buildPayload(), image, signatureImage, meta, now).catch((e) => {
      expect(e).toBeInstanceOf(BizException);
      expect((e as BizException).biz).toEqual(BizCode.RECRUITMENT_DUPLICATE_APPLICATION);
    });
  });
});

// review #484 G3(2026-07-03):主证件照 putObject + 两次裁剪图 storeCropImage 原位于拥有 FM-B 补偿的
// try 之外——裁剪图落图抛错时,已写成功的主证件照(及先成功的裁剪图)key 从未被补偿删,成永久存储孤儿。
// 修复把三次落图纳入与事务同一个 try/catch 失败域,复用既有 storedKeys 补偿循环(见上方 describe)。
// mainlandOcr 需带 cardImageBase64/portraitImageBase64 才会触发 step 10b 的两次 storeCropImage 调用
// ——上面的 FM-B 回归组 realname.recognize 桩不含这两个字段,故单独建组覆盖。
describe('RecruitmentApplicationsService · 落图失败孤儿补偿(review #484 G3)', () => {
  const VALID_MAINLAND_ID = '110101199003070038'; // GB11643 有效校验位 + 36 岁(2026 基准)

  function buildPayload(): RecruitmentSubmitPayloadDto {
    return {
      wechatCode: 'code-x',
      phoneVerificationToken: 'token-x',
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
      privacyConsentAccepted: true, // F5 契约收紧:submit 必填
    };
  }

  const image: UploadedImageFile = {
    buffer: Buffer.from('fake-id-card-bytes'),
    mimetype: 'image/jpeg',
    size: 100,
  };
  const meta: AuditMeta = { requestId: 'r1', ip: null, ua: null };
  const now = new Date('2026-06-18T00:00:00.000Z');

  // mainland 鉴伪版返回主体框 + 头像裁剪图 base64 → step 10b 两次 storeCropImage 均实际调用 putObject。
  function buildServiceWithCrops() {
    const storage = {
      putObject: jest.fn(),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      generateUploadUrl: jest.fn(),
      generateDownloadUrl: jest.fn(),
      headObject: jest.fn(),
      readObjectPrefix: jest.fn(),
    };
    const prisma = {
      recruitmentCycle: {
        findFirst: jest.fn().mockResolvedValue({ id: 'cyc1', capacity: null, year: 2026 }),
      },
      recruitmentApplication: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      dictItem: {
        findFirst: jest.fn().mockResolvedValue({ id: 'rel1' }),
      },
      // F1 OCR 日封顶计数(mainland 付费 OCR 前 upsert increment;未超限)
      recruitmentOcrDailyCounter: {
        upsert: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // 本组测试均在落图阶段先抛错,事务不应被调用
      $transaction: jest.fn(),
    };
    const wechat = { code2session: jest.fn().mockResolvedValue({ openid: 'op1' }) };
    const realname = {
      recognize: jest.fn().mockResolvedValue({
        recognized: true,
        name: '张三',
        idCardNumber: VALID_MAINLAND_ID,
        warnings: [],
        cardImageBase64: 'ZmFrZS1jYXJkLWNyb3A=',
        portraitImageBase64: 'ZmFrZS1wb3J0cmFpdA==',
      }),
    };
    const rbac = { can: jest.fn() };
    const auditLogs = { log: jest.fn() };
    const identity = {
      assertPhoneSessionValid: jest.fn(),
      consumePhoneSession: jest.fn(),
      readOcrAttemptState: jest.fn().mockResolvedValue(null),
      writeOcrAttempt: jest.fn().mockResolvedValue(undefined),
    };
    // Phase 6-B 第三域第四刀:三个新类全部传**真实实例**并喂同一组 mock ——
    // OCR 配额闸、裁剪图存取与补偿删除、周期容量预检的行为锁必须走真实实现。
    // mock 掉它们等于把本 spec 的「补偿删孤儿 blob」「OCR 只调一次」等断言变成自说自话。
    const cycles = new RecruitmentCycleAccessService(prisma as never);
    const ocr = new RecruitmentOcrService(
      prisma as never,
      cycles,
      realname as never,
      { validateFromBuffer: jest.fn() } as never,
      storage,
      { recruitmentOcr: { dailyIpLimit: 30 } } as never,
    );
    const service = new RecruitmentApplicationsService(
      cycles,
      ocr,
      new RecruitmentApplicationProgressService(prisma as never, wechat as never),
      prisma as never,
      rbac as never,
      auditLogs as never,
      wechat as never,
      realname as never,
      identity as never,
      { validateFromBuffer: jest.fn() } as never,
      storage,
      { recruitmentOcr: { dailyIpLimit: 30 } } as never, // F1:OCR 日封顶 config
    );
    return { service, storage, prisma };
  }

  it('头像裁剪图(第 3 次 putObject)抛错 → 主证件照 + 主体裁剪图 key 全部补偿删除 + 原错误照抛', async () => {
    const { service, storage, prisma } = buildServiceWithCrops();
    storage.putObject
      .mockResolvedValueOnce({ key: 'k1', etag: null }) // 主证件照
      .mockResolvedValueOnce({ key: 'k2', etag: null }) // 主体框裁剪图
      .mockRejectedValueOnce(new Error('portrait crop putObject boom')); // 头像裁剪图

    await expect(service.submit(buildPayload(), image, image, meta, now)).rejects.toThrow(
      'portrait crop putObject boom',
    );

    expect(storage.putObject).toHaveBeenCalledTimes(3);
    expect(prisma.$transaction).not.toHaveBeenCalled(); // 落图先抛,事务从未开启
    expect(storage.deleteObject).toHaveBeenCalledTimes(2);
    expect(storage.deleteObject).toHaveBeenCalledWith(
      expect.stringContaining('recruitment/id-card/cyc1/'),
    );
    expect(storage.deleteObject).toHaveBeenCalledWith(
      expect.stringContaining('recruitment/id-card-crop/cyc1/'),
    );
  });

  it('主体框裁剪图(第 2 次 putObject)抛错 → 仅先前已写的主证件照 key 被补偿删除,头像裁剪图从未调用', async () => {
    const { service, storage, prisma } = buildServiceWithCrops();
    storage.putObject
      .mockResolvedValueOnce({ key: 'k1', etag: null }) // 主证件照
      .mockRejectedValueOnce(new Error('body crop putObject boom')); // 主体框裁剪图

    await expect(service.submit(buildPayload(), image, image, meta, now)).rejects.toThrow(
      'body crop putObject boom',
    );

    expect(storage.putObject).toHaveBeenCalledTimes(2); // 头像裁剪图短路未调用
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledWith(
      expect.stringContaining('recruitment/id-card/cyc1/'),
    );
  });

  it('主证件照(第 1 次 putObject)自身抛错 → 该 key 补偿删为空操作(从未真正写入),原错误照抛', async () => {
    const { service, storage, prisma } = buildServiceWithCrops();
    storage.putObject.mockRejectedValueOnce(new Error('main image putObject boom'));

    await expect(service.submit(buildPayload(), image, image, meta, now)).rejects.toThrow(
      'main image putObject boom',
    );

    expect(storage.putObject).toHaveBeenCalledTimes(1); // 两次裁剪图短路未调用
    expect(prisma.$transaction).not.toHaveBeenCalled();
    // 主证件照 key 在 storedKeys 初始化时已预置,即使自身落图失败也仍走一次 best-effort 删(空操作)
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
  });
});

// review #484 G4(2026-07-03):resolveManual 写响应曾恒 toAdminApplicationDto(updated, false) 明文,
// 未检查 read.sensitive —— 与详情/导出(recruitment-applications-query.service.ts)口径矛盾。
// 镜像 query.service.spec.ts 的 rbac.can mock 范式(SENSITIVE 常量同款),锁定双分支。
describe('RecruitmentApplicationsService.resolveManual · S3 敏感字段分级(响应脱敏闸,review #484 G4)', () => {
  const RAW_ID = '110101199003070038';
  const RAW_PHONE = '13900000001';
  const RESOLVE = 'recruitment-application.resolve.manual';
  const SENSITIVE = 'recruitment-application.read.sensitive';
  const user = { id: 'admin1', username: 'admin', role: 'ADMIN', memberId: null } as never;
  const meta: AuditMeta = { requestId: 'r1', ip: null, ua: null };
  const now = new Date('2026-06-24T00:00:00.000Z');

  // toAdminApplicationDto / isPromotable 读到的字段全集(镜像 query.service.spec.ts 的 ROW)
  const UPDATED_ROW = {
    id: 'app-1',
    cycleId: 'cyc-1',
    statusCode: 'rejected',
    tempNo: null,
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
    eliminationStage: 'manual',
    idCardImageKey: null,
    thresholdMarks: null,
    evaluationNote: null,
    promotedMemberId: null,
    openid: 'op-1',
    createdAt: new Date('2026-06-18T00:00:00.000Z'),
  };

  // approved:false(reject 分支)——避免另外桩 issueTempNo 的 tx.recruitmentCycle.update(该分支已由
  // e2e ㉑-㉔ 覆盖发号路径,本组只锁「响应脱敏随 read.sensitive」这层,与业务态转移正交)。
  function buildService(canMap: Record<string, boolean>) {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'app-1' }]),
      recruitmentApplication: {
        // 第 1/2 次是「锁前定位 + 锁后权威重读」;第 4 次是 H1 新增的
        // 「级联 + 门槛重算之后再读一遍」—— 重算可能刚清掉 thresholdMarks,
        // 响应必须是那之后的事实。返回 UPDATED_ROW 让脱敏断言仍拿到证件号/手机。
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ id: 'app-1', statusCode: 'manual_review' })
          .mockResolvedValueOnce({ id: 'app-1', statusCode: 'manual_review' })
          .mockResolvedValue(UPDATED_ROW),
        update: jest.fn().mockResolvedValue(UPDATED_ROW),
      },
      // 评审 findings H1:核验不通过 = 报名进终态 ⇒ 级联该报名的非 PROMOTED Claim。
      // 摆一条真 Claim 而不是空数组:空数组会让收尾函数提前返回,
      // 「级联真的发生了」就测不到。SUBMITTED 不贡献门槛 ⇒ 重算无改动。
      recruitmentCertificateClaim: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: 'claim-manual-1', status: 'SUBMITTED', standard: { categoryCode: 'first_aid' } },
          ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn().mockImplementation((cb: (tx: unknown) => unknown) => cb(tx)),
    };
    const rbac = {
      can: jest.fn((_u: unknown, code: string) => Promise.resolve(canMap[code] ?? false)),
    };
    const auditLogs = { log: jest.fn() };
    // Phase 6-B 第三域第四刀:本组只测 resolveManual,不触 OCR / 进度查询 ——
    // 故那两族传空替身即可;周期层仍传真实实例(容量预检在人工 resolve 路径上也生效)。
    const cycles = new RecruitmentCycleAccessService(prisma as never);
    const service = new RecruitmentApplicationsService(
      cycles,
      {} as never,
      {} as never,
      prisma as never,
      rbac as never,
      auditLogs as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { recruitmentOcr: { dailyIpLimit: 30 } } as never, // F1:OCR 日封顶 config(本组不触 submit)
    );
    return { service, tx };
  }

  it('仅持 resolve.manual(无 read.sensitive)→ 响应脱敏证件号/手机', async () => {
    const { service, tx } = buildService({ [RESOLVE]: true, [SENSITIVE]: false });
    const dto = await service.resolveManual('app-1', { approved: false }, user, meta, now);
    // 4 次 =「锁前定位 + 锁后权威重读」(本用例原意)+ 门槛重算内的一次读 +
    // 级联/重算之后的收尾重读(H1 新增,刻意的,不是回归)。
    expect(tx.recruitmentApplication.findFirst).toHaveBeenCalledTimes(4);
    expect(tx.recruitmentApplication.findFirst.mock.invocationCallOrder[1]).toBeGreaterThan(
      tx.$queryRaw.mock.invocationCallOrder[0],
    );
    // 级联真的发生了:少了这一句,把收尾函数整段删掉也不会红。
    expect(tx.recruitmentCertificateClaim.updateMany).toHaveBeenCalledTimes(1);
    expect(dto.idCardNumber).not.toBe(RAW_ID);
    expect(dto.idCardNumber).toContain('*');
    expect(dto.phone).not.toBe(RAW_PHONE);
    expect(dto.phone).toContain('*');
  });

  it('持 resolve.manual + read.sensitive → 响应明文证件号/手机', async () => {
    const { service } = buildService({ [RESOLVE]: true, [SENSITIVE]: true });
    const dto = await service.resolveManual('app-1', { approved: false }, user, meta, now);
    expect(dto.idCardNumber).toBe(RAW_ID);
    expect(dto.phone).toBe(RAW_PHONE);
  });
});

// 招新可用性收口 F1(2026-07-11;评审稿 recruitment-usability-closeout-review.md §2.5/E-U-2):
// ① 同轮活跃报名 openid/phone 去重发生在付费 OCR **之前**(命中 28004/28005,recognize 与落图零调用);
// ② 付费 OCR 按 IP 北京自然日封顶(upsert increment 后判限;超限 28060,recognize 零调用)。
describe('RecruitmentApplicationsService.submit · F1 防重前移 + OCR 日封顶', () => {
  const VALID_MAINLAND_ID = '110101199003070038';

  function buildPayload(): RecruitmentSubmitPayloadDto {
    return {
      wechatCode: 'code-x',
      phoneVerificationToken: 'token-x',
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
      privacyConsentAccepted: true, // F5 契约收紧:submit 必填
    };
  }

  const image: UploadedImageFile = {
    buffer: Buffer.from('fake-id-card-bytes'),
    mimetype: 'image/jpeg',
    size: 100,
  };
  const meta: AuditMeta = { requestId: 'r1', ip: '203.0.113.9', ua: null };
  const now = new Date('2026-07-11T00:00:00.000Z');

  // dupHits:按 findFirst 调用序(① idCard ② openid ③ phone)指定哪一步命中;quotaCount:upsert 返回值。
  function buildService(opts: { dupHits?: Array<null | { id: string }>; quotaCount?: number }) {
    const findFirst = jest.fn();
    for (const hit of opts.dupHits ?? [null, null, null]) {
      findFirst.mockResolvedValueOnce(hit);
    }
    const storage = {
      putObject: jest.fn().mockResolvedValue({ key: 'k', etag: null }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      generateUploadUrl: jest.fn(),
      generateDownloadUrl: jest.fn(),
      headObject: jest.fn(),
      readObjectPrefix: jest.fn(),
    };
    const prisma = {
      recruitmentCycle: {
        findFirst: jest.fn().mockResolvedValue({ id: 'cyc1', capacity: null, year: 2026 }),
      },
      recruitmentApplication: { findFirst },
      dictItem: { findFirst: jest.fn().mockResolvedValue({ id: 'rel1' }) },
      recruitmentOcrDailyCounter: {
        upsert: jest.fn().mockResolvedValue({ count: opts.quotaCount ?? 1 }),
      },
      $transaction: jest.fn(),
    };
    const wechat = { code2session: jest.fn().mockResolvedValue({ openid: 'op1' }) };
    const realname = { recognize: jest.fn() };
    const identity = {
      assertPhoneSessionValid: jest.fn(),
      consumePhoneSession: jest.fn(),
      readOcrAttemptState: jest.fn().mockResolvedValue(null),
      writeOcrAttempt: jest.fn().mockResolvedValue(undefined),
    };
    // Phase 6-B 第三域第四刀:三个新类全部传**真实实例**并喂同一组 mock ——
    // OCR 配额闸、裁剪图存取与补偿删除、周期容量预检的行为锁必须走真实实现。
    // mock 掉它们等于把本 spec 的「补偿删孤儿 blob」「OCR 只调一次」等断言变成自说自话。
    const cycles = new RecruitmentCycleAccessService(prisma as never);
    const ocr = new RecruitmentOcrService(
      prisma as never,
      cycles,
      realname as never,
      { validateFromBuffer: jest.fn() } as never,
      storage,
      { recruitmentOcr: { dailyIpLimit: 30 } } as never,
    );
    const service = new RecruitmentApplicationsService(
      cycles,
      ocr,
      new RecruitmentApplicationProgressService(prisma as never, wechat as never),
      prisma as never,
      { can: jest.fn() } as never,
      { log: jest.fn() } as never,
      wechat as never,
      realname as never,
      identity as never,
      { validateFromBuffer: jest.fn() } as never,
      storage,
      { recruitmentOcr: { dailyIpLimit: 30 } } as never,
    );
    // ⚠️ 配额闸的日志观测点随 OCR 族迁走 —— spy 打在 ocr 实例上,不是主 service。
    const loggerWarn = jest
      .spyOn((ocr as unknown as { logger: { warn(message: unknown): void } }).logger, 'warn')
      .mockImplementation();
    return { service, storage, prisma, realname, loggerWarn };
  }

  it('同轮活跃 openid 命中 → 28004;付费 OCR / 落图 / 事务零调用', async () => {
    const { service, storage, prisma, realname } = buildService({
      dupHits: [null, { id: 'dup-openid' }],
    });
    await expect(service.submit(buildPayload(), image, image, meta, now)).rejects.toMatchObject({
      biz: { code: BizCode.RECRUITMENT_DUPLICATE_OPENID_ACTIVE.code },
    });
    expect(realname.recognize).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.recruitmentOcrDailyCounter.upsert).not.toHaveBeenCalled(); // 去重在配额计数之前 → 被拒提交不占当日 OCR 配额
  });

  it('同轮活跃 phone 命中 → 28005;付费 OCR / 落图 / 事务零调用', async () => {
    const { service, storage, prisma, realname } = buildService({
      dupHits: [null, null, { id: 'dup-phone' }],
    });
    await expect(service.submit(buildPayload(), image, image, meta, now)).rejects.toMatchObject({
      biz: { code: BizCode.RECRUITMENT_DUPLICATE_PHONE_ACTIVE.code },
    });
    expect(realname.recognize).not.toHaveBeenCalled();
    expect(storage.putObject).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('OCR 日封顶超限(upsert 返回 count > limit)→ 28060;recognize 零调用、计数键 = ip × 北京日', async () => {
    const { service, prisma, realname, loggerWarn } = buildService({ quotaCount: 31 });
    await expect(service.submit(buildPayload(), image, image, meta, now)).rejects.toMatchObject({
      biz: { code: BizCode.RECRUITMENT_OCR_DAILY_LIMIT.code },
    });
    expect(realname.recognize).not.toHaveBeenCalled();
    expect(prisma.recruitmentOcrDailyCounter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ip_dateKey: { ip: '203.0.113.9', dateKey: '2026-07-11' } },
      }),
    );
    expect(loggerWarn).toHaveBeenCalledWith({
      event: 'recruitment.ocr.daily-limit',
      operation: 'recognize',
      safeErrorCategory: 'rate-limit',
      retryable: true,
      manualCleanupRequired: false,
    });
    const serialized = JSON.stringify(loggerWarn.mock.calls);
    expect(serialized).not.toContain('203.0.113.9');
    expect(serialized).not.toContain('2026-07-11');
    expect(serialized).not.toContain('count');
  });

  it('恰达上限(count == limit)→ 放行继续 OCR(先加后判,拒者恒拒边界)', async () => {
    const { service, realname } = buildService({ quotaCount: 30 });
    // recognize 桩未配置返回值 → 后续流程会抛(本用例只锁「配额不拦」),吞掉即可。
    await service.submit(buildPayload(), image, image, meta, now).catch(() => undefined);
    expect(realname.recognize).toHaveBeenCalledTimes(1);
  });
});
