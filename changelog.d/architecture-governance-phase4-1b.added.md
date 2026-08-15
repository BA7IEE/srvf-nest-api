### Added

- **架构治理 Phase 4-1b:状态机 `governed` 声明闸**(R10)。`harness/state-machines.json` 的
  `governanceStatus` 从此可取 `inventory | governed`,并由 `pnpm docs:boundaries:check` 把关 ——
  声明 `governed` 必须附 `governedEvidence`,拿不出证据即拒(fail-closed)。
  门槛按层分叉:**L1 配置列**要求闭集能从在册 migration 的 DB CHECK 原样重算且未被后续 `DROP`;
  **L2/L3 流程列**要求具名实现模块存在、符号真在文件里、迁移边逐条与模块字面量双向对账、
  wrong-state BizCode 真实存在。判据先守**边与实现映射**而非闭集 —— 4-1a 实测闭集已有 34/56
  被 DB 兜住,而边有 20 条零机器声明,只比闭集会恒真通过(空绿)。
  本轮升 `governed` 8 条(全为 L1 零 blocker 配置列),L3 一条不升;其余 48 条仍 `inventory`。
  `pnpm docs:boundaries` 新增 `stateGovernance` 报告块(恒 report-only)。
  零 `src/**` / `prisma/**` 改动,无行为变更。
