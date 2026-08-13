### Added

- 前端 TS client 覆盖全部五个 surface(admin / app / auth / system / open),不再只出 admin 与 app —— 部分生成会让剩下那部分回到手写,等于制造第二份真相。跨 surface 共用的类型(envelope、分页、传输层契约、被 ≥2 个 surface 引用的 DTO)统一落 `docs/handoff/clients/shared/types.ts`,各 surface 引入并再导出;共用集由生成器**算出**而非硬编码,全仓零重复定义由 harness selftest 机核。
