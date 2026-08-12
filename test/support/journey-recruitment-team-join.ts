import request from 'supertest';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { hashPhoneVerificationToken } from '../../src/modules/recruitment/recruitment.constants';
import { AppMeTeamJoinService } from '../../src/modules/team-join/team-join-applications.app.service';
import { TeamJoinApplicationsService } from '../../src/modules/team-join/team-join-applications.service';
import { TeamJoinEnrollmentService } from '../../src/modules/team-join/team-join-enrollment.service';
import { devStubOcrImage, VALID_PNG_IMAGE } from '../helpers/file-fixtures';
import { httpServer } from '../helpers/http-server';
import { type JourneyRuntime, journeyAdmin, journeyPrisma } from './journey-runtime';

const RECRUITMENT_CYCLES = '/api/admin/v1/recruitment/cycles';
const RECRUITMENT_APPLICATIONS = '/api/open/v1/recruitment/applications';
const CERTIFICATE_CLAIMS = '/api/open/v1/recruitment/certificate-claims';
const ADMIN_RECRUITMENT = '/api/admin/v1/recruitment';
const GENERAL_GATES = [
  'fitness',
  'first-aid-training',
  'military',
  'psych',
  'interview',
  'dept-assessment',
  'entry-exam',
  'intermediate-outdoor',
] as const;

const JOURNEY_META = { requestId: 'journey-recruitment-team-join', ip: null, ua: null };
const ID_CARD = '110101199003070038';

interface JourneyHttpResponse {
  status: number;
  body: { code?: number; message?: string; data?: unknown };
}

