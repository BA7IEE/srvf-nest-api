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

// 终态 scoped-authz PR4「任职」e2e(2026-07-01;冻结稿 §3.4 / §7.3 / §4.3 / R2 + goal DoD §7)。
// 覆盖:RBAC 边界 / 双轴 CRUD / 任命成功 + isConcurrent 回填 / 四类校验各自拒 + 任期 + 防重 + 存在性 /
//   撤销后不再 active + 历史可查 / 副队长甲兼任并存。
//
// RBAC:本仓 rbac.fixture 的 RBAC_PERMISSIONS 未含 position-assignment.*(且 membership/position 同样未含,
// 沿 PR2/PR3 只走 seed+contract 未写 CRUD e2e 的惯例);为不改共享 fixture(其 count 被 rbac 元 e2e 依赖),
// 本 spec 在 beforeAll 内联 seed 4 码 + 绑 ops-admin,再 grant 给 pa-adm(判权走 service 层 rbac.can,0 @Roles)。

const PA_CODES = [
  'position-assignment.read.record',
  'position-assignment.create.record',
  'position-assignment.revoke.record',
  'position-assignment.read.history',
] as const;

async function seedPositionAssignmentCodesAndBind(
  prisma: PrismaService,
  opsAdminRoleId: string,
): Promise<void> {
  for (const code of PA_CODES) {
    const [module, action, resourceType] = code.split('.');
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, module, action, resourceType },
    });
  }
  const perms = await prisma.permission.findMany({
    where: { code: { in: [...PA_CODES] } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: opsAdminRoleId, permissionId: p.id })),
    skipDuplicates: true,
  });
}

