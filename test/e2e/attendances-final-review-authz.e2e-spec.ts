import type { INestApplication } from '@nestjs/common';
import {
  AssignmentStatus,
  BindingScopeType,
  BindingStatus,
  PrincipalType,
  Role,
} from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { AuthzService } from '../../src/modules/authz/authz.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertTestDatabaseUrl } from '../setup/test-db';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// 原 PR9 人员隔离和 BD-2 任职授权矩阵，迁到不可变结算版本/ReviewAction。
// 使用真实 seed 的角色、职务、组织闭包，保留无绑定拒绝、撤任职即时失权、
// SA/scoped 自审和两级同人拒绝、兼容 env 不放宽约束，以及拒绝零写。
// 重提创建新版本并保留旧版本；旧 reopen 只验证不可作为新版本的兼容别名。
// 真实账本更正另由 activity-settlement-correction 和入队并发套件验证。

const SEED_ENV = {
  APP_ENV: 'test',
  SUPER_ADMIN_PASSWORD: 'Passw0rd1!',
  SUPER_ADMIN_EMAIL: '',
  RBAC_INITIAL_OPS_ADMIN_USER_ID: '',
  SUPER_ADMIN_USERNAME: 'pr9-fra-su',
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
const FIRST_REVIEWER_ROLE_CODE = 'attendance-first-reviewer';
const FINAL_REVIEWER_ROLE_CODE = 'attendance-final-reviewer';

describe('原生结算审核人员隔离与 BD-2 scoped 授权', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authz: AuthzService;

  let rootId: string;
  let apdId: string;
  let activityId: string;
  const previousWorkflowGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  const expectations = new Map<
    string,
    {
      evidenceSealId: string;
      evidenceRevision: number;
      populationRevision: number;
      workflowRevision: number;
      contentHash: string;
    }
  >();

  // HTTP 身份(均 loginAs 真登录)
  let subAdminId: string; // ADMIN + biz-admin + 显式一审角色；兼作自审拒绝主体
  let subAdminAuth: string;
  let revAdminId: string; // 历史一审事实的 actor；不据此授予当前审核权限
  let finalAdminAuth: string; // ADMIN + biz-admin;PR-11 摘码主体(④ 终审 30100 / ⑤b 责任动作边界)
  let finalAdminPayload: CurrentUserPayload;
  let saUserId: string;
  let saAuth: string;
  let bareUserAuth: string;
  let adminNoGrantAuth: string;
  // BD-2 scoped 终审人(无 biz-admin,仅 POSITION_ASSIGNMENT 主体绑定)
  let deptHeadUserId: string;
  let deptHeadAuth: string;
  let deptHeadPayload: CurrentUserPayload;
  let deptHeadAssignmentId: string;
  // 同职务无绑定者(⑦)
  let deptPeerAuth: string;

  // 只构造授权所消费的不可变提交/既有一审事实；不改写提交人或复活旧服务。
  // 每个运行独立活动；重提用 priorVersionId 关联新版本，保留旧版本。
  async function createVersion(
    submitterUserId: string,
    reviewerUserId?: string,
    stage: 'first' | 'final' = 'final',
    priorSubmitterUserId?: string,
  ): Promise<string> {
    const prototype = await prisma.activity.findUniqueOrThrow({ where: { id: activityId } });
    const activity = await prisma.activity.create({
      data: {
        title: prototype.title,
        activityTypeCode: prototype.activityTypeCode,
        organizationId: prototype.organizationId,
        startAt: prototype.startAt,
        endAt: prototype.endAt,
        location: prototype.location,
        statusCode: 'published',
      },
    });
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
        contentHash: `fra-seal-${activity.id}`,
        statusCode: 'active',
        sealedByUserId: submitterUserId,
        sealedAt: activity.endAt,
      },
    });
    const versionNumber = priorSubmitterUserId === undefined ? 1 : 2;
    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        statusCode: stage === 'first' ? 'pending_first_review' : 'pending_final_review',
        currentSubmittedVersion: versionNumber,
      },
    });
    const common = {
      settlementRunId: run.id,
      evidenceSealId: seal.id,
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      personCount: 0,
      sessionParticipationCount: 0,
      serviceSegmentCount: 0,
      submittedAt: activity.endAt,
    };
    const prior =
      priorSubmitterUserId === undefined
        ? null
        : await prisma.attendanceSettlementVersion.create({
            data: {
              ...common,
              version: 1,
              createdByUserId: priorSubmitterUserId,
              statusCode: 'returned',
              returnFromStage: 'first',
              returnReason: '修订后重新提交',
              contentHash: `fra-prior-${activity.id}`,
              operationKey: `fra-prior-${activity.id}`,
              requestHash: `fra-prior-hash-${activity.id}`,
            },
          });
    const version = await prisma.attendanceSettlementVersion.create({
      data: {
        ...common,
        version: versionNumber,
        priorVersionId: prior?.id,
        createdByUserId: submitterUserId,
        statusCode: 'submitted',
        contentHash: `fra-version-${activity.id}`,
        operationKey: `fra-submit-${activity.id}`,
        requestHash: `fra-submit-hash-${activity.id}`,
      },
    });
    if (stage === 'final') {
      await prisma.settlementReviewAction.create({
        data: {
          settlementVersionId: version.id,
          stageCode: 'first',
          actionCode: 'approve',
          actorUserId: reviewerUserId ?? revAdminId,
          actedAt: new Date(),
          operationKey: `fra-first-${version.id}`,
          requestHash: `fra-first-hash-${version.id}`,
        },
      });
    }
    expectations.set(version.id, {
      evidenceSealId: seal.id,
      evidenceRevision: 0,
      populationRevision: 0,
      workflowRevision: 0,
      contentHash: version.contentHash,
    });
    return version.id;
  }

  function review(
    versionId: string,
    auth: string,
    stage: 'first' | 'final',
    action: 'approve' | 'return',
    instance = app,
  ) {
    const expectation = expectations.get(versionId);
    if (!expectation) throw new Error('missing immutable review fixture');
    return request(httpServer(instance))
      .post(`/api/admin/v1/attendance-settlements/${versionId}/${stage}-${action}`)
      .set('Authorization', auth)
      .send({
        operationKey: `fra-${stage}-${action}-${versionId}`,
        ...expectation,
        ...(action === 'return' ? { note: '人员隔离验证' } : {}),
      });
  }

  function finalApprove(versionId: string, auth: string) {
    return review(versionId, auth, 'final', 'approve');
  }

  async function versionState(versionId: string) {
    const version = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    return {
      version,
      run: await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: version.settlementRunId },
      }),
      actions: await prisma.settlementReviewAction.findMany({
        where: { settlementVersionId: versionId },
        orderBy: { id: 'asc' },
      }),
      batches: await prisma.ledgerPostingBatch.findMany({
        where: { settlementVersionId: versionId },
        orderBy: { id: 'asc' },
      }),
      auditCount: await prisma.auditLog.count(),
      intentCount: await prisma.notificationOutboxIntent.count(),
    };
  }

  async function expectRetiredReopen(versionId: string, auth: string) {
    const before = await versionState(versionId);
    await request(httpServer(app))
      .post(`/api/admin/v1/attendance-sheets/${versionId}/reopen`)
      .set('Authorization', auth)
      .send({ reason: '不能把新版本当旧单据重开' })
      .expect(404);
    expect(await versionState(versionId)).toEqual(before);
  }

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    runSeed();

    prisma = app.get(PrismaService);
    authz = app.get(AuthzService);

    const orgByCode = async (code: string): Promise<string> =>
      (await prisma.organization.findFirstOrThrow({ where: { code }, select: { id: true } })).id;
    rootId = await orgByCode('SRVF');
    apdId = await orgByCode('APD');

    // 活动挂真 seed 部门(closure 由 seed 维护;TREE@root 经 organizationPath 覆盖)
    const activity = await prisma.activity.create({
      data: {
        title: '终审接线演示',
        activityTypeCode: 'pr9-demo',
        organizationId: apdId,
        startAt: new Date('2026-06-01T01:00:00.000Z'),
        endAt: new Date('2026-06-01T05:00:00.000Z'),
        location: '训练场',
        statusCode: 'completed',
      },
      select: { id: true },
    });
    activityId = activity.id;

    // ===== HTTP 身份 =====
    const subAdmin = await createTestUser(app, { username: 'fra-sub-adm', role: Role.ADMIN });
    const revAdmin = await createTestUser(app, { username: 'fra-rev-adm', role: Role.ADMIN });
    const finalAdmin = await createTestUser(app, { username: 'fra-final-adm', role: Role.ADMIN });
    const saUser = await createTestUser(app, { username: 'fra-su-2', role: Role.SUPER_ADMIN });
    await createTestUser(app, { username: 'fra-bare-user', role: Role.USER });
    await createTestUser(app, { username: 'fra-adm-nogrant', role: Role.ADMIN });
    subAdminId = subAdmin.id;
    revAdminId = revAdmin.id;
    saUserId = saUser.id;

    // biz-admin 用真 seed 角色(PR-11 后 68 码；不注入 test-only legacy 动作)。
    const bizAdminRoleId = (
      await prisma.rbacRole.findFirstOrThrow({
        where: { code: 'biz-admin', deletedAt: null },
        select: { id: true },
      })
    ).id;
    await grantBizAdminToUser(app, subAdmin.id, bizAdminRoleId, {
      includeLegacyActivityActions: false,
    });
    await grantBizAdminToUser(app, revAdmin.id, bizAdminRoleId, {
      includeLegacyActivityActions: false,
    });
    await grantBizAdminToUser(app, finalAdmin.id, bizAdminRoleId, {
      includeLegacyActivityActions: false,
    });
    // ②b 必须先命中真实一审 grant，才能验证“提交人/最近重提人不得一审”的域约束。
    // 不再借 biz-admin 的旧动作权限承载该用例。
    const firstReviewerRoleId = (
      await prisma.rbacRole.findFirstOrThrow({
        where: { code: FIRST_REVIEWER_ROLE_CODE, deletedAt: null },
        select: { id: true },
      })
    ).id;
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: subAdmin.id,
        roleId: firstReviewerRoleId,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        startedAt: PAST_START,
      },
    });
    finalAdminPayload = {
      id: finalAdmin.id,
      username: 'fra-final-adm',
      role: Role.ADMIN,
      status: finalAdmin.status,
      memberId: null,
    };

    finalAdminAuth = (await loginAs(app, 'fra-final-adm')).authHeader;
    subAdminAuth = (await loginAs(app, 'fra-sub-adm')).authHeader;
    saAuth = (await loginAs(app, 'fra-su-2')).authHeader;
    bareUserAuth = (await loginAs(app, 'fra-bare-user')).authHeader;
    adminNoGrantAuth = (await loginAs(app, 'fra-adm-nogrant')).authHeader;

    // ===== BD-2 scoped 终审人:APD dept-leader 任职 + attendance-final-reviewer@TREE(root)=====
    const deptHeadUser = await createTestUser(app, { username: 'fra-dept-head', role: Role.USER });
    deptHeadUserId = deptHeadUser.id;
    const deptHeadMember = await prisma.member.create({
      data: { memberNo: 'fra-m-head', ...memberIdentityData('FRA 部长') },
      select: { id: true },
    });
    await prisma.user.update({
      where: { id: deptHeadUser.id },
      data: { memberId: deptHeadMember.id },
    });
    deptHeadAuth = (await loginAs(app, 'fra-dept-head')).authHeader;
    deptHeadPayload = {
      id: deptHeadUser.id,
      username: 'fra-dept-head',
      role: Role.USER,
      status: deptHeadUser.status,
      memberId: deptHeadMember.id,
    };

    const deptLeaderPositionId = (
      await prisma.organizationPosition.findFirstOrThrow({
        where: { code: 'dept-leader', deletedAt: null },
        select: { id: true },
      })
    ).id;
    deptHeadAssignmentId = (
      await prisma.organizationPositionAssignment.create({
        data: {
          memberId: deptHeadMember.id,
          organizationId: apdId,
          positionId: deptLeaderPositionId,
          status: AssignmentStatus.ACTIVE,
          startedAt: PAST_START,
        },
        select: { id: true },
      })
    ).id;
    const finalReviewerRoleId = (
      await prisma.rbacRole.findFirstOrThrow({
        where: { code: FINAL_REVIEWER_ROLE_CODE, deletedAt: null },
        select: { id: true },
      })
    ).id;
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.POSITION_ASSIGNMENT,
        principalId: deptHeadAssignmentId,
        roleId: finalReviewerRoleId,
        scopeType: BindingScopeType.ORGANIZATION_TREE,
        scopeOrgId: rootId,
        status: BindingStatus.ACTIVE,
        startedAt: PAST_START,
      },
    });

    // ⑦ 同职务(APD dept-leader)但零 RoleBinding 的对照者
    const peerUser = await createTestUser(app, { username: 'fra-dept-peer', role: Role.USER });
    const peerMember = await prisma.member.create({
      data: { memberNo: 'fra-m-peer', ...memberIdentityData('FRA 部长对照') },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: peerUser.id }, data: { memberId: peerMember.id } });
    deptPeerAuth = (await loginAs(app, 'fra-dept-peer')).authHeader;
    await prisma.organizationPositionAssignment.create({
      data: {
        memberId: peerMember.id,
        organizationId: apdId,
        positionId: deptLeaderPositionId,
        status: AssignmentStatus.ACTIVE,
        startedAt: PAST_START,
      },
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (previousWorkflowGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousWorkflowGate;
    }
  });

  // ============ 真收紧(约束语义;摘码后由持权身份承载)============

  it('① SA 不能终审自己的提交；版本、审核、批次、审计及通知零变化', async () => {
    const versionId = await createVersion(saUserId);
    const before = await versionState(versionId);
    expectBizError(
      await finalApprove(versionId, saAuth),
      BizCode.SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN,
    );
    expect(await versionState(versionId)).toEqual(before);
  });

  it('①b scoped 持权者仍不能终审自己的提交', async () => {
    // 依赖声明顺序先于 ⑥(⑥ 会永久 END deptHead 任职);此时绑定仍 ACTIVE。
    const versionId = await createVersion(deptHeadUserId);
    const before = await versionState(versionId);
    expectBizError(
      await finalApprove(versionId, deptHeadAuth),
      BizCode.SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN,
    );
    expect(await versionState(versionId)).toEqual(before);
  });

  it('② SA 不能兼任两级审核', async () => {
    const versionId = await createVersion(subAdminId, saUserId);
    const before = await versionState(versionId);
    expectBizError(
      await finalApprove(versionId, saAuth),
      BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN,
    );
    expect(await versionState(versionId)).toEqual(before);
  });

  it('②b 初次和重提版本的提交人都不能一审通过/退回；旧版本保持不变', async () => {
    const originalVersionId = await createVersion(subAdminId, undefined, 'first');
    const original = await versionState(originalVersionId);
    expectBizError(
      await review(originalVersionId, subAdminAuth, 'first', 'approve'),
      BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN,
    );
    expect(await versionState(originalVersionId)).toEqual(original);

    const resubmittedId = await createVersion(subAdminId, undefined, 'first', revAdminId);
    const before = await versionState(resubmittedId);
    const priorId = before.version.priorVersionId;
    expect(priorId).not.toBeNull();
    if (priorId === null) throw new Error('missing prior settlement version');
    const prior = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: priorId },
    });
    expect(prior).toMatchObject({
      createdByUserId: revAdminId,
      statusCode: 'returned',
      version: 1,
    });
    expect(before.version).toMatchObject({ createdByUserId: subAdminId, version: 2 });
    expectBizError(
      await review(resubmittedId, subAdminAuth, 'first', 'return'),
      BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN,
    );
    expect(await versionState(resubmittedId)).toEqual(before);
    await expect(
      prisma.attendanceSettlementVersion.findUniqueOrThrow({ where: { id: prior.id } }),
    ).resolves.toEqual(prior);
  });

  it('③终审退回同样禁止 SA 自审和两级同人', async () => {
    for (const [creatorId, firstId, biz] of [
      [saUserId, revAdminId, BizCode.SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN],
      [subAdminId, saUserId, BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN],
    ] as const) {
      const versionId = await createVersion(creatorId, firstId);
      const before = await versionState(versionId);
      expectBizError(await review(versionId, saAuth, 'final', 'return'), biz);
      expect(await versionState(versionId)).toEqual(before);
    }
  });

  // ============ 摘码翻面(2026-07-03;原 B 方案 GLOBAL ALLOW 翻转)============

  it('④ biz-admin 不获得新旧终审动作；拒绝零写，旧 reopen 不作别名', async () => {
    const versionId = await createVersion(subAdminId, revAdminId);
    const before = await versionState(versionId);
    expectBizError(await finalApprove(versionId, finalAdminAuth), BizCode.RBAC_FORBIDDEN);
    expectBizError(
      await review(versionId, finalAdminAuth, 'final', 'return'),
      BizCode.RBAC_FORBIDDEN,
    );
    expect(await versionState(versionId)).toEqual(before);
    await expectRetiredReopen(versionId, finalAdminAuth);

    // DB 显式断言:终审三码不在 biz-admin 绑定(seed 对账另见 seed-biz-admin.e2e-spec 68)
    const bizRole = await prisma.rbacRole.findFirstOrThrow({
      where: { code: 'biz-admin', deletedAt: null },
      select: { id: true },
    });
    expect(
      await prisma.rolePermission.count({
        where: {
          roleId: bizRole.id,
          permission: {
            code: {
              in: [
                'attendance.final-approve.sheet',
                'attendance.final-reject.sheet',
                'attendance.reopen.sheet',
                'activity.settlement-first-review.record',
                'activity.settlement-final-review.record',
              ],
            },
          },
        },
      }),
    ).toBe(0);
  });

  it('④b SA 可以终审他人版本，只准备批次；旧 reopen 不改变已批准版本', async () => {
    const versionId = await createVersion(subAdminId, revAdminId);
    const res = await finalApprove(versionId, saAuth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      versionStatusAfter: 'approved',
      runStatusAfter: 'posting',
      ledgerPostingBatchStatus: 'preparing',
    });
    const after = await versionState(versionId);
    expect(after.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageCode: 'final',
          actorUserId: saUserId,
          actionCode: 'approve',
        }),
      ]),
    );
    expect(after.batches).toHaveLength(1);
    expect(after.batches[0]).toMatchObject({ statusCode: 'preparing', committedAt: null });
    await expectRetiredReopen(versionId, saAuth);
  });

  it('⑤裸 USER / 无 biz-admin 的 ADMIN → 30100(权限拒绝面契约零变)', async () => {
    const versionId = await createVersion(subAdminId, revAdminId);
    const before = await versionState(versionId);
    for (const auth of [bareUserAuth, adminNoGrantAuth]) {
      expectBizError(await finalApprove(versionId, auth), BizCode.RBAC_FORBIDDEN);
      expectBizError(await review(versionId, auth, 'final', 'return'), BizCode.RBAC_FORBIDDEN);
      expect(await versionState(versionId)).toEqual(before);
    }
  });

  it('⑤b PR-11 摘码边界:biz-admin 仅保留考勤读取,全部责任动作 DENY', async () => {
    expect(await authz.can(finalAdminPayload, 'attendance.read.sheet')).toBe(true);
    for (const action of [
      'attendance.create.sheet',
      'attendance.update.sheet',
      'attendance.delete.sheet',
      'attendance.approve.sheet',
      'attendance.reject.sheet',
      'attendance.return.sheet',
      'attendance.final-return.sheet',
      'attendance.final-approve.sheet',
      'attendance.final-reject.sheet',
      'attendance.reopen.sheet',
      'activity.settlement-first-review.record',
      'activity.settlement-final-review.record',
    ]) {
      expect(await authz.can(finalAdminPayload, action)).toBe(false);
    }
  });

  // ============ BD-2 scoped 通路(goal DoD 4)============

  it('⑥scoped 全链:任职+绑定 → 200(source=role_binding);撤任职 → 同请求 30100(expired_grant 换届即失权)', async () => {
    // 无 biz-admin 的 USER,仅凭 POSITION_ASSIGNMENT 主体绑定终审他人单 → ALLOW
    const versionA = await createVersion(subAdminId, revAdminId);
    const explainAllow = await authz.explain(
      deptHeadPayload,
      'activity.settlement-final-review.record',
      { type: 'attendance_settlement_version', id: versionA },
    );
    expect(explainAllow.allow).toBe(true);
    expect(explainAllow.matchedGrant?.source).toBe('role_binding');
    expect(explainAllow.matchedGrant?.roleCode).toBe(FINAL_REVIEWER_ROLE_CODE);
    expect(explainAllow.matchedGrant?.scopeType).toBe(BindingScopeType.ORGANIZATION_TREE);
    const resAllow = await finalApprove(versionA, deptHeadAuth);
    expect(resAllow.status).toBe(200);
    expect(resAllow.body.data.versionStatusAfter).toBe('approved');
    const approved = await versionState(versionA);
    expect(approved.version.statusCode).toBe('approved');
    expect(approved.run.statusCode).toBe('posting');
    expect(approved.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageCode: 'final',
          actionCode: 'approve',
          actorUserId: deptHeadUserId,
        }),
      ]),
    );
    await expectRetiredReopen(versionA, deptHeadAuth);

    // 换届:任职 ENDED → POSITION_ASSIGNMENT 主体绑定随之失效(不动绑定行)
    await prisma.organizationPositionAssignment.update({
      where: { id: deptHeadAssignmentId },
      data: { status: AssignmentStatus.ENDED, endedAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    const versionB = await createVersion(subAdminId, revAdminId);
    const before = await versionState(versionB);
    const explainDeny = await authz.explain(
      deptHeadPayload,
      'activity.settlement-final-review.record',
      { type: 'attendance_settlement_version', id: versionB },
    );
    expect(explainDeny.allow).toBe(false);
    expect(explainDeny.reason).toBe('expired_grant');
    expectBizError(await finalApprove(versionB, deptHeadAuth), BizCode.RBAC_FORBIDDEN);
    expect(await versionState(versionB)).toEqual(before);
  });

  it('⑦同职务无绑定者 → 30100(no_permission;终审绝不随职务推导 —— org-admin policy 无终审码)', async () => {
    const versionId = await createVersion(subAdminId, revAdminId);
    const before = await versionState(versionId);
    expectBizError(await finalApprove(versionId, deptPeerAuth), BizCode.RBAC_FORBIDDEN);
    expect(await versionState(versionId)).toEqual(before);
  });

  // ============ 兼容 env(独立 app 实例读 env，但运行时忽略)============

  describe('⑧ATTENDANCE_ALLOW_SAME_REVIEWER=true(独立 app;同人/自审仍严格拒绝)', () => {
    let relaxedApp: INestApplication;
    let relaxedSaAuth: string;
    const previousSameReviewer = process.env.ATTENDANCE_ALLOW_SAME_REVIEWER;

    beforeAll(async () => {
      process.env.ATTENDANCE_ALLOW_SAME_REVIEWER = 'true';
      relaxedApp = await createTestApp();
      // 同库同用户,对新 app 实例重新登录(fixtures 不重建)。
      // 摘码后 ADMIN+biz-admin 无终审码,同人/自审对照均由持权的 SA 承载。
      relaxedSaAuth = (await loginAs(relaxedApp, 'fra-su-2')).authHeader;
    }, 60_000);

    afterAll(async () => {
      try {
        await relaxedApp?.close();
      } finally {
        if (previousSameReviewer === undefined) delete process.env.ATTENDANCE_ALLOW_SAME_REVIEWER;
        else process.env.ATTENDANCE_ALLOW_SAME_REVIEWER = previousSameReviewer;
      }
    });

    it('兼容 env 不放宽原生两级人员隔离', async () => {
      for (const [creatorId, firstId, biz] of [
        [subAdminId, saUserId, BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN],
        [saUserId, revAdminId, BizCode.SETTLEMENT_SELF_FINAL_REVIEW_FORBIDDEN],
      ] as const) {
        const versionId = await createVersion(creatorId, firstId);
        const before = await versionState(versionId);
        expectBizError(await review(versionId, relaxedSaAuth, 'final', 'approve', relaxedApp), biz);
        expect(await versionState(versionId)).toEqual(before);
      }
    });
  });
});
