# 第五轮全仓 Review：第一性 × 对抗性 × 系统性（v0.57.0）

> **冻结日期**：2026-07-17
>
> **基线**：`origin/main@21a00c3b`（package / Swagger / CHANGELOG = v0.57.0）
>
> **性质**：report-only；本报告只记录事实，不包含任何修复
>
> **复核口径**：代码、schema、调用链、真实 PostgreSQL 事务交错、测试与 Git 当前状态优先；历史报告只用于去重
>
> **结论摘要**：P0 = 0，P1 = 0，P2 = 7，P3 = 2；共 9 条 finding，其中 8 条 `CONFIRMED`，1 条为“文档漂移 `CONFIRMED` + 未来扩展风险 `PLAUSIBLE`”

---

## 0. 范围、方法与去重基线

本轮先完整核对四轮冻结报告，再从当前代码重新取证，避免把已修项或 accepted limitation 复报为 finding：

- `full-repo-systematic-review-v0.26.0.md`
- `full-repo-systematic-review-v0.34.0.md`
- `full-repo-first-principles-adversarial-review-v0.38.0.md`
- `full-repo-fourth-review-v0.56.0.md`

新增审计面重点覆盖：

1. v0.57.0 对第四轮 F1–F6 的修复质量；
2. Harness 2.0 机器层：`docs-counts`、`changelog-merge`、lane preflight、worktree DB 派生；
3. 经典安全面：登录 timing、防 refresh 重放、附件内容校验、CSV 公式注入；
4. 全仓不变式、统一写原语、新增 E2E fixture 与 reference / map / handoff 漂移。

基线自证：

- lane worktree：`.claude/worktrees/review-5th`；分支：`claude/fifth-review`；起点：`21a00c3b`；相对 `origin/main` behind = 0。
- `pnpm agent:preflight --lane` 通过，开工时工作树 clean、open PR = 0。
- v0.56/v0.57 新增面由 `git diff v0.55.0..v0.57.0` 与相关提交逐文件界定；未以 CHANGELOG 描述替代代码检查。

---

## 1. 视角①：第一性——从不变式倒查反例

本节只从 schema、生产写路径、事务锁序和实际返回契约出发；注释与文档不作为不变式成立的证明。

| 不变式                           | 从全仓倒查的反例入口                                                              | 代码事实与结论                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 判权单轨                         | 活跃 `@Roles` / `@UseGuards`、controller 内角色短路、无权限的新写入口             | `src/**` 活跃 `@Roles` / `@UseGuards` 均为 0；参与域管理写面继续在 service 走 `authz.explain()` / `rbac.can()`，App 写面维持 self-scope。未找到第二条角色判权轨。**HOLDS**。                                                                                                                                                                                                                                                            |
| 软删语义                         | 软删模型的物理 `delete()`、详情不滤 `deletedAt`、状态 claim 不滤软删              | 生产物理删除只落在明确硬删/配置/派生/短命模型（Attachment、Permission / RolePermission、OrganizationClosure、RecruitmentIdentitySession）；`claimAtStatus()` 对六类软删状态模型均带 `deletedAt: null`，见 `src/common/prisma/claim-at-status.util.ts:35-70`。未找到软删业务模型的新反例。**HOLDS**。                                                                                                                                    |
| 防枚举一致性                     | 登录不存在/软删/禁用/错密响应和耗时；refresh 子原因；资源不存在与越权顺序         | 密码登录任何路径恰执行一次 `bcrypt.compare()`，未命中使用合法 bcrypt dummy hash，失败统一 `LOGIN_FAILED`，见 `src/modules/auth/auth.service.ts:61-94`；refresh 不存在、过期、撤销、重放与用户失效对外统一 `10007`，见 `src/modules/auth/auth.service.ts:197-297`。定向 E2E 通过。**HOLDS**。                                                                                                                                            |
| Activity → Registration 固定锁序 | Admin 代报、自助、App、bulk、approve/cancel、考勤 submit、活动取消                | 两个生产 `activityRegistration.create()` 均先锁 Activity，见 `src/modules/activity-registrations/activity-registrations.service.ts:849-908,912-969`；App 委派 self create，bulk 仅串行委派 approve/reject。考勤 submit 先 Activity `FOR SHARE` 再 claim registration，见 `src/modules/attendances/attendances.service.ts:623-645`。数据状态不变式成立；但活动取消在取得 Activity 锁前快照通知收件人，形成新的副作用竞态，见 **R5-01**。 |
| L3 永不返回                      | App 2xx schema、safeSelect / presenter、raw GPS、password/token/secret/signed URL | 对 `docs/handoff/openapi.json` 中全部 41 个 `/api/app/*` operation 的 2xx schema 递归展开 `$ref`，禁字段命中 0；`JwtPayload` 仍仅 `{sub,username}`，见 `src/modules/auth/strategies/jwt.strategy.ts:12-17`。**HOLDS**。                                                                                                                                                                                                                 |
| audit A-1 不可改删               | `auditLog.update/updateMany/delete/deleteMany/upsert`、跨模块直接改 audit row     | `src/**` 上述 mutation 0 命中；业务只经 audit service 创建或查询。**HOLDS**。                                                                                                                                                                                                                                                                                                                                                           |
| P0-E refresh 冻结                | raw token 入库、rotation 非 CAS、family 延期、重放未撤家族、access 主动吊销       | raw token 256-bit 随机且只存 SHA-256，见 `src/modules/auth/refresh-token.util.ts:18-31`；rotation `updateMany` CAS、继承原 `expiresAt`、重放独立事务撤 family，见 `src/modules/auth/auth.service.ts:226-327`；相关 unit / E2E 全绿。**HOLDS**。                                                                                                                                                                                         |

