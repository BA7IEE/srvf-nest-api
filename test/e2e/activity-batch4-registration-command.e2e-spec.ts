import type { INestApplication } from '@nestjs/common';
import { MemberStatus, Prisma, Role } from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { VALID_PNG_IMAGE } from '../helpers/file-fixtures';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

const FAR = {
  start: new Date('2099-11-01T08:00:00.000Z'),
  end: new Date('2099-11-01T12:00:00.000Z'),
  deadline: new Date('2099-10-31T23:59:59.000Z'),
};

function receiptKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected receipt');
  return Object.keys(value).sort();
}

describe('activity batch4 canonical registration command', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let applicantAuth: string;
  let otherAuth: string;
  let superAuth: string;
  let applicantUserId: string;
  let otherUserId: string;
  let applicantMemberId: string;
  let otherMemberId: string;
  let superUserId: string;
  let organizationId: string;
  let activityId: string;
  let noFormActivityId: string;
  let formVersionId: string;
  let sessionAId: string;
  let sessionBId: string;
  let positionA1Id: string;
  let positionA2Id: string;
  let positionB1Id: string;
  let previousInsuranceGate: string | undefined;

  const commandPath = (id = activityId) => `/api/app/v1/activities/${id}/registrations`;
  const uploadSessionPath = (id = activityId) =>
    `/api/app/v1/activities/${id}/registration-upload-sessions`;

  beforeAll(async () => {
    previousInsuranceGate = process.env.INSURANCE_ENFORCEMENT_ENABLED;
    process.env.INSURANCE_ENFORCEMENT_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    const org = await prisma.organization.create({
      data: { name: 'Batch4 Registration Command', nodeTypeCode: 'team', sortOrder: 0 },
      select: { id: true },
    });
    organizationId = org.id;
    const [applicant, other, superUser] = await Promise.all([
      createTestUser(app, { username: 'batch4-command-applicant' }),
      createTestUser(app, { username: 'batch4-command-other' }),
      createTestUser(app, { username: 'batch4-command-super', role: Role.SUPER_ADMIN }),
    ]);
    const [applicantMember, otherMember] = await Promise.all([
      prisma.member.create({
        data: {
          memberNo: 'B4CMD-APPLICANT',
          ...memberIdentityData('Command Applicant'),
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
      prisma.member.create({
        data: {
          memberNo: 'B4CMD-OTHER',
          ...memberIdentityData('Command Other'),
          gradeCode: 'L1',
          status: MemberStatus.ACTIVE,
        },
        select: { id: true },
      }),
    ]);
    applicantUserId = applicant.id;
    otherUserId = other.id;
    applicantMemberId = applicantMember.id;
    otherMemberId = otherMember.id;
    superUserId = superUser.id;
    await Promise.all([
      prisma.user.update({ where: { id: applicant.id }, data: { memberId: applicantMember.id } }),
      prisma.user.update({ where: { id: other.id }, data: { memberId: otherMember.id } }),
    ]);
    applicantAuth = (await loginAs(app, applicant.username)).authHeader;
    otherAuth = (await loginAs(app, other.username)).authHeader;
    superAuth = (await loginAs(app, superUser.username)).authHeader;

    const baseActivity = {
      activityTypeCode: 'training',
      organizationId: org.id,
      startAt: FAR.start,
      endAt: FAR.end,
      registrationDeadline: FAR.deadline,
      location: 'Canonical Command Field',
      statusCode: 'published',
      isPublicRegistration: true,
      publishedAt: new Date(),
    };
    const [activity, noFormActivity] = await Promise.all([
      prisma.activity.create({
        data: { ...baseActivity, title: 'Canonical Command Activity' },
        select: { id: true },
      }),
      prisma.activity.create({
        data: { ...baseActivity, title: 'No Form Command Activity' },
        select: { id: true },
      }),
    ]);
    activityId = activity.id;
    noFormActivityId = noFormActivity.id;

    const form = await prisma.registrationFormVersion.create({
      data: {
        activityId,
        version: 1,
        statusCode: 'active',
        workflowRevision: 1,
        schemaHash: 'b'.repeat(64),
        activatedAt: new Date(),
        fields: {
          create: [
            {
              fieldCode: 'short',
              typeCode: 'short_text',
              label: '短文本',
              required: true,
              minLength: 2,
              maxLength: 10,
              visibilityCode: 'self_only',
              exportable: false,
              sortOrder: 1,
            },
            {
              fieldCode: 'long',
              typeCode: 'long_text',
              label: '长文本',
              required: false,
              maxLength: 100,
              visibilityCode: 'self_only',
              exportable: false,
              sortOrder: 2,
            },
            {
              fieldCode: 'number',
              typeCode: 'number',
              label: '数字',
              required: false,
              minValue: new Prisma.Decimal('1.5'),
              maxValue: new Prisma.Decimal('3.5'),
              visibilityCode: 'self_only',
              exportable: false,
              sortOrder: 3,
            },
            {
              fieldCode: 'date',
              typeCode: 'date',
              label: '日期',
              required: false,
              visibilityCode: 'self_only',
              exportable: false,
              sortOrder: 4,
            },
            {
              fieldCode: 'single',
              typeCode: 'single_choice',
              label: '单选',
              required: false,
              optionsJson: [{ value: 'yes', label: '是' }],
              visibilityCode: 'self_only',
              exportable: false,
              sortOrder: 5,
            },
            {
              fieldCode: 'multi',
              typeCode: 'multi_choice',
              label: '多选',
              required: false,
              maxSelections: 2,
              optionsJson: [
                { value: 'a', label: '甲' },
                { value: 'b', label: '乙' },
                { value: 'c', label: '丙' },
              ],
              visibilityCode: 'self_only',
              exportable: false,
              sortOrder: 6,
            },
            {
              fieldCode: 'proof',
              typeCode: 'file',
              label: '附件',
              required: true,
              visibilityCode: 'self_only',
              exportable: false,
              sortOrder: 7,
            },
            {
              fieldCode: 'confirm',
              typeCode: 'confirmation',
              label: '确认',
              required: true,
              visibilityCode: 'self_only',
              exportable: false,
              sortOrder: 8,
            },
          ],
        },
      },
      select: { id: true },
    });
    formVersionId = form.id;
    const [sessionA, sessionB] = await Promise.all([
      prisma.activitySession.create({
        data: {
          activityId,
          code: 'command-a',
          name: 'Command Session A',
          startAt: FAR.start,
          endAt: FAR.end,
          locationText: 'A',
          checkInOpenAt: new Date('2099-11-01T07:30:00.000Z'),
          checkInCloseAt: new Date('2099-11-01T09:00:00.000Z'),
          checkOutOpenAt: new Date('2099-11-01T11:00:00.000Z'),
          checkOutCloseAt: FAR.end,
          locationRequired: false,
          locationPolicySourceCode: 'activity',
          statusCode: 'scheduled',
        },
        select: { id: true },
      }),
      prisma.activitySession.create({
        data: {
          activityId,
          code: 'command-b',
          name: 'Command Session B',
          startAt: FAR.start,
          endAt: FAR.end,
          locationText: 'B',
          checkInOpenAt: new Date('2099-11-01T07:30:00.000Z'),
          checkInCloseAt: new Date('2099-11-01T09:00:00.000Z'),
          checkOutOpenAt: new Date('2099-11-01T11:00:00.000Z'),
          checkOutCloseAt: FAR.end,
          locationRequired: false,
          locationPolicySourceCode: 'activity',
          statusCode: 'scheduled',
        },
        select: { id: true },
      }),
    ]);
    sessionAId = sessionA.id;
    sessionBId = sessionB.id;
    const [positionA1, positionA2, positionB1] = await Promise.all([
      prisma.activitySessionPosition.create({
        data: {
          activityId,
          sessionId: sessionAId,
          code: 'a1',
          name: 'A-1',
          attendanceRoleCode: 'volunteer',
        },
        select: { id: true },
      }),
      prisma.activitySessionPosition.create({
        data: {
          activityId,
          sessionId: sessionAId,
          code: 'a2',
          name: 'A-2',
          attendanceRoleCode: 'volunteer',
        },
        select: { id: true },
      }),
      prisma.activitySessionPosition.create({
        data: {
          activityId,
          sessionId: sessionBId,
          code: 'b1',
          name: 'B-1',
          attendanceRoleCode: 'volunteer',
        },
        select: { id: true },
      }),
    ]);
    positionA1Id = positionA1.id;
    positionA2Id = positionA2.id;
    positionB1Id = positionB1.id;
    await prisma.attachmentTypeConfig.create({
      data: {
        code: 'registration-upload-session',
        displayName: '报名会话附件',
        ownerTable: 'registration_upload_sessions',
        defaultMaxSizeBytes: 10 * 1024 * 1024,
        defaultMimeWhitelist: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      },
    });
  });

  afterAll(async () => {
    await app.close();
    if (previousInsuranceGate === undefined) delete process.env.INSURANCE_ENFORCEMENT_ENABLED;
    else process.env.INSURANCE_ENFORCEMENT_ENABLED = previousInsuranceGate;
  });

  async function uploadSession(auth = applicantAuth, routeActivityId = activityId) {
    const created = await request(httpServer(app))
      .post(uploadSessionPath(routeActivityId))
      .set('Authorization', auth);
    expect(created.status).toBe(201);
    const { id, token } = created.body.data as { id: string; token: string };
    const uploaded = await request(httpServer(app))
      .post(`/api/app/v1/activities/${routeActivityId}/registration-upload-sessions/${id}/files`)
      .set('Authorization', auth)
      .field('token', token)
      .attach('file', VALID_PNG_IMAGE, { filename: 'command-proof.png', contentType: 'image/png' });
    expect(uploaded.status).toBe(200);
    return { id, attachmentId: uploaded.body.data.attachmentId as string };
  }

  function validBody(operationKey: string, uploadSessionId: string, preferences?: unknown) {
    return {
      operationKey,
      formVersion: 1,
      answers: [
        { fieldCode: 'short', value: '通过' },
        { fieldCode: 'long', value: '完整长答案' },
        { fieldCode: 'number', value: 2 },
        { fieldCode: 'date', value: '2099-01-01' },
        { fieldCode: 'single', value: 'yes' },
        { fieldCode: 'multi', value: ['b', 'a'] },
        { fieldCode: 'proof', uploadSessionId },
        { fieldCode: 'confirm', value: true },
      ],
      preferences: preferences ?? [
        { sessionId: sessionAId, positionIds: [positionA2Id, positionA1Id] },
        { sessionId: sessionBId, positionIds: [positionB1Id] },
      ],
    };
  }

  async function createNoFormCommandActivity(input: {
    title: string;
    genderRequirementCode?: string | null;
    requiresInsurance?: boolean;
  }): Promise<{ id: string }> {
    return prisma.activity.create({
      data: {
        title: input.title,
        activityTypeCode: 'training',
        organizationId,
        startAt: FAR.start,
        endAt: FAR.end,
        registrationDeadline: FAR.deadline,
        location: 'Canonical Command Gate Field',
        statusCode: 'published',
        isPublicRegistration: true,
        publishedAt: new Date(),
        genderRequirementCode: input.genderRequirementCode ?? null,
        requiresInsurance: input.requiresInsurance ?? false,
      },
      select: { id: true },
    });
  }

  async function createScheduledCommandSession(
    targetActivityId: string,
    code: string,
  ): Promise<{ id: string }> {
    return prisma.activitySession.create({
      data: {
        activityId: targetActivityId,
        code,
        name: `Command ${code}`,
        startAt: FAR.start,
        endAt: FAR.end,
        locationText: 'Gate session',
        checkInOpenAt: new Date('2099-11-01T07:30:00.000Z'),
        checkInCloseAt: new Date('2099-11-01T09:00:00.000Z'),
        checkOutOpenAt: new Date('2099-11-01T11:00:00.000Z'),
        checkOutCloseAt: FAR.end,
        locationRequired: false,
        locationPolicySourceCode: 'activity',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
  }

  async function commandAuditCount(actorUserId: string): Promise<number> {
    return prisma.auditLog.count({
      where: {
        event: 'registration.create',
        resourceType: 'activity_registration',
        actorUserId,
      },
    });
  }

  async function expectNoCanonicalCommandWrites(input: {
    activityId: string;
    memberId: string;
    actorUserId: string;
    auditCountBefore: number;
  }): Promise<void> {
    expect(
      await prisma.activityRegistration.count({
        where: { activityId: input.activityId, memberId: input.memberId },
      }),
    ).toBe(0);
    expect(
      await prisma.activityRegistrationRevision.count({
        where: { registration: { activityId: input.activityId, memberId: input.memberId } },
      }),
    ).toBe(0);
    expect(
      await prisma.registrationFormAnswer.count({
        where: {
          registrationRevision: {
            registration: { activityId: input.activityId, memberId: input.memberId },
          },
        },
      }),
    ).toBe(0);
    expect(
      await prisma.activityPositionPreference.count({
        where: {
          registrationRevision: {
            registration: { activityId: input.activityId, memberId: input.memberId },
          },
        },
      }),
    ).toBe(0);
    expect(
      await prisma.activityParticipationIdentity.count({
        where: { activityId: input.activityId, memberId: input.memberId },
      }),
    ).toBe(0);
    expect(
      await prisma.activityParticipationRevision.count({
        where: { identity: { activityId: input.activityId, memberId: input.memberId } },
      }),
    ).toBe(0);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { activityRegistration: { activityId: input.activityId, memberId: input.memberId } },
      }),
    ).toBe(0);
    expect(
      await prisma.qualificationEvaluationSnapshot.count({
        where: { ruleSetVersion: { activityId: input.activityId } },
      }),
    ).toBe(0);
    expect(await commandAuditCount(input.actorUserId)).toBe(input.auditCountBefore);
  }

  async function canonicalHistoricalHeadWriteChain(input: {
    activityId: string;
    memberId: string;
    actorUserId: string;
  }) {
    const [
      activity,
      headers,
      registrationRevisions,
      answers,
      preferences,
      identities,
      participationRevisions,
      evidence,
      audits,
    ] = await Promise.all([
      prisma.activity.findUniqueOrThrow({
        where: { id: input.activityId },
        select: {
          statusCode: true,
          currentEvidenceRevision: true,
          currentPopulationRevision: true,
          currentClosureRevision: true,
          workflowRevision: true,
        },
      }),
      prisma.activityRegistration.findMany({
        where: { activityId: input.activityId, memberId: input.memberId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          statusCode: true,
          statusSummaryCode: true,
          currentRevision: true,
          currentFormVersionId: true,
          sourceCode: true,
          cancelledAt: true,
          deletedAt: true,
          updatedAt: true,
        },
      }),
      prisma.activityRegistrationRevision.findMany({
        where: { registration: { activityId: input.activityId, memberId: input.memberId } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          registrationId: true,
          revision: true,
          sourceCode: true,
          requestKey: true,
          requestHash: true,
        },
      }),
      prisma.registrationFormAnswer.findMany({
        where: {
          registrationRevision: {
            registration: { activityId: input.activityId, memberId: input.memberId },
          },
        },
        orderBy: { id: 'asc' },
        select: { id: true, registrationRevisionId: true, fieldId: true },
      }),
      prisma.activityPositionPreference.findMany({
        where: {
          registrationRevision: {
            registration: { activityId: input.activityId, memberId: input.memberId },
          },
        },
        orderBy: { id: 'asc' },
        select: { id: true, registrationRevisionId: true, sessionId: true, positionId: true },
      }),
      prisma.activityParticipationIdentity.findMany({
        where: { activityId: input.activityId, memberId: input.memberId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          registrationId: true,
          currentRevision: true,
          currentStatusCode: true,
          currentPositionId: true,
          capacityReservationId: true,
          populationIncluded: true,
          version: true,
          updatedAt: true,
        },
      }),
      prisma.activityParticipationRevision.findMany({
        where: { identity: { activityId: input.activityId, memberId: input.memberId } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          identityId: true,
          revision: true,
          statusCode: true,
          sourceCode: true,
          requestKey: true,
          requestHash: true,
        },
      }),
      prisma.insuranceEligibilityEvidence.findMany({
        where: { activityRegistration: { activityId: input.activityId, memberId: input.memberId } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          activityRegistrationId: true,
          sourceKind: true,
          memberInsuranceId: true,
          teamInsuranceCoverageId: true,
        },
      }),
      prisma.auditLog.count({
        where: {
          event: 'registration.create',
          resourceType: 'activity_registration',
          actorUserId: input.actorUserId,
        },
      }),
    ]);
    return {
      activity,
      headers,
      registrationRevisions,
      answers,
      preferences,
      identities,
      participationRevisions,
      evidence,
      audits,
    };
  }

  it('creates the v1.1 immutable chain, transfers the file, then replays consumed-session retry by hash', async () => {
    const upload = await uploadSession();
    const body = validBody('batch4-command-first-0001', upload.id);
    const first = await request(httpServer(app))
      .post(commandPath())
      .set('Authorization', applicantAuth)
      .send(body);
    expect(first.status).toBe(201);
    expect(receiptKeys(first.body.data)).toEqual([
      'registrationId',
      'registrationRevisionId',
      'revision',
      'submittedAt',
    ]);
    expect(JSON.stringify(first.body.data)).not.toMatch(/answer|attachment|token|key|url|owner/i);
    const receipt = first.body.data as {
      registrationId: string;
      registrationRevisionId: string;
      revision: number;
      submittedAt: string;
    };
    expect(receipt.revision).toBe(1);

    const [header, revision, answers, preferences, identities, audit] = await Promise.all([
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: receipt.registrationId },
        select: {
          memberId: true,
          statusCode: true,
          currentRevision: true,
          currentFormVersionId: true,
          statusSummaryCode: true,
          sourceCode: true,
        },
      }),
      prisma.activityRegistrationRevision.findUniqueOrThrow({
        where: { id: receipt.registrationRevisionId },
        select: {
          registrationId: true,
          revision: true,
          formVersionId: true,
          answersHash: true,
          requestHash: true,
        },
      }),
      prisma.registrationFormAnswer.findMany({
        where: { registrationRevisionId: receipt.registrationRevisionId },
        select: { id: true, field: { select: { fieldCode: true } }, attachmentId: true },
        orderBy: { field: { fieldCode: 'asc' } },
      }),
      prisma.activityPositionPreference.findMany({
        where: { registrationRevisionId: receipt.registrationRevisionId },
        select: { sessionId: true, positionId: true, preferenceOrder: true },
        orderBy: [{ sessionId: 'asc' }, { preferenceOrder: 'asc' }],
      }),
      prisma.activityParticipationIdentity.findMany({
        where: { registrationId: receipt.registrationId },
        select: {
          id: true,
          sessionId: true,
          currentRevision: true,
          currentStatusCode: true,
          populationIncluded: true,
        },
        orderBy: { sessionId: 'asc' },
      }),
      prisma.auditLog.findFirst({
        where: { event: 'registration.create', resourceId: receipt.registrationId },
        select: { context: true },
      }),
    ]);
    expect(header).toEqual({
      memberId: applicantMemberId,
      statusCode: 'pending',
      currentRevision: 1,
      currentFormVersionId: formVersionId,
      statusSummaryCode: 'active',
      sourceCode: 'self',
    });
    expect(revision).toMatchObject({
      registrationId: receipt.registrationId,
      revision: 1,
      formVersionId,
      answersHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(answers).toHaveLength(8);
    const fileAnswer = answers.find((answer) => answer.field.fieldCode === 'proof');
    expect(fileAnswer?.attachmentId).toBe(upload.attachmentId);
    expect(preferences.filter((preference) => preference.sessionId === sessionAId)).toEqual([
      { sessionId: sessionAId, positionId: positionA2Id, preferenceOrder: 1 },
      { sessionId: sessionAId, positionId: positionA1Id, preferenceOrder: 2 },
    ]);
    expect(preferences.filter((preference) => preference.sessionId === sessionBId)).toEqual([
      { sessionId: sessionBId, positionId: positionB1Id, preferenceOrder: 1 },
    ]);
    expect(identities).toHaveLength(2);
    expect(identities.find((identity) => identity.sessionId === sessionAId)).toEqual(
      expect.objectContaining({
        currentRevision: 1,
        currentStatusCode: 'pending',
        populationIncluded: false,
      }),
    );
    expect(identities.find((identity) => identity.sessionId === sessionBId)).toEqual(
      expect.objectContaining({
        currentRevision: 1,
        currentStatusCode: 'pending',
        populationIncluded: false,
      }),
    );
    expect(
      await prisma.activityParticipationRevision.count({
        where: { identityId: { in: identities.map((identity) => identity.id) }, revision: 1 },
      }),
    ).toBe(2);
    expect(
      await prisma.capacityReservation.count({
        where: { identityId: { in: identities.map((identity) => identity.id) } },
      }),
    ).toBe(0);
    expect(
      await prisma.attachment.findUniqueOrThrow({
        where: { id: upload.attachmentId },
        select: { ownerType: true, ownerId: true },
      }),
    ).toEqual({ ownerType: 'registration-form-answer', ownerId: fileAnswer!.id });
    expect(
      await prisma.registrationUploadSession.findUniqueOrThrow({
        where: { id: upload.id },
        select: { statusCode: true, consumedAt: true },
      }),
    ).toEqual({ statusCode: 'consumed', consumedAt: expect.any(Date) });
    expectBizError(
      await request(httpServer(app))
        .get(`/api/admin/v1/attachments/${upload.attachmentId}`)
        .set('Authorization', superAuth),
      BizCode.ATTACHMENT_NOT_FOUND,
    );
    const genericList = await request(httpServer(app))
      .get('/api/admin/v1/attachments')
      .query({ ownerType: 'registration-form-answer' })
      .set('Authorization', superAuth);
    expect(genericList.status).toBe(200);
    expect(genericList.body.data).toMatchObject({ items: [], total: 0 });
    const auditExtra =
      audit?.context && typeof audit.context === 'object' && !Array.isArray(audit.context)
        ? (audit.context as Record<string, unknown>).extra
        : undefined;
    expect(JSON.stringify(auditExtra)).not.toContain('完整长答案');
    expect(auditExtra).toEqual({
      revision: 1,
      source: 'self',
      answerCount: 8,
      preferenceCount: 3,
      requestHash: revision.requestHash,
    });

    const replay = await request(httpServer(app))
      .post(commandPath())
      .set('Authorization', applicantAuth)
      .send(body);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(receipt);
    expect(
      await prisma.activityRegistrationRevision.count({
        where: { registrationId: receipt.registrationId },
      }),
    ).toBe(1);

    const conflict = await request(httpServer(app))
      .post(commandPath())
      .set('Authorization', applicantAuth)
      .send({ ...body, answers: [{ fieldCode: 'short', value: '不同' }] });
    expectBizError(conflict, BizCode.ACTIVITY_REGISTRATION_OPERATION_KEY_CONFLICT);
  });

  it('reuses a cancelled canonical history for a new key and replays the exact old key', async () => {
    const activity = await createNoFormCommandActivity({
      title: 'Canonical Cancelled Historical Header',
    });
    const firstBody = {
      operationKey: 'batch4-command-cancelled-history-first-0001',
      formVersion: null,
      answers: [],
      preferences: [],
    };
    const first = await request(httpServer(app))
      .post(commandPath(activity.id))
      .set('Authorization', applicantAuth)
      .send(firstBody);
    expect(first.status).toBe(201);
    const registrationId = first.body.data.registrationId as string;
    await prisma.activityRegistration.update({
      where: { id: registrationId },
      data: {
        statusCode: 'cancelled',
        statusSummaryCode: 'cancelled',
        cancelledAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
    const before = await canonicalHistoricalHeadWriteChain({
      activityId: activity.id,
      memberId: applicantMemberId,
      actorUserId: applicantUserId,
    });

    const newKey = await request(httpServer(app))
      .post(commandPath(activity.id))
      .set('Authorization', applicantAuth)
      .send({ ...firstBody, operationKey: 'batch4-command-cancelled-history-new-0002' });
    expect(newKey.status).toBe(201);
    expect(newKey.body.data.registrationId).toBe(registrationId);
    const afterNewKey = await canonicalHistoricalHeadWriteChain({
      activityId: activity.id,
      memberId: applicantMemberId,
      actorUserId: applicantUserId,
    });
    expect(afterNewKey.headers).toEqual([
      expect.objectContaining({
        id: registrationId,
        statusCode: 'pending',
        statusSummaryCode: 'active',
        currentRevision: 2,
        cancelledAt: null,
      }),
    ]);
    expect(afterNewKey.registrationRevisions).toHaveLength(before.registrationRevisions.length + 1);
    expect(afterNewKey.audits).toBe(before.audits + 1);

    const replay = await request(httpServer(app))
      .post(commandPath(activity.id))
      .set('Authorization', applicantAuth)
      .send(firstBody);
    expect(replay.status).toBe(201);
    expect(replay.body.data).toEqual(first.body.data);
    await expect(
      canonicalHistoricalHeadWriteChain({
        activityId: activity.id,
        memberId: applicantMemberId,
        actorUserId: applicantUserId,
      }),
    ).resolves.toEqual(afterNewKey);
  });

  it('fails closed with 20147 before any canonical write when an identity pointer drifts', async () => {
    const pointerActivity = await createNoFormCommandActivity({
      title: 'Canonical Pointer Reconciliation',
    });
    const pointerSession = await createScheduledCommandSession(
      pointerActivity.id,
      'pointer-reconciliation',
    );
    const firstBody = {
      operationKey: 'batch4-command-pointer-first-0001',
      formVersion: null,
      answers: [],
      preferences: [{ sessionId: pointerSession.id, positionIds: [] }],
    };
    const first = await request(httpServer(app))
      .post(commandPath(pointerActivity.id))
      .set('Authorization', applicantAuth)
      .send(firstBody);
    expect(first.status).toBe(201);
    const identity = await prisma.activityParticipationIdentity.findFirstOrThrow({
      where: { activityId: pointerActivity.id, memberId: applicantMemberId },
      select: { id: true },
    });
    await prisma.activityParticipationIdentity.update({
      where: { id: identity.id },
      data: { capacityReservationId: 'drifted-session-reservation' },
    });
    const before = await canonicalHistoricalHeadWriteChain({
      activityId: pointerActivity.id,
      memberId: applicantMemberId,
      actorUserId: applicantUserId,
    });

    const response = await request(httpServer(app))
      .post(commandPath(pointerActivity.id))
      .set('Authorization', applicantAuth)
      .send({ ...firstBody, operationKey: 'batch4-command-pointer-drift-new-0002' });
    expectBizError(response, BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
    await expect(
      canonicalHistoricalHeadWriteChain({
        activityId: pointerActivity.id,
        memberId: applicantMemberId,
        actorUserId: applicantUserId,
      }),
    ).resolves.toEqual(before);
  });

  it('keeps all write roots zero on invalid answer/version/upload ownership and appends immutable pending resubmissions', async () => {
    const header = await prisma.activityRegistration.findFirstOrThrow({
      where: { activityId, memberId: applicantMemberId, statusCode: 'pending' },
      select: { id: true, currentRevision: true },
    });
    const beforeInvalid = await prisma.activityRegistrationRevision.count({
      where: { registrationId: header.id },
    });
    const invalidAnswer = await request(httpServer(app))
      .post(commandPath())
      .set('Authorization', applicantAuth)
      .send({
        ...validBody('batch4-command-invalid-answer-0001', 'session-does-not-matter'),
        answers: [{ fieldCode: 'short', value: '' }],
      });
    expectBizError(invalidAnswer, BizCode.REGISTRATION_FORM_ANSWER_INVALID);
    const wrongVersion = await request(httpServer(app))
      .post(commandPath())
      .set('Authorization', applicantAuth)
      .send({
        ...validBody('batch4-command-invalid-version-0001', 'session-does-not-matter'),
        formVersion: 2,
      });
    expectBizError(wrongVersion, BizCode.REGISTRATION_FORM_VERSION_INVALID);
    expect(
      await prisma.activityRegistrationRevision.count({ where: { registrationId: header.id } }),
    ).toBe(beforeInvalid);

    const foreign = await uploadSession(otherAuth);
    const foreignUse = await request(httpServer(app))
      .post(commandPath())
      .set('Authorization', applicantAuth)
      .send(validBody('batch4-command-foreign-upload-0001', foreign.id));
    expectBizError(foreignUse, BizCode.ATTACHMENT_NOT_FOUND);
    expect(
      await prisma.activityRegistrationRevision.count({ where: { registrationId: header.id } }),
    ).toBe(beforeInvalid);
    expect(
      await prisma.registrationUploadSession.findUniqueOrThrow({
        where: { id: foreign.id },
        select: { statusCode: true, consumedAt: true },
      }),
    ).toEqual({ statusCode: 'active', consumedAt: null });

    const resubmitUpload = await uploadSession();
    const resubmit = await request(httpServer(app))
      .post(commandPath())
      .set('Authorization', applicantAuth)
      .send(
        validBody('batch4-command-resubmit-0001', resubmitUpload.id, [
          { sessionId: sessionBId, positionIds: [positionB1Id] },
        ]),
      );
    expect(resubmit.status).toBe(201);
    expect(resubmit.body.data.revision).toBe(2);
    const afterRemove = await prisma.activityParticipationIdentity.findMany({
      where: { registrationId: header.id },
      select: { id: true, sessionId: true, currentRevision: true, currentStatusCode: true },
      orderBy: { sessionId: 'asc' },
    });
    expect(afterRemove.find((identity) => identity.sessionId === sessionAId)).toEqual(
      expect.objectContaining({ currentRevision: 2, currentStatusCode: 'cancelled' }),
    );
    expect(afterRemove.find((identity) => identity.sessionId === sessionBId)).toEqual(
      expect.objectContaining({ currentRevision: 2, currentStatusCode: 'pending' }),
    );

    const reselectUpload = await uploadSession();
    const reselect = await request(httpServer(app))
      .post(commandPath())
      .set('Authorization', applicantAuth)
      .send(
        validBody('batch4-command-reselect-0001', reselectUpload.id, [
          { sessionId: sessionAId, positionIds: [positionA1Id] },
        ]),
      );
    expect(reselect.status).toBe(201);
    expect(reselect.body.data.revision).toBe(3);
    const afterReselect = await prisma.activityParticipationIdentity.findMany({
      where: { registrationId: header.id },
      select: { id: true, sessionId: true, currentRevision: true, currentStatusCode: true },
      orderBy: { sessionId: 'asc' },
    });
    expect(afterReselect.map((identity) => identity.id).sort()).toEqual(
      afterRemove.map((identity) => identity.id).sort(),
    );
    expect(afterReselect.find((identity) => identity.sessionId === sessionAId)).toEqual(
      expect.objectContaining({ currentRevision: 3, currentStatusCode: 'pending' }),
    );
    expect(afterReselect.find((identity) => identity.sessionId === sessionBId)).toEqual(
      expect.objectContaining({ currentRevision: 3, currentStatusCode: 'cancelled' }),
    );

    await prisma.activityRegistration.update({
      where: { id: header.id },
      data: { statusCode: 'pass' },
    });
    const afterPassCount = await prisma.activityRegistrationRevision.count({
      where: { registrationId: header.id },
    });
    const passBlocked = await request(httpServer(app))
      .post(commandPath())
      .set('Authorization', applicantAuth)
      .send(validBody('batch4-command-pass-blocked-0001', (await uploadSession()).id));
    expectBizError(passBlocked, BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID);
    expect(
      await prisma.activityRegistrationRevision.count({ where: { registrationId: header.id } }),
    ).toBe(afterPassCount);
  });

  it('accepts only null/empty answers without an active Form and rejects prohibited body fields', async () => {
    const noForm = await request(httpServer(app))
      .post(commandPath(noFormActivityId))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: 'batch4-command-no-form-0001',
        formVersion: null,
        answers: [],
        preferences: [],
      });
    expect(noForm.status).toBe(201);
    const noFormRevisionCount = await prisma.activityRegistrationRevision.count({
      where: { registrationId: noForm.body.data.registrationId },
    });
    expectBizError(
      await request(httpServer(app))
        .post(commandPath(noFormActivityId))
        .set('Authorization', applicantAuth)
        .send({
          operationKey: 'batch4-command-no-form-bad-0001',
          formVersion: 1,
          answers: [],
          preferences: [],
        }),
      BizCode.REGISTRATION_FORM_VERSION_INVALID,
    );
    expect(
      await prisma.activityRegistrationRevision.count({
        where: { registrationId: noForm.body.data.registrationId },
      }),
    ).toBe(noFormRevisionCount);
    for (const [field, value] of [
      ['activityId', noFormActivityId],
      ['memberId', applicantMemberId],
      ['userId', 'must-not-be-accepted'],
      ['statusCode', 'pending'],
    ]) {
      expectBizError(
        await request(httpServer(app))
          .post(commandPath(noFormActivityId))
          .set('Authorization', applicantAuth)
          .send({
            operationKey: `batch4-command-prohibited-body-${field}-0001`,
            formVersion: null,
            answers: [],
            preferences: [],
            [field]: value,
          }),
        BizCode.BAD_REQUEST,
        { strictMessage: false },
      );
    }
    expectBizError(
      await request(httpServer(app))
        .post(commandPath())
        .set('Authorization', applicantAuth)
        .send({
          operationKey: 'batch4-command-prohibited-file-field-0001',
          formVersion: 1,
          answers: [{ fieldCode: 'proof', attachmentId: 'must-not-be-accepted' }],
          preferences: [],
        }),
      BizCode.BAD_REQUEST,
      { strictMessage: false },
    );
  });

  it('keeps the activity gender hard gate for missing and mismatched MemberProfile before any canonical write', async () => {
    const [missingProfileActivity, mismatchedProfileActivity] = await Promise.all([
      createNoFormCommandActivity({
        title: 'Canonical Command Missing Profile Gate',
        genderRequirementCode: 'female',
      }),
      createNoFormCommandActivity({
        title: 'Canonical Command Mismatched Profile Gate',
        genderRequirementCode: 'female',
      }),
    ]);
    await prisma.memberProfile.create({
      data: {
        memberId: otherMemberId,
        genderCode: 'male',
        birthDate: new Date('1990-01-01T00:00:00.000Z'),
        documentTypeCode: 'id_card',
        documentNumber: 'batch4-command-gender-mismatch',
        mobile: '13800000001',
        privacyConsentSigned: true,
      },
    });
    const [applicantAuditBefore, otherAuditBefore] = await Promise.all([
      commandAuditCount(applicantUserId),
      commandAuditCount(otherUserId),
    ]);
    const [missingProfile, mismatch] = await Promise.all([
      request(httpServer(app))
        .post(commandPath(missingProfileActivity.id))
        .set('Authorization', applicantAuth)
        .send({
          operationKey: 'batch4-command-gender-missing-profile-0001',
          formVersion: null,
          answers: [],
          preferences: [],
        }),
      request(httpServer(app))
        .post(commandPath(mismatchedProfileActivity.id))
        .set('Authorization', otherAuth)
        .send({
          operationKey: 'batch4-command-gender-mismatch-0001',
          formVersion: null,
          answers: [],
          preferences: [],
        }),
    ]);
    expect([missingProfile.status, mismatch.status]).toEqual([409, 409]);
    expect([missingProfile.body.code, mismatch.body.code]).toEqual([
      BizCode.ACTIVITY_REGISTRATION_GENDER_MISMATCH.code,
      BizCode.ACTIVITY_REGISTRATION_GENDER_MISMATCH.code,
    ]);
    await Promise.all([
      expectNoCanonicalCommandWrites({
        activityId: missingProfileActivity.id,
        memberId: applicantMemberId,
        actorUserId: applicantUserId,
        auditCountBefore: applicantAuditBefore,
      }),
      expectNoCanonicalCommandWrites({
        activityId: mismatchedProfileActivity.id,
        memberId: otherMemberId,
        actorUserId: otherUserId,
        auditCountBefore: otherAuditBefore,
      }),
    ]);
  });

  it('rechecks insurance through the canonical command and creates exactly one first-registration evidence', async () => {
    const insuredActivity = await createNoFormCommandActivity({
      title: 'Canonical Command Insurance Gate',
      requiresInsurance: true,
    });
    const auditBeforeMissingInsurance = await commandAuditCount(applicantUserId);
    const missingInsurance = await request(httpServer(app))
      .post(commandPath(insuredActivity.id))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: 'batch4-command-insurance-missing-0001',
        formVersion: null,
        answers: [],
        preferences: [],
      });
    expectBizError(missingInsurance, BizCode.INSURANCE_REQUIRED);
    await expectNoCanonicalCommandWrites({
      activityId: insuredActivity.id,
      memberId: applicantMemberId,
      actorUserId: applicantUserId,
      auditCountBefore: auditBeforeMissingInsurance,
    });

    const insurance = await prisma.memberInsurance.create({
      data: {
        memberId: applicantMemberId,
        insurerName: 'Canonical Command Insurance',
        policyNumber: 'B4-COMMAND-INSURANCE-0001',
        coverageStart: new Date('2099-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2099-12-31T00:00:00.000Z'),
        reviewStatusCode: 'verified',
        reviewedByUserId: superUserId,
        reviewedAt: new Date('2099-01-01T00:00:00.000Z'),
      },
      select: { id: true },
    });
    const first = await request(httpServer(app))
      .post(commandPath(insuredActivity.id))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: 'batch4-command-insurance-first-0001',
        formVersion: null,
        answers: [],
        preferences: [],
      });
    expect(first.status).toBe(201);
    const registrationId = first.body.data.registrationId as string;
    const evidence = await prisma.insuranceEligibilityEvidence.findMany({
      where: { activityRegistrationId: registrationId },
      select: {
        ownerKind: true,
        activityRegistrationId: true,
        activityRegistrationRevisionId: true,
        teamJoinApplicationId: true,
        sourceKind: true,
        memberInsuranceId: true,
        teamInsuranceCoverageId: true,
      },
    });
    expect(evidence).toEqual([
      {
        ownerKind: 'activity_registration',
        activityRegistrationId: registrationId,
        activityRegistrationRevisionId: first.body.data.registrationRevisionId,
        teamJoinApplicationId: null,
        sourceKind: 'member_insurance',
        memberInsuranceId: insurance.id,
        teamInsuranceCoverageId: null,
      },
    ]);

    const resubmission = await request(httpServer(app))
      .post(commandPath(insuredActivity.id))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: 'batch4-command-insurance-resubmit-0001',
        formVersion: null,
        answers: [],
        preferences: [],
      });
    expect(resubmission.status).toBe(201);
    expect(resubmission.body.data).toMatchObject({ registrationId, revision: 2 });
    expect(
      await prisma.insuranceEligibilityEvidence.findMany({
        where: { activityRegistrationId: registrationId },
        orderBy: { createdAt: 'asc' },
        select: { activityRegistrationRevisionId: true },
      }),
    ).toEqual([
      { activityRegistrationRevisionId: first.body.data.registrationRevisionId },
      { activityRegistrationRevisionId: resubmission.body.data.registrationRevisionId },
    ]);

    await prisma.memberInsurance.update({
      where: { id: insurance.id },
      data: { deletedAt: new Date() },
    });
    const auditBeforeIneligibleResubmission = await commandAuditCount(applicantUserId);
    const ineligibleResubmission = await request(httpServer(app))
      .post(commandPath(insuredActivity.id))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: 'batch4-command-insurance-ineligible-resubmit-0001',
        formVersion: null,
        answers: [],
        preferences: [],
      });
    expectBizError(ineligibleResubmission, BizCode.INSURANCE_REQUIRED);
    expect(
      await prisma.activityRegistration.findUniqueOrThrow({
        where: { id: registrationId },
        select: { currentRevision: true },
      }),
    ).toEqual({ currentRevision: 2 });
    expect(await prisma.activityRegistrationRevision.count({ where: { registrationId } })).toBe(2);
    expect(
      await prisma.insuranceEligibilityEvidence.count({
        where: { activityRegistrationId: registrationId },
      }),
    ).toBe(2);
    expect(await commandAuditCount(applicantUserId)).toBe(auditBeforeIneligibleResubmission);
  });

  it('requires preferences when the activity has any live position before any canonical write', async () => {
    const positionActivity = await createNoFormCommandActivity({
      title: 'Canonical Command Preferences Required',
    });
    const positionSession = await createScheduledCommandSession(
      positionActivity.id,
      'preferences-required',
    );
    await prisma.activitySessionPosition.create({
      data: {
        activityId: positionActivity.id,
        sessionId: positionSession.id,
        code: 'preferences-required',
        name: 'Preferences Required',
        attendanceRoleCode: 'volunteer',
      },
    });
    const auditBeforeMissingPreferences = await commandAuditCount(applicantUserId);

    const missingPreferences = await request(httpServer(app))
      .post(commandPath(positionActivity.id))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: 'batch4-command-preferences-missing-0001',
        formVersion: null,
        answers: [],
        preferences: [],
      });

    expectBizError(missingPreferences, BizCode.ACTIVITY_POSITION_REQUIRED);
    await expectNoCanonicalCommandWrites({
      activityId: positionActivity.id,
      memberId: applicantMemberId,
      actorUserId: applicantUserId,
      auditCountBefore: auditBeforeMissingPreferences,
    });
  });

  it('requires one or more positions when a selected scheduled session has live positions', async () => {
    const positionActivity = await createNoFormCommandActivity({
      title: 'Canonical Command Position Required',
    });
    const positionSession = await createScheduledCommandSession(
      positionActivity.id,
      'position-required',
    );
    const position = await prisma.activitySessionPosition.create({
      data: {
        activityId: positionActivity.id,
        sessionId: positionSession.id,
        code: 'position-required',
        name: 'Position Required',
        attendanceRoleCode: 'volunteer',
      },
      select: { id: true },
    });
    const auditBeforeMissingPosition = await commandAuditCount(applicantUserId);
    const missingPosition = await request(httpServer(app))
      .post(commandPath(positionActivity.id))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: 'batch4-command-position-missing-0001',
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: positionSession.id, positionIds: [] }],
      });
    expectBizError(missingPosition, BizCode.ACTIVITY_POSITION_REQUIRED);
    await expectNoCanonicalCommandWrites({
      activityId: positionActivity.id,
      memberId: applicantMemberId,
      actorUserId: applicantUserId,
      auditCountBefore: auditBeforeMissingPosition,
    });

    const validPosition = await request(httpServer(app))
      .post(commandPath(positionActivity.id))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: 'batch4-command-position-valid-0001',
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: positionSession.id, positionIds: [position.id] }],
      });
    expect(validPosition.status).toBe(201);
    expect(
      await prisma.activityPositionPreference.findMany({
        where: { registrationRevisionId: validPosition.body.data.registrationRevisionId },
        select: { sessionId: true, positionId: true, preferenceOrder: true },
      }),
    ).toEqual([
      {
        sessionId: positionSession.id,
        positionId: position.id,
        preferenceOrder: 1,
      },
    ]);
  });

  it('fails closed on old App/Admin create paths once a live v1.1 session or Form exists, while a legacy activity remains unchanged', async () => {
    expectBizError(
      await request(httpServer(app))
        .post('/api/app/v1/my/registrations')
        .set('Authorization', applicantAuth)
        .send({ activityId }),
      BizCode.ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED,
    );
    expectBizError(
      await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/registrations`)
        .set('Authorization', superAuth)
        .send({ memberId: applicantMemberId }),
      BizCode.ACTIVITY_REGISTRATION_V11_FLOW_REQUIRED,
    );

    const legacy = await prisma.activity.create({
      data: {
        title: 'Legacy Registration Still Works',
        activityTypeCode: 'training',
        organizationId: (
          await prisma.activity.findUniqueOrThrow({
            where: { id: activityId },
            select: { organizationId: true },
          })
        ).organizationId,
        startAt: FAR.start,
        endAt: FAR.end,
        registrationDeadline: FAR.deadline,
        location: 'Legacy Field',
        statusCode: 'published',
        isPublicRegistration: true,
        publishedAt: new Date(),
      },
      select: { id: true },
    });
    const legacyCreate = await request(httpServer(app))
      .post('/api/app/v1/my/registrations')
      .set('Authorization', applicantAuth)
      .send({ activityId: legacy.id });
    expect(legacyCreate.status).toBe(201);
  });

  it('rejects a canonical submit before any write when an active block qualification RuleSet is not met', async () => {
    const activity = await createNoFormCommandActivity({
      title: 'Qualification Block Command Activity',
    });
    const ruleSet = await prisma.activityQualificationRuleSet.create({
      data: {
        activityId: activity.id,
        version: 1,
        statusCode: 'draft',
        rules: {
          create: {
            ruleTypeCode: 'grade',
            enforcementCode: 'block',
            operator: 'in',
            valueJson: { codes: ['L2'] },
            sortOrder: 1,
          },
        },
      },
      select: { id: true },
    });
    await prisma.activityQualificationRuleSet.update({
      where: { id: ruleSet.id },
      data: { statusCode: 'active' },
    });
    const auditCountBefore = await commandAuditCount(applicantUserId);

    const response = await request(httpServer(app))
      .post(commandPath(activity.id))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: 'batch4-command-qualification-block-0001',
        formVersion: null,
        answers: [],
        preferences: [],
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe(21040);
    expect(response.body.data).toBeNull();
    await expectNoCanonicalCommandWrites({
      activityId: activity.id,
      memberId: applicantMemberId,
      actorUserId: applicantUserId,
      auditCountBefore,
    });
  });

  it('persists a warn snapshot and continues a canonical submit when a warn qualification RuleSet is not met', async () => {
    const activity = await createNoFormCommandActivity({
      title: 'Qualification Warn Command Activity',
    });
    const ruleSet = await prisma.activityQualificationRuleSet.create({
      data: {
        activityId: activity.id,
        version: 1,
        statusCode: 'draft',
        rules: {
          create: {
            ruleTypeCode: 'grade',
            enforcementCode: 'warn',
            operator: 'in',
            valueJson: { codes: ['L2'] },
            warnScore: 70,
            sortOrder: 1,
          },
        },
      },
      select: { id: true },
    });
    await prisma.activityQualificationRuleSet.update({
      where: { id: ruleSet.id },
      data: { statusCode: 'active' },
    });

    const response = await request(httpServer(app))
      .post(commandPath(activity.id))
      .set('Authorization', applicantAuth)
      .send({
        operationKey: 'batch4-command-qualification-warn-0001',
        formVersion: null,
        answers: [],
        preferences: [],
      });

    expect(response.status).toBe(201);
    const snapshot = await prisma.qualificationEvaluationSnapshot.findFirstOrThrow({
      where: {
        ruleSetVersionId: ruleSet.id,
        registrationRevisionId: response.body.data.registrationRevisionId,
      },
      select: {
        identityId: true,
        evaluationPhaseCode: true,
        resultCode: true,
        detailsJson: true,
        inputFactsHash: true,
      },
    });
    expect(snapshot).toEqual(
      expect.objectContaining({
        identityId: null,
        evaluationPhaseCode: 'submit',
        resultCode: 'warn',
        inputFactsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(JSON.stringify(snapshot.detailsJson)).not.toMatch(
      /grade|gender|birth|organization|certificate|insurance|valueJson/i,
    );
  });
});
