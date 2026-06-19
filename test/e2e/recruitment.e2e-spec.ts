import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { ID_CARD_IMAGE_MAX_BYTES } from '../../src/modules/recruitment/recruitment.constants';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { Role } from '@prisma/client';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 招新一期(招新前段)T3 e2e(冻结评审稿 docs/archive/reviews/recruitment-phase1-review.md §4/§7):
// 报名全链 + 校验失败分支 + 外籍人工 + 编号按序唯一 + 防重复 + 轮次开关 + 付费核验前置免费校验 +
// 每次核验入 audit + signed-URL 取图 + members 计数零增长。DevStub 双通道(wechat / realname)驱动。
//
// DevStub 语义:
//   wechat code2session → openid = `dev-openid-<code>`(不同 code = 不同微信用户)。
//   realname verify → 身份证号校验位(第 18 位)偶(含 X=10)→ matched;奇 → mismatch(评审稿 E-R-6)。
// 故下列号均为 **GB11643 真有效校验位**(先过 service isValidChineseId 免费校验,再由 DevStub 判 matched)。

const OPEN_SUBMIT = '/api/open/v1/recruitment/applications';
const OPEN_QUERY = '/api/open/v1/recruitment/applications/query';
const ADMIN_CYCLES = '/api/admin/v1/recruitment/cycles';
const ADMIN_APPS = '/api/admin/v1/recruitment/applications';

// 校验位偶 → DevStub matched(报名 → verified + 发临时编号)
const ID_MATCH_A = '110101199003070038'; // 校验位 8
const ID_MATCH_B = '110101199003070046'; // 校验位 6
const ID_MATCH_C = '110101199003070054'; // 校验位 4
// 校验位奇 → DevStub mismatch(报名 → rejected)
const ID_MISMATCH = '110101199003070011'; // 校验位 1
// 有效校验位但年龄越界(生于 2015,约 11 岁)
const ID_UNDERAGE = '110101201503070018';
// 校验位错误 → isValidChineseId=false(免费校验即拦,不进付费核验)
const ID_INVALID = '110101199003070010';