第一性结论：核心业务不变式未发现 P0/P1 反例；唯一新业务缺口是 **R5-01**，它不破坏最终数据状态，却会漏掉一个已被本事务联动取消的报名者通知。

---

## 2. 视角②：对抗性——攻击 / 竞态剧本与诚实负结果

### 2.1 v0.57 六修元审

| 靶点                           | 对抗剧本                                                                                                       | 结果                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 聚合锁覆盖                  | 全仓枚举 `activityRegistration.create/createMany/upsert`，再沿 Admin / self / App / bulk controller 到 service | 生产 create 只有两处，Admin 与 self 都先锁 Activity；App 薄壳委派 self；所谓 bulk 是审核而非报名创建，并逐条委派统一 approve/reject。**尝试证伪失败（负结果）**。证据：`activity-registrations.service.ts:849-969`、`app-my-registrations.service.ts:134-155`、`activity-registration-bulk.service.ts:12-63`。                                           |
| F1 × 活动取消                  | 取消先读收件人但未锁 Activity；并发报名取得 Activity 锁、提交 pending；取消随后 claim Activity 并联动取消      | 真实 PostgreSQL 双事务按该顺序交错，得到 `recipientSnapshot=[]`、新报名先为 `pending`、最终为 `cancelled`、`linkedCancelled=1`。**证伪修复成功：R5-01 CONFIRMED**。                                                                                                                                                                                      |
| F2 Admin / App 代取消 × submit | submit 读到 pass 后暂停；Admin 或 App cancel 尝试抢 registration；反向顺序也测试                               | cancelAdmin / cancelMy 对 pass 均先 Activity `FOR UPDATE` 再 `claimAtStatus` 并检查 attendance；submit 先 Activity `FOR SHARE` 再批量 claim registration。两顺序均由锁 / CAS 串行化，无法生成 cancelled + live attendance。**尝试证伪失败（负结果）**。证据：`activity-registrations.service.ts:1175-1235,1379-1429`、`attendances.service.ts:581-645`。 |
| F2 活动取消联动                | submit 与活动 cancel 并发                                                                                      | submit 的 Activity `FOR SHARE` 与 cancel 的 Activity status claim/update 排他；先 cancel 则 submit 锁后复读拒绝，先 submit 则 cancel 等待提交。未复现第四轮数据矛盾。**负结果**。                                                                                                                                                                        |
| F3 改窗时区 / 边界             | `Z` 与 `+08:00` 表示同一时刻、岗位恰贴活动边界、父子并发改窗                                                   | 父活动与岗位两侧写均先锁 Activity；比较统一使用 `Date.getTime()`；相等边界允许，`start >= end` 或越父窗拒绝。定向 unit / E2E 通过。**尝试证伪失败（负结果）**。证据：`activities.service.ts:319-352,617-683`、`activity-positions.service.ts:426-443`。                                                                                                  |
| F4 dashboard 三源 scope        | scoped-only 角色请求 dashboard，再与 flat registrations / attendance sheets 的组织过滤对账                     | dashboard 对两权限分别调用 `getVisibleOrganizationScope()`，按 `activity.organizationId` 下推；GLOBAL 保持无过滤。E2E 中 GLOBAL / org-readonly / group-readonly / empty-scope 对账通过。**负结果**。证据：`meta.service.ts:93-177`、`activity-registrations.service.ts:249-275`。                                                                        |
| F5 0 分母 / 全撤回             | 无 approved 且无 feedback；全部 approved 撤回但保留历史 feedback                                               | 0/0 显式返回 0；全撤回时分母为 live feedback member 集合，分子与分母同为已评价人数，结果为 1，不会 >1。union 口径同时进入 DTO 描述。**尝试证伪失败（负结果）**。证据：`activity-feedbacks-query.service.ts:75-115`、`activity-feedback.dto.ts:63-69`。                                                                                                   |
| F6 五态恒等式 / 并发           | 读取期间 status 并发变化；构造五态各一；检查总数与分项                                                         | 单次查询得到一个 registration 数组，同一数组内计算 total 与五分项，因此并发写不会让 total 与分项跨快照；E2E 明确断言五项和 = total。当前运行时成立。schema 注释与未来穷尽性另见 **R5-09**。                                                                                                                                                              |

