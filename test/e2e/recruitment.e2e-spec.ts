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

// 招新报名全链 e2e(OCR 改造冻结评审稿 docs/archive/reviews/recruitment-realname-ocr-review.md §4/§8):
// 识别端点 + 报名全链(大陆 OCR 匹配→verified / 不匹配·防伪告警·不清晰→manual_review)+ 外籍人工 +
// 编号按序唯一 + 防重复 + 轮次开关 + 付费 OCR 前置免费校验 + 每次 OCR 入 audit + signed-URL + members 零增长。
//
// DevStub 双通道驱动:
//   wechat code2session → openid = `dev-openid-<code>`(不同 code = 不同微信用户)。
//   realname OCR recognize → 把证件照 buffer 当 JSON 信封 {name,idCardNumber,warnings,clarity,documentCategory} 回显。
// 故 submit()/recognize() 把「期望的 OCR 结果」编进图(信封);**匹配/不匹配由信封 vs 提交值决定**,
// 不再由身份证号校验位奇偶决定(OCR 改造退役 realnameDevStubMatched)。下列号均为 GB11643 真有效校验位
// (大陆免费校验 isValidChineseId 仍前置)。

const OPEN_SUBMIT = '/api/open/v1/recruitment/applications';
const OPEN_RECOGNIZE = '/api/open/v1/recruitment/applications/recognize';
const OPEN_QUERY = '/api/open/v1/recruitment/applications/query';
const ADMIN_CYCLES = '/api/admin/v1/recruitment/cycles';
const ADMIN_APPS = '/api/admin/v1/recruitment/applications';

