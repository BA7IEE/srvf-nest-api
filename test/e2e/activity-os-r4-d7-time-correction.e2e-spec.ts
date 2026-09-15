import {
  BindingScopeType,
  PrincipalType,
  Role,
  UserStatus,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { ParticipationTimeLedgerAccessService } from '../../src/modules/activities/participation-time-ledger-access.service';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import {
  buildActivityTimeAllocationManifest,
  type ActivityTimeAllocationSliceInput,
} from '../../src/modules/activities/activity-time-allocation-command';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import { CorrectionAuditRecorder } from '../../src/modules/activities/correction-audit-recorder';
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

describe('D7-1 recognition correction real transaction', () => {
  let f: D13Fixture;
  let actor: CurrentUserPayload;
  let prepareFailure = 'none';
  const meta = { requestId: 'd5-e2e', ip: null, ua: null };
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeEach(async () => {
    // Test-process configuration only. Never changes an application instance or deployment Gate.
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    f = await createD13Fixture();
    prepareFailure = 'none';
    const timeSettlement = f.app.get(ActivityTimeSettlementService);
    const prepare = timeSettlement.prepare.bind(timeSettlement);
    jest.spyOn(timeSettlement, 'prepare').mockImplementation(async (...args) => {
      try {
        return await prepare(...args);
      } catch (error) {
        // Fixed diagnostic fields only; never expose SQL, IDs, URLs or raw error messages.
        prepareFailure = JSON.stringify({
          prismaCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null,
          expiredTransaction:
            error instanceof Error &&
            /expired transaction|Transaction already closed/u.test(error.message),
          transactionTimeoutMs:
            error instanceof Error
              ? Number(error.message.match(/timeout for this transaction was (\d+) ms/u)?.[1]) ||
                null
              : null,
          transactionElapsedMs:
            error instanceof Error
              ? Number(error.message.match(/however (\d+) ms passed/u)?.[1]) || null
              : null,
          knownPrisma: error instanceof Prisma.PrismaClientKnownRequestError,
          unknownPrisma: error instanceof Prisma.PrismaClientUnknownRequestError,
        });
        throw error;
      }
    });
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
      prepareFailure,
    }).toEqual({ status: 200, code: 0, message: expect.any(String), prepareFailure: 'none' });
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
