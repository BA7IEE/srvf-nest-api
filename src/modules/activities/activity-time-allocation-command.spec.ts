import {
  activityTimeAllocationRequestHash,
  buildActivityTimeAllocationManifest,
  parseActivityTimeAllocationCommand,
  parseActivityTimeAllocationReceipt,
} from './activity-time-allocation-command';

const automatic = () => ({
  operationKey: 'allocation-operation',
  sourceSegmentId: 'segment-one',
  expectedRevision: 0,
  recognitionModeCode: 'automatic',
  evidenceAttachmentIds: [],
});

const manual = () => ({
  operationKey: 'allocation-operation',
  sourceSegmentId: 'segment-one',
  expectedRevision: 0,
  recognitionModeCode: 'manual',
  manualReason: '现场复核后的人工分类',
  slices: [
    {
      categoryCode: 'training',
      startAt: '2026-09-12T09:00:00.000Z',
      endAt: '2026-09-12T10:00:00.000Z',
    },
    {
      categoryCode: 'volunteer_service',
      startAt: '2026-09-12T08:00:00.000Z',
      endAt: '2026-09-12T09:00:00.000Z',
    },
  ],
  evidenceAttachmentIds: ['attachment-two', 'attachment-one'],
});

describe('D3 participant time-allocation command grammar', () => {
  it('canonicalizes manual slices and attachment IDs without mutating caller input', () => {
    const input = manual();
    const before = JSON.stringify(input);
    const parsed = parseActivityTimeAllocationCommand(input);
    expect(parsed).toMatchObject({ recognitionModeCode: 'manual' });
    if (parsed.recognitionModeCode !== 'manual') throw new Error('manual fixture drifted');
    expect(parsed.slices.map((slice) => slice.startAt)).toEqual([
      '2026-09-12T08:00:00.000Z',
      '2026-09-12T09:00:00.000Z',
    ]);
    expect(parsed.evidenceAttachmentIds).toEqual(['attachment-one', 'attachment-two']);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('binds actor/activity/payload but not the idempotency key into the request hash', () => {
    const parsed = parseActivityTimeAllocationCommand(manual());
    const hash = activityTimeAllocationRequestHash('activity-one', 'actor-one', parsed);
    expect(
      activityTimeAllocationRequestHash(
        'activity-one',
        'actor-one',
        parseActivityTimeAllocationCommand({ ...manual(), operationKey: 'another-operation' }),
      ),
    ).toBe(hash);
    expect(activityTimeAllocationRequestHash('activity-two', 'actor-one', parsed)).not.toBe(hash);
    expect(activityTimeAllocationRequestHash('activity-one', 'actor-two', parsed)).not.toBe(hash);
    expect(
      activityTimeAllocationRequestHash(
        'activity-one',
        'actor-one',
        parseActivityTimeAllocationCommand({ ...manual(), expectedRevision: 1 }),
      ),
    ).not.toBe(hash);
  });

  it('accepts only the two exact mode shapes and bounded, safe values', () => {
    expect(parseActivityTimeAllocationCommand(automatic())).toMatchObject({
      recognitionModeCode: 'automatic',
      manualReason: null,
      slices: [],
    });
    for (const value of [
      { ...automatic(), slices: [] },
      { ...automatic(), operationKey: 'short' },
      { ...automatic(), operationKey: 'allocation\nkey' },
      { ...automatic(), evidenceAttachmentIds: ['same', 'same'] },
      { ...manual(), manualReason: 'with\u0000control' },
      { ...manual(), slices: [] },
      {
        ...manual(),
        slices: [{ ...manual().slices[0], endAt: '2026-09-12T09:00:00.000Z' }],
      },
      { ...manual(), extra: true },
      { ...manual(), expectedRevision: 2147483647 },
    ]) {
      expect(() => parseActivityTimeAllocationCommand(value)).toThrow(TypeError);
    }
  });

  it('does not invoke an attacker-owned discriminant accessor', () => {
    const getter = jest.fn();
    const input = Object.defineProperty({ ...automatic() }, 'recognitionModeCode', {
      get: getter,
      enumerable: true,
    });
    expect(() => parseActivityTimeAllocationCommand(input)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('D3 canonical manifest and receipt', () => {
  const receipt = {
    schemaVersion: 1,
    activityId: 'activity-one',
    allocationRevisionId: 'allocation-one',
    revision: 1,
    sourceSegmentId: 'segment-one',
    sourceSegmentRevision: 2,
    recognitionModeCode: 'automatic',
    allocationHash: 'a'.repeat(64),
    sliceCount: 1,
    evidenceCount: 0,
    createdAt: '2026-09-12T08:00:00.000Z',
  } as const;

  it('creates a stable ordinal manifest independent of caller slice order', () => {
    const slices = parseActivityTimeAllocationCommand(manual());
    if (slices.recognitionModeCode !== 'manual') throw new Error('manual fixture drifted');
    const reversed = [...slices.slices].reverse();
    const first = buildActivityTimeAllocationManifest(slices.slices);
    const second = buildActivityTimeAllocationManifest(reversed);
    expect(second).toEqual(first);
    expect(first.manifest.slices['0']).toMatchObject({ ordinal: 0 });
  });

  it('keeps replay receipts closed and identity-bound', () => {
    expect(parseActivityTimeAllocationReceipt(receipt, 'activity-one', 'allocation-one')).toEqual(
      receipt,
    );
    for (const change of [
      { activityId: 'activity-two' },
      { allocationRevisionId: 'allocation-two' },
      { recognitionModeCode: 'future' },
      { allocationHash: 'A'.repeat(64) },
      { createdAt: '2026-09-12T08:00:00Z' },
      { operationKey: 'must-not-leak' },
    ]) {
      expect(() =>
        parseActivityTimeAllocationReceipt(
          { ...receipt, ...change },
          'activity-one',
          'allocation-one',
        ),
      ).toThrow(TypeError);
    }
  });
});
