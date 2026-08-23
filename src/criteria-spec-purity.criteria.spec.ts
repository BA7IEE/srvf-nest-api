import {
  ALL_RULES,
  CONTROL_IMPURE_RUNNER,
  CONTROL_PURE_RUNNER,
  MIN_CRITERIA_SPECS,
  analyzeCriteriaSpecPurity,
  analyzeSource,
  selfCheck,
} from '../scripts/check-criteria-spec-purity';

/**
 * 「判据类闸的实质逻辑不得放在无保护的 spec 里」类闸。
 *
 * ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-criteria-spec-purity.ts`。**
 *    那个文件在 selfGuard(`scripts/check-*.ts`)内,改松它要过红区人闸。
 *    本文件存在的唯一理由是让 `pnpm test`(CI 里跑)自动收它,免掉一份 CI 接线。
 *
 * 🔴 本文件自己也在本闸的管辖内(它叫 `*.criteria.spec.ts`)—— 这是刻意的:
 *    「守护判据纯度的那份判据」若自己夹带逻辑,就没资格要求别人纯。
 *
 * 修的是**缺陷类**不是实例:不点名今天这八条,而是问「`src/` 下每一个
 * `*.criteria.spec.ts` 是不是薄运行器」。下一条判据写成夹带扫描逻辑的形态时,
 * 本闸当场红并点名到行号与规则。
 */
describe('criteria spec purity', () => {
  const report = analyzeCriteriaSpecPurity();

  // ===========================================================================
  // 自证:先证明仪器没瞎,再报数
  //
  // 「扫描面为空 ⇒ 零违规 ⇒ 全绿」是本仓已登记的假绿形状 —— 对本闸尤其致命,
  // 因为把判据整族改名(`*.gate.spec.ts`)就能让发现面塌成 0。地板锚点堵这条路。
  // ===========================================================================

  it('self-proves the scan surface is non-empty and both controls still fire', () => {
    expect(selfCheck(report)).toEqual([]);
    expect(report.scanned.length).toBeGreaterThanOrEqual(MIN_CRITERIA_SPECS);
  });

  it('includes its own runner in the scanned surface', () => {
    // 本文件必须在管辖内 —— 否则「守护者豁免自己」,而那正是本刀要修的形状。
    expect(report.scanned).toContain('src/criteria-spec-purity.criteria.spec.ts');
  });

  // ===========================================================================
  // 对照:假阳性 / 真阳性各一条
  //
  // 假阳性对照是**本闸可用性的前提**:它若把正确形态也判成违规,人只会把闸关掉。
  // ===========================================================================

  it('passes a pure thin runner — the correct shape must stay green', () => {
    expect(analyzeSource('control.criteria.spec.ts', CONTROL_PURE_RUNNER)).toEqual([]);
  });

  it('flags every rule on a runner that carries judgement logic', () => {
    const hit = analyzeSource('control.criteria.spec.ts', CONTROL_IMPURE_RUNNER);

    expect([...new Set(hit.map((violation) => violation.rule))].sort()).toEqual(ALL_RULES);
  });

  // ===========================================================================
  // 主断言
  // ===========================================================================

  it('keeps every criteria spec a thin runner', () => {
    // 违规条目自带 file / line / rule / detail,报错直接告诉人搬哪去。
    expect(report.violations).toEqual([]);
  });
});
