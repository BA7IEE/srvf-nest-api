import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { Prisma, Role, UserStatus } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AttendancePunchAuditRecorder } from './attendance-punch-audit-recorder';
import { AttendancePunchCommandService } from './attendance-punch-command.service';
import { normalizeAttendancePunchReason } from './attendance-punch-request-hash';

type PrismaTx = Prisma.TransactionClient;

export const ONSITE_BULK_PUNCH_JOB_TYPE = 'bulk_proxy';
export const ONSITE_BULK_PUNCH_JOB_ACTION = 'onsite_bulk_punch';
const ONSITE_BULK_PUNCH_PAYLOAD_VERSION = 1;
const ONSITE_BULK_OPERATION_KEY_PATTERN = /^[A-Za-z0-9_-]{1,96}$/u;

/**
 * AC-068 的选择条件。合同追踪矩阵 I55 判定现有 200/500 人批量上限「当前合理，保留现有正确
 * 方向」，开发文档 §11.5 又明写 item 批次「不形成业务上限」—— 两句话合起来的意思是:
 * 上限该守单请求体积，不该逼业务人员手工把一万人拆成二十次请求。所以这里加的是**第二种
 * 入口**（提交条件，服务端展开），不是把 500 改大。
 */
export interface OnsiteBulkPunchSelection {
  mode: 'session-all';
  statusCodes?: string[];
  positionId?: string;
}

export interface CreateOnsiteBulkPunchJobInput {
  activityId: string;
  sessionId: string;
  operationKey: string;
  actionCode: 'check_in' | 'check_out';
  reason: string;
  /** 与 selection 恰好二选一。 */
  participationIdentityIds?: string[];
  /** 与 participationIdentityIds 恰好二选一。 */
  selection?: OnsiteBulkPunchSelection;
  longitude: number | null;
  latitude: number | null;
  accuracy: number | null;
}

export interface OnsiteBatchJobReceipt {
  jobId: string;
  statusCode: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  replayed: boolean;
}

/** Worker claim 的 lease/fencing 值必须和每个 item 写入一起重验。 */
export interface OnsiteBulkPunchLeaseFence {
  leaseOwner: string;
  leaseGeneration: number;
}

export class OnsiteBulkPunchLeaseLostError extends Error {
  constructor() {
    super('onsite bulk punch lease lost');
    this.name = 'OnsiteBulkPunchLeaseLostError';
  }
}

export interface OnsiteBulkPunchRunResult {
  itemsProcessed: number;
  itemsSkipped: number;
  itemsFailed: number;
  statusCode: 'succeeded' | 'partial_failed' | 'failed';
}

interface OnsiteBulkPayload {
  action: typeof ONSITE_BULK_PUNCH_JOB_ACTION;
  actionCode: 'check_in' | 'check_out';
  reason: string;
  location: { longitude: string | null; latitude: string | null; accuracy: string | null };
  actorUserId: string;
  actorMemberId: string;
}

interface LockedOnsiteBulkJob {
  id: string;
  activityId: string;
  sessionId: string | null;
  jobTypeCode: string;
  statusCode: string;
  requestHash: string | null;
  payload: Prisma.JsonValue;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  leaseOwner: string | null;
  leaseGeneration: number;
  leaseExpiresAt: Date | null;
}

interface LockedOnsiteBulkItem {
  id: string;
  itemKey: string;
  statusCode: string;
  resourceType: string | null;
  resourceId: string | null;
  payloadHash: string | null;
}

type OnsiteBulkItemResult =
  | { kind: 'succeeded' }
  | { kind: 'failed' }
  | { kind: 'authorization_revoked' }
  | { kind: 'already_terminal' };

