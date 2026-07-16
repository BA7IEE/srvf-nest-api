# 第四轮全仓 Review 报告（v0.56.0）

> **✅ 修复落地状态(2026-07-17 回填,沿 v0.26.0 报告先例)**:六条 findings 已全部 review-then-fix 闭环——F4/F5 → PR #666(dashboard 三源 scope + feedbackRate 分母口径);F1/F2/F3/F6 → PR #667(Activity 聚合锁先于基线读 / `claimAtStatus` CAS 收口取消×考勤竞态 / 改窗校验岗位窗 / registrationCounts 补 waitlisted;含 F1×2 + F2×1 真并发测试)。双 lane 并行执行(process §8),正文冻结不回改。

> 状态：**FROZEN / REPORT-ONLY**
> 审查基线：`main@b276d5f3e30f66b8721f769ca70e1616636b3a76`（v0.56.0）
> 审查日期：2026-07-17
> 审查 lane：A（`claude/fourth-review`）
> 结论口径：只记录问题，不在本 PR 修复；修复必须另立 review-then-fix goal。

## 0. 结论摘要

本轮按七个维度完成代码、迁移、契约、权限、测试和文档的交叉复核，结论为：

- **P0：0**
- **P1：2**
- **P2：4**
- **P3：0**
- 六条 finding 均为 **CONFIRMED**，没有仅凭静态推断登记的 PLAUSIBLE finding。
- `EXPECTED_ROUTES=360`、OpenAPI contract（659 tests / 2 snapshots）、四项文档守护和专项 E2E 均通过；App 侧 41 个 operation 的 2xx 响应 schema 未发现 L3 字段。
- 主要风险集中在参与闭环：报名 create 没有加入 Activity 聚合锁序，考勤提交没有锁住报名状态，以及活动窗更新未维护岗位窗从属不变式。另有 dashboard 副职只读可见性、评价率分母生命周期、候补状态度量三处口径问题。
- 因存在 P1 数据一致性问题，建议在下一次参与域功能继续演进前，按 `review-then-fix` 单独立项；本报告 PR 不承载修复。

## 1. 参与闭环交互（最高优先）

### 扫描范围与已确认事实

- 活动总容量的公开读侧统一经 `deriveEffectiveActivityCapacity()` 派生，`capacity=null` 时由岗位容量求和；实现见 `src/modules/activities/activity-capacity.ts:5-18`，Admin 与 App presenter/query 均复用该函数，未发现第三套容量真相源。
- 候补队列 key、排位与递补候选均包含 `(activityId, activityPositionId)`：`src/modules/activity-registrations/activity-registration-waitlist-query.service.ts:14-20,61-84`、`src/modules/activities/activity-waitlist-promotion.ts:95-104`。岗位级队列隔离专项 E2E 与 unit 均通过。
- approve 在 Activity 锁后重读容量并 CAS claim：`src/modules/activity-registrations/activity-registrations.service.ts:976-1011`；bulk approve 逐项复用单条 approve，没有另造绕过锁序的批量写路径：`src/modules/activity-registrations/activity-registration-bulk.service.ts:12-31,47-62`。
- 岗位容量更新在 Activity 锁后重读岗位与占用基线：`src/modules/activities/activity-positions.service.ts:169-219`；#631 型“锁前 delta 基线”专项并发回归通过。
- GPS 签到遵循 Activity → registration 的固定锁序，并在锁后复核当前 pass 报名：`src/modules/attendances/app-activity-check-ins.service.ts:253-305`；checkout 使用条件更新，相关专项 E2E 通过。
- 旧报名 partial unique 的 migration SQL 与 `v0.54.0` 逐字零 diff：`prisma/migrations/20260510193742_v2_batch3_activities_attendances/migration.sql:226-228`。

本维度登记 **3 findings（P1×2、P2×1）**。

### F1 — 报名 create 未加入 Activity 聚合锁，候补递补与岗位删除可产生失配状态

- **级别：P1**
- **复核结论：CONFIRMED**
- **代码证据：**
  - Admin 代报与 self/App create 先读 activity/position/passCount，再决定 `pending|waitlisted` 并插入，但事务内没有锁 Activity：`src/modules/activity-registrations/activity-registrations.service.ts:835-878,897-938`。
  - 状态由锁外可变化的 `passCount/capacity` 决定：`src/modules/activity-registrations/activity-registrations.service.ts:581-595`。
  - 相邻写侧以 Activity 为聚合锁：容量扩容与递补见 `src/modules/activities/activities.service.ts:647-684,748-760`；岗位软删除先锁 Activity、统计 active registration 后删除见 `src/modules/activities/activity-positions.service.ts:291-309`；递补引擎在锁内读取队列见 `src/modules/activities/activity-waitlist-promotion.ts:73-105`。
