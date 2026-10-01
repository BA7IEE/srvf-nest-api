import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { INestApplication } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { MEMBER_TX_TIMEOUT_MS } from '../../src/common/prisma/member-advisory-lock.util';
import { ledgerCommitRequiredSlots } from '../../src/modules/activities/ledger-commit-lock-budget';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// ===== 活动改造 v1.1 第 2 批第五刀:bind 参数上限的规模判据(goal DoD 13)=====
//
// 🔴 第 0 批实测:**Prisma 查询引擎的 bind 参数上限是 32767**(不是协议的 65535)。
//    day-state 批量回写按逐行 `VALUES` 每人 4 个参数 ⇒ **8191 人处确定性失败**
//    (不是概率问题,是算术)。出路是 `unnest($1::text[], …)`:bind 数恒为**列数**,
//    与人数无关。
//
// ⇒ 本 spec 的规模刻意取 **8192**:恰好越过那条线。跑绿本身就是"逐行 VALUES 那条路
//   已经被换掉"的证据 —— 若谁把哪一条批量写改回逐行 `VALUES`,这条用例会以
//   「Assertion violation: too many bind variables」当场炸,而不是慢慢变慢。
//
// 另外两条读数(写进 PR 报告):
//   - 生效事务里**每条语句的 bind 参数数**(应恒为列数级常数,唯一例外是既有
//     `lockMembersForWrite` 的每人 1 参数 —— 它是只读文件,本刀不改);
//   - 生效事务里的 **SQL 条数**(应固定,不随人数增长)。
//
// ⚠️ 本 spec 单跑约 1-2 分钟(建 8192 人 × 6 张表的夹具占大头),刻意与主 spec 分开,
//    免得把主 spec 的反馈环拖慢。

/** 恰好越过「每人 4 参数 ⇒ 8191 人」那条线。 */
const SCALE_MEMBER_COUNT = 8_192;

/** 造夹具时每批写多少行(createMany 是多行 VALUES,自己也受 32767 约束)。 */
const FIXTURE_CHUNK = 1_000;

const SESSION_START = new Date('2020-03-01T01:00:00.000Z');
const SESSION_END = new Date('2020-03-01T05:00:00.000Z');
const SEAL_AT = new Date('2020-03-01T09:00:00.000Z');

/** Execute the actual tagged template from the service, not a second candidate implementation. */
function segmentQueryFromService(kind: 'members' | 'update', activityId: string, batchId: string) {
  const source = readFileSync(
    join(process.cwd(), 'src/modules/activities/ledger-posting.service.ts'),
    'utf8',
  );
  const template =
    kind === 'members'
      ? source.match(/`(\s*SELECT DISTINCT i\."memberId"[\s\S]*?)`/g)
      : source.match(/`(\s*WITH target AS MATERIALIZED[\s\S]*?)`/g);
  if (template?.length !== 1) throw new Error('segment query source is ambiguous');
  const parts = template[0].slice(1, -1).split(/\$\{([^}]+)\}/);
  const strings: string[] = [];
  const values: string[] = [];
  parts.forEach((part, index) => {
    if (index % 2 === 0) strings.push(part);
    else if (part === 'activityId') values.push(activityId);
    else if (part === 'batch.id') values.push(batchId);
    else throw new Error('unreviewed segment query binding');
  });
  return Prisma.sql(strings, ...values);
}

// Fixed main-21b8de1c reference, deliberately independent of the candidate.
function previousSegmentQueries(activityId: string, batchId: string) {
  return {
    members: Prisma.sql`SELECT DISTINCT i."memberId"
      FROM "ParticipantServiceSegmentRevision" s
      JOIN "ActivityParticipationIdentity" i ON i.id = s."participationIdentityId"
      WHERE i."activityId" = ${activityId} AND s."statusCode" = 'draft'
        AND s."resultCode" NOT IN ('voided', 'replaced') AND s."checkOutAt" IS NOT NULL
      ORDER BY i."memberId" ASC`,
    update: Prisma.sql`UPDATE "ParticipantServiceSegmentRevision" AS s
      SET "statusCode" = 'committed', "effectiveBatchId" = ${batchId}, "updatedAt" = NOW()
      FROM "ActivityParticipationIdentity" i
      WHERE s."participationIdentityId" = i.id AND i."activityId" = ${activityId}
        AND s."statusCode" = 'draft'`,
  };
}

