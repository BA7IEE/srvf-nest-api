import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { splitSpanByBeijingDay } from '../../common/datetime/date-only.util';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import type { ActivityTimeCutoverReceiptResult } from './activity-time-cutover-command';
import {
  ACTIVITY_TIME_CUTOVER_RECEIPT_ID,
  verifyActivityTimeCutoverReceipt,
} from './activity-time-cutover-command';
import { TIME_SETTLEMENT_CATEGORIES } from './activity-time-settlement-policy';

export const PARTICIPATION_TIME_PROOF_MAX_ROWS = 10_000;

export type ParticipationTimeSourceCategory =
  | 'legacy_recognized_service'
  | (typeof TIME_SETTLEMENT_CATEGORIES)[number];

export interface ParticipationTimeTruthItem {
  ledgerDate: string;
  activityId: string;
  rootManifestId: string | null;
  participationIdentityId: string;
  sourceCategoryCode: ParticipationTimeSourceCategory;
  sourceEntryId: string;
  latestCorrectionManifestId: string | null;
  sourceMode: 'legacy_ledger' | 'classified_time_ledger';
  recognizedSeconds: number;
}

export interface ParticipationTimeTruthSet {
  receipt: ActivityTimeCutoverReceiptResult;
  asOf: string;
  items: ParticipationTimeTruthItem[];
}

interface LegacyRow {
  ledgerDate: string;
  activityId: string;
  rootManifestId: string | null;
  participationIdentityId: string;
  sourceEntryId: string;
  recognizedSeconds: bigint;
}

interface ClassifiedRootRow {
  rootEntryId: string;
  rootManifestId: string;
  activityId: string;
  participationIdentityId: string;
  categoryCode: string;
  recognizedSeconds: number;
}

interface CorrectionManifestRow {
  id: string;
  rootManifestId: string;
  predecessorManifestId: string | null;
  sourceProofId: string | null;
  sourceProofHash: string | null;
  contentHash: string;
  receiptContentHash: string | null;
  createdAt: Date;
}

interface CorrectionEntryRow {
  manifestId: string;
  rootEntryId: string;
  participationIdentityId: string;
  categoryCode: string;
  secondsDelta: number;
}

interface SliceRow {
  rootEntryId: string | null;
  proofId: string | null;
  participationIdentityId: string;
  sliceId: string;
  categoryCode: string;
  startAt: Date;
  endAt: Date;
}

interface SourceProofRow {
  id: string;
  rootManifestId: string;
  sourceSetHash: string;
  expectedBindingCount: number;
  actualBindingCount: bigint;
}

interface WeightedDate {
  ledgerDate: string;
  milliseconds: bigint;
}

function invalidTruth(): never {
  throw new BizException(BizCode.ACTIVITY_TIME_PROOF_INVALID);
}

function toSafeSeconds(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) invalidTruth();
  return Number(value);
}

/** Split one UTC interval into exact Beijing natural-day millisecond weights. */
export function splitIntervalByBeijingDate(startAt: Date, endAt: Date): WeightedDate[] {
  if (
    !Number.isFinite(startAt.getTime()) ||
    !Number.isFinite(endAt.getTime()) ||
    startAt.getTime() >= endAt.getTime()
  ) {
    invalidTruth();
  }
  const slices = splitSpanByBeijingDay(startAt, endAt);
  if (slices.length > 3_000) invalidTruth();
  return slices.map((slice) => ({
    ledgerDate: slice.ledgerDate.toISOString().slice(0, 10),
    milliseconds: BigInt(slice.milliseconds),
  }));
}

