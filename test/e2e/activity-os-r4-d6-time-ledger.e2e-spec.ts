import { BindingScopeType, PrincipalType, Role, UserStatus, Prisma } from '@prisma/client';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import { ParticipationTimeLedgerAccessService } from '../../src/modules/activities/participation-time-ledger-access.service';
import { ParticipationTimeLedgerQueryService } from '../../src/modules/activities/participation-time-ledger-query.service';
import { SettlementNotificationProducer } from '../../src/modules/activities/settlement-notification-producer';
import { assertConnectedTestDatabase } from '../setup/test-db';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import {
  buildActivityTimeAllocationManifest,
  type ActivityTimeAllocationSliceInput,
} from '../../src/modules/activities/activity-time-allocation-command';

class ObservedLedgerDatabase extends PrismaClient<Prisma.PrismaClientOptions, 'query'> {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
import {
  LedgerPreparationService,
  LedgerPrepareLeaseLostError,
} from '../../src/modules/activities/ledger-preparation.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPostingAuditRecorder } from '../../src/modules/activities/ledger-posting-audit-recorder';
import { ParticipationTimeLedgerService } from '../../src/modules/activities/participation-time-ledger.service';
import { LedgerReadyBatchCommitter } from '../../src/modules/activities/ledger-ready-batch-committer.service';
import { ActivityTimeSettlementAccessService } from '../../src/modules/activities/activity-time-settlement-access.service';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import {
  CORRECTION_CHANGE_SCHEMA_VERSION,
  parseCorrectionChangeSet,
} from '../../src/modules/activities/correction-change-set';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { runMemberLinearizedTransaction } from '../../src/common/prisma/member-advisory-lock.util';
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

describe('D6 classified ledger through real preparation and commit', () => {
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
    'measures classified worker and ledger at %i identities',
    async (population) => {
      const p = await createCapacitySource(population);
      const prepared = await post(p.url + '/prepare', prepareCommand(p));
      const submitted = await post(p.url + '/submit', {
        operationKey: f.key('scale_submit'),
        expectedDraftVersion: p.proof.expectedDraftVersion,
        expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
        timeRevisionId: prepared.timeRevisionId,
        expectedBucketContentHash: prepared.bucketContentHash,
      });
      const { timeRevision, finalActor, batch } = await createClassifiedPostingFixture(
        submitted.timeRevisionId as string,
        population,
      );
      expect(
        await f.db.participantSettlementTimeBucket.count({
          where: { timeRevisionId: timeRevision.id },
        }),
      ).toBe(population * 4);
      if (population === 2000) {
        expect(
          await f.db.participantTimeAllocationRevision.count({
            where: { activityId: p.activityId },
          }),
        ).toBe(10000);
        expect(
          await f.db.participantTimeAllocationSlice.count({ where: { activityId: p.activityId } }),
        ).toBe(50000);
        expect(
          await f.db.participantSettlementTimeBucketSource.count({
            where: { timeRevisionId: timeRevision.id },
          }),
        ).toBe(40000);
      }
      const observed = new ObservedLedgerDatabase({ log: [{ emit: 'event', level: 'query' }] });
      let statements: string[] = [];
      let queryDurations: number[] = [];
      let queryTimeline: { operation: string; atMs: number }[] = [];
      let stepStarted = performance.now();
      let classificationQueries = 0;
      let authorizationQueries = 0;
      observed.$on('query', (event) => {
        statements.push(event.query);
        queryDurations.push(event.duration);
        queryTimeline.push({
          operation: event.query.trim().split(/\s/u)[0],
          atMs: Math.round(performance.now() - stepStarted),
        });
      });
      const measurements: {
        step: string;
        queries: number;
        healthChecks: number;
        classificationQueries: number;
        authorizationQueries: number;
        elapsedMs: number;
        queryDurationsMs: number[];
        queryTimeline: { operation: string; atMs: number }[];
      }[] = [];
      const measureClassification = async <T>(
        run: () => Promise<T>,
        authorization = false,
      ): Promise<T> => {
        const start = statements.length;
        try {
          return await run();
        } finally {
          const count = statements
            .slice(start)
            .filter(
              (sql) =>
                !/^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/i.test(sql) &&
                !/^\s*SELECT 1\s*;?\s*$/i.test(sql),
            ).length;
          classificationQueries += count;
          if (authorization) authorizationQueries += count;
        }
      };
      const measure = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
        statements = [];
        queryDurations = [];
        queryTimeline = [];
        classificationQueries = 0;
        authorizationQueries = 0;
        const start = performance.now();
        stepStarted = start;
        try {
          return await run();
        } finally {
          const queries = statements.filter(
            (sql) => !/^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/i.test(sql),
          );
          measurements.push({
            step,
            queries: queries.length,
            healthChecks: queries.filter((sql) => /^\s*SELECT 1\s*;?\s*$/i.test(sql)).length,
            classificationQueries,
            authorizationQueries,
            elapsedMs: Math.round(performance.now() - start),
            queryDurationsMs: [...queryDurations],
            queryTimeline: [...queryTimeline],
          });
        }
      };
      const ledger = new ParticipationTimeLedgerService();
      const access = f.app.get(ParticipationTimeLedgerAccessService);
      const ensureManifest = ledger.ensureManifest.bind(ledger);
      const prepareIdentities = ledger.prepareIdentities.bind(ledger);
      const assertComplete = ledger.assertComplete.bind(ledger);
      const hasClassifiedSource = ledger.hasClassifiedSource.bind(ledger);
      const assertNotClassifiedCorrectionBatch =
        ledger.assertNotClassifiedCorrectionBatch.bind(ledger);
      const authorize = access.authorize.bind(access);
      jest
        .spyOn(ledger, 'ensureManifest')
        .mockImplementation((...args) => measureClassification(() => ensureManifest(...args)));
      jest
        .spyOn(ledger, 'prepareIdentities')
        .mockImplementation((...args) => measureClassification(() => prepareIdentities(...args)));
      jest
        .spyOn(ledger, 'assertComplete')
        .mockImplementation((...args) => measureClassification(() => assertComplete(...args)));
      jest
        .spyOn(ledger, 'hasClassifiedSource')
        .mockImplementation((...args) => measureClassification(() => hasClassifiedSource(...args)));
      jest
        .spyOn(ledger, 'assertNotClassifiedCorrectionBatch')
        .mockImplementation((...args) =>
          measureClassification(() => assertNotClassifiedCorrectionBatch(...args)),
        );
      jest
        .spyOn(access, 'authorize')
        .mockImplementation((...args) => measureClassification(() => authorize(...args), true));
      const preparation = new LedgerPreparationService(
        observed,
        f.app.get(ActivityWorkflowGate),
        ledger,
      );
      const posting = new LedgerPostingService(
        observed,
        f.app.get(LedgerPostingAuditRecorder),
        f.app.get(SettlementNotificationProducer),
        f.app.get(ActivityWorkflowGate),
        ledger,
        access,
      );
      const queries = new ParticipationTimeLedgerQueryService(
        observed,
        f.app.get(ActivityTimeSettlementAccessService),
      );
      const chunk = preparation.prepareChunk.bind(preparation);
      const finalize = preparation.finalize.bind(preparation);
      jest
        .spyOn(preparation, 'prepareChunk')
        .mockImplementation((...args) => measure('chunk', () => chunk(...args)));
      jest
        .spyOn(preparation, 'finalize')
        .mockImplementation((...args) => measure('finalize', () => finalize(...args)));
      const worker = new ActivityBatchWorker(
        observed,
        preparation,
        f.app.get(LedgerReadyBatchCommitter),
        false,
      );
      let measurementsReported = false;
      try {
        await assertConnectedTestDatabase(observed);
        const job = await measure('ensure', () => preparation.ensurePrepareJob(batch.id));
        const started = performance.now();
        let ready = false;
        for (let round = 0; round < 100; round += 1) {
          const result = await worker.drainOnce({ now: new Date(Date.now() + 1000) });
          expect(result.jobId).toBe(job.jobId);
          expect(result.commitAttempted).toBe(false);
          if (result.batchStatus === 'ready') {
            ready = true;
            break;
          }
        }
        expect(ready).toBe(true);
        const workerElapsedMs = Math.round(performance.now() - started);
        await measure('commit', () =>
          posting.commitBatch(
            { postingBatchId: batch.id, operationKey: f.key('scale_commit') },
            finalActor,
            meta,
          ),
        );
        const report = await measure('get', () =>
          queries.report(p.activityId, timeRevision.id, { page: 1, pageSize: 100 }, actor),
        );
        expect(report.entryCount).toBe(population * 4);
        expect(report.resultPage.total).toBe(population * 4);
        expect(report.resultPage.items).toHaveLength(Math.min(100, population * 4));
        console.info(
          'D6 measured SQL and timing',
          JSON.stringify({
            population,
            workerElapsedMs,
            measurements: measurements.map((row) => ({
              step: row.step,
              queries: row.queries,
              healthChecks: row.healthChecks,
              classificationQueries: row.classificationQueries,
              authorizationQueries: row.authorizationQueries,
              elapsedMs: row.elapsedMs,
            })),
          }),
        );
        measurementsReported = true;
        expect(measurements.filter((row) => row.step === 'chunk').length).toBeGreaterThan(0);
        for (const row of measurements) {
          expect(row.queries).toBeGreaterThan(0);
          if (row.step === 'chunk' || row.step === 'finalize')
            expect(row.classificationQueries).toBeLessThanOrEqual(8);
          if (row.step === 'commit') {
            expect(row.classificationQueries).toBeLessThanOrEqual(56);
            expect(row.queries - row.healthChecks).toBeLessThanOrEqual(85);
          }
          if (row.step === 'get') {
            expect(row.queries).toBeLessThanOrEqual(120);
            expect(row.elapsedMs).toBeLessThan(30000);
          }
        }
      } finally {
        if (!measurementsReported)
          console.info(
            'D6 completed step measurements',
            JSON.stringify({ population, measurements }),
          );
        await worker.onModuleDestroy();
        await observed.$disconnect();
      }
    },
    600000,
  );

