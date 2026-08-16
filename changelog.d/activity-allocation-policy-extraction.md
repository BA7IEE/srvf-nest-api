### Changed

- 活动名额分配抽出纯判定层与类型层(Phase 6-B 第五域第一刀,架构边界 §3.2):`activity-allocation.service.ts` 中六个零 IO 零事务的判定函数(`assertVoidLiveFacts` / `assertPreparingCandidates` / `readReceiptBatchStatusCode` / `initialPreferencePositions` / `assertPendingSource` / `targetProjection`)与两个纯值转换工具(`decimalString` / `asObject`)迁入 `activity-allocation-policy.ts`;七个核心数据形状 type 与响应 schema 版本常量迁入 `activity-allocation.types.ts`,供服务与判定层共享,避免判定层反向 import 服务。判定层为模块级纯函数而非 `@Injectable`:不进 DI 图,两个 module 均无需改注册。零 endpoint、零 DTO、零 OpenAPI、零 BizCode、零权限码变更,对外行为逐字不变。
