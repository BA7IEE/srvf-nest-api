# SRVF Code Architecture Boundary Review

> **状态**:**Phase 0.7 设计期文档 v0**(2026-05-19)
> **性质**:**implementation-boundary review**(不是代码重构 PR;不是开发授权)
> **范围**:只定义后续代码实现边界,**不**改代码
>
> **与前序评审稿关系**:
>
> - [Phase 0](api-client-boundary.md) 解决 **API surface**(`/api/auth/v1` / `/api/public/v1` / `/api/app/v1` / `/api/admin/v1` / `/api/system/v1` 五段顶层边界)
> - [Phase 0.5](app-permission-boundary-review.md) 解决 **App 身份 / 权限 / capability**(11 类身份 × 9 capability + AppSelf/AppPeer/AppManaged DTO 命名 + §10.2 D-1~D-4 已锁决议)
> - [Phase 0.6](data-access-lifecycle-boundary-review.md) 解决 **surface / field / scope / state / lifecycle**(140 endpoint × 4 档敏感等级 × 6 档 scope × 7 个状态机 + User/Member 生命周期矩阵)
> - **Phase 0.7(本文档)** 解决 **后续代码实现时如何分层承载这些规则**(Controller / DTO / Presenter / QueryService / CommandService / PolicyService / StateMachine / AuditRecorder / Effect / Reporting)
>
> **冲突优先级**:本文档优先级**最低**;冲突时让步给 [`ARCHITECTURE.md`](../ARCHITECTURE.md) / [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) / [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) / [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) / 既有批次评审稿 / Phase 0 / 0.5 / 0.6。
> **本文档不实施任何东西**:不改 schema / Role / endpoint / DTO / controller / service / test / dep。
> **生效条件**:本评审稿经用户拍板后,Phase 2 App API 实施评审稿启动时**必须**先消化本文档 §1-§10 边界。

---

## 0. TL;DR

1. **现状(沿 v0.14.0 仓库 HEAD)**:25 个 Controller / 140 个 endpoint;顶 6 个 service 累计 **4862 行**,其中 `attendances.service.ts` 单文件 **1413 行**,`attachments.service.ts` **885 行**,`activity-registrations.service.ts` **808 行** — 已经接近"难审查 / 难安全扩展"门槛
2. **本文档不是重构 PR**:不拆任何现有 service / controller / DTO;不新增任何 architecture-layer 代码(Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect / Workflow / Export / Report / DictionaryReader / ConfigReader)
3. **本文档锁定 10 个代码架构边界**:为后续 Phase 2 App API 实施与未来大 service 重构建立 implementation boundary
4. **P0 边界 5 项**:DTO/Presenter、Action+Scope+FieldPolicy 三层授权、StateMachine、QueryService、AuditRecorder
5. **P1 边界 5 项**:Effect/Workflow/Outbox、Export/Report、UserMemberLifecycle/AppIdentityResolver、Dictionary/Config Reader、多端 Swagger/SDK
6. **触发重构条件 10 条**:明确"什么样的新需求必须立刻走新边界,不能继续往大 service 塞"
7. **不立即重构清单**:沿 v1 §1 / V1.1 §17.3 / 本文档 §6 — 现有 service 不动,Phase 2 / Phase 5 / 后续大 service 评审时再单独立项拆

---

## 1. Surface Controller Boundary(Controller 按 surface 拆)

### 1.1 目标结构

Controller 按 **surface**(沿 [Phase 0.6 §1.1](data-access-lifecycle-boundary-review.md))物理拆分:

| Surface | Controller 命名 | 路径前缀 |
|---|---|---|
| `public` | `public-*.controller.ts` 或 `health.controller.ts` 等 | `/api/public/v1/*` |
| `mobile` | `mobile-*.controller.ts` 或 `app-*.controller.ts` | `/api/app/v1/*` |
| `admin` | `admin-*.controller.ts` | `/api/admin/v1/*`(新接口)/ `/api/v2/*`(Admin Legacy) |
| `ops` / `system` | `system-*.controller.ts` 或 `ops-*.controller.ts` | `/api/system/v1/*` |
| `internal` | `internal-*.controller.ts`(当前无,留作扩展)| 内网或不暴露 |

**示例目标结构(沿 [boundary §4](api-client-boundary.md) 与 Phase 0.5 §6.3):**

```txt
src/modules/activities/
├── controllers/
│   ├── mobile-activities.controller.ts        # /api/app/v1/activities*
│   ├── admin-activities.controller.ts         # /api/admin/v1/activities* + /api/v2/activities*(Legacy)
│   └── (未来若有 public 活动列表)
│       public-activities.controller.ts        # /api/public/v1/activities*(招新页;暂未规划)
├── activities.module.ts
├── activities.service.ts                       # 业务能力,跨 controller 复用
├── activities.repository.ts                    # Prisma 访问层(可选;现状 service 内直读 prisma 也 OK)
└── dto/
    ├── app/
    ├── admin/
    └── (按需 system/)
```

### 1.2 铁律

