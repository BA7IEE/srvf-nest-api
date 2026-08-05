import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { PrismaService } from '../../src/database/prisma.service';
import { MEMBER_TX_TIMEOUT_MS } from '../../src/common/prisma/member-advisory-lock.util';
import { ledgerCommitRequiredSlots } from '../../src/modules/activities/ledger-commit-lock-budget';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';

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

interface StatementRecord {
  binds: number;
  sample: string;
}

/**
 * 把交互事务里的 `$queryRaw` / `$executeRaw` / delegate 调用全部记下来。
 *
 * 沿 `attendance-final-approve-scale-isolation.e2e-spec.ts` 的既有手法(代理 tx),
 * 只多记一件事:**每条语句实际绑定了几个参数**。
 */
function installStatementRecorder(prisma: PrismaService): {
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
            return fn.apply(target, args);
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
                return (fn as (...a: never[]) => unknown).apply(d, args);
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
    await app.close();
  });

  it('8192 人:准备 + 生效全过;生效事务的 SQL 条数固定、bind 参数与人数无关', async () => {
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

    const memberIds = Array.from({ length: SCALE_MEMBER_COUNT }, () => randomUUID());
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
        memberNo: `scale-m${index}`,
        displayName: `规模队员 ${index}`,
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
        eventKey: `scale-in-${index}`,
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
        populationCountDistinct: SCALE_MEMBER_COUNT,
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
        personCount: SCALE_MEMBER_COUNT,
        sessionParticipationCount: SCALE_MEMBER_COUNT,
        serviceSegmentCount: SCALE_MEMBER_COUNT,
        createdByUserId: actor.id,
        submittedAt: SEAL_AT,
        statusCode: 'approved',
        operationKey: 'scale-submit',
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
        requestKey: 'settlement-final-approve:scale',
        requestHash: 'scale-approve-hash',
        totalCount: SCALE_MEMBER_COUNT,
        preparedByUserId: actor.id,
      },
      select: { id: true },
    });

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
    const recorder = installStatementRecorder(prisma);
    recorder.reset();
    const commitStartedAt = Date.now();
    const result = await posting.commitBatch(
      { postingBatchId: batch.id, operationKey: 'scale-commit' },
      actor,
      auditMeta,
    );
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
});
