import { readFileSync } from 'node:fs';

import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BindingScopeType, BindingStatus, MemberStatus, PrincipalType, Role } from '@prisma/client';
import request from 'supertest';

import type { JwtConfig } from '../../src/config/jwt.config';
import { PrismaService } from '../../src/database/prisma.service';
import { ActivitiesModule } from '../../src/modules/activities/activities.module';
import { ActivityBatchWorker } from '../../src/modules/activities/activity-batch.worker';
import { ACTIVITY_CLOSURE_GAP_ORDER } from '../../src/modules/activities/activity-closure-checks';
import { LedgerReadyBatchCommitter } from '../../src/modules/activities/ledger-ready-batch-committer.service';
import {
  digestAttendanceQrToken,
  signAttendanceQrToken,
} from '../../src/modules/attendances/attendance-qr-token';
import { loginAs } from '../fixtures/auth.fixture';
import { seedActivityResponsibilitySystemRoles } from '../fixtures/activity-responsibility.fixture';
import { createTestUser } from '../fixtures/users.fixture';
import { httpServer } from '../helpers/http-server';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// ===== 活动全链路贯通 e2e —— 验证刀,零 src 改动 =====
//
// 本 spec 的存在理由:仓库里几乎没有一条 spec 跨越两个批次的接缝。每一段的输入都是
// 手工夹具而不是上一段的真实输出 —— 发布链产出的活动形状、报名产出的参与身份、
// 打卡产出的服务段、结算产出的账本批次,它们之间的接缝**从未被真实数据穿过**。
//
// 唯一的核心不变量:**链上任何一站的输入,必须是上一站的真实输出。**
//
// 执行位:本文件禁止用 prisma 直插制造链路自身能产出的任何状态。例如下面这行
// 字面量只允许出现在注释里,剥注释后必须一个不剩:prisma.activity.create
// 它同时充当自检断言的**阳性对照** —— 若剥注释函数坏掉(把整份源码吃空)或匹配
// 写法写错,阳性对照会先红,而不是让「零命中」被读成「合规」。
//
// 允许直插的只有链路外的前置:组织、账号/角色绑定、活动类型与贡献规则等基础字典。

const FORBIDDEN_DELEGATES = [
  'activity',
  'activitySession',
  'activitySessionPosition',
  'activityPublishReview',
  'activityRuleSnapshot',
  'activityEvidenceState',
  'activityResponsibilityAssignment',
  'activityRegistration',
  'activityRegistrationRevision',
  'activityParticipationIdentity',
  'activityParticipationRevision',
  'activityCapacityBucket',
  'capacityReservation',
  'activityAllocationBatch',
  'activityAllocationCandidate',
  'attendanceQrCredential',
  'attendancePunchEvent',
  'participantServiceSegmentRevision',
  'evidenceSeal',
  'attendanceSettlementRun',
  'attendanceSettlementVersion',
  'participantSettlementResultRevision',
  'settlementReviewAction',
  'ledgerPostingBatch',
  'participationLedgerEntry',
  'activitySettlementClosureRevision',
] as const;

const WRITE_METHODS = ['create', 'createMany', 'createManyAndReturn', 'upsert'] as const;

/**
 * 2020 年固定过去时刻;不耦合墙钟(本仓栽过日期炸弹)。
 *
 * 断点②(见交付报告):**这条链有两个时间权威**。第 1–10 站读的是应用进程时钟
 * (fake timers 能推动),第 11 站封场读的是 `SELECT now()` —— **数据库时钟**,
 * 测试端无法伪造。二者叠加的后果是:任何**未来日期**的夹具都永远封不了场
 * (库里是今天,场次签退截止在 2099 ⇒「仍有场次的签退窗口未结束」恒成立)。
 * 故整条时间轴只能放在数据库的过去,再用 fake timers 在其中逐站前移应用时钟 ——
 * 这也正是 activity-settlement-closure.e2e-spec.ts 既有的 2020 口径。
 */
const DEADLINE = new Date('2020-03-01T00:00:00.000Z');
const SESSION_START = new Date('2020-03-10T08:00:00.000Z');
const SESSION_END = new Date('2020-03-10T12:00:00.000Z');
const CHECK_IN_OPEN = new Date('2020-03-10T07:30:00.000Z');
const CHECK_IN_CLOSE = new Date('2020-03-10T08:30:00.000Z');
const CHECK_OUT_OPEN = new Date('2020-03-10T11:00:00.000Z');
const CHECK_OUT_CLOSE = new Date('2020-03-10T12:30:00.000Z');

