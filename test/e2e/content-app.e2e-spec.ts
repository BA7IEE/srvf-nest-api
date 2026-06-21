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

// CMS 内容发布模块(第 28 模块)T4 app/v1 会员读取面 e2e
// (冻结评审稿 docs/archive/reviews/content-module-review.md §4 5 档可见 + §8 app + §9 DoD)。
//
// 核心:**5 档可见性矩阵**,每个 caller 在列表 + 详情都断言「看得到该看的」+「看不到不该看的」(DoD §9)。
// caller:
//   - volunteer(canUseApp,无 member_department)→ 见 public + member;**不**见 formal_member / department / management
//   - formalA(活跃 member_department orgA)→ 见 public + member + formal_member + department[orgA];不见 department[orgB] / management
//   - formalB(活跃 member_department orgB)→ 见 public + member + formal_member + department[orgB];不见 department[orgA] / management
//   - mgmt(biz-admin,持 content.read.record)→ 见全 5 档(含 management)
// 另:canUseApp=false(unlinked / inactive)→ 403;viewCount app 详情 +1;搜索 + 标签 AND 可见性(搜不到越档)。
//
// content 全部 published;reset-db 已清 contents + member_department + org;本 spec 自造数据。

const APP_CONTENTS = '/api/app/v1/contents';

interface Caller {
  userId: string;
  memberId: string;
  auth: string;
}

