import {
  fingerprintMetricEnvelope,
  metricArray,
  metricInteger,
  metricObject,
  metricText,
} from './activity-metric-definition';
import type { TimePolicyCategory } from './activity-time-policy-definition';

export const ACTIVITY_TIME_ALLOCATION_OPERATION = 'recognize_time_allocation' as const;
export const ACTIVITY_TIME_ALLOCATION_SCHEMA_VERSION = 1 as const;

/** Server-resolved D4 proof, never accepted by the original V1 parser. */
export interface ActivityTimeAllocationSettlementProof {
  readonly settlementDraftVersionId: string;
  readonly settlementEvidenceSealId: string;
  readonly settlementEvidenceRevision: number;
  readonly settlementPopulationRevision: number;
  readonly settlementWorkflowRevision: number;
  readonly settlementDraftContentHash: string;
}

export interface ActivityTimeAllocationSliceInput {
  readonly categoryCode: TimePolicyCategory;
  readonly intervalKindCode: 'service_segment';
  readonly startAt: string;
  readonly endAt: string;
}

export interface ActivityTimeAllocationSliceManifest extends ActivityTimeAllocationSliceInput {
  readonly ordinal: number;
}

export type ActivityTimeAllocationCommand =
  | {
      readonly operationKey: string;
      readonly sourceSegmentId: string;
      readonly expectedRevision: number;
      readonly recognitionModeCode: 'automatic';
      readonly manualReason: null;
      readonly slices: readonly [];
      readonly evidenceAttachmentIds: readonly string[];
    }
  | {
      readonly operationKey: string;
      readonly sourceSegmentId: string;
      readonly expectedRevision: number;
      readonly recognitionModeCode: 'manual';
      readonly manualReason: string;
      readonly slices: readonly ActivityTimeAllocationSliceInput[];
      readonly evidenceAttachmentIds: readonly string[];
    };

export interface ActivityTimeAllocationManifest {
  readonly schemaVersion: 1;
  readonly slices: Readonly<Record<string, ActivityTimeAllocationSliceManifest>>;
}

export interface ActivityTimeAllocationReceiptResult {
  readonly schemaVersion: 1;
  readonly activityId: string;
  readonly allocationRevisionId: string;
  readonly revision: number;
  readonly sourceSegmentId: string;
  readonly sourceSegmentRevision: number;
  readonly recognitionModeCode: 'automatic' | 'manual';
  readonly allocationHash: string;
  readonly sliceCount: number;
  readonly evidenceCount: number;
  readonly createdAt: string;
}

function allocationTypeError(message: string): never {
  throw new TypeError('activity time allocation: ' + message);
}

function isoInstant(value: unknown): string {
  const text = metricText(value, 24);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(text))
    return allocationTypeError('invalid instant');
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text)
    return allocationTypeError('invalid instant');
  return text;
}

function categoryCode(value: unknown): TimePolicyCategory {
  if (
    value === 'volunteer_service' ||
    value === 'training' ||
    value === 'organization' ||
    value === 'non_creditable'
  )
    return value;
  return allocationTypeError('invalid category');
}

function parseManualSlice(value: unknown): ActivityTimeAllocationSliceInput {
  const row = metricObject(value, ['categoryCode', 'startAt', 'endAt']);
  const startAt = isoInstant(row.startAt);
  const endAt = isoInstant(row.endAt);
  if (startAt >= endAt) return allocationTypeError('empty manual interval');
  return {
    categoryCode: categoryCode(row.categoryCode),
    intervalKindCode: 'service_segment',
    startAt,
    endAt,
  };
}

function parseEvidenceIds(value: unknown): readonly string[] {
  const ids = metricArray(value, 500).map((item) => metricText(item, 64));
  if (new Set(ids).size !== ids.length) return allocationTypeError('duplicate attachment evidence');
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function sortSlices(
  slices: readonly ActivityTimeAllocationSliceInput[],
): readonly ActivityTimeAllocationSliceInput[] {
  return [...slices].sort((left, right) => {
    const byStart = left.startAt.localeCompare(right.startAt);
    if (byStart !== 0) return byStart;
    const byEnd = left.endAt.localeCompare(right.endAt);
    if (byEnd !== 0) return byEnd;
    return left.categoryCode.localeCompare(right.categoryCode);
  });
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
  });
}

function operationKey(value: unknown): string {
  const parsed = metricText(value, 128);
  if (parsed.length < 8 || !/\S/u.test(parsed) || hasControlCharacter(parsed))
    return allocationTypeError('invalid operation key');
  return parsed;
}

