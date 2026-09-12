import {
  BindingScopeType,
  PrincipalType,
  Role,
  UserStatus,
  Prisma,
  PrismaClient,
  type ActivitySettlementTimeRevision,
  type ParticipantSettlementTimeBucket,
  type ParticipantSettlementTimeBucketSource,
} from '@prisma/client';
import { fingerprintMetricEnvelope } from '../../src/modules/activities/activity-metric-definition';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import { ActivityTimeAllocationService } from '../../src/modules/activities/activity-time-allocation.service';
import { ActivityTimeSettlementAccessService } from '../../src/modules/activities/activity-time-settlement-access.service';
import { ActivityTimeSettlementQueryService } from '../../src/modules/activities/activity-time-settlement-query.service';
import { SettlementSubmitService } from '../../src/modules/activities/settlement-submit.service';
import { ParticipationSegmentFacade } from '../../src/modules/attendances/participation-segment.facade';
import { assertConnectedTestDatabase } from '../setup/test-db';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { EvidenceSealService } from '../../src/modules/activities/evidence-seal.service';
import {
  SettlementDraftService,
  type SettlementDraftResult,
} from '../../src/modules/activities/settlement-draft.service';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { ActivityTimeSettlementAuditRecorder } from '../../src/modules/activities/activity-time-settlement-audit-recorder';
import { ActivityTimeSettlementService } from '../../src/modules/activities/activity-time-settlement.service';
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
import appConfig, { type AppConfig } from '../../src/config/app.config';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import {
  buildActivityTimeAllocationManifest,
  type ActivityTimeAllocationSliceInput,
} from '../../src/modules/activities/activity-time-allocation-command';

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

