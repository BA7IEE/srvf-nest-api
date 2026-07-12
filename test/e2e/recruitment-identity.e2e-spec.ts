import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { RealnameSettingsService } from '../../src/modules/realname/realname-settings.service';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 招新四期 S4a(H5 + 手机身份链)e2e:发码 → 验码发 token → H5 报名提交 → 手机查询② → 自助换绑;
// + token 一次性失效 + 小程序链向后兼容 + 容量/去重不被会话行影响(冻结评审稿
// docs/archive/reviews/recruitment-phase4-loop-optimization-review.md §3)。
//
// DevStub 三通道:wechat code2session → openid=`dev-openid-<code>`;realname OCR 回显图信封;
// SMS DEV_STUB 固定码 888888。报名前会话表 recruitment_identity_sessions 承载 token。

const SEND = '/api/open/v1/recruitment/identity/send-code';
const VERIFY = '/api/open/v1/recruitment/identity/verify-code';
const SUBMIT = '/api/open/v1/recruitment/applications';
const QUERY_WECHAT = '/api/open/v1/recruitment/applications/query';
const QUERY_PHONE = '/api/open/v1/recruitment/applications/query-by-phone';
const REBIND_WECHAT = '/api/open/v1/recruitment/applications/rebind-wechat';
const REBIND_PHONE = '/api/open/v1/recruitment/applications/rebind-phone';

const FIXED_CODE = '888888';
const ID_A = '110101199003070038'; // 有效校验位大陆身份证
const ID_B = '110101199003070046';

