import {
  fingerprintMetricEnvelope,
  metricArray,
  metricInteger,
  metricObject,
  metricText,
} from './activity-metric-definition';
import { parseActivityOutcomeCommand } from './activity-outcome-command';

export type OutcomeCorrectionValue =
  | {
      metricDefinitionId: string;
      sourceKind: 'manual';
      value: string | number | boolean;
      evidenceAttachmentIds: string[];
    }
  | {
      metricDefinitionId: string;
      sourceKind: 'system';
      sourceValueId: string;
      evidenceAttachmentIds: string[];
    };

export interface OutcomeCorrectionInput {
  operationKey: string;
  expectedLatestRevision: number;
  expectedConfirmedRevision: number;
  metricSetVersionId: string;
  metricSetDefinitionHash: string;
  candidateId: string | null;
  values: OutcomeCorrectionValue[];
}

/** A full replacement draft, not a patch of the current formal result. */
export function parseOutcomeCorrection(input: unknown): OutcomeCorrectionInput {
  const optional =
    input !== null && typeof input === 'object' && Object.hasOwn(input, 'candidateId')
      ? ['candidateId']
      : [];
  const row = metricObject(input, [
    'operationKey',
    'expectedLatestRevision',
    'expectedConfirmedRevision',
    'metricSetVersionId',
    'metricSetDefinitionHash',
    'values',
    ...optional,
  ]);
  const operationKey = metricText(row.operationKey, 128);
  const expectedLatestRevision = metricInteger(row.expectedLatestRevision, 1, 2147483646);
  const expectedConfirmedRevision = metricInteger(
    row.expectedConfirmedRevision,
    1,
    expectedLatestRevision,
  );
  const metricSetVersionId = metricText(row.metricSetVersionId, 64);
  const metricSetDefinitionHash = metricText(row.metricSetDefinitionHash, 64);
  if (!/^[0-9a-f]{64}$/.test(metricSetDefinitionHash))
    throw new TypeError('invalid correction set hash');
  const candidateId =
    row.candidateId === undefined || row.candidateId === null
      ? null
      : metricText(row.candidateId, 64);
  const values = metricArray(row.values, 100).map((inputValue): OutcomeCorrectionValue => {
    const descriptor =
      inputValue !== null && typeof inputValue === 'object'
        ? Object.getOwnPropertyDescriptor(inputValue, 'sourceKind')
        : undefined;
    const sourceKind: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (sourceKind !== 'manual' && sourceKind !== 'system')
      throw new TypeError('invalid correction source');
    const value = metricObject(inputValue, [
      'metricDefinitionId',
      'sourceKind',
      sourceKind === 'manual' ? 'value' : 'sourceValueId',
      'evidenceAttachmentIds',
    ]);
    if (sourceKind === 'manual') {
      const parsed = parseActivityOutcomeCommand({
        operationKey,
        expectedRevision: expectedLatestRevision,
        metricSetVersionId,
        metricSetDefinitionHash,
        values: [
          {
            metricDefinitionId: value.metricDefinitionId,
            value: value.value,
            evidenceAttachmentIds: value.evidenceAttachmentIds,
          },
        ],
      });
      return { ...parsed.values[0], sourceKind };
    }
    if (candidateId === null) throw new TypeError('system correction requires a candidate');
    const evidenceAttachmentIds = metricArray(value.evidenceAttachmentIds, 20).map((id) =>
      metricText(id, 64),
    );
    if (new Set(evidenceAttachmentIds).size !== evidenceAttachmentIds.length)
      throw new TypeError('duplicate correction evidence');
    return {
      metricDefinitionId: metricText(value.metricDefinitionId, 64),
      sourceKind,
      sourceValueId: metricText(value.sourceValueId, 64),
      evidenceAttachmentIds,
    };
  });
  if (
    !values.length ||
    new Set(values.map((value) => value.metricDefinitionId)).size !== values.length
  )
    throw new TypeError('correction metrics must be nonempty and unique');
  values.sort((a, b) =>
    a.metricDefinitionId < b.metricDefinitionId
      ? -1
      : a.metricDefinitionId > b.metricDefinitionId
        ? 1
        : 0,
  );
  return {
    operationKey,
    expectedLatestRevision,
    expectedConfirmedRevision,
    metricSetVersionId,
    metricSetDefinitionHash,
    candidateId,
    values,
  };
}

