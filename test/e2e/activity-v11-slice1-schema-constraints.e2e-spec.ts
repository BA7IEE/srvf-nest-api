import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// 活动改造 v1.1 —— 第 1 批第一刀(2026-08-04;第 71 migration
// `20260804020000_activity_v11_slice1_sessions_participation_capacity`)。
// 合同:docs/archive/reviews/activity-business-overhaul-v1.1/
//       SRVF_活动业务全流程改造_详细开发文档_v1.1.md §3.1 / §3.2 / §3.3 / §3.8 / §3.9 / §3.10
//
// 本 spec 的**唯一**职责:证明 migration 里的每条 CHECK / unique / partial unique 在真实
// PostgreSQL 上**真的会拒**非法数据 —— 而不是"schema 文本里写了"。
//
// 为什么每条都要**双向**断言(违规被拒 + 合法放行):
// 只断言"被拒"证明不了约束是对的 —— 一条 `CHECK (false)` 也能让所有违规用例全绿,
// 却把合法写入一起拒掉。反向样例是区分"约束正确"与"约束过严"的唯一手段。
//
// 走 $executeRawUnsafe 而非 Prisma model API:CHECK 与 partial unique 的 WHERE 都是
// **DB 层**约束,Prisma client 不认识它们;必须让语句真的打到 PostgreSQL 才算实测。
// Prisma 把原生语句的数据库错误包成 P2010,SQLSTATE 落在 `meta.code`
// (23505=unique / 23514=check / 23503=foreign key)。

const T = (iso: string) => `'${iso}'::timestamp`;

// 场次基准时间窗(全部 2099,避免"硬编码历史日期 + 耦合墙钟"的定时炸弹)。
const START_AT = '2099-06-01T09:00:00.000Z';
const END_AT = '2099-06-01T17:00:00.000Z';
const CHECKIN_OPEN = '2099-06-01T08:00:00.000Z';
const CHECKIN_CLOSE = '2099-06-01T10:00:00.000Z';
const CHECKOUT_OPEN = '2099-06-01T16:00:00.000Z';
const CHECKOUT_CLOSE = '2099-06-01T18:00:00.000Z';
const PREP_START = '2099-06-01T07:00:00.000Z';

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

