# SRVF 安全·并发·性能加固评审稿(Security / Concurrency / Performance Hardening Review)— 冻结

> **状态:冻结,不回改**(2026-07-13;立项源 = goal「安全·并发·性能加固线 —— 基于 2026-07-13 全仓审计 26 findings」,goal 文本即立项 + 拍板 + 执行授权;维护者已就三项设计边界**逐项拍板**〔D1–D3,见 §3〕,本稿是拍板记录的扩写冻结档,**非待拍板稿** —— runner 不再询问,按 §5 处置表直接实施)。
> **性质**:本文件是**冻结时刻**的核实与设计依据,**非当前事实源**;当前字段/接口/错误码事实以 `prisma/schema.prisma` + live `/api/docs-json` + `src/**` 为准;实施与本稿冲突时 **goal 原文优先**。file:line 为审计时点锚点(2026-07-13,v0.43.0 landing),**行号可能微移,runner 开工先据此重扫亲核**。
> **档位 A(docs-only,冻结稿本身)**;后续实施刀档位见 goal;A 档不进 CHANGELOG。
> **审计方法**:8 路并行子审计,逐条**以实际代码为准、不受文档/注释干扰**核实(维护者明确要求);每条给 verdict + 严重度 + file:line 证据 + 现网可利用性判断。
> **发版目标**:一版发完 → **v0.44.0**(下一未占用 minor,v0.43.0 已发则 v0.44.0;runner 亲核)。

---

## 0. TL;DR

