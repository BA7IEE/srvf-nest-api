import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  buildParticipationTimeLedger,
  TimeLedgerPolicyError,
} from './participation-time-ledger-policy';

export interface TimeLedgerBatch {
  readonly id: string;
  readonly settlementVersionId: string;
  readonly settlementRunId: string;
}

/** All methods use the caller transaction and require its existing batch lock. */
@Injectable()
export class ParticipationTimeLedgerService {
  /** Only this migration's named constraints; never turn an unknown DB failure into success. */
  rethrowConstraint(error: unknown, operation?: 'manifest' | 'entry'): never {
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
      typeof known?.meta?.target === 'string' ? known.meta.target : '',
    ]
      .filter((value): value is string => typeof value === 'string')
      .join(' ');
    const names = new Set(details.match(/\bptl[a-z0-9_]+\b/gu) ?? []);
    if (names.has('ptl_visibility_guard'))
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_NOT_READY);
    if (
      ['ptlm_batch_key', 'ptle_entry_key', 'ptle_manifest_bucket_key'].some((name) =>
        names.has(name),
      )
    )
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_CONTENT_CONFLICT);
    if (
      [
        'ptlm_shape_check',
        'ptlm_hash_check',
        'ptlm_batch_fkey',
        'ptlm_revision_fkey',
        'ptlm_source_guard',
        'ptle_shape_check',
        'ptle_hash_check',
        'ptle_manifest_fkey',
        'ptle_bucket_fkey',
        'ptle_batch_guard',
      ].some((name) => names.has(name))
    )
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_SOURCE_INVALID);
    // Prisma P2002 commonly exposes exact fields rather than the PostgreSQL constraint name.
    if (known?.code === 'P2002' && operation && Array.isArray(known.meta?.target)) {
      const target = known.meta.target;
      const expected =
        operation === 'manifest'
          ? [['postingBatchId']]
          : [['entryKey'], ['manifestId', 'bucketId']];
      if (
        expected.some(
          (fields) =>
            fields.length === target.length &&
            fields.every((field, index) => target[index] === field),
        )
      )
        throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_CONTENT_CONFLICT);
    }
    throw error;
  }

  async hasClassifiedSource(tx: Prisma.TransactionClient, batch: TimeLedgerBatch) {
    const manifest = await tx.participationTimeLedgerManifest.findUnique({
      where: { postingBatchId: batch.id },
      select: { id: true },
    });
    if (manifest) return true;
    return (
      (await tx.activitySettlementTimeRevision.findFirst({
        where: { settlementVersionId: batch.settlementVersionId, kindCode: 'submitted' },
        select: { id: true },
      })) !== null
    );
  }

  async assertLegacyCorrection(tx: Prisma.TransactionClient, baseSettlementVersionId: string) {
    if (
      (await tx.participationTimeLedgerManifest.findFirst({
        where: { settlementVersionId: baseSettlementVersionId },
        select: { id: true },
      })) ||
      (await tx.participationTimeCorrectionManifest.findFirst({
        where: { settlementVersionId: baseSettlementVersionId },
        select: { id: true },
      }))
    ) {
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_CORRECTION_UNAVAILABLE);
    }
  }

  async assertNotClassifiedCorrectionBatch(tx: Prisma.TransactionClient, postingBatchId: string) {
    const applications = await tx.correctionApplication.findMany({
      where: { newPostingBatchId: postingBatchId },
      select: { correctionRequest: { select: { baseSettlementVersionId: true } } },
    });
    const bases = applications.map((row) => row.correctionRequest.baseSettlementVersionId);
    if (
      bases.length &&
      ((await tx.participationTimeLedgerManifest.findFirst({
        where: { settlementVersionId: { in: bases } },
        select: { id: true },
      })) ||
        (await tx.participationTimeCorrectionManifest.findFirst({
          where: { settlementVersionId: { in: bases } },
          select: { id: true },
        })))
    ) {
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_CORRECTION_UNAVAILABLE);
    }
  }

  async source(tx: Prisma.TransactionClient, batch: TimeLedgerBatch) {
    const revision = await tx.activitySettlementTimeRevision.findFirst({
      where: { settlementVersionId: batch.settlementVersionId, kindCode: 'submitted' },
    });
    if (!revision) return null;
    if (revision.settlementRunId !== batch.settlementRunId) {
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_SOURCE_INVALID);
    }
    const [buckets, results] = await Promise.all([
      tx.participantSettlementTimeBucket.findMany({
        where: { timeRevisionId: revision.id },
        select: {
          id: true,
          participationIdentityId: true,
          categoryCode: true,
          recognizedSeconds: true,
        },
        orderBy: { id: 'asc' },
        take: 8001,
      }),
      tx.participantSettlementResultRevision.findMany({
        where: { settlementVersionId: batch.settlementVersionId },
        select: { participationIdentityId: true },
        take: 2001,
      }),
    ]);
    if (results.length > 2000 || buckets.length > 8000) {
      throw new BizException(BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT);
    }
    const identities = new Set(results.map((row) => row.participationIdentityId));
    if (
      buckets.length !== revision.bucketCount ||
      buckets.some((row) => !identities.has(row.participationIdentityId))
    ) {
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_SOURCE_INVALID);
    }
    try {
      return buildParticipationTimeLedger(
        {
          postingBatchId: batch.id,
          activityId: revision.activityId,
          settlementRunId: batch.settlementRunId,
          settlementVersionId: batch.settlementVersionId,
          timeRevisionId: revision.id,
          bucketContentHash: revision.bucketContentHash,
          sourceSetHash: revision.sourceSetHash,
        },
        buckets,
      );
    } catch (error) {
      if (!(error instanceof TimeLedgerPolicyError)) throw error;
      throw new BizException(
        error.reason === 'scale_limit'
          ? BizCode.ACTIVITY_TIME_SETTLEMENT_SCALE_LIMIT
          : BizCode.ACTIVITY_TIME_LEDGER_SOURCE_INVALID,
      );
    }
  }

  async ensureManifest(tx: Prisma.TransactionClient, batch: TimeLedgerBatch) {
    const source = await this.source(tx, batch);
    const existing = await tx.participationTimeLedgerManifest.findUnique({
      where: { postingBatchId: batch.id },
    });
    if (!source) {
      if (existing) throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_SOURCE_INVALID);
      return null;
    }
    if (existing) {
      this.assertManifest(existing, source.manifest);
      return existing;
    }
    // The parent batch lock serializes legitimate writers; constraint errors are not swallowed.
    return tx.participationTimeLedgerManifest
      .create({ data: source.manifest })
      .catch((error: unknown) => this.rethrowConstraint(error, 'manifest'));
  }

  async prepareIdentities(
    tx: Prisma.TransactionClient,
    batch: TimeLedgerBatch,
    identityIds: readonly string[],
  ) {
    const source = await this.source(tx, batch);
    if (!source) return;
    const manifest = await tx.participationTimeLedgerManifest.findUnique({
      where: { postingBatchId: batch.id },
    });
    if (!manifest) throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_NOT_READY);
    this.assertManifest(manifest, source.manifest);
    const selected = new Set(identityIds);
    if (selected.size !== identityIds.length)
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_SOURCE_INVALID);
    const entries = source.entries.filter((row) => selected.has(row.participationIdentityId));
    const existing = await tx.participationTimeLedgerEntry.findMany({
      where: { manifestId: manifest.id, participationIdentityId: { in: [...identityIds] } },
    });
    const expected = new Map(entries.map((row) => [row.entryKey, row]));
    for (const row of existing) {
      const target = expected.get(row.entryKey);
      if (!target || !this.entryMatches(row, target))
        throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_CONTENT_CONFLICT);
    }
    const present = new Set(existing.map((row) => row.entryKey));
    const missing = entries.filter((row) => !present.has(row.entryKey));
    if (missing.length)
      await tx.participationTimeLedgerEntry
        .createMany({
          data: missing.map((row) => ({ ...row, manifestId: manifest.id })),
        })
        .catch((error: unknown) => this.rethrowConstraint(error, 'entry'));
  }

  async assertComplete(tx: Prisma.TransactionClient, batch: TimeLedgerBatch) {
    const source = await this.source(tx, batch);
    const manifest = await tx.participationTimeLedgerManifest.findUnique({
      where: { postingBatchId: batch.id },
    });
    if (!source) {
      if (manifest) throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_SOURCE_INVALID);
      return false;
    }
    if (!manifest) throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_NOT_READY);
    this.assertManifest(manifest, source.manifest);
    const entries = await tx.participationTimeLedgerEntry.findMany({
      where: { manifestId: manifest.id },
      take: 8001,
    });
    if (entries.length !== source.entries.length)
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_NOT_READY);
    const expected = new Map(source.entries.map((row) => [row.entryKey, row]));
    for (const row of entries) {
      const target = expected.get(row.entryKey);
      if (!target || !this.entryMatches(row, target))
        throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_CONTENT_CONFLICT);
    }
    return true;
  }

  private assertManifest(
    actual: ReturnType<typeof buildParticipationTimeLedger>['manifest'],
    expected: ReturnType<typeof buildParticipationTimeLedger>['manifest'],
  ) {
    if (
      Object.keys(expected).some((key) => Reflect.get(actual, key) !== Reflect.get(expected, key))
    ) {
      throw new BizException(BizCode.ACTIVITY_TIME_LEDGER_CONTENT_CONFLICT);
    }
  }

  private entryMatches(
    actual: ReturnType<typeof buildParticipationTimeLedger>['entries'][number],
    expected: ReturnType<typeof buildParticipationTimeLedger>['entries'][number],
  ) {
    return Object.keys(expected).every(
      (key) => Reflect.get(actual, key) === Reflect.get(expected, key),
    );
  }
}
