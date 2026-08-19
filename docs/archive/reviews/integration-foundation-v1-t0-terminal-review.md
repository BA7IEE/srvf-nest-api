# SRVF Integration Foundation v1 — T0 终态评审冻结稿

> **性质**:已冻结、**尚未实施**的 T0 施工依据(沿 `wecom-integration-t0-terminal-review.md` 先例)。
> **档位**:本 PR 为 A 档(docs-only);其所立项的 PR1–PR8 为 **D 档**。
> **上游权威设计基线**:维护者提供的《SRVF Integration Foundation v1:系统集成能力终态架构与分阶段落地实施规格》(下称「规格书」)。
> **本稿与规格书的关系**:规格书是**方向权威**;本稿是**对最新 `main` 的漂移复核 + 仓内事实锚定 + 写集与授权预算**。
> 两者冲突时:方向以规格书为准,**当前代码事实与写集以本稿为准**(本稿逐条给了 `路径:行号` 证据)。
> **冻结后不回改**:实施若需偏离,暂停并另出 superseding / amendments 文件,不改本稿正文。

---

## 0. TL;DR

### 0.1 一句话终态

外部系统以独立 **ServicePrincipal** 身份接入,需要承担真人责任时通过受控 **DelegationGrant** 代表指定 User 执行;
所有请求仍进入 SRVF 唯一领域命令核、状态机、权限、审计与事务。**数据库永不对外开放,永不创建假 bot User。**

### 0.2 核验结论(三句)

1. **规格书方向经本轮复核成立**,当前代码对它没有结构性阻碍 —— `request.user` 在生产代码里只有 **2 处**读取点(§5.3),
   身份链是真正的收窄点,因此「新增并行机器入口、不动现有 537 接口」是可执行的,不是一厢情愿。
2. **规格书的事实读数有 1 处已过期**(BizCode 447 → **449**),**结论无一条被推翻**;另有 **14 条**规格书未覆盖的仓内事实需要在实施前吃掉(§2.2 findings 表)。
3. **考勤真相链正处于切换中**(`ACTIVITY_V11_WORKFLOW_ENABLED` 已合入 `main`、默认关闭、生产 NO-GO)⇒ 按规格书 §45 第三种结论,
   **PR7 禁止做考勤写接口**(§6)。这是本稿最硬的一条约束。

### 0.3 本稿要维护者拍的板

见 §2.1 决策表 `D-IF-1 … D-IF-12`。全部有推荐值,维护者回**「按推荐」**即整体冻结。
其中 **`D-IF-2`(PR1 开工时机)** 与 **`D-IF-5`(控制面禁授口径)** 是两条会真正改变工程后果的,建议单独看一眼。

### 0.4 与首次上线的关系

**本项目不阻塞首次生产上线**,且本稿把「不阻塞」从一句承诺变成三条可核验判据 —— 见 §3。

---

## 1. 核验基线与漂移报告

### 1.1 事实锚点(实测)

| 项 | 值 | 取证 |
|---|---|---|
| 规格书核验基线 | `main@dfaa32d574e97751585f008f72cdb2dc8dd060d5` | 规格书页眉 |
| **本稿核验 HEAD** | **`48637fab5ec81e71ee2e760edf97090b19081945`** | `git rev-parse HEAD` |
| 版本 | `0.66.0` | `package.json` |
| 工作树 | clean | `git status --porcelain` 空 |
| open PR | **#1085**(`feat(ops): 合同 §16.1 十项切换前检查`) | `gh pr list --state open` |
| 本稿核验日期 | 2026-08-19 | — |

### 1.2 漂移报告(`dfaa32d5` → `48637fab`,恰 1 笔提交)

`48637fab` = **#1084**「第 7 批第 ③ 刀 —— `ACTIVITY_V11_WORKFLOW_ENABLED` 单一切换闸(C 档,默认关闭)」。
规格书写作时 #1084 尚是 open PR(规格书 §1 第四轮、§55 均以「存在开放 PR #1084」为前提)。**它已合入。**