/** 在册起始时刻;必须早于整条时间轴。 */
const MEMBERSHIP_STARTED_AT = new Date('2019-01-01T00:00:00.000Z');

/** 逐站前移的应用时钟锚点;推进的是时钟,不是数据。 */
const T_BEFORE_DEADLINE = new Date('2020-02-01T00:00:00.000Z');
const T_AFTER_DEADLINE = new Date('2020-03-02T00:00:00.000Z');
const T_CHECK_IN = new Date('2020-03-10T07:45:00.000Z');
const T_CHECK_OUT = new Date('2020-03-10T11:30:00.000Z');
const T_AFTER_END = new Date('2020-03-10T13:00:00.000Z');

interface StationRecord {
  station: number;
  name: string;
  status: number;
  ok: boolean;
}

describe('活动全链路贯通(14 站 · 8 条接缝)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: ActivityBatchWorker;
  let committer: LedgerReadyBatchCommitter;

  let organizationId: string;
  let activityTypeCode: string;
  let attendanceRoleCode: string;

  let managerUsername: string;
  let applicantUsername: string;
  let publishReviewerUsername: string;
  let firstReviewerUsername: string;
  let finalReviewerUsername: string;

  const stations: StationRecord[] = [];

  beforeAll(async () => {
    // 断点①(见交付报告):App 面 managed-activity 建草稿被这枚开关挡住,且关时抛的是
    // ACTIVITY_ATTENDANCE_DECLARATION_INVALID(20039「当前活动不能声明考勤已全部提交」)
    // —— 与建草稿毫无关系的错误码。本 spec 与 batch3 同款置真,不改 src。
    process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    worker = app.get(ActivityBatchWorker);
    // 非严格解析会取到同类型的另一个实例(屏障打在没人用的对象上,每步都"成功")。
    committer = app.select(ActivitiesModule).get(LedgerReadyBatchCommitter, { strict: true });

    await seedActivityResponsibilitySystemRoles(app);

    // 链路外前置① 组织树
    const root = await prisma.organization.create({
      data: { name: '全链路根组织', nodeTypeCode: 'full-chain-root' },
      select: { id: true },
    });
    const organization = await prisma.organization.create({
      data: { name: '全链路执行队', nodeTypeCode: 'full-chain-team', parentId: root.id },
      select: { id: true },
    });
    organizationId = organization.id;
    await prisma.organizationClosure.createMany({
      data: [
        { ancestorId: root.id, descendantId: root.id, depth: 0 },
        { ancestorId: root.id, descendantId: organization.id, depth: 1 },
        { ancestorId: organization.id, descendantId: organization.id, depth: 0 },
      ],
    });

    // 链路外前置② 基础字典
    const activityType = await prisma.dictType.create({
      data: { code: 'activity_type', label: '活动类型' },
      select: { id: true },
    });
    activityTypeCode = 'full-chain-rescue';
    await prisma.dictItem.create({
      data: { typeId: activityType.id, code: activityTypeCode, label: '全链路救援' },
    });
    const attendanceRole = await prisma.dictType.create({
      data: { code: 'attendance_role', label: '考勤角色' },
      select: { id: true },
    });
    attendanceRoleCode = 'full-chain-volunteer';
    await prisma.dictItem.create({
      data: { typeId: attendanceRole.id, code: attendanceRoleCode, label: '全链路志愿者' },
    });

    // 链路外前置③ 贡献规则(缺它结算会挂 missing_contribution_rule)
    await prisma.contributionRule.create({
      data: { activityTypeCode, attendanceRoleCode, pointsBelow: '2.00' },
    });

    // 链路外前置④ 账号
    const manager = await createAccount('manager', Role.USER, { withMembership: true });
    managerUsername = manager.username;
    const applicant = await createAccount('applicant', Role.USER, { withMembership: true });
    applicantUsername = applicant.username;

    const publishReviewer = await createAccount('publish-reviewer', Role.USER);
    publishReviewerUsername = publishReviewer.username;
    const firstReviewer = await createAccount('first-reviewer', Role.USER);
    firstReviewerUsername = firstReviewer.username;
    const finalReviewer = await createAccount('final-reviewer', Role.USER);
    finalReviewerUsername = finalReviewer.username;

    // 链路外前置⑤ RBAC
    // 负责人自己也要三枚 rbac-global 结算动作码 —— 活动责任(scoped)不覆盖它们。
    await grantGlobal(manager.userId, 'full-chain-settlement-operator', [
      'activity.settlement-generate.record',
      'activity.settlement-submit.record',
      'activity.settlement-close.record',
    ]);
    await grantGlobal(publishReviewer.userId, 'full-chain-publish-reviewer', [
      'activity-review.read.request',
      'activity-review.return.request',
      'activity.publish.record',
    ]);
    await grantGlobal(firstReviewer.userId, 'full-chain-first-reviewer', [
      'attendance.read.sheet',
      'activity.settlement-first-review.record',
    ]);
    await grantGlobal(finalReviewer.userId, 'full-chain-final-reviewer', [
      'attendance.read.sheet',
      'activity.settlement-final-review.record',
    ]);
  }, 180_000);

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED;
  });

  async function createAccount(
    label: string,
    role: Role,
    options: { withMembership?: boolean } = {},
  ): Promise<{ username: string; userId: string; memberId: string }> {
    const username = `full-chain-${label}`;
    const user = await createTestUser(app, { username, role });
    const member = await prisma.member.create({
      data: {
        memberNo: `FULL-CHAIN-${label.toUpperCase()}`,
        displayName: `全链路 ${label}`,
        gradeCode: 'level-3',
        status: MemberStatus.ACTIVE,
      },
      select: { id: true },
    });
    await prisma.user.update({ where: { id: user.id }, data: { memberId: member.id } });
    if (options.withMembership === true) {
      // `startedAt` 必须显式落在时间轴之前:该列默认取**数据库时钟**(今天),而
      // ActivityInitiationPolicy 的在册判定用的是**应用时钟**(本 spec 冻到 2020)——
      // 默认值会让发起人在自己的时间轴上「还没入队」(断点②的同源表现)。
      await prisma.memberOrganizationMembership.create({
        data: { memberId: member.id, organizationId, startedAt: MEMBERSHIP_STARTED_AT },
      });
    }
    return { username, userId: user.id, memberId: member.id };
  }

  async function grantGlobal(userId: string, roleCode: string, codes: string[]): Promise<void> {
    await prisma.permission.createMany({
      data: codes.map((code) => {
        const [resourceType, action] = code.split('.');
        return { code, module: resourceType, action: action ?? 'manage', resourceType };
      }),
      skipDuplicates: true,
    });
    const role = await prisma.rbacRole.create({
      data: { code: roleCode, displayName: roleCode },
      select: { id: true },
    });
    const permissions = await prisma.permission.findMany({
      where: { code: { in: codes } },
      select: { id: true },
    });
    expect(permissions).toHaveLength(codes.length);
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({ roleId: role.id, permissionId: permission.id })),
    });
    await prisma.roleBinding.create({
      data: {
        principalType: PrincipalType.USER,
        principalId: userId,
        roleId: role.id,
        scopeType: BindingScopeType.GLOBAL,
        status: BindingStatus.ACTIVE,
        // 同 memberOrganizationMembership.startedAt:默认取数据库时钟,判权比的是
        // 应用时钟 ⇒ 不显式前置的话,授权在自己的时间轴上「尚未生效」。
        startedAt: MEMBERSHIP_STARTED_AT,
      },
    });
  }

  /** 只伪造 Date;定时器一律放行(fake timers 碰 DB 会挂 suite)。 */
  function freezeSystemTime(now: Date): void {
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
    jest.setSystemTime(now);
  }

  /** envelope 里的字段类型是 unknown;这两个读取器把「不是字符串/数字」显式收敛成空值。 */
  function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  function num(value: unknown): number {
    return typeof value === 'number' ? value : 0;
  }

  /**
   * 每一站的统一断言点。断在哪一站就把那一站的实测报文原样抛出去 ——
   * 本刀的产出物是精确断点,不是「某处 500」。
   */
  function station(
    index: number,
    name: string,
    response: { status: number; body: unknown },
    expected: number,
  ): Record<string, unknown> {
    const ok = response.status === expected;
    stations.push({ station: index, name, status: response.status, ok });
    if (!ok) {
      throw new Error(
        `第 ${index} 站「${name}」断链:期望 HTTP ${expected},实得 ${response.status}\n` +
          `响应报文:${JSON.stringify(response.body)}\n` +
          `已走通:${stations
            .filter((entry) => entry.ok)
            .map((entry) => `${entry.station}.${entry.name}`)
            .join(' → ')}`,
      );
    }
    const body = response.body as { data?: unknown };
    return (body.data ?? {}) as Record<string, unknown>;
  }

  it('走完 14 站并逐条钉住 8 条接缝的身份连续性', async () => {
    // 报名截止之前:第 1–6 站。冻结在先、登录在后 —— token 的 exp 按应用时钟判。
    freezeSystemTime(T_BEFORE_DEADLINE);
    const managerAuth = (await loginAs(app, managerUsername)).authHeader;

    // ---------- 第 1 站:建草稿 ----------
    const draft = station(
      1,
      '建草稿',
      await request(httpServer(app))
        .post('/api/app/v1/my/managed-activities')
        .set('Authorization', managerAuth)
        .send({
          title: '全链路贯通演练',
          activityTypeCode,
          organizationId,
          allocationModeCode: 'qualification_rank',
          registrationModeCode: 'open_apply',
          visibilityCode: 'internal',
          defaultLocationRequired: false,
          archiveWaitingDays: 0,
          startAt: SESSION_START.toISOString(),
          endAt: SESSION_END.toISOString(),
          registrationDeadline: DEADLINE.toISOString(),
          location: '深圳',
          capacity: 1,
          isPublicRegistration: true,
        }),
      201,
    );
    const activityId = String((draft.activity as { id?: string } | undefined)?.id ?? '');
    expect(activityId).not.toBe('');

    const workflowRevisionBefore = (
      await prisma.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { workflowRevision: true },
      })
    ).workflowRevision;

    // ---------- 第 2 站:加场次 ----------
    const sessionCreated = station(
      2,
      '加场次',
      await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/sessions`)
        .set('Authorization', managerAuth)
        .send({
          code: 'full-chain-session',
          name: '全链路场次',
          startAt: SESSION_START.toISOString(),
          endAt: SESSION_END.toISOString(),
          locationText: '深圳集合点',
          capacity: 1,
          checkInOpenAt: CHECK_IN_OPEN.toISOString(),
          checkInCloseAt: CHECK_IN_CLOSE.toISOString(),
          checkOutOpenAt: CHECK_OUT_OPEN.toISOString(),
          checkOutCloseAt: CHECK_OUT_CLOSE.toISOString(),
          locationRequired: false,
          radiusMeters: null,
        }),
      201,
    );
    const sessionId = text(sessionCreated.sessionId);
    expect(sessionId).not.toBe('');

    // ---------- 第 3 站:加岗位 ----------
    const positionCreated = station(
      3,
      '加岗位',
      await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}/positions`)
        .set('Authorization', managerAuth)
        .send({
          code: 'full-chain-position',
          name: '全链路岗位',
          attendanceRoleCode,
          capacity: 1,
          startAt: SESSION_START.toISOString(),
          endAt: SESSION_END.toISOString(),
        }),
      201,
    );
    const positionId = text(positionCreated.positionId);
    expect(positionId).not.toBe('');

    // ---------- 第 4 站:提交发布审核 ----------
    const review = station(
      4,
      '提交发布审核',
      await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/publish-reviews`)
        .set('Authorization', managerAuth)
        .send({ operationKey: 'full-chain-publish-review', confirmation: true }),
      200,
    );
    const publishReviewId = text(review.id);
    expect(publishReviewId).not.toBe('');

    // ---------- 第 5 站:管理端批准 ----------
    const publishReviewerAuth = (await loginAs(app, publishReviewerUsername)).authHeader;
    station(
      5,
      '管理端批准',
      await request(httpServer(app))
        .post(`/api/admin/v1/activity-publish-reviews/${publishReviewId}/approve`)
        .set('Authorization', publishReviewerAuth)
        .send({ requiresInsuranceConfirmed: true, operationKey: 'full-chain-approve' }),
      200,
    );

    // 接缝①:批准 → 活动
    const publishedActivity = await prisma.activity.findUniqueOrThrow({
      where: { id: activityId },
      select: { statusCode: true, workflowRevision: true },
    });
    expect(publishedActivity.statusCode).toBe('published');
    expect(publishedActivity.workflowRevision).toBeGreaterThan(workflowRevisionBefore);
    const ruleSnapshots = await prisma.activityRuleSnapshot.findMany({
      where: { activityId },
      select: { workflowRevision: true, createdByReviewId: true },
    });
    // 快照必须由这一次批准产出,而不是碰巧存在一条。
    expect(ruleSnapshots).toEqual([
      expect.objectContaining({
        workflowRevision: publishedActivity.workflowRevision,
        createdByReviewId: publishReviewId,
      }),
    ]);

    // ---------- 第 6 站:队员报名 ----------
    const applicantAuth = (await loginAs(app, applicantUsername)).authHeader;
    const registration = station(
      6,
      '队员报名',
      await request(httpServer(app))
        .post(`/api/app/v1/activities/${activityId}/registrations`)
        .set('Authorization', applicantAuth)
        .send({
          operationKey: 'full-chain-register',
          formVersion: null,
          answers: [],
          preferences: [{ sessionId, positionIds: [positionId] }],
        }),
      201,
    );
    const registrationId = text(registration.registrationId);
    expect(registrationId).not.toBe('');

    // ---------- 第 7 站:分配批次 ----------
    // 报名截止之后才允许冻结候选;推进的是时钟,不是数据。
    freezeSystemTime(T_AFTER_DEADLINE);
    const managerAuthAfterDeadline = (await loginAs(app, managerUsername)).authHeader;
    const prepared = station(
      7,
      '分配批次 prepare',
      await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/allocation-batches`)
        .set('Authorization', managerAuthAfterDeadline)
        .send({ operationKey: 'full-chain-allocate-prepare', sessionId, positionId }),
      201,
    );
    const preparedBatch = prepared.batch as { batchId?: string; candidates?: unknown } | undefined;
    const batchId = text(preparedBatch?.batchId ?? prepared.batchId);
    expect(batchId).not.toBe('');

    const preparedCandidates = (prepared.candidates ?? preparedBatch?.candidates ?? []) as Array<{
      participationIdentityId?: string;
      registrationId?: string;
    }>;
    // 接缝②(上半):候选人来自第 6 站的那条报名
    expect(preparedCandidates.map((candidate) => candidate.registrationId)).toEqual([
      registrationId,
    ]);
    const participationIdentityId = text(preparedCandidates[0]?.participationIdentityId);
    expect(participationIdentityId).not.toBe('');

    const committed = station(
      7,
      '分配批次 commit',
      await request(httpServer(app))
        .post(
          `/api/app/v1/my/managed-activities/${activityId}/allocation-batches/${batchId}/commit`,
        )
        .set('Authorization', managerAuthAfterDeadline)
        .send({ operationKey: 'full-chain-allocate-commit' }),
      200,
    );
    const committedBatch = committed.batch as { candidates?: unknown } | undefined;
    const committedCandidates = (committed.candidates ??
      committedBatch?.candidates ??
      []) as Array<{ participationIdentityId?: string; resultCode?: string }>;
    const allocatedIdentityIds = committedCandidates
      .filter((candidate) => candidate.resultCode === 'allocated')
      .map((candidate) => String(candidate.participationIdentityId));
    expect(allocatedIdentityIds).toEqual([participationIdentityId]);

    // 接缝③:分配 → 容量(比集合,不比计数)
    const reservations = await prisma.capacityReservation.findMany({
      where: { activityId, status: 'active' },
      select: { identityId: true },
    });
    expect(new Set(reservations.map((row) => row.identityId))).toEqual(
      new Set(allocatedIdentityIds),
    );

    // ---------- 第 8 站:签发二维码 ----------
    const checkInCredential = station(
      8,
      '签发签到二维码',
      await request(httpServer(app))
        .post(
          `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}` +
            '/qr-credentials/check-in/issue',
        )
        .set('Authorization', managerAuthAfterDeadline)
        .send({ operationKey: 'full-chain-qr-check-in' }),
      201,
    );
    const checkInCredentialId = text(checkInCredential.credentialId);
    expect(checkInCredentialId).not.toBe('');

    const checkOutCredential = station(
      8,
      '签发签退二维码',
      await request(httpServer(app))
        .post(
          `/api/app/v1/my/managed-activities/${activityId}/sessions/${sessionId}` +
            '/qr-credentials/check-out/issue',
        )
        .set('Authorization', managerAuthAfterDeadline)
        .send({ operationKey: 'full-chain-qr-check-out' }),
      201,
    );
    const checkOutCredentialId = text(checkOutCredential.credentialId);
    expect(checkOutCredentialId).not.toBe('');

    // ---------- 第 9 站:签到 ----------
    freezeSystemTime(T_CHECK_IN);
    const checkInToken = await renderToken(checkInCredentialId);
    const punchInAuth = (await loginAs(app, applicantUsername)).authHeader;
    const checkedIn = station(
      9,
      '签到',
      await request(httpServer(app))
        .post(`/api/app/v1/activities/${activityId}/sessions/${sessionId}/punches/check-in`)
        .set('Authorization', punchInAuth)
        .send({ qrToken: checkInToken, eventKey: 'full-chain-punch-in' }),
      201,
    );
    const checkInEventId = text(checkedIn.eventId);
    expect(checkInEventId).not.toBe('');

    // 接缝④:二维码 → 打卡(用的就是第 8 站签发的那张)
    const checkInRow = await prisma.attendanceQrCredential.findUniqueOrThrow({
      where: { id: checkInCredentialId },
      select: { tokenDigest: true },
    });
    expect(digestAttendanceQrToken(checkInToken)).toBe(checkInRow.tokenDigest);
    const checkInEvent = await prisma.attendancePunchEvent.findUniqueOrThrow({
      where: { id: checkInEventId },
      select: { participationIdentityId: true, qrCredentialId: true },
    });
    expect(checkInEvent.qrCredentialId).toBe(checkInCredentialId);
    // 接缝②(下半):打卡写入的身份就是第 7 站分配的那一个
    expect(checkInEvent.participationIdentityId).toBe(participationIdentityId);

    // ---------- 第 10 站:签退 ----------
    freezeSystemTime(T_CHECK_OUT);
    const checkOutToken = await renderToken(checkOutCredentialId);
    const punchOutAuth = (await loginAs(app, applicantUsername)).authHeader;
    const checkedOut = station(
      10,
      '签退',
      await request(httpServer(app))
        .post(`/api/app/v1/activities/${activityId}/sessions/${sessionId}/punches/check-out`)
        .set('Authorization', punchOutAuth)
        .send({ qrToken: checkOutToken, eventKey: 'full-chain-punch-out' }),
      201,
    );
    const checkOutEventId = text(checkedOut.eventId);
    expect(checkOutEventId).not.toBe('');

    // 接缝⑤:打卡 → 服务段
    const segments = await prisma.participantServiceSegmentRevision.findMany({
      where: { participationIdentityId },
      select: {
        sourceCheckInEventId: true,
        sourceCloseEventId: true,
        statusCode: true,
        resultCode: true,
      },
    });
    // 服务段是**修订链**而不是单行:签到开段(后被 superseded)、签退闭段(current)。
    // 两条都必须锚回第 9 站的那个事件行;闭段的关闭源必须是第 10 站的那个事件行。
    expect(segments.length).toBeGreaterThan(0);
    expect(new Set(segments.map((segment) => segment.sourceCheckInEventId))).toEqual(
      new Set([checkInEventId]),
    );
    const currentSegments = segments.filter((segment) => segment.statusCode !== 'superseded');
    expect(currentSegments).toEqual([
      expect.objectContaining({
        sourceCheckInEventId: checkInEventId,
        sourceCloseEventId: checkOutEventId,
      }),
    ]);

    // ---------- 第 11 站:封场 ----------
    freezeSystemTime(T_AFTER_END);
    const managerAuthAfterEnd = (await loginAs(app, managerUsername)).authHeader;
    const sealed = station(
      11,
      '封场',
      await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/evidence-seals`)
        .set('Authorization', managerAuthAfterEnd)
        .send({}),
      200,
    );
    const evidenceSealId = text(sealed.sealId ?? sealed.id);
    expect(evidenceSealId).not.toBe('');

    // ---------- 第 12 站:生成 + 提交结算 ----------
    const generated = station(
      12,
      '生成结算草稿',
      await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/settlement/generate`)
        .set('Authorization', managerAuthAfterEnd)
        .send({ operationKey: 'full-chain-settlement-generate' }),
      200,
    );
    const draftVersion = num(generated.settlementVersion);
    expect(draftVersion).toBeGreaterThan(0);

    // 接缝⑥:封场 → 结算人口(逐个 id 比对,不是比个数)
    const draftVersionId = text(generated.settlementVersionId);
    const draftRows = await prisma.participantSettlementResultRevision.findMany({
      where: { settlementVersionId: draftVersionId },
      select: { participationIdentityId: true },
    });
    const punchedIdentityIds = await prisma.attendancePunchEvent
      .findMany({
        where: { activityId, eventTypeCode: 'check_in' },
        select: { participationIdentityId: true },
      })
      .then((rows) => new Set(rows.map((row) => row.participationIdentityId)));
    // 空集 == 空集 会让这条接缝静默变成空绿;先钉住两边都真的有人。
    expect(punchedIdentityIds.size).toBe(1);
    expect(draftRows.length).toBeGreaterThan(0);
    expect(new Set(draftRows.map((row) => row.participationIdentityId))).toEqual(
      punchedIdentityIds,
    );

    const submitted = station(
      12,
      '提交结算送审',
      await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/settlement/submit`)
        .set('Authorization', managerAuthAfterEnd)
        .send({
          operationKey: 'full-chain-settlement-submit',
          expectedDraftVersion: draftVersion,
          evidenceSealId,
          confirmation: true,
        }),
      200,
    );
    const settlementVersionId = text(submitted.settlementVersionId);
    expect(settlementVersionId).not.toBe('');

    // ---------- 第 13 站:一审 + 终审 ----------
    const approveBody = {
      evidenceSealId: text(submitted.evidenceSealId) || evidenceSealId,
      evidenceRevision: num(submitted.evidenceRevision),
      populationRevision: num(submitted.populationRevision),
      workflowRevision: num(submitted.workflowRevision),
      contentHash: text(submitted.contentHash),
    };
    const firstReviewerAuth = (await loginAs(app, firstReviewerUsername)).authHeader;
    station(
      13,
      '结算一审',
      await request(httpServer(app))
        .post(`/api/admin/v1/attendance-settlements/${settlementVersionId}/first-approve`)
        .set('Authorization', firstReviewerAuth)
        .send({ ...approveBody, operationKey: 'full-chain-settlement-first' }),
      200,
    );
    const finalReviewerAuth = (await loginAs(app, finalReviewerUsername)).authHeader;
    station(
      13,
      '结算终审',
      await request(httpServer(app))
        .post(`/api/admin/v1/attendance-settlements/${settlementVersionId}/final-approve`)
        .set('Authorization', finalReviewerAuth)
        .send({ ...approveBody, operationKey: 'full-chain-settlement-final' }),
      200,
    );

    // ---------- 第 14 站:入账 + 关账 ----------
    // 终审建出 `preparing` 批次;worker 把它推到 `ready`(HTTP app 的 auto-commit 恒关),
    // 再由 committer 显式统一生效。
    // 断点②第三次现形:`ActivityBatchJob.availableAt` 默认取**数据库时钟**,而
    // `claimJob` 拿**应用时钟**去比 —— 应用时钟冻在过去时该任务永远不可领取。
    // 账本这半条链本来就锚在数据库时间上,故此处放开假时钟(并重新登录换新 token)。
    jest.useRealTimers();
    const managerAuthRealtime = (await loginAs(app, managerUsername)).authHeader;

    const postingBatch = await prisma.ledgerPostingBatch.findFirstOrThrow({
      where: { settlementVersionId },
      select: { id: true },
    });
    for (let round = 0; round < 6; round += 1) {
      const current = await prisma.ledgerPostingBatch.findUniqueOrThrow({
        where: { id: postingBatch.id },
        select: { statusCode: true },
      });
      if (current.statusCode === 'ready') break;
      await worker.drainOnce();
    }
    const readyBatch = await prisma.ledgerPostingBatch.findUniqueOrThrow({
      where: { id: postingBatch.id },
      select: { statusCode: true },
    });
    expect(readyBatch.statusCode).toBe('ready');

    const commitResult = await committer.commitReadyBatch(postingBatch.id);
    stations.push({ station: 14, name: '账本统一生效', status: 200, ok: true });
    expect(commitResult).toEqual(expect.objectContaining({ postingBatchId: postingBatch.id }));

    // 接缝⑦:结算 → 账本(比集合,不比计数)
    const ledgerEntries = await prisma.participationLedgerEntry.findMany({
      where: { postingBatchId: postingBatch.id },
      select: { participationIdentityId: true },
    });
    const versionPopulation = await prisma.participantSettlementResultRevision.findMany({
      where: { settlementVersionId },
      select: { participationIdentityId: true },
    });
    expect(ledgerEntries.length).toBeGreaterThan(0);
    expect(versionPopulation.length).toBeGreaterThan(0);
    expect(new Set(ledgerEntries.map((row) => row.participationIdentityId))).toEqual(
      new Set(versionPopulation.map((row) => row.participationIdentityId)),
    );

    const closed = station(
      14,
      '关账',
      await request(httpServer(app))
        .post(`/api/app/v1/my/managed-activities/${activityId}/settlement/close`)
        .set('Authorization', managerAuthRealtime)
        .send({
          operationKey: 'full-chain-settlement-close',
          expectedSettlementVersionId: settlementVersionId,
          expectedPostingBatchId: postingBatch.id,
        }),
      200,
    );

    // 接缝⑧:账本 → 关账
    expect(closed.outcome).toBe('closed');
    expect(closed.gaps).toEqual([]);
    // goal 写的是「12 项检查」,合同的执行位其实是 §5.15 的十二步收敛成**八类**硬检查
    // (ACTIVITY_CLOSURE_GAP_ORDER)。这里钉合同的那一份,不钉一个手抄的数字。
    const checks = (closed.checks ?? []) as Array<{ gapCode: string; passed: boolean }>;
    expect(checks.map((check) => check.gapCode)).toEqual([...ACTIVITY_CLOSURE_GAP_ORDER]);
    expect(checks.filter((check) => !check.passed)).toEqual([]);
    expect(closed.postingBatchId).toBe(postingBatch.id);
    const closureRevision = await prisma.activitySettlementClosureRevision.findFirstOrThrow({
      where: { activityId, statusCode: 'active' },
      select: { postingBatchId: true, settlementVersionId: true, evidenceSealId: true },
    });
    expect(closureRevision).toEqual({
      postingBatchId: postingBatch.id,
      settlementVersionId,
      evidenceSealId,
    });
  }, 600_000);

  /**
   * 二维码 token 是凭证行的纯函数(签名输入全部取自该行),故由第 8 站产出的
   * 凭证行重签即得同一串 token —— 与 tokenDigest 对得上就证明「用的是那一张」。
   * 生产 render 端点只回 SVG 二进制、绝不回显 token,测试端无法从 HTTP 取到明文。
   */
  async function renderToken(credentialId: string): Promise<string> {
    const credential = await prisma.attendanceQrCredential.findUniqueOrThrow({
      where: { id: credentialId },
      select: {
        id: true,
        activityId: true,
        sessionId: true,
        actionCode: true,
        credentialVersion: true,
        validFrom: true,
        validUntil: true,
      },
    });
    const config = app.get(ConfigService).get<JwtConfig>('jwt');
    if (
      config === undefined ||
      (credential.actionCode !== 'check_in' && credential.actionCode !== 'check_out')
    ) {
      throw new Error(`凭证 ${credentialId} 无法签名`);
    }
    return signAttendanceQrToken(
      {
        credentialId: credential.id,
        activityId: credential.activityId,
        sessionId: credential.sessionId,
        actionCode: credential.actionCode,
        credentialVersion: credential.credentialVersion,
        validFrom: credential.validFrom,
        validUntil: credential.validUntil,
      },
      config.secret,
    );
  }

  it('自检:本 spec 从不直插链路自身能产出的任何实体', () => {
    const source = readFileSync(__filename, 'utf8');
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

    const patternsOf = (delegate: string): string[] =>
      WRITE_METHODS.map((method) => `prisma.${delegate}.${method}`);

    // 阳性对照:同一组模式在未剥注释的源码里必须命中(文件头刻意留了一处),
    // 否则「剥后零命中」只是剥注释函数或匹配写法坏掉,不是真的合规。
    const rawHits = FORBIDDEN_DELEGATES.flatMap(patternsOf).filter((pattern) =>
      source.includes(pattern),
    );
    expect(rawHits).not.toEqual([]);

    const strippedHits = FORBIDDEN_DELEGATES.flatMap(patternsOf).filter((pattern) =>
      stripped.includes(pattern),
    );
    expect(strippedHits).toEqual([]);
  });
});