/** Integer largest-remainder allocation; totals are exact and ties are date-stable. */
export function allocateSecondsByDate(
  totalSeconds: number,
  slices: readonly Pick<SliceRow, 'sliceId' | 'startAt' | 'endAt'>[],
): Array<{ ledgerDate: string; recognizedSeconds: number }> {
  if (!Number.isSafeInteger(totalSeconds) || totalSeconds < 0) invalidTruth();
  if (totalSeconds === 0) return [];
  const byDate = new Map<string, bigint>();
  for (const slice of [...slices].sort(
    (left, right) =>
      left.startAt.getTime() - right.startAt.getTime() ||
      left.endAt.getTime() - right.endAt.getTime() ||
      left.sliceId.localeCompare(right.sliceId),
  )) {
    for (const piece of splitIntervalByBeijingDate(slice.startAt, slice.endAt)) {
      byDate.set(piece.ledgerDate, (byDate.get(piece.ledgerDate) ?? 0n) + piece.milliseconds);
    }
  }
  const weighted = [...byDate.entries()]
    .map(([ledgerDate, milliseconds]) => ({ ledgerDate, milliseconds }))
    .sort((left, right) => left.ledgerDate.localeCompare(right.ledgerDate));
  const totalWeight = weighted.reduce((sum, row) => sum + row.milliseconds, 0n);
  if (totalWeight <= 0n) invalidTruth();
  const total = BigInt(totalSeconds);
  const provisional = weighted.map((row) => {
    const numerator = total * row.milliseconds;
    return {
      ledgerDate: row.ledgerDate,
      seconds: numerator / totalWeight,
      remainder: numerator % totalWeight,
    };
  });
  let missing = total - provisional.reduce((sum, row) => sum + row.seconds, 0n);
  const ranked = provisional
    .map((row, index) => ({ ...row, index }))
    .sort((left, right) =>
      left.remainder === right.remainder
        ? left.ledgerDate.localeCompare(right.ledgerDate)
        : left.remainder > right.remainder
          ? -1
          : 1,
    );
  for (const row of ranked) {
    if (missing === 0n) break;
    provisional[row.index].seconds += 1n;
    missing -= 1n;
  }
  if (missing !== 0n) invalidTruth();
  return provisional.map((row) => ({
    ledgerDate: row.ledgerDate,
    recognizedSeconds: toSafeSeconds(row.seconds),
  }));
}

function compareTruthItems(left: ParticipationTimeTruthItem, right: ParticipationTimeTruthItem) {
  return (
    left.ledgerDate.localeCompare(right.ledgerDate) ||
    left.activityId.localeCompare(right.activityId) ||
    (left.rootManifestId ?? '').localeCompare(right.rootManifestId ?? '') ||
    left.participationIdentityId.localeCompare(right.participationIdentityId) ||
    left.sourceCategoryCode.localeCompare(right.sourceCategoryCode) ||
    left.sourceEntryId.localeCompare(right.sourceEntryId)
  );
}

function sliceGroupKey(first: string, second: string, third: string): string {
  return `${first}\u0000${second}\u0000${third}`;
}

function groupSlices(
  rows: readonly SliceRow[],
  keyOf: (row: SliceRow) => string | null,
): Map<string, SliceRow[]> {
  const grouped = new Map<string, SliceRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null) continue;
    const existing = grouped.get(key);
    if (existing) existing.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

function latestManifestsByRoot(
  roots: readonly string[],
  manifests: readonly CorrectionManifestRow[],
): Map<string, CorrectionManifestRow | null> {
  const result = new Map<string, CorrectionManifestRow | null>();
  const manifestsByRoot = new Map<string, CorrectionManifestRow[]>();
  for (const manifest of manifests) {
    const existing = manifestsByRoot.get(manifest.rootManifestId);
    if (existing) existing.push(manifest);
    else manifestsByRoot.set(manifest.rootManifestId, [manifest]);
  }
  for (const rootId of roots) {
    const rows = manifestsByRoot.get(rootId) ?? [];
    if (rows.length === 0) {
      result.set(rootId, null);
      continue;
    }
    if (
      rows.some(
        (row) =>
          row.receiptContentHash !== row.contentHash ||
          (row.sourceProofId === null) !== (row.sourceProofHash === null),
      )
    ) {
      invalidTruth();
    }
    const byId = new Map(rows.map((row) => [row.id, row]));
    const children = new Map<string, CorrectionManifestRow>();
    for (const row of rows) {
      if (row.predecessorManifestId === null) continue;
      if (!byId.has(row.predecessorManifestId) || children.has(row.predecessorManifestId)) {
        invalidTruth();
      }
      children.set(row.predecessorManifestId, row);
    }
    const heads = rows.filter((row) => row.predecessorManifestId === null);
    if (heads.length !== 1) invalidTruth();
    let cursor = heads[0];
    const visited = new Set<string>();
    while (true) {
      if (visited.has(cursor.id)) invalidTruth();
      visited.add(cursor.id);
      const child = children.get(cursor.id);
      if (!child) break;
      cursor = child;
    }
    if (visited.size !== rows.length) invalidTruth();
    result.set(rootId, cursor);
  }
  return result;
}

