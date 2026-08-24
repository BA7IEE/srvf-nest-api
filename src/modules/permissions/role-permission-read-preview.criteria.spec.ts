import {
  MIN_BIZ_CODES,
  MIN_GATES,
  analyzeReadPreview,
  selfCheck,
} from '../../../scripts/check-role-permission-read-preview';

// P1-32 PR 4b(2026-08-24):「preview 与 PUT 的准入判定同源」的执行位。
//
// ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-role-permission-read-preview.ts`。**
//    那个文件在 selfGuard(`scripts/check-*.ts`)内,改松它要过红区人闸;
//    而 `src/**/*.spec.ts` 不在 selfGuard —— 把逻辑放这里等于没锁。
//    地板锚点、AST 扫描面、两条对照样本,全在那边。这条分工由
//    `scripts/check-criteria-spec-purity.ts` 机器执法。
//
// ─── 这条闸修的是哪一类缺陷 ────────────────────────────────────────────────
// `preview` 是第四个会回答「这次权限集变更能不能过」的入口(前三个已被 PR 4a 并成
// 一条写原语)。它若自己再算一遍,「预览说能过、真提交拒绝」或反过来都**没有任何症状**:
// 不报错、不变红、不留日志,只是管理员点了保存才发现,或者干脆放弃了一次合法变更。
//
// ⇒ 正解不是「让 preview 也调一遍那些闸」(那仍是两份序列,漂了照样无症状),
//   而是**只有一个判定序列**:两个公开方法各只有一句委托,唯一差别是最后一个参数。

describe('preview / PUT 同源 —— 自证(先证明仪器没瞎,再报数)', () => {
  const report = analyzeReadPreview();

  it('闸的扫描面、BizCode 全表、内建角色清单都不低于地板,反向探针仍是自定义角色,两条对照样本一正一反', () => {
    expect(selfCheck(report)).toEqual([]);
    expect(report.gateCount).toBeGreaterThanOrEqual(MIN_GATES);
    expect(report.bizCodeCount).toBeGreaterThanOrEqual(MIN_BIZ_CODES);
  });
});

describe('preview / PUT 同源 —— 准入判定只有一处', () => {
  const report = analyzeReadPreview();

  it('🔴 service 侧:同一委托 / 同一闸集合 / 闸不在分支里 / dry-run 出口在闸之后(违规即红并点名)', () => {
    expect(report.serviceViolations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });

  it('🔴 两侧可达的闸集合逐一相等(任一侧多一道或少一道即红)', () => {
    expect(report.previewGates).toEqual(report.writeGates);
  });

  it('🔴 controller 侧:两个端点的 @Body() 是同一个类、@RequiresPermission 逐字相同', () => {
    expect(report.controllerViolations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });

  it('presenter 只搬运不判断 —— 不许 import BizCode 值表(引到码表就能按码分类)', () => {
    expect(report.presenterViolations.map((v) => `${v.rule}: ${v.detail}`)).toEqual([]);
  });

  it('🔴 拦截原因在 BizCode **全表**上原样搬运(某个码被特殊处理 / 文案被重写即红并点名)', () => {
    expect(report.relayFailures.map((f) => `${f.code}: ${f.reason}`)).toEqual([]);
  });
});

describe('读面 editPolicy == 正在执法的谓词(两向)', () => {
  const report = analyzeReadPreview();

  it('🔴 每个内建角色都标成不可改且带只读原因码 —— 与 PR 3a 的 30108 闸同一口径', () => {
    expect(report.editPolicy.builtinMarkedEditable).toEqual([]);
    expect(report.editPolicy.builtinMissingReason).toEqual([]);
  });

  it('自定义角色不许被标成只读(反向:防「恒返回不可改」把正向断言变成空转)', () => {
    expect(report.editPolicy.customMarkedReadOnly).toEqual([]);
    expect(report.editPolicy.customHasReason).toEqual([]);
  });

  it('editPolicy 与角色分类三字段不许分家(canEdit ⟺ permissionManagementMode 可改)', () => {
    expect(report.editPolicy.disagreesWithClassification).toEqual([]);
  });
});