### 2.2 Harness 2.0 机器层

#### `docs-counts` 九提取器

纯内存喂入合法或可编译的代码形态后得到：

- block comment / template literal 中行首 `@Controller(` 会计为 controller；装饰器写成合法的 `@Controller (` 则漏计；
- block comment 中 `code: 'ghost.read'` 会计为权限码，双引号字面量漏计；
- `export type AuditLogEvent = 'a' | 'b'` 同行 union 得到 0，现有多行风格得到 2；
- `@Cron(`、`httpStatus:`、`rbacRole.upsert(` 对注释与字符串均做裸 occurrence 计数；
- endpoint 只识别单引号数组行，双引号 / helper / spread 形态漏计。

当前仓库九个数字与现有代码书写形态相符，`docs:counts:check` 通过；失败的是“守卫对合法重构仍可靠”这一命题，见 **R5-02**。

#### `changelog-merge`

在内存复刻实际算法：fragment 含嵌套 `##` 后，CHANGELOG 顶级 heading 数从 2 变 3；空 fragment 合并正文长度为 0；非法 UTF-8 bytes 经 Node `utf8` 解码产生 U+FFFD。实现随后无条件写 CHANGELOG 并删除所有 fragment，见 **R5-03**。诚实负结果：未知参数已在 `scripts/changelog-merge.ts:25-29` 被拒；目录不存在或无 fragment 会 no-op，不触发删除。

#### lane preflight

`SRVF_LANE=0 pnpm agent:preflight` 实跑仍进入 lane 模式，证明任何非空环境值都可降级 open-PR 硬判；脚本没有档位 / release 分支识别，见 **R5-08**。负结果：lane banner 明确警告 E 档必须 global，clean tree 与 behind-main 两闸仍是硬判，所以这是可信调用方可误用的治理缺口，不是远程攻击面。

#### worktree DB 派生

同一派生函数实测：`lane-a` 与 `lane_a` 同为 `lane_a`；两个共享前 40 字符的名称同 slug；全中文 `审计五` 得到空 slug 并回落主库 `app_test`。正常目录 `review-5th` 正确得到 `app_test_review_5th`，本轮 8 个 E2E suites 确实在该库运行。异常名碰撞见 **R5-04**。

### 2.3 经典安全面回归

