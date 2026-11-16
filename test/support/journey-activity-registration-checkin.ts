import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';

import type { JwtConfig } from '../../src/config/jwt.config';
import { signAttendanceQrToken } from '../../src/modules/attendances/attendance-qr-token';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { journeyPrisma, type JourneyRuntime } from './journey-runtime';
import { memberIdentityData } from '../helpers/member-identity.fixture';

const MANAGED_ACTIVITIES = '/api/app/v1/my/managed-activities';
const CHECK_IN_LOCATION = { longitude: 114, latitude: 22, accuracy: 5 };

/**
 * 本旅程证明真实报名到新版打卡，不把独立结算 E2E 的通过冒充整条旅程已串联。
 */
export const JOURNEY_2_KNOWN_GAP =
  '本旅程已到真实 AttendancePunchEvent；签退、结算和贡献入账尚未在本旅程串联验证';
export const JOURNEY_2_REVIEW_TRIGGER = '将既有签退、结算和账本入口串入同一真实旅程时复核';

interface JourneyHttpResponse {
  readonly status: number;
  readonly body: { code?: number; message?: string; data?: unknown };
}

function requireStatus(response: JourneyHttpResponse, expected: number, action: string): void {
  if (response.status !== expected) {
    throw new Error(
      `${action} expected HTTP ${expected}, got ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
}

async function prepareActivityRegistrationFixture(runtime: JourneyRuntime): Promise<{
  readonly applicantAuth: string;
  readonly ownerAuth: string;
  readonly organizationId: string;
  readonly activityTypeCode: string;
}> {
  const prisma = journeyPrisma(runtime);
  // Login DTO 限 username ≤32；UUID 只取紧凑前缀，仍足以隔离本 spec 的夹具。
  const tag = `journey2-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const nodeTypeCode = `${tag}-node`;
  const activityTypeCode = `${tag}-type`;

  const [nodeType, activityType] = await Promise.all([
    // journey-direct-write: ambient — 字典底座,不属于「报名 → 签到」这条被验链
    prisma.dictType.create({
      data: { code: 'node_type', label: '旅程二组织节点类型' },
      select: { id: true },
    }),
    // journey-direct-write: ambient — 同上
    prisma.dictType.create({
      data: { code: 'activity_type', label: '旅程二活动类型' },
      select: { id: true },
    }),
  ]);
  await Promise.all([
    // journey-direct-write: ambient — 同上
    prisma.dictItem.create({
      data: { typeId: nodeType.id, code: nodeTypeCode, label: '旅程二组织节点' },
    }),
    // journey-direct-write: ambient — 同上
    prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '旅程二活动类型' },
    }),
  ]);

  // Admin create 必须落在非根节点；组织树本身仍属于 test/support 的前置夹具。
  // journey-direct-write: ambient — 组织树底座,不属于被验链
  const root = await prisma.organization.create({
    data: { name: `${tag} 根节点`, nodeTypeCode },
    select: { id: true },
  });
  // journey-direct-write: ambient — 同上
  const organization = await prisma.organization.create({
    data: { name: `${tag} 承办队`, nodeTypeCode, parentId: root.id },
    select: { id: true },
  });

  const user = await createTestUser(runtime.app, {
    username: `${tag}-applicant`,
    role: Role.USER,
  });
  // journey-direct-write: ambient — 队员建档属招新链(另有 journey 验),不是本链
  const member = await prisma.member.create({
    data: {
      memberNo: `${tag}-member`,
      ...memberIdentityData('旅程二报名队员'),
      status: MemberStatus.ACTIVE,
    },
    select: { id: true },
  });
  // journey-direct-write: ambient — 账号与队员关联,同属招新链
  await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });

  const ownerUser = await createTestUser(runtime.app, {
    username: `${tag}-owner`,
    role: Role.SUPER_ADMIN,
  });
  // journey-direct-write: ambient — 发起人的有效身份和组织任职是活动创建的前置资格。
  const owner = await prisma.member.create({
    data: {
      memberNo: `${tag}-owner`,
      ...memberIdentityData('旅程二活动负责人'),
      gradeCode: 'level-1',
      status: MemberStatus.ACTIVE,
    },
  });
  // journey-direct-write: ambient — 同上。
  await prisma.user.update({ where: { id: ownerUser.id }, data: { memberId: owner.id } });
  // journey-direct-write: ambient — 同上。
  await prisma.memberOrganizationMembership.create({
    data: { memberId: owner.id, organizationId: organization.id },
  });
  // 系统责任角色是权限底座；活动 owner assignment/binding 仍由真实发布事务产生。
  await seedActivityResponsibilitySystemRoles(runtime.app);

  return {
    applicantAuth: (await loginAs(runtime.app, user.username)).authHeader,
    ownerAuth: (await loginAs(runtime.app, ownerUser.username)).authHeader,
    organizationId: organization.id,
    activityTypeCode,
  };
}

