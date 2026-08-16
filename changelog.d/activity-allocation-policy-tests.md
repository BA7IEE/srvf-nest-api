### Added

- 活动名额分配判定层补齐单测(Phase 6-B 第五域第三刀):`activity-allocation-policy.ts` 的 `assertPendingSource` / `initialPreferencePositions` / `targetProjection` / `decimalString` / `asObject` 共 28 例。这些函数迁出 `activity-allocation.service.ts` 前零单测覆盖,抽成纯函数后才具备无 mock 可测性。因该层 11 个抛出点中有 10 个共用同一 BizCode(错误码无鉴别力),用例恒采用「每个用例只破坏一个字段、其余全部合法」的构造,定位职责由用例名与输入差异承担;三组变异对拍验证红集各自精确命中,不弥散。
