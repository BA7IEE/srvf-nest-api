# SRVF 系统性安全收口评审稿(Systematic Security Hardening Review, findings 1–15)— 冻结

> **历史证据,非当前执行约束**。当前事实读 [`docs/current-state.md`](../../current-state.md);逐笔变更读 CHANGELOG `## v0.45.0` / `## v0.46.0`;handoff 见 [`v0.45.0.md`](../handoff/v0.45.0.md) / [`v0.46.0.md`](../handoff/v0.46.0.md)。
>
> 本稿冻结「承接 v0.44.0 审计的第二轮系统性安全核实」全过程:15 findings 逐条核实结论 + 维护者拍板 + 七刀收口落点 + 四类底层规则强不变量。接续 [`security-concurrency-hardening-review-v0.44.0.md`](security-concurrency-hardening-review-v0.44.0.md)。

---

## 0. TL;DR

- **起因**:v0.44.0 加固发版后,维护者提出核心判断——*「过去每发现一个漏洞就在某个具体接口上补一刀;没把『权限委派』『状态迁移』『并发计数』『文件验证』做成所有入口必经的统一底层规则。因此新接口修好、旧接口还能绕;创建修好、更新还能绕;审批修好、编辑还能撞。」* 并给出 15 条具体怀疑。
- **核实法**:6 路并行只读 agent 逐 finding 读**实际代码**(非文档)+ 精确 file:line 证据;每刀合入后主会话以 **commit-diff 元核验**(4 核验点/刀,非 stale grep)。
- **结论**:15 findings **全部属实**(无一不成立;第六刀核实时另揪出 `updateRole`/`create` 亦无审计、members 轴同类残留各一)。
- **收口**:七刀 #578–587,均主会话元核验 PASS;findings 1–15 除 **#14(接受)/#12(待 waiver)** 外全落地。
- **发版**:🎉 v0.45.0(2026-07-13;findings 1–7 + 队员轴残留)+ 🎉 v0.46.0(2026-07-14;findings 9/10/11/15/8c/13 + members 残留)。
- **本轮成果 = 四类底层规则各收成一个单一强制原语**(见 §5),七刀无一散补丁。

## 1. 元信息与基线证据

