import {
  evaluateSettlementReviewSeparation,
  type SettlementReviewSeparationFacts,
} from './settlement-review-separation';

// 三方分离(合同 §3.19)的**纯判定**单测。
//
// 🔴 全文件最重要的一段是「三条互不重叠」:每条判据各配一组事实,
//    **只有它自己那一条会命中**。这是 goal DoD 3「红集互不重叠」的结构前提 ——
//    卸掉实现里的第 i 条,只有第 i 组用例会红。
//
// 事务内锁后复判这件事本身(即"事实必须是锁后重读的")不在这里,它是 e2e 的事
// (见 `activity-settlement-review-concurrency.e2e-spec.ts` 的「入口通过、锁后才不合法」)。

const SUBMITTER = 'user-submitter';
const FIRST_REVIEWER = 'user-first-reviewer';
const OUTSIDER = 'user-outsider';

const facts = (
  overrides: Partial<SettlementReviewSeparationFacts> = {},
): SettlementReviewSeparationFacts => ({
  submittedByUserId: SUBMITTER,
  firstReviewerUserId: null,
  ...overrides,
});

describe('evaluateSettlementReviewSeparation —— 提交人/一审人/终审人三方分离', () => {
  describe('① 提交人 ≠ 一审人', () => {
    it('提交人自己来一审 ⇒ self_first_review', () => {
      expect(evaluateSettlementReviewSeparation('first', facts(), SUBMITTER)).toBe(
        'self_first_review',
      );
    });

    it('第三方来一审 ⇒ 放行', () => {
      expect(evaluateSettlementReviewSeparation('first', facts(), OUTSIDER)).toBeNull();
    });
  });

  describe('② 提交人 ≠ 终审人', () => {
    it('提交人自己来终审 ⇒ self_final_review', () => {
      expect(
        evaluateSettlementReviewSeparation(
          'final',
          facts({ firstReviewerUserId: FIRST_REVIEWER }),
          SUBMITTER,
        ),
      ).toBe('self_final_review');
    });
  });

  describe('③ 一审人 ≠ 终审人', () => {
    it('一审人再来终审 ⇒ same_reviewer', () => {
      expect(
        evaluateSettlementReviewSeparation(
          'final',
          facts({ firstReviewerUserId: FIRST_REVIEWER }),
          FIRST_REVIEWER,
        ),
      ).toBe('same_reviewer');
    });

    it('三个人各不相同 ⇒ 放行', () => {
      expect(
        evaluateSettlementReviewSeparation(
          'final',
          facts({ firstReviewerUserId: FIRST_REVIEWER }),
          OUTSIDER,
        ),
      ).toBeNull();
    });
  });

  // ⭐ goal DoD 3:三条判据必须**互不重叠**。
  //
  // 这一段不是"再测一遍"——它测的是**每组事实只命中一条**:
  // 卸掉实现里的任意一条,只有对应那一行会红,红集不会串。
  describe('⭐ 三条互不重叠(卸一条只红一条的结构前提)', () => {
    const cases: Array<{
      rule: string;
      stage: 'first' | 'final';
      actor: string;
      given: SettlementReviewSeparationFacts;
      expected: string;
    }> = [
      {
        rule: '①',
        stage: 'first',
        actor: SUBMITTER,
        // 一审阶段:②③ 都只在 final 触发 ⇒ 结构上够不到。
        given: facts({ firstReviewerUserId: null }),
        expected: 'self_first_review',
      },
      {
        rule: '②',
        stage: 'final',
        actor: SUBMITTER,
        // 一审人是**别人** ⇒ ③ 不可能命中;① 只在 first 触发。
        given: facts({ firstReviewerUserId: FIRST_REVIEWER }),
        expected: 'self_final_review',
      },
      {
        rule: '③',
        stage: 'final',
        actor: FIRST_REVIEWER,
        // 操作人**不是**提交人 ⇒ ② 不可能命中;① 只在 first 触发。
        given: facts({ firstReviewerUserId: FIRST_REVIEWER }),
        expected: 'same_reviewer',
      },
    ];

    it.each(cases)('$rule 的事实只命中 $expected', ({ stage, actor, given, expected }) => {
      expect(evaluateSettlementReviewSeparation(stage, given, actor)).toBe(expected);
    });
  });

  // 类型上可空、结构上不可达(`createdByUserId` 的 FK 是 onDelete: Restrict,
  // 写入方恒传 currentUser.id)。留分支只是类型诚实 —— 但仍要钉住它**不会**
  // 因为 null == null 之类的写法退化成"谁都不能审"或"谁都能审"。
  describe('可空侧的行为(与考勤既有范式同口径:null 不等于任何 actor)', () => {
    it('提交人为 null ⇒ 一审不因分离被拒', () => {
      expect(
        evaluateSettlementReviewSeparation('first', facts({ submittedByUserId: null }), OUTSIDER),
      ).toBeNull();
    });

    it('尚无一审人时,终审不因 ③ 被拒', () => {
      expect(
        evaluateSettlementReviewSeparation('final', facts({ firstReviewerUserId: null }), OUTSIDER),
      ).toBeNull();
    });
  });
});
