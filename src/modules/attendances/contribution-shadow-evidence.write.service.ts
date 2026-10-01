import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { ContributionLegacySource } from './contribution-calculator';
import type { NormalizedAttendanceRecord } from './attendance-record.policy';

type PrismaTx = Prisma.TransactionClient;

export type ShadowAttemptInput = Pick<
  Prisma.ContributionShadowAttemptReceiptCreateManyInput,
  | 'windowId'
  | 'auditLogId'
  | 'sheetId'
  | 'activityId'
  | 'sheetVersion'
  | 'committedFactHash'
  | 'signedMappingVersion'
  | 'expectedRecordCount'
>;

/** Frozen D1 algorithm; callers cannot choose the replay key. */
export function shadowAttemptReplayKey(input: ShadowAttemptInput): string {
  return createHash('sha256')
    .update(`e3-2-d1:v1:${input.windowId}:${input.auditLogId}:${input.sheetVersion}`, 'utf8')
    .digest('hex');
}

export type ShadowComparisonAttempt = Pick<
  Prisma.ContributionShadowAttemptReceiptCreateManyInput,
  | 'id'
  | 'windowId'
  | 'auditLogId'
  | 'sheetId'
  | 'sheetVersion'
  | 'activityId'
  | 'expectedRecordCount'
> & { id: string };

export type ShadowMappingApplicationInput = Omit<
  Prisma.ContributionShadowMappingApplicationCreateManyInput,
  'id' | 'createdAt'
>;

export type ShadowComparisonInput = Omit<
  Prisma.ContributionShadowComparisonReceiptCreateManyInput,
  'id' | 'createdAt' | 'attemptId'
>;

const APPLICATION_FIELDS: readonly (keyof ShadowMappingApplicationInput)[] = [
  'approvalId',
  'legacySourceAnchorId',
  'windowId',
  'auditLogId',
  'sheetId',
  'sheetVersion',
  'recordId',
  'memberId',
  'activityId',
  'selectionItemId',
  'policyVersionId',
  'policyDefinitionHash',
  'evaluatorVersion',
  'durationSeconds',
  'policyPoints',
  'explanationCode',
];
const COMPARISON_FIELDS: readonly (keyof ShadowComparisonInput)[] = [
  'recordId',
  'sheetId',
  'memberId',
  'activityId',
  'classificationCode',
  'comparable',
  'factHash',
  'legacySourceHash',
  'policySourceHash',
  'legacyRuleId',
  'selectionRevisionId',
  'selectionItemId',
  'policyVersionId',
  'policyId',
  'definitionHash',
  'evaluatorVersion',
  'legacyServiceHours',
  'durationSeconds',
  'legacyPoints',
  'policyPoints',
  'failureCode',
  'hashAlgorithmCode',
  'canonicalVersion',
];

type PreparedRecord = NormalizedAttendanceRecord & { contributionPoints: number };
type StoredRecord = Omit<PreparedRecord, 'serviceHours' | 'contributionPoints'> & {
  id: string;
  sheetId: string;
  serviceHours: Prisma.Decimal;
  contributionPoints: Prisma.Decimal | null;
};

/** Input order is retained only after a strict business-key bijection is proven. */
export function matchLegacyRecords(
  sheetId: string,
  prepared: PreparedRecord[],
  stored: StoredRecord[],
): StoredRecord[] {
  const fail = () => new Error('shadow legacy record correspondence failed');
  if (prepared.length === 0 || prepared.length !== stored.length) throw fail();
  const key = (record: PreparedRecord | StoredRecord) =>
    JSON.stringify([record.memberId, record.checkInAt.getTime(), record.checkOutAt.getTime()]);
  const byKey = new Map<string, StoredRecord>();
  const ids = new Set<string>();
  for (const record of stored) {
    const recordKey = key(record);
    if (record.sheetId !== sheetId || byKey.has(recordKey) || ids.has(record.id)) throw fail();
    byKey.set(recordKey, record);
    ids.add(record.id);
  }
  const result = prepared.map((record) => {
    const recordKey = key(record);
    const actual = byKey.get(recordKey);
    if (
      !actual ||
      actual.roleCode !== record.roleCode ||
      actual.attendanceStatusCode !== record.attendanceStatusCode ||
      actual.registrationId !== record.registrationId ||
      actual.note !== record.note ||
      !actual.serviceHours.equals(record.serviceHours) ||
      actual.contributionPoints === null ||
      !actual.contributionPoints.equals(record.contributionPoints)
    )
      throw fail();
    byKey.delete(recordKey);
    return actual;
  });
  if (byKey.size !== 0) throw fail();
  return result;
}

