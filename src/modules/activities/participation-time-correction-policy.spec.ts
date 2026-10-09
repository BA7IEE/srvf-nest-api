import {
  buildParticipationTimeCorrection,
  TimeCorrectionPolicyError,
  type TimeCorrectionAnchor,
  type TimeCorrectionRoot,
} from './participation-time-correction-policy';

const anchor: TimeCorrectionAnchor = {
  correctionRequestId: 'request',
  postingBatchId: 'batch',
  activityId: 'activity',
  settlementRunId: 'run',
  baseSettlementVersionId: 'v1',
  settlementVersionId: 'v2',
  rootManifestId: 'root',
  rootSettlementVersionId: 'v1',
  predecessorManifestId: null,
  baseContentHash: 'a'.repeat(64),
  requestHash: 'b'.repeat(64),
};
const root: TimeCorrectionRoot = {
  id: 'entry',
  manifestId: 'root',
  participationIdentityId: 'person',
  categoryCode: 'volunteer_service',
  recognizedSeconds: 3600,
};
const value = { rootEntryId: 'entry', recognizedSeconds: 1800 };
const build = () => buildParticipationTimeCorrection(anchor, [root], [value], []);

describe('E4 native unchanged-time basis remains separate from the current business base', () => {
  const nativeTimeBasis = {
    contributionRevisionId: 'native-unchanged-proof',
    activityId: anchor.activityId,
    settlementRunId: anchor.settlementRunId,
    baseSettlementVersionId: 'unchanged-business-version',
    effectiveTimeSettlementVersionId: anchor.rootSettlementVersionId,
  };
  const nativeAnchor = {
    ...anchor,
    baseSettlementVersionId: nativeTimeBasis.baseSettlementVersionId,
    settlementVersionId: 'next-time-version',
    sourceProofId: 'current-v3-source',
    sourceProofHash: 'c'.repeat(64),
    nativeTimeBasis,
  };
  it('pairs the real root after an unchanged business version, without leaking a synthetic basis into the manifest', () => {
    const next = buildParticipationTimeCorrection(nativeAnchor, [root], [value], []);
    expect(next.manifest.baseSettlementVersionId).toBe(nativeTimeBasis.baseSettlementVersionId);
    expect(next.manifest.rootManifestId).toBe(root.manifestId);
    expect(next.entries.map((entry) => entry.secondsDelta)).toEqual([-3600, 1800]);
    expect('nativeTimeBasis' in next.manifest).toBe(false);
  });
  it('retains the latest actual time predecessor across an unchanged business version', () => {
    const next = buildParticipationTimeCorrection(
      {
        ...nativeAnchor,
        predecessorManifestId: 'actual-time-predecessor',
        nativeTimeBasis: {
          ...nativeTimeBasis,
          effectiveTimeSettlementVersionId: 'last-time-version',
        },
      },
      [root],
      [value],
      [
        {
          id: 'prior-credit',
          manifestId: 'actual-time-predecessor',
          rootEntryId: root.id,
          participationIdentityId: root.participationIdentityId,
          categoryCode: root.categoryCode,
          entryTypeCode: 'credit',
          secondsDelta: 2400,
        },
      ],
    );
    expect(next.entries[0].secondsDelta).toBe(-2400);
    expect(next.entries[0].reversesCorrectionEntryId).toBe('prior-credit');
  });
  it.each([
    { contributionRevisionId: '' },
    { activityId: 'other-activity' },
    { settlementRunId: 'other-run' },
    { baseSettlementVersionId: 'stale-base' },
    { effectiveTimeSettlementVersionId: '' },
    { effectiveTimeSettlementVersionId: nativeAnchor.baseSettlementVersionId },
    { effectiveTimeSettlementVersionId: nativeAnchor.settlementVersionId },
    { effectiveTimeSettlementVersionId: 'different-time-root' },
  ])('rejects a missing, mismatched or unpaired native basis %#', (change) => {
    expect(() =>
      buildParticipationTimeCorrection(
        {
          ...nativeAnchor,
          nativeTimeBasis: { ...nativeTimeBasis, ...change },
        },
        [root],
        [value],
        [],
      ),
    ).toThrow(TimeCorrectionPolicyError);
  });
  it('can validate exact time pairing before submit has created its current V3 proof, without claiming it already exists', () => {
    const preview = buildParticipationTimeCorrection(
      { ...nativeAnchor, sourceProofId: null, sourceProofHash: null },
      [root],
      [value],
      [],
    );
    expect(preview.manifest.formatVersion).toBe(1);
    expect('sourceProofId' in preview.manifest).toBe(false);
    expect('sourceProofHash' in preview.manifest).toBe(false);
    expect(preview.manifest.baseSettlementVersionId).toBe(nativeAnchor.baseSettlementVersionId);
    expect(preview.entries.map((entry) => entry.secondsDelta)).toEqual([-3600, 1800]);
  });
  it('still rejects the different business base without a proven native basis', () => {
    const { nativeTimeBasis: _basis, ...unproven } = nativeAnchor;
    void _basis;
    expect(() => buildParticipationTimeCorrection(unproven, [root], [value], [])).toThrow(
      TimeCorrectionPolicyError,
    );
  });
});