@Injectable()
export class ParticipationTimeTruthQueryService {
  async readMemberTruthInTx(
    tx: Prisma.TransactionClient,
    input: { memberId: string; dateFrom: string; dateTo: string },
  ): Promise<ParticipationTimeTruthSet> {
    const receipt = await tx.activityTimeCutoverReceipt.findUnique({
      where: { id: ACTIVITY_TIME_CUTOVER_RECEIPT_ID },
    });
    if (!receipt) throw new BizException(BizCode.ACTIVITY_TIME_PROOF_UNAVAILABLE);
    const verifiedReceipt = verifyActivityTimeCutoverReceipt(receipt);
    const [legacyRows, roots, clock] = await Promise.all([
      this.readLegacy(tx, input),
      this.readClassifiedRoots(tx, input.memberId),
      tx.$queryRaw<Array<{ asOf: Date }>>`SELECT transaction_timestamp() AS "asOf"`,
    ]);
    const legacy = await this.validateLegacyCorrectionChains(tx, legacyRows);
    const classified = await this.materializeClassified(tx, roots, input);
    const items = [...legacy, ...classified].sort(compareTruthItems);
    if (items.length > PARTICIPATION_TIME_PROOF_MAX_ROWS) {
      throw new BizException(BizCode.ACTIVITY_TIME_PROOF_SCALE_LIMIT);
    }
    return {
      receipt: verifiedReceipt,
      asOf: (clock[0]?.asOf ?? new Date(0)).toISOString(),
      items,
    };
  }

  private async readLegacy(
    tx: Prisma.TransactionClient,
    input: { memberId: string; dateFrom: string; dateTo: string },
  ): Promise<ParticipationTimeTruthItem[]> {
    const rows = await tx.$queryRaw<LegacyRow[]>`
      SELECT to_char(entry."ledgerDate", 'YYYY-MM-DD') AS "ledgerDate",
        entry."activityId", COALESCE(correction."rootManifestId", ordinary.id) AS "rootManifestId",
        entry."participationIdentityId", min(entry.id) AS "sourceEntryId",
        ((sum(entry."serviceHoursDelta") * 100)::bigint * 36) AS "recognizedSeconds"
      FROM "ParticipationLedgerEntry" entry
      JOIN "LedgerPostingBatch" batch
        ON batch.id = entry."postingBatchId" AND batch."statusCode" = 'committed'
      LEFT JOIN "ParticipationTimeLedgerManifest" ordinary
        ON ordinary."postingBatchId" = batch.id
      LEFT JOIN "ParticipationTimeCorrectionManifest" correction
        ON correction."postingBatchId" = batch.id
      WHERE entry."memberId" = ${input.memberId}
        AND entry."ledgerDate" >= ${new Date(`${input.dateFrom}T00:00:00.000Z`)}::date
        AND entry."ledgerDate" <= ${new Date(`${input.dateTo}T00:00:00.000Z`)}::date
        AND NOT EXISTS (
          SELECT 1 FROM "ParticipationTimeCutoverBinding" binding
          WHERE binding."rootManifestId" = COALESCE(correction."rootManifestId", ordinary.id)
        )
      GROUP BY entry."ledgerDate", entry."activityId",
        COALESCE(correction."rootManifestId", ordinary.id), entry."participationIdentityId"
      HAVING sum(entry."serviceHoursDelta") <> 0
      ORDER BY entry."ledgerDate", entry."activityId",
        COALESCE(correction."rootManifestId", ordinary.id), entry."participationIdentityId"
      LIMIT ${PARTICIPATION_TIME_PROOF_MAX_ROWS + 1}
    `;
    if (rows.length > PARTICIPATION_TIME_PROOF_MAX_ROWS) {
      throw new BizException(BizCode.ACTIVITY_TIME_PROOF_SCALE_LIMIT);
    }
    return rows.map((row) => ({
      ledgerDate: row.ledgerDate,
      activityId: row.activityId,
      rootManifestId: row.rootManifestId,
      participationIdentityId: row.participationIdentityId,
      sourceCategoryCode: 'legacy_recognized_service',
      sourceEntryId: row.sourceEntryId,
      latestCorrectionManifestId: null,
      sourceMode: 'legacy_ledger',
      recognizedSeconds: toSafeSeconds(row.recognizedSeconds),
    }));
  }

