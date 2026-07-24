# 活动责任闭环上线认领与切换 Runbook

> 适用版本：v0.61.0 活动责任闭环 PR-10 / PR-11。  
> 性质：维护者在受控维护窗执行的一次性上线 SOP，不是自动修数脚本。  
> 权威业务决议：[`activity-responsibility-workflow-v2-review.md`](../archive/reviews/activity-responsibility-workflow-v2-review.md)。  
> 机器可执行只读探针：[`activity-responsibility-workflow-preflight.sql`](activity-responsibility-workflow-preflight.sql)。

## 0. 安全边界

- 本仓库只交付只读预检、API 操作样例、测试库演练证据和切换顺序。
- AI 不执行生产 migration、seed、真实历史认领、RoleBinding 配置、数据修复、fleet drain、配置切换或发布。
- 禁止从 `publishedBy`、创建人、审核人或活动标题猜 initiator / owner。每条 legacy 认领都由业务负责人明确指定。
- 真实姓名、`memberNo`、账号、任职和活动对应关系不得进入仓库、PR、issue 或 AI 会话；本文件只使用占位符。
- 禁止 `prisma migrate dev`、`prisma migrate reset`、`prisma db push`。生产仅执行已审查的 `pnpm prisma:deploy`。
- 同一 fleet 禁止 `ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED=true/false` 混跑。切 true 前必须 drain 旧实例与旧事务。
- PR-11 contract 后，单独把 gate 改回 false 不构成完整回滚：旧通用角色权限已经摘除，回滚必须同时恢复上一版本及经审核的旧 RolePermission 集。

## 1. 阶段与通过条件

| 阶段 | gate | 通用角色旧活动动作 | 允许动作 | 通过条件 |
|---|---|---|---|---|
| expand / 配置 | `false` | 保留 | 部署 nullable schema、新角色；配置 reviewer；盘点 legacy | 不切生产入口 |
| 认领维护窗 | 旧 fleet 全停；唯一维护实例为 `true` | 保留 | 冻结外部流量后逐条 `assign-initiator` / `claim`；反复跑只读探针 | `dataReadyForContract=true`，随后停止维护实例 |
| contract 维护窗 | 全部实例停止 | PR-11 seed 摘除 | 最终只读探针、已审查 deploy/seed | false fleet 与 true 维护实例均 drain |
| cutover | 全 fleet `true` | 已摘除 | 启动新实例并验收 workflow | fleet 配置一致、验收全绿 |

任何阶段的通过条件不满足，都停止在当前阶段，不进入下一阶段。

`claim` / `assign-initiator` 本身受 workflow gate 保护，gate=false 会返回
`ACTIVITY_STATUS_INVALID`。因此不能在仍提供流量的 false fleet 上完成认领。唯一允许的演练形态是：
先冻结写流量并完整 drain false fleet，再启动一个不接外部流量的 true 维护实例；认领完成后先停止并
drain 该实例，才执行 contract。全程不存在 true / false 实例混跑。

## 2. 执行只读预检

在目标环境的只读凭证或受控运维终端执行：

```bash
psql "$DATABASE_URL" \
  --no-psqlrc \
  --set ON_ERROR_STOP=1 \
  --file docs/ops/activity-responsibility-workflow-preflight.sql
```

SQL 首行输出 `summary|{...}`，随后按需输出零到多行 `legacy-gap|{...}`。脚本以 `BEGIN TRANSACTION READ ONLY` 开始，PostgreSQL 会拒绝任何误写。

### 2.1 summary 字段

| 字段 | 必须值 | 含义 |
|---|---:|---|
| `legacyDraftWithoutInitiator` | 0 | 未软删 draft 均已有显式 initiator |
| `legacyPublishedWithoutOwner` | 0 | 未软删 published 均已有 active owner |
| `activeOwnerProjectionGaps` | 0 | active owner 均有 deterministic `activity-owner@ACTIVITY` RoleBinding |
| `activityPublishReviewerBindings` | > 0 | 至少一条当前有效的发布审核绑定 |
| `attendanceFirstReviewerBindings` | > 0 | 至少一条当前有效的考勤一审绑定 |
| `attendanceFinalReviewerBindings` | > 0 | 至少一条当前有效的考勤终审绑定 |
| `dataReadyForContract` | `true` | 上述条件的合取；只证明数据配置可进入 PR-11 contract，不代表 fleet 已 drain |

探针只把 `draft` / `published` 作为 legacy 阻断项。`completed` / `cancelled` 允许 initiator / owner 为空，继续以 `legacyUnassigned=true` 只读展示。

`legacy-gap` 行只返回 activity id、organization id、status 和所需动作，不返回人员信息：

- `draft` → `assign-initiator`
- `published` → `claim`
- `published` 且已有任意 active 协办、但没有 owner → `manual-review-active-responsibility`

最后一种不能直接调用 `claim`：服务会因“已存在 active responsibility”拒绝。必须停下核对该异常
责任历史并另立受审数据处置，禁止自动结束协办、补 owner 或改用裸 SQL。

## 3. 逐条完成 legacy 认领

