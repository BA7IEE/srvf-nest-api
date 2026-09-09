import { fingerprintActivityMetricDefinition } from './activity-metric-definition';
import {
  aggregateMetricCandidateSources,
  evaluateActivityMetricRule,
  fingerprintMetricCandidateSources,
  getActivityMetricRule,
  METRIC_CANDIDATE_LIMITS,
  MetricSourceInterval,
  normalizeMetricCandidateSources,
  resolveActivityMetricRuleBinding,
} from './activity-metric-rule';

function interval(
  sourceRevisionId: string,
  memberId: string,
  start: number,
  end: number,
): MetricSourceInterval {
  return {
    sourceRevisionId,
    memberId,
    identityId: `identity-${sourceRevisionId}`,
    sessionId: `session-${sourceRevisionId}`,
    checkInAt: new Date(start),
    checkOutAt: new Date(end),
    resultCode: 'valid',
  };
}

function fixture(hours = false, scale = 2, minimum: string | number = hours ? '0' : 0) {
  const definition = {
    schemaVersion: 1,
    code: 'actual',
    version: 1,
    name: '实际参与',
    configuration: hours
      ? { kindCode: 'non_negative_decimal', unit: '小时', scale, minimum, maximum: '999999' }
      : { kindCode: 'non_negative_integer', unit: '人', minimum, maximum: 2000 },
  };
  const hash = fingerprintActivityMetricDefinition(definition).definitionHash;
  const code = hours ? 'actual_participation_hours_v1' : 'actual_participant_count_v1';
  return {
    definition,
    hash,
    code,
    evaluate: (rows: MetricSourceInterval[]) =>
      evaluateActivityMetricRule(
        'definition',
        definition,
        hash,
        code,
        1,
        normalizeMetricCandidateSources(rows),
      ),
  };
}

