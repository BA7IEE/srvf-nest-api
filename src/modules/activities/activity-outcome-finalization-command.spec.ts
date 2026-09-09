import { instanceToPlain, plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AppConfirmActivityOutcomeDto,
  AppPrepareActivityOutcomeCorrectionDto,
} from './dto/app/app-activity-outcome-finalization.dto';
import {
  outcomeConfirmationRequestHash,
  outcomeCorrectionRequestHash,
  outcomeCorrectionCancellationHash,
  parseOutcomeCorrection,
  parseOutcomeCorrectionCancellation,
  parseOutcomeConfirmation,
  parseOutcomeFinalizationReceipt,
} from './activity-outcome-finalization-command';

describe('C3-2 HTTP DTO to strict command boundary', () => {
  const anchors = {
    operationKey: 'http-command',
    expectedLatestRevision: 2,
    expectedConfirmedRevision: 1,
    metricSetVersionId: 'set',
    metricSetDefinitionHash: 'a'.repeat(64),
  };
  it('preserves a manual correction through nested HTTP transformation', async () => {
    const dto = plainToInstance(AppPrepareActivityOutcomeCorrectionDto, {
      ...anchors,
      values: [
        { metricDefinitionId: 'metric', sourceKind: 'manual', value: 9, evidenceAttachmentIds: [] },
      ],
    });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    expect(parseOutcomeCorrection(instanceToPlain(dto)).values[0]).toEqual({
      metricDefinitionId: 'metric',
      sourceKind: 'manual',
      value: 9,
      evidenceAttachmentIds: [],
    });
  });
  it('preserves a system correction without accepting a client supplied value', async () => {
    const dto = plainToInstance(AppPrepareActivityOutcomeCorrectionDto, {
      ...anchors,
      candidateId: 'candidate',
      values: [
        {
          metricDefinitionId: 'metric',
          sourceKind: 'system',
          sourceValueId: 'candidate-value',
          evidenceAttachmentIds: [],
        },
      ],
    });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    expect(parseOutcomeCorrection(instanceToPlain(dto)).values[0].sourceKind).toBe('system');
    dto.values[0].value = 7;
    expect(() => parseOutcomeCorrection(instanceToPlain(dto))).toThrow(TypeError);
  });
  it('passes manual confirmation references but rejects value injection', async () => {
    const input = {
      ...anchors,
      manualDraftId: 'draft',
      values: [
        {
          metricDefinitionId: 'metric',
          sourceKind: 'manual',
          sourceValueId: 'saved-value',
          evidenceAttachmentIds: ['attachment'],
        },
      ],
    };
    const dto = plainToInstance(AppConfirmActivityOutcomeDto, input);
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
    expect(parseOutcomeConfirmation(instanceToPlain(dto)).manualDraftId).toBe('draft');
    const injected = plainToInstance(AppConfirmActivityOutcomeDto, {
      ...input,
      values: [{ ...input.values[0], value: 99 }],
    });
    expect(await validate(injected, { whitelist: true, forbidNonWhitelisted: true })).not.toEqual(
      [],
    );
  });
});

