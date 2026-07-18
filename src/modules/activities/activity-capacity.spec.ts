import {
  deriveEffectiveActivityCapacity,
  getActivityCapacityHeadroom,
  hasActivityCapacity,
} from './activity-capacity';

describe('deriveEffectiveActivityCapacity', () => {
  it('无岗位沿 Activity.capacity；岗位只能收紧父上限，不能架空父上限', () => {
    expect(deriveEffectiveActivityCapacity(20, [])).toBe(20);
    expect(
      deriveEffectiveActivityCapacity(20, [{ capacity: 3 }, { capacity: 5 }, { capacity: 2 }]),
    ).toBe(10);
    expect(deriveEffectiveActivityCapacity(20, [{ capacity: 3 }, { capacity: null }])).toBe(20);
    expect(deriveEffectiveActivityCapacity(5, [{ capacity: 3 }, { capacity: 5 }])).toBe(5);
    expect(deriveEffectiveActivityCapacity(null, [{ capacity: 3 }, { capacity: null }])).toBeNull();
  });

  it('总容量与岗位容量同时裁决 admission', () => {
    expect(
      hasActivityCapacity({
        activityCapacity: 2,
        activityPassCount: 2,
        activityPositionCapacity: 10,
        activityPositionPassCount: 1,
      }),
    ).toBe(false);
    expect(
      hasActivityCapacity({
        activityCapacity: 10,
        activityPassCount: 2,
        activityPositionCapacity: 2,
        activityPositionPassCount: 2,
      }),
    ).toBe(false);
  });

  it('全局剩余量对不限与已满 fail-closed', () => {
    expect(getActivityCapacityHeadroom(null, 99)).toBeNull();
    expect(getActivityCapacityHeadroom(3, 2)).toBe(1);
    expect(getActivityCapacityHeadroom(3, 4)).toBe(0);
  });
});
