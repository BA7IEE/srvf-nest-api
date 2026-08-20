import type { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../src/database/prisma.service';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// 活动改造 v1.1 —— 第 1 批第四刀(2026-08-04;第 74 migration
// `20260804080000_activity_v11_slice4_settlement_ledger_correction_closure_job`)。
// 合同:docs/archive/reviews/activity-business-overhaul-v1.1/
//       SRVF_活动业务全流程改造_详细开发文档_v1.1.md §3.19..§3.27
//
// 本 spec 的**唯一**职责:证明 migration 里的每条 CHECK / unique / partial unique /
// trigger 在真实 PostgreSQL 上**真的会拒**非法数据 —— 而不是"schema 文本里写了"。
// 沿前三刀同一范式。
//
// 🔴 每条都**双向**断言(违规被拒 + 合法放行)。只断言"被拒"证明不了约束是对的:
// 一条 `CHECK (false)` 也能让所有违规用例全绿,却把合法写入一起拒掉。更阴的是列名写错 ——
// 合法行被外键/非空挡下时,每条"被拒"都成立却**毫无意义**。反向样例是唯一的分辨手段。
//
// 🔴 本刀语义像钱:committed 之后的 ParticipationLedgerEntry 就是队员贡献值的真值。
//    两条头号判据:
//    ① `recognized = credited + cappedOut`(§3.23.6)—— 纯算术等式,NULL 陷阱重灾区。
//    ② append-only trigger 四条 —— INSERT 放行 / UPDATE 拒 / DELETE 拒 / **TRUNCATE 放行**。
//       第四条挡不住就是整个 e2e 地基塌方(`test/setup/reset-db.ts` 靠 TRUNCATE 清库)。
//
// 走 $executeRawUnsafe 而非 Prisma model API:CHECK 与 partial unique 的 WHERE、
// NULLS NOT DISTINCT、trigger 都是 **DB 层**约束,Prisma client 不认识它们。
// Prisma 把原生语句的数据库错误包成 P2010,SQLSTATE 落在 `meta.code`
// (23505=unique / 23514=check / 23502=not null / 23503=foreign key / 55000=trigger RAISE)。

const T = (iso: string) => `'${iso}'::timestamp`;
const D = (ymd: string) => `DATE '${ymd}'`;

// 全部 2099 —— 避免"硬编码历史日期 + 耦合墙钟"的定时炸弹(仓内已有事故案例)。
const SESSION_START = '2099-06-01T09:00:00.000Z';
const SESSION_END = '2099-06-01T17:00:00.000Z';
const CHECKIN_OPEN = '2099-06-01T08:00:00.000Z';
const CHECKIN_CLOSE = '2099-06-01T10:00:00.000Z';
const CHECKOUT_OPEN = '2099-06-01T16:00:00.000Z';
const CHECKOUT_CLOSE = '2099-06-01T18:00:00.000Z';
const LEDGER_DATE = '2099-06-01';
const LEDGER_DATE_2 = '2099-06-02';

interface RawDbError {
  sqlState: string;
  constraint: string;
  message: string;
}

describe('活动改造 v1.1 第 1 批第四刀 schema 约束(第 74 migration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let organizationId: string;
  let activityId: string;
  let memberId: string;
  let memberId2: string;
  let userId: string;
  let sessionId: string;
  let identityId: string;
  let identityId2: string;
  let sealId: string;

  // 本刀自己建的锚点(每个 beforeEach 重建)
  let runId: string;
  let versionId: string;
  let versionId2: string;
  let resultId: string;
  let batchId: string;
  let batchId2: string;

  let seq = 0;
  const uniq = (label: string) => `v11s4-${label}-${(seq += 1)}`;

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

  // ⚠️ 四类错误能拿到的证据不一样(Prisma 6.19 实测):
  // - CHECK(23514)/ FK(23503):meta.message 是 PG 主消息,含 `constraint "xxx"`
  //   ⇒ 可断言到**具体约束名**。
  // - UNIQUE(23505):meta.message 只有 PG 的 DETAIL 行,形如
  //   `Key ("settlementVersionId")=(v1) already exists.`,**不含约束名**
  //   ⇒ 改断言**键列签名**(本 schema 里覆盖该组键列的唯一索引只有一条,无歧义;
  //   partial 谓词由配套的"放行"用例反向锁死)。
  // - 🔴 NOT NULL(23502):**本刀实测订正前三刀 spec 里的一处误述** —— 它和 UNIQUE 一样
  //   只给 DETAIL 行(`Failing row contains (...)`),**既没有约束名、也没有列名**。
  //   前三刀的注释把它和 CHECK/FK 归成一类("含 constraint 字样"),那是错的:
  //   本刀按那个说法写断言,三条 NULL 用例全红,读错误文本才发现。
  //   ⇒ 23502 只能断言 sqlState;"是哪一列 NOT NULL"改用 information_schema 结构断言覆盖
  //   (见 '四个 delta 列在 DB 里确实都是 NOT NULL')。
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

  const runSql = (
    id: string,
    o: { statusCode?: string; version?: number; currentDraftVersion?: number | null } = {},
  ) => {
    const v = { statusCode: 'drafting', version: 0, currentDraftVersion: null, ...o };
    return `INSERT INTO "AttendanceSettlementRun"
      ("id","updatedAt","activityId","statusCode","version","currentDraftVersion")
      VALUES ('${id}', ${T(SESSION_START)}, '${activityId}', '${v.statusCode}', ${v.version},
       ${v.currentDraftVersion === null ? 'NULL' : v.currentDraftVersion})`;
  };

  const versionSql = (
    id: string,
    o: {
      version?: number;
      statusCode?: string;
      personCount?: number;
      returnFromStage?: string | null;
    } = {},
  ) => {
    const v = {
      version: 1,
      statusCode: 'draft',
      personCount: 1,
      returnFromStage: null,
      ...o,
    };
    return `INSERT INTO "AttendanceSettlementVersion"
      ("id","updatedAt","settlementRunId","version","evidenceSealId","evidenceRevision",
       "populationRevision","workflowRevision","contentHash","personCount",
       "sessionParticipationCount","serviceSegmentCount","statusCode","returnFromStage")
      VALUES ('${id}', ${T(SESSION_START)}, '${runId}', ${v.version}, '${sealId}', 0, 0, 0,
       'content-hash', ${v.personCount}, 1, 1, '${v.statusCode}',
       ${v.returnFromStage === null ? 'NULL' : `'${v.returnFromStage}'`})`;
  };

  const reviewSql = (
    id: string,
    o: {
      settlementVersionId?: string;
      stageCode?: string;
      actionCode?: string;
      operationKey?: string;
    } = {},
  ) => {
    const v = {
      settlementVersionId: versionId,
      stageCode: 'first',
      actionCode: 'approve',
      operationKey: `op-${id}`,
      ...o,
    };
    return `INSERT INTO "SettlementReviewAction"
      ("id","settlementVersionId","stageCode","actionCode","actorUserId","actedAt","operationKey")
      VALUES ('${id}', '${v.settlementVersionId}', '${v.stageCode}', '${v.actionCode}',
       '${userId}', ${T(SESSION_START)}, '${v.operationKey}')`;
  };

  const resultSql = (
    id: string,
    o: {
      settlementVersionId?: string;
      participationIdentityId?: string;
      resultCode?: string;
      statusCode?: string;
      recognizedHours?: number;
      recognizedPoints?: number;
      calculatedHours?: number;
      calculatedPoints?: number;
      adjustmentReason?: string | null;
    } = {},
  ) => {
    const v = {
      settlementVersionId: versionId,
      participationIdentityId: identityId,
      resultCode: 'present',
      statusCode: 'committed',
      recognizedHours: 4,
      recognizedPoints: 1.5,
      calculatedHours: 4,
      calculatedPoints: 1.5,
      adjustmentReason: null,
      ...o,
    };
    return `INSERT INTO "ParticipantSettlementResultRevision"
      ("id","updatedAt","settlementVersionId","participationIdentityId","revision","resultCode",
       "recognizedServiceHours","recognizedContributionPoints","calculatedServiceHours",
       "calculatedContributionPoints","adjustmentReason","statusCode")
      VALUES ('${id}', ${T(SESSION_START)}, '${v.settlementVersionId}',
       '${v.participationIdentityId}', 0, '${v.resultCode}', ${v.recognizedHours},
       ${v.recognizedPoints}, ${v.calculatedHours}, ${v.calculatedPoints},
       ${v.adjustmentReason === null ? 'NULL' : `'${v.adjustmentReason}'`}, '${v.statusCode}')`;
  };

  const daySql = (
    id: string,
    o: {
      ledgerDate?: string;
      creditedPoints?: number;
      stableOrderKey?: string;
    } = {},
  ) => {
    const v = { ledgerDate: LEDGER_DATE, creditedPoints: 1.5, stableOrderKey: `k-${id}`, ...o };
    return `INSERT INTO "ParticipantSettlementDay"
      ("id","updatedAt","resultRevisionId","memberId","ledgerDate","serviceHours",
       "recognizedPoints","creditedPoints","cappedOutPoints","sequenceStartAt","stableOrderKey")
      VALUES ('${id}', ${T(SESSION_START)}, '${resultId}', '${memberId}', ${D(v.ledgerDate)},
       4.00, 1.50, ${v.creditedPoints}, 0.00, ${T(SESSION_START)}, '${v.stableOrderKey}')`;
  };

  const batchSql = (
    id: string,
    o: {
      settlementVersionId?: string;
      batchRevision?: number;
      statusCode?: string;
      requestKey?: string;
      failureCount?: number;
    } = {},
  ) => {
    const v = {
      settlementVersionId: versionId,
      batchRevision: 1,
      statusCode: 'preparing',
      requestKey: `rk-${id}`,
      failureCount: 0,
      ...o,
    };
    return `INSERT INTO "LedgerPostingBatch"
      ("id","updatedAt","settlementRunId","settlementVersionId","batchRevision","statusCode",
       "requestKey","failureCount")
      VALUES ('${id}', ${T(SESSION_START)}, '${runId}', '${v.settlementVersionId}',
       ${v.batchRevision}, '${v.statusCode}', '${v.requestKey}', ${v.failureCount})`;
  };

  const entrySql = (
    id: string,
    o: {
      postingBatchId?: string;
      entryKey?: string;
      operationKey?: string;
      ledgerDate?: string;
      entryTypeCode?: string;
      serviceHoursDelta?: number | null;
      recognizedPointsDelta?: number | null;
      creditedPointsDelta?: number | null;
      cappedOutPointsDelta?: number | null;
      reversesEntryId?: string | null;
    } = {},
  ) => {
    const v = {
      postingBatchId: batchId,
      entryKey: `ek-${id}`,
      operationKey: `oe-${id}`,
      ledgerDate: LEDGER_DATE,
      entryTypeCode: 'contribution_credit',
      serviceHoursDelta: 0,
      recognizedPointsDelta: 1.5,
      creditedPointsDelta: 1.5,
      cappedOutPointsDelta: 0,
      reversesEntryId: null,
      ...o,
    };
    const num = (n: number | null) => (n === null ? 'NULL' : String(n));
    return `INSERT INTO "ParticipationLedgerEntry"
      ("id","postingBatchId","entryKey","operationKey","memberId","activityId","sessionId",
       "participationIdentityId","resultRevisionId","ledgerDate","entryTypeCode",
       "serviceHoursDelta","recognizedPointsDelta","creditedPointsDelta","cappedOutPointsDelta",
       "reversesEntryId")
      VALUES ('${id}', '${v.postingBatchId}', '${v.entryKey}', '${v.operationKey}', '${memberId}',
       '${activityId}', '${sessionId}', '${identityId}', '${resultId}', ${D(v.ledgerDate)},
       '${v.entryTypeCode}', ${num(v.serviceHoursDelta)}, ${num(v.recognizedPointsDelta)},
       ${num(v.creditedPointsDelta)}, ${num(v.cappedOutPointsDelta)},
       ${v.reversesEntryId === null ? 'NULL' : `'${v.reversesEntryId}'`})`;
  };

  const dayStateSql = (
    id: string,
    o: { memberId?: string; ledgerDate?: string; version?: number } = {},
  ) => {
    const v = { memberId, ledgerDate: LEDGER_DATE, version: 0, ...o };
    return `INSERT INTO "MemberContributionDayState"
      ("id","updatedAt","memberId","ledgerDate","version","committedCreditedPoints")
      VALUES ('${id}', ${T(SESSION_START)}, '${v.memberId}', ${D(v.ledgerDate)}, ${v.version}, 1.50)`;
  };

  const correctionSql = (
    id: string,
    o: {
      participationIdentityId?: string | null;
      requestTypeCode?: string;
      statusCode?: string;
      reason?: string;
      baseClosureRevision?: number;
    } = {},
  ) => {
    const v = {
      participationIdentityId: null as string | null,
      requestTypeCode: 'result',
      statusCode: 'pending',
      reason: '漏记一人',
      baseClosureRevision: 1,
      ...o,
    };
    return `INSERT INTO "AttendanceCorrectionRequest"
      ("id","updatedAt","activityId","settlementRunId","participationIdentityId",
       "baseSettlementVersionId","baseClosureRevision","requestTypeCode","requestedChangeJson",
       "reason","statusCode","submittedAt")
      VALUES ('${id}', ${T(SESSION_START)}, '${activityId}', '${runId}',
       ${v.participationIdentityId === null ? 'NULL' : `'${v.participationIdentityId}'`},
       '${versionId}', ${v.baseClosureRevision}, '${v.requestTypeCode}', '{}'::jsonb,
       '${v.reason}', '${v.statusCode}', ${T(SESSION_START)})`;
  };

  const closureSql = (
    id: string,
    o: { revision?: number; statusCode?: string; serviceHours?: number } = {},
  ) => {
    const v = { revision: 1, statusCode: 'active', serviceHours: 8, ...o };
    return `INSERT INTO "ActivitySettlementClosureRevision"
      ("id","updatedAt","activityId","revision","settlementVersionId","postingBatchId",
       "evidenceSealId","evidenceRevision","populationRevision","workflowRevision","personCount",
       "sessionParticipationCount","resultCountsJson","serviceHours","contributionPoints",
       "checksHash","checksJson","statusCode","closedAt")
      VALUES ('${id}', ${T(SESSION_START)}, '${activityId}', ${v.revision}, '${versionId}',
       '${batchId}', '${sealId}', 0, 0, 0, 1, 1, '{}'::jsonb, ${v.serviceHours}, 2.50,
       'checks-hash', '{}'::jsonb, '${v.statusCode}', ${T(CHECKOUT_CLOSE)})`;
  };

  const jobSql = (
    id: string,
    o: {
      jobTypeCode?: string;
      statusCode?: string;
      operationKey?: string;
      leaseGeneration?: number;
    } = {},
  ) => {
    const v = {
      jobTypeCode: 'settlement_prepare',
      statusCode: 'pending',
      operationKey: `oj-${id}`,
      leaseGeneration: 0,
      ...o,
    };
    return `INSERT INTO "ActivityBatchJob"
      ("id","updatedAt","jobTypeCode","activityId","statusCode","operationKey","payloadVersion",
       "payload","leaseGeneration")
      VALUES ('${id}', ${T(SESSION_START)}, '${v.jobTypeCode}', '${activityId}',
       '${v.statusCode}', '${v.operationKey}', 1, '{}'::jsonb, ${v.leaseGeneration})`;
  };

  const jobItemSql = (
    id: string,
    o: { jobId?: string; itemKey?: string; statusCode?: string; attempts?: number } = {},
  ) => {
    const v = { jobId: 'job-a', itemKey: `k-${id}`, statusCode: 'pending', attempts: 0, ...o };
    return `INSERT INTO "ActivityBatchJobItem"
      ("id","updatedAt","jobId","itemKey","statusCode","attempts")
      VALUES ('${id}', ${T(SESSION_START)}, '${v.jobId}', '${v.itemKey}', '${v.statusCode}',
       ${v.attempts})`;
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
          activityTypeCode: 'v11-slice4',
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
        data: { memberNo: uniq('member'), ...memberIdentityData('V11 Slice4 Member') },
        select: { id: true },
      })
    ).id;

    memberId2 = (
      await prisma.member.create({
        data: { memberNo: uniq('member'), ...memberIdentityData('V11 Slice4 Member 2') },
        select: { id: true },
      })
    ).id;

    userId = (
      await prisma.user.create({
        data: { username: uniq('user').toLowerCase(), passwordHash: 'x' },
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

    const mkIdentity = async (mid: string) => {
      const registrationId = (
        await prisma.activityRegistration.create({
          data: { activityId, memberId: mid, statusCode: 'pending' },
          select: { id: true },
        })
      ).id;
      return (
        await prisma.activityParticipationIdentity.create({
          data: { activityId, sessionId, registrationId, memberId: mid, currentStatusCode: 'pass' },
          select: { id: true },
        })
      ).id;
    };
    identityId = await mkIdentity(memberId);
    identityId2 = await mkIdentity(memberId2);

    sealId = (
      await prisma.evidenceSeal.create({
        data: {
          activityId,
          sealRevision: 0,
          evidenceRevision: 0,
          populationRevision: 0,
          workflowRevision: 0,
          allWindowsClosedAt: new Date(CHECKOUT_CLOSE),
          openSegmentCount: 0,
          manualReviewPendingCount: 0,
          populationCountDistinct: 0,
          populationCountBySession: {},
          contentHash: 'seal-hash',
          statusCode: 'active',
          sealedAt: new Date(CHECKOUT_CLOSE),
        },
        select: { id: true },
      })
    ).id;

    // 本刀锚点链:run → version(×2)→ result → batch(×2)
    runId = 'run-a';
    versionId = 'ver-a';
    versionId2 = 'ver-b';
    resultId = 'res-a';
    batchId = 'batch-a';
    batchId2 = 'batch-b';
    await expectAccepted(runSql(runId, { statusCode: 'posted' }));
    await expectAccepted(versionSql(versionId, { version: 1, statusCode: 'approved' }));
    await expectAccepted(versionSql(versionId2, { version: 2, statusCode: 'draft' }));
    await expectAccepted(resultSql(resultId));
    await expectAccepted(batchSql(batchId, { batchRevision: 1, statusCode: 'committed' }));
    await expectAccepted(batchSql(batchId2, { batchRevision: 2, statusCode: 'preparing' }));
    await expectAccepted(jobSql('job-a'));
  });

  // ==========================================================================
  // 正对照先行 —— 十四张新表的合法行必须都能进
  //
  // 这一组是全 spec 的地基:若列名/必填列写错,合法行会被 NOT NULL / FK 挡下,
  // 后面每条"被拒"都仍然成立却毫无意义(主会话在前几刀连续踩过四次)。
  // ==========================================================================
  describe('正对照:合法行必须能进(约束不是 CHECK(false))', () => {
    it('①②⑥⑬ Run / Version / PostingBatch / BatchJob 已在 beforeEach 落地', async () => {
      const counts = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT (SELECT count(*) FROM "AttendanceSettlementRun")
              + (SELECT count(*) FROM "AttendanceSettlementVersion")
              + (SELECT count(*) FROM "LedgerPostingBatch")
              + (SELECT count(*) FROM "ActivityBatchJob") AS n`,
      );
      expect(Number(counts[0].n)).toBe(1 + 2 + 2 + 1);
    });

    it('③ ReviewAction:同一版本 first + final 两个阶段各一个决定都放行', async () => {
      await expectAccepted(reviewSql('ra1', { stageCode: 'first' }));
      await expectAccepted(reviewSql('ra2', { stageCode: 'final' }));
    });

    it('④ ResultRevision:认定==计算时 adjustmentReason 留空放行', async () => {
      await expectAccepted(
        resultSql('res-ok', {
          settlementVersionId: versionId2,
          recognizedHours: 4,
          calculatedHours: 4,
          recognizedPoints: 1.5,
          calculatedPoints: 1.5,
          adjustmentReason: null,
        }),
      );
    });

    it('④b ResultRevision:认定≠计算但带 adjustmentReason 放行', async () => {
      await expectAccepted(
        resultSql('res-adj', {
          settlementVersionId: versionId2,
          recognizedHours: 0,
          calculatedHours: 3,
          recognizedPoints: 0,
          calculatedPoints: 1,
          adjustmentReason: '现场提前离场闭合',
        }),
      );
    });

    it('⑤ SettlementDay 放行', async () => {
      await expectAccepted(daySql('day-ok'));
    });

    it('⑥b PostingBatch:preparing 与 committed 可以并存(preparing 不占 committed 槽)', async () => {
      // beforeEach 已落 committed(batch-a)+ preparing(batch-b),这里再加一条 preparing
      await expectAccepted(batchSql('batch-c', { batchRevision: 3, statusCode: 'preparing' }));
    });

    it('⑦ LedgerEntry:credit / service / 封顶态 / reversal 四种合法形态都放行', async () => {
      // 1.5 = 1.5 + 0
      await expectAccepted(entrySql('e1'));
      // service 分录:点数三列全 0
      await expectAccepted(
        entrySql('e2', {
          entryTypeCode: 'service_credit',
          serviceHoursDelta: 4,
          recognizedPointsDelta: 0,
          creditedPointsDelta: 0,
          cappedOutPointsDelta: 0,
        }),
      );
      // 封顶态:2.0 = 1.5 + 0.5
      await expectAccepted(
        entrySql('e3', {
          ledgerDate: LEDGER_DATE_2,
          recognizedPointsDelta: 2.0,
          creditedPointsDelta: 1.5,
          cappedOutPointsDelta: 0.5,
        }),
      );
      // 冲回:负 delta + 必带 reversesEntryId,且 -1.5 = -1.5 + 0
      await expectAccepted(
        entrySql('e4', {
          postingBatchId: batchId2,
          entryTypeCode: 'contribution_reversal',
          recognizedPointsDelta: -1.5,
          creditedPointsDelta: -1.5,
          cappedOutPointsDelta: 0,
          reversesEntryId: 'e1',
        }),
      );
    });

    it('⑧⑨ ReversalClaim / DayState 放行', async () => {
      await expectAccepted(entrySql('e1'));
      await expectAccepted(
        `INSERT INTO "LedgerEntryReversalClaim"("id","originalEntryId") VALUES ('cl1','e1')`,
      );
      await expectAccepted(dayStateSql('ds1'));
    });

    it('⑩ CorrectionRequest:活动级(identity=NULL)与人员级可以并存', async () => {
      await expectAccepted(correctionSql('cr1', { participationIdentityId: null }));
      await expectAccepted(correctionSql('cr2', { participationIdentityId: identityId }));
    });

    it('⑩b CorrectionRequest:终态(rejected)不占 open 槽,同 target 可再提', async () => {
      await expectAccepted(
        correctionSql('cr-rej', { participationIdentityId: identityId, statusCode: 'rejected' }),
      );
      await expectAccepted(
        correctionSql('cr-new', { participationIdentityId: identityId, statusCode: 'pending' }),
      );
    });

    it('⑪ CorrectionApplication 放行', async () => {
      await expectAccepted(correctionSql('cr1'));
      await expectAccepted(
        `INSERT INTO "CorrectionApplication"
         ("id","updatedAt","correctionRequestId","newSettlementVersionId","newResultRevisionIds",
          "newPostingBatchId","statusCode")
         VALUES ('ca1', ${T(SESSION_START)}, 'cr1', '${versionId2}', '["${resultId}"]'::jsonb,
          '${batchId2}', 'preparing')`,
      );
    });

    it('⑫ ClosureRevision:active 一条 + superseded 多条可以并存', async () => {
      await expectAccepted(closureSql('clo1', { revision: 1, statusCode: 'active' }));
      await expectAccepted(closureSql('clo2', { revision: 2, statusCode: 'superseded' }));
      await expectAccepted(closureSql('clo3', { revision: 3, statusCode: 'superseded' }));
    });

    it('⑭ BatchJobItem:resource 两列留空放行(import_preview 此刻没有资源可指)', async () => {
      await expectAccepted(jobItemSql('it1'));
    });
  });

  // ==========================================================================
  // ① AttendanceSettlementRun(§3.19)
  // ==========================================================================
  describe('① AttendanceSettlementRun', () => {
    it('activityId 全局唯一 —— 一活动一行', async () => {
      await expectRejected(runSql('run-dup'), { sqlState: '23505', key: '"activityId"' });
    });

    it('statusCode 九值闭集', async () => {
      await expectRejected(runSql('run-x', { statusCode: '完结' }), {
        sqlState: '23514',
        constraint: 'attendance_settlement_run_status_code_check',
      });
      // 反向:九个合法值逐一放行(证明闭集不是"只放行我恰好用的那个")
      const legal = [
        'not_started',
        'drafting',
        'submitted',
        'pending_first_review',
        'pending_final_review',
        'posting',
        'posted',
        'correction_open',
        'closed',
      ];
      for (const code of legal) {
        await expectAccepted(
          `UPDATE "AttendanceSettlementRun" SET "statusCode"='${code}' WHERE "id"='${runId}'`,
        );
      }
    });

    it('version / current* 指针非负', async () => {
      await expectRejected(runSql('run-x', { version: -1 }), {
        sqlState: '23514',
        constraint: 'attendance_settlement_run_version_check',
      });
      await expectRejected(runSql('run-x', { currentDraftVersion: -1 }), {
        sqlState: '23514',
        constraint: 'attendance_settlement_run_pointers_check',
      });
    });
  });

  // ==========================================================================
  // ② AttendanceSettlementVersion(§3.19)
  // ==========================================================================
  describe('② AttendanceSettlementVersion', () => {
    it('(settlementRunId, version) 唯一', async () => {
      await expectRejected(versionSql('ver-x', { version: 1 }), {
        sqlState: '23505',
        key: '"settlementRunId"',
      });
    });

    it('statusCode 五值闭集', async () => {
      await expectRejected(versionSql('ver-x', { version: 9, statusCode: '待审' }), {
        sqlState: '23514',
        constraint: 'attendance_settlement_version_status_code_check',
      });
    });

    it('计数快照非负', async () => {
      await expectRejected(versionSql('ver-x', { version: 9, personCount: -1 }), {
        sqlState: '23514',
        constraint: 'attendance_settlement_version_counts_check',
      });
    });

    it('returnFromStage 只能是 first / final(或留空)', async () => {
      await expectRejected(versionSql('ver-x', { version: 9, returnFromStage: 'second' }), {
        sqlState: '23514',
        constraint: 'attendance_settlement_version_return_stage_check',
      });
      await expectAccepted(versionSql('ver-r1', { version: 10, returnFromStage: 'first' }));
      await expectAccepted(versionSql('ver-r2', { version: 11, returnFromStage: 'final' }));
      await expectAccepted(versionSql('ver-r3', { version: 12, returnFromStage: null }));
    });
  });

  // ==========================================================================
  // ③ SettlementReviewAction(§3.19)
  // ==========================================================================
  describe('③ SettlementReviewAction', () => {
    it('operationKey 全局唯一(单列,不是复合)', async () => {
      await expectAccepted(reviewSql('ra1', { operationKey: 'shared-op' }));
      await expectRejected(
        reviewSql('ra2', {
          settlementVersionId: versionId2,
          stageCode: 'final',
          operationKey: 'shared-op',
        }),
        { sqlState: '23505', key: '"operationKey"' },
      );
    });

    it('一版本一阶段至多一个生效决定', async () => {
      await expectAccepted(reviewSql('ra1', { stageCode: 'first', actionCode: 'approve' }));
      await expectRejected(reviewSql('ra2', { stageCode: 'first', actionCode: 'return' }), {
        sqlState: '23505',
        key: '"settlementVersionId"',
      });
      // 反向三条:换阶段 / 换版本都必须放行(证明谓词与键列没写死过宽)
      await expectAccepted(reviewSql('ra3', { stageCode: 'final' }));
      await expectAccepted(reviewSql('ra4', { settlementVersionId: versionId2 }));
    });

    it('stageCode / actionCode 闭集', async () => {
      await expectRejected(reviewSql('ra-x', { stageCode: 'third' }), {
        sqlState: '23514',
        constraint: 'settlement_review_action_stage_code_check',
      });
      await expectRejected(reviewSql('ra-x', { actionCode: 'reject' }), {
        sqlState: '23514',
        constraint: 'settlement_review_action_action_code_check',
      });
    });
  });

  // ==========================================================================
  // ④ ParticipantSettlementResultRevision(§3.20)
  // ==========================================================================
  describe('④ ParticipantSettlementResultRevision', () => {
    it('(settlementVersionId, participationIdentityId) 唯一 —— 一 identity 每版本一条', async () => {
      await expectRejected(resultSql('res-x'), {
        sqlState: '23505',
        key: '"settlementVersionId"',
      });
      // 反向:换 identity / 换版本都放行
      await expectAccepted(resultSql('res-i2', { participationIdentityId: identityId2 }));
      await expectAccepted(resultSql('res-v2', { settlementVersionId: versionId2 }));
    });

    it('resultCode 十值闭集(十个合法值逐一放行)', async () => {
      await expectRejected(
        resultSql('res-x', { settlementVersionId: versionId2, resultCode: '迟到' }),
        {
          sqlState: '23514',
          constraint: 'participant_settlement_result_result_code_check',
        },
      );
      const legal = [
        'present',
        'leave',
        'absent',
        'cancelled',
        'not_selected',
        'waitlist_expired',
        'review_expired',
        'invitation_expired',
        'exempt',
        'early_departure_zero',
      ];
      for (const code of legal) {
        await expectAccepted(
          `UPDATE "ParticipantSettlementResultRevision" SET "resultCode"='${code}'
           WHERE "id"='${resultId}'`,
        );
      }
    });

    it('statusCode 三值闭集', async () => {
      await expectRejected(
        resultSql('res-x', { settlementVersionId: versionId2, statusCode: '已提交' }),
        { sqlState: '23514', constraint: 'participant_settlement_result_status_code_check' },
      );
    });

    // 🔴 OR 形状的两侧各一条 —— 只测一侧会漏掉另一侧完全失效的情况
    it('🔴 时长认定≠计算却无 adjustmentReason 被拒(OR 左支)', async () => {
      await expectRejected(
        resultSql('res-x', {
          settlementVersionId: versionId2,
          recognizedHours: 3,
          calculatedHours: 4,
          adjustmentReason: null,
        }),
        { sqlState: '23514', constraint: 'participant_settlement_result_adjustment_reason_check' },
      );
    });

    it('🔴 分值认定≠计算却无 adjustmentReason 被拒(OR 右支)', async () => {
      await expectRejected(
        resultSql('res-x', {
          settlementVersionId: versionId2,
          recognizedPoints: 0.5,
          calculatedPoints: 1,
          adjustmentReason: null,
        }),
        { sqlState: '23514', constraint: 'participant_settlement_result_adjustment_reason_check' },
      );
    });

    it('adjustmentReason 只有空白字符等同于没填', async () => {
      await expectRejected(
        resultSql('res-x', {
          settlementVersionId: versionId2,
          recognizedHours: 3,
          calculatedHours: 4,
          adjustmentReason: '   ',
        }),
        { sqlState: '23514', constraint: 'participant_settlement_result_adjustment_reason_check' },
      );
    });

    it('认定/计算值非负', async () => {
      await expectRejected(
        resultSql('res-x', {
          settlementVersionId: versionId2,
          recognizedHours: -1,
          calculatedHours: -1,
        }),
        { sqlState: '23514', constraint: 'participant_settlement_result_amounts_check' },
      );
    });
  });

  // ==========================================================================
  // ⑤ ParticipantSettlementDay(§3.21)
  // ==========================================================================
  describe('⑤ ParticipantSettlementDay', () => {
    it('(resultRevisionId, ledgerDate) 唯一', async () => {
      await expectAccepted(daySql('day1'));
      await expectRejected(daySql('day2'), { sqlState: '23505', key: '"resultRevisionId"' });
      // 反向:换一天必须放行
      await expectAccepted(daySql('day3', { ledgerDate: LEDGER_DATE_2 }));
    });

    it('金额非负 / stableOrderKey 不得空白', async () => {
      await expectRejected(daySql('day-x', { creditedPoints: -1 }), {
        sqlState: '23514',
        constraint: 'participant_settlement_day_amounts_check',
      });
      await expectRejected(daySql('day-y', { stableOrderKey: '   ' }), {
        sqlState: '23514',
        constraint: 'participant_settlement_day_order_key_check',
      });
    });
  });

  // ==========================================================================
  // ⑥ LedgerPostingBatch(§3.22)
  // ==========================================================================
  describe('⑥ LedgerPostingBatch', () => {
    it('requestKey 幂等唯一(单列,不是 (requestKey, requestHash) 复合)', async () => {
      await expectRejected(batchSql('batch-x', { batchRevision: 9, requestKey: 'rk-batch-a' }), {
        sqlState: '23505',
        key: '"requestKey"',
      });
    });

    it('(settlementVersionId, batchRevision) 唯一', async () => {
      await expectRejected(batchSql('batch-x', { batchRevision: 1 }), {
        sqlState: '23505',
        key: '"settlementVersionId"',
      });
    });

    it('🔴 一个 SettlementVersion 至多一个 committed batch', async () => {
      await expectRejected(batchSql('batch-x', { batchRevision: 9, statusCode: 'committed' }), {
        sqlState: '23505',
        key: '"settlementVersionId"',
      });
      // 反向两条:① 另一个 version 的 committed 放行 ② 同 version 的非 committed 放行
      await expectAccepted(
        batchSql('batch-v2', {
          settlementVersionId: versionId2,
          batchRevision: 1,
          statusCode: 'committed',
        }),
      );
      await expectAccepted(batchSql('batch-p', { batchRevision: 8, statusCode: 'failed' }));
    });

    it('statusCode 五值闭集 / 计数非负', async () => {
      await expectRejected(batchSql('batch-x', { batchRevision: 9, statusCode: '已发布' }), {
        sqlState: '23514',
        constraint: 'ledger_posting_batch_status_code_check',
      });
      await expectRejected(batchSql('batch-y', { batchRevision: 9, failureCount: -1 }), {
        sqlState: '23514',
        constraint: 'ledger_posting_batch_counters_check',
      });
    });
  });

  // ==========================================================================
  // ⑦ ParticipationLedgerEntry(§3.23)—— 语义像钱的那张
  // ==========================================================================
  describe('⑦ ParticipationLedgerEntry', () => {
    it('entryKey / operationKey 各自单列唯一', async () => {
      await expectAccepted(entrySql('e1'));
      await expectRejected(entrySql('e2', { entryKey: 'ek-e1', ledgerDate: LEDGER_DATE_2 }), {
        sqlState: '23505',
        key: '"entryKey"',
      });
      await expectRejected(entrySql('e3', { operationKey: 'oe-e1', ledgerDate: LEDGER_DATE_2 }), {
        sqlState: '23505',
        key: '"operationKey"',
      });
    });

    it('(postingBatchId, resultRevisionId, ledgerDate, entryTypeCode) 唯一', async () => {
      await expectAccepted(entrySql('e1'));
      await expectRejected(entrySql('e2'), { sqlState: '23505', key: '"postingBatchId"' });
      // 反向三条:换 batch / 换日期 / 换类型都放行
      await expectAccepted(entrySql('e3', { postingBatchId: batchId2 }));
      await expectAccepted(entrySql('e4', { ledgerDate: LEDGER_DATE_2 }));
      await expectAccepted(
        entrySql('e5', {
          entryTypeCode: 'service_credit',
          serviceHoursDelta: 4,
          recognizedPointsDelta: 0,
          creditedPointsDelta: 0,
          cappedOutPointsDelta: 0,
        }),
      );
    });

    it('entryTypeCode 四值闭集', async () => {
      await expectRejected(entrySql('e-x', { entryTypeCode: 'bonus' }), {
        sqlState: '23514',
        constraint: 'participation_ledger_entry_type_code_check',
      });
    });

    // 🔴 形状 CHECK 的两侧各一条
    it('🔴 reversal 不带 reversesEntryId 被拒(形状左支)', async () => {
      await expectRejected(
        entrySql('e-x', {
          entryTypeCode: 'contribution_reversal',
          recognizedPointsDelta: -1.5,
          creditedPointsDelta: -1.5,
          cappedOutPointsDelta: 0,
          reversesEntryId: null,
        }),
        { sqlState: '23514', constraint: 'participation_ledger_entry_reversal_shape_check' },
      );
    });

    it('🔴 普通 credit 却带 reversesEntryId 被拒(形状右支)', async () => {
      await expectAccepted(entrySql('e1'));
      await expectRejected(entrySql('e-x', { ledgerDate: LEDGER_DATE_2, reversesEntryId: 'e1' }), {
        sqlState: '23514',
        constraint: 'participation_ledger_entry_reversal_shape_check',
      });
    });

    // ======================================================================
    // 🔴🔴 §3.23.6 recognized = credited + cappedOut —— 本刀最高危的一条
    // ======================================================================
    it('🔴 等式不成立被拒(2.00 ≠ 1.00 + 0.50)', async () => {
      await expectRejected(
        entrySql('e-x', {
          recognizedPointsDelta: 2.0,
          creditedPointsDelta: 1.0,
          cappedOutPointsDelta: 0.5,
        }),
        { sqlState: '23514', constraint: 'participation_ledger_entry_balance_check' },
      );
    });

    // 🔴 NULL 陷阱:三列任一为 NULL 时朴素等式会求值成 NULL,而 CHECK 在 NULL 时**判通过**。
    //    防线 1 = 三列 NOT NULL(下面三条);
    //    防线 2 = CHECK 自身把 IS NOT NULL 守卫写在 AND 链最前(AND 是 FALSE-主导),
    //             故即使日后有人卸掉 NOT NULL,CHECK 仍然拒 —— 该性质已在 scratch 库上
    //             用 `DROP NOT NULL` + 插 NULL 实测(仍 23514),并用朴素式变异反证
    //             (朴素式下同一行被**静默放行**)。变异证据写在 PR body,不在此 spec 里
    //             重复(spec 不改 DDL)。
    it('🔴 recognizedPointsDelta 为 NULL 被拒', async () => {
      // 23502 只能断言 sqlState —— Prisma 不给列名(见文件头四类错误说明);
      // "是这一列"由三条互相独立的用例 + information_schema 结构断言共同覆盖。
      await expectRejected(entrySql('e-x', { recognizedPointsDelta: null }), { sqlState: '23502' });
    });

    it('🔴 creditedPointsDelta 为 NULL 被拒', async () => {
      // 23502 只能断言 sqlState —— Prisma 不给列名(见文件头四类错误说明);
      // "是这一列"由三条互相独立的用例 + information_schema 结构断言共同覆盖。
      await expectRejected(entrySql('e-x', { creditedPointsDelta: null }), { sqlState: '23502' });
    });

    it('🔴 cappedOutPointsDelta 为 NULL 被拒', async () => {
      // 23502 只能断言 sqlState —— Prisma 不给列名(见文件头四类错误说明);
      // "是这一列"由三条互相独立的用例 + information_schema 结构断言共同覆盖。
      await expectRejected(entrySql('e-x', { cappedOutPointsDelta: null }), { sqlState: '23502' });
    });

    it('🔴 四个 delta 列在 DB 里确实都是 NOT NULL(防线 1 的结构断言)', async () => {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ column_name: string; is_nullable: string }>
      >(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'ParticipationLedgerEntry'
           AND column_name IN ('serviceHoursDelta','recognizedPointsDelta',
                               'creditedPointsDelta','cappedOutPointsDelta')
         ORDER BY column_name`,
      );
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.is_nullable === 'NO')).toBe(true);
    });

    it('§3.23.7 范围:时长 delta 越 ±24 被拒', async () => {
      await expectRejected(
        entrySql('e-x', {
          entryTypeCode: 'service_credit',
          serviceHoursDelta: 24.01,
          recognizedPointsDelta: 0,
          creditedPointsDelta: 0,
          cappedOutPointsDelta: 0,
        }),
        { sqlState: '23514', constraint: 'participation_ledger_entry_magnitude_check' },
      );
      // 反向:边界值 24.00 必须放行(证明不是"把合法上界也一起拒了")
      await expectAccepted(
        entrySql('e-ok', {
          entryTypeCode: 'service_credit',
          serviceHoursDelta: 24.0,
          recognizedPointsDelta: 0,
          creditedPointsDelta: 0,
          cappedOutPointsDelta: 0,
        }),
      );
    });

    it('§3.23.7 范围:credited delta 越 ±3 被拒,recognized 可以远大于 3', async () => {
      await expectRejected(
        entrySql('e-x', {
          recognizedPointsDelta: 3.5,
          creditedPointsDelta: 3.5,
          cappedOutPointsDelta: 0,
        }),
        { sqlState: '23514', constraint: 'participation_ledger_entry_magnitude_check' },
      );
      // 🔴 反向:recognized=9 / credited=3 / cappedOut=6 —— 封顶前的认定值天然可以远大于 3,
      //    给 recognized 也设 3 的上界会误杀这类合法行。
      await expectAccepted(
        entrySql('e-cap', {
          recognizedPointsDelta: 9.0,
          creditedPointsDelta: 3.0,
          cappedOutPointsDelta: 6.0,
        }),
      );
    });

    it('§3.23.7 符号:credit 带负 delta 被拒(左支)', async () => {
      await expectRejected(
        entrySql('e-x', {
          entryTypeCode: 'service_credit',
          serviceHoursDelta: -1,
          recognizedPointsDelta: 0,
          creditedPointsDelta: 0,
          cappedOutPointsDelta: 0,
        }),
        { sqlState: '23514', constraint: 'participation_ledger_entry_sign_check' },
      );
    });

    it('§3.23.7 符号:reversal 带正 delta 被拒(右支)', async () => {
      await expectAccepted(entrySql('e1'));
      await expectRejected(
        entrySql('e-x', {
          postingBatchId: batchId2,
          entryTypeCode: 'contribution_reversal',
          recognizedPointsDelta: 1.5,
          creditedPointsDelta: 1.5,
          cappedOutPointsDelta: 0,
          reversesEntryId: 'e1',
        }),
        { sqlState: '23514', constraint: 'participation_ledger_entry_sign_check' },
      );
    });
  });

  // ==========================================================================
  // 🔴 DoD 4:append-only trigger 四条判据(本刀第二组)
  // ==========================================================================
  describe('🔴 ParticipationLedgerEntry append-only trigger 四条判据', () => {
    it('[1/4] INSERT 放行', async () => {
      await expectAccepted(entrySql('t1'));
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "ParticipationLedgerEntry" WHERE "id"='t1'`,
      );
      expect(Number(rows[0].n)).toBe(1);
    });

    it('[2/4] UPDATE 被 trigger 拒(55000)', async () => {
      await expectAccepted(entrySql('t1'));
      await expectRejected(
        `UPDATE "ParticipationLedgerEntry" SET "creditedPointsDelta"=0.00 WHERE "id"='t1'`,
        { sqlState: '55000', messageContains: 'append-only' },
      );
    });

    it('[3/4] DELETE 被 trigger 拒(55000)', async () => {
      await expectAccepted(entrySql('t1'));
      await expectRejected(`DELETE FROM "ParticipationLedgerEntry" WHERE "id"='t1'`, {
        sqlState: '55000',
        messageContains: 'append-only',
      });
    });

    // 🔴 第四条是 e2e 地基:reset-db.ts 靠 TRUNCATE ... CASCADE 清库,
    //    本表不在 TRUNCATE 列表里,靠引用 "Activity" / "Member" 被 CASCADE 带走。
    //    行级 trigger 不响应 TRUNCATE —— 这条挡不住,整个 e2e 套件就跑不动了。
    it('[4/4] TRUNCATE 放行,且 trigger 事后仍然存活并生效', async () => {
      await expectAccepted(entrySql('t1'));
      await expectAccepted(entrySql('t2', { ledgerDate: LEDGER_DATE_2 }));
      const before = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "ParticipationLedgerEntry"`,
      );
      expect(Number(before[0].n)).toBe(2);

      await resetDb(app);

      const after = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "ParticipationLedgerEntry"`,
      );
      expect(Number(after[0].n)).toBe(0);

      // trigger 仍在
      const trg = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
        `SELECT tgname FROM pg_trigger
         WHERE tgname = 'trg_participation_ledger_entry_10_append_only'`,
      );
      expect(trg).toHaveLength(1);
    });
  });

  // ==========================================================================
  // 🔴 DoD 2:第三刀的打卡 trigger 在**本刀加列之后**必须仍然是那四条
  // ==========================================================================
  describe('🔴 AttendancePunchEvent:本刀加列 importJobItemId 之后 trigger 四条判据重跑', () => {
    const punchSql = (id: string, importJobItemId: string | null = null) =>
      `INSERT INTO "AttendancePunchEvent"
       ("id","activityId","sessionId","participationIdentityId","memberId","eventTypeCode",
        "sourceCode","occurredAt","receivedAt","operatorUserId","eventKey","requestHash",
        "evidenceRevision","importJobItemId")
       VALUES ('${id}', '${activityId}', '${sessionId}', '${identityId}', '${memberId}',
        'check_in', 'import', ${T(SESSION_START)}, ${T(SESSION_START)}, '${userId}',
        'pek-${id}', 'req-hash', 0,
        ${importJobItemId === null ? 'NULL' : `'${importJobItemId}'`})`;

    it('新列是可空 TEXT + 指向 ActivityBatchJobItem 的外键(加列本身的结构断言)', async () => {
      const col = await prisma.$queryRawUnsafe<
        Array<{ data_type: string; is_nullable: string; column_default: string | null }>
      >(
        `SELECT data_type, is_nullable, column_default FROM information_schema.columns
         WHERE table_name='AttendancePunchEvent' AND column_name='importJobItemId'`,
      );
      expect(col).toHaveLength(1);
      expect(col[0].data_type).toBe('text');
      expect(col[0].is_nullable).toBe('YES');
      expect(col[0].column_default).toBeNull();

      const fk = await prisma.$queryRawUnsafe<Array<{ target: string }>>(
        `SELECT confrelid::regclass::text AS target FROM pg_constraint
         WHERE conrelid = '"AttendancePunchEvent"'::regclass AND contype = 'f'
           AND conkey = (SELECT ARRAY[attnum] FROM pg_attribute
                         WHERE attrelid = '"AttendancePunchEvent"'::regclass
                           AND attname = 'importJobItemId')`,
      );
      expect(fk).toHaveLength(1);
      expect(fk[0].target).toBe('"ActivityBatchJobItem"');
    });

    it('[1/4] INSERT 仍放行,且新列可写(欠账列不是死列)', async () => {
      await expectAccepted(jobItemSql('it1'));
      await expectAccepted(punchSql('pe1', 'it1'));
      const rows = await prisma.$queryRawUnsafe<Array<{ importJobItemId: string | null }>>(
        `SELECT "importJobItemId" FROM "AttendancePunchEvent" WHERE "id"='pe1'`,
      );
      expect(rows[0].importJobItemId).toBe('it1');
    });

    it('[2/4] UPDATE 仍被拒 —— 加列没把 trigger 顺手弄坏', async () => {
      await expectAccepted(punchSql('pe1'));
      await expectRejected(
        `UPDATE "AttendancePunchEvent" SET "importJobItemId"=NULL WHERE "id"='pe1'`,
        { sqlState: '55000', messageContains: 'append-only' },
      );
    });

    it('[3/4] DELETE 仍被拒', async () => {
      await expectAccepted(punchSql('pe1'));
      await expectRejected(`DELETE FROM "AttendancePunchEvent" WHERE "id"='pe1'`, {
        sqlState: '55000',
        messageContains: 'append-only',
      });
    });

    it('[4/4] TRUNCATE 仍放行且 trigger 存活', async () => {
      await expectAccepted(punchSql('pe1'));
      await resetDb(app);
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "AttendancePunchEvent"`,
      );
      expect(Number(rows[0].n)).toBe(0);
      const trg = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
        `SELECT tgname FROM pg_trigger WHERE tgname='trg_attendance_punch_event_10_append_only'`,
      );
      expect(trg).toHaveLength(1);
    });
  });

  // ==========================================================================
  // ⑧⑨ LedgerEntryReversalClaim / MemberContributionDayState
  // ==========================================================================
  describe('⑧⑨ ReversalClaim / DayState', () => {
    it('🔴 一条原分录至多被冲回一次(originalEntryId unique)', async () => {
      await expectAccepted(entrySql('e1'));
      await expectAccepted(entrySql('e2', { ledgerDate: LEDGER_DATE_2 }));
      await expectAccepted(
        `INSERT INTO "LedgerEntryReversalClaim"("id","originalEntryId") VALUES ('cl1','e1')`,
      );
      await expectRejected(
        `INSERT INTO "LedgerEntryReversalClaim"("id","originalEntryId") VALUES ('cl2','e1')`,
        { sqlState: '23505', key: '"originalEntryId"' },
      );
      // 反向:另一条原分录可以各自被冲一次
      await expectAccepted(
        `INSERT INTO "LedgerEntryReversalClaim"("id","originalEntryId") VALUES ('cl3','e2')`,
      );
    });

    it('DayState:(memberId, ledgerDate) 唯一 + version 非负', async () => {
      await expectAccepted(dayStateSql('ds1'));
      await expectRejected(dayStateSql('ds2'), { sqlState: '23505', key: '"memberId"' });
      // 反向两条:换人 / 换日期都放行
      await expectAccepted(dayStateSql('ds3', { memberId: memberId2 }));
      await expectAccepted(dayStateSql('ds4', { ledgerDate: LEDGER_DATE_2 }));
      await expectRejected(dayStateSql('ds-x', { ledgerDate: '2099-06-03', version: -1 }), {
        sqlState: '23514',
        constraint: 'member_contribution_day_state_version_check',
      });
    });
  });

  // ==========================================================================
  // ⑩⑪ AttendanceCorrectionRequest / CorrectionApplication(§3.25)
  // ==========================================================================
  describe('⑩⑪ Correction', () => {
    it('🔴 活动级(participationIdentityId = NULL)第二条 open 被拒 —— NULLS NOT DISTINCT 判据', async () => {
      await expectAccepted(correctionSql('cr1', { participationIdentityId: null }));
      await expectRejected(
        correctionSql('cr2', { participationIdentityId: null, statusCode: 'returned' }),
        { sqlState: '23505', key: '"activityId"' },
      );
    });

    it('人员级同 target 第二条 open 被拒', async () => {
      await expectAccepted(correctionSql('cr1', { participationIdentityId: identityId }));
      await expectRejected(
        correctionSql('cr2', { participationIdentityId: identityId, statusCode: 'applying' }),
        { sqlState: '23505', key: '"activityId"' },
      );
      // 反向:换人放行
      await expectAccepted(correctionSql('cr3', { participationIdentityId: identityId2 }));
    });

    it('四个 open 态各占槽,三个终态各不占槽(逐值反向对照)', async () => {
      const open = ['pending', 'returned', 'approved', 'applying'];
      const terminal = ['rejected', 'applied', 'voided'];
      // 终态:同 target 连着塞三条都不该被拦
      for (const [i, code] of terminal.entries()) {
        await expectAccepted(
          correctionSql(`cr-t${i}`, {
            participationIdentityId: identityId,
            statusCode: code,
          }),
        );
      }
      // open 态:第一条放行,其余四态逐一被拦
      await expectAccepted(
        correctionSql('cr-open', { participationIdentityId: identityId, statusCode: 'pending' }),
      );
      for (const [i, code] of open.entries()) {
        await expectRejected(
          correctionSql(`cr-o${i}`, { participationIdentityId: identityId, statusCode: code }),
          { sqlState: '23505', key: '"activityId"' },
        );
      }
    });

    it('requestTypeCode / statusCode 闭集,reason 不得空白,baseClosureRevision 非负', async () => {
      await expectRejected(correctionSql('cr-x', { requestTypeCode: '补录' }), {
        sqlState: '23514',
        constraint: 'attendance_correction_request_type_code_check',
      });
      await expectRejected(correctionSql('cr-x', { statusCode: '待办' }), {
        sqlState: '23514',
        constraint: 'attendance_correction_request_status_code_check',
      });
      await expectRejected(correctionSql('cr-x', { reason: '   ' }), {
        sqlState: '23514',
        constraint: 'attendance_correction_request_reason_check',
      });
      await expectRejected(correctionSql('cr-x', { baseClosureRevision: -1 }), {
        sqlState: '23514',
        constraint: 'attendance_correction_request_numbers_check',
      });
    });

    it('CorrectionApplication statusCode 四值闭集', async () => {
      await expectAccepted(correctionSql('cr1'));
      await expectRejected(
        `INSERT INTO "CorrectionApplication"
         ("id","updatedAt","correctionRequestId","newSettlementVersionId","newResultRevisionIds",
          "newPostingBatchId","statusCode")
         VALUES ('ca-x', ${T(SESSION_START)}, 'cr1', '${versionId2}', '[]'::jsonb,
          '${batchId2}', '已应用')`,
        { sqlState: '23514', constraint: 'correction_application_status_code_check' },
      );
    });
  });

  // ==========================================================================
  // ⑫ ActivitySettlementClosureRevision(§3.26)
  // ==========================================================================
  describe('⑫ ClosureRevision', () => {
    it('(activityId, revision) 唯一', async () => {
      await expectAccepted(closureSql('clo1', { revision: 1 }));
      await expectRejected(closureSql('clo2', { revision: 1, statusCode: 'superseded' }), {
        sqlState: '23505',
        key: '"activityId"',
      });
    });

    it('🔴 一活动至多一个 active closure', async () => {
      await expectAccepted(closureSql('clo1', { revision: 1, statusCode: 'active' }));
      await expectRejected(closureSql('clo2', { revision: 2, statusCode: 'active' }), {
        sqlState: '23505',
        key: '"activityId"',
      });
      // 反向两条:superseded / voided 不占槽
      await expectAccepted(closureSql('clo3', { revision: 3, statusCode: 'superseded' }));
      await expectAccepted(closureSql('clo4', { revision: 4, statusCode: 'voided' }));
    });

    it('statusCode 三值闭集 / 合计非负', async () => {
      await expectRejected(closureSql('clo-x', { revision: 9, statusCode: '已关账' }), {
        sqlState: '23514',
        constraint: 'activity_settlement_closure_status_code_check',
      });
      await expectRejected(
        closureSql('clo-y', { revision: 9, statusCode: 'superseded', serviceHours: -1 }),
        { sqlState: '23514', constraint: 'activity_settlement_closure_totals_check' },
      );
    });

    it('⚠️ 合计列是 numeric(12,2) 而非 (5,2) —— 万人 × 24h 不能撑爆', async () => {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ column_name: string; numeric_precision: number; numeric_scale: number }>
      >(
        `SELECT column_name, numeric_precision, numeric_scale FROM information_schema.columns
         WHERE table_name='ActivitySettlementClosureRevision'
           AND column_name IN ('serviceHours','contributionPoints')
         ORDER BY column_name`,
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.numeric_precision === 12 && r.numeric_scale === 2)).toBe(true);
      // 行为对照:240000.00 小时(万人 × 24h)必须存得下
      await expectAccepted(
        closureSql('clo-big', { revision: 7, statusCode: 'superseded', serviceHours: 240000.0 }),
      );
    });
  });

  // ==========================================================================
  // ⑬⑭ ActivityBatchJob / Item(§3.27)
  // ==========================================================================
  describe('⑬⑭ BatchJob / BatchJobItem', () => {
    it('Job:operationKey 单列唯一', async () => {
      await expectRejected(jobSql('job-x', { operationKey: 'oj-job-a' }), {
        sqlState: '23505',
        key: '"operationKey"',
      });
    });

    it('Job:jobTypeCode 七值闭集(七个合法值逐一放行)', async () => {
      await expectRejected(jobSql('job-x', { jobTypeCode: '导出' }), {
        sqlState: '23514',
        constraint: 'activity_batch_job_type_code_check',
      });
      const legal = [
        'settlement_prepare',
        'bulk_proxy',
        'import_preview',
        'import_execute',
        'export',
        'notification_expand',
        'reconciliation',
      ];
      for (const code of legal) {
        await expectAccepted(
          `UPDATE "ActivityBatchJob" SET "jobTypeCode"='${code}' WHERE "id"='job-a'`,
        );
      }
    });

    it('Job:statusCode 七值闭集 / 计数与 leaseGeneration 非负', async () => {
      await expectRejected(jobSql('job-x', { statusCode: '运行中' }), {
        sqlState: '23514',
        constraint: 'activity_batch_job_status_code_check',
      });
      await expectRejected(jobSql('job-y', { leaseGeneration: -1 }), {
        sqlState: '23514',
        constraint: 'activity_batch_job_counters_check',
      });
    });

    it('⚠️ worker 协议五列存在且形状与既有 outbox 一致(零新增基础设施)', async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_name='ActivityBatchJob'
           AND column_name IN ('leaseOwner','leaseGeneration','leaseExpiresAt','attempts','availableAt')
         ORDER BY column_name`,
      );
      expect(rows.map((r) => r.column_name)).toEqual([
        'attempts',
        'availableAt',
        'leaseExpiresAt',
        'leaseGeneration',
        'leaseOwner',
      ]);
      // 领取判据要与 now() 直接比较 ⇒ 两个时间列必须带时区,与 notification_outbox_intents 同型
      const tz = rows.filter((r) => ['availableAt', 'leaseExpiresAt'].includes(r.column_name));
      expect(tz.every((r) => r.data_type === 'timestamp with time zone')).toBe(true);
    });

    it('Item:(jobId, itemKey) 唯一 / attempts 非负 / itemKey 不得空白', async () => {
      await expectAccepted(jobItemSql('it1', { itemKey: 'k1' }));
      await expectRejected(jobItemSql('it2', { itemKey: 'k1' }), {
        sqlState: '23505',
        key: '"jobId"',
      });
      await expectRejected(jobItemSql('it-x', { attempts: -1 }), {
        sqlState: '23514',
        constraint: 'activity_batch_job_item_attempts_check',
      });
      await expectRejected(jobItemSql('it-y', { itemKey: '   ' }), {
        sqlState: '23514',
        constraint: 'activity_batch_job_item_key_check',
      });
    });

    it('⚠️ Item.statusCode **刻意没有**闭集 CHECK(合同缺口)—— 任意值放行', async () => {
      // 这条是把"刻意不做"钉成会变红的判据:哪天有人凭猜测补了闭集 CHECK,这里立刻红,
      // 迫使补的人先回去把合同缺口补上(§3.27 给了 Job 七值,没给 Item)。
      await expectAccepted(jobItemSql('it-any', { statusCode: 'whatever-未定义' }));
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
         WHERE r.relname = 'ActivityBatchJobItem' AND c.contype = 'c'
           AND pg_get_constraintdef(c.oid) LIKE '%statusCode%'`,
      );
      expect(Number(rows[0].n)).toBe(0);
    });

    it('⚠️ Item 没有为异常堆栈 / SQL / 敏感原值预留任何字段(§3.27)', async () => {
      const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'ActivityBatchJobItem' ORDER BY column_name`,
      );
      const names = cols.map((c) => c.column_name);
      expect(names).toEqual([
        'attempts',
        'createdAt',
        'id',
        'itemKey',
        'jobId',
        'lastErrorCode',
        'payloadHash',
        'resourceId',
        'resourceType',
        'resultReference',
        'safeMessage',
        'statusCode',
        'updatedAt',
      ]);
      // 明确点名:不得出现任何堆栈 / SQL / 原值类列
      for (const forbidden of [
        'stack',
        'stackTrace',
        'sql',
        'rawPayload',
        'rawValue',
        'errorDetail',
      ]) {
        expect(names).not.toContain(forbidden);
      }
    });
  });

  // ==========================================================================
  // 🔴 DoD 3 / 6 / 12:选型、刻意不做、清库闭包 —— 三条结构判据
  // ==========================================================================
  describe('🔴 结构判据:ledgerDate 同型 / 跨行不变量刻意不进 DB / 零 resetDb 幸存表', () => {
    it('🔴 DoD 3:ledgerDate 三处全部是 date(不是 timestamp)', async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string; data_type: string }>>(
        `SELECT table_name, data_type FROM information_schema.columns
         WHERE column_name = 'ledgerDate' ORDER BY table_name`,
      );
      expect(rows.map((r) => r.table_name)).toEqual([
        'MemberContributionDayState',
        'ParticipantSettlementDay',
        'ParticipationLedgerEntry',
      ]);
      // 混型会让 (memberId, ledgerDate) 唯一在跨表 join 时静默错位
      expect(rows.every((r) => r.data_type === 'date')).toBe(true);
    });

    // 🔴 DoD 6:「日合计 0..3」是**跨行**不变量,刻意不进 DB。
    //    这条用两个判据钉死"刻意",让日后有人偷偷加伪造执行位时立刻变红:
    //    ① 行为判据:同 member 同日多条分录合计超过 3,DB **必须放行**;
    //    ② 结构判据:三张账本相关表上不得出现任何 statement/row trigger 去伪造跨行求和。
    it('🔴 DoD 6:同 member 同日合计超过 3 时 DB 放行 —— 跨行日上限刻意归 service', async () => {
      await expectAccepted(
        entrySql('c1', {
          recognizedPointsDelta: 3.0,
          creditedPointsDelta: 3.0,
          cappedOutPointsDelta: 0,
        }),
      );
      await expectAccepted(
        entrySql('c2', {
          postingBatchId: batchId2,
          recognizedPointsDelta: 3.0,
          creditedPointsDelta: 3.0,
          cappedOutPointsDelta: 0,
        }),
      );
      const sum = await prisma.$queryRawUnsafe<Array<{ total: string }>>(
        `SELECT coalesce(sum("creditedPointsDelta"),0)::text AS total
         FROM "ParticipationLedgerEntry"
         WHERE "memberId"='${memberId}' AND "ledgerDate"=${D(LEDGER_DATE)}`,
      );
      // 6.00 > 3 —— DB 确实没有跨行执行位,这是**刻意的**(执行位在第 2 批 service 的
      // member advisory lock 内)。若哪天有人加了 trigger 伪造跨行求和,上面两条 INSERT
      // 会有一条变红,这个断言就是那道警报。
      expect(Number(sum[0].total)).toBeGreaterThan(3);
    });

    it('🔴 DoD 6:账本三表上零 trigger 伪造跨行求和(只允许 append-only 那一条)', async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ relname: string; tgname: string }>>(
        `SELECT r.relname, t.tgname FROM pg_trigger t JOIN pg_class r ON r.oid = t.tgrelid
         WHERE NOT t.tgisinternal
           AND r.relname IN ('ParticipationLedgerEntry','ParticipantSettlementDay',
                             'MemberContributionDayState')
         ORDER BY r.relname, t.tgname`,
      );
      expect(rows).toEqual([
        {
          relname: 'ParticipationLedgerEntry',
          tgname: 'trg_participation_ledger_entry_10_append_only',
        },
      ]);
    });

    it('🔴 DoD 12:本刀 14 张新表零出向外键的集合 = 空集(否则 resetDb 清不掉)', async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ t: string }>>(
        `WITH new_tables(t) AS (VALUES
           ('AttendanceSettlementRun'),('AttendanceSettlementVersion'),('SettlementReviewAction'),
           ('ParticipantSettlementResultRevision'),('ParticipantSettlementDay'),
           ('LedgerPostingBatch'),('ParticipationLedgerEntry'),('LedgerEntryReversalClaim'),
           ('MemberContributionDayState'),('AttendanceCorrectionRequest'),
           ('CorrectionApplication'),('ActivitySettlementClosureRevision'),
           ('ActivityBatchJob'),('ActivityBatchJobItem'))
         SELECT t FROM new_tables
         WHERE NOT EXISTS (
           SELECT 1 FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
           WHERE c.contype = 'f' AND r.relname = new_tables.t)`,
      );
      expect(rows).toEqual([]);
    });

    it('🔴 DoD 12 行为对照:14 张表写满数据后 resetDb 必须全部清空', async () => {
      await expectAccepted(reviewSql('ra1'));
      await expectAccepted(daySql('day1'));
      await expectAccepted(entrySql('e1'));
      await expectAccepted(
        `INSERT INTO "LedgerEntryReversalClaim"("id","originalEntryId") VALUES ('cl1','e1')`,
      );
      await expectAccepted(dayStateSql('ds1'));
      await expectAccepted(correctionSql('cr1'));
      await expectAccepted(
        `INSERT INTO "CorrectionApplication"
         ("id","updatedAt","correctionRequestId","newSettlementVersionId","newResultRevisionIds",
          "newPostingBatchId","statusCode")
         VALUES ('ca1', ${T(SESSION_START)}, 'cr1', '${versionId2}', '[]'::jsonb, '${batchId2}',
          'preparing')`,
      );
      await expectAccepted(closureSql('clo1'));
      await expectAccepted(jobItemSql('it1'));

      await resetDb(app);

      const rows = await prisma.$queryRawUnsafe<Array<{ t: string; n: bigint }>>(
        `SELECT 'AttendanceSettlementRun' t, count(*) n FROM "AttendanceSettlementRun"
         UNION ALL SELECT 'AttendanceSettlementVersion', count(*) FROM "AttendanceSettlementVersion"
         UNION ALL SELECT 'SettlementReviewAction', count(*) FROM "SettlementReviewAction"
         UNION ALL SELECT 'ParticipantSettlementResultRevision', count(*) FROM "ParticipantSettlementResultRevision"
         UNION ALL SELECT 'ParticipantSettlementDay', count(*) FROM "ParticipantSettlementDay"
         UNION ALL SELECT 'LedgerPostingBatch', count(*) FROM "LedgerPostingBatch"
         UNION ALL SELECT 'ParticipationLedgerEntry', count(*) FROM "ParticipationLedgerEntry"
         UNION ALL SELECT 'LedgerEntryReversalClaim', count(*) FROM "LedgerEntryReversalClaim"
         UNION ALL SELECT 'MemberContributionDayState', count(*) FROM "MemberContributionDayState"
         UNION ALL SELECT 'AttendanceCorrectionRequest', count(*) FROM "AttendanceCorrectionRequest"
         UNION ALL SELECT 'CorrectionApplication', count(*) FROM "CorrectionApplication"
         UNION ALL SELECT 'ActivitySettlementClosureRevision', count(*) FROM "ActivitySettlementClosureRevision"
         UNION ALL SELECT 'ActivityBatchJob', count(*) FROM "ActivityBatchJob"
         UNION ALL SELECT 'ActivityBatchJobItem', count(*) FROM "ActivityBatchJobItem"`,
      );
      expect(rows).toHaveLength(14);
      expect(rows.filter((r) => Number(r.n) !== 0)).toEqual([]);
    });
  });
});