本节只在 §6 的受控维护窗执行：外部写流量已冻结、false fleet 和旧事务已 drain，并且唯一维护
实例以 `ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED=true` 启动且不接业务流量。不要在日常
gate=false 实例上尝试这些接口。

### 3.1 业务侧准备

对每条 gap 在线下工单记录：

1. activity id 与当前状态；
2. 业务负责人明确确认的目标正式队员；
3. 确认人、确认时间、理由；
4. 操作人和 API 响应的 audit 追踪信息。

目标队员必须满足：

- `Member.status=ACTIVE`、未软删；
- `gradeCode ∈ level-1..level-7`；
- 已关联一个 active、未软删的 User。

不得把 `publishedBy` 直接映射为发起人或 owner。

### 3.2 draft：补录 initiator

```bash
curl -X POST \
  "https://<API_HOST>/api/admin/v1/activities/<ACTIVITY_ID>/responsibilities/assign-initiator" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "memberId": "<CONFIRMED_FORMAL_MEMBER_ID>",
    "reason": "<OFFLINE_APPROVAL_REFERENCE>"
  }'
```

约束：

- 只允许 `draft` 且 `initiatorMemberId IS NULL`；
- 不创建 owner；
- 重复补录或状态不符必须停下核对，不得换 SQL 绕过 API。

### 3.3 published：认领 owner

```bash
curl -X POST \
  "https://<API_HOST>/api/admin/v1/activities/<ACTIVITY_ID>/responsibilities/claim" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "ownerMemberId": "<CONFIRMED_FORMAL_MEMBER_ID>",
    "reason": "<OFFLINE_APPROVAL_REFERENCE>"
  }'
```

成功必须在同一事务内产生：

- 一条 active owner `ActivityResponsibilityAssignment(source=legacy-claim)`；
- 一条 `activity-owner`、`scopeType=ACTIVITY` 的 active RoleBinding；
- RoleBinding note 精确为 `system:activity-responsibility:<assignmentId>`；
- 一条 `activity.publish` 伞事件，`extra.operation=responsibility-legacy-claim`。

任一双写或 audit 失败应整体回滚。禁止手工补其中一腿。

### 3.4 每批复核

每处理一小批即重跑 §2 探针。不要批量裸 SQL 更新 Activity / responsibility / RoleBinding。

若 `activeOwnerProjectionGaps > 0`：

1. 停止 contract；
2. 按 assignment id / activity id 检查 audit 与事务错误；
3. 不自动重建 binding，不按时间戳选赢家；
4. 由维护者决定通过业务 API 重做还是另立数据修复审批。

## 4. reviewer RoleBinding 配置样例

三个 reviewer 角色均零默认持有人、零 PositionRolePolicy，必须显式配置。推荐主体是 active `POSITION_ASSIGNMENT`，scope 是业务组织的 `ORGANIZATION_TREE`。

### 4.1 通用请求形状

```bash
curl -X POST "https://<API_HOST>/api/admin/v1/role-bindings" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "principalType": "POSITION_ASSIGNMENT",
    "principalId": "<ACTIVE_POSITION_ASSIGNMENT_ID>",
    "roleId": "<REVIEWER_ROLE_ID>",
    "scopeType": "ORGANIZATION_TREE",
    "scopeOrgId": "<SCOPE_ROOT_ORGANIZATION_ID>",
    "startedAt": "<ISO_8601_START>",
    "note": "<OFFLINE_APPROVAL_REFERENCE>"
  }'
```

`<REVIEWER_ROLE_ID>` 分别从 `GET /api/system/v1/roles` 查：

| 角色 code | 用途 | 至少配置 |
|---|---|---:|
| `activity-publish-reviewer` | 活动发布 / 变更审核 | 1 条有效绑定 |
| `attendance-first-reviewer` | 考勤一审 approve / reject / return | 1 条有效绑定 |
| `attendance-final-reviewer` | 考勤终审 approve / reject / return | 1 条有效绑定；建议 2 人互备 |

生产建议三个阶段使用不同人员；即使配置重叠，服务端仍会对提交人、最近重提人、一审人执行人员隔离，SUPER_ADMIN 也不能绕过。

### 4.2 有效性核对

探针只计入以下绑定：

- Role 与 RoleBinding 均未软删；
- binding `status=ACTIVE` 且当前时间在任期内；
- scope 为 GLOBAL / ORGANIZATION / ORGANIZATION_TREE 且形状合法；组织 scope 必须指向 active、未软删组织；
- reviewer 角色仍完整持有该阶段 seed 固定的全部 RolePermission；
- USER 主体是 active User；
- MEMBER 主体是 active Member 且有 active User；
- POSITION_ASSIGNMENT 主体的任职、Member、User 均 active 且任期有效。

任职撤销 / 到期后，POSITION_ASSIGNMENT binding 立即失效，不依赖缓存刷新。

## 5. PR-11 contract 前 production checklist

