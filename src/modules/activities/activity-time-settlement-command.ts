import {
  fingerprintMetricEnvelope,
  metricInteger,
  metricObject,
  metricText,
} from './activity-metric-definition';
import {
  activityTimeAllocationRequestHash,
  parseActivityTimeAllocationCommand,
  type ActivityTimeAllocationCommand,
} from './activity-time-allocation-command';

export const TIME_SETTLEMENT_ALLOCATION_OPERATION = 'recognize_settlement_time_allocation' as const;
export const TIME_SETTLEMENT_PREPARE_OPERATION = 'prepare_time_settlement' as const;
export const TIME_SETTLEMENT_SUBMIT_OPERATION = 'submit_time_settlement' as const;

export interface TimeSettlementDraftExpectation {
  readonly expectedDraftVersion: number;
  readonly expectedEvidenceSealId: string;
}

export interface TimeSettlementAllocationCommand extends TimeSettlementDraftExpectation {
  readonly expectedEvidenceRevision: number;
  readonly expectedPopulationRevision: number;
  readonly expectedWorkflowRevision: number;
  readonly allocation: ActivityTimeAllocationCommand;
}

export interface TimeSettlementPrepareCommand extends TimeSettlementDraftExpectation {
  readonly operationKey: string;
  readonly expectedTimeRevision: number;
}

export interface TimeSettlementSubmitCommand extends TimeSettlementDraftExpectation {
  readonly operationKey: string;
  readonly timeRevisionId: string;
  readonly expectedBucketContentHash: string;
}

export interface TimeSettlementReceiptResult {
  readonly schemaVersion: 1;
  readonly activityId: string;
  readonly timeRevisionId: string;
  readonly revision: number;
  readonly kindCode: 'draft' | 'submitted';
  readonly settlementRunId: string;
  readonly settlementVersionId: string;
  readonly settlementVersion: number;
  readonly contentHash: string;
  readonly bucketContentHash: string;
  readonly bucketCount: number;
  readonly sourceCount: number;
  readonly createdAt: string;
}

export function parseTimeSettlementReceipt(
  input: unknown,
  activityId: string,
  timeRevisionId: string,
): TimeSettlementReceiptResult {
  const row = metricObject(input, [
    'schemaVersion',
    'activityId',
    'timeRevisionId',
    'revision',
    'kindCode',
    'settlementRunId',
    'settlementVersionId',
    'settlementVersion',
    'contentHash',
    'bucketContentHash',
    'bucketCount',
    'sourceCount',
    'createdAt',
  ]);
  const createdAt = boundedText(row.createdAt, 24);
  const contentHash = boundedText(row.contentHash, 64);
  const bucketContentHash = boundedText(row.bucketContentHash, 64);
  const bucketCount = metricInteger(row.bucketCount, 0, 8000);
  const sourceCount = metricInteger(row.sourceCount, 0, 40000);
  if (
    row.schemaVersion !== 1 ||
    row.activityId !== activityId ||
    row.timeRevisionId !== timeRevisionId ||
    (row.kindCode !== 'draft' && row.kindCode !== 'submitted') ||
    !/^[0-9a-f]{64}$/u.test(contentHash) ||
    !/^[0-9a-f]{64}$/u.test(bucketContentHash) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(createdAt) ||
    !Number.isFinite(new Date(createdAt).getTime()) ||
    new Date(createdAt).toISOString() !== createdAt ||
    bucketCount % 4 !== 0 ||
    sourceCount % 4 !== 0
  )
    throw new TypeError('invalid time settlement receipt');
  return {
    schemaVersion: 1,
    activityId,
    timeRevisionId,
    kindCode: row.kindCode,
    revision: metricInteger(row.revision, 1, 2147483647),
    settlementRunId: boundedText(row.settlementRunId, 64),
    settlementVersionId: boundedText(row.settlementVersionId, 64),
    settlementVersion: metricInteger(row.settlementVersion, 1, 2147483647),
    contentHash,
    bucketContentHash,
    bucketCount,
    sourceCount,
    createdAt,
  };
}

function boundedText(value: unknown, maximum: number): string {
  const text = metricText(value, maximum);
  if (/\p{Cc}/u.test(text)) throw new TypeError('time settlement text contains control characters');
  return text;
}

function operationKey(value: unknown): string {
  const text = boundedText(value, 128);
  if (text.length < 8) throw new TypeError('time settlement operation key is too short');
  return text;
}

function draftExpectation(row: Record<string, unknown>): TimeSettlementDraftExpectation {
  return {
    expectedDraftVersion: metricInteger(row.expectedDraftVersion, 1, 2147483647),
    expectedEvidenceSealId: boundedText(row.expectedEvidenceSealId, 64),
  };
}