- **登录 timing**：不存在、memberNo 未绑定、member 软删、user 禁用、错密码均统一错误且各跑一次 bcrypt compare；`auth-memberno-login.e2e-spec.ts` 随定向套件通过。**负结果**。
- **refresh 家族**：rotation CAS、旧 token 重放撤 family、非 rotation revoke 不误判重放、absolute expiry 不延期；`auth-refresh.e2e-spec.ts` 通过。**负结果**。
- **附件校验**：全部 multipart 入口（证件 / 签名 / 证书 / OCR）与 object confirm/create 继续委派 `AttachmentContentValidator`；对象存在、实际大小、MIME 黑名单与签名表同源。unit + attachments E2E 通过。**负结果**。
- **CSV 注入**：报名与招新两个 exporter 都调用 `common/csv/escapeCsvField()`；`= + - @ TAB CR` 前缀中和后再做 RFC 4180 转义。unit 通过。**负结果**。

---

## 3. 视角③：系统性——横向一致性、测试资产与文档契约

### 3.1 同类写侧是否统一走原语

| 原语              | 横向扫描结果                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 状态 CAS          | `claimAtStatus()` 已覆盖 Activity、ActivityRegistration、AttendanceSheet、Certificate、RecruitmentApplication、TeamJoinApplication；新 submit/cancel 接线复用该 helper。 |
| Activity 聚合锁   | registration create、approve、pass cancel、岗位 create/update/delete、容量变更、候补递补统一以 Activity 为首锁；未发现新增 registration create 旁路。                    |
| 批量委派          | registration bulk review 串行调用单条 approve/reject，未复制第二套状态机、判权、容量或 audit。                                                                           |
| 计数 / 聚合       | activity participation 与 overview 复用 `buildActivityParticipationMetrics()`；feedback summary 分母使用一条 distinct union 查询口径。                                   |
| 文件验证          | object / buffer 两条链统一落 `AttachmentContentValidator`；未发现 v0.56/v0.57 新文件写入口绕过。                                                                         |
| audit append-only | 全仓无 audit update/delete/upsert；新增路径未破 A-1。                                                                                                                    |

系统性写侧结论：除 R5-01 的“锁前收件人快照”外，v0.57 六修没有新增第二套写原语。

### 3.2 新 E2E fixture 时间炸弹检查

对 `v0.55.0..v0.57.0` 新增/修改 E2E 的绝对时间与 `Date.now()` 全量扫描：

- 活动 / 岗位写路径使用 2099 未来时间或显式 completed/draft 状态；排序 fixture 的 2026-07-15/16 时间只参与稳定 FIFO，不与当前时间比较；
- feedback window 使用相对 `Date.now()`，边界 E2E 留 60 秒余量，精确等号由 fake-clock unit 锁定；
- participation metrics 的 2026-07/08 时间配合显式业务状态，只用于统计与月份分桶，不依赖“今天之前/之后”；
- admin-me 的 `lastLoginAt` fire-and-forget 已改为 5 秒有界轮询。

未发现新的“某日期一到即翻红” fixture；这是本轮诚实负结果，不计 finding。

### 3.3 reference、RBAC_MAP、CODEMAP、handoff 抽查

- 九篇 `docs/reference/` 与当前实现抽查：响应包装、分页、DTO 校验、Swagger、软删/事务、角色保护、配置归属、测试纪律、auth/P0-E 的关键机械事实未发现代码反例。
- `pnpm docs:rbacmap:check`：206 权限码、74 controller、360 operation、5 canonical 前缀、seed↔代码引用均 0 FAIL；RBAC_MAP 当前事实未发现新漂移。
- Harness 恒读顺序在三份操作文档中互相矛盾，见 **R5-05**。
- 操作页声称四个 docs guard 全挂 CI，实际 CI 只跑 readtax + counts；CODEMAP 三个本轮增长 service 的精确 LOC 已过时且未被门禁拦截，见 **R5-06**。
- handoff OpenAPI 的路径 / schema 已包含 v0.57 waitlisted 修复且 operation = 360，但 `info.version` 仍为 0.56.0，见 **R5-07**。
- F6 代码与 DTO 已是五态，schema 仍写“四态”，见 **R5-09**。

---

## 4. Findings 分级总表