- **并发复现 A（候补滞留）：** 初始 `capacity=1/pass=1`。create 读到满员并暂停；并发扩容 `1→2` 在 Activity 锁内看到候补数为 0 后提交；create 随后插入 `waitlisted`。终态为 `capacity=2`、仅 1 个 pass、另有 1 个 waitlisted，存在空位但无人触发递补。
- **并发复现 B（岗位软删）：** create 读到 live position 后暂停；并发岗位删除锁 Activity、统计 active registration 为 0 并软删岗位；create 随后成功插入指向该已软删岗位的 active pending registration。
- **影响：** 自动递补闭环可留下永久滞留候补；岗位删除保护可被并发报名穿透，产生业务上不可审批/不可正确归队的 active registration。两种复现共享同一根因：create 没有参与既定 Activity 聚合锁序。

### F2 — 考勤表提交与报名取消并发时，可绕过“已有考勤不可取消”保护

- **级别：P1**
- **复核结论：CONFIRMED**
- **代码证据：**
  - 批量考勤提交先普通读取 registration 与状态并校验 `pass`，随后才创建 sheet/record，期间没有对 registration 做 `FOR SHARE` 或状态 claim：`src/modules/attendances/attendances.service.ts:519-537,556-576,605-650`。
  - 取消路径锁 Activity 后 claim registration，再调用 `assertNoAttendanceRecords()`；该保护只统计取消当下已经存在的 record：`src/modules/activity-registrations/activity-registrations.service.ts:623-629,1178-1200`。
  - GPS check-in 已采用 Activity → pass registration `FOR SHARE` 并锁后复核的正确原语，可作为同域对照：`src/modules/attendances/app-activity-check-ins.service.ts:253-305`。
- **并发复现：** 考勤提交读到 pass registration 后暂停；取消事务 claim 成功且统计 record=0，提交 cancelled；考勤事务随后创建 sheet/record。终态为同一 registration `status=cancelled` 且存在 attendance record。
- **影响：** 直接生成现有业务保护意图明确禁止的状态，后续参与度量、贡献值、评价资格可能同时把该成员当作已取消和已出勤。

### F3 — 活动时间窗更新未校验既有岗位时间窗，父子时间不变式可被破坏

- **级别：P2**
- **复核结论：CONFIRMED**
- **代码证据：**
  - 岗位 create/update 明确要求岗位窗成对存在且落在活动窗内：`src/modules/activities/activity-positions.service.ts:426-443`。
  - Activity update 只校验活动自身开始/结束和报名截止时间，没有读取或校验既有岗位窗：`src/modules/activities/activities.service.ts:631-645,687-733`；且只有更新 capacity 时才获取 Activity 锁：`src/modules/activities/activities.service.ts:647-649`。
  - GPS 与考勤均优先使用岗位窗：`src/modules/attendances/app-activity-check-ins.service.ts:307-317`、`src/modules/attendances/attendances.service.ts:568-576`。
- **复现：** 先建合法的活动窗与其内岗位窗，再调用实际 `ActivitiesService.update()` 缩窄父活动窗；更新成功，终态岗位开始早于活动开始且岗位结束晚于活动结束。
- **影响：** “岗位窗必须包含于活动窗”的写入不变式只在岗位侧单向成立；管理员改活动时间后，签到/考勤仍按越界岗位窗放行，活动级展示与参与凭证发生语义分裂。

## 2. 安全回归：v0.45/v0.46 统一原语在 v0.47+ 写侧的接线

本维度 **新增 0 finding**；F1、F2 是本轮发现的两个统一并发原语接线缺口，已在第 1 节登记，不重复计数。

扫过以下 v0.47+ 写侧与相邻安全原语：