function sqlText(value: string | null): string {
  if (value === null) return 'NULL';
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlNum(value: number | null): string {
  return value === null ? 'NULL' : String(value);
}

function sqlBool(value: boolean | null): string {
  return value === null ? 'NULL' : String(value);
}

function sqlTime(value: string | null): string {
  return value === null ? 'NULL' : T(value);
}

describe('活动改造 v1.1 schema 约束(第 71–81 migration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let organizationId: string;
  let activityId: string;
  let otherActivityId: string;
  let memberId: string;
  let registrationId: string;
  let sessionId: string;
  let otherSessionId: string;
  // 同一活动内的第二个场次。用于「只换场次」的正样本 —— 换活动会同时动到
  // activityId,那样的样本在 sessionId 这一维上并不单独不同。
  let sameActivityOtherSessionId: string;
  let positionId: string;
  let identityId: string;
  let bucketId: string;

  let seq = 0;
  const uniq = (label: string) => `v11s1-${label}-${(seq += 1)}`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  // 执行一条原生语句;成功返回 null,失败返回归一化的错误标识。
  // 刻意不 throw —— 调用点用返回值做断言,避免 expect().rejects 把"没抛"读成通过。
  async function run(sql: string): Promise<RawDbError | null> {
    try {
      await prisma.$executeRawUnsafe(sql);
      return null;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
        const meta = err.meta as { code?: string; message?: string } | undefined;
        const message = meta?.message ?? '';
        const matched = /constraint "([^"]+)"/.exec(message);
        return { sqlState: meta?.code ?? '', constraint: matched?.[1] ?? '', message };
      }
      throw err;
    }
  }

  // 断言"被拒",并把**错误原文**一并返回,供报告引用(DoD 5 要的是拒绝证据不是"测试通过")。
  //
  // ⚠️ 两类错误能拿到的证据**不一样**,实测(Prisma 6.19)如下:
  // - CHECK(23514)/ FK(23503):meta.message 是 PG 的主消息,含 `constraint "xxx"`
  //   ⇒ 可以断言到**具体约束名**。
  // - UNIQUE(23505):meta.message 只有 PG 的 **DETAIL** 行,形如
  //   `Key ("activityId", code)=(a1, C) already exists.`,**不含约束名**
  //   ⇒ 改断言**键列签名**。这同样是唯一的:本 schema 里覆盖该组键列的唯一索引只有一条,
  //   所以"哪条索引开的火"没有歧义;而释放/软删后放行的正向用例进一步锁死了 partial 谓词。
  async function expectRejected(
    sql: string,
    expected: { sqlState: string; constraint?: string; key?: string },
  ): Promise<RawDbError> {
    const err = await run(sql);
    expect(err).not.toBeNull();
    expect(err!.sqlState).toBe(expected.sqlState);
    if (expected.constraint !== undefined) {
      expect(err!.constraint).toBe(expected.constraint);
    }
    if (expected.key !== undefined) {
      expect(err!.message).toContain(expected.key);
    }
    return err!;
  }

  async function expectAccepted(sql: string): Promise<void> {
    const err = await run(sql);
    expect(err).toBeNull();
  }

  beforeEach(async () => {
    await resetDb(app);

    const organization = await prisma.organization.create({
      data: { name: uniq('org'), nodeTypeCode: 'team' },
      select: { id: true },
    });
    organizationId = organization.id;

    const makeActivity = async (label: string) =>
      (
        await prisma.activity.create({
          data: {
            title: uniq(label),
            activityTypeCode: 'v11-slice1',
            organizationId,
            startAt: new Date(START_AT),
            endAt: new Date(END_AT),
            location: 'constraint fixture',
            statusCode: 'draft',
          },
          select: { id: true },
        })
      ).id;

    activityId = await makeActivity('activity');
    otherActivityId = await makeActivity('other-activity');

    const member = await prisma.member.create({
      data: { memberNo: uniq('member'), ...memberIdentityData('V11 Slice1 Member') },
      select: { id: true },
    });
    memberId = member.id;

    const registration = await prisma.activityRegistration.create({
      data: { activityId, memberId, statusCode: 'pending' },
      select: { id: true },
    });
    registrationId = registration.id;

    const makeSession = async (ownerActivityId: string, label: string) =>
      (
        await prisma.activitySession.create({
          data: {
            activityId: ownerActivityId,
            code: uniq(label),
            name: uniq(label),
            startAt: new Date(START_AT),
            endAt: new Date(END_AT),
            locationText: 'constraint fixture',
            checkInOpenAt: new Date(CHECKIN_OPEN),
            checkInCloseAt: new Date(CHECKIN_CLOSE),
            checkOutOpenAt: new Date(CHECKOUT_OPEN),
            checkOutCloseAt: new Date(CHECKOUT_CLOSE),
            locationRequired: false,
            locationPolicySourceCode: 'system',
            statusCode: 'scheduled',
          },
          select: { id: true },
        })
      ).id;

    sessionId = await makeSession(activityId, 'session');
    otherSessionId = await makeSession(otherActivityId, 'other-session');
    sameActivityOtherSessionId = await makeSession(activityId, 'same-activity-session-2');

    const position = await prisma.activitySessionPosition.create({
      data: {
        activityId,
        sessionId,
        code: uniq('position'),
        name: uniq('position'),
        attendanceRoleCode: 'volunteer',
      },
      select: { id: true },
    });
    positionId = position.id;

    const identity = await prisma.activityParticipationIdentity.create({
      data: { activityId, sessionId, registrationId, memberId, currentStatusCode: 'pending' },
      select: { id: true },
    });
    identityId = identity.id;

    const bucket = await prisma.activityCapacityBucket.create({
      data: { activityId, scopeTypeCode: 'session_participation', scopeId: sessionId, capacity: 5 },
      select: { id: true },
    });
    bucketId = bucket.id;
  });

  // ==========================================================================
  // ① 既有表 Activity 的新增约束(§3.1)
  //
  // 这些用 UPDATE 打:fixture 行已经存在,UPDATE 能精确隔离出"是这一列被拒",
  // 不会被 INSERT 缺列之类的无关错误污染。
  // ==========================================================================

  describe('§3.1 Activity 约束', () => {
    const upd = (setClause: string) =>
      `UPDATE "Activity" SET ${setClause} WHERE "id" = ${sqlText(activityId)}`;

    it('capacity=0 被拒(23514);capacity=1 与 NULL 放行', async () => {
      const err = await expectRejected(upd(`"capacity" = 0`), {
        sqlState: '23514',
        constraint: 'activity_capacity_positive_check',
      });
      expect(err.message).toContain('activity_capacity_positive_check');

      await expectAccepted(upd(`"capacity" = 1`));
      await expectAccepted(upd(`"capacity" = NULL`));
    });

    it('archiveWaitingDays 越界(-1 / 366)被拒;边界 0 与 365 放行', async () => {
      await expectRejected(upd(`"archiveWaitingDays" = -1`), {
        sqlState: '23514',
        constraint: 'activity_archive_waiting_days_range_check',
      });
      await expectRejected(upd(`"archiveWaitingDays" = 366`), {
        sqlState: '23514',
        constraint: 'activity_archive_waiting_days_range_check',
      });
      await expectAccepted(upd(`"archiveWaitingDays" = 0`));
      await expectAccepted(upd(`"archiveWaitingDays" = 365`));
    });

    it('两个 revision 为负被拒;0 与正数放行', async () => {
      await expectRejected(upd(`"currentEvidenceRevision" = -1`), {
        sqlState: '23514',
        constraint: 'activity_current_revision_non_negative_check',
      });
      await expectRejected(upd(`"currentPopulationRevision" = -1`), {
        sqlState: '23514',
        constraint: 'activity_current_revision_non_negative_check',
      });
      await expectAccepted(upd(`"currentEvidenceRevision" = 0, "currentPopulationRevision" = 7`));
    });

    it('registrationModeCode 闭集外被拒;四个合法值与 NULL 放行', async () => {
      await expectRejected(upd(`"registrationModeCode" = 'open'`), {
        sqlState: '23514',
        constraint: 'activity_registration_mode_code_check',
      });
      for (const code of ['open_apply', 'invitation_only', 'admin_only', 'paused']) {
        await expectAccepted(upd(`"registrationModeCode" = ${sqlText(code)}`));
      }
      // 本 expand 刀该列可空(null = 尚未解析),CHECK 必须放行 NULL。
      await expectAccepted(upd(`"registrationModeCode" = NULL`));
    });

    it('visibilityCode 闭集外被拒;internal / invitation / NULL 放行', async () => {
      await expectRejected(upd(`"visibilityCode" = 'public'`), {
        sqlState: '23514',
        constraint: 'activity_visibility_code_check',
      });
      await expectAccepted(upd(`"visibilityCode" = 'internal'`));
      await expectAccepted(upd(`"visibilityCode" = 'invitation'`));
      await expectAccepted(upd(`"visibilityCode" = NULL`));
    });

    it('terminatedAt 有值但 statusCode 不是 terminated → 被拒;配套改状态后放行', async () => {
      await expectRejected(upd(`"terminatedAt" = ${T(END_AT)}`), {
        sqlState: '23514',
        constraint: 'activity_termination_shape_check',
      });
      await expectAccepted(upd(`"terminatedAt" = ${T(END_AT)}, "statusCode" = 'terminated'`));
      // 反向:statusCode=terminated 但 terminatedAt 为空 —— 合同只要求单向蕴含,放行。
      await expectAccepted(upd(`"terminatedAt" = NULL, "statusCode" = 'terminated'`));
    });

    it('既有行在新 CHECK 下恒真:什么都不改的 UPDATE 全表放行(存量零改写自证)', async () => {
      await expectAccepted(`UPDATE "Activity" SET "title" = "title"`);
    });
  });

  // ==========================================================================
  // ② ActivitySession(§3.2)
  // ==========================================================================

  describe('§3.2 ActivitySession 约束', () => {
    interface SessionRow {
      id: string;
      activityId: string;
      code: string;
      name: string;
      startAt: string;
      endAt: string;
      checkInOpenAt: string;
      checkInCloseAt: string;
      checkOutOpenAt: string;
      checkOutCloseAt: string;
      preparationStartAt: string | null;
      locationRequired: boolean;
      radiusMeters: number | null;
      longitude: number | null;
      latitude: number | null;
      capacity: number | null;
      locationPolicySourceCode: string;
      statusCode: string;
      lateGraceMinutes: number;
      earlyLeaveThresholdMinutes: number;
      deletedAt: string | null;
    }

    function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
      const label = uniq('sess');
      return {
        id: label,
        activityId,
        code: label,
        name: label,
        startAt: START_AT,
        endAt: END_AT,
        checkInOpenAt: CHECKIN_OPEN,
        checkInCloseAt: CHECKIN_CLOSE,
        checkOutOpenAt: CHECKOUT_OPEN,
        checkOutCloseAt: CHECKOUT_CLOSE,
        preparationStartAt: null,
        locationRequired: false,
        radiusMeters: null,
        longitude: null,
        latitude: null,
        capacity: null,
        locationPolicySourceCode: 'system',
        statusCode: 'scheduled',
        lateGraceMinutes: 15,
        earlyLeaveThresholdMinutes: 15,
        deletedAt: null,
        ...overrides,
      };
    }

    function insertSession(overrides: Partial<SessionRow> = {}): string {
      const r = sessionRow(overrides);
      return `INSERT INTO "ActivitySession" (
        "id","activityId","code","name","startAt","endAt","locationText",
        "checkInOpenAt","checkInCloseAt","checkOutOpenAt","checkOutCloseAt","preparationStartAt",
        "locationRequired","radiusMeters","longitude","latitude","capacity",
        "locationPolicySourceCode","statusCode","lateGraceMinutes","earlyLeaveThresholdMinutes",
        "deletedAt","updatedAt"
      ) VALUES (
        ${sqlText(r.id)},${sqlText(r.activityId)},${sqlText(r.code)},${sqlText(r.name)},
        ${T(r.startAt)},${T(r.endAt)},'constraint fixture',
        ${T(r.checkInOpenAt)},${T(r.checkInCloseAt)},${T(r.checkOutOpenAt)},${T(r.checkOutCloseAt)},
        ${sqlTime(r.preparationStartAt)},
        ${sqlBool(r.locationRequired)},${sqlNum(r.radiusMeters)},
        ${sqlNum(r.longitude)},${sqlNum(r.latitude)},${sqlNum(r.capacity)},
        ${sqlText(r.locationPolicySourceCode)},${sqlText(r.statusCode)},
        ${sqlNum(r.lateGraceMinutes)},${sqlNum(r.earlyLeaveThresholdMinutes)},
        ${sqlTime(r.deletedAt)},now()
      )`;
    }

    it('capacity=0 被拒;capacity=1 / NULL 放行', async () => {
      await expectRejected(insertSession({ capacity: 0 }), {
        sqlState: '23514',
        constraint: 'activity_session_capacity_positive_check',
      });
      await expectAccepted(insertSession({ capacity: 1 }));
      await expectAccepted(insertSession({ capacity: null }));
    });

    it('startAt >= endAt 被拒(相等也拒);startAt < endAt 放行', async () => {
      await expectRejected(insertSession({ startAt: END_AT, endAt: START_AT }), {
        sqlState: '23514',
        constraint: 'activity_session_time_range_check',
      });
      await expectRejected(insertSession({ startAt: START_AT, endAt: START_AT }), {
        sqlState: '23514',
        constraint: 'activity_session_time_range_check',
      });
      await expectAccepted(insertSession());
    });

    it('签到窗口:checkInOpenAt > checkInCloseAt 被拒;checkInCloseAt > checkOutCloseAt 被拒', async () => {
      await expectRejected(
        insertSession({ checkInOpenAt: CHECKIN_CLOSE, checkInCloseAt: CHECKIN_OPEN }),
        { sqlState: '23514', constraint: 'activity_session_checkin_window_check' },
      );
      await expectRejected(insertSession({ checkInCloseAt: '2099-06-01T19:00:00.000Z' }), {
        sqlState: '23514',
        constraint: 'activity_session_checkin_window_check',
      });
      // 合同明写「允许签到和签退窗口重叠」—— 该形状必须放行。
      await expectAccepted(
        insertSession({ checkInCloseAt: CHECKOUT_CLOSE, checkOutOpenAt: CHECKIN_OPEN }),
      );
    });

    it('签退窗口:checkOutOpenAt > checkOutCloseAt 被拒;相等放行', async () => {
      await expectRejected(insertSession({ checkOutOpenAt: '2099-06-01T18:00:00.001Z' }), {
        sqlState: '23514',
        constraint: 'activity_session_checkout_window_check',
      });
      await expectAccepted(insertSession({ checkOutOpenAt: CHECKOUT_CLOSE }));
    });

    it('preparationStartAt 晚于 startAt 被拒;等于/早于/NULL 放行', async () => {
      await expectRejected(insertSession({ preparationStartAt: '2099-06-01T09:00:00.001Z' }), {
        sqlState: '23514',
        constraint: 'activity_session_preparation_start_check',
      });
      await expectAccepted(insertSession({ preparationStartAt: PREP_START }));
      await expectAccepted(insertSession({ preparationStartAt: START_AT }));
      await expectAccepted(insertSession({ preparationStartAt: null }));
    });

    it('坐标必须成对:只给经度 / 只给纬度被拒;同空、同有放行', async () => {
      await expectRejected(insertSession({ longitude: 116.4 }), {
        sqlState: '23514',
        constraint: 'activity_session_coordinate_pair_check',
      });
      await expectRejected(insertSession({ latitude: 39.9 }), {
        sqlState: '23514',
        constraint: 'activity_session_coordinate_pair_check',
      });
      await expectAccepted(insertSession({ longitude: 116.4, latitude: 39.9 }));
      await expectAccepted(insertSession());
    });

    it('定位策略:false 带半径被拒;true 缺半径/缺坐标被拒;半径越界(49/10001)被拒', async () => {
      await expectRejected(insertSession({ locationRequired: false, radiusMeters: 100 }), {
        sqlState: '23514',
        constraint: 'activity_session_location_policy_check',
      });
      await expectRejected(
        insertSession({
          locationRequired: true,
          radiusMeters: null,
          longitude: 116.4,
          latitude: 39.9,
        }),
        { sqlState: '23514', constraint: 'activity_session_location_policy_check' },
      );
      await expectRejected(
        insertSession({
          locationRequired: true,
          radiusMeters: 100,
          longitude: null,
          latitude: null,
        }),
        { sqlState: '23514', constraint: 'activity_session_location_policy_check' },
      );
      await expectRejected(
        insertSession({
          locationRequired: true,
          radiusMeters: 49,
          longitude: 116.4,
          latitude: 39.9,
        }),
        { sqlState: '23514', constraint: 'activity_session_location_policy_check' },
      );
      await expectRejected(
        insertSession({
          locationRequired: true,
          radiusMeters: 10001,
          longitude: 116.4,
          latitude: 39.9,
        }),
        { sqlState: '23514', constraint: 'activity_session_location_policy_check' },
      );

      // 边界 50 / 10000 放行;false + 坐标(导航用)放行。
      await expectAccepted(
        insertSession({
          locationRequired: true,
          radiusMeters: 50,
          longitude: 116.4,
          latitude: 39.9,
        }),
      );
      await expectAccepted(
        insertSession({
          locationRequired: true,
          radiusMeters: 10000,
          longitude: 116.4,
          latitude: 39.9,
        }),
      );
      await expectAccepted(
        insertSession({
          locationRequired: false,
          radiusMeters: null,
          longitude: 116.4,
          latitude: 39.9,
        }),
      );
    });

    it('statusCode 闭集外被拒;三个合法值放行', async () => {
      await expectRejected(insertSession({ statusCode: 'ongoing' }), {
        sqlState: '23514',
        constraint: 'activity_session_status_code_check',
      });
      for (const code of ['scheduled', 'cancelled', 'terminated']) {
        await expectAccepted(insertSession({ statusCode: code }));
      }
    });

    it('locationPolicySourceCode 闭集外被拒;五个合法值放行', async () => {
      await expectRejected(insertSession({ locationPolicySourceCode: 'manual' }), {
        sqlState: '23514',
        constraint: 'activity_session_location_policy_source_check',
      });
      for (const code of ['system', 'template', 'activity', 'session', 'position']) {
        await expectAccepted(insertSession({ locationPolicySourceCode: code }));
      }
    });

    it('迟到/早退阈值越界(-1 / 61)被拒;边界 0 与 60 放行', async () => {
      await expectRejected(insertSession({ lateGraceMinutes: -1 }), {
        sqlState: '23514',
        constraint: 'activity_session_grace_minutes_range_check',
      });
      await expectRejected(insertSession({ earlyLeaveThresholdMinutes: 61 }), {
        sqlState: '23514',
        constraint: 'activity_session_grace_minutes_range_check',
      });
      await expectAccepted(insertSession({ lateGraceMinutes: 0, earlyLeaveThresholdMinutes: 60 }));
    });

    it('live (activityId, code) 唯一:同活动重复 code 被拒;软删后释放槽位;别的活动同 code 放行', async () => {
      const code = uniq('dup-code');
      await expectAccepted(insertSession({ code }));
      await expectRejected(insertSession({ code }), {
        sqlState: '23505',
        key: 'Key ("activityId", code)',
      });
      // 别的活动用同一个 code —— 唯一性只在活动内,必须放行。
      await expectAccepted(insertSession({ code, activityId: otherActivityId }));
      // partial 的意义:软删既有行后,同 code 可以重新建。
      await expectAccepted(
        `UPDATE "ActivitySession" SET "deletedAt" = now()
         WHERE "activityId" = ${sqlText(activityId)} AND "code" = ${sqlText(code)}`,
      );
      await expectAccepted(insertSession({ code }));
    });

    it('live (activityId, name) 唯一:同活动重复 name 被拒;软删后释放槽位', async () => {
      const name = uniq('dup-name');
      await expectAccepted(insertSession({ name }));
      await expectRejected(insertSession({ name }), {
        sqlState: '23505',
        key: 'Key ("activityId", name)',
      });
      await expectAccepted(
        `UPDATE "ActivitySession" SET "deletedAt" = now()
         WHERE "activityId" = ${sqlText(activityId)} AND "name" = ${sqlText(name)}`,
      );
      await expectAccepted(insertSession({ name }));
    });
  });

  // ==========================================================================
  // ③ ActivitySessionPosition(§3.3)
  // ==========================================================================

  describe('§3.3 ActivitySessionPosition 约束', () => {
    interface PositionRow {
      id: string;
      activityId: string;
      sessionId: string;
      code: string;
      name: string;
      capacity: number | null;
      startAt: string | null;
      endAt: string | null;
      locationRequired: boolean | null;
      radiusMeters: number | null;
      deletedAt: string | null;
    }

    function insertPosition(overrides: Partial<PositionRow> = {}): string {
      const label = uniq('pos');
      const r: PositionRow = {
        id: label,
        activityId,
        sessionId,
        code: label,
        name: label,
        capacity: null,
        startAt: null,
        endAt: null,
        locationRequired: null,
        radiusMeters: null,
        deletedAt: null,
        ...overrides,
      };
      return `INSERT INTO "ActivitySessionPosition" (
        "id","activityId","sessionId","code","name","attendanceRoleCode","capacity",
        "startAt","endAt","locationRequired","radiusMeters","deletedAt","updatedAt"
      ) VALUES (
        ${sqlText(r.id)},${sqlText(r.activityId)},${sqlText(r.sessionId)},
        ${sqlText(r.code)},${sqlText(r.name)},'volunteer',${sqlNum(r.capacity)},
        ${sqlTime(r.startAt)},${sqlTime(r.endAt)},
        ${sqlBool(r.locationRequired)},${sqlNum(r.radiusMeters)},
        ${sqlTime(r.deletedAt)},now()
      )`;
    }

    it('capacity=0 被拒;1 / NULL 放行', async () => {
      await expectRejected(insertPosition({ capacity: 0 }), {
        sqlState: '23514',
        constraint: 'activity_session_position_capacity_positive_check',
      });
      await expectAccepted(insertPosition({ capacity: 1 }));
      await expectAccepted(insertPosition({ capacity: null }));
    });

    it('startAt/endAt 必须同空同有且有序:只给一个被拒、逆序被拒;同空/同有有序放行', async () => {
      await expectRejected(insertPosition({ startAt: START_AT }), {
        sqlState: '23514',
        constraint: 'activity_session_position_time_pair_check',
      });
      await expectRejected(insertPosition({ endAt: END_AT }), {
        sqlState: '23514',
        constraint: 'activity_session_position_time_pair_check',
      });
      await expectRejected(insertPosition({ startAt: END_AT, endAt: START_AT }), {
        sqlState: '23514',
        constraint: 'activity_session_position_time_pair_check',
      });
      await expectAccepted(insertPosition());
      await expectAccepted(insertPosition({ startAt: START_AT, endAt: END_AT }));
    });

    it('定位覆盖:显式 false 带半径被拒、半径越界被拒;只覆盖半径(locationRequired 留空)放行', async () => {
      await expectRejected(insertPosition({ locationRequired: false, radiusMeters: 100 }), {
        sqlState: '23514',
        constraint: 'activity_session_position_location_policy_check',
      });
      await expectRejected(insertPosition({ locationRequired: true, radiusMeters: 49 }), {
        sqlState: '23514',
        constraint: 'activity_session_position_location_policy_check',
      });
      await expectRejected(insertPosition({ radiusMeters: 10001 }), {
        sqlState: '23514',
        constraint: 'activity_session_position_location_policy_check',
      });
      // 岗位允许只覆盖半径而继承 session 的 locationRequired —— 该形状必须放行。
      await expectAccepted(insertPosition({ locationRequired: null, radiusMeters: 100 }));
      await expectAccepted(insertPosition({ locationRequired: false, radiusMeters: null }));
      await expectAccepted(insertPosition({ locationRequired: true, radiusMeters: 50 }));
    });

    it('live (sessionId, code) / (sessionId, name) 唯一;软删后释放槽位', async () => {
      const code = uniq('pos-dup-code');
      await expectAccepted(insertPosition({ code }));
      await expectRejected(insertPosition({ code }), {
        sqlState: '23505',
        key: 'Key ("sessionId", code)',
      });
      await expectAccepted(
        `UPDATE "ActivitySessionPosition" SET "deletedAt" = now()
         WHERE "sessionId" = ${sqlText(sessionId)} AND "code" = ${sqlText(code)}`,
      );
      await expectAccepted(insertPosition({ code }));

      const name = uniq('pos-dup-name');
      await expectAccepted(insertPosition({ name }));
      await expectRejected(insertPosition({ name }), {
        sqlState: '23505',
        key: 'Key ("sessionId", name)',
      });
    });

    it('复合 FK 真的挡住"岗位挂到别的活动的场次上"(23503)', async () => {
      // activityId 属活动 A,sessionId 属活动 B —— 单列 FK 挡不住,复合 FK 必须挡住。
      const err = await expectRejected(insertPosition({ activityId, sessionId: otherSessionId }), {
        sqlState: '23503',
        constraint: 'ActivitySessionPosition_activityId_sessionId_fkey',
      });
      expect(err.message).toContain('ActivitySessionPosition_activityId_sessionId_fkey');
      // 两个锚点一致时放行。
      await expectAccepted(
        insertPosition({ activityId: otherActivityId, sessionId: otherSessionId }),
      );
    });
  });

  // ==========================================================================
  // ④ ActivityParticipationIdentity(§3.8)
  // ==========================================================================

  describe('§3.8 ActivityParticipationIdentity 约束', () => {
    interface IdentityRow {
      id: string;
      activityId: string;
      sessionId: string;
      registrationId: string;
      memberId: string;
      currentStatusCode: string;
      currentRevision: number;
      version: number;
      capacityReservationId: string | null;
    }

    function insertIdentity(overrides: Partial<IdentityRow> = {}): string {
      const label = uniq('ident');
      const r: IdentityRow = {
        id: label,
        activityId,
        sessionId,
        registrationId,
        memberId,
        currentStatusCode: 'pending',
        currentRevision: 0,
        version: 0,
        capacityReservationId: null,
        ...overrides,
      };
      return `INSERT INTO "ActivityParticipationIdentity" (
        "id","activityId","sessionId","registrationId","memberId","currentStatusCode",
        "currentRevision","version","capacityReservationId","updatedAt"
      ) VALUES (
        ${sqlText(r.id)},${sqlText(r.activityId)},${sqlText(r.sessionId)},
        ${sqlText(r.registrationId)},${sqlText(r.memberId)},${sqlText(r.currentStatusCode)},
        ${sqlNum(r.currentRevision)},${sqlNum(r.version)},
        ${sqlText(r.capacityReservationId)},now()
      )`;
    }

    it('(activityId, sessionId, memberId) 唯一 —— 且**不带删除条件**:改成 cancelled 后仍然拒第二行', async () => {
      // fixture 里已有一行 (activityId, sessionId, memberId)。
      await expectRejected(insertIdentity(), {
        sqlState: '23505',
        key: 'Key ("activityId", "sessionId", "memberId")',
      });

      // §3.8 的核心判据:取消重报**永不再建身份行**。
      // 把当前身份置为 cancelled 之后,第二行**仍然**必须被拒 —— 这正是
      // "普通 unique 而非 partial unique" 的可观测差别。若换成带删除条件的
      // partial unique,下面这条就会放行,本用例即变红。
      await expectAccepted(
        `UPDATE "ActivityParticipationIdentity" SET "currentStatusCode" = 'cancelled'
         WHERE "id" = ${sqlText(identityId)}`,
      );
      await expectRejected(insertIdentity(), {
        sqlState: '23505',
        key: 'Key ("activityId", "sessionId", "memberId")',
      });

      // 换一个场次则放行(唯一键含 sessionId)。
      // ⚠️ 这里必须换**同一活动内**的另一个场次:原本写的是 otherActivity + otherSession,
      // 那个样本在 activityId 与 sessionId 两维上同时不同,证明不了「唯一键含 sessionId」;
      // 而且 registrationId / memberId 仍是本活动的,复合锚点闭合后它会被
      // ActivityParticipationIdentity_registrationId_activityId_me_fkey 直接拒掉。
      await expectAccepted(insertIdentity({ sessionId: sameActivityOtherSessionId }));
    });

    it('currentStatusCode 闭集外被拒;14 个合法值全部放行', async () => {
      await expectRejected(insertIdentity({ currentStatusCode: 'approved' }), {
        sqlState: '23514',
        constraint: 'activity_participation_identity_status_code_check',
      });

      const all = [
        'pending',
        'pass',
        'waitlisted',
        'not_selected',
        'rejected',
        'cancelled',
        'cancellation_requested',
        'invitation_pending',
        'invitation_declined',
        'invitation_expired',
        'review_expired',
        'waitlist_expired',
        'attended',
        'settled',
      ];
      expect(all).toHaveLength(14);
      // 唯一键占用 (activityId, sessionId, memberId),故逐个值用 UPDATE 验放行。
      for (const code of all) {
        await expectAccepted(
          `UPDATE "ActivityParticipationIdentity" SET "currentStatusCode" = ${sqlText(code)}
           WHERE "id" = ${sqlText(identityId)}`,
        );
      }
    });

    it('currentRevision / version 为负被拒;0 与正数放行', async () => {
      const upd = (s: string) =>
        `UPDATE "ActivityParticipationIdentity" SET ${s} WHERE "id" = ${sqlText(identityId)}`;
      await expectRejected(upd(`"currentRevision" = -1`), {
        sqlState: '23514',
        constraint: 'activity_participation_identity_counter_check',
      });
      await expectRejected(upd(`"version" = -1`), {
        sqlState: '23514',
        constraint: 'activity_participation_identity_counter_check',
      });
      await expectAccepted(upd(`"currentRevision" = 3, "version" = 9`));
    });

    it('复合 FK 挡住"身份挂到别的活动的场次上"(23503)', async () => {
      await expectRejected(insertIdentity({ activityId, sessionId: otherSessionId }), {
        sqlState: '23503',
        constraint: 'ActivityParticipationIdentity_activityId_sessionId_fkey',
      });
    });

    it('currentPositionId:指向真实岗位放行,指向不存在的岗位被 FK 拒(23503)', async () => {
      const upd = (value: string) =>
        `UPDATE "ActivityParticipationIdentity" SET "currentPositionId" = ${value}
         WHERE "id" = ${sqlText(identityId)}`;
      await expectAccepted(upd(sqlText(positionId)));
      await expectAccepted(upd('NULL'));
      await expectRejected(upd(sqlText('position-that-does-not-exist')), {
        sqlState: '23503',
        constraint: 'ActivityParticipationIdentity_currentPositionId_activityId_fkey',
      });
    });

    // ===== DoD 7:capacityReservationId 是**不带 FK** 的快速指针 =====
    it('capacityReservationId 悬空指针被 DB 放行(证明确实没加 FK),由对账查询发现', async () => {
      const dangling = 'reservation-that-does-not-exist';
      // ① 没有 FK ⇒ DB 接受悬空指针。这正是选项 (a) 的代价,必须显式钉住。
      await expectAccepted(
        `UPDATE "ActivityParticipationIdentity"
         SET "capacityReservationId" = ${sqlText(dangling)}
         WHERE "id" = ${sqlText(identityId)}`,
      );

      // ② 失同步的发现手段:LEFT JOIN 对账 —— 指针非空却查不到 reservation 行。
      const orphans = await prisma.$queryRawUnsafe<
        Array<{ id: string; capacityReservationId: string }>
      >(
        `SELECT i."id", i."capacityReservationId"
         FROM "ActivityParticipationIdentity" i
         LEFT JOIN "CapacityReservation" r ON r."id" = i."capacityReservationId"
         WHERE i."capacityReservationId" IS NOT NULL AND r."id" IS NULL`,
      );
      expect(orphans).toHaveLength(1);
      expect(orphans[0]).toMatchObject({ id: identityId, capacityReservationId: dangling });

      // ③ 反向:指针指向真实 reservation 时,同一对账查询必须查不出任何行
      //    —— 否则这条"对账"是恒真的假判据。
      await expectAccepted(
        `INSERT INTO "CapacityReservation"
           ("id","identityId","bucketId","reservationType","status","updatedAt")
         VALUES ('real-reservation',${sqlText(identityId)},${sqlText(bucketId)},
                 'session_participation','active',now())`,
      );
      await expectAccepted(
        `UPDATE "ActivityParticipationIdentity" SET "capacityReservationId" = 'real-reservation'
         WHERE "id" = ${sqlText(identityId)}`,
      );
      const clean = await prisma.$queryRawUnsafe<unknown[]>(
        `SELECT i."id"
         FROM "ActivityParticipationIdentity" i
         LEFT JOIN "CapacityReservation" r ON r."id" = i."capacityReservationId"
         WHERE i."capacityReservationId" IS NOT NULL AND r."id" IS NULL`,
      );
      expect(clean).toHaveLength(0);
    });
  });

  // ==========================================================================
  // ⑤ ActivityParticipationRevision(§3.9)
  // ==========================================================================

  describe('§3.9 ActivityParticipationRevision 约束', () => {
    function insertRevision(
      overrides: { id?: string; revision?: number; statusCode?: string } = {},
    ): string {
      const label = uniq('rev');
      const { id = label, revision = 1, statusCode = 'pending' } = overrides;
      return `INSERT INTO "ActivityParticipationRevision" (
        "id","identityId","revision","statusCode","effectiveAt","sourceCode"
      ) VALUES (
        ${sqlText(id)},${sqlText(identityId)},${sqlNum(revision)},
        ${sqlText(statusCode)},${T(START_AT)},'self'
      )`;
    }

    it('(identityId, revision) 唯一:同一 identity 重复 revision 被拒;换号放行', async () => {
      await expectAccepted(insertRevision({ revision: 1 }));
      await expectRejected(insertRevision({ revision: 1 }), {
        sqlState: '23505',
        key: 'Key ("identityId", revision)',
      });
      await expectAccepted(insertRevision({ revision: 2 }));
    });

    it('revision 为负被拒;0 放行', async () => {
      await expectRejected(insertRevision({ revision: -1 }), {
        sqlState: '23514',
        constraint: 'activity_participation_revision_number_check',
      });
      await expectAccepted(insertRevision({ revision: 0 }));
    });

    it('statusCode 闭集外被拒;14 个合法值全部放行', async () => {
      await expectRejected(insertRevision({ statusCode: 'approved' }), {
        sqlState: '23514',
        constraint: 'activity_participation_revision_status_code_check',
      });
      const all = [
        'pending',
        'pass',
        'waitlisted',
        'not_selected',
        'rejected',
        'cancelled',
        'cancellation_requested',
        'invitation_pending',
        'invitation_declined',
        'invitation_expired',
        'review_expired',
        'waitlist_expired',
        'attended',
        'settled',
      ];
      expect(all).toHaveLength(14);
      let revision = 100;
      for (const statusCode of all) {
        await expectAccepted(insertRevision({ statusCode, revision: (revision += 1) }));
      }
    });
  });

  // ==========================================================================
  // ⑥ ActivityCapacityBucket(§3.10)
  // ==========================================================================

  describe('§3.10 ActivityCapacityBucket 约束', () => {
    function insertBucket(
      overrides: {
        id?: string;
        scopeTypeCode?: string;
        scopeId?: string;
        capacity?: number | null;
        occupied?: number;
        version?: number;
      } = {},
    ): string {
      const label = uniq('bucket');
      const {
        id = label,
        scopeTypeCode = 'position_participation',
        scopeId = label,
        capacity = 10,
        occupied = 0,
        version = 0,
      } = overrides;
      return `INSERT INTO "ActivityCapacityBucket" (
        "id","activityId","scopeTypeCode","scopeId","capacity","occupied","version","updatedAt"
      ) VALUES (
        ${sqlText(id)},${sqlText(activityId)},${sqlText(scopeTypeCode)},${sqlText(scopeId)},
        ${sqlNum(capacity)},${sqlNum(occupied)},${sqlNum(version)},now()
      )`;
    }

    it('(scopeTypeCode, scopeId) 唯一:重复被拒;换 scopeType 或换 scopeId 放行', async () => {
      const scopeId = uniq('scope');
      await expectAccepted(insertBucket({ scopeTypeCode: 'session_participation', scopeId }));
      await expectRejected(insertBucket({ scopeTypeCode: 'session_participation', scopeId }), {
        sqlState: '23505',
        key: 'Key ("scopeTypeCode", "scopeId")',
      });
      await expectAccepted(insertBucket({ scopeTypeCode: 'position_participation', scopeId }));
      await expectAccepted(insertBucket({ scopeTypeCode: 'session_participation' }));
    });

    it('scopeTypeCode 闭集外被拒;四个合法值放行', async () => {
      await expectRejected(insertBucket({ scopeTypeCode: 'activity' }), {
        sqlState: '23514',
        constraint: 'activity_capacity_bucket_scope_type_code_check',
      });
      for (const code of [
        'activity_person',
        'session_participation',
        'position_participation',
        'reserve_group',
      ]) {
        await expectAccepted(insertBucket({ scopeTypeCode: code }));
      }
    });

    it('capacity=0 被拒;1 / NULL 放行', async () => {
      await expectRejected(insertBucket({ capacity: 0 }), {
        sqlState: '23514',
        constraint: 'activity_capacity_bucket_capacity_positive_check',
      });
      await expectAccepted(insertBucket({ capacity: 1 }));
      await expectAccepted(insertBucket({ capacity: null }));
    });

    it('超卖闸:occupied 为负被拒、occupied > capacity 被拒;occupied = capacity 放行;capacity=NULL 时不设上限', async () => {
      await expectRejected(insertBucket({ occupied: -1 }), {
        sqlState: '23514',
        constraint: 'activity_capacity_bucket_occupancy_check',
      });
      await expectRejected(insertBucket({ capacity: 10, occupied: 11 }), {
        sqlState: '23514',
        constraint: 'activity_capacity_bucket_occupancy_check',
      });
      await expectAccepted(insertBucket({ capacity: 10, occupied: 10 }));
      await expectAccepted(insertBucket({ capacity: null, occupied: 999999 }));

      // UPDATE 路径同样被咬 —— 占位事务真正的写法是 UPDATE occupied,不是 INSERT。
      const id = uniq('bucket-upd');
      await expectAccepted(insertBucket({ id, capacity: 3, occupied: 3 }));
      await expectRejected(
        `UPDATE "ActivityCapacityBucket" SET "occupied" = 4 WHERE "id" = ${sqlText(id)}`,
        { sqlState: '23514', constraint: 'activity_capacity_bucket_occupancy_check' },
      );
    });

    it('version 为负被拒;0 放行', async () => {
      await expectRejected(insertBucket({ version: -1 }), {
        sqlState: '23514',
        constraint: 'activity_capacity_bucket_version_check',
      });
      await expectAccepted(insertBucket({ version: 0 }));
    });
  });

  // ==========================================================================
  // ⑦ CapacityReservation(§3.10)
  // ==========================================================================

  describe('§3.10 CapacityReservation 约束', () => {
    function insertReservation(
      overrides: {
        id?: string;
        identityId?: string;
        bucketId?: string;
        status?: string;
        releasedAt?: string | null;
      } = {},
    ): string {
      const label = uniq('resv');
      const {
        id = label,
        identityId: iid = identityId,
        bucketId: bid = bucketId,
        status = 'active',
        releasedAt = null,
      } = overrides;
      return `INSERT INTO "CapacityReservation" (
        "id","identityId","bucketId","reservationType","status","releasedAt","updatedAt"
      ) VALUES (
        ${sqlText(id)},${sqlText(iid)},${sqlText(bid)},'session_participation',
        ${sqlText(status)},${sqlTime(releasedAt)},now()
      )`;
    }

    it('status 闭集外被拒(只断言 23514,不断言命中哪条约束)', async () => {
      // ⚠️ 非法 status 会让 release_shape_check 的两个分支**同时为假**,于是它在
      // INSERT 路径上覆盖 status_check。断言具体约束名会是假绿(沿 wecom T1 实测教训),
      // 故这里只断言 SQLSTATE。
      const err = await expectRejected(insertReservation({ status: 'pending' }), {
        sqlState: '23514',
      });
      expect(err.message).toContain('CapacityReservation');
      await expectAccepted(insertReservation({ status: 'active' }));
      await expectAccepted(insertReservation({ status: 'released', releasedAt: END_AT }));
    });

    it('释放形状:active 带 releasedAt 被拒;released 缺 releasedAt 被拒', async () => {
      // 这两条用**合法 status** 触发,才能把 shape_check 与 status_check 隔离开。
      await expectRejected(insertReservation({ status: 'active', releasedAt: END_AT }), {
        sqlState: '23514',
        constraint: 'capacity_reservation_release_shape_check',
      });
      await expectRejected(insertReservation({ status: 'released', releasedAt: null }), {
        sqlState: '23514',
        constraint: 'capacity_reservation_release_shape_check',
      });
    });

    it('partial unique:同 (identity,bucket) 第二条 active 被拒;释放后可重新占位;released 可重复', async () => {
      const first = uniq('resv-a');
      await expectAccepted(insertReservation({ id: first }));

      const err = await expectRejected(insertReservation(), {
        sqlState: '23505',
        key: 'Key ("identityId", "bucketId")',
      });
      expect(err.message).toContain('already exists');

      // partial 的意义:释放后槽位必须放开,否则"释放后重新占位"被永久挡死。
      await expectAccepted(
        `UPDATE "CapacityReservation" SET "status" = 'released', "releasedAt" = now()
         WHERE "id" = ${sqlText(first)}`,
      );
      await expectAccepted(insertReservation());

      // released 历史行可以有任意多条(索引只覆盖 active)。
      await expectAccepted(insertReservation({ status: 'released', releasedAt: END_AT }));
      await expectAccepted(insertReservation({ status: 'released', releasedAt: END_AT }));
    });

    it('换一个 bucket 时同一 identity 可以再有一条 active(唯一键是 identity+bucket 组合)', async () => {
      await expectAccepted(insertReservation());
      const otherBucket = uniq('bucket-other');
      await expectAccepted(
        `INSERT INTO "ActivityCapacityBucket"
           ("id","activityId","scopeTypeCode","scopeId","capacity","updatedAt")
         VALUES (${sqlText(otherBucket)},${sqlText(activityId)},'activity_person',
                 ${sqlText(otherBucket)},5,now())`,
      );
      await expectAccepted(insertReservation({ bucketId: otherBucket }));
    });

    interface ActivityPersonReservationFixture {
      identityId: string;
      bucketId: string;
      memberId: string;
      activityId: string;
    }

    async function createActivityPersonReservationFixture(
      overrides: {
        activityId?: string;
        memberId?: string;
        registrationId?: string;
      } = {},
    ): Promise<ActivityPersonReservationFixture> {
      const targetActivityId = overrides.activityId ?? activityId;
      const targetMemberId = overrides.memberId ?? memberId;
      const targetRegistrationId = overrides.registrationId ?? registrationId;
      const session = await prisma.activitySession.create({
        data: {
          activityId: targetActivityId,
          code: uniq('activity-person-session'),
          name: uniq('activity-person-session'),
          startAt: new Date(START_AT),
          endAt: new Date(END_AT),
          locationText: 'constraint fixture',
          checkInOpenAt: new Date(CHECKIN_OPEN),
          checkInCloseAt: new Date(CHECKIN_CLOSE),
          checkOutOpenAt: new Date(CHECKOUT_OPEN),
          checkOutCloseAt: new Date(CHECKOUT_CLOSE),
          locationRequired: false,
          locationPolicySourceCode: 'system',
          statusCode: 'scheduled',
        },
        select: { id: true },
      });
      const identity = await prisma.activityParticipationIdentity.create({
        data: {
          activityId: targetActivityId,
          sessionId: session.id,
          registrationId: targetRegistrationId,
          memberId: targetMemberId,
          currentStatusCode: 'pending',
        },
        select: { id: true },
      });
      const bucket = await prisma.activityCapacityBucket.create({
        data: {
          activityId: targetActivityId,
          scopeTypeCode: 'activity_person',
          scopeId: uniq('activity-person-bucket'),
          capacity: 5,
        },
        select: { id: true },
      });
      return {
        identityId: identity.id,
        bucketId: bucket.id,
        memberId: targetMemberId,
        activityId: targetActivityId,
      };
    }

    async function createRegistrationFor(
      targetActivityId: string,
      targetMemberId: string,
    ): Promise<string> {
      const registration = await prisma.activityRegistration.create({
        data: { activityId: targetActivityId, memberId: targetMemberId, statusCode: 'pending' },
        select: { id: true },
      });
      return registration.id;
    }

    function insertActivityPersonReservation(
      fixture: ActivityPersonReservationFixture,
      overrides: {
        id?: string;
        memberId?: string | null;
        activityId?: string | null;
        status?: string;
        releasedAt?: string | null;
      } = {},
    ): string {
      const label = uniq('activity-person-resv');
      const {
        id = label,
        memberId: reservationMemberId = fixture.memberId,
        activityId: reservationActivityId = fixture.activityId,
        status = 'active',
        releasedAt = null,
      } = overrides;
      return `INSERT INTO "CapacityReservation" (
        "id","identityId","bucketId","memberId","activityId","reservationType","status","releasedAt","updatedAt"
      ) VALUES (
        ${sqlText(id)},${sqlText(fixture.identityId)},${sqlText(fixture.bucketId)},
        ${sqlText(reservationMemberId)},${sqlText(reservationActivityId)},'activity_person',
        ${sqlText(status)},${sqlTime(releasedAt)},now()
      )`;
    }

    it('第 78 migration:两列是 nullable text，且各自为 Restrict FK', async () => {
      const columns = await prisma.$queryRawUnsafe<
        Array<{ column_name: string; data_type: string; is_nullable: string }>
      >(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'CapacityReservation'
           AND column_name IN ('memberId', 'activityId')
         ORDER BY column_name`,
      );
      expect(columns).toEqual([
        { column_name: 'activityId', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'memberId', data_type: 'text', is_nullable: 'YES' },
      ]);

      const foreignKeys = await prisma.$queryRawUnsafe<
        Array<{
          column_name: string;
          foreign_table_name: string;
          delete_rule: string;
          update_rule: string;
        }>
      >(
        `SELECT kcu.column_name, ccu.table_name AS foreign_table_name,
                rc.delete_rule, rc.update_rule
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_catalog = kcu.constraint_catalog
          AND tc.constraint_schema = kcu.constraint_schema
          AND tc.constraint_name = kcu.constraint_name
         JOIN information_schema.referential_constraints rc
           ON tc.constraint_catalog = rc.constraint_catalog
          AND tc.constraint_schema = rc.constraint_schema
          AND tc.constraint_name = rc.constraint_name
         JOIN information_schema.constraint_column_usage ccu
           ON rc.unique_constraint_catalog = ccu.constraint_catalog
          AND rc.unique_constraint_schema = ccu.constraint_schema
          AND rc.unique_constraint_name = ccu.constraint_name
         WHERE tc.table_schema = current_schema()
           AND tc.table_name = 'CapacityReservation'
           AND tc.constraint_type = 'FOREIGN KEY'
           AND kcu.column_name IN ('memberId', 'activityId')
         ORDER BY kcu.column_name`,
      );
      expect(foreignKeys).toEqual([
        {
          column_name: 'activityId',
          foreign_table_name: 'Activity',
          delete_rule: 'RESTRICT',
          update_rule: 'CASCADE',
        },
        {
          column_name: 'memberId',
          foreign_table_name: 'Member',
          delete_rule: 'RESTRICT',
          update_rule: 'CASCADE',
        },
      ]);

      const indexes = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = current_schema()
           AND tablename = 'CapacityReservation'
           AND indexname LIKE 'capacity_reservation_member_activity%'
         ORDER BY indexname`,
      );
      expect(indexes).toEqual([
        { indexname: 'capacity_reservation_member_activity_active_person_unique' },
      ]);
    });

    it('active activity-person reservation 带完整 member/activity 锚点时放行', async () => {
      const fixture = await createActivityPersonReservationFixture();
      await expectAccepted(insertActivityPersonReservation(fixture));
    });

    it('active activity-person reservation 缺任一 member/activity 锚点均被具名 CHECK 拒绝', async () => {
      const fixture = await createActivityPersonReservationFixture();
      await expectRejected(insertActivityPersonReservation(fixture, { memberId: null }), {
        sqlState: '23514',
        constraint: 'capacity_reservation_active_activity_person_anchor_check',
      });
      await expectRejected(insertActivityPersonReservation(fixture, { activityId: null }), {
        sqlState: '23514',
        constraint: 'capacity_reservation_active_activity_person_anchor_check',
      });
      await expectAccepted(insertActivityPersonReservation(fixture));
    });

    it('两个不同 identity、不同 bucket 的同 member/activity active activity-person 第二条被拒', async () => {
      const first = await createActivityPersonReservationFixture();
      const second = await createActivityPersonReservationFixture();
      expect(second.identityId).not.toBe(first.identityId);
      expect(second.bucketId).not.toBe(first.bucketId);
      expect(second.memberId).toBe(first.memberId);
      expect(second.activityId).toBe(first.activityId);

      await expectAccepted(insertActivityPersonReservation(first));
      const err = await expectRejected(insertActivityPersonReservation(second), {
        sqlState: '23505',
        key: 'Key ("memberId", "activityId")',
      });
      expect(err.message).toContain('already exists');
    });

    it('active activity-person 释放后，相同 member/activity 可重新 active', async () => {
      const first = await createActivityPersonReservationFixture();
      const second = await createActivityPersonReservationFixture();
      const firstId = uniq('activity-person-first');
      await expectAccepted(insertActivityPersonReservation(first, { id: firstId }));
      await expectAccepted(
        `UPDATE "CapacityReservation" SET "status" = 'released', "releasedAt" = now()
         WHERE "id" = ${sqlText(firstId)}`,
      );
      await expectAccepted(insertActivityPersonReservation(second));
    });

    it('同 member、不同 activity 的 active activity-person reservation 同时放行', async () => {
      const first = await createActivityPersonReservationFixture();
      const otherRegistrationId = await createRegistrationFor(otherActivityId, memberId);
      const second = await createActivityPersonReservationFixture({
        activityId: otherActivityId,
        registrationId: otherRegistrationId,
      });
      expect(second.memberId).toBe(first.memberId);
      expect(second.activityId).not.toBe(first.activityId);

      await expectAccepted(insertActivityPersonReservation(first));
      await expectAccepted(insertActivityPersonReservation(second));
    });

    it('不同 member、同 activity 的 active activity-person reservation 同时放行', async () => {
      const first = await createActivityPersonReservationFixture();
      const otherMember = await prisma.member.create({
        data: { memberNo: uniq('other-member'), ...memberIdentityData('V11 Slice1 Other Member') },
        select: { id: true },
      });
      const otherRegistrationId = await createRegistrationFor(activityId, otherMember.id);
      const second = await createActivityPersonReservationFixture({
        memberId: otherMember.id,
        registrationId: otherRegistrationId,
      });
      expect(second.memberId).not.toBe(first.memberId);
      expect(second.activityId).toBe(first.activityId);

      await expectAccepted(insertActivityPersonReservation(first));
      await expectAccepted(insertActivityPersonReservation(second));
    });

    it('session_participation reservation 仍可让两列保持 NULL', async () => {
      const id = uniq('session-reservation-null-anchor');
      await expectAccepted(insertReservation({ id }));
      const rows = await prisma.$queryRawUnsafe<
        Array<{ memberId: string | null; activityId: string | null }>
      >(
        `SELECT "memberId", "activityId" FROM "CapacityReservation"
         WHERE "id" = ${sqlText(id)}`,
      );
      expect(rows).toEqual([{ memberId: null, activityId: null }]);
    });
  });

  // ==========================================================================
  // ⑧ ActivityRegistration 永久报名头(第 81 migration)
  // ==========================================================================

  describe('第 81 migration:ActivityRegistration 永久报名头 unique', () => {
    function insertRegistration(
      overrides: {
        id?: string;
        targetActivityId?: string;
        targetMemberId?: string;
        statusCode?: string;
      } = {},
    ): string {
      const {
        id = uniq('permanent-registration'),
        targetActivityId = activityId,
        targetMemberId = memberId,
        statusCode = 'pending',
      } = overrides;
      return (
        'INSERT INTO "ActivityRegistration" ' +
        '("id", "updatedAt", "activityId", "memberId", "statusCode") VALUES (' +
        [
          sqlText(id),
          'now()',
          sqlText(targetActivityId),
          sqlText(targetMemberId),
          sqlText(statusCode),
        ].join(', ') +
        ')'
      );
    }

    it('普通 unique 存在且无 WHERE；旧 active partial index 已不存在', async () => {
      const indexes = await prisma.$queryRawUnsafe<
        Array<{
          indexName: string;
          isUnique: boolean;
          hasNoPredicate: boolean;
          indexDef: string;
        }>
      >(
        'SELECT c.relname AS "indexName", ' +
          'i.indisunique AS "isUnique", ' +
          'i.indpred IS NULL AS "hasNoPredicate", ' +
          'pg_get_indexdef(i.indexrelid) AS "indexDef" ' +
          'FROM pg_index i ' +
          'JOIN pg_class c ON c.oid = i.indexrelid ' +
          'JOIN pg_class t ON t.oid = i.indrelid ' +
          'JOIN pg_namespace n ON n.oid = t.relnamespace ' +
          'WHERE n.nspname = current_schema() ' +
          "AND t.relname = 'ActivityRegistration' " +
          'AND c.relname IN (' +
          "'activity_registrations_activity_member_active_unique', " +
          "'activity_registrations_activity_member_permanent_unique') " +
          'ORDER BY c.relname',
      );

      expect(indexes).toHaveLength(1);
      expect(indexes[0]).toMatchObject({
        indexName: 'activity_registrations_activity_member_permanent_unique',
        isUnique: true,
        hasNoPredicate: true,
      });
      expect(indexes[0].indexDef.toUpperCase()).not.toContain('WHERE');
    });

    it('换 activity、换 member 都合法', async () => {
      const otherMember = await prisma.member.create({
        data: {
          memberNo: uniq('permanent-other-member'),
          ...memberIdentityData('Permanent Other Member'),
        },
        select: { id: true },
      });

      await expectAccepted(insertRegistration({ targetActivityId: otherActivityId }));
      await expectAccepted(insertRegistration({ targetMemberId: otherMember.id }));
    });

    it('active 重复精确 23505', async () => {
      await expectRejected(insertRegistration(), {
        sqlState: '23505',
        key: 'Key ("activityId", "memberId")',
      });
    });

    it('cancelled 后重复精确 23505', async () => {
      await expectAccepted(
        'UPDATE "ActivityRegistration" ' +
          'SET "statusCode" = \'cancelled\', "cancelledAt" = now() ' +
          'WHERE "id" = ' +
          sqlText(registrationId),
      );
      await expectRejected(insertRegistration(), {
        sqlState: '23505',
        key: 'Key ("activityId", "memberId")',
      });
    });

    it('soft-deleted 后重复精确 23505', async () => {
      await expectAccepted(
        'UPDATE "ActivityRegistration" ' +
          'SET "deletedAt" = now() ' +
          'WHERE "id" = ' +
          sqlText(registrationId),
      );
      await expectRejected(insertRegistration(), {
        sqlState: '23505',
        key: 'Key ("activityId", "memberId")',
      });
    });
  });
});