1. **同一业务 Service 可被多个 surface Controller 复用**(`ActivitiesService` 同时给 `mobile-activities` 与 `admin-activities` 用)
2. **Controller 不应长期混用 mobile / admin / ops**;若发现某 Controller 三 surface 都覆盖,**必须**单独立项物理拆
3. **新增 App API 必须新建 mobile Controller**(沿 [Phase 0.5 §10.2 D-4](app-permission-boundary-review.md) `/me/*` + `/my/*` 物理分离)
4. **旧 `/api/v2/*`** 可作为 Admin Legacy 长期保留(沿 [Phase 3 方案 C](api-client-boundary-migration-plan.md));**不**强制迁移
5. **System / Ops 接口不得混入普通 Admin Controller**;`dictionaries` / `permissions` / `rbac-*` / `audit-logs` / `storage-settings` / `attachment-*-configs` / `contribution-rules`(沿 [`CLAUDE.md §19.7 D-1`](../CLAUDE.md))在 Phase 4 拆出 system controller
6. **Mixed Controller 后续只允许渐进拆**(沿 [Phase 0 boundary §3 铁律 8](api-client-boundary.md)),**禁止**在 Mixed 中继续扩张新 endpoint / 新业务能力

### 1.3 当前现状

> 沿 [inventory §2](api-client-boundary-inventory.md):

- **已物理拆 controller**(单文件多 Controller 类):`activity-registrations`(admin block + me block)/ `attendances`(activity-scope + sheet + me)— 命名上**尚未**按 `mobile-` / `admin-` 前缀拆,DTO 仍共用
- **未物理拆 controller**(单 Controller 同时承载 surface 边界):`users`(`/me` × 3 + 管理 × 8)/ `activities` `list` + `findOne`(Mixed `@Roles(SUPER_ADMIN, ADMIN, USER)`)/ `attachments`(`/me/uploaded` + admin 操作)
- **本期不拆**(沿 §6 不立即重构清单);Phase 5 实施时单独立项

---

## 2. DTO / View / Presenter Boundary

### 2.1 概念分层

| 概念 | 定义 | 当前位置 | 目标位置 |
|---|---|---|---|
| **DTO** | API 入参 / 出参合同(被 controller 直接消费;暴露给 OpenAPI snapshot) | `src/modules/<mod>/<mod>.dto.ts` 或同目录 `dto/` | 拆 `dto/app/` / `dto/admin/` / `dto/system/` / `dto/internal/` |
| **View** | 某个使用场景的返回视图(同一 entity 不同视角投影;如 `AppMyActivityListView` ≠ `AdminActivityDetailView`) | 当前未明确分层;混在 DTO 内 | 复杂场景下 view = DTO 的具名子集 |
| **Presenter** | `entity / domain` → `DTO/View` 的转换层 | 当前散在 service 内(`select: {...}` + 手动 map) | 显式 Presenter 文件 / function |
| **Select** | Prisma 数据库查询字段(`prisma.user.findUnique({ select: ... })`) | 部分集中(如 [users.select.ts](../src/modules/users/users.select.ts));部分散落 | 每个 surface select 单独维护 |
| **FieldPolicy** | 字段可见性规则(L0 / L1 / L2 / L3 × surface × scope) | 沿 [Phase 0.6 §2](data-access-lifecycle-boundary-review.md);**当前未代码化** | 与 Presenter 协同(Presenter 调 FieldPolicy 决定哪些字段输出)|

### 2.2 铁律(Phase 2 实施时强约束)

> 沿 [Phase 0.5 §6.2](app-permission-boundary-review.md) + [Phase 0.6 §2.4](data-access-lifecycle-boundary-review.md):

1. **禁止 App DTO 继承 Admin DTO**(`class AppXxxDto extends AdminXxxDto` 视作越权;PR review 强制拒绝)
2. **禁止 App DTO 使用 `PickType` / `OmitType`** 从 Admin DTO 裁剪生成(NestJS swagger mapped-types 的隐性继承同样禁止)
3. **禁止把 Prisma model 直接作为 response contract**;`User` / `Member` / `Activity` 等 Prisma 类型**仅在** service 内使用,**绝不**返给 controller
4. **敏感字段裁剪不得散落在 controller / service**;必须在 Presenter / FieldPolicy 层集中维护
5. **新增 L2 / L3 字段时必须同步更新 FieldPolicy**;沿 [Phase 0.6 §2.2 表](data-access-lifecycle-boundary-review.md);新增字段不进 FieldPolicy 视作 review 拒绝信号
6. **`AppSelf*Dto` / `AppPeer*Dto` / `AppManaged*Dto` / `Admin*Dto` / `System*Dto` 必须物理分开**(独立文件 / 独立类型;**禁止**通过类型别名共享)

### 2.3 建议命名(沿 [Phase 0.5 §6.1](app-permission-boundary-review.md))

```txt
AppSelfProfileDto           # 本人资料
AppMyRegistrationDto        # 本人持有的报名
AppPeerMemberSummaryDto     # App 看别人(脱敏摘要)
AppManagedActivityRegistrationDto  # 我管的活动报名(任务范围内)
AdminMemberDetailDto        # 后台资源详情
SystemContributionRuleDto   # 系统配置
```

### 2.4 当前现状

> 沿 [Phase 0.6 §1.3](data-access-lifecycle-boundary-review.md) Mixed 风险清单:

- `UserResponseDto` 同时给 App `/me` 与 Admin `/:id` 用 — **Phase 2 强制拆**
- `ActivityResponseDto` 三角共用 — **Phase 2 强制拆**
- `AttachmentResponseDto` 上传 / 列表 / `/me/uploaded` 共用 — **Phase 2 强制拆**
- `ActivityRegistrationResponseDto` / `AttendanceRecordResponseDto` controller 已拆但 DTO 共用 — **Phase 2 强制拆 DTO**

---

## 3. Authorization Boundary(三层授权边界)

### 3.1 三层定义

