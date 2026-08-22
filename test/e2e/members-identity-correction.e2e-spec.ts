import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import {
  MEMBER_ORIGIN_IMPORT,
  MEMBER_ORIGIN_MANUAL,
} from '../../src/common/identity/member-origin.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 第七轮评审 R7-A-01:队员身份主档订正入口 e2e。
//
// 修的是什么:memberNo / memberSinceDate / memberOriginCode 三个建档时确定的身份事实,
// 录错之后**只能直接改库** —— 实测全仓 member delegate 8 处写调用里,这三个字段只出现在
// 3 处 create(本地夹具 / 招新发号 / 建档),零订正路径。而存量老队员录入是上线前待办,
// 一行录错就长期固化,memberNo 还同时是登录识别锚。
//
// 本 spec 锁五件事:
//   ① 判权矩阵 —— 含**决定性反面样本**:持 biz-admin 但单独摘掉 member.correct.identity
//      这一条绑定 ⇒ 本端点 30100,而同一用户 PATCH /:id 仍 200。
//      只测「无 biz-admin → 403」是不够的:那条在端点判的是**别的码**时也照样绿
//      (反面样本必须在被测的那一维上单独不同)。
//   ② 校验复用建档那套 —— 一条不松(唯一/日期/字符集/必填理由/二次确认),
//      也一条不加(memberOriginCode 与建档同口径:自由串候选字典,不做存在性校验)。
//   ③ 审计 —— before / after / reason / actor / 时间五项齐全,before/after 恒为完整三元组。
//   ④ 读面 + 禁止清单 —— 详情返回订正后的值;`UpdateMemberDto` 的禁止清单**原样保留**。
//   ⑤ 已烧号台账(2026-08-22 追加)—— 「编号永不复用」这条铁律的**直接证据**:
//      建档 A001 → 订正为 A999 → 再建档 A001 **必须被拒**。
//      订正是原地 update,旧号改完 Member 表里一行都不剩,此前的唯一性预检因此看不见它;
//      台账只增不删,占住的正是这批「发出去过、现在不挂在任何人身上」的号。
//      本组用例**必须走 HTTP 建档端点** —— `prisma.member.create` 抄近路会绕开被测的那一段。

const BASE = '/api/admin/v1/members';