describe('D7-1 immutable correction contents', () => {
  it('reverses the initial root exactly and posts a full replacement', () => {
    const result = build();
    expect(
      result.entries.map((e) => [e.entryTypeCode, e.secondsDelta, e.reversesCorrectionEntryId]),
    ).toEqual([
      ['reversal', -3600, null],
      ['credit', 1800, null],
    ]);
    expect(result.manifest.reversalSecondsTotal).toBe(-3600n);
    expect(result.manifest.replacementSecondsTotal).toBe(1800n);
    expect(result.categories.map((c) => c.netSecondsDelta)).toEqual(['-1800', '0', '0', '0']);
    expect(result.changed).toBe(true);
  });
  it('keeps paired zero entries without negative zero', () => {
    const result = buildParticipationTimeCorrection(
      anchor,
      [{ ...root, recognizedSeconds: 0 }],
      [{ ...value, recognizedSeconds: 0 }],
      [],
    );
    expect(result.entries.map((e) => e.secondsDelta)).toEqual([0, 0]);
    expect(result.changed).toBe(false);
  });
  it('uses the immediate prior credit instead of reversing the root again', () => {
    const result = buildParticipationTimeCorrection(
      {
        ...anchor,
        baseSettlementVersionId: 'v2',
        settlementVersionId: 'v3',
        predecessorManifestId: 'm2',
      },
      [root],
      [{ ...value, recognizedSeconds: 900 }],
      [
        {
          id: 'credit2',
          manifestId: 'm2',
          rootEntryId: root.id,
          participationIdentityId: root.participationIdentityId,
          categoryCode: root.categoryCode,
          entryTypeCode: 'credit',
          secondsDelta: 1800,
        },
      ],
    );
    expect(result.entries[0].secondsDelta).toBe(-1800);
    expect(result.entries[0].reversesCorrectionEntryId).toBe('credit2');
    expect(result.manifest.replacementSecondsTotal).toBe(900n);
  });
  it('is independent of root and replacement input ordering', () => {
    const other = { ...root, id: 'training', categoryCode: 'training' };
    const values = [value, { ...value, rootEntryId: 'training' }];
    expect(buildParticipationTimeCorrection(anchor, [root, other], values, [])).toEqual(
      buildParticipationTimeCorrection(anchor, [other, root], [...values].reverse(), []),
    );
  });
  it('changes content hashes but preserves keys for same-batch changed content', () => {
    const next = buildParticipationTimeCorrection(
      anchor,
      [root],
      [{ ...value, recognizedSeconds: 0 }],
      [],
    );
    expect(next.entries[1].entryKey).toBe(build().entries[1].entryKey);
    expect(next.entries[1].contentHash).not.toBe(build().entries[1].contentHash);
    expect(next.manifest.contentHash).not.toBe(build().manifest.contentHash);
  });
  it('keeps legacy chains in the exact V1 hash domain when no source proof exists', () => {
    const legacy = build();
    const explicitLegacy = buildParticipationTimeCorrection(
      { ...anchor, sourceProofId: null, sourceProofHash: null },
      [root],
      [value],
      [],
    );
    expect(explicitLegacy.manifest).toEqual(legacy.manifest);
    expect(explicitLegacy.manifest.formatVersion).toBe(1);
    expect('sourceProofId' in explicitLegacy.manifest).toBe(false);
    expect('sourceProofHash' in explicitLegacy.manifest).toBe(false);
  });
  it('binds a frozen source proof into the isolated format 2 hash domain', () => {
    const format2 = buildParticipationTimeCorrection(
      { ...anchor, sourceProofId: 'proof', sourceProofHash: 'c'.repeat(64) },
      [root],
      [value],
      [],
    );
    expect(format2.manifest.formatVersion).toBe(2);
    if (format2.manifest.formatVersion !== 2) throw new Error('expected format 2 proof');
    expect(format2.manifest.sourceProofId).toBe('proof');
    expect(format2.manifest.sourceProofHash).toBe('c'.repeat(64));
    expect(format2.manifest.contentHash).not.toBe(build().manifest.contentHash);
  });
  it.each([
    { sourceProofId: 'proof', sourceProofHash: null },
    { sourceProofId: null, sourceProofHash: 'c'.repeat(64) },
    { sourceProofId: '', sourceProofHash: 'c'.repeat(64) },
    { sourceProofId: 'proof', sourceProofHash: 'not-a-hash' },
  ])('rejects an incomplete or malformed source proof %#', (sourceProof) => {
    expect(() =>
      buildParticipationTimeCorrection({ ...anchor, ...sourceProof }, [root], [value], []),
    ).toThrow(TimeCorrectionPolicyError);
  });
  it.each([-1, 0.5, NaN, Infinity, 2147483648])(
    'rejects invalid replacement seconds %s',
    (seconds) => {
      expect(() =>
        buildParticipationTimeCorrection(
          anchor,
          [root],
          [{ ...value, recognizedSeconds: seconds }],
          [],
        ),
      ).toThrow(TimeCorrectionPolicyError);
    },
  );
  it('rejects a different root with the same cardinality', () => {
    expect(() =>
      buildParticipationTimeCorrection(anchor, [root], [{ ...value, rootEntryId: 'wrong' }], []),
    ).toThrow(TimeCorrectionPolicyError);
  });
  it('rejects missing replacement roots', () => {
    expect(() => buildParticipationTimeCorrection(anchor, [root], [], [])).toThrow(
      TimeCorrectionPolicyError,
    );
  });
  it('rejects duplicate identity/category roots', () => {
    expect(() =>
      buildParticipationTimeCorrection(
        anchor,
        [root, { ...root, id: 'other' }],
        [value, { ...value, rootEntryId: 'other' }],
        [],
      ),
    ).toThrow(TimeCorrectionPolicyError);
  });
  it('rejects unclassified categories', () => {
    expect(() =>
      buildParticipationTimeCorrection(
        anchor,
        [{ ...root, categoryCode: 'legacy_unclassified' }],
        [value],
        [],
      ),
    ).toThrow(TimeCorrectionPolicyError);
  });
  it('rejects a root from another manifest', () => {
    expect(() =>
      buildParticipationTimeCorrection(anchor, [{ ...root, manifestId: 'other' }], [value], []),
    ).toThrow(TimeCorrectionPolicyError);
  });
  it('requires a predecessor for subsequent versions', () => {
    expect(() =>
      buildParticipationTimeCorrection(
        { ...anchor, baseSettlementVersionId: 'later' },
        [root],
        [value],
        [],
      ),
    ).toThrow(TimeCorrectionPolicyError);
  });
  it.each(['reversal', 'unknown'])('never reverses a predecessor of type %s', (entryTypeCode) => {
    expect(() =>
      buildParticipationTimeCorrection(
        {
          ...anchor,
          baseSettlementVersionId: 'v2',
          settlementVersionId: 'v3',
          predecessorManifestId: 'm2',
        },
        [root],
        [value],
        [
          {
            id: 'prior',
            manifestId: 'm2',
            rootEntryId: root.id,
            participationIdentityId: root.participationIdentityId,
            categoryCode: root.categoryCode,
            entryTypeCode,
            secondsDelta: 1,
          },
        ],
      ),
    ).toThrow(TimeCorrectionPolicyError);
  });
  it.each([1, 100, 2000])(
    'retains every pair and exact int64 totals for %s identities',
    (count) => {
      const roots = Array.from({ length: count }, (_, i) =>
        ['volunteer_service', 'training', 'organization', 'non_creditable'].map((categoryCode) => ({
          ...root,
          id: `${i}-${categoryCode}`,
          participationIdentityId: `person-${i}`,
          categoryCode,
          recognizedSeconds: 2147483647,
        })),
      ).flat();
      const result = buildParticipationTimeCorrection(
        anchor,
        roots,
        roots.map((r) => ({ rootEntryId: r.id, recognizedSeconds: 2147483646 })),
        [],
      );
      expect(result.entries).toHaveLength(count * 8);
      expect(result.manifest.reversalSecondsTotal).toBe(-BigInt(count * 4) * 2147483647n);
      expect(result.manifest.replacementSecondsTotal).toBe(BigInt(count * 4) * 2147483646n);
    },
  );
});