export function parseTimeSettlementPrepareCommand(input: unknown): TimeSettlementPrepareCommand {
  const row = metricObject(input, [
    'operationKey',
    'expectedDraftVersion',
    'expectedEvidenceSealId',
    'expectedTimeRevision',
  ]);
  return {
    ...draftExpectation(row),
    operationKey: operationKey(row.operationKey),
    expectedTimeRevision: metricInteger(row.expectedTimeRevision, 0, 2147483646),
  };
}

export function parseTimeSettlementSubmitCommand(input: unknown): TimeSettlementSubmitCommand {
  const row = metricObject(input, [
    'operationKey',
    'expectedDraftVersion',
    'expectedEvidenceSealId',
    'timeRevisionId',
    'expectedBucketContentHash',
  ]);
  const expectedBucketContentHash = boundedText(row.expectedBucketContentHash, 64);
  if (!/^[0-9a-f]{64}$/u.test(expectedBucketContentHash))
    throw new TypeError('time settlement bucket hash must be a canonical SHA-256 digest');
  return {
    ...draftExpectation(row),
    operationKey: operationKey(row.operationKey),
    timeRevisionId: boundedText(row.timeRevisionId, 64),
    expectedBucketContentHash,
  };
}

/** A separate parser/domain: the original D3 V1 still rejects these draft-only fields. */
export function parseTimeSettlementAllocationCommand(
  input: unknown,
): TimeSettlementAllocationCommand {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('time settlement allocation must be an object');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'recognitionModeCode');
  const manual = descriptor && 'value' in descriptor && descriptor.value === 'manual';
  const allocationKeys = [
    'operationKey',
    'sourceSegmentId',
    'expectedRevision',
    'recognitionModeCode',
    'evidenceAttachmentIds',
    ...(manual ? ['manualReason', 'slices'] : []),
  ];
  const row = metricObject(input, [
    ...allocationKeys,
    'expectedDraftVersion',
    'expectedEvidenceSealId',
    'expectedEvidenceRevision',
    'expectedPopulationRevision',
    'expectedWorkflowRevision',
  ]);
  const allocation = parseActivityTimeAllocationCommand(
    Object.fromEntries(allocationKeys.map((key) => [key, row[key]])),
  );
  return {
    ...draftExpectation(row),
    expectedEvidenceRevision: metricInteger(row.expectedEvidenceRevision, 0, 2147483647),
    expectedPopulationRevision: metricInteger(row.expectedPopulationRevision, 0, 2147483647),
    expectedWorkflowRevision: metricInteger(row.expectedWorkflowRevision, 0, 2147483647),
    allocation,
  };
}

export function timeSettlementPrepareRequestHash(
  activityId: string,
  actorUserId: string,
  command: TimeSettlementPrepareCommand,
): string {
  return fingerprintMetricEnvelope('activity-time-settlement-prepare-v1', {
    activityId: boundedText(activityId, 64),
    actorUserId: boundedText(actorUserId, 64),
    expectedDraftVersion: command.expectedDraftVersion,
    expectedEvidenceSealId: command.expectedEvidenceSealId,
    expectedTimeRevision: command.expectedTimeRevision,
  }).definitionHash;
}

export function timeSettlementSubmitRequestHash(
  activityId: string,
  actorUserId: string,
  command: TimeSettlementSubmitCommand,
): string {
  return fingerprintMetricEnvelope('activity-time-settlement-submit-v1', {
    activityId: boundedText(activityId, 64),
    actorUserId: boundedText(actorUserId, 64),
    expectedDraftVersion: command.expectedDraftVersion,
    expectedEvidenceSealId: command.expectedEvidenceSealId,
    timeRevisionId: command.timeRevisionId,
    expectedBucketContentHash: command.expectedBucketContentHash,
  }).definitionHash;
}

export function timeSettlementAllocationRequestHash(
  activityId: string,
  actorUserId: string,
  command: TimeSettlementAllocationCommand,
): string {
  return fingerprintMetricEnvelope('activity-time-settlement-allocation-v1', {
    activityId: boundedText(activityId, 64),
    actorUserId: boundedText(actorUserId, 64),
    expectedDraftVersion: command.expectedDraftVersion,
    expectedEvidenceSealId: command.expectedEvidenceSealId,
    expectedEvidenceRevision: command.expectedEvidenceRevision,
    expectedPopulationRevision: command.expectedPopulationRevision,
    expectedWorkflowRevision: command.expectedWorkflowRevision,
    allocationRequestHash: activityTimeAllocationRequestHash(
      activityId,
      actorUserId,
      command.allocation,
    ),
  }).definitionHash;
}
