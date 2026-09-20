import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AttachmentsService } from '../attachments/attachments.service';
import { fingerprintMetricEnvelope } from './activity-metric-definition';
import {
  buildCorrectionTimeAllocationManifest,
  type ActivityTimeAllocationSliceInput,
} from './activity-time-allocation-command';
import {
  assertAllocationSlicesWithinSource,
  assertManualTimeAllocationAllowed,
  assertTimeAllocationEvidence,
  automaticTimeAllocationSlices,
  historicalAttendanceRoleFromRuleSnapshot,
  historicalTimePolicySelectionTargetsFromRuleSnapshot,
} from './activity-time-allocation-policy';
import {
  activityTimePolicySelectionHash,
  parseActivityTimePolicySelectionDocument,
  resolveActivityTimePolicySelection,
} from './activity-time-policy-selection';
import { timePolicyVersionDocument } from './activity-time-policy-presenter';
import type {
  CorrectionAllocationChange,
  CorrectionChangeSet,
  CorrectionSegmentChange,
} from './correction-change-set';

type Tx = Prisma.TransactionClient;

// The V3 source set is capped at 10,000 rows.  Prisma expands an `in` filter
// into individual bind expressions, which exhausts PostgreSQL's stack depth at
// that boundary.  Keep reads set-based, but issue bounded 1,000-row reads.
const CORRECTION_ALLOCATION_READ_BATCH_SIZE = 1000;

// D7-2's correction commit retains the same immutable fact contract at the
// 2,000-identity acceptance scale. Keep allocation and receipt rows bounded
// at 1,000; source bindings instead travel as one parameterized JSON recordset.
// That keeps the 10,000-row contract below PostgreSQL's bind ceiling and makes
// its statement-level guard run once, without weakening any database constraint.
const CORRECTION_ALLOCATION_SOURCE_WRITE_BATCH_SIZE = 1000;
const CORRECTION_ALLOCATION_CHILD_WRITE_BATCH_SIZE = 5000;

async function createManyInFixedBatches<T>(
  rows: readonly T[],
  batchSize: number,
  createMany: (data: T[]) => Promise<{ count: number }>,
): Promise<void> {
  let createdCount = 0;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const result = await createMany(rows.slice(offset, offset + batchSize));
    createdCount += result.count;
  }
  if (createdCount !== rows.length) return invalidCorrectionFact();
}

/**
 * A correction proof can carry 10,000 immutable source bindings. A Prisma
 * `createMany` needs two 5,000-row statements at that scale, so the exact same
 * statement-level database guard executes twice. The JSON payload remains a
 * bound value; `jsonb_to_recordset` only turns that fixed in-memory fact into
 * typed rows inside the existing transaction.
 */
async function createCorrectionBindingsInOneStatement(
  tx: Tx,
  rows: readonly Prisma.CorrectionTimeAllocationBindingCreateManyInput[],
): Promise<void> {
  if (rows.length === 0) return;
  const insertedCount = await tx.$executeRaw`
    INSERT INTO "CorrectionTimeAllocationBinding" (
      id,
      "proofId",
      "activityId",
      "participationIdentityId",
      "segmentKey",
      "allocationRevisionId",
      "sourceSegmentId",
      "sourceSegmentRevision",
      "pendingAllocationId",
      "sourceHash"
    )
    SELECT binding.id,
           binding."proofId",
           binding."activityId",
           binding."participationIdentityId",
           binding."segmentKey",
           binding."allocationRevisionId",
           binding."sourceSegmentId",
           binding."sourceSegmentRevision",
           binding."pendingAllocationId",
           binding."sourceHash"
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS binding(
      id text,
      "proofId" text,
      "activityId" text,
      "participationIdentityId" text,
      "segmentKey" text,
      "allocationRevisionId" text,
      "sourceSegmentId" text,
      "sourceSegmentRevision" integer,
      "pendingAllocationId" text,
      "sourceHash" text
    )
  `;
  if (insertedCount !== rows.length) return invalidCorrectionFact();
}

type BaseAllocation = Prisma.ParticipantTimeAllocationRevisionGetPayload<{
  include: {
    sourceSegment: true;
    ruleSnapshot: true;
    timePolicySelectionRevision: true;
    policyVersion: true;
    slices: true;
  };
}>;

interface SourceSnapshotRow {
  readonly participationIdentityId: string;
  readonly segmentKey: string;
  readonly baseSegmentRevisionId: string;
  readonly baseSegmentRevision: number;
  readonly sourceSegmentId: string;
  readonly sourceSegmentRevision: number;
  readonly baseAllocationRevisionId: string;
  readonly allocationRevisionId: string;
  readonly pendingAllocationId: string | null;
  readonly sliceCount: number;
  readonly sourceHash: string;
}

/**
 * A fully parsed source proof prepared before the short Human commit
 * transaction starts.  It is only an optimization: materialization accepts it
 * after a fresh, locked transaction read proves that the immutable proof
 * anchor is unchanged.
 */
export interface CorrectionTimeAllocationProofPrevalidation {
  readonly proofId: string;
  readonly applicationId: string;
  readonly activityId: string;
  readonly sourceSetHash: string;
  readonly expectedSegmentCount: number;
  readonly expectedPendingCount: number;
  readonly expectedSliceCount: number;
  readonly expectedBindingCount: number;
  readonly formatVersion: number;
  readonly sourceSnapshots: readonly SourceSnapshotRow[];
}

type CorrectionTimeAllocationProofReader = Pick<Prisma.TransactionClient, 'correctionApplication'>;

export interface CorrectionTimeAllocationPreparation {
  readonly sourceProofId: string;
  readonly sourceProofHash: string;
  readonly proofData: {
    readonly id: string;
    readonly applicationId: string;
    readonly correctionManifestId: string;
    readonly activityId: string;
    readonly settlementRunId: string;
    readonly rootManifestId: string;
    readonly baseSettlementVersionId: string;
    readonly settlementVersionId: string;
    readonly postingBatchId: string;
    readonly sourceSetHash: string;
    readonly calculationHash: string;
    readonly sourceSnapshotJson: Prisma.InputJsonValue;
    readonly calculatedBucketsJson: Prisma.InputJsonValue;
    readonly expectedSegmentCount: number;
    readonly expectedPendingCount: number;
    readonly expectedSliceCount: number;
    readonly expectedBindingCount: number;
    readonly formatVersion: number;
  };
}