```txt
ActionPermission   →  能不能做这类动作?
                      由 rbac.can(currentUser, '<action-code>') 或 capability 表决定
                      例:rbac.can(user, 'activity-registration.review')

DataScope          →  这个动作能作用于哪批数据?
                      由 service 内 assertCanXxx + where 子句决定
                      例:where: { memberId: currentUser.memberId } 限定本人

FieldPolicy        →  返回时能看到哪些字段?
                      由 DTO 类型 + select(...) + Presenter 决定
                      例:AppSelfDto 不含 deletedAt / passwordHash
```

**正交关系**(沿 [Phase 0.6 §3.2](data-access-lifecycle-boundary-review.md)):

```txt
RBAC(动作)     × Scope(范围)     × Field(字段)     × State(状态机)
   ↓                ↓                  ↓                  ↓
能不能做?        作用于哪批?        看到哪些字段?     当前状态允许?
```

**铁律**:四个维度**全部通过**,动作才允许;**任一不通过**,拒绝。

### 3.2 capability ≠ 授权证明

沿 [Phase 0.5 §10.2 D-3 / `CLAUDE.md §19.7 D-5.3`](../CLAUDE.md):

- `GET /api/app/v1/me/capabilities` 返回 `canRegisterActivity: true` 等 product-level 字段 — **只是 UI hint**,前端用它决定按钮是否显示
- 后端**仍必须**在 `POST /api/app/v1/my/registrations` 写端点**重新校验** `ActionPermission` + `DataScope` + `FieldPolicy` + `StateMachine`
- **禁止**把 capability 当成"我已经检查过权限,后端可以跳过校验"的证明
- **禁止**前端传 capability 头给后端"声明权限"

### 3.3 反模式:Role 短路

**禁止**写成:

```ts
// ❌ 错误:Role 直接决定字段集
if (user.role === 'ADMIN') {
  return allFields;
}
return appSelfFields;
```

**正确**(沿 §3.1 四维分层):

```ts
// ✅ 正确:action permission → scope resolver → field policy → presenter
await this.policy.assertCanRead(user, target);  // ActionPermission
const scope = this.scope.resolve(user, target); // DataScope
const dto = this.presenter.toAppSelf(target, scope); // FieldPolicy
return dto;
```

**为什么禁止 Role 短路**(沿 [Phase 0.5 §1.4](app-permission-boundary-review.md) Admin 兼队员陷阱):

- `ADMIN` 兼队员调 `/api/app/v1/my/registrations` 应**仅**返回本人报名(`scope = self`),即使他是 admin
- `Role.USER` ≠ "mobile access";`Role.ADMIN` 不扩大 AppSelf 字段可见性
- Role 是入口判定,**不**是字段判定

---

## 4. QueryService Boundary

### 4.1 职责范围

`<Module>QueryService` 承载**所有列表 / 筛选 / scope / 分页 / total / 导出字段**逻辑:

| 关注点 | 由 QueryService 承担 |
|---|---|
| DTO filter → Prisma where | ✅ 把 `ListXxxQueryDto` 翻译成 `Prisma.XxxWhereInput` |
| DataScope → Prisma where | ✅ 把 scope(`self` / `department` / `activity` / `managed` / `all`)翻译成 where 限制 |
| 默认排序 | ✅ 沿 [`CLAUDE.md §4` 分页](../CLAUDE.md) `orderBy: { createdAt: 'desc' }` |
| 可搜索字段 | ✅ DTO `q` / `keyword` 字段映射到允许搜索的列(白名单)|
| 可导出字段 | ✅ 导出时的字段集与列表查询不同时必须显式声明 |
| 分页与 total | ✅ `skip` / `take` / `total = count(where)` |
| Mobile / Admin / Export 查询差异 | ✅ 不同 surface 调不同 method;**禁止**单 method 通过参数分支 |

### 4.2 反模式禁止

1. **禁止先查大量数据再内存过滤做分页**(`findMany({ take: 10000 })` 后 `.filter(...)` 是 N+1 / OOM 风险)
2. **禁止 App / Admin / Export 共用无 scope 区分的查询方法**;每 surface 单独 method
3. **禁止导出逻辑复制列表查询规则**;导出与列表共用 where 表达,但 select 字段集**必须**单独维护
4. **禁止 scope 规则散落在多个 service 方法**;统一在 QueryService 入口收口

### 4.3 建议未来命名

```txt
ActivityQueryService          # 活动列表 / 筛选 / 详情
RegistrationQueryService      # 报名列表 / 筛选 / 统计 / 导出
AttendanceQueryService        # 考勤列表 / 筛选 / 我的考勤
MemberQueryService            # 队员列表 / 筛选 / 部门内 / 全量
AttachmentQueryService        # 附件列表 / by-owner / me/uploaded
AuditLogQueryService          # 审计日志查询
```

### 4.4 本期不实施

沿 §6 不立即重构清单。**Phase 2 实施 App API 时**,新增 method 可以**先内嵌**在现有 service 内,但**必须**符合本节铁律(scope 显式 / 字段白名单 / 导出与列表分开 method);当某 service 累计 5+ list method 时考虑抽 QueryService。

---

## 5. CommandService Boundary

### 5.1 职责范围

`<Module>CommandService` 承载**所有写操作**(create / update / delete / approve / reject / cancel / status transition):

```txt
Controller
   ↓ (DTO 输入)
CommandService
   ├→ PolicyService.assertCanXxx(actor, target)      ← §6 业务合法性
   ├→ StateMachine.canTransition(from, action)        ← §7 状态合法性
   ├→ prisma.$transaction([                           ← DB 事务
   │     主写动作,
   │     联动写(如 P0-E refresh token 撤销),
   │     AuditRecorder.write(...)                     ← §8 审计
   │  ])
   └→ EffectDispatcher.enqueue(...)                   ← §9 副作用(post-commit)
```