@Injectable()
export class AttendanceOnsiteBatchJobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AttendancePunchAuditRecorder,
    private readonly command: AttendancePunchCommandService,
  ) {}

  async createBulkPunchJob(
    input: CreateOnsiteBulkPunchJobInput,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<OnsiteBatchJobReceipt> {
    if (currentUser.memberId === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    if (!ONSITE_BULK_OPERATION_KEY_PATTERN.test(input.operationKey)) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    const reason = normalizeAttendancePunchReason(input.reason);
    if (reason === null) throw new BizException(BizCode.BAD_REQUEST);
    // 恰好二选一:两个都给说不清以谁为准,都不给则没有操作对象。DTO 的 @ValidateIf 只能
    // 表达「另一个缺席时我必填」,表达不了「不许都给」⇒ 这一条必须在这里兜。
    const hasIdentityIds = input.participationIdentityIds !== undefined;
    const hasSelection = input.selection !== undefined;
    if (hasIdentityIds === hasSelection) throw new BizException(BizCode.BAD_REQUEST);

    const participationIdentityIds = canonicalIdentityIds(input.participationIdentityIds ?? []);
    if (
      hasIdentityIds &&
      (participationIdentityIds.length === 0 || participationIdentityIds.length > 500)
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    const selection =
      input.selection === undefined ? undefined : canonicalSelection(input.selection);
    const requestHash = createOnsiteBulkPunchRequestHash({
      activityId: input.activityId,
      sessionId: input.sessionId,
      actorUserId: currentUser.id,
      actionCode: input.actionCode,
      reason,
      participationIdentityIds,
      selection,
      longitude: input.longitude,
      latitude: input.latitude,
      accuracy: input.accuracy,
    });
    const operationKey = `b6:bulk:${input.activityId}:${input.operationKey}`;

    return this.reserveBulkJobWithReplay(
      {
        ...input,
        reason,
        operationKey,
        participationIdentityIds,
        selection,
        requestHash,
      },
      currentUser,
      auditMeta,
    );
  }

  async getBulkPunchJob(args: {
    activityId: string;
    jobId: string;
    currentUser: CurrentUserPayload;
  }): Promise<OnsiteBatchJobReceipt> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivity(tx, args.activityId);
      await this.assertManagedAttendance(tx, args.activityId, args.currentUser);
      const job = await tx.activityBatchJob.findFirst({
        where: {
          id: args.jobId,
          activityId: args.activityId,
          jobTypeCode: ONSITE_BULK_PUNCH_JOB_TYPE,
        },
        select: {
          id: true,
          statusCode: true,
          total: true,
          succeeded: true,
          failed: true,
          skipped: true,
          payload: true,
        },
      });
      if (job === null || !isOnsiteBulkPayload(job.payload)) {
        throw new BizException(BizCode.BAD_REQUEST);
      }
      return receiptFromJob(job, false);
    });
  }

  private async reserveBulkJobWithReplay(
    input: CreateOnsiteBulkPunchJobInput & { requestHash: string },
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<OnsiteBatchJobReceipt> {
    try {
      return await this.reserveBulkJob(input, currentUser, auditMeta);
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      return await this.reserveBulkJob(input, currentUser, auditMeta);
    }
  }

  private async reserveBulkJob(
    input: CreateOnsiteBulkPunchJobInput & { requestHash: string },
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<OnsiteBatchJobReceipt> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivity(tx, input.activityId);
      await this.assertManagedAttendance(tx, input.activityId, currentUser);

      const existing = await tx.activityBatchJob.findUnique({
        where: { operationKey: input.operationKey },
        select: {
          id: true,
          activityId: true,
          sessionId: true,
          jobTypeCode: true,
          requestHash: true,
          statusCode: true,
          total: true,
          succeeded: true,
          failed: true,
          skipped: true,
          payload: true,
        },
      });
      if (existing !== null) {
        if (
          existing.activityId !== input.activityId ||
          existing.sessionId !== input.sessionId ||
          existing.jobTypeCode !== ONSITE_BULK_PUNCH_JOB_TYPE ||
          existing.requestHash !== input.requestHash ||
          !isOnsiteBulkPayload(existing.payload)
        ) {
          throw new BizException(BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT);
        }
        return receiptFromJob(existing, true);
      }

      const explicitIdentityIds = input.participationIdentityIds ?? [];
      if (input.selection === undefined) {
        const identities = await tx.activityParticipationIdentity.findMany({
          where: {
            activityId: input.activityId,
            sessionId: input.sessionId,
            id: { in: explicitIdentityIds },
          },
          select: { id: true },
        });
        if (identities.length !== explicitIdentityIds.length) {
          throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
        }
      }

      const payload: Prisma.InputJsonObject = {
        action: ONSITE_BULK_PUNCH_JOB_ACTION,
        actionCode: input.actionCode,
        reason: input.reason,
        location: canonicalLocation(input.longitude, input.latitude, input.accuracy),
        actorUserId: currentUser.id,
        actorMemberId: currentUser.memberId!,
      };
      const job = await tx.activityBatchJob.create({
        data: {
          jobTypeCode: ONSITE_BULK_PUNCH_JOB_TYPE,
          activityId: input.activityId,
          sessionId: input.sessionId,
          statusCode: 'pending',
          operationKey: input.operationKey,
          requestHash: input.requestHash,
          payloadVersion: ONSITE_BULK_PUNCH_PAYLOAD_VERSION,
          payload,
          // 条件式入队此刻还不知道命中多少人(要等 INSERT ... SELECT 回报行数)⇒ 先落 0,
          // 展开完再写真值;两步在同一事务里,外部永远看不到 total=0 的中间态。
          total: input.selection === undefined ? explicitIdentityIds.length : 0,
          // 写与判同源:`ActivityBatchWorker.claimJob` 用应用时钟比 `availableAt`,
          // 故入队显式写应用时钟,不吃列上的 `@default(now())`(数据库时钟)。
          availableAt: new Date(),
          createdByUserId: currentUser.id,
        },
        select: {
          id: true,
          statusCode: true,
          total: true,
          succeeded: true,
          failed: true,
          skipped: true,
        },
      });

      const total =
        input.selection === undefined
          ? await this.createItemsFromIdentityIds(tx, job.id, input)
          : await this.createItemsFromSelection(tx, job.id, input, input.selection);
      const reserved = total === job.total ? job : { ...job, total };
      if (total !== job.total) {
        await tx.activityBatchJob.update({ where: { id: job.id }, data: { total } });
      }

      await this.audit.logOnsiteBatchJob({
        operation: 'attendance-bulk.create',
        activityId: input.activityId,
        sessionId: input.sessionId,
        jobId: job.id,
        total: reserved.total,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        auditMeta,
        tx,
      });
      return receiptFromJob(reserved, false);
    });
  }

  /** 显式 id 列表入队:形状与改造前逐字一致(≤500 条,bind 数随条数走,可接受)。 */
  private async createItemsFromIdentityIds(
    tx: PrismaTx,
    jobId: string,
    input: CreateOnsiteBulkPunchJobInput & { requestHash: string },
  ): Promise<number> {
    const ids = input.participationIdentityIds ?? [];
    await tx.activityBatchJobItem.createMany({
      data: ids.map((participationIdentityId) => ({
        jobId,
        itemKey: `identity:${participationIdentityId}`,
        statusCode: 'pending',
        resourceType: 'activity_participation_identity',
        resourceId: participationIdentityId,
        payloadHash: input.requestHash,
      })),
    });
    return ids.length;
  }

  /**
   * AC-068 条件式入队 —— 把「全选本场次」在 **SQL 里**展开成任务项。
   *
   * 🔴 为什么必须是 `INSERT ... SELECT` 而不是「先查 id 再 createMany」:
   *   1. **bind 参数恒为常量**(3 至 5 个,与人数无关)。本仓已实测 Prisma bind 上限 32767,
   *      逐行 `VALUES` 每项 6 参数在 ~5461 项处确定性失败 —— 10000 人必炸。
   *      同一条理由已经写在 `ledger-preparation.service.ts` 的 `writeSettlementDays` 上。
   *   2. **一个 identity id 都不进应用内存**,满足开发文档 §11.4「10000 人逐人页每页只查当前页,
   *      不加载整场 identity ids 到应用内存」。
   *   3. **往返次数恒为 1**,持有 Activity 咨询锁的时长只随一次批量插入走,不随往返次数放大。
   *
   * `gen_random_uuid()::text` 生成主键:本仓既有 raw INSERT(`ParticipantSettlementDay` /
   * `ParticipationLedgerEntry`)已是同一写法,不是本刀新开的口径。
   *
   * WHERE 里的 activityId + sessionId 同时钉死 ⇒ 与显式 id 入口那次「必须全部属于本场次」
   * 的校验等价,而且是 by construction 的:选择条件根本无法指向别的场次。
   */
  private async createItemsFromSelection(
    tx: PrismaTx,
    jobId: string,
    input: CreateOnsiteBulkPunchJobInput & { requestHash: string },
    selection: OnsiteBulkPunchSelection,
  ): Promise<number> {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`i."activityId" = ${input.activityId}`,
      Prisma.sql`i."sessionId" = ${input.sessionId}`,
    ];
    if (selection.statusCodes !== undefined) {
      conditions.push(Prisma.sql`i."currentStatusCode" = ANY(${selection.statusCodes}::text[])`);
    }
    if (selection.positionId !== undefined) {
      conditions.push(Prisma.sql`i."currentPositionId" = ${selection.positionId}`);
    }
    const inserted = await tx.$executeRaw`
      INSERT INTO "ActivityBatchJobItem" (
        "id", "createdAt", "updatedAt", "jobId", "itemKey", "statusCode",
        "resourceType", "resourceId", "payloadHash"
      )
      SELECT gen_random_uuid()::text, NOW(), NOW(), ${jobId}, 'identity:' || i."id", 'pending',
             'activity_participation_identity', i."id", ${input.requestHash}
      FROM "ActivityParticipationIdentity" i
      WHERE ${Prisma.join(conditions, ' AND ')}
    `;
    // 命中 0 人 = 没有操作对象,与显式入口的 @ArrayMinSize(1) 同义;抛在事务里,job 一并回滚。
    if (inserted === 0) throw new BizException(BizCode.BAD_REQUEST);
    return inserted;
  }

  /**
   * 只由拿到 job lease 的既有 ActivityBatchWorker 调用。
   *
   * 每个 item 都独占一个短 Activity 根事务：PunchEvent、证据版本、服务段、审计与 item
   * 的成功指针一起提交；业务失败通过 SAVEPOINT 回滚上述写入后才记 item failed。这样一项
   * 的失败绝不把半个 PunchEvent 留给下一项，且 worker 进程崩溃后只会重试仍为 pending 的项。
   */
  async processBulkPunchJob(input: {
    jobId: string;
    activityId: string;
    fence: OnsiteBulkPunchLeaseFence;
  }): Promise<OnsiteBulkPunchRunResult> {
    const candidates = await this.prisma.activityBatchJobItem.findMany({
      where: { jobId: input.jobId, statusCode: 'pending' },
      select: { id: true },
      orderBy: [{ itemKey: 'asc' }, { id: 'asc' }],
    });
    let itemsProcessed = 0;
    let itemsSkipped = 0;
    let itemsFailed = 0;

    for (const candidate of candidates) {
      const result = await this.processBulkPunchItem({ ...input, itemId: candidate.id });
      if (result.kind === 'succeeded') {
        itemsProcessed += 1;
        continue;
      }
      if (result.kind === 'failed') {
        itemsFailed += 1;
        continue;
      }
      if (result.kind === 'authorization_revoked') {
        itemsSkipped += 1;
        itemsSkipped += await this.skipPendingBulkItems(input);
        break;
      }
    }

    const finalized = await this.finalizeBulkPunchJob(input);
    return {
      itemsProcessed,
      itemsSkipped,
      itemsFailed,
      statusCode: finalized.statusCode,
    };
  }

  private async processBulkPunchItem(input: {
    jobId: string;
    activityId: string;
    itemId: string;
    fence: OnsiteBulkPunchLeaseFence;
  }): Promise<OnsiteBulkItemResult> {
    return this.prisma.$transaction(async (tx) => {
      // Canonical lock order: Activity root → durable job/fence → actor/responsibility → item →
      // unified PunchCommand's session/identity/event chain. The command re-locks Activity
      // reentrantly, never introducing a second occupied/segment algorithm.
      const activity = await this.lockActivityRoot(tx, input.activityId);
      const now = await this.readAuthoritativeNow(tx);
      const job = await this.lockAndVerifyBulkJob(tx, input, now);
      const item = await this.lockBulkItem(tx, input.itemId, job.id);
      if (item.statusCode !== 'pending') return { kind: 'already_terminal' };

      await tx.$executeRaw(Prisma.sql`SAVEPOINT onsite_bulk_punch_item`);
      let savepointOpen = true;
      try {
        if (activity.deletedAt !== null) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
        if (activity.statusCode !== 'published') {
          throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
        }
        const payload = requireOnsiteBulkPayload(job.payload);
        this.assertBulkItemInvariant(job, item);
        const actor = await this.lockActiveActor(tx, payload.actorUserId, payload.actorMemberId);
        if (
          actor === null ||
          !(await this.hasManagedAttendance(tx, job.activityId, actor.memberId!))
        ) {
          await tx.$executeRaw(Prisma.sql`ROLLBACK TO SAVEPOINT onsite_bulk_punch_item`);
          await tx.$executeRaw(Prisma.sql`RELEASE SAVEPOINT onsite_bulk_punch_item`);
          savepointOpen = false;
          await this.markBulkItemSkipped(tx, job, item, input.fence);
          return { kind: 'authorization_revoked' };
        }
        if (job.sessionId === null) this.failClosed();
        const location = parseOnsiteBulkLocation(payload.location);
        const receipt = await this.command.managedPunchWithinTransaction(tx, {
          activityId: job.activityId,
          sessionId: job.sessionId,
          participationIdentityId: item.resourceId,
          memberCredential: null,
          actionCode: payload.actionCode,
          sourceCode: 'bulk',
          eventKey: `attendance-bulk:${job.id}:${item.itemKey}`,
          reason: payload.reason,
          deviceId: null,
          longitude: location.longitude,
          latitude: location.latitude,
          accuracy: location.accuracy,
          batchJobItemId: item.id,
          currentUser: actor,
          auditMeta: {
            requestId: `activity-batch-worker:${job.id}:${item.id}`,
            ip: null,
            ua: null,
          },
        });
        await tx.$executeRaw(Prisma.sql`RELEASE SAVEPOINT onsite_bulk_punch_item`);
        savepointOpen = false;
        await this.markBulkItemSucceeded(tx, job, item, input.fence, receipt.eventId);
        return { kind: 'succeeded' };
      } catch (error) {
        if (savepointOpen) {
          await tx.$executeRaw(Prisma.sql`ROLLBACK TO SAVEPOINT onsite_bulk_punch_item`);
          await tx.$executeRaw(Prisma.sql`RELEASE SAVEPOINT onsite_bulk_punch_item`);
          savepointOpen = false;
        }
        if (error instanceof BizException) {
          await this.markBulkItemFailed(tx, job, item, input.fence, error);
          return { kind: 'failed' };
        }
        throw error;
      }
    });
  }

  private async skipPendingBulkItems(input: {
    jobId: string;
    activityId: string;
    fence: OnsiteBulkPunchLeaseFence;
  }): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivityRoot(tx, input.activityId);
      const now = await this.readAuthoritativeNow(tx);
      const job = await this.lockAndVerifyBulkJob(tx, input, now);
      const skipped = await tx.activityBatchJobItem.updateMany({
        where: { jobId: job.id, statusCode: 'pending' },
        data: {
          statusCode: 'skipped',
          attempts: { increment: 1 },
          lastErrorCode: `BizException:${BizCode.RBAC_FORBIDDEN.code}`,
          safeMessage: BizCode.RBAC_FORBIDDEN.message,
        },
      });
      if (skipped.count === 0) return 0;
      await this.incrementBulkJobCounter(tx, job, input.fence, 'skipped', skipped.count);
      return skipped.count;
    });
  }

  private async finalizeBulkPunchJob(input: {
    jobId: string;
    activityId: string;
    fence: OnsiteBulkPunchLeaseFence;
  }): Promise<Pick<OnsiteBulkPunchRunResult, 'statusCode'>> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivityRoot(tx, input.activityId);
      const now = await this.readAuthoritativeNow(tx);
      const job = await this.lockAndVerifyBulkJob(tx, input, now);
      const items = await tx.activityBatchJobItem.findMany({
        where: { jobId: job.id },
        select: { statusCode: true },
        orderBy: { itemKey: 'asc' },
      });
      if (items.length !== job.total) this.failClosed();
      const succeeded = items.filter((item) => item.statusCode === 'succeeded').length;
      const failed = items.filter((item) => item.statusCode === 'failed').length;
      const skipped = items.filter((item) => item.statusCode === 'skipped').length;
      if (succeeded + failed + skipped !== job.total) this.failClosed();
      if (job.succeeded !== succeeded || job.failed !== failed || job.skipped !== skipped) {
        this.failClosed();
      }
      const statusCode: OnsiteBulkPunchRunResult['statusCode'] =
        succeeded === job.total ? 'succeeded' : succeeded === 0 ? 'failed' : 'partial_failed';
      const updated = await tx.activityBatchJob.updateMany({
        where: {
          id: job.id,
          statusCode: 'processing',
          leaseOwner: input.fence.leaseOwner,
          leaseGeneration: input.fence.leaseGeneration,
        },
        data: {
          statusCode,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          lastErrorCode: null,
        },
      });
      if (updated.count !== 1) throw new OnsiteBulkPunchLeaseLostError();
      return { statusCode };
    });
  }

  private async lockActivityRoot(
    tx: PrismaTx,
    activityId: string,
  ): Promise<{ id: string; statusCode: string; deletedAt: Date | null }> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; statusCode: string; deletedAt: Date | null }>
    >(
      Prisma.sql`
        SELECT "id", "statusCode", "deletedAt"
        FROM "Activity"
        WHERE "id" = ${activityId}
        FOR UPDATE
      `,
    );
    if (rows.length !== 1 || rows[0] === undefined) this.failClosed();
    return rows[0];
  }

  private async lockAndVerifyBulkJob(
    tx: PrismaTx,
    input: { jobId: string; activityId: string; fence: OnsiteBulkPunchLeaseFence },
    now: Date,
  ): Promise<LockedOnsiteBulkJob> {
    const rows = await tx.$queryRaw<LockedOnsiteBulkJob[]>(Prisma.sql`
      SELECT
        "id", "activityId", "sessionId", "jobTypeCode", "statusCode", "requestHash", "payload",
        "total", "succeeded", "failed", "skipped", "leaseOwner", "leaseGeneration", "leaseExpiresAt"
      FROM "ActivityBatchJob"
      WHERE "id" = ${input.jobId}
      FOR UPDATE
    `);
    const job = rows[0];
    if (
      rows.length !== 1 ||
      job === undefined ||
      job.activityId !== input.activityId ||
      job.jobTypeCode !== ONSITE_BULK_PUNCH_JOB_TYPE ||
      job.statusCode !== 'processing' ||
      job.leaseOwner !== input.fence.leaseOwner ||
      job.leaseGeneration !== input.fence.leaseGeneration ||
      job.leaseExpiresAt === null ||
      job.leaseExpiresAt.getTime() <= now.getTime()
    ) {
      throw new OnsiteBulkPunchLeaseLostError();
    }
    if (job.sessionId === null || !isOnsiteBulkPayload(job.payload)) this.failClosed();
    return job;
  }

  private async lockBulkItem(
    tx: PrismaTx,
    itemId: string,
    jobId: string,
  ): Promise<LockedOnsiteBulkItem> {
    const rows = await tx.$queryRaw<LockedOnsiteBulkItem[]>(Prisma.sql`
      SELECT "id", "itemKey", "statusCode", "resourceType", "resourceId", "payloadHash"
      FROM "ActivityBatchJobItem"
      WHERE "id" = ${itemId} AND "jobId" = ${jobId}
      FOR UPDATE
    `);
    if (rows.length !== 1 || rows[0] === undefined) this.failClosed();
    return rows[0];
  }

  private async lockActiveActor(
    tx: PrismaTx,
    userId: string,
    memberId: string,
  ): Promise<CurrentUserPayload | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; username: string; role: Role; status: UserStatus; memberId: string }>
    >(Prisma.sql`
      SELECT u."id", u."username", u."role", u."status", u."memberId"
      FROM "User" u
      INNER JOIN "Member" m ON m."id" = u."memberId"
      WHERE u."id" = ${userId}
        AND u."memberId" = ${memberId}
        AND u."status" = 'ACTIVE'
        AND u."deletedAt" IS NULL
        AND m."status" = 'ACTIVE'
        AND m."deletedAt" IS NULL
      FOR SHARE OF u, m
    `);
    const actor = rows[0];
    if (rows.length !== 1 || actor === undefined) return null;
    return actor;
  }

  private async hasManagedAttendance(
    tx: PrismaTx,
    activityId: string,
    memberId: string,
  ): Promise<boolean> {
    const assignments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "activity_responsibility_assignments"
      WHERE "activityId" = ${activityId}
        AND "memberId" = ${memberId}
        AND "status" = 'active'
        AND "canManageAttendance" = true
      ORDER BY "id" ASC
      FOR SHARE
    `);
    return assignments.length > 0;
  }

  private assertBulkItemInvariant(job: LockedOnsiteBulkJob, item: LockedOnsiteBulkItem): void {
    if (
      job.requestHash === null ||
      item.resourceType !== 'activity_participation_identity' ||
      item.resourceId === null ||
      item.itemKey !== `identity:${item.resourceId}` ||
      item.payloadHash !== job.requestHash
    ) {
      this.failClosed();
    }
  }

  private async markBulkItemSucceeded(
    tx: PrismaTx,
    job: LockedOnsiteBulkJob,
    item: LockedOnsiteBulkItem,
    fence: OnsiteBulkPunchLeaseFence,
    eventId: string,
  ): Promise<void> {
    const updated = await tx.activityBatchJobItem.updateMany({
      where: { id: item.id, jobId: job.id, statusCode: 'pending' },
      data: {
        statusCode: 'succeeded',
        attempts: { increment: 1 },
        resultReference: eventId,
        lastErrorCode: null,
        safeMessage: null,
      },
    });
    if (updated.count !== 1) throw new OnsiteBulkPunchLeaseLostError();
    await this.incrementBulkJobCounter(tx, job, fence, 'succeeded', 1);
  }

  private async markBulkItemFailed(
    tx: PrismaTx,
    job: LockedOnsiteBulkJob,
    item: LockedOnsiteBulkItem,
    fence: OnsiteBulkPunchLeaseFence,
    error: BizException,
  ): Promise<void> {
    const updated = await tx.activityBatchJobItem.updateMany({
      where: { id: item.id, jobId: job.id, statusCode: 'pending' },
      data: {
        statusCode: 'failed',
        attempts: { increment: 1 },
        lastErrorCode: `BizException:${error.biz.code}`,
        safeMessage: error.biz.message,
      },
    });
    if (updated.count !== 1) throw new OnsiteBulkPunchLeaseLostError();
    await this.incrementBulkJobCounter(tx, job, fence, 'failed', 1);
  }

  private async markBulkItemSkipped(
    tx: PrismaTx,
    job: LockedOnsiteBulkJob,
    item: LockedOnsiteBulkItem,
    fence: OnsiteBulkPunchLeaseFence,
  ): Promise<void> {
    const updated = await tx.activityBatchJobItem.updateMany({
      where: { id: item.id, jobId: job.id, statusCode: 'pending' },
      data: {
        statusCode: 'skipped',
        attempts: { increment: 1 },
        lastErrorCode: `BizException:${BizCode.RBAC_FORBIDDEN.code}`,
        safeMessage: BizCode.RBAC_FORBIDDEN.message,
      },
    });
    if (updated.count !== 1) throw new OnsiteBulkPunchLeaseLostError();
    await this.incrementBulkJobCounter(tx, job, fence, 'skipped', 1);
  }

  private async incrementBulkJobCounter(
    tx: PrismaTx,
    job: LockedOnsiteBulkJob,
    fence: OnsiteBulkPunchLeaseFence,
    counter: 'succeeded' | 'failed' | 'skipped',
    amount: number,
  ): Promise<void> {
    const data: Prisma.ActivityBatchJobUpdateManyMutationInput =
      counter === 'succeeded'
        ? { succeeded: { increment: amount } }
        : counter === 'failed'
          ? { failed: { increment: amount } }
          : { skipped: { increment: amount } };
    const updated = await tx.activityBatchJob.updateMany({
      where: {
        id: job.id,
        statusCode: 'processing',
        leaseOwner: fence.leaseOwner,
        leaseGeneration: fence.leaseGeneration,
      },
      data,
    });
    if (updated.count !== 1) throw new OnsiteBulkPunchLeaseLostError();
  }

  private async readAuthoritativeNow(tx: PrismaTx): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ authoritativeNow: Date }>>`
      SELECT now() AS "authoritativeNow"
    `;
    const now = rows[0]?.authoritativeNow;
    if (!now) this.failClosed();
    return now;
  }

  private failClosed(): never {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }

  private async lockActivity(tx: PrismaTx, activityId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string; statusCode: string }>>(Prisma.sql`
      SELECT "id", "statusCode" FROM "Activity"
      WHERE "id" = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (rows.length !== 1) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    if (rows[0]?.statusCode !== 'published') {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
  }

  private async assertManagedAttendance(
    tx: PrismaTx,
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<void> {
    if (currentUser.memberId === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
    const assignments = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "activity_responsibility_assignments"
      WHERE "activityId" = ${activityId}
        AND "memberId" = ${currentUser.memberId}
        AND "status" = 'active'
        AND "canManageAttendance" = true
      ORDER BY "id" ASC
      FOR SHARE
    `);
    if (assignments.length === 0) throw new BizException(BizCode.RBAC_FORBIDDEN);
  }
}

function canonicalIdentityIds(ids: string[]): string[] {
  return [...new Set(ids)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
}

function decimal(value: number | null, digits: number): string | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) throw new BizException(BizCode.BAD_REQUEST);
  return value.toFixed(digits);
}

function canonicalLocation(
  longitude: number | null,
  latitude: number | null,
  accuracy: number | null,
): OnsiteBulkPayload['location'] {
  return {
    longitude: decimal(longitude, 7),
    latitude: decimal(latitude, 7),
    accuracy: decimal(accuracy, 2),
  };
}

/** 条件的规范化:同一组条件不论客户端怎么排列/重复,都必须算出同一个 requestHash。 */
function canonicalSelection(selection: OnsiteBulkPunchSelection): OnsiteBulkPunchSelection {
  return {
    mode: selection.mode,
    ...(selection.statusCodes === undefined
      ? {}
      : { statusCodes: [...new Set(selection.statusCodes)].sort() }),
    ...(selection.positionId === undefined ? {} : { positionId: selection.positionId }),
  };
}

function createOnsiteBulkPunchRequestHash(args: {
  activityId: string;
  sessionId: string;
  actorUserId: string;
  actionCode: 'check_in' | 'check_out';
  reason: string;
  participationIdentityIds: string[];
  selection?: OnsiteBulkPunchSelection;
  longitude: number | null;
  latitude: number | null;
  accuracy: number | null;
}): string {
  const payload = JSON.stringify({
    v: 'attendance-onsite-bulk-punch/v1',
    activityId: args.activityId,
    sessionId: args.sessionId,
    actorUserId: args.actorUserId,
    actionCode: args.actionCode,
    reason: args.reason,
    participationIdentityIds: args.participationIdentityIds,
    location: canonicalLocation(args.longitude, args.latitude, args.accuracy),
    // ⚠️ 只有走条件入口时才多这一个键 —— 显式 id 入口算出的哈希必须与改造前**逐字节相同**,
    // 否则改造前入队、改造后重放同一个 operationKey 会被判成 IDEMPOTENCY_CONFLICT。
    ...(args.selection === undefined ? {} : { selection: args.selection }),
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function isOnsiteBulkPayload(
  value: Prisma.JsonValue,
): value is Prisma.JsonObject & OnsiteBulkPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const payload = value;
  const location = payload['location'];
  if (typeof location !== 'object' || location === null || Array.isArray(location)) return false;
  const canonicalLocation = location;
  return (
    payload['action'] === ONSITE_BULK_PUNCH_JOB_ACTION &&
    (payload['actionCode'] === 'check_in' || payload['actionCode'] === 'check_out') &&
    typeof payload['reason'] === 'string' &&
    typeof payload['actorUserId'] === 'string' &&
    typeof payload['actorMemberId'] === 'string' &&
    isCanonicalLocationValue(canonicalLocation['longitude']) &&
    isCanonicalLocationValue(canonicalLocation['latitude']) &&
    isCanonicalLocationValue(canonicalLocation['accuracy'])
  );
}

function requireOnsiteBulkPayload(value: Prisma.JsonValue): OnsiteBulkPayload {
  if (!isOnsiteBulkPayload(value)) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  return value;
}

function parseOnsiteBulkLocation(location: OnsiteBulkPayload['location']): {
  longitude: number | null;
  latitude: number | null;
  accuracy: number | null;
} {
  return {
    longitude: parseCanonicalLocationValue(location.longitude),
    latitude: parseCanonicalLocationValue(location.latitude),
    accuracy: parseCanonicalLocationValue(location.accuracy),
  };
}

function isCanonicalLocationValue(value: Prisma.JsonValue | undefined): value is string | null {
  if (value === null) return true;
  return typeof value === 'string' && /^-?\d+\.\d+$/u.test(value) && Number.isFinite(Number(value));
}

function parseCanonicalLocationValue(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BizException(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
  return parsed;
}

function receiptFromJob(
  job: {
    id: string;
    statusCode: string;
    total: number;
    succeeded: number;
    failed: number;
    skipped: number;
  },
  replayed: boolean,
): OnsiteBatchJobReceipt {
  return {
    jobId: job.id,
    statusCode: job.statusCode,
    total: job.total,
    succeeded: job.succeeded,
    failed: job.failed,
    skipped: job.skipped,
    replayed,
  };
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
