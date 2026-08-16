import { Prisma } from '@prisma/client';

import { BizException } from '../../common/exceptions/biz.exception';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  asObject,
  assertPendingSource,
  decimalString,
  initialPreferencePositions,
  targetProjection,
} from './activity-allocation-policy';
import type { CandidateSource } from './activity-allocation.types';

/*
 * 分配判定层的单测(Phase 6-B 第五域第三刀)。
 *
 * 这些函数迁出 activity-allocation.service.ts 前**零单测覆盖** —— 抽成纯函数后才具备
 * 无 mock 可测性,本 spec 兑现那部分价值。
 *
 * ⚠️ 本层的判定共 11 个抛出点,其中 **10 个抛同一个 ACTIVITY_CAPACITY_RECONCILIATION_FAILED**。
 * 后果:断言「抛了哪个码」**没有鉴别力** —— 任一条件失效都长得一样。
 * 故本 spec 恒用「**每个用例只破坏一个字段,其余全部合法**」的构造:
 * 定位职责由**用例名 + 输入差异**承担,不由错误码承担。
 * 判据是否真绑住,靠变异对拍验证(见 PR 正文的红集矩阵)。
 */

const PENDING_SOURCE: CandidateSource = {
  id: 'identity-1',
  activityId: 'act-1',
  memberId: 'member-1',
  sessionId: 'sess-1',
  registrationId: 'reg-1',
  identityRevision: 1,
  identityStatusCode: 'pending',
  currentPositionId: null,
  capacityReservationId: null,
  populationIncluded: false,
  identityVersion: 1,
  registrationCurrentRevision: 1,
  registrationRevisionId: 'rev-1',
  participationRevisionId: 'prev-1',
  participationRevisionStatusCode: 'pending',
  participationRevisionPositionId: null,
  participationRevisionWaitlistRank: null,
  participationRevisionAllocationBatchId: null,
  acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
  preferenceSnapshot: null,
};

function source(over: Partial<CandidateSource> = {}): CandidateSource {
  return { ...PENDING_SOURCE, ...over };
}

/** 断言抛的是业务异常且为预期码 —— 码本身无鉴别力,定位靠用例名与入参差异。 */
function expectReconciliationFailure(fn: () => unknown): void {
  expect(fn).toThrow(BizException);
  try {
    fn();
  } catch (error) {
    expect((error as BizException).biz).toBe(BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED);
  }
}

describe('assertPendingSource —— 候选来源必须是「干净的待分配态」', () => {
  it('全部字段合法时放行(正对照:证明下方每条红都是被破坏的那一个字段导致)', () => {
    expect(() => assertPendingSource(source())).not.toThrow();
  });

  // 十个条件逐条破坏。每例仅改一个字段,其余与正对照逐字相同。
  const singleFieldBreakages: ReadonlyArray<[string, Partial<CandidateSource>]> = [
    ['身份修订号 < 1', { identityRevision: 0 }],
    ['报名当前修订号 < 1', { registrationCurrentRevision: 0 }],
    ['身份态不是 pending', { identityStatusCode: 'pass' }],
    ['参与修订态不是 pending', { participationRevisionStatusCode: 'pass' }],
    ['参与修订已有岗位', { participationRevisionPositionId: 'pos-1' }],
    ['参与修订已有候补名次', { participationRevisionWaitlistRank: 1 }],
    ['参与修订已挂在某批次上', { participationRevisionAllocationBatchId: 'batch-1' }],
    ['当前已有岗位', { currentPositionId: 'pos-1' }],
    ['已占容量预留', { capacityReservationId: 'cap-1' }],
    ['已计入人数口径', { populationIncluded: true }],
  ];

  it.each(singleFieldBreakages)('拒绝:%s', (_label, breakage) => {
    expectReconciliationFailure(() => assertPendingSource(source(breakage)));
  });
});

