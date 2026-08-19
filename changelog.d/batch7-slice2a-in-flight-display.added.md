### Added

- 活动业务改造 v1.1 第 7 批第 ②-a 刀:队员参与统计的三条读面
  (`GET /api/app/v1/my/participation-summary`、
  `GET /api/admin/v1/members/:memberId/participation-summary`、
  `GET /api/admin/v1/members/:memberId/contribution-summary`)
  新增 `ledgerTotals` 对象,并排给出账本口径的**已生效 / 在途**两轴
  (`committedServiceHours` / `committedContributionPoints` /
  `inFlightServiceHours` / `inFlightContributionPoints`)。
  **既有四个数字**(总服务时长 / 参与活动数 / 记录条数 / 贡献值)的取数、口径、字段名
  **一个字未动** —— 仍是 approved 考勤口径;真正切换取数是 ②-b,需另行拍板。

  「在途」取**直查法**:分录所属批次停在 `preparing` / `ready` 的那部分。差值法
  (总数 − 已生效)被否掉,因为冲正已入账而重记仍在途时它会算出负数,且它相减的是
  两张不同的表,会把口径漂移当成在途报出来。与已生效那一轴的互斥是**结构性**的
  (一条分录一个批次,一个批次一个状态),不靠约定。

  🔴 实测结论:「已生效 + 在途 = 总数」**不成立**(实测 1.5 + 3.5 = 5 ≠ 4)。两条独立原因:
  批次要到终审才存在,「考勤已审批但结算未终审」那一段两轴都不计;且四个数字按考勤记录算、
  两轴按账本分录 delta 算。故本刀**不合并数字**,三个口径并排摆出、各自标签清楚。

  合同 §3.22 的分录级不可见性**一寸未让**:新方法只返回标量小计,不返回任何分录行
  (无 entryKey / 无日期 / 无逐条金额),既有三条分录读面仍是全仓唯一出口且仍钉死
  `committed`;`ledger-query.service.ts` 的 7 处 committed 过滤一处未改,也没有引入
  `includeUncommitted` 之类的开关。四个数由**全仓唯一入口** `loadMemberLedgerTotals`
  计算,三条读面口径一致是结构性的而非靠各自记得调同一个方法。
  零新增权限码、零 schema、零 migration、零新增端点。
