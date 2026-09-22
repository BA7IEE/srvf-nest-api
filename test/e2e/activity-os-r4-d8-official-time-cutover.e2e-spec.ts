import { execFileSync } from 'node:child_process';
import { BindingScopeType, PrincipalType, Role, UserStatus } from '@prisma/client';
import request from 'supertest';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { ActivityParticipationQueryService } from '../../src/modules/activities/activity-participation-query.service';
import type { TimePolicyDefinition } from '../../src/modules/activities/activity-time-policy-definition';
import { ACTIVITY_TIME_CUTOVER_RECEIPT_ID } from '../../src/modules/activities/activity-time-cutover-command';
import { EvidenceSealService } from '../../src/modules/activities/evidence-seal.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { ParticipationTimeProofQueryService } from '../../src/modules/activities/participation-time-proof-query.service';
import { ParticipationTimeTruthQueryService } from '../../src/modules/activities/participation-time-truth-query.service';
import { SettlementDraftService } from '../../src/modules/activities/settlement-draft.service';
import { ParticipationSummaryQueryService } from '../../src/modules/attendances/participation-summary-query.service';
import { ParticipationOverviewQueryService } from '../../src/modules/meta/participation-overview-query.service';
import {
  D13_APP,
  closeD13Fixture,
  createD13ActivePolicy,
  createD13Draft,
  createD13Fixture,
  explicitTimePolicyChange,
  type D13Fixture,
} from '../helpers/activity-time-policy.fixture';
import { httpServer } from '../helpers/http-server';
import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';

const START = new Date('2020-03-01T08:00:00.000Z');
const END = new Date('2020-03-01T09:00:00.000Z');
const TRAINING_DEFINITION: TimePolicyDefinition = {
  defaultCategory: 'training',
  roleMappings: [],
  allowSplit: true,
  specialIntervals: {
    preparation: { mode: 'exclude' },
    duty: { mode: 'exclude' },
    travel: { mode: 'exclude' },
  },
  rounding: { mode: 'floor', quantumSeconds: 60 },
  evidence: { requiredSources: [], requireManualRecognition: false },
  manualAdjustment: { enabled: true, reasonRequired: true, evidenceRequired: false },
};