export interface LegacySourceAnchorInput {
  windowId: string;
  auditLogId: string;
  sheetId: string;
  sheetVersion: number;
  activityId: string;
  recordId: string;
  memberId: string;
  activityTypeCode: string;
  attendanceRoleCode: string;
  legacyServiceHours: Prisma.Decimal;
  legacyPoints: Prisma.Decimal;
  source: ContributionLegacySource;
}

function fixedTwo(value: Prisma.Decimal): string {
  const normalized = value.toFixed(2);
  if (!value.equals(normalized)) {
    throw new Error('shadow legacy source contains non-canonical decimal precision');
  }
  return normalized;
}

function canonicalField(value: string | null): string {
  return value === null ? 'N' : `S${Buffer.byteLength(value, 'utf8')}:${value}`;
}

/** Byte contract is frozen in E3-2 plan §23.2 and SQL cslsa_source_hash_fn. */
export function hashLegacySource(input: LegacySourceAnchorInput): string {
  const source = input.source;
  const fields: Array<string | null> = [
    input.windowId,
    input.auditLogId,
    input.sheetId,
    String(input.sheetVersion),
    input.activityId,
    input.recordId,
    input.memberId,
    input.activityTypeCode,
    input.attendanceRoleCode,
    fixedTwo(input.legacyServiceHours),
    source.sourceKindCode,
    source.legacyRuleId,
    source.durationThreshold === null ? null : fixedTwo(source.durationThreshold),
    source.pointsBelow === null ? null : fixedTwo(source.pointsBelow),
    source.pointsAbove === null ? null : fixedTwo(source.pointsAbove),
    fixedTwo(input.legacyPoints),
  ];
  return createHash('sha256')
    .update(`SRVF:E3-2:legacy-source:v1:${fields.map(canonicalField).join('')}`, 'utf8')
    .digest('hex');
}

@Injectable()
export class ContributionShadowEvidenceWriteService {
  /**
   * A separately qualified recovery transaction only, after the failed evidence
   * transaction has rolled back. Retain every already committed comparison and
   * propose its counts; the terminal insert guard locks the attempt and independently
   * recounts before accepting them. A race rejects rather than guessing. Never retry
   * here, overwrite a terminal, or copy exception details into durable evidence.
   */
  async writeFailedTerminal(tx: PrismaTx, attempt: ShadowComparisonAttempt) {
    // Runtime is append/read-only and has no UPDATE privilege for row locks.
    // Do not broaden ACLs: final serialized count validation belongs to the
    // existing definer-owned insert guard, not an unprivileged FOR UPDATE here.
    const stored = await tx.contributionShadowAttemptReceipt.findUnique({
      where: { id: attempt.id },
    });
    if (
      !stored ||
      stored.windowId !== attempt.windowId ||
      stored.auditLogId !== attempt.auditLogId ||
      stored.sheetId !== attempt.sheetId ||
      stored.activityId !== attempt.activityId ||
      stored.sheetVersion !== attempt.sheetVersion ||
      stored.expectedRecordCount !== attempt.expectedRecordCount
    )
      throw new Error('shadow failed terminal attempt mismatch');
    const existing = await tx.contributionShadowTerminalReceipt.findUnique({
      where: { attemptId: attempt.id },
    });
    if (existing) return { terminal: existing, replayed: true };
    const rows = await tx.contributionShadowComparisonReceipt.findMany({
      where: { attemptId: attempt.id },
      select: { recordId: true, classificationCode: true, comparable: true },
    });
    const counts = { equalCount: 0, mismatchCount: 0, holdCount: 0, errorCount: 0 };
    const holds = new Set([
      'legacy_rule_missing',
      'policy_version_missing_or_unapproved',
      'mapping_hold',
      'input_source_mismatch',
      'precision_boundary',
      'source_drift',
      'duplicate_active_pair',
    ]);
    const records = new Set<string>();
    for (const row of rows) {
      if (
        !row.recordId ||
        records.has(row.recordId) ||
        row.comparable !==
          (row.classificationCode === 'equal' || row.classificationCode === 'points_mismatch')
      )
        throw new Error('shadow failed terminal comparison mismatch');
      records.add(row.recordId);
      if (row.classificationCode === 'equal') counts.equalCount += 1;
      else if (row.classificationCode === 'points_mismatch') counts.mismatchCount += 1;
      else if (row.classificationCode === 'evaluation_error') counts.errorCount += 1;
      else if (holds.has(row.classificationCode)) counts.holdCount += 1;
      else throw new Error('shadow failed terminal classification mismatch');
    }
    if (rows.length > attempt.expectedRecordCount)
      throw new Error('shadow failed terminal count mismatch');
    const terminal = await tx.contributionShadowTerminalReceipt.create({
      data: {
        id: randomUUID(),
        attemptId: attempt.id,
        statusCode: 'failed',
        expectedRecordCount: attempt.expectedRecordCount,
        writtenRecordCount: rows.length,
        ...counts,
        failureCode: 'shadow_comparison_failed',
      },
    });
    return { terminal, replayed: false };
  }

