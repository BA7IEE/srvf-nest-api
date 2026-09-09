import {
  fingerprintMetricEnvelope,
  metricArray,
  metricInteger,
  metricObject,
  metricText,
} from './activity-metric-definition';

export interface MetricCandidateCommandInput {
  schemaVersion: 1;
  operationKey: string;
  expectedCandidateRevision: number;
  expectedOutcomeRevision: number;
  metricSetVersionId: string;
  metricSetDefinitionHash: string;
  bindingIds: string[];
}

export interface MetricCandidateCommandResult {
  schemaVersion: 1;
  candidateId: string;
  activityId: string;
  revision: number;
  metricSetVersionId: string;
  metricSetDefinitionHash: string;
  createdStatusCode: 'candidate';
  sourceCode: 'system';
  valueCount: number;
  sourceCount: number;
  createdAt: string;
}

export function candidateHash(input: unknown): string {
  const hash = metricText(input, 64);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new TypeError('invalid candidate hash');
  return hash;
}

export function candidateCreationTime(input: unknown): string {
  const text = metricText(input, 24);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text)
    throw new TypeError('invalid candidate creation time');
  return text;
}

/** Only accepts objects already built from closed parsers, never raw caller input. */
export function boundedMetricCommandEnvelope(domain: string, parsed: unknown) {
  const result = fingerprintMetricEnvelope(domain, parsed);
  if (Buffer.byteLength(result.canonicalText, 'utf8') > 16384)
    throw new TypeError('metric command envelope exceeds budget');
  return result;
}

export function assertMetricResultBudget(parsed: unknown): void {
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > 4096)
    throw new TypeError('metric command result exceeds budget');
}

export function parseMetricCandidateCommand(input: unknown): MetricCandidateCommandInput {
  const v = metricObject(input, [
    'schemaVersion',
    'operationKey',
    'expectedCandidateRevision',
    'expectedOutcomeRevision',
    'metricSetVersionId',
    'metricSetDefinitionHash',
    'bindingIds',
  ]);
  if (v.schemaVersion !== 1) throw new TypeError('unsupported candidate command schema');
  const bindingIds = metricArray(v.bindingIds, 100).map((id) => metricText(id, 64));
  if (!bindingIds.length || new Set(bindingIds).size !== bindingIds.length)
    throw new TypeError('candidate bindings must be nonempty and unique');
  bindingIds.sort();
  return {
    schemaVersion: 1,
    operationKey: metricText(v.operationKey, 128),
    expectedCandidateRevision: metricInteger(v.expectedCandidateRevision, 0, 2147483646),
    expectedOutcomeRevision: metricInteger(v.expectedOutcomeRevision, 0, 2147483646),
    metricSetVersionId: metricText(v.metricSetVersionId, 64),
    metricSetDefinitionHash: candidateHash(v.metricSetDefinitionHash),
    bindingIds,
  };
}

export function metricCandidateRequestHash(activityId: string, input: unknown): string {
  const command = parseMetricCandidateCommand(input);
  return boundedMetricCommandEnvelope('activity-metric-candidate-command-v1', {
    schemaVersion: command.schemaVersion,
    activityId: metricText(activityId, 64),
    expectedCandidateRevision: command.expectedCandidateRevision,
    expectedOutcomeRevision: command.expectedOutcomeRevision,
    metricSetVersionId: command.metricSetVersionId,
    metricSetDefinitionHash: command.metricSetDefinitionHash,
    bindingIds: command.bindingIds,
  }).definitionHash;
}

export function parseMetricCandidateReceipt(
  input: unknown,
  activityId: string,
  candidateId: string,
): MetricCandidateCommandResult {
  const v = metricObject(input, [
    'schemaVersion',
    'candidateId',
    'activityId',
    'revision',
    'metricSetVersionId',
    'metricSetDefinitionHash',
    'createdStatusCode',
    'sourceCode',
    'valueCount',
    'sourceCount',
    'createdAt',
  ]);
  if (
    v.schemaVersion !== 1 ||
    v.candidateId !== candidateId ||
    v.activityId !== activityId ||
    v.createdStatusCode !== 'candidate' ||
    v.sourceCode !== 'system'
  )
    throw new TypeError('invalid candidate receipt anchors');
  const result: MetricCandidateCommandResult = {
    schemaVersion: 1,
    candidateId: metricText(v.candidateId, 64),
    activityId: metricText(v.activityId, 64),
    revision: metricInteger(v.revision, 1, 2147483647),
    metricSetVersionId: metricText(v.metricSetVersionId, 64),
    metricSetDefinitionHash: candidateHash(v.metricSetDefinitionHash),
    createdStatusCode: 'candidate',
    sourceCode: 'system',
    valueCount: metricInteger(v.valueCount, 1, 100),
    sourceCount: metricInteger(v.sourceCount, 0, 10000),
    createdAt: candidateCreationTime(v.createdAt),
  };
  assertMetricResultBudget(result);
  return result;
}
