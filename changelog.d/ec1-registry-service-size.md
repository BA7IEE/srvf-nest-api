### Added

- 尺寸棘轮登记入 `harness/ratchet-registry.json`(EC-1 达成,PR-B):新增 `service-size` 条目(`kind: numeric-monotonic` / `metric: loc`),`eslint.harness.mjs` 按 kind 分流(数值型不进 `RATCHET_BASELINES`、不生成任何 ESLint 豁免块)。至此 `ratchet-registry.json` 的 `_comment` 自称「全仓所有单调基线的唯一登记处」名副其实 —— 此前它只装得下 ESLint 规则型。尺寸基线的单调性(每个 file 的 loc 只减不增 + 不得新增 file)自本 PR 起由 base-trusted 裁判守。既有三条棘轮一个字节未改。