describe('招新一期(招新前段)报名全链 e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string; // SUPER_ADMIN(rbac.can 短路通过)
  let userAuth: string; // 普通 USER(RBAC 边界)

  function validPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      wechatCode: 'code-default',
      realName: '张三',
      idCardNumber: ID_MATCH_A,
      documentTypeCode: 'mainland_id',
      phone: '13900000001',
      detailedAddress: '北京市朝阳区某街道 1 号院 2 单元',
      cityDistrict: '北京市朝阳区',
      sourceChannel: 'wechat_moments',
      emergencyContacts: [
        { name: '李四', relation: '父亲', phone: '13900000002' },
        { name: '王五', relation: '母亲', phone: '13900000003' },
      ],
      ...over,
    };
  }

  function submit(
    payload: Record<string, unknown>,
    opts: { withImage?: boolean } = {},
  ): request.Test {
    const withImage = opts.withImage ?? true;
    let req = request(httpServer(app)).post(OPEN_SUBMIT).field('payload', JSON.stringify(payload));
    if (withImage) {
      req = req.attach('idCardImage', Buffer.from('fake-id-card-image-bytes'), {
        filename: 'id.jpg',
        contentType: 'image/jpeg',
      });
    }
    return req;
  }

  function openCycle(over: Record<string, unknown> = {}) {
    return prisma.recruitmentCycle.create({
      data: { year: 2026, name: '2026 年度招新', statusCode: 'open', ...over },
    });
  }

  function realnameVerifyAuditCount(): Promise<number> {
    return prisma.auditLog.count({ where: { event: 'recruitment-application.realname-verify' } });
  }

  beforeAll(async () => {
    process.env.RECRUITMENT_THROTTLE_LIMIT = '100'; // 配额上限(评审稿 max 100);全链测试不触限流
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

    // 双 DevStub 通道:wechat(确定性假 openid)+ realname(校验位奇偶定 matched)
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prisma.realnameVerificationSettings.create({
      data: { providerType: 'DEV_STUB', enabled: true },
    });

    await createTestUser(app, { username: 'recruit_admin', role: Role.SUPER_ADMIN });
    adminAuth = (await loginAs(app, 'recruit_admin')).authHeader;
    await createTestUser(app, { username: 'recruit_user', role: Role.USER });
    userAuth = (await loginAs(app, 'recruit_user')).authHeader;
  });

  afterAll(async () => {
    delete process.env.RECRUITMENT_THROTTLE_LIMIT;
    await app.close();
  });

  beforeEach(async () => {
    // 每测隔离:清报名 + 轮次 + 招新审计(audit 计数按 event 断言,需逐测清零)
    await prisma.recruitmentApplication.deleteMany({});
    await prisma.recruitmentCycle.deleteMany({});
    await prisma.auditLog.deleteMany({
      where: { resourceType: { in: ['recruitment_application', 'recruitment_cycle'] } },
    });
  });

  // ① 报名全链 → verified + 临时编号 + members 计数零增长
  it('① 大陆证件 matched → 200 verified + 临时编号 T20260001;members 零增长', async () => {
    await openCycle();
    const membersBefore = await prisma.member.count();

    const res = await submit(validPayload({ wechatCode: 'code-a', idCardNumber: ID_MATCH_A }));

    expect(res.status).toBe(201);
    expect(res.body.code).toBe(0);
    expect(res.body.data.statusCode).toBe('verified');
    expect(res.body.data.tempNo).toBe('T20260001');
    expect(res.body.data.cycleName).toBe('2026 年度招新');

    // 临时编号绑在 application,**不**进 members(两层身份铁律)
    expect(await prisma.member.count()).toBe(membersBefore);
    const app1 = await prisma.recruitmentApplication.findFirst({ where: { tempNo: 'T20260001' } });
    expect(app1?.openid).toBe('dev-openid-code-a');
    expect(app1?.statusCode).toBe('verified');
  });

  // ② 校验失败分支 → rejected(无临时编号)
  it('② 大陆证件 mismatch → 200 rejected,无临时编号,eliminationStage=realname', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'code-b', idCardNumber: ID_MISMATCH }));

    expect(res.status).toBe(201);
    expect(res.body.data.statusCode).toBe('rejected');
    expect(res.body.data.tempNo).toBeNull();
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-b' },
    });
    expect(row?.eliminationStage).toBe('realname');
    expect(row?.tempNo).toBeNull();
  });

  // ③ 外籍 → manual_review(不调付费核验);admin 人工 resolve approved → verified + 发号
  it('③ 外籍证件 → manual_review(零付费核验调用);人工 resolve 通过 → verified + 临时编号', async () => {
    await openCycle();
    const res = await submit(
      validPayload({
        wechatCode: 'code-c',
        documentTypeCode: 'passport',
        idCardNumber: 'E12345678',
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.statusCode).toBe('manual_review');
    expect(res.body.data.tempNo).toBeNull();
    // 外籍根本不进付费核验:零 realname-verify 审计
    expect(await realnameVerifyAuditCount()).toBe(0);

    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-c' },
    });
    expect(row?.isForeigner).toBe(true);

    // 人工 resolve approved → verified + 发号
    const resolved = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${row?.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: true, reviewNote: '证件人工核验通过' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.statusCode).toBe('verified');
    expect(resolved.body.data.tempNo).toBe('T20260001');
  });

  // ③b 人工 resolve 仅对 manual_review 生效;非 manual_review → 28040
  it('③b resolve 非 manual_review(已 verified)→ 28040', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-d', idCardNumber: ID_MATCH_A }));
    const verified = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-d' },
    });
    const res = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${verified?.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: true });
    expectBizError(res, BizCode.RECRUITMENT_APPLICATION_NOT_PENDING_MANUAL);
  });

  // ④ 编号按序唯一:两条 matched → T20260001 / T20260002
  it('④ 连续两条 matched → 临时编号按序唯一递增', async () => {
    await openCycle();
    const r1 = await submit(validPayload({ wechatCode: 'code-e1', idCardNumber: ID_MATCH_A }));
    const r2 = await submit(validPayload({ wechatCode: 'code-e2', idCardNumber: ID_MATCH_B }));
    expect(r1.body.data.tempNo).toBe('T20260001');
    expect(r2.body.data.tempNo).toBe('T20260002');
    // tempNo 全局唯一(partial unique 兜底)
    const nos = await prisma.recruitmentApplication.findMany({
      where: { tempNo: { not: null } },
      select: { tempNo: true },
    });
    expect(new Set(nos.map((n) => n.tempNo)).size).toBe(2);
  });

  // ⑤ 防重复:同轮同身份证号(非 rejected)第二次 → 28003
  it('⑤ 同轮同身份证号重复报名 → 28003', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-f1', idCardNumber: ID_MATCH_C }));
    const dup = await submit(validPayload({ wechatCode: 'code-f2', idCardNumber: ID_MATCH_C }));
    expectBizError(dup, BizCode.RECRUITMENT_DUPLICATE_APPLICATION);
    // 防重发生在付费核验前:只有第一条留下 realname-verify 审计
    expect(await realnameVerifyAuditCount()).toBe(1);
  });

  // ⑥ 轮次开关:无 open 轮 → 28030
  it('⑥ 无 open 轮次 → 报名 28030', async () => {
    await openCycle({ statusCode: 'closed' });
    const res = await submit(validPayload({ wechatCode: 'code-g', idCardNumber: ID_MATCH_A }));
    expectBizError(res, BizCode.RECRUITMENT_CYCLE_NOT_OPEN);
  });

  // ⑥b 轮次开关:admin 已有 open 轮时再开第二个 open → 400(至多一个 open)
  it('⑥b admin 开第二个 open 轮 → 400(至多一个 open 轮)', async () => {
    await openCycle(); // 已存在一个 open
    const closed = await prisma.recruitmentCycle.create({
      data: { year: 2027, name: '2027 招新', statusCode: 'closed' },
    });
    const res = await request(httpServer(app))
      .patch(`${ADMIN_CYCLES}/${closed.id}`)
      .set('Authorization', adminAuth)
      .send({ statusCode: 'open' });
    expectBizError(res, BizCode.BAD_REQUEST);
  });

  // ⑥c 容量满 → 28031
  it('⑥c 轮次容量满 → 报名 28031', async () => {
    await openCycle({ capacity: 1 });
    await submit(validPayload({ wechatCode: 'code-h1', idCardNumber: ID_MATCH_A })); // 占 1 个 verified
    const full = await submit(validPayload({ wechatCode: 'code-h2', idCardNumber: ID_MATCH_B }));
    expectBizError(full, BizCode.RECRUITMENT_CYCLE_CAPACITY_FULL);
  });

  // ⑦ 付费核验前置免费校验:无效校验位身份证 → 40000,且**零** realname-verify 审计(未进付费通道)
  it('⑦ 无效校验位身份证 → 40000,付费核验零调用(免费校验前置)', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'code-i', idCardNumber: ID_INVALID }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(BizCode.BAD_REQUEST.code);
    expect(await realnameVerifyAuditCount()).toBe(0);
    // 不建申请
    expect(await prisma.recruitmentApplication.count()).toBe(0);
  });

  // ⑦b 年龄越界 → 28010(免费校验)
  it('⑦b 年龄越界(未满 18)→ 28010', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'code-j', idCardNumber: ID_UNDERAGE }));
    expectBizError(res, BizCode.RECRUITMENT_AGE_OUT_OF_RANGE);
    expect(await realnameVerifyAuditCount()).toBe(0);
  });

  // ⑦c 缺证件照 → 28011
  it('⑦c 缺证件照 → 28011', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'code-k', idCardNumber: ID_MATCH_A }), {
      withImage: false,
    });
    expectBizError(res, BizCode.RECRUITMENT_ID_CARD_IMAGE_REQUIRED);
  });

  // ⑦d 紧急联系人 <2 → 通用 400 校验失败(multipart 内嵌 JSON 手动校验)
  it('⑦d 紧急联系人 <2 → 400', async () => {
    await openCycle();
    const res = await submit(
      validPayload({
        wechatCode: 'code-l',
        idCardNumber: ID_MATCH_A,
        emergencyContacts: [{ name: '李四', relation: '父亲', phone: '13900000002' }],
      }),
    );
    expect(res.status).toBe(400);
  });

  // ⑧ 每次付费核验入 audit:一条 matched 报名 → 恰 1 条 realname-verify 审计 + 1 条 submit 审计
  it('⑧ matched 报名:submit + realname-verify 各留 1 条审计(actor 置空)', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-m', idCardNumber: ID_MATCH_A }));
    expect(await realnameVerifyAuditCount()).toBe(1);
    const submitAudit = await prisma.auditLog.findFirst({
      where: { event: 'recruitment-application.submit' },
    });
    expect(submitAudit?.actorUserId).toBeNull(); // 无账号自助提交
  });

  // ⑨ signed-URL 取图:admin 取证件照短 TTL URL → 200 + url/expiresAt
  it('⑨ admin 取证件照 signed-URL → 200 + url + expiresAt', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-n', idCardNumber: ID_MATCH_A }));
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-n' },
    });
    const res = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${row?.id}/id-card-image-url`)
      .set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(typeof res.body.data.url).toBe('string');
    expect(res.body.data.url.length).toBeGreaterThan(0);
    expect(res.body.data.expiresAt).toBeDefined();
  });

  // ⑩ admin 列表掩码 + 详情全显 + 公开查询本人
  it('⑩ admin 列表身份证掩码 / 详情全显;公开 query 返本人状态', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-o', idCardNumber: ID_MATCH_A }));
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-o' },
    });

    // 列表:身份证号掩码
    const list = await request(httpServer(app)).get(ADMIN_APPS).set('Authorization', adminAuth);
    expect(list.status).toBe(200);
    expect(list.body.data.total).toBe(1);
    expect(list.body.data.items[0].idCardNumber).not.toBe(ID_MATCH_A);
    expect(list.body.data.items[0].idCardNumber).toContain('*');

    // 详情:身份证号全显
    const detail = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${row?.id}`)
      .set('Authorization', adminAuth);
    expect(detail.body.data.idCardNumber).toBe(ID_MATCH_A);

    // 公开 query:本人凭新 code(同 openid)查到 verified
    const q = await request(httpServer(app)).post(OPEN_QUERY).send({ wechatCode: 'code-o' });
    expect(q.status).toBe(200);
    expect(q.body.data.statusCode).toBe('verified');
    expect(q.body.data.tempNo).toBe('T20260001');
  });

  // ⑪ RBAC 边界:普通 USER 调 admin 列表 → 30100
  it('⑪ 普通 USER token 调 admin 报名列表 → 30100', async () => {
    const res = await request(httpServer(app)).get(ADMIN_APPS).set('Authorization', userAuth);
    expectBizError(res, BizCode.RBAC_FORBIDDEN);
  });

  // ===== 系统性审查 R1 修复回归(FM-A / FM-C / F-1) =====

  // FM-A:核验已出 matched 结果但 tx2 失败的真卡死态(pending_verification + verifyOutcome=matched)可人工 resolve 恢复。
  // 直接造该行(模拟 tx2 失败遗留),admin approve → verified + 发号(唯一恢复出口;DoD ② matched 卡死行可发号)。
  it('Ⓐ1 pending_verification matched 卡死态 → 人工 resolve approve 恢复为 verified + 发号', async () => {
    const cycle = await openCycle();
    const stuck = await prisma.recruitmentApplication.create({
      data: {
        cycleId: cycle.id,
        statusCode: 'pending_verification',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: '赵六',
        idCardNumber: ID_MATCH_A,
        phone: '13900000009',
        verifyOutcome: 'matched', // FM-A 收紧:真卡死行须先具备核验结果方可救
      },
    });
    const res = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${stuck.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: true, reviewNote: '核验中断,人工补发' });
    expect(res.status).toBe(200);
    expect(res.body.data.statusCode).toBe('verified');
    expect(res.body.data.tempNo).toBe('T20260001');
  });

  // FM-A:真卡死态也可人工 reject(恢复出口的另一支;不受容量限)。matched 卡死行 admin 仍可裁断为 reject。
  it('Ⓐ2 pending_verification matched 卡死态 → 人工 resolve reject 为 rejected(eliminationStage=manual)', async () => {
    const cycle = await openCycle();
    const stuck = await prisma.recruitmentApplication.create({
      data: {
        cycleId: cycle.id,
        statusCode: 'pending_verification',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: '赵六',
        idCardNumber: ID_MATCH_B,
        phone: '13900000010',
        verifyOutcome: 'matched', // FM-A 收紧:真卡死行须先具备核验结果方可救(reject 路径同理)
      },
    });
    const res = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${stuck.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: false });
    expect(res.status).toBe(200);
    expect(res.body.data.statusCode).toBe('rejected');
    expect(res.body.data.eliminationStage).toBe('manual');
  });

  // FM-A 收紧(DoD ①):核验在途行(pending_verification + verifyOutcome 空)admin 不可碰 —— approve / reject 均 28040。
  // 真腾讯云通道接上后,每个大陆报名调 verify 的数秒窗口都停此态;此闸杜绝 admin 在该窗口抢自动发号 / 提前发号绕实名。
  it('Ⓐ3 pending_verification 核验在途态(verifyOutcome 空)→ resolve approve / reject 均 28040;行零改动', async () => {
    const cycle = await openCycle();
    const inflight = await prisma.recruitmentApplication.create({
      data: {
        cycleId: cycle.id,
        statusCode: 'pending_verification',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: '孙八',
        idCardNumber: ID_MATCH_A,
        phone: '13900000012',
        // verifyOutcome 留空 = 核验在途(verify 未出结果)
      },
    });
    const approve = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${inflight.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: true });
    expectBizError(approve, BizCode.RECRUITMENT_APPLICATION_NOT_PENDING_MANUAL);
    const reject = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${inflight.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: false });
    expectBizError(reject, BizCode.RECRUITMENT_APPLICATION_NOT_PENDING_MANUAL);
    // 在途行未被改动:仍 pending_verification、无 tempNo、verifyOutcome 仍空
    const after = await prisma.recruitmentApplication.findUnique({ where: { id: inflight.id } });
    expect(after?.statusCode).toBe('pending_verification');
    expect(after?.tempNo).toBeNull();
    expect(after?.verifyOutcome).toBeNull();
  });

  // FM-A 收紧(DoD ③):mismatch 卡死行实名核验已判不一致 —— approve 被拒(不绕开实名结果发号),reject 可。
  it('Ⓐ4 pending_verification mismatch 卡死态 → approve 28040;reject 可 → rejected', async () => {
    const cycle = await openCycle();
    const mismatch = await prisma.recruitmentApplication.create({
      data: {
        cycleId: cycle.id,
        statusCode: 'pending_verification',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: '周九',
        idCardNumber: ID_MISMATCH,
        phone: '13900000013',
        verifyOutcome: 'mismatch', // 核验已判不一致的卡死行(tx2 失败遗留)
      },
    });
    // approve 不可:不给绕开实名结果发号的口子
    const approve = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${mismatch.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: true });
    expectBizError(approve, BizCode.RECRUITMENT_APPLICATION_NOT_PENDING_MANUAL);
    const stillStuck = await prisma.recruitmentApplication.findUnique({
      where: { id: mismatch.id },
    });
    expect(stillStuck?.statusCode).toBe('pending_verification');
    expect(stillStuck?.tempNo).toBeNull();
    // reject 可:卡死行清理出口
    const reject = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${mismatch.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: false });
    expect(reject.status).toBe(200);
    expect(reject.body.data.statusCode).toBe('rejected');
    expect(reject.body.data.eliminationStage).toBe('manual');
  });

  // FM-C:容量满时人工 resolve approve 也被发号事务原子挡(28031);自增回滚;reject 不受限。
  it('Ⓒ 容量满 → 人工 resolve approve 也 28031(发号原子校验 + tempNoSeq 回滚);reject 仍可', async () => {
    const cycle = await openCycle({ capacity: 1 });
    // 占满容量:一条 matched 报名 → verified + T20260001(tempNoSeq=1)
    await submit(validPayload({ wechatCode: 'code-cap1', idCardNumber: ID_MATCH_A }));
    const pending = await prisma.recruitmentApplication.create({
      data: {
        cycleId: cycle.id,
        statusCode: 'pending_verification',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: '钱七',
        idCardNumber: ID_MATCH_B,
        phone: '13900000011',
        verifyOutcome: 'matched', // FM-A 收紧:matched 真卡死行方过在途闸,approve 才触达容量原子校验(FM-C)
      },
    });
    const res = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${pending.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: true });
    expectBizError(res, BizCode.RECRUITMENT_CYCLE_CAPACITY_FULL);
    // 行未被发号;cycle.tempNoSeq 因事务回滚保持 1(无超发)
    const after = await prisma.recruitmentApplication.findUnique({ where: { id: pending.id } });
    expect(after?.statusCode).toBe('pending_verification');
    expect(after?.tempNo).toBeNull();
    const c = await prisma.recruitmentCycle.findUnique({ where: { id: cycle.id } });
    expect(c?.tempNoSeq).toBe(1);
    // reject 不受容量限,卡死态始终可被拒(恢复出口不被容量堵死)
    const rej = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${pending.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: false });
    expect(rej.status).toBe(200);
    expect(rej.body.data.statusCode).toBe('rejected');
  });

  // F-1:证件照超 5MB → multer 解析层 413(归一 40000),不全量 buffer 进内存;不建申请。
  it('Ⓕ 证件照超 5MB → 413 + 40000(multer 大小闸);不建申请', async () => {
    await openCycle();
    const tooBig = Buffer.alloc(ID_CARD_IMAGE_MAX_BYTES + 1024);
    const res = await request(httpServer(app))
      .post(OPEN_SUBMIT)
      .field(
        'payload',
        JSON.stringify(validPayload({ wechatCode: 'code-big', idCardNumber: ID_MATCH_A })),
      )
      .attach('idCardImage', tooBig, { filename: 'big.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe(BizCode.BAD_REQUEST.code);
    expect(await prisma.recruitmentApplication.count()).toBe(0);
  });

  // =====================================================================
  // 招新二期(招新后段)T2:门槛标记 + 综合评定 + 公示名单
  // (冻结评审稿 recruitment-phase2-review.md §4/§8;状态机 verified→pending_evaluation→publicity)
  // =====================================================================

  const ADMIN_APPS2 = ADMIN_APPS;
  const THRESHOLDS = ['patrol1', 'patrol2', 'training', 'redCross', 'bsafe'] as const;

  async function submitVerified(code: string, idCard: string, name = '张三') {
    const res = await submit(
      validPayload({ wechatCode: code, idCardNumber: idCard, realName: name }),
    );
    expect(res.body.data.statusCode).toBe('verified');
    return prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: `dev-openid-${code}` },
    });
  }
  function markThreshold(id: string, thresholdCode: string, completed: boolean, auth = adminAuth) {
    return request(httpServer(app))
      .patch(`${ADMIN_APPS2}/${id}/thresholds`)
      .set('Authorization', auth)
      .send({ thresholdCode, completed });
  }
  async function markAll(id: string) {
    for (const c of THRESHOLDS) await markThreshold(id, c, true);
  }
  function evaluate(id: string, approved: boolean, note?: string, auth = adminAuth) {
    return request(httpServer(app))
      .post(`${ADMIN_APPS2}/${id}/evaluate`)
      .set('Authorization', auth)
      .send({ approved, ...(note !== undefined ? { note } : {}) });
  }

  it('㉑(二期) 门槛标记:逐项标 → 末次自动 pending_evaluation;清一项回退 verified;谁标/何时落库', async () => {
    await openCycle();
    const appRow = await submitVerified('p2-1', ID_MATCH_A);
    for (const c of ['patrol1', 'patrol2', 'training', 'redCross']) {
      const r = await markThreshold(appRow.id, c, true);
      expect(r.status).toBe(200);
      expect(r.body.data.statusCode).toBe('verified');
      expect(r.body.data.thresholdsComplete).toBe(false);
    }
    const r5 = await markThreshold(appRow.id, 'bsafe', true);
    expect(r5.body.data.statusCode).toBe('pending_evaluation');
    expect(r5.body.data.thresholdsComplete).toBe(true);

    const after = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { id: appRow.id },
    });
    const marks = after.thresholdMarks as Record<string, { at: string; by: string }>;
    expect(Object.keys(marks).sort()).toEqual([
      'bsafe',
      'patrol1',
      'patrol2',
      'redCross',
      'training',
    ]);
    expect(marks.bsafe.by).toBeTruthy(); // 谁标
    expect(marks.bsafe.at).toBeTruthy(); // 何时

    const rc = await markThreshold(appRow.id, 'patrol1', false);
    expect(rc.body.data.statusCode).toBe('verified'); // 清一项 → 回退
    expect(rc.body.data.thresholdsComplete).toBe(false);
  });

  it('㉒(二期) 门槛标记幂等 + 非法态 28041 + RBAC 边界 + 非法 code 422', async () => {
    await openCycle();
    const appRow = await submitVerified('p2-2', ID_MATCH_B);
    await markThreshold(appRow.id, 'patrol1', true);
    const r2 = await markThreshold(appRow.id, 'patrol1', true); // 幂等
    expect(r2.body.data.statusCode).toBe('verified');
    const row = await prisma.recruitmentApplication.findFirstOrThrow({ where: { id: appRow.id } });
    expect(Object.keys(row.thresholdMarks as object)).toEqual(['patrol1']);

    // 非法态:rejected 报名标门槛 → 28041
    const mm = await submit(validPayload({ wechatCode: 'p2-2b', idCardNumber: ID_MISMATCH }));
    expect(mm.body.data.statusCode).toBe('rejected');
    const rejected = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-p2-2b' },
    });
    expectBizError(
      await markThreshold(rejected.id, 'patrol1', true),
      BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
    );

    // RBAC:USER → forbidden
    expectBizError(
      await markThreshold(appRow.id, 'training', true, userAuth),
      BizCode.RBAC_FORBIDDEN,
    );

    // 非法 thresholdCode → 400 校验失败(@IsIn;沿 phase-1 DTO 校验 400 范式)
    const bad = await request(httpServer(app))
      .patch(`${ADMIN_APPS2}/${appRow.id}/thresholds`)
      .set('Authorization', adminAuth)
      .send({ thresholdCode: 'nope', completed: true });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe(BizCode.BAD_REQUEST.code);
  });

  it('㉓(二期) 综合评定:pending_evaluation 通过→publicity / 不通过→rejected(evaluation)', async () => {
    await openCycle();
    const a1 = await submitVerified('p2-3a', ID_MATCH_A);
    await markAll(a1.id);
    const pass = await evaluate(a1.id, true, '综合表现优秀');
    expect(pass.status).toBe(200);
    expect(pass.body.data.statusCode).toBe('publicity');
    expect(pass.body.data.evaluationNote).toBe('综合表现优秀');

    const a2 = await submitVerified('p2-3b', ID_MATCH_B);
    await markAll(a2.id);
    const fail = await evaluate(a2.id, false, '体能不达标');
    expect(fail.body.data.statusCode).toBe('rejected');
    expect(fail.body.data.eliminationStage).toBe('evaluation');
  });

  it('㉔(二期) verified approved=false→门槛超期淘汰(threshold-timeout);approved=true→28041', async () => {
    await openCycle();
    const a1 = await submitVerified('p2-4a', ID_MATCH_A);
    const timeout = await evaluate(a1.id, false, '逾期未完成门槛');
    expect(timeout.body.data.statusCode).toBe('rejected');
    expect(timeout.body.data.eliminationStage).toBe('threshold-timeout');

    const a2 = await submitVerified('p2-4b', ID_MATCH_B);
    expectBizError(await evaluate(a2.id, true), BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
  });

  it('㉕(二期) 公示名单:拼音序 + 拟发编号预览 + 零敏感 + 外籍 needsManualBuild 不占号', async () => {
    const cycle = await openCycle();
    // 三大陆:张三/李四/王五(拼音 zhang/li/wang)
    const zhang = await submitVerified('p2-5z', ID_MATCH_A, '张三');
    const li = await submitVerified('p2-5l', ID_MATCH_B, '李四');
    const wang = await submitVerified('p2-5w', ID_MATCH_C, '王五');
    for (const a of [zhang, li, wang]) {
      await markAll(a.id);
      await evaluate(a.id, true);
    }
    // 外籍(护照):拼音 '阿' a 排最前;manual_review → resolve → 门槛 → 评定 → publicity
    const fs = await submit(
      validPayload({
        wechatCode: 'p2-5f',
        documentTypeCode: 'passport',
        idCardNumber: 'E87654321',
        realName: '阿福',
      }),
    );
    expect(fs.body.data.statusCode).toBe('manual_review');
    const foreign = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-p2-5f' },
    });
    await request(httpServer(app))
      .post(`${ADMIN_APPS2}/${foreign.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: true });
    await markAll(foreign.id);
    await evaluate(foreign.id, true);

    const res = await request(httpServer(app))
      .get(`${ADMIN_CYCLES}/${cycle.id}/publicity-list`)
      .set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.cycleYear).toBe(2026);
    expect(data.promotableCount).toBe(3);
    expect(data.manualBuildCount).toBe(1);
    // 拼音序:阿福(a) → 李四(li) → 王五(wang) → 张三(zhang)
    expect(data.items.map((i: { realName: string }) => i.realName)).toEqual([
      '阿福',
      '李四',
      '王五',
      '张三',
    ]);
    // 外籍排首但不占号(needsManualBuild + null);大陆按拼音序 26001/26002/26003
    expect(data.items[0]).toMatchObject({
      realName: '阿福',
      isForeigner: true,
      needsManualBuild: true,
      proposedMemberNo: null,
    });
    expect(data.items[1]).toMatchObject({
      realName: '李四',
      needsManualBuild: false,
      proposedMemberNo: '26001',
    });
    expect(data.items[2]).toMatchObject({ realName: '王五', proposedMemberNo: '26002' });
    expect(data.items[3]).toMatchObject({ realName: '张三', proposedMemberNo: '26003' });
    // 零敏感:item 仅 5 字段,无身份证号/手机/住址
    expect(Object.keys(data.items[1] as Record<string, unknown>).sort()).toEqual([
      'applicationId',
      'isForeigner',
      'needsManualBuild',
      'proposedMemberNo',
      'realName',
    ]);
  });
});