interface StatementRecord {
  binds: number;
  sample: string;
}

interface DiagnosticRow {
  label: string;
  elapsedMs: number;
  status: string;
}

interface PlanDiagnostic {
  label: string;
  elapsedMs: number;
  plan: unknown;
}

/** Keep planner metadata only; never emit conditions, output expressions or parameter values. */
function redactLedgerPlan(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLedgerPlan);
  if (!value || typeof value !== 'object') return value;
  const allowed = new Set([
    'Plan',
    'QUERY PLAN',
    'Plans',
    'Node Type',
    'Parent Relationship',
    'Join Type',
    'Relation Name',
    'Index Name',
    'Scan Direction',
    'Strategy',
    'Startup Cost',
    'Total Cost',
    'Plan Rows',
    'Plan Width',
    'JIT',
    'Functions',
    'Options',
    'Inlining',
    'Optimization',
    'Expressions',
    'Deforming',
    'Actual Rows',
    'Actual Loops',
    'Actual Startup Time',
    'Actual Total Time',
    'Execution Time',
    'Planning Time',
    'Shared Hit Blocks',
    'Shared Read Blocks',
    'Shared Dirtied Blocks',
    'Shared Written Blocks',
  ]);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => allowed.has(key))
      .map(([key, child]) => [key, redactLedgerPlan(child)]),
  );
}

async function collectLedgerPlan(
  target: object,
  args: unknown[],
  label: string,
  plans: PlanDiagnostic[],
  rows: DiagnosticRow[],
): Promise<void> {
  const began = performance.now();
  const head = args[0];
  if (!Array.isArray(head)) throw new Error('ledger plan expected original tagged query');
  const query = Prisma.sql(head as string[], ...args.slice(1));
  try {
    // No ANALYZE: the original statement is still executed exactly once below.
    const result = await (target as Prisma.TransactionClient).$queryRaw<
      Array<Record<string, unknown>>
    >(Prisma.sql`EXPLAIN (FORMAT JSON) ${query}`);
    plans.push({
      label,
      elapsedMs: Number((performance.now() - began).toFixed(3)),
      plan: redactLedgerPlan(result.map((row) => row['QUERY PLAN'])),
    });
    recordTiming(rows, 'diagnostic.plan.' + label, began);
  } catch (error) {
    recordTiming(rows, 'diagnostic.plan.' + label, began, error);
    throw error;
  }
}

/** 只记录固定标签、耗时与允许名单错误码；不输出异常消息、SQL 或参数。 */
function recordTiming(rows: DiagnosticRow[], label: string, began: number, error?: unknown): void {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  rows.push({
    label,
    elapsedMs: Number((performance.now() - began).toFixed(3)),
    status: error === undefined ? 'ok' : code === 'P2028' || code === 'P2010' ? code : 'error',
  });
}

/** 保留 PrismaPromise 的延迟执行；仅在既有 await 消费时包裹 then。 */
function timedQuery(result: unknown, label: string, rows: DiagnosticRow[]): unknown {
  if (!result || typeof result !== 'object' || !('then' in result)) return result;
  return new Proxy(result, {
    get(promise, property) {
      if (property === 'then') {
        return (
          fulfilled?: (value: unknown) => unknown,
          rejected?: (error: unknown) => unknown,
        ) => {
          const began = performance.now();
          const then: unknown = Reflect.get(promise, 'then');
          if (typeof then !== 'function') throw new Error('ledger diagnostic promise contract');
          return Reflect.apply(then, promise, [
            (value: unknown) => {
              recordTiming(rows, label, began);
              return fulfilled ? fulfilled(value) : value;
            },
            (error: unknown) => {
              recordTiming(rows, label, began, error);
              if (rejected) return rejected(error);
              throw error;
            },
          ]);
        };
      }
      const value: unknown = Reflect.get(promise, property);
      return typeof value === 'function' ? value.bind(promise) : value;
    },
  });
}

