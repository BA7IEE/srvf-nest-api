import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import type { JwtConfig } from '../../src/config/jwt.config';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { signAttendanceMemberCredential } from '../../src/modules/attendances/attendance-member-credential-token';
import {
  AttendanceOfflinePackageTokenService,
  signAttendanceOfflineEvent,
  type AttendanceOfflinePackageTokenPayload,
} from '../../src/modules/attendances/attendance-offline-package-token';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

type Scenario = { activityId: string; sessionId: string; positionId: string };
type IssuedPackage = {
  package: {
    id: string;
    activityId: string;
    sessionId: string;
    deviceId: string;
    statusCode: string;
    nextExpectedSequence: number;
  };
  packageToken: string;
};

describe('activity batch6 offline package exact HTTP wire and writer', () => {
  const previousResponsibilityWorkflow = process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  let app: INestApplication;
  let peerApp: INestApplication;
  let prisma: PrismaService;
  let peerPrisma: PrismaService;
  let tokens: AttendanceOfflinePackageTokenService;
  let jwtSecret: string;
  let managerAuth: string;
  let managerPeerAuth: string;
  let applicantAuth: string;
  let operatorAuth: string;
  let adminAuth: string;
  let managerUserId: string;
  let managerMemberId: string;
  let applicantUserId: string;
  let applicantMemberId: string;
  let operatorUserId: string;
  let operatorMemberId: string;
  let activityOwnerRoleId: string;
  let sequence = 0;

  beforeAll(async () => {
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    peerApp = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    peerPrisma = peerApp.get(PrismaService);
    tokens = app.get(AttendanceOfflinePackageTokenService);
    const jwt = app.get(ConfigService).get<JwtConfig>('jwt');
    if (!jwt) throw new Error('jwt config is required for offline credential e2e');
    jwtSecret = jwt.secret;
    activityOwnerRoleId = (await seedActivityResponsibilitySystemRoles(app))['activity-owner'];

    const [manager, applicant, operator, admin] = await Promise.all([
      createTestUser(app, { username: 'batch6-offline-manager', role: Role.USER }),
      createTestUser(app, { username: 'batch6-offline-applicant', role: Role.USER }),
      createTestUser(app, { username: 'batch6-offline-operator', role: Role.USER }),
      createTestUser(app, { username: 'batch6-offline-admin', role: Role.SUPER_ADMIN }),
    ]);
    const [managerMember, applicantMember, operatorMember, adminMember] = await Promise.all([
      prisma.member.create({
        data: {
          memberNo: 'B6-OFFLINE-MANAGER',
          displayName: 'Batch6 Offline Manager',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
      prisma.member.create({
        data: {
          memberNo: 'B6-OFFLINE-APPLICANT',
          displayName: 'Batch6 Offline Applicant',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
      prisma.member.create({
        data: {
          memberNo: 'B6-OFFLINE-OPERATOR',
          displayName: 'Batch6 Offline Operator',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
      prisma.member.create({
        data: {
          memberNo: 'B6-OFFLINE-ADMIN',
          displayName: 'Batch6 Offline Admin',
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
    ]);
    managerUserId = manager.id;
    managerMemberId = managerMember.id;
    applicantUserId = applicant.id;
    applicantMemberId = applicantMember.id;
    operatorUserId = operator.id;
    operatorMemberId = operatorMember.id;
    await Promise.all([
      prisma.user.update({ where: { id: manager.id }, data: { memberId: managerMember.id } }),
      prisma.user.update({ where: { id: applicant.id }, data: { memberId: applicantMember.id } }),
      prisma.user.update({ where: { id: operator.id }, data: { memberId: operatorMember.id } }),
      prisma.user.update({ where: { id: admin.id }, data: { memberId: adminMember.id } }),
    ]);
    [managerAuth, managerPeerAuth, applicantAuth, operatorAuth, adminAuth] = await Promise.all([
      loginAs(app, manager.username).then(({ authHeader }) => authHeader),
      loginAs(peerApp, manager.username).then(({ authHeader }) => authHeader),
      loginAs(app, applicant.username).then(({ authHeader }) => authHeader),
      loginAs(app, operator.username).then(({ authHeader }) => authHeader),
      loginAs(app, admin.username).then(({ authHeader }) => authHeader),
    ]);
  }, 90_000);

  afterAll(async () => {
    await Promise.all([app.close(), peerApp.close()]);
    if (previousResponsibilityWorkflow === undefined) {
      delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
    } else {
      process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = previousResponsibilityWorkflow;
    }
  });

  async function createScenario(capacity = 1): Promise<Scenario> {
    const index = ++sequence;
    const now = new Date();
    const startAt = new Date(now.getTime() - 10 * 60_000);
    const endAt = new Date(now.getTime() + 2 * 60 * 60_000);
    const organization = await prisma.organization.create({
      data: { name: `Batch6 Offline Team ${index}`, nodeTypeCode: 'batch6-offline-team' },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: `Batch6 Offline Activity ${index}`,
        activityTypeCode: 'training',
        organizationId: organization.id,
        startAt,
        endAt,
        location: 'Batch6 Offline Field',
        statusCode: 'published',
        publishedAt: now,
        capacity,
        isPublicRegistration: true,
        allocationModeCode: 'first_come',
        registrationDeadline: new Date(now.getTime() + 60 * 60_000),
      },
      select: { id: true },
    });
    const publishReview = await prisma.activityPublishReview.create({
      data: {
        activityId: activity.id,
        requestType: 'initial',
        requestVersion: 1,
        baseRevision: 0,
        status: 'approved',
        snapshot: {},
        directPublish: true,
        submittedByUserId: managerUserId,
        reviewedByUserId: managerUserId,
        reviewedAt: now,
      },
      select: { id: true },
    });
    await prisma.activityRuleSnapshot.create({
      data: {
        activityId: activity.id,
        workflowRevision: 0,
        resolvedConfig: {},
        snapshotHash: 'a'.repeat(64),
        createdByReviewId: publishReview.id,
      },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: `batch6-offline-session-${index}`,
        name: `Batch6 Offline Session ${index}`,
        startAt,
        endAt,
        locationText: 'Batch6 Offline Field',
        capacity,
        checkInOpenAt: new Date(now.getTime() - 30 * 60_000),
        checkInCloseAt: new Date(now.getTime() + 30 * 60_000),
        checkOutOpenAt: new Date(now.getTime() - 30 * 60_000),
        checkOutCloseAt: new Date(now.getTime() + 3 * 60 * 60_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const position = await prisma.activitySessionPosition.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        code: `batch6-offline-position-${index}`,
        name: `Batch6 Offline Position ${index}`,
        attendanceRoleCode: 'volunteer',
        capacity,
      },
      select: { id: true },
    });
    await prisma.activityCapacityBucket.createMany({
      data: [
        {
          activityId: activity.id,
          scopeTypeCode: 'activity_person',
          scopeId: activity.id,
          capacity,
        },
        {
          activityId: activity.id,
          scopeTypeCode: 'session_participation',
          scopeId: session.id,
          capacity,
        },
        {
          activityId: activity.id,
          scopeTypeCode: 'position_participation',
          scopeId: position.id,
          capacity,
        },
      ],
    });
    await prisma.activityEvidenceState.create({ data: { activityId: activity.id } });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: managerMemberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: managerUserId,
        source: 'publish',
      },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: managerMemberId,
        roleId: activityOwnerRoleId,
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activity.id,
        status: BindingStatus.ACTIVE,
        note: `batch6 offline fixture ${index}`,
      },
    });
    return { activityId: activity.id, sessionId: session.id, positionId: position.id };
  }

  async function submitMember(scenario: Scenario, auth: string, memberId: string): Promise<string> {
    const submitted = await request(httpServer(app))
      .post(`/api/app/v1/activities/${scenario.activityId}/registrations`)
      .set('Authorization', auth)
      .send({
        operationKey: `batch6-offline-register-${++sequence}`,
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: scenario.sessionId, positionIds: [scenario.positionId] }],
      });
    expect(submitted.status).toBe(201);
    return prisma.activityParticipationIdentity
      .findFirstOrThrow({
        where: {
          activityId: scenario.activityId,
          sessionId: scenario.sessionId,
          memberId,
        },
        select: { id: true },
      })
      .then((identity) => identity.id);
  }

  async function submitApplicant(scenario: Scenario): Promise<string> {
    return submitMember(scenario, applicantAuth, applicantMemberId);
  }

  async function issuePackage(
    targetApp: INestApplication,
    auth: string,
    scenario: Scenario,
    input: { operationKey?: string; deviceId?: string } = {},
  ): Promise<{ response: request.Response; data: IssuedPackage }> {
    const response = await request(httpServer(targetApp))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/` +
          `${scenario.sessionId}/offline-packages`,
      )
      .set('Authorization', auth)
      .send({
        operationKey: input.operationKey ?? `batch6-offline-issue-${++sequence}`,
        deviceId: input.deviceId ?? `offline-device-${sequence}`,
      });
    if (response.status !== 201) {
      throw new Error(`offline issue failed: ${response.status} ${JSON.stringify(response.body)}`);
    }
    return { response, data: response.body.data as IssuedPackage };
  }

  function decodePackageToken(token: string): AttendanceOfflinePackageTokenPayload {
    const payloadPart = token.split('.')[0];
    return JSON.parse(
      Buffer.from(payloadPart, 'base64url').toString('utf8'),
    ) as AttendanceOfflinePackageTokenPayload;
  }

  function memberCredential(
    deviceTime: Date,
    subject: { userId: string; memberId: string } = {
      userId: applicantUserId,
      memberId: applicantMemberId,
    },
  ): string {
    return signAttendanceMemberCredential(
      {
        ...subject,
        issuedAt: new Date(deviceTime.getTime() - 1_000),
        expiresAt: new Date(deviceTime.getTime() + 59_000),
        nonce: `batch6-offline-member-credential-${++sequence}`,
      },
      jwtSecret,
    );
  }

  function signedUpload(
    issued: IssuedPackage,
    overrides: Partial<{
      sequence: number;
      priorHash: string;
      eventKey: string;
      actionCode: 'check_in' | 'check_out';
      deviceTime: Date;
      memberCredential: string;
      longitude: number;
      latitude: number;
      accuracy: number;
    }> = {},
  ) {
    const payload = decodePackageToken(issued.packageToken);
    const deviceTime = overrides.deviceTime ?? new Date();
    const credential = overrides.memberCredential ?? memberCredential(deviceTime);
    const event = {
      packageId: issued.package.id,
      sequence: overrides.sequence ?? payload.sequenceStart,
      priorHash: overrides.priorHash ?? payload.chainAnchorHash,
      eventKey: overrides.eventKey ?? `batch6-offline-event-${++sequence}`,
      actionCode: overrides.actionCode ?? ('check_in' as const),
      deviceTime,
      memberCredential: credential,
      longitude: overrides.longitude ?? 12.3456789,
      latitude: overrides.latitude ?? 23.456789,
      accuracy: overrides.accuracy ?? 7.25,
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

  async function upload(
    targetApp: INestApplication,
    auth: string,
    scenario: Scenario,
    issued: IssuedPackage,
    body: ReturnType<typeof signedUpload>,
  ): Promise<request.Response> {
    return request(httpServer(targetApp))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-packages/` +
          `${issued.package.id}/upload`,
      )
      .set('Authorization', auth)
      .send(body);
  }

  async function reviewList(scenario: Scenario): Promise<request.Response> {
    return request(httpServer(app))
      .get(`/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-review-items`)
      .set('Authorization', managerAuth);
  }

  it('AC-045: issue/upload uses the unique Punch writer and exact two-pool replay without sensitive leakage', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);
    const operationKey = `batch6-offline-exact-issue-${++sequence}`;
    const { response: issuedResponse, data: issued } = await issuePackage(
      app,
      managerAuth,
      scenario,
      { operationKey, deviceId: `exact-device-${sequence}` },
    );
    expect(issuedResponse.body.data).toMatchObject({
      package: {
        activityId: scenario.activityId,
        sessionId: scenario.sessionId,
        statusCode: 'active',
        packageVersion: 1,
        packageKeyVersion: 0,
        sequenceStart: 1,
        nextExpectedSequence: 1,
        ruleSnapshotHash: 'a'.repeat(64),
      },
    });
    const replayedIssue = await issuePackage(peerApp, managerPeerAuth, scenario, {
      operationKey,
      deviceId: issued.package.deviceId,
    });
    expect(replayedIssue.data.packageToken).toBe(issued.packageToken);
    expect(replayedIssue.data.package.id).toBe(issued.package.id);
    const changedIssue = await request(httpServer(peerApp))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/` +
          `${scenario.sessionId}/offline-packages`,
      )
      .set('Authorization', managerPeerAuth)
      .send({ operationKey, deviceId: 'changed-device' });
    expect(changedIssue.body.code).toBe(22088);

    const event = signedUpload(issued);
    const accepted = await upload(app, managerAuth, scenario, issued, event);
    expect(accepted.status).toBe(201);
    expect(accepted.body.data).toMatchObject({
      eventTypeCode: 'check_in',
      segmentStatusCode: 'open',
    });
    const rawSuccess = JSON.stringify(accepted.body);
    expect(rawSuccess).not.toContain(issued.packageToken);
    expect(rawSuccess).not.toContain(event.memberCredential);
    expect(rawSuccess).not.toContain(event.signature);
    expect(rawSuccess).not.toContain('longitude');
    expect(rawSuccess).not.toContain('latitude');

    const formal = await prisma.attendancePunchEvent.findUniqueOrThrow({
      where: { eventKey: event.eventKey },
      select: {
        id: true,
        participationIdentityId: true,
        sourceCode: true,
        offlinePackageId: true,
        offlineSequence: true,
        offlinePriorHash: true,
        offlineEventPayloadHash: true,
        longitude: true,
        latitude: true,
      },
    });
    expect(formal).toMatchObject({
      participationIdentityId,
      sourceCode: 'offline',
      offlinePackageId: issued.package.id,
      offlineSequence: 1,
      offlinePriorHash: event.priorHash,
    });
    expect(formal.offlineEventPayloadHash).toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      prisma.participantServiceSegmentRevision.count({
        where: { sourceCheckInEventId: formal.id, statusCode: { not: 'superseded' } },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.activityEvidenceState.findUniqueOrThrow({
        where: { activityId: scenario.activityId },
        select: { evidenceRevision: true },
      }),
    ).resolves.toEqual({ evidenceRevision: 1 });

    const exactReplay = await upload(peerApp, managerPeerAuth, scenario, issued, event);
    expect(exactReplay.status).toBe(201);
    expect(exactReplay.body.data.eventId).toBe(formal.id);
    const changedSignature = {
      ...event,
      signature: `${event.signature.startsWith('A') ? 'B' : 'A'}${event.signature.slice(1)}`,
    };
    const signatureConflict = await upload(
      peerApp,
      managerPeerAuth,
      scenario,
      issued,
      changedSignature,
    );
    expect(signatureConflict.body.code).toBe(22088);
    const changedEvent = signedUpload(issued, {
      eventKey: event.eventKey,
      deviceTime: new Date(event.deviceTime),
      memberCredential: event.memberCredential,
      longitude: 12.3456788,
    });
    const conflict = await upload(peerApp, managerPeerAuth, scenario, issued, changedEvent);
    expect(conflict.body.code).toBe(22088);
    await expect(
      peerPrisma.attendancePunchEvent.count({ where: { eventKey: event.eventKey } }),
    ).resolves.toBe(1);

    const storedPackage = await prisma.offlinePackage.findUniqueOrThrow({
      where: { id: issued.package.id },
      select: { tokenDigest: true, nextExpectedSequence: true, lastAcceptedHash: true },
    });
    expect(storedPackage.tokenDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(storedPackage.tokenDigest).not.toBe(issued.packageToken);
    expect(storedPackage.nextExpectedSequence).toBe(2);
    expect(storedPackage.lastAcceptedHash).toMatch(/^[0-9a-f]{64}$/u);
    const recoveredIssue = await issuePackage(peerApp, managerPeerAuth, scenario, {
      operationKey,
      deviceId: issued.package.deviceId,
    });
    expect(recoveredIssue.data.packageToken).toBe(issued.packageToken);
    expect(recoveredIssue.data.package.nextExpectedSequence).toBe(2);
    const auditRows = await prisma.auditLog.findMany({
      where: { resourceType: 'activity', resourceId: scenario.activityId },
      select: { context: true },
    });
    const auditJson = JSON.stringify(auditRows);
    expect(auditJson).not.toContain(issued.packageToken);
    expect(auditJson).not.toContain(event.memberCredential);
    expect(auditJson).not.toContain(event.signature);
    expect(auditJson).not.toContain('longitude');
    expect(auditJson).not.toContain('latitude');
  }, 90_000);

  it('22097 rejects an unverifiable package with zero review and zero PunchEvent', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const { data: issued } = await issuePackage(app, managerAuth, scenario);
    const body = signedUpload(issued);
    body.packageToken = `${body.packageToken.startsWith('A') ? 'B' : 'A'}${body.packageToken.slice(1)}`;

    const rejected = await upload(app, managerAuth, scenario, issued, body);
    expect(rejected.body.code).toBe(22097);
    await expect(
      prisma.offlinePunchReviewItem.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.attendancePunchEvent.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(0);
  });

  it('rejects an uploader without responsibility before token proof and keeps every branch at zero writes', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const { data: issued } = await issuePackage(app, managerAuth, scenario);
    const auditBefore = await prisma.auditLog.count({
      where: { resourceType: 'activity', resourceId: scenario.activityId },
    });
    const invalidToken = signedUpload(issued);
    invalidToken.packageToken =
      `${invalidToken.packageToken.startsWith('A') ? 'B' : 'A'}` +
      invalidToken.packageToken.slice(1);
    const mismatched = {
      ...issued,
      packageToken: tokens.sign({
        ...decodePackageToken(issued.packageToken),
        activityId: `${scenario.activityId}-mismatch`,
      }),
    };
    const invalidCredential = signedUpload(issued);
    invalidCredential.memberCredential =
      `${invalidCredential.memberCredential.startsWith('A') ? 'B' : 'A'}` +
      invalidCredential.memberCredential.slice(1);

    for (const [candidate, body] of [
      [issued, invalidToken],
      [mismatched, signedUpload(mismatched)],
      [issued, invalidCredential],
      [issued, signedUpload(issued)],
    ] as const) {
      const rejected = await upload(app, applicantAuth, scenario, candidate, body);
      expect(rejected.status).toBe(403);
      expect(rejected.body.code).toBe(BizCode.RBAC_FORBIDDEN.code);
    }
    await expect(
      prisma.offlinePunchReviewItem.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.attendancePunchEvent.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.auditLog.count({
        where: { resourceType: 'activity', resourceId: scenario.activityId },
      }),
    ).resolves.toBe(auditBefore);
  });

  it('refuses to issue an empty roster package without creating a token row', async () => {
    const scenario = await createScenario();
    const rejected = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/sessions/` +
          `${scenario.sessionId}/offline-packages`,
      )
      .set('Authorization', managerAuth)
      .send({ operationKey: `empty-roster-${++sequence}`, deviceId: `empty-device-${sequence}` });
    expect(rejected.status).toBe(400);
    await expect(
      prisma.offlinePackage.count({ where: { activityId: scenario.activityId } }),
    ).resolves.toBe(0);
  });

  it('signature anomaly is safe, reject-only, never writes PunchEvent, and cannot later approve', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const { data: issued } = await issuePackage(app, managerAuth, scenario);
    const body = signedUpload(issued);
    body.signature = `${body.signature.startsWith('A') ? 'B' : 'A'}${body.signature.slice(1)}`;

    const staged = await upload(app, managerAuth, scenario, issued, body);
    expect(staged.body.code).toBe(22099);
    const list = await reviewList(scenario);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    expect(list.body.data.items[0]).toMatchObject({
      packageId: issued.package.id,
      anomalyCode: 'signature_invalid',
      approvalPolicyCode: 'reject_only',
      statusCode: 'pending',
    });
    const safeJson = JSON.stringify(list.body);
    expect(safeJson).not.toContain(body.signature);
    expect(safeJson).not.toContain(body.memberCredential);
    for (const forbidden of [
      'packageToken',
      'signatureDigest',
      'eventPayloadHash',
      'providedPriorHash',
      'memberCredential',
      'longitude',
      'latitude',
      'accuracy',
    ]) {
      expect(safeJson).not.toContain(forbidden);
    }
    const reviewId = list.body.data.items[0].id as string;
    const approveRejected = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-review-items/` +
          `${reviewId}/approve`,
      )
      .set('Authorization', managerAuth)
      .send({ operationKey: `reject-only-approve-${++sequence}`, reason: '拒绝项不得批准' });
    expect(approveRejected.status).toBe(400);
    const rejected = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-review-items/` +
          `${reviewId}/reject`,
      )
      .set('Authorization', managerAuth)
      .send({ operationKey: `reject-only-reject-${++sequence}`, reason: '签名证据不可信' });
    expect(rejected.status).toBe(201);
    expect(rejected.body.data).toMatchObject({ statusCode: 'rejected', formalPunchEventId: null });
    await expect(
      prisma.attendancePunchEvent.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.offlinePackage.findUniqueOrThrow({
        where: { id: issued.package.id },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'revoked' });
    const approveAfterReject = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-review-items/` +
          `${reviewId}/approve`,
      )
      .set('Authorization', managerAuth)
      .send({ operationKey: `approve-after-reject-${++sequence}`, reason: '不得翻转已拒绝结论' });
    expect(approveAfterReject.status).toBe(400);
  });

  it('integrity failure stays reject-only even when the package was already revoked', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const { data: issued } = await issuePackage(app, managerAuth, scenario);
    const revoked = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-packages/` +
          `${issued.package.id}/revoke`,
      )
      .set('Authorization', managerAuth)
      .send({ operationKey: `integrity-revoke-${++sequence}`, reason: '验证终态不掩盖签名异常' });
    expect(revoked.status).toBe(201);
    const body = signedUpload(issued);
    body.signature = `${body.signature.startsWith('A') ? 'B' : 'A'}${body.signature.slice(1)}`;

    const staged = await upload(app, managerAuth, scenario, issued, body);
    expect(staged.body.code).toBe(22099);
    const review = await prisma.offlinePunchReviewItem.findFirstOrThrow({
      where: { offlinePackageId: issued.package.id },
      select: { id: true, anomalyCode: true, approvalPolicyCode: true },
    });
    expect(review).toMatchObject({
      anomalyCode: 'signature_invalid',
      approvalPolicyCode: 'reject_only',
    });
    const approveRejected = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-review-items/` +
          `${review.id}/approve`,
      )
      .set('Authorization', managerAuth)
      .send({ operationKey: `integrity-approve-${++sequence}`, reason: '伪造签名不得批准' });
    expect(approveRejected.status).toBe(400);
    await expect(
      prisma.attendancePunchEvent.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.offlinePackage.findUniqueOrThrow({
        where: { id: issued.package.id },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'revoked' });
  });

  it('revoked package stages an approvable item; approve is atomic but never restores write capability', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const { data: issued } = await issuePackage(app, managerAuth, scenario);
    const revoked = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-packages/` +
          `${issued.package.id}/revoke`,
      )
      .set('Authorization', managerAuth)
      .send({ operationKey: `package-revoke-${++sequence}`, reason: '设备离开受控现场' });
    expect(revoked.status).toBe(201);

    const body = signedUpload(issued);
    const staged = await upload(app, managerAuth, scenario, issued, body);
    expect(staged.body.code).toBe(22099);
    const review = await prisma.offlinePunchReviewItem.findFirstOrThrow({
      where: { offlinePackageId: issued.package.id },
      select: { id: true, anomalyCode: true, approvalPolicyCode: true },
    });
    expect(review).toMatchObject({
      anomalyCode: 'package_revoked',
      approvalPolicyCode: 'approvable',
    });
    const approved = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-review-items/` +
          `${review.id}/approve`,
      )
      .set('Authorization', managerAuth)
      .send({ operationKey: `review-approve-${++sequence}`, reason: '核对纸质记录后承认历史事实' });
    expect(approved.status).toBe(201);
    expect(approved.body.data).toMatchObject({ statusCode: 'approved' });
    expect(approved.body.data.formalPunchEventId).toEqual(expect.any(String));
    await expect(
      prisma.attendancePunchEvent.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(1);
    await expect(
      prisma.offlinePackage.findUniqueOrThrow({
        where: { id: issued.package.id },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'revoked' });
  }, 60_000);

  it('failed approval rolls back review resolution, PunchEvent, evidence, segment, and audit together', async () => {
    const scenario = await createScenario();
    const participationIdentityId = await submitApplicant(scenario);
    const { data: issued } = await issuePackage(app, managerAuth, scenario);
    const revoked = await request(httpServer(app))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-packages/` +
          `${issued.package.id}/revoke`,
      )
      .set('Authorization', managerAuth)
      .send({ operationKey: `atomic-revoke-${++sequence}`, reason: '制造可批准的历史事实' });
    expect(revoked.status).toBe(201);
    const staged = await upload(
      app,
      managerAuth,
      scenario,
      issued,
      signedUpload(issued, { actionCode: 'check_out' }),
    );
    expect(staged.body.code).toBe(22099);
    const review = await prisma.offlinePunchReviewItem.findFirstOrThrow({
      where: { offlinePackageId: issued.package.id },
      select: { id: true, statusCode: true, approvalPolicyCode: true },
    });
    expect(review).toMatchObject({ statusCode: 'pending', approvalPolicyCode: 'approvable' });
    const evidenceBefore = await prisma.activityEvidenceState.findUnique({
      where: { activityId: scenario.activityId },
      select: { evidenceRevision: true },
    });
    const auditBefore = await prisma.auditLog.count({
      where: { resourceType: 'activity', resourceId: scenario.activityId },
    });

    const failed = await request(httpServer(peerApp))
      .post(
        `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-review-items/` +
          `${review.id}/approve`,
      )
      .set('Authorization', managerPeerAuth)
      .send({ operationKey: `atomic-approve-${++sequence}`, reason: '应被服务段不变量整笔拒绝' });
    expect(failed.body.code).toBe(22093);
    await expect(
      prisma.offlinePunchReviewItem.findUniqueOrThrow({
        where: { id: review.id },
        select: { statusCode: true, formalPunchEventId: true, resolutionOperationKey: true },
      }),
    ).resolves.toEqual({
      statusCode: 'pending',
      formalPunchEventId: null,
      resolutionOperationKey: null,
    });
    await expect(
      prisma.attendancePunchEvent.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.participantServiceSegmentRevision.count({
        where: { participationIdentityId },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.activityEvidenceState.findUnique({
        where: { activityId: scenario.activityId },
        select: { evidenceRevision: true },
      }),
    ).resolves.toEqual(evidenceBefore);
    await expect(
      prisma.auditLog.count({
        where: { resourceType: 'activity', resourceId: scenario.activityId },
      }),
    ).resolves.toBe(auditBefore);
  }, 60_000);

  it('ADV-003: revoke versus upload is linearized across two PostgreSQL pools', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const { data: issued } = await issuePackage(app, managerAuth, scenario);
    const body = signedUpload(issued);
    const [uploaded, revoked] = await Promise.all([
      upload(app, managerAuth, scenario, issued, body),
      request(httpServer(peerApp))
        .post(
          `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-packages/` +
            `${issued.package.id}/revoke`,
        )
        .set('Authorization', managerPeerAuth)
        .send({ operationKey: `race-revoke-${++sequence}`, reason: '并发撤销线性化' }),
    ]);
    expect(revoked.status).toBe(201);
    const punchCount = await prisma.attendancePunchEvent.count({
      where: { offlinePackageId: issued.package.id },
    });
    if (uploaded.status === 201) {
      expect(punchCount).toBe(1);
    } else {
      expect(uploaded.body.code).toBe(22099);
      expect(punchCount).toBe(0);
      await expect(
        prisma.offlinePunchReviewItem.findFirstOrThrow({
          where: { offlinePackageId: issued.package.id },
          select: { anomalyCode: true },
        }),
      ).resolves.toEqual({ anomalyCode: 'package_revoked' });
    }
    await expect(
      prisma.offlinePackage.findUniqueOrThrow({
        where: { id: issued.package.id },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'revoked' });
  }, 60_000);

  it('review versus revoke re-reads responsibility and package state without lost updates', async () => {
    const scenario = await createScenario(2);
    await submitApplicant(scenario);
    await submitMember(scenario, operatorAuth, operatorMemberId);
    const collaborator = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${scenario.activityId}/responsibilities/collaborators`)
      .set('Authorization', adminAuth)
      .send({
        memberId: operatorMemberId,
        canManageRegistrations: false,
        canManageAttendance: true,
        reason: '离线设备现场协办',
      });
    if (collaborator.status !== 201) {
      throw new Error(
        `collaborator create failed: ${collaborator.status} ${JSON.stringify(collaborator.body)}`,
      );
    }
    const { data: issued } = await issuePackage(app, operatorAuth, scenario);
    const responsibilityRevoked = await request(httpServer(peerApp))
      .delete(
        `/api/admin/v1/activities/${scenario.activityId}/responsibilities/collaborators/` +
          `${collaborator.body.data.id as string}`,
      )
      .set('Authorization', adminAuth);
    expect(responsibilityRevoked.status).toBe(200);
    const body = signedUpload(issued);
    const auditBeforeUnauthorizedReplay = await prisma.auditLog.count({
      where: { resourceType: 'activity', resourceId: scenario.activityId },
    });
    const currentUploaderRejected = await upload(app, operatorAuth, scenario, issued, body);
    expect(currentUploaderRejected.status).toBe(403);
    expect(currentUploaderRejected.body.code).toBe(BizCode.RBAC_FORBIDDEN.code);
    await expect(
      prisma.offlinePunchReviewItem.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.attendancePunchEvent.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.auditLog.count({
        where: { resourceType: 'activity', resourceId: scenario.activityId },
      }),
    ).resolves.toBe(auditBeforeUnauthorizedReplay);
    const staged = await upload(app, managerAuth, scenario, issued, body);
    expect(staged.body.code).toBe(22099);
    const review = await prisma.offlinePunchReviewItem.findFirstOrThrow({
      where: { offlinePackageId: issued.package.id },
      select: { id: true, anomalyCode: true },
    });
    expect(review.anomalyCode).toBe('operator_authorization_revoked');

    const responsibilityRestored = await request(httpServer(peerApp))
      .post(`/api/admin/v1/activities/${scenario.activityId}/responsibilities/collaborators`)
      .set('Authorization', adminAuth)
      .send({
        memberId: operatorMemberId,
        canManageRegistrations: false,
        canManageAttendance: true,
        reason: '验证 pending review 不会因撤权恢复而旁路',
      });
    expect(responsibilityRestored.status).toBe(201);
    const stillPending = await upload(peerApp, managerPeerAuth, scenario, issued, body);
    expect(stillPending.body.code).toBe(22099);
    await expect(
      prisma.offlinePunchReviewItem.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(1);
    await expect(
      prisma.attendancePunchEvent.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(0);

    const [approved, revoked] = await Promise.all([
      request(httpServer(app))
        .post(
          `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-review-items/` +
            `${review.id}/approve`,
        )
        .set('Authorization', managerAuth)
        .send({ operationKey: `review-race-approve-${++sequence}`, reason: '现场记录经二次核验' }),
      request(httpServer(peerApp))
        .post(
          `/api/app/v1/my/managed-activities/${scenario.activityId}/onsite/offline-packages/` +
            `${issued.package.id}/revoke`,
        )
        .set('Authorization', managerPeerAuth)
        .send({ operationKey: `review-race-revoke-${++sequence}`, reason: '复核同时收回设备' }),
    ]);
    expect(approved.status).toBe(201);
    expect(revoked.status).toBe(201);
    await expect(
      prisma.attendancePunchEvent.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(1);
    await expect(
      prisma.offlinePackage.findUniqueOrThrow({
        where: { id: issued.package.id },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'revoked' });
  }, 60_000);

  it.each([
    {
      name: 'sequence gap',
      expected: 'sequence_gap',
      mutate: (issued: IssuedPackage) => signedUpload(issued, { sequence: 2 }),
    },
    {
      name: 'invalid prior chain hash',
      expected: 'hash_chain_invalid',
      mutate: (issued: IssuedPackage) => signedUpload(issued, { priorHash: 'f'.repeat(64) }),
    },
    {
      name: 'future device time',
      expected: 'future_time',
      mutate: (issued: IssuedPackage) => {
        const deviceTime = new Date(Date.now() + 10 * 60_000);
        return signedUpload(issued, { deviceTime, memberCredential: memberCredential(deviceTime) });
      },
    },
    {
      name: 'time outside package window',
      expected: 'time_out_of_window',
      mutate: (issued: IssuedPackage) => {
        const deviceTime = new Date(Date.now() - 40 * 60_000);
        return signedUpload(issued, { deviceTime, memberCredential: memberCredential(deviceTime) });
      },
    },
    {
      name: 'member outside frozen participant snapshot',
      expected: 'participant_snapshot_mismatch',
      mutate: (issued: IssuedPackage) => {
        const deviceTime = new Date();
        return signedUpload(issued, {
          deviceTime,
          memberCredential: memberCredential(deviceTime, {
            userId: operatorUserId,
            memberId: operatorMemberId,
          }),
        });
      },
    },
  ])('$name creates one review and zero PunchEvent', async ({ expected, mutate }) => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const { data: issued } = await issuePackage(app, managerAuth, scenario);
    const staged = await upload(app, managerAuth, scenario, issued, mutate(issued));
    expect(staged.body.code).toBe(22099);
    await expect(
      prisma.offlinePunchReviewItem.findMany({
        where: { offlinePackageId: issued.package.id },
        select: { anomalyCode: true },
      }),
    ).resolves.toEqual([{ anomalyCode: expected }]);
    await expect(
      prisma.attendancePunchEvent.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(0);
  });

  it('device anchor drift becomes one reject-only review, never a second package-token disclosure', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const { data: issued } = await issuePackage(app, managerAuth, scenario);
    const driftedToken = tokens.sign({
      ...decodePackageToken(issued.packageToken),
      deviceId: 'server-verified-different-device',
    });
    await prisma.offlinePackage.update({
      where: { id: issued.package.id },
      data: { tokenDigest: tokens.digest(driftedToken) },
    });
    const drifted = { ...issued, packageToken: driftedToken };
    const response = await upload(app, managerAuth, scenario, drifted, signedUpload(drifted));
    expect(response.body.code).toBe(22099);
    expect(JSON.stringify(response.body)).not.toContain(driftedToken);
    await expect(
      prisma.offlinePunchReviewItem.findMany({
        where: { offlinePackageId: issued.package.id },
        select: { anomalyCode: true, approvalPolicyCode: true },
      }),
    ).resolves.toEqual([{ anomalyCode: 'device_mismatch', approvalPolicyCode: 'reject_only' }]);
    await expect(
      prisma.attendancePunchEvent.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(0);
  });

  it('accepted sequence reused under a new event key stages one duplicate review and no second PunchEvent', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const { data: issued } = await issuePackage(app, managerAuth, scenario);
    const accepted = signedUpload(issued);
    expect((await upload(app, managerAuth, scenario, issued, accepted)).status).toBe(201);
    const duplicate = signedUpload(issued);
    const auditBeforeReview = await prisma.auditLog.count({
      where: { resourceType: 'activity', resourceId: scenario.activityId },
    });
    const first = await upload(app, managerAuth, scenario, issued, duplicate);
    const auditAfterFirstReview = await prisma.auditLog.count({
      where: { resourceType: 'activity', resourceId: scenario.activityId },
    });
    const replay = await upload(peerApp, managerPeerAuth, scenario, issued, duplicate);
    const auditAfterReplay = await prisma.auditLog.count({
      where: { resourceType: 'activity', resourceId: scenario.activityId },
    });
    expect(first.body.code).toBe(22099);
    expect(replay.body.code).toBe(22099);
    expect(auditAfterFirstReview).toBe(auditBeforeReview + 1);
    expect(auditAfterReplay).toBe(auditAfterFirstReview);
    await expect(
      prisma.offlinePunchReviewItem.findMany({
        where: { offlinePackageId: issued.package.id },
        select: { anomalyCode: true, approvalPolicyCode: true },
      }),
    ).resolves.toEqual([{ anomalyCode: 'sequence_duplicate', approvalPolicyCode: 'reject_only' }]);
    await expect(
      prisma.attendancePunchEvent.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(1);
  });

  it('22098 commits one package_expired review while keeping PunchEvent at zero', async () => {
    const scenario = await createScenario();
    await submitApplicant(scenario);
    const { data: issued } = await issuePackage(app, managerAuth, scenario);
    const original = decodePackageToken(issued.packageToken);
    const deviceTime = new Date(Date.now() - 2 * 60_000);
    const expiredPayload: AttendanceOfflinePackageTokenPayload = {
      ...original,
      validFrom: new Date(deviceTime.getTime() - 10 * 60_000).toISOString(),
      validUntil: new Date(deviceTime.getTime() + 30_000).toISOString(),
      uploadUntil: new Date(Date.now() - 1_000).toISOString(),
    };
    const expiredToken = tokens.sign(expiredPayload);
    await prisma.offlinePackage.update({
      where: { id: issued.package.id },
      data: {
        validFrom: new Date(expiredPayload.validFrom),
        validUntil: new Date(expiredPayload.validUntil),
        uploadUntil: new Date(expiredPayload.uploadUntil),
        tokenDigest: tokens.digest(expiredToken),
      },
    });
    const expiredIssued = { ...issued, packageToken: expiredToken };
    const body = signedUpload(expiredIssued, {
      deviceTime,
      memberCredential: memberCredential(deviceTime),
    });
    const auditBefore = await prisma.auditLog.count({
      where: { resourceType: 'activity', resourceId: scenario.activityId },
    });
    const expired = await upload(app, managerAuth, scenario, expiredIssued, body);
    const auditAfterFirst = await prisma.auditLog.count({
      where: { resourceType: 'activity', resourceId: scenario.activityId },
    });
    const replay = await upload(peerApp, managerPeerAuth, scenario, expiredIssued, body);
    const auditAfterReplay = await prisma.auditLog.count({
      where: { resourceType: 'activity', resourceId: scenario.activityId },
    });
    expect(expired.body.code).toBe(22098);
    expect(replay.body.code).toBe(22098);
    expect(auditAfterFirst).toBe(auditBefore + 1);
    expect(auditAfterReplay).toBe(auditAfterFirst);
    await expect(
      prisma.offlinePunchReviewItem.findMany({
        where: { offlinePackageId: issued.package.id },
        select: { anomalyCode: true, approvalPolicyCode: true },
      }),
    ).resolves.toEqual([{ anomalyCode: 'package_expired', approvalPolicyCode: 'approvable' }]);
    await expect(
      prisma.offlinePackage.findUniqueOrThrow({
        where: { id: issued.package.id },
        select: { statusCode: true },
      }),
    ).resolves.toEqual({ statusCode: 'expired' });
    await expect(
      prisma.attendancePunchEvent.count({ where: { offlinePackageId: issued.package.id } }),
    ).resolves.toBe(0);
  });
});