class ObservedD4SourceDatabase extends PrismaClient<Prisma.PrismaClientOptions, 'query'> {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

describe('D4 classified settlement: real App HTTP and immutable PostgreSQL truth', () => {
  let f: D13Fixture;
  let actor: CurrentUserPayload;
  const meta = { requestId: 'd4-e2e', ip: null, ua: null };
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

  it('real seal/draft → App recognition → prepare → formal submit → frozen paged drilldown; preserves legacy values', async () => {
    const p = await prepareSource();
    const prior = await f.db.participantSettlementResultRevision.findFirstOrThrow({
      where: { settlementVersionId: p.generated.settlementVersionId },
    });
    const missing = await request(httpServer(f.app))
      .get(p.url)
      .set('Authorization', f.creator.auth)
      .expect(200);
    expect(missing.body.data.ready).toBe(false);
    const recognition = await recognize(p);
    const ready = await request(httpServer(f.app))
      .get(p.url)
      .set('Authorization', f.creator.auth)
      .expect(200);
    expect(ready.body.data.ready).toBe(true);
    const prepared = await post(`${p.url}/prepare`, prepareCommand(p));
    expect(prepared).toMatchObject({
      kindCode: 'draft',
      bucketCount: 4,
      sourceCount: 4,
      revision: 1,
    });
    const submitted = await post(`${p.url}/submit`, {
      operationKey: f.key('submit'),
      expectedDraftVersion: p.proof.expectedDraftVersion,
      expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
      timeRevisionId: prepared.timeRevisionId,
      expectedBucketContentHash: prepared.bucketContentHash,
    });
    expect(submitted).toMatchObject({
      kindCode: 'submitted',
      bucketCount: 4,
      sourceCount: 4,
      revision: 2,
      bucketContentHash: prepared.bucketContentHash,
    });
    expect(submitted.contentHash).not.toBe(prepared.contentHash);
    const actual = await f.db.participantSettlementResultRevision.findFirstOrThrow({
      where: { settlementVersionId: submitted.settlementVersionId as string },
    });
    expect(actual.recognizedServiceHours).toEqual(prior.recognizedServiceHours);
    expect(actual.recognizedContributionPoints).toEqual(prior.recognizedContributionPoints);
    const buckets = await request(httpServer(f.app))
      .get(`${p.url}/revisions/${submitted.timeRevisionId}/buckets?page=1&pageSize=2`)
      .set('Authorization', f.creator.auth)
      .expect(200);
    expect(buckets.body.data).toMatchObject({ total: 4, page: 1, pageSize: 2 });
    const all = await f.db.participantSettlementTimeBucket.findMany({
      where: { timeRevisionId: submitted.timeRevisionId as string },
    });
    expect(all.find((row) => row.categoryCode === 'volunteer_service')).toMatchObject({
      calculatedSeconds: 3600,
      recognizedSeconds: 3600,
      rawRecognizedMilliseconds: 3600000n,
    });
    const sources = await request(httpServer(f.app))
      .get(`${p.url}/revisions/${submitted.timeRevisionId}/sources?bucketId=${all[0].id}`)
      .set('Authorization', f.creator.auth)
      .expect(200);
    expect(sources.body.data.total).toBe(1);
    const detail = await request(httpServer(f.app))
      .get(`${p.url}/allocations/${recognition.allocationRevisionId}`)
      .set('Authorization', f.creator.auth)
      .expect(200);
    expect(detail.body.data).toMatchObject({
      manualReason: null,
      policy: DEFINITION,
      slices: [
        {
          categoryCode: 'volunteer_service',
          intervalKindCode: 'service_segment',
          startAt: START.toISOString(),
          endAt: END.toISOString(),
        },
      ],
    });
    for (const data of [buckets.body.data, sources.body.data, detail.body.data]) {
      expect(JSON.stringify(data)).not.toMatch(
        /operationKey|requestHash|signedUrl|passwordHash|storageKey|actorUserId/,
      );
    }
    expect(
      await f.db.activitySettlementTimeCommandReceipt.count({
        where: { activityId: p.activityId },
      }),
    ).toBe(2);
    expect(
      await f.db.auditLog.count({
        where: { resourceId: p.activityId, event: 'activity.time-settlement.command' },
      }),
    ).toBe(2);
  }, 90000);

  it.each(['buckets', 'sources', 'allocation'] as const)(
    'authorizes historical %s against its own version, not a later self-submitted version',
    async (kind) => {
      const p = await prepareSource();
      const allocation = await recognize(p);
      const prepared = await post(`${p.url}/prepare`, prepareCommand(p));
      const role = await f.db.rbacRole.create({
        data: { code: f.key('history_reader'), displayName: 'D4 historical reviewer fixture' },
      });
      for (const code of [
        'activity.time-settlement.read',
        'activity.settlement-first-review.record',
      ]) {
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
        await f.db.rolePermission.create({
          data: { roleId: role.id, permissionId: permission.id },
        });
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
      const path =
        kind === 'allocation'
          ? `${p.url}/allocations/${allocation.allocationRevisionId}`
          : `${p.url}/revisions/${prepared.timeRevisionId}/${kind}`;
      try {
        // Positive control: the reader really has current App/scope/reviewer eligibility.
        const before = await request(httpServer(f.app))
          .get(path)
          .set('Authorization', f.reviewer.auth);
        expect({ status: before.status, code: before.body.code }).toEqual({ status: 200, code: 0 });
        const previous = await f.db.attendanceSettlementVersion.findUniqueOrThrow({
          where: { id: p.generated.settlementVersionId },
        });
        // Append a later fixture; never mutate the historical version or its immutable evidence.
        await f.db.attendanceSettlementVersion.create({
          data: {
            ...previous,
            id: f.key('later_version'),
            version: previous.version + 1,
            priorVersionId: previous.id,
            createdByUserId: f.reviewer.id,
            operationKey: null,
            requestHash: null,
          },
        });
        const historical = await request(httpServer(f.app))
          .get(path)
          .set('Authorization', f.reviewer.auth);
        expect({ status: historical.status, code: historical.body.code }).toEqual({
          status: 200,
          code: 0,
        });
        // Current-version self-review remains forbidden; historical access must not bypass it.
        const current = await request(httpServer(f.app))
          .get(p.url)
          .set('Authorization', f.reviewer.auth);
        expect({ status: current.status, code: current.body.code }).toEqual({
          status: BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE.httpStatus,
          code: BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE.code,
        });
        await f.db.roleBinding.update({
          where: { id: binding.id },
          data: { deletedAt: new Date() },
        });
        const revoked = await request(httpServer(f.app))
          .get(path)
          .set('Authorization', f.reviewer.auth);
        expect({ status: revoked.status, code: revoked.body.code }).toEqual({
          status: BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE.httpStatus,
          code: BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE.code,
        });
      } finally {
        await f.db.roleBinding.update({
          where: { id: binding.id },
          data: { deletedAt: new Date() },
        });
      }
    },
  );

  it.each([
    { enabled: false, readonlyMaintenance: false, biz: BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED },
    {
      enabled: false,
      readonlyMaintenance: true,
      biz: BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE,
    },
    {
      enabled: true,
      readonlyMaintenance: true,
      biz: BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE,
    },
    { enabled: true, readonlyMaintenance: false, biz: null },
  ])(
    'real HTTP Gate enabled=$enabled readonly=$readonlyMaintenance preserves history and controls all write replays',
    async (state) => {
      const p = await prepareSource();
      if (!p.source) throw new Error('expected sealed source');
      const allocationBody = {
        ...p.proof,
        operationKey: f.key('recognize'),
        sourceSegmentId: p.source.id,
        expectedRevision: 0,
        recognitionModeCode: 'automatic',
        evidenceAttachmentIds: [],
      };
      const allocation = await post(`${p.url}/allocations`, allocationBody);
      const prepareBody = prepareCommand(p);
      const prepared = await post(`${p.url}/prepare`, prepareBody);
      const submitBody = {
        operationKey: f.key('submit'),
        expectedDraftVersion: p.proof.expectedDraftVersion,
        expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
        timeRevisionId: prepared.timeRevisionId,
        expectedBucketContentHash: prepared.bucketContentHash,
      };
      const submitted = await post(`${p.url}/submit`, submitBody);
      const commands = [
        { suffix: 'allocations', body: allocationBody, result: allocation },
        { suffix: 'prepare', body: prepareBody, result: prepared },
        { suffix: 'submit', body: submitBody, result: submitted },
      ];
      const counts = async () =>
        Promise.all([
          f.db.activitySettlementTimeRevision.count({ where: { activityId: p.activityId } }),
          f.db.participantSettlementTimeBucket.count({ where: { activityId: p.activityId } }),
          f.db.participantSettlementTimeBucketSource.count({ where: { activityId: p.activityId } }),
          f.db.activitySettlementTimeCommandReceipt.count({ where: { activityId: p.activityId } }),
          f.db.participantTimeAllocationRevision.count({ where: { activityId: p.activityId } }),
        ]);
      const before = await counts();
      // Change only this isolated test application's injected configuration. The actual
      // Gate implementation and every HTTP/Service entry remain in use, without mocking.
      const settings = f.app.get<AppConfig>(appConfig.KEY).activityV11Workflow;
      const original = { ...settings };
      try {
        settings.enabled = state.enabled;
        settings.readonlyMaintenance = state.readonlyMaintenance;
        for (const command of commands) {
          const response = await request(httpServer(f.app))
            .post(`${p.url}/${command.suffix}`)
            .set('Authorization', f.creator.auth)
            .send(command.body);
          expect({ status: response.status, code: response.body.code }).toEqual({
            status: state.biz?.httpStatus ?? 200,
            code: state.biz?.code ?? 0,
          });
          if (!state.biz) expect(response.body.data).toEqual(command.result);
        }
        const history = await request(httpServer(f.app))
          .get(`${p.url}/revisions/${submitted.timeRevisionId}/buckets`)
          .set('Authorization', f.creator.auth);
        expect({
          status: history.status,
          code: history.body.code,
          total: history.body.data?.total,
        }).toEqual({ status: 200, code: 0, total: 4 });
        expect(await counts()).toEqual(before);
      } finally {
        Object.assign(settings, original);
      }
    },
  );

  async function createMaximumCapacitySource(extraSlice = false) {
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
      batch: true,
      beforeSeal: async (draft) => {
        // All evidence exists BEFORE the real seal and legacy draft generation.
        for (let offset = 0; offset < 1999; offset += 100) {
          const people = Array.from({ length: Math.min(100, 1999 - offset) }, (_, i) => ({
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
    expect(sources).toHaveLength(9999);
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
        const input = slicesFor(source.start, source.end, extraSlice && source === sources[0]);
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

  it('maximum valid sources: 2000 identities, 10000 segments and 50000 slices produce 8000 buckets and 40000 sources', async () => {
    const p = await createMaximumCapacitySource();
    expect(
      await f.db.activityParticipationIdentity.count({ where: { activityId: p.activityId } }),
    ).toBe(2000);
    expect(
      await f.db.participantTimeAllocationRevision.count({ where: { activityId: p.activityId } }),
    ).toBe(10000);
    expect(
      await f.db.participantTimeAllocationSlice.count({ where: { activityId: p.activityId } }),
    ).toBe(50000);
    const observed = new ObservedD4SourceDatabase({ log: [{ emit: 'event', level: 'query' }] });
    let total = 0;
    observed.$on('query', (event) => {
      if (!/^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/i.test(event.query)) total++;
    });
    try {
      await assertConnectedTestDatabase(observed);
      await f.db.user.update({ where: { id: actor.id }, data: { role: Role.USER } });
      const access = f.app.get(ActivityTimeSettlementAccessService);
      const facade = f.app.get(ParticipationSegmentFacade);
      const queries = new ActivityTimeSettlementQueryService(observed, access, facade);
      const measured = new ActivityTimeSettlementService(
        observed,
        access,
        queries,
        facade,
        f.app.get(ActivityTimeAllocationService),
        f.app.get(SettlementSubmitService),
        f.app.get(ActivityTimeSettlementAuditRecorder),
        f.app.get(ActivityWorkflowGate),
      );
      total = 0;
      const started = Date.now();
      const prepared = await measured.prepare(p.activityId, prepareCommand(p), actor, meta);
      const prepareMs = Date.now() - started;
      const prepareQueries = total;
      expect(
        await f.db.participantSettlementTimeBucket.count({
          where: { timeRevisionId: prepared.timeRevisionId },
        }),
      ).toBe(8000);
      expect(
        await f.db.participantSettlementTimeBucketSource.count({
          where: { timeRevisionId: prepared.timeRevisionId },
        }),
      ).toBe(40000);
      total = 0;
      await queries.buckets(
        p.activityId,
        prepared.timeRevisionId,
        { page: 1, pageSize: 20 },
        actor,
      );
      const pageQueries = total;
      total = 0;
      const submitted = await measured.submit(
        p.activityId,
        {
          operationKey: f.key('capacity_submit'),
          expectedDraftVersion: p.proof.expectedDraftVersion,
          expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
          timeRevisionId: prepared.timeRevisionId,
          expectedBucketContentHash: prepared.bucketContentHash,
        },
        actor,
        meta,
      );
      const submitQueries = total;
      expect(submitted.kindCode).toBe('submitted');
      console.info(
        'D4 maximum valid sources:',
        JSON.stringify({ prepareQueries, pageQueries, submitQueries, prepareMs }),
      );
      expect(prepareQueries).toBeGreaterThan(0);
      expect(prepareQueries).toBeLessThanOrEqual(400);
      expect(pageQueries).toBeGreaterThan(0);
      expect(pageQueries).toBeLessThanOrEqual(120);
      expect(submitQueries).toBeGreaterThan(0);
      expect(submitQueries).toBeLessThanOrEqual(950);
      expect(prepareMs).toBeLessThan(30000);
    } finally {
      await f.db.user.update({ where: { id: actor.id }, data: { role: Role.SUPER_ADMIN } });
      await observed.$disconnect();
    }
  }, 600000);

  it('50001 valid current slices independently exceed capacity without a partial preparation receipt', async () => {
    const p = await createMaximumCapacitySource(true);
    expect(
      await f.db.activityParticipationIdentity.count({ where: { activityId: p.activityId } }),
    ).toBe(2000);
    expect(
      await f.db.participantTimeAllocationRevision.count({ where: { activityId: p.activityId } }),
    ).toBe(10000);
    expect(
      await f.db.participantTimeAllocationSlice.count({ where: { activityId: p.activityId } }),
    ).toBe(50001);
    const response = await request(httpServer(f.app))
      .post(`${p.url}/prepare`)
      .set('Authorization', f.creator.auth)
      .send(prepareCommand(p));
    expect({ status: response.status, code: response.body.code }).toEqual({
      status: BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT.httpStatus,
      code: BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT.code,
    });
    expect(
      await f.db.activitySettlementTimeRevision.count({ where: { activityId: p.activityId } }),
    ).toBe(0);
    expect(
      await f.db.participantSettlementTimeBucket.count({ where: { activityId: p.activityId } }),
    ).toBe(0);
    expect(
      await f.db.participantSettlementTimeBucketSource.count({
        where: { activityId: p.activityId },
      }),
    ).toBe(0);
    expect(
      await f.db.activitySettlementTimeCommandReceipt.count({
        where: { activityId: p.activityId },
      }),
    ).toBe(0);
    expect(
      await f.db.auditLog.count({
        where: { resourceId: p.activityId, event: 'activity.time-settlement.command' },
      }),
    ).toBe(0);
  }, 600000);

  it('unknown automatic baseline requires manual recognition and a retained reason; all actual SQL is measured', async () => {
    const p = await prepareSource({
      definition: {
        ...DEFINITION,
        evidence: { requiredSources: [], requireManualRecognition: true },
      },
    });
    if (!p.source) throw new Error('source expected');
    const recognition = await post(`${p.url}/allocations`, {
      ...p.proof,
      operationKey: f.key('manual'),
      sourceSegmentId: p.source.id,
      expectedRevision: 0,
      recognitionModeCode: 'manual',
      manualReason: '现场批准培训认定，自动基线不可用',
      evidenceAttachmentIds: [],
      slices: [
        { categoryCode: 'training', startAt: START.toISOString(), endAt: END.toISOString() },
      ],
    });
    const observed = new ObservedD4SourceDatabase({ log: [{ emit: 'event', level: 'query' }] });
    let total = 0,
      authQueries = 0,
      authCalls = 0;
    observed.$on('query', (event) => {
      if (!/^\s*(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)\b/i.test(event.query)) total++;
    });
    try {
      await assertConnectedTestDatabase(observed);
      const access = f.app.get(ActivityTimeSettlementAccessService),
        facade = f.app.get(ParticipationSegmentFacade);
      const originalAuthorize = access.authorize.bind(access);
      jest.spyOn(access, 'authorize').mockImplementation(async (...args) => {
        const before = total;
        try {
          return await originalAuthorize(...args);
        } finally {
          authQueries += total - before;
          authCalls++;
        }
      });
      const queries = new ActivityTimeSettlementQueryService(observed, access, facade);
      const measured = new ActivityTimeSettlementService(
        observed,
        access,
        queries,
        facade,
        f.app.get(ActivityTimeAllocationService),
        f.app.get(SettlementSubmitService),
        f.app.get(ActivityTimeSettlementAuditRecorder),
        f.app.get(ActivityWorkflowGate),
      );
      const counts: Record<string, { total: number; authQueries: number; authCalls: number }> = {};
      total = 0;
      const prepared = await measured.prepare(p.activityId, prepareCommand(p), actor, meta);
      counts.prepare = { total, authQueries, authCalls };
      total = authQueries = authCalls = 0;
      await queries.buckets(
        p.activityId,
        prepared.timeRevisionId,
        { page: 1, pageSize: 20 },
        actor,
      );
      counts.page = { total, authQueries, authCalls };
      total = authQueries = authCalls = 0;
      const submitted = await measured.submit(
        p.activityId,
        {
          operationKey: f.key('submit'),
          expectedDraftVersion: p.proof.expectedDraftVersion,
          expectedEvidenceSealId: p.proof.expectedEvidenceSealId,
          timeRevisionId: prepared.timeRevisionId,
          expectedBucketContentHash: prepared.bucketContentHash,
        },
        actor,
        meta,
      );
      counts.submit = { total, authQueries, authCalls };
      console.info('D4 SQL measured with a recognized source:', JSON.stringify(counts));
      const rows = await f.db.participantSettlementTimeBucket.findMany({
        where: { timeRevisionId: submitted.timeRevisionId },
      });
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.calculatedSeconds).toBeNull();
        expect(row.rawCalculatedMilliseconds).toBeNull();
        expect(row.adjustmentReason).toEqual([
          {
            allocationRevisionId: recognition.allocationRevisionId,
            manualReason: '现场批准培训认定，自动基线不可用',
          },
        ]);
      }
      expect(rows.find((row) => row.categoryCode === 'training')?.recognizedSeconds).toBe(3600);
      const detail = await request(httpServer(f.app))
        .get(`${p.url}/allocations/${recognition.allocationRevisionId}`)
        .set('Authorization', f.creator.auth)
        .expect(200);
      expect(detail.body.data.manualReason).toBe('现场批准培训认定，自动基线不可用');
    } finally {
      await observed.$disconnect();
    }
  }, 90000);

  it('explicitly absent population with no valid segment produces four real zero buckets', async () => {
    const p = await prepareSource({ noEvents: true });
    const prepared = await post(`${p.url}/prepare`, prepareCommand(p));
    expect(prepared).toMatchObject({ bucketCount: 4, sourceCount: 0 });
    const buckets = await request(httpServer(f.app))
      .get(`${p.url}/revisions/${prepared.timeRevisionId}/buckets`)
      .set('Authorization', f.creator.auth)
      .expect(200);
    expect(buckets.body.data.items).toHaveLength(4);
    for (const bucket of buckets.body.data.items)
      expect(bucket).toMatchObject({
        calculatedSeconds: 0,
        recognizedSeconds: 0,
        emptyReasonCode: 'no_valid_segment',
        timePolicyVersionId: null,
      });
  }, 60000);

  it('same-key replay is exact, different payload conflicts, and audit failure rolls all four new tables back', async () => {
    const p = await prepareSource();
    await recognize(p);
    const command = prepareCommand(p);
    const first = await post(`${p.url}/prepare`, command);
    expect(await post(`${p.url}/prepare`, command)).toEqual(first);
    const conflict = await request(httpServer(f.app))
      .post(`${p.url}/prepare`)
      .set('Authorization', f.creator.auth)
      .send({ ...command, expectedTimeRevision: 1 })
      .expect(409);
    expect(conflict.body.code).toBe(BizCode.ACTIVITY_TIME_SETTLEMENT_COMMAND_CONFLICT.code);
    jest
      .spyOn(f.app.get(ActivityTimeSettlementAuditRecorder), 'log')
      .mockRejectedValueOnce(new Error('d4 audit rollback probe'));
    await expect(
      f.app
        .get(ActivityTimeSettlementService)
        .prepare(p.activityId, prepareCommand(p, 1), actor, meta),
    ).rejects.toThrow('d4 audit rollback probe');
    expect(
      await f.db.activitySettlementTimeRevision.count({ where: { activityId: p.activityId } }),
    ).toBe(1);
    expect(
      await f.db.participantSettlementTimeBucket.count({ where: { activityId: p.activityId } }),
    ).toBe(4);
    expect(
      await f.db.participantSettlementTimeBucketSource.count({
        where: { activityId: p.activityId },
      }),
    ).toBe(4);
    expect(
      await f.db.activitySettlementTimeCommandReceipt.count({
        where: { activityId: p.activityId },
      }),
    ).toBe(1);
  }, 90000);

  it('PostgreSQL independently rejects forged chains, counts, policy quantum, durations, reasons and receipts', async () => {
    const p = await prepareSource();
    await recognize(p);
    const prepared = await f.app
      .get(ActivityTimeSettlementService)
      .prepare(p.activityId, prepareCommand(p), actor, meta);
    const original = await f.db.activitySettlementTimeRevision.findUniqueOrThrow({
      where: { id: prepared.timeRevisionId },
    });
    const buckets = await f.db.participantSettlementTimeBucket.findMany({
      where: { timeRevisionId: original.id },
    });
    const sources = await f.db.participantSettlementTimeBucketSource.findMany({
      where: { timeRevisionId: original.id },
    });
    expect(buckets).toHaveLength(4);
    expect(sources).toHaveLength(4);
    interface Forgery {
      parent?: Partial<ActivitySettlementTimeRevision>;
      bucket?: Partial<ParticipantSettlementTimeBucket>;
      source?: Partial<ParticipantSettlementTimeBucketSource>;
      omitBucket?: boolean;
      omitSource?: boolean;
      omitAllSources?: boolean;
      omitReceipt?: boolean;
      operationCode?: string;
      result?: Record<string, unknown>;
      before?: (tx: Prisma.TransactionClient) => Promise<void>;
    }
    const safeJson = (row: unknown) =>
      JSON.stringify(row, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
    const positiveRollback = new Error('complete direct SQL control verified; roll back fixture');

    async function probe(change: Forgery = {}) {
      const id = f.key('sql_negative');
      const parent = {
        ...original,
        id,
        revision: original.revision + 1,
        previousTimeRevisionId: original.id,
        ...change.parent,
      };
      const nextBuckets = buckets.slice(change.omitBucket ? 1 : 0).map((row) => ({
        ...row,
        id: id + ':' + row.id,
        timeRevisionId: id,
        ...change.bucket,
      }));
      const nextSources = sources
        .slice(change.omitAllSources ? sources.length : change.omitSource ? 1 : 0)
        .filter((row) => nextBuckets.some((bucket) => bucket.id === id + ':' + row.bucketId))
        .map((row) => ({
          ...row,
          id: id + ':' + row.id,
          bucketId: id + ':' + row.bucketId,
          timeRevisionId: id,
          ...change.source,
        }));
      const categories = ['volunteer_service', 'training', 'organization', 'non_creditable'];
      const document = [...nextBuckets]
        .sort(
          (a, b) =>
            a.participationIdentityId.localeCompare(b.participationIdentityId) ||
            categories.indexOf(a.categoryCode) - categories.indexOf(b.categoryCode),
        )
        .map((row) => ({
          participationIdentityId: row.participationIdentityId,
          categoryCode: row.categoryCode,
          calculatedSeconds: row.calculatedSeconds,
          recognizedSeconds: row.recognizedSeconds,
          rawCalculatedMilliseconds: row.rawCalculatedMilliseconds?.toString() ?? null,
          rawRecognizedMilliseconds: row.rawRecognizedMilliseconds.toString(),
          timePolicyVersionId: row.timePolicyVersionId,
          definitionHash: row.definitionHash,
          evaluatorVersion: row.evaluatorVersion,
          quantumSeconds: row.quantumSeconds,
          adjustmentReason: row.adjustmentReason,
          emptyReasonCode: row.timePolicyVersionId === null ? 'no_valid_segment' : null,
          sources: nextSources
            .filter((source) => source.bucketId === row.id)
            .sort((a, b) => a.allocationRevisionId.localeCompare(b.allocationRevisionId))
            .map((source) => ({
              allocationRevisionId: source.allocationRevisionId,
              sourceSegmentId: source.sourceSegmentId,
              sourceSegmentRevision: source.sourceSegmentRevision,
              rawCalculatedMilliseconds: source.rawCalculatedMilliseconds?.toString() ?? null,
              rawRecognizedMilliseconds: source.rawRecognizedMilliseconds.toString(),
            })),
        }));
      // A forged caller can recompute its own fingerprint. The database must still reject the
      // underlying wrong policy/value/reason, not merely a conveniently stale digest.
      parent.bucketContentHash =
        change.parent?.bucketContentHash ??
        fingerprintMetricEnvelope('activity-time-settlement-buckets-v1', document).definitionHash;
      const result = {
        ...prepared,
        timeRevisionId: id,
        revision: parent.revision,
        bucketContentHash: parent.bucketContentHash,
        bucketCount: parent.bucketCount,
        sourceCount: parent.sourceCount,
        ...change.result,
      };
      const receipt = {
        id: id + ':receipt',
        actorUserId: actor.id,
        activityId: p.activityId,
        operationCode: change.operationCode ?? 'prepare_time_settlement',
        operationKey: id,
        requestHash: 'c'.repeat(64),
        timeRevisionId: id,
        resultJson: result,
        createdAt: parent.createdAt,
      };
      await f.db.$transaction(
        async (tx) => {
          if (change.before) await change.before(tx);
          await tx.$executeRaw`INSERT INTO "ActivitySettlementTimeRevision"
          SELECT * FROM jsonb_populate_record(NULL::"ActivitySettlementTimeRevision", ${safeJson(parent)}::jsonb)`;
          await tx.$executeRaw`INSERT INTO "ParticipantSettlementTimeBucket"
          SELECT * FROM jsonb_populate_recordset(NULL::"ParticipantSettlementTimeBucket", ${safeJson(nextBuckets)}::jsonb)`;
          await tx.$executeRaw`INSERT INTO "ParticipantSettlementTimeBucketSource"
          SELECT * FROM jsonb_populate_recordset(NULL::"ParticipantSettlementTimeBucketSource", ${safeJson(nextSources)}::jsonb)`;
          if (!change.omitReceipt)
            await tx.$executeRaw`INSERT INTO "ActivitySettlementTimeCommandReceipt"
          SELECT * FROM jsonb_populate_record(NULL::"ActivitySettlementTimeCommandReceipt", ${safeJson(receipt)}::jsonb)`;
          await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
          throw positiveRollback;
        },
        { timeout: 30000 },
      );
    }

    await expect(probe()).rejects.toBe(positiveRollback);
    const cases: { name: string; change: Forgery; code: string; message: string }[] = [
      {
        name: 'orphan run',
        change: { parent: { settlementRunId: f.key('missing_run') } },
        code: '23503',
        message: 'classified settlement run is unavailable',
      },
      {
        name: 'wrong version',
        change: { parent: { settlementVersionId: f.key('missing_version') } },
        code: '23514',
        message: 'classified settlement version proof mismatch',
      },
      {
        name: 'wrong evidence counter',
        change: { parent: { evidenceRevision: original.evidenceRevision + 1 } },
        code: '23514',
        message: 'classified settlement version proof mismatch',
      },
      {
        name: 'skipped predecessor',
        change: { parent: { revision: original.revision + 2 } },
        code: '23514',
        message: 'classified settlement predecessor must be the latest same-run revision',
      },
      {
        name: 'wrong draft hash',
        change: { parent: { draftContentHash: 'f'.repeat(64) } },
        code: '23514',
        message: 'classified settlement requires the current draft',
      },
      {
        name: 'stale current seal',
        change: {
          before: async (tx) => {
            // A zero-counter seal can legitimately have no state row. Establish an actual
            // changed counter; UPDATE affecting zero rows would not exercise the stale guard.
            const state = await tx.activityEvidenceState.upsert({
              where: { activityId: p.activityId },
              create: { activityId: p.activityId, evidenceRevision: original.evidenceRevision + 1 },
              update: { evidenceRevision: original.evidenceRevision + 1 },
            });
            expect(state.evidenceRevision).toBe(original.evidenceRevision + 1);
          },
        },
        code: '23514',
        message: 'classified settlement seal is not current and closed',
      },
      {
        name: 'missing complete receipt',
        change: { omitReceipt: true },
        code: '23514',
        message: 'classified settlement revision requires its complete receipt',
      },
      {
        name: 'wrong bucket count',
        change: { parent: { bucketCount: 8 } },
        code: '23514',
        message:
          'classified settlement population, source fingerprint, child count or bucket hash mismatch',
      },
      {
        name: 'wrong source count',
        change: { parent: { sourceCount: 8 } },
        code: '23514',
        message:
          'classified settlement population, source fingerprint, child count or bucket hash mismatch',
      },
      {
        name: 'source fingerprint',
        change: { parent: { sourceSetHash: 'f'.repeat(64) } },
        code: '23514',
        message:
          'classified settlement population, source fingerprint, child count or bucket hash mismatch',
      },
      {
        name: 'bucket fingerprint',
        change: { parent: { bucketContentHash: 'f'.repeat(64) } },
        code: '23514',
        message:
          'classified settlement population, source fingerprint, child count or bucket hash mismatch',
      },
      {
        name: 'missing category',
        change: { omitBucket: true },
        code: '23514',
        message:
          'classified settlement population, source fingerprint, child count or bucket hash mismatch',
      },
      {
        name: 'missing source',
        change: { omitSource: true },
        code: '23514',
        message:
          'classified settlement population, source fingerprint, child count or bucket hash mismatch',
      },
      {
        name: 'wrong frozen quantum',
        change: { bucket: { quantumSeconds: 1 } },
        code: '23514',
        message: 'classified bucket source, frozen policy or derived duration mismatch',
      },
      {
        name: 'missing allocation sources with consistent zero count and recomputed digest',
        change: { omitAllSources: true, parent: { sourceCount: 0 } },
        code: '23514',
        message: 'classified settlement requires all latest applicable closed source allocations',
      },
      {
        name: 'unrelated policy hash',
        change: { bucket: { definitionHash: 'f'.repeat(64) } },
        code: '23503',
        message: 'pstb_policy_fkey',
      },
      {
        name: 'wrong source revision',
        change: { source: { sourceSegmentRevision: 2 } },
        code: '23503',
        message: 'pstbs_allocation_source_fkey',
      },
      {
        name: 'forged duration',
        change: { source: { rawRecognizedMilliseconds: 1000n } },
        code: '23514',
        message: 'classified bucket source, frozen policy or derived duration mismatch',
      },
      {
        name: 'forged reason with valid digest',
        change: {
          bucket: {
            adjustmentReason: [
              {
                allocationRevisionId: sources[0].allocationRevisionId,
                manualReason: '伪造人工理由',
              },
            ],
          },
        },
        code: '23514',
        message: 'classified bucket totals or retained manual reasons mismatch',
      },
      {
        name: 'wrong operation',
        change: { operationCode: 'submit_time_settlement' },
        code: '23514',
        message: 'classified settlement receipt operation or result does not match its parent',
      },
      {
        name: 'extra result field',
        change: { result: { privateNote: '不可混入收据' } },
        code: '23514',
        message: 'classified settlement receipt operation or result does not match its parent',
      },
    ];
    for (const sample of cases) {
      let failure: unknown;
      try {
        await probe(sample.change);
      } catch (error) {
        failure = error;
      }
      expect({ name: sample.name, error: failure }).toMatchObject({
        name: sample.name,
        error: {
          code: 'P2010',
          meta: { code: sample.code, message: expect.stringContaining(sample.message) },
        },
      });
    }
    expect(
      await f.db.activitySettlementTimeRevision.count({ where: { activityId: p.activityId } }),
    ).toBe(1);
    expect(
      await f.db.participantSettlementTimeBucket.count({ where: { activityId: p.activityId } }),
    ).toBe(4);
    expect(
      await f.db.participantSettlementTimeBucketSource.count({
        where: { activityId: p.activityId },
      }),
    ).toBe(4);
    expect(
      await f.db.activitySettlementTimeCommandReceipt.count({
        where: { activityId: p.activityId },
      }),
    ).toBe(1);
  }, 90000);

  it('rejects UPDATE and DELETE on all four immutable history tables without changing fixtures', async () => {
    const p = await prepareSource();
    await recognize(p);
    await f.app
      .get(ActivityTimeSettlementService)
      .prepare(p.activityId, prepareCommand(p), actor, meta);
    const tables = [
      'ActivitySettlementTimeRevision',
      'ParticipantSettlementTimeBucket',
      'ParticipantSettlementTimeBucketSource',
      'ActivitySettlementTimeCommandReceipt',
    ] as const;
    for (const table of tables) {
      for (const verb of ['UPDATE', 'DELETE'] as const) {
        const statement =
          verb === 'UPDATE'
            ? Prisma.sql`UPDATE ${Prisma.raw('"' + table + '"')} SET id = id WHERE "activityId" = ${p.activityId}`
            : Prisma.sql`DELETE FROM ${Prisma.raw('"' + table + '"')} WHERE "activityId" = ${p.activityId}`;
        await expect(f.db.$executeRaw(statement)).rejects.toMatchObject({
          code: 'P2010',
          meta: {
            code: '55000',
            message: expect.stringContaining(
              'classified settlement history is permanently immutable',
            ),
          },
        });
      }
    }
    expect(
      await f.db.activitySettlementTimeRevision.count({ where: { activityId: p.activityId } }),
    ).toBe(1);
    expect(
      await f.db.participantSettlementTimeBucket.count({ where: { activityId: p.activityId } }),
    ).toBe(4);
    expect(
      await f.db.participantSettlementTimeBucketSource.count({
        where: { activityId: p.activityId },
      }),
    ).toBe(4);
    expect(
      await f.db.activitySettlementTimeCommandReceipt.count({
        where: { activityId: p.activityId },
      }),
    ).toBe(1);
  }, 60000);

  it('requires every sealed-draft proof field and its separate D4 operation even for direct SQL allocations', async () => {
    const p = await prepareSource();
    await recognize(p);
    const prior = await f.db.participantTimeAllocationRevision.findFirstOrThrow({
      where: { activityId: p.activityId },
    });
    const positiveRollback = new Error('valid D4 SQL allocation control; roll back fixture');
    async function probe(
      patch: Record<string, unknown> = {},
      operation = 'recognize_settlement_time_allocation',
    ) {
      const id = f.key('sql_allocation');
      const change = JSON.stringify({
        id,
        revision: prior.revision + 1,
        previousAllocationRevisionId: prior.id,
        ...patch,
      });
      await f.db.$transaction(
        async (tx) => {
          const parents = await tx.$executeRaw`INSERT INTO "ParticipantTimeAllocationRevision"
          SELECT (jsonb_populate_record(NULL::"ParticipantTimeAllocationRevision", to_jsonb(a) || ${change}::jsonb)).*
          FROM "ParticipantTimeAllocationRevision" a WHERE a.id = ${prior.id}`;
          expect(parents).toBe(1);
          const slices = await tx.$executeRaw`INSERT INTO "ParticipantTimeAllocationSlice"
          SELECT (jsonb_populate_record(NULL::"ParticipantTimeAllocationSlice", to_jsonb(s) ||
            jsonb_build_object('id', ${id}::text || ':' || s.id, 'allocationRevisionId', ${id}::text))).*
          FROM "ParticipantTimeAllocationSlice" s WHERE s."allocationRevisionId" = ${prior.id}`;
          expect(slices).toBe(1);
          const receipts =
            await tx.$executeRaw`INSERT INTO "ParticipantTimeAllocationCommandReceipt"
          SELECT (jsonb_populate_record(NULL::"ParticipantTimeAllocationCommandReceipt", to_jsonb(r) ||
            jsonb_build_object('id', ${id}::text || ':receipt', 'operationKey', ${id}::text,
              'operationCode', ${operation}::text, 'allocationRevisionId', ${id}::text,
              'resultJson', r."resultJson" || jsonb_build_object('allocationRevisionId', ${id}::text, 'revision', ${prior.revision + 1}::integer)))).*
          FROM "ParticipantTimeAllocationCommandReceipt" r WHERE r."allocationRevisionId" = ${prior.id}`;
          expect(receipts).toBe(1);
          await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`;
          throw positiveRollback;
        },
        { timeout: 30000 },
      );
    }
    await expect(probe()).rejects.toBe(positiveRollback);
    const patches = [
      { settlementDraftVersionId: f.key('foreign_draft') },
      { settlementEvidenceSealId: f.key('foreign_seal') },
      { settlementEvidenceRevision: p.proof.expectedEvidenceRevision + 1 },
      { settlementPopulationRevision: p.proof.expectedPopulationRevision + 1 },
      { settlementWorkflowRevision: p.proof.expectedWorkflowRevision + 1 },
      { settlementDraftContentHash: 'f'.repeat(64) },
      { settlementEvidenceSealId: null },
      { settlementEvidenceRevision: null },
      { settlementPopulationRevision: null },
      { settlementWorkflowRevision: null },
      { settlementDraftContentHash: null },
    ];
    for (const patch of patches)
      await expect(probe(patch)).rejects.toMatchObject({
        code: 'P2010',
        meta: {
          code: '23514',
          message: expect.stringContaining(
            'time allocation requires the current sealed settlement draft',
          ),
        },
      });
    await expect(probe({ settlementDraftVersionId: null })).rejects.toMatchObject({
      code: 'P2010',
      meta: {
        code: '23514',
        message: expect.stringContaining(
          'time allocation source segment is not a closed valid current fact',
        ),
      },
    });
    await expect(probe({}, 'recognize_time_allocation')).rejects.toMatchObject({
      code: 'P2010',
      meta: {
        code: '23514',
        message: expect.stringContaining(
          'time allocation proof and receipt operation do not match',
        ),
      },
    });
    expect(
      await f.db.participantTimeAllocationRevision.count({ where: { activityId: p.activityId } }),
    ).toBe(1);
    expect(
      await f.db.participantTimeAllocationCommandReceipt.count({
        where: { activityId: p.activityId },
      }),
    ).toBe(1);
  }, 60000);
});