| ID    | 级别 | 复核                  | 摘要                                                                                              |
| ----- | ---- | --------------------- | ------------------------------------------------------------------------------------------------- |
| R5-01 | P2   | CONFIRMED             | 活动取消在 Activity claim 前快照通知收件人，并发新报名会被联动取消但漏通知                        |
| R5-02 | P2   | CONFIRMED             | `docs-counts` 多个提取器依赖词法偶然形态，可被合法代码、注释或字符串骗过                          |
| R5-03 | P2   | CONFIRMED             | `changelog-merge` 接受嵌套 heading / 空 / 非 UTF-8 fragment，写入后仍删除源 fragment              |
| R5-04 | P2   | CONFIRMED             | worktree DB slug 非单射；特殊名称可跨 lane 共库，空 slug 甚至回落 `app_test`                      |
| R5-05 | P2   | CONFIRMED             | Harness 2.0 恒读协议三份文档给出互相冲突的入口与顺序                                              |
| R5-06 | P2   | CONFIRMED             | “四 guard 全挂 CI”不成立；CODEMAP / RBAC_MAP checker 未接 CI，现有 CODEMAP 小幅精确值漂移未被阻断 |
| R5-07 | P2   | CONFIRMED             | v0.57 handoff OpenAPI 的 `info.version` 仍为 0.56.0，当前状态“六处一致”失真                       |
| R5-08 | P3   | CONFIRMED             | `--lane` / 任意非空 `SRVF_LANE` 可机械绕过 E 档 open-PR global 闸，脚本不识别档位                 |
| R5-09 | P3   | CONFIRMED / PLAUSIBLE | schema 注释仍称报名四态；当前五态恒等式成立，但 string + 非穷尽 switch 对未来新态不 fail-close    |

P0 = 0；P1 = 0。

---

## 5. Findings 详细证据

### R5-01 — 活动取消会漏掉锁前快照之后提交、但被同事务联动取消的报名者通知

- **级别**：P2
- **复核结论**：CONFIRMED
- **文件:行号证据**：
  - 活动取消先读 Activity，再查询 active registrations 并形成 `notificationMemberIds`：`src/modules/activities/activities.service.ts:989-1005`。
  - 直到其后 `claimAtStatus(activity)` 才取得活动行写锁：`src/modules/activities/activities.service.ts:1007-1022`。
  - 联动 `updateMany` 会取消快照之后新出现的 pending / waitlisted：`src/modules/activities/activities.service.ts:1024-1035`。
  - commit 后只向旧快照派发：`src/modules/activities/activities.service.ts:1051-1068`。
  - registration create 会先拿 Activity `FOR UPDATE` 再插入：`src/modules/activity-registrations/activity-registrations.service.ts:488-500,849-908,912-969`。
- **真实事务交错**：取消 T1 读到 `recipientSnapshot=[]` 后暂停；报名 T2 取得 Activity 锁并提交 pending；T1 随后 claim Activity、取消该 registration。实测输出：`activityClaim=1`、`linkedCancelled=1`、最终 status=`cancelled`、`missedRecipient=true`。
- **影响**：最终数据状态守恒，但用户的报名被系统取消却收不到活动取消通知；这是锁前计算副作用目标集造成的确定性遗漏。
- **排除项辨析**：这不是 #20/#21 已接受的 dispatcher at-most-once / crash window；目标 member 在调用 dispatcher 之前就被永久漏出收件人集合，因此即使派发器 100% 成功仍不会发送。

### R5-02 — `docs-counts` 不是结构真源计数，合法书写变化可静默制造假绿 / 假红

- **级别**：P2
- **复核结论**：CONFIRMED
- **文件:行号证据**：
  - 只剥离 `//`，不剥 block comment / string：`scripts/docs-counts.ts:64-82`。
  - endpoint 只匹配单引号数组行：`scripts/docs-counts.ts:85-100`。
  - AuditLogEvent 假设 union 每个成员独占后续一行：`scripts/docs-counts.ts:103-121`。
  - controller / Cron / BizCode / role 使用行首 regex 或裸字符串 occurrence：`scripts/docs-counts.ts:124-146`。
  - T0 拍板口径要求 controller 文件、BizCode 键、seed 权限数组、事件常量成员、seed 内建角色等真源：`docs/archive/reviews/harness-2.0-t0-review.md:85-95`。
