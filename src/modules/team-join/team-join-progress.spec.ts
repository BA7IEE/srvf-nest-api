import { LedgerQueryService } from '../activities/ledger-query.service';
import { Prisma } from '@prisma/client';

import {
  computeCappedContribution,
  computeCappedContributionBatch,
  computeContribution,
  computeContributionBatch,
} from './team-join-progress';
import { ActivityWorkflowGate } from '../../common/activity-workflow/activity-workflow.gate';
import type { AppConfig } from '../../config/app.config';
import { CONTRIBUTION_THRESHOLD, contributionCutoff } from './team-join.constants';

// 贡献值封顶核 unit 矩阵(2026-06-23 队员/审批跨轴只读查询 goal:contribution-summary 后端聚合)。
// 锁三件事(沿 contribution-calculator.spec.ts mock 范式):
//   1. cutoff 参数化:Date → where.checkInAt: { lt: cutoff };null → 生涯累计,where 无 checkInAt;
//   2. 全局每日封顶 3:同北京日多条求和后封顶,capped < 裸 SUM(**禁裸 SUM** 的回归护栏);
//   3. null 贡献值按 0 计 + 跨北京日各自独立封顶再加总。
// 行为权威仍是 e2e(真实 DB);本 spec 不复刻 DB 级断言,只锁聚合算法与查询形态。

const legacyGate = { participationReadSource: () => 'approved-attendance' as const };

type RecordRow = { checkInAt: Date; contributionPoints: Prisma.Decimal | null };

// 封顶核发往 prisma 的 where 形态(用于断言 cutoff 参数化 / approved-only)。
type FindManyWhere = {
  memberId: string;
  deletedAt: null;
  checkInAt?: { lt: Date };
  sheet: { statusCode: string; deletedAt: null };
};

function makeClient(records: RecordRow[]) {
  const findMany = jest.fn().mockResolvedValue(records);
  const client = { attendanceRecord: { findMany } } as unknown as Prisma.TransactionClient;
  return { client, findMany };
}

// 取第 callIndex 次 findMany 调用的 where(typed,避开 src/ 下 no-unsafe-member-access)。
function whereOfCall(findMany: jest.Mock, callIndex = 0): FindManyWhere {
  const calls = findMany.mock.calls as unknown as Array<[{ where: FindManyWhere }]>;
  return calls[callIndex][0].where;
}

function rec(checkInAtISO: string, points: number | null): RecordRow {
  return {
    checkInAt: new Date(checkInAtISO),
    contributionPoints: points === null ? null : new Prisma.Decimal(points),
  };
}

// 北京日界:UTC 16:00(前一日)~ UTC 16:00(当日)为同一北京日。
// 下列 UTC 时刻同属北京 2026-06-01:08:00Z(北京 16:00)/ 09:00Z(北京 17:00)。
// 20:00Z(北京 06-02 04:00)属次日。
const D1_A = '2026-06-01T08:00:00.000Z';
const D1_B = '2026-06-01T09:00:00.000Z';
const D2_A = '2026-06-01T20:00:00.000Z';
const D2_B = '2026-06-02T01:00:00.000Z';

