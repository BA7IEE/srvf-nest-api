### Added

- **队员 360 统一保险概览**：新增 `GET /api/admin/v1/members/:memberId/insurances/overview`，一次返回个人自购保险、团队保险安全投影与按北京当前日派生的汇总；复用既有 scoped-authz 权限与审计事件，旧保险列表/审核、资格 gate 及 App 契约不变。
