import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { HumanCorrectionItemAuthority } from './human-correction-item-authority';
import {
  HUMAN_CORRECTION_JOB_TYPE,
  HumanCorrectionLeaseLostError,
  HumanCorrectionAuthorityUnavailableError,
  humanCorrectionJobHash,
  parseHumanCorrectionJobPayload,
  assertHumanCorrectionFence,
  type HumanCorrectionJobClaim,
  type HumanCorrectionJobFence,
} from './human-correction-intent';
export * from './human-correction-intent';

/** Called only after the original Activity/run/request/application locks and
 * live Human authorization. The job row stays locked through real COMMIT.
 * An expired/reclaimed worker cannot publish, even if it had not yet obtained
 * the Activity lock when a recovery owner took over. */
export async function lockHumanCorrectionJobRow(
  tx: Prisma.TransactionClient,
  fence: HumanCorrectionJobClaim,
) {
  const rows = await tx.$queryRaw<
    {
      id: string;
      payload: Prisma.JsonValue;
      requestHash: string | null;
      createdByUserId: string | null;
      payloadVersion: number;
    }[]
  >`
    SELECT id,payload,"requestHash","createdByUserId","payloadVersion" FROM "ActivityBatchJob"
    WHERE id=${fence.jobId} AND "activityId"=${fence.payload.activityId}
      AND "jobTypeCode"=${HUMAN_CORRECTION_JOB_TYPE} AND "statusCode"='processing'
      AND "postingBatchId"=${fence.payload.postingBatchId}
      AND "leaseOwner"=${fence.leaseOwner} AND "leaseGeneration"=${fence.leaseGeneration}
      AND "leaseExpiresAt">clock_timestamp() FOR UPDATE`;
  const row = rows[0];
  if (rows.length !== 1 || !row) throw new HumanCorrectionLeaseLostError();
  const payload = parseHumanCorrectionJobPayload(row.payload);
  if (
    row.payloadVersion !== 1 ||
    row.createdByUserId !== payload.actorUserId ||
    row.requestHash !== humanCorrectionJobHash(payload) ||
    humanCorrectionJobHash(payload) !== humanCorrectionJobHash(fence.payload)
  )
    throw new BizException(BizCode.CORRECTION_OPERATION_KEY_CONFLICT);
}

/** The Job fence is writable scheduling state. Publication ALSO requires the
 * protected Item lock/epoch on this SAME transaction, held through COMMIT. */
export async function lockHumanCorrectionJob(
  tx: Prisma.TransactionClient,
  fence: HumanCorrectionJobFence,
  authority?: HumanCorrectionItemAuthority,
) {
  if (!authority) throw new HumanCorrectionAuthorityUnavailableError();
  assertHumanCorrectionFence(fence);
  await lockHumanCorrectionJobRow(tx, fence);
  await authority.assertAttemptInTx(tx, fence);
}

/** No separate metadata COMMIT: a failed protected CAS aborts business/audit. */
export async function finishHumanCorrectionJob(
  tx: Prisma.TransactionClient,
  fence: HumanCorrectionJobFence,
  authority?: HumanCorrectionItemAuthority,
) {
  if (!authority) throw new HumanCorrectionAuthorityUnavailableError();
  assertHumanCorrectionFence(fence);
  await authority.finishInTx(tx, fence);
  const job = await tx.activityBatchJob.updateMany({
    where: {
      id: fence.jobId,
      jobTypeCode: HUMAN_CORRECTION_JOB_TYPE,
      statusCode: 'processing',
      leaseOwner: fence.leaseOwner,
      leaseGeneration: fence.leaseGeneration,
    },
    data: {
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
  if (job.count !== 1) throw new HumanCorrectionLeaseLostError();
}