### 5.2 铁律

1. **Controller 不直接拼业务逻辑**;Controller 只负责入参校验 + 调 CommandService + 返 DTO
2. **Service 不应同时承担**:查询 + 命令 + 状态机 + 审计 + 副作用 + Presenter 全部职责;当前 [`attendances.service.ts:1413`](../src/modules/attendances/attendances.service.ts) 实际承担了 6 类职责,这是**反模式样本**
3. **写操作有明确事务边界**:沿 [`CLAUDE.md §12` 事务铁律](../CLAUDE.md);多个写操作 / 先检查再写入 / 管理员保护类必须 `prisma.$transaction`
4. **写操作的副作用不能和主交易混为一团**:发送短信 / 推送通知 / 删除附件物理文件 / 重算贡献值等沿 §9 Effect / Workflow 边界,**post-commit** 执行(若失败不回滚主交易)

### 5.3 建议未来命名

```txt
ActivityCommandService        # publish / cancel / softDelete
RegistrationCommandService    # create / approve / reject / cancel
AttendanceCommandService      # submit / approve / final-approve / final-reject
CertificateCommandService     # create / verify / reject
MemberCommandService          # create / updateStatus / softDelete
UserCommandService            # changePassword / resetPassword / updateRole / disable
```

### 5.4 本期不实施

沿 §6。Phase 2 新增 App write endpoint 时**直接**调既有 service method 即可;**禁止**借此契机大规模重命名 / 拆分既有 service。

---

## 6. PolicyService Boundary

### 6.1 职责范围

`<Module>PolicyService` 承载**业务规则判断**(business rule guards),与 RBAC / StateMachine 正交:

| 维度 | 由谁判 | 例 |
|---|---|---|
| **粗粒度动作授权** | `rbac.can(user, '<code>')` | "我能不能调 `activity.update` 这个动作" |
| **业务合法性** | `PolicyService.canXxx(user, target, context)` | "这个活动还在报名期吗?报名上限到了吗?我已经报过这个活动了吗?" |
| **状态合法性** | `StateMachine.canTransition(from, action)` | "从 `pending` 能否走 `approve` 动作" |

### 6.2 至少覆盖

> Phase 2 / Phase 5 实施时,以下判断**必须**走 PolicyService:

- 是否能报名某活动(报名期内 + 上限未满 + 本人未报过 + 资格证书匹配)
- 是否能取消报名(在取消窗口期 + 报名状态可取消)
- 是否能审核报名(我是该活动的负责人吗 + 报名状态是 pending 吗)
- 是否能查看考勤(本人 / 同活动 / 同部门 / Admin)
- 是否能查看证书(本人 / 已公示 / Admin)
- 是否能导出某 view(导出权限 + 数据范围)
- 是否能访问某附件(附件 owner / 公示标志 / 当前用户范围)
- 是否能查看高敏字段(沿 [Phase 0.6 §2.3](data-access-lifecycle-boundary-review.md) 字段分级)
- 是否能触发通知 / 短信(发送频率 / 用户偏好 / 频次限流)

### 6.3 铁律

1. **不要把所有判断都塞进 `rbac.can(...)`**;RBAC 是动作权限,Policy 是业务合法性
2. **PolicyService 是只读判断**,**禁止**在 PolicyService 内执行写操作
3. **PolicyService 应抛具体 BizException**(`CANNOT_REGISTER_FULL` / `REGISTRATION_WINDOW_CLOSED` / `ALREADY_REGISTERED` 等),便于前端友好提示
4. **PolicyService 与 RBAC + StateMachine 协作**:三者同等重要,**不**互相替代

### 6.4 当前现状

业务规则判断当前**散落**在大 service 中(`activities.service.ts` 内 `assertCanRegister` / `attendances.service.ts` 内 `assertCanFinalApprove` 等)。**本期不拆**;Phase 2 / Phase 5 实施时单独立项。

---

## 7. StateMachine Boundary

### 7.1 职责范围

每个核心模块(Activity / Registration / AttendanceSheet / Certificate / User / Member)未来应有**显式 transition 定义**,而不是零散 `if (status === 'pending') { ... }` 判断。

### 7.2 transition 规范字段

每条状态转移必须显式描述:

| 字段 | 说明 |
|---|---|
| `from` | 起始状态 code |
| `action` | 触发动作名 |
| `to` | 目标状态 code |
| `actor` | 谁能触发(actor type + permission code)|
| `scope` | 数据范围(沿 §3 / Phase 0.6 §3.1)|
| `guard` | 进入 transition 前的 Policy 检查(沿 §6)|
| `audit` | 是否必写审计(沿 §8)|
| `sideEffects` | 进入 to 后的副作用(沿 §9)|
| `failureCode` | guard 失败 / state 不允许时抛的 BizException |

### 7.3 必须覆盖目标模块

| 模块 | 当前状态机数 | 实施状况 |
|---|---|---|
| `Activity` | 4 态(draft / published / cancelled / completed)| ⚠️ 字典 code 字符串,service 层校验 |
| `Registration` | 4 态闭集(pending / pass / reject / cancelled)| ⚠️ 同上 |
| `AttendanceSheet` | 5 态(pending / pending_final_review / approved / rejected;含中间态)| ⚠️ 同上 |
| `Certificate` | 4 态闭集(pending / verified / expired / rejected)| ⚠️ 同上 |
| `User` | 2 态 + deletedAt = 3 态 | ✅ Prisma enum 强约束 |
| `Member` | 2 态 + deletedAt = 3 态 | ✅ Prisma enum 强约束 |

