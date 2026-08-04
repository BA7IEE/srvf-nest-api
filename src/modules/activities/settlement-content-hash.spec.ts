import {
  buildSettlementContentCanonicalText,
  canonicalize,
  computeSettlementContentHash,
  decimalToCanonicalString,
  SETTLEMENT_CONTENT_SCHEMA_VERSION,
  type SettlementContentItem,
  type SettlementContentPayload,
} from './settlement-content-hash';

// ===== 第 2 批第三刀 DoD 4:canonical contentHash 的三条判据 =====
//
// hash 是 §5.11 一审/终审比对的唯一依据 —— 不稳定就等于没有比对。
// 三条各自独立:可复现 / **key 序无关** / 内容敏感。中间那条是"canonical 而不是
// `JSON.stringify` 直出"的**唯一可观测差别**:把 canonicalize 换成 stringify,
// 只有它会红。

function item(overrides: Partial<SettlementContentItem> = {}): SettlementContentItem {
  return {
    participationIdentityId: 'identity-1',
    resultCode: 'present',
    lateFlag: false,
    earlyLeaveFlag: false,
    exceptionFlags: null,
    recognizedServiceHours: '4.00',
    recognizedContributionPoints: '1.50',
    calculatedServiceHours: '4.00',
    calculatedContributionPoints: '1.50',
    adjustmentReason: null,
    ...overrides,
  };
}

function payload(overrides: Partial<SettlementContentPayload> = {}): SettlementContentPayload {
  return {
    schemaVersion: SETTLEMENT_CONTENT_SCHEMA_VERSION,
    activityId: 'activity-1',
    settlementRunId: 'run-1',
    evidenceSealId: 'seal-1',
    sealRevision: 1,
    evidenceRevision: 0,
    populationRevision: 0,
    workflowRevision: 0,
    personCount: 2,
    sessionParticipationCount: 2,
    serviceSegmentCount: 2,
    items: [item(), item({ participationIdentityId: 'identity-2' })],
    ...overrides,
  };
}

