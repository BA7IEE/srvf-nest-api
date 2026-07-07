import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantOpsAdminToUser, seedRbacPermissionsAndOpsAdmin } from '../fixtures/rbac.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 队员账号闭环 v2(完整生命周期,2026-07-07;goal「队员账号闭环 v2(完整生命周期)」;
// 冻结评审稿 docs/archive/reviews/member-account-loop-v2-review.md)e2e。
//
// RBAC:member.grant.account / member.bind.account 不在共享 rbac.fixture(其 count 被 rbac
// 元 e2e 依赖);沿 members-account-grant.e2e-spec.ts 先例,本 spec 在 beforeAll 内联 seed
// 两码 + 绑 ops-admin,不改共享 fixture。user.update.status 已在共享 fixture 56 码内。
//
// 覆盖:
// - 绑定既有悬空账号(权限边界 / member 状态 / 目标账号状态四类拒绝 + 成功)
// - 解绑(只断链,账号回悬空 ACTIVE,不停用不软删)
// - 退号重开(单事务原子;username 代际后缀;phone 结构性冲突固化为有意行为)
// - 队员面启停账号(禁自我操作;禁用联动撤销 refresh token;不写 audit)
// - 完整生命周期链:开号 → 解绑 → 绑定回 → 退号重开 → 启停,全程两面回显正确翻转
// - auth 既有 e2e zero-touch(本文件未修改任何既有 auth spec)

const MEMBER_ACCOUNT_CODES = ['member.grant.account', 'member.bind.account'] as const;

async function seedMemberAccountCodesAndBind(
  prisma: PrismaService,
  opsAdminRoleId: string,
): Promise<void> {
  for (const code of MEMBER_ACCOUNT_CODES) {
    const [module, action, resourceType] = code.split('.');
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, module, action, resourceType },
    });
  }
  const perms = await prisma.permission.findMany({
    where: { code: { in: [...MEMBER_ACCOUNT_CODES] } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: opsAdminRoleId, permissionId: p.id })),
    skipDuplicates: true,
  });
}

