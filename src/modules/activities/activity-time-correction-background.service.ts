import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import { Injectable } from '@nestjs/common';
import { HumanCorrectionItemAuthority } from './human-correction-item-authority';
import { Prisma, type ActivityBatchJob } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { loadActiveUserIdentityInTx } from '../users/user-active-identity.query';
import { ActivityTimeCorrectionAccessService } from './activity-time-correction-access.service';
import { ActivityTimeCorrectionCommandService } from './activity-time-correction-command.service';
import {
  HUMAN_CORRECTION_JOB_TYPE,
  HumanCorrectionLeaseLostError,
  humanCorrectionJobHash,
  lockHumanCorrectionJobRow,
  HumanCorrectionAuthorityUnavailableError,
  type HumanCorrectionIntent,
  type HumanCorrectionJobClaim,
  parseHumanCorrectionJobPayload,
  type HumanCorrectionJobFence,
  type HumanCorrectionJobPayload,
} from './correction-background-job';
import { parseCorrectionChangeSet } from './correction-change-set';
import type { AppCommitActivityTimeCorrectionDto } from './dto/app/app-activity-time-correction.dto';
import type { AppActivityTimeCorrectionJobDto } from './dto/app/app-activity-time-correction-job.dto';

type Tx = Prisma.TransactionClient;
const JOB_SELECT = {
  id: true,
  statusCode: true,
  payload: true,
  payloadVersion: true,
  requestHash: true,
  jobTypeCode: true,
  activityId: true,
  postingBatchId: true,
  createdByUserId: true,
  leaseOwner: true,
  leaseGeneration: true,
  leaseExpiresAt: true,
  lastErrorCode: true,
} as const;
type Job = Pick<ActivityBatchJob, keyof typeof JOB_SELECT>;
const UNCONFIRMED = 'HUMAN_CORRECTION_OUTCOME_UNCONFIRMED';
const UNAPPLIED = 'HUMAN_CORRECTION_CONFIRMED_UNAPPLIED';

/** Durable acceptance only. The worker calls the unchanged Human commit protocol,
 * under the original actor and its original 15s transaction budget. */