export function outcomeCorrectionRequestHash(activityId: string, input: unknown): string {
  const command = parseOutcomeCorrection(input);
  return fingerprintMetricEnvelope('activity-outcome-correct-v1', {
    activityId: metricText(activityId, 64),
    expectedLatestRevision: command.expectedLatestRevision,
    expectedConfirmedRevision: command.expectedConfirmedRevision,
    metricSetVersionId: command.metricSetVersionId,
    metricSetDefinitionHash: command.metricSetDefinitionHash,
    candidateId: command.candidateId,
    values: command.values,
  }).definitionHash;
}

export function parseOutcomeCorrectionCancellation(input: unknown) {
  const row = metricObject(input, [
    'operationKey',
    'expectedLatestRevision',
    'expectedConfirmedRevision',
  ]);
  const expectedLatestRevision = metricInteger(row.expectedLatestRevision, 1, 2147483647);
  return {
    operationKey: metricText(row.operationKey, 128),
    expectedLatestRevision,
    expectedConfirmedRevision: metricInteger(
      row.expectedConfirmedRevision,
      1,
      expectedLatestRevision,
    ),
  };
}

export function outcomeCorrectionCancellationHash(
  activityId: string,
  outcomeRevisionId: string,
  input: unknown,
): string {
  const command = parseOutcomeCorrectionCancellation(input);
  return fingerprintMetricEnvelope('activity-outcome-cancel-correction-v1', {
    activityId: metricText(activityId, 64),
    outcomeRevisionId: metricText(outcomeRevisionId, 64),
    expectedLatestRevision: command.expectedLatestRevision,
    expectedConfirmedRevision: command.expectedConfirmedRevision,
  }).definitionHash;
}

export interface OutcomeConfirmationSelection {
  metricDefinitionId: string;
  sourceKind: 'manual' | 'system';
  sourceValueId: string;
  evidenceAttachmentIds: string[];
}

export interface OutcomeConfirmationInput {
  operationKey: string;
  expectedLatestRevision: number;
  expectedConfirmedRevision: number;
  metricSetVersionId: string;
  metricSetDefinitionHash: string;
  manualDraftId: string | null;
  candidateId: string | null;
  values: OutcomeConfirmationSelection[];
}

/** No client-provided numeric value, rule, identity or confirmation time is accepted. */
export function parseOutcomeConfirmation(input: unknown): OutcomeConfirmationInput {
  const optional = ['manualDraftId', 'candidateId'].filter(
    (key) => input !== null && typeof input === 'object' && Object.hasOwn(input, key),
  );
  const row = metricObject(input, [
    'operationKey',
    'expectedLatestRevision',
    'expectedConfirmedRevision',
    'metricSetVersionId',
    'metricSetDefinitionHash',
    'values',
    ...optional,
  ]);
  const values = metricArray(row.values, 100).map((item): OutcomeConfirmationSelection => {
    const value = metricObject(item, [
      'metricDefinitionId',
      'sourceKind',
      'sourceValueId',
      'evidenceAttachmentIds',
    ]);
    if (value.sourceKind !== 'manual' && value.sourceKind !== 'system')
      throw new TypeError('invalid confirmation source kind');
    const evidenceAttachmentIds = metricArray(value.evidenceAttachmentIds, 20).map((id) =>
      metricText(id, 64),
    );
    if (
      !evidenceAttachmentIds.length ||
      new Set(evidenceAttachmentIds).size !== evidenceAttachmentIds.length
    )
      throw new TypeError('confirmation evidence must be nonempty and unique');
    return {
      metricDefinitionId: metricText(value.metricDefinitionId, 64),
      sourceKind: value.sourceKind,
      sourceValueId: metricText(value.sourceValueId, 64),
      evidenceAttachmentIds,
    };
  });
  if (
    !values.length ||
    new Set(values.map((value) => value.metricDefinitionId)).size !== values.length
  )
    throw new TypeError('confirmation metrics must be nonempty and unique');
  values.sort((a, b) =>
    a.metricDefinitionId < b.metricDefinitionId
      ? -1
      : a.metricDefinitionId > b.metricDefinitionId
        ? 1
        : 0,
  );
  const manualDraftId =
    row.manualDraftId === undefined || row.manualDraftId === null
      ? null
      : metricText(row.manualDraftId, 64);
  const candidateId =
    row.candidateId === undefined || row.candidateId === null
      ? null
      : metricText(row.candidateId, 64);
  if (values.some((value) => value.sourceKind === 'manual') && manualDraftId === null)
    throw new TypeError('manual confirmation requires a draft');
  if (values.some((value) => value.sourceKind === 'system') && candidateId === null)
    throw new TypeError('system confirmation requires a candidate');
  const metricSetDefinitionHash = metricText(row.metricSetDefinitionHash, 64);
  if (!/^[0-9a-f]{64}$/.test(metricSetDefinitionHash))
    throw new TypeError('invalid confirmation set hash');
  const expectedLatestRevision = metricInteger(row.expectedLatestRevision, 0, 2147483646);
  return {
    operationKey: metricText(row.operationKey, 128),
    expectedLatestRevision,
    expectedConfirmedRevision: metricInteger(
      row.expectedConfirmedRevision,
      0,
      expectedLatestRevision,
    ),
    metricSetVersionId: metricText(row.metricSetVersionId, 64),
    metricSetDefinitionHash,
    manualDraftId,
    candidateId,
    values,
  };
}

