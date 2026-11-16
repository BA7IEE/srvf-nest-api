import type { INestApplication } from '@nestjs/common';
import { BindingScopeType, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { PrismaService } from '../../src/database/prisma.service';
import { NotificationOutboxWorker } from '../../src/modules/notifications/notification-outbox.worker';
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
  let outboxWorker: NotificationOutboxWorker;
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

  let memberAId: string;
  let memberBId: string;
  let memberCId: string;
  let otherMemberId: string;

  let activityId: string; // 主测试活动(published)
  let activityCancelledId: string; // 已取消活动
  let activityOtherId: string; // 另一活动(用于跨 activity 不重叠 + registration mismatch)

  let registrationAId: string; // memberA 在 activityId 的报名(用于 R23 正向)
  let registrationOtherActivityId: string; // memberA 在 activityOtherId 的报名(用于 R23 反向)

  beforeAll(async () => {
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    outboxWorker = app.get(NotificationOutboxWorker);

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

    // 另一活动(用于跨 activity 时间冲突 + R23 mismatch)
    const actOther = await request(httpServer(app))
      .post('/api/admin/v1/activities')
      .set('Authorization', adminAuth)
      .send({
        title: 'ATT-OTHER',
        activityTypeCode: ti.code,
        organizationId: childOrg.id,
        startAt: pastIso('06-02T08:00:00.000Z'),
        endAt: futureIso('06-30T18:00:00.000Z'),
        location: '演示',
        allocationModeCode: 'first_come',
      });
    activityOtherId = actOther.body.data.id;
    await request(httpServer(app))
      .patch(`/api/admin/v1/activities/${activityOtherId}/publish`)
      .set('Authorization', adminAuth)
      .send({ requiresInsuranceConfirmed: true });

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

    // 报名 memberA 到 activityOtherId(R23 反向:registration.activityId !== sheet.activityId)
    const reg2 = await request(httpServer(app))
      .post(`/api/admin/v1/activities/${activityOtherId}/registrations`)
      .set('Authorization', adminAuth)
      .send({ memberId: memberAId });
    registrationOtherActivityId = reg2.body.data.id;

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
    }
  });

  // ============ helpers ============

  async function nativeDraft(
    memberIds: string[],
    hours = 2,
    activityTypeCode = 'att-native',
    roleCode = 'member',
  ) {
    const f = await createSettlementDraftFixture(prisma, {
      organizationId: nativeOrganizationId,
      ownerMemberId: nativeOwnerId,
      actorUserId: nativeUserId,
      participantMemberIds: memberIds,
      activityTypeCode,
      sessionHours: Math.max(4, hours),
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
    const startAt = new Date('2020-03-01T00:00:00Z');
    const endAt = new Date(startAt.getTime() + hours * 3_600_000);
    // Explicit source facts, not prefilled expected results: generate must
    // replace the helper's two-hour draft with the time derived from punches.
    await prisma.attendancePunchEvent.createMany({
      data: identities.flatMap((identity) =>
        [
          { eventTypeCode: 'check_in', occurredAt: startAt },
          { eventTypeCode: 'check_out', occurredAt: endAt },
        ].map((event) => ({
          ...event,
          activityId: f.activityId,
          sessionId: identity.sessionId,
          participationIdentityId: identity.id,
          memberId: identity.memberId,
          positionId,
          sourceCode: 'staff_scan',
          operatorUserId: nativeUserId,
          receivedAt: event.occurredAt,
          eventKey: `${identity.id}-${event.eventTypeCode}`,
          requestHash: `${identity.id}-${event.eventTypeCode}`,
          evidenceRevision: 0,
        })),
      ),
    });
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
      ledgerCount,
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
      prisma.participationLedgerEntry.count({ where: { activityId: f.activityId } }),
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
      ledgerCount,
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

  // 在新建 sheet 后补 records contributionPoints(approve 前必填,R31)
  async function fillContributionPoints(sheetId: string, value = 1.0): Promise<void> {
    await prisma.attendanceRecord.updateMany({
      where: { sheetId, deletedAt: null },
      data: { contributionPoints: value },
    });
  }

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

  // 批次 4-B helper:推到 pending_final_review(APD 一级 approve)。
  async function approveToPendingFinalReview(sheetId: string): Promise<void> {
    const res = await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${sheetId}/approve`)
      .set('Authorization', adminAuth)
      .send({});
    if (res.status !== 200) {
      throw new Error(
        `approveToPendingFinalReview failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
  }

  // 批次 4-B helper:推到 approved 终态(APD 一级 approve + APD 部门部长 / 副部长 final-approve)。
  // 沿决议表 v1.0 D5 候选 B + D-S6:approved 语义升级为"终审通过"。
  // PR9/PR3:终审换 finalAdminAuth(submit 是 submitterAuth、一级审是 adminAuth,
  // 自审 22074/22081 与同人 22075 约束生效后
  // 同一人不能再终审)。
  async function approveToTerminalApproved(sheetId: string): Promise<void> {
    await approveToPendingFinalReview(sheetId);
    const res = await request(httpServer(app))
      .patch(`/api/admin/v1/attendance-sheets/${sheetId}/final-approve`)
      .set('Authorization', finalAdminAuth)
      .send({});
    if (res.status !== 200) {
      throw new Error(
        `approveToTerminalApproved failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
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

    it('requiresInsurance=false 时 submit 显式 registrationId:null → 按未传处理并持久化 null', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberBId,
              checkInAt: pastIso('09-01T08:00:00.000Z'),
              checkOutAt: pastIso('09-01T09:00:00.000Z'),
              registrationId: null,
            }),
          ],
        });
      expect(res.status).toBe(201);
      const record = await prisma.attendanceRecord.findFirstOrThrow({
        where: { sheetId: res.body.data.id, deletedAt: null },
        select: { registrationId: true },
      });
      expect(record.registrationId).toBeNull();
    });

    it('当前时刻提交未来考勤记录 → 22079', async () => {
      const checkInAt = new Date(Date.now() + 3_600_000);
      const checkOutAt = new Date(checkInAt.getTime() + 3_600_000);
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberBId,
              checkInAt: checkInAt.toISOString(),
              checkOutAt: checkOutAt.toISOString(),
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_CHECK_OUT_IN_FUTURE);
    });

    it('requiresInsurance=true 时省略或显式 null registrationId 拒绝;同活动同成员 pass 报名放行', async () => {
      await prisma.activity.update({
        where: { id: activityId },
        data: { requiresInsurance: true },
      });
      try {
        const withoutRegistration = await request(httpServer(app))
          .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
          .set('Authorization', adminAuth)
          .send({
            records: [
              baseRecord({
                memberId: memberAId,
                checkInAt: pastIso('07-20T08:00:00.000Z'),
                checkOutAt: pastIso('07-20T09:00:00.000Z'),
              }),
            ],
          });
        expectBizError(withoutRegistration, BizCode.ATTENDANCE_REGISTRATION_INVALID);

        const nullRegistration = await request(httpServer(app))
          .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
          .set('Authorization', adminAuth)
          .send({
            records: [
              baseRecord({
                memberId: memberAId,
                checkInAt: pastIso('07-20T08:00:00.000Z'),
                checkOutAt: pastIso('07-20T09:00:00.000Z'),
                registrationId: null,
              }),
            ],
          });
        expectBizError(nullRegistration, BizCode.ATTENDANCE_REGISTRATION_INVALID);

        const withRegistration = await request(httpServer(app))
          .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
          .set('Authorization', adminAuth)
          .send({
            records: [
              baseRecord({
                memberId: memberAId,
                checkInAt: pastIso('07-20T08:00:00.000Z'),
                checkOutAt: pastIso('07-20T09:00:00.000Z'),
                registrationId: registrationAId,
              }),
            ],
          });
        expect(withRegistration.status).toBe(201);
      } finally {
        await prisma.activity.update({
          where: { id: activityId },
          data: { requiresInsurance: false },
        });
      }
    });
  });

  // ============ POST submit 关键失败 ============

  describe('POST submit 关键失败', () => {
    it('activity 不存在 → ACTIVITY_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post('/api/admin/v1/activities/cl0000000000000000000000/attendance-sheets')
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberCId })] });
      expectBizError(res, BizCode.ACTIVITY_NOT_FOUND);
    });

    it('activity cancelled → ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN(20122)', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityCancelledId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberCId })] });
      expectBizError(res, BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN);
    });

    it('member 不存在 → MEMBER_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [baseRecord({ memberId: 'cl0000000000000000000000' })],
        });
      expectBizError(res, BizCode.MEMBER_NOT_FOUND);
    });

    it('roleCode 不存在 → ATTENDANCE_ROLE_CODE_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [baseRecord({ memberId: memberCId, roleCode: 'no-such-role' })],
        });
      expectBizError(res, BizCode.ATTENDANCE_ROLE_CODE_INVALID);
    });

    it('attendanceStatusCode 不存在 → ATTENDANCE_STATUS_CODE_INVALID(absent/leave 自动失败)', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [baseRecord({ memberId: memberCId, attendanceStatusCode: 'absent' })],
        });
      expectBizError(res, BizCode.ATTENDANCE_STATUS_CODE_INVALID);
    });

    it('checkOutAt <= checkInAt → CHECK_OUT_BEFORE_CHECK_IN', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberCId,
              checkInAt: pastIso('06-01T10:00:00.000Z'),
              checkOutAt: pastIso('06-01T10:00:00.000Z'),
            }),
          ],
        });
      expectBizError(res, BizCode.CHECK_OUT_BEFORE_CHECK_IN);
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

    it('R23 跨表:registrationId 不属于本活动 → ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH', async () => {
      // memberA 在 activityOtherId 有 reg,但 sheet 父活动是 activityId
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberAId,
              checkInAt: pastIso('06-01T16:00:00.000Z'),
              checkOutAt: pastIso('06-01T17:00:00.000Z'),
              registrationId: registrationOtherActivityId,
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH);
    });

    it('R23 跨表:registrationId 不存在 → MISMATCH', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberAId,
              checkInAt: pastIso('06-03T10:00:00.000Z'),
              checkOutAt: pastIso('06-03T12:00:00.000Z'),
              registrationId: 'cl0000000000000000000000',
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH);
    });

    it('registrationId 属于其他 member → ATTENDANCE_REGISTRATION_INVALID', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: memberBId,
              registrationId: registrationAId,
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_REGISTRATION_INVALID);
    });

    it('registrationId 对应报名非 pass → ATTENDANCE_REGISTRATION_INVALID', async () => {
      const pending = await prisma.activityRegistration.create({
        data: { activityId, memberId: memberBId, statusCode: 'pending' },
        select: { id: true },
      });
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [baseRecord({ memberId: memberBId, registrationId: pending.id })],
        });
      expectBizError(res, BizCode.ATTENDANCE_REGISTRATION_INVALID);
    });

    it('registrationId 空字符串 → ValidationPipe BAD_REQUEST', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberBId, registrationId: '' })] });
      expectBizError(res, BizCode.BAD_REQUEST, { strictMessage: false });
    });

    it.each([
      ['before tolerance', pastIso('06-01T05:59:59.999Z'), pastIso('06-01T09:00:00.000Z')],
      ['after tolerance', futureIso('07-31T16:00:00.000Z'), futureIso('07-31T20:00:00.001Z')],
    ])('%s → ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW', async (_label, checkInAt, checkOutAt) => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({ records: [baseRecord({ memberId: memberCId, checkInAt, checkOutAt })] });
      expectBizError(res, BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW);
    });

    it('records 201 条 → 400 DTO 上限', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({ records: Array.from({ length: 201 }, () => baseRecord()) });
      expect(res.status).toBe(400);
    });

    it('空 records 数组 → 400', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({ records: [] });
      expect(res.status).toBe(400);
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

  describe('时间不重叠校验', () => {
    let overlapMember: string;

    beforeAll(async () => {
      // 单独 member 隔离本段干扰
      const m = await prisma.member.create({
        data: { memberNo: 'att-m-overlap', ...memberIdentityData('Overlap M') },
        select: { id: true },
      });
      overlapMember = m.id;
      // 先入第一段:08:00 - 10:00
      await createPendingSheet(activityId, [
        baseRecord({
          memberId: overlapMember,
          checkInAt: pastIso('06-05T08:00:00.000Z'),
          checkOutAt: pastIso('06-05T10:00:00.000Z'),
        }),
      ]);
    });

    it('完全重叠 → 22060', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: overlapMember,
              checkInAt: pastIso('06-05T08:00:00.000Z'),
              checkOutAt: pastIso('06-05T10:00:00.000Z'),
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_TIME_OVERLAP);
    });

    it('部分重叠 → 22060', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: overlapMember,
              checkInAt: pastIso('06-05T09:00:00.000Z'),
              checkOutAt: pastIso('06-05T11:00:00.000Z'),
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_TIME_OVERLAP);
    });

    it('Q-S15 左闭右开:紧邻 endAt = startAt 允许', async () => {
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: overlapMember,
              checkInAt: pastIso('06-05T10:00:00.000Z'),
              checkOutAt: pastIso('06-05T12:00:00.000Z'),
            }),
          ],
        });
      expect(res.status).toBe(201);
    });

    it('跨 Sheet 跨 Activity 全局校验:不同 activity 但同 memberId 时间重叠 → 22060', async () => {
      // 在 activityOtherId 给 overlapMember 提交同时段 → 应被拒
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityOtherId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: overlapMember,
              checkInAt: pastIso('06-05T09:30:00.000Z'),
              checkOutAt: pastIso('06-05T10:30:00.000Z'),
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_TIME_OVERLAP);
    });

    it('数组内部重叠(同 batch 内同 memberId)→ 22060', async () => {
      const otherM = (
        await prisma.member.create({
          data: { memberNo: 'att-m-internal', ...memberIdentityData('Internal') },
          select: { id: true },
        })
      ).id;
      const res = await request(httpServer(app))
        .post(`/api/admin/v1/activities/${activityId}/attendance-sheets`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: otherM,
              checkInAt: pastIso('06-06T08:00:00.000Z'),
              checkOutAt: pastIso('06-06T10:00:00.000Z'),
            }),
            baseRecord({
              memberId: otherM,
              checkInAt: pastIso('06-06T09:00:00.000Z'),
              checkOutAt: pastIso('06-06T11:00:00.000Z'),
            }),
          ],
        });
      expectBizError(res, BizCode.ATTENDANCE_TIME_OVERLAP);
    });
  });

  // ============ GET list / detail ============

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

    it('GET detail:不存在 → ATTENDANCE_SHEET_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets/cl0000000000000000000000')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });

    it('GET detail:不返 records 数组(Sheet 简化)', async () => {
      const res = await request(httpServer(app))
        .get(`/api/admin/v1/attendance-sheets/${createdId}`)
        .set('Authorization', adminAuth);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(createdId);
      expect(res.body.data).not.toHaveProperty('records');
      expect(res.body.data).not.toHaveProperty('previousSnapshot');
      expect(res.body.data).not.toHaveProperty('deletedAt');
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

    it('GET review-detail:不存在 → ATTENDANCE_SHEET_NOT_FOUND', async () => {
      const res = await request(httpServer(app))
        .get('/api/admin/v1/attendance-sheets/cl0000000000000000000000/review-detail')
        .set('Authorization', adminAuth);
      expectBizError(res, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
    });
  });

  // ============ PATCH edit ============

  describe('PATCH edit', () => {
    // Keep the still-unmigrated legacy fixtures from blocking independent
    // native DTO checks. All legacy cases remain runnable and unchanged.
    describe('旧编辑流程（待迁移）', () => {
      let pendingId: string;
      let approvedId: string;
      let rejectedId: string;

      beforeAll(async () => {
        pendingId = await createPendingSheet(activityId, [
          baseRecord({
            memberId: memberCId,
            checkInAt: pastIso('06-15T08:00:00.000Z'),
            checkOutAt: pastIso('06-15T10:00:00.000Z'),
          }),
        ]);

        // approved Sheet(批次 4-B 升级:approve + finalApprove 才到 approved 终态):
        // create → fillContributionPoints → approveToTerminalApproved。
        approvedId = await createPendingSheet(activityId, [
          baseRecord({
            memberId: memberCId,
            checkInAt: pastIso('06-15T11:00:00.000Z'),
            checkOutAt: pastIso('06-15T12:00:00.000Z'),
          }),
        ]);
        await fillContributionPoints(approvedId);
        await approveToTerminalApproved(approvedId);

        // rejected Sheet(APD 一级驳回)
        rejectedId = await createPendingSheet(activityId, [
          baseRecord({
            memberId: memberCId,
            checkInAt: pastIso('06-15T13:00:00.000Z'),
            checkOutAt: pastIso('06-15T14:00:00.000Z'),
          }),
        ]);
        await request(httpServer(app))
          .patch(`/api/admin/v1/attendance-sheets/${rejectedId}/reject`)
          .set('Authorization', adminAuth)
          .send({ reviewNote: 'fixture reject' });
      });

      it('edit pending Sheet(替换 records)→ 200,version+1,previousSnapshot 后端写入', async () => {
        const before = await prisma.attendanceSheet.findUnique({ where: { id: pendingId } });
        expect(before?.version).toBe(1);
        expect(before?.previousSnapshot).toBeNull();

        const res = await request(httpServer(app))
          .patch(`/api/admin/v1/attendance-sheets/${pendingId}`)
          .set('Authorization', adminAuth)
          .send({
            records: [
              baseRecord({
                memberId: memberCId,
                checkInAt: pastIso('06-15T08:30:00.000Z'),
                checkOutAt: pastIso('06-15T09:30:00.000Z'),
              }),
            ],
          });
        expect(res.status).toBe(200);
        expect(res.body.data.version).toBe(2);

        const after = await prisma.attendanceSheet.findUnique({ where: { id: pendingId } });
        expect(after?.version).toBe(2);
        expect(after?.previousSnapshot).not.toBeNull();
        // snapshot 含 sheet + records 字段(Q-S16)
        const snap = after?.previousSnapshot as { sheet: unknown; records: unknown[] } | null;
        expect(snap?.sheet).toBeDefined();
        expect(Array.isArray(snap?.records)).toBe(true);
        expect(snap?.records.length).toBe(1);

        // 旧 records 软删,新 records 活跃 = 1
        const activeRecords = await prisma.attendanceRecord.findMany({
          where: { sheetId: pendingId, deletedAt: null },
        });
        expect(activeRecords.length).toBe(1);
        expect(activeRecords[0].checkInAt.toISOString()).toBe(pastIso('06-15T08:30:00.000Z'));
        const allRecords = await prisma.attendanceRecord.findMany({
          where: { sheetId: pendingId },
        });
        expect(allRecords.length).toBe(2); // 1 旧软删 + 1 新
      });

      it('requiresInsurance=false 时 edit 显式 registrationId:null → 按未传处理并持久化 null', async () => {
        const id = await createPendingSheet(activityId, [
          baseRecord({
            memberId: memberBId,
            checkInAt: pastIso('09-02T08:00:00.000Z'),
            checkOutAt: pastIso('09-02T09:00:00.000Z'),
          }),
        ]);
        const res = await request(httpServer(app))
          .patch(`/api/admin/v1/attendance-sheets/${id}`)
          .set('Authorization', adminAuth)
          .send({
            records: [
              baseRecord({
                memberId: memberBId,
                checkInAt: pastIso('09-02T08:00:00.000Z'),
                checkOutAt: pastIso('09-02T09:00:00.000Z'),
                registrationId: null,
              }),
            ],
          });
        expect(res.status).toBe(200);
        const record = await prisma.attendanceRecord.findFirstOrThrow({
          where: { sheetId: id, deletedAt: null },
          select: { registrationId: true },
        });
        expect(record.registrationId).toBeNull();
      });

      it('requiresInsurance=true 时 edit 显式 registrationId:null → ATTENDANCE_REGISTRATION_INVALID', async () => {
        const id = await createPendingSheet(activityId, [
          baseRecord({
            memberId: memberCId,
            checkInAt: pastIso('09-03T08:00:00.000Z'),
            checkOutAt: pastIso('09-03T09:00:00.000Z'),
          }),
        ]);
        await prisma.activity.update({
          where: { id: activityId },
          data: { requiresInsurance: true },
        });
        try {
          const res = await request(httpServer(app))
            .patch(`/api/admin/v1/attendance-sheets/${id}`)
            .set('Authorization', adminAuth)
            .send({
              records: [
                baseRecord({
                  memberId: memberCId,
                  checkInAt: pastIso('09-03T08:00:00.000Z'),
                  checkOutAt: pastIso('09-03T09:00:00.000Z'),
                  registrationId: null,
                }),
              ],
            });
          expectBizError(res, BizCode.ATTENDANCE_REGISTRATION_INVALID);
        } finally {
          await prisma.activity.update({
            where: { id: activityId },
            data: { requiresInsurance: false },
          });
        }
      });

      it('edit 替换 records 时重新按 ContributionRule 计算最终分值', async () => {
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
          select: { id: true },
        });
        try {
          const id = await createPendingSheet(activityId, [
            baseRecord({
              memberId: memberBId,
              roleCode: 'info',
              checkInAt: pastIso('08-10T08:00:00.000Z'),
              checkOutAt: pastIso('08-10T09:00:00.000Z'),
            }),
          ]);
          await prisma.contributionRule.update({
            where: { id: rule.id },
            data: { pointsBelow: 0.9 },
          });

          const edited = await request(httpServer(app))
            .patch(`/api/admin/v1/attendance-sheets/${id}`)
            .set('Authorization', adminAuth)
            .send({
              records: [
                baseRecord({
                  memberId: memberBId,
                  roleCode: 'info',
                  checkInAt: pastIso('08-10T08:00:00.000Z'),
                  checkOutAt: pastIso('08-10T09:00:00.000Z'),
                }),
              ],
            });
          expect(edited.status).toBe(200);
          const record = await prisma.attendanceRecord.findFirstOrThrow({
            where: { sheetId: id, deletedAt: null },
            select: { contributionPoints: true },
          });
          expect(record.contributionPoints?.toString()).toBe('0.9');
        } finally {
          await prisma.contributionRule.delete({ where: { id: rule.id } });
        }
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

      it('edit approved Sheet → 22040 ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE', async () => {
        const res = await request(httpServer(app))
          .patch(`/api/admin/v1/attendance-sheets/${approvedId}`)
          .set('Authorization', adminAuth)
          .send({ records: [baseRecord({ memberId: memberCId })] });
        expectBizError(res, BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE);
      });

      it('edit rejected Sheet → 22041 ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE', async () => {
        const res = await request(httpServer(app))
          .patch(`/api/admin/v1/attendance-sheets/${rejectedId}`)
          .set('Authorization', adminAuth)
          .send({ records: [baseRecord({ memberId: memberCId })] });
        expectBizError(res, BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE);
      });

      it('edit Sheet 不存在 → 22001', async () => {
        const res = await request(httpServer(app))
          .patch('/api/admin/v1/attendance-sheets/cl0000000000000000000000')
          .set('Authorization', adminAuth)
          .send({});
        expectBizError(res, BizCode.ATTENDANCE_SHEET_NOT_FOUND);
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
      const batch = await prisma.ledgerPostingBatch.findFirstOrThrow({
        where: { settlementVersionId: version.id },
      });
      const preparation = app.get(LedgerPreparationService);
      const { jobId } = await preparation.ensurePrepareJob(batch.id);
      for (const item of await prisma.activityBatchJobItem.findMany({ where: { jobId } })) {
        await preparation.prepareChunk(jobId, item.id);
      }
      expect((await preparation.finalize(jobId)).batchStatus).toBe('ready');
      expect(
        await prisma.participationLedgerEntry.count({ where: { postingBatchId: batch.id } }),
      ).toBeGreaterThan(0);
      expect((await read()).body.data.total).toBe(0);
      const actor = await prisma.user.findUniqueOrThrow({
        where: { id: nativeFinalReviewerId },
        select: { id: true, username: true, role: true, status: true, memberId: true },
      });
      expect(
        (
          await app
            .get(LedgerPostingService)
            .commitBatch({ postingBatchId: batch.id, operationKey: `commit:${batch.id}` }, actor, {
              requestId: 'native-acceptance-post',
              ip: null,
              ua: 'jest',
            })
        ).batchStatus,
      ).toBe('committed');
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

  describe('v0.47.0 attendance reopen 完整链路', () => {
    it('pending→approve→finalApprove→reopen→edit→approve→finalApprove;贡献值下降后恢复', async () => {
      const member = await prisma.member.create({
        data: { memberNo: 'att-reopen-m-001', ...memberIdentityData('Reopen Member') },
        select: { id: true },
      });
      const childOrg = await prisma.organization.findFirstOrThrow({
        where: { nodeTypeCode: 'att-child' },
        select: { id: true },
      });
      const activity = await prisma.activity.create({
        data: {
          title: 'ATT-REOPEN-FULL-CHAIN',
          activityTypeCode: 'att-demo',
          organizationId: childOrg.id,
          startAt: new Date(pastIso('01-05T08:00:00.000Z')),
          endAt: new Date(pastIso('01-05T18:00:00.000Z')),
          location: '重开链路',
          statusCode: 'published',
        },
        select: { id: true },
      });
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

      const sheetId = await createPendingSheet(activity.id, [
        baseRecord({
          memberId: member.id,
          checkInAt: pastIso('01-05T09:00:00.000Z'),
          checkOutAt: pastIso('01-05T10:00:00.000Z'),
        }),
      ]);
      await fillContributionPoints(sheetId, 1);
      await approveToPendingFinalReview(sheetId);
      const firstFinal = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/final-approve`)
        .set('Authorization', finalAdminAuth)
        .send({ finalReviewNote: '首次终审' });
      expect(firstFinal.status).toBe(200);
      expect(firstFinal.body.data.statusCode).toBe('approved');
      expect(await summary()).toBe('1');
      const firstIntent = await prisma.notificationOutboxIntent.findFirstOrThrow({
        where: {
          aggregateType: 'attendance_sheet',
          aggregateId: sheetId,
          status: 'pending',
        },
      });
      await outboxWorker.drainEventKey(firstIntent.eventKey);

      const notificationCountAfterFirstFinal = await prisma.notification.count({
        where: { recipientMemberId: member.id, deletedAt: null },
      });
      for (const invalidBody of [{}, { reason: '   ' }]) {
        expectBizError(
          await request(httpServer(app))
            .post(`/api/admin/v1/attendance-sheets/${sheetId}/reopen`)
            .set('Authorization', finalAdminAuth)
            .send(invalidBody),
          BizCode.BAD_REQUEST,
          { strictMessage: false },
        );
      }
      const reopen = await request(httpServer(app))
        .post(`/api/admin/v1/attendance-sheets/${sheetId}/reopen`)
        .set('Authorization', finalAdminAuth)
        .send({ reason: '  记录时间需要修订  ' });
      expect(reopen.status).toBe(200);
      expect(reopen.body.data).toMatchObject({
        statusCode: 'pending',
        reviewerUserId: null,
        reviewedAt: null,
        reviewNote: null,
        finalReviewerUserId: null,
        finalReviewedAt: null,
        finalReviewNote: null,
        version: 1,
      });
      expect(await summary()).toBe('0');
      expect(
        await prisma.notification.count({
          where: { recipientMemberId: member.id, deletedAt: null },
        }),
      ).toBe(notificationCountAfterFirstFinal);

      expectBizError(
        await request(httpServer(app))
          .post(`/api/admin/v1/attendance-sheets/${sheetId}/reopen`)
          .set('Authorization', finalAdminAuth)
          .send({ reason: '不能重复撤回' }),
        BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
      );

      const reopenAudit = await prisma.auditLog.findFirstOrThrow({
        where: { resourceId: sheetId, event: 'attendance-sheet.reopen' },
        orderBy: { createdAt: 'desc' },
      });
      const reopenContext = reopenAudit.context as {
        before?: { sheet?: { statusCode?: string }; records?: unknown[] };
        after?: { sheet?: { statusCode?: string }; records?: unknown[] };
        extra?: { reason?: string; recordsCount?: number };
      };
      expect(reopenContext.before?.sheet?.statusCode).toBe('approved');
      expect(reopenContext.after?.sheet?.statusCode).toBe('pending');
      expect(reopenContext.before?.records).toHaveLength(1);
      expect(reopenContext.after?.records).toHaveLength(1);
      expect(reopenContext.extra).toMatchObject({
        reason: '记录时间需要修订',
        recordsCount: 1,
      });

      const edited = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}`)
        .set('Authorization', adminAuth)
        .send({
          records: [
            baseRecord({
              memberId: member.id,
              checkInAt: pastIso('01-05T11:00:00.000Z'),
              checkOutAt: pastIso('01-05T12:00:00.000Z'),
              note: '撤回后修订',
            }),
          ],
        });
      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({ statusCode: 'pending', version: 2 });
      await fillContributionPoints(sheetId, 1);
      await approveToPendingFinalReview(sheetId);
      const secondFinal = await request(httpServer(app))
        .patch(`/api/admin/v1/attendance-sheets/${sheetId}/final-approve`)
        .set('Authorization', finalAdminAuth)
        .send({ finalReviewNote: '修订后重审' });
      expect(secondFinal.status).toBe(200);
      expect(secondFinal.body.data.statusCode).toBe('approved');
      expect(await summary()).toBe('1');
      const secondIntent = await prisma.notificationOutboxIntent.findFirstOrThrow({
        where: {
          aggregateType: 'attendance_sheet',
          aggregateId: sheetId,
          status: 'pending',
        },
      });
      await outboxWorker.drainEventKey(secondIntent.eventKey);
      expect(
        await prisma.notification.count({
          where: { recipientMemberId: member.id, deletedAt: null },
        }),
      ).toBe(notificationCountAfterFirstFinal + 1);

      const records = await prisma.attendanceRecord.findMany({
        where: { sheetId },
        select: { deletedAt: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(records).toHaveLength(2);
      expect(records.filter((r) => r.deletedAt === null)).toHaveLength(1);
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
