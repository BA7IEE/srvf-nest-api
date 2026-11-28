import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { fingerprintLocalTimeBucketManifest } from './activity-time-settlement-canonical';
import {
  TIME_SETTLEMENT_CATEGORIES,
  TimeSettlementPolicyError,
} from './activity-time-settlement-policy';
import { timeShadowHoursToSeconds } from './activity-time-shadow-policy';
import { ACTIVITY_TIME_CUTOVER_RECEIPT_ID } from './activity-time-cutover-command';

type Tx = Prisma.TransactionClient;

export function ordinaryTimeBuckets(
  participationIdentityId: string,
  calculatedHours: string,
  recognizedHours: string,
) {
  const calculated = timeShadowHoursToSeconds(calculatedHours);
  const recognized = timeShadowHoursToSeconds(recognizedHours);
  return TIME_SETTLEMENT_CATEGORIES.map((categoryCode) => {
    const calculatedSeconds = categoryCode === 'volunteer_service' ? calculated : 0;
    const recognizedSeconds = categoryCode === 'volunteer_service' ? recognized : 0;
    return {
      participationIdentityId,
      categoryCode,
      calculatedSeconds,
      recognizedSeconds,
      rawCalculatedMilliseconds: BigInt(calculatedSeconds) * 1000n,
      rawRecognizedMilliseconds: BigInt(recognizedSeconds) * 1000n,
      timePolicyVersionId: null,
      definitionHash: null,
      evaluatorVersion: null,
      quantumSeconds: null,
    };
  });
}

export async function hasTimeCutover(tx: Tx) {
  return Boolean(
    await tx.activityTimeCutoverReceipt.findUnique({
      where: { id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID },
      select: { id: true },
    }),
  );
}

/** The caller holds the Activity lock and writes in the same transaction as submit or posting. */
export async function createOrdinaryTimeRoot(
  tx: Tx,
  activityId: string,
  settlementVersionId: string,
  actorUserId: string,
) {
  const notReady = () => new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SOURCE_NOT_READY);
  const [proof] = await tx.$queryRaw<Array<{ allowed: boolean; sourceSetHash: string }>>`
    SELECT astr_ordinary_root_allowed(${activityId}, ${settlementVersionId}, ${actorUserId}) AS allowed,
           astr_source_set_hash(${activityId}, ${settlementVersionId}) AS "sourceSetHash"
  `;
  if (!proof?.allowed) throw notReady();

  const version = await tx.attendanceSettlementVersion.findUniqueOrThrow({
    where: { id: settlementVersionId },
  });
  const population = await tx.activityParticipationIdentity.findMany({
    where: { activityId, populationIncluded: true },
    select: { id: true },
    take: 2001,
  });
  if (population.length > 2000)
    throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT);

  const identityIds = population.map(({ id }) => id);
  const results = await tx.participantSettlementResultRevision.findMany({
    where: {
      settlementVersionId,
      participationIdentityId: { in: identityIds },
    },
    select: {
      participationIdentityId: true,
      calculatedServiceHours: true,
      recognizedServiceHours: true,
    },
  });
  if (results.length !== population.length) throw notReady();
  results.sort((left, right) =>
    left.participationIdentityId < right.participationIdentityId ? -1 : 1,
  );
  try {
    const buckets = results.flatMap((result) =>
      ordinaryTimeBuckets(
        result.participationIdentityId,
        result.calculatedServiceHours.toString(),
        result.recognizedServiceHours.toString(),
      ),
    );
    const bucketContentHash = fingerprintLocalTimeBucketManifest(
      buckets.map((bucket) => ({
        ...bucket,
        rawCalculatedMilliseconds: bucket.rawCalculatedMilliseconds.toString(),
        rawRecognizedMilliseconds: bucket.rawRecognizedMilliseconds.toString(),
        adjustmentReason: null,
        emptyReasonCode: 'no_valid_segment',
        sources: [],
      })),
    ).definitionHash;
    const prior = await tx.activitySettlementTimeRevision.findFirst({
      where: { settlementRunId: version.settlementRunId },
      orderBy: { revision: 'desc' },
      select: { id: true, revision: true },
    });
    const createdAt = new Date();
    let previous = prior;
    let sourceDraftTimeRevisionId: string | null = null;
    for (const kindCode of ['draft', 'submitted'] as const) {
      // Both revisions refer to the same frozen result version. The draft time revision
      // is the source for the classified copy, independent of the mutable settlement draft.
      const revision: { id: string; revision: number } =
        await tx.activitySettlementTimeRevision.create({
          select: { id: true, revision: true },
          data: {
            kindCode,
            activityId,
            settlementVersionId,
            settlementRunId: version.settlementRunId,
            evidenceSealId: version.evidenceSealId,
            evidenceRevision: version.evidenceRevision,
            populationRevision: version.populationRevision,
            workflowRevision: version.workflowRevision,
            draftContentHash: version.contentHash,
            sourceSetHash: proof.sourceSetHash,
            bucketContentHash,
            bucketCount: buckets.length,
            sourceCount: 0,
            revision: (previous?.revision ?? 0) + 1,
            previousTimeRevisionId: previous?.id ?? null,
            sourceDraftTimeRevisionId,
            createdAt,
            createdByUserId: actorUserId,
          },
        });
      if (buckets.length)
        await tx.participantSettlementTimeBucket.createMany({
          data: buckets.map((bucket) => ({ ...bucket, activityId, timeRevisionId: revision.id })),
        });
      const operationCode =
        kindCode === 'draft' ? 'prepare_time_settlement' : 'submit_time_settlement';
      const operationKey = `ordinary-time-root:${settlementVersionId}:${kindCode}`;
      await tx.activitySettlementTimeCommandReceipt.create({
        data: {
          activityId,
          actorUserId,
          timeRevisionId: revision.id,
          operationCode,
          operationKey,
          requestHash: createHash('sha256').update(operationKey).digest('hex'),
          createdAt,
          resultJson: {
            schemaVersion: 1,
            activityId,
            timeRevisionId: revision.id,
            revision: revision.revision,
            kindCode,
            settlementRunId: version.settlementRunId,
            settlementVersionId,
            settlementVersion: version.version,
            contentHash: version.contentHash,
            bucketContentHash,
            bucketCount: buckets.length,
            sourceCount: 0,
            createdAt: createdAt.toISOString(),
          },
        },
      });
      previous = revision;
      sourceDraftTimeRevisionId = revision.id;
    }
    return identityIds;
  } catch (error) {
    if (
      error instanceof TimeSettlementPolicyError ||
      (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2004') ||
      // The PostgreSQL connector may omit the trigger's constraint name.
      (error instanceof Prisma.PrismaClientUnknownRequestError &&
        /\bcode: "23514"/u.test(error.message))
    )
      throw notReady();
    throw error;
  }
}
