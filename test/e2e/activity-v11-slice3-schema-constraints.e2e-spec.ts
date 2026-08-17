import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 活动改造 v1.1 —— 第 1 批第三刀(2026-08-04;第 73 migration
// `20260804060000_activity_v11_slice3_punch_evidence`)。
// 合同:docs/archive/reviews/activity-business-overhaul-v1.1/
//       SRVF_活动业务全流程改造_详细开发文档_v1.1.md §3.15 / §3.16 / §3.17 / §3.18
//
// 本 spec 的**唯一**职责:证明 migration 里的每条 CHECK / unique / partial unique /
// trigger 在真实 PostgreSQL 上**真的会拒**非法数据 —— 而不是"schema 文本里写了"。
// 沿前两刀同一范式。
//
// 🔴 每条都**双向**断言(违规被拒 + 合法放行)。只断言"被拒"证明不了约束是对的:
// 一条 `CHECK (false)` 也能让所有违规用例全绿,却把合法写入一起拒掉。更阴的是列名写错 ——
// 合法行被外键/非空挡下时,每条"被拒"都成立却**毫无意义**。反向样例是唯一的分辨手段。
//
// 🔴 本刀的头号判据是 **append-only trigger 的四条**(见 describe 'append-only'):
// INSERT 放行 / UPDATE 被拒 / DELETE 被拒 / **TRUNCATE 仍放行**。第四条挡不住就是
// 整个 e2e 地基塌方 —— `test/setup/reset-db.ts` 靠 TRUNCATE 清库。
//
// 走 $executeRawUnsafe 而非 Prisma model API:CHECK 与 partial unique 的 WHERE、
// NULLS NOT DISTINCT、trigger 都是 **DB 层**约束,Prisma client 不认识它们。
// Prisma 把原生语句的数据库错误包成 P2010,SQLSTATE 落在 `meta.code`
// (23505=unique / 23514=check / 23503=foreign key / 55000=trigger RAISE)。

const T = (iso: string) => `'${iso}'::timestamp`;

// 全部 2099 —— 避免"硬编码历史日期 + 耦合墙钟"的定时炸弹(仓内已有事故案例)。
const SESSION_START = '2099-06-01T09:00:00.000Z';
const SESSION_END = '2099-06-01T17:00:00.000Z';
const CHECKIN_OPEN = '2099-06-01T08:00:00.000Z';
const CHECKIN_CLOSE = '2099-06-01T10:00:00.000Z';
const CHECKOUT_OPEN = '2099-06-01T16:00:00.000Z';
const CHECKOUT_CLOSE = '2099-06-01T18:00:00.000Z';
const OFFLINE_UPLOAD_UNTIL = '2099-06-01T19:00:00.000Z';
const VALID_FROM = '2099-06-01T08:00:00.000Z';
const VALID_UNTIL = '2099-06-01T18:00:00.000Z';
const OCCURRED_AT = '2099-06-01T09:30:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

describe('活动改造 v1.1 第 1 批第三刀 schema 约束(第 73 migration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let organizationId: string;
  let activityId: string;
  let memberId: string;
  let userId: string;
  let registrationId: string;
  let sessionId: string;
  let sessionId2: string;
  let identityId: string;
  let offlinePackageId: string;

  let seq = 0;
  const uniq = (label: string) => `v11s3-${label}-${(seq += 1)}`;

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

  // ⚠️ 三类错误能拿到的证据不一样(Prisma 6.19 实测,沿前两刀结论):
  // - CHECK(23514)/ FK(23503)/ NOT NULL(23502):meta.message 是 PG 主消息,
  //   含 `constraint "xxx"` ⇒ 可断言到**具体约束名**。
  // - UNIQUE(23505):meta.message 只有 PG 的 DETAIL 行,形如
  //   `Key ("sessionId", "actionCode")=(s1, check_in) already exists.`,**不含约束名**
  //   ⇒ 改断言**键列签名**(本 schema 里覆盖该组键列的唯一索引只有一条,无歧义;
  //   partial 谓词由配套的"放行"用例反向锁死)。
  // - trigger RAISE(55000):主消息是 RAISE 的自定义文本,约束名走 PG 的独立错误字段
  //   而**不进消息文本** ⇒ 断言 sqlState + 消息文本。
  async function expectRejected(
    sql: string,
    expected: { sqlState: string; constraint?: string; key?: string; messageContains?: string },
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
    if (expected.messageContains !== undefined) {
      expect(err!.message).toContain(expected.messageContains);
    }
    return err!;
  }

  async function expectAccepted(sql: string): Promise<void> {
    const err = await run(sql);
    expect(err).toBeNull();
  }

  // ---- SQL 片段构造器:所有列名逐字取自实际建表语句(先 information_schema 核对过,不猜)----

  function qrSql(
    id: string,
    over: Partial<{
      actionCode: string;
      credentialVersion: number;
      statusCode: string;
      signingKeyVersion: number;
      validFrom: string;
      validUntil: string;
      revokedAt: string | null;
    }> = {},
  ): string {
    const o = {
      actionCode: 'check_in',
      credentialVersion: 1,
      statusCode: 'active',
      signingKeyVersion: 0,
      validFrom: VALID_FROM,
      validUntil: VALID_UNTIL,
      revokedAt: null as string | null,
      ...over,
    };
    return `INSERT INTO "AttendanceQrCredential"
      ("id","updatedAt","activityId","sessionId","actionCode","credentialVersion","statusCode",
       "tokenDigest","signingKeyVersion","validFrom","validUntil","issuedAt","revokedAt")
      VALUES ('${id}', ${T(SESSION_START)}, '${activityId}', '${sessionId}', '${o.actionCode}',
       ${o.credentialVersion}, '${o.statusCode}', 'digest-only-no-token', ${o.signingKeyVersion},
       ${T(o.validFrom)}, ${T(o.validUntil)}, ${T(SESSION_START)},
       ${o.revokedAt === null ? 'NULL' : T(o.revokedAt)})`;
  }

  function punchSql(
    id: string,
    over: Partial<{
      eventTypeCode: string;
      sourceCode: string;
      reason: string | null;
      supersedesEventId: string | null;
      longitude: number | null;
      latitude: number | null;
      accuracy: number | null;
      evidenceRevision: number;
      eventKey: string;
      sessionId: string;
      offlinePackageId: string | null;
      offlineSequence: number | null;
      offlinePriorHash: string | null;
      offlineEventPayloadHash: string | null;
    }> = {},
  ): string {
    const o = {
      eventTypeCode: 'check_in',
      sourceCode: 'self_qr',
      reason: null as string | null,
      supersedesEventId: null as string | null,
      longitude: null as number | null,
      latitude: null as number | null,
      accuracy: null as number | null,
      evidenceRevision: 0,
      eventKey: `key-${id}`,
      sessionId,
      ...over,
    };
    const valueOr = <T>(value: T | undefined, fallback: T): T =>
      value === undefined ? fallback : value;
    const offlinePackage = valueOr(
      over.offlinePackageId,
      o.sourceCode === 'offline' ? offlinePackageId : null,
    );
    const offlineSequence = valueOr(over.offlineSequence, o.sourceCode === 'offline' ? 1 : null);
    const offlinePriorHash = valueOr(
      over.offlinePriorHash,
      o.sourceCode === 'offline' ? HASH_A : null,
    );
    const offlineEventPayloadHash = valueOr(
      over.offlineEventPayloadHash,
      o.sourceCode === 'offline' ? HASH_B : null,
    );
    const s = (value: string | null) => (value === null ? 'NULL' : `'${value}'`);
    const n = (value: number | null) => (value === null ? 'NULL' : String(value));
    return `INSERT INTO "AttendancePunchEvent"
      ("id","activityId","sessionId","participationIdentityId","memberId","eventTypeCode",
       "sourceCode","occurredAt","receivedAt","operatorUserId","reason","supersedesEventId",
       "longitude","latitude","accuracy","eventKey","requestHash","evidenceRevision",
       "offlinePackageId","offlineSequence","offlinePriorHash","offlineEventPayloadHash")
      VALUES ('${id}', '${activityId}', '${o.sessionId}', '${identityId}', '${memberId}',
       '${o.eventTypeCode}', '${o.sourceCode}', ${T(OCCURRED_AT)}, ${T(OCCURRED_AT)}, '${userId}',
       ${o.reason === null ? 'NULL' : `'${o.reason}'`},
       ${o.supersedesEventId === null ? 'NULL' : `'${o.supersedesEventId}'`},
       ${o.longitude === null ? 'NULL' : o.longitude},
       ${o.latitude === null ? 'NULL' : o.latitude},
       ${o.accuracy === null ? 'NULL' : o.accuracy},
       '${o.eventKey}', 'req-hash', ${o.evidenceRevision},
       ${s(offlinePackage)}, ${n(offlineSequence)}, ${s(offlinePriorHash)}, ${s(offlineEventPayloadHash)})`;
  }

  function sealSql(
    id: string,
    over: Partial<{ sealRevision: number; statusCode: string; openSegmentCount: number }> = {},
  ): string {
    const o = { sealRevision: 0, statusCode: 'active', openSegmentCount: 0, ...over };
    return `INSERT INTO "EvidenceSeal"
      ("id","updatedAt","activityId","sealRevision","evidenceRevision","populationRevision",
       "workflowRevision","allWindowsClosedAt","openSegmentCount","manualReviewPendingCount",
       "populationCountDistinct","populationCountBySession","contentHash","statusCode","sealedAt")
      VALUES ('${id}', ${T(SESSION_START)}, '${activityId}', ${o.sealRevision}, 0, 0, 0,
       ${T(CHECKOUT_CLOSE)}, ${o.openSegmentCount}, 0, 0, '{}'::jsonb, 'hash', '${o.statusCode}',
       ${T(CHECKOUT_CLOSE)})`;
  }

  function segmentSql(
    id: string,
    checkInEventId: string,
    over: Partial<{
      segmentKey: string;
      revision: number;
      resultCode: string;
      statusCode: string;
      checkOutAt: string | null;
      serviceHours: number | null;
    }> = {},
  ): string {
    const o = {
      segmentKey: 'seg-1',
      revision: 0,
      resultCode: 'valid',
      statusCode: 'draft',
      checkOutAt: null as string | null,
      serviceHours: null as number | null,
      ...over,
    };
    return `INSERT INTO "ParticipantServiceSegmentRevision"
      ("id","updatedAt","participationIdentityId","segmentKey","revision","sourceCheckInEventId",
       "resultCode","statusCode","checkInAt","checkOutAt","serviceHours")
      VALUES ('${id}', ${T(SESSION_START)}, '${identityId}', '${o.segmentKey}', ${o.revision},
       '${checkInEventId}', '${o.resultCode}', '${o.statusCode}', ${T(SESSION_START)},
       ${o.checkOutAt === null ? 'NULL' : T(o.checkOutAt)},
       ${o.serviceHours === null ? 'NULL' : o.serviceHours})`;
  }

  beforeEach(async () => {
    await resetDb(app);

    organizationId = (
      await prisma.organization.create({
        data: { name: uniq('org'), nodeTypeCode: 'team' },
        select: { id: true },
      })
    ).id;

    activityId = (
      await prisma.activity.create({
        data: {
          title: uniq('activity'),
          activityTypeCode: 'v11-slice3',
          organizationId,
          startAt: new Date(SESSION_START),
          endAt: new Date(SESSION_END),
          location: 'constraint fixture',
          statusCode: 'draft',
        },
        select: { id: true },
      })
    ).id;

    memberId = (
      await prisma.member.create({
        data: { memberNo: uniq('member'), displayName: 'V11 Slice3 Member' },
        select: { id: true },
      })
    ).id;

    userId = (
      await prisma.user.create({
        data: { username: uniq('user').toLowerCase(), passwordHash: 'x' },
        select: { id: true },
      })
    ).id;

    const publishReviewId = (
      await prisma.activityPublishReview.create({
        data: {
          activityId,
          requestType: 'initial',
          requestVersion: 1,
          baseRevision: 0,
          status: 'approved',
          snapshot: {},
          directPublish: true,
          submittedByUserId: userId,
          reviewedByUserId: userId,
          reviewedAt: new Date(SESSION_START),
        },
        select: { id: true },
      })
    ).id;
    const ruleSnapshotId = (
      await prisma.activityRuleSnapshot.create({
        data: {
          activityId,
          workflowRevision: 0,
          resolvedConfig: {},
          snapshotHash: HASH_A,
          createdByReviewId: publishReviewId,
        },
        select: { id: true },
      })
    ).id;

    registrationId = (
      await prisma.activityRegistration.create({
        data: { activityId, memberId, statusCode: 'pending' },
        select: { id: true },
      })
    ).id;

    sessionId = (
      await prisma.activitySession.create({
        data: {
          activityId,
          code: uniq('session'),
          name: uniq('session'),
          startAt: new Date(SESSION_START),
          endAt: new Date(SESSION_END),
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

    sessionId2 = (
      await prisma.activitySession.create({
        data: {
          activityId,
          code: uniq('session-other'),
          name: uniq('session-other'),
          startAt: new Date(SESSION_START),
          endAt: new Date(SESSION_END),
          locationText: 'constraint fixture other session',
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

    identityId = (
      await prisma.activityParticipationIdentity.create({
        data: { activityId, sessionId, registrationId, memberId, currentStatusCode: 'pass' },
        select: { id: true },
      })
    ).id;

    offlinePackageId = (
      await prisma.offlinePackage.create({
        data: {
          activityId,
          sessionId,
          operatorUserId: userId,
          operatorMemberId: memberId,
          deviceId: uniq('offline-device'),
          packageVersion: 1,
          packageKeyVersion: 0,
          statusCode: 'active',
          tokenDigest: HASH_A,
          ruleSnapshotId,
          ruleSnapshotHash: HASH_A,
          workflowRevision: 0,
          participantSnapshotHash: HASH_B,
          validFrom: new Date(VALID_FROM),
          validUntil: new Date(VALID_UNTIL),
          uploadUntil: new Date(OFFLINE_UPLOAD_UNTIL),
          sequenceStart: 1,
          nextExpectedSequence: 1,
          chainAnchorHash: HASH_C,
          lastAcceptedHash: HASH_C,
          issuedAt: new Date(VALID_FROM),
          issueOperationKey: uniq('offline-issue'),
          issueRequestHash: HASH_A,
        },
        select: { id: true },
      })
    ).id;
  });

  // ==========================================================================
  // ⭐ DoD 2:append-only trigger 的四条判据(本刀最高风险项)
  // ==========================================================================
  describe('AttendancePunchEvent append-only trigger(§3.16)', () => {
    it('INSERT 放行、UPDATE 与 DELETE 被 55000 拒 —— 三条一起断言,缺正对照就等于没验', async () => {
      // 正对照:trigger 只挡改写,不能顺手把写入也挡了。
      // 一个恒拒的 trigger 也能让下面两条"被拒"全绿 —— 这条是唯一的分辨手段。
      await expectAccepted(punchSql('p-append-1'));

      await expectRejected(
        `UPDATE "AttendancePunchEvent" SET "reason" = 'tamper' WHERE "id" = 'p-append-1'`,
        {
          sqlState: '55000',
          messageContains: 'attendance punch event is append-only',
        },
      );

      await expectRejected(`DELETE FROM "AttendancePunchEvent" WHERE "id" = 'p-append-1'`, {
        sqlState: '55000',
        messageContains: 'attendance punch event is append-only',
      });

      // 行仍在:两条拒绝不是"改完又回滚",是根本没落地。
      const rows = await prisma.$queryRawUnsafe<Array<{ reason: string | null }>>(
        `SELECT "reason" FROM "AttendancePunchEvent" WHERE "id" = 'p-append-1'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].reason).toBeNull();
    });

    it('⭐ TRUNCATE 仍然放行 —— 行级 trigger 不响应 TRUNCATE,resetDb 不能被它挡死', async () => {
      await expectAccepted(punchSql('p-trunc-1'));
      await expectAccepted(punchSql('p-trunc-2', { eventKey: 'key-p-trunc-2' }));

      const before = await prisma.attendancePunchEvent.count();
      expect(before).toBe(2);

      // 这正是 test/setup/reset-db.ts 走的那条路径。挡住 = 整个 e2e 套件重置不了。
      // 本表不在 TRUNCATE 列表里,靠 CASCADE 被带走(它引用 "Activity",而 "Activity" 在列表内)。
      await resetDb(app);

      expect(await prisma.attendancePunchEvent.count()).toBe(0);

      // trigger 必须**还在** —— TRUNCATE 清的是行,不是 DDL。
      // 少了这条,一个"被 TRUNCATE 顺手卸掉"的 trigger 也能让上面全绿。
      const triggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = '"AttendancePunchEvent"'::regclass AND NOT tgisinternal
        ORDER BY tgname
      `;
      expect(triggers.map((t) => t.tgname)).toEqual(['trg_attendance_punch_event_10_append_only']);
    });
  });

  // ==========================================================================
  // §3.16 void/replace 形状 —— DoD 6 点名的高危对象,两侧各一条拒绝 + 各一条正对照
  // ==========================================================================
  describe('AttendancePunchEvent void/replace 形状(§3.16)', () => {
    it('void / replace 必须带 supersedesEventId,缺了被拒;带全了放行', async () => {
      await expectAccepted(punchSql('p-base', { eventKey: 'key-p-base' }));

      await expectRejected(punchSql('p-void-bad', { eventTypeCode: 'void', reason: 'r' }), {
        sqlState: '23514',
        constraint: 'attendance_punch_event_supersede_shape_check',
      });
      await expectRejected(punchSql('p-repl-bad', { eventTypeCode: 'replace', reason: 'r' }), {
        sqlState: '23514',
        constraint: 'attendance_punch_event_supersede_shape_check',
      });

      // 正对照:形状齐了必须能进,否则上面两条"被拒"毫无意义。
      await expectAccepted(
        punchSql('p-void-ok', {
          eventTypeCode: 'void',
          reason: 'mistaken scan',
          supersedesEventId: 'p-base',
          eventKey: 'key-p-void-ok',
        }),
      );
    });

    it('普通签到签退不得带 supersedes,带了被拒;不带放行', async () => {
      await expectAccepted(punchSql('p-plain-base', { eventKey: 'key-p-plain-base' }));

      await expectRejected(
        punchSql('p-ci-bad', { eventTypeCode: 'check_in', supersedesEventId: 'p-plain-base' }),
        { sqlState: '23514', constraint: 'attendance_punch_event_plain_no_supersede_check' },
      );
      await expectRejected(
        punchSql('p-co-bad', { eventTypeCode: 'check_out', supersedesEventId: 'p-plain-base' }),
        { sqlState: '23514', constraint: 'attendance_punch_event_plain_no_supersede_check' },
      );

      await expectAccepted(
        punchSql('p-co-ok', { eventTypeCode: 'check_out', eventKey: 'key-p-co-ok' }),
      );
    });

    it('特殊闭合 / 作废 / 替代必须带 reason —— 无歧义的三类才落 CHECK', async () => {
      await expectAccepted(punchSql('p-reason-base', { eventKey: 'key-p-reason-base' }));

      await expectRejected(punchSql('p-edc-bad', { eventTypeCode: 'early_departure_close' }), {
        sqlState: '23514',
        constraint: 'attendance_punch_event_reason_required_check',
      });
      await expectRejected(
        punchSql('p-void-noreason', {
          eventTypeCode: 'void',
          supersedesEventId: 'p-reason-base',
        }),
        { sqlState: '23514', constraint: 'attendance_punch_event_reason_required_check' },
      );

      await expectAccepted(
        punchSql('p-edc-ok', {
          eventTypeCode: 'early_departure_close',
          reason: 'left early',
          eventKey: 'key-p-edc-ok',
        }),
      );
    });

    it('一条原事件至多被一个 void/replace 处理(partial unique)', async () => {
      await expectAccepted(punchSql('p-target', { eventKey: 'key-p-target' }));
      await expectAccepted(punchSql('p-other', { eventKey: 'key-p-other' }));
      await expectAccepted(
        punchSql('p-v1', {
          eventTypeCode: 'void',
          reason: 'r',
          supersedesEventId: 'p-target',
          eventKey: 'key-p-v1',
        }),
      );

      // 第二个 void 指向同一原事件 → 被拒
      await expectRejected(
        punchSql('p-v2', {
          eventTypeCode: 'void',
          reason: 'r',
          supersedesEventId: 'p-target',
          eventKey: 'key-p-v2',
        }),
        { sqlState: '23505', key: '"supersedesEventId"' },
      );
      // replace 也占同一个槽(谓词覆盖 void 与 replace 两种)
      await expectRejected(
        punchSql('p-v3', {
          eventTypeCode: 'replace',
          reason: 'r',
          supersedesEventId: 'p-target',
          eventKey: 'key-p-v3',
        }),
        { sqlState: '23505', key: '"supersedesEventId"' },
      );

      // 正对照:指向**另一条**原事件必须放行,否则上面只是"第二条 void 一律拒"。
      await expectAccepted(
        punchSql('p-v4', {
          eventTypeCode: 'replace',
          reason: 'r',
          supersedesEventId: 'p-other',
          eventKey: 'key-p-v4',
        }),
      );
    });
  });

  // ==========================================================================
  // §3.16 位置字段成对:三态(全空 / 全有 / 半有)各一条
  // ==========================================================================
  describe('AttendancePunchEvent 坐标成对(§3.16)', () => {
    it('全空放行、全有放行、半有被拒', async () => {
      // 「不要求定位时允许全部 null」
      await expectAccepted(punchSql('p-geo-none', { eventKey: 'key-p-geo-none' }));
      await expectAccepted(
        punchSql('p-geo-both', {
          longitude: 116.397123,
          latitude: 39.907483,
          accuracy: 12.5,
          eventKey: 'key-p-geo-both',
        }),
      );

      await expectRejected(punchSql('p-geo-lon', { longitude: 116.397123 }), {
        sqlState: '23514',
        constraint: 'attendance_punch_event_coordinate_pair_check',
      });
      await expectRejected(punchSql('p-geo-lat', { latitude: 39.907483 }), {
        sqlState: '23514',
        constraint: 'attendance_punch_event_coordinate_pair_check',
      });
    });

    it('accuracy 刻意不入成对判定 —— 有坐标无精度必须放行(比合同更严会误杀合法行)', async () => {
      await expectAccepted(
        punchSql('p-geo-noacc', {
          longitude: 116.0,
          latitude: 39.0,
          accuracy: null,
          eventKey: 'key-p-geo-noacc',
        }),
      );
    });
  });

  // ==========================================================================
  // §3.16 闭集 / 全局唯一 / 计数
  // ==========================================================================
  describe('AttendancePunchEvent 闭集与唯一(§3.16)', () => {
    it('eventTypeCode 与 sourceCode 闭集,合法取值逐个放行', async () => {
      await expectRejected(punchSql('p-bad-type', { eventTypeCode: 'bogus' }), {
        sqlState: '23514',
        constraint: 'attendance_punch_event_event_type_code_check',
      });
      await expectRejected(punchSql('p-bad-src', { sourceCode: 'bogus' }), {
        sqlState: '23514',
        constraint: 'attendance_punch_event_source_code_check',
      });

      // 正对照:合同点名的七个 source 一个都不能被误杀。
      const sources = ['self_qr', 'staff_scan', 'proxy', 'bulk', 'import', 'offline', 'correction'];
      for (const [i, src] of sources.entries()) {
        await expectAccepted(
          punchSql(`p-src-${i}`, { sourceCode: src, eventKey: `key-p-src-${i}` }),
        );
      }
    });

    it('eventKey 全局唯一', async () => {
      await expectAccepted(punchSql('p-k1', { eventKey: 'dup-key' }));
      await expectRejected(punchSql('p-k2', { eventKey: 'dup-key' }), {
        sqlState: '23505',
        key: '"eventKey"',
      });
      await expectAccepted(punchSql('p-k3', { eventKey: 'other-key' }));
    });

    it('evidenceRevision 非负', async () => {
      await expectRejected(punchSql('p-rev-bad', { evidenceRevision: -1 }), {
        sqlState: '23514',
        constraint: 'attendance_punch_event_evidence_revision_check',
      });
      await expectAccepted(punchSql('p-rev-ok', { evidenceRevision: 0, eventKey: 'key-p-rev-ok' }));
    });
  });

  // ==========================================================================
  // §3.15 AttendanceQrCredential
  // ==========================================================================
  describe('AttendanceQrCredential(§3.15)', () => {
    it('actionCode / statusCode 闭集,合法值放行', async () => {
      await expectRejected(qrSql('q-bad-action', { actionCode: 'bogus' }), {
        sqlState: '23514',
        constraint: 'attendance_qr_credential_action_code_check',
      });
      await expectRejected(qrSql('q-bad-status', { statusCode: 'bogus' }), {
        sqlState: '23514',
        constraint: 'attendance_qr_credential_status_code_check',
      });

      await expectAccepted(qrSql('q-ok-in', { actionCode: 'check_in' }));
      await expectAccepted(qrSql('q-ok-out', { actionCode: 'check_out' }));
      await expectAccepted(qrSql('q-ok-exp', { statusCode: 'expired', credentialVersion: 2 }));
      await expectAccepted(
        qrSql('q-ok-rev', { statusCode: 'revoked', credentialVersion: 3, revokedAt: VALID_UNTIL }),
      );
    });

    it('作废形状双向:revoked ⇔ revokedAt 非空', async () => {
      await expectRejected(qrSql('q-rev-nots', { statusCode: 'revoked' }), {
        sqlState: '23514',
        constraint: 'attendance_qr_credential_revoked_shape_check',
      });
      await expectRejected(qrSql('q-act-ts', { statusCode: 'active', revokedAt: VALID_UNTIL }), {
        sqlState: '23514',
        constraint: 'attendance_qr_credential_revoked_shape_check',
      });

      // expired 不带 revokedAt 必须放行 —— 双向形状只锁 revoked 这一态。
      await expectAccepted(qrSql('q-exp-ok', { statusCode: 'expired' }));
    });

    it('版本号与有效窗口', async () => {
      await expectRejected(qrSql('q-v0', { credentialVersion: 0 }), {
        sqlState: '23514',
        constraint: 'attendance_qr_credential_version_check',
      });
      await expectRejected(qrSql('q-kv', { signingKeyVersion: -1 }), {
        sqlState: '23514',
        constraint: 'attendance_qr_credential_version_check',
      });
      await expectRejected(qrSql('q-win', { validFrom: VALID_UNTIL, validUntil: VALID_UNTIL }), {
        sqlState: '23514',
        constraint: 'attendance_qr_credential_validity_window_check',
      });
      await expectAccepted(qrSql('q-win-ok'));
    });

    it('同 session/action 至多一个 active(partial unique),换 action 或换终态放行', async () => {
      await expectAccepted(qrSql('q-a1', { actionCode: 'check_in', credentialVersion: 1 }));

      await expectRejected(qrSql('q-a2', { actionCode: 'check_in', credentialVersion: 2 }), {
        sqlState: '23505',
        key: '"sessionId"',
      });

      // 谓词正确性的两条正对照:
      // ① 同 session 的另一个 action 有自己的槽位
      await expectAccepted(qrSql('q-a3', { actionCode: 'check_out', credentialVersion: 1 }));
      // ② 终态不占槽位 —— 否则一次作废就永久锁死重发
      await expectAccepted(
        qrSql('q-a4', { actionCode: 'check_in', credentialVersion: 3, statusCode: 'expired' }),
      );
    });

    it('(sessionId, actionCode, credentialVersion) 唯一', async () => {
      await expectAccepted(qrSql('q-u1', { credentialVersion: 5, statusCode: 'expired' }));
      await expectRejected(qrSql('q-u2', { credentialVersion: 5, statusCode: 'expired' }), {
        sqlState: '23505',
        key: '"credentialVersion"',
      });
      await expectAccepted(qrSql('q-u3', { credentialVersion: 6, statusCode: 'expired' }));
    });
  });

  // ==========================================================================
  // §3.17 ActivityEvidenceState / EvidenceSeal
  // ==========================================================================
  describe('ActivityEvidenceState 与 EvidenceSeal(§3.17)', () => {
    it('一活动一行 evidence state', async () => {
      await expectAccepted(
        `INSERT INTO "ActivityEvidenceState" ("id","updatedAt","activityId")
         VALUES ('es-1', ${T(SESSION_START)}, '${activityId}')`,
      );
      await expectRejected(
        `INSERT INTO "ActivityEvidenceState" ("id","updatedAt","activityId")
         VALUES ('es-2', ${T(SESSION_START)}, '${activityId}')`,
        { sqlState: '23505', key: '"activityId"' },
      );
      await expectRejected(
        `UPDATE "ActivityEvidenceState" SET "evidenceRevision" = -1 WHERE "id" = 'es-1'`,
        { sqlState: '23514', constraint: 'activity_evidence_state_revision_check' },
      );
    });

    it('seal statusCode 闭集、(activityId, sealRevision) 唯一、计数非负', async () => {
      await expectAccepted(sealSql('sl-1', { sealRevision: 0 }));

      await expectRejected(sealSql('sl-bad-status', { sealRevision: 9, statusCode: 'bogus' }), {
        sqlState: '23514',
        constraint: 'evidence_seal_status_code_check',
      });
      await expectRejected(sealSql('sl-dup', { sealRevision: 0, statusCode: 'superseded' }), {
        sqlState: '23505',
        key: '"sealRevision"',
      });
      await expectRejected(sealSql('sl-neg', { sealRevision: 9, openSegmentCount: -1 }), {
        sqlState: '23514',
        constraint: 'evidence_seal_counts_check',
      });

      await expectAccepted(sealSql('sl-2', { sealRevision: 1, statusCode: 'superseded' }));
    });

    it('刻意**不建**「一活动至多一个 active seal」—— 第二条 active 必须放行', async () => {
      // 合同 §3.17 没给这条 partial unique,§11.3「必需索引」只给 Closure 点了
      // 「partial unique active activity」,Seal 那行没有 ⇒ 沿"合同没给的不发明"。
      // 这条用例把"刻意不建"钉成可执行判据:哪天有人顺手补上,它会立刻变红,
      // 从而强制那次改动去翻合同,而不是静悄悄改变语义。
      await expectAccepted(sealSql('sl-act-1', { sealRevision: 0, statusCode: 'active' }));
      await expectAccepted(sealSql('sl-act-2', { sealRevision: 1, statusCode: 'active' }));
    });
  });

  // ==========================================================================
  // §3.18 ParticipantServiceSegmentRevision
  // ==========================================================================
  describe('ParticipantServiceSegmentRevision(§3.18)', () => {
    beforeEach(async () => {
      await expectAccepted(punchSql('seg-src', { eventKey: 'key-seg-src' }));
    });

    it('resultCode / statusCode 闭集,四态与三态逐个放行', async () => {
      await expectRejected(segmentSql('g-bad-result', 'seg-src', { resultCode: 'bogus' }), {
        sqlState: '23514',
        constraint: 'participant_service_segment_result_code_check',
      });
      await expectRejected(segmentSql('g-bad-status', 'seg-src', { statusCode: 'bogus' }), {
        sqlState: '23514',
        constraint: 'participant_service_segment_status_code_check',
      });

      const results = ['valid', 'early_departure_zero', 'voided', 'replaced'];
      for (const [i, rc] of results.entries()) {
        await expectAccepted(
          segmentSql(`g-r-${i}`, 'seg-src', {
            resultCode: rc,
            segmentKey: `seg-r-${i}`,
          }),
        );
      }
    });

    it('开放段(无签退事件 / 无签退时间 / 无时长)必须能写入 —— 合同字段表未标可空,本刀改可空并上报', async () => {
      // §4.5「无开放段＋check_in → open」:此刻闭合事件根本不存在。
      // NOT NULL 会让这个合同自己定义的形态**根本写不进来**,故三列改可空。
      await expectAccepted(
        segmentSql('g-open', 'seg-src', {
          statusCode: 'draft',
          checkOutAt: null,
          serviceHours: null,
        }),
      );
      const rows = await prisma.$queryRawUnsafe<
        Array<{ sourceCloseEventId: string | null; checkOutAt: Date | null }>
      >(
        `SELECT "sourceCloseEventId", "checkOutAt" FROM "ParticipantServiceSegmentRevision" WHERE "id" = 'g-open'`,
      );
      expect(rows[0].sourceCloseEventId).toBeNull();
      expect(rows[0].checkOutAt).toBeNull();
    });

    it('时长非负、签退不早于签到', async () => {
      await expectRejected(segmentSql('g-neg', 'seg-src', { serviceHours: -0.01 }), {
        sqlState: '23514',
        constraint: 'participant_service_segment_service_hours_check',
      });
      await expectRejected(segmentSql('g-order', 'seg-src', { checkOutAt: CHECKIN_OPEN }), {
        sqlState: '23514',
        constraint: 'participant_service_segment_checkout_order_check',
      });
      await expectAccepted(
        segmentSql('g-ok', 'seg-src', { checkOutAt: SESSION_END, serviceHours: 8 }),
      );
      // 0 小时是 early_departure_zero 的正常取值,不能被"非负"顺手拒掉。
      await expectAccepted(
        segmentSql('g-zero', 'seg-src', {
          segmentKey: 'seg-zero',
          resultCode: 'early_departure_zero',
          serviceHours: 0,
        }),
      );
    });

    it('每个 (identity, segmentKey) 至多一个非 superseded 当前修订;让位后后继可进', async () => {
      await expectAccepted(segmentSql('g-c1', 'seg-src', { revision: 0, statusCode: 'draft' }));

      await expectRejected(
        segmentSql('g-c2', 'seg-src', { revision: 1, statusCode: 'committed' }),
        { sqlState: '23505', key: '"segmentKey"' },
      );

      // 谓词正确性正对照 ①:另一个 segmentKey 有自己的槽位
      await expectAccepted(segmentSql('g-c3', 'seg-src', { revision: 0, segmentKey: 'seg-2' }));

      // 谓词正确性正对照 ②:让位后后继必须能进 —— 否则一旦写入就永远无法产生新修订
      await expectAccepted(
        `UPDATE "ParticipantServiceSegmentRevision" SET "statusCode" = 'superseded' WHERE "id" = 'g-c1'`,
      );
      await expectAccepted(segmentSql('g-c4', 'seg-src', { revision: 1, statusCode: 'committed' }));
    });

    it('(identity, segmentKey, revision) 唯一', async () => {
      await expectAccepted(
        segmentSql('g-u1', 'seg-src', { revision: 0, statusCode: 'superseded' }),
      );
      await expectRejected(
        segmentSql('g-u2', 'seg-src', { revision: 0, statusCode: 'superseded' }),
        // ⚠️ PG 的 DETAIL 行只给**需要引号**的标识符加引号:`revision` 全小写无需引号,
        // 故键签名是 `..., "segmentKey", revision)` —— 断言 `"revision"` 会永远不匹配。
        { sqlState: '23505', key: '"segmentKey", revision)' },
      );
      await expectAccepted(
        segmentSql('g-u3', 'seg-src', { revision: 1, statusCode: 'superseded' }),
      );
    });
  });

  // ==========================================================================
  // 第 6 批已兑现的离线锚点，以及本刀继续不做的两项
  // ==========================================================================
  describe('第 6 批离线锚点与保留的非目标项', () => {
    it('offline 链锚存在、复合 FK 锚定场次，并双向拒绝错误形状', async () => {
      const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'AttendancePunchEvent'
          AND column_name IN (
            'offlinePackageId', 'offlineSequence', 'offlinePriorHash', 'offlineEventPayloadHash'
          )
        ORDER BY ordinal_position
      `;
      expect(cols).toEqual([
        { column_name: 'offlinePackageId' },
        { column_name: 'offlineSequence' },
        { column_name: 'offlinePriorHash' },
        { column_name: 'offlineEventPayloadHash' },
      ]);

      const fks = await prisma.$queryRaw<
        Array<{ conname: string; target: string; definition: string }>
      >`
        SELECT conname, confrelid::regclass::text AS target, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
        WHERE conname = 'AttendancePunchEvent_offline_package_anchor_fkey'
      `;
      expect(fks).toHaveLength(1);
      expect(fks[0]).toMatchObject({
        conname: 'AttendancePunchEvent_offline_package_anchor_fkey',
        target: '"OfflinePackage"',
      });
      expect(fks[0]?.definition).toContain(
        'FOREIGN KEY ("offlinePackageId", "activityId", "sessionId")',
      );

      // 正对照:四个离线锚都齐且 package/activity/session 同源时必须放行。
      await expectAccepted(
        punchSql('p-offline-ok', {
          sourceCode: 'offline',
          eventKey: 'key-p-offline-ok',
          offlineSequence: 1,
        }),
      );
      await expectRejected(
        punchSql('p-offline-missing-anchor', {
          sourceCode: 'offline',
          eventKey: 'key-p-offline-missing-anchor',
          offlineSequence: null,
        }),
        { sqlState: '23514', constraint: 'attendance_punch_event_offline_shape_check' },
      );
      await expectRejected(
        punchSql('p-nonoffline-carries-anchor', {
          sourceCode: 'staff_scan',
          eventKey: 'key-p-nonoffline-carries-anchor',
          offlinePackageId,
          offlineSequence: 2,
          offlinePriorHash: HASH_A,
          offlineEventPayloadHash: HASH_B,
        }),
        { sqlState: '23514', constraint: 'attendance_punch_event_offline_shape_check' },
      );
      await expectRejected(
        punchSql('p-offline-session-drift', {
          sourceCode: 'offline',
          eventKey: 'key-p-offline-session-drift',
          sessionId: sessionId2,
          offlineSequence: 3,
        }),
        { sqlState: '23503', constraint: 'AttendancePunchEvent_offline_package_anchor_fkey' },
      );
    });

    // 到期的那两列改由「必须存在**且**带真外键」正向钉住 —— 只删旧断言会留下真空:
    // 哪天有人把列删了或退化成无外键的裸列,没有任何用例会红。
    it('第四刀兑现的两列必须存在且各自带真外键(欠账已还,不是删了判据)', async () => {
      const cols = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE column_name IN ('importJobItemId', 'effectiveBatchId')
        ORDER BY table_name
      `;
      expect(cols).toEqual([
        { table_name: 'AttendancePunchEvent', column_name: 'importJobItemId' },
        { table_name: 'ParticipantServiceSegmentRevision', column_name: 'effectiveBatchId' },
      ]);

      const fks = await prisma.$queryRaw<Array<{ source: string; target: string }>>`
        SELECT r.relname AS source, c.confrelid::regclass::text AS target
        FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        WHERE c.contype = 'f'
          AND r.relname IN ('AttendancePunchEvent', 'ParticipantServiceSegmentRevision')
          AND c.conkey = (
            SELECT ARRAY[a.attnum] FROM pg_attribute a
            WHERE a.attrelid = c.conrelid
              AND a.attname IN ('importJobItemId', 'effectiveBatchId'))
        ORDER BY r.relname
      `;
      expect(fks).toEqual([
        { source: 'AttendancePunchEvent', target: '"ActivityBatchJobItem"' },
        { source: 'ParticipantServiceSegmentRevision', target: '"LedgerPostingBatch"' },
      ]);
    });

    it('时间重叠不进 DB:本刀零 exclusion constraint、零 btree_gist', async () => {
      // §3.18 明写「时间重叠校验在**现有 member lock 内**完成」⇒ 那是 service 层
      // (第 5 批)的事。这里钉死:本刀五张表上一条排他约束都没有。
      const exclusions = await prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE contype = 'x'
          AND conrelid::regclass::text IN (
            '"AttendanceQrCredential"', '"AttendancePunchEvent"', '"ActivityEvidenceState"',
            '"EvidenceSeal"', '"ParticipantServiceSegmentRevision"'
          )
      `;
      expect(exclusions).toEqual([]);

      const ext = await prisma.$queryRaw<Array<{ extname: string }>>`
        SELECT extname FROM pg_extension WHERE extname = 'btree_gist'
      `;
      expect(ext).toEqual([]);
    });

    it('AttendancePunchEvent 无 updatedAt / deletedAt(§3.16 不可变模型)', async () => {
      const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'AttendancePunchEvent'
          AND column_name IN ('updatedAt', 'deletedAt')
      `;
      expect(cols).toEqual([]);
    });
  });
});
