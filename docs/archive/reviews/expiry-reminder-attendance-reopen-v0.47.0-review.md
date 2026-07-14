# v0.47.0 到期提醒 + 考勤终审撤回重审实施评审稿

> **状态**：实施前评审稿（冻结文本，2026-07-14）
> **性质**：D 档立项、红线解锁与实施授权记录。维护者 2026-07-14 下发的 goal 文本已完成拍板；本稿只把拍板项、影响面、回退条件和验收锚点固化，不重开产品决策。
> **范围**：F1 证书/个人保险/团队保单到期提醒；F2 考勤终审 `reopen`；F3 v0.47.0 release closeout。
> **不在范围**：队列、Redis、事件总线、第三个定时任务、考勤新状态、作废重录、历史贡献账本回滚、已发生入队/晋升回溯、短信渠道、保险核验工作流、`#592` 已合代码改写。
> **冲突纪律**：本稿让步给 `AGENTS.md`、`ARCHITECTURE.md`、baseline 与 active policy；但 goal 已明确授权的第二个 `@Cron`、受保护文档 surgical true-up、考勤行为新增、Permission/AuditLogEvent 扩展属于本稿冻结范围。实施发现新产品未决项或需越出本稿时，沿 `docs/process.md §4.1` 停下等拍板。

---

## 0. 开工基线（F0，runner 亲核）

2026-07-14 开工探针：

- `pnpm agent:preflight`：通过；worktree clean、0 open PR、未落后 `origin/main`。
- branch / HEAD：`main` / `14dc7da1b0f2011d470cf0e10cd007c232f15716`。
- 版本：`package.json=0.46.0`、Swagger `0.46.0`、最新 tag / Latest Release 均为 `v0.46.0`。
- `CHANGELOG.md ## Unreleased`：已有 `#592` 招新业务三改，v0.47.0 一并带出，不回改其实现。
- migration：49；权限码：205；`EXPECTED_ROUTES`：336；AuditLogEvent：111。
- `@Cron`：真实装饰器 1 个（生日批）；注释命中不计数。
- `pnpm docs:rbacmap:check`：0 FAIL / 0 WARN；`pnpm docs:codemap:check`：0 FAIL，仅既有 god-service WARN。

结论：F0 门禁满足，可以进入 T0/F1/F2/F3 串行队列。

---

## 1. 维护者拍板项（2026-07-14）

| 编号 | 决策 | 冻结内容 |
|---|---|---|
| D-ER-1 | 第二个 cron 解锁 | 仅新增“每日到期扫描”一个 `@Cron`；全仓终态恰好 2 个。每日 09:00 `Asia/Shanghai`，沿生日批 `@Cron` 薄壳 + `runOnce()` 结构。不解锁 queue / Redis / 事件总线 / retention cron。 |
| D-ER-2 | 证书提醒与翻态 | `expiredAt=NULL` 跳过；未来 60 天窗口内提醒本人一次；到期日把 `verified → expired`，同事务写 `certificate.expire` 审计，commit 后通知本人一次。门槛仍按日期实时判定，不因持久态翻转改变资格语义。 |
| D-ER-3 | 保险提醒 | 自购保险提前 30 天定向本人；团队保单提前 30 天建一条 `visibility=management` 系统广播。历史已在窗口内或已过期且未标记的数据首跑补一轮。 |
| D-ER-4 | 渠道 | 个人维度使用站内 + 微信订阅消息，复用 `NotificationDispatcher.dispatchTargeted`；微信 `no-template` / 无 quota / 上游失败均 best-effort，不阻断站内。团队保单只建站内广播。 |
| D-ER-5 | 幂等 | 证书 60 天提醒复用 `expireNotifyDueAt`；两张保险表各新增 `expireNotifiedAt DateTime?`。处理前使用条件更新抢占，只有抢占成功者派发；重跑不重复。证书到期以 `verified → expired` 条件更新作为一次性闸。 |
| D-ER-6 | 通知字典 | `notification_type` 新增 `expiry-reminder`，同步微信模板空配置 seed 与内置字典防误删既有闭集机制。真实微信模板 ID 为运维待办，不阻塞发布。 |
| D-AR-1 | 考勤 reopen | 新动作 `approved → pending`；不新增状态值；一次性清空一级审核和终审两组三字段；records 保留，随后可 edit → 一审 → 终审。 |
| D-AR-2 | 原因与审计 | `POST /api/admin/v1/attendance-sheets/:id/reopen`；撤销原因 DTO 必填，写入新事件 `attendance-sheet.reopen` 的 `extra.reason`；before/after 带 sheet + records 快照；业务写和 audit 同事务。 |
| D-AR-3 | 权限 | 新码 `attendance.reopen.sheet`；授权面与终审一致：SUPER_ADMIN 短路或 scoped `attendance-final-reviewer` 绑定；不绑 `biz-admin`。Service 判权走现有 authz/RBAC R 模式，不加 `@Roles` / `@RequirePermissions`。 |
| D-AR-4 | 贡献语义 | team-join 只累计 `approved` sheet，reopen 后实时下降、再终审后恢复；已发生入队/晋升不回溯；无账本回滚。reopen 不发通知；再终审复用现有确认通知。 |
| D-AR-5 | 旧行为锁 | `edit` / `softDelete` 对 `approved` 仍拒 `22040`；reopen 只接受 `approved`，其他 4 态复用明确的 `ATTENDANCE_SHEET_STATUS_INVALID`；5 态常量零变化。 |

