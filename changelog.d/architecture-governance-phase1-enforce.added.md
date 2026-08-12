### Changed

- 架构治理 Phase 1：在 red-first HTTP E2E 证明无声明路由会于 handler 前以
  `AUTHZ_UNDECLARED` 拒绝后，`AuthzDeclarationGuard` 从 report 切换为 enforce；回滚仅需将同一开关改回 report。
