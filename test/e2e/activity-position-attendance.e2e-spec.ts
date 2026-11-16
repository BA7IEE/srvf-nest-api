import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import type { JwtConfig } from '../../src/config/jwt.config';
import { PrismaService } from '../../src/database/prisma.service';
import { EvidenceSealService } from '../../src/modules/activities/evidence-seal.service';
import { AttendancePunchCommandService } from '../../src/modules/attendances/attendance-punch-command.service';
import {
  digestAttendanceQrToken,
  signAttendanceQrToken,
} from '../../src/modules/attendances/attendance-qr-token';
import { loginAs } from '../fixtures/auth.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// Preserve position-window and role-prefill acceptance on native facts.
// Native missing checkout is unresolved: it must not be invented from endAt.
const BASE = new Date('2020-07-01T00:00:00Z');
const at = (hours: number) => new Date(BASE.getTime() + hours * 3_600_000);
const META = { requestId: 'native-position-acceptance', ip: null, ua: null };
type Action = 'check_in' | 'check_out';
interface Fixture {
  activityId: string;
  activityTypeCode: string;
  sessionId: string;
  positionId: string;
  identityId: string;
  tokens: Record<Action, string>;
}

describe('Native position attendance wiring — migrated F4 acceptance', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: CurrentUserPayload;
  let ownerAuth: string;
  let participantId: string;
  let participantAuth: string;
  let organizationId: string;
  let sequence = 0;
  const previousGate = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;

  function clock(hours: number) {
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
    jest.setSystemTime(at(hours));
  }
  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    const ownerUser = await createTestUser(app, {
      username: 'native-position-owner',
      role: Role.SUPER_ADMIN,
    });
    const ownerMember = await prisma.member.create({
      data: {
        memberNo: 'NATIVE-POSITION-OWNER',
        ...memberIdentityData('岗位负责人'),
        gradeCode: 'level-2',
      },
    });
    owner = await prisma.user.update({
      where: { id: ownerUser.id },
      data: { memberId: ownerMember.id },
      select: { id: true, username: true, memberId: true, role: true, status: true },
    });
    ownerAuth = (await loginAs(app, owner.username)).authHeader;
    const user = await createTestUser(app, { username: 'native-position-participant' });
    participantId = (
      await prisma.member.create({
        data: {
          memberNo: 'NATIVE-POSITION-MEMBER',
          ...memberIdentityData('岗位参加者'),
          gradeCode: 'level-2',
        },
      })
    ).id;
    await prisma.user.update({ where: { id: user.id }, data: { memberId: participantId } });
    participantAuth = (await loginAs(app, user.username)).authHeader;
    organizationId = (
      await prisma.organization.create({ data: { name: '岗位验收', nodeTypeCode: 'team' } })
    ).id;
  });
  beforeEach(() => clock(2));
  afterEach(() => jest.useRealTimers());
  afterAll(async () => {
    jest.useRealTimers();
    try {
      await app?.close();
    } finally {
      if (previousGate === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousGate;
    }
  });

  async function fixture(): Promise<Fixture> {
    const tag = `native-position-${++sequence}`;
    const activity = await prisma.activity.create({
      data: {
        title: tag,
        activityTypeCode: tag,
        organizationId,
        startAt: BASE,
        endAt: at(12),
        location: '岗位',
        statusCode: 'published',
      },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: tag,
        name: tag,
        startAt: BASE,
        endAt: at(12),
        locationText: '岗位',
        statusCode: 'scheduled',
        locationRequired: false,
        locationPolicySourceCode: 'session',
        checkInOpenAt: BASE,
        checkInCloseAt: at(11),
        checkOutOpenAt: BASE,
        checkOutCloseAt: at(12),
      },
    });
    const slot = await prisma.activitySessionPosition.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        code: tag,
        name: tag,
        attendanceRoleCode: 'instructor',
        startAt: at(1),
        endAt: at(3),
      },
    });
    const registration = await prisma.activityRegistration.create({
      data: { activityId: activity.id, memberId: participantId, statusCode: 'pass' },
    });
    const identity = await prisma.activityParticipationIdentity.create({
      data: {
        activityId: activity.id,
        sessionId: session.id,
        memberId: participantId,
        registrationId: registration.id,
        currentPositionId: slot.id,
        currentStatusCode: 'pass',
        populationIncluded: true,
      },
    });
    await prisma.activityEvidenceState.create({ data: { activityId: activity.id } });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: owner.memberId!,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        source: 'publish',
        assignedByUserId: owner.id,
      },
    });
    const tokens = {} as Record<Action, string>;
    for (const actionCode of ['check_in', 'check_out'] as const) {
      const payload = {
        credentialId: randomUUID(),
        activityId: activity.id,
        sessionId: session.id,
        actionCode,
        credentialVersion: 1,
        validFrom: BASE,
        validUntil: at(12),
      };
      tokens[actionCode] = signAttendanceQrToken(
        payload,
        app.get(ConfigService).getOrThrow<JwtConfig>('jwt').secret,
      );
      await prisma.attendanceQrCredential.create({
        data: {
          id: payload.credentialId,
          activityId: activity.id,
          sessionId: session.id,
          actionCode,
          credentialVersion: 1,
          validFrom: BASE,
          validUntil: at(12),
          statusCode: 'active',
          tokenDigest: digestAttendanceQrToken(tokens[actionCode]),
          signingKeyVersion: 0,
          issuedAt: BASE,
          issuedByUserId: owner.id,
        },
      });
    }
    return {
      activityId: activity.id,
      activityTypeCode: tag,
      sessionId: session.id,
      positionId: slot.id,
      identityId: identity.id,
      tokens,
    };
  }
  const punch = (f: Fixture, action: Action) =>
    request(httpServer(app))
      .post(
        `/api/app/v1/activities/${f.activityId}/sessions/${f.sessionId}/punches/${action === 'check_in' ? 'check-in' : 'check-out'}`,
      )
      .set('Authorization', participantAuth)
      .send({ qrToken: f.tokens[action], eventKey: `${f.activityId}:${action}` });
  async function snapshot(f: Fixture) {
    return {
      events: await prisma.attendancePunchEvent.findMany({
        where: { activityId: f.activityId },
        orderBy: { id: 'asc' },
      }),
      segments: await prisma.participantServiceSegmentRevision.findMany({
        where: { participationIdentityId: f.identityId },
        orderBy: { id: 'asc' },
      }),
      evidence: await prisma.activityEvidenceState.findUnique({
        where: { activityId: f.activityId },
      }),
      audit: await prisma.auditLog.count({ where: { resourceId: f.activityId } }),
      intents: await prisma.notificationOutboxIntent.count(),
    };
  }

  it('活动/场次窗内但岗位窗外拒绝；岗位窗内真实 QR 签到保留岗位锚点', async () => {
    const f = await fixture();
    await prisma.activitySessionPosition.update({
      where: { id: f.positionId },
      data: { startAt: at(5), endAt: at(6) },
    });
    const before = await snapshot(f);
    expectBizError(await punch(f, 'check_in'), BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW);
    expect(await snapshot(f)).toEqual(before);
    await prisma.activitySessionPosition.update({
      where: { id: f.positionId },
      data: { startAt: at(1), endAt: at(3) },
    });
    const response = await punch(f, 'check_in').expect(201);
    const event = await prisma.attendancePunchEvent.findUniqueOrThrow({
      where: { id: response.body.data.eventId },
    });
    expect(event).toMatchObject({
      positionId: f.positionId,
      participationIdentityId: f.identityId,
      memberId: participantId,
    });
  });

  it('导入写核不能以场次范围代替岗位范围，失败事件/投影/审计均零写', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    await expect(
      app.get(AttendancePunchCommandService).managedPunch({
        activityId: f.activityId,
        sessionId: f.sessionId,
        participationIdentityId: f.identityId,
        memberCredential: null,
        actionCode: 'check_in',
        sourceCode: 'import',
        eventKey: `${f.activityId}:import`,
        reason: '岗位时段验收',
        deviceId: null,
        longitude: null,
        latitude: null,
        accuracy: null,
        occurredAt: at(0.5),
        currentUser: owner,
        auditMeta: META,
      }),
    ).rejects.toMatchObject({ biz: BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW });
    expect(await snapshot(f)).toEqual(before);
  });

  it('真实成对打卡经封场/生成/送审按岗位角色预填贡献，不能回落 member 规则', async () => {
    const f = await fixture();
    await prisma.contributionRule.createMany({
      data: [
        {
          activityTypeCode: f.activityTypeCode,
          attendanceRoleCode: 'instructor',
          pointsBelow: 2.5,
          status: 'ACTIVE',
        },
        {
          activityTypeCode: f.activityTypeCode,
          attendanceRoleCode: 'member',
          pointsBelow: 0.5,
          status: 'ACTIVE',
        },
      ],
    });
    await punch(f, 'check_in').expect(201);
    clock(2.5);
    await punch(f, 'check_out').expect(201);
    // Seal uses PostgreSQL's clock; return the HTTP submit clock to the same
    // real, post-activity time instead of pretending the session is still live.
    jest.useRealTimers();
    const seal = await app.get(EvidenceSealService).seal(f.activityId, owner, META);
    const base = `/api/app/v1/my/managed-activities/${f.activityId}/settlement`;
    const generated = await request(httpServer(app))
      .post(`${base}/generate`)
      .set('Authorization', ownerAuth)
      .send({ operationKey: `${f.activityId}:generate` })
      .expect(200);
    const items = await request(httpServer(app))
      .get(`${base}/items`)
      .set('Authorization', ownerAuth)
      .expect(200);
    expect(items.body.data.items).toHaveLength(1);
    expect(items.body.data.items[0]).toMatchObject({
      identityId: f.identityId,
      calculatedServiceHours: 0.5,
      calculatedContributionPoints: 2.5,
    });
    const submitted = await request(httpServer(app))
      .post(`${base}/submit`)
      .set('Authorization', ownerAuth)
      .send({
        operationKey: `${f.activityId}:submit`,
        evidenceSealId: seal.sealId,
        expectedDraftVersion: generated.body.data.settlementVersion,
        confirmation: true,
      })
      .expect(200);
    const result = await prisma.participantSettlementResultRevision.findFirstOrThrow({
      where: {
        settlementVersionId: submitted.body.data.settlementVersionId,
        participationIdentityId: f.identityId,
      },
    });
    expect(Number(result.calculatedContributionPoints)).toBe(2.5);
    expect(Number(result.recognizedContributionPoints)).toBe(2.5);
    expect(await prisma.attendanceRecord.count()).toBe(0);
    expect(
      await prisma.participationLedgerEntry.count({ where: { activityId: f.activityId } }),
    ).toBe(0);
  });

  it('未签退不再自动补到岗位 endAt；开放服务段阻断封场且原事实不变', async () => {
    const f = await fixture();
    await punch(f, 'check_in').expect(201);
    const before = await snapshot(f);
    await expect(
      app.get(EvidenceSealService).seal(f.activityId, owner, META),
    ).rejects.toMatchObject({ biz: BizCode.EVIDENCE_SEAL_OPEN_SEGMENT_EXISTS });
    expect(await snapshot(f)).toEqual(before);
    expect(await prisma.evidenceSeal.count({ where: { activityId: f.activityId } })).toBe(0);
    expect(
      await prisma.attendanceSettlementVersion.count({
        where: { settlementRun: { activityId: f.activityId } },
      }),
    ).toBe(0);
  });
});
