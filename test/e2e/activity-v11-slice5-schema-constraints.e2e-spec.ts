import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

// 活动改造 v1.1 —— 第 1 批**第五刀**(第 75 migration)与第 4 批缺口⑤
// (第 80 migration `20260808133500_activity_v11_batch4_allocation_contract_guards`)。
// 合同:docs/archive/reviews/activity-business-overhaul-v1.1/
//       SRVF_活动业务全流程改造_详细开发文档_v1.1.md §3.11
//
// 本 spec 的**唯一**职责:证明 migration 里的每条 CHECK / unique 在真实 PostgreSQL 上
// **真的会拒**非法数据 —— 而不是"schema 文本里写了"。沿前四刀同一范式。
//
// 🔴 每条都**双向**断言(违规被拒 + 合法放行)。只断言"被拒"证明不了约束是对的:
// 一条 `CHECK (false)` 也能让所有违规用例全绿,却把合法写入一起拒掉。更阴的是列名写错 ——
// 合法行被外键/非空挡下时,每条"被拒"都成立却**毫无意义**。反向样例是唯一的分辨手段。
//
// 🔴 本刀有大量「**刻意不做**」(合同只给散文不给字段表 ⇒ ④ 不发明)。
//    每一条刻意不做都配了一条**会变红**的用例 —— 哪天有人顺手补上,它立刻变红,
//    于是"补"这件事必须是一次显式决定,而不是悄悄发生。
//
// 走 $executeRawUnsafe 而非 Prisma model API:CHECK 是 **DB 层**约束,client 不认识。
// Prisma 把原生语句的数据库错误包成 P2010,SQLSTATE 落在 `meta.code`
// (23505=unique / 23514=check / 23502=not null / 23503=foreign key)。
//
// ⚠️ 沿第四刀实测订正的口径:**23502(NOT NULL)的 meta.message 只有 DETAIL 行,
//    既无约束名也无列名** ⇒ 只能断言 sqlState,"是哪一列"改用 information_schema 结构断言。
//    23505(UNIQUE)只给 DETAIL 行 ⇒ 断言**键列签名**而非约束名。
//    23514(CHECK)/ 23503(FK)的主消息含 `constraint "xxx"` ⇒ 可断言到具体约束名。

const T = (iso: string) => `'${iso}'::timestamp`;

// 全部 2099 —— 避免"硬编码历史日期 + 耦合墙钟"的定时炸弹(仓内已有事故案例)。
const SESSION_START = '2099-06-01T09:00:00.000Z';
const SESSION_END = '2099-06-01T17:00:00.000Z';
const CHECKIN_OPEN = '2099-06-01T08:00:00.000Z';
const CHECKIN_CLOSE = '2099-06-01T10:00:00.000Z';
const CHECKOUT_OPEN = '2099-06-01T16:00:00.000Z';
const CHECKOUT_CLOSE = '2099-06-01T18:00:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