describe('CMS 内容发布模块(第 28 模块)app/v1 会员读取面 e2e(5 档可见矩阵)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let volunteer: Caller; // 无部门
  let formalA: Caller; // 活跃部门 orgA
  let formalB: Caller; // 活跃部门 orgB
  let mgmtAuth: string; // biz-admin(持 content.read.record → isManagement)
  let unlinkedAuth: string; // 无绑定 member → canUseApp=false
  let inactiveAuth: string; // member INACTIVE → canUseApp=false

  let orgA: string;
  let orgB: string;

  // 各档一篇(全 published)。
  let cPublic: string;
  let cMember: string;
  let cFormal: string;
  let cDeptA: string;
  let cDeptB: string;
  let cMgmt: string;

  async function makeMember(
    username: string,
    memberStatus: 'ACTIVE' | 'INACTIVE',
  ): Promise<Caller> {
    const user = await createTestUser(app, { username, role: Role.USER });
    const member = await prisma.member.create({
      data: { memberNo: `CON-${username}`, displayName: username, status: memberStatus },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    const { authHeader } = await loginAs(app, username);
    return { userId: user.id, memberId: member.id, auth: authHeader };
  }

  async function makeOrg(name: string): Promise<string> {
    const org = await prisma.organization.create({
      data: { name, nodeTypeCode: 'demo-node', status: 'ACTIVE' },
    });
    return org.id;
  }

  async function setDept(memberId: string, organizationId: string): Promise<void> {
    await prisma.memberDepartment.create({ data: { memberId, organizationId } });
  }

  async function makeContent(over: {
    title: string;
    visibilityCode: string;
    visibleOrganizationIds?: string[];
    statusCode?: string;
    tags?: string[];
    body?: string;
  }): Promise<string> {
    const row = await prisma.content.create({
      data: {
        title: over.title,
        summary: '摘要',
        body: over.body ?? '正文',
        contentTypeCode: 'announcement',
        statusCode: over.statusCode ?? 'published',
        visibilityCode: over.visibilityCode,
        visibleOrganizationIds: over.visibleOrganizationIds ?? [],
        tags: over.tags ?? [],
        publishedAt: new Date(),
      },
      select: { id: true },
    });
    return row.id;
  }

  function listApp(auth: string, qs = ''): request.Test {
    return request(httpServer(app)).get(`${APP_CONTENTS}${qs}`).set('Authorization', auth);
  }
  function detailApp(auth: string, id: string): request.Test {
    return request(httpServer(app)).get(`${APP_CONTENTS}/${id}`).set('Authorization', auth);
  }

  // 列表里能见到的全部 id 集合(翻页足够大,一次取全)。
  async function listedIds(auth: string): Promise<string[]> {
    const res = await listApp(auth, '?pageSize=50');
    expect(res.status).toBe(200);
    return (res.body.data.items as { id: string }[]).map((i) => i.id);
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await resetDb(app);

    // biz-admin 角色 + 把 content.read.record 绑给它(→ mgmt caller 的 isManagement 命中)。
    const { bizAdminRoleId } = await seedBizAdminPermissionsAndRole(app);
    await prisma.permission.upsert({
      where: { code: 'content.read.record' },
      update: {},
      create: {
        code: 'content.read.record',
        module: 'content',
        action: 'read',
        resourceType: 'record',
      },
    });
    const perm = await prisma.permission.findUnique({
      where: { code: 'content.read.record' },
      select: { id: true },
    });
    await prisma.rolePermission.createMany({
      data: [{ roleId: bizAdminRoleId, permissionId: perm!.id }],
      skipDuplicates: true,
    });

    // mgmt caller:ADMIN 用户 + biz-admin 角色 + 绑定一个 ACTIVE member(canUseApp 需要 member)。
    const mgmtUser = await createTestUser(app, { username: 'con_mgmt', role: Role.ADMIN });
    const mgmtMember = await prisma.member.create({
      data: { memberNo: 'CON-mgmt', displayName: 'mgmt', status: 'ACTIVE' },
    });
    await prisma.user.update({ where: { id: mgmtUser.id }, data: { memberId: mgmtMember.id } });
    await grantBizAdminToUser(app, mgmtUser.id, bizAdminRoleId);
    mgmtAuth = (await loginAs(app, 'con_mgmt')).authHeader;

    // 三个普通会员 caller
    volunteer = await makeMember('con_vol', 'ACTIVE');
    formalA = await makeMember('con_formal_a', 'ACTIVE');
    formalB = await makeMember('con_formal_b', 'ACTIVE');

    // 两个非准入 caller
    await createTestUser(app, { username: 'con_unlinked', role: Role.USER });
    unlinkedAuth = (await loginAs(app, 'con_unlinked')).authHeader;
    inactiveAuth = (await makeMember('con_inactive', 'INACTIVE')).auth;

    // 部门归属:formalA→orgA;formalB→orgB(volunteer 无部门)
    orgA = await makeOrg('部门A');
    orgB = await makeOrg('部门B');
    await setDept(formalA.memberId, orgA);
    await setDept(formalB.memberId, orgB);

    // 各档一篇(全 published)
    cPublic = await makeContent({ title: 'C-public', visibilityCode: 'public' });
    cMember = await makeContent({ title: 'C-member', visibilityCode: 'member' });
    cFormal = await makeContent({ title: 'C-formal', visibilityCode: 'formal_member' });
    cDeptA = await makeContent({
      title: 'C-deptA',
      visibilityCode: 'department',
      visibleOrganizationIds: [orgA],
    });
    cDeptB = await makeContent({
      title: 'C-deptB',
      visibilityCode: 'department',
      visibleOrganizationIds: [orgB],
    });
    cMgmt = await makeContent({ title: 'C-mgmt', visibilityCode: 'management' });
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ 准入 ============
  describe('准入 canUseApp', () => {
    it('unlinked(无绑定 member)列表 → 403', async () => {
      expectBizError(await listApp(unlinkedAuth), BizCode.FORBIDDEN);
    });
    it('unlinked 详情 → 403(准入先于可见性)', async () => {
      expectBizError(await detailApp(unlinkedAuth, cPublic), BizCode.FORBIDDEN);
    });
    it('inactive member 列表 → 403', async () => {
      expectBizError(await listApp(inactiveAuth), BizCode.FORBIDDEN);
    });
    it('无 Authorization → 401', async () => {
      const res = await request(httpServer(app)).get(APP_CONTENTS);
      expectBizError(res, BizCode.UNAUTHORIZED);
    });
  });

  // ============ 列表矩阵:正向 + 负向 ============
  describe('列表 5 档矩阵(看得到该看的 + 看不到不该看的)', () => {
    it('volunteer(无部门):见 public + member;不见 formal / deptA / deptB / mgmt', async () => {
      const ids = await listedIds(volunteer.auth);
      expect(ids).toContain(cPublic);
      expect(ids).toContain(cMember);
      expect(ids).not.toContain(cFormal);
      expect(ids).not.toContain(cDeptA);
      expect(ids).not.toContain(cDeptB);
      expect(ids).not.toContain(cMgmt);
    });

    it('formalA(orgA):见 public + member + formal + deptA;不见 deptB / mgmt', async () => {
      const ids = await listedIds(formalA.auth);
      expect(ids).toContain(cPublic);
      expect(ids).toContain(cMember);
      expect(ids).toContain(cFormal);
      expect(ids).toContain(cDeptA);
      expect(ids).not.toContain(cDeptB);
      expect(ids).not.toContain(cMgmt);
    });

    it('formalB(orgB):见 public + member + formal + deptB;不见 deptA / mgmt', async () => {
      const ids = await listedIds(formalB.auth);
      expect(ids).toContain(cPublic);
      expect(ids).toContain(cMember);
      expect(ids).toContain(cFormal);
      expect(ids).toContain(cDeptB);
      expect(ids).not.toContain(cDeptA);
      expect(ids).not.toContain(cMgmt);
    });

    // mgmt caller(con_mgmt)持 content.read.record → isManagement=true,但**无 member_department**
    // → isFormalMember=false / activeOrgIds=[]。可见档=各档独立判定:public(恒) + member(isMember,
    // 因 canUseApp) + management(isManagement);**不**含 formal_member / department(管理层非各档超集,
    // 评审稿 §4.3「management 档主要由 admin/v1 承载,app/v1 仅边角能见」)。
    it('mgmt(持 content.read.record,无部门):见 public + member + management;不见 formal / 两部门', async () => {
      const ids = await listedIds(mgmtAuth);
      expect(ids).toContain(cPublic);
      expect(ids).toContain(cMember);
      expect(ids).toContain(cMgmt);
      expect(ids).not.toContain(cFormal);
      expect(ids).not.toContain(cDeptA);
      expect(ids).not.toContain(cDeptB);
    });
  });

  // ============ 详情矩阵:正向 200 + 负向 404 防枚举 ============
  describe('详情 5 档矩阵(可见 200 / 不可见 404 防枚举)', () => {
    it('volunteer:public/member → 200;formal/deptA/mgmt → 404', async () => {
      expect((await detailApp(volunteer.auth, cPublic)).status).toBe(200);
      expect((await detailApp(volunteer.auth, cMember)).status).toBe(200);
      expectBizError(await detailApp(volunteer.auth, cFormal), BizCode.CONTENT_NOT_FOUND);
      expectBizError(await detailApp(volunteer.auth, cDeptA), BizCode.CONTENT_NOT_FOUND);
      expectBizError(await detailApp(volunteer.auth, cMgmt), BizCode.CONTENT_NOT_FOUND);
    });

    it('formalA:public/member/formal/deptA → 200;deptB/mgmt → 404', async () => {
      expect((await detailApp(formalA.auth, cPublic)).status).toBe(200);
      expect((await detailApp(formalA.auth, cMember)).status).toBe(200);
      expect((await detailApp(formalA.auth, cFormal)).status).toBe(200);
      expect((await detailApp(formalA.auth, cDeptA)).status).toBe(200);
      expectBizError(await detailApp(formalA.auth, cDeptB), BizCode.CONTENT_NOT_FOUND);
      expectBizError(await detailApp(formalA.auth, cMgmt), BizCode.CONTENT_NOT_FOUND);
    });

    it('formalB:deptB → 200;deptA → 404(部门隔离)', async () => {
      expect((await detailApp(formalB.auth, cDeptB)).status).toBe(200);
      expectBizError(await detailApp(formalB.auth, cDeptA), BizCode.CONTENT_NOT_FOUND);
    });

    it('mgmt:management 档 → 200(边角能见)', async () => {
      const res = await detailApp(mgmtAuth, cMgmt);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(cMgmt);
      expect(res.body.data.visibilityCode).toBe('management');
    });

    it('详情读者出参零敏感:无 authorUserId / 无 visibleOrganizationIds(department 档亦不泄露 orgId 列表)', async () => {
      const res = await detailApp(formalA.auth, cDeptA);
      expect(res.status).toBe(200);
      expect(res.body.data).not.toHaveProperty('authorUserId');
      expect(res.body.data).not.toHaveProperty('visibleOrganizationIds');
      expect(res.body.data).not.toHaveProperty('statusCode');
    });
  });

  // ============ viewCount ============
  describe('viewCount:app 详情 +1,列表 / 404 不计', () => {
    it('可见详情每次 +1', async () => {
      const id = await makeContent({ title: 'C-vc', visibilityCode: 'public' });
      expect((await detailApp(volunteer.auth, id)).body.data.viewCount).toBe(1);
      expect((await detailApp(formalA.auth, id)).body.data.viewCount).toBe(2);
      const row = await prisma.content.findUnique({ where: { id }, select: { viewCount: true } });
      expect(row?.viewCount).toBe(2);
    });

    it('不可见详情(404)不增 viewCount', async () => {
      const before = await prisma.content.findUnique({
        where: { id: cMgmt },
        select: { viewCount: true },
      });
      await detailApp(volunteer.auth, cMgmt); // 404
      const after = await prisma.content.findUnique({
        where: { id: cMgmt },
        select: { viewCount: true },
      });
      expect(after?.viewCount).toBe(before?.viewCount);
    });
  });

  // ============ 搜索 + 标签 AND 可见性 ============
  describe('搜索 + 标签:与可见性 AND(搜不到越档)', () => {
    it('volunteer keyword 命中 formal 档标题 → 搜不到(可见性 AND)', async () => {
      const res = await listApp(volunteer.auth, '?keyword=C-formal');
      expect(res.status).toBe(200);
      const ids = (res.body.data.items as { id: string }[]).map((i) => i.id);
      expect(ids).not.toContain(cFormal);
    });

    it('formalB tags 命中 deptA 标签 → 搜不到(部门隔离 AND)', async () => {
      const tagged = await makeContent({
        title: 'C-deptA-tagged',
        visibilityCode: 'department',
        visibleOrganizationIds: [orgA],
        tags: ['xtag'],
      });
      const res = await listApp(formalB.auth, '?tags=xtag');
      const ids = (res.body.data.items as { id: string }[]).map((i) => i.id);
      expect(ids).not.toContain(tagged);
    });

    it('formalA keyword 命中自己可见的 deptA → 搜得到', async () => {
      const res = await listApp(formalA.auth, '?keyword=C-deptA');
      const ids = (res.body.data.items as { id: string }[]).map((i) => i.id);
      expect(ids).toContain(cDeptA);
    });
  });
});