describe('D8-2 official participation time cutover', () => {
  let fixture: D13Fixture;
  let actor: CurrentUserPayload;
  const meta = { requestId: 'd8-2-official-time', ip: null, ua: null };
  const dedicatedW98 = process.env.SRVF_D8_2_W98 === '1';
  const previousV11 = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  const previousReadonly = process.env.ACTIVITY_WORKFLOW_READONLY;
  const originalEnvironment = {
    worker: process.env.JEST_WORKER_ID,
    databaseUrl: process.env.DATABASE_URL,
    storageRoot: process.env.STORAGE_LOCAL_ROOT,
  };

  beforeAll(() => {
    if (!dedicatedW98) return;
    process.env.JEST_WORKER_ID = '98';
    loadTestEnv();
    process.env.STORAGE_LOCAL_ROOT = './tmp/storage-w98';
    assertTestDatabaseUrl(process.env.DATABASE_URL);
    dropWorkerDatabase(98);
    execFileSync(
      'docker',
      ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
      { stdio: 'pipe' },
    );
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: process.env,
      stdio: 'pipe',
    });
  }, 120_000);

  beforeEach(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    process.env.ACTIVITY_WORKFLOW_READONLY = 'false';
    fixture = await createD13Fixture();
    actor = {
      id: fixture.creator.id,
      memberId: fixture.creator.memberId,
      username: 'd8-2-actor',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
    };
    const role = await fixture.db.rbacRole.create({
      data: { code: fixture.key('official_role'), displayName: 'D8-2 official read fixture' },
    });
    for (const code of [
      'activity.time-settlement.read',
      'activity.time-settlement.prepare',
      'activity.time-allocation.recognize',
      'activity.settlement-submit.record',
      'attendance.read.sheet',
      'activity-registration.read.record',
    ]) {
      const permission = await fixture.db.permission.upsert({
        where: { code },
        update: {},
        create: {
          code,
          module: 'activity',
          action: code.split('.').at(-1) ?? 'read',
          resourceType: 'activity',
        },
      });
      await fixture.db.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
    await fixture.db.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: actor.id,
        roleId: role.id,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: fixture.organizationId,
      },
    });
    await fixture.db.contributionRule.create({
      data: {
        activityTypeCode: 'event_support',
        attendanceRoleCode: 'service',
        pointsBelow: 2,
        status: 'ACTIVE',
      },
    });
  }, 120_000);

  afterEach(async () => {
    await closeD13Fixture(fixture);
    restoreEnvironment('ACTIVITY_V11_WORKFLOW_ENABLED', previousV11);
    restoreEnvironment('ACTIVITY_WORKFLOW_READONLY', previousReadonly);
  });

  afterAll(() => {
    if (!dedicatedW98) return;
    try {
      dropWorkerDatabase(98);
    } finally {
      restoreEnvironment('JEST_WORKER_ID', originalEnvironment.worker);
      restoreEnvironment('DATABASE_URL', originalEnvironment.databaseUrl);
      restoreEnvironment('STORAGE_LOCAL_ROOT', originalEnvironment.storageRoot);
    }
  }, 120_000);

  function restoreEnvironment(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  async function createSubmittedTrainingSource() {
    const draft = await createD13Draft(fixture, { withPosition: true });
    if (!draft.positionId) throw new Error('D8-2 position required');
    const pointer = await createD13ActivePolicy(fixture, TRAINING_DEFINITION, {
      effectiveFrom: '1900-01-01T00:00:00.000Z',
      effectiveUntil: '2101-01-01T00:00:00.000Z',
    });
    const selectionResponse = await request(httpServer(fixture.app))
      .patch(`${D13_APP}/${draft.activityId}/time-policy-selection`)
      .set('Authorization', fixture.creator.auth)
      .send({
        operationKey: fixture.key('selection'),
        expectedRevision: 0,
        changes: [
          explicitTimePolicyChange(pointer, {
            layerCode: 'activity',
            sessionId: null,
            positionId: null,
          }),
        ],
      })
      .expect(200);
    const selection = await fixture.db.activityTimePolicySelectionRevision.findUniqueOrThrow({
      where: { id: selectionResponse.body.data.selectionRevisionId as string },
    });
    await fixture.db.activity.update({
      where: { id: draft.activityId },
      data: { startAt: START, endAt: END, statusCode: 'published' },
    });
    await fixture.db.activitySession.update({
      where: { id: draft.sessionId },
      data: {
        startAt: START,
        endAt: END,
        checkInOpenAt: START,
        checkInCloseAt: END,
        checkOutOpenAt: START,
        checkOutCloseAt: END,
      },
    });
    await fixture.db.activitySessionPosition.update({
      where: { id: draft.positionId },
      data: { startAt: START, endAt: END },
    });
    await fixture.db.activityResponsibilityAssignment.create({
      data: {
        activityId: draft.activityId,
        memberId: fixture.creator.memberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: actor.id,
        source: 'publish',
      },
    });
    const review = await fixture.db.activityPublishReview.create({
      data: {
        activityId: draft.activityId,
        requestType: 'initial',
        requestVersion: 1,
        baseRevision: 0,
        status: 'approved',
        snapshot: {},
        directPublish: true,
        submittedByUserId: actor.id,
        submittedAt: START,
        reviewedByUserId: actor.id,
        reviewedAt: START,
      },
    });
    await fixture.db.activityRuleSnapshot.create({
      data: {
        activityId: draft.activityId,
        workflowRevision: 0,
        timePolicySelectionRevisionId: selection.id,
        resolvedConfig: {
          sessions: [
            {
              sessionId: draft.sessionId,
              positions: [{ positionId: draft.positionId, attendanceRoleCode: 'service' }],
            },
          ],
          timePolicyPointers: {
            selectionRevisionId: selection.id,
            selectionRevision: selection.revision,
            selectionHash: selection.selectionHash,
            selection: selection.selectionJson,
          },
        },
        snapshotHash: '3'.repeat(64),
        createdByReviewId: review.id,
        createdAt: new Date('2019-12-01T00:00:00.000Z'),
      },
    });
    const registration = await fixture.db.activityRegistration.create({
      data: {
        activityId: draft.activityId,
        memberId: fixture.creator.memberId,
        statusCode: 'pass',
      },
    });
    const identity = await fixture.db.activityParticipationIdentity.create({
      data: {
        activityId: draft.activityId,
        sessionId: draft.sessionId,
        registrationId: registration.id,
        memberId: fixture.creator.memberId,
        currentStatusCode: 'pass',
        currentPositionId: draft.positionId,
        populationIncluded: true,
      },
    });
    const events = [];
    for (const [eventTypeCode, occurredAt] of [
      ['check_in', START],
      ['check_out', END],
    ] as const) {
      events.push(
        await fixture.db.attendancePunchEvent.create({
          data: {
            activityId: draft.activityId,
            sessionId: draft.sessionId,
            positionId: draft.positionId,
            participationIdentityId: identity.id,
            memberId: fixture.creator.memberId,
            eventTypeCode,
            sourceCode: 'self_qr',
            occurredAt,
            receivedAt: occurredAt,
            operatorUserId: actor.id,
            eventKey: fixture.key(eventTypeCode),
            requestHash: '4'.repeat(64),
            evidenceRevision: 0,
          },
        }),
      );
    }
    const source = await fixture.db.participantServiceSegmentRevision.create({
      data: {
        participationIdentityId: identity.id,
        segmentKey: '0001',
        revision: 1,
        sourceCheckInEventId: events[0].id,
        sourceCloseEventId: events[1].id,
        resultCode: 'valid',
        statusCode: 'draft',
        checkInAt: START,
        checkOutAt: END,
        serviceHours: 1,
      },
    });
    await fixture.app.get(EvidenceSealService).seal(draft.activityId, actor, meta);
    const generated = await fixture.app
      .get(SettlementDraftService)
      .generate(draft.activityId, actor, meta);
    const seal = await fixture.db.evidenceSeal.findUniqueOrThrow({
      where: { id: generated.evidenceSealId },
    });
    const proof = {
      expectedDraftVersion: generated.settlementVersion,
      expectedEvidenceSealId: seal.id,
      expectedEvidenceRevision: seal.evidenceRevision,
      expectedPopulationRevision: seal.populationRevision,
      expectedWorkflowRevision: seal.workflowRevision,
    };
    const url = `${D13_APP}/${draft.activityId}/time-settlement`;
    const post = async (path: string, payload: object) => {
      const response = await request(httpServer(fixture.app))
        .post(path)
        .set('Authorization', fixture.creator.auth)
        .send(payload)
        .expect(200);
      expect(response.body).toMatchObject({ code: 0 });
      return response.body.data;
    };
    await post(`${url}/allocations`, {
      ...proof,
      operationKey: fixture.key('recognize'),
      sourceSegmentId: source.id,
      expectedRevision: 0,
      recognitionModeCode: 'automatic',
      evidenceAttachmentIds: [],
    });
    const prepared = await post(`${url}/prepare`, {
      operationKey: fixture.key('prepare'),
      expectedDraftVersion: proof.expectedDraftVersion,
      expectedEvidenceSealId: proof.expectedEvidenceSealId,
      expectedTimeRevision: 0,
    });
    const submitted = await post(`${url}/submit`, {
      operationKey: fixture.key('submit'),
      expectedDraftVersion: proof.expectedDraftVersion,
      expectedEvidenceSealId: proof.expectedEvidenceSealId,
      timeRevisionId: prepared.timeRevisionId,
      expectedBucketContentHash: prepared.bucketContentHash,
    });
    const timeRevision = await fixture.db.activitySettlementTimeRevision.findUniqueOrThrow({
      where: { id: submitted.timeRevisionId as string },
    });
    return { draft, identity, timeRevision };
  }

  async function insertCutoverReceipt(): Promise<void> {
    await fixture.db.$queryRaw`
      INSERT INTO "ActivityTimeCutoverReceipt" (
        id, "operationKey", "requestHash", "deployedMainSha",
        "evidenceBundleHash", "actorUserId", "contentHash"
      ) VALUES (
        ${ACTIVITY_TIME_CUTOVER_RECEIPT_ID}, ${fixture.key('cutover')}, ${'5'.repeat(64)},
        ${'6'.repeat(40)}, ${'7'.repeat(64)}, ${actor.id}, ${'0'.repeat(64)}
      )
    `;
  }

  async function commitClassifiedRoot(
    timeRevision: Awaited<ReturnType<typeof createSubmittedTrainingSource>>['timeRevision'],
  ): Promise<void> {
    const finalActor: CurrentUserPayload = {
      id: fixture.reviewer.id,
      memberId: fixture.reviewer.memberId,
      username: 'd8-2-final-reviewer',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
    };
    const permission = await fixture.db.permission.upsert({
      where: { code: 'activity.settlement-final-review.record' },
      update: {},
      create: {
        code: 'activity.settlement-final-review.record',
        module: 'activity',
        action: 'record',
        resourceType: 'settlement-final-review',
      },
    });
    const role = await fixture.db.rbacRole.create({
      data: { code: fixture.key('final_role'), displayName: 'D8-2 final reviewer' },
    });
    await fixture.db.rolePermission.create({
      data: { roleId: role.id, permissionId: permission.id },
    });
    await fixture.db.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: finalActor.id,
        roleId: role.id,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: fixture.organizationId,
      },
    });
    await fixture.db.settlementReviewAction.create({
      data: {
        settlementVersionId: timeRevision.settlementVersionId,
        stageCode: 'final',
        actionCode: 'approve',
        actorUserId: finalActor.id,
        actedAt: END,
        operationKey: fixture.key('final_review'),
      },
    });
    await fixture.db.attendanceSettlementVersion.update({
      where: { id: timeRevision.settlementVersionId },
      data: { statusCode: 'approved' },
    });
    await fixture.db.attendanceSettlementRun.update({
      where: { id: timeRevision.settlementRunId },
      data: { statusCode: 'posting' },
    });
    const batch = await fixture.db.ledgerPostingBatch.create({
      data: {
        settlementRunId: timeRevision.settlementRunId,
        settlementVersionId: timeRevision.settlementVersionId,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: fixture.key('classified_batch'),
        totalCount: 1,
        preparedByUserId: finalActor.id,
      },
    });
    const preparation = fixture.app.get(LedgerPreparationService);
    const job = await preparation.ensurePrepareJob(batch.id);
    const items = await fixture.db.activityBatchJobItem.findMany({
      where: { jobId: job.jobId },
      orderBy: { itemKey: 'asc' },
    });
    expect(items).toHaveLength(1);
    for (const item of items) await preparation.prepareChunk(job.jobId, item.id);
    await expect(preparation.finalize(job.jobId)).resolves.toMatchObject({ batchStatus: 'ready' });
    await expect(
      fixture.app
        .get(LedgerPostingService)
        .commitBatch(
          { postingBatchId: batch.id, operationKey: fixture.key('commit') },
          finalActor,
          meta,
        ),
    ).resolves.toMatchObject({ batchStatus: 'committed', replayed: false });
  }

  it('one real classified root drives proof, member/activity/month totals and exact-seconds histogram', async () => {
    const source = await createSubmittedTrainingSource();
    await insertCutoverReceipt();
    await commitClassifiedRoot(source.timeRevision);
    await fixture.db.activity.update({
      where: { id: source.draft.activityId },
      data: { statusCode: 'completed' },
    });
    const sheet = await fixture.db.attendanceSheet.create({
      data: {
        activityId: source.draft.activityId,
        submitterUserId: actor.id,
        statusCode: 'approved',
      },
    });
    await fixture.db.attendanceRecord.create({
      data: {
        sheetId: sheet.id,
        memberId: fixture.creator.memberId,
        roleCode: 'service',
        checkInAt: START,
        checkOutAt: END,
        serviceHours: 9,
        attendanceStatusCode: 'present',
        contributionPoints: 1,
      },
    });

    const proof = await fixture.app
      .get(ParticipationTimeProofQueryService)
      .forAdminMember(
        fixture.creator.memberId,
        { dateFrom: '2020-01-01', dateTo: '2020-12-31', page: 1, pageSize: 100 },
        actor,
      );
    expect(proof).toMatchObject({
      trainingSeconds: 3_600,
      eligibleServiceSeconds: 0,
      total: 1,
    });

    const official = await fixture.db.$transaction((tx) =>
      fixture.app.get(ParticipationTimeTruthQueryService).readOfficialTotalsInTx(tx, {
        activityIds: [source.draft.activityId],
      }),
    );
    expect(official?.totals).toEqual([
      {
        activityId: source.draft.activityId,
        memberId: fixture.creator.memberId,
        eligibleSeconds: 0,
      },
    ]);

    const memberSummary = await fixture.app
      .get(ParticipationSummaryQueryService)
      .forMemberAdmin(fixture.creator.memberId, actor);
    expect(memberSummary).toMatchObject({
      totalServiceHours: '0',
      activityCount: 1,
      recordCount: 1,
      contributionPoints: '1',
    });

    const activityQuery = fixture.app.get(ActivityParticipationQueryService);
    const activitySummary = await activityQuery.participationSummary(
      source.draft.activityId,
      actor,
    );
    expect(activitySummary.totalServiceHours).toBe('0');
    expect(activitySummary.durationHistogram).toEqual({
      under2Hours: 1,
      from2To4Hours: 0,
      from4To8Hours: 0,
      atLeast8Hours: 0,
    });
    expect(activitySummary.attendeeCount).toBe(1);

    const reconciliation = await activityQuery.reconciliation(source.draft.activityId, actor);
    expect(reconciliation.registeredParticipants).toEqual([
      expect.objectContaining({
        memberId: fixture.creator.memberId,
        recordCount: 1,
        approvedRecordCount: 1,
        totalServiceHours: '0',
      }),
    ]);

    const overview = await fixture.app.get(ParticipationOverviewQueryService).getOverview(
      {
        organizationId: fixture.organizationId,
        dateFrom: '2020-03-01T00:00:00.000Z',
        dateTo: '2020-03-31T23:59:59.999Z',
      },
      actor,
    );
    expect(overview.months).toEqual([
      expect.objectContaining({
        month: '2020-03',
        totalServiceHours: '0',
        participationCount: 1,
        durationHistogram: {
          under2Hours: 1,
          from2To4Hours: 0,
          from4To8Hours: 0,
          atLeast8Hours: 0,
        },
      }),
    ]);
  }, 120_000);
});