describe('computeCappedContribution(封顶核)', () => {
  it('cutoff=null(生涯累计)→ where 无 checkInAt 上界,approved sheet only', async () => {
    const { client, findMany } = makeClient([rec(D1_A, 1.0)]);

    const points = await computeCappedContribution(
      client,
      'm1',
      null,
      legacyGate,
      LedgerQueryService,
    );

    expect(points.toString()).toBe('1');
    expect(findMany).toHaveBeenCalledTimes(1);
    const where = whereOfCall(findMany);
    expect(where.memberId).toBe('m1');
    expect(where.deletedAt).toBeNull();
    expect(where.checkInAt).toBeUndefined(); // 生涯累计:无 cutoff 上界
    expect(where.sheet).toEqual({ statusCode: 'approved', deletedAt: null });
  });

  it('cutoff=Date → where.checkInAt: { lt: cutoff }(入队 gate 本轮截至语义)', async () => {
    const { client, findMany } = makeClient([rec(D1_A, 1.0)]);
    const cutoff = contributionCutoff(2026);

    await computeCappedContribution(client, 'm1', cutoff, legacyGate, LedgerQueryService);

    expect(whereOfCall(findMany).checkInAt).toEqual({ lt: cutoff });
  });

  it('全局每日封顶 3:同北京日 2.0 + 2.0 = 4.0 → 封顶 3(capped < 裸 SUM 4.0)', async () => {
    const { client } = makeClient([rec(D1_A, 2.0), rec(D1_B, 2.0)]);

    const points = await computeCappedContribution(
      client,
      'm1',
      null,
      legacyGate,
      LedgerQueryService,
    );

    // 封顶生效:capped 3 严格小于裸 SUM 4.0(禁裸 SUM 回归护栏)。
    expect(points.toString()).toBe('3');
    expect(points.lessThan(new Prisma.Decimal('4.0'))).toBe(true);
  });

  it('null 贡献值按 0 计,且跨北京日各自独立封顶再加总', async () => {
    // 北京日1:2.0 + 2.0 = 4.0 → 封顶 3;北京日2:0.5 + null(=0) = 0.5。总 = 3.5。
    // 裸 SUM = 2.0+2.0+0.5+0 = 4.5,封顶后 3.5 < 4.5。
    const { client } = makeClient([
      rec(D1_A, 2.0),
      rec(D1_B, 2.0),
      rec(D2_A, 0.5),
      rec(D2_B, null),
    ]);

    const points = await computeCappedContribution(
      client,
      'm1',
      null,
      legacyGate,
      LedgerQueryService,
    );

    expect(points.toString()).toBe('3.5');
    expect(points.lessThan(new Prisma.Decimal('4.5'))).toBe(true);
  });

  it('空集 → 0', async () => {
    const { client } = makeClient([]);
    const points = await computeCappedContribution(
      client,
      'm1',
      null,
      legacyGate,
      LedgerQueryService,
    );
    expect(points.toString()).toBe('0');
  });
});

describe('computeContribution(委托封顶核 + 入队年 cutoff + ≥5 gate;行为零变化回归)', () => {
  it('points 走封顶核 + cutoff=contributionCutoff(year);satisfied = points ≥ 5', async () => {
    // 2 个北京日各 3(每日两条 2.0+2.0 封顶)= 6.0 ≥ 5 → satisfied。
    const { client, findMany } = makeClient([
      rec('2026-01-01T08:00:00.000Z', 2.0),
      rec('2026-01-01T09:00:00.000Z', 2.0),
      rec('2026-01-02T08:00:00.000Z', 2.0),
      rec('2026-01-02T09:00:00.000Z', 2.0),
    ]);

    const result = await computeContribution(client, 'm1', 2026, legacyGate, LedgerQueryService);

    expect(result.points.toString()).toBe('6');
    expect(result.satisfied).toBe(true);
    // 委托时把入队年 cutoff 传给封顶核。
    expect(whereOfCall(findMany).checkInAt).toEqual({ lt: contributionCutoff(2026) });
  });

  it('points < 阈值 → satisfied=false', async () => {
    const { client } = makeClient([rec('2026-01-01T08:00:00.000Z', 1.0)]);
    const result = await computeContribution(client, 'm1', 2026, legacyGate, LedgerQueryService);
    expect(result.points.lessThan(CONTRIBUTION_THRESHOLD)).toBe(true);
    expect(result.satisfied).toBe(false);
  });
});

function actualGate(enabled: boolean, readonlyMaintenance = false) {
  return new ActivityWorkflowGate({
    activityV11Workflow: { enabled, readonlyMaintenance },
  } as AppConfig);
}

function ledgerClient(total: string | null, rows: Array<{ memberId: string; total: string }> = []) {
  const aggregate = jest.fn().mockResolvedValue({
    _sum: { creditedPointsDelta: total === null ? null : new Prisma.Decimal(total) },
  });
  const groupBy = jest.fn().mockResolvedValue(
    rows.map((row) => ({
      memberId: row.memberId,
      _sum: { creditedPointsDelta: new Prisma.Decimal(row.total) },
    })),
  );
  const findMany = jest.fn().mockResolvedValue([rec(D1_A, 99)]);
  const client = {
    attendanceRecord: { findMany },
    participationLedgerEntry: { aggregate, groupBy },
  } as unknown as Prisma.TransactionClient;
  return { client, aggregate, groupBy, findMany };
}

