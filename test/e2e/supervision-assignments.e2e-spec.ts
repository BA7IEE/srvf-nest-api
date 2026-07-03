import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
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

// 终态 scoped-authz PR5「分管」e2e(2026-07-01;冻结稿 §3.5 / §7.4 / §4.3 / R5 + goal DoD §7)。
// 覆盖:RBAC 边界 / 建分管(与职务正交:supervisor 无任何职务仍可建)/ 副队长乙双分管(SECT TREE + SSD EXACT 并存)/
//   supervision-scope(TREE 展开含子组、EXACT 不展开)/ supervisors(直接 DIRECT + 祖先 TREE 继承 INHERITED、
//   祖先 EXACT 不覆盖)/ 防重 SUPERVISION_ALREADY_EXISTS / 撤销后不再 active + supervisors 不含 /
//   改 scopeMode / 校验各自拒(supervisor 非会员 / 非 active / org 不存在 / 非 active / 任期非法)。
//
// RBAC:本仓 rbac.fixture 的 RBAC_PERMISSIONS 未含 supervision-assignment.*(沿 PR2/PR3/PR4 惯例);
// 为不改共享 fixture,本 spec 在 beforeAll 内联 seed 4 码 + 绑 ops-admin,再 grant 给 sup-adm(判权走 service 层 rbac.can,0 @Roles)。

const SUP_CODES = [
  'supervision-assignment.read.record',
  'supervision-assignment.create.record',
  'supervision-assignment.update.record',
  'supervision-assignment.revoke.record',
] as const;

async function seedSupervisionCodesAndBind(
  prisma: PrismaService,
  opsAdminRoleId: string,
): Promise<void> {
  for (const code of SUP_CODES) {
    const [module, action, resourceType] = code.split('.');
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, module, action, resourceType },
    });
  }
  const perms = await prisma.permission.findMany({
    where: { code: { in: [...SUP_CODES] } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: opsAdminRoleId, permissionId: p.id })),
    skipDuplicates: true,
  });
}

