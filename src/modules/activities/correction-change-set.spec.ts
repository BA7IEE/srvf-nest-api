import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  CORRECTION_CHANGE_SCHEMA_VERSION,
  parseCorrectionChangeSet,
} from './correction-change-set';
import { evaluateCorrectionReviewSeparation } from './correction-review-separation';

// ===== 第七刀:更正入参形状 + 更正审核人员隔离(纯函数层)=====
//
// 🔴 `requestedChangeJson` 是"账要改成什么样"的唯一输入。合同 §3.25 **没有给它字段表**,
//    闭集由本刀补齐 ⇒ 本 spec 就是那份闭集的可执行说明书。
//    每一条不合规都必须**拒绝**,不许"取默认值后继续"——
//    一个被静默补上默认值的字段,就是一笔没人授权过的账。

function validResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participationIdentityId: 'identity-1',
    resultCode: 'present',
    recognizedServiceHours: '4.00',
    recognizedContributionPoints: '1.20',
    adjustmentReason: '负责人复核后下调',
    lateFlag: false,
    earlyLeaveFlag: false,
    ...overrides,
  };
}

function changeSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: CORRECTION_CHANGE_SCHEMA_VERSION,
    results: [validResult()],
    segments: [],
    ...overrides,
  };
}

function expectRejected(raw: unknown): void {
  try {
    parseCorrectionChangeSet(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(BizException);
    expect((error as BizException).biz.code).toBe(BizCode.CORRECTION_CHANGE_SET_INVALID.code);
    return;
  }
  throw new Error('期望被拒绝,实际解析通过');
}

describe('更正内容形状 (合同 §3.25 `requestedChangeJson`;字段表由本刀补齐)', () => {
  // ===== ① 正对照 =========================================================
  describe('① 合规内容解析通过', () => {
    it('只改结果值', () => {
      const parsed = parseCorrectionChangeSet(changeSet());
      expect(parsed.results).toHaveLength(1);
      expect(parsed.results[0].recognizedContributionPoints).toBe(1.2);
      expect(parsed.segments).toHaveLength(0);
    });

    it('只改服务段', () => {
      const parsed = parseCorrectionChangeSet(
        changeSet({
          results: [],
          segments: [
            {
              participationIdentityId: 'identity-1',
              segmentKey: 'seg-0',
              checkInAt: '2020-03-01T01:00:00.000Z',
              checkOutAt: '2020-03-01T03:00:00.000Z',
              resultCode: 'valid',
              serviceHours: '2.00',
            },
          ],
        }),
      );
      expect(parsed.segments).toHaveLength(1);
      expect(parsed.segments[0].checkOutAt.toISOString()).toBe('2020-03-01T03:00:00.000Z');
    });

    it('零时长段(签到签退同刻)是合法形态', () => {
      const parsed = parseCorrectionChangeSet(
        changeSet({
          results: [],
          segments: [
            {
              participationIdentityId: 'identity-1',
              segmentKey: 'seg-0',
              checkInAt: '2020-03-01T01:00:00.000Z',
              checkOutAt: '2020-03-01T01:00:00.000Z',
              resultCode: 'early_departure_zero',
              serviceHours: '0.00',
            },
          ],
        }),
      );
      expect(parsed.segments[0].serviceHours).toBe(0);
    });
  });

  // ===== ② 形状层(逐条只拨一项)============================================
  describe('② 形状不合规一律拒绝', () => {
    it.each([
      ['不是对象', 'nope'],
      ['schemaVersion 不匹配', changeSet({ schemaVersion: 2 })],
      ['顶层多一个键', { ...changeSet(), extra: 1 }],
      ['顶层少一个键', { schemaVersion: CORRECTION_CHANGE_SCHEMA_VERSION, results: [] }],
      ['results 不是数组', changeSet({ results: {} })],
      ['结果项多一个键', changeSet({ results: [{ ...validResult(), extra: 1 }] })],
      ['结果项少一个键', changeSet({ results: [omit(validResult(), 'lateFlag')] })],
      ['空更正', changeSet({ results: [], segments: [] })],
    ])('%s ⇒ 拒绝', (_label, raw) => {
      expectRejected(raw);
    });

    it('同一个人被改两次 ⇒ 拒绝(否则"哪一条生效"取决于数组顺序)', () => {
      expectRejected(changeSet({ results: [validResult(), validResult()] }));
    });
  });

  // ===== ③ 取值层 =========================================================
  describe('③ 取值不合规一律拒绝', () => {
    it.each([
      ['resultCode 不在十值闭集', validResult({ resultCode: 'unknown' })],
      ['金额写成 number 而不是字符串', validResult({ recognizedContributionPoints: 1.2 })],
      ['金额多余小数位', validResult({ recognizedContributionPoints: '1.005' })],
      ['金额为负', validResult({ recognizedContributionPoints: '-1.00' })],
      ['时长超过 24 小时', validResult({ recognizedServiceHours: '25.00' })],
      ['lateFlag 不是布尔', validResult({ lateFlag: 'false' })],
      ['adjustmentReason 是空串', validResult({ adjustmentReason: '' })],
    ])('%s ⇒ 拒绝', (_label, result) => {
      expectRejected(changeSet({ results: [result] }));
    });

    it('🔴 多余小数位**不四舍五入**接受', () => {
      // `numeric(5,2)` 在 DB 侧对 1.005 是**静默归一**成 1.00(第 1 批已实测,不报错)
      // ⇒ 若这里放行,申请人写下的值与最终入账的值可以不同,而两边都没有任何提示。
      expectRejected(changeSet({ results: [validResult({ recognizedServiceHours: '4.005' })] }));
      // 正对照:两位以内照常通过。
      expect(
        parseCorrectionChangeSet(
          changeSet({ results: [validResult({ recognizedServiceHours: '4.50' })] }),
        ).results[0].recognizedServiceHours,
      ).toBe(4.5);
    });

    it('非 present 结果带非零金额 ⇒ 拒绝(补集写法,闭集扩展时 fail-closed)', () => {
      expectRejected(
        changeSet({
          results: [validResult({ resultCode: 'absent', recognizedContributionPoints: '1.20' })],
        }),
      );
      // 正对照:非 present 且金额全零照常通过。
      expect(
        parseCorrectionChangeSet(
          changeSet({
            results: [
              validResult({
                resultCode: 'absent',
                recognizedServiceHours: '0.00',
                recognizedContributionPoints: '0.00',
              }),
            ],
          }),
        ).results[0].resultCode,
      ).toBe('absent');
    });

    it('签退早于签到 ⇒ 拒绝', () => {
      expectRejected(
        changeSet({
          results: [],
          segments: [
            {
              participationIdentityId: 'identity-1',
              segmentKey: 'seg-0',
              checkInAt: '2020-03-01T03:00:00.000Z',
              checkOutAt: '2020-03-01T01:00:00.000Z',
              resultCode: 'valid',
              serviceHours: '2.00',
            },
          ],
        }),
      );
    });

    it('🔴 时刻只接受字符串:`null` 不得被 `new Date(null)` 解析成 1970-01-01', () => {
      // 本仓已栽过一次:`new Date(null)` = 1970-01-01,**不是** Invalid Date。
      expectRejected(
        changeSet({
          results: [],
          segments: [
            {
              participationIdentityId: 'identity-1',
              segmentKey: 'seg-0',
              checkInAt: null,
              checkOutAt: '2020-03-01T03:00:00.000Z',
              resultCode: 'valid',
              serviceHours: '2.00',
            },
          ],
        }),
      );
    });
  });
});

describe('更正审核人员隔离 (合同 §7.5)', () => {
  it('操作人 ≠ 提交人 ⇒ 放行', () => {
    expect(
      evaluateCorrectionReviewSeparation({ submittedByUserId: 'user-a' }, 'user-b'),
    ).toBeNull();
  });

  it('🔴 操作人就是提交人 ⇒ self_correction_review', () => {
    expect(evaluateCorrectionReviewSeparation({ submittedByUserId: 'user-a' }, 'user-a')).toBe(
      'self_correction_review',
    );
  });

  it('提交人为 null(结构上不可达)不否决 —— 与第四刀同一口径', () => {
    expect(evaluateCorrectionReviewSeparation({ submittedByUserId: null }, 'user-a')).toBeNull();
  });
});

function omit(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...source };
  delete copy[key];
  return copy;
}
