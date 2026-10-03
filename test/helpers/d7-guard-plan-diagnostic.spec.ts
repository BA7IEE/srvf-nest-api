import { parseGuardPlanTrace, sanitizeGuardPlan } from './d7-guard-plan-diagnostic';

describe('D7 bounded internal plan redaction (no database)', () => {
  it('drops raw SQL, IDs, conditions, arbitrary labels and string-shaped metrics', () => {
    expect(
      sanitizeGuardPlan({
        'Node Type': 'secret-token',
        'Actual Rows': 'private',
        'Actual Loops': 10,
        Filter: 'secret-filter',
        'Index Cond': 'private-id',
        Output: ['private'],
        Plans: [{ 'Node Type': 'Function Scan', 'Actual Rows': 10000, 'Function Name': 'private' }],
      }),
    ).toEqual({
      'Node Type': 'Other',
      'Actual Loops': 10,
      Plans: [{ 'Node Type': 'Function Scan', 'Actual Rows': 10000 }],
    });
  });
  it('handles quoted braces and escapes without returning query text', () => {
    const trace =
      'NOTICE: duration: 1.25 ms plan:\n' +
      JSON.stringify({
        'Query Text': 'SELECT "private\\"}value"',
        Plan: { 'Node Type': 'Result', 'Actual Rows': 1 },
      }) +
      '\nCONTEXT: private-context';
    expect(parseGuardPlanTrace(trace)).toEqual({
      plans: [{ elapsedMs: 1.25, plan: { 'Node Type': 'Result', 'Actual Rows': 1 } }],
      malformed: false,
      truncated: false,
    });
    expect(JSON.stringify(parseGuardPlanTrace(trace))).not.toContain('private');
  });
  it('marks incomplete frames rather than claiming a complete plan', () => {
    expect(parseGuardPlanTrace('NOTICE: duration: 2 ms plan:\n{"Plan":')).toEqual({
      plans: [],
      malformed: true,
      truncated: false,
    });
  });
  it('retains at most 24 frames and explicitly reports truncation', () => {
    const trace = Array.from(
      { length: 25 },
      () => 'NOTICE: duration: 1 ms plan:\n{"Plan":{"Node Type":"Result"}}',
    ).join('\n');
    const result = parseGuardPlanTrace(trace);
    expect(result.plans).toHaveLength(24);
    expect(result.truncated).toBe(true);
  });
  it('rejects oversized traces and non-finite or negative metrics', () => {
    expect(parseGuardPlanTrace('x'.repeat(2_000_001)).truncated).toBe(true);
    expect(
      sanitizeGuardPlan({ 'Actual Rows': -1, 'Actual Loops': Infinity, 'Temp Read Blocks': 4 }),
    ).toEqual({ 'Temp Read Blocks': 4 });
  });
});
