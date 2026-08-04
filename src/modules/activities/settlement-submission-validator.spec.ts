import {
  validateSettlementSubmission,
  type SettlementSubmissionFacts,
} from './settlement-submission-validator';

// ===== 第 2 批第三刀 DoD 3:§5.10 ④ 五条校验的单测层判据 =====
//
// 这里喂的是**计数**,所以能造出 DB 层不可达的形态(尤其 `duplicate_identity` ——
// 它在应用路径上被两条 unique 挡死,e2e 造不出红,red-first 证据只能在这一层)。
//
// 每组用例只动**一个**字段,并显式断言"其余四条此刻都是绿的"—— 这是"逐条卸掉后
// 红集互不重叠"在单测层的直接证明:卸掉判据 X,只有 X 那组会红。

/** 全绿基线:五条判据全部满足。 */
function facts(overrides: Partial<SettlementSubmissionFacts> = {}): SettlementSubmissionFacts {
  return {
    populationCount: 3,
    resultRowCount: 3,
    distinctResultIdentityCount: 3,
    populationWithoutResultCount: 0,
    openSegmentCount: 0,
    blockedResultCount: 0,
    ...overrides,
  };
}

describe('validateSettlementSubmission (合同 §5.10 ④)', () => {
  it('五条全满足 ⇒ 放行', () => {
    expect(validateSettlementSubmission(facts())).toBeNull();
  });

  // ⭐ 最关键的一条:第二刀「不写结果行表达未决」的唯一执行位。
  describe('① pending_result —— 人口里有他、结果表里没有他', () => {
    it('有一个未决项 ⇒ pending_result', () => {
      // 自然形态:人口 3 人,只写了 2 条结果行。
      expect(
        validateSettlementSubmission(
          facts({
            resultRowCount: 2,
            distinctResultIdentityCount: 2,
            populationWithoutResultCount: 1,
          }),
        ),
      ).toBe('pending_result');
    });

    it('**基数相等但仍有人缺席** ⇒ 仍然 pending_result(基数式抓不到的那一侧)', () => {
      // 人口 {A,B,C}、结果 {A,B,X}(X 不在人口里):行数 3 = 人口 3,基数式放行,
      // 只有包含式能抓住 C 缺席。⇒ 这条**只由 pending_result 触发**。
      expect(validateSettlementSubmission(facts({ populationWithoutResultCount: 1 }))).toBe(
        'pending_result',
      );
    });
  });

  describe('② item_count_mismatch —— 项数 ≠ population', () => {
    it('**没有人缺席但多出一行** ⇒ item_count_mismatch(包含式抓不到的那一侧)', () => {
      // 人口 {A}、结果 {A,X}:每个人口身份都有行(包含式放行),但多出 X。
      expect(
        validateSettlementSubmission(
          facts({ populationCount: 1, resultRowCount: 2, distinctResultIdentityCount: 2 }),
        ),
      ).toBe('item_count_mismatch');
    });

    it('人口为空但有结果行 ⇒ item_count_mismatch', () => {
      expect(
        validateSettlementSubmission(
          facts({ populationCount: 0, resultRowCount: 1, distinctResultIdentityCount: 1 }),
        ),
      ).toBe('item_count_mismatch');
    });
  });

  describe('③ duplicate_identity —— 同一 identity 两条结果行', () => {
    it('行数 > 不同 identity 数 ⇒ duplicate_identity', () => {
      // 人口 3、结果 3 行但只有 2 个不同 identity(其中一个重复)。
      // ⚠️ DB 上 unique (settlementVersionId, participationIdentityId) 让这形态在
      //    应用路径不可达 —— 本条是本判据的**唯一** red-first 证据(防御位)。
      expect(validateSettlementSubmission(facts({ distinctResultIdentityCount: 2 }))).toBe(
        'duplicate_identity',
      );
    });
  });

  describe('④ open_segment —— 还有人没签退', () => {
    it('存在开放服务段 ⇒ open_segment', () => {
      expect(validateSettlementSubmission(facts({ openSegmentCount: 1 }))).toBe('open_segment');
    });
  });

  describe('⑤ missing_rule —— 第二刀标的 blocker 必须真正挡住提交', () => {
    it('存在带 blocker 的结果行 ⇒ missing_rule', () => {
      expect(validateSettlementSubmission(facts({ blockedResultCount: 1 }))).toBe('missing_rule');
    });
  });

  // 判据绑定矩阵的单测层证据:每条判据的触发形态**只动它自己那个计数**,
  // 且此时另外四个计数都停在全绿基线上 —— 所以不存在"一个形态同时踩两条"。
  describe('判据绑定 —— 每条只由自己那一个事实触发', () => {
    it.each([
      ['pending_result', { populationWithoutResultCount: 1 }],
      [
        'item_count_mismatch',
        { populationCount: 1, resultRowCount: 2, distinctResultIdentityCount: 2 },
      ],
      ['duplicate_identity', { distinctResultIdentityCount: 2 }],
      ['open_segment', { openSegmentCount: 1 }],
      ['missing_rule', { blockedResultCount: 1 }],
    ] as const)('%s 的触发形态不会误报成别的种类', (expected, overrides) => {
      expect(validateSettlementSubmission(facts(overrides))).toBe(expected);
    });
  });
});