@Injectable()
export class ActivityTimeCorrectionBackgroundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: ActivityTimeCorrectionCommandService,
    private readonly access: ActivityTimeCorrectionAccessService,
    private readonly workflow: ActivityWorkflowGate,
    private readonly items: HumanCorrectionItemAuthority,
  ) {}

  async enqueue(
    activityId: string,
    requestId: string,
    dto: AppCommitActivityTimeCorrectionDto,
    user: CurrentUserPayload,
  ) {
    this.workflow.assertV11WriteAllowed();
    this.items.assertClient(this.prisma);
    // Only queue insertion can be retried on this unique-key race; this never
    // prepares or commits business, and the second pass reauthorizes and compares.
    for (let race = 0; race < 2; race += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await this.items.assertCallerInTx(tx);
          await this.lockActivity(tx, activityId);
          const operation = this.commands.toHumanCommitInput(activityId, requestId, dto, user);
          const target = await this.readTarget(tx, dto.correctionApplicationId);
          if (
            !target ||
            target.correctionRequestId !== requestId ||
            target.correctionRequest.activityId !== activityId ||
            target.correctionRequest.baseSettlementVersionId !==
              dto.expectedBaseSettlementVersionId ||
            target.newPostingBatchId !== dto.postingBatchId ||
            !target.correctionRequest.requestHash
          )
            throw new BizException(BizCode.CORRECTION_APPLY_STATUS_INVALID);
          const actor = await this.access.authorizeCommit(
            tx,
            user,
            activityId,
            dto.expectedBaseSettlementVersionId,
          );
          if (target.newPostingBatch.preparedByUserId !== actor.id)
            throw new BizException(BizCode.CORRECTION_APPLY_STATUS_INVALID);
          const changes = parseCorrectionChangeSet(target.correctionRequest.requestedChangeJson);
          if (
            (changes.schemaVersion !== 2 && changes.schemaVersion !== 3) ||
            (changes.schemaVersion === 3 && !target.timeSourceProof)
          )
            throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
          const roots = target.newPostingBatch.timeCorrectionManifests;
          if (roots.length !== 1 || !roots[0])
            throw new BizException(BizCode.CORRECTION_APPLY_STATUS_INVALID);
          const payload: HumanCorrectionJobPayload = {
            action: HUMAN_CORRECTION_JOB_TYPE,
            schemaVersion: changes.schemaVersion,
            activityId,
            requestId,
            applicationId: target.id,
            settlementRunId: target.correctionRequest.settlementRunId,
            newSettlementVersionId: target.newSettlementVersionId,
            rootManifestId: roots[0].rootManifestId,
            postingBatchId: target.newPostingBatchId,
            baseSettlementVersionId: dto.expectedBaseSettlementVersionId,
            actorUserId: actor.id,
            operationKey: operation.operationKey,
            commitRequestHash: operation.requestHash,
            sourceRequestHash: target.correctionRequest.requestHash,
            sourceProofHash: target.timeSourceProof?.sourceSetHash ?? null,
            segmentCount: changes.segments.length,
          };
          const hash = humanCorrectionJobHash(payload);
          const operationKey = `${HUMAN_CORRECTION_JOB_TYPE}:${dto.operationKey}`;
          const previous = await tx.activityBatchJob.findMany({
            where: {
              OR: [
                { operationKey },
                {
                  jobTypeCode: HUMAN_CORRECTION_JOB_TYPE,
                  postingBatchId: target.newPostingBatchId,
                },
              ],
            },
            select: JOB_SELECT,
            take: 2,
          });
          if (previous.length) {
            if (
              previous.length !== 1 ||
              this.checkedPayload(previous[0]).actorUserId !== actor.id ||
              previous[0].requestHash !== hash
            )
              throw new BizException(BizCode.CORRECTION_OPERATION_KEY_CONFLICT);
            let intent: HumanCorrectionIntent;
            try {
              intent = await this.items.readInTx(tx, previous[0].id, payload, true);
            } catch (error) {
              if (error instanceof HumanCorrectionLeaseLostError)
                throw new BizException(BizCode.CORRECTION_OPERATION_KEY_CONFLICT);
              throw error;
            }
            return this.present(previous[0], target, payload, intent);
          }
          if (!this.isUnapplied(target) && !this.isApplied(target, payload))
            throw new BizException(BizCode.CORRECTION_APPLY_STATUS_INVALID);
          const applied = this.isApplied(target, payload);
          const job = await tx.activityBatchJob.create({
            data: {
              jobTypeCode: HUMAN_CORRECTION_JOB_TYPE,
              activityId,
              settlementVersionId: target.newSettlementVersionId,
              postingBatchId: target.newPostingBatchId,
              statusCode: applied ? 'succeeded' : 'pending',
              operationKey,
              requestHash: hash,
              availableAt: new Date(),
              payloadVersion: 1,
              payload: payload as unknown as Prisma.InputJsonObject,
              total: 1,
              succeeded: applied ? 1 : 0,
              createdByUserId: actor.id,
              completedAt: applied ? new Date() : null,
            },
            select: JOB_SELECT,
          });
          const intent = await this.items.acceptInTx(tx, job.id, payload, applied);
          return this.present(job, target, payload, intent);
        });
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002' ||
          race !== 0
        )
          throw error;
      }
    }
    throw new BizException(BizCode.CORRECTION_OPERATION_KEY_CONFLICT);
  }

  async detail(activityId: string, requestId: string, jobId: string, user: CurrentUserPayload) {
    this.items.assertClient(this.prisma);
    return this.prisma.$transaction(async (tx) => {
      const { job, payload, target, intent } = await this.authorizedJob(
        tx,
        activityId,
        requestId,
        jobId,
        user,
      );
      return this.present(job, target, payload, intent);
    });
  }

  /** Explicit retry only after independent reconciliation proved no publication
   * and fenced out the previous worker. An expired lease alone is insufficient. */
  async retry(activityId: string, requestId: string, jobId: string, user: CurrentUserPayload) {
    this.workflow.assertV11WriteAllowed();
    this.items.assertClient(this.prisma);
    return this.prisma.$transaction(async (tx) => {
      await this.items.assertCallerInTx(tx);
      await this.lockActivity(tx, activityId);
      await tx.$queryRaw`SELECT id FROM "ActivityBatchJob" WHERE id=${jobId} FOR UPDATE`;
      const { job, payload, target, intent } = await this.authorizedJob(
        tx,
        activityId,
        requestId,
        jobId,
        user,
        true,
      );
      if (
        job.statusCode !== 'failed' ||
        job.lastErrorCode !== UNAPPLIED ||
        intent.statusCode !== 'failed' ||
        intent.lastErrorCode !== UNAPPLIED ||
        !this.isUnapplied(target)
      )
        throw new BizException(BizCode.CORRECTION_APPLY_STATUS_INVALID);
      const pending = await this.items.retryInTx(tx, intent, payload);
      await tx.activityBatchJob.update({
        where: { id: jobId },
        data: {
          statusCode: 'pending',
          failed: 0,
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseGeneration: { increment: 1 },
          availableAt: new Date(),
          completedAt: null,
          lastErrorCode: null,
        },
      });
      return this.present(
        {
          ...job,
          statusCode: 'pending',
          lastErrorCode: null,
          leaseGeneration: job.leaseGeneration + 1,
        },
        target,
        payload,
        pending,
      );
    });
  }

  async process(input: {
    jobId: string;
    activityId: string;
    leaseOwner: string;
    leaseGeneration: number;
  }): Promise<boolean> {
    this.items.assertClient(this.prisma);
    const job = await this.prisma.activityBatchJob.findUnique({
      where: { id: input.jobId },
      select: JOB_SELECT,
    });
    if (
      !job ||
      job.statusCode !== 'processing' ||
      job.leaseOwner !== input.leaseOwner ||
      job.leaseGeneration !== input.leaseGeneration
    )
      return false;
    const payload = this.checkedPayload(job);
    if (payload.activityId !== input.activityId) throw new HumanCorrectionLeaseLostError();
    const claim: HumanCorrectionJobClaim = { ...input, payload };
    let observed: HumanCorrectionIntent | undefined;
    try {
      const permit = await this.prisma.$transaction(async (tx) => {
        await this.items.assertCallerInTx(tx);
        await this.lockActivity(tx, payload.activityId, true);
        await lockHumanCorrectionJobRow(tx, claim);
        const intent = await this.items.readInTx(tx, claim.jobId, payload, true);
        observed = intent;
        const target = await this.requireTarget(tx, payload);
        if (!this.isUnapplied(target) || intent.statusCode !== 'pending') return null;
        const original = await loadActiveUserIdentityInTx(tx, payload.actorUserId);
        if (!original) throw new BizException(BizCode.UNAUTHORIZED);
        const actor = await this.access.authorizeCommit(
          tx,
          original,
          payload.activityId,
          payload.baseSettlementVersionId,
        );
        const started = await this.items.startInTx(tx, intent, payload);
        if (!started) return null;
        observed = started;
        const fence: HumanCorrectionJobFence = {
          ...claim,
          intentItemId: started.id,
          intentHash: started.intentHash,
          itemEpoch: started.itemEpoch,
        };
        return { actor, fence };
      });
      if (permit)
        await this.commands.commit(
          payload.activityId,
          payload.requestId,
          {
            correctionApplicationId: payload.applicationId,
            postingBatchId: payload.postingBatchId,
            expectedBaseSettlementVersionId: payload.baseSettlementVersionId,
            operationKey: payload.operationKey,
          },
          permit.actor,
          {
            requestId: `human-correction-job:${input.jobId}:${input.leaseGeneration}`,
            ip: null,
            ua: 'activity-batch-worker',
          },
          permit.fence,
        );
    } catch (error) {
      if (error instanceof HumanCorrectionAuthorityUnavailableError) throw error;
      if (error instanceof HumanCorrectionLeaseLostError) return false;
      // Neither a rejected Promise nor lease expiry establishes a DB outcome.
    }
    return this.reconcile(claim, observed);
  }

  private async reconcile(
    claim: HumanCorrectionJobClaim,
    expected?: HumanCorrectionIntent,
  ): Promise<boolean> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.items.assertCallerInTx(tx);
        await this.lockActivity(tx, claim.payload.activityId, true);
        await tx.$queryRaw`SELECT id FROM "ActivityBatchJob" WHERE id=${claim.jobId} FOR UPDATE NOWAIT`;
        const current = await tx.activityBatchJob.findUnique({
          where: { id: claim.jobId },
          select: JOB_SELECT,
        });
        if (
          !current ||
          humanCorrectionJobHash(this.checkedPayload(current)) !==
            humanCorrectionJobHash(claim.payload)
        )
          throw new HumanCorrectionLeaseLostError();
        const intent = await this.items.readInTx(tx, claim.jobId, claim.payload, true);
        if (
          expected &&
          (intent.id !== expected.id ||
            intent.intentHash !== expected.intentHash ||
            intent.itemEpoch !== expected.itemEpoch)
        )
          throw new HumanCorrectionLeaseLostError();
        const target = await this.requireTarget(tx, claim.payload);
        const applied = this.isApplied(target, claim.payload);
        const ownsJob =
          current.statusCode === 'processing' &&
          current.leaseOwner === claim.leaseOwner &&
          current.leaseGeneration === claim.leaseGeneration;
        if (!ownsJob)
          return (
            applied &&
            intent.statusCode === 'succeeded' &&
            intent.resultReference === claim.payload.applicationId
          );
        if (applied) await this.items.confirmAppliedInTx(tx, intent, claim.payload);
        else if (this.isUnapplied(target)) {
          if (intent.statusCode === 'pending' || intent.statusCode === 'processing')
            await this.items.confirmUnappliedInTx(tx, intent, claim.payload);
          else if (intent.statusCode !== 'failed' || intent.lastErrorCode !== UNAPPLIED)
            throw new Error(UNCONFIRMED);
        } else throw new Error(UNCONFIRMED);
        const updated = await tx.activityBatchJob.updateMany({
          where: {
            id: claim.jobId,
            jobTypeCode: HUMAN_CORRECTION_JOB_TYPE,
            statusCode: 'processing',
            leaseOwner: claim.leaseOwner,
            leaseGeneration: claim.leaseGeneration,
          },
          data: {
            statusCode: applied ? 'succeeded' : 'failed',
            succeeded: applied ? 1 : 0,
            failed: applied ? 0 : 1,
            leaseGeneration: { increment: 1 },
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: new Date(),
            lastErrorCode: applied ? null : UNAPPLIED,
          },
        });
        if (updated.count !== 1) throw new HumanCorrectionLeaseLostError();
        return applied;
      });
    } catch (error) {
      if (error instanceof HumanCorrectionAuthorityUnavailableError) throw error;
      if (error instanceof HumanCorrectionLeaseLostError) return false;
      // Only an untrusted nonterminal hint. No protected Item mutation, terminal
      // inference or retry permission can result from this catch path.
      await this.prisma.activityBatchJob.updateMany({
        where: {
          id: claim.jobId,
          jobTypeCode: HUMAN_CORRECTION_JOB_TYPE,
          statusCode: 'processing',
          leaseOwner: claim.leaseOwner,
          leaseGeneration: claim.leaseGeneration,
        },
        data: { lastErrorCode: UNCONFIRMED },
      });
      return false;
    }
  }

  private checkedPayload(job: Job) {
    const payload = parseHumanCorrectionJobPayload(job.payload);
    if (
      job.payloadVersion !== 1 ||
      job.jobTypeCode !== HUMAN_CORRECTION_JOB_TYPE ||
      job.activityId !== payload.activityId ||
      job.postingBatchId !== payload.postingBatchId ||
      job.createdByUserId !== payload.actorUserId ||
      job.requestHash !== humanCorrectionJobHash(payload)
    )
      throw new BizException(BizCode.CORRECTION_OPERATION_KEY_CONFLICT);
    return payload;
  }

  private async authorizedJob(
    tx: Tx,
    activityId: string,
    requestId: string,
    jobId: string,
    user: CurrentUserPayload,
    lockIntent = false,
  ) {
    const job = await tx.activityBatchJob.findFirst({
      where: { id: jobId, activityId, jobTypeCode: HUMAN_CORRECTION_JOB_TYPE },
      select: JOB_SELECT,
    });
    if (!job) throw new BizException(BizCode.NOT_FOUND);
    const payload = this.checkedPayload(job);
    if (
      payload.activityId !== activityId ||
      payload.requestId !== requestId ||
      payload.actorUserId !== user.id
    )
      throw new BizException(BizCode.NOT_FOUND);
    await this.access.authorizeCommit(tx, user, activityId, payload.baseSettlementVersionId);
    const target = await this.requireTarget(tx, payload);
    const intent = await this.items.readInTx(tx, job.id, payload, lockIntent);
    return { job, payload, target, intent };
  }

  private readTarget(tx: Tx, applicationId: string) {
    return tx.correctionApplication.findUnique({
      where: { id: applicationId },
      select: {
        id: true,
        statusCode: true,
        correctionRequestId: true,
        newPostingBatchId: true,
        newSettlementVersionId: true,
        correctionRequest: {
          select: {
            id: true,
            activityId: true,
            baseSettlementVersionId: true,
            settlementRunId: true,
            requestHash: true,
            requestedChangeJson: true,
            statusCode: true,
          },
        },
        newPostingBatch: {
          select: {
            statusCode: true,
            preparedByUserId: true,
            committedByUserId: true,
            timeCorrectionManifests: { select: { rootManifestId: true }, take: 2 },
          },
        },
        timeSourceProof: { select: { sourceSetHash: true } },
      },
    });
  }

  private async requireTarget(tx: Tx, payload: HumanCorrectionJobPayload) {
    const target = await this.readTarget(tx, payload.applicationId);
    if (
      !target ||
      target.correctionRequestId !== payload.requestId ||
      target.correctionRequest.activityId !== payload.activityId ||
      target.correctionRequest.baseSettlementVersionId !== payload.baseSettlementVersionId ||
      target.newPostingBatchId !== payload.postingBatchId ||
      target.newSettlementVersionId !== payload.newSettlementVersionId ||
      target.correctionRequest.settlementRunId !== payload.settlementRunId ||
      target.newPostingBatch.timeCorrectionManifests.length !== 1 ||
      target.newPostingBatch.timeCorrectionManifests[0]?.rootManifestId !==
        payload.rootManifestId ||
      target.newPostingBatch.preparedByUserId !== payload.actorUserId ||
      target.correctionRequest.requestHash !== payload.sourceRequestHash ||
      (target.timeSourceProof?.sourceSetHash ?? null) !== payload.sourceProofHash
    )
      throw new BizException(BizCode.CORRECTION_OPERATION_KEY_CONFLICT);
    const changes = parseCorrectionChangeSet(target.correctionRequest.requestedChangeJson);
    if (
      changes.schemaVersion !== payload.schemaVersion ||
      changes.segments.length !== payload.segmentCount
    )
      throw new BizException(BizCode.CORRECTION_OPERATION_KEY_CONFLICT);
    return target;
  }

  private isUnapplied(
    target: NonNullable<Awaited<ReturnType<ActivityTimeCorrectionBackgroundService['readTarget']>>>,
  ) {
    return (
      target.statusCode === 'preparing' &&
      target.correctionRequest.statusCode === 'applying' &&
      target.newPostingBatch.statusCode === 'ready'
    );
  }
  private isApplied(
    target: NonNullable<Awaited<ReturnType<ActivityTimeCorrectionBackgroundService['readTarget']>>>,
    payload: HumanCorrectionJobPayload,
  ) {
    return (
      target.statusCode === 'committed' &&
      target.correctionRequest.statusCode === 'applied' &&
      target.newPostingBatch.statusCode === 'committed' &&
      target.newPostingBatch.committedByUserId === payload.actorUserId
    );
  }

  private present(
    job: Job,
    target: NonNullable<Awaited<ReturnType<ActivityTimeCorrectionBackgroundService['readTarget']>>>,
    payload: HumanCorrectionJobPayload,
    intent: HumanCorrectionIntent,
  ): AppActivityTimeCorrectionJobDto {
    const applied = this.isApplied(target, payload);
    const retryAllowed =
      !applied &&
      this.isUnapplied(target) &&
      intent.statusCode === 'failed' &&
      intent.lastErrorCode === UNAPPLIED;
    return {
      jobId: job.id,
      correctionApplicationId: payload.applicationId,
      postingBatchId: payload.postingBatchId,
      stage: applied
        ? 'applied'
        : retryAllowed
          ? 'failed'
          : intent.statusCode === 'pending' && job.statusCode === 'pending'
            ? 'queued'
            : intent.statusCode === 'processing' &&
                job.lastErrorCode !== UNCONFIRMED &&
                job.leaseExpiresAt !== null &&
                job.leaseExpiresAt > new Date()
              ? 'executing'
              : 'verifying',
      applied,
      completedUnits: applied ? 1 : 0,
      totalUnits: 1,
      segmentCount: payload.segmentCount,
      attempt: intent.itemEpoch,
      retryAllowed,
    };
  }

  private async lockActivity(tx: Tx, activityId: string, nowait = false) {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM "Activity"
      WHERE id=${activityId} AND "deletedAt" IS NULL FOR UPDATE ${nowait ? Prisma.sql`NOWAIT` : Prisma.empty}`);
    if (rows.length !== 1) throw new BizException(BizCode.NOT_FOUND);
  }
}