describe('R5 single contribution source', () => {
  it.each([false, true])(
    'enabled with readonly=%s uses committed credited only, without a second daily cap or legacy fallback',
    async (readonlyMaintenance) => {
      const { client, aggregate, findMany } = ledgerClient('5.25');
      const result = await computeCappedContribution(
        client,
        'member',
        null,
        actualGate(true, readonlyMaintenance),
        LedgerQueryService,
      );
      expect(result.toString()).toBe('5.25');
      expect(findMany).not.toHaveBeenCalled();
      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(aggregate).toHaveBeenCalledWith({
        where: { memberId: 'member', postingBatch: { statusCode: 'committed' } },
        _sum: { creditedPointsDelta: true },
      });
    },
  );

  it.each([false, true])(
    'disabled with readonly=%s retains approved Decimal daily capping',
    async (readonlyMaintenance) => {
      const { client, findMany } = makeClient([rec(D1_A, 2), rec(D1_B, 2), rec(D2_A, 0.5)]);
      expect(
        (
          await computeCappedContribution(
            client,
            'member',
            null,
            actualGate(false, readonlyMaintenance),
            LedgerQueryService,
          )
        ).toString(),
      ).toBe('3.5');
      expect(findMany).toHaveBeenCalledTimes(1);
    },
  );

  it('does not replace a null committed SUM with legacy points', async () => {
    const { client, findMany } = ledgerClient(null);
    expect(
      (
        await computeCappedContribution(
          client,
          'member',
          null,
          actualGate(true),
          LedgerQueryService,
        )
      ).toString(),
    ).toBe('0');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('keeps correction/reversal deltas in the net total without filtering superseded result revisions', async () => {
    const { client, aggregate } = ledgerClient('4.50');
    const result = await computeContribution(
      client,
      'member',
      2026,
      actualGate(true),
      LedgerQueryService,
    );
    expect(result.points.toString()).toBe('4.5');
    expect(result.satisfied).toBe(false);
    expect(aggregate).toHaveBeenCalledWith({
      where: {
        memberId: 'member',
        postingBatch: { statusCode: 'committed' },
        ledgerDate: { lt: new Date('2026-04-01T00:00:00.000Z') },
      },
      _sum: { creditedPointsDelta: true },
    });
  });

  it('counts the Beijing March31 civil day, excluding April1 without comparing DATE to the UTC cutoff instant', async () => {
    const { client, aggregate } = ledgerClient('5');
    const result = await computeContribution(
      client,
      'member',
      2026,
      actualGate(true),
      LedgerQueryService,
    );
    expect(result.satisfied).toBe(true);
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          memberId: 'member',
          postingBatch: { statusCode: 'committed' },
          ledgerDate: { lt: new Date('2026-04-01T00:00:00.000Z') },
        },
      }),
    );
    expect(contributionCutoff(2026).toISOString()).toBe('2026-03-31T16:00:00.000Z');
  });

  it('batch deduplicates once, preserves absent members as zero, and uses the same cutoff and threshold', async () => {
    const { client, aggregate, groupBy, findMany } = ledgerClient(null, [
      { memberId: 'one', total: '5.25' },
      { memberId: 'two', total: '4.5' },
    ]);
    const result = await computeContributionBatch(
      client,
      ['one', 'two', 'one', 'absent'],
      2026,
      actualGate(true),
      LedgerQueryService,
    );
    expect([...result.keys()]).toEqual(['one', 'two', 'absent']);
    expect([...result.values()].map((v) => [v.points.toString(), v.satisfied])).toEqual([
      ['5.25', true],
      ['4.5', false],
      ['0', false],
    ]);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy).toHaveBeenCalledWith({
      by: ['memberId'],
      where: {
        memberId: { in: ['one', 'two', 'absent'] },
        postingBatch: { statusCode: 'committed' },
        ledgerDate: { lt: new Date('2026-04-01T00:00:00.000Z') },
      },
      _sum: { creditedPointsDelta: true },
    });
    expect(aggregate).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('batch off preserves per-member and per-day capping and null-as-zero', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { ...rec(D1_A, 2), memberId: 'one' },
      { ...rec(D1_B, 2), memberId: 'one' },
      { ...rec(D2_A, 2), memberId: 'one' },
      { ...rec(D1_A, null), memberId: 'two' },
    ]);
    const client = { attendanceRecord: { findMany } } as unknown as Prisma.TransactionClient;
    const result = await computeCappedContributionBatch(
      client,
      ['one', 'two', 'absent'],
      null,
      actualGate(false),
      LedgerQueryService,
    );
    expect([...result.values()].map((v) => v.toString())).toEqual(['5', '0', '0']);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('empty batch with enabled=%s performs no query', async (enabled) => {
    const { client, aggregate, groupBy, findMany } = ledgerClient(null);
    expect(
      await computeCappedContributionBatch(
        client,
        [],
        null,
        actualGate(enabled),
        LedgerQueryService,
      ),
    ).toEqual(new Map());
    expect(aggregate).not.toHaveBeenCalled();
    expect(groupBy).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});
