# 第三轮全仓 review —— 第一性原理 × 对抗性 × 系统性(v0.38.0 基线,report-only)

> **性质**:冻结评审报告,**只报告不修复**(report-only 铁律;`src/` `prisma/` `test/` 零改动)。
> 修复由维护者读报告后另立 review-then-fix goal(镜像第二轮 #484→#485–#491/#495 先例)。
> **档位 A(docs-only)**;不进 CHANGELOG。前两轮冻结稿:
> `full-repo-systematic-review-v0.26.0.md`(第一轮 #399)/ `full-repo-systematic-review-v0.34.0.md`(第二轮 #484)/ `pre-go-live-readiness-review-v0.35.0.md`(上线就绪 #497)。

---

## ✅ 修复落地状态(2026-07-10;review-then-fix goal「第三轮 review findings 收口」)

本报告 report-only;findings 经 review-then-fix goal 分四刀落地 + 发版 **v0.39.0**,状态汇总如下(计数亲核一致):

| finding | 级 | 处置 | PR |
|---|---|---|---|
| **F&A-1 + A-4** 队员轴 bind/status/reopen 绕过 last-SA / manage-user 护栏 | P1(边界 P0) | ✅ **已修**:bind 拒非 USER / 非 ACTIVE 目标(15034/15035)+ status/reopen 前置校验 linked `role===USER`(15036)+ true-up `:817-819` 假前提注释 | [#527](https://github.com/BA7IEE/srvf-nest-api/pull/527) |
| **F&A-2** RBAC 授权配置写面无 audit + `rbac-roles:243` 僵尸注释 | P2 | ✅ **已修**:三服务 8 写点直写 auditLog(+8 AuditLogEvent)+ 删僵尸注释 + `security.md` config-audit 权威规则成文 | [#528](https://github.com/BA7IEE/srvf-nest-api/pull/528) |
| **F&A-3** member-profiles 档案面明文 PII(待复核) | P3 | ✅ **已修(取掩码分级)**:新码 `member-profile.read.sensitive`,`documentNumber`/`mobile` 默认掩码(197→198 码 / biz-admin 73→74) | [#529](https://github.com/BA7IEE/srvf-nest-api/pull/529) |
| **F-7** `seed.ts:3165`「48 vs 76」等过时计数注释 | P3(文档卫生) | ✅ **已修**:并入 F&A-3 刀 true-up | [#529](https://github.com/BA7IEE/srvf-nest-api/pull/529) |
| **A-5** `bulkGrantAccounts` 逐行串行 bcrypt | P3 | ⛔ **接受 / 不做**:已封顶 200 + ops-admin 高信任 + skip-on-error 语义正确,轻度性能面非 DoS;诉求触发再优化(登记 NEXT_TASKS P1-19) | — |
| **A-6** authz batch 每项重算 `collectGrants`(N+1 放大) | P3 | ⛔ **接受 / 不做**:封顶 ≤200 + 诊断码 + caller 恒定,近低效非 DoS;诉求触发再做(登记 NEXT_TASKS P1-19) | — |

> 结论:**P0=0 / P1(1)✅ / P2(1)✅ / P3(5):3 ✅ + 2 接受不做**。上线阻断项(P1 F&A-1)已于上线前修复;发版 v0.39.0 ⚠️ 行为变更 4 条置顶(见 Release notes / CHANGELOG)。台账 `NEXT_TASKS` P1-19 已翻 ✅,`current-state §4` 相关行同步。

---

## 0. 报告顶部 —— 上线判断 + 疑似 P0 标红

- **是否存在阻上线的 P0(越权 / 数据丢失 / PII 泄漏级且现网可利用):无。** 项目尚未上线,零现网风险。
- 🟥 **建议上线前修一项(P1,边界性 P0):`bindAccount` 经队员轴绕过 `assertNotLastSuperAdmin` + `assertCanManageUser` 两道用户轴护栏**(见 F&A-1)。它需要高信任的 `ops-admin` 才能触发,故不判 P0;但它实证性地击穿了两条"刻意写死"的安全不变量(最后一个 SUPER_ADMIN 保护 + 管理者等级校验),且守卫注释自身的前提为假 —— **强烈建议上线前收口**。
- 其余为 **P2 一项(RBAC 授权配置写面无 audit + 假称有 audit 的僵尸注释)** 与 **P3 若干(均无当前运行时危害,多为"待复核 / 一致性 / 文档卫生")**。

**一句话结论**:v0.38.0 基线整体健康,delta 面(队员账号闭环 + 后台对接 F1–F5)判权与并发设计经得起对抗推演;仅队员轴账号生命周期存在一处跨轴护栏绕过(P1,建议上线前修),外加一处授权配置审计盲区(P2)与一批可接受的 P3。**不构成硬性上线阻断,建议修 P1 后放行。**

---

## 1. 元信息与基线证据

| 项 | 值 |
|---|---|
| 评审基线 commit | `3ce05d30a599a7cd81321a7685c7f8b2a6ce0821`(`docs(handoff): 刷新 openapi.json 快照到 v0.38.0` #525) |
| HEAD == origin/main | 是(亲核一致) |
| 版本 | v0.38.0(package.json = tag `v0.38.0` = Swagger `setVersion('0.38.0')` 三方核一致;GitHub Release 第四方离线未核) |
| 工作树 / open PR / Unreleased | clean / 0 / 0(开工门禁全过) |
| 评审窗口 | `v0.34.0..HEAD`(45 commits,#482–#525;逐 PR 亲核清单见 §7 覆盖矩阵) |
| 评审日期 | 2026-07-10 |

### 1.1 质量门状态(基线实况)

| 门 | 本地实跑 | 结果 | 说明 |
|---|---|---|---|
| `typecheck`(`tsc --noEmit`) | ✅ 是 | **PASS**(exit 0) | 纯 JS 工具链,沙箱可跑 |
| `lint`(`eslint --max-warnings 0 src/**`) | ✅ 是 | **PASS**(exit 0) | 同上 |
| `unit` / `contract` / `e2e` | ❌ 否 | 未独立实跑 | 需 Postgres/OrbStack(沙箱无);依赖仓内记载 CI 绿 + PR CI 兜底 |
| `docs:rbacmap:check` / `docs:codemap:check` | ❌ 否 | 未实跑(其不变量已手工在纯 node 复核) | tsx→esbuild 原生二进制平台不符(macOS 装的 `node_modules` 在 Linux 沙箱跑 esbuild 报 `TransformError`);**未为绕门禁改任何配置**(遵 DoD #3) |

> 质量门降级说明合规:本地 OrbStack 不可用 + tsx 守卫脚本受 esbuild 平台阻断 → 按 goal §3 以本地可跑门(typecheck/lint 绿)+ 手工不变量复核 + 文档记载 CI 绿兜底,零配置改动。

---

## 2. 已知集(不重复报,仅 true-up)

开工已读 AGENTS.md / current-state.md(§1–§6)/ 三份冻结稿 / NEXT_TASKS.md / RBAC_MAP.md,建立"已知/已接受集":

- **已接受债务(current-state §4 + NEXT_TASKS)**:god-service 体量观察(attendances/activity-registrations/attachments/users/activities/recruitment-applications;architecture-boundary §6 未触发不拆)· service 单测占比低(刻意 e2e 为主)· Mixed Controller 存量 2 处 · contract snapshot ~1MB · SMS/招新 retention 手动 SQL(不解锁 cron)· 保险到期无提醒 · 招新 28003 同轮去重可枚举(拍板接受)· 外籍 promote 手动建档边界 · #399 残余 F7(付费核验 cost-DoS,通道休眠)/ F8(promote 字典码,零运行时危害)/ dev-only CVE / F18 CI audit gate → G-12。
- **本轮对以上一律不重复报**;下文 findings 均为已知集之外的新发现或对已知集的漂移 true-up。

---

## 3. Findings 台账(P0–P3)

> 每条 = 现象 + `file:line` 证据 + 失败场景 + 分级理由 + 一句自我反驳(证据纪律:写入前先自我反驳,站不住即撤/降级)。

### 计数总览

| 级 | 数量 | 一句话 |
|---|---|---|
| P0 | 0 | 无现网可利用越权/数据丢失/PII 泄漏 |
| P1 | 1 | 队员轴 bind 绕过最后一个 SUPER_ADMIN + 管理者等级护栏 |
| P2 | 1 | RBAC 授权配置写面无 audit + 僵尸注释假称有 audit |
| P3 | 5 | member-profiles 档案面明文 PII(待复核)· bind 未校验目标 status · bulk-grant 串行 bcrypt · authz batch N+1 放大 · 两处过时计数注释 |

---

### 🟥 F&A-1 (P1,边界 P0) —— `bindAccount` 认领任意角色/状态的悬空账号,使队员轴的停用/退号重开绕过"最后一个 SUPER_ADMIN 保护"与"管理者等级校验"

**现象**:队员账号闭环 v2 的 `bindAccount` 只校验目标 User「存在 / 未软删 / `memberId === null`」,**不校验 `target.role` 或 `target.status`**。因此可把一个悬空的 **SUPER_ADMIN / ADMIN** 账号绑定到任意 ACTIVE 队员;此后经队员轴 `PATCH :id/account/status {DISABLED}`(停用+撤 refresh)或 `POST :id/account/reopen`(软删旧号+开新号)即可停用/软删该特权账号 —— 而这两个方法**刻意跳过了**用户轴上 `assertNotLastSuperAdmin` 与 `assertCanManageUser` 两道护栏。

**证据**:
- `src/modules/members/members.service.ts:622-629` `bindAccount`:`select { id, memberId, status }`,仅判 `target.memberId !== null`(627-629 → `MEMBER_ACCOUNT_TARGET_ALREADY_LINKED`),**无 role 判定、无 status 判定**。
- `src/modules/members/members.service.ts:817-819` 注释明写跳过最后一个 SUPER_ADMIN 保护,其前提是「bind/grant/reopen 恒 role=USER」——`grant`(560)/`reopen`(775)确实 `role: Role.USER`,但 **`bind` 挂的是既有任意角色账号**,前提为假。
- `src/modules/members/members.service.ts:822-857` `updateAccountStatus`:唯一护栏是自我保护(838-840 `CANNOT_OPERATE_SELF`),**无 `assertNotLastSuperAdmin` / 无管理者等级校验**。
- `src/modules/members/members.service.ts:757-760` `reopenAccount`:直接软删 `oldLink`(设 `deletedAt + status=DISABLED`),**无 role / last-SA 校验**。
- 对照被绕过的用户轴护栏:`src/modules/users/users.service.ts:134-148` `assertNotLastSuperAdmin`(count 剩余 ACTIVE 非删 SUPER_ADMIN,为 0 抛 `LAST_SUPER_ADMIN_PROTECTED`),`:108` `assertCanManageUser`;二者在 `updateRole`(567/577)/`updateStatus`/`softDelete` 上保留执行。
- 可绑目标存在性:seed 的 bootstrap SUPER_ADMIN 与一切 API 建的 ADMIN 均 `memberId=null`(非队员)→ 悬空可绑;判权 `assertCanOrThrow(currentUser,'member.bind.account')` 只认 RBAC 码不认 actor 的 `Role` 枚举 → 持 `ops-admin` 但非 SUPER_ADMIN 的 actor 即可达。

**失败场景**:持 `ops-admin`(非 SUPER_ADMIN)的运营:① `POST admin/v1/members/:m/account/bind {userId: <某 SUPER_ADMIN 的 id>}`(id 经 `user.read.account` 可列举)→ 把最后一个 SUPER_ADMIN 绑到某队员;② `PATCH admin/v1/members/:m/account/status {DISABLED}` 或 `POST .../account/reopen` → 停用/软删最后一个 SUPER_ADMIN。结果 = 可用性锁死 + 越过用户轴显式禁止的特权边界。即便目标只是 ADMIN:用户轴停用一个 ADMIN 需 actor 等级压过它(`assertCanManageUser`),队员轴无此校验 —— 仍是边界绕过。

**分级理由(P1,非 P0)**:实证击穿两条刻意写死的安全不变量 + 最后一个 SUPER_ADMIN 可用性锁死,证据确凿;但**需要 deliberately-provisioned 的高信任 `ops-admin` 码**(无未认证/低权/未授权路径),且项目未上线无现网数据 → 不判 P0。因其"越权面"本质 + 守卫注释前提为假,**置于 findings 台账首位,建议上线前修**。

**自我反驳**:"ops-admin 本就强,属信任内。"——不成立:仓库画了明确的线,连 ops-admin 都不能碰 SUPER_ADMIN(`seed.ts:1998-2002` 不绑 `user.update.role` 与凭证 reset),`assertNotLastSuperAdmin` 连真 SUPER_ADMIN 都约束;一条让 ops-admin 经旁轴停用/软删最后一个 SUPER_ADMIN 的路径是真边界破。**Finding 成立。**

**最小修方向(仅诊断,不开药方细节)**:`bindAccount` 拒绝非 `USER`(并建议非 `ACTIVE`)目标;或给 `updateAccountStatus`/`reopenAccount` 补 `assertNotLastSuperAdmin` + 管理者等级校验;并 true-up `:817-819` 注释。

---

### F&A-2 (P2) —— RBAC 授权配置写面无 audit;`rbac-roles.service.ts:243` 僵尸注释假称有 `rbac.role.delete` audit 事件

**现象**:RBAC 授权模型的运行时变更 —— RbacRole 建/改/软删、RolePermission 授予/撤销、Permission CRUD —— **均不写 audit_logs**。尤其 `rbac-roles.service.ts` 的注释声称删除责任"由 audit_logs 的 `rbac.role.delete` 事件 + actorUserId 记录",但全文件无任何 `auditLogs.log` 调用,该事件从不产生。而**用户-角色分配(user-roles)是有 audit 的**,授权模型里"谁把哪条权限绑给哪个角色"这更敏感的一步反而无留痕 —— 非对称。

**证据**:
- `src/modules/permissions/rbac-roles.service.ts:35-38` 构造器仅注入 `prisma`+`rbac`(无 `AuditLogsService`);`:185/218/235` 有 `assertCanOrThrow('rbac.role.{create,update,delete}')` 判权;**全文件无 `.log(`**;`:243` 注释假称 `rbac.role.delete` 事件存在(僵尸注释)。
- `src/modules/permissions/role-permissions.service.ts:41-45` 构造器无 `AuditLogsService`,grant/revoke 无 audit。
- `src/modules/permissions/permissions.service.ts` Permission CRUD 无 audit。
- 对照有 audit 的授权侧:`src/modules/permissions/user-roles.service.ts`(用户角色分配写 audit)。

**失败场景**:恶意或误操作的 ops-admin 把某高权 Permission 绑到某低权角色、或删掉某角色的授权,事后 audit_logs 无任何取证轨迹;排障/合规审计无法回答"谁在何时改了授权模型"。属安全可观测性/取证盲区(非直接越权)。

**分级理由(P2)**:该系统核心价值即"可审计"(A-1 红线),而授权模型自身的变更无留痕,是与项目使命冲突的观测盲区;但端点均 ops-admin/SUPER_ADMIN 判权,非未授权访问 → 非 P1。

**是否已知**:字典/settings 不写 audit 是**有据的早期决定**(`docs/archive/handoff/v0.11.0.md:325` Storage Settings 配置变更 audit「留独立专项 PR」;v2 数据模型草案「第一阶段 4 模型写操作不接入 audit_logs」)。但:(a) 该"专项 PR"在 NEXT_TASKS 无在册任务追踪;(b) 4 模型中的 organizations 已于 #495 反向补了 audit、memberships(#490)亦有,决定的当前生效范围已漂移、不自洽;(c) **RBAC roles/permissions 授权配置不在"settings/4 模型"任何一个已记决定的覆盖内**,且僵尸注释假称已覆盖 → 至少僵尸注释是新的事实性错误,RBAC-config 审计盲区无在册背书。

**自我反驳**:"config 面不 audit 是全仓惯例。"——部分成立(settings 有文档),但 RBAC 授权配置≠settings,且 organizations/attachment-configs/contribution-rules 这些 config 面**是**写 audit 的,惯例本身不自洽;更硬的是 `:243` 注释假称事件存在 —— 这一条独立成立。**Finding 成立(P2)。**

---

### F&A-3 (P3,待复核) —— `member-profiles` 管理档案面 `findOne` 返回明文 `documentNumber`(身份证号)与 `mobile`,无掩码/无 read.sensitive 分级;与 recruitment 的"默认掩码 + 分级解掩"及 CODEMAP"身份证默认掩码后 4 位"措辞不一致

**现象**:`member-profiles.findOne`(admin 档案详情,`member-profile.read.record`,该码为业务面 → 绑 biz-admin,即一切 ADMIN 可读)经 `memberProfileSafeSelect` 直返完整 `documentNumber` 与 `mobile`,**无掩码变换、无 `read.sensitive` 式分级**。而 recruitment_applications(同类 PII)对 admin **默认掩码**、需独立更严的 `recruitment-application.read.sensitive` 码解掩;App 自助面亦用 `documentNumberMasked`。同类 PII 两套口径。

**证据**:
- `src/modules/member-profiles/member-profiles.service.ts:27-59` `memberProfileSafeSelect` 含 `documentNumber: true`(34)/ `mobile: true`(44);`:208-224` `findOne` 直返该 select 无掩码;`member-profile-response.dto.ts:26/65` 字段注释「高敏感」。
- 对照:`src/modules/recruitment/recruitment-applications.presenter.ts:65-107` `toAdminApplicationDto(app, masked)` 默认掩码 + `masked` 分级(review #484 G4 收口)。
- CODEMAP member-profiles 行:「含敏感字段(身份证默认掩码后 4 位)」—— 与 findOne 明文实现措辞冲突。

**分级理由(P3,待复核)**:访问方是**已授权** admin,非越权/泄漏给未授权方 → 非 P1/P2;但存在两种可能:(a) 管理档案面本就该全显(管理队员需真实证件号,与 recruitment 信任语境不同),则 CODEMAP 措辞需 true-up;(b) 档案面应同 recruitment 采"掩码默认 + read.sensitive 解掩",则为掩码缺口。**证据存疑于设计意图,降级标"待复核",交维护者定夺,不擅判为漏洞。**

**自我反驳**:"admin 看队员档案要真实证件号,天经地义。"——很可能成立,故未判更高级;但 recruitment 对同类 PII 的"掩码默认+分级"先例 + CODEMAP"默认掩码"措辞,使"档案面无任何分级"至少是一处**需要显式确认的一致性缺口**,不是无中生有。保留为 P3 待复核。

---

### A-4 (P3) —— `bindAccount` 不校验目标 `status`,可绑定一个 `DISABLED` 悬空账号

**现象/证据**:`members.service.ts:622-629` 选了 `status` 却不判,`DISABLED` 的悬空账号可被绑定并经队员面 `hasAccount/accountStatus` 回显为已绑禁用号。**失败场景**:误绑一个已禁用账号,队员侧显示"有账号但禁用"。**分级(P3)**:无越权、无数据损坏,仅状态语义瑕疵。**自我反驳**:与 F&A-1 同源(bind 目标校验缺失),可并入 F&A-1 一并修;单列仅为完整。

### A-5 (P3) —— `bulkGrantAccounts` 逐行独立事务 + 逐行 cost-10 bcrypt,串行

**现象/证据**:`members.service.ts:865-905` 循环 `dto.items`(`members.dto.ts` `@ArrayMaxSize(200)` 已封顶),每行独立 `$transaction` + `bcrypt.hash(randomBytes(48),10)`(`grantAccountCore` 547-550)。200 行 ≈ 数秒 CPU 串行。**分级(P3)**:已封顶 200 + ops-admin 门,轻度性能面非 DoS。**自我反驳**:封顶+高权+逐行 skip-on-error 语义正确,基本可接受,仅登记。

### A-6 (P3) —— authz `explain-batch` / `action-state/batch` 每项重算 `collectGrants`,无 throttle 兜底

**现象/证据**:`src/modules/authz/action-state.service.ts:62-84` 逐项调 `authz.explain`→`collectGrants`(`authz.service.ts:243` 明写"全部现查不缓存",4 查/项)+ resolver 2–4 查/项;`action-state/batch` 的 subject 恒为同一 caller,grant 收集本可 memoize 却重复至多 200×;反向白名单限流跳过非登录路由(`throttler-biz.guard.ts:59-60`)。**分级(P3)**:DTO 封顶 200(`authz.dto.ts:313/401`)+ ops-admin 诊断码 + 串行 await,爆炸半径=可信主体查自己的库。**自我反驳**:封顶+高权+无 fan-out,更近低效非 DoS;survive 为低severity 备忘(caller 恒定的 grant 收集可平凡 memoize)。

### F-7 (P3,文档卫生) —— 两处过时计数注释

**现象/证据**:(a) `prisma/seed.ts:3165` 注释「upsert **48** 条业务面 Permission」,而 `BIZ_PERMISSION_SEED` 实为 **76** 条(base 子数组求和;运行期日志用 `.length` 故输出正确,仅注释过时)。(b) 同族过时措辞散见(seed 顶部绑定统计以 `.length` 强校验为准,注释数字滞后)。**分级(P3)**:纯注释,运行期以 `.length` 为准无危害。**自我反驳**:cosmetic,改 seed.ts 属 D 档不值单独立项;登记供后续顺手 true-up。

---

## 4. 主线 F —— 第一性原理结论

从项目自述使命(稳定 / 清晰 / 可维护 / AI 友好 / 避免过度工程化 / 可持续二开)审视:

### F1 复杂度问责(仅诊断,不开重构药方)

- **rbac 与 authz 双判权体系并存(最大复杂度成本项)**:`authz`(终态 scoped-authz PR8)已是"统一判权大脑",但仅 participation 三模块(activities / activity-registrations / attendances,PR12)迁入,其余业务面仍走 `rbac.can`。**双轨在服务同一目的(判权)却两套心智模型**;终态是全量迁 authz 还是长期双轨,当前无收敛时间线 → 债务候选#1(今天从零设计会选单一判权出口)。
- **switch-per-type 归属解析出现两份**:`authz/resource-resolver.service.ts`(11 类)与 `meta/meta.service.ts`(resolve-labels 的 switch-per-type)各自维护一份"按 type 分派"的自包含 switch。设计上刻意不互注入(防环)、可理解,但**两处平行 registry 未来同增同改**,是一处"抽象未挣回成本"的观察点 → 债务候选#2。
- **dryRun 哨兵回滚范式**(`position-assignments`/`supervision-assignments` 的 `create(dryRun)` 在 `$transaction` 内 insert+audit 后抛 `DryRunAbort` 令整事务回滚)聪明但隐晦:preview 复用 create() 保证"预演=真实校验",代价是"写了再回滚"的反直觉控制流 → 债务候选#3(可读性成本,非正确性问题;§5-A1 已证零写逃逸)。
- god-service 体量(attendances 1428L 等)—— **已知已接受**,architecture-boundary §6 未触发不拆,本轮不重复登记。

### F2 规则体系自洽

- **config 面 audit 决定已漂移、不自洽**:v2 早期"4 模型写不接 audit"+ "settings 配置 audit 留独立专项 PR",但 organizations(#495)/ memberships(#490)已反向补 audit,而 dictionaries / RBAC roles/permissions 仍无 —— 决定的当前生效边界模糊、无单一权威表述,且"独立专项 PR"在 NEXT_TASKS 无在册追踪(见 F&A-2)。**建议:显式收敛一句"哪些 config 面写 audit / 哪些刻意不写"的权威规则,并把僵尸注释 true-up。**(报告只登记,不擅调和文档。)
- **僵尸注释**:`rbac-roles.service.ts:243`(假称 audit 事件)、`seed.ts:3165`(48 vs 76)—— 代码惯例/事实与注释不符的两处(F&A-2 / F-7)。
- 其余权威分层(AGENTS / current-state / process / architecture-boundary / api-surface-policy / handoff)本轮抽查未见新矛盾;计数类断言全过(§6)。

### F3 概念模型自洽

- **User↔Member 一对多改造后的身份模型基本自洽**:登录主体恒 User;`User.memberId` partial unique `WHERE deletedAt IS NULL` 让"软删旧号→重开新号"取到释放槽位;`computeNextUsername` 探测式 + `User.username` 全量 unique 兜底并发;reopen 先软删后建、单事务、次序正确(§5-A2 已证不会双 live 链)。**唯一自洽性破口 = F&A-1**:"linked user 恒 role=USER"这一被 status/reopen 依赖的不变量,被 bind(挂既有任意角色账号)打破 —— 概念模型层面的裂缝,不止是判权疏漏。
- **rbac / authz 双体系边界**能讲清(authz 无 ref 退化 = rbac GLOBAL 逐字等价,行为锁 e2e;participation 三模块 scoped 增能),但**终态路径(是否全量迁 authz)未定** → 见 F1 债务候选#1。
- **ops-admin / biz-admin / org-admin 三码族归属成体系**:ops-admin=系统/RBAC/配置面(96 码)、biz-admin=全量业务面(73 码)、org-admin=scoped 派生(57,PolicyScopeMode.TREE 自动继承);账号铸造(member.grant/bind.account)刻意归 ops-admin 与 `user.*.account` 同族 —— 归属自洽。

---

## 5. 主线 A —— 对抗性结论

### A1 攻击者视角(delta 逐端点 + 存量抽查)

- **队员账号闭环**:唯一实锤 = F&A-1(bind 目标校验缺失致跨轴护栏绕过)。判权门齐全(controller 无 `@Public`,service 层 `assertCanOrThrow`;码只在 `OPS_ADMIN_PERMISSION_SEED`,低权角色够不着)· 枚举面仅对已授权 ops-admin 可见 · reopen/unbind 后旧号经 `jwt.strategy` 每请求 re-check(`deletedAt!=null`/非 ACTIVE 即拒)+ refresh family 撤销闭合。
- **后台对接 F1–F5**:**结构性洁净**。关键事实:`rbac.can` 只读 `scopeType=GLOBAL` RoleBinding(`rbac.service.ts:85-92`),无 ref 的 `authz.explain` 退化 GLOBAL(`authz.service.ts:162-177`)→ 扁平跨轴总表(registrations/attendance-sheets/memberships/assignments)是 **GLOBAL-only 能力**,scoped-only admin 直接 403,**非 scope 逃逸**(是文档化边界)。expand 投影零 L3/PII 泄漏(registrations/attendances/memberships/positions/supervision 各 expand 仅 id+展示字段)。resolve-labels 两层权限(入口码 + per-type read 码)+ 静默省略(未知/无权 id 不报错、不进结果,防枚举)+ 自包含 switch 零业务 service 注入。preview/dry-run(position/supervision/membership.conflicts)零写逃逸(纯读或 `DryRunAbort` 整事务回滚,audit 传 tx 一并回滚)。batch 服务端封顶 ≤200(DTO 校验,201→400)。transfer 单事务 end+create、`runWithUniqueConstraintGuard`→P2002 整体回滚,不产双 live 归属。tree-with-summary 单 groupBy 无 N+1;分页 `pageSize @Max(100)`。
- **注入 / 上传 / signed URL / refresh 旋转 / 防滥发**:signed URL 永不返回(除 content 读取面文档化例外;§ Invariant-1 全扫 HOLDS)· JWT payload 仅 `{sub,username}`(`auth.service.ts:124/316`)· 防枚举三套(找回密码/OTP/微信)一致性未破(security.md §30/§31)。

### A2 并发与竞态

- **P2002 映射**:`runWithUniqueConstraintGuard` 把 `username`/`memberId`(partial unique `User_memberId_active_key`)→ 业务码;并发 grant+grant / grant+bind → 第二次 commit 撞 partial unique → 映射 BizException,**绝不双 live 链**(`members.service.ts:163-165` 应用于 553/631/768)。唯一瑕疵 = 撞两 unique 时 Postgres 只报一个、码非确定(`USERNAME_ALREADY_EXISTS` 或 `MEMBER_HAS_LINKED_USER`)—— UX 面,代码 142-165 已显式接受,P3。
- **computeNextUsername 探测式**:靠全量 `User_username_key` 兜 TOCTOU,并发探同一候选者 loser 得 `USERNAME_ALREADY_EXISTS`,无静默撞车。
- **quota 原子扣减 / partial unique×软删除 / commit 后事务外 Effect**:transfer/reopen 单事务原子;招新容量 `FOR UPDATE`(#411 存量);未见 commit 后事务外 Effect 失败语义新问题。

### A3 断言证伪(≥20,见 §6 独立清单)

### A4 修复回归复核(抽样,未回退)

- #495 organizations 写面 audit(create/status-change/move/delete 4 事件在树 `organizations.service.ts:337/432/528/586`)✅ · #490 memberships 双入口 audit(`membership.set/end` + transfer)✅ · #486 recruitment `read.sensitive` 掩码(spec 锚在树)✅ · #489 生产可达 CVE overrides(`pnpm.overrides` 含 qs `^6.15.2` / `@nestjs/swagger>js-yaml` / `fast-uri ^3.1.2` / form-data / tough-cookie / uuid / ajv)✅ · #494 冻结表 DROP 零残留(`src/` 无 `prisma.memberDepartment`/`prisma.userRole` delegate 访问)✅ · #498–#500 就绪修复(docs/config)未见回退。

---

## 6. 断言证伪清单(A3,逐条判定)

| # | 自我断言(出处) | 判定 | 证据 / 说明 |
|---|---|---|---|
| 1 | 版本三方一致 | **真(三方)** | package.json 0.38.0 = tag v0.38.0 = Swagger `setVersion('0.38.0')`;GitHub Release 第四方离线未核 |
| 2 | `EXPECTED_ROUTES` = 326 | **真** | 亲核数组条目 326(`openapi.contract-spec.ts` L49–614) |
| 3 | 权限码 = 197 | **真** | 101 config(ALL_PERMISSION_SEED)+ 20 attachment + 76 business;其中 4 码 const-ref(`user.update.role` + SMS/WECHAT/REALNAME reset-credentials)故正则初计 193 |
| 4 | controller = 66 | **真** | 66 个 `export class *Controller`(63 文件,含多 class 文件) |
| 5 | 模块 = 35 | **真** | `src/modules/*` 35 个(app.module 除外) |
| 6 | migration = 40 | **真** | `prisma/migrations` 40(末 `20260707130528_user_memberid_partial_unique`) |
| 7 | 角色 = 7 | **真** | ops-admin/biz-admin/org-admin/member/group-manager/org-supervisor/attendance-final-reviewer |
| 8 | 全仓活跃 `@Roles` = 0 | **真** | 零 `^@Roles(` 装饰器行(37 处 grep 命中全为注释/定义/import;member DELETE 走 `rbac.can('member.delete.record')`) |
| 9 | 本仓唯一 `@Cron` = 生日祝福 | **真** | `birthday-greeting.service.ts:51` 唯一 |
| 10 | 无 queue/bull/event-emitter 任务基建 | **真** | 仅 `event-placeholder.ts` 注释 |
| 11 | 队员账号闭环期间 auth 全程零 diff | **真** | `git diff v0.37.0..HEAD -- src/modules/auth` 为空 |
| 12 | 冻结表已 DROP 零残留读写(#494) | **真** | `src/` 无 `prisma.memberDepartment`/`prisma.userRole` delegate 访问 |
| 13 | JWT payload 仅 `{sub,username}` | **真** | `auth.service.ts:124/316` |
| 14 | `User.memberId` partial unique WHERE deletedAt IS NULL | **真** | migration `20260707130528_.../migration.sql`(`User_memberId_active_key`) |
| 15 | signed URL/accessUrl 永不返回(除 content 读取面) | **真** | Invariant-1 全扫 HOLDS |
| 16 | 软删过滤 `deletedAt: null` 全覆盖 | **真** | Invariant-3 全扫 HOLDS(唯一性检查含软删为有意) |
| 17 | L3 敏感字段掩码 | **部分真** | App/recruitment/users/members 掩码;**member-profiles 档案面 documentNumber/mobile 明文**(F&A-3 待复核) |
| 18 | audit 写面全覆盖 | **部分真/伪** | 业务写面覆盖;**RBAC roles/permissions/字典 config 写面无 audit**,rbac-roles:243 假称有(F&A-2) |
| 19 | 后台扁平跨轴总表无 scope 逃逸 | **真** | GLOBAL-only 判权(rbac.service.ts:85-92 / authz.service.ts:162-177) |
| 20 | preview/dry-run 零写逃逸 | **真** | 纯读或 DryRunAbort 整事务回滚(§5-A1) |
| 21 | batch ≤200 服务端强制 | **真** | `authz.dto.ts:313/401`、`meta.dto.ts` DTO 校验,201→400 |
| 22 | typecheck / lint 绿 | **真(本地实跑)** | exit 0 / exit 0 |
| 23 | seed 幂等二跑 / 干净库 40/40 重放 / full e2e 全绿 | **未独立核验** | 需 DB/OrbStack(沙箱无)+ tsx 守卫受 esbuild 平台阻断;依赖仓内 CI 绿记载 + PR CI 兜底 |

> ≥20 达标(23 条)。判"部分真/伪/未核验"的均给了证据与降级理由,未一刀切判伪。

---

## 7. 覆盖矩阵(模块 × 维度,自证无漏扫)

维度:**J**=判权/越权(A1)· **C**=并发/竞态(A2)· **U**=signed URL(Inv-1)· **L**=L3 掩码(Inv-2)· **S**=软删过滤(Inv-3)· **Au**=写面 audit(Inv-4)。
标记:✔=抽查无发现 · ●=有 finding(见台账)· —=该维度对本模块不适用 · ~=已知已接受(不重复报)。

| 模块 | J | C | U | L | S | Au | 备注 |
|---|---|---|---|---|---|---|---|
| members(delta 核心) | ● F&A-1 | ✔ A2 | — | ✔ | ✔ | ✔ | 账号闭环深审 |
| users | ✔ | ✔ | — | ✔(select 排除 phone/openid) | ✔ | ✔(status 不 audit=既定) | |
| member-profiles | ✔ | — | — | ● F&A-3 | ✔ | ● F&A-2 族(仅 read placeholder) | 档案面明文 PII 待复核 |
| authz | ✔(GLOBAL 退化) | ✔ | — | ✔ | — | 无(诊断只读) | explain/action-state |
| meta(delta) | ✔(两层权限) | ✔ | — | ✔ | ✔ | 无(只读) | resolve-labels/workbench |
| member-departments/memberships(delta) | ✔ | ✔(transfer 原子) | — | ✔ | ✔ | ✔ | F4 transfer 深审 |
| position-assignments/supervision(delta) | ✔ | ✔ | — | ✔ | ✔ | ✔ | F5 preview 深审 |
| organizations | ✔ | ✔ | — | ✔ | ✔ | ✔(#495) | tree-with-summary 无 N+1 |
| activity-registrations/attendances(delta expand) | ✔(GLOBAL) | ✔ | — | ✔(expand 无 PII) | ✔ | ✔ | F2 expand 深审 |
| permissions(rbac/roles/role-permissions) | ✔ | ✔ | — | — | ✔ | ● F&A-2 | 授权配置无 audit |
| dictionaries | ✔ | ✔ | — | — | ✔ | ~(早期决定) | config 无 audit(已知) |
| attachments/attachment-configs | ✔ | ✔ | ✔(Inv-1) | ✔ | ✔ | ✔ | signed URL 红线守住 |
| recruitment/realname/team-join | ✔ | ✔(FOR UPDATE) | ✔ | ✔(掩码+分级) | ✔ | ✔ | A4 #486 未回退 |
| content/notifications | ✔ | ✔ | ✔(读取面例外) | ✔ | ✔ | ✔ | 可见性纯函数 |
| insurances/certificates/emergency-contacts/contribution-rules | ✔ | ✔ | — | ✔ | ✔ | ✔ | self-scope 防 IDOR |
| auth/sms/wechat/storage/health/ai/announcement-import | ✔ | ✔ | ✔ | ✔ | ✔/~(settings 无 audit=文档化) | v0.38 零 diff | |

> 空格已消除:每格为显式 ✔/●/~/— 之一。设置类(sms/wechat/storage/realname settings)写面无 audit 标 `~`(文档化早期决定,见 F&A-2 讨论,不单列为新 finding)。

---

## 8. 新发现 vs 已知对账 + NEXT_TASKS true-up

**新发现(已知集之外)**:
1. F&A-1(P1)— 队员轴 bind 绕过 last-SA/manage-user 护栏(**建议上线前修;镜像 #484→fix goal 立项**)。
2. F&A-2(P2)— RBAC 授权配置写面无 audit + rbac-roles:243 僵尸注释。
3. F&A-3(P3,待复核)— member-profiles 档案面明文 PII / CODEMAP 措辞不一致。
4. A-4/A-5/A-6(P3)— bind 未校验 status / bulk-grant 串行 bcrypt / authz batch N+1。
5. F-7(P3,文档卫生)— seed:3165「48 vs 76」等过时计数注释。

**与已知集的关系**:以上均**不**与 current-state §4 / NEXT_TASKS 现有条目重复;F&A-2 与"settings config audit 留独立专项 PR"相邻但不重叠(那是 settings,此是 RBAC 授权配置 + 字典 + 僵尸注释)。

**NEXT_TASKS true-up 建议(仅建议,报告不擅改)**:
- 新增一条 review-then-fix 候选(P1):"队员轴账号 bind/status/reopen 护栏收口"。
- F&A-2 建议把"config 面 audit 覆盖收敛 + 僵尸注释 true-up"从 v0.11.0 handoff 的隐性"独立专项 PR"提升为 NEXT_TASKS 在册项(否则该 deferral 无追踪)。
- 台账无漂移需删除;#494/#495/#490 等已闭环项经 A4 复核未回退,current-state 相关行无需改动。

---

## 9. 修复分批建议(供后续 review-then-fix goal 立项;本 goal 零修复)

- **批 1(上线前,建议)**:F&A-1 —— `bindAccount` 拒非 USER(建议兼非 ACTIVE)目标 + `updateAccountStatus`/`reopenAccount` 补 `assertNotLastSuperAdmin`/管理者等级校验 + true-up `:817-819` 注释;附回归 e2e(绑 ADMIN/SUPER_ADMIN 目标应拒;队员轴停用/reopen 命中 last-SA 保护)。A-4(bind status)并入本批。
- **批 2(上线后,P2)**:F&A-2 —— 给 rbac-roles/role-permissions/permissions 写面接 `AuditLogEvent`(或维护者显式拍板"刻意不 audit"并 true-up 僵尸注释 + 收敛 config-audit 权威规则)。
- **批 3(文档/一致性,P3)**:F&A-3 待复核后二选一(档案面掩码分级 or CODEMAP true-up)· F-7 计数注释 true-up · A-6 authz batch grant 收集 memoize(低优)。
- A-5(bulk-grant bcrypt)按需,无诉求可不做。

---

## 10. 授权与边界自证

- **零代码修复**:`src/` `prisma/` `test/` 零改动(report-only 铁律)。
- **零 PII / 零密钥**:全文无真实姓名/手机号/memberNo/证件号(示例均为占位描述,如「某 SUPER_ADMIN 的 id」)。
- **未为绕门禁改任何配置**;未跑 `migrate reset`/不可逆库操作;未新增依赖;AGENTS 等受保护文档零修改(F2 发现只进报告)。
- 产物 = 本冻结稿(docs/archive/reviews/);current-state / NEXT_TASKS 的例行登记由维护者按 A 档先例执行(见随附人话简报)。

---

*(第三轮 · 第一性原理 × 对抗性 × 系统性 · v0.38.0 基线 · report-only · 冻结)*
