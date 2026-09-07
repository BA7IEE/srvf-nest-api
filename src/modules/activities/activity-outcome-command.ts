import {
  fingerprintMetricEnvelope,
  metricArray,
  metricInteger,
  metricObject,
  metricText,
} from './activity-metric-definition';

export interface ActivityOutcomeValueInput {
  metricDefinitionId: string;
  value: string | number | boolean;
  evidenceAttachmentIds: string[];
}

export interface ActivityOutcomeCommandInput {
  operationKey: string;
  expectedRevision: number;
  metricSetVersionId: string;
  metricSetDefinitionHash: string;
  values: ActivityOutcomeValueInput[];
}

/** Creation facts only; current lifecycle status is obtained from the query service. */
export interface ActivityOutcomeCommandResult {
  schemaVersion: 1;
  activityId: string;
  outcomeRevisionId: string;
  revision: number;
  metricSetVersionId: string;
  metricSetDefinitionHash: string;
  createdStatusCode: 'draft';
  sourceCode: 'manual';
  valueCount: number;
  evidenceCount: number;
  createdAt: string;
}

function outcomeHash(input: unknown): string {
  const value = metricText(input, 64);
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError('invalid outcome hash');
  return value;
}

function parseValue(input: unknown): ActivityOutcomeValueInput {
  const hasEvidence =
    typeof input === 'object' &&
    input !== null &&
    Object.prototype.hasOwnProperty.call(input, 'evidenceAttachmentIds');
  const v = metricObject(
    input,
    hasEvidence
      ? ['metricDefinitionId', 'value', 'evidenceAttachmentIds']
      : ['metricDefinitionId', 'value'],
  );
  const value = v.value;
  // Exact definition-specific bounds and short_text rejection are enforced after
  // loading the locked set. This parser only admits a bounded scalar transport.
  if (
    !(
      typeof value === 'boolean' ||
      (typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        !Object.is(value, -0)) ||
      (typeof value === 'string' && value.length > 0 && value.length <= 64)
    )
  )
    throw new TypeError('invalid outcome scalar');
  const evidenceAttachmentIds = metricArray(hasEvidence ? v.evidenceAttachmentIds : [], 20).map(
    (id) => metricText(id, 64),
  );
  if (new Set(evidenceAttachmentIds).size !== evidenceAttachmentIds.length)
    throw new TypeError('duplicate outcome evidence');
  return {
    metricDefinitionId: metricText(v.metricDefinitionId, 64),
    value,
    evidenceAttachmentIds,
  };
}

export function parseActivityOutcomeCommand(input: unknown): ActivityOutcomeCommandInput {
  const v = metricObject(input, [
    'operationKey',
    'expectedRevision',
    'metricSetVersionId',
    'metricSetDefinitionHash',
    'values',
  ]);
  const values = metricArray(v.values, 100).map(parseValue);
  if (
    !values.length ||
    new Set(values.map((item) => item.metricDefinitionId)).size !== values.length
  )
    throw new TypeError('outcome metrics must be nonempty and unique');
  values.sort((a, b) =>
    a.metricDefinitionId < b.metricDefinitionId
      ? -1
      : a.metricDefinitionId > b.metricDefinitionId
        ? 1
        : 0,
  );
  return {
    operationKey: metricText(v.operationKey, 128),
    expectedRevision: metricInteger(v.expectedRevision, 0, 2147483646),
    metricSetVersionId: metricText(v.metricSetVersionId, 64),
    metricSetDefinitionHash: outcomeHash(v.metricSetDefinitionHash),
    values,
  };
}

export function activityOutcomeRequestHash(activityId: string, input: unknown): string {
  const command = parseActivityOutcomeCommand(input);
  return fingerprintMetricEnvelope('activity-outcome-record-manual-v1', {
    activityId: metricText(activityId, 64),
    expectedRevision: command.expectedRevision,
    metricSetVersionId: command.metricSetVersionId,
    metricSetDefinitionHash: command.metricSetDefinitionHash,
    values: command.values,
  }).definitionHash;
}

export function parseActivityOutcomeReceipt(
  input: unknown,
  activityId: string,
  outcomeRevisionId: string,
): ActivityOutcomeCommandResult {
  const v = metricObject(input, [
    'schemaVersion',
    'activityId',
    'outcomeRevisionId',
    'revision',
    'metricSetVersionId',
    'metricSetDefinitionHash',
    'createdStatusCode',
    'sourceCode',
    'valueCount',
    'evidenceCount',
    'createdAt',
  ]);
  const createdAt = metricText(v.createdAt, 24);
  const timestamp = new Date(createdAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== createdAt)
    throw new TypeError('invalid outcome creation time');
  const hash = metricText(v.metricSetDefinitionHash, 64);
  if (
    v.schemaVersion !== 1 ||
    v.activityId !== activityId ||
    v.outcomeRevisionId !== outcomeRevisionId ||
    v.createdStatusCode !== 'draft' ||
    v.sourceCode !== 'manual' ||
    !/^[0-9a-f]{64}$/.test(hash)
  )
    throw new TypeError('invalid outcome receipt');
  const valueCount = metricInteger(v.valueCount, 1, 100);
  return {
    schemaVersion: 1,
    activityId: metricText(v.activityId, 64),
    outcomeRevisionId: metricText(v.outcomeRevisionId, 64),
    revision: metricInteger(v.revision, 1, 2147483647),
    metricSetVersionId: metricText(v.metricSetVersionId, 64),
    metricSetDefinitionHash: hash,
    createdStatusCode: 'draft',
    sourceCode: 'manual',
    valueCount,
    evidenceCount: metricInteger(v.evidenceCount, 0, valueCount * 20),
    createdAt,
  };
}
