import {
  activityTimeAllocationRequestHash,
  parseActivityTimeAllocationCommand,
} from './activity-time-allocation-command';
import {
  parseTimeSettlementAllocationCommand,
  parseTimeSettlementPrepareCommand,
  parseTimeSettlementSubmitCommand,
  parseTimeSettlementReceipt,
  timeSettlementAllocationRequestHash,
  timeSettlementPrepareRequestHash,
  timeSettlementSubmitRequestHash,
  TIME_SETTLEMENT_ALLOCATION_OPERATION,
  TIME_SETTLEMENT_PREPARE_OPERATION,
  TIME_SETTLEMENT_SUBMIT_OPERATION,
} from './activity-time-settlement-command';

const prepare = {
  operationKey: 'd4-prepare-0001',
  expectedDraftVersion: 1,
  expectedEvidenceSealId: 'seal-0001',
  expectedTimeRevision: 0,
};
const submit = {
  operationKey: 'd4-submit-0001',
  expectedDraftVersion: 1,
  expectedEvidenceSealId: 'seal-0001',
  timeRevisionId: 'time-revision-0001',
  expectedBucketContentHash: 'a'.repeat(64),
};
const allocation = {
  operationKey: 'd4-allocation-0001',
  sourceSegmentId: 'segment-0001',
  expectedRevision: 0,
  recognitionModeCode: 'automatic',
  evidenceAttachmentIds: [],
};
const proof = {
  expectedDraftVersion: 1,
  expectedEvidenceSealId: 'seal-0001',
  expectedEvidenceRevision: 2,
  expectedPopulationRevision: 3,
  expectedWorkflowRevision: 4,
};

describe('D4 closed and safe durable receipts', () => {
  const result = {
    schemaVersion: 1,
    activityId: 'activity',
    timeRevisionId: 'time-revision',
    revision: 1,
    kindCode: 'draft',
    settlementRunId: 'run',
    settlementVersionId: 'version',
    settlementVersion: 2,
    contentHash: 'a'.repeat(64),
    bucketContentHash: 'b'.repeat(64),
    bucketCount: 4,
    sourceCount: 0,
    createdAt: '2026-09-12T00:00:00.000Z',
  };
  it('returns only the exact safe result', () => {
    expect(parseTimeSettlementReceipt(result, 'activity', 'time-revision')).toEqual(result);
  });
  it.each([
    { activityId: 'other' },
    { timeRevisionId: 'other' },
    { bucketCount: 3 },
    { sourceCount: 5 },
    { bucketCount: 8004 },
    { sourceCount: 40004 },
    { kindCode: 'posted' },
    { revision: 0 },
    { schemaVersion: 2 },
    { contentHash: 'broken' },
    { createdAt: '2026-02-30T00:00:00.000Z' },
    { operationKey: 'forbidden' },
    { signedUrl: 'forbidden' },
  ])('rejects damaged or overbroad result %j', (change) => {
    expect(() =>
      parseTimeSettlementReceipt({ ...result, ...change }, 'activity', 'time-revision'),
    ).toThrow(TypeError);
  });
});