function diagnosticSqlLabel(args: unknown[]): string {
  const head = args[0];
  const parts = Array.isArray(head)
    ? head
    : head && typeof head === 'object' && 'strings' in head && Array.isArray(head.strings)
      ? head.strings
      : [];
  const literal =
    typeof head === 'string' ? head : parts.filter((p) => typeof p === 'string').join('?');
  const verb = /^\s*(SELECT|UPDATE|INSERT|SET|WITH)\b/.exec(literal)?.[1] ?? 'other';
  if (literal.includes('pg_advisory_xact_lock')) return 'raw.member-or-budget-lock';
  const tables = [
    'Activity',
    'AttendanceSettlementRun',
    'AttendanceSettlementVersion',
    'LedgerPostingBatch',
    'ParticipationLedgerEntry',
    'ParticipantServiceSegmentRevision',
    'ParticipantSettlementResultRevision',
    'MemberContributionDayState',
    'MemberContributionDayBaseline',
    'ActivityParticipationIdentity',
  ].filter((name) => literal.includes('"' + name + '"'));
  return ['raw', verb, ...tables].join('.');
}

function installStageTimers(service: LedgerPostingService, rows: DiagnosticRow[]): () => void {
  const target = service as unknown as Record<string, unknown>;
  const names = [
    'lockActivity',
    'lockRun',
    'lockVersion',
    'lockBatch',
    'assertNoOtherCommittedBatch',
    'readBatchDayDeltas',
    'assertPreparedSetConsistent',
    'readDraftSegmentMemberIds',
    'acquireCommitBudget',
    'assertNoCrossActivitySegmentOverlap',
    'createMissingDayStates',
    'lockDayStates',
    'readPreparedBaseline',
    'advanceDayStates',
  ];
  const originals = names.map((name) => {
    const method = target[name];
    if (typeof method !== 'function') throw new Error('ledger diagnostic stage missing');
    return { name, method, descriptor: Object.getOwnPropertyDescriptor(target, name) };
  });
  for (const { name, method } of originals) {
    target[name] = async (...args: unknown[]) => {
      const began = performance.now();
      try {
        const result: unknown = await Reflect.apply(method, service, args);
        recordTiming(rows, 'stage.' + name, began);
        return result;
      } catch (error) {
        recordTiming(rows, 'stage.' + name, began, error);
        throw error;
      }
    };
  }
  return () => {
    for (const { name, descriptor } of originals) {
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else Reflect.deleteProperty(target, name);
    }
  };
}

/**
 * 把交互事务里的 `$queryRaw` / `$executeRaw` / delegate 调用全部记下来。
 *
 * 沿 `attendance-final-approve-scale-isolation.e2e-spec.ts` 的既有手法(代理 tx),
 * 只多记一件事:**每条语句实际绑定了几个参数**。
 */
