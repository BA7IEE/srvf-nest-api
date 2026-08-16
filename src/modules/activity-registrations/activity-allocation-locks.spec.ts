import { Prisma } from '@prisma/client';

import { BizException } from '../../common/exceptions/biz.exception';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { firstComeWaitlistRank, lockApplicationProjections } from './activity-allocation-locks';
import type { FirstComeWaitlistRow, PrismaTx } from './activity-allocation.types';

/*
 * 分配锁定读取层的单测(#1041 抽出,此前零覆盖)。
 *
 * ⚠️ 本层是**被调用方**而非事务起点:它在调用方已开启的事务里加锁,
 * 因此**调用顺序即锁顺序**,而那条约束**无法用单测表达**(它是跨方法的调用次序)。
 * 本 spec 只能覆盖各函数**自身的判定与返回**;锁序仍靠编排器的锁序台账与人工评审。
 * 不要因为这里全绿就以为锁序被守住了 —— 那是两件事。
 *
 * 本层判定同样共用 ACTIVITY_CAPACITY_RECONCILIATION_FAILED(错误码无鉴别力),
 * 故沿用「每个用例只破坏一个字段、其余合法」的构造。
 */

function makeTx(rows: unknown[]) {
  const queryRaw = jest.fn<Promise<unknown[]>, [Prisma.Sql]>().mockResolvedValue(rows);
  return { tx: { $queryRaw: queryRaw } as unknown as PrismaTx, queryRaw };
}

function expectReconciliationFailure(promise: Promise<unknown>): Promise<void> {
  return expect(promise)
    .rejects.toThrow(BizException)
    .then(async () => {
      await expect(promise).rejects.toMatchObject({
        biz: BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED,
      });
    });
}

describe('lockApplicationProjections —— 只做加锁读取,不做判定', () => {
  it('原样返回查询结果(本函数无任何拒绝分支)', async () => {
    const rows = [{ allocationCandidateId: 'c1' }, { allocationCandidateId: 'c2' }];
    const { tx, queryRaw } = makeTx(rows);
    await expect(lockApplicationProjections(tx, 'batch-1')).resolves.toEqual(rows);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('空结果集合法(批次可以没有已投影的申请)', async () => {
    const { tx } = makeTx([]);
    await expect(lockApplicationProjections(tx, 'batch-1')).resolves.toEqual([]);
  });
});

describe('firstComeWaitlistRank —— 先到先得队列的下一个序号', () => {
  const CLEAN_ROW: FirstComeWaitlistRow = {
    participationIdentityId: 'id-1',
    acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
    waitlistRank: 1,
    currentPositionId: null,
    capacityReservationId: null,
    populationIncluded: false,
  };

  function row(over: Partial<FirstComeWaitlistRow> = {}): FirstComeWaitlistRow {
    return { ...CLEAN_ROW, ...over };
  }

  it('空队列 ⇒ 从 1 开始', async () => {
    const { tx } = makeTx([]);
    await expect(firstComeWaitlistRank(tx, input())).resolves.toBe(1);
  });

  it('取现有最大序号 +1(不是取数量 +1)', async () => {
    const { tx } = makeTx([
      row({ waitlistRank: 1 }),
      row({ participationIdentityId: 'id-2', waitlistRank: 5 }),
    ]);
    await expect(firstComeWaitlistRank(tx, input())).resolves.toBe(6);
  });

  // 这条钉的是注释里那句「deliberately permits gaps after departures」——
  // 退出者带走自己的序号后队列会留洞,新号必须继续往后取而不是填洞,
  // 否则两个人会拿到同一个序号(而 revision 是 append-only,历史事实不可改写)。
  it('队列有空洞时仍取最大值 +1,不填洞(append-only 事实不可改写)', async () => {
    const { tx } = makeTx([
      row({ waitlistRank: 1 }),
      row({ participationIdentityId: 'id-3', waitlistRank: 7 }),
    ]);
    await expect(firstComeWaitlistRank(tx, input())).resolves.toBe(8);
  });

  const singleFieldBreakages: ReadonlyArray<[string, Partial<FirstComeWaitlistRow>]> = [
    ['候补行没有序号', { waitlistRank: null }],
    ['序号小于 1', { waitlistRank: 0 }],
    ['候补者却已占岗位', { currentPositionId: 'pos-1' }],
    ['候补者却已占容量预留', { capacityReservationId: 'cap-1' }],
    ['候补者却已计入人数口径', { populationIncluded: true }],
  ];

  it.each(singleFieldBreakages)('拒绝:%s', async (_label, breakage) => {
    const { tx } = makeTx([row(breakage)]);
    await expectReconciliationFailure(firstComeWaitlistRank(tx, input()));
  });

  it('拒绝:两行拿到同一个序号(队列序号必须唯一)', async () => {
    const { tx } = makeTx([
      row({ waitlistRank: 3 }),
      row({ participationIdentityId: 'id-2', waitlistRank: 3 }),
    ]);
    await expectReconciliationFailure(firstComeWaitlistRank(tx, input()));
  });

  it('拒绝:同一身份在队列里出现两次', async () => {
    const { tx } = makeTx([row({ waitlistRank: 1 }), row({ waitlistRank: 2 })]);
    await expectReconciliationFailure(firstComeWaitlistRank(tx, input()));
  });

  it('多行全部合法时放行(正对照:证明上面每条红都是被破坏的那个字段导致)', async () => {
    const { tx } = makeTx([
      row({ waitlistRank: 1 }),
      row({ participationIdentityId: 'id-2', waitlistRank: 2 }),
      row({ participationIdentityId: 'id-3', waitlistRank: 3 }),
    ]);
    await expect(firstComeWaitlistRank(tx, input())).resolves.toBe(4);
  });

  function input() {
    return {
      activityId: 'act-1',
      sessionId: 'sess-1',
      positionId: null,
      participationIdentityId: 'id-new',
      acceptedAt: new Date('2026-02-01T00:00:00.000Z'),
    };
  }
});
