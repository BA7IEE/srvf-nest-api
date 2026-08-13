### Added

- R11 契约语义门:对 `docs/handoff/openapi.json` 的 base↔head 做语义分类,breaking 判定表成文九类(端点删除、响应字段删除、请求必填新增、类型收窄、请求枚举删值、响应枚举加值、请求撤销 nullable、响应变可空、成功状态码变更)。破坏性变更须在 changelog.d 里以 `contract-breaking` 块申报(含真回滚手段),并由维护者在 harness-review 环境点批;additive 变更放行但恒进 gate 报告。
- 两级结构沿用 R14 已验证的形态:申报完整性是硬闸(scan 失败 ⇒ 审批 job 被跳过,点头也盖不掉),Environment 审批是补齐申报之后的第二道闸。

### Changed

- `agent:check:api` 与 `agent:check:full` 追加 `docs:openapi:check`(v4 §11 遗留项,本地管线补齐)。