describe('C3-2 correction draft and cancellation input', () => {
  const manual = {
    metricDefinitionId: 'manual',
    sourceKind: 'manual',
    value: 9,
    evidenceAttachmentIds: [],
  };
  const system = {
    metricDefinitionId: 'system',
    sourceKind: 'system',
    sourceValueId: 'candidate-value',
    evidenceAttachmentIds: [],
  };
  const input = {
    operationKey: 'prepare',
    expectedLatestRevision: 3,
    expectedConfirmedRevision: 2,
    metricSetVersionId: 'set',
    metricSetDefinitionHash: 'a'.repeat(64),
    candidateId: 'candidate',
    values: [manual, system],
  };
  it('accepts new manual values and system references without requiring evidence yet', () => {
    expect(parseOutcomeCorrection(input)).toEqual(input);
  });
  it('binds manual value changes in the hash', () => {
    expect(outcomeCorrectionRequestHash('activity', input)).not.toBe(
      outcomeCorrectionRequestHash('activity', {
        ...input,
        values: [{ ...manual, value: 10 }, system],
      }),
    );
  });
  it('normalizes metric order and does not hash the retry key', () => {
    expect(outcomeCorrectionRequestHash('activity', input)).toBe(
      outcomeCorrectionRequestHash('activity', {
        ...input,
        operationKey: 'retry',
        values: [system, manual],
      }),
    );
  });
  it.each([
    { expectedConfirmedRevision: 0 },
    { expectedConfirmedRevision: 4 },
    { values: [] },
    { values: [manual, manual] },
    { candidateId: null },
    { values: [{ ...system, value: 100 }] },
    { values: [{ ...manual, sourceValueId: 'forged' }] },
    { values: [{ ...manual, value: -1 }] },
    { values: [{ ...manual, value: -0 }] },
    { values: [{ ...manual, value: 1.5 }] },
    { values: [{ ...manual, value: {} }] },
    { values: [{ ...manual, evidenceAttachmentIds: ['same', 'same'] }] },
  ])('rejects malformed correction %j', (change) => {
    expect(() => parseOutcomeCorrection({ ...input, ...change })).toThrow();
  });
  it('does not invoke a sourceKind accessor', () => {
    const getter = jest.fn(() => 'manual');
    const value = { ...manual };
    Object.defineProperty(value, 'sourceKind', { get: getter, enumerable: true });
    expect(() => parseOutcomeCorrection({ ...input, values: [value] })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  const cancel = {
    operationKey: 'cancel',
    expectedLatestRevision: 3,
    expectedConfirmedRevision: 2,
  };
  it('cancels by two anchors and binds the target in the hash', () => {
    expect(parseOutcomeCorrectionCancellation(cancel)).toEqual(cancel);
    expect(outcomeCorrectionCancellationHash('activity', 'draft-a', cancel)).not.toBe(
      outcomeCorrectionCancellationHash('activity', 'draft-b', cancel),
    );
  });
  it('allows cancellation at the revision ceiling without allocating another revision', () => {
    expect(
      parseOutcomeCorrectionCancellation({ ...cancel, expectedLatestRevision: 2147483647 })
        .expectedLatestRevision,
    ).toBe(2147483647);
  });
  it.each([{ expectedConfirmedRevision: 0 }, { expectedConfirmedRevision: 4 }, { delete: true }])(
    'rejects malformed cancellation %j',
    (change) => {
      expect(() => parseOutcomeCorrectionCancellation({ ...cancel, ...change })).toThrow();
    },
  );
});

describe('C3-2 confirmation input', () => {
  const manual = {
    metricDefinitionId: 'a',
    sourceKind: 'manual',
    sourceValueId: 'value-a',
    evidenceAttachmentIds: ['proof-a'],
  };
  const system = {
    metricDefinitionId: 'b',
    sourceKind: 'system',
    sourceValueId: 'value-b',
    evidenceAttachmentIds: ['proof-b'],
  };
  const command = {
    operationKey: 'confirm',
    expectedLatestRevision: 2,
    expectedConfirmedRevision: 0,
    metricSetVersionId: 'set',
    metricSetDefinitionHash: 'a'.repeat(64),
    manualDraftId: 'draft',
    candidateId: 'candidate',
    values: [manual, system],
  };
  it('accepts mixed sources without accepting client values', () => {
    expect(parseOutcomeConfirmation(command)).toEqual(command);
    expect(() =>
      parseOutcomeConfirmation({ ...command, values: [{ ...manual, value: 123 }] }),
    ).toThrow();
  });
  it('normalizes metric order and excludes the retry key from content hash', () => {
    expect(outcomeConfirmationRequestHash('activity', command)).toBe(
      outcomeConfirmationRequestHash('activity', {
        ...command,
        operationKey: 'retry',
        values: [system, manual],
      }),
    );
  });
  it('binds content hash to the activity', () => {
    expect(outcomeConfirmationRequestHash('activity', command)).not.toBe(
      outcomeConfirmationRequestHash('other', command),
    );
  });
  it.each([
    { values: [] },
    { values: [manual, manual] },
    { manualDraftId: null },
    { candidateId: null },
    { values: [{ ...manual, sourceKind: 'ai' }] },
    { values: [{ ...manual, evidenceAttachmentIds: [] }] },
    { values: [{ ...manual, evidenceAttachmentIds: ['same', 'same'] }] },
    {
      values: [
        { ...manual, evidenceAttachmentIds: Array.from({ length: 21 }, (_, i) => `proof-${i}`) },
      ],
    },
    { expectedConfirmedRevision: 3 },
    { metricSetDefinitionHash: 'A'.repeat(64) },
    { confirmedAt: '2026-09-09T00:00:00.000Z' },
  ])('rejects invalid selection %j', (change) => {
    expect(() => parseOutcomeConfirmation({ ...command, ...change })).toThrow();
  });
  it('accepts 100 values and 2000 evidence references but rejects 101 values', () => {
    const values = Array.from({ length: 100 }, (_, i) => ({
      ...manual,
      metricDefinitionId: `metric-${i}`,
      evidenceAttachmentIds: Array.from({ length: 20 }, (_, j) => `proof-${i}-${j}`),
    }));
    expect(parseOutcomeConfirmation({ ...command, values }).values).toHaveLength(100);
    expect(() =>
      parseOutcomeConfirmation({
        ...command,
        values: [...values, { ...manual, metricDefinitionId: 'extra' }],
      }),
    ).toThrow();
  });
  it('does not invoke an accessor supplied as an optional reference', () => {
    const getter = jest.fn(() => 'draft');
    const input = { ...command };
    Object.defineProperty(input, 'manualDraftId', { get: getter, enumerable: true });
    expect(() => parseOutcomeConfirmation(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('C3-2 immutable finalization receipts', () => {
  const receipt = {
    schemaVersion: 1,
    activityId: 'activity',
    outcomeRevisionId: 'outcome',
    revision: 2,
    createdStatusCode: 'confirmed',
    valueCount: 2,
    evidenceCount: 2,
    createdAt: '2026-09-09T00:00:00.000Z',
    operationCode: 'confirm_outcome',
  };
  const parse = (input: unknown) =>
    parseOutcomeFinalizationReceipt(input, 'activity', 'outcome', 'confirm_outcome');
  it('round trips only safe creation facts', () => {
    expect(parse(receipt)).toEqual(receipt);
  });
  it.each(['actorUserId', 'operationKey', 'requestHash', 'sourceJson', 'signedUrl'])(
    'rejects extra %s',
    (key) => {
      expect(() => parse({ ...receipt, [key]: 'forbidden' })).toThrow(TypeError);
    },
  );
  it.each([
    { schemaVersion: 2 },
    { activityId: 'other' },
    { outcomeRevisionId: 'other' },
    { operationCode: 'prepare_outcome_correction' },
    { createdStatusCode: 'draft' },
    { valueCount: 0 },
    { valueCount: 101 },
    { evidenceCount: 1 },
    { evidenceCount: 41 },
    { revision: 0 },
    { revision: 2147483648 },
    { createdAt: '2026-09-09' },
    { createdAt: '2026-02-30T00:00:00.000Z' },
  ])('rejects malformed receipt %j', (change) => {
    expect(() => parse({ ...receipt, ...change })).toThrow();
  });
  it('accepts the exact confirmation capacity', () => {
    expect(parse({ ...receipt, valueCount: 100, evidenceCount: 2000 }).evidenceCount).toBe(2000);
  });
  it.each([
    ['prepare_outcome_correction', 'draft'],
    ['cancel_outcome_correction', 'superseded'],
  ] as const)(
    'retains %s facts without requiring confirmation-level evidence',
    (operationCode, createdStatusCode) => {
      const input = { ...receipt, operationCode, createdStatusCode, evidenceCount: 0 };
      expect(parseOutcomeFinalizationReceipt(input, 'activity', 'outcome', operationCode)).toEqual(
        input,
      );
    },
  );
});
