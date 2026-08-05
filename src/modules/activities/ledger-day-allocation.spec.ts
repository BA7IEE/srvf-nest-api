import {
  LEDGER_DAILY_CREDIT_CAP_HUNDREDTHS,
  allocateDailyCredit,
  dayTotalWithinCap,
  distributeByWeight,
  splitRecognizedIntoDays,
} from './ledger-day-allocation';

// 账本算术的判据。**它错了不会报错** —— 会产出一个看起来正常的账本,
// 所以这里每一条都写成"算出来的数必须逐分等于某个具体值",不写"大致正确"。
//
// 北京日界口径:北京 00:00 = 前一日 16:00Z(UTC+8)。下面的样本刻意跨这条界。
describe('ledger day allocation —— 北京日拆分 + 日上限分配(§3.21 / §3.24 / §5.12)', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  describe('① 北京日拆分:权重来自服务段,被分配的总量是认定值', () => {
    it('单日单段:整块落在同一个北京日', () => {
      const outcome = splitRecognizedIntoDays({
        spans: [
          {
            startAt: new Date('2020-03-01T01:00:00.000Z'),
            endAt: new Date('2020-03-01T05:00:00.000Z'),
          },
        ],
        recognizedServiceHours: 4,
        recognizedContributionPoints: 1.2,
        stableOrderKey: 'k1',
      });
      expect(outcome.kind).toBe('split');
      if (outcome.kind !== 'split') return;
      expect(outcome.rows).toStrictEqual([
        {
          ledgerDate: day('2020-03-01'),
          serviceHours: 4,
          recognizedPoints: 1.2,
          sequenceStartAt: new Date('2020-03-01T01:00:00.000Z'),
          stableOrderKey: 'k1',
        },
      ]);
    });

    it('⭐ 跨北京日界的一段按毫秒比例拆成两日,逐日求和恒等于认定总量', () => {
      // 北京时间 2020-03-01 22:00 → 03-02 02:00(= UTC 14:00 → 18:00),
      // 前 2 小时属 03-01,后 2 小时属 03-02(界线 = UTC 16:00)。
      const outcome = splitRecognizedIntoDays({
        spans: [
          {
            startAt: new Date('2020-03-01T14:00:00.000Z'),
            endAt: new Date('2020-03-01T18:00:00.000Z'),
          },
        ],
        recognizedServiceHours: 4,
        recognizedContributionPoints: 1.5,
        stableOrderKey: 'k1',
      });
      if (outcome.kind !== 'split') throw new Error('expected split');
      expect(outcome.rows.map((row) => row.ledgerDate)).toStrictEqual([
        day('2020-03-01'),
        day('2020-03-02'),
      ]);
      expect(outcome.rows.map((row) => row.serviceHours)).toStrictEqual([2, 2]);
      expect(outcome.rows.map((row) => row.recognizedPoints)).toStrictEqual([0.75, 0.75]);
      // 第二日的起点必须是**日界那一刻**,不是段的起点。
      expect(outcome.rows[1].sequenceStartAt).toStrictEqual(new Date('2020-03-01T16:00:00.000Z'));
    });

    it('⭐ 除不尽时用最大余额法:逐日求和仍逐分等于认定总量(不丢分)', () => {
      // 三段等长 ⇒ 1.00 分三等分。逐项四舍五入会得 0.33×3 = 0.99(丢 1 分)。
      const outcome = splitRecognizedIntoDays({
        spans: [
          {
            startAt: new Date('2020-03-01T02:00:00.000Z'),
            endAt: new Date('2020-03-01T03:00:00.000Z'),
          },
          {
            startAt: new Date('2020-03-02T02:00:00.000Z'),
            endAt: new Date('2020-03-02T03:00:00.000Z'),
          },
          {
            startAt: new Date('2020-03-03T02:00:00.000Z'),
            endAt: new Date('2020-03-03T03:00:00.000Z'),
          },
        ],
        recognizedServiceHours: 3,
        recognizedContributionPoints: 1,
        stableOrderKey: 'k1',
      });
      if (outcome.kind !== 'split') throw new Error('expected split');
      const points = outcome.rows.map((row) => row.recognizedPoints);
      expect(points).toStrictEqual([0.34, 0.33, 0.33]);
      expect(points.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 10);
    });

    it('多段落在同一日 ⇒ 合并成一行,sequenceStartAt 取最早起点', () => {
      const outcome = splitRecognizedIntoDays({
        spans: [
          {
            startAt: new Date('2020-03-01T06:00:00.000Z'),
            endAt: new Date('2020-03-01T07:00:00.000Z'),
          },
          {
            startAt: new Date('2020-03-01T01:00:00.000Z'),
            endAt: new Date('2020-03-01T02:00:00.000Z'),
          },
        ],
        recognizedServiceHours: 2,
        recognizedContributionPoints: 0.6,
        stableOrderKey: 'k1',
      });
      if (outcome.kind !== 'split') throw new Error('expected split');
      expect(outcome.rows).toHaveLength(1);
      expect(outcome.rows[0].sequenceStartAt).toStrictEqual(new Date('2020-03-01T01:00:00.000Z'));
      expect(outcome.rows[0].serviceHours).toBe(2);
    });

    it('开放段(未签退)不产生权重 —— 没有签退时刻就没有时长', () => {
      const outcome = splitRecognizedIntoDays({
        spans: [{ startAt: new Date('2020-03-01T01:00:00.000Z'), endAt: null }],
        recognizedServiceHours: 0,
        recognizedContributionPoints: 0,
        stableOrderKey: 'k1',
      });
      expect(outcome).toStrictEqual({ kind: 'split', rows: [] });
    });

    it('零认定值 + 零服务日 = 合法的"没有账可入"', () => {
      expect(
        splitRecognizedIntoDays({
          spans: [],
          recognizedServiceHours: 0,
          recognizedContributionPoints: 0,
          stableOrderKey: 'k1',
        }),
      ).toStrictEqual({ kind: 'split', rows: [] });
    });

    it('⭐ 有非零认定值却一天都归不上 ⇒ no_service_day(绝不猜一个日期)', () => {
      expect(
        splitRecognizedIntoDays({
          spans: [],
          recognizedServiceHours: 0,
          recognizedContributionPoints: 0.5,
          stableOrderKey: 'k1',
        }),
      ).toStrictEqual({ kind: 'no_service_day' });
      expect(
        splitRecognizedIntoDays({
          spans: [{ startAt: new Date('2020-03-01T01:00:00.000Z'), endAt: null }],
          recognizedServiceHours: 1,
          recognizedContributionPoints: 0,
          stableOrderKey: 'k1',
        }),
      ).toStrictEqual({ kind: 'no_service_day' });
    });
  });

  describe('② 日上限分配:先到的服务先拿额度', () => {
    const at = (iso: string) => new Date(iso);

    it('额度充足 ⇒ 全额计入,零截断', () => {
      expect(
        allocateDailyCredit(
          [
            {
              recognizedPoints: 1.2,
              sequenceStartAt: at('2020-03-01T01:00:00.000Z'),
              stableOrderKey: 'a',
            },
          ],
          0,
        ),
      ).toStrictEqual([{ creditedPoints: 1.2, cappedOutPoints: 0 }]);
    });

    it('⭐ 跨过上限时**部分**计入,余下进 cappedOut(不是整条丢弃)', () => {
      expect(
        allocateDailyCredit(
          [
            {
              recognizedPoints: 2,
              sequenceStartAt: at('2020-03-01T01:00:00.000Z'),
              stableOrderKey: 'a',
            },
          ],
          2,
        ),
      ).toStrictEqual([{ creditedPoints: 1, cappedOutPoints: 1 }]);
    });

    it('基线已达上限 ⇒ 本批全部截掉,不出现负额度', () => {
      expect(
        allocateDailyCredit(
          [
            {
              recognizedPoints: 1.5,
              sequenceStartAt: at('2020-03-01T01:00:00.000Z'),
              stableOrderKey: 'a',
            },
          ],
          3,
        ),
      ).toStrictEqual([{ creditedPoints: 0, cappedOutPoints: 1.5 }]);
      // 历史数据超过上限(理论上不可达)时同样钳到 0,不"回吐额度"。
      expect(
        allocateDailyCredit(
          [
            {
              recognizedPoints: 1,
              sequenceStartAt: at('2020-03-01T01:00:00.000Z'),
              stableOrderKey: 'a',
            },
          ],
          4,
        ),
      ).toStrictEqual([{ creditedPoints: 0, cappedOutPoints: 1 }]);
    });

    it('⭐ 分配顺序由 (sequenceStartAt, stableOrderKey) 决定,与入参书写顺序无关', () => {
      const late = {
        recognizedPoints: 2,
        sequenceStartAt: at('2020-03-01T09:00:00.000Z'),
        stableOrderKey: 'z',
      };
      const early = {
        recognizedPoints: 2,
        sequenceStartAt: at('2020-03-01T01:00:00.000Z'),
        stableOrderKey: 'a',
      };
      // 先写 late 再写 early:额度仍然先给 early(1.5+1.5 会更"公平",但那不是合同口径)。
      expect(allocateDailyCredit([late, early], 0)).toStrictEqual([
        { creditedPoints: 1, cappedOutPoints: 1 },
        { creditedPoints: 2, cappedOutPoints: 0 },
      ]);
      // 换个书写顺序,**每一行拿到的数不变**。
      expect(allocateDailyCredit([early, late], 0)).toStrictEqual([
        { creditedPoints: 2, cappedOutPoints: 0 },
        { creditedPoints: 1, cappedOutPoints: 1 },
      ]);
    });

    it('起点相同 ⇒ 按 stableOrderKey 定序(不依赖 id 生成顺序)', () => {
      const sameStart = at('2020-03-01T01:00:00.000Z');
      expect(
        allocateDailyCredit(
          [
            { recognizedPoints: 2, sequenceStartAt: sameStart, stableOrderKey: 'b' },
            { recognizedPoints: 2, sequenceStartAt: sameStart, stableOrderKey: 'a' },
          ],
          0,
        ),
      ).toStrictEqual([
        { creditedPoints: 1, cappedOutPoints: 1 },
        { creditedPoints: 2, cappedOutPoints: 0 },
      ]);
    });

    // ⭐ 这条与 DB 上的 `participation_ledger_entry_balance_check` 是同一件事:
    //    应用层算出来的每一行都必须满足它,否则写库时会 23514。
    it('⭐ 恒等式 recognized = credited + cappedOut 对每一行成立', () => {
      const candidates = [
        {
          recognizedPoints: 1.37,
          sequenceStartAt: at('2020-03-01T01:00:00.000Z'),
          stableOrderKey: 'a',
        },
        {
          recognizedPoints: 2.41,
          sequenceStartAt: at('2020-03-01T05:00:00.000Z'),
          stableOrderKey: 'b',
        },
        {
          recognizedPoints: 0.55,
          sequenceStartAt: at('2020-03-01T09:00:00.000Z'),
          stableOrderKey: 'c',
        },
      ];
      const allocated = allocateDailyCredit(candidates, 0.4);
      allocated.forEach((row, index) => {
        expect(row.creditedPoints + row.cappedOutPoints).toBeCloseTo(
          candidates[index].recognizedPoints,
          10,
        );
      });
      // 合计计入 = 3 − 0.4 = 2.6(额度被用满)。
      expect(allocated.reduce((sum, row) => sum + row.creditedPoints, 0)).toBeCloseTo(2.6, 10);
    });
  });

  describe('③ 日合计 0..3 的最终判定(§3.24 末句)', () => {
    it('上限值取自全仓既有常量,不是本模块另立的 3', () => {
      expect(LEDGER_DAILY_CREDIT_CAP_HUNDREDTHS).toBe(300);
    });

    it('恰好等于上限放行,超出一分即拒', () => {
      expect(dayTotalWithinCap(1.5, 1.5)).toBe(true);
      expect(dayTotalWithinCap(1.5, 1.51)).toBe(false);
      expect(dayTotalWithinCap(0, 3)).toBe(true);
      expect(dayTotalWithinCap(2.99, 0.02)).toBe(false);
    });

    it('负合计同样拒(冲回不得把日合计打到 0 以下)', () => {
      expect(dayTotalWithinCap(0.5, -0.6)).toBe(false);
      expect(dayTotalWithinCap(0.5, -0.5)).toBe(true);
    });

    // 浮点直接相加会得 0.30000000000000004 > 0.3 这类结果;整数分不会。
    it('0.1 + 0.2 这类浮点陷阱不影响判定', () => {
      expect(dayTotalWithinCap(2.9, 0.1)).toBe(true);
    });
  });

  describe('④ 最大余额法本身', () => {
    it('逐项求和恒等于总量', () => {
      expect(distributeByWeight(100, [1, 1, 1])).toStrictEqual([34, 33, 33]);
      expect(distributeByWeight(7, [1, 1, 1, 1, 1])).toStrictEqual([2, 2, 1, 1, 1]);
      expect(distributeByWeight(0, [3, 1])).toStrictEqual([0, 0]);
      expect(distributeByWeight(5, [])).toStrictEqual([]);
    });

    it('权重全零(理论不可达)也不丢总量', () => {
      expect(distributeByWeight(9, [0, 0])).toStrictEqual([9, 0]);
    });
  });
});
