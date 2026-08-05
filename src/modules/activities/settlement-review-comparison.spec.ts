import {
  compareSettlementReviewSnapshot,
  type SettlementReviewExpectation,
  type SettlementReviewLiveFacts,
  type SettlementReviewVersionSnapshot,
} from './settlement-review-comparison';

// §5.11「比较 seal / revisions / workflow / contentHash」的**纯判定**单测。
//
// 每一项都测**两侧**:审核人看的那一版(expected)漂了,以及现场事实(live)漂了。
// 只测一侧会漏掉另一半 —— 而这两半防的是完全不同的两件事(见实现文件头)。

const SEAL = 'seal-1';

const version: SettlementReviewVersionSnapshot = {
  evidenceSealId: SEAL,
  evidenceRevision: 3,
  populationRevision: 5,
  workflowRevision: 7,
  contentHash: 'hash-abc',
};

const expected = (
  overrides: Partial<SettlementReviewExpectation> = {},
): SettlementReviewExpectation => ({ ...version, ...overrides });

const live = (overrides: Partial<SettlementReviewLiveFacts> = {}): SettlementReviewLiveFacts => ({
  activeEvidenceSealId: SEAL,
  evidenceRevision: version.evidenceRevision,
  populationRevision: version.populationRevision,
  workflowRevision: version.workflowRevision,
  ...overrides,
});

describe('compareSettlementReviewSnapshot —— 审核前四项比对', () => {
  it('三侧完全一致 ⇒ 放行', () => {
    expect(
      compareSettlementReviewSnapshot({ expected: expected(), version, live: live() }),
    ).toBeNull();
  });

  describe('① evidence_seal', () => {
    it('已无 active seal', () => {
      expect(
        compareSettlementReviewSnapshot({
          expected: expected(),
          version,
          live: live({ activeEvidenceSealId: null }),
        }),
      ).toBe('evidence_seal');
    });

    it('当前 active seal 换了一张', () => {
      expect(
        compareSettlementReviewSnapshot({
          expected: expected(),
          version,
          live: live({ activeEvidenceSealId: 'seal-2' }),
        }),
      ).toBe('evidence_seal');
    });

    it('审核人看的是另一张 seal', () => {
      expect(
        compareSettlementReviewSnapshot({
          expected: expected({ evidenceSealId: 'seal-2' }),
          version,
          live: live(),
        }),
      ).toBe('evidence_seal');
    });
  });

  describe('② evidence_population_revision', () => {
    it.each([
      ['现场 evidenceRevision 前进', live({ evidenceRevision: 4 }), expected()],
      ['现场 populationRevision 前进', live({ populationRevision: 6 }), expected()],
      ['审核人看的 evidenceRevision 不同', live(), expected({ evidenceRevision: 2 })],
      ['审核人看的 populationRevision 不同', live(), expected({ populationRevision: 4 })],
    ])('%s', (_label, liveFacts, expectation) => {
      expect(
        compareSettlementReviewSnapshot({ expected: expectation, version, live: liveFacts }),
      ).toBe('evidence_population_revision');
    });
  });

  describe('③ workflow_revision', () => {
    it.each([
      ['现场 workflowRevision 前进', live({ workflowRevision: 8 }), expected()],
      ['审核人看的 workflowRevision 不同', live(), expected({ workflowRevision: 6 })],
    ])('%s', (_label, liveFacts, expectation) => {
      expect(
        compareSettlementReviewSnapshot({ expected: expectation, version, live: liveFacts }),
      ).toBe('workflow_revision');
    });
  });

  describe('④ content_hash(🔴 只比对不重算)', () => {
    it('审核人看到的摘要与版本行不一致', () => {
      expect(
        compareSettlementReviewSnapshot({
          expected: expected({ contentHash: 'hash-xyz' }),
          version,
          live: live(),
        }),
      ).toBe('content_hash');
    });

    // 反向钉子:本项**没有 live 侧**。若哪天有人给它加了"重算后的 hash"当第三个输入,
    // 这条断言的形状(live 完全不含 contentHash 字段)会先在类型上挡住。
    it('live 侧不参与 hash 判定 —— 现场事实全对时,hash 一致即放行', () => {
      expect(
        compareSettlementReviewSnapshot({ expected: expected(), version, live: live() }),
      ).toBeNull();
    });
  });

  // ⭐ 四项互不重叠:每组输入只动一项,命中的就只有那一项。
  describe('⭐ 四项互不重叠(卸一项只红一条的结构前提)', () => {
    it.each([
      ['①', expected(), live({ activeEvidenceSealId: 'seal-2' }), 'evidence_seal'],
      ['②', expected(), live({ evidenceRevision: 4 }), 'evidence_population_revision'],
      ['③', expected(), live({ workflowRevision: 8 }), 'workflow_revision'],
      ['④', expected({ contentHash: 'hash-xyz' }), live(), 'content_hash'],
    ])('%s 的输入只命中 %s', (_label, expectation, liveFacts, mismatch) => {
      expect(
        compareSettlementReviewSnapshot({ expected: expectation, version, live: liveFacts }),
      ).toBe(mismatch);
    });
  });
});
