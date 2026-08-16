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

export interface CreateOnsiteBulkPunchJobInput {
  activityId: string;
  sessionId: string;
  operationKey: string;
  actionCode: 'check_in' | 'check_out';
  reason: string;
  participationIdentityIds: string[];
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
    const participationIdentityIds = canonicalIdentityIds(input.participationIdentityIds);
    if (participationIdentityIds.length === 0 || participationIdentityIds.length > 500) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    const requestHash = createOnsiteBulkPunchRequestHash({
      activityId: input.activityId,
      sessionId: input.sessionId,
      actorUserId: currentUser.id,
      actionCode: input.actionCode,
      reason,
      participationIdentityIds,
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

      const identities = await tx.activityParticipationIdentity.findMany({
        where: {
          activityId: input.activityId,
          sessionId: input.sessionId,
          id: { in: input.participationIdentityIds },
        },
        select: { id: true },
      });
      if (identities.length !== input.participationIdentityIds.length) {
        throw new BizException(BizCode.ATTENDANCE_REGISTRATION_INVALID);
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
          total: input.participationIdentityIds.length,
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
      await tx.activityBatchJobItem.createMany({
        data: input.participationIdentityIds.map((participationIdentityId) => ({
          jobId: job.id,
          itemKey: `identity:${participationIdentityId}`,
          statusCode: 'pending',
          resourceType: 'activity_participation_identity',
          resourceId: participationIdentityId,
          payloadHash: input.requestHash,
        })),
      });
      await this.audit.logOnsiteBatchJob({
        operation: 'attendance-bulk.create',
        activityId: input.activityId,
        sessionId: input.sessionId,
        jobId: job.id,
        total: job.total,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        auditMeta,
        tx,
      });
      return receiptFromJob(job, false);
    });
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

function createOnsiteBulkPunchRequestHash(args: {
  activityId: string;
  sessionId: string;
  actorUserId: string;
  actionCode: 'check_in' | 'check_out';
  reason: string;
  participationIdentityIds: string[];
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