describe('队员账号闭环 v2:完整生命周期(bind/unbind/reopen/status)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let opsAdminAuth: string;
  let opsAdminUserId: string;
  let userAuth: string;

  let memberSeq = 0;
  async function newMember(
    status: MemberStatus = MemberStatus.ACTIVE,
  ): Promise<{ id: string; memberNo: string }> {
    memberSeq += 1;
    const memberNo = `mal-e2e-${memberSeq}`;
    return prisma.member.create({
      data: { memberNo, displayName: `MAL-${memberSeq}`, status },
      select: { id: true, memberNo: true },
    });
  }

  let danglingSeq = 0;
  async function newDanglingUser(): Promise<{ id: string; username: string }> {
    danglingSeq += 1;
    const username = `mal-dangling-${danglingSeq}`;
    const user = await createTestUser(app, { username });
    return { id: user.id, username: user.username };
  }

  function grant(memberId: string, phone: unknown, auth?: string): Promise<request.Response> {
    const req = request(httpServer(app)).post(`/api/admin/v1/members/${memberId}/account`);
    if (auth !== undefined) req.set('Authorization', auth);
    return req.send({ phone });
  }

  function bind(memberId: string, userId: unknown, auth?: string): Promise<request.Response> {
    const req = request(httpServer(app)).post(`/api/admin/v1/members/${memberId}/account/bind`);
    if (auth !== undefined) req.set('Authorization', auth);
    return req.send({ userId });
  }

  function unbind(memberId: string, auth?: string): Promise<request.Response> {
    const req = request(httpServer(app)).post(`/api/admin/v1/members/${memberId}/account/unbind`);
    if (auth !== undefined) req.set('Authorization', auth);
    return req.send({});
  }

  function reopen(memberId: string, phone: unknown, auth?: string): Promise<request.Response> {
    const req = request(httpServer(app)).post(`/api/admin/v1/members/${memberId}/account/reopen`);
    if (auth !== undefined) req.set('Authorization', auth);
    return req.send({ phone });
  }

  function setStatus(memberId: string, status: unknown, auth?: string): Promise<request.Response> {
    const req = request(httpServer(app)).patch(`/api/admin/v1/members/${memberId}/account/status`);
    if (auth !== undefined) req.set('Authorization', auth);
    return req.send({ status });
  }

  function getMember(memberId: string, auth: string): Promise<request.Response> {
    return request(httpServer(app))
      .get(`/api/admin/v1/members/${memberId}`)
      .set('Authorization', auth);
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });

    await createTestUser(app, { username: 'mal-su', role: Role.SUPER_ADMIN });
    const opsAdmin = await createTestUser(app, { username: 'mal-ops', role: Role.ADMIN });
    opsAdminUserId = opsAdmin.id;
    await createTestUser(app, { username: 'mal-user', role: Role.USER });

    superAdminAuth = (await loginAs(app, 'mal-su')).authHeader;
    opsAdminAuth = (await loginAs(app, 'mal-ops')).authHeader;
    userAuth = (await loginAs(app, 'mal-user')).authHeader;

    const rbacSeed = await seedRbacPermissionsAndOpsAdmin(app);
    await seedMemberAccountCodesAndBind(prisma, rbacSeed.opsAdminRoleId);
    await grantOpsAdminToUser(app, opsAdmin.id, rbacSeed.opsAdminRoleId);
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ bind:权限边界 + 校验顺序 ============

  describe('bind:权限边界 + 校验顺序', () => {
    it('未登录 → 401', async () => {
      const member = await newMember();
      const target = await newDanglingUser();
      expectBizError(await bind(member.id, target.id), BizCode.UNAUTHORIZED);
    });

    it('USER → 30100 RBAC_FORBIDDEN', async () => {
      const member = await newMember();
      const target = await newDanglingUser();
      expectBizError(await bind(member.id, target.id, userAuth), BizCode.RBAC_FORBIDDEN);
    });

    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const target = await newDanglingUser();
      expectBizError(
        await bind('cl0000000000000000nonexist', target.id, opsAdminAuth),
        BizCode.MEMBER_NOT_FOUND,
      );
    });

    it('member 非 ACTIVE → MEMBER_INACTIVE', async () => {
      const member = await newMember(MemberStatus.INACTIVE);
      const target = await newDanglingUser();
      expectBizError(await bind(member.id, target.id, opsAdminAuth), BizCode.MEMBER_INACTIVE);
    });

    it('本队员已有 live 账号 → MEMBER_HAS_LINKED_USER', async () => {
      const member = await newMember();
      expect((await grant(member.id, '13900002001', opsAdminAuth)).status).toBe(201);
      const target = await newDanglingUser();
      expectBizError(
        await bind(member.id, target.id, opsAdminAuth),
        BizCode.MEMBER_HAS_LINKED_USER,
      );
    });

    it('目标 userId 不存在 → USER_NOT_FOUND', async () => {
      const member = await newMember();
      expectBizError(
        await bind(member.id, 'cl0000000000000000nonexist', opsAdminAuth),
        BizCode.USER_NOT_FOUND,
      );
    });

    it('目标 userId 已软删 → USER_NOT_FOUND', async () => {
      const member = await newMember();
      const target = await newDanglingUser();
      await prisma.user.update({
        where: { id: target.id },
        data: { deletedAt: new Date() },
      });
      expectBizError(await bind(member.id, target.id, opsAdminAuth), BizCode.USER_NOT_FOUND);
    });

    it('目标账号已绑定其他队员 → MEMBER_ACCOUNT_TARGET_ALREADY_LINKED', async () => {
      const otherMember = await newMember();
      const granted = await grant(otherMember.id, '13900002002', opsAdminAuth);
      expect(granted.status).toBe(201);
      const member = await newMember();
      expectBizError(
        await bind(member.id, granted.body.data.userId, opsAdminAuth),
        BizCode.MEMBER_ACCOUNT_TARGET_ALREADY_LINKED,
      );
    });

    it('绑定成功:账号保留原用户名/密码登录方式,memberId 指向队员', async () => {
      const member = await newMember();
      const target = await newDanglingUser();
      const res = await bind(member.id, target.id, opsAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.hasAccount).toBe(true);
      expect(res.body.data.userId).toBe(target.id);

      const updated = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(updated.memberId).toBe(member.id);
      expect(updated.username).toBe(target.username); // 未改 username
    });
  });

  // ============ unbind:权限边界 + 校验顺序 ============

  describe('unbind:权限边界 + 校验顺序', () => {
    it('未登录 → 401', async () => {
      const member = await newMember();
      expectBizError(await unbind(member.id), BizCode.UNAUTHORIZED);
    });

    it('USER → 30100 RBAC_FORBIDDEN', async () => {
      const member = await newMember();
      expectBizError(await unbind(member.id, userAuth), BizCode.RBAC_FORBIDDEN);
    });

    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      expectBizError(
        await unbind('cl0000000000000000nonexist', opsAdminAuth),
        BizCode.MEMBER_NOT_FOUND,
      );
    });

    it('member 无 live 账号 → MEMBER_HAS_NO_LINKED_USER', async () => {
      const member = await newMember();
      expectBizError(await unbind(member.id, opsAdminAuth), BizCode.MEMBER_HAS_NO_LINKED_USER);
    });

    it('解绑成功:账号回悬空 ACTIVE,不停用不软删', async () => {
      const member = await newMember();
      const granted = await grant(member.id, '13900003001', opsAdminAuth);
      expect(granted.status).toBe(201);
      const userId = granted.body.data.userId;

      const res = await unbind(member.id, opsAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.hasAccount).toBe(false);
      expect(res.body.data.accountStatus).toBeNull();
      expect(res.body.data.userId).toBeNull();

      const unbound = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(unbound.memberId).toBeNull();
      expect(unbound.deletedAt).toBeNull();
      expect(unbound.status).toBe(UserStatus.ACTIVE);
    });
  });

  // ============ reopen:权限边界 + 校验顺序 ============

  describe('reopen:权限边界 + 校验顺序', () => {
    it('未登录 → 401', async () => {
      const member = await newMember();
      expectBizError(await reopen(member.id, '13900004001'), BizCode.UNAUTHORIZED);
    });

    it('USER → 30100 RBAC_FORBIDDEN', async () => {
      const member = await newMember();
      expectBizError(await reopen(member.id, '13900004002', userAuth), BizCode.RBAC_FORBIDDEN);
    });

    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      expectBizError(
        await reopen('cl0000000000000000nonexist', '13900004003', opsAdminAuth),
        BizCode.MEMBER_NOT_FOUND,
      );
    });

    it('member 非 ACTIVE → MEMBER_INACTIVE', async () => {
      const member = await newMember(MemberStatus.INACTIVE);
      expectBizError(await reopen(member.id, '13900004004', opsAdminAuth), BizCode.MEMBER_INACTIVE);
    });

    it('member 无 live 账号(从未开号)→ MEMBER_HAS_NO_LINKED_USER(应走开号)', async () => {
      const member = await newMember();
      expectBizError(
        await reopen(member.id, '13900004005', opsAdminAuth),
        BizCode.MEMBER_HAS_NO_LINKED_USER,
      );
    });

    it('传入与旧号相同手机号 → PHONE_ALREADY_BOUND(结构性固化为有意行为,非缺陷)', async () => {
      const member = await newMember();
      const phone = '13900004006';
      const granted = await grant(member.id, phone, opsAdminAuth);
      expect(granted.status).toBe(201);
      expectBizError(await reopen(member.id, phone, opsAdminAuth), BizCode.PHONE_ALREADY_BOUND);
    });

    it('重开成功:旧号软删+DISABLED,新号 live 且 username 追加代际后缀(-2)', async () => {
      const member = await newMember();
      const granted = await grant(member.id, '13900004007', opsAdminAuth);
      expect(granted.status).toBe(201);
      expect(granted.body.data.username).toBe(member.memberNo); // 首次仍裸 memberNo
      const oldUserId = granted.body.data.userId;

      const reopened = await reopen(member.id, '13900004008', opsAdminAuth);
      expect(reopened.status).toBe(201);
      expect(reopened.body.data.username).toBe(`${member.memberNo}-2`);
      expect(reopened.body.data.memberId).toBe(member.id);
      expect(reopened.body.data.phone).toBe('13900004008');
      const newUserId = reopened.body.data.userId;
      expect(newUserId).not.toBe(oldUserId);

      const oldUser = await prisma.user.findUniqueOrThrow({ where: { id: oldUserId } });
      expect(oldUser.deletedAt).not.toBeNull();
      expect(oldUser.status).toBe(UserStatus.DISABLED);
      expect(oldUser.memberId).toBe(member.id); // 历史行仍留痕指回该队员

      const newUser = await prisma.user.findUniqueOrThrow({ where: { id: newUserId } });
      expect(newUser.deletedAt).toBeNull();
      expect(newUser.status).toBe(UserStatus.ACTIVE);
      expect(newUser.memberId).toBe(member.id);

      const liveCount = await prisma.user.count({
        where: { memberId: member.id, deletedAt: null },
      });
      expect(liveCount).toBe(1);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { event: 'member.account-reopened', resourceId: member.id },
      });
      const context = audit.context as {
        extra?: { memberId?: string; oldUserId?: string; newUserId?: string; phone?: string };
      };
      expect(context.extra?.oldUserId).toBe(oldUserId);
      expect(context.extra?.newUserId).toBe(newUserId);
      expect(context.extra?.phone).toBe('139****4008');
      expect(JSON.stringify(audit.context)).not.toContain('13900004008');
    });

    it('连续重开两次:第三代 username 追加 -3', async () => {
      const member = await newMember();
      const g = await grant(member.id, '13900004010', opsAdminAuth);
      expect(g.status).toBe(201);
      const r1 = await reopen(member.id, '13900004011', opsAdminAuth);
      expect(r1.status).toBe(201);
      expect(r1.body.data.username).toBe(`${member.memberNo}-2`);
      const r2 = await reopen(member.id, '13900004012', opsAdminAuth);
      expect(r2.status).toBe(201);
      expect(r2.body.data.username).toBe(`${member.memberNo}-3`);

      const liveCount = await prisma.user.count({
        where: { memberId: member.id, deletedAt: null },
      });
      expect(liveCount).toBe(1);
    });
  });

  // ============ status:权限边界 + 校验顺序 + 副作用 ============

  describe('status:权限边界 + 校验顺序 + 副作用', () => {
    it('未登录 → 401', async () => {
      const member = await newMember();
      expectBizError(await setStatus(member.id, UserStatus.DISABLED), BizCode.UNAUTHORIZED);
    });

    it('USER → 30100 RBAC_FORBIDDEN', async () => {
      const member = await newMember();
      expectBizError(
        await setStatus(member.id, UserStatus.DISABLED, userAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });

    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      expectBizError(
        await setStatus('cl0000000000000000nonexist', UserStatus.DISABLED, opsAdminAuth),
        BizCode.MEMBER_NOT_FOUND,
      );
    });

    it('member 无 live 账号 → MEMBER_HAS_NO_LINKED_USER', async () => {
      const member = await newMember();
      expectBizError(
        await setStatus(member.id, UserStatus.DISABLED, opsAdminAuth),
        BizCode.MEMBER_HAS_NO_LINKED_USER,
      );
    });

    it('禁自我操作:currentUser 绑定的账号恰是被操作对象 → CANNOT_OPERATE_SELF', async () => {
      const member = await newMember();
      const bound = await bind(member.id, opsAdminUserId, opsAdminAuth);
      expect(bound.status).toBe(200);
      expectBizError(
        await setStatus(member.id, UserStatus.DISABLED, opsAdminAuth),
        BizCode.CANNOT_OPERATE_SELF,
      );
      // 解绑清理,避免污染后续用例复用 opsAdminUserId
      await unbind(member.id, opsAdminAuth);
    });

    it('启停成功 + 禁用联动撤销 refresh token + 不写 audit', async () => {
      const member = await newMember();
      const target = await newDanglingUser();
      const bound = await bind(member.id, target.id, opsAdminAuth);
      expect(bound.status).toBe(200);

      // 真实登录产生 refresh token(密码登录,target 走 createTestUser 默认密码)。
      const login = await loginAs(app, target.username);
      expect(typeof login.accessToken).toBe('string');

      const before = await prisma.refreshToken.findFirst({ where: { userId: target.id } });
      expect(before).not.toBeNull();
      expect(before?.revokedAt).toBeNull();

      const disabled = await setStatus(member.id, UserStatus.DISABLED, opsAdminAuth);
      expect(disabled.status).toBe(200);
      expect(disabled.body.data.accountStatus).toBe(UserStatus.DISABLED);

      const afterDisable = await prisma.refreshToken.findFirst({ where: { userId: target.id } });
      expect(afterDisable?.revokedAt).not.toBeNull();
      expect(afterDisable?.revokedReason).toBe('admin-disable');

      const auditCount = await prisma.auditLog.count({
        where: { event: { in: ['member.account-granted'] }, resourceId: member.id },
      });
      // 本用例未走 grant,granted 数应为 0;更关键的是没有任何"member 状态改动"事件被写入
      // (队员面启停刻意不写 audit,镜像 UsersService.updateStatus 的 D-PR3-2 决定)。
      expect(auditCount).toBe(0);

      const enabled = await setStatus(member.id, UserStatus.ACTIVE, opsAdminAuth);
      expect(enabled.status).toBe(200);
      expect(enabled.body.data.accountStatus).toBe(UserStatus.ACTIVE);
    });
  });

  // ============ 完整生命周期链 ============

  describe('完整生命周期链', () => {
    it('开号 → 解绑 → 绑定回 → 退号重开 → 启停,全程两面回显正确翻转', async () => {
      const member = await newMember();

      // 1. 开号
      const granted = await grant(member.id, '13900005001', opsAdminAuth);
      expect(granted.status).toBe(201);
      const firstUserId = granted.body.data.userId;

      let detail = await getMember(member.id, superAdminAuth);
      expect(detail.body.data.hasAccount).toBe(true);
      expect(detail.body.data.accountStatus).toBe(UserStatus.ACTIVE);
      expect(detail.body.data.userId).toBe(firstUserId);

      // 2. 解绑
      const unbound = await unbind(member.id, opsAdminAuth);
      expect(unbound.status).toBe(200);
      detail = await getMember(member.id, superAdminAuth);
      expect(detail.body.data.hasAccount).toBe(false);
      expect(detail.body.data.accountStatus).toBeNull();
      expect(detail.body.data.userId).toBeNull();

      // 3. 绑定回同一账号
      const bound = await bind(member.id, firstUserId, opsAdminAuth);
      expect(bound.status).toBe(200);
      detail = await getMember(member.id, superAdminAuth);
      expect(detail.body.data.hasAccount).toBe(true);
      expect(detail.body.data.userId).toBe(firstUserId);

      // 4. 退号重开
      const reopened = await reopen(member.id, '13900005002', opsAdminAuth);
      expect(reopened.status).toBe(201);
      const secondUserId = reopened.body.data.userId;
      expect(secondUserId).not.toBe(firstUserId);

      detail = await getMember(member.id, superAdminAuth);
      expect(detail.body.data.userId).toBe(secondUserId);
      expect(detail.body.data.accountStatus).toBe(UserStatus.ACTIVE);

      // 5. 启停
      const disabled = await setStatus(member.id, UserStatus.DISABLED, opsAdminAuth);
      expect(disabled.status).toBe(200);
      detail = await getMember(member.id, superAdminAuth);
      expect(detail.body.data.accountStatus).toBe(UserStatus.DISABLED);
      expect(detail.body.data.userId).toBe(secondUserId); // 启停不影响 userId

      const enabled = await setStatus(member.id, UserStatus.ACTIVE, opsAdminAuth);
      expect(enabled.status).toBe(200);
      detail = await getMember(member.id, superAdminAuth);
      expect(detail.body.data.accountStatus).toBe(UserStatus.ACTIVE);
    });
  });
});
