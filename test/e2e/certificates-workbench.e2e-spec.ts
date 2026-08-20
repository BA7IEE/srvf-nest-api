import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import {
  seedCertificateStandard,
  type SeededCertificateStandard,
} from '../fixtures/certificate-standard.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// 证书标准库 PR-5 e2e(冻结稿 §13.5 / §13.6 / §14 / §15.2 / §15.7)。
//
// 三个端点:全局工作台 list / stats + 单证 evidence-urls。
// 本 spec 的重点不是「能不能返数据」,而是三条最容易静默失效的不变量:
//   ① §15.7 scope 先下推再计数 —— 范围外的行既不进 items 也不进 total;
//   ② §14 effectiveStatusCode 与 expired 计数不依赖 cron 已翻态;
//   ③ §15.2 出参白名单 —— 完整编号 / 备注 / 审核人 / key 一个都不许出现。
const WORKBENCH = '/api/admin/v1/certificates';

// §15.2 出参字段闭集。用**精确 key 集合**断言,不用 objectContaining ——
// 后者放行任何新增字段,而工作台扩面正是泄露 L2/L3 的最短路径。
const ITEM_KEYS = [
  'id',
  'member',
  'standard',
  'issuingOrg',
  'certNumberMasked',
  'issuedAt',
  'expiredAt',
  'certStatusCode',
  'effectiveStatusCode',
  'sourceCode',
  'evidenceAvailable',
  'createdAt',
].sort();