| 规格书陈述 | 漂移后事实 | 结论 |
|---|---|---|
| §55「核验基线时存在开放 PR #1084」 | **#1084 已合入 `main`**;当前 open PR 是 **#1085**(写集 `changelog.d/` + `docs/current-state.md` + `scripts/cutover-check.ts`) | ⚠️ **已变**。#1085 与本 T0 写集**零相交**(§18.1),不构成阻塞 |
| §1 第四轮「本文档不把外部考勤导入永久写死为调用旧 `AttendancesService.submit()`」 | **判断正确且现已成为硬事实**:`submit()` 首句即 `assertLegacyWriteAllowed()`([attendances.service.ts:354](../../../src/modules/attendances/attendances.service.ts)) | ✅ 结论加强 |
| §3 基线读数 BizCode **447** | 实测 **449**(#1084 新增 `20153` / `20154`) | ⚠️ **订正**(§4.8) |
| §3 其余 8 项读数(模块 37 / Controller 101 / Endpoint 537 / Migration 89 / 权限码 234 / AuditLogEvent 139 / 内建角色 15 / Cron 2) | **逐项一致** | ✅ `pnpm docs:counts:check` 通过 |
| §51「新增第 12 个命名 throttler」 | **正确**:实测现有 **11** 个([throttle-options.ts](../../../src/bootstrap/throttle-options.ts)) | ✅(但 `current-state.md §2` 写「10 throttler」是**陈旧**的,见 F-7) |
| §52「37xxx 在本次基线 grep 中未发现占用」 | **正确且更强**:`src/ test/ scripts/ prisma/` 全扫,`37[0-9]{3}` **零命中** | ✅ 可冻结 |
| §4 当前 Guard 顺序 | 逐字一致:`ThrottlerBizGuard → JwtAuthGuard → AuthzDeclarationGuard → RolesGuard`([app.module.ts:217-220](../../../src/app.module.ts)) | ✅ |
| §2「`JwtPayload` 固定 `{ sub, username }`」 | 逐字一致([jwt.strategy.ts:14-17](../../../src/modules/auth/strategies/jwt.strategy.ts)) | ✅ |
| §5「`validatePrincipalOrThrow()` 对未知非 SYSTEM 类型落入 Position Assignment 分支」 | **逐字命中**:`} else { // POSITION_ASSIGNMENT`([role-bindings.service.ts:123-124](../../../src/modules/role-bindings/role-bindings.service.ts)) | ✅ 风险真实存在 |
| §2「`AttendanceSheet.submitterUserId` 不可空」 | 一致([schema.prisma:1675](../../../prisma/schema.prisma)) | ✅ |
| §7「五个 canonical prefixes」 | 一致,且锁点比规格书列的**更具体**(§4.6) | ✅ |

**漂移结论**:规格书的**方向、决策表、架构、PR 序列一条未被推翻**;只有 BizCode 计数需订正,以及「#1084 已从 open 变 merged」这一前提翻转,
而该翻转**加强**了规格书 §45 的告诫,并把「PR7 不做考勤」从「视情况」变成了本稿 §6 的**硬结论**。

---

## 2. 维护者拍板清单

### 2.1 决策表(`D-IF-*`)

| # | 决策项 | 选项 | **推荐** | 理由(一句话) |
|---|---|---|---|---|
| **D-IF-1** | 是否整体采纳规格书终态方向 | A 采纳 / B 另议 | **A** | 四轮复核 + 本轮仓内实测均未发现结构性阻碍;方向与 OAuth2 Client Credentials / RFC 8693 `act` / GitHub Apps / Entra SP 一致 |
| **D-IF-2** | **PR1 开工时机** | A 首次生产上线**之后**开工 / B 上线前即可合入(Gate 关闭) | **A** | PR1 会成为**第 90 条 migration**,首次上线会执行截至那时的全部 migration;Gate 反正是关的 ⇒ 上线前合入**收益为零、风险非零**。详见 §3.3 |
| **D-IF-3** | BizCode 段位 | A `37xxx` / B 另选 | **A** | 全仓零占用(实测);且同 PR 必须补登**漏登的 36xxx**(F-6) |
| **D-IF-4** | 第六 canonical surface `/api/integration/v1/*` | A 新增 / B 复用 `open/v1` | **A** | `open/v1` 语义是「**无账号**公开面 + `@Public()`」,与「强认证机器面」冲突;混进去会让 `@Public` 与 Integration auth 互斥判据无处可立 |
| **D-IF-5** | **控制面禁授口径** | A 不动 `isControlPlanePermissionCode()`,另立单向断言 / B 扩宽既有前缀常量 | **A** | B 会**改变现有人的角色委派行为**(今天允许授的 `storage-setting.read.*` 之类会开始被拒)= 真行为漂移。详见 F-4 |
| **D-IF-6** | `Permission` 两个 eligibility 字段是否开放 HTTP 修改 | A 否(仅 seed / code review) / B 是 | **A** | 沿规格书 §15.1;开放即等于把「机器能不能用这个权限」交给运行时,资格门失效 |
| **D-IF-7** | v1 委托形态 | A 仅 `ServicePrincipal → 固定 User` / B 含职务/部门解析 | **A** | 业务责任必须在操作时落到确定 User;负责人变更后责任漂移是不可接受的审计缺陷 |
| **D-IF-8** | 审批 / 终审能否由机器完成 | A 永久 Direct User Only / B v1 禁、后续再议 | **A** | 与既有「提交人不能自审、一级与终审分离」同源;开放它等于让机器身份绕过责任分离 |
| **D-IF-9** | 部分成功批量导入 | A 禁止(整单原子) / B 允许 | **A** | 部分成功 = 客户端必须实现补偿逻辑,而补偿逻辑必然绕过幂等;这是重复写入的经典入口 |
| **D-IF-10** | `PrincipalType` 新增值命名 | A `SERVICE_PRINCIPAL` / B 其它 | **A** | 与表名 `service_principals`、模块名一致;不得用部门名 |
| **D-IF-11** | **`allowedPrincipalKinds` 的落法** | A 作为 `CanonicalRouteAuthzDeclaration` 第 7 轴、**默认值省略序列化** / B 全 537 条显式写出 | **A** | B 会让 `authz-semantic-diff` 把 PR4 判成**全仓 537 条语义变更**,评审等于失效。详见 F-3 |
| **D-IF-12** | 本稿定位 | A 冻结稿(不回改,偏离另出 amendments) / B 活文档 | **A** | 沿 `docs/README.md` §「已冻结但尚未实施的 T0 评审稿是施工依据」既有制度 |

> 维护者回**「按推荐」**即视为 `D-IF-1 … D-IF-12` 全部按上表冻结。

### 2.2 本轮新发现(规格书未覆盖;实施前必须吃掉)

| # | 发现 | 影响 | 落到哪个 PR |
|---|---|---|---|
| **F-1** | **`request.user` 在生产代码里只有 2 处读取点**:[current-user.decorator.ts:29](../../../src/common/decorators/current-user.decorator.ts) 与 [roles.guard.ts:32,36](../../../src/common/guards/roles.guard.ts);503 处 `@CurrentUser()` 全部经由前者 | ⇒ **Integration principal 绝不能挂到 `request.user`**。一旦挂上,`@CurrentUser()` 的 503 个调用点会把机器当人拿到 `CurrentUserPayload`,`RolesGuard` 会拿 `request.user.role` 判角色 —— 而 ServicePrincipal 根本没有 `Role`。必须用**独立 request key**(如 `request.integrationPrincipal`)+ 独立 `@CurrentIntegrationPrincipal()` | **PR3**(硬约束 + 判据) |
| **F-2** | `generate-authz-manifest.ts` 的 `inputDigest` 覆盖**全部 `src/**/*.ts`**(非 spec)([generate-authz-manifest.ts:116-127,141-143](../../../scripts/generate-authz-manifest.ts)) | ⇒ **任何动 `src/` 的 PR 都会改写红区生成物 `docs/ai-harness/ROUTE_AUTHZ.md`**(红区条目 `architecture-governance-phase0-artifacts`)。PR2–PR7 每个都要红区令牌 + CI trusted-judge 环境审批,且**必须严格串行**(并行必冲突,解冲突换 SHA 即作废环境审批) | **PR1–PR8 排班**(§18) |
| **F-3** | `CanonicalRouteAuthzDeclaration` 现有 **6 轴**(`admission/mode/codes/require/scopes/engine`),`null` 是刻意的、用于确定性语义 diff([authz-context.ts:82-89](../../../src/common/authz/authz-context.ts));`authz-semantic-diff.ts` 是 R14 授权语义门的判据本体 | ⇒ 加第 7 轴若对 537 条全部显式序列化,语义门会判成全仓变更,PR4 的评审信噪比归零 | **PR4**(按 `D-IF-11` A 落法) |
| **F-4** | 仓内**已有**控制面单一谓词:`isControlPlanePermissionCode()` = `['rbac.', 'role-binding.']` ∪ 6 条保留码([role-delegation.policy.ts:12,29-34](../../../src/modules/permissions/role-delegation.policy.ts));另有 `isPrivilegedRole()`、`SYSTEM_MANAGED_ROLE_CODE_SET`、`protected-role-codes.ts` | ⇒ 规格书 §15.3 列的前缀(`storage-setting.*` / `sms-setting.*` / `wechat-setting.*` / `wecom-setting.*` / `user.*` 全量)**比现有谓词宽**。**扩宽既有常量 = 改变现有人的委派行为**。正确做法:唯一可靠门是 `servicePrincipalAllowed=false`,再加一条**单向 seed 自检**:`isControlPlanePermissionCode(code) === true ⇒ servicePrincipalAllowed === false`(只读既有谓词,零行为漂移) | **PR2** |
| **F-5** | `RbacRole` **没有** `systemManaged` / `isSystem` 列;"system-managed role" 是 `SYSTEM_MANAGED_ROLE_CODES` 三个 **code 常量**([system-managed-role-codes.ts:7-11](../../../src/modules/permissions/system-managed-role-codes.ts)) | ⇒ 规格书 §15.3 规则 2 的实现是**读常量集合**,**不要去加 schema 列** | **PR2** |
| **F-6** | BizCode 段位索引注释里 **漏登 36xxx(wecom)** —— 索引从 `35xxx` 直接跳到 `40xxx`([biz-code.constant.ts:56-59](../../../src/common/exceptions/biz-code.constant.ts)),而 36xxx 实际已被企业微信占用 6 码 | ⇒ 只加 37xxx 而不补登 36xxx,下一个人还会以为 36xxx 空着 → 撞号。**同 PR 补登** | **PR3** |
| **F-7** | `docs/current-state.md §2` 写「**10** throttler 共用 PG bucket」,实测 **11** | ⇒ 新增第 12 个时若照抄旧句会连错两次。同 PR 订正 | **PR3** |
| **F-8** | 考勤真相链**正处于切换中**:闸已合入、默认关闭、生产 NO-GO(§6) | ⇒ **PR7 禁止做考勤写接口** | **PR7** |
| **F-9** | `AttendancesService.submit()` / `edit()` / `softDelete()` 首句均为 `assertLegacyWriteAllowed()`(354 / 576 / 755 行);`attendance-review.service.ts` 8 处、`app-activity-check-ins.service.ts` 2 处同理 | ⇒ 任何 Integration 适配层直调它们,都会在闸翻转当天整条链死掉,且**是静默的 503 而不是编译错误** | **PR7 前置** |
| **F-10** | audit `log()` 生产调用点 **205 处**;其中 `actorUserId: null` **12 处**(内部系统任务) | ⇒ 规格书 §23 的 additive-optional 判断正确;且 DB CHECK **必须放行「actorUser/actorSP/onBehalfOf 三项全 null」**(内部 Worker 行),否则 12 处当场炸 | **PR1 / PR5** |
| **F-11** | `docs/api-surface-policy.md` **在红区**(`protected-docs`);`.claude/skills/srvf-api-surface/SKILL.md` 有 **2 处**「五前缀」事实(第 28、53 行) | ⇒ PR6 加第六前缀须红区令牌,且 skill 两处要同 PR 更新,否则 skill 会持续给出错误约束 | **PR6** |
| **F-12** | `harness:needs` **不模型化 `allowCreate`** —— 对 `docs/archive/**` 新建文件报「需要授权」,但实际放行([check-redzone.ts:96](../../../scripts/check-redzone.ts)) | ⇒ 本 T0(新建归档文件)**无需令牌**;后续别被这条假阳吓住 | 本 PR |
| **F-13** | `docs/README.md` 第 95 行写「已冻结但尚未实施的 T0 评审稿…**当前只剩一份**:`wecom-integration-t0-terminal-review.md`」 | ⇒ 本稿加入后该句变假,同 PR 订正为两份并注明各自阶段 | 本 PR |
| **F-14** | `docs/current-state.md §3`「暂不启动清单」显式含「新 schema / migration / Permission seed / Role 扩展」,且该清单是**评审解锁制** | ⇒ **本 T0 就是解锁凭据**;但解锁的是「可以立项」,不是「可以现在开工」—— 开工时机由 `D-IF-2` 决定 | §3 / §18 |

---

## 3. 与首次生产上线的关系 —— 「不阻塞」的可核验形态

### 3.1 上线硬门现状(不由本项目决定)

`docs/current-state.md §1` 记载:发布边界 🟡「代码可继续推进,**生产开关仍 NO-GO**」;
剩余两笔卡在「域名未下来」;生产部署是独立硬门,migration 生产执行、首批标准初始化、前端适配、企微联调各按 runbook 单独审批。

**本项目与上述任何一条都无因果关系。**

### 3.2 「不阻塞」的三条判据(可核验,非承诺)

| # | 判据 | 怎么核 |
|---|---|---|
| **B-1** | 首次上线的 GO / NO-GO 条件里**不得出现任何 Foundation 相关项** | `current-state.md §1` 发布边界单元格 + 各 runbook 全文 grep `INTEGRATION_` / `ServicePrincipal` → 必须零命中 |
| **B-2** | `INTEGRATION_API_ENABLED` **缺省关闭**时,现有 537 接口与全部既有 e2e / contract **零行为漂移** | 每个 PR 的 CI 冷跑全量 e2e + `pnpm test:contract` + `docs:openapi:check` 快照逐行可解释 |
| **B-3** | Foundation **不引入**任何首次上线需要新增审批的运维项(第 3 个 cron / Redis / queue / 新外部依赖 / 新密钥轮换流程) | `pnpm docs:counts:check` 的 Cron 恒 **2**;`EXTERNAL_IO_INVENTORY.md` 无新条目 |

### 3.3 但「不阻塞」≠「现在就该开工」(`D-IF-2` 的论证)

这是本稿唯一一处**建议比规格书更保守**的地方,理由是工程事实而非风险偏好:

- PR1 会成为**第 90 条 migration**(现有 89 条:`ls prisma/migrations | grep -c '^2026'`)。
- 首次生产上线会执行**截至那时的全部 migration**。因此 PR1 若在上线前合入 `main`,它就**跟着上生产**。
- 该 migration 确实是 additive / 零回填 / 默认关闭 —— 但它带来的是**首发批次里多一条未在生产验证过的 DDL**,而
  `INTEGRATION_API_ENABLED=false` 意味着这条 DDL 在上线后**一行运行时代码都不会碰它**。
- 即:**上线前合入的收益 = 0,风险 > 0**。
- 附加成本:F-2 已证明每个动 `src/` 的 Foundation PR 都要占用红区审批与串行槽,而上线收口期本身要跑 release lane(E 档要求 global preflight 全过 / 0 open PR)—— 两者抢同一条串行道。

**⇒ 推荐:T0 现在冻结合入(它是 docs-only,零运行时足迹);PR1 待首次生产上线完成后由维护者放行。**
若维护者选 B(上线前即可合),本稿不反对,但要求 PR1 的 PR body 显式写明「本 migration 将随首次上线进生产」,并在 `deployment.md` runbook 增列一行。

---

## 4. 当前代码事实锚点(实施依据;全部实测)

### 4.1 身份链

```text
Human User
  ↓ username/password · SMS · 微信 · 企微
AuthService.createSession
  ↓  JwtPayload = { sub, username }          jwt.strategy.ts:14-17
JwtAuthGuard(全局)                            app.module.ts:218
  ↓  @Public() 放行                            jwt-auth.guard.ts:22-28
JwtStrategy.validate() —— 每请求查 User        jwt.strategy.ts:41-53
  ↓  where { id, deletedAt: null } + status !== ACTIVE → UNAUTHORIZED
request.user : CurrentUserPayload             current-user.decorator.ts:16-22
  ↓
RbacService / AuthzService / Domain Service
```

**永久不变量**(每个后续 PR 的 DoD 都要复核):

- `JwtPayload` 恰为 `{ sub, username }`,不塞 role / permissions / scope / tokenVersion;
- `JwtStrategy.validate()` 继续每请求查 User 的 ACTIVE + 未软删事实,**不引入任何身份/权限缓存**;
- 现有 refresh rotation / family revoke / absolute expiration / 防重放 / 失败统一码不变;
- 现有 537 个接口默认仍只接受 Human User JWT。

### 4.2 Guard 链

现状([app.module.ts:217-220](../../../src/app.module.ts)):

```text
ThrottlerBizGuard → JwtAuthGuard → AuthzDeclarationGuard → RolesGuard
```

- `AuthzDeclarationGuard` 已是 **`enforce`** 模式([authz-declaration.guard.ts:26](../../../src/common/guards/authz-declaration.guard.ts)),
  未声明路由直接 `AUTHZ_UNDECLARED` ⇒ **新 Integration 路由不写声明会当场 500/403,不会静默放行**(这是好事,可直接当 §18 PR6 的判据)。
- `RolesGuard` 读 `request.user.role`([roles.guard.ts:32-38](../../../src/common/guards/roles.guard.ts)) ⇒ 见 **F-1**。

终态顺序(规格书 §4,本稿确认可行):

```text
ThrottlerBizGuard
→ JwtAuthGuard                    # 只负责现有 Human Bearer
→ ServiceClientCredentialsGuard   # 只在机器换 Token 路由生效
→ IntegrationJwtAuthGuard         # 只在 Integration Bearer 路由生效
→ AuthzDeclarationGuard
→ RolesGuard
```

### 4.3 RBAC / RoleBinding

- `PrincipalType` 现为 4 值:`USER / MEMBER / POSITION_ASSIGNMENT / SYSTEM`([schema.prisma:2018-2023](../../../prisma/schema.prisma))。
- `RoleBinding` 已具备 `principalType / principalId / roleId / scopeType / scopeOrgId / scopeActivityId / scopeResourceType / scopeResourceId / status / startedAt / endedAt / deletedAt`([schema.prisma:1986-2015](../../../prisma/schema.prisma)) ⇒ **机器权限不需要新表**。
- `RbacService.getUserPermissionCodes()` 只读 **USER × GLOBAL**([rbac.service.ts:79-81](../../../src/modules/permissions/rbac.service.ts) → `effectiveGlobalUserRoleBindingWhere`)。
- `AuthzService` 组合 USER / MEMBER / POSITION_ASSIGNMENT + 职务 + 分管([authz.service.ts:365-398](../../../src/modules/authz/authz.service.ts))。
- ⚠️ `validatePrincipalOrThrow()` 的 `else` 分支 = Position Assignment([role-bindings.service.ts:123-124](../../../src/modules/role-bindings/role-bindings.service.ts))
  ⇒ **新增枚举值必须同 PR 改成 exhaustive switch**,否则 `SERVICE_PRINCIPAL` 会被静默当职务任职校验。
- `Permission` 无 eligibility 字段([schema.prisma:1933-1949](../../../prisma/schema.prisma));`RbacRole` 无 `systemManaged` 列(F-5)。

### 4.4 Audit

- `AuditLog` 主体侧只有 `actorUserId` + `actorRoleSnap`([schema.prisma:1865-1892](../../../prisma/schema.prisma))。
- `AuditLogInput` 是 interface,`actorUserId: string | null` 必填([audit-logs.service.ts:32-43](../../../src/modules/audit-logs/audit-logs.service.ts))。
- 生产调用点 **205 处**,其中 `actorUserId: null` **12 处** ⇒ 见 **F-10**。
- `AuditLogEvent` union 现 **139** 项(`docs:counts` 真源 = `audit-logs.types.ts`)。

### 4.5 限流

**11** 个命名 throttler([throttle-options.ts](../../../src/bootstrap/throttle-options.ts)):
`default / password-change / refresh / sms-send / sms-verify / password-reset / login-sms / login-wechat / recruitment / content-public / login-wecom`。

⚠️ 文件内注释已用血写明:**只注册 throttler、不接 `ThrottlerBizGuard` 的 name 分派,会让新 throttler 对所有已挂其他限流装饰器的端点多计一道数** —— 属真实回归。
`service-token` 作为**第 12 个**必须成对落地(§18 PR3 写集已按此列全 6 个文件)。

### 4.6 API Surface / Contract / Harness

五 canonical prefixes 的**实际锁点**(比规格书 §34 列的更具体):

| 锁点 | 位置 | 形态 |
|---|---|---|
| contract 断言 | [test/contract/openapi.contract-spec.ts:2382-2395](../../../test/contract/openapi.contract-spec.ts) | `CANONICAL_PREFIXES` 数组 + `Route B 终态` 断言 |
| RBAC 检查器 | [scripts/check-rbac-map.ts:59](../../../scripts/check-rbac-map.ts) | `CANONICAL_PREFIXES` |
| RBAC 地图生成器 | [scripts/generate-rbac-map.ts:33](../../../scripts/generate-rbac-map.ts) | `CANONICAL_PREFIXES` |
| 政策文档(**红区**) | [docs/api-surface-policy.md §0](../../api-surface-policy.md) | 五行表 + 「未来开放平台扩展仍按需 **D 档立项**」 |
| skill 事实 | `.claude/skills/srvf-api-surface/SKILL.md:28,53` | 两处「五个 canonical surface」 |
| EXPECTED_ROUTES | `test/contract/openapi.contract-spec.ts` | 555 行路由清单 |
| 授权清单 | [docs/ai-harness/ROUTE_AUTHZ.md](../../ai-harness/ROUTE_AUTHZ.md) | endpoint count 537;surface 分布 admin 273 / app 153 / system 75 / auth 20 / open 16 |

> `docs/api-surface-policy.md §0` 已写明「未来开放平台扩展仍按需 D 档立项」⇒ **加第六前缀是政策内的、需 D 档立项的动作,不是政策外的破例**。本稿即该立项。

### 4.7 日志

- redact 清单在 [logger-options.ts:34+](../../../src/bootstrap/logger-options.ts);已含 `req.headers.authorization` / `*.token` / `*.accessToken` / `*.refreshToken` / `*.secret`。
- ⚠️ pino 的 `redact.paths` **不支持子串通配**(仅路径表达式与 `*.<name>`)⇒ 规格书 §26 要求的 `*.clientSecret` / `*.secretHash` / `*.rawSecret` / `*.serviceToken` / `*.delegatedToken` / `*.credentialSecret` **必须逐条枚举**,不能指望 `*.secret` 覆盖 `*.clientSecret`。
- `buildHttpLogProps()` 现只输出 `reqId` + `userId`([request-id.ts:42-48](../../../src/bootstrap/request-id.ts))。

### 4.8 BizCode

- 总数 **449**(`docs:counts:check`)。
- 段位:35xxx = activity feedbacks;**36xxx = wecom(已用 6 码,但索引注释漏登 —— F-6)**;`37xxx` 全仓零占用。
- 索引注释末行写「未规划模块预留…**35xxx 之后顺延**」⇒ 37xxx 是政策内的下一段。

---

## 5. 横切点普查

### 5.1 `PrincipalType` 使用点

**`src/` 12 个文件**(含 3 个 `.spec.ts`):

```text
src/modules/role-bindings/role-bindings.service.ts        ← ⚠️ else 分支(必改 exhaustive)
src/modules/role-bindings/role-bindings.dto.ts            ← @IsEnum 4 处、@ApiProperty 4 处
src/modules/role-bindings/role-binding-query.service.ts   ← 展开与反查(3 分支)
src/modules/permissions/role-binding-validity.ts          ← 判权唯一有效读源
src/modules/permissions/user-roles.service.ts             ← legacy user-role 入口
src/modules/permissions/last-admin-protection.policy.ts   ← 最后管理员保护
src/modules/authz/authz.service.ts                        ← 三源 principalOr 组装
src/modules/activities/activity-responsibility-grant-projector.ts
src/modules/members/members.service.ts
src/local-activity-frontend-fixture.ts                    ← 本地夹具
src/modules/permissions/*.spec.ts × 2
```

**`test/` 43 个 e2e spec** + `prisma/schema.prisma` + `prisma/CLAUDE.md` + 1 条历史 migration。

> PR2 的 exhaustive switch 改造要**逐个走完上表前 7 个非夹具文件**;`role-binding-query.service.ts:259-263` 的 `if (USER) / if (MEMBER) / 隐含 else` 与 `role-bindings.service.ts:123` 是同一形状的两处。

### 5.2 `CurrentUserPayload` / `@CurrentUser()`

| 指标 | 值 |
|---|---|
| 引用 `CurrentUserPayload` 的 `src/` 文件(不含 spec) | **249** |
| 含 test 的全仓文件 | **359** |
| `@CurrentUser()` 参数装饰器使用点(不含 spec) | **503** |

⇒ **这就是规格书 §10「不做全仓 `CurrentUserPayload → GenericPrincipal`」的量化依据**。改它 = 503 个签名 + 249 个文件,与「537 接口零漂移」直接冲突。

### 5.3 `request.user`(关键收窄点)

生产代码里 **只有 2 个文件** 读它:

| 文件 | 行 | 用途 |
|---|---|---|
| `src/common/decorators/current-user.decorator.ts` | 29 | `@CurrentUser()` 的唯一实现 |
| `src/common/guards/roles.guard.ts` | 32, 36 | `@Roles(...)` 兜底,读 `request.user.role` |

**⇒ F-1 的硬约束**:Integration principal 必须落在**独立 request key**,不得写 `request.user`。
判据形态建议(PR3):一条 selftest 断言 —— `IntegrationJwtAuthGuard` / `ServiceClientCredentialsGuard` 的实现文件里
**不得出现对 `request.user` / `req.user` 的赋值**;正对照 = 故意写一次赋值,判据必须转红。

---

## 6. 考勤 canonical chain 结论(本稿最硬的一条)

### 6.1 实测

`ActivityWorkflowGate` 是 `ACTIVITY_V11_WORKFLOW_ENABLED` 在 `src` 生产代码里的**唯一读取处**([activity-workflow.gate.ts](../../../src/common/activity-workflow/activity-workflow.gate.ts)),由 `pnpm gate:v11:check` 机器执法。三个判闸位:

| 方法 | 闸关(默认) | 闸开 |
|---|---|---|
| `assertV11WriteAllowed()` | **拒**(新结算真相链) | 放行 |
| `assertLegacyWriteAllowed()` | 放行(**今天的行为**) | **拒**(旧 AttendanceSheet / ActivityCheckIn 写) |
| `participationReadSource()` | `approved-attendance` | `committed-ledger` |

两端读同一个 `isV11Enabled()` ⇒ **不可能同时放行**,实例永远进不了「新打卡 + 旧结算」混合态。

已接闸的旧链写入口(共 13 处):`attendances.service.ts` 3(`submit` / `edit` / `softDelete`)、
`attendance-review.service.ts` 8、`app-activity-check-ins.service.ts` 2。

⚠️ 闸控范围**刻意收窄到结算真相链**,不含 `ActivitySession` 写 —— 因为 Session 是两条路径的**共用前置**(发布活动硬性要求 live session),
闸掉它会让旧写路径一起死,违反「闸关 ⇒ 旧路径放行」的安全底线。此注释就在 gate 文件里,**实施 PR7 前必须读它**。

### 6.2 结论

当前状态 = 规格书 §45 的**第三种情形**:

> 「如果真相链仍在切换中,**先交付 Foundation,不做考勤业务写接口**。」

判据(全部实测成立):

1. 闸已合入 `main`(#1084),但 **`.env.example` 默认 `ACTIVITY_V11_WORKFLOW_ENABLED=false`**;
2. `production` / `smoke` 必须**显式**设置,即生产尚未做出选择([app.config.ts:511-525](../../../src/config/app.config.ts));
3. 生产整体仍 NO-GO(`current-state.md §1`);
4. 新链(第 4–7 批)已合 `main` 但**未部署**;旧链仍是**今天唯一放行**的写路径。

⇒ **冻结结论 C-ATT-1**:**PR7 不得实现任何考勤写接口**(不论走旧 Sheet 还是新 Punch/Import)。
⇒ **冻结结论 C-ATT-2**:PR7 改选一个**只读或低风险**业务面作为首个真实接入。
   候选(按稳定性排序,PR7 立项时以当时 `main` 复核):`GET` 类活动只读信息 / 组织与队员只读摘要 / 字典只读。
   **候选面必须满足**:① 不写业务真相;② 不依赖任何在切换中的闸;③ 有明确最小字段契约。
⇒ **冻结结论 C-ATT-3**:待 `ACTIVITY_V11_WORKFLOW_ENABLED` 在生产**做出并稳定**选择后,考勤接入**另立 D 档 PR**(记为 PR7');
   届时必须重跑规格书 §45 的真相链复核,并**禁止**为 Integration 增加绕过 `assertLegacyWriteAllowed()` / `assertV11WriteAllowed()` 或其后继闸的特殊通路。

---

## 7. 目标架构(冻结)

```text
Human User ──► 现有 Human JWT ──► JwtAuthGuard ─┐
                                                 ├─► Authorization ─► 唯一 Domain Command / Policy / StateMachine
ServicePrincipal ─► Credential ─► Service Token ─┤                         │
                        │                        │                         ├─► 双主体 Audit
                DelegationGrant                  │                         └─► PostgreSQL
                        └─► Delegated Token ─────┘
                              (IntegrationJwtAuthGuard)

外部系统 ┄┄┄ 永不连接 ┄┄┄► PostgreSQL   (禁止)
```

**渐进式兼容原则**(不做的三件事,量化依据见 §5.2):

```text
✗ 全仓 CurrentUserPayload → GenericPrincipal
✗ 全仓 @CurrentUser → @CurrentPrincipal
✗ 全仓 RbacService.can → 新接口
```

v1 新增**并行**上下文:

```ts
export type IntegrationPrincipalContext =
  | { kind: 'SERVICE';   servicePrincipalId: string; credentialId: string }
  | { kind: 'DELEGATED'; servicePrincipalId: string; credentialId: string;
      delegationGrantId: string; subjectUser: CurrentUserPayload };
```

配 `@CurrentIntegrationPrincipal()`;**挂在独立 request key 上,不是 `request.user`**(F-1)。

---

## 8. 数据模型终态(语义冻结;relation 名 / 索引名 / migration SQL 由 PR1 按当时 `schema.prisma` 补齐)

沿规格书 §27–§33,本稿只记**必须额外守住的仓内约束**:

| 模型 | 关键约束 | 本稿补充 |
|---|---|---|
| `ServicePrincipal` | `clientId` 唯一、服务端生成、前缀 `srvf_sp_`、永不复用;`SUSPENDED` 下一请求即拒 | 软删沿仓内 `deletedAt` 惯例;`@@map("service_principals")` |
| `ServicePrincipalCredential` | `secretHash` 唯一;行不可改 Secret,只能新建 / 撤销;同一 SP 同时 ≤2 条 ACTIVE 且未过期 | **计数必须锁定主体后再算**,否则并发可突破上限(仓内已有 `pg_advisory_xact_lock` 范式,注意 `::text`) |
| `Permission` | `+ servicePrincipalAllowed Boolean @default(false)`、`+ delegatedAccessAllowed Boolean @default(false)` | migration 默认 false,**零回填**;CHECK:`delegatedAccessAllowed ⇒ servicePrincipalAllowed` |
| `DelegationGrant` | scope 字段形状 CHECK + `endedAt > startedAt` | scope 形状 CHECK 沿 `RoleBinding` 既有 migration 的写法,别另发明 |
| `DelegationGrantPermission` | `@@unique([grantId, permissionId])` | 创建时锁定并复核 `delegatedAccessAllowed=true` |
| `IntegrationCommandReceipt` | `@@unique([servicePrincipalId, operation, idempotencyKey])` | `operation` 必须是**服务端固定常量**;`responseSnapshot` 禁写 Token / Secret / 完整 PII / signed URL |
| `AuditLog` | additive `actorServicePrincipalId` / `actorCredentialId` / `onBehalfOfUserId` / `onBehalfOfRoleSnap` + 4 条 CHECK | ⚠️ **CHECK 必须放行「三项全 null」**(12 处内部 Worker 行,F-10) |

`PrincipalType` 终态:

```prisma
enum PrincipalType { USER  MEMBER  POSITION_ASSIGNMENT  SERVICE_PRINCIPAL  SYSTEM }
```

---

## 9. 认证设计终态

### 9.1 独立信任域(不可协商)

| 轴 | Human | Integration |
|---|---|---|
| secret | `JWT_SECRET` | `INTEGRATION_JWT_SECRET`(**不得相同**;production ≥48 字符) |
| issuer / audience | 现状不变 | `INTEGRATION_JWT_ISSUER=srvf-dp` / `INTEGRATION_JWT_AUDIENCE=srvf-integration` |
| 有效期 | 现状不变 | ≤30 分钟(建议 10m) |
| refresh | 有 | **无** |
| claims 携带权限 | 否 | **否**(每请求从 PG 读当前事实) |

新增环境变量(沿 `parseActivityV11WorkflowEnabled` 的**既有形状**,别发明新形状 —— [app.config.ts:511-525](../../../src/config/app.config.ts)):

```env
INTEGRATION_API_ENABLED=false          # production/smoke 必须显式 true|false;严格解析,不接受 '1'/'yes'
INTEGRATION_JWT_SECRET=<独立高熵密钥>
INTEGRATION_JWT_ISSUER=srvf-dp
INTEGRATION_JWT_AUDIENCE=srvf-integration
INTEGRATION_SERVICE_TOKEN_EXPIRES_IN=10m
INTEGRATION_DELEGATED_TOKEN_EXPIRES_IN=10m
SERVICE_TOKEN_THROTTLE_LIMIT=10
SERVICE_TOKEN_THROTTLE_TTL_SECONDS=60
```

### 9.2 Client Secret

- `crypto.randomBytes(32).toString('base64url')`;原始值**只在创建响应返一次**;
- 存 `SHA-256`,不存明文;**不用 bcrypt**(高熵随机串,bcrypt 是给低熵人类密码的);
- 比较必须 constant-time;
- **clientId 不存在与 Secret 错误走同一 dummy hash 比较、同一响应、同一可控耗时**(沿仓内既有防枚举范式);
- 轮换 = 新建 B → 外部切换 → 撤销 A;**禁止原地改 Secret**。

### 9.3 冻结接口

```http
POST /api/auth/v1/service-token
Authorization: Basic base64(clientId:clientSecret)
```

```http
POST /api/auth/v1/delegated-token
Authorization: Bearer <Service Token>
{ "delegationGrantId": "..." }
```

两者响应沿 SRVF 统一包装 `{ code, message, data }`,`data = { accessToken, tokenType: "Bearer", expiresIn }`,**不返 refresh**。

### 9.4 Claims

Service:`{ iss, aud, sub=<servicePrincipalId>, tokenUse:'service', credentialId, jti, iat, exp }`
Delegated:`{ iss, aud, sub=<subjectUserId>, tokenUse:'delegated', credentialId, delegationGrantId, act:{ sub:<servicePrincipalId> }, jti, iat, exp }`

**禁止入 claims**:permission codes / role codes / organization scopes / clientSecret / secretHash / 完整 SP 对象。

---

## 10. 授权设计终态

### 10.1 交集,永不并集

```text
SERVICE   : Route 允许 SERVICE ∩ Permission.servicePrincipalAllowed ∩ SP RoleBinding permission ∩ SP scope ∩ Domain invariant
DELEGATED : Route 允许 DELEGATED ∩ servicePrincipalAllowed ∩ delegatedAccessAllowed
            ∩ SP permission/scope ∩ Subject User 现有 Authz permission/scope ∩ Grant permission/scope
            ∩ Domain invariant / ActionConstraint
```

**必须全部通过。** 错误形态:`SP 权限 ∪ User 权限`。

### 10.2 ServicePrincipal 角色资格(七条,`D-IF-5` 口径)

1. Role 未软删;
2. Role 不在 `SYSTEM_MANAGED_ROLE_CODE_SET`(**读常量,不加 schema 列** —— F-5);
3. Role 内**每个** Permission 均 `servicePrincipalAllowed=true`;
4. 默认禁止 `SELF` scope;
5. 无 `SUPER_ADMIN` 短路;
6. 不获得 Member / Position / Supervision 虚拟 grant;
7. 不得授予控制面角色。

**第 7 条的实现方式(`D-IF-5` = A)**:

- **不改** `CONTROL_PLANE_PERMISSION_PREFIXES` / `isControlPlanePermissionCode()`(改它 = 改现有人的委派行为);
- 唯一可靠门 = `servicePrincipalAllowed=false`;
- 加一条**单向 seed 自检**(纵深防御,零行为漂移):
  `∀ code: isControlPlanePermissionCode(code) === true ⇒ Permission(code).servicePrincipalAllowed === false`;
- 运行时**每次判权都过滤 `servicePrincipalAllowed`**,不能只在 RoleBinding 创建时校验;
- 向**已被 SP 绑定**的 Role 新增 `RolePermission` 时,同样拒绝 `servicePrincipalAllowed=false` 的 Permission
  (否则角色后续扩权可绕过初始检查 —— 这是仓内 `#399 F1` 授权洞的同形复发面)。

### 10.3 Principal-neutral 授权核

不复制 `AuthzService`。抽出:

```text
DirectPrincipalAuthzService       # 按 {principalType, principalId} 查显式 RoleBinding
RoleBindingScopeCoveragePolicy    # 与 User direct binding 共享的 scope 覆盖判定
```

复用既有 `ResourceResolver`(`src/modules/authz/resource-resolver.service.ts`)。
现有 `AuthzService` 保留 SUPER_ADMIN / 三源 / 职务推导 / 分管推导 / ActionConstraint,**一行不改语义**。

Delegated 三腿:Service 腿 → `DirectPrincipalAuthzService`;User 腿 → 现有 `AuthzService`;Grant 腿 → `DelegationGrantPolicy`。

### 10.4 路由 Principal Admission(`D-IF-11`)

新增独立轴 `allowedPrincipalKinds: USER | SERVICE | DELEGATED`。

- 所有现有非 Public 路由默认 `USER`;
- **默认值省略序列化**(F-3):`CanonicalRouteAuthzDeclaration` 只在非默认时写出该轴,避免 537 条全量 diff;
- `/api/integration/v1/*` 缺声明 ⇒ Harness 直接红(`AuthzDeclarationGuard` 已是 enforce,天然具备该能力);
- 客户端凭证换 Token 路由声明为 `CLIENT_CREDENTIALS`,**不标 `PUBLIC`**;
- `@Public()` 与 Integration auth metadata **互斥**(须有判据)。

**长期矩阵**(冻结):

| 操作 | USER | SERVICE | DELEGATED |
|---|---:|---:|---:|
| Integration 自检 `/me` | 否 | 是 | 是 |
| 读取有限业务信息 | 可另设 | 是 | 是 |
| 系统自动同步无责任数据 | 否 | 是 | 可选 |
| 创建需真人负责的业务记录 | 否 | **否** | 是 |
| 一级审核 | 是 | 否 | **否** |
| 终审 | 是 | 否 | **否** |
| RBAC / Credential / SP / Grant 控制面 | 是 | **否** | **否** |

---

## 11. Delegation 终态

### 11.1 每次使用必须校验(11 条,缺一即拒)

```text
① SP ACTIVE 且未软删          ② Subject User ACTIVE 且未软删
③ Credential ACTIVE 且未过期  ④ Grant ACTIVE / 未撤销 / 在有效期内
⑤ Grant 属于当前 SP           ⑥ Permission 在 Grant allowlist 内
⑦ Permission.delegatedAccessAllowed = true
⑧ Grant Scope 覆盖目标资源    ⑨ Subject User 自身仍有该权限且覆盖目标资源
⑩ SP 自身有该权限且覆盖目标资源
⑪ GLOBAL 委托只允许 SUPER_ADMIN 明确创建
```

### 11.2 v1 边界

支持:`ServicePrincipal → 固定 User`。
不支持:`→ 职务` / `→ 部门负责人自动解析` / 多级委托链 / 用户自助 OAuth Consent UI。

### 11.3 高危操作硬禁止(Route Principal Admission 层,即使数据配错也拦得住)

用户 / 角色 / 权限 / 凭证 / ServicePrincipal / DelegationGrant 控制面;一级审核与终审;
Storage / SMS / 微信 / 企微 Secret 修改;最后管理员保护相关操作。

---

## 12. 双主体审计终态

### 12.1 语义矩阵

| 场景 | actorUserId | actorServicePrincipalId | onBehalfOfUserId |
|---|---|---|---|
| 真人直接操作 | User | null | null |
| 机器自身操作 | null | SP | null |
| 机器代表真人 | null | SP | User |
| **SRVF 内部系统任务** | **null** | **null** | **null** ← 12 处现存行,CHECK 必须放行 |

### 12.2 DB CHECK(4 条)

1. `actorUserId` 与 `actorServicePrincipalId` 不得同时非空;
2. `onBehalfOfUserId` 非空 ⇒ `actorServicePrincipalId` 非空;
3. `actorCredentialId` 非空 ⇒ `actorServicePrincipalId` 非空;
4. `onBehalfOfRoleSnap` 非空 ⇒ `onBehalfOfUserId` 非空。

> ⚠️ 仓内已记录「DB 约束九个静默失效形状」的教训 —— PR1 必须对每条 CHECK 做**双向变异对拍**(写一条违规行必须被拒),而不是只看 migration 跑通。

### 12.3 写入兼容

`AuditLogInput` **additive optional** 四个字段;205 处现有调用点不传 ⇒ 行为零漂移;Integration 调用方显式传入。
未来收口为 discriminated union **本期不做**。

### 12.4 事件

新增控制面事件 8 条:`service-principal.create/update/status-change/credential-create/credential-revoke`、
`delegation-grant.create/revoke`、`auth.service-token`、`auth.delegated-token`。

**业务事件不另开一套** —— 例如外部提交仍写既有业务事件,区别由双主体字段 + `extra.channel='integration'` 表达。

### 12.5 读取面

Foundation v1 **不改**现有审计读取范围(SA 全量 / 非 SA 沿当前 self-or-user 规则)。SP Audit 默认只进 SA 可见面。

### 12.6 日志

`buildHttpLogProps()` 增 `servicePrincipalId` / `onBehalfOfUserId`。
redact 清单**逐条枚举**(§4.7):`*.clientSecret` `*.secretHash` `*.rawSecret` `*.serviceToken` `*.delegatedToken` `*.credentialSecret`。
禁止日志出现:`clientSecret` / `secretHash` / `rawSecret` / `serviceToken` / `delegatedToken` / `Authorization` / `jti`。

---

## 13. API Surface 与控制面

### 13.1 第六 canonical surface

```text
/api/admin/v1/*  /api/app/v1/*  /api/auth/v1/*  /api/system/v1/*  /api/open/v1/*  + /api/integration/v1/*
```

**同 PR 必须一次性同步的 8 处**(§4.6 表 + 生成物):
`docs/api-surface-policy.md`(**红区**)、`scripts/check-rbac-map.ts`、`scripts/generate-rbac-map.ts`、
contract `CANONICAL_PREFIXES` + `EXPECTED_ROUTES`、`src/bootstrap/apply-swagger.ts` tags/security schemes、
OpenAPI snapshot、`docs/ai-harness/ROUTE_AUTHZ.md` + `RBAC_MAP.md` + `CODEMAP.md`(生成物)、
`.claude/skills/srvf-api-surface/SKILL.md`(2 处)。

### 13.2 控制面端点(落 `system/v1`)

| Method | Path |
|---|---|
| POST / GET | `/api/system/v1/service-principals` |
| GET / PATCH | `/api/system/v1/service-principals/:id` |
| PATCH | `/api/system/v1/service-principals/:id/status` |
| POST / GET | `/api/system/v1/service-principals/:id/credentials` |
| POST | `/api/system/v1/service-principals/:id/credentials/:credentialId/revoke` |
| POST / GET | `/api/system/v1/delegation-grants` |
| GET | `/api/system/v1/delegation-grants/:id` |
| POST | `/api/system/v1/delegation-grants/:id/revoke` |

权限码(新增 9 条,全部绑 ops-admin;**ServicePrincipal 永远不能持有**):

```text
service-principal.create.record      service-principal.read.record
service-principal.update.record      service-principal.update.status
service-principal.create.credential  service-principal.revoke.credential
delegation-grant.create.record       delegation-grant.read.record
delegation-grant.revoke.record
```

> 这 9 条新码全部满足 §10.2 的单向自检(`servicePrincipalAllowed=false`),因为它们是控制面。

### 13.3 自检接口

```http
GET /api/integration/v1/me
Authorization: Bearer <Service or Delegated Token>
```

只返 `{ principalKind, servicePrincipal: { clientId, name }, delegated }`。
**禁返**:raw permission codes / RoleBinding 全量 / client secret / hash / 完整 User 对象 / 身份证 / 手机号等 PII。
**它不是授权诊断器。**

---

## 14. 幂等地基

所有 Integration 写接口强制 `Idempotency-Key: <8-128 chars>`,字符集 `[A-Za-z0-9_.:-]`。

同一 `(servicePrincipalId, operation, idempotencyKey)`:
首次执行并写 receipt;相同 key + 相同 requestHash → 返首次结果不重复写业务;相同 key + 不同 hash → **409**;并发相同请求 → 只允许一个真正执行。

事务算法(同一 PG 事务内):

```text
① pg_advisory_xact_lock(servicePrincipalId + operation + idempotencyKey)   ← 注意 ::text
② 查已有 receipt  ③ 已存在则重放或冲突  ④ 不存在则执行领域命令
⑤ 写 receipt + response snapshot        ⑥ 一起提交
```

**禁止**:内存 Map 幂等 / 先写 receipt 再事务外写业务 / 超时后盲目再建业务记录 /
用 `x-request-id` 代替 / 按 Credential 维度去重 / 每个部门单独建幂等表。

---

## 15. BizCode 段位冻结(37xxx)

**候选表**(精确号位与 HTTP status 由 PR3 冻结,届时须**重新全仓查撞号**):

| 码 | 名 | HTTP | 归一说明 |
|---|---|---|---|
| 37001 | `SERVICE_PRINCIPAL_NOT_FOUND` | 404 | |
| 37002 | `SERVICE_CLIENT_ID_ALREADY_EXISTS` | 409 | |
| 37010 | `SERVICE_CREDENTIAL_INVALID` | 401 | **防枚举归一**:clientId 不存在 / Secret 错 / SP SUSPENDED / Credential 撤销或过期,**全部同码同耗时** |
| 37011 | `INTEGRATION_TOKEN_INVALID` | 401 | Token / 主体 / 凭证失效归一 |
| 37012 | `DELEGATION_GRANT_INVALID` | 403 | Grant 不存在 / 不属于当前 SP / 撤销 / 过期,归一 |
| 37013 | `PRINCIPAL_KIND_FORBIDDEN` | 403 | Route Admission 拒绝 |
| 37020 | `IDEMPOTENCY_KEY_CONFLICT` | 409 | |
| 37030 | `INTEGRATION_API_DISABLED` | 503 | 形状沿既有 `*_NOT_ENABLED`(20036 / 20153)—— 「开关没开」不是「状态不对」 |

**同 PR 强制项(F-6)**:补登段位索引里漏掉的 `36xxx: wecom`,并加 `37xxx: integration`。

---

## 16. Permission eligibility 清单(v1 初始值)

**规则**:migration 默认 `servicePrincipalAllowed=false` / `delegatedAccessAllowed=false`,**234 个现有权限一个都不回填**。

**v1 初始开放集合 = 空**,即 PR1–PR6 交付后没有任何权限对机器开放。
首批开放在 **PR7 立项时**逐条列出并由维护者签字,每条须回答:

| 字段 | 要求 |
|---|---|
| 权限码 | 精确 code |
| `servicePrincipalAllowed` | true / false |
| `delegatedAccessAllowed` | true / false(true 必须蕴含前者为 true) |
| 为什么机器需要它 | 一句话业务理由 |
| 最坏滥用后果 | 一句话 |
| 是否落在 `isControlPlanePermissionCode()` | 必须为 **false**(§10.2 单向自检) |

**永久禁止开放**(即使将来评审):`rbac.*`、`role-binding.*`、`service-principal.*`、`delegation-grant.*`、
6 条 `RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES`、一级审核与终审相关码。

---

## 17. Migration 与回滚风险

### 17.1 Migration

- 现有 **89** 条;PR1 为**第 90 条**,expand-only / additive / 零回填。
- 干净 PostgreSQL 从 0 全量重放 + `prisma generate` + seed **幂等二跑**;
- migration SQL **人工逐行复核**;
- **禁止** AI 自动执行 `prisma migrate dev` / `db push` / `migrate reset`;禁止改历史 migration。

### 17.2 `PrincipalType` enum 的不可逆边界(P1)

`PrincipalType` 增加 `SERVICE_PRINCIPAL` 是**前向兼容但非真正可逆**的 PostgreSQL enum 变更:

- 尚未创建任何 `SERVICE_PRINCIPAL` RoleBinding 行时,回滚旧二进制风险较低;
- **一旦库内已有该 enum 值的 RoleBinding 行**,旧 Prisma Client 查询全部 RoleBinding 时可能无法识别新值;
- ⇒ 激活后优先「**关 Gate + 向前修复**」,不要盲目回滚到 pre-foundation 二进制;
- ⇒ 真要回滚旧二进制,**必须先由维护者审批清理 / 迁出新类型绑定**,AI 不得自动执行。

**这条必须逐字写进 PR8 的发布 runbook。**

### 17.3 回滚顺序

```text
① INTEGRATION_API_ENABLED=false   ← 第一手段,永远
② 撤销 Credential
③ SUSPEND ServicePrincipal
④ REVOKE DelegationGrant
⑤ 保留审计、receipt 与业务数据(不删)
```

---

## 18. PR1–PR8 写集白名单与授权预算

### 18.1 本 T0(A 档)写集

```text
docs/archive/reviews/integration-foundation-v1-t0-terminal-review.md   (新增)
docs/README.md                                                          (索引 + F-13 订正)
docs/ai-harness/NEXT_TASKS.md                                           (P1-30 登记)
```

- 与 open PR **#1085**(`changelog.d/` + `docs/current-state.md` + `scripts/cutover-check.ts`)**零相交**;
- 红区授权:**不需要**。`docs/archive/**` 条目带 `allowCreate: true`,新建放行([check-redzone.ts:96](../../../scripts/check-redzone.ts));`harness:needs` 的「需要授权」是它不模型化 `allowCreate` 的假阳(F-12);
- 不进 CHANGELOG(A 档)。

### 18.2 PR1–PR8 写集与授权

> **排班铁律(F-2)**:PR2–PR7 每个都会改写红区生成物 `docs/ai-harness/ROUTE_AUTHZ.md`(其 `inputDigest` 覆盖全部 `src/**/*.ts`)。
> ⇒ **严格串行,一次只有一条在飞**;并行必冲突,解冲突换 SHA **作废已有环境审批**;合并用 merge 不用 rebase。
> ⇒ 每个 PR 开工前跑 `pnpm harness:needs '<写集>'`,并注意它**只核你点名的路径** —— 报「零红区」不等于零红区。

| PR | 档 | 核心写集(白名单) | 红区 / 授权 |
|---|---|---|---|
| **PR1** Schema 地基 | D | `prisma/schema.prisma`、`prisma/migrations/2026xxxx_integration_foundation/`、`prisma/seed.ts`(仅新 Permission 行,eligibility 全 false) | **red**: `prisma-schema`;**唯一 migration token** |
| **PR2** 控制面 + RoleBinding | D | `src/modules/service-principals/**`、`src/modules/delegation-grants/**`(仅数据管理)、`src/modules/role-bindings/**`、`src/modules/permissions/{rbac-seed-facts,role-delegation.policy}.ts`、`prisma/seed.ts`、`src/modules/audit-logs/audit-logs.types.ts`、生成物 | **red**: `permission-seed-facts`、`prisma-schema`(seed)、生成物 3 份 |
| **PR3** 机器认证 + Token + Gate + 限流 | D | `src/modules/integration-auth/**`、`src/modules/auth/**`(**仅新增端点,现有一行不改**)、`src/common/guards/**`、`src/bootstrap/{throttle-options,logger-options,request-id}.ts`、`src/config/app.config.ts`、`src/common/decorators/service-token-throttle.decorator.ts`、`src/common/exceptions/biz-code.constant.ts`、`.env.example` / `.env.test`、`docs/current-state.md`(F-7 订正)、生成物 | **red**: `auth-frozen`、`global-pipeline`、`authz-core`、`test-env`;`.env.test` 需令牌 |
| **PR4** Principal-neutral Authz | D | `src/modules/authz/**`、`src/common/authz/authz-context.ts`、`src/common/decorators/route-authz.decorator.ts`、`src/modules/permissions/**`、`scripts/generate-authz-manifest.ts`、`scripts/authz-semantic-diff.ts`、生成物 | **red**: `authz-core`、`enforcement-layer`(两支 scripts)、生成物 |
| **PR5** Delegation + 双主体 Audit | D | `src/modules/delegation-grants/**`、`src/modules/integration-auth/**`、`src/modules/audit-logs/**`、`prisma/schema.prisma`(若 CHECK 补充)、生成物 | **red**: `prisma-schema`(如动)、生成物 |
| **PR6** 第六 Surface + `/me` + 幂等 | D | `src/modules/integration-idempotency/**`、Integration Controller、`src/bootstrap/apply-swagger.ts`、`docs/api-surface-policy.md`、`scripts/{check,generate}-rbac-map.ts`、`test/contract/openapi.contract-spec.ts`、`docs/openapi.json`、`.claude/skills/srvf-api-surface/SKILL.md`、`docs/ops/integration-api-runbook.md`、生成物 | **red**: `protected-docs`(api-surface-policy)、`global-pipeline`(bootstrap)、`enforcement-layer`(scripts + test/contract)、生成物 |
| **PR7** 首个真实业务接入 | C/D | 目标业务模块的 `controllers/integration-*.controller.ts` + 独立 DTO + Facade;**禁止**新建 `src/modules/integration/everything.service.ts` | 按目标模块定;**禁止**触碰 §6 列的 13 处考勤闸位 |
| **PR8** Runbook / Handoff / Release | E | `docs/ops/integration-api-runbook.md`、`docs/handoff/**`、`CHANGELOG.md`、`docs/current-state.md` | E 档需 global preflight 全过(0 open PR) |

**每个 PR 的报告必须含**:exact SHA / PR 链接 / 写集;修改文件;schema-migration-seed-auth-guard-audit-contract 变化;
snapshot diff **逐行解释**;本地命令与 CI 结果;**安全不变量自证**;本次未做;residual risk;是否建议维护者合并。

---

## 19. 测试与验收矩阵

### 19.1 现有系统零漂移(每个 PR 都要过)

- Human `JwtPayload` 恰 `{sub, username}`;User JWT / refresh / logout / 防枚举行为锁全绿;
- 537 endpoint path/method/schema 不变(除各 PR 明示的净新增);
- 现有权限判定矩阵全绿;现有 Audit 旧行读取兼容;
- **Cron 恒 2**;不引入 Redis / queue / LLM / vector / 多租户。

### 19.2 Credential

Secret 只显一次;hash-only;错误归一 + dummy hash;多 Credential 轮换;revoke 后既有 Token **下一请求**失效;
日志 / Audit / OpenAPI / snapshot 无 Secret 或 hash。

### 19.3 Token 隔离

Human Token 调 Integration → 拒;Service Token 调 Admin/App/System → 拒;Delegated Token 调 Direct-User-Only → 拒;
错 issuer / audience / signature / tokenUse → **统一拒**;Gate false → 503;Service/Delegated Token **不生成 refresh row**。

### 19.4 RBAC

`SERVICE_PRINCIPAL` RoleBinding 可建 / 可查 / 可撤;**未知 principal type 不落入 Position Assignment**(F-5 的正对照);
ineligible Permission 导致绑定拒绝;direct grant scope 生效;SP 无职务 / 分管 / SA 短路;撤权下一请求生效。

### 19.5 Delegation 全矩阵

| SP | User | Grant | Scope | 期望 |
|---|---|---|---|---|
| allow | allow | allow | cover | **allow** |
| deny | allow | allow | cover | deny |
| allow | deny | allow | cover | deny |
| allow | allow | deny | cover | deny |
| allow | allow | allow | not cover | deny |

另测:expired / future / revoked Grant;disabled 或软删 User;suspended SP;revoked Credential;
grant 属于另一个 SP;non-delegatable permission;**caller-controlled subject 字段不存在**(DTO 里根本没有该字段)。

### 19.6 Audit

四种行的字段组合正确(含**内部系统任务三项全 null**);DB CHECK 拦非法组合(**双向变异对拍**);
Audit 写失败仍回滚业务事务;非 SA 读取范围未意外扩大。

### 19.7 Idempotency

首次成功;相同 key+hash 重放;相同 key+不同 hash → 409;**20 并发相同请求只写一条业务**;
业务失败不留 receipt;不同 SP 相同 key 互不影响;同 SP 不同 operation 相同 key 互不影响。

### 19.8 必跑命令

```bash
pnpm agent:preflight
pnpm agent:check:quick
pnpm test:contract
pnpm docs:openapi:check
pnpm docs:authz:check
pnpm docs:rbacmap:check
pnpm docs:codemap:check
pnpm docs:counts:check
pnpm harness:selftest
pnpm gate:v11:check          # ← 本稿新增:PR7 及任何触碰活动/考勤的 PR 必跑
```

全量 `agent:check:full` **恒由 PR CI 冷跑裁决**;本机只跑 `quick` + 定向 spec(仓内已三次实录:本地连跑全量必出榨干假红)。
Schema PR 另加:干净库全 migration 重放 + seed 二跑 + migration SQL 人工逐行复核。

---

## 20. 风险表

| 风险 | 级 | 控制 |
|---|---|---|
| 改全局 Guard 导致现有接口未登录 / 误放行 | P0 | 路由 metadata 分派;existing route 默认 USER;全量 auth e2e 由 CI 冷跑 |
| **Integration principal 落到 `request.user`** | **P0** | **F-1**:独立 request key + selftest 断言(正对照必须转红) |
| Human / Service Token confusion | P0 | 独立 secret / issuer / audience / strategy / route scheme |
| 机器权限过大 | P0 | eligibility 默认 false;Role 全量资格检查;单向 seed 自检;无 SA / 虚拟 grant |
| 外部系统冒充任意人 | P0 | subject 只来自 Grant;DTO / param 里**根本没有** userId 字段;Harness subject-input 检查 |
| 委托权限提升 | P0 | SP ∩ User ∩ Grant,禁并集 |
| 审批责任被机器绕过 | P0 | Route Principal Admission = Direct User Only |
| 绕过业务逻辑写 DB | P0 | DB 永不开放;Integration 只调领域命令核 |
| **新旧考勤链混跑** | **P0** | **§6 冻结结论 C-ATT-1/2/3**:PR7 不做考勤;任何 PR 禁止新增绕闸通路;`gate:v11:check` 必跑 |
| **PR 并行导致生成物冲突 → 环境审批作废** | **P1** | **F-2**:严格串行;merge 不 rebase;每 PR 前跑 `harness:needs` |
| **`allowedPrincipalKinds` 淹没语义门** | **P1** | **F-3 / D-IF-11**:默认值省略序列化 |
| 重试造成重复记录 | P1 | receipt + advisory lock + 同事务 |
| Secret 泄漏 | P1 | 一次展示 / hash-only / 逐条 redact / 短 Token / revoke |
| 旧二进制不识别新 enum | P1 | §17.2:分阶段激活;Gate off;激活后优先 roll-forward;回滚须维护者审批 |
| Audit 看不出真实 Actor | P1 | 双主体字段 + CHECK + HTTP log context |
| Scope 逻辑复制漂移 | P1 | 抽共享 coverage policy + characterization |
| 新 Surface 绕过 contract | P1 | canonical prefix / Harness / EXPECTED_ROUTES **同 PR** 更新(§13.1 的 8 处) |
| 项目拖延首次上线 | P1 | **§3 的 B-1/B-2/B-3 三条判据** + `D-IF-2` 推荐上线后开工 |
| **扩宽控制面前缀常量误伤现有委派** | **P1** | **F-4 / D-IF-5 = A**:不动既有谓词,只加单向断言 |

---

## 21. 本期明确不做

Developer Portal / 应用市场 / 外部开发者自助注册 / 用户 OAuth Consent 页面 / Webhook 管理平台 /
多语言 SDK / mTLS / DPoP / `private_key_jwt` / 公私钥 Credential / 按调用量计费 / 多租户 /
Redis / queue / cache / **第 3 个 Cron** / 外部系统直接审批或终审 / 一次性开放全部内部 API /
外部系统数据库只读账号 / 部门专属表名 · 权限名 · 模块名 / 部分成功批量导入 / 为尚未出现的业务提前重构全部 Service。

**额外(本稿新增)**:

- 不做考勤业务写接口(§6 C-ATT-1);
- 不改现有 `isControlPlanePermissionCode()` / `CONTROL_PLANE_PERMISSION_PREFIXES` 的语义(F-4);
- 不给 `RbacRole` 加 `systemManaged` 列(F-5);
- 不把 `AuditLogInput` 收口成 discriminated union(§12.3);
- 不改现有审计读取范围(§12.5)。

---

## 22. 参考

- OAuth 2.0(RFC 6749)Client Credentials — https://datatracker.ietf.org/doc/html/rfc6749
- OAuth 2.0 Token Exchange(RFC 8693)`act` claim — https://datatracker.ietf.org/doc/rfc8693/
- GitHub Apps:installation token vs user access token — https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user
- Microsoft Entra:application objects and service principals — https://learn.microsoft.com/en-us/entra/identity-platform/app-objects-and-service-principals
- AWS STS `AssumeRole`(短期凭证) — https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html

仓内:
[`AGENTS.md`](../../../AGENTS.md) · [`docs/process.md`](../../process.md) · [`docs/current-state.md`](../../current-state.md) ·
[`docs/api-surface-policy.md`](../../api-surface-policy.md) · [`docs/security.md`](../../security.md) ·
[`harness/redzone.json`](../../../harness/redzone.json) · [`wecom-integration-t0-terminal-review.md`](./wecom-integration-t0-terminal-review.md)(T0 体例先例)

---

## 23. 最终验收结论(Foundation v1 完成时应成立)

```text
外部系统不接触数据库
外部系统不保存真人密码
每个系统拥有独立机器身份和可轮换凭证
机器只能取得最小权限和最小范围
需要真人责任时必须存在正式委托
业务创建人仍是真人
技术调用者仍可追溯到具体系统和 Credential
所有写操作仍经过 SRVF 唯一业务逻辑
重试不会重复写入
撤权下一请求生效
现有官方后台、App、小程序和 537 个接口行为不变
首次生产上线不被本项目阻塞
```
