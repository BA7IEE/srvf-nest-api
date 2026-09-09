import {
  metricCandidateRequestHash,
  parseMetricCandidateCommand,
  parseMetricCandidateReceipt,
} from './activity-metric-candidate-command';

describe('C3-1 candidate closed command and receipt', () => {
  const request = {
    schemaVersion: 1,
    operationKey: 'key',
    expectedCandidateRevision: 0,
    expectedOutcomeRevision: 0,
    metricSetVersionId: 'set',
    metricSetDefinitionHash: 'a'.repeat(64),
    bindingIds: ['b', 'a'],
  };
  const receipt = {
    schemaVersion: 1,
    candidateId: 'candidate',
    activityId: 'activity',
    revision: 1,
    metricSetVersionId: 'set',
    metricSetDefinitionHash: 'a'.repeat(64),
    createdStatusCode: 'candidate',
    sourceCode: 'system',
    valueCount: 2,
    sourceCount: 0,
    createdAt: '2025-01-01T00:00:00.000Z',
  };
  it('canonicalizes binding order without mutating the request or hashing the key', () => {
    const hash = metricCandidateRequestHash('activity', request);
    expect(parseMetricCandidateCommand(request).bindingIds).toEqual(['a', 'b']);
    expect(request.bindingIds).toEqual(['b', 'a']);
    expect(
      metricCandidateRequestHash('activity', {
        ...request,
        bindingIds: ['a', 'b'],
        operationKey: 'other-key',
      }),
    ).toBe(hash);
    expect(metricCandidateRequestHash('other', request)).not.toBe(hash);
  });
  it.each([
    { expectedCandidateRevision: 1 },
    { expectedOutcomeRevision: 1 },
    { metricSetVersionId: 'other' },
    { metricSetDefinitionHash: 'b'.repeat(64) },
    { bindingIds: ['other'] },
  ])('binds every semantic field in the request hash: %j', (change) => {
    expect(metricCandidateRequestHash('activity', { ...request, ...change })).not.toBe(
      metricCandidateRequestHash('activity', request),
    );
  });
  it.each([
    { schemaVersion: 2 },
    { extra: true },
    { bindingIds: [] },
    { bindingIds: ['a', 'a'] },
    { bindingIds: Array.from({ length: 101 }, (_, i) => String(i)) },
    { expectedCandidateRevision: 2147483647 },
    { expectedOutcomeRevision: -1 },
    { metricSetDefinitionHash: 'A'.repeat(64) },
    { operationKey: 'x'.repeat(129) },
  ])('rejects malformed commands: %j', (change) => {
    expect(() => parseMetricCandidateCommand({ ...request, ...change })).toThrow(TypeError);
  });
  it('rejects accessors without invoking them', () => {
    const getter = jest.fn(() => ['a']);
    const input = { ...request };
    Object.defineProperty(input, 'bindingIds', { get: getter, enumerable: true });
    expect(() => parseMetricCandidateCommand(input)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });
  it('enforces UTF-8 envelope budget without truncating identifiers', () => {
    const input = {
      ...request,
      bindingIds: Array.from({ length: 100 }, (_, i) => `${i}${'中'.repeat(60)}`),
    };
    expect(parseMetricCandidateCommand(input).bindingIds).toHaveLength(100);
    expect(() => metricCandidateRequestHash('activity', input)).toThrow(TypeError);
  });
  it('round-trips only immutable creation facts', () => {
    expect(parseMetricCandidateReceipt(receipt, 'activity', 'candidate')).toEqual(receipt);
  });
  it.each([
    { activityId: 'other' },
    { candidateId: 'other' },
    { sourceCode: 'manual' },
    { createdStatusCode: 'confirmed' },
    { fresh: true },
    { sourceCount: 10001 },
    { valueCount: 0 },
    { revision: 0 },
    { createdAt: '2025-02-30T00:00:00.000Z' },
  ])('rejects corrupted receipts: %j', (change) => {
    expect(() =>
      parseMetricCandidateReceipt({ ...receipt, ...change }, 'activity', 'candidate'),
    ).toThrow(TypeError);
  });
});