- 状态迁移 CAS：expiry marker 使用条件 `updateMany`，见 `src/modules/notifications/expiry-reminder.service.ts:197-240`；考勤 reopen 使用旧状态条件更新，见 `src/modules/attendances/attendances.service.ts:1658-1688`。
- 活动聚合锁与并发计数：岗位容量更新、岗位软删、候补递补和报名 approve 已接 Activity 锁；create 缺口归入 F1。
- 当前报名共享锁：GPS 签到已接；考勤提交缺口归入 F2。
- 评价唯一性：service 对 partial unique 的 P2002 做业务错误映射，见 `src/modules/activity-feedbacks/activity-feedbacks.service.ts:65-89`。
- 委派/副职只读：seed 由角色策略动态派生只读权限，未发现硬编码第二套权限列表。
- 文件验证：检查全部 `AttachmentContentValidator` 调用入口，v0.47+ 未新增绕过统一 MIME/内容验证的新文件写侧。

## 3. 鉴权数据范围：9 角色 × 206 码与副职只读派生

### 扫描范围与已确认事实

- seed 从目标角色的 effective policy 动态派生 read-only 权限，而非复制静态权限码：`prisma/seed.ts:3518-3526`；副队长岗位策略见 `prisma/seed.ts:3551-3570`，seed 内还有派生不变量守卫。
- `AuthzService` 汇合 direct / position / supervision 三类来源并计算可见组织范围：`src/modules/authz/authz.service.ts:139-224`。
- `pnpm docs:rbacmap:check` 确认 9 个 built-in role、206 个 permission 全量覆盖；权限码未引用与 Swagger 鉴权后缀违规均为 0。
- scoped authz、三来源、position-role policy 等专项 E2E 通过；副职对 registrations/attendance 等 flat list 的组织范围过滤成立。

本维度登记 **1 finding（P2）**。

### F4 — dashboard summary 仍只认 GLOBAL RBAC，副职可见性与 scoped 列表不一致

- **级别：P2**
- **复核结论：CONFIRMED**
- **代码证据：**
  - dashboard block 是否出现由 `RbacService.can()` 决定：`src/modules/meta/meta.service.ts:91-155`。
  - `RbacService` 明确只读取 GLOBAL RoleBinding，不包含 position/supervision/scoped 来源：`src/modules/permissions/rbac.service.ts:72-76`。
  - 完整 effective permission 应由 `AuthzService` 汇合三来源：`src/modules/authz/authz.service.ts:188-224`。
  - 三来源 E2E 已证明副队长可获得组织只读权限：`test/e2e/authz-three-source.e2e-spec.ts:509-535`；scoped participation E2E 已证明相同用户可读取过滤后的报名/考勤列表：`test/e2e/participation-scoped-authz.e2e-spec.ts:573-645`。
- **影响：** 副职可以打开组织范围内的参与列表，却在 dashboard 看不到对应 registrations/attendance 汇总块；同一权限在入口摘要与明细页形成不一致的可见性。该问题是少展示，不构成跨范围泄漏。

## 4. 度量结算口径：参与度量、贡献值与评价聚合

### 扫描范围与已确认事实

- 每条 approved attendance 的 raw contribution 由 `computeRawContribution()` 统一计算：`src/modules/attendances/contribution-calculator.ts:49-51`。
- team-join 与个人参与汇总继续复用 `computeCappedContribution()`，封顶规则没有分叉：`src/modules/team-join/team-join-progress.ts:26-65`、`src/modules/attendances/participation-summary-query.service.ts:47-73`。
- 活动详情参与度量与 dashboard overview 复用 `computeActivityParticipationMetrics()`：`src/modules/activities/activity-participation-metrics.ts:5-6`、`src/modules/meta/participation-overview-query.service.ts:134-168`。

本维度登记 **2 findings（P2×2）**。

### F5 — 评价 numerator 与当前 approved denominator 生命周期不同，feedbackRate 可大于 1

- **级别：P2**
- **复核结论：CONFIRMED**
- **代码证据：**
  - numerator 聚合全部未软删 feedback；denominator 只统计当前 approved sheet 的 distinct member，最后直接相除：`src/modules/activity-feedbacks/activity-feedbacks-query.service.ts:75-120`。
  - 提交评价时只校验当下存在 approved attendance：`src/modules/activity-feedbacks/activity-feedbacks.service.ts:52-83`。
  - feedback 只关联 activity/member，不关联资格来源 attendance sheet；schema 见 `prisma/schema.prisma:962-981`。
  - attendance reopen 把 approved sheet 改回 pending，但保留 attendance records 与已经创建的 feedback：`src/modules/attendances/attendances.service.ts:1642-1687`。
