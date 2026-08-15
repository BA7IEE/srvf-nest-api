### Added

- 债务台账语义完整性检查 `pnpm docs:boundaries:debt:check` 接入 CI **Fast checks** 既有的 `Architecture governance A-metadata gate` 步骤,**不新增 required context**。定为 **blocking**(A 类 registry integrity,判台账不判代码,与同步骤的 `:check` / `:ids:check` 同类):断言 `harness/architecture-debt.json` 每条债务都填满 7 个语义字段(`classification` / `reason` / `risk` / `desiredExit` / `ownerApiTarget` / `reviewTrigger` / `introducedAt`)且不残留 `pending-phase2` 占位。此前该命令**存在于 package.json 却未接任何 CI**,而它是 `semanticFieldsComplete` 的唯一执法者(`--violations` 被 `|| true` 兜住、`--metadata` 的 errors 只装 domain-map 元数据、`:ids:check` 管的是 call-site 身份)——即该不变量此前零执法。真触发已验证:清空 `XW-0001` 的 `desiredExit` 则门 exit 1 并点名 `XW-0001 missing semantic fields: desiredExit`,还原后 exit 0;当前 222/222 通过。

### Fixed

- `scripts/check-boundaries.ts` 的 `--debt-check` 输出中 `reportOnly` 由 `true` 改正为 `false`——原值与紧接其后的 `process.exitCode = 1` 自相矛盾,只因该命令此前未接 CI 而一直没人撞上(既不阻断也不被跑)。`--violations` 那处的 `reportOnly: true` 是正确的,未改。
