import type { INestApplication } from '@nestjs/common';
import {
  AssignmentStatus,
  BindingScopeType,
  MembershipStatus,
  MembershipType,
  PrincipalType,
  Role,
  SupervisionScopeMode,
  SupervisionStatus,
} from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import {
  grantBizAdminToUser,
  grantLegacyActivityActionsToUser,
} from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { seedParticipationReadState } from '../fixtures/contribution-ledger.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const relativeIso = (yearOffset: number, suffix: string): string =>
  `${new Date().getUTCFullYear() + yearOffset}-${suffix}`;
const pastIso = (suffix: string): string => relativeIso(-1, suffix);
const futureIso = (suffix: string): string => relativeIso(2, suffix);
import { assertTestDatabaseUrl } from '../setup/test-db';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// 真实 seed 的职务投影、显式一审绑定与分管派生覆盖三种 scope 来源。
// 活动/报名仍验证本树允许、树外拒绝及既有资源缺失回退。
// 旧 Sheet 入口退役；新结算审核/详情/版本列表验证组织范围与零越权写入。
// member-axis 仅按当前 PRIMARY 主归属授权，不按历史参与活动所属组织裁剪。
// GLOBAL 全量、空 scope 空集、无码拒绝；新版未知版本统一拒绝以防枚举。

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
  SUPER_ADMIN_USERNAME: 'pr12-psa-su',
};

