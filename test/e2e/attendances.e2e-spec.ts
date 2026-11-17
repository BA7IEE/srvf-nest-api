import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, Prisma, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { loginAs } from '../fixtures/auth.fixture';
import { grantBizAdminToUser, seedBizAdminPermissionsAndRole } from '../fixtures/biz-admin.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { expectBizError } from '../helpers/biz-code.assert';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';
import { createSettlementDraftFixture } from '../helpers/settlement-draft.fixture';
import { ACTIVITY_RESPONSIBILITY_WORKFLOW_PERMISSION_SEED } from '../../src/modules/permissions/permission-catalog';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import type { AppManagedActivityOnsiteParticipationReceiptDto } from '../../src/modules/activity-registrations/dto/app/app-onsite-participation.dto';
import { AttendancePunchCommandService } from '../../src/modules/attendances/attendance-punch-command.service';
import { CorrectionApplicationService } from '../../src/modules/activities/correction-application.service';
import { CorrectionAuditRecorder } from '../../src/modules/activities/correction-audit-recorder';
import { CORRECTION_CHANGE_SCHEMA_VERSION } from '../../src/modules/activities/correction-change-set';

const relativeIso = (yearOffset: number, suffix: string): string =>
  `${new Date().getUTCFullYear() + yearOffset}-${suffix}`;
const pastIso = (suffix: string): string => relativeIso(-1, suffix);
const futureIso = (suffix: string): string => relativeIso(2, suffix);
const earlierIso = (suffix: string): string => relativeIso(-2, suffix);

// Slow-4 T3(2026-06-11,评审稿 §8 / D-S4-4):管理端 10 端点入口切到 service 层 rbac.can(),
// 失败统一 RBAC_FORBIDDEN(30100)。`adminAuth` 在 beforeAll 全局 grant biz-admin,
// 业务断言零修改;细粒度判权矩阵另见 attendances-rbac-boundary.e2e-spec.ts。
//
// V2 第一阶段批次 3B attendances 模块 e2e。
// 覆盖 9 接口主成功 + 关键失败:
// - 权限边界 / DTO 白名单
// - 状态机 3 态(submit pending / approve approved / reject rejected)
// - 时间不重叠(R16 / Q-S15;同 memberId × [start, end) 左闭右开;跨 Sheet / 跨 Activity 全局)
// - serviceHours 自动计算 + 手填 + <=0 + > 跨度(D14 / D45 / D51 / D46)
// - registrationId 跨表 R23(registration.activityId === sheet.activityId)
// - approved / rejected 不可改 / 不可删(22040 / 22041)
// - previousSnapshot 后端自动生成 + version+1(R28 / Q-S16)
// - contributionPoints approved 前必填(R31 / 22072)
// - cancelled Activity 拒 submit(20122)
// - 队员端 /me/attendance-records:仅 approved Sheet 内 records(Q-A14)
// - USER 越权 → 不在结果集

