# SRVF 活动报名候补与自动递补 T0 评审稿

> **状态**：FROZEN（2026-07-15）  
> **档位**：D 档功能串，F0～F4 串行  
> **立项基线**：v0.52.0 / `e8a59131` / 0 open PR  
> **已有依据**：活动模块审计刀 6 第二件 goal-objective（2026-07-15）+ 维护者对两次受保护文档冲突简报回复“按推荐”  
> **目标**：关闭活动审计项 #5（无候补/自动排队递补）

本稿只展开 goal 已拍板的 W1～W3、工程代决、行为白名单、DoD 与维护者已确认的两处
surgical true-up 例外，不新增决策。实施若发现本稿与 live 代码、`AGENTS.md`、baseline、
API surface policy 或 bounded-context 仍有冲突，必须按 `docs/process.md §4.1` 停止并提交
人话简报，不得自行调和。

## 0. TL;DR

1. `registration_status` 从 4 态 additive 扩为 5 态，新增 `waitlisted`（候补中）。
2. 满员报名不再拒绝 21031；Admin 代报、自助与 App 共用 create 链改为落 `waitlisted`。
3. 候补排序固定为 `registeredAt ASC, id ASC`，无候补人数上限。
4. 名额释放时只把队首 `waitlisted → pending`，仍须走正常审批；禁止直接转 `pass`。
5. 递补触发点只有两类：取消 `pass` 报名；活动 capacity 调大或改为 `null`。
6. 递补在业务事务内完成，Activity 行 `FOR UPDATE` 串行化，registration 逐行 CAS claim。
7. 递补 audit 复用 `registration.review`，`extra.action='promote'`；不新增 AuditLogEvent。
8. 递补通知在 commit 后事务外 best-effort 派发，类型复用 `registration-result`，仅站内。
9. App/admin 报名读模型 additive 返回 `waitlistPosition`；dashboard additive 返回
   `registrations.waitlisted`。
10. 目标足迹：migration 52、endpoint 350、permission 206、AuditLogEvent 113、cron 2、
    BizCode 240 均不增加；seed 只新增 1 个字典 item；本 goal 不 bump、不 tag、不 release。

## 1. 冻结范围与阶段

| 阶段 | 交付 | 硬边界 |
|---|---|---|
| F0 | 本冻结稿 | 只展开既定决议，不新增决策 |
| F1 | `waitlisted` 字典 item、防误删守卫登记、状态机 3 边、create 满员分流 | 0 schema / migration / endpoint / permission / BizCode |
| F2 | 递补引擎、cancelAdmin/cancelMy 与 activity capacity update 接线、promote audit、commit 后通知 | Activity `FOR UPDATE` + registration CAS；approve 锁与容量闸零 diff |
| F3 | App/admin `waitlistPosition` 批量读侧、dashboard `waitlisted` 计数 | 禁 N+1；只做 2 簇 additive 契约 |
| F4 | e2e 全矩阵、contract snapshot、handoff、CHANGELOG Unreleased、current-state §2、终态门禁 | 不 bump / tag / release |

阶段按 F0 → F4 串行，不跨阶段提前扩行为。受保护文档例外仅有维护者已确认的：

- `docs/participation-bounded-context.md`：同步 Registration 4→5 态与 lifecycle。
- `src/modules/activity-registrations/CLAUDE.md`：同步本地 5 态、满员分流、递补事实。

`AGENTS.md` 与其他模块 CLAUDE 保持零修改。

## 2. 产品决策 W1～W3

### 2.1 W1：递补只转待审

- 名额空出后，队首候补自动 `waitlisted → pending`。
- 递补者重新进入既有审核流；审批人闸、approve 容量闸与 `FOR UPDATE` 锁保持不变。
- 禁止 `waitlisted → pass` 直通，禁止新增手动递补端点。
- 递补成功后向本人发送站内通知：“候补已递补，进入待审”。

### 2.2 W2：满员自动进候补

- Admin 代报、自助与 App create 的全部既有前置闸继续执行：活动状态、公开性（Admin 例外）、
  报名截止、活动结束时间、性别、保险、防重。
