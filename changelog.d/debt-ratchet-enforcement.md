### Added

- 架构债棘轮接上执行位:新增 `pnpm docs:boundaries:newdebt:check`,判据为「本次扫描出的每条 finding,其 `callSiteId` 或 `legacyCallSiteId` 必须已在 `harness/architecture-debt-baseline.json` 中」,已接进 CI 且**无 `|| true`**。此前 v4 §6 元规则「禁新增代码债」零执法 —— 既有的 `docs:boundaries:debt:check` 自述 `registry-integrity-only`(只校验已登记条目的语义字段,从不与扫描结果比对),而产出 findings 的 `docs:boundaries` 带 `|| true`;实测 641 条 finding 里 412 条不在台账中,登记与否对 CI 毫无影响。基线同时登记为 `set-monotonic` 棘轮,由 base-trusted 裁判守「集合只减不增」。