---

## 2. 方案对比与选择

### 2.1 到期提醒幂等

| 方案 | 形态 | 优点 | 风险 / 代价 | 结论 |
|---|---|---|---|---|
| A（拍板） | DB nullable 时间字段 + 条件更新抢占；commit 后走现有 dispatcher | 零新表、零异步基建；同日/重启/并发重跑均 at-most-once；直接满足 goal 字段约束 | 抢占 commit 后、站内行 create 前若进程崩溃，会出现一次通知丢失；这是现有 post-commit 通知可靠性边界的同类窗口 | **采用**。在无 outbox/queue 红线下优先保证“不重复”；失败记录日志，运维可查业务日期本身 |
| B | outbox / job 表 + worker / retry | 可把业务标记与待发送事件同事务落库，兼顾不丢与不重 | 新表、新 worker、第三类调度/事件机制，越出 goal 且撞 queue/event 红线 | 不采用；真实可靠性诉求出现时另立 D 档 |

字段语义冻结：

- `Certificate.expireNotifyDueAt`：历史命名保留；非空表示 60 天提醒已被当前实现抢占/处理，写入本次运行的北京时间日界对应 UTC 时间。不对外暴露。
- `MemberInsurance.expireNotifiedAt` / `TeamInsurancePolicy.expireNotifiedAt`：非空表示该到期提醒已被抢占/处理；不因 coverage 日期后续修改自动清空。若业务未来要求“改期后再提醒”，必须单独立项定义重置规则，本期不猜。
- 证书到期通知不新增第二 marker：只有成功把 `certStatusCode` 从 `verified` 条件更新为 `expired` 的执行者写审计并派发。

### 2.2 到期扫描实现边界

| 方案 | 形态 | 结论 |
|---|---|---|
| A（拍板） | notifications 模块新增 `ExpiryReminderService`；`@Cron` 仅调用 `runOnce()`；服务编排证书/保险查询、抢占与 dispatcher | **采用**。这是明确通知副作用与调度职责，避免把 cron 塞入 certificates/insurances 大 service；不新增第二个 Effect class |
| B | certificates / insurances 各自一个 cron | 会产生 3 个真实 cron、跨模块重复调度与重复日界逻辑 | 禁止 |

扫描顺序固定：证书 60 天提醒 → 证书到期翻态/审计 → 自购保险提醒 → 团队保单管理层广播。单项失败记录并继续后续项，不让一条坏数据阻断整批。

北京时间日界冻结：job 触发时计算 `today`（北京时间自然日对应的日期值）、`today+60d`、`today+30d`；所有业务 DateTime 仍以 UTC `Date` 入库。窗口：

- 证书预提醒：`verified`、未软删、`expiredAt > today && expiredAt <= today+60d`、marker 为空。
- 证书到期：`verified`、未软删、`expiredAt <= today`；含首跑时历史已过期记录。
- 保险：未软删、`coverageEnd <= today+30d`、marker 为空；不设下界，首跑补已过期记录。文案按 `coverageEnd < today` 区分“已到期”与“即将到期”。

### 2.3 考勤 reopen 判权

