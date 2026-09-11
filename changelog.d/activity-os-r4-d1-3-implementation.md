- D1-3：实现模板→活动→场次→场次岗位四层时长政策选择，分批 PATCH 生成完整不可变修订，并保留历史选择、命令收据和审计事实。
- 新增模板 V4、提案 V8、Readiness 与批准/变更冻结接线；旧模板、旧提案和历史快照继续按既有版本语义解析。
- 新增第119条 migration、两条显式时长政策权限及 `activity.time-policy.selection` 审计事件；不回填、不删除业务数据、不自动授予角色。
- 本次不操作生产、不启用 Gate；隔离库 E2E、contract、PR CI、合并仍按验收流程执行。

<!-- contract-breaking
operation: GET /api/admin/v1/activity-template-versions
reason: D1-3 让模板 V4 成为可读取的正式表示，列表回包的 schemaVersion 及 definition 现在可能为 4；只穷举 V1–V3 的旧客户端必须新增分支。
impact: 使用列表并按 schemaVersion 或 definition 穷举分支的 Admin 调用方须识别 V4；V1–V3 的请求、响应值与既有语义不变。
migration: 重新生成 Admin 客户端并按 AdminActivityTemplateDefinitionV4Dto 增加 V4 展示/编辑分支；旧客户端未适配前不得把 V4 记录作为其工作流输入。
rollback: 未写入 V4 模板前可通过独立 revert PR 回退应用改动；已有 V4 记录时保留兼容 reader 并前向修复，不部署只识别 V1–V3 的旧应用，不删模板或自动降库。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/activity-template-versions
reason: D1-3 允许显式 schemaVersion=4 的模板命令，命令回包现在可能为 4；只穷举 V3 的旧客户端必须新增分支。
impact: 读取创建收据并穷举 schemaVersion 的 Admin 调用方须识别 V4；省略 schemaVersion 的既有 V3 请求与其回包保持原语义。
migration: 重新生成 Admin 客户端并按 AdminActivityTemplateDefinitionV4Dto 增加 V4 分支；旧调用方继续省略 schemaVersion 并发送既有 V3 定义。
rollback: 未写入 V4 模板前可通过独立 revert PR 回退应用改动；已有 V4 记录时保留兼容 reader 并前向修复，不部署只识别 V1–V3 的旧应用，不删模板或自动降库。
-->

<!-- contract-breaking
operation: GET /api/admin/v1/activity-template-versions/{id}
reason: D1-3 让模板 V4 成为可读取的正式表示，详情回包的 schemaVersion 及 definition 现在可能为 4；只穷举 V1–V3 的旧客户端必须新增分支。
impact: 读取详情并按 schemaVersion 或 definition 穷举分支的 Admin 调用方须识别 V4；V1–V3 的响应值与既有语义不变。
migration: 重新生成 Admin 客户端并按 AdminActivityTemplateDefinitionV4Dto 增加 V4 展示/编辑分支；旧客户端未适配前不得把 V4 记录作为其工作流输入。
rollback: 未写入 V4 模板前可通过独立 revert PR 回退应用改动；已有 V4 记录时保留兼容 reader 并前向修复，不部署只识别 V1–V3 的旧应用，不删模板或自动降库。
-->

