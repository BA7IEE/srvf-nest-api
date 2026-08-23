import {
  analyzeSeedDescriptionAuthority,
  selfCheck,
} from '../../../scripts/check-seed-description-authority';

// P2-15(2026-08-23):`Permission.description` 的 seed 单向权威 —— 执行位。
//
// ⚠️ **本文件只是薄运行器,实质逻辑在 `scripts/check-seed-description-authority.ts`。**
//    那个文件在 selfGuard(`scripts/check-*.ts`)内,改松它要过红区人闸;
//    而 `src/**/*.spec.ts` 不在 selfGuard —— 把逻辑放这里等于没锁。
//    AST 扫描器、两族地板锚点、四个合成样本对照,全在那边。
//
// ─── 这条闸修的是哪一类缺陷 ────────────────────────────────────────────────
// `Permission.description` 的权威源是代码常量 `RbacPermissionSeed.description`。
// DB 与代码分叉有两条路:
//   V1 运行时 `PATCH /permissions/:id` 改 DB   → ✅ 已关(P1-32 PR 3b,30110)
//   V2 改代码里的字符串,seed 的 `update: {}` 保证既有库永远收不到 → 🔴 本闸的靶子
//
// ⚠️ V2 这类漂移**零症状**:没有任何测试、任何检查会因为它变红。
//
// ─── 判据的职责不是当期快照 ────────────────────────────────────────────────
//   🔴 **将来任何一处新的 `permission.upsert`,不覆盖 description 就进不了主干。**
// 所以发现面是**结构性扫 AST 调用**,不写死 4 处、不按行号。
//
// ─── ⭐ 反向锚点:字典**故意**不跟着改 ──────────────────────────────────────
// `dictType` / `dictItem` 的 `update: {}` 与权限的**语义已经分岔**:字典运营本就该能
// 运行时改(是功能),seed 不得回退。下一个人很可能把字典当成「漏改」顺手统一 ——
// **正向的破坏会被人发现(文案不更新);反向的破坏零症状。**
// 所以反向锚点比正向那条更重要,不是补充。
describe('seed description 权威判据 —— 自证(仪器先过体检)', () => {
  const report = analyzeSeedDescriptionAuthority();

  it('源码非空、两族扫描面不低于地板、扫描器分辨得出 model、合成样本读数正确', () => {
    // 四个合成样本(正样本 / update:{} / 写死字面量 / 注释噪声)都在 selfCheck 里 ——
    // 「尺子自己也要验」:AST 退化成文本匹配时,注释噪声那条会当场红。
    expect(selfCheck(report)).toEqual([]);
  });
});

describe('seed description 权威判据 —— 正向(代码常量单向成为权威)', () => {
  const report = analyzeSeedDescriptionAuthority();

  it('🔴 每一处 prisma.permission.upsert 的 update 都含 description(新增一处不带即红并点名)', () => {
    expect(report.permissionOffenders).toEqual([]);
  });
});

describe('seed description 权威判据 —— 反向锚点(字典刻意不跟着改)', () => {
  const report = analyzeSeedDescriptionAuthority();

  it('🔴 每一处 dictType / dictItem upsert 仍是 update: {}(被顺手统一即红并点名)', () => {
    expect(report.dictOffenders).toEqual([]);
  });
});
