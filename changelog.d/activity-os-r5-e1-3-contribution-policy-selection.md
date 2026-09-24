# Activity OS R5 E1-3：活动贡献政策选择与发布冻结

- 新增模板／活动／岗位三层贡献政策选择，Template V5、Proposal V9、发布审批冻结和四类 Readiness；旧 V1–V4 模板、V2–V8 提案及 legacy 未配置活动保持兼容。
- 新增 Admin/App 选择读写及 App options 共五个端点；两项 scoped Human 权限均不默认授予内建角色，SUPER_ADMIN、Service Principal 与 delegation 不直通。
- 新增第131条 additive migration：不可变选择 revision、item、command receipt 三表及可空历史指针；零 DML、回填、删除或旧 migration 修改，业务数据永久留存。
- 新增选择安全审计与 `20247–20254` 闭合错误码；OpenAPI、生成客户端、RBAC／路由／状态机／审计登记和前端交接同步刷新。
- 既有 E1-1 物理地基回归改用统一受控 fixture cleanup，级联清理时完整恢复贡献政策与分类时长不可截断守卫；业务断言与超时不变。
- 第131条 migration 的3b及最终269权限、173/168审计、30/277字典与实际摘要的4b均已重签。
- PR 冷跑发现旧版本模板单测、历史迁移夹具与 Prisma 漂移精确基线需识别本轮 additive 字段；仅适配历史测试输入及当前计数，保留旧升级目标、业务断言和 fail-closed 校验。
- 当前仅为 Draft PR 候选；不代表 Ready、合并、部署、D8-OPS、Gate、旧规则转换、正式贡献结算或前端发布。

### 契约语义申报

下列申报如实登记可信语义裁判的保守分类。Template V5 的响应枚举扩展要求穷举版本的 Admin 客户端增加 V5 分支；三个 App
写入口新增的顶层选择字段仍为可选，裁判将可选对象内部的必填子字段单独判为 B3，旧请求无需发送这些对象。申报不等于红区批准、
Ready、合并、部署或 Gate 授权。

<!-- contract-breaking
operation: POST /api/admin/v1/activity-template-versions
reason: E1-3 允许显式 schemaVersion=5 的模板命令，命令回包现在可能为 5；只穷举 V1–V4 的旧客户端必须新增分支。
impact: 读取创建收据并穷举 schemaVersion 的 Admin 调用方须识别 V5；既有 V1–V4 请求、响应值、canonical 与 hash 语义不变。
migration: 重新生成 Admin 客户端并按 AdminActivityTemplateDefinitionV5Dto 增加 V5 分支；旧客户端未适配前继续发送既有 V1–V4 定义，不得把 V5 记录作为其工作流输入。
rollback: 未写入 V5 模板前可通过独立 revert PR 回退应用改动并保留第131条 additive schema；已有 V5 记录时保留兼容 reader 并前向修复，不部署只识别 V1–V4 的旧应用，不删模板、修订或业务数据。
-->

<!-- contract-breaking
operation: PUT /api/admin/v1/activity-template-versions/{id}/draft
reason: E1-3 允许 draft V5 的命令回包返回 schemaVersion=5；只穷举 V1–V4 的旧客户端必须新增分支。
impact: 更新 draft 后读取命令收据并穷举 schemaVersion 的 Admin 调用方须识别 V5；既有 V1–V4 draft 请求及其回包保持原语义。
migration: 重新生成 Admin 客户端并按 AdminActivityTemplateDefinitionV5Dto 增加 V5 分支；旧调用方继续操作既有 V1–V4 记录，未适配前不编辑 V5 draft。
rollback: 未写入 V5 模板前可通过独立 revert PR 回退应用改动并保留第131条 additive schema；已有 V5 记录时保留兼容 reader 并前向修复，不部署只识别 V1–V4 的旧应用，不删模板、修订或业务数据。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/activity-template-versions/{id}/activate
reason: E1-3 允许激活 V5 draft，命令回包现在可能为 schemaVersion=5；只穷举 V1–V4 的旧客户端必须新增分支。
impact: 激活后读取命令收据并穷举 schemaVersion 的 Admin 调用方须识别 V5；既有 V1–V4 激活请求及其回包保持原语义。
migration: 重新生成 Admin 客户端并按 AdminActivityTemplateDefinitionV5Dto 增加 V5 分支；旧调用方继续操作既有 V1–V4 记录，未适配前不激活 V5 draft。
rollback: 未写入 V5 模板前可通过独立 revert PR 回退应用改动并保留第131条 additive schema；已有 V5 记录时保留兼容 reader 并前向修复，不部署只识别 V1–V4 的旧应用，不删模板、修订或业务数据。
-->

