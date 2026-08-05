import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import {
  LEDGER_PREPARE_JOB_TYPE,
  LedgerPrepareLeaseLostError,
  LedgerPreparationService,
  type LedgerPrepareLeaseFence,
} from './ledger-preparation.service';
import { LedgerReadyBatchCommitter } from './ledger-ready-batch-committer.service';

export const ACTIVITY_BATCH_AUTO_COMMIT_ENABLED = Symbol('ACTIVITY_BATCH_AUTO_COMMIT_ENABLED');

// ===== 活动改造 v1.1 第 2 批第五刀:`ActivityBatchWorker`(合同 §3.27)=====
//
// §3.27 worker 协议逐字:「复用现有 PostgreSQL `SKIP LOCKED + lease/fencing` 模式,
// 在现有 worker 进程注册 ActivityBatchWorker,**不新增 cron 和外部队列**。」
//
// ## 与既有两个 worker 的形状对齐
//
// `notification-outbox` / `storage-consistency` 两条既有链路的取活方式被逐条镜像:
//   - `FOR UPDATE SKIP LOCKED` 取候选(多实例并行不互相阻塞);
//   - `leaseOwner + leaseGeneration + leaseExpiresAt` 三列构成**租约与围栏**;
//   - `attempts` 上限 + `availableAt` 退避;
//   - 每次真正写业务之前**重新校验围栏**(见 `LedgerPreparationService.prepareChunk`)。
//
// 🔴 **零新增基础设施**:没有 Redis、没有队列、没有新 cron(全仓 cron 终态仍恰 2)、
//    没有新进程。`ActivityBatchJob` 的五列 lease/fencing 是第 1 批第四刀建表时
//    就照既有两张表的形状留好的。
//
// ## 第 ⑧a 刀补齐进程注册与 ready 自动提交
//
// `ActivityBatchWorkerModule` 已被两个既有 worker application context import,两个入口
// 都把本类的 `run()` 与原循环并行启动。它仍没有 cron、Redis、外部 queue 或新进程。
//
// prepare 收口到 `ready` 后,本类只调用 `LedgerReadyBatchCommitter`；后者从
// `SettlementReviewAction(final/approve)` 取 actor,再调用第五刀唯一的 `commitBatch`。
// commit 失败只把同一 prepare job 退回 pending,批次保持 ready,不重算 baseline。
//
// ## 本 worker 只认 `settlement_prepare` 一种任务
//
// §3.27 的 `jobTypeCode` 是七值闭集,其余六种(bulk_proxy / import_* / export /
// notification_expand / reconciliation)分属后续批次。本刀**不为它们预留分发骨架** ——
// 空壳分支既不会被测到,又会让人以为已经支持。

/** 一次取活的租约时长。取活后每个 item 的事务都会重新校验围栏。 */
export const ACTIVITY_BATCH_LEASE_MS = 5 * 60_000;

/** 单个任务的最大尝试次数。用尽仍未成功 ⇒ `dead`,不再自动重试。 */
export const ACTIVITY_BATCH_MAX_ATTEMPTS = 5;

/** 失败重试退避(与既有 outbox 的固定退避同形,不引入指数退避这类新机制)。 */
export const ACTIVITY_BATCH_RETRY_BACKOFF_MS = 30_000;

/** 一次 `drainOnce` 最多为多少个 `preparing` 批次补建任务。 */
const ENQUEUE_SCAN_LIMIT = 20;

export interface ActivityBatchDrainResult {
  /** 本轮新建的准备任务数。 */
  jobsEnqueued: number;
  /** 本轮是否领到了任务(false = 队列空,调用方可以停)。 */
  jobClaimed: boolean;
  jobId: string | null;
  itemsProcessed: number;
  itemsSkipped: number;
  itemsFailed: number;
  /** 收口后的批次状态(未收口时 null)。 */
  batchStatus: string | null;
  /** 本轮是否进入过 ready → committed 自动提交。 */
  commitAttempted: boolean;
  /** 自动提交失败的脱敏错误类名;成功或未尝试为 null。 */
  commitErrorCode: string | null;
}