- **核实基线**:v0.44.0(main `8a0a51a1`);随刀推进锚点 `cf9379bd`(#578)→`d9d71cf8`(#579)→`359c3e24`(#580)→`99d3f22e`(#581)→`1513336a`(#585)→`edde3d42`(#586)→`d93bfc12`(#587)。
- **核实产物**:15 findings 分 6 组并行核实,每组返 VERDICT + file:line + UNIFIED FIX SHAPE。
- **元核验法**:`git diff <prev-squash>..<cut-squash>` 比对,每刀 4 核验点(单一原语落位 / 行为锁 0 回归 / 计数 / 真跑真断言 e2e)。
- **计数最终态(v0.46.0,亲核)**:端点 **336** / 权限码 **205** / biz-admin **81** / org-admin **60** / ops-admin **96** / controller **66** / 模块 **35** / 角色 **7** / BizCode **232** / migration **49**(v0.44.0 的 48 + 第 49 `settings_singleton_constraints`)/ AuditLogEvent **111**(v0.44.0 的 99 + 第六刀 +11 + 第七刀 +1)。

## 2. 结论矩阵(15 findings 全景)

| # | 主张摘要 | 核实 | 收口 | 版本 |
|---|---|---|---|---|
| 1 | 角色委派可绕(漏 6 保留码 / 先绑后加权 / 旧 user-roles 路径) | 属实 | #578 | v0.45.0 |
| 2 | RoleBinding PATCH/preview 不重跑委派检查 | 属实 | #578 | v0.45.0 |
| 3 | ops-admin 可软删 ops-admin 角色本身 | 属实 | #578 | v0.45.0 |
| 4 | 最后管理员保护非事务(系统级 / 旧路径 / 覆盖窄) | 属实 | #579(+#581 队员轴) | v0.45.0 |
| 5 | 全局 RBAC 忽略 startedAt/endedAt,与 authz 不一致 | 属实 | #579 | v0.45.0 |
| 6 | 大量状态机仍「读态→裸 id update」竞态 | 属实 | #580 | v0.45.0 |
| 7 | 已核验证书改核心字段不回退信任;verify/reject 竞态 | 属实 | #580 | v0.45.0 |
| 8c | 短信码弱哈希(裸 sha256、无 pepper、不绑 phone/purpose) | 属实 | #587 | v0.46.0 |
| 9 | 旧附件 create 绕过内容/魔数校验 | 属实 | #585 | v0.46.0 |
| 10 | 招新身份证/签名/证书图只信客户端 MIME | 属实 | #585 | v0.46.0 |
| 11 | 附件 expireAt 不参与下载授权 | 属实 | #585 | v0.46.0 |
| 12 | 通知 commit 后丢失窗口(无 outbox) | 属实 | **⏸ 待 waiver** | — |
| 13 | Storage/SMS(+wechat/realname)单例仅代码层 | 属实 | #587 | v0.46.0 |
| 14 | 附件 / 旧 role-binding 列表全量后内存分页 | 属实 | **⏸ 接受** | — |
| 15 | 用户状态/软删 + settings 凭证重置/配置改动缺持久审计 | 属实 | #586(+#587 members 残留) | v0.46.0 |

> 核实副产物(未在原 15 条,同类补齐):#15 核实时发现 `users.updateRole`/`create` 亦无审计(第六刀一并补);members 轴 `updateAccountStatus`/ops-admin 保护缺口(第一/七刀队员轴收口)。

## 3. 维护者拍板(冻结)

- **委派(1/2/3)**:① 授予 `rbac.*`/`role-binding.*` 控制面权限码收窄为**仅 SUPER_ADMIN**;② **全部 7 个内置角色**禁止 API 删除(代码常量 `PROTECTED_ROLE_CODES`,不加 schema 列)。
- **任期/末位(4/5)**:① rbac 统一认任期(过期/未来绑定三处一致失效);② 最后管理员**全覆盖 + 一把共享 advisory 锁**串起用户降级/禁用/软删 + binding 撤销 + 旧路径 + 队员轴。
- **状态迁移/证书(6/7)**:证书核心字段编辑 → **回退 pending 重审 + 清核验三字段**(verified/rejected 统一)。
- **控制面审计(15)**:**系统性全覆盖**(users role/status/softDelete + 4 settings update/reset),推翻 D-PR3-2 / D-SMS-9 / storage §6.6.5 挂起;🔴 凭证明文/密文永不入 audit。
- **文件验证(9/10/11)**:旧 create **原地加固**(补 headObject+魔数,端点保留、0 契约变更);expireAt **下载生效**。
- **pepper/单例(8c/13)**:短信码 HMAC+scrypt-pepper 绑 phone:purpose;settings 单例覆盖**全 4 个**(partial-unique on constant,dedup 保最新 + 全事务)。
- **接受/不做**:#14 附件分页维持接受(权限内存过滤→DB 分页是有正确性风险重构,现规模有界);#12 outbox **未获 waiver**(撞「无 queue/cron」红线)。

## 4. 逐条核实与收口(簇 → PR)

### 4.1 委派收口(#1/2/3)· #578 · v0.45.0
单一 `isControlPlanePermissionCode`(`rbac.*` ∪ `role-binding.*` ∪ 6 SA-only 保留码)+ 单一 `RoleDelegationPolicy`,统一覆盖 role-bindings create/preview/特权 update + user-roles assign/revoke(非 SA 拒 `30102`,SA 短路);role-permissions 非 SA 分配控制面码整批拒 `30103`;7 内置角色删除拒新增 `PROTECTED_ROLE_DELETE_FORBIDDEN=30104` + seed 漂移哨兵。BizCode 231→232。

### 4.2 任期 + 最后管理员(#4/5)· #579 · v0.45.0
共享 `role-binding-validity`(`isWithinTerm` + `effectiveGlobalUserRoleBindingWhere`,边界 `lte/gte` 与 `<=/>=` 逐字一致):`RbacService` 两读改用、`AuthzService` 删本地 `isWithinTerm` 改 import。单一 `LastAdminProtectionPolicy`(锁键 `users:last-super-admin` / 复用 `role-bindings:last-ops-admin`)覆盖 SUPER_ADMIN 降级/禁用/软删 + ops-admin 撤绑定(role-bindings×2 + user-roles) + 禁用/软删最后 ops-admin 用户(users×2);`getActiveOpsAdminHolderIds` 要求绑定 active **且** 用户 active。0 BizCode。

### 4.3 状态迁移 + 证书信任(#6/7)· #580 · v0.45.0
单一公共 `claimAtStatus`(no-op status `updateMany` + `count===0` throw;**只加并发 claim、不判迁移合法性**)16 call site 覆盖 activities/registrations/attendances/certificates/recruitment〔withdraw 读入事务〕/team-join;各状态机 from→to 矩阵零改。证书 `coreFieldEdited && certStatusCode!==pending` → 回 pending + 清 verifiedBy/At/Note。0 BizCode。

### 4.4 队员轴最后 ops-admin 残留(finding-4 同类)· #581 · v0.45.0
`MembersService` 三削权门(`updateAccountStatus` DISABLED / `offboard` / `reopenAccount`)复用 #579 `assertCanDeactivateOpsAdminUser` + 同锁键;bind/unbind benign 不涉;SUPER_ADMIN 已被 §F&A-1 role 护栏隔离。

### 4.5 文件验证统一收口(#9/10/11)· #585 · v0.46.0
单一 `AttachmentContentValidator`(`validateFromObject` headObject+真实 size+blocklist+魔数 / `validateFromBuffer`,复用 `attachment-signature`+`attachment-validation`)覆盖 6 入口:confirm-upload / legacy create(原地加固)/ 招新 id-card·signature·证书图 / realname OCR。`resolveAccessUrl(key,expireAt)` 单点检查过期(返 null)+ public 列表 filter。0 migration / BizCode +0(复用 `13016`)/ 336 routes 不变。

### 4.6 控制面审计补全(#15)· #586 · v0.46.0
users `updateRole`/`updateStatus`/`softDelete` + storage/sms/wechat/realname settings `updateSettings`/`resetCredentials` 共 11 处**写行同事务内** `auditLogs.log(...,tx)`。🔴 凭证重置 audit payload 仅 `event/resourceType/resourceId/meta:auditMeta/tx`——e2e 用合成密钥断言 `not.toContain(明文)` **且** `not.toContain(密文)` + `not.toMatch(/secret|credential|password|token/i)`。AuditLogEvent 99→110(+11);0 migration / BizCode +0。

### 4.7 pepper + 单例 + members 审计(#8c/13 + 残留)· #587 · v0.46.0
① 8c:`sms-code-hash.util` `createHmac('sha256', scrypt(SMS_ENCRYPTION_KEY, 独立 salt))` update `phone:purpose:code`;create+verify 全替换裸 sha256,明文/pepper 不入库,env 缺失 fail-fast。② 13:**第 49 migration** 四 settings 表 `CREATE UNIQUE INDEX ... ON x ((true))` 单例;**dedup 保 updatedAt DESC 最新行、只删 row_number>1、RAISE NOTICE 记删除数、四表 LOCK+dedup+建索引同一 BEGIN/COMMIT**(no silent loss、干净库 no-op);服务改 upsert。③ members:`member.account.status-change` in-tx audit。migration 48→49;AuditLogEvent 110→111;BizCode +0。

### 4.8 接受 / 待 waiver(#14/#12)
- **#14**:附件 `list`/`listByOwner` 权限**内存逐行过滤**后 `slice`,DB 分页须把 RBAC 谓词下推 SQL(有正确性风险重构);旧 role-binding `list` 无分页但已有 `/page` 兄弟端点。**维持接受**,规模/延迟触顶再单独设计,记 NEXT_TASKS。
- **#12**:业务 commit 后事务外直调 dispatch + 吞异常,无 outbox。修复需 outbox 表 + 中继扫描,**撞「无 queue/cron」红线**;未获 waiver,记 NEXT_TASKS。

## 5. 处置汇总与强不变量(四类底层规则 → 单一强制原语)

| 类别 | 单一原语(唯一门) | 覆盖入口 |
|---|---|---|
| **权限委派** | `isControlPlanePermissionCode` + `RoleDelegationPolicy` + `PROTECTED_ROLE_CODES` | role-bindings create/preview/update · user-roles assign/revoke · role-permissions 授码 · 角色删除 |
| **并发计数** | `role-binding-validity`(任期)+ `LastAdminProtectionPolicy`(一把共享 advisory 锁) | rbac/authz 判权 · 最后 SUPER_ADMIN / ops-admin 全路径(含队员轴) |
| **状态迁移** | `claimAtStatus`(CAS) | 16 处状态写(活动/报名/考勤/证书/招新/入队) |
| **文件验证** | `AttachmentContentValidator` + `resolveAccessUrl` expireAt 单点 | 6 文件落库/落存储/OCR 入口 · 全部下载出口 |
| **控制面审计** | in-tx `auditLogs.log(...,tx)` 范式 | 11 处高危控制面写(凭证不入 audit) |
| **凭据哈希** | `hashSmsVerificationCode`(HMAC + scrypt-pepper) | 短信码 create/verify |
| **配置单例** | 四 settings 表 partial-unique on constant | 首配并发 |

**治理原则(冻结)**:不变量下沉到能强制的最低层——DB 约束 > 单一强制服务/原语 > per-handler 检查。per-handler 防护面积 = 处理器数量(每新增一个入口即一个洞);单一原语 / DB 约束防护面积 = 1。**新增同类入口必须走这些门,不得再散补丁**;每类配漂移/并发/特征化测试守回归。

## 6. 关联

- CHANGELOG `## v0.45.0`(2026-07-13)/ `## v0.46.0`(2026-07-14);handoff [`v0.45.0.md`](../handoff/v0.45.0.md) / [`v0.46.0.md`](../handoff/v0.46.0.md);current-state §1/§2。
- 前置:[`security-concurrency-hardening-review-v0.44.0.md`](security-concurrency-hardening-review-v0.44.0.md)(v0.44.0 首轮 26 findings)。
- 未竟债务:[`docs/ai-harness/NEXT_TASKS.md`](../../ai-harness/NEXT_TASKS.md)(#14 附件分页 / #12 通知 outbox)。
- 授权范式:AGENTS §294(受保护文档 surgical 编辑);§0 铁律不被本稿覆盖。