function requireStatus(response: JourneyHttpResponse, expected: number, action: string): void {
  if (response.status !== expected) {
    throw new Error(
      `${action} expected HTTP ${expected}, got ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
}

async function createAndOpenRecruitmentCycle(runtime: JourneyRuntime): Promise<string> {
  const created = await request(httpServer(runtime.app))
    .post(RECRUITMENT_CYCLES)
    .set('Authorization', runtime.adminAuth)
    .send({ year: 2026, name: '旅程一招新轮次', capacity: 10 });
  requireStatus(created, 201, '创建招新轮次');
  const id = String(created.body.data?.id ?? '');
  if (!id) throw new Error('创建招新轮次未返回 id');

  const opened = await request(httpServer(runtime.app))
    .patch(`${RECRUITMENT_CYCLES}/${id}`)
    .set('Authorization', runtime.adminAuth)
    .send({ statusCode: 'open' });
  requireStatus(opened, 200, '开启招新轮次');
  return id;
}

async function submitRecruitmentApplication(
  runtime: JourneyRuntime,
  cycleId: string,
): Promise<{ applicationId: string; wechatCode: string }> {
  const prisma = journeyPrisma(runtime);
  const wechatCode = 'journey-1-applicant';
  const phone = '13900001001';
  const token = 'journey-1-phone-token';
  await prisma.recruitmentIdentitySession.create({
    data: {
      cycleId,
      phone,
      phoneVerifiedAt: new Date(),
      phoneVerificationMethod: 'sms',
      phoneVerificationTokenHash: hashPhoneVerificationToken(token),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });

  const payload = {
    wechatCode,
    phoneVerificationToken: token,
    realName: '旅程申请人',
    idCardNumber: ID_CARD,
    documentTypeCode: 'mainland_id',
    phone,
    detailedAddress: '北京市朝阳区旅程测试街道 1 号',
    cityDistrict: '北京市朝阳区',
    sourceChannel: 'journey-test',
    emergencyContacts: [
      { name: '旅程家属甲', relation: 'parent', phone: '13900001002' },
      { name: '旅程家属乙', relation: 'family', phone: '13900001003' },
    ],
    privacyConsentAccepted: true,
  };
  const submitted = await request(httpServer(runtime.app))
    .post(RECRUITMENT_APPLICATIONS)
    .field('payload', JSON.stringify(payload))
    .attach(
      'idCardImage',
      devStubOcrImage({ name: payload.realName, idCardNumber: ID_CARD, clarity: true }),
      { filename: 'journey-id.jpg', contentType: 'image/jpeg' },
    )
    .attach('signatureImage', VALID_PNG_IMAGE, {
      filename: 'journey-signature.png',
      contentType: 'image/png',
    });
  requireStatus(submitted, 201, '公开提交招新报名');
  if (submitted.body.data?.statusCode !== 'verified') {
    throw new Error(`公开报名未进入 verified: ${JSON.stringify(submitted.body)}`);
  }

  const application = await prisma.recruitmentApplication.findFirst({
    where: { cycleId, openid: `dev-openid-${wechatCode}` },
    select: { id: true },
  });
  if (!application) throw new Error('公开报名成功后未找到申请记录');
  return { applicationId: application.id, wechatCode };
}

async function seedClaimRecognitionStandards(
  runtime: JourneyRuntime,
): Promise<Map<string, string>> {
  const prisma = journeyPrisma(runtime);
  const standardByCategory = new Map<string, string>();
  for (const category of ['first_aid', 'bsafe']) {
    const standard = await prisma.certificateStandard.create({
      data: {
        code: `journey-1-${category}`,
        name: `旅程一 ${category} 证书标准`,
        kind: 'CREDENTIAL',
        categoryCode: category,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    await prisma.certificateRecognitionPolicy.create({
      data: {
        standardId: standard.id,
        version: 1,
        status: 'ACTIVE',
        issuerPolicy: 'FREE_TEXT',
        validityMode: 'EXPLICIT_OPTIONAL',
        certNumberMode: 'OPTIONAL',
      },
    });
    standardByCategory.set(category, standard.id);
  }
  return standardByCategory;
}

async function submitAndApproveRequiredClaims(
  runtime: JourneyRuntime,
  applicationId: string,
  wechatCode: string,
  standardByCategory: ReadonlyMap<string, string>,
): Promise<void> {
  for (const category of ['first_aid', 'bsafe']) {
    const standardId = standardByCategory.get(category);
    if (!standardId) throw new Error(`缺少 ${category} 的旅程证书标准`);
    const submitted = await request(httpServer(runtime.app))
      .post(CERTIFICATE_CLAIMS)
      .field('categoryHintCode', category)
      .field('suggestedStandardId', standardId)
      .field('rawCertificateName', `旅程一 ${category} 证书`)
      .field('issuingOrg', '旅程测试发证机构')
      .field('issuedAt', '2026-01-01')
      .field('wechatCode', wechatCode)
      .attach('images', VALID_PNG_IMAGE, {
        filename: `journey-${category}.png`,
        contentType: 'image/png',
      });
    requireStatus(submitted, 201, `公开提交 ${category} 证书申报`);
    const claim = submitted.body.data?.claim as { id?: string; version?: number } | undefined;
    if (!claim?.id || claim.version === undefined) {
      throw new Error(
        `公开提交 ${category} 证书申报未返回 claim: ${JSON.stringify(submitted.body)}`,
      );
    }
    const reviewed = await request(httpServer(runtime.app))
      .post(`${ADMIN_RECRUITMENT}/certificate-claims/${claim.id}/review`)
      .set('Authorization', runtime.adminAuth)
      .send({
        decision: 'APPROVE',
        version: claim.version,
        standardId,
        issuingOrg: '旅程测试发证机构',
        issuedAt: '2026-01-01',
      });
    requireStatus(reviewed, 200, `审核通过 ${category} 证书申报`);
  }

  const after = await journeyPrisma(runtime).recruitmentApplication.findUnique({
    where: { id: applicationId },
    select: { statusCode: true },
  });
  if (after?.statusCode !== 'pending_evaluation') {
    throw new Error(`证书审核后报名未进入 pending_evaluation: ${after?.statusCode ?? 'missing'}`);
  }
}

async function promoteApplicant(
  runtime: JourneyRuntime,
  applicationId: string,
): Promise<{
  memberId: string;
  user: CurrentUserPayload;
}> {
  const prisma = journeyPrisma(runtime);
  const volOrg = await prisma.organization.create({
    data: { name: '志愿者归口', code: 'VOL', nodeTypeCode: 'volunteer', status: 'ACTIVE' },
  });
  if (!volOrg.id) throw new Error('创建 VOL 归口组织失败');

  const application = await prisma.recruitmentApplication.findUniqueOrThrow({
    where: { id: applicationId },
    select: { cycleId: true },
  });
  const promoted = await request(httpServer(runtime.app))
    .post(`${RECRUITMENT_CYCLES}/${application.cycleId}/promote`)
    .set('Authorization', runtime.adminAuth)
    .send({});
  requireStatus(promoted, 200, '公示结束后批量发号');

  const after = await prisma.recruitmentApplication.findUnique({
    where: { id: applicationId },
    select: { statusCode: true, promotedMemberId: true },
  });
  if (after?.statusCode !== 'promoted' || !after.promotedMemberId) {
    throw new Error(`发号后报名未正确落到 promoted: ${JSON.stringify(after)}`);
  }
  const user = await prisma.user.findFirst({
    where: { memberId: after.promotedMemberId, deletedAt: null },
    select: { id: true, username: true, role: true, status: true, memberId: true },
  });
  if (!user?.memberId) throw new Error('发号后未建立绑定队员的账号');
  return {
    memberId: user.memberId,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      memberId: user.memberId,
    },
  };
}

async function prepareTeamJoin(runtime: JourneyRuntime, memberId: string): Promise<string> {
  const prisma = journeyPrisma(runtime);
  const target = await prisma.organization.create({
    data: { name: '旅程一目标队', nodeTypeCode: 'general', status: 'ACTIVE' },
  });
  await prisma.teamJoinCycle.create({
    data: {
      year: 2026,
      name: '旅程一入队轮次',
      statusCode: 'open',
      openedAt: new Date(),
      openOrganizationIds: [target.id],
      maxTargetOrgs: 1,
    },
  });

  // 入队贡献值是已完成活动的历史事实；按两个北京自然日拆 3+2，避开每日封顶。
  const activity = await prisma.activity.create({
    data: {
      title: '旅程一贡献前置活动',
      activityTypeCode: 'journey-training',
      organizationId: target.id,
      startAt: new Date('2026-01-20T01:00:00.000Z'),
      endAt: new Date('2026-01-20T05:00:00.000Z'),
      location: '旅程测试地点',
      statusCode: 'completed',
    },
  });
  const sheet = await prisma.attendanceSheet.create({
    data: {
      activityId: activity.id,
      submitterUserId: journeyAdmin(runtime).id,
      statusCode: 'approved',
    },
  });
  await prisma.attendanceRecord.createMany({
    data: [
      {
        sheetId: sheet.id,
        memberId,
        roleCode: 'member',
        checkInAt: new Date('2026-01-20T01:00:00.000Z'),
        checkOutAt: new Date('2026-01-20T05:00:00.000Z'),
        serviceHours: '4.00',
        attendanceStatusCode: 'present',
        contributionPoints: '3.00',
      },
      {
        sheetId: sheet.id,
        memberId,
        roleCode: 'member',
        checkInAt: new Date('2026-01-19T01:00:00.000Z'),
        checkOutAt: new Date('2026-01-19T05:00:00.000Z'),
        serviceHours: '4.00',
        attendanceStatusCode: 'present',
        contributionPoints: '2.00',
      },
    ],
  });
  return target.id;
}

export interface RecruitmentTeamJoinJourneyResult {
  readonly applicationStatus: string;
  readonly memberId: string;
  readonly memberNo: string;
  readonly teamJoinApplicationId: string;
  readonly teamJoinStatus: string;
  readonly gradeCode: string | null;
  readonly targetOrganizationId: string;
  replayFinalJoin(): Promise<number>;
}

/**
 * 金五条①：真实公开报名 → 招新门槛/评定 → 批量发号建账号 → 入队全链。
 *
 * 除轮次、字典、考勤历史等前置造数外，所有状态推进均经生产 HTTP 或生产 service。
 */
export async function runRecruitmentPromotionTeamJoinJourney(
  runtime: JourneyRuntime,
): Promise<RecruitmentTeamJoinJourneyResult> {
  const prisma = journeyPrisma(runtime);
  const cycleId = await createAndOpenRecruitmentCycle(runtime);
  const { applicationId, wechatCode } = await submitRecruitmentApplication(runtime, cycleId);

  for (const thresholdCode of ['patrol1', 'patrol2', 'training']) {
    const marked = await request(httpServer(runtime.app))
      .patch(`${ADMIN_RECRUITMENT}/applications/${applicationId}/thresholds`)
      .set('Authorization', runtime.adminAuth)
      .send({ thresholdCode, completed: true });
    requireStatus(marked, 200, `标记招新门槛 ${thresholdCode}`);
  }
  const standards = await seedClaimRecognitionStandards(runtime);
  await submitAndApproveRequiredClaims(runtime, applicationId, wechatCode, standards);

  const evaluated = await request(httpServer(runtime.app))
    .post(`${ADMIN_RECRUITMENT}/applications/${applicationId}/evaluate`)
    .set('Authorization', runtime.adminAuth)
    .send({ approved: true, note: '旅程一综合评定通过' });
  requireStatus(evaluated, 200, '招新综合评定');
  if (evaluated.body.data?.statusCode !== 'publicity') {
    throw new Error(`招新综合评定未进入 publicity: ${JSON.stringify(evaluated.body)}`);
  }

  const promoted = await promoteApplicant(runtime, applicationId);
  const targetOrganizationId = await prepareTeamJoin(runtime, promoted.memberId);
  const appService = runtime.app.get(AppMeTeamJoinService);
  const reviewService = runtime.app.get(TeamJoinApplicationsService);
  const enrollmentService = runtime.app.get(TeamJoinEnrollmentService);
  const created = await appService.submit(
    { targetOrganizationIds: [targetOrganizationId] },
    promoted.user,
    JOURNEY_META,
    new Date(),
  );
  for (const gateCode of GENERAL_GATES) {
    await reviewService.markGate(
      created.id,
      { gateCode, passed: true, completionDate: new Date().toISOString() },
      journeyAdmin(runtime),
      JOURNEY_META,
      new Date(),
    );
  }
  await reviewService.evaluate(
    created.id,
    { approved: true, note: '旅程一入队综合评定通过' },
    journeyAdmin(runtime),
    JOURNEY_META,
    new Date(),
  );
  const joined = await enrollmentService.join(
    created.id,
    { organizationId: targetOrganizationId },
    journeyAdmin(runtime),
    JOURNEY_META,
    new Date(),
  );

  const member = await prisma.member.findUnique({
    where: { id: promoted.memberId },
    select: { memberNo: true, gradeCode: true },
  });
  if (!member) throw new Error('入队后队员不存在');
  const membership = await prisma.memberOrganizationMembership.findFirst({
    where: {
      memberId: promoted.memberId,
      organizationId: targetOrganizationId,
      status: 'ACTIVE',
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!membership) throw new Error('入队后未建立目标组织的有效归属');

  return {
    applicationStatus: 'promoted',
    memberId: promoted.memberId,
    memberNo: member.memberNo,
    teamJoinApplicationId: created.id,
    teamJoinStatus: joined.statusCode,
    gradeCode: member.gradeCode,
    targetOrganizationId,
    async replayFinalJoin(): Promise<number> {
      try {
        await enrollmentService.join(
          created.id,
          { organizationId: targetOrganizationId },
          journeyAdmin(runtime),
          JOURNEY_META,
          new Date(),
        );
      } catch (error) {
        if (error instanceof BizException) return error.biz.code;
        throw error;
      }
      throw new Error('终态入队重放意外成功');
    },
  };
}
