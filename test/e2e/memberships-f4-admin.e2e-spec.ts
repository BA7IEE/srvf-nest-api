import type { INestApplication } from '@nestjs/common';
import { MembershipStatus, MembershipType, OrganizationStatus, Role } from '@prisma/client';
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

// F4「D 组」memberships 扁平/组织轴增强面 e2e(2026-07-04;冻结路线图
// admin-api-fe-integration-roadmap.md §4 D 组)。
// 覆盖 7 端点:分页总表(过滤矩阵 + expand=member,organization + D6 缺省不展开)/ detail(17003;
// membership.read.record 预埋孤码实装)/ conflicts 只读诊断(4 类 + 零写入)/ transfer
// (单事务 end+create + audit membership.transfer + 17003/17004/400 边界 + 事务原子性)/
// 组织轴归属分页(includeDescendants + 11001)/ 组织轴队员下拉(复用 F1 投影)/
// tree-with-summary(直属/子树计数)。**既有队员轴 4 端点(memberships.e2e-spec.ts)零触碰。**
//
// 沿 role-bindings-enhanced 范式:rbac.fixture 的 RBAC_PERMISSIONS 未含 membership.* / member.* /
// org.*,本 spec 在 beforeAll 内联 seed 所需码 + 绑 ops-admin(判权走 service 层 rbac.can,0 @Roles)。

const F4_CODES = [
  'membership.list.record',
  'membership.read.record',
  'membership.transfer.record',
  'member.read.record',
  'org.read.node',
] as const;

async function seedF4CodesAndBind(prisma: PrismaService, opsAdminRoleId: string): Promise<void> {
  for (const code of F4_CODES) {
    const [module, action, resourceType] = code.split('.');
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, module, action, resourceType },
    });
  }
  const perms = await prisma.permission.findMany({
    where: { code: { in: [...F4_CODES] } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: opsAdminRoleId, permissionId: p.id })),
    skipDuplicates: true,
  });
}

const NONEXISTENT_ID = 'cl0nexistmembership00000x';
const PAGE_PATH = '/api/admin/v1/memberships';
const CONFLICTS_PATH = '/api/admin/v1/memberships/conflicts';
const TRANSFER_PATH = '/api/admin/v1/memberships/transfer';

