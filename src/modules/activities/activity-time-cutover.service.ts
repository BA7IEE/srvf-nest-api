import { Injectable } from '@nestjs/common';
import { Prisma, type ActivityTimeCutoverReceipt } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { ActivityTimeCutoverAuditRecorder } from './activity-time-cutover-audit-recorder';
import {
  ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
  ActivityTimeCutoverCommand,
  type ActivityTimeCutoverReceiptResult,
  type ActivityTimeCutoverRequest,
  normalizeActivityTimeCutoverRequest,
  verifyActivityTimeCutoverReceipt,
} from './activity-time-cutover-command';

export interface ActivityTimeCutoverCheckResult {
  schemaVersion: 1;
  status: 'ready' | 'blocked' | 'already_cut_over';
  v11Enabled: boolean;
  maintenanceWindowOpen: boolean;
  preparingOrReadyBatchCount: number;
  pendingOrProcessingPrepareJobCount: number;
  cutoverReceipt: ActivityTimeCutoverReceiptResult | null;
  blockers: string[];
}

@Injectable()
export class ActivityTimeCutoverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gate: ActivityWorkflowGate,
    private readonly command: ActivityTimeCutoverCommand,
    private readonly audit: ActivityTimeCutoverAuditRecorder,
  ) {}

  async check(): Promise<ActivityTimeCutoverCheckResult> {
    const snapshot = await this.prisma.$transaction(
      async (tx) => {
        const [receipt, batchCount, jobCount] = await Promise.all([
          tx.activityTimeCutoverReceipt.findUnique({
            where: { id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID },
          }),
          tx.ledgerPostingBatch.count({
            where: { statusCode: { in: ['preparing', 'ready'] } },
          }),
          tx.activityBatchJob.count({
            where: {
              jobTypeCode: 'settlement_prepare',
              statusCode: { in: ['pending', 'processing'] },
            },
          }),
        ]);
        return { receipt, batchCount, jobCount };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 2_000,
        timeout: 5_000,
      },
    );
    const v11Enabled = this.gate.isV11Enabled();
    const maintenanceWindowOpen = this.gate.isReadonlyMaintenance();
    const blockers: string[] = [];
    if (!v11Enabled) blockers.push('v11_not_enabled');
    if (!maintenanceWindowOpen) blockers.push('readonly_maintenance_required');
    if (snapshot.batchCount > 0) blockers.push('posting_batches_in_flight');
    if (snapshot.jobCount > 0) blockers.push('settlement_prepare_jobs_in_flight');
    const cutoverReceipt = snapshot.receipt
      ? verifyActivityTimeCutoverReceipt(snapshot.receipt)
      : null;
    return {
      schemaVersion: 1,
      status: cutoverReceipt ? 'already_cut_over' : blockers.length === 0 ? 'ready' : 'blocked',
      v11Enabled,
      maintenanceWindowOpen,
      preparingOrReadyBatchCount: snapshot.batchCount,
      pendingOrProcessingPrepareJobCount: snapshot.jobCount,
      cutoverReceipt,
      blockers,
    };
  }

  async execute(args: {
    currentUser: CurrentUserPayload;
    request: ActivityTimeCutoverRequest;
    auditMeta: AuditMeta;
  }): Promise<ActivityTimeCutoverReceiptResult> {
    const input = normalizeActivityTimeCutoverRequest(args.currentUser.id, args.request);
    this.assertWindow();
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Acquire the same exclusive domain as the DB trigger before reading
          // actor/grants or the singleton.  The trigger reacquisition is
          // transaction-reentrant and remains the direct-SQL safety boundary.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(atc_lock_key())::text`;
          this.assertWindow();
          const actor = await this.command.lockAndAuthorize(tx, args.currentUser);
          const prior = await tx.activityTimeCutoverReceipt.findUnique({
            where: { id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID },
          });
          if (prior) return this.replay(prior, input);

          const rows = await tx.$queryRaw<ActivityTimeCutoverReceipt[]>`
            INSERT INTO "ActivityTimeCutoverReceipt" (
              "id", "operationKey", "requestHash", "deployedMainSha",
              "evidenceBundleHash", "actorUserId", "contentHash"
            ) VALUES (
              ${ACTIVITY_TIME_CUTOVER_RECEIPT_ID}, ${input.operationKey}, ${input.requestHash},
              ${input.deployedMainSha}, ${input.evidenceBundleHash}, ${actor.id}, ${'0'.repeat(64)}
            )
            RETURNING *
          `;
          if (rows.length !== 1) {
            throw new BizException(BizCode.ACTIVITY_TIME_CUTOVER_RECEIPT_INVALID);
          }
          const result = verifyActivityTimeCutoverReceipt(rows[0]);
          await this.audit.log(tx, actor, args.auditMeta, result);
          return result;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 2_000,
          timeout: 7_000,
        },
      );
    } catch (error) {
      this.rethrowConstraint(error);
    }
  }

  private assertWindow(): void {
    if (!this.gate.isV11Enabled() || !this.gate.isReadonlyMaintenance()) {
      throw new BizException(BizCode.ACTIVITY_TIME_CUTOVER_NOT_READY);
    }
  }

  private replay(
    receipt: ActivityTimeCutoverReceipt,
    input: ReturnType<typeof normalizeActivityTimeCutoverRequest>,
  ): ActivityTimeCutoverReceiptResult {
    if (
      receipt.operationKey !== input.operationKey ||
      receipt.requestHash !== input.requestHash ||
      receipt.deployedMainSha !== input.deployedMainSha ||
      receipt.evidenceBundleHash !== input.evidenceBundleHash ||
      receipt.actorUserId !== input.actorUserId
    ) {
      throw new BizException(BizCode.ACTIVITY_TIME_CUTOVER_COMMAND_CONFLICT);
    }
    return { ...verifyActivityTimeCutoverReceipt(receipt), replayed: true };
  }

  private rethrowConstraint(error: unknown): never {
    if (error instanceof BizException) throw error;
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) throw error;
    if (!['P2002', 'P2003', 'P2004', 'P2010'].includes(error.code)) throw error;
    const details = [
      error.message,
      error.meta?.constraint,
      error.meta?.field_name,
      error.meta?.database_error,
      error.meta?.message,
      error.meta?.target,
    ]
      .filter((value) => typeof value === 'string')
      .join(' ');
    if (
      /atcr_open_(batch|job)_guard|atc_post_cutover_manifest_guard|activity time cutover has unfinished (posting batches|settlement prepare jobs)|post-cutover ordinary batch has no classified root manifest/u.test(
        details,
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_TIME_CUTOVER_NOT_READY);
    }
    if (
      /atcr_singleton_guard|atcr_operation_key|activity time cutover receipt already exists/u.test(
        details,
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_TIME_CUTOVER_COMMAND_CONFLICT);
    }
    throw new BizException(BizCode.ACTIVITY_TIME_CUTOVER_RECEIPT_INVALID);
  }
}