/**
 * D7-2's correction allocation path is intentionally isolated from the public
 * D3 command.  It freezes the reviewed V3 source set during prepare, and only
 * later materializes that exact fact after the correction batch is ready.
 */
@Injectable()
export class CorrectionTimeAllocationService {
  constructor(private readonly attachments: AttachmentsService) {}

  /**
   * Parse the large, immutable V3 source proof before the 7-second Human
   * commit transaction.  This is deliberately advisory: a missing, malformed
   * or stale prevalidation is never a reason to trust it inside the
   * transaction.  `materialize` re-reads its compact anchor after the caller
   * holds the application lock, and otherwise follows the original complete
   * in-transaction parse path.
   */
  async prevalidateFrozenSourceProof(
    reader: CorrectionTimeAllocationProofReader,
    input: { correctionRequestId: string; activityId: string },
  ): Promise<CorrectionTimeAllocationProofPrevalidation | undefined> {
    const application = await reader.correctionApplication.findFirst({
      where: {
        correctionRequestId: input.correctionRequestId,
        statusCode: 'preparing',
        timeSourceProof: { isNot: null },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        timeSourceProof: {
          select: {
            id: true,
            applicationId: true,
            activityId: true,
            sourceSetHash: true,
            sourceSnapshotJson: true,
            expectedSegmentCount: true,
            expectedPendingCount: true,
            expectedSliceCount: true,
            expectedBindingCount: true,
            formatVersion: true,
          },
        },
      },
    });
    const proof = application?.timeSourceProof;
    if (
      !proof ||
      application.id !== proof.applicationId ||
      proof.activityId !== input.activityId ||
      proof.formatVersion !== 1
    ) {
      return undefined;
    }

    let sourceSnapshots: readonly SourceSnapshotRow[];
    try {
      sourceSnapshots = parseSourceSnapshots(proof.sourceSnapshotJson);
    } catch (error) {
      if (error instanceof BizException) return undefined;
      throw error;
    }
    if (
      fingerprintMetricEnvelope('correction-time-source-set-v1', proof.sourceSnapshotJson)
        .definitionHash !== proof.sourceSetHash ||
      sourceSnapshots.length !== proof.expectedSegmentCount ||
      proof.expectedBindingCount !== sourceSnapshots.length ||
      sourceSnapshots.reduce((total, source) => total + source.sliceCount, 0) !==
        proof.expectedSliceCount
    ) {
      return undefined;
    }
    return {
      proofId: proof.id,
      applicationId: proof.applicationId,
      activityId: proof.activityId,
      sourceSetHash: proof.sourceSetHash,
      expectedSegmentCount: proof.expectedSegmentCount,
      expectedPendingCount: proof.expectedPendingCount,
      expectedSliceCount: proof.expectedSliceCount,
      expectedBindingCount: proof.expectedBindingCount,
      formatVersion: proof.formatVersion,
      sourceSnapshots,
    };
  }

