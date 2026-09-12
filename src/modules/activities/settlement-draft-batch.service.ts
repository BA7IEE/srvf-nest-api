import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { AppIdentityResolver } from '../users/app-identity.resolver';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import { getActivityOrganizationEligibility } from '../organizations/organization-publish-readiness.primitive';
import { SettlementDraftService, type SettlementDraftBatchProof } from './settlement-draft.service';
import {
  SETTLEMENT_DRAFT_GENERATE_JOB_ACTION,
  SETTLEMENT_DRAFT_GENERATE_JOB_TYPE,
} from './settlement-draft-dispatch.service';

type Tx = Prisma.TransactionClient;
export interface SettlementDraftLeaseFence {
  leaseOwner: string;
  leaseGeneration: number;
}
export class SettlementDraftLeaseLostError extends Error {}
class LegacyDraftJobError extends Error {}
interface BatchInput extends SettlementDraftLeaseFence {
  jobId: string;
  activityId: string;
  maxAttempts: number;
  retryBackoffMs: number;
}
interface Payload extends SettlementDraftBatchProof {
  actorUserId: string;
  actorMemberId: string;
}

@Injectable()
export class SettlementDraftBatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: SettlementDraftService,
    private readonly identities: AppIdentityResolver,
    private readonly authz: AuthzService,
    private readonly gate: ActivityWorkflowGate,
  ) {}

  async process(input: BatchInput): Promise<{ succeeded: boolean }> {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const job = await this.lockJob(tx, input);
          this.gate.assertV11WriteAllowed();
          const payload = this.parsePayload(job.payloadVersion, job.payload, input.activityId);
          if (job.createdByUserId !== payload.actorUserId || !job.requestHash)
            throw new LegacyDraftJobError();
          const items = await tx.activityBatchJobItem.findMany({ where: { jobId: job.id } });
          const item = items[0];
          if (
            items.length !== 1 ||
            !item ||
            item.itemKey !== 'generate' ||
            item.resourceType !== 'activity' ||
            item.resourceId !== input.activityId ||
            item.payloadHash !== job.requestHash ||
            item.statusCode === 'succeeded'
          )
            throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
          const actor = await this.authorize(tx, input.activityId, payload);
          const result = await this.drafts.generateInTransaction(
            tx,
            input.activityId,
            actor,
            { requestId: `settlement-draft-job:${job.id}`, ip: null, ua: null },
            payload,
          );
          // Re-read after the run lock and all generation work, using the same transaction.
          await this.authorize(tx, input.activityId, payload);
          await this.lockJob(tx, input);
          this.gate.assertV11WriteAllowed();
          await tx.attendanceSettlementVersion.updateMany({
            where: { id: result.settlementVersionId, operationKey: null },
            data: { operationKey: job.operationKey, requestHash: job.requestHash },
          });
          await tx.activityBatchJobItem.update({
            where: { id: item.id },
            data: {
              statusCode: 'succeeded',
              attempts: { increment: 1 },
              resultReference: result.settlementVersionId,
              lastErrorCode: null,
              safeMessage: null,
            },
          });
          await tx.activityBatchJob.update({
            where: { id: job.id },
            data: {
              settlementVersionId: result.settlementVersionId,
              statusCode: 'succeeded',
              succeeded: 1,
              failed: 0,
              skipped: 0,
              completedAt: new Date(),
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorCode: null,
            },
          });
        },
        { timeout: 30000, maxWait: 5000 },
      );
      return { succeeded: true };
    } catch (error) {
      if (error instanceof SettlementDraftLeaseLostError) throw error;
      await this.recordFailure(input, error);
      return { succeeded: false };
    }
  }

  private parsePayload(version: number, value: Prisma.JsonValue, activityId: string): Payload {
    if (version !== 2 || !value || typeof value !== 'object' || Array.isArray(value))
      throw new LegacyDraftJobError();
    const p = value;
    if (
      p.action !== SETTLEMENT_DRAFT_GENERATE_JOB_ACTION ||
      p.executionMode !== 'async' ||
      p.activityId !== activityId ||
      typeof p.actorUserId !== 'string' ||
      !p.actorUserId ||
      typeof p.actorMemberId !== 'string' ||
      !p.actorMemberId ||
      typeof p.evidenceSealId !== 'string' ||
      !p.evidenceSealId ||
      typeof p.evidenceRevision !== 'number' ||
      !Number.isSafeInteger(p.evidenceRevision) ||
      p.evidenceRevision < 0 ||
      typeof p.populationRevision !== 'number' ||
      !Number.isSafeInteger(p.populationRevision) ||
      p.populationRevision < 0 ||
      typeof p.workflowRevision !== 'number' ||
      !Number.isSafeInteger(p.workflowRevision) ||
      p.workflowRevision < 0
    )
      throw new LegacyDraftJobError();
    return {
      actorUserId: p.actorUserId,
      actorMemberId: p.actorMemberId,
      evidenceSealId: p.evidenceSealId,
      evidenceRevision: p.evidenceRevision,
      populationRevision: p.populationRevision,
      workflowRevision: p.workflowRevision,
    };
  }

  private async authorize(tx: Tx, activityId: string, payload: Payload) {
    // Lock the same identity rows used by the existing bulk handler; never cache a JWT role.
    await tx.$queryRaw`SELECT u.id FROM "User" u JOIN "Member" m ON m.id = u."memberId"
      WHERE u.id = ${payload.actorUserId} AND m.id = ${payload.actorMemberId} FOR SHARE OF u, m`;
    const actor = await loadActiveUserIdentityInTx(tx, payload.actorUserId);
    if (
      !actor ||
      actor.memberId !== payload.actorMemberId ||
      !(await this.identities.resolve(actor, tx)).canUseApp
    )
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    const activity = await tx.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: { organizationId: true },
    });
    if (
      !activity ||
      (await getActivityOrganizationEligibility(tx, activity.organizationId)) !== 'eligible'
    )
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    if (
      !(await this.authz.can(
        actor,
        'activity.settlement-generate.record',
        { type: 'activity', id: activityId },
        tx,
      ))
    )
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    return actor;
  }

  private async lockJob(tx: Tx, input: BatchInput) {
    // Both cancel and this writer take the activity root before the job. Claim is a separate short tx.
    await tx.$queryRaw`SELECT id FROM "Activity" WHERE id = ${input.activityId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "ActivityBatchJob" WHERE id = ${input.jobId} FOR UPDATE`;
    const job = await tx.activityBatchJob.findUnique({ where: { id: input.jobId } });
    const payload = job?.payload;
    if (
      !job ||
      job.activityId !== input.activityId ||
      job.jobTypeCode !== SETTLEMENT_DRAFT_GENERATE_JOB_TYPE ||
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      payload.action !== SETTLEMENT_DRAFT_GENERATE_JOB_ACTION ||
      payload.executionMode !== 'async' ||
      job.statusCode !== 'processing' ||
      job.leaseOwner !== input.leaseOwner ||
      job.leaseGeneration !== input.leaseGeneration ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt.getTime() <= Date.now() ||
      job.total !== 1
    )
      throw new SettlementDraftLeaseLostError();
    return job;
  }

  private async recordFailure(input: BatchInput, error: unknown) {
    const gateUnavailable =
      error instanceof BizException &&
      (error.biz.code === BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED.code ||
        error.biz.code === BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE.code);
    const permanent =
      error instanceof LegacyDraftJobError || (error instanceof BizException && !gateUnavailable);
    const code =
      error instanceof LegacyDraftJobError
        ? 'DraftJobProofMissing'
        : error instanceof BizException
          ? String(error.biz.code)
          : 'DraftJobTemporaryFailure';
    await this.prisma.$transaction(
      async (tx) => {
        const job = await this.lockJob(tx, input);
        const now = new Date();
        const dead = job.attempts >= input.maxAttempts;
        const terminal = permanent || dead;
        await tx.activityBatchJobItem.updateMany({
          where: { jobId: job.id, itemKey: 'generate', statusCode: { not: 'succeeded' } },
          data: {
            statusCode: terminal ? 'failed' : 'pending',
            attempts: { increment: 1 },
            lastErrorCode: code,
            safeMessage:
              error instanceof LegacyDraftJobError
                ? '旧任务缺少执行凭据，请重新发起'
                : '草稿生成未完成，请检查任务状态',
          },
        });
        await tx.activityBatchJob.update({
          where: { id: job.id },
          data: {
            statusCode: dead ? 'dead' : permanent ? 'failed' : 'pending',
            succeeded: 0,
            failed: terminal ? 1 : 0,
            skipped: 0,
            availableAt: new Date(now.getTime() + input.retryBackoffMs),
            completedAt: terminal ? now : null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastErrorCode: code,
          },
        });
      },
      { timeout: 30000, maxWait: 5000 },
    );
  }
}