  /**
   * Caller owns the qualified, independent runtime transaction. A terminal is
   * returned unchanged (including failed); callers must not resume its writes.
   * No retry/upsert: a concurrent unique conflict aborts this transaction, and
   * only a separately authorized replay may read the winner after it commits.
   */
  async readOrCreateAttempt(tx: PrismaTx, input: ShadowAttemptInput) {
    const fail = () => new Error('shadow attempt evidence mismatch');
    if (
      ['id', 'createdAt', 'replayKey', 'hashAlgorithmCode', 'canonicalVersion'].some(
        (field) => field in input,
      ) ||
      [
        input.windowId,
        input.auditLogId,
        input.sheetId,
        input.activityId,
        input.signedMappingVersion,
      ].some((value) => typeof value !== 'string' || value.length === 0) ||
      !Number.isSafeInteger(input.sheetVersion) ||
      input.sheetVersion < 1 ||
      !Number.isSafeInteger(input.expectedRecordCount) ||
      input.expectedRecordCount < 1 ||
      !/^[a-f0-9]{64}$/.test(input.committedFactHash)
    )
      throw fail();
    const replayKey = shadowAttemptReplayKey(input);
    const existing = await tx.contributionShadowAttemptReceipt.findUnique({
      where: { auditLogId: input.auditLogId },
      include: { terminal: true },
    });
    if (existing) {
      if (
        existing.windowId !== input.windowId ||
        existing.auditLogId !== input.auditLogId ||
        existing.sheetId !== input.sheetId ||
        existing.activityId !== input.activityId ||
        existing.sheetVersion !== input.sheetVersion ||
        existing.committedFactHash !== input.committedFactHash ||
        existing.signedMappingVersion !== input.signedMappingVersion ||
        existing.expectedRecordCount !== input.expectedRecordCount ||
        existing.replayKey !== replayKey ||
        existing.hashAlgorithmCode !== 'sha256' ||
        existing.canonicalVersion !== 1
      )
        throw fail();
      return { attempt: existing, replayed: true };
    }
    const attempt = await tx.contributionShadowAttemptReceipt.create({
      data: {
        id: randomUUID(),
        windowId: input.windowId,
        auditLogId: input.auditLogId,
        sheetId: input.sheetId,
        activityId: input.activityId,
        sheetVersion: input.sheetVersion,
        committedFactHash: input.committedFactHash,
        signedMappingVersion: input.signedMappingVersion,
        expectedRecordCount: input.expectedRecordCount,
        replayKey,
        hashAlgorithmCode: 'sha256',
        canonicalVersion: 1,
      },
      include: { terminal: true },
    });
    return { attempt, replayed: false };
  }

