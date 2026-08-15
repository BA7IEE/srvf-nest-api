### Changed

- 架构治理 Phase 4-1a:`harness/state-machines.json` 的 56 条状态列登记补全为逐条含 `layer`(L1 配置 13 / L2 简单流程 19 / L3 复杂流程 24)、`stateSet`(含真值来源)、`transitions`、`wrongStateBizCode`、`implementation` 与 `governedBlockers`;**`governanceStatus` 全部仍为 `inventory`**,不构成治理承诺。新增现状报告 [`docs/ai-harness/STATE_MACHINE_INVENTORY.md`](docs/ai-harness/STATE_MACHINE_INVENTORY.md)。**零执行位**:未新增任何检查,未改 `check-boundaries.ts` / `action-state-checks.ts`,未回填 DB CHECK,未升任何条目为 `governed`。

  主要读数:24 条 L3 里**仅 6 条有专属状态机**;最普遍缺口为 `no-wrong-state-bizcode`(25)/ `no-db-check`(22)/ `edges-not-derived`(20)/ `no-state-machine`(18);8 个既有状态机分属 5 种形状、零共享抽象,其中 2 个治理的是 Prisma `enum` 列而登记表只收 `String` 列 —— 结构上装不下。
