import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../src/common/decorators/current-user.decorator';
import { BizCode } from '../../src/common/exceptions/biz-code.constant';
import { BizException } from '../../src/common/exceptions/biz.exception';
import { PrismaService } from '../../src/database/prisma.service';
import {
  LEDGER_COMMIT_LOCK_SLOT_COUNT,
  ledgerCommitRequiredSlots,
  tryAcquireLedgerCommitSlots,
} from '../../src/modules/activities/ledger-commit-lock-budget';
import { LedgerPostingService } from '../../src/modules/activities/ledger-posting.service';
import { LedgerPreparationService } from '../../src/modules/activities/ledger-preparation.service';
import { createTestUser } from '../fixtures/users.fixture';
import { resetDb } from '../setup/reset-db';
import { createTestApp } from '../setup/test-app';
import { memberIdentityData } from '../helpers/member-identity.fixture';

// ===== 活动改造 v1.1 第 2 批第五刀:「万人统一生效恒串行」的运行期判据 =====
//
// ⭐ 维护者 2026-08-04 拍板:「同一时刻只允许一场万人活动统一生效」,并明写
//    **必须带执行位,不能只写成文字约束** —— 纯散文的约束等于没有约束,
//    第二场照样能开始,然后在 `out of shared memory` 上炸掉(硬 ERROR,不可重试)。
//
// 本 spec 是那个执行位的运行期判据,三段:
//   ① 闸**只占需要的那么多槽**(用 `pg_locks` 正面数,不靠推理 executor 的短路行为);
//   ② 槽位被占满时,第二场生效**被拒**(20087)而不是挤进去;放开后立刻能过;
//   ③ 还有余量时**照常放行** —— 否则这道闸就退化成"一律拒绝",那也是错的。
//
// ⚠️ 「4999 + 8000 合计 12999 > 12800」那条拍板点名的反例是**算术**性质,
//    在 `src/modules/activities/ledger-commit-lock-budget.spec.ts` ③ 钉住
//    (造两场五千人真数据只为验一条乘法,不值当)。两处合起来才是完整判据:
//    这里证明"闸真的会拦",那里证明"拦的门槛按并发总量算而不是单场人数"。
//
// ⚠️ 并发构造**不用** `Promise.all(两个 service 调用)` 那种假并发:那是同一个连接池,
//    极可能先后串行走完。这里用**两套 Nest / Prisma pool** + 一条把槽位攥住不放的
//    第三事务当闸门。

const SESSION_START = new Date('2020-03-01T01:00:00.000Z');
const SESSION_END = new Date('2020-03-01T05:00:00.000Z');
const SEAL_AT = new Date('2020-03-01T09:00:00.000Z');

interface Fixture {
  activityId: string;
  runId: string;
  versionId: string;
  batchId: string;
  memberIds: string[];
}

