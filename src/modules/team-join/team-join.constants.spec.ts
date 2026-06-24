import { VOL_ORG_CODE, VOLUNTEER_GRADE_CODE, isUnenrolledVolunteer } from './team-join.constants';

// 招新闭环优化 S5(评审稿 §5.2b):两处入队门禁共享的「未入队志愿者」双口径纯函数。
// 锁定:新口径(volunteer + 仅一条 VOL active 部门)/ legacy 口径(null + 零部门)双兼容,
// 其余身份(已入队级别 / 非 VOL 部门 / 不一致态)一律拦截。VOL 字面镜像 seed Organization.code 契约。

describe('isUnenrolledVolunteer · 双口径(S5)', () => {
  const vol = (code = VOL_ORG_CODE) => ({ organization: { code } });

  it('新口径:gradeCode=volunteer + 仅一条 VOL active 部门 → true', () => {
    expect(isUnenrolledVolunteer({ gradeCode: VOLUNTEER_GRADE_CODE }, [vol()])).toBe(true);
  });

  it('legacy 口径:gradeCode=null + 零 active 部门 → true', () => {
    expect(isUnenrolledVolunteer({ gradeCode: null }, [])).toBe(true);
  });

  it('volunteer 但零部门(半态)→ false', () => {
    expect(isUnenrolledVolunteer({ gradeCode: VOLUNTEER_GRADE_CODE }, [])).toBe(false);
  });

  it('volunteer 但部门非 VOL → false', () => {
    expect(isUnenrolledVolunteer({ gradeCode: VOLUNTEER_GRADE_CODE }, [vol('SMRT')])).toBe(false);
  });

  it('volunteer + 多于一条 active 部门(VOL + 其它)→ false', () => {
    expect(isUnenrolledVolunteer({ gradeCode: VOLUNTEER_GRADE_CODE }, [vol(), vol('SMRT')])).toBe(
      false,
    );
  });

  it('legacy null 但已有部门 → false(不再是零部门)', () => {
    expect(isUnenrolledVolunteer({ gradeCode: null }, [vol()])).toBe(false);
  });

  it('已入队队员(level-1 + 目标部门)→ false', () => {
    expect(isUnenrolledVolunteer({ gradeCode: 'level-1' }, [vol('SMRT')])).toBe(false);
  });

  it('已设级别但零部门(不一致态)→ false', () => {
    expect(isUnenrolledVolunteer({ gradeCode: 'level-1' }, [])).toBe(false);
  });
});
