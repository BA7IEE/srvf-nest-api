import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import type {
  AppMyActivityBatchJobDetailDto,
  AppMyActivityBatchJobItemDto,
  AppMyActivityBatchJobListItemDto,
  ListAppMyActivityBatchJobItemsQueryDto,
  ListAppMyActivityBatchJobsQueryDto,
} from './dto/app/app-my-activity-batch-job.dto';

type PrismaTx = Prisma.TransactionClient;

/**
 * 合同 §6.13「后台任务」统一读面 + §9.9 界面口径。
 *
 * 🔴 判权基准(§6.13 原文):「服务端根据 job.activityId 和当前责任／组织范围判权。
 *    知道 jobId 不能查看或重试他人的任务。」——**不是**按 job 创建人。
 *    本类里没有任何分支读 `createdByUserId` 来放行:`createdBy` 只出现在出参投影中。
 *
 * 🔴 越权一律 `NOT_FOUND`(40400),与「jobId 不存在」同码同文案 ⇒ 不泄露任务是否存在。
 *
 * 🔴 重试与取消(§9.9「下载和重试都重新判权」)在**事务内**重新判权,并对责任行取
 *    `FOR SHARE`:与撤权写事务互斥 ⇒ 撤权一旦提交,后续重试/取消立即失效,
 *    不因为「你当初建的」而放行。
 *
 * ⚠️ 时钟:本类**不做任何基于时钟的业务判定**。`retryFailedAllowed` / `cancelAllowed`
 *    与实际放行都只看 `statusCode`;唯一读时刻的地方是 §9.9 要求的 lease **人话状态**,
 *    它照抄 worker 领取判据的同一口径(应用时钟,见 activity-batch.worker.ts 的
 *    `"leaseExpiresAt" <= ${now}`),不另立第二个时间权威(#1075)。
 */
