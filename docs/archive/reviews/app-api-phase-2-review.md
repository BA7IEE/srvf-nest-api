# SRVF App API Phase 2 Review

> **状态**:**Phase 2 实施前评审稿 v0**(2026-05-19)
> **定位**:Phase 2 `/api/app/v1/*` 队员端 App API 实施**前置**评审稿。**不是开发授权**,**不是任务卡**,**不动代码 / DTO / schema / endpoint / migration / package.json**。
> **配套必读**:
>   - [`docs/api-client-boundary.md`](api-client-boundary.md)(Phase 0 顶层规范 + 8 条铁律)
>   - [`docs/api-client-boundary-inventory.md`](api-client-boundary-inventory.md)(140 endpoint 现状盘点)
>   - [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md)(分阶段路线 + Phase 3 方案 C)
>   - [`docs/api-client-boundary-phase-1-review.md`](api-client-boundary-phase-1-review.md)(Phase 1A/1B 执行评审稿)
>   - **[`docs/app-permission-boundary-review.md`](app-permission-boundary-review.md)(Phase 0.5 — App 身份 / 权限 / 数据可见性;§10.2 D-1 ~ D-4 已锁)**
>   - **[`docs/data-access-lifecycle-boundary-review.md`](data-access-lifecycle-boundary-review.md)(Phase 0.6 — surface / field / scope / state / lifecycle)**
>   - **[`docs/code-architecture-boundary-review.md`](code-architecture-boundary-review.md)(Phase 0.7 — Controller / DTO / Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect 10 个 implementation boundary)**
> **冲突优先级**:本评审稿优先级**最低**;冲突时让步给 [`ARCHITECTURE.md`](../ARCHITECTURE.md) / [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) / [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) / [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) / Phase 0 / 0.5 / 0.6 / 0.7 评审稿 / 既有批次评审稿。
> **解除条件**:本评审稿用户拍板冻结后,Phase 2 各 PR(P2-N)允许在 [`docs/process.md`](process.md) §3-§4 流程内**逐个**立项;**本评审稿不替代** Phase 2 各 PR 的独立评审。

---

## 0. TL;DR

1. **Phase 2 是 App API 第一波代码落地**:从 `mobile` surface(沿 [Phase 0.6 §1.1](data-access-lifecycle-boundary-review.md))切入,新增 `/api/app/v1/me/*` + `/api/app/v1/my/*` + `/api/app/v1/activities/*` 共 **15 个候选 endpoint**(沿 §2)。
2. **不照搬 [`migration-plan §4.1`](api-client-boundary-migration-plan.md) 的旧 11 个 P0 清单**:按 [Phase 0.5 §10.2 D-1 ~ D-4 锁定决策](app-permission-boundary-review.md) 重新校准 — `/me/permissions` → `/me/capabilities`、`/me/registrations*` → `/my/registrations*`、`/me/attendance-records` → `/my/attendance-records`、`/me` 拆 `me + me/account + me/profile`、`activities` 拆 `activities/available + my/activities`(沿 §1.2)。
3. **Phase 2 不支持候选 / 临时编号志愿者** App 登录(沿 D-5.1):仅 `User.memberId != null && User.status=ACTIVE && User.deletedAt IS NULL && Member.status=ACTIVE` 的正式队员可用 App;Admin 兼队员走 linked-member self perspective,**不**扩大字段可见性(沿 D-5.2)。
4. **Phase 2 暴露 `capabilities` 不暴露 raw RBAC permission code**(沿 D-5.3):`GET /api/app/v1/me/capabilities` 返 `canUseApp` / `canRegisterActivity` / `canCancelOwnRegistration` 等 product-level 字段;后端**仍必须**在每个写端点重新做授权校验。
5. **Phase 2 PR 拆分 = P2-0 docs-freeze + P2-1 ~ P2-7 业务 + P2-8 收尾** 共 **9 个 PR**(沿 §8;**v0.1 修订** 把 `PUT /me/password` 独立拆出为 P2-3);每个 PR diff **< 500 行**(超 500 行必须拆);**P2-0 不动代码**,P2-1 ~ P2-7 均为 **C 档**(新 endpoint + 新 DTO + contract / e2e 变化)。
6. **Phase 2 不动**:`prisma/schema.prisma` / migration / Role enum / MemberStatus enum / Permission seed / 旧 `/api/v2/*` 行为 / 旧 `/api/users/me*` 行为 / Phase 1B alias / 多份 Swagger 拆分 / `tasks/*` / `managed/*`(沿 §3)。
7. **Phase 2 启动硬前置**:本评审稿冻结 + Phase 0.5 §10.2 / Phase 0.6 / Phase 0.7 已被用户拍板;若 §10.1.5 / §10.1.6 待业务方决议项尚未拍板,Phase 2 P0 端点**仍可启动**(因 P0 范围避开 §10.1.5/6 影响面);**仅** `/me/profile` 中身份证号字段是否暴露给本人完整号会触发 §10.1.6,**默认走后 4 位掩码**(沿 [Phase 0.6 §2.3 / §6.5](data-access-lifecycle-boundary-review.md))。

---

## 1. Phase 2 范围与旧 11 个 P0 清单调整

### 1.1 旧 11 个 P0 清单(沿 [`migration-plan §4.1`](api-client-boundary-migration-plan.md))

```txt
GET   /api/app/v1/me
PATCH /api/app/v1/me/profile
PUT   /api/app/v1/me/password
GET   /api/app/v1/me/permissions
GET   /api/app/v1/me/registrations
GET   /api/app/v1/me/registrations/:id
PATCH /api/app/v1/me/registrations/:id/cancel
POST  /api/app/v1/me/activities/:id/registrations
GET   /api/app/v1/me/attendance-records
GET   /api/app/v1/activities
GET   /api/app/v1/activities/:id
```

旧清单**于 2026-05-19 之前撰写**,在 Phase 0.5 / 0.6 / 0.7 评审稿落地前。Phase 2 启动前必须按这三份评审稿重新校准。

### 1.2 校准后变更(沿 Phase 0.5 §10.2 / Phase 0.6 §3.1)

| # | 旧 P0 接口 | 校准后状态 | 校准来源 |
|---|---|---|---|
| 1 | `GET /api/app/v1/me` | **保留** + **拆出** `GET /me/account` + `GET /me/profile` | Phase 0.5 §8.1 #1(方案 A 倾向)|
| 2 | `PATCH /api/app/v1/me/profile` | **保留**(白名单严格) | 无变化 |
| 3 | `PUT /api/app/v1/me/password` | **保留**;P0-D 全套铁律继承(`@PasswordChangeThrottle` / `OLD_PASSWORD_INVALID=10005` / `NEW_PASSWORD_SAME_AS_OLD=10006` / 撤 refresh / audit) | [P0-D 评审稿](first-release-p0d-change-my-password-review.md) + [`CLAUDE.md §9 P0-D 子节`](../CLAUDE.md) |
| 4 | `GET /api/app/v1/me/permissions` | **替换**为 `GET /api/app/v1/me/capabilities`(product-level capability map,**禁止**返 raw RBAC permission code) | Phase 0.5 §10.2 **D-3** + [`CLAUDE.md §19.7 D-5.3`](../CLAUDE.md) |
| 5 | `GET /api/app/v1/me/registrations` | **改路径**到 `GET /api/app/v1/my/registrations` | Phase 0.5 §10.2 **D-4** |
| 6 | `GET /api/app/v1/me/registrations/:id` | **改路径**到 `GET /api/app/v1/my/registrations/:id` | 同上 |
| 7 | `PATCH /api/app/v1/me/registrations/:id/cancel` | **改路径**到 `PATCH /api/app/v1/my/registrations/:id/cancel` | 同上 |
| 8 | `POST /api/app/v1/me/activities/:id/registrations` | **改路径**到 `POST /api/app/v1/my/registrations`(入参带 `activityId`)| Phase 0.5 §3 / §8.2(`my/*` 表"我的业务记录") |
| 9 | `GET /api/app/v1/me/attendance-records` | **改路径**到 `GET /api/app/v1/my/attendance-records` | Phase 0.5 §10.2 **D-4** |
| 10 | `GET /api/app/v1/activities` | **拆**为 `GET /api/app/v1/activities/available`(我可参加的)+ `GET /api/app/v1/my/activities`(我已报名 / 已参与) | Phase 0.5 §8.1 #2 |
| 11 | `GET /api/app/v1/activities/:id` | **保留**;App 视角 DTO(脱敏 + 简化) | Phase 0.6 §1.3 Mixed 拆分 |

**新增 P1**:`GET /api/app/v1/my/certificates`(沿 [inventory §4 P1](api-client-boundary-inventory.md);App 端"我的证书"刚需,纳入 Phase 2 范围)。

**预留命名空间但不实现**:`/api/app/v1/tasks/*` / `/api/app/v1/managed/*`(沿 Phase 0.5 §3.2 / §4 / §10.3)。

### 1.3 Phase 2 范围声明

**Phase 2 是**:新增 `/api/app/v1/*` 队员端 App API 第一波代码落地(15 个 endpoint)。