function installStatementRecorder(
  prisma: PrismaService,
  rows: DiagnosticRow[],
  plans: PlanDiagnostic[],
): {
  reset: () => void;
  statements: () => StatementRecord[];
  restore: () => void;
} {
  const original = prisma.$transaction.bind(prisma) as (...args: unknown[]) => unknown;
  let records: StatementRecord[] = [];

  const bindCountOf = (args: unknown[]): StatementRecord => {
    const head = args[0] as { strings?: readonly string[]; values?: unknown[] } | undefined;
    if (head !== undefined && Array.isArray(head.values) && Array.isArray(head.strings)) {
      // `tx.$queryRaw(Prisma.sql`…`)` —— 参数已经打包成 Sql 对象。
      return { binds: head.values.length, sample: head.strings.join('?').slice(0, 90) };
    }
    if (Array.isArray(head)) {
      // 标签模板:args[0] 是 strings 数组,其余是插值。
      return { binds: args.length - 1, sample: (head as string[]).join('?').slice(0, 90) };
    }
    return { binds: -1, sample: 'delegate' };
  };

  const wrap = (tx: object): object =>
    new Proxy(tx, {
      get(target, prop, receiver): unknown {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string') return value;
        if (prop.startsWith('$') && typeof value === 'function') {
          const fn = value as (...args: never[]) => unknown;
          return (...args: never[]) => {
            records.push(bindCountOf(args));
            const label = diagnosticSqlLabel(args);
            const result = fn.apply(target, args);
            const isMemberRead =
              label ===
                'raw.SELECT.ParticipantServiceSegmentRevision.ActivityParticipationIdentity' &&
              Array.isArray(args[0]) &&
              String(args[0]).includes('DISTINCT');
            const isSegmentWrite =
              label ===
                'raw.UPDATE.ParticipantServiceSegmentRevision.ActivityParticipationIdentity' ||
              (label ===
                'raw.WITH.ParticipantServiceSegmentRevision.ActivityParticipationIdentity' &&
                Array.isArray(args[0]) &&
                String(args[0]).includes('UPDATE "ParticipantServiceSegmentRevision"'));
            if (isMemberRead || isSegmentWrite) {
              // Still lazy: planning and consumption begin only when the caller awaits.
              // Separate planner time from the one original call; both consume the unchanged budget.
              return {
                then: (
                  fulfilled?: (output: unknown) => unknown,
                  rejected?: (error: unknown) => unknown,
                ) =>
                  collectLedgerPlan(target, args, label, plans, rows)
                    .then(() => timedQuery(result, label, rows))
                    .then(fulfilled, rejected),
              };
            }
            return timedQuery(result, label, rows);
          };
        }
        if (
          value !== null &&
          typeof value === 'object' &&
          typeof (value as { findFirst?: unknown }).findFirst === 'function'
        ) {
          const delegate = value;
          return new Proxy(delegate, {
            get(d, m, r): unknown {
              const fn: unknown = Reflect.get(d, m, r);
              if (typeof fn !== 'function') return fn;
              return (...args: never[]) => {
                records.push({ binds: -1, sample: `${prop}.${String(m)}` });
                return timedQuery(
                  (fn as (...a: never[]) => unknown).apply(d, args),
                  `delegate.${prop}.${String(m)}`,
                  rows,
                );
              };
            },
          });
        }
        return value;
      },
    });

  const patched = (arg: unknown, options: unknown): unknown =>
    typeof arg === 'function'
      ? original((tx: object) => (arg as (t: object) => unknown)(wrap(tx)), options)
      : original(arg, options);
  (prisma as unknown as Record<string, unknown>).$transaction = patched;

  return {
    reset: () => {
      records = [];
    },
    statements: () => records,
    restore: () => {
      (prisma as unknown as Record<string, unknown>).$transaction = original;
    },
  };
}

