import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import {
  ID_CARD_IMAGE_MAX_BYTES,
  hashPhoneVerificationToken,
} from '../../src/modules/recruitment/recruitment.constants';
import { NotificationOutboxService } from '../../src/modules/notifications/notification-outbox.service';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
import { PrismaService } from '../../src/database/prisma.service';
import { STORAGE_PROVIDER } from '../../src/modules/storage/storage.constants';
import type { StorageProvider } from '../../src/modules/storage/storage.interface';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { Prisma, Role } from '@prisma/client';
import { expectBizError } from '../helpers/biz-code.assert';
import { devStubOcrImage, VALID_PNG_IMAGE } from '../helpers/file-fixtures';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 招新报名全链 e2e(OCR 改造冻结评审稿 docs/archive/reviews/recruitment-realname-ocr-review.md §4/§8):
// 识别端点 + 报名全链(大陆 OCR 匹配→verified / 不匹配·防伪告警·不清晰→manual_review)+ 非大陆证件人工 +
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
  let storage: StorageProvider;
  let adminAuth: string; // SUPER_ADMIN(rbac.can 短路通过)
  let userAuth: string; // 普通 USER(RBAC 边界)
  let sensitiveAuth: string; // 非 SA:read.record + read.sensitive(S3 敏感查看)
  let recordOnlyAuth: string; // 非 SA:仅 read.record(S3 脱敏查看)
  let submitTokenSeq = 0;

  // F1(招新可用性收口):同轮活跃报名 phone 去重落地后,默认 fixture 手机随 wechatCode 唯一化
  // (镜像 DevStub `dev-openid-<code>` 的确定性派生;显式传 phone 的用例不受影响)。
  // 确定性哈希、非随机 → 可复现;同一 code 恒同号(测试内引用可用 phoneFor 回查)。
  function phoneFor(code: string): string {
    let h = 0;
    for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0;
    return `139${String(h % 100000000).padStart(8, '0')}`;
  }

  function validPayload(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      wechatCode: 'code-default',
      realName: '张三',
      idCardNumber: ID_MATCH_A,
      documentTypeCode: 'mainland_id',
      phone: phoneFor(typeof over.wechatCode === 'string' ? over.wechatCode : 'code-default'),
      detailedAddress: '北京市朝阳区某街道 1 号院 2 单元',
      cityDistrict: '北京市朝阳区',
      sourceChannel: 'wechat_moments',
      emergencyContacts: [
        { name: '李四', relation: 'parent', phone: '13900000002' },
        { name: '王五', relation: 'family', phone: '13900000003' },
      ],
      privacyConsentAccepted: true, // F5 契约收紧:submit 必填(fixture 缺省即真)
      ...over,
    };
  }

  // 提交:multipart payload + idCardImage(= DevStub OCR 信封)。默认信封 = 与 payload 一致(matched);
  // opts.ocr 覆盖造不一致/告警/不清晰(评审稿 §3.7);opts.withImage=false 造缺图。
  async function submit(
    payload: Record<string, unknown>,
    opts: {
      withImage?: boolean;
      ocr?: Record<string, unknown>;
      image?: Buffer;
      signature?: Buffer | null;
    } = {},
  ): Promise<request.Response> {
    const submitPayload = { ...payload };
    if (submitPayload.phoneVerificationToken === undefined) {
      const cycle = await prisma.recruitmentCycle.findFirst({
        where: { statusCode: 'open', deletedAt: null },
        select: { id: true },
      });
      const rawToken = `e2e-submit-token-${++submitTokenSeq}-${String(payload.phone)}`;
      submitPayload.phoneVerificationToken = rawToken;
      if (cycle) {
        await prisma.recruitmentIdentitySession.create({
          data: {
            cycleId: cycle.id,
            phone: String(payload.phone),
            phoneVerifiedAt: new Date(),
            phoneVerificationMethod: 'sms',
            phoneVerificationTokenHash: hashPhoneVerificationToken(rawToken),
            expiresAt: new Date(Date.now() + 30 * 60_000),
          },
        });
      }
    }
    if (submitPayload.phoneVerificationToken === null) {
      delete submitPayload.phoneVerificationToken;
    }
    const withImage = opts.withImage ?? true;
    const envelope = opts.ocr ?? {
      name: submitPayload.realName,
      idCardNumber: submitPayload.idCardNumber,
      clarity: true,
      warnings: [],
    };
    let req = request(httpServer(app))
      .post(OPEN_SUBMIT)
      .field('payload', JSON.stringify(submitPayload));
    if (withImage) {
      req = req.attach('idCardImage', opts.image ?? devStubOcrImage(envelope), {
        filename: 'id.jpg',
        contentType: 'image/jpeg',
      });
    }
    // 签名图必填:fixture 默认补齐;显式 signature:null 仅用于缺签名契约断言。
    const signature = opts.signature === undefined ? VALID_PNG_IMAGE : opts.signature;
    if (signature) {
      req = req.attach('signatureImage', signature, {
        filename: 'sig.png',
        contentType: 'image/png',
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
    return req.attach('idCardImage', devStubOcrImage(envelope), {
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

  // S3 判权矩阵:给一个新的非 SA USER 精确授予 codes(建 Permission + 专用角色 + 绑 + 挂),返登录 authHeader。
  // 角色/权限/绑定写在 beforeAll、不被 beforeEach 清(后者只清报名/promote 产物),跨测持久。
  // code 形态恒 3 段 `<module>.<action>.<resourceType>`(recruitment-application.read.{record,sensitive})。
  async function createUserWithCodes(username: string, codes: string[]): Promise<string> {
    await createTestUser(app, { username, role: Role.USER });
    const u = await prisma.user.findUniqueOrThrow({ where: { username }, select: { id: true } });
    for (const code of codes) {
      const [moduleName, action, resourceType] = code.split('.');
      await prisma.permission.upsert({
        where: { code },
        update: {},
        create: { code, module: moduleName, action, resourceType },
      });
    }
    const perms = await prisma.permission.findMany({
      where: { code: { in: codes } },
      select: { id: true },
    });
    const role = await prisma.rbacRole.create({
      data: { code: `e2e-role-${username}`, displayName: username },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
    // 终态 scoped-authz PR6:判权读源 = global RoleBinding。
    await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: u.id,
        roleId: role.id,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
      },
    });
    return (await loginAs(app, username)).authHeader;
  }

  beforeAll(async () => {
    process.env.RECRUITMENT_THROTTLE_LIMIT = '100'; // 配额上限(评审稿 max 100);全链测试不触限流
    app = await createTestApp();
    prisma = app.get(PrismaService);
    storage = app.get<StorageProvider>(STORAGE_PROVIDER);
    await resetDb(app);

    // 双 DevStub 通道:wechat(确定性假 openid)+ realname(校验位奇偶定 matched)
    await prisma.wechatSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });
    await prisma.realnameVerificationSettings.create({
      data: { providerType: 'DEV_STUB', enabled: true },
    });
    // v0.40.0 H5 手机通道发号:sms DevStub(固定验证码 888888),供「H5 发号 → login-sms 登录」集成用例。
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });

    await createTestUser(app, { username: 'recruit_admin', role: Role.SUPER_ADMIN });
    adminAuth = (await loginAs(app, 'recruit_admin')).authHeader;
    await createTestUser(app, { username: 'recruit_user', role: Role.USER });
    userAuth = (await loginAs(app, 'recruit_user')).authHeader;

    // S3 敏感字段分级判权矩阵用户(非 SA,走真实 RBAC 而非短路)
    sensitiveAuth = await createUserWithCodes('recruit_sensitive', [
      'recruitment-application.read.record',
      'recruitment-application.read.sensitive',
    ]);
    recordOnlyAuth = await createUserWithCodes('recruit_record_only', [
      'recruitment-application.read.record',
    ]);

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
        { typeId: stageType.id, code: 'withdrawn', label: '已撤销报名', sortOrder: 10 }, // F6
      ],
    });

    // 招新闭环优化 S5(评审稿 §5.2a):promote 现写 gradeCode='volunteer' + 建 VOL 归口部门
    //(Organization.code='VOL' + ACTIVE,≠ VOD 志愿者组织部)。seed VOL 组织(reference data,
    // beforeEach 不清,跨测持久);缺它 promote 会 28044 清晰失败。
    await prisma.organization.create({
      data: { name: '志愿者', code: 'VOL', nodeTypeCode: 'volunteer', status: 'ACTIVE' },
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
    // v0.40.0 H5 手机通道用例走 login-sms 登录 → 建 refreshToken(FK→User Restrict)+ 登录 audit
    // (actorUserId FK→User Restrict);二者须先于 promote 建的 User 清。
    await prisma.refreshToken.deleteMany({});
    const promoteUsers = await prisma.user.findMany({
      where: { memberId: { not: null } },
      select: { id: true },
    });
    if (promoteUsers.length > 0) {
      await prisma.auditLog.deleteMany({
        where: { actorUserId: { in: promoteUsers.map((u) => u.id) } },
      });
    }
    await prisma.user.deleteMany({ where: { memberId: { not: null } } }); // promote 建的 User 都绑 member
    await prisma.memberOrganizationMembership.deleteMany({}); // S5:promote 建的 VOL 归口 PRIMARY 归属(FK RESTRICT,须先于 member 清)
    // 统一通知 S3:promote 发号定向通知(recipientMemberId FK→Member Restrict)+ 投递须先于 member 清。
    await prisma.notificationDelivery.deleteMany({});
    await prisma.notificationRead.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.notificationOutboxIntent.deleteMany({});
    // F7:promote 现为证书图类别建 pending Certificate(FK→Member Restrict,须先于 member 清)
    await prisma.certificate.deleteMany({});
    await prisma.member.deleteMany({});
    await prisma.recruitmentApplication.deleteMany({});
    await prisma.recruitmentCycle.deleteMany({});
    // F1:OCR 日封顶按 IP 持久计数 —— 每测清零,防同文件多测累计打满 30 上限误伤无关用例。
    await prisma.recruitmentOcrDailyCounter.deleteMany({});
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

  // ② 大陆 OCR 不匹配(小程序链/无会话)→ S4b 六分流:延迟 confirm 三选一,**不落记录**(替换原「直落 manual_review」)
  it('② 大陆 OCR 不匹配 → 200 outcome=confirm,不落记录,回带 OCR 识别值供三选一', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'code-b', idCardNumber: ID_MATCH_A }), {
      ocr: { name: '李四', idCardNumber: ID_MATCH_A, clarity: true, warnings: [] },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.outcome).toBe('confirm');
    expect(res.body.data.statusCode).toBeNull();
    expect(res.body.data.stage).toBe('confirm');
    expect(res.body.data.recognized).toEqual({ realName: '李四', idCardNumber: ID_MATCH_A });
    // 不落报名记录 + 不留 DB OCR 审计(无 resourceId;付费 OCR 仅 pino 留痕)
    expect(await prisma.recruitmentApplication.count()).toBe(0);
    expect(await realnameVerifyAuditCount()).toBe(0);
  });

  // ②-③ mismatch 三选一之③「确认 OCR 错」(applicantConfirmedOcrWrong)→ 落普通人工(normal,不误杀)
  it('②-③ mismatch + applicantConfirmedOcrWrong → manual_review(riskLevel=normal,ocr_mismatch_confirmed)', async () => {
    await openCycle();
    const res = await submit(
      validPayload({
        wechatCode: 'code-b-confirm',
        idCardNumber: ID_MATCH_A,
        applicantConfirmedOcrWrong: true,
      }),
      { ocr: { name: '李四', idCardNumber: ID_MATCH_A, clarity: true, warnings: [] } },
    );
    expect(res.body.data.outcome).toBe('submitted');
    expect(res.body.data.statusCode).toBe('manual_review');
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-b-confirm' },
    });
    expect(row?.verifyOutcome).toBe('mismatch');
    expect(row?.riskLevel).toBe('normal');
    expect(row?.manualReviewReason).toBe('ocr_mismatch_confirmed');
    expect(row?.applicantConfirmedOcrWrong).toBe(true);
    expect(await realnameVerifyAuditCount()).toBe(1); // 落记录 → 付费 OCR 留痕
  });

  // ②b 大陆 OCR 防伪告警(小程序链/无会话)→ 延迟 retake(重拍原件),**不落记录、不升级**(无会话不服务端升级)
  it('②b 大陆 OCR 防伪告警 → outcome=retake,不落记录(无会话不升级高风险)', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'code-b2', idCardNumber: ID_MATCH_A }), {
      ocr: { name: '张三', idCardNumber: ID_MATCH_A, clarity: true, warnings: ['PS'] },
    });
    expect(res.body.data.outcome).toBe('retake');
    expect(res.body.data.stage).toBe('retake');
    expect(res.body.data.statusCode).toBeNull();
    // 中性引导:不暴露 forgery/高风险(申请人侧隐私口径)
    expect(JSON.stringify(res.body.data)).not.toMatch(/防伪|篡改|forgery|高风险/);
    expect(await prisma.recruitmentApplication.count()).toBe(0);
  });

  // ②c 大陆 OCR 证件照不清晰 → 延迟 retake,**不落记录、永不进人工**
  it('②c 大陆 OCR 不清晰 → outcome=retake,不落记录', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'code-b3', idCardNumber: ID_MATCH_A }), {
      ocr: { clarity: false },
    });
    expect(res.body.data.outcome).toBe('retake');
    expect(res.body.data.stage).toBe('retake');
    expect(await prisma.recruitmentApplication.count()).toBe(0);
  });

  // ③ 非大陆证件 → manual_review(不调付费核验);admin 人工 resolve approved → verified + 发号
  it('③ 非大陆证件 → manual_review(零付费核验调用);人工 resolve 通过 → verified + 临时编号', async () => {
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
    // 非大陆证件根本不进付费核验:零 realname-verify 审计
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

  // ===== 招新可用性收口 F1(评审稿 recruitment-usability-closeout-review.md §2.5/E-U-2):
  //       防重前移(同轮活跃 openid/phone)+ OCR 按 IP 北京自然日封顶 =====

  async function ocrCounterTotal(): Promise<number> {
    const rows = await prisma.recruitmentOcrDailyCounter.findMany({ select: { count: true } });
    return rows.reduce((s, r) => s + r.count, 0);
  }

  it('⑤b(F1) 同轮同微信(换证件号)二次提交 → 28004,且不触付费 OCR(日封顶计数零增长)', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-dup-o', idCardNumber: ID_MATCH_A }));
    const afterFirst = await ocrCounterTotal();
    expect(afterFirst).toBe(1); // 首笔 mainland 提交计 1 次付费 OCR

    // 同 openid(同 wechatCode)+ 不同证件号 + 不同手机 → openid 去重命中(证件号键绕不过成本线)
    const dup = await submit(
      validPayload({
        wechatCode: 'code-dup-o',
        idCardNumber: ID_MATCH_B,
        phone: '13911100001',
      }),
    );
    expectBizError(dup, BizCode.RECRUITMENT_DUPLICATE_OPENID_ACTIVE);
    expect(await ocrCounterTotal()).toBe(afterFirst); // 被拒提交零 OCR、零计数
    expect(await realnameVerifyAuditCount()).toBe(1);
  });

  it('⑤c(F1) 同轮同手机(换证件号/换微信)二次提交 → 28005,且不触付费 OCR', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-dup-p1', idCardNumber: ID_MATCH_A }));
    const afterFirst = await ocrCounterTotal();

    const dup = await submit(
      validPayload({
        wechatCode: 'code-dup-p2',
        idCardNumber: ID_MATCH_B,
        phone: phoneFor('code-dup-p1'), // 与首笔同手机
      }),
    );
    expectBizError(dup, BizCode.RECRUITMENT_DUPLICATE_PHONE_ACTIVE);
    expect(await ocrCounterTotal()).toBe(afterFirst);
  });

  it('⑤d(F1) rejected 后同 openid/同手机可重报(排除集 = 非活跃态不占键)', async () => {
    await openCycle();
    // mismatch + 确认③ → manual_review(活跃行)→ 人工 reject → rejected
    await submit(
      validPayload({
        wechatCode: 'code-dup-r',
        idCardNumber: ID_MATCH_A,
        applicantConfirmedOcrWrong: true,
      }),
      { ocr: { name: '别人', idCardNumber: ID_MATCH_A, clarity: true } },
    );
    const row = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-code-dup-r' },
    });
    await request(httpServer(app))
      .post(`${ADMIN_APPS}/${row.id}/resolve`)
      .set('Authorization', adminAuth)
      .send({ approved: false })
      .expect(200);

    // 同 openid + 同手机 + 换证件号重报 → 三键(idCard/openid/phone)均不撞 rejected 行 → verified
    const again = await submit(
      validPayload({ wechatCode: 'code-dup-r', idCardNumber: ID_MATCH_B }),
    );
    expect(again.status).toBe(201);
    expect(again.body.data.statusCode).toBe('verified');
  });

  it('⑤e(F1) OCR 日封顶:当日计数达上限 → recognize/submit 28060(HTTP 429);非大陆证件不调 OCR 不受限', async () => {
    await openCycle();
    // 先跑一次 recognize 学到本环境请求 IP 的计数键(不猜 IP 形态)
    const warm = await recognize('mainland_id', {
      name: '张三',
      idCardNumber: ID_MATCH_A,
      clarity: true,
      warnings: [],
    });
    expect(warm.status).toBe(200);
    const counter = await prisma.recruitmentOcrDailyCounter.findFirstOrThrow();
    expect(counter.count).toBe(1);

    // 把当日该 IP 计数顶到默认上限 30(造「已打满」持久状态;env 未设 → 默认 30)
    await prisma.recruitmentOcrDailyCounter.update({
      where: { id: counter.id },
      data: { count: 30 },
    });

    const blockedRecognize = await recognize('mainland_id', {
      name: '张三',
      idCardNumber: ID_MATCH_A,
      clarity: true,
      warnings: [],
    });
    expectBizError(blockedRecognize, BizCode.RECRUITMENT_OCR_DAILY_LIMIT); // 429 语义由 helper 反向锁定

    // submit(mainland)与 recognize 共享同一计数 → 同样 28060;不落图、不落记录
    const blockedSubmit = await submit(
      validPayload({ wechatCode: 'code-cap-ip', idCardNumber: ID_MATCH_B }),
    );
    expectBizError(blockedSubmit, BizCode.RECRUITMENT_OCR_DAILY_LIMIT);
    expect(await prisma.recruitmentApplication.count()).toBe(0);

    // 非大陆证件不调付费 OCR → 不受日封顶影响(免费人工通道照常)
    const foreign = await submit(
      validPayload({
        wechatCode: 'code-cap-f',
        documentTypeCode: 'passport',
        idCardNumber: 'E00112233',
      }),
    );
    expect(foreign.body.data.statusCode).toBe('manual_review');
  });

  // ===== 招新可用性收口 F2(评审稿 §3 R1):admin 改报名资料(PATCH :id)=====

  function updateApp(id: string, body: Record<string, unknown>, auth = adminAuth) {
    return request(httpServer(app))
      .patch(`${ADMIN_APPS}/${id}`)
      .set('Authorization', auth)
      .send(body);
  }

  // 直插 fixture(免 OCR/去重链干扰;字段镜像 identity spec seedApp 范式)
  function createAppRow(cycleId: string, over: Record<string, unknown> = {}) {
    return prisma.recruitmentApplication.create({
      data: {
        cycleId,
        statusCode: 'verified',
        documentTypeCode: 'mainland_id',
        isForeigner: false,
        realName: '张三',
        idCardNumber: ID_MATCH_A,
        birthDate: new Date('1990-03-07T00:00:00.000Z'),
        genderCode: 'male',
        phone: '13900007001',
        detailedAddress: '北京市朝阳区某街道 1 号',
        openid: 'dev-openid-f2-x',
        ...over,
      },
    });
  }

  it('F2-① 权限边界:无码 USER → 30100;SA 短路可改', async () => {
    const cycle = await openCycle();
    const row = await createAppRow(cycle.id, { statusCode: 'manual_review' });
    expectBizError(
      await updateApp(row.id, { detailedAddress: '新地址 1 号' }, userAuth),
      BizCode.RBAC_FORBIDDEN,
    );
    const ok = await updateApp(row.id, { detailedAddress: '新地址 1 号' });
    expect(ok.status).toBe(200);
  });

  it('F2-② verified 大陆改姓名(身份字段)→ 28045;manual_review 改姓名 → 200 + audit 掩码', async () => {
    const cycle = await openCycle();
    const verified = await createAppRow(cycle.id, { openid: 'dev-openid-f2-a' });
    expectBizError(
      await updateApp(verified.id, { realName: '张三丰' }),
      BizCode.RECRUITMENT_IDENTITY_FIELDS_LOCKED,
    );

    const manual = await createAppRow(cycle.id, {
      statusCode: 'manual_review',
      idCardNumber: ID_MATCH_B,
      phone: '13900007002',
      openid: 'dev-openid-f2-b',
    });
    const res = await updateApp(manual.id, { realName: '张三丰' });
    expect(res.status).toBe(200);
    expect(res.body.data.realName).toBe('张三丰');
    const audit = await prisma.auditLog.findFirst({
      where: { event: 'recruitment-application.update', resourceId: manual.id },
    });
    expect(audit).not.toBeNull();
    const ctx = audit?.context as {
      before?: unknown;
      after?: unknown;
      extra?: { identityChanged?: boolean };
    } | null;
    expect(ctx?.extra?.identityChanged).toBe(true);
    // 身份字段前后值仅掩码入 audit(明文姓名不落)
    expect(JSON.stringify(ctx?.before)).not.toContain('张三');
    expect(JSON.stringify(ctx?.after)).not.toContain('张三丰');
  });

  it('F2-③ 大陆记录 birthDate/genderCode 恒派生:直改 → 40000;改证件号 → 重派生 + 校验位/年龄/同轮去重闸', async () => {
    const cycle = await openCycle();
    const manual = await createAppRow(cycle.id, { statusCode: 'manual_review' });
    // 直改派生字段 → 40000
    expectBizError(await updateApp(manual.id, { birthDate: '1991-01-01' }), BizCode.BAD_REQUEST, {
      strictMessage: false,
    });
    // 校验位错误 → 40000
    expectBizError(await updateApp(manual.id, { idCardNumber: ID_INVALID }), BizCode.BAD_REQUEST, {
      strictMessage: false,
    });
    // 年龄越界 → 28010
    expectBizError(
      await updateApp(manual.id, { idCardNumber: ID_UNDERAGE }),
      BizCode.RECRUITMENT_AGE_OUT_OF_RANGE,
    );
    // 撞同轮活跃证件号 → 28003
    await createAppRow(cycle.id, {
      idCardNumber: ID_MATCH_C,
      phone: '13900007003',
      openid: 'dev-openid-f2-c',
    });
    expectBizError(
      await updateApp(manual.id, { idCardNumber: ID_MATCH_C }),
      BizCode.RECRUITMENT_DUPLICATE_APPLICATION,
    );
    // 有效改号 → birthDate/genderCode 随新号重派生(镜像 submit 派生权威)
    const ok = await updateApp(manual.id, { idCardNumber: ID_MATCH_B });
    expect(ok.status).toBe(200);
    const row = await prisma.recruitmentApplication.findUniqueOrThrow({
      where: { id: manual.id },
    });
    expect(row.idCardNumber).toBe(ID_MATCH_B);
    expect(row.birthDate?.toISOString()).toBe('1990-03-07T00:00:00.000Z');
    expect(row.genderCode).toBe(Number(ID_MATCH_B[16]) % 2 === 1 ? 'male' : 'female');
  });

  it('F2-④ 非大陆证件补录 birthDate/genderCode(F3 手动建档前置)→ 200 归一落库(verified 行亦可改身份字段)', async () => {
    const cycle = await openCycle();
    const foreign = await createAppRow(cycle.id, {
      documentTypeCode: 'passport',
      isForeigner: true,
      idCardNumber: 'E55667788',
      birthDate: null,
      genderCode: null,
      phone: '13900007004',
      openid: 'dev-openid-f2-f',
    });
    const res = await updateApp(foreign.id, { birthDate: '1992-05-20', genderCode: 'female' });
    expect(res.status).toBe(200);
    const row = await prisma.recruitmentApplication.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    expect(row.birthDate?.toISOString()).toBe('1992-05-20T00:00:00.000Z');
    expect(row.genderCode).toBe('female');
  });

  it('F2-④b 十项收口刀A:非大陆证件补录 birthDate 同样过 18-60 年龄闸(未成年 → 28010;此前补录零年龄校验)', async () => {
    const cycle = await openCycle();
    const foreign = await createAppRow(cycle.id, {
      documentTypeCode: 'passport',
      isForeigner: true,
      idCardNumber: 'E55667789',
      birthDate: null,
      genderCode: null,
      phone: '13900007005',
      openid: 'dev-openid-f2-g',
    });
    const res = await updateApp(foreign.id, { birthDate: '2015-01-01' });
    expectBizError(res, BizCode.RECRUITMENT_AGE_OUT_OF_RANGE);
  });

  it('F2-⑤ 非身份字段恒可改(verified 大陆);非法 relation → 19010;promoted/脱敏行 → 28041;空 body → 40000', async () => {
    const cycle = await openCycle();
    const verified = await createAppRow(cycle.id);
    const res = await updateApp(verified.id, {
      detailedAddress: '深圳市南山区新址 8 号',
      emergencyContacts: [
        { name: '赵一', relation: 'parent', phone: '13900007101' },
        { name: '钱二', relation: 'family', phone: '13900007102' },
      ],
    });
    expect(res.status).toBe(200);
    const audit = await prisma.auditLog.findFirst({
      where: { event: 'recruitment-application.update', resourceId: verified.id },
    });
    const ctx = audit?.context as { extra?: { identityChanged?: boolean } } | null;
    expect(ctx?.extra?.identityChanged).toBe(false);
    // audit 不落非身份字段内容(地址明文不进 extra/before/after)
    expect(JSON.stringify(audit?.context)).not.toContain('深圳市南山区');

    expectBizError(
      await updateApp(verified.id, {
        emergencyContacts: [
          { name: '赵一', relation: 'not-a-relation', phone: '13900007101' },
          { name: '钱二', relation: 'family', phone: '13900007102' },
        ],
      }),
      BizCode.EMERGENCY_CONTACT_RELATION_CODE_INVALID,
    );

    const promoted = await createAppRow(cycle.id, {
      statusCode: 'promoted',
      sensitivePurgedAt: new Date(),
      realName: null,
      idCardNumber: null,
      phone: null,
      openid: null,
    });
    expectBizError(
      await updateApp(promoted.id, { detailedAddress: '不该写入' }),
      BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
    );

    expectBizError(await updateApp(verified.id, {}), BizCode.BAD_REQUEST, {
      strictMessage: false,
    });
  });

  // ===== 招新可用性收口 F3(评审稿 §3 R3 / §6.1 E-U-3/E-U-4):单人手动建档 promote-single =====

  function promoteSingle(id: string, auth = adminAuth) {
    return request(httpServer(app))
      .post(`${ADMIN_APPS}/${id}/promote-single`)
      .set('Authorization', auth)
      .send({});
  }

  it('F3-① 权限边界:无码 USER → 30100;非 publicity(verified)→ 28041', async () => {
    const cycle = await openCycle();
    const row = await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        statusCode: 'verified',
        realName: '甲一',
        idCardNumber: 'F3ID0001',
        openid: 'f3-a-openid',
        phone: '13900008001',
      }) as never,
    });
    expectBizError(await promoteSingle(row.id, userAuth), BizCode.RBAC_FORBIDDEN);
    expectBizError(await promoteSingle(row.id), BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
  });

  it('F3-② 非大陆证件手动建档全链:缺派生 28047 → F2 补录 → 建档成功(号段与批量连续)→ 幂等重跑 28041 零重复', async () => {
    const cycle = await openCycle();
    const membersBefore = await prisma.member.count();

    // 大陆 publicity 行走批量 promote 占 26001(证明单发与批量共享同一原子号段)
    await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        realName: '乙二',
        idCardNumber: 'F3ID0002',
        openid: 'f3-cn-openid',
        phone: '13900008002',
      }) as never,
    });
    const batch = await promote(cycle.id);
    expect(batch.body.data.promotedCount).toBe(1);
    expect(batch.body.data.promoted[0].memberNo).toBe('26001');

    // 非大陆证件 publicity 行(缺 birthDate/genderCode;批量因 missing-derived-field 跳过)
    const foreign = await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        documentTypeCode: 'passport',
        isForeigner: true,
        realName: '阿福',
        idCardNumber: 'E33445566',
        birthDate: null,
        genderCode: null,
        openid: 'f3-fr-openid',
        phone: '13900008003',
        emergencyContacts: [
          { name: '丙三', relation: 'parent', phone: '13900008101' },
          { name: '丁四', relation: 'family', phone: '13900008102' },
        ],
      }) as never,
    });
    // 缺派生字段 → 28047(提示先 F2 补录)
    expectBizError(
      await promoteSingle(foreign.id),
      BizCode.RECRUITMENT_PROFILE_INCOMPLETE_FOR_PROMOTE,
    );
    // F2 补录(非大陆证件身份字段可改)
    await updateApp(foreign.id, { birthDate: '1993-08-15', genderCode: 'male' }).expect(200);

    // 单人建档成功:与批量共享号段 → 26002 连续;微信通道(openid 未被占用)
    const res = await promoteSingle(foreign.id);
    expect(res.status).toBe(200);
    expect(res.body.data.memberNo).toBe('26002');
    expect(res.body.data.loginChannel).toBe('wechat');
    expect(await prisma.member.count()).toBe(membersBefore + 2);

    const member = await prisma.member.findUniqueOrThrow({
      where: { id: res.body.data.memberId },
      include: { users: true, memberProfile: true, emergencyContacts: true },
    });
    expect(member.memberNo).toBe('26002');
    expect(member.gradeCode).toBe('volunteer');
    expect(member.users[0]?.openid).toBe('f3-fr-openid');
    expect(member.users[0]?.username).toBe('26002');
    expect(member.memberProfile?.documentNumber).toBe('E33445566');
    expect(member.memberProfile?.birthDate.toISOString()).toBe('1993-08-15T00:00:00.000Z');
    expect(member.emergencyContacts.length).toBe(2);

    // 报名行:promoted + 敏感即时清(镜像批量)
    const appRow = await prisma.recruitmentApplication.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    expect(appRow.statusCode).toBe('promoted');
    expect(appRow.promotedMemberId).toBe(member.id);
    expect(appRow.realName).toBeNull();
    expect(appRow.idCardNumber).toBeNull();
    expect(appRow.openid).toBeNull();
    expect(appRow.phone).toBeNull();
    expect(appRow.sensitivePurgedAt).not.toBeNull();

    // audit:同批量事件名 + F3 additive viaPath/channel
    const audit = await prisma.auditLog.findFirst({
      where: { event: 'recruitment-application.promote', resourceId: foreign.id },
    });
    const ctx = audit?.context as {
      extra?: { viaPath?: string; channel?: string };
    } | null;
    expect(ctx?.extra?.viaPath).toBe('promote-single');
    expect(ctx?.extra?.channel).toBe('wechat');

    // 幂等重跑:promoted 已离开 publicity → 28041,members 零增长(DoD「幂等重跑 0」)
    expectBizError(await promoteSingle(foreign.id), BizCode.RECRUITMENT_APPLICATION_WRONG_STATE);
    expect(await prisma.member.count()).toBe(membersBefore + 2);
    const singleEventKey = `recruitment-promotion:${foreign.id}`;
    expect(
      await prisma.notificationOutboxIntent.count({ where: { eventKey: singleEventKey } }),
    ).toBe(1);
    const worker = app.get(NotificationOutboxWorker);
    expect(await worker.drainEventKey(singleEventKey)).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await worker.drainEventKey(singleEventKey)).toMatchObject({ claimed: 0 });
    expect(await prisma.notification.count({ where: { recipientMemberId: member.id } })).toBe(1);
  });

  it('F3-③ 锚点择优(E-U-4):openid 被占 + phone 空闲 → 手机通道;双占 → 28046;双缺 → 28046', async () => {
    const cycle = await openCycle();

    // openid 被既有 User 占用 + phone 空闲 → 手机通道(User.phone 落 + openid 不写)
    await prisma.user.upsert({
      where: { username: 'f3-occupier-1' },
      update: {},
      create: {
        username: 'f3-occupier-1',
        passwordHash: 'x',
        role: 'USER',
        openid: 'f3-occ-openid',
      },
    });
    const rowPhone = await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        realName: '戊五',
        idCardNumber: 'F3ID0005',
        openid: 'f3-occ-openid',
        phone: '13900008005',
      }) as never,
    });
    const res = await promoteSingle(rowPhone.id);
    expect(res.status).toBe(200);
    expect(res.body.data.loginChannel).toBe('phone');
    const member = await prisma.member.findUniqueOrThrow({
      where: { id: res.body.data.memberId },
      include: { users: true },
    });
    expect(member.users[0]?.openid).toBeNull();
    expect(member.users[0]?.phone).toBe('13900008005');
    expect(member.users[0]?.phoneVerifiedAt).not.toBeNull();

    // 双占 → 28046(openid 占用 + phone 占用〔上一步建的 User 已占 13900008005〕)
    const rowBoth = await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        realName: '己六',
        idCardNumber: 'F3ID0006',
        openid: 'f3-occ-openid',
        phone: '13900008005',
      }) as never,
    });
    expectBizError(await promoteSingle(rowBoth.id), BizCode.RECRUITMENT_LOGIN_ANCHOR_UNAVAILABLE);

    // 双缺 → 28046(R3:不建无登录锚点的号)
    const rowNone = await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        realName: '庚七',
        idCardNumber: 'F3ID0007',
        openid: null,
        phone: null,
      }) as never,
    });
    expectBizError(await promoteSingle(rowNone.id), BizCode.RECRUITMENT_LOGIN_ANCHOR_UNAVAILABLE);
  });

  // ===== 招新可用性收口 F4-3b(评审稿 §2.3/E-U-5):发号后微信查询 fall-through 引导态 =====

  it('F4-w 发号后 query(微信)→ 报名行 openid 已清仍返 stage=volunteer 引导态;无报名行/INACTIVE → 28002', async () => {
    const cycle = await openCycle();
    // 发号后形态:报名行 promoted + PII 清空(openid null),User 持 openid,Member ACTIVE
    const member = await prisma.member.create({
      data: { memberNo: '26903', displayName: '癸十', status: 'ACTIVE', gradeCode: 'volunteer' },
    });
    await prisma.user.create({
      data: {
        username: '26903',
        passwordHash: 'x',
        role: 'USER',
        memberId: member.id,
        openid: 'dev-openid-f4w', // = code2session('f4w') 的 DevStub openid
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
        openid: null,
        tempNo: 'T20260033',
      },
    });

    const res = await request(httpServer(app)).post(OPEN_QUERY).send({ wechatCode: 'f4w' });
    expect(res.status).toBe(200);
    expect(res.body.data.stage).toBe('volunteer'); // 「已转志愿者 / 待入队」引导态
    expect(res.body.data.stageText).toBe('已转志愿者 / 待入队');
    expect(res.body.data.nextAction).toBe('apply-teamjoin');
    expect(res.body.data.memberNo).toBeNull(); // 公开面不泄编号
    expect(res.body.data.tempNo).toBe('T20260033');

    // 有账号但非招新出身(无 promotedMemberId 报名行)→ 维持 28002
    const member2 = await prisma.member.create({
      data: { memberNo: '26904', displayName: '子甲', status: 'ACTIVE', gradeCode: 'volunteer' },
    });
    await prisma.user.create({
      data: {
        username: '26904',
        passwordHash: 'x',
        role: 'USER',
        memberId: member2.id,
        openid: 'dev-openid-f4w2',
      },
    });
    expectBizError(
      await request(httpServer(app)).post(OPEN_QUERY).send({ wechatCode: 'f4w2' }),
      BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    );

    // INACTIVE(已离队)→ 维持 28002(不泄状态)
    await prisma.member.update({ where: { id: member.id }, data: { status: 'INACTIVE' } });
    expectBizError(
      await request(httpServer(app)).post(OPEN_QUERY).send({ wechatCode: 'f4w' }),
      BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    );
  });

  // ===== 招新可用性收口 F5(评审稿 §2.8 R5):知情同意 + 签名图 =====

  it('F5-① 契约收紧:payload 缺 privacyConsentAccepted → 40000;显式 false → 40000(⚠️ 行为变更)', async () => {
    await openCycle();
    const base = validPayload({ wechatCode: 'f5-c0', idCardNumber: ID_MATCH_A });
    delete base.privacyConsentAccepted;
    expectBizError(await submit(base), BizCode.BAD_REQUEST, { strictMessage: false });

    expectBizError(
      await submit(
        validPayload({
          wechatCode: 'f5-c1',
          idCardNumber: ID_MATCH_A,
          privacyConsentAccepted: false,
        }),
      ),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );
    expect(await prisma.recruitmentApplication.count()).toBe(0); // 双拒零落库
  });

  it('F5-② 契约收紧:缺 signatureImage → 40000,零落库(⚠️ 行为变更)', async () => {
    await openCycle();
    expectBizError(
      await submit(validPayload({ wechatCode: 'f5-no-signature' }), { signature: null }),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );
    expect(await prisma.recruitmentApplication.count()).toBe(0);
  });

  it('finding #10:主证件照声明 image/jpeg 但字节为文本 → 13016,零 OCR/零落库', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'content-fake-id-card' }), {
      image: Buffer.from('plain text pretending to be jpeg'),
    });

    expectBizError(res, BizCode.ATTACHMENT_CONTENT_TYPE_MISMATCH);
    expect(await prisma.recruitmentApplication.count()).toBe(0);
  });

  it('finding #10:签名图声明 image/png 但字节为文本 → 13016,零 OCR/零落库', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'content-fake-signature' }), {
      signature: Buffer.from('plain text pretending to be png'),
    });

    expectBizError(res, BizCode.ATTACHMENT_CONTENT_TYPE_MISMATCH);
    expect(await prisma.recruitmentApplication.count()).toBe(0);
  });

  it('finding #10:OCR 转发前拒绝伪装 JPEG 字节 → 13016', async () => {
    await openCycle();
    const res = await request(httpServer(app))
      .post(OPEN_RECOGNIZE)
      .field('documentTypeCode', 'mainland_id')
      .attach('idCardImage', Buffer.from('plain text pretending to be jpeg'), {
        filename: 'fake.jpg',
        contentType: 'image/jpeg',
      });

    expectBizError(res, BizCode.ATTACHMENT_CONTENT_TYPE_MISMATCH);
  });

  it('F5-③ 同意留痕 + 签名图全链:submit 落 stamps/key → promote 搬 profile + 报名行清空 + signed 真值', async () => {
    const cycle = await openCycle();
    const res = await submit(
      validPayload({
        wechatCode: 'f5-sig',
        idCardNumber: ID_MATCH_A,
        privacyConsentVersion: '2026-07',
      }),
      { signature: VALID_PNG_IMAGE },
    );
    expect(res.status).toBe(201);
    expect(res.body.data.statusCode).toBe('verified');

    const row = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-f5-sig' },
    });
    expect(row.privacyConsentAcceptedAt).not.toBeNull();
    expect(row.privacyConsentVersion).toBe('2026-07');
    expect(row.signatureImageKey).toMatch(/^recruitment\/signature\//);
    const sigKey = row.signatureImageKey as string;

    // 推到 publicity 后批量 promote(签名搬运走批量与单发共用内核)
    await prisma.recruitmentApplication.update({
      where: { id: row.id },
      data: { statusCode: 'publicity' },
    });
    const pr = await promote(cycle.id);
    expect(pr.body.data.promotedCount).toBe(1);
    const memberId = pr.body.data.promoted[0].memberId as string;

    const profile = await prisma.memberProfile.findFirstOrThrow({ where: { memberId } });
    expect(profile.privacyConsentSigned).toBe(true); // 搬真值(非硬编码)
    expect(profile.privacyConsentSignedAt?.toISOString()).toBe(
      row.privacyConsentAcceptedAt?.toISOString(),
    );
    expect(profile.signatureImageKey).toBe(sigKey); // R5:同一 storage 对象搬入档案

    const after = await prisma.recruitmentApplication.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.signatureImageKey).toBeNull(); // 报名行清空(blob 单一属主=member)
    expect(after.privacyConsentAcceptedAt).not.toBeNull(); // 同意留痕为脱敏留存字段,不清
  });

  it('F5-④ 存量无 consent 行 promote → privacyConsentSigned=false(⚠️ 行为变更:不再硬编码 true)', async () => {
    const cycle = await openCycle();
    await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        realName: '丑乙',
        idCardNumber: 'F5ID0001',
        openid: 'f5-legacy-openid',
        phone: '13900009001',
      }) as never,
    });
    const pr = await promote(cycle.id);
    expect(pr.body.data.promotedCount).toBe(1);
    const memberId = pr.body.data.promoted[0].memberId as string;
    const profile = await prisma.memberProfile.findFirstOrThrow({ where: { memberId } });
    expect(profile.privacyConsentSigned).toBe(false); // 存量 null → false(当事人从未签署)
    expect(profile.privacyConsentSignedAt).toBeNull();
    expect(profile.signatureImageKey).toBeNull();
  });

  // ===== 招新可用性收口 F7(评审稿 §2.9 R6):证书图上传与长期档案 =====

  const OPEN_CERTS = '/api/open/v1/recruitment/applications/certificates';

  function uploadCerts(fields: Record<string, string>, fileCount: number) {
    let req = request(httpServer(app)).post(OPEN_CERTS);
    for (const [k, v] of Object.entries({
      issuingOrg: '深圳市红十字会',
      issuedAt: '2026-07-01',
      ...fields,
    }))
      req = req.field(k, v);
    for (let i = 0; i < fileCount; i++) {
      req = req.attach('images', VALID_PNG_IMAGE, {
        filename: `cert-${i}.png`,
        contentType: 'image/png',
      });
    }
    return req;
  }

  it('finding #10:证书图声明 image/png 但字节为文本 → 13016,不落 key', async () => {
    const cycle = await openCycle();
    await createAppRow(cycle.id, {
      openid: 'dev-openid-fake-cert',
      phone: '13900009109',
    });

    const res = await request(httpServer(app))
      .post(OPEN_CERTS)
      .field('category', 'first_aid')
      .field('issuingOrg', '深圳市红十字会')
      .field('issuedAt', '2026-07-01')
      .field('wechatCode', 'fake-cert')
      .attach('images', Buffer.from('plain text pretending to be png'), {
        filename: 'fake.png',
        contentType: 'image/png',
      });

    expectBizError(res, BizCode.ATTACHMENT_CONTENT_TYPE_MISMATCH);
    const row = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-fake-cert' },
    });
    expect(row.certificateImages).toBeNull();
  });

  it('A1/F7-① 上传必填发证信息并落库;重传整类覆盖;非法/缺字段/未来日期 → 400', async () => {
    const cycle = await openCycle();
    await createAppRow(cycle.id, { openid: 'dev-openid-f7-a', phone: '13900009101' });

    const r1 = await uploadCerts({ category: 'first_aid', wechatCode: 'f7-a' }, 2);
    expect(r1.status).toBe(200);
    expect(r1.body.data).toEqual({ category: 'first_aid', imageCount: 2 });
    const row1 = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-f7-a' },
    });
    const imgs1 = row1.certificateImages as Record<string, string[]>;
    expect(imgs1.first_aid).toHaveLength(2);
    expect(imgs1.first_aid[0]).toMatch(/^recruitment\/certificate\/first_aid\//);
    expect(row1.certificateIssuanceInfo).toEqual({
      first_aid: { issuingOrg: '深圳市红十字会', issuedAt: '2026-07-01' },
    });

    const missingIssuingOrg = request(httpServer(app))
      .post(OPEN_CERTS)
      .field('category', 'bsafe')
      .field('issuedAt', '2026-07-01')
      .field('wechatCode', 'f7-a')
      .attach('images', Buffer.from('cert'), { filename: 'cert.png', contentType: 'image/png' });
    expectBizError(await missingIssuingOrg, BizCode.BAD_REQUEST, { strictMessage: false });
    const missingIssuedAt = request(httpServer(app))
      .post(OPEN_CERTS)
      .field('category', 'bsafe')
      .field('issuingOrg', '深圳市红十字会')
      .field('wechatCode', 'f7-a')
      .attach('images', Buffer.from('cert'), { filename: 'cert.png', contentType: 'image/png' });
    expectBizError(await missingIssuedAt, BizCode.BAD_REQUEST, { strictMessage: false });
    expectBizError(
      await uploadCerts({ category: 'bsafe', wechatCode: 'f7-a', issuedAt: '2099-01-01' }, 1),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );

    // 重传覆盖(2 → 1;key 全换)
    const r2 = await uploadCerts({ category: 'first_aid', wechatCode: 'f7-a' }, 1);
    expect(r2.body.data.imageCount).toBe(1);
    const row2 = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-f7-a' },
    });
    const imgs2 = row2.certificateImages as Record<string, string[]>;
    expect(imgs2.first_aid).toHaveLength(1);
    expect(imgs1.first_aid).not.toContain(imgs2.first_aid[0]);

    // 第二类并存(bsafe 不覆盖 first_aid)
    const r3 = await uploadCerts({ category: 'bsafe', wechatCode: 'f7-a' }, 1);
    expect(r3.body.data.imageCount).toBe(1);
    const row3 = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-f7-a' },
    });
    const imgs3 = row3.certificateImages as Record<string, string[]>;
    expect(Object.keys(imgs3).sort()).toEqual(['bsafe', 'first_aid']);

    // 非法 category → 400(DTO @IsIn)
    expectBizError(
      await uploadCerts({ category: 'not-a-cert', wechatCode: 'f7-a' }, 1),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );
    // 双通道 both → 400
    expectBizError(
      await uploadCerts(
        { category: 'bsafe', wechatCode: 'f7-a', phone: '13900009101', code: '888888' },
        1,
      ),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );
    // 零文件 → 400
    expectBizError(
      await uploadCerts({ category: 'bsafe', wechatCode: 'f7-a' }, 0),
      BizCode.BAD_REQUEST,
      {
        strictMessage: false,
      },
    );

    // 刀A2:终态行(rejected)不再作为写动作锚点 → 28002
    await createAppRow(cycle.id, {
      statusCode: 'rejected',
      idCardNumber: 'F7ID0002',
      phone: '13900009102',
      openid: 'dev-openid-f7-b',
    });
    expectBizError(
      await uploadCerts({ category: 'first_aid', wechatCode: 'f7-b' }, 1),
      BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    );
  });

  it('F7-② admin 取证书图 signed-URL:仅 read.record → 30100;read.sensitive → 按类别 urls;无图 → 空 items', async () => {
    const cycle = await openCycle();
    const row = await createAppRow(cycle.id, { openid: 'dev-openid-f7-c', phone: '13900009103' });
    await uploadCerts({ category: 'bsafe', wechatCode: 'f7-c' }, 2).expect(200);

    const urlPath = `${ADMIN_APPS}/${row.id}/certificate-image-urls`;
    expectBizError(
      await request(httpServer(app)).get(urlPath).set('Authorization', recordOnlyAuth),
      BizCode.RBAC_FORBIDDEN,
    );
    const ok = await request(httpServer(app)).get(urlPath).set('Authorization', sensitiveAuth);
    expect(ok.status).toBe(200);
    expect(ok.body.data.items).toHaveLength(1);
    expect(ok.body.data.items[0].category).toBe('bsafe');
    expect(ok.body.data.items[0].urls).toHaveLength(2);
    expect(ok.body.data.expiresAt).toEqual(expect.any(String));

    // 无图行 → 空 items(200,非 404:「有没有传」是合法业务信息)
    const bare = await createAppRow(cycle.id, {
      idCardNumber: 'F7ID0003',
      phone: '13900009104',
      openid: 'dev-openid-f7-d',
    });
    const empty = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${bare.id}/certificate-image-urls`)
      .set('Authorization', sensitiveAuth);
    expect(empty.status).toBe(200);
    expect(empty.body.data.items).toEqual([]);
  });

  it('A5/F7-③ promote 搬发证真值,approved 继承 verified(审核人/时间/备注),未审仍 pending,并清三列', async () => {
    const cycle = await openCycle();
    await createAppRow(cycle.id, {
      statusCode: 'publicity',
      realName: '寅丙',
      idCardNumber: 'F7ID0005',
      phone: '13900009105',
      openid: 'dev-openid-f7-e',
      birthDate: new Date('1995-03-07T00:00:00.000Z'),
      genderCode: 'male',
    });
    await uploadCerts({ category: 'first_aid', wechatCode: 'f7-e' }, 2).expect(200);
    await uploadCerts(
      {
        category: 'bsafe',
        wechatCode: 'f7-e',
        issuingOrg: '深圳市急救中心',
        issuedAt: '2026-06-15',
      },
      1,
    ).expect(200);
    const before = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-f7-e' },
    });
    const uploaded = before.certificateImages as Record<string, string[]>;
    const reviewer = await prisma.user.findUniqueOrThrow({
      where: { username: 'recruit_admin' },
      select: { id: true, memberId: true },
    });
    await prisma.recruitmentApplication.update({
      where: { id: before.id },
      data: {
        certificateReviewStatus: {
          first_aid: {
            status: 'approved',
            at: '2026-07-12T08:00:00.000Z',
            by: reviewer.id,
            note: '招新期审核已通过,证件与本人一致',
          },
        },
      },
    });

    const pr = await promote(cycle.id);
    expect(pr.body.data.promotedCount).toBe(1);
    const memberId = pr.body.data.promoted[0].memberId as string;

    const certs = await prisma.certificate.findMany({
      where: { memberId },
      orderBy: { certTypeCode: 'asc' },
    });
    expect(certs).toHaveLength(2);
    expect(certs.map((c) => c.certTypeCode)).toEqual(['bsafe', 'first_aid']);
    for (const c of certs) {
      expect(c.isInternal).toBe(false);
    }
    // 招新期 approved → 继承为 verified(审核人=reviewer.memberId〔SUPER_ADMIN 无 member → null〕/
    // 审核时间=review.at / 审核备注原样继承),不再重建成 pending。
    const firstAid = certs.find((c) => c.certTypeCode === 'first_aid');
    expect(firstAid?.certStatusCode).toBe('verified');
    expect(firstAid?.verifiedBy).toBe(reviewer.memberId);
    expect(firstAid?.verifiedAt?.toISOString()).toBe('2026-07-12T08:00:00.000Z');
    expect(firstAid?.verifyNote).toBe('招新期审核已通过,证件与本人一致');
    expect(firstAid?.issuingOrg).toBe('深圳市红十字会');
    expect(firstAid?.issuedAt.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    // 未审类别仍建 pending,verify 三字段留空,走既有 certificates verify/reject 核验流。
    const bsafe = certs.find((c) => c.certTypeCode === 'bsafe');
    expect(bsafe?.certStatusCode).toBe('pending');
    expect(bsafe?.verifiedBy).toBeNull();
    expect(bsafe?.verifiedAt).toBeNull();
    expect(bsafe?.issuingOrg).toBe('深圳市急救中心');
    expect(bsafe?.issuedAt.toISOString()).toBe('2026-06-15T00:00:00.000Z');
    expect(bsafe?.verifyNote).toBeNull();
    expect(certs.find((c) => c.certTypeCode === 'first_aid')?.imageKeys).toEqual(
      uploaded.first_aid,
    );
    expect(certs.find((c) => c.certTypeCode === 'bsafe')?.imageKeys).toEqual(uploaded.bsafe);

    // 报名行清空(blob 单一属主 = certificate)
    const after = await prisma.recruitmentApplication.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(after.certificateImages).toBeNull();
    expect(after.certificateReviewStatus).toBeNull();
    expect(after.certificateIssuanceInfo).toBeNull();
    expect(after.statusCode).toBe('promoted');
  });

  it('A5:存量证书图缺发证信息 → promote 回退占位机构与当天日期', async () => {
    const cycle = await openCycle();
    const legacy = await createAppRow(cycle.id, {
      statusCode: 'publicity',
      realName: '存量申请人',
      idCardNumber: 'F7LEGACY01',
      phone: '13900009115',
      openid: 'dev-openid-f7-legacy',
      certificateImages: { first_aid: ['recruitment/certificate/first_aid/legacy.png'] },
      certificateReviewStatus: {
        first_aid: {
          status: 'approved',
          at: '2026-07-10T08:00:00.000Z',
          by: 'missing-reviewer-id',
        },
      },
      certificateIssuanceInfo: undefined,
    });
    await promote(cycle.id).expect(200);
    const cert = await prisma.certificate.findFirstOrThrow({
      where: { member: { memberNo: { not: '' } }, certTypeCode: 'first_aid' },
      orderBy: { createdAt: 'desc' },
    });
    expect(cert.memberId).toBe(
      (await prisma.recruitmentApplication.findUniqueOrThrow({ where: { id: legacy.id } }))
        .promotedMemberId,
    );
    expect(cert.issuingOrg).toBe('申请人自报(招新上传,待核验)');
    const beijingToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(cert.issuedAt.toISOString().slice(0, 10)).toBe(beijingToday);
    // 招新期 approved 继承 verified:审核人 review.by 查无对应 User → verifiedBy 合法为 null(沿 Q-I2);
    // 审核时间继承 review.at;该存量夹具无 note → verifyNote 为空。
    expect(cert.certStatusCode).toBe('verified');
    expect(cert.verifiedBy).toBeNull();
    expect(cert.verifiedAt?.toISOString()).toBe('2026-07-10T08:00:00.000Z');
    expect(cert.verifyNote).toBeNull();
  });

  it('A2/A3/G:未审不可标、approved 禁重传、清标后可再标、驳回后复通上传', async () => {
    const cycle = await openCycle();
    const row = await createAppRow(cycle.id, {
      statusCode: 'verified',
      tempNo: 'T20269991',
      openid: 'dev-openid-g-cert',
      phone: '13900009991',
      idCardNumber: 'GCERT001',
    });
    expectBizError(
      await markThreshold(row.id, 'redCross', true),
      BizCode.RECRUITMENT_CERTIFICATE_IMAGE_REQUIRED,
    );
    await uploadCerts({ category: 'first_aid', wechatCode: 'g-cert' }, 1).expect(200);
    expectBizError(
      await markThreshold(row.id, 'redCross', true),
      BizCode.RECRUITMENT_CERTIFICATE_NOT_APPROVED,
    );
    const reviewPath = `${ADMIN_APPS}/${row.id}/certificates/first_aid/review`;
    const approved = await request(httpServer(app))
      .post(reviewPath)
      .set('Authorization', adminAuth)
      .send({ approved: true });
    expect(approved.status).toBe(200);
    expect(approved.body.data.certificates).toContainEqual(
      expect.objectContaining({
        category: 'first_aid',
        imageCount: 1,
        issuingOrg: '深圳市红十字会',
        issuedAt: '2026-07-01',
        reviewStatus: 'approved',
        reviewedBy: expect.any(String),
      }),
    );
    const detail = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${row.id}`)
      .set('Authorization', adminAuth);
    expect(detail.body.data.certificates).toEqual(approved.body.data.certificates);
    const list = await request(httpServer(app))
      .get(`${ADMIN_APPS}?cycleId=${cycle.id}`)
      .set('Authorization', adminAuth);
    expect(list.body.data.items[0].certificates).toEqual(approved.body.data.certificates);
    let db = await prisma.recruitmentApplication.findUniqueOrThrow({ where: { id: row.id } });
    expect((db.thresholdMarks as Record<string, unknown>).redCross).toBeTruthy();
    expectBizError(
      await uploadCerts({ category: 'first_aid', wechatCode: 'g-cert' }, 1),
      BizCode.RECRUITMENT_CERTIFICATE_ALREADY_APPROVED,
    );
    await markThreshold(row.id, 'redCross', false).expect(200);
    await markThreshold(row.id, 'redCross', true).expect(200);

    const rejected = await request(httpServer(app))
      .post(reviewPath)
      .set('Authorization', adminAuth)
      .send({ approved: false, note: '照片模糊,请重传' });
    expect(rejected.status).toBe(200);
    db = await prisma.recruitmentApplication.findUniqueOrThrow({ where: { id: row.id } });
    expect((db.thresholdMarks as Record<string, unknown>).redCross).toBeUndefined();
    expect(db.certificateImages).toBeNull();
    const progress = await request(httpServer(app)).post(OPEN_QUERY).send({ wechatCode: 'g-cert' });
    expect(progress.body.data.certificates).toContainEqual({
      category: 'first_aid',
      status: 'rejected',
      imageCount: 0,
      note: '照片模糊,请重传',
    });

    await uploadCerts({ category: 'first_aid', wechatCode: 'g-cert' }, 1).expect(200);
    const afterRetransmit = await request(httpServer(app))
      .post(OPEN_QUERY)
      .send({ wechatCode: 'g-cert' });
    expect(afterRetransmit.body.data.certificates).toContainEqual({
      category: 'first_aid',
      status: 'uploaded',
      imageCount: 1,
      note: null,
    });
    expect(
      await prisma.auditLog.count({
        where: { event: 'recruitment-application.certificate-review', resourceId: row.id },
      }),
    ).toBe(2);
  });

  // ⑥ 轮次开关:无 open 轮 → 28030
  it('⑥ 无 open 轮次 → 报名 28030', async () => {
    await openCycle({ statusCode: 'closed' });
    const res = await submit(validPayload({ wechatCode: 'code-g', idCardNumber: ID_MATCH_A }));
    expectBizError(res, BizCode.RECRUITMENT_CYCLE_NOT_OPEN);
  });

  // ⑥b 轮次开关:admin 已有 open 轮时再开第二个 open → 28032(至多一个 open;十项收口刀B 由通用
  //    40000 升专码,并发穿透另有 partial unique P2002 兜底同码)
  it('⑥b admin 开第二个 open 轮 → 28032(至多一个 open 轮)', async () => {
    await openCycle(); // 已存在一个 open
    const closed = await prisma.recruitmentCycle.create({
      data: { year: 2027, name: '2027 招新', statusCode: 'closed' },
    });
    const res = await request(httpServer(app))
      .patch(`${ADMIN_CYCLES}/${closed.id}`)
      .set('Authorization', adminAuth)
      .send({ statusCode: 'open' });
    expectBizError(res, BizCode.RECRUITMENT_CYCLE_OPEN_CONFLICT);
  });

  // ⑥c 容量满 → 28031
  it('⑥c 轮次容量满 → 报名 28031', async () => {
    await openCycle({ capacity: 1 });
    await submit(validPayload({ wechatCode: 'code-h1', idCardNumber: ID_MATCH_A })); // 占 1 个 verified
    const full = await submit(validPayload({ wechatCode: 'code-h2', idCardNumber: ID_MATCH_B }));
    expectBizError(full, BizCode.RECRUITMENT_CYCLE_CAPACITY_FULL);
  });

  // ⑥c2 招新人数默认不限 + capacity 可清空回不限:更新传 capacity=null → 清空 → 超原上限仍可报名
  it('⑥c2 更新 capacity=null 清空回不限 → 报名不再受 28031 限', async () => {
    const cycle = await openCycle({ capacity: 1 });
    const patched = await request(httpServer(app))
      .patch(`${ADMIN_CYCLES}/${cycle.id}`)
      .set('Authorization', adminAuth)
      .send({ capacity: null });
    expect(patched.status).toBe(200);
    expect(patched.body.data.capacity).toBeNull();
    expect(
      (await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycle.id } })).capacity,
    ).toBeNull();
    // 原上限 1,清空后连报两个均 verified(不限人数)
    const first = await submit(validPayload({ wechatCode: 'code-h3', idCardNumber: ID_MATCH_A }));
    expect(first.body.data.statusCode).toBe('verified');
    const second = await submit(validPayload({ wechatCode: 'code-h4', idCardNumber: ID_MATCH_B }));
    expect(second.body.data.statusCode).toBe('verified');
  });

  // ⑥d 十项收口刀A:documentTypeCode 白名单(⚠️ 契约收紧)——名单外任意串此前会被当非大陆证件进人工队列
  it('⑥d 提交 documentTypeCode 名单外值(abc)→ 40000(DTO @IsIn 白名单)', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'code-dt', documentTypeCode: 'abc' }));
    expectBizError(res, BizCode.BAD_REQUEST);
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
    const submitAfter = (submitAudit?.context as { after?: Record<string, unknown> }).after;
    expect(submitAfter?.isNonMainlandDocument).toBe(false);
    expect(submitAfter?.isForeigner).toBeUndefined();
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

  // ⑩c S4b 列表过滤(契约↔校验一致性修复;前端报名审核 tab smoke):
  //     cycleId/statusCode/riskLevel 进 query DTO 白名单后,带过滤参的列表不再被全局
  //     ValidationPipe forbidNonWhitelisted 误拒(原 400「property cycleId should not exist」)+ 过滤命中正确;
  //     非法 riskLevel(超 normal/high/system)经 DTO @IsIn → 400(反证白名单确在校验、未弱化全局安全设置)。
  it('⑩c S4b 列表过滤 cycleId/statusCode/riskLevel:带 filters 不再 400 + 命中正确;非法 riskLevel→400', async () => {
    const cycle = await openCycle();
    // 直接造 3 行(隔离过滤投影;riskLevel 实由 OCR 六分流落,这里直造)。同轮 idCardNumber 须各异
    //(partial unique (cycleId, idCardNumber) WHERE 非删非拒;A/B manual_review + C verified 均「活跃」受约束)。
    const seed = (over: Partial<Prisma.RecruitmentApplicationUncheckedCreateInput>) =>
      prisma.recruitmentApplication.create({
        data: {
          cycleId: cycle.id,
          statusCode: 'manual_review', // 默认人工队列态;verified 行经 over 覆盖
          documentTypeCode: 'mainland_id',
          isForeigner: false,
          realName: '过滤样本',
          ...over,
        },
      });
    const appNormal = await seed({
      riskLevel: 'normal',
      idCardNumber: ID_MATCH_A,
      verifyOutcome: 'mismatch',
    });
    const appHigh = await seed({
      riskLevel: 'high',
      idCardNumber: ID_MATCH_B,
      verifyOutcome: 'mismatch',
    });
    const appVerified = await seed({
      statusCode: 'verified',
      riskLevel: null,
      idCardNumber: ID_MATCH_C,
    });

    const list = (qs: string) =>
      request(httpServer(app)).get(`${ADMIN_APPS}${qs}`).set('Authorization', adminAuth);

    // 核心回归:带全部三过滤参 → 200(不再 400),命中 normal 行
    const filtered = await list(`?cycleId=${cycle.id}&statusCode=manual_review&riskLevel=normal`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.total).toBe(1);
    expect(filtered.body.data.items[0].id).toBe(appNormal.id);

    // 单 riskLevel=high → 命中 high 行
    const high = await list('?riskLevel=high');
    expect(high.status).toBe(200);
    expect(high.body.data.total).toBe(1);
    expect(high.body.data.items[0].id).toBe(appHigh.id);

    // 单 statusCode=verified → 命中 verified 行
    const verified = await list('?statusCode=verified');
    expect(verified.status).toBe(200);
    expect(verified.body.data.total).toBe(1);
    expect(verified.body.data.items[0].id).toBe(appVerified.id);

    // 无过滤 → 基线全 3 行(证过滤是收窄、非默认空)
    const all = await list('');
    expect(all.status).toBe(200);
    expect(all.body.data.total).toBe(3);

    // 非法 riskLevel(超出 normal/high/system)→ 400(DTO @IsIn 生效)
    const bad = await list('?riskLevel=bogus');
    expect(bad.status).toBe(400);
  });

  // ⑪ RBAC 边界:普通 USER 调 admin 列表 → 30100
  it('⑪ 普通 USER token 调 admin 报名列表 → 30100', async () => {
    const res = await request(httpServer(app)).get(ADMIN_APPS).set('Authorization', userAuth);
    expectBizError(res, BizCode.RBAC_FORBIDDEN);
  });

  // ⑪b S3 敏感字段分级(评审稿 §11):持 read.record + read.sensitive → 详情明文 + 证件照 signed-URL 200
  it('⑪b S3 · read.record+read.sensitive → 详情明文身份证号 + 证件照 signed-URL 200', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-s1', idCardNumber: ID_MATCH_A }));
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-s1' },
    });
    const detail = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${row?.id}`)
      .set('Authorization', sensitiveAuth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.idCardNumber).toBe(ID_MATCH_A); // 明文

    const img = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${row?.id}/id-card-image-url`)
      .set('Authorization', sensitiveAuth);
    expect(img.status).toBe(200);
    expect(typeof img.body.data.url).toBe('string');
    expect(img.body.data.url.length).toBeGreaterThan(0);
  });

  // ⑪c S3:仅 read.record(无 read.sensitive)→ 详情脱敏(字段集不变) + 证件照 signed-URL 30100;列表仍可见
  it('⑪c S3 · 仅 read.record → 详情脱敏 + 证件照 30100;列表(脱敏)仍 200', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-s2', idCardNumber: ID_MATCH_A }));
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-s2' },
    });

    // 详情:可见(200)但证件号脱敏;字段集不变(realName 等同名键仍在)
    const detail = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${row?.id}`)
      .set('Authorization', recordOnlyAuth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.idCardNumber).not.toBe(ID_MATCH_A);
    expect(detail.body.data.idCardNumber).toContain('*');
    expect(detail.body.data.realName).toBe('张三');

    // 证件照 signed-URL:闸已从 read.record 收紧为 read.sensitive → 30100
    const img = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${row?.id}/id-card-image-url`)
      .set('Authorization', recordOnlyAuth);
    expectBizError(img, BizCode.RBAC_FORBIDDEN);

    // 列表:read.record 仍可见(本就脱敏)
    const list = await request(httpServer(app))
      .get(ADMIN_APPS)
      .set('Authorization', recordOnlyAuth);
    expect(list.status).toBe(200);
  });

  // ⑪d S3:无任何码(普通 USER)→ 详情 + 证件照均 30100(闸优先)
  it('⑪d S3 · 普通 USER(无码)→ 详情 + 证件照 signed-URL 均 30100', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-s3', idCardNumber: ID_MATCH_A }));
    const row = await prisma.recruitmentApplication.findFirst({
      where: { openid: 'dev-openid-code-s3' },
    });
    const detail = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${row?.id}`)
      .set('Authorization', userAuth);
    expectBizError(detail, BizCode.RBAC_FORBIDDEN);
    const img = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${row?.id}/id-card-image-url`)
      .set('Authorization', userAuth);
    expectBizError(img, BizCode.RBAC_FORBIDDEN);
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

  // =====================================================================
  // OCR 鉴伪版充分利用(2026-06-29;评审稿 recruitment-ocr-anti-forgery-enrichment-review.md §8 D1-D4)
  // =====================================================================

  // 富信封:DevStub 注入扩展字段 + 证件类型 + 卡片级告警 + 两裁剪图 base64。
  // 故意令 OCR 的 sex/birth 与号码推导**不同**(沿 D2:OCR 仅回显不覆盖);address 等供落库/回显。
  const CARD_CROP_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01]).toString('base64');
  const PORTRAIT_CROP_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x02]).toString('base64');
  function richOcr(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: '张三',
      idCardNumber: ID_MATCH_A,
      clarity: true,
      warnings: [],
      documentType: '中华人民共和国居民身份证',
      extendedFields: {
        sex: { content: '女', reflect: false, incomplete: false }, // 故意 ≠ 号码推导(male)
        nation: { content: '汉', reflect: true, incomplete: false },
        birth: { content: '2000/1/1', reflect: false, incomplete: false }, // 故意 ≠ 号码推导(1990-03-07)
        address: { content: '北京市朝阳区某街道 99 号', reflect: false, incomplete: true },
        authority: { content: '北京市公安局朝阳分局', reflect: false, incomplete: false },
        validDate: { content: '2010.07.21-2020.07.21', reflect: false, incomplete: false },
      },
      cardWarnings: {
        copy: false,
        reshoot: false,
        ps: false,
        border: true,
        occlusion: false,
        blur: false,
      },
      cardImageBase64: CARD_CROP_B64,
      portraitImageBase64: PORTRAIT_CROP_B64,
      ...over,
    };
  }

  // D1:recognize 鉴伪版扩展回显(ocrDetail:字段级 reflect/incomplete + 卡片级告警 + 证件类型);**裁剪图 base64 绝不在响应**
  it('OCR⑤(D1) recognize 鉴伪版扩展回显 ocrDetail;裁剪图 base64 不在响应', async () => {
    await openCycle();
    const res = await recognize('mainland_id', richOcr());
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.clarityOk).toBe(true);
    // 字段级回显(content + reflect/incomplete)
    expect(d.ocrDetail.address).toEqual({
      content: '北京市朝阳区某街道 99 号',
      reflect: false,
      incomplete: true,
    });
    expect(d.ocrDetail.nation).toEqual({ content: '汉', reflect: true, incomplete: false });
    expect(d.ocrDetail.sex.content).toBe('女');
    expect(d.ocrDetail.documentType).toBe('中华人民共和国居民身份证');
    // 卡片级质量/防伪告警全集(border=true)
    expect(d.ocrDetail.cardWarnings).toEqual({
      copy: false,
      reshoot: false,
      ps: false,
      border: true,
      occlusion: false,
      blur: false,
    });
    // L3:裁剪图 base64 绝不进 recognize 响应(全响应体不含注入的 base64 串)
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain(CARD_CROP_B64);
    expect(blob).not.toContain(PORTRAIT_CROP_B64);
  });

  // D2 + D3:submit matched → verified;落 4 OCR 列(住址/民族/签发机关/有效期)+ 2 裁剪图 key;
  // **gender/birth 仍来自号码推导**(OCR 的 sex=女/birth=2000 不覆盖 male/1990-03-07)。
  it('OCR⑥(D2/D3) submit 落 4 OCR 列 + 2 裁剪图 key;gender/birth 恒号码推导(OCR 不覆盖)', async () => {
    await openCycle();
    const res = await submit(validPayload({ wechatCode: 'code-rich', idCardNumber: ID_MATCH_A }), {
      ocr: richOcr(),
    });
    expect(res.body.data.statusCode).toBe('verified');
    const row = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-code-rich' },
    });
    // 4 OCR 列落库(顾问式存档)
    expect(row.ocrAddress).toBe('北京市朝阳区某街道 99 号');
    expect(row.ocrNation).toBe('汉');
    expect(row.ocrAuthority).toBe('北京市公安局朝阳分局');
    expect(row.ocrValidDate).toBe('2010.07.21-2020.07.21');
    // 2 裁剪图 key 非空 + 前缀正确
    expect(row.idCardCropImageKey).toMatch(/^recruitment\/id-card-crop\//);
    expect(row.idCardPortraitImageKey).toMatch(/^recruitment\/id-card-portrait\//);
    // **权威性铁律**:gender/birth 仍来自身份证号(male / 1990-03-07),OCR 的 sex/birth 不覆盖
    expect(row.genderCode).toBe('male');
    expect(row.birthDate?.toISOString()).toBe('1990-03-07T00:00:00.000Z');
  });

  // D3:不返裁剪图的富信封提交仍成功;两裁剪 key 列降级为 null(接口未返裁剪图不阻断)
  it('OCR⑦(D3) submit 不返裁剪图 → 两裁剪 key 列 null,提交仍成功', async () => {
    await openCycle();
    const res = await submit(
      validPayload({ wechatCode: 'code-nocrop', idCardNumber: ID_MATCH_A }),
      {
        ocr: richOcr({ cardImageBase64: undefined, portraitImageBase64: undefined }),
      },
    );
    expect(res.body.data.statusCode).toBe('verified');
    const row = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-code-nocrop' },
    });
    expect(row.idCardCropImageKey).toBeNull();
    expect(row.idCardPortraitImageKey).toBeNull();
    // 4 OCR 列仍落(扩展字段在;裁剪图缺只影响两 key 列)
    expect(row.ocrAddress).toBe('北京市朝阳区某街道 99 号');
  });

  // D4:admin 三图 signed-URL(原图 + 主体裁剪 + 头像裁剪)+ 4 OCR 列敏感分级。
  it('OCR⑧(D4) admin 三图 URL + 4 OCR 列敏感分级(sensitive 明文 / record-only 脱敏 null)', async () => {
    await openCycle();
    await submit(validPayload({ wechatCode: 'code-d4', idCardNumber: ID_MATCH_A }), {
      ocr: richOcr(),
    });
    const row = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: 'dev-openid-code-d4' },
    });

    // 三图 URL(read.sensitive 闸内):原图 + 两裁剪图 URL 均非空
    const img = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${row.id}/id-card-image-url`)
      .set('Authorization', sensitiveAuth);
    expect(img.status).toBe(200);
    expect(typeof img.body.data.url).toBe('string');
    expect(img.body.data.url.length).toBeGreaterThan(0);
    expect(typeof img.body.data.cropImageUrl).toBe('string');
    expect(img.body.data.cropImageUrl.length).toBeGreaterThan(0);
    expect(typeof img.body.data.portraitImageUrl).toBe('string');
    expect(img.body.data.portraitImageUrl.length).toBeGreaterThan(0);

    // 详情:read.sensitive → 4 OCR 列明文
    const detailS = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${row.id}`)
      .set('Authorization', sensitiveAuth);
    expect(detailS.body.data.ocrAddress).toBe('北京市朝阳区某街道 99 号');
    expect(detailS.body.data.ocrNation).toBe('汉');
    expect(detailS.body.data.hasIdCardCropImage).toBe(true);
    expect(detailS.body.data.hasIdCardPortraitImage).toBe(true);

    // 详情:仅 read.record(脱敏级)→ 4 OCR 列 null(字段集不变,值随码脱敏);has-flag 仍可见(非 PII)
    const detailR = await request(httpServer(app))
      .get(`${ADMIN_APPS}/${row.id}`)
      .set('Authorization', recordOnlyAuth);
    expect(detailR.status).toBe(200);
    expect(detailR.body.data.ocrAddress).toBeNull();
    expect(detailR.body.data.ocrNation).toBeNull();
    expect(detailR.body.data.ocrAuthority).toBeNull();
    expect(detailR.body.data.ocrValidDate).toBeNull();
    expect(detailR.body.data.hasIdCardCropImage).toBe(true);
  });

  // Ⓜ manual_review(大陆 OCR 不匹配)→ 人工 resolve approve → verified + 发号
  // (人工是 manual_review 最终权威:看图后可放行真实申请人,「对不上转人工不误杀」)
  it('Ⓜ manual_review(OCR 不匹配,申请人确认③)→ resolve approve → verified + 发号(人工最终权威)', async () => {
    await openCycle();
    // S4b:mismatch 经三选一之③(applicantConfirmedOcrWrong)落普通人工,admin 看图放行真实申请人
    await submit(
      validPayload({
        wechatCode: 'code-mr',
        idCardNumber: ID_MATCH_A,
        applicantConfirmedOcrWrong: true,
      }),
      { ocr: { name: '李四', idCardNumber: ID_MATCH_A, clarity: true } },
    );
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
    await submit(
      validPayload({
        wechatCode: 'code-mr2',
        idCardNumber: ID_MATCH_A,
        applicantConfirmedOcrWrong: true,
      }),
      { ocr: { name: '李四', idCardNumber: ID_MATCH_A, clarity: true } },
    );
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

  it('finding #6:同一 manual_review 并发 approve || reject → 恰一方成功,败者 NOT_PENDING_MANUAL', async () => {
    const cycle = await openCycle();
    const manual = await createAppRow(cycle.id, {
      statusCode: 'manual_review',
      openid: 'dev-openid-manual-race',
      phone: '13900007991',
      idCardNumber: 'MANUAL-RACE-001',
    });
    const results = await Promise.all([
      request(httpServer(app))
        .post(`${ADMIN_APPS}/${manual.id}/resolve`)
        .set('Authorization', adminAuth)
        .send({ approved: true, reviewNote: 'race approve' }),
      request(httpServer(app))
        .post(`${ADMIN_APPS}/${manual.id}/resolve`)
        .set('Authorization', adminAuth)
        .send({ approved: false, reviewNote: 'race reject' }),
    ]);

    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    const loser = results.find((result) => result.status !== 200);
    expect(loser).toBeDefined();
    expectBizError(loser!, BizCode.RECRUITMENT_APPLICATION_NOT_PENDING_MANUAL);
    const row = await prisma.recruitmentApplication.findUniqueOrThrow({
      where: { id: manual.id },
      select: { statusCode: true },
    });
    expect(['verified', 'rejected']).toContain(row.statusCode);
    expect(await prisma.auditLog.count({ where: { resourceId: manual.id } })).toBe(1);
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
  async function seedThresholdCertificateImages(id: string) {
    await prisma.recruitmentApplication.update({
      where: { id },
      data: {
        certificateImages: {
          first_aid: [`recruitment/certificate/first_aid/test/${id}.png`],
          bsafe: [`recruitment/certificate/bsafe/test/${id}.png`],
        },
        certificateReviewStatus: {
          first_aid: { status: 'approved', at: new Date().toISOString(), by: 'fixture-admin' },
          bsafe: { status: 'approved', at: new Date().toISOString(), by: 'fixture-admin' },
        },
      },
    });
  }
  async function markAll(id: string) {
    await seedThresholdCertificateImages(id);
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
    await seedThresholdCertificateImages(appRow.id);
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

    // 非法态:非 verified/pending_evaluation 报名标门槛 → 28041(S4b:mismatch 经确认③落 manual_review 行)
    const mm = await submit(
      validPayload({
        wechatCode: 'p2-2b',
        idCardNumber: ID_MISMATCH,
        applicantConfirmedOcrWrong: true,
      }),
      { ocr: { name: '别人', idCardNumber: ID_MISMATCH, clarity: true } },
    );
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

  it('刀A4 markThreshold 并发标不同项 → 行锁后两项均保留,JSON 不丢更新', async () => {
    await openCycle();
    const appRow = await submitVerified('a4-lock', ID_MATCH_A);
    const [a, b] = await Promise.all([
      markThreshold(appRow.id, 'patrol1', true),
      markThreshold(appRow.id, 'patrol2', true),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const row = await prisma.recruitmentApplication.findUniqueOrThrow({
      where: { id: appRow.id },
    });
    const marks = row.thresholdMarks as Record<string, unknown>;
    expect(Object.keys(marks).sort()).toEqual(['patrol1', 'patrol2']);
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

  it('㉕(二期) 公示名单:拼音序 + 拟发编号预览 + 零敏感 + 非大陆证件缺派生字段不占号', async () => {
    const cycle = await openCycle();
    // 三大陆:张三/李四/王五(拼音 zhang/li/wang)
    const zhang = await submitVerified('p2-5z', ID_MATCH_A, '张三');
    const li = await submitVerified('p2-5l', ID_MATCH_B, '李四');
    const wang = await submitVerified('p2-5w', ID_MATCH_C, '王五');
    for (const a of [zhang, li, wang]) {
      await markAll(a.id);
      await evaluate(a.id, true);
    }
    // 非大陆证件(护照):拼音 '阿' a 排最前;manual_review → resolve → 门槛 → 评定 → publicity
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
    // 非大陆证件行因缺 birthDate/genderCode 仍不占号;大陆按拼音序 26001/26002/26003
    expect(data.items[0]).toMatchObject({
      realName: '阿福',
      isNonMainlandDocument: true,
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
      'isNonMainlandDocument',
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

  async function promotionWriteSnapshot(cycleId: string, applicationIds: string[]) {
    const [
      cycle,
      applications,
      memberCount,
      userCount,
      profileCount,
      contactCount,
      membershipCount,
      outboxCount,
      auditCount,
    ] = await Promise.all([
      prisma.recruitmentCycle.findUniqueOrThrow({
        where: { id: cycleId },
        select: { memberNoSeq: true },
      }),
      prisma.recruitmentApplication.findMany({
        where: { id: { in: applicationIds } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          statusCode: true,
          promotedMemberId: true,
          sensitivePurgedAt: true,
          realName: true,
          idCardNumber: true,
          phone: true,
          openid: true,
          idCardCropImageKey: true,
          idCardPortraitImageKey: true,
        },
      }),
      prisma.member.count(),
      prisma.user.count(),
      prisma.memberProfile.count(),
      prisma.emergencyContact.count(),
      prisma.memberOrganizationMembership.count(),
      prisma.notificationOutboxIntent.count({
        where: { aggregateId: { in: applicationIds } },
      }),
      prisma.auditLog.count({
        where: {
          event: 'recruitment-application.promote',
          resourceId: { in: applicationIds },
        },
      }),
    ]);
    return {
      memberNoSeq: cycle.memberNoSeq,
      applications,
      memberCount,
      userCount,
      profileCount,
      contactCount,
      membershipCount,
      outboxCount,
      auditCount,
    };
  }

  it('㉖(二期) 一键发号:公示→建 User+Member+档案+紧急联系人;{YY}{NNN} 拼音序;两层身份(无部门无级别);报名敏感清', async () => {
    const cycle = await openCycle();
    const membersBefore = await prisma.member.count();
    await toPublicity('p3-z', ID_MATCH_A, '张三'); // zhang
    await toPublicity('p3-l', ID_MATCH_B, '李四'); // li
    await toPublicity('p3-w', ID_MATCH_C, '王五'); // wang

    // 十项收口刀C/E fixture:给「李四」行预置 OCR 产物/裁剪图/换绑轨迹——promote 须即时清
    // (刀C,此前漏清=永久残留),头像裁剪图须转 User.avatarKey(刀E)。
    const liCropKey = 'recruitment-id-card-crop/test/li-crop.jpg';
    const liPortraitKey = 'recruitment-id-card-portrait/test/li-portrait.jpg';
    await storage.putObject({
      key: liCropKey,
      body: Buffer.from('crop'),
      contentType: 'image/jpeg',
    });
    await storage.putObject({
      key: liPortraitKey,
      body: Buffer.from('portrait'),
      contentType: 'image/jpeg',
    });
    await prisma.recruitmentApplication.updateMany({
      where: { cycleId: cycle.id, realName: '李四' },
      data: {
        ocrAddress: '身份证OCR住址某某路1号',
        ocrNation: '汉',
        ocrAuthority: '某某公安局',
        ocrValidDate: '2020.01.01-2040.01.01',
        idCardCropImageKey: liCropKey,
        idCardPortraitImageKey: liPortraitKey,
        phoneChangeReason: '换机',
        phoneBindingHistory: [{ from: '13800000000', to: '13800000001', at: '2026-07-01' }],
      },
    });

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
        users: true,
        memberProfile: true,
        emergencyContacts: true,
        memberOrganizationMemberships: true,
      },
    });
    // 招新闭环优化 S5(评审稿 §5.2a;推翻 phase-3 E-J-6 双表示):promote 即赋志愿者身份 ——
    // gradeCode='volunteer' + 恰 1 条 active VOL 归口部门(入队才换目标部门 + 升 level-1)。
    expect(li.gradeCode).toBe('volunteer');
    expect(li.memberOrganizationMemberships.length).toBe(1);
    const volOrg = await prisma.organization.findFirstOrThrow({ where: { code: 'VOL' } });
    expect(li.memberOrganizationMemberships[0].organizationId).toBe(volOrg.id);
    expect(li.memberOrganizationMemberships[0].deletedAt).toBeNull();
    expect(li.displayName).toBe('李四');
    // wrinkle③ User:openid 绑定、username=memberNo、passwordHash 非空(密码登录天然关闭)、memberId 回链
    // 队员账号闭环 v2:User.memberId 改一对多(partial unique),users 数组;刚 promote
    // 出的队员恰好只有这一条 live 关联,故 users[0] 与 v1 单条 user 断言逐字等价。
    expect(li.users.length).toBe(1);
    expect(li.users[0]?.openid).toBe('dev-openid-p3-l');
    expect(li.users[0]?.username).toBe('26001');
    expect(li.users[0]?.passwordHash).toBeTruthy();
    expect(li.users[0]?.memberId).toBe(li.id);
    // MemberProfile 映射 + email null(M-1)+ 证件照搬入(wrinkle①)
    expect(li.memberProfile?.realName).toBe('李四');
    expect(li.memberProfile?.documentNumber).toBe(ID_MATCH_B);
    // F1 fixture 手机唯一化后动态引用(语义不变:profile.mobile = 报名行 phone 原值搬运)
    expect(li.memberProfile?.mobile).toBe(phoneFor('p3-l'));
    expect(li.memberProfile?.email).toBeNull();
    expect(li.memberProfile?.joinSourceCode).toBe('recruitment');
    expect(li.memberProfile?.privacyConsentSigned).toBe(true);
    expect(li.memberProfile?.idCardImageKey).toBeTruthy();
    // 十项收口刀E:建档搬运补齐——区县→residenceArea、详址→detailedAddress(此前被销毁无落点);
    // 未填 profileExtra 不无中生有;OCR 头像裁剪图 → 账号头像(同一 storage 对象属主转 user)
    expect(li.memberProfile?.residenceArea).toBeTruthy();
    expect(li.memberProfile?.detailedAddress).toBeTruthy();
    expect(li.memberProfile?.profileExtra).toBeNull();
    expect(li.users[0]?.avatarKey).toBe(liPortraitKey);
    expect(await storage.headObject(liCropKey)).toMatchObject({ exists: false });
    expect(await storage.headObject(liPortraitKey)).toMatchObject({ exists: true });
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
    expect(liApp.detailedAddress).toBeNull();
    // 十项收口刀C:OCR 产物/裁剪图 key/换绑轨迹一并即时清(此前漏清 → promoted 行永久残留高敏 PII)
    expect(liApp.ocrAddress).toBeNull();
    expect(liApp.ocrNation).toBeNull();
    expect(liApp.ocrAuthority).toBeNull();
    expect(liApp.ocrValidDate).toBeNull();
    expect(liApp.idCardCropImageKey).toBeNull();
    expect(liApp.idCardPortraitImageKey).toBeNull();
    expect(liApp.phoneChangeReason).toBeNull();
    expect(liApp.phoneBindingHistory).toBeNull();
    expect(liApp.sensitivePurgedAt).toBeTruthy();
    expect(liApp.cityDistrict).toBe('北京市朝阳区'); // 脱敏统计永久留存
    // cycle.memberNoSeq 自增到 3
    const cy = await prisma.recruitmentCycle.findFirstOrThrow({ where: { id: cycle.id } });
    expect(cy.memberNoSeq).toBe(3);
    await storage.deleteObject(liPortraitKey);
  });

  it('㉖-crop-fail batch/single 删除异常安全失败：按序只删 promotable，业务/audit/outbox/号段/清敏字段零写', async () => {
    const cycle = await openCycle();
    const occupiedOpenid = 'crop-fail-bound-openid';
    const occupier = await prisma.user.create({
      data: {
        username: 'crop-fail-bound-user',
        passwordHash: 'x',
        role: 'USER',
        openid: occupiedOpenid,
      },
    });
    const liKey = 'recruitment/crop/e2e-li-raw-sensitive.jpg';
    const wangSkipKey = 'recruitment/crop/e2e-wang-skip-raw-sensitive.jpg';
    const zhangKey = 'recruitment/crop/e2e-zhang-raw-sensitive.jpg';
    const zhang = await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        realName: '张三',
        idCardNumber: 'CROPFAIL0001',
        openid: 'crop-fail-zhang-openid',
        idCardCropImageKey: zhangKey,
        idCardPortraitImageKey: 'recruitment/portrait/e2e-zhang-sensitive.jpg',
      }) as never,
    });
    const wang = await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        realName: '王五',
        idCardNumber: 'CROPFAIL0002',
        openid: occupiedOpenid,
        idCardCropImageKey: wangSkipKey,
        idCardPortraitImageKey: 'recruitment/portrait/e2e-wang-sensitive.jpg',
      }) as never,
    });
    const li = await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        realName: '李四',
        idCardNumber: 'CROPFAIL0003',
        openid: 'crop-fail-li-openid',
        idCardCropImageKey: liKey,
        idCardPortraitImageKey: 'recruitment/portrait/e2e-li-sensitive.jpg',
      }) as never,
    });
    const applicationIds = [zhang.id, wang.id, li.id];
    const before = await promotionWriteSnapshot(cycle.id, applicationIds);
    const batchProviderMessage = `COS secret bucket failed for ${zhangKey}`;
    const singleProviderMessage = `provider credential leaked for ${liKey}`;
    const deleteSpy = jest
      .spyOn(storage, 'deleteObject')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error(batchProviderMessage))
      .mockRejectedValueOnce(new Error(singleProviderMessage));

    try {
      const batch = await promote(cycle.id);
      expectBizError(batch, BizCode.INTERNAL_ERROR);
      expect(JSON.stringify(batch.body)).not.toContain(zhangKey);
      expect(JSON.stringify(batch.body)).not.toContain(batchProviderMessage);
      expect(deleteSpy.mock.calls.map(([key]) => key)).toEqual([liKey, zhangKey]);
      expect(deleteSpy).not.toHaveBeenCalledWith(wangSkipKey);
      expect(deleteSpy).not.toHaveBeenCalledWith(expect.stringContaining('/portrait/'));
      expect(await promotionWriteSnapshot(cycle.id, applicationIds)).toEqual(before);

      const single = await promoteSingle(li.id);
      expectBizError(single, BizCode.INTERNAL_ERROR);
      expect(JSON.stringify(single.body)).not.toContain(liKey);
      expect(JSON.stringify(single.body)).not.toContain(singleProviderMessage);
      expect(deleteSpy.mock.calls.map(([key]) => key)).toEqual([liKey, zhangKey, liKey]);
      expect(await promotionWriteSnapshot(cycle.id, applicationIds)).toEqual(before);
    } finally {
      deleteSpy.mockRestore();
      await prisma.user.delete({ where: { id: occupier.id } });
    }
  });

  it('㉖-crop-retry batch/single 删除成功后 DB 失败：key 暂留、对象已缺失，修复后 absent-delete 幂等重试成功', async () => {
    const cycle = await openCycle({ memberNoSeq: 999 });
    const batchKey = 'recruitment/crop/e2e-batch-db-retry.jpg';
    const singleKey = 'recruitment/crop/e2e-single-db-retry.jpg';
    const batchRow = await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        realName: '李四',
        idCardNumber: 'CROPRETRY0001',
        openid: 'crop-retry-batch-openid',
        idCardCropImageKey: batchKey,
      }) as never,
    });
    await storage.putObject({
      key: batchKey,
      body: Buffer.from('batch crop'),
      contentType: 'image/jpeg',
    });

    const originalDelete = storage.deleteObject.bind(storage);
    const deleteSpy = jest
      .spyOn(storage, 'deleteObject')
      .mockImplementation((key) => originalDelete(key));
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      const batchBefore = await promotionWriteSnapshot(cycle.id, [batchRow.id]);
      expectBizError(await promote(cycle.id), BizCode.RECRUITMENT_MEMBER_NO_EXHAUSTED);
      expect(await storage.headObject(batchKey)).toMatchObject({ exists: false });
      expect(await promotionWriteSnapshot(cycle.id, [batchRow.id])).toEqual(batchBefore);
      expect(
        await prisma.recruitmentApplication.findUniqueOrThrow({ where: { id: batchRow.id } }),
      ).toMatchObject({
        statusCode: 'publicity',
        idCardCropImageKey: batchKey,
        promotedMemberId: null,
        sensitivePurgedAt: null,
      });

      await prisma.recruitmentCycle.update({
        where: { id: cycle.id },
        data: { memberNoSeq: 0 },
      });
      const batchRetry = await promote(cycle.id);
      expect(batchRetry.status).toBe(200);
      expect(batchRetry.body.data.promoted[0].memberNo).toBe('26001');
      expect(await storage.headObject(batchKey)).toMatchObject({ exists: false });
      expect(
        await prisma.recruitmentApplication.findUniqueOrThrow({ where: { id: batchRow.id } }),
      ).toMatchObject({
        statusCode: 'promoted',
        idCardCropImageKey: null,
        sensitivePurgedAt: expect.any(Date),
      });

      const singleRow = await prisma.recruitmentApplication.create({
        data: publicityRow({
          cycleId: cycle.id,
          realName: '张三',
          idCardNumber: 'CROPRETRY0002',
          openid: 'crop-retry-single-openid',
          idCardCropImageKey: singleKey,
        }) as never,
      });
      await storage.putObject({
        key: singleKey,
        body: Buffer.from('single crop'),
        contentType: 'image/jpeg',
      });
      await prisma.recruitmentCycle.update({
        where: { id: cycle.id },
        data: { memberNoSeq: 999 },
      });
      const singleBefore = await promotionWriteSnapshot(cycle.id, [singleRow.id]);
      expectBizError(await promoteSingle(singleRow.id), BizCode.RECRUITMENT_MEMBER_NO_EXHAUSTED);
      expect(await storage.headObject(singleKey)).toMatchObject({ exists: false });
      expect(await promotionWriteSnapshot(cycle.id, [singleRow.id])).toEqual(singleBefore);
      expect(
        await prisma.recruitmentApplication.findUniqueOrThrow({ where: { id: singleRow.id } }),
      ).toMatchObject({
        statusCode: 'publicity',
        idCardCropImageKey: singleKey,
        promotedMemberId: null,
        sensitivePurgedAt: null,
      });

      await prisma.recruitmentCycle.update({
        where: { id: cycle.id },
        data: { memberNoSeq: 1 },
      });
      const singleRetry = await promoteSingle(singleRow.id);
      expect(singleRetry.status).toBe(200);
      expect(singleRetry.body.data.memberNo).toBe('26002');
      expect(await storage.headObject(singleKey)).toMatchObject({ exists: false });
      expect(
        await prisma.recruitmentApplication.findUniqueOrThrow({ where: { id: singleRow.id } }),
      ).toMatchObject({
        statusCode: 'promoted',
        idCardCropImageKey: null,
        sensitivePurgedAt: expect.any(Date),
      });
      expect(deleteSpy.mock.calls.map(([key]) => key)).toEqual([
        batchKey,
        batchKey,
        singleKey,
        singleKey,
      ]);
      const safeAbsentWarning = 'LocalProvider deleteObject: object already absent (idempotent)';
      expect(warnSpy.mock.calls.filter(([message]) => message === safeAbsentWarning)).toHaveLength(
        2,
      );
      const warningText = warnSpy.mock.calls.flat().map(String).join(' ');
      expect(warningText).not.toContain(batchKey);
      expect(warningText).not.toContain(singleKey);
    } finally {
      warnSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  // ===== 统一通知 S3(评审稿 §6.4 / 招新 §9.1):发号 → 定向通知(站内 + 微信)=====

  it('㉖d(outbox) 发号与每个 targeted@1 intent 同次 commit', async () => {
    const cycle = await openCycle();
    await toPublicity('s3-z', ID_MATCH_A, '张三');
    await toPublicity('s3-l', ID_MATCH_B, '李四');

    const res = await promote(cycle.id);
    expect(res.body.data.promotedCount).toBe(2);
    const promoted = res.body.data.promoted as Array<{
      applicationId: string;
      memberId: string;
      memberNo: string;
    }>;

    for (const p of promoted) {
      const intents = await prisma.notificationOutboxIntent.findMany({
        where: { destinationRef: p.memberId },
      });
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({
        eventKey: `recruitment-promotion:${p.applicationId}`,
        eventType: 'notification.targeted',
        payloadVersion: 1,
        aggregateType: 'recruitment_application',
        destinationRef: p.memberId,
        status: 'pending',
      });
      expect(intents[0].payload).toMatchObject({
        recipientMemberId: p.memberId,
        channels: ['in-app', 'wechat'],
      });
      const payload = intents[0].payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual([
        'body',
        'channels',
        'notificationTypeCode',
        'recipientMemberId',
        'title',
      ]);
      const serialized = JSON.stringify(payload);
      expect(serialized).toContain(p.memberNo);
      expect(serialized).not.toContain('dev-openid');
      expect(serialized).not.toMatch(/1[3-9]\d{9}/);
      expect(serialized).not.toContain('张三');
      expect(serialized).not.toContain('李四');
      expect(serialized).not.toContain(ID_MATCH_A);
      expect(serialized).not.toContain(ID_MATCH_B);
    }

    // 重复 HTTP 请求不得生成新 intent；JIT drain 在单轮上限内连续消费 2 parent + 2 wechat child，
    // 且只能为每个 member 建一条站内 Effect。
    const repeated = await promote(cycle.id);
    expect(repeated.status).toBe(200);
    expect(repeated.body.data.promotedCount).toBe(0);
    expect(await prisma.notificationOutboxIntent.count()).toBe(2);
    const worker = app.get(NotificationOutboxWorker);
    expect(await worker.drainOnce()).toMatchObject({ claimed: 4, succeeded: 4 });
    expect(await worker.drainOnce()).toMatchObject({ claimed: 0 });
    for (const p of promoted) {
      expect(await prisma.notification.count({ where: { recipientMemberId: p.memberId } })).toBe(1);
    }
  });

  it('㉖e(outbox mutation) batch 第二个 enqueue 失败→前一个 intent 与整批发号同时回滚', async () => {
    const cycle = await openCycle();
    await toPublicity('s3-err-a', ID_MATCH_A, '张三');
    await toPublicity('s3-err-b', ID_MATCH_B, '李四');

    const outbox = app.get(NotificationOutboxService);
    const originalEnqueue = outbox.enqueue.bind(outbox);
    const spy = jest
      .spyOn(outbox, 'enqueue')
      .mockImplementationOnce((input, client) => originalEnqueue(input, client))
      .mockRejectedValueOnce(new Error('enqueue boom'));
    try {
      const res = await promote(cycle.id);
      expect(res.status).toBe(500);
      expect(await prisma.member.count({ where: { memberNo: '26001' } })).toBe(0);
      expect(await prisma.member.count({ where: { memberNo: '26002' } })).toBe(0);
      expect(await prisma.notificationOutboxIntent.count()).toBe(0);
      const rows = await prisma.recruitmentApplication.findMany({
        where: { openid: { in: ['dev-openid-s3-err-a', 'dev-openid-s3-err-b'] } },
      });
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.statusCode === 'publicity')).toBe(true);
      expect(
        await prisma.recruitmentCycle.findUniqueOrThrow({ where: { id: cycle.id } }),
      ).toMatchObject({ memberNoSeq: 0 });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
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

  it('㉗(二期) 幂等:重跑 promote 命中 0(promoted 已离开 publicity);同报名不重复建 Member;不双建 VOL 部门', async () => {
    const cycle = await openCycle();
    await toPublicity('p3i-a', ID_MATCH_A, '陈一');
    const first = await promote(cycle.id);
    expect(first.body.data.promotedCount).toBe(1);
    const membersAfterFirst = await prisma.member.count();
    // S5:首跑即建恰 1 条 active VOL 归口部门
    const memberId = first.body.data.promoted[0].memberId as string;
    expect(
      await prisma.memberOrganizationMembership.count({
        where: { memberId, deletedAt: null, membershipType: 'PRIMARY', status: 'ACTIVE' },
      }),
    ).toBe(1);

    const second = await promote(cycle.id);
    expect(second.body.data.promotedCount).toBe(0);
    expect(second.body.data.skippedCount).toBe(0);
    expect(await prisma.member.count()).toBe(membersAfterFirst); // 不重复建 Member
    // S5:重跑命中 0 → 不双建 VOL 部门(仍恰 1 条 active)
    expect(
      await prisma.memberOrganizationMembership.count({
        where: { memberId, deletedAt: null, membershipType: 'PRIMARY', status: 'ACTIVE' },
      }),
    ).toBe(1);
  });

  it('㉘(二期) 港澳台证件补齐资料后进入批量发号,与大陆申请同批建档', async () => {
    const cycle = await openCycle();
    const fs = await submit(
      validPayload({
        wechatCode: 'p3f-f',
        documentTypeCode: 'hk_macau_permit',
        idCardNumber: 'H99887766',
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
    await updateApp(foreign.id, { birthDate: '1992-05-20', genderCode: 'female' }).expect(200);
    await markAll(foreign.id);
    await evaluate(foreign.id, true);
    await toPublicity('p3f-m', ID_MATCH_A, '王五');
    const membersBefore = await prisma.member.count();

    const res = await promote(cycle.id);
    expect(res.body.data.promotedCount).toBe(2);
    expect(res.body.data.skippedCount).toBe(0);
    expect(await prisma.member.count()).toBe(membersBefore + 2);
    const fa = await prisma.recruitmentApplication.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(fa.statusCode).toBe('promoted');
    expect(fa.promotedMemberId).not.toBeNull();
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
    const rawPhoneSeed = over.idCardNumber ?? over.openid ?? over.realName;
    const phoneSeed = typeof rawPhoneSeed === 'string' ? rawPhoneSeed : 'publicity';
    let phoneHash = 0;
    for (let i = 0; i < phoneSeed.length; i++) {
      phoneHash = (phoneHash * 31 + phoneSeed.charCodeAt(i)) >>> 0;
    }
    return {
      cycleId: '', // 调用处填
      statusCode: 'publicity',
      documentTypeCode: 'mainland_id',
      isForeigner: false,
      genderCode: 'male',
      birthDate: new Date('1995-03-07T00:00:00.000Z'),
      phone: `138${String(phoneHash % 100000000).padStart(8, '0')}`,
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

  it('刀B 同轮活跃 openid DB 防重:第二行 P2002;首行转 rejected 后释放槽位', async () => {
    const cycle = await openCycle();
    const first = await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        openid: 'f15-dup',
        realName: '钱一',
        idCardNumber: 'F15ID0001',
      }),
    });
    const secondData = publicityRow({
      cycleId: cycle.id,
      openid: 'f15-dup',
      realName: '钱二',
      idCardNumber: 'F15ID0002',
    });
    await expect(prisma.recruitmentApplication.create({ data: secondData })).rejects.toMatchObject({
      code: 'P2002',
    });
    await prisma.recruitmentApplication.update({
      where: { id: first.id },
      data: { statusCode: 'rejected' },
    });
    await expect(prisma.recruitmentApplication.create({ data: secondData })).resolves.toBeTruthy();
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
    const promotedMemberIds = (res.body.data.promoted as Array<{ memberId: string }>).map(
      (item) => item.memberId,
    );
    expect(
      await prisma.notificationOutboxIntent.count({
        where: { destinationRef: { in: promotedMemberIds } },
      }),
    ).toBe(2);
    expect(
      await prisma.notificationOutboxIntent.count({
        where: { aggregateId: res.body.data.skipped[0].applicationId },
      }),
    ).toBe(0);
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
        // 待人工 ×3:S4b 真 riskLevel 三栏 system / high / normal;前二条 createdAt=今日
        {
          cycleId: cycle.id,
          statusCode: 'manual_review',
          documentTypeCode: 'mainland_id',
          verifyOutcome: 'ocr_error',
          riskLevel: 'system',
          manualReviewReason: 'system_ocr_error',
          createdAt: TODAY,
          realName: '系统一',
        },
        {
          cycleId: cycle.id,
          statusCode: 'manual_review',
          documentTypeCode: 'mainland_id',
          verifyOutcome: 'forgery_warning',
          riskLevel: 'high',
          manualReviewReason: 'forgery_suspected',
          createdAt: TODAY,
          realName: '高危一',
        },
        {
          cycleId: cycle.id,
          statusCode: 'manual_review',
          documentTypeCode: 'mainland_id',
          verifyOutcome: 'mismatch',
          riskLevel: 'normal',
          manualReviewReason: 'ocr_mismatch_confirmed',
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
        // 公示 ×3:甲/乙 大陆可发号、丙非大陆证件缺派生字段需手动建档
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
        { code: 'redCross', name: '急救资质', completedCount: 0 },
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

  // =====================================================================
  // 招新闭环优化 S6:批量操作(冻结评审稿 recruitment-phase4-loop-optimization-review.md §8)
  //   批量标门槛(复用单行 markThreshold)/ 批量导出 CSV(脱敏复用 S3 toAdminDto)/
  //   一键发号前预检(复用 decidePromotionIssuance,预检=实发)。
  // =====================================================================

  async function submitVerifiedPhone(code: string, idCard: string, name: string, phone: string) {
    const res = await submit(
      validPayload({ wechatCode: code, idCardNumber: idCard, realName: name, phone }),
    );
    expect(res.body.data.statusCode).toBe('verified');
    return prisma.recruitmentApplication.findFirstOrThrow({
      where: { openid: `dev-openid-${code}` },
    });
  }
  function batchMarkThreshold(body: Record<string, unknown>, auth = adminAuth) {
    return request(httpServer(app))
      .post(`${ADMIN_APPS}/batch-mark-threshold`)
      .set('Authorization', auth)
      .send(body);
  }

  it('㉘(S6) 批量标门槛:tempNo / 手机 / 姓名+手机 三键命中 + unmatched(no-match / insufficient)+ 幂等 + per-row 审计', async () => {
    const cycle = await openCycle();
    const a1 = await submitVerifiedPhone('s6-1', ID_MATCH_A, '赵一', '13900001001');
    const a2 = await submitVerifiedPhone('s6-2', ID_MATCH_B, '钱二', '13900001002');
    const a3 = await submitVerifiedPhone('s6-3', ID_MATCH_C, '孙三', '13900001003');

    const res = await batchMarkThreshold({
      cycleId: cycle.id,
      thresholdCode: 'patrol1',
      completed: true,
      matches: [
        { tempNo: a1.tempNo }, // matched by tempNo
        { phone: '13900001002' }, // matched by phone(唯一)
        { realName: '孙三', phone: '13900001003' }, // matched by name+phone
        { tempNo: 'T20269999' }, // no-match
        { realName: '只有名' }, // insufficient-key
      ],
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ total: 5, marked: 3, unmatched: 2, failed: 0, autoAdvanced: 0 });
    expect(d.results[0]).toMatchObject({
      index: 0,
      status: 'marked',
      applicationId: a1.id,
      matchedBy: 'tempNo',
    });
    expect(d.results[1]).toMatchObject({
      status: 'marked',
      applicationId: a2.id,
      matchedBy: 'phone',
    });
    expect(d.results[2]).toMatchObject({
      status: 'marked',
      applicationId: a3.id,
      matchedBy: 'name+phone',
    });
    expect(d.results[3]).toMatchObject({ status: 'unmatched', unmatchedReason: 'no-match' });
    expect(d.results[4]).toMatchObject({
      status: 'unmatched',
      unmatchedReason: 'insufficient-key',
    });

    // DB:三行 patrol1 已标(复用单行 markThreshold 逻辑)
    const a1db = await prisma.recruitmentApplication.findFirstOrThrow({ where: { id: a1.id } });
    expect((a1db.thresholdMarks as Record<string, unknown>).patrol1).toBeTruthy();

    // 幂等:重跑同批 → 仍 marked、无副作用
    const again = await batchMarkThreshold({
      cycleId: cycle.id,
      thresholdCode: 'patrol1',
      completed: true,
      matches: [{ tempNo: a1.tempNo }],
    });
    expect(again.body.data.marked).toBe(1);
    expect(again.body.data.results[0].status).toBe('marked');

    // per-row mark-threshold DB 审计已写(复用单行 → 首批 + 幂等重跑 ≥ 2 条)
    const auditCount = await prisma.auditLog.count({
      where: { event: 'recruitment-application.mark-threshold', resourceId: a1.id },
    });
    expect(auditCount).toBeGreaterThanOrEqual(2);
  });

  it('㉙(S6) 批量标门槛:状态非法行→failed(逐行容错,不整批断,其余唯一命中行照标)', async () => {
    const cycle = await openCycle();
    // 同轮 active phone 已由刀B DB 约束保证唯一；历史/跨轮 ambiguous 的纯匹配行为由
    // recruitment-batch-matching.spec.ts 精确锁定。本 e2e 聚焦逐行失败不阻断其余写入。
    const first = await submitVerifiedPhone('s6-da', ID_MATCH_A, '周一', '13900002000');
    // manual_review 行(状态非法标门槛 → failed):mismatch + 申请人确认③ + 独立手机
    const mmRes = await submit(
      validPayload({
        wechatCode: 's6-mm',
        idCardNumber: ID_MISMATCH,
        phone: '13900002500',
        applicantConfirmedOcrWrong: true,
      }),
      { ocr: { name: '别人', idCardNumber: ID_MISMATCH, clarity: true } },
    );
    expect(mmRes.body.data.statusCode).toBe('manual_review');
    // 一个可正常标的 verified 行(证明逐行容错:它不受 failed 行影响)
    const ok = await submitVerifiedPhone('s6-ok', ID_MATCH_C, '郑三', '13900002600');

    const res = await batchMarkThreshold({
      cycleId: cycle.id,
      thresholdCode: 'patrol1',
      completed: true,
      matches: [
        { phone: '13900002000' }, // 唯一命中 → marked
        { phone: '13900002500' }, // 命中 manual_review → failed(状态非法)
        { phone: '13900002600' }, // 正常 → marked
      ],
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ total: 3, marked: 2, unmatched: 0, failed: 1 });
    expect(d.results[0]).toMatchObject({ status: 'marked', applicationId: first.id });
    expect(d.results[1]).toMatchObject({
      status: 'failed',
      errorCode: BizCode.RECRUITMENT_APPLICATION_WRONG_STATE.code,
    });
    expect(d.results[2]).toMatchObject({ status: 'marked', applicationId: ok.id });
    // 容错验证:ok 行确实标上了(失败行未阻断它)
    const okDb = await prisma.recruitmentApplication.findFirstOrThrow({ where: { id: ok.id } });
    expect((okDb.thresholdMarks as Record<string, unknown>).patrol1).toBeTruthy();
  });

  it('㉚(S6) 批量标门槛:批量标末次门槛触发自动推进 pending_evaluation(autoAdvanced 计数;保留单行自动推进语义)', async () => {
    const cycle = await openCycle();
    const a = await submitVerifiedPhone('s6-aa', ID_MATCH_A, '郑一', '13900003000');
    await seedThresholdCertificateImages(a.id);
    for (const c of ['patrol1', 'patrol2', 'training', 'redCross'])
      await markThreshold(a.id, c, true);

    const res = await batchMarkThreshold({
      cycleId: cycle.id,
      thresholdCode: 'bsafe',
      completed: true,
      matches: [{ tempNo: a.tempNo }],
    });
    expect(res.body.data.marked).toBe(1);
    expect(res.body.data.autoAdvanced).toBe(1);
    expect(res.body.data.results[0]).toMatchObject({
      status: 'marked',
      statusCode: 'pending_evaluation',
      thresholdsComplete: true,
    });
    const db = await prisma.recruitmentApplication.findFirstOrThrow({ where: { id: a.id } });
    expect(db.statusCode).toBe('pending_evaluation');
  });

  it('A3:批量端点逐行复用单行证书 approved 硬闸', async () => {
    const cycle = await openCycle();
    const row = await submitVerifiedPhone('a3-batch', ID_MATCH_A, '批量证书', '13900003010');
    await prisma.recruitmentApplication.update({
      where: { id: row.id },
      data: {
        certificateImages: { first_aid: ['recruitment/certificate/first_aid/batch.png'] },
      },
    });
    const blocked = await batchMarkThreshold({
      cycleId: cycle.id,
      thresholdCode: 'redCross',
      completed: true,
      matches: [{ tempNo: row.tempNo }],
    });
    expect(blocked.body.data.results[0]).toMatchObject({
      status: 'failed',
      errorCode: BizCode.RECRUITMENT_CERTIFICATE_NOT_APPROVED.code,
    });

    await prisma.recruitmentApplication.update({
      where: { id: row.id },
      data: {
        certificateReviewStatus: {
          first_aid: { status: 'approved', at: new Date().toISOString(), by: 'admin-fixture' },
        },
      },
    });
    const allowed = await batchMarkThreshold({
      cycleId: cycle.id,
      thresholdCode: 'redCross',
      completed: true,
      matches: [{ tempNo: row.tempNo }],
    });
    expect(allowed.body.data.results[0]).toMatchObject({ status: 'marked' });
  });

  it('㉛(S6) 批量标门槛 RBAC + 校验:USER → 30100;空 matches → 400;非法 thresholdCode → 400', async () => {
    const cycle = await openCycle();
    expectBizError(
      await batchMarkThreshold(
        {
          cycleId: cycle.id,
          thresholdCode: 'patrol1',
          completed: true,
          matches: [{ tempNo: 'T1' }],
        },
        userAuth,
      ),
      BizCode.RBAC_FORBIDDEN,
    );
    const empty = await batchMarkThreshold({
      cycleId: cycle.id,
      thresholdCode: 'patrol1',
      completed: true,
      matches: [],
    });
    expect(empty.status).toBe(400);
    const badCode = await batchMarkThreshold({
      cycleId: cycle.id,
      thresholdCode: 'not-a-threshold',
      completed: true,
      matches: [{ tempNo: 'T1' }],
    });
    expect(badCode.status).toBe(400);
  });

  it('㉜(S6) 批量导出 CSV:持 read.sensitive → 明文列;仅 read.record → 脱敏列(明文不泄露);无码 → 30100', async () => {
    const cycle = await openCycle();
    // 显式传 phone(F1 fixture 手机唯一化后,本测的 CSV 明文/脱敏断言仍锚定固定号)
    await submit(
      validPayload({ wechatCode: 's6-ex', idCardNumber: ID_MATCH_A, phone: '13900000001' }),
    ); // verified

    // 持 read.sensitive → 明文证件号 / 手机列
    const plain = await request(httpServer(app))
      .post(`${ADMIN_APPS}/export`)
      .set('Authorization', sensitiveAuth)
      .send({ cycleId: cycle.id });
    expect(plain.status).toBe(200);
    expect(plain.headers['content-type']).toContain('text/csv');
    expect(plain.text).toContain('id_card_number'); // 表头
    expect(plain.text).toContain(ID_MATCH_A); // 明文证件号
    expect(plain.text).toContain('13900000001'); // 明文手机

    // 仅 read.record → 脱敏列(明文绝不出)
    const masked = await request(httpServer(app))
      .post(`${ADMIN_APPS}/export`)
      .set('Authorization', recordOnlyAuth)
      .send({ cycleId: cycle.id });
    expect(masked.status).toBe(200);
    expect(masked.text).not.toContain(ID_MATCH_A); // 明文不泄露
    expect(masked.text).not.toContain('13900000001');
    expect(masked.text).toContain('*'); // 掩码(复用 toAdminDto)
    expect(masked.text).toContain('张三'); // 非敏感列照常(realName 在 record 级)

    // 无码 USER → 30100
    expectBizError(
      await request(httpServer(app))
        .post(`${ADMIN_APPS}/export`)
        .set('Authorization', userAuth)
        .send({}),
      BizCode.RBAC_FORBIDDEN,
    );
  });

  it('㉝(S6) 批量导出 CSV:按筛选(publicity)只导公示行,过滤其余态', async () => {
    const cycle = await openCycle();
    await submit(validPayload({ wechatCode: 's6-f1', idCardNumber: ID_MATCH_A })); // verified
    await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        openid: 's6-pub',
        realName: '公示员',
        idCardNumber: 'S6PUB001',
      }),
    });
    const res = await request(httpServer(app))
      .post(`${ADMIN_APPS}/export`)
      .set('Authorization', sensitiveAuth)
      .send({ cycleId: cycle.id, filter: 'publicity' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('公示员'); // 公示行在
    expect(res.text).not.toContain('张三'); // verified(submit 默认名)被滤除
  });

  it('㉞(S6) 发号预检 = 实发:precheck 逐行 willIssue/skipReason 与实际 promote promoted/skipped 同源(decidePromotionIssuance)', async () => {
    const cycle = await openCycle();
    // 既有 User 占用 openid 's6p-bound'(模拟该报名者 openid 已绑既有账号 → promote 会 skip)
    await prisma.user.create({
      data: { username: 's6-bound-occupier', passwordHash: 'x', role: 'USER', openid: 's6p-bound' },
    });
    // 混合公示集:资料齐备的非大陆证件也可发 + openid 占用 + 缺登录通道。
    // 批内重复防御纯函数由 recruitment-promotion.service.spec.ts 锁定；DB 刀B 后生产态不可再造。
    await prisma.recruitmentApplication.createMany({
      data: [
        publicityRow({
          cycleId: cycle.id,
          openid: 's6p-1',
          realName: '艾一',
          idCardNumber: 'S6P0001',
        }),
        publicityRow({
          cycleId: cycle.id,
          openid: 's6p-2',
          realName: '艾二',
          idCardNumber: 'S6P0002',
        }),
        publicityRow({
          cycleId: cycle.id,
          openid: 's6p-f',
          realName: '波三',
          isForeigner: true,
          documentTypeCode: 'passport',
          idCardNumber: 'S6P0003',
        }),
        publicityRow({
          cycleId: cycle.id,
          openid: 's6p-bound',
          realName: '曹四',
          idCardNumber: 'S6P0004',
        }),
        publicityRow({
          cycleId: cycle.id,
          openid: 's6p-3',
          realName: '丁五',
          idCardNumber: 'S6P0005',
        }),
        publicityRow({
          cycleId: cycle.id,
          openid: null,
          phone: null, // v0.40.0:openid + phone 皆无 → missing-login-channel(无任何登录通道,不可发号)
          realName: '鄂七',
          idCardNumber: 'S6P0006',
        }),
      ],
    });
    const nonMainland = await prisma.recruitmentApplication.findFirstOrThrow({
      where: { cycleId: cycle.id, openid: 's6p-f' },
      select: { id: true },
    });

    // 1) 预检(纯读;promote 之前)
    const pre = await request(httpServer(app))
      .get(`${ADMIN_CYCLES}/${cycle.id}/promote-precheck`)
      .set('Authorization', adminAuth);
    expect(pre.status).toBe(200);
    type PreRow = { applicationId: string; willIssue: boolean; skipReason: string | null };
    const preById: Record<string, PreRow> = Object.fromEntries(
      (pre.body.data.rows as PreRow[]).map((r) => [r.applicationId, r]),
    );

    // 2) 实际发号
    const prom = await promote(cycle.id);
    expect(prom.status).toBe(200);
    const promotedIds = new Set(
      (prom.body.data.promoted as Array<{ applicationId: string }>).map((p) => p.applicationId),
    );
    const skipById: Record<string, { reason: string }> = Object.fromEntries(
      (prom.body.data.skipped as Array<{ applicationId: string; reason: string }>).map((s) => [
        s.applicationId,
        s,
      ]),
    );

    // 3) 一致性:每行 precheck.willIssue === 实发 promoted;skipReason === 实发 skipped.reason(预检=实发)
    for (const [id, row] of Object.entries(preById)) {
      expect(row.willIssue).toBe(promotedIds.has(id));
      if (!row.willIssue) expect(row.skipReason).toBe(skipById[id].reason);
    }
    // 汇总一致
    expect(pre.body.data.promotableCount).toBe(prom.body.data.promotedCount);
    expect(pre.body.data.skipCount).toBe(prom.body.data.skippedCount);
    expect(pre.body.data.total).toBe(6);

    // 覆盖生产可达的三类跳过原因。
    const reasons = new Set(
      Object.values(preById)
        .filter((r) => !r.willIssue)
        .map((r) => r.skipReason),
    );
    expect(preById[nonMainland.id]).toMatchObject({ willIssue: true, skipReason: null });
    expect(promotedIds).toContain(nonMainland.id);
    expect(reasons).toContain('openid-already-bound');
    // v0.40.0 H5 手机通道:missing-openid 停用,openid+phone 皆无 → missing-login-channel。
    expect(reasons).toContain('missing-login-channel');
  });

  it('㉟(S6) 发号预检:唯一 openid 不误报重复 + 缺字段 flag;RBAC USER → 30100;轮次不存在 → 28001', async () => {
    const cycle = await openCycle();
    await prisma.recruitmentApplication.createMany({
      data: [
        publicityRow({
          cycleId: cycle.id,
          openid: 's6h-a',
          realName: '甲',
          idCardNumber: 'S6H001',
        }),
        publicityRow({
          cycleId: cycle.id,
          openid: 's6h-b',
          realName: '乙',
          idCardNumber: 'S6H002',
        }),
        publicityRow({
          cycleId: cycle.id,
          openid: 's6h-nb',
          realName: '丙',
          idCardNumber: 'S6H003',
          birthDate: null,
          genderCode: null,
        }),
      ],
    });
    const pre = await request(httpServer(app))
      .get(`${ADMIN_CYCLES}/${cycle.id}/promote-precheck`)
      .set('Authorization', adminAuth);
    expect(pre.status).toBe(200);
    type HRow = {
      realName: string | null;
      duplicateOpenidInBatch: boolean;
      missingBirthDate: boolean;
      missingGender: boolean;
      skipReason: string | null;
    };
    const rows = pre.body.data.rows as HRow[];
    // 刀B 后同轮活跃 openid DB 唯一；生产可达行不应误报重复。
    const uniqueRows = rows.filter((r) => r.realName === '甲' || r.realName === '乙');
    expect(uniqueRows.every((r) => !r.duplicateOpenidInBatch)).toBe(true);
    // 缺生日/性别行:flag + missing-derived-field
    const nb = rows.find((r) => r.realName === '丙')!;
    expect(nb.missingBirthDate).toBe(true);
    expect(nb.missingGender).toBe(true);
    expect(nb.skipReason).toBe('missing-derived-field');

    // RBAC:USER → 30100
    expectBizError(
      await request(httpServer(app))
        .get(`${ADMIN_CYCLES}/${cycle.id}/promote-precheck`)
        .set('Authorization', userAuth),
      BizCode.RBAC_FORBIDDEN,
    );
    // 轮次不存在 → 28001
    expectBizError(
      await request(httpServer(app))
        .get(`${ADMIN_CYCLES}/non-existent/promote-precheck`)
        .set('Authorization', adminAuth),
      BizCode.RECRUITMENT_CYCLE_NOT_FOUND,
    );
  });

  // ============ v0.40.0 H5 手机通道发号 ============

  it('H5 手机通道:无 openid 有已验证手机 → 发号成功,User.phone/phoneVerifiedAt 落库、openid=null,可走 login-sms 登录', async () => {
    const cycle = await openCycle();
    const h5Phone = '13800108001';
    await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        openid: null, // 无微信
        phone: h5Phone, // 有已验证手机(H5 经 RECRUITMENT_BIND 实证)
        realName: '槐H五',
        idCardNumber: 'H5PHONE001',
      }),
    });

    const prom = await promote(cycle.id);
    expect(prom.status).toBe(200);
    const promoted = prom.body.data.promoted as Array<{ applicationId: string; memberId: string }>;
    expect(promoted).toHaveLength(1);
    const memberId = promoted[0].memberId;

    // User:phone + phoneVerifiedAt 落库,openid=null(手机通道);username=memberNo、role=USER。
    const linkedUser = await prisma.user.findFirstOrThrow({
      where: { memberId, deletedAt: null },
      select: { phone: true, phoneVerifiedAt: true, openid: true, role: true },
    });
    expect(linkedUser.phone).toBe(h5Phone);
    expect(linkedUser.phoneVerifiedAt).not.toBeNull();
    expect(linkedUser.openid).toBeNull();
    expect(linkedUser.role).toBe('USER');

    // 可走 login-sms(DevStub 888888)登录。
    const sendCode = await request(httpServer(app))
      .post('/api/auth/v1/login-sms/send-code')
      .send({ phone: h5Phone });
    expect(sendCode.status).toBe(200);
    const login = await request(httpServer(app))
      .post('/api/auth/v1/login-sms')
      .send({ phone: h5Phone, code: '888888' });
    expect(login.status).toBe(200);
    expect(typeof login.body.data.accessToken).toBe('string');
  });

  it('H5 手机通道:phone 被既有账号占用 → skip phone-already-bound(不发号)', async () => {
    const cycle = await openCycle();
    const occupiedPhone = '13800108101';
    await prisma.user.create({
      data: {
        username: 'h5-phone-occupier',
        passwordHash: 'x',
        role: 'USER',
        phone: occupiedPhone,
      },
    });
    const appRow = await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        openid: null,
        phone: occupiedPhone,
        realName: '占H用',
        idCardNumber: 'H5PHONE002',
      }),
    });

    const prom = await promote(cycle.id);
    expect(prom.status).toBe(200);
    expect(prom.body.data.promotedCount).toBe(0);
    const skipped = prom.body.data.skipped as Array<{ applicationId: string; reason: string }>;
    const mine = skipped.find((s) => s.applicationId === appRow.id);
    expect(mine?.reason).toBe('phone-already-bound');
  });

  it('刀B H5 手机通道同轮活跃 phone DB 防重:第二行 P2002;首行转 rejected 后释放槽位', async () => {
    const cycle = await openCycle();
    const dupPhone = '13800108201';
    const first = await prisma.recruitmentApplication.create({
      data: publicityRow({
        cycleId: cycle.id,
        openid: null,
        phone: dupPhone,
        realName: '甲重',
        idCardNumber: 'H5PHONE003',
      }),
    });
    const secondData = publicityRow({
      cycleId: cycle.id,
      openid: null,
      phone: dupPhone,
      realName: '乙重',
      idCardNumber: 'H5PHONE004',
    });
    await expect(prisma.recruitmentApplication.create({ data: secondData })).rejects.toMatchObject({
      code: 'P2002',
    });
    await prisma.recruitmentApplication.update({
      where: { id: first.id },
      data: { statusCode: 'rejected' },
    });
    await expect(prisma.recruitmentApplication.create({ data: secondData })).resolves.toBeTruthy();
  });
});