- **反例**：template literal 行首 `@Controller(` 被计 1；block comment 与字符串中的 `@Cron(`/`httpStatus:`/`rbacRole.upsert(` 被计；双引号 permission、同行 AuditLogEvent union、双引号 EXPECTED_ROUTES 被漏计。
- **影响**：今后合法格式化 / 重构可在事实数已变化时让 guard 继续通过，或在业务零变化时阻断 CI；“current-state 计数由真源守护”的治理承诺不稳。
- **当前边界**：现有书写形态下九项输出正确（36/74/360/54/250/206/113/9/2）；本 finding 不声称今天的九个数字错误。

### R5-03 — changelog fragment 未校验编码与结构，且失败形态仍会删源

- **级别**：P2
- **复核结论**：CONFIRMED
- **文件:行号证据**：
  - 所有 `.md` 以宽松 `utf-8` 解码、trim、过滤空内容：`scripts/changelog-merge.ts:34-46`。
  - 不校验 fragment 是否只含可并入 Unreleased 的条目，直接拼接：`scripts/changelog-merge.ts:48-63`。
  - 写入后无条件删除全部 fragment：`scripts/changelog-merge.ts:65-67`。
- **反例**：
  - fragment 内 `## Nested` 成为新的顶级 release heading，后续条目脱离 Unreleased；
  - 只有空 fragment 时 `combined=''`，脚本仍重写 CHANGELOG、删除 fragment并报告成功；
  - 非 UTF-8 byte 被 Node 解码成 U+FFFD，替换字符进入 CHANGELOG 后原 fragment 被删除。
- **影响**：release 串行收口可能永久丢失 fragment 原始证据或破坏 CHANGELOG 分段；恢复只能依赖 Git / PR 历史。
- **负结果**：未知参数已拒绝；目录不存在或无 fragment 会 no-op，这两条 hardening 有效。

### R5-04 — worktree 测试库名派生存在碰撞与主库回落

- **级别**：P2
- **复核结论**：CONFIRMED
- **文件:行号证据**：
  - 目录名先把全部非 `[a-z0-9]` 折成 `_`，再截断 40 字符；空 slug 直接返回 `app_test`：`test/setup/worktree-db.ts:17-34`。
  - URL 只在 pathname 恰为 `/app_test` 时重写：`test/setup/worktree-db.ts:36-52`。
  - T0 声称 `db:test:init` 与 Jest globalSetup 共用派生函数：`docs/archive/reviews/harness-2.0-t0-review.md:89-95`；实际 `db:test:init` 仍硬编码 `app_test`：`package.json:23`。
- **反例**：`lane-a == lane_a`；超 40 字符共同前缀碰撞；全中文名 slug 为空并回落 `app_test`。
- **影响**：两个合法 lane 名可能共用测试库，spec 级 reset / truncate 相互污染，制造随机失败或假通过；空 slug 还会与主 checkout 共库。
- **当前边界**：正常名称 `review-5th` 派生为 `app_test_review_5th`，本轮真实 E2E 隔离正常。

### R5-05 — Harness 2.0 恒读协议自身互冲

- **级别**：P2
- **复核结论**：CONFIRMED
- **文件:行号证据**：
  - 根规则称唯一恒读入口为 AGENTS，顺序 `AGENTS → current-state → process`：`AGENTS.md:3-4,9-20`。
  - current-state 改称 `current-state → ai-harness/README → process`，并把 AGENTS 降为“按主题选读”：`docs/current-state.md:59-61`。
  - ai-harness README 又给出 `current-state → AGENTS → process`：`docs/ai-harness/README.md:1-4`。
- **影响**：不同 Agent / 启动器按任一“恒读三件套”执行都会得到不同前置规则；尤其按 current-state 文本可完全跳过根铁律，削弱红区与触发即停投递。
- **边界**：三者都最终指向同一批文件，当前会话已人工全部读取；这是协议冲突，不是本轮发生了越权修改。

### R5-06 — CODEMAP / RBAC_MAP 守卫并未“全部挂 CI”，地图可在 required check 绿时漂移