describe('ledger posting scale —— 8192 人越过 bind 上限(goal DoD 13)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let preparation: LedgerPreparationService;
  let posting: LedgerPostingService;
  let actor: CurrentUserPayload;

  const auditMeta = { requestId: 'ledger-posting-scale', ip: null, ua: null };

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    app = await createTestApp();
    await resetDb(app);
    prisma = app.get(PrismaService);
    preparation = app.get(LedgerPreparationService);
    posting = app.get(LedgerPostingService);
    const user = await createTestUser(app, {
      username: 'ledger-scale-actor',
      role: Role.SUPER_ADMIN,
    });
    actor = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
  }, 120_000);

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await app.close();
  });

  async function createScaleFixture(count = SCALE_MEMBER_COUNT) {
    const tag = randomUUID();
    const organization = await prisma.organization.create({
      data: { name: '账本规模组织', nodeTypeCode: 'ledger-scale-team' },
      select: { id: true },
    });
    const activity = await prisma.activity.create({
      data: {
        title: '账本规模活动',
        activityTypeCode: 'ledger-scale-type',
        organizationId: organization.id,
        startAt: SESSION_START,
        endAt: SESSION_END,
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });
    const session = await prisma.activitySession.create({
      data: {
        activityId: activity.id,
        code: 'ledger-scale-s0',
        name: '规模场次',
        startAt: SESSION_START,
        endAt: SESSION_END,
        locationText: '深圳',
        checkInOpenAt: new Date(SESSION_START.getTime() - 3600_000),
        checkInCloseAt: new Date(SESSION_START.getTime() + 3600_000),
        checkOutOpenAt: SESSION_START,
        checkOutCloseAt: new Date(SESSION_END.getTime() + 3600_000),
        locationRequired: false,
        locationPolicySourceCode: 'session',
        statusCode: 'scheduled',
      },
      select: { id: true },
    });

    const memberIds = Array.from({ length: count }, () => randomUUID());
    const registrationIds = memberIds.map(() => randomUUID());
    const identityIds = memberIds.map(() => randomUUID());
    const punchIds = memberIds.map(() => randomUUID());

    const inChunks = async <T>(rows: T[], write: (chunk: T[]) => Promise<unknown>) => {
      for (let index = 0; index < rows.length; index += FIXTURE_CHUNK) {
        await write(rows.slice(index, index + FIXTURE_CHUNK));
      }
    };

    await inChunks(
      memberIds.map((id, index) => ({
        id,
        memberNo: `${tag}-${index}`,
        ...memberIdentityData(`规模队员 ${index}`),
        gradeCode: 'level-2',
      })),
      (chunk) => prisma.member.createMany({ data: chunk }),
    );
    await inChunks(
      registrationIds.map((id, index) => ({
        id,
        activityId: activity.id,
        memberId: memberIds[index],
        statusCode: 'approved',
      })),
      (chunk) => prisma.activityRegistration.createMany({ data: chunk }),
    );
    await inChunks(
      identityIds.map((id, index) => ({
        id,
        activityId: activity.id,
        sessionId: session.id,
        registrationId: registrationIds[index],
        memberId: memberIds[index],
        currentStatusCode: 'pass',
        populationIncluded: true,
      })),
      (chunk) => prisma.activityParticipationIdentity.createMany({ data: chunk }),
    );
    await inChunks(
      punchIds.map((id, index) => ({
        id,
        activityId: activity.id,
        sessionId: session.id,
        participationIdentityId: identityIds[index],
        memberId: memberIds[index],
        eventTypeCode: 'check_in',
        sourceCode: 'self_qr',
        occurredAt: SESSION_START,
        receivedAt: SESSION_START,
        operatorUserId: actor.id,
        eventKey: `${tag}-scale-in-${index}`,
        requestHash: `scale-in-hash-${index}`,
        evidenceRevision: 0,
      })),
      (chunk) => prisma.attendancePunchEvent.createMany({ data: chunk }),
    );
    await inChunks(
      identityIds.map((identityId, index) => ({
        participationIdentityId: identityId,
        segmentKey: 'seg-0',
        revision: 0,
        sourceCheckInEventId: punchIds[index],
        resultCode: 'valid',
        statusCode: 'draft',
        checkInAt: SESSION_START,
        checkOutAt: SESSION_END,
        serviceHours: 4,
      })),
      (chunk) => prisma.participantServiceSegmentRevision.createMany({ data: chunk }),
    );

    const seal = await prisma.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: SEAL_AT,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: count,
        populationCountBySession: {},
        contentHash: 'seal-scale',
        statusCode: 'active',
        sealedByUserId: actor.id,
        sealedAt: SEAL_AT,
      },
      select: { id: true },
    });
    const run = await prisma.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        statusCode: 'posting',
        currentDraftVersion: 1,
        currentSubmittedVersion: 1,
      },
      select: { id: true },
    });
    const version = await prisma.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: 'content-scale',
        personCount: count,
        sessionParticipationCount: count,
        serviceSegmentCount: count,
        createdByUserId: actor.id,
        submittedAt: SEAL_AT,
        statusCode: 'approved',
        operationKey: `${tag}-scale-submit`,
        requestHash: 'scale-submit-hash',
      },
      select: { id: true },
    });
    await inChunks(
      identityIds.map((identityId) => ({
        settlementVersionId: version.id,
        participationIdentityId: identityId,
        revision: 0,
        resultCode: 'present',
        recognizedServiceHours: 4,
        recognizedContributionPoints: 1,
        calculatedServiceHours: 4,
        calculatedContributionPoints: 1,
        statusCode: 'draft',
      })),
      (chunk) => prisma.participantSettlementResultRevision.createMany({ data: chunk }),
    );
    const batch = await prisma.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: `settlement-final-approve:${tag}`,
        requestHash: 'scale-approve-hash',
        totalCount: count,
        preparedByUserId: actor.id,
      },
      select: { id: true },
    });

    return { activity, session, batch, memberIds, identityIds, punchIds, registrationIds };
  }

  it('8192 人:准备 + 生效全过;生效事务的 SQL 条数固定、bind 参数与人数无关', async () => {
    const { batch } = await createScaleFixture();
    // ===== 准备:分块跑完 =====
    const prepareStartedAt = Date.now();
    const { jobId, itemCount } = await preparation.ensurePrepareJob(batch.id);
    const items = await prisma.activityBatchJobItem.findMany({
      where: { jobId },
      select: { id: true },
      orderBy: { itemKey: 'asc' },
    });
    for (const item of items) await preparation.prepareChunk(jobId, item.id);
    await preparation.finalize(jobId);
    const prepareMs = Date.now() - prepareStartedAt;

    const ready = await prisma.ledgerPostingBatch.findUniqueOrThrow({
      where: { id: batch.id },
      select: { statusCode: true, preparedCount: true, totalCount: true },
    });
    expect(ready.statusCode).toBe('ready');
    expect(ready.preparedCount).toBe(SCALE_MEMBER_COUNT);
    expect(ready.totalCount).toBe(SCALE_MEMBER_COUNT);
    // 每人两条分录(service_credit + contribution_credit)。
    await expect(
      prisma.participationLedgerEntry.count({ where: { postingBatchId: batch.id } }),
    ).resolves.toBe(SCALE_MEMBER_COUNT * 2);

    // ===== 生效:一次短事务 =====
    const plannerStats = await prisma.$queryRaw`
      SELECT c.relname AS table_name, c.reltuples::DOUBLE PRECISION AS estimated_rows,
        c.relpages, s.n_live_tup::DOUBLE PRECISION AS reported_live_rows,
        s.n_mod_since_analyze::DOUBLE PRECISION AS modified_since_analyze,
        s.last_analyze IS NOT NULL AS analyzed, s.last_autoanalyze IS NOT NULL AS autoanalyzed,
        current_setting('jit') AS jit, current_setting('jit_above_cost') AS jit_above_cost
      FROM pg_class c JOIN pg_stat_user_tables s ON s.relid=c.oid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public'
        AND c.relname IN ('ParticipantServiceSegmentRevision','ActivityParticipationIdentity')
      ORDER BY c.relname
    `;
    const diagnosticRows: DiagnosticRow[] = [];
    const plans: PlanDiagnostic[] = [];
    const restoreStages = installStageTimers(posting, diagnosticRows);
    const recorder = installStatementRecorder(prisma, diagnosticRows, plans);
    recorder.reset();
    const commitStartedAt = Date.now();
    const result = await posting
      .commitBatch({ postingBatchId: batch.id, operationKey: 'scale-commit' }, actor, auditMeta)
      .finally(() => {
        recorder.restore();
        restoreStages();
        // 阶段包含其内部查询，不能将两层耗时相加；失败也保留现场并原样抛出。
        console.info(
          '[ledger-scale-diagnostic] ' +
            JSON.stringify({
              members: SCALE_MEMBER_COUNT,
              budgetMs: MEMBER_TX_TIMEOUT_MS,
              elapsedMs: Date.now() - commitStartedAt,
              queries: recorder.statements().length,
              // Original query count above excludes the two non-executing plans.
              plannerStats,
              plans,
              rows: diagnosticRows,
            }),
        );
      });
    const commitMs = Date.now() - commitStartedAt;
    const statements = recorder.statements();
    recorder.restore();

    expect(result.batchStatus).toBe('committed');
    expect(result.runStatus).toBe('posted');
    expect(result.memberCount).toBe(SCALE_MEMBER_COUNT);
    expect(result.dayStateCount).toBe(SCALE_MEMBER_COUNT);
    expect(result.entryCount).toBe(SCALE_MEMBER_COUNT * 2);

    await expect(
      prisma.memberContributionDayState.count({ where: { latestBatchId: batch.id } }),
    ).resolves.toBe(SCALE_MEMBER_COUNT);

    // ===== 读数(逐条进 PR 报告)=====
    const raw = statements.filter((row) => row.binds >= 0);
    const maxBinds = Math.max(...raw.map((row) => row.binds));
    const overLine = raw.filter((row) => row.binds > 64);

    console.log(
      JSON.stringify({
        scaleReadout: {
          memberCount: SCALE_MEMBER_COUNT,
          prepareItemCount: itemCount,
          prepareMs,
          commitMs,
          commitStatementCount: statements.length,
          commitRawStatementCount: raw.length,
          maxBindsInCommit: maxBinds,
          statementsOverSixtyFourBinds: overLine.map((row) => ({
            binds: row.binds,
            sample: row.sample,
          })),
          requiredLockSlots: ledgerCommitRequiredSlots(SCALE_MEMBER_COUNT),
          memberTxBudgetMs: MEMBER_TX_TIMEOUT_MS,
        },
      }),
    );

    // 🔴 判据一:SQL 条数固定、不随人数增长。8192 人若还走"每人一条"那条路,
    //    这里会是四位数。给一个远高于实测、又远低于 O(人数) 的上界。
    expect(statements.length).toBeLessThan(40);

    // 🔴 判据二:除既有 `lockMembersForWrite` 那一条(每人 1 个参数,只读文件不改)之外,
    //    生效事务里**没有任何一条语句的 bind 参数随人数增长**。
    //    换句话说:day-state 补建 / 加锁 / 回写三条都必须是 `unnest`,列数级常数。
    const memberLockStatements = raw.filter((row) => row.sample.includes('pg_advisory_xact_lock'));
    expect(memberLockStatements).toHaveLength(1);
    expect(memberLockStatements[0].binds).toBe(SCALE_MEMBER_COUNT);
    for (const row of raw) {
      if (row.sample.includes('pg_advisory_xact_lock')) continue;
      expect(row.binds).toBeLessThanOrEqual(16);
    }

    // 🔴 判据三:恒串行闸给 8192 人算出的槽位数确实在预算内(否则 20088 会先拦住)。
    expect(ledgerCommitRequiredSlots(SCALE_MEMBER_COUNT)).toBe(9);
  }, 600_000);

  it('compares original and actual candidate SQL rows, replay and rollback; bounded planner probes are local only', async () => {
    const plansEnabled = process.env.SRVF_E3_MAIN_PERF_SQL_PROBE === '1';
    if (plansEnabled && process.env.SRVF_E3_MAIN_PERF_W98 !== '1') {
      throw new Error('planner experiment is restricted to explicit w98 mode');
    }
    const f = await createScaleFixture(plansEnabled ? SCALE_MEMBER_COUNT : 4);
    const outside = await createScaleFixture(1);
    const rollback = new Error('rollback isolated equivalence probe');
    const groups: unknown[] = [];
    await expect(
      prisma.$transaction(
        async (tx) => {
          const otherRegistration = await tx.activityRegistration.create({
            data: {
              activityId: outside.activity.id,
              memberId: f.memberIds[0],
              statusCode: 'approved',
            },
          });
          const otherIdentity = await tx.activityParticipationIdentity.create({
            data: {
              activityId: outside.activity.id,
              sessionId: outside.session.id,
              registrationId: otherRegistration.id,
              memberId: f.memberIds[0],
              currentStatusCode: 'pass',
            },
          });
          await tx.participantServiceSegmentRevision.create({
            data: {
              participationIdentityId: otherIdentity.id,
              sourceCheckInEventId: outside.punchIds[0],
              segmentKey: 'cross-activity',
              revision: 0,
              statusCode: 'draft',
              resultCode: 'valid',
              checkInAt: SESSION_START,
              checkOutAt: SESSION_END,
              serviceHours: 4,
            },
          });
          const outsideIds = [...outside.identityIds, otherIdentity.id];
          const session = await tx.activitySession.findUniqueOrThrow({
            where: { id: f.session.id },
          });
          const duplicateSession = await tx.activitySession.create({
            data: {
              ...session,
              id: randomUUID(),
              code: 'equivalence-second-session',
              name: 'equivalence second session',
            },
          });
          const duplicate = await tx.activityParticipationIdentity.create({
            data: {
              activityId: f.activity.id,
              sessionId: duplicateSession.id,
              registrationId: f.registrationIds[0],
              memberId: f.memberIds[0],
              currentStatusCode: 'pass',
            },
          });
          for (const statusCode of ['draft', 'committed', 'superseded']) {
            for (const resultCode of ['valid', 'early_departure_zero', 'voided', 'replaced']) {
              for (const closed of [true, false]) {
                await tx.participantServiceSegmentRevision.create({
                  data: {
                    participationIdentityId: duplicate.id,
                    sourceCheckInEventId: f.punchIds[0],
                    segmentKey: `equivalence-${statusCode}-${resultCode}-${closed}`,
                    revision: 0,
                    statusCode,
                    resultCode,
                    checkInAt: SESSION_START,
                    checkOutAt: closed ? SESSION_END : null,
                    serviceHours: closed ? 0 : null,
                  },
                });
              }
            }
          }
          const old = previousSegmentQueries(f.activity.id, f.batch.id);
          const candidate = {
            members: segmentQueryFromService('members', f.activity.id, f.batch.id),
            update: segmentQueryFromService('update', f.activity.id, f.batch.id),
          };
          const ids = [...f.identityIds, duplicate.id, ...outsideIds];
          const snapshot = () =>
            tx.participantServiceSegmentRevision.findMany({
              where: { participationIdentityId: { in: ids } },
              orderBy: { id: 'asc' },
            });
          const before = await snapshot();
          expect(await posting['readDraftSegmentMemberIds'](tx, 'no-such-activity')).toEqual([]);
          expect(
            await tx.$executeRaw(segmentQueryFromService('update', 'no-such-activity', f.batch.id)),
          ).toBe(0);
          expect(
            await tx.participationLedgerEntry.count({ where: { postingBatchId: f.batch.id } }),
          ).toBe(0);
          let expectedRows: Awaited<ReturnType<typeof snapshot>> | undefined;
          for (const analyzed of plansEnabled ? [false, true] : [false]) {
            if (analyzed) {
              await tx.$executeRaw`ANALYZE "ActivityParticipationIdentity"`;
              await tx.$executeRaw`ANALYZE "ParticipantServiceSegmentRevision"`;
            }
            const stats =
              await tx.$queryRaw`SELECT relname,reltuples::DOUBLE PRECISION AS rows,relpages
          FROM pg_class WHERE oid IN ('"ActivityParticipationIdentity"'::regclass,'"ParticipantServiceSegmentRevision"'::regclass) ORDER BY relname`;
            for (const [label, queries] of [
              ['original', old],
              ['candidate', candidate],
            ] as const) {
              await tx.$executeRaw`SAVEPOINT segment_equivalence`;
              const members = await tx.$queryRaw<Array<{ memberId: string }>>(queries.members);
              expect(members.map((row) => row.memberId)).toEqual([...f.memberIds].sort());
              expect(await posting['readDraftSegmentMemberIds'](tx, f.activity.id)).toEqual(
                members.map((row) => row.memberId),
              );
              if (plansEnabled) {
                const memberPlan = await tx.$queryRaw(
                  Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queries.members}`,
                );
                const updatePlan = await tx.$queryRaw(
                  Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${queries.update}`,
                );
                groups.push({
                  label,
                  analyzed,
                  stats,
                  memberPlan: redactLedgerPlan(memberPlan),
                  updatePlan: redactLedgerPlan(updatePlan),
                });
              } else await tx.$executeRaw(queries.update);
              const after = await snapshot();
              if (expectedRows === undefined) expectedRows = after;
              else expect(after).toEqual(expectedRows);
              for (let index = 0; index < before.length; index++) {
                const prior = before[index];
                const changed =
                  prior.statusCode === 'draft' &&
                  !outsideIds.includes(prior.participationIdentityId);
                expect(after[index]).toEqual(
                  changed
                    ? {
                        ...prior,
                        statusCode: 'committed',
                        effectiveBatchId: f.batch.id,
                        updatedAt: after[index].updatedAt,
                      }
                    : prior,
                );
              }
              expect(await tx.$executeRaw(queries.update)).toBe(0);
              await tx.$executeRaw`ROLLBACK TO SAVEPOINT segment_equivalence`;
              expect(await snapshot()).toEqual(before);
              await tx.$executeRaw`RELEASE SAVEPOINT segment_equivalence`;
            }
          }
          if (plansEnabled) expect(groups).toHaveLength(4);
          throw rollback;
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBe(rollback);
    expect(
      await prisma.activityParticipationIdentity.count({ where: { activityId: f.activity.id } }),
    ).toBe(f.identityIds.length);
    expect(
      await prisma.participantServiceSegmentRevision.count({
        where: { participationIdentityId: { in: f.identityIds }, statusCode: 'draft' },
      }),
    ).toBe(f.identityIds.length);
    if (plansEnabled) console.info('[ledger-equivalence-four-groups] ' + JSON.stringify(groups));
  }, 600_000);
});
