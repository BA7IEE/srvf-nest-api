import type { INestApplication } from '@nestjs/common';
import { MemberStatus, MembershipStatus, MembershipType, Role, UserStatus } from '@prisma/client';
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

// 参与域生命周期收口⑤(v0.40.0):POST /api/admin/v1/members/:id/offboard 一键离队 e2e。
//
// RBAC:`member.offboard.record` 绑 biz-admin(业务面);ops-admin 不持有(反向绑定自证)。
// 覆盖:
// - 权限边界:未登录 401 / USER 30100 / ADMIN+ops-admin(无 offboard 码)30100 / biz-admin 200 / SUPER_ADMIN 短路 200
// - 守卫:member 不存在 15001 / linked 账号 role≠USER(提权后)15036
//   (CANNOT_OPERATE_SELF 防御性守卫:role 前置校验使其在正常 RBAC 流程下不可达 —— 持 offboard 码者
//    role 必非 USER,而 linked===self 要求 currentUser 即那条 USER 行,矛盾;不单测,由 15036 覆盖近似面)
// - 成功四腿:member INACTIVE + END 全部 active 归属 + 停用 linked 账号并撤 refresh + 1 条 member.offboard audit;
//   offboard 后该账号 access(jwt 每请求查库拦 DISABLED)与 refresh 双双 401
// - 幂等:已 offboard 重跑 200,各腿 skip(memberDeactivated/accountDisabled false,membershipsEnded 0)
// - 无 linked 账号:账号腿跳过,仍 200
// - residual advisory:残留 active 分管回显(不级联撤分管)

const FIXED_CODE = '888888'; // DEV_STUB 固定验证码

