import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MemberStatus, Prisma, Role, UserStatus } from '@prisma/client';
import request from 'supertest';
import type { JwtConfig } from '../../src/config/jwt.config';
import { ActivityWorkflowGate } from '../../src/common/activity-workflow/activity-workflow.gate';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityMetricCandidateAuditRecorder } from '../../src/modules/activities/activity-metric-candidate-audit-recorder';
import { AttendanceSegmentProjectorService } from '../../src/modules/activities/attendance-segment-projector.service';
import { activitySessionCancellationEffects } from '../../src/modules/activities/activity-session-cancellation-effects';
import { ActivityNotificationProducer } from '../../src/modules/activities/activity-notification-producer';
import { activitySessionRescheduleEffects } from '../../src/modules/activities/activity-session-reschedule-effects';
import { CorrectionAuditRecorder } from '../../src/modules/activities/correction-audit-recorder';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { SettlementDraftAuditRecorder } from '../../src/modules/activities/settlement-draft-audit-recorder';
import { SettlementDraftService } from '../../src/modules/activities/settlement-draft.service';
import { ActivityRegistrationAuditRecorder } from '../../src/modules/activity-registrations/activity-registration-audit-recorder';
import { AttendancePunchAuditRecorder } from '../../src/modules/attendances/attendance-punch-audit-recorder';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import { signAttendanceMemberCredential } from '../../src/modules/attendances/attendance-member-credential-token';
import {
  signAttendanceOfflineEvent,
  type AttendanceOfflinePackageTokenPayload,
} from '../../src/modules/attendances/attendance-offline-package-token';
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
  let jwtSecret: string;
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
  type OfflinePackageIssue = {
    package: { id: string };
    packageToken: string;
  };
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
  async function inFixtureChunks<T>(
    rows: readonly T[],
    write: (chunk: T[]) => Promise<unknown>,
    size = 500,
  ) {
    for (let index = 0; index < rows.length; index += size) {
      await write(rows.slice(index, index + size));
    }
  }
  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await assertConnectedTestDatabase(prisma);
    await resetDb(app);
    const jwt = app.get(ConfigService).get<JwtConfig>('jwt');
    if (!jwt) throw new Error('jwt config is required for C3-1 offline writer coverage');
    jwtSecret = jwt.secret;
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
    jest.useRealTimers();
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

  async function createOnsiteIdentityWriterFixture() {
    const row = await activity();
    const now = new Date();
    const startAt = new Date(now.getTime() - 60 * 60_000);
    const endAt = new Date(now.getTime() + 60 * 60_000);
    await prisma.activity.update({
      where: { id: row.id },
      data: { statusCode: 'published', publishedAt: now, startAt, endAt, capacity: 20 },
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
    const existingSource = await addSource(row.id, memberId);
    const session = await prisma.activitySession.create({
      data: {
        activityId: row.id,
        code: key(),
        name: `身份写者_${key()}`,
        startAt,
        endAt,
        locationText: '测试',
        capacity: 20,
        checkInOpenAt: new Date(now.getTime() - 10 * 60_000),
        checkInCloseAt: new Date(now.getTime() + 10 * 60_000),
        checkOutOpenAt: new Date(now.getTime() - 10 * 60_000),
        checkOutCloseAt: new Date(now.getTime() + 10 * 60_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
    });
    await prisma.activityCapacityBucket.createMany({
      data: [
        {
          activityId: row.id,
          scopeTypeCode: 'activity_person',
          scopeId: row.id,
          capacity: 20,
        },
        {
          activityId: row.id,
          scopeTypeCode: 'session_participation',
          scopeId: session.id,
          capacity: 20,
        },
      ],
    });
    const target = await prisma.member.create({
      data: {
        memberNo: key(),
        ...memberIdentityData('候选身份写者'),
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
    });
    return { row, session, existingSource, target };
  }

  async function createSessionCancellationWriterFixture() {
    const row = await activity();
    const now = new Date();
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
    const existingSource = await addSource(row.id, memberId);
    const session = await prisma.activitySession.create({
      data: {
        activityId: row.id,
        code: key(),
        name: `场次取消写者_${key()}`,
        startAt: new Date(now.getTime() - 60 * 60_000),
        endAt: new Date(now.getTime() + 60 * 60_000),
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
    const target = await prisma.member.create({
      data: {
        memberNo: key(),
        ...memberIdentityData('候选场次取消写者'),
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
    });
    const registration = await prisma.activityRegistration.create({
      data: {
        activityId: row.id,
        memberId: target.id,
        statusCode: 'pending',
        statusSummaryCode: 'active',
        currentRevision: 1,
        sourceCode: 'self',
        registeredAt: now,
      },
    });
    await prisma.activityRegistrationRevision.create({
      data: {
        registrationId: registration.id,
        revision: 1,
        sourceCode: 'self',
        submittedByUserId: actorId,
        submittedAt: now,
      },
    });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: row.id,
        sessionId: session.id,
        registrationId: registration.id,
        memberId: target.id,
        currentRevision: 1,
        currentStatusCode: 'pending',
        populationIncluded: false,
      },
    });
    await prisma.activityParticipationRevision.create({
      data: {
        identityId: identity.id,
        revision: 1,
        statusCode: 'pending',
        effectiveAt: now,
        createdByUserId: actorId,
        sourceCode: 'self',
      },
    });
    return { row, session, identity, existingSource };
  }

  async function createSessionRescheduleWriterFixture() {
    const fixture = await createPublishedCompleteSourceForOnsiteVoid();
    await prisma.attendanceQrCredential.createMany({
      data: (['check_in', 'check_out'] as const).map((actionCode) => ({
        activityId: fixture.row.id,
        sessionId: fixture.source.session.id,
        actionCode,
        credentialVersion: 1,
        statusCode: 'active',
        tokenDigest: 'a'.repeat(64),
        signingKeyVersion: 0,
        validFrom:
          actionCode === 'check_in'
            ? fixture.source.session.checkInOpenAt
            : fixture.source.session.checkOutOpenAt,
        validUntil:
          actionCode === 'check_in'
            ? fixture.source.session.checkInCloseAt
            : fixture.source.session.checkOutCloseAt,
        issuedByUserId: actorId,
        issuedAt: new Date(),
      })),
    });
    return fixture;
  }

  function decodeOfflinePackageToken(token: string): AttendanceOfflinePackageTokenPayload {
    const payloadPart = token.split('.')[0];
    if (!payloadPart) throw new Error('C3-1 offline package token has no payload');
    return JSON.parse(
      Buffer.from(payloadPart, 'base64url').toString('utf8'),
    ) as AttendanceOfflinePackageTokenPayload;
  }

  function signedOfflineUpload(
    issued: OfflinePackageIssue,
    overrides: Partial<{
      sequence: number;
      priorHash: string;
      eventKey: string;
      actionCode: 'check_in' | 'check_out';
      deviceTime: Date;
    }> = {},
  ) {
    const payload = decodeOfflinePackageToken(issued.packageToken);
    const deviceTime = overrides.deviceTime ?? new Date();
    const actionCode = overrides.actionCode ?? 'check_in';
    const memberCredential = signAttendanceMemberCredential(
      {
        userId: actorId,
        memberId,
        issuedAt: new Date(deviceTime.getTime() - 1_000),
        expiresAt: new Date(deviceTime.getTime() + 59_000),
        nonce: `offline_credential_nonce_${key()}`,
      },
      jwtSecret,
    );
    const event = {
      packageId: issued.package.id,
      sequence: overrides.sequence ?? payload.sequenceStart,
      priorHash: overrides.priorHash ?? payload.chainAnchorHash,
      eventKey: overrides.eventKey ?? key(),
      actionCode,
      deviceTime,
      memberCredential,
      longitude: 12.3456789,
      latitude: 23.456789,
      accuracy: 7.25,
    };
    return {
      packageToken: issued.packageToken,
      sequence: event.sequence,
      priorHash: event.priorHash,
      eventKey: event.eventKey,
      actionCode: event.actionCode,
      deviceTime: event.deviceTime.toISOString(),
      memberCredential: event.memberCredential,
      location: {
        longitude: event.longitude,
        latitude: event.latitude,
        accuracy: event.accuracy,
      },
      signature: signAttendanceOfflineEvent(issued.packageToken, event),
    };
  }

  async function createOfflinePackageCandidateFixture() {
    const row = await activity();
    const now = new Date();
    const startAt = new Date(now.getTime() - 2 * 60 * 60_000);
    const endAt = new Date(now.getTime() + 2 * 60 * 60_000);
    await prisma.activity.update({
      where: { id: row.id },
      data: { statusCode: 'published', publishedAt: now, startAt, endAt },
    });
    const publishReview = await prisma.activityPublishReview.create({
      data: {
        activityId: row.id,
        requestType: 'initial',
        requestVersion: 1,
        baseRevision: 0,
        status: 'approved',
        snapshot: {},
        directPublish: true,
        submittedByUserId: actorId,
        reviewedByUserId: actorId,
        reviewedAt: now,
      },
    });
    await prisma.activityRuleSnapshot.create({
      data: {
        activityId: row.id,
        workflowRevision: 0,
        resolvedConfig: {},
        snapshotHash: 'a'.repeat(64),
        createdByReviewId: publishReview.id,
      },
    });
    await prisma.activityEvidenceState.create({ data: { activityId: row.id } });
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
    const session = await prisma.activitySession.create({
      data: {
        activityId: row.id,
        code: key(),
        name: `离线写者_${key()}`,
        startAt,
        endAt,
        locationText: '测试',
        checkInOpenAt: startAt,
        checkInCloseAt: new Date(now.getTime() + 30 * 60_000),
        checkOutOpenAt: startAt,
        checkOutCloseAt: new Date(now.getTime() + 3 * 60 * 60_000),
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
        currentRevision: 0,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
    });
    await prisma.activityParticipationRevision.create({
      data: {
        identityId: identity.id,
        revision: 0,
        statusCode: 'pass',
        effectiveAt: now,
        createdByUserId: actorId,
        sourceCode: 'C3-1 offline writer fixture',
      },
    });
    const issuedResponse = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${row.id}/onsite/sessions/${session.id}` +
          '/offline-packages',
      )
      .set('Authorization', auth)
      .send({ operationKey: key(), deviceId: key() });
    if (issuedResponse.status !== 201) {
      throw new Error(
        `C3-1 offline package issue failed: ${issuedResponse.status} ${JSON.stringify(issuedResponse.body)}`,
      );
    }
    const issued = issuedResponse.body.data as OfflinePackageIssue;
    if (!issued.package?.id || !issued.packageToken) {
      throw new Error('C3-1 offline package issue response is incomplete');
    }
    return { row, session, identity, issued };
  }

  async function createSettlementReprojectionCandidateFixture() {
    const row = await activity();
    const startAt = new Date('2020-03-01T00:00:00.000Z');
    const endAt = new Date('2020-03-01T04:00:00.000Z');
    await prisma.activity.update({
      where: { id: row.id },
      data: { statusCode: 'published', publishedAt: endAt, startAt, endAt },
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
    const session = await prisma.activitySession.create({
      data: {
        activityId: row.id,
        code: key(),
        name: `结算重投影写者_${key()}`,
        startAt,
        endAt,
        locationText: '测试',
        checkInOpenAt: new Date(startAt.getTime() - 60 * 60_000),
        checkInCloseAt: new Date(startAt.getTime() + 60 * 60_000),
        checkOutOpenAt: new Date(startAt.getTime() + 2 * 60 * 60_000),
        checkOutCloseAt: new Date(endAt.getTime() + 4 * 60 * 60_000),
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
    await prisma.activityEvidenceState.create({ data: { activityId: row.id } });
    await prisma.evidenceSeal.create({
      data: {
        activityId: row.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: new Date(endAt.getTime() + 4 * 60 * 60_000),
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: 1,
        populationCountBySession: { [session.id]: 1 },
        contentHash: key(),
        statusCode: 'active',
        sealedByUserId: actorId,
        sealedAt: new Date(endAt.getTime() + 5 * 60 * 60_000),
      },
    });
    for (const [eventTypeCode, occurredAt] of [
      ['check_in', startAt],
      ['check_out', new Date(startAt.getTime() + 60 * 60_000)],
    ] as const) {
      await prisma.attendancePunchEvent.create({
        data: {
          activityId: row.id,
          sessionId: session.id,
          participationIdentityId: identity.id,
          memberId,
          operatorUserId: actorId,
          eventTypeCode,
          sourceCode: 'proxy',
          occurredAt,
          receivedAt: occurredAt,
          eventKey: key(),
          requestHash: key(),
          evidenceRevision: 0,
          reason: null,
        },
      });
    }
    return { row, identity };
  }

  function uploadOfflinePackage(
    activityId: string,
    packageId: string,
    body: ReturnType<typeof signedOfflineUpload>,
  ) {
    return request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${activityId}/onsite/offline-packages/${packageId}/upload`,
      )
      .set('Authorization', auth)
      .send(body);
  }

  function freezeSystemTime(now: Date): void {
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    jest.setSystemTime(now);
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

  it('waits for a real offline package upload and then snapshots only its committed service segment', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    await grant(['activity.outcome.calculate', 'activity.outcome.read']);
    const fixture = await createOfflinePackageCandidateFixture();
    const checkInAt = new Date();
    const checkIn = signedOfflineUpload(fixture.issued, { deviceTime: checkInAt });
    const checkInResponse = await uploadOfflinePackage(
      fixture.row.id,
      fixture.issued.package.id,
      checkIn,
    );
    if (checkInResponse.status !== 201) {
      throw new Error(
        `C3-1 offline package check-in failed: ${checkInResponse.status} ${JSON.stringify(checkInResponse.body)}`,
      );
    }
    const packageAfterCheckIn = await prisma.offlinePackage.findUniqueOrThrow({
      where: { id: fixture.issued.package.id },
      select: { lastAcceptedHash: true, nextExpectedSequence: true },
    });
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
    const checkOutAt = new Date(checkInAt.getTime() + 31 * 60_000);
    freezeSystemTime(checkOutAt);
    const checkOut = signedOfflineUpload(fixture.issued, {
      sequence: packageAfterCheckIn.nextExpectedSequence,
      priorHash: packageAfterCheckIn.lastAcceptedHash,
      actionCode: 'check_out',
      deviceTime: checkOutAt,
    });
    const uploading = uploadOfflinePackage(
      fixture.row.id,
      fixture.issued.package.id,
      checkOut,
    ).then((response) => response);
    const blockerPid = await Promise.race([
      auditEntered,
      uploading.then((response) => {
        throw new Error(
          `C3-1 offline package upload ended before the audit barrier: ${response.status} ${JSON.stringify(response.body)}`,
        );
      }),
    ]);
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
          message: 'candidate did not wait for the real offline package upload activity lock',
        },
      );
    } finally {
      releaseAudit();
      expect((await uploading).status).toBe(201);
    }
    const response = await calculating;
    expect(response.status).toBe(201);
    const candidateId = (response.body.data as { candidateId: string }).candidateId;
    const source = await prisma.activityMetricCandidateSource.findFirstOrThrow({
      where: { candidateId },
    });
    expect(source).toMatchObject({
      identityId: fixture.identity.id,
      resultCode: 'valid',
    });
    expect(source.checkOutAt?.getTime()).toBeGreaterThan(source.checkInAt.getTime());
  });

  it('waits for a real offline review approval and then snapshots only its committed service segment', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    await grant(['activity.outcome.calculate', 'activity.outcome.read']);
    const fixture = await createOfflinePackageCandidateFixture();
    const checkInAt = new Date();
    const checkIn = signedOfflineUpload(fixture.issued, { deviceTime: checkInAt });
    const checkInResponse = await uploadOfflinePackage(
      fixture.row.id,
      fixture.issued.package.id,
      checkIn,
    );
    if (checkInResponse.status !== 201) {
      throw new Error(
        `C3-1 offline review fixture check-in failed: ${checkInResponse.status} ${JSON.stringify(checkInResponse.body)}`,
      );
    }
    const packageAfterCheckIn = await prisma.offlinePackage.findUniqueOrThrow({
      where: { id: fixture.issued.package.id },
      select: { lastAcceptedHash: true, nextExpectedSequence: true },
    });
    expect(
      (
        await request(httpServer(app))
          .post(
            `/api/app/v1/my/managed-activities/${fixture.row.id}/onsite/offline-packages/` +
              `${fixture.issued.package.id}/revoke`,
          )
          .set('Authorization', auth)
          .send({ operationKey: key(), reason: 'C3-1 候选交错复核夹具' })
      ).status,
    ).toBe(201);
    const checkOutAt = new Date(checkInAt.getTime() + 31 * 60_000);
    freezeSystemTime(checkOutAt);
    const staged = await uploadOfflinePackage(
      fixture.row.id,
      fixture.issued.package.id,
      signedOfflineUpload(fixture.issued, {
        sequence: packageAfterCheckIn.nextExpectedSequence,
        priorHash: packageAfterCheckIn.lastAcceptedHash,
        actionCode: 'check_out',
        deviceTime: checkOutAt,
      }),
    );
    expectBizError(staged, BizCode.ATTENDANCE_OFFLINE_REVIEW_REQUIRED);
    const review = await prisma.offlinePunchReviewItem.findFirstOrThrow({
      where: { offlinePackageId: fixture.issued.package.id, statusCode: 'pending' },
      select: { id: true, actionCode: true, approvalPolicyCode: true },
    });
    expect(review).toMatchObject({ actionCode: 'check_out', approvalPolicyCode: 'approvable' });
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
    const approving = request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${fixture.row.id}/onsite/offline-review-items/` +
          `${review.id}/approve`,
      )
      .set('Authorization', auth)
      .send({ operationKey: key(), reason: 'C3-1 候选锁等待离线复核批准' })
      .then((response) => response);
    const blockerPid = await Promise.race([
      auditEntered,
      approving.then((response) => {
        throw new Error(
          `C3-1 offline review approval ended before the audit barrier: ${response.status} ${JSON.stringify(response.body)}`,
        );
      }),
    ]);
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
          message: 'candidate did not wait for the real offline review approval activity lock',
        },
      );
    } finally {
      releaseAudit();
      expect((await approving).status).toBe(201);
    }
    const response = await calculating;
    expect(response.status).toBe(201);
    const candidateId = (response.body.data as { candidateId: string }).candidateId;
    const source = await prisma.activityMetricCandidateSource.findFirstOrThrow({
      where: { candidateId },
    });
    expect(source).toMatchObject({ identityId: fixture.identity.id, resultCode: 'valid' });
    expect(source.checkOutAt?.getTime()).toBeGreaterThan(source.checkInAt.getTime());
  });

  it('waits for the real settlement re-projection and then snapshots only its committed segment revision', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    await grant(['activity.outcome.calculate', 'activity.outcome.read']);
    const fixture = await createSettlementReprojectionCandidateFixture();
    const recorder = app.get(SettlementDraftAuditRecorder);
    const originalLog = recorder.log.bind(recorder);
    let notifyAudit!: (pid: number) => void;
    let releaseAudit!: () => void;
    const auditEntered = new Promise<number>((resolve) => {
      notifyAudit = resolve;
    });
    const auditReleased = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    jest.spyOn(recorder, 'log').mockImplementationOnce(async (args) => {
      const [backend] = await args.tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid`;
      notifyAudit(backend.pid);
      await auditReleased;
      await originalLog(args);
    });
    const generating = app.get(SettlementDraftService).generate(fixture.row.id, correctionActor(), {
      requestId: 'c3-1-settlement-reprojection-candidate',
      ip: null,
      ua: null,
    });
    const blockerPid = await Promise.race([
      auditEntered,
      generating.then((result) => {
        throw new Error(
          `C3-1 settlement re-projection ended before the audit barrier: ${JSON.stringify(result)}`,
        );
      }),
    ]);
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
          message: 'candidate did not wait for the real settlement re-projection activity lock',
        },
      );
    } finally {
      releaseAudit();
    }
    const generated = await generating;
    expect(generated.segmentsCreated).toBe(1);
    const response = await calculating;
    expect(response.status).toBe(201);
    const candidateId = (response.body.data as { candidateId: string }).candidateId;
    const source = await prisma.activityMetricCandidateSource.findFirstOrThrow({
      where: { candidateId },
    });
    expect(source).toMatchObject({ identityId: fixture.identity.id, resultCode: 'valid' });
    expect(source.checkOutAt?.getTime()).toBeGreaterThan(source.checkInAt.getTime());
  });

  it('waits for a real onsite identity creation and excludes its not-yet-attended identity', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    await grant([
      'activity.outcome.calculate',
      'activity.outcome.read',
      'activity-registration.create.record',
    ]);
    const fixture = await createOnsiteIdentityWriterFixture();
    const recorder = app.get(ActivityRegistrationAuditRecorder);
    const originalLogOnsiteCreate = recorder.logOnsiteCreate.bind(recorder);
    let notifyAudit!: (pid: number) => void;
    let releaseAudit!: () => void;
    const auditEntered = new Promise<number>((resolve) => {
      notifyAudit = resolve;
    });
    const auditReleased = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    jest.spyOn(recorder, 'logOnsiteCreate').mockImplementationOnce(async (args) => {
      const [backend] = await args.tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid`;
      notifyAudit(backend.pid);
      await auditReleased;
      await originalLogOnsiteCreate(args);
    });
    const creating = request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${fixture.row.id}/onsite-participations`)
      .set('Authorization', auth)
      .send({
        operationKey: key(),
        memberId: fixture.target.id,
        sessionId: fixture.session.id,
        reason: 'C3-1 候选锁等待身份创建',
      })
      .then((response) => response);
    const blockerPid = await Promise.race([
      auditEntered,
      creating.then((response) => {
        throw new Error(
          `C3-1 onsite identity creation ended before the audit barrier: ${response.status} ${JSON.stringify(response.body)}`,
        );
      }),
    ]);
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
          message: 'candidate did not wait for the real onsite identity creation activity lock',
        },
      );
    } finally {
      releaseAudit();
    }
    const created = await creating;
    expect(created.status).toBe(201);
    const createdIdentityId = (created.body.data as { participationIdentityId: string })
      .participationIdentityId;
    const response = await calculating;
    expect(response.status).toBe(201);
    const candidateId = (response.body.data as { candidateId: string }).candidateId;
    const candidate = await prisma.activityMetricCandidate.findUniqueOrThrow({
      where: { id: candidateId },
      include: { sources: { orderBy: { ordinal: 'asc' } } },
    });
    expect(candidate.sources).toHaveLength(1);
    expect(candidate.sources[0]).toMatchObject({
      identityId: fixture.existingSource.identity.id,
      resultCode: 'valid',
    });
    expect(candidate.sources.some((source) => source.identityId === createdIdentityId)).toBe(false);
    expect(
      (await get(`${base(fixture.row.id)}/${candidateId}`).expect(200)).body.data.values,
    ).toMatchObject([{ value: 1, unitCode: 'count' }]);
  });

  it('makes real session-cancellation effects wait behind a candidate and retains historical sources', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    await grant(['activity.outcome.calculate', 'activity.outcome.read']);
    const fixture = await createSessionCancellationWriterFixture();
    const auditLogs = app.get(AuditLogsService);
    const candidateAudit = app.get(ActivityMetricCandidateAuditRecorder);
    const originalCandidateLog = candidateAudit.log.bind(candidateAudit);
    let notifyAudit!: (pid: number) => void;
    let releaseAudit!: () => void;
    const auditEntered = new Promise<number>((resolve) => {
      notifyAudit = resolve;
    });
    const auditReleased = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    jest
      .spyOn(candidateAudit, 'log')
      .mockImplementationOnce(async (tx, actor, meta, result, priorId) => {
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid`;
        notifyAudit(backend.pid);
        await auditReleased;
        await originalCandidateLog(tx, actor, meta, result, priorId);
      });
    const calculating = post(base(fixture.row.id), command()).then((response) => response);
    const blockerPid = await Promise.race([
      auditEntered,
      calculating.then((response) => {
        throw new Error(
          `C3-1 candidate ended before the audit barrier: ${response.status} ${JSON.stringify(response.body)}`,
        );
      }),
    ]);
    const cancelling = prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Activity" WHERE "id" = ${fixture.row.id} FOR UPDATE`;
      if (locked.length !== 1)
        throw new Error('C3-1 session cancellation fixture activity is missing');
      await tx.activitySession.update({
        where: { id: fixture.session.id },
        data: { statusCode: 'cancelled' },
      });
      return activitySessionCancellationEffects.applyInTransactionTrusted(
        tx,
        {
          notificationProducer: app.get(ActivityNotificationProducer),
          auditLogs,
        },
        {
          activityId: fixture.row.id,
          cancelledSessionIds: [fixture.session.id],
          versionKey: key(),
          at: new Date(),
          actorUserId: actorId,
          actorRoleSnap: Role.SUPER_ADMIN,
          auditMeta: { requestId: key(), ip: null, ua: null },
        },
      );
    });
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
          message: 'real session cancellation did not wait for the candidate activity lock',
        },
      );
    } finally {
      releaseAudit();
    }
    const initial = await calculating;
    expect(initial.status).toBe(201);
    const initialCandidateId = (initial.body.data as { candidateId: string }).candidateId;
    const initialCandidate = await prisma.activityMetricCandidate.findUniqueOrThrow({
      where: { id: initialCandidateId },
      include: { sources: { orderBy: { ordinal: 'asc' } } },
    });
    expect(initialCandidate.sources).toHaveLength(1);
    expect(initialCandidate.sources[0]).toMatchObject({
      identityId: fixture.existingSource.identity.id,
      resultCode: 'valid',
    });
    expect((await cancelling).cancelledIdentityCount).toBe(1);
    await expect(
      prisma.activitySession.findUniqueOrThrow({
        where: { id: fixture.session.id },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'cancelled' });
    await expect(
      prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: fixture.identity.id },
        select: { currentStatusCode: true, populationIncluded: true },
      }),
    ).resolves.toEqual({ currentStatusCode: 'cancelled', populationIncluded: false });
    const retained = await post(base(fixture.row.id), command(1)).expect(201);
    const retainedCandidateId = (retained.body.data as { candidateId: string }).candidateId;
    const retainedCandidate = await prisma.activityMetricCandidate.findUniqueOrThrow({
      where: { id: retainedCandidateId },
      include: { sources: { orderBy: { ordinal: 'asc' } } },
    });
    expect(retainedCandidate.sources).toHaveLength(1);
    expect(retainedCandidate.sources[0]).toMatchObject({
      identityId: fixture.existingSource.identity.id,
      resultCode: 'valid',
    });
    expect(
      retainedCandidate.sources.some((source) => source.identityId === fixture.identity.id),
    ).toBe(false);
  });

  it('makes real session-reschedule effects wait behind a candidate and then reads the new window coherently', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    await grant(['activity.outcome.calculate', 'activity.outcome.read']);
    const fixture = await createSessionRescheduleWriterFixture();
    const candidateAudit = app.get(ActivityMetricCandidateAuditRecorder);
    const originalCandidateLog = candidateAudit.log.bind(candidateAudit);
    let notifyAudit!: (pid: number) => void;
    let releaseAudit!: () => void;
    const auditEntered = new Promise<number>((resolve) => {
      notifyAudit = resolve;
    });
    const auditReleased = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    jest
      .spyOn(candidateAudit, 'log')
      .mockImplementationOnce(async (tx, actor, meta, result, priorId) => {
        const [backend] = await tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid`;
        notifyAudit(backend.pid);
        await auditReleased;
        await originalCandidateLog(tx, actor, meta, result, priorId);
      });
    const calculating = post(base(fixture.row.id), command()).then((response) => response);
    const blockerPid = await Promise.race([
      auditEntered,
      calculating.then((response) => {
        throw new Error(
          `C3-1 candidate ended before the reschedule audit barrier: ${response.status} ${JSON.stringify(response.body)}`,
        );
      }),
    ]);
    const rescheduledStartAt = new Date(fixture.source.session.startAt.getTime() - 5 * 60_000);
    const rescheduledEndAt = new Date(fixture.source.session.endAt.getTime() + 5 * 60_000);
    const rescheduling = prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Activity" WHERE "id" = ${fixture.row.id} FOR UPDATE`;
      if (locked.length !== 1)
        throw new Error('C3-1 session reschedule fixture activity is missing');
      await tx.activitySession.update({
        where: { id: fixture.source.session.id },
        data: {
          startAt: rescheduledStartAt,
          endAt: rescheduledEndAt,
          checkInOpenAt: new Date(fixture.source.session.checkInOpenAt.getTime() - 5 * 60_000),
          checkInCloseAt: new Date(fixture.source.session.checkInCloseAt.getTime() + 5 * 60_000),
          checkOutOpenAt: new Date(fixture.source.session.checkOutOpenAt.getTime() - 5 * 60_000),
          checkOutCloseAt: new Date(fixture.source.session.checkOutCloseAt.getTime() + 5 * 60_000),
          workflowRevision: { increment: 1 },
        },
      });
      return activitySessionRescheduleEffects.applyInTransactionTrusted(
        { auditLogs: app.get(AuditLogsService) },
        tx,
        {
          activityId: fixture.row.id,
          rescheduledSessionIds: [fixture.source.session.id],
          versionKey: key(),
          at: new Date(),
          actorUserId: actorId,
          actorRoleSnap: Role.SUPER_ADMIN,
          auditMeta: { requestId: key(), ip: null, ua: null },
          jwtSecret,
        },
      );
    });
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
          message: 'real session reschedule did not wait for the candidate activity lock',
        },
      );
    } finally {
      releaseAudit();
    }
    expect((await calculating).status).toBe(201);
    expect(await rescheduling).toMatchObject({
      rescheduledSessionCount: 1,
      reissuedCredentialCount: 2,
    });
    const credentialStates = await prisma.attendanceQrCredential.findMany({
      where: { activityId: fixture.row.id, sessionId: fixture.source.session.id },
      select: { actionCode: true, credentialVersion: true, statusCode: true },
      orderBy: [{ actionCode: 'asc' }, { credentialVersion: 'asc' }],
    });
    expect(credentialStates).toEqual([
      { actionCode: 'check_in', credentialVersion: 1, statusCode: 'revoked' },
      { actionCode: 'check_in', credentialVersion: 2, statusCode: 'active' },
      { actionCode: 'check_out', credentialVersion: 1, statusCode: 'revoked' },
      { actionCode: 'check_out', credentialVersion: 2, statusCode: 'active' },
    ]);
    const after = await post(base(fixture.row.id), command(1)).expect(201);
    const candidateId = (after.body.data as { candidateId: string }).candidateId;
    const source = await prisma.activityMetricCandidateSource.findFirstOrThrow({
      where: { candidateId },
    });
    expect(source).toMatchObject({ identityId: fixture.source.identity.id, resultCode: 'valid' });
    expect(source.checkInAt).toEqual(new Date('2025-01-01T00:00:00.000Z'));
    expect(source.checkOutAt).toEqual(new Date('2025-01-01T01:00:00.000Z'));
  });

  it('has an index-only-viability plan for the bounded current source reads', async () => {
    const fixture = await createPublishedCompleteSourceForOnsiteVoid();
    const plans = await prisma.$transaction(async (tx) => {
      // This only proves that the production-shaped bounded queries have an available index path.
      // It deliberately does not claim a latency budget or replace a production-size benchmark.
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      const [segments] = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(Prisma.sql`
        EXPLAIN (FORMAT JSON, COSTS OFF)
        SELECT segment."id"
        FROM "ParticipantServiceSegmentRevision" AS segment
        INNER JOIN "ActivityParticipationIdentity" AS identity
          ON identity."id" = segment."participationIdentityId"
        WHERE identity."activityId" = ${fixture.row.id}
          AND segment."statusCode" IN ('draft', 'committed')
        ORDER BY segment."id" ASC
        LIMIT 10001`);
      const [events] = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(Prisma.sql`
        EXPLAIN (FORMAT JSON, COSTS OFF)
        SELECT "id"
        FROM "AttendancePunchEvent"
        WHERE "activityId" = ${fixture.row.id}
        ORDER BY "occurredAt" ASC, "id" ASC
        LIMIT 20001`);
      return { segments: segments['QUERY PLAN'], events: events['QUERY PLAN'] };
    });
    const segmentPlan = JSON.stringify(plans.segments);
    const eventPlan = JSON.stringify(plans.events);
    expect(segmentPlan).toContain('Limit');
    expect(eventPlan).toContain('Limit');
    expect(segmentPlan).toMatch(/Index Scan|Bitmap Index Scan/);
    expect(eventPlan).toMatch(/Index Scan|Bitmap Index Scan/);
    expect(segmentPlan).not.toContain('Seq Scan');
    expect(eventPlan).not.toContain('Seq Scan');
  });

  it('uses the exact 1,000-event identity budget for a real dense replace/void chain and rejects 1,001', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    await grant(['activity.outcome.calculate', 'activity.outcome.read']);
    const row = await activity();
    const startAt = new Date('2025-01-01T00:00:00.000Z');
    const endAt = new Date('2025-01-01T02:00:00.000Z');
    const session = await prisma.activitySession.create({
      data: {
        activityId: row.id,
        code: key(),
        name: 'P12 单身份链',
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
    const registration = await prisma.activityRegistration.create({
      data: { activityId: row.id, memberId, statusCode: 'pass' },
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
    const checkInId = randomUUID();
    const checkOutId = randomUUID();
    const operationIds: string[] = [];
    const events: Prisma.AttendancePunchEventCreateManyInput[] = [
      {
        id: checkInId,
        activityId: row.id,
        sessionId: session.id,
        participationIdentityId: identity.id,
        memberId,
        eventTypeCode: 'check_in',
        sourceCode: 'proxy',
        occurredAt: startAt,
        receivedAt: startAt,
        operatorUserId: actorId,
        eventKey: key(),
        requestHash: key(),
        evidenceRevision: 0,
      },
      {
        id: checkOutId,
        activityId: row.id,
        sessionId: session.id,
        participationIdentityId: identity.id,
        memberId,
        eventTypeCode: 'check_out',
        sourceCode: 'proxy',
        occurredAt: endAt,
        receivedAt: endAt,
        operatorUserId: actorId,
        eventKey: key(),
        requestHash: key(),
        evidenceRevision: 0,
      },
    ];
    for (let index = 0; index < 998; index += 1) {
      const id = randomUUID();
      operationIds.push(id);
      const occurredAt = new Date(endAt.getTime() + (index + 1) * 60_000);
      events.push({
        id,
        activityId: row.id,
        sessionId: session.id,
        participationIdentityId: identity.id,
        memberId,
        eventTypeCode: index % 2 === 0 ? 'replace' : 'void',
        sourceCode: 'proxy',
        occurredAt,
        receivedAt: occurredAt,
        operatorUserId: actorId,
        eventKey: key(),
        requestHash: key(),
        supersedesEventId: index === 0 ? checkOutId : operationIds[index - 1],
        reason: 'P12 密集作废替代链',
        evidenceRevision: 0,
      });
    }
    await inFixtureChunks(events, (chunk) =>
      prisma.attendancePunchEvent.createMany({ data: chunk }),
    );
    expect(events).toHaveLength(1_000);
    const projected = app.get(AttendanceSegmentProjectorService).rebuild(
      events.map((event) => ({
        id: event.id!,
        eventTypeCode: event.eventTypeCode,
        occurredAt: event.occurredAt as Date,
        supersedesEventId: event.supersedesEventId ?? null,
      })),
      {
        sessionStartAt: startAt,
        sessionEndAt: endAt,
        lateGraceMinutes: session.lateGraceMinutes,
        earlyLeaveThresholdMinutes: session.earlyLeaveThresholdMinutes,
      },
    );
    expect(projected.chainAnomalies).toEqual([]);
    expect(projected.segments).toHaveLength(1);
    expect(projected.segments[0].sourceCloseEventId).toBe(checkOutId);
    const { exceptionFlags, ...segment } = projected.segments[0];
    await prisma.participantServiceSegmentRevision.create({
      data: {
        ...segment,
        exceptionFlagsJson: exceptionFlags,
        participationIdentityId: identity.id,
        revision: 1,
        statusCode: 'draft',
      },
    });
    const exact = await post(base(row.id), command()).expect(201);
    expect(exact.body.data).toMatchObject({ sourceCount: 1, valueCount: 1 });
    expect(await prisma.activityMetricCandidate.count({ where: { activityId: row.id } })).toBe(1);
    const overflowAt = new Date(endAt.getTime() + 1_000 * 60_000);
    await prisma.attendancePunchEvent.create({
      data: {
        id: randomUUID(),
        activityId: row.id,
        sessionId: session.id,
        participationIdentityId: identity.id,
        memberId,
        eventTypeCode: 'replace',
        sourceCode: 'proxy',
        occurredAt: overflowAt,
        receivedAt: overflowAt,
        operatorUserId: actorId,
        eventKey: key(),
        requestHash: key(),
        supersedesEventId: operationIds.at(-1)!,
        reason: 'P12 身份事件上限',
        evidenceRevision: 0,
      },
    });
    expectBizError(
      await post(base(row.id), command(1)),
      BizCode.ACTIVITY_METRIC_SOURCE_LIMIT_EXCEEDED,
    );
    expect(await prisma.activityMetricCandidate.count({ where: { activityId: row.id } })).toBe(1);
  }, 120000);

  it('persists the 2,000-member, 20,000-event and 10,000-source candidate within its command budget', async () => {
    jest.spyOn(app.get(ActivityWorkflowGate), 'isV11Enabled').mockReturnValue(true);
    await grant(['activity.outcome.calculate', 'activity.outcome.read']);
    const row = await activity();
    const sessionStartAt = new Date('2025-01-01T00:00:00.000Z');
    const sessionEndAt = new Date('2025-01-01T12:00:00.000Z');
    const session = await prisma.activitySession.create({
      data: {
        activityId: row.id,
        code: key(),
        name: 'P12 满额候选',
        startAt: sessionStartAt,
        endAt: sessionEndAt,
        locationText: '测试',
        checkInOpenAt: sessionStartAt,
        checkInCloseAt: sessionEndAt,
        checkOutOpenAt: sessionStartAt,
        checkOutCloseAt: sessionEndAt,
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
    });
    const memberIds: string[] = [];
    const identityIds: string[] = [];
    const members: Prisma.MemberCreateManyInput[] = [];
    const registrations: Prisma.ActivityRegistrationCreateManyInput[] = [];
    const identities: Prisma.ActivityParticipationIdentityCreateManyInput[] = [];
    const events: Prisma.AttendancePunchEventCreateManyInput[] = [];
    const segments: Prisma.ParticipantServiceSegmentRevisionCreateManyInput[] = [];
    let firstCloseId = '';
    for (let memberIndex = 0; memberIndex < 2_000; memberIndex += 1) {
      const scaleMemberId = randomUUID();
      const registrationId = randomUUID();
      const identityId = randomUUID();
      memberIds.push(scaleMemberId);
      identityIds.push(identityId);
      members.push({
        id: scaleMemberId,
        memberNo: key(),
        ...memberIdentityData(`P12 规模队员 ${memberIndex}`),
        gradeCode: 'level-3',
      });
      registrations.push({
        id: registrationId,
        activityId: row.id,
        memberId: scaleMemberId,
        statusCode: 'pass',
      });
      identities.push({
        id: identityId,
        activityId: row.id,
        sessionId: session.id,
        registrationId,
        memberId: scaleMemberId,
        currentStatusCode: 'pass',
        populationIncluded: true,
      });
      for (let segmentIndex = 0; segmentIndex < 5; segmentIndex += 1) {
        const checkInId = randomUUID();
        const checkOutId = randomUUID();
        if (memberIndex === 0 && segmentIndex === 0) firstCloseId = checkOutId;
        const checkInAt = new Date(sessionStartAt.getTime() + segmentIndex * 2 * 3_600_000);
        const checkOutAt = new Date(checkInAt.getTime() + 3_600_000);
        events.push(
          {
            id: checkInId,
            activityId: row.id,
            sessionId: session.id,
            participationIdentityId: identityId,
            memberId: scaleMemberId,
            eventTypeCode: 'check_in',
            sourceCode: 'proxy',
            occurredAt: checkInAt,
            receivedAt: checkInAt,
            operatorUserId: actorId,
            eventKey: key(),
            requestHash: key(),
            evidenceRevision: 0,
          },
          {
            id: checkOutId,
            activityId: row.id,
            sessionId: session.id,
            participationIdentityId: identityId,
            memberId: scaleMemberId,
            eventTypeCode: 'check_out',
            sourceCode: 'proxy',
            occurredAt: checkOutAt,
            receivedAt: checkOutAt,
            operatorUserId: actorId,
            eventKey: key(),
            requestHash: key(),
            evidenceRevision: 0,
          },
        );
        segments.push({
          id: randomUUID(),
          participationIdentityId: identityId,
          segmentKey: String(segmentIndex + 1).padStart(4, '0'),
          revision: 1,
          sourceCheckInEventId: checkInId,
          sourceCloseEventId: checkOutId,
          resultCode: 'valid',
          statusCode: 'draft',
          checkInAt,
          checkOutAt,
          serviceHours: 1,
          exceptionFlagsJson: [],
        });
      }
    }
    await inFixtureChunks(members, (chunk) => prisma.member.createMany({ data: chunk }));
    await inFixtureChunks(registrations, (chunk) =>
      prisma.activityRegistration.createMany({ data: chunk }),
    );
    await inFixtureChunks(identities, (chunk) =>
      prisma.activityParticipationIdentity.createMany({ data: chunk }),
    );
    await inFixtureChunks(events, (chunk) =>
      prisma.attendancePunchEvent.createMany({ data: chunk }),
    );
    await inFixtureChunks(segments, (chunk) =>
      prisma.participantServiceSegmentRevision.createMany({ data: chunk }),
    );
    expect(members).toHaveLength(2_000);
    expect(events).toHaveLength(20_000);
    expect(segments).toHaveLength(10_000);
    const startedAt = Date.now();
    const exact = await post(base(row.id), command()).expect(201);
    expect(Date.now() - startedAt).toBeLessThan(30_000);
    const candidateId = (exact.body.data as { candidateId: string }).candidateId;
    expect(exact.body.data).toMatchObject({ sourceCount: 10_000, valueCount: 1 });
    expect(await prisma.activityMetricCandidateSource.count({ where: { candidateId } })).toBe(
      10_000,
    );
    const overflowAt = new Date(sessionEndAt.getTime() + 60_000);
    await prisma.attendancePunchEvent.create({
      data: {
        id: randomUUID(),
        activityId: row.id,
        sessionId: session.id,
        participationIdentityId: identityIds[0],
        memberId: memberIds[0],
        eventTypeCode: 'void',
        sourceCode: 'proxy',
        occurredAt: overflowAt,
        receivedAt: overflowAt,
        operatorUserId: actorId,
        eventKey: key(),
        requestHash: key(),
        supersedesEventId: firstCloseId,
        reason: 'P12 活动事件上限',
        evidenceRevision: 0,
      },
    });
    expectBizError(
      await post(base(row.id), command(1)),
      BizCode.ACTIVITY_METRIC_SOURCE_LIMIT_EXCEEDED,
    );
    expect(await prisma.activityMetricCandidate.count({ where: { activityId: row.id } })).toBe(1);
  }, 180000);

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
