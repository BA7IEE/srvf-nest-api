import { Prisma } from '@prisma/client';

import { computeCappedContribution, computeContribution } from './team-join-progress';
import { CONTRIBUTION_THRESHOLD, contributionCutoff } from './team-join.constants';

// 贡献值封顶核 unit 矩阵(2026-06-23 队员/审批跨轴只读查询 goal:contribution-summary 后端聚合)。
// 锁三件事(沿 contribution-calculator.spec.ts mock 范式):
//   1. cutoff 参数化:Date → where.checkInAt: { lt: cutoff };null → 生涯累计,where 无 checkInAt;
//   2. 全局每日封顶 1.5:同北京日多条求和后封顶,capped < 裸 SUM(**禁裸 SUM** 的回归护栏);
//   3. null 贡献值按 0 计 + 跨北京日各自独立封顶再加总。
// 行为权威仍是 e2e(真实 DB);本 spec 不复刻 DB 级断言,只锁聚合算法与查询形态。

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

    const points = await computeCappedContribution(client, 'm1', null);

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

    await computeCappedContribution(client, 'm1', cutoff);

    expect(whereOfCall(findMany).checkInAt).toEqual({ lt: cutoff });
  });

  it('全局每日封顶 1.5:同北京日 1.0 + 1.0 = 2.0 → 封顶 1.5(capped < 裸 SUM 2.0)', async () => {
    const { client } = makeClient([rec(D1_A, 1.0), rec(D1_B, 1.0)]);

    const points = await computeCappedContribution(client, 'm1', null);

    // 封顶生效:capped 1.5 严格小于裸 SUM 2.0(禁裸 SUM 回归护栏)。
    expect(points.toString()).toBe('1.5');
    expect(points.lessThan(new Prisma.Decimal('2.0'))).toBe(true);
  });

  it('null 贡献值按 0 计,且跨北京日各自独立封顶再加总', async () => {
    // 北京日1:1.0 + 1.0 = 2.0 → 封顶 1.5;北京日2:0.5 + null(=0) = 0.5。总 = 2.0。
    // 裸 SUM = 1.0+1.0+0.5+0 = 2.5,封顶后 2.0 < 2.5。
    const { client } = makeClient([
      rec(D1_A, 1.0),
      rec(D1_B, 1.0),
      rec(D2_A, 0.5),
      rec(D2_B, null),
    ]);

    const points = await computeCappedContribution(client, 'm1', null);

    expect(points.toString()).toBe('2');
    expect(points.lessThan(new Prisma.Decimal('2.5'))).toBe(true);
  });

  it('空集 → 0', async () => {
    const { client } = makeClient([]);
    const points = await computeCappedContribution(client, 'm1', null);
    expect(points.toString()).toBe('0');
  });
});

describe('computeContribution(委托封顶核 + 入队年 cutoff + ≥5 gate;行为零变化回归)', () => {
  it('points 走封顶核 + cutoff=contributionCutoff(year);satisfied = points ≥ 5', async () => {
    // 4 个北京日各 1.5(每日两条 1.0+1.0 封顶)= 6.0 ≥ 5 → satisfied。
    const { client, findMany } = makeClient([
      rec('2026-01-01T08:00:00.000Z', 1.0),
      rec('2026-01-01T09:00:00.000Z', 1.0),
      rec('2026-01-02T08:00:00.000Z', 1.0),
      rec('2026-01-02T09:00:00.000Z', 1.0),
      rec('2026-01-03T08:00:00.000Z', 1.0),
      rec('2026-01-03T09:00:00.000Z', 1.0),
      rec('2026-01-04T08:00:00.000Z', 1.0),
      rec('2026-01-04T09:00:00.000Z', 1.0),
    ]);

    const result = await computeContribution(client, 'm1', 2026);

    expect(result.points.toString()).toBe('6');
    expect(result.satisfied).toBe(true);
    // 委托时把入队年 cutoff 传给封顶核。
    expect(whereOfCall(findMany).checkInAt).toEqual({ lt: contributionCutoff(2026) });
  });

  it('points < 阈值 → satisfied=false', async () => {
    const { client } = makeClient([rec('2026-01-01T08:00:00.000Z', 1.0)]);
    const result = await computeContribution(client, 'm1', 2026);
    expect(result.points.lessThan(CONTRIBUTION_THRESHOLD)).toBe(true);
    expect(result.satisfied).toBe(false);
  });
});
