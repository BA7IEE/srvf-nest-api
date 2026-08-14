### Added

- 架构治理 Phase 3 前置：债务 call-site 身份一致性检查 `pnpm docs:boundaries:ids:check` 接入 CI **Fast checks** 既有的 `Architecture governance A-metadata gate` 步骤，**不新增 required context**。定为 **blocking**（A 类元数据完整性，判台账不判代码）：断言每条已登记的 call-site 债务条目仍能解析到一个活的调用点。真触发已验证——把某条的 `callSiteId` 改坏则门 exit 1 并逐条列出 `unmatched`，还原后 exit 0；当前 201/201 通过且幂等。