  it.each([
    'complete',
    'complete_user_disabled_while_waiting',
    'complete_member_inactive_while_waiting',
    'complete_organization_inactive_while_waiting',
    'auto_commit',
    'invisible_failed',
    'invisible_voided',
    'missing_entry',
    'wrong_hash',
    'wrong_key',
    'wrong_amount',
    'mapped_source_fk',
    'anchor_entry_batch',
    'anchor_entry_activity',
    'anchor_entry_revision',
    'anchor_entry_identity',
    'anchor_entry_category',
    'anchor_entry_bucket_set',
    'anchor_manifest_version',
    'anchor_manifest_run',
    'anchor_manifest_activity',
    'anchor_manifest_revision',
    'late_entry_insert',
    'late_manifest_insert',
  ] as const)(
    'checks classified preparation and commit: %s',
    async (scenario) => {
      const normalPreparation = scenario.startsWith('complete');
      const p = await prepareSource();
      await recognize(p);
      const prepared = await post(p.url + '/prepare', prepareCommand(p));
      const submitted = await post(p.url + '/submit', {
        operationKey: f.key('ledger_submit'),
        expectedDraftVersion: p.proof.expectedDraftVersion,
        expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
        timeRevisionId: prepared.timeRevisionId,
        expectedBucketContentHash: prepared.bucketContentHash,
      });
      const timeRevision = await f.db.activitySettlementTimeRevision.findUniqueOrThrow({
        where: { id: submitted.timeRevisionId as string },
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
          totalCount: 1,
          preparedByUserId: finalActor.id,
        },
      });
      const preparation = f.app.get(LedgerPreparationService);
      const job = await preparation.ensurePrepareJob(batch.id);
      const items = await f.db.activityBatchJobItem.findMany({
        where: { jobId: job.jobId },
        orderBy: { itemKey: 'asc' },
      });
      if (scenario === 'mapped_source_fk') {
        const ledger = f.app.get(ParticipationTimeLedgerService);
        const originalSource = ledger.source.bind(ledger);
        jest.spyOn(ledger, 'source').mockImplementationOnce(async (tx, target) => {
          const source = await originalSource(tx, target);
          if (!source) throw new Error('Expected classified source');
          return {
            ...source,
            entries: source.entries.map((row, index) =>
              index === 0 ? { ...row, recognizedSeconds: row.recognizedSeconds + 1 } : row,
            ),
          };
        });
        expect(items).toHaveLength(1);
        await expect(preparation.prepareChunk(job.jobId, items[0].id)).rejects.toMatchObject({
          biz: { code: 20226, httpStatus: 409 },
        });
        expect(await f.db.participationTimeLedgerEntry.count()).toBe(0);
        expect(
          await f.db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batch.id } }),
        ).toMatchObject({ statusCode: 'preparing', preparedCount: 0 });
        return;
      }
      if (scenario === 'late_entry_insert' || scenario === 'late_manifest_insert') {
        const ledger = f.app.get(ParticipationTimeLedgerService);
        const source = await f.db.$transaction((tx) => ledger.source(tx, batch));
        if (!source) throw new Error('Expected classified source');
        const manifest = await f.db.participationTimeLedgerManifest.findUniqueOrThrow({
          where: { postingBatchId: batch.id },
        });
        const targetBatch =
          scenario === 'late_entry_insert'
            ? batch
            : await f.db.ledgerPostingBatch.create({
                data: {
                  settlementRunId: batch.settlementRunId,
                  settlementVersionId: batch.settlementVersionId,
                  batchRevision: 2,
                  statusCode: 'preparing',
                  requestKey: f.key('late_manifest_batch'),
                },
              });
        const entry = source.entries[0];
        const insert = () =>
          scenario === 'late_entry_insert'
            ? f.db.$executeRaw`INSERT INTO "ParticipationTimeLedgerEntry"
            (id,"manifestId","postingBatchId","activityId","timeRevisionId","bucketId",
             "participationIdentityId","categoryCode","recognizedSeconds","entryKey","contentHash")
            VALUES (${f.key('late_entry')},${manifest.id},${targetBatch.id},${entry.activityId},
              ${entry.timeRevisionId},${entry.bucketId},${entry.participationIdentityId},
              ${entry.categoryCode},${entry.recognizedSeconds},${entry.entryKey},${entry.contentHash})`
            : f.db.$executeRaw`INSERT INTO "ParticipationTimeLedgerManifest"
            (id,"postingBatchId","activityId","settlementRunId","settlementVersionId","timeRevisionId",
             "bucketContentHash","sourceSetHash","contentHash","expectedEntryCount","recognizedSecondsTotal","formatVersion")
            VALUES (${f.key('late_manifest')},${targetBatch.id},${manifest.activityId},${manifest.settlementRunId},
              ${manifest.settlementVersionId},${manifest.timeRevisionId},${manifest.bucketContentHash},
              ${manifest.sourceSetHash},${manifest.contentHash},${manifest.expectedEntryCount},
              ${manifest.recognizedSecondsTotal},${manifest.formatVersion})`;
        // A successful positive insert rolls back, so the racing insert has no uniqueness conflict.
        const rollback = new Error('rollback positive late-insert fixture');
        await expect(
          f.db.$transaction(async (tx) => {
            if (scenario === 'late_entry_insert')
              await tx.participationTimeLedgerEntry.create({
                data: { ...entry, manifestId: manifest.id },
              });
            else
              await tx.participationTimeLedgerManifest.create({
                data: {
                  ...manifest,
                  id: f.key('positive_manifest'),
                  postingBatchId: targetBatch.id,
                },
              });
            throw rollback;
          }),
        ).rejects.toBe(rollback);
        let release!: () => void;
        let locked!: (pid: number) => void;
        const releasePromise = new Promise<void>((resolve) => {
          release = resolve;
        });
        const lockPromise = new Promise<number>((resolve) => {
          locked = resolve;
        });
        const holder = f.db.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "LedgerPostingBatch" WHERE id=${targetBatch.id} FOR UPDATE`;
            await tx.ledgerPostingBatch.update({
              where: { id: targetBatch.id },
              data: { statusCode: 'failed' },
            });
            const [row] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            locked(row.pid);
            await releasePromise;
          },
          { timeout: 10000 },
        );
        const pid = await lockPromise;
        const pending = Promise.resolve(insert());
        void pending.catch(() => undefined);
        try {
          let observed = false;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const [row] = await f.db.$queryRaw<{ waiting: boolean }[]>`
              SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                AND ${pid}=ANY(pg_blocking_pids(pid))) AS waiting`;
            if (row.waiting) {
              observed = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(observed).toBe(true);
        } finally {
          release();
          await holder;
        }
        await expect(pending).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
        expect(await f.db.participationTimeLedgerEntry.count()).toBe(0);
        expect(
          await f.db.participationTimeLedgerManifest.count({
            where: { postingBatchId: targetBatch.id },
          }),
        ).toBe(scenario === 'late_entry_insert' ? 1 : 0);
        expect(
          await f.db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: targetBatch.id } }),
        ).toMatchObject({ statusCode: 'failed' });
        return;
      }
      if (scenario.startsWith('anchor_')) {
        // All replacement IDs belong to a second real chain; nonexistent IDs would only
        // prove ordinary FK existence, not protection against mixing two valid chains.
        const foreign = await prepareSource();
        await recognize(foreign);
        const foreignPrepared = await post(foreign.url + '/prepare', prepareCommand(foreign));
        const foreignSubmitted = await post(foreign.url + '/submit', {
          operationKey: f.key('foreign_submit'),
          expectedDraftVersion: foreign.proof.expectedDraftVersion,
          expectedEvidenceSealId: foreign.proof.expectedEvidenceSealId,
          timeRevisionId: foreignPrepared.timeRevisionId,
          expectedBucketContentHash: foreignPrepared.bucketContentHash,
        });
        const foreignRevision = await f.db.activitySettlementTimeRevision.findUniqueOrThrow({
          where: { id: foreignSubmitted.timeRevisionId as string },
        });
        const foreignBatch = await f.db.ledgerPostingBatch.create({
          data: {
            settlementRunId: foreignRevision.settlementRunId,
            settlementVersionId: foreignRevision.settlementVersionId,
            batchRevision: 1,
            statusCode: 'preparing',
            requestKey: f.key('foreign_batch'),
          },
        });
        const ledger = f.app.get(ParticipationTimeLedgerService);
        const source = await f.db.$transaction((tx) => ledger.source(tx, batch));
        if (!source) throw new Error('Expected classified source');
        const manifest = await f.db.participationTimeLedgerManifest.findUniqueOrThrow({
          where: { postingBatchId: batch.id },
        });
        const rollback = new Error('rollback successful positive-control fixture');
        if (scenario === 'anchor_entry_bucket_set') {
          const entries = source.entries.map((row) => ({ ...row, manifestId: manifest.id }));
          expect(entries).toHaveLength(4);
          const foreignBucket = await f.db.participantSettlementTimeBucket.findFirstOrThrow({
            where: { timeRevisionId: foreignRevision.id, categoryCode: entries[0].categoryCode },
          });
          await expect(
            f.db.$transaction(async (tx) => {
              await tx.participationTimeLedgerEntry.createMany({ data: entries });
              expect(await tx.participationTimeLedgerEntry.count()).toBe(4);
              throw rollback;
            }),
          ).rejects.toBe(rollback);
          const replaced = entries.map((row, index) =>
            index === 0 ? { ...row, bucketId: foreignBucket.id } : row,
          );
          expect(replaced).toHaveLength(entries.length);
          expect(new Set(replaced.map((row) => row.bucketId)).size).toBe(4);
          await expect(
            f.db.participationTimeLedgerEntry.createMany({ data: replaced }),
          ).rejects.toMatchObject({ code: 'P2003' });
          expect(await f.db.participationTimeLedgerEntry.count()).toBe(0);
          expect(
            await f.db.participationTimeLedgerManifest.findUniqueOrThrow({
              where: { id: manifest.id },
            }),
          ).toEqual(manifest);
          expect(
            await f.db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batch.id } }),
          ).toMatchObject({ statusCode: 'preparing', preparedCount: 0 });
          await request(httpServer(f.app))
            .get(p.url + '/revisions/' + timeRevision.id + '/ledger')
            .set('Authorization', f.creator.auth)
            .expect(404);
          return;
        }
        if (scenario.startsWith('anchor_entry_')) {
          const base = { ...source.entries[0], manifestId: manifest.id };
          await expect(
            f.db.$transaction(async (tx) => {
              await tx.participationTimeLedgerEntry.create({ data: base });
              throw rollback;
            }),
          ).rejects.toBe(rollback);
          const replacement = {
            ...(scenario === 'anchor_entry_batch' ? { postingBatchId: foreignBatch.id } : {}),
            ...(scenario === 'anchor_entry_activity' ? { activityId: foreign.activityId } : {}),
            ...(scenario === 'anchor_entry_revision' ? { timeRevisionId: foreignRevision.id } : {}),
            ...(scenario === 'anchor_entry_identity'
              ? { participationIdentityId: foreign.identityId }
              : {}),
            ...(scenario === 'anchor_entry_category'
              ? { categoryCode: base.categoryCode === 'training' ? 'organization' : 'training' }
              : {}),
          };
          await expect(
            f.db.participationTimeLedgerEntry.create({ data: { ...base, ...replacement } }),
          ).rejects.toMatchObject({ code: 'P2003' });
        } else {
          const extraBatch = await f.db.ledgerPostingBatch.create({
            data: {
              settlementRunId: batch.settlementRunId,
              settlementVersionId: batch.settlementVersionId,
              batchRevision: 2,
              statusCode: 'preparing',
              requestKey: f.key('manifest_anchor_batch'),
            },
          });
          const base = { ...manifest, id: f.key('manifest_anchor'), postingBatchId: extraBatch.id };
          await expect(
            f.db.$transaction(async (tx) => {
              await tx.participationTimeLedgerManifest.create({ data: base });
              throw rollback;
            }),
          ).rejects.toBe(rollback);
          const replacement = {
            ...(scenario === 'anchor_manifest_version'
              ? { settlementVersionId: foreignRevision.settlementVersionId }
              : {}),
            ...(scenario === 'anchor_manifest_run'
              ? { settlementRunId: foreignRevision.settlementRunId }
              : {}),
            ...(scenario === 'anchor_manifest_activity' ? { activityId: foreign.activityId } : {}),
            ...(scenario === 'anchor_manifest_revision'
              ? { timeRevisionId: foreignRevision.id }
              : {}),
          };
          await expect(
            f.db.participationTimeLedgerManifest.create({ data: { ...base, ...replacement } }),
          ).rejects.toMatchObject({ code: 'P2003' });
          expect(
            await f.db.participationTimeLedgerManifest.count({
              where: { postingBatchId: extraBatch.id },
            }),
          ).toBe(0);
        }
        expect(await f.db.participationTimeLedgerEntry.count()).toBe(0);
        expect(
          await f.db.participationTimeLedgerManifest.findUniqueOrThrow({
            where: { id: manifest.id },
          }),
        ).toEqual(manifest);
        return;
      }
      if (scenario === 'auto_commit') {
        // Same production worker class and commit service; enable automatic submission only in this test instance.
        const worker = new ActivityBatchWorker(
          f.db,
          preparation,
          f.app.get(LedgerReadyBatchCommitter),
          true,
        );
        const now = new Date(Date.now() + 1000);
        const fault = jest
          .spyOn(f.app.get(LedgerPostingAuditRecorder), 'log')
          .mockRejectedValueOnce(new Error('d6-auto-audit-failure'));
        const failed = await worker.drainOnce({ now });
        fault.mockRestore();
        expect(failed).toMatchObject({
          jobId: job.jobId,
          jobClaimed: true,
          batchStatus: 'ready',
          commitAttempted: true,
          commitErrorCode: 'Error',
        });
        expect(
          await f.db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batch.id } }),
        ).toMatchObject({ statusCode: 'ready', committedAt: null });
        expect(await f.db.memberContributionDayState.count()).toBe(0);
        const beforeRetry = await f.db.participationTimeLedgerEntry.findMany({
          where: { postingBatchId: batch.id },
          orderBy: { id: 'asc' },
        });
        expect(beforeRetry).toHaveLength(4);
        const pending = await f.db.activityBatchJob.findUniqueOrThrow({ where: { id: job.jobId } });
        expect(pending.statusCode).toBe('pending');
        const succeeded = await worker.drainOnce({
          now: new Date(pending.availableAt.getTime() + 1),
        });
        expect(succeeded).toMatchObject({
          jobId: job.jobId,
          batchStatus: 'committed',
          commitAttempted: true,
          commitErrorCode: null,
        });
        expect(
          await f.db.participationTimeLedgerEntry.findMany({
            where: { postingBatchId: batch.id },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(beforeRetry);
        expect(
          await f.db.activityBatchJob.findUniqueOrThrow({ where: { id: job.jobId } }),
        ).toMatchObject({ statusCode: 'succeeded' });
        const response = await request(httpServer(f.app))
          .get(p.url + '/revisions/' + timeRevision.id + '/ledger')
          .set('Authorization', f.creator.auth)
          .expect(200);
        expect(response.body.data).toMatchObject({
          postingBatchId: batch.id,
          entryCount: 4,
          recognizedSecondsTotal: '3600',
        });
        await worker.onModuleDestroy();
        return;
      }
      if (scenario === 'invisible_failed' || scenario === 'invisible_voided') {
        for (const item of items) await preparation.prepareChunk(job.jobId, item.id);
        expect((await preparation.finalize(job.jobId)).batchStatus).toBe('ready');
        const statusCode = scenario === 'invisible_failed' ? 'failed' : 'voided';
        // Deliberately construct each terminal fixture state; do not add a transition API.
        await f.db.ledgerPostingBatch.update({ where: { id: batch.id }, data: { statusCode } });
        expect(
          await f.db.participationTimeLedgerEntry.count({ where: { postingBatchId: batch.id } }),
        ).toBe(4);
        const response = await request(httpServer(f.app))
          .get(p.url + '/revisions/' + timeRevision.id + '/ledger')
          .set('Authorization', f.creator.auth)
          .expect(404);
        expect(response.body.code).toBe(20230);
        expect(response.body.data).toBeNull();
        return;
      }
      if (!normalPreparation) {
        const ledger = f.app.get(ParticipationTimeLedgerService);
        jest
          .spyOn(ledger, 'prepareIdentities')
          .mockImplementationOnce(async (tx, target, identities) => {
            const source = await ledger.source(tx, target);
            const manifest = await ledger.ensureManifest(tx, target);
            if (!source || !manifest) throw new Error('Expected classified fixture');
            let entries = source.entries.filter((row) =>
              identities.includes(row.participationIdentityId),
            );
            expect(entries).toHaveLength(4);
            if (scenario === 'missing_entry') entries = entries.slice(1);
            else
              entries = entries.map((row, index) =>
                index === 0
                  ? {
                      ...row,
                      ...(scenario === 'wrong_hash'
                        ? { contentHash: 'f'.repeat(64) }
                        : scenario === 'wrong_amount'
                          ? { recognizedSeconds: row.recognizedSeconds + 1 }
                          : { entryKey: 'e'.repeat(64) }),
                    }
                  : row,
              );
            await tx.participationTimeLedgerEntry.createMany({
              data: entries.map((row) => ({ ...row, manifestId: manifest.id })),
            });
          });
      }
      if (scenario === 'wrong_amount') {
        expect(items).toHaveLength(1);
        await expect(preparation.prepareChunk(job.jobId, items[0].id)).rejects.toMatchObject({
          code: 'P2003',
        });
        expect(
          await f.db.participationTimeLedgerEntry.count({ where: { postingBatchId: batch.id } }),
        ).toBe(0);
        expect(
          await f.db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batch.id } }),
        ).toMatchObject({ statusCode: 'preparing', preparedCount: 0 });
        return;
      }
      if (normalPreparation) {
        const currentFence = { leaseOwner: 'd6-current-worker', leaseGeneration: 2 };
        // Persist a newer lease generation; an old process must fail before any chunk write.
        await f.db.activityBatchJob.update({ where: { id: job.jobId }, data: currentFence });
        const jobBefore = await f.db.activityBatchJob.findUniqueOrThrow({
          where: { id: job.jobId },
        });
        await expect(
          preparation.prepareChunk(job.jobId, items[0].id, {
            leaseOwner: 'd6-old-worker',
            leaseGeneration: 1,
          }),
        ).rejects.toBeInstanceOf(LedgerPrepareLeaseLostError);
        expect(await f.db.activityBatchJob.findUniqueOrThrow({ where: { id: job.jobId } })).toEqual(
          jobBefore,
        );
        expect(
          await f.db.participationTimeLedgerEntry.count({ where: { postingBatchId: batch.id } }),
        ).toBe(0);
        for (const item of items) {
          await preparation.prepareChunk(job.jobId, item.id, currentFence);
          const beforeReplay = await f.db.participationTimeLedgerEntry.findMany({
            where: { postingBatchId: batch.id },
            orderBy: { id: 'asc' },
          });
          expect((await preparation.prepareChunk(job.jobId, item.id, currentFence)).skipped).toBe(
            true,
          );
          expect(
            await f.db.participationTimeLedgerEntry.findMany({
              where: { postingBatchId: batch.id },
              orderBy: { id: 'asc' },
            }),
          ).toEqual(beforeReplay);
          // A completed item does not permit an expired fence to bypass the check on replay.
          await expect(
            preparation.prepareChunk(job.jobId, item.id, {
              leaseOwner: 'd6-old-worker',
              leaseGeneration: 1,
            }),
          ).rejects.toBeInstanceOf(LedgerPrepareLeaseLostError);
        }
        const preparedEntries = await f.db.participationTimeLedgerEntry.findMany({
          where: { postingBatchId: batch.id },
          orderBy: { id: 'asc' },
        });
        // Reproduce durable state after a worker stopped between its last chunk and finalization.
        await f.db.activityBatchJob.update({
          where: { id: job.jobId },
          data: { leaseExpiresAt: new Date(0) },
        });
        const recovered = await f.app.get(ActivityBatchWorker).drainOnce();
        expect(recovered).toMatchObject({
          jobClaimed: true,
          jobId: job.jobId,
          batchStatus: 'ready',
          commitAttempted: false,
        });
        const recoveredJob = await f.db.activityBatchJob.findUniqueOrThrow({
          where: { id: job.jobId },
        });
        expect(recoveredJob.statusCode).toBe('succeeded');
        expect(recoveredJob.leaseGeneration).toBeGreaterThan(currentFence.leaseGeneration);
        expect(
          await f.db.participationTimeLedgerEntry.findMany({
            where: { postingBatchId: batch.id },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(preparedEntries);
      } else {
        for (const item of items) await preparation.prepareChunk(job.jobId, item.id);
      }
      if (!normalPreparation) {
        await expect(preparation.finalize(job.jobId)).rejects.toMatchObject({
          biz: { code: scenario === 'missing_entry' ? 20228 : 20227, httpStatus: 409 },
        });
        if (scenario === 'missing_entry') {
          await expect(f.db.$executeRaw`
            UPDATE "LedgerPostingBatch" SET "statusCode" = 'ready' WHERE id = ${batch.id}
          `).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
        }
        expect(
          await f.db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batch.id } }),
        ).toMatchObject({ statusCode: 'preparing' });
        expect(
          await f.db.participationTimeLedgerEntry.count({ where: { postingBatchId: batch.id } }),
        ).toBe(scenario === 'missing_entry' ? 3 : 4);
        await request(httpServer(f.app))
          .get(p.url + '/revisions/' + timeRevision.id + '/ledger')
          .set('Authorization', f.creator.auth)
          .expect(404);
        return;
      }
      expect((await preparation.finalize(job.jobId)).batchStatus).toBe('ready');
      const manifest = await f.db.participationTimeLedgerManifest.findUniqueOrThrow({
        where: { postingBatchId: batch.id },
      });
      expect(manifest.expectedEntryCount).toBe(4);
      expect(
        await f.db.participationTimeLedgerEntry.count({
          where: { manifestId: manifest.id, recognizedSeconds: 0 },
        }),
      ).toBe(3);
      const ledgerUrl = p.url + '/revisions/' + timeRevision.id + '/ledger';
      await request(httpServer(f.app))
        .get(ledgerUrl)
        .set('Authorization', f.creator.auth)
        .expect(404);
      const posting = f.app.get(LedgerPostingService);
      const commitInput = { postingBatchId: batch.id, operationKey: f.key('commit') };
      await expect(posting.commitBatch(commitInput, actor, meta)).rejects.toMatchObject({
        biz: { code: 40300, httpStatus: 403 },
      });
      // A cached caller payload cannot preserve eligibility after the current identity changes.
      await f.db.user.update({ where: { id: finalActor.id }, data: { status: 'DISABLED' } });
      await expect(posting.commitBatch(commitInput, finalActor, meta)).rejects.toMatchObject({
        biz: { code: 40100, httpStatus: 401 },
      });
      await f.db.user.update({ where: { id: finalActor.id }, data: { status: 'ACTIVE' } });
      await f.db.member.update({
        where: { id: f.reviewer.memberId },
        data: { status: 'INACTIVE' },
      });
      await expect(posting.commitBatch(commitInput, finalActor, meta)).rejects.toMatchObject({
        biz: { code: 40300, httpStatus: 403 },
      });
      await f.db.member.update({
        where: { id: f.reviewer.memberId },
        data: { status: 'ACTIVE' },
      });
      const stateBefore = await f.db.memberContributionDayState.findMany({
        orderBy: { id: 'asc' },
      });
      const runBefore = await f.db.attendanceSettlementRun.findUniqueOrThrow({
        where: { id: timeRevision.settlementRunId },
      });
      const batchBefore = await f.db.ledgerPostingBatch.findUniqueOrThrow({
        where: { id: batch.id },
      });
      const resultsBefore = await f.db.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: timeRevision.settlementVersionId },
        orderBy: { id: 'asc' },
      });
      const audit = f.app.get(LedgerPostingAuditRecorder);
      // Force commit past its initial authorization and into the existing member lock.
      let releaseMember!: () => void;
      let memberLocked!: (pid: number) => void;
      const memberRelease = new Promise<void>((resolve) => {
        releaseMember = resolve;
      });
      const memberReady = new Promise<number>((resolve) => {
        memberLocked = resolve;
      });
      const memberHolder = f.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${f.creator.memberId}))::text`;
          const [connection] = await tx.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          memberLocked(connection.pid);
          await memberRelease;
        },
        { timeout: 10000 },
      );
      const memberPid = await Promise.race([
        memberReady,
        memberHolder.then(() => {
          throw new Error('member lock ended early');
        }),
      ]);
      const revokedCommit = posting.commitBatch(commitInput, finalActor, meta);
      void revokedCommit.catch(() => undefined);
      try {
        let observed = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const [row] = await f.db.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND ${memberPid} = ANY(pg_blocking_pids(pid))) AS waiting
        `;
          if (row.waiting) {
            observed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(observed).toBe(true);
        if (scenario === 'complete_user_disabled_while_waiting') {
          await f.db.user.update({ where: { id: finalActor.id }, data: { status: 'DISABLED' } });
        } else if (scenario === 'complete_member_inactive_while_waiting') {
          await f.db.member.update({
            where: { id: f.reviewer.memberId },
            data: { status: 'INACTIVE' },
          });
        } else if (scenario === 'complete_organization_inactive_while_waiting') {
          await f.db.organization.update({
            where: { id: f.organizationId },
            data: { status: 'INACTIVE' },
          });
        } else {
          await f.db.roleBinding.updateMany({
            where: { principalId: finalActor.id, roleId: finalRole.id },
            data: { deletedAt: new Date() },
          });
        }
      } finally {
        releaseMember();
        await memberHolder;
      }
      await expect(revokedCommit).rejects.toMatchObject({
        biz:
          scenario === 'complete_user_disabled_while_waiting'
            ? { code: 40100, httpStatus: 401 }
            : { code: 40300, httpStatus: 403 },
      });
      expect(await f.db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batch.id } })).toEqual(
        batchBefore,
      );
      expect(await f.db.memberContributionDayState.findMany({ orderBy: { id: 'asc' } })).toEqual(
        stateBefore,
      );
      if (scenario !== 'complete') {
        expect(
          await f.db.attendanceSettlementRun.findUniqueOrThrow({
            where: { id: timeRevision.settlementRunId },
          }),
        ).toEqual(runBefore);
        expect(
          await f.db.participantSettlementResultRevision.findMany({
            where: { settlementVersionId: timeRevision.settlementVersionId },
            orderBy: { id: 'asc' },
          }),
        ).toEqual(resultsBefore);
        return;
      }
      await f.db.roleBinding.updateMany({
        where: { principalId: finalActor.id, roleId: finalRole.id },
        data: { deletedAt: null },
      });
      const failure = jest
        .spyOn(audit, 'log')
        .mockRejectedValueOnce(new Error('d6-final-audit-failure'));
      await expect(posting.commitBatch(commitInput, finalActor, meta)).rejects.toThrow(
        'd6-final-audit-failure',
      );
      failure.mockRestore();
      expect(await f.db.memberContributionDayState.findMany({ orderBy: { id: 'asc' } })).toEqual(
        stateBefore,
      );
      expect(
        await f.db.attendanceSettlementRun.findUniqueOrThrow({
          where: { id: timeRevision.settlementRunId },
        }),
      ).toEqual(runBefore);
      expect(await f.db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batch.id } })).toEqual(
        batchBefore,
      );
      expect(
        await f.db.participantSettlementResultRevision.findMany({
          where: { settlementVersionId: timeRevision.settlementVersionId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(resultsBefore);
      await request(httpServer(f.app))
        .get(ledgerUrl)
        .set('Authorization', f.creator.auth)
        .expect(404);
      let unlock!: () => void;
      let locked!: (pid: number) => void;
      const unlocked = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const lockReady = new Promise<number>((resolve) => {
        locked = resolve;
      });
      const holder = f.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "LedgerPostingBatch" WHERE id = ${batch.id} FOR UPDATE`;
          const [connection] = await tx.$queryRaw<
            { pid: number }[]
          >`SELECT pg_backend_pid() AS pid`;
          locked(connection.pid);
          await unlocked;
        },
        { timeout: 10000 },
      );
      const holderPid = await Promise.race([
        lockReady,
        holder.then(() => {
          throw new Error('lock holder ended early');
        }),
      ]);
      const racing = Promise.all([
        posting.commitBatch(commitInput, finalActor, meta),
        posting.commitBatch(commitInput, finalActor, meta),
      ]);
      // Capture rejection immediately while the observer confirms a real PostgreSQL lock wait.
      void racing.catch(() => undefined);
      try {
        let observed = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const [row] = await f.db.$queryRaw<{ waiting: boolean }[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND ${holderPid} = ANY(pg_blocking_pids(pid))) AS waiting
        `;
          if (row.waiting) {
            observed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(observed).toBe(true);
      } finally {
        unlock();
        await holder;
      }
      const commits = await racing;
      expect(commits.map((row) => row.replayed).sort()).toEqual([false, true]);
      const committed = commits[0];
      expect(committed.batchStatus).toBe('committed');
      const response = await request(httpServer(f.app))
        .get(ledgerUrl)
        .query({ page: 1, pageSize: 2 })
        .set('Authorization', f.creator.auth)
        .expect(200);
      expect(response.body.data).toMatchObject({
        postingBatchId: batch.id,
        manifestId: manifest.id,
        contentHash: manifest.contentHash,
        recognizedSecondsTotal: '3600',
        entryCount: 4,
        resultPage: { page: 1, pageSize: 2, total: 4 },
      });
      expect(response.body.data.resultPage.items).toHaveLength(2);
      // Existing correction authorization is GLOBAL, unlike the classified final-review scope.
      // Grant it explicitly in this fixture so the category guard, not missing permission, rejects.
      await f.db.roleBinding.create({
        data: {
          principalType: PrincipalType.USER,
          principalId: finalActor.id,
          roleId: finalRole.id,
          scopeType: BindingScopeType.GLOBAL,
        },
      });
      const correctionRequest = await f.db.attendanceCorrectionRequest.create({
        data: {
          activityId: p.activityId,
          settlementRunId: timeRevision.settlementRunId,
          baseSettlementVersionId: timeRevision.settlementVersionId,
          baseClosureRevision: 1,
          requestTypeCode: 'time',
          requestedChangeJson: {
            schemaVersion: CORRECTION_CHANGE_SCHEMA_VERSION,
            results: [
              {
                participationIdentityId: resultsBefore[0].participationIdentityId,
                resultCode: 'present',
                recognizedServiceHours: '2.00',
                recognizedContributionPoints: '0.00',
                adjustmentReason: 'D6 category protection fixture',
                lateFlag: false,
                earlyLeaveFlag: false,
              },
            ],
            segments: [],
          },
          reason: 'D6 classified correction guard fixture',
          statusCode: 'approved',
          submittedByUserId: actor.id,
          submittedAt: START,
          reviewedByUserId: finalActor.id,
          reviewedAt: END,
        },
      });
      expect(() => parseCorrectionChangeSet(correctionRequest.requestedChangeJson)).not.toThrow();
      const correction = f.app.get(CorrectionApplicationService);
      const correctionInput = {
        correctionRequestId: correctionRequest.id,
        operationKey: f.key('classified_correction'),
        requestHash: 'd6-classified-correction-guard',
      };
      const correctionSnapshot = () =>
        Promise.all([
          f.db.ledgerPostingBatch.findUniqueOrThrow({ where: { id: batch.id } }),
          f.db.attendanceSettlementRun.findUniqueOrThrow({
            where: { id: timeRevision.settlementRunId },
          }),
          f.db.memberContributionDayState.findMany({ orderBy: { id: 'asc' } }),
          f.db.participationTimeLedgerEntry.findMany({ orderBy: { id: 'asc' } }),
          f.db.attendanceCorrectionRequest.findUniqueOrThrow({
            where: { id: correctionRequest.id },
          }),
        ]);
      const correctionBefore = await correctionSnapshot();
      await expect(correction.prepare(correctionInput, finalActor, meta)).rejects.toMatchObject({
        biz: { code: 20229, httpStatus: 409 },
      });
      await expect(correction.commit(correctionInput, finalActor, meta)).rejects.toMatchObject({
        biz: { code: 20229, httpStatus: 409 },
      });
      expect(await correctionSnapshot()).toEqual(correctionBefore);
      // Construct the forbidden internal linkage in a transaction: the shared posting
      // entry must reject even a committed-batch replay, before returning its old result.
      await expect(
        runMemberLinearizedTransaction(f.db, async (tx) => {
          const application = await tx.correctionApplication.create({
            data: {
              correctionRequestId: correctionRequest.id,
              newSettlementVersionId: timeRevision.settlementVersionId,
              newResultRevisionIds: resultsBefore.map((row) => row.id),
              newPostingBatchId: batch.id,
              statusCode: 'committed',
            },
          });
          await tx.correctionSegmentPreparationReceipt.create({
            data: { applicationId: application.id, preparedSegmentCount: 0 },
          });
          // Prove this fixture satisfies deferred SQL constraints before exercising the guard.
          await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
          return posting.commitBatchWithin(tx, p.activityId, commitInput, finalActor, meta);
        }),
      ).rejects.toMatchObject({ biz: { code: 20229, httpStatus: 409 } });
      expect(await correctionSnapshot()).toEqual(correctionBefore);
      expect(
        await f.db.correctionApplication.count({
          where: { correctionRequestId: correctionRequest.id },
        }),
      ).toBe(0);
      const readPermission = await f.db.permission.findUniqueOrThrow({
        where: { code: 'activity.time-settlement.read' },
      });
      await f.db.rolePermission.create({
        data: { roleId: finalRole.id, permissionId: readPermission.id },
      });
      const historicalBefore = await request(httpServer(f.app))
        .get(ledgerUrl)
        .set('Authorization', f.reviewer.auth)
        .expect(200);
      const prior = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: timeRevision.settlementVersionId },
      });
      // A later draft is deliberately authored by this reviewer, so latest-version review
      // eligibility cannot stand in for the explicitly requested historical version.
      const newer = await f.db.attendanceSettlementVersion.create({
        data: {
          settlementRunId: prior.settlementRunId,
          version: prior.version + 1,
          evidenceSealId: prior.evidenceSealId,
          evidenceRevision: prior.evidenceRevision,
          populationRevision: prior.populationRevision,
          workflowRevision: prior.workflowRevision,
          contentHash: prior.contentHash,
          personCount: prior.personCount,
          sessionParticipationCount: prior.sessionParticipationCount,
          serviceSegmentCount: prior.serviceSegmentCount,
          createdByUserId: finalActor.id,
          statusCode: 'draft',
          priorVersionId: prior.id,
        },
      });
      await f.db.attendanceSettlementRun.update({
        where: { id: prior.settlementRunId },
        data: { currentDraftVersion: newer.version },
      });
      await expect(
        f.db.$transaction((tx) =>
          f.app
            .get(ActivityTimeSettlementAccessService)
            .authorize(tx, finalActor, p.activityId, 'read'),
        ),
      ).rejects.toMatchObject({ biz: { code: 20219, httpStatus: 404 } });
      const historicalAfter = await request(httpServer(f.app))
        .get(ledgerUrl)
        .set('Authorization', f.reviewer.auth)
        .expect(200);
      expect(historicalAfter.body.data).toEqual(historicalBefore.body.data);
      expect(historicalAfter.body.data).toMatchObject({
        timeRevisionId: timeRevision.id,
        postingBatchId: batch.id,
        contentHash: manifest.contentHash,
      });
      expect((await posting.commitBatch(commitInput, finalActor, meta)).batchStatus).toBe(
        'committed',
      );
      expect(
        await f.db.participationTimeLedgerEntry.count({ where: { manifestId: manifest.id } }),
      ).toBe(4);
      await expect(posting.commitBatch(commitInput, actor, meta)).rejects.toMatchObject({
        biz: { code: 40300, httpStatus: 403 },
      });
      const entriesBefore = await f.db.participationTimeLedgerEntry.findMany({
        where: { manifestId: manifest.id },
        orderBy: { id: 'asc' },
      });
      // These are rejected mutations of this isolated fixture, never cleanup or business deletion.
      await expect(f.db.$executeRaw`
      UPDATE "ParticipationTimeLedgerManifest" SET "formatVersion" = "formatVersion"
      WHERE id = ${manifest.id}
    `).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
      await expect(f.db.$executeRaw`
      DELETE FROM "ParticipationTimeLedgerManifest" WHERE id = ${manifest.id}
    `).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
      await expect(f.db.$executeRaw`
      UPDATE "ParticipationTimeLedgerEntry" SET "recognizedSeconds" = "recognizedSeconds"
      WHERE "manifestId" = ${manifest.id}
    `).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
      await expect(f.db.$executeRaw`
      DELETE FROM "ParticipationTimeLedgerEntry" WHERE "manifestId" = ${manifest.id}
    `).rejects.toMatchObject({ code: 'P2010', meta: { code: '23514' } });
      expect(
        await f.db.participationTimeLedgerManifest.findUniqueOrThrow({
          where: { id: manifest.id },
        }),
      ).toEqual(manifest);
      await f.db.roleBinding.updateMany({
        where: { principalId: finalActor.id, roleId: finalRole.id },
        data: { deletedAt: new Date() },
      });
      await expect(posting.commitBatch(commitInput, finalActor, meta)).rejects.toMatchObject({
        biz: { code: 40300, httpStatus: 403 },
      });
      expect(
        await f.db.participationTimeLedgerEntry.findMany({
          where: { manifestId: manifest.id },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(entriesBefore);
    },
    120000,
  );
});