- 最后按 `capacity !== null && passCount >= capacity` 决定新行状态：满员为 `waitlisted`，
  其余为 `pending`；`capacity=null` 恒为 `pending`。
- create 满员判断不额外加锁；错误判断最多影响排队时序细节，最终 pass 超发仍由既有 approve
  锁与容量复核阻断。
- `waitlisted` 不是 `cancelled`，因此继续占用同人同活动 live registration 唯一槽；重复报名仍返 21002。

### 2.3 W3：扩容自动递补

- capacity 从有限值调大 N：按 FIFO 最多递补 `newCapacity - oldCapacity` 名。
- capacity 从有限值改为 `null`：递补全部候补。
- capacity 缩小：不递补；既有 `newCapacity >= passCount` 守卫保持不变。
- 其他 Activity 字段更新不触发递补。

## 3. 状态机与唯一槽

### 3.1 五态闭集

```text
pending / pass / reject / cancelled / waitlisted
```

`waitlisted` 是既有 `ActivityRegistration` 行，不新增表、字段或 migration。队列序固定：

```text
registeredAt ASC, id ASC
```

### 3.2 本期状态边

| action | 合法边 | 约束 |
|---|---|---|
| approve | `pending → pass` | 逐字保持；`waitlisted` approve 仍返 21030 |
| reject | `pending\|waitlisted → reject` | 允许管理员清理候补 |
| cancel | `pending\|pass\|waitlisted → cancelled` | cancelAdmin/cancelMy 共用 |
| promote | `waitlisted → pending` | 仅递补引擎内部使用，无端点 |
| reopen | `reject → pending` | 逐字保持 |

状态机新增 action `promote`，但不会形成对外 API。所有状态错误继续复用
`ACTIVITY_REGISTRATION_STATUS_INVALID=21030`。

### 3.3 活动取消联动

Activity cancel 的既有联动由“pending → cancelled”扩为“pending + waitlisted → cancelled”。
`pass` 仍保留原行为，不在本期改变。活动取消通知继续覆盖所有仍在册报名者。

## 4. 递补引擎与并发边界

### 4.1 触发点

仅允许：

1. `cancelAdmin` / `cancelMy` 取消的原状态是 `pass`：同事务递补恰 1 名。
2. `ActivitiesService.update` 的 capacity 调大：同事务递补 delta 名。
3. `ActivitiesService.update` 的 capacity 改为 `null`：同事务递补全部。

取消 `pending` / `waitlisted` 不触发；缩容和非 capacity 更新不触发。

### 4.2 原子性与锁顺序

每次递补：

1. 在原业务事务内对目标 Activity 行执行 `SELECT ... FOR UPDATE`，使同活动取消/扩容递补串行。
2. 按 `registeredAt ASC, id ASC` 读取待递补 `waitlisted` 行。
3. 对每行执行 `claimAtStatus(... expectedStatus='waitlisted')` 或等价条件 CAS。
4. claim 成功才写 `statusCode='pending'` 并写同事务 audit；并发败者不得重复递补同一人。
5. 返回成功递补者最小通知要素；事务 commit 后再派发站内通知。

同活动双取消并发必须最终释放两个名额并递补两个不同队列成员（候补足够时）；不得双递补
同一人，也不得因两个事务都读到同一队首而漏掉第二名。

### 4.3 Audit

- event 固定复用 `registration.review`。
- `extra.operation='review'`、`extra.action='promote'`。
- before/after 使用既有 registration snapshot；prior=`waitlisted`、next=`pending`。
- actor 使用触发取消/扩容的当前用户；不新增 AuditLogEvent 或 BizCode。

### 4.4 通知

- 类型：`registration-result`。
- 渠道：仅站内。
- 标题/正文：表达“候补已递补，进入待审”。
- 通知在业务事务 commit 后执行；单人失败只记日志，不回滚已完成递补。
- 不新增 cron、queue、outbox 或第二个 Effect 类，沿既有 NotificationDispatcher。

## 5. 读侧与契约

### 5.1 waitlistPosition

