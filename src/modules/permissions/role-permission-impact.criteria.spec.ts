import {
  MIN_CATALOG_ENTRIES,
  MIN_IMPACT_MODELS,
  MIN_NON_TRIGGERING_CODES,
  MIN_PROOF_EXPORTS,
  MIN_PROOF_REUSE_MUTATIONS,
  MIN_SAFE_DTO_SITES,
  MIN_TRIGGERING_CODES,
  PROOF_REUSE_MUTATIONS,
  analyzeRolePermissionImpact,
  checkProofFamilyForgery,
  checkStepUpProofReuse,
  selfCheck,
} from '../../../scripts/check-role-permission-impact';

// P1-32 PR 5(2026-08-24):「影响标注不许说谎 + step-up proof 不许复用」的执行位。
//
// ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-role-permission-impact.ts`。**
//    那个文件在 selfGuard(`scripts/check-*.ts`)内,改松它要过红区人闸;
//    而 `src/**/*.spec.ts` 不在 selfGuard —— 把逻辑放这里等于没锁。
//    事实矩阵、地板锚点、变异样本、AST 扫描面,全在那边。这条分工由
//    `scripts/check-criteria-spec-purity.ts` 机器执法。
//
// ─── 这条闸修的是哪三类缺陷 ──────────────────────────────────────────────
// ① **标了 EXACT 其实是估算**:响应形状对、字段齐全、没有报错,只是那个数是编的。
//    前端据此写「共影响 5 人」,而真值可能是 500。零症状。
// ② **step-up proof 能跨维度复用**:为角色 A / 旧 revision / 低风险 payload 申请的 proof
//    拿去做另一件事。三条是**三个独立维度**,任一条漏绑那一维就形同虚设 ——
//    所以三条**各自单独变异**,每个反面样本只在被测那一维上不同
//    (一次动两维时,另一维根本没绑也照样红,「红了」就证明不了这一维在守)。
// ③ **为了保险全都要 step-up**:没有假阳性对照时,把判定写成 `return true`
//    能让 ② 的三条变异全部通过 —— 那正是 DoD 第三条要防的实现倾向。

describe('影响预览与 step-up —— 自证(先证明仪器没瞎,再报数)', () => {
  const report = analyzeRolePermissionImpact();

  it('目录 / 高风险码 / 低风险码 / 事实矩阵 / 白名单扫描面都不低于地板', () => {
    expect(selfCheck(report)).toEqual([]);
    expect(report.risk.catalogSize).toBeGreaterThanOrEqual(MIN_CATALOG_ENTRIES);
    expect(report.risk.triggering.length).toBeGreaterThanOrEqual(MIN_TRIGGERING_CODES);
    expect(report.safeDtoSiteCount).toBeGreaterThanOrEqual(MIN_SAFE_DTO_SITES);
  });

  it('⭐ 假阳性对照本体:仍有足量权限码**不**触发二次验证(判定被写成恒 true 时当场红)', () => {
    expect(report.risk.nonTriggering.length).toBeGreaterThanOrEqual(MIN_NON_TRIGGERING_CODES);
  });

  it('⭐ 三条复用维度各有一条独立变异样本(用一条代替三条 = 上层边界遮蔽下层边界)', () => {
    expect(PROOF_REUSE_MUTATIONS.length).toBeGreaterThanOrEqual(MIN_PROOF_REUSE_MUTATIONS);
    expect(PROOF_REUSE_MUTATIONS.map((mutation) => mutation.dimension)).toEqual([
      'cross-role',
      'cross-revision',
      'cross-payload',
    ]);
  });
});

describe('影响标注不许说谎', () => {
  const report = analyzeRolePermissionImpact();

  it('🔴 标了 EXACT 就必须是精确数;被截断就必须标 PARTIAL 且是下界(逐条反算真值比对)', () => {
    expect(report.impactViolations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });

  it('🔴 影响查询只读本域(platform-access)自己的模型 —— 越界读一个即红并点名(归属从 domain-map 现取)', () => {
    expect(report.crossDomainViolations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
    expect(report.impactModels.foreign).toEqual([]);
    expect(report.impactModels.models.length).toBeGreaterThanOrEqual(MIN_IMPACT_MODELS);
  });

  it('🔴 分管源那个固定角色的 src 侧副本与 authz 判权链逐字一致,且仍是内建角色', () => {
    expect(report.supervisionViolations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });
});

describe('step-up proof —— 三条维度各自不可复用', () => {
  it('🔴 跨角色 / 跨 revision / 跨 payload 各必红,原样复用必须通过(真实签发 + 真实验签)', async () => {
    expect((await checkStepUpProofReuse()).map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });

  it('🔴 身份绑定族与配置变更族的 proof **双向**互相冒充不了(密钥域 + audience 隔离)', async () => {
    expect((await checkProofFamilyForgery()).map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });
});

describe('高风险触发面两向成立 —— 低风险不被无意义加重', () => {
  const report = analyzeRolePermissionImpact();

  it('🔴 该触发的都触发、不该触发的都不触发;目录外的码 fail-close;空差集不加重;授撤对称', () => {
    expect(report.riskViolations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });

  it('🔴 风险判定不许新造分级 —— 策略文件里不得出现权限码字面量', () => {
    expect(report.secondScaleViolations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });

  it('payload 指纹:乱序去重同指纹 / 集合不同必不同 / 无随机量', () => {
    expect(report.payloadHashViolations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });

  it('🔴 两族 proof 的密钥域 / audience 逐字不同,且 action 字面量两处一致(并回同一把钥匙 = 身份 proof 能改权限集)', () => {
    expect(report.familyIsolationViolations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });

  it('域中立层那个 proof 文件只装这一件事(导出面命名;挡漂移不挡蓄意规避)', () => {
    expect(report.proofFileViolations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
    expect(report.proofExports.exported.length).toBeGreaterThanOrEqual(MIN_PROOF_EXPORTS);
  });
});

describe('step-up 的射程登记 —— 缺口必须在机器上可见', () => {
  const report = analyzeRolePermissionImpact();

  it('🔴 PUT 与 preview 都可达 step-up 闸,且闸不在分支里', () => {
    expect(report.jurisdiction.inScopeReach).toEqual({ replace: true, previewReplace: true });
    expect(report.jurisdiction.gateIsConditional).toBe(false);
  });

  it('🔴 旧增量端点 assign / revoke **不受管辖**(登记在案的真实缺口),且它们仍在并经唯一写原语落库 —— PR 8 退役它们时本条必红,强制重看登记', () => {
    expect(report.jurisdiction.outOfScopeReach).toEqual({ assign: false, revoke: false });
    expect(report.jurisdiction.legacyEntriesStillWired).toEqual({ assign: true, revoke: true });
    expect(report.jurisdictionViolations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });

  it('影响查询只在 preview 侧,不进写路径(冻结稿风险表「只在 preview 执行」)', () => {
    expect(report.jurisdiction.impactQueryUsers).toEqual(['previewReplace']);
  });

  it('🔴 step-up 签发端点的显式字段白名单与 DTO 字段集逐一相等(漏一个字段会被静默丢弃且零报错)', () => {
    expect(report.dtoWhitelistViolations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });
});