  private async readClassifiedRoots(
    tx: Prisma.TransactionClient,
    memberId: string,
  ): Promise<ClassifiedRootRow[]> {
    const rows = await tx.$queryRaw<ClassifiedRootRow[]>`
      SELECT entry.id AS "rootEntryId", entry."manifestId" AS "rootManifestId",
        entry."activityId", entry."participationIdentityId", entry."categoryCode",
        entry."recognizedSeconds"
      FROM "ParticipationTimeLedgerEntry" entry
      JOIN "ParticipationTimeLedgerManifest" root ON root.id = entry."manifestId"
      JOIN "ParticipationTimeCutoverBinding" binding
        ON binding."rootManifestId" = root.id
        AND binding."postingBatchId" = root."postingBatchId"
        AND binding."activityId" = root."activityId"
        AND binding."settlementRunId" = root."settlementRunId"
        AND binding."settlementVersionId" = root."settlementVersionId"
        AND binding."rootContentHash" = root."contentHash"
      JOIN "LedgerPostingBatch" batch
        ON batch.id = root."postingBatchId" AND batch."statusCode" = 'committed'
      JOIN "ActivityParticipationIdentity" identity
        ON identity.id = entry."participationIdentityId"
        AND identity."activityId" = entry."activityId"
      WHERE identity."memberId" = ${memberId}
      ORDER BY root.id, entry.id
      LIMIT ${PARTICIPATION_TIME_PROOF_MAX_ROWS + 1}
    `;
    if (rows.length > PARTICIPATION_TIME_PROOF_MAX_ROWS) {
      throw new BizException(BizCode.ACTIVITY_TIME_PROOF_SCALE_LIMIT);
    }
    if (
      rows.some(
        (row) =>
          !TIME_SETTLEMENT_CATEGORIES.includes(
            row.categoryCode as (typeof TIME_SETTLEMENT_CATEGORIES)[number],
          ) ||
          !Number.isSafeInteger(row.recognizedSeconds) ||
          row.recognizedSeconds < 0,
      )
    ) {
      invalidTruth();
    }
    return rows;
  }

  private async validateLegacyCorrectionChains(
    tx: Prisma.TransactionClient,
    items: readonly ParticipationTimeTruthItem[],
  ): Promise<ParticipationTimeTruthItem[]> {
    const rootIds = [
      ...new Set(
        items
          .map((item) => item.rootManifestId)
          .filter((rootManifestId): rootManifestId is string => rootManifestId !== null),
      ),
    ];
    if (rootIds.length === 0) return [...items];
    const manifests = await tx.$queryRaw<CorrectionManifestRow[]>(Prisma.sql`
      SELECT manifest.id, manifest."rootManifestId", manifest."predecessorManifestId",
        manifest."sourceProofId", manifest."sourceProofHash", manifest."contentHash",
        receipt."contentHash" AS "receiptContentHash", manifest."createdAt"
      FROM "ParticipationTimeCorrectionManifest" manifest
      JOIN "LedgerPostingBatch" batch
        ON batch.id = manifest."postingBatchId" AND batch."statusCode" = 'committed'
      LEFT JOIN "ParticipationTimeCorrectionCommitReceipt" receipt
        ON receipt."manifestId" = manifest.id
      WHERE manifest."rootManifestId" IN (${Prisma.join(rootIds)})
      ORDER BY manifest."rootManifestId", manifest."createdAt", manifest.id
    `);
    const latestByRoot = latestManifestsByRoot(rootIds, manifests);
    const latestWithProof = [...latestByRoot.values()].filter(
      (row): row is CorrectionManifestRow => row !== null && row.sourceProofId !== null,
    );
    if (latestWithProof.length > 0) {
      const proofIds = [...new Set(latestWithProof.map((row) => row.sourceProofId as string))];
      const proofs = await tx.$queryRaw<SourceProofRow[]>(Prisma.sql`
        SELECT proof.id, proof."rootManifestId", proof."sourceSetHash",
          proof."expectedBindingCount", count(binding.id)::bigint AS "actualBindingCount"
        FROM "CorrectionTimeSourceProof" proof
        LEFT JOIN "CorrectionTimeAllocationBinding" binding ON binding."proofId" = proof.id
        WHERE proof.id IN (${Prisma.join(proofIds)})
        GROUP BY proof.id
        ORDER BY proof.id
      `);
      this.verifyProofs(latestWithProof, proofs);
    }
    return items.map((item) => ({
      ...item,
      latestCorrectionManifestId:
        item.rootManifestId === null ? null : (latestByRoot.get(item.rootManifestId)?.id ?? null),
    }));
  }

