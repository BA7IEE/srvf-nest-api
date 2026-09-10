import { canTransitionTimePolicyVersion } from './activity-time-policy-state-machine';

describe('time policy lifecycle', () => {
  it.each([
    ['draft', 'active', true],
    ['active', 'retired', true],
    ['draft', 'retired', false],
    ['retired', 'active', false],
    ['active', 'draft', false],
    ['retired', 'draft', false],
    ['draft', 'draft', false],
    ['active', 'active', false],
    ['retired', 'retired', false],
    [null, 'draft', false],
    ['unknown', 'active', false],
  ])('%s -> %s is %s', (from, to, expected) => {
    expect(canTransitionTimePolicyVersion(from, to)).toBe(expected);
  });
});
