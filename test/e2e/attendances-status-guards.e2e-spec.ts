import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { SettlementDraftService } from '../../src/modules/activities/settlement-draft.service';
import { SettlementReviewService } from '../../src/modules/activities/settlement-review.service';
import { SettlementSubmitService } from '../../src/modules/activities/settlement-submit.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { createSettlementDraftFixture } from '../helpers/settlement-draft.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 原状态验收迁入 working draft / 不可变提交版本：
// 活动生命周期不被结算推进；非法状态整笔零写；退役删除不再级联清历史。
// 新版没有旧 rejected/final_rejected 的删除语义。returned 只开放 working draft，
// 旧提交版本仍不可变。状态闸单独 seed run 状态，完整审核迁移另由 review E2E 验证。
const META = { requestId: 'settlement-state-characterization', ip: null, ua: 'jest' };
type Fixture = Awaited<ReturnType<typeof createSettlementDraftFixture>>;
const REVIEW_STATES = [
  'pending_first_review',
  'pending_final_review',
  'posting',
  'posted',
] as const;

describe('结算状态与退役删除边界 (characterization)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let drafts: SettlementDraftService;
  let submissions: SettlementSubmitService;
  let reviews: SettlementReviewService;
  let actor: CurrentUserPayload;
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
    drafts = app.get(SettlementDraftService);
    submissions = app.get(SettlementSubmitService);
    reviews = app.get(SettlementReviewService);
    const user = async (username: string): Promise<CurrentUserPayload> => {
      const created = await createTestUser(app, { username, role: Role.SUPER_ADMIN });
      return {
        id: created.id,
        username,
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        memberId: null,
      };
    };
    actor = await user('state-submit');
    reviewer = await user('state-review');
    auth = (await loginAs(app, actor.username)).authHeader;
    organizationId = (
      await prisma.organization.create({
        data: { name: '状态验收组织', nodeTypeCode: 'settlement-state-node' },
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
    ownerId = await member('settlement-state-owner');
    participantIds = await Promise.all([
      member('settlement-state-participant-1'),
      member('settlement-state-participant-2'),
    ]);
  });

  afterAll(async () => {
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    await app?.close();
  });

  async function fixture(statusCode = 'published', people = 1) {
    const f = await createSettlementDraftFixture(prisma, {
      organizationId,
      ownerMemberId: ownerId,
      actorUserId: actor.id,
      participantMemberIds: participantIds.slice(0, people),
      activityTypeCode: 'settlement-state-type',
    });
    if (statusCode !== 'published') {
      await prisma.activity.update({ where: { id: f.activityId }, data: { statusCode } });
    }
    return f;
  }

  function submit(f: Fixture) {
    return submissions.submit(
      {
        activityId: f.activityId,
        operationKey: `submit-${f.activityId}`,
        requestHash: `state-hash-${f.activityId}`,
        expectedDraftVersion: 1,
        expectedEvidenceSealId: f.sealId,
      },
      actor,
      META,
    );
  }

  function edit(f: Fixture) {
    return drafts.updateItem(
      {
        activityId: f.activityId,
        participationIdentityId: f.identityId,
        expectedDraftVersion: 1,
        resultCode: 'present',
        recognizedServiceHours: 4,
        recognizedContributionPoints: 1,
        reason: '复核后调整',
      },
      actor,
      META,
    );
  }

  async function snapshot(f: Fixture) {
    return {
      activity: await prisma.activity.findUniqueOrThrow({ where: { id: f.activityId } }),
      run: await prisma.attendanceSettlementRun.findUniqueOrThrow({ where: { id: f.runId } }),
      versions: await prisma.attendanceSettlementVersion.findMany({
        where: { settlementRunId: f.runId },
        orderBy: { version: 'asc' },
        include: { resultRevisions: { orderBy: { id: 'asc' } } },
      }),
      audits: await prisma.auditLog.findMany({
        where: { resourceId: f.activityId },
        orderBy: { id: 'asc' },
      }),
      intents: await prisma.notificationOutboxIntent.count({
        where: { aggregateId: f.activityId },
      }),
    };
  }

  it.each(['published', 'completed'])(
    '提交 %s 活动只推进结算，不改活动生命周期',
    async (status) => {
      const f = await fixture(status);
      const result = await submit(f);
      const after = await snapshot(f);
      expect(after.activity.statusCode).toBe(status);
      expect(after.run.statusCode).toBe('pending_first_review');
      expect(after.versions).toHaveLength(2);
      expect(after.versions[1]).toMatchObject({
        id: result.settlementVersionId,
        statusCode: 'submitted',
        version: 2,
      });
      expect(after.audits).toHaveLength(1);
      expect(after.audits[0]).toMatchObject({
        event: 'activity.publish',
        actorUserId: actor.id,
        context: { extra: { operation: 'settlement-submit' } },
      });
    },
  );

  it.each([
    { status: 'draft', biz: BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN },
    { status: 'cancelled', biz: BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN },
  ])('首次提交 $status 活动拒绝且活动、版本、结果、审计和意图不变', async ({ status, biz }) => {
    const f = await fixture(status);
    const before = await snapshot(f);
    await expect(submit(f)).rejects.toMatchObject({ biz });
    expect(await snapshot(f)).toEqual(before);
  });

  it('completed 的 working draft 可认定，修订和审计留前后值，不改版本号', async () => {
    const f = await fixture('completed');
    await edit(f);
    const after = await snapshot(f);
    expect(after.activity.statusCode).toBe('completed');
    expect(after.run.statusCode).toBe('drafting');
    expect(after.versions).toHaveLength(1);
    expect(after.versions[0]).toMatchObject({ id: f.draftId, version: 1, statusCode: 'draft' });
    expect(after.versions[0].resultRevisions).toHaveLength(1);
    expect(after.versions[0].resultRevisions[0].revision).toBe(1);
    expect(after.versions[0].resultRevisions[0].recognizedServiceHours.toString()).toBe('4');
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0].context).toMatchObject({
      before: { revision: 0, recognizedServiceHours: '2' },
      after: { revision: 1, recognizedServiceHours: '4' },
      extra: { operation: 'settlement-draft-item-update' },
    });
  });

  it.each(REVIEW_STATES)('%s 时禁止认定，草稿及已提交结果全部不变', async (statusCode) => {
    const f = await fixture('completed');
    await submit(f);
    await prisma.attendanceSettlementRun.update({ where: { id: f.runId }, data: { statusCode } });
    const before = await snapshot(f);
    await expect(edit(f)).rejects.toMatchObject({
      biz: BizCode.SETTLEMENT_DRAFT_UPDATE_RUN_STATUS_INVALID,
    });
    expect(await snapshot(f)).toEqual(before);
  });

  it('退回只允许修改 working draft，原提交版本的所有结果保持不变', async () => {
    const f = await fixture('completed');
    const result = await submit(f);
    const version = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: result.settlementVersionId },
    });
    await reviews.firstReview(
      {
        activityId: f.activityId,
        actionCode: 'return',
        operationKey: `return-${f.activityId}`,
        requestHash: 'return-state-hash',
        returnReason: '重新核实',
        expectation: {
          evidenceSealId: version.evidenceSealId,
          evidenceRevision: version.evidenceRevision,
          populationRevision: version.populationRevision,
          workflowRevision: version.workflowRevision,
          contentHash: version.contentHash,
        },
      },
      reviewer,
      META,
    );
    const before = await snapshot(f);
    await edit(f);
    const after = await snapshot(f);
    expect(after.versions[1]).toEqual(before.versions[1]);
    expect(after.versions[1].statusCode).toBe('returned');
    expect(after.versions[0].resultRevisions[0].revision).toBe(1);
    expect(after.versions[0].resultRevisions[0].recognizedServiceHours.toString()).toBe('4');
  });

  it.each(['drafting', ...REVIEW_STATES])(
    '%s 不重新开放旧删除，多个参与者及版本历史均保留',
    async (statusCode) => {
      const f = await fixture('completed', 2);
      if (statusCode !== 'drafting') {
        await submit(f);
        await prisma.attendanceSettlementRun.update({
          where: { id: f.runId },
          data: { statusCode },
        });
      }
      const before = await snapshot(f);
      for (const version of before.versions) {
        expect(version.resultRevisions).toHaveLength(2);
        expect(
          new Set(version.resultRevisions.map((row) => row.participationIdentityId)).size,
        ).toBe(2);
        await request(httpServer(app))
          .delete(`/api/admin/v1/attendance-sheets/${version.id}`)
          .set('Authorization', auth)
          .expect(404);
      }
      expect(await snapshot(f)).toEqual(before);
    },
  );
});
