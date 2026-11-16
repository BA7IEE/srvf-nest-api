import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { createSettlementDraftFixture } from '../helpers/settlement-draft.fixture';

describe('native settlement return and resubmit workflow', () => {
  let app: INestApplication;
  let appB: INestApplication;
  let prisma: PrismaService;
  let organizationId: string;
  let ownerId: string;
  let memberId: string;
  let submitterId: string;
  let submitterAuth: string;
  let reviewerId: string;
  let reviewerAuth: string;
  let saId: string;
  let saAuth: string;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  type Fixture = Awaited<ReturnType<typeof createSettlementDraftFixture>> & { versionId: string };

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    appB = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    const role = await prisma.rbacRole.create({
      data: { code: 'native-return-reviewer', displayName: '原生结算初审员' },
    });
    for (const action of ['settlement-submit', 'settlement-first-review']) {
      const code = `activity.${action}.record`;
      const permission = await prisma.permission.upsert({
        where: { code },
        update: {},
        create: { code, module: 'activity', action, resourceType: 'record' },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
    const submitter = await createTestUser(app, { username: 'return-submitter', role: Role.ADMIN });
    const reviewer = await createTestUser(app, { username: 'return-reviewer', role: Role.ADMIN });
    const sa = await createTestUser(app, { username: 'return-sa', role: Role.SUPER_ADMIN });
    submitterId = submitter.id;
    reviewerId = reviewer.id;
    saId = sa.id;
    await prisma.roleBinding.createMany({
      data: [submitter.id, reviewer.id].map((userId) => ({
        principalType: 'USER',
        principalId: userId,
        roleId: role.id,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
      })),
    });
    organizationId = (
      await prisma.organization.create({
        data: { name: 'Return workflow org', nodeTypeCode: 'return-workflow-org' },
      })
    ).id;
    const member = async (memberNo: string) =>
      (
        await prisma.member.create({
          data: {
            memberNo,
            ...memberIdentityData(memberNo),
            status: 'ACTIVE',
            gradeCode: 'level-2',
          },
        })
      ).id;
    ownerId = await member('return-owner');
    memberId = await member('return-participant');
    const saMemberId = await member('return-sa-member');
    await prisma.user.update({ where: { id: submitterId }, data: { memberId: ownerId } });
    await prisma.user.update({ where: { id: saId }, data: { memberId: saMemberId } });
    submitterAuth = (await loginAs(app, submitter.username)).authHeader;
    reviewerAuth = (await loginAs(app, reviewer.username)).authHeader;
    saAuth = (await loginAs(app, sa.username)).authHeader;
  });

  afterAll(async () => {
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    await appB?.close();
    await app?.close();
  });

  const appPath = (f: { activityId: string }) =>
    `/api/app/v1/my/managed-activities/${f.activityId}/settlement`;

  async function fixture(): Promise<Fixture> {
    const f = await createSettlementDraftFixture(prisma, {
      organizationId,
      ownerMemberId: ownerId,
      actorUserId: submitterId,
      participantMemberIds: [memberId],
      activityTypeCode: 'return-workflow',
    });
    const response = await request(httpServer(app))
      .post(`${appPath(f)}/submit`)
      .set('Authorization', submitterAuth)
      .send({
        operationKey: `submit-${f.activityId}`,
        expectedDraftVersion: 1,
        evidenceSealId: f.sealId,
        confirmation: true,
      })
      .expect(200);
    return { ...f, versionId: response.body.data.settlementVersionId as string };
  }

  async function review(
    f: Fixture,
    stage: 'first' | 'final',
    action: 'approve' | 'return',
    auth = stage === 'first' ? reviewerAuth : saAuth,
    note = '请复核原始记录',
    instance = app,
  ) {
    const version = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: f.versionId },
    });
    return request(httpServer(instance))
      .post(`/api/admin/v1/attendance-settlements/${f.versionId}/${stage}-${action}`)
      .set('Authorization', auth)
      .send({
        operationKey: `${stage}-${action}-${f.versionId}`,
        evidenceSealId: version.evidenceSealId,
        evidenceRevision: version.evidenceRevision,
        populationRevision: version.populationRevision,
        workflowRevision: version.workflowRevision,
        contentHash: version.contentHash,
        note,
      });
  }

  function resubmit(f: Fixture) {
    return request(httpServer(app))
      .post(`${appPath(f)}/versions/${f.versionId}/resubmit`)
      .set('Authorization', saAuth)
      .send({
        operationKey: `resubmit-${f.activityId}`,
        expectedDraftVersion: 1,
        evidenceSealId: f.sealId,
        confirmation: true,
      });
  }

  const version = (f: Fixture) =>
    prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: f.versionId },
      include: {
        resultRevisions: { orderBy: { id: 'asc' } },
        reviewActions: { orderBy: { actedAt: 'asc' } },
        postingBatches: { orderBy: { id: 'asc' } },
      },
    });

  async function snapshot(f: Fixture) {
    return {
      versions: await prisma.attendanceSettlementVersion.findMany({
        where: { settlementRunId: f.runId },
        orderBy: { version: 'asc' },
        include: { resultRevisions: { orderBy: { id: 'asc' } }, reviewActions: true },
      }),
      run: await prisma.attendanceSettlementRun.findUniqueOrThrow({ where: { id: f.runId } }),
      audits: await prisma.auditLog.findMany({
        where: { resourceId: f.activityId },
        orderBy: { id: 'asc' },
      }),
      intents: await prisma.notificationOutboxIntent.count({
        where: { aggregateId: f.activityId },
      }),
    };
  }

  it('first return preserves records/audit; SUPER_ADMIN resubmits a fresh version without erasing history', async () => {
    const f = await fixture();
    const facts = (await version(f)).resultRevisions;
    const returned = await review(f, 'first', 'return', reviewerAuth, ' 请补充签退说明 ');
    expect(returned.status).toBe(200);
    const previous = await version(f);
    expect(previous).toMatchObject({
      statusCode: 'returned',
      returnFromStage: 'first',
      returnReason: '请补充签退说明',
    });
    expect(previous.resultRevisions).toEqual(facts);
    expect(previous.reviewActions).toHaveLength(1);
    expect(previous.reviewActions[0]).toMatchObject({
      stageCode: 'first',
      actionCode: 'return',
      actorUserId: reviewerId,
    });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: {
        resourceId: f.activityId,
        event: 'activity.publish',
        context: { path: ['extra', 'operation'], equals: 'settlement-first-review' },
      },
    });
    expect(audit.context).toMatchObject({ extra: { actionCode: 'return' } });
    const submitted = await resubmit(f);
    expect(submitted.status).toBe(200);
    const next = { ...f, versionId: submitted.body.data.settlementVersionId as string };
    const current = await version(next);
    expect(current).toMatchObject({
      statusCode: 'submitted',
      createdByUserId: saId,
      priorVersionId: f.versionId,
      returnFromStage: null,
      returnReason: null,
      version: 3,
    });
    expect(current.reviewActions).toHaveLength(0);
    expect(current.resultRevisions).toHaveLength(1);
    expect(current.resultRevisions[0]).toMatchObject({
      participationIdentityId: facts[0].participationIdentityId,
      recognizedServiceHours: facts[0].recognizedServiceHours,
      recognizedContributionPoints: facts[0].recognizedContributionPoints,
    });
    expect(await version(f)).toEqual(previous);
    const beforeDenied = await snapshot(next);
    expectBizError(
      await review(next, 'first', 'approve', saAuth),
      BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN,
    );
    expect(await snapshot(next)).toEqual(beforeDenied);
  });

  it('final return preserves results and records the final actor and stage', async () => {
    const f = await fixture();
    expect((await review(f, 'first', 'approve')).status).toBe(200);
    const before = await version(f);
    expect((await review(f, 'final', 'return', saAuth, '终审要求修订')).status).toBe(200);
    const after = await version(f);
    expect(after).toMatchObject({
      statusCode: 'returned',
      returnFromStage: 'final',
      returnReason: '终审要求修订',
    });
    expect(after.resultRevisions).toEqual(before.resultRevisions);
    expect(after.reviewActions).toHaveLength(2);
    expect(after.reviewActions[1]).toMatchObject({
      stageCode: 'final',
      actionCode: 'return',
      actorUserId: saId,
    });
  });

  it('return actions retain self/same-reviewer constraints with zero writes', async () => {
    const self = await fixture();
    const beforeSelf = await snapshot(self);
    expectBizError(
      await review(self, 'first', 'return', submitterAuth),
      BizCode.SETTLEMENT_SELF_FIRST_REVIEW_FORBIDDEN,
    );
    expect(await snapshot(self)).toEqual(beforeSelf);
    const same = await fixture();
    expect((await review(same, 'first', 'approve', saAuth)).status).toBe(200);
    const beforeSame = await snapshot(same);
    expectBizError(
      await review(same, 'final', 'return', saAuth),
      BizCode.SETTLEMENT_SAME_REVIEWER_FORBIDDEN,
    );
    expect(await snapshot(same)).toEqual(beforeSame);
  });

  it('rejects blank return notes and resubmission outside returned with stable codes and zero writes', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    expectBizError(
      await review(f, 'first', 'return', reviewerAuth, '   '),
      BizCode.SETTLEMENT_REVIEW_RETURN_REASON_REQUIRED,
    );
    expectBizError(await resubmit(f), BizCode.SETTLEMENT_RESUBMIT_VERSION_NOT_RETURNED);
    expect(await snapshot(f)).toEqual(before);
  });

  it('two Nest apps serialize approve-vs-return at both stages without duplicate decisions or posting', async () => {
    for (const stage of ['first', 'final'] as const) {
      const f = await fixture();
      if (stage === 'final') expect((await review(f, 'first', 'approve')).status).toBe(200);
      const before = await version(f);
      const auth = stage === 'first' ? reviewerAuth : saAuth;
      const results = await Promise.all([
        review(f, stage, 'approve', auth, 'approve race', app),
        review(f, stage, 'return', auth, 'return race', appB),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      expectBizError(
        results.find((result) => result.status === 409)!,
        BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED,
      );
      const after = await version(f);
      const decision = after.reviewActions.filter((row) => row.stageCode === stage);
      expect(decision).toHaveLength(1);
      expect(after.resultRevisions).toEqual(before.resultRevisions);
      const run = await prisma.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: f.runId },
      });
      if (decision[0].actionCode === 'return') {
        expect(run.statusCode).toBe('drafting');
        expect(after.statusCode).toBe('returned');
        expect(after.postingBatches).toHaveLength(0);
      } else if (stage === 'first') {
        expect(run.statusCode).toBe('pending_final_review');
        expect(after.statusCode).toBe('submitted');
        expect(after.postingBatches).toHaveLength(0);
      } else {
        expect(run.statusCode).toBe('posting');
        expect(after.statusCode).toBe('approved');
        expect(after.postingBatches).toHaveLength(1);
        expect(after.postingBatches[0].statusCode).toBe('preparing');
      }
      const audits = await prisma.auditLog.findMany({
        where: {
          resourceId: f.activityId,
          context: {
            path: ['extra', 'operation'],
            equals: `settlement-${stage}-review`,
          },
        },
      });
      expect(audits).toHaveLength(1);
    }
  });
});
