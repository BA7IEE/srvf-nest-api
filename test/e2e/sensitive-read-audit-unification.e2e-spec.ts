import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivityRegistrationsService } from '../../src/modules/activity-registrations/activity-registrations.service';
import { AttendancesService } from '../../src/modules/attendances/attendances.service';
import { AuditLogsService } from '../../src/modules/audit-logs/audit-logs.service';
import type { AuditLogEvent, AuditMeta } from '../../src/modules/audit-logs/audit-logs.types';
import { CertificatesService } from '../../src/modules/certificates/certificates.service';
import { EmergencyContactsService } from '../../src/modules/emergency-contacts/emergency-contacts.service';
import { MemberInsurancesService } from '../../src/modules/insurances/member-insurances.service';
import { MemberProfilesService } from '../../src/modules/member-profiles/member-profiles.service';
import { RecruitmentApplicationsQueryService } from '../../src/modules/recruitment/recruitment-applications-query.service';
import { RecruitmentCertificateClaimsService } from '../../src/modules/recruitment/recruitment-certificate-claims.service';
import { STORAGE_PROVIDER } from '../../src/modules/storage/storage.constants';
import type { StorageProvider } from '../../src/modules/storage/storage.interface';
import {
  seedCertificateStandard,
  type SeededCertificateStandard,
} from '../fixtures/certificate-standard.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// C-2 sensitive-read audit unification E2E.
//
// This spec deliberately calls the real Nest providers against the guarded test PostgreSQL DB.
// It locks the three boundaries that a mock-only unit suite cannot prove together:
// - all nine sensitive-read event families persist actor/meta with allowlisted metadata only;
// - an audit rejection is fail-closed after the business query but before any response value;
// - CSV generators and signed URLs remain unobtainable until the audit write completes.

const AUDIT_META: AuditMeta = {
  requestId: 'sensitive-read-audit-unification-req-0001',
  ip: '198.51.100.42',
  ua: 'jest/30 sensitive-read-audit-unification',
};

const QUALIFICATION_FILTER_VALUE = 'audit-cert-type-raw-9f1';
const ATTENDANCE_FILTER_VALUE = 'pending';
const REGISTRATION_SCOPE_FILTER_VALUE = 'all' as const;
const RECRUITMENT_STATUS_FILTER_VALUE = 'manual_review';
const RECRUITMENT_RISK_FILTER_VALUE = 'high';

const PROFILE_REAL_NAME = 'Audit PII Profile 9f1';
const PROFILE_DOCUMENT_NUMBER = '110101199001011234';
const PROFILE_MOBILE = '13876543210';
const CONTACT_NAME = 'Audit PII Contact 9f1';
const CONTACT_PHONE = '13987654321';
const INSURANCE_POLICY_NUMBER = 'POLICY-RAW-9F1-SECRET';
const APPLICATION_REAL_NAME = 'Audit PII Applicant 9f1';
const APPLICATION_ID_CARD = '440101199202023456';
const APPLICATION_PHONE = '13765432109';
const ID_CARD_IMAGE_KEY = 'recruitment/audit/id-card-original-9f1.jpg';
const CERTIFICATE_IMAGE_KEY = 'recruitment/audit/certificate-first-aid-9f1.jpg';
const SIGNED_URL = 'https://signed.example.invalid/audit-secret?token=raw-9f1';

const EXPECTED_EVENT_FAMILIES = [
  'profile.read.other',
  'emergency-contact.read.other',
  'member-insurance.read.other',
  'certificate.read.other',
  'certificate.read.qualification-flag',
  'attendance-sheet.read.other',
  'registration.review',
  'recruitment-application.read.other',
  'recruitment-application.id-card-image.read',
] as const satisfies readonly AuditLogEvent[];

interface ReadAuditContext {
  requestId: string;
  ip: string | null;
  ua: string | null;
  extra?: Record<string, unknown>;
}

interface SeededFixtures {
  memberId: string;
  profileId: string;
  activityId: string;
  recruitmentCycleId: string;
  recruitmentApplicationId: string;
  recruitmentCertificateClaimId: string;
}

type OrdinaryReadCase =
  | 'profile'
  | 'emergency-contact'
  | 'member-insurance'
  | 'certificate-list'
  | 'certificate-qualification'
  | 'attendance-list'
  | 'recruitment-list';

