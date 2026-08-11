import type { INestApplication } from '@nestjs/common';
import {
  BindingScopeType,
  BindingStatus,
  MemberStatus,
  MembershipStatus,
  Prisma,
  PrincipalType,
  Role,
} from '@prisma/client';
import request from 'supertest';

import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { seedCertificateStandard } from '../fixtures/certificate-standard.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

const PERIOD = {
  startAt: new Date('2199-11-01T08:00:00.000Z'),
  endAt: new Date('2199-11-02T12:00:00.000Z'),
  deadline: new Date('2199-10-31T23:59:59.000Z'),
};

type QualificationPayload = {
  resultCode: 'pass' | 'warn' | 'fail';
  unmetRules: Array<{
    ruleId: string;
    enforcementCode: 'block' | 'warn';
    resultCode: 'warn' | 'fail';
    message: string | null;
    warnScore: number | null;
  }>;
};

type QualifiedFixture = {
  memberId: string;
  auth: string;
  activityId: string;
  sessionId: string;
  positionId: string;
  activityRuleSetId: string;
  sessionRuleSetId: string;
  positionRuleSetId: string;
  certificateAId: string;
  certificateBId: string;
  insuranceId: string;
  membershipId: string;
};

describe('activity batch4 qualification runtime', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sequence = 0;
  let rootOrganizationId: string;
  let childOrganizationId: string;
  let activityTypeCode: string;
  let reviewerAuth: string;
  let reviewerUserId: string;
  let manager: { memberId: string; userId: string; auth: string };
  let activityOwnerRoleId: string;

  const next = (prefix: string) => `${prefix}-${++sequence}`;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    activityOwnerRoleId = (await seedActivityResponsibilitySystemRoles(app))['activity-owner'];

    const root = await prisma.organization.create({
      data: { name: 'Qualification Runtime Root', nodeTypeCode: 'qualification-runtime-root' },
      select: { id: true },
    });
    const child = await prisma.organization.create({
      data: {
        name: 'Qualification Runtime Child',
        nodeTypeCode: 'qualification-runtime-child',
        parentId: root.id,
      },
      select: { id: true },
    });
    rootOrganizationId = root.id;
    childOrganizationId = child.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: child.id, depth: 1 },
        { ancestorId: child.id, descendantId: child.id, depth: 0 },
      ],
    });
    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    activityTypeCode = 'qualification-runtime-training';
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '资格运行时训练' },
    });

    const reviewer = await createTestUser(app, {
      username: 'qualification-reviewer',
      role: Role.SUPER_ADMIN,
    });
    reviewerUserId = reviewer.id;
    reviewerAuth = (await loginAs(app, reviewer.username)).authHeader;
    const managerUser = await createLinkedMember('qualification-manager', 'L1');
    manager = { ...managerUser, userId: managerUser.userId };
  });

  afterAll(async () => {
    await app.close();
  });

  async function createLinkedMember(
    label: string,
    gradeCode: string,
  ): Promise<{ memberId: string; userId: string; auth: string }> {
    const suffix = next(label);
    const user = await createTestUser(app, { username: suffix, role: Role.USER });
    const member = await prisma.member.create({
      data: {
        memberNo: `QUAL-${suffix}`,
        displayName: `Qualification ${suffix}`,
        gradeCode,
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    await prisma.memberOrganizationMembership.create({
      data: { memberId: member.id, organizationId: childOrganizationId },
    });
    return {
      memberId: member.id,
      userId: user.id,
      auth: (await loginAs(app, user.username)).authHeader,
    };
  }

  async function createProfile(memberId: string): Promise<void> {
    await prisma.memberProfile.create({
      data: {
        memberId,
        realName: '资格运行时队员',
        genderCode: 'female',
        // 活动北京时间 2199-11-01 当日恰满 18 周岁。
        birthDate: new Date('2181-11-01T00:00:00.000Z'),
        documentTypeCode: 'id_card',
        documentNumber: `qualification-doc-${next('profile')}`,
        mobile: `138${String(sequence).padStart(8, '0')}`,
        joinedDate: new Date('2020-01-01T00:00:00.000Z'),
        joinSourceCode: 'qualification-runtime',
        privacyConsentSigned: true,
      },
    });
  }

  async function createQualifiedActivity(): Promise<QualifiedFixture> {
    const applicant = await createLinkedMember('qualification-applicant', 'L1');
    const [standardA, standardB] = await Promise.all([
      seedCertificateStandard(prisma, { code: next('qualification-standard-a') }),
      seedCertificateStandard(prisma, { code: next('qualification-standard-b') }),
    ]);
    await createProfile(applicant.memberId);
    const [certificateA, certificateB, insurance] = await Promise.all([
      prisma.certificate.create({
        data: {
          memberId: applicant.memberId,
          ...standardA.certificateColumns,
          issuingOrg: '资格运行时发证机构 A',
          certNumber: 'QUAL-CERT-A',
          issuedAt: new Date('2199-01-01T00:00:00.000Z'),
          expiredAt: new Date('2199-11-02T00:00:00.000Z'),
          certStatusCode: 'verified',
        },
        select: { id: true },
      }),
      prisma.certificate.create({
        data: {
          memberId: applicant.memberId,
          ...standardB.certificateColumns,
          issuingOrg: '资格运行时发证机构 B',
          certNumber: 'QUAL-CERT-B',
          issuedAt: new Date('2199-01-01T00:00:00.000Z'),
          expiredAt: new Date('2199-11-02T00:00:00.000Z'),
          certStatusCode: 'verified',
        },
        select: { id: true },
      }),
      prisma.memberInsurance.create({
        data: {
          memberId: applicant.memberId,
          insurerName: 'Qualification Insurance',
          policyNumber: 'QUAL-POLICY-SECRET',
          coverageStart: new Date('2199-01-01T00:00:00.000Z'),
          coverageEnd: new Date('2199-12-31T00:00:00.000Z'),
          reviewStatusCode: 'verified',
          reviewedByUserId: reviewerUserId,
          reviewedAt: new Date('2199-01-01T00:00:00.000Z'),
        },
        select: { id: true },
      }),
    ]);
    const activity = await prisma.activity.create({
      data: {
        title: next('Qualification Runtime Activity'),
        activityTypeCode,
        organizationId: childOrganizationId,
        startAt: PERIOD.startAt,
        endAt: PERIOD.endAt,
        registrationDeadline: PERIOD.deadline,
        location: 'Qualification Runtime Field',
        statusCode: 'published',
        publishedAt: new Date(),
        isPublicRegistration: true,
      },
      select: { id: true },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: next('qualification-session'),
        name: 'Qualification Session',
        startAt: PERIOD.startAt,
        endAt: PERIOD.endAt,
        locationText: 'Qualification Runtime Field',
        checkInOpenAt: new Date('2199-11-01T07:00:00.000Z'),
        checkInCloseAt: new Date('2199-11-01T10:00:00.000Z'),
        checkOutOpenAt: new Date('2199-11-02T09:00:00.000Z'),
        checkOutCloseAt: new Date('2199-11-02T13:00:00.000Z'),
        locationRequired: false,
        locationPolicySourceCode: 'activity',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    const position = await prisma.activitySessionPosition.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        code: next('qualification-position'),
        name: 'Qualification Position',
        attendanceRoleCode: 'volunteer',
      },
      select: { id: true },
    });
    const [activityRuleSet, sessionRuleSet, positionRuleSet] = await Promise.all([
      prisma.activityQualificationRuleSet.create({
        data: {
          activityId: activity.id,
          version: 1,
          statusCode: 'draft',
          rules: {
            create: [
              {
                ruleTypeCode: 'grade',
                enforcementCode: 'block',
                operator: 'in',
                valueJson: { codes: ['L1', 'L3'] },
                sortOrder: 1,
              },
              {
                ruleTypeCode: 'gender',
                enforcementCode: 'block',
                operator: 'in',
                valueJson: { codes: ['female'] },
                sortOrder: 2,
              },
              {
                ruleTypeCode: 'organization',
                enforcementCode: 'block',
                operator: 'in_subtree',
                valueJson: { organizationIds: [rootOrganizationId] },
                sortOrder: 3,
              },
              {
                ruleTypeCode: 'certificate',
                enforcementCode: 'block',
                operator: 'has_any',
                valueJson: { standardIds: [standardA.standardId] },
                sortOrder: 4,
              },
              {
                ruleTypeCode: 'training',
                enforcementCode: 'block',
                operator: 'has_any',
                valueJson: { standardIds: [standardB.standardId] },
                sortOrder: 5,
              },
              {
                ruleTypeCode: 'age',
                enforcementCode: 'block',
                operator: 'between',
                valueJson: { minYears: 18, maxYears: 18 },
                sortOrder: 6,
              },
              {
                ruleTypeCode: 'insurance',
                enforcementCode: 'block',
                operator: 'covers_activity',
                valueJson: Prisma.DbNull,
                sortOrder: 7,
              },
            ],
          },
        },
        select: { id: true },
      }),
      prisma.activityQualificationRuleSet.create({
        data: {
          activityId: activity.id,
          sessionId: session.id,
          version: 1,
          statusCode: 'draft',
          rules: {
            create: {
              ruleTypeCode: 'gender',
              enforcementCode: 'warn',
              operator: 'in',
              valueJson: { codes: ['male'] },
              warnScore: 7,
              message: '性别提示',
              sortOrder: 1,
            },
          },
        },
        select: { id: true },
      }),
      prisma.activityQualificationRuleSet.create({
        data: {
          activityId: activity.id,
          sessionId: session.id,
          positionId: position.id,
          version: 1,
          statusCode: 'draft',
          rules: {
            create: {
              ruleTypeCode: 'certificate',
              enforcementCode: 'block',
              operator: 'has_any',
              valueJson: { standardIds: [standardA.standardId] },
              sortOrder: 1,
            },
          },
        },
        select: { id: true },
      }),
    ]);
    await prisma.activitySessionPosition.update({
      where: { id: position.id },
      data: { qualificationRuleSetId: positionRuleSet.id },
    });
    await prisma.activityQualificationRuleSet.updateMany({
      where: { id: { in: [activityRuleSet.id, sessionRuleSet.id, positionRuleSet.id] } },
      data: { statusCode: 'active' },
    });
    const membership = await prisma.memberOrganizationMembership.findFirstOrThrow({
      where: { memberId: applicant.memberId, organizationId: childOrganizationId, deletedAt: null },
      select: { id: true },
    });
    return {
      memberId: applicant.memberId,
      auth: applicant.auth,
      activityId: activity.id,
      sessionId: session.id,
      positionId: position.id,
      activityRuleSetId: activityRuleSet.id,
      sessionRuleSetId: sessionRuleSet.id,
      positionRuleSetId: positionRuleSet.id,
      certificateAId: certificateA.id,
      certificateBId: certificateB.id,
      insuranceId: insurance.id,
      membershipId: membership.id,
    };
  }

  function readQualification(response: request.Response): QualificationPayload {
    return response.body.data.qualification as QualificationPayload;
  }

  async function detail(activityId: string, auth: string): Promise<request.Response> {
    return request(httpServer(app))
      .get(`/api/app/v1/activities/${activityId}`)
      .set('Authorization', auth);
  }

  it('AC-018 qualification runtime evaluates all seven D83 rule types across display, submit, onsite, and review', async () => {
    const fixture = await createQualifiedActivity();

    const displayFirst = await detail(fixture.activityId, fixture.auth);
    expect(displayFirst.status).toBe(200);
    expect(readQualification(displayFirst)).toEqual({ resultCode: 'pass', unmetRules: [] });
    expect(displayFirst.body.data.sessions[0].qualification).toMatchObject({ resultCode: 'warn' });
    expect(displayFirst.body.data.sessions[0].positions[0].qualification).toMatchObject({
      resultCode: 'warn',
    });
    const displaySecond = await detail(fixture.activityId, fixture.auth);
    expect(displaySecond.status).toBe(200);
    const firstDisplayHashes = await prisma.qualificationEvaluationSnapshot.findMany({
      where: { ruleSetVersion: { activityId: fixture.activityId }, evaluationPhaseCode: 'display' },
      select: { ruleSetVersionId: true, inputFactsHash: true },
      orderBy: [{ ruleSetVersionId: 'asc' }, { createdAt: 'asc' }],
    });
    expect(firstDisplayHashes).toHaveLength(6);
    for (const ruleSetId of [
      fixture.activityRuleSetId,
      fixture.sessionRuleSetId,
      fixture.positionRuleSetId,
    ]) {
      const hashes = firstDisplayHashes
        .filter((snapshot) => snapshot.ruleSetVersionId === ruleSetId)
        .map((snapshot) => snapshot.inputFactsHash);
      expect(hashes).toHaveLength(2);
      expect(hashes[0]).toBe(hashes[1]);
    }

    const submit = await request(httpServer(app))
      .post(`/api/app/v1/activities/${fixture.activityId}/registrations`)
      .set('Authorization', fixture.auth)
      .send({
        operationKey: 'qualification-runtime-submit-0001',
        formVersion: null,
        answers: [],
        preferences: [{ sessionId: fixture.sessionId, positionIds: [fixture.positionId] }],
      });
    expect(submit.status).toBe(201);
    const submitSnapshots = await prisma.qualificationEvaluationSnapshot.findMany({
      where: {
        registrationRevisionId: submit.body.data.registrationRevisionId,
        evaluationPhaseCode: 'submit',
      },
      select: { ruleSetVersionId: true, identityId: true, resultCode: true },
      orderBy: { ruleSetVersionId: 'asc' },
    });
    expect(submitSnapshots).toHaveLength(3);
    expect(submitSnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleSetVersionId: fixture.activityRuleSetId,
          identityId: null,
          resultCode: 'pass',
        }),
        expect.objectContaining({
          ruleSetVersionId: fixture.positionRuleSetId,
          identityId: expect.any(String),
          resultCode: 'pass',
        }),
        expect.objectContaining({
          ruleSetVersionId: fixture.sessionRuleSetId,
          identityId: expect.any(String),
          resultCode: 'warn',
        }),
      ]),
    );

    const beforeReview = await Promise.all([
      prisma.activityRegistration.findUniqueOrThrow({
        where: { id: submit.body.data.registrationId },
        select: { statusCode: true, reviewedAt: true },
      }),
      prisma.qualificationEvaluationSnapshot.count({
        where: {
          ruleSetVersion: { activityId: fixture.activityId },
          evaluationPhaseCode: 'review',
        },
      }),
      prisma.auditLog.count({ where: { resourceId: submit.body.data.registrationId } }),
      prisma.notificationOutboxIntent.count({
        where: { aggregateId: submit.body.data.registrationId },
      }),
    ]);
    await prisma.member.update({ where: { id: fixture.memberId }, data: { gradeCode: 'L2' } });
    const blockedReview = await request(httpServer(app))
      .patch(
        `/api/admin/v1/activities/${fixture.activityId}/registrations/${submit.body.data.registrationId}/approve`,
      )
      .set('Authorization', reviewerAuth)
      .send({ reviewNote: '资格事实已变化' });
    expect(blockedReview.status).toBe(409);
    expect(blockedReview.body.code).toBe(BizCode.ACTIVITY_QUALIFICATION_NOT_MET.code);
    await expect(
      Promise.all([
        prisma.activityRegistration.findUniqueOrThrow({
          where: { id: submit.body.data.registrationId },
          select: { statusCode: true, reviewedAt: true },
        }),
        prisma.qualificationEvaluationSnapshot.count({
          where: {
            ruleSetVersion: { activityId: fixture.activityId },
            evaluationPhaseCode: 'review',
          },
        }),
        prisma.auditLog.count({ where: { resourceId: submit.body.data.registrationId } }),
        prisma.notificationOutboxIntent.count({
          where: { aggregateId: submit.body.data.registrationId },
        }),
      ]),
    ).resolves.toEqual(beforeReview);

    const onsiteActivity = await prisma.activity.create({
      data: {
        title: next('Qualification Onsite Activity'),
        activityTypeCode,
        organizationId: childOrganizationId,
        startAt: PERIOD.startAt,
        endAt: PERIOD.endAt,
        location: 'Qualification Onsite Field',
        capacity: 3,
        statusCode: 'published',
        publishedAt: new Date(),
      },
      select: { id: true },
    });
    const onsiteSession = await prisma.activitySession.create({
      data: {
        activityId: onsiteActivity.id,
        code: next('qualification-onsite-session'),
        name: 'Qualification Onsite Session',
        startAt: PERIOD.startAt,
        endAt: PERIOD.endAt,
        locationText: 'Qualification Onsite Field',
        capacity: 3,
        checkInOpenAt: new Date('2199-11-01T07:00:00.000Z'),
        checkInCloseAt: new Date('2199-11-01T10:00:00.000Z'),
        checkOutOpenAt: new Date('2199-11-02T09:00:00.000Z'),
        checkOutCloseAt: new Date('2199-11-02T13:00:00.000Z'),
        locationRequired: false,
        locationPolicySourceCode: 'activity',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });
    await prisma.activityCapacityBucket.createMany({
      data: [
        {
          activityId: onsiteActivity.id,
          scopeTypeCode: 'activity_person',
          scopeId: onsiteActivity.id,
          capacity: 3,
        },
        {
          activityId: onsiteActivity.id,
          scopeTypeCode: 'session_participation',
          scopeId: onsiteSession.id,
          capacity: 3,
        },
      ],
    });
    await prisma.activityEvidenceState.create({ data: { activityId: onsiteActivity.id } });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: onsiteActivity.id,
        memberId: manager.memberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: manager.userId,
        source: 'publish',
      },
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.MEMBER,
        principalId: manager.memberId,
        roleId: activityOwnerRoleId,
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: onsiteActivity.id,
        status: BindingStatus.ACTIVE,
        note: 'qualification onsite fixture',
      },
    });
    const onsiteRuleSet = await prisma.activityQualificationRuleSet.create({
      data: {
        activityId: onsiteActivity.id,
        version: 1,
        statusCode: 'draft',
        rules: {
          create: {
            ruleTypeCode: 'grade',
            enforcementCode: 'warn',
            operator: 'in',
            valueJson: { codes: ['L2'] },
            warnScore: 9,
            sortOrder: 1,
          },
        },
      },
      select: { id: true },
    });
    await prisma.activityQualificationRuleSet.update({
      where: { id: onsiteRuleSet.id },
      data: { statusCode: 'active' },
    });
    const onsiteTarget = await prisma.member.create({
      data: {
        memberNo: next('qualification-onsite-target'),
        displayName: 'Qualification Onsite Target',
        gradeCode: 'L1',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    const onsite = await request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${onsiteActivity.id}/onsite-participations`)
      .set('Authorization', manager.auth)
      .send({
        memberId: onsiteTarget.id,
        sessionId: onsiteSession.id,
        operationKey: 'qualification-runtime-onsite-0001',
      });
    expect(onsite.status).toBe(201);
    await expect(
      prisma.qualificationEvaluationSnapshot.findMany({
        where: {
          ruleSetVersionId: onsiteRuleSet.id,
          registrationRevisionId: onsite.body.data.registrationRevisionId,
        },
        select: { identityId: true, evaluationPhaseCode: true, resultCode: true },
      }),
    ).resolves.toEqual([{ identityId: null, evaluationPhaseCode: 'submit', resultCode: 'warn' }]);
  });

  it('does not leak qualification facts into immutable snapshots and keeps their count and hashes unchanged for failed displays', async () => {
    const fixture = await createQualifiedActivity();
    const first = await detail(fixture.activityId, fixture.auth);
    expect(first.status).toBe(200);
    const initialSnapshots = await prisma.qualificationEvaluationSnapshot.findMany({
      where: { ruleSetVersion: { activityId: fixture.activityId }, evaluationPhaseCode: 'display' },
      select: { detailsJson: true, inputFactsHash: true, ruleSetVersionId: true },
      orderBy: { ruleSetVersionId: 'asc' },
    });
    expect(initialSnapshots).toHaveLength(3);
    for (const snapshot of initialSnapshots) {
      const details = JSON.stringify(snapshot.detailsJson);
      expect(details).not.toMatch(
        /L1|female|2181|QUAL-POLICY-SECRET|qualification-standard|valueJson|birthDate|organizationIds/i,
      );
    }
    const snapshotFactsBeforeFailedDisplays = initialSnapshots.map((snapshot) => ({
      ruleSetVersionId: snapshot.ruleSetVersionId,
      inputFactsHash: snapshot.inputFactsHash,
    }));

    await prisma.memberProfile.update({
      where: { memberId: fixture.memberId },
      data: { deletedAt: new Date() },
    });
    const withoutProfile = await detail(fixture.activityId, fixture.auth);
    expect(readQualification(withoutProfile)).toMatchObject({ resultCode: 'fail' });
    expect(readQualification(withoutProfile).unmetRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resultCode: 'fail' }),
        expect.objectContaining({ resultCode: 'fail' }),
      ]),
    );
    await expect(
      prisma.qualificationEvaluationSnapshot.findMany({
        where: {
          ruleSetVersion: { activityId: fixture.activityId },
          evaluationPhaseCode: 'display',
        },
        select: { ruleSetVersionId: true, inputFactsHash: true },
        orderBy: { ruleSetVersionId: 'asc' },
      }),
    ).resolves.toEqual(snapshotFactsBeforeFailedDisplays);
    await prisma.memberProfile.update({
      where: { memberId: fixture.memberId },
      data: { deletedAt: null },
    });

    await prisma.certificate.update({
      where: { id: fixture.certificateBId },
      data: { expiredAt: new Date('2199-11-01T00:00:00.000Z') },
    });
    const incompleteCertificate = await detail(fixture.activityId, fixture.auth);
    expect(readQualification(incompleteCertificate)).toMatchObject({ resultCode: 'fail' });
    await expect(
      prisma.qualificationEvaluationSnapshot.findMany({
        where: {
          ruleSetVersion: { activityId: fixture.activityId },
          evaluationPhaseCode: 'display',
        },
        select: { ruleSetVersionId: true, inputFactsHash: true },
        orderBy: { ruleSetVersionId: 'asc' },
      }),
    ).resolves.toEqual(snapshotFactsBeforeFailedDisplays);
    await prisma.certificate.update({
      where: { id: fixture.certificateBId },
      data: { expiredAt: new Date('2199-11-02T00:00:00.000Z') },
    });

    await prisma.memberOrganizationMembership.update({
      where: { id: fixture.membershipId },
      data: { status: MembershipStatus.ENDED, endedAt: new Date('2199-01-01T00:00:00.000Z') },
    });
    expect(readQualification(await detail(fixture.activityId, fixture.auth))).toMatchObject({
      resultCode: 'fail',
    });
    await expect(
      prisma.qualificationEvaluationSnapshot.findMany({
        where: {
          ruleSetVersion: { activityId: fixture.activityId },
          evaluationPhaseCode: 'display',
        },
        select: { ruleSetVersionId: true, inputFactsHash: true },
        orderBy: { ruleSetVersionId: 'asc' },
      }),
    ).resolves.toEqual(snapshotFactsBeforeFailedDisplays);
    await prisma.memberOrganizationMembership.update({
      where: { id: fixture.membershipId },
      data: { status: MembershipStatus.ACTIVE, endedAt: null },
    });

    await prisma.memberInsurance.update({
      where: { id: fixture.insuranceId },
      data: { deletedAt: new Date() },
    });
    expect(readQualification(await detail(fixture.activityId, fixture.auth))).toMatchObject({
      resultCode: 'fail',
    });
    await expect(
      prisma.qualificationEvaluationSnapshot.findMany({
        where: {
          ruleSetVersion: { activityId: fixture.activityId },
          evaluationPhaseCode: 'display',
        },
        select: { ruleSetVersionId: true, inputFactsHash: true },
        orderBy: { ruleSetVersionId: 'asc' },
      }),
    ).resolves.toEqual(snapshotFactsBeforeFailedDisplays);
  });
});
