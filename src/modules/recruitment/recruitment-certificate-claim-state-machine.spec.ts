import { RecruitmentCertificateClaimStatus as S } from '@prisma/client';
import { BizException } from '../../common/exceptions/biz.exception';
import {
  APP_STATUS_PENDING_EVALUATION,
  APP_STATUS_PUBLICITY,
  APP_STATUS_VERIFIED,
  assertApplicantMayMutate,
  assertClaimTransitionAllowed,
  assertClaimVersionMatches,
  claimContributesToThreshold,
  deriveSatisfiedCertificateCategories,
  recalcApplicationStatusForThresholds,
} from './recruitment-certificate-claim-state-machine';

// 证书标准库 PR-4a-1:招新证书申报纯规则的**穷举**单测(零 DB / 零 mock)。
// 与 certificate-standard-policy.spec 同款理由:状态机 6×6 全枚举后,
// 任何人放开一格都会红。

const ALL = [S.SUBMITTED, S.NEEDS_INFO, S.APPROVED, S.REJECTED, S.PROMOTED, S.WITHDRAWN] as const;

function expectBiz(fn: () => void, code: number): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BizException);
    expect((err as BizException).biz.code).toBe(code);
    return;
  }
  throw new Error(`期望抛 BizCode ${code},但没有抛`);
}

