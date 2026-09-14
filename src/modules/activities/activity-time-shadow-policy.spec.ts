import {
  compareTimeShadow,
  timeShadowHoursToSeconds,
  type TimeShadowAnchor,
  type TimeShadowBucket,
} from './activity-time-shadow-policy';
import {
  TIME_SETTLEMENT_CATEGORIES,
  TimeSettlementPolicyError,
} from './activity-time-settlement-policy';

const anchor: TimeShadowAnchor = {
  activityId: 'activity',
  settlementRunId: 'run',
  settlementVersionId: 'submitted',
  timeRevisionId: 'time',
  legacyContentHash: 'a'.repeat(64),
  draftContentHash: 'b'.repeat(64),
  sourceSetHash: 'c'.repeat(64),
  bucketContentHash: 'd'.repeat(64),
};
const legacy = (id = 'identity', hours = '1.00') => ({
  participationIdentityId: id,
  calculatedServiceHours: hours,
  recognizedServiceHours: hours,
  manuallyAdjusted: false,
});
function buckets(id = 'identity', seconds = 3600): TimeShadowBucket[] {
  return TIME_SETTLEMENT_CATEGORIES.map((categoryCode) => ({
    id: id + '-' + categoryCode,
    participationIdentityId: id,
    categoryCode,
    calculatedSeconds: categoryCode === 'volunteer_service' ? seconds : 0,
    recognizedSeconds: categoryCode === 'volunteer_service' ? seconds : 0,
    manuallyAdjusted: false,
  }));
}

