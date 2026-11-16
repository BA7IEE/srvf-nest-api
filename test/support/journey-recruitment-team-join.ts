import { Role } from '@prisma/client';
import request from 'supertest';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { AppMeTeamJoinService } from '../../src/modules/team-join/team-join-applications.app.service';
import { TeamJoinApplicationsService } from '../../src/modules/team-join/team-join-applications.service';
import { TeamJoinEnrollmentService } from '../../src/modules/team-join/team-join-enrollment.service';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { devStubOcrImage, VALID_PNG_IMAGE } from '../helpers/file-fixtures';
import { httpServer } from '../helpers/http-server';
import { issuePhoneVerificationToken } from './journey-recruitment-identity';
import { produceJourneyNativeContribution } from './journey-native-contribution';
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
  // 招新链第一步走**真入口**:发码 → 验码 → 拿一次性 token(P2-12a;此前是直写会话行起步)
  const token = await issuePhoneVerificationToken(runtime, phone);

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
    // journey-direct-write: ambient — 证书标准属配置底座
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
    // journey-direct-write: ambient — 同上
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
  // journey-direct-write: ambient — 组织树底座
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

// 负责人提交、独立一审、独立终审；两个测试角色分别只含既有新链审核码。
// 三段责任人从真实不可变版本与 ReviewAction 读回校验，不以 HTTP 成功代替身份隔离证明。
interface SettlementReviewers {
  readonly firstAuth: string;
  readonly finalAuth: string;
}

const FIRST_REVIEWER_PERMISSION_CODES = ['activity.settlement-first-review.record'] as const;
const FINAL_REVIEWER_PERMISSION_CODES = ['activity.settlement-final-review.record'] as const;

async function grantWorkflowReviewerRole(
  runtime: JourneyRuntime,
  spec: {
    username: string;
    roleCode: string;
    displayName: string;
    permissionCodes: ReadonlyArray<string>;
  },
): Promise<string> {
  const prisma = journeyPrisma(runtime);
  // journey-direct-write: ambient — 判权底座(RBAC 角色行);建角色不属于被验的考勤审核链
  const role = await prisma.rbacRole.create({
    data: { code: spec.roleCode, displayName: spec.displayName },
    select: { id: true },
  });
  const permissions = await prisma.permission.findMany({
    where: { code: { in: [...spec.permissionCodes] } },
    select: { id: true },
  });
  // 自证:码集没建全就当场炸。少一条 Permission 行 ⇒ 该角色少一条码,而症状要到几十行后
  // 才以 30100 的形态出现,读起来像「判权写错了」而不是「夹具少建了一行」。
  if (permissions.length !== spec.permissionCodes.length) {
    throw new Error(
      `${spec.roleCode} 需要 ${spec.permissionCodes.length} 条 Permission,` +
        `实际只查到 ${permissions.length} 条`,
    );
  }
  // journey-direct-write: ambient — 同上(角色 × 权限映射)
  await prisma.rolePermission.createMany({
    data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
  });
  const user = await createTestUser(runtime.app, { username: spec.username, role: Role.ADMIN });
  // journey-direct-write: ambient — 同上(USER × 角色 GLOBAL 绑定;判权唯一读源)
  await prisma.roleBinding.create({
    data: {
      principalType: 'USER',
      principalId: user.id,
      roleId: role.id,
      scopeType: 'GLOBAL',
      status: 'ACTIVE',
    },
  });
  return (await loginAs(runtime.app, spec.username)).authHeader;
}

