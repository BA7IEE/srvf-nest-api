### Added

- 架构治理 R15 落地:`src/common` 纳入边界扫描,新增三条 report-only 判据 —— 业务 Prisma 访问(delegate ∪ raw 物理表)、业务谓词(状态 ∧ 时间窗内联组合)、`common → src/modules` 入边。此前 `src/common/**` 因 `moduleOf()` 只认 `src/modules/` 而在扫描主循环第一行即被跳过,是所有边界规则的共同逃生通道。当前发现数 6 / 0 / 0,全部为 report,不改变任何业务行为。
- `harness/domain-map.json` 的 `kernel.primitives` 登记 `member-advisory-lock`(owner = `identity-org`):共享业务内核必须显式登记归属,不因放在 `src/common` 而免除。
