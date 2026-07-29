import { addMonthsClamped, beijingDateOnly, normalizeDateOnly } from './date-only.util';

// 纯日期归一 util 单元测试(2026-06-12 把关 P2 收口)。
// 核心证据 = 用例 ③:带偏移北京午夜,旧实现(按 UTC 日历日)误归一为前一天 05-14,
// 新实现(按 UTC+8 日历日)归一为 05-15;用例 ②⑤ 锁定既有 spec/e2e 喂入口径行为不变,
// 用例 ④ 锁定 UTC 深夜(北京已次日)的分叉方向。

describe('date-only.util', () => {
  describe('normalizeDateOnly', () => {
    it('① 纯日期 "1990-05-15" → 1990-05-15T00:00:00.000Z', () => {
      expect(normalizeDateOnly('1990-05-15').toISOString()).toBe('1990-05-15T00:00:00.000Z');
    });

    it('② UTC 白天 datetime "2026-03-15T10:30:00.000Z"(cert spec 现状口径)→ 2026-03-15(行为不变)', () => {
      expect(normalizeDateOnly('2026-03-15T10:30:00.000Z').toISOString()).toBe(
        '2026-03-15T00:00:00.000Z',
      );
    });

    it('③ 带偏移北京午夜 "1990-05-15T00:00:00+08:00" → 1990-05-15(旧实现误为 05-14,修复证据)', () => {
      expect(normalizeDateOnly('1990-05-15T00:00:00+08:00').toISOString()).toBe(
        '1990-05-15T00:00:00.000Z',
      );
    });

    it('④ UTC 深夜 "2026-03-15T20:00:00.000Z"(= 北京 03-16 04:00)→ 2026-03-16(锁定分叉方向)', () => {
      expect(normalizeDateOnly('2026-03-15T20:00:00.000Z').toISOString()).toBe(
        '2026-03-16T00:00:00.000Z',
      );
    });

    it('⑤ UTC 午夜 "1990-01-15T00:00:00.000Z"(member e2e 现状口径)→ 1990-01-15(行为不变)', () => {
      expect(normalizeDateOnly('1990-01-15T00:00:00.000Z').toISOString()).toBe(
        '1990-01-15T00:00:00.000Z',
      );
    });
  });

  // 证书标准库 PR-1(冻结稿 certificate-standard-library-t0-review.md §10):
  // `beijingDateOnly` 是 `normalizeDateOnly` 的 Date 入口版本,给「今天」这类
  // 已经是 Date 的瞬间用;两者共用同一 UTC+8 日界,不是第二套日期算法(§19)。
  describe('beijingDateOnly', () => {
    it('UTC 15:59:59.999 仍是同一北京日(日界前一刻)', () => {
      expect(beijingDateOnly(new Date('2026-07-14T15:59:59.999Z')).toISOString()).toBe(
        '2026-07-14T00:00:00.000Z',
      );
    });

    it('UTC 16:00:00.000 翻到次日北京日(日界)', () => {
      expect(beijingDateOnly(new Date('2026-07-14T16:00:00.000Z')).toISOString()).toBe(
        '2026-07-15T00:00:00.000Z',
      );
    });

    it('与 normalizeDateOnly 对同一瞬间同解(单一日界口径)', () => {
      const instant = '2026-03-15T20:00:00.000Z';
      expect(beijingDateOnly(new Date(instant)).toISOString()).toBe(
        normalizeDateOnly(instant).toISOString(),
      );
    });
  });

  // 冻结稿 §10.4 FIXED_MONTHS:自然月 + 月底夹取,结果即「最后有效日」;
  // 明令禁止 `30 天 × 月数`。两条示例逐字取自冻结稿。
  describe('addMonthsClamped', () => {
    it('§10.4 示例一:2024-02-29 + 12 月 = 2025-02-28(闰日夹取)', () => {
      expect(addMonthsClamped(new Date('2024-02-29T00:00:00.000Z'), 12).toISOString()).toBe(
        '2025-02-28T00:00:00.000Z',
      );
    });

    it('§10.4 示例二:2026-01-31 + 1 月 = 2026-02-28(月底夹取)', () => {
      expect(addMonthsClamped(new Date('2026-01-31T00:00:00.000Z'), 1).toISOString()).toBe(
        '2026-02-28T00:00:00.000Z',
      );
    });

    it('日期存在于目标月时不夹取:2026-03-15 + 24 月 = 2028-03-15', () => {
      expect(addMonthsClamped(new Date('2026-03-15T00:00:00.000Z'), 24).toISOString()).toBe(
        '2028-03-15T00:00:00.000Z',
      );
    });

    it('跨年:2026-12-31 + 1 月 = 2027-01-31', () => {
      expect(addMonthsClamped(new Date('2026-12-31T00:00:00.000Z'), 1).toISOString()).toBe(
        '2027-01-31T00:00:00.000Z',
      );
    });

    it('闰年 2 月:2027-08-31 + 6 月 = 2028-02-29(2028 是闰年,夹到 29 不是 28)', () => {
      expect(addMonthsClamped(new Date('2027-08-31T00:00:00.000Z'), 6).toISOString()).toBe(
        '2028-02-29T00:00:00.000Z',
      );
    });

    it('不是「30 天 × 月数」:2026-01-01 + 1 月 = 2026-02-01(而非 2026-01-31)', () => {
      expect(addMonthsClamped(new Date('2026-01-01T00:00:00.000Z'), 1).toISOString()).toBe(
        '2026-02-01T00:00:00.000Z',
      );
    });

    it('上界 600 月(50 年)仍是自然月:2026-01-31 + 600 月 = 2076-01-31', () => {
      expect(addMonthsClamped(new Date('2026-01-31T00:00:00.000Z'), 600).toISOString()).toBe(
        '2076-01-31T00:00:00.000Z',
      );
    });
  });
});
