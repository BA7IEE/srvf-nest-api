import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
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
//   - volunteer(canUseApp,无 member_department)→ 见 member;不见 formal / department / management
//   - formalA(活跃 orgA)→ 见 member + formal + department[orgA];不见 department[orgB] / management
//   - formalB(活跃 orgB)→ 见 member + formal + department[orgB];不见 department[orgA]
//   - mgmt(biz-admin 持 notification.read.record + ACTIVE member)→ 见 member + management;不见 formal / 两部门
//   - canUseApp=false(unlinked / inactive)→ 403
// reset-db 已清 notifications / member_department / org;本 spec 自造数据。

const APP_NOTIFICATIONS = '/api/app/v1/notifications';

interface Caller {
  userId: string;
  memberId: string;
  auth: string;
}

describe('统一通知模块(第 28 模块)app/v1 会员读取面 e2e(4 档可见 + 站内信)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let volunteer: Caller;
  let formalA: Caller;
  let formalB: Caller;
  let mgmtAuth: string;
  let unlinkedAuth: string;
  let inactiveAuth: string;

  let orgA: string;
  let orgB: string;

  // 各档一条(全 published)+ 一条 draft(未发布)。
  let nMember: string;
  let nFormal: string;
  let nDeptA: string;
  let nDeptB: string;
  let nMgmt: string;
  let nDraft: string;

  async function makeMember(
    username: string,
    memberStatus: 'ACTIVE' | 'INACTIVE',
  ): Promise<Caller> {
    const user = await createTestUser(app, { username, role: Role.USER });
    const member = await prisma.member.create({
      data: { memberNo: `NTF-${username}`, displayName: username, status: memberStatus },
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
  }): Promise<string> {
    const status = over.statusCode ?? 'published';
    const row = await prisma.notification.create({
      data: {
        title: over.title,
        body: '正文',
        notificationTypeCode: 'general',
        statusCode: status,
        visibilityCode: over.visibilityCode,
        visibleOrganizationIds: over.visibleOrganizationIds ?? [],
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

    // mgmt caller:ADMIN + biz-admin + ACTIVE member(canUseApp 需要 member)。
    const mgmtUser = await createTestUser(app, { username: 'ntf_mgmt', role: Role.ADMIN });
    const mgmtMember = await prisma.member.create({
      data: { memberNo: 'NTF-mgmt', displayName: 'mgmt', status: 'ACTIVE' },
    });
    await prisma.user.update({ where: { id: mgmtUser.id }, data: { memberId: mgmtMember.id } });
    await grantBizAdminToUser(app, mgmtUser.id, bizAdminRoleId);
    mgmtAuth = (await loginAs(app, 'ntf_mgmt')).authHeader;

    volunteer = await makeMember('ntf_vol', 'ACTIVE');
    formalA = await makeMember('ntf_formal_a', 'ACTIVE');
    formalB = await makeMember('ntf_formal_b', 'ACTIVE');

    await createTestUser(app, { username: 'ntf_unlinked', role: Role.USER });
    unlinkedAuth = (await loginAs(app, 'ntf_unlinked')).authHeader;
    inactiveAuth = (await makeMember('ntf_inactive', 'INACTIVE')).auth;

    orgA = await makeOrg('部门A');
    orgB = await makeOrg('部门B');
    await prisma.memberDepartment.create({
      data: { memberId: formalA.memberId, organizationId: orgA },
    });
    await prisma.memberDepartment.create({
      data: { memberId: formalB.memberId, organizationId: orgB },
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
    it('inactive member 列表 → 403', async () => {
      expectBizError(await listApp(inactiveAuth), BizCode.FORBIDDEN);
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
    it('volunteer:见 member;不见 formal / deptA / deptB / mgmt / draft', async () => {
      const ids = await listedIds(volunteer.auth);
      expect(ids).toContain(nMember);
      expect(ids).not.toContain(nFormal);
      expect(ids).not.toContain(nDeptA);
      expect(ids).not.toContain(nDeptB);
      expect(ids).not.toContain(nMgmt);
      expect(ids).not.toContain(nDraft);
    });
    it('formalA:见 member + formal + deptA;不见 deptB / mgmt', async () => {
      const ids = await listedIds(formalA.auth);
      expect(ids).toContain(nMember);
      expect(ids).toContain(nFormal);
      expect(ids).toContain(nDeptA);
      expect(ids).not.toContain(nDeptB);
      expect(ids).not.toContain(nMgmt);
    });
    it('formalB:见 deptB;不见 deptA(部门隔离)', async () => {
      const ids = await listedIds(formalB.auth);
      expect(ids).toContain(nDeptB);
      expect(ids).not.toContain(nDeptA);
    });
    it('mgmt(持 notification.read.record,无部门):见 member + management;不见 formal / 两部门', async () => {
      const ids = await listedIds(mgmtAuth);
      expect(ids).toContain(nMember);
      expect(ids).toContain(nMgmt);
      expect(ids).not.toContain(nFormal);
      expect(ids).not.toContain(nDeptA);
      expect(ids).not.toContain(nDeptB);
    });
  });

  // ============ 详情 4 档矩阵:可见 200 / 不可见 404 防枚举 ============
  describe('详情 4 档矩阵(可见 200 / 不可见 + 未发布 404 防枚举)', () => {
    it('volunteer:member → 200;formal / deptA / mgmt / draft → 404', async () => {
      expect((await detailApp(volunteer.auth, nMember)).status).toBe(200);
      expectBizError(await detailApp(volunteer.auth, nFormal), BizCode.NOTIFICATION_NOT_FOUND);
      expectBizError(await detailApp(volunteer.auth, nDeptA), BizCode.NOTIFICATION_NOT_FOUND);
      expectBizError(await detailApp(volunteer.auth, nMgmt), BizCode.NOTIFICATION_NOT_FOUND);
      expectBizError(await detailApp(volunteer.auth, nDraft), BizCode.NOTIFICATION_NOT_FOUND);
    });
    it('formalB:deptB → 200;deptA → 404(部门隔离)', async () => {
      expect((await detailApp(formalB.auth, nDeptB)).status).toBe(200);
      expectBizError(await detailApp(formalB.auth, nDeptA), BizCode.NOTIFICATION_NOT_FOUND);
    });
    it('详情读者出参零敏感:无 authorUserId / visibleOrganizationIds / statusCode / readCount', async () => {
      const res = await detailApp(formalA.auth, nDeptA);
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
      const r1 = await markReadApp(volunteer.auth, id);
      expect(r1.status).toBe(200);
      expect(r1.body.data.read).toBe(true);
      expect(
        (await prisma.notification.findUnique({ where: { id }, select: { readCount: true } }))
          ?.readCount,
      ).toBe(1);

      const r2 = await markReadApp(volunteer.auth, id); // 幂等二次
      expect(r2.status).toBe(200);
      expect(r2.body.data.read).toBe(true);
      expect(
        (await prisma.notification.findUnique({ where: { id }, select: { readCount: true } }))
          ?.readCount,
      ).toBe(1); // **不重复增**
      expect(await prisma.notificationRead.count({ where: { notificationId: id } })).toBe(1);
    });

    it('read 标志:detail 不自动已读(readCount 不变);mark-read 后 list / detail read=true', async () => {
      const id = await makeNotif({ title: 'MR-flag', visibilityCode: 'member' });
      const d1 = await detailApp(volunteer.auth, id);
      expect(d1.body.data.read).toBe(false);
      // detail **不**自动已读:readCount 仍 0,无 NotificationRead 行
      expect(
        (await prisma.notification.findUnique({ where: { id }, select: { readCount: true } }))
          ?.readCount,
      ).toBe(0);
      expect(await prisma.notificationRead.count({ where: { notificationId: id } })).toBe(0);

      await markReadApp(volunteer.auth, id);
      expect((await detailApp(volunteer.auth, id)).body.data.read).toBe(true);
      const inList = (await listApp(volunteer.auth, '?pageSize=50')).body.data.items as {
        id: string;
        read: boolean;
      }[];
      expect(inList.find((i) => i.id === id)?.read).toBe(true);
    });

    it('unread-count 准确:mark-read 一条后 −1', async () => {
      const id = await makeNotif({ title: 'MR-unread', visibilityCode: 'member' });
      const before = (await unreadCountApp(formalB.auth)).body.data.unreadCount as number;
      expect(before).toBeGreaterThan(0);
      await markReadApp(formalB.auth, id);
      const after = (await unreadCountApp(formalB.auth)).body.data.unreadCount as number;
      expect(after).toBe(before - 1);
    });

    it('mark-read 不可见 / 未发布 → 31001 防侧信道(不可标记看不到的)', async () => {
      expectBizError(await markReadApp(volunteer.auth, nMgmt), BizCode.NOTIFICATION_NOT_FOUND);
      expectBizError(await markReadApp(volunteer.auth, nDraft), BizCode.NOTIFICATION_NOT_FOUND);
    });

    it('mark-read 不存在 id → 31001', async () => {
      expectBizError(await markReadApp(volunteer.auth, 'nope-id'), BizCode.NOTIFICATION_NOT_FOUND);
    });
  });
});