| 方案 | 形态 | 结论 |
|---|---|---|
| A（拍板） | 新 permission code 与 `finalApprove/finalReject` 使用同一 scoped `attendance-final-reviewer` 授权面；Service 复用 final-review authz helper 的资源 ref 语义 | **采用**。SUPER_ADMIN 可用；普通 ADMIN 必须持有效 scoped 绑定；`biz-admin` 不自动获得 |
| B | 把新码绑定 biz-admin 或仅 `rbac.can` GLOBAL | 会扩大终审撤回权，违背“授权面与终审对齐” | 不采用 |

reopen 不复用 `final-review` 伞事件：其语义是已批准结果撤回，单列 `attendance-sheet.reopen` 便于审计检索；无 schema migration（TS union）。

---

## 3. Prisma / seed 风险表

| 项 | 结论 |
|---|---|
| 是否修改 `prisma/schema.prisma` | ✅ `MemberInsurance` / `TeamInsurancePolicy` 各加 `expireNotifiedAt DateTime?`；Certificate 只消费既有字段 |
| 是否新增 migration | ✅ 1 个，预期第 50 个；两条 `ADD COLUMN ... TIMESTAMP(3)`，均 nullable、无 default、无回填 |
| 是否修改 `prisma/seed.ts` | ✅ notification type + 微信模板空配置 + `attendance.reopen.sheet` permission 与 scoped reviewer role 绑定 |
| 是否影响现有数据 | ✅ 首跑会扫描窗口内/已过期存量并补提醒；verified 到期证书会翻 expired；两新列初值 null |
| 是否不可逆 | ❌ 实现是 additive；不删除/改写历史列、enum、索引或表。业务侧翻态属于预期运行行为，不由 migration 批量回填 |
| 是否影响 OpenAPI / contract | ✅ 仅 F2 新增 1 endpoint + 1 request DTO；F1 无 endpoint / DTO 变化 |
| 是否影响鉴权 / Permission / 审计 | ✅ permission 205→206；AuditLogEvent 111→113（`certificate.expire` 由 placeholder 迁入 + `attendance-sheet.reopen` 新增） |
| 是否新增 BizCode | ❌ 非 approved reopen 复用 `ATTENDANCE_SHEET_STATUS_INVALID`；其它既有码不变 |
| 是否需要用户拍板 | ✅ 已由 goal 拍板；本稿冻结后实施 |

预期 migration SQL：

```sql
ALTER TABLE "member_insurances"
ADD COLUMN "expireNotifiedAt" TIMESTAMP(3);

ALTER TABLE "team_insurance_policies"
ADD COLUMN "expireNotifiedAt" TIMESTAMP(3);
```

验证禁止域：不运行 `prisma migrate dev`、`prisma migrate reset`、`prisma migrate deploy`、`prisma db push`。干净库重放采用临时数据库 + 按 migration 顺序执行已审查 SQL；seed 对该临时库连续执行两次并比较关键计数。测试套件若其 globalSetup 内部固定调用 `migrate deploy`，本地不直接触发，使用 CI 全量结果作为 full e2e 证据；本地用非禁用路径准备数据库后可运行绕开 globalSetup 的定向测试时再执行。

---

## 4. F1 实现清单（到期提醒）

### 4.1 文件与职责

- `prisma/schema.prisma` + 新 migration：两张保险表各加 marker。
- `prisma/seed.ts`：`notification_type.expiry-reminder` + 对应 `WechatSubscribeTemplate` 空配置；不填假模板 ID。
- `src/modules/notifications/expiry-reminder.service.ts`：第二个 job，唯一逻辑入口 `runOnce()`；`@Cron('0 0 9 * * *', { timeZone: 'Asia/Shanghai' })` 薄壳。
- `NotificationDispatcher`：additive 新增系统广播方法；形状固定 `broadcast/system/published/management/in-app/recipientMemberId=null/authorUserId=null`，不走 admin 状态机、不派微信。
- `NotificationDispatcher.dispatchTargeted`：个人提醒复用原入口，channels 固定 `['in-app','wechat']`。
- `AuditLogsService`：`certificate.expire` 事务内落库；actor / role 为 null；cron meta 使用稳定 requestId 前缀，ip/ua 为 null；before/after 不含凭证或 L3。
- `src/modules/notifications/notifications.module.ts`：注册 job 与更新行为锁注释；`onModuleInit` 启动锚说明两个 cron。
- `src/app.module.ts`、`src/modules/notifications/CLAUDE.md`、`docs/V2红线与复活路径.md`：仅 surgical waiver true-up。
- `src/common/audit/audit-placeholder.ts`：`certificate.expire` 从 pino-only union/注释迁出；`audit-logs.types.ts` 加真实 DB event。
- `src/modules/certificates/certificates.service.ts`：仅把“后台任务推动”注释校准到已实装；扫描逻辑不塞入该 service。

