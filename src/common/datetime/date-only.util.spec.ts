import {
  addMonthsClamped,
  beijingDateOnly,
  beijingDayBoundsUtc,
  normalizeDateOnly,
  splitSpanByBeijingDay,
} from './date-only.util';

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

  // 活动改造 v1.1 第 2 批第一刀(合同 §3.21 北京日拆分)。
  // 三类边界按 goal DoD 1 逐条覆盖:跨日界 / 月末 / 闰日。
  describe('beijingDayBoundsUtc', () => {
    it('北京日 2026-07-14 覆盖 [2026-07-13T16:00Z, 2026-07-14T16:00Z)', () => {
      const bounds = beijingDayBoundsUtc(new Date('2026-07-14T00:00:00.000Z'));
      expect(bounds.startAt.toISOString()).toBe('2026-07-13T16:00:00.000Z');
      expect(bounds.endAt.toISOString()).toBe('2026-07-14T16:00:00.000Z');
    });

    it('与 beijingDateOnly 自洽:区间内任一瞬间归回同一日,区间右端点已属次日', () => {
      const ledgerDate = new Date('2026-07-14T00:00:00.000Z');
      const { startAt, endAt } = beijingDayBoundsUtc(ledgerDate);
      expect(beijingDateOnly(startAt).toISOString()).toBe(ledgerDate.toISOString());
      expect(beijingDateOnly(new Date(endAt.getTime() - 1)).toISOString()).toBe(
        ledgerDate.toISOString(),
      );
      expect(beijingDateOnly(endAt).toISOString()).toBe('2026-07-15T00:00:00.000Z');
    });
  });

  describe('splitSpanByBeijingDay', () => {
    it('同一北京日内不切分,整段一片', () => {
      const slices = splitSpanByBeijingDay(
        new Date('2026-07-14T01:00:00.000Z'),
        new Date('2026-07-14T05:00:00.000Z'),
      );
      expect(slices).toHaveLength(1);
      expect(slices[0].ledgerDate.toISOString()).toBe('2026-07-14T00:00:00.000Z');
      expect(slices[0].milliseconds).toBe(4 * 3600 * 1000);
    });

    it('跨日界:15:00Z → 17:00Z 切成 07-14 / 07-15 两片,断点恰在 16:00Z', () => {
      const slices = splitSpanByBeijingDay(
        new Date('2026-07-14T15:00:00.000Z'),
        new Date('2026-07-14T17:00:00.000Z'),
      );
      expect(
        slices.map((slice) => [slice.ledgerDate.toISOString(), slice.milliseconds]),
      ).toStrictEqual([
        ['2026-07-14T00:00:00.000Z', 3600 * 1000],
        ['2026-07-15T00:00:00.000Z', 3600 * 1000],
      ]);
      expect(slices[0].endAt.toISOString()).toBe('2026-07-14T16:00:00.000Z');
      expect(slices[1].startAt.toISOString()).toBe('2026-07-14T16:00:00.000Z');
    });

    it('月末:01-31 15:00Z → 01-31 17:00Z 后一片是 02-01(不是 01-32 也不是 02-31)', () => {
      const slices = splitSpanByBeijingDay(
        new Date('2026-01-31T15:00:00.000Z'),
        new Date('2026-01-31T17:00:00.000Z'),
      );
      expect(slices.map((slice) => slice.ledgerDate.toISOString())).toStrictEqual([
        '2026-01-31T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z',
      ]);
    });

    // ⚠️ 闰日样本取 **2096** 而不是就近的 2028:`srvf/no-near-future-date` 禁近未来日期字面量
    // (INC-18)。2100 不是闰年,2096 是本世纪最后一个能用的闰年。
    it('闰日:2096-02-28 15:00Z → 17:00Z 后一片是 02-29(2096 是闰年)', () => {
      const slices = splitSpanByBeijingDay(
        new Date('2096-02-28T15:00:00.000Z'),
        new Date('2096-02-28T17:00:00.000Z'),
      );
      expect(slices.map((slice) => slice.ledgerDate.toISOString())).toStrictEqual([
        '2096-02-28T00:00:00.000Z',
        '2096-02-29T00:00:00.000Z',
      ]);
    });

    it('非闰年同一位置直接跳到 03-01(2026 非闰年;与上例构成对照)', () => {
      const slices = splitSpanByBeijingDay(
        new Date('2026-02-28T15:00:00.000Z'),
        new Date('2026-02-28T17:00:00.000Z'),
      );
      expect(slices.map((slice) => slice.ledgerDate.toISOString())).toStrictEqual([
        '2026-02-28T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
      ]);
    });

    it('跨多日:整 3 天 + 尾巴,片数与时长逐片可核', () => {
      const slices = splitSpanByBeijingDay(
        new Date('2026-07-13T18:00:00.000Z'),
        new Date('2026-07-16T02:00:00.000Z'),
      );
      expect(
        slices.map((slice) => [slice.ledgerDate.toISOString(), slice.milliseconds / 3600_000]),
      ).toStrictEqual([
        ['2026-07-14T00:00:00.000Z', 22],
        ['2026-07-15T00:00:00.000Z', 24],
        ['2026-07-16T00:00:00.000Z', 10],
      ]);
    });

    it('切片无缝且不重叠:相邻片首尾相接,总时长等于原区间', () => {
      const startAt = new Date('2026-07-13T18:00:00.000Z');
      const endAt = new Date('2026-07-16T02:00:00.000Z');
      const slices = splitSpanByBeijingDay(startAt, endAt);
      expect(slices[0].startAt.toISOString()).toBe(startAt.toISOString());
      expect(slices[slices.length - 1].endAt.toISOString()).toBe(endAt.toISOString());
      for (let i = 1; i < slices.length; i += 1) {
        expect(slices[i].startAt.toISOString()).toBe(slices[i - 1].endAt.toISOString());
      }
      expect(slices.reduce((sum, slice) => sum + slice.milliseconds, 0)).toBe(
        endAt.getTime() - startAt.getTime(),
      );
    });

    it('恰好落在日界上的瞬间归后一日,不产生零长度片', () => {
      const slices = splitSpanByBeijingDay(
        new Date('2026-07-14T16:00:00.000Z'),
        new Date('2026-07-14T17:00:00.000Z'),
      );
      expect(slices).toHaveLength(1);
      expect(slices[0].ledgerDate.toISOString()).toBe('2026-07-15T00:00:00.000Z');
    });

    it('空区间与倒序区间返回空数组(不抛)', () => {
      const instant = new Date('2026-07-14T10:00:00.000Z');
      expect(splitSpanByBeijingDay(instant, instant)).toStrictEqual([]);
      expect(splitSpanByBeijingDay(instant, new Date('2026-07-14T09:00:00.000Z'))).toStrictEqual(
        [],
      );
    });

    it('无效 Date 抛 RangeError,绝不返回「看着合法」的结果', () => {
      const valid = new Date('2026-07-14T10:00:00.000Z');
      expect(() => splitSpanByBeijingDay(new Date('nope'), valid)).toThrow(RangeError);
      expect(() => splitSpanByBeijingDay(valid, new Date('nope'))).toThrow(RangeError);
    });
  });
});