describe('initialPreferencePositions —— 志愿岗位序列的解析与校验', () => {
  it('批次已锁定岗位时直接返回该岗位,不看快照', () => {
    expect(initialPreferencePositions(null, 'pos-batch')).toEqual(['pos-batch']);
  });

  it('批次无岗位且快照为空数组 ⇒ 视为「不限岗位」的单元素 [null]', () => {
    expect(initialPreferencePositions({ positionIds: [] }, null)).toEqual([null]);
  });

  it('批次无岗位且快照给出岗位序列 ⇒ 原样返回(顺序即志愿顺序)', () => {
    expect(initialPreferencePositions({ positionIds: ['p1', 'p2'] }, null)).toEqual(['p1', 'p2']);
  });

  it('拒绝:快照为 null(无从得知志愿)', () => {
    expectReconciliationFailure(() => initialPreferencePositions(null, null));
  });

  it('拒绝:positionIds 不是数组', () => {
    expectReconciliationFailure(() => initialPreferencePositions({ positionIds: 'p1' }, null));
  });

  it('拒绝:序列含非字符串元素', () => {
    expectReconciliationFailure(() =>
      initialPreferencePositions({ positionIds: ['p1', 2] as unknown as Prisma.JsonValue }, null),
    );
  });

  it('拒绝:序列含空字符串', () => {
    expectReconciliationFailure(() =>
      initialPreferencePositions({ positionIds: ['p1', ''] }, null),
    );
  });

  it('拒绝:序列有重复岗位(同一岗位不可填两次志愿)', () => {
    expectReconciliationFailure(() =>
      initialPreferencePositions({ positionIds: ['p1', 'p1'] }, null),
    );
  });
});

describe('targetProjection —— 按批次维度取资格投影', () => {
  const projection = { eligible: true } as never;

  it('批次无岗位 ⇒ 取场次投影', () => {
    const evaluation = {
      sessions: new Map([['sess-1', projection]]),
      positions: new Map(),
    } as never;
    expect(targetProjection(evaluation, 'sess-1', null)).toBe(projection);
  });

  it('批次有岗位 ⇒ 取岗位投影(而非场次投影)', () => {
    const evaluation = {
      sessions: new Map([['sess-1', { eligible: false } as never]]),
      positions: new Map([['pos-1', projection]]),
    } as never;
    expect(targetProjection(evaluation, 'sess-1', 'pos-1')).toBe(projection);
  });

  it('拒绝:目标维度没有投影 ⇒ 资格配置无效(注意这是唯一抛别的码的判定)', () => {
    const evaluation = { sessions: new Map(), positions: new Map() } as never;
    expect(() => targetProjection(evaluation, 'sess-1', null)).toThrow(BizException);
    try {
      targetProjection(evaluation, 'sess-1', null);
    } catch (error) {
      expect((error as BizException).biz).toBe(
        BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID,
      );
    }
  });
});

describe('decimalString / asObject —— 纯值转换', () => {
  it('decimalString:null 透传为 null', () => {
    expect(decimalString(null)).toBeNull();
  });

  // 实现是 toFixed(4) 而非 toString():**定长小数是哈希确定性的前提** ——
  // 同一数值的不同书写(12.5 / 12.50 / 12.500)必须产生逐字相同的表示,
  // 否则 candidateSnapshotHash 会因存量精度差异而漂移,进而误判「快照被篡改」。
  it('decimalString:定长 4 位小数(同值不同精度 ⇒ 逐字相同)', () => {
    expect(decimalString(new Prisma.Decimal('12.5'))).toBe('12.5000');
    expect(decimalString(new Prisma.Decimal('12.50'))).toBe('12.5000');
    expect(decimalString(new Prisma.Decimal('12.500'))).toBe('12.5000');
  });

  it('decimalString:整数也补足小数位(不因整数走别的分支)', () => {
    expect(decimalString(new Prisma.Decimal('100'))).toBe('100.0000');
  });

  it('asObject:普通对象原样返回', () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
  });

  it('asObject:数组不是对象 ⇒ null(防止把 JSON 数组当记录读)', () => {
    expect(asObject([1, 2])).toBeNull();
  });

  it('asObject:null 与标量 ⇒ null', () => {
    expect(asObject(null)).toBeNull();
    expect(asObject('x')).toBeNull();
    expect(asObject(3)).toBeNull();
  });
});