describe('certificates 全局工作台 + 证据读取(PR-5)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saAuth: string; // SUPER_ADMIN:全局可见
  let plainAuth: string; // 无任何证书码
  let std: SeededCertificateStandard;
  let memberA: string;

  const SECRET_NUMBER = 'SZ-2026-WORKBENCH-0001';

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'wb-sa', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'wb-plain', role: Role.USER });
    saAuth = (await loginAs(app, 'wb-sa')).authHeader;
    plainAuth = (await loginAs(app, 'wb-plain')).authHeader;

    std = await seedCertificateStandard(prisma, {
      code: 'wb-first-aid',
      categoryCode: 'first_aid',
      levelCode: 'wb-l2',
    });

    memberA = (
      await prisma.member.create({
        data: { memberNo: 'WB-0001', ...memberIdentityData('工作台甲') },
        select: { id: true },
      })
    ).id;

    // §13.5 的 ADMIN 分支交给 AttachmentsService,而它要求 ownerType 有一条 ACTIVE
    // attachment_type_configs 记录。这不是夹具凑数 —— 它是一条**真实运行期耦合**:
    // 运维把 certificate 这条配置停用,ADMIN 来源的证据读取就会 400 而不是返空数组。
    // 那是正确的 fail-closed(配置不确定就不签 URL),但值得知道。
    await prisma.attachmentTypeConfig.create({
      data: {
        code: 'certificate',
        displayName: '证书证据',
        ownerTable: 'certificate',
        status: 'ACTIVE',
      },
    });

    const today = new Date();
    const dayOnly = (offsetDays: number): Date => {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      d.setUTCDate(d.getUTCDate() + offsetDays);
      return d;
    };

    // 六张证书,刻意覆盖 §14 每个计数器至少一格。
    const base = {
      memberId: memberA,
      ...std.certificateColumns,
      issuingOrg: '深圳市红十字会',
      issuedAt: dayOnly(-400),
    };
    await prisma.certificate.createMany({
      data: [
        { ...base, certStatusCode: 'pending', certNumber: SECRET_NUMBER },
        // verified + 终身 → verified & permanent
        { ...base, certStatusCode: 'verified', expiredAt: null },
        // verified + 30 天后到期 → verified & expiringWithin60Days
        { ...base, certStatusCode: 'verified', expiredAt: dayOnly(30) },
        // verified + 90 天后到期 → 只算 verified(不进 60 天窗)
        { ...base, certStatusCode: 'verified', expiredAt: dayOnly(90) },
        // ⚠️ verified 但**已过期**:持久态仍 verified(cron 未翻),§14 要求算进 expired
        { ...base, certStatusCode: 'verified', expiredAt: dayOnly(-1) },
        { ...base, certStatusCode: 'rejected' },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('§15.7 判权:无证书码 → 30100(list 与 stats 都拦)', async () => {
    expectBizError(
      await request(httpServer(app)).get(WORKBENCH).set('Authorization', plainAuth),
      BizCode.RBAC_FORBIDDEN,
    );
    expectBizError(
      await request(httpServer(app)).get(`${WORKBENCH}/stats`).set('Authorization', plainAuth),
      BizCode.RBAC_FORBIDDEN,
    );
  });

  it('§15.2 出参字段恰好 12 个;完整编号 / 备注 / 审核人 / key 一个都不出现', async () => {
    const res = await request(httpServer(app)).get(WORKBENCH).set('Authorization', saAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(6);

    for (const item of res.body.data.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    }
    const serialized = JSON.stringify(res.body);
    // 完整编号绝不出现;掩码可以。
    expect(serialized).not.toContain(SECRET_NUMBER);
    expect(serialized).toContain('SZ****01');
    for (const forbidden of ['verifyNote', 'verifiedBy', 'imageKeys', 'sourceClaimId']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('§14 effectiveStatusCode:verified 但已过期 → expired(不依赖 cron 翻态)', async () => {
    const res = await request(httpServer(app)).get(WORKBENCH).set('Authorization', saAuth);
    const items = res.body.data.items as Array<{
      certStatusCode: string;
      effectiveStatusCode: string;
      expiredAt: string | null;
    }>;
    const stale = items.find(
      (i) =>
        i.certStatusCode === 'verified' &&
        i.expiredAt !== null &&
        new Date(i.expiredAt).getTime() < Date.now(),
    );
    expect(stale).toBeDefined();
    // 持久态仍是 verified —— 这一点必须同时断言,否则看不出「没有发明第五个持久状态」。
    expect(stale?.certStatusCode).toBe('verified');
    expect(stale?.effectiveStatusCode).toBe('expired');
  });

  it('§14 六个计数器逐条(expired 含「verified 但已过期」那一张)', async () => {
    const res = await request(httpServer(app))
      .get(`${WORKBENCH}/stats`)
      .set('Authorization', saAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      pending: 1,
      // 4 张 verified 里,已过期那张不算 verified。
      verified: 3,
      // 只有那张「verified 但 expiredAt<today」—— 库里没有持久 expired 行,
      // 所以这个 1 完全来自第二个分支。少了它这里会是 0。
      expired: 1,
      rejected: 1,
      expiringWithin60Days: 1,
      permanent: 1,
    });
  });

  it('§13.6 过滤:类别 / 状态 / 来源经关联生效;q 命中队员编号但**不搜完整证书编号**', async () => {
    const byCategory = await request(httpServer(app))
      .get(WORKBENCH)
      .query({ categoryCode: 'first_aid' })
      .set('Authorization', saAuth);
    expect(byCategory.body.data.total).toBe(6);

    const byOtherCategory = await request(httpServer(app))
      .get(WORKBENCH)
      .query({ categoryCode: 'bsafe' })
      .set('Authorization', saAuth);
    expect(byOtherCategory.body.data.total).toBe(0);

    const byStatus = await request(httpServer(app))
      .get(WORKBENCH)
      .query({ certStatusCode: 'rejected' })
      .set('Authorization', saAuth);
    expect(byStatus.body.data.total).toBe(1);

    const bySource = await request(httpServer(app))
      .get(WORKBENCH)
      .query({ sourceCode: 'RECRUITMENT' })
      .set('Authorization', saAuth);
    expect(bySource.body.data.total).toBe(0); // 夹具全是 ADMIN 来源

    const byMemberNo = await request(httpServer(app))
      .get(WORKBENCH)
      .query({ q: 'WB-0001' })
      .set('Authorization', saAuth);
    expect(byMemberNo.body.data.total).toBe(6);

    // 拿完整证书编号去搜 → 搜不到。这是刻意的:可搜即可枚举(§13.6)。
    const byCertNumber = await request(httpServer(app))
      .get(WORKBENCH)
      .query({ q: SECRET_NUMBER })
      .set('Authorization', saAuth);
    expect(byCertNumber.body.data.total).toBe(0);
  });

  it('§14 stats 接受与 list 完全相同的非分页过滤(两者不能各算一套)', async () => {
    const q = { certStatusCode: 'verified' };
    const list = await request(httpServer(app))
      .get(WORKBENCH)
      .query(q)
      .set('Authorization', saAuth);
    const stats = await request(httpServer(app))
      .get(`${WORKBENCH}/stats`)
      .query(q)
      .set('Authorization', saAuth);
    // list 的 total 是「持久态 verified」的 4 张;stats 的 verified 是「有效」的 3 张
    // (已过期那张被排除)—— 两者定义不同但**基于同一过滤集**,所以 4 = 3 + 1。
    expect(list.body.data.total).toBe(4);
    expect(stats.body.data.verified + stats.body.data.expired).toBe(4);
  });

  it('§15.7 scope 下推:组织过滤命中不到的范围 → items 与 total 同时为 0', async () => {
    // 该队员没有任何组织归属,所以按任意组织过滤都应命中 0 ——
    // 关键是 total 也必须是 0(先查后裁会让 total 泄露存在数量)。
    const res = await request(httpServer(app))
      .get(WORKBENCH)
      .query({ organizationId: 'no-such-org' })
      .set('Authorization', saAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.total).toBe(0);

    const stats = await request(httpServer(app))
      .get(`${WORKBENCH}/stats`)
      .query({ organizationId: 'no-such-org' })
      .set('Authorization', saAuth);
    expect(stats.body.data).toEqual({
      pending: 0,
      verified: 0,
      expired: 0,
      rejected: 0,
      expiringWithin60Days: 0,
      permanent: 0,
    });
  });

  it('§13.5 证据读取:需 read.sensitive;no-store;ADMIN 来源无 attachment → 空数组', async () => {
    const cert = await prisma.certificate.findFirstOrThrow({
      where: { memberId: memberA },
      select: { id: true },
    });
    const url = `/api/admin/v1/members/${memberA}/certificates/${cert.id}/evidence-urls`;

    expectBizError(
      await request(httpServer(app)).get(url).set('Authorization', plainAuth),
      BizCode.RBAC_FORBIDDEN,
    );

    const ok = await request(httpServer(app)).get(url).set('Authorization', saAuth);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body.data.sourceCode).toBe('ADMIN');
    // 没有 attachment → 空数组,而不是 404;「有没有证据」是合法业务信息。
    expect(ok.body.data.urls).toEqual([]);
    // 出参只有 URL,绝不含 key。
    expect(JSON.stringify(ok.body)).not.toContain('imageKeys');
  });

  it('§13.5 已软删证书不签 URL(归属复查在签之前)', async () => {
    const cert = await prisma.certificate.create({
      data: {
        memberId: memberA,
        ...std.certificateColumns,
        issuingOrg: '深圳市红十字会',
        issuedAt: new Date('2024-01-01T00:00:00.000Z'),
        certStatusCode: 'pending',
        deletedAt: new Date(),
      },
      select: { id: true },
    });
    expectBizError(
      await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberA}/certificates/${cert.id}/evidence-urls`)
        .set('Authorization', saAuth),
      BizCode.CERTIFICATE_NOT_FOUND,
    );
  });
});