describe('招新四期 S4a(H5 + 手机身份链)e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  function basePayload(phone: string, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      realName: '张三',
      idCardNumber: ID_A,
      documentTypeCode: 'mainland_id',
      phone,
      detailedAddress: '北京市朝阳区某街道 1 号院 2 单元',
      cityDistrict: '北京市朝阳区',
      sourceChannel: 'offline_qr',
      emergencyContacts: [
        { name: '李四', relation: 'parent', phone: '13900000002' },
        { name: '王五', relation: 'family', phone: '13900000003' },
      ],
      privacyConsentAccepted: true, // F5 契约收紧:submit 必填(fixture 缺省即真)
      ...over,
    };
  }

  // multipart 提交;payload JSON 串 + idCardImage(DevStub OCR 信封,默认与 payload 一致=matched)
  function submit(payload: Record<string, unknown>, ocr?: Record<string, unknown>): request.Test {
    const envelope = ocr ?? {
      name: payload.realName,
      idCardNumber: payload.idCardNumber,
      clarity: true,
      warnings: [],
    };
    return request(httpServer(app))
      .post(SUBMIT)
      .field('payload', JSON.stringify(payload))
      .attach('idCardImage', Buffer.from(JSON.stringify(envelope)), {
        filename: 'id.jpg',
        contentType: 'image/jpeg',
      });
  }

  async function sendCode(phone: string): Promise<void> {
    await request(httpServer(app)).post(SEND).send({ phone }).expect(200);
  }

  // 发码 + 验码 → 取 H5 身份令牌(一次性)
  async function getToken(phone: string): Promise<string> {
    await sendCode(phone);
    const res = await request(httpServer(app)).post(VERIFY).send({ phone, code: FIXED_CODE });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    return res.body.data.phoneVerificationToken as string;
  }

  function openCycle(over: Record<string, unknown> = {}) {
    return prisma.recruitmentCycle.create({
      data: { year: 2026, name: '2026 年度招新', statusCode: 'open', ...over },
    });
  }

  // 直接落一条活跃报名(隔离 rebind/query 链与 SMS 60s 间隔耦合;不走完整提交链)
  function seedApp(cycleId: string, over: Record<string, unknown> = {}) {
    return prisma.recruitmentApplication.create({
      data: {
        cycleId,
        statusCode: 'verified',
        tempNo: 'T20260001',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: '张三',
        idCardNumber: ID_A,
        phone: '13900000001',
        openid: 'dev-openid-seed',
        ...over,
      },
    });
  }

  beforeAll(async () => {
    process.env.RECRUITMENT_THROTTLE_LIMIT = '100'; // 配额上限(评审稿 max 100);全链测试不触 IP 限流
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

    // 三 DevStub 通道
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prisma.realnameVerificationSettings.create({
      data: { providerType: 'DEV_STUB', enabled: true },
    });

    // emergency_relation 字典(报名 emergencyContacts.relation 校验)
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

    // recruitment_stage 字典(进度模型 stageText 来源)
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
        // S4b 会话态 / 风险态(manual_high 申请人侧文案中性同 manual)
        { typeId: stageType.id, code: 'retake', label: '待重拍', sortOrder: 7 },
        { typeId: stageType.id, code: 'confirm', label: '待核对', sortOrder: 8 },
        { typeId: stageType.id, code: 'manual_high', label: '待人工核验', sortOrder: 9 },
        { typeId: stageType.id, code: 'withdrawn', label: '已撤销报名', sortOrder: 10 },
      ],
    });
  });

  afterAll(async () => {
    delete process.env.RECRUITMENT_THROTTLE_LIMIT;
    await app.close();
  });

  beforeEach(async () => {
    await prisma.recruitmentIdentitySession.deleteMany({});
    await prisma.smsVerificationCode.deleteMany({});
    await prisma.smsSendLog.deleteMany({});
    await prisma.recruitmentApplication.deleteMany({});
    await prisma.recruitmentCycle.deleteMany({});
    // F1:OCR 日封顶按 IP 持久计数 —— 每测清零,防同文件多测累计打满 30 上限误伤无关用例。
    await prisma.recruitmentOcrDailyCounter.deleteMany({});
    await prisma.auditLog.deleteMany({});
  });

  // ============ 发码 / 验码 ============

  // F4 行为变更翻面(评审稿 §2.3;goal ⚠️ 列明):原「无 open 轮 → 28030」改为防枚举泛化 200
  // (闭轮陌生手机与真发码路径不可区分;省发码语义保留 = 零 code 行)。命中报名者的放行见 F4-a。
  it('① 无 open 轮 + 无报名命中 → send-code 防枚举泛化 200(原 28030;F4 行为变更)', async () => {
    const res = await request(httpServer(app)).post(SEND).send({ phone: '13900000001' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toEqual({ expiresInSeconds: 300 });
    expect(await prisma.smsVerificationCode.count()).toBe(0); // 不真发码(省发码)
  });

  it('② 发码 200 + 验码 → 发 token(落会话行;明文 token 仅返一次)', async () => {
    await openCycle();
    await sendCode('13900000001');
    const res = await request(httpServer(app))
      .post(VERIFY)
      .send({ phone: '13900000001', code: FIXED_CODE });
    expect(res.status).toBe(200);
    expect(res.body.data.phoneVerificationToken).toEqual(expect.any(String));
    expect(res.body.data.phoneVerificationToken.length).toBeGreaterThanOrEqual(32);
    expect(res.body.data.expiresAt).toEqual(expect.any(String));

    // 会话行落库:phone + 验证时刻 + method=sms;token 入库只存 hash(明文不入库)
    const sess = await prisma.recruitmentIdentitySession.findFirst({
      where: { phone: '13900000001' },
    });
    expect(sess?.phoneVerificationMethod).toBe('sms');
    expect(sess?.phoneVerifiedAt).not.toBeNull();
    expect(sess?.consumedAt).toBeNull();
    expect(sess?.phoneVerificationTokenHash).not.toBe(res.body.data.phoneVerificationToken); // 存 hash 非明文
  });

  it('③ 验码错码 → 统一 24010(防枚举)', async () => {
    await openCycle();
    await sendCode('13900000001');
    const res = await request(httpServer(app))
      .post(VERIFY)
      .send({ phone: '13900000001', code: '000000' });
    expectBizError(res, BizCode.SMS_CODE_INVALID);
  });

  // ============ H5 报名全链 ============

  it('④ H5 全链:send → verify → submit(token,无 wechatCode)→ verified + phoneVerifiedAt + openid 空', async () => {
    await openCycle();
    const phone = '13900000001';
    const token = await getToken(phone);
    const res = await submit(basePayload(phone, { phoneVerificationToken: token }));

    expect(res.status).toBe(201);
    expect(res.body.data.statusCode).toBe('verified');
    expect(res.body.data.tempNo).toBe('T20260001');

    const row = await prisma.recruitmentApplication.findFirst({ where: { phone } });
    expect(row?.openid).toBeNull(); // 纯 H5 无微信
    expect(row?.phoneVerifiedAt).not.toBeNull();
    expect(row?.phoneVerificationMethod).toBe('sms');
    // 会话行已消费(一次性)
    const sess = await prisma.recruitmentIdentitySession.findFirst({ where: { phone } });
    expect(sess?.consumedAt).not.toBeNull();
  });

  it('⑤ token 一次性:同 token 二次 submit → 28050(会话已消费)', async () => {
    await openCycle();
    const phone = '13900000001';
    const token = await getToken(phone);
    await submit(basePayload(phone, { phoneVerificationToken: token })).expect(201);

    // 同 token 再报(换证件号免撞去重,撞的是 token 一次性)
    const res = await submit(
      basePayload(phone, { phoneVerificationToken: token, idCardNumber: ID_B }),
    );
    expectBizError(res, BizCode.RECRUITMENT_IDENTITY_SESSION_INVALID);
  });

  it('⑥ submit 缺凭证(无 wechatCode 无 token)→ 40000', async () => {
    await openCycle();
    const res = await submit(basePayload('13900000001'));
    expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
  });

  it('⑦ submit token 手机与提交不一致 → 40000(防「验 A 号 token 报 B 号」)', async () => {
    await openCycle();
    const token = await getToken('13900000001');
    const res = await submit(basePayload('13900000009', { phoneVerificationToken: token }));
    expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
  });

  it('⑧ submit 伪造 token → 28050', async () => {
    await openCycle();
    const res = await submit(
      basePayload('13900000001', { phoneVerificationToken: 'deadbeef'.repeat(8) }),
    );
    expectBizError(res, BizCode.RECRUITMENT_IDENTITY_SESSION_INVALID);
  });

  // ============ 查询②:手机 + 验证码 ============

  it('⑨ 查询②:手机+验证码 → 本人进度模型(stage/stageText/todoList)', async () => {
    const cycle = await openCycle();
    await seedApp(cycle.id, { phone: '13900000001', statusCode: 'verified' });
    await sendCode('13900000001');
    const res = await request(httpServer(app))
      .post(QUERY_PHONE)
      .send({ phone: '13900000001', code: FIXED_CODE });
    expect(res.status).toBe(200);
    expect(res.body.data.stage).toBe('threshold'); // verified + 门槛未齐
    expect(res.body.data.stageText).toBe('门槛未完成');
    expect(res.body.data.tempNo).toBe('T20260001');
    expect(Array.isArray(res.body.data.todoList)).toBe(true);
  });

  it('⑩ 查询② 错码 → 24010;无匹配报名 → 28002', async () => {
    const cycle = await openCycle();
    await seedApp(cycle.id, { phone: '13900000001' });
    await sendCode('13900000001');
    const bad = await request(httpServer(app))
      .post(QUERY_PHONE)
      .send({ phone: '13900000001', code: '000000' });
    expectBizError(bad, BizCode.SMS_CODE_INVALID);

    // 不同手机(无报名)→ 验码通过但定位不到 → 28002
    await sendCode('13900000002');
    const none = await request(httpServer(app))
      .post(QUERY_PHONE)
      .send({ phone: '13900000002', code: FIXED_CODE });
    expectBizError(none, BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
  });

  // ============ 招新可用性收口 F4(评审稿 §2.3/E-U-5):闭轮发码放行 + 发号后查询引导态 ============

  it('F4-a 闭轮 + 手机命中未清除报名 → 发码放行 + 验码发 token + 查询②/换绑链全通(3a 修复)', async () => {
    const cycle = await openCycle({ statusCode: 'closed' });
    await seedApp(cycle.id, { phone: '13900000001', statusCode: 'verified' });

    // 发码放行(真发:code 行存在)
    await sendCode('13900000001');
    expect(await prisma.smsVerificationCode.count({ where: { phone: '13900000001' } })).toBe(1);

    // 验码 → 发 token(轮次锚 = 报名行所在轮)
    const verify = await request(httpServer(app))
      .post(VERIFY)
      .send({ phone: '13900000001', code: FIXED_CODE });
    expect(verify.status).toBe(200);
    expect(verify.body.data.phoneVerificationToken).toEqual(expect.any(String));
    const sess = await prisma.recruitmentIdentitySession.findFirst({
      where: { phone: '13900000001' },
    });
    expect(sess?.cycleId).toBe(cycle.id);

    // 查询②(再发一码会撞 60s 间隔 → 直接用新码流:等价用 rebind-wechat 校验链亦通)
    await prisma.smsVerificationCode.deleteMany({}); // 释放 60s 间隔(测试隔离,不影响语义)
    await sendCode('13900000001');
    const q = await request(httpServer(app))
      .post(QUERY_PHONE)
      .send({ phone: '13900000001', code: FIXED_CODE });
    expect(q.status).toBe(200);
    expect(q.body.data.stage).toBe('threshold');
  });

  it('F4-b 闭轮 + 陌生手机 → send-code 防枚举泛化 200(零 code 行零 send_log);verify-code → 24010', async () => {
    await openCycle({ statusCode: 'closed' });

    const res = await request(httpServer(app)).post(SEND).send({ phone: '13900000009' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data).toEqual({ expiresInSeconds: 300 }); // 与真发码路径同形同值(沿 login-sms)
    expect(await prisma.smsVerificationCode.count()).toBe(0); // 不发码
    expect(await prisma.smsSendLog.count()).toBe(0); // 零留痕

    const verify = await request(httpServer(app))
      .post(VERIFY)
      .send({ phone: '13900000009', code: FIXED_CODE });
    expectBizError(verify, BizCode.SMS_CODE_INVALID); // 与码错同形(防枚举)
  });

  it('F4-c 发号后查询②(User.phone 锚,H5 手机通道)→ stage=volunteer 引导态;INACTIVE 队员 → 28002', async () => {
    const cycle = await openCycle(); // 开放轮供发码(闭轮下发号者 phone 已清,send-code 走泛化 = E-U-5 已知边界)
    const member = await prisma.member.create({
      data: { memberNo: '26901', displayName: '辛八', status: 'ACTIVE', gradeCode: 'volunteer' },
    });
    await prisma.user.create({
      data: {
        username: '26901',
        passwordHash: 'x',
        role: 'USER',
        memberId: member.id,
        phone: '13900000031',
        phoneVerifiedAt: new Date(),
      },
    });
    await prisma.recruitmentApplication.create({
      data: {
        cycleId: cycle.id,
        statusCode: 'promoted',
        promotedMemberId: member.id,
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        sensitivePurgedAt: new Date(),
        tempNo: 'T20260031',
        thresholdMarks: {
          patrol1: { at: 'x', by: 'y' },
          patrol2: { at: 'x', by: 'y' },
          training: { at: 'x', by: 'y' },
          redCross: { at: 'x', by: 'y' },
          bsafe: { at: 'x', by: 'y' },
        },
      },
    });

    await sendCode('13900000031');
    const res = await request(httpServer(app))
      .post(QUERY_PHONE)
      .send({ phone: '13900000031', code: FIXED_CODE });
    expect(res.status).toBe(200);
    expect(res.body.data.stage).toBe('volunteer'); // 引导态:已转志愿者 / 待入队
    expect(res.body.data.nextAction).toBe('apply-teamjoin');
    expect(res.body.data.memberNo).toBeNull(); // 公开面不泄编号
    expect(res.body.data.tempNo).toBe('T20260031');

    // INACTIVE 队员(已离队)→ 维持 28002(不泄状态)
    await prisma.member.update({ where: { id: member.id }, data: { status: 'INACTIVE' } });
    await prisma.smsVerificationCode.deleteMany({});
    await sendCode('13900000031');
    const gone = await request(httpServer(app))
      .post(QUERY_PHONE)
      .send({ phone: '13900000031', code: FIXED_CODE });
    expectBizError(gone, BizCode.RECRUITMENT_APPLICATION_NOT_FOUND);
  });

  it('F4-d 发号后查询②(member_profiles.mobile 锚,微信通道发号 User 无 phone)→ 同引导态', async () => {
    const cycle = await openCycle();
    const member = await prisma.member.create({
      data: { memberNo: '26902', displayName: '壬九', status: 'ACTIVE', gradeCode: 'volunteer' },
    });
    await prisma.user.create({
      data: {
        username: '26902',
        passwordHash: 'x',
        role: 'USER',
        memberId: member.id,
        openid: 'f4d-openid', // 微信通道:User 无 phone
      },
    });
    await prisma.memberProfile.create({
      data: {
        memberId: member.id,
        realName: '壬九',
        genderCode: 'male',
        birthDate: new Date('1990-01-01T00:00:00.000Z'),
        documentTypeCode: 'mainland_id',
        documentNumber: 'F4D0001',
        mobile: '13900000032', // 报名手机搬进档案
        joinedDate: new Date('2026-07-01T00:00:00.000Z'),
        joinSourceCode: 'recruitment',
        privacyConsentSigned: true,
      },
    });
    await prisma.recruitmentApplication.create({
      data: {
        cycleId: cycle.id,
        statusCode: 'promoted',
        promotedMemberId: member.id,
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        sensitivePurgedAt: new Date(),
      },
    });

    await sendCode('13900000032');
    const res = await request(httpServer(app))
      .post(QUERY_PHONE)
      .send({ phone: '13900000032', code: FIXED_CODE });
    expect(res.status).toBe(200);
    expect(res.body.data.stage).toBe('volunteer');
  });

  // ============ 招新可用性收口 F6(评审稿 §3 R4):自助撤销 ============

  const WITHDRAW = '/api/open/v1/recruitment/applications/withdraw';

  it('F6-① 手机通道撤销 → withdrawn 终态 + 进度模型 stage=withdrawn + audit;重撤 → 28052(幂等语义)', async () => {
    const cycle = await openCycle();
    const app0 = await seedApp(cycle.id, { phone: '13900000001', statusCode: 'verified' });
    await sendCode('13900000001');
    const res = await request(httpServer(app))
      .post(WITHDRAW)
      .send({ phone: '13900000001', code: FIXED_CODE });
    expect(res.status).toBe(200);
    expect(res.body.data.stage).toBe('withdrawn');
    expect(res.body.data.stageText).toBe('已撤销报名');
    expect(res.body.data.nextAction).toBeNull();

    const row = await prisma.recruitmentApplication.findUniqueOrThrow({ where: { id: app0.id } });
    expect(row.statusCode).toBe('withdrawn');
    expect(row.eliminationStage).toBeNull(); // 非淘汰:不写 eliminationStage

    const audit = await prisma.auditLog.findFirst({
      where: { event: 'recruitment-application.withdraw', resourceId: app0.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBeNull(); // 无账号自助
    const ctx = audit?.context as { extra?: { channel?: string; phone?: string } } | null;
    expect(ctx?.extra?.channel).toBe('phone');
    expect(ctx?.extra?.phone).toContain('*'); // 掩码

    // 重撤(终态命中)→ 28052
    await prisma.smsVerificationCode.deleteMany({});
    await sendCode('13900000001');
    const again = await request(httpServer(app))
      .post(WITHDRAW)
      .send({ phone: '13900000001', code: FIXED_CODE });
    expectBizError(again, BizCode.RECRUITMENT_APPLICATION_NOT_WITHDRAWABLE);
  });

  it('F6-② 微信通道撤销 → withdrawn;promoted/rejected 终态 → 28052;双通道 both/neither → 40000', async () => {
    const cycle = await openCycle();
    await seedApp(cycle.id, {
      phone: '13900000021',
      openid: 'dev-openid-wd-a',
      statusCode: 'manual_review',
      tempNo: null,
    });
    const ok = await request(httpServer(app)).post(WITHDRAW).send({ wechatCode: 'wd-a' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.stage).toBe('withdrawn');

    // rejected 终态 → 28052
    await seedApp(cycle.id, {
      phone: '13900000022',
      openid: 'dev-openid-wd-b',
      statusCode: 'rejected',
      tempNo: null,
      idCardNumber: 'WDID0002',
    });
    expectBizError(
      await request(httpServer(app)).post(WITHDRAW).send({ wechatCode: 'wd-b' }),
      BizCode.RECRUITMENT_APPLICATION_NOT_WITHDRAWABLE,
    );

    // both / neither → 40000
    expectBizError(
      await request(httpServer(app))
        .post(WITHDRAW)
        .send({ wechatCode: 'wd-a', phone: '13900000021', code: FIXED_CODE }),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );
    expectBizError(await request(httpServer(app)).post(WITHDRAW).send({}), BizCode.BAD_REQUEST, {
      strictMessage: false,
    });
  });

  it('F6-③ DoD:撤销后同轮同证件号重报成功(partial unique 排除集 + 三键去重排除集均含 withdrawn)', async () => {
    await openCycle();
    // 首报(H5 链)→ verified
    const token = await getToken('13900000001');
    await submit(basePayload('13900000001', { phoneVerificationToken: token })).expect(201);

    // 自助撤销
    await prisma.smsVerificationCode.deleteMany({});
    await sendCode('13900000001');
    await request(httpServer(app))
      .post(WITHDRAW)
      .send({ phone: '13900000001', code: FIXED_CODE })
      .expect(200);

    // 同轮 同证件号 + 同手机 重报 → 成功(撤销行不再占键)
    await prisma.smsVerificationCode.deleteMany({});
    const token2 = await getToken('13900000001');
    const again = await submit(basePayload('13900000001', { phoneVerificationToken: token2 }));
    expect(again.status).toBe(201);
    expect(again.body.data.statusCode).toBe('verified');
    // 两行并存:一 withdrawn 一 verified(同 idCardNumber/同 phone;partial unique 只约束活跃行)
    const rows = await prisma.recruitmentApplication.findMany({
      where: { phone: '13900000001' },
      select: { statusCode: true },
    });
    expect(rows.map((r) => r.statusCode).sort()).toEqual(['verified', 'withdrawn']);
  });

  // ============ 招新可用性收口 F7:证书图上传(手机通道)============

  it('F7-④ 手机通道上传证书图 → 消费一码 + 落 keys + audit(actor 置空)', async () => {
    const cycle = await openCycle();
    await seedApp(cycle.id, { phone: '13900000001', statusCode: 'verified' });
    await sendCode('13900000001');
    const res = await request(httpServer(app))
      .post('/api/open/v1/recruitment/applications/certificates')
      .field('category', 'first_aid')
      .field('phone', '13900000001')
      .field('code', FIXED_CODE)
      .attach('images', Buffer.from('fake-cert'), {
        filename: 'c.png',
        contentType: 'image/png',
      });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ category: 'first_aid', imageCount: 1 });
    const row = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { phone: '13900000001' },
    });
    expect((row.certificateImages as Record<string, string[]>).first_aid).toHaveLength(1);
    const audit = await prisma.auditLog.findFirst({
      where: { event: 'recruitment-application.certificate-upload', resourceId: row.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBeNull();
    const ctx = audit?.context as { extra?: { channel?: string; category?: string } } | null;
    expect(ctx?.extra?.channel).toBe('phone');
    expect(ctx?.extra?.category).toBe('first_aid');
  });

  // ============ 小程序链向后兼容 ============

  it('⑪ 小程序链向后兼容:submit(wechatCode 无 token)→ verified + openid 落;query(wechat)可查', async () => {
    await openCycle();
    const res = await submit(basePayload('13900000001', { wechatCode: 'code-mini' }));
    expect(res.status).toBe(201);
    expect(res.body.data.statusCode).toBe('verified');
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-mini' },
    });
    expect(row?.openid).toBe('dev-openid-code-mini');
    expect(row?.phoneVerifiedAt).toBeNull(); // 小程序链不验手机

    // query(wechat)向后兼容:同 code → 同 openid(DevStub)→ 查得本人进度模型
    const q = await request(httpServer(app)).post(QUERY_WECHAT).send({ wechatCode: 'code-mini' });
    expect(q.status).toBe(200);
    expect(q.body.data.stage).toBe('threshold');
  });

  // ============ 自助换微信换绑 ============

  it('⑫ rebind-wechat:当前手机验码 → 换新微信 → openid 更新 + 审计', async () => {
    const cycle = await openCycle();
    await seedApp(cycle.id, { phone: '13900000001', openid: 'dev-openid-old' });
    await sendCode('13900000001');
    const res = await request(httpServer(app))
      .post(REBIND_WECHAT)
      .send({ phone: '13900000001', code: FIXED_CODE, newWechatCode: 'code-new' });
    expect(res.status).toBe(200);
    expect(res.body.data.stage).toBe('threshold');

    const row = await prisma.recruitmentApplication.findFirst({ where: { phone: '13900000001' } });
    expect(row?.openid).toBe('dev-openid-code-new');
    const audit = await prisma.auditLog.findFirst({
      where: { event: 'recruitment-application.rebind-wechat' },
    });
    expect(audit).not.toBeNull();
  });

  it('⑬ rebind-wechat 新微信已绑本轮他人报名 → 28051', async () => {
    const cycle = await openCycle();
    await seedApp(cycle.id, {
      phone: '13900000001',
      openid: 'dev-openid-mine',
      idCardNumber: ID_A,
    });
    // 另一报名已占用 dev-openid-code-taken
    await seedApp(cycle.id, {
      phone: '13900000002',
      openid: 'dev-openid-code-taken',
      idCardNumber: ID_B,
      tempNo: 'T20260002',
    });
    await sendCode('13900000001');
    const res = await request(httpServer(app))
      .post(REBIND_WECHAT)
      .send({ phone: '13900000001', code: FIXED_CODE, newWechatCode: 'code-taken' });
    expectBizError(res, BizCode.RECRUITMENT_WECHAT_ALREADY_BOUND);
  });

  // ============ 自助换手机换绑 ============

  it('⑭ rebind-phone:双验(当前+新手机)→ phone 更新 + 换绑历史 + 审计', async () => {
    const cycle = await openCycle();
    await seedApp(cycle.id, { phone: '13900000001' });
    await sendCode('13900000001');
    await sendCode('13900000002');
    const res = await request(httpServer(app)).post(REBIND_PHONE).send({
      phone: '13900000001',
      code: FIXED_CODE,
      newPhone: '13900000002',
      newPhoneCode: FIXED_CODE,
      reason: '换号',
    });
    expect(res.status).toBe(200);

    const row = await prisma.recruitmentApplication.findFirst({
      where: { phone: '13900000002' },
    });
    expect(row?.phone).toBe('13900000002');
    expect(row?.phoneChangedAt).not.toBeNull();
    expect(row?.phoneChangeReason).toBe('换号');
    expect(Array.isArray(row?.phoneBindingHistory)).toBe(true);
    expect((row?.phoneBindingHistory as Array<{ to: string }>)[0].to).toBe('13900000002');
    const audit = await prisma.auditLog.findFirst({
      where: { event: 'recruitment-application.rebind-phone' },
    });
    expect(audit).not.toBeNull();
  });

  it('⑮ rebind-phone 新旧手机相同 → 40000', async () => {
    const cycle = await openCycle();
    await seedApp(cycle.id, { phone: '13900000001' });
    await sendCode('13900000001');
    const res = await request(httpServer(app)).post(REBIND_PHONE).send({
      phone: '13900000001',
      code: FIXED_CODE,
      newPhone: '13900000001',
      newPhoneCode: FIXED_CODE,
    });
    expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
  });

  // ============ 容量 / 去重不被会话行影响 ============

  it('⑯ 会话行不进报名表、不参与去重:多会话行 → applications 零增长 + 同证件去重仍 28003', async () => {
    await openCycle(); // capacity 不限(隔离去重证明,不被容量先拦)
    // 建多个会话行(验码),不应进入报名表(→ 不影响容量/统计/去重,皆查 applications)
    await getToken('13900000001');
    await getToken('13900000002');
    expect(await prisma.recruitmentIdentitySession.count()).toBe(2);
    expect(await prisma.recruitmentApplication.count()).toBe(0); // 会话行不进报名表

    // H5 报名 1 人 → applications=1
    const token3 = await getToken('13900000003');
    await submit(
      basePayload('13900000003', { phoneVerificationToken: token3, idCardNumber: ID_A }),
    ).expect(201);
    expect(await prisma.recruitmentApplication.count()).toBe(1);

    // 同证件号再报(不同手机/token)→ 去重 28003(去重键 idCardNumber,会话行/手机不干扰)
    const token4 = await getToken('13900000004');
    const dup = await submit(
      basePayload('13900000004', { phoneVerificationToken: token4, idCardNumber: ID_A }),
    );
    expectBizError(dup, BizCode.RECRUITMENT_DUPLICATE_APPLICATION);
  });

  // ============ S4b:OCR 六分流(H5 会话计数;评审稿 §2.1;Q-P4-2/3/4)============
  // 重拍/上游计次落 S4a 会话行预建列(ocrAttemptCount/requiresRetake/lastOcrOutcome);
  // 延迟分流不落报名记录、不消费 token(身份链保活可重试);连续达 2 次才升级落库。

  // 临时禁用/恢复 realname 通道(DevStub 不模拟上游错 → 用通道开关造 ocr_error;断言前即复原)。
  // 直写 DB 绕过 service → 须显式 invalidate() 清 60s settings 缓存,否则旧值仍命中(非确定性)。
  async function setRealnameEnabled(enabled: boolean): Promise<void> {
    await prisma.realnameVerificationSettings.updateMany({ data: { enabled } });
    app.get(RealnameSettingsService).invalidate();
  }

  it('⑰ 模糊(clarity:false)→ retake,不落记录,会话行 count++/requiresRetake,token 不消费', async () => {
    await openCycle();
    const phone = '13900000001';
    const token = await getToken(phone);
    const res = await submit(basePayload(phone, { phoneVerificationToken: token }), {
      clarity: false,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.outcome).toBe('retake');
    expect(res.body.data.stage).toBe('retake');
    expect(res.body.data.stageText).toBe('待重拍');
    expect(await prisma.recruitmentApplication.count()).toBe(0); // 不落记录
    const sess = await prisma.recruitmentIdentitySession.findFirst({ where: { phone } });
    expect(sess?.ocrAttemptCount).toBe(1);
    expect(sess?.requiresRetake).toBe(true);
    expect(sess?.lastOcrOutcome).toBe('ocr_unclear');
    expect(sess?.consumedAt).toBeNull(); // token 保活可重试
  });

  it('⑱ 上游失败连续 2 次才落:首次 retry 不落 / 第二次 → manual_review riskLevel=system', async () => {
    await openCycle();
    const phone = '13900000001';
    const token = await getToken(phone);
    await setRealnameEnabled(false); // 造 ocr_error
    const r1 = await submit(basePayload(phone, { phoneVerificationToken: token }));
    const r2 = await submit(basePayload(phone, { phoneVerificationToken: token }));
    await setRealnameEnabled(true); // 断言前复原,失败不污染后续
    expect(r1.body.data.outcome).toBe('retry'); // 首次只提示重试
    expect(await prisma.recruitmentApplication.count()).toBe(1); // 仅第二次落 1 条
    expect(r2.body.data.outcome).toBe('submitted');
    expect(r2.body.data.statusCode).toBe('manual_review');
    const row = await prisma.recruitmentApplication.findFirst({ where: { phone } });
    expect(row?.riskLevel).toBe('system');
    expect(row?.manualReviewReason).toBe('system_ocr_error');
    expect(row?.verifyOutcome).toBe('ocr_error');
    expect(row?.lastOcrOutcome).toBe('ocr_error'); // 快照
  });

  it('⑲ 防伪连续 2 次才落:首次 retake(中性不暴露 forgery)/ 第二次 → manual_review riskLevel=high', async () => {
    await openCycle();
    const phone = '13900000001';
    const token = await getToken(phone);
    const forgery = { name: '张三', idCardNumber: ID_A, clarity: true, warnings: ['PS'] };
    const r1 = await submit(basePayload(phone, { phoneVerificationToken: token }), forgery);
    expect(r1.body.data.outcome).toBe('retake');
    expect(JSON.stringify(r1.body.data)).not.toMatch(/防伪|篡改|forgery|高风险|疑似/); // 申请人侧中性
    expect(await prisma.recruitmentApplication.count()).toBe(0);
    const r2 = await submit(basePayload(phone, { phoneVerificationToken: token }), forgery);
    expect(r2.body.data.outcome).toBe('submitted');
    expect(r2.body.data.statusCode).toBe('manual_review');
    const row = await prisma.recruitmentApplication.findFirst({ where: { phone } });
    expect(row?.riskLevel).toBe('high');
    expect(row?.manualReviewReason).toBe('forgery_suspected');
  });

  it('⑳ mismatch 三选一①②:confirm 不落记录 → 用 OCR 回填纠正后 verified(不进人工)', async () => {
    await openCycle();
    const phone = '13900000001';
    const token = await getToken(phone);
    // 填「张三」但 OCR 读「李四」→ mismatch → confirm(不落记录,回带识别值)
    const mm = await submit(
      basePayload(phone, { phoneVerificationToken: token, realName: '张三' }),
      {
        name: '李四',
        idCardNumber: ID_A,
        clarity: true,
        warnings: [],
      },
    );
    expect(mm.body.data.outcome).toBe('confirm');
    expect(mm.body.data.stage).toBe('confirm');
    expect(mm.body.data.recognized).toEqual({ realName: '李四', idCardNumber: ID_A });
    expect(await prisma.recruitmentApplication.count()).toBe(0); // ①② 不进人工
    // ①用 OCR 回填:改填「李四」重提(同 token 未消费)→ matched → verified
    const ok = await submit(
      basePayload(phone, { phoneVerificationToken: token, realName: '李四' }),
      {
        name: '李四',
        idCardNumber: ID_A,
        clarity: true,
        warnings: [],
      },
    );
    expect(ok.body.data.outcome).toBe('submitted');
    expect(ok.body.data.statusCode).toBe('verified');
    const row = await prisma.recruitmentApplication.findFirst({ where: { phone } });
    expect(row?.statusCode).toBe('verified');
    expect(row?.riskLevel).toBeNull();
  });

  it('㉑ mismatch 三选一③:applicantConfirmedOcrWrong → 普通人工(riskLevel=normal + 确认标记)', async () => {
    await openCycle();
    const phone = '13900000001';
    const token = await getToken(phone);
    const res = await submit(
      basePayload(phone, {
        phoneVerificationToken: token,
        realName: '张三',
        applicantConfirmedOcrWrong: true,
      }),
      { name: '李四', idCardNumber: ID_A, clarity: true, warnings: [] },
    );
    expect(res.body.data.outcome).toBe('submitted');
    expect(res.body.data.statusCode).toBe('manual_review');
    const row = await prisma.recruitmentApplication.findFirst({ where: { phone } });
    expect(row?.riskLevel).toBe('normal');
    expect(row?.manualReviewReason).toBe('ocr_mismatch_confirmed');
    expect(row?.applicantConfirmedOcrWrong).toBe(true);
  });

  it('㉒ 十项收口刀C:高风险行公开面 stage 折叠为 manual(机器码不再泄露分级):query-by-phone', async () => {
    const cycle = await openCycle();
    await seedApp(cycle.id, {
      phone: '13900000001',
      statusCode: 'manual_review',
      tempNo: null,
      riskLevel: 'high',
      manualReviewReason: 'forgery_suspected',
      verifyOutcome: 'forgery_warning',
      openid: 'dev-openid-mh',
    });
    await sendCode('13900000001');
    const res = await request(httpServer(app))
      .post(QUERY_PHONE)
      .send({ phone: '13900000001', code: FIXED_CODE });
    expect(res.status).toBe(200);
    // 刀C 行为变更:此前 stage 原样透传 manual_high(抓包即知被归入高风险);现公开出口折叠为 manual。
    expect(res.body.data.stage).toBe('manual');
    expect(res.body.data.stageText).toBe('待人工核验'); // 中性,不暴露高风险
    // 负面词表补 manual_high(此前断言「不暴露」却漏了机器码字面)
    expect(JSON.stringify(res.body.data)).not.toMatch(/高风险|疑似|造假|forgery|manual_high/);
  });

  // ===== 十项收口刀F:公开公示名单(view-publicity 悬空动作收口)=====

  it('刀F-a 公开公示名单:无公示中名单 → 200 + cycleYear=null + items=[](空窗合法,不 404)', async () => {
    await openCycle();
    const res = await request(httpServer(app)).get('/api/open/v1/recruitment/publicity');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ cycleYear: null, items: [] });
  });

  it('刀F-b 公开公示名单:publicity 行 → 姓名+拟发号(与后台预览/实发同源);不出内部字段', async () => {
    const cycle = await openCycle();
    await seedApp(cycle.id, {
      statusCode: 'publicity',
      birthDate: new Date('1990-03-07T00:00:00.000Z'),
      genderCode: 'male',
    });
    const res = await request(httpServer(app)).get('/api/open/v1/recruitment/publicity');
    expect(res.status).toBe(200);
    expect(res.body.data.cycleYear).toBe(2026);
    expect(res.body.data.items).toEqual([{ realName: '张三', proposedMemberNo: '26001' }]);
  });

  // ===== 十项收口刀C:验码顺手清同手机过期会话行 =====

  it('刀C-a 验码成功 → 同手机过期会话行被硬删(明文手机/OCR 轨迹不再累积)', async () => {
    const cycle = await openCycle();
    await prisma.recruitmentIdentitySession.create({
      data: {
        cycleId: cycle.id,
        phone: '13900000001',
        phoneVerifiedAt: new Date(Date.now() - 3600_000),
        phoneVerificationMethod: 'sms',
        phoneVerificationTokenHash: 'expired-hash-13900000001',
        expiresAt: new Date(Date.now() - 1800_000), // 已过期
      },
    });
    await getToken('13900000001'); // 验码成功 → 建新会话行前顺手删同手机过期行
    const rows = await prisma.recruitmentIdentitySession.findMany({
      where: { phone: '13900000001' },
    });
    expect(rows.length).toBe(1); // 只剩新行(过期行已硬删,非标记)
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});
