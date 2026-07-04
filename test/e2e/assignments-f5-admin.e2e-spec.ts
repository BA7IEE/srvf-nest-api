import type { INestApplication } from '@nestjs/common';
import { AssignmentStatus, Role, SupervisionScopeMode, SupervisionStatus } from '@prisma/client';
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

// F5「E 组」任职/分管总表 + preview e2e(2026-07-04;冻结路线图 admin-api-fe-integration-roadmap.md §4 E1/E2)。
// 覆盖 6 端点:E1 任职全局分页总表(过滤矩阵 + expand=member,position,organization + D6 缺省不展开)/
// detail(32020)/ preview(dry-run 任命校验逐项收集 violations + 零写入自证);
// E2 分管 /page(D9 兄弟路由,旧数组端点零触碰)/ detail(33001)/ coverage-preview(EXACT/TREE 展开 + 零写入)。
// **旧端点(任职组织轴/队员轴/revoke/history + 分管数组/CRUD)零触碰**:行为锁在
// position-assignments.e2e-spec.ts / supervision-assignments.e2e-spec.ts,本文件不改。
//
// 沿 role-bindings-enhanced / memberships-f4-admin 范式:本 spec 在 beforeAll 内联 seed 所需码 + 绑 ops-admin。

const F5_CODES = ['position-assignment.read.record', 'supervision-assignment.read.record'] as const;

async function seedF5CodesAndBind(prisma: PrismaService, opsAdminRoleId: string): Promise<void> {
  for (const code of F5_CODES) {
    const [module, action, resourceType] = code.split('.');
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, module, action, resourceType },
    });
  }
  const perms = await prisma.permission.findMany({
    where: { code: { in: [...F5_CODES] } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: opsAdminRoleId, permissionId: p.id })),
    skipDuplicates: true,
  });
}

const NONEXISTENT_ID = 'cl0nexistassignment00000x';
const PA_PATH = '/api/admin/v1/position-assignments';
const SA_PAGE_PATH = '/api/admin/v1/supervision-assignments/page';
const SA_COVERAGE_PATH = '/api/admin/v1/supervision-assignments/coverage-preview';