- **复现：** 两名成员各有 approved attendance 并已评价；reopen 其中一张 sheet 后，query 返回 `count=2`、`approvedDenominator=1`、`feedbackRate=2`。
- **影响：** 名为 rate 的公开度量可超过 100%，活动评价 dashboard 与结算/运营判断失真；若 sheet 最终 reject，该历史 numerator 仍继续计入。

### F6 — registrationCounts 未包含第五态 waitlisted，状态分项与 total 无法对账

- **级别：P2**
- **复核结论：CONFIRMED**
- **代码证据：**
  - 计算器先把所有 live registration 计入 total，但 switch 仅累加 pending/pass/reject/cancelled：`src/modules/activities/activity-participation-metrics.ts:53-75`。
  - 对外 DTO 也只有上述四个分项：`src/modules/activities/activity-participation.dto.ts:29-44`。
  - waitlisted 已是正式第五态；冻结评审明确状态集合和语义：`docs/archive/reviews/activity-waitlist-t0-review.md:77-93`。
- **复现：** 输入仅 1 条 waitlisted registration，输出 `total=1`，四个状态分项全部为 0。
- **影响：** 活动详情与复用该 helper 的 participation overview 都无法用状态分项还原总报名数；候补规模在参与度量表面被静默遗漏。

## 5. 数据模型：54 个 migration 与三张新表

本维度 **0 个独立 finding**；F1 的“active registration 指向 soft-deleted position”是事务锁序问题，已在第 1 节计数，不重复登记为 schema finding。

扫过并核验：

- 基线共 54 个 migration，空测试库 deploy 成功，`_prisma_migrations` 实测 54 条 applied。
- 三张新表分别由以下 migration 引入：
  - `ActivityCheckIn`：`prisma/migrations/20260715101605_add_activity_check_ins/migration.sql:1-57`
  - `ActivityFeedback`：`prisma/migrations/20260715193127_add_activity_feedbacks/migration.sql:1-42`
  - `ActivityPosition` 及 registration 外键：`prisma/migrations/20260716045857_add_activity_positions/migration.sql:1-54`
- 直接查询 PostgreSQL catalog 核验三表的普通索引、partial unique、PK 与 7 条 FK；FK 均为 `ON UPDATE CASCADE / ON DELETE RESTRICT`。
- partial unique 条件分别锁定 live check-in registration、live activity/member feedback、live activity/name position；与 Prisma 模型的软删除语义一致。
- 原报名 partial unique 继续保持 `("activityId", "memberId") WHERE "deletedAt" IS NULL AND "statusCode" <> 'cancelled'`，且相对 v0.54.0 SQL 零 diff。

## 6. 契约表面：360 routes、snapshot 与 L3

本维度 **0 finding**。

扫过并核验：

- `pnpm test:contract` 通过：1 suite、659 tests、2 snapshots；路由集合与 `EXPECTED_ROUTES=360` 一致。
- snapshot diff 只按当前基线读取，没有执行 `-u`；本报告未改契约、DTO、endpoint 或 snapshot。
- 对 OpenAPI 中全部 41 个 `/api/app/*` operation 的 2xx response schema 做递归字段扫描，`passwordHash`、token hash、refresh/access token、secret/credential、原始 GPS 经度/纬度/精度均为 0 命中。
- Check-in 的 Admin/App safeSelect 和 field policy 分层明确：`src/modules/attendances/activity-check-in-field-policy.ts:4-33,88-121`；presenter 不把原始定位字段投向 App：`src/modules/attendances/activity-check-in-presenter.ts:28-70`。

## 7. 文档计数 true-up 与代码事实抽查

本维度 **0 finding**。

四项守护全部通过：

- `pnpm docs:counts:check`：36 modules / 74 Controllers / 360 Endpoints / 54 Migrations / 250 BizCodes / 206 permissions / 113 AuditLogEvents / 9 built-in roles / 2 Cron。
- `pnpm docs:readtax:check`：`AGENTS.md`、`docs/current-state.md`、`CLAUDE.md` 均在预算内。
- `pnpm docs:codemap:check`：0 FAIL；已有 10 个 >700 LOC service 的 WARN 属 current-state 已登记债务，不作为本轮 finding。
- `pnpm docs:rbacmap:check`：0 FAIL / 0 WARN；206 个 seed permission 全部被代码引用，360 条 Swagger auth suffix 均合规。