describe('队员身份主档订正(第七轮评审 R7-A-01)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saAuth: string;
  let admBizAuth: string; // ADMIN + biz-admin(持 member.correct.identity)
  let admDefaultAuth: string; // ADMIN 无 biz-admin
  let userAuth: string;
  let admBizId: string;
  let bizAdminRoleId: string;

  let seq = 0;
  /** 每个用例一个全新队员 —— 订正是破坏性写,共享夹具会让用例互相依赖执行顺序。 */
  async function newMember(
    overrides: { memberNo?: string; memberSinceDate?: Date; memberOriginCode?: string } = {},
  ) {
    seq += 1;
    const identity = memberIdentityData(`订正样本${seq}`);
    const created = await prisma.member.create({
      data: {
        memberNo: overrides.memberNo ?? `IC-${String(seq).padStart(4, '0')}`,
        ...identity,
        ...(overrides.memberSinceDate === undefined
          ? {}
          : { memberSinceDate: overrides.memberSinceDate }),
        ...(overrides.memberOriginCode === undefined
          ? {}
          : { memberOriginCode: overrides.memberOriginCode }),
      },
      select: { id: true, memberNo: true, memberSinceDate: true, memberOriginCode: true },
    });
    return created;
  }

  const correct = (id: string, auth: string, body: Record<string, unknown>) =>
    request(httpServer(app))
      .post(`${BASE}/${id}/identity-corrections`)
      .set('Authorization', auth)
      .send(body);

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'ic-su', role: Role.SUPER_ADMIN });
    const admBiz = await createTestUser(app, { username: 'ic-adm-biz', role: Role.ADMIN });
    admBizId = admBiz.id;
    await createTestUser(app, { username: 'ic-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'ic-user', role: Role.USER });
    saAuth = (await loginAs(app, 'ic-su')).authHeader;
    admBizAuth = (await loginAs(app, 'ic-adm-biz')).authHeader;
    admDefaultAuth = (await loginAs(app, 'ic-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'ic-user')).authHeader;

    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    bizAdminRoleId = bizSeed.bizAdminRoleId;
    await grantBizAdminToUser(app, admBizId, bizAdminRoleId);
  });

  afterAll(async () => {
    await app.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('① 判权矩阵', () => {
    it('正:非 SUPER_ADMIN、持 member.correct.identity 的 ADMIN → 200 且真的改了库', async () => {
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, {
        memberSinceDate: '2019-06-01',
        reason: '存量导入时把发号日误录成导入当天',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.memberSinceDate).toBe('2019-06-01T00:00:00.000Z');

      const row = await prisma.member.findUniqueOrThrow({
        where: { id: m.id },
        select: { memberSinceDate: true },
      });
      expect(row.memberSinceDate.toISOString()).toBe('2019-06-01T00:00:00.000Z');
    });

    it('SUPER_ADMIN → 200(judge 短路)', async () => {
      const m = await newMember();
      const res = await correct(m.id, saAuth, {
        memberOriginCode: MEMBER_ORIGIN_IMPORT,
        reason: '历史导入订正',
      });
      expect(res.status).toBe(200);
    });

    it('反:ADMIN 无 biz-admin → 30100', async () => {
      const m = await newMember();
      const res = await correct(m.id, admDefaultAuth, {
        memberSinceDate: '2019-06-01',
        reason: 'x',
      });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('反:裸 USER → 30100', async () => {
      const m = await newMember();
      const res = await correct(m.id, userAuth, { memberSinceDate: '2019-06-01', reason: 'x' });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    // ⭐ 决定性反面样本:只摘 member.correct.identity 这一条绑定,其余 biz-admin 码全留。
    // 若端点其实判的是别的码(或压根没判权),本用例会绿 —— 这正是它存在的理由。
    describe('反(单维):持 biz-admin 但摘掉 member.correct.identity 这一条', () => {
      let removedPermissionId: string;

      beforeAll(async () => {
        const permission = await prisma.permission.findUniqueOrThrow({
          where: { code: 'member.correct.identity' },
          select: { id: true },
        });
        removedPermissionId = permission.id;
        const deleted = await prisma.rolePermission.deleteMany({
          where: { roleId: bizAdminRoleId, permissionId: removedPermissionId },
        });
        // 先钉「确实摘到了东西」—— 摘了个空集也会让下面两条全绿。
        expect(deleted.count).toBe(1);
      });

      afterAll(async () => {
        await prisma.rolePermission.create({
          data: { roleId: bizAdminRoleId, permissionId: removedPermissionId },
        });
      });

      it('本端点 → 30100', async () => {
        const m = await newMember();
        const res = await correct(m.id, admBizAuth, { memberSinceDate: '2019-06-01', reason: 'x' });
        expectBizError(res, BizCode.RBAC_FORBIDDEN);
      });

      it('同一用户的 PATCH /:id 仍 200(证明摘的是这一条码,不是整个角色)', async () => {
        const m = await newMember();
        const res = await request(httpServer(app))
          .patch(`${BASE}/${m.id}`)
          .set('Authorization', admBizAuth)
          .send({ realName: '仍可改资料' });
        expect(res.status).toBe(200);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('② 校验:复用建档那套,一条不松', () => {
    it('memberNo 撞既有(含软删口径)→ 15002', async () => {
      const occupied = await newMember({ memberNo: 'IC-TAKEN' });
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, {
        memberNo: occupied.memberNo,
        confirmMemberNoChange: true,
        reason: '编号订正',
      });
      expectBizError(res, BizCode.MEMBER_NO_ALREADY_EXISTS);
    });

    it('memberNo 含非法字符 → 400(与建档同一条 @Matches)', async () => {
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, {
        memberNo: 'IC 0001',
        confirmMemberNoChange: true,
        reason: '编号订正',
      });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('非法日期 → 400(与建档同一个 @IsDateString)', async () => {
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, { memberSinceDate: '不是日期', reason: 'x' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('身份字段显式 null → 400(OmittableOnly:身份事实不可清空,只可省略)', async () => {
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, { memberOriginCode: null, reason: 'x' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('reason 缺失 → 400(订正理由必填)', async () => {
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, { memberSinceDate: '2019-06-01' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('reason 为空串 → 400', async () => {
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, { memberSinceDate: '2019-06-01', reason: '' });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('一个身份字段都没传 → 15011(不静默 200)', async () => {
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, { reason: '什么都没改' });
      expectBizError(res, BizCode.MEMBER_IDENTITY_CORRECTION_NO_CHANGE);
    });

    it('传了但每一项都与现值相同 → 15011(同一形状,同样不静默 200)', async () => {
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, {
        memberNo: m.memberNo,
        memberSinceDate: m.memberSinceDate.toISOString(),
        memberOriginCode: m.memberOriginCode,
        reason: '原样回传',
      });
      expectBizError(res, BizCode.MEMBER_IDENTITY_CORRECTION_NO_CHANGE);
    });

    it('改 memberNo 但没带二次确认 → 15012', async () => {
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, { memberNo: 'IC-NEWNO-1', reason: '编号录错' });
      expectBizError(res, BizCode.MEMBER_NO_CORRECTION_NOT_CONFIRMED);
    });

    it('改 memberNo 带 confirmMemberNoChange=true → 200', async () => {
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, {
        memberNo: 'IC-NEWNO-2',
        confirmMemberNoChange: true,
        reason: '编号录错',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.memberNo).toBe('IC-NEWNO-2');
    });

    it('原样回传 memberNo + 改别的字段 → 200(没改动编号就不该要二次确认)', async () => {
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, {
        memberNo: m.memberNo,
        memberSinceDate: '2018-03-04',
        reason: '只改发号日',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.memberNo).toBe(m.memberNo);
      expect(res.body.data.memberSinceDate).toBe('2018-03-04T00:00:00.000Z');
    });

    it('memberSinceDate 带偏移的 datetime 按北京日历日归一(与建档同一个 normalizeDateOnly)', async () => {
      const m = await newMember();
      // UTC 05-14T16:00Z = 北京 05-15 00:00 ⇒ 必须落 05-15,不是 05-14。
      const res = await correct(m.id, admBizAuth, {
        memberSinceDate: '2021-05-15T00:00:00+08:00',
        reason: '带偏移输入',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.memberSinceDate).toBe('2021-05-15T00:00:00.000Z');
    });

    // 一条不加:memberOriginCode **刻意**不做字典存在性校验,与建档逐字同口径
    //(join_source 是自由串候选字典,MP-28 起就是 —— 见 common/identity/member-origin.constant.ts;
    // 当闭集校验会让「后台加了个码却订正不了」。维护者 2026-08-21 拍板)。
    it('memberOriginCode 是字典里没有的码 → 200(与建档同口径,刻意不校验)', async () => {
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, {
        memberOriginCode: 'brand-new-origin-code',
        reason: '运营新增来源',
      });
      expect(res.status).toBe(200);
      expect(res.body.data.memberOriginCode).toBe('brand-new-origin-code');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('③ 审计:before / after / reason / actor / 时间', () => {
    beforeEach(async () => {
      await prisma.auditLog.deleteMany({ where: { event: 'member.identity.correct' } });
    });

    it('写 1 条 member.identity.correct,五项齐全且 before/after 恒为完整三元组', async () => {
      const m = await newMember({
        memberNo: 'IC-AUDIT-1',
        memberSinceDate: new Date('2020-01-01T00:00:00.000Z'),
        memberOriginCode: MEMBER_ORIGIN_MANUAL,
      });
      const res = await correct(m.id, admBizAuth, {
        memberNo: 'IC-AUDIT-2',
        memberSinceDate: '2016-09-09',
        confirmMemberNoChange: true,
        reason: '存量导入把编号与发号日一起录错了',
      });
      expect(res.status).toBe(200);

      const audits = await prisma.auditLog.findMany({
        where: { event: 'member.identity.correct' },
      });
      expect(audits).toHaveLength(1);
      const row = audits[0];

      // actor + 客体定位 + 时间
      expect(row.actorUserId).toBe(admBizId);
      expect(row.actorRoleSnap).toBe(Role.ADMIN);
      expect(row.resourceType).toBe('member');
      expect(row.resourceId).toBe(m.id);
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.success).toBe(true);

      const context = row.context as {
        requestId: string;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
        extra: { reason: string; changedFields: string[] };
      };
      expect(typeof context.requestId).toBe('string');

      // before / after 恒写完整三元组(不只写改动项)—— 未改动的 memberOriginCode 也在里面。
      expect(context.before).toEqual({
        memberNo: 'IC-AUDIT-1',
        memberSinceDate: '2020-01-01T00:00:00.000Z',
        memberOriginCode: MEMBER_ORIGIN_MANUAL,
      });
      expect(context.after).toEqual({
        memberNo: 'IC-AUDIT-2',
        memberSinceDate: '2016-09-09T00:00:00.000Z',
        memberOriginCode: MEMBER_ORIGIN_MANUAL,
      });
      expect(context.extra.reason).toBe('存量导入把编号与发号日一起录错了');
      expect(context.extra.changedFields.sort()).toEqual(['memberNo', 'memberSinceDate']);
    });

    it('被拒的订正不留审计(fail-fast:BizException 回滚整段事务)', async () => {
      const m = await newMember();
      const res = await correct(m.id, admBizAuth, { memberNo: 'IC-NOCONFIRM', reason: '没带确认' });
      expectBizError(res, BizCode.MEMBER_NO_CORRECTION_NOT_CONFIRMED);
      const audits = await prisma.auditLog.findMany({
        where: { event: 'member.identity.correct' },
      });
      expect(audits).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  describe('④ 读面 + UpdateMemberDto 禁止清单原样保留', () => {
    it('订正后 GET /:id 返回订正后的值(⑤类不留新缺口)', async () => {
      const m = await newMember();
      await correct(m.id, admBizAuth, {
        memberNo: 'IC-READBACK',
        memberSinceDate: '2015-02-03',
        memberOriginCode: MEMBER_ORIGIN_IMPORT,
        confirmMemberNoChange: true,
        reason: '三项一起订正',
      }).expect(200);

      const res = await request(httpServer(app))
        .get(`${BASE}/${m.id}`)
        .set('Authorization', admBizAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.memberNo).toBe('IC-READBACK');
      expect(res.body.data.memberSinceDate).toBe('2015-02-03T00:00:00.000Z');
      expect(res.body.data.memberOriginCode).toBe(MEMBER_ORIGIN_IMPORT);
    });

    it.each([
      ['memberNo', 'IC-VIA-PATCH'],
      ['memberSinceDate', '2019-01-01'],
      ['memberOriginCode', MEMBER_ORIGIN_IMPORT],
    ])(
      'PATCH /:id 仍然拒收 %s → 400(有了订正入口不等于日常改资料可以放宽)',
      async (field, value) => {
        const m = await newMember();
        const res = await request(httpServer(app))
          .patch(`${BASE}/${m.id}`)
          .set('Authorization', admBizAuth)
          .send({ [field]: value });
        expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
      },
    );
  });
  // ─────────────────────────────────────────────────────────────────────────
  // ⑤ 已烧号台账 —— 「编号永不复用」这条铁律的直接证据(2026-08-22,维护者拍板方案 A)
  //
  // 缺陷:`correctIdentity` 是**原地 update**,`A001` 订正成 `A999` 之后库里再没有
  // 任何行持有 `A001` ⇒ 下一个人建档时唯一性预检通过 ⇒ **旧号被重新发出去**。
  // 而 memberNo 同时是登录识别锚(auth.service 按 memberNo 兜底查)⇒ 号被复用意味着
  // 曾经用 `A001` 登录的是甲、现在是乙。
  //
  // ⚠️ 本组用例**必须走 HTTP 建档端点**,不能拿 `prisma.member.create` 抄近路 ——
  //    近路绕开 `assertMemberNoUnique`,那正是被测的那一段。
  // ─────────────────────────────────────────────────────────────────────────
  describe('⑤ 已烧号台账:编号永不复用', () => {
    const createMember = (memberNo: string) =>
      request(httpServer(app))
        .post(BASE)
        .set('Authorization', admBizAuth)
        .send({ memberNo, ...memberIdentityData(`烧号样本-${memberNo}`) });

    const reservations = (memberNo: string) =>
      prisma.memberNoReservation.findMany({
        where: { memberNo },
        select: { memberNo: true, memberId: true, reason: true },
      });

    it('⭐ 建档 A001 → 订正为 A999 → 再建档 A001 必须被拒(铁律的直接证据)', async () => {
      const created = await createMember('BURN-A001');
      expect(created.status).toBe(201);
      const memberId = created.body.data.id as string;

      // 建档即烧号
      expect(await reservations('BURN-A001')).toEqual([
        { memberNo: 'BURN-A001', memberId, reason: 'created' },
      ]);

      const corrected = await correct(memberId, admBizAuth, {
        memberNo: 'BURN-A999',
        confirmMemberNoChange: true,
        reason: '录入时把编号敲错了',
      });
      expect(corrected.status).toBe(200);
      expect(corrected.body.data.memberNo).toBe('BURN-A999');

      // 订正后:Member 表里 A001 **一行都没有**了 —— 这正是旧判据看不见它的原因
      expect(await prisma.member.findUnique({ where: { memberNo: 'BURN-A001' } })).toBeNull();
      // 而台账里旧号那行**原样留着**(memberId 保留原值,reason 不改)
      expect(await reservations('BURN-A001')).toEqual([
        { memberNo: 'BURN-A001', memberId, reason: 'created' },
      ]);
      // 新号也烧了一行
      expect(await reservations('BURN-A999')).toEqual([
        { memberNo: 'BURN-A999', memberId, reason: 'corrected' },
      ]);

      // ⭐ 铁律:旧号不可再发
      const reuse = await createMember('BURN-A001');
      expectBizError(reuse, BizCode.MEMBER_NO_ALREADY_EXISTS);
      // 被拒之后台账不多不少 —— 失败的建档不该留下半行
      expect(await reservations('BURN-A001')).toHaveLength(1);
    });

    it('反向对照:从未发过的号照常可建(证明上一条不是「什么都建不出来」)', async () => {
      const res = await createMember('BURN-FRESH-1');
      expect(res.status).toBe(201);
      expect(await reservations('BURN-FRESH-1')).toHaveLength(1);
    });

    it('订正**回不去**:A→B 之后再想订正回 A 同样被拒(永不复用对本人也成立)', async () => {
      const created = await createMember('BURN-B001');
      const memberId = created.body.data.id as string;

      expect(
        (
          await correct(memberId, admBizAuth, {
            memberNo: 'BURN-B002',
            confirmMemberNoChange: true,
            reason: '第一次订正',
          })
        ).status,
      ).toBe(200);

      const back = await correct(memberId, admBizAuth, {
        memberNo: 'BURN-B001',
        confirmMemberNoChange: true,
        reason: '想改回去',
      });
      expectBizError(back, BizCode.MEMBER_NO_ALREADY_EXISTS);
      // 队员仍停在 B002,没有被这次失败弄成中间态
      const row = await prisma.member.findUniqueOrThrow({
        where: { id: memberId },
        select: { memberNo: true },
      });
      expect(row.memberNo).toBe('BURN-B002');
    });

    it('订正失败时台账不留半行(同事务:member 没改成,号也不该被烧掉)', async () => {
      const a = await createMember('BURN-C001');
      const b = await createMember('BURN-C002');
      const bId = b.body.data.id as string;
      expect(a.status).toBe(201);

      // 把 B 订正成 A 的号 —— 撞在活号上,必拒
      const res = await correct(bId, admBizAuth, {
        memberNo: 'BURN-C001',
        confirmMemberNoChange: true,
        reason: '故意撞号',
      });
      expectBizError(res, BizCode.MEMBER_NO_ALREADY_EXISTS);

      // C001 台账仍只有 A 那一行(reason='created'),没被这次失败追加成两行
      expect(await reservations('BURN-C001')).toEqual([
        { memberNo: 'BURN-C001', memberId: a.body.data.id as string, reason: 'created' },
      ]);
      // B 自己也没动
      const row = await prisma.member.findUniqueOrThrow({
        where: { id: bId },
        select: { memberNo: true },
      });
      expect(row.memberNo).toBe('BURN-C002');
    });

    it('只改日期 / 来源的订正不烧号(没换编号就不该凭空占一个号)', async () => {
      const created = await createMember('BURN-D001');
      const memberId = created.body.data.id as string;

      const res = await correct(memberId, admBizAuth, {
        memberSinceDate: '2018-08-08',
        reason: '发号日录错',
      });
      expect(res.status).toBe(200);

      const all = await prisma.memberNoReservation.findMany({
        where: { memberId },
        select: { memberNo: true },
      });
      expect(all).toEqual([{ memberNo: 'BURN-D001' }]);
    });

    // 判据是**比集合**不是比计数:计数相等完全掩盖得了内容缺失
    // (实测:台账删一行、再插一行别的号 ⇒ 计数判据仍读 N=N 判「无问题」,集合判据当场点名)。
    //
    // ⚠️ 扫描面刻意收窄到 `BURN-` 前缀:本 spec 的 `newMember()` 走的是
    //    `prisma.member.create` **直插**,绕开了建档端点也就绕开了烧号 ——
    //    那是夹具抄近路,不是生产写路径的缺口。拿全表当扫描面会把夹具的
    //    `IC-00xx` 也算进来,判据就变成在考夹具而不是在考被测对象。
    //    生产写路径「一个不漏」由 `harness-guards.selftest.ts` 的烧号闸静态执法;
    //    存量回填「一个不漏」由 migration 侧双向 EXCEPT 实测。
    it('经建档端点发出的号,台账一个不漏(比集合,不比计数)', async () => {
      const members = await prisma.member.findMany({
        where: { memberNo: { startsWith: 'BURN-' } },
        select: { memberNo: true },
      });
      const burned = await prisma.memberNoReservation.findMany({
        where: { memberNo: { startsWith: 'BURN-' } },
        select: { memberNo: true },
      });
      const burnedSet = new Set(burned.map((r) => r.memberNo));
      // 先钉两边非空 —— 空集合互相包含会静默变绿
      expect(members.length).toBeGreaterThan(0);
      expect(burnedSet.size).toBeGreaterThan(0);
      expect(members.filter((m) => !burnedSet.has(m.memberNo))).toEqual([]);
      // 反向:台账里的 BURN- 号必然多于活号(被订正走的旧号只在台账里)
      expect(burnedSet.size).toBeGreaterThan(members.length);
    });
  });
});