@Injectable()
export class AppMyActivityBatchJobsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    memberId: string,
    query: ListAppMyActivityBatchJobsQueryDto,
  ): Promise<PageResultDto<AppMyActivityBatchJobListItemDto>> {
    const where: Prisma.ActivityBatchJobWhereInput = {
      activity: scopedActivityWhere(memberId),
      ...(query.activityId === undefined ? {} : { activityId: query.activityId }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.activityBatchJob.count({ where }),
      this.prisma.activityBatchJob.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: JOB_SELECT,
      }),
    ]);
    const now = new Date();
    return {
      items: rows.map((row) => presentJob(row, now)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async detail(memberId: string, jobId: string): Promise<AppMyActivityBatchJobDetailDto> {
    const row = await this.prisma.activityBatchJob.findFirst({
      where: { id: jobId, activity: scopedActivityWhere(memberId) },
      select: JOB_SELECT,
    });
    if (row === null) throw new BizException(BizCode.NOT_FOUND);
    return {
      ...presentJob(row, new Date()),
      retryFailedAllowed: row.failed > 0 && RETRYABLE_JOB_STATUSES.has(row.statusCode),
      cancelAllowed: CANCELLABLE_JOB_STATUSES.has(row.statusCode),
    };
  }

  async listItems(
    memberId: string,
    jobId: string,
    query: ListAppMyActivityBatchJobItemsQueryDto,
  ): Promise<PageResultDto<AppMyActivityBatchJobItemDto>> {
    // 先确认 job 在责任范围内 —— 否则「越权但 jobId 存在」会返回空页而不是 404,
    // 空页与「你的任务恰好没有失败项」不可区分,等于把存在性泄露成一个时序差。
    const job = await this.prisma.activityBatchJob.findFirst({
      where: { id: jobId, activity: scopedActivityWhere(memberId) },
      select: { id: true },
    });
    if (job === null) throw new BizException(BizCode.NOT_FOUND);
    const where: Prisma.ActivityBatchJobItemWhereInput = {
      jobId: job.id,
      ...(query.status === undefined ? {} : { statusCode: query.status }),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.activityBatchJobItem.count({ where }),
      this.prisma.activityBatchJobItem.findMany({
        where,
        orderBy: [{ itemKey: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: ITEM_SELECT,
      }),
    ]);
    return {
      items: rows.map((row) => ({
        itemId: row.id,
        itemKey: row.itemKey,
        statusCode: row.statusCode,
        attempts: row.attempts,
        lastErrorCode: row.lastErrorCode,
        safeMessage: row.safeMessage,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * 只把 `failed` 项打回 `pending`,并把 job 计数里的 `failed` 同额扣减。
   *
   * 🔴 计数必须同额扣减:worker 的 `finalizeBulkPunchJob` 会核对
   *    `succeeded + failed + skipped === total` **且**逐项统计与 job 计数逐字相等,
   *    对不上就 `failClosed()`。少扣一位 ⇒ 下一轮 worker 直接失败。
   * 🔴 `succeeded` / `skipped` 计数与对应 item 一律不动 ⇒ 成功项不会被二次执行副作用。
   * 🔴 不写 `availableAt`:该列已是过去时刻,job 回到 `pending` 即可被领取。
   *    (写它会给 #1075 的时钟登记表新增写点 —— 本刀不动那张表。)
   */
  async retryFailed(memberId: string, jobId: string): Promise<AppMyActivityBatchJobDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const job = await this.lockJobInScope(tx, memberId, jobId);
      if (!RETRYABLE_JOB_STATUSES.has(job.statusCode)) {
        throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
      }
      const failed = await tx.activityBatchJobItem.updateMany({
        where: { jobId: job.id, statusCode: 'failed' },
        data: { statusCode: 'pending', lastErrorCode: null, safeMessage: null },
      });
      if (failed.count === 0) throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
      await tx.activityBatchJob.update({
        where: { id: job.id },
        data: {
          statusCode: 'pending',
          failed: { decrement: failed.count },
          attempts: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: null,
          lastErrorCode: null,
        },
      });
    });
    return this.detail(memberId, jobId);
  }

  /**
   * 终态语义:`succeeded` / `cancelled` / `dead` 不可取消 —— 已完成或已提交的任务
   * 取消掉等于伪造一个从未发生的结局。进行中(`pending` / `processing`)取消后,
   * worker 的领取判据(`statusCode = 'pending'` 或 `'processing'`)当场不再匹配 ⇒
   * 不再被领;已持有租约的那一轮在下一项的 `lockAndVerifyBulkJob` 上 lease-lost 退出。
   */
  async cancel(memberId: string, jobId: string): Promise<AppMyActivityBatchJobDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const job = await this.lockJobInScope(tx, memberId, jobId);
      if (!CANCELLABLE_JOB_STATUSES.has(job.statusCode)) {
        throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
      }
      const now = await readAuthoritativeNow(tx);
      await tx.activityBatchJob.update({
        where: { id: job.id },
        data: {
          statusCode: 'cancelled',
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
        },
      });
    });
    return this.detail(memberId, jobId);
  }

  /**
   * 事务内重新判权 + 行锁,锁序沿 §10.1:**Activity 根 → job 行 → 责任行**。
   *
   * 🔴 责任行取 `FOR SHARE`:撤权是对同一行的 UPDATE ⇒ 两者互斥。撤权先提交 ⇒ 本方法
   *    读到的 `status` 已不是 `active`,当场判否;本方法先持锁 ⇒ 撤权排队到本事务之后。
   *    这正是「重试与取消重新判权」在并发下真正成立的机制,不是「查一下」。
   * 🔴 三处失败一律 `NOT_FOUND` 同码:job 不存在 / 活动已软删 / 不在责任范围,
   *    调用方无法从错误码区分,存在性不泄露。
   */
  private async lockJobInScope(
    tx: PrismaTx,
    memberId: string,
    jobId: string,
  ): Promise<{ id: string; activityId: string; statusCode: string }> {
    const located = await tx.activityBatchJob.findUnique({
      where: { id: jobId },
      select: { activityId: true },
    });
    if (located === null) throw new BizException(BizCode.NOT_FOUND);

    // ① Activity 根锁(§10.1 第 1 层),与 worker 的 lockActivityRoot 同一把锁。
    const activities = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Activity"
      WHERE "id" = ${located.activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (activities.length !== 1) throw new BizException(BizCode.NOT_FOUND);

    // ② job 行锁 —— 锁后重读 statusCode,避免拿锁前的陈旧状态做终态判定。
    const jobs = await tx.$queryRaw<Array<{ id: string; activityId: string; statusCode: string }>>(
      Prisma.sql`
        SELECT "id", "activityId", "statusCode" FROM "ActivityBatchJob"
        WHERE "id" = ${jobId} AND "activityId" = ${located.activityId}
        FOR UPDATE
      `,
    );
    const job = jobs[0];
    if (jobs.length !== 1 || job === undefined) throw new BizException(BizCode.NOT_FOUND);

    // ③ 责任行共享锁 + 重新判权。
    if (!(await inResponsibilityScope(tx, job.activityId, memberId))) {
      throw new BizException(BizCode.NOT_FOUND);
    }
    return job;
  }
}

/**
 * 「当前责任／组织范围」的唯一定义(与 ActivityResponsibilityService.listManaged 同口径):
 * 活动发起人本人,或该活动上一条 `status = 'active'` 的责任分配。
 * 撤销后 `status` 不再是 `active` ⇒ 立即出范围。
 */
function scopedActivityWhere(memberId: string): Prisma.ActivityWhereInput {
  return {
    deletedAt: null,
    OR: [
      { initiatorMemberId: memberId },
      { responsibilityAssignments: { some: { memberId, status: 'active' } } },
    ],
  };
}

async function inResponsibilityScope(
  tx: PrismaTx,
  activityId: string,
  memberId: string,
): Promise<boolean> {
  // ⚠️ 两条查询**不能**合成一条 UNION:PostgreSQL 禁止 `FOR SHARE` 与 UNION 同用,
  //    合起来写只会静默丢掉行锁 —— 注释说「已加锁」而实际没加,是本仓栽过的形状。
  const assignments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "activity_responsibility_assignments"
    WHERE "activityId" = ${activityId}
      AND "memberId" = ${memberId}
      AND "status" = 'active'
    ORDER BY "id" ASC
    FOR SHARE
  `);
  if (assignments.length > 0) return true;
  // 发起人身份挂在 Activity 行上,该行在 ① 已被 `FOR UPDATE` 持有,无需二次加锁。
  const initiator = await tx.activity.findFirst({
    where: { id: activityId, deletedAt: null, initiatorMemberId: memberId },
    select: { id: true },
  });
  return initiator !== null;
}

async function readAuthoritativeNow(tx: PrismaTx): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ authoritativeNow: Date }>>`
    SELECT now() AS "authoritativeNow"
  `;
  const now = rows[0]?.authoritativeNow;
  if (!now) throw new BizException(BizCode.SERVICE_UNAVAILABLE);
  return now;
}

const RETRYABLE_JOB_STATUSES: ReadonlySet<string> = new Set(['partial_failed', 'failed', 'dead']);

const CANCELLABLE_JOB_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'processing',
  'partial_failed',
  'failed',
]);

const JOB_SELECT = {
  id: true,
  jobTypeCode: true,
  statusCode: true,
  total: true,
  succeeded: true,
  failed: true,
  skipped: true,
  attempts: true,
  leaseExpiresAt: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  activity: { select: { id: true, title: true, statusCode: true } },
  createdBy: { select: { member: { select: { id: true, memberNo: true, displayName: true } } } },
} satisfies Prisma.ActivityBatchJobSelect;

const ITEM_SELECT = {
  id: true,
  itemKey: true,
  statusCode: true,
  attempts: true,
  lastErrorCode: true,
  safeMessage: true,
} satisfies Prisma.ActivityBatchJobItemSelect;

type JobRow = Prisma.ActivityBatchJobGetPayload<{ select: typeof JOB_SELECT }>;

/**
 * §9.9 点名的「lease／重试**人话状态**」。
 *
 * 🔴 这里刻意只产出人话:`leaseOwner`(worker 实例标识)、`leaseExpiresAt` /
 *    `availableAt`(内部调度时刻)、`attempts` 原值一律不出网 —— 它们既是内部实现细节,
 *    也是探测 worker 节奏的边信道。
 */
function presentJob(row: JobRow, now: Date): AppMyActivityBatchJobListItemDto {
  return {
    jobId: row.id,
    jobTypeCode: row.jobTypeCode,
    activity: {
      id: row.activity.id,
      title: row.activity.title,
      statusCode: row.activity.statusCode,
    },
    createdBy:
      row.createdBy?.member == null
        ? null
        : {
            memberId: row.createdBy.member.id,
            memberNo: row.createdBy.member.memberNo,
            displayName: row.createdBy.member.displayName,
          },
    statusCode: row.statusCode,
    total: row.total,
    succeeded: row.succeeded,
    failed: row.failed,
    skipped: row.skipped,
    leaseStateText: leaseStateText(row, now),
    retryStateText: retryStateText(row),
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function leaseStateText(row: JobRow, now: Date): string {
  if (row.statusCode === 'processing') {
    // 与 activity-batch.worker.ts 的领取判据同口径同时钟:
    // `"leaseExpiresAt" IS NOT NULL AND "leaseExpiresAt" <= ${now}` ⇒ 视为已超时可回收。
    return row.leaseExpiresAt !== null && row.leaseExpiresAt.getTime() > now.getTime()
      ? '正在执行中'
      : '上一次执行已超时,系统会自动重新接手';
  }
  if (row.statusCode === 'pending') return '排队中,等待系统领取';
  return '当前没有执行中的占用';
}

function retryStateText(row: JobRow): string {
  if (row.statusCode === 'dead') return '已用尽自动重试次数,需人工重试失败项';
  if (row.statusCode === 'cancelled') return '已取消,不再自动重试';
  if (row.statusCode === 'succeeded') return '已全部成功,无需重试';
  if (row.failed > 0) return `有 ${row.failed} 项失败,可重试失败项`;
  if (row.attempts > 0) return '系统已自动重新接手过,当前无失败项';
  return '尚未发生重试';
}