- **级别**：P2
- **复核结论**：CONFIRMED
- **文件:行号证据**：
  - 操作页声明 readtax / counts / codemap / rbacmap “全部挂 CI”：`docs/ai-harness/README.md:12-14`。
  - CI 实际只执行 readtax + counts：`.github/workflows/ci.yml:123-126`。
  - CODEMAP 仍声明 activities 1206L、activity-registrations 1587L、attendances 1746L：`CODEMAP.md:14-15,21`；当前 `wc -l` 为 1241 / 1603 / 1781。
  - checker 仅在声明与实际差值绝对值 >100 时才报 WARN，且 WARN 不导致失败：`scripts/check-codemap.ts:260-315`。
- **影响**：地图变更或小步长期漂移可在 CI required check 绿色时合入；“全部挂 CI”会让维护者误以为无需显式运行两个 map checker。
- **当前边界**：本轮手工跑四件套均 0 FAIL；RBAC_MAP 的 206 码 / 74 controller / 360 operation 当前一致。这里不复报 god-service 体量债务，只报告守卫接线与精确地图事实漂移。

### R5-07 — v0.57 handoff OpenAPI 版本字段未随 bump

- **级别**：P2
- **复核结论**：CONFIRMED
- **文件:行号证据**：
  - package 为 0.57.0：`package.json:3`；Swagger builder 为 0.57.0：`src/bootstrap/apply-swagger.ts:20-24`；CHANGELOG 有 v0.57.0：`CHANGELOG.md:5`。
  - committed handoff OpenAPI 的 `info.version` 是 0.56.0：`docs/handoff/openapi.json:1`。
  - current-state 声称六处一致：`docs/current-state.md:6-11`。
  - v0.57 handoff 声称 `openapi.json` 已刷新且 version 随 bump：`docs/archive/handoff/v0.57.0.md:13-20`。
  - bump commit `805725a1` 只改 package 与 `apply-swagger.ts`，未改 handoff OpenAPI。
- **影响**：下载 / 生成客户端或做 release 追踪时，契约工件自报旧版本；当前事实入口与 handoff 验证快照同时失真。
- **当前边界**：该 JSON 已含 waitlisted 等 v0.57 schema、operation 仍为 360；不是整份回退到旧契约，而是版本元数据漏同步。`pnpm test:contract` 全绿，说明 contract snapshot 不守护 handoff export 的 `info.version`。

### R5-08 — lane 模式可由调用方绕过 E 档 global open-PR 闸

- **级别**：P3
- **复核结论**：CONFIRMED
- **文件:行号证据**：
  - 脚本只按 `--lane` 或 `SRVF_LANE` 非空切模式，无档位 / release 分支判定：`scripts/agent-preflight.sh:14-27`。
  - lane 模式把 open PR 从 hard fail 降为提示：`scripts/agent-preflight.sh:89-100`。
  - 脚本明确不在 CI 调用：`scripts/agent-preflight.sh:18-20`。
- **实跑**：`SRVF_LANE=0 pnpm agent:preflight` 仍打印 lane banner 并走 lane 分支。
- **影响**：E 档操作者若误带环境变量或主动传 `--lane`，脚本本身不会执行“全仓 0 open PR”强闸；只能依赖文字纪律与总控自觉。
- **为何是 P3**：脚本会显眼提示 E 档必须 global，且 clean / behind 两闸不降级；需要可信调用方误用，不是外部输入可触发的安全漏洞。

### R5-09 — F6 已修代码仍与 schema 四态注释漂移，未来新态不会 fail-close

- **级别**：P3
- **复核结论**：文档漂移 CONFIRMED；未来状态扩展导致恒等式失守 PLAUSIBLE
- **文件:行号证据**：
  - schema 仍写“statusCode 字典 4 态”，只列 pending/pass/reject/cancelled：`prisma/schema.prisma:852-855`。
  - DTO 已固定返回五态：`src/modules/activities/activity-participation.dto.ts:29-47`。
  - metrics 输入的 `statusCode` 是裸 `string`，switch 覆盖五态但无 default / exhaustive assert；total 直接取数组长度：`src/modules/activities/activity-participation-metrics.ts:10-14,49-80`。
- **当前结论**：全仓生产 registration 写路径只产生这五态，单数组快照下五项和恒等于 total；定向 E2E 断言通过，当前运行时无 bug。
- **未来风险**：若字典新增第六态而未同步 helper，total 会计入、分项静默漏计，第四轮 F6 以同一种形态复发；schema 注释会进一步误导下一次 schema / fixture 维护。

