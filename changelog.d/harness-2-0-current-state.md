### Harness 2.0 · PR3 current-state 全指针化(#TBD)

- `docs/current-state.md` 重写为全指针形态(151 行 ≈8.9 万字符 → ≤4,500 字符):§1 计数块由 `pnpm docs:counts` 生成并接线锚点(`docs:counts:check` 转严格校验);§2 历史能力叙事全部删除,事实指向 CHANGELOG / handoff / live swagger / CODEMAP / RBAC_MAP;§3 暂不启动与 §4 债务保留全部条目、压缩叙事(来龙去脉见 `archive/harness-v1/current-state.md` 快照与各冻结评审稿)
- `docs:readtax:check` 对 current-state 翻 `enforced=true`(首个硬判文件);counts 块行标签精简以适配预算