  /**
   * Caller owns a separate, already authorized runtime transaction AFTER legacy
   * commit. These local bijection/count checks do not establish comparability:
   * PostgreSQL independently validates every application and comparison. Failure
   * must propagate to abort this transaction; the persisted attempt/old business
   * transaction is not owned, retried or compensated here.
   */
  async writeCompleteComparisonSet(
    tx: PrismaTx,
    attempt: ShadowComparisonAttempt,
    applications: readonly ShadowMappingApplicationInput[],
    comparisons: readonly ShadowComparisonInput[],
  ) {
    const fail = () => new Error('shadow comparison evidence set mismatch');
    if (
      !attempt.id ||
      !Number.isSafeInteger(attempt.expectedRecordCount) ||
      attempt.expectedRecordCount <= 0 ||
      comparisons.length !== attempt.expectedRecordCount
    )
      throw fail();
    const byRecord = new Map<string, ShadowComparisonInput>();
    const comparisonFields = new Set<string>(COMPARISON_FIELDS);
    const applicationFields = new Set<string>(APPLICATION_FIELDS);
    const buckets = { equalCount: 0, mismatchCount: 0, holdCount: 0, errorCount: 0 };
    const holds = new Set([
      'legacy_rule_missing',
      'policy_version_missing_or_unapproved',
      'mapping_hold',
      'input_source_mismatch',
      'precision_boundary',
      'source_drift',
      'duplicate_active_pair',
    ]);
    for (const comparison of comparisons) {
      if (
        Object.keys(comparison).some((field) => !comparisonFields.has(field)) ||
        'id' in comparison ||
        'createdAt' in comparison ||
        'attemptId' in comparison ||
        comparison.sheetId !== attempt.sheetId ||
        comparison.activityId !== attempt.activityId ||
        byRecord.has(comparison.recordId) ||
        !comparison.recordId ||
        comparison.comparable !==
          (comparison.classificationCode === 'equal' ||
            comparison.classificationCode === 'points_mismatch')
      )
        throw fail();
      byRecord.set(comparison.recordId, comparison);
      if (comparison.classificationCode === 'equal') buckets.equalCount += 1;
      else if (comparison.classificationCode === 'points_mismatch') buckets.mismatchCount += 1;
      else if (comparison.classificationCode === 'evaluation_error') buckets.errorCount += 1;
      else if (holds.has(comparison.classificationCode)) buckets.holdCount += 1;
      else throw fail();
    }
    const applicationRecords = new Set<string>();
    for (const application of applications) {
      const comparison = byRecord.get(application.recordId);
      if (
        Object.keys(application).some((field) => !applicationFields.has(field)) ||
        'id' in application ||
        'createdAt' in application ||
        application.windowId !== attempt.windowId ||
        application.auditLogId !== attempt.auditLogId ||
        application.sheetVersion !== attempt.sheetVersion ||
        application.sheetId !== attempt.sheetId ||
        application.activityId !== attempt.activityId ||
        applicationRecords.has(application.recordId) ||
        !comparison?.comparable ||
        application.memberId !== comparison.memberId ||
        application.selectionItemId !== comparison.selectionItemId ||
        application.policyVersionId !== comparison.policyVersionId ||
        application.policyDefinitionHash !== comparison.definitionHash ||
        application.evaluatorVersion !== comparison.evaluatorVersion ||
        application.durationSeconds !== comparison.durationSeconds
      )
        throw fail();
      applicationRecords.add(application.recordId);
    }
    if (applicationRecords.size !== buckets.equalCount + buckets.mismatchCount) throw fail();

    if (applications.length > 0) {
      // One bound JSON value avoids Prisma's parameter-limit splitting. Static
      // columns omit createdAt so PostgreSQL alone supplies the default clock.
      const payload = JSON.stringify(
        applications.map((application) => ({ ...application, id: randomUUID() })),
      );
      const count = await tx.$executeRaw`
        INSERT INTO public."ContributionShadowMappingApplication"
          (id,"approvalId","legacySourceAnchorId","windowId","auditLogId","sheetId",
           "sheetVersion","recordId","memberId","activityId","selectionItemId",
           "policyVersionId","policyDefinitionHash","evaluatorVersion","durationSeconds",
           "policyPoints","explanationCode")
        SELECT id,"approvalId","legacySourceAnchorId","windowId","auditLogId","sheetId",
           "sheetVersion","recordId","memberId","activityId","selectionItemId",
           "policyVersionId","policyDefinitionHash","evaluatorVersion","durationSeconds",
           "policyPoints","explanationCode"
        FROM jsonb_populate_recordset(NULL::public."ContributionShadowMappingApplication",${payload}::jsonb)`;
      if (count !== applications.length) throw fail();
    }
    const payload = JSON.stringify(
      comparisons.map((comparison) => ({
        ...comparison,
        id: randomUUID(),
        attemptId: attempt.id,
      })),
    );
    const count = await tx.$executeRaw`
      INSERT INTO public."ContributionShadowComparisonReceipt"
        (id,"attemptId","recordId","sheetId","memberId","activityId","classificationCode",
         comparable,"factHash","legacySourceHash","policySourceHash","legacyRuleId",
         "selectionRevisionId","selectionItemId","policyVersionId","policyId","definitionHash",
         "evaluatorVersion","legacyServiceHours","durationSeconds","legacyPoints","policyPoints",
         "failureCode","hashAlgorithmCode","canonicalVersion")
      SELECT id,"attemptId","recordId","sheetId","memberId","activityId","classificationCode",
         comparable,"factHash","legacySourceHash","policySourceHash","legacyRuleId",
         "selectionRevisionId","selectionItemId","policyVersionId","policyId","definitionHash",
         "evaluatorVersion","legacyServiceHours","durationSeconds","legacyPoints","policyPoints",
         "failureCode","hashAlgorithmCode","canonicalVersion"
      FROM jsonb_populate_recordset(NULL::public."ContributionShadowComparisonReceipt",${payload}::jsonb)`;
    if (count !== comparisons.length) throw fail();
    return tx.contributionShadowTerminalReceipt.create({
      data: {
        id: randomUUID(),
        attemptId: attempt.id,
        statusCode: 'complete',
        expectedRecordCount: attempt.expectedRecordCount,
        writtenRecordCount: count,
        ...buckets,
        failureCode: null,
      },
    });
  }