详见 [Phase 0.6 §4](data-access-lifecycle-boundary-review.md) 状态机矩阵。

### 7.4 铁律

1. **Phase 0.6 §4 是 design baseline,不是 implementation proof**;当前 service 层已有部分状态校验,但不是完整状态机抽象
2. **后续新增复杂状态(如 AttendanceSheet 5 态)时,不允许继续只靠零散 if 判断扩张**;**必须**抽显式 transition table
3. **transition table 应集中维护**(如 `activity-state.ts` / `registration-state.ts` 等),**禁止**散落在多个 service method
4. **非法 transition 必须抛具体 BizException**,**禁止**默默 no-op 或返成功
5. **状态转移必须在 `prisma.$transaction` 内**(沿 §5.2 #3),防并发双写

### 7.5 本期不实施

沿 §6。Phase 2 新增 App API 涉及报名取消等单步 transition 时**直接**调既有 service method 即可;Phase 5 拆大 service 时一并抽 StateMachine。

---

## 8. AuditRecorder Boundary

### 8.1 职责范围

审计构造归**统一层**,**禁止**每个 service 各自手写。沿 [`docs/批次6_audit_logs_API前评审.md`](批次6_audit_logs_API前评审.md) A-1 红线(audit_logs 写入即不可改不可删)。

### 8.2 audit row 应包含

> 沿当前 `audit-logs.types.ts` 字段集 + 本节扩充建议:

| 字段 | 必填? | 说明 |
|---|---|---|
| `actor` | ✅ | `userId` + `memberId`(若有);系统动作时记 `'system'` |
| `resource` | ✅ | `resourceType`(`user` / `member` / `activity` / ...)+ `resourceId` |
| `action` | ✅ | 动作 code(沿 `AuditLogEvent`) |
| `before` | ⚠️ | 操作前快照(写操作必填,读操作可选) |
| `after` | ⚠️ | 操作后快照(写操作必填) |
| `diff` | ⚠️ | `before` / `after` 字段级 diff(可由 AuditRecorder 自动生成) |
| `requestId` | ✅ | 沿 [`CLAUDE.md §17.2`](../CLAUDE.md) `nestjs-pino` 请求 ID |
| `ip` | ✅ | `request.ip` |
| `userAgent` | ✅ | `request.headers['user-agent']` |
| **sensitive field masking** | ✅ | L2 / L3 字段**禁止**写入 `before` / `after` 明文;只记字段名 + "redacted" |
| `read_audit` | ⚠️ | 高敏字段读取(身份证号完整查看 / 紧急联系人查看)单独审计 |
| `export_audit` | ⚠️ | 导出动作必写,记导出 view / 字段集 / 行数 |
| `failed_operation_audit` | ⚠️ | 鉴权失败 / Policy 失败的写动作尝试也应留痕(可选,沿运营诉求决议) |

### 8.3 必须统一审计的动作

> 沿 [Phase 0.6 §6.5 + §6.8 高风险返工点](data-access-lifecycle-boundary-review.md):

| 动作 | 当前是否已审计 | Phase 2 / 5 应保证统一 |
|---|---|---|
| 修改密码(本人 / 管理员重置) | ✅ 已实施(P0-D / P0-E)| 保持 |
| 修改队员敏感资料(`member_profiles` PATCH)| ⚠️ 部分 | Phase 2 统一 |
| 修改 Member 状态(in/out) | ⚠️ 部分 | Phase 2 / 5 统一 |
| 活动发布 / 取消 | ⚠️ 部分 | Phase 5 统一 |
| 报名审核 / 取消 | ⚠️ 部分 | Phase 2 / 5 统一 |
| 考勤审核 / 终审 | ⚠️ 部分 | Phase 5 统一 |
| 证书审核 / 驳回 | ⚠️ 部分 | Phase 5 统一 |
| 权限 / 角色 / 用户角色变更(RBAC)| ✅ 已实施(P0-F)| 保持 |
| 存储配置 / SMS 配置 / 凭证重置 | ⚠️ Phase 4 system API 评审统一 | Phase 4 |
| 导出数据 | ❌ 未实施 | Phase 2 / 4 评估 |
| 查看高敏字段(完整身份证号 / 紧急联系人) | ❌ 未实施(读审计未启用)| 沿运营诉求 |
| 生成 signed URL | ❌ 未实施 | Phase 2 / 4 评估 |

### 8.4 铁律

1. **AuditRecorder 必须在 `prisma.$transaction` 内写入**(主写动作与 audit row 同事务,沿 [`CLAUDE.md §12`](../CLAUDE.md))
2. **AuditRecorder 必须 mask 敏感字段**;**禁止**写入 L3 凭据 / L2 手机号身份证号明文(沿 [Phase 0.6 §6.5 / §6.8](data-access-lifecycle-boundary-review.md))
3. **AuditRecorder 接口应统一**,各 service 不自己拼 audit row;Phase 2 / 5 实施时若发现 service 内出现 `prisma.auditLog.create({ ... })` 散写,review 拒绝合并

### 8.5 本期不实施

沿 §6。**不**改 [audit-logs.types.ts](../src/modules/audit-logs/audit-logs.types.ts);**不**新建 `AuditRecorder` class。当前 audit 写入沿现状(各 service 内显式调既有方法)。

---

## 9. Effect / Workflow Boundary

### 9.1 职责范围

通知 / 短信 / 附件删除 / 导出 / 异步任务 / 积分 / 贡献值计算等**副作用**,不得和**主交易**混为一团。

### 9.2 4 类副作用区分

| 类型 | 定义 | 失败处理 |
|---|---|---|
| **main transaction** | 主写动作(`prisma.$transaction` 内)| 失败 → 整体回滚 |
| **post-commit effect** | 主交易 commit **之后** 触发(发短信 / 发通知)| 失败**不**回滚主交易;记 effect-fail audit |
| **retryable effect** | 失败可重试(如发送短信)| 沿 outbox / queue 模式;**当前不引入** |
| **manual recovery** | 高危副作用失败需人工介入(如附件物理删除失败、跨 Provider 迁移)| 失败 → 写 audit + 留运维处理 |

### 9.3 必须覆盖未来场景

| 场景 | 当前实施 | 边界归属 |
|---|---|---|
| 活动取消后通知参与者 | ❌ 未实施 | post-commit effect / 异步 retryable |
| 报名通过后发消息 | ❌ 未实施 | post-commit effect |
| 找回密码短信 | ❌ 未实施 | retryable effect + outbox |
| 节假日祝福短信 | ❌ 未实施 | scheduled workflow(沿 v1 不引入 cron 铁律)|
| 附件物理删除 | ❌ 未实施(沿 [`docs/批次7_attachments_*`](批次7_attachments_API前评审.md))| post-commit effect / manual recovery on fail |
| signed URL 生成 | ✅ 已实施(`getUploadUrl` / `getDownloadUrl`)| main transaction 内现签现给(URL 不入日志,沿 [Phase 0.6 §6.8](data-access-lifecycle-boundary-review.md))|
| 大文件导出 | ❌ 未实施 | retryable / async workflow(超过一定行数走后台任务)|
| 贡献值 / 服务时长重算 | ⚠️ 部分(`contribution-rules` 配置已实装,运算未实装)| post-commit effect + audit |
| 审批后触发后续任务 | ❌ 未实施 | post-commit effect / workflow chain |

### 9.4 铁律

1. **当前不引入 queue / outbox / Redis / cron / job runner**(沿 [`CLAUDE.md §1`](../CLAUDE.md) v1 不做清单)
2. **未来新增副作用时必须先判断是否需要 Effect / Workflow 边界**;若需要,**单独立项 D 档评审**
3. **当前 service 内若直接调外部供应商(短信 / 推送)**,**临时**接受 inline 实现,但**必须**注释标注"TODO: 迁 EffectDispatcher,触发条件:出现重试 / 失败回放需求"
4. **post-commit effect 失败不回滚主交易**;但**必须**写 effect-fail audit

### 9.5 本期不实施

沿 §6。**不**新建 `EffectDispatcher` / `OutboxService` / `WorkflowEngine` 任何代码。

---

## 10. Reporting / Export / Dictionary / Config Boundary

### 10.1 五类边界

| 边界 | 职责 | 当前位置 |
|---|---|---|
| **ExportService** | CSV / Excel / PDF 导出 | 散在 service(如 `activity-registrations.service.ts` 的 `exportCsv`) |
| **ReportService** | 跨模块统计 / 仪表盘 / 月报年报 | 当前无 |
| **DictionaryReader** | 字典读取 + **历史字典值显示策略** | 沿 `dictionaries.service.ts`;字段引用层手写 |
| **ConfigReader** | 系统配置读取 + 历史配置变更后旧数据如何解释 | 沿 `storage-settings` / `attachment-*-configs`;无统一抽象 |
| **OptionResolver** | UI 下拉项构造(基于字典 + 业务规则;如"可选活动类型"过滤已停用的)| 当前无;通过 DictionaryReader + 业务规则手拼 |

### 10.2 必须覆盖

1. **导出权限**:沿 §3 三层授权;**禁止**单独走 `@Roles(...)` 短路
2. **导出字段脱敏**:导出 view ≠ 列表 view;每次导出**必须**显式声明字段集,与 FieldPolicy 协同
3. **导出审计**:沿 §8.3,导出动作必写 audit(导出 view / 字段集 / 行数 / actor)
4. **大数据量异步导出**:沿 §9 retryable effect;超过一定行数走后台任务,**当前不实施**
5. **统计口径**:跨模块统计**必须**集中在 ReportService,**禁止**多模块各自重复查询
6. **历史字典值显示**:字典 item 停用后,历史数据 / 已生成报表显示 label 的策略
7. **停用字典项展示**:DictionaryReader 提供"看见已停用值"开关(`includeInactive`),让管理后台 / 历史详情查得到
8. **配置变更后旧数据**:`contribution-rules` 改了之后,已生成的考勤记录是用旧规则换算还是新规则?ReportService 必须显式回答

### 10.3 铁律

1. **ExportService / ReportService 未来承载导出与报表**;**禁止**在业务 service 内直接拼 CSV 字符串
2. **DictionaryReader / ConfigReader 未来承载配置读取与历史显示策略**;**禁止**在业务 service 内分散 `prisma.dictItem.findFirst({ where: { code } })` 查找
3. **OptionResolver 承载 UI 下拉项构造**;**禁止**前端直接拼字典(因为业务规则过滤需要后端决定)

### 10.4 本期不实施

沿 §6。**不**新建 `ExportService` / `ReportService` / `DictionaryReader` / `ConfigReader` / `OptionResolver` 任何代码。

---

## 11. Refactor Triggers(触发重构条件)

> 以下表格列出"什么样的新需求**必须**立刻走新边界,**不能**继续往大 service 塞"。
> 每个 trigger 是 Phase 2+ 实施 PR review 的**拒绝信号**。

| 触发条件 | 不允许继续做法 | 应考虑的边界 |
|---|---|---|
| 新增 mobile endpoint | 复用 Admin Controller / Admin DTO | **Mobile Controller**(§1)+ **App DTO**(§2)+ **Presenter**(§2) |
| 新增高敏字段(L2 / L3) | 直接加到通用 DTO | **FieldPolicy**(§2)+ **Presenter**(§2);沿 [Phase 0.6 §2](data-access-lifecycle-boundary-review.md) |
| 新增导出 | 在业务 Service 里拼 CSV 字符串 | **ExportService**(§10)+ **AuditRecorder**(§8) |
| 新增审批状态(如 AttendanceSheet 多级审批) | 在 service 里继续 if/else | **StateMachine**(§7)+ 显式 transition table |
| 新增 `department` / `activity` / `managed` scope | service 里手写 where 子句 | **ScopeResolver**(§3)+ **QueryService**(§4) |
| 新增通知 / 短信 | service 内直接调用供应商 | **Effect / Workflow**(§9)+ post-commit 边界 |
| 新增大列表筛选(超 5 个 filter 字段) | 内存过滤分页 | **QueryService**(§4) |
| 新增跨模块统计 | 各模块重复查询 | **ReportService**(§10) |
| 新增附件访问策略 | 直接返回 URL | **AttachmentAccessPolicy**(§6)+ **AuditRecorder**(§8) |
| 新增高危系统配置(SMS / app-config / message-template) | 普通 Admin Controller | **Ops / System Controller**(§1)+ **AuditRecorder**(§8) |

---

## 12. 不立即重构清单

**本 PR 不做**:

- ❌ 不拆 [`attendances.service.ts:1413`](../src/modules/attendances/attendances.service.ts)
- ❌ 不拆 [`attachments.service.ts:885`](../src/modules/attachments/attachments.service.ts)
- ❌ 不拆 [`activity-registrations.service.ts:808`](../src/modules/activity-registrations/activity-registrations.service.ts)
- ❌ 不拆 [`activities.service.ts:656`](../src/modules/activities/activities.service.ts)
- ❌ 不拆 [`certificates.service.ts:556`](../src/modules/certificates/certificates.service.ts)
- ❌ 不拆 [`users.service.ts:544`](../src/modules/users/users.service.ts)
- ❌ 不迁移旧 Controller 物理位置(沿 [Phase 3 方案 C](api-client-boundary-migration-plan.md))
- ❌ 不新增 Presenter 代码
- ❌ 不新增 QueryService 代码
- ❌ 不新增 PolicyService 代码
- ❌ 不新增 StateMachine 代码
- ❌ 不新增 AuditRecorder 代码
- ❌ 不新增 Outbox / Queue / Job
- ❌ 不新增 ExportService / ReportService
- ❌ 不新增 DictionaryReader / ConfigReader / OptionResolver
- ❌ 不新增 EffectDispatcher / WorkflowEngine
- ❌ 不修改任何现有 DTO / Guard / 权限装饰器

**何时启动各 service 拆分**:

| Service | 拆分时机 |
|---|---|
| `attendances.service.ts` | Phase 5 拆 Mixed 时或独立 D 档评审(沿 [`docs/current-state.md §4 P2`](current-state.md))|
| `attachments.service.ts` | Phase 5 拆 Mixed + Phase 4 拆 System(attachment-configs)时一并评审 |
| `activity-registrations.service.ts` | Phase 5 拆 Mixed DTO 时一并评审 |
| `activities.service.ts` | Phase 5(`list` / `findOne` Mixed P0 风险)|
| `users.service.ts` | Phase 5 拆 Mixed(`/me` × 3 + 管理 × 8)|

---

## 13. P0 / P1 架构风险排序

> **判定依据**:对未来 Phase 2 App API 实施的"返工成本 × 安全风险"。

### 13.1 P0(Phase 2 启动前必须接受边界)

1. **DTO / Presenter 边界**(§2)— 沿 [Phase 0.6 §6.1 极高风险](data-access-lifecycle-boundary-review.md);**Phase 2 App API 实施时必须立即生效**
2. **Action + Scope + FieldPolicy 三层授权边界**(§3)— 沿 [Phase 0.6 §3.2](data-access-lifecycle-boundary-review.md);**Phase 2 实施时必须四维 + Role 不短路**
3. **StateMachine 边界**(§7)— 沿 [Phase 0.6 §4](data-access-lifecycle-boundary-review.md);Phase 2 涉及报名取消等 transition 时强制
4. **QueryService 边界**(§4)— Mobile API 默认 `scope = self` 是 Phase 2 强约束;沿 [Phase 0.6 §3.3](data-access-lifecycle-boundary-review.md)
5. **AuditRecorder 边界**(§8)— 沿 P0-D / P0-E / P0-F 已建立的审计范式;**Phase 2 实施 App API 写动作时必须统一审计**

### 13.2 P1(中长期实施,触发时再启动)

1. **Effect / Workflow / Outbox**(§9)— 出现首个"必须可重试 / 必须人工恢复"副作用诉求时启动
2. **Export / ReportService**(§10)— 出现首个"导出 + 跨模块统计"需求时启动
3. **UserMemberLifecycleService / AppIdentityResolver** — 沿 [Phase 0.6 §5.4 + §5.6](data-access-lifecycle-boundary-review.md);本身**生命周期规则是 P0**,但**抽象代码**可以等 Phase 2 实施 `/me/capabilities` 时一并落地
4. **Dictionary / Config Reader**(§10)— 出现"停用字典 / 历史配置如何展示"实际诉求时启动
5. **多端 Swagger / SDK 拆分**(`/api-docs/app` / `/api-docs/admin` / `/api-docs/system`)— 沿 [Phase 1 评审稿 §5.2](api-client-boundary-phase-1-review.md);Phase 4 评估

### 13.3 P0 与 P1 的过渡

- **生命周期规则是 P0**(沿 Phase 0.5 §10.2 D-1 / D-2 / D-4 / Phase 0.6 §5),意味着 Phase 2 实施 `/api/app/v1/me*` 时**必须**在 service 内做 L1-L10 矩阵校验
- **`UserMemberLifecycleService` 代码抽象是 P1**,意味着这套校验**第一次落地**可以在 `users.service.ts` 内一个 method 实现,**第二次复用**(如 `members.service.ts` 也需要时)再抽 service

---

## 14. 与既有铁律的衔接

| 既有铁律 | 与本评审稿关系 |
|---|---|
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) A-2 / A-3 / A-4 | ✅ 本评审稿不动 Role enum / schema / migration |
| [`CLAUDE.md §1`](../CLAUDE.md) v1 不做清单(不引入 Redis / queue / cron / casl)| ✅ §9 Effect / Workflow 明确"当前不引入" |
| [`CLAUDE.md §2-§7`](../CLAUDE.md) 模块结构 / 命名 / 返回格式 / 错误处理 / Swagger / ValidationPipe | ✅ 本评审稿沿用,**不**改这些既有铁律 |
| [`CLAUDE.md §8` Guard / 鉴权](../CLAUDE.md) | ✅ §3 三层授权是对 §8 的补充,**不**替代;`JwtAuthGuard` + `RolesGuard` 全局注册保留 |
| [`CLAUDE.md §9 P0-D / P0-E` 密码 / refresh 铁律](../CLAUDE.md) | ✅ §8 AuditRecorder 沿 P0-D / P0-E 已建立的审计范式 |
| [`CLAUDE.md §10` 软删除](../CLAUDE.md) | ✅ 本评审稿沿用;Presenter / FieldPolicy **不**含 `deletedAt` |
| [`CLAUDE.md §12` 事务](../CLAUDE.md) | ✅ §5 CommandService + §8 AuditRecorder 在 `prisma.$transaction` 内执行 |
| [`CLAUDE.md §19.7 D-1 ~ D-6`](../CLAUDE.md) | ✅ 全部沿用 |
| [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) 13 项 | ✅ 不触发任何基线变更 |
| [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) | ✅ A-2 / A-3 / A-4 / Slow-3 / Slow-4 沿用 |
| Phase 0 / 0.5 / 0.6 评审稿 | ✅ 本评审稿是补充,**不**替代 |