describe('sensitive-read audit unification (C-2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let certStd: SeededCertificateStandard;
  let auditLogs: AuditLogsService;
  let memberProfiles: MemberProfilesService;
  let emergencyContacts: EmergencyContactsService;
  let memberInsurances: MemberInsurancesService;
  let certificates: CertificatesService;
  let attendances: AttendancesService;
  let registrations: ActivityRegistrationsService;
  let recruitmentQueries: RecruitmentApplicationsQueryService;
  let recruitmentClaims: RecruitmentCertificateClaimsService;
  let storage: StorageProvider;
  let actor: CurrentUserPayload;
  let fixtures: SeededFixtures;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDb(app);

    prisma = app.get(PrismaService);
    certStd = await seedCertificateStandard(prisma, {
      categoryCode: QUALIFICATION_FILTER_VALUE,
    });
    auditLogs = app.get(AuditLogsService);
    memberProfiles = app.get(MemberProfilesService);
    emergencyContacts = app.get(EmergencyContactsService);
    memberInsurances = app.get(MemberInsurancesService);
    certificates = app.get(CertificatesService);
    attendances = app.get(AttendancesService);
    registrations = app.get(ActivityRegistrationsService);
    recruitmentQueries = app.get(RecruitmentApplicationsQueryService);
    recruitmentClaims = app.get(RecruitmentCertificateClaimsService);
    storage = app.get<StorageProvider>(STORAGE_PROVIDER);

    const actorRow = await prisma.user.create({
      data: {
        username: 'sensitive-read-audit-sa',
        passwordHash: '$2a$10$synthetic-hash-unused-no-login',
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
      },
      select: { id: true, username: true },
    });
    actor = {
      id: actorRow.id,
      username: actorRow.username,
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      memberId: null,
    };

    const member = await prisma.member.create({
      data: { memberNo: 'sensitive-audit-m-001', ...memberIdentityData('Sensitive Audit Member') },
      select: { id: true },
    });
    const profile = await prisma.memberProfile.create({
      data: {
        memberId: member.id,
        genderCode: 'male',
        birthDate: new Date('1990-01-01T00:00:00.000Z'),
        documentTypeCode: 'mainland_id',
        documentNumber: PROFILE_DOCUMENT_NUMBER,
        mobile: PROFILE_MOBILE,
        privacyConsentSigned: true,
        exerciseMethods: [],
        firstAidSkills: [],
      },
      select: { id: true },
    });
    await prisma.emergencyContact.create({
      data: {
        memberId: member.id,
        contactName: CONTACT_NAME,
        relationCode: 'family',
        phonePrimary: CONTACT_PHONE,
        address: 'Audit PII Address 9f1',
        priority: 0,
      },
    });
    await prisma.memberInsurance.create({
      data: {
        memberId: member.id,
        insurerName: 'Audit PII Insurer 9f1',
        policyNumber: INSURANCE_POLICY_NUMBER,
        coverageStart: new Date('2026-01-01T00:00:00.000Z'),
        coverageEnd: new Date('2099-12-31T23:59:59.000Z'),
      },
    });

    const certType = await prisma.dictType.create({
      data: { code: 'cert_type', label: 'Certificate type' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: {
        typeId: certType.id,
        code: QUALIFICATION_FILTER_VALUE,
        label: 'Audit qualification fixture',
      },
    });
    await prisma.certificate.create({
      data: {
        memberId: member.id,
        ...certStd.certificateColumns,
        issuingOrg: 'Audit PII Issuer 9f1',
        certNumber: 'CERT-RAW-9F1-SECRET',
        issuedAt: new Date('2026-01-01T00:00:00.000Z'),
        certStatusCode: 'verified',
      },
    });

    const organization = await prisma.organization.create({
      data: {
        name: 'Sensitive Read Audit Root',
        nodeTypeCode: 'audit-root',
        parentId: null,
      },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: 'Sensitive Read Audit Activity',
        activityTypeCode: 'audit-activity',
        organizationId: organization.id,
        startAt: new Date('2099-07-19T08:00:00.000Z'),
        endAt: new Date('2099-07-19T12:00:00.000Z'),
        location: 'audit fixture',
        statusCode: 'published',
      },
      select: { id: true },
    });
    await prisma.attendanceSheet.create({
      data: {
        activityId: activity.id,
        submitterUserId: actor.id,
        statusCode: ATTENDANCE_FILTER_VALUE,
      },
    });

    const cycle = await prisma.recruitmentCycle.create({
      data: {
        year: 2099,
        name: 'Sensitive Read Audit Cycle',
        statusCode: 'closed',
      },
      select: { id: true },
    });
    const application = await prisma.recruitmentApplication.create({
      data: {
        cycleId: cycle.id,
        statusCode: RECRUITMENT_STATUS_FILTER_VALUE,
        riskLevel: RECRUITMENT_RISK_FILTER_VALUE,
        documentTypeCode: 'mainland_id',
        realName: APPLICATION_REAL_NAME,
        idCardNumber: APPLICATION_ID_CARD,
        phone: APPLICATION_PHONE,
        idCardImageKey: ID_CARD_IMAGE_KEY,
      },
      select: { id: true },
    });
    // 证书标准库 PR-4a-2:证书图的敏感读入口从「报名行 JSON 按类别」迁到
    // 「Claim 行」。同一条不变量(先按安全计数审计、再调 provider;审计失败零 provider)
    // 必须跟着入口走 —— 本文件是「每个敏感读入口都被覆盖」的总账,漏改就等于漏防。
    const certificateClaim = await prisma.recruitmentCertificateClaim.create({
      data: {
        applicationId: application.id,
        status: 'SUBMITTED',
        categoryHintCode: 'first_aid',
        imageKeys: [CERTIFICATE_IMAGE_KEY],
      },
      select: { id: true },
    });

    fixtures = {
      memberId: member.id,
      profileId: profile.id,
      activityId: activity.id,
      recruitmentCycleId: cycle.id,
      recruitmentApplicationId: application.id,
      recruitmentCertificateClaimId: certificateClaim.id,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function recruitmentList(): Promise<unknown> {
    return recruitmentQueries.listForAdmin(
      { page: 1, pageSize: 20 },
      {
        cycleId: fixtures.recruitmentCycleId,
        statusCode: RECRUITMENT_STATUS_FILTER_VALUE,
        riskLevel: RECRUITMENT_RISK_FILTER_VALUE,
      },
      actor,
      AUDIT_META,
    );
  }

  async function invokeOrdinaryRead(name: OrdinaryReadCase): Promise<unknown> {
    switch (name) {
      case 'profile':
        return memberProfiles.findOne(fixtures.memberId, actor, AUDIT_META);
      case 'emergency-contact':
        return emergencyContacts.list(fixtures.memberId, actor, AUDIT_META);
      case 'member-insurance':
        return memberInsurances.listForMember(fixtures.memberId, actor, AUDIT_META);
      case 'certificate-list':
        return certificates.list(fixtures.memberId, actor, AUDIT_META);
      case 'certificate-qualification':
        return certificates.isQualified(
          fixtures.memberId,
          'category',
          QUALIFICATION_FILTER_VALUE,
          actor,
          AUDIT_META,
        );
      case 'attendance-list':
        return attendances.list(
          fixtures.activityId,
          { page: 1, pageSize: 20, statusCode: ATTENDANCE_FILTER_VALUE },
          actor,
          AUDIT_META,
        );
      case 'recruitment-list':
        return recruitmentList();
    }
  }

  async function readFirstChunk(
    generator: AsyncGenerator<string, void, undefined> | undefined,
  ): Promise<IteratorResult<string, void> | undefined> {
    return generator?.next();
  }

  it('persists 9 event families with actor/meta and allowlisted extras only', async () => {
    const storageSpy = jest.spyOn(storage, 'generateDownloadUrl').mockResolvedValue({
      url: SIGNED_URL,
      expiresAt: new Date('2099-07-19T12:05:00.000Z'),
    });

    await memberProfiles.findOne(fixtures.memberId, actor, AUDIT_META);
    await emergencyContacts.list(fixtures.memberId, actor, AUDIT_META);
    await memberInsurances.listForMember(fixtures.memberId, actor, AUDIT_META);
    await certificates.list(fixtures.memberId, actor, AUDIT_META);
    await certificates.isQualified(
      fixtures.memberId,
      'category',
      QUALIFICATION_FILTER_VALUE,
      actor,
      AUDIT_META,
    );
    await attendances.list(
      fixtures.activityId,
      { page: 1, pageSize: 20, statusCode: ATTENDANCE_FILTER_VALUE },
      actor,
      AUDIT_META,
    );
    const registrationGenerator = await registrations.exportCsv(
      fixtures.activityId,
      { format: 'csv', scope: REGISTRATION_SCOPE_FILTER_VALUE },
      actor,
      AUDIT_META,
    );
    await recruitmentList();
    const recruitmentGenerator = await recruitmentQueries.exportApplicationsCsv(
      { cycleId: fixtures.recruitmentCycleId, filter: 'manual' },
      actor,
      AUDIT_META,
    );
    await recruitmentClaims.getImageUrls(actor, fixtures.recruitmentCertificateClaimId, AUDIT_META);
    await recruitmentQueries.getIdCardImageUrl(
      fixtures.recruitmentApplicationId,
      actor,
      AUDIT_META,
    );

    expect(registrationGenerator).toBeDefined();
    expect(recruitmentGenerator).toBeDefined();
    expect(storageSpy).toHaveBeenCalledTimes(2);

    const rows = await prisma.auditLog.findMany({
      where: { actorUserId: actor.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(rows).toHaveLength(11);
    expect([...new Set(rows.map((row) => row.event))].sort()).toEqual(
      [...EXPECTED_EVENT_FAMILIES].sort(),
    );

    for (const row of rows) {
      expect(row.actorUserId).toBe(actor.id);
      expect(row.actorRoleSnap).toBe(Role.SUPER_ADMIN);
      expect(row.success).toBe(true);
      const context = row.context as unknown as ReadAuditContext;
      expect(context.requestId).toBe(AUDIT_META.requestId);
      expect(context.ip).toBe(AUDIT_META.ip);
      expect(context.ua).toBe(AUDIT_META.ua);
    }

    const rowFor = (event: AuditLogEvent, operation: string) => {
      const matches = rows.filter((row) => {
        const context = row.context as unknown as ReadAuditContext;
        return row.event === event && context.extra?.operation === operation;
      });
      expect(matches).toHaveLength(1);
      return matches[0];
    };
    const contextFor = (event: AuditLogEvent, operation: string): ReadAuditContext =>
      rowFor(event, operation).context as unknown as ReadAuditContext;

    const profileRow = rowFor('profile.read.other', 'detail');
    expect([profileRow.resourceType, profileRow.resourceId]).toEqual([
      'member_profile',
      fixtures.profileId,
    ]);
    expect(contextFor('profile.read.other', 'detail').extra).toEqual({
      operation: 'detail',
      targetMemberId: fixtures.memberId,
      maskLevel: 'plain',
    });

    expect(contextFor('emergency-contact.read.other', 'list').extra).toEqual({
      operation: 'list',
      count: 1,
      maskLevel: 'plain',
    });
    expect(contextFor('member-insurance.read.other', 'list').extra).toEqual({
      operation: 'list',
      count: 1,
    });
    expect(contextFor('certificate.read.other', 'list').extra).toEqual({
      operation: 'list',
      count: 1,
    });
    expect(contextFor('certificate.read.qualification-flag', 'qualification-flag').extra).toEqual({
      operation: 'qualification-flag',
      // 评审 findings F4(§12):判据从单一 certTypeCode 改成两级。
      // 审计仍只记「按哪些字段筛的」,不记筛选值 —— 字段名换了,这条不变量没换。
      filterFields: ['criterionType', 'criterionCode'],
    });
    expect(contextFor('attendance-sheet.read.other', 'list').extra).toEqual({
      operation: 'list',
      count: 1,
      filterFields: ['statusCode'],
    });
    expect(contextFor('registration.review', 'export').extra).toEqual({
      operation: 'export',
      filterFields: ['format', 'scope'],
    });
    expect(contextFor('recruitment-application.read.other', 'list').extra).toEqual({
      operation: 'list',
      filterFields: ['cycleId', 'statusCode', 'riskLevel'],
      maskLevel: 'masked',
      count: 1,
    });
    expect(contextFor('recruitment-application.read.other', 'export').extra).toEqual({
      operation: 'export',
      filterFields: ['cycleId', 'filter'],
      maskLevel: 'plain',
    });
    // PR-4a-2:operation 从 `certificate-images`(报名行按类别)改为
    // `certificate-claim-images`(单条申报)。事件名与 extra 白名单不变 ——
    // 换的是入口,不是审计口径。
    expect(
      contextFor('recruitment-application.read.other', 'certificate-claim-images').extra,
    ).toEqual({
      operation: 'certificate-claim-images',
      count: 1,
    });
    expect(contextFor('recruitment-application.id-card-image.read', 'id-card-image').extra).toEqual(
      {
        operation: 'id-card-image',
        fields: ['idCardImage'],
      },
    );

    const serializedContexts = JSON.stringify(rows.map((row) => row.context));
    const forbiddenValues = [
      PROFILE_REAL_NAME,
      PROFILE_DOCUMENT_NUMBER,
      PROFILE_MOBILE,
      CONTACT_NAME,
      CONTACT_PHONE,
      INSURANCE_POLICY_NUMBER,
      APPLICATION_REAL_NAME,
      APPLICATION_ID_CARD,
      APPLICATION_PHONE,
      ID_CARD_IMAGE_KEY,
      CERTIFICATE_IMAGE_KEY,
      SIGNED_URL,
      QUALIFICATION_FILTER_VALUE,
      ATTENDANCE_FILTER_VALUE,
      REGISTRATION_SCOPE_FILTER_VALUE,
      fixtures.recruitmentCycleId,
      RECRUITMENT_STATUS_FILTER_VALUE,
      RECRUITMENT_RISK_FILTER_VALUE,
      'manual',
    ];
    for (const value of forbiddenValues) {
      expect(serializedContexts).not.toContain(value);
    }
    expect(serializedContexts).not.toMatch(
      /policy.?number|id.?card.?number|object.?key|signed.?url|credential|token/i,
    );
  });

  it.each<OrdinaryReadCase>([
    'profile',
    'emergency-contact',
    'member-insurance',
    'certificate-list',
    'certificate-qualification',
    'attendance-list',
    'recruitment-list',
  ])('%s rejects the read result when audit persistence rejects', async (name) => {
    const auditError = new Error(`audit unavailable: ${name}`);
    const auditSpy = jest.spyOn(auditLogs, 'log').mockRejectedValueOnce(auditError);

    await expect(invokeOrdinaryRead(name)).rejects.toBe(auditError);
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });

  it('CSV audit rejection exposes neither generator nor first byte for both exports', async () => {
    const auditSpy = jest.spyOn(auditLogs, 'log');
    const registrationQuerySpy = jest.spyOn(prisma.activityRegistration, 'findMany');
    const recruitmentQuerySpy = jest.spyOn(prisma.recruitmentApplication, 'findMany');

    let registrationGenerator: AsyncGenerator<string, void, undefined> | undefined;
    const registrationAuditError = new Error('registration export audit unavailable');
    auditSpy.mockRejectedValueOnce(registrationAuditError);
    await expect(
      registrations
        .exportCsv(
          fixtures.activityId,
          { format: 'csv', scope: REGISTRATION_SCOPE_FILTER_VALUE },
          actor,
          AUDIT_META,
        )
        .then((generator) => {
          registrationGenerator = generator;
          return generator;
        }),
    ).rejects.toBe(registrationAuditError);
    expect(registrationGenerator).toBeUndefined();
    expect(await readFirstChunk(registrationGenerator)).toBeUndefined();
    expect(registrationQuerySpy).not.toHaveBeenCalled();

    let recruitmentGenerator: AsyncGenerator<string, void, undefined> | undefined;
    const recruitmentAuditError = new Error('recruitment export audit unavailable');
    auditSpy.mockRejectedValueOnce(recruitmentAuditError);
    await expect(
      recruitmentQueries
        .exportApplicationsCsv(
          { cycleId: fixtures.recruitmentCycleId, filter: 'manual' },
          actor,
          AUDIT_META,
        )
        .then((generator) => {
          recruitmentGenerator = generator;
          return generator;
        }),
    ).rejects.toBe(recruitmentAuditError);
    expect(recruitmentGenerator).toBeUndefined();
    expect(await readFirstChunk(recruitmentGenerator)).toBeUndefined();
    expect(recruitmentQuerySpy).not.toHaveBeenCalled();
  });

  it('signed-image audit rejection calls the storage provider zero times', async () => {
    const providerSpy = jest.spyOn(storage, 'generateDownloadUrl').mockResolvedValue({
      url: SIGNED_URL,
      expiresAt: new Date('2099-07-19T12:05:00.000Z'),
    });
    const auditSpy = jest.spyOn(auditLogs, 'log');

    const idCardAuditError = new Error('id-card image audit unavailable');
    auditSpy.mockRejectedValueOnce(idCardAuditError);
    await expect(
      recruitmentQueries.getIdCardImageUrl(fixtures.recruitmentApplicationId, actor, AUDIT_META),
    ).rejects.toBe(idCardAuditError);
    expect(providerSpy).not.toHaveBeenCalled();

    const certificateAuditError = new Error('certificate image audit unavailable');
    auditSpy.mockRejectedValueOnce(certificateAuditError);
    await expect(
      recruitmentClaims.getImageUrls(actor, fixtures.recruitmentCertificateClaimId, AUDIT_META),
    ).rejects.toBe(certificateAuditError);
    expect(providerSpy).not.toHaveBeenCalled();
  });
});
