import { Injectable } from '@nestjs/common';
import { Prisma, type ParticipationTimeCorrectionManifest } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { parseCorrectionChangeSet, type CorrectionTimeChange } from './correction-change-set';
import {
  buildParticipationTimeCorrection,
  TimeCorrectionPolicyError,
} from './participation-time-correction-policy';

interface CorrectionSourceAnchor {
  correctionRequestId: string;
  postingBatchId: string;
  activityId: string;
  settlementRunId: string;
  baseSettlementVersionId: string;
  settlementVersionId: string;
  requestHash: string;
}

/** The caller owns Activity/run/version/batch locks and the entire correction transaction. */
@Injectable()
export class ParticipationTimeCorrectionService {
  async isCorrectionBatch(tx: Prisma.TransactionClient, postingBatchId: string) {
    const [result] = await tx.$queryRaw<{ required: boolean; classifiedBase: boolean }[]>`
      WITH applications AS (
        SELECT q."requestedChangeJson", q."baseSettlementVersionId" FROM "CorrectionApplication" a
        JOIN "AttendanceCorrectionRequest" q ON q."id" = a."correctionRequestId"
        WHERE a."newPostingBatchId" = ${postingBatchId}
      )
      SELECT EXISTS(SELECT 1 FROM applications WHERE "requestedChangeJson"->'schemaVersion' = '2'::jsonb) AS required,
        EXISTS(SELECT 1 FROM applications a WHERE
          EXISTS(SELECT 1 FROM "ParticipationTimeLedgerManifest" m WHERE m."settlementVersionId" = a."baseSettlementVersionId")
          OR EXISTS(SELECT 1 FROM "ParticipationTimeCorrectionManifest" m WHERE m."settlementVersionId" = a."baseSettlementVersionId")
        ) AS "classifiedBase"
    `;
    // Same legacy exclusion as assertNotClassifiedCorrectionBatch, in the same
    // bounded probe: ordinary D6 posting must not pay for a second application read.
    if (!result.required && result.classifiedBase)
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_CORRECTION_UNAVAILABLE);
    return result.required;
  }

  async source(
    tx: Prisma.TransactionClient,
    anchor: CorrectionSourceAnchor,
    change: CorrectionTimeChange,
  ) {
    if (change.baseSettlementVersionId !== anchor.baseSettlementVersionId) this.invalid();
    const anchors = await tx.$queryRaw<
      {
        id: string;
        settlementVersionId: string;
        expectedEntryCount: number;
        baseContentHash: string;
        predecessorManifestId: string | null;
      }[]
    >`
      SELECT root."id", root."settlementVersionId", root."expectedEntryCount",
        root."contentHash" AS "baseContentHash", NULL::text AS "predecessorManifestId"
      FROM "ParticipationTimeLedgerManifest" root
      JOIN "LedgerPostingBatch" b ON b."id" = root."postingBatchId" AND b."statusCode" = 'committed'
      WHERE root."settlementVersionId" = ${anchor.baseSettlementVersionId}
        AND root."activityId" = ${anchor.activityId} AND root."settlementRunId" = ${anchor.settlementRunId}
      UNION ALL
      SELECT root."id", root."settlementVersionId", root."expectedEntryCount", m."contentHash", m."id"
      FROM "ParticipationTimeCorrectionManifest" m
      JOIN "ParticipationTimeCorrectionCommitReceipt" r ON r."manifestId" = m."id" AND r."contentHash" = m."contentHash"
      JOIN "LedgerPostingBatch" b ON b."id" = m."postingBatchId" AND b."statusCode" = 'committed'
      JOIN "ParticipationTimeLedgerManifest" root ON root."id" = m."rootManifestId"
        AND root."activityId" = m."activityId" AND root."settlementRunId" = m."settlementRunId"
      JOIN "LedgerPostingBatch" rb ON rb."id" = root."postingBatchId" AND rb."statusCode" = 'committed'
      WHERE m."settlementVersionId" = ${anchor.baseSettlementVersionId}
        AND m."activityId" = ${anchor.activityId} AND m."settlementRunId" = ${anchor.settlementRunId}
      LIMIT 2
    `;
    if (anchors.length !== 1 || anchors[0].baseContentHash !== change.baseTimeLedgerHash)
      this.invalid();
    const root = anchors[0];
    const roots = await tx.$queryRaw<
      {
        id: string;
        manifestId: string;
        participationIdentityId: string;
        categoryCode: string;
        recognizedSeconds: number;
        previousEntryId: string | null;
        previousSeconds: number | null;
      }[]
    >`
      SELECT e."id", e."manifestId", e."participationIdentityId", e."categoryCode", e."recognizedSeconds",
        p."id" AS "previousEntryId", p."secondsDelta" AS "previousSeconds"
      FROM "ParticipationTimeLedgerEntry" e
      LEFT JOIN "ParticipationTimeCorrectionEntry" p ON p."manifestId" = ${root.predecessorManifestId}
        AND p."rootEntryId" = e."id" AND p."entryTypeCode" = 'credit'
        AND p."participationIdentityId" = e."participationIdentityId" AND p."categoryCode" = e."categoryCode"
      WHERE e."manifestId" = ${root.id} ORDER BY e."id" LIMIT 8001
    `;
    const previous = root.predecessorManifestId
      ? roots.flatMap((entry) => {
          if (entry.previousEntryId === null || entry.previousSeconds === null) return [];
          return [
            {
              id: entry.previousEntryId,
              manifestId: root.predecessorManifestId as string,
              rootEntryId: entry.id,
              participationIdentityId: entry.participationIdentityId,
              categoryCode: entry.categoryCode,
              entryTypeCode: 'credit',
              secondsDelta: entry.previousSeconds,
            },
          ];
        })
      : [];
    if (roots.length !== root.expectedEntryCount) this.invalid();
    try {
      return buildParticipationTimeCorrection(
        {
          correctionRequestId: anchor.correctionRequestId,
          postingBatchId: anchor.postingBatchId,
          activityId: anchor.activityId,
          settlementRunId: anchor.settlementRunId,
          baseSettlementVersionId: anchor.baseSettlementVersionId,
          settlementVersionId: anchor.settlementVersionId,
          requestHash: anchor.requestHash,
          rootManifestId: root.id,
          rootSettlementVersionId: root.settlementVersionId,
          predecessorManifestId: root.predecessorManifestId,
          baseContentHash: change.baseTimeLedgerHash,
        },
        roots,
        change.items,
        previous,
      );
    } catch (error) {
      if (!(error instanceof TimeCorrectionPolicyError)) throw error;
      throw new BizException(
        error.reason === 'scale_limit'
          ? BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT
          : BizCode.ACTIVITY_TIME_LEDGER_SOURCE_INVALID,
      );
    }
  }

  async prepare(
    tx: Prisma.TransactionClient,
    source: Awaited<ReturnType<ParticipationTimeCorrectionService['source']>>,
  ) {
    const manifest = await tx.participationTimeCorrectionManifest.create({ data: source.manifest });
    const created = await tx.participationTimeCorrectionEntry.createMany({
      data: source.entries.map((entry) => ({ ...entry, manifestId: manifest.id })),
    });
    if (created.count !== source.entries.length)
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_NOT_READY);
    return manifest;
  }

  /** Recompute against only the immutable root and immediate predecessor, never latest/policy. */
  async assertComplete(
    tx: Prisma.TransactionClient,
    postingBatchId: string,
    requireReceipt: boolean,
  ) {
    const [manifest] = await tx.$queryRaw<
      (ParticipationTimeCorrectionManifest & {
        requestedChangeJson: Prisma.JsonValue;
        storedRequestHash: string | null;
        receiptContentHash: string | null;
      })[]
    >`
      SELECT m.*, q."requestedChangeJson", q."requestHash" AS "storedRequestHash", r."contentHash" AS "receiptContentHash"
      FROM "ParticipationTimeCorrectionManifest" m
      JOIN "AttendanceCorrectionRequest" q ON q."id" = m."correctionRequestId"
      LEFT JOIN "ParticipationTimeCorrectionCommitReceipt" r ON r."manifestId" = m."id"
      WHERE m."postingBatchId" = ${postingBatchId}
    `;
    if (!manifest) throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_NOT_READY);
    const change = parseCorrectionChangeSet(manifest.requestedChangeJson).timeCorrection;
    if (!change || manifest.requestHash !== manifest.storedRequestHash) this.invalid();
    const expected = await this.source(tx, manifest, change);
    if (
      Object.keys(expected.manifest).some(
        (key) => Reflect.get(manifest, key) !== Reflect.get(expected.manifest, key),
      )
    ) {
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_CONTENT_CONFLICT);
    }
    const rows = await tx.participationTimeCorrectionEntry.findMany({
      where: { manifestId: manifest.id },
      take: 16001,
    });
    const byKey = new Map(expected.entries.map((entry) => [entry.entryKey, entry]));
    if (rows.length !== expected.entries.length)
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_NOT_READY);
    for (const row of rows) {
      const target = byKey.get(row.entryKey);
      if (
        !target ||
        Object.keys(target).some((key) => Reflect.get(row, key) !== Reflect.get(target, key))
      ) {
        throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_CONTENT_CONFLICT);
      }
    }
    if (requireReceipt && manifest.receiptContentHash !== manifest.contentHash) {
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_NOT_READY);
    }
    return manifest;
  }

  /** Only the outer CorrectionApplicationService calls this, never the shared ledger committer. */
  async createCommitReceipt(tx: Prisma.TransactionClient, postingBatchId: string) {
    const locked = await tx.$queryRaw<
      (ParticipationTimeCorrectionManifest & { batchStatus: string })[]
    >`
      SELECT m.*, b."statusCode" AS "batchStatus" FROM "LedgerPostingBatch" b
      JOIN "ParticipationTimeCorrectionManifest" m ON m."postingBatchId" = b."id"
      WHERE b."id" = ${postingBatchId} FOR UPDATE OF b
    `;
    if (locked.length !== 1 || locked[0].batchStatus !== 'ready')
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_NOT_READY);
    // The receipt INSERT trigger checks complete pairing here. The shared commit
    // protocol still performs both independent canonical and authorization checks.
    const manifest = locked[0];
    return tx.participationTimeCorrectionCommitReceipt.create({
      data: {
        manifestId: manifest.id,
        postingBatchId,
        activityId: manifest.activityId,
        settlementRunId: manifest.settlementRunId,
        baseSettlementVersionId: manifest.baseSettlementVersionId,
        settlementVersionId: manifest.settlementVersionId,
        contentHash: manifest.contentHash,
      },
    });
  }

  rethrowConstraint(error: unknown): never {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) &&
      !(error instanceof Prisma.PrismaClientUnknownRequestError)
    )
      throw error;
    const known = error instanceof Prisma.PrismaClientKnownRequestError ? error : null;
    if (known && !['P2002', 'P2003', 'P2004', 'P2010'].includes(known.code)) throw error;
    if (known?.code === 'P2010' && !['23503', '23505', '23514'].includes(String(known.meta?.code)))
      throw error;
    const details = [
      error.message,
      known?.meta?.constraint,
      known?.meta?.field_name,
      known?.meta?.database_error,
      known?.meta?.message,
      known?.meta?.target,
    ]
      .filter((value) => typeof value === 'string')
      .join(' ');
    const names = new Set(details.match(/\bptc[a-z0-9_]+\b/gu) ?? []);
    if (
      ['ptc_visibility_guard', 'ptc_commit_closure_guard', 'ptcr_insert_guard'].some((name) =>
        names.has(name),
      )
    )
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_NOT_READY);
    if (
      [
        'ptcm_batch_key',
        'ptce_entry_key',
        'ptce_manifest_root_type_key',
        'ptcr_manifest_key',
        'ptcr_base_version_key',
      ].some((name) => names.has(name))
    )
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_CONTENT_CONFLICT);
    if (
      [
        'ptcm_format_check',
        'ptcm_hash_check',
        'ptcm_counts_check',
        'ptcm_totals_check',
        'ptcm_versions_check',
        'ptcm_batch_fkey',
        'ptcm_root_fkey',
        'ptcm_request_fkey',
        'ptcm_predecessor_fkey',
        'ptcm_insert_guard',
        'ptce_category_check',
        'ptce_type_amount_check',
        'ptce_hash_check',
        'ptce_manifest_fkey',
        'ptce_root_fkey',
        'ptce_reverses_fkey',
        'ptce_insert_guard',
        'ptcr_hash_check',
        'ptcr_manifest_fkey',
      ].some((name) => names.has(name))
    )
      this.invalid();
    throw error;
  }

  private invalid(): never {
    throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_SOURCE_INVALID);
  }
}
