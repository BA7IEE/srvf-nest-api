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

    const service = new RecruitmentApplicationsService(
      prisma as never,
      rbac as never,
      auditLogs as never,
      wechat as never,
      realname as never,
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