<!-- contract-breaking
operation: PUT /api/admin/v1/activity-template-versions/{id}/draft
reason: D1-3 允许 draft V4 的命令回包返回 schemaVersion=4；只穷举 V3 的旧客户端必须新增分支。
impact: 更新 draft 后读取命令收据并穷举 schemaVersion 的 Admin 调用方须识别 V4；现有 V3 draft 请求与其回包保持原语义。
migration: 重新生成 Admin 客户端并按 AdminActivityTemplateDefinitionV4Dto 增加 V4 分支；旧调用方继续发送既有 V3 定义。
rollback: 未写入 V4 模板前可通过独立 revert PR 回退应用改动；已有 V4 记录时保留兼容 reader 并前向修复，不部署只识别 V1–V3 的旧应用，不删模板或自动降库。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/activity-template-versions/{id}/activate
reason: D1-3 允许激活 V4 draft，命令回包现在可能为 schemaVersion=4；只穷举 V3 的旧客户端必须新增分支。
impact: 激活后读取命令收据并穷举 schemaVersion 的 Admin 调用方须识别 V4；现有 V3 激活请求与其回包保持原语义。
migration: 重新生成 Admin 客户端并按 AdminActivityTemplateDefinitionV4Dto 增加 V4 分支；旧调用方继续操作 V3 记录。
rollback: 未写入 V4 模板前可通过独立 revert PR 回退应用改动；已有 V4 记录时保留兼容 reader 并前向修复，不部署只识别 V1–V3 的旧应用，不删模板或自动降库。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/activity-template-versions/{id}/retire
reason: D1-3 允许退役 V4 active 模板，命令回包现在可能为 schemaVersion=4；只穷举 V3 的旧客户端必须新增分支。
impact: 退役后读取命令收据并穷举 schemaVersion 的 Admin 调用方须识别 V4；现有 V3 退役请求与其回包保持原语义。
migration: 重新生成 Admin 客户端并按 AdminActivityTemplateDefinitionV4Dto 增加 V4 分支；旧调用方继续操作 V3 记录。
rollback: 未写入 V4 模板前可通过独立 revert PR 回退应用改动；已有 V4 记录时保留兼容 reader 并前向修复，不部署只识别 V1–V3 的旧应用，不删模板或自动降库。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/professional
reason: R11 将新增可选 timePolicySelection 内的必填子字段判为 B3；顶层字段仍为可选，旧请求未被改为必填。本块如实登记保守机器分类，不消除检查器缺陷。
impact: 专业创建的旧调用方仍可省略 timePolicySelection，顶层 required 清单未变；仅主动使用新字段的调用方须发送完整四层选择，旧创建和幂等重放保持兼容。
migration: 旧调用方无需迁移；新调用方按生成的 App DTO 发送完整选择，或省略该字段以保留历史未配置。本申报不授权生产部署或 Gate 切换。
rollback: 若复验发现旧请求真实不兼容，先停止合并；若已合入则通过独立 revert PR 回退应用改动。不得自动降第119条 migration、删选择事实或删除业务数据。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/emergency
reason: R11 将新增可选 timePolicySelection 内的必填子字段判为 B3；顶层字段仍为可选，旧请求未被改为必填。本块如实登记保守机器分类，不消除检查器缺陷。
impact: 紧急创建的旧调用方仍可省略 timePolicySelection，顶层 required 清单未变；仅主动使用新字段的调用方须发送完整活动级选择，旧创建和幂等重放保持兼容。
migration: 旧调用方无需迁移；新调用方按生成的 App DTO 发送完整选择，或省略该字段以保留历史未配置。本申报不授权生产部署或 Gate 切换。
rollback: 若复验发现旧请求真实不兼容，先停止合并；若已合入则通过独立 revert PR 回退应用改动。不得自动降第119条 migration、删选择事实或删除业务数据。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/change-reviews
reason: R11 将新增可选 timePolicySelectionChanges 内的必填子字段判为 B3；旧调用方仍可同时省略该字段和 expectedTimePolicySelectionRevision。本块如实登记保守机器分类，不消除检查器缺陷。
impact: 旧变更审核请求的顶层 required 清单未变；主动提交选择变更时才须发送完整变化项及当前 revision，旧提交、批准和历史提案保持兼容。
migration: 旧调用方无需迁移；新调用方按生成的 App DTO 同时发送完整选择变化和当前 revision，或同时省略以保留既有选择。本申报不授权生产部署或 Gate 切换。
rollback: 若复验发现旧请求真实不兼容，先停止合并；若已合入则通过独立 revert PR 回退应用改动。不得自动降第119条 migration、删选择事实或删除业务数据。
-->
