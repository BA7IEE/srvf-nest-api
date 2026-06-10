import { Prisma } from '@prisma/client';

import { ContributionCalculator } from './contribution-calculator';

// ContributionCalculator 组件级 unit 矩阵(B 档 test-only;沿 D14 5.B / D-A8 / D-S11 / Q-OPEN-7)。
// 行为权威仍是 attendances-contribution-prefill.e2e-spec.ts(真实 DB + ContributionRule 表);
// 本 spec 不重复 DB 级断言,只锁三件事:
//   1. 入参三态分发(undefined → 预填 / null → 显式清空跳过 / number → 不覆盖,含 0);
//   2. 档位计算矩阵(threshold null / hours<=threshold / hours>threshold × pointsAbove 兜底)
//      与 dailyCap 兜底 1.5(Q-OPEN-7)+ MIN 封顶;
//   3. 发往 tx 的查询形态(ACTIVE + deletedAt null + createdAt ASC;§3.1 复核报告"明确,不随机")。
// 与 attendances.service.spec.ts 的边界声明互补(该 spec 明确不复刻本组件内部矩阵)。

const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

interface RuleRow {
  durationThreshold: Prisma.Decimal | null;
  pointsBelow: Prisma.Decimal;
  pointsAbove: Prisma.Decimal | null;
  dailyCap: Prisma.Decimal | null;
  createdAt: Date;
}

// 默认 dailyCap 3.00:高于本文件所有 candidate,确保档位断言不被封顶干扰;
// 测 cap 行为时显式覆盖。
function makeRule(overrides: Partial<RuleRow> = {}): RuleRow {
  return {
    durationThreshold: null,
    pointsBelow: new Prisma.Decimal('1.00'),
    pointsAbove: null,
    dailyCap: new Prisma.Decimal('3.00'),
    createdAt: FIXED_DATE,
    ...overrides,
  };
}

function makeTx(rules: RuleRow[]) {
  const findMany = jest.fn().mockResolvedValue(rules);
  const tx = { contributionRule: { findMany } } as unknown as Prisma.TransactionClient;
  return { tx, findMany };
}

function rec(
  serviceHours: number,
  contributionPoints?: number | null,
): { roleCode: string; serviceHours: number; contributionPoints?: number | null } {
  return { roleCode: 'volunteer', serviceHours, contributionPoints };
}

