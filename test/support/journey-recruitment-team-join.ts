import { Role } from '@prisma/client';
import request from 'supertest';

import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { AppMeTeamJoinService } from '../../src/modules/team-join/team-join-applications.app.service';
import { TeamJoinApplicationsService } from '../../src/modules/team-join/team-join-applications.service';
import { TeamJoinEnrollmentService } from '../../src/modules/team-join/team-join-enrollment.service';
import { loginAs } from '../fixtures/auth.fixture';
import { seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { devStubOcrImage, VALID_PNG_IMAGE } from '../helpers/file-fixtures';
import { httpServer } from '../helpers/http-server';
import { issuePhoneVerificationToken } from './journey-recruitment-identity';
import { type JourneyRuntime, journeyAdmin, journeyPrisma } from './journey-runtime';

const RECRUITMENT_CYCLES = '/api/admin/v1/recruitment/cycles';
const RECRUITMENT_APPLICATIONS = '/api/open/v1/recruitment/applications';
const CERTIFICATE_CLAIMS = '/api/open/v1/recruitment/certificate-claims';
const ADMIN_RECRUITMENT = '/api/admin/v1/recruitment';
const ADMIN_ACTIVITIES = '/api/admin/v1/activities';
const ATTENDANCE_SHEETS = '/api/admin/v1/attendance-sheets';
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

// ── 考勤审核链的两个审核身份(P2-12b)──────────────────────────────────────
//
// 一审 / 终审是**两个不同角色的两个人**,这不是排版偏好 —— 审核链自己就这么钉的:
//   submitter == 审核人 → 22073 / 22074(SELF_{FIRST,FINAL}_REVIEW_FORBIDDEN;SUPER_ADMIN 亦拒)
//   一审人   == 终审人 → 22075(SAME_REVIEWER_FORBIDDEN)
// 故本 journey 用三个身份:submitter = journey SUPER_ADMIN(短路持 create 码)、
// 一审 = `attendance-first-reviewer`、终审 = `attendance-final-reviewer`。后两个是
// `prisma/seed.ts` 里的**真生产角色码**,不是本文件发明的测试角色;换一个身份走完全程
// 一条 22075 都碰不到 = 没测审核链的角色隔离。
interface AttendanceReviewers {
  readonly firstAuth: string;
  readonly finalAuth: string;
}

// 码集沿 seed.ts 两处生产定义(`ACTIVITY_RESPONSIBILITY_WORKFLOW_ROLE_SEED` /
// `seedAttendanceFinalReviewerRole`),去掉两条 `activity.settlement-*-review.record`——
// 它们不在 biz-admin fixture 的 `BIZ_PERMISSIONS` 里(建不出 Permission 行),本链也一条不走。
// 少绑不会让链假绿:少了谁,对应那步当场 30100。
const FIRST_REVIEWER_PERMISSION_CODES = [
  'attendance.read.sheet',
  'attendance.approve.sheet',
  'attendance.reject.sheet',
  'attendance.return.sheet',
] as const;
const FINAL_REVIEWER_PERMISSION_CODES = [
  'attendance.read.sheet',
  'attendance.final-approve.sheet',
  'attendance.final-reject.sheet',
  'attendance.final-return.sheet',
  'attendance.reopen.sheet',
] as const;

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

async function prepareAttendanceReviewers(runtime: JourneyRuntime): Promise<AttendanceReviewers> {
  // 两个审核角色要绑的那几条业务面 Permission 行的既有唯一夹具来源(幂等)。
  await seedBizAdminPermissionsAndRole(runtime.app);
  const firstAuth = await grantWorkflowReviewerRole(runtime, {
    username: 'journey-attendance-first',
    roleCode: 'attendance-first-reviewer',
    displayName: '考勤一审员',
    permissionCodes: FIRST_REVIEWER_PERMISSION_CODES,
  });
  const finalAuth = await grantWorkflowReviewerRole(runtime, {
    username: 'journey-attendance-final',
    roleCode: 'attendance-final-reviewer',
    displayName: '考勤终审员',
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
const EXPECTED_CONTRIBUTION_TOTAL = ATTENDANCE_POINTS_BELOW + ATTENDANCE_POINTS_ABOVE;

/**
 * 贡献值走**真考勤审核链**:建单 → 一审 → 终审,三段各是真 HTTP + 真身份。
 *
 * 立项(P2-12b)前这里是直插 `statusCode: 'approved'` 的 sheet + records,于是整条审核链
 * 在 journey 里一次都没跑过;而入队门槛恒按 approved 考勤算
 * (`team-join-progress.ts` 的 `approvedRecordsWhere`)——「考勤链产出的 approved」与
 * 「直插的 approved」是不是同一件事,当时无人证明。
 */
async function produceContributionViaAttendanceChain(
  runtime: JourneyRuntime,
  input: { activityId: string; memberId: string; reviewers: AttendanceReviewers },
): Promise<void> {
  const prisma = journeyPrisma(runtime);
  const records = [
    // 4h > 档位 ⇒ 取 pointsAbove(3 分);北京 1-20
    {
      memberId: input.memberId,
      roleCode: 'member',
      checkInAt: '2026-01-20T01:00:00.000Z',
      checkOutAt: '2026-01-20T05:00:00.000Z',
      attendanceStatusCode: 'present',
    },
    // 2h ≤ 档位 ⇒ 取 pointsBelow(2 分);北京 1-19
    {
      memberId: input.memberId,
      roleCode: 'member',
      checkInAt: '2026-01-19T01:00:00.000Z',
      checkOutAt: '2026-01-19T03:00:00.000Z',
      attendanceStatusCode: 'present',
    },
  ];

  const submitted = await request(httpServer(runtime.app))
    .post(`${ADMIN_ACTIVITIES}/${input.activityId}/attendance-sheets`)
    .set('Authorization', runtime.adminAuth)
    .send({ records });
  requireStatus(submitted, 201, '提交考勤单据');
  const sheetId = String(submitted.body.data?.id ?? '');
  if (!sheetId) throw new Error('提交考勤单据未返回 id');
  if (submitted.body.data?.statusCode !== 'pending') {
    throw new Error(`提交考勤单据未进入 pending: ${JSON.stringify(submitted.body)}`);
  }

  // 自证①:预填分真的由 ContributionRule 算出来了。无匹配规则时 calculator **保守返 0
  // 且不报错**(`computePrefilledPoints` 的 `if (!chosen) return 0`),症状会一路漂到几十行
  // 之后的「入队门槛贡献值不足」,读起来像门槛口径变了。这里当场钉死。
  const prefilled = await prisma.attendanceRecord.findMany({
    where: { sheetId, deletedAt: null },
    select: { contributionPoints: true },
  });
  const prefilledTotal = prefilled.reduce((sum, row) => sum + Number(row.contributionPoints), 0);
  if (prefilled.length !== records.length || prefilledTotal !== EXPECTED_CONTRIBUTION_TOTAL) {
    throw new Error(
      `考勤单据预填分不符:期望 ${records.length} 条合计 ${EXPECTED_CONTRIBUTION_TOTAL},` +
        `实得 ${prefilled.length} 条合计 ${prefilledTotal} —— ` +
        'ContributionRule 没匹配上时 calculator 静默返 0,不会自己报错',
    );
  }

  const firstApproved = await request(httpServer(runtime.app))
    .patch(`${ATTENDANCE_SHEETS}/${sheetId}/approve`)
    .set('Authorization', input.reviewers.firstAuth)
    .send({ reviewNote: '旅程一考勤一审通过' });
  requireStatus(firstApproved, 200, '考勤一审');
  if (firstApproved.body.data?.statusCode !== 'pending_final_review') {
    throw new Error(`考勤一审未进入 pending_final_review: ${JSON.stringify(firstApproved.body)}`);
  }

  const finalApproved = await request(httpServer(runtime.app))
    .patch(`${ATTENDANCE_SHEETS}/${sheetId}/final-approve`)
    .set('Authorization', input.reviewers.finalAuth)
    .send({ finalReviewNote: '旅程一考勤终审通过' });
  requireStatus(finalApproved, 200, '考勤终审');
  if (finalApproved.body.data?.statusCode !== 'approved') {
    throw new Error(`考勤终审未进入 approved: ${JSON.stringify(finalApproved.body)}`);
  }

  // 自证②:三段责任真的落在**三个不同 user** 上。三个字段都非空且两两不等,才排除
  // 「同一身份走完全程」—— 那种走法碰不到 22074 / 22075,而单据终态长得一模一样。
  const sheet = await prisma.attendanceSheet.findUniqueOrThrow({
    where: { id: sheetId },
    select: { submitterUserId: true, reviewerUserId: true, finalReviewerUserId: true },
  });
  const actors = [sheet.submitterUserId, sheet.reviewerUserId, sheet.finalReviewerUserId];
  if (actors.some((actor) => !actor) || new Set(actors).size !== 3) {
    throw new Error(
      `考勤审核链三段责任人未落在三个不同身份上:${JSON.stringify(sheet)} —— ` +
        '同一身份走完全程等于没测角色隔离',
    );
  }
}

async function prepareTeamJoin(runtime: JourneyRuntime, memberId: string): Promise<string> {
  const prisma = journeyPrisma(runtime);
  // journey-direct-write: ambient — 同上
  const target = await prisma.organization.create({
    data: { name: '旅程一目标队', nodeTypeCode: 'general', status: 'ACTIVE' },
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

  // 入队贡献值是已完成活动的历史事实。活动时间窗跨 1-19 / 1-20 两天 —— 考勤记录必须落在
  // 活动窗 ± `ATTENDANCE_WINDOW_TOLERANCE_HOURS`(默认 2h)内,否则 submit 直接
  // 22042 ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW;而封顶要求两条记录分属两个北京日。
  // journey-direct-write: ambient — 活动本体属发布链
  const activity = await prisma.activity.create({
    data: {
      title: '旅程一贡献前置活动',
      activityTypeCode: 'journey-training',
      organizationId: target.id,
      startAt: ATTENDANCE_WINDOW.startAt,
      endAt: ATTENDANCE_WINDOW.endAt,
      location: '旅程测试地点',
      statusCode: 'completed',
    },
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

  // journey-direct-write: mid-chain-start — 属被验链、有 API,但刻意从 approved 中间态起步:凑贡献值过入队门槛,建单/一审/终审三步不在本 journey 声称验证的范围内
  const sheet = await prisma.attendanceSheet.create({
    data: {
      activityId: activity.id,
      submitterUserId: journeyAdmin(runtime).id,
      statusCode: 'approved',
    },
  });
  // journey-direct-write: mid-chain-start — 同上,记录侧
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
        checkOutAt: new Date('2026-01-19T03:00:00.000Z'),
        serviceHours: '2.00',
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