  async writeMatchedLegacySources(
    tx: PrismaTx,
    context: Pick<
      LegacySourceAnchorInput,
      'windowId' | 'auditLogId' | 'sheetId' | 'sheetVersion' | 'activityId' | 'activityTypeCode'
    >,
    prepared: PreparedRecord[],
    sources: ContributionLegacySource[],
    stored: StoredRecord[],
  ): Promise<void> {
    if (sources.length !== prepared.length) {
      throw new Error('shadow legacy source correspondence failed');
    }
    const matched = matchLegacyRecords(context.sheetId, prepared, stored);
    await this.writeLegacySources(
      tx,
      matched.map((record, index) => ({
        ...context,
        recordId: record.id,
        memberId: record.memberId,
        attendanceRoleCode: record.roleCode,
        legacyServiceHours: record.serviceHours,
        legacyPoints: record.contributionPoints!,
        source: sources[index],
      })),
    );
  }

  // Caller owns the old attendance transaction. The deferred DB guard checks
  // that this batch is exactly the current audit's complete record set.
  async writeLegacySources(tx: PrismaTx, inputs: LegacySourceAnchorInput[]): Promise<void> {
    if (inputs.length === 0) throw new Error('shadow legacy source set cannot be empty');
    const data: Prisma.ContributionShadowLegacySourceAnchorCreateManyInput[] = inputs.map(
      (input) => ({
        id: randomUUID(),
        windowId: input.windowId,
        auditLogId: input.auditLogId,
        sheetId: input.sheetId,
        sheetVersion: input.sheetVersion,
        activityId: input.activityId,
        recordId: input.recordId,
        memberId: input.memberId,
        activityTypeCode: input.activityTypeCode,
        attendanceRoleCode: input.attendanceRoleCode,
        legacyServiceHours: input.legacyServiceHours,
        sourceKindCode: input.source.sourceKindCode,
        legacyRuleId: input.source.legacyRuleId,
        durationThreshold: input.source.durationThreshold,
        pointsBelow: input.source.pointsBelow,
        pointsAbove: input.source.pointsAbove,
        legacyPoints: input.legacyPoints,
        hashAlgorithmCode: 'sha256',
        canonicalVersion: 1,
        legacySourceHash: hashLegacySource(input),
      }),
    );
    await tx.contributionShadowLegacySourceAnchor.createMany({ data });
  }
}