describe('position-assignments 任职双轴管理', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string;
  let adminDefaultAuth: string;
  let userAuth: string;

  // 配置面基线(beforeAll 建一次,只读复用)。
  let posTeamLeaderId: string; // allowMultiple=false, allowConcurrent=true
  let posViceId: string; // allowMultiple=true,  allowConcurrent=true
  let posGroupLeaderId: string; // allowMultiple=true,  allowConcurrent=true(group;requireMembership=true)
  let posSoloId: string; // allowMultiple=true,  allowConcurrent=false
  let orgTeamId: string; // rescue-team
  let orgTeam2Id: string; // rescue-team
  let orgGrpId: string; // group,parent=orgTeam

  let memberSeq = 0;
  async function newMember(tag: string): Promise<string> {
    memberSeq += 1;
    const m = await prisma.member.create({
      data: { memberNo: `pa-e2e-${tag}-${memberSeq}`, displayName: `PA-${tag}-${memberSeq}` },
      select: { id: true },
    });
    return m.id;
  }

  const startedAt = '2026-07-01T00:00:00.000Z';

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const admin = await createTestUser(app, { username: 'pa-adm', role: Role.ADMIN });
    await createTestUser(app, { username: 'pa-adm-default', role: Role.ADMIN });
    await createTestUser(app, { username: 'pa-user', role: Role.USER });
    adminAuth = (await loginAs(app, 'pa-adm')).authHeader;
    adminDefaultAuth = (await loginAs(app, 'pa-adm-default')).authHeader;
    userAuth = (await loginAs(app, 'pa-user')).authHeader;

    const seed = await seedRbacPermissionsAndOpsAdmin(app);
    await seedPositionAssignmentCodesAndBind(prisma, seed.opsAdminRoleId);
    await grantOpsAdminToUser(app, admin.id, seed.opsAdminRoleId);

    // 职务定义
    const [teamLeader, vice, groupLeader, solo] = await Promise.all([
      prisma.organizationPosition.create({
        data: {
          code: 'pa-e2e-team-leader',
          name: '队长',
          categoryCode: 'LEADER',
          allowMultiple: false,
          allowConcurrent: true,
        },
        select: { id: true },
      }),
      prisma.organizationPosition.create({
        data: {
          code: 'pa-e2e-vice',
          name: '副队长',
          categoryCode: 'DEPUTY',
          allowMultiple: true,
          allowConcurrent: true,
        },
        select: { id: true },
      }),
      prisma.organizationPosition.create({
        data: {
          code: 'pa-e2e-group-leader',
          name: '组长',
          categoryCode: 'LEADER',
          allowMultiple: true,
          allowConcurrent: true,
        },
        select: { id: true },
      }),
      prisma.organizationPosition.create({
        data: {
          code: 'pa-e2e-solo',
          name: '独任',
          categoryCode: 'STAFF',
          allowMultiple: true,
          allowConcurrent: false,
        },
        select: { id: true },
      }),
    ]);
    posTeamLeaderId = teamLeader.id;
    posViceId = vice.id;
    posGroupLeaderId = groupLeader.id;
    posSoloId = solo.id;

    // 组织树:orgTeam(rescue-team)/ orgTeam2(rescue-team)/ orgGrp(group,parent=orgTeam)
    const team = await prisma.organization.create({
      data: { name: 'pa-e2e-team', nodeTypeCode: 'rescue-team' },
      select: { id: true },
    });
    orgTeamId = team.id;
    const team2 = await prisma.organization.create({
      data: { name: 'pa-e2e-team2', nodeTypeCode: 'rescue-team' },
      select: { id: true },
    });
    orgTeam2Id = team2.id;
    const grp = await prisma.organization.create({
      data: { name: 'pa-e2e-grp', nodeTypeCode: 'group', parentId: orgTeamId },
      select: { id: true },
    });
    orgGrpId = grp.id;

    // closure(手写,镜像 org service/migration 维护:depth-0 自身 + orgTeam→orgGrp 边)。
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: orgTeamId, descendantId: orgTeamId, depth: 0 },
        { ancestorId: orgTeam2Id, descendantId: orgTeam2Id, depth: 0 },
        { ancestorId: orgGrpId, descendantId: orgGrpId, depth: 0 },
        { ancestorId: orgTeamId, descendantId: orgGrpId, depth: 1 },
      ],
    });

    // 职务规则:rescue-team 允许 team-leader / vice / solo(requireMembership=false);
    //           group 允许 group-leader(requireMembership=true)。
    await prisma.organizationPositionRule.createMany({
      data: [
        { nodeTypeCode: 'rescue-team', positionId: posTeamLeaderId, requireMembership: false },
        { nodeTypeCode: 'rescue-team', positionId: posViceId, requireMembership: false },
        { nodeTypeCode: 'rescue-team', positionId: posSoloId, requireMembership: false },
        { nodeTypeCode: 'group', positionId: posGroupLeaderId, requireMembership: true },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  function appoint(auth: string, orgId: string, body: Record<string, unknown>) {
    return request(httpServer(app))
      .post(`/api/admin/v1/organizations/${orgId}/position-assignments`)
      .set('Authorization', auth)
      .send(body);
  }

  // ============ RBAC 权限边界 ============

  describe('RBAC 权限边界', () => {
    it('未登录 GET 组织轴 → 401', async () => {
      const res = await request(httpServer(app)).get(
        `/api/admin/v1/organizations/${orgTeamId}/position-assignments`,
      );
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER GET 组织轴 → 30100', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${orgTeamId}/position-assignments`)
        .set('Authorization', userAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER POST 任命 → 30100', async () => {
      const res = await appoint(userAuth, orgTeamId, {
        positionId: posViceId,
        memberId: await newMember('rbac'),
        startedAt,
      });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('ADMIN 默认无 ops-admin → 30100', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${orgTeamId}/position-assignments`)
        .set('Authorization', adminDefaultAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  // ============ 任命成功 + 双轴列表 + isConcurrent 回填 ============

  describe('任命成功 + 双轴列表', () => {
    it('任命成功 → 201 + status=ACTIVE + appointedByUserId + isConcurrent 默认 false', async () => {
      const memberId = await newMember('ok');
      const res = await appoint(adminAuth, orgTeamId, {
        positionId: posViceId,
        memberId,
        startedAt,
      });
      expect(res.status).toBe(201);
      expect(res.body.code).toBe(0);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.organizationId).toBe(orgTeamId);
      expect(res.body.data.positionId).toBe(posViceId);
      expect(res.body.data.memberId).toBe(memberId);
      expect(res.body.data.appointedByUserId).toBeTruthy();
      expect(res.body.data.isConcurrent).toBe(false);
      expect(res.body.data).not.toHaveProperty('deletedAt');
    });

    it('组织轴列表含在任 + 队员轴列表含该任职', async () => {
      const memberId = await newMember('axis');
      const created = await appoint(adminAuth, orgTeamId, {
        positionId: posViceId,
        memberId,
        startedAt,
      });
      const paId = created.body.data.id as string;

      const orgList = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${orgTeamId}/position-assignments`)
        .set('Authorization', adminAuth);
      expect(orgList.status).toBe(200);
      expect((orgList.body.data as Array<{ id: string }>).some((a) => a.id === paId)).toBe(true);

      const memberList = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/position-assignments`)
        .set('Authorization', adminAuth);
      expect(memberList.status).toBe(200);
      expect((memberList.body.data as Array<{ id: string }>).map((a) => a.id)).toEqual([paId]);
    });

    it('isConcurrent=true 回填', async () => {
      const memberId = await newMember('conc');
      const res = await appoint(adminAuth, orgTeamId, {
        positionId: posViceId,
        memberId,
        startedAt,
        isConcurrent: true,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.isConcurrent).toBe(true);
    });
  });

  // ============ 任命校验(四类各自拒 + 任期 + 防重 + 存在性)============

  describe('任命校验', () => {
    it('任期非法:endedAt ≤ startedAt → TENURE_INVALID', async () => {
      const res = await appoint(adminAuth, orgTeamId, {
        positionId: posViceId,
        memberId: await newMember('tenure'),
        startedAt,
        endedAt: startedAt,
      });
      expectBizError(res, BizCode.POSITION_ASSIGNMENT_TENURE_INVALID);
    });

    it('职务适配:该 org 类别无对应 active 规则 → RULE_NOT_MATCHED', async () => {
      // group-leader 无 rescue-team 规则(仅 group 有)
      const res = await appoint(adminAuth, orgTeamId, {
        positionId: posGroupLeaderId,
        memberId: await newMember('rule'),
        startedAt,
      });
      expectBizError(res, BizCode.POSITION_ASSIGNMENT_RULE_NOT_MATCHED);
    });

    it('requireMembership:group-leader@组 且无本组织/祖先 active 归属 → MEMBERSHIP_REQUIRED', async () => {
      const res = await appoint(adminAuth, orgGrpId, {
        positionId: posGroupLeaderId,
        memberId: await newMember('nomem'),
        startedAt,
      });
      expectBizError(res, BizCode.POSITION_ASSIGNMENT_MEMBERSHIP_REQUIRED);
    });

    it('requireMembership 祖先命中:归属在父队(orgTeam)→ 任命 group-leader@子组 成功', async () => {
      const memberId = await newMember('anc');
      // 在祖先 orgTeam 建 active PRIMARY 归属
      await prisma.memberOrganizationMembership.create({
        data: { memberId, organizationId: orgTeamId },
      });
      const res = await appoint(adminAuth, orgGrpId, {
        positionId: posGroupLeaderId,
        memberId,
        startedAt,
      });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('ACTIVE');
    });

    it('兼任:allowConcurrent=false 且已有其它 active 任职 → CONCURRENT_FORBIDDEN', async () => {
      const memberId = await newMember('conc-forbid');
      // 先给一条 active(vice allowConcurrent=true,不触发)
      const first = await appoint(adminAuth, orgTeamId, {
        positionId: posViceId,
        memberId,
        startedAt,
      });
      expect(first.status).toBe(201);
      // 再任 solo(allowConcurrent=false)→ 因已有 active 任职被拒
      const res = await appoint(adminAuth, orgTeamId, {
        positionId: posSoloId,
        memberId,
        startedAt,
      });
      expectBizError(res, BizCode.POSITION_ASSIGNMENT_CONCURRENT_FORBIDDEN);
    });

    it('单人独占:allowMultiple=false 且已有在任者(他人)→ SINGLE_HOLDER', async () => {
      const holder = await newMember('single-holder');
      const other = await newMember('single-other');
      const first = await appoint(adminAuth, orgTeam2Id, {
        positionId: posTeamLeaderId,
        memberId: holder,
        startedAt,
      });
      expect(first.status).toBe(201);
      const res = await appoint(adminAuth, orgTeam2Id, {
        positionId: posTeamLeaderId,
        memberId: other,
        startedAt,
      });
      expectBizError(res, BizCode.POSITION_ASSIGNMENT_SINGLE_HOLDER);
    });

    it('防重:同人同组织同职务已有 active → ALREADY_EXISTS', async () => {
      const memberId = await newMember('dup');
      const first = await appoint(adminAuth, orgTeamId, {
        positionId: posViceId,
        memberId,
        startedAt,
      });
      expect(first.status).toBe(201);
      const res = await appoint(adminAuth, orgTeamId, {
        positionId: posViceId,
        memberId,
        startedAt,
      });
      expectBizError(res, BizCode.POSITION_ASSIGNMENT_ALREADY_EXISTS);
    });

    it('org 不存在 → ORGANIZATION_NOT_FOUND', async () => {
      const res = await appoint(adminAuth, 'cl0000000000000000000000', {
        positionId: posViceId,
        memberId: await newMember('noorg'),
        startedAt,
      });
      expectBizError(res, BizCode.ORGANIZATION_NOT_FOUND);
    });

    it('position 不存在 → POSITION_NOT_FOUND', async () => {
      const res = await appoint(adminAuth, orgTeamId, {
        positionId: 'cl0000000000000000000000',
        memberId: await newMember('nopos'),
        startedAt,
      });
      expectBizError(res, BizCode.POSITION_NOT_FOUND);
    });

    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await appoint(adminAuth, orgTeamId, {
        positionId: posViceId,
        memberId: 'cl0000000000000000000000',
        startedAt,
      });
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });
  });

  // ============ 撤销 + 历史 ============

  describe('撤销 + 历史', () => {
    it('撤销 active → 201 + REVOKED + revokedByUserId + endedAt;org 轴不再 active,队员轴仍可见', async () => {
      const memberId = await newMember('revoke');
      const created = await appoint(adminAuth, orgTeamId, {
        positionId: posViceId,
        memberId,
        startedAt,
      });
      const paId = created.body.data.id as string;

      const rev = await request(httpServer(app))
        .post(`/api/admin/v1/position-assignments/${paId}/revoke`)
        .set('Authorization', adminAuth);
      expect(rev.status).toBe(201);
      expect(rev.body.data.status).toBe('REVOKED');
      expect(rev.body.data.revokedByUserId).toBeTruthy();
      expect(rev.body.data.endedAt).toBeTruthy();

      // 组织轴(仅 ACTIVE)不再含
      const orgList = await request(httpServer(app))
        .get(`/api/admin/v1/organizations/${orgTeamId}/position-assignments`)
        .set('Authorization', adminAuth);
      expect((orgList.body.data as Array<{ id: string }>).some((a) => a.id === paId)).toBe(false);

      // 队员轴(含历史)仍含,状态 REVOKED
      const memberList = await request(httpServer(app))
        .get(`/api/admin/v1/members/${memberId}/position-assignments`)
        .set('Authorization', adminAuth);
      const found = (memberList.body.data as Array<{ id: string; status: string }>).find(
        (a) => a.id === paId,
      );
      expect(found?.status).toBe('REVOKED');
    });

    it('重复撤销 → ALREADY_ENDED', async () => {
      const memberId = await newMember('re-revoke');
      const created = await appoint(adminAuth, orgTeamId, {
        positionId: posViceId,
        memberId,
        startedAt,
      });
      const paId = created.body.data.id as string;
      await request(httpServer(app))
        .post(`/api/admin/v1/position-assignments/${paId}/revoke`)
        .set('Authorization', adminAuth);
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/position-assignments/${paId}/revoke`)
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.POSITION_ASSIGNMENT_ALREADY_ENDED);
    });

    it('撤销不存在 → NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/position-assignments/cl0000000000000000000000/revoke')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.POSITION_ASSIGNMENT_NOT_FOUND);
    });

    it('历史链:同人-组织-职务 任命→撤销→再任命,history(:firstId) 返 2 条', async () => {
      const memberId = await newMember('hist');
      const first = await appoint(adminAuth, orgTeamId, {
        positionId: posViceId,
        memberId,
        startedAt,
      });
      const firstId = first.body.data.id as string;
      await request(httpServer(app))
        .post(`/api/admin/v1/position-assignments/${firstId}/revoke`)
        .set('Authorization', adminAuth);
      // 撤销后再任命(旧行 REVOKED 不占 active 唯一)
      const second = await appoint(adminAuth, orgTeamId, {
        positionId: posViceId,
        memberId,
        startedAt: '2026-08-01T00:00:00.000Z',
      });
      expect(second.status).toBe(201);

      const hist = await request(httpServer(app))
        .get(`/api/admin/v1/position-assignments/${firstId}/history`)
        .set('Authorization', adminAuth);
      expect(hist.status).toBe(200);
      const rows = hist.body.data as Array<{ id: string; status: string }>;
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.status)).toEqual(['REVOKED', 'ACTIVE']);
    });

    it('历史 :id 不存在 → NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/position-assignments/cl0000000000000000000000/history')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.POSITION_ASSIGNMENT_NOT_FOUND);
    });
  });

  // ============ 副队长甲兼任并存(allowConcurrent) ============

  describe('副队长甲场景:同人两队职务并存', () => {
    it('副队长@team(兼容) + 队长@另一队(isConcurrent=true)两条 active 并存', async () => {
      const zhao = await newMember('zhao');
      // 另建一支独立救援队,避免与「单人独占」用例占用的 orgTeam2 team-leader 冲突(副队长甲兼 SAMT 队长)。
      const orgZhaoTeam = await prisma.organization.create({
        data: { name: 'pa-e2e-zhao-team', nodeTypeCode: 'rescue-team' },
        select: { id: true },
      });
      const a1 = await appoint(adminAuth, orgTeamId, {
        positionId: posViceId,
        memberId: zhao,
        startedAt,
      });
      expect(a1.status).toBe(201);
      const a2 = await appoint(adminAuth, orgZhaoTeam.id, {
        positionId: posTeamLeaderId,
        memberId: zhao,
        startedAt,
        isConcurrent: true,
      });
      expect(a2.status).toBe(201);
      expect(a2.body.data.isConcurrent).toBe(true);

      const memberList = await request(httpServer(app))
        .get(`/api/admin/v1/members/${zhao}/position-assignments`)
        .set('Authorization', adminAuth);
      const active = (memberList.body.data as Array<{ status: string }>).filter(
        (a) => a.status === 'ACTIVE',
      );
      expect(active).toHaveLength(2);
    });
  });
});