### 4.2 事务与失败语义

- 60 天证书/两类保险：条件 `updateMany` 抢占 marker；`count=1` 才 commit 后派发，`count=0` 表示已处理/并发败者。
- 证书到期：事务内条件翻态 + audit；`count=1` 才 commit 后派发“已失效”；失败时业务事务回滚，不产生“翻态无审计”。
- dispatcher 的站内 create 失败：catch + error log，marker 不回滚（方案 A 已接受边界）；微信臂永不外抛。
- 不打印 policyNumber / certNumber / openid / signed URL / secret；日志只记 resource id、阶段和错误类。

### 4.3 F1 测试锚点

- unit：日界/窗口、永不过期证书跳过、四路径命中/不命中、二跑幂等、并发抢占败者不派发、单项失败继续。
- dispatcher unit：management 系统广播形状精确；个人 channels 含 in-app + wechat；no-template 不阻断。
- e2e：证书到期翻 `expired` + `certificate.expire` audit + directed in-app notification；证书 60 天、个人保险 30 天、团队保单 30 天各自二跑零新增；永不过期证书零触发。
- mechanical：`rg '@Cron\(' src --glob '*.ts'` 真实命中恰好 2；migration 49→50；seed 二跑计数一致。

---

## 5. F2 实现清单（考勤 reopen）

### 5.1 契约

- `POST /api/admin/v1/attendance-sheets/:id/reopen`
- body：`ReopenAttendanceSheetDto { reason: string }`，必填、trim 后非空、最大 500；DTO 白名单不接其它字段。
- response：既有 `AttendanceSheetResponseDto` 包装；HTTP 201（Nest `@Post` 默认）与统一 `{code,message,data}`。
- permission：`attendance.reopen.sheet`；Swagger summary 显式 `[rbac: attendance.reopen.sheet]`。

### 5.2 状态、并发与事务

1. Controller 构造 AuditMeta，Service 先走与终审相同授权面。
2. 事务内读取 sheet + records；状态机 `decide('reopen', currentStatus)` 仅允许 approved。
3. CAS 条件更新 `id + statusCode=approved + deletedAt=null`，写：
   - `statusCode=pending`
   - `reviewerUserId/reviewedAt/reviewNote=null`
   - `finalReviewerUserId/finalReviewedAt/finalReviewNote=null`
   - records 不删不改。
4. CAS `count=0` 复用 `ATTENDANCE_SHEET_STATUS_INVALID`，防并发双 reopen。
5. 同事务写 `attendance-sheet.reopen`；before/after 均含 records 快照，extra 含 reason / priorStatus / nextStatus / recordsCount。
6. 返回 presenter 结果；不派通知、不发 `attendance.recorded`。

状态机动作集合只加 `reopen`，状态集合仍为 `pending / pending_final_review / approved / rejected / final_rejected` 五态。

### 5.3 达标通知与贡献语义

- `team-join-progress.computeContribution` 的查询只读 approved sheet，故 reopen 后自然下降、再终审后自然恢复；不新增累计表或回滚逻辑。
- 已完成入队/晋升不回溯，沿保险报名门槛快照语义。
- 现有 finalApprove 会重新发考勤确认通知，保持不变。
- “贡献值已达标”通知若当前实现按 before/after 跨阈值计算，则 reopen 后再终审会再次跨阈值。F2 先核查；能以现有数据低成本去重则在同 PR 加幂等断言，否则按 goal 接受并把该行为登记在 CHANGELOG/交接说明，不为此引入新表/marker。

### 5.4 F2 测试锚点

- state-machine unit：approved → pending；其余 4 态拒；动作全集断言更新。
- service/unit：审核六字段清空、records 原样保留、CAS、同事务 audit、audit 失败回滚、reopen 零通知。
- endpoint e2e：未登录/无权/scoped reviewer/SUPER_ADMIN；reason 缺失/空串/超长；非 approved 失败。
- 全链 e2e：submit → approve → finalApprove → reopen → edit records → approve → finalApprove；team-join 贡献值“通过后上升、打回后下降、再通过后恢复”；再次终审确认通知存在。
- 旧行为：approved 下 edit/softDelete 仍 `22040`；全量 e2e 绿。