describe('D5 exact time shadow comparison', () => {
  it.each([
    ['0', 0],
    ['0.01', 36],
    ['1.1', 3960],
    ['999.99', 3599964],
  ])('converts %s hours without floating rounding', (value, seconds) => {
    expect(timeShadowHoursToSeconds(value)).toBe(seconds);
  });
  it.each(['-1', '1.001', '1e2', 'NaN', 'Infinity', '', ' 1', '1000'])(
    'rejects invalid decimal %s',
    (value) => {
      expect(() => timeShadowHoursToSeconds(value)).toThrow(TimeSettlementPolicyError);
    },
  );
  it('compares zero and centihours exactly, without tolerance', () => {
    expect(compareTimeShadow(anchor, [legacy('i', '0.01')], buckets('i', 36)).summary.matched).toBe(
      1,
    );
    const report = compareTimeShadow(anchor, [legacy('i', '0.01')], buckets('i', 35));
    expect(report.items[0]).toMatchObject({
      status: 'different',
      calculatedDifferenceSeconds: -1,
      recognizedDifferenceSeconds: -1,
      reasons: ['unexplained'],
    });
    expect(compareTimeShadow(anchor, [legacy('i', '0')], buckets('i', 0)).summary).toEqual({
      total: 1,
      matched: 1,
      different: 0,
      notComparable: 0,
      empty: false,
    });
  });
  it('does not mix non-volunteer categories into volunteer seconds', () => {
    const rows = buckets();
    rows[1] = { ...rows[1], calculatedSeconds: 500, recognizedSeconds: 500 };
    const row = compareTimeShadow(anchor, [legacy()], rows).items[0];
    expect(row.status).toBe('matched');
    expect(row.recognizedDifferenceSeconds).toBe(0);
    expect(row.reasons).toEqual(['non_volunteer_time_present']);
    expect(row.categories.find((item) => item.categoryCode === 'training')?.recognizedSeconds).toBe(
      500,
    );
  });
  it('keeps unknown calculation null while retaining the independent recognition comparison', () => {
    const rows = buckets();
    rows[0] = { ...rows[0], calculatedSeconds: null, manuallyAdjusted: true };
    expect(compareTimeShadow(anchor, [legacy()], rows).items[0]).toMatchObject({
      status: 'not_comparable',
      calculatedDifferenceSeconds: null,
      recognizedDifferenceSeconds: 0,
      reasons: ['calculation_unknown', 'manual_recognition_present'],
    });
  });
  it('does not explain a numeric difference merely because manual recognition exists', () => {
    const report = compareTimeShadow(
      anchor,
      [{ ...legacy(), manuallyAdjusted: true }],
      buckets('identity', 4000),
    );
    expect(report.items[0].reasons).toEqual(['manual_recognition_present', 'unexplained']);
  });
  it('preserves union denominator and never substitutes missing sides with zero', () => {
    const report = compareTimeShadow(
      anchor,
      [legacy('old-only'), legacy('same')],
      [...buckets('new-only'), ...buckets('same')],
    );
    expect(report.summary).toEqual({
      total: 3,
      matched: 1,
      different: 0,
      notComparable: 2,
      empty: false,
    });
    expect(report.items.map((row) => row.participationIdentityId)).toEqual([
      'new-only',
      'old-only',
      'same',
    ]);
    expect(report.items[0].legacyCalculatedSeconds).toBeNull();
    expect(report.items[1].recognizedDifferenceSeconds).toBeNull();
  });
  it('marks missing categories and legacy-unclassified input non-comparable', () => {
    expect(compareTimeShadow(anchor, [legacy()], buckets().slice(0, 1)).items[0].reasons).toContain(
      'missing_bucket',
    );
    const rows = [
      ...buckets(),
      { ...buckets()[0], id: 'legacy', categoryCode: 'legacy_unclassified' },
    ];
    const row = compareTimeShadow(anchor, [legacy()], rows).items[0];
    expect(row.status).toBe('not_comparable');
    expect(row.reasons).toContain('legacy_unclassified');
  });
  it('distinguishes no evidence from a legitimate zero', () => {
    expect(compareTimeShadow(anchor, [], []).summary).toEqual({
      total: 0,
      matched: 0,
      different: 0,
      notComparable: 0,
      empty: true,
    });
  });
  it('fingerprints complete ordered evidence independent of input order', () => {
    const old = [legacy('z'), legacy('A')],
      rows = [...buckets('z'), ...buckets('A')];
    const first = compareTimeShadow(anchor, old, rows);
    expect(first).toEqual(compareTimeShadow(anchor, [...old].reverse(), [...rows].reverse()));
    expect(first.inputFingerprint).not.toBe(
      compareTimeShadow({ ...anchor, settlementVersionId: 'other' }, old, rows).inputFingerprint,
    );
    expect(first.inputFingerprint).not.toBe(
      compareTimeShadow(anchor, [legacy('z', '2'), legacy('A')], rows).inputFingerprint,
    );
    expect(first.inputFingerprint).not.toBe(
      compareTimeShadow(anchor, old, [...buckets('z', 3599), ...buckets('A')]).inputFingerprint,
    );
  });
  it('fingerprints old manual facts even when the new side already carries a manual marker', () => {
    const rows = buckets().map((row) => ({ ...row, manuallyAdjusted: true }));
    const before = compareTimeShadow(anchor, [legacy()], rows);
    const after = compareTimeShadow(anchor, [{ ...legacy(), manuallyAdjusted: true }], rows);
    expect(after.items).toEqual(before.items);
    expect(after.inputFingerprint).not.toBe(before.inputFingerprint);
  });
  it('rejects ambiguous duplicate results and bucket categories', () => {
    expect(() => compareTimeShadow(anchor, [legacy(), legacy()], buckets())).toThrow(
      TimeSettlementPolicyError,
    );
    expect(() => compareTimeShadow(anchor, [legacy()], [...buckets(), buckets()[0]])).toThrow(
      TimeSettlementPolicyError,
    );
  });
  it.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'does not report invalid source seconds %s as matched',
    (value) => {
      const rows = buckets();
      rows[0] = { ...rows[0], recognizedSeconds: value };
      expect(compareTimeShadow(anchor, [legacy()], rows).items[0].status).toBe('not_comparable');
    },
  );
  it('accepts the full 2000 identity / 8000 bucket bound without truncation and rejects excess', () => {
    const old = Array.from({ length: 2000 }, (_, i) => legacy('identity-' + i));
    const rows = old.flatMap((row) => buckets(row.participationIdentityId));
    expect(compareTimeShadow(anchor, old, rows).summary).toEqual({
      total: 2000,
      matched: 2000,
      different: 0,
      notComparable: 0,
      empty: false,
    });
    expect(() => compareTimeShadow(anchor, [...old, legacy('extra')], rows)).toThrow(
      new TimeSettlementPolicyError('scale_limit'),
    );
    expect(() => compareTimeShadow(anchor, old, [...rows, buckets('extra')[0]])).toThrow(
      new TimeSettlementPolicyError('scale_limit'),
    );
  });
});
