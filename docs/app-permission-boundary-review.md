# SRVF App Permission & Identity Boundary Review

> **状态**:**Phase 0.5 专项评审 v0**(2026-05-19)
> **定位**:[Phase 0 客户端边界设计](api-client-boundary.md) 与 [Phase 1A / 1B 实施评审稿](api-client-boundary-phase-1-review.md) 之间的**前置专项**,
> **专门**评估移动端 / 小程序 / 队员端的**身份模型、权限边界、数据可见性**,避免后续 Phase 2 落地 App API 时返工。
> **配套文档**:
>   - [`docs/api-client-boundary.md`](api-client-boundary.md)(顶层规范)
>   - [`docs/api-client-boundary-inventory.md`](api-client-boundary-inventory.md)(现状盘点)
>   - [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md)(分阶段路线)
>   - [`docs/api-client-boundary-phase-1-review.md`](api-client-boundary-phase-1-review.md)(Phase 1 执行评审稿)
> **冲突优先级**:本评审稿优先级**最低**;冲突时让步给 [`ARCHITECTURE.md`](../ARCHITECTURE.md) / [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) / [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) / [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) / 既有批次评审稿。
> **生效条件**:本评审稿经用户拍板后,Phase 2 立项必须**先**对齐本评审稿;**不**作为开发授权。

---

## 0. TL;DR(给两分钟时间的读者)

1. **App API ≠ USER API**:`/api/app/v1/*` 表示"当前登录人视角",**不**等于"只有 `Role.USER` 能调";`SUPER_ADMIN` / `ADMIN` 也是登录人,他们登录后看 App 也走同一组接口
2. **当前 schema 不足以表达完整业务身份**:`MemberStatus` 仅 `ACTIVE` / `INACTIVE`,**没有**"候选 / 临时 / 正式"区分;"中队负责人 / 部门负责人 / 活动负责人 / 考勤负责人"**完全未建模**
3. **Phase 2 App API 设计前**必须先回答 3 个业务问题:**身份语义如何映射现有 schema** / **App 移动端要不要承载管理能力** / **数据脱敏边界谁来执行**
4. **路径建议**:`me`(身份)+ `my`(业务记录)+ `tasks`(待办)+ `managed`(移动端管理范围)四段分层
5. **DTO 命名规则**:`AppSelf*Dto` / `AppPeer*Dto` / `AppManaged*Dto` / `AdminXxxDto` / `SystemXxxDto` 五段强制隔离
6. **Phase 2 影响**:11 个 P0 接口里**至少 3 个**需要在 Phase 2 启动前澄清,**不**到 P0 立项就照搬清单

**本评审稿不实现任何东西**:不改 schema、不改 Role enum、不动 Permission seed、不动 Prisma、不动 controller、不动 DTO、不动测试。

---

## 1. App API 不等于 USER API

### 1.1 错误的心智模型

```txt
错误:/api/app/v1/* ≡ @Roles(USER)
错误:/api/admin/v1/* ≡ @Roles(SUPER_ADMIN, ADMIN)
错误:/api/system/v1/* ≡ @Roles(SUPER_ADMIN)
```

> 这种映射把"客户端边界"等同于"角色边界",会导致:
> - `ADMIN` 用户登录 App 看自己的 `/me` 会被 403
> - `SUPER_ADMIN` 用 App 看自己的活动报名会被拒
> - 不得不在每个 App 接口同时挂 `@Roles(USER, ADMIN, SUPER_ADMIN)`,逐渐退化成"任意登录用户"

### 1.2 正确的心智模型

```txt
正确:/api/app/v1/* ≡ "当前登录人视角的接口集合"(任意登录用户身份均可调)
正确:/api/admin/v1/* ≡ "资源管理视角的接口集合"(需特定权限点)
正确:/api/system/v1/* ≡ "系统治理视角的接口集合"(需高危权限点)
```

**关键**:**客户端边界**(`/app` / `/admin` / `/system`)与**权限点**(`@Roles(...)` / `rbac.can(...)`)是**两个正交维度**,**不**互相绑定。

App API 内部的权限收紧靠**业务 capability** 判定(如 `CanRegisterActivity`),**不**靠"路径段属于哪个客户端"。

### 1.3 11 类业务身份现状盘点

> 用户列出的 11 类身份,与当前 schema / RBAC 的映射关系。
> ⚠️ **表中标 [未建模] 的身份是 Phase 2 启动前必须先决议如何映射的问题**。

| # | 业务身份 | 当前是否有 schema 表达 | 当前对应字段 | 缺口 |
|---|---|---|---|---|
| 1 | **未登录游客** | ✅ | 无 token | 沿 `@Public()` 装饰器;App 端是否有游客可见页待定(沿 [`docs/api-client-boundary.md §2.2 Public API`](api-client-boundary.md))|
| 2 | **候选志愿者** | ❌ [未建模] | 无字段 | 不在 `MemberStatus` / `Role` 范围内;**可能**对应"已提交报名表但未审核"状态;Phase 2 前需澄清 |
| 3 | **临时编号志愿者** | ❌ [未建模] | 无字段(`MemberProfile.volunteerNo` 是义工号,非临时编号) | `volunteerNo` 注释明确"不参与登录/权限/身份识别";Phase 2 前需澄清"临时编号"语义 |
| 4 | **正式队员** | ✅ 部分 | `Member.memberNo`(全局不复用)+ `Member.status = ACTIVE` + `User.memberId` 关联 | 可识别;App 看自己等同"有 `User.memberId` 关联且 `Member.status=ACTIVE`" |
| 5 | **普通队员** | ⚠️ 隐含 | 同 4,无 `rbac.user-role.*` 加权 | "普通"是负向定义("不是负责人");需要靠"未持任何业务级 RBAC 角色"识别 |
| 6 | **中队负责人** | ❌ [未建模] | 无 schema 字段 / 无既有 RBAC 角色 | 沿 [批次 8 RBAC 业务确认稿 Q8 决议 A](批次8_RBAC_业务确认稿.md):**当前不切片**;部门级权限不通过 RBAC 引擎实现 |
| 7 | **部门负责人** | ❌ [未建模] | 同 6 | 同 6;沿 [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) "部门级数据范围权限显式在 Service 内 `assertCanXxx` 实现" |
| 8 | **活动负责人** | ❌ [未建模] | 无字段 | `Activity` 表无 `leaderId` / `responsibleMemberId` 等字段;Phase 2 前需澄清"活动负责人"如何识别(创建者?指派?) |
| 9 | **考勤负责人** | ❌ [未建模] | 无字段 | 同 8;`AttendanceSheet` 有 `creator` / `reviewer` 字段但未必等于"考勤负责人"业务概念 |
| 10 | **Admin 兼队员** | ✅ | `User.role = ADMIN` + `User.memberId != null` | 已可识别;**最重要的边界陷阱**(见 §1.4)|
| 11 | **离队 / 退队 / 停用** | ✅ 部分 | `Member.status = INACTIVE`(离队/退队)/ `User.status = DISABLED`(账号停用)/ `User.deletedAt != null`(账号软删) | 可识别;**有 3 个相互独立的"失效"状态**,需明确哪些组合允许 App 登录(见 §2)|