---

## 6. 派生文档与计数

F1 同 PR：

- `src/app.module.ts`、notifications 模块 `CLAUDE.md` / module 注释。
- `docs/V2红线与复活路径.md` F8 / Slow-7 对应条目登记“第二个且仅第二个 cron”。
- `CHANGELOG.md ## Unreleased` 增量记录 F1。

F2 同 PR：

- `docs/participation-bounded-context.md §4`：在终审通过后补 `reopen approved → pending` 行，并说明 records/贡献/通知语义。
- `docs/ai-harness/RBAC_MAP.md`：权限总数 205→206、路由 336→337、授权映射与终审一致。
- `docs/handoff/admin-web.md`：审批工作台能力图加入 reopen + 必填原因 + scoped 权限。
- `docs/handoff/openapi.json`：从 live `/api/docs-json`（临时端口 3005）刷新，字段真相以 live contract 为准。
- `CHANGELOG.md ## Unreleased` 增量记录 F2 与前端注意项。

release 后 `docs/current-state.md` 与 v0.47.0 handoff/OpenAPI 按 E 档九阶段回填。冻结 handoff 合入后不回改。

终态预期计数（以 live runner 再核为准）：

| 项 | 开工 | v0.47.0 预期 |
|---|---:|---:|
| migration | 49 | 50 |
| permission | 205 | 206 |
| EXPECTED_ROUTES | 336 | 337 |
| AuditLogEvent | 111 | 113 |
| 真实 `@Cron` | 1 | 2 |
| BizCode | 232 | 232 |

---

## 7. PR 串行与验收

1. **T0（A 档）**：本评审稿冻结；docs 范围自查，独立 PR 合并。
2. **F1（D 档）**：schema/migration/seed/job/dispatcher/audit/waiver/tests/CHANGELOG；full gates + migration/seed 专项；独立 PR，CI green 后 squash merge。
3. **F2（D 档）**：状态机/端点/permission/audit/tests/handoff/OpenAPI/participation/CHANGELOG；full gates；独立 PR，CI green 后 squash merge。
4. **F3（E 档）**：按 `docs/process.md §5` 与 `srvf-release-closeout`：landing（若需要）→ 3-file bump → handoff → tag 指向 handoff squash → Latest GitHub Release → current-state/OpenAPI 回填 → cleanup。

每刀合并前执行 `docs/process.md §5.4` 全套核验；清理只作用于本 task 分支。禁止 `reset --hard`、force push、force worktree remove、批量 `branch -D`。

---

## 8. 完成定义（终版报告逐条举证）

- 全仓真实 `@Cron` 恰好 2；expiry job 暴露 `runOnce()`。
- 证书 60 天 / 自购保险 30 天 / 团队保单 30 天：命中、未命中、同日二跑幂等；终身证书跳过。
- 到期证书翻 `expired`、`certificate.expire` audit 入库、本人站内通知存在；微信 no-template 不阻断。
- migration 50 个干净库重放、seed 二跑幂等；不使用禁用 Prisma 命令。
- 考勤全链 reopen/re-edit/re-review/re-final-review 通过；贡献值下降/恢复；非 approved 拒绝；approved edit/delete 仍 22040。
- unit / lint / typecheck / build / contract / 全量 e2e 与 required CI 全绿；已知 flaky 仅允许隔离重跑后以证据归类，不得直接忽略。
- participation / RBAC_MAP / handoff / OpenAPI / V2 waiver / notifications CLAUDE / CHANGELOG / current-state 全同步。
- `v0.47.0` tag、Latest GitHub Release、main 六处版本一致；0 open PR、main 与 origin 对齐、worktree clean、无本 task 分支残留。

---

## 9. 明确不做

- 不引入 queue / Redis / event bus / outbox / 第三个 cron。
- 不新增考勤状态，不实现“作废重录”，不删除 reopen 前 records。
- 不回溯已发生入队/晋升，不新增贡献累计账本。
- 不把保险提醒改成短信，不填假微信模板 ID。
- 不自动清空保险 reminder marker；不扩展“改期后再提醒”产品语义。
- 不修改 `#592` 已合代码；只在 v0.47.0 CHANGELOG 折叠时一起发布。
- 不运行 `prisma migrate dev/reset/deploy/db push`；不触碰开发/生产数据。
