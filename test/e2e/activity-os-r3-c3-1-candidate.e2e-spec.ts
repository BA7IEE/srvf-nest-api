import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityMetricCandidateAuditRecorder } from '../../src/modules/activities/activity-metric-candidate-audit-recorder';
import { AttendanceSegmentProjectorService } from '../../src/modules/activities/attendance-segment-projector.service';
import { CorrectionAuditRecorder } from '../../src/modules/activities/correction-audit-recorder';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { AttendancePunchAuditRecorder } from '../../src/modules/attendances/attendance-punch-audit-recorder';
import { parseMetricCandidateReceipt } from '../../src/modules/activities/activity-metric-candidate-command';
import { parseMetricRuleBindingReceipt } from '../../src/modules/activities/activity-metric-rule-binding-command';
import { parseMetricReceipt } from '../../src/modules/activities/activity-metric-command';
import { createTestUser } from '../fixtures/users.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { waitFor } from '../helpers/wait-for';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { assertConnectedTestDatabase } from '../setup/test-db';

describe('C3-1 candidate HTTP and real transaction closure', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: string;
  let actorId: string;
  let actorUsername: string;
  let memberId: string;
  let reviewer: CurrentUserPayload;
  let organizationId: string;
  let definitionId: string;
  let definitionHash: string;
  let setId: string;
  let setHash: string;
  let bindingId: string;
  let correction: CorrectionApplicationService;
  let preparation: LedgerPreparationService;
  let posting: LedgerPostingService;
  let sequence = 0;
  const key = () => `candidate_http_${++sequence}`;
  const bindings = '/api/admin/v1/activity-metric-rule-bindings';
  const base = (activityId: string) =>
    `/api/app/v1/my/managed-activities/${activityId}/metric-candidates`;
  const post = (path: string, body: object) =>
    request(httpServer(app)).post(path).set('Authorization', auth).send(body);
  const get = (path: string) => request(httpServer(app)).get(path).set('Authorization', auth);
  const bindingCommand = () => ({
    schemaVersion: 1,
    operationKey: key(),
    metricDefinitionId: definitionId,
    definitionHash,
    ruleCode: 'actual_participant_count_v1',
    evaluatorVersion: 1,
  });
  const command = (expectedCandidateRevision = 0) => ({
    schemaVersion: 1,
    operationKey: key(),
    expectedCandidateRevision,
    expectedOutcomeRevision: 0,
    metricSetVersionId: setId,
    metricSetDefinitionHash: setHash,
    bindingIds: [bindingId],
  });
  const activity = () =>
    prisma.activity.create({
      data: {
        title: key(),
        activityTypeCode: 'training',
        allocationModeCode: 'first_come',
        organizationId,
        initiatorMemberId: memberId,
        statusCode: 'draft',
        startAt: new Date('2025-01-01'),
        endAt: new Date('2025-01-02'),
        location: '测试',
        metricRequirementCode: 'required',
        selectedMetricSetVersionId: setId,
        selectedMetricSetDefinitionHash: setHash,
        metricSelectionRevision: 1,
      },
    });
  const correctionActor = (): CurrentUserPayload => ({
    id: actorId,
    username: actorUsername,
    role: Role.SUPER_ADMIN,
    status: UserStatus.ACTIVE,
    memberId,
  });
  const correctionAuditMeta = { requestId: 'c3-1-correction-candidate', ip: null, ua: null };
  async function grant(codes: string[], principalId = actorId) {
    const role = await prisma.rbacRole.create({
      data: { code: key(), displayName: '候选测试显式授权' },
    });
    for (const code of codes) {
      const permission = await prisma.permission.upsert({
        where: { code },
        update: {},
        create: {
          code,
          module: 'activity',
          action: 'test',
          resourceType: 'test',
          description: 'test',
          servicePrincipalAllowed: false,
          delegatedAccessAllowed: false,
        },
      });
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
    }
    await prisma.roleBinding.create({
      data: { principalType: 'USER', principalId, roleId: role.id, scopeType: 'GLOBAL' },
    });
  }
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await assertConnectedTestDatabase(prisma);
    await resetDb(app);
    correction = app.get(CorrectionApplicationService);
    preparation = app.get(LedgerPreparationService);
    posting = app.get(LedgerPostingService);
    // Catalogs do not cascade from User; clear only this worker's prior test fixtures.
    await prisma.$executeRaw`TRUNCATE "ActivityMetricCommandReceipt", "ActivityMetricSetItem", "ActivityMetricSetVersion", "ActivityMetricDefinition" CASCADE`;
    const actor = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    actorId = actor.id;
    actorUsername = actor.username;
    const reviewerUser = await createTestUser(app, {
      username: key(),
      role: Role.SUPER_ADMIN,
    });
    reviewer = {
      id: reviewerUser.id,
      username: reviewerUser.username,
      role: reviewerUser.role,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const member = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('候选测试'), gradeCode: 'level-3' },
    });
    memberId = member.id;
    await prisma.user.update({ where: { id: actorId }, data: { memberId } });
    auth = (await loginAs(app, actor.username)).authHeader;
    const root = await prisma.organization.create({ data: { name: key(), nodeTypeCode: 'root' } });
    organizationId = (
      await prisma.organization.create({
        data: { name: key(), nodeTypeCode: 'team', parentId: root.id },
      })
    ).id;
    const definition = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-definitions', {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '人数',
            configuration: {
              kindCode: 'non_negative_integer',
              unit: '人',
              minimum: 0,
              maximum: 2000,
            },
          },
        }).expect(201)
      ).body.data,
    );
    definitionId = definition.id;
    definitionHash = definition.definitionHash;
    await post(`/api/admin/v1/activity-metric-definitions/${definitionId}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: definitionHash,
    }).expect(200);
    const set = parseMetricReceipt(
      (
        await post('/api/admin/v1/activity-metric-sets', {
          operationKey: key(),
          definition: {
            schemaVersion: 1,
            code: key(),
            version: 1,
            name: '候选集',
            items: [
              {
                key: 'people',
                sortOrder: 0,
                required: true,
                metricDefinitionId: definitionId,
                definitionHash,
              },
            ],
          },
        }).expect(201)
      ).body.data,
    );
    setId = set.id;
    setHash = set.definitionHash;
    await post(`/api/admin/v1/activity-metric-sets/${setId}/activate`, {
      operationKey: key(),
      expectedDefinitionHash: setHash,
    }).expect(200);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await app?.close();
  });

  it('denies binding creation without an explicit grant even for SUPER_ADMIN', async () => {
    expectBizError(await post(bindings, bindingCommand()), BizCode.RBAC_FORBIDDEN);
    expect(await prisma.activityMetricRuleBinding.count()).toBe(0);
    // Read admission is exactly the existing metric catalog policy.
    await get(bindings).expect(200);
  });
  it('creates and replays a binding, reuses it for a new key, retains separate audit/receipts', async () => {
    await grant(['activity-metric.manage.rule-binding']);
    const body = bindingCommand();
    const response = await post(bindings, body).expect(201);
    bindingId = (response.body.data as { bindingId: string }).bindingId;
    parseMetricRuleBindingReceipt(response.body.data, bindingId);
    expect((await post(bindings, body).expect(201)).body).toEqual(response.body);
    expect((await post(bindings, bindingCommand()).expect(201)).body.data).toEqual(
      response.body.data,
    );
    expect(await prisma.activityMetricRuleBinding.count()).toBe(1);
    expect(await prisma.activityMetricRuleBindingCommandReceipt.count()).toBe(2);
    expect(
      await prisma.auditLog.count({ where: { event: 'activity.metric-rule-binding.command' } }),
    ).toBe(2);
  });
  it('denies calculation without explicit managed grants', async () => {
    const row = await activity();
    expectBizError(
      await post(base(row.id), command()),
      BizCode.ACTIVITY_OUTCOME_REFERENCE_UNAVAILABLE,
    );
    expect(await prisma.activityMetricCandidate.count()).toBe(0);
  });
  it('rejects unavailable source rather than fabricating a zero result', async () => {
    await grant(['activity.outcome.calculate', 'activity.outcome.read']);
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(false);
    const row = await activity();
    expectBizError(await post(base(row.id), command()), BizCode.ACTIVITY_METRIC_SOURCE_UNAVAILABLE);
    expect(await prisma.activityMetricCandidate.count({ where: { activityId: row.id } })).toBe(0);
  });
  it('persists a genuine empty-source zero, replays original facts and appends a revision', async () => {
    // Test-instance stub only; no environment or deployment Gate is changed.
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    const row = await activity();
    const body = command();
    const response = await post(base(row.id), body).expect(201);
    const id = (response.body.data as { candidateId: string }).candidateId;
    const receipt = parseMetricCandidateReceipt(response.body.data, row.id, id);
    expect(receipt).toMatchObject({ revision: 1, sourceCount: 0, valueCount: 1 });
    expect((await post(base(row.id), body).expect(201)).body).toEqual(response.body);
    expectBizError(
      await post(base(row.id), { ...body, expectedOutcomeRevision: 1 }),
      BizCode.ACTIVITY_METRIC_CANDIDATE_COMMAND_CONFLICT,
    );
    const detail = await get(`${base(row.id)}/${id}`).expect(200);
    expect(detail.body.data).toMatchObject({
      freshness: 'fresh',
      reproducible: true,
      values: [{ value: 0, unitCode: 'count' }],
    });
    await post(base(row.id), command(1)).expect(201);
    expect(await prisma.activityMetricCandidate.count({ where: { activityId: row.id } })).toBe(2);
    expect(
      await prisma.activityMetricCandidateCommandReceipt.count({ where: { activityId: row.id } }),
    ).toBe(2);
    expect(await prisma.activityOutcomeRevision.count({ where: { activityId: row.id } })).toBe(0);
    expect(await prisma.activity.findUnique({ where: { id: row.id } })).toEqual(row);
  });
  it('rolls back candidate, values and receipt when audit fails', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    jest
      .spyOn(app.get(ActivityMetricCandidateAuditRecorder), 'log')
      .mockRejectedValueOnce(new Error('test audit rollback'));
    const row = await activity();
    await post(base(row.id), command()).expect(500);
    expect(await prisma.activityMetricCandidate.count({ where: { activityId: row.id } })).toBe(0);
    expect(await prisma.activityMetricCandidateValue.count({ where: { activityId: row.id } })).toBe(
      0,
    );
    expect(
      await prisma.activityMetricCandidateCommandReceipt.count({ where: { activityId: row.id } }),
    ).toBe(0);
  });
  it('rejects client-supplied system values before any write', async () => {
    const row = await activity();
    await post(base(row.id), { ...command(), values: [{ value: 999 }] }).expect(400);
    expect(await prisma.activityMetricCandidate.count({ where: { activityId: row.id } })).toBe(0);
  });

  async function addSource(activityId: string, participantId: string, early = false, open = false) {
    const startAt = new Date('2025-01-01T00:00:00.000Z');
    const endAt = new Date('2025-01-01T02:00:00.000Z');
    const session = await prisma.activitySession.create({
      data: {
        activityId,
        code: key(),
        name: `参与测试_${key()}`,
        startAt,
        endAt,
        locationText: '测试',
        checkInOpenAt: startAt,
        checkInCloseAt: endAt,
        checkOutOpenAt: startAt,
        checkOutCloseAt: endAt,
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
    });
    const registration = await prisma.activityRegistration.upsert({
      where: { activityId_memberId: { activityId, memberId: participantId } },
      update: {},
      create: { activityId, memberId: participantId, statusCode: 'pass' },
    });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId,
        sessionId: session.id,
        registrationId: registration.id,
        memberId: participantId,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
    });
    const events = [];
    for (const eventTypeCode of open
      ? ['check_in']
      : ['check_in', early ? 'early_departure_close' : 'check_out']) {
      const occurredAt =
        eventTypeCode === 'check_in'
          ? startAt
          : new Date(startAt.getTime() + (early ? 600000 : 3600000));
      events.push(
        await prisma.attendancePunchEvent.create({
          data: {
            activityId,
            sessionId: session.id,
            participationIdentityId: identity.id,
            memberId: participantId,
            operatorUserId: actorId,
            eventTypeCode,
            sourceCode: 'proxy',
            occurredAt,
            receivedAt: occurredAt,
            eventKey: key(),
            requestHash: key(),
            evidenceRevision: 0,
            reason: '隔离测试夹具',
          },
        }),
      );
    }
    const projected = app.get(AttendanceSegmentProjectorService).rebuild(events, {
      sessionStartAt: startAt,
      sessionEndAt: endAt,
      lateGraceMinutes: session.lateGraceMinutes,
      earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
    });
    expect(projected.chainAnomalies).toEqual([]);
    for (const segment of projected.segments) {
      const { exceptionFlags, ...fields } = segment;
      await prisma.participantServiceSegmentRevision.create({
        data: {
          ...fields,
          exceptionFlagsJson: exceptionFlags,
          participationIdentityId: identity.id,
          revision: 1,
          statusCode: 'draft',
        },
      });
    }
    return { identity, session };
  }

  async function createLiveOpenSourceForOnsiteWriter() {
    const row = await activity();
    const now = new Date();
    const startAt = new Date(now.getTime() - 5 * 60_000);
    const endAt = new Date(now.getTime() + 60 * 60_000);
    await prisma.activity.update({
      where: { id: row.id },
      data: { statusCode: 'published', publishedAt: now },
    });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: row.id,
        memberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: actorId,
        source: 'publish',
      },
    });
    await prisma.activityEvidenceState.create({ data: { activityId: row.id } });
    const session = await prisma.activitySession.create({
      data: {
        activityId: row.id,
        code: key(),
        name: `现场写者_${key()}`,
        startAt,
        endAt,
        locationText: '测试',
        checkInOpenAt: new Date(now.getTime() - 10 * 60_000),
        checkInCloseAt: new Date(now.getTime() + 10 * 60_000),
        checkOutOpenAt: new Date(now.getTime() - 10 * 60_000),
        checkOutCloseAt: new Date(now.getTime() + 10 * 60_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
    });
    const registration = await prisma.activityRegistration.upsert({
      where: { activityId_memberId: { activityId: row.id, memberId } },
      update: {},
      create: { activityId: row.id, memberId, statusCode: 'pass' },
    });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: row.id,
        sessionId: session.id,
        registrationId: registration.id,
        memberId,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
    });
    const checkInAt = new Date(now.getTime() - 60_000);
    const checkIn = await prisma.attendancePunchEvent.create({
      data: {
        activityId: row.id,
        sessionId: session.id,
        participationIdentityId: identity.id,
        memberId,
        operatorUserId: actorId,
        eventTypeCode: 'check_in',
        sourceCode: 'proxy',
        occurredAt: checkInAt,
        receivedAt: checkInAt,
        eventKey: key(),
        requestHash: key(),
        evidenceRevision: 0,
        reason: 'C3-1 现场写者交错夹具',
      },
    });
    const projection = app.get(AttendanceSegmentProjectorService).rebuild([checkIn], {
      sessionStartAt: session.startAt,
      sessionEndAt: session.endAt,
      lateGraceMinutes: session.lateGraceMinutes,
      earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
    });
    expect(projection.chainAnomalies).toEqual([]);
    const open = projection.segments[0];
    if (!open) throw new Error('C3-1 onsite writer fixture did not project an open segment');
    const { exceptionFlags, ...fields } = open;
    await prisma.participantServiceSegmentRevision.create({
      data: {
        ...fields,
        exceptionFlagsJson: exceptionFlags,
        participationIdentityId: identity.id,
        revision: 1,
        statusCode: 'draft',
      },
    });
    return { row, session, identity };
  }

  async function createPublishedCompleteSourceForOnsiteVoid() {
    const row = await activity();
    await prisma.activity.update({
      where: { id: row.id },
      data: { statusCode: 'published', publishedAt: new Date() },
    });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: row.id,
        memberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: actorId,
        source: 'publish',
      },
    });
    await prisma.activityEvidenceState.create({ data: { activityId: row.id } });
    const source = await addSource(row.id, memberId);
    const checkOut = await prisma.attendancePunchEvent.findFirstOrThrow({
      where: {
        activityId: row.id,
        participationIdentityId: source.identity.id,
        eventTypeCode: 'check_out',
      },
      orderBy: { id: 'asc' },
    });
    return { row, source, checkOut };
  }

  async function createSettledCorrectableCandidateFixture() {
    const row = await activity();
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: row.id,
        memberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: actorId,
        source: 'publish',
      },
    });
    const participant = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('更正候选参与人'), gradeCode: 'level-3' },
    });
    const { identity, session } = await addSource(row.id, participant.id);
    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId: row.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: session.endAt,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 1,
        populationCountBySession: { [session.id]: 1 },
        contentHash: key(),
        statusCode: 'active',
        sealedByUserId: actorId,
        sealedAt: session.endAt,
      },
    });
    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: row.id,
        statusCode: 'posting',
        currentDraftVersion: 1,
        currentSubmittedVersion: 1,
      },
    });
    const version = await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: key(),
        personCount: 1,
        sessionParticipationCount: 1,
        serviceSegmentCount: 1,
        createdByUserId: actorId,
        submittedAt: session.endAt,
        statusCode: 'approved',
        operationKey: key(),
        requestHash: key(),
      },
    });
    await prisma.participantSettlementResultRevision.create({
      data: {
        settlementVersionId: version.id,
        participationIdentityId: identity.id,
        revision: 0,
        resultCode: 'present',
        recognizedServiceHours: 1,
        recognizedContributionPoints: 1,
        calculatedServiceHours: 1,
        calculatedContributionPoints: 1,
        statusCode: 'draft',
      },
    });
    const batch = await prisma.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: key(),
        requestHash: key(),
        totalCount: 1,
        preparedByUserId: actorId,
      },
    });
    const { jobId } = await preparation.ensurePrepareJob(batch.id);
    const items = await prisma.activityBatchJobItem.findMany({
      where: { jobId },
      select: { id: true },
      orderBy: { itemKey: 'asc' },
    });
    for (const item of items) await preparation.prepareChunk(jobId, item.id);
    await preparation.finalize(jobId);
    await posting.commitBatch(
      { postingBatchId: batch.id, operationKey: key() },
      correctionActor(),
      correctionAuditMeta,
    );
    return { row, identity, session, run, version, batch };
  }

  it('counts one actual member across sessions, excludes absent registrations and retains early departure', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    const row = await activity();
    await addSource(row.id, memberId);
    await addSource(row.id, memberId, true);
    const absent = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('未到场'), gradeCode: 'level-3' },
    });
    await prisma.activityRegistration.create({
      data: { activityId: row.id, memberId: absent.id, statusCode: 'pass' },
    });
    const result = await post(base(row.id), command()).expect(201);
    const id = (result.body.data as { candidateId: string }).candidateId;
    const detail = await get(`${base(row.id)}/${id}`).expect(200);
    expect(detail.body.data).toMatchObject({
      sourceCount: 2,
      freshness: 'fresh',
      reproducible: true,
      values: [{ value: 1 }],
    });
    const sources = await prisma.activityMetricCandidateSource.findMany({
      where: { candidateId: id },
      orderBy: { ordinal: 'asc' },
    });
    expect(sources.map((source) => source.memberGroupOrdinal)).toEqual([0, 0]);
    expect(sources.map((source) => source.resultCode).sort()).toEqual([
      'early_departure_zero',
      'valid',
    ]);
    expect(await prisma.activityOutcomeRevision.count({ where: { activityId: row.id } })).toBe(0);
  });

  it('marks a retained candidate stale when a later completed source changes the live digest', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    const row = await activity();
    const created = await post(base(row.id), command()).expect(201);
    const candidateId = (created.body.data as { candidateId: string }).candidateId;

    await addSource(row.id, memberId);

    const detail = await get(`${base(row.id)}/${candidateId}`).expect(200);
    expect(detail.body.data).toMatchObject({
      candidateId,
      sourceCount: 0,
      freshness: 'stale',
      reproducible: true,
      values: [{ value: 0, unitCode: 'count' }],
    });
    expect(await prisma.activityMetricCandidateSource.count({ where: { candidateId } })).toBe(0);
  });

  it('waits for the real onsite early-close transaction and then snapshots only its committed segment', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    await grant(['activity.outcome.calculate', 'activity.outcome.read']);
    const fixture = await createLiveOpenSourceForOnsiteWriter();
    const recorder = app.get(AttendancePunchAuditRecorder);
    const originalLogPunch = recorder.logPunch.bind(recorder);
    let notifyAudit!: (pid: number) => void;
    let releaseAudit!: () => void;
    const auditEntered = new Promise<number>((resolve) => {
      notifyAudit = resolve;
    });
    const auditReleased = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    jest.spyOn(recorder, 'logPunch').mockImplementationOnce(async (args) => {
      const [backend] = await args.tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid`;
      notifyAudit(backend.pid);
      await auditReleased;
      await originalLogPunch(args);
    });
    const closing = request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${fixture.row.id}` +
          `/onsite/sessions/${fixture.session.id}/early-departure-close`,
      )
      .set('Authorization', auth)
      .send({
        participationIdentityId: fixture.identity.id,
        eventKey: key(),
        reason: 'C3-1 候选锁等待现场提前离场',
      })
      .then((response) => response);
    const blockerPid = await auditEntered;
    const calculating = post(base(fixture.row.id), command()).then((response) => response);
    try {
      await waitFor(
        async () => {
          const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
            SELECT count(*) FROM pg_stat_activity
            WHERE datname = current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))`;
          return row.count > 0n;
        },
        {
          timeoutMs: 5000,
          message: 'candidate did not wait for the real onsite early-close activity lock',
        },
      );
    } finally {
      releaseAudit();
      expect((await closing).status).toBe(201);
    }
    const response = await calculating;
    expect(response.status).toBe(201);
    const candidateId = (response.body.data as { candidateId: string }).candidateId;
    const source = await prisma.activityMetricCandidateSource.findFirstOrThrow({
      where: { candidateId },
    });
    expect(source.resultCode).toBe('early_departure_zero');
    expect(source.checkOutAt.getTime()).toBeGreaterThan(source.checkInAt.getTime());
  });

  it('makes the real onsite void writer wait behind a candidate Activity lock without mixing snapshots', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    await grant(['activity.outcome.calculate', 'activity.outcome.read']);
    const fixture = await createPublishedCompleteSourceForOnsiteVoid();
    const recorder = app.get(ActivityMetricCandidateAuditRecorder);
    const originalLog = recorder.log.bind(recorder);
    let notifyAudit!: (pid: number) => void;
    let releaseAudit!: () => void;
    const auditEntered = new Promise<number>((resolve) => {
      notifyAudit = resolve;
    });
    const auditReleased = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    jest.spyOn(recorder, 'log').mockImplementationOnce(async (tx, actor, meta, result, priorId) => {
      const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      notifyAudit(backend.pid);
      await auditReleased;
      await originalLog(tx, actor, meta, result, priorId);
    });
    const calculating = post(base(fixture.row.id), command()).then((response) => response);
    const blockerPid = await auditEntered;
    const voiding = request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${fixture.row.id}` +
          `/onsite/punch-events/${fixture.checkOut.id}/void`,
      )
      .set('Authorization', auth)
      .send({ operationKey: key(), reason: 'C3-1 候选锁等待现场作废' })
      .then((response) => response);
    try {
      await waitFor(
        async () => {
          const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
            SELECT count(*) FROM pg_stat_activity
            WHERE datname = current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))`;
          return row.count > 0n;
        },
        {
          timeoutMs: 5000,
          message: 'real onsite void writer did not wait for the candidate activity lock',
        },
      );
    } finally {
      releaseAudit();
      expect((await calculating).status).toBe(201);
    }
    expect((await voiding).status).toBe(201);
    const candidate = await prisma.activityMetricCandidate.findFirstOrThrow({
      where: { activityId: fixture.row.id },
      include: { sources: { orderBy: { ordinal: 'asc' } } },
    });
    expect(candidate.sources).toHaveLength(1);
    expect(candidate.sources[0].sourceRevisionId).not.toBeNull();
    expect(
      (await get(`${base(fixture.row.id)}/${candidate.id}`).expect(200)).body.data,
    ).toMatchObject({ freshness: 'unavailable', reproducible: true });
  });

  it('keeps a candidate fresh through correction prepare and failed commit, then marks it stale on the real committed correction', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    await grant(['activity.outcome.calculate', 'activity.outcome.read']);
    await grant(['activity.settlement-final-review.record'], reviewer.id);
    const fixture = await createSettledCorrectableCandidateFixture();
    const initial = await post(base(fixture.row.id), command()).expect(201);
    const candidateId = (initial.body.data as { candidateId: string }).candidateId;
    const retainedBefore = await prisma.activityMetricCandidateSource.findMany({
      where: { candidateId },
      orderBy: { ordinal: 'asc' },
    });
    expect(retainedBefore).toHaveLength(1);
    expect(retainedBefore[0].checkOutAt).toEqual(new Date('2025-01-01T01:00:00.000Z'));

    const submitted = await correction.submit(
      {
        activityId: fixture.row.id,
        participationIdentityId: fixture.identity.id,
        requestTypeCode: 'time',
        reason: 'C3-1 候选来源更正夹具',
        operationKey: key(),
        requestHash: key(),
        requestedChangeJson: {
          schemaVersion: 1,
          results: [],
          segments: [
            {
              participationIdentityId: fixture.identity.id,
              segmentKey: '0001',
              checkInAt: fixture.session.startAt.toISOString(),
              checkOutAt: new Date(fixture.session.startAt.getTime() + 3 * 3600_000).toISOString(),
              resultCode: 'valid',
              serviceHours: '3.00',
            },
          ],
        },
      },
      correctionActor(),
      correctionAuditMeta,
    );
    await correction.review(
      { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
      reviewer,
      correctionAuditMeta,
    );
    const apply = {
      correctionRequestId: submitted.correctionRequestId,
      operationKey: key(),
      requestHash: key(),
    };
    const prepared = await correction.prepare(apply, reviewer, correctionAuditMeta);
    expect(prepared.pendingSegmentRevisionCount).toBe(1);
    expect(
      (await get(`${base(fixture.row.id)}/${candidateId}`).expect(200)).body.data,
    ).toMatchObject({ freshness: 'fresh', reproducible: true });

    const commitAudit = jest
      .spyOn(app.get(CorrectionAuditRecorder), 'logCommit')
      .mockRejectedValueOnce(new Error('C3-1 forced correction commit rollback'));
    await expect(correction.commit(apply, reviewer, correctionAuditMeta)).rejects.toThrow(
      'C3-1 forced correction commit rollback',
    );
    commitAudit.mockRestore();
    expect(
      (await get(`${base(fixture.row.id)}/${candidateId}`).expect(200)).body.data,
    ).toMatchObject({ freshness: 'fresh', reproducible: true });
    expect(
      await prisma.participantServiceSegmentRevision.findMany({
        where: { participationIdentityId: fixture.identity.id, statusCode: 'committed' },
      }),
    ).toHaveLength(1);

    const committed = await correction.commit(apply, reviewer, correctionAuditMeta);
    expect(committed.supersededSegmentRevisionCount).toBe(1);
    expect(
      (await get(`${base(fixture.row.id)}/${candidateId}`).expect(200)).body.data,
    ).toMatchObject({ freshness: 'stale', reproducible: true });
    const current = await prisma.participantServiceSegmentRevision.findFirstOrThrow({
      where: { participationIdentityId: fixture.identity.id, statusCode: 'committed' },
    });
    expect(current.checkOutAt).toEqual(new Date('2025-01-01T03:00:00.000Z'));
    expect(
      await prisma.activityMetricCandidateSource.findMany({
        where: { candidateId },
        orderBy: { ordinal: 'asc' },
      }),
    ).toEqual(retainedBefore);
  });

  it('waits for a real correction commit and creates a candidate from only the committed replacement source', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    await grant(['activity.outcome.calculate', 'activity.outcome.read']);
    await grant(['activity.settlement-final-review.record'], reviewer.id);
    const fixture = await createSettledCorrectableCandidateFixture();
    const submitted = await correction.submit(
      {
        activityId: fixture.row.id,
        participationIdentityId: fixture.identity.id,
        requestTypeCode: 'time',
        reason: 'C3-1 候选更正锁交错夹具',
        operationKey: key(),
        requestHash: key(),
        requestedChangeJson: {
          schemaVersion: 1,
          results: [],
          segments: [
            {
              participationIdentityId: fixture.identity.id,
              segmentKey: '0001',
              checkInAt: fixture.session.startAt.toISOString(),
              checkOutAt: new Date(fixture.session.startAt.getTime() + 3 * 3600_000).toISOString(),
              resultCode: 'valid',
              serviceHours: '3.00',
            },
          ],
        },
      },
      correctionActor(),
      correctionAuditMeta,
    );
    await correction.review(
      { correctionRequestId: submitted.correctionRequestId, actionCode: 'approve' },
      reviewer,
      correctionAuditMeta,
    );
    const apply = {
      correctionRequestId: submitted.correctionRequestId,
      operationKey: key(),
      requestHash: key(),
    };
    await correction.prepare(apply, reviewer, correctionAuditMeta);

    let notifyCommitAudit!: (pid: number) => void;
    let releaseCommitAudit!: () => void;
    const commitAuditEntered = new Promise<number>((resolve) => {
      notifyCommitAudit = resolve;
    });
    const commitAuditReleased = new Promise<void>((resolve) => {
      releaseCommitAudit = resolve;
    });
    const recorder = app.get(CorrectionAuditRecorder);
    const originalLogCommit = recorder.logCommit.bind(recorder);
    jest.spyOn(recorder, 'logCommit').mockImplementationOnce(async (args) => {
      const [backend] = await args.tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid`;
      notifyCommitAudit(backend.pid);
      await commitAuditReleased;
      await originalLogCommit(args);
    });
    const committing = correction.commit(apply, reviewer, correctionAuditMeta);
    const blockerPid = await commitAuditEntered;
    const calculating = post(base(fixture.row.id), command()).then((response) => response);
    try {
      await waitFor(
        async () => {
          const [row] = await prisma.$queryRaw<{ count: bigint }[]>`
            SELECT count(*) FROM pg_stat_activity
            WHERE datname = current_database() AND ${blockerPid} = ANY(pg_blocking_pids(pid))`;
          return row.count > 0n;
        },
        {
          timeoutMs: 5000,
          message: 'candidate did not wait for the real correction commit activity lock',
        },
      );
    } finally {
      releaseCommitAudit();
      await committing;
    }
    const response = await calculating;
    expect(response.status).toBe(201);
    const candidateId = (response.body.data as { candidateId: string }).candidateId;
    const source = await prisma.activityMetricCandidateSource.findFirstOrThrow({
      where: { candidateId },
    });
    const committed = await prisma.participantServiceSegmentRevision.findFirstOrThrow({
      where: { participationIdentityId: fixture.identity.id, statusCode: 'committed' },
    });
    expect(source.sourceRevisionId).toBe(committed.id);
    expect(source.checkOutAt).toEqual(new Date('2025-01-01T03:00:00.000Z'));
  });

  it('retains a reproducible candidate after its original owner loses app eligibility and the activity is archived', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    await grant(['activity.outcome.calculate', 'activity.outcome.read']);
    const fixture = await createSettledCorrectableCandidateFixture();
    await prisma.activity.update({
      where: { id: fixture.row.id },
      data: { statusCode: 'published' },
    });
    const created = await post(base(fixture.row.id), command()).expect(201);
    const candidateId = (created.body.data as { candidateId: string }).candidateId;

    const verifierUser = await createTestUser(app, { username: key(), role: Role.SUPER_ADMIN });
    const verifierMember = await prisma.member.create({
      data: { memberNo: key(), ...memberIdentityData('候选历史核验人'), gradeCode: 'level-3' },
    });
    await prisma.user.update({
      where: { id: verifierUser.id },
      data: { memberId: verifierMember.id },
    });
    await grant(['activity.outcome.read'], verifierUser.id);
    await prisma.activityResponsibilityAssignment.updateMany({
      where: { activityId: fixture.row.id, memberId, status: 'active' },
      data: { status: 'ended', endedAt: new Date(), endedByUserId: actorId },
    });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: fixture.row.id,
        memberId: verifierMember.id,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: actorId,
        source: 'publish',
      },
    });
    await prisma.member.update({
      where: { id: memberId },
      data: { status: MemberStatus.INACTIVE },
    });
    await prisma.activity.update({
      where: { id: fixture.row.id },
      data: {
        statusCode: 'archived',
        archivedAt: new Date(),
        archivedByUserId: actorId,
        archivedFromStatusCode: 'published',
        archiveReasonCode: 'settled',
        archiveOperationKey: key(),
        archiveRequestHash: key(),
      },
    });

    try {
      await get(`${base(fixture.row.id)}/${candidateId}`).expect(403);
      const verifierAuth = (await loginAs(app, verifierUser.username)).authHeader;
      const detail = await request(httpServer(app))
        .get(`${base(fixture.row.id)}/${candidateId}`)
        .set('Authorization', verifierAuth)
        .expect(200);
      expect(detail.body.data).toMatchObject({
        candidateId,
        freshness: 'fresh',
        reproducible: true,
        sourceCount: 1,
      });
      expect(await prisma.activityMetricCandidateSource.count({ where: { candidateId } })).toBe(1);
    } finally {
      await prisma.member.update({
        where: { id: memberId },
        data: { status: MemberStatus.ACTIVE },
      });
    }
  });

  it('rejects an open source instead of counting an unfinished interval', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    const row = await activity();
    await addSource(row.id, memberId, false, true);
    expectBizError(await post(base(row.id), command()), BizCode.ACTIVITY_METRIC_SOURCE_INCOMPLETE);
    expect(await prisma.activityMetricCandidate.count({ where: { activityId: row.id } })).toBe(0);
  });

  it.each([
    'ActivityMetricRuleBinding',
    'ActivityMetricCandidate',
    'ActivityMetricCandidateValue',
    'ActivityMetricCandidateSource',
    'ActivityMetricCandidateCommandReceipt',
    'ActivityMetricRuleBindingCommandReceipt',
  ])('physically refuses UPDATE and DELETE of retained %s test facts', async (table) => {
    const identifier = Prisma.raw(`"${table}"`);
    const before = await prisma.$queryRaw<{ count: bigint }[]>(
      Prisma.sql`SELECT count(*) FROM ${identifier}`,
    );
    expect(Number(before[0].count)).toBeGreaterThan(0);
    await expect(
      prisma.$executeRaw(Prisma.sql`UPDATE ${identifier} SET "id" = "id"`),
    ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await expect(prisma.$executeRaw(Prisma.sql`DELETE FROM ${identifier}`)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(await prisma.$queryRaw(Prisma.sql`SELECT count(*) FROM ${identifier}`)).toEqual(before);
  });
});
