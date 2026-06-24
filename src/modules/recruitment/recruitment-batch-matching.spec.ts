import {
  type BatchMatchCandidate,
  resolveBatchMatch,
  resolveBatchMatches,
} from './recruitment-batch-matching';

// 招新闭环优化 S6 · 批量标门槛匹配纯函数单测(goal DoD#5「matched/unmatched」)。
// 覆盖:① 三匹配键优先级(tempNo > 姓名+手机 > 手机);② 0 命中 no-match;③ 多命中 ambiguous;
// ④ 缺匹配键 insufficient-key;⑤ 归一(trim / 空串);⑥ 批量同序。

function cand(
  over: Partial<BatchMatchCandidate> & Pick<BatchMatchCandidate, 'id'>,
): BatchMatchCandidate {
  return { tempNo: null, phone: null, realName: null, ...over };
}

const CANDIDATES: BatchMatchCandidate[] = [
  cand({ id: 'a1', tempNo: 'T20260001', phone: '13900000001', realName: '张三' }),
  cand({ id: 'a2', tempNo: 'T20260002', phone: '13900000002', realName: '李四' }),
  cand({ id: 'a3', tempNo: 'T20260003', phone: '13900000002', realName: '王五' }), // 与 a2 共用手机
];

describe('resolveBatchMatch · 匹配键优先级 + 命中裁决', () => {
  it('tempNo 精确命中(优先级最高,即使 phone/realName 同时给出也走 tempNo)', () => {
    expect(
      resolveBatchMatch(
        { tempNo: 'T20260001', phone: '13900000002', realName: '错名' },
        CANDIDATES,
      ),
    ).toEqual({ status: 'matched', applicationId: 'a1', matchedBy: 'tempNo' });
  });

  it('姓名+手机命中(无 tempNo 时走 name+phone;共用手机靠姓名区分)', () => {
    expect(resolveBatchMatch({ phone: '13900000002', realName: '王五' }, CANDIDATES)).toEqual({
      status: 'matched',
      applicationId: 'a3',
      matchedBy: 'name+phone',
    });
  });

  it('仅手机:唯一命中 → matched', () => {
    expect(resolveBatchMatch({ phone: '13900000001' }, CANDIDATES)).toEqual({
      status: 'matched',
      applicationId: 'a1',
      matchedBy: 'phone',
    });
  });

  it('仅手机:多命中(a2/a3 共用)→ ambiguous(绝不猜)', () => {
    expect(resolveBatchMatch({ phone: '13900000002' }, CANDIDATES)).toEqual({
      status: 'unmatched',
      reason: 'ambiguous',
    });
  });

  it('姓名+手机:姓名对不上 → no-match(0 命中)', () => {
    expect(resolveBatchMatch({ phone: '13900000002', realName: '不存在' }, CANDIDATES)).toEqual({
      status: 'unmatched',
      reason: 'no-match',
    });
  });

  it('tempNo 不存在 → no-match', () => {
    expect(resolveBatchMatch({ tempNo: 'T20269999' }, CANDIDATES)).toEqual({
      status: 'unmatched',
      reason: 'no-match',
    });
  });

  it('仅 realName(无 phone)→ insufficient-key(姓名单键不作为匹配键)', () => {
    expect(resolveBatchMatch({ realName: '张三' }, CANDIDATES)).toEqual({
      status: 'unmatched',
      reason: 'insufficient-key',
    });
  });

  it('三键全空 / 全空白 → insufficient-key', () => {
    expect(resolveBatchMatch({}, CANDIDATES)).toEqual({
      status: 'unmatched',
      reason: 'insufficient-key',
    });
    expect(resolveBatchMatch({ tempNo: '  ', phone: '', realName: '   ' }, CANDIDATES)).toEqual({
      status: 'unmatched',
      reason: 'insufficient-key',
    });
  });

  it('归一:首尾空白 trim 后精确命中', () => {
    expect(resolveBatchMatch({ tempNo: '  T20260002 ' }, CANDIDATES)).toEqual({
      status: 'matched',
      applicationId: 'a2',
      matchedBy: 'tempNo',
    });
  });

  it('候选 tempNo 为 null 不被空 tempNo 误命中', () => {
    const withNullTemp = [cand({ id: 'x', tempNo: null, phone: '13800000000' })];
    // 入参给 phone(有效键),候选 tempNo=null 不参与;命中 phone
    expect(resolveBatchMatch({ phone: '13800000000' }, withNullTemp)).toEqual({
      status: 'matched',
      applicationId: 'x',
      matchedBy: 'phone',
    });
  });
});

describe('resolveBatchMatches · 批量同序', () => {
  it('结果与入参一一对应、同序', () => {
    const out = resolveBatchMatches(
      [
        { tempNo: 'T20260001' }, // matched a1
        { phone: '13900000002' }, // ambiguous
        { realName: '只有名' }, // insufficient-key
      ],
      CANDIDATES,
    );
    expect(out).toEqual([
      { status: 'matched', applicationId: 'a1', matchedBy: 'tempNo' },
      { status: 'unmatched', reason: 'ambiguous' },
      { status: 'unmatched', reason: 'insufficient-key' },
    ]);
  });
});