<!-- contract-breaking
operation: POST /api/admin/v1/activity-template-versions/{id}/retire
reason: E1-3 允许退役 V5 active 模板，命令回包现在可能为 schemaVersion=5；只穷举 V1–V4 的旧客户端必须新增分支。
impact: 退役后读取命令收据并穷举 schemaVersion 的 Admin 调用方须识别 V5；既有 V1–V4 退役请求及其回包保持原语义。
migration: 重新生成 Admin 客户端并按 AdminActivityTemplateDefinitionV5Dto 增加 V5 分支；旧调用方继续操作既有 V1–V4 记录，未适配前不操作 V5 模板。
rollback: 未写入 V5 模板前可通过独立 revert PR 回退应用改动并保留第131条 additive schema；已有 V5 记录时保留兼容 reader 并前向修复，不部署只识别 V1–V4 的旧应用，不删模板、修订或业务数据。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/professional
reason: R11 将新增可选 contributionPolicySelection 内的必填子字段判为 B3；顶层字段仍为可选，旧请求未被改为必填。本块如实登记保守机器分类，不消除检查器缺陷。
impact: 专业创建的旧调用方仍可省略 contributionPolicySelection，顶层 required 清单未变；仅主动使用新字段的调用方须发送完整活动与岗位选择，既有创建和幂等重放保持兼容。
migration: 旧调用方无需迁移；新调用方按生成的 App DTO 发送完整选择，或省略该字段以保留历史未配置。本申报不授权生产部署、正式贡献结算或 Gate 切换。
rollback: 若复验发现旧请求真实不兼容，先停止 Ready 与合并；若已合入则通过独立 revert PR 回退应用改动并保留第131条 additive schema及永久事实，不降库、不删选择修订或业务数据。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/emergency
reason: R11 将新增可选 contributionPolicySelection 内的必填子字段判为 B3；顶层字段仍为可选，旧请求未被改为必填。本块如实登记保守机器分类，不消除检查器缺陷。
impact: 紧急创建的旧调用方仍可省略 contributionPolicySelection，顶层 required 清单未变；仅主动使用新字段的调用方须发送完整活动级选择，既有创建和幂等重放保持兼容。
migration: 旧调用方无需迁移；新调用方按生成的 App DTO 发送完整选择，或省略该字段以保留历史未配置。本申报不授权生产部署、正式贡献结算或 Gate 切换。
rollback: 若复验发现旧请求真实不兼容，先停止 Ready 与合并；若已合入则通过独立 revert PR 回退应用改动并保留第131条 additive schema及永久事实，不降库、不删选择修订或业务数据。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/change-reviews
reason: R11 将新增可选 contributionPolicySelectionChanges 内的必填子字段判为 B3；该字段与 expectedContributionPolicySelectionRevision 仍可同时省略。本块如实登记保守机器分类，不消除检查器缺陷。
impact: 旧变更审核请求的顶层 required 清单未变；主动提交贡献选择变更时才须成对提供完整变化项与当前 revision，未配置 legacy 活动仍走既有兼容提案路径。
migration: 旧调用方无需迁移；新调用方按生成的 App DTO 成对发送完整选择变化和当前 revision，或同时省略以保留既有选择。本申报不授权生产部署、正式贡献结算或 Gate 切换。
rollback: 若复验发现旧请求真实不兼容，先停止 Ready 与合并；若已合入则通过独立 revert PR 回退应用改动。已有 V9 或选择修订时保留兼容 reader 并前向修复，不降库、不删提案、快照、选择修订或业务数据。
-->