describe('supervision-assignments 分管管理', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string;
  let adminDefaultAuth: string;
  let userAuth: string;

  // 组织树(beforeAll 建一次,只读复用):
  //   SECT(rescue-team)→ SECTaction(group,子)   —— 副队长乙 TREE 分管 SECT
  //   SSD(rescue-team) → SSDsub(group,子)       —— 副队长乙 EXACT 分管 SSD(EXACT 不覆盖 SSDsub)
  let orgSECTId: string;
  let orgSECTactionId: string;
  let orgSSDId: string;
  let orgSSDsubId: string;

  let memberSeq = 0;
  async function newMember(tag: string): Promise<string> {
    memberSeq += 1;
    const m = await prisma.member.create({
      data: { memberNo: `sup-e2e-${tag}-${memberSeq}`, displayName: `SUP-${tag}-${memberSeq}` },
      select: { id: true },
    });
    return m.id;
  }

  const startedAt = '2026-07-01T00:00:00.000Z';

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const admin = await createTestUser(app, { username: 'sup-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'sup-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'sup-user', role: Role.USER });
    adminAuth = (await loginAs(app, 'sup-adm')).authHeader;
    adminDefaultAuth = (await loginAs(app, 'sup-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'sup-user')).authHeader;

    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await seedSupervisionCodesAndBind(prisma, seed.opsAdminRoleId);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);

    // 组织树。
    const sect = await prisma.organization.create({
      data: { name: 'sup-e2e-SECT', nodeTypeCode: 'rescue-team' },
      select: { id: true },
    });
    orgSECTId = sect.id;
    const sectAction = await prisma.organization.create({
      data: { name: 'sup-e2e-SECT-action', nodeTypeCode: 'group', parentId: orgSECTId },
      select: { id: true },
    });
    orgSECTactionId = sectAction.id;
    const ssd = await prisma.organization.create({
      data: { name: 'sup-e2e-SSD', nodeTypeCode: 'rescue-team' },
      select: { id: true },
    });
    orgSSDId = ssd.id;
    const ssdSub = await prisma.organization.create({
      data: { name: 'sup-e2e-SSD-sub', nodeTypeCode: 'group', parentId: orgSSDId },
      select: { id: true },
    });
    orgSSDsubId = ssdSub.id;

    // closure(手写,镜像 org service/migration 维护:depth-0 自身 + 两条父→子边)。
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: orgSECTId, descendantId: orgSECTId, depth: 0 },
        { ancestorId: orgSECTactionId, descendantId: orgSECTactionId, depth: 0 },
        { ancestorId: orgSSDId, descendantId: orgSSDId, depth: 0 },
        { ancestorId: orgSSDsubId, descendantId: orgSSDsubId, depth: 0 },
        { ancestorId: orgSECTId, descendantId: orgSECTactionId, depth: 1 },
        { ancestorId: orgSSDId, descendantId: orgSSDsubId, depth: 1 },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  function createSup(auth: string, body: Record<string, unknown>) {
    return request(httpServer(app))
      .post('/api/admin/v1/supervision-assignments')
      .set('Authorization', auth)
      .send(body);
  }

  // ============ RBAC 权限边界 ============

  describe('RBAC 权限边界', () => {
    it('未登录 GET 列表 → 401', async () => {
      const res = await request(httpServer(app)).get('/api/admin/v1/supervision-assignments');
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET 列表 → 30100', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/supervision-assignments')
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER POST 建分管 → 30100', async () => {
      const res = await createSup(userAuth, {
        supervisorMemberId: await newMember('rbac'),
        organizationId: orgSECTId,
        startedAt,
      });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('ADMIN 默认无 ops-admin → 30100', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/supervision-assignments')
        .set('Authorization', adminDefaultAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ 副队长乙场景:双分管并存 + scope 展开 ============

  describe('副队长乙场景:副队长(无本刀职务)分管 SECT + SSD', () => {
    it('建分管不要求 supervisor 持职务;SECT(TREE) + SSD(EXACT)两条 active 并存', async () => {
      const huangyong = await newMember('huangyong');
      // 副队长乙本刀不建任何 PositionAssignment(分管与职务正交,create 绝不校验持职务)。
      const a1 = await createSup(adminAuth, {
        supervisorMemberId: huangyong,
        organizationId: orgSECTId,
        scopeMode: 'TREE',
        startedAt,
      });
      expect(a1.status).toBe(201);
      expect(a1.body.code).toBe(0);
      expect(a1.body.data.status).toBe('ACTIVE');
      expect(a1.body.data.scopeMode).toBe('TREE');
      expect(a1.body.data.appointedByUserId).toBeTruthy();
      expect(a1.body.data).not.toHaveProperty('deletedAt');

      const a2 = await createSup(adminAuth, {
        supervisorMemberId: huangyong,
        organizationId: orgSSDId,
        scopeMode: 'EXACT',
        startedAt,
      });
      expect(a2.status).toBe(201);
      expect(a2.body.data.scopeMode).toBe('EXACT');

      // 分管范围:SECT(TREE)展开含子组 SECTaction;SSD(EXACT)仅自身。
      const scope = await request(httpServer(app))
        .get(`/api/admin/v1/members/${huangyong}/supervision-scope`)
        .set('Authorization', adminAuth);
      expect(scope.status).toBe(200);
      const entries = scope.body.data as Array<{
        organizationId: string;
        scopeMode: string;
        expandedOrganizationIds: string[];
      }>;
      const sect = entries.find((e) => e.organizationId === orgSECTId)!;
      const ssd = entries.find((e) => e.organizationId === orgSSDId)!;
      expect(sect.scopeMode).toBe('TREE');
      expect([...sect.expandedOrganizationIds].sort()).toEqual([orgSECTId, orgSECTactionId].sort());
      expect(ssd.scopeMode).toBe('EXACT');
      expect(ssd.expandedOrganizationIds).toEqual([orgSSDId]);
    });

    it('scopeMode 省略默认 TREE', async () => {
      const m = await newMember('default-tree');
      const res = await createSup(adminAuth, {
        supervisorMemberId: m,
        organizationId: orgSECTId,
        startedAt,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.scopeMode).toBe('TREE');
    });
  });

  // ============ supervisors:被谁分管(直接 + 祖先 TREE 继承;祖先 EXACT 不覆盖) ============

  describe('supervisors 被谁分管', () => {
    it('SECT 直接分管 DIRECT;子组 SECTaction 因 SECT TREE 而 INHERITED;SSDsub 不被 SSD EXACT 覆盖', async () => {
      const supervisor = await newMember('cover');
      await createSup(adminAuth, {
        supervisorMemberId: supervisor,
        organizationId: orgSECTId,
        scopeMode: 'TREE',
        startedAt,
      });
      await createSup(adminAuth, {
        supervisorMemberId: supervisor,
        organizationId: orgSSDId,
        scopeMode: 'EXACT',
        startedAt,
      });

      // SECT 本身:该 supervisor DIRECT。
      const sectSup = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${orgSECTId}/supervisors`)
        .set('Authorization', adminAuth);
      expect(sectSup.status).toBe(200);
      const sectRows = sectSup.body.data as Array<{
        coverage: string;
        supervisionAssignment: { supervisorMemberId: string };
      }>;
      const mineOnSect = sectRows.find(
        (r) => r.supervisionAssignment.supervisorMemberId === supervisor,
      )!;
      expect(mineOnSect.coverage).toBe('DIRECT');

      // 子组 SECTaction:因 SECT TREE 覆盖 → INHERITED。
      const actionSup = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${orgSECTactionId}/supervisors`)
        .set('Authorization', adminAuth);
      const actionRows = actionSup.body.data as Array<{
        coverage: string;
        supervisionAssignment: { supervisorMemberId: string };
      }>;
      const mineOnAction = actionRows.find(
        (r) => r.supervisionAssignment.supervisorMemberId === supervisor,
      )!;
      expect(mineOnAction.coverage).toBe('INHERITED');

      // SSDsub:SSD 是 EXACT,不覆盖子组 → 该 supervisor 不在列。
      const ssdSubSup = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${orgSSDsubId}/supervisors`)
        .set('Authorization', adminAuth);
      const ssdSubRows = ssdSubSup.body.data as Array<{
        supervisionAssignment: { supervisorMemberId: string };
      }>;
      expect(
        ssdSubRows.some((r) => r.supervisionAssignment.supervisorMemberId === supervisor),
      ).toBe(false);
    });
  });

  // ============ 防重 + 校验 ============

  describe('建分管校验', () => {
    it('防重:同人对同组织已有 active → SUPERVISION_ALREADY_EXISTS', async () => {
      const m = await newMember('dup');
      const first = await createSup(adminAuth, {
        supervisorMemberId: m,
        organizationId: orgSECTId,
        startedAt,
      });
      expect(first.status).toBe(201);
      const res = await createSup(adminAuth, {
        supervisorMemberId: m,
        organizationId: orgSECTId,
        startedAt,
      });
      expectBizError(res, BizCode.SUPERVISION_ALREADY_EXISTS);
    });

    it('任期非法:endedAt ≤ startedAt → TENURE_INVALID', async () => {
      const res = await createSup(adminAuth, {
        supervisorMemberId: await newMember('tenure'),
        organizationId: orgSECTId,
        startedAt,
        endedAt: startedAt,
      });
      expectBizError(res, BizCode.SUPERVISION_ASSIGNMENT_TENURE_INVALID);
    });

    it('supervisor 非会员(不存在)→ MEMBER_NOT_FOUND', async () => {
      const res = await createSup(adminAuth, {
        supervisorMemberId: 'cl0000000000000000000000',
        organizationId: orgSECTId,
        startedAt,
      });
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('supervisor 非 active → MEMBER_INACTIVE', async () => {
      const inactive = await prisma.member.create({
        data: {
          memberNo: `sup-e2e-inactive-${Date.now()}`,
          displayName: 'inactive',
          status: 'INACTIVE',
        },
        select: { id: true },
      });
      const res = await createSup(adminAuth, {
        supervisorMemberId: inactive.id,
        organizationId: orgSECTId,
        startedAt,
      });
      expectBizError(res, BizCode.MEMBER_INACTIVE);
    });

    it('org 不存在 → ORGANIZATION_NOT_FOUND', async () => {
      const res = await createSup(adminAuth, {
        supervisorMemberId: await newMember('noorg'),
        organizationId: 'cl0000000000000000000000',
        startedAt,
      });
      expectBizError(res, BizCode.ORGANIZATION_NOT_FOUND);
    });

    it('org 非 active → ORGANIZATION_INACTIVE', async () => {
      const inactiveOrg = await prisma.organization.create({
        data: {
          name: `sup-e2e-inactive-org-${Date.now()}`,
          nodeTypeCode: 'group',
          status: 'INACTIVE',
        },
        select: { id: true },
      });
      const res = await createSup(adminAuth, {
        supervisorMemberId: await newMember('inactiveorg'),
        organizationId: inactiveOrg.id,
        startedAt,
      });
      expectBizError(res, BizCode.ORGANIZATION_INACTIVE);
    });
  });

  // ============ 改 + 撤销 ============

  describe('改 + 撤销', () => {
    it('PATCH 改 scopeMode(TREE→EXACT)', async () => {
      const m = await newMember('patch');
      const created = await createSup(adminAuth, {
        supervisorMemberId: m,
        organizationId: orgSECTId,
        scopeMode: 'TREE',
        startedAt,
      });
      const id = created.body.data.id as string;
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/supervision-assignments/${id}`)
        .set('Authorization', adminAuth)
        .send({ scopeMode: 'EXACT', note: '收窄为仅本节点' });
      expect(res.status).toBe(200);
      expect(res.body.data.scopeMode).toBe('EXACT');
      expect(res.body.data.note).toBe('收窄为仅本节点');
    });

    it('PATCH 不存在 → NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .patch('/api/admin/v1/supervision-assignments/cl0000000000000000000000')
        .set('Authorization', adminAuth)
        .send({ scopeMode: 'EXACT' });
      expectBizError(res, BizCode.SUPERVISION_ASSIGNMENT_NOT_FOUND);
    });

    it('撤销 active → REVOKED;列表不再 active;supervisors 查询不含', async () => {
      const m = await newMember('revoke');
      const created = await createSup(adminAuth, {
        supervisorMemberId: m,
        organizationId: orgSSDId,
        scopeMode: 'EXACT',
        startedAt,
      });
      const id = created.body.data.id as string;

      const rev = await request(httpServer(app))
        .post(`/api/admin/v1/supervision-assignments/${id}/revoke`)
        .set('Authorization', adminAuth);
      expect(rev.status).toBe(201);
      expect(rev.body.data.status).toBe('REVOKED');
      expect(rev.body.data.revokedByUserId).toBeTruthy();
      expect(rev.body.data.endedAt).toBeTruthy();

      // 扁平列表(仅 ACTIVE)不再含。
      const list = await request(httpServer(app))
        .get('/api/admin/v1/supervision-assignments')
        .set('Authorization', adminAuth);
      expect((list.body.data as Array<{ id: string }>).some((r) => r.id === id)).toBe(false);

      // supervisors(SSD)不再含该 supervisor(该撤销记录)。
      const sup = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${orgSSDId}/supervisors`)
        .set('Authorization', adminAuth);
      expect(
        (sup.body.data as Array<{ supervisionAssignment: { id: string } }>).some(
          (r) => r.supervisionAssignment.id === id,
        ),
      ).toBe(false);
    });

    it('重复撤销 → ALREADY_ENDED', async () => {
      const m = await newMember('re-revoke');
      const created = await createSup(adminAuth, {
        supervisorMemberId: m,
        organizationId: orgSSDId,
        scopeMode: 'EXACT',
        startedAt,
      });
      const id = created.body.data.id as string;
      await request(httpServer(app))
        .post(`/api/admin/v1/supervision-assignments/${id}/revoke`)
        .set('Authorization', adminAuth);
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/supervision-assignments/${id}/revoke`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.SUPERVISION_ASSIGNMENT_ALREADY_ENDED);
    });

    it('撤销后同人对同组织可再建(旧 REVOKED 不占 active 唯一)', async () => {
      const m = await newMember('re-create');
      const first = await createSup(adminAuth, {
        supervisorMemberId: m,
        organizationId: orgSSDId,
        scopeMode: 'EXACT',
        startedAt,
      });
      const id = first.body.data.id as string;
      await request(httpServer(app))
        .post(`/api/admin/v1/supervision-assignments/${id}/revoke`)
        .set('Authorization', adminAuth);
      const second = await createSup(adminAuth, {
        supervisorMemberId: m,
        organizationId: orgSSDId,
        scopeMode: 'TREE',
        startedAt: '2026-08-01T00:00:00.000Z',
      });
      expect(second.status).toBe(201);
      expect(second.body.data.status).toBe('ACTIVE');
    });
  });
});