describe('ContributionCalculator', () => {
  let calculator: ContributionCalculator;

  beforeEach(() => {
    calculator = new ContributionCalculator();
  });

  describe('入参三态分发(D-A8 + v0.6 契约小修复)', () => {
    it('number 已传值 → 原样保留,不查表', async () => {
      const { tx, findMany } = makeTx([makeRule()]);

      const out = await calculator.applyContributionRulePrefill([rec(4, 0.8)], 'rescue', tx);

      expect(out[0].contributionPoints).toBe(0.8);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('0 也是 number → 不覆盖(锁定 !== undefined 判定,防 truthy 回归)', async () => {
      const { tx, findMany } = makeTx([makeRule()]);

      const out = await calculator.applyContributionRulePrefill([rec(4, 0)], 'rescue', tx);

      expect(out[0].contributionPoints).toBe(0);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('null 显式清空 → 跳过预填保持 null,不查表(APD approve 前现场填入)', async () => {
      const { tx, findMany } = makeTx([makeRule()]);

      const out = await calculator.applyContributionRulePrefill([rec(4, null)], 'rescue', tx);

      expect(out[0].contributionPoints).toBeNull();
      expect(findMany).not.toHaveBeenCalled();
    });

    it('undefined → 走预填(查表取值)', async () => {
      const { tx, findMany } = makeTx([makeRule({ pointsBelow: new Prisma.Decimal('1.20') })]);

      const out = await calculator.applyContributionRulePrefill([rec(4)], 'rescue', tx);

      expect(out[0].contributionPoints).toBe(1.2);
      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it('mixed batch:仅 undefined 项查表;顺序 / 长度 / 泛型额外字段透传不变', async () => {
      const { tx, findMany } = makeTx([makeRule({ pointsBelow: new Prisma.Decimal('1.20') })]);
      const records = [
        { ...rec(4, 0.5), memberId: 'm1' },
        { ...rec(4, null), memberId: 'm2' },
        { ...rec(4), memberId: 'm3' },
      ];

      const out = await calculator.applyContributionRulePrefill(records, 'rescue', tx);

      expect(out).toHaveLength(3);
      expect(out.map((r) => r.memberId)).toEqual(['m1', 'm2', 'm3']);
      expect(out[0].contributionPoints).toBe(0.5);
      expect(out[1].contributionPoints).toBeNull();
      expect(out[2].contributionPoints).toBe(1.2);
      expect(findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('规则匹配与档位(D14 5.B;无匹配规则不抛错沿 D-S11 22048 不开)', () => {
    it('无匹配规则 → contributionPoints = null,不抛错', async () => {
      const { tx } = makeTx([]);

      const out = await calculator.applyContributionRulePrefill([rec(4)], 'rescue', tx);

      expect(out[0].contributionPoints).toBeNull();
    });

    // 档位矩阵:threshold / pointsAbove / serviceHours → 预期取值
    // below=1.00, above=2.00(由 makeRule 覆盖),cap=3.00 不干扰。
    const tierCases: Array<
      [
        name: string,
        threshold: string | null,
        above: string | null,
        hours: number,
        expected: number,
      ]
    > = [
      ['threshold null → 取 below(above 不参与)', null, '2.00', 4, 1],
      ['hours < threshold → below', '4.00', '2.00', 3.5, 1],
      ['hours = threshold(边界含等于)→ below', '4.00', '2.00', 4, 1],
      ['hours > threshold → above', '4.00', '2.00', 4.5, 2],
      ['hours > threshold 且 above null → 兜底 below', '4.00', null, 4.5, 1],
    ];

    it.each(tierCases)('%s', async (_name, threshold, above, hours, expected) => {
      const { tx } = makeTx([
        makeRule({
          durationThreshold: threshold === null ? null : new Prisma.Decimal(threshold),
          pointsBelow: new Prisma.Decimal('1.00'),
          pointsAbove: above === null ? null : new Prisma.Decimal(above),
        }),
      ]);

      const out = await calculator.applyContributionRulePrefill([rec(hours)], 'rescue', tx);

      expect(out[0].contributionPoints).toBe(expected);
    });

    it('多条候选(NULL threshold 档位)取首条 —— DB 按 createdAt ASC 返回,选取明确不随机(§3.1)', async () => {
      const { tx } = makeTx([
        makeRule({ pointsBelow: new Prisma.Decimal('0.50'), createdAt: FIXED_DATE }),
        makeRule({
          pointsBelow: new Prisma.Decimal('2.50'),
          createdAt: new Date('2026-02-01T00:00:00.000Z'),
        }),
      ]);

      const out = await calculator.applyContributionRulePrefill([rec(4)], 'rescue', tx);

      expect(out[0].contributionPoints).toBe(0.5);
    });

    it('查询形态锁定:ACTIVE + deletedAt null + 双维度匹配 + createdAt ASC', async () => {
      const { tx, findMany } = makeTx([]);

      await calculator.applyContributionRulePrefill([rec(4)], 'rescue', tx);

      expect(findMany).toHaveBeenCalledWith({
        where: {
          activityTypeCode: 'rescue',
          attendanceRoleCode: 'volunteer',
          status: 'ACTIVE',
          deletedAt: null,
        },
        select: {
          durationThreshold: true,
          pointsBelow: true,
          pointsAbove: true,
          dailyCap: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      });
    });
  });

  describe('每日上限(Q-OPEN-7:dailyCap null 兜底 1.5;预填值 = MIN(candidate, cap))', () => {
    const capCases: Array<
      [name: string, dailyCap: string | null, below: string, expected: number]
    > = [
      ['dailyCap null → 兜底 1.5 封顶', null, '2.00', 1.5],
      ['dailyCap 低于 candidate → 取 cap', '1.00', '2.00', 1],
      ['dailyCap 高于 candidate → 取 candidate', '3.00', '2.00', 2],
      ['dailyCap null 但 candidate 未触顶 → 取 candidate', null, '0.75', 0.75],
    ];

    it.each(capCases)('%s', async (_name, dailyCap, below, expected) => {
      const { tx } = makeTx([
        makeRule({
          dailyCap: dailyCap === null ? null : new Prisma.Decimal(dailyCap),
          pointsBelow: new Prisma.Decimal(below),
        }),
      ]);

      const out = await calculator.applyContributionRulePrefill([rec(4)], 'rescue', tx);

      expect(out[0].contributionPoints).toBe(expected);
    });
  });
});