  async prepare(
    tx: Tx,
    input: {
      applicationId: string;
      correctionManifestId: string;
      activityId: string;
      settlementRunId: string;
      rootManifestId: string;
      baseSettlementVersionId: string;
      settlementVersionId: string;
      postingBatchId: string;
      changeSet: CorrectionChangeSet;
      calculatedBuckets: readonly unknown[];
    },
  ): Promise<CorrectionTimeAllocationPreparation> {
    if (input.changeSet.schemaVersion !== 3 || !input.changeSet.allocations)
      return invalidCorrectionFact();

    const pendingSegments = await tx.correctionPendingSegmentRevision.findMany({
      where: { applicationId: input.applicationId, activityId: input.activityId },
      orderBy: [{ participationIdentityId: 'asc' }, { segmentKey: 'asc' }],
      select: {
        id: true,
        participationIdentityId: true,
        segmentKey: true,
        baseRevisionId: true,
        baseRevisionNumber: true,
        targetRevisionNumber: true,
        checkInAt: true,
        checkOutAt: true,
        resultCode: true,
        serviceHours: true,
      },
    });
    if (
      pendingSegments.length !== input.changeSet.segments.length ||
      pendingSegments.length !== input.changeSet.allocations.length
    )
      return invalidCorrectionFact();

    const allocationsByKey = new Map(
      input.changeSet.allocations.map((allocation) => [pairKey(allocation), allocation]),
    );
    if (allocationsByKey.size !== pendingSegments.length) return invalidCorrectionFact();

    // A V3 proof is deliberately a full source-set proof, not a list of only
    // the changed rows.  The ordinary settlement reader likewise treats valid,
    // committed segments as the source set requiring an allocation.
    const sourceSegments = await tx.participantServiceSegmentRevision.findMany({
      where: {
        identity: { activityId: input.activityId },
        statusCode: 'committed',
        resultCode: 'valid',
      },
      orderBy: [{ participationIdentityId: 'asc' }, { segmentKey: 'asc' }],
      take: 10001,
      select: {
        id: true,
        participationIdentityId: true,
        segmentKey: true,
        revision: true,
        checkInAt: true,
        checkOutAt: true,
      },
    });
    if (sourceSegments.length === 0 || sourceSegments.length > 10000)
      return invalidCorrectionFact();
    if (
      new Set(sourceSegments.map(pairKey)).size !== sourceSegments.length ||
      sourceSegments.some((segment) => segment.checkOutAt === null)
    ) {
      return invalidCorrectionFact();
    }
    const sourceSegmentIds = sourceSegments.map((segment) => segment.id);
    await tx.$queryRaw`
      SELECT "id" FROM "ParticipantServiceSegmentRevision"
      WHERE "id" = ANY(${sourceSegmentIds}::text[])
      ORDER BY "id" FOR SHARE
    `;

    // Pull exactly one current allocation per source segment in a bounded set;
    // do not turn a 10,000-row correction into a per-row query loop.
    const currentAllocationIds = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT ON (a."participationIdentityId", a."segmentKey") a."id"
      FROM "ParticipantTimeAllocationRevision" a
      JOIN "ParticipantServiceSegmentRevision" s
        ON s."id" = a."sourceSegmentId"
          AND s."revision" = a."sourceSegmentRevision"
      WHERE a."activityId" = ${input.activityId}
        AND s."id" = ANY(${sourceSegmentIds}::text[])
        AND a."settlementDraftVersionId" IS NULL
      ORDER BY a."participationIdentityId", a."segmentKey", a."revision" DESC
    `;
    if (currentAllocationIds.length !== sourceSegments.length) return invalidCorrectionFact();
    const allocationIds = currentAllocationIds.map((row) => row.id);
    await tx.$queryRaw`
      SELECT "id" FROM "ParticipantTimeAllocationRevision"
      WHERE "id" = ANY(${allocationIds}::text[])
      ORDER BY "id" FOR SHARE
    `;
    // The preceding FOR SHARE has already locked the whole source allocation
    // set in one deterministic order.  These bounded reads only avoid Prisma's
    // oversized IN expansion; they neither change the locked set nor turn this
    // into a per-segment query loop (at most ten reads for 10,000 sources).
    const baseAllocations: BaseAllocation[] = [];
    for (
      let offset = 0;
      offset < allocationIds.length;
      offset += CORRECTION_ALLOCATION_READ_BATCH_SIZE
    ) {
      baseAllocations.push(
        ...(await tx.participantTimeAllocationRevision.findMany({
          where: {
            id: {
              in: allocationIds.slice(offset, offset + CORRECTION_ALLOCATION_READ_BATCH_SIZE),
            },
          },
          include: {
            sourceSegment: true,
            ruleSnapshot: true,
            timePolicySelectionRevision: true,
            policyVersion: true,
            slices: { orderBy: { ordinal: 'asc' } },
          },
        })),
      );
    }
    if (baseAllocations.length !== allocationIds.length) return invalidCorrectionFact();
    const baseByKey = new Map(baseAllocations.map((row) => [pairKey(row), row]));
    if (baseByKey.size !== sourceSegments.length) return invalidCorrectionFact();

    const attachmentIds = [
      ...new Set(input.changeSet.allocations.flatMap((row) => row.evidenceAttachmentIds)),
    ].sort(compareText);
    if (attachmentIds.length > 0) {
      await this.attachments.lockOwnerReferenceStorageBoundaryTrusted(tx, {
        ownerId: input.activityId,
        ownerTypes: ['activity'],
        referencedAttachmentIds: attachmentIds,
      });
      const found = await this.attachments.findOwnedAttachmentsTrusted(tx, {
        ownerId: input.activityId,
        ownerTypes: ['activity'],
        attachmentIds,
      });
      if (found === null || found.length !== attachmentIds.length) return invalidCorrectionFact();
    }

    const pendingRows: Prisma.CorrectionPendingTimeAllocationCreateManyInput[] = [];
    const evidenceRows: Prisma.CorrectionPendingTimeAllocationEvidenceCreateManyInput[] = [];
    const snapshots: Array<Record<string, unknown>> = [];
    const pendingByKey = new Map(pendingSegments.map((pending) => [pairKey(pending), pending]));
    if (pendingByKey.size !== pendingSegments.length) return invalidCorrectionFact();

    for (const sourceSegment of sourceSegments) {
      const key = pairKey(sourceSegment);
      const pending = pendingByKey.get(key);
      const base = baseByKey.get(key);
      if (!base) return invalidCorrectionFact();
      if (
        base.activityId !== input.activityId ||
        base.sourceSegmentId !== sourceSegment.id ||
        base.sourceSegmentRevision !== sourceSegment.revision ||
        base.sourceSegment.id !== sourceSegment.id ||
        base.sourceSegment.revision !== sourceSegment.revision ||
        base.sourceSegment.statusCode !== 'committed' ||
        base.settlementDraftVersionId !== null ||
        base.slices.length !== base.sliceCount ||
        !slicesAreCanonical(base.slices)
      ) {
        return invalidCorrectionFact();
      }
      if (!pending) {
        snapshots.push(
          this.snapshotSource({
            segment: sourceSegment,
            base,
            sourceSegmentId: sourceSegment.id,
            sourceSegmentRevision: sourceSegment.revision,
            allocationRevisionId: base.id,
            pendingAllocationId: null,
            slices: canonicalStoredSlices(base.slices),
          }),
        );
        continue;
      }
      const allocation = allocationsByKey.get(pairKey(pending));
      if (!allocation) return invalidCorrectionFact();
      this.assertBaseAllocation({ activityId: input.activityId, pending, allocation, base });

      const policy = timePolicyVersionDocument(base.policyVersion);
      if (
        policy.evaluatorVersion !== base.evaluatorVersion ||
        policy.definitionHash !== base.definitionHash ||
        base.ruleSnapshot.timePolicySelectionRevisionId !== base.timePolicySelectionRevisionId ||
        base.ruleSnapshot.snapshotHash !== base.ruleSnapshotHash ||
        base.timePolicySelectionRevision.selectionHash !== base.selectionHash ||
        base.policyVersion.statusCode === 'draft' ||
        base.policyVersion.effectiveFrom > pending.checkInAt ||
        (base.policyVersion.effectiveUntil !== null &&
          base.policyVersion.effectiveUntil < pending.checkOutAt)
      ) {
        return invalidCorrectionFact();
      }
      this.assertSelectionPointer(base);

      const zeroOnly =
        pending.serviceHours.isZero() ||
        pending.checkInAt.getTime() === pending.checkOutAt.getTime() ||
        pending.resultCode === 'early_departure_zero' ||
        pending.resultCode === 'voided' ||
        pending.resultCode === 'replaced';
      const slices = this.resolveSlices({
        allocation,
        base,
        policy: policy.definition,
        pending,
        zeroOnly,
      });
      const manifest = buildCorrectionTimeAllocationManifest(slices);
      const pendingAllocationId = randomUUID();
      const targetSegmentRevisionId = randomUUID();
      const targetAllocationRevisionId = randomUUID();
      snapshots.push(
        this.snapshotSource({
          segment: sourceSegment,
          base,
          sourceSegmentId: targetSegmentRevisionId,
          sourceSegmentRevision: pending.targetRevisionNumber,
          allocationRevisionId: targetAllocationRevisionId,
          allocationRevision: base.revision + 1,
          pendingAllocationId,
          slices,
          recognitionModeCode: allocation.recognitionModeCode,
          manualReason: allocation.manualReason,
          allocationHash: manifest.allocationHash,
        }),
      );
      pendingRows.push({
        id: pendingAllocationId,
        applicationId: input.applicationId,
        activityId: input.activityId,
        participationIdentityId: pending.participationIdentityId,
        segmentKey: pending.segmentKey,
        pendingSegmentId: pending.id,
        baseAllocationRevisionId: base.id,
        targetAllocationRevisionId,
        targetSegmentRevisionId,
        targetAllocationRevision: base.revision + 1,
        ruleSnapshotId: base.ruleSnapshotId,
        ruleSnapshotHash: base.ruleSnapshotHash,
        timePolicySelectionRevisionId: base.timePolicySelectionRevisionId,
        selectionHash: base.selectionHash,
        policyVersionId: base.policyVersionId,
        definitionHash: base.definitionHash,
        evaluatorVersion: base.evaluatorVersion,
        recognitionModeCode: allocation.recognitionModeCode,
        manualReason: allocation.manualReason,
        allocationJson: manifest.manifest as unknown as Prisma.InputJsonValue,
        allocationHash: manifest.allocationHash,
        sliceCount: slices.length,
      });
      allocation.evidenceAttachmentIds.forEach((attachmentId, ordinal) => {
        evidenceRows.push({
          id: randomUUID(),
          pendingAllocationId,
          activityId: input.activityId,
          attachmentId,
          ordinal,
        });
      });
    }
    if (pendingRows.length !== pendingSegments.length) return invalidCorrectionFact();

    const pendingCreated = await tx.correctionPendingTimeAllocation.createMany({
      data: pendingRows,
    });
    if (pendingCreated.count !== pendingRows.length) return invalidCorrectionFact();
    if (evidenceRows.length > 0) {
      const evidenceCreated = await tx.correctionPendingTimeAllocationEvidence.createMany({
        data: evidenceRows,
      });
      if (evidenceCreated.count !== evidenceRows.length) return invalidCorrectionFact();
    }

    const sourceSnapshotJson = snapshots.sort(sourceSnapshotOrder);
    const calculatedBucketsJson = [...input.calculatedBuckets];
    const sourceSetHash = fingerprintMetricEnvelope(
      'correction-time-source-set-v1',
      sourceSnapshotJson,
    ).definitionHash;
    const calculationHash = fingerprintMetricEnvelope(
      'correction-time-calculation-buckets-v1',
      calculatedBucketsJson,
    ).definitionHash;
    const expectedSliceCount = snapshots.reduce(
      (total, snapshot) => total + Number(snapshot.sliceCount),
      0,
    );
    const sourceProofId = randomUUID();
    return {
      sourceProofId,
      sourceProofHash: sourceSetHash,
      proofData: {
        id: sourceProofId,
        applicationId: input.applicationId,
        correctionManifestId: input.correctionManifestId,
        activityId: input.activityId,
        settlementRunId: input.settlementRunId,
        rootManifestId: input.rootManifestId,
        baseSettlementVersionId: input.baseSettlementVersionId,
        settlementVersionId: input.settlementVersionId,
        postingBatchId: input.postingBatchId,
        sourceSetHash,
        calculationHash,
        sourceSnapshotJson: sourceSnapshotJson as Prisma.InputJsonValue,
        calculatedBucketsJson: calculatedBucketsJson as Prisma.InputJsonValue,
        expectedSegmentCount: snapshots.length,
        expectedPendingCount: pendingRows.length,
        expectedSliceCount,
        expectedBindingCount: snapshots.length,
        formatVersion: 1,
      },
    };
  }

  async createProof(tx: Tx, preparation: CorrectionTimeAllocationPreparation): Promise<void> {
    await tx.correctionTimeSourceProof.create({ data: preparation.proofData });
  }

  async materialize(
    tx: Tx,
    input: {
      applicationId: string;
      activityId: string;
      actorUserId: string;
      prevalidatedProof?: CorrectionTimeAllocationProofPrevalidation;
    },
  ): Promise<number> {
    let proof:
      | {
          id: string;
          applicationId: string;
          activityId: string;
          sourceSetHash: string;
          expectedSegmentCount: number;
          expectedPendingCount: number;
          expectedSliceCount: number;
          expectedBindingCount: number;
          formatVersion: number;
        }
      | undefined;
    let sourceSnapshots: readonly SourceSnapshotRow[] | undefined;

    // The enclosing caller has already locked Activity → Run → Request →
    // Application.  Re-read this compact immutable anchor only after those
    // locks.  A plan never replaces that check; any mismatch falls through to
    // the historical full proof read and validation below.
    if (input.prevalidatedProof) {
      const lockedProof = await tx.correctionTimeSourceProof.findUnique({
        where: { applicationId: input.applicationId },
        select: {
          id: true,
          applicationId: true,
          activityId: true,
          sourceSetHash: true,
          expectedSegmentCount: true,
          expectedPendingCount: true,
          expectedSliceCount: true,
          expectedBindingCount: true,
          formatVersion: true,
        },
      });
      if (lockedProof && proofPrevalidationMatches(input.prevalidatedProof, lockedProof, input)) {
        proof = lockedProof;
        sourceSnapshots = input.prevalidatedProof.sourceSnapshots;
      }
    }

    if (!proof || !sourceSnapshots) {
      const fullProof = await tx.correctionTimeSourceProof.findUnique({
        where: { applicationId: input.applicationId },
        select: {
          id: true,
          applicationId: true,
          activityId: true,
          sourceSetHash: true,
          sourceSnapshotJson: true,
          expectedSegmentCount: true,
          expectedPendingCount: true,
          expectedSliceCount: true,
          expectedBindingCount: true,
          formatVersion: true,
        },
      });
      if (!fullProof) return invalidCorrectionFact();
      proof = fullProof;
      sourceSnapshots = parseSourceSnapshots(fullProof.sourceSnapshotJson);
    }
    const sourceByKey = new Map(sourceSnapshots.map((source) => [sourcePairKey(source), source]));
    const pending = await tx.correctionPendingTimeAllocation.findMany({
      where: { applicationId: input.applicationId, activityId: input.activityId },
      include: { evidence: { orderBy: { ordinal: 'asc' } }, baseAllocationRevision: true },
      orderBy: [{ participationIdentityId: 'asc' }, { segmentKey: 'asc' }],
    });
    if (
      pending.length === 0 ||
      pending.length !== proof.expectedPendingCount ||
      sourceSnapshots.length !== proof.expectedSegmentCount ||
      proof.expectedBindingCount !== sourceSnapshots.length ||
      sourceSnapshots.reduce((total, source) => total + source.sliceCount, 0) !==
        proof.expectedSliceCount
    ) {
      return invalidCorrectionFact();
    }
    const pendingById = new Map(pending.map((row) => [row.id, row]));
    const pendingByKey = new Map(pending.map((row) => [sourcePairKey(row), row]));
    if (pendingById.size !== pending.length || pendingByKey.size !== pending.length)
      return invalidCorrectionFact();

    const createdAt = new Date();
    const allocationRows: Prisma.ParticipantTimeAllocationRevisionCreateManyInput[] = [];
    const sliceRows: Prisma.ParticipantTimeAllocationSliceCreateManyInput[] = [];
    const evidenceRows: Prisma.ParticipantTimeAllocationEvidenceCreateManyInput[] = [];
    const receiptRows: Prisma.ParticipantTimeAllocationCommandReceiptCreateManyInput[] = [];
    const bindingRows: Prisma.CorrectionTimeAllocationBindingCreateManyInput[] = [];

    for (const row of pending) {
      const source = sourceByKey.get(sourcePairKey(row));
      if (
        !source ||
        source.pendingAllocationId !== row.id ||
        source.baseAllocationRevisionId !== row.baseAllocationRevisionId ||
        source.allocationRevisionId !== row.targetAllocationRevisionId ||
        source.sourceSegmentId !== row.targetSegmentRevisionId
      ) {
        return invalidCorrectionFact();
      }
      const slices = parseCorrectionManifestSlices(row.allocationJson);
      if (slices.length !== row.sliceCount || row.evidence.length > 20)
        return invalidCorrectionFact();
      const base = row.baseAllocationRevision;
      if (
        base.activityId !== input.activityId ||
        base.participationIdentityId !== row.participationIdentityId ||
        base.segmentKey !== row.segmentKey ||
        base.id !== row.baseAllocationRevisionId
      ) {
        return invalidCorrectionFact();
      }
      allocationRows.push({
        id: row.targetAllocationRevisionId,
        activityId: input.activityId,
        sessionId: base.sessionId,
        memberId: base.memberId,
        participationIdentityId: row.participationIdentityId,
        segmentKey: row.segmentKey,
        revision: row.targetAllocationRevision,
        previousAllocationRevisionId: base.id,
        sourceSegmentId: row.targetSegmentRevisionId,
        sourceSegmentRevision: source.sourceSegmentRevision,
        sourcePositionId: base.sourcePositionId,
        ruleSnapshotId: row.ruleSnapshotId,
        ruleSnapshotHash: row.ruleSnapshotHash,
        timePolicySelectionRevisionId: row.timePolicySelectionRevisionId,
        selectionHash: row.selectionHash,
        policyId: base.policyId,
        policyVersionId: row.policyVersionId,
        definitionHash: row.definitionHash,
        evaluatorVersion: row.evaluatorVersion,
        settlementDraftVersionId: null,
        settlementEvidenceSealId: null,
        settlementEvidenceRevision: null,
        settlementPopulationRevision: null,
        settlementWorkflowRevision: null,
        settlementDraftContentHash: null,
        correctionPendingAllocationId: row.id,
        recognitionModeCode: row.recognitionModeCode,
        manualReason: row.manualReason,
        allocationJson: row.allocationJson as Prisma.InputJsonValue,
        allocationHash: row.allocationHash,
        sliceCount: row.sliceCount,
        createdAt,
        createdByUserId: input.actorUserId,
      });
      slices.forEach((slice, ordinal) => {
        sliceRows.push({
          id: randomUUID(),
          allocationRevisionId: row.targetAllocationRevisionId,
          activityId: input.activityId,
          ordinal,
          categoryCode: slice.categoryCode,
          intervalKindCode: slice.intervalKindCode,
          startAt: new Date(slice.startAt),
          endAt: new Date(slice.endAt),
        });
      });
      row.evidence.forEach((evidence) => {
        evidenceRows.push({
          id: randomUUID(),
          allocationRevisionId: row.targetAllocationRevisionId,
          activityId: input.activityId,
          attachmentId: evidence.attachmentId,
          ordinal: evidence.ordinal,
        });
      });
      const receipt = {
        schemaVersion: 1,
        activityId: input.activityId,
        allocationRevisionId: row.targetAllocationRevisionId,
        revision: row.targetAllocationRevision,
        sourceSegmentId: row.targetSegmentRevisionId,
        sourceSegmentRevision: source.sourceSegmentRevision,
        recognitionModeCode: row.recognitionModeCode,
        allocationHash: row.allocationHash,
        sliceCount: row.sliceCount,
        evidenceCount: row.evidence.length,
        createdAt: createdAt.toISOString(),
      };
      const operationKey = `correction-time-allocation:${input.applicationId}:${row.id}`;
      receiptRows.push({
        id: randomUUID(),
        actorUserId: input.actorUserId,
        operationCode: 'recognize_correction_time_allocation',
        operationKey,
        requestHash: fingerprintMetricEnvelope('correction-time-allocation-receipt-v1', {
          applicationId: input.applicationId,
          pendingAllocationId: row.id,
          allocationHash: row.allocationHash,
        }).definitionHash,
        activityId: input.activityId,
        allocationRevisionId: row.targetAllocationRevisionId,
        resultJson: receipt,
        createdAt,
      });
    }

    for (const source of sourceSnapshots) {
      const pendingRow =
        source.pendingAllocationId === null ? null : pendingById.get(source.pendingAllocationId);
      if (
        (source.pendingAllocationId === null && pendingByKey.has(sourcePairKey(source))) ||
        (source.pendingAllocationId !== null &&
          (!pendingRow ||
            pendingRow.participationIdentityId !== source.participationIdentityId ||
            pendingRow.segmentKey !== source.segmentKey ||
            pendingRow.targetSegmentRevisionId !== source.sourceSegmentId ||
            pendingRow.targetAllocationRevisionId !== source.allocationRevisionId))
      ) {
        return invalidCorrectionFact();
      }
      bindingRows.push({
        id: randomUUID(),
        proofId: proof.id,
        activityId: input.activityId,
        participationIdentityId: source.participationIdentityId,
        segmentKey: source.segmentKey,
        allocationRevisionId: source.allocationRevisionId,
        sourceSegmentId: source.sourceSegmentId,
        sourceSegmentRevision: source.sourceSegmentRevision,
        pendingAllocationId: source.pendingAllocationId,
        sourceHash: source.sourceHash,
      });
    }

    await createManyInFixedBatches(
      allocationRows,
      CORRECTION_ALLOCATION_SOURCE_WRITE_BATCH_SIZE,
      (data) => tx.participantTimeAllocationRevision.createMany({ data }),
    );
    if (sliceRows.length > 0) {
      await createManyInFixedBatches(
        sliceRows,
        CORRECTION_ALLOCATION_CHILD_WRITE_BATCH_SIZE,
        (data) => tx.participantTimeAllocationSlice.createMany({ data }),
      );
    }
    if (evidenceRows.length > 0) {
      await createManyInFixedBatches(
        evidenceRows,
        CORRECTION_ALLOCATION_CHILD_WRITE_BATCH_SIZE,
        (data) => tx.participantTimeAllocationEvidence.createMany({ data }),
      );
    }
    await createManyInFixedBatches(
      receiptRows,
      CORRECTION_ALLOCATION_SOURCE_WRITE_BATCH_SIZE,
      (data) => tx.participantTimeAllocationCommandReceipt.createMany({ data }),
    );
    await createCorrectionBindingsInOneStatement(tx, bindingRows);
    return pending.length;
  }

  private assertBaseAllocation(input: {
    activityId: string;
    pending: {
      participationIdentityId: string;
      segmentKey: string;
      baseRevisionId: string;
      baseRevisionNumber: number;
    };
    allocation: CorrectionAllocationChange;
    base: {
      id: string;
      activityId: string;
      participationIdentityId: string;
      segmentKey: string;
      sourceSegmentId: string;
      sourceSegmentRevision: number;
      sourceSegment: { id: string; revision: number; statusCode: string };
    };
  }): void {
    const { pending, allocation, base } = input;
    if (
      allocation.baseSegmentRevisionId !== pending.baseRevisionId ||
      allocation.baseAllocationRevisionId !== base.id ||
      base.activityId !== input.activityId ||
      base.participationIdentityId !== pending.participationIdentityId ||
      base.segmentKey !== pending.segmentKey ||
      base.sourceSegmentId !== pending.baseRevisionId ||
      base.sourceSegmentRevision !== pending.baseRevisionNumber ||
      base.sourceSegment.id !== pending.baseRevisionId ||
      base.sourceSegment.revision !== pending.baseRevisionNumber ||
      base.sourceSegment.statusCode !== 'committed'
    ) {
      invalidCorrectionFact();
    }
  }

  /**
   * Store a canonical, self-contained source record for every effective base
   * segment.  Changed rows point at their preallocated targets; unchanged rows
   * retain their exact committed source IDs.  The source hash therefore binds
   * both kinds of rows to the same immutable proof domain.
   */
  private snapshotSource(input: {
    segment: {
      id: string;
      participationIdentityId: string;
      segmentKey: string;
      revision: number;
    };
    base: {
      id: string;
      revision: number;
      ruleSnapshotId: string;
      ruleSnapshotHash: string;
      timePolicySelectionRevisionId: string;
      selectionHash: string;
      policyId: string;
      policyVersionId: string;
      definitionHash: string;
      evaluatorVersion: number;
      recognitionModeCode: string;
      manualReason: string | null;
      allocationHash: string;
    };
    sourceSegmentId: string;
    sourceSegmentRevision: number;
    allocationRevisionId: string;
    pendingAllocationId: string | null;
    slices: readonly ActivityTimeAllocationSliceInput[];
    allocationRevision?: number;
    recognitionModeCode?: string;
    manualReason?: string | null;
    allocationHash?: string;
  }): Record<string, unknown> {
    const row = {
      participationIdentityId: input.segment.participationIdentityId,
      segmentKey: input.segment.segmentKey,
      baseSegmentRevisionId: input.segment.id,
      baseSegmentRevision: input.segment.revision,
      sourceSegmentId: input.sourceSegmentId,
      sourceSegmentRevision: input.sourceSegmentRevision,
      baseAllocationRevisionId: input.base.id,
      allocationRevisionId: input.allocationRevisionId,
      allocationRevision: input.allocationRevision ?? input.base.revision,
      pendingAllocationId: input.pendingAllocationId,
      ruleSnapshotId: input.base.ruleSnapshotId,
      ruleSnapshotHash: input.base.ruleSnapshotHash,
      timePolicySelectionRevisionId: input.base.timePolicySelectionRevisionId,
      selectionHash: input.base.selectionHash,
      policyId: input.base.policyId,
      policyVersionId: input.base.policyVersionId,
      definitionHash: input.base.definitionHash,
      evaluatorVersion: input.base.evaluatorVersion,
      recognitionModeCode: input.recognitionModeCode ?? input.base.recognitionModeCode,
      manualReason: Object.prototype.hasOwnProperty.call(input, 'manualReason')
        ? (input.manualReason ?? null)
        : input.base.manualReason,
      allocationHash: input.allocationHash ?? input.base.allocationHash,
      sliceCount: input.slices.length,
      slices: input.slices.map((slice, ordinal) => ({
        ordinal,
        categoryCode: slice.categoryCode,
        intervalKindCode: slice.intervalKindCode,
        startAt: slice.startAt,
        endAt: slice.endAt,
      })),
    };
    return {
      ...row,
      sourceHash: fingerprintMetricEnvelope('correction-time-source-row-v1', row).definitionHash,
    };
  }

  private assertSelectionPointer(base: {
    sessionId: string;
    sourcePositionId: string | null;
    policyId: string;
    policyVersionId: string;
    definitionHash: string;
    ruleSnapshot: { resolvedConfig: Prisma.JsonValue };
    timePolicySelectionRevision: { selectionHash: string; selectionJson: Prisma.JsonValue };
  }): void {
    try {
      const selection = parseActivityTimePolicySelectionDocument(
        base.timePolicySelectionRevision.selectionJson,
      );
      if (
        activityTimePolicySelectionHash(selection) !==
        base.timePolicySelectionRevision.selectionHash
      )
        return invalidCorrectionFact();
      const targets = historicalTimePolicySelectionTargetsFromRuleSnapshot(
        base.ruleSnapshot.resolvedConfig,
      );
      const resolved = resolveActivityTimePolicySelection(selection, targets);
      const target = resolved.find(
        (candidate) =>
          candidate.scope.layerCode === (base.sourcePositionId === null ? 'session' : 'position') &&
          candidate.scope.sessionId === base.sessionId &&
          candidate.scope.positionId === base.sourcePositionId,
      );
      if (
        !target?.pointer ||
        target.pointer.policyId !== base.policyId ||
        target.pointer.versionId !== base.policyVersionId ||
        target.pointer.definitionHash !== base.definitionHash
      ) {
        invalidCorrectionFact();
      }
    } catch (error) {
      if (error instanceof BizException || error instanceof TypeError) invalidCorrectionFact();
      throw error;
    }
  }

  private resolveSlices(input: {
    allocation: CorrectionAllocationChange;
    base: {
      sessionId: string;
      sourcePositionId: string | null;
      ruleSnapshot: { resolvedConfig: Prisma.JsonValue };
    };
    policy: Parameters<typeof automaticTimeAllocationSlices>[0];
    pending: { checkInAt: Date; checkOutAt: Date };
    zeroOnly: boolean;
  }): readonly ActivityTimeAllocationSliceInput[] {
    if (input.zeroOnly) {
      if (
        input.allocation.recognitionModeCode !== 'automatic' ||
        input.allocation.manualReason !== null ||
        input.allocation.slices.length !== 0
      ) {
        return invalidCorrectionFact();
      }
      return [];
    }
    const slices =
      input.allocation.recognitionModeCode === 'automatic'
        ? automaticTimeAllocationSlices(
            input.policy,
            historicalAttendanceRoleFromRuleSnapshot(
              input.base.ruleSnapshot.resolvedConfig,
              input.base.sessionId,
              input.base.sourcePositionId,
            ),
            input.pending.checkInAt,
            input.pending.checkOutAt,
          )
        : (() => {
            assertManualTimeAllocationAllowed(input.policy);
            return input.allocation.slices.map((slice) => ({
              categoryCode: slice.categoryCode,
              intervalKindCode: slice.intervalKindCode,
              startAt: slice.startAt.toISOString(),
              endAt: slice.endAt.toISOString(),
            }));
          })();
    assertAllocationSlicesWithinSource(
      slices,
      input.pending.checkInAt,
      input.pending.checkOutAt,
      input.policy.allowSplit,
    );
    assertTimeAllocationEvidence(
      input.policy,
      input.allocation.recognitionModeCode,
      input.allocation.evidenceAttachmentIds.length,
    );
    return slices;
  }
}

function pairKey(
  input: Pick<CorrectionSegmentChange, 'participationIdentityId' | 'segmentKey'>,
): string {
  return `${input.participationIdentityId}\u0000${input.segmentKey}`;
}

function sourcePairKey(
  input: Pick<SourceSnapshotRow, 'participationIdentityId' | 'segmentKey'>,
): string {
  return `${input.participationIdentityId}\u0000${input.segmentKey}`;
}

function sourceSnapshotOrder(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return (
    compareText(String(left.participationIdentityId), String(right.participationIdentityId)) ||
    compareText(String(left.segmentKey), String(right.segmentKey))
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function slicesAreCanonical(
  slices: readonly {
    ordinal: number;
    categoryCode: string;
    intervalKindCode: string;
    startAt: Date;
    endAt: Date;
  }[],
): boolean {
  return slices.every(
    (slice, ordinal) =>
      slice.ordinal === ordinal &&
      isTimeCategory(slice.categoryCode) &&
      slice.intervalKindCode === 'service_segment' &&
      Number.isFinite(slice.startAt.getTime()) &&
      Number.isFinite(slice.endAt.getTime()) &&
      slice.startAt.getTime() < slice.endAt.getTime(),
  );
}

function canonicalStoredSlices(
  slices: readonly {
    ordinal: number;
    categoryCode: string;
    intervalKindCode: string;
    startAt: Date;
    endAt: Date;
  }[],
): readonly ActivityTimeAllocationSliceInput[] {
  if (!slicesAreCanonical(slices)) return invalidCorrectionFact();
  return slices.map((slice) => ({
    categoryCode: slice.categoryCode as ActivityTimeAllocationSliceInput['categoryCode'],
    intervalKindCode: 'service_segment',
    startAt: slice.startAt.toISOString(),
    endAt: slice.endAt.toISOString(),
  }));
}

function proofPrevalidationMatches(
  prevalidation: CorrectionTimeAllocationProofPrevalidation,
  proof: {
    id: string;
    applicationId: string;
    activityId: string;
    sourceSetHash: string;
    expectedSegmentCount: number;
    expectedPendingCount: number;
    expectedSliceCount: number;
    expectedBindingCount: number;
    formatVersion: number;
  },
  input: { applicationId: string; activityId: string },
): boolean {
  return (
    proof.id === prevalidation.proofId &&
    proof.applicationId === input.applicationId &&
    proof.applicationId === prevalidation.applicationId &&
    proof.activityId === input.activityId &&
    proof.activityId === prevalidation.activityId &&
    proof.sourceSetHash === prevalidation.sourceSetHash &&
    proof.expectedSegmentCount === prevalidation.expectedSegmentCount &&
    proof.expectedPendingCount === prevalidation.expectedPendingCount &&
    proof.expectedSliceCount === prevalidation.expectedSliceCount &&
    proof.expectedBindingCount === prevalidation.expectedBindingCount &&
    proof.formatVersion === prevalidation.formatVersion
  );
}

function parseSourceSnapshots(value: Prisma.JsonValue): readonly SourceSnapshotRow[] {
  if (!Array.isArray(value)) return invalidCorrectionFact();
  const rows = value.map((candidate) => {
    if (!isRecord(candidate)) return invalidCorrectionFact();
    const source = sourceSnapshotData(candidate);
    const row: SourceSnapshotRow = {
      participationIdentityId: text(candidate.participationIdentityId),
      segmentKey: text(candidate.segmentKey),
      baseSegmentRevisionId: text(candidate.baseSegmentRevisionId),
      baseSegmentRevision: integer(candidate.baseSegmentRevision, 1, 2147483647),
      sourceSegmentId: text(candidate.sourceSegmentId),
      sourceSegmentRevision: integer(candidate.sourceSegmentRevision, 1, 2147483647),
      baseAllocationRevisionId: text(candidate.baseAllocationRevisionId),
      allocationRevisionId: text(candidate.allocationRevisionId),
      pendingAllocationId:
        candidate.pendingAllocationId === null ? null : text(candidate.pendingAllocationId),
      sliceCount: integer(candidate.sliceCount, 0, 500),
      sourceHash: hash(candidate.sourceHash),
    };
    if (
      fingerprintMetricEnvelope('correction-time-source-row-v1', source).definitionHash !==
      row.sourceHash
    ) {
      return invalidCorrectionFact();
    }
    return row;
  });
  if (
    rows.length === 0 ||
    new Set(rows.map(sourcePairKey)).size !== rows.length ||
    rows.some((row, index) => index > 0 && sourcePairKey(rows[index - 1]) >= sourcePairKey(row))
  ) {
    return invalidCorrectionFact();
  }
  return rows;
}

function sourceSnapshotData(candidate: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'participationIdentityId',
    'segmentKey',
    'baseSegmentRevisionId',
    'baseSegmentRevision',
    'sourceSegmentId',
    'sourceSegmentRevision',
    'baseAllocationRevisionId',
    'allocationRevisionId',
    'allocationRevision',
    'pendingAllocationId',
    'ruleSnapshotId',
    'ruleSnapshotHash',
    'timePolicySelectionRevisionId',
    'selectionHash',
    'policyId',
    'policyVersionId',
    'definitionHash',
    'evaluatorVersion',
    'recognitionModeCode',
    'manualReason',
    'allocationHash',
    'sliceCount',
    'slices',
    'sourceHash',
  ] as const;
  if (Object.keys(candidate).length !== keys.length || keys.some((key) => !(key in candidate)))
    return invalidCorrectionFact();
  for (const key of [
    'participationIdentityId',
    'segmentKey',
    'baseSegmentRevisionId',
    'sourceSegmentId',
    'baseAllocationRevisionId',
    'allocationRevisionId',
    'ruleSnapshotId',
    'timePolicySelectionRevisionId',
    'policyId',
    'policyVersionId',
  ]) {
    text(candidate[key]);
  }
  for (const key of [
    'ruleSnapshotHash',
    'selectionHash',
    'definitionHash',
    'allocationHash',
    'sourceHash',
  ]) {
    hash(candidate[key]);
  }
  for (const key of [
    'baseSegmentRevision',
    'sourceSegmentRevision',
    'allocationRevision',
    'evaluatorVersion',
    'sliceCount',
  ]) {
    integer(candidate[key], 0, 2147483647);
  }
  if (candidate.pendingAllocationId !== null && typeof candidate.pendingAllocationId !== 'string') {
    return invalidCorrectionFact();
  }
  if (candidate.recognitionModeCode !== 'automatic' && candidate.recognitionModeCode !== 'manual')
    return invalidCorrectionFact();
  if (candidate.manualReason !== null && typeof candidate.manualReason !== 'string')
    return invalidCorrectionFact();
  if (!Array.isArray(candidate.slices) || candidate.slices.length !== candidate.sliceCount)
    return invalidCorrectionFact();
  const slices = candidate.slices.map((slice, ordinal) => {
    if (!isRecord(slice) || Object.keys(slice).length !== 5) return invalidCorrectionFact();
    if (integer(slice.ordinal, 0, 500) !== ordinal) return invalidCorrectionFact();
    if (!isTimeCategory(slice.categoryCode) || slice.intervalKindCode !== 'service_segment')
      return invalidCorrectionFact();
    const startAt = instant(slice.startAt);
    const endAt = instant(slice.endAt);
    if (startAt >= endAt) return invalidCorrectionFact();
    return {
      ordinal,
      categoryCode: slice.categoryCode,
      intervalKindCode: 'service_segment',
      startAt,
      endAt,
    };
  });
  if (slices.length > 500) return invalidCorrectionFact();
  const source = { ...candidate };
  delete source.sourceHash;
  return source;
}

function parseCorrectionManifestSlices(
  value: Prisma.JsonValue,
): readonly ActivityTimeAllocationSliceInput[] {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.schemaVersion !== 1 ||
    !isRecord(value.slices)
  )
    return invalidCorrectionFact();
  const rows = Object.entries(value.slices)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([key, candidate]) => {
      if (!/^0$|^[1-9][0-9]{0,2}$/u.test(key) || !isRecord(candidate))
        return invalidCorrectionFact();
      if (Object.keys(candidate).length !== 5) return invalidCorrectionFact();
      const ordinal = integer(candidate.ordinal, 0, 500);
      if (String(ordinal) !== key) return invalidCorrectionFact();
      const categoryCode = candidate.categoryCode;
      if (!isTimeCategory(categoryCode)) {
        return invalidCorrectionFact();
      }
      const startAt = instant(candidate.startAt);
      const endAt = instant(candidate.endAt);
      if (candidate.intervalKindCode !== 'service_segment' || startAt >= endAt)
        return invalidCorrectionFact();
      return {
        categoryCode,
        intervalKindCode: 'service_segment' as const,
        startAt,
        endAt,
      };
    });
  if (rows.length > 500) return invalidCorrectionFact();
  return rows;
}

function isTimeCategory(value: unknown): value is ActivityTimeAllocationSliceInput['categoryCode'] {
  return (
    value === 'volunteer_service' ||
    value === 'training' ||
    value === 'organization' ||
    value === 'non_creditable'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128)
    return invalidCorrectionFact();
  return value;
}

function hash(value: unknown): string {
  const parsed = text(value);
  if (!/^[a-f0-9]{64}$/u.test(parsed)) return invalidCorrectionFact();
  return parsed;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum)
    return invalidCorrectionFact();
  return value;
}

function instant(value: unknown): string {
  const parsed = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed))
    return invalidCorrectionFact();
  const date = new Date(parsed);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== parsed)
    return invalidCorrectionFact();
  return parsed;
}

function invalidCorrectionFact(): never {
  throw new BizException(BizCode.CORRECTION_CHANGE_SET_INVALID);
}
