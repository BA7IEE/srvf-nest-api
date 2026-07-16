import { deriveEffectiveActivityCapacity } from './activity-capacity';

describe('deriveEffectiveActivityCapacity', () => {
  it('无岗位沿 Activity.capacity；全有限岗位求和；任一不限则整体不限', () => {
    expect(deriveEffectiveActivityCapacity(20, [])).toBe(20);
    expect(
      deriveEffectiveActivityCapacity(20, [{ capacity: 3 }, { capacity: 5 }, { capacity: 2 }]),
    ).toBe(10);
    expect(deriveEffectiveActivityCapacity(20, [{ capacity: 3 }, { capacity: null }])).toBeNull();
  });
});