describe('attendances 模块', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAuth: string;
  let submitterAuth: string;
  // 终态 scoped-authz PR9:第二身份专职终审 —— 自审禁止(submitter==终审人 → 22074)+
  // 同人默认禁止(一级 reviewer==终审人 → 22075)后,单人无法再走完 submit→approve→final 全程;
  // 摘码微刀(2026-07-03):biz-admin 不再持终审两码 → 终审人从 ADMIN+biz-admin 换成
  // SUPER_ADMIN(SA 兜底通路;仅换身份,业务断言零修改)。本 spec submit 用 submitterAuth、
  // 一级审用 adminAuth,
  // final-approve / final-reject 一律 finalAdminAuth(权限/约束矩阵见
  // attendances-final-review-authz.e2e-spec.ts + attendances-rbac-boundary.e2e-spec.ts)。
  let finalAdminAuth: string;
  let userWithMemberAuth: string;
  let nativeAuth: string;
  let nativeUserId: string;
  let nativeOwnerId: string;
  let nativeRoleId: string;
  let nativeOrganizationId: string;
  let nativeFirstReviewerId: string;
  let nativeFinalReviewerId: string;
  let nativeFinalAuth: string;
  const previousV11 = process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
  const previousInsuranceGate = process.env.INSURANCE_ENFORCEMENT_ENABLED;

  let memberAId: string;
  let memberBId: string;
  let memberCId: string;
  let otherMemberId: string;

  let activityId: string; // 主测试活动(published)
  let activityCancelledId: string; // 已取消活动

  let registrationAId: string; // memberA 在 activityId 的报名(用于 R23 正向)

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    process.env.INSURANCE_ENFORCEMENT_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);

    // 用户(权限边界只需 1 个已绑 member 的 USER)
    nativeFinalReviewerId = (
      await createTestUser(app, { username: 'att-su', role: Role.SUPER_ADMIN })
    ).id;
    const admin = await createTestUser(app, { username: 'att-adm', role: Role.ADMIN });
    const submitter = await createTestUser(app, {
      username: 'att-submitter',
      role: Role.ADMIN,
    });
    // PR9 第二身份专职终审;摘码微刀(2026-07-03)后为 SUPER_ADMIN(SA 兜底通路,见上方注释)
    nativeFirstReviewerId = (
      await createTestUser(app, { username: 'att-final-adm', role: Role.SUPER_ADMIN })
    ).id;
    await createTestUser(app, { username: 'att-user-with-mem', role: Role.USER });
    adminAuth = (await loginAs(app, 'att-adm')).authHeader;
    submitterAuth = (await loginAs(app, 'att-submitter')).authHeader;
    finalAdminAuth = (await loginAs(app, 'att-final-adm')).authHeader;
    nativeFinalAuth = (await loginAs(app, 'att-su')).authHeader;
    userWithMemberAuth = (await loginAs(app, 'att-user-with-mem')).authHeader;

    // Slow-4 T3:seed 业务面码 + biz-admin;给 att-adm 全局 grant(沿 org e2e 范式;
    // att-final-adm 是 SA 走短路,不 grant —— biz-admin 已无终审两码,grant 也无用)
    const bizSeed = await seedBizAdminPermissionsAndRole(app);
    await grantBizAdminToUser(app, admin.id, bizSeed.bizAdminRoleId);
    await grantBizAdminToUser(app, submitter.id, bizSeed.bizAdminRoleId);

    const ma = await prisma.member.create({
      data: { memberNo: 'att-m-a', ...memberIdentityData('Member A') },
      select: { id: true },
    });
    memberAId = ma.id;
    const mb = await prisma.member.create({
      data: { memberNo: 'att-m-b', ...memberIdentityData('Member B') },
      select: { id: true },
    });
    memberBId = mb.id;
    const mc = await prisma.member.create({
      data: { memberNo: 'att-m-c', ...memberIdentityData('Member C') },
      select: { id: true },
    });
    memberCId = mc.id;
    const mOther = await prisma.member.create({
      data: { memberNo: 'att-m-other', ...memberIdentityData('Other Member') },
      select: { id: true },
    });
    otherMemberId = mOther.id;

    await prisma.user.update({
      where: { username: 'att-user-with-mem' },
      data: { memberId: memberAId },
    });

    // 字典:node_type + activity_type + attendance_role + attendance_status
    const nodeDict = await prisma.dictType.create({
      data: { code: 'node_type', label: '节点类型' },
      select: { id: true },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'att-root', label: '根' },
    });
    await prisma.dictItem.create({
      data: { typeId: nodeDict.id, code: 'att-child', label: '子' },
    });
    const rootOrg = await prisma.organization.create({
      data: { name: 'Att Root', nodeTypeCode: 'att-root', parentId: null },
      select: { id: true },
    });
    const childOrg = await prisma.organization.create({
      data: { name: 'Att Child', nodeTypeCode: 'att-child', parentId: rootOrg.id },
      select: { id: true },
    });

    const actTypeDict = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    const ti = await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'att-demo', label: '演示' },
      select: { code: true },
    });

    // attendance_role 字典(7 项闭集)
    const roleDict = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    for (const code of [
      'member',
      'instructor',
      'assistant',
      'coach',
      'front_command',
      'back_command',
      'info',
    ]) {
      await prisma.dictItem.create({
        data: { typeId: roleDict.id, code, label: code },
      });
    }

    // attendance_status 字典(3 项闭集;absent/leave 故意不建)
    const statDict = await prisma.dictType.create({
      data: { code: 'attendance_status', label: '考勤状态' },
      select: { id: true },
    });
    for (const code of ['present', 'late', 'early_leave']) {
      await prisma.dictItem.create({
        data: { typeId: statDict.id, code, label: code },
      });
    }

    // 主活动(published)
    const actCreate = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', adminAuth)
      .send({
        title: 'ATT-MAIN',
        activityTypeCode: ti.code,
        organizationId: childOrg.id,
        startAt: pastIso('06-01T08:00:00.000Z'),
        endAt: futureIso('07-31T18:00:00.000Z'),
        location: '演示',
        allocationModeCode: 'first_come',
      });
    activityId = actCreate.body.data.id;
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/publish`)
      .set('Authorization', adminAuth)
      .send({ requiresInsuranceConfirmed: true });

    // 已取消活动
    const actCancel = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', adminAuth)
      .send({
        title: 'ATT-CANCEL',
        activityTypeCode: ti.code,
        organizationId: childOrg.id,
        startAt: pastIso('06-01T08:00:00.000Z'),
        endAt: futureIso('06-01T18:00:00.000Z'),
        location: '演示',
        allocationModeCode: 'first_come',
      });
    activityCancelledId = actCancel.body.data.id;
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityCancelledId}/publish`)
      .set('Authorization', adminAuth)
      .send({ requiresInsuranceConfirmed: true });
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityCancelledId}/cancel`)
      .set('Authorization', adminAuth)
      .send({});

    // 报名 memberA 到 activityId(R23 正向)
    const reg1 = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activityId}/registrations`)
      .set('Authorization', adminAuth)
      .send({ memberId: memberAId });
    registrationAId = reg1.body.data.id;
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityId}/registrations/${registrationAId}/approve`)
      .set('Authorization', adminAuth)
      .send({});

    nativeOrganizationId = childOrg.id;
    const nativeOwner = await prisma.member.create({
      data: {
        memberNo: 'att-native-owner',
        ...memberIdentityData('Native Owner'),
        status: 'ACTIVE',
        gradeCode: 'level-2',
      },
    });
    nativeOwnerId = nativeOwner.id;
    const nativeUser = await createTestUser(app, { username: 'att-native-owner', role: Role.USER });
    nativeUserId = nativeUser.id;
    await prisma.user.update({ where: { id: nativeUserId }, data: { memberId: nativeOwnerId } });
    const codes = [
      'activity.settlement-generate.record',
      'activity.settlement-update-draft.record',
      'activity.settlement-submit.record',
      'activity-registration.create.record',
    ];
    await prisma.permission.createMany({
      data: ACTIVITY_RESPONSIBILITY_WORKFLOW_PERMISSION_SEED.filter((permission) =>
        codes.includes(permission.code),
      ).map((permission) => ({ ...permission })),
      skipDuplicates: true,
    });
    const permissions = await prisma.permission.findMany({ where: { code: { in: codes } } });
    expect(permissions).toHaveLength(codes.length);
    const role = await prisma.rbacRole.create({
      data: { code: 'test-att-native-writer', displayName: 'Native settlement writer' },
    });
    nativeRoleId = role.id;
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({
        roleId: nativeRoleId,
        permissionId: permission.id,
      })),
    });
    await prisma.dictItem.create({
      data: { typeId: actTypeDict.id, code: 'att-native', label: '原生结算验收' },
    });
    await prisma.contributionRule.create({
      data: {
        activityTypeCode: 'att-native',
        attendanceRoleCode: 'member',
        status: 'ACTIVE',
        pointsBelow: 1,
      },
    });
    nativeAuth = (await loginAs(app, 'att-native-owner')).authHeader;
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      if (previousV11 === undefined) delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
      else process.env.ACTIVITY_V11_WORKFLOW_ENABLED = previousV11;
      if (previousInsuranceGate === undefined) delete process.env.INSURANCE_ENFORCEMENT_ENABLED;
      else process.env.INSURANCE_ENFORCEMENT_ENABLED = previousInsuranceGate;
    }
  });

  // ============ helpers ============

  async function onsiteScenario(
    requiresInsurance = false,
    startAt = new Date(Date.now() + 3_600_000),
  ) {
    const endAt = new Date(startAt.getTime() + 4 * 3_600_000);
    const activity = await prisma.activity.create({
      data: {
        title: 'Native attendance admission',
        activityTypeCode: 'att-native',
        organizationId: nativeOrganizationId,
        startAt,
        endAt,
        location: '现场',
        statusCode: 'published',
        publishedAt: new Date(),
        capacity: 10,
        requiresInsurance,
      },
    });
    await prisma.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: nativeOwnerId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: nativeUserId,
        source: 'publish',
      },
    });
    await prisma.roleBinding.create({
      data: {
        roleId: nativeRoleId,
        principalType: PrincipalType.USER,
        principalId: nativeUserId,
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: activity.id,
        status: 'ACTIVE',
      },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: 'onsite',
        name: '现场场次',
        startAt,
        endAt,
        capacity: 10,
        statusCode: 'scheduled',
        locationRequired: false,
        locationText: '现场',
        locationPolicySourceCode: 'session',
        checkInOpenAt: new Date(startAt.getTime() - 1_800_000),
        checkInCloseAt: new Date(startAt.getTime() + 1_800_000),
        checkOutOpenAt: new Date(endAt.getTime() - 3_600_000),
        checkOutCloseAt: new Date(endAt.getTime() + 1_800_000),
      },
    });
    await prisma.activityCapacityBucket.createMany({
      data: [
        {
          activityId: activity.id,
          scopeTypeCode: 'activity_person',
          scopeId: activity.id,
          capacity: 10,
        },
        {
          activityId: activity.id,
          scopeTypeCode: 'session_participation',
          scopeId: session.id,
          capacity: 10,
        },
      ],
    });
    await prisma.activityEvidenceState.create({ data: { activityId: activity.id } });
    return { activityId: activity.id, sessionId: session.id };
  }

  function onsite(
    f: Awaited<ReturnType<typeof onsiteScenario>>,
    memberId: string,
    extra: Record<string, unknown> = {},
  ) {
    return request(httpServer(app))
      .post(`/api/app/v1/my/managed-activities/${f.activityId}/onsite-participations`)
      .set('Authorization', nativeAuth)
      .send({
        operationKey: `onsite:${f.activityId}:${memberId}`,
        memberId,
        sessionId: f.sessionId,
        reason: '负责人核验现场参加资格',
        ...extra,
      });
  }

  async function onsiteSnapshot(f: Awaited<ReturnType<typeof onsiteScenario>>) {
    const activityId = f.activityId;
    return Promise.all([
      prisma.activityRegistration.findMany({ where: { activityId }, orderBy: { id: 'asc' } }),
      prisma.activityParticipationIdentity.findMany({
        where: { activityId },
        orderBy: { id: 'asc' },
      }),
      prisma.activityRegistrationRevision.findMany({
        where: { registration: { activityId } },
        orderBy: { id: 'asc' },
      }),
      prisma.activityParticipationRevision.findMany({
        where: { identity: { activityId } },
        orderBy: { id: 'asc' },
      }),
      prisma.capacityReservation.findMany({
        where: { identity: { activityId } },
        orderBy: { id: 'asc' },
      }),
      prisma.activityCapacityBucket.findMany({ where: { activityId }, orderBy: { id: 'asc' } }),
      prisma.insuranceEligibilityEvidence.findMany({
        where: { activityRegistration: { activityId } },
        orderBy: { id: 'asc' },
      }),
      prisma.activityEvidenceState.findUniqueOrThrow({ where: { activityId } }),
      prisma.attendancePunchEvent.findMany({ where: { activityId }, orderBy: { id: 'asc' } }),
      prisma.participationLedgerEntry.count({ where: { activityId } }),
      prisma.auditLog.count(),
      prisma.notificationOutboxIntent.count(),
    ]);
  }

  async function expectInvalidOnsiteAnchor(
    f: Awaited<ReturnType<typeof onsiteScenario>>,
    memberId: string,
    registrationId: string,
  ) {
    const before = await onsiteSnapshot(f);
    expectBizError(await onsite(f, memberId, { registrationId }), BizCode.BAD_REQUEST, {
      strictMessage: false,
    });
    expect(await onsiteSnapshot(f)).toEqual(before);
    // The native identity cannot carry a foreign/missing head even below HTTP.
    // Assert the exact composite FK, not an unrelated constraint or DTO error.
    await expect(
      prisma.$executeRaw(Prisma.sql`
      INSERT INTO "ActivityParticipationIdentity"
        ("id", "updatedAt", "activityId", "sessionId", "registrationId", "memberId", "currentStatusCode")
      VALUES (${`invalid-${f.activityId}-${memberId}`}, CURRENT_TIMESTAMP,
        ${f.activityId}, ${f.sessionId}, ${registrationId}, ${memberId}, 'cancelled')
    `),
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: {
        code: '23503',
        message: expect.stringContaining(
          'ActivityParticipationIdentity_registrationId_activityId_me_fkey',
        ),
      },
    });
    expect(await onsiteSnapshot(f)).toEqual(before);
  }

  async function admitWithOwnAnchor(
    f: Awaited<ReturnType<typeof onsiteScenario>>,
    memberId: string,
  ) {
    const response = await onsite(f, memberId).expect(201);
    const identity = await prisma.activityParticipationIdentity.findUniqueOrThrow({
      where: { id: response.body.data.participationIdentityId },
      include: { registration: true },
    });
    expect(identity).toMatchObject({
      activityId: f.activityId,
      memberId,
      registrationId: response.body.data.registrationId,
      currentStatusCode: 'pass',
      populationIncluded: true,
      // Canonical admission lives on the identity/revision/reservation, not
      // the legacy header statusCode (which may remain pending).
      registration: {
        activityId: f.activityId,
        memberId,
        sourceCode: 'onsite',
        statusSummaryCode: 'active',
      },
    });
    return response.body.data as AppManagedActivityOnsiteParticipationReceiptDto;
  }

  async function nativeImportSource(
    f: Awaited<ReturnType<typeof onsiteScenario>>,
    memberId: string,
  ) {
    const admitted = await admitWithOwnAnchor(f, memberId);
    return {
      activityId: f.activityId,
      sessionId: f.sessionId,
      participationIdentityId: admitted.participationIdentityId,
      memberCredential: null,
      sourceCode: 'import' as const,
      reason: '导入历史签到表',
      deviceId: null,
      longitude: null,
      latitude: null,
      accuracy: null,
      currentUser: await prisma.user.findUniqueOrThrow({
        where: { id: nativeUserId },
        select: { id: true, username: true, memberId: true, role: true, status: true },
      }),
      auditMeta: { requestId: 'native-import-time', ip: null, ua: null },
    };
  }

  async function expectNativeAnchorCannotBeCleared(
    f: Awaited<ReturnType<typeof onsiteScenario>>,
    memberId: string,
    receipt: AppManagedActivityOnsiteParticipationReceiptDto,
  ) {
    const before = await onsiteSnapshot(f);
    const response = await onsite(f, memberId, { registrationId: null });
    expectBizError(response, BizCode.BAD_REQUEST, { strictMessage: false });
    expect(response.body.message).toBe('property registrationId should not exist');
    expect(await onsiteSnapshot(f)).toEqual(before);
    // Prisma exposes PG's row DETAIL, not COLUMN_NAME. Check the named
    // constraint in the catalog instead of matching data-bearing error text.
    expect(
      await prisma.$queryRaw`
      SELECT attname AS "column", attnotnull AS required FROM pg_attribute
      WHERE attrelid = '"ActivityParticipationIdentity"'::regclass
        AND attname = 'registrationId'
    `,
    ).toEqual([{ column: 'registrationId', required: true }]);
    await expect(
      prisma.$executeRaw(Prisma.sql`
        UPDATE "ActivityParticipationIdentity" SET "registrationId" = NULL
        WHERE "id" = ${receipt.participationIdentityId}
      `),
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: { code: '23502' },
    });
    expect(await onsiteSnapshot(f)).toEqual(before);
    expect((await onsite(f, memberId).expect(201)).body.data).toEqual(receipt);
    expect(await onsiteSnapshot(f)).toEqual(before);
  }

  async function nativeDraft(
    memberIds: string[],
    hours = 2,
    activityTypeCode = 'att-native',
    roleCode = 'member',
    spans = [{ start: 0, end: hours }],
  ) {
    const f = await createSettlementDraftFixture(prisma, {
      organizationId: nativeOrganizationId,
      ownerMemberId: nativeOwnerId,
      actorUserId: nativeUserId,
      participantMemberIds: memberIds,
      activityTypeCode,
      sessionHours: Math.max(4, ...spans.map((span) => span.end)),
    });
    await prisma.roleBinding.create({
      data: {
        roleId: nativeRoleId,
        principalType: PrincipalType.USER,
        principalId: nativeUserId,
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: f.activityId,
        status: 'ACTIVE',
      },
    });
    const identities = await prisma.activityParticipationIdentity.findMany({
      where: { id: { in: f.identityIds } },
    });
    let positionId: string | null = null;
    if (roleCode !== 'member') {
      positionId = (
        await prisma.activitySessionPosition.create({
          data: {
            activityId: f.activityId,
            sessionId: identities[0].sessionId,
            code: 'native-role',
            name: roleCode,
            attendanceRoleCode: roleCode,
          },
        })
      ).id;
      await prisma.activityParticipationIdentity.updateMany({
        where: { id: { in: f.identityIds } },
        data: { currentPositionId: positionId },
      });
    }
    // Explicit source facts, not prefilled expected results: generate must
    // replace the helper's two-hour draft with the time derived from punches.
    const events = spans
      .flatMap((span) => [
        { eventTypeCode: 'check_in', hour: span.start },
        { eventTypeCode: 'check_out', hour: span.end },
      ])
      .sort(
        (a, b) =>
          a.hour - b.hour ||
          (a.eventTypeCode === b.eventTypeCode ? 0 : a.eventTypeCode === 'check_out' ? -1 : 1),
      );
    for (const identity of identities) {
      // Preserve checkout-before-checkin ordering at an exact shared boundary.
      for (const [index, event] of events.entries()) {
        const occurredAt = new Date(Date.parse('2020-03-01T00:00:00Z') + event.hour * 3_600_000);
        await prisma.attendancePunchEvent.create({
          data: {
            eventTypeCode: event.eventTypeCode,
            occurredAt,
            activityId: f.activityId,
            sessionId: identity.sessionId,
            participationIdentityId: identity.id,
            memberId: identity.memberId,
            positionId,
            sourceCode: 'staff_scan',
            operatorUserId: nativeUserId,
            receivedAt: occurredAt,
            eventKey: `${identity.id}-${index}`,
            requestHash: `${identity.id}-${index}`,
            evidenceRevision: 0,
          },
        });
      }
    }
    const base = `/api/app/v1/my/managed-activities/${f.activityId}/settlement`;
    const generated = await request(httpServer(app))
      .post(`${base}/generate`)
      .set('Authorization', nativeAuth)
      .send({ operationKey: `generate:${f.activityId}` })
      .expect(200);
    expect(generated.body.data).toMatchObject({ outcome: 'draft', personCount: memberIds.length });
    return {
      ...f,
      base,
      identities,
      draftVersion: generated.body.data.settlementVersion as number,
    };
  }

  async function nativeSubmit(f: Awaited<ReturnType<typeof nativeDraft>>) {
    const response = await request(httpServer(app))
      .post(`${f.base}/submit`)
      .set('Authorization', nativeAuth)
      .send({
        operationKey: `submit:${f.activityId}`,
        expectedDraftVersion: f.draftVersion,
        evidenceSealId: f.sealId,
        confirmation: true,
      })
      .expect(200);
    const versionId = response.body.data.settlementVersionId as string;
    const version = await prisma.attendanceSettlementVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    const results = await prisma.participantSettlementResultRevision.findMany({
      where: { settlementVersionId: versionId },
      orderBy: { participationIdentityId: 'asc' },
    });
    return { response, version, results };
  }

  async function nativeSnapshot(f: Awaited<ReturnType<typeof nativeDraft>>) {
    const [
      activity,
      run,
      versions,
      results,
      batches,
      reviews,
      entries,
      segments,
      punches,
      auditCount,
      intentCount,
    ] = await Promise.all([
      prisma.activity.findUniqueOrThrow({ where: { id: f.activityId } }),
      prisma.attendanceSettlementRun.findUniqueOrThrow({ where: { id: f.runId } }),
      prisma.attendanceSettlementVersion.findMany({
        where: { settlementRunId: f.runId },
        orderBy: { version: 'asc' },
      }),
      prisma.participantSettlementResultRevision.findMany({
        where: { settlementVersion: { settlementRunId: f.runId } },
        orderBy: { id: 'asc' },
      }),
      prisma.ledgerPostingBatch.findMany({
        where: { settlementRunId: f.runId },
        orderBy: { id: 'asc' },
      }),
      prisma.settlementReviewAction.findMany({
        where: { settlementVersion: { settlementRunId: f.runId } },
        orderBy: { id: 'asc' },
      }),
      prisma.participationLedgerEntry.findMany({
        where: { activityId: f.activityId },
        orderBy: { id: 'asc' },
      }),
      prisma.participantServiceSegmentRevision.findMany({
        where: { participationIdentityId: { in: f.identityIds } },
        orderBy: { id: 'asc' },
      }),
      prisma.attendancePunchEvent.findMany({
        where: { activityId: f.activityId },
        orderBy: { id: 'asc' },
      }),
      prisma.auditLog.count(),
      prisma.notificationOutboxIntent.count(),
    ]);
    return {
      activity,
      run,
      versions,
      results,
      batches,
      reviews,
      ledgerCount: entries.length,
      entries,
      segments,
      punches,
      auditCount,
      intentCount,
    };
  }

  function nativeReview(
    version: Awaited<ReturnType<typeof nativeSubmit>>['version'],
    stage: 'first-approve' | 'first-return' | 'final-approve' | 'final-return',
    note?: string,
    keySuffix = '',
  ) {
    return request(httpServer(app))
      .post(`/api/admin/v1/attendance-settlements/${version.id}/${stage}`)
      .set('Authorization', stage.startsWith('first') ? finalAdminAuth : nativeFinalAuth)
      .send({
        operationKey: `${stage}:${version.id}${keySuffix}`,
        note,
        evidenceSealId: version.evidenceSealId,
        evidenceRevision: version.evidenceRevision,
        populationRevision: version.populationRevision,
        workflowRevision: version.workflowRevision,
        contentHash: version.contentHash,
      });
  }

  async function nativePrepare(versionId: string) {
    const batch = await prisma.ledgerPostingBatch.findFirstOrThrow({
      where: { settlementVersionId: versionId },
    });
    const preparation = app.get(LedgerPreparationService);
    const { jobId } = await preparation.ensurePrepareJob(batch.id);
    for (const item of await prisma.activityBatchJobItem.findMany({ where: { jobId } })) {
      await preparation.prepareChunk(jobId, item.id);
    }
    expect((await preparation.finalize(jobId)).batchStatus).toBe('ready');
    return batch;
  }

  async function nativeCommit(batchId: string) {
    const actor = await prisma.user.findUniqueOrThrow({
      where: { id: nativeFinalReviewerId },
      select: { id: true, username: true, role: true, status: true, memberId: true },
    });
    expect(
      (
        await app.get(LedgerPostingService).commitBatch(
          {
            postingBatchId: batchId,
            operationKey: `commit:${batchId}`,
          },
          actor,
          { requestId: 'native-acceptance-post', ip: null, ua: 'jest' },
        )
      ).batchStatus,
    ).toBe('committed');
  }

  async function expectNativeDtoRejection(
    operation: 'submit' | 'edit',
    extra: Record<string, unknown>,
  ) {
    const f = await nativeDraft([memberCId]);
    const before = await nativeSnapshot(f);
    const response =
      operation === 'submit'
        ? await request(httpServer(app))
            .post(`${f.base}/submit`)
            .set('Authorization', nativeAuth)
            .send({
              operationKey: `dto:${f.activityId}`,
              expectedDraftVersion: f.draftVersion,
              evidenceSealId: f.sealId,
              confirmation: true,
              ...extra,
            })
        : await request(httpServer(app))
            .patch(`${f.base}/items/${f.identityId}`)
            .set('Authorization', nativeAuth)
            .send({
              expectedDraftVersion: f.draftVersion,
              resultCode: 'present',
              recognizedServiceHours: 1.5,
              recognizedContributionPoints: 1,
              reason: '扣除休息时间',
              ...extra,
            });
    expectBizError(response, BizCode.BAD_REQUEST, { strictMessage: false });
    expect(await nativeSnapshot(f)).toEqual(before);
    return f;
  }

  // These operations are explicitly retired, not aliases for native return or
  // correction. Exercise real historical rows and real native versions together.
  async function expectRetiredMutation(options: {
    action: 'delete' | 'edit' | 'reject' | 'final-reject';
    legacyStatus?: string;
    nativeStage?: 'submitted' | 'pending-final' | 'approved' | 'first-returned' | 'final-returned';
    auth?: string;
    missing?: boolean;
    body?: Record<string, unknown>;
  }) {
    const f = await nativeDraft([memberCId]);
    const { version } = await nativeSubmit(f);
    if (
      options.nativeStage === 'approved' ||
      options.nativeStage === 'pending-final' ||
      options.nativeStage === 'final-returned'
    ) {
      await nativeReview(version, 'first-approve').expect(200);
    }
    if (options.nativeStage === 'approved') {
      await nativeReview(version, 'final-approve').expect(200);
    } else if (options.nativeStage === 'final-returned') {
      await nativeReview(version, 'final-return', '终审历史保护验收').expect(200);
    } else if (options.nativeStage === 'first-returned') {
      await nativeReview(version, 'first-return', '历史保护验收').expect(200);
    }
    const legacy = await prisma.attendanceSheet.create({
      data: {
        activityId: f.activityId,
        submitterUserId: nativeUserId,
        statusCode: options.legacyStatus ?? 'pending',
        records: {
          create: {
            memberId: memberCId,
            roleCode: 'member',
            attendanceStatusCode: 'present',
            checkInAt: new Date('2020-03-01T00:00:00Z'),
            checkOutAt: new Date('2020-03-01T01:00:00Z'),
            serviceHours: 1,
            contributionPoints: 7,
            deletedAt:
              options.legacyStatus === 'final_rejected' ? new Date('2020-03-01T03:00:00Z') : null,
          },
        },
      },
    });
    const legacySnapshot = () =>
      prisma.attendanceSheet.findUniqueOrThrow({
        where: { id: legacy.id },
        include: { records: { orderBy: { id: 'asc' } } },
      });
    const before = await nativeSnapshot(f);
    const history = await legacySnapshot();
    for (const id of options.missing ? ['cl0000000000000000000000'] : [legacy.id, version.id]) {
      const path = `/api/admin/v1/attendance-sheets/${id}`;
      const command =
        options.action === 'delete'
          ? request(httpServer(app)).delete(path)
          : request(httpServer(app)).patch(
              options.action === 'edit' ? path : `${path}/${options.action}`,
            );
      const response = await command.set('Authorization', options.auth ?? nativeFinalAuth).send(
        options.body ??
          (options.action === 'edit'
            ? {
                records: history.records.map((row) => ({
                  memberId: row.memberId,
                  roleCode: row.roleCode,
                  attendanceStatusCode: row.attendanceStatusCode,
                  checkInAt: row.checkInAt.toISOString(),
                  checkOutAt: row.checkOutAt.toISOString(),
                })),
              }
            : {}),
      );
      expectBizError(response, BizCode.NOT_FOUND);
      expect(await legacySnapshot()).toEqual(history);
      expect(await nativeSnapshot(f)).toEqual(before);
    }
    return { f, version, legacySnapshot, history };
  }

  const baseRecord = (override: Record<string, unknown> = {}): Record<string, unknown> => ({
    memberId: memberAId,
    roleCode: 'member',
    checkInAt: pastIso('06-01T08:00:00.000Z'),
    checkOutAt: pastIso('06-01T12:00:00.000Z'),
    attendanceStatusCode: 'present',
    ...override,
  });

  async function createPendingSheet(
    actId: string,
    records: Array<Record<string, unknown>>,
  ): Promise<string> {
    const res = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${actId}/attendance-sheets`)
      .set('Authorization', submitterAuth)
      .send({ records });
    if (res.status !== 201) {
      throw new Error(`createPendingSheet failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.data.id as string;
  }

  // ============ 权限边界 ============

  describe('权限边界', () => {
    const missingVersionId = 'cl000000000000000000xxxx';
    const submitCommand = {
      operationKey: 'attendance-permission-submit',
      expectedDraftVersion: 1,
      evidenceSealId: 'cl000000000000000000seal',
      confirmation: true,
    };
    let before: number[];
    const footprint = () =>
      Promise.all([
        prisma.attendanceSettlementRun.count(),
        prisma.attendanceSettlementVersion.count(),
        prisma.participantSettlementResultRevision.count(),
        prisma.settlementReviewAction.count(),
        prisma.ledgerPostingBatch.count(),
        prisma.participationLedgerEntry.count(),
        prisma.auditLog.count(),
        prisma.notificationOutboxIntent.count(),
      ]);
    beforeEach(async () => {
      before = await footprint();
    });
    afterEach(async () => {
      expect(await footprint()).toEqual(before);
    });

    it('未登录 POST 新结算 submit → 401', async () => {
      const res = await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/settlement/submit`)
        .send(submitCommand);
      expectBizError(res, BizCode.UNAUTHORIZED);
    });

    it('USER POST 新结算 submit → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/settlement/submit`)
        .set('Authorization', userWithMemberAuth)
        .send(submitCommand);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER GET 结算审核列表 → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements')
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER GET 结算入账状态不泄露版本存在性 → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-settlements/${missingVersionId}/posting-batch`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER GET 新结算 review-detail 不泄露版本存在性 → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-settlements/${missingVersionId}/review-detail`)
        .set('Authorization', userWithMemberAuth);
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER PATCH 新结算认定不泄露参与身份存在性 → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .patch(
          `/api/app/v1/my/managed-activities/${activityId}/settlement/items/${missingVersionId}`,
        )
        .set('Authorization', userWithMemberAuth)
        .send({
          expectedDraftVersion: 1,
          resultCode: 'present',
          recognizedServiceHours: 1,
          recognizedContributionPoints: 1,
          reason: 'unauthorized edit',
        });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });

    it('USER POST 新结算 first-approve 不泄露版本存在性 → 30100 RBAC_FORBIDDEN', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/attendance-settlements/${missingVersionId}/first-approve`)
        .set('Authorization', userWithMemberAuth)
        .send({
          operationKey: 'attendance-permission-review',
          evidenceSealId: submitCommand.evidenceSealId,
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          contentHash: '0'.repeat(64),
          note: 'unauthorized review',
        });
      expectBizError(res, BizCode.RBAC_FORBIDDEN);
    });
  });

  describe('原生与旧历史的退役写入边界', () => {
    it('普通 USER 不能经旧删除入口修改历史或新版本', async () => {
      await expectRetiredMutation({ action: 'delete', auth: userWithMemberAuth });
    });
    it('普通 USER 不能经旧硬驳回入口修改历史或新版本', async () => {
      await expectRetiredMutation({
        action: 'reject',
        auth: userWithMemberAuth,
        body: { reviewNote: 'x' },
      });
    });
  });

  // ============ POST submit 主成功 ============

  describe('POST submit 主路径', () => {
    it('原生提交单人草稿 → 新 submitted 版本与 pending_first_review，无提前审核或内部字段', async () => {
      const f = await nativeDraft([memberBId]);
      const { response, version, results } = await nativeSubmit(f);
      expect(response.body.data.activityId).toBe(f.activityId);
      expect(version).toMatchObject({
        statusCode: 'submitted',
        createdByUserId: nativeUserId,
        submittedAt: expect.any(Date),
        personCount: 1,
      });
      expect(version.version).toBeGreaterThan(f.draftVersion);
      expect(
        (await prisma.attendanceSettlementRun.findUniqueOrThrow({ where: { id: f.runId } }))
          .statusCode,
      ).toBe('pending_first_review');
      expect(results).toHaveLength(1);
      expect(
        await prisma.settlementReviewAction.count({ where: { settlementVersionId: version.id } }),
      ).toBe(0);
      for (const key of ['deletedAt', 'previousSnapshot', 'requestHash'])
        expect(response.body.data).not.toHaveProperty(key);
    });

    it('原生提交多名参与者 → 全部身份各一条提交结果', async () => {
      const f = await nativeDraft([memberCId, memberBId]);
      const { version, results } = await nativeSubmit(f);
      expect(version.personCount).toBe(2);
      expect(results.map((result) => result.participationIdentityId).sort()).toEqual(
        [...f.identityIds].sort(),
      );
    });

    it('原生提交不传时长 → 真实生成器从打卡计算 3.5 小时', async () => {
      const { results } = await nativeSubmit(await nativeDraft([memberCId], 3.5));
      expect(results).toHaveLength(1);
      expect(results[0].calculatedServiceHours.toString()).toBe('3.5');
      expect(results[0].recognizedServiceHours.toString()).toBe('3.5');
    });

    it('原生提交有理由扣除休息时间 → 认定 2.5 小时且保留 3 小时机器基线', async () => {
      const f = await nativeDraft([otherMemberId], 3);
      await request(httpServer(app))
        .patch(`${f.base}/items/${f.identityId}`)
        .set('Authorization', nativeAuth)
        .send({
          expectedDraftVersion: f.draftVersion,
          resultCode: 'present',
          recognizedServiceHours: 2.5,
          recognizedContributionPoints: 1,
          reason: '扣除半小时休息',
        })
        .expect(200);
      const { results } = await nativeSubmit(f);
      expect(results[0].recognizedServiceHours.toString()).toBe('2.5');
      expect(results[0].calculatedServiceHours.toString()).toBe('3');
      expect(results[0].adjustmentReason).toBe('扣除半小时休息');
    });

    it('原生提交从身份保留同活动同成员报名锚点', async () => {
      const f = await nativeDraft([memberAId], 2.5);
      const { results } = await nativeSubmit(f);
      expect(results[0].participationIdentityId).toBe(f.identityId);
      const identity = await prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: f.identityId },
        include: { registration: true },
      });
      expect(identity.registrationId).toBe(f.identities[0].registrationId);
      expect(identity.registration).toMatchObject({
        activityId: f.activityId,
        memberId: memberAId,
      });
    });

    it('原生无需保险可现场参加，无须预报名；锚点由服务端建立而非接收 null', async () => {
      const f = await onsiteScenario();
      const before = await onsiteSnapshot(f);
      expectBizError(await onsite(f, memberBId, { registrationId: null }), BizCode.BAD_REQUEST, {
        strictMessage: false,
      });
      expect(await onsiteSnapshot(f)).toEqual(before);
      const response = await onsite(f, memberBId).expect(201);
      expect(response.body.data).toMatchObject({ sourceCode: 'onsite', statusCode: 'pass' });
      const identity = await prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: response.body.data.participationIdentityId },
        include: { registration: true },
      });
      expect(identity).toMatchObject({
        activityId: f.activityId,
        memberId: memberBId,
        registrationId: response.body.data.registrationId,
        registration: { activityId: f.activityId, memberId: memberBId },
      });
      expect(
        await prisma.insuranceEligibilityEvidence.count({
          where: { activityRegistration: { activityId: f.activityId } },
        }),
      ).toBe(0);
    });

    it('原生导入不得在允许窗口内伪造未来签退/签到，历史事实及精确重放仍可用', async () => {
      const now = Date.now();
      const f = await onsiteScenario(false, new Date(now - 3.5 * 3_600_000));
      const command = app.get(AttendancePunchCommandService);
      const input = await nativeImportSource(f, memberCId);
      const checkIn = {
        ...input,
        actionCode: 'check_in' as const,
        eventKey: `past-in:${f.activityId}`,
        occurredAt: new Date(now - 3.5 * 3_600_000),
      };
      const first = await command.managedPunch(checkIn);
      const before = await onsiteSnapshot(f);
      const segments = () =>
        prisma.participantServiceSegmentRevision.findMany({
          where: { participationIdentityId: input.participationIdentityId },
          orderBy: { id: 'asc' },
        });
      const beforeSegments = await segments();
      // This is within checkOutOpenAt/checkOutCloseAt, so the session-window
      // guard alone cannot establish that the claimed event has already happened.
      await expect(
        command.managedPunch({
          ...input,
          actionCode: 'check_out',
          eventKey: `future-out:${f.activityId}`,
          occurredAt: new Date(now + 10 * 60_000),
        }),
      ).rejects.toMatchObject({ biz: BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW });
      expect(await onsiteSnapshot(f)).toEqual(before);
      expect(await segments()).toEqual(beforeSegments);
      await command.managedPunch({
        ...input,
        actionCode: 'check_out',
        eventKey: `past-out:${f.activityId}`,
        occurredAt: new Date(now - 10 * 60_000),
      });
      const committedFacts = await onsiteSnapshot(f);
      expect(await command.managedPunch(checkIn)).toMatchObject({ eventId: first.eventId });
      expect(await onsiteSnapshot(f)).toEqual(committedFacts);

      const future = await onsiteScenario();
      const futureAdmitted = await admitWithOwnAnchor(future, memberBId);
      const futureSession = await prisma.activitySession.findUniqueOrThrow({
        where: { id: future.sessionId },
      });
      const futureBefore = await onsiteSnapshot(future);
      await expect(
        command.managedPunch({
          ...input,
          activityId: future.activityId,
          sessionId: future.sessionId,
          participationIdentityId: futureAdmitted.participationIdentityId,
          actionCode: 'check_in',
          eventKey: `future-in:${future.activityId}`,
          occurredAt: futureSession.startAt,
        }),
      ).rejects.toMatchObject({ biz: BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW });
      expect(await onsiteSnapshot(future)).toEqual(futureBefore);
    });

    it('原生需保险的现场参加先核验真实来源，无来源零写，有来源按同人同活动留证', async () => {
      const f = await onsiteScenario(true);
      const before = await onsiteSnapshot(f);
      expectBizError(await onsite(f, memberCId), BizCode.INSURANCE_REQUIRED);
      expect(await onsiteSnapshot(f)).toEqual(before);
      expectBizError(await onsite(f, memberCId, { registrationId: null }), BizCode.BAD_REQUEST, {
        strictMessage: false,
      });
      expect(await onsiteSnapshot(f)).toEqual(before);
      const insurance = await prisma.memberInsurance.create({
        data: {
          memberId: memberCId,
          insurerName: 'Fixture insurance',
          policyNumber: 'ATT-NATIVE-INSURANCE',
          coverageStart: new Date(Date.now() - 86_400_000),
          coverageEnd: new Date(Date.now() + 7 * 86_400_000),
          reviewStatusCode: 'verified',
          reviewedByUserId: nativeUserId,
          reviewedAt: new Date(),
        },
      });
      const response = await onsite(f, memberCId).expect(201);
      const evidence = await prisma.insuranceEligibilityEvidence.findMany({
        where: { activityRegistrationId: response.body.data.registrationId },
        include: {
          activityRegistration: { select: { activityId: true, memberId: true } },
          memberInsurance: { select: { memberId: true } },
        },
      });
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        memberInsuranceId: insurance.id,
        activityRegistrationRevisionId: response.body.data.registrationRevisionId,
        activityRegistration: { activityId: f.activityId, memberId: memberCId },
        memberInsurance: { memberId: memberCId },
      });
      const identity = await prisma.activityParticipationIdentity.findUniqueOrThrow({
        where: { id: response.body.data.participationIdentityId },
      });
      expect(identity).toMatchObject({
        activityId: f.activityId,
        memberId: memberCId,
        registrationId: response.body.data.registrationId,
      });
      const admitted = await onsiteSnapshot(f);
      expect((await onsite(f, memberCId).expect(201)).body.data).toEqual(response.body.data);
      expect(await onsiteSnapshot(f)).toEqual(admitted);
    });
  });

  // ============ POST submit 关键失败 ============

  describe('POST submit 关键失败', () => {
    it('原生不存在活动：GLOBAL 持码者得 NOT_FOUND，scoped 及撤 GLOBAL 后均防枚举且零写', async () => {
      const f = await nativeDraft([memberCId]);
      const submitMissing = () =>
        request(httpServer(app))
          .post('/api/app/v1/my/managed-activities/cl0000000000000000000000/settlement/submit')
          .set('Authorization', nativeAuth)
          .send({
            operationKey: 'missing-activity-submit',
            expectedDraftVersion: f.draftVersion,
            evidenceSealId: f.sealId,
            confirmation: true,
          });
      const before = await nativeSnapshot(f);
      expectBizError(await submitMissing(), BizCode.RBAC_FORBIDDEN);
      expect(await nativeSnapshot(f)).toEqual(before);
      const binding = await prisma.roleBinding.create({
        data: {
          roleId: nativeRoleId,
          principalType: PrincipalType.USER,
          principalId: nativeUserId,
          scopeType: BindingScopeType.GLOBAL,
          status: 'ACTIVE',
        },
      });
      try {
        expectBizError(await submitMissing(), BizCode.ACTIVITY_NOT_FOUND);
        expect(await nativeSnapshot(f)).toEqual(before);
      } finally {
        await prisma.roleBinding.delete({ where: { id: binding.id } });
      }
      expectBizError(await submitMissing(), BizCode.RBAC_FORBIDDEN);
      expect(await nativeSnapshot(f)).toEqual(before);
    });

    it('原生 cancelled 活动首次送审拒绝 20122，草稿/版本/审计/通知零写', async () => {
      const f = await nativeDraft([memberCId]);
      // Cancelled is the input checkpoint, as in the dedicated state-guard suite.
      await prisma.activity.update({
        where: { id: f.activityId },
        data: { statusCode: 'cancelled' },
      });
      const before = await nativeSnapshot(f);
      const response = await request(httpServer(app))
        .post(`${f.base}/submit`)
        .set('Authorization', nativeAuth)
        .send({
          operationKey: `cancelled:${f.activityId}`,
          expectedDraftVersion: f.draftVersion,
          evidenceSealId: f.sealId,
          confirmation: true,
        });
      expectBizError(response, BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN);
      expect(await nativeSnapshot(f)).toEqual(before);
    });

    it('原生现场准入拒绝不存在/软删/停用成员，不建身份、占位或保险证据', async () => {
      const f = await onsiteScenario();
      const targets: Array<{
        id: string;
        error: typeof BizCode.MEMBER_NOT_FOUND | typeof BizCode.MEMBER_INACTIVE;
      }> = [{ id: 'cl0000000000000000000000', error: BizCode.MEMBER_NOT_FOUND }];
      for (const state of ['deleted', 'inactive'] as const) {
        const member = await prisma.member.create({
          data: {
            memberNo: `att-native-${state}`,
            ...memberIdentityData(`Invalid ${state}`),
            status: state === 'inactive' ? 'INACTIVE' : 'ACTIVE',
            deletedAt: state === 'deleted' ? new Date() : null,
          },
        });
        targets.push({
          id: member.id,
          error: state === 'deleted' ? BizCode.MEMBER_NOT_FOUND : BizCode.MEMBER_INACTIVE,
        });
      }
      const before = await onsiteSnapshot(f);
      for (const target of targets) {
        expectBizError(await onsite(f, target.id), target.error);
        expect(await onsiteSnapshot(f)).toEqual(before);
      }
    });

    it('原生角色由岗位事实决定，submit 不能夹带 roleCode 且拒绝零写', async () => {
      await expectNativeDtoRejection('submit', { roleCode: 'no-such-role' });
    });

    it('原生认定拒绝未知 resultCode，也不接受旧 attendanceStatusCode 字段', async () => {
      // Native absence decisions are valid enum members; the retired DTO's
      // present-only restriction is not the native result-code contract.
      await expectNativeDtoRejection('edit', { resultCode: 'no-such-result' });
      await expectNativeDtoRejection('edit', { attendanceStatusCode: 'absent' });
    });

    it('原生签退不得等于或早于签到，拒绝零写；满30分钟可闭合真实段', async () => {
      const start = Date.now() - 3.5 * 3_600_000;
      const f = await onsiteScenario(false, new Date(start));
      // Deliberately overlap the configured windows to exercise ordering/
      // duration validation rather than fail at the earlier window guard.
      await prisma.activitySession.update({
        where: { id: f.sessionId },
        data: { checkOutOpenAt: new Date(start - 30 * 60_000) },
      });
      const input = await nativeImportSource(f, memberCId);
      const command = app.get(AttendancePunchCommandService);
      await command.managedPunch({
        ...input,
        actionCode: 'check_in',
        eventKey: `ordered-in:${f.activityId}`,
        occurredAt: new Date(start),
      });
      const before = await onsiteSnapshot(f);
      const segments = () =>
        prisma.participantServiceSegmentRevision.findMany({
          where: { participationIdentityId: input.participationIdentityId },
          orderBy: { id: 'asc' },
        });
      const beforeSegments = await segments();
      for (const offset of [0, -1]) {
        await expect(
          command.managedPunch({
            ...input,
            actionCode: 'check_out',
            eventKey: `unordered-out:${f.activityId}:${offset}`,
            occurredAt: new Date(start + offset),
          }),
        ).rejects.toMatchObject({ biz: BizCode.ATTENDANCE_PUNCH_MIN_DURATION_NOT_REACHED });
        expect(await onsiteSnapshot(f)).toEqual(before);
        expect(await segments()).toEqual(beforeSegments);
      }
      expect(
        await command.managedPunch({
          ...input,
          actionCode: 'check_out',
          eventKey: `ordered-out:${f.activityId}`,
          occurredAt: new Date(start + 30 * 60_000),
        }),
      ).toMatchObject({ eventTypeCode: 'check_out', segmentStatusCode: 'closed_valid' });
      expect(await prisma.attendancePunchEvent.count({ where: { activityId: f.activityId } })).toBe(
        2,
      );
    });

    it('serviceHours <= 0 → ATTENDANCE_SERVICE_HOURS_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberCId,
              checkInAt: pastIso('06-01T12:00:00.000Z'),
              checkOutAt: pastIso('06-01T13:00:00.000Z'),
              serviceHours: 0,
            }),
          ],
        });
      // DTO 层 @Min(0.01) 直接 400
      expect(res.status).toBe(400);
    });

    it('serviceHours > 跨度 → ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberCId,
              checkInAt: pastIso('06-01T13:00:00.000Z'),
              checkOutAt: pastIso('06-01T14:00:00.000Z'),
              serviceHours: 5,
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN);
    });

    it('原生 R23：同成员的外活动报名头被复合外键拒绝，外活动场次也不可混用', async () => {
      const f = await onsiteScenario();
      const foreign = await onsiteScenario();
      const foreignReceipt = await admitWithOwnAnchor(foreign, memberAId);
      const foreignBefore = await onsiteSnapshot(foreign);
      await expectInvalidOnsiteAnchor(f, memberAId, foreignReceipt.registrationId);
      const before = await onsiteSnapshot(f);
      expectBizError(
        await onsite(f, memberAId, { sessionId: foreign.sessionId }),
        BizCode.BAD_REQUEST,
        { strictMessage: false },
      );
      expect(await onsiteSnapshot(f)).toEqual(before);
      expect(await onsiteSnapshot(foreign)).toEqual(foreignBefore);
      const accepted = await admitWithOwnAnchor(f, memberAId);
      expect(accepted.registrationId).not.toBe(foreignReceipt.registrationId);
    });

    it('原生 R23：不存在的报名头不能形成身份；正常准入建立真实锚点', async () => {
      const f = await onsiteScenario();
      await expectInvalidOnsiteAnchor(f, memberAId, 'cl0000000000000000000000');
      await admitWithOwnAnchor(f, memberAId);
    });

    it('原生 R23：同活动内不能借用其他成员的报名头，失败零写且正向对照可准入', async () => {
      const f = await onsiteScenario();
      const first = await admitWithOwnAnchor(f, memberAId);
      await expectInvalidOnsiteAnchor(f, memberBId, first.registrationId);
      const second = await admitWithOwnAnchor(f, memberBId);
      expect(second.registrationId).not.toBe(first.registrationId);
    });

    it('原生 pending 报名不是参加凭据，须通过现场准入追加 pass 修订和占位', async () => {
      const f = await onsiteScenario();
      const pending = await prisma.activityRegistration.create({
        data: { activityId: f.activityId, memberId: memberBId, statusCode: 'pending' },
        select: { id: true },
      });
      const before = await onsiteSnapshot(f);
      expect(
        await prisma.activityParticipationIdentity.count({
          where: { registrationId: pending.id },
        }),
      ).toBe(0);
      expectBizError(
        await onsite(f, memberBId, { registrationId: pending.id }),
        BizCode.BAD_REQUEST,
        { strictMessage: false },
      );
      expect(await onsiteSnapshot(f)).toEqual(before);
      const admitted = await admitWithOwnAnchor(f, memberBId);
      expect(admitted.registrationId).toBe(pending.id);
      expect(
        await prisma.activityRegistration.count({
          where: { activityId: f.activityId, memberId: memberBId },
        }),
      ).toBe(1);
      expect(
        await prisma.activityParticipationRevision.findUniqueOrThrow({
          where: { id: admitted.participationRevisionId },
        }),
      ).toMatchObject({ statusCode: 'pass', sourceCode: 'onsite' });
      expect(
        await prisma.capacityReservation.count({
          where: { identityId: admitted.participationIdentityId, status: 'active' },
        }),
      ).toBe(2);
      expect(await prisma.attendancePunchEvent.count({ where: { activityId: f.activityId } })).toBe(
        0,
      );
      expect(
        await prisma.participationLedgerEntry.count({ where: { activityId: f.activityId } }),
      ).toBe(0);
    });

    it('原生空报名锚点或空场次 ID 均在 DTO 拒绝，不能生成孤立身份', async () => {
      const f = await onsiteScenario();
      const before = await onsiteSnapshot(f);
      for (const extra of [{ registrationId: '' }, { sessionId: '' }]) {
        expectBizError(await onsite(f, memberBId, extra), BizCode.BAD_REQUEST, {
          strictMessage: false,
        });
        expect(await onsiteSnapshot(f)).toEqual(before);
      }
    });

    it.each(['check_in', 'check_out'] as const)(
      '原生 %s 窗口外1ms拒绝零写，精确边界允许',
      async (actionCode) => {
        const now = Date.now();
        const f = await onsiteScenario(false, new Date(now - 3.5 * 3_600_000));
        const input = await nativeImportSource(f, memberCId);
        const command = app.get(AttendancePunchCommandService);
        const session = await prisma.activitySession.findUniqueOrThrow({
          where: { id: f.sessionId },
        });
        if (actionCode === 'check_out') {
          await command.managedPunch({
            ...input,
            actionCode: 'check_in',
            eventKey: `window-in:${f.activityId}`,
            occurredAt: session.startAt,
          });
        }
        // Admit while the activity is open, then test historical import after
        // both windows have ended. This keeps the future-time guard from masking
        // the checkout upper-bound assertion. Only Date is faked, not DB/timers.
        jest.useFakeTimers({
          now: now + 6 * 3_600_000,
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
        try {
          const boundary =
            actionCode === 'check_in' ? session.checkInOpenAt : session.checkOutCloseAt;
          const outside = new Date(boundary.getTime() + (actionCode === 'check_in' ? -1 : 1));
          const before = await onsiteSnapshot(f);
          const segments = () =>
            prisma.participantServiceSegmentRevision.findMany({
              where: { participationIdentityId: input.participationIdentityId },
              orderBy: { id: 'asc' },
            });
          const beforeSegments = await segments();
          await expect(
            command.managedPunch({
              ...input,
              actionCode,
              eventKey: `outside:${f.activityId}`,
              occurredAt: outside,
            }),
          ).rejects.toMatchObject({ biz: BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW });
          expect(await onsiteSnapshot(f)).toEqual(before);
          expect(await segments()).toEqual(beforeSegments);
          expect(
            await command.managedPunch({
              ...input,
              actionCode,
              eventKey: `boundary:${f.activityId}`,
              occurredAt: boundary,
            }),
          ).toMatchObject({
            eventTypeCode: actionCode,
            segmentStatusCode: actionCode === 'check_in' ? 'open' : 'closed_valid',
          });
        } finally {
          jest.useRealTimers();
        }
      },
    );

    it('原生提交拒绝夹带201条旧 records，正常提交仅冻结服务端人口', async () => {
      // Native submit has no client-supplied records array. The retired
      // transport's 200-row limit is not a limit on native settlement population.
      const f = await expectNativeDtoRejection('submit', {
        records: Array.from({ length: 201 }, () => baseRecord()),
      });
      const { version, results } = await nativeSubmit(f);
      expect(version.personCount).toBe(1);
      expect(results).toHaveLength(1);
      expect(results[0].participationIdentityId).toBe(f.identityId);
    });

    it('原生提交不能以空 records 清空已有事实，省略旧字段后认定完整保留', async () => {
      const f = await expectNativeDtoRejection('submit', { records: [] });
      const { version, results } = await nativeSubmit(f);
      expect(version.personCount).toBe(1);
      expect(results).toHaveLength(1);
      expect(results[0].participationIdentityId).toBe(f.identityId);
      expect(results[0].calculatedServiceHours.toString()).toBe('2');
      expect(results[0].recognizedServiceHours.toString()).toBe('2');
    });

    it('原生 DTO submit: non-whitelisted statusCode → 400 且零写', async () => {
      await expectNativeDtoRejection('submit', { statusCode: 'approved' });
    });

    it('原生 DTO submit: non-whitelisted version → 400 且零写', async () => {
      await expectNativeDtoRejection('submit', { version: 99 });
    });

    it('原生 DTO submit: non-whitelisted previousSnapshot → 400 且零写', async () => {
      await expectNativeDtoRejection('submit', { previousSnapshot: { fake: true } });
    });

    it('原生 DTO submit: non-whitelisted submitterUserId → 400 且零写', async () => {
      await expectNativeDtoRejection('submit', { submitterUserId: 'cl0000000000000000000000' });
    });
  });

  // ============ 时间不重叠(R16 / Q-S15) ============

  describe('原生时间不重叠校验', () => {
    async function participant(label: string) {
      return prisma.member.create({
        data: {
          memberNo: `att-overlap-${label}`,
          ...memberIdentityData(`Overlap ${label}`),
          status: 'ACTIVE',
          gradeCode: 'level-2',
        },
      });
    }
    async function ready(f: Awaited<ReturnType<typeof nativeDraft>>) {
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-approve').expect(200);
      await nativeReview(version, 'final-approve').expect(200);
      return nativePrepare(version.id);
    }
    async function conflict(label: string, spans: Array<{ start: number; end: number }>) {
      const member = await participant(label);
      const f = await nativeDraft([member.id], 2, 'att-native', 'member', spans);
      const before = await nativeSnapshot(f);
      const draftId = before.versions.find((row) => row.version === f.draftVersion)!.id;
      expect(before.results.filter((row) => row.settlementVersionId === draftId)).toHaveLength(0);
      expect(before.punches).toHaveLength(spans.length * 2);
      const response = await request(httpServer(app))
        .post(`${f.base}/submit`)
        .set('Authorization', nativeAuth)
        .send({
          operationKey: `conflict:${f.activityId}`,
          expectedDraftVersion: f.draftVersion,
          evidenceSealId: f.sealId,
          confirmation: true,
        });
      expectBizError(response, BizCode.SETTLEMENT_SUBMIT_PENDING_RESULT);
      expect(await nativeSnapshot(f)).toEqual(before);
      expect(before.ledgerCount).toBe(0);
      return before;
    }

    it('完全重叠事实保持未决，不生成认定或正式时长，送审拒绝零写', async () => {
      await conflict('full', [
        { start: 0, end: 2 },
        { start: 0, end: 2 },
      ]);
    });

    it('部分重叠事实不能静默选一段入账，送审拒绝且原始证据不变', async () => {
      await conflict('partial', [
        { start: 0, end: 2 },
        { start: 1, end: 3 },
      ]);
    });

    it('左闭右开：同一时刻签退/再签到允许，真实入账恰为两段之和', async () => {
      const member = await participant('adjacent');
      const f = await nativeDraft([member.id], 2, 'att-native', 'member', [
        { start: 0, end: 2 },
        { start: 2, end: 4 },
      ]);
      const batch = await ready(f);
      await nativeCommit(batch.id);
      const sum = await prisma.participationLedgerEntry.aggregate({
        where: { postingBatchId: batch.id, entryTypeCode: 'service_credit' },
        _sum: { serviceHoursDelta: true },
      });
      expect(sum._sum.serviceHoursDelta?.toString()).toBe('4');
      const after = await nativeSnapshot(f);
      expect(after.segments.filter((row) => row.statusCode !== 'superseded')).toHaveLength(2);
      expect(after.punches).toHaveLength(4);
    });

    it('跨活动同人重叠在正式提交拒绝22060，两个活动、分录与日累计均不变', async () => {
      const member = await participant('cross');
      const first = await nativeDraft([member.id]);
      await nativeCommit((await ready(first)).id);
      const second = await nativeDraft([member.id], 1, 'att-native', 'member', [
        { start: 1.5, end: 2.5 },
      ]);
      const batch = await ready(second);
      const before = await nativeSnapshot(second);
      const firstBefore = await nativeSnapshot(first);
      const totals = await prisma.memberContributionDayState.findMany({
        where: { memberId: member.id },
        orderBy: { id: 'asc' },
      });
      await expect(nativeCommit(batch.id)).rejects.toMatchObject({
        biz: BizCode.ATTENDANCE_TIME_OVERLAP,
      });
      expect(await nativeSnapshot(second)).toEqual(before);
      expect(await nativeSnapshot(first)).toEqual(firstBefore);
      expect(
        await prisma.memberContributionDayState.findMany({
          where: { memberId: member.id },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(totals);
      expect(
        await prisma.participationLedgerEntry.count({
          where: { activityId: second.activityId, postingBatch: { statusCode: 'committed' } },
        }),
      ).toBe(0);
    });

    it('同批既有有效段又有内部重叠时整笔阻断，不部分入账', async () => {
      const before = await conflict('internal', [
        { start: 0, end: 1 },
        { start: 1, end: 3 },
        { start: 2, end: 4 },
      ]);
      expect(before.segments.length).toBeGreaterThan(0);
    });
  });

  // ============ GET list / detail ============

  describe('原生结算只读元数据与防枚举', () => {
    it('入账进度存在时可读；不存在版本拒绝且无读取审计或其他写入', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-approve').expect(200);
      await nativeReview(version, 'final-approve').expect(200);
      const control = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-settlements/${version.id}/posting-batch`)
        .set('Authorization', finalAdminAuth)
        .expect(200);
      expect(control.body.data).toMatchObject({
        settlementVersionId: version.id,
        effective: false,
      });
      const before = await nativeSnapshot(f);
      const response = await request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements/cl0000000000000000000000/posting-batch')
        .set('Authorization', finalAdminAuth);
      expectBizError(response, BizCode.RBAC_FORBIDDEN);
      expect(await nativeSnapshot(f)).toEqual(before);
    });

    it('版本元数据正常返回，不混入旧 records/previousSnapshot/deletedAt', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      const response = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-settlements/${version.id}/review-detail`)
        .set('Authorization', finalAdminAuth)
        .expect(200);
      expect(response.body.data.version).toMatchObject({
        id: version.id,
        version: version.version,
        statusCode: 'submitted',
        personCount: 1,
      });
      for (const field of ['records', 'previousSnapshot', 'deletedAt']) {
        expect(response.body.data).not.toHaveProperty(field);
        expect(response.body.data.version).not.toHaveProperty(field);
      }
    });

    it('审核详情存在时可读；不存在版本保持防枚举与失败零写', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      await request(httpServer(app))
        .get(`/api/admin/v1/attendance-settlements/${version.id}/review-detail`)
        .set('Authorization', finalAdminAuth)
        .expect(200);
      const before = await nativeSnapshot(f);
      const response = await request(httpServer(app))
        .get('/api/admin/v1/attendance-settlements/cl0000000000000000000000/review-detail')
        .set('Authorization', finalAdminAuth);
      expectBizError(response, BizCode.RBAC_FORBIDDEN);
      expect(await nativeSnapshot(f)).toEqual(before);
    });
  });

  describe('GET list / detail', () => {
    let createdId: string;

    beforeAll(async () => {
      createdId = await createPendingSheet(activityId, [
        baseRecord({
          memberId: memberCId,
          checkInAt: pastIso('06-10T08:00:00.000Z'),
          checkOutAt: pastIso('06-10T10:00:00.000Z'),
        }),
      ]);
    });

    it('GET list:activity 不存在 → ACTIVITY_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/activities/cl0000000000000000000000/attendance-sheets')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });

    it('GET list 主路径:分页返回 + statusCode=pending 过滤', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .query({ statusCode: 'pending' })
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      const statuses = (res.body.data.items as Array<{ statusCode: string }>).map(
        (i) => i.statusCode,
      );
      for (const s of statuses) expect(s).toBe('pending');
    });

    it('GET review-detail:Activity 摘要 + Sheet + Records 完整(R25)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-sheets/${createdId}/review-detail`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.activity).toBeDefined();
      expect(res.body.data.activity.id).toBe(activityId);
      expect(res.body.data.activity.title).toBe('ATT-MAIN');
      expect(res.body.data.sheet).toBeDefined();
      expect(res.body.data.sheet.id).toBe(createdId);
      expect(Array.isArray(res.body.data.records)).toBe(true);
      expect(res.body.data.records.length).toBe(1);
      // record 嵌套含 member 摘要
      expect(res.body.data.records[0].member).toBeDefined();
      expect(res.body.data.records[0].member.memberNo).toBeTruthy();
      expect(res.body.data.records[0].member.realName).toBeTruthy();
      expect(res.body.data.records[0].member.label).toBeTruthy();
      // Decimal 序列化为 string
      expect(typeof res.body.data.records[0].serviceHours).toBe('string');
    });
  });

  // ============ PATCH edit ============

  describe('PATCH edit', () => {
    it('原生工作草稿认定递增 revision 并保留机器值与审计；送审后禁止原地改写', async () => {
      const f = await nativeDraft([memberCId]);
      const before = await nativeSnapshot(f);
      const draftId = before.versions.find((row) => row.version === f.draftVersion)!.id;
      const original = before.results.find((row) => row.settlementVersionId === draftId)!;
      const edit = () =>
        request(httpServer(app))
          .patch(`${f.base}/items/${f.identityId}`)
          .set('Authorization', nativeAuth)
          .send({
            expectedDraftVersion: f.draftVersion,
            resultCode: 'present',
            recognizedServiceHours: 1.5,
            recognizedContributionPoints: 1,
            reason: '扣除半小时休息',
          });
      await edit().expect(200);
      const updated = await prisma.participantSettlementResultRevision.findUniqueOrThrow({
        where: { id: original.id },
      });
      expect(updated.revision).toBe(original.revision + 1);
      expect(updated.calculatedServiceHours.toString()).toBe('2');
      expect(updated.recognizedServiceHours.toString()).toBe('1.5');
      const audits = await prisma.auditLog.findMany({
        where: {
          resourceId: f.activityId,
          event: 'activity.publish',
          context: { path: ['extra', 'operation'], equals: 'settlement-draft-item-update' },
        },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorUserId: nativeUserId,
        resourceType: 'activity',
        context: {
          before: { revision: original.revision, recognizedServiceHours: '2' },
          after: { revision: original.revision + 1, recognizedServiceHours: '1.5' },
          extra: { settlementVersionId: draftId, participationIdentityId: f.identityId },
        },
      });
      expect(JSON.stringify(audits[0].context)).not.toContain('扣除半小时休息');
      const submitted = await nativeSubmit(f);
      expect(submitted.results[0].recognizedServiceHours.toString()).toBe('1.5');
      const frozen = await nativeSnapshot(f);
      expectBizError(await edit(), BizCode.SETTLEMENT_DRAFT_UPDATE_RUN_STATUS_INVALID);
      expect(await nativeSnapshot(f)).toEqual(frozen);
    });

    it('原生已终审及实际入账后均不能原地编辑，已生效分录保持不变', async () => {
      const member = await prisma.member.create({
        data: {
          memberNo: 'att-native-frozen',
          ...memberIdentityData('Frozen Participant'),
          status: 'ACTIVE',
          gradeCode: 'level-2',
        },
      });
      const f = await nativeDraft([member.id]);
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-approve').expect(200);
      await nativeReview(version, 'final-approve').expect(200);
      const edit = () =>
        request(httpServer(app))
          .patch(`${f.base}/items/${f.identityId}`)
          .set('Authorization', nativeAuth)
          .send({
            expectedDraftVersion: f.draftVersion,
            resultCode: 'present',
            recognizedServiceHours: 1.5,
            recognizedContributionPoints: 1,
            reason: '已审核后改写尝试',
          });
      const approved = await nativeSnapshot(f);
      expectBizError(await edit(), BizCode.SETTLEMENT_DRAFT_UPDATE_RUN_STATUS_INVALID);
      expect(await nativeSnapshot(f)).toEqual(approved);
      const batch = await nativePrepare(version.id);
      await nativeCommit(batch.id);
      const ledger = await prisma.participationLedgerEntry.findMany({
        where: { activityId: f.activityId },
        orderBy: { id: 'asc' },
      });
      expect(ledger.length).toBeGreaterThan(0);
      const posted = await nativeSnapshot(f);
      expectBizError(await edit(), BizCode.SETTLEMENT_DRAFT_UPDATE_RUN_STATUS_INVALID);
      expect(await nativeSnapshot(f)).toEqual(posted);
      expect(
        await prisma.participationLedgerEntry.findMany({
          where: { activityId: f.activityId },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(ledger);
    });

    it('原生退回版本与旧 rejected 历史不接受旧编辑入口或 ID 别名', async () => {
      await expectRetiredMutation({
        action: 'edit',
        legacyStatus: 'rejected',
        nativeStage: 'first-returned',
      });
    });

    it('原生编辑不存在或其他活动身份均拒绝，两边事实与审计不变', async () => {
      const f = await nativeDraft([memberCId]);
      const foreign = await nativeDraft([memberBId]);
      const before = await nativeSnapshot(f);
      const foreignBefore = await nativeSnapshot(foreign);
      for (const identityId of ['cl0000000000000000000000', foreign.identityId]) {
        const response = await request(httpServer(app))
          .patch(`${f.base}/items/${identityId}`)
          .set('Authorization', nativeAuth)
          .send({
            expectedDraftVersion: f.draftVersion,
            resultCode: 'present',
            recognizedServiceHours: 1.5,
            recognizedContributionPoints: 1,
            reason: '身份不存在',
          });
        expectBizError(response, BizCode.ACTIVITY_NOT_FOUND);
        expect(await nativeSnapshot(f)).toEqual(before);
        expect(await nativeSnapshot(foreign)).toEqual(foreignBefore);
      }
    });

    it('原生重生成按当前 legacy 规则重算，旧草稿结果保留，新提交冻结新值', async () => {
      const rule = await prisma.contributionRule.create({
        data: {
          activityTypeCode: 'att-demo',
          attendanceRoleCode: 'info',
          durationThreshold: null,
          pointsBelow: 0.4,
          pointsAbove: null,
          dailyCap: null,
          status: 'ACTIVE',
        },
      });
      try {
        const f = await nativeDraft([memberBId], 2, 'att-demo', 'info');
        const before = await nativeSnapshot(f);
        const draftId = before.versions.find((row) => row.version === f.draftVersion)!.id;
        const original = before.results.filter((row) => row.settlementVersionId === draftId);
        expect(original).toHaveLength(1);
        expect(original[0].calculatedContributionPoints.toString()).toBe('0.4');
        await prisma.contributionRule.update({
          where: { id: rule.id },
          data: { pointsBelow: 0.9 },
        });
        const generated = await request(httpServer(app))
          .post(`${f.base}/generate`)
          .set('Authorization', nativeAuth)
          .send({ operationKey: `recalculate:${f.activityId}` })
          .expect(200);
        const nextVersion = generated.body.data.settlementVersion as number;
        expect(nextVersion).toBeGreaterThan(f.draftVersion);
        const after = await nativeSnapshot(f);
        expect(after.results.filter((row) => row.settlementVersionId === draftId)).toEqual(
          original,
        );
        const submitted = await nativeSubmit({ ...f, draftVersion: nextVersion });
        expect(submitted.results[0].calculatedContributionPoints.toString()).toBe('0.9');
        expect(submitted.results[0].recognizedContributionPoints.toString()).toBe('0.9');
      } finally {
        await prisma.contributionRule.delete({ where: { id: rule.id } });
      }
    });

    // The retired DTO's nullable field normalization is not a native editing
    // capability. Preserve its business obligations through real admission:
    // no preregistration is required without insurance, and source evidence
    // cannot be unlinked. Historical timestamp editing remains a separate gap.
    describe('原生报名来源保护与待补时间纠错', () => {
      it('原生无需保险可无预报名参加，但永久身份来源不能被 null 清除或重放改写', async () => {
        const f = await onsiteScenario(false);
        expect(
          await prisma.activityRegistration.count({ where: { activityId: f.activityId } }),
        ).toBe(0);
        const receipt = await admitWithOwnAnchor(f, memberBId);
        expect(
          await prisma.insuranceEligibilityEvidence.count({
            where: { activityRegistrationId: receipt.registrationId },
          }),
        ).toBe(0);
        await expectNativeAnchorCannotBeCleared(f, memberBId, receipt);
      });

      it('原生需保险时缺来源拒绝；准入后的报名锚点及保险证据不能被 null 清除', async () => {
        const f = await onsiteScenario(true);
        const before = await onsiteSnapshot(f);
        expectBizError(await onsite(f, memberBId), BizCode.INSURANCE_REQUIRED);
        expect(await onsiteSnapshot(f)).toEqual(before);
        const insurance = await prisma.memberInsurance.create({
          data: {
            memberId: memberBId,
            insurerName: 'Fixture insurance',
            policyNumber: 'ATT-NATIVE-ANCHOR-INSURANCE',
            coverageStart: new Date(Date.now() - 86_400_000),
            coverageEnd: new Date(Date.now() + 7 * 86_400_000),
            reviewStatusCode: 'verified',
            reviewedByUserId: nativeUserId,
            reviewedAt: new Date(),
          },
        });
        const receipt = await admitWithOwnAnchor(f, memberBId);
        const evidence = await prisma.insuranceEligibilityEvidence.findMany({
          where: { activityRegistrationId: receipt.registrationId },
        });
        expect(evidence).toHaveLength(1);
        expect(evidence[0]).toMatchObject({
          memberInsuranceId: insurance.id,
          activityRegistrationRevisionId: receipt.registrationRevisionId,
        });
        await expectNativeAnchorCannotBeCleared(f, memberBId, receipt);
      });

      it('edit pending Sheet 记录越过活动时间窗 → ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW', async () => {
        const id = await createPendingSheet(activityId, [
          baseRecord({
            memberId: memberCId,
            checkInAt: pastIso('06-17T08:00:00.000Z'),
            checkOutAt: pastIso('06-17T09:00:00.000Z'),
          }),
        ]);

        const res = await request(httpServer(app))
          .patch(`/api/admin/v1/attendance-sheets/${id}`)
          .set('Authorization', adminAuth)
          .send({
            records: [
              baseRecord({
                memberId: memberCId,
                checkInAt: earlierIso('06-01T05:59:59.999Z'),
                checkOutAt: earlierIso('06-01T09:00:00.000Z'),
              }),
            ],
          });
        expectBizError(res, BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW);

        const activeRecords = await prisma.attendanceRecord.findMany({
          where: { sheetId: id, deletedAt: null },
        });
        expect(activeRecords).toHaveLength(1);
        expect(activeRecords[0].checkInAt.toISOString()).toBe(pastIso('06-17T08:00:00.000Z'));
      });
    });

    it('原生 DTO edit: non-whitelisted statusCode → 400 且零写', async () => {
      await expectNativeDtoRejection('edit', { statusCode: 'approved' });
    });

    it('原生 DTO edit: non-whitelisted version → 400 且零写', async () => {
      await expectNativeDtoRejection('edit', { version: 99 });
    });

    it('原生 DTO edit: non-whitelisted previousSnapshot → 400 且零写', async () => {
      await expectNativeDtoRejection('edit', { previousSnapshot: { fake: true } });
    });

    it('原生 DTO edit: reviewNote 必须走独立审核命令 → 400 且零写', async () => {
      await expectNativeDtoRejection('edit', { reviewNote: 'should be rejected' });
    });
  });

  // ============ DELETE softDelete ============

  describe('DELETE softDelete', () => {
    it('原生已提交版本与旧 pending 历史均不再接受旧删除或级联软删', async () => {
      await expectRetiredMutation({ action: 'delete' });
    });

    it('原生终审版本、准备批次与旧 approved 历史不能被旧删除入口改变', async () => {
      await expectRetiredMutation({
        action: 'delete',
        legacyStatus: 'approved',
        nativeStage: 'approved',
      });
    });

    it('原生退回版本、原因、working draft 与旧 rejected 历史在删除尝试后不变', async () => {
      await expectRetiredMutation({
        action: 'delete',
        legacyStatus: 'rejected',
        nativeStage: 'first-returned',
      });
    });

    it('原生历史存在时删除未知 ID 仍为退役路由 40400，无业务副作用', async () => {
      await expectRetiredMutation({ action: 'delete', missing: true });
    });
  });

  // ============ PATCH approve ============

  describe('PATCH approve', () => {
    it('原生应计分却无有效规则 → 送审前阻断，不能把未认定贡献带到审核', async () => {
      const f = await nativeDraft([memberCId], 2, 'att-native-no-rule');
      const before = await nativeSnapshot(f);
      const response = await request(httpServer(app))
        .post(`${f.base}/submit`)
        .set('Authorization', nativeAuth)
        .send({
          operationKey: `missing-rule:${f.activityId}`,
          expectedDraftVersion: f.draftVersion,
          evidenceSealId: f.sealId,
          confirmation: true,
        });
      expectBizError(response, BizCode.SETTLEMENT_SUBMIT_MISSING_RULE);
      expect(await nativeSnapshot(f)).toEqual(before);
    });

    it('原生初审通过 → pending_final_review，记录审核人/时间/意见，无终审决定或入账', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-approve', 'looks good').expect(200);
      const after = await nativeSnapshot(f);
      expect(after.run.statusCode).toBe('pending_final_review');
      expect(after.reviews).toHaveLength(1);
      expect(after.reviews[0]).toMatchObject({
        stageCode: 'first',
        actionCode: 'approve',
        actorUserId: nativeFirstReviewerId,
        actedAt: expect.any(Date),
        note: 'looks good',
      });
      expect(after.batches).toHaveLength(0);
      expect(after.ledgerCount).toBe(0);
    });

    it('原生初审只允许精确重放；新命令不能再次决定且拒绝零写', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      const first = await nativeReview(version, 'first-approve').expect(200);
      const replay = await nativeReview(version, 'first-approve').expect(200);
      expect(replay.body.data).toMatchObject({
        replayed: true,
        reviewActionId: first.body.data.reviewActionId,
      });
      const before = await nativeSnapshot(f);
      expect(before.reviews).toHaveLength(1);
      const response = await nativeReview(version, 'first-approve', undefined, ':again');
      expectBizError(response, BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED);
      expect(await nativeSnapshot(f)).toEqual(before);
    });

    it('原生已退回版本不能改判通过，保留原决定与原因', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-return', '请补充认定依据').expect(200);
      const before = await nativeSnapshot(f);
      expect(before.versions.find((row) => row.id === version.id)).toMatchObject({
        statusCode: 'returned',
        returnReason: '请补充认定依据',
      });
      expectBizError(
        await nativeReview(version, 'first-approve'),
        BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED,
      );
      expect(await nativeSnapshot(f)).toEqual(before);
    });

    it('原生初审不存在版本 → 30100 防枚举且零写', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      const before = await nativeSnapshot(f);
      const response = await nativeReview(
        { ...version, id: 'cl0000000000000000000000' },
        'first-approve',
      );
      expectBizError(response, BizCode.RBAC_FORBIDDEN);
      expect(await nativeSnapshot(f)).toEqual(before);
    });
  });

  // ============ PATCH reject ============

  describe('PATCH reject', () => {
    it('原生初审退回留存原因和事实；旧硬驳回入口不能改写旧历史或新版 ID', async () => {
      const { f, version, legacySnapshot, history } = await expectRetiredMutation({
        action: 'reject',
        body: { reviewNote: '数据有误' },
      });
      const before = await nativeSnapshot(f);
      await nativeReview(version, 'first-return', '数据需补充').expect(200);
      const after = await nativeSnapshot(f);
      expect(after.run.statusCode).toBe('drafting');
      expect(after.versions.find((row) => row.id === version.id)).toMatchObject({
        statusCode: 'returned',
        returnFromStage: 'first',
        returnReason: '数据需补充',
      });
      expect(after.reviews).toEqual([
        expect.objectContaining({
          stageCode: 'first',
          actionCode: 'return',
          actorUserId: nativeFirstReviewerId,
          actedAt: expect.any(Date),
          note: '数据需补充',
        }),
      ]);
      expect(after.results).toEqual(before.results);
      expect(await legacySnapshot()).toEqual(history);
    });

    it('原生初审退回缺原因 → DTO 40000 且零写', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      const before = await nativeSnapshot(f);
      expectBizError(await nativeReview(version, 'first-return'), BizCode.BAD_REQUEST, {
        strictMessage: false,
      });
      expect(await nativeSnapshot(f)).toEqual(before);
    });

    it('原生初审已通过后不能改判初审退回，待终审状态与原决定不变', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-approve').expect(200);
      const before = await nativeSnapshot(f);
      expectBizError(
        await nativeReview(version, 'first-return', '改判尝试'),
        BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED,
      );
      expect(await nativeSnapshot(f)).toEqual(before);
    });

    it('原生初审退回不存在版本 → 防枚举 30100 且零写', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      const before = await nativeSnapshot(f);
      expectBizError(
        await nativeReview({ ...version, id: 'cl0000000000000000000000' }, 'first-return', 'x'),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(await nativeSnapshot(f)).toEqual(before);
    });
  });

  // ============ approved-only 事件 / 副作用 ============

  describe('原生正式时长的生效边界', () => {
    // Assert actual credit visibility; unresolved milestone notifications are
    // covered separately and are not claimed complete by these state checks.
    it('初审退回不产生已批准版本、入账批次或本人可见时长', async () => {
      const f = await nativeDraft([memberAId]);
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-return', '退回不入账').expect(200);
      const after = await nativeSnapshot(f);
      expect(after.versions.find((row) => row.id === version.id)?.statusCode).toBe('returned');
      expect(after.batches).toHaveLength(0);
      expect(after.ledgerCount).toBe(0);
      const response = await request(httpServer(app))
        .get('/api/app/v1/my/participation-ledger')
        .set('Authorization', userWithMemberAuth)
        .expect(200);
      expect(
        (response.body.data.items as Array<{ activityId: string }>).some(
          (row) => row.activityId === f.activityId,
        ),
      ).toBe(false);
    });

    it('初审通过只推进待终审，不产生本人可见时长或批次', async () => {
      const f = await nativeDraft([memberAId]);
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-approve').expect(200);
      const after = await nativeSnapshot(f);
      expect(after.run.statusCode).toBe('pending_final_review');
      expect(after.batches).toHaveLength(0);
      expect(after.ledgerCount).toBe(0);
      const response = await request(httpServer(app))
        .get('/api/app/v1/my/participation-ledger')
        .set('Authorization', userWithMemberAuth)
        .expect(200);
      expect(
        (response.body.data.items as Array<{ activityId: string }>).some(
          (row) => row.activityId === f.activityId,
        ),
      ).toBe(false);
    });
  });

  // ============ 批次 4-B 新增:终审 final-approve / final-reject ============
  // 详见 docs:
  //   - 批次4_贡献值业务规则_API草案.md v1.0 D-A2 / D-A5
  //   - 批次4_贡献值业务规则_schema草案评审决议表.md v1.0 D-S5 / D-S7

  describe('PATCH final-approve / final-reject(批次 4-B 终审)', () => {
    it('原生终审通过 → 版本 approved、run posting、批次 preparing，两个审核决定均保留', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-approve', 'first ok').expect(200);
      await nativeReview(version, 'final-approve', 'final ok').expect(200);
      const after = await nativeSnapshot(f);
      expect(after.run.statusCode).toBe('posting');
      expect(after.versions.find((row) => row.id === version.id)?.statusCode).toBe('approved');
      expect(after.reviews).toHaveLength(2);
      expect(after.reviews).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stageCode: 'first',
            actorUserId: nativeFirstReviewerId,
            note: 'first ok',
            actedAt: expect.any(Date),
          }),
          expect.objectContaining({
            stageCode: 'final',
            actorUserId: nativeFinalReviewerId,
            note: 'final ok',
            actedAt: expect.any(Date),
          }),
        ]),
      );
      expect(after.batches).toHaveLength(1);
      expect(after.batches[0]).toMatchObject({ statusCode: 'preparing', totalCount: 1 });
      expect(after.ledgerCount).toBe(0);
      expect(after.results.every((row) => row.statusCode === 'draft')).toBe(true);
    });

    it('原生终审与准备不提前让本人看到时长；真实账本提交后才可见', async () => {
      const f = await nativeDraft([memberAId]);
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-approve').expect(200);
      await nativeReview(version, 'final-approve').expect(200);
      const read = () =>
        request(httpServer(app))
          .get('/api/app/v1/my/participation-ledger')
          .set('Authorization', userWithMemberAuth)
          .expect(200);
      expect((await read()).body.data.total).toBe(0);
      const batch = await nativePrepare(version.id);
      expect(
        await prisma.participationLedgerEntry.count({ where: { postingBatchId: batch.id } }),
      ).toBeGreaterThan(0);
      expect((await read()).body.data.total).toBe(0);
      await nativeCommit(batch.id);
      const visible = await read();
      const rows = visible.body.data.items as Array<{
        activityId: string;
        entryTypeCode: string;
        serviceHoursDelta: number;
      }>;
      expect(
        rows.filter(
          (row) => row.activityId === f.activityId && row.entryTypeCode === 'service_credit',
        ),
      ).toEqual([expect.objectContaining({ serviceHoursDelta: 2 })]);
      expect(
        rows.some(
          (row) => row.activityId === f.activityId && row.entryTypeCode === 'contribution_credit',
        ),
      ).toBe(true);
      for (const row of rows) expect(row).not.toHaveProperty('memberId');
    });

    it('原生终审通过允许不填意见，决定持久化 null', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-approve').expect(200);
      await nativeReview(version, 'final-approve').expect(200);
      const action = await prisma.settlementReviewAction.findFirstOrThrow({
        where: { settlementVersionId: version.id, stageCode: 'final' },
      });
      expect(action).toMatchObject({
        actorUserId: nativeFinalReviewerId,
        actionCode: 'approve',
        note: null,
      });
    });

    it('原生终审精确重放复用决定与批次，新命令重复决定拒绝且零写', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-approve').expect(200);
      await nativeReview(version, 'final-approve').expect(200);
      const first = await nativeSnapshot(f);
      const replay = await nativeReview(version, 'final-approve').expect(200);
      expect(replay.body.data.replayed).toBe(true);
      const before = await nativeSnapshot(f);
      expect(before.reviews).toEqual(first.reviews);
      expect(before.batches).toEqual(first.batches);
      expectBizError(
        await nativeReview(version, 'final-approve', undefined, ':again'),
        BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED,
      );
      expect(await nativeSnapshot(f)).toEqual(before);
    });

    it('原生未初审版本不能跳到终审，拒绝零写', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      const before = await nativeSnapshot(f);
      expectBizError(
        await nativeReview(version, 'final-approve'),
        BizCode.SETTLEMENT_REVIEW_RUN_STATUS_INVALID,
      );
      expect(await nativeSnapshot(f)).toEqual(before);
    });

    it('原生终审退回的旧版本不能改判通过，原因和审核历史不变', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-approve').expect(200);
      await nativeReview(version, 'final-return', '退回补充证明').expect(200);
      const before = await nativeSnapshot(f);
      expect(before.versions.find((row) => row.id === version.id)).toMatchObject({
        statusCode: 'returned',
        returnFromStage: 'final',
        returnReason: '退回补充证明',
      });
      expect(before.reviews).toHaveLength(2);
      expectBizError(
        await nativeReview(version, 'final-approve'),
        BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED,
      );
      expect(await nativeSnapshot(f)).toEqual(before);
    });

    it('原生终审不存在版本保持防枚举，不生成决定、批次或审计', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      const before = await nativeSnapshot(f);
      expectBizError(
        await nativeReview({ ...version, id: 'cl0000000000000000000000' }, 'final-approve'),
        BizCode.RBAC_FORBIDDEN,
      );
      expect(await nativeSnapshot(f)).toEqual(before);
    });

    describe('原生退回与退役终态驳回边界', () => {
      it('旧终态驳回不能写入；原生终审退回留存人/时间/原因，不级联删除事实', async () => {
        const { f, version, legacySnapshot, history } = await expectRetiredMutation({
          action: 'final-reject',
          legacyStatus: 'pending_final_review',
          nativeStage: 'pending-final',
          body: { finalReviewNote: '终审驳回理由' },
        });
        const before = await nativeSnapshot(f);
        await nativeReview(version, 'final-return', '终审退回理由').expect(200);
        const after = await nativeSnapshot(f);
        expect(after.run.statusCode).toBe('drafting');
        expect(after.versions.find((row) => row.id === version.id)).toMatchObject({
          statusCode: 'returned',
          returnFromStage: 'final',
          returnReason: '终审退回理由',
        });
        expect(after.reviews.find((row) => row.stageCode === 'final')).toMatchObject({
          actorUserId: nativeFinalReviewerId,
          actedAt: expect.any(Date),
          note: '终审退回理由',
        });
        expect(after.results).toEqual(before.results);
        expect(after.ledgerCount).toBe(0);
        expect(await legacySnapshot()).toEqual(history);
      });

      it('原生终审退回缺原因必须拒绝且零写', async () => {
        const f = await nativeDraft([memberCId]);
        const { version } = await nativeSubmit(f);
        await nativeReview(version, 'first-approve').expect(200);
        const before = await nativeSnapshot(f);
        expectBizError(await nativeReview(version, 'final-return'), BizCode.BAD_REQUEST, {
          strictMessage: false,
        });
        expect(await nativeSnapshot(f)).toEqual(before);
      });

      it('原生终审退回的空串/空白原因均拒绝且零写', async () => {
        const f = await nativeDraft([memberCId]);
        const { version } = await nativeSubmit(f);
        await nativeReview(version, 'first-approve').expect(200);
        const before = await nativeSnapshot(f);
        for (const [note, error] of [
          ['', BizCode.BAD_REQUEST],
          ['   ', BizCode.SETTLEMENT_REVIEW_RETURN_REASON_REQUIRED],
        ] as const) {
          expectBizError(await nativeReview(version, 'final-return', note), error, {
            strictMessage: error !== BizCode.BAD_REQUEST,
          });
          expect(await nativeSnapshot(f)).toEqual(before);
        }
      });

      it('原生已终审退回的版本不能再次作出新决定，拒绝零写', async () => {
        const f = await nativeDraft([memberCId]);
        const { version } = await nativeSubmit(f);
        await nativeReview(version, 'first-approve').expect(200);
        await nativeReview(version, 'final-return', '首次退回').expect(200);
        const before = await nativeSnapshot(f);
        expectBizError(
          await nativeReview(version, 'final-return', '再次退回', ':again'),
          BizCode.SETTLEMENT_REVIEW_ALREADY_DECIDED,
        );
        expect(await nativeSnapshot(f)).toEqual(before);
      });

      it('旧终态历史拒绝编辑；原生只编辑 working draft，已退回版本与旧软删事实不变', async () => {
        const { f, version, legacySnapshot, history } = await expectRetiredMutation({
          action: 'edit',
          legacyStatus: 'final_rejected',
          nativeStage: 'final-returned',
        });
        const before = await nativeSnapshot(f);
        await request(httpServer(app))
          .patch(`${f.base}/items/${f.identityId}`)
          .set('Authorization', nativeAuth)
          .send({
            expectedDraftVersion: before.run.currentDraftVersion,
            resultCode: 'present',
            recognizedServiceHours: 1.5,
            recognizedContributionPoints: 1,
            reason: '扣除休息',
          })
          .expect(200);
        const after = await nativeSnapshot(f);
        expect(after.versions.find((row) => row.id === version.id)).toEqual(
          before.versions.find((row) => row.id === version.id),
        );
        expect(after.results.filter((row) => row.settlementVersionId === version.id)).toEqual(
          before.results.filter((row) => row.settlementVersionId === version.id),
        );
        const draftId = after.versions.find(
          (row) => row.version === after.run.currentDraftVersion,
        )!.id;
        expect(
          after.results
            .find((row) => row.settlementVersionId === draftId)
            ?.recognizedServiceHours.toString(),
        ).toBe('1.5');
        expect(await legacySnapshot()).toEqual(history);
      });

      it('原生退回版本与旧终态软删历史不能再经旧删除入口改变', async () => {
        await expectRetiredMutation({
          action: 'delete',
          legacyStatus: 'final_rejected',
          nativeStage: 'final-returned',
        });
      });

      it('原生待终审时不可改写 working draft 或送审结果，拒绝零写', async () => {
        const f = await nativeDraft([memberCId]);
        const { version } = await nativeSubmit(f);
        await nativeReview(version, 'first-approve').expect(200);
        const before = await nativeSnapshot(f);
        const response = await request(httpServer(app))
          .patch(`${f.base}/items/${f.identityId}`)
          .set('Authorization', nativeAuth)
          .send({
            expectedDraftVersion: before.run.currentDraftVersion,
            resultCode: 'present',
            recognizedServiceHours: 1.5,
            recognizedContributionPoints: 1,
            reason: '审核中偷改',
          });
        expectBizError(response, BizCode.SETTLEMENT_DRAFT_UPDATE_RUN_STATUS_INVALID);
        expect(await nativeSnapshot(f)).toEqual(before);
      });

      it('原生待终审版本和旧 pending_final_review 历史不能被旧删除入口抹去', async () => {
        await expectRetiredMutation({
          action: 'delete',
          legacyStatus: 'pending_final_review',
          nativeStage: 'pending-final',
        });
      });
    });
  });

  // ============ 批次 4-B 新增:D14 ContributionRule 预填 ============
  // 沿 D-S4 / D-A8 / 业务规则文档 §4

  describe('D14 ContributionRule 预填(批次 4-B)', () => {
    it('原生生成/提交按活动类型与岗位角色匹配 pointsBelow', async () => {
      // 直接造一条 ACTIVE 规则:activityType=att-demo / role=member / >=6h 1.5 / <6h 0.5
      const rule = await prisma.contributionRule.create({
        data: {
          activityTypeCode: 'att-demo',
          attendanceRoleCode: 'member',
          durationThreshold: 6,
          pointsBelow: 0.5,
          pointsAbove: 1.5,
          dailyCap: null,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      try {
        const { results } = await nativeSubmit(await nativeDraft([memberCId], 1, 'att-demo'));
        expect(results).toHaveLength(1);
        expect(results[0].calculatedContributionPoints.toString()).toBe('0.5');
        expect(results[0].recognizedContributionPoints.toString()).toBe('0.5');
      } finally {
        await prisma.contributionRule.delete({ where: { id: rule.id } });
      }
    });

    it('原生讲师岗位 8 小时取 pointsAbove，不按单条 dailyCap 截断规则原分', async () => {
      const rule = await prisma.contributionRule.create({
        data: {
          activityTypeCode: 'att-demo',
          attendanceRoleCode: 'instructor',
          durationThreshold: 6,
          pointsBelow: 1,
          pointsAbove: 3,
          dailyCap: 1.25, // 列保留但 calculator 不再读;不再每条封顶
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      try {
        const { results } = await nativeSubmit(
          await nativeDraft([memberCId], 8, 'att-demo', 'instructor'),
        );
        expect(results).toHaveLength(1);
        expect(results[0].calculatedServiceHours.toString()).toBe('8');
        expect(results[0].calculatedContributionPoints.toString()).toBe('3');
        expect(results[0].recognizedContributionPoints.toString()).toBe('3');
      } finally {
        await prisma.contributionRule.delete({ where: { id: rule.id } });
      }
    });

    it('原生未命中规则仍可生成零分草稿，必须显式标记 blocker', async () => {
      const f = await nativeDraft([memberCId], 1, 'att-demo', 'coach');
      const response = await request(httpServer(app))
        .get(`${f.base}/items`)
        .set('Authorization', nativeAuth)
        .expect(200);
      expect(response.body.data.items).toHaveLength(1);
      expect(response.body.data.items[0]).toMatchObject({
        calculatedContributionPoints: 0,
        recognizedContributionPoints: 0,
      });
      const result = await prisma.participantSettlementResultRevision.findFirstOrThrow({
        where: {
          participationIdentityId: f.identityId,
          settlementVersion: { settlementRunId: f.runId, version: f.draftVersion },
        },
      });
      expect(result.exceptionFlagsJson).toMatchObject({
        blockers: ['contribution_points_zero_no_effective_rule'],
      });
    });

    it('原生 DTO submit: 调用方不能夹带 contributionPoints 改写草稿认定', async () => {
      await expectNativeDtoRejection('submit', { contributionPoints: 0.8 });
    });

    it('原生 DTO submit: contributionPoints:null 同样被白名单拒绝且零写', async () => {
      await expectNativeDtoRejection('submit', { contributionPoints: null });
    });

    it('原生同 type×role 第二条 ACTIVE 被唯一约束拒绝，真实生成/提交保留原规则分', async () => {
      const rule1 = await prisma.contributionRule.create({
        data: {
          activityTypeCode: 'att-demo',
          attendanceRoleCode: 'front_command',
          durationThreshold: null,
          pointsBelow: 1.0,
          pointsAbove: null,
          dailyCap: null,
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      try {
        await expect(
          prisma.contributionRule.create({
            data: {
              activityTypeCode: 'att-demo',
              attendanceRoleCode: 'front_command',
              durationThreshold: 2,
              pointsBelow: 0.3,
              pointsAbove: 0.6,
              dailyCap: null,
              status: 'ACTIVE',
            },
          }),
        ).rejects.toMatchObject({ code: 'P2002' });

        const { results } = await nativeSubmit(
          await nativeDraft([memberCId], 1, 'att-demo', 'front_command'),
        );
        expect(results[0].calculatedContributionPoints.toString()).toBe('1');
        expect(results[0].recognizedContributionPoints.toString()).toBe('1');
      } finally {
        await prisma.contributionRule.delete({ where: { id: rule1.id } });
      }
    });
  });

  // ============ 审计刀1:考勤提交不再隐式推动 Activity.completed ============

  describe('Activity.completed 只允许显式状态机推动', () => {
    it('原生首次提交结算不隐式完结活动', async () => {
      const f = await nativeDraft([memberCId]);
      await nativeSubmit(f);
      expect((await nativeSnapshot(f)).activity.statusCode).toBe('published');
    });

    it('原生退回重提新版本不隐式完结活动，也不改写旧版本', async () => {
      const f = await nativeDraft([memberCId]);
      const { version } = await nativeSubmit(f);
      await nativeReview(version, 'first-return', '补充说明后重提').expect(200);
      const before = await nativeSnapshot(f);
      const response = await request(httpServer(app))
        .post(`${f.base}/versions/${version.id}/resubmit`)
        .set('Authorization', nativeAuth)
        .send({
          operationKey: `resubmit:${f.activityId}`,
          expectedDraftVersion: before.run.currentDraftVersion,
          evidenceSealId: f.sealId,
          confirmation: true,
        })
        .expect(200);
      expect(response.body.data.settlementVersionId).not.toBe(version.id);
      const after = await nativeSnapshot(f);
      expect(after.activity.statusCode).toBe('published');
      expect(after.versions.find((row) => row.id === version.id)).toEqual(
        before.versions.find((row) => row.id === version.id),
      );
      expect(after.results.filter((row) => row.settlementVersionId === version.id)).toEqual(
        before.results.filter((row) => row.settlementVersionId === version.id),
      );
      expect(
        after.versions.find((row) => row.id === response.body.data.settlementVersionId),
      ).toMatchObject({ statusCode: 'submitted', priorVersionId: version.id });
    });

    it('原生初审/终审退回均不改变活动 published 状态或产生正式时长', async () => {
      for (const stage of ['first-return', 'final-return'] as const) {
        const f = await nativeDraft([memberCId]);
        const { version } = await nativeSubmit(f);
        if (stage === 'final-return') await nativeReview(version, 'first-approve').expect(200);
        await nativeReview(version, stage, '退回说明').expect(200);
        const after = await nativeSnapshot(f);
        expect(after.activity.statusCode).toBe('published');
        expect(after.versions.find((row) => row.id === version.id)?.statusCode).toBe('returned');
        expect(after.ledgerCount).toBe(0);
      }
    });

    it('原生活动经显式完结后仍可提交已有现场事实，保持 completed', async () => {
      const f = await nativeDraft([memberCId]);
      await request(httpServer(app))
        .post(`/api/admin/v1/activities/${f.activityId}/complete`)
        .set('Authorization', nativeFinalAuth)
        .expect(200);
      expect((await nativeSnapshot(f)).activity.statusCode).toBe('completed');
      const { version } = await nativeSubmit(f);
      expect(version.statusCode).toBe('submitted');
      expect((await nativeSnapshot(f)).activity.statusCode).toBe('completed');
    });
  });

  describe('A7 正式更正生效链路（原 v0.47.0 reopen 旅程）', () => {
    it('提交/审核/准备不暂扣积分，失败整笔回滚，正式提交才切换且旧历史与入队决定保留', async () => {
      const member = await prisma.member.create({
        data: {
          memberNo: 'att-correction-a7',
          ...memberIdentityData('Correction Member'),
          status: 'ACTIVE',
          gradeCode: 'level-2',
        },
        select: { id: true },
      });
      const f = await nativeDraft([member.id], 2);
      const cycle = await prisma.teamJoinCycle.create({
        data: {
          year: new Date().getUTCFullYear() - 1,
          name: 'Reopen invariant',
          statusCode: 'closed',
        },
        select: { id: true },
      });
      const historicalAdmission = await prisma.teamJoinApplication.create({
        data: {
          cycleId: cycle.id,
          memberId: member.id,
          statusCode: 'joined',
          targetOrganizationIds: [],
          joinedAt: new Date(earlierIso('12-31T00:00:00.000Z')),
        },
        select: { id: true, statusCode: true, joinedAt: true },
      });

      const summary = async (): Promise<string> => {
        const res = await request(httpServer(app))
          .get(`/api/admin/v1/members/${member.id}/contribution-summary`)
          .set('Authorization', adminAuth);
        expect(res.status).toBe(200);
        return res.body.data.contributionPoints as string;
      };
      expect(await summary()).toBe('0');
      const { version, results } = await nativeSubmit(f);
      await nativeReview(version, 'first-approve').expect(200);
      await nativeReview(version, 'final-approve').expect(200);
      expect(await summary()).toBe('0');
      const batch = await nativePrepare(version.id);
      expect(await summary()).toBe('0');
      await nativeCommit(batch.id);
      expect(await summary()).toBe('1');
      const firstHistory = await nativeSnapshot(f);
      expect(firstHistory.entries).toHaveLength(2);

      // V1 point correction has an existing internal service boundary, not a
      // public Human HTTP command. Do not bypass Human's V2/V3 qualification.
      const correction = app.get(CorrectionApplicationService);
      const audit = app.get(CorrectionAuditRecorder);
      const meta = { requestId: 'a7-correction-acceptance', ip: null, ua: 'jest' };
      const actorSelect = { id: true, username: true, role: true, status: true, memberId: true };
      const owner = await prisma.user.findUniqueOrThrow({
        where: { id: nativeUserId },
        select: actorSelect,
      });
      const reviewer = await prisma.user.findUniqueOrThrow({
        where: { id: nativeFinalReviewerId },
        select: actorSelect,
      });
      const requestInput = {
        activityId: f.activityId,
        participationIdentityId: f.identityIds[0],
        requestTypeCode: 'points',
        requestedChangeJson: {
          schemaVersion: CORRECTION_CHANGE_SCHEMA_VERSION,
          results: [
            {
              participationIdentityId: f.identityIds[0],
              resultCode: 'present',
              recognizedServiceHours: '2.00',
              recognizedContributionPoints: '0.50',
              adjustmentReason: '复核认定分值，不改原始现场事实',
              lateFlag: false,
              earlyLeaveFlag: false,
            },
          ],
          segments: [],
        },
        reason: '认定贡献值更正',
        operationKey: `a7-submit:${f.activityId}`,
        requestHash: `a7-submit-hash:${f.activityId}`,
      };
      const state = async () => ({
        ...(await nativeSnapshot(f)),
        requests: await prisma.attendanceCorrectionRequest.findMany({
          where: { activityId: f.activityId },
          orderBy: { id: 'asc' },
        }),
        applications: await prisma.correctionApplication.findMany({
          where: { correctionRequest: { activityId: f.activityId } },
          orderBy: { id: 'asc' },
        }),
        dayStates: await prisma.memberContributionDayState.findMany({
          where: { memberId: member.id },
          orderBy: { ledgerDate: 'asc' },
        }),
      });
      const submitted = await correction.submit(requestInput, owner, meta);
      expect(submitted).toMatchObject({
        statusCode: 'pending',
        baseSettlementVersionId: version.id,
        baseResultRevisionId: results[0].id,
        replayed: false,
      });
      expect(await summary()).toBe('1');
      const afterSubmit = await state();
      await expect(correction.submit(requestInput, owner, meta)).resolves.toMatchObject({
        replayed: true,
      });
      expect(await state()).toEqual(afterSubmit);
      await expect(
        correction.review(
          {
            correctionRequestId: submitted.correctionRequestId,
            actionCode: 'approve',
          },
          owner,
          meta,
        ),
      ).rejects.toMatchObject({ biz: BizCode.CORRECTION_REVIEW_SELF_FORBIDDEN });
      expect(await state()).toEqual(afterSubmit);
      await expect(
        correction.review(
          {
            correctionRequestId: submitted.correctionRequestId,
            actionCode: 'approve',
            note: '独立复核',
          },
          reviewer,
          meta,
        ),
      ).resolves.toMatchObject({ outcome: 'reviewed', statusCode: 'approved' });
      expect(await summary()).toBe('1');
      const applyInput = {
        correctionRequestId: submitted.correctionRequestId,
        operationKey: `a7-apply:${f.activityId}`,
        requestHash: `a7-apply-hash:${f.activityId}`,
      };
      const reviewed = await state();
      await expect(correction.prepare(applyInput, owner, meta)).rejects.toMatchObject({
        biz: BizCode.RBAC_FORBIDDEN,
      });
      expect(await state()).toEqual(reviewed);
      const prepared = await correction.prepare(applyInput, reviewer, meta);
      expect(prepared).toMatchObject({ batchStatus: 'ready', baseSettlementVersionId: version.id });
      expect(await summary()).toBe('1');
      const beforeFailure = await state();
      const writeCommitAudit = audit.logCommit.bind(audit);
      const fault = jest.spyOn(audit, 'logCommit').mockImplementationOnce(async (args) => {
        await writeCommitAudit(args);
        throw new Error('A7: fault after actual commit audit insert');
      });
      try {
        await expect(correction.commit(applyInput, reviewer, meta)).rejects.toThrow(
          'A7: fault after actual commit audit insert',
        );
        expect(fault).toHaveBeenCalledTimes(1);
      } finally {
        fault.mockRestore();
      }
      expect(await state()).toEqual(beforeFailure);
      expect(await summary()).toBe('1');

      const committed = await correction.commit(applyInput, reviewer, meta);
      expect(committed).toMatchObject({
        correctionStatus: 'applied',
        applicationStatus: 'committed',
        replayed: false,
        ledger: { batchStatus: 'committed' },
      });
      expect(await summary()).toBe('0.5');
      const finalState = await state();
      expect(finalState.run.currentPostedVersion).toBe(prepared.newSettlementVersion);
      expect(finalState.punches).toEqual(firstHistory.punches);
      expect(
        finalState.entries.filter((row) => firstHistory.entries.some((old) => old.id === row.id)),
      ).toEqual(firstHistory.entries);
      expect(finalState.entries).toHaveLength(
        firstHistory.entries.length + prepared.reversalEntryCount + prepared.replacementEntryCount,
      );
      expect(finalState.versions.find((row) => row.id === version.id)).toEqual(
        firstHistory.versions.find((row) => row.id === version.id),
      );
      const original = firstHistory.results.find((row) => row.id === results[0].id)!;
      expect(finalState.results.find((row) => row.id === original.id)).toEqual({
        ...original,
        statusCode: 'superseded',
        updatedAt: expect.any(Date),
      });
      expect(
        finalState.results.find(
          (row) => row.settlementVersionId === prepared.newSettlementVersionId,
        ),
      ).toMatchObject({
        baseResultRevisionId: original.id,
        correctionRequestId: submitted.correctionRequestId,
        recognizedContributionPoints: new Prisma.Decimal('0.50'),
        statusCode: 'committed',
      });
      expect(
        await prisma.auditLog.count({
          where: {
            resourceId: f.activityId,
            event: 'activity.publish',
            context: { path: ['extra', 'operation'], equals: 'correction-commit' },
          },
        }),
      ).toBe(1);
      await expect(correction.commit(applyInput, reviewer, meta)).resolves.toMatchObject({
        replayed: true,
      });
      expect(await state()).toEqual(finalState);
      // Even an exact successful command key cannot grant final-review authority.
      await expect(correction.commit(applyInput, owner, meta)).rejects.toMatchObject({
        biz: BizCode.RBAC_FORBIDDEN,
      });
      expect(await state()).toEqual(finalState);
      expect(await summary()).toBe('0.5');
      // Member result delivery is deferred A8, not a success assertion here.
      // Exact old notification requirements/source are retained in the decision handoff.
      expect(
        await prisma.teamJoinApplication.findUniqueOrThrow({
          where: { id: historicalAdmission.id },
          select: { statusCode: true, joinedAt: true },
        }),
      ).toEqual({
        statusCode: historicalAdmission.statusCode,
        joinedAt: historicalAdmission.joinedAt,
      });
    });
  });
});
