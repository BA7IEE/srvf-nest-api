### Changed

- R15 判据① 的 6 条存量违规(`src/common/prisma/claim-at-status.util.ts` 在 `$queryRaw` 里硬编码 6 张业务物理表,跨 participation / credentials / engagement 三域)按 per-call-site 身份登记进架构债务台账,classification `common-business-table`。此前只有一条「计数钉」(selftest 把发现数钉在 6),能抓住**新增**但抓不住**换掉** —— 删一条又新增另一条时计数仍是 6。登记后 `callSiteId` 逐条对账,换掉即红。
- `runMigrateIds`(`docs:boundaries:ids:check`)的活跃 call site 集合并上 R15 的 `commonFindings`。`--violations` 把 common 单独成块是为了不污染 `edgeUsage` / `readTiers` 的读数,而身份对账问的是「每条登记在案的 call site 是否还活着」,本就该覆盖全部已登记债务;不合并则登记 R15 债务会把该闸打红(实测退出码 1)。既有 21 条域级记录的 `notApplicable` 归属与全部读数逐字节不变。