async function prepareSettlementReviewers(runtime: JourneyRuntime): Promise<SettlementReviewers> {
  // journey-direct-write: ambient — 两个独立审核身份仅持既有新链审核码。
  await journeyPrisma(runtime).permission.createMany({
    data: [
      {
        code: FIRST_REVIEWER_PERMISSION_CODES[0],
        module: 'activity',
        action: 'settlement-first-review',
        resourceType: 'record',
      },
      {
        code: FINAL_REVIEWER_PERMISSION_CODES[0],
        module: 'activity',
        action: 'settlement-final-review',
        resourceType: 'record',
      },
    ],
    skipDuplicates: true,
  });
  const firstAuth = await grantWorkflowReviewerRole(runtime, {
    username: 'journey-settlement-first',
    roleCode: 'journey-settlement-first-reviewer',
    displayName: '结算一审员',
    permissionCodes: FIRST_REVIEWER_PERMISSION_CODES,
  });
  const finalAuth = await grantWorkflowReviewerRole(runtime, {
    username: 'journey-settlement-final',
    roleCode: 'journey-settlement-final-reviewer',
    displayName: '结算终审员',
    permissionCodes: FINAL_REVIEWER_PERMISSION_CODES,
  });
  return { firstAuth, finalAuth };
}

// 两条考勤记录跨**两个北京自然日**:入队门槛要 ≥5 分,而贡献值按北京日封顶 3 分/日
// (`team-join-progress.ts` 的 `capByBeijingDay`),挤在同一天最多只能拿 3 分。
// ⭐ 分值**不由本文件写死** —— submit 的 contributionPoints 由 `ContributionRule` 按时长档位
// 权威计算(`contribution-calculator.ts`;请求体里传了也不作数)。直插版那两个 3.00 / 2.00
// 是手填字面量,跳过的正是这一段。
const ATTENDANCE_WINDOW = {
  startAt: new Date('2026-01-19T01:00:00.000Z'),
  endAt: new Date('2026-01-20T05:00:00.000Z'),
} as const;
const ATTENDANCE_DURATION_THRESHOLD_HOURS = 3;
const ATTENDANCE_POINTS_BELOW = 2;
const ATTENDANCE_POINTS_ABOVE = 3;

async function prepareTeamJoin(runtime: JourneyRuntime, memberId: string): Promise<string> {
  const prisma = journeyPrisma(runtime);
  // journey-direct-write: ambient — 活动创建要求承办组织为非根节点。
  const root = await prisma.organization.create({
    data: { name: '旅程一组织根', nodeTypeCode: 'general', status: 'ACTIVE' },
  });
  // journey-direct-write: ambient — 同上
  const target = await prisma.organization.create({
    data: { name: '旅程一目标队', nodeTypeCode: 'general', status: 'ACTIVE', parentId: root.id },
  });
  // journey-direct-write: ambient — 入队周期属配置底座
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

  // journey-direct-write: ambient — 活动类型属于配置底座。
  const activityType = await prisma.dictType.create({
    data: { code: 'activity_type', label: '活动类型' },
  });
  // journey-direct-write: ambient — 同上。
  await prisma.dictItem.create({
    data: { typeId: activityType.id, code: 'journey-training', label: '旅程训练' },
  });
  // 档位使两条记录分别取到 3 分与 2 分。`contribution-rules` 虽有 admin 写入口,
  // 但它不在「建单 → 一审 → 终审」这条被验链上,故按配置底座计。
  // journey-direct-write: ambient — 贡献值规则属配置底座
  await prisma.contributionRule.create({
    data: {
      activityTypeCode: 'journey-training',
      attendanceRoleCode: 'member',
      durationThreshold: String(ATTENDANCE_DURATION_THRESHOLD_HOURS),
      pointsBelow: String(ATTENDANCE_POINTS_BELOW),
      pointsAbove: String(ATTENDANCE_POINTS_ABOVE),
      status: 'ACTIVE',
    },
  });

  const reviewers = await prepareSettlementReviewers(runtime);
  await produceJourneyNativeContribution(runtime, {
    organizationId: target.id,
    activityTypeCode: 'journey-training',
    memberId,
    ...reviewers,
    sessions: [
      {
        startAt: ATTENDANCE_WINDOW.startAt.toISOString(),
        endAt: '2026-01-19T03:00:00.000Z',
        expectedPoints: ATTENDANCE_POINTS_BELOW,
      },
      {
        startAt: '2026-01-20T01:00:00.000Z',
        endAt: ATTENDANCE_WINDOW.endAt.toISOString(),
        expectedPoints: ATTENDANCE_POINTS_ABOVE,
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
