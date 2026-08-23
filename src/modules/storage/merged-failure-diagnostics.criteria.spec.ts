import {
  analyzeMergedDiagnostics,
  pinnedDiagnosticsRegressions,
  selfCheck,
} from '../../../scripts/check-merged-failure-diagnostics';

// P2-8(2026-08-23):「把不同失败原因合并成一句话」类闸 —— 执行位。
//
// ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-merged-failure-diagnostics.ts`。**
//    那个文件在 selfGuard(`scripts/check-*.ts`)内,改松它要过红区人闸;
//    而 `src/**/*.spec.ts` 不在 selfGuard —— 把逻辑放这里等于没锁。
//    三张失败分类词表、AST 扫描器、地板锚点、四条内联样本对照,全在那边。
//
//    ⚠️ 本闸落地时(P2-8)曾在 changelog 里写明「判据放 spec 是为了省红区授权」——
//    **那条理由是错的**,同日已被 P2-13 订正:`scripts/**` 整个不进 ROUTE_AUTHZ 的
//    inputDigest,省授权是空好处;而 spec 不在 selfGuard,判据任何 PR 都能改松。
//
// ─── 这条闸修的是哪一类缺陷 ────────────────────────────────────────────────
// 一个 `try` 覆盖了两个**下一步动作不同**的失败原因,`catch` 却只抛一句话。
// 运维拿到的那句话指向错误的排查方向,时间就白付了。
//
// 实例(2026-08-20 第二阶段真机部署实测):`storage-settings-bootstrap.ts` 曾把
// `readFileSync()` 与 `JSON.parse()` 放进同一个 `try`,统一抛「config-file 不是合法
// JSON」。config-file 按安全要求设 600 root:root、而 runner 镜像是 USER node(uid 1000)
// ⇒ **EACCES 被报成 JSON 语法错误**,照着错误信息白查一轮。
//
// ─── 判据不是「今天这处拆开了」,而是「合回去必须红」 ──────────────────────
// 发现面是**结构性扫 AST**,不写死行号、不点名函数。
//
// 🔴 分类轴取「下一步动作」而不是「会不会抛」—— 因为**令牌校验路径合并失败原因是
//    安全特性不是缺陷**(分开报「base64 坏了」与「签名不对」= 给攻击者送预言机)。
//    取对了轴,那批路径的调用全是内容类、不跨类 ⇒ 零豁免即判绿。
describe('merged failure diagnostics (storage module)', () => {
  const report = analyzeMergedDiagnostics();

  // ==========================================================================
  // 自证 + 正 / 反对照
  //
  // 「扫描面为空 ⇒ 零违规 ⇒ 全绿」是本仓已登记的假绿形状。地板锚点全部是受保护
  // 文件里的具名常量;四条内联样本(合并 / 拆开 / 单因 / 带 cause)的对照也在
  // selfCheck 里跑 —— 判据自己的变异对拍**跟着判据一起活**,不靠某次手工变异的记忆。
  // ==========================================================================

  it('self-proves the surface, the classifier and all four inline controls', () => {
    expect(selfCheck(report)).toEqual([]);
  });

  // ==========================================================================
  // 主断言
  // ==========================================================================

  it('has no catch that merges an environment failure with a content failure', () => {
    expect(report.violations).toEqual([]);
  });

  it('leaves no failure source unclassified in multi-source catches', () => {
    // 词表不认识的调用不许静默放行 —— 那正是「至少一处」型判据失明的起点。
    expect(report.classificationGaps).toEqual([]);
  });

  // ==========================================================================
  // 定点回归锚:P2-8 这处**具体**的修法不许被回退
  //
  // 上面的类闸管「不许合并」,这一条管「这处确实拆成了两句**不同**的话」——
  // 类闸对「拆开了但两句话写成一样」是失明的。
  // ==========================================================================

  it('reports read failure and parse failure as two different messages', () => {
    expect(pinnedDiagnosticsRegressions(report)).toEqual([]);
  });
});