**Phase 2 不是**:
- 不是 Recruiting / Onboarding(候选 / 临时编号志愿者沿 D-5.1 不进入 Phase 2)
- 不是 Admin API 改造(沿 Phase 3 方案 C 旧 `/api/v2/*` 不动)
- 不是 System API 收口(沿 Phase 4)
- 不是 Mixed API 物理拆分(沿 Phase 5;Phase 2 **不**动 `/api/users/me*` / `/api/v2/users/me/*` / `/api/v2/activities` / `/api/v2/rbac/me/permissions` / `/api/v2/attachments/me/uploaded` 任何旧路径)
- 不是 schema / migration 改造(沿 [`ARCHITECTURE.md`](../ARCHITECTURE.md) A-3)
- 不是 Phase 1B `/api/auth/v1/*` / `/api/public/v1/*` 别名(那是 Phase 1 范围)
- 不是 RBAC 权限点收紧(沿 P0-F 独立通道)

---

## 2. Phase 2 最终建议接口清单

> **状态**:**实施候选**(由 Phase 2 P2-1 ~ P2-7 各自 PR 评审稿在启动时再次对齐)。
> 本表为**强制基线**;Phase 2 各 PR 评审稿允许**收窄**(如 P2-6 暂缓某接口),**禁止**扩张(新增本表外端点必须用户拍板)。