describe('settlement contentHash (合同 §5.10 ⑤)', () => {
  describe('判据 1 —— 同样输入两次 ⇒ 同一个 hash', () => {
    it('两次独立构造的等价载荷得到同一个 hash', () => {
      expect(computeSettlementContentHash(payload())).toBe(computeSettlementContentHash(payload()));
    });

    it('hash 是 64 位十六进制(sha256)', () => {
      expect(computeSettlementContentHash(payload())).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('判据 2 —— 字段书写顺序 / 对象 key 顺序变化 ⇒ hash 不变', () => {
    // 🔴 这一条是"canonical 而不是 stringify 直出"的执行位。
    //    把 canonicalize 里的 `Object.keys(record).sort()` 去掉 `.sort()`,只有本组会红。
    it('顶层字段倒着写,hash 不变', () => {
      const forward = payload();
      // 逐字重建一个 key 插入顺序完全相反的等价对象。
      const reversed = Object.fromEntries(
        Object.entries(forward).reverse(),
      ) as unknown as SettlementContentPayload;

      // 先证明"插入顺序确实不同"—— 否则本用例是空绿。
      expect(Object.keys(reversed)).not.toEqual(Object.keys(forward));
      expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(forward));

      expect(computeSettlementContentHash(reversed)).toBe(computeSettlementContentHash(forward));
    });

    it('item 内部字段倒着写,hash 不变', () => {
      const forward = payload({ items: [item()] });
      const reversedItem = Object.fromEntries(
        Object.entries(item()).reverse(),
      ) as unknown as SettlementContentItem;
      const reversed = payload({ items: [reversedItem] });

      expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(forward));
      expect(computeSettlementContentHash(reversed)).toBe(computeSettlementContentHash(forward));
    });

    it('嵌套 exceptionFlags 的 key 顺序变化,hash 不变', () => {
      const a = payload({
        items: [item({ exceptionFlags: { blockers: ['x'], note: { b: 1, a: 2 } } })],
      });
      const b = payload({
        items: [item({ exceptionFlags: { note: { a: 2, b: 1 }, blockers: ['x'] } })],
      });

      expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
      expect(computeSettlementContentHash(a)).toBe(computeSettlementContentHash(b));
    });

    it('数组顺序**仍然**影响 hash —— 排序只作用于对象 key,不作用于数组', () => {
      // 反向断言:若把数组也排序,这条会红。items 的顺序由调用方按 identityId 固定,
      // 而 exceptionFlags 里的数组顺序是内容的一部分,不该被悄悄归一。
      const a = payload({ items: [item({ exceptionFlags: { blockers: ['a', 'b'] } })] });
      const b = payload({ items: [item({ exceptionFlags: { blockers: ['b', 'a'] } })] });
      expect(computeSettlementContentHash(a)).not.toBe(computeSettlementContentHash(b));
    });
  });

  describe('判据 3 —— 任一实质内容变化 ⇒ hash 变', () => {
    const baseline = computeSettlementContentHash(payload());

    it.each([
      ['resultCode', payload({ items: [item({ resultCode: 'absent' }), item()] })],
      ['认定时长', payload({ items: [item({ recognizedServiceHours: '3.00' }), item()] })],
      ['认定贡献值', payload({ items: [item({ recognizedContributionPoints: '9.00' }), item()] })],
      ['计算时长', payload({ items: [item({ calculatedServiceHours: '3.00' }), item()] })],
      ['lateFlag', payload({ items: [item({ lateFlag: true }), item()] })],
      ['earlyLeaveFlag', payload({ items: [item({ earlyLeaveFlag: true }), item()] })],
      ['adjustmentReason', payload({ items: [item({ adjustmentReason: '负责人调整' }), item()] })],
      [
        'exceptionFlags',
        payload({ items: [item({ exceptionFlags: { blockers: ['x'] } }), item()] }),
      ],
      ['identity 变了', payload({ items: [item({ participationIdentityId: 'identity-9' })] })],
      ['少了一个人', payload({ items: [item()] })],
      ['personCount', payload({ personCount: 3 })],
      ['sessionParticipationCount', payload({ sessionParticipationCount: 3 })],
      ['serviceSegmentCount', payload({ serviceSegmentCount: 3 })],
      ['evidenceSealId', payload({ evidenceSealId: 'seal-2' })],
      ['sealRevision', payload({ sealRevision: 2 })],
      ['evidenceRevision', payload({ evidenceRevision: 1 })],
      ['populationRevision', payload({ populationRevision: 1 })],
      ['workflowRevision', payload({ workflowRevision: 1 })],
      ['activityId', payload({ activityId: 'activity-2' })],
      ['settlementRunId', payload({ settlementRunId: 'run-2' })],
      ['schemaVersion', payload({ schemaVersion: 2 })],
    ])('%s 变化 ⇒ hash 变', (_label, mutated) => {
      expect(computeSettlementContentHash(mutated)).not.toBe(baseline);
    });
  });

  describe('小数与时间的序列化口径', () => {
    it('"1.5" / 1.5 / "1.50" 归一到同一个定标度文本', () => {
      expect(decimalToCanonicalString('1.5')).toBe('1.50');
      expect(decimalToCanonicalString(1.5)).toBe('1.50');
      expect(decimalToCanonicalString('1.50')).toBe('1.50');
    });

    it('非有限小数抛错,不产出一个会漂的 hash', () => {
      expect(() => decimalToCanonicalString(Number.NaN)).toThrow(TypeError);
      expect(() => decimalToCanonicalString(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    });

    it('canonicalize 拒绝非整数 number —— 小数必须先转文本', () => {
      expect(() => canonicalize({ hours: 1.5 })).toThrow(TypeError);
      expect(() => canonicalize({ count: 3 })).not.toThrow();
      expect(() => canonicalize({ count: Number.NaN })).toThrow(TypeError);
    });

    it('canonical 文本里一个时间字段都没有 —— 提交时刻不进 hash', () => {
      const text = buildSettlementContentCanonicalText(payload());
      expect(text).not.toMatch(/submittedAt|createdAt|updatedAt/);
      // 也不该出现任何 ISO-8601 形状的串。
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('canonicalize 的基本形状', () => {
    it('对象 key 排序、数组保序、字符串走 JSON 转义', () => {
      expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
      expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
      expect(canonicalize({ s: 'a"b' })).toBe('{"s":"a\\"b"}');
      expect(canonicalize(null)).toBe('null');
      expect(canonicalize(true)).toBe('true');
    });
  });
});
