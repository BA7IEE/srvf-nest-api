import {
  activityOutcomeRequestHash,
  parseActivityOutcomeCommand,
  parseActivityOutcomeReceipt,
} from './activity-outcome-command';

const command = () => ({
  operationKey: 'operation',
  expectedRevision: 0,
  metricSetVersionId: 'metric-set',
  metricSetDefinitionHash: 'a'.repeat(64),
  values: [{ metricDefinitionId: 'metric-a', value: true }],
});

describe('C2 manual outcome command', () => {
  it('canonicalizes missing evidence and metric order without reordering evidence', () => {
    const a = {
      ...command(),
      values: [
        { metricDefinitionId: 'metric-b', value: '1.25', evidenceAttachmentIds: ['two', 'one'] },
        { metricDefinitionId: 'metric-a', value: true },
      ],
    };
    const b = {
      ...a,
      values: [
        { metricDefinitionId: 'metric-a', value: true, evidenceAttachmentIds: [] },
        a.values[0],
      ],
    };
    expect(activityOutcomeRequestHash('activity', a)).toBe(
      activityOutcomeRequestHash('activity', b),
    );
    expect(parseActivityOutcomeCommand(a).values[1].evidenceAttachmentIds).toEqual(['two', 'one']);
    expect(a.values[0].metricDefinitionId).toBe('metric-b');
  });

  it('binds activity, expected revision, exact set, values and evidence order', () => {
    const base = {
      ...command(),
      values: [
        { metricDefinitionId: 'metric-a', value: true, evidenceAttachmentIds: ['one', 'two'] },
      ],
    };
    const hash = activityOutcomeRequestHash('activity', base);
    expect(activityOutcomeRequestHash('other', base)).not.toBe(hash);
    for (const changed of [
      { ...base, expectedRevision: 1 },
      { ...base, metricSetDefinitionHash: 'b'.repeat(64) },
      { ...base, metricSetVersionId: 'other-set' },
      { ...base, values: [{ ...base.values[0], value: false }] },
      { ...base, values: [{ ...base.values[0], evidenceAttachmentIds: ['two', 'one'] }] },
    ])
      expect(activityOutcomeRequestHash('activity', changed)).not.toBe(hash);
    expect(activityOutcomeRequestHash('activity', { ...base, operationKey: 'another' })).toBe(hash);
  });

  it.each([
    { ...command(), sourceCode: 'manual' },
    { ...command(), expectedRevision: 2147483647 },
    { ...command(), operationKey: 'x'.repeat(129) },
    { ...command(), values: [] },
    { ...command(), values: Array(101).fill(command().values[0]) },
    { ...command(), values: [command().values[0], command().values[0]] },
    ...[{}, null, -0, -1, 1.25, NaN, Infinity].map((value) => ({
      ...command(),
      values: [{ metricDefinitionId: 'metric', value }],
    })),
    { ...command(), values: [{ ...command().values[0], evidenceAttachmentIds: ['same', 'same'] }] },
    {
      ...command(),
      values: [{ ...command().values[0], evidenceAttachmentIds: Array(21).fill('id') }],
    },
    { ...command(), values: [{ ...command().values[0], confirmedAt: null }] },
  ])('rejects malformed or unbounded transport %#', (input) => {
    expect(() => parseActivityOutcomeCommand(input)).toThrow(TypeError);
  });

  it('does not invoke accessors or accept sparse arrays', () => {
    const getter = jest.fn();
    const item = Object.defineProperty(
      { metricDefinitionId: 'metric', value: true },
      'evidenceAttachmentIds',
      { get: getter, enumerable: true },
    );
    expect(() => parseActivityOutcomeCommand({ ...command(), values: [item] })).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
    expect(() => parseActivityOutcomeCommand({ ...command(), values: Array(1) })).toThrow(
      TypeError,
    );
  });
});

describe('C2 safe creation receipt', () => {
  const receipt = {
    schemaVersion: 1,
    activityId: 'activity',
    outcomeRevisionId: 'outcome',
    revision: 1,
    metricSetVersionId: 'metric-set',
    metricSetDefinitionHash: 'a'.repeat(64),
    createdStatusCode: 'draft',
    sourceCode: 'manual',
    valueCount: 1,
    evidenceCount: 0,
    createdAt: '2026-09-07T08:00:00.000Z',
  };
  it('accepts only the bounded creation summary', () => {
    expect(parseActivityOutcomeReceipt(receipt, 'activity', 'outcome')).toEqual(receipt);
  });
  it.each([
    { createdAt: 'not-a-time' },
    { activityId: 'other' },
    { outcomeRevisionId: 'other' },
    { schemaVersion: 2 },
    { createdStatusCode: 'confirmed' },
    { sourceCode: 'system' },
    { valueCount: 0 },
    { evidenceCount: 21 },
    { metricSetDefinitionHash: 'bad' },
    { values: [] },
    { key: 'hidden' },
  ])('rejects drift, unsafe fields and impossible counts %#', (change) => {
    expect(() =>
      parseActivityOutcomeReceipt({ ...receipt, ...change }, 'activity', 'outcome'),
    ).toThrow(TypeError);
  });
});