describe('F5/E 组 任职/分管增强面(总表 / detail / preview / coverage-preview)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminAuth: string; // ops-admin 持有者(F5 读码)
  let plainAdminAuth: string; // ADMIN 不持 ops-admin → 30100

  let rootId: string;
  let deptId: string;
  let groupId: string;

  let mLeaderId: string; // 部长(dept-leader@dept,ACTIVE)
  let mExLeaderId: string; // 已撤销任职(REVOKED@dept)
  let mSupervisorId: string; // 分管人(TREE@dept ACTIVE + REVOKED@root 历史)

  let deptLeaderPositionId: string; // seed 职务:dept-leader(requireMembership 依 seed 规则)
  let paActiveId: string;
  let paRevokedId: string;
  let saActiveId: string;
  let saRevokedId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const admin = await createTestUser(app, { username: 'f5a-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'f5a-adm-plain', role: Role.ADMIN });
    adminAuth = (await loginAs(app, 'f5a-adm')).authHeader;
    plainAdminAuth = (await loginAs(app, 'f5a-adm-plain')).authHeader;

    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await seedF5CodesAndBind(prisma, seed.opsAdminRoleId);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);

    // 组织树 root(rescue-team)→ dept(department)→ group(group)+ closure 最小边集
    const mkOrg = (name: string, parentId: string | null, nodeTypeCode: string) =>
      prisma.organization.create({
        data: { name, nodeTypeCode, parentId },
        select: { id: true },
      });
    rootId = (await mkOrg('F5 根队', null, 'rescue-team')).id;
    deptId = (await mkOrg('F5 部门', rootId, 'department')).id;
    groupId = (await mkOrg('F5 小组', deptId, 'group')).id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: rootId, descendantId: rootId, depth: 0 },
        { ancestorId: deptId, descendantId: deptId, depth: 0 },
        { ancestorId: groupId, descendantId: groupId, depth: 0 },
        { ancestorId: rootId, descendantId: deptId, depth: 1 },
        { ancestorId: rootId, descendantId: groupId, depth: 2 },
        { ancestorId: deptId, descendantId: groupId, depth: 1 },
      ],
      skipDuplicates: true,
    });

    const mkMember = (memberNo: string, displayName: string) =>
      prisma.member.create({ data: { memberNo, displayName }, select: { id: true } });
    mLeaderId = (await mkMember('f5a-l', 'F5 部长甲')).id;
    mExLeaderId = (await mkMember('f5a-x', 'F5 前任乙')).id;
    mSupervisorId = (await mkMember('f5a-s', 'F5 分管丙')).id;

    // 职务:直接建独立职务定义(不依赖 seed 6 职务;规则 department×职务 供 preview 职务适配路径)
    const position = await prisma.organizationPosition.create({
      data: {
        code: 'f5a-dept-leader',
        name: 'F5 部长',
        categoryCode: 'LEADER',
        allowMultiple: false,
        allowConcurrent: true,
      },
      select: { id: true },
    });
    deptLeaderPositionId = position.id;
    await prisma.organizationPositionRule.create({
      data: {
        nodeTypeCode: 'department',
        positionId: deptLeaderPositionId,
        requireMembership: true,
        status: 'ACTIVE',
      },
    });

    // 归属:部长甲 PRIMARY@dept(满足 requireMembership);前任乙无归属
    await prisma.memberOrganizationMembership.create({
      data: { memberId: mLeaderId, organizationId: deptId, membershipType: 'PRIMARY' },
    });

    // 任职:甲 ACTIVE@dept;乙 REVOKED@dept(历史)
    const paActive = await prisma.organizationPositionAssignment.create({
      data: {
        organizationId: deptId,
        positionId: deptLeaderPositionId,
        memberId: mLeaderId,
        status: AssignmentStatus.ACTIVE,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      select: { id: true },
    });
    paActiveId = paActive.id;
    const paRevoked = await prisma.organizationPositionAssignment.create({
      data: {
        organizationId: deptId,
        positionId: deptLeaderPositionId,
        memberId: mExLeaderId,
        status: AssignmentStatus.REVOKED,
        startedAt: new Date('2025-01-01T00:00:00.000Z'),
        endedAt: new Date('2025-12-31T00:00:00.000Z'),
      },
      select: { id: true },
    });
    paRevokedId = paRevoked.id;

    // 分管:丙 TREE@dept ACTIVE;丙 REVOKED@root 历史
    const saActive = await prisma.organizationSupervisionAssignment.create({
      data: {
        supervisorMemberId: mSupervisorId,
        organizationId: deptId,
        scopeMode: SupervisionScopeMode.TREE,
        status: SupervisionStatus.ACTIVE,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
      select: { id: true },
    });
    saActiveId = saActive.id;
    const saRevoked = await prisma.organizationSupervisionAssignment.create({
      data: {
        supervisorMemberId: mSupervisorId,
        organizationId: rootId,
        scopeMode: SupervisionScopeMode.EXACT,
        status: SupervisionStatus.REVOKED,
        startedAt: new Date('2025-01-01T00:00:00.000Z'),
        endedAt: new Date('2025-12-31T00:00:00.000Z'),
      },
      select: { id: true },
    });
    saRevokedId = saRevoked.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const idsOf = (res: request.Response): string[] =>
    res.body.data.items.map((i: { id: string }) => i.id);

  // ============ RBAC 门 ============

  describe('RBAC 门(读码复用;preview/coverage-preview 走 read 码 = goal 拍板)', () => {
    it('六端点:ADMIN 不持 ops-admin → 30100;未登录 → 401', async () => {
      expectBizError(
        await request(httpServer(app)).get(PA_PATH).set('Authorization', plainAdminAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .get(`${PA_PATH}/${paActiveId}`)
          .set('Authorization', plainAdminAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .post(`${PA_PATH}/preview`)
          .set('Authorization', plainAdminAuth)
          .send({
            organizationId: deptId,
            positionId: deptLeaderPositionId,
            memberId: mLeaderId,
            startedAt: '2026-08-01T00:00:00.000Z',
          }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app)).get(SA_PAGE_PATH).set('Authorization', plainAdminAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .get(`/api/admin/v1/supervision-assignments/${saActiveId}`)
          .set('Authorization', plainAdminAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .post(SA_COVERAGE_PATH)
          .set('Authorization', plainAdminAuth)
          .send({ organizationId: deptId }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(await request(httpServer(app)).get(PA_PATH), BizCode.UNAUTHORIZED);
    });
  });

  // ============ E1 任职总表 ============

  describe('GET /position-assignments(全局分页总表)', () => {
    function getPage(query: Record<string, string> = {}) {
      return request(httpServer(app)).get(PA_PATH).query(query).set('Authorization', adminAuth);
    }

    it('缺省含 REVOKED 历史(与组织轴仅 ACTIVE 刻意不同);status/memberId/positionId 过滤;分页外壳', async () => {
      const all = await getPage();
      expect(all.status).toBe(200);
      expect(all.body.data).toMatchObject({ page: 1, pageSize: 20 });
      expect(idsOf(all).sort()).toEqual([paActiveId, paRevokedId].sort());

      const active = await getPage({ status: 'ACTIVE' });
      expect(idsOf(active)).toEqual([paActiveId]);

      const byMember = await getPage({ memberId: mExLeaderId });
      expect(idsOf(byMember)).toEqual([paRevokedId]);

      const byPosition = await getPage({ positionId: deptLeaderPositionId });
      expect(idsOf(byPosition)).toHaveLength(2);
    });

    it('organizationId + includeDescendants(closure 展开);q 命中队员/职务/组织', async () => {
      const rootOnly = await getPage({ organizationId: rootId });
      expect(idsOf(rootOnly)).toHaveLength(0); // 任职都挂在 dept

      const rootTree = await getPage({ organizationId: rootId, includeDescendants: 'true' });
      expect(idsOf(rootTree)).toHaveLength(2);

      const byQ = await getPage({ q: 'f5a-x' });
      expect(idsOf(byQ)).toEqual([paRevokedId]);
      const byPosName = await getPage({ q: 'F5 部长' });
      expect(idsOf(byPosName).length).toBeGreaterThanOrEqual(2); // 命中职务名(两条)+ 队员名「F5 部长甲」
    });

    it('expand=member,position,organization 命中才附;缺省不含键(D6 形状锁);白名单外 → 40000', async () => {
      const plain = await getPage({ status: 'ACTIVE' });
      expect(plain.body.data.items[0]).not.toHaveProperty('member');
      expect(plain.body.data.items[0]).not.toHaveProperty('position');
      expect(plain.body.data.items[0]).not.toHaveProperty('organization');

      const expanded = await getPage({ status: 'ACTIVE', expand: 'member,position,organization' });
      const item = expanded.body.data.items[0];
      expect(item.member).toEqual({
        id: mLeaderId,
        memberNo: 'f5a-l',
        displayName: 'F5 部长甲',
        gradeCode: null,
      });
      expect(item.position).toMatchObject({
        id: deptLeaderPositionId,
        code: 'f5a-dept-leader',
        name: 'F5 部长',
        categoryCode: 'LEADER',
      });
      expect(item.organization).toMatchObject({ id: deptId, name: 'F5 部门' });

      expectBizError(await getPage({ expand: 'member,bogus' }), BizCode.BAD_REQUEST);
    });
  });

  describe('GET /position-assignments/:id(detail)', () => {
    it('命中 → 200(不含 expand 键);不存在 → 32020', async () => {
      const res = await request(httpServer(app))
        .get(`${PA_PATH}/${paRevokedId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: paRevokedId,
        organizationId: deptId,
        memberId: mExLeaderId,
        status: 'REVOKED',
      });
      expect(res.body.data).not.toHaveProperty('member');

      expectBizError(
        await request(httpServer(app))
          .get(`${PA_PATH}/${NONEXISTENT_ID}`)
          .set('Authorization', adminAuth),
        BizCode.POSITION_ASSIGNMENT_NOT_FOUND,
      );
    });
  });

  describe('POST /position-assignments/preview(dry-run 任命预检)', () => {
    function postPreview(body: Record<string, unknown>) {
      return request(httpServer(app))
        .post(`${PA_PATH}/preview`)
        .set('Authorization', adminAuth)
        .send(body);
    }

    it('可任命组合 → valid:true(职务适配+归属+独占全过);零写入自证', async () => {
      // 给前任乙补归属,使唯一 blocker 是 SINGLE_HOLDER —— 此用例先撤甲?否:换 group 无规则会撞适配。
      // 直接用「甲已在任」之外的干净组合:乙 @dept 同职务 —— 会撞 SINGLE_HOLDER。
      // 故本用例用甲自己换任期 preview?撞 ALREADY_EXISTS。→ 造第二个部门 dept2(同类别 department,规则复用)。
      const dept2 = await prisma.organization.create({
        data: { name: 'F5 部门二', nodeTypeCode: 'department', parentId: rootId },
        select: { id: true },
      });
      await prisma.organizationClosure.createMany({
        data: [
          { ancestorId: dept2.id, descendantId: dept2.id, depth: 0 },
          { ancestorId: rootId, descendantId: dept2.id, depth: 1 },
        ],
        skipDuplicates: true,
      });
      await prisma.memberOrganizationMembership.create({
        data: { memberId: mExLeaderId, organizationId: dept2.id, membershipType: 'PRIMARY' },
      });

      const before = await prisma.organizationPositionAssignment.count();
      const res = await postPreview({
        organizationId: dept2.id,
        positionId: deptLeaderPositionId,
        memberId: mExLeaderId,
        startedAt: '2026-08-01T00:00:00.000Z',
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ valid: true, violations: [] });
      expect(await prisma.organizationPositionAssignment.count()).toBe(before);
    });

    it('违规逐项收集(区别 create first-failure):任期 + 归属缺失 + 独占同批返回', async () => {
      // 组合:甲之外的新队员(无归属)+ dept(已有甲在任,独占)+ 倒置任期 → 3 项违规一次返齐
      const stranger = await prisma.member.create({
        data: { memberNo: 'f5a-n', displayName: 'F5 新丁' },
        select: { id: true },
      });
      const res = await postPreview({
        organizationId: deptId,
        positionId: deptLeaderPositionId,
        memberId: stranger.id,
        startedAt: '2026-08-01T00:00:00.000Z',
        endedAt: '2026-07-01T00:00:00.000Z',
      });
      expect(res.body.data.valid).toBe(false);
      const codes = res.body.data.violations.map((v: { bizCode: number }) => v.bizCode);
      expect(codes).toContain(BizCode.POSITION_ASSIGNMENT_TENURE_INVALID.code);
      expect(codes).toContain(BizCode.POSITION_ASSIGNMENT_MEMBERSHIP_REQUIRED.code);
      expect(codes).toContain(BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER.code);
    });

    it('防重(同人同坑)→ 32021;职务适配缺规则 → 32022;存在性缺失 → NOT_FOUND 违规项即返', async () => {
      const dup = await postPreview({
        organizationId: deptId,
        positionId: deptLeaderPositionId,
        memberId: mLeaderId,
        startedAt: '2026-08-01T00:00:00.000Z',
      });
      expect(dup.body.data.violations.map((v: { bizCode: number }) => v.bizCode)).toContain(
        BizCode.POSITION_ASSIGNMENT_ALREADY_EXISTS.code,
      );

      // group 无该职务规则 → 32022(甲在 group 无归属,32025 同批;两项都收集)
      const noRule = await postPreview({
        organizationId: groupId,
        positionId: deptLeaderPositionId,
        memberId: mLeaderId,
        startedAt: '2026-08-01T00:00:00.000Z',
      });
      const noRuleCodes = noRule.body.data.violations.map((v: { bizCode: number }) => v.bizCode);
      expect(noRuleCodes).toContain(BizCode.POSITION_ASSIGNMENT_RULE_NOT_MATCHED.code);

      const missing = await postPreview({
        organizationId: NONEXISTENT_ID,
        positionId: NONEXISTENT_ID,
        memberId: NONEXISTENT_ID,
        startedAt: '2026-08-01T00:00:00.000Z',
      });
      const missingCodes = missing.body.data.violations.map((v: { bizCode: number }) => v.bizCode);
      expect(missingCodes).toEqual(
        expect.arrayContaining([
          BizCode.ORGANIZATION_NOT_FOUND.code,
          BizCode.POSITION_NOT_FOUND.code,
          BizCode.MEMBER_NOT_FOUND.code,
        ]),
      );
    });
  });

  // ============ E2 分管 ============

  describe('GET /supervision-assignments/page(D9 兄弟路由)+ :id detail', () => {
    function getPage(query: Record<string, string> = {}) {
      return request(httpServer(app))
        .get(SA_PAGE_PATH)
        .query(query)
        .set('Authorization', adminAuth);
    }

    it('缺省含 REVOKED 历史(旧数组端点仅 ACTIVE,两口径并存);过滤矩阵', async () => {
      const all = await getPage();
      expect(idsOf(all).sort()).toEqual([saActiveId, saRevokedId].sort());

      // 旧数组端点(零触碰)仍仅 ACTIVE
      const legacy = await request(httpServer(app))
        .get('/api/admin/v1/supervision-assignments')
        .set('Authorization', adminAuth);
      expect(legacy.body.data.map((i: { id: string }) => i.id)).toEqual([saActiveId]);

      expect(idsOf(await getPage({ status: 'REVOKED' }))).toEqual([saRevokedId]);
      expect(idsOf(await getPage({ scopeMode: 'TREE' }))).toEqual([saActiveId]);
      expect(idsOf(await getPage({ supervisorMemberId: mSupervisorId }))).toHaveLength(2);
      expect(idsOf(await getPage({ organizationId: deptId }))).toEqual([saActiveId]);
      expect(
        idsOf(await getPage({ organizationId: rootId, includeDescendants: 'true' })),
      ).toHaveLength(2);
      expect(idsOf(await getPage({ q: 'F5 分管丙' }))).toHaveLength(2);
    });

    it('expand=supervisor,organization 命中才附;缺省不含键;detail 命中/33001', async () => {
      const plain = await getPage({ status: 'ACTIVE' });
      expect(plain.body.data.items[0]).not.toHaveProperty('supervisor');

      const expanded = await getPage({ status: 'ACTIVE', expand: 'supervisor,organization' });
      const item = expanded.body.data.items[0];
      expect(item.supervisor).toEqual({
        id: mSupervisorId,
        memberNo: 'f5a-s',
        displayName: 'F5 分管丙',
        gradeCode: null,
      });
      expect(item.organization).toMatchObject({ id: deptId, name: 'F5 部门' });

      const detail = await request(httpServer(app))
        .get(`/api/admin/v1/supervision-assignments/${saRevokedId}`)
        .set('Authorization', adminAuth);
      expect(detail.status).toBe(200);
      expect(detail.body.data).toMatchObject({ id: saRevokedId, status: 'REVOKED' });

      expectBizError(
        await request(httpServer(app))
          .get(`/api/admin/v1/supervision-assignments/${NONEXISTENT_ID}`)
          .set('Authorization', adminAuth),
        BizCode.SUPERVISION_ASSIGNMENT_NOT_FOUND,
      );
    });
  });

  describe('POST /supervision-assignments/coverage-preview(覆盖预演)', () => {
    function postCoverage(body: Record<string, unknown>) {
      return request(httpServer(app))
        .post(SA_COVERAGE_PATH)
        .set('Authorization', adminAuth)
        .send(body);
    }

    it('TREE(缺省)= closure 展开含后代与自身;EXACT = 仅该节点;零写入', async () => {
      const before = await prisma.organizationSupervisionAssignment.count();
      const tree = await postCoverage({ organizationId: deptId });
      expect(tree.status).toBe(200);
      expect(tree.body.data.scopeMode).toBe('TREE');
      expect(tree.body.data.expandedOrganizationIds.sort()).toEqual([deptId, groupId].sort());

      const exact = await postCoverage({ organizationId: deptId, scopeMode: 'EXACT' });
      expect(exact.body.data).toEqual({
        organizationId: deptId,
        scopeMode: 'EXACT',
        expandedOrganizationIds: [deptId],
      });
      expect(await prisma.organizationSupervisionAssignment.count()).toBe(before);
    });

    it('组织不存在 → 11001', async () => {
      expectBizError(
        await postCoverage({ organizationId: NONEXISTENT_ID }),
        BizCode.ORGANIZATION_NOT_FOUND,
      );
    });
  });
});
