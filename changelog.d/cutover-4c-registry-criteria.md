### 合同 ④ 判据收编:登记表判据挪进红区 scripts + cutover:check 新增 ④-c(A 类)与四个对拍读数

P2-23a/b 的两份登记表判据(#1202 / #1203)首发时是零红区形态:逻辑住 `src/**` spec,
**任何 PR 能零授权删掉或改松它**。维护者 2026-08-27 发令牌收编(与 ④-b 接线同刀):

- **判据本体进红区**:`scripts/check-dictionary-seed-registry.ts` +
  `scripts/check-audit-event-registry.ts`(selfGuard `scripts/check-*.ts` glob 自动覆盖,
  无需改 redzone 清单);两个 spec 降为**薄运行器**(真读数 + 常驻变异对拍 M1–M6,
  35/35 通过)。脚本带 CLI:`pnpm exec tsx scripts/check-*-registry.ts`。
- **`cutover:check` ④ 新增 4-c(A 类)**「字典与 Audit events 登记表:双向对拍判红」,
  判据引用红区脚本本体;正对照 4c(审计计数被改 ⇒ 必红且点名 `auth.login`)+ 4c′(真源 ⇒ 必绿)。
  4-b(C 类)证据行同步改写:从「没有登记表」的旧事实改为指向 ④-c 与五个对拍读数。
- **签字对拍读数 +4**:`dict-registry-types`(28)/ `dict-registry-items`(242)/
  `audit-event-registry-total`(147)/ `audit-event-registry-active`(142),计数型
  (提取塌了给 -1 ⇒ `judgeSignoffReadings` 当场红,不会静默挂旧签字)。
  增删任何字典项 / 审计事件 ⇒ 读数变 ⇒ ④-b 须重签 —— 维护者随本刀重签即可升「已逐条核对」。

核验:cutover 全量 + `--signoff` 双模式本地绿;`harness:selftest` 68/0;
`pnpm lint` / typecheck / 两个薄运行器 35/35 绿。P2-22 那刀的同款升级仍待其自身立项。
