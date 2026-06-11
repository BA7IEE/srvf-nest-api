import { normalizeDateOnly } from './date-only.util';

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
});
