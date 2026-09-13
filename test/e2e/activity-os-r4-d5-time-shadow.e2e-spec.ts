import {
  BindingScopeType,
  PrincipalType,
  Role,
  UserStatus,
  MemberStatus,
  Prisma,
} from '@prisma/client';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { ActivityTimeSettlementAccessService } from '../../src/modules/activities/activity-time-settlement-access.service';
import { ActivityTimeSettlementQueryService } from '../../src/modules/activities/activity-time-settlement-query.service';
import { ParticipationSegmentFacade } from '../../src/modules/attendances/participation-segment.facade';
import { assertConnectedTestDatabase } from '../setup/test-db';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import {
  buildActivityTimeAllocationManifest,
  type ActivityTimeAllocationSliceInput,
} from '../../src/modules/activities/activity-time-allocation-command';

class ObservedShadowDatabase extends PrismaClient<Prisma.PrismaClientOptions, 'query'> {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { EvidenceSealService } from '../../src/modules/activities/evidence-seal.service';
import {
  SettlementDraftService,
  type SettlementDraftResult,
} from '../../src/modules/activities/settlement-draft.service';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import type { TimePolicyDefinition } from '../../src/modules/activities/activity-time-policy-definition';
import type { AppTimeShadowReportDto } from '../../src/modules/activities/dto/app/app-activity-time-settlement.dto';
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

describe('D5 shadow: real submitted version through App HTTP', () => {
  let f: D13Fixture;
  let actor: CurrentUserPayload;
  const meta = { requestId: 'd5-e2e', ip: null, ua: null };
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  beforeAll(async () => {
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
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
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

  // Snapshot every public table, including row contents rather than only row counts.
  // Identifiers come exclusively from PostgreSQL's catalog and are quoted before use.
  async function databaseSnapshot() {
    const tables = await f.db.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
    expect(tables.length).toBeGreaterThan(100);
    const snapshots: Record<string, unknown> = {};
    for (const { tablename } of tables) {
      const identifier = '"' + tablename.replace(/"/g, '""') + '"';
      snapshots[tablename] = await f.db.$queryRawUnsafe(
        `SELECT count(*)::text AS count, md5(COALESCE(string_agg(row_value, E'\\n' ORDER BY row_value), '')) AS fingerprint FROM (SELECT to_jsonb(t)::text AS row_value FROM public.${identifier} t) rows`,
      );
    }
    return snapshots;
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

  async function submittedSource() {
    const p = await prepareSource();
    await recognize(p);
    const prepared = await post(p.url + '/prepare', prepareCommand(p));
    const submitted = await post(p.url + '/submit', {
      operationKey: f.key('shadow_submit'),
      expectedDraftVersion: p.proof.expectedDraftVersion,
      expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
      timeRevisionId: prepared.timeRevisionId,
      expectedBucketContentHash: prepared.bucketContentHash,
    });
    return { p, prepared, submitted };
  }

  it('bounds actual SQL at 1/100/2000 identities with valid full-capacity sources', async () => {
    const observed = new ObservedShadowDatabase({ log: [{ emit: 'event', level: 'query' }] });
    let statements: string[] = [];
    observed.$on('query', (event) => {
      statements.push(event.query);
    });
    const measurements: {
      population: number;
      queries: number;
      businessQueries: number;
      healthChecks: number;
      elapsedMs: number;
    }[] = [];
    try {
      await assertConnectedTestDatabase(observed);
      const queries = new ActivityTimeSettlementQueryService(
        observed,
        f.app.get(ActivityTimeSettlementAccessService),
        f.app.get(ParticipationSegmentFacade),
      );
      for (const population of [1, 100, 2000]) {
        const p = await createCapacitySource(population);
        const prepared = await post(p.url + '/prepare', prepareCommand(p));
        const submitted = await post(p.url + '/submit', {
          operationKey: f.key('scale_submit'),
          expectedDraftVersion: p.proof.expectedDraftVersion,
          expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
          timeRevisionId: prepared.timeRevisionId,
          expectedBucketContentHash: prepared.bucketContentHash,
        });
        const timeRevisionId = submitted.timeRevisionId as string;
        expect(
          await f.db.participantSettlementTimeBucket.count({ where: { timeRevisionId } }),
        ).toBe(population * 4);
        if (population === 2000) {
          expect(
            await f.db.participantTimeAllocationRevision.count({
              where: { activityId: p.activityId },
            }),
          ).toBe(10000);
          expect(
            await f.db.participantTimeAllocationSlice.count({
              where: { activityId: p.activityId },
            }),
          ).toBe(50000);
          expect(
            await f.db.participantSettlementTimeBucketSource.count({ where: { timeRevisionId } }),
          ).toBe(40000);
        }
        statements = [];
        const started = performance.now();
        const report = await queries.shadow(
          p.activityId,
          timeRevisionId,
          { page: 1, pageSize: 100 },
          actor,
        );
        const elapsedMs = Math.round(performance.now() - started);
        const reads = statements.filter(
          (sql) => !/^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/i.test(sql),
        );
        // Prisma may issue SELECT 1 after the connection sits idle during source preparation.
        // Keep it in the total budget; compare population-dependent SQL separately.
        const healthChecks = reads.filter((sql) => /^\s*SELECT 1\s*;?\s*$/i.test(sql)).length;
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((sql) => /^\s*(SELECT|WITH)\b/i.test(sql))).toBe(true);
        expect(
          statements.some((sql) => /\b(INSERT INTO|UPDATE\s+"|DELETE FROM|TRUNCATE)\b/i.test(sql)),
        ).toBe(false);
        expect(reads.length).toBeLessThanOrEqual(120);
        expect(elapsedMs).toBeLessThan(30000);
        expect(report.summary.total).toBe(population);
        expect(
          report.summary.matched + report.summary.different + report.summary.notComparable,
        ).toBe(population);
        expect(report.resultPage.items).toHaveLength(Math.min(100, population));
        const last = await queries.shadow(
          p.activityId,
          timeRevisionId,
          { page: Math.ceil(population / 100), pageSize: 100 },
          actor,
        );
        expect(last.inputFingerprint).toBe(report.inputFingerprint);
        expect(last.summary).toEqual(report.summary);
        measurements.push({
          population,
          queries: reads.length,
          businessQueries: reads.length - healthChecks,
          healthChecks,
          elapsedMs,
        });
      }
      console.info('D5 actual SQL including authorization:', JSON.stringify(measurements));
      expect(new Set(measurements.map((row) => row.businessQueries)).size).toBe(1);
    } finally {
      await observed.$disconnect();
    }
  }, 600000);

  it('returns same-version equality, stable pages and unchanged stored values and audit', async () => {
    const { p, prepared, submitted } = await submittedSource();
    const allTablesBefore = await databaseSnapshot();
    const before = await f.db.participantSettlementResultRevision.findMany({
      where: { settlementVersionId: submitted.settlementVersionId as string },
    });
    const auditBefore = await f.db.auditLog.count();
    const bucketBefore = await f.db.participantSettlementTimeBucket.findMany({
      where: { timeRevisionId: submitted.timeRevisionId as string },
    });
    const path = p.url + '/revisions/' + String(submitted.timeRevisionId) + '/shadow';
    const response = await request(httpServer(f.app))
      .get(path)
      .set('Authorization', f.creator.auth)
      .expect(200);
    expect(response.body.code).toBe(0);
    const report = response.body.data as AppTimeShadowReportDto;
    expect(report).toMatchObject({
      activityId: p.activityId,
      settlementVersionId: submitted.settlementVersionId,
      timeRevisionId: submitted.timeRevisionId,
      summary: { total: 1, matched: 1, different: 0, notComparable: 0, empty: false },
    });
    expect(report.resultPage).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(report.resultPage.items[0]).toMatchObject({
      participationIdentityId: p.identityId,
      legacyCalculatedSeconds: 3600,
      legacyRecognizedSeconds: 3600,
      calculatedDifferenceSeconds: 0,
      recognizedDifferenceSeconds: 0,
    });
    const page2 = await request(httpServer(f.app))
      .get(path + '?page=2&pageSize=1')
      .set('Authorization', f.creator.auth)
      .expect(200);
    expect(page2.body.data.inputFingerprint).toBe(report.inputFingerprint);
    expect(page2.body.data.summary).toEqual(report.summary);
    expect(page2.body.data.resultPage).toEqual({ items: [], total: 1, page: 2, pageSize: 1 });
    expect(
      await f.db.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: submitted.settlementVersionId as string },
      }),
    ).toEqual(before);
    expect(
      await f.db.participantSettlementTimeBucket.findMany({
        where: { timeRevisionId: submitted.timeRevisionId as string },
      }),
    ).toEqual(bucketBefore);
    expect(await f.db.auditLog.count()).toBe(auditBefore);
    expect(await databaseSnapshot()).toEqual(allTablesBefore);
    const invalid = await request(httpServer(f.app))
      .get(p.url + '/revisions/' + String(prepared.timeRevisionId) + '/shadow')
      .set('Authorization', f.creator.auth);
    expect({ status: invalid.status, code: invalid.body.code }).toEqual({
      status: 404,
      code: BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE.code,
    });
  });

  it('binds reviewer access and report content to history even after a later self-created version', async () => {
    const { p, submitted } = await submittedSource();
    const path = p.url + '/revisions/' + String(submitted.timeRevisionId) + '/shadow';
    // A regular member with unrelated review permissions cannot see the report.
    const ordinary = await request(httpServer(f.app))
      .get(path)
      .set('Authorization', f.reviewer.auth);
    expect(ordinary.status).toBe(404);
    const role = await f.db.rbacRole.create({
      data: { code: f.key('shadow_reviewer'), displayName: 'D5 explicit review fixture' },
    });
    for (const code of [
      'activity.time-settlement.read',
      'activity.settlement-first-review.record',
    ]) {
      const permission = await f.db.permission.upsert({
        where: { code },
        update: {},
        create: { code, module: 'activity', action: 'read', resourceType: 'settlement' },
      });
      await f.db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    }
    const binding = await f.db.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: f.reviewer.id,
        roleId: role.id,
        scopeType: BindingScopeType.ORGANIZATION,
        scopeOrgId: f.organizationId,
      },
    });
    try {
      const before = await request(httpServer(f.app))
        .get(path)
        .set('Authorization', f.reviewer.auth)
        .expect(200);
      const previous = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
        where: { id: submitted.settlementVersionId as string },
      });
      await f.db.attendanceSettlementVersion.create({
        data: {
          ...previous,
          id: f.key('later_self_version'),
          version: previous.version + 1,
          priorVersionId: previous.id,
          createdByUserId: f.reviewer.id,
          operationKey: null,
          requestHash: null,
        },
      });
      const historical = await request(httpServer(f.app))
        .get(path)
        .set('Authorization', f.reviewer.auth)
        .expect(200);
      expect(historical.body.data).toEqual(before.body.data);
      const current = await request(httpServer(f.app))
        .get(p.url)
        .set('Authorization', f.reviewer.auth);
      expect(current.status).toBe(404);
      expect(current.body.code).toBe(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE.code);
      const otherOrganization = await f.db.organization.findFirstOrThrow({
        where: { id: { not: f.organizationId }, deletedAt: null },
      });
      await f.db.roleBinding.update({
        where: { id: binding.id },
        data: { scopeOrgId: otherOrganization.id },
      });
      const outside = await request(httpServer(f.app))
        .get(path)
        .set('Authorization', f.reviewer.auth);
      expect(outside.status).toBe(404);
      expect(outside.body.data).toBeNull();
    } finally {
      await f.db.roleBinding.update({ where: { id: binding.id }, data: { deletedAt: new Date() } });
    }
  });

  it('rejects cross-activity anchors and malformed pagination', async () => {
    const { p, submitted } = await submittedSource();
    const other = await prepareSource();
    const response = await request(httpServer(f.app))
      .get(other.url + '/revisions/' + String(submitted.timeRevisionId) + '/shadow')
      .set('Authorization', f.creator.auth);
    expect({ status: response.status, code: response.body.code }).toEqual({
      status: 404,
      code: BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE.code,
    });
    await request(httpServer(f.app))
      .get(p.url + '/revisions/' + String(submitted.timeRevisionId) + '/shadow?pageSize=101')
      .set('Authorization', f.creator.auth)
      .expect(400);
  });

  it('rechecks current user status for a historical report and never returns cached content', async () => {
    const { p, submitted } = await submittedSource();
    const path = p.url + '/revisions/' + String(submitted.timeRevisionId) + '/shadow';
    await request(httpServer(f.app)).get(path).set('Authorization', f.creator.auth).expect(200);
    const previous = await f.db.user.findUniqueOrThrow({ where: { id: actor.id } });
    try {
      await f.db.user.update({ where: { id: actor.id }, data: { status: UserStatus.DISABLED } });
      const denied = await request(httpServer(f.app))
        .get(path)
        .set('Authorization', f.creator.auth);
      expect(denied.status).toBe(401);
      expect(denied.body.data).toBeNull();
    } finally {
      await f.db.user.update({ where: { id: actor.id }, data: { status: previous.status } });
    }
  });

  it('rejects inactive members and revoked explicit grants without caching a previous report', async () => {
    const { p, submitted } = await submittedSource();
    const path = p.url + '/revisions/' + String(submitted.timeRevisionId) + '/shadow';
    const member = await f.db.member.findUniqueOrThrow({ where: { id: f.creator.memberId } });
    try {
      await f.db.member.update({
        where: { id: member.id },
        data: { status: MemberStatus.INACTIVE },
      });
      const denied = await request(httpServer(f.app))
        .get(path)
        .set('Authorization', f.creator.auth);
      expect(denied.status).toBe(403);
      expect(denied.body.data).toBeNull();
    } finally {
      await f.db.member.update({ where: { id: member.id }, data: { status: member.status } });
    }
    const bindings = await f.db.roleBinding.findMany({
      where: {
        principalId: actor.id,
        deletedAt: null,
        role: {
          rolePermissions: { some: { permission: { code: 'activity.time-settlement.read' } } },
        },
      },
    });
    expect(bindings.length).toBeGreaterThan(0);
    try {
      await f.db.roleBinding.updateMany({
        where: { id: { in: bindings.map((row) => row.id) } },
        data: { deletedAt: new Date() },
      });
      const denied = await request(httpServer(f.app))
        .get(path)
        .set('Authorization', f.creator.auth);
      expect(denied.status).toBe(404);
      expect(denied.body.code).toBe(BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE.code);
      expect(denied.body.data).toBeNull();
    } finally {
      for (const binding of bindings)
        await f.db.roleBinding.update({
          where: { id: binding.id },
          data: { deletedAt: binding.deletedAt },
        });
    }
    await request(httpServer(f.app)).get(path).set('Authorization', f.creator.auth).expect(200);
  });
});
