### Added

- 架构治理 Phase 1：新增 R8 权限声明↔实现闭环的 report-only ESLint 扫描。它消费 Route Authorization Policy 与断言模式的生成物，覆盖 T1 handler、T2 同模块一层 service、别名/中转及 `require:any` 全部声明 OR 分支；超出可判边界的路径如实报告为 T3 候选。