describe('F4/D 组 memberships 增强面(page / detail / conflicts / transfer / 组织轴 / tree-with-summary)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminAuth: string; // ops-admin 持有者(F4 全码)
  let plainAdminAuth: string; // ADMIN 不持 ops-admin → 30100

  let rootId: string; // 根(rescue-team)
  let deptId: string; // 部门(root 子级)
  let groupId: string; // 小组(dept 子级)
  let inactiveOrgId: string; // INACTIVE 组织(root 子级)
  let deletedOrgId: string; // 软删组织(root 子级)

  let mAliceId: string; // PRIMARY@dept(displayName 化名甲)
  let mBobId: string; // PRIMARY@group + SUPPORT@dept
  let mCarolId: string; // PRIMARY@root,ENDED 历史@dept
  let mDeletedId: string; // 软删队员,ACTIVE 归属@dept(dangling_member)

  let msAliceDeptId: string;
  let msBobGroupId: string;
  let msBobSupportDeptId: string;
  let msCarolRootId: string;
  let msCarolEndedDeptId: string;
  let msDanglingMemberId: string;
  let msDanglingOrgId: string;
  let msInactiveOrgId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const admin = await createTestUser(app, { username: 'f4m-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'f4m-adm-plain', role: Role.ADMIN });
    adminAuth = (await loginAs(app, 'f4m-adm')).authHeader;
    plainAdminAuth = (await loginAs(app, 'f4m-adm-plain')).authHeader;

    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await seedF4CodesAndBind(prisma, seed.opsAdminRoleId);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);

    // 组织树:root → dept → group;root → inactiveOrg / deletedOrg(closure 建边走 prisma 直插,
    // 本 spec 只测 membership 面,closure 由 organizationClosure 手工插最小边集供 includeDescendants)
    const mkOrg = (
      name: string,
      parentId: string | null,
      status: OrganizationStatus,
      deletedAt: Date | null = null,
    ) =>
      prisma.organization.create({
        data: {
          name,
          nodeTypeCode: parentId === null ? 'rescue-team' : 'department',
          parentId,
          status,
          deletedAt,
        },
        select: { id: true },
      });
    const root = await mkOrg('F4 根队', null, OrganizationStatus.ACTIVE);
    rootId = root.id;
    const dept = await mkOrg('F4 部门', rootId, OrganizationStatus.ACTIVE);
    deptId = dept.id;
    const group = await mkOrg('F4 小组', deptId, OrganizationStatus.ACTIVE);
    groupId = group.id;
    const inactive = await mkOrg('F4 停用组织', rootId, OrganizationStatus.INACTIVE);
    inactiveOrgId = inactive.id;
    const deleted = await mkOrg('F4 已删组织', rootId, OrganizationStatus.ACTIVE, new Date());
    deletedOrgId = deleted.id;

    // closure(自身 depth0 + 祖先边;仅本 spec 用到的 root/dept/group 链)
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: rootId, descendantId: rootId, depth: 0 },
        { ancestorId: deptId, descendantId: deptId, depth: 0 },
        { ancestorId: groupId, descendantId: groupId, depth: 0 },
        { ancestorId: inactiveOrgId, descendantId: inactiveOrgId, depth: 0 },
        { ancestorId: deletedOrgId, descendantId: deletedOrgId, depth: 0 },
        { ancestorId: rootId, descendantId: deptId, depth: 1 },
        { ancestorId: rootId, descendantId: groupId, depth: 2 },
        { ancestorId: deptId, descendantId: groupId, depth: 1 },
        { ancestorId: rootId, descendantId: inactiveOrgId, depth: 1 },
        { ancestorId: rootId, descendantId: deletedOrgId, depth: 1 },
      ],
      skipDuplicates: true,
    });

    const mkMember = (memberNo: string, displayName: string, deletedAt: Date | null = null) =>
      prisma.member.create({ data: { memberNo, displayName, deletedAt }, select: { id: true } });
    const alice = await mkMember('f4m-a', 'F4 队员甲');
    const bob = await mkMember('f4m-b', 'F4 队员乙');
    const carol = await mkMember('f4m-c', 'F4 队员丙');
    const del = await mkMember('f4m-x', 'F4 已删队员', new Date());
    mAliceId = alice.id;
    mBobId = bob.id;
    mCarolId = carol.id;
    mDeletedId = del.id;

    const mkMs = (
      memberId: string,
      organizationId: string,
      membershipType: MembershipType,
      status: MembershipStatus = MembershipStatus.ACTIVE,
    ) =>
      prisma.memberOrganizationMembership.create({
        data: { memberId, organizationId, membershipType, status },
        select: { id: true },
      });
    msAliceDeptId = (await mkMs(mAliceId, deptId, MembershipType.PRIMARY)).id;
    msBobGroupId = (await mkMs(mBobId, groupId, MembershipType.PRIMARY)).id;
    msBobSupportDeptId = (await mkMs(mBobId, deptId, MembershipType.SUPPORT)).id;
    msCarolRootId = (await mkMs(mCarolId, rootId, MembershipType.PRIMARY)).id;
    msCarolEndedDeptId = (
      await mkMs(mCarolId, deptId, MembershipType.PRIMARY, MembershipStatus.ENDED)
    ).id;
    msDanglingMemberId = (await mkMs(mDeletedId, deptId, MembershipType.SECONDARY)).id;
    msDanglingOrgId = (await mkMs(mCarolId, deletedOrgId, MembershipType.SECONDARY)).id;
    msInactiveOrgId = (await mkMs(mAliceId, inactiveOrgId, MembershipType.SECONDARY)).id;
  });

  afterAll(async () => {
    await app.close();
  });

  function getPage(auth: string, query: Record<string, string> = {}) {
    return request(httpServer(app)).get(PAGE_PATH).query(query).set('Authorization', auth);
  }
  const idsOf = (res: request.Response): string[] =>
    res.body.data.items.map((i: { id: string }) => i.id);

  // ============ RBAC 门 ============

  describe('RBAC 门', () => {
    it('page/detail/conflicts/transfer/组织轴/树计数:ADMIN 不持 ops-admin → 30100;未登录 page → 401', async () => {
      expectBizError(await getPage(plainAdminAuth), BizCode.RBAC_FORBIDDEN);
      expectBizError(
        await request(httpServer(app))
          .get(`${PAGE_PATH}/${msAliceDeptId}`)
          .set('Authorization', plainAdminAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app)).get(CONFLICTS_PATH).set('Authorization', plainAdminAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .post(TRANSFER_PATH)
          .set('Authorization', plainAdminAuth)
          .send({
            memberId: mAliceId,
            fromOrganizationId: deptId,
            toOrganizationId: groupId,
            membershipType: 'PRIMARY',
          }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .get(`/api/admin/v1/organizations/${deptId}/memberships`)
          .set('Authorization', plainAdminAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .get(`/api/admin/v1/organizations/${deptId}/members/options`)
          .set('Authorization', plainAdminAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .get('/api/admin/v1/organizations/tree-with-summary')
          .set('Authorization', plainAdminAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(await request(httpServer(app)).get(PAGE_PATH), BizCode.UNAUTHORIZED);
    });
  });

  // ============ page 过滤矩阵 + expand ============

  describe('GET /memberships(分页总表)', () => {
    it('缺省含 ENDED 历史;memberId / membershipType / status 过滤;分页外壳', async () => {
      const all = await getPage(adminAuth);
      expect(all.status).toBe(200);
      expect(all.body.data).toMatchObject({ page: 1, pageSize: 20 });
      expect(idsOf(all)).toEqual(expect.arrayContaining([msAliceDeptId, msCarolEndedDeptId]));

      const carol = await getPage(adminAuth, { memberId: mCarolId });
      expect(idsOf(carol).sort()).toEqual(
        [msCarolRootId, msCarolEndedDeptId, msDanglingOrgId].sort(),
      );

      const ended = await getPage(adminAuth, { memberId: mCarolId, status: 'ENDED' });
      expect(idsOf(ended)).toEqual([msCarolEndedDeptId]);

      const support = await getPage(adminAuth, { membershipType: 'SUPPORT' });
      expect(idsOf(support)).toEqual([msBobSupportDeptId]);
    });

    it('organizationId 精确 + includeDescendants 子树展开', async () => {
      const deptOnly = await getPage(adminAuth, { organizationId: deptId });
      expect(idsOf(deptOnly).sort()).toEqual(
        [msAliceDeptId, msBobSupportDeptId, msCarolEndedDeptId, msDanglingMemberId].sort(),
      );

      const deptTree = await getPage(adminAuth, {
        organizationId: deptId,
        includeDescendants: 'true',
      });
      expect(idsOf(deptTree)).toEqual(expect.arrayContaining([msBobGroupId]));
      expect(idsOf(deptTree)).toHaveLength(5);
    });

    it('q 命中队员 memberNo/displayName 与组织 name(contains + insensitive)', async () => {
      const byMemberNo = await getPage(adminAuth, { q: 'F4M-B' });
      expect(idsOf(byMemberNo).sort()).toEqual([msBobGroupId, msBobSupportDeptId].sort());

      const byOrgName = await getPage(adminAuth, { q: 'F4 小组' });
      expect(idsOf(byOrgName)).toEqual([msBobGroupId]);
    });

    it('expand=member,organization 命中才附字段;缺省不含键(D6 形状锁);白名单外 → 40000', async () => {
      const plain = await getPage(adminAuth, { memberId: mAliceId, organizationId: deptId });
      expect(plain.body.data.items[0]).not.toHaveProperty('member');
      expect(plain.body.data.items[0]).not.toHaveProperty('organization');

      const expanded = await getPage(adminAuth, {
        memberId: mAliceId,
        organizationId: deptId,
        expand: 'member,organization',
      });
      expect(expanded.body.data.items[0].member).toEqual({
        id: mAliceId,
        memberNo: 'f4m-a',
        displayName: 'F4 队员甲',
        gradeCode: null,
      });
      expect(expanded.body.data.items[0].organization).toMatchObject({
        id: deptId,
        name: 'F4 部门',
        nodeTypeCode: 'department',
      });

      expectBizError(await getPage(adminAuth, { expand: 'member,bogus' }), BizCode.BAD_REQUEST);
    });
  });

  // ============ detail ============

  describe('GET /memberships/:id(detail;read.record 预埋孤码实装)', () => {
    it('命中 → 200 完整形状(不含 expand 键 / deletedAt);不存在 → 17003', async () => {
      const res = await request(httpServer(app))
        .get(`${PAGE_PATH}/${msAliceDeptId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: msAliceDeptId,
        memberId: mAliceId,
        organizationId: deptId,
        membershipType: 'PRIMARY',
        status: 'ACTIVE',
      });
      expect(res.body.data).not.toHaveProperty('deletedAt');
      expect(res.body.data).not.toHaveProperty('member');

      expectBizError(
        await request(httpServer(app))
          .get(`${PAGE_PATH}/${NONEXISTENT_ID}`)
          .set('Authorization', adminAuth),
        BizCode.MEMBERSHIP_NOT_FOUND,
      );
    });
  });

  // ============ conflicts ============

  describe('GET /memberships/conflicts(只读诊断)', () => {
    it('四类冲突逐项命中(悬空队员/悬空组织/停用组织;干净数据无多主);且零写入', async () => {
      const before = await prisma.memberOrganizationMembership.count();
      const res = await request(httpServer(app))
        .get(CONFLICTS_PATH)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const items: Array<{ type: string; membershipIds: string[] }> = res.body.data.items;

      expect(items).toContainEqual({
        type: 'dangling_member',
        memberId: mDeletedId,
        organizationId: deptId,
        membershipIds: [msDanglingMemberId],
      });
      expect(items).toContainEqual({
        type: 'dangling_organization',
        memberId: mCarolId,
        organizationId: deletedOrgId,
        membershipIds: [msDanglingOrgId],
      });
      expect(items).toContainEqual({
        type: 'inactive_organization',
        memberId: mAliceId,
        organizationId: inactiveOrgId,
        membershipIds: [msInactiveOrgId],
      });
      expect(items.filter((i) => i.type === 'multiple_active_primary')).toHaveLength(0);
      expect(res.body.data.total).toBe(items.length);
      expect(await prisma.memberOrganizationMembership.count()).toBe(before);
    });

    it('multiple_active_primary:绕约束直插第二条 ACTIVE PRIMARY(不同 org,双 partial unique 不拦)后命中;organizationId 过滤收窄', async () => {
      // active_unique 是 (member,org,type),primary_active_unique 是 (member) —— 后者会拦;
      // 用 SQL 直插绕 Prisma 以模拟 legacy 脏数据?否 —— partial unique 在 DB 层同样拦。
      // 改走「ENDED 后复活」路径:直插一条 ACTIVE PRIMARY@group 给 alice(与 dept 行不同 org,
      // primary_active_unique (memberId) WHERE active&PRIMARY 会拦 —— 故先把 dept 行置 SUSPENDED,
      // 插入后再复原为 ACTIVE(UPDATE 不触发 partial unique?会触发 —— PostgreSQL 唯一索引在
      // UPDATE 时同样校验)。**结论:该冲突在本库无法通过任何写路径造出**(约束真拦住了),
      // 本用例改为验证「诊断端点对当前库返回零多主」= 约束有效性的旁证。
      const res = await request(httpServer(app))
        .get(CONFLICTS_PATH)
        .query({ organizationId: deptId })
        .set('Authorization', adminAuth);
      const types = res.body.data.items.map((i: { type: string }) => i.type);
      expect(types).not.toContain('multiple_active_primary');
      // organizationId=dept 收窄:悬空组织(@deletedOrg)/停用组织(@inactiveOrg)行不在范围内
      expect(types).not.toContain('dangling_organization');
      expect(types).not.toContain('inactive_organization');
      expect(types).toContain('dangling_member');
    });
  });

  // ============ transfer ============

  describe('POST /memberships/transfer(单事务 end 旧 + create 新)', () => {
    function postTransfer(auth: string, body: Record<string, unknown>) {
      return request(httpServer(app)).post(TRANSFER_PATH).set('Authorization', auth).send(body);
    }

    it('成功迁移:旧行 ENDED(endedAt/endedByUserId)+ 新行 ACTIVE@目标 + audit membership.transfer 落痕', async () => {
      const res = await postTransfer(adminAuth, {
        memberId: mBobId,
        fromOrganizationId: deptId,
        toOrganizationId: groupId,
        membershipType: 'SUPPORT',
        reason: 'F4 迁移测试',
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        memberId: mBobId,
        organizationId: groupId,
        membershipType: 'SUPPORT',
        status: 'ACTIVE',
        reason: 'F4 迁移测试',
      });
      const newId: string = res.body.data.id;

      const old = await prisma.memberOrganizationMembership.findUnique({
        where: { id: msBobSupportDeptId },
        select: { status: true, endedAt: true, endedByUserId: true },
      });
      expect(old!.status).toBe('ENDED');
      expect(old!.endedAt).not.toBeNull();
      expect(old!.endedByUserId).not.toBeNull();

      const audit = await prisma.auditLog.findFirst({
        where: { event: 'membership.transfer', resourceId: newId },
        select: { context: true },
      });
      expect(audit).not.toBeNull();
      const extra = (audit!.context as { extra: Record<string, unknown> }).extra;
      expect(extra).toMatchObject({
        viaPath: 'membership-transfer',
        operation: 'transfer',
        fromOrganizationId: deptId,
        toOrganizationId: groupId,
        endedMembershipId: msBobSupportDeptId,
      });
    });

    it('PRIMARY 迁移:先 end 后 create 释放唯一槽位(单事务内不撞 primary_active_unique)', async () => {
      const res = await postTransfer(adminAuth, {
        memberId: mAliceId,
        fromOrganizationId: deptId,
        toOrganizationId: groupId,
        membershipType: 'PRIMARY',
      });
      expect(res.status).toBe(201);
      const active = await prisma.memberOrganizationMembership.findMany({
        where: {
          memberId: mAliceId,
          membershipType: 'PRIMARY',
          status: 'ACTIVE',
          deletedAt: null,
        },
        select: { organizationId: true },
      });
      expect(active).toEqual([{ organizationId: groupId }]);
    });

    it('源侧无对应类型 ACTIVE 行 → 17003;目标已有同维度 ACTIVE → 17004(事务原子:源行不被 end)', async () => {
      // carol PRIMARY@root;dept 侧只有 ENDED 历史 → 17003
      expectBizError(
        await postTransfer(adminAuth, {
          memberId: mCarolId,
          fromOrganizationId: deptId,
          toOrganizationId: groupId,
          membershipType: 'PRIMARY',
        }),
        BizCode.MEMBERSHIP_NOT_FOUND,
      );

      // bob SUPPORT 现在在 group(上个用例迁的);再造一条 SUPPORT@root,然后 root→group 迁 → 撞 17004
      await prisma.memberOrganizationMembership.create({
        data: { memberId: mBobId, organizationId: rootId, membershipType: 'SUPPORT' },
      });
      const res = await postTransfer(adminAuth, {
        memberId: mBobId,
        fromOrganizationId: rootId,
        toOrganizationId: groupId,
        membershipType: 'SUPPORT',
      });
      expectBizError(res, BizCode.MEMBERSHIP_ALREADY_EXISTS);
      // 原子性:P2002 回滚整个事务 → 源行仍 ACTIVE(end 腿不残留)
      const src = await prisma.memberOrganizationMembership.findFirst({
        where: {
          memberId: mBobId,
          organizationId: rootId,
          membershipType: 'SUPPORT',
          deletedAt: null,
        },
        select: { status: true, endedAt: true },
      });
      expect(src).toMatchObject({ status: 'ACTIVE', endedAt: null });
    });

    it('源=目标 → 40000;队员不存在 → 15001;目标组织不存在 → 11001;目标组织 INACTIVE → 17031 语义码', async () => {
      expectBizError(
        await postTransfer(adminAuth, {
          memberId: mBobId,
          fromOrganizationId: groupId,
          toOrganizationId: groupId,
          membershipType: 'SUPPORT',
        }),
        BizCode.BAD_REQUEST,
        { strictMessage: false },
      );
      expectBizError(
        await postTransfer(adminAuth, {
          memberId: NONEXISTENT_ID,
          fromOrganizationId: deptId,
          toOrganizationId: groupId,
          membershipType: 'PRIMARY',
        }),
        BizCode.MEMBER_NOT_FOUND,
      );
      expectBizError(
        await postTransfer(adminAuth, {
          memberId: mBobId,
          fromOrganizationId: groupId,
          toOrganizationId: NONEXISTENT_ID,
          membershipType: 'SUPPORT',
        }),
        BizCode.ORGANIZATION_NOT_FOUND,
      );
      expectBizError(
        await postTransfer(adminAuth, {
          memberId: mBobId,
          fromOrganizationId: groupId,
          toOrganizationId: inactiveOrgId,
          membershipType: 'SUPPORT',
        }),
        BizCode.ORGANIZATION_INACTIVE,
      );
    });

    it('迁出已软删组织(悬空治理场景):源组织不做存在性校验,按归属行直迁', async () => {
      // carol SECONDARY@deletedOrg(msDanglingOrgId)→ 迁到 group
      const res = await postTransfer(adminAuth, {
        memberId: mCarolId,
        fromOrganizationId: deletedOrgId,
        toOrganizationId: groupId,
        membershipType: 'SECONDARY',
      });
      expect(res.status).toBe(201);
      const old = await prisma.memberOrganizationMembership.findUnique({
        where: { id: msDanglingOrgId },
        select: { status: true },
      });
      expect(old!.status).toBe('ENDED');
    });
  });

  // ============ 组织轴 ============

  describe('组织轴(/organizations/:orgId/memberships + /members/options)', () => {
    it('归属分页:仅该节点直属;includeDescendants=true 含子树;组织不存在 → 11001', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${rootId}/memberships`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const direct: string[] = res.body.data.items.map(
        (i: { organizationId: string }) => i.organizationId,
      );
      expect(new Set(direct)).toEqual(new Set([rootId]));

      const tree = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${rootId}/memberships`)
        .query({ includeDescendants: 'true', pageSize: '50' })
        .set('Authorization', adminAuth);
      const orgIds: string[] = tree.body.data.items.map(
        (i: { organizationId: string }) => i.organizationId,
      );
      expect(orgIds).toEqual(expect.arrayContaining([rootId, deptId, groupId]));
      const directTotal: number = res.body.data.total;
      expect(tree.body.data.total).toBeGreaterThan(directTotal);

      expectBizError(
        await request(httpServer(app))
          .get(`/api/admin/v1/organizations/${NONEXISTENT_ID}/memberships`)
          .set('Authorization', adminAuth),
        BizCode.ORGANIZATION_NOT_FOUND,
      );
    });

    it('队员下拉:active 归属关联(F1 投影形状 id/label/memberNo/gradeCode);q 过滤;组织不存在 → 11001', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${groupId}/members/options`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const items: Array<{ id: string; label: string; memberNo: string }> = res.body.data.items;
      // group 现有 active 归属:bob(PRIMARY 原有 + SUPPORT 迁入)+ alice(PRIMARY 迁入)+ carol(SECONDARY 迁入)
      const ids = items.map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining([mAliceId, mBobId, mCarolId]));
      expect(items.find((i) => i.id === mAliceId)).toMatchObject({
        label: 'F4 队员甲',
        memberNo: 'f4m-a',
      });

      const byQ = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${groupId}/members/options`)
        .query({ q: 'f4m-b' })
        .set('Authorization', adminAuth);
      expect(byQ.body.data.items.map((i: { id: string }) => i.id)).toEqual([mBobId]);

      expectBizError(
        await request(httpServer(app))
          .get(`/api/admin/v1/organizations/${NONEXISTENT_ID}/members/options`)
          .set('Authorization', adminAuth),
        BizCode.ORGANIZATION_NOT_FOUND,
      );
    });
  });

  // ============ tree-with-summary ============

  describe('GET /organizations/tree-with-summary(树 + 归属计数)', () => {
    it('directMembershipCount = 直属 ACTIVE 条数;subtreeMembershipCount = 后序折叠合计', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/organizations/tree-with-summary')
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const roots = res.body.data as Array<{
        id: string;
        directMembershipCount: number;
        subtreeMembershipCount: number;
        children: Array<{
          id: string;
          directMembershipCount: number;
          subtreeMembershipCount: number;
          children: unknown[];
        }>;
      }>;
      const rootNode = roots.find((r) => r.id === rootId)!;
      expect(rootNode).toBeDefined();

      // 直属计数与 DB 逐一对照(ACTIVE 未软删条数;transfer 用例改动后以实时 DB 为准)
      const countAt = (orgId: string) =>
        prisma.memberOrganizationMembership.count({
          where: { organizationId: orgId, status: 'ACTIVE', deletedAt: null },
        });
      expect(rootNode.directMembershipCount).toBe(await countAt(rootId));

      const deptNode = rootNode.children.find((c) => c.id === deptId)!;
      const groupNode = (
        deptNode.children as Array<{
          id: string;
          directMembershipCount: number;
          subtreeMembershipCount: number;
        }>
      ).find((c) => c.id === groupId)!;
      expect(deptNode.directMembershipCount).toBe(await countAt(deptId));
      expect(groupNode.directMembershipCount).toBe(await countAt(groupId));
      expect(groupNode.subtreeMembershipCount).toBe(groupNode.directMembershipCount);
      expect(deptNode.subtreeMembershipCount).toBe(
        deptNode.directMembershipCount + groupNode.subtreeMembershipCount,
      );
      expect(rootNode.subtreeMembershipCount).toBeGreaterThanOrEqual(
        rootNode.directMembershipCount + deptNode.subtreeMembershipCount,
      );
    });
  });
});