export interface ActivityRegistrationCheckInJourneyResult {
  readonly activityId: string;
  readonly registrationId: string;
  readonly checkInId: string;
  readonly checkInRegistrationId: string;
  readonly replayCheckInId: string;
  readonly checkInCount: number;
  readonly knownGap: string;
  readonly reviewTrigger: string;
}

/**
 * 金五条②：专业草稿 → 独立发布审核 → 报名分配 → 签发 QR → 本人打卡。
 *
 * 造数仅限身份、组织和权限底座；活动、审核、报名、凭证和打卡均走真实 HTTP。
 */
export async function runActivityRegistrationCheckInJourney(
  runtime: JourneyRuntime,
): Promise<ActivityRegistrationCheckInJourneyResult> {
  const fixture = await prepareActivityRegistrationFixture(runtime);
  const now = Date.now();
  const startAt = new Date(now + 10 * 60_000).toISOString();
  const endAt = new Date(now + 70 * 60_000).toISOString();
  const created = await request(httpServer(runtime.app))
    .post(`${MANAGED_ACTIVITIES}/professional`)
    .set('Authorization', fixture.ownerAuth)
    .send({
      operationKey: `journey-2-create-${randomUUID()}`,
      title: '旅程二活动报名签到',
      activityTypeCode: fixture.activityTypeCode,
      allocationModeCode: 'first_come',
      metricSelection: { metricRequirementCode: 'not_required', metricSetPointer: null },
      organizationId: fixture.organizationId,
      startAt,
      endAt,
      registrationDeadline: new Date(now + 5 * 60_000).toISOString(),
      location: '旅程二真实签到点',
      isPublicRegistration: true,
      requiresInsurance: false,
      capacity: 10,
      sessions: [
        {
          session: {
            code: 'journey',
            name: '旅程场次',
            startAt,
            endAt,
            locationText: '旅程二真实签到点',
            longitude: CHECK_IN_LOCATION.longitude,
            latitude: CHECK_IN_LOCATION.latitude,
            capacity: 10,
            checkInOpenAt: new Date(now - 5 * 60_000).toISOString(),
            checkInCloseAt: new Date(now + 30 * 60_000).toISOString(),
            checkOutOpenAt: new Date(now + 40 * 60_000).toISOString(),
            checkOutCloseAt: endAt,
            locationRequired: true,
            radiusMeters: 200,
          },
          positions: [],
        },
      ],
    });
  requireStatus(created, 201, '创建旅程二活动');
  const activityId = String(
    (created.body.data as { activity?: { activityId?: string } } | undefined)?.activity
      ?.activityId ?? '',
  );
  if (!activityId) throw new Error('创建旅程二活动未返回 id');

  const submittedReview = await request(httpServer(runtime.app))
    .post(`${MANAGED_ACTIVITIES}/${activityId}/publish-reviews`)
    .set('Authorization', fixture.ownerAuth)
    .send({ operationKey: `journey-2-publish-${randomUUID()}`, confirmation: true });
  requireStatus(submittedReview, 200, '提交旅程二发布审核');
  const reviewId = String(submittedReview.body.data?.id ?? '');
  if (!reviewId) throw new Error('发布审核未返回 id');
  const published = await request(httpServer(runtime.app))
    .post(`/api/admin/v1/activity-publish-reviews/${reviewId}/approve`)
    .set('Authorization', runtime.adminAuth)
    .send({
      requiresInsuranceConfirmed: true,
      operationKey: `journey-2-approve-${randomUUID()}`,
    });
  requireStatus(published, 200, '发布旅程二活动');
  if ((published.body.data as { status?: string } | undefined)?.status !== 'approved') {
    throw new Error(`旅程二活动未发布: ${JSON.stringify(published.body)}`);
  }
  const prisma = journeyPrisma(runtime);
  const session = await prisma.activitySession.findFirstOrThrow({
    where: { activityId, code: 'journey' },
    select: { id: true },
  });

  const submitted = await request(httpServer(runtime.app))
    .post(`/api/app/v1/activities/${activityId}/registrations`)
    .set('Authorization', fixture.applicantAuth)
    .send({
      operationKey: `journey-2-registration-${randomUUID()}`,
      formVersion: null,
      answers: [],
      preferences: [{ sessionId: session.id, positionIds: [] }],
    });
  requireStatus(submitted, 201, '提交旅程二报名');
  const registrationId = String(
    (submitted.body.data as { registrationId?: string } | undefined)?.registrationId ?? '',
  );
  if (!registrationId) throw new Error('提交旅程二报名未返回 registrationId');

  const identity = await prisma.activityParticipationIdentity.findFirstOrThrow({
    where: { registrationId, sessionId: session.id },
    select: { id: true, currentStatusCode: true, populationIncluded: true },
  });
  if (identity.currentStatusCode !== 'pass' || !identity.populationIncluded) {
    const buckets = await prisma.activityCapacityBucket.findMany({
      where: { activityId },
      select: { scopeTypeCode: true, capacity: true, occupied: true },
    });
    throw new Error(
      `旅程二报名未生效: ${identity.currentStatusCode}, population=${identity.populationIncluded}, buckets=${JSON.stringify(buckets)}`,
    );
  }

  const issued = await request(httpServer(runtime.app))
    .post(
      `${MANAGED_ACTIVITIES}/${activityId}/sessions/${session.id}/qr-credentials/check-in/issue`,
    )
    .set('Authorization', fixture.ownerAuth)
    .send({ operationKey: `journey-2-qr-${randomUUID()}` });
  requireStatus(issued, 201, '签发旅程二签到凭证');
  const credential = await prisma.attendanceQrCredential.findUniqueOrThrow({
    where: { id: String(issued.body.data?.credentialId ?? '') },
  });
  // 还原真实已签发凭证的扫码载荷；不直插凭证、打卡事件或结算事实。
  const qrToken = signAttendanceQrToken(
    {
      credentialId: credential.id,
      activityId,
      sessionId: session.id,
      actionCode: 'check_in',
      credentialVersion: credential.credentialVersion,
      validFrom: credential.validFrom,
      validUntil: credential.validUntil,
    },
    runtime.app.get(ConfigService).getOrThrow<JwtConfig>('jwt').secret,
  );
  const checkInPath = `/api/app/v1/activities/${activityId}/sessions/${session.id}/punches/check-in`;
  const punch = {
    ...CHECK_IN_LOCATION,
    qrToken,
    eventKey: `journey-2-punch-${randomUUID()}`,
  };
  const checkedIn = await request(httpServer(runtime.app))
    .post(checkInPath)
    .set('Authorization', fixture.applicantAuth)
    .send(punch);
  requireStatus(checkedIn, 201, '旅程二本人签到');
  const checkInId = String(checkedIn.body.data?.eventId ?? '');
  if (!checkInId) throw new Error('旅程二签到未返回 eventId');
  const event = await prisma.attendancePunchEvent.findUniqueOrThrow({
    where: { id: checkInId },
    select: { participationIdentity: { select: { registrationId: true } } },
  });
  const checkInRegistrationId = event.participationIdentity.registrationId;

  // 真 HTTP 重试而非 fixture 查询：同一报名的首次与合法重试都必须返回当前证据。
  const replayed = await request(httpServer(runtime.app))
    .post(checkInPath)
    .set('Authorization', fixture.applicantAuth)
    .send(punch);
  requireStatus(replayed, 201, '旅程二签到重试');
  const replayCheckInId = String(replayed.body.data?.eventId ?? '');

  const checkInCount = await prisma.attendancePunchEvent.count({
    where: { participationIdentityId: identity.id },
  });
  return {
    activityId,
    registrationId,
    checkInId,
    checkInRegistrationId,
    replayCheckInId,
    checkInCount,
    knownGap: JOURNEY_2_KNOWN_GAP,
    reviewTrigger: JOURNEY_2_REVIEW_TRIGGER,
  };
}
