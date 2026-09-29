import { execFileSync } from 'node:child_process';
import {
  BindingScopeType,
  BindingStatus,
  MemberStatus,
  PrincipalType,
  Role,
  UserStatus,
} from '@prisma/client';
import request from 'supertest';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { EvidenceSealService } from '../../src/modules/activities/evidence-seal.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { SettlementDraftService } from '../../src/modules/activities/settlement-draft.service';
import type { TimePolicyDefinition } from '../../src/modules/activities/activity-time-policy-definition';
import { ACTIVITY_TIME_CUTOVER_RECEIPT_ID } from '../../src/modules/activities/activity-time-cutover-command';
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
const DEFINITION: TimePolicyDefinition = {
  defaultCategory: 'volunteer_service',
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

describe('D8-1 formal participation time proof', () => {
  let fixture: D13Fixture;
  let actor: CurrentUserPayload;
  let reviewerProofBindingId: string;
  let proofReadRoleId: string;
  const meta = { requestId: 'd8-proof', ip: null, ua: null };
  const dedicatedW98 = process.env.SRVF_D8_1_W98 === '1';
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
      username: 'd8-proof-actor',
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
    };
    const codes = [
      'activity.time-settlement.read',
      'activity.time-settlement.prepare',
      'activity.time-allocation.recognize',
      'activity.settlement-submit.record',
      'attendance.read.sheet',
    ];
    const role = await fixture.db.rbacRole.create({
      data: { code: fixture.key('time_role'), displayName: 'D8-1 proof fixture' },
    });
    proofReadRoleId = role.id;
    for (const code of codes) {
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
    reviewerProofBindingId = (
      await fixture.db.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: fixture.reviewer.id,
          roleId: role.id,
          scopeType: BindingScopeType.ORGANIZATION,
          scopeOrgId: fixture.organizationId,
        },
      })
    ).id;
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

  async function post(url: string, payload: object) {
    const response = await request(httpServer(fixture.app))
      .post(url)
      .set('Authorization', fixture.creator.auth)
      .send(payload)
      .expect(200);
    expect(response.body).toMatchObject({ code: 0 });
    return response.body.data;
  }

  async function createLegacyLedgerFact(): Promise<void> {
    const draft = await createD13Draft(fixture);
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
        populationIncluded: true,
      },
    });
    const seal = await fixture.db.evidenceSeal.create({
      data: {
        activityId: draft.activityId,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: END,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 1,
        populationCountBySession: { [draft.sessionId]: 1 },
        contentHash: '1'.repeat(64),
        statusCode: 'active',
        sealedByUserId: actor.id,
        sealedAt: END,
      },
    });
    const run = await fixture.db.attendanceSettlementRun.create({
      data: { activityId: draft.activityId, statusCode: 'posting' },
    });
    const version = await fixture.db.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: '2'.repeat(64),
        personCount: 1,
        sessionParticipationCount: 1,
        serviceSegmentCount: 1,
        createdByUserId: actor.id,
        statusCode: 'approved',
      },
    });
    const result = await fixture.db.participantSettlementResultRevision.create({
      data: {
        settlementVersionId: version.id,
        participationIdentityId: identity.id,
        revision: 1,
        resultCode: 'present',
        recognizedServiceHours: 1,
        recognizedContributionPoints: 0,
        calculatedServiceHours: 1,
        calculatedContributionPoints: 0,
        statusCode: 'committed',
      },
    });
    const batch = await fixture.db.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'committed',
        requestKey: fixture.key('legacy_batch'),
        totalCount: 1,
        preparedCount: 1,
        committedAt: END,
        committedByUserId: actor.id,
      },
    });
    await fixture.db.participationLedgerEntry.create({
      data: {
        postingBatchId: batch.id,
        entryKey: fixture.key('legacy_entry'),
        operationKey: fixture.key('legacy_operation'),
        memberId: fixture.creator.memberId,
        activityId: draft.activityId,
        sessionId: draft.sessionId,
        participationIdentityId: identity.id,
        resultRevisionId: result.id,
        ledgerDate: new Date('2020-03-02T00:00:00.000Z'),
        entryTypeCode: 'service_credit',
        serviceHoursDelta: 1,
        recognizedPointsDelta: 0,
        creditedPointsDelta: 0,
        cappedOutPointsDelta: 0,
      },
    });
  }

  async function createSubmittedClassifiedSource() {
    const draft = await createD13Draft(fixture, { withPosition: true });
    if (!draft.positionId) throw new Error('D8 classified position required');
    const pointer = await createD13ActivePolicy(fixture, DEFINITION, {
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
    return fixture.db.activitySettlementTimeRevision.findUniqueOrThrow({
      where: { id: submitted.timeRevisionId as string },
    });
  }

  async function insertCutoverReceipt(): Promise<void> {
    const rows = await fixture.db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "ActivityTimeCutoverReceipt" (
        id, "operationKey", "requestHash", "deployedMainSha",
        "evidenceBundleHash", "actorUserId", "contentHash"
      ) VALUES (
        ${ACTIVITY_TIME_CUTOVER_RECEIPT_ID}, ${fixture.key('cutover')}, ${'5'.repeat(64)},
        ${'6'.repeat(40)}, ${'7'.repeat(64)}, ${actor.id}, ${'0'.repeat(64)}
      ) RETURNING id
    `;
    expect(rows).toEqual([{ id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID }]);
  }

  async function commitClassifiedRoot(
    timeRevision: Awaited<ReturnType<typeof createSubmittedClassifiedSource>>,
  ): Promise<void> {
    const finalActor: CurrentUserPayload = {
      id: fixture.reviewer.id,
      memberId: fixture.reviewer.memberId,
      username: 'd8-final-reviewer',
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
      data: { code: fixture.key('final_role'), displayName: 'D8 final reviewer' },
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
    const manifest = await fixture.db.participationTimeLedgerManifest.findUniqueOrThrow({
      where: { postingBatchId: batch.id },
    });
    await expect(
      fixture.db.participationTimeCutoverBinding.findUniqueOrThrow({
        where: { rootManifestId: manifest.id },
      }),
    ).resolves.toMatchObject({
      cutoverReceiptId: ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
      rootContentHash: manifest.contentHash,
    });
  }

  it('fails closed before cutover, then returns stable mixed legacy/classified proof on both surfaces', async () => {
    const appUrl = '/api/app/v1/my/participation-time-proof';
    const query = { dateFrom: '2020-01-01', dateTo: '2020-12-31', page: 1, pageSize: 1 };
    await request(httpServer(fixture.app))
      .get(appUrl)
      .query(query)
      .set('Authorization', fixture.creator.auth)
      .expect(503)
      .expect(({ body }) => expect(body).toMatchObject({ code: 20235 }));

    await createLegacyLedgerFact();
    const timeRevision = await createSubmittedClassifiedSource();
    await insertCutoverReceipt();
    await commitClassifiedRoot(timeRevision);

    const first = await request(httpServer(fixture.app))
      .get(appUrl)
      .query(query)
      .set('Authorization', fixture.creator.auth);
    expect({ status: first.status, code: first.body.code, message: first.body.message }).toEqual({
      status: 200,
      code: 0,
      message: expect.any(String),
    });
    expect(first.body.data).toMatchObject({
      proofVersion: 1,
      cutoverReceiptId: ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
      memberId: fixture.creator.memberId,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      legacyRecognizedSeconds: 3600,
      volunteerServiceSeconds: 3600,
      eligibleServiceSeconds: 7200,
      total: 2,
      page: 1,
      pageSize: 1,
      isPubliclyVerifiable: false,
      provenance: 'database_cutover_root_binding_v1',
      items: [{ sourceMode: 'classified_time_ledger', sourceCategoryCode: 'volunteer_service' }],
    });
    expect(first.body.data.proofSetHash).toMatch(/^[a-f0-9]{64}$/u);

    const second = await request(httpServer(fixture.app))
      .get(appUrl)
      .query({ ...query, page: 2 })
      .set('Authorization', fixture.creator.auth)
      .expect(200);
    expect(second.body.data).toMatchObject({
      proofSetHash: first.body.data.proofSetHash,
      total: 2,
      page: 2,
      items: [{ sourceMode: 'legacy_ledger', sourceCategoryCode: 'legacy_recognized_service' }],
    });

    const admin = await request(httpServer(fixture.app))
      .get(`/api/admin/v1/members/${fixture.creator.memberId}/participation-time-proof`)
      .query({ ...query, pageSize: 100 })
      .set('Authorization', fixture.creator.auth)
      .expect(200);
    expect(admin.body.data).toMatchObject({
      proofSetHash: first.body.data.proofSetHash,
      eligibleServiceSeconds: 7200,
      total: 2,
    });

    const scopedCrossMember = await request(httpServer(fixture.app))
      .get(`/api/admin/v1/members/${fixture.creator.memberId}/participation-time-proof`)
      .query({ ...query, pageSize: 100 })
      .set('Authorization', fixture.reviewer.auth)
      .expect(200);
    expect(scopedCrossMember.body.data).toMatchObject({
      memberId: fixture.creator.memberId,
      proofSetHash: first.body.data.proofSetHash,
    });

    await fixture.db.roleBinding.update({
      where: { id: reviewerProofBindingId },
      data: { status: BindingStatus.SUSPENDED },
    });
    await request(httpServer(fixture.app))
      .get(`/api/admin/v1/members/${fixture.creator.memberId}/participation-time-proof`)
      .query({ ...query, pageSize: 100 })
      .set('Authorization', fixture.reviewer.auth)
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ code: 30100 }));

    await fixture.db.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: fixture.reviewer.id,
        roleId: proofReadRoleId,
        scopeType: BindingScopeType.GLOBAL,
      },
    });
    const globalFallback = await request(httpServer(fixture.app))
      .get(`/api/admin/v1/members/${fixture.creator.memberId}/participation-time-proof`)
      .query({ ...query, pageSize: 100 })
      .set('Authorization', fixture.reviewer.auth)
      .expect(200);
    expect(globalFallback.body.data).toMatchObject({
      memberId: fixture.creator.memberId,
      proofSetHash: first.body.data.proofSetHash,
    });

    await request(httpServer(fixture.app))
      .get(appUrl)
      .query({ dateFrom: '2020-01-01', dateTo: '2021-01-01', page: 1, pageSize: 20 })
      .set('Authorization', fixture.creator.auth)
      .expect(400)
      .expect(({ body }) => expect(body).toMatchObject({ code: 20238 }));

    await fixture.db.member.update({
      where: { id: fixture.creator.memberId },
      data: { status: MemberStatus.INACTIVE },
    });
    await request(httpServer(fixture.app))
      .get(appUrl)
      .query(query)
      .set('Authorization', fixture.creator.auth)
      .expect(403);
  }, 120_000);
});