function runSeed(): void {
  const envForChild: NodeJS.ProcessEnv = { ...process.env, ...SEED_ENV };
  assertTestDatabaseUrl(envForChild.DATABASE_URL);
  execSync('pnpm tsx prisma/seed.ts', {
    env: envForChild,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const PAST_START = new Date('2020-01-01T00:00:00.000Z');

describe('participation 三模块 scoped-authz HTTP 面(PR12:逐面迁移第一批)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // 组织
  let smrtId: string;
  let swrtId: string;
  let groupId: string; // SMRT 下新建 group 节点(group-leader 测试专用)

  // HTTP 身份
  let teamLeaderAuth: string;
  let groupLeaderAuth: string;
  let supervisorAuth: string;
  let bizAdminAuth: string;
  let bizAdminUserId: string;
  let emptyScopeAuth: string;
  let bareUserAuth: string;

  // 目标资源
  let smrtActivityId: string; // update/publish/cancel ALLOW 链(draft)
  let swrtActivityId: string; // update/publish/cancel DENY(draft)
  let smrtActivity2Id: string; // registrations 载体(published,SMRT)
  let swrtActivity2Id: string; // registrations 载体(published,SWRT;他队)
  let groupActivityId: string; // group-leader 无 activity.update 权限的反向输入
  let smrtRegId: string; // pending registration @ smrtActivity2
  let swrtRegId: string; // pending registration @ swrtActivity2
  let smrtSettlement: Awaited<ReturnType<typeof createSubmittedSettlement>>;
  let swrtSettlement: Awaited<ReturnType<typeof createSubmittedSettlement>>;
  let groupSettlement: Awaited<ReturnType<typeof createSubmittedSettlement>>;
  let groupLedgerVersionId: string;
  let groupLedgerRegistrationId: string;
  let outsideLedgerVersionId: string;
  let outsideLedgerActivityId: string;
  let regTargetMemberId: string;
  let attTargetMemberId: string;
  let groupTargetMemberId: string;
  let crossTargetMemberId: string;
  const previousWorkflowGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  async function createPastActivity(organizationId: string, title: string) {
    return prisma.activity.create({
      data: {
        title,
        organizationId,
        activityTypeCode: 'training',
        startAt: new Date(pastIso('06-01T01:00:00.000Z')),
        endAt: new Date(pastIso('06-01T05:00:00.000Z')),
        location: 'PSA native fixture',
        statusCode: 'published',
      },
    });
  }

  // 与原生 HTTP 审核边界套件相同的不可变空人口提交输入。
  // 创建者从一开始就是独立用户，不在审核前改写提交人来绕开人员隔离。
  async function createSubmittedSettlement(organizationId: string) {
    const activity = await createPastActivity(organizationId, `PSA review ${organizationId}`);
    const sealedAt = new Date(pastIso('06-02T00:00:00.000Z'));
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: activity.endAt,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 0,
        populationCountBySession: {},
        contentHash: `psa-seal-${activity.id}`,
        statusCode: 'active',
        sealedByUserId: bizAdminUserId,
        sealedAt,
      },
    });
    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        statusCode: 'pending_first_review',
        currentSubmittedVersion: 1,
      },
    });
    const version = await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: `psa-version-${activity.id}`,
        personCount: 0,
        sessionParticipationCount: 0,
        serviceSegmentCount: 0,
        createdByUserId: bizAdminUserId,
        submittedAt: sealedAt,
        statusCode: 'submitted',
        operationKey: `psa-submit-${activity.id}`,
        requestHash: `psa-submit-hash-${activity.id}`,
      },
    });
    return {
      activityId: activity.id,
      versionId: version.id,
      expectation: {
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: version.contentHash,
      },
    };
  }

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    runSeed();

    prisma = app.get(PrismaService);

    const orgByCode = async (code: string): Promise<string> =>
      (await prisma.organization.findFirstOrThrow({ where: { code }, select: { id: true } })).id;
    smrtId = await orgByCode('SMRT');
    swrtId = await orgByCode('SWRT');

    // ===== 新建 group 节点(SMRT 下)+ closure(自环 + 祖先链,沿 authz-three-source 范式) =====
    const grp = await prisma.organization.create({
      data: { name: 'PR12 测试组', nodeTypeCode: 'group', parentId: smrtId },
      select: { id: true },
    });
    groupId = grp.id;
    const smrtAncestors = await prisma.organizationClosure.findMany({
      where: { descendantId: smrtId },
      select: { ancestorId: true, depth: true },
    });
    await prisma.organizationClosure.create({
      data: { ancestorId: groupId, descendantId: groupId, depth: 0 },
    });
    await prisma.organizationClosure.createMany({
      data: smrtAncestors.map((a) => ({
        ancestorId: a.ancestorId,
        descendantId: groupId,
        depth: a.depth + 1,
      })),
    });

    // ===== HTTP 身份 =====
    const teamLeaderUser = await createTestUser(app, {
      username: 'psa-team-leader',
      role: Role.USER,
    });
    const teamLeaderMember = await prisma.member.create({
      data: { memberNo: 'psa-m-tl', ...memberIdentityData('PSA 队长') },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: teamLeaderUser.id },
      data: { memberId: teamLeaderMember.id },
    });
    teamLeaderAuth = (await loginAs(app, 'psa-team-leader')).authHeader;

    const groupLeaderUser = await createTestUser(app, {
      username: 'psa-group-leader',
      role: Role.USER,
    });
    const groupLeaderMember = await prisma.member.create({
      data: { memberNo: 'psa-m-gl', ...memberIdentityData('PSA 组长') },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: groupLeaderUser.id },
      data: { memberId: groupLeaderMember.id },
    });
    groupLeaderAuth = (await loginAs(app, 'psa-group-leader')).authHeader;

    const supervisorUser = await createTestUser(app, {
      username: 'psa-supervisor',
      role: Role.USER,
    });
    const supervisorMember = await prisma.member.create({
      data: { memberNo: 'psa-m-sup', ...memberIdentityData('PSA 分管副队长') },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: supervisorUser.id },
      data: { memberId: supervisorMember.id },
    });
    supervisorAuth = (await loginAs(app, 'psa-supervisor')).authHeader;

    const bizAdminUser = await createTestUser(app, { username: 'psa-biz-admin', role: Role.ADMIN });
    bizAdminUserId = bizAdminUser.id;
    const bizAdminRoleId = (
      await prisma.rbacRole.findFirstOrThrow({
        where: { code: 'biz-admin', deletedAt: null },
        select: { id: true },
      })
    ).id;
    await grantBizAdminToUser(app, bizAdminUser.id, bizAdminRoleId);
    bizAdminAuth = (await loginAs(app, 'psa-biz-admin')).authHeader;

    const emptyScopeUser = await createTestUser(app, {
      username: 'psa-empty-scope',
      role: Role.USER,
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: emptyScopeUser.id,
        roleId: bizAdminRoleId,
        scopeType: BindingScopeType.SELF,
      },
    });
    emptyScopeAuth = (await loginAs(app, 'psa-empty-scope')).authHeader;

    await createTestUser(app, { username: 'psa-bare-user', role: Role.USER });
    bareUserAuth = (await loginAs(app, 'psa-bare-user')).authHeader;

    // ===== 职务任命(真 seed 职务定义 + policy)=====
    const positionByCode = async (code: string): Promise<string> =>
      (
        await prisma.organizationPosition.findFirstOrThrow({
          where: { code, deletedAt: null },
          select: { id: true },
        })
      ).id;
    const teamLeaderPositionId = await positionByCode('team-leader');
    const groupLeaderPositionId = await positionByCode('group-leader');

    await prisma.organizationPositionAssignment.create({
      data: {
        memberId: teamLeaderMember.id,
        organizationId: smrtId,
        positionId: teamLeaderPositionId,
        status: AssignmentStatus.ACTIVE,
        startedAt: PAST_START,
      },
    });
    await prisma.organizationPositionAssignment.create({
      data: {
        memberId: groupLeaderMember.id,
        organizationId: groupId,
        positionId: groupLeaderPositionId,
        status: AssignmentStatus.ACTIVE,
        startedAt: PAST_START,
      },
    });
    // gate=false 的旧 org-admin 行为仍由显式 test-only scoped grant 承载；
    // 真实 seed 角色保持 PR-11 摘权后的终态。
    await grantLegacyActivityActionsToUser(app, teamLeaderUser.id, {
      scopeType: 'ORGANIZATION_TREE',
      scopeOrgId: smrtId,
    });
    // group-manager 不再天然一审；本 scope 测试改由独立一审角色显式授权。
    const firstReviewerRoleId = (
      await prisma.rbacRole.findFirstOrThrow({
        where: { code: 'attendance-first-reviewer', deletedAt: null },
        select: { id: true },
      })
    ).id;
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: groupLeaderUser.id,
        roleId: firstReviewerRoleId,
        scopeType: BindingScopeType.ORGANIZATION_TREE,
        scopeOrgId: groupId,
        status: 'ACTIVE',
        startedAt: PAST_START,
      },
    });
    await prisma.organizationSupervisionAssignment.create({
      data: {
        supervisorMemberId: supervisorMember.id,
        organizationId: smrtId,
        scopeMode: SupervisionScopeMode.TREE,
        status: SupervisionStatus.ACTIVE,
        startedAt: PAST_START,
      },
    });

    // ===== 目标资源 =====
    const mkActivity = (organizationId: string, statusCode: string) =>
      prisma.activity.create({
        data: {
          title: `PR12 活动 @${organizationId}`,
          activityTypeCode: 'pr12-demo',
          organizationId,
          startAt: new Date(pastIso('06-01T01:00:00.000Z')),
          endAt: new Date(futureIso('06-01T05:00:00.000Z')),
          location: '训练场',
          statusCode,
          isPublicRegistration: true,
        },
        select: { id: true },
      });
    smrtActivityId = (await mkActivity(smrtId, 'draft')).id;
    swrtActivityId = (await mkActivity(swrtId, 'draft')).id;
    smrtActivity2Id = (await mkActivity(smrtId, 'published')).id;
    swrtActivity2Id = (await mkActivity(swrtId, 'published')).id;
    groupActivityId = (await mkActivity(groupId, 'published')).id;

    const mkTargetMember = async (tag: string): Promise<string> =>
      (
        await prisma.member.create({
          data: { memberNo: `psa-t-${tag}`, ...memberIdentityData(`PSA 目标 ${tag}`) },
          select: { id: true },
        })
      ).id;
    regTargetMemberId = await mkTargetMember('reg');
    attTargetMemberId = await mkTargetMember('att');
    groupTargetMemberId = await mkTargetMember('grp');
    crossTargetMemberId = await mkTargetMember('cross');

    await prisma.memberOrganizationMembership.createMany({
      data: [
        {
          memberId: regTargetMemberId,
          organizationId: smrtId,
          membershipType: MembershipType.PRIMARY,
          status: MembershipStatus.ACTIVE,
        },
        {
          memberId: attTargetMemberId,
          organizationId: smrtId,
          membershipType: MembershipType.PRIMARY,
          status: MembershipStatus.ACTIVE,
        },
        {
          memberId: groupTargetMemberId,
          organizationId: groupId,
          membershipType: MembershipType.PRIMARY,
          status: MembershipStatus.ACTIVE,
        },
        {
          memberId: crossTargetMemberId,
          organizationId: swrtId,
          membershipType: MembershipType.PRIMARY,
          status: MembershipStatus.ACTIVE,
        },
      ],
    });

    smrtRegId = (
      await prisma.activityRegistration.create({
        data: { activityId: smrtActivity2Id, memberId: regTargetMemberId, statusCode: 'pending' },
        select: { id: true },
      })
    ).id;
    swrtRegId = (
      await prisma.activityRegistration.create({
        data: {
          activityId: swrtActivity2Id,
          memberId: regTargetMemberId,
          statusCode: 'pending',
        },
        select: { id: true },
      })
    ).id;

    smrtSettlement = await createSubmittedSettlement(smrtId);
    swrtSettlement = await createSubmittedSettlement(swrtId);
    groupSettlement = await createSubmittedSettlement(groupId);

    // 队员主归属在 SMRT，正式参与发生在 SWRT，专门验证 member-axis 不按历史活动裁剪。
    const outsideLedgerActivity = await createPastActivity(swrtId, 'PSA outside ledger');
    outsideLedgerActivityId = outsideLedgerActivity.id;
    await seedParticipationReadState(prisma, {
      activityId: outsideLedgerActivityId,
      actorUserId: bizAdminUserId,
      participants: [
        {
          memberId: attTargetMemberId,
          resultCode: 'present',
          serviceHours: '4',
          creditedPoints: '2',
        },
      ],
    });
    const groupLedgerActivity = await createPastActivity(groupId, 'PSA group ledger');
    await seedParticipationReadState(prisma, {
      activityId: groupLedgerActivity.id,
      actorUserId: bizAdminUserId,
      participants: [
        {
          memberId: groupTargetMemberId,
          resultCode: 'present',
          serviceHours: '4',
          creditedPoints: '1',
        },
      ],
    });
    outsideLedgerVersionId = (
      await prisma.attendanceSettlementVersion.findFirstOrThrow({
        where: { settlementRun: { activityId: outsideLedgerActivityId }, version: 1 },
        select: { id: true },
      })
    ).id;
    groupLedgerVersionId = (
      await prisma.attendanceSettlementVersion.findFirstOrThrow({
        where: { settlementRun: { activityId: groupLedgerActivity.id }, version: 1 },
        select: { id: true },
      })
    ).id;
    groupLedgerRegistrationId = (
      await prisma.activityRegistration.findUniqueOrThrow({
        where: {
          activityId_memberId: {
            activityId: groupLedgerActivity.id,
            memberId: groupTargetMemberId,
          },
        },
        select: { id: true },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (previousWorkflowGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousWorkflowGate;
    }
  });

  // ============ ①team-leader:activity update/publish/cancel(本队 ALLOW / 他队 DENY) ============

  describe('①team-leader@SMRT → org-admin@TREE(SMRT)', () => {
    it('本队(SMRT)活动:update → publish → cancel 全链 ALLOW', async () => {
      const upd = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${smrtActivityId}`)
        .set('Authorization', teamLeaderAuth)
        .send({ title: 'team-leader 改的标题' });
      expect(upd.status).toBe(200);
      expect(upd.body.data.title).toBe('team-leader 改的标题');

      const pub = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${smrtActivityId}/publish`)
        .set('Authorization', teamLeaderAuth)
        .send({ requiresInsuranceConfirmed: true });
      expect(pub.status).toBe(200);
      expect(pub.body.data.statusCode).toBe('published');

      const can = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${smrtActivityId}/cancel`)
        .set('Authorization', teamLeaderAuth)
        .send({ cancelReason: 'PR12 scoped 测试' });
      expect(can.status).toBe(200);
      expect(can.body.data.statusCode).toBe('cancelled');
    });

    it('他队(SWRT)活动:update / publish / cancel 全 DENY 30100(树外,活动状态零变化)', async () => {
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${swrtActivityId}`)
          .set('Authorization', teamLeaderAuth)
          .send({ title: 'x' }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${swrtActivityId}/publish`)
          .set('Authorization', teamLeaderAuth)
          .send({ requiresInsuranceConfirmed: true }),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${swrtActivityId}/cancel`)
          .set('Authorization', teamLeaderAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
      const stillDraft = await prisma.activity.findUniqueOrThrow({
        where: { id: swrtActivityId },
        select: { statusCode: true },
      });
      expect(stillDraft.statusCode).toBe('draft');
    });

    it('本队活动嵌套 registrations 列表 + approve ALLOW,他队 DENY 30100', async () => {
      const listOwn = await request(httpServer(app))
        .get(`/api/admin/v1/activities/${smrtActivity2Id}/registrations`)
        .set('Authorization', teamLeaderAuth);
      expect(listOwn.status).toBe(200);
      expect(listOwn.body.data.items.map((r: { id: string }) => r.id)).toContain(smrtRegId);

      const approveOwn = await request(httpServer(app))
        .patch(`/api/admin/v1/activities/${smrtActivity2Id}/registrations/${smrtRegId}/approve`)
        .set('Authorization', teamLeaderAuth)
        .send({});
      expect(approveOwn.status).toBe(200);
      expect(approveOwn.body.data.statusCode).toBe('pass');

      expectBizError(
        await request(httpServer(app))
          .get(`/api/admin/v1/activities/${swrtActivity2Id}/registrations`)
          .set('Authorization', teamLeaderAuth),
        BizCode.RBAC_FORBIDDEN,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${swrtActivity2Id}/registrations/${swrtRegId}/approve`)
          .set('Authorization', teamLeaderAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
    });

    it('旧建单入口退役；新版一审本树 ALLOW、树外 DENY 且零写', async () => {
      for (const activityId of [smrtActivity2Id, swrtActivity2Id]) {
        await request(httpServer(app))
          .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
          .set('Authorization', teamLeaderAuth)
          .send({})
          .expect(404);
      }

      const approveOwn = await request(httpServer(app))
        .post(`/api/admin/v1/attendance-settlements/${smrtSettlement.versionId}/first-approve`)
        .set('Authorization', teamLeaderAuth)
        .send({ operationKey: 'psa-team-first', ...smrtSettlement.expectation });
      expect(approveOwn.status).toBe(200);
      expect(approveOwn.body.data).toMatchObject({
        stageCode: 'first',
        actionCode: 'approve',
        runStatusAfter: 'pending_final_review',
      });
      await expect(
        prisma.attendanceSettlementRun.findUniqueOrThrow({
          where: { activityId: smrtSettlement.activityId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'pending_final_review' });

      const before = await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { activityId: swrtSettlement.activityId },
      });
      expectBizError(
        await request(httpServer(app))
          .post(`/api/admin/v1/attendance-settlements/${swrtSettlement.versionId}/first-approve`)
          .set('Authorization', teamLeaderAuth)
          .send({ operationKey: 'psa-outside-first', ...swrtSettlement.expectation }),
        BizCode.RBAC_FORBIDDEN,
      );
      await expect(
        prisma.attendanceSettlementRun.findUniqueOrThrow({
          where: { activityId: swrtSettlement.activityId },
        }),
      ).resolves.toEqual(before);
      expect(
        await prisma.settlementReviewAction.count({
          where: { settlementVersionId: swrtSettlement.versionId },
        }),
      ).toBe(0);
    });
  });

  // ============ ②group-leader:本组结算一审 ALLOW;activity.update DENY(角色无码) ============

  describe('②group-leader@SMRT 子组 → group-manager@TREE(子组)', () => {
    it('本组原生结算一级审核 → ALLOW', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/attendance-settlements/${groupSettlement.versionId}/first-approve`)
        .set('Authorization', groupLeaderAuth)
        .send({ operationKey: 'psa-group-first', ...groupSettlement.expectation });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        stageCode: 'first',
        actionCode: 'approve',
        runStatusAfter: 'pending_final_review',
      });
      await expect(
        prisma.attendanceSettlementRun.findUniqueOrThrow({
          where: { activityId: groupSettlement.activityId },
          select: { statusCode: true },
        }),
      ).resolves.toEqual({ statusCode: 'pending_final_review' });
    });

    it('activity.update → DENY 30100(group-manager 角色不含 activity 写码,no_permission)', async () => {
      expectBizError(
        await request(httpServer(app))
          .patch(`/api/admin/v1/activities/${groupActivityId}`)
          .set('Authorization', groupLeaderAuth)
          .send({ title: 'x' }),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  // ============ ③org-supervisor:分管树内结算详情 ALLOW;树外 DENY ============

  describe('③org-supervisor(SupervisionAssignment@SMRT,TREE)', () => {
    it('分管树内(SMRT)结算版本详情 → ALLOW', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-settlements/${smrtSettlement.versionId}/review-detail`)
        .set('Authorization', supervisorAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.version.id).toBe(smrtSettlement.versionId);
    });

    it('分管树外(SWRT)结算版本详情 → DENY 30100', async () => {
      expectBizError(
        await request(httpServer(app))
          .get(`/api/admin/v1/attendance-settlements/${swrtSettlement.versionId}/review-detail`)
          .set('Authorization', supervisorAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  // ============ ④v0.49 扁平列表 + member-axis 部门数据范围 ============

  describe('④v0.49 部门数据范围全面接线(participation 五入口)', () => {
    const idsOf = (res: request.Response): string[] =>
      res.body.data.items.map((item: { id: string }) => item.id);
    const versionIdsOf = (res: request.Response): string[] =>
      (res.body.data.items as Array<{ settlementVersionId: string }>).map(
        (item) => item.settlementVersionId,
      );

    it('team-leader@SMRT:报名/结算仅返本树；报名组织筛选与授权范围取交集', async () => {
      const registrations = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ pageSize: 100 })
        .set('Authorization', teamLeaderAuth);
      expect(registrations.status).toBe(200);
      expect(idsOf(registrations)).toContain(smrtRegId);
      expect(idsOf(registrations)).not.toContain(swrtRegId);

      const crossRegistrations = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ organizationId: swrtId })
        .set('Authorization', teamLeaderAuth);
      expect(crossRegistrations.status).toBe(200);
      expect(crossRegistrations.body.data).toMatchObject({ items: [], total: 0 });

      const settlements = await request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements')
        .query({ pageSize: 100 })
        .set('Authorization', teamLeaderAuth);
      expect(settlements.status).toBe(200);
      expect(versionIdsOf(settlements).sort()).toEqual(
        [smrtSettlement.versionId, groupSettlement.versionId, groupLedgerVersionId].sort(),
      );
      expect(settlements.body.data.total).toBe(3);

      // 结算版本列表没有组织筛选参数，不能把旧 Sheet 的查询能力映射过去。
      // 仍支持这些参数的报名面继续锁定精确组织/后代范围及交集行为。
      const exactSmrtRegistrations = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ organizationId: smrtId, pageSize: 100 })
        .set('Authorization', teamLeaderAuth);
      expect(exactSmrtRegistrations.status).toBe(200);
      expect(idsOf(exactSmrtRegistrations)).toContain(smrtRegId);
      expect(idsOf(exactSmrtRegistrations)).not.toContain(groupLedgerRegistrationId);
      expect(idsOf(exactSmrtRegistrations)).not.toContain(swrtRegId);

      const smrtTreeRegistrations = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ organizationId: smrtId, includeDescendants: true, pageSize: 100 })
        .set('Authorization', teamLeaderAuth);
      expect(smrtTreeRegistrations.status).toBe(200);
      expect(idsOf(smrtTreeRegistrations)).toEqual(
        expect.arrayContaining([smrtRegId, groupLedgerRegistrationId]),
      );
      expect(idsOf(smrtTreeRegistrations)).not.toContain(swrtRegId);
    });

    it('分管/组长/GLOBAL/空 scope/no-permission 扁平矩阵', async () => {
      const supervised = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ pageSize: 100 })
        .set('Authorization', supervisorAuth);
      expect(supervised.status).toBe(200);
      expect(idsOf(supervised)).toContain(smrtRegId);
      expect(idsOf(supervised)).not.toContain(swrtRegId);

      const groupSettlements = await request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements')
        .query({ pageSize: 100 })
        .set('Authorization', groupLeaderAuth);
      expect(groupSettlements.status).toBe(200);
      expect(versionIdsOf(groupSettlements).sort()).toEqual(
        [groupSettlement.versionId, groupLedgerVersionId].sort(),
      );
      expect(groupSettlements.body.data.total).toBe(2);

      const globalRegistrations = await request(httpServer(app))
        .get('/api/admin/v1/registrations')
        .query({ pageSize: 100 })
        .set('Authorization', bizAdminAuth);
      expect(idsOf(globalRegistrations)).toEqual(expect.arrayContaining([smrtRegId, swrtRegId]));

      const globalSettlements = await request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements')
        .set('Authorization', bizAdminAuth);
      expect(globalSettlements.status).toBe(200);
      expect(versionIdsOf(globalSettlements).sort()).toEqual(
        [
          smrtSettlement.versionId,
          groupSettlement.versionId,
          swrtSettlement.versionId,
          groupLedgerVersionId,
          outsideLedgerVersionId,
        ].sort(),
      );
      expect(globalSettlements.body.data.total).toBe(5);

      for (const path of ['/api/admin/v1/registrations', '/api/admin/v1/attendance-settlements']) {
        const empty = await request(httpServer(app)).get(path).set('Authorization', emptyScopeAuth);
        expect(empty.status).toBe(200);
        expect(empty.body.data).toMatchObject({ items: [], total: 0 });

        expectBizError(
          await request(httpServer(app)).get(path).set('Authorization', bareUserAuth),
          BizCode.RBAC_FORBIDDEN,
        );
      }
    });

    it('member-axis 按 active PRIMARY 主归属点授权,不按历史活动所属组织裁剪', async () => {
      const registrations = await request(httpServer(app))
        .get(`/api/admin/v1/members/${regTargetMemberId}/registrations`)
        .query({ pageSize: 100 })
        .set('Authorization', teamLeaderAuth);
      expect(registrations.status).toBe(200);
      expect(idsOf(registrations)).toEqual(expect.arrayContaining([smrtRegId, swrtRegId]));

      const ledger = await request(httpServer(app))
        .get(`/api/admin/v1/members/${attTargetMemberId}/participation-ledger`)
        .query({ pageSize: 100 })
        .set('Authorization', teamLeaderAuth);
      expect(ledger.status).toBe(200);
      expect(ledger.body.data.total).toBe(2);
      expect(ledger.body.data.items).toHaveLength(2);
      expect(ledger.body.data.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            activityId: outsideLedgerActivityId,
            entryTypeCode: 'service_credit',
          }),
          expect.objectContaining({
            activityId: outsideLedgerActivityId,
            entryTypeCode: 'contribution_credit',
          }),
        ]),
      );

      const summary = await request(httpServer(app))
        .get(`/api/admin/v1/members/${attTargetMemberId}/contribution-summary`)
        .set('Authorization', supervisorAuth);
      expect(summary.status).toBe(200);
      expect(summary.body.data).toEqual({
        memberId: attTargetMemberId,
        contributionPoints: '2',
        ledgerTotals: {
          committedServiceHours: '4',
          committedContributionPoints: '2',
          inFlightServiceHours: '0',
          inFlightContributionPoints: '0',
        },
      });

      const groupSummary = await request(httpServer(app))
        .get(`/api/admin/v1/members/${groupTargetMemberId}/contribution-summary`)
        .set('Authorization', groupLeaderAuth);
      expect(groupSummary.status).toBe(200);
      expect(groupSummary.body.data.memberId).toBe(groupTargetMemberId);
      expect(groupSummary.body.data.contributionPoints).toBe('1');

      for (const suffix of ['registrations', 'participation-ledger', 'contribution-summary']) {
        expectBizError(
          await request(httpServer(app))
            .get(`/api/admin/v1/members/${crossTargetMemberId}/${suffix}`)
            .set('Authorization', teamLeaderAuth),
          BizCode.RBAC_FORBIDDEN,
        );
      }
    });

    it('member-axis 不存在资源:GLOBAL 持码者保留 MEMBER_NOT_FOUND,scoped 持码者 30100 防枚举', async () => {
      expectBizError(
        await request(httpServer(app))
          .get('/api/admin/v1/members/no-such-member/registrations')
          .set('Authorization', bizAdminAuth),
        BizCode.MEMBER_NOT_FOUND,
      );
      expectBizError(
        await request(httpServer(app))
          .get('/api/admin/v1/members/no-such-member/registrations')
          .set('Authorization', teamLeaderAuth),
        BizCode.RBAC_FORBIDDEN,
      );
    });
  });

  // ============ ⑤NOT_FOUND 回退(沿 PR9 范式;三模块各一例) ============

  describe('⑤NOT_FOUND 回退(resource_not_found → rbac.can 全局码回退,「先判权后查资源」行为锁)', () => {
    it('activities.update:GLOBAL 持码者(biz-admin)→ ACTIVITY_NOT_FOUND;无码者 → 30100', async () => {
      expectBizError(
        await request(httpServer(app))
          .patch('/api/admin/v1/activities/no-such-activity')
          .set('Authorization', bizAdminAuth)
          .send({ title: 'x' }),
        BizCode.ACTIVITY_NOT_FOUND,
      );
      expectBizError(
        await request(httpServer(app))
          .patch('/api/admin/v1/activities/no-such-activity')
          .set('Authorization', bareUserAuth)
          .send({ title: 'x' }),
        BizCode.RBAC_FORBIDDEN,
      );
    });

    it('activity-registrations.approve:GLOBAL 持码者 → ACTIVITY_REGISTRATION_NOT_FOUND;无码者 → 30100', async () => {
      expectBizError(
        await request(httpServer(app))
          .patch(
            `/api/admin/v1/activities/${smrtActivity2Id}/registrations/no-such-registration/approve`,
          )
          .set('Authorization', bizAdminAuth)
          .send({}),
        BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
      );
      expectBizError(
        await request(httpServer(app))
          .patch(
            `/api/admin/v1/activities/${smrtActivity2Id}/registrations/no-such-registration/approve`,
          )
          .set('Authorization', bareUserAuth)
          .send({}),
        BizCode.RBAC_FORBIDDEN,
      );
    });

    it('旧详情路由始终404；新版未知版本对 GLOBAL、scoped 与无码用户均防枚举', async () => {
      for (const auth of [bizAdminAuth, teamLeaderAuth, bareUserAuth]) {
        await request(httpServer(app))
          .get('/api/admin/v1/attendance-sheets/no-such-sheet')
          .set('Authorization', auth)
          .expect(404);
        expectBizError(
          await request(httpServer(app))
            .get('/api/admin/v1/attendance-settlements/no-such-version/review-detail')
            .set('Authorization', auth),
          BizCode.RBAC_FORBIDDEN,
        );
      }
    });
  });
});
