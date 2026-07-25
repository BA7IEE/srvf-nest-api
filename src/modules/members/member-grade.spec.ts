import { isFormalMemberGradeCode } from './member-grade';

describe('isFormalMemberGradeCode', () => {
  it.each(['level-1', 'level-2', 'level-3', 'level-4', 'level-5', 'level-6', 'level-7'] as const)(
    '仅正式等级闭集中的 %s 返回 true',
    (gradeCode) => {
      expect(isFormalMemberGradeCode(gradeCode)).toBe(true);
    },
  );

  it.each([
    'volunteer',
    'reserve',
    null,
    undefined,
    'level-0',
    'level-8',
    'level-01',
    'LEVEL-1',
    'Level-1',
    'level-1-extra',
  ] as const)('闭集外等级 %s 返回 false', (gradeCode) => {
    expect(isFormalMemberGradeCode(gradeCode)).toBe(false);
  });
});
