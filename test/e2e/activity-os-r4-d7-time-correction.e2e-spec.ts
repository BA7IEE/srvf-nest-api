import {
  BindingScopeType,
  PrincipalType,
  Role,
  UserStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { ParticipationTimeLedgerAccessService } from '../../src/modules/activities/participation-time-ledger-access.service';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import {
  activityTimeAllocationRequestHash,
  buildActivityTimeAllocationManifest,
  type ActivityTimeAllocationCommand,
  type ActivityTimeAllocationSliceInput,
} from '../../src/modules/activities/activity-time-allocation-command';
import { ActivityTimeAllocationService } from '../../src/modules/activities/activity-time-allocation.service';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import { CorrectionAuditRecorder } from '../../src/modules/activities/correction-audit-recorder';
import { CorrectionTimeAllocationService } from '../../src/modules/activities/correction-time-allocation.service';
import { ParticipationTimeCorrectionService } from '../../src/modules/activities/participation-time-correction.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerReadyBatchCommitter } from '../../src/modules/activities/ledger-ready-batch-committer.service';
import { EvidenceSealService } from '../../src/modules/activities/evidence-seal.service';
import {
  SettlementDraftService,
  type SettlementDraftResult,
} from '../../src/modules/activities/settlement-draft.service';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import type { TimePolicyDefinition } from '../../src/modules/activities/activity-time-policy-definition';
import {
  D13_APP,
  createD13Fixture,
  closeD13Fixture,
  createD13Draft,
  createD13ActivePolicy,
  explicitTimePolicyChange,
  type D13Fixture,
} from '../helpers/activity-time-policy.fixture';
import { httpServer } from '../helpers/http-server';
import { loadTestEnv } from '../setup/load-env';
import { assertTestDatabaseUrl, dropWorkerDatabase } from '../setup/test-db';
import { deriveTestDbName } from '../setup/worktree-db';
const START = new Date('2020-03-01T08:00:00.000Z');
const END = new Date('2020-03-01T09:00:00.000Z');
const WORKER = 98;
const USE_DEDICATED_W98 = process.env.SRVF_D7_2_W98 === '1';
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

describe('D7-1 recognition correction real transaction', () => {
  let f: D13Fixture;
  let actor: CurrentUserPayload;
  const meta = { requestId: 'd5-e2e', ip: null, ua: null };
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  const originalEnvironment = {
    worker: process.env.JEST_WORKER_ID,
    databaseUrl: process.env.DATABASE_URL,
    storageRoot: process.env.STORAGE_LOCAL_ROOT,
  };
  beforeAll(() => {
    // Direct maintenance validation uses only the approved w98 clone. CI keeps
    // its assigned worker and its existing lifecycle unchanged.
    if (USE_DEDICATED_W98) {
      process.env.JEST_WORKER_ID = String(WORKER);
      loadTestEnv();
      process.env.STORAGE_LOCAL_ROOT = `./tmp/storage-w${WORKER}`;
      assertTestDatabaseUrl(process.env.DATABASE_URL);
      dropWorkerDatabase(WORKER);
      execFileSync(
        'docker',
        ['exec', 'u-nest-api-postgres', 'createdb', '-U', 'postgres', deriveTestDbName()],
        { stdio: 'pipe' },
      );
      execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
        env: process.env,
        stdio: 'pipe',
      });
    }
    assertTestDatabaseUrl(process.env.DATABASE_URL);
  }, 120000);
  beforeEach(async () => {
    // Test-process configuration only. Never changes an application instance or deployment Gate.
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    f = await createD13Fixture();
    actor = {
      id: f.creator.id,
      memberId: f.creator.memberId,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      username: 'd4-fixture',
    };
    const codes = [
      'activity.time-settlement.read',
      'activity.time-settlement.prepare',
      'activity.time-allocation.recognize',
      'activity.settlement-submit.record',
    ];
    const role = await f.db.rbacRole.create({
      data: { code: f.key('d4_role'), displayName: 'D4 explicit fixture' },
    });
    for (const code of codes) {
      const permission = await f.db.permission.upsert({
        where: { code },
        update: {},
        create: {
          code,
          module: 'activity',
          action: code.split('.')[1],
          resourceType: code.split('.')[2],
        },
      });
      await f.db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
    await f.db.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: actor.id,
        roleId: role.id,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: f.organizationId,
      },
    });
    await f.db.contributionRule.create({
      data: {
        activityTypeCode: 'event_support',
        attendanceRoleCode: 'service',
        pointsBelow: 2,
        status: 'ACTIVE',
      },
    });
  }, 120000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await closeD13Fixture(f);
    if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
  });
  afterAll(() => {
    if (!USE_DEDICATED_W98) return;
    try {
      dropWorkerDatabase(WORKER);
    } finally {
      restoreEnvironment('JEST_WORKER_ID', originalEnvironment.worker);
      restoreEnvironment('DATABASE_URL', originalEnvironment.databaseUrl);
      restoreEnvironment('STORAGE_LOCAL_ROOT', originalEnvironment.storageRoot);
    }
  }, 120000);

  function restoreEnvironment(name: string, value: string | undefined) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  async function prepareSource(
    options: {
      noEvents?: boolean;
      definition?: TimePolicyDefinition;
      batch?: boolean;
      beforeSeal?: (draft: {
        activityId: string;
        sessionId: string;
        positionId: string;
      }) => Promise<void>;
    } = {},
  ) {
    const draft = await createD13Draft(f, { withPosition: true });
    if (!draft.positionId) throw new Error('source position required');
    const pointer = await createD13ActivePolicy(f, options.definition ?? DEFINITION, {
      effectiveFrom: '1900-01-01T00:00:00.000Z',
      effectiveUntil: '2101-01-01T00:00:00.000Z',
    });
    const selectionResponse = await request(httpServer(f.app))
      .patch(`${D13_APP}/${draft.activityId}/time-policy-selection`)
      .set('Authorization', f.creator.auth)
      .send({
        operationKey: f.key('selection'),
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
    const selection = await f.db.activityTimePolicySelectionRevision.findUniqueOrThrow({
      where: { id: selectionResponse.body.data.selectionRevisionId as string },
    });
    // Keep creation HTTP's future-time checks; afterwards construct a fixed historical event fixture.
    await f.db.activity.update({
      where: { id: draft.activityId },
      data: { startAt: START, endAt: END, statusCode: 'published' },
    });
    await f.db.activitySession.update({
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
    await f.db.activitySessionPosition.update({
      where: { id: draft.positionId },
      data: { startAt: START, endAt: END },
    });
    await f.db.activityResponsibilityAssignment.create({
      data: {
        activityId: draft.activityId,
        memberId: f.creator.memberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: actor.id,
        source: 'publish',
      },
    });
    const review = await f.db.activityPublishReview.create({
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
    await f.db.activityRuleSnapshot.create({
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
        snapshotHash: 'a'.repeat(64),
        createdByReviewId: review.id,
        createdAt: new Date('2019-12-01T00:00:00.000Z'),
      },
    });
    const registration = await f.db.activityRegistration.create({
      data: { activityId: draft.activityId, memberId: f.creator.memberId, statusCode: 'pass' },
    });
    const identity = await f.db.activityParticipationIdentity.create({
      data: {
        activityId: draft.activityId,
        sessionId: draft.sessionId,
        registrationId: registration.id,
        memberId: f.creator.memberId,
        currentStatusCode: 'pass',
        currentPositionId: draft.positionId,
        populationIncluded: true,
      },
    });
    if (!options.noEvents) {
      const eventIds: string[] = [];
      for (const [type, at] of [
        ['check_in', START],
        ['check_out', END],
      ] as const) {
        const event = await f.db.attendancePunchEvent.create({
          data: {
            activityId: draft.activityId,
            sessionId: draft.sessionId,
            positionId: draft.positionId,
            participationIdentityId: identity.id,
            memberId: f.creator.memberId,
            eventTypeCode: type,
            sourceCode: 'self_qr',
            occurredAt: at,
            receivedAt: at,
            operatorUserId: actor.id,
            eventKey: f.key(type),
            requestHash: 'b'.repeat(64),
            evidenceRevision: 0,
          },
        });
        eventIds.push(event.id);
      }
      await f.db.participantServiceSegmentRevision.create({
        data: {
          participationIdentityId: identity.id,
          segmentKey: '0001',
          revision: 1,
          sourceCheckInEventId: eventIds[0],
          sourceCloseEventId: eventIds[1],
          resultCode: 'valid',
          statusCode: 'draft',
          checkInAt: START,
          checkOutAt: END,
          serviceHours: 1,
          lateFlag: false,
          earlyLeaveFlag: false,
        },
      });
    }
    await options.beforeSeal?.({ ...draft, positionId: draft.positionId });
    await f.app.get(EvidenceSealService).seal(draft.activityId, actor, meta);
    let generated: Pick<
      SettlementDraftResult,
      | 'settlementRunId'
      | 'settlementVersionId'
      | 'settlementVersion'
      | 'evidenceSealId'
      | 'contentHash'
      | 'blockedItemCount'
    >;
    if (options.batch) {
      const response = await post(`${D13_APP}/${draft.activityId}/settlement/generate`, {
        operationKey: f.key('capacity_generate'),
      });
      expect(response.outcome).toBe('job');
      const processed = await f.app.get(ActivityBatchWorker).drainOnce();
      expect(processed).toMatchObject({ jobId: response.jobId, itemsProcessed: 1, itemsFailed: 0 });
      const job = await f.db.activityBatchJob.findUniqueOrThrow({
        where: { id: response.jobId as string },
      });
      expect({ status: job.statusCode, error: job.lastErrorCode }).toEqual({
        status: 'succeeded',
        error: null,
      });
      if (!job.settlementVersionId) throw new Error('batch draft result required');
      const version = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: job.settlementVersionId },
      });
      const resolved = await f.db.participantSettlementResultRevision.count({
        where: { settlementVersionId: version.id, exceptionFlagsJson: { equals: Prisma.DbNull } },
      });
      generated = {
        settlementRunId: version.settlementRunId,
        settlementVersionId: version.id,
        settlementVersion: version.version,
        evidenceSealId: version.evidenceSealId,
        contentHash: version.contentHash,
        blockedItemCount: version.sessionParticipationCount - resolved,
      };
    } else
      generated = await f.app.get(SettlementDraftService).generate(draft.activityId, actor, meta);
    if (options.noEvents) {
      await f.app.get(SettlementDraftService).updateItem({
        activityId: draft.activityId,
        participationIdentityId: identity.id,
        expectedDraftVersion: generated.settlementVersion,
        resultCode: 'absent',
        recognizedServiceHours: 0,
        recognizedContributionPoints: 0,
        reason: '明确无参与证据',
      });
      const version = await f.db.attendanceSettlementVersion.findFirstOrThrow({
        where: { settlementRunId: generated.settlementRunId, statusCode: 'draft' },
        orderBy: { version: 'desc' },
      });
      generated = {
        ...generated,
        settlementVersion: version.version,
        settlementVersionId: version.id,
        contentHash: version.contentHash,
      };
    } else expect(generated.blockedItemCount).toBe(0);
    const seal = await f.db.evidenceSeal.findUniqueOrThrow({
      where: { id: generated.evidenceSealId },
    });
    const source = await f.db.participantServiceSegmentRevision.findFirst({
      where: { participationIdentityId: identity.id, statusCode: 'draft' },
    });
    const proof = {
      expectedDraftVersion: generated.settlementVersion,
      expectedEvidenceSealId: seal.id,
      expectedEvidenceRevision: seal.evidenceRevision,
      expectedPopulationRevision: seal.populationRevision,
      expectedWorkflowRevision: seal.workflowRevision,
    };
    return {
      ...draft,
      identityId: identity.id,
      source,
      generated,
      proof,
      url: `${D13_APP}/${draft.activityId}/time-settlement`,
    };
  }

  async function post(url: string, payload: object) {
    const response = await request(httpServer(f.app))
      .post(url)
      .set('Authorization', f.creator.auth)
      .send(payload);
    expect({
      status: response.status,
      code: response.body.code,
      message: response.body.message,
    }).toEqual({ status: 200, code: 0, message: expect.any(String) });
    return response.body.data;
  }
  function prepareCommand(p: Awaited<ReturnType<typeof prepareSource>>, expectedTimeRevision = 0) {
    return {
      operationKey: f.key('prepare'),
      expectedDraftVersion: p.proof.expectedDraftVersion,
      expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
      expectedTimeRevision,
    };
  }
  async function recognize(p: Awaited<ReturnType<typeof prepareSource>>) {
    if (!p.source) throw new Error('expected source');
    return post(`${p.url}/allocations`, {
      ...p.proof,
      operationKey: f.key('recognize'),
      sourceSegmentId: p.source.id,
      expectedRevision: 0,
      recognitionModeCode: 'automatic',
      evidenceAttachmentIds: [],
    });
  }

  async function createCapacitySource(population: number) {
    const sources: Array<{
      id: string;
      identityId: string;
      memberId: string;
      segmentKey: string;
      revision: number;
      start: Date;
      end: Date;
    }> = [];
    const p = await prepareSource({
      batch: population === 2000,
      beforeSeal: async (draft) => {
        // All evidence exists BEFORE the real seal and legacy draft generation.
        for (let offset = 0; offset < population - 1; offset += 100) {
          const people = Array.from({ length: Math.min(100, population - 1 - offset) }, (_, i) => ({
            index: offset + i,
            memberId: f.key('capacity_member'),
            registrationId: f.key('capacity_registration'),
            identityId: f.key('capacity_identity'),
          }));
          const events: Prisma.AttendancePunchEventCreateManyInput[] = [];
          const segments: Prisma.ParticipantServiceSegmentRevisionCreateManyInput[] = [];
          for (const person of people) {
            for (let j = 0; j < (person.index === 0 ? 9 : 5); j++) {
              // Distinct instants avoid relying on random event IDs to order close/open ties.
              const start = new Date(START.getTime() + j * 60001);
              const end = new Date(start.getTime() + 60000);
              const eventIds = [f.key('capacity_in'), f.key('capacity_out')];
              for (const [k, at] of [start, end].entries())
                events.push({
                  id: eventIds[k],
                  activityId: draft.activityId,
                  sessionId: draft.sessionId,
                  positionId: draft.positionId,
                  participationIdentityId: person.identityId,
                  memberId: person.memberId,
                  eventTypeCode: k === 0 ? 'check_in' : 'check_out',
                  sourceCode: 'self_qr',
                  occurredAt: at,
                  receivedAt: at,
                  operatorUserId: actor.id,
                  eventKey: f.key('capacity_event'),
                  requestHash: 'b'.repeat(64),
                  evidenceRevision: 0,
                });
              const source = {
                id: f.key('capacity_segment'),
                identityId: person.identityId,
                memberId: person.memberId,
                segmentKey: String(j + 1).padStart(4, '0'),
                revision: 1,
                start,
                end,
              };
              sources.push(source);
              segments.push({
                id: source.id,
                participationIdentityId: person.identityId,
                segmentKey: source.segmentKey,
                revision: 1,
                sourceCheckInEventId: eventIds[0],
                sourceCloseEventId: eventIds[1],
                resultCode: 'valid',
                statusCode: 'draft',
                checkInAt: start,
                checkOutAt: end,
                serviceHours: 0.02,
                lateFlag: false,
                earlyLeaveFlag: false,
              });
            }
          }
          await f.db.$transaction(
            async (tx) => {
              await tx.member.createMany({
                data: people.map((person) => ({
                  id: person.memberId,
                  memberNo: person.memberId,
                  ...memberIdentityData('D4 capacity fixture'),
                })),
              });
              await tx.activityRegistration.createMany({
                data: people.map((person) => ({
                  id: person.registrationId,
                  activityId: draft.activityId,
                  memberId: person.memberId,
                  statusCode: 'pass',
                })),
              });
              await tx.activityParticipationIdentity.createMany({
                data: people.map((person) => ({
                  id: person.identityId,
                  activityId: draft.activityId,
                  sessionId: draft.sessionId,
                  registrationId: person.registrationId,
                  memberId: person.memberId,
                  currentStatusCode: 'pass',
                  populationIncluded: true,
                  currentPositionId: draft.positionId,
                })),
              });
              await tx.attendancePunchEvent.createMany({ data: events });
              await tx.participantServiceSegmentRevision.createMany({ data: segments });
            },
            { timeout: 30000 },
          );
        }
      },
    });
    if (!p.source) throw new Error('capacity source required');
    // Generation may supersede pre-seal fixture rows; use its actual current truth, never stale IDs.
    const currentSources = await f.db.participantServiceSegmentRevision.findMany({
      where: {
        identity: { activityId: p.activityId },
        statusCode: 'draft',
        participationIdentityId: { not: p.identityId },
      },
      select: {
        id: true,
        participationIdentityId: true,
        segmentKey: true,
        revision: true,
        checkInAt: true,
        checkOutAt: true,
        identity: { select: { memberId: true } },
      },
    });
    sources.length = 0;
    for (const source of currentSources) {
      if (!source.checkInAt || !source.checkOutAt)
        throw new Error('closed current source required');
      sources.push({
        id: source.id,
        identityId: source.participationIdentityId,
        memberId: source.identity.memberId,
        segmentKey: source.segmentKey,
        revision: source.revision,
        start: source.checkInAt,
        end: source.checkOutAt,
      });
    }
    expect(sources).toHaveLength(population === 1 ? 0 : (population - 1) * 5 + 4);
    const slicesFor = (start: Date, end: Date, extra = false): ActivityTimeAllocationSliceInput[] =>
      (
        [
          'volunteer_service',
          'training',
          'organization',
          'non_creditable',
          'volunteer_service',
          ...(extra ? ['training' as const] : []),
        ] as const
      ).map((categoryCode, i) => ({
        categoryCode,
        intervalKindCode: 'service_segment',
        startAt: new Date(
          start.getTime() + ((end.getTime() - start.getTime()) * i) / (extra ? 6 : 5),
        ).toISOString(),
        endAt: new Date(
          start.getTime() + ((end.getTime() - start.getTime()) * (i + 1)) / (extra ? 6 : 5),
        ).toISOString(),
      }));
    const recognition = await post(`${p.url}/allocations`, {
      ...p.proof,
      operationKey: f.key('capacity_manual'),
      sourceSegmentId: p.source.id,
      expectedRevision: 0,
      recognitionModeCode: 'manual',
      manualReason: '满额合法来源验证',
      evidenceAttachmentIds: [],
      slices: slicesFor(START, END).map(({ categoryCode, startAt, endAt }) => ({
        categoryCode,
        startAt,
        endAt,
      })),
    });
    const prototype = await f.db.participantTimeAllocationRevision.findUniqueOrThrow({
      where: { id: recognition.allocationRevisionId as string },
    });
    const receipt = await f.db.participantTimeAllocationCommandReceipt.findFirstOrThrow({
      where: { allocationRevisionId: prototype.id },
    });
    for (let offset = 0; offset < sources.length; offset += 100) {
      const parents: Prisma.ParticipantTimeAllocationRevisionCreateManyInput[] = [];
      const slices: Prisma.ParticipantTimeAllocationSliceCreateManyInput[] = [];
      const receipts: Prisma.ParticipantTimeAllocationCommandReceiptCreateManyInput[] = [];
      for (const source of sources.slice(offset, offset + 100)) {
        const id = f.key('capacity_allocation');
        const input = slicesFor(source.start, source.end, false);
        const { manifest, allocationHash } = buildActivityTimeAllocationManifest(input);
        parents.push({
          ...prototype,
          id,
          sliceCount: input.length,
          participationIdentityId: source.identityId,
          memberId: source.memberId,
          segmentKey: source.segmentKey,
          sourceSegmentId: source.id,
          sourceSegmentRevision: source.revision,
          allocationJson: {
            schemaVersion: manifest.schemaVersion,
            slices: Object.fromEntries(
              Object.entries(manifest.slices).map(([key, value]) => [key, { ...value }]),
            ),
          },
          allocationHash,
        });
        input.forEach((slice, ordinal) =>
          slices.push({
            id: f.key('capacity_slice'),
            allocationRevisionId: id,
            activityId: p.activityId,
            ordinal,
            categoryCode: slice.categoryCode,
            intervalKindCode: slice.intervalKindCode,
            startAt: new Date(slice.startAt),
            endAt: new Date(slice.endAt),
          }),
        );
        receipts.push({
          ...receipt,
          id: f.key('capacity_receipt'),
          allocationRevisionId: id,
          operationKey: f.key('capacity_operation'),
          resultJson: {
            schemaVersion: 1,
            activityId: p.activityId,
            allocationRevisionId: id,
            revision: 1,
            sourceSegmentId: source.id,
            sourceSegmentRevision: source.revision,
            recognitionModeCode: 'manual',
            allocationHash,
            sliceCount: input.length,
            evidenceCount: 0,
            createdAt: prototype.createdAt.toISOString(),
          },
        });
      }
      // Parent, complete children and receipt commit together; all database guards remain enabled.
      await f.db.$transaction(
        async (tx) => {
          await tx.participantTimeAllocationRevision.createMany({ data: parents });
          await tx.participantTimeAllocationSlice.createMany({ data: slices });
          await tx.participantTimeAllocationCommandReceipt.createMany({ data: receipts });
        },
        { timeout: 30000 },
      );
    }
    return p;
  }

  async function createClassifiedPostingFixture(timeRevisionId: string, totalCount: number) {
    const timeRevision = await f.db.activitySettlementTimeRevision.findUniqueOrThrow({
      where: { id: timeRevisionId },
    });
    const finalActor: CurrentUserPayload = {
      id: f.reviewer.id,
      memberId: f.reviewer.memberId,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      username: 'd6-final-reviewer',
    };
    const permission = await f.db.permission.upsert({
      where: { code: 'activity.settlement-final-review.record' },
      update: {},
      create: {
        code: 'activity.settlement-final-review.record',
        module: 'activity',
        action: 'record',
        resourceType: 'settlement-final-review',
      },
    });
    const finalRole = await f.db.rbacRole.create({
      data: { code: f.key('final'), displayName: 'D6 final fixture' },
    });
    await f.db.rolePermission.create({
      data: { roleId: finalRole.id, permissionId: permission.id },
    });
    await f.db.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: finalActor.id,
        roleId: finalRole.id,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: f.organizationId,
      },
    });
    // Reviewed source fixture; review commands themselves remain covered by their unchanged suites.
    await f.db.settlementReviewAction.create({
      data: {
        settlementVersionId: timeRevision.settlementVersionId,
        stageCode: 'final',
        actionCode: 'approve',
        actorUserId: finalActor.id,
        actedAt: END,
        operationKey: f.key('final_review'),
      },
    });
    await f.db.attendanceSettlementVersion.update({
      where: { id: timeRevision.settlementVersionId },
      data: { statusCode: 'approved' },
    });
    await f.db.attendanceSettlementRun.update({
      where: { id: timeRevision.settlementRunId },
      data: { statusCode: 'posting' },
    });
    const batch = await f.db.ledgerPostingBatch.create({
      data: {
        settlementRunId: timeRevision.settlementRunId,
        settlementVersionId: timeRevision.settlementVersionId,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: f.key('batch'),
        totalCount,
        preparedByUserId: finalActor.id,
      },
    });
    return { timeRevision, finalActor, finalRole, batch };
  }

  /**
   * A D4 sealed-draft allocation proves a draft calculation, while D7-2 deliberately accepts
   * only the later committed-source allocation chain.  Build that real D3-shaped predecessor
   * after the initial ledger commit: the creator goes through its service command, and the
   * remaining scale fixture rows copy their already-validated allocation/slice/evidence facts
   * into a new immutable revision with a matching committed-source receipt.
   */
  async function materializeCommittedAllocationFacts(p: Awaited<ReturnType<typeof prepareSource>>) {
    const sources = await f.db.participantServiceSegmentRevision.findMany({
      where: {
        identity: { activityId: p.activityId },
        statusCode: 'committed',
        resultCode: 'valid',
      },
      select: { id: true, participationIdentityId: true },
      orderBy: [{ participationIdentityId: 'asc' }, { segmentKey: 'asc' }],
    });
    const sourceIds = sources.map((row) => row.id);
    const readDraftAllocations = (sourceSegmentIds: string[]) =>
      f.db.participantTimeAllocationRevision.findMany({
        where: {
          activityId: p.activityId,
          sourceSegmentId: { in: sourceSegmentIds },
          settlementDraftVersionId: { not: null },
        },
        include: {
          slices: { orderBy: { ordinal: 'asc' } },
          evidence: { orderBy: { ordinal: 'asc' } },
        },
        orderBy: [{ participationIdentityId: 'asc' }, { segmentKey: 'asc' }, { revision: 'asc' }],
      });
    const draftAllocations: Awaited<ReturnType<typeof readDraftAllocations>> = [];
    // 2,000 人满额夹具会有 10,000 个来源段；单条 IN 参数列表会越过本地
    // Postgres 的栈深上限。仅分批读取同一冻结来源集，不改变任何业务调用或断言。
    for (let offset = 0; offset < sourceIds.length; offset += 500) {
      draftAllocations.push(...(await readDraftAllocations(sourceIds.slice(offset, offset + 500))));
    }
    const bySourceId = new Map(draftAllocations.map((row) => [row.sourceSegmentId, row]));
    if (sources.length === 0 || bySourceId.size !== sources.length)
      throw new Error('complete sealed-draft allocation source set required');
    const creatorSource = sources.find((row) => row.participationIdentityId === p.identityId);
    if (!creatorSource) throw new Error('creator committed source required');
    const creatorDraftAllocation = bySourceId.get(creatorSource.id);
    if (!creatorDraftAllocation) throw new Error('creator sealed-draft allocation required');

    const creatorCommitted = await f.app.get(ActivityTimeAllocationService).recognize(
      p.activityId,
      {
        operationKey: f.key('committed_allocation'),
        sourceSegmentId: creatorSource.id,
        expectedRevision: creatorDraftAllocation.revision,
        recognitionModeCode: 'automatic',
        evidenceAttachmentIds: [],
      },
      actor,
      meta,
    );
    if (creatorCommitted.revision !== creatorDraftAllocation.revision + 1)
      throw new Error('creator committed allocation revision required');

    const remaining = draftAllocations.filter((row) => row.id !== creatorDraftAllocation.id);
    for (let offset = 0; offset < remaining.length; offset += 100) {
      const parents: Prisma.ParticipantTimeAllocationRevisionCreateManyInput[] = [];
      const slices: Prisma.ParticipantTimeAllocationSliceCreateManyInput[] = [];
      const evidence: Prisma.ParticipantTimeAllocationEvidenceCreateManyInput[] = [];
      const receipts: Prisma.ParticipantTimeAllocationCommandReceiptCreateManyInput[] = [];
      const createdAt = new Date();
      for (const row of remaining.slice(offset, offset + 100)) {
        const id = f.key('committed_allocation');
        const operationKey = f.key('committed_allocation_command');
        const evidenceAttachmentIds = row.evidence.map((item) => item.attachmentId).sort();
        const manualSlices: ActivityTimeAllocationSliceInput[] = row.slices.map((slice) => {
          if (
            slice.intervalKindCode !== 'service_segment' ||
            !['volunteer_service', 'training', 'organization', 'non_creditable'].includes(
              slice.categoryCode,
            )
          ) {
            throw new Error('canonical committed allocation slice required');
          }
          return {
            categoryCode: slice.categoryCode as ActivityTimeAllocationSliceInput['categoryCode'],
            intervalKindCode: 'service_segment',
            startAt: slice.startAt.toISOString(),
            endAt: slice.endAt.toISOString(),
          };
        });
        const command: ActivityTimeAllocationCommand =
          row.recognitionModeCode === 'automatic'
            ? {
                operationKey,
                sourceSegmentId: row.sourceSegmentId,
                expectedRevision: row.revision,
                recognitionModeCode: 'automatic',
                manualReason: null,
                slices: [],
                evidenceAttachmentIds,
              }
            : row.recognitionModeCode === 'manual' && row.manualReason !== null
              ? {
                  operationKey,
                  sourceSegmentId: row.sourceSegmentId,
                  expectedRevision: row.revision,
                  recognitionModeCode: 'manual',
                  manualReason: row.manualReason,
                  slices: manualSlices,
                  evidenceAttachmentIds,
                }
              : (() => {
                  throw new Error('valid committed allocation recognition mode required');
                })();
        parents.push({
          id,
          createdAt,
          activityId: row.activityId,
          sessionId: row.sessionId,
          memberId: row.memberId,
          participationIdentityId: row.participationIdentityId,
          segmentKey: row.segmentKey,
          revision: row.revision + 1,
          previousAllocationRevisionId: row.id,
          sourceSegmentId: row.sourceSegmentId,
          sourceSegmentRevision: row.sourceSegmentRevision,
          sourcePositionId: row.sourcePositionId,
          ruleSnapshotId: row.ruleSnapshotId,
          ruleSnapshotHash: row.ruleSnapshotHash,
          timePolicySelectionRevisionId: row.timePolicySelectionRevisionId,
          selectionHash: row.selectionHash,
          policyId: row.policyId,
          policyVersionId: row.policyVersionId,
          definitionHash: row.definitionHash,
          evaluatorVersion: row.evaluatorVersion,
          settlementDraftVersionId: null,
          settlementEvidenceSealId: null,
          settlementEvidenceRevision: null,
          settlementPopulationRevision: null,
          settlementWorkflowRevision: null,
          settlementDraftContentHash: null,
          correctionPendingAllocationId: null,
          recognitionModeCode: row.recognitionModeCode,
          manualReason: row.manualReason,
          allocationJson: row.allocationJson as Prisma.InputJsonValue,
          allocationHash: row.allocationHash,
          sliceCount: row.sliceCount,
          createdByUserId: row.createdByUserId,
        });
        slices.push(
          ...row.slices.map((slice) => ({
            id: f.key('committed_allocation_slice'),
            allocationRevisionId: id,
            activityId: row.activityId,
            ordinal: slice.ordinal,
            categoryCode: slice.categoryCode,
            intervalKindCode: slice.intervalKindCode,
            startAt: slice.startAt,
            endAt: slice.endAt,
          })),
        );
        evidence.push(
          ...row.evidence.map((item) => ({
            id: f.key('committed_allocation_evidence'),
            allocationRevisionId: id,
            activityId: row.activityId,
            attachmentId: item.attachmentId,
            ordinal: item.ordinal,
          })),
        );
        receipts.push({
          id: f.key('committed_allocation_receipt'),
          actorUserId: row.createdByUserId,
          activityId: row.activityId,
          operationCode: 'recognize_time_allocation',
          operationKey,
          requestHash: activityTimeAllocationRequestHash(
            row.activityId,
            row.createdByUserId,
            command,
          ),
          allocationRevisionId: id,
          resultJson: {
            schemaVersion: 1,
            activityId: row.activityId,
            allocationRevisionId: id,
            revision: row.revision + 1,
            sourceSegmentId: row.sourceSegmentId,
            sourceSegmentRevision: row.sourceSegmentRevision,
            recognitionModeCode: row.recognitionModeCode,
            allocationHash: row.allocationHash,
            sliceCount: row.sliceCount,
            evidenceCount: evidenceAttachmentIds.length,
            createdAt: createdAt.toISOString(),
          },
          createdAt,
        });
      }
      await f.db.$transaction(
        async (tx) => {
          await tx.participantTimeAllocationRevision.createMany({ data: parents });
          await tx.participantTimeAllocationSlice.createMany({ data: slices });
          if (evidence.length > 0)
            await tx.participantTimeAllocationEvidence.createMany({ data: evidence });
          await tx.participantTimeAllocationCommandReceipt.createMany({ data: receipts });
        },
        { timeout: 30000 },
      );
    }
  }

  /**
   * D7-2 deliberately starts from the same committed, classified source as
   * D7-1.  This keeps the Human HTTP contract tied to real settlement, ledger,
   * allocation and final-review facts instead of creating a partial shortcut.
   */
  async function createCommittedFactCorrectionBase(population = 1) {
    const p = population === 1 ? await prepareSource() : await createCapacitySource(population);
    if (population === 1) await recognize(p);
    const preparedTime = await post(p.url + '/prepare', prepareCommand(p));
    const submittedTime = await post(p.url + '/submit', {
      operationKey: f.key('submit_time'),
      expectedDraftVersion: p.proof.expectedDraftVersion,
      expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
      timeRevisionId: preparedTime.timeRevisionId,
      expectedBucketContentHash: preparedTime.bucketContentHash,
    });
    const { timeRevision, finalActor, finalRole, batch } = await createClassifiedPostingFixture(
      submittedTime.timeRevisionId as string,
      population,
    );
    const preparation = f.app.get(LedgerPreparationService);
    const job = await preparation.ensurePrepareJob(batch.id);
    const items = await f.db.activityBatchJobItem.findMany({ where: { jobId: job.jobId } });
    for (const item of items) await preparation.prepareChunk(job.jobId, item.id);
    await preparation.finalize(job.jobId);
    await f.app
      .get(LedgerPostingService)
      .commitBatch(
        { postingBatchId: batch.id, operationKey: f.key('initial_commit') },
        finalActor,
        meta,
      );
    await materializeCommittedAllocationFacts(p);
    await f.db.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: finalActor.id,
        roleId: finalRole.id,
        scopeType: BindingScopeType.GLOBAL,
      },
    });
    const root = await f.db.participationTimeLedgerManifest.findUniqueOrThrow({
      where: { postingBatchId: batch.id },
    });
    const roots = await f.db.participationTimeLedgerEntry.findMany({
      where: { manifestId: root.id },
      orderBy: { id: 'asc' },
    });
    const sources = await f.db.participantServiceSegmentRevision.findMany({
      where: {
        identity: { activityId: p.activityId },
        statusCode: 'committed',
        resultCode: 'valid',
      },
      select: {
        id: true,
        participationIdentityId: true,
        segmentKey: true,
        revision: true,
        checkInAt: true,
        checkOutAt: true,
        resultCode: true,
        serviceHours: true,
      },
      orderBy: [{ participationIdentityId: 'asc' }, { segmentKey: 'asc' }],
    });
    const allocations = await f.db.participantTimeAllocationRevision.findMany({
      where: {
        activityId: p.activityId,
        sourceSegmentId: { in: sources.map((row) => row.id) },
        settlementDraftVersionId: null,
      },
      select: {
        id: true,
        sourceSegmentId: true,
        sourceSegmentRevision: true,
        participationIdentityId: true,
        segmentKey: true,
        sliceCount: true,
      },
    });
    const source = sources.find((row) => row.participationIdentityId === p.identityId);
    if (!source) throw new Error('creator source required');
    const allocation = allocations.find(
      (row) =>
        row.sourceSegmentId === source.id &&
        row.sourceSegmentRevision === source.revision &&
        row.participationIdentityId === source.participationIdentityId &&
        row.segmentKey === source.segmentKey,
    );
    if (!allocation) throw new Error('creator source allocation required');
    return { p, timeRevision, root, roots, source, allocation, sources, allocations };
  }

  it('runs the Human V3 submit, returned-resubmit, review, prepare and commit chain', async () => {
    const { p, timeRevision, root, roots, source, allocation } =
      await createCommittedFactCorrectionBase();
    if (source.checkOutAt === null) throw new Error('closed source segment required');
    expect(roots.map((entry) => entry.categoryCode).sort()).toEqual([
      'non_creditable',
      'organization',
      'training',
      'volunteer_service',
    ]);

    const correctedCheckOutAt = new Date(source.checkOutAt.getTime() - 60_000);
    const correctionUrl = `${D13_APP}/${p.activityId}/time-corrections`;
    const requestBody = (operationKey: string, reason: string) => ({
      participationIdentityId: source.participationIdentityId,
      requestTypeCode: 'time',
      requestedChangeJson: {
        schemaVersion: 3,
        results: [],
        segments: [
          {
            participationIdentityId: source.participationIdentityId,
            segmentKey: source.segmentKey,
            checkInAt: source.checkInAt.toISOString(),
            checkOutAt: correctedCheckOutAt.toISOString(),
            resultCode: source.resultCode,
            serviceHours: '0.98',
          },
        ],
        timeCorrection: {
          baseSettlementVersionId: timeRevision.settlementVersionId,
          baseTimeLedgerHash: root.contentHash,
          reason: '核验后更正服务段终止时刻',
          items: roots.map((entry) => ({
            rootEntryId: entry.id,
            recognizedSeconds:
              entry.categoryCode === 'volunteer_service' ? 3540 : entry.recognizedSeconds,
          })),
        },
        allocations: [
          {
            participationIdentityId: source.participationIdentityId,
            segmentKey: source.segmentKey,
            baseSegmentRevisionId: source.id,
            baseAllocationRevisionId: allocation.id,
            recognitionModeCode: 'automatic',
            manualReason: null,
            slices: [],
            evidenceAttachmentIds: [],
          },
        ],
      },
      reason,
      operationKey,
    });

    const first = await request(httpServer(f.app))
      .post(correctionUrl)
      .set('Authorization', f.creator.auth)
      .send(requestBody(f.key('human_submit'), '发现服务段结束时刻需核实'))
      .expect(201);
    expect(first.body).toMatchObject({
      code: 0,
      data: {
        activityId: p.activityId,
        baseSettlementVersionId: timeRevision.settlementVersionId,
        statusCode: 'pending',
        replayed: false,
      },
    });
    const firstData = first.body.data as { requestId: string; requestVersion: number };

    const wrongActivityId = p.activityId.slice(0, -1) + (p.activityId.endsWith('0') ? '1' : '0');
    const wrongRouteReview = await request(httpServer(f.app))
      .post(`${D13_APP}/${wrongActivityId}/time-corrections/${firstData.requestId}/review`)
      .set('Authorization', f.reviewer.auth)
      .send({
        actionCode: 'approve',
        expectedRequestVersion: firstData.requestVersion,
        note: '错误活动路径不得处理该申请',
      });
    expect({ status: wrongRouteReview.status, code: wrongRouteReview.body.code }).toEqual({
      status: BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE.httpStatus,
      code: BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE.code,
    });
    await expect(
      f.db.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id: firstData.requestId } }),
    ).resolves.toMatchObject({ statusCode: 'pending' });

    const initialDetail = await request(httpServer(f.app))
      .get(`${correctionUrl}/${firstData.requestId}`)
      .set('Authorization', f.creator.auth)
      .query({ page: 1, pageSize: 1 })
      .expect(200);
    expect(initialDetail.body.data).toMatchObject({
      requestId: firstData.requestId,
      evidenceStatusCode: 'not_frozen',
      sourceProofHash: null,
      sourcePage: null,
    });

    const returned = await request(httpServer(f.app))
      .post(`${correctionUrl}/${firstData.requestId}/review`)
      .set('Authorization', f.reviewer.auth)
      .send({
        actionCode: 'return',
        expectedRequestVersion: firstData.requestVersion,
        note: '请补齐核验说明后重提',
      })
      .expect(200);
    expect(returned.body.data).toMatchObject({
      outcome: 'reviewed',
      requestId: firstData.requestId,
      statusCode: 'returned',
      replayed: false,
    });

    const wrongRouteResubmit = await request(httpServer(f.app))
      .post(`${D13_APP}/${wrongActivityId}/time-corrections/${firstData.requestId}/resubmit`)
      .set('Authorization', f.creator.auth)
      .send(requestBody(f.key('human_resubmit_wrong_activity'), '错误活动路径不得重提该申请'));
    expect({ status: wrongRouteResubmit.status, code: wrongRouteResubmit.body.code }).toEqual({
      status: BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE.httpStatus,
      code: BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE.code,
    });
    await expect(
      f.db.attendanceCorrectionRequest.findUniqueOrThrow({ where: { id: firstData.requestId } }),
    ).resolves.toMatchObject({ statusCode: 'returned' });

    const resubmitted = await request(httpServer(f.app))
      .post(`${correctionUrl}/${firstData.requestId}/resubmit`)
      .set('Authorization', f.creator.auth)
      .send(requestBody(f.key('human_resubmit'), '已补齐服务段时间核验依据'))
      .expect(201);
    expect(resubmitted.body.data).toMatchObject({
      outcome: 'resubmitted',
      statusCode: 'pending',
      replayed: false,
    });
    const resubmittedData = resubmitted.body.data as { requestId: string; requestVersion: number };
    const oldRequest = await f.db.attendanceCorrectionRequest.findUniqueOrThrow({
      where: { id: firstData.requestId },
    });
    expect(oldRequest).toMatchObject({
      statusCode: 'voided',
      reviewNote: '请补齐核验说明后重提',
    });
    expect(
      await f.db.attendanceCorrectionRequest.findUniqueOrThrow({
        where: { id: resubmittedData.requestId },
      }),
    ).toMatchObject({ resubmittedFromRequestId: firstData.requestId, statusCode: 'pending' });

    const approved = await request(httpServer(f.app))
      .post(`${correctionUrl}/${resubmittedData.requestId}/review`)
      .set('Authorization', f.reviewer.auth)
      .send({
        actionCode: 'approve',
        expectedRequestVersion: resubmittedData.requestVersion,
        note: '复核通过',
      })
      .expect(200);
    expect(approved.body.data).toMatchObject({
      outcome: 'reviewed',
      requestId: resubmittedData.requestId,
      statusCode: 'approved',
    });

    const prepared = await request(httpServer(f.app))
      .post(`${correctionUrl}/${resubmittedData.requestId}/prepare`)
      .set('Authorization', f.reviewer.auth)
      .send({
        expectedBaseSettlementVersionId: timeRevision.settlementVersionId,
        operationKey: f.key('human_prepare'),
      })
      .expect(200);
    expect(prepared.body).toMatchObject({
      code: 0,
      data: {
        requestId: resubmittedData.requestId,
        replayed: false,
        sourceProofHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    const preparedData = prepared.body.data as {
      applicationId: string;
      postingBatchId: string;
      settlementVersionId: string;
      sourceProofHash: string;
    };

    // The guard must reject an otherwise FK-valid binding when it claims the
    // changed pending allocation with the source's unchanged base allocation.
    // This exercises the statement-level path before normal materialization
    // creates any binding.
    const sourceProof = await f.db.correctionTimeSourceProof.findUniqueOrThrow({
      where: { applicationId: preparedData.applicationId },
    });
    const pendingAllocation = await f.db.correctionPendingTimeAllocation.findFirstOrThrow({
      where: { applicationId: preparedData.applicationId },
    });
    const snapshots = sourceProof.sourceSnapshotJson;
    if (!Array.isArray(snapshots)) throw new Error('source proof snapshots required');
    const sourceSnapshot = snapshots.find((value): value is Prisma.JsonObject => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      return (
        value.participationIdentityId === source.participationIdentityId &&
        value.segmentKey === source.segmentKey &&
        value.baseSegmentRevisionId === source.id &&
        value.baseAllocationRevisionId === allocation.id &&
        value.pendingAllocationId === pendingAllocation.id
      );
    });
    const sourceHash = sourceSnapshot?.sourceHash;
    if (typeof sourceHash !== 'string') throw new Error('base source hash required');
    await expect(
      f.db.$executeRaw(
        Prisma.sql`
          INSERT INTO "CorrectionTimeAllocationBinding" (
            "id", "proofId", "activityId", "participationIdentityId", "segmentKey",
            "allocationRevisionId", "sourceSegmentId", "sourceSegmentRevision",
            "pendingAllocationId", "sourceHash"
          ) VALUES (
            ${f.key('binding_guard_mismatch')}, ${sourceProof.id}, ${p.activityId},
            ${source.participationIdentityId}, ${source.segmentKey},
            ${allocation.id}, ${source.id}, ${source.revision},
            ${pendingAllocation.id}, ${sourceHash}
          )
        `,
      ),
    ).rejects.toThrow('binding does not match its pending allocation fact');
    expect(
      await f.db.correctionTimeAllocationBinding.count({ where: { proofId: sourceProof.id } }),
    ).toBe(0);

    // The allocation counterpart must fail closed through the new AFTER
    // statement guard as well.  It is FK-valid but deliberately retains the
    // base allocation anchors instead of the pending V3 target anchors.
    const baseAllocation = await f.db.participantTimeAllocationRevision.findUniqueOrThrow({
      where: { id: allocation.id },
    });
    await expect(
      f.db.participantTimeAllocationRevision.create({
        data: {
          ...baseAllocation,
          id: f.key('allocation_guard_mismatch'),
          revision: pendingAllocation.targetAllocationRevision,
          previousAllocationRevisionId: baseAllocation.id,
          correctionPendingAllocationId: pendingAllocation.id,
          settlementDraftVersionId: null,
          settlementEvidenceSealId: null,
          settlementEvidenceRevision: null,
          settlementPopulationRevision: null,
          settlementWorkflowRevision: null,
          settlementDraftContentHash: null,
          allocationJson: baseAllocation.allocationJson as Prisma.InputJsonValue,
        },
      }),
    ).rejects.toThrow('correction allocation differs from its pending fact');
    expect(
      await f.db.participantTimeAllocationRevision.count({
        where: { correctionPendingAllocationId: pendingAllocation.id },
      }),
    ).toBe(0);

    const frozenDetail = await request(httpServer(f.app))
      .get(`${correctionUrl}/${resubmittedData.requestId}`)
      .set('Authorization', f.creator.auth)
      .query({ page: 1, pageSize: 1 })
      .expect(200);
    expect(frozenDetail.body.data).toMatchObject({
      requestId: resubmittedData.requestId,
      evidenceStatusCode: 'frozen',
      sourceProofHash: preparedData.sourceProofHash,
      sourcePage: { total: 1, page: 1, pageSize: 1 },
    });
    expect(frozenDetail.body.data.sourcePage.items).toHaveLength(1);

    const commitPayload = {
      expectedBaseSettlementVersionId: timeRevision.settlementVersionId,
      correctionApplicationId: preparedData.applicationId,
      postingBatchId: preparedData.postingBatchId,
      operationKey: f.key('human_commit'),
    };
    const committed = await request(httpServer(f.app))
      .post(`${correctionUrl}/${resubmittedData.requestId}/commit`)
      .set('Authorization', f.reviewer.auth)
      .send(commitPayload)
      .expect(200);
    expect(committed.body.data).toMatchObject({
      requestId: resubmittedData.requestId,
      applicationId: preparedData.applicationId,
      postingBatchId: preparedData.postingBatchId,
      settlementVersionId: preparedData.settlementVersionId,
      correctionStatus: 'applied',
      applicationStatus: 'committed',
      replayed: false,
    });

    // A same-task replay must report the same immutable target IDs, without
    // adding a second audit/ledger result or substituting placeholder values.
    const replayed = await request(httpServer(f.app))
      .post(`${correctionUrl}/${resubmittedData.requestId}/commit`)
      .set('Authorization', f.reviewer.auth)
      .send(commitPayload)
      .expect(200);
    expect(replayed.body.data).toMatchObject({
      requestId: resubmittedData.requestId,
      applicationId: preparedData.applicationId,
      postingBatchId: preparedData.postingBatchId,
      settlementVersionId: preparedData.settlementVersionId,
      replayed: true,
    });

    const proof = await f.db.correctionTimeSourceProof.findUniqueOrThrow({
      where: { applicationId: preparedData.applicationId },
    });
    const [pending, bindings, materialized, receipt, manifest, currentRoot] = await Promise.all([
      f.db.correctionPendingTimeAllocation.findMany({
        where: { applicationId: preparedData.applicationId },
      }),
      f.db.correctionTimeAllocationBinding.findMany({ where: { proofId: proof.id } }),
      f.db.participantTimeAllocationRevision.findMany({
        where: { correctionPendingAllocationId: { not: null } },
      }),
      f.db.participantTimeAllocationCommandReceipt.findMany({
        where: { operationCode: 'recognize_correction_time_allocation' },
      }),
      f.db.participationTimeCorrectionManifest.findUniqueOrThrow({
        where: { postingBatchId: preparedData.postingBatchId },
      }),
      f.db.participationTimeLedgerManifest.findUniqueOrThrow({ where: { id: root.id } }),
    ]);
    expect(proof.sourceSetHash).toBe(preparedData.sourceProofHash);
    expect(pending).toHaveLength(1);
    expect(bindings).toHaveLength(1);
    expect(materialized).toHaveLength(1);
    expect(receipt).toHaveLength(1);
    expect(materialized[0].correctionPendingAllocationId).toBe(pending[0].id);
    expect(bindings[0].pendingAllocationId).toBe(pending[0].id);
    expect(manifest).toMatchObject({
      sourceProofId: proof.id,
      sourceProofHash: proof.sourceSetHash,
      formatVersion: 2,
    });
    expect(currentRoot.contentHash).toBe(root.contentHash);
  }, 120000);

  it.each([100, 2000])(
    'runs the Human V3 write chain against a complete %i-identity source proof',
    async (population) => {
      const { p, timeRevision, root, roots, sources, allocations } =
        await createCommittedFactCorrectionBase(population);
      expect(sources).toHaveLength(population * 5);
      const source =
        sources.find((row) => row.participationIdentityId !== p.identityId) ?? sources[0];
      if (
        !source ||
        source.checkInAt === null ||
        source.checkOutAt === null ||
        source.serviceHours === null
      ) {
        throw new Error('closed correction source required');
      }
      const allocation = allocations.find(
        (row) =>
          row.sourceSegmentId === source.id &&
          row.sourceSegmentRevision === source.revision &&
          row.participationIdentityId === source.participationIdentityId &&
          row.segmentKey === source.segmentKey,
      );
      if (!allocation) throw new Error('source allocation required');
      const correctedCheckOutAt = new Date(source.checkOutAt.getTime() - 1_000);
      const correctionUrl = `${D13_APP}/${p.activityId}/time-corrections`;
      const submitted = await request(httpServer(f.app))
        .post(correctionUrl)
        .set('Authorization', f.creator.auth)
        .send({
          participationIdentityId: source.participationIdentityId,
          requestTypeCode: 'time',
          requestedChangeJson: {
            schemaVersion: 3,
            results: [],
            segments: [
              {
                participationIdentityId: source.participationIdentityId,
                segmentKey: source.segmentKey,
                checkInAt: source.checkInAt.toISOString(),
                checkOutAt: correctedCheckOutAt.toISOString(),
                resultCode: source.resultCode,
                // This one-second source correction stays within the existing
                // two-decimal service-hour representation, so it exercises a
                // real V3 fact change without fabricating a rounded value.
                serviceHours: source.serviceHours.toString(),
              },
            ],
            timeCorrection: {
              baseSettlementVersionId: timeRevision.settlementVersionId,
              baseTimeLedgerHash: root.contentHash,
              reason: '满额来源集合中的一条服务段经核验后更正',
              items: roots.map((entry) => ({
                rootEntryId: entry.id,
                // V3 的事实变化即使落在同一量化桶，也不得被当作空更正拒绝。
                recognizedSeconds: entry.recognizedSeconds,
              })),
            },
            allocations: [
              {
                participationIdentityId: source.participationIdentityId,
                segmentKey: source.segmentKey,
                baseSegmentRevisionId: source.id,
                baseAllocationRevisionId: allocation.id,
                recognitionModeCode: 'automatic',
                manualReason: null,
                slices: [],
                evidenceAttachmentIds: [],
              },
            ],
          },
          reason: '满额事实更正验收',
          operationKey: f.key(`human_capacity_${population}_submit`),
        })
        .expect(201);
      const submittedData = submitted.body.data as { requestId: string; requestVersion: number };
      await request(httpServer(f.app))
        .post(`${correctionUrl}/${submittedData.requestId}/review`)
        .set('Authorization', f.reviewer.auth)
        .send({
          actionCode: 'approve',
          expectedRequestVersion: submittedData.requestVersion,
          note: '满额事实来源复核通过',
        })
        .expect(200);
      const prepared = await request(httpServer(f.app))
        .post(`${correctionUrl}/${submittedData.requestId}/prepare`)
        .set('Authorization', f.reviewer.auth)
        .send({
          expectedBaseSettlementVersionId: timeRevision.settlementVersionId,
          operationKey: f.key(`human_capacity_${population}_prepare`),
        })
        .expect(200);
      const preparedData = prepared.body.data as {
        applicationId: string;
        postingBatchId: string;
        settlementVersionId: string;
      };
      const sourceProof = await f.db.correctionTimeSourceProof.findUniqueOrThrow({
        where: { applicationId: preparedData.applicationId },
      });
      const pendingAllocations = await f.db.correctionPendingTimeAllocation.findMany({
        where: { applicationId: preparedData.applicationId },
      });
      expect(pendingAllocations).toHaveLength(1);
      const expectedSliceCount =
        allocations.reduce((total, row) => total + row.sliceCount, 0) -
        allocation.sliceCount +
        pendingAllocations[0].sliceCount;
      expect(sourceProof).toMatchObject({
        expectedSegmentCount: sources.length,
        expectedPendingCount: 1,
        expectedBindingCount: sources.length,
        expectedSliceCount,
      });
      let commitFailure = 'none';
      // CI-only failure diagnosis: retain only fixed stage names and numeric timing
      // aggregates.  Never print SQL, IDs, request bodies, URLs or raw errors.
      const commitPhaseMs = {
        correctionCommit: null as number | null,
        timeAllocationMaterialization: null as number | null,
        correctionReceipt: null as number | null,
        ledgerCommit: null as number | null,
      };
      const queryTiming = {
        pendingMaterialization: { count: 0, durationMs: 0 },
        timeAllocationMaterialization: { count: 0, durationMs: 0 },
        segmentMaterialization: { count: 0, durationMs: 0 },
        correctionReceipt: { count: 0, durationMs: 0 },
        ledgerDeltas: { count: 0, durationMs: 0 },
        draftSegmentMembers: { count: 0, durationMs: 0 },
        memberLocks: { count: 0, durationMs: 0 },
        dayStates: { count: 0, durationMs: 0 },
        other: { count: 0, durationMs: 0 },
      };
      type QueryTimingBucket = keyof typeof queryTiming;
      const classifyCommitQuery = (query: string): QueryTimingBucket => {
        if (query.includes('pg_advisory_xact_lock')) return 'memberLocks';
        if (query.includes('"CorrectionPendingSegmentRevision"')) return 'pendingMaterialization';
        if (
          [
            '"CorrectionTimeSourceProof"',
            '"CorrectionPendingTimeAllocation"',
            '"ParticipantTimeAllocationRevision"',
            '"ParticipantTimeAllocationSlice"',
            '"ParticipantTimeAllocationEvidence"',
            '"ParticipantTimeAllocationCommandReceipt"',
            '"CorrectionTimeAllocationBinding"',
          ].some((table) => query.includes(table))
        ) {
          return 'timeAllocationMaterialization';
        }
        if (
          query.includes('"ParticipationTimeCorrectionManifest"') ||
          query.includes('"ParticipationTimeCorrectionCommitReceipt"')
        ) {
          return 'correctionReceipt';
        }
        if (query.includes('"ParticipationLedgerEntry"') && query.includes('GROUP BY')) {
          return 'ledgerDeltas';
        }
        if (
          query.includes('"ParticipantServiceSegmentRevision"') &&
          query.includes('SELECT DISTINCT')
        ) {
          return 'draftSegmentMembers';
        }
        if (query.includes('"ParticipantServiceSegmentRevision"')) {
          return 'segmentMaterialization';
        }
        if (query.includes('"MemberContributionDayState"')) return 'dayStates';
        return 'other';
      };
      const measureCommitPhase = async <T>(
        phase: keyof typeof commitPhaseMs,
        work: () => Promise<T>,
      ): Promise<T> => {
        const startedAt = performance.now();
        try {
          return await work();
        } finally {
          commitPhaseMs[phase] = Math.round(performance.now() - startedAt);
        }
      };
      const observed =
        population === 2000 ? new PrismaClient({ log: [{ emit: 'event', level: 'query' }] }) : null;
      if (observed) {
        await observed.$connect();
        observed.$on('query', (event) => {
          const bucket = queryTiming[classifyCommitQuery(event.query)];
          bucket.count++;
          bucket.durationMs += Math.round(event.duration);
        });
      }
      const transactionSpy = observed
        ? jest.spyOn(f.db, '$transaction').mockImplementation(observed.$transaction.bind(observed))
        : undefined;
      const correction = f.app.get(CorrectionApplicationService);
      const commit = correction.commit.bind(correction);
      const correctionTimeAllocation = f.app.get(CorrectionTimeAllocationService);
      const materializeTimeAllocations =
        correctionTimeAllocation.materialize.bind(correctionTimeAllocation);
      const timeAllocationSpy = observed
        ? jest
            .spyOn(correctionTimeAllocation, 'materialize')
            .mockImplementation((...args) =>
              measureCommitPhase('timeAllocationMaterialization', () =>
                materializeTimeAllocations(...args),
              ),
            )
        : undefined;
      const timeCorrection = f.app.get(ParticipationTimeCorrectionService);
      const createCommitReceipt = timeCorrection.createCommitReceipt.bind(timeCorrection);
      const receiptSpy = observed
        ? jest
            .spyOn(timeCorrection, 'createCommitReceipt')
            .mockImplementation((...args) =>
              measureCommitPhase('correctionReceipt', () => createCommitReceipt(...args)),
            )
        : undefined;
      const ledgerPosting = f.app.get(LedgerPostingService);
      const commitBatchWithin = ledgerPosting.commitBatchWithin.bind(ledgerPosting);
      const ledgerSpy = observed
        ? jest
            .spyOn(ledgerPosting, 'commitBatchWithin')
            .mockImplementation((...args) =>
              measureCommitPhase('ledgerCommit', () => commitBatchWithin(...args)),
            )
        : undefined;
      jest.spyOn(correction, 'commit').mockImplementation(async (...args) => {
        const startedAt = performance.now();
        try {
          return await commit(...args);
        } catch (error) {
          if (population === 2000) {
            commitPhaseMs.correctionCommit = Math.round(performance.now() - startedAt);
            // Fixed diagnostic fields only; never expose SQL, IDs, URLs or raw error messages.
            commitFailure = JSON.stringify({
              prismaCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null,
              expiredTransaction:
                error instanceof Error &&
                /expired transaction|Transaction already closed/u.test(error.message),
              transactionTimeoutMs:
                error instanceof Error
                  ? Number(
                      error.message.match(/timeout for this transaction was (\d+) ms/u)?.[1],
                    ) || null
                  : null,
              transactionElapsedMs:
                error instanceof Error
                  ? Number(error.message.match(/however (\d+) ms passed/u)?.[1]) || null
                  : null,
              knownPrisma: error instanceof Prisma.PrismaClientKnownRequestError,
              unknownPrisma: error instanceof Prisma.PrismaClientUnknownRequestError,
              commitPhaseMs,
              queryTiming,
            });
          }
          throw error;
        } finally {
          if (commitPhaseMs.correctionCommit === null)
            commitPhaseMs.correctionCommit = Math.round(performance.now() - startedAt);
        }
      });
      const committed = await (async () => {
        try {
          return await request(httpServer(f.app))
            .post(`${correctionUrl}/${submittedData.requestId}/commit`)
            .set('Authorization', f.reviewer.auth)
            .send({
              expectedBaseSettlementVersionId: timeRevision.settlementVersionId,
              correctionApplicationId: preparedData.applicationId,
              postingBatchId: preparedData.postingBatchId,
              operationKey: f.key(`human_capacity_${population}_commit`),
            })
            .expect((response) => {
              if (response.status !== 200) {
                // Fixed diagnostic fields only; never expose raw response content, IDs, URLs or errors.
                console.error('D7 2000-identity commit failure', {
                  status: response.status,
                  code: typeof response.body?.code === 'number' ? response.body.code : null,
                  commitFailure,
                });
              }
            })
            .expect(200);
        } finally {
          transactionSpy?.mockRestore();
          timeAllocationSpy?.mockRestore();
          receiptSpy?.mockRestore();
          ledgerSpy?.mockRestore();
          if (observed) await observed.$disconnect();
        }
      })();
      expect(committed.body.data).toMatchObject({
        requestId: submittedData.requestId,
        applicationId: preparedData.applicationId,
        postingBatchId: preparedData.postingBatchId,
        settlementVersionId: preparedData.settlementVersionId,
        correctionStatus: 'applied',
        applicationStatus: 'committed',
      });
      const [pendingCount, bindingCount, materializedCount, receiptCount] = await Promise.all([
        f.db.correctionPendingTimeAllocation.count({
          where: { applicationId: preparedData.applicationId },
        }),
        f.db.correctionTimeAllocationBinding.count({ where: { proofId: sourceProof.id } }),
        f.db.participantTimeAllocationRevision.count({
          where: { correctionPendingAllocationId: { not: null } },
        }),
        f.db.participantTimeAllocationCommandReceipt.count({
          where: { operationCode: 'recognize_correction_time_allocation' },
        }),
      ]);
      expect([pendingCount, bindingCount, materializedCount, receiptCount]).toEqual([
        1,
        sources.length,
        1,
        1,
      ]);
    },
    600000,
  );

  it('serializes concurrent Human commits into one effect and one exact replay', async () => {
    const { p, timeRevision, root, roots, source, allocation } =
      await createCommittedFactCorrectionBase();
    if (source.checkInAt === null || source.checkOutAt === null) {
      throw new Error('closed correction source required');
    }
    const correctionUrl = `${D13_APP}/${p.activityId}/time-corrections`;
    const submitted = await request(httpServer(f.app))
      .post(correctionUrl)
      .set('Authorization', f.creator.auth)
      .send({
        participationIdentityId: source.participationIdentityId,
        requestTypeCode: 'time',
        requestedChangeJson: {
          schemaVersion: 3,
          results: [],
          segments: [
            {
              participationIdentityId: source.participationIdentityId,
              segmentKey: source.segmentKey,
              checkInAt: source.checkInAt.toISOString(),
              checkOutAt: new Date(source.checkOutAt.getTime() - 60_000).toISOString(),
              resultCode: source.resultCode,
              serviceHours: '0.98',
            },
          ],
          timeCorrection: {
            baseSettlementVersionId: timeRevision.settlementVersionId,
            baseTimeLedgerHash: root.contentHash,
            reason: '并发提交仍只应生效一条事实链',
            items: roots.map((entry) => ({
              rootEntryId: entry.id,
              recognizedSeconds:
                entry.categoryCode === 'volunteer_service' ? 3540 : entry.recognizedSeconds,
            })),
          },
          allocations: [
            {
              participationIdentityId: source.participationIdentityId,
              segmentKey: source.segmentKey,
              baseSegmentRevisionId: source.id,
              baseAllocationRevisionId: allocation.id,
              recognitionModeCode: 'automatic',
              manualReason: null,
              slices: [],
              evidenceAttachmentIds: [],
            },
          ],
        },
        reason: '并发提交验收',
        operationKey: f.key('human_concurrent_submit'),
      })
      .expect(201);
    const submittedData = submitted.body.data as { requestId: string; requestVersion: number };
    await request(httpServer(f.app))
      .post(`${correctionUrl}/${submittedData.requestId}/review`)
      .set('Authorization', f.reviewer.auth)
      .send({
        actionCode: 'approve',
        expectedRequestVersion: submittedData.requestVersion,
        note: '并发提交前复核通过',
      })
      .expect(200);
    const prepared = await request(httpServer(f.app))
      .post(`${correctionUrl}/${submittedData.requestId}/prepare`)
      .set('Authorization', f.reviewer.auth)
      .send({
        expectedBaseSettlementVersionId: timeRevision.settlementVersionId,
        operationKey: f.key('human_concurrent_prepare'),
      })
      .expect(200);
    const preparedData = prepared.body.data as {
      applicationId: string;
      postingBatchId: string;
      settlementVersionId: string;
    };
    const commitPayload = {
      expectedBaseSettlementVersionId: timeRevision.settlementVersionId,
      correctionApplicationId: preparedData.applicationId,
      postingBatchId: preparedData.postingBatchId,
      operationKey: f.key('human_concurrent_commit'),
    };
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        request(httpServer(f.app))
          .post(`${correctionUrl}/${submittedData.requestId}/commit`)
          .set('Authorization', f.reviewer.auth)
          .send(commitPayload)
          .expect(200),
      ),
    );
    expect(responses.map((response) => response.body.data.replayed).sort()).toEqual([false, true]);
    for (const response of responses) {
      expect(response.body.data).toMatchObject({
        requestId: submittedData.requestId,
        applicationId: preparedData.applicationId,
        postingBatchId: preparedData.postingBatchId,
        settlementVersionId: preparedData.settlementVersionId,
        correctionStatus: 'applied',
        applicationStatus: 'committed',
      });
    }
    expect(
      await f.db.participationTimeCorrectionCommitReceipt.count({
        where: { postingBatchId: preparedData.postingBatchId },
      }),
    ).toBe(1);
    expect(
      await f.db.participantTimeAllocationCommandReceipt.count({
        where: { operationCode: 'recognize_correction_time_allocation' },
      }),
    ).toBe(1);
  }, 120000);

  it.each([1, 100, 2000])(
    'commits complete pairs and replays within budget for %i identities',
    async (population) => {
      const p = population === 1 ? await prepareSource() : await createCapacitySource(population);
      if (population === 1) await recognize(p);
      const preparedTime = await post(p.url + '/prepare', prepareCommand(p));
      const submittedTime = await post(p.url + '/submit', {
        operationKey: f.key('submit_time'),
        expectedDraftVersion: p.proof.expectedDraftVersion,
        expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
        timeRevisionId: preparedTime.timeRevisionId,
        expectedBucketContentHash: preparedTime.bucketContentHash,
      });
      const { timeRevision, finalActor, finalRole, batch } = await createClassifiedPostingFixture(
        submittedTime.timeRevisionId as string,
        population,
      );
      const preparation = f.app.get(LedgerPreparationService);
      const job = await preparation.ensurePrepareJob(batch.id);
      const items = await f.db.activityBatchJobItem.findMany({ where: { jobId: job.jobId } });
      for (const item of items) await preparation.prepareChunk(job.jobId, item.id);
      await preparation.finalize(job.jobId);
      await f.app
        .get(LedgerPostingService)
        .commitBatch(
          { postingBatchId: batch.id, operationKey: f.key('initial_commit') },
          finalActor,
          meta,
        );
      await f.db.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: finalActor.id,
          roleId: finalRole.id,
          scopeType: BindingScopeType.GLOBAL,
        },
      });
      const root = await f.db.participationTimeLedgerManifest.findUniqueOrThrow({
        where: { postingBatchId: batch.id },
      });
      const roots = await f.db.participationTimeLedgerEntry.findMany({
        where: { manifestId: root.id },
        orderBy: { id: 'asc' },
      });
      const buckets = await f.db.participantSettlementTimeBucket.findMany({
        where: { timeRevisionId: timeRevision.id },
        orderBy: { id: 'asc' },
      });
      const correction = f.app.get(CorrectionApplicationService);
      const observed = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
      await observed.$connect();
      jest.spyOn(f.db, '$transaction').mockImplementation(observed.$transaction.bind(observed));
      let depth = 0;
      let classifiedQueries = 0;
      let totalQueries = 0;
      observed.$on('query', () => {
        totalQueries++;
        if (depth > 0) classifiedQueries++;
      });
      const measure = async <T>(work: () => Promise<T>) => {
        depth++;
        try {
          return await work();
        } finally {
          depth--;
        }
      };
      const classified = f.app.get(ParticipationTimeCorrectionService);
      const access = f.app.get(ParticipationTimeLedgerAccessService);
      const source = classified.source.bind(classified);
      const prepare = classified.prepare.bind(classified);
      const complete = classified.assertComplete.bind(classified);
      const receipt = classified.createCommitReceipt.bind(classified);
      const isCorrection = classified.isCorrectionBatch.bind(classified);
      const authorize = access.authorizeCorrection.bind(access);
      jest
        .spyOn(classified, 'source')
        .mockImplementation((...args) => measure(() => source(...args)));
      jest
        .spyOn(classified, 'prepare')
        .mockImplementation((...args) => measure(() => prepare(...args)));
      jest
        .spyOn(classified, 'assertComplete')
        .mockImplementation((...args) => measure(() => complete(...args)));
      jest
        .spyOn(classified, 'createCommitReceipt')
        .mockImplementation((...args) => measure(() => receipt(...args)));
      jest
        .spyOn(classified, 'isCorrectionBatch')
        .mockImplementation((...args) => measure(() => isCorrection(...args)));
      jest
        .spyOn(access, 'authorizeCorrection')
        .mockImplementation((...args) => measure(() => authorize(...args)));
      try {
        let baseVersionId = timeRevision.settlementVersionId;
        let baseHash = root.contentHash;
        let predecessorId: string | null = null;
        let previousSeconds = 0;
        let committedCount = 0;
        for (const seconds of [1800, 900, 1200]) {
          const submitInput = {
            activityId: p.activityId,
            participationIdentityId: null,
            requestTypeCode: 'time',
            requestedChangeJson: {
              schemaVersion: 2,
              results: [],
              segments: [],
              timeCorrection: {
                baseSettlementVersionId: baseVersionId,
                baseTimeLedgerHash: baseHash,
                reason: '永久保留更正依据',
                items: roots.map((entry) => ({
                  rootEntryId: entry.id,
                  recognizedSeconds: entry.categoryCode === 'volunteer_service' ? seconds : 0,
                })),
              },
            },
            reason: '分类认定复核',
            operationKey: f.key('correction_submit'),
            requestHash: 'caller-hash-is-not-trusted',
          };
          const submitted = await correction.submit(submitInput, actor, meta);
          expect((await correction.submit(submitInput, actor, meta)).replayed).toBe(true);
          await correction.review(
            { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
            finalActor,
            meta,
          );
          const input = {
            correctionRequestId: submitted.correctionRequestId,
            operationKey: f.key('correction_apply'),
            requestHash: 'apply',
          };
          if (population === 1 && committedCount === 0) {
            for (const mode of ['missing-manifest', 'missing-entry', 'wrong-amount'] as const) {
              jest.spyOn(classified, 'prepare').mockImplementationOnce(async (tx, contents) => {
                if (mode === 'missing-manifest') return contents.manifest as never;
                const entries = contents.entries.map((entry) => ({ ...entry }));
                if (mode === 'missing-entry') entries.pop();
                else {
                  const reversal = entries.find((entry) => entry.entryTypeCode === 'reversal')!;
                  reversal.secondsDelta -= 1;
                }
                return prepare(tx, { ...contents, entries });
              });
              await expect(correction.prepare(input, finalActor, meta)).rejects.toThrow();
              expect(await f.db.participationTimeCorrectionManifest.count()).toBe(0);
              expect(await f.db.participationTimeCorrectionEntry.count()).toBe(0);
              expect(await f.db.participationTimeCorrectionCommitReceipt.count()).toBe(0);
              expect(
                await f.db.attendanceCorrectionRequest.findUniqueOrThrow({
                  where: { id: input.correctionRequestId },
                }),
              ).toMatchObject({ statusCode: 'approved' });
            }
          }
          classifiedQueries = 0;
          const prepared = await correction.prepare(input, finalActor, meta);
          expect(classifiedQueries).toBeLessThanOrEqual(24);
          const reportUrl =
            p.url + '/versions/' + prepared.newSettlementVersionId + '/correction-ledger';
          await request(httpServer(f.app))
            .get(reportUrl)
            .set('Authorization', f.creator.auth)
            .expect(404);
          await expect(
            f.app.get(LedgerReadyBatchCommitter).commitReadyBatch(prepared.newPostingBatchId),
          ).rejects.toMatchObject({ biz: { code: 20229 } });
          await expect(
            f.app
              .get(LedgerPostingService)
              .commitBatch(
                { postingBatchId: prepared.newPostingBatchId, operationKey: f.key('bypass') },
                finalActor,
                meta,
              ),
          ).rejects.toMatchObject({ biz: { code: 20228 } });
          expect(await f.db.participationTimeCorrectionCommitReceipt.count()).toBe(committedCount);
          // A direct receipt insert may not survive without the outer transaction closure.
          await expect(
            f.db.$transaction((tx) =>
              f.app
                .get(ParticipationTimeCorrectionService)
                .createCommitReceipt(tx, prepared.newPostingBatchId),
            ),
          ).rejects.toThrow('time correction transaction is incomplete');
          const audit = f.app.get(CorrectionAuditRecorder);
          const failLast = jest
            .spyOn(audit, 'logCommit')
            .mockRejectedValueOnce(new Error('D7 final audit rollback probe'));
          await expect(correction.commit(input, finalActor, meta)).rejects.toThrow(
            'D7 final audit rollback probe',
          );
          failLast.mockRestore();
          expect(await f.db.participationTimeCorrectionCommitReceipt.count()).toBe(committedCount);
          expect(
            await f.db.ledgerPostingBatch.findUniqueOrThrow({
              where: { id: prepared.newPostingBatchId },
            }),
          ).toMatchObject({ statusCode: 'ready' });
          expect(
            await f.db.attendanceCorrectionRequest.findUniqueOrThrow({
              where: { id: input.correctionRequestId },
            }),
          ).toMatchObject({ statusCode: 'applying' });
          classifiedQueries = 0;
          const committed = await correction.commit(input, finalActor, meta);
          expect(classifiedQueries).toBeLessThanOrEqual(24);
          expect(committed.applicationStatus).toBe('committed');
          expect((await correction.commit(input, finalActor, meta)).replayed).toBe(true);
          await f.db.member.update({
            where: { id: f.reviewer.memberId },
            data: { status: 'INACTIVE' },
          });
          await expect(correction.commit(input, finalActor, meta)).rejects.toMatchObject({
            biz: { code: 40300 },
          });
          await f.db.member.update({
            where: { id: f.reviewer.memberId },
            data: { status: 'ACTIVE' },
          });
          const manifest = await f.db.participationTimeCorrectionManifest.findUniqueOrThrow({
            where: { postingBatchId: prepared.newPostingBatchId },
          });
          expect(manifest.predecessorManifestId).toBe(predecessorId);
          expect(manifest.expectedEntryCount).toBe(population * 8);
          expect(manifest.replacementSecondsTotal).toBe(BigInt(seconds * population));
          expect(manifest.reversalSecondsTotal).toBe(
            predecessorId ? BigInt(-previousSeconds * population) : -root.recognizedSecondsTotal,
          );
          totalQueries = 0;
          const report = await request(httpServer(f.app))
            .get(reportUrl)
            .query({ pageSize: 2 })
            .set('Authorization', f.creator.auth)
            .expect(200);
          expect(totalQueries).toBeLessThanOrEqual(40);
          expect(report.body.data.resultPage).toMatchObject({
            page: 1,
            pageSize: 2,
            total: population * 8,
          });
          expect(report.body.data.resultPage.items).toHaveLength(2);
          expect(JSON.stringify(report.body.data)).not.toContain('永久保留更正依据');
          await f.db.$transaction((tx) =>
            f.app
              .get(ParticipationTimeCorrectionService)
              .assertComplete(tx, prepared.newPostingBatchId, true),
          );
          baseVersionId = prepared.newSettlementVersionId;
          baseHash = manifest.contentHash;
          predecessorId = manifest.id;
          previousSeconds = seconds;
          committedCount++;
          const noChangeInput = {
            ...submitInput,
            operationKey: f.key('no_change'),
            requestedChangeJson: {
              ...submitInput.requestedChangeJson,
              timeCorrection: {
                ...submitInput.requestedChangeJson.timeCorrection,
                baseSettlementVersionId: baseVersionId,
                baseTimeLedgerHash: baseHash,
                reason: '仅原因改变不产生新账',
              },
            },
          };
          await expect(correction.submit(noChangeInput, actor, meta)).rejects.toMatchObject({
            biz: { code: 20102 },
          });
        }
        expect(await f.db.participationTimeCorrectionCommitReceipt.count()).toBe(3);
        if (population === 1) {
          for (const [table, constraint] of [
            ['ParticipationTimeCorrectionManifest', 'ptcm_immutable'],
            ['ParticipationTimeCorrectionEntry', 'ptce_immutable'],
            ['ParticipationTimeCorrectionCommitReceipt', 'ptcr_immutable'],
          ] as const) {
            // PostgreSQL itself reports the exact guard name; Prisma can omit it.
            await f.db.$executeRawUnsafe(`DO $$
              DECLARE observed_constraint text;
              BEGIN
                BEGIN
                  UPDATE "${table}" SET "contentHash" = "contentHash";
                  RAISE EXCEPTION 'expected immutable guard';
                EXCEPTION WHEN check_violation THEN
                  GET STACKED DIAGNOSTICS observed_constraint = CONSTRAINT_NAME;
                  IF observed_constraint <> '${constraint}' THEN
                    RAISE EXCEPTION 'unexpected immutable guard';
                  END IF;
                END;
              END $$`);
          }
        }
        expect(
          await f.db.participationTimeLedgerEntry.findMany({
            where: { manifestId: root.id },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(roots);
        expect(
          await f.db.participantSettlementTimeBucket.findMany({
            where: { timeRevisionId: timeRevision.id },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(buckets);
      } finally {
        jest.restoreAllMocks();
        await observed.$disconnect();
      }
    },
    600000,
  );
});
