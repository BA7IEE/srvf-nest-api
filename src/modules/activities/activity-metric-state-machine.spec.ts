import { assertMetricTransition, metricStatus } from './activity-metric-state-machine';
describe('metric lifecycle', () => {
  it.each([
    ['draft', 'update', 'draft'],
    ['draft', 'activate', 'active'],
    ['active', 'retire', 'retired'],
  ] as const)('%s → %s', (state, action, target) => {
    expect(assertMetricTransition(state, action, 'a', 'a')).toBe(target);
  });
  it.each([
    ['draft', 'retire'],
    ['active', 'update'],
    ['active', 'activate'],
    ['retired', 'update'],
    ['retired', 'activate'],
    ['retired', 'retire'],
  ] as const)('rejects %s / %s', (state, action) => {
    expect(() => assertMetricTransition(state, action, 'a', 'a')).toThrow(
      '当前指标状态不允许此操作',
    );
  });
  it('rejects stale hash and unknown status', () => {
    expect(() => assertMetricTransition('draft', 'update', 'b', 'a')).toThrow('指标版本已变化');
    expect(() => metricStatus(null)).toThrow('当前指标状态');
  });
});
