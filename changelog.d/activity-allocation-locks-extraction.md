### Changed

- 活动名额分配抽出锁定读取层(Phase 6-B 第五域第二刀,架构边界 §3.2):六个「在调用方事务内加锁、按确定顺序读事实、做一致性断言」的函数(`lockBatchWaitlistHead` / `lockFirstComeWaitlistHead` / `lockApplicationProjections` / `assertProjectedReservationsExact` / `firstComeWaitlistRank` / `readReservationAnchors`)迁入 `activity-allocation-locks.ts`,七个相关数据形状 type 迁入 `activity-allocation.types.ts`。该层实测零 `this.` 注入依赖(只吃传入的 `tx`),故为模块级纯函数而非 `@Injectable`,不进 DI 图、两个 module 均无需改注册。锁序:该层是被调用方而非事务起点,调用顺序即锁顺序,权威次序仍在服务各命令方法的调用序列里,新文件不复制、只在头注声明该约束。零 endpoint、零 DTO、零 OpenAPI、零 BizCode、零权限码变更,对外行为逐字不变。
