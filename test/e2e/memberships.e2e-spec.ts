import type { INestApplication } from '@nestjs/common';
import { MemberStatus, OrganizationStatus, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 终态 scoped-authz PR2(2026-07-01;冻结稿 §3.1 / §7.1):memberships 组织归属管理面 e2e。
// 覆盖 4 端点(GET list / POST 新增 / PATCH :id 改类型任期 / DELETE :id 结束)主成功 + 关键失败:
//   - 权限边界(R 模式 rbac.can;USER / ADMIN 默认无 ops-admin → 30100;沿 PR1 org.move.node 范式用 SUPER_ADMIN 跑功能)
//   - PRIMARY 唯一(第二条 active PRIMARY → MEMBERSHIP_ALREADY_EXISTS)
//   - SECONDARY / TEMPORARY / SUPPORT 可并存多条
//   - 同 (member, org, type) 重复 active → MEMBERSHIP_ALREADY_EXISTS
//   - end(status=ENDED + 保留留痕;结束后可再建 PRIMARY;已结束再 end → NOT_FOUND)
//   - member / organization NOT_FOUND / INACTIVE 校验(沿 member-departments set 语义)
// membership.* 绑 ops-admin 由 seed-rbac.e2e-spec 对账;本 spec 功能路径走 SUPER_ADMIN 短路(沿 PR1)。

describe('memberships 组织归属 CRUD', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let superAdminAuth: string;
  let adminDefaultAuth: string;
  let userAuth: string;

  let nodeTypeCode: string;
  let activeOrgIdA: string;
  let activeOrgIdB: string;
  let activeOrgIdC: string;
  let inactiveOrgId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    await createTestUser(app, { username: 'ms-su', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'ms-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'ms-user', role: Role.USER });
    superAdminAuth = (await loginAs(app, 'ms-su')).authHeader;
    adminDefaultAuth = (await loginAs(app, 'ms-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'ms-user')).authHeader;

    const nodeType = await prisma.dictType.create({
      data: { code: 'node_type', label: 'Node Type' },
      select: { id: true },
    });
    const item = await prisma.dictItem.create({
      data: { typeId: nodeType.id, code: 'demo-ms-nodetype-1', label: 'NT' },
      select: { code: true },
    });
    nodeTypeCode = item.code;

    const orgA = await prisma.organization.create({
      data: { name: 'demo-ms-orgA', nodeTypeCode },
      select: { id: true },
    });
    activeOrgIdA = orgA.id;
    const orgB = await prisma.organization.create({
      data: { name: 'demo-ms-orgB', nodeTypeCode, parentId: orgA.id },
      select: { id: true },
    });
    activeOrgIdB = orgB.id;
    const orgC = await prisma.organization.create({
      data: { name: 'demo-ms-orgC', nodeTypeCode, parentId: orgA.id },
      select: { id: true },
    });
    activeOrgIdC = orgC.id;
    const orgInactive = await prisma.organization.create({
      data: {
        name: 'demo-ms-orgINACTIVE',
        nodeTypeCode,
        parentId: orgA.id,
        status: OrganizationStatus.INACTIVE,
      },
      select: { id: true },
    });
    inactiveOrgId = orgInactive.id;
  });

  afterAll(async () => {
    await app.close();
  });

  // 便捷:建一个 member 返回 id。
  const newMember = async (memberNo: string, status: MemberStatus = MemberStatus.ACTIVE) => {
    const m = await prisma.member.create({
      data: { memberNo, displayName: memberNo, status },
      select: { id: true },
    });
    return m.id;
  };

  const postMembership = (auth: string, memberId: string, body: object) =>
    request(httpServer(app))
      .post(`/api/admin/v1/members/${memberId}/memberships`)
      .set('Authorization', auth)
      .send(body);

  // ============ 权限边界 ============

  describe('权限边界', () => {
    let memberId: string;
    beforeAll(async () => {
      memberId = await newMember('demo-ms-pb-1');
    });

    it('未登录 GET list → 401', async () => {
      const res = await request(httpServer(app)).get(
        `/api/admin/v1/members/${memberId}/memberships`,
      );
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET list → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/memberships`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('ADMIN 默认无 ops-admin GET list → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/memberships`)
        .set('Authorization', adminDefaultAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER POST → 30100 RBAC_FORBIDDEN', async () => {
      const res = await postMembership(userAuth, memberId, {
        organizationId: activeOrgIdA,
        membershipType: 'PRIMARY',
      });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ POST 新增 + PRIMARY 唯一 + 多类型并存 ============

  describe('POST 新增', () => {
    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await postMembership(superAdminAuth, 'cl0000000000000000000000', {
        organizationId: activeOrgIdA,
        membershipType: 'PRIMARY',
      });
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('organization 不存在 → ORGANIZATION_NOT_FOUND', async () => {
      const memberId = await newMember('demo-ms-post-orgnf');
      const res = await postMembership(superAdminAuth, memberId, {
        organizationId: 'cl0000000000000000000000',
        membershipType: 'PRIMARY',
      });
      expectBizError(res, BizCode.ORGANIZATION_NOT_FOUND);
    });

    it('member INACTIVE → MEMBER_INACTIVE', async () => {
      const memberId = await newMember('demo-ms-post-mi', MemberStatus.INACTIVE);
      const res = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdA,
        membershipType: 'PRIMARY',
      });
      expectBizError(res, BizCode.MEMBER_INACTIVE);
    });

    it('organization INACTIVE → ORGANIZATION_INACTIVE', async () => {
      const memberId = await newMember('demo-ms-post-oi');
      const res = await postMembership(superAdminAuth, memberId, {
        organizationId: inactiveOrgId,
        membershipType: 'PRIMARY',
      });
      expectBizError(res, BizCode.ORGANIZATION_INACTIVE);
    });

    it('首个 PRIMARY → 201 + data(status=ACTIVE, createdByUserId 记录)', async () => {
      const memberId = await newMember('demo-ms-post-primary');
      const res = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdA,
        membershipType: 'PRIMARY',
        reason: '首次编入',
      });
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.memberId).toBe(memberId);
      expect(res.body.data.organizationId).toBe(activeOrgIdA);
      expect(res.body.data.membershipType).toBe('PRIMARY');
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.reason).toBe('首次编入');
      expect(res.body.data.endedAt).toBeNull();
      expect(res.body.data.createdByUserId).not.toBeNull();
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('第二条 active PRIMARY(不同 org)→ MEMBERSHIP_ALREADY_EXISTS', async () => {
      const memberId = await newMember('demo-ms-post-primary2');
      const first = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdA,
        membershipType: 'PRIMARY',
      });
      expect(first.status).toBe(201);
      const second = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdB,
        membershipType: 'PRIMARY',
      });
      expectBizError(second, BizCode.MEMBERSHIP_ALREADY_EXISTS);
    });

    it('SECONDARY / TEMPORARY / SUPPORT 可与 PRIMARY 并存多条 → 全部 201', async () => {
      const memberId = await newMember('demo-ms-post-multi');
      for (const [type, org] of [
        ['PRIMARY', activeOrgIdA],
        ['SECONDARY', activeOrgIdB],
        ['TEMPORARY', activeOrgIdC],
        ['SUPPORT', activeOrgIdB],
      ] as const) {
        const res = await postMembership(superAdminAuth, memberId, {
          organizationId: org,
          membershipType: type,
        });
        expect(res.status).toBe(201);
        expect(res.body.data.membershipType).toBe(type);
      }
      const activeCount = await prisma.memberOrganizationMembership.count({
        where: { memberId, deletedAt: null, status: 'ACTIVE' },
      });
      expect(activeCount).toBe(4);
    });

    it('同 (member, org, type) 重复 active → MEMBERSHIP_ALREADY_EXISTS', async () => {
      const memberId = await newMember('demo-ms-post-dup');
      const first = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdB,
        membershipType: 'SECONDARY',
      });
      expect(first.status).toBe(201);
      const dup = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdB,
        membershipType: 'SECONDARY',
      });
      expectBizError(dup, BizCode.MEMBERSHIP_ALREADY_EXISTS);
    });
  });

  // ============ GET list ============

  describe('GET list', () => {
    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/members/cl0000000000000000000000/memberships')
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('列全归属(PRIMARY + SECONDARY 并存)→ 200 + 数组;不含 deletedAt', async () => {
      const memberId = await newMember('demo-ms-list-1');
      await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdA,
        membershipType: 'PRIMARY',
      });
      await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdB,
        membershipType: 'SECONDARY',
      });
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/memberships`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(0);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(2);
      const types = res.body.data.map((r: { membershipType: string }) => r.membershipType).sort();
      expect(types).toEqual(['PRIMARY', 'SECONDARY']);
      expect(res.body.data[0]).not.toHaveProperty('deletedAt');
    });

    it('member 无任何归属 → 200 + 空数组', async () => {
      const memberId = await newMember('demo-ms-list-empty');
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/memberships`)
        .set('Authorization', superAdminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // ============ PATCH :id 改类型 / 任期 / 原因 ============

  describe('PATCH :id', () => {
    it('归属 id 不存在 → MEMBERSHIP_NOT_FOUND', async () => {
      const memberId = await newMember('demo-ms-patch-nf');
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/memberships/cl0000000000000000000000`)
        .set('Authorization', superAdminAuth)
        .send({ reason: 'x' });
      expectBizError(res, BizCode.MEMBERSHIP_NOT_FOUND);
    });

    it('改类型 / 原因 → 200 + 更新生效', async () => {
      const memberId = await newMember('demo-ms-patch-ok');
      const created = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdB,
        membershipType: 'SECONDARY',
      });
      const id = created.body.data.id as string;
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/memberships/${id}`)
        .set('Authorization', superAdminAuth)
        .send({ membershipType: 'TEMPORARY', reason: '调整' });
      expect(res.status).toBe(200);
      expect(res.body.data.membershipType).toBe('TEMPORARY');
      expect(res.body.data.reason).toBe('调整');
      expect(res.body.data.endedAt).toBeNull();
    });

    it('ACTIVE PATCH future startedAt 或任意 endedAt → BAD_REQUEST，且原行不变', async () => {
      const memberId = await newMember('demo-ms-patch-term-invalid');
      const created = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdB,
        membershipType: 'SECONDARY',
      });
      const id = created.body.data.id as string;
      for (const body of [
        { startedAt: '2999-01-01T00:00:00.000Z' },
        { endedAt: '2999-01-02T00:00:00.000Z' },
      ]) {
        const res = await request(httpServer(app))
          .patch(`/api/admin/v1/members/${memberId}/memberships/${id}`)
          .set('Authorization', superAdminAuth)
          .send(body);
        expectBizError(res, BizCode.BAD_REQUEST);
      }
      const row = await prisma.memberOrganizationMembership.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('ACTIVE');
      expect(row.endedAt).toBeNull();
      expect(row.startedAt.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('真并发创建同一 PRIMARY → 恰一 201，败者 HTTP/BizCode=17004', async () => {
      const memberId = await newMember('demo-ms-concurrent-create');
      const responses = await Promise.all([
        postMembership(superAdminAuth, memberId, {
          organizationId: activeOrgIdA,
          membershipType: 'PRIMARY',
        }),
        postMembership(superAdminAuth, memberId, {
          organizationId: activeOrgIdB,
          membershipType: 'PRIMARY',
        }),
      ]);
      expect(responses.filter((res) => res.status === 201)).toHaveLength(1);
      const rejected = responses.find((res) => res.status !== 201);
      expect(rejected).toBeDefined();
      expectBizError(rejected!, BizCode.MEMBERSHIP_ALREADY_EXISTS);
      expect(
        await prisma.memberOrganizationMembership.count({
          where: { memberId, status: 'ACTIVE', deletedAt: null },
        }),
      ).toBe(1);
    });

    it('改类型撞 PRIMARY 唯一 → MEMBERSHIP_ALREADY_EXISTS', async () => {
      const memberId = await newMember('demo-ms-patch-uq');
      // 已有一条 active PRIMARY
      await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdA,
        membershipType: 'PRIMARY',
      });
      // 再建一条 SECONDARY,尝试把它改成 PRIMARY → 撞 primary_active_unique
      const sec = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdB,
        membershipType: 'SECONDARY',
      });
      const res = await request(httpServer(app))
        .patch(`/api/admin/v1/members/${memberId}/memberships/${sec.body.data.id}`)
        .set('Authorization', superAdminAuth)
        .send({ membershipType: 'PRIMARY' });
      expectBizError(res, BizCode.MEMBERSHIP_ALREADY_EXISTS);
    });
  });

  // ============ DELETE :id 结束归属 ============

  describe('DELETE :id (end)', () => {
    it('归属 id 不存在 → MEMBERSHIP_NOT_FOUND', async () => {
      const memberId = await newMember('demo-ms-del-nf');
      const res = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberId}/memberships/cl0000000000000000000000`)
        .set('Authorization', superAdminAuth);
      expectBizError(res, BizCode.MEMBERSHIP_NOT_FOUND);
    });

    it('结束 active PRIMARY → 200 + status=ENDED + endedAt;之后可再建 PRIMARY;结束行仍在 list', async () => {
      const memberId = await newMember('demo-ms-del-ok');
      const created = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdA,
        membershipType: 'PRIMARY',
      });
      const id = created.body.data.id as string;

      const delRes = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberId}/memberships/${id}`)
        .set('Authorization', superAdminAuth);
      expect(delRes.status).toBe(200);
      expect(delRes.body.data.id).toBe(id);
      expect(delRes.body.data.status).toBe('ENDED');
      expect(delRes.body.data.endedAt).not.toBeNull();
      expect(delRes.body.data.endedByUserId).not.toBeNull();

      // 结束后主归属已释放 → 可再建新 PRIMARY
      const again = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdB,
        membershipType: 'PRIMARY',
      });
      expect(again.status).toBe(201);

      // 结束行保留留痕 → list 仍含 ENDED 行(共 2 条:1 ENDED + 1 新 ACTIVE)
      const list = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/memberships`)
        .set('Authorization', superAdminAuth);
      expect(list.body.data).toHaveLength(2);
    });

    it('结束已结束的归属 → MEMBERSHIP_NOT_FOUND(仅 active 可结束)', async () => {
      const memberId = await newMember('demo-ms-del-twice');
      const created = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdA,
        membershipType: 'PRIMARY',
      });
      const id = created.body.data.id as string;
      const first = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberId}/memberships/${id}`)
        .set('Authorization', superAdminAuth);
      expect(first.status).toBe(200);
      const second = await request(httpServer(app))
        .delete(`/api/admin/v1/members/${memberId}/memberships/${id}`)
        .set('Authorization', superAdminAuth);
      expectBizError(second, BizCode.MEMBERSHIP_NOT_FOUND);
    });

    it('真并发结束同一 ACTIVE → 恰一 200，败者 HTTP/BizCode=17003，槽位可立即重建', async () => {
      const memberId = await newMember('demo-ms-concurrent-end');
      const created = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdA,
        membershipType: 'PRIMARY',
      });
      const id = created.body.data.id as string;
      const responses = await Promise.all([
        request(httpServer(app))
          .delete(`/api/admin/v1/members/${memberId}/memberships/${id}`)
          .set('Authorization', superAdminAuth),
        request(httpServer(app))
          .delete(`/api/admin/v1/members/${memberId}/memberships/${id}`)
          .set('Authorization', superAdminAuth),
      ]);
      expect(responses.filter((res) => res.status === 200)).toHaveLength(1);
      const rejected = responses.find((res) => res.status !== 200);
      expect(rejected).toBeDefined();
      expectBizError(rejected!, BizCode.MEMBERSHIP_NOT_FOUND);
      const replacement = await postMembership(superAdminAuth, memberId, {
        organizationId: activeOrgIdB,
        membershipType: 'PRIMARY',
      });
      expect(replacement.status).toBe(201);
    });
  });
});
