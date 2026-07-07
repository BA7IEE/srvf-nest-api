import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 队员账号闭环 v1(MVP,2026-07-07;goal「队员账号闭环 v1(MVP)——给已存在队员开
// "手机验证码登录"账号 + 队员面/用户面互相回显」)e2e。
//
// RBAC:`member.grant.account` 不在共享 rbac.fixture(其 count 被 rbac 元 e2e 依赖);沿
// position-assignments.e2e-spec.ts 先例,本 spec 在 beforeAll 内联 seed 1 码 + 绑 ops-admin,
// 不改共享 fixture。
//
// 覆盖:
// - 权限边界:未登录 401 / USER 30100 / ADMIN+biz-admin(无 ops-admin)30100(码绑 ops-admin,
//   不绑 biz-admin,goal 工程代决)/ ADMIN+ops-admin 200 / SUPER_ADMIN 短路 200
// - 校验顺序:member 不存在 15001(含已软删)/ member 非 ACTIVE 17030 / 已有绑定(含软删占用
//   槽位不放行)15031 / username(=memberNo)被占用 → 探测式自动取下一代 username 开号成功
//   (队员账号闭环 v2 收尾,computeNextUsername 改探测式后不再硬拒绝,2026-07-08)/ phone
//   被占用(含软删)24002 / phone 缺失格式错 400
// - 成功路径:User 建成(username=memberNo / phone / phoneVerifiedAt=now / role=USER /
//   memberId);audit `member.account-granted`(resourceType=member,extra 掩码,零明文号/hash)
// - hasAccount / accountStatus / userId 在 GET 详情 + list(含 `?hasAccount=` 过滤)正确反映
// - 全链:grantAccount → login-sms/send-code → login-sms → GET app/v1/me(canUseApp=true)
// - auth 既有 e2e(login / login-sms / refresh / password-reset)zero-touch —— 本文件
//   未修改任何既有 auth spec,行为锁由未改动本身证明(见 full e2e 回归)

const MEMBER_ACCOUNT_CODE = 'member.grant.account';
const FIXED_CODE = '888888'; // DEV_STUB 固定验证码(沿 auth-login-sms.e2e-spec.ts 范式)

async function seedMemberAccountCodeAndBind(
  prisma: PrismaService,
  opsAdminRoleId: string,
): Promise<void> {
  const [module, action, resourceType] = MEMBER_ACCOUNT_CODE.split('.');
  await prisma.permission.upsert({
    where: { code: MEMBER_ACCOUNT_CODE },
    update: {},
    create: { code: MEMBER_ACCOUNT_CODE, module, action, resourceType },
  });
  const perm = await prisma.permission.findUniqueOrThrow({
    where: { code: MEMBER_ACCOUNT_CODE },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: [{ roleId: opsAdminRoleId, permissionId: perm.id }],
    skipDuplicates: true,
  });
}

describe('队员账号闭环 v1:POST /api/admin/v1/members/:id/account', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let opsAdminAuth: string;
  let bizAdminOnlyAuth: string;
  let userAuth: string;

  let memberSeq = 0;
  async function newMember(
    status: MemberStatus = MemberStatus.ACTIVE,
  ): Promise<{ id: string; memberNo: string }> {
    memberSeq += 1;
    const memberNo = `mag-e2e-${memberSeq}`;
    return prisma.member.create({
      data: { memberNo, displayName: `MAG-${memberSeq}`, status },
      select: { id: true, memberNo: true },
    });
  }

  function grant(memberId: string, phone: unknown, auth?: string): Promise<request.Response> {
    const req = request(httpServer(app)).post(`/api/admin/v1/members/${memberId}/account`);
    if (auth !== undefined) req.set('Authorization', auth);
    return req.send({ phone });
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });

    await createTestUser(app, { username: 'mag-su', role: Role.SUPER_ADMIN });
    const opsAdmin = await createTestUser(app, { username: 'mag-ops', role: Role.ADMIN });
    const bizOnly = await createTestUser(app, { username: 'mag-biz', role: Role.ADMIN });
    await createTestUser(app, { username: 'mag-user', role: Role.USER });

    superAdminAuth = (await loginAs(app, 'mag-su')).authHeader;
    opsAdminAuth = (await loginAs(app, 'mag-ops')).authHeader;
    bizAdminOnlyAuth = (await loginAs(app, 'mag-biz')).authHeader;
    userAuth = (await loginAs(app, 'mag-user')).authHeader;

    const rbacSeed = await seedRbacPermissionsAndOpsAdmin(app);
    await seedMemberAccountCodeAndBind(prisma, rbacSeed.opsAdminRoleId);
    await grantOpsAdminToUser(app, opsAdmin.id, rbacSeed.opsAdminRoleId);

    // 反向验证「码不绑 biz-admin」:mag-biz 只持 biz-admin,不持 ops-admin。
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, bizOnly.id, bizSeed.bizAdminRoleId);
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 权限边界 ============

  describe('权限边界', () => {
    it('未登录 → 401', async () => {
      const member = await newMember();
      expectBizError(await grant(member.id, '13800000001'), BizCode.UNAUTHORIZED);
    });

    it('USER → 30100 RBAC_FORBIDDEN', async () => {
      const member = await newMember();
      expectBizError(await grant(member.id, '13800000002', userAuth), BizCode.RBAC_FORBIDDEN);
    });

    it('ADMIN(持 biz-admin,无 ops-admin)→ 30100(码绑 ops-admin,不绑 biz-admin,goal 工程代决)', async () => {
      const member = await newMember();
      expectBizError(
        await grant(member.id, '13800000003', bizAdminOnlyAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });

    it('ADMIN(持 ops-admin)→ 201', async () => {
      const member = await newMember();
      const res = await grant(member.id, '13800000004', opsAdminAuth);
      expect(res.status).toBe(201);
      expect(res.body.data.role).toBe(Role.USER);
    });

    it('SUPER_ADMIN 短路 → 201', async () => {
      const member = await newMember();
      const res = await grant(member.id, '13800000005', superAdminAuth);
      expect(res.status).toBe(201);
    });
  });

  // ============ 校验顺序与错误码 ============

  describe('校验顺序与错误码', () => {
    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      expectBizError(
        await grant('cl0000000000000000nonexist', '13800001001', opsAdminAuth),
        BizCode.MEMBER_NOT_FOUND,
      );
    });

    it('member 已软删 → 视作不存在,MEMBER_NOT_FOUND', async () => {
      const member = await newMember();
      await prisma.member.update({ where: { id: member.id }, data: { deletedAt: new Date() } });
      expectBizError(await grant(member.id, '13800001002', opsAdminAuth), BizCode.MEMBER_NOT_FOUND);
    });

    it('member 非 ACTIVE(INACTIVE)→ MEMBER_INACTIVE', async () => {
      const member = await newMember(MemberStatus.INACTIVE);
      expectBizError(await grant(member.id, '13800001003', opsAdminAuth), BizCode.MEMBER_INACTIVE);
    });

    it('phone 缺失 → 400', async () => {
      const member = await newMember();
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/members/${member.id}/account`)
        .set('Authorization', opsAdminAuth)
        .send({});
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it('phone 格式错(非大陆 11 位)→ 400', async () => {
      const member = await newMember();
      expectBizError(await grant(member.id, '12345', opsAdminAuth), BizCode.BAD_REQUEST, {
        strictMessage: false,
      });
    });

    it('phone 被其它账号占用 → PHONE_ALREADY_BOUND', async () => {
      const occupied = await createTestUser(app, { username: 'mag-phone-occupied' });
      await prisma.user.update({ where: { id: occupied.id }, data: { phone: '13800002001' } });
      const member = await newMember();
      expectBizError(
        await grant(member.id, '13800002001', opsAdminAuth),
        BizCode.PHONE_ALREADY_BOUND,
      );
    });

    it('phone 被已软删账号占用 → 仍 PHONE_ALREADY_BOUND(含软删占用范式,沿 AGENTS §10)', async () => {
      const occupied = await createTestUser(app, {
        username: 'mag-phone-softdel',
        deletedAt: new Date(),
      });
      await prisma.user.update({ where: { id: occupied.id }, data: { phone: '13800002002' } });
      const member = await newMember();
      expectBizError(
        await grant(member.id, '13800002002', opsAdminAuth),
        BizCode.PHONE_ALREADY_BOUND,
      );
    });

    // 队员账号闭环 v2 收尾(computeNextUsername 改探测式,2026-07-08):不再区分冲突
    // 来源是"本队员自己的历史/悬空账号"还是"纯属巧合的无关用户"——两者在 DB 里本就
    // 无法区分(悬空账号 unbind 后 memberId 同样为 null),探测式统一按 username 是否
    // 被占用自动跳到下一代,不再对"无关巧合冲突"单独硬拒绝(v1 行为变更,已与维护者
    // 确认:见 PR 描述"探测式冲突"拍板记录)。
    it('memberNo 恰与某已有 username 冲突 → 探测式自动取下一代 username 开号成功', async () => {
      const member = await newMember();
      await createTestUser(app, { username: member.memberNo }); // 抢占 username 命名空间
      const res = await grant(member.id, '13800002003', opsAdminAuth);
      expect(res.status).toBe(201);
      expect(res.body.data.username).toBe(`${member.memberNo}-2`);
    });

    it('队员已有绑定 User → MEMBER_HAS_LINKED_USER(重复开号拒绝,非幂等)', async () => {
      const member = await newMember();
      expect((await grant(member.id, '13800003001', opsAdminAuth)).status).toBe(201);
      expectBizError(
        await grant(member.id, '13800003002', opsAdminAuth),
        BizCode.MEMBER_HAS_LINKED_USER,
      );
    });

    // 队员账号闭环 v2(评审稿 D-2)对 v1 唯一有意的行为变更:User.memberId 从全量 @unique
    // 改 partial unique(WHERE deletedAt IS NULL)后,existingLink 预检查改"仅 live"——
    // 队员的绑定 User 一旦软删,槽位随即释放,可重新开号成功(此前 v1 逻辑下仍会拒绝)。
    it('队员的绑定 User 已被软删(槽位已释放)→ 可重新开号成功(队员账号闭环 v2 D-2)', async () => {
      const member = await newMember();
      const granted = await grant(member.id, '13800003003', opsAdminAuth);
      expect(granted.status).toBe(201);
      await prisma.user.update({
        where: { id: granted.body.data.userId },
        data: { deletedAt: new Date(), status: UserStatus.DISABLED },
      });
      const reGranted = await grant(member.id, '13800003004', opsAdminAuth);
      expect(reGranted.status).toBe(201);
      expect(reGranted.body.data.memberId).toBe(member.id);
      expect(reGranted.body.data.userId).not.toBe(granted.body.data.userId);

      // 软删旧行仍在(历史记录),新行 live 且是该 memberId 唯一的 live 关联。
      const liveCount = await prisma.user.count({
        where: { memberId: member.id, deletedAt: null },
      });
      expect(liveCount).toBe(1);
    });
  });

  // ============ 并发开号:P2002 兜底(真实 Postgres,队员账号闭环 v2 评审稿 §1.2 E-4)============

  // memberId 唯一约束自本 PR 起是手写 partial unique index(User_memberId_active_key),
  // 不再是 schema 声明的 @unique;此测试用真实并发请求(非 mock target)验证
  // runWithUniqueConstraintGuard 在真实 Postgres 下仍能把撞车正确映射为 BizException,
  // 不裸抛 500。两个并发请求打同一队员时,输家 INSERT 同时违反 username(=memberNo
  // 两者相同)与 memberId 两个唯一约束,PG 只报其一且不保证是哪个(#516 commit 原文
  // 已载明此非确定性),故断言接受两种码中的任一种,而非武断锁死一种。
  describe('并发开号:P2002 兜底(真实 Postgres)', () => {
    it('两个并发请求打同一 live 且无账号的队员 → 恰好一个 201,另一个干净 4xx(非裸 500)', async () => {
      const member = await newMember();
      const [resA, resB] = await Promise.all([
        grant(member.id, '13800008001', opsAdminAuth),
        grant(member.id, '13800008002', opsAdminAuth),
      ]);

      const winners = [resA, resB].filter((r) => r.status === 201);
      const losers = [resA, resB].filter((r) => r.status !== 201);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);

      const loserCode = losers[0].body.code as number;
      expect([BizCode.MEMBER_HAS_LINKED_USER.code, BizCode.USERNAME_ALREADY_EXISTS.code]).toContain(
        loserCode,
      );

      // 恰好 1 条 live User 关联该队员(赢家),不多不少——partial unique 正确生效。
      const linkedCount = await prisma.user.count({
        where: { memberId: member.id, deletedAt: null },
      });
      expect(linkedCount).toBe(1);
    });
  });

  // ============ 成功路径 + 审计 ============

  describe('成功路径 + 审计', () => {
    it('开号成功:响应含 username=memberNo / phone / phoneVerifiedAt / role=USER / memberId;audit 掩码零明文', async () => {
      const member = await newMember();
      const res = await grant(member.id, '13800004001', opsAdminAuth);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        username: member.memberNo,
        phone: '13800004001',
        role: Role.USER,
        memberId: member.id,
      });
      expect(typeof res.body.data.userId).toBe('string');
      expect(res.body.data.phoneVerifiedAt).not.toBeNull();

      const created = await prisma.user.findUniqueOrThrow({
        where: { id: res.body.data.userId },
      });
      expect(created.role).toBe(Role.USER);
      expect(created.memberId).toBe(member.id);
      expect(created.phoneVerifiedAt).not.toBeNull();
      expect(created.passwordHash.length).toBeGreaterThan(0); // 随机不可用口令仍是非空 hash
      expect(created.status).toBe(UserStatus.ACTIVE);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'member.account-granted', resourceId: member.id },
      });
      expect(audit.resourceType).toBe('member');
      const context = audit.context as {
        extra?: { memberId?: string; userId?: string; phone?: string };
      };
      expect(context.extra?.memberId).toBe(member.id);
      expect(context.extra?.userId).toBe(res.body.data.userId);
      expect(context.extra?.phone).toBe('138****4001');
      const serialized = JSON.stringify(audit.context);
      expect(serialized).not.toContain('13800004001');
      expect(serialized).not.toContain(created.passwordHash);
    });
  });

  // ============ hasAccount / accountStatus 反映(list + detail)============

  describe('hasAccount / accountStatus / userId 反映', () => {
    it('开号前 hasAccount=false/accountStatus=null/userId=null;开号后三者正确填充', async () => {
      const member = await newMember();
      const before = await request(httpServer(app))
        .get(`/api/admin/v1/members/${member.id}`)
        .set('Authorization', superAdminAuth);
      expect(before.body.data.hasAccount).toBe(false);
      expect(before.body.data.accountStatus).toBeNull();
      expect(before.body.data.userId).toBeNull();

      const granted = await grant(member.id, '13800005001', opsAdminAuth);
      expect(granted.status).toBe(201);

      const after = await request(httpServer(app))
        .get(`/api/admin/v1/members/${member.id}`)
        .set('Authorization', superAdminAuth);
      expect(after.body.data.hasAccount).toBe(true);
      expect(after.body.data.accountStatus).toBe(UserStatus.ACTIVE);
      expect(after.body.data.userId).toBe(granted.body.data.userId);
    });

    it('GET /members?hasAccount=true|false 能正确筛出已开号 / 未开号队员(批量查,避免 N+1)', async () => {
      const withAccount = await newMember();
      const withoutAccount = await newMember();
      expect((await grant(withAccount.id, '13800005002', opsAdminAuth)).status).toBe(201);

      const trueRes = await request(httpServer(app))
        .get('/api/admin/v1/members')
        .query({ hasAccount: 'true', memberNo: withAccount.memberNo })
        .set('Authorization', superAdminAuth);
      const trueIds = trueRes.body.data.items.map((m: { id: string }) => m.id);
      expect(trueIds).toContain(withAccount.id);

      const falseRes = await request(httpServer(app))
        .get('/api/admin/v1/members')
        .query({ hasAccount: 'false', memberNo: withoutAccount.memberNo })
        .set('Authorization', superAdminAuth);
      const falseIds = falseRes.body.data.items.map((m: { id: string }) => m.id);
      expect(falseIds).toContain(withoutAccount.id);

      const falseExcludes = await request(httpServer(app))
        .get('/api/admin/v1/members')
        .query({ hasAccount: 'false', memberNo: withAccount.memberNo })
        .set('Authorization', superAdminAuth);
      const excludedIds = falseExcludes.body.data.items.map((m: { id: string }) => m.id);
      expect(excludedIds).not.toContain(withAccount.id);
    });
  });

  // ============ 全链:开号 → login-sms → GET app/v1/me ============

  describe('全链:开号 → login-sms 登录 → GET app/v1/me', () => {
    it('开号后队员可用手机验证码登录并访问 app/v1/me(canUseApp=true,memberId/memberNo 一致)', async () => {
      const member = await newMember();
      const phone = '13800006001';
      const granted = await grant(member.id, phone, opsAdminAuth);
      expect(granted.status).toBe(201);

      const sendCode = await request(httpServer(app))
        .post('/api/auth/v1/login-sms/send-code')
        .send({ phone });
      expect(sendCode.status).toBe(200);

      const login = await request(httpServer(app))
        .post('/api/auth/v1/login-sms')
        .send({ phone, code: FIXED_CODE });
      expect(login.status).toBe(200);
      const accessToken = login.body.data.accessToken as string;
      expect(typeof accessToken).toBe('string');

      const me = await request(httpServer(app))
        .get('/api/app/v1/me')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body.data.canUseApp).toBe(true);
      expect(me.body.data.memberId).toBe(member.id);
      expect(me.body.data.memberNo).toBe(member.memberNo);
    });
  });
});