describe('ledger posting concurrency —— 恒串行闸 + 双实例并发生效', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let prismaA: PrismaService;
  let prismaB: PrismaService;
  let postingA: LedgerPostingService;
  let postingB: LedgerPostingService;
  let preparationA: LedgerPreparationService;

  let actor: CurrentUserPayload;
  let organizationId: string;
  let sequence = 0;

  const auditMeta = { requestId: 'ledger-posting-concurrency', ip: null, ua: null };

  beforeAll(async () => {
    // 第 7 批第 ③ 刀 —— 活动 v1.1 单一 cutover gate(合同 §16.2)。本 spec 驱动的是
    // **结算真相链**(打卡 / 封场 / 结算 / 账本 / 关账 / 更正),那条链按定义只在闸开时存在;
    // 闸关(默认 = 今天的行为)时这些写入口一律回 20153。故此处显式置真,
    // **断言一字未改** —— 改的只是这个 spec 声明自己跑在哪一侧闸。
    process.env.ACTIVITY_V11_WORKFLOW_ENABLED = 'true';
    appA = await createTestApp();
    appB = await createTestApp();
    await resetDb(appA);
    prismaA = appA.get(PrismaService);
    prismaB = appB.get(PrismaService);
    postingA = appA.get(LedgerPostingService);
    postingB = appB.get(LedgerPostingService);
    preparationA = appA.get(LedgerPreparationService);

    const user = await createTestUser(appA, {
      username: 'ledger-posting-conc-actor',
      role: Role.SUPER_ADMIN,
    });
    actor = {
      id: user.id,
      username: user.username,
      role: user.role,
      status: UserStatus.ACTIVE,
      memberId: null,
    };
    const organization = await prismaA.organization.create({
      data: { name: '账本并发组织', nodeTypeCode: 'ledger-posting-conc-team' },
      select: { id: true },
    });
    organizationId = organization.id;
  });

  afterAll(async () => {
    delete process.env.ACTIVITY_V11_WORKFLOW_ENABLED;
    await Promise.all([appA.close(), appB.close()]);
  });

  async function createReadyBatch(memberCount = 2): Promise<Fixture> {
    sequence += 1;
    const tag = `ledger-conc-${sequence}`;

    const activity = await prismaA.activity.create({
      data: {
        title: `账本并发活动 ${sequence}`,
        activityTypeCode: `ledger-conc-type-${sequence}`,
        organizationId,
        startAt: SESSION_START,
        endAt: SESSION_END,
        location: '深圳',
        statusCode: 'published',
      },
      select: { id: true },
    });
    const session = await prismaA.activitySession.create({
      data: {
        activityId: activity.id,
        code: `${tag}-s0`,
        name: `${tag} 场次`,
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

    const memberIds = Array.from({ length: memberCount }, () => randomUUID());
    await prismaA.member.createMany({
      data: memberIds.map((id, index) => ({
        id,
        memberNo: `${tag}-m${index}`,
        ...memberIdentityData(`${tag} 队员 ${index}`),
        gradeCode: 'level-2',
      })),
    });
    const registrationIds = memberIds.map(() => randomUUID());
    await prismaA.activityRegistration.createMany({
      data: registrationIds.map((id, index) => ({
        id,
        activityId: activity.id,
        memberId: memberIds[index],
        statusCode: 'approved',
      })),
    });

    // 当前 active owner:通知 intent 的收件人。没有他 `enqueuePosted` 会静默跳过,
    // ④ 的「intent 只有一条」就会变成一条**空绿**判据。
    const ownerMember = await prismaA.member.create({
      data: {
        memberNo: `${tag}-owner`,
        ...memberIdentityData(`${tag} 负责人`),
        gradeCode: 'level-2',
      },
      select: { id: true },
    });
    await prismaA.activityResponsibilityAssignment.create({
      data: {
        activityId: activity.id,
        memberId: ownerMember.id,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        assignedByUserId: actor.id,
        source: 'publish',
      },
    });

    const seal = await prismaA.evidenceSeal.create({
      data: {
        activityId: activity.id,
        sealRevision: 1,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        allWindowsClosedAt: SEAL_AT,
        openSegmentCount: 0,
        manualReviewPendingCount: 0,
        populationCountDistinct: memberCount,
        populationCountBySession: {},
        contentHash: `seal-${tag}`,
        statusCode: 'active',
        sealedByUserId: actor.id,
        sealedAt: SEAL_AT,
      },
      select: { id: true },
    });
    const run = await prismaA.attendanceSettlementRun.create({
      data: {
        activityId: activity.id,
        statusCode: 'posting',
        currentDraftVersion: 1,
        currentSubmittedVersion: 1,
      },
      select: { id: true },
    });
    const version = await prismaA.attendanceSettlementVersion.create({
      data: {
        settlementRunId: run.id,
        version: 1,
        evidenceSealId: seal.id,
        evidenceRevision: 0,
        populationRevision: 0,
        workflowRevision: 0,
        contentHash: `content-${tag}`,
        personCount: memberCount,
        sessionParticipationCount: memberCount,
        serviceSegmentCount: memberCount,
        createdByUserId: actor.id,
        submittedAt: SEAL_AT,
        statusCode: 'approved',
        operationKey: `${tag}-submit`,
        requestHash: `${tag}-submit-hash`,
      },
      select: { id: true },
    });

    for (let index = 0; index < memberCount; index += 1) {
      const identity = await prismaA.activityParticipationIdentity.create({
        data: {
          activityId: activity.id,
          sessionId: session.id,
          registrationId: registrationIds[index],
          memberId: memberIds[index],
          currentStatusCode: 'pass',
          populationIncluded: true,
        },
        select: { id: true },
      });
      const checkIn = await prismaA.attendancePunchEvent.create({
        data: {
          activityId: activity.id,
          sessionId: session.id,
          participationIdentityId: identity.id,
          memberId: memberIds[index],
          eventTypeCode: 'check_in',
          sourceCode: 'self_qr',
          occurredAt: SESSION_START,
          receivedAt: SESSION_START,
          operatorUserId: actor.id,
          eventKey: `${tag}-in-${index}`,
          requestHash: `${tag}-in-hash-${index}`,
          evidenceRevision: 0,
        },
        select: { id: true },
      });
      await prismaA.participantServiceSegmentRevision.create({
        data: {
          participationIdentityId: identity.id,
          segmentKey: 'seg-0',
          revision: 0,
          sourceCheckInEventId: checkIn.id,
          resultCode: 'valid',
          statusCode: 'draft',
          checkInAt: SESSION_START,
          checkOutAt: SESSION_END,
          serviceHours: 4,
        },
      });
      await prismaA.participantSettlementResultRevision.create({
        data: {
          settlementVersionId: version.id,
          participationIdentityId: identity.id,
          revision: 0,
          resultCode: 'present',
          recognizedServiceHours: 4,
          recognizedContributionPoints: 1,
          calculatedServiceHours: 4,
          calculatedContributionPoints: 1,
          statusCode: 'draft',
        },
      });
    }

    const batch = await prismaA.ledgerPostingBatch.create({
      data: {
        settlementRunId: run.id,
        settlementVersionId: version.id,
        batchRevision: 1,
        statusCode: 'preparing',
        requestKey: `settlement-final-approve:${version.id}:${tag}`,
        requestHash: `${tag}-approve-hash`,
        totalCount: memberCount,
        preparedByUserId: actor.id,
      },
      select: { id: true },
    });

    const { jobId } = await preparationA.ensurePrepareJob(batch.id);
    const items = await prismaA.activityBatchJobItem.findMany({
      where: { jobId },
      select: { id: true },
      orderBy: { itemKey: 'asc' },
    });
    for (const item of items) await preparationA.prepareChunk(jobId, item.id);
    await preparationA.finalize(jobId);

    return {
      activityId: activity.id,
      runId: run.id,
      versionId: version.id,
      batchId: batch.id,
      memberIds,
    };
  }

  /**
   * 在 appB 上开一条事务,占住 `slots` 个槽位并**卡住不提交**,直到测试放闸。
   * 返回 `[已占到的槽数, 放闸函数, 事务 promise]`。
   */
  function occupySlots(slots: number): {
    acquired: Promise<number>;
    release: () => void;
    done: Promise<void>;
  } {
    let resolveGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let resolveAcquired: (value: number) => void = () => undefined;
    const acquired = new Promise<number>((resolve) => {
      resolveAcquired = resolve;
    });
    const done = prismaB
      .$transaction(
        async (tx) => {
          const count = await tryAcquireLedgerCommitSlots(tx, slots);
          resolveAcquired(count);
          await gate;
        },
        { timeout: 30_000 },
      )
      .then(() => undefined);
    return { acquired, release: resolveGate, done };
  }

  // =========================================================================
  // ⭐ ① 闸只占需要的那么多槽 —— `pg_locks` 正面读数
  // =========================================================================
  it('① 请求 2 个槽 ⇒ 本事务恰好持有 2 把 advisory 锁(不是把 10 个都锁上)', async () => {
    const [acquired, held] = await prismaA.$transaction(async (tx) => {
      const count = await tryAcquireLedgerCommitSlots(tx, 2);
      const [row] = await tx.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid()
      `;
      return [count, row?.count ?? -1] as const;
    });
    expect(acquired).toBe(2);
    // 🔴 这条是"LIMIT 会短路"那个假设的**正面证据**:若执行器把 10 个槽都试了一遍,
    //    这里就会读到 10,一次 2 人的生效会把整库的生效预算独占 —— 闸变成自锁。
    expect(held).toBe(2);
  });

  // =========================================================================
  // ⭐⭐ ② 槽位占满 ⇒ 第二场生效被拒(20087),放开后立刻能过
  // =========================================================================
  it('② 全部槽位被占住时 commit 收 20087 且零副作用;放闸后同一批次立刻成功', async () => {
    const fixture = await createReadyBatch(2);

    const blocker = occupySlots(LEDGER_COMMIT_LOCK_SLOT_COUNT);
    expect(await blocker.acquired).toBe(LEDGER_COMMIT_LOCK_SLOT_COUNT);

    // —— 闸门关着 ——
    const rejected = postingA.commitBatch(
      { postingBatchId: fixture.batchId, operationKey: 'conc-blocked' },
      actor,
      auditMeta,
    );
    await expect(rejected).rejects.toBeInstanceOf(BizException);
    await rejected.catch((error: unknown) => {
      expect((error as BizException).biz).toBe(BizCode.LEDGER_COMMIT_LOCK_BUDGET_EXHAUSTED);
    });
    // 被闸拦下的那一次**一个字都没写**:批次仍 ready、day-state 一行都没建。
    await expect(
      prismaA.ledgerPostingBatch.findUniqueOrThrow({
        where: { id: fixture.batchId },
        select: { statusCode: true },
      }),
    ).resolves.toStrictEqual({ statusCode: 'ready' });
    await expect(
      prismaA.memberContributionDayState.count({ where: { memberId: { in: fixture.memberIds } } }),
    ).resolves.toBe(0);

    // —— 放闸 ——
    blocker.release();
    await blocker.done;

    const passed = await postingA.commitBatch(
      { postingBatchId: fixture.batchId, operationKey: 'conc-released' },
      actor,
      auditMeta,
    );
    expect(passed.batchStatus).toBe('committed');
    expect(passed.replayed).toBe(false);
  });

  // =========================================================================
  // ③ 正对照:还有余量时照常放行(否则这道闸就退化成"一律拒绝")
  // =========================================================================
  it('③ 只占 9 个槽、留 1 个余量 ⇒ 需要 1 个槽的生效照常通过', async () => {
    const fixture = await createReadyBatch(2);
    expect(ledgerCommitRequiredSlots(fixture.memberIds.length)).toBe(1);

    const blocker = occupySlots(LEDGER_COMMIT_LOCK_SLOT_COUNT - 1);
    expect(await blocker.acquired).toBe(LEDGER_COMMIT_LOCK_SLOT_COUNT - 1);

    const result = await postingA.commitBatch(
      { postingBatchId: fixture.batchId, operationKey: 'conc-headroom' },
      actor,
      auditMeta,
    );
    expect(result.batchStatus).toBe('committed');

    blocker.release();
    await blocker.done;
  });

  // =========================================================================
  // ④ 两套 Nest / Prisma pool 真并发生效同一批次 ⇒ 只有一个"真的记了账"
  // =========================================================================
  it('④ 双实例同时 commit 同一批次 ⇒ 恰好一个 replayed=false,日合计只加一次', async () => {
    const fixture = await createReadyBatch(3);

    const [first, second] = await Promise.all([
      postingA.commitBatch(
        { postingBatchId: fixture.batchId, operationKey: 'conc-race-a' },
        actor,
        auditMeta,
      ),
      postingB.commitBatch(
        { postingBatchId: fixture.batchId, operationKey: 'conc-race-b' },
        actor,
        auditMeta,
      ),
    ]);

    expect([first.batchStatus, second.batchStatus]).toStrictEqual(['committed', 'committed']);
    // 🔴 判据:只有一个真的写了账,另一个走的是重放分支。
    expect([first.replayed, second.replayed].filter((value) => value === false)).toHaveLength(1);

    // day-state 只递增过一次 —— 这才是"没有重复入账"的硬证据。
    const states = await prismaA.memberContributionDayState.findMany({
      where: { memberId: { in: fixture.memberIds } },
      select: { version: true, committedCreditedPoints: true },
    });
    expect(states).toHaveLength(3);
    for (const state of states) {
      expect(state.version).toBe(1);
      expect(Number(state.committedCreditedPoints)).toBe(1);
    }
    // 通知 intent 也只有一条(eventKey 按批次去重)。
    await expect(
      prismaA.notificationOutboxIntent.count({
        where: { eventKey: `settlement-ledger-commit:${fixture.batchId}` },
      }),
    ).resolves.toBe(1);
  });
});
