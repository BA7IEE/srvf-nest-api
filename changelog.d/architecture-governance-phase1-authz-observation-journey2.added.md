### Added

- 架构治理 Phase 1：`AuthzDeclarationGuard` 在 report 模式启动时输出静态未声明路由总数，并与按流量观察到的未声明路由数并列记录；两者均不参与任何判权决定。
- 新增旅程②当前真实部分链“活动→报名→审批→签到”，以 `ActivityCheckIn` 证据和签到重试幂等性守护；结算至贡献值账本因缺少 `AttendancePunchEvent` 生产写入口具名登记，待该入口合入 main 后扩展。
