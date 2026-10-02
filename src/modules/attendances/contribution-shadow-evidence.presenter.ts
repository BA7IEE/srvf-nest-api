import { Injectable } from '@nestjs/common';
import type {
  ShadowCandidateEvidenceDto,
  ShadowComparisonEvidenceDto,
  ShadowWindowEvidenceDto,
  ShadowWindowSummaryDto,
} from './dto/system/contribution-shadow-evidence.dto';

// Explicit projection, not object spread of database/user data. This class has
// no database, authorization or audit dependency and cannot return raw evidence.
const CANDIDATE_STRINGS = [
  'auditLogId',
  'createdAt',
  'event',
  'primaryClassification',
  'signatureStatus',
] as const;
const CANDIDATE_NULLABLE_STRINGS = [
  'operation',
  'sheetId',
  'activityId',
  'attemptId',
  'terminalId',
  'terminalStatus',
  'failureCode',
  'committedFactHash',
  'dispositionId',
  'previousDispositionId',
  'decisionCode',
  'approvalReceiptId',
  'signedByUserId',
  'approvalReference',
  'basisCode',
  'evidenceHash',
  'candidateEvidenceHash',
  'signedAt',
] as const;
const CANDIDATE_COUNTS = [
  'comparisonCount',
  'equalCount',
  'mismatchCount',
  'holdCount',
  'errorCount',
] as const;
const CANDIDATE_FLAGS = [
  'rawUnresolved',
  'netUnresolved',
  'missingStart',
  'missingTerminal',
  'notApplicable',
] as const;
const SUMMARY_COUNTS = [
  'candidateCount',
  'attemptCount',
  'terminalCount',
  'rawMissingStartCount',
  'rawMissingTerminalCount',
  'rawUnresolvedCount',
  'notApplicableCount',
  'netUnresolvedCount',
  'netMissingStartCount',
  'netMissingTerminalCount',
  'failedCount',
  'mismatchCount',
  'holdCount',
  'errorCount',
  'sourceOrChainAnomalyCount',
  'staleSignatureCount',
  'anomalousReceiptCount',
] as const;

function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Invalid shadow text projection');
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError('Invalid shadow count projection');
  return value;
}
function nullableText(value: unknown): string | null {
  return value == null ? null : text(value);
}
function instant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return text(value);
}

@Injectable()
export class ContributionShadowEvidencePresenter {
  window(row: {
    id: string;
    startsAt: Date;
    endsAt: Date;
    createdAt: Date;
    deploymentDigest: string;
    configDigest: string;
    signedMappingVersion: string;
    registrationReceipt: { id: string; manifestHash: string } | null;
  }): ShadowWindowEvidenceDto {
    return {
      id: row.id,
      startsAt: instant(row.startsAt),
      endsAt: instant(row.endsAt),
      createdAt: instant(row.createdAt),
      deploymentDigest: row.deploymentDigest,
      configDigest: row.configDigest,
      signedMappingVersion: row.signedMappingVersion,
      registrationReceiptId: row.registrationReceipt?.id ?? null,
      manifestHash: row.registrationReceipt?.manifestHash ?? null,
      registrationStatus: row.registrationReceipt ? 'registered' : 'legacy_unsigned',
    };
  }

  candidate(row: Record<string, unknown>): ShadowCandidateEvidenceDto {
    const result: Record<string, unknown> = {};
    for (const key of CANDIDATE_STRINGS) result[key] = text(row[key]);
    for (const key of CANDIDATE_NULLABLE_STRINGS) result[key] = nullableText(row[key]);
    for (const key of CANDIDATE_COUNTS) result[key] = count(row[key]);
    for (const key of ['sheetVersion', 'expectedRecordCount', 'revision'] as const)
      result[key] = row[key] == null ? null : count(row[key]);
    for (const key of CANDIDATE_FLAGS) {
      if (typeof row[key] !== 'boolean') throw new TypeError('Invalid shadow flag projection');
      result[key] = row[key];
    }
    if (
      !Array.isArray(row.reasonCodes) ||
      row.reasonCodes.some((reason) => typeof reason !== 'string')
    )
      throw new TypeError('Invalid shadow reason projection');
    result.reasonCodes = (row.reasonCodes as unknown[]).map(text);
    if (
      (result.reasonCodes as string[]).some(
        (reason) =>
          ![
            'source_or_chain_anomaly',
            'missing_start',
            'missing_terminal',
            'failed',
            'error',
            'hold',
            'mismatch',
          ].includes(reason),
      )
    )
      throw new TypeError('Invalid shadow reason code');
    if (!['unsigned', 'current', 'stale_evidence'].includes(text(result.signatureStatus)))
      throw new TypeError('Invalid shadow signature projection');
    return result as unknown as ShadowCandidateEvidenceDto;
  }

  summary(row: Record<string, unknown>, window: ShadowWindowEvidenceDto): ShadowWindowSummaryDto {
    const result: Record<string, unknown> = { window };
    for (const key of SUMMARY_COUNTS) result[key] = count(row[key]);
    if (
      count(result.candidateCount) !==
        count(result.attemptCount) + count(result.rawMissingStartCount) ||
      count(result.attemptCount) !==
        count(result.terminalCount) + count(result.rawMissingTerminalCount) ||
      count(result.netUnresolvedCount) !==
        count(result.rawUnresolvedCount) - count(result.notApplicableCount)
    )
      throw new TypeError('Inconsistent shadow count identities');
    result.observationStatus =
      result.candidateCount === 0 ? 'zero_visible_candidates' : 'evidence_visible';
    return result as unknown as ShadowWindowSummaryDto;
  }

  comparison(row: {
    id: string;
    attemptId: string;
    recordId: string;
    memberId: string;
    classificationCode: string;
    comparable: boolean;
    factHash: string;
    legacySourceHash: string;
    policySourceHash: string | null;
    legacyPoints: { toString(): string } | null;
    policyPoints: { toString(): string } | null;
    durationSeconds: number | null;
    failureCode: string | null;
    hashAlgorithmCode: string;
    canonicalVersion: number;
    createdAt: Date;
  }): ShadowComparisonEvidenceDto {
    return {
      id: row.id,
      attemptId: row.attemptId,
      recordId: row.recordId,
      memberId: row.memberId,
      classificationCode: row.classificationCode,
      comparable: row.comparable,
      factHash: row.factHash,
      legacySourceHash: row.legacySourceHash,
      policySourceHash: row.policySourceHash,
      legacyPoints: row.legacyPoints?.toString() ?? null,
      policyPoints: row.policyPoints?.toString() ?? null,
      durationSeconds: row.durationSeconds,
      failureCode: row.failureCode,
      hashAlgorithmCode: row.hashAlgorithmCode,
      canonicalVersion: row.canonicalVersion,
      createdAt: instant(row.createdAt),
    };
  }
}
