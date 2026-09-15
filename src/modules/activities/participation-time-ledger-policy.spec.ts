import {
  buildParticipationTimeLedger,
  TimeLedgerPolicyError,
  type TimeLedgerAnchor,
} from './participation-time-ledger-policy';

const anchor: TimeLedgerAnchor = {
  postingBatchId: 'batch',
  activityId: 'activity',
  settlementRunId: 'run',
  settlementVersionId: 'version',
  timeRevisionId: 'revision',
  bucketContentHash: 'a'.repeat(64),
  sourceSetHash: 'b'.repeat(64),
};
const bucket = {
  id: 'bucket',
  participationIdentityId: 'identity',
  categoryCode: 'volunteer_service',
  recognizedSeconds: 0,
};

describe('D6 canonical participation time ledger', () => {
  it('retains zero entries and all four decimal-string totals', () => {
    const result = buildParticipationTimeLedger(anchor, [bucket]);
    expect(result.entries).toHaveLength(1);
    expect(result.manifest.expectedEntryCount).toBe(1);
    expect(result.manifest.recognizedSecondsTotal).toBe(0n);
    expect(result.categories).toEqual(
      ['volunteer_service', 'training', 'organization', 'non_creditable'].map((categoryCode) => ({
        categoryCode,
        recognizedSecondsTotal: '0',
      })),
    );
  });
  it('is independent of source row ordering', () => {
    const other = { ...bucket, id: 'other', categoryCode: 'training', recognizedSeconds: 20 };
    expect(buildParticipationTimeLedger(anchor, [bucket, other])).toEqual(
      buildParticipationTimeLedger(anchor, [other, bucket]),
    );
  });
  it('keeps non-volunteer seconds separate and sums above int32 exactly', () => {
    const result = buildParticipationTimeLedger(anchor, [
      { ...bucket, recognizedSeconds: 2147483647 },
      { ...bucket, id: 'training', categoryCode: 'training', recognizedSeconds: 2147483647 },
    ]);
    expect(result.manifest.recognizedSecondsTotal).toBe(4294967294n);
    expect(result.categories[0].recognizedSecondsTotal).toBe('2147483647');
    expect(result.categories[1].recognizedSecondsTotal).toBe('2147483647');
  });
  it('changes entry keys across batches but not for changed content in the same source key', () => {
    const original = buildParticipationTimeLedger(anchor, [bucket]);
    const changed = buildParticipationTimeLedger(anchor, [{ ...bucket, recognizedSeconds: 1 }]);
    expect(changed.entries[0].entryKey).toBe(original.entries[0].entryKey);
    expect(changed.entries[0].contentHash).not.toBe(original.entries[0].contentHash);
    expect(changed.manifest.contentHash).not.toBe(original.manifest.contentHash);
    expect(
      buildParticipationTimeLedger({ ...anchor, postingBatchId: 'other' }, [bucket]).entries[0]
        .entryKey,
    ).not.toBe(original.entries[0].entryKey);
  });
  it.each([-1, 0.5, 2147483648, NaN, Infinity])(
    'rejects invalid seconds %s',
    (recognizedSeconds) => {
      expect(() =>
        buildParticipationTimeLedger(anchor, [{ ...bucket, recognizedSeconds }]),
      ).toThrow(TimeLedgerPolicyError);
    },
  );
  it('rejects legacy unclassified buckets', () => {
    expect(() =>
      buildParticipationTimeLedger(anchor, [{ ...bucket, categoryCode: 'legacy_unclassified' }]),
    ).toThrow(TimeLedgerPolicyError);
  });
  it('rejects repeated source buckets', () => {
    expect(() => buildParticipationTimeLedger(anchor, [bucket, bucket])).toThrow(
      TimeLedgerPolicyError,
    );
  });
  it('rejects repeated identity/category even with different bucket ids', () => {
    expect(() =>
      buildParticipationTimeLedger(anchor, [bucket, { ...bucket, id: 'other' }]),
    ).toThrow(TimeLedgerPolicyError);
  });
  it('supports an empty manifest without inventing entries', () => {
    expect(buildParticipationTimeLedger(anchor, []).manifest.expectedEntryCount).toBe(0);
  });
  it('rejects malformed source hashes', () => {
    expect(() =>
      buildParticipationTimeLedger({ ...anchor, sourceSetHash: 'invalid' }, [bucket]),
    ).toThrow(TimeLedgerPolicyError);
  });
  it.each([1, 100, 2000])('preserves all four buckets for %s identities', (count) => {
    const buckets = Array.from({ length: count }, (_, index) =>
      ['volunteer_service', 'training', 'organization', 'non_creditable'].map((categoryCode) => ({
        id: `bucket-${index}-${categoryCode}`,
        participationIdentityId: `identity-${index}`,
        categoryCode,
        recognizedSeconds: 2147483647,
      })),
    ).flat();
    const result = buildParticipationTimeLedger(anchor, buckets);
    expect(result.entries).toHaveLength(count * 4);
    expect(result.manifest.expectedEntryCount).toBe(count * 4);
    expect(result.manifest.recognizedSecondsTotal).toBe(BigInt(count) * 4n * 2147483647n);
    expect(new Set(result.entries.map((entry) => entry.entryKey)).size).toBe(count * 4);
    expect(buildParticipationTimeLedger(anchor, [...buckets].reverse())).toEqual(result);
  });
  it('rejects more than 2000 identities without silently truncating', () => {
    const buckets = Array.from({ length: 2001 }, (_, index) => ({
      ...bucket,
      id: `bucket-${index}`,
      participationIdentityId: `identity-${index}`,
    }));
    expect(() => buildParticipationTimeLedger(anchor, buckets)).toThrow(TimeLedgerPolicyError);
  });
  it('rejects more than 8000 buckets before building entries', () => {
    expect(() => buildParticipationTimeLedger(anchor, Array(8001).fill(bucket))).toThrow(
      TimeLedgerPolicyError,
    );
  });
});