- [ ] 当前部署代码包含 PR-1 至 PR-10，required CI 全绿。
- [ ] 已审查的 65 个 migration 均 deploy 完成，`prisma migrate status` 无 pending。
- [ ] fleet 当前仍统一显式为 `ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED=false`。
- [ ] 发布审核、一审、终审均至少一条有效绑定；终审建议两人互备。
- [ ] 三个 reviewer 角色的固定 RolePermission 码集已与 seed 逐码核对。
- [ ] reviewer 账号能登录，scope 与业务组织树一致。
- [ ] 已用测试单验证：提交人不能一审 / 终审，一审人不能终审，SUPER_ADMIN 同样受限。
- [ ] 已冻结维护窗、回滚负责人和上一版本镜像 / 配置。
- [ ] 已确认旧 fleet、worker 和长事务的 drain 方法。
- [ ] 真实人员对照资料只存于受控工单，不进入仓库。

以上是进入维护窗的前置项；此时只读探针可以仍有 legacy gap，不能伪填
`dataReadyForContract=true`。维护窗内还必须依次确认：

- [ ] 外部写流量已冻结，所有 false 实例、worker、连接和旧事务已 drain。
- [ ] 只启动一个不接外部流量的 true 维护实例，且不存在任何 false 实例。
- [ ] 逐条完成 `assign-initiator` / `claim`；`manual-review-active-responsibility` 已停下单独处置。
- [ ] §2 探针输出 `dataReadyForContract=true`，所有 `legacy-gap` 行归零。
- [ ] owner projection gap 为 0。
- [ ] true 维护实例已停止并 drain，数据库上没有活动责任 workflow 写事务。

任一前置项或维护窗项未勾选，禁止执行 PR-11 contract seed 或启动 cutover fleet。

## 6. 维护窗切换顺序

本节描述顺序，不授权 AI 或 CI 对生产执行。

1. 冻结活动 / 报名 / 考勤写流量。
2. 停止并 drain 所有 false 实例、worker 和旧事务，确认连接与写流量归零。
3. 启动一个不接外部流量的 PR-1–PR-10 维护实例，显式配置 gate=true；不得同时保留 false 实例。
4. 通过 §3 API 逐条完成 legacy 认领，反复跑 §2；只接受 `dataReadyForContract=true`。
5. 停止并 drain true 维护实例，再在同一数据库快照上重跑 §2。
6. 执行已审查的 PR-11 deploy / seed，使通用角色旧动作权限完成 targeted contract 摘除。
7. 核对 `biz-admin` / `org-admin` / `group-manager` 精确码集与三个 reviewer / owner 角色码集。
8. 为整个新 fleet 注入完全相同的 `ACTIVITY_RESPONSIBILITY_WORKFLOW_ENABLED=true`，再启动实例。
9. 先验 health / ready，再进行 §7 业务验收；通过后恢复流量。

禁止滚动地让 true / false 实例同时接流量。该切换应是 drain 后的整 fleet 替换。

## 7. 切换后验收

- [ ] `/api/system/v1/health/ready` 返回 200 / code 0。
- [ ] 正式队员可在本人当前归属组织发起；volunteer / reserve / null grade 被拒。
- [ ] 有效 cross-org grant 可跨组织发起，无 grant 不可。
- [ ] 普通发起进入发布审核；有对应 reviewer grant 的发起人可直发本人活动。
- [ ] 发布审核工作台只见授权组织，发起人 / 最近提交人不能自审。
- [ ] 发布成功存在唯一 owner 与 deterministic RoleBinding。
- [ ] owner / 对应协办可管理报名、考勤；无责任关系的全局管理员不可借旧通用角色操作。
- [ ] 一审、终审仅显式 reviewer 可做，人员隔离错误码符合契约。
- [ ] returned 可编辑并重提回 pending；reject / finalReject 仍软删除 records。
- [ ] managed closure 在 completed + 已声明 + 所有有效 Sheet approved 时才 closed。
- [ ] dashboard reviewer 待办按各 action 的授权组织范围统计。
- [ ] 重跑 §2，仍为 `dataReadyForContract=true`。

## 8. 回滚

### 8.1 contract 前

保持全 fleet gate=false，停止认领 / 配置操作并保留已写历史；新增 nullable 数据和绑定不影响旧入口。不要删除演练留下的合法 audit。

### 8.2 contract 后、恢复流量前

若验收失败：

1. 不恢复业务流量；
2. 停止新 fleet；
3. 保存失败证据与当前只读探针；
4. 按已审核的回滚包恢复上一版本代码、上一版 seed 角色码集和统一 gate=false 配置；
5. 再次确认全 fleet 无混档，才允许启动旧版本。

仅改 gate=false 而不恢复旧 RolePermission 会形成权限真空，禁止作为回滚。

### 8.3 恢复流量后

按事故流程冻结写流量并升级维护者；不自动补权、不批量授予 biz-admin、不删除责任 / audit 历史。

## 9. 本 Runbook 不做

- 不执行任何生产命令；
- 不提供自动猜 owner / initiator 的 SQL；
- 不提供批量 UPDATE / DELETE / 回填；
- 不记录真实 reviewer / owner 名单；
- 不删除 gate=false 兼容分支；稳定一版后另立 cleanup goal；
- 不发布、不打 tag。