describe('recruitment-certificate-claim 状态机与门槛派生(纯规则)', () => {
  // ============ §8.2 状态机 6×6 全枚举 ============
  describe('assertClaimTransitionAllowed — 36 格全枚举', () => {
    // 逐条对应 §8.2。WITHDRAWN 是每个非终态的合法出口(整份报名撤销时批量转)。
    const ALLOWED = new Set([
      'SUBMITTED>NEEDS_INFO',
      'SUBMITTED>APPROVED',
      'SUBMITTED>REJECTED',
      'SUBMITTED>WITHDRAWN',
      'NEEDS_INFO>SUBMITTED',
      'NEEDS_INFO>WITHDRAWN',
      'REJECTED>SUBMITTED',
      'REJECTED>WITHDRAWN',
      'APPROVED>PROMOTED',
      'APPROVED>SUBMITTED', // 撤回审核(§8.2 末段的独立动作)
      'APPROVED>WITHDRAWN',
    ]);

    for (const from of ALL) {
      for (const to of ALL) {
        const key = `${from}>${to}`;
        const allowed = ALLOWED.has(key);
        it(`${key} → ${allowed ? '放行' : '拒(28057)'}`, () => {
          if (allowed) {
            expect(() => assertClaimTransitionAllowed(from, to)).not.toThrow();
          } else {
            expectBiz(() => assertClaimTransitionAllowed(from, to), 28057);
          }
        });
      }
    }

    it('PROMOTED 是终态:任何出口都拒(已生成正式证书,回退会让档案与申报脱钩)', () => {
      for (const to of ALL) {
        expectBiz(() => assertClaimTransitionAllowed(S.PROMOTED, to), 28057);
      }
    });

    it('WITHDRAWN 是终态:任何出口都拒(要重来就新建一条,一证一行不复用)', () => {
      for (const to of ALL) {
        expectBiz(() => assertClaimTransitionAllowed(S.WITHDRAWN, to), 28057);
      }
    });

    it('撤回审核走 APPROVED→SUBMITTED 而非 →NEEDS_INFO', () => {
      expect(() => assertClaimTransitionAllowed(S.APPROVED, S.SUBMITTED)).not.toThrow();
      // 撤回是「审核结论错了」不是「材料不足」,不该给申请人推补材料通知。
      expectBiz(() => assertClaimTransitionAllowed(S.APPROVED, S.NEEDS_INFO), 28057);
    });
  });

  // ============ 申请人可动范围 ============
  describe('assertApplicantMayMutate', () => {
    it('SUBMITTED / NEEDS_INFO / REJECTED 可动', () => {
      for (const s of [S.SUBMITTED, S.NEEDS_INFO, S.REJECTED] as const) {
        expect(() => assertApplicantMayMutate(s)).not.toThrow();
      }
    });

    it('APPROVED 不可由申请人直接改(§8.2 明列);PROMOTED / WITHDRAWN 同拒', () => {
      for (const s of [S.APPROVED, S.PROMOTED, S.WITHDRAWN] as const) {
        expectBiz(() => assertApplicantMayMutate(s), 28057);
      }
    });
  });

  describe('assertClaimVersionMatches(CAS)', () => {
    it('相等放行;不等 28058', () => {
      expect(() => assertClaimVersionMatches(3, 3)).not.toThrow();
      expectBiz(() => assertClaimVersionMatches(2, 3), 28058);
      expectBiz(() => assertClaimVersionMatches(4, 3), 28058);
    });
  });

  // ============ §8.4 门槛派生 ============
  describe('deriveSatisfiedCertificateCategories', () => {
    it('APPROVED 与 PROMOTED 都计入;其余状态不计', () => {
      expect(claimContributesToThreshold(S.APPROVED)).toBe(true);
      expect(claimContributesToThreshold(S.PROMOTED)).toBe(true);
      for (const s of [S.SUBMITTED, S.NEEDS_INFO, S.REJECTED, S.WITHDRAWN] as const) {
        expect(claimContributesToThreshold(s)).toBe(false);
      }
    });

    it('🔴 同类别两条:拒掉一条**不清除**另一条已通过带来的门槛(§8.4 第一条推论)', () => {
      const satisfied = deriveSatisfiedCertificateCategories([
        { status: S.APPROVED, categoryCode: 'first_aid' },
        { status: S.REJECTED, categoryCode: 'first_aid' },
      ]);
      expect(satisfied.has('first_aid')).toBe(true);
    });

    it('全部非贡献状态 → 该类别不满足', () => {
      const satisfied = deriveSatisfiedCertificateCategories([
        { status: S.SUBMITTED, categoryCode: 'bsafe' },
        { status: S.REJECTED, categoryCode: 'bsafe' },
        { status: S.WITHDRAWN, categoryCode: 'bsafe' },
      ]);
      expect(satisfied.has('bsafe')).toBe(false);
    });

    it('未解析 Standard(categoryCode=null)不计 —— 只认审核结论,不认申请人提示', () => {
      const satisfied = deriveSatisfiedCertificateCategories([
        { status: S.APPROVED, categoryCode: null },
      ]);
      expect(satisfied.size).toBe(0);
    });

    it('多类别各自独立聚合', () => {
      const satisfied = deriveSatisfiedCertificateCategories([
        { status: S.APPROVED, categoryCode: 'first_aid' },
        { status: S.PROMOTED, categoryCode: 'bsafe' },
        { status: S.SUBMITTED, categoryCode: 'other' },
      ]);
      expect([...satisfied].sort()).toEqual(['bsafe', 'first_aid']);
    });

    it('空集合 → 空结果', () => {
      expect(deriveSatisfiedCertificateCategories([]).size).toBe(0);
    });
  });

  // ============ §8.4 报名状态随门槛重算 ============
  describe('recalcApplicationStatusForThresholds', () => {
    it('全部完成:verified → pending_evaluation', () => {
      expect(recalcApplicationStatusForThresholds(APP_STATUS_VERIFIED, true)).toEqual({
        nextStatus: APP_STATUS_PENDING_EVALUATION,
        mustClearEvaluation: false,
      });
    });

    it('全部完成:pending_evaluation 保持不动', () => {
      expect(recalcApplicationStatusForThresholds(APP_STATUS_PENDING_EVALUATION, true)).toEqual({
        nextStatus: APP_STATUS_PENDING_EVALUATION,
        mustClearEvaluation: false,
      });
    });

    it('全部完成:publicity 留在 publicity(不把已公示的人拉回评定队列)', () => {
      expect(recalcApplicationStatusForThresholds(APP_STATUS_PUBLICITY, true)).toEqual({
        nextStatus: APP_STATUS_PUBLICITY,
        mustClearEvaluation: false,
      });
    });

    it('变为未完成:pending_evaluation → verified', () => {
      expect(recalcApplicationStatusForThresholds(APP_STATUS_PENDING_EVALUATION, false)).toEqual({
        nextStatus: APP_STATUS_VERIFIED,
        mustClearEvaluation: false,
      });
    });

    it('🔴 变为未完成:publicity → verified **且必须清评定字段**', () => {
      expect(recalcApplicationStatusForThresholds(APP_STATUS_PUBLICITY, false)).toEqual({
        nextStatus: APP_STATUS_VERIFIED,
        mustClearEvaluation: true,
      });
    });

    it('变为未完成:verified 保持 verified,且不需要清评定', () => {
      expect(recalcApplicationStatusForThresholds(APP_STATUS_VERIFIED, false)).toEqual({
        nextStatus: APP_STATUS_VERIFIED,
        mustClearEvaluation: false,
      });
    });

    it('门槛波及不到的状态一律原样返回(发号后门槛不可再动;已拒/已撤不被拉回流程)', () => {
      for (const s of [
        'pending_verification',
        'manual_review',
        'rejected',
        'withdrawn',
        'promoted',
      ]) {
        for (const complete of [true, false]) {
          expect(recalcApplicationStatusForThresholds(s, complete)).toEqual({
            nextStatus: s,
            mustClearEvaluation: false,
          });
        }
      }
    });
  });
});