### 1.4 "Admin 兼队员" 是最关键的边界陷阱

**场景**:某 `User` 同时是 `ADMIN`(`role=ADMIN`)且关联了 `Member`(`memberId != null`)。

**问题**:此人登录 App 看 `/api/app/v1/me/registrations`:
- 看自己的报名 ✓(应当返回)
- 看所有队员的报名 ✗(那是 `/api/admin/v1/registrations`,不是 `/me`)

**铁律**:**App API 内部的"我"永远靠 `currentUser.id` + `currentUser.memberId` 锁定本人范围**,**不**看 `role`。
即使是 `SUPER_ADMIN` 调 `/api/app/v1/me/registrations`,也**只**返回 super-admin 自己作为 member 的报名。

如果 super-admin 没有关联 member(`User.memberId === null`),`/me/registrations` 应返回**空列表**或 `MEMBER_NOT_LINKED` 业务码 — **不是** "拒绝访问"。

---

## 2. 登录权限与业务权限分离

### 2.1 概念区分

| 概念 | 现有支撑 | 语义 |
|---|---|---|
| **CanLogin**(能登录) | `User.deletedAt === null && User.status === ACTIVE` | 沿 [`CLAUDE.md §8`](../CLAUDE.md) 现状 |
| **CanUseApp**(能用 App) | ⚠️ **当前无独立判定**,等同 `CanLogin` | Phase 2 评审稿需决议:是否所有 `CanLogin` 用户都能用 App?管理员账号是否需"App 入口"开关? |
| **CanViewSelf**(看自己) | 等同 `CanLogin` + `currentUser.memberId != null`(若需要 member 数据) | App 默认能力 |
| **CanEditSelf**(改自己资料) | 等同 `CanViewSelf` + `MemberStatus.ACTIVE` ? | 离队人员是否可改资料?Phase 2 前需澄清 |
| **CanRegisterActivity**(报名活动) | 等同 `CanViewSelf` + `MemberStatus.ACTIVE` + 活动状态 `published` + 报名期内 | 沿现状 `activity-registrations.controller.ts` registerMe |
| **CanCancelRegistration**(取消自己报名) | 等同已经报名 + 报名状态 cancellable + 取消窗口期内 | 沿现状 cancelMyRegistration |
| **CanViewOwnAttendance**(看自己考勤) | 等同 `CanViewSelf` | 离队人员是否可查历史考勤?Phase 2 前需澄清 |
| **CanViewOwnCertificates**(看自己证书) | 等同 `CanViewSelf` | 沿现状未实现 |
| **CanManageMobileTasks**(在移动端处理任务) | ❌ **当前无判定**;沿 [§4](#4-移动端管理能力是否需要预留) 决议 | 视 §4 结论 |

### 2.2 11 身份 × 9 能力矩阵

> ⚠️ 表中 **?** 表示当前 schema 不足以判定,需 Phase 2 前业务方拍板;**N/A** 表示场景不存在。
> ✅ = 当前必须支持;❌ = 当前明确拒绝;? = 待业务方决议。

| 身份 \ 能力 | CanLogin | CanUseApp | CanViewSelf | CanEditSelf | CanRegisterActivity | CanCancelRegistration | CanViewOwnAttendance | CanViewOwnCertificates | CanManageMobileTasks |
|---|---|---|---|---|---|---|---|---|---|
| 未登录游客 | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 候选志愿者(未建模) | ? | ? | ?(沿 §1.3 缺口)| ? | ?(可能允许) | N/A | N/A | N/A | ❌ |
| 临时编号志愿者(未建模) | ? | ? | ? | ? | ? | ? | ? | ? | ❌ |
| 正式队员(普通)| ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| 中队负责人(未建模) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ?(沿 §4) |
| 部门负责人(未建模) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ?(沿 §4) |
| 活动负责人(未建模) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ?(沿 §4) |
| 考勤负责人(未建模) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ?(沿 §4) |
| Admin 兼队员 | ✅ | ✅(沿 §1.4) | ✅(本人 member 范围) | ✅(本人 member 字段) | ✅ | ✅ | ✅ | ✅ | ?(沿 §4) |
| 离队 / 退队(`MemberStatus=INACTIVE`) | ✅ | ?(管理后台可见,App 是否拒登?) | ?(可看历史档案) | ❌(不允许改) | ❌(不允许报名)| ❌(可能允许取消历史) | ?(查历史) | ?(查历史)| ❌ |
| 账号停用(`UserStatus=DISABLED` / `deletedAt != null`) | ❌(沿 [`CLAUDE.md §8` 现状](../CLAUDE.md)) | ❌ | N/A | N/A | N/A | N/A | N/A | N/A | N/A |

**矩阵结论**:
- "正式队员(普通)" 与 "中队/部门/活动/考勤负责人" 的能力差异**仅在** `CanManageMobileTasks` 一列;其它 8 列完全一致 — 说明"业务负责人身份"的 App 端价值集中在 §4 决策上
- "候选 / 临时编号" 2 列大量 **?** — 说明这两个身份**在 Phase 2 前必须先决议是否允许登录 App**;若不允许,Phase 2 不需为他们设计任何 App API
- "Admin 兼队员" 与"正式队员" 完全一致 — 验证 §1.4 铁律:**`Role` 不应进入 App API 的 capability 判定**

---

## 3. App API 路径语义分层

### 3.1 四段分层提案

```txt
/api/app/v1/me/*           # "我是谁" — 身份资料、账号、设置
/api/app/v1/my/*           # "我的什么" — 我的业务记录(报名 / 考勤 / 证书)
/api/app/v1/tasks/*        # "我要做什么" — 待办、待审、消息提醒
/api/app/v1/managed/*      # "我管什么" — 移动端被授权管理的局部范围(沿 §4 决议)
```

### 3.2 各段语义

#### `me/*`(身份资料)

**语义**:**当前登录人是谁**。
**典型接口**:

```txt
GET   /api/app/v1/me               # 本人 user + member 摘要
GET   /api/app/v1/me/account       # 账号信息(username / lastLoginAt / 是否绑定 member)
GET   /api/app/v1/me/profile       # member 详情(本人视角字段;不含 Admin 内部字段)
PATCH /api/app/v1/me/profile       # 改 nickname / avatarKey 等
PUT   /api/app/v1/me/password      # 改密(沿 P0-D)
GET   /api/app/v1/me/department    # 本人当前部门
GET   /api/app/v1/me/permissions   # 本人 App capabilities(不直接暴露 RBAC permission code;见 §8)
GET   /api/app/v1/me/emergency-contacts  # 本人紧急联系人(App 视角)
PATCH /api/app/v1/me/emergency-contacts/:id  # 改本人紧急联系人
```

**铁律**:`me/*` **只返回本人字段**;**禁止**有任何"按 id 查别人"的子路径(那是 Admin 范围)。

#### `my/*`(业务记录)

**语义**:**当前登录人持有的业务对象**(报名 / 考勤记录 / 证书)。
**典型接口**:

```txt
GET   /api/app/v1/my/registrations             # 我的报名记录
GET   /api/app/v1/my/registrations/:id         # 我的某条报名详情
PATCH /api/app/v1/my/registrations/:id/cancel  # 取消我的报名
GET   /api/app/v1/my/attendance-records        # 我的考勤记录
GET   /api/app/v1/my/certificates              # 我的证书
GET   /api/app/v1/my/contribution-points       # 我的贡献值汇总
GET   /api/app/v1/my/attachments               # 我上传的附件
```

**铁律**:`my/*` 的入参**不**接受任何 `memberId` / `userId` 字段;查询 where 永远是 `currentUser.memberId`。

#### `tasks/*`(待办)

**语义**:**需要当前登录人处理的事项**。
**典型接口**(未实现,Phase 2/3 评估):

```txt
GET   /api/app/v1/tasks                    # 我的待办合集
GET   /api/app/v1/tasks/registration-approvals  # 待我审的报名(若我是活动负责人)
GET   /api/app/v1/tasks/attendance-checks  # 待我审的考勤(若我是考勤负责人)
GET   /api/app/v1/tasks/notifications      # 系统通知
POST  /api/app/v1/tasks/:id/ack            # 已读
```

**铁律**:`tasks/*` 的具体内容随 §4 决议而定;**Phase 2 是否实现待业务方拍板**。
即使本期不实现,**路径名空间应当预留**(避免将来与其它子路径冲突)。

#### `managed/*`(移动端管理范围)

**语义**:**当前登录人在移动端被授权管理的局部资源**(典型如活动负责人在 App 上看本活动报名)。
**典型接口**(未实现,Phase 2/3 评估):

```txt
GET   /api/app/v1/managed/activities             # 我作为负责人的活动列表
GET   /api/app/v1/managed/activities/:id/registrations  # 该活动的报名(我作为活动负责人)
PATCH /api/app/v1/managed/activities/:id/registrations/:rid/approve  # 移动端审批
GET   /api/app/v1/managed/attendance-sheets      # 我作为考勤负责人的考勤表
```

**铁律**:`managed/*` 必须经过**业务级权限校验**(`activity.leaderId == currentUser.memberId` 等);**禁止**简单按角色短路放过。

### 3.3 与 `/api/admin/v1/*` 的区别

| 维度 | `/api/app/v1/managed/*` | `/api/admin/v1/*` |
|---|---|---|
| 视角 | 移动端当前登录人**被授权管理的局部范围** | PC 管理后台**资源管理全量视图** |
| 入参 | **不**接受 `memberId` / `userId` 等他人 ID;**只**接受"自己有权管的"资源 ID | 接受任意资源 ID 配合权限点判定 |
| 输出 | App 视角 DTO(脱敏 / 简化) | Admin 详情 DTO(完整字段) |
| 客户端 | App / 小程序 | PC Web |
| 权限校验 | **必须**双重校验:既登录 + 又持业务负责人身份 | 沿 `rbac.can(...)` 或 `@Roles(...)` |

### 3.4 与现状的兼容

> 现有 `/api/v2/users/me/*` 与 `/api/users/me*` 散落在 Admin Legacy 前缀下,**不**冲突本提案。
> Phase 2 新增 `/api/app/v1/me/*` / `/api/app/v1/my/*`,**不**删旧 path(沿 Phase 3 方案 C);未来若个别 me 接口想下线旧 path,单独立项。

---

## 4. 移动端管理能力是否需要预留

### 4.1 5 类问题逐项评估

| # | 业务诉求 | Phase 2 是否实现 | 是否预留 path / DTO 命名空间 | 备注 |
|---|---|---|---|---|
| 4.1 | 活动负责人在 App 看本活动报名名单 | ❌ **不实现** | ✅ **预留** `/api/app/v1/managed/activities/:id/registrations` | 业务方需先决议"活动负责人"如何在 schema 识别(创建者 / 指派字段?) |
| 4.2 | 活动负责人在 App 审核报名 | ❌ **不实现** | ✅ **预留** `/api/app/v1/managed/activities/:id/registrations/:rid/approve` | 同上 |
| 4.3 | 考勤负责人在 App 补录 / 确认考勤 | ❌ **不实现** | ✅ **预留** `/api/app/v1/managed/attendance-sheets/*` | 业务方需先决议"考勤负责人"如何识别 |
| 4.4 | 中队负责人在 App 看本中队成员 / 活动 / 报名 | ❌ **不实现** | ✅ **预留** `/api/app/v1/managed/squad/*` 命名空间 | 沿 [批次 8 RBAC Q8=A](批次8_RBAC_业务确认稿.md):**当前不切片**;移动端实现前必须先建模部门级数据范围权限 |
| 4.5 | 部门负责人在 App 处理审批任务 | ❌ **不实现** | ⚠️ **同 4.4** | 同 4.4 |

### 4.2 预留策略

- **预留**:`/api/app/v1/managed/*` 与 `/api/app/v1/tasks/*` **命名空间**保留;后续添加子路径时**不**与 `me/*` / `my/*` 冲突
- **不实现**:本评审稿**不**催促 Phase 2 实现任何 `managed/*` / `tasks/*` 接口
- **不预设业务身份字段**:`Activity` / `AttendanceSheet` 等 schema **不**因本评审稿新增 `leaderId` / `responsibleMemberId` 字段;那是独立 D 档评审任务(沿 V2 红线 A-3 / A-4)

### 4.3 何时启动管理能力评审

满足以下**任一**条件时,**单独立项**评审"App 端管理能力"专项:

- 业务方明确提出"队员希望在 App 上审报名 / 录考勤"(频次描述清晰)
- 队组织扩张到 ≥ 2 个独立运作的部门(部门级数据范围权限自然成为刚需)
- 移动端联调反馈 PC 后台审批响应不及时

**当前阶段**(单组织、运营手工操作):**不**启动。

---

## 5. 数据可见性矩阵

### 5.1 字段 × 视角矩阵

> **视角定义**:
> - **AppSelf**:App 看本人(`memberId == currentUser.memberId`)
> - **AppPeer**:App 看其他队员(脱敏摘要;**当前未实现**,沿 [`docs/api-client-boundary.md §3 铁律 3`](api-client-boundary.md))
> - **AppManaged**:App 看自己负责管理范围内的他人(`§4` 预留)
> - **Admin**:PC 后台看任意队员(`rbac.can(...)` 或 `@Roles(SUPER_ADMIN, ADMIN)`)
> - **System**:系统治理视角(`SUPER_ADMIN` 或 `ops-admin`)
>
> 标记:✅ = 可见;⚠️ = 需脱敏(掩码 / 部分);❌ = 不可见;**?** = Phase 2 评审稿决议;N/A = 字段在该视角无语义

| # | 字段 | AppSelf | AppPeer | AppManaged | Admin | System |
|---|---|---|---|---|---|---|
| 5.1 | 姓名(`MemberProfile.realName`) | ✅ | ⚠️ 显示名 / 队员等级 | ✅(完整) | ✅ | ✅ |
| 5.2 | 手机号(`MemberProfile.mobile`) | ✅(本人) | ❌ | ⚠️ 需求待定 | ✅ | ✅ |
| 5.3 | 身份证号(`MemberProfile.documentNumber`) | ⚠️ 显示后 4 位 | ❌ | ❌ | ⚠️ 默认掩码 | ✅(必要时) |
| 5.4 | 志愿者编号(`MemberProfile.volunteerNo`) | ✅(本人) | ⚠️ 可视为公开编号(待业务确认)| ✅ | ✅ | ✅ |
| 5.5 | 临时编号(未建模) | **?** | **?** | **?** | **?** | **?** |
| 5.6 | 组织 / 中队(`MemberDepartment.organizationId`) | ✅ | ⚠️ 仅本队员所在中队名 | ✅ | ✅ | ✅ |
| 5.7 | 职务 / 岗位(未建模) | **?** | **?** | **?** | **?** | **?** |
| 5.8 | 紧急联系人(`EmergencyContact.*`) | ✅(本人) | ❌ | ⚠️ 仅"已签授权"字段 | ✅ | ✅ |
| 5.9 | 血型(`MemberProfile.bloodTypeCode`) | ✅ | ❌ | ⚠️(救援现场可能需要;待业务确认)| ✅ | ✅ |
| 5.10 | 健康信息(`MemberProfile.medicalNotes`) | ✅ | ❌ | ❌(默认)| ✅ | ✅ |
| 5.11 | 证书(`Certificate.*`) | ✅(本人;含未通过) | ⚠️ 仅"已通过 + 公示" | ✅(完整) | ✅ | ✅ |
| 5.12 | 证书附件(沿 `attachments` 模型) | ✅(本人) | ❌ | ⚠️ 仅"已公示" | ✅ | ✅ |
| 5.13 | 活动报名状态(`ActivityRegistration.status`) | ✅(本人) | ⚠️ 仅"已确认"参与者 | ✅(完整) | ✅ | ✅ |
| 5.14 | 考勤记录(`AttendanceRecord.*`) | ✅(本人) | ❌ | ✅(同队/同活动)| ✅ | ✅ |
| 5.15 | 贡献值(未实装聚合查询) | ✅(本人) | ⚠️ 仅排行榜公开维度(待业务确认)| ✅(完整) | ✅ | ✅ |
| 5.16 | 审核备注(`Certificate.reviewerNote` / `Registration.rejectReason`) | ⚠️ 看自己的 reject 原因 | ❌ | ⚠️(待业务确认)| ✅ | ✅ |
| 5.17 | 内部备注(若 Admin 在 schema 加私有字段) | ❌ | ❌ | ❌ | ✅(根据 RBAC) | ✅ |
| 5.18 | 系统角色(`User.role`) | ⚠️ 仅本人 role 名称(用于 UI 展示) | ❌ | ❌ | ✅ | ✅ |
| 5.19 | RBAC 权限(`UserRole[]` + `Permission[]`) | ⚠️ App capability 抽象后展示(不直接暴露 permission code;见 §8) | ❌ | ❌ | ✅ | ✅ |
| 5.20 | 离队 / 退队原因(未建模独立字段)| ⚠️(本人;通常历史记录归档不让自己改) | ❌ | ❌ | ✅ | ✅ |

### 5.2 数据可见性铁律

1. **AppSelf 与 Admin 永远 DTO 不同**:即使字段集相似,也必须 DTO 类型隔离(沿 [`docs/api-client-boundary.md §3 铁律 3`](api-client-boundary.md))
2. **AppPeer 必须脱敏**:**禁止**直接返回 Admin DTO 给 App 的"看别人"场景;**所有** PII 字段(手机 / 身份证 / 紧急联系人 / 医疗 / 内部备注)**默认不可见**
3. **AppManaged 不是 Admin**:即使活动负责人在移动端看报名,**也不应**看到非本活动 / 非本队员的全量数据;DTO 只暴露**完成任务所需**字段
4. **System DTO 可暴露平台级配置字段**(如 `ContributionRule.*` / `StorageSettings.*`),但**禁止**返回明文凭据(沿 [`docs/api-client-boundary.md §2.2 System API 铁律`](api-client-boundary.md))
5. **身份证号等高敏感字段**:即使是 AppSelf,**默认**也只返回后 4 位掩码;前端如需要完整号(如打印报名表)走独立"完整资料导出"接口,**审计写入**

### 5.3 当前 schema 字段对照

> 5.1 表中标 **?** 或"未建模"的字段(临时编号 / 职务 / 离队原因),Phase 2 启动前必须决议**字段去向**:
> - 加进 `MemberProfile` 还是新表
> - 是字典还是自由字段
> - 谁能改

**本评审稿不替业务方决议**,仅记录缺口。

---

## 6. App DTO 命名规范

### 6.1 命名规则

| DTO 类型 | 前缀 | 视角 | 举例 |
|---|---|---|---|
| 本人详情 | `AppSelf*Dto` | 当前登录人看自己 | `AppSelfProfileDto` / `AppSelfMemberDto` / `AppSelfCertificateDto` |
| 我的业务对象 | `AppMy*Dto` | 当前登录人持有的业务记录 | `AppMyRegistrationDto` / `AppMyAttendanceRecordDto` / `AppMyCertificateDto` |
| 看别人(App 视角脱敏) | `AppPeer*Dto` | App 看其他队员的脱敏摘要 | `AppPeerMemberSummaryDto` / `AppPeerActivityParticipantDto` |
| 我管的(App 视角负责人范围) | `AppManaged*Dto` | App 看自己负责管理范围 | `AppManagedActivityRegistrationDto` / `AppManagedAttendanceSheetDto` |
| Admin 详情 | `Admin*Dto` | PC 后台资源管理视角 | `AdminMemberDetailDto` / `AdminRegistrationDto` |
| System 配置 | `System*Dto` | 系统治理 | `SystemContributionRuleDto` / `SystemStorageSettingsDto` |
| 内部 service shape | `*Internal*` / `*Entity*` | service 内部用,不出 controller | `MemberInternalShape` |

### 6.2 命名铁律

- **AppSelf*Dto ≠ Admin*Dto**:**禁止** `extends` / `Pick` / `Omit` 一个 Admin DTO 来构造 AppSelf DTO;两者字段集必须独立维护
- **AppPeer*Dto 必须脱敏**:类定义阶段就**不包含**敏感字段(手机 / 身份证 / 医疗 / 紧急联系人);**禁止**靠"运行期裁字段"防泄漏
- **AppManaged*Dto 只暴露任务所需**:活动负责人审报名场景的 `AppManagedActivityRegistrationDto` **不**含"报名人健康信息";考勤负责人录考勤场景的 `AppManagedAttendanceRecordDto` **不**含"考勤人身份证号"
- **System*Dto 字段开放但受权限控制**:`SystemContributionRuleDto` 可含完整规则字段,但接口入口必须 `rbac.can('contribution-rule.*')` 短路
- **DTO 内部不存路径段**:DTO 类名不暴露客户端边界(如**不**叫 `AppV1MyRegistrationDto`);客户端版本号由 controller 路径承载

### 6.3 DTO 文件组织

```txt
src/modules/activity-registrations/dto/
├── app/
│   ├── app-my-registration.dto.ts             # AppMyRegistrationDto(本人持有)
│   ├── app-peer-activity-participant.dto.ts   # AppPeerActivityParticipantDto(看别人,脱敏)
│   └── app-managed-registration.dto.ts        # AppManagedRegistrationDto(我管的)
├── admin/
│   ├── admin-registration.dto.ts              # AdminRegistrationDto
│   └── admin-list-registrations.query.dto.ts
└── internal/
    └── registration.shape.ts                  # internal types
```

**当前现状**:仓库中**没有** `dto/app/` / `dto/admin/` 目录(沿 [`docs/api-client-boundary-inventory.md`](api-client-boundary-inventory.md));Phase 5 拆分 DTO 时落地这套结构。**Phase 0.5 不**强制马上落地。

---

## 7. App Guard / 权限模型建议(只设计不实现)

### 7.1 4 类 Guard 提案

> **设计期**:仅提案,**不**实现。
> **实施时机**:Phase 2 实施 App API 时,根据实际需求逐个落地;**不**为了"完整性"一次性建 4 个 Guard。

| Guard | 职责 | 当前等价物 | 何时实施 |
|---|---|---|---|
| **AppAccessGuard** | 判断当前账号是否允许使用 App | 现 `JwtAuthGuard` + `User.status === ACTIVE && deletedAt === null` 已足够 | 出现"管理员账号禁用 App 入口"等额外限制时 |
| **MemberStatusGuard** | 判断是否具备正式队员 / 候选 / 临时编号等状态 | ❌ 当前 schema 不足以判定 | 候选 / 临时编号入 schema 后 |
| **ActivityEligibilityGuard** | 判断当前人是否能报名某活动 | 散落在 `activity-registrations.service.ts` 内 `assertCanXxx` | Phase 2 实施 `POST /api/app/v1/me/activities/:id/registrations` 时评估是否抽取 Guard |
| **MobileTaskPermissionGuard** | 判断当前人是否能在移动端处理某个任务 | ❌ 当前不存在 | §4 决议启动管理能力时 |

### 7.2 Guard vs Service 内 assertCanXxx 的选择

> 沿 [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) "部门级数据范围权限显式在 Service 内 `assertCanXxx` 实现,**不**通过 Guard 层"

**Guard 适用**:
- 入口级"是否能进这个端点"判定(沿 `JwtAuthGuard` / `RolesGuard` 范式)
- 静态可判定(看 user / role / status,不读业务数据)

**Service 适用**:
- 业务级"对这个具体资源能不能做这个操作"判定(沿 `assertCanManageUser` 范式)
- 动态需读业务数据(读 `Activity.status` / `Activity.startTime` 等)

**铁律**:Phase 2 实施 App API 时**优先**用 Service 内 assertCanXxx,**不**为每个业务规则新建 Guard。

### 7.3 不实现清单

- ❌ 不实现 `AppAccessGuard`(沿 7.1)
- ❌ 不实现 `MemberStatusGuard`(schema 缺口)
- ❌ 不实现 `ActivityEligibilityGuard`(Phase 2 决议)
- ❌ 不实现 `MobileTaskPermissionGuard`(§4 决议)
- ❌ 不引入 `casl` / 通用 ABAC 引擎(沿 [`CLAUDE.md §1` v1 不做清单](../CLAUDE.md))

---

## 8. Phase 2 影响

> 重新审视 [`docs/api-client-boundary-migration-plan.md §4.1`](api-client-boundary-migration-plan.md) 的 11 个 P0 App 接口。

### 8.1 接口逐项再评估

#### `GET /api/app/v1/me` — **建议拆分**

**问题**:`me` 一个端点是否打包返回 user + member?

**Phase 2 选择**:
- **方案 A**(推荐):`GET /api/app/v1/me` 返回 user + member 摘要 + 是否绑定 member 的标志;**额外**提供:
   - `GET /api/app/v1/me/profile` — 完整 member 资料(本人视角)
   - `GET /api/app/v1/me/account` — 仅账号信息(username / lastLoginAt / role 等)
- **方案 B**:`GET /api/app/v1/me` 仅返回 user(不含 member);`GET /api/app/v1/me/member` 单独返 member
- **本评审稿倾向**:方案 A;但**Phase 2 评审稿决议**

#### `GET /api/app/v1/activities` — **建议区分**

**问题**:列表语义是"我能参加的" / "我已报名的" / "我负责的"?

**Phase 2 选择**:
- `GET /api/app/v1/activities/available` — 我能报名的(过滤 published + 报名期内)
- `GET /api/app/v1/my/activities` — 我已报名 / 已参与的(沿 `my/*` 命名空间)
- `GET /api/app/v1/managed/activities` — 我作为负责人的(§4 预留,不实现)
- **本评审稿倾向**:Phase 2 至少实现前两项;`managed` 留预留

#### `GET /api/app/v1/me/permissions` — **建议改语义**

**问题**:暴露 RBAC `permission code` 还是 App capability?

**Phase 2 选择**:
- **方案 A**(推荐):返回 **App capability** 抽象后的字符串集(如 `["can-register-activity", "can-view-own-attendance", "can-manage-activity-as-leader"]`);前端按 capability 控制 UI
- **方案 B**:返回完整 RBAC `permission code[]`(如 `["activity.read", "activity-registration.cancel"]`);前端自己映射 UI
- **本评审稿倾向**:方案 A — 前端不应直接耦合后端 permission code 命名;capability 抽象让 RBAC 演进不破坏 App
- **风险**:capability 列表是新约定,**需要** Phase 2 评审稿前与前端对齐字段名

#### 新增建议:`/api/app/v1/tasks` 命名空间

**问题**:Phase 2 是否实现 `tasks/*`?

**Phase 2 选择**:
- **方案 A**(本评审稿倾向):**Phase 2 不实现** `tasks/*` 业务接口;**仅在命名空间层面预留**,Phase 3+ 再决议
- **方案 B**:Phase 2 实现 `GET /api/app/v1/tasks/notifications`(本人通知)— 若业务方刚需消息中心
- **风险**:不预留 → 将来 App 加消息中心时**需要**改架构图

#### 新增建议:`/api/app/v1/managed/*` 命名空间

**问题**:Phase 2 是否预留 `managed/*`?

**Phase 2 选择**:
- **方案 A**(本评审稿倾向):**预留命名空间但不实现任何 endpoint**;沿 §4 决议
- **方案 B**:Phase 2 实现 `GET /api/app/v1/managed/activities`(我负责的活动列表)— 若业务方刚需
- **风险**:不预留 → 后续被业务诉求触发时无法快速响应

### 8.2 Phase 2 P0 接口建议变更

| 原 P0 接口 | 建议 | 来源 |
|---|---|---|
| `GET /api/app/v1/me` | 拆为 `me` + `me/account` + `me/profile`(沿 §8.1)| §8.1 #1 |
| `PATCH /api/app/v1/me/profile` | 沿现状(P0 保留) | — |
| `PUT /api/app/v1/me/password` | 沿现状(P0 保留) | — |
| `GET /api/app/v1/me/permissions` | **改语义**返 App capability,不直接暴露 permission code | §8.1 #3 |
| `GET /api/app/v1/activities` | **拆为** `available` + `my/activities` 两个端点 | §8.1 #2 |
| `GET /api/app/v1/activities/:id` | 沿现状,Resp DTO 用 `AppActivityDetailDto`(脱敏) | — |
| `POST /api/app/v1/me/activities/:id/registrations` | **改路径**到 `POST /api/app/v1/my/registrations`(入参带 `activityId`),符合 `my/*` 语义 | §3 |
| `GET /api/app/v1/me/registrations` | **改路径**到 `GET /api/app/v1/my/registrations` | §3 |
| `GET /api/app/v1/me/registrations/:id` | **改路径**到 `GET /api/app/v1/my/registrations/:id` | §3 |
| `PATCH /api/app/v1/me/registrations/:id/cancel` | **改路径**到 `PATCH /api/app/v1/my/registrations/:id/cancel` | §3 |
| `GET /api/app/v1/me/attendance-records` | **改路径**到 `GET /api/app/v1/my/attendance-records` | §3 |

> 路径变更建议是**评审建议**,Phase 2 立项评审稿可以**决议保留 `me/*` 不拆 `my/*`**,但**必须明确给出理由**。

---

## 9. 不做清单

本专项评审**绝对不**实现以下任何一项:

- ❌ 不改现有 `Role` enum(SUPER_ADMIN / ADMIN / USER 三层稳定;沿 [`ARCHITECTURE.md`](../ARCHITECTURE.md) A-2 红线)
- ❌ 不新增 `MemberStatus` enum 值(候选 / 临时编号 / 正式 / 离队 等业务身份分类**留给独立 D 档评审**)
- ❌ 不在 `Member` / `Activity` / `AttendanceSheet` 上新增 `leaderId` / `responsibleMemberId` 等字段
- ❌ 不新增 Permission seed(沿 [`docs/批次8_RBAC_业务确认稿.md`](批次8_RBAC_业务确认稿.md) Q8=A 不切片)
- ❌ 不新增 `RbacRole` 内置角色(`ops-admin` 之外)
- ❌ 不改 Prisma schema
- ❌ 不生成 migration
- ❌ 不新增任何 App / Admin / System endpoint
- ❌ 不改现有 Controller / DTO / Guard / Service
- ❌ 不改测试
- ❌ 不实现 §7 任何 Guard
- ❌ 不实现 §3 / §8 提出的任何新路径
- ❌ 不预先建 `dto/app/` / `dto/admin/` / `dto/internal/` 目录

---

## 10. 最终结论

### 10.1 必须立即补入 Phase 2 设计的事项

> **Phase 2 立项评审稿启动前**,以下事项必须先决议:

| # | 决议项 | 决议人 | 阻塞 Phase 2 启动? |
|---|---|---|---|
| 10.1.1 | "候选志愿者 / 临时编号志愿者" **是否能登录 App**;若能,如何在现有 `MemberStatus` / `User` 之外识别 | 业务方 | ✅ 是(决议结果影响 §2 矩阵) |
| 10.1.2 | "Admin 兼队员" 登录 App 时的 `/me` 行为(沿 §1.4);是否需要 `MEMBER_NOT_LINKED` BizCode | 业务方 + AI 评审 | ✅ 是(无决议会导致 §2 矩阵 "Admin 兼队员" 一行有歧义) |
| 10.1.3 | `GET /api/app/v1/me/permissions` 返 App capability 还是 permission code(沿 §8.1 #3) | AI 评审 + 前端 | ✅ 是(影响前端 SDK 设计) |
| 10.1.4 | `/api/app/v1/me/*` 与 `/api/app/v1/my/*` 是否拆(沿 §3 / §8.2);若拆,11 个 P0 接口中 4 个路径需调整 | AI 评审 | ✅ 是(影响路径稳定性) |
| 10.1.5 | 数据可见性矩阵 §5.1 中标 **?** 的 5 行(临时编号 / 职务 / 离队原因 / 血型在 AppManaged 可见性 / 贡献值排行)| 业务方 | ⚠️ 部分(影响 DTO 字段集,但 P0 接口可避开) |
| 10.1.6 | App API 是否暴露身份证号给本人(完整 vs 后 4 位掩码;沿 §5.2 铁律 5) | 业务方 + 合规 | ⚠️ 影响 AppSelfProfileDto 字段集 |

### 10.2 User Decisions Locked on 2026-05-19

> **状态**:本节由用户拍板,**4 条决策已锁定**;未来会话**禁止**自行重新评估或建议回滚,除非用户主动要求重开。
> 本节 4 条 D-N 仅是 §10.2 节内编号,**与** [`CLAUDE.md §19.7`](../CLAUDE.md) / [`AGENTS.md §19.7`](../AGENTS.md) 中的 D-1 / D-2 / D-3 / D-4 / D-5 **互不干扰**(两套编号空间各自独立)。
> 本节 4 条决策对应解锁 §10.1 中 4 项 ✅ 阻塞决议(§10.1.1 / §10.1.2 / §10.1.3 / §10.1.4)。

#### D-1 Phase 2 does not support candidate / temporary-number volunteer App login

Phase 2 App APIs only support users who are linked to an existing formal member:

- `User.memberId != null`
- `User.status = ACTIVE`
- `User.deletedAt IS NULL`
- `Member.status = ACTIVE`

Candidate volunteers and temporary-number volunteers are **not modeled in the current schema**. They must be handled by a future Recruiting / Onboarding design track, **not** by Phase 2 App API implementation.

**对应 §10.1.1 阻塞项**:候选 / 临时编号志愿者**不进** Phase 2 App 登录范围。

#### D-2 Admin-as-member uses App self perspective

When an `ADMIN` / `SUPER_ADMIN` account is **linked to a member**, `/api/app/v1/*` must behave from the linked member's **self perspective**.

`ADMIN` / `SUPER_ADMIN` role **must not expand** AppSelf field visibility.

When an `ADMIN` / `SUPER_ADMIN` account is **not linked to a member**, App capabilities should return `canUseApp = false` with a `MEMBER_NOT_LINKED`-style reason. Whether this becomes a formal `BizCode` is **deferred to Phase 2 implementation review**.

**对应 §10.1.2 阻塞项**:Admin 兼队员视角锁定为本人 member 范围,**不**因 role 扩大可见性。

#### D-3 App exposes capabilities, not raw RBAC permission codes

**Do not implement**:

```txt
GET /api/app/v1/me/permissions
```

as a raw RBAC permission-code endpoint.

**Phase 2 should implement or plan**:

```txt
GET /api/app/v1/me/capabilities
```

The response should expose **product-level App capabilities** such as:

- `canUseApp`
- `canEditProfile`
- `canRegisterActivity`
- `canCancelOwnRegistration`
- `canViewOwnAttendance`
- `canViewOwnCertificates`
- `canViewTasks`
- `canViewManagedActivities`
- `canReviewManagedRegistrations`
- `canReviewManagedAttendance`

**Backend still must re-check authorization on every write endpoint.** Capabilities are **UI hints**, not authorization proof.

**对应 §10.1.3 阻塞项**:App 暴露 product-level capability,**禁止**直接暴露 RBAC `permission code`。

#### D-4 `/me/*` and `/my/*` are physically separated

Phase 2 App API design must use:

```txt
/api/app/v1/me/*  = identity, account, profile, capability
/api/app/v1/my/*  = business records owned by the current member
```

**Examples**:

```txt
GET   /api/app/v1/me
GET   /api/app/v1/me/account
GET   /api/app/v1/me/profile
PATCH /api/app/v1/me/profile
PUT   /api/app/v1/me/password
GET   /api/app/v1/me/capabilities

GET   /api/app/v1/my/registrations
GET   /api/app/v1/my/attendance-records
GET   /api/app/v1/my/certificates
GET   /api/app/v1/my/activities
```

**对应 §10.1.4 阻塞项**:`/me/*` 与 `/my/*` **物理拆分**(沿 §3.1 四段分层提案前两段)。

### 10.3 可以延后到 Phase 3 / 4 / 5 的事项

- §3 `tasks/*` / `managed/*` 命名空间预留 → Phase 3+
- §4 移动端管理能力(活动负责人 / 考勤负责人 / 部门负责人 / 中队负责人) → Phase 3+ 或独立专项
- §6.3 `dto/app/` / `dto/admin/` 目录结构落地 → Phase 5(沿 [migration-plan §7](api-client-boundary-migration-plan.md))
- §7 任何 Guard 实现 → 触发条件出现时单独立项
- §5.20 离队 / 退队原因字段建模 → 独立 D 档

### 10.4 暂不考虑的事项

- 多组织 / 跨队隔离的 App API(沿 [批次 8 RBAC Q8=A 不切片](批次8_RBAC_业务确认稿.md))
- 通用 ABAC 权限引擎 / casl(沿 [`CLAUDE.md §1` v1 不做清单](../CLAUDE.md))
- App 端联系人 / 队员公开通讯录(`AppPeer*Dto` 数据源)
- App 端推送通知 / WebSocket 实时消息(`tasks/*` 实时部分)
- 多客户端 SDK 分别生成(沿 [Phase 1 评审稿 §1.2](api-client-boundary-phase-1-review.md))

### 10.5 高风险返工点

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 10.5.1 | Phase 2 实施 `/me/permissions` 直接返 permission code,App 上线后再改 capability,**前端必须升版** | **高** | 已由 §10.2 D-3 锁定:Phase 2 走 `/me/capabilities`,**禁止**返 raw permission code |
| 10.5.2 | Phase 2 复用 Admin DTO 给 App,App 上线后再拆,**敏感字段已泄漏一段时间** | **高(合规风险)** | DTO 类型隔离铁律(§6.2)必须在 Phase 2 评审稿冻结时一并锁定 |
| 10.5.3 | Phase 2 不预留 `tasks/*` / `managed/*` 命名空间,后续 App 上消息中心 / 管理能力时**架构图破** | **中** | 沿 §4.2 与 §3.2,**仅预留命名空间不实现 endpoint** |
| 10.5.4 | App 端假设"`Role.USER` 才是队员",Admin 兼队员登录 App 出现 403 | **中** | 已由 §10.2 D-2 锁定:Admin 兼队员用 App 自视角;E2E 必须覆盖"Admin 登录 App" 用例 |
| 10.5.5 | 业务方将来加"候选志愿者 / 临时编号"概念,触发 `MemberStatus` enum 扩展,**已上线 App 端假设 ACTIVE / INACTIVE 二值的代码全需复审** | **高** | 已由 §10.2 D-1 锁定:候选 / 临时编号**不进** Phase 2 范围;`MemberStatus` 扩展走独立 Recruiting / Onboarding 设计线 |
| 10.5.6 | App 端身份证号默认返完整,后续合规收紧,前端必须重新处理掩码 | **中** | §5.2 铁律 5 在 Phase 2 评审稿冻结,**默认掩码**,完整号走独立审计接口 |

---

## 11. 与既有铁律的衔接

| 现有铁律 | 与本评审稿关系 |
|---|---|
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) A-2(Role enum 不动)| ✅ 本评审稿**明确不动** Role enum |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) A-3(schema 改动需 D 档)| ✅ 本评审稿**不**触发 schema 改动 |
| [`CLAUDE.md §1`](../CLAUDE.md) v1 不做清单 | ✅ 本评审稿不引入 casl / RBAC 升级 |
| [`CLAUDE.md §13`](../CLAUDE.md) 角色层级 | ✅ 沿 SUPER_ADMIN / ADMIN / USER 不变 |
| [`CLAUDE.md §19`](../CLAUDE.md) 客户端边界设计期 | ✅ 本评审稿严格遵守 §19.1 硬禁止 |
| [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) | ✅ 本评审稿不触发 13 项基线任何变更 |
| [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) | ✅ A-2 / A-3 / A-4 / Slow-3 / Slow-4 全部沿用 |
| [`docs/批次8_RBAC_业务确认稿.md`](批次8_RBAC_业务确认稿.md) Q8=A 不切片 | ✅ 本评审稿明确 §4.4 / §4.5 部门切片**不实现** |
| [`docs/first-release-p0e-refresh-token-review.md`](first-release-p0e-refresh-token-review.md) | ✅ App API 沿 P0-E refresh token 现状;login / refresh / logout 共用 `/api/auth/*` |
| [`docs/first-release-p0d-change-my-password-review.md`](first-release-p0d-change-my-password-review.md) | ✅ App 改密 Phase 2 实施时**继承** P0-D 全部铁律(限流 + 联动撤 refresh + audit + BizCode) |