- App 我的报名列表与详情：仅 `statusCode='waitlisted'` 时返回排位，其他状态返回 `null`。
- Admin 活动报名列表同字段。
- 排位按同活动 live `waitlisted` 的 `registeredAt ASC, id ASC` 计算，第一名为 1。
- 列表必须批量计算，禁止按 item 查询形成 N+1。

本簇为 additive response 字段变更；App DTO 继续与 Admin DTO 物理隔离。

### 5.2 Dashboard

`registrations` 块从 `{ pending }` additive 扩为 `{ pending, waitlisted }`。两者都只统计未软删
registration；块级权限裁剪与 HTTP 行为保持不变。

## 6. 行为变更白名单（恰好 5 条）

1. 满员 create（Admin + self/App）由拒绝 21031 改为成功创建 `waitlisted`。
2. 取消 `pass` 报名同事务自动递补队首为 `pending`，commit 后通知。
3. capacity 调大/改 `null` 自动递补 delta/全部。
4. 状态机 cancel/reject 合法源态扩展包含 `waitlisted`。
5. Activity cancel 联动由 pending 扩为 pending + waitlisted → cancelled。

除此之外的用户可见行为变化必须停线。尤其：

- approve 容量闸、Activity `FOR UPDATE` 与 pending 审批语义零 diff。
- participation 度量、考勤结算与 GPS 打卡路径零 diff；候补不是 pass，不能签到。
- reopen、CSV、权限、surface、分页、错误码语义不扩展。

## 7. 足迹硬约束

| 项 | 基线 | 终态 |
|---|---:|---:|
| Prisma migration | 52 | 52 |
| Endpoint | 350 | 350 |
| Permission code | 206 | 206 |
| AuditLogEvent | 113 | 113 |
| Cron | 2 | 2 |
| BizCode | 240 | 240（预计；若实现确需新增须停线说明） |
| Seed | — | 仅 `registration_status.waitlisted` +1 item |

禁止 `prisma migrate reset`、手工 `prisma migrate deploy`、`prisma db push`；禁止 schema、migration、
新表、新端点、新权限、新 AuditLogEvent、第三个 cron、候补上限配置、新依赖。

## 8. 验收矩阵

至少覆盖：

- 满员 Admin 代报、自助、App 创建均进入候补，排位正确。
- FIFO 递补；`registeredAt` 相同时以 `id` tie-break。
- 取消 pending/waitlisted 不递补；取消 pass 只递补 1 名。
- capacity 扩容 delta、改 `null` 全递补；缩容不递补且既有容量守卫不变。
- waitlisted approve 返 21030、reject 成功、cancelMy 成功。
- 并发双取消不重复递补同一人且不漏掉第二名。
- waitlisted 占防重槽，重复报名返 21002。
- Activity cancel 联动取消候补。
- promote audit 的 event/action/before/after 正确。
- 递补通知收件人、类型、文案及 commit 后 best-effort 语义。
- App list/detail 与 Admin list 的 `waitlistPosition`；列表无 N+1。
- dashboard `registrations.waitlisted`。
- waitlisted 无法使用 GPS 签到，既有参与度量/打卡/结算回归不变。

最终必须通过：`pnpm agent:check:full`、`pnpm docs:rbacmap:check`、
`pnpm docs:codemap:check`，并逐行解释 contract snapshot diff。

## 9. Handoff

- miniapp：新增 `waitlisted` 状态展示；列表/详情展示 `waitlistPosition`；满员报名成功文案改为
  “已进入候补”；递补后展示待审并消费站内通知。
- admin-web：复用既有报名列表 `statusCode=waitlisted` 过滤；展示排位；明确取消 pass 与扩容会
  自动递补为 pending，仍须正常审批。

## 10. 本期不做

- 版本 bump、tag、GitHub Release、release closeout。
- waitlisted → pass 直通、手动递补端点、候补上限、预约/确认时限。
- 新表、schema、migration、Redis、queue、cron、outbox、事件总线。
- 新权限码、新 BizCode、新 AuditLogEvent、新通知类型。
- 改动 approve 容量闸/锁、参与度量、打卡、考勤结算。
- 启动审计刀 6 第三件“评价”；仅在终版报告留下接口说明。
