import type { INestApplication } from '@nestjs/common';
import { MembershipType, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 统一通知模块 S1 站内信渠道(第 28 模块 notifications 扩 controller)app/v1 会员读取面 e2e
// (冻结评审稿 unified-notification-dispatcher-review.md §5 / member-notification-review.md §7 + §9 DoD)。
//
// 核心:**4 档可见性矩阵**(去 public;复用 content.visibility)+ 站内信增量(read 标志 / mark-read 幂等 /
// unread-count / 防枚举 404)。caller:
//   - volunteer / reserve / null-grade(均 ACTIVE PRIMARY)→ 见 member + 本部门;不见 formal
//   - level-1(ACTIVE PRIMARY orgA)→ 见 member + formal + department[orgA]
//   - level-3(无 current org)→ 见 member + formal;不见 department
//   - mgmt(biz-admin 持 notification.read.record + ACTIVE member)→ 见 member + management;不见 formal / 两部门
//   - canUseApp=false(unlinked / inactive level-3)→ 403
// reset-db 已清 notifications / member_organization_memberships / org;本 spec 自造数据。

const APP_NOTIFICATIONS = '/api/app/v1/notifications';

interface Caller {
  userId: string;
  memberId: string;
  auth: string;
}

describe('统一通知模块(第 28 模块)app/v1 会员读取面 e2e(4 档可见 + 站内信)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let volunteerPrimary: Caller;
  let reservePrimary: Caller;
  let nullGradePrimary: Caller;
  let level1Primary: Caller;
  let level3NoOrg: Caller;
  let multiMembership: Caller;
  let mgmtAuth: string;
  let plainAdminAuth: string;
  let unlinkedAuth: string;
  let inactiveLevel3Auth: string;

  let orgA: string;
  let orgB: string;
  let orgC: string;
  let orgD: string;

  // 各档一条(全 published)+ 一条 draft(未发布)。
  let nMember: string;
  let nFormal: string;
  let nDeptA: string;
  let nDeptB: string;
  let nDeptC: string;
  let nDeptD: string;
  let nMgmt: string;
  let nDraft: string;

  async function makeMember(
    username: string,
    memberStatus: 'ACTIVE' | 'INACTIVE',
    gradeCode: string | null,
  ): Promise<Caller> {
    const user = await createTestUser(app, { username, role: Role.USER });
    const member = await prisma.member.create({
      data: {
        memberNo: `NTF-${username}`,
        displayName: username,
        status: memberStatus,
        gradeCode,
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const { authHeader } = await loginAs(app, username);
    return { userId: user.id, memberId: member.id, auth: authHeader };
  }

  async function makeOrg(name: string): Promise<string> {
    const org = await prisma.organization.create({
      data: { name, nodeTypeCode: 'demo-node', status: 'ACTIVE' },
      select: { id: true },
    });
    return org.id;
  }

  async function makeNotif(over: {
    title: string;
    visibilityCode: string;
    visibleOrganizationIds?: string[];
    statusCode?: string;
    audienceType?: 'broadcast' | 'directed';
    recipientMemberId?: string;
  }): Promise<string> {
    const status = over.statusCode ?? 'published';
    const audienceType = over.audienceType ?? 'broadcast';
    const row = await prisma.notification.create({
      data: {
        title: over.title,
        body: '正文',
        notificationTypeCode: 'general',
        statusCode: status,
        visibilityCode: over.visibilityCode,
        visibleOrganizationIds: over.visibleOrganizationIds ?? [],
        audienceType,
        sourceType: audienceType === 'directed' ? 'system' : 'admin',
        recipientMemberId: over.recipientMemberId ?? null,
        publishedAt: status === 'published' ? new Date() : null,
      },
      select: { id: true },
    });
    return row.id;
  }

  function listApp(auth: string, qs = ''): request.Test {
    return request(httpServer(app)).get(`${APP_NOTIFICATIONS}${qs}`).set('Authorization', auth);
  }
  function detailApp(auth: string, id: string): request.Test {
    return request(httpServer(app)).get(`${APP_NOTIFICATIONS}/${id}`).set('Authorization', auth);
  }
  function markReadApp(auth: string, id: string): request.Test {
    return request(httpServer(app))
      .post(`${APP_NOTIFICATIONS}/${id}/read`)
      .set('Authorization', auth);
  }
  function unreadCountApp(auth: string): request.Test {
    return request(httpServer(app))
      .get(`${APP_NOTIFICATIONS}/unread-count`)
      .set('Authorization', auth);
  }

  async function listedIds(auth: string): Promise<string[]> {
    const res = await listApp(auth, '?pageSize=50');
    expect(res.status).toBe(200);
    return (res.body.data.items as { id: string }[]).map((i) => i.id);
  }

  async function unreadCountOf(auth: string): Promise<number> {
    const res = await unreadCountApp(auth);
    expect(res.status).toBe(200);
    return res.body.data.unreadCount as number;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

    // biz-admin 角色 + 把 notification.read.record 绑给它(→ mgmt caller 的 isManagement 命中)。
    const { bizAdminRoleId } = await seedBizAdminPermissionsAndRole(app);
    await prisma.permission.upsert({
      where: { code: 'notification.read.record' },
      update: {},
      create: {
        code: 'notification.read.record',
        module: 'notification',
        action: 'read',
        resourceType: 'record',
      },
    });
    const perm = await prisma.permission.findUnique({
      where: { code: 'notification.read.record' },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: [{ roleId: bizAdminRoleId, permissionId: perm!.id }],
      skipDuplicates: true,
    });

    // mgmt caller:普通 USER + 显式 biz-admin RoleBinding + ACTIVE member。
    const mgmtUser = await createTestUser(app, { username: 'ntf_mgmt', role: Role.USER });
    const mgmtMember = await prisma.member.create({
      data: { memberNo: 'NTF-mgmt', displayName: 'mgmt', status: 'ACTIVE' },
    });
    await prisma.user.update({ where: { id: mgmtUser.id }, data: { memberId: mgmtMember.id } });
    await grantBizAdminToUser(app, mgmtUser.id, bizAdminRoleId);
    mgmtAuth = (await loginAs(app, 'ntf_mgmt')).authHeader;

    const plainAdmin = await createTestUser(app, {
      username: 'ntf_plain_admin',
      role: Role.ADMIN,
    });
    const plainAdminMember = await prisma.member.create({
      data: { memberNo: 'NTF-plain-admin', displayName: 'plain-admin', status: 'ACTIVE' },
    });
    await prisma.user.update({
      where: { id: plainAdmin.id },
      data: { memberId: plainAdminMember.id },
    });
    plainAdminAuth = (await loginAs(app, 'ntf_plain_admin')).authHeader;

    // PR-D 六账号矩阵:正式队员真值只由 ACTIVE member + gradeCode=level-1…level-7 决定。
    volunteerPrimary = await makeMember('ntf_vol_primary', 'ACTIVE', 'volunteer');
    reservePrimary = await makeMember('ntf_reserve_primary', 'ACTIVE', 'reserve');
    nullGradePrimary = await makeMember('ntf_null_primary', 'ACTIVE', null);
    level1Primary = await makeMember('ntf_level1_primary', 'ACTIVE', 'level-1');
    level3NoOrg = await makeMember('ntf_level3_no_org', 'ACTIVE', 'level-3');
    multiMembership = await makeMember('ntf_multi_membership', 'ACTIVE', null);

    await createTestUser(app, { username: 'ntf_unlinked', role: Role.USER });
    unlinkedAuth = (await loginAs(app, 'ntf_unlinked')).authHeader;
    inactiveLevel3Auth = (await makeMember('ntf_inactive_level3', 'INACTIVE', 'level-3')).auth;

    orgA = await makeOrg('部门A');
    orgB = await makeOrg('部门B');
    orgC = await makeOrg('部门C');
    orgD = await makeOrg('部门D');
    await prisma.memberOrganizationMembership.createMany({
      data: [
        { memberId: volunteerPrimary.memberId, organizationId: orgA },
        { memberId: reservePrimary.memberId, organizationId: orgB },
        { memberId: nullGradePrimary.memberId, organizationId: orgA },
        { memberId: level1Primary.memberId, organizationId: orgA },
        {
          memberId: multiMembership.memberId,
          organizationId: orgA,
          membershipType: MembershipType.SECONDARY,
        },
        {
          memberId: multiMembership.memberId,
          organizationId: orgB,
          membershipType: MembershipType.TEMPORARY,
        },
        {
          memberId: multiMembership.memberId,
          organizationId: orgC,
          membershipType: MembershipType.SUPPORT,
        },
      ],
    });

    nMember = await makeNotif({ title: 'N-member', visibilityCode: 'member' });
    nFormal = await makeNotif({ title: 'N-formal', visibilityCode: 'formal_member' });
    nDeptA = await makeNotif({
      title: 'N-deptA',
      visibilityCode: 'department',
      visibleOrganizationIds: [orgA],
    });
    nDeptB = await makeNotif({
      title: 'N-deptB',
      visibilityCode: 'department',
      visibleOrganizationIds: [orgB],
    });
    nDeptC = await makeNotif({
      title: 'N-deptC',
      visibilityCode: 'department',
      visibleOrganizationIds: [orgC],
    });
    nDeptD = await makeNotif({
      title: 'N-deptD',
      visibilityCode: 'department',
      visibleOrganizationIds: [orgD],
    });
    nMgmt = await makeNotif({ title: 'N-mgmt', visibilityCode: 'management' });
    nDraft = await makeNotif({ title: 'N-draft', visibilityCode: 'member', statusCode: 'draft' });
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 准入 ============
  describe('准入 canUseApp', () => {
    it('unlinked 列表 → 403', async () => {
      expectBizError(await listApp(unlinkedAuth), BizCode.FORBIDDEN);
    });
    it('unlinked 详情 → 403(准入先于可见性)', async () => {
      expectBizError(await detailApp(unlinkedAuth, nMember), BizCode.FORBIDDEN);
    });
    it('inactive level-3 的 feed / detail / mark-read / unread-count → 403', async () => {
      expectBizError(await listApp(inactiveLevel3Auth), BizCode.FORBIDDEN);
      expectBizError(await detailApp(inactiveLevel3Auth, nFormal), BizCode.FORBIDDEN);
      expectBizError(await markReadApp(inactiveLevel3Auth, nFormal), BizCode.FORBIDDEN);
      expectBizError(await unreadCountApp(inactiveLevel3Auth), BizCode.FORBIDDEN);
    });
    it('unlinked unread-count → 403', async () => {
      expectBizError(await unreadCountApp(unlinkedAuth), BizCode.FORBIDDEN);
    });
    it('无 Authorization → 401', async () => {
      expectBizError(await request(httpServer(app)).get(APP_NOTIFICATIONS), BizCode.UNAUTHORIZED);
    });
  });

  // ============ 列表 4 档矩阵 ============
  describe('列表 4 档矩阵(看得到该看的 + 看不到不该看的;去 public)', () => {
    it('volunteer + ACTIVE PRIMARY(orgA):见 member + deptA;不见 formal / deptB / mgmt / draft', async () => {
      const ids = await listedIds(volunteerPrimary.auth);
      expect(ids).toContain(nMember);
      expect(ids).toContain(nDeptA);
      expect(ids).not.toContain(nFormal);
      expect(ids).not.toContain(nDeptB);
      expect(ids).not.toContain(nMgmt);
      expect(ids).not.toContain(nDraft);
    });

    it('reserve + ACTIVE PRIMARY(orgB):见 member + deptB;不见 formal / deptA / mgmt', async () => {
      const ids = await listedIds(reservePrimary.auth);
      expect(ids).toContain(nMember);
      expect(ids).toContain(nDeptB);
      expect(ids).not.toContain(nFormal);
      expect(ids).not.toContain(nDeptA);
      expect(ids).not.toContain(nMgmt);
    });

    it('null-grade + ACTIVE PRIMARY(orgA):见 member + deptA;不见 formal / deptB / mgmt', async () => {
      const ids = await listedIds(nullGradePrimary.auth);
      expect(ids).toContain(nMember);
      expect(ids).toContain(nDeptA);
      expect(ids).not.toContain(nFormal);
      expect(ids).not.toContain(nDeptB);
      expect(ids).not.toContain(nMgmt);
    });

    it('level-1 + ACTIVE PRIMARY(orgA):见 member + formal + deptA;不见 deptB / mgmt', async () => {
      const ids = await listedIds(level1Primary.auth);
      expect(ids).toContain(nMember);
      expect(ids).toContain(nFormal);
      expect(ids).toContain(nDeptA);
      expect(ids).not.toContain(nDeptB);
      expect(ids).not.toContain(nMgmt);
    });

    it('level-3 + 无 current org:见 member + formal;不见两部门 / mgmt', async () => {
      const ids = await listedIds(level3NoOrg.auth);
      expect(ids).toContain(nMember);
      expect(ids).toContain(nFormal);
      expect(ids).not.toContain(nDeptA);
      expect(ids).not.toContain(nDeptB);
      expect(ids).not.toContain(nMgmt);
    });

    it('mgmt(持 notification.read.record,无部门):见 member + management;不见 formal / 两部门', async () => {
      const ids = await listedIds(mgmtAuth);
      expect(ids).toContain(nMember);
      expect(ids).toContain(nMgmt);
      expect(ids).not.toContain(nFormal);
      expect(ids).not.toContain(nDeptA);
      expect(ids).not.toContain(nDeptB);
    });

    it('裸 ADMIN(无 notification.read.record):不天然命中 management', async () => {
      const ids = await listedIds(plainAdminAuth);
      expect(ids).toContain(nMember);
      expect(ids).not.toContain(nMgmt);
    });

    it('无 PRIMARY 但有 SECONDARY / TEMPORARY / SUPPORT:feed 见三个有效任职部门,不见无任职部门', async () => {
      const ids = await listedIds(multiMembership.auth);
      expect(ids).toEqual(expect.arrayContaining([nDeptA, nDeptB, nDeptC]));
      expect(ids).not.toContain(nDeptD);
    });
  });

  // ============ 详情 4 档矩阵:可见 200 / 不可见 404 防枚举 ============
  describe('详情 4 档矩阵(可见 200 / 不可见 + 未发布 404 防枚举)', () => {
    it('volunteer + PRIMARY:member / deptA → 200;formal / deptB / mgmt / draft → 31001', async () => {
      expect((await detailApp(volunteerPrimary.auth, nMember)).status).toBe(200);
      expect((await detailApp(volunteerPrimary.auth, nDeptA)).status).toBe(200);
      expectBizError(
        await detailApp(volunteerPrimary.auth, nFormal),
        BizCode.NOTIFICATION_NOT_FOUND,
      );
      expectBizError(
        await detailApp(volunteerPrimary.auth, nDeptB),
        BizCode.NOTIFICATION_NOT_FOUND,
      );
      expectBizError(await detailApp(volunteerPrimary.auth, nMgmt), BizCode.NOTIFICATION_NOT_FOUND);
      expectBizError(
        await detailApp(volunteerPrimary.auth, nDraft),
        BizCode.NOTIFICATION_NOT_FOUND,
      );
    });

    it('reserve + PRIMARY:deptB → 200;formal / deptA → 31001', async () => {
      expect((await detailApp(reservePrimary.auth, nDeptB)).status).toBe(200);
      expectBizError(await detailApp(reservePrimary.auth, nFormal), BizCode.NOTIFICATION_NOT_FOUND);
      expectBizError(await detailApp(reservePrimary.auth, nDeptA), BizCode.NOTIFICATION_NOT_FOUND);
    });

    it('null-grade + PRIMARY:deptA → 200;formal → 31001', async () => {
      expect((await detailApp(nullGradePrimary.auth, nDeptA)).status).toBe(200);
      expectBizError(
        await detailApp(nullGradePrimary.auth, nFormal),
        BizCode.NOTIFICATION_NOT_FOUND,
      );
    });

    it('level-1 + PRIMARY:member / formal / deptA → 200;deptB / mgmt → 31001', async () => {
      expect((await detailApp(level1Primary.auth, nMember)).status).toBe(200);
      expect((await detailApp(level1Primary.auth, nFormal)).status).toBe(200);
      expect((await detailApp(level1Primary.auth, nDeptA)).status).toBe(200);
      expectBizError(await detailApp(level1Primary.auth, nDeptB), BizCode.NOTIFICATION_NOT_FOUND);
      expectBizError(await detailApp(level1Primary.auth, nMgmt), BizCode.NOTIFICATION_NOT_FOUND);
    });

    it('level-3 + 无 current org:formal → 200;两部门 → 31001', async () => {
      expect((await detailApp(level3NoOrg.auth, nFormal)).status).toBe(200);
      expectBizError(await detailApp(level3NoOrg.auth, nDeptA), BizCode.NOTIFICATION_NOT_FOUND);
      expectBizError(await detailApp(level3NoOrg.auth, nDeptB), BizCode.NOTIFICATION_NOT_FOUND);
    });

    it('mgmt:management → 200;formal → 31001', async () => {
      expect((await detailApp(mgmtAuth, nMgmt)).status).toBe(200);
      expectBizError(await detailApp(mgmtAuth, nFormal), BizCode.NOTIFICATION_NOT_FOUND);
    });

    it('裸 ADMIN:management → 31001 防枚举', async () => {
      expectBizError(await detailApp(plainAdminAuth, nMgmt), BizCode.NOTIFICATION_NOT_FOUND);
      expectBizError(await markReadApp(plainAdminAuth, nMgmt), BizCode.NOTIFICATION_NOT_FOUND);
    });

    it('SECONDARY / TEMPORARY / SUPPORT 的详情和 mark-read 可见,无任职部门仍 31001', async () => {
      expect((await detailApp(multiMembership.auth, nDeptA)).status).toBe(200);
      expect((await detailApp(multiMembership.auth, nDeptB)).status).toBe(200);
      expect((await detailApp(multiMembership.auth, nDeptC)).status).toBe(200);
      expect((await markReadApp(multiMembership.auth, nDeptC)).status).toBe(200);
      expectBizError(await detailApp(multiMembership.auth, nDeptD), BizCode.NOTIFICATION_NOT_FOUND);
    });

    it('详情读者出参零敏感:无 authorUserId / visibleOrganizationIds / statusCode / readCount', async () => {
      const res = await detailApp(level1Primary.auth, nDeptA);
      expect(res.status).toBe(200);
      expect(res.body.data).not.toHaveProperty('authorUserId');
      expect(res.body.data).not.toHaveProperty('visibleOrganizationIds');
      expect(res.body.data).not.toHaveProperty('statusCode');
      expect(res.body.data).not.toHaveProperty('readCount');
    });
  });

  // ============ read 标志 + mark-read 幂等 + readCount + unread-count ============
  describe('站内信:read 标志 / mark-read 幂等 / readCount / unread-count', () => {
    it('mark-read 幂等:首读 readCount=1,二读 no-op 不重复增,已读行恰 1', async () => {
      const id = await makeNotif({ title: 'MR-idem', visibilityCode: 'member' });
      const r1 = await markReadApp(volunteerPrimary.auth, id);
      expect(r1.status).toBe(200);
      expect(r1.body.data.read).toBe(true);
      expect(
        (await prisma.notification.findUnique({ where: { id }, select: { readCount: true } }))
          ?.readCount,
      ).toBe(1);

      const r2 = await markReadApp(volunteerPrimary.auth, id); // 幂等二次
      expect(r2.status).toBe(200);
      expect(r2.body.data.read).toBe(true);
      expect(
        (await prisma.notification.findUnique({ where: { id }, select: { readCount: true } }))
          ?.readCount,
      ).toBe(1); // **不重复增**
      expect(await prisma.notificationRead.count({ where: { notificationId: id } })).toBe(1);
    });

    it('两请求并发 mark-read:两者都幂等成功，read 行与 readCount 恰各 1', async () => {
      const id = await makeNotif({ title: 'MR-concurrent', visibilityCode: 'member' });
      const beforeUnread = await unreadCountOf(volunteerPrimary.auth);

      const [first, second] = await Promise.all([
        markReadApp(volunteerPrimary.auth, id),
        markReadApp(volunteerPrimary.auth, id),
      ]);

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(first.body.data).toEqual({ read: true });
      expect(second.body.data).toEqual({ read: true });
      expect(
        await prisma.notificationRead.count({
          where: { notificationId: id, memberId: volunteerPrimary.memberId },
        }),
      ).toBe(1);
      expect(
        (await prisma.notification.findUnique({ where: { id }, select: { readCount: true } }))
          ?.readCount,
      ).toBe(1);
      expect(await unreadCountOf(volunteerPrimary.auth)).toBe(beforeUnread - 1);
    });

    it('readCount increment 失败时 read 行整体回滚，修复数据后重试可恢复正确计数', async () => {
      const id = await makeNotif({ title: 'MR-rollback', visibilityCode: 'member' });
      // PostgreSQL integer 上限用于无测试钩子的真实失败注入：increment 必然溢出。
      await prisma.notification.update({
        where: { id },
        data: { readCount: 2_147_483_647 },
      });

      const failed = await markReadApp(volunteerPrimary.auth, id);
      expect(failed.status).toBe(500);
      expect(
        await prisma.notificationRead.count({
          where: { notificationId: id, memberId: volunteerPrimary.memberId },
        }),
      ).toBe(0);
      expect(
        (await prisma.notification.findUnique({ where: { id }, select: { readCount: true } }))
          ?.readCount,
      ).toBe(2_147_483_647);

      await prisma.notification.update({ where: { id }, data: { readCount: 0 } });
      const retried = await markReadApp(volunteerPrimary.auth, id);
      expect(retried.status).toBe(200);
      expect(retried.body.data).toEqual({ read: true });
      expect(
        await prisma.notificationRead.count({
          where: { notificationId: id, memberId: volunteerPrimary.memberId },
        }),
      ).toBe(1);
      expect(
        (await prisma.notification.findUnique({ where: { id }, select: { readCount: true } }))
          ?.readCount,
      ).toBe(1);
    });

    it('read 标志:detail 不自动已读(readCount 不变);mark-read 后 list / detail read=true', async () => {
      const id = await makeNotif({ title: 'MR-flag', visibilityCode: 'member' });
      const d1 = await detailApp(volunteerPrimary.auth, id);
      expect(d1.body.data.read).toBe(false);
      // detail **不**自动已读:readCount 仍 0,无 NotificationRead 行
      expect(
        (await prisma.notification.findUnique({ where: { id }, select: { readCount: true } }))
          ?.readCount,
      ).toBe(0);
      expect(await prisma.notificationRead.count({ where: { notificationId: id } })).toBe(0);

      await markReadApp(volunteerPrimary.auth, id);
      expect((await detailApp(volunteerPrimary.auth, id)).body.data.read).toBe(true);
      const inList = (await listApp(volunteerPrimary.auth, '?pageSize=50')).body.data.items as {
        id: string;
        read: boolean;
      }[];
      expect(inList.find((i) => i.id === id)?.read).toBe(true);
    });

    it('unread-count 准确:mark-read 一条后 −1', async () => {
      const id = await makeNotif({ title: 'MR-unread', visibilityCode: 'member' });
      const before = await unreadCountOf(reservePrimary.auth);
      expect(before).toBeGreaterThan(0);
      await markReadApp(reservePrimary.auth, id);
      const after = await unreadCountOf(reservePrimary.auth);
      expect(after).toBe(before - 1);
    });

    it('volunteer / reserve / null-grade + PRIMARY 均不可 mark-read formal,且零写入', async () => {
      const id = await makeNotif({ title: 'MR-formal-denied', visibilityCode: 'formal_member' });

      for (const caller of [volunteerPrimary, reservePrimary, nullGradePrimary]) {
        expectBizError(await markReadApp(caller.auth, id), BizCode.NOTIFICATION_NOT_FOUND);
      }

      expect(await prisma.notificationRead.count({ where: { notificationId: id } })).toBe(0);
      expect(
        (await prisma.notification.findUnique({ where: { id }, select: { readCount: true } }))
          ?.readCount,
      ).toBe(0);
    });

    it('formal broadcast 只计入 level-1 / level-3 的 unread-count;level-3 无 org 仍可 mark-read', async () => {
      const callers = [
        volunteerPrimary,
        reservePrimary,
        nullGradePrimary,
        level1Primary,
        level3NoOrg,
      ];
      const before = await Promise.all(callers.map((caller) => unreadCountOf(caller.auth)));
      const id = await makeNotif({ title: 'MR-formal-unread', visibilityCode: 'formal_member' });
      const afterPublish = await Promise.all(callers.map((caller) => unreadCountOf(caller.auth)));

      expect(afterPublish[0]).toBe(before[0]);
      expect(afterPublish[1]).toBe(before[1]);
      expect(afterPublish[2]).toBe(before[2]);
      expect(afterPublish[3]).toBe(before[3] + 1);
      expect(afterPublish[4]).toBe(before[4] + 1);

      const marked = await markReadApp(level3NoOrg.auth, id);
      expect(marked.status).toBe(200);
      expect(marked.body.data.read).toBe(true);
      expect(await unreadCountOf(level3NoOrg.auth)).toBe(before[4]);
      expect(
        await prisma.notificationRead.count({
          where: { notificationId: id, memberId: level3NoOrg.memberId },
        }),
      ).toBe(1);
    });

    it('mark-read 不可见 / 未发布 → 31001 防侧信道(不可标记看不到的)', async () => {
      expectBizError(
        await markReadApp(volunteerPrimary.auth, nMgmt),
        BizCode.NOTIFICATION_NOT_FOUND,
      );
      expectBizError(
        await markReadApp(volunteerPrimary.auth, nDraft),
        BizCode.NOTIFICATION_NOT_FOUND,
      );
    });

    it('mark-read 不存在 id → 31001', async () => {
      expectBizError(
        await markReadApp(volunteerPrimary.auth, 'nope-id'),
        BizCode.NOTIFICATION_NOT_FOUND,
      );
    });

    it('directed 仍仅收件人可见;他人 feed 缺席、detail / mark-read=31001、unread-count 不变', async () => {
      const otherBefore = await unreadCountOf(level3NoOrg.auth);
      const id = await makeNotif({
        title: 'MR-directed-level1-only',
        visibilityCode: 'member',
        audienceType: 'directed',
        recipientMemberId: level1Primary.memberId,
      });

      expect(await listedIds(level1Primary.auth)).toContain(id);
      expect((await detailApp(level1Primary.auth, id)).status).toBe(200);

      expect(await listedIds(level3NoOrg.auth)).not.toContain(id);
      expectBizError(await detailApp(level3NoOrg.auth, id), BizCode.NOTIFICATION_NOT_FOUND);
      expectBizError(await markReadApp(level3NoOrg.auth, id), BizCode.NOTIFICATION_NOT_FOUND);
      expect(
        await prisma.notificationRead.count({
          where: { notificationId: id, memberId: level3NoOrg.memberId },
        }),
      ).toBe(0);
      expect(await unreadCountOf(level3NoOrg.auth)).toBe(otherBefore);
    });
  });
});