1. **26 条 findings 逐条以实际代码核实:25 条属实、1 条(#16)不成立。** #16「撤权后旧权限继续生效」的笼统说法不成立 —— 三条常规撤权路径均**同步清缓存**,30min TTL 仅兜底;其残留风险已被 #17/18/19 精确覆盖。
2. **最严重簇 = RoleBinding 写侧接口(#1/2/25/26)**:新 `role-bindings` CRUD 面直接写 `RbacService` 判权读源表,却只复刻了入口权限码校验,**丢掉了旧 `user-roles` 路径的两道业务护栏**(角色分级 `canAssignRole` + 最后一个 ops-admin 保护),外加 PATCH 无审计 —— 越权提权 + 自锁 + 无审计切换。默认 seed 四码全绑 ops-admin,故爆炸半径 = 被盗/失控的 ops-admin;**无匿名可利用面**。
3. **次严重簇 = 审批/考勤并发覆盖(#3–8)**:全部 READ COMMITTED + read→`update({where:{id}})` 无状态条件、`version` 列明确不做乐观锁;**#6 可致静默数据丢失**(单据显示通过但明细已软删 → 贡献值算错)。一个守卫套路(条件式 `updateMany` on 期望 statusCode)一次修 #3/4/5/6。
4. **三项设计边界维护者已拍板(§3)**:① 一版发完 v0.44.0;② 通知丢失(#20/21)接受并记录(不破「不引 cron/queue」R-5 红线);③ 考勤重叠只加应用层锁(#8 数据库 btree_gist 排他约束不做,本仓首个 DB 扩展、托管库可用性未验、触发极罕见)。
5. **整条线 0 schema / 0 migration / 0 新端点**:并发与鉴权修复全是复用既有错误码(30101/30102/`*_STATUS_INVALID`)的「加守卫」;附件 DB 约束已排除。唯一码面增量 = +1 AuditLogEvent(`role-binding.update`)+ ≤1 附件 BizCode。
6. **现网风险总评:无阻断级 P0**。全部攻击面需已登录运营/管理员身份、当前单实例、身份禁用每请求查库不受缓存影响。属「趁没出事先加固」;唯二不建议久拖:RoleBinding 最后管理员自锁(#2)+ 考勤 #6 静默数据丢失。

---

## 1. 元信息与基线证据

| 项 | 值 |
|---|---|
| 审计基线 | main HEAD `dc9efaa5`(#564)之后、v0.43.0 landing 期;审计时 worktree HEAD == origin/main,`git status` clean,`package.json` = 0.42.0 |
| v0.43.0 状态 | 功能已入 main(#564 证书闭环刀A / #565 team-join 刀B);发版 bump **PR #567 open** |
| 审计日期 | 2026-07-13 |
| 审计范围 | 用户提交的 26 条 findings(安全 / 并发 / 性能 / 可靠性),8 簇 |
| 方法 | 8 路并行子审计,读实际代码逐条核实,file:line 取证;不采信 CLAUDE.md / 注释的声明 |
| 门禁提醒 | 本加固线 **preflight 硬门禁 = 0 open PR**(#567 已合、v0.43.0 已发)后方可开工 |

---

## 2. 结论矩阵(26 findings 全景)

> 严重度 = 现网可利用性 × 后果;**均非匿名可利用**(除 #9 无需登录)。处置列对应 goal DoD 项(R1–R10)。

| # | 问题 | 结论 | 严重度 | 处置(goal) |
|---|---|---|---|---|
| 1 | RoleBinding create 可绑任意/GLOBAL 高权角色给自己或他人 | ✅ 属实 | 高 | 改 · R1 |
| 2 | 删除/撤销绕过「最后一个 ops-admin」保护 | ✅ 属实 | 高 | 改 · R1 |
| 25 | PATCH 更新完全不写审计 | ✅ 属实 | 中 | 改 · R1 |
| 26 | 高权绑定可无审计地重新激活(ENDED→ACTIVE) | ✅ 属实 | 中 | 改 · R1 |
| 3 | 活动报名 通过/驳回 并发覆盖 | ✅ 属实 | 高 | 改 · R2 |
| 4 | 考勤一级审批 并发覆盖 | ✅ 属实 | 中 | 改 · R2 |
| 5 | 考勤终审 并发覆盖(带贡献值/通知副作用) | ✅ 属实 | 中-高 | 改 · R2 |
| 6 | 审批并发 → 单据通过但明细已软删(静默数据丢失) | ✅ 属实 | 高 | 改 · R2 |
| 7 | 时间重叠仅应用层「先查后插」可被并发绕过 | ✅ 属实 | 低-中 | 改(应用层锁)· R8 |
| 8 | 数据库无时间重叠兜底约束 | ✅ 属实 | 低 | **接受记录** · R10 |
| 9 | 公开 logout 可刷垃圾审计 | ✅ 属实 | 低-中 | 改 · R5 |
| 10 | 附件列表 先全量查再内存分页 | ✅ 属实 | 低(规模) | **接受记录** · R10 |
| 11 | 附件列表 certificate 分支 N+1 | ✅ 属实 | 低-中(规模) | 改 · R9 |
| 12 | by-owner 同样全量再分页 | ✅ 属实 | 低(有界) | **接受记录** · R10 |
| 13 | CSV 导出一次性全量入内存 | ✅ 属实 | 中 | 改 · R7 |
| 14 | StreamableFile 并非流式(整个 Buffer) | ✅ 属实 | 中 | 改 · R7 |
| 15 | CSV 公式注入 | ✅ 属实 | 中 | 改 · R4 |
| 16 | 撤权后旧权限继续生效(笼统说法) | ❌ **不成立** | — | 无代码 · R10 |
| 17 | 清缓存失败被静默吞掉 | ✅ 属实 | 中 | 改 · R3 |
| 18 | 删角色后不清持有者缓存 | ✅ 属实 | 中 | 改 · R3 |
| 19 | 多实例无法跨节点失效 | ✅ 属实(潜在) | 今日低 | **接受记录** · R10 |
| 20 | 业务成功后通知可能永久丢 | ✅ 属实 | 低 | **接受记录** · R10 |
| 21 | 提交后崩溃丢通知 | ✅ 属实 | 低 | **接受记录** · R10 |
| 22 | 上传只信客户端声明的 MIME | ✅ 属实 | 中 | 改 · R6 |
| 23 | confirm-upload 不校验真实类型 | ✅ 属实 | 中 | 改 · R6 |
| 24 | 非图片可伪装成图片入库 | ✅ 属实(多为潜在) | 中 | 改 · R6 |

**统计**:属实 25 / 不成立 1;改 = 15 条(R1–R9)/ 接受记录 = 10 条(R10)/ 不成立 = 1 条。

---

## 3. 维护者拍板(2026-07-13,冻结)

- **D1 发版方式 = 一版发完**:一个 goal,P1→P2→P3 分批,合成一个版本(v0.44.0)。不单独抢发 P1 —— 全部需已登录运营/管理员身份才能触发、当前单实例、无匿名可利用面,无抢发必要。
- **D2 通知丢失(#20/21)= 接受并记录**:不写补发代码。涉及两处仅站内提醒(写同一数据库、失败极罕见)、非权威数据、业务结果已安全落库可另查;做「可靠补发」须引队列/后台任务,正撞仓库明令的 `不引 cron/queue`(R-5)红线,为很小收益破红线不值。
- **D3 考勤时间重叠(#7/#8)= 只加应用层锁**:#7 按 memberId 串行化堵并发;#8 数据库 btree_gist 排他约束**不做** —— 本仓首个 DB 扩展、托管库(腾讯云)可用性未验、且触发本就罕见(同一人同时录两单)。

---

## 4. 逐条核实(file:line 证据;审计时点锚点)

### 4.1 簇 A — RoleBinding 写侧越权/自锁/无审计(#1/2/25/26)· R1 · P1

根因:`role-bindings` CRUD 面直接写 `RoleBinding` 表(= `RbacService` 判权唯一读源:`principalType=USER, scopeType=GLOBAL, status=ACTIVE, deletedAt=null`),却只复刻入口码校验,丢掉旧 `user-roles` 路径两道护栏。默认 seed 四 `role-binding.*` 码全绑 ops-admin。

- **#1 越权** — [role-bindings.service.ts:589](../../../src/modules/role-bindings/role-bindings.service.ts) `create()` 仅 `assertCanOrThrow('role-binding.create.record')` + `validateScopeShapeOrThrow`(:152 显式允许 GLOBAL);全服务无 `canAssignRole` 等价、无「给自己」检查、无角色分级比较。旧路径护栏见 [user-roles.service.ts:129](../../../src/modules/permissions/user-roles.service.ts)(`canAssignRole`,ops-admin 只能分配非 ops-admin,启用于 :225)。
- **#2 自锁** — [role-bindings.service.ts:738](../../../src/modules/role-bindings/role-bindings.service.ts) `remove()` 软删无持有人计数;`update()` 同样可把最后一个 ops-admin 绑定改 ENDED/SUSPENDED 无守卫。旧路径护栏见 [user-roles.service.ts:315](../../../src/modules/permissions/user-roles.service.ts)(`LAST_OPS_ADMIN_PROTECTED` 30101)。
- **#25 无审计** — [role-bindings.service.ts:687](../../../src/modules/role-bindings/role-bindings.service.ts) `update()` 改 status/startedAt/endedAt/note 后直接返回,无 `auditLogs.log`(注释「不写 audit」);同文件 `create()`(:648)/`remove()`(:754)均写审计。`AuditLogEvent` 联合类型有 `role-binding.create`/`.revoke` 无 `.update`。
- **#26 无审计重激活** — `update()` 接受 status→ACTIVE(仅拒 endedAt 已过期);[rbac.service.ts:85](../../../src/modules/permissions/rbac.service.ts) 判权只滤 `status=ACTIVE`(**不看 endedAt/startedAt**),故重激活即刻生效 + 触发缓存清理(:730),全程零审计。

### 4.2 簇 B — 审批/考勤并发覆盖(#3–8)· R2(#3/4/5/6)+ R8(#7)+ R10(#8)· P1/P2

所有转换事务 = Prisma 交互式 `$transaction` 回调 + 无 `isolationLevel` → Postgres 默认 **READ COMMITTED**;全仓 grep 无 Serializable。

- **#3** — [activity-registrations.service.ts:766](../../../src/modules/activity-registrations/activity-registrations.service.ts) approve/reject 均 read→`update({where:{id}})` 无 statusCode 条件;唯一锁 `SELECT ... FOR UPDATE`(:761)只在 approve 且 capacity≠null 时锁 Activity 行(护容量非护状态)。两操作者各读 pending → 各自状态机放行 → 后写者无条件覆盖 → 双审计 + 矛盾通知。
- **#4** — [attendances.service.ts:1153](../../../src/modules/attendances/attendances.service.ts) 一级 approve/reject 同模式;`version Int @default(1)` schema 注释「Q-D8 不做乐观锁」,approve/reject 从不读比。
- **#5** — 终审 finalApprove(:1281)/finalReject(:1488)同缺守卫;finalApprove 有已提交副作用:`eventPlaceholder('attendance.recorded')`(:1298,发贡献值)+ 事务外派发通知(:1348/1352)。
- **#6(最伤)** — reject 软删明细 [attendances.service.ts:1213](../../../src/modules/attendances/attendances.service.ts)(`updateMany deletedAt`);无原子守卫下,reject 先软删全部明细并置 rejected,approve 读旧快照后 `update sheet WHERE id` 覆盖 → 单据回到 pending_final_review 而明细已提交软删 → 后续 finalApprove 置 APPROVED 但 `attendance.recorded` 读 notDeleted 明细为空 → **零贡献入账、无人通知**。
- **#7** — [time-overlap-policy.ts:41](../../../src/modules/attendances/time-overlap-policy.ts) `findMany` 命中即抛;submit(:533)/edit(:992)调用前;纯 SELECT-then-INSERT,冲突行尚不存在,连 FOR UPDATE 也抓不到幻影。
- **#8** — `AttendanceRecord` 仅 PK+FK+普通索引(`@@index([memberId, deletedAt])` 是性能索引);全 `prisma/migrations/**` grep 无 `EXCLUDE|gist|tstzrange|btree_gist` DDL。**拍板 D3:不做**。

一个守卫套路修 #3/4/5/6:条件式 `tx.updateMany({where:{id, statusCode:期望值}})`,`count===0` 抛既有 STATUS_INVALID 码;或镜像 :761 的 `FOR UPDATE` 先例。

### 4.3 簇 C — 公开 logout 审计污染(#9)· R5 · P1

- [auth.controller.ts:104](../../../src/modules/auth/auth.controller.ts) `@Public() @Post('logout')` 无 throttle 装饰;[throttler-biz.guard.ts](../../../src/common/guards/throttler-biz.guard.ts) `shouldSkip` 无 throttle 元数据即跳过 → 应用层无限流(刻意,防挤占正常用户 logout 配额)。
- [auth.service.ts:364](../../../src/modules/auth/auth.service.ts) `auditLogs.log('auth.logout')` 在 `if (row && ...)` 命中块**之外**,garbage token(`found:false`,actor/resource=null)仍写一行。`audit_logs` 无 update/delete API(R1 红线)→ 垃圾行不可经 API 清。
- **修复有同文件先例**:[auth.service.ts:220](../../../src/modules/auth/auth.service.ts) `refresh()` 明确「token 不存在不写 audit」;logout 与自家 refresh 范式不一致。⚠️ auth/CLAUDE.md 记 `extra.found` 为现状,改动属 D 档 + security-review。

### 4.4 簇 D — 附件列表性能(#10/11/12)· R9(#11)+ R10(#10/12)· P3

- **#10** — [attachments.service.ts:512](../../../src/modules/attachments/attachments.service.ts) `list()` `findMany` 无 skip/take → 全量物化,`:518-529` 逐行 `canViewAttachment` + `.slice()` 内存分页;成本随命中总数非页大小。
- **#11(先咬)** — 逐行 `canViewAttachment` → `buildRbacResourceAndScope`(:264)对 **certificate** ownerType 每行发 `certificate.findFirst`(member/activity/content 无额外查)。注:`rbac.can()` **非 N+1**(按 user.id 缓存,[rbac.service.ts:82](../../../src/modules/permissions/rbac.service.ts))。**唯一 P3 代码项**:证书 ownerId 批量化(collect→`findMany in`→Map)。
- **#12** — [attachments.service.ts:650](../../../src/modules/attachments/attachments.service.ts) `listByOwner()` 同模式,但锁定单 `(ownerType,ownerId)`、实际数据量极小 → 现规模近装饰性。**接受记录**。
- 判断:小型救援队现规模基本理论问题,行 payload 仅元数据、查询走索引;#11 随证书附件累积最先显现。

### 4.5 簇 E — CSV 导出(#13/14/15)· R4(#15,P1)+ R7(#13/14,P2)

两条同构手写路径:活动报名(`activity-registrations.service.ts` `exportCsv`)+ 招新申请(`recruitment-applications-query.service.ts` `exportApplicationsCsv`)。

- **#13** — [activity-registrations.service.ts:1139](../../../src/modules/activity-registrations/activity-registrations.service.ts) `findMany` 无 skip/take;招新路径更糟 [recruitment-applications-query.service.ts:121](../../../src/modules/recruitment/recruitment-applications-query.service.ts) **无 select 投影**且 `cycleId` 可缺省 → 整表全列导出;下游再堆 `filtered`/`dtos`/`lines[]`/joined string。
- **#14** — controller `Buffer.from('﻿'+csv)`(活动 :150/157、招新 :134/140)把完整串再拷成完整 Buffer;峰值同时存活 4–6 份完整数据 → 并发/大数据量 OOM。
- **#15** — `escapeField` 仅处理 `, " \n \r`(RFC4180),不中和首字符 `= + - @`/Tab;`display_name`(members.dto.ts:168 仅 `@IsString/@MaxLength`)、`real_name`(OCR/申请人/admin 自由文本)均攻击者可控 → 存储型 → 管理员导出触发的经典 CSV 公式注入。修复:首字符判 → 前缀 `'`,前置于 RFC4180 引号;两处抽共享 util。

### 4.6 簇 F — RBAC 缓存(#16/17/18/19)· R3(#17/18,P1)+ R10(#19,P3)+ #16 不成立

- **#16 不成立** — TTL [app.config.ts:412](../../../src/config/app.config.ts) `RBAC_CACHE_TTL_SECONDS` 默认 1800;常规撤权**同步清缓存**:user-role 撤销 [user-roles.service.ts:358](../../../src/modules/permissions/user-roles.service.ts)、role-binding 删 [role-bindings.service.ts:771](../../../src/modules/role-bindings/role-bindings.service.ts)、role-permission 撤 [role-permissions.service.ts:209](../../../src/modules/permissions/role-permissions.service.ts)。笼统「撤权即残留」为假;残留=#17/18/19。
- **#17 属实** — [rbac-cache.service.ts:91](../../../src/modules/permissions/rbac-cache.service.ts) `invalidateAllUsersWithRole` 持有人查询失败仅 `logger.warn` 后正常返回;调用方 `role-permissions.service.ts:209→212` 事务已提交后仍返 200 → DB 已撤但缓存仍旧,分叉 ≤ 一个 TTL。修:撤权方向失败退 `invalidateAll()`(fail-closed)。
- **#18 属实(面最广)** — [rbac-roles.service.ts:268](../../../src/modules/permissions/rbac-roles.service.ts) `softDelete()` 无任何缓存失效,构造函数(:37)**未注入 `RbacCacheService`**;角色软删=对全体持有者的批量撤权却零 evict。同类洞:`PermissionsService.delete`([permissions.service.ts:191](../../../src/modules/permissions/permissions.service.ts))。修:注入 + commit 后 `invalidateAllUsersWithRole`。
- **#19 属实但潜在** — [rbac-cache.service.ts:32](../../../src/modules/permissions/rbac-cache.service.ts) 进程内 `Map`,无 Redis/pub-sub;但 [deployment.md:8](../../../docs/deployment.md) 记当前**单实例**且已列扩容前清单,身份禁用(`JwtStrategy` 每请求查 status/deletedAt)不受此缓存影响。今日零危害。**接受记录**。

### 4.7 簇 G — 通知可靠性(#20/21)· R10 · P3 · 拍板 D2 接受记录

- 四业务生产者同型:业务 `$transaction` 先 commit → 事务外、仅 log 的 try/catch 里派发([activity-registrations.service.ts:797/860](../../../src/modules/activity-registrations/activity-registrations.service.ts)、[attendances.service.ts:1348/1352](../../../src/modules/attendances/attendances.service.ts));`dispatchTargeted` = 独立 `notification.create`([notification-dispatcher.ts:51](../../../src/modules/notifications/notification-dispatcher.ts))。全仓无 outbox/retry/DLQ/backfill(唯一 `@Cron`=生日批)。
- **实际影响低**:两审计流程均 `channels:[IN_APP]` → 「发送」=同库单条 INSERT,失败罕见;载荷为非权威提醒;失败易发的 wechat/sms 不在此二流程。**拍板 D2:不写代码**,记 NEXT_TASKS + notifications/CLAUDE.md 台账(触碰 R-5 红线,须维护者拍方可建异步基建)。

### 4.8 簇 H — 附件 MIME/内容校验(#22/23/24)· R6 · P2

预签名直传架构:generate-url → client PUT → confirm-upload。

- **#22** — [attachments.service.ts:739](../../../src/modules/attachments/attachments.service.ts) `assertMimeAllowed(dto.ownerType, dto.mime)`,扩展名(:747)、预签名 Content-Type(:771)、入库 mime(:760)全driven by 客户端 `dto.mime`;URL 生成期无字节,合理,但**后续从不复核**。
- **#23** — [attachments.service.ts:823](../../../src/modules/attachments/attachments.service.ts) confirm-upload 注释「contentType 不校验」,仅查存在(:810)+ 大小(:819);不读 head/魔数、不解码图片。
- **#24** — 22+23 必然:声明 image/jpeg 传任意字节 → 入库 mime=image/jpeg + `.jpg`。服务回读 [attachments.service.ts:108](../../../src/modules/attachments/attachments.service.ts) `resolveAccessUrl` **无 contentDisposition** → 内联;经公开 `open/v1/contents` 匿名可达。**多为潜在、非当下 live XSS**(需认证上传、开箱白名单仅 image/pdf、COS 返 pinned image content-type 已defang HTML-as-JPG)。**尖锐边界**:`image/svg+xml` 可执行脚本、未进黑名单([attachment-validation.ts:35](../../../src/modules/attachments/attachment-validation.ts) `SYSTEM_MIME_BLOCKLIST_EXACT`),一旦运营白名单即公开存储型 XSS;另 COS 是否绑定签名 Content-Type 未在服务端复核。修:黑名单 +svg/html/xhtml(极小高值)+ confirm-upload 魔数回读 fail-close(零新依赖,手写签名表)。

---

## 5. 处置汇总与强不变量

- **改(15 条,R1–R9)**:见 §2 处置列 + goal DoD。
- **接受记录(10 条,R10,0 代码)**:#8(拍板 D3)、#10/#12(现规模理论)、#16(不成立,记结论)、#19(deployment.md:8 已记)、#20/#21(拍板 D2)。汇入 `docs/ai-harness/NEXT_TASKS.md` + 相关 CLAUDE.md,各注 finding 号 + 为何暂不做。
- **强不变量(每刀自证)**:0 schema / 0 migration;0 新端点 → 权限码/`EXPECTED_ROUTES`/controller/模块/角色 计数全不变;+1 AuditLogEvent(`role-binding.update`);≤1 新 BizCode(仅附件魔数不符);`SYSTEM_MIME_BLOCKLIST_EXACT` +3;零新依赖;判权核心(`RbacService.can()`/`AuthzService`)零 diff。
- **⚠️ 行为变更(供 CHANGELOG 置顶)**:R1 越权/自锁 denials(30102/30101)· R2 并发败者 STATUS_INVALID · R4 CSV 单元格前缀 `'` · R5 未知 token logout 不写审计 · R6 confirm-upload 拒伪装文件 + svg/html 恒拒。

---

## 6. 关联

- 立项 goal:「安全·并发·性能加固线 —— 基于 2026-07-13 全仓审计 26 findings」(本稿 = 其 F0 冻结评审稿)。
- 前序全仓 review(report-only 体例参照):`full-repo-systematic-review-v0.26.0.md` / `full-repo-systematic-review-v0.34.0.md` / `full-repo-first-principles-adversarial-review-v0.38.0.md`。本稿区别:**已含维护者拍板(§3),非 report-only,是实施设计依据**。