---

## 12. 解除时机与下一步

### 12.1 本评审稿生效顺序

1. **2026-05-19 v0 创建**:本评审稿 v0 创建;**不**改任何代码
2. **2026-05-19 v0.1 决策锁定**:用户拍板 §10.1 中 4 项 ✅ 阻塞决议,结果回写 §10.2(D-1 / D-2 / D-3 / D-4);§10.1.5 / §10.1.6 仍待决议(影响 DTO 字段集,但**不**阻塞 Phase 2 启动)
3. **Phase 2 立项评审稿启动**:沿 [migration-plan.md §4](api-client-boundary-migration-plan.md) 单独立项;本评审稿 §10.2 作为输入硬约束

### 12.2 本评审稿不解决的问题

- 不解决"候选 / 临时编号" schema 建模 → 独立 D 档专项
- 不解决"活动负责人 / 考勤负责人" schema 建模 → 独立 D 档专项
- 不解决"部门级数据范围权限" → 沿 [`ARCHITECTURE.md §9` 升级路径](../ARCHITECTURE.md);多组织诉求出现时启动

### 12.3 修订规则

- 本评审稿评审通过后,后续修订必须**记录修订时间 + 变更摘要**
- §10 决议项决议后,在本文档**就地**更新,**不**新建 v1 / v2 文档(沿 [Phase 1 评审稿 §10](api-client-boundary-phase-1-review.md))

---

> **本评审稿生效时间**:2026-05-19(Phase 0.5 v0)。
> **当前状态**:✅ "Phase 2 前置文档" — 4 项阻塞决议已锁定(2026-05-19 §10.2 D-1 ~ D-4);Phase 2 立项时本评审稿 §10.2 为硬约束。
> **过期条件**:Phase 2 全部落地后,本评审稿降为"历史评审"。