抽查 `docs/current-state.md:9-32,46-53` 与 live 代码/测试/数据库一致：版本、计数、Route B、cron=2 和 accepted limitations 均未发现漂移；活动岗位/签到/评价的事实另以 live schema、migration、service 与 contract 交叉确认。

## 8. Findings 分级总表

| ID | 级别 | 结论 | 摘要 | 主证据 |
|---|---|---|---|---|
| F1 | P1 | CONFIRMED | registration create 缺 Activity 聚合锁，候补与岗位删除并发失配 | `activity-registrations.service.ts:835-938` |
| F2 | P1 | CONFIRMED | attendance submit 与 cancel 并发绕过“已有考勤不可取消” | `attendances.service.ts:519-650` |
| F3 | P2 | CONFIRMED | Activity 改窗不校验既有 position 窗 | `activities.service.ts:631-733` |
| F4 | P2 | CONFIRMED | dashboard 只认 GLOBAL RBAC，漏掉副职 scoped 可见性 | `meta.service.ts:91-155` |
| F5 | P2 | CONFIRMED | feedbackRate numerator/denominator 生命周期不一致，可 >1 | `activity-feedbacks-query.service.ts:75-120` |
| F6 | P2 | CONFIRMED | registrationCounts 漏 waitlisted，第五态不可对账 | `activity-participation-metrics.ts:53-75` |

P0 与 P3 均为 **0 finding**。

## 9. 排除清单核对

以下项目均已核对，属于维护者已拍板接受或既有 backlog，本轮不复报、也不计入 finding：

| 排除项 | 本轮处理 |
|---|---|
| #8 `btree_gist` | 已识别为 accepted limitation；不复报 |
| #10 / #12 附件内存分页 | 已识别为 accepted limitation；不复报 |
| #19 RBAC 单进程 cache | 已识别为 accepted limitation；不复报 |
| #20 / #21 at-most-once 通知 | 已识别为 accepted limitation；不复报 |
| 28003 枚举 | 已识别为已拍板例外；不复报 |
| A-5 / A-6 | 已识别为后续设计项；不复报 |
| P1-21 / P1-22 / P1-23 | 已识别为 `NEXT_TASKS` backlog；不复报 |

核对来源：`docs/current-state.md:51-53`、`docs/ai-harness/NEXT_TASKS.md:41-54,66-68,91-95`，以及前三轮/专项 review 的冻结结论。

## 10. 验证记录

在独立 lane worktree、派生测试库 `app_test_review_4th` 上执行：

| 验证 | 结果 |
|---|---|
| `pnpm agent:preflight --lane` | PASS |
| `pnpm agent:check:full` | PASS：lint / typecheck / build；unit 102 suites / 2597 tests；contract 659 tests / 2 snapshots；E2E 153 suites / 3023 tests |
| 10 个参与闭环/容量/评价/贡献专项 unit suites | PASS，69 tests |
| 12 个 waitlist/position/check-in/feedback/authz 专项 E2E suites | PASS，138 tests |
| `pnpm test:contract` | PASS，659 tests / 2 snapshots / 360 routes |
| 三表 index/FK/partial unique PostgreSQL catalog introspection | PASS |
| 原报名 partial unique 与 v0.54.0 migration SQL diff | PASS，zero diff |
| App 2xx response schema L3 扫描 | PASS，41 operations / 0 forbidden properties |
| `pnpm docs:counts:check` | PASS |
| `pnpm docs:readtax:check` | PASS |
| `pnpm docs:codemap:check` | PASS（0 FAIL） |
| `pnpm docs:rbacmap:check` | PASS（0 FAIL / 0 WARN） |

并发 finding 使用真实 PostgreSQL、独立测试数据和两个独立 Prisma transaction 交错复现；实验数据只存在于派生测试库，不进入仓库。

## 11. 本次未做

- 未修复 F1-F6，未改任何 `src/**`、`test/**`、`prisma/**`、契约 snapshot 或权威源文档。
- 未删除、放宽或改写任何既有测试断言。
- 未执行 migration reset/db push、生产写入、数据回填或物理删除。
- 未改依赖、workflow、Dockerfile、权限码、Role、Guard、登录/JWT/refresh、Storage/COS。
- 未处理排除清单中的 accepted limitations / backlog。
- 未修改、合并或关闭其他 lane 的分支/PR；本 PR 只开出等待总控集成，不自行合并。