---

## 15. 解除时机与下一步

### 15.1 本评审稿生效顺序

1. **2026-05-19 v0 创建**:本评审稿 v0 创建;**不**改任何代码
2. **用户拍板**:用户接受本评审稿 §1 ~ §13;**无需**新增 D-N 锁定决议,沿 §19.7 D-7 自然继承
3. **Phase 2 App API 实施评审稿启动时**:本评审稿与 [Phase 0.5 §10.2](app-permission-boundary-review.md) + [Phase 0.6](data-access-lifecycle-boundary-review.md) 共同作为 Phase 2 实施硬约束

### 15.2 本评审稿不解决的问题

- 不解决"何时启动 `attendances.service.ts` / `attachments.service.ts` 拆分"具体时机 → 沿 §6 / [`docs/current-state.md §4 P2`](current-state.md);触发条件出现时单独立项
- 不解决"Effect / Workflow 选 outbox 还是 inline retry"具体技术选型 → §9 触发时独立 D 档评审
- 不解决"Multiple Swagger documents 实施细节" → [Phase 1 评审稿 §5.2](api-client-boundary-phase-1-review.md);Phase 4 评估
- 不锁 `ExportService` / `ReportService` 具体接口形态 → §10 触发时独立评审

### 15.3 修订规则

- 本评审稿评审通过后,修订必须**记录修订时间 + 变更摘要**
- 各 §1-§10 的"建议未来命名"在实际落地 service 时**就地**对齐,**不**强制按本评审稿字面值;允许更友好的命名,但**必须**保持本评审稿提出的边界语义

### 15.4 Phase 2 实施引用

**Phase 2 implementation must read** [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md) **before any `/api/app/v1/*` endpoint PR**。本评审稿 §1-§10 边界(尤其 §2 DTO/Presenter / §3 三层授权 / §4 QueryService / §7 StateMachine / §8 AuditRecorder)由该评审稿 §7 锁定为 Phase 2 最小落地范围(新增 Mobile Controller + App DTO + Presenter + AppIdentityResolver + AppCapabilityService;其余分层在触发时单独立项)。

---

> **本评审稿生效时间**:2026-05-19(Phase 0.7 v0)。
> **当前状态**:Phase 2 前置文档之一(与 Phase 0.5 §10.2 + Phase 0.6 共同作用)。
> **过期条件**:所有 P0 边界在 Phase 2 / Phase 5 落地后,本评审稿进入"长期参考"性质;P1 边界触发时按节单独修订。
