const FORMAL_MEMBER_GRADE_CODES: ReadonlySet<string> = new Set([
  'level-1',
  'level-2',
  'level-3',
  'level-4',
  'level-5',
  'level-6',
  'level-7',
]);

export function isFormalMemberGradeCode(gradeCode: string | null | undefined): boolean {
  return gradeCode !== null && gradeCode !== undefined && FORMAL_MEMBER_GRADE_CODES.has(gradeCode);
}