export function outcomeConfirmationRequestHash(activityId: string, input: unknown): string {
  const command = parseOutcomeConfirmation(input);
  return fingerprintMetricEnvelope('activity-outcome-confirm-v1', {
    activityId: metricText(activityId, 64),
    expectedLatestRevision: command.expectedLatestRevision,
    expectedConfirmedRevision: command.expectedConfirmedRevision,
    metricSetVersionId: command.metricSetVersionId,
    metricSetDefinitionHash: command.metricSetDefinitionHash,
    manualDraftId: command.manualDraftId,
    candidateId: command.candidateId,
    values: command.values,
  }).definitionHash;
}

export type OutcomeFinalizationOperation =
  | 'confirm_outcome'
  | 'prepare_outcome_correction'
  | 'cancel_outcome_correction';

export interface OutcomeFinalizationResult {
  schemaVersion: 1;
  activityId: string;
  outcomeRevisionId: string;
  revision: number;
  createdStatusCode: 'confirmed' | 'draft' | 'superseded';
  valueCount: number;
  evidenceCount: number;
  createdAt: string;
  operationCode: OutcomeFinalizationOperation;
}

/** Immutable command facts, not a claim about the target's current status. */
export function parseOutcomeFinalizationReceipt(
  input: unknown,
  activityId: string,
  outcomeRevisionId: string,
  operationCode: OutcomeFinalizationOperation,
): OutcomeFinalizationResult {
  const row = metricObject(input, [
    'schemaVersion',
    'activityId',
    'outcomeRevisionId',
    'revision',
    'createdStatusCode',
    'valueCount',
    'evidenceCount',
    'createdAt',
    'operationCode',
  ]);
  const statusByOperation = {
    confirm_outcome: 'confirmed',
    prepare_outcome_correction: 'draft',
    cancel_outcome_correction: 'superseded',
  } as const;
  const createdStatusCode = statusByOperation[operationCode];
  if (
    !createdStatusCode ||
    row.schemaVersion !== 1 ||
    row.activityId !== activityId ||
    row.outcomeRevisionId !== outcomeRevisionId ||
    row.operationCode !== operationCode ||
    row.createdStatusCode !== createdStatusCode
  )
    throw new TypeError('invalid finalization receipt anchors');
  const createdAt = metricText(row.createdAt, 24);
  const timestamp = new Date(createdAt);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== createdAt)
    throw new TypeError('invalid finalization receipt time');
  const valueCount = metricInteger(row.valueCount, 1, 100);
  return {
    schemaVersion: 1,
    activityId: metricText(row.activityId, 64),
    outcomeRevisionId: metricText(row.outcomeRevisionId, 64),
    revision: metricInteger(row.revision, 1, 2147483647),
    createdStatusCode,
    valueCount,
    evidenceCount: metricInteger(
      row.evidenceCount,
      operationCode === 'confirm_outcome' ? valueCount : 0,
      valueCount * 20,
    ),
    createdAt,
    operationCode,
  };
}