---

## 6. 排除清单核对

以下均已核对，未复报、未计 finding：

| 排除项                      | 本轮处理                                                                       |
| --------------------------- | ------------------------------------------------------------------------------ |
| #8 `btree_gist`             | accepted limitation；不复报                                                    |
| #10 / #12 附件内存分页      | accepted limitation；不复报                                                    |
| #19 RBAC 单进程 cache       | accepted limitation；不复报                                                    |
| #20 / #21 at-most-once 通知 | accepted limitation；不复报；R5-01 是派发前目标集漏算，不属于此项              |
| 28003 枚举                  | 已拍板例外；不复报                                                             |
| A-5 / A-6                   | 后续设计项；不复报                                                             |
| P1-21 / P1-22 / P1-23       | `NEXT_TASKS` backlog；不复报                                                   |
| 第四轮 F1–F6                | 不复述“已修”为 finding；只报告 R5-01、R5-09 两个修复质量新缺口，其余均记负结果 |

---

## 7. 验证记录

全部命令在独立 lane worktree 执行；DB 写仅发生于派生测试库 `app_test_review_5th`。

| 验证                                                | 结果                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                    | PASS                                                                                                               |
| `pnpm prisma:generate`                              | PASS                                                                                                               |
| `pnpm agent:preflight --lane`                       | PASS：clean / 0 open PR / behind 0                                                                                 |
| `pnpm docs:counts:check`                            | PASS：36 / 74 / 360 / 54 / 250 / 206 / 113 / 9 / 2                                                                 |
| `pnpm docs:readtax:check`                           | PASS                                                                                                               |
| `pnpm docs:codemap:check`                           | 0 FAIL；1 WARN（god-service 列表）/ 1 INFO；本报告另指出 <100L 声明漂移不触发 WARN                                 |
| `pnpm docs:rbacmap:check`                           | PASS：0 FAIL / 0 WARN                                                                                              |
| `pnpm agent:check:quick`                            | PASS：lint / typecheck / 102 unit suites / 2597 tests                                                              |
| 7 个定向 unit suites                                | PASS：115 tests（auth、CSV、attachment validator、activities、attendances、feedback query、participation query）   |
| 8 个定向 E2E suites                                 | PASS：210 tests（waitlist、activities、feedback、participation、dashboard、memberNo timing、refresh、attachments） |
| `pnpm test:contract`                                | PASS：659 tests / 2 snapshots / 360 routes                                                                         |
| App 2xx schema L3 递归扫描                          | PASS：41 operations / 0 forbidden property                                                                         |
| Activity cancel × concurrent create PostgreSQL 交错 | CONFIRMED R5-01：snapshot 0 / linkedCancelled 1 / final cancelled / missedRecipient true；probe 数据已删除         |
| Harness 纯内存反例                                  | CONFIRMED R5-02/R5-03/R5-04：regex 假正/假负、nested/empty/UTF-8、slug collision                                   |
| `SRVF_LANE=0 pnpm agent:preflight`                  | CONFIRMED R5-08：非空字符串 `0` 仍触发 lane mode                                                                   |
| handoff OpenAPI 解析                                | 360 operations；`info.version=0.56.0`，CONFIRMED R5-07                                                             |

测试中的 error 日志均来自既有“派发失败不阻断”负向用例，Jest 最终退出码为 0。

---

## 8. 本次未做

- 未修复 R5-01–R5-09；明显 bug 与文档冲突也只报告，修复须另行 review-then-fix 立项。
- 除本报告外，未修改任何 `src/**`、`test/**`、`prisma/**`、script、contract snapshot、handoff、reference、CODEMAP、RBAC_MAP、workflow、CHANGELOG 或历史报告。
- 未删除、放宽、改写任何既有测试断言；未新增临时测试文件。
- 未执行 `prisma migrate reset`、`prisma db push`、生产写入、数据回填或物理删除；E2E 仅对派生测试库 apply 已审查 migrations / reset fixture 数据。
- 未处理排除清单中的 accepted limitations / backlog。
- 未修改、清理、合并或关闭其他 lane 的分支、worktree 或 PR。
- 本 PR 只开出等待总控集成；**开 PR 即终态，不自行合并**。