export function parseActivityTimeAllocationCommand(input: unknown): ActivityTimeAllocationCommand {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return allocationTypeError('command must be an object');
  const modeDescriptor = Object.getOwnPropertyDescriptor(input, 'recognitionModeCode');
  const mode =
    modeDescriptor && 'value' in modeDescriptor && typeof modeDescriptor.value === 'string'
      ? modeDescriptor.value
      : undefined;
  if (mode === 'automatic') {
    const row = metricObject(input, [
      'operationKey',
      'sourceSegmentId',
      'expectedRevision',
      'recognitionModeCode',
      'evidenceAttachmentIds',
    ]);
    const parsedOperationKey = operationKey(row.operationKey);
    return {
      operationKey: parsedOperationKey,
      sourceSegmentId: metricText(row.sourceSegmentId, 64),
      expectedRevision: metricInteger(row.expectedRevision, 0, 2147483646),
      recognitionModeCode: 'automatic',
      manualReason: null,
      slices: [],
      evidenceAttachmentIds: parseEvidenceIds(row.evidenceAttachmentIds),
    };
  }
  if (mode === 'manual') {
    const row = metricObject(input, [
      'operationKey',
      'sourceSegmentId',
      'expectedRevision',
      'recognitionModeCode',
      'manualReason',
      'slices',
      'evidenceAttachmentIds',
    ]);
    const parsedOperationKey = operationKey(row.operationKey);
    const manualReason = metricText(row.manualReason, 1024);
    if (hasControlCharacter(manualReason))
      return allocationTypeError('manual reason contains a control character');
    const slices = metricArray(row.slices, 500).map(parseManualSlice);
    if (slices.length === 0)
      return allocationTypeError('manual allocation needs at least one slice');
    return {
      operationKey: parsedOperationKey,
      sourceSegmentId: metricText(row.sourceSegmentId, 64),
      expectedRevision: metricInteger(row.expectedRevision, 0, 2147483646),
      recognitionModeCode: 'manual',
      manualReason,
      slices: sortSlices(slices),
      evidenceAttachmentIds: parseEvidenceIds(row.evidenceAttachmentIds),
    };
  }
  return allocationTypeError('unknown recognition mode');
}

export function activityTimeAllocationRequestHash(
  activityId: string,
  actorUserId: string,
  command: ActivityTimeAllocationCommand,
): string {
  return fingerprintMetricEnvelope('activity-time-allocation-recognize-v1', {
    actorUserId: metricText(actorUserId, 64),
    activityId: metricText(activityId, 64),
    expectedRevision: command.expectedRevision,
    sourceSegmentId: command.sourceSegmentId,
    recognitionModeCode: command.recognitionModeCode,
    manualReason: command.manualReason,
    slices: command.slices,
    evidenceAttachmentIds: command.evidenceAttachmentIds,
  }).definitionHash;
}

export function buildActivityTimeAllocationManifest(
  slices: readonly ActivityTimeAllocationSliceInput[],
): { manifest: ActivityTimeAllocationManifest; allocationHash: string } {
  if (slices.length < 1 || slices.length > 500)
    return allocationTypeError('slice count is invalid');
  const ordered = sortSlices(slices);
  const mapped = Object.fromEntries(
    ordered.map((slice, ordinal) => [
      String(ordinal),
      {
        ordinal,
        categoryCode: slice.categoryCode,
        intervalKindCode: slice.intervalKindCode,
        startAt: slice.startAt,
        endAt: slice.endAt,
      },
    ]),
  ) as Record<string, ActivityTimeAllocationSliceManifest>;
  const manifest: ActivityTimeAllocationManifest = {
    schemaVersion: ACTIVITY_TIME_ALLOCATION_SCHEMA_VERSION,
    slices: mapped,
  };
  return {
    manifest,
    allocationHash: fingerprintMetricEnvelope('activity-time-allocation-manifest-v1', manifest)
      .definitionHash,
  };
}

export function parseActivityTimeAllocationReceipt(
  input: unknown,
  activityId: string,
  allocationRevisionId: string,
): ActivityTimeAllocationReceiptResult {
  const row = metricObject(input, [
    'schemaVersion',
    'activityId',
    'allocationRevisionId',
    'revision',
    'sourceSegmentId',
    'sourceSegmentRevision',
    'recognitionModeCode',
    'allocationHash',
    'sliceCount',
    'evidenceCount',
    'createdAt',
  ]);
  const recognitionModeCode = row.recognitionModeCode;
  const allocationHash = metricText(row.allocationHash, 64);
  if (
    row.schemaVersion !== ACTIVITY_TIME_ALLOCATION_SCHEMA_VERSION ||
    row.activityId !== activityId ||
    row.allocationRevisionId !== allocationRevisionId ||
    (recognitionModeCode !== 'automatic' && recognitionModeCode !== 'manual') ||
    !/^[0-9a-f]{64}$/u.test(allocationHash)
  )
    return allocationTypeError('invalid receipt identity');
  return {
    schemaVersion: ACTIVITY_TIME_ALLOCATION_SCHEMA_VERSION,
    activityId,
    allocationRevisionId,
    revision: metricInteger(row.revision, 1, 2147483647),
    sourceSegmentId: metricText(row.sourceSegmentId, 64),
    sourceSegmentRevision: metricInteger(row.sourceSegmentRevision, 1, 2147483647),
    recognitionModeCode,
    allocationHash,
    sliceCount: metricInteger(row.sliceCount, 1, 500),
    evidenceCount: metricInteger(row.evidenceCount, 0, 500),
    createdAt: isoInstant(row.createdAt),
  };
}