describe('C3-1 retained actual participation rule v1', () => {
  it('counts one person across identities/sessions and unions overlaps and adjacent intervals', () => {
    const rows = [
      interval('a', 'member-a', 0, 3600000),
      interval('b', 'member-a', 1800000, 5400000),
      interval('c', 'member-a', 5400000, 7200000),
      interval('d', 'member-b', 0, 3600000),
    ];
    expect(fixture().evaluate(rows).valueJson).toBe(2);
    expect(fixture(true).evaluate(rows).valueJson).toBe('3');
  });

  it('does not double-count nested intervals but retains separated intervals', () => {
    const rows = [
      interval('a', 'm', 0, 3600000),
      interval('b', 'm', 1, 2),
      interval('c', 'm', 7200000, 10800000),
    ];
    expect(fixture(true).evaluate(rows).valueJson).toBe('2');
  });

  it('counts actual early departure independently of recognized serviceHours', () => {
    const row = interval('a', 'm', 0, 600000);
    row.resultCode = 'early_departure_zero';
    expect(fixture().evaluate([row]).valueJson).toBe(1);
    expect(fixture(true).evaluate([row]).valueJson).toBe('0.17');
  });

  it('uses UTC instants across midnight and offset changes', () => {
    const row = interval(
      'a',
      'm',
      Date.parse('2025-11-02T01:30:00-04:00'),
      Date.parse('2025-11-02T01:30:00-05:00'),
    );
    expect(fixture(true).evaluate([row]).valueJson).toBe('1');
    const acrossMidnight = interval(
      'b',
      'm',
      Date.parse('2025-09-08T23:30:00Z'),
      Date.parse('2025-09-09T01:30:00Z'),
    );
    expect(fixture(true).evaluate([acrossMidnight]).valueJson).toBe('2');
  });

  it.each([
    [17999, '0'],
    [18000, '0.01'],
    [18001, '0.01'],
    [3600000, '1'],
  ])('rounds %i milliseconds once to canonical %s at scale 2', (duration, expected) => {
    expect(fixture(true).evaluate([interval('a', 'm', 0, duration)]).valueJson).toBe(expected);
  });

  it('rounds after summing, not per member or per interval', () => {
    expect(
      fixture(true).evaluate([interval('a', 'm1', 0, 10000), interval('b', 'm2', 0, 10000)])
        .valueJson,
    ).toBe('0.01');
  });

  it('supports scales zero and six without floating-point or noncanonical trailing zeros', () => {
    expect(fixture(true, 0).evaluate([interval('a', 'm', 0, 1800000)]).valueJson).toBe('1');
    expect(fixture(true, 6).evaluate([interval('a', 'm', 0, 2)]).valueJson).toBe('0.000001');
    expect(fixture(true, 6).evaluate([interval('a', 'm', 0, 3600000)]).valueJson).toBe('1');
  });

  it('represents a proven empty input as numeric zero, not a claim of source availability', () => {
    expect(fixture().evaluate([]).valueJson).toBe(0);
    expect(fixture(true).evaluate([]).valueJson).toBe('0');
  });

  it('rejects true zero outside the target definition bounds', () => {
    expect(() => fixture(false, 2, 1).evaluate([])).toThrow(TypeError);
    expect(() => fixture(true, 2, '0.1').evaluate([])).toThrow(TypeError);
  });

  it('rejects definition hash, type, unit and evaluator mismatches', () => {
    const f = fixture();
    expect(() =>
      resolveActivityMetricRuleBinding('d', f.definition, '0'.repeat(64), f.code, 1),
    ).toThrow(TypeError);
    expect(() =>
      resolveActivityMetricRuleBinding(
        'd',
        f.definition,
        f.hash,
        'actual_participation_hours_v1',
        1,
      ),
    ).toThrow(TypeError);
    const wrongUnit = {
      ...f.definition,
      configuration: {
        kindCode: 'non_negative_integer',
        unit: '次',
        minimum: 0,
        maximum: 2000,
      },
    };
    expect(() =>
      resolveActivityMetricRuleBinding(
        'd',
        wrongUnit,
        fingerprintActivityMetricDefinition(wrongUnit).definitionHash,
        f.code,
        1,
      ),
    ).toThrow(TypeError);
    expect(() => getActivityMetricRule(f.code, 2)).toThrow(TypeError);
    expect(() => getActivityMetricRule('uploaded_script', 1)).toThrow(TypeError);
  });

  it('keeps ordering deterministic while detecting changed member partitions', () => {
    const rows = [
      interval('b', 'm1', 0, 3600000),
      interval('a', 'm2', 0, 3600000),
      interval('c', 'm1', 0, 3600000),
    ];
    const first = normalizeMetricCandidateSources(rows);
    expect(normalizeMetricCandidateSources([...rows].reverse())).toEqual(first);
    const digest = fingerprintMetricCandidateSources('activity', first).sourceDigest;
    expect(
      fingerprintMetricCandidateSources(
        'activity',
        normalizeMetricCandidateSources(
          rows.map((row) => ({ ...row, memberId: row.memberId + '-renamed' })),
        ),
      ).sourceDigest,
    ).toBe(digest);
    expect(
      fingerprintMetricCandidateSources(
        'activity',
        normalizeMetricCandidateSources(rows.map((row) => ({ ...row, memberId: 'one-member' }))),
      ).sourceDigest,
    ).not.toBe(digest);
    expect(fingerprintMetricCandidateSources('other-activity', first).sourceDigest).not.toBe(
      digest,
    );
  });

  it('replays retained input fields without current member IDs, original rows or a clock', () => {
    const f = fixture(true);
    const sources = normalizeMetricCandidateSources([interval('a', 'private-member', 0, 5400000)]);
    expect(JSON.stringify(sources)).not.toContain('private-member');
    const before = evaluateActivityMetricRule(
      'definition',
      f.definition,
      f.hash,
      f.code,
      1,
      sources,
    );
    const restored = structuredClone(sources);
    expect(
      evaluateActivityMetricRule('definition', f.definition, f.hash, f.code, 1, restored),
    ).toEqual(before);
    expect(fingerprintMetricCandidateSources('activity', restored)).toEqual(
      fingerprintMetricCandidateSources('activity', sources),
    );
  });

  it.each([0, -1, NaN])('rejects invalid/zero interval endpoint %s', (end) => {
    expect(() => normalizeMetricCandidateSources([interval('a', 'm', 0, end)])).toThrow(TypeError);
  });

  it('rejects duplicate sources and corrupt retained ordering, groups or dates', () => {
    const row = interval('a', 'm', 0, 1);
    expect(() => normalizeMetricCandidateSources([row, row])).toThrow(TypeError);
    const sources = normalizeMetricCandidateSources([row]);
    expect(() => aggregateMetricCandidateSources([{ ...sources[0], ordinal: 1 }])).toThrow(
      TypeError,
    );
    expect(() =>
      aggregateMetricCandidateSources([{ ...sources[0], memberGroupOrdinal: 1 }]),
    ).toThrow(TypeError);
    expect(() =>
      aggregateMetricCandidateSources([{ ...sources[0], checkOutAt: 'invalid' }]),
    ).toThrow(TypeError);
  });

  it.each([30, 500, 2000])('computes the complete %i-member tier', (size) => {
    const rows = Array.from({ length: size }, (_, i) => interval(`s-${i}`, `m-${i}`, 0, 3600000));
    expect(fixture().evaluate(rows).valueJson).toBe(size);
    expect(fixture(true).evaluate(rows).valueJson).toBe(String(size));
  });

  it('rejects member cap+1 and source cap+1 without truncation', () => {
    const rows = Array.from({ length: METRIC_CANDIDATE_LIMITS.members + 1 }, (_, i) =>
      interval(`s-${i}`, `m-${i}`, 0, 1),
    );
    expect(() => normalizeMetricCandidateSources(rows)).toThrow(RangeError);
    const sameMember = Array.from({ length: METRIC_CANDIDATE_LIMITS.segments }, (_, i) =>
      interval(`s-${i}`, 'm', i, i + 1),
    );
    expect(normalizeMetricCandidateSources(sameMember)).toHaveLength(10000);
    expect(() =>
      normalizeMetricCandidateSources([...sameMember, interval('extra', 'm', 0, 1)]),
    ).toThrow(RangeError);
  });
});
