import { coldLintSelfChecks } from '../scripts/check-cold-lint';

// The protected check-* script owns all predicates and positive/negative
// controls. This file only gives each independent control a real test slot.
describe('complete cold-lint entry', () => {
  test.each(coldLintSelfChecks())('$name', ({ passed }) => {
    expect(passed).toBe(true);
  });
});