  private async materializeClassified(
    tx: Prisma.TransactionClient,
    roots: readonly ClassifiedRootRow[],
    input: { dateFrom: string; dateTo: string },
  ): Promise<ParticipationTimeTruthItem[]> {
    if (roots.length === 0) return [];
    const rootIds = [...new Set(roots.map((row) => row.rootManifestId))];
    const manifests = await tx.$queryRaw<CorrectionManifestRow[]>(Prisma.sql`
      SELECT manifest.id, manifest."rootManifestId", manifest."predecessorManifestId",
        manifest."sourceProofId", manifest."sourceProofHash", manifest."contentHash",
        receipt."contentHash" AS "receiptContentHash", manifest."createdAt"
      FROM "ParticipationTimeCorrectionManifest" manifest
      JOIN "LedgerPostingBatch" batch
        ON batch.id = manifest."postingBatchId" AND batch."statusCode" = 'committed'
      LEFT JOIN "ParticipationTimeCorrectionCommitReceipt" receipt
        ON receipt."manifestId" = manifest.id
      WHERE manifest."rootManifestId" IN (${Prisma.join(rootIds)})
      ORDER BY manifest."rootManifestId", manifest."createdAt", manifest.id
    `);
    const latestByRoot = latestManifestsByRoot(rootIds, manifests);
    const manifestIds = manifests.map((row) => row.id);
    const corrections =
      manifestIds.length === 0
        ? []
        : await tx.$queryRaw<CorrectionEntryRow[]>(Prisma.sql`
            SELECT entry."manifestId", entry."rootEntryId", entry."participationIdentityId",
              entry."categoryCode", entry."secondsDelta"
            FROM "ParticipationTimeCorrectionEntry" entry
            WHERE entry."manifestId" IN (${Prisma.join(manifestIds)})
            ORDER BY entry."manifestId", entry."rootEntryId", entry."entryTypeCode", entry.id
          `);
    const rootEntryIds = roots.map((row) => row.rootEntryId);
    const rootSlices = await tx.$queryRaw<SliceRow[]>(Prisma.sql`
      SELECT entry.id AS "rootEntryId", NULL::text AS "proofId",
        entry."participationIdentityId", slice.id AS "sliceId", slice."categoryCode",
        slice."startAt", slice."endAt"
      FROM "ParticipationTimeLedgerEntry" entry
      JOIN "ParticipantSettlementTimeBucketSource" source ON source."bucketId" = entry."bucketId"
      JOIN "ParticipantTimeAllocationSlice" slice
        ON slice."allocationRevisionId" = source."allocationRevisionId"
        AND slice."activityId" = entry."activityId"
      WHERE entry.id IN (${Prisma.join(rootEntryIds)})
      ORDER BY entry.id, slice."startAt", slice."endAt", slice.id
    `);
    const latestWithProof = [...latestByRoot.values()].filter(
      (row): row is CorrectionManifestRow => row !== null && row.sourceProofId !== null,
    );
    const proofIds = [...new Set(latestWithProof.map((row) => row.sourceProofId as string))];
    const [proofs, correctionSlices] =
      proofIds.length === 0
        ? [[], []]
        : await Promise.all([
            tx.$queryRaw<SourceProofRow[]>(Prisma.sql`
              SELECT proof.id, proof."rootManifestId", proof."sourceSetHash",
                proof."expectedBindingCount", count(binding.id)::bigint AS "actualBindingCount"
              FROM "CorrectionTimeSourceProof" proof
              LEFT JOIN "CorrectionTimeAllocationBinding" binding ON binding."proofId" = proof.id
              WHERE proof.id IN (${Prisma.join(proofIds)})
              GROUP BY proof.id
              ORDER BY proof.id
            `),
            tx.$queryRaw<SliceRow[]>(Prisma.sql`
              SELECT NULL::text AS "rootEntryId", binding."proofId",
                binding."participationIdentityId", slice.id AS "sliceId", slice."categoryCode",
                slice."startAt", slice."endAt"
              FROM "CorrectionTimeAllocationBinding" binding
              JOIN "ParticipantTimeAllocationSlice" slice
                ON slice."allocationRevisionId" = binding."allocationRevisionId"
                AND slice."activityId" = binding."activityId"
              WHERE binding."proofId" IN (${Prisma.join(proofIds)})
              ORDER BY binding."proofId", binding."participationIdentityId",
                slice."startAt", slice."endAt", slice.id
            `),
          ]);
    this.verifyProofs(latestWithProof, proofs);

    const rootsByEntryId = new Map(roots.map((root) => [root.rootEntryId, root]));
    const rootSlicesByEntryCategory = groupSlices(rootSlices, (slice) =>
      slice.rootEntryId === null
        ? null
        : sliceGroupKey(slice.rootEntryId, slice.participationIdentityId, slice.categoryCode),
    );
    const correctionSlicesByProofIdentityCategory = groupSlices(correctionSlices, (slice) =>
      slice.proofId === null
        ? null
        : sliceGroupKey(slice.proofId, slice.participationIdentityId, slice.categoryCode),
    );
    const correctionSeconds = new Map<string, number>();
    for (const entry of corrections) {
      const root = rootsByEntryId.get(entry.rootEntryId);
      if (
        !root ||
        root.participationIdentityId !== entry.participationIdentityId ||
        root.categoryCode !== entry.categoryCode ||
        !Number.isSafeInteger(entry.secondsDelta)
      ) {
        invalidTruth();
      }
      const next = (correctionSeconds.get(entry.rootEntryId) ?? 0) + entry.secondsDelta;
      if (!Number.isSafeInteger(next)) invalidTruth();
      correctionSeconds.set(entry.rootEntryId, next);
    }

    const output: ParticipationTimeTruthItem[] = [];
    for (const root of roots) {
      const recognizedSeconds =
        root.recognizedSeconds + (correctionSeconds.get(root.rootEntryId) ?? 0);
      if (!Number.isSafeInteger(recognizedSeconds) || recognizedSeconds < 0) invalidTruth();
      if (recognizedSeconds === 0) continue;
      const latest = latestByRoot.get(root.rootManifestId) ?? null;
      const proofSlices = latest?.sourceProofId
        ? (correctionSlicesByProofIdentityCategory.get(
            sliceGroupKey(latest.sourceProofId, root.participationIdentityId, root.categoryCode),
          ) ?? [])
        : [];
      const slices = latest?.sourceProofId
        ? proofSlices
        : (rootSlicesByEntryCategory.get(
            sliceGroupKey(root.rootEntryId, root.participationIdentityId, root.categoryCode),
          ) ?? []);
      if (slices.length === 0) invalidTruth();
      for (const day of allocateSecondsByDate(recognizedSeconds, slices)) {
        if (day.ledgerDate < input.dateFrom || day.ledgerDate > input.dateTo) continue;
        output.push({
          ledgerDate: day.ledgerDate,
          activityId: root.activityId,
          rootManifestId: root.rootManifestId,
          participationIdentityId: root.participationIdentityId,
          sourceCategoryCode: root.categoryCode as ParticipationTimeSourceCategory,
          sourceEntryId: root.rootEntryId,
          latestCorrectionManifestId: latest?.id ?? null,
          sourceMode: 'classified_time_ledger',
          recognizedSeconds: day.recognizedSeconds,
        });
      }
    }
    if (output.length > PARTICIPATION_TIME_PROOF_MAX_ROWS) {
      throw new BizException(BizCode.ACTIVITY_TIME_PROOF_SCALE_LIMIT);
    }
    return output;
  }

  private verifyProofs(
    latestManifests: readonly CorrectionManifestRow[],
    proofs: readonly SourceProofRow[],
  ): void {
    const byId = new Map(proofs.map((proof) => [proof.id, proof]));
    for (const manifest of latestManifests) {
      const proof = byId.get(manifest.sourceProofId as string);
      if (
        !proof ||
        proof.rootManifestId !== manifest.rootManifestId ||
        proof.sourceSetHash !== manifest.sourceProofHash ||
        BigInt(proof.expectedBindingCount) !== proof.actualBindingCount
      ) {
        invalidTruth();
      }
    }
  }
}