// 有效校验位大陆身份证(OCR 匹配/不匹配改由 submit() 信封驱动,与校验位无关)
const ID_MATCH_A = '110101199003070038';
const ID_MATCH_B = '110101199003070046';
const ID_MATCH_C = '110101199003070054';
const ID_MISMATCH = '110101199003070011'; // 仍是有效号;用于「OCR 与提交值不一致」链(信封造)
// 有效校验位但年龄越界(生于 2015,约 11 岁)
const ID_UNDERAGE = '110101201503070018';
// 校验位错误 → isValidChineseId=false(免费校验即拦,不进付费 OCR)
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
        { name: '李四', relation: 'parent', phone: '13900000002' },
        { name: '王五', relation: 'family', phone: '13900000003' },
      ],
      ...over,
    };
  }

  // 提交:multipart payload + idCardImage(= DevStub OCR 信封)。默认信封 = 与 payload 一致(matched);
  // opts.ocr 覆盖造不一致/告警/不清晰(评审稿 §3.7);opts.withImage=false 造缺图。
  function submit(
    payload: Record<string, unknown>,
    opts: { withImage?: boolean; ocr?: Record<string, unknown> } = {},
  ): request.Test {
    const withImage = opts.withImage ?? true;
    const envelope = opts.ocr ?? {
      name: payload.realName,
      idCardNumber: payload.idCardNumber,
      clarity: true,
      warnings: [],
    };
    let req = request(httpServer(app)).post(OPEN_SUBMIT).field('payload', JSON.stringify(payload));
    if (withImage) {
      req = req.attach('idCardImage', Buffer.from(JSON.stringify(envelope)), {
        filename: 'id.jpg',
        contentType: 'image/jpeg',
      });
    }
    return req;
  }

  // 识别端点:multipart documentTypeCode + idCardImage(= OCR 信封);envelope=null 造缺图。
  function recognize(
    documentTypeCode: string,
    envelope: Record<string, unknown> | null,
  ): request.Test {
    const req = request(httpServer(app))
      .post(OPEN_RECOGNIZE)
      .field('documentTypeCode', documentTypeCode);
    if (envelope === null) return req;
    return req.attach('idCardImage', Buffer.from(JSON.stringify(envelope)), {
      filename: 'id.jpg',
      contentType: 'image/jpeg',
    });
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

    // F3(#399):promote 现复用 canonical assertEmergencyRelationCodeValid 校验 emergency_relation 字典码;
    // seed 该字典 + ACTIVE 项,供 validPayload 的 emergencyContacts.relation 通过(reference data,
    // beforeEach 不清,跨测持久)。
    const relType = await prisma.dictType.create({
      data: { code: 'emergency_relation', label: 'Emergency Relation' },
      select: { id: true },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: relType.id, code: 'parent', label: 'Parent' },
        { typeId: relType.id, code: 'family', label: 'Family' },
      ],
    });

    // 招新闭环优化 S1:recruitment_stage 业务态文案字典(镜像 prisma/seed.ts seedRecruitmentStageDict;
    // 公开查询进度模型的 stageText 来源;reference data,beforeEach 不清,跨测持久)。
    const stageType = await prisma.dictType.create({
      data: { code: 'recruitment_stage', label: '招新进度态' },
      select: { id: true },
    });
    await prisma.dictItem.createMany({
      data: [
        { typeId: stageType.id, code: 'manual', label: '待人工核验', sortOrder: 0 },
        { typeId: stageType.id, code: 'threshold', label: '门槛未完成', sortOrder: 1 },
        { typeId: stageType.id, code: 'threshold_done', label: '门槛已完成', sortOrder: 2 },
        { typeId: stageType.id, code: 'evaluation', label: '待综合评定', sortOrder: 3 },
        { typeId: stageType.id, code: 'publicity', label: '公示中', sortOrder: 4 },
        { typeId: stageType.id, code: 'volunteer', label: '已转志愿者 / 待入队', sortOrder: 5 },
        { typeId: stageType.id, code: 'rejected', label: '未通过', sortOrder: 6 },
      ],
    });
  });

  afterAll(async () => {
    delete process.env.RECRUITMENT_THROTTLE_LIMIT;
    await app.close();
  });

  beforeEach(async () => {
    // 每测隔离:先清 promote 产物(FK 顺序:contacts/profile/绑 member 的 user → member;
    // 二期 promote 跨测会撞 memberNo/openid @unique,phase-1 测试无 member 为 no-op),再清报名/轮次/审计。
    await prisma.emergencyContact.deleteMany({});
    await prisma.memberProfile.deleteMany({});
    await prisma.user.deleteMany({ where: { memberId: { not: null } } }); // promote 建的 User 都绑 member
    await prisma.member.deleteMany({});
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

  // ② 大陆 OCR 不匹配(信封姓名 ≠ 提交)→ manual_review(不再 rejected,「对不上转人工不误杀」)
  it('② 大陆 OCR 不匹配 → 200 manual_review,无临时编号,verifyOutcome=mismatch(不 rejected)', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'code-b', idCardNumber: ID_MATCH_A }), {
      ocr: { name: '李四', idCardNumber: ID_MATCH_A, clarity: true, warnings: [] },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.statusCode).toBe('manual_review');
    expect(res.body.data.tempNo).toBeNull();
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-b' },
    });
    expect(row?.verifyOutcome).toBe('mismatch');
    expect(row?.eliminationStage).toBeNull(); // mismatch 不再写 'realname' 淘汰(退役)
    expect(row?.tempNo).toBeNull();
    expect(await realnameVerifyAuditCount()).toBe(1); // 付费 OCR 已调一次(留痕)
  });

  // ②b 大陆 OCR 防伪告警 → manual_review(forgery_warning;矩阵防伪先于匹配)
  it('②b 大陆 OCR 防伪告警 → manual_review(verifyOutcome=forgery_warning)', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'code-b2', idCardNumber: ID_MATCH_A }), {
      ocr: { name: '张三', idCardNumber: ID_MATCH_A, clarity: true, warnings: ['PS'] },
    });
    expect(res.body.data.statusCode).toBe('manual_review');
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-b2' },
    });
    expect(row?.verifyOutcome).toBe('forgery_warning');
  });

  // ②c 大陆 OCR 证件照不清晰 → manual_review(ocr_unclear)
  it('②c 大陆 OCR 不清晰 → manual_review(verifyOutcome=ocr_unclear)', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'code-b3', idCardNumber: ID_MATCH_A }), {
      ocr: { clarity: false },
    });
    expect(res.body.data.statusCode).toBe('manual_review');
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-b3' },
    });
    expect(row?.verifyOutcome).toBe('ocr_unclear');
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
        emergencyContacts: [{ name: '李四', relation: 'parent', phone: '13900000002' }],
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

    // 公开 query:本人凭新 code(同 openid)查到进度模型(verified + 零门槛 → 业务态 threshold)
    const q = await request(httpServer(app)).post(OPEN_QUERY).send({ wechatCode: 'code-o' });
    expect(q.status).toBe(200);
    expect(q.body.data.stage).toBe('threshold');
    expect(q.body.data.tempNo).toBe('T20260001');
    // 业务化:机器态 statusCode 不再外露于进度模型
    expect(q.body.data.statusCode).toBeUndefined();
  });

  // ⑩b 公开查询进度模型(招新闭环优化 S1;评审稿 §4/§6):业务态 stage + 字典 stageText +
  //     门槛 todoList 真投影 + memberNo 恒 null(覆盖边界)。
  it('⑩b 公开查询进度模型:verified + 部分门槛 → stage/stageText/todoList 真投影', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-prog', idCardNumber: ID_MATCH_A }));
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-prog' },
    });
    // 落 2/5 门槛(直接落库,隔离验证查询投影;门槛标记本身另有测试)
    await prisma.recruitmentApplication.update({
      where: { id: row?.id },
      data: {
        thresholdMarks: {
          patrol1: { at: '2026-06-24T00:00:00.000Z', by: 'admin' },
          training: { at: '2026-06-24T00:00:00.000Z', by: 'admin' },
        },
      },
    });

    const q = await request(httpServer(app)).post(OPEN_QUERY).send({ wechatCode: 'code-prog' });
    expect(q.status).toBe(200);
    const d = q.body.data;
    expect(d.stage).toBe('threshold');
    expect(d.stageText).toBe('门槛未完成'); // 来自 recruitment_stage 字典
    expect(d.statusText).toBe('门槛未完成'); // S1:同 stageText
    expect(d.nextAction).toBe('complete-threshold');
    expect(d.identityText).toBe('报名申请人');
    expect(d.tempNo).toBe('T20260001');
    expect(d.memberNo).toBeNull(); // 覆盖边界:公开查询不可达 promoted 行
    // 门槛 todoList 真投影:5 项,done 来自实际标记
    const todoList = d.todoList as Array<{ code: string; name: string; done: boolean }>;
    expect(todoList).toHaveLength(5);
    const doneByCode: Record<string, boolean> = Object.fromEntries(
      todoList.map((i) => [i.code, i.done]),
    );
    expect(doneByCode.patrol1).toBe(true);
    expect(doneByCode.training).toBe(true);
    expect(doneByCode.patrol2).toBe(false);
    expect(doneByCode.redCross).toBe(false);
    expect(doneByCode.bsafe).toBe(false);
    expect(todoList.every((i) => i.name.length > 0)).toBe(true);
  });

  // ⑪ RBAC 边界:普通 USER 调 admin 列表 → 30100
  it('⑪ 普通 USER token 调 admin 报名列表 → 30100', async () => {
    const res = await request(httpServer(app)).get(ADMIN_APPS).set('Authorization', userAuth);
    expectBizError(res, BizCode.RBAC_FORBIDDEN);
  });

  // ===== OCR 改造:识别端点 + manual_review resolve + 容量原子(FM-C 沿用)=====
  // 注:OCR 改造退役 pending_verification 在途态与 FM-A 卡死恢复/守卫(报名 submit 单事务建终态,
  // 外部 OCR 在唯一事务之前,失败整体回滚无残留)——原 Ⓐ1-Ⓐ4 卡死系列随之删除。

  // OCR① 识别端点 mainland → ocrSupported + clarityOk + 回填姓名/证件号(供申请人确认)
  it('OCR① 识别端点 mainland → ocrSupported/clarityOk + 回填', async () => {
    await openCycle();
    const res = await recognize('mainland_id', {
      name: '张三',
      idCardNumber: ID_MATCH_A,
      clarity: true,
      warnings: [],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.ocrSupported).toBe(true);
    expect(res.body.data.clarityOk).toBe(true);
    expect(res.body.data.recognized.realName).toBe('张三');
    expect(res.body.data.recognized.idCardNumber).toBe(ID_MATCH_A);
  });

  // OCR② 识别端点 非 OCR 类型 → ocrSupported:false(前端转手填)
  it('OCR② 识别端点 非 OCR 类型(taiwan_permit)→ ocrSupported:false', async () => {
    await openCycle();
    const res = await recognize('taiwan_permit', { name: 'x', idCardNumber: 'T1234567' });
    expect(res.status).toBe(200);
    expect(res.body.data.ocrSupported).toBe(false);
    expect(res.body.data.recognized).toBeNull();
  });

  // OCR③ 识别端点 不清晰 → clarityOk:false(非错误,可继续提交转人工)
  it('OCR③ 识别端点 不清晰 → clarityOk:false', async () => {
    await openCycle();
    const res = await recognize('mainland_id', { clarity: false });
    expect(res.status).toBe(200);
    expect(res.body.data.ocrSupported).toBe(true);
    expect(res.body.data.clarityOk).toBe(false);
    expect(res.body.data.recognized).toBeNull();
  });

  // OCR④ 识别端点 无 open 轮 → 28030(省 OCR)
  it('OCR④ 识别端点 无 open 轮 → 28030', async () => {
    const res = await recognize('mainland_id', { name: '张三', idCardNumber: ID_MATCH_A });
    expectBizError(res, BizCode.RECRUITMENT_CYCLE_NOT_OPEN);
  });

  // Ⓜ manual_review(大陆 OCR 不匹配)→ 人工 resolve approve → verified + 发号
  // (人工是 manual_review 最终权威:看图后可放行真实申请人,「对不上转人工不误杀」)
  it('Ⓜ manual_review(OCR 不匹配)→ resolve approve → verified + 发号(人工最终权威)', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-mr', idCardNumber: ID_MATCH_A }), {
      ocr: { name: '李四', idCardNumber: ID_MATCH_A, clarity: true },
    });
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-mr' },
    });
    expect(row?.statusCode).toBe('manual_review');
    const res = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${row?.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: true, reviewNote: '看图核实为本人,放行' });
    expect(res.status).toBe(200);
    expect(res.body.data.statusCode).toBe('verified');
    expect(res.body.data.tempNo).toBe('T20260001');
  });

  // Ⓜb manual_review → 人工 resolve reject → rejected(eliminationStage=manual)
  it('Ⓜb manual_review → resolve reject → rejected(eliminationStage=manual)', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-mr2', idCardNumber: ID_MATCH_A }), {
      ocr: { name: '李四', idCardNumber: ID_MATCH_A, clarity: true },
    });
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-mr2' },
    });
    const res = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${row?.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: false });
    expect(res.status).toBe(200);
    expect(res.body.data.statusCode).toBe('rejected');
    expect(res.body.data.eliminationStage).toBe('manual');
  });

  // FM-C(沿用):容量满时 manual_review resolve approve 也被发号事务原子挡(28031);自增回滚;reject 不受限。
  // manual_review 行直接造(容量满时 submit 在容量预检即 28031,无法经 submit 建);issueTempNo 容量校验仍兜底。
  it('Ⓒ 容量满 → manual_review resolve approve 也 28031(发号原子校验 + tempNoSeq 回滚);reject 仍可', async () => {
    const cycle = await openCycle({ capacity: 1 });
    // 占满容量:一条 matched 报名 → verified + T20260001(tempNoSeq=1)
    await submit(validPayload({ wechatCode: 'code-cap1', idCardNumber: ID_MATCH_A }));
    const manual = await prisma.recruitmentApplication.create({
      data: {
        cycleId: cycle.id,
        statusCode: 'manual_review',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: '钱七',
        idCardNumber: ID_MATCH_B,
        phone: '13900000011',
        verifyOutcome: 'mismatch',
      },
    });
    const res = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${manual.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: true });
    expectBizError(res, BizCode.RECRUITMENT_CYCLE_CAPACITY_FULL);
    // 行未被发号;cycle.tempNoSeq 因事务回滚保持 1(无超发)
    const after = await prisma.recruitmentApplication.findUnique({ where: { id: manual.id } });
    expect(after?.statusCode).toBe('manual_review');
    expect(after?.tempNo).toBeNull();
    const c = await prisma.recruitmentCycle.findUnique({ where: { id: cycle.id } });
    expect(c?.tempNoSeq).toBe(1);
    // reject 不受容量限,manual_review 始终可被拒
    const rej = await request(httpServer(app))
      .post(`${ADMIN_APPS}/${manual.id}/resolve`)
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

    // 非法态:非 verified/pending_evaluation 报名标门槛 → 28041(OCR 改造:用 manual_review 行,经 OCR 不匹配造)
    const mm = await submit(validPayload({ wechatCode: 'p2-2b', idCardNumber: ID_MISMATCH }), {
      ocr: { name: '别人', idCardNumber: ID_MISMATCH, clarity: true },
    });
    expect(mm.body.data.statusCode).toBe('manual_review');
    const nonVerified = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-p2-2b' },
    });
    expectBizError(
      await markThreshold(nonVerified.id, 'patrol1', true),
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

  // =====================================================================
  // 招新二期(招新后段)T3:一键发号(建 User+Member;最重一刀)
  // (评审稿 D-R2-5/6 + §4 流程冻结 + §8 DoD)
  // =====================================================================

  async function toPublicity(code: string, idCard: string, name: string) {
    const a = await submitVerified(code, idCard, name);
    await markAll(a.id);
    await evaluate(a.id, true);
    return a;
  }
  function promote(cycleId: string, auth = adminAuth) {
    return request(httpServer(app))
      .post(`${ADMIN_CYCLES}/${cycleId}/promote`)
      .set('Authorization', auth)
      .send({});
  }

  it('㉖(二期) 一键发号:公示→建 User+Member+档案+紧急联系人;{YY}{NNN} 拼音序;两层身份(无部门无级别);报名敏感清', async () => {
    const cycle = await openCycle();
    const membersBefore = await prisma.member.count();
    await toPublicity('p3-z', ID_MATCH_A, '张三'); // zhang
    await toPublicity('p3-l', ID_MATCH_B, '李四'); // li
    await toPublicity('p3-w', ID_MATCH_C, '王五'); // wang

    const res = await promote(cycle.id);
    expect(res.status).toBe(200);
    expect(res.body.data.promotedCount).toBe(3);
    expect(res.body.data.skippedCount).toBe(0);
    // 拼音序:李四 26001 / 王五 26002 / 张三 26003
    expect(
      res.body.data.promoted.map((p: { realName: string; memberNo: string }) => [
        p.realName,
        p.memberNo,
      ]),
    ).toEqual([
      ['李四', '26001'],
      ['王五', '26002'],
      ['张三', '26003'],
    ]);

    expect(await prisma.member.count()).toBe(membersBefore + 3);
    const li = await prisma.member.findFirstOrThrow({
      where: { memberNo: '26001' },
      include: {
        user: true,
        memberProfile: true,
        emergencyContacts: true,
        memberDepartments: true,
      },
    });
    // 两层身份铁律:无级别、无部门
    expect(li.gradeCode).toBeNull();
    expect(li.memberDepartments.length).toBe(0);
    expect(li.displayName).toBe('李四');
    // wrinkle③ User:openid 绑定、username=memberNo、passwordHash 非空(密码登录天然关闭)、memberId 回链
    expect(li.user?.openid).toBe('dev-openid-p3-l');
    expect(li.user?.username).toBe('26001');
    expect(li.user?.passwordHash).toBeTruthy();
    expect(li.user?.memberId).toBe(li.id);
    // MemberProfile 映射 + email null(M-1)+ 证件照搬入(wrinkle①)
    expect(li.memberProfile?.realName).toBe('李四');
    expect(li.memberProfile?.documentNumber).toBe(ID_MATCH_B);
    expect(li.memberProfile?.mobile).toBe('13900000001');
    expect(li.memberProfile?.email).toBeNull();
    expect(li.memberProfile?.joinSourceCode).toBe('recruitment');
    expect(li.memberProfile?.privacyConsentSigned).toBe(true);
    expect(li.memberProfile?.idCardImageKey).toBeTruthy();
    // 紧急联系人迁移(2 个,priority 0/1)
    expect(li.emergencyContacts.length).toBe(2);
    // 报名行:promoted + 链 + 敏感清 + blob 归 member + 脱敏统计留存
    // (F12#399 后 openid 已即时清,改用 promotedMemberId 定位本行)
    const liApp = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { promotedMemberId: li.id },
    });
    expect(liApp.statusCode).toBe('promoted');
    expect(liApp.promotedMemberId).toBe(li.id);
    expect(liApp.realName).toBeNull();
    expect(liApp.idCardNumber).toBeNull();
    expect(liApp.idCardImageKey).toBeNull();
    expect(liApp.openid).toBeNull(); // F12(#399):openid 一并即时清
    expect(liApp.reviewNote).toBeNull(); // F12(#399):reviewNote 一并即时清
    expect(liApp.sensitivePurgedAt).toBeTruthy();
    expect(liApp.cityDistrict).toBe('北京市朝阳区'); // 脱敏统计永久留存
    // cycle.memberNoSeq 自增到 3
    const cy = await prisma.recruitmentCycle.findFirstOrThrow({ where: { id: cycle.id } });
    expect(cy.memberNoSeq).toBe(3);
  });

  // F3(#399):relation 字典校验 = 报名侧(主入口,提交即拒)+ promote 侧(defense-in-depth)双层一致。
  it('㉖b(二期 F3) 报名侧:emergencyContacts.relation 非字典码 → 提交即拒 19010(报名不落库,不会卡 promote)', async () => {
    await openCycle();
    // 首位 relation 为非字典码(历史 label '父亲' 即此类漏网);报名侧现即拒,不让其进入 publicity
    const res = await submit(
      validPayload({
        wechatCode: 'p3-badsubmit',
        idCardNumber: ID_MATCH_A,
        realName: '赵六',
        emergencyContacts: [
          { name: '钱七', relation: 'not-a-relation', phone: '13900000009' },
          { name: '孙八', relation: 'parent', phone: '13900000010' },
        ],
      }),
    );
    expectBizError(res, BizCode.EMERGENCY_CONTACT_RELATION_CODE_INVALID);
    // fail-fast 在 tx1 前 → 报名未落库
    expect(
      await prisma.recruitmentApplication.count({ where: { openid: 'dev-openid-p3-badsubmit' } }),
    ).toBe(0);
  });

  it('㉖c(二期 F3) promote 侧 defense-in-depth:报名后 relation 失效(字典停用/数据修订)→ promote 19010 + 整批回滚', async () => {
    const cycle = await openCycle();
    // 合法 relation 提交 → 驱到 publicity
    const a = await toPublicity('p3-defense', ID_MATCH_A, '赵六');
    // 模拟「提交后 relation 失效」(报名侧通过、之后字典项停用或数据被改):直接改报名 JSON 为非字典码
    await prisma.recruitmentApplication.update({
      where: { id: a.id },
      data: {
        emergencyContacts: [
          { name: '钱七', relation: 'not-a-relation', phone: '13900000009' },
          { name: '孙八', relation: 'parent', phone: '13900000010' },
        ],
      },
    });
    const membersBefore = await prisma.member.count();

    // promote 复用同一 canonical 校验 → 19010,单事务整批回滚
    const res = await promote(cycle.id);
    expectBizError(res, BizCode.EMERGENCY_CONTACT_RELATION_CODE_INVALID);
    expect(await prisma.member.count()).toBe(membersBefore);
    const after = await prisma.recruitmentApplication.findFirstOrThrow({ where: { id: a.id } });
    expect(after.statusCode).toBe('publicity');
    expect(after.promotedMemberId).toBeNull();
  });

  it('㉗(二期) 幂等:重跑 promote 命中 0(promoted 已离开 publicity);同报名不重复建 Member', async () => {
    const cycle = await openCycle();
    await toPublicity('p3i-a', ID_MATCH_A, '陈一');
    const first = await promote(cycle.id);
    expect(first.body.data.promotedCount).toBe(1);
    const membersAfterFirst = await prisma.member.count();

    const second = await promote(cycle.id);
    expect(second.body.data.promotedCount).toBe(0);
    expect(second.body.data.skippedCount).toBe(0);
    expect(await prisma.member.count()).toBe(membersAfterFirst); // 不重复建
  });

  it('㉘(二期) 外籍 skip+report:不进一键发号(foreign-manual-build)、不建 Member、仍 publicity;大陆照常发', async () => {
    const cycle = await openCycle();
    const fs = await submit(
      validPayload({
        wechatCode: 'p3f-f',
        documentTypeCode: 'passport',
        idCardNumber: 'E99887766',
        realName: '周吴',
      }),
    );
    expect(fs.body.data.statusCode).toBe('manual_review');
    const foreign = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-p3f-f' },
    });
    await request(httpServer(app))
      .post(`${ADMIN_APPS2}/${foreign.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: true });
    await markAll(foreign.id);
    await evaluate(foreign.id, true);
    await toPublicity('p3f-m', ID_MATCH_A, '王五');
    const membersBefore = await prisma.member.count();

    const res = await promote(cycle.id);
    expect(res.body.data.promotedCount).toBe(1); // 仅大陆
    expect(res.body.data.skippedCount).toBe(1);
    expect(res.body.data.skipped[0]).toMatchObject({ reason: 'foreign-manual-build' });
    expect(await prisma.member.count()).toBe(membersBefore + 1); // 外籍未建 Member
    const fa = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-p3f-f' },
    });
    expect(fa.statusCode).toBe('publicity'); // 仍 publicity,待 admin 手动建档
    expect(fa.promotedMemberId).toBeNull();
  });

  it('㉙(二期) 空公示集→零发;撞 999 上限→28043(整批回滚:seq 复位、报名仍 publicity、零 Member)', async () => {
    const cycle = await openCycle();
    const empty = await promote(cycle.id);
    expect(empty.body.data.promotedCount).toBe(0);

    // 把 memberNoSeq 顶到 999,再发 1 → 1000 > 999 → 28043
    await prisma.recruitmentCycle.update({ where: { id: cycle.id }, data: { memberNoSeq: 999 } });
    await toPublicity('p3x-a', ID_MATCH_A, '赵敏');
    const membersBefore = await prisma.member.count();
    expectBizError(await promote(cycle.id), BizCode.RECRUITMENT_MEMBER_NO_EXHAUSTED);
    // 整批回滚:seq 复位 999、零 Member、报名仍 publicity
    const cy = await prisma.recruitmentCycle.findFirstOrThrow({ where: { id: cycle.id } });
    expect(cy.memberNoSeq).toBe(999);
    expect(await prisma.member.count()).toBe(membersBefore);
    const za = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-p3x-a' },
    });
    expect(za.statusCode).toBe('publicity');
  });

  it('㉚(二期) promote RBAC:USER → forbidden;轮次不存在 → 28001', async () => {
    const cycle = await openCycle();
    expectBizError(await promote(cycle.id, userAuth), BizCode.RBAC_FORBIDDEN);
    expectBizError(await promote('nonexistent-cycle-id'), BizCode.RECRUITMENT_CYCLE_NOT_FOUND);
  });

  // ㉛ 超时硬化(B 档):bcrypt 移出事务后,大批量一键发号不被事务超时顶死。
  // 不依赖计时(避免 flaky):直接造 ≥20 个 publicity 报名 → 一键发号 → 断言号段连续无空洞、全部成功。
  it('㉛(二期·硬化) 批量发号 ≥20:号段 26001..26025 连续无空洞、全部建 User+Member 成功', async () => {
    const cycle = await openCycle();
    const N = 25;
    // 直接造 publicity 报名(绕开提交链路;字段满足 isPromotable + promote 逐字段读取需要)。
    // 已是 phase-1 ㉙ 用例既有手法(直接 prisma 操纵 cycle/报名)。
    const rows = Array.from({ length: N }, (_, i) => ({
      cycleId: cycle.id,
      statusCode: 'publicity',
      documentTypeCode: 'mainland_id',
      isForeigner: false,
      openid: `batch-openid-${i}`,
      realName: `批量报名${String(i).padStart(2, '0')}`,
      genderCode: i % 2 === 0 ? 'male' : 'female',
      birthDate: new Date('1995-03-07T00:00:00.000Z'),
      idCardNumber: `BATCHID${String(i).padStart(4, '0')}`,
      phone: `139000${String(i).padStart(5, '0')}`,
    }));
    await prisma.recruitmentApplication.createMany({ data: rows });
    const membersBefore = await prisma.member.count();

    const res = await promote(cycle.id);
    expect(res.status).toBe(200);
    expect(res.body.data.promotedCount).toBe(N);
    expect(res.body.data.skippedCount).toBe(0);

    // 号段连续无空洞:N 个永久编号恰为 26001..26025(同长定宽 → 字典序=数值序)
    const nos = res.body.data.promoted.map((p: { memberNo: string }) => p.memberNo).sort();
    const expected = Array.from({ length: N }, (_, i) => `26${String(i + 1).padStart(3, '0')}`);
    expect(nos).toEqual(expected);

    // 全部成功落库:N 个 Member、N 个绑定 openid 的 User(passwordHash 取自事务前预算)、cycle 自增到 N
    expect(await prisma.member.count()).toBe(membersBefore + N);
    expect(await prisma.user.count({ where: { memberId: { not: null } } })).toBe(N);
    const cy = await prisma.recruitmentCycle.findFirstOrThrow({ where: { id: cycle.id } });
    expect(cy.memberNoSeq).toBe(N);
  });

  // =====================================================================
  // #399 P3 promote 健壮批(F12 即时清漏 / F15 批内 openid 去重 / F9 公示口径分叉)
  // 直接造 publicity 报名(沿 ㉛ 手法,绕开提交链路)
  // =====================================================================

  function publicityRow(over: Record<string, unknown>) {
    return {
      cycleId: '', // 调用处填
      statusCode: 'publicity',
      documentTypeCode: 'mainland_id',
      isForeigner: false,
      genderCode: 'male',
      birthDate: new Date('1995-03-07T00:00:00.000Z'),
      phone: '13900000000',
      ...over,
    };
  }

  it('㉜(二期 F12) promote 即时清:promoted 行 openid + reviewNote 一并置 NULL(留存 SOP 跳过 promoted 行的前提)', async () => {
    const cycle = await openCycle();
    await prisma.recruitmentApplication.createMany({
      data: [
        publicityRow({
          cycleId: cycle.id,
          openid: 'f12-openid',
          realName: '周九',
          idCardNumber: 'F12ID0001',
          reviewNote: '人工核验备注(含可识别信息)',
        }),
      ],
    });
    const res = await promote(cycle.id);
    expect(res.body.data.promotedCount).toBe(1);
    const appId = res.body.data.promoted[0].applicationId as string;
    const row = await prisma.recruitmentApplication.findFirstOrThrow({ where: { id: appId } });
    expect(row.statusCode).toBe('promoted');
    expect(row.sensitivePurgedAt).toBeTruthy();
    // F12:两再识别字段亦清(原先漏清 → 在 sensitivePurgedAt 已置行被 SOP 永久跳过、永久残留)
    expect(row.openid).toBeNull();
    expect(row.reviewNote).toBeNull();
    // 既有即时清字段一并复核(零行为漂移)
    expect(row.realName).toBeNull();
    expect(row.idCardNumber).toBeNull();
  });

  it('㉝(二期 F15) 同批共享 openid:仅发号序首行发号、次行 skip(duplicate-openid-in-batch),不整批回滚零发号', async () => {
    const cycle = await openCycle();
    const membersBefore = await prisma.member.count();
    // 两行共享 openid 'f15-dup' + 一行独立;原先第二行入事务撞 User.openid @unique → P2002 → 整批回滚
    await prisma.recruitmentApplication.createMany({
      data: [
        publicityRow({
          cycleId: cycle.id,
          openid: 'f15-dup',
          realName: '钱一',
          idCardNumber: 'F15ID0001',
        }),
        publicityRow({
          cycleId: cycle.id,
          openid: 'f15-dup',
          realName: '钱二',
          idCardNumber: 'F15ID0002',
        }),
        publicityRow({
          cycleId: cycle.id,
          openid: 'f15-uniq',
          realName: '孙三',
          idCardNumber: 'F15ID0003',
        }),
      ],
    });
    const res = await promote(cycle.id);
    expect(res.status).toBe(200);
    // 去重后 2 发号(共享 openid 仅发号序首行)+ 1 skip;不整批回滚(否则 promotedCount=0)
    expect(res.body.data.promotedCount).toBe(2);
    expect(res.body.data.skippedCount).toBe(1);
    expect(res.body.data.skipped[0]).toMatchObject({ reason: 'duplicate-openid-in-batch' });
    expect(await prisma.member.count()).toBe(membersBefore + 2);
    // 共享 openid 仅一个 User 持有(@unique 未被撞)
    expect(await prisma.user.count({ where: { openid: 'f15-dup' } })).toBe(1);
  });

  it('㉞(二期 F9) 公示预览 = 实发:openid 已被既有 User 占用的行 needsManualBuild + 不占号,其余拟发号与 promote 实发一致', async () => {
    const cycle = await openCycle();
    // 既有 User 占用某 openid(模拟该报名者 openid 已绑定既有账号 → promote 会 skip)
    await prisma.user.create({
      data: {
        username: 'f9-bound-user',
        passwordHash: 'x',
        role: 'USER',
        openid: 'f9-bound-openid',
      },
    });
    // 拼音序:李四(li)< 王五(wang,openid 占用)< 张三(zhang)
    await prisma.recruitmentApplication.createMany({
      data: [
        publicityRow({
          cycleId: cycle.id,
          openid: 'f9-openid-li',
          realName: '李四',
          idCardNumber: 'F9ID0001',
        }),
        publicityRow({
          cycleId: cycle.id,
          openid: 'f9-bound-openid',
          realName: '王五',
          idCardNumber: 'F9ID0002',
        }),
        publicityRow({
          cycleId: cycle.id,
          openid: 'f9-openid-zhang',
          realName: '张三',
          idCardNumber: 'F9ID0003',
        }),
      ],
    });
    // 公示预览:王五(openid 占用)needsManualBuild + null;李四 26001 / 张三 26002(王五不占号、无偏移)
    const pv = await request(httpServer(app))
      .get(`${ADMIN_CYCLES}/${cycle.id}/publicity-list`)
      .set('Authorization', adminAuth);
    expect(pv.status).toBe(200);
    expect(pv.body.data.promotableCount).toBe(2);
    expect(pv.body.data.items[0]).toMatchObject({
      realName: '李四',
      needsManualBuild: false,
      proposedMemberNo: '26001',
    });
    expect(pv.body.data.items[1]).toMatchObject({
      realName: '王五',
      needsManualBuild: true,
      proposedMemberNo: null,
    });
    expect(pv.body.data.items[2]).toMatchObject({
      realName: '张三',
      needsManualBuild: false,
      proposedMemberNo: '26002',
    });
    // 实发 = 预览:李四 26001 / 张三 26002;王五 skip(openid-already-bound)
    const res = await promote(cycle.id);
    expect(res.body.data.promotedCount).toBe(2);
    expect(res.body.data.skippedCount).toBe(1);
    expect(res.body.data.skipped[0]).toMatchObject({ reason: 'openid-already-bound' });
    expect(
      res.body.data.promoted.map((p: { realName: string; memberNo: string }) => [
        p.realName,
        p.memberNo,
      ]),
    ).toEqual([
      ['李四', '26001'],
      ['张三', '26002'],
    ]);
  });

  // =====================================================================
  // 招新闭环优化 S2:招新工作台聚合 stats(冻结评审稿 recruitment-phase4-loop-optimization-review.md §7.1)
  //   GET admin/v1/recruitment/cycles/:id/stats —— 五组计数走真实 DB + Prisma + controller;
  //   计数与 stage 派生同源(S1 deriveRecruitmentStage)、发号预判复用 decidePromotionIssuance。
  // =====================================================================
  it('㉕(S2) 工作台 stats:五组计数正确(多态夹具,真实库)', async () => {
    const cycle = await prisma.recruitmentCycle.create({
      data: { year: 2027, name: '2027 stats 夹具轮', statusCode: 'closed' },
    });
    const OLD = new Date('2020-01-01T00:00:00.000Z');
    const TODAY = new Date(); // 与 controller new Date() 同北京日(midnight 临界忽略,沿仓内 date 测试惯例)
    const at = '2026-06-10T00:00:00.000Z';
    await prisma.recruitmentApplication.createMany({
      data: [
        // 待人工 ×3:system(ocr_error)/ high(forgery_warning)/ normal(mismatch);前二条 createdAt=今日
        {
          cycleId: cycle.id,
          statusCode: 'manual_review',
          documentTypeCode: 'mainland_id',
          verifyOutcome: 'ocr_error',
          createdAt: TODAY,
          realName: '系统一',
        },
        {
          cycleId: cycle.id,
          statusCode: 'manual_review',
          documentTypeCode: 'mainland_id',
          verifyOutcome: 'forgery_warning',
          createdAt: TODAY,
          realName: '高危一',
        },
        {
          cycleId: cycle.id,
          statusCode: 'manual_review',
          documentTypeCode: 'mainland_id',
          verifyOutcome: 'mismatch',
          createdAt: OLD,
          reviewedAt: TODAY,
          realName: '普通一',
        },
        // 门槛跟踪中 ×1(verified + 未齐;verifiedAt=今日)
        {
          cycleId: cycle.id,
          statusCode: 'verified',
          documentTypeCode: 'mainland_id',
          createdAt: OLD,
          verifiedAt: TODAY,
          thresholdMarks: { patrol1: { at, by: 'u1' }, patrol2: { at, by: 'u1' } },
          realName: '门槛一',
        },
        // 待综合评定 ×1
        {
          cycleId: cycle.id,
          statusCode: 'pending_evaluation',
          documentTypeCode: 'mainland_id',
          createdAt: OLD,
          realName: '评定一',
        },
        // 公示 ×3:甲/乙 大陆可发号、丙 外籍需手动建档
        {
          cycleId: cycle.id,
          statusCode: 'publicity',
          documentTypeCode: 'mainland_id',
          isForeigner: false,
          birthDate: new Date('1995-03-07T00:00:00.000Z'),
          genderCode: 'male',
          openid: 'stat-oa',
          realName: '公示甲',
          createdAt: OLD,
        },
        {
          cycleId: cycle.id,
          statusCode: 'publicity',
          documentTypeCode: 'mainland_id',
          isForeigner: false,
          birthDate: new Date('1995-03-07T00:00:00.000Z'),
          genderCode: 'female',
          openid: 'stat-ob',
          realName: '公示乙',
          createdAt: OLD,
        },
        {
          cycleId: cycle.id,
          statusCode: 'publicity',
          documentTypeCode: 'passport',
          isForeigner: true,
          openid: 'stat-oc',
          realName: '公示丙',
          createdAt: OLD,
        },
        // 已发号 ×1(promotedMemberId 无 FK,任意串)
        {
          cycleId: cycle.id,
          statusCode: 'promoted',
          documentTypeCode: 'mainland_id',
          promotedMemberId: 'stat-fake-mem',
          createdAt: OLD,
          realName: '已号一',
        },
        // 评定淘汰 ×1(rejected + eliminationStage=evaluation)
        {
          cycleId: cycle.id,
          statusCode: 'rejected',
          documentTypeCode: 'mainland_id',
          eliminationStage: 'evaluation',
          createdAt: OLD,
          realName: '淘汰一',
        },
      ],
    });

    const res = await request(httpServer(app))
      .get(`${ADMIN_CYCLES}/${cycle.id}/stats`)
      .set('Authorization', adminAuth);
    expect(res.status).toBe(200);
    expect(res.body.data.cycleId).toBe(cycle.id);
    expect(res.body.data.cycleYear).toBe(2027);
    expect(res.body.data.today).toEqual({
      newApplications: 2,
      tempNoIssued: 1,
      manualProcessed: 1,
    });
    expect(res.body.data.pending).toEqual({
      manualTotal: 3,
      manualNormal: 1,
      manualHigh: 1,
      manualSystem: 1,
      pendingEvaluation: 1,
      pendingIssuance: 3,
    });
    expect(res.body.data.threshold).toEqual({
      tracking: 1,
      byThreshold: [
        { code: 'patrol1', name: '巡山一', completedCount: 1 },
        { code: 'patrol2', name: '巡山二', completedCount: 1 },
        { code: 'training', name: '培训', completedCount: 0 },
        { code: 'redCross', name: '红十字', completedCount: 0 },
        { code: 'bsafe', name: 'BSAFE', completedCount: 0 },
      ],
    });
    expect(res.body.data.evaluation).toEqual({ pending: 1, passed: 3, eliminated: 1 });
    expect(res.body.data.issuance).toEqual({
      inPublicity: 3,
      oneClickIssuable: 2,
      needManualBuild: 1,
      promoted: 1,
    });
  });

  it('㉖(S2) 工作台 stats:普通 USER 无 read.record → 403 RBAC_FORBIDDEN', async () => {
    const cycle = await prisma.recruitmentCycle.create({
      data: { year: 2027, name: '2027 stats rbac 轮', statusCode: 'closed' },
    });
    const res = await request(httpServer(app))
      .get(`${ADMIN_CYCLES}/${cycle.id}/stats`)
      .set('Authorization', userAuth);
    expectBizError(res, BizCode.RBAC_FORBIDDEN);
  });

  it('㉗(S2) 工作台 stats:轮次不存在 → 28001', async () => {
    const res = await request(httpServer(app))
      .get(`${ADMIN_CYCLES}/non-existent-cycle/stats`)
      .set('Authorization', adminAuth);
    expectBizError(res, BizCode.RECRUITMENT_CYCLE_NOT_FOUND);
  });
});
