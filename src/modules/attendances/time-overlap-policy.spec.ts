import { Prisma } from '@prisma/client';

import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { TimeOverlapPolicy } from './time-overlap-policy';

// TimeOverlapPolicy 组件级 unit 矩阵(B 档 test-only;沿 R16 / Q-S15)。
// 行为权威仍是 attendances-time-overlap.e2e-spec.ts(PR #179 9 个 characterization case);
// 本 spec 不重复 DB 级断言,只锁两件事:
//   1. assertNoInternalOverlap 的纯内存重叠矩阵([start, end) 左闭右开 × per-member 分组);
//   2. assertNoTimeOverlap 发往 tx 的查询形态(memberId / AND 区间条件 / deletedAt 软删过滤 /
//      excludeSheetId 两态 / take 1)与"有冲突即抛 22060"判定。
// 与 attendances.service.spec.ts 的边界声明互补(该 spec 明确不复刻本组件内部矩阵)。

const T08 = new Date('2026-01-01T08:00:00.000Z');
const T09 = new Date('2026-01-01T09:00:00.000Z');
const T10 = new Date('2026-01-01T10:00:00.000Z');
const T11 = new Date('2026-01-01T11:00:00.000Z');
const T12 = new Date('2026-01-01T12:00:00.000Z');
const T16 = new Date('2026-01-01T16:00:00.000Z');

function rec(memberId: string, checkInAt: Date, checkOutAt: Date) {
  return { memberId, checkInAt, checkOutAt };
}

// 不依赖全局 fail()(jest 30 circus 下不可用);未抛时 caught 为 undefined,断言自然失败。
function expectTimeOverlapBiz(fn: () => void): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(BizException);
  expect((caught as BizException).biz).toBe(BizCode.ATTENDANCE_TIME_OVERLAP);
  expect((caught as BizException).biz.code).toBe(22060);
}

describe('TimeOverlapPolicy', () => {
  let policy: TimeOverlapPolicy;

  beforeEach(() => {
    policy = new TimeOverlapPolicy();
  });

  describe('assertNoInternalOverlap(纯内存,同 batch 内自检)', () => {
    it('空数组不抛', () => {
      expect(() => policy.assertNoInternalOverlap([])).not.toThrow();
    });

    it('单条不抛', () => {
      expect(() => policy.assertNoInternalOverlap([rec('m1', T08, T12)])).not.toThrow();
    });

    it('同 member 区间首尾相接不算重叠([8,12) + [12,16) 左闭右开)', () => {
      expect(() =>
        policy.assertNoInternalOverlap([rec('m1', T08, T12), rec('m1', T12, T16)]),
      ).not.toThrow();
    });

    // 重叠矩阵:部分重叠 / 完全包含 / 完全相同 → 全部 22060
    const overlapCases: Array<[string, Date, Date, Date, Date]> = [
      ['部分重叠', T08, T12, T11, T16],
      ['完全包含', T08, T12, T09, T10],
      ['完全相同', T08, T12, T08, T12],
    ];

    it.each(overlapCases)('同 member %s → 抛 22060', (_name, in1, out1, in2, out2) => {
      expectTimeOverlapBiz(() =>
        policy.assertNoInternalOverlap([rec('m1', in1, out1), rec('m1', in2, out2)]),
      );
    });

    it('不同 member 同区间不冲突(per-member 分组)', () => {
      expect(() =>
        policy.assertNoInternalOverlap([rec('m1', T08, T12), rec('m2', T08, T12)]),
      ).not.toThrow();
    });

    it('非相邻位置也检(第 3 条与第 1 条冲突)', () => {
      expectTimeOverlapBiz(() =>
        policy.assertNoInternalOverlap([
          rec('m1', T08, T10),
          rec('m1', T12, T16),
          rec('m1', T09, T11),
        ]),
      );
    });
  });

  describe('assertNoTimeOverlap(跨 Sheet 全局校验,查询形态锁定)', () => {
    function makeTx(rows: Array<{ id: string }>) {
      const findMany = jest.fn().mockResolvedValue(rows);
      const tx = { attendanceRecord: { findMany } } as unknown as Prisma.TransactionClient;
      return { tx, findMany };
    }

    it('无冲突行不抛;查询形态严格锁定(submit 路径:无 sheetId 键 = excludeSheetId undefined)', async () => {
      const { tx, findMany } = makeTx([]);

      await expect(
        policy.assertNoTimeOverlap('m1', T08, T12, undefined, tx),
      ).resolves.toBeUndefined();

      expect(findMany).toHaveBeenCalledTimes(1);
      // toHaveBeenCalledWith 深度严格相等:where 多出任何键(如 sheetId)即失败。
      expect(findMany).toHaveBeenCalledWith({
        where: {
          memberId: 'm1',
          AND: [{ checkInAt: { lt: T12 } }, { checkOutAt: { gt: T08 } }],
          deletedAt: null,
        },
        select: { id: true },
        take: 1,
      });
    });

    it('excludeSheetId 传入时 where.sheetId = { not: <id> }(edit 排除旧 Sheet)', async () => {
      const { tx, findMany } = makeTx([]);

      await policy.assertNoTimeOverlap('m1', T08, T12, 'sheet-old', tx);

      expect(findMany).toHaveBeenCalledWith({
        where: {
          memberId: 'm1',
          sheetId: { not: 'sheet-old' },
          AND: [{ checkInAt: { lt: T12 } }, { checkOutAt: { gt: T08 } }],
          deletedAt: null,
        },
        select: { id: true },
        take: 1,
      });
    });

    it('存在冲突行 → 抛 BizException(22060)', async () => {
      const { tx } = makeTx([{ id: 'rec-conflict' }]);

      await expect(policy.assertNoTimeOverlap('m1', T08, T12, undefined, tx)).rejects.toMatchObject(
        {
          biz: BizCode.ATTENDANCE_TIME_OVERLAP,
        },
      );
    });
  });
});