// D-Throttle:补齐第 9 个命名实例的真实 owner endpoint 回归。
describe('公开招新 recruitment throttler', () => {
  let throttleApp: INestApplication;
  const originalLimit = process.env.RECRUITMENT_THROTTLE_LIMIT;
  const originalTtl = process.env.RECRUITMENT_THROTTLE_TTL_SECONDS;

  beforeAll(async () => {
    process.env.RECRUITMENT_THROTTLE_LIMIT = '1';
    process.env.RECRUITMENT_THROTTLE_TTL_SECONDS = '60';
    throttleApp = await createTestApp();
    await resetDb(throttleApp);
  });

  afterAll(async () => {
    await throttleApp.close();
    if (originalLimit === undefined) delete process.env.RECRUITMENT_THROTTLE_LIMIT;
    else process.env.RECRUITMENT_THROTTLE_LIMIT = originalLimit;
    if (originalTtl === undefined) delete process.env.RECRUITMENT_THROTTLE_TTL_SECONDS;
    else process.env.RECRUITMENT_THROTTLE_TTL_SECONDS = originalTtl;
  });

  it('publicity 同 IP 第 2 次命中 recruitment 42900 且不暴露限流头', async () => {
    const first = await request(httpServer(throttleApp)).get('/api/open/v1/recruitment/publicity');
    expect(first.status).toBe(200);

    const second = await request(httpServer(throttleApp)).get('/api/open/v1/recruitment/publicity');
    expectBizError(second, BizCode.TOO_MANY_REQUESTS);
    expect(second.headers).not.toHaveProperty('retry-after');
    expect(Object.keys(second.headers).join(',')).not.toMatch(/x-ratelimit/i);
  });
});
