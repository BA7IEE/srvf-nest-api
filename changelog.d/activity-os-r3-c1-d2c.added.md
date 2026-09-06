新增 C1 D2c 的 V7 发布审核冻结：新 initial/change writer 在 base/target 中绑定 Activity 指标三事实，显式变更以 paired revision 防并发并在审核根事务内复验当前身份、责任和有界指标闭包；历史 v2–v6/legacy 解析、hash 与 apply 保持兼容。审核详情新增安全 `proposal-v7` 字段名摘要，App change DTO 增加可选 paired metric selection 输入；Readiness 识别 V3 并以实际选择状态替换旧指标不可表达 blocker。无 schema/migration/seed、权限码、审计事件、路由或 Gate 变更，未部署生产；整体跨模型复审待后续统一执行。

### C1 D2c 契约误报申报（2026-09-07）

维护者已确认「确认 C1 D2c 契约误报申报方案 A」。下列 `contract-breaking` 块
如实记录 PR #1284 首轮可信扫描的七处 B3，不声称旧请求新增必填字段，也不代表检查器缺陷已修复。
触发字段均位于新增可选 `metricSelection` 内：`metricRequirementCode`、`metricSetPointer`
及指针的 `id`、`code`、`version`、`schemaVersion`、`definitionHash`。
`scripts/contract-semantic-diff.ts` 的 `flattenFields` 未保留可选祖先的条件，属于 D2b 已复现的同类误报。
`ChangeReviewDto` 的顶层 required 清单未变；`metricSelection` 与
`expectedMetricSelectionRevision` 可同时省略，主动传入时才要求成对完整输入。
`activity-os-r3-c1-d2c-proposal-compatibility.e2e-spec.ts` 验证旧客户端省略两字段仍可提交和批准，
历史 unconfigured 四列保持原值，也覆盖省略并保留已退役历史引用的无关变更。
本次仅补声明，不改运行时、DTO、OpenAPI、测试或检查器；独立 E2E 失败不在本误报申报覆盖范围。
可信环境人工审批与合并许可仍须独立取得，本声明不授权开启任何业务 Gate。

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/change-reviews
reason: R11 把新增可选 metricSelection 内的七个必填子字段判为 B3；可选祖先条件丢失导致同类误报。本块登记机器触发，不声明旧请求变为必填，也不消除检查器缺陷。
impact: 此变更审核接口的旧调用方仍可同时省略 metricSelection 和 expectedMetricSelectionRevision，顶层 required 清单不变；主动使用新字段时才须成对提供完整选择与 revision。省略字段的提交、批准和历史列保留已有 HTTP 兼容测试；本结论不豁免其他行为回归。
migration: 旧调用方无需为这两个可选字段迁移；新调用方按生成的 App DTO 成对发送完整选择和当前 revision，或同时省略以保留现有选择。V7 应用须统一兼容部署，生产部署、目录初始化与 Gate 切换仍须另行批准。
rollback: 尚无 V7 持久化数据时可经独立批准的 revert PR 回退应用改动；已有 V7 数据时不得回退至仅支持 V6 的应用，须另行批准维护窗口停止受影响的提审、批准和直发入口，保留 V7 兼容 reader 并前向修复。B7 创建 Gate 不是这些入口的总开关；不得删除 V7 数据、重算旧 hash 或自动降库。
-->
