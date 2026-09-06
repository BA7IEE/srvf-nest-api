# C1 D2c 活动指标 V7 提案与 Readiness 交付说明

状态：仓内实现已在当前分支完成，尚未创建或合并 PR，未部署生产。整体跨模型复审按维护者已确认的节奏留待全部实现完成后统一执行；本页不构成目录初始化、人员授码、前端发布、生产发布或 Gate 开启授权。

本页承接 [D2b 选择与 Template V3 交付](activity-metric-selection-template-rollout.md)，只说明 D2c 新增的审核冻结和内部 Readiness 语义。指标定义、指标集、活动选择、模板和既有 v2–v6 审核的历史事实仍分别以其既有合同为准。

## V7 提案合同

新的初发和变更审核一律生成 `schemaVersion=7`；已持久化的 v2–v6/legacy 快照继续按原 parser、canonical、hash、错误和 apply 分支处理，不重新哈希，也不因本次写回 Activity 指标列。

V7 在 base 与 target 都冻结三项 Activity 事实：

- `metricRequirementCode`
- `metricSetPointer`（required 时的精确五字段指针；not_required 时为 null）
- `metricSelectionRevision`

`unconfigured + null + revision=0` 仅用于解释历史活动，新命令不能主动清回该状态。`not_required + null + revision>=1` 是显式选择，不等于未配置。`required` 必须引用可完整重建、至多 100 个定义的精确指标集闭包；不存在、hash 不符、闭包缺失或 101 个以上定义都 fail-closed，不猜最新版本。

初发审核不新增 body 字段，但提交前活动必须已通过既有指标选择入口处于 `required` 或 `not_required`。已发布活动的 change review 可选传入：

```json
{
  "metricSelection": { "metricRequirementCode": "not_required", "metricSetPointer": null },
  "expectedMetricSelectionRevision": 1
}
```

两个字段必须成对出现；省略两者表示保留当前选择。显式同值也会按“新的选择”复验，不能借退役历史引用绕过校验；真实变化才把 revision 精确加一。服务端使用 hash 绑定的内部 `metricSelectionExplicit` 标记区分“省略并保留历史”与“显式重选”，该标记不在客户端 DTO 或审核读面暴露。

提交和批准的锁序在既有审核根事务内扩展为 Activity → 指标集 → 定义（按 ID 排序）。每次锁等待后都会用同一事务重验当前身份、App 准入、属主/责任、活动状态、pending 条件和指标引用；失败不会留下部分 review、Activity 选择、RuleSnapshot、审计或 outbox 写入。

## 前端与审核工作台

HTTP 路由、权限码、审计事件、Gate 和 schema/migration 均没有新增：

- App 初发仍是 `POST /api/app/v1/my/managed-activities/:activityId/publish-reviews`。
- App 变更仍是 `POST /api/app/v1/my/managed-activities/:activityId/change-reviews`，仅增加上述可选成对字段。
- Admin 审核仍使用既有 `GET /api/admin/v1/activity-publish-reviews[/:id]` 与 `POST /:id/approve`。

审核详情的安全摘要新增 `kind: 'proposal-v7'` 和 `v7Fields.changedFields`。它们只会给出受控字段名，不返回 before/after 值、指标集名称、定义内容、快照全文或个人数据。损坏/未知 V7 快照返回受控的不可解析摘要，不能把原 JSON 透给页面。

前端处理：

- `20174`：输入的指标选择形状无效，修正完整选择后再提交。
- `20175`：活动选择 revision 已变化，刷新活动后由用户决定是否重提。
- `20172`：引用的集或定义已不可作为新选择，重新读取可选目录并选择有效项。
- 审核批准阶段若显式选择在等待期间退役，同样返回 `20172`；省略选择的已发布历史引用可完成无关变更。

不要把 `changeDiff` 当作可恢复编辑状态，也不要尝试用 Admin 目录、直发、legacy submit 或普通 PATCH 侧写指标选择。

## 内部 Readiness

`ActivityPublishReadinessService` 仍是内部、只读、gate-off 的 evaluator：没有新增 HTTP 返回面，不接审核/发布 Gate，不写业务数据、审计、成果、时长或贡献。

它在同一只读快照中加载 Activity 四列、精确集和有界定义闭包，并把结果投影为：

| 状态 | Readiness 结果 |
|---|---|
| unconfigured | blocker `METRIC_SELECTION_MISSING` |
| 合法 not_required | 清除指标 blocker，不代表已有成果 |
| draft required 且 active 闭包完整 | 清除指标 blocker |
| published 的历史 retired required 闭包完整 | 可解释并清除指标 blocker |
| 形状、指针或 hash/闭包损坏 | blocker `METRIC_SELECTION_INVALID` |
| draft required 引用已退役 | blocker `METRIC_REFERENCE_UNAVAILABLE` |

V3 模板通过既有严格 parser 识别；V1/V2/legacy 分支不改。模板默认值不是当前活动选择的替代品，Readiness 不会自动选 latest 或重写活动。

## 发布、回退与边界

部署前必须另行批准统一支持 V7 的应用版本，避免旧 reader 与 V7 writer 混跑。若需暂停，必须在独立维护窗口停止受影响的提审、批准和直发入口，同时保留兼容 reader 解释在途审核；B7 的创建 Gate 不能证明这些入口已关闭。

不得通过回退删除 V7 review、RuleSnapshot、选择、目录或重算旧 hash。生产初始化指标内容、人员授码、前端页面和生产部署均不在本次范围。C2/C3 成果值、Release 4 时长和 Release 5 贡献仍未实施。

## 本次未做

未新增 schema、migration、seed、权限码、审计事件、HTTP 路由或 Gate；未部署生产、初始化目录内容、授予人员权限、发布前端或开启任何 Gate；未完成整体跨模型复审，也不因此宣称 C1 已完成或可进入 C2。