| Method | Path | Purpose | Surface | Scope | Auth | DTO(命名草案) | Service 复用 | Risk | PR Batch |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/app/v1/me` | 本人 user + member 摘要 + `canUseApp` 标志 | mobile | self | JwtAuthGuard(任意登录用户)| `AppMeResponseDto` | `users.service.findMe` + 新 `AppIdentityResolver`(可内嵌 users.service 内一个 method)| 中 | **P2-1** |
| GET | `/api/app/v1/me/account` | 仅账号信息(username / role / lastLoginAt / canUseApp / `memberLinked` 标志)| mobile | self | JwtAuthGuard | `AppMeAccountDto` | 同上 | 低 | P2-1 |
| GET | `/api/app/v1/me/capabilities` | 本人 App capability map(product-level) | mobile | self | JwtAuthGuard | `AppCapabilityResponseDto` | 新 `AppCapabilityService.resolve(currentUser)` | **高(D-5.3)** | **P2-1** |
| GET | `/api/app/v1/me/profile` | 本人 member 详情(App 视角字段;**身份证号默认掩码**)| mobile | self | JwtAuthGuard + Member.status=ACTIVE | `AppSelfProfileDto` | 新 method `getMemberProfileForSelf(memberId)`(可在 `members.service` 新增,**不**复用 admin `getProfile`)| **高(L2)** | **P2-2** |
| PATCH | `/api/app/v1/me/profile` | 改 `nickname` / `avatarKey`(严格白名单 2 字段;沿 §5.2 #5 锁定列表) | mobile | self | JwtAuthGuard + Member.status=ACTIVE | `UpdateAppSelfProfileDto`(仅 `nickname` + `avatarKey`) | 新 method;**禁止**夹带 §5.2 #5 列出的任何其他字段 | 中(白名单严格)| P2-2 |
| PUT | `/api/app/v1/me/password` | 本人改密(P0-D 全套铁律继承;独立 PR) | mobile | self | JwtAuthGuard + `@PasswordChangeThrottle()` | `ChangeMyPasswordDto`(沿 P0-D zero drift) | 复用 `users.service.changeMyPassword` | **高(沿 P0-D + P0-E)** | **P2-3** |
| GET | `/api/app/v1/activities/available` | 我可参加的活动列表(published + 报名窗内 + 未满 + 未被本人报过)| mobile | self(隐式) | JwtAuthGuard + Member.status=ACTIVE | `AppAvailableActivityListItemDto` | 新 method `activities.service.listAvailableForMember(memberId, query)`;**不**复用 `list(currentUser, query)` | **高(新逻辑)** | **P2-4** |
| GET | `/api/app/v1/activities/:id` | 活动详情(App 视角)| mobile | self(隐式) | JwtAuthGuard + Member.status=ACTIVE | `AppActivityDetailDto` | 复用 `activities.service.findOne` + 新 `AppActivityPresenter` | 中(DTO 隔离) | P2-4 |
| GET | `/api/app/v1/my/activities` | 我已报名 / 已参与的活动列表(汇总视图)| mobile | self | JwtAuthGuard + Member.status=ACTIVE | `AppMyActivityListItemDto` | 新 method(可在 `activity-registrations.service` 内,**返 activity 摘要而非 registration**)| 中 | **P2-5** |
| GET | `/api/app/v1/my/registrations` | 我的报名记录列表 | mobile | self | JwtAuthGuard + Member.status=ACTIVE | `AppMyRegistrationListItemDto` | 复用 `activity-registrations.service.listMyRegistrations` + 新 Presenter | 中 | P2-5 |
| GET | `/api/app/v1/my/registrations/:id` | 我的某条报名详情 | mobile | self | JwtAuthGuard + 资源 owner 校验(`registration.memberId == currentUser.memberId`)| `AppMyRegistrationDto` | 复用 `activity-registrations.service.findMyRegistration` + 新 Presenter | 中(scope 双重校验) | P2-5 |
| POST | `/api/app/v1/my/registrations` | 本人报名某活动(入参 `activityId` + 自定义表单数据)| mobile | self | JwtAuthGuard + Member.status=ACTIVE + Policy(活动状态 / 报名窗 / 上限 / 已报过 / 资格)| `CreateAppMyRegistrationDto` | 复用 `activity-registrations.service.registerMe` + Phase 0.7 Policy 显式 transition guard | **高(状态机 + Policy)** | **P2-5** |
| PATCH | `/api/app/v1/my/registrations/:id/cancel` | 取消本人报名 | mobile | self | JwtAuthGuard + Member.status=ACTIVE + 资源 owner + Policy(状态可取消 + 取消窗) | (无 body 或 `CancelAppMyRegistrationDto` 仅可选备注)| 复用 `activity-registrations.service.cancelMyRegistration` + Phase 0.7 transition guard | **高(状态机)** | P2-5 |
| GET | `/api/app/v1/my/attendance-records` | 我的考勤记录(汇总;按活动)| mobile | self | JwtAuthGuard + Member.status=ACTIVE | `AppMyAttendanceRecordDto` | 复用 `attendances.service.listMyRecords` + 新 Presenter | 中 | **P2-6** |
| GET | `/api/app/v1/my/certificates` | 我的证书列表(本人;含未通过的让本人自查;但**禁止**返其他 member 字段)| mobile | self | JwtAuthGuard + Member.status=ACTIVE | `AppMyCertificateDto` | 新 method `certificates.service.listForMember(memberId, query)` | 中(新 method) | **P2-7** |

### 2.1 路径设计校验(沿 Phase 0.5 §10.2 D-4)

```txt
/me/*  = identity / account / profile / capability  ← 共 6 个 endpoint(GET me + 5 个)
/my/*  = business records owned by current member   ← 共 7 个 endpoint(activities/registrations/attendance/certificates)
/activities/*                                       ← 共 2 个 endpoint(available + :id 详情)
```

`/me/*` 与 `/my/*` 物理拆分(沿 D-4);`/activities/*` 表"全局活动池中我可见的部分",不归 `/me/*` 也不归 `/my/*`。

### 2.2 实施可行性已验证

- **`/me`**:`users.service.findMe` 已返回完整 user;Phase 2 需新增 `+ member` 联表(沿 [`schema.prisma` User.memberId 反向 relation](../prisma/schema.prisma));新建 `AppMeResponseDto` 合并字段
- **`/me/account`**:仅 `findMe` 的子集 + 派生 `canUseApp` / `memberLinked` 标志
- **`/me/profile`** GET / PATCH:`member-profiles.service` 现有 admin 路径需新 self-perspective method;**禁止**复用 admin DTO
- **`/me/password`**:`users.service.changeMyPassword` 已实施(P0-D);Phase 2 仅迁 path
- **`/me/capabilities`**:新 service(`AppCapabilityService`)读 currentUser + member.status + rbac permission set,输出 product-level map
- **`/activities/available`**:`activities.service.list` 现状对 USER 角色已过滤 published + completed;Phase 2 需新增"报名窗口内 + 未满 + 本人未报过"逻辑(沿 Phase 0.7 §11 Refactor Trigger:新增大列表筛选必须走 QueryService)
- **`/activities/:id`**:`activities.service.findOne` 已存在;Phase 2 仅做 App DTO 投影
- **`/my/activities` / `/my/registrations*`**:`activity-registrations.service` 已有 `listMyRegistrations` / `findMyRegistration` / `cancelMyRegistration` / `registerMe`;Phase 2 仅做 Mobile Controller + App DTO + Presenter
- **`/my/attendance-records`**:`attendances.service.listMyRecords` 已存在;Phase 2 仅做 Mobile Controller + App DTO + Presenter
- **`/my/certificates`**:**新 method**;现状仅有 admin `members/:memberId/certificates` 路径(沿 [inventory §2.7](api-client-boundary-inventory.md));Phase 2 必须新增 `certificates.service.listForMember(memberId, query)` self-scope method

---

## 3. Phase 2 不做清单(强制)

Phase 2 **绝对不做**以下任何一项;违反 = PR review 拒绝信号。

### 3.1 不支持 / 不实现

- ❌ **不支持**候选志愿者 App 登录(沿 D-5.1)
- ❌ **不支持**临时编号志愿者 App 登录(沿 D-5.1)
- ❌ **不支持**未绑定 member 的 admin 账号使用 App 队员功能(`canUseApp=false`;沿 D-5.2 + [Phase 0.6 §5.4 L1 / L8 行](data-access-lifecycle-boundary-review.md))
- ❌ **不实现** Recruiting / Onboarding 流程(报名 → 候选 → 转正 / 临时编号 → 转正 / 队员变更);独立 D 档专项
- ❌ **不实现** `/api/app/v1/tasks/*`(命名空间预留;沿 Phase 0.5 §4.1)
- ❌ **不实现** `/api/app/v1/managed/*`(同上)
- ❌ **不实现** `/me/permissions` 返 raw RBAC permission code(沿 D-5.3)
- ❌ **不实现** App 端"看别人"接口(`AppPeer*` 视角;沿 [Phase 0.5 §6.1](app-permission-boundary-review.md))
- ❌ **不实现** 找回密码 / 短信验证码 / OAuth / 微信小程序登录(沿 [`migration-plan §10.4`](api-client-boundary-migration-plan.md) + Phase 0.5 §10.4)
- ❌ **不实现** App 端"完整身份证号导出"接口(沿 [Phase 0.6 §2.3 / §6.5](data-access-lifecycle-boundary-review.md);默认掩码)
- ❌ **不实现** App 端"已登录设备列表" / device fingerprint(沿 [`CLAUDE.md §9 P0-E v1 D-9`](../CLAUDE.md))
- ❌ **不实现** 多份 Swagger 拆分(`/api-docs/app` 等;沿 [Phase 1 评审稿 §5.2](api-client-boundary-phase-1-review.md);Phase 4 评估)
- ❌ **不实现** Phase 1B `/api/auth/v1/*` / `/api/public/v1/*` alias(独立 Phase 1B PR)

### 3.2 不动 / 不破坏

- ❌ **不动** `prisma/schema.prisma`(沿 [`ARCHITECTURE.md`](../ARCHITECTURE.md) A-3)
- ❌ **不生成** migration
- ❌ **不动** `Role` enum / `UserStatus` enum / `MemberStatus` enum
- ❌ **不新增** Permission seed / RbacRole(沿 [批次 8 Q8=A 不切片](批次8_RBAC_业务确认稿.md))
- ❌ **不动** 旧 `/api/v2/*` 行为(沿 Phase 3 方案 C)
- ❌ **不动** `/api/users/me` / `PATCH /api/users/me` / `PUT /api/users/me/password` 三个 v1 legacy path(沿 P0-D 兼容)
- ❌ **不动** `/api/v2/users/me/*` 4 个旧 path(沿 [inventory §5](api-client-boundary-inventory.md))
- ❌ **不动** `/api/v2/rbac/me/permissions`(继续作为 PC 后台菜单权限点来源使用;App 端走新 `/me/capabilities`)
- ❌ **不动** `/api/v2/attachments/me/uploaded`(沿 [inventory §5](api-client-boundary-inventory.md);App 端 `me/attachments` 沿 P2 范围**不**包含,留作 Phase 2.x 单独评审)
- ❌ **不动** Phase 1A Swagger Tag(沿 [Phase 1 评审稿 §2.2.2](api-client-boundary-phase-1-review.md))
- ❌ **不动** P0-E refresh token / login / logout / logout-all 现状契约(`/api/auth/*`)
- ❌ **不 deprecated** 任何旧接口
- ❌ **不引入** Redis / queue / cron / outbox / casl(沿 [`CLAUDE.md §1`](../CLAUDE.md))
- ❌ **不引入**新依赖 / 不改 `package.json` / 不改 `pnpm-lock.yaml`
- ❌ **不动** `apply-global-setup.ts` / `apply-swagger.ts` 等 bootstrap 文件

### 3.3 不立即重构(沿 [Phase 0.7 §6 / §12](code-architecture-boundary-review.md))

Phase 2 **不**拆既有大 service(`attendances.service.ts:1413` / `attachments.service.ts:885` / `activity-registrations.service.ts:808` / `activities.service.ts:656` / `users.service.ts:544`)。**仅在新增 method 时**严格遵守 Phase 0.7 §11 Refactor Triggers(新增 mobile endpoint → 必须 Mobile Controller + App DTO + Presenter)。

---

## 4. App `/me/capabilities` 设计

### 4.1 端点契约

```
GET /api/app/v1/me/capabilities

Auth:     JwtAuthGuard(任意登录用户)
Throttle: 默认(不专门限流)
Scope:    self
Response: AppCapabilityResponseDto
```

### 4.2 响应结构建议

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "account": {
      "canUseApp": true,
      "reason": null,
      "canEditProfile": true,
      "canChangePassword": true
    },
    "activities": {
      "canViewAvailableActivities": true,
      "canRegisterActivity": true,
      "canCancelOwnRegistration": true
    },
    "attendance": {
      "canViewOwnAttendance": true
    },
    "certificates": {
      "canViewOwnCertificates": true
    },
    "tasks": {
      "canViewTasks": false
    },
    "managed": {
      "canViewManagedActivities": false,
      "canReviewManagedRegistrations": false,
      "canReviewManagedAttendance": false
    }
  }
}
```

### 4.3 字段语义铁律(沿 D-5.3 + Phase 0.7 §3.2)

1. **响应字段集是 product-level capability map**,**不是** RBAC permission code 列表;**禁止**返 `permissionCodes: string[]` 字段;**禁止**返 RBAC `role` 名
2. **capability 不是授权证明**:前端用它**控制 UI**(按钮是否显示 / 入口是否可点);**后端必须**在每个写端点(`POST /my/registrations` / `PATCH /my/registrations/:id/cancel` / `PATCH /me/profile` / `PUT /me/password`)**重新做完整四维授权校验**(Action × Scope × Field × State;沿 [Phase 0.7 §3](code-architecture-boundary-review.md))
3. **`ADMIN` / `SUPER_ADMIN` 不扩大** AppSelf capability:Admin 兼队员的 `/me/capabilities` 与 USER 队员的输出**字段集相同**;Admin **不**因 role 多出 `canManageMembers` 之类(沿 D-5.2)
4. **未绑定 member 的账号**:`account.canUseApp=false` + `account.reason="MEMBER_NOT_LINKED"`(或类似稳定字符串);所有其它 capability **强制 false**;**禁止**部分 true 部分 false(沿 [Phase 0.6 §5.4 L1 / L8](data-access-lifecycle-boundary-review.md))
5. **`Member.status=INACTIVE` 或软删**:`account.canUseApp=false`(沿 [Phase 0.6 §5.4 L3 / L4](data-access-lifecycle-boundary-review.md));`reason` 由 Phase 2 实施评审稿决议是否细分 `MEMBER_INACTIVE` / `MEMBER_DELETED`(本评审稿**不**锁;P2-1 PR 评审稿决议)
6. **未来扩展**:新增 capability 字段(如 `account.canBindWechat`)**不**视作 breaking change(向后兼容);**删除**或**改语义**视作 breaking,需 Phase 2.x 评审稿
7. **`reason` 字段命名风格**(`MEMBER_NOT_LINKED` / `MEMBER_INACTIVE` 等)**不**绑定到 BizCode 段位;**不**新增 BizCode 号位;`reason` 是**展示字符串**,不是异常 code
8. **本评审稿不锁** `MEMBER_NOT_LINKED` 是否成为正式 BizCode(沿 Phase 0.5 §10.2 D-2 留 P2-1 评审稿);若决议成为 BizCode,沿 100xx 段位下一可用号位(当前已用 10001 ~ 10007;沿 [`CLAUDE.md §5`](../CLAUDE.md))

### 4.4 实施 PR 的责任范围

P2-1 PR 评审稿启动时**必须**对齐:

- `AppCapabilityService` 内部读哪些字段(`User.role` / `User.status` / `User.memberId` / `Member.status` / `Permission[]`)
- `reason` 字段的可能取值闭集
- 每个 capability 与 backend 真正校验路径的映射(沿 §4.3 铁律 2)
- contract snapshot:`AppCapabilityResponseDto` 字段集**冻结**;新增字段允许,删除 / 改名需新评审

---

## 5. App DTO 命名规范与字段策略

### 5.1 DTO 类名草案

| 类名 | 路径 | 视角 | 字段集上限(沿 Phase 0.6 §2.3) |
|---|---|---|---|
| `AppMeResponseDto` | `GET /me` | AppSelf | L0 + L1(本人) |
| `AppMeAccountDto` | `GET /me/account` | AppSelf | L0 + L1(本人;含 `canUseApp` / `memberLinked`) |
| `AppSelfProfileDto` | `GET /me/profile` | AppSelf | L0 + L1 + **掩码 L2**(本人;身份证号默认后 4 位) |
| `UpdateAppSelfProfileDto` | `PATCH /me/profile` 入参 | AppSelf | 严格白名单(本评审稿 §5.2 锁定字段集) |
| `AppCapabilityResponseDto` | `GET /me/capabilities` | AppSelf | L0(capability map) |
| `AppAvailableActivityListItemDto` | `GET /activities/available` | AppSelf(隐式) | L0 + L1(活动公开字段) |
| `AppActivityDetailDto` | `GET /activities/:id` | AppSelf(隐式) | L0 + L1(活动公开字段;**不**含 `cancelledBy` / `publishedBy` 等内部审批字段) |
| `AppMyActivityListItemDto` | `GET /my/activities` | AppSelf | L0 + L1(活动公开字段 + 本人在该活动的 registration 状态) |
| `AppMyRegistrationListItemDto` | `GET /my/registrations` | AppSelf | L0 + L1 |
| `AppMyRegistrationDto` | `GET /my/registrations/:id` | AppSelf | L0 + L1(含本人被 reject 的 `rejectReason` — L1 对本人) |
| `CreateAppMyRegistrationDto` | `POST /my/registrations` 入参 | AppSelf | 严格白名单:`activityId` + `registrationData?`(可选自定义表单数据) |
| `CancelAppMyRegistrationDto` | `PATCH /my/registrations/:id/cancel` 入参 | AppSelf | 严格白名单:可选 `note`(P2-5 评审稿决议是否必填) |
| `AppMyAttendanceRecordDto` | `GET /my/attendance-records` | AppSelf | L0 + L1 |
| `AppMyCertificateDto` | `GET /my/certificates` | AppSelf | L0 + L1(含本人未通过的 `rejectionReason` — L1 对本人) |
| (预留命名,**不实施**)`AppPeer*Dto` | — | AppPeer | 沿 Phase 0.5 §6.1;Phase 2 不实施 |
| (预留命名,**不实施**)`AppManaged*Dto` | — | AppManaged | 沿 Phase 0.5 §6.1;Phase 2 不实施 |

### 5.2 DTO 字段策略铁律(沿 Phase 0.5 §6.2 + Phase 0.6 §2.4 + Phase 0.7 §2.2)

1. **禁止 `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` Admin DTO 构造 App DTO**:`class AppMeResponseDto extends UserResponseDto` 视作越权;PR review 强制拒绝;NestJS swagger mapped-types 同样禁止
2. **禁止把 Prisma model 直接作为 App response contract**:`User` / `Member` / `Activity` / `ActivityRegistration` / `AttendanceRecord` / `Certificate` Prisma 类型**仅在** service 内使用,**绝不**返给 controller
3. **AppSelf DTO 字段集 ≤ L2(本人)**;L3 字段(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL)**永远不出现**;snapshot 测试若出现 L3 → PR 拒合并(沿 [Phase 0.6 §6.5](data-access-lifecycle-boundary-review.md))
4. **`AppSelfProfileDto` 中身份证号默认后 4 位掩码**(沿 [Phase 0.6 §2.3](data-access-lifecycle-boundary-review.md));完整号走独立审计接口(**Phase 2 不实施**)
5. **`UpdateAppSelfProfileDto` 严格白名单**(Phase 2 锁定;沿 [`CLAUDE.md §11`](../CLAUDE.md)):

   **仅允许 2 个字段**:
   - `nickname`(本人昵称;`@MaxLength(50)`)
   - `avatarKey`(本人头像 attachment key;`@MaxLength(255)`)

   **明确禁止**(以下任一字段进入 DTO 视作越权;`forbidNonWhitelisted: true` 兜底,DTO 自身白名单是第一道防线):

   - **Member 业务字段**:`realName` / `mobile` / `documentNumber`(身份证号)/ `bloodType` / `bloodTypeCode` / `medicalNotes`(健康信息 / 医疗备注)/ `memberNo` / `displayName` / `gradeCode`
   - **Emergency contacts**:任何 `emergencyContact*` / `contactName` / `contactPhone` / `relation` / `emergencyContacts[]` 字段(沿 [inventory §2.6](api-client-boundary-inventory.md);App 端"看 / 改自己的紧急联系人"应**独立** endpoint `PATCH /api/app/v1/me/emergency-contacts/*`,**Phase 2 不实施**;若纳入需独立立项 + 独立 DTO + audit + 限流)
   - **Organization / Department**:`organizationId` / `departmentId` / `organizationName` / `departmentName` / `memberDepartment*` 字段(沿 [inventory §2.12](api-client-boundary-inventory.md);部门归属由管理员维护,**Phase 2 不开放本人改**)
   - **Account 字段**:`username` / `email` / `password` / `newPassword` / `oldPassword` / `passwordHash` / `lastLoginAt` / `id` / `memberId` / `userId`(本人改密走独立 endpoint `PUT /api/app/v1/me/password`,沿 P2-3;**禁止**在本接口夹带)
   - **Role / Permission / Status**:`role` / `roles[]` / `permissions[]` / `permissionCodes[]` / `status` / `deletedAt`(系统字段;沿 [`CLAUDE.md §13`](../CLAUDE.md);**禁止**通过资料接口提权)
   - **审批 / 内部字段**:`reviewerNote` / `verifiedBy` / `verifiedAt` / `internalNote` / `cancelledBy*` / `publishedBy*` / 任何 Admin 视角内部字段

   若 P2-2 评审稿决议 App 端允许本人改某项 Member 业务字段(如 `realName` / `mobile`),**必须**独立立项,**不**夹带到本接口;独立立项时需:与 Admin 改 member 接口拉齐**审计** + **限流** + **字段级 BizException** + **L2 字段处理策略**(沿 [Phase 0.6 §2.3 / §6.5](data-access-lifecycle-boundary-review.md)),并在新评审稿中明确单字段授权链路。
6. **`CreateAppMyRegistrationDto` 严格白名单**:仅允许 `activityId` + 可选 `registrationData`(JSON);**禁止**包含 `memberId` / `userId` / `submittedAt` / `statusCode` / `reviewedBy` / `reviewedAt` 等任何系统字段
7. **`AppMyRegistrationDto` 状态字段语义化**:`statusCode` 若返字符串(沿现状字典 4 态 `pending` / `pass` / `reject` / `cancelled`),**前端按字符串映射**;**禁止**返内部审批语义字段(如 `pending_internal_review`);沿 [Phase 0.6 §4.4](data-access-lifecycle-boundary-review.md)
8. **物理目录**(沿 [Phase 0.7 §2.3 / §6.3](code-architecture-boundary-review.md)):每个模块独立 `dto/app/` 目录;**禁止**跨模块共用 `dto/app/`;**禁止**新建项目级 `dto/app/` 公共目录
9. **`AppActivityDetailDto` 不含**:`deletedAt` / `publishedBy` / `cancelledBy` / `cancelledByUserId` / `internalNotes` / `creatorUserId`(内部审批字段);**允许**含 `statusCode` / `startDate` / `endDate` / `location` / `description` / `currentRegistrations` / `maxRegistrations`(沿 [Phase 0.6 §1.3](data-access-lifecycle-boundary-review.md))
10. **`AppMyCertificateDto` 字段集**:`id` / `certStatusCode` / `issuedDate` / `createdAt` + 对本人的 `rejectionReason`;**禁止**返 `reviewerNote` / `reviewedBy` / `internalNote` 等内部字段

---

## 6. App Identity / Access 检查逻辑

### 6.1 Phase 2 App API 准入规则(沿 D-5.1 + D-5.2)

每个 `/api/app/v1/*` endpoint 在 `JwtAuthGuard` 通过后,**必须**在 service / controller 中执行如下检查(沿 [Phase 0.6 §5.5 实施铁律](data-access-lifecycle-boundary-review.md)):

```
读 currentUser
  ↓
if (!currentUser.memberId
    || currentUser.status !== 'ACTIVE'
    || currentUser.deletedAt !== null
) {
  → 仅允许 /me/capabilities 返回 canUseApp=false
  → 所有其它 endpoint 拒绝(走 capability-aware 拒绝路径,详见 §6.3)
}

读 member by currentUser.memberId
  ↓
if (!member
    || member.status !== 'ACTIVE'
    || member.deletedAt !== null
) {
  → 仅允许 /me/capabilities 返回 canUseApp=false
  → 所有其它业务 endpoint 拒绝(走 capability-aware 拒绝路径)
}

→ 通过准入,继续走 Action × Scope × Field × State 四维校验
```

### 6.2 各 endpoint 的准入要求

| Endpoint | JwtAuthGuard | User.status=ACTIVE + deletedAt=null | User.memberId != null | Member.status=ACTIVE + deletedAt=null |
|---|---|---|---|---|
| `GET /me` | ✅ | ✅(沿 `JwtStrategy.validate`) | ⚠️ 可选(无 member 时 `canUseApp=false`)| ⚠️ 同左 |
| `GET /me/account` | ✅ | ✅ | ⚠️ 同上 | ⚠️ 同上 |
| `GET /me/capabilities` | ✅ | ✅ | ⚠️ 同上 | ⚠️ 同上 |
| `GET /me/profile` | ✅ | ✅ | **必填** | **必须 ACTIVE** |
| `PATCH /me/profile` | ✅ | ✅ | **必填** | **必须 ACTIVE** |
| `PUT /me/password` | ✅ | ✅ | ⚠️ 可选(admin 无 member 也允许改密)| ⚠️ 同左 |
| `GET /activities/available` | ✅ | ✅ | **必填** | **必须 ACTIVE** |
| `GET /activities/:id` | ✅ | ✅ | **必填** | **必须 ACTIVE** |
| `GET /my/activities` | ✅ | ✅ | **必填** | **必须 ACTIVE** |
| `GET /my/registrations` | ✅ | ✅ | **必填** | **必须 ACTIVE** |
| `GET /my/registrations/:id` | ✅ | ✅ | **必填** | **必须 ACTIVE** + owner |
| `POST /my/registrations` | ✅ | ✅ | **必填** | **必须 ACTIVE** + Policy |
| `PATCH /my/registrations/:id/cancel` | ✅ | ✅ | **必填** | **必须 ACTIVE** + owner + Policy |
| `GET /my/attendance-records` | ✅ | ✅ | **必填** | **必须 ACTIVE** |
| `GET /my/certificates` | ✅ | ✅ | **必填** | **必须 ACTIVE** |

### 6.3 拒绝路径设计(沿 Phase 0.5 §10.2 D-2 user-friendly)

**不**通过简单 403 拒绝:
- 走 `capability-aware` 拒绝路径,在 capability check 失败时返回**业务级 BizException** 而非纯 403
- BizCode 段位:本评审稿**不**新增 BizCode 号位;由 P2-1 PR 评审稿决议是否新增 `MEMBER_NOT_LINKED` / `MEMBER_INACTIVE`(沿 §4.3 铁律 8)
- 在 P2-1 评审稿冻结前,**临时**复用 `FORBIDDEN`(40300)+ message `"App 功能不可用:未绑定队员档案"` / `"App 功能不可用:队员档案已停用"` 等明确文案;前端通过 `/me/capabilities` 提前规避

### 6.4 状态机层叠语义(沿 [Phase 0.6 §4](data-access-lifecycle-boundary-review.md))

**User 生命周期 ≠ Member 生命周期**(沿 [Phase 0.6 §5.2 铁律](data-access-lifecycle-boundary-review.md)):

| 状态组合 | CanLogin | CanUseApp | App 读历史 | App 报名 | 沿 Phase 0.6 §5.4 |
|---|---|---|---|---|---|
| User ACTIVE + Member ACTIVE + linked | ✅ | ✅ | ✅ | ✅ | L2 |
| User ACTIVE + Member INACTIVE + linked | ✅ | ❌(`canUseApp=false`)| ⚠️ 沿 Phase 2 评审决议 | ❌ | L3 |
| User ACTIVE + Member 软删 + linked | ✅ | ❌ | ❌ | ❌ | L4 |
| User ACTIVE + 无 memberId(admin 不绑)| ✅ | ❌(沿 D-5.2)| N/A | N/A | L1 / L8 |
| User DISABLED 或 软删 | ❌(沿 [`CLAUDE.md §8`](../CLAUDE.md)) | N/A | N/A | N/A | L5 / L6 |
| Admin 兼队员(ACTIVE + Member ACTIVE)| ✅ | ✅(本人 self perspective;沿 D-5.2)| ✅(本人范围) | ✅(本人) | L7 |

**铁律**:Phase 2 实施时,App API where 子句**永远**用 `currentUser.memberId` 作为本人锁定(沿 D-5.2);**禁止**用 `currentUser.role` 短路决定数据范围(沿 [Phase 0.7 §3.3](code-architecture-boundary-review.md))。

---

## 7. Query / Presenter / Policy 落地策略(最小化)

> 沿 [Phase 0.7 §11 Refactor Triggers + §13 P0 / P1 排序](code-architecture-boundary-review.md):**boundary-aware,不立即大规模重构**。

### 7.1 新增代码层(Phase 2 必须有)

| 层 | 何时引入 | Phase 2 范围 |
|---|---|---|
| **Mobile Controller** | P2-1 起 | 每个新 endpoint 都有 mobile controller;命名 `mobile-*.controller.ts` 或 `app-*.controller.ts`;**禁止**复用 admin controller |
| **App DTO**(独立目录) | P2-1 起 | 每个模块新建 `dto/app/` 子目录;沿 §5 命名 |
| **App Presenter / Mapper** | P2-1 起 | `entity → AppXxxDto` 转换在显式 mapper / function 中;**禁止**在 service 内 `select: {...}` 直接拼 App DTO 形状(因为 service 应跨 surface 复用,沿 [Phase 0.7 §2.1](code-architecture-boundary-review.md))|
| **AppIdentityResolver** | P2-1 | 单 method 实现 §6.1 准入检查;Phase 2 内**可内嵌**在 `users.service` 一个 method(沿 [Phase 0.7 §13.3 P0/P1 过渡](code-architecture-boundary-review.md));**第二次复用**(P2-2 P2-3 ...)再抽 service / 拆为 `AppIdentityService` |
| **AppCapabilityService** | P2-1 | 沿 §4;独立 service 文件 |

### 7.2 可延后(Phase 2 允许内嵌在既有 service)

| 层 | 沿 Phase 0.7 § | Phase 2 行为 |
|---|---|---|
| **QueryService** | §4 | 新 `activities.service.listAvailableForMember(memberId, query)` / `certificates.service.listForMember(memberId, query)` **可内嵌**在既有 service;新 method 必须遵守"scope 显式 + 字段白名单 + 不内存过滤分页"铁律;当某 service 累计 ≥ 5 个 list method 时考虑抽 QueryService(沿 §4.4) |
| **PolicyService** | §6 | 报名 / 取消的业务合法性(`canRegister` / `canCancel`)**可内嵌**在 `activity-registrations.service`;必须**显式抛 BizException**(`REGISTRATION_WINDOW_CLOSED` / `ALREADY_REGISTERED` 等;沿 §6.3 铁律 3);沿 Phase 0.7 §13.2 P1 触发时单独立项 |
| **StateMachine** | §7 | 报名 / 取消的状态转移**必须**在 service 内显式校验 `from → to` 合法性,抛 `INVALID_STATE_TRANSITION` 类 BizException;**不**要求 Phase 2 抽显式 transition table(沿 §7.5);Phase 5 拆 service 时一并抽 |
| **AuditRecorder** | §8 | Phase 2 写操作沿 P0-D / P0-E / P0-F 已建立的审计范式(各 service 内显式调既有 `AuditLogsService.log()`);**不**新建 `AuditRecorder` class;写敏感字段时按既有 redact 规则;沿 §8.5 不立即抽 |
| **Effect / Workflow** | §9 | Phase 2 **不**触发新副作用(无短信 / 推送 / 异步任务诉求);沿 §9.5 不实施 |

### 7.3 大 service 不动声明(沿 [Phase 0.7 §12](code-architecture-boundary-review.md))

Phase 2 **不**拆以下大 service(各拆分时机沿 §12 表);Phase 2 新增 mobile endpoint 时**仅**新增 method,**不**改既有 method 签名:

- [`attendances.service.ts:1413`](../src/modules/attendances/attendances.service.ts) — Phase 5
- [`attachments.service.ts:885`](../src/modules/attachments/attachments.service.ts) — Phase 4 + Phase 5
- [`activity-registrations.service.ts:808`](../src/modules/activity-registrations/activity-registrations.service.ts) — Phase 5
- [`activities.service.ts:656`](../src/modules/activities/activities.service.ts) — Phase 5
- [`users.service.ts:544`](../src/modules/users/users.service.ts) — Phase 5
- [`certificates.service.ts:556`](../src/modules/certificates/certificates.service.ts) — Phase 5

---

## 8. PR 拆分方案

> 沿 [`process.md §3`](process.md):每个 PR 单独立项,**不混档**,**不混 PR**;每 PR diff < 500 行(超 500 必须拆)。

### 8.1 PR 串(P2-0 ~ P2-8)

> **v0.1 修订(2026-05-19)**:`PUT /me/password` 从原 P2-1 中**拆出**为**独立 PR P2-3**;原 P2-3 ~ P2-7 编号顺延一位为 P2-4 ~ P2-8。
> **拆分理由**:改密涉及限流(`@PasswordChangeThrottle()`)/ access token 行为 / 联动撤本人全部 refresh token / audit(`password.change.self`)/ 错误码 10005 / 10006 / P0-E zero drift 等**安全敏感面**,必须**独立评审 + 独立 e2e + 独立 contract snapshot**,**不**与基础身份 / 资料 endpoint 混在同一 PR。

| PR | 范围 | 档位 | 依赖 | 预估 diff |
|---|---|---|---|---|
| **P2-0** | **docs-freeze**:本评审稿用户拍板冻结 + Phase 2 同步引用 + `CLAUDE.md` / `AGENTS.md` §19.7 D-8 增补 | **A 档** | — | < 200 行(纯 docs)|
| **P2-1** | `/api/app/v1/me` + `/me/account` + `/me/capabilities`(共 3 endpoint)+ `AppMeResponseDto` / `AppMeAccountDto` / `AppCapabilityResponseDto` + `AppIdentityResolver` + `AppCapabilityService` + e2e | **C 档** | P2-0 | < 500 行 |
| **P2-2** | `/me/profile`(GET + PATCH;2 endpoint;沿 §5.2 #5 严格白名单 2 字段)+ `AppSelfProfileDto` / `UpdateAppSelfProfileDto` + member-profile self perspective method + e2e | **C 档** | P2-1 | < 500 行 |
| **P2-3** | **`PUT /api/app/v1/me/password`**(独立 PR;P0-D 全套铁律继承)+ `ChangeMyPasswordDto`(沿 P0-D zero drift)+ `@PasswordChangeThrottle()` 限流接入 + audit `password.change.self` + 联动撤本人全部 refresh token(`revokedReason='self-password-change'`)+ e2e(P0-D 全套 + 沿 §9.3 #14)| **C 档(沿 P0-D / P0-E)** | P2-1 | < 500 行 |
| **P2-4** | `/activities/available` + `/activities/:id`(2 endpoint)+ `AppAvailableActivityListItemDto` / `AppActivityDetailDto` + `activities.service.listAvailableForMember` + `AppActivityPresenter` + e2e | **C 档** | P2-1 | < 500 行 |
| **P2-5** | `/my/registrations` × 4(list / detail / create / cancel)+ `/my/activities`(1 endpoint;共 5 endpoint)+ App DTO × 4 + Presenter + Policy / StateMachine 内嵌 + e2e | **C 档** | P2-1 + P2-4 | **可能 > 500 行,**P2-5 PR 评审稿可考虑拆 P2-5a(读 3 endpoint)+ P2-5b(写 2 endpoint) |
| **P2-6** | `/my/attendance-records`(1 endpoint)+ `AppMyAttendanceRecordDto` + Presenter + e2e | **C 档** | P2-1 | < 300 行 |
| **P2-7** | `/my/certificates`(1 endpoint)+ `AppMyCertificateDto` + `certificates.service.listForMember` + Presenter + e2e | **C 档** | P2-1 | < 400 行 |
| **P2-8** | **收尾**:`docs/current-state.md` 回填 + handoff 段(若到 release 节奏)+ `CHANGELOG.md` Unreleased + Swagger Tag 复核 | **A 档** | P2-1 ~ P2-7 全合入 | < 200 行(docs)|

### 8.2 PR 串铁律

1. **P2-0 docs-only**:不动代码;仅文档冻结;A 档
2. **P2-1 是其余所有 PR 的硬前置**:`/me/capabilities` 与 `AppIdentityResolver` 是后续所有 endpoint 的准入基础设施;P2-1 不合入,P2-2 ~ P2-7 **不得**立项
3. **P2-3(`/me/password`)独立 PR**:虽 service 已存在 P0-D 实现,但路径迁 `/api/app/v1/me/password` 涉及限流装饰器 / audit 命名 / 联动撤 refresh 的复用与 zero drift 验证;**禁止**与 P2-1 / P2-2 合并;e2e 必须沿 P0-D 全套断言(沿 §9.3 #14)
4. **P2-4 / P2-5 顺序耦合**:P2-4 引入 `/activities/available` 与 `AppActivityPresenter`;P2-5 写动作(`POST /my/registrations`)依赖活动可用性判断(沿 §6.4 状态机),P2-4 不合入 P2-5 不立项
5. **P2-2 / P2-3 / P2-4 / P2-6 / P2-7 互不依赖**(都仅依赖 P2-1):可在 P2-1 合入后**并行**评审稿起草;**但**合入仍按用户拍板逐个串行
6. **每 PR 完成后必须用户拍板才进下一个**(沿 [`process.md §7`](process.md))
7. **每 PR 评审稿单独立项**:本评审稿**不替代** P2-N 各 PR 的独立评审稿;每 PR 启动前**必须**:
   - 复核本评审稿 + Phase 0.5 §10.2 + Phase 0.6 §1-§6 + Phase 0.7 §1-§13
   - 列出 OpenAPI snapshot diff 摘要(沿 [Phase 1 评审稿 §5](api-client-boundary-phase-1-review.md) 范式)
   - 列出**严格不做**清单(沿本评审稿 §3)
   - 用户拍板范围,不夹带

### 8.3 PR 描述模板(参考 [Phase 1 评审稿 §2.2.4 / §2.3.5](api-client-boundary-phase-1-review.md))

```markdown
## Phase 2 — PR P2-N

档位:**C 档**(沿 docs/app-api-phase-2-review.md §8.1)

## 范围
- 新增 endpoint(列表):...
- 新增 App DTO(列表):...
- 新增 service method(列表):...
- 新增 controller 文件(列表):...

## 严格不做
- 不动 prisma/schema.prisma
- 不动 migration
- 不动旧 /api/v2/* 行为
- 不动旧 /api/users/me* 行为
- 不动 Role / UserStatus / MemberStatus enum
- 不新增 Permission seed / RbacRole
- 不引入 Redis / queue / cron
- 不引入新依赖
- 不动 Phase 1A Swagger Tag
- 不实施 P2 范围外的 endpoint(沿 docs/app-api-phase-2-review.md §3)

## 准入校验
- 沿 docs/app-api-phase-2-review.md §6.1 / §6.2

## 数据可见性 / DTO 隔离
- 沿 docs/app-api-phase-2-review.md §5
- 严禁 `extends` / `Pick` / `Omit` Admin DTO 构造 App DTO

## 验收命令
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm test:e2e

## OpenAPI snapshot diff 摘要
- 新增 path:[完整列表]
- 删除 path:**0**
- 修改 path:**0**(旧 path 全不动)
- 新增 tag:[若有]

## E2E 覆盖
- 沿 docs/app-api-phase-2-review.md §9 9 个最小用例分类

## 回退方案
git revert 即可;新增 path 删除不影响旧 path
```

---

## 9. 测试要求

> 每个 Phase 2 实施 PR(P2-1 ~ P2-7)必须满足。

### 9.1 通用质量门槛(沿 [`process.md §3` C 档](process.md))

```bash
pnpm lint
pnpm typecheck
pnpm test            # unit
pnpm test:contract   # OpenAPI snapshot
pnpm test:e2e        # 含本 PR 新增 endpoint 与旧 path 兼容性
```

任一未通过 → **不**合并。

### 9.2 每个新 endpoint 必须覆盖

每个 `/api/app/v1/*` 新 endpoint 至少 **9 类** e2e 用例:

1. **success case**:正常请求(linked active member)返 200 + DTO 字段匹配 contract
2. **unauthenticated case**:无 token / 过期 token 返 401(沿 P0-E `UNAUTHORIZED=40100`)
3. **member not linked case**:`User.memberId=null` 调本 endpoint;`/me/capabilities` 返 `canUseApp=false`,其他 endpoint 走拒绝路径
4. **member inactive case**:`Member.status=INACTIVE`(或软删);capability 返 `canUseApp=false`,其他业务 endpoint 拒绝
5. **scope self case**:验证 where 子句**实际**含 `memberId = currentUser.memberId`(可通过制造"其他 member 数据"断言不可见)
6. **sensitive field not returned case**:response body 不含 L3 字段(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL);**禁止**含 `deletedAt` / `publishedBy` / `cancelledBy` 等 admin 内部字段
7. **admin-as-member case**:`ADMIN` / `SUPER_ADMIN` + linked active member 调 `/api/app/v1/my/*` 返**仅本人**数据(沿 D-5.2 + Phase 0.6 §6.9);**禁止**因 role 看到其他 member 数据
8. **contract snapshot**:本 endpoint 在 OpenAPI snapshot 中可见,字段集等于 DTO 定义
9. **path stability**:旧 path(`/api/users/me*` / `/api/v2/users/me/*` / `/api/v2/activities*` / `/api/v2/rbac/me/permissions` / `/api/v2/users/me/attendance-records`)行为**逐字不变**

### 9.3 写操作额外覆盖

`POST /my/registrations` / `PATCH /my/registrations/:id/cancel` / `PATCH /me/profile` / `PUT /me/password` 额外覆盖:

10. **duplicate submit**:对幂等性敏感的写动作(如 `POST /my/registrations` 重复报名同一活动)按 Phase 0.6 §4.4 partial unique 约束返**业务级 BizException**(`ALREADY_REGISTERED` 类)而非 P2002 透出
11. **invalid state**:状态机不允许的动作(报名已 cancel 的活动 / 取消已 pass 的报名)抛 `INVALID_STATE_TRANSITION` 类 BizException(沿 [Phase 0.7 §7.4](code-architecture-boundary-review.md));**禁止**默默 no-op
12. **not owner / not self**:访问 / 修改其他 member 持有的资源(如 `PATCH /my/registrations/:id/cancel` 用别人的 registration id)返 404(沿 [`CLAUDE.md §10`](../CLAUDE.md) 软删除 / scope 一致返"用户不存在")或 403;**禁止**透出资源存在性
13. **audit**:本写动作沿 P0-D / P0-E / P0-F 范式写 audit;`auditLog.actor` = `currentUser`;`extra` mask 敏感字段(沿 [Phase 0.6 §6.5](data-access-lifecycle-boundary-review.md))
14. **`PUT /me/password` 沿 P0-D 完整覆盖**:`OLD_PASSWORD_INVALID=10005` / `NEW_PASSWORD_SAME_AS_OLD=10006` / `@PasswordChangeThrottle()` / 改密成功撤本人全部 refresh / audit 写 `password.change.self`(沿 [`CLAUDE.md §9 P0-D / P0-E 子节`](../CLAUDE.md));**P2-3 PR**(改密独立 PR)e2e 必须沿 P0-D e2e 范式逐项断言

### 9.4 P2-0 测试要求

P2-0 是 **A 档 docs-only**;**不**要求跑 e2e;**仅**要求:
- `git diff --stat` 仅显示 `docs/*.md` + `CLAUDE.md` + `AGENTS.md` 变化
- `find src -name "*.controller.ts" | wc -l` 仍 = 25

---

## 10. 风险表

> 风险等级:**极高** / **高** / **中** / **低**。Phase 2 启动前必须每条逐项确认缓解措施已就位。

| # | 风险 | 触发条件 | 影响 | 缓解 | 阻塞 Phase 2? |
|---|---|---|---|---|---|
| 10.1 | App DTO 复用 Admin DTO | 实施者图省事 `extends UserResponseDto` / `Pick MemberResponseDto` | **极高(安全 / 合规)**;敏感字段返工;一旦上线 App 暴露字段,客户端版本占比高时**回退困难** | 沿 §5.2 #1 / Phase 0.5 §6.2 / Phase 0.7 §2.2;PR review 强制 grep `extends.*Dto` / `PickType\|OmitType\|IntersectionType.*Dto` | ✅ 是 |
| 10.2 | capability 被误当作授权证明 | 前端 / 后端任一方"信 capability,不再 check"| **极高(越权)** | 沿 §4.3 铁律 2 + D-5.3;每个写端点 service 入口**重新做完整四维校验**;PR review 强制 grep 写动作内是否有 `if (capabilities.canXxx)` 等"信前端"模式 | ✅ 是 |
| 10.3 | Admin 兼队员越权看他人数据 | service 内 `if (user.role === ADMIN) return allData` 短路 | **极高(越权 + 合规)** | 沿 §6.4 / D-5.2 / Phase 0.7 §3.3;App API where 子句**永远** `memberId = currentUser.memberId`;e2e 必含 "ADMIN 调 `/my/registrations` 期待仅本人" 用例 | ✅ 是 |
| 10.4 | 未绑定 member 的账号行为不清 | admin 未绑 / 候选未转正 / 临时编号未建模 | 中(用户体验)| 沿 §6.3 拒绝路径;P2-1 评审稿明确 `MEMBER_NOT_LINKED` 文案 / 是否上 BizCode | ⚠️ 部分(影响 P2-1 PR 评审稿)|
| 10.5 | `activities/available` 复用 admin list 逻辑 | 实施者直接调 `activities.service.list(currentUser, query)`,内部按 role 裁字段 | 高(Mixed 扩张)| 沿 §2.2;**P2-4** 必须**新增独立 method** `listAvailableForMember(memberId, query)`;PR review 强制查 `activities.service.list` 与 `listAvailableForMember` 是否**不同 method** | ✅ 是 |
| 10.6 | 报名 create / cancel 状态机不清 | service 内零散 if (`if (status === 'pending') {...}`)| 高(数据一致性)| 沿 §7.2 / Phase 0.7 §7.4;**P2-5** service 内**显式抛** `INVALID_STATE_TRANSITION` 类 BizException;每条非法 transition e2e 覆盖 | ✅ 是 |
| 10.7 | L3 敏感字段泄露 | response DTO / audit context / log 出现 `passwordHash` / `refreshToken` / `tokenHash` / `secret*` / 完整 signed URL | **极高(安全事故)** | 沿 §5.2 #3 / Phase 0.6 §2.4 / Phase 0.7 §2.2 #6;每 PR contract snapshot 自动检测;auditMeta context **永远不**写 raw L3 | ✅ 是 |
| 10.8 | User / Member 生命周期混淆 | 实施者把 `User.status=DISABLED` 与 `Member.status=INACTIVE` 当同一概念 | 高 | 沿 §6.4 / Phase 0.6 §5;P2-1 实施 `AppIdentityResolver` 时严格按 §6.1 闭包写;e2e 必含 L1 / L3 / L7 / L8 矩阵行 | ✅ 是 |
| 10.9 | contract diff 超范围 | PR 内意外改 admin DTO / 旧 path schema | 高(契约破坏)| 沿 [Phase 1 评审稿 §5](api-client-boundary-phase-1-review.md);PR 描述强制列 snapshot diff 摘要;**仅允许**新增 path / 新增 DTO;**禁止**改任何旧 path key / 旧 DTO 字段 | ✅ 是 |
| 10.10 | PR 过大难审查 | P2-5 写 + 读 5 endpoint 一起合 | 中(review 质量)| 沿 §8.2;P2-5 评审稿可考虑拆 P2-5a + P2-5b;每 PR < 500 行 | ⚠️ P2-5 启动前决议 |
| 10.11 | `/me/profile` 身份证号字段默认完整暴露 | 实施者直接返 `documentNumber` 字段 | **极高(合规)** | 沿 §5.2 #4 / Phase 0.6 §2.3;P2-2 PR 评审稿明确 `AppSelfProfileDto` 字段集**含掩码版本**(后 4 位);完整号走独立审计接口(Phase 2 不实施) | ✅ 是 |
| 10.11a | `PATCH /me/profile` 入参夹带 Member 业务字段 / Emergency contacts / Organization / Role / Permission | 实施者图省事在 `UpdateAppSelfProfileDto` 加 `realName` / `mobile` / `documentNumber` / `bloodType` / `medicalNotes` / `emergencyContact*` / `organizationId` / `departmentId` / `role` / `permissions[]` 等任一字段 | **极高(合规 + 越权)**;一旦 App 上线本人可改自己身份证 / 部门 / 角色,**安全事故**;`forbidNonWhitelisted` 兜底不足,**DTO 自身白名单**是第一道防线 | 沿 §5.2 #5 锁定的 2 字段白名单 + 完整禁止列表;PR review **强制**:① grep `UpdateAppSelfProfileDto` 类定义,断言字段集**恰好** `{nickname, avatarKey}`;② contract snapshot 中 `UpdateAppSelfProfileDto` 字段集**恰好** 2 个;③ e2e 必含"传 `documentNumber` / `realName` / `role` 任一字段 → 期待 `BAD_REQUEST` 40000"用例;独立改 Member 业务字段必须**单独立项**(沿 §5.2 #5 尾段)| ✅ 是 |
| 10.12 | 旧 path 被意外改动 | PR 内顺手调 `/api/v2/users/me/registrations` 或 `/api/users/me` 的 controller / DTO / service signature | 高(向后兼容)| 沿 §3.2;PR review 强制查 `git diff` 中是否含旧 controller 文件修改;旧 path e2e 必须**逐字通过** | ✅ 是 |
| 10.13 | 候选 / 临时编号志愿者逻辑被偷偷塞进 Phase 2 | 实施者新增 `MemberStatus` 值或在 `User.role` 之外加 status 字段 | **极高(沿 D-5.1)** | 沿 §3.2;PR review 强制查 `prisma/schema.prisma` diff;**任何** schema 改动 = D 档 = 单独立项 | ✅ 是 |
| 10.14 | Phase 2 顺手做 Phase 1B alias | 实施者觉得 `/api/auth/v1/*` 自然在 Phase 2 一起做 | 中(范围扩张)| Phase 1B 独立 PR(沿 [Phase 1 评审稿 §2.3](api-client-boundary-phase-1-review.md));Phase 2 **不**碰 `/api/auth/*` / `/api/health/*` 任何 path | ✅ 是 |
| 10.15 | Phase 2 顺手做 attachments `me/uploaded` | 实施者觉得 `/me/attachments` 属于 App 自然范围 | 中(范围扩张)| 沿 §3.2;`/api/v2/attachments/me/uploaded` Phase 2 范围**不**包含;留作 Phase 2.x 单独评审 | ✅ 是 |

---

## 11. 同步引用与文档归属

### 11.1 本评审稿被引用

本评审稿 v0 用户拍板冻结后,以下文档**必须**在 P2-0 PR 内增加 "Phase 2 implementation must read `docs/app-api-phase-2-review.md`" 提示(沿 [`process.md §6` 权威源](process.md) — 不重写既有设计,仅追加引用):

- `docs/api-client-boundary-migration-plan.md`(§4 节首加引用)
- `docs/app-permission-boundary-review.md`(§12 节末加引用)
- `docs/data-access-lifecycle-boundary-review.md`(§8 节末加引用)
- `docs/code-architecture-boundary-review.md`(§15 节末加引用)

### 11.2 本评审稿引用

本评审稿生效后,与以下文档形成 "Phase 2 实施前必读" 矩阵:

- [`docs/api-client-boundary.md`](api-client-boundary.md) — 顶层规范 + 8 铁律
- [`docs/api-client-boundary-inventory.md`](api-client-boundary-inventory.md) — 现状盘点(`/me` 端点位置 / Mixed 风险)
- [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md) — 分阶段路线(Phase 2 在 §4)
- [`docs/api-client-boundary-phase-1-review.md`](api-client-boundary-phase-1-review.md) — Phase 1 模板(PR 描述模板 / snapshot diff 验收)
- [`docs/app-permission-boundary-review.md`](app-permission-boundary-review.md) — Phase 0.5(身份 / 权限 / D-1 ~ D-4)
- [`docs/data-access-lifecycle-boundary-review.md`](data-access-lifecycle-boundary-review.md) — Phase 0.6(surface / field / scope / state / lifecycle)
- [`docs/code-architecture-boundary-review.md`](code-architecture-boundary-review.md) — Phase 0.7(代码分层 10 边界)
- [`docs/first-release-p0d-change-my-password-review.md`](first-release-p0d-change-my-password-review.md) — P0-D 改密(**P2-3** `/me/password` 沿用)
- [`docs/first-release-p0e-refresh-token-review.md`](first-release-p0e-refresh-token-review.md) — P0-E refresh token(**P2-3** 改密成功撤 refresh 沿用)
- [`docs/process.md`](process.md) — PR 分级 + D 档降速规则

### 11.3 下位评审稿(P2-N 各 PR 启动前必读)

本评审稿冻结后,P2-1 ~ P2-7 各 PR 启动前**必须**先读对应下位评审稿(若已存在);P2-N **implementation must read** 对应文件 **before code changes**:

- **P2-2** `/api/app/v1/me/profile` GET / PATCH → [`docs/app-api-p2-2-profile-review.md`](app-api-p2-2-profile-review.md)(2026-05-19 v0)
- **P2-3** `PUT /api/app/v1/me/password` → [`docs/app-api-p2-3-password-review.md`](app-api-p2-3-password-review.md)(2026-05-20 v0)。**P2-3 implementation must read `docs/app-api-p2-3-password-review.md` before code changes.**
- **P2-4** `GET /api/app/v1/activities/available` + `GET /api/app/v1/activities/:id` → [`docs/app-api-p2-4-activities-review.md`](app-api-p2-4-activities-review.md)(2026-05-20 v0)。**P2-4 implementation must read `docs/app-api-p2-4-activities-review.md` before code changes.**
- **P2-5** `GET /api/app/v1/my/activities` + `/my/registrations` × 4 → [`docs/app-api-p2-5-registrations-review.md`](app-api-p2-5-registrations-review.md)(2026-05-20 v0)。**P2-5 implementation must read `docs/app-api-p2-5-registrations-review.md` before code changes.** P2-5 拆 P2-5a(读 3 endpoint)+ P2-5b(写 2 endpoint);P2-5 implementation 必须等待 P2-4a + P2-4b 全部合入。
- P2-1 / P2-6 / P2-7 — 各 PR 启动前由用户决议是否需要独立评审稿;不需独立评审稿的 PR 直接沿本评审稿 §2 ~ §10 实施

---

## 12. 决策记录 / 验收 / 修订

### 12.1 已锁定决策(2026-05-19,沿 Phase 0.5 §10.2 + Phase 0.6 + Phase 0.7)

- ✅ 候选 / 临时编号志愿者**不进**Phase 2 App 登录范围(D-5.1)
- ✅ Admin 兼队员走 linked-member self perspective(D-5.2)
- ✅ App 暴露 capability,不暴露 raw RBAC permission code(D-5.3)
- ✅ `/me/*` 与 `/my/*` 物理拆分(D-5.4)
- ✅ App DTO 禁止 `extends` / `Pick` / `Omit` Admin DTO(Phase 0.7 §2.2)
- ✅ Mobile API 默认 `scope = self`(Phase 0.6 §3.3)
- ✅ L3 字段永不返回(Phase 0.6 §2.3)
- ✅ Phase 2 不动 schema / migration / Role / MemberStatus / Permission seed(§3.2)

### 12.2 本评审稿决议项(用户拍板时回答)

| # | 决议项 | 默认建议(沿前序评审稿) |
|---|---|---|
| 12.2.1 | Phase 2 最终接口清单是否接受 §2 表(15 个 endpoint) | ✅ 接受 |
| 12.2.2 | PR 拆分 P2-0 ~ P2-8 是否接受(§8.1;**v0.1** 把 `/me/password` 独立拆为 P2-3)| ✅ 接受 |
| 12.2.3 | P2-5 是否预拆 P2-5a / P2-5b | ⏳ P2-5 启动前再决议(基于实际 diff 行数) |
| 12.2.4 | `/me/profile` 身份证号默认掩码(沿 §5.2 #4 / §10.11) | ✅ 接受(完整号走独立审计接口,Phase 2 不实施) |
| 12.2.5 | `MEMBER_NOT_LINKED` / `MEMBER_INACTIVE` 是否新增 BizCode(沿 §4.3 #8 / §6.3) | ⏳ P2-1 评审稿决议 |
| 12.2.6 | `/me/profile` 写接口允许哪些 member 字段被本人改(沿 §5.2 #5) | ⏳ P2-2 评审稿决议 |
| 12.2.7 | `CancelAppMyRegistrationDto.note` 是否必填(沿 §5.1 表) | ⏳ P2-5 评审稿决议 |
| 12.2.8 | `/my/certificates` 是否含 `pending` / `rejected` 状态条目(让本人看自己的未通过)(沿 §5.1 `AppMyCertificateDto`) | ✅ 含(沿 Phase 0.6 §2 #2.11 AppSelf 视角"含未通过") |

### 12.3 修订规则

- 本评审稿 v0 用户拍板冻结后,**就地**修订(沿 [Phase 1 评审稿 §10](api-client-boundary-phase-1-review.md));**不**新建 v1 / v2 文档
- 每次修订记录修订时间 + 变更摘要(在本节末追加)
- P2-1 ~ P2-7 各 PR 评审稿是**独立文档**,**不**修订本评审稿;若实施过程发现本评审稿与代码冲突,**暂停**并向用户汇报

### 12.4 验收锚点

| 锚点 | 状态 |
|---|---|
| 本评审稿 v0 用户拍板冻结 | ✅ 已冻结(2026-05-19)|
| `CLAUDE.md §19.7` / `AGENTS.md §19.7` 新增 D-8 | ✅ 与 P2-0(#143)同 PR |
| 4 份相邻评审稿同步引用 | ✅ 与 P2-0(#143)同 PR |
| P2-0 docs-freeze PR | ✅ 合入(#143)|
| P2-1 ~ P2-7 实施 PR | ✅ 全部合入(#144 / #146 / #148 / #153+#154 / #155+#156 / #158 / #160;含配套评审稿 #145 / #147 / #149+#152 / #150+#151 / #157 / #159)|
| P2-8 收尾(current-state / CHANGELOG)| ✅ 本 PR 落地(docs-only;`current-state.md` §1+§2+§4 回填 + `CHANGELOG.md` Unreleased 段填充;不打 v0.15.0)|

### 12.5 修订历史

| 日期 | 版本 | 摘要 |
|---|---|---|
| 2026-05-19 | v0 | 本评审稿 v0 创建;15 个候选 endpoint + 8 PR 串 + 15 条风险表;沿 Phase 0.5 §10.2 / Phase 0.6 / Phase 0.7 全套约束 |
| 2026-05-19 | v0.1 | **修正 1**:`PUT /me/password` 从 P2-1 拆出为**独立 PR P2-3**(原 P2-3 ~ P2-7 顺延为 P2-4 ~ P2-8),沿 P0-D / P0-E 安全敏感面独立评审 + 独立 e2e;§2 PR Batch 列、§8.1 PR 串、§8.2 依赖链、§9.3 #14、§10.5 / §10.6 / §10.10、§11.2、§12.2.2 / §12.2.3 / §12.2.7、§12.3、§12.4 验收锚点、文末"过期条件"全部同步;TL;DR 第 5 条 "8 个 PR" 改为 "9 个 PR"。**修正 2**:`PATCH /me/profile` 字段白名单显式锁定 — §5.2 #5 重写为**仅允许 2 字段**(`nickname` / `avatarKey`)+ **明确禁止 6 大类**(Member 业务字段 / Emergency contacts / Organization / Department / Account / Role / Permission / Status / 审批内部字段);§10 风险表新增 10.11a(profile 字段越界,PR review 强断言 DTO 字段集恰好 2 个 + e2e 反向用例)|

---

> **本评审稿生效时间**:2026-05-19(Phase 2 实施前评审稿 v0)。
> **当前状态**:⏳ 待用户拍板冻结。
> **过期条件**:Phase 2 P2-1 ~ P2-8 全部落地后,本评审稿降为"历史评审"性质;沿 [Phase 1 评审稿 §10 / V2 红线 §5.1 handoff 历史规则](V2红线与复活路径.md)。
