### 变更

- 完成 Integration Foundation v1 的上线运行手册：覆盖独立环境变量与 Secret、控制面预配置、
  非生产联调、Gate 审批、Credential / Grant 止损、事故处置与 `SERVICE_PRINCIPAL` enum 回滚边界。
- 发版阶段 A 变为显式刷新版本变更的下游交接产物，防止 OpenAPI contract version 更新后客户端或
  授权台账静默陈旧。

BREAKING: 无（运行与发版收口；不改变业务 API）