@Injectable()
export class ActivityBatchWorker implements OnApplicationShutdown, OnModuleDestroy {
  private readonly logger = new Logger(ActivityBatchWorker.name);
  private stopping = false;
  private wakeIdle: (() => void) | null = null;
  private activeRound: Promise<ActivityBatchDrainResult> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly preparation: LedgerPreparationService,
    private readonly committer: LedgerReadyBatchCommitter,
    @Inject(ACTIVITY_BATCH_AUTO_COMMIT_ENABLED)
    private readonly autoCommitEnabled: boolean,
  ) {}

  onApplicationShutdown(): Promise<void> {
    return this.stopAndDrain();
  }

  onModuleDestroy(): Promise<void> {
    return this.stopAndDrain();
  }

  /** 现有两个进程共同启动的守护循环；空队列时短轮询，不新增 cron / queue。 */
  async run(): Promise<void> {
    this.logger.log('activity batch worker started');
    while (!this.stopping) {
      try {
        this.activeRound = this.drainOnce();
        const result = await this.activeRound;
        if (!result.jobClaimed && result.jobsEnqueued === 0) await this.waitForNextPoll(500);
      } catch (error) {
        this.logger.warn(`activity batch drain failed error=${errorName(error)}`);
        await this.waitForNextPoll(500);
      } finally {
        this.activeRound = null;
      }
    }
  }

  /**
   * 跑一轮:补建任务 → 领一个任务 → 逐块处理 → 收口。
   *
   * `run()` 的每轮与测试显式调用都复用这里；本方法本身不睡眠,一次只做一轮。
   */
  async drainOnce(options: { now?: Date } = {}): Promise<ActivityBatchDrainResult> {
    const now = options.now ?? new Date();
    const jobsEnqueued = await this.enqueuePreparingBatches(now);

    const claimed = await this.claimJob(now);
    if (claimed === null) {
      return {
        jobsEnqueued,
        jobClaimed: false,
        jobId: null,
        itemsProcessed: 0,
        itemsSkipped: 0,
        itemsFailed: 0,
        batchStatus: null,
        commitAttempted: false,
        commitErrorCode: null,
      };
    }

    const fence: LedgerPrepareLeaseFence = {
      leaseOwner: claimed.leaseOwner,
      leaseGeneration: claimed.leaseGeneration,
    };
    const items = await this.prisma.activityBatchJobItem.findMany({
      where: { jobId: claimed.id, statusCode: { not: 'succeeded' } },
      select: { id: true },
      orderBy: { itemKey: 'asc' },
    });

    let itemsProcessed = 0;
    let itemsSkipped = 0;
    let itemsFailed = 0;
    for (const item of items) {
      try {
        const result = await this.preparation.prepareChunk(claimed.id, item.id, fence);
        if (result.skipped) itemsSkipped += 1;
        else itemsProcessed += 1;
      } catch (error) {
        if (error instanceof LedgerPrepareLeaseLostError) {
          // 围栏失效 ⇒ 本轮整体作废,**不写任何收尾状态**(那是新持有者的事)。
          this.logger.warn(`activity batch job ${claimed.id} lease lost, aborting round`);
          return {
            jobsEnqueued,
            jobClaimed: true,
            jobId: claimed.id,
            itemsProcessed,
            itemsSkipped,
            itemsFailed,
            batchStatus: null,
            commitAttempted: false,
            commitErrorCode: null,
          };
        }
        itemsFailed += 1;
        await this.markItemFailed(item.id, error);
        break;
      }
    }

    if (itemsFailed > 0) {
      await this.releaseForRetry(claimed.id, now);
      return {
        jobsEnqueued,
        jobClaimed: true,
        jobId: claimed.id,
        itemsProcessed,
        itemsSkipped,
        itemsFailed,
        batchStatus: null,
        commitAttempted: false,
        commitErrorCode: null,
      };
    }

    const finalized = await this.preparation.finalize(claimed.id);
    if (finalized.batchStatus === 'ready' && this.autoCommitEnabled) {
      try {
        // `commitBatch` 会把成功的 settlement_prepare job 当作 baseline 明细真源。
        // 重试领取会把 job 暂时改成 processing,故调用统一生效协议前先恢复 succeeded;
        // lease 仍保留到 commit ack,崩溃后由下一轮的过期 lease 恢复器重新排队。
        await this.markReadyForCommit(claimed.id);
        const committed = await this.committer.commitReadyBatch(finalized.postingBatchId);
        await this.markCommitSucceeded(claimed.id);
        return {
          jobsEnqueued,
          jobClaimed: true,
          jobId: claimed.id,
          itemsProcessed,
          itemsSkipped,
          itemsFailed,
          batchStatus: committed.batchStatus,
          commitAttempted: true,
          commitErrorCode: null,
        };
      } catch (error) {
        // commitBatch 自己的事务保证任何失败都零部分生效。这里只退回**同一条 job**,
        // 不改 ready 批次、不重算 baseline,下一轮仍会拿同一批次重试。
        await this.releaseForRetry(claimed.id, now, error);
        this.logger.warn(
          `activity ledger auto commit deferred job=${claimed.id} error=${errorName(error)}`,
        );
        return {
          jobsEnqueued,
          jobClaimed: true,
          jobId: claimed.id,
          itemsProcessed,
          itemsSkipped,
          itemsFailed,
          batchStatus: finalized.batchStatus,
          commitAttempted: true,
          commitErrorCode: errorName(error),
        };
      }
    }
    if (finalized.batchStatus === 'committed' && this.autoCommitEnabled) {
      // commit 已成功、但上一任在 ack job 前崩溃时,过期 lease 会重领到这里。
      // 批次本身就是幂等真源,只需把同一 job 收口,绝不再次写账。
      await this.markCommitSucceeded(claimed.id);
    }
    return {
      jobsEnqueued,
      jobClaimed: true,
      jobId: claimed.id,
      itemsProcessed,
      itemsSkipped,
      itemsFailed,
      batchStatus: finalized.batchStatus,
      commitAttempted: false,
      commitErrorCode: null,
    };
  }

  /**
   * 反复 `drainOnce` 直到队列空。**有界**(`maxRounds`),不是守护进程循环 ——
   * 没有定时器,也不会在没活干的时候空转。
   */
  async drainUntilIdle(maxRounds = 100): Promise<ActivityBatchDrainResult[]> {
    const rounds: ActivityBatchDrainResult[] = [];
    for (let index = 0; index < maxRounds; index += 1) {
      const result = await this.drainOnce();
      rounds.push(result);
      if (!result.jobClaimed && result.jobsEnqueued === 0) break;
    }
    return rounds;
  }

  /**
   * §5.12 的入口:给每个还没有准备任务的 `preparing` 批次补一条任务。
   *
   * 幂等靠 `ActivityBatchJob.operationKey` 单列 unique(`settlement_prepare:{batchId}`)——
   * 这里的 `none` 过滤只是省掉无谓的事务,不是正确性来源。
   */
  private async enqueuePreparingBatches(now: Date): Promise<number> {
    // commit 前已把准备 job 收成 succeeded,若进程在真正 commit / ack 前崩溃,
    // batch 会保持 ready。等原 lease 过期后把**同一 job**恢复 pending,不新建、不重算。
    if (this.autoCommitEnabled) {
      await this.prisma.activityBatchJob.updateMany({
        where: {
          jobTypeCode: LEDGER_PREPARE_JOB_TYPE,
          statusCode: 'succeeded',
          postingBatch: { statusCode: 'ready' },
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        },
        data: {
          statusCode: 'pending',
          availableAt: now,
          completedAt: null,
        },
      });
    }
    const batches = await this.prisma.ledgerPostingBatch.findMany({
      where: {
        statusCode: 'preparing',
        batchJobs: { none: { jobTypeCode: LEDGER_PREPARE_JOB_TYPE } },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: ENQUEUE_SCAN_LIMIT,
    });
    let enqueued = 0;
    for (const batch of batches) {
      try {
        await this.preparation.ensurePrepareJob(batch.id);
        enqueued += 1;
      } catch (error) {
        // 批次刚被别的路径改走(退回作废 / 已被另一实例建过任务)是正常竞态,
        // 不该让整轮取活失败。
        this.logger.warn(
          `enqueue settlement prepare job failed batch=${batch.id} error=${errorName(error)}`,
        );
      }
    }
    return enqueued;
  }

  /**
   * `FOR UPDATE SKIP LOCKED` 取一个可跑的任务并盖上租约。
   *
   * 可取条件与既有 outbox 逐条同形:
   *   - 未开跑(`pending`)且 `availableAt` 已到;或
   *   - 跑了一半但**租约已过期**(`processing` + `leaseExpiresAt <= now`)—— 持有者已经死了。
   * `attempts` 用尽的任务不再取(由 `sweepDead` 收成 `dead`)。
   */
  private async claimJob(
    now: Date,
  ): Promise<{ id: string; leaseOwner: string; leaseGeneration: number } | null> {
    const leaseOwner = `activity-batch-worker:${randomUUID()}`;
    const leaseExpiresAt = new Date(now.getTime() + ACTIVITY_BATCH_LEASE_MS);

    return await this.prisma.$transaction(async (tx) => {
      await this.sweepDead(tx, now);

      const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM "ActivityBatchJob"
        WHERE "jobTypeCode" = ${LEDGER_PREPARE_JOB_TYPE}
          AND "attempts" < ${ACTIVITY_BATCH_MAX_ATTEMPTS}
          AND (
            ("statusCode" = 'pending' AND "availableAt" <= ${now})
            OR ("statusCode" = 'processing'
                AND "leaseExpiresAt" IS NOT NULL
                AND "leaseExpiresAt" <= ${now})
          )
        ORDER BY "availableAt" ASC, "createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      const candidate = candidates[0];
      if (candidate === undefined) return null;

      const updated = await tx.activityBatchJob.update({
        where: { id: candidate.id },
        data: {
          statusCode: 'processing',
          leaseOwner,
          leaseGeneration: { increment: 1 },
          leaseExpiresAt,
          attempts: { increment: 1 },
          startedAt: now,
          lastErrorCode: null,
        },
        select: { id: true, leaseGeneration: true },
      });
      return { id: updated.id, leaseOwner, leaseGeneration: updated.leaseGeneration };
    });
  }

  /**
   * 租约到期但尝试次数已用尽 ⇒ 原子标 `dead`。
   *
   * 与既有 outbox 同一理由:不这么做的话,一个"已经试到上限"的任务会永远卡在
   * `processing` + 过期租约上,既不被取走也不被判死,运维看不出它已经放弃了。
   */
  private async sweepDead(tx: Prisma.TransactionClient, now: Date): Promise<void> {
    await tx.activityBatchJob.updateMany({
      where: {
        jobTypeCode: LEDGER_PREPARE_JOB_TYPE,
        statusCode: 'processing',
        attempts: { gte: ACTIVITY_BATCH_MAX_ATTEMPTS },
        leaseExpiresAt: { not: null, lte: now },
      },
      data: {
        statusCode: 'dead',
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: 'LEDGER_PREPARE_MAX_ATTEMPTS_EXHAUSTED',
      },
    });
  }

  /**
   * 一个块失败 ⇒ 任务退回 `pending` 并退避。
   *
   * ⚠️ **不改批次状态**:块失败是可重试的(下一轮从失败的那个块继续,已成功的块
   * 靠 item 状态跳过)。真正让批次落 `failed` 的只有 `finalize` 里的数量不一致。
   */
  private async releaseForRetry(jobId: string, now: Date, error?: unknown): Promise<void> {
    await this.prisma.activityBatchJob.update({
      where: { id: jobId },
      data: {
        statusCode: 'pending',
        leaseOwner: null,
        leaseExpiresAt: null,
        availableAt: new Date(now.getTime() + ACTIVITY_BATCH_RETRY_BACKOFF_MS),
        completedAt: null,
        ...(error === undefined ? {} : { lastErrorCode: errorName(error) }),
      },
    });
  }

  /**
   * §3.27 明写「**不存异常堆栈、SQL 和敏感原值**」⇒ 只落
   * `lastErrorCode`(错误类名)与 `safeMessage`(BizCode 的对外文案,已是脱敏产物)。
   */
  private async markItemFailed(itemId: string, error: unknown): Promise<void> {
    await this.prisma.activityBatchJobItem.update({
      where: { id: itemId },
      data: {
        statusCode: 'failed',
        attempts: { increment: 1 },
        lastErrorCode: errorName(error),
        safeMessage: safeMessageOf(error),
      },
    });
  }

  private async markCommitSucceeded(jobId: string): Promise<void> {
    await this.prisma.activityBatchJob.update({
      where: { id: jobId },
      data: {
        statusCode: 'succeeded',
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
        lastErrorCode: null,
      },
    });
  }

  private async markReadyForCommit(jobId: string): Promise<void> {
    await this.prisma.activityBatchJob.update({
      where: { id: jobId },
      data: {
        statusCode: 'succeeded',
        completedAt: new Date(),
        lastErrorCode: null,
      },
    });
  }

  private stopAndDrain(): Promise<void> {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.stopping = true;
    this.wakeIdle?.();
    this.shutdownPromise = (async () => {
      if (this.activeRound !== null) await Promise.allSettled([this.activeRound]);
    })();
    return this.shutdownPromise;
  }

  private async waitForNextPoll(ms: number): Promise<void> {
    if (this.stopping) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.wakeIdle === finish) this.wakeIdle = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wakeIdle = finish;
      if (this.stopping) finish();
    });
  }
}

function errorName(error: unknown): string {
  const bizCode = (error as { biz?: { code?: unknown } } | null)?.biz?.code;
  if (typeof bizCode === 'number') return `BizException:${bizCode}`;
  if (error instanceof Error && error.name.length > 0) return error.name;
  return 'UnknownError';
}

/**
 * 只有 `BizException` 才有对外可展示的文案(它本来就是给用户看的);其余一律 null ——
 * 原始 `error.message` 可能带 SQL 片段或值,正是 §3.27 明禁的东西。
 */
function safeMessageOf(error: unknown): string | null {
  const biz = (error as { biz?: { message?: unknown } } | null)?.biz;
  return typeof biz?.message === 'string' ? biz.message : null;
}
