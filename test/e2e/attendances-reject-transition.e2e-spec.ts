import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import type { AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { ActivitySettlementHttpService } from '../../src/modules/activities/activity-settlement-http.service';
import { SettlementSubmitService } from '../../src/modules/activities/settlement-submit.service';
import { SettlementDraftService } from '../../src/modules/activities/settlement-draft.service';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { httpServer } from '../helpers/http-server';
import { createSettlementDraftFixture } from '../helpers/settlement-draft.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// Old hard rejection is retired. Its valid review/state/audit/concurrency
// assertions move to first-return, which preserves facts for resubmission.
// Historical Sheet deletion is deliberately not inherited by the new command.
const META: AuditMeta = { requestId: 'rej-native-state', ip: null, ua: 'jest/return-state' };
type Fixture = Awaited<ReturnType<typeof createSettlementDraftFixture>> & { versionId: string };

describe('native first-return and retired hard rejection', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reviews: ActivitySettlementHttpService;
  let submitter: CurrentUserPayload;
  let reviewer: CurrentUserPayload;
  let auth: string;
  let organizationId: string;
  let ownerId: string;
  let participantIds: string[];
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    reviews = app.get(ActivitySettlementHttpService);
    const user = async (username: string, role: Role): Promise<CurrentUserPayload> => {
      const row = await createTestUser(app, { username, role });
      return { id: row.id, username, role, status: UserStatus.ACTIVE, memberId: null };
    };
    submitter = await user('att-rej-submitter', Role.USER);
    reviewer = await user('att-rej-reviewer', Role.ADMIN);
    auth = (await loginAs(app, reviewer.username)).authHeader;
    const role = await prisma.rbacRole.create({
      data: { code: 'native-return-characterization', displayName: '原生退回验收' },
    });
    const code = 'activity.settlement-first-review.record';
    const permission = await prisma.permission.upsert({
      where: { code },
      update: {},
      create: {
        code,
        module: 'activity',
        action: 'settlement-first-review',
        resourceType: 'record',
      },
    });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await prisma.roleBinding.create({
      data: {
        principalType: 'USER',
        principalId: reviewer.id,
        roleId: role.id,
        scopeType: 'GLOBAL',
        status: 'ACTIVE',
      },
    });
    organizationId = (
      await prisma.organization.create({
        data: { name: 'Return transition org', nodeTypeCode: 'return-root' },
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
    ownerId = await member('return-transition-owner');
    participantIds = await Promise.all([1, 2].map((index) => member(`return-transition-${index}`)));
  });

  afterAll(async () => {
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    await app?.close();
  });

  async function fixture(): Promise<Fixture> {
    const f = await createSettlementDraftFixture(prisma, {
      organizationId,
      ownerMemberId: ownerId,
      actorUserId: submitter.id,
      participantMemberIds: participantIds,
      activityTypeCode: 'return-type',
    });
    for (const [index, participationIdentityId] of f.identityIds.entries()) {
      await app.get(SettlementDraftService).updateItem(
        {
          activityId: f.activityId,
          participationIdentityId,
          expectedDraftVersion: 1,
          resultCode: 'present',
          recognizedServiceHours: 2,
          recognizedContributionPoints: index + 1,
          reason: '退回验收人工认定',
        },
        submitter,
        META,
      );
    }
    const result = await app.get(SettlementSubmitService).submit(
      {
        activityId: f.activityId,
        operationKey: `submit-${f.activityId}`,
        requestHash: `submit-hash-${f.activityId}`,
        expectedDraftVersion: 1,
        expectedEvidenceSealId: f.sealId,
      },
      submitter,
      META,
    );
    return { ...f, versionId: result.settlementVersionId };
  }

  async function review(f: Fixture, action: 'approve' | 'return') {
    const v = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: f.versionId },
    });
    return reviews.review(
      f.versionId,
      'first',
      action,
      {
        operationKey: `${action}-${f.versionId}`,
        note: '需要重新核对',
        expectation: {
          evidenceSealId: v.evidenceSealId,
          evidenceRevision: v.evidenceRevision,
          populationRevision: v.populationRevision,
          workflowRevision: v.workflowRevision,
          contentHash: v.contentHash,
        },
      },
      reviewer,
      META,
    );
  }

  async function snapshot(f: Fixture) {
    return {
      version: await prisma.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: f.versionId },
        include: {
          resultRevisions: { orderBy: { id: 'asc' } },
          reviewActions: true,
          postingBatches: true,
        },
      }),
      run: await prisma.attendanceSettlementRun.findUniqueOrThrow({ where: { id: f.runId } }),
      audits: await prisma.auditLog.findMany({
        where: { resourceId: f.activityId },
        orderBy: { id: 'asc' },
      }),
      intents: await prisma.notificationOutboxIntent.findMany({
        where: { aggregateId: f.activityId },
        orderBy: { id: 'asc' },
      }),
    };
  }

  const reviewAudits = (f: Fixture) =>
    prisma.auditLog.findMany({
      where: {
        resourceId: f.activityId,
        context: { path: ['extra', 'operation'], equals: 'settlement-first-review' },
      },
    });

  it('first return records actor/time/note and audit, retaining results and historical Sheet data', async () => {
    const f = await fixture();
    const history = await prisma.attendanceSheet.create({
      data: {
        activityId: f.activityId,
        submitterUserId: submitter.id,
        statusCode: 'pending',
        records: {
          create: participantIds.map((memberId) => ({
            memberId,
            roleCode: 'member',
            attendanceStatusCode: 'present',
            checkInAt: new Date('2020-03-01T00:00:00Z'),
            checkOutAt: new Date('2020-03-01T02:00:00Z'),
            serviceHours: 2,
            contributionPoints: 1,
          })),
        },
      },
      include: { records: { orderBy: { id: 'asc' } } },
    });
    const before = await snapshot(f);
    expect(before.version.resultRevisions).toHaveLength(2);
    expect(await review(f, 'return')).toMatchObject({
      runStatusAfter: 'drafting',
      versionStatusAfter: 'returned',
    });
    const after = await snapshot(f);
    expect(after.version).toMatchObject({
      statusCode: 'returned',
      returnFromStage: 'first',
      returnReason: '需要重新核对',
    });
    expect(after.version.resultRevisions).toEqual(before.version.resultRevisions);
    expect(after.version.reviewActions).toHaveLength(1);
    expect(after.version.reviewActions[0]).toMatchObject({
      actionCode: 'return',
      actorUserId: reviewer.id,
      actedAt: expect.any(Date),
      note: '需要重新核对',
    });
    expect(after.version.postingBatches).toHaveLength(0);
    const logged = await reviewAudits(f);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      event: 'activity.publish',
      actorUserId: reviewer.id,
      context: {
        extra: {
          actionCode: 'return',
          runStatusBefore: 'pending_first_review',
          runStatusAfter: 'drafting',
        },
      },
    });
    expect(after.intents).toHaveLength(before.intents.length + 1);
    await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${history.id}/reject`)
      .set('Authorization', auth)
      .send({ reviewNote: 'old hard rejection' })
      .expect(404);
    expect(await snapshot(f)).toEqual(after);
    expect(
      await prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: history.id },
        include: { records: { orderBy: { id: 'asc' } } },
      }),
    ).toEqual(history);
  });

  it('approve versus return has exactly one decision, audit and intent; the loser cannot delete results', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    const settled = await Promise.allSettled([review(f, 'approve'), review(f, 'return')]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = settled.find((result) => result.status === 'rejected');
    expect(loser).toMatchObject({
      status: 'rejected',
      reason: { biz: BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED },
    });
    expect(JSON.stringify(loser)).not.toContain('40P01');
    const after = await snapshot(f);
    expect(after.version.reviewActions).toHaveLength(1);
    const approved = after.version.reviewActions[0].actionCode === 'approve';
    expect(after.run.statusCode).toBe(approved ? 'pending_final_review' : 'drafting');
    expect(after.version.statusCode).toBe(approved ? 'submitted' : 'returned');
    expect(after.version.resultRevisions).toEqual(before.version.resultRevisions);
    expect(after.version.postingBatches).toHaveLength(0);
    expect(await reviewAudits(f)).toHaveLength(1);
    expect(after.intents).toHaveLength(before.intents.length + 1);
  });

  it.each(['pending_final_review', 'posting', 'drafting', 'posted'])(
    'first return from run=%s is refused with no state/audit/effect changes',
    async (statusCode) => {
      const f = await fixture();
      await prisma.attendanceSettlementRun.update({ where: { id: f.runId }, data: { statusCode } });
      const before = await snapshot(f);
      await expect(review(f, 'return')).rejects.toMatchObject({
        biz: BizCode.SETTLEMENT_REVIEW_RUN_STATUS_INVALID,
      });
      expect(await snapshot(f)).toEqual(before);
    },
  );
});