describe('活动改造 v1.1 第 1 批第五刀 / 第 4 批缺口⑤ schema 约束(第 75 / 80 migration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let organizationId: string;
  let activityId: string;
  let memberId: string;
  let userId: string;
  let sessionId: string;
  let sessionId2: string;
  let positionId: string;
  let positionId2: string;
  let registrationId: string;
  let registrationRevisionId: string;
  let registrationRevisionId2: string;
  let identityId: string;
  let identityId2: string;
  let ruleSetId: string;

  let seq = 0;
  const uniq = (label: string) => `v11s5-${label}-${(seq += 1)}`;

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

  // ---- SQL 片段构造器:列名逐字取自实际建表语句(先 information_schema 核对过,不猜)----

  const preferenceSql = (
    id: string,
    o: {
      registrationRevisionId?: string;
      sessionId?: string;
      positionId?: string;
      preferenceOrder?: number;
    } = {},
  ) => {
    const v = {
      registrationRevisionId,
      sessionId,
      positionId,
      preferenceOrder: 1,
      ...o,
    };
    return `INSERT INTO "ActivityPositionPreference"
      ("id","registrationRevisionId","sessionId","positionId","preferenceOrder")
      VALUES ('${id}', '${v.registrationRevisionId}', '${v.sessionId}', '${v.positionId}',
       ${v.preferenceOrder})`;
  };

  const batchSql = (
    id: string,
    o: {
      sessionId?: string;
      positionId?: string | null;
      modeCode?: string;
      candidateSnapshotHash?: string | null;
      randomCommitment?: string | null;
      randomSeedReveal?: string | null;
      algorithmVersionCode?: string;
      statusCode?: string;
      operationKey?: string;
      requestHash?: string | null;
      committedAt?: string | null;
      voidReason?: string | null;
      voidedAt?: string | null;
    } = {},
  ) => {
    const v = {
      sessionId,
      positionId: null as string | null,
      modeCode: 'lottery',
      candidateSnapshotHash: HASH_A as string | null,
      statusCode: 'preparing',
      algorithmVersionCode: 'allocation-v1',
      operationKey: `ob-${id}`,
      requestHash: null as string | null,
      committedAt: null as string | null,
      ...o,
    };
    const randomCommitment =
      o.randomCommitment !== undefined
        ? o.randomCommitment
        : v.modeCode === 'lottery'
          ? HASH_B
          : null;
    const randomSeedReveal =
      o.randomSeedReveal !== undefined
        ? o.randomSeedReveal
        : v.modeCode === 'lottery' && v.statusCode === 'committed'
          ? HASH_C
          : null;
    const voidReason =
      o.voidReason !== undefined
        ? o.voidReason
        : v.statusCode === 'voided'
          ? 'D86 legal voided batch fixture'
          : null;
    const voidedAt =
      o.voidedAt !== undefined ? o.voidedAt : v.statusCode === 'voided' ? SESSION_END : null;
    const s = (x: string | null) => (x === null ? 'NULL' : `'${x}'`);
    return `INSERT INTO "ActivityAllocationBatch"
      ("id","updatedAt","activityId","sessionId","positionId","modeCode","candidateSnapshotHash",
       "algorithmVersionCode","randomCommitment","randomSeedReveal","statusCode","operationKey",
       "requestHash","createdByUserId","committedAt","voidReason","voidedAt")
      VALUES ('${id}', ${T(SESSION_START)}, '${activityId}', '${v.sessionId}', ${s(v.positionId)},
       '${v.modeCode}', ${s(v.candidateSnapshotHash)}, '${v.algorithmVersionCode}',
       ${s(randomCommitment)}, ${s(randomSeedReveal)}, '${v.statusCode}', '${v.operationKey}',
       ${s(v.requestHash)}, '${userId}',
       ${v.committedAt === null ? 'NULL' : T(v.committedAt)}, ${s(voidReason)},
       ${voidedAt === null ? 'NULL' : T(voidedAt)})`;
  };

  const candidateSql = (
    id: string,
    o: {
      allocationBatchId?: string;
      activityId?: string;
      sessionId?: string;
      waitlistPositionId?: string | null;
      participationIdentityId?: string;
      registrationId?: string;
      registrationRevisionId?: string;
      acceptedAt?: string;
      qualificationSnapshotHash?: string;
      qualificationScore?: number | null;
      tieBreakKey?: string | null;
      lotteryOrder?: number | null;
      resultCode?: string | null;
      waitlistRank?: number | null;
      explanation?: string;
    } = {},
  ) => {
    const v = {
      allocationBatchId: 'batch-a',
      activityId,
      sessionId,
      waitlistPositionId: null as string | null,
      participationIdentityId: identityId,
      registrationId,
      registrationRevisionId,
      acceptedAt: SESSION_START,
      qualificationSnapshotHash: HASH_A,
      qualificationScore: null as number | null,
      tieBreakKey: `tb-${id}` as string | null,
      lotteryOrder: null as number | null,
      resultCode: null as string | null,
      waitlistRank: null as number | null,
      explanation: '{}',
      ...o,
    };
    const s = (x: string | null) => (x === null ? 'NULL' : `'${x}'`);
    const n = (x: number | null) => (x === null ? 'NULL' : String(x));
    return `INSERT INTO "ActivityAllocationCandidate"
      ("id","updatedAt","allocationBatchId","activityId","sessionId","waitlistPositionId",
       "participationIdentityId","qualificationScore",
       "registrationId","registrationRevisionId","acceptedAt","qualificationSnapshotHash",
       "tieBreakKey","lotteryOrder","resultCode","waitlistRank","explanation")
      VALUES ('${id}', ${T(SESSION_START)}, '${v.allocationBatchId}', '${v.activityId}',
       '${v.sessionId}', ${s(v.waitlistPositionId)}, '${v.participationIdentityId}',
       ${n(v.qualificationScore)}, '${v.registrationId}', '${v.registrationRevisionId}',
       ${T(v.acceptedAt)}, '${v.qualificationSnapshotHash}', ${s(v.tieBreakKey)},
       ${n(v.lotteryOrder)}, ${s(v.resultCode)}, ${n(v.waitlistRank)},
       '${v.explanation}'::jsonb)`;
  };

  const quotaGroupSql = (
    id: string,
    o: {
      scopeTypeCode?: string;
      scopeId?: string;
      qualificationRuleSetId?: string | null;
      capacity?: number | null;
      releaseAt?: string | null;
      fallbackMode?: string;
    } = {},
  ) => {
    const v = {
      scopeTypeCode: 'session_participation',
      scopeId: sessionId,
      qualificationRuleSetId: null as string | null,
      capacity: null as number | null,
      releaseAt: SESSION_START as string | null,
      fallbackMode: 'release_to_public_pool',
      ...o,
    };
    return `INSERT INTO "ActivityReservedQuotaGroup"
      ("id","updatedAt","activityId","scopeTypeCode","scopeId","qualificationRuleSetId",
       "capacity","releaseAt","fallbackMode")
      VALUES ('${id}', ${T(SESSION_START)}, '${activityId}', '${v.scopeTypeCode}', '${v.scopeId}',
       ${v.qualificationRuleSetId === null ? 'NULL' : `'${v.qualificationRuleSetId}'`},
       ${v.capacity === null ? 'NULL' : String(v.capacity)},
       ${v.releaseAt === null ? 'NULL' : T(v.releaseAt)}, '${v.fallbackMode}')`;
  };

  const revisionSql = (
    id: string,
    o: { revision?: number; statusCode?: string; allocationBatchId?: string | null } = {},
  ) => {
    const v = {
      revision: 0,
      statusCode: 'pending',
      allocationBatchId: null as string | null,
      ...o,
    };
    return `INSERT INTO "ActivityParticipationRevision"
      ("id","identityId","revision","statusCode","effectiveAt","sourceCode","allocationBatchId")
      VALUES ('${id}', '${identityId}', ${v.revision}, '${v.statusCode}', ${T(SESSION_START)},
       'self', ${v.allocationBatchId === null ? 'NULL' : `'${v.allocationBatchId}'`})`;
  };

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
          activityTypeCode: 'v11-slice5',
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
        data: { memberNo: uniq('member'), displayName: 'V11 Slice5 Member' },
        select: { id: true },
      })
    ).id;

    userId = (
      await prisma.user.create({
        data: { username: uniq('user').toLowerCase(), passwordHash: 'x' },
        select: { id: true },
      })
    ).id;

    const makeSession = async (label: string) =>
      (
        await prisma.activitySession.create({
          data: {
            activityId,
            code: uniq(label),
            name: uniq(label),
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

    sessionId = await makeSession('session');
    sessionId2 = await makeSession('session2');

    const makePosition = async (sid: string) =>
      (
        await prisma.activitySessionPosition.create({
          data: {
            activityId,
            sessionId: sid,
            code: uniq('pos'),
            name: uniq('pos'),
            attendanceRoleCode: 'member',
          },
          select: { id: true },
        })
      ).id;

    positionId = await makePosition(sessionId);
    positionId2 = await makePosition(sessionId);

    registrationId = (
      await prisma.activityRegistration.create({
        data: { activityId, memberId, statusCode: 'pending' },
        select: { id: true },
      })
    ).id;

    const makeRegRevision = async (revision: number) =>
      (
        await prisma.activityRegistrationRevision.create({
          data: {
            registrationId,
            revision,
            sourceCode: 'self',
            submittedAt: new Date(SESSION_START),
          },
          select: { id: true },
        })
      ).id;

    registrationRevisionId = await makeRegRevision(0);
    registrationRevisionId2 = await makeRegRevision(1);

    const makeIdentity = async (sid: string) =>
      (
        await prisma.activityParticipationIdentity.create({
          data: {
            activityId,
            sessionId: sid,
            registrationId,
            memberId,
            currentStatusCode: 'pending',
          },
          select: { id: true },
        })
      ).id;

    identityId = await makeIdentity(sessionId);
    identityId2 = await makeIdentity(sessionId2);

    ruleSetId = (
      await prisma.activityQualificationRuleSet.create({
        data: { activityId, version: 1, statusCode: 'active' },
        select: { id: true },
      })
    ).id;

    // 供候选人 / 修订用例复用的两个批次(一个 preparing、一个 committed)。
    await expectAccepted(batchSql('batch-a', { statusCode: 'preparing' }));
    await expectAccepted(
      batchSql('batch-b', { statusCode: 'committed', committedAt: SESSION_END }),
    );
  });

  // ==========================================================================
  // ① §3.11 ActivityPositionPreference:两条 unique 缺一不可
  // ==========================================================================
  describe('§3.11 ActivityPositionPreference 约束', () => {
    it('立正对照:同报名修订同场次的多个志愿(序位与岗位都不同)必须能进', async () => {
      await expectAccepted(preferenceSql('p-1', { preferenceOrder: 1, positionId }));
      await expectAccepted(preferenceSql('p-2', { preferenceOrder: 2, positionId: positionId2 }));
    });

    it('同 (报名修订, 场次) 下**序位**重复必须被拒(§3.11 第一条 unique)', async () => {
      await expectAccepted(preferenceSql('p-1', { preferenceOrder: 1, positionId }));
      await expectRejected(
        // 换了岗位、序位仍是 1 ⇒ 只可能撞第一条 unique
        preferenceSql('p-x', { preferenceOrder: 1, positionId: positionId2 }),
        {
          sqlState: '23505',
          // ⚠️ 23505 只给 DETAIL 行,不含约束名 ⇒ 断言**键列签名**。
          // PG 的 DETAIL 只给需要引号的标识符加引号,三列均为驼峰 ⇒ 全部带引号。
          key: 'Key ("registrationRevisionId", "sessionId", "preferenceOrder")',
        },
      );
    });

    it('同 (报名修订, 场次) 下**岗位**重复必须被拒(§3.11 第二条 unique)', async () => {
      await expectAccepted(preferenceSql('p-1', { preferenceOrder: 1, positionId }));
      await expectRejected(
        // 换了序位、岗位仍是同一个 ⇒ 只可能撞第二条 unique
        preferenceSql('p-x', { preferenceOrder: 9, positionId }),
        {
          sqlState: '23505',
          key: 'Key ("registrationRevisionId", "sessionId", "positionId")',
        },
      );
    });

    it('preferenceOrder 从 1 起:1 / 2 放行，0 / 负数被精确 CHECK 拒绝', async () => {
      await expectAccepted(preferenceSql('p-one', { preferenceOrder: 1, positionId }));
      await expectAccepted(preferenceSql('p-two', { preferenceOrder: 2, positionId: positionId2 }));
      await expectRejected(
        preferenceSql('p-zero', {
          registrationRevisionId: registrationRevisionId2,
          preferenceOrder: 0,
          positionId,
        }),
        {
          sqlState: '23514',
          constraint: 'activity_position_preference_order_one_based_check',
        },
      );
      await expectRejected(
        preferenceSql('p-negative', {
          registrationRevisionId: registrationRevisionId2,
          preferenceOrder: -1,
          positionId: positionId2,
        }),
        {
          sqlState: '23514',
          constraint: 'activity_position_preference_order_one_based_check',
        },
      );
    });

    it('🔴 两条 unique 各自独立存在 —— 缺任何一条都会让上面两例中的一例变绿', async () => {
      // 结构断言兜底:光靠上面两条行为用例,若两条索引被合并成一条,
      // 其中一例仍会红、另一例会绿 —— 这里直接钉住"库里确实有两条独立的唯一索引"。
      const indexes = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'ActivityPositionPreference' AND indexdef LIKE '%UNIQUE%'
        ORDER BY indexname
      `;
      // ⚠️ PG 把主键索引也渲染成 `CREATE UNIQUE INDEX` ⇒ pkey 必然在结果集里,
      //    列进期望值而不是从查询里过滤掉:整表期望比"过滤后恰好两条"更难被绕过。
      expect(indexes.map((i) => i.indexname)).toEqual([
        'ActivityPositionPreference_pkey',
        'activity_position_preference_order_key',
        'activity_position_preference_position_key',
      ]);
      // 🟢 键列全 NOT NULL ⇒ **不需要** NULLS NOT DISTINCT;确认没有人顺手加上
      // (加上会改变语义:本表键列不可空,该子句在这里纯属噪声)。
      expect(indexes.every((i) => !i.indexdef.includes('NULLS NOT DISTINCT'))).toBe(true);
    });

    it('换场次 / 换报名修订都会释放槽位(证明 unique 的键确实含那两列,不是更宽的约束)', async () => {
      await expectAccepted(preferenceSql('p-1', { preferenceOrder: 1, positionId }));
      // 同一报名修订、**换场次** ⇒ 序位 1 可以再来一遍
      const posInSession2 = (
        await prisma.activitySessionPosition.create({
          data: {
            activityId,
            sessionId: sessionId2,
            code: uniq('pos'),
            name: uniq('pos'),
            attendanceRoleCode: 'member',
          },
          select: { id: true },
        })
      ).id;
      await expectAccepted(
        preferenceSql('p-2', {
          sessionId: sessionId2,
          positionId: posInSession2,
          preferenceOrder: 1,
        }),
      );
      // **换报名修订** ⇒ 同场次同岗位同序位也可以再来一遍(改志愿 = 追加新报名修订)
      await expectAccepted(
        preferenceSql('p-3', {
          registrationRevisionId: registrationRevisionId2,
          positionId,
          preferenceOrder: 1,
        }),
      );
    });

    it('三条外键都是真外键(报名修订 / 场次 / 岗位)', async () => {
      await expectRejected(preferenceSql('p-x', { registrationRevisionId: 'no-such-rev' }), {
        sqlState: '23503',
        constraint: 'ActivityPositionPreference_registrationRevisionId_fkey',
      });
      await expectRejected(preferenceSql('p-y', { sessionId: 'no-such-session' }), {
        sqlState: '23503',
        constraint: 'ActivityPositionPreference_sessionId_fkey',
      });
      await expectRejected(preferenceSql('p-z', { positionId: 'no-such-position' }), {
        sqlState: '23503',
        constraint: 'ActivityPositionPreference_positionId_fkey',
      });
    });

    it('不可变模型:本表无 updatedAt / deletedAt(志愿改动 = 追加新报名修订)', async () => {
      const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'ActivityPositionPreference'
          AND column_name IN ('updatedAt', 'deletedAt')
      `;
      expect(cols).toEqual([]);
    });
  });

  // ==========================================================================
  // ② §3.11 ActivityAllocationBatch:两条闭集 + 提交形状 + 幂等键唯一
  // ==========================================================================
  describe('§3.11 ActivityAllocationBatch 约束', () => {
    it('立正对照:三种 modeCode × 三种 statusCode 的合法形态都必须能进', async () => {
      await expectAccepted(batchSql('m1', { modeCode: 'first_come' }));
      await expectAccepted(batchSql('m2', { modeCode: 'qualification_rank' }));
      await expectAccepted(batchSql('m3', { modeCode: 'lottery' }));
      // preparing:committedAt 必须允许为 NULL —— 这正是把它放宽成可空的**唯一**理由
      await expectAccepted(batchSql('s1', { statusCode: 'preparing', committedAt: null }));
      await expectAccepted(batchSql('s2', { statusCode: 'committed', committedAt: SESSION_END }));
      // D86 voided 还必须有合法 reason/time；两种历史形态仍为未提交即作废 / 提交后作废。
      await expectAccepted(batchSql('s3', { statusCode: 'voided', committedAt: null }));
      await expectAccepted(batchSql('s4', { statusCode: 'voided', committedAt: SESSION_END }));
      // positionId 可空:NULL = 场次级批次;有值 = 岗位级批次
      await expectAccepted(batchSql('p1', { positionId: null }));
      await expectAccepted(batchSql('p2', { positionId }));
    });

    it('modeCode 越出三值闭集必须被拒', async () => {
      await expectRejected(batchSql('x', { modeCode: 'random_pick' }), {
        sqlState: '23514',
        // D85 的 seed shape 同样闭合 mode；其名称排序早于旧 mode CHECK，
        // PostgreSQL 会先报告这一条。下方精确集合仍钉住旧 CHECK 没被删除。
        constraint: 'activity_allocation_batch_lottery_seed_shape_check',
      });
    });

    it('statusCode 越出三值闭集必须被拒', async () => {
      await expectRejected(batchSql('x', { modeCode: 'first_come', statusCode: 'done' }), {
        sqlState: '23514',
        constraint: 'activity_allocation_batch_status_code_check',
      });
    });

    // 🔴🔴 DoD 4 的 NULL 边界主判据:涉及**可空列** committedAt 的 CHECK,
    //     必须给出「该列为 NULL 时被**拒绝**」的证据。
    it('🔴 NULL 边界:statusCode=committed 却 committedAt 为 NULL 必须被拒', async () => {
      await expectRejected(
        batchSql('x', { modeCode: 'first_come', statusCode: 'committed', committedAt: null }),
        {
          sqlState: '23514',
          constraint: 'activity_allocation_batch_committed_shape_check',
        },
      );
    });

    it('🔴 该 CHECK 用的是**守卫前置**式,不是靠 statusCode 的 NOT NULL 兜底', async () => {
      // 本刀初版写的是朴素式 `statusCode <> 'committed' OR committedAt IS NOT NULL`,
      // scratch 库变异实测:DROP NOT NULL 之后 statusCode=NULL 的行**被静默放行并真的入库**
      // (`NULL <> 'committed'` = NULL,`NULL OR FALSE` = NULL ⇒ CHECK 判通过)。
      // 改成守卫前置的 AND 链后同一行被 23514 拒(AND 是 FALSE-主导,塌成 FALSE 不是 NULL)。
      // 这里把"用的是哪种写法"钉成结构判据 —— 哪天有人"简化"回朴素式,这条会红。
      const [row] = await prisma.$queryRaw<Array<{ def: string }>>`
        SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'activity_allocation_batch_committed_shape_check'
      `;
      expect(row).toBeDefined();
      // 守卫必须在 AND 链里(而不是只有一条裸 OR)
      expect(row.def).toContain('IS NOT NULL');
      expect(row.def).toMatch(/statusCode.*IS NOT NULL.*AND/s);
    });

    it('先提交后作废的行保留 committedAt(单向蕴含,不误杀这一合法形态)', async () => {
      await expectAccepted(batchSql('v1', { statusCode: 'voided', committedAt: SESSION_END }));
    });

    it('🔴 幂等键唯一是**单列** operationKey —— 同 key 不同 payload 仍须被拒', async () => {
      await expectAccepted(
        batchSql('k1', {
          operationKey: 'op-same',
          requestHash: 'rh-1',
          candidateSnapshotHash: HASH_A,
        }),
      );
      // 若唯一键是 (operationKey, requestHash) 复合,这一行会被**放行** ——
      // 而"同一个幂等 key 配不同 payload"正是幂等键最该拦的那类冲突。
      await expectRejected(
        batchSql('k2', {
          operationKey: 'op-same',
          requestHash: 'COMPLETELY-DIFFERENT',
          candidateSnapshotHash: HASH_B,
        }),
        { sqlState: '23505', key: 'Key ("operationKey")=(op-same)' },
      );
    });

    it('复合外键 (activityId, sessionId) 挡住"批次挂到别的活动的场次上"', async () => {
      await expectRejected(batchSql('x', { sessionId: 'no-such-session' }), {
        sqlState: '23503',
        constraint: 'ActivityAllocationBatch_activityId_sessionId_fkey',
      });
    });

    it('candidateSnapshotHash 保持 NOT NULL(合同字段表未标 ?,本刀不放宽)', async () => {
      const err = await run(batchSql('x', { candidateSnapshotHash: null }));
      expect(err).not.toBeNull();
      // 23502 的 meta.message 只有 DETAIL 行,既无约束名也无列名 ⇒ 只断言 sqlState,
      // "是哪一列"由下面的结构断言覆盖(沿第四刀实测订正的口径)。
      expect(err!.sqlState).toBe('23502');

      const cols = await prisma.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'ActivityAllocationBatch'
          AND column_name IN ('candidateSnapshotHash', 'randomCommitment', 'positionId', 'committedAt')
        ORDER BY column_name
      `;
      expect(cols).toEqual([
        // 合同同一条 bullet 里对 positionId / randomCommitment 显式标了 `?`,
        // 说明"未标 = 必填"是刻意的 ⇒ candidateSnapshotHash 保持 NOT NULL。
        { column_name: 'candidateSnapshotHash', is_nullable: 'NO' },
        // committedAt 是本刀**唯一**放宽的一列(preparing 态要求),并配了 shape CHECK 补回。
        { column_name: 'committedAt', is_nullable: 'YES' },
        { column_name: 'positionId', is_nullable: 'YES' },
        { column_name: 'randomCommitment', is_nullable: 'YES' },
      ]);
    });

    // 🔴 DoD 5:可空列进唯一索引的 NULLS NOT DISTINCT 问题在本表的答复。
    it('🔴 可空的 positionId **没有**进任何唯一索引 ⇒ 无处也不该加 NULLS NOT DISTINCT', async () => {
      const uniques = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'ActivityAllocationBatch' AND indexdef LIKE '%UNIQUE%'
        ORDER BY indexname
      `;
      // D86 为复合 FK 增加 id/activity 与 id/activity/session 被引用唯一键；
      // operationKey 仍是本表的单列幂等键。
      // (PG 把主键索引也渲染成 `CREATE UNIQUE INDEX` ⇒ pkey 必然在结果集里。)
      expect(uniques.map((u) => u.indexname)).toEqual([
        'ActivityAllocationBatch_pkey',
        'activity_allocation_batch_id_activity_session_unique',
        'activity_allocation_batch_id_activity_unique',
        'activity_allocation_batch_operation_key_key',
      ]);
      expect(uniques.every((u) => !u.indexdef.includes('positionId'))).toBe(true);
      // §3.11 与 §11.3 都没有为本表要求岗位维度的唯一 ⇒ 按④不发明。
      // 哪天有人补了含 positionId 的唯一索引,这条会红 —— 那时**必须**同时决定
      // 要不要 NULLS NOT DISTINCT(否则岗位级为 NULL 的行可无限重复,索引在最该
      // 生效的那类行上完全失效 —— 第二刀邀请那条的原型)。
    });
  });

  // ==========================================================================
  // ③ §3.11 ActivityAllocationCandidate:结果闭集与同批次 identity 唯一
  // ==========================================================================
  describe('§3.11 ActivityAllocationCandidate 约束与刻意不做', () => {
    it('立正对照:最小冻结行与满行都必须能进', async () => {
      await expectAccepted(candidateSql('c-min'));
      await expectAccepted(
        candidateSql('c-full', {
          allocationBatchId: 'batch-b',
          qualificationScore: 87.5,
          lotteryOrder: 7,
          resultCode: 'allocated',
          explanation: '{"rules":[{"code":"grade","score":40}]}',
        }),
      );
      // D85 冻结逐规则明细，解释必须是 JSON object，不能再用纯文本占位。
      await expectAccepted(
        candidateSql('c-object', {
          participationIdentityId: identityId2,
          explanation: '{"reason":"名额已满,进入候补"}',
        }),
      );
    });

    it('批次复合锚与参与身份外键都是真外键', async () => {
      await expectRejected(candidateSql('x', { allocationBatchId: 'no-such-batch' }), {
        sqlState: '23503',
        constraint: 'activity_allocation_candidate_batch_anchor_fkey',
      });
      await expectRejected(candidateSql('y', { participationIdentityId: 'no-such-identity' }), {
        sqlState: '23503',
        constraint: 'activity_allocation_candidate_identity_registration_fkey',
      });
    });

    it('tieBreakKey 是 NOT NULL(稳定排序的锚,缺了"稳定"二字就无从谈起)', async () => {
      const err = await run(candidateSql('x', { tieBreakKey: null }));
      expect(err).not.toBeNull();
      expect(err!.sqlState).toBe('23502');
    });

    // ---- 以下两条继续把不应落 DB 的 append-only 语义钉成会变红的判据 ----

    it('🔴 刻意不装 append-only trigger:preparing 期 UPDATE **必须放行**', async () => {
      // 这不是"忘了装",是装上就**错**:批次 preparing 期正要往候选行里写
      // 评分 / 抽签序号 / 结果 / 候补序号,无条件 append-only 会把合法写路径堵死。
      // 合同说的是「结果 **committed 后**不可改」= 条件不可变,不是 append-only;
      // 且它**没有**像 §3.23.8 那样点名"DB 角色层禁 UPDATE/DELETE"
      // (沿 §3.17 EvidenceSeal / §3.19 SettlementReviewAction 两条先例)。
      await expectAccepted(candidateSql('c-1'));
      await expectAccepted(
        `UPDATE "ActivityAllocationCandidate"
         SET "resultCode" = 'waitlisted', "waitlistRank" = 5,
             "waitlistPositionId" = '${positionId}', "updatedAt" = ${T(SESSION_END)}
         WHERE "id" = 'c-1'`,
      );
      const [row] = await prisma.$queryRaw<Array<{ resultCode: string; waitlistRank: number }>>`
        SELECT "resultCode", "waitlistRank" FROM "ActivityAllocationCandidate" WHERE id = 'c-1'
      `;
      expect(row.resultCode).toBe('waitlisted');
      expect(Number(row.waitlistRank)).toBe(5);
      // DELETE 同样放行(void 旧批次时要能清理)
      await expectAccepted(`DELETE FROM "ActivityAllocationCandidate" WHERE "id" = 'c-1'`);
    });

    it('🔴 本表零 trigger(哪天有人装了 append-only,这条立刻变红)', async () => {
      const triggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
        SELECT t.tgname FROM pg_trigger t
        WHERE t.tgrelid = '"ActivityAllocationCandidate"'::regclass
          AND NOT t.tgisinternal
      `;
      expect(triggers).toEqual([]);
      // 「committed 后不可改」的执行位归第 4 批 service(Activity 锁内重读批次状态)——
      // 行级 trigger 读父批次在并发下会骗人(互相看不见未提交的 status 变更),
      // 与第四刀「日合计求和 trigger 在并发下骗人」同型。
    });

    it('resultCode 保持 nullable，非空仅三值闭集', async () => {
      await expectRejected(candidateSql('c-invalid', { resultCode: '完全不在闭集里的取值' }), {
        sqlState: '23514',
        constraint: 'activity_allocation_candidate_result_code_check',
      });
      await expectAccepted(candidateSql('c-null', { resultCode: null }));
      await expectAccepted(
        candidateSql('c-allocated', {
          participationIdentityId: identityId2,
          resultCode: 'allocated',
        }),
      );
      await expectAccepted(
        candidateSql('c-waitlisted', {
          allocationBatchId: 'batch-b',
          resultCode: 'waitlisted',
          waitlistRank: 1,
          waitlistPositionId: positionId,
        }),
      );
      await expectAccepted(
        candidateSql('c-not-selected', {
          allocationBatchId: 'batch-b',
          participationIdentityId: identityId2,
          resultCode: 'not_selected',
        }),
      );
    });

    it('同批次同 identity 第二行拒绝；换 identity 或换批次放行', async () => {
      await expectAccepted(candidateSql('c-1'));
      await expectRejected(candidateSql('c-2'), {
        sqlState: '23505',
        key: 'Key ("allocationBatchId", "participationIdentityId")',
      });
      await expectAccepted(candidateSql('c-3', { participationIdentityId: identityId2 }));
      await expectAccepted(candidateSql('c-4', { allocationBatchId: 'batch-b' }));
      const uniques = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'ActivityAllocationCandidate' AND indexdef LIKE '%UNIQUE%'
        ORDER BY indexname
      `;
      expect(uniques.map((u) => u.indexname)).toEqual([
        'ActivityAllocationCandidate_pkey',
        'activity_allocation_candidate_batch_identity_key',
        'activity_allocation_candidate_batch_lottery_order_unique',
        'activity_allocation_candidate_batch_position_rank_unique',
        'activity_allocation_candidate_batch_tie_break_key',
        'activity_allocation_candidate_id_batch_identity_unique',
      ]);
      expect(uniques.every((u) => !u.indexdef.includes('NULLS NOT DISTINCT'))).toBe(true);
    });

    it('D87 点名的岗位候补 rank 查询索引确实存在', async () => {
      const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'ActivityAllocationCandidate'
          AND indexname = 'activity_allocation_candidate_batch_position_rank_idx'
      `;
      expect(indexes).toHaveLength(1);
    });
  });

  // ==========================================================================
  // ④ §3.11 ActivityReservedQuotaGroup:capacity 与拍板的 scope / fallback 闭集
  // ==========================================================================
  describe('§3.11 ActivityReservedQuotaGroup 约束与刻意不做', () => {
    it('立正对照:capacity 为 NULL(不限)必须**放行** —— NULL 边界的正对照', async () => {
      await expectAccepted(quotaGroupSql('rq-null', { capacity: null }));
      await expectAccepted(quotaGroupSql('rq-one', { capacity: 1 }));
      await expectAccepted(quotaGroupSql('rq-many', { capacity: 999 }));
      // 资格条件版本可空 / 有值两种形态
      await expectAccepted(quotaGroupSql('rq-rs', { qualificationRuleSetId: ruleSetId }));
    });

    it('capacity = 0 必须被拒', async () => {
      await expectRejected(quotaGroupSql('x', { capacity: 0 }), {
        sqlState: '23514',
        constraint: 'activity_reserved_quota_group_capacity_positive_check',
      });
    });

    it('capacity 为负数必须被拒', async () => {
      await expectRejected(quotaGroupSql('x', { capacity: -1 }), {
        sqlState: '23514',
        constraint: 'activity_reserved_quota_group_capacity_positive_check',
      });
    });

    it('releaseAt 保持 NOT NULL(散文未标可空,不自行放宽)', async () => {
      const err = await run(quotaGroupSql('x', { releaseAt: null }));
      expect(err).not.toBeNull();
      expect(err!.sqlState).toBe('23502');
    });

    it('qualificationRuleSetId 是真外键(指向 §3.13 规则集,那张表自带 version)', async () => {
      await expectRejected(quotaGroupSql('x', { qualificationRuleSetId: 'no-such-ruleset' }), {
        sqlState: '23503',
        constraint: 'ActivityReservedQuotaGroup_qualificationRuleSetId_fkey',
      });
    });

    it('scopeTypeCode 四值闭集，任意第五值被精确 CHECK 拒绝', async () => {
      for (const [id, scopeTypeCode] of [
        ['rq-activity-person', 'activity_person'],
        ['rq-session-participation', 'session_participation'],
        ['rq-position-participation', 'position_participation'],
        ['rq-reserve-group', 'reserve_group'],
      ]) {
        await expectAccepted(quotaGroupSql(id, { scopeTypeCode }));
      }
      await expectRejected(quotaGroupSql('rq-invalid-scope', { scopeTypeCode: 'other_scope' }), {
        sqlState: '23514',
        constraint: 'activity_reserved_quota_group_scope_type_code_check',
      });
    });

    it('fallbackMode 两值闭集，任意第三值被精确 CHECK 拒绝', async () => {
      await expectAccepted(quotaGroupSql('rq-release', { fallbackMode: 'release_to_public_pool' }));
      await expectAccepted(quotaGroupSql('rq-void', { fallbackMode: 'void_on_expiry' }));
      await expectRejected(
        quotaGroupSql('rq-invalid-fallback', { fallbackMode: 'keep_reserved' }),
        {
          sqlState: '23514',
          constraint: 'activity_reserved_quota_group_fallback_mode_check',
        },
      );
    });

    it('省略 fallbackMode 时，数据库默认真实落为 release_to_public_pool', async () => {
      await expectAccepted(`INSERT INTO "ActivityReservedQuotaGroup"
        ("id","updatedAt","activityId","scopeTypeCode","scopeId","qualificationRuleSetId",
         "capacity","releaseAt")
        VALUES ('rq-default', ${T(SESSION_START)}, '${activityId}', 'session_participation', '${sessionId}',
         NULL, NULL, ${T(SESSION_START)})`);
      const [row] = await prisma.$queryRaw<Array<{ fallbackMode: string }>>`
        SELECT "fallbackMode" FROM "ActivityReservedQuotaGroup" WHERE id = 'rq-default'
      `;
      expect(row).toEqual({ fallbackMode: 'release_to_public_pool' });
    });

    it('scopeId 刻意零外键(多态 id,沿 ActivityCapacityBucket.scopeId 既有范式)', async () => {
      // 填一个根本不存在的 scopeId 仍须入库 —— 把"没有外键"钉成可执行判据。
      await expectAccepted(quotaGroupSql('rq-poly', { scopeId: 'totally-nonexistent-scope' }));
    });
  });

  // ==========================================================================
  // ⑤ DoD 2:兑现第一刀欠下的 allocationBatchId
  // ==========================================================================
  describe('DoD 2:ActivityParticipationRevision.allocationBatchId 欠账已还', () => {
    it('该列存在、可空、且带**真外键**指向 ActivityAllocationBatch', async () => {
      const cols = await prisma.$queryRaw<
        Array<{ column_name: string; data_type: string; is_nullable: string }>
      >`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'ActivityParticipationRevision' AND column_name = 'allocationBatchId'
      `;
      expect(cols).toEqual([
        { column_name: 'allocationBatchId', data_type: 'text', is_nullable: 'YES' },
      ]);

      const fks = await prisma.$queryRaw<Array<{ conname: string; target: string }>>`
        SELECT c.conname, c.confrelid::regclass::text AS target
        FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid = '"ActivityParticipationRevision"'::regclass
          AND c.conkey = (
            SELECT ARRAY[a.attnum] FROM pg_attribute a
            WHERE a.attrelid = c.conrelid AND a.attname = 'allocationBatchId')
      `;
      expect(fks).toEqual([
        {
          conname: 'ActivityParticipationRevision_allocationBatchId_fkey',
          target: '"ActivityAllocationBatch"',
        },
      ]);
    });

    it('两种形态都合法:不经批次(NULL)与指向真批次', async () => {
      await expectAccepted(revisionSql('pr-1', { revision: 0, allocationBatchId: null }));
      await expectAccepted(
        revisionSql('pr-2', {
          revision: 1,
          statusCode: 'waitlisted',
          allocationBatchId: 'batch-b',
        }),
      );
    });

    it('指向不存在的批次必须被拒(证明是真外键不是裸列)', async () => {
      await expectRejected(revisionSql('x', { allocationBatchId: 'no-such-batch' }), {
        sqlState: '23503',
        constraint: 'ActivityParticipationRevision_allocationBatchId_fkey',
      });
    });

    it('§11.3 逐字点名的 (allocationBatchId, statusCode) 索引确实存在', async () => {
      const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'ActivityParticipationRevision'
          AND indexname = 'activity_participation_revision_batch_status_idx'
      `;
      expect(indexes).toHaveLength(1);
    });
  });

  // ==========================================================================
  // ⑥ 「本刀刻意不做」的其余口径 + DoD 8 地基判据
  // ==========================================================================
  describe('刻意不做与地基判据', () => {
    it('✅ 到期翻面:§3.4 两表已建,ruleSnapshotId 可空且带真 FK', async () => {
      // 原判据的到期条件已经成立:第 3 批①.5 建 ActivityTemplate /
      // ActivityRuleSnapshot 后,§3.11 的跨切片列必须**连列带 FK**补齐,不能删掉
      // 原用例来掩盖变化。
      const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('ActivityTemplate', 'ActivityRuleSnapshot')
        ORDER BY table_name
      `;
      expect(tables).toEqual([
        { table_name: 'ActivityRuleSnapshot' },
        { table_name: 'ActivityTemplate' },
      ]);

      // 「形状正确」的最小闭环:模板版本键 / snapshot 的活动与审核锚点都真的在表中。
      const snapshotCols = await prisma.$queryRaw<
        Array<{ column_name: string; data_type: string; is_nullable: string }>
      >`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'ActivityRuleSnapshot'
          AND column_name IN ('activityId', 'workflowRevision', 'templateVersionId',
                              'resolvedConfig', 'snapshotHash', 'createdByReviewId')
        ORDER BY column_name
      `;
      expect(snapshotCols).toEqual([
        { column_name: 'activityId', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'createdByReviewId', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'resolvedConfig', data_type: 'jsonb', is_nullable: 'NO' },
        { column_name: 'snapshotHash', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'templateVersionId', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'workflowRevision', data_type: 'integer', is_nullable: 'NO' },
      ]);

      const col = await prisma.$queryRaw<
        Array<{ data_type: string; is_nullable: string; column_default: string | null }>
      >`
        SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'ActivityAllocationBatch' AND column_name = 'ruleSnapshotId'
      `;
      expect(col).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);

      const fks = await prisma.$queryRaw<Array<{ conname: string; target: string }>>`
        SELECT c.conname, c.confrelid::regclass::text AS target
        FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid = '"ActivityAllocationBatch"'::regclass
          AND c.conkey = (
            SELECT ARRAY[a.attnum] FROM pg_attribute a
            WHERE a.attrelid = c.conrelid AND a.attname = 'ruleSnapshotId')
      `;
      expect(fks).toEqual([
        {
          conname: 'ActivityAllocationBatch_ruleSnapshotId_fkey',
          target: '"ActivityRuleSnapshot"',
        },
      ]);
    });

    it('🔴 DoD 8:四张新表**零出向外键的表 = 空集**(否则 resetDb 的 CASCADE 清不到)', async () => {
      const orphans = await prisma.$queryRaw<Array<{ t: string }>>`
        WITH new_tables(t) AS (VALUES
          ('ActivityPositionPreference'), ('ActivityAllocationBatch'),
          ('ActivityAllocationCandidate'), ('ActivityReservedQuotaGroup'))
        SELECT t FROM new_tables
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          WHERE c.contype = 'f' AND c.conrelid = ('"' || t || '"')::regclass)
      `;
      // 四张表都不在 test/setup/reset-db.ts 的 TRUNCATE 列表里,全靠引用
      // Activity / ActivityRegistrationRevision 被 CASCADE 带走。
      // 零出向外键 = 跨 spec 残留(第三刀记过的 CASCADE 幸存表事故形态)。
      expect(orphans).toEqual([]);
    });

    it('🔴 DoD 8 行为侧:四张表确实被 resetDb 清空(不是只看外键推理)', async () => {
      await expectAccepted(preferenceSql('p-1'));
      await expectAccepted(candidateSql('c-1'));
      await expectAccepted(quotaGroupSql('rq-1'));
      const before = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT (SELECT count(*) FROM "ActivityPositionPreference")
             + (SELECT count(*) FROM "ActivityAllocationBatch")
             + (SELECT count(*) FROM "ActivityAllocationCandidate")
             + (SELECT count(*) FROM "ActivityReservedQuotaGroup") AS n
      `;
      expect(Number(before[0].n)).toBeGreaterThan(0);

      await resetDb(app);

      const after = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT (SELECT count(*) FROM "ActivityPositionPreference")
             + (SELECT count(*) FROM "ActivityAllocationBatch")
             + (SELECT count(*) FROM "ActivityAllocationCandidate")
             + (SELECT count(*) FROM "ActivityReservedQuotaGroup") AS n
      `;
      expect(Number(after[0].n)).toBe(0);
    });

    it('本刀零 trigger、零 exclusion constraint(四张表上一条都没有)', async () => {
      const triggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
        SELECT t.tgname FROM pg_trigger t
        WHERE NOT t.tgisinternal
          AND t.tgrelid::regclass::text IN (
            '"ActivityPositionPreference"', '"ActivityAllocationBatch"',
            '"ActivityAllocationCandidate"', '"ActivityReservedQuotaGroup"')
      `;
      expect(triggers).toEqual([]);

      const exclusions = await prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE contype = 'x'
          AND conrelid::regclass::text IN (
            '"ActivityPositionPreference"', '"ActivityAllocationBatch"',
            '"ActivityAllocationCandidate"', '"ActivityReservedQuotaGroup"')
      `;
      expect(exclusions).toEqual([]);
    });

    it('第 75/80/85 migration 的四张目标表 CHECK 集合精确冻结', async () => {
      const checks = await prisma.$queryRaw<Array<{ conname: string }>>`
        SELECT conname FROM pg_constraint
        WHERE contype = 'c'
          AND conrelid::regclass::text IN (
            '"ActivityPositionPreference"', '"ActivityAllocationBatch"',
            '"ActivityAllocationCandidate"', '"ActivityReservedQuotaGroup"')
        ORDER BY conname
      `;
      // D86 在既有 batch CHECK 集合中增加 voided 事实形状约束。
      expect(checks.map((c) => c.conname)).toEqual([
        'activity_allocation_batch_algorithm_version_code_check',
        'activity_allocation_batch_candidate_snapshot_hash_check',
        'activity_allocation_batch_committed_shape_check',
        'activity_allocation_batch_lottery_seed_shape_check',
        'activity_allocation_batch_mode_code_check',
        'activity_allocation_batch_status_code_check',
        'activity_allocation_batch_status_committed_at_check',
        'activity_allocation_batch_void_shape_check',
        'activity_allocation_candidate_explanation_object_check',
        'activity_allocation_candidate_lottery_order_one_based_check',
        'activity_allocation_candidate_qualification_score_range_check',
        'activity_allocation_candidate_qualification_snapshot_hash_check',
        'activity_allocation_candidate_result_code_check',
        'activity_allocation_candidate_result_rank_shape_check',
        'activity_allocation_candidate_tie_break_key_nonempty_check',
        'activity_allocation_candidate_waitlist_rank_one_based_check',
        'activity_position_preference_order_one_based_check',
        'activity_reserved_quota_group_capacity_positive_check',
        'activity_reserved_quota_group_fallback_mode_check',
        'activity_reserved_quota_group_scope_type_code_check',
      ]);
    });
  });
});