describe('D4 explicit time settlement command boundary', () => {
  it('parses prepare and submit without accepting client-computed totals', () => {
    expect(parseTimeSettlementPrepareCommand(prepare)).toEqual(prepare);
    expect(parseTimeSettlementSubmitCommand(submit)).toEqual(submit);
  });

  it.each(['recognizedSeconds', 'calculatedSeconds', 'policyId', 'sources', 'draftContentHash'])(
    'rejects untrusted prepare field %s',
    (field) => {
      expect(() => parseTimeSettlementPrepareCommand({ ...prepare, [field]: 1 })).toThrow(
        TypeError,
      );
    },
  );

  it.each([
    { operationKey: 'short' },
    { operationKey: ' d4-prepare-0001' },
    { operationKey: 'd4-prepare-\n0001' },
    { operationKey: 'x'.repeat(129) },
    { expectedDraftVersion: 0 },
    { expectedDraftVersion: 1.5 },
    { expectedDraftVersion: 2147483648 },
    { expectedTimeRevision: -1 },
    { expectedTimeRevision: 2147483647 },
    { expectedEvidenceSealId: '' },
    { expectedEvidenceSealId: 'seal\u0085test' },
  ])('rejects malformed prepare input %j', (change) => {
    expect(() => parseTimeSettlementPrepareCommand({ ...prepare, ...change })).toThrow(TypeError);
  });

  it.each(['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), '', 'a'.repeat(65)])(
    'rejects noncanonical bucket digest %s',
    (hash) => {
      expect(() =>
        parseTimeSettlementSubmitCommand({ ...submit, expectedBucketContentHash: hash }),
      ).toThrow(TypeError);
    },
  );

  it('rejects missing, symbolic, inherited and accessor properties without invoking getters', () => {
    const getter = jest.fn(() => 1);
    const accessor = Object.defineProperty({ ...prepare }, 'expectedDraftVersion', { get: getter });
    expect(() => parseTimeSettlementPrepareCommand(accessor)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
    expect(() => parseTimeSettlementPrepareCommand({ ...prepare, [Symbol('hidden')]: 1 })).toThrow(
      TypeError,
    );
    expect(() => parseTimeSettlementPrepareCommand(Object.create(prepare))).toThrow(TypeError);
    expect(() => parseTimeSettlementPrepareCommand({ operationKey: prepare.operationKey })).toThrow(
      TypeError,
    );
  });

  it('keeps all D3 V1 fields and semantics, and refuses proof fields on the old parser', () => {
    const command = parseTimeSettlementAllocationCommand({ ...allocation, ...proof });
    expect(command).toEqual({
      ...proof,
      allocation: parseActivityTimeAllocationCommand(allocation),
    });
    expect(() => parseActivityTimeAllocationCommand({ ...allocation, ...proof })).toThrow(
      TypeError,
    );
    expect(() => parseTimeSettlementAllocationCommand(allocation)).toThrow(TypeError);
  });

  it('preserves manual reason, sorted evidence and interval validation from D3', () => {
    const manual = {
      ...allocation,
      recognitionModeCode: 'manual',
      manualReason: '现场确认的培训时间',
      slices: [
        {
          categoryCode: 'training',
          startAt: '2026-09-12T00:00:00.000Z',
          endAt: '2026-09-12T01:00:00.000Z',
        },
      ],
      evidenceAttachmentIds: ['attachment-b', 'attachment-a'],
    };
    expect(parseTimeSettlementAllocationCommand({ ...manual, ...proof }).allocation).toEqual(
      parseActivityTimeAllocationCommand(manual),
    );
    expect(() =>
      parseTimeSettlementAllocationCommand({ ...manual, ...proof, manualReason: '  ' }),
    ).toThrow(TypeError);
    expect(() =>
      parseTimeSettlementAllocationCommand({ ...manual, ...proof, manualReason: '理由\n换行' }),
    ).toThrow(TypeError);
  });

  it('does not invoke recognition-mode getters', () => {
    const getter = jest.fn(() => 'automatic');
    const input = Object.defineProperty({ ...allocation, ...proof }, 'recognitionModeCode', {
      get: getter,
    });
    expect(() => parseTimeSettlementAllocationCommand(input)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['expectedEvidenceRevision', 'expectedPopulationRevision', 'expectedWorkflowRevision'])(
    'requires a valid revision anchor %s',
    (field) => {
      expect(() =>
        parseTimeSettlementAllocationCommand({ ...allocation, ...proof, [field]: -1 }),
      ).toThrow(TypeError);
    },
  );

  it('isolates all three operation namespaces and the D3 V1 request hash', () => {
    expect(
      new Set([
        TIME_SETTLEMENT_ALLOCATION_OPERATION,
        TIME_SETTLEMENT_PREPARE_OPERATION,
        TIME_SETTLEMENT_SUBMIT_OPERATION,
      ]).size,
    ).toBe(3);
    const parsed = parseTimeSettlementAllocationCommand({ ...allocation, ...proof });
    const current = timeSettlementAllocationRequestHash('activity-1', 'actor-1', parsed);
    expect(current).not.toBe(
      activityTimeAllocationRequestHash('activity-1', 'actor-1', parsed.allocation),
    );
    expect(current).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not put the prepare operation key into the payload hash', () => {
    const parsed = parseTimeSettlementPrepareCommand(prepare);
    const hash = timeSettlementPrepareRequestHash('activity-1', 'actor-1', parsed);
    expect(
      timeSettlementPrepareRequestHash('activity-1', 'actor-1', {
        ...parsed,
        operationKey: 'other-key',
      }),
    ).toBe(hash);
    expect(timeSettlementPrepareRequestHash('activity-1', 'actor-2', parsed)).not.toBe(hash);
    expect(timeSettlementPrepareRequestHash('activity-2', 'actor-1', parsed)).not.toBe(hash);
    expect(
      timeSettlementPrepareRequestHash('activity-1', 'actor-1', {
        ...parsed,
        expectedTimeRevision: 1,
      }),
    ).not.toBe(hash);
  });

  it('binds the submitted revision, draft, seal and bucket digest', () => {
    const parsed = parseTimeSettlementSubmitCommand(submit);
    const hash = timeSettlementSubmitRequestHash('activity-1', 'actor-1', parsed);
    expect(
      timeSettlementSubmitRequestHash('activity-1', 'actor-1', {
        ...parsed,
        operationKey: 'other-key',
      }),
    ).toBe(hash);
    for (const change of [
      { timeRevisionId: 'other-revision' },
      { expectedDraftVersion: 2 },
      { expectedEvidenceSealId: 'other-seal' },
      { expectedBucketContentHash: 'b'.repeat(64) },
    ]) {
      expect(
        timeSettlementSubmitRequestHash('activity-1', 'actor-1', { ...parsed, ...change }),
      ).not.toBe(hash);
    }
  });

  it.each([
    'expectedEvidenceRevision',
    'expectedPopulationRevision',
    'expectedWorkflowRevision',
    'expectedDraftVersion',
  ] as const)('binds recognition proof field %s into the independent request hash', (field) => {
    const parsed = parseTimeSettlementAllocationCommand({ ...allocation, ...proof });
    const hash = timeSettlementAllocationRequestHash('activity-1', 'actor-1', parsed);
    expect(
      timeSettlementAllocationRequestHash('activity-1', 'actor-1', {
        ...parsed,
        [field]: parsed[field] + 1,
      }),
    ).not.toBe(hash);
  });
});