describe('参与域生命周期收口⑤:POST /api/admin/v1/members/:id/offboard', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let bizAdminAuth: string;
  let opsAdminOnlyAuth: string;
  let userAuth: string;
  let orgId: string;

  let memberSeq = 0;
  async function newMember(
    status: MemberStatus = MemberStatus.ACTIVE,
  ): Promise<{ id: string; memberNo: string }> {
    memberSeq += 1;
    const memberNo = `off-e2e-${memberSeq}`;
    return prisma.member.create({
      data: { memberNo, displayName: `OFF-${memberSeq}`, status },
      select: { id: true, memberNo: true },
    });
  }

  // 经 SUPER_ADMIN(短路 RBAC)给队员开号 → 返 userId(role=USER)。
  async function grantAccount(memberId: string, phone: string): Promise<string> {
    const res = await request(httpServer(app))
      .post(`/api/admin/v1/members/${memberId}/account`)
      .set('Authorization', superAdminAuth)
      .send({ phone });
    expect(res.status).toBe(201);
    return res.body.data.userId as string;
  }

  async function loginMember(
    phone: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    await request(httpServer(app)).post('/api/auth/v1/login-sms/send-code').send({ phone });
    const login = await request(httpServer(app))
      .post('/api/auth/v1/login-sms')
      .send({ phone, code: FIXED_CODE });
    expect(login.status).toBe(200);
    return {
      accessToken: login.body.data.accessToken as string,
      refreshToken: login.body.data.refreshToken as string,
    };
  }

  async function seedPrimaryMembership(memberId: string): Promise<void> {
    await prisma.memberOrganizationMembership.create({
      data: {
        memberId,
        organizationId: orgId,
        membershipType: MembershipType.PRIMARY,
        status: MembershipStatus.ACTIVE,
        startedAt: new Date(),
      },
    });
  }

  function offboard(memberId: string, auth?: string): request.Test {
    const req = request(httpServer(app)).post(`/api/admin/v1/members/${memberId}/offboard`);
    if (auth !== undefined) req.set('Authorization', auth);
    return req;
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    await prisma.smsSettings.create({ data: { providerType: 'DEV_STUB', enabled: true } });

    await createTestUser(app, { username: 'off-su', role: Role.SUPER_ADMIN });
    const bizAdmin = await createTestUser(app, { username: 'off-biz', role: Role.ADMIN });
    const opsAdmin = await createTestUser(app, { username: 'off-ops', role: Role.ADMIN });
    await createTestUser(app, { username: 'off-user', role: Role.USER });

    superAdminAuth = (await loginAs(app, 'off-su')).authHeader;
    bizAdminAuth = (await loginAs(app, 'off-biz')).authHeader;
    opsAdminOnlyAuth = (await loginAs(app, 'off-ops')).authHeader;
    userAuth = (await loginAs(app, 'off-user')).authHeader;

    // biz-admin 持 offboard 码;ops-admin 不持(反向绑定自证)。
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, bizAdmin.id, bizSeed.bizAdminRoleId);
    const rbacSeed = await seedRbacPermissionsAndOpsAdmin(app);
    await grantOpsAdminToUser(app, opsAdmin.id, rbacSeed.opsAdminRoleId);

    // 组织(归属 FK)。
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({ data: { typeId: nodeDict.id, code: 'off-root', label: '根' } });
    const org = await prisma.organization.create({
      data: { name: 'Offboard Org', nodeTypeCode: 'off-root', parentId: null },
      select: { id: true },
    });
    orgId = org.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 权限边界 ============
  describe('权限边界', () => {
    it('未登录 → 401', async () => {
      const m = await newMember();
      expectBizError(await offboard(m.id), BizCode.UNAUTHORIZED);
    });

    it('USER → 30100 RBAC_FORBIDDEN', async () => {
      const m = await newMember();
      expectBizError(await offboard(m.id, userAuth), BizCode.RBAC_FORBIDDEN);
    });

    it('ADMIN+ops-admin(无 offboard 码)→ 30100(offboard 是 biz-admin 码)', async () => {
      const m = await newMember();
      expectBizError(await offboard(m.id, opsAdminOnlyAuth), BizCode.RBAC_FORBIDDEN);
    });

    it('biz-admin → 200', async () => {
      const m = await newMember();
      const res = await offboard(m.id, bizAdminAuth);
      expect(res.status).toBe(201);
      expect(res.body.data.member.status).toBe(MemberStatus.INACTIVE);
    });
  });

  // ============ 守卫 ============
  describe('守卫', () => {
    it('member 不存在 → 15001', async () => {
      expectBizError(
        await offboard('cl0000000000000000000000', superAdminAuth),
        BizCode.MEMBER_NOT_FOUND,
      );
    });

    it('linked 账号被提权为 ADMIN → 15036(堵经队员轴绕过用户轴护栏)', async () => {
      const m = await newMember();
      const userId = await grantAccount(m.id, '13800009001');
      // 提权 linked 账号为 ADMIN(模拟先绑后提权)。
      await prisma.user.update({ where: { id: userId }, data: { role: Role.ADMIN } });
      expectBizError(
        await offboard(m.id, superAdminAuth),
        BizCode.MEMBER_ACCOUNT_ROLE_NOT_MANAGEABLE,
      );
    });
  });

  // ============ 成功四腿 + access/refresh 401 ============
  describe('成功:四腿 + 离队后 access/refresh 双双 401', () => {
    it('member+account+归属 → offboard → INACTIVE/ENDED/DISABLED + 撤 refresh + audit;access/refresh 401', async () => {
      const m = await newMember();
      const phone = '13800009101';
      const userId = await grantAccount(m.id, phone);
      await seedPrimaryMembership(m.id);
      const { accessToken, refreshToken } = await loginMember(phone);

      // 离队前 access 可用。
      const meBefore = await request(httpServer(app))
        .get('/api/app/v1/me')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(meBefore.status).toBe(200);

      const res = await offboard(m.id, bizAdminAuth);
      expect(res.status).toBe(201);
      const data = res.body.data;
      expect(data.member.status).toBe(MemberStatus.INACTIVE);
      expect(data.member.accountStatus).toBe(UserStatus.DISABLED);
      expect(data.memberDeactivated).toBe(true);
      expect(data.membershipsEnded).toBe(1);
      expect(data.accountDisabled).toBe(true);
      expect(data.refreshTokensRevoked).toBeGreaterThanOrEqual(1);
      expect(data.linkedUserId).toBe(userId);
      expect(data.residualActivePositionAssignments).toBe(0);
      expect(data.residualActiveSupervisions).toBe(0);

      // DB 反向断言。
      const member = await prisma.member.findUniqueOrThrow({ where: { id: m.id } });
      expect(member.status).toBe(MemberStatus.INACTIVE);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.status).toBe(UserStatus.DISABLED);
      const activeMemberships = await prisma.memberOrganizationMembership.count({
        where: { memberId: m.id, status: MembershipStatus.ACTIVE, deletedAt: null },
      });
      expect(activeMemberships).toBe(0);
      const endedMembership = await prisma.memberOrganizationMembership.findFirstOrThrow({
        where: { memberId: m.id },
      });
      expect(endedMembership.status).toBe(MembershipStatus.ENDED);
      expect(endedMembership.endedAt).not.toBeNull();

      // audit member.offboard 一条。
      const audits = await prisma.auditLog.findMany({
        where: { event: 'member.offboard', resourceId: m.id },
      });
      expect(audits).toHaveLength(1);

      // access token(jwt 每请求查库,DISABLED → 401)。
      const meAfter = await request(httpServer(app))
        .get('/api/app/v1/me')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(meAfter.status).toBe(401);

      // refresh token(已撤销 → 401)。
      const refreshRes = await request(httpServer(app))
        .post('/api/auth/v1/refresh')
        .send({ refreshToken });
      expect(refreshRes.status).toBe(401);
    });
  });

  // ============ 幂等 ============
  describe('幂等', () => {
    it('已 offboard 重跑 → 200,各腿 skip(memberDeactivated/accountDisabled false,membershipsEnded 0)', async () => {
      const m = await newMember();
      const phone = '13800009201';
      await grantAccount(m.id, phone);
      await seedPrimaryMembership(m.id);

      const first = await offboard(m.id, bizAdminAuth);
      expect(first.status).toBe(201);
      expect(first.body.data.memberDeactivated).toBe(true);
      expect(first.body.data.membershipsEnded).toBe(1);
      expect(first.body.data.accountDisabled).toBe(true);

      const second = await offboard(m.id, bizAdminAuth);
      expect(second.status).toBe(201);
      expect(second.body.data.memberDeactivated).toBe(false);
      expect(second.body.data.membershipsEnded).toBe(0);
      expect(second.body.data.accountDisabled).toBe(false);
      expect(second.body.data.refreshTokensRevoked).toBe(0);
    });
  });

  // ============ 无 linked 账号 ============
  describe('无 linked 账号', () => {
    it('offboard 无账号队员 → 账号腿 skip,仍 200(member INACTIVE)', async () => {
      const m = await newMember();
      await seedPrimaryMembership(m.id);
      const res = await offboard(m.id, bizAdminAuth);
      expect(res.status).toBe(201);
      expect(res.body.data.member.status).toBe(MemberStatus.INACTIVE);
      expect(res.body.data.accountDisabled).toBe(false);
      expect(res.body.data.linkedUserId).toBeNull();
      expect(res.body.data.membershipsEnded).toBe(1);
    });
  });

  // ============ residual advisory ============
  describe('residual advisory(不级联)', () => {
    it('残留 active 分管 → residualActiveSupervisions 回显 > 0(offboard 不级联撤分管)', async () => {
      const m = await newMember();
      await prisma.organizationSupervisionAssignment.create({
        data: { supervisorMemberId: m.id, organizationId: orgId, startedAt: new Date() },
      });
      const res = await offboard(m.id, bizAdminAuth);
      expect(res.status).toBe(201);
      expect(res.body.data.residualActiveSupervisions).toBeGreaterThanOrEqual(1);
      // 分管行未被级联撤销(仍 active)。
      const stillActive = await prisma.organizationSupervisionAssignment.count({
        where: { supervisorMemberId: m.id, status: 'ACTIVE', deletedAt: null },
      });
      expect(stillActive).toBeGreaterThanOrEqual(1);
    });
  });
});
