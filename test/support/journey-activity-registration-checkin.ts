import { randomUUID } from 'node:crypto';

import { MemberStatus, Role } from '@prisma/client';
import request from 'supertest';

import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { journeyPrisma, type JourneyRuntime } from './journey-runtime';

const ADMIN_ACTIVITIES = '/api/admin/v1/activities';
const CHECK_IN_LOCATION = { longitude: 114, latitude: 22, accuracy: 5 };

/**
 * 当前生产链没有 AttendancePunchEvent 的写入口；结算/账本读的是该事件，不能由 journey
 * 直接造数冒充已经打通。punch 生产入口合入 main 后，按此触发器扩展为全链版。
 */
export const JOURNEY_2_KNOWN_GAP =
  '结算到贡献值账本缺 AttendancePunchEvent 生产写入口，当前链路物理不可达';
export const JOURNEY_2_REVIEW_TRIGGER = 'punch 生产入口合入 main 时扩展为全链版';

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
  readonly organizationId: string;
  readonly activityTypeCode: string;
}> {
  const prisma = journeyPrisma(runtime);
  // Login DTO 限 username ≤32；UUID 只取紧凑前缀，仍足以隔离本 spec 的夹具。
  const tag = `journey2-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const nodeTypeCode = `${tag}-node`;
  const activityTypeCode = `${tag}-type`;

  const [nodeType, activityType] = await Promise.all([
    prisma.dictType.create({
      data: { code: 'node_type', label: '旅程二组织节点类型' },
      select: { id: true },
    }),
    prisma.dictType.create({
      data: { code: 'activity_type', label: '旅程二活动类型' },
      select: { id: true },
    }),
  ]);
  await Promise.all([
    prisma.dictItem.create({
      data: { typeId: nodeType.id, code: nodeTypeCode, label: '旅程二组织节点' },
    }),
    prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '旅程二活动类型' },
    }),
  ]);

  // Admin create 必须落在非根节点；组织树本身仍属于 test/support 的前置夹具。
  const root = await prisma.organization.create({
    data: { name: `${tag} 根节点`, nodeTypeCode },
    select: { id: true },
  });
  const organization = await prisma.organization.create({
    data: { name: `${tag} 承办队`, nodeTypeCode, parentId: root.id },
    select: { id: true },
  });

  const user = await createTestUser(runtime.app, {
    username: `${tag}-applicant`,
    role: Role.USER,
  });
  const member = await prisma.member.create({
    data: {
      memberNo: `${tag}-member`,
      displayName: '旅程二报名队员',
      status: MemberStatus.ACTIVE,
    },
    select: { id: true },
  });
  await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });

  return {
    applicantAuth: (await loginAs(runtime.app, user.username)).authHeader,
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
 * 金五条②当前真实部分链：活动 → 报名 → 审批 → ActivityCheckIn 打卡证据。
 *
 * 造数仅限字典、组织和用户前置事实；活动、报名、审批和签到均经生产 HTTP 路径推进。
 */
export async function runActivityRegistrationCheckInJourney(
  runtime: JourneyRuntime,
): Promise<ActivityRegistrationCheckInJourneyResult> {
  const fixture = await prepareActivityRegistrationFixture(runtime);
  const now = Date.now();
  const created = await request(httpServer(runtime.app))
    .post(ADMIN_ACTIVITIES)
    .set('Authorization', runtime.adminAuth)
    .send({
      title: '旅程二活动报名签到',
      activityTypeCode: fixture.activityTypeCode,
      allocationModeCode: 'first_come',
      organizationId: fixture.organizationId,
      startAt: new Date(now - 60_000).toISOString(),
      endAt: new Date(now + 60 * 60_000).toISOString(),
      registrationDeadline: new Date(now + 30 * 60_000).toISOString(),
      location: '旅程二真实签到点',
      isPublicRegistration: true,
      requiresInsurance: false,
      locationLongitude: CHECK_IN_LOCATION.longitude,
      locationLatitude: CHECK_IN_LOCATION.latitude,
    });
  requireStatus(created, 201, '创建旅程二活动');
  const activityId = String((created.body.data as { id?: string } | undefined)?.id ?? '');
  if (!activityId) throw new Error('创建旅程二活动未返回 id');

  const published = await request(httpServer(runtime.app))
    .patch(`${ADMIN_ACTIVITIES}/${activityId}/publish`)
    .set('Authorization', runtime.adminAuth)
    .send({ requiresInsuranceConfirmed: true });
  requireStatus(published, 200, '发布旅程二活动');
  if ((published.body.data as { statusCode?: string } | undefined)?.statusCode !== 'published') {
    throw new Error(`旅程二活动未发布: ${JSON.stringify(published.body)}`);
  }

  const submitted = await request(httpServer(runtime.app))
    .post(`/api/app/v1/activities/${activityId}/registrations`)
    .set('Authorization', fixture.applicantAuth)
    .send({
      operationKey: `journey-2-registration-${randomUUID()}`,
      formVersion: null,
      answers: [],
      preferences: [],
    });
  requireStatus(submitted, 201, '提交旅程二报名');
  const registrationId = String(
    (submitted.body.data as { registrationId?: string } | undefined)?.registrationId ?? '',
  );
  if (!registrationId) throw new Error('提交旅程二报名未返回 registrationId');

  const approved = await request(httpServer(runtime.app))
    .patch(`${ADMIN_ACTIVITIES}/${activityId}/registrations/${registrationId}/approve`)
    .set('Authorization', runtime.adminAuth)
    .send({ reviewNote: '旅程二审核通过' });
  requireStatus(approved, 200, '审核通过旅程二报名');
  if ((approved.body.data as { statusCode?: string } | undefined)?.statusCode !== 'pass') {
    throw new Error(`旅程二报名未进入 pass: ${JSON.stringify(approved.body)}`);
  }

  const checkInPath = `/api/app/v1/my/activities/${activityId}/check-in`;
  const checkedIn = await request(httpServer(runtime.app))
    .post(checkInPath)
    .set('Authorization', fixture.applicantAuth)
    .send(CHECK_IN_LOCATION);
  requireStatus(checkedIn, 200, '旅程二本人签到');
  const checkInId = String((checkedIn.body.data as { id?: string } | undefined)?.id ?? '');
  const checkInRegistrationId = String(
    (checkedIn.body.data as { registrationId?: string } | undefined)?.registrationId ?? '',
  );
  if (!checkInId || !checkInRegistrationId) {
    throw new Error(`旅程二签到未返回完整 ActivityCheckIn 证据: ${JSON.stringify(checkedIn.body)}`);
  }

  // 真 HTTP 重试而非 fixture 查询：同一报名的首次与合法重试都必须返回当前证据。
  const replayed = await request(httpServer(runtime.app))
    .post(checkInPath)
    .set('Authorization', fixture.applicantAuth)
    .send(CHECK_IN_LOCATION);
  requireStatus(replayed, 200, '旅程二签到重试');
  const replayCheckInId = String((replayed.body.data as { id?: string } | undefined)?.id ?? '');

  const checkInCount = await journeyPrisma(runtime).activityCheckIn.count({
    where: { registrationId, deletedAt: null },
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
