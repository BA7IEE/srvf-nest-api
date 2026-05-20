# SRVF App API P2-5 Registrations & My Activities Review

> **状态**:**P2-5 实施前评审稿 v0**(2026-05-20)
> **性质**:**implementation review**(沿 [`docs/process.md §6`](process.md))。**不是代码改造,不是 migration,不是 endpoint 增减**。
> **范围**:仅评审 5 个 endpoint 的入参 / 返回 / 鉴权 / 数据源 / 状态机 / Policy / audit / 测试 / 风险。**不**起草任何代码。
>   - P2-5a 只读 3 endpoint:`GET /api/app/v1/my/registrations` / `GET /api/app/v1/my/registrations/:id` / `GET /api/app/v1/my/activities`
>   - P2-5b 写动作 2 endpoint:`POST /api/app/v1/my/registrations` / `PATCH /api/app/v1/my/registrations/:id/cancel`
> **前置必读**:
>   - [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md) §2(P2-5 在 PR Batch 列)+ §3(不做清单)+ §6(准入)+ §8.1(PR 串)+ §9(测试)+ §10(风险表)
>   - [`docs/app-api-p2-2-profile-review.md`](app-api-p2-2-profile-review.md) §6.1(`AppIdentityResolver` 准入范式)+ §7.4(显式 safeDto 范式)+ §11(风险表 10.11a 反模式)
>   - [`docs/app-api-p2-3-password-review.md`](app-api-p2-3-password-review.md) §4.6(P2-3 D-P2-3-1 = X **不**复用到 P2-5;`memberId` / `Member.status=ACTIVE` 强约必走 `AppIdentityResolver`)
>   - [`docs/app-api-p2-4-activities-review.md`](app-api-p2-4-activities-review.md) §2(D-P2-4-1 锁定 `published only`)+ §5(DTO 字段策略)+ §6(`AppActivitiesService` 物理隔离范式)+ §7(零新 BizCode + 404 vs 403 策略 D-P2-4-3)
>   - [`docs/app-permission-boundary-review.md`](app-permission-boundary-review.md) §10.2 D-1 ~ D-4(身份准入)
>   - [`docs/data-access-lifecycle-boundary-review.md`](data-access-lifecycle-boundary-review.md) §2(L0-L3 字段分级)+ §3(scope 默认 self)+ §4(状态机)+ §5(User/Member 生命周期)
>   - [`docs/code-architecture-boundary-review.md`](code-architecture-boundary-review.md) §2(DTO/Presenter)+ §3(三层授权 Action × Scope × Field × State)+ §6(PolicyService)+ §7(StateMachine)+ §8(AuditRecorder)+ §13(P0/P1 触发不立即抽 service)
>   - [`CLAUDE.md §9 / §11 / §13 / §19.7 D-5 ~ D-8`](../CLAUDE.md)
> **冲突优先级**(沿 [`docs/srvf-foundation-baseline.md §14.4`](srvf-foundation-baseline.md)):
> v1 §1-§17 / V1.1 §17 / V2 §18 / baseline / 红线 / [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md) / [`docs/app-permission-boundary-review.md`](app-permission-boundary-review.md) / [`docs/data-access-lifecycle-boundary-review.md`](data-access-lifecycle-boundary-review.md) / [`docs/code-architecture-boundary-review.md`](code-architecture-boundary-review.md) / [`docs/app-api-p2-4-activities-review.md`](app-api-p2-4-activities-review.md) > **本评审稿(§1-§17)**
> 冲突时本稿让步,**不擅自调和**。
> **解除条件**:本评审稿经用户拍板冻结后,P2-5a / P2-5b 各自实施 PR 允许在 [`docs/process.md`](process.md) §3 + §4 流程内**逐个**立项;**本评审稿不替代** P2-5a / P2-5b 各自 PR 的独立 review。

---

## 0. TL;DR(13 条)

1. **强制拆 P2-5a + P2-5b 两个独立 PR**:P2-5a 包 3 只读 endpoint(`GET /my/registrations` / `GET /my/registrations/:id` / `GET /my/activities`);P2-5b 包 2 写 endpoint(`POST /my/registrations` / `PATCH /my/registrations/:id/cancel`)。沿 [`docs/app-api-phase-2-review.md §8.1`](app-api-phase-2-review.md) line 428 + §8.2 #4;v0 **锁定**(D-P2-5-1)。
2. **P2-5 implementation 必须等 P2-4a + P2-4b 全合入后才允许立项**(D-P2-5-2)。沿 [phase-2-review.md §8.2 #4](app-api-phase-2-review.md):"P2-4 引入 `/activities/available` 与 `AppActivityPresenter`;P2-5 写动作依赖活动可用性判断,P2-4 不合入 P2-5 不立项"。
3. **`/my/activities` 纳入 P2-5a**(D-P2-5-3),**不**推迟到 P2-6;归属 `activities/` 模块下新建 `AppMyActivitiesService`(D-P2-5-4),底层查 `ActivityRegistration` join `Activity` 但对外语义归"我的活动"。
4. **App Controller 必须新建** `AppMyRegistrationsController @Controller('app/v1/my')`(D-P2-5-5);**禁止**追加方法到既有 `ActivityRegistrationsMeController`(`/v2/users/me/*`)或 `ActivityRegistrationsAdminController`(`/v2/activities/:id/registrations`)。
5. **App DTO 全部新建**(D-P2-5-6;**7 个新 DTO 文件 = 5 个核心 DTO + 2 个 Query DTO**):**禁止** `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` admin DTO 任一构造方式(**例外**:`extends PaginationQueryDto` 允许,因 `PaginationQueryDto` 来自 `common/dto/pagination.dto.ts` 跨模块公共 DTO,不是 admin 模块 DTO;沿 §8.1 #1);沿 §19.7 D-7 + Phase 0.7 §2.2 + P2-4 review §5.2 #1。
6. **5 个 endpoint 全部前置 `AppIdentityResolver.resolve(currentUser)` + `assertCanUseApp`**(D-P2-5-7):`canUseApp=true` AND linked member exists AND `Member.status=ACTIVE`;失败统一 `FORBIDDEN=40300`;**禁止**用 `@Roles(Role.USER)` 限制访问;**禁止** ADMIN 角色短路看他人数据。
7. **`POST /my/registrations` 必须前置校验活动 `statusCode='published'`**(D-P2-5-8);非 published(`draft` / `cancelled` / `completed` / 软删 / 不存在)**统一抛 `ACTIVITY_NOT_FOUND=20001`** / HTTP 404,与 P2-4 D-P2-4-1 / D-P2-4-3 侧信道防御对齐。**不**改既有 admin path 行为。
8. **`CancelAppMyRegistrationDto.cancelReason` 保持可选**(D-P2-5-9):沿 admin `CancelRegistrationDto.cancelReason?` 范式;DTO 类名独立但字段集字面一致。降低 App 用户取消摩擦。
9. **零新增 BizCode**(D-P2-5-10):全部复用既有 11 项(`ACTIVITY_NOT_FOUND=20001` / `ACTIVITY_NOT_PUBLIC_REGISTRATION=20120` / `ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN=20121` / `ACTIVITY_REGISTRATION_NOT_FOUND=21001` / `ACTIVITY_REGISTRATION_ALREADY_EXISTS=21002` / `ACTIVITY_REGISTRATION_STATUS_INVALID=21030` / `ACTIVITY_CAPACITY_EXCEEDED=21032` / `FORBIDDEN=40300` / `BAD_REQUEST=40000` / `UNAUTHORIZED=40100` / `INTERNAL_ERROR=50000`)。**禁止**开 `APP_REGISTRATION_*` / `APP_MEMBER_*` / `REGISTRATION_CANCEL_WINDOW_CLOSED` 等新段位。
10. **`registrationDeadline` 列为独立待决议项**(D-P2-5-11):**P2-5 v0 不夹带实施**;若后续启用,**必须**走 `RegistrationPolicyService`(Phase 0.7 §6 PolicyService 路径)或等价策略层;**禁止**在 controller 硬编码 deadline 判断;**禁止**与 admin path 联动改动。
11. **`extras` Json 本期不做嵌套敏感字段校验,不做 audit mask 扩展**(D-P2-5-12):沿 v2 现状用户自定义 JSON 不校验(沿 service §1.6 注释 + Q-A13);仅作为后续 P2.x 风险记录(见 §14 风险表 14.9)。
12. **P2-5 严格不夹带**(D-P2-5-13):P2-6 attendance records / P2-7 certificates / Phase 1B alias / RBAC 全面接入 / schema / migration / new BizCode 段位 / admin 旧 path 改动 / multipart Swagger 拆分 / 任何 LLM / vector / Redis / queue / cron。
13. **PR 体量**:P2-5a 预估 ~350-450 行(3 endpoint + 3 DTO + 1 new service + e2e + contract);P2-5b 预估 ~400-500 行(2 endpoint + 2 DTO + Policy/state 复用 + e2e + contract);均 **< 500 行红线**(沿 phase-2-review.md §8.1 line 423)。

---

## 1. 背景与范围

### 1.1 背景

> 本评审稿是 Phase 2 (`/api/app/v1/*` 队员端 App API)在 P2-1 / P2-2 / P2-3 / P2-4(评审稿)四档已落地后,**面向报名 / 我的活动业务面**的实施前评审。

P2-1(`/me` + `/me/account` + `/me/capabilities`,PR [#144 `58aac2f`](https://github.com/) commit)、P2-2(`/me/profile` GET + PATCH,PR [#146 `5b5d59e`](https://github.com/) commit)、P2-3(`/me/password`,PR [#148 `6603667`](https://github.com/) commit)与 P2-4 review(PR [#149 `c3c4db9`](https://github.com/) commit)已建立完整的 App 身份准入基础设施:

- `AppIdentityResolver.resolve(currentUser)`:统一返回 `{ canUseApp, reason, member }` 三元组(沿 [`src/modules/users/app-identity.resolver.ts`](../src/modules/users/app-identity.resolver.ts))
- `AppCapabilityService`:product-level capability map(沿 [`src/modules/users/app-capability.service.ts`](../src/modules/users/app-capability.service.ts))
- `AppMeController @Controller('app/v1/me')` 物理隔离范式(沿 [`src/modules/users/controllers/app-me.controller.ts`](../src/modules/users/controllers/app-me.controller.ts))
- App DTO 物理目录 `dto/app/`(沿 [`src/modules/users/dto/app/`](../src/modules/users/dto/app/))
- 零新增 BizCode + 零 schema / migration(P2-1 ~ P2-3 全期保持)
- P2-4 v0.1 锁定 `published only` 可见性(D-P2-4-1)+ 404 vs 403 防侧信道(D-P2-4-3)+ `AppActivitiesService` 独立 service 物理隔离(D-P2-4-4)

P2-5 是 Phase 2 阶段**业务面最大**的一档:
- 唯一同时包含**读 + 写动作 + 状态机 + Policy + capacity race + audit + partial unique 约束**的 PR 串
- 业务模型最复杂(registration 4 态闭集 + Activity 4 态 + Member 2 态生命周期)
- 现有 admin path 已经接近完整覆盖(沿 [`src/modules/activity-registrations/activity-registrations.service.ts`](../src/modules/activity-registrations/activity-registrations.service.ts) 808 行;批次 3A 决议表 v1.0 全部锁定)
- 本评审稿核心使命:**严格隔离 App surface,大量 thin-wrap 复用既有 service,杜绝 admin DTO 漏 App / capability 被当授权 / role 短路看他人 三大类反模式**

### 1.2 范围

**本评审稿范围**:仅评审 P2-5a + P2-5b 共 **5 个 endpoint** 的实施前所有决议项;明确 PR 拆分策略 + Controller / Service 归属 + DTO 字段集 + BizCode 复用矩阵 + 状态机 + Policy + Audit + 测试 + 风险 + 禁止事项 + 待决议项。

**本评审稿不实施任何东西**:不改 schema / Role / MemberStatus / Permission seed / 任何 endpoint / 任何 DTO / 任何 controller / 任何测试。

### 1.3 不在范围

| 不在范围 | 推迟到 / 沿用 |
|---|---|
| `/api/app/v1/my/attendance-records` | P2-6 单独立项 |
| `/api/app/v1/my/certificates` | P2-7 单独立项 |
| `/api/app/v1/me/*` 任何 endpoint | P2-1 / P2-2 / P2-3 已完成 |
| `/api/app/v1/activities/available` / `/api/app/v1/activities/:id` | P2-4(review v0.1 已合入,implementation 待启动) |
| `/api/auth/v1/*` / `/api/public/v1/*` alias | Phase 1B 独立通道 |
| Admin path(`/api/v2/activities/:id/registrations/*` + `/api/v2/users/me/registrations/*`)| 沿 Phase 2 review §3.2 line 161:"不动 `/api/v2/users/me/*` 4 个旧 path";**零修改** |
| `registrationDeadline` 强约 | D-P2-5-11 待决议;P2-5 v0 不做 |
| Recruiting / Onboarding(候选 / 临时编号志愿者) | D-5.1 锁定不进 Phase 2 |
| Tasks / Managed 命名空间 | Phase 2 review §3.1 锁定 Phase 2 不实施 |
| RBAC 收紧 | P0-F 独立通道 |
| schema / migration / Permission seed / Role enum 改动 | A-3 / A-4 红线 + Phase 2 review §3.2 |
| 微信小程序登录 / OAuth 第三方 / 找回密码 | Phase 2 review §3.1 line 147 锁定 Phase 2 不实施 |

---

## 2. 与 Phase 2 顶层评审稿的关系

### 2.1 引用矩阵

| Phase 2 review 章节 | 本评审稿位置 | 关系 |
|---|---|---|
| §2 接口清单 line 100-104(`/my/activities` / `/my/registrations` × 4)| §5 接口表 | **保留 5 endpoint 全集**;细化 query / DTO / service 落地 |
| §3.1 不实施 / §3.2 不动 | §15 禁止事项 | 全部继承 + 加 P2-5 特化条款 |
| §5.2 #1 ~ #10 DTO 铁律 | §8 DTO 字段集 | 字面继承 |
| §6.1 准入硬约束 | §7 identity / permission / ownership | 继承 + 给出 5 endpoint 准入矩阵 |
| §6.2 各 endpoint 准入要求 | §7.2 | 继承 + 与 D-P2-5-7 对齐 |
| §6.3 拒绝路径 | §7.3 | 继承 + 沿 P2-2 / P2-4 `FORBIDDEN` 临时复用 |
| §6.4 状态机层叠语义 | §10 状态机 | 继承 + 给出 registration 4 态机 |
| §7.1 ~ §7.3 Query / Presenter / Policy 落地 | §6 controller/service + §10 + §11 | 继承 + 沿 P2-4 私有 mapper 范式 |
| §8.1 PR 串 P2-5 | §17 PR 拆分 + D-P2-5-1 | **强制拆 P2-5a + P2-5b**(把 §8.1 "可考虑"升级为"强制") |
| §8.2 #4 顺序耦合 | §3 P2-4 依赖 + D-P2-5-2 | 字面继承 |
| §9.2 9 类 + §9.3 写专项 | §13 测试 | 继承 + 给出 5 endpoint 用例分类 |
| §10 风险表 10.1 ~ 10.15 | §14 风险表 | 继承 + 加 P2-5 特化风险 14.16 ~ 14.20 |
| §11.3 P2-5 是否独立评审稿 | 本评审稿 = 答 ✅ | 本评审稿即是 |
| §12.2.3 P2-5 是否预拆 | D-P2-5-1 = ✅ 预拆 | **本评审稿锁定** |
| §12.2.7 `CancelAppMyRegistrationDto.note` 是否必填 | D-P2-5-9 = ❌ 可选 | **本评审稿锁定** |

### 2.2 引用同步要求

> 沿 Phase 2 review §11.3:**P2-5 implementation must read `docs/app-api-p2-5-registrations-review.md` before code changes.**

**本评审稿冻结后**(P2-5a docs-only PR 合入后),Phase 2 review §11.3 应同步增补:

```diff
- P2-1 / P2-5 / P2-6 / P2-7 — 各 PR 启动前由用户决议是否需要独立评审稿
+ - **P2-5** `/my/registrations` × 4 + `/my/activities`(1)→ `docs/app-api-p2-5-registrations-review.md`(2026-05-20 v0)。**P2-5 implementation must read `docs/app-api-p2-5-registrations-review.md` before code changes.**
+ - P2-1 / P2-6 / P2-7 — 各 PR 启动前由用户决议是否需要独立评审稿
```

**该 diff 由本评审稿冻结后的下一个 docs PR 顺手做**,**不**夹带本评审稿 PR(沿 process.md A 档不混档)。

---

## 3. 与 P2-4 的依赖关系

### 3.1 依赖关系图

```
P2-1 ✅(P2-5 准入基础设施)
    ↓
P2-4 review ✅(`/activities/available` + `/activities/:id` 可见性 + service 物理隔离范式)
    ↓
P2-4a impl ❌(`/activities/available` + service 骨架)
    ↓
P2-4b impl ❌(`/activities/:id` + 完整 Presenter)
    ↓ 全合入(硬前置;D-P2-5-2)
    ┌────────────────┐
    ↓                ↓
P2-5a impl(读 3)    [可并行起草 P2-6 / P2-7 评审稿]
    ↓
P2-5b impl(写 2)
    ↓
[P2-6 impl / P2-7 impl 各自依赖 P2-1,与 P2-5 独立]
    ↓
P2-8 收尾
```

### 3.2 P2-5 依赖 P2-4 的具体原因

| 依赖项 | P2-4 提供 | P2-5 复用 |
|---|---|---|
| App 视角 published only 可见性铁律 | D-P2-4-1 锁定方案 A | `POST /my/registrations` 报名前活动状态校验(D-P2-5-8 与 D-P2-4-1 对齐)|
| 404 vs 403 防侧信道范式 | D-P2-4-3 锁定 | 报名 / 取消时活动 / registration 不可见 → 404;沿同范式(§7.3 / §9 / §14)|
| `AppActivitiesService` 独立 service 物理隔离 | D-P2-4-4 锁定方案 B(新建)| `AppMyActivitiesService` 沿同范式(D-P2-5-4 / §6.2)|
| App DTO 物理目录 `dto/app/` | `src/modules/activities/dto/app/app-activity-detail.dto.ts` | `AppMyActivityListItemDto` 落同目录;`AppMyRegistration*` 落 `src/modules/activity-registrations/dto/app/`(§6.3.2)|
| App Controller 物理隔离范式 | `AppActivitiesController @Controller('app/v1/activities')` | `AppMyRegistrationsController @Controller('app/v1/my')`(§6.1)|
| 私有 mapper(`toListItemDto` / `toDetailDto`)沿 P0/P1 过渡 | P2-4 §8.2 决议 D-P2-4-4(不抽 Presenter class)| P2-5 私有 mapper 范式沿同(§6.4)|
| `AppIdentityResolver` 准入接入范式 | P2-4 §6.1 准入硬约束 line 251 + §6.2 admin-without-member | P2-5 全 5 endpoint 准入沿同(D-P2-5-7;§7)|
| 零新 BizCode 范式 | P2-4 §7.1 / §7.2 | D-P2-5-10 锁定零新 BizCode |

### 3.3 P2-5 必须等 P2-4a + P2-4b 全合入的硬理由

- ✅ **P2-4 impl 落地的 `AppActivitiesService` + `AppActivityDetailDto` / `AppAvailableActivityListItemDto` 文件** 必须存在,P2-5 review snapshot 才与 P2-4 字段集对齐;不合入会出现"评审稿引用未存在文件"
- ✅ **P2-4 impl 落地的 `AppActivitiesController` 路由表** 必须先到位,P2-5 `/my/activities` 才知道**不与** `/activities/available` 路径冲突(两者不同 controller,但 `app/v1` 前缀共享)
- ✅ **P2-4 v0.1 锁定的 `published only` + 404 防侧信道**必须实施验证,P2-5 D-P2-5-8 才能验收"`POST /my/registrations` 报 draft 活动返 404"用例与 P2-4 行为对齐
- ✅ P2-5b `POST /my/registrations` 与 P2-4 `GET /activities/available` 是"我看到 X 活动 → 我报名 X 活动"完整闭环;P2-4 不合入,P2-5b e2e 必须 mock `published` 活动,易脱漂移

---

## 4. P2-5a / P2-5b 拆分决议(D-P2-5-1)

### 4.1 决议

**D-P2-5-1 = 强制拆**:P2-5 拆为 P2-5a(只读 3 endpoint)+ P2-5b(写 2 endpoint)两个独立实施 PR。

### 4.2 拆分映射

| Endpoint | PR | 类型 | 风险 |
|---|---|---|---|
| `GET /api/app/v1/my/registrations` | **P2-5a** | 只读 | 中(DTO 隔离 + scope self) |
| `GET /api/app/v1/my/registrations/:id` | **P2-5a** | 只读 + owner | 中(DTO 隔离 + owner 校验) |
| `GET /api/app/v1/my/activities` | **P2-5a** | 只读 + 派生汇总 | 中(派生 `myRegistrationStatusCode` 取值规则)|
| `POST /api/app/v1/my/registrations` | **P2-5b** | 写 + 事务 + capacity race + Policy + 状态机 + audit | **极高** |
| `PATCH /api/app/v1/my/registrations/:id/cancel` | **P2-5b** | 写 + 事务 + 状态机 + owner + audit | 高 |

### 4.3 拆分理由(沿 [`docs/process.md §3`](process.md) 不混档)

| 维度 | P2-5a | P2-5b |
|---|---|---|
| **审查重点** | DTO 字段集 + admin DTO 反复用 + `/my/activities` 派生取值规则 + scope self | 状态机完整性 + capacity race + 并发安全 + audit context 完整性 + Policy 复用 + owner 反越权 |
| **新核心 DTO** | 3:`AppMyRegistrationListItemDto` / `AppMyRegistrationDto` / `AppMyActivityListItemDto` | 2:`CreateAppMyRegistrationDto` / `CancelAppMyRegistrationDto` |
| **新 Query DTO**(`extends PaginationQueryDto`) | 2:`ListAppMyRegistrationsQueryDto` / `ListAppMyActivitiesQueryDto` | 0 |
| **新 DTO 文件总计** | **5** | **2** |
| **新 service method** | 3(只读;1 真新逻辑 `listMyActivities`,2 thin-wrap)| 2(写;均 thin-wrap 复用既有 `createMy` / `cancelMy` 但需 App 准入前置)|
| **新 service file** | 1:`AppMyActivitiesService`(新建)| 0(复用既有 `ActivityRegistrationsService` 或包薄壳;待 §6.2 决议)|
| **事务 / 状态机 / Policy / audit** | 无 | ✅ 全套 |
| **限流** | 无(沿 default throttler) | 无(沿 default throttler;**不**为 App `POST /my/registrations` 开独立 throttler;D-P2-5-7.3)|
| **预估 diff** | 350-450 行 | 400-500 行 |
| **e2e 用例** | ~25-30 | ~30-40 |
| **contract snapshot** | 新增 3 path + 3 DTO | 新增 2 path + 2 DTO |
| **回退粒度** | 独立 git revert,**不**影响写路径 | 独立 git revert,**不**影响读路径 |

### 4.4 不混档铁律

- ❌ **禁止**单 PR 合并 P2-5a + P2-5b(预估合并后 750-950 行,超 [phase-2-review.md §8.1 line 423](app-api-phase-2-review.md) "每 PR diff < 500 行"红线)
- ❌ **禁止** P2-5a 内提前实施 `CreateAppMyRegistrationDto` / `CancelAppMyRegistrationDto`(留 P2-5b)
- ❌ **禁止** P2-5b 内实施 `/my/activities`(留 P2-5a)
- ❌ **禁止**任一 PR 顺手实施 P2-6 / P2-7 / Phase 1B / RBAC 收紧任何动作

### 4.5 P2-5a 与 P2-5b 串行要求

- **P2-5a 必须先合入,P2-5b 才允许立项**:沿 [phase-2-review.md §8.2](app-api-phase-2-review.md) #5 "P2-5a / P2-5b 各 PR 启动前由用户拍板"
- **P2-5a 评审稿可独立起草**,**但** P2-5b 评审稿(若与本评审稿分拆)需在 P2-5a 合入后再启动(沿 process.md §7 不自动启动下一 PR)
- **本评审稿**(v0)同时覆盖 P2-5a + P2-5b 决议项,**不**拆为两份独立评审稿(沿 P2-4 review 同时覆盖 P2-4a + P2-4b 范式)

---

## 5. API endpoint 草案

### 5.1 路径设计(沿 §19.7 D-5.4 / [`docs/app-permission-boundary-review.md §10.2 D-4`](app-permission-boundary-review.md))

```txt
GET    /api/app/v1/my/registrations              ← 我的报名列表(分页 + 可选 statusCode filter)
GET    /api/app/v1/my/registrations/:id          ← 我的某条报名详情
GET    /api/app/v1/my/activities                 ← 我已报名 / 已参与的活动汇总(分页 + 可选 registrationStatusCode filter)
POST   /api/app/v1/my/registrations              ← 本人报名(入参带 activityId + 可选 extras)
PATCH  /api/app/v1/my/registrations/:id/cancel   ← 取消本人报名(入参可选 cancelReason)
```

**沿 D-P2-5-5**:`/my/*` = "我的业务记录";`registration` / `activity`(我已报名)归 `/my/*`,**不**归 `/me/*`(后者是 identity / account / profile / capability)。

**沿 Phase 2 review §2 line 103 + 本评审稿**:`POST` 不用嵌套子资源形态 `POST /my/activities/:id/registrations`,改为平铺 `POST /my/registrations`(入参 `activityId` 在 body)。
理由:
- 一致性:`/my/*` 平铺语义,与 `/my/registrations/:id` 命名空间统一
- 减少路径段:App 端 URL 长度 / 路由表复杂度更低
- 与 admin 嵌套 `POST /v2/activities/:activityId/registrations` 物理隔离,语义上 App 是"本人主动报名某活动",admin 是"管理某活动下的报名集合"

### 5.2 接口表

| Method | Path | PR | Surface | Scope | Auth | DTO 入参 | DTO 出参 | Service | Risk |
|---|---|---|---|---|---|---|---|---|---|
| GET | `/api/app/v1/my/registrations` | **P2-5a** | mobile | self(强约 `memberId = currentUser.memberId`)| `JwtAuthGuard` + `AppIdentityResolver.resolve` + `assertCanUseApp` | `ListAppMyRegistrationsQueryDto`(`page` / `pageSize` / 可选 `statusCode`)| `PageResultDto<AppMyRegistrationListItemDto>` | 复用 `ActivityRegistrationsService.listMy` + Mobile mapper | 中 |
| GET | `/api/app/v1/my/registrations/:id` | **P2-5a** | mobile | self + owner | 同上 | `IdParamDto` | `AppMyRegistrationDto` | 复用 `ActivityRegistrationsService.findMy` + Mobile mapper | 中 |
| GET | `/api/app/v1/my/activities` | **P2-5a** | mobile | self | 同上 | `ListAppMyActivitiesQueryDto`(`page` / `pageSize` / 可选 `registrationStatusCode`)| `PageResultDto<AppMyActivityListItemDto>` | **新** `AppMyActivitiesService.listForMember(memberId, query)` | **高(新逻辑 + 派生取值)** |
| POST | `/api/app/v1/my/registrations` | **P2-5b** | mobile | self | 同上 | `CreateAppMyRegistrationDto`(必填 `activityId` + 可选 `extras`)| `AppMyRegistrationDto` | 复用 `ActivityRegistrationsService.createMy(activityId, { extras }, currentUser, auditMeta)` + **前置 `assertActivityPublishedOrThrow`**(D-P2-5-8) | **极高** |
| PATCH | `/api/app/v1/my/registrations/:id/cancel` | **P2-5b** | mobile | self + owner | 同上 | `IdParamDto` + `CancelAppMyRegistrationDto`(可选 `cancelReason`)| `AppMyRegistrationDto` | 复用 `ActivityRegistrationsService.cancelMy` | 高 |

### 5.3 路径稳定性铁律

- ❌ **不动** 旧 `/v2/users/me/activities/:activityId/registration`(POST;`ActivityRegistrationsMeController.createMy`)
- ❌ **不动** 旧 `/v2/users/me/registrations`(GET;`ActivityRegistrationsMeController.listMy`)
- ❌ **不动** 旧 `/v2/users/me/registrations/:id`(GET;`ActivityRegistrationsMeController.findMy`)
- ❌ **不动** 旧 `/v2/users/me/registrations/:id/cancel`(PATCH;`ActivityRegistrationsMeController.cancelMy`)
- ❌ **不动** 旧 `/v2/activities/:activityId/registrations`(POST/GET;admin)
- ❌ **不动** 旧 `/v2/activities/:activityId/registrations/:id/approve`(PATCH;admin)
- ❌ **不动** 旧 `/v2/activities/:activityId/registrations/:id/reject`(PATCH;admin)
- ❌ **不动** 旧 `/v2/activities/:activityId/registrations/:id/cancel`(PATCH;admin)
- ❌ **不动** 旧 `/v2/activities/:activityId/registrations/export`(GET;admin CSV)

**沿 Phase 2 review §3.2 + P2-4 review §6 P2-4 不动 admin path 范式**;PR review 强查 `git diff --stat` 与 `git diff src/modules/activity-registrations/activity-registrations.controller.ts` **必须无变化**(P2-5a / P2-5b 全期保持)。

---

## 6. Controller / Service 归属方案

### 6.1 Controller 归属(D-P2-5-5)

**新建** `AppMyRegistrationsController @Controller('app/v1/my')`:

- 物理路径:`src/modules/activity-registrations/controllers/app-my-registrations.controller.ts`(沿 `src/modules/users/controllers/app-me.controller.ts` 范式;**新建** `controllers/` 子目录)
- 5 endpoint 全部挂在此 Controller(P2-5a 3 个 + P2-5b 2 个)
- `@ApiTags('Mobile - My Registrations')` + `@ApiTags('Mobile - My Activities')`(`/my/activities` 单独打 Tag;沿 P2-1 `@Get('capabilities')` 单独打 `@ApiTags('Mobile - Capabilities')` 范式)
- `@ApiBearerAuth()`(全 5 endpoint)
- **不挂** `@Roles(...)`(沿 P2-2 / P2-3 / P2-4 范式;App endpoint 不用 `Role` 短路;ADMIN 兼队员可用走 `AppIdentityResolver`)
- **不挂** `@Public()`(全部要登录)
- **不挂** 限流装饰器(沿 default throttler;D-P2-5-7.3)

### 6.2 Service 归属(D-P2-5-4)

| Service | 状态 | 范围 | 物理位置 |
|---|---|---|---|
| `ActivityRegistrationsService` | **现有,不改签名** | 复用 `listMy` / `findMy` / `createMy` / `cancelMy`;**仅在 P2-5b 新增 1 个 private helper `assertActivityPublishedOrThrow(activityId, tx)`** 沿 D-P2-5-8 | [`src/modules/activity-registrations/activity-registrations.service.ts`](../src/modules/activity-registrations/activity-registrations.service.ts) |
| `AppMyActivitiesService` | **新建** | `listForMember(memberId, query)`:返"我已建立 registration 关系的活动汇总";底层 join `ActivityRegistration` × `Activity` | `src/modules/activities/app-my-activities.service.ts`(沿 P2-2 `AppProfileService` / P2-4 `AppActivitiesService` 同模块顶层范式)|
| `AppIdentityResolver` | **现有,不改** | 5 endpoint 全部前置注入 + 调用 | `src/modules/users/app-identity.resolver.ts` |

### 6.3 Module 归属

#### 6.3.1 `ActivityRegistrationsModule`(`src/modules/activity-registrations/activity-registrations.module.ts`)

- 追加 `AppMyRegistrationsController` 到 `controllers[]`
- `providers[]` 不变(`ActivityRegistrationsService` 已存在)
- imports 增加 `UsersModule`(若未已 import,沿 P2-4 `ActivitiesModule` 引入 `UsersModule` 取 `AppIdentityResolver` 范式)— **本评审稿不锁是否 already imported**;P2-5a PR 实施时再核

#### 6.3.2 `ActivitiesModule`(`src/modules/activities/activities.module.ts`)

- `providers[]` 追加 `AppMyActivitiesService`
- imports 不变(`PrismaService` 已存在)

#### 6.3.3 DTO 物理目录

| DTO | 物理位置 |
|---|---|
| `AppMyRegistrationListItemDto` | `src/modules/activity-registrations/dto/app/app-my-registration-list-item.dto.ts` |
| `AppMyRegistrationDto` | `src/modules/activity-registrations/dto/app/app-my-registration.dto.ts` |
| `CreateAppMyRegistrationDto` | `src/modules/activity-registrations/dto/app/create-app-my-registration.dto.ts` |
| `CancelAppMyRegistrationDto` | `src/modules/activity-registrations/dto/app/cancel-app-my-registration.dto.ts` |
| `ListAppMyRegistrationsQueryDto` | `src/modules/activity-registrations/dto/app/list-app-my-registrations-query.dto.ts` |
| `AppMyActivityListItemDto` | `src/modules/activities/dto/app/app-my-activity-list-item.dto.ts` |
| `ListAppMyActivitiesQueryDto` | `src/modules/activities/dto/app/list-app-my-activities-query.dto.ts` |

**铁律(沿 [Phase 0.7 §2.3 / §6.3](code-architecture-boundary-review.md))**:每个模块**独立** `dto/app/` 目录;**禁止**跨模块共用;**禁止**新建项目级 `dto/app/` 公共目录。

### 6.4 私有 mapper(沿 [P2-4 §8.3](app-api-p2-4-activities-review.md) 决议 D-P2-4-4 P0/P1 过渡)

| Service | 私有 mapper |
|---|---|
| `AppMyRegistrationsController`(via controller mapper helper)| **不放 controller**;放在 `AppMyRegistrationsService`(若新建)或 inline 在 controller 内私有 method `toAppListItemDto(row)` / `toAppDetailDto(row)`(沿 P2-2 `AppProfileService` 私有 mapper 范式)|
| `AppMyActivitiesService` | 私有 `toAppListItemDto(row)`:Prisma row → `AppMyActivityListItemDto`;映射 join 后的 activity + registration 字段 |

> **决议待定**(see §16 #16.2):mapper 是放在 controller 还是放在 thin-wrapping service。本评审稿**推荐**新建 **薄壳 `AppMyRegistrationsService`** 承载 mapper + `AppIdentityResolver` 前置调用 + `assertActivityPublishedOrThrow` 调用 + thin-wrap 既有 `ActivityRegistrationsService`;controller 只做 `@Body` / `@Param` / `@Query` / `@CurrentUser` / `@Req` 收集 + service 调用。

### 6.5 复用既有基础设施

| 复用项 | 来源 |
|---|---|
| `AppIdentityResolver.resolve(currentUser)` | [`src/modules/users/app-identity.resolver.ts`](../src/modules/users/app-identity.resolver.ts) — 沿 P2-2 / P2-4 注入 |
| `notDeletedWhere` | `common/prisma/soft-delete.util` — 直接 import |
| `PaginationQueryDto` / `PageResultDto<T>` / `IdParamDto` | `common/dto/*` — 直接 import |
| `BizException` / `BizCode` | `common/exceptions/*` — 直接 import |
| `buildAuditMeta(req)` helper | 沿 P2-3 `app-me.controller.ts:200-206` 复制范式 — 第三次复用仍复制不抽(沿 P2-3 决议 α) |
| `JwtAuthGuard` / `RolesGuard` 全局 | `AppModule` `APP_GUARD` 已注册 — 自动鉴权 |
| `ResponseInterceptor` 全局 | 自动包装 `{ code, message, data }` |
| `AllExceptionsFilter` 全局 | 自动处理 `BizException` → BizCode httpStatus |

---

## 7. App identity / permission / ownership 规则(D-P2-5-7)

### 7.1 准入硬约束(5 endpoint 全适用)

| 检查项 | 来源 | 失败行为 |
|---|---|---|
| `JwtAuthGuard.canActivate` | 全局 Guard(沿 [`CLAUDE.md §8`](../CLAUDE.md))| token 无效 / 过期 / user 软删 / `DISABLED` → `UNAUTHORIZED=40100` / HTTP 401 |
| `AppIdentityResolver.resolve(currentUser).canUseApp === true` | [`src/modules/users/app-identity.resolver.ts`](../src/modules/users/app-identity.resolver.ts) | `false` → `BizException(FORBIDDEN)` / HTTP 403(沿 P2-2 §6.1 + P2-4 §6.1 范式) |
| `Member.status === ACTIVE` AND `Member.deletedAt IS NULL` | `AppIdentityResolver` 内部已统一处理 | 失败 → `canUseApp=false` → 同上 |
| `User.memberId !== null` | `AppIdentityResolver` 内部已统一处理 | `null` → `canUseApp=false` → 同上 |

### 7.2 各 endpoint 准入要求矩阵

| Endpoint | JwtAuthGuard | canUseApp=true | linked member | Member.status=ACTIVE | Owner 校验 | State machine | Policy(可报名)|
|---|---|---|---|---|---|---|---|
| `GET /my/registrations` | ✅ | ✅ | ✅ | ✅ | 隐式(`memberId = currentUser.memberId`)| — | — |
| `GET /my/registrations/:id` | ✅ | ✅ | ✅ | ✅ | ✅ 显式(`registration.memberId === currentUser.memberId`,否则 `ACTIVITY_REGISTRATION_NOT_FOUND` 404)| — | — |
| `GET /my/activities` | ✅ | ✅ | ✅ | ✅ | 隐式(同上)| — | — |
| `POST /my/registrations` | ✅ | ✅ | ✅ | ✅ | — | — | ✅ `assertActivityPublishedOrThrow` + 复用 `assertActivityRegistrable` + `assertCapacityNotExceeded` + `assertNoActiveRegistration` |
| `PATCH /my/registrations/:id/cancel` | ✅ | ✅ | ✅ | ✅ | ✅(沿 `ActivityRegistrationsService.cancelMy` 内部 owner 校验) | ✅ `pending\|pass → cancelled`;其他状态抛 `21030` | — |

### 7.3 拒绝路径设计

**统一走 `FORBIDDEN=40300`**(沿 P2-2 §6.1 / P2-4 §6.1 范式):
- `canUseApp=false`(未绑定 / 未激活 / 软删 member) → `BizException(BizCode.FORBIDDEN)`(HTTP 403)
- message 文案统一 "App 功能不可用:未绑定队员档案" / "App 功能不可用:队员档案已停用"(沿 Phase 2 review §6.3)
- reason 字符串(`MEMBER_NOT_LINKED` / `MEMBER_INACTIVE` / `MEMBER_DELETED`)在 `GET /me/capabilities`(P2-1)`account.reason` 暴露;**本评审稿不在 P2-5 endpoint 返 reason**
- **不**为 P2-5 引入 `APP_MEMBER_NOT_LINKED` / `APP_MEMBER_INACTIVE` 等新 BizCode(沿 D-P2-5-10)

### 7.4 D-P2-3-1 例外不复用(强约束)

- P2-3 `D-P2-3-1 = X` 锁定的 admin-without-member 例外**严格仅**适用 `PUT /api/app/v1/me/password`(沿 [`docs/app-api-p2-3-password-review.md §4.6`](app-api-p2-3-password-review.md))
- **P2-5 5 endpoint 全部不复用此例外**:报名 / 取消 / 查报名 / 查我的活动**都是 member-domain 业务数据**,与账号级改密语义完全不同
- Admin 无 `memberId` 关联 → P2-5 全 5 endpoint → `FORBIDDEN=40300`(沿 P2-4 §6.2 line 256 范式)

### 7.5 admin-as-member 处理

- `ADMIN` / `SUPER_ADMIN` 有 `memberId != null` AND `Member.status=ACTIVE` → `canUseApp=true` → P2-5 走 **linked-member self perspective**
- 看到的数据 / 可操作范围 = 与普通 `USER` 兼队员看到的**完全一致**(沿 §19.7 D-5.2 + Phase 0.6 §6.9)
- 例:Admin 兼队员调 `/my/registrations` 返**仅本人**报名,**不**会因 `role=ADMIN` 看到其他人

### 7.6 ADMIN 角色短路禁止(铁律)

- ❌ **禁止** service / controller 内 `if (currentUser.role === Role.ADMIN) where.memberId = undefined` / 任何 role 短路
- ❌ **禁止**用 `Role.USER` 在 `@Roles(...)` 限制访问(P2-5 全 5 endpoint **不挂** `@Roles`)
- ✅ App API where 子句**永远**用 `currentUser.memberId` 锁定本人范围(沿 §19.7 D-6 + Phase 0.7 §3.3)
- ✅ owner 校验由 service 内 `if (row.memberId !== currentUser.memberId) throw NOT_FOUND` 显式做(沿 `findMy` / `cancelMy` 现状)

### 7.7 Owner 校验铁律

| 场景 | 行为 |
|---|---|
| `GET /my/registrations/:id` 命中他人 registration | `ACTIVITY_REGISTRATION_NOT_FOUND=21001` / HTTP 404(沿 `findMy:638-641` 既有范式)|
| `PATCH /my/registrations/:id/cancel` 命中他人 registration | 同上(沿 `cancelMy:660-662`)|
| `GET /my/registrations/:id` 命中本人已软删 registration | `ACTIVITY_REGISTRATION_NOT_FOUND=21001` / HTTP 404(沿 `notDeletedWhere` 统一过滤)|

**不**走 `FORBIDDEN=40300` 区分"存在但非本人"vs"不存在":统一 404 防侧信道(沿 [`CLAUDE.md §10`](../CLAUDE.md) 软删 + Phase 0.6 §6.7)。

---

## 8. DTO 字段集(D-P2-5-6)

### 8.1 字段策略铁律(沿 [§19.7 D-7](../CLAUDE.md) + [Phase 0.6 §2.4](data-access-lifecycle-boundary-review.md) + [Phase 0.7 §2.2](code-architecture-boundary-review.md) + [P2-4 §5.2 #1](app-api-p2-4-activities-review.md))

> **`extends PaginationQueryDto` 例外说明(读者提前提示)**:本节 #1 禁止 `extends` admin DTO,**但 `extends PaginationQueryDto` 允许**,因为 `PaginationQueryDto` 来自 [`common/dto/pagination.dto.ts`](../src/common/dto/pagination.dto.ts) 是**跨模块公共 DTO**,**不是** admin 模块 DTO(沿 P2-4 范式 + Phase 0.6 §2.4 公共 DTO 例外)。§8.2.4 line 549 / 568 中 `ListAppMyRegistrationsQueryDto extends PaginationQueryDto` / `ListAppMyActivitiesQueryDto extends PaginationQueryDto` 是符合规则的写法,**不**违反本节 #1。

1. ❌ **禁止** `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` / `mapped-types` 任一构造方式复用 admin DTO(`ActivityRegistrationResponseDto` / `ActivityRegistrationListItemDto` / `CancelRegistrationDto` / `CreateMyRegistrationDto` / `CreateRegistrationDto` / `ListMyRegistrationsQueryDto` / `ListRegistrationsQueryDto` / `ActivityResponseDto` / `ActivityListItemDto`);**唯一允许例外**:`extends PaginationQueryDto`(沿本节顶部例外说明 + §8.2.4)
2. ❌ **禁止**把 Prisma model 类型(`ActivityRegistration` / `Activity` / `Member`)直接作为 controller response contract
3. ✅ **允许**字段集 ≤ L2(本人)(沿 [Phase 0.6 §2.3](data-access-lifecycle-boundary-review.md))
4. ❌ L3 字段(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL)**永远不出现**
5. ✅ **可返**本人 reject 解释(`reviewNote` — L1 对本人)、本人取消理由(`cancelReason` — L1 对本人)、本人自定义 Json(`extras` — L0)
6. ❌ **禁止返** admin 内部字段(`reviewedBy` / `cancelledByUserId`;沿 §8.2 字段表)
7. ✅ 每个 endpoint 入参 DTO 严格白名单(`forbidNonWhitelisted: true` 兜底,DTO 自身白名单是第一道防线;沿 Phase 2 review §10.11a)

### 8.2 出参 DTO 字段集

#### 8.2.1 `AppMyRegistrationListItemDto`(P2-5a 列表项)

字段集 **恰好 11 个**(基础 9 项 + 活动派生 2 项):

| # | 字段 | 类型 | 必返 | 来源 | 备注 |
|---|---|---|---|---|---|
| 1 | `id` | `string`(cuid) | ✅ | `ActivityRegistration.id` | 主键 |
| 2 | `activityId` | `string` | ✅ | `ActivityRegistration.activityId` | 活动外键(前端可点跳详情;P2-4 `/activities/:id`) |
| 3 | `activityTitle` | `string` | ✅ | join `Activity.title` | **派生**;前端列表展示活动名;**禁止** N+1(用 join + select)|
| 4 | `activityStartAt` | `Date` | ✅ | join `Activity.startAt` | 派生;前端按时间排序友好 |
| 5 | `activityEndAt` | `Date` | ✅ | join `Activity.endAt` | 派生 |
| 6 | `activityCoverImageUrl` | `string \| null` | ✅(可空) | join `Activity.coverImageUrl` | 派生 |
| 7 | `statusCode` | `string`(`pending`/`pass`/`reject`/`cancelled`) | ✅ | `ActivityRegistration.statusCode` | 报名状态 |
| 8 | `registeredAt` | `Date` | ✅ | `ActivityRegistration.registeredAt` | |
| 9 | `reviewedAt` | `Date \| null` | ✅(可空)| `ActivityRegistration.reviewedAt` | |
| 10 | `cancelledAt` | `Date \| null` | ✅(可空) | `ActivityRegistration.cancelledAt` | |
| 11 | `createdAt` | `Date` | ✅ | `ActivityRegistration.createdAt` | |

**明确不返**(L1 内部 / L1 admin 字段):

| 字段 | 来源 | 不返理由 |
|---|---|---|
| `memberId` | `ActivityRegistration.memberId` | 列表 / 详情只对本人,**禁止**返本人 memberId(沿 `AppMeAccountDto.linkedMemberId` 已暴露,本接口 redundant)— **本评审稿决议待定;见 §16 #16.5** |
| `reviewedBy` | `ActivityRegistration.reviewedBy` | L1 admin 内部 User.id;App 不暴露审核人 |
| `cancelledByUserId` | `ActivityRegistration.cancelledByUserId` | 同上 |
| `reviewNote` | `ActivityRegistration.reviewNote` | 列表项不展示(详情可返);沿 P2-4 列表精简范式 |
| `cancelReason` | `ActivityRegistration.cancelReason` | 同上 |
| `extras` | `ActivityRegistration.extras`(Json) | 列表项不展示(详情可返);避免列表项 payload 膨胀 |
| `updatedAt` | `ActivityRegistration.updatedAt` | App 浏览端不需要(沿 P2-4 v0.1 收窄精神)|
| `deletedAt` | `ActivityRegistration.deletedAt` | 永不返 |
| `member.memberNo` / `member.displayName` | join Member | 本人看本人无意义(本人已知自己的 memberNo / displayName);沿 v2 admin list 是 admin 视角需要,App 不需要 |

#### 8.2.2 `AppMyRegistrationDto`(P2-5a 详情 + P2-5b 出参共用)

字段集 **恰好 12 个**:

| # | 字段 | 类型 | 必返 | 来源 | 备注 |
|---|---|---|---|---|---|
| 1 | `id` | `string` | ✅ | `ActivityRegistration.id` | |
| 2 | `activityId` | `string` | ✅ | `ActivityRegistration.activityId` | |
| 3 | `memberId` | `string` | ✅ | `ActivityRegistration.memberId` | 本人 memberId(冗余;**待 §16 #16.5 决议是否返**)|
| 4 | `statusCode` | `string` | ✅ | `ActivityRegistration.statusCode` | |
| 5 | `registeredAt` | `Date` | ✅ | `ActivityRegistration.registeredAt` | |
| 6 | `reviewedAt` | `Date \| null` | ✅(可空)| `ActivityRegistration.reviewedAt` | |
| 7 | `reviewNote` | `string \| null` | ✅(可空) | `ActivityRegistration.reviewNote` | L1 对本人:本人 reject 解释;允许返(沿 §8.1 #5)|
| 8 | `extras` | `Record<string, unknown> \| null` | ✅(可空)| `ActivityRegistration.extras`(Json)| 用户自定义 JSON;沿 v2 Q-A13 不做嵌套校验 |
| 9 | `cancelledAt` | `Date \| null` | ✅(可空)| `ActivityRegistration.cancelledAt` | |
| 10 | `cancelReason` | `string \| null` | ✅(可空) | `ActivityRegistration.cancelReason` | L1 对本人:取消原因;允许返 |
| 11 | `createdAt` | `Date` | ✅ | `ActivityRegistration.createdAt` | |
| 12 | `updatedAt` | `Date` | ✅ | `ActivityRegistration.updatedAt` | 详情需要(沿 v2 详情范式)|

**明确不返**:

| 字段 | 不返理由 |
|---|---|
| `reviewedBy` | L1 admin 内部 User.id;App 不暴露审核人 |
| `cancelledByUserId` | 同上(App 端取消的是本人,不需要再暴露 cancelledByUserId = self;admin 代取消的 cancelledByUserId 也不暴露)|
| `deletedAt` | 永不返 |
| `member` join 字段 | 同 §8.2.1 |
| activity join 字段(`activityTitle` 等) | 详情不嵌套活动信息;前端拿 `activityId` 后调 P2-4 `GET /activities/:id` 获取活动详情(沿 [Phase 0.7 §2.3](code-architecture-boundary-review.md) 单 endpoint 单职责)|

#### 8.2.3 `AppMyActivityListItemDto`(P2-5a `/my/activities` 列表项)

字段集 **恰好 11 个**:

| # | 字段 | 类型 | 必返 | 来源 | 备注 |
|---|---|---|---|---|---|
| 1 | `activityId` | `string` | ✅ | `Activity.id` | 主键(活动 id,**不**是 registration id;前端可点跳 P2-4 详情)|
| 2 | `title` | `string` | ✅ | `Activity.title` | |
| 3 | `activityTypeCode` | `string` | ✅ | `Activity.activityTypeCode` | |
| 4 | `statusCode` | `string`(`draft`/`published`/`cancelled`/`completed`)| ✅ | `Activity.statusCode` | **活动状态**;App 端"我已报名但活动黄了"场景应可见,所以**不**强约 published;沿 §11 决议 |
| 5 | `startAt` | `Date` | ✅ | `Activity.startAt` | |
| 6 | `endAt` | `Date` | ✅ | `Activity.endAt` | |
| 7 | `location` | `string` | ✅ | `Activity.location` | |
| 8 | `coverImageUrl` | `string \| null` | ✅(可空)| `Activity.coverImageUrl` | |
| 9 | `myRegistrationId` | `string` | ✅ | `ActivityRegistration.id` | 我在该活动的最新有效 registration id(派生取值规则见 §11)|
| 10 | `myRegistrationStatusCode` | `string` | ✅ | `ActivityRegistration.statusCode` | 我在该活动的报名状态(派生)|
| 11 | `myRegisteredAt` | `Date` | ✅ | `ActivityRegistration.registeredAt` | 我在该活动的最新报名时间(派生)|

**明确不返**:

| 字段 | 不返理由 |
|---|---|
| `capacity` / `registrationDeadline` / `description` / `content` / `genderRequirementCode` / `isPublicRegistration` / `organizationId` / `registrationSchema` / `galleryImageUrls` / `locationLongitude` / `locationLatitude` / `publishedBy*` / `cancelledBy*` / `registrationNotes` | 沿 P2-4 `AppActivityDetailDto` 不返字段集精神;`/my/activities` 是列表汇总,详情走 P2-4 `GET /activities/:id` |
| `myRegistrationCount` | 同一活动多条历史 registration 数量;沿 §11 决议**不返**;前端如需逐条查 `/my/registrations?activityId=X`(**P2-5 不实施 query 过滤**,见 §16 #16.7)|
| `deletedAt` | 永不返 |

#### 8.2.4 入参 DTO

##### `CreateAppMyRegistrationDto`(P2-5b 入参)

严格 **2 字段**:

```ts
export class CreateAppMyRegistrationDto {
  @ApiProperty({ description: '目标活动 id', minLength: 8, maxLength: 64 })
  @IsString()
  @Length(8, 64)
  activityId!: string;

  @ApiPropertyOptional({
    description: '扩展字段(Json;沿 v2 Q-A13 不做嵌套校验)',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  extras?: Record<string, unknown>;
}
```

**明确禁止字段**(`forbidNonWhitelisted` 兜底;DTO 自身白名单是第一道防线):

`memberId` / `userId` / `statusCode` / `submittedAt` / `registeredAt` / `reviewedBy` / `reviewedAt` / `reviewNote` / `cancelledByUserId` / `cancelledAt` / `cancelReason` / `id` / `deletedAt` / `createdAt` / `updatedAt`

**沿 [`docs/activity-registrations.dto.ts:23`](../src/modules/activity-registrations/activity-registrations.dto.ts) 既有禁止清单 + Phase 2 review §10.11a 风险**。

##### `CancelAppMyRegistrationDto`(P2-5b 入参)

严格 **1 字段**(沿 D-P2-5-9 保持可选):

```ts
export class CancelAppMyRegistrationDto {
  @ApiPropertyOptional({ description: '取消原因(可选)', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cancelReason?: string;
}
```

**注意**:类名独立 `CancelAppMyRegistrationDto`,**禁止** `extends CancelRegistrationDto`;字段集字面与 `CancelRegistrationDto` 一致是**有意的 zero-drift**(沿 P2-3 `ChangeMyPasswordDto` 直接复用范式精神,但因 `CancelRegistrationDto` 是 admin DTO 而非 Mixed 共享 DTO,P2-5 必须独立类。**两份 DTO 字段集字面一致**但**禁止类层级复用**。

##### `ListAppMyRegistrationsQueryDto`(P2-5a 列表 query)

严格 **3 字段**(`page` / `pageSize` 沿 `PaginationQueryDto`;**新增** `statusCode` 可选):

```ts
export class ListAppMyRegistrationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按报名状态过滤(pending / pass / reject / cancelled)',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  statusCode?: string;
}
```

**注意 `extends PaginationQueryDto`**:这是**唯一允许**的 `extends`,因为 `PaginationQueryDto` 是 `common/` 公共 DTO,**不是 admin 模块 DTO**(沿 P2-4 `extends PaginationQueryDto` 范式 + §8.1 #1 仅禁止 admin 模块 DTO)。

##### `ListAppMyActivitiesQueryDto`(P2-5a `/my/activities` query)

严格 **3 字段**(`page` / `pageSize` 沿 `PaginationQueryDto` + 可选 `registrationStatusCode`):

```ts
export class ListAppMyActivitiesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '按本人报名状态过滤(pending / pass / reject / cancelled);默认全集',
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  registrationStatusCode?: string;
}
```

**`registrationStatusCode` 而非 `statusCode`**:命名显式表达"是本人 registration 状态,不是活动状态";避免与 `Activity.statusCode` 概念混淆(沿 [Phase 0.6 §4.4](data-access-lifecycle-boundary-review.md) 字典 code 语义清晰)。

### 8.3 文件归属表

| DTO | 文件 |
|---|---|
| `AppMyRegistrationListItemDto` | `src/modules/activity-registrations/dto/app/app-my-registration-list-item.dto.ts` |
| `AppMyRegistrationDto` | `src/modules/activity-registrations/dto/app/app-my-registration.dto.ts` |
| `CreateAppMyRegistrationDto` | `src/modules/activity-registrations/dto/app/create-app-my-registration.dto.ts` |
| `CancelAppMyRegistrationDto` | `src/modules/activity-registrations/dto/app/cancel-app-my-registration.dto.ts` |
| `ListAppMyRegistrationsQueryDto` | `src/modules/activity-registrations/dto/app/list-app-my-registrations-query.dto.ts` |
| `AppMyActivityListItemDto` | `src/modules/activities/dto/app/app-my-activity-list-item.dto.ts` |
| `ListAppMyActivitiesQueryDto` | `src/modules/activities/dto/app/list-app-my-activities-query.dto.ts` |

---

## 9. BizCode 复用矩阵(D-P2-5-10)

### 9.1 零新增 BizCode(锁定)

✅ 全部复用既有 11 项(沿 [`src/common/exceptions/biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts)):

| BizCode | code | HTTP | 适用场景 |
|---|---|---|---|
| `UNAUTHORIZED` | 40100 | 401 | 无 / 过期 / 无效 access token / user 软删 / `DISABLED` |
| `FORBIDDEN` | 40300 | 403 | `canUseApp=false`(未绑定 / 未激活 / 软删 member) |
| `BAD_REQUEST` | 40000 | 400 | DTO 校验失败 / `forbidNonWhitelisted` 命中 / `IdParamDto` 不符 / `pageSize` > 100 |
| `INTERNAL_ERROR` | 50000 | 500 | 未捕获异常兜底 |
| `ACTIVITY_NOT_FOUND` | 20001 | 404 | 活动不存在 / `draft` / `cancelled` / `completed` / 软删(**仅** P2-5b `POST /my/registrations` 命中非 published)|
| `ACTIVITY_NOT_PUBLIC_REGISTRATION` | 20120 | 409 | 活动 `isPublicRegistration=false`(沿 `assertActivityRegistrable`)|
| `ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN` | 20121 | 409 | 活动 `statusCode='cancelled'`(沿 `assertActivityRegistrable`;**注意**与 D-P2-5-8 重叠:cancelled 活动既走 `ACTIVITY_NOT_FOUND` 也走 `ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN`?**沿 D-P2-5-8 锁定为 `ACTIVITY_NOT_FOUND`**;`20121` **本期 App path 不会被触达**,保留供 admin path 使用 — see §9.3)|
| `ACTIVITY_REGISTRATION_NOT_FOUND` | 21001 | 404 | registration 不存在 / 越权访问他人 / 已软删 |
| `ACTIVITY_REGISTRATION_ALREADY_EXISTS` | 21002 | 409 | partial unique 冲突(同活动同 member active)|
| `ACTIVITY_REGISTRATION_STATUS_INVALID` | 21030 | 409 | 取消时 `statusCode ∉ { pending, pass }` |
| `ACTIVITY_CAPACITY_EXCEEDED` | 21032 | 409 | 活动名额已满 |
| `MEMBER_NOT_FOUND` | 15001 | 404 | **App path 不应触达**(controller 层 `AppIdentityResolver` 已拦截);若兜底触达表示 controller 漏前置;e2e 应验证**不出现** 15001 |

### 9.2 不开的 BizCode(锁定)

❌ **本评审稿明确不开**:

- ❌ `APP_REGISTRATION_*` 段位(沿 baseline §1.3 + P2-4 review §7.2;不为 surface 开独立段位;activity_registrations 段 210xx / 211xx 共享 admin + app)
- ❌ `APP_MEMBER_NOT_LINKED` / `APP_MEMBER_INACTIVE` / `APP_MEMBER_DELETED`(沿 P2-4 review §7.2 + `app-access-reason.ts`;`canUseApp=false` 走通用 `FORBIDDEN`,reason 在 `/me/capabilities` 字符串暴露)
- ❌ `REGISTRATION_CANCEL_WINDOW_CLOSED`(取消窗口限制是 Policy 扩展;P2-5 v0 不实施;沿 D-P2-5-11)
- ❌ `REGISTRATION_GENDER_REQUIREMENT_MISMATCH`(性别要求过滤;沿 v2 admin 现状未实施)
- ❌ `REGISTRATION_DEADLINE_PASSED`(报名截止时间过;沿 D-P2-5-11)
- ❌ `ACTIVITY_NOT_VISIBLE` / `ACTIVITY_HIDDEN`(走 `ACTIVITY_NOT_FOUND`,避免存在性侧信道;沿 P2-4 D-P2-4-3)

### 9.3 `ACTIVITY_NOT_FOUND` vs `ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN` 冲突解析

**冲突点**:既有 `ActivityRegistrationsService.assertActivityRegistrable`(`service.ts:243-255`)对 cancelled 活动抛 `ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN=20121`(409);D-P2-5-8 锁定 cancelled / draft / completed 统一返 `ACTIVITY_NOT_FOUND=20001`(404)。

**决议(D-P2-5-8 解析)**:

P2-5b `POST /my/registrations` 实施时:

1. 在 service 层(`ActivityRegistrationsService.createMy` 进入前)**新增前置 helper** `assertActivityPublishedOrThrow(activityId, tx)`:
   - 查 activity 用 `notDeletedWhere({ id, statusCode: 'published' })`
   - 不存在(含 draft / cancelled / completed / 软删) → `BizException(ACTIVITY_NOT_FOUND)` / HTTP 404
   - 存在 → 继续调用既有 `createMy`
2. 既有 `createMy` 内部的 `assertActivityRegistrable` 校验**仍然保留**(`isPublicRegistration` + cancelled 二次校验);因为 `assertActivityPublishedOrThrow` 已拦下 cancelled,所以 `assertActivityRegistrable` 在 App path **实际只会触发** `ACTIVITY_NOT_PUBLIC_REGISTRATION`(`isPublicRegistration=false`)
3. **admin path 行为不变**:admin `POST /v2/activities/:activityId/registrations` 继续走原 `assertActivityRegistrable`,可以触达 `ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN=20121`

**结果**:

| Path | 活动 published + 公开报名 | 活动 published + 非公开 | 活动 cancelled / draft / completed | 活动不存在 |
|---|---|---|---|---|
| **App `POST /my/registrations`** | ✅ 200 | ❌ `20120` 409 | ❌ `20001` 404(**统一 404 防侧信道;D-P2-5-8**)| ❌ `20001` 404 |
| **Admin `POST /v2/activities/:id/registrations`** | ✅ 200 | ❌ `20120` 409 | ❌ `20121` 409(cancelled)/ `20120` 409(draft / completed `isPublicRegistration=false` 时)/ `20001` 404(不存在)| ❌ `20001` 404 |

**铁律**:App path 与 admin path 在"活动可见性"上**故意不同**;App 看到的世界仅 published,admin 看到全部 4 态。这是**端点语义差异**,**不**是 v2 行为破坏(沿 P2-4 §2.3 D-P2-4-1 锁定理由 5)。

**`isPublicRegistration=false` 边界说明(SHOULD-FIX #4 增补)**:

- ✅ **`activity.statusCode != published`**(`draft` / `cancelled` / `completed` / 软删 / 不存在)→ App 报名**统一抛 `ACTIVITY_NOT_FOUND=20001` / HTTP 404**(沿 D-P2-5-8;由薄壳 `assertActivityPublishedOrThrow` 前置拦截)
- ⚠️ **`activity.statusCode = published` 但 `isPublicRegistration=false`**(已发布但内部活动,不开放公开报名)→ **沿现有业务语义抛 `ACTIVITY_NOT_PUBLIC_REGISTRATION=20120` / HTTP 409**(由既有 `ActivityRegistrationsService.assertActivityRegistrable` 触发)
- 📌 **`isPublicRegistration=false` 的 published 活动不属于 D-P2-5-8 的"非 published"范围**:该活动仍是 `published`,只是产品业务语义"未开放公开报名";App 端(P2-4 `/activities/available`)**仍可见**该活动(P2-4 D-P2-4-1 仅过滤 `statusCode='published'`,**未**过滤 `isPublicRegistration`),所以返 `20120` 不会泄漏额外可观测性
- 🔄 **若用户要求进一步收窄 App 可观测性**(把 `isPublicRegistration=false` 也统一抛 `20001` 让 App 端完全看不到此类活动差别),可另行决议,沿 §16.B 新增待决议项(SHOULD-FIX #4 同步加入)

### 9.4 实施侧落地建议

**在 `ActivityRegistrationsService` 新增 1 个 public method**(沿 §6.2 决议;**仅** P2-5b 用):

```ts
// (草案;P2-5b PR 实施)
async assertActivityPublishedOrThrow(activityId: string, tx?: PrismaTx): Promise<void> {
  const client = tx ?? this.prisma;
  const act = await client.activity.findFirst({
    where: notDeletedWhere({ id: activityId, statusCode: 'published' }),
    select: { id: true },
  });
  if (!act) {
    throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }
}
```

**或者**在新建薄壳 `AppMyRegistrationsService` 内实现(沿 §6.4 推荐方案;controller → app-service → 既有 service 三层):

```ts
// (草案;P2-5b PR 实施)
@Injectable()
export class AppMyRegistrationsService {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly registrationsService: ActivityRegistrationsService,
    private readonly prisma: PrismaService,
  ) {}

  async createMyForApp(currentUser, dto, auditMeta) {
    const access = await this.appIdentity.resolve(currentUser);
    if (!access.canUseApp) throw new BizException(BizCode.FORBIDDEN);
    // 前置 published 校验;沿 D-P2-5-8
    const published = await this.prisma.activity.findFirst({
      where: notDeletedWhere({ id: dto.activityId, statusCode: 'published' }),
      select: { id: true },
    });
    if (!published) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return this.registrationsService.createMy(dto.activityId, { extras: dto.extras }, currentUser, auditMeta);
  }
}
```

**两种方案**(public method on `ActivityRegistrationsService` vs private check in `AppMyRegistrationsService`)PR 实施时再决议;**本评审稿推荐方案 B**(薄壳 service 内部前置,**不**污染既有 `ActivityRegistrationsService` 公共 API)。

---

## 10. 状态机与 Policy 规则

### 10.1 Registration 4 态闭集(沿 [`docs/批次3_API前评审决议表.md`](docs/批次3_API前评审决议表.md) v1.0 + `activity-registrations.service.ts:58-61`)

```
            ┌─────────┐
   create   │ pending │
  ─────────►│         │
            └────┬────┘
                 │
       approve   │   reject
   ┌─────────────┼─────────────┐
   ▼             ▼             ▼
┌──────┐    (cancel)        ┌────────┐
│ pass │      ◄──────────── │ reject │
│      │                    │        │
└──┬───┘                    └────────┘
   │ cancel
   ▼
┌───────────┐
│ cancelled │
└───────────┘
```

**App path 仅触达**:
- `pending` ← `POST /my/registrations`(初始态)
- `pending → cancelled` / `pass → cancelled` ← `PATCH /my/registrations/:id/cancel`
- **App 不能触发** `approve` / `reject`(沿 P2-5 不在范围;那是 admin path 职责)

### 10.2 P2-5b 状态机校验(沿 既有 `cancelMy:664-669` 范式)

| 当前状态 | App 允许的动作 | 失败行为 |
|---|---|---|
| `pending` | ✅ cancel | — |
| `pass` | ✅ cancel | — |
| `reject` | ❌ cancel | `ACTIVITY_REGISTRATION_STATUS_INVALID=21030` / HTTP 409 |
| `cancelled` | ❌ cancel(已 cancel)| 同上 |

### 10.3 Policy 复用矩阵(P2-5b)

`POST /my/registrations` 进入既有 `createMy` 后,事务内顺序校验(沿 `createMy:392-410`):

1. ✅(本评审稿 D-P2-5-8 新增)`assertActivityPublishedOrThrow` — 活动必须 published;否则 `ACTIVITY_NOT_FOUND=20001`
2. `resolveUserMemberIdOrThrow` — 拿到本人 `memberId`(冗余,因 controller 已经 `AppIdentityResolver`;沿现状保留)
3. `assertActivityRegistrable` — 检查 `isPublicRegistration` + cancelled(沿 D-P2-5-8 解析:cancelled 在步骤 1 已拦,本步只触发 `ACTIVITY_NOT_PUBLIC_REGISTRATION`)
4. `assertCapacityNotExceeded` — 检查 `pass` 计数 < `capacity`(若 capacity != null);否则 `ACTIVITY_CAPACITY_EXCEEDED=21032`
5. `assertNoActiveRegistration` — 检查 partial unique;否则 `ACTIVITY_REGISTRATION_ALREADY_EXISTS=21002`
6. `runWithUniqueConstraintGuard` 包 `prisma.activityRegistration.create`(并发 race 由 partial unique 兜底 → P2002 → 21002)
7. ✅ Audit `registration.create`(`extra.viaPath='self'`;沿现状)

### 10.4 Policy 不实施清单(沿 D-P2-5-11)

| Policy | 状态 | 触发时机 |
|---|---|---|
| `registrationDeadline` 过期拒报 | ❌ **P2-5 v0 不做** | 沿 D-P2-5-11;**待用户决议**(§16 #16.1);若启用必须走 `RegistrationPolicyService`(Phase 0.7 §6 路径)或等价层 |
| `genderRequirementCode` 性别不符拒报 | ❌ **P2-5 v0 不做** | 沿 v2 admin 现状未实施;若产品要求 P2.x 单独立项 |
| `cancelWindow` 取消窗口(开始前 24h 不可取消等)| ❌ **P2-5 v0 不做** | Phase 2 review §3.1 / §10.10;**禁止**在 controller 硬编码;若启用需 PolicyService 路径单独立项 |
| 候选 / 临时编号志愿者报名 | ❌ **永不在 P2-5** | 沿 §19.7 D-5.1 / P2-3 review §4.6 |
| 报名后通知 / 短信 / 邮件 | ❌ **P2-5 v0 不做** | Phase 0.7 §9 Effect/Workflow boundary;若启用单独立项 |

### 10.5 状态机不立即抽 StateMachine boundary(沿 [Phase 0.7 §7.5 / §13.3](code-architecture-boundary-review.md))

- ✅ P2-5b 仍**显式抛 BizException**(沿现状 `cancelMy:664-669`)
- ❌ **不**在 P2-5b 抽 `RegistrationStateMachine.canTransition(from, to)`
- ❌ **不**在 P2-5b 引入 `RegistrationPolicyService` class
- ✅ 沿 Phase 0.7 §11 Refactor Triggers + §13.3 P0/P1 过渡:第二次复用(如未来 P2-5+ 出现 `bulk cancel` / `transfer` 等)再抽

---

## 11. `/my/activities` 汇总规则

### 11.1 语义

> "我已建立 registration 关系的活动"汇总视图;每个活动一行;含本人在该活动的**最新有效** registration 摘要。

**包含**:
- 本人**所有有效 registration**(`deletedAt IS NULL`)对应的活动
- 活动状态**可包含全部 4 态**(`draft` / `published` / `cancelled` / `completed`),因为本人可能在活动 published 时报名后,活动被管理员 cancelled / completed
- **但**:若本人某活动**所有** registration 均软删(`deletedAt IS NOT NULL`),该活动**不出现**在汇总(因为已无关系)

**不包含**:
- 本人**未报名**的活动(那是 P2-4 `/activities/available` 职责)
- `draft` 活动(本人原则上不可见 draft 活动,因为 App 不可见 draft;但若 admin 误开 draft 让本人提前报过,该 registration 仍可见 — see §11.3 边界讨论)

### 11.2 派生取值规则

**每个活动一行**:本人在该活动可能有 0 ~ N 条 registration(因 cancel 后可重报);取**最新有效**作为该活动的 registration 摘要。

**取值优先级**:

1. **优先取 active registration**(`deletedAt=null` AND `statusCode IN ('pending', 'pass')`):
   - 若有多条 active(不应该出现,partial unique 约束保证;但兜底),取 `createdAt DESC` 的最新
2. **若无 active,取最新 reject**(`statusCode='reject'`):
   - 沿 §8.2.3 字段表;reject 表示"该活动我曾尝试但被拒",仍是有意义的"我的活动"关系
3. **若无 active 且无 reject,取最新 cancelled**:
   - 沿现状:同活动可 cancel 后重报,新一轮报名又 cancel,取最新 cancelled
4. **若全部软删,该活动不出现**

### 11.3 SQL / Prisma 实施草案(P2-5a PR 实施时再对齐)

**方案 A**(推荐):**两阶段查询**(沿 v2 admin list 双 query 范式;避免复杂窗口函数):

```ts
// (草案;P2-5a PR 实施)
async listForMember(memberId: string, query: ListAppMyActivitiesQueryDto) {
  // 1. 查本人所有 active registration 的 activityId distinct 集合(按 createdAt DESC)
  //    + 可选 registrationStatusCode 过滤
  const where: Prisma.ActivityRegistrationWhereInput = { memberId };
  if (query.registrationStatusCode !== undefined) {
    where.statusCode = query.registrationStatusCode;
  }
  // 2. 用 distinct activityId + skip/take 分页拿当前页 activity 列表
  // 3. 对当前页 activityId 集合 join Activity,取每个 activityId 的"最新有效" registration
  //    (取值规则沿 §11.2)
  // 4. 拼装 AppMyActivityListItemDto[]
}
```

**方案 B**:**单 query + Prisma `_count` + GroupBy**(复杂;沿 Phase 0.7 §4.4 QueryService 路径)。

**方案 C**:**手工 SQL** + Prisma `$queryRaw`(性能最优但维护成本高)。

**本评审稿不锁实现方案**;P2-5a PR 评审稿决议(沿 §16 #16.4)。

### 11.4 排序

- 默认 `orderBy: { 最新 registration.createdAt: 'desc' }`(沿 `/my/registrations` 列表默认)
- **不**支持入参 `orderBy` 自定义(沿 P2-4 列表 query 严格白名单精神)
- **不**支持搜索 / keyword filter(沿 P2-4 §7 query 严格白名单)

### 11.5 分页边界

- 沿 `PaginationQueryDto` 默认 `page=1` / `pageSize=20` / 最大 `pageSize=100`
- `total` 字段返"本人所有有效 registration 涉及的活动数"(若 `registrationStatusCode` 过滤,则返过滤后总数)

### 11.6 数据隐私 / 越权防御

- `where` 子句**永远**含 `memberId = currentUser.memberId`(沿 §7.5 + Phase 0.6 §3.3)
- **禁止** service 内 `if (role === ADMIN) where.memberId = undefined` 短路
- e2e 必含 "ADMIN+memberId 调 `/my/activities` 返**仅本人**"用例(沿 §13)

### 11.7 边界场景

| 场景 | 行为 |
|---|---|
| 本人在某活动报名后又被 admin 代取消 | 取最新 cancelled;`myRegistrationStatusCode=cancelled` |
| 本人在某活动报名后活动被 cancelled | `Activity.statusCode=cancelled` + `myRegistrationStatusCode=pending`(或 pass);**不**联动改 registration 状态(沿现状)|
| 本人在某活动报名后活动被 completed | 同上;`Activity.statusCode=completed` + `myRegistrationStatusCode=pass`(常见路径)|
| 本人无任何 registration | 空 list(`items=[]`, `total=0`)|
| 本人所有 registration 全软删 | 空 list |

---

## 12. Audit 策略

### 12.1 复用既有 audit event(沿 [`src/modules/activity-registrations/activity-registrations.service.ts:54`](../src/modules/activity-registrations/activity-registrations.service.ts) + [`audit-logs.types.ts`](../src/modules/audit-logs/audit-logs.types.ts))

| Endpoint | Audit event | `extra` 字段(P2-5 落地)|
|---|---|---|
| `GET /my/registrations` | ❌ 不写 audit(read 不记录;沿 Q1=A) | — |
| `GET /my/registrations/:id` | ❌ 同上 | — |
| `GET /my/activities` | ❌ 同上 | — |
| `POST /my/registrations` | ✅ `registration.create`(复用既有) | `{ operation: 'create', viaPath: 'self', activityId, targetMemberId: currentUser.memberId }`(沿 `createMy:417-424` 现状) |
| `PATCH /my/registrations/:id/cancel` | ✅ `registration.review`(复用既有;`action='cancel'`)| `{ operation: 'review', action: 'cancel', priorStatusCode, nextStatusCode: 'cancelled', cancelledByPath: 'self', cancelReason, activityId, targetMemberId }`(沿 `cancelMy:683-700` 现状) |

### 12.2 零新增 audit event

❌ **不开**:
- `registration.create.app`(沿 P2-3 audit 命名风格 + Phase 2 review §11.3 audit 严格继承;App / v2 self path 共用 `registration.create`,通过 `extra.viaPath='self'` 区分,**但**无法区分 App 与 v2 me self;若产品要求**可观测**,沿 §16 #16.6 待决议)
- `my-activities.list`(read endpoint 不记录;沿 Q1=A)
- `app.my-registrations.*` 新事件(沿 baseline §1 命名风格)

### 12.3 audit `extra` mask 策略

- ✅ `extra.cancelReason`(本人取消原因字符串)**允许写入**(沿现状 `cancelMy:697`);文本无敏感字段语义
- ✅ `extra.viaPath='self'` / `targetMemberId=currentUser.memberId` **允许写入**;无敏感语义
- ✅ `before` / `after` `toAuditSnapshot` 现状返字段集**全部非敏感**(沿 service:127-141 + 注释)
- ❌ **不** mask `extras`(用户自定义 JSON)子字段;沿 D-P2-5-12 仅作为 P2.x 风险记录(§14.9)

### 12.4 audit context `auditMeta`

- 沿 P2-3 `buildAuditMeta(req)` 范式;controller 内私有 helper(沿 P2-3 决议 α:第三次复用仍复制不抽)
- `{ requestId, ip, ua }`(沿 [`audit-logs.types.ts AuditMeta`](../src/modules/audit-logs/audit-logs.types.ts))
- **沿 D-P2-5-12 不扩展 `surface: 'app'` 字段**;`ua` 与 `actorRoleSnap` 已足够区分 surface

### 12.5 audit 不触发 attendances / activities 高压区

- ✅ 沿 [Phase 0.6 §6.7 / §4](data-access-lifecycle-boundary-review.md):registration 触发 audit **不**联动 attendance / activity audit(批次 3A / 3B 范式)
- ✅ P2-5 写动作**不**联动改 `Activity.statusCode`(报名 / 取消不影响活动状态);沿现状

---

## 13. 测试策略

### 13.1 通用质量门槛(沿 [`docs/process.md §3` C 档](process.md))

```bash
pnpm lint
pnpm typecheck
pnpm test            # unit
pnpm test:contract   # OpenAPI snapshot
pnpm test:e2e        # 含本 PR 新增 endpoint 与旧 path 兼容性
```

任一未通过 → **不**合并。

### 13.2 必须新增 E2E spec

| spec 文件 | PR | 覆盖范围 |
|---|---|---|
| `test/e2e/app-my-registrations-read.e2e-spec.ts` | **P2-5a** | 3 个只读 endpoint:9 类用例 × 3 endpoint + `/my/activities` 特殊汇总用例 ≈ **30-35 用例** |
| `test/e2e/app-my-registrations-write.e2e-spec.ts` | **P2-5b** | 2 个写 endpoint:9 类 + 写专项 5 类 ≈ **30-40 用例** |

(沿 Phase 2 review §9.2 9 类 + §9.3 写操作额外覆盖)

### 13.3 P2-5a 必跑用例分类(每 endpoint × 3)

1. ✅ **success**(linked active member,有报名 / 已报活动)
2. ✅ **unauthenticated**(无 token / 过期 token → `UNAUTHORIZED=40100` / HTTP 401)
3. ✅ **member-not-linked**(`User.memberId=null` → `FORBIDDEN=40300` / HTTP 403)
4. ✅ **member-inactive**(`Member.status=INACTIVE` → 403)
5. ✅ **member-soft-deleted**(`Member.deletedAt != null` → 403)
6. ✅ **scope-self**(制造他人 registration,断言本人 list / detail / `/my/activities` **看不到他人**)
7. ✅ **sensitive-field-not-returned**(响应**不含** `reviewedBy` / `cancelledByUserId` / `member.memberNo` / `member.displayName` / `deletedAt` / 任何 L3 字段)
8. ✅ **admin-as-member**(`ADMIN` + linked member 调返**仅本人**;**不**因 role 看到其他人)
9. ✅ **contract-snapshot**(OpenAPI snapshot 字段集 = DTO 定义)
10. ✅ **path-stability**(旧 `/v2/users/me/registrations*` 行为**逐字不变**;通过既有 e2e `activity-registrations.e2e-spec.ts` 验证)

### 13.4 P2-5a `/my/activities` 特殊用例

11. ✅ **multiple-registrations-same-activity**:同一活动本人有 cancelled + 新 pending,`myRegistrationStatusCode` 取 active(沿 §11.2)
12. ✅ **all-cancelled-activity**:本人某活动只有 cancelled 记录,`myRegistrationStatusCode='cancelled'`
13. ✅ **only-reject-activity**:本人某活动只有 reject 记录,`myRegistrationStatusCode='reject'`
14. ✅ **activity-cancelled-after-register**:本人报名后活动 cancelled,该活动**仍出现**在 `/my/activities` 列表,`Activity.statusCode='cancelled'`,`myRegistrationStatusCode='pass'`
15. ✅ **filter-by-registrationStatusCode**:`?registrationStatusCode=pass` 返**仅** pass 状态的活动
16. ✅ **empty-list**:本人无任何 registration → `items=[]`, `total=0`

### 13.5 P2-5b 必跑用例分类(每 endpoint × 2)

1. ✅ **success**(linked active member + activity published + 公开报名 + 名额未满 + 未报过)
2. ✅ **unauthenticated**(401)
3. ✅ **member-not-linked**(403)
4. ✅ **member-inactive**(403)
5. ✅ **scope-self**(本人创建 registration 时 `memberId = currentUser.memberId`;**不**接收 body memberId)
6. ✅ **sensitive-field-not-returned**(响应无 admin 内部字段)
7. ✅ **admin-as-member-create**(`ADMIN` + linked member 调 `POST /my/registrations` 成功创建,但 `memberId = adminUser.memberId`,**不**夹带创建他人)
8. ✅ **contract-snapshot**
9. ✅ **path-stability**(旧 `POST /v2/users/me/activities/:id/registration` 行为**逐字不变**)

### 13.6 P2-5b 写专项必跑用例

10. ✅ **activity-not-found**(报名不存在活动 → `ACTIVITY_NOT_FOUND=20001` / 404)
11. ✅ **activity-draft**(报名 draft 活动 → 沿 D-P2-5-8 → `ACTIVITY_NOT_FOUND=20001` / 404)— **关键铁律用例**
12. ✅ **activity-cancelled**(报名 cancelled 活动 → 沿 D-P2-5-8 → `ACTIVITY_NOT_FOUND=20001` / 404;**不**触达 `20121`)— **关键铁律用例**
13. ✅ **activity-completed**(报名 completed 活动 → 沿 D-P2-5-8 → `ACTIVITY_NOT_FOUND=20001` / 404)— **关键铁律用例**
14. ✅ **activity-not-public**(`isPublicRegistration=false` published 活动 → `ACTIVITY_NOT_PUBLIC_REGISTRATION=20120` / 409)
15. ✅ **duplicate-submit**(同活动重复报名 → `ACTIVITY_REGISTRATION_ALREADY_EXISTS=21002` / 409)
16. ✅ **capacity-exceeded**(名额已满 → `ACTIVITY_CAPACITY_EXCEEDED=21032` / 409;**race 用例** — 并发 N 个超容量报名,期望恰 capacity 个成功)
17. ✅ **invalid-state-cancel**(`PATCH cancel` 已 reject / cancelled / 不存在状态 → `ACTIVITY_REGISTRATION_STATUS_INVALID=21030` / 409)
18. ✅ **not-owner-cancel**(取消他人 registration → `ACTIVITY_REGISTRATION_NOT_FOUND=21001` / 404 — **不**透出存在性)
19. ✅ **audit-write**(成功 create / cancel 写入 audit_logs;`event='registration.create'` / `registration.review`;`extra.viaPath='self'`;`extra.targetMemberId=currentUser.memberId`;**不**含 raw L3)
20. ✅ **admin-as-member-cancel**(`ADMIN` + linked member 取消本人 registration 成功;**禁止**通过 App path 取消别人)

### 13.7 contract snapshot 必须

| 修改 | 期望 |
|---|---|
| 新增 path(P2-5a)| `/api/app/v1/my/registrations`(GET)+ `/api/app/v1/my/registrations/:id`(GET)+ `/api/app/v1/my/activities`(GET)= **3** 新 path |
| 新增 path(P2-5b)| `/api/app/v1/my/registrations`(POST)+ `/api/app/v1/my/registrations/:id/cancel`(PATCH)= **2** 新 path |
| 新增 DTO(P2-5a)| `AppMyRegistrationListItemDto` / `AppMyRegistrationDto` / `AppMyActivityListItemDto` / `ListAppMyRegistrationsQueryDto` / `ListAppMyActivitiesQueryDto` = **5** 新 DTO |
| 新增 DTO(P2-5b)| `CreateAppMyRegistrationDto` / `CancelAppMyRegistrationDto` = **2** 新 DTO |
| 删除 path | **0**(旧 path 全不动)|
| 修改 path response/request schema | **0**(旧 path schema 全不变)|
| 修改 Guard / `@Roles(...)` 引发 security 字段变化 | **0**(admin path 不动)|

### 13.8 测试不需要做

❌ **本评审稿明确不做**:
- 不写 unit test for `AppMyActivitiesService.listForMember`(沿 v2 项目 unit 主要覆盖 service 关键逻辑,但 list method 主要 SQL 查询逻辑由 e2e 覆盖即可;沿现状)
- 不写 contract test for admin path(沿 path-stability;旧 contract snapshot 应**逐字相等**)
- 不写 perf / load test for capacity race(沿 Phase 2 review §9 e2e 即可;perf 单独立项)

---

## 14. 风险表

> 风险等级:**极高** / **高** / **中** / **低**。P2-5a / P2-5b 启动前必须每条逐项确认缓解措施已就位。

| # | 风险 | 等级 | 触发条件 | 缓解 | 阻塞 P2-5? |
|---|---|---|---|---|---|
| 14.1 | App DTO 复用 admin DTO | **极高** | 实施者 `extends ActivityRegistrationResponseDto` / `Pick CancelRegistrationDto` / `Omit ActivityRegistrationListItemDto` | 沿 §8.1 #1;PR review 强 grep:① `extends.*Registration` 在 `dto/app/` 内 = 0;② `PickType\|OmitType\|IntersectionType\|PartialType.*Registration` 在 `dto/app/` 内 = 0;③ `mapped-types` import 在 `dto/app/` 内 = 0 | ✅ 是 |
| 14.2 | `MEMBER_NOT_FOUND=15001` 透出到 App | 高 | 实施者直接复用 `listMy` / `createMy` 不在 controller 层先做 `AppIdentityResolver` | controller 层强约 `const access = await this.appIdentity.resolve(currentUser); if (!access.canUseApp) throw FORBIDDEN;` 在所有 5 endpoint 前置;e2e 必含 "无 memberId 调 5 endpoint 期望 403 而非 15001" | ✅ 是 |
| 14.3 | admin 兼队员越权(`role=ADMIN` 看他人)| **极高** | service / controller 内 `if (role === ADMIN) return allData` 短路 | 沿 §7.5 / §7.6 + §19.7 D-5.2 + Phase 0.7 §3.3;e2e 必含 "ADMIN+memberId 调 `/my/registrations` 期待仅本人" 用例 | ✅ 是 |
| 14.4 | `cancelMy` race(并发取消同一条)| 中 | 同一 registration 并发取消 | service `cancelMy` 已用 `prisma.$transaction` + status 复核;沿现状不动 | 否 |
| 14.5 | `POST /my/registrations` capacity race | 高 | 并发报名同一活动超容量 | service `createMy` 已 `prisma.$transaction` + `assertCapacityNotExceeded` 事务内 count + partial unique;沿现状不动;e2e 必含并发 race 用例 | 否 |
| 14.6 | `myRegistrationStatusCode` 派生逻辑不一致 | 中 | `/my/activities` 内同活动多条 registration 时取值规则不明 | §11.2 锁定优先级:`active > reject > cancelled`;e2e #11 / #12 / #13 强测;P2-5a PR 评审稿启动时再 grep 确认 | 否 |
| 14.7 | `/my/activities` query 引入 admin 字段 | 中 | 实施者图省事加 `activityTypeCode` / `organizationId` / `statusCode`(活动)/ `isPublicRegistration` 等 admin query 字段 | DTO 严格 3 字段白名单(`page` / `pageSize` / 可选 `registrationStatusCode`);**注意是 registration 状态,不是 activity 状态**;PR review 强 grep `class ListAppMyActivitiesQueryDto` 字段集恰好 1 个 + extends `PaginationQueryDto` | ✅ 是 |
| 14.8 | capabilities 被当授权证明 | 中 | 实施者把"前端按钮状态"做进 service 当成授权证明 | 沿 §19.7 D-5.3 + P2-1 `AppCapabilityService` 铁律 2:capability **不是授权证明**;`AppIdentityResolver.resolve` 才是;e2e 验证 capabilities `canRegisterActivity=false`(假设 reason 文本)但 `Member.status=ACTIVE` 仍能报名(因 capabilities 与实际授权解耦)| ✅ 是 |
| 14.9 | `extras` Json 注入 / 敏感数据 | 中 | 客户端传入 `extras: { passwordHash: 'xxx', refreshToken: 'xxx', secret: 'xxx' }` 等敏感字段名 | 沿 v2 现状:`extras` 是用户自定义 JSON,不做嵌套校验(沿 service §1.6 注释 + Q-A13);**P2-5 v0 不做校验**;**audit 也不 mask**(沿 D-P2-5-12);P2.x 评估后续(沿 §16 #16.8)| 否(待决议) |
| 14.10 | path 冲突 | 低 | 同 handler 双 path? | 物理隔离:App 是 `AppMyRegistrationsController @Controller('app/v1/my')`,admin 是 `ActivityRegistrationsAdminController @Controller('v2/activities/:activityId/registrations')`,me 是 `ActivityRegistrationsMeController @Controller('v2/users/me')`;三 controller 路径前缀**完全不重叠**;NestJS 路由表无冲突 | 否 |
| 14.11 | PR 体量超 500 行 | 中 | 单 PR 全做 5 endpoint | 沿 D-P2-5-1 强制拆 P2-5a + P2-5b;PR review 强查 `git diff --stat` 行数 | ✅ 是 |
| 14.12 | `CancelAppMyRegistrationDto.cancelReason` 误必填 | 低 | 实施者 PR 内改成必填 | DTO `@IsOptional()` 严格沿 admin 范式;沿 D-P2-5-9 保持可选;PR review grep `class CancelAppMyRegistrationDto` 必含 `@IsOptional()` 在 `cancelReason` 前 | 否 |
| 14.13 | path-stability 旧 `/v2/users/me/registrations*` 被改 | 高 | PR 内顺手"清理"旧 v2 路径 | 沿 §5.3 + Phase 2 review §3.2;PR review 强查 `git diff src/modules/activity-registrations/activity-registrations.controller.ts` **必须无变化**;旧 path e2e **逐字通过** | ✅ 是 |
| 14.14 | `/my/activities` 触发 attendances 高压区 | 低 | `/my/activities` 是否要返"出勤摘要"`hasAttendanceRecord` / `myAttendanceStatus` | **P2-5 不做**;归 P2-6(`/my/attendance-records`);本评审稿严格不夹带;DTO 字段集恰好 11 项(沿 §8.2.3)| ✅ 是 |
| 14.15 | `extras` 字段集差异(create 接收 vs detail 返回) | 低 | DTO 字段集脱漂移 | `AppMyRegistrationDto.extras` 与 admin `ActivityRegistrationResponseDto.extras` 类型一致(`Record<string, unknown> \| null`);沿现状 | 否 |
| 14.16 | D-P2-5-8 报名时 cancelled / draft 活动错抛 `20121` 而非 `20001` | **高** | 实施者直接调既有 `createMy` 而未前置 `assertActivityPublishedOrThrow` | 沿 §9.3 / §9.4;实施薄壳 `AppMyRegistrationsService` 内 controller 调用前**必须**先校验 `statusCode='published'`;e2e #11 / #12 / #13 强测 | ✅ 是 |
| 14.17 | `registrationDeadline` 被实施者顺手加进 controller 硬编码 | 中 | 实施者觉得"报名截止应当然实施" | 沿 D-P2-5-11;PR review 强 grep `registrationDeadline` 在 P2-5b 实施文件**不出现**(除非作为不实施 / TODO 标记);若产品需求出现,沿 PolicyService 路径单独立项 | ✅ 是 |
| 14.18 | service / module 循环依赖 | 中 | `AppMyRegistrationsController`(在 `activity-registrations`)依赖 `UsersModule.AppIdentityResolver`;`AppMyActivitiesService`(在 `activities`)依赖 `UsersModule.AppIdentityResolver`;若 `UsersModule` 反向依赖 `ActivityRegistrationsModule` / `ActivitiesModule` 会形成循环 | P2-1 已建 `AppIdentityResolver` 在 `UsersModule`;`UsersModule` 不依赖业务模块(沿现状);P2-5a / P2-5b PR 实施时分别核 `forwardRef()` 是否需要 | 否(沿现状无循环)|
| 14.19 | `AppMyActivitiesService.listForMember` 性能(N+1)| 中 | 列表 20 项 × 每项再查 registration → 21 query | §11.3 方案 A 二阶段查询 + Prisma `select` 显式 join;P2-5a PR 实施时验证 query 数 ≤ 3(activity list query + registration aggregate query + count query)| ⚠️ P2-5a 启动前再验 |
| 14.20 | App 端 audit 与 v2 me path audit 无法区分 surface | 低 | audit_logs `event='registration.create'` + `extra.viaPath='self'` 同时被 App `POST /my/registrations` 与 v2 `POST /v2/users/me/activities/:id/registration` 写入,无法区分 | 沿 §12.4 不扩展 `surface` 字段;现有 `actorRoleSnap` + `auditMeta.ua` 已可区分;若审计运营需要,沿 §16 #16.6 待决议 | 否(待决议)|

---

## 15. 禁止事项(D-P2-5-13 + 横向沿袭)

> 横跨 P2-5a + P2-5b 的"绝对不做"。违反 = PR review 拒绝信号。

### 15.1 不实施 / 不引入

- ❌ **不实施** `/api/app/v1/my/attendance-records`(留 P2-6)
- ❌ **不实施** `/api/app/v1/my/certificates`(留 P2-7)
- ❌ **不实施** `/api/app/v1/me/*`(P2-1 / P2-2 / P2-3 已完成,**不**夹带)
- ❌ **不实施** `/api/auth/v1/*` / `/api/public/v1/*` alias(Phase 1B 独立通道)
- ❌ **不实施** `/api/app/v1/tasks/*` / `/api/app/v1/managed/*`(沿 Phase 2 review §3.1)
- ❌ **不实施** App `me/permissions` 返 raw RBAC permission code(沿 §19.7 D-5.3)
- ❌ **不实施** App 端"看别人"接口(`AppPeer*` 视角)
- ❌ **不实施** Recruiting / Onboarding 流程(沿 §19.7 D-5.1)
- ❌ **不实施** 候选 / 临时编号志愿者 App 登录
- ❌ **不实施** App 端"已登录设备列表" / device fingerprint(沿 P0-E v1 D-9)
- ❌ **不实施** 多份 Swagger 拆分(`/api-docs/app` 等;沿 Phase 1 review §5.2)
- ❌ **不实施** `registrationDeadline` 校验(沿 D-P2-5-11)
- ❌ **不实施** `genderRequirementCode` 性别要求校验(沿 §10.4)
- ❌ **不实施** `cancelWindow` 取消窗口(沿 §10.4)
- ❌ **不实施** 报名后通知 / 短信 / 邮件(沿 §10.4)
- ❌ **不实施** RBAC 全面收紧(沿 P0-F 独立通道)
- ❌ **不实施** `AppPeer*Dto` / `AppManaged*Dto`(沿 §19.7 D-5)

### 15.2 不动 / 不破坏

- ❌ **不动** `prisma/schema.prisma`(沿 A-3 红线 + Phase 2 review §3.2)
- ❌ **不生成** migration
- ❌ **不动** `Role` / `UserStatus` / `MemberStatus` enum
- ❌ **不新增** Permission seed / RbacRole(沿批次 8 Q8=A)
- ❌ **不动** 旧 `/api/v2/*` 行为(沿 Phase 3 方案 C)
- ❌ **不动** `/api/users/me*` 任何 endpoint
- ❌ **不动** `/api/v2/users/me/*` 4 个旧 path(`POST /activities/:id/registration` / `GET /registrations` / `GET /registrations/:id` / `PATCH /registrations/:id/cancel`)
- ❌ **不动** `/api/v2/activities/:activityId/registrations/*` 5 个 admin path(list / create / approve / reject / cancel / export)
- ❌ **不动** Phase 1A Swagger Tag(沿 Phase 1 review §2.2.2)
- ❌ **不动** P0-E refresh token / login / logout / logout-all 现状契约
- ❌ **不动** P0-D `PUT /api/users/me/password`(沿 P2-3 不复用 D-P2-3-1 例外)
- ❌ **不动** `apply-global-setup.ts` / `apply-swagger.ts` 等 bootstrap 文件
- ❌ **不 deprecated** 任何旧接口
- ❌ **不引入** Redis / queue / cron / outbox / casl(沿 [`CLAUDE.md §1`](../CLAUDE.md))
- ❌ **不引入** 新依赖 / 不改 `package.json` / 不改 `pnpm-lock.yaml`
- ❌ **不修改** [`CLAUDE.md §19.7`](../CLAUDE.md) / [`AGENTS.md §19.7`](../AGENTS.md)(本评审稿是 P2-5 子层;若需升级到全局 §19.7 新增 D-9,沿 Phase 2 review §11.3 P2-5 评审稿启动前用户决议)
- ❌ **不修改** [`docs/current-state.md`](current-state.md) / [`CHANGELOG.md`](../CHANGELOG.md)(沿 process.md A 档 docs-only;P2-5 implementation 合入后由 P2-8 收尾)

### 15.3 不立即重构(沿 [Phase 0.7 §6 / §12](code-architecture-boundary-review.md))

- ❌ **不**拆既有大 service [`attendances.service.ts:1413`](../src/modules/attendances/attendances.service.ts) / [`activity-registrations.service.ts:808`](../src/modules/activity-registrations/activity-registrations.service.ts) / [`activities.service.ts:656`](../src/modules/activities/activities.service.ts)
- ❌ **不**抽 `RegistrationStateMachine` class(沿 Phase 0.7 §7.5)
- ❌ **不**抽 `RegistrationPolicyService` class(沿 Phase 0.7 §6;`registrationDeadline` 不实施)
- ❌ **不**抽 `AppMyRegistrationsPresenter` class(沿 P0/P1 过渡;**仅在 P2-5b 第二次复用时**才抽)
- ❌ **不**抽 `AuditRecorder` class(沿 Phase 0.7 §8;复用既有 `AuditLogsService.log` 范式)
- ✅ **仅**新增 method 时严格遵守 Phase 0.7 §11 Refactor Triggers(新 mobile endpoint → 必须 Mobile Controller + App DTO + Mapper)

---

## 16. 待用户拍板项

> 本评审稿冻结前由用户回答 / 接受默认建议。
> **§16 拆为两小节**(沿 SHOULD-FIX #2):
>   - **§16.A 已默认锁定 / 用户复审即可**:已被 D-P2-5-N 或本评审稿正文锁定,列出供用户**一次性复审**(若同意默认建议即不需逐项决议)
>   - **§16.B 真正待用户拍板**:本评审稿**未锁定**,需用户**逐项明确**默认建议是否接受

### 16.A 已默认锁定 / 用户复审即可

| # | 决议项 | 默认锁定 | 锁定源 |
|---|---|---|---|
| **16.A.1** | `AppMyActivityListItemDto.myRegistrationStatusCode` 取值优先级(active > reject > cancelled)| ✅ **锁定** | §11.2 + D-P2-5-3 |
| **16.A.2** | `AppMyActivitiesService` 物理位置 `src/modules/activities/`(归"我的活动"语义,沿 P2-4 `AppActivitiesService` 同模块隔离)| ✅ **锁定** | D-P2-5-4 + §6.2 |
| **16.A.3** | `myRegistrationStatusCode` 字段命名(vs `myRegStatusCode` / `registrationStatusCode`)| ✅ **锁定** = `myRegistrationStatusCode`(命名显式 + 与 §11.2 取值规则一致)| §8.2.3 + §16.A.1 |
| **16.A.4** | P2-5a 是否预拆 P2-5a-1(`/my/registrations` × 2)+ P2-5a-2(`/my/activities` × 1) | ❌ **不预拆**(P2-5a 单 PR ~350-450 行,符合 < 500 红线)| D-P2-5-1 + §4 |
| **16.A.5** | 是否在本评审稿冻结 PR 中同步增补 [`docs/app-api-phase-2-review.md §11.3`](app-api-phase-2-review.md) 引用条目 | ❌ **本 PR 不夹带**(沿 process.md A 档不混档;由下一个 docs PR 顺手做)| §2.2 |
| **16.A.6** | `registrationDeadline` 过期是否在 P2-5b 启用拒报(是否同意 D-P2-5-11 的"P2-5 v0 不夹带"处理) | ❌ **不启用**(沿 D-P2-5-11;若后续启用需 `RegistrationPolicyService` 或等价策略层单独立项,**禁止**在 controller 硬编码 deadline 判断)| D-P2-5-11 + §10.4 + §14.17 |
| **16.A.7** | mapper 落 controller 私有 method 还是落新建薄壳 `AppMyRegistrationsService` | ✅ **新建薄壳 `AppMyRegistrationsService`**(controller 只收参,薄壳做 `AppIdentityResolver.resolve` + `assertActivityPublishedOrThrow` + thin-wrap 既有 `ActivityRegistrationsService`)| §6.4 + 沿 P2-2 `AppProfileService` / P2-4 `AppActivitiesService` 范式 |

### 16.B 真正待用户拍板

| # | 决议项 | 默认建议 | 沿用源 |
|---|---|---|---|
| **16.B.1** | `AppMyActivitiesService.listForMember` 实施方案 A(两阶段查询)/ B(`_count` + GroupBy)/ C(`$queryRaw`) | ⏳ **方案 A 推荐**(沿 v2 admin list 双 query 范式 + Phase 0.7 §4.4);P2-5a PR 实施时再最终决议 | §11.3 |
| **16.B.2** | `AppMyRegistrationDto` / `AppMyRegistrationListItemDto` 是否返 `memberId` 字段 | ⏳ **默认不返**(本人已知自己的 memberId via `/me/account.linkedMemberId`;沿 P2-4 v0.1 收窄精神);若需返,沿 §8.2.1 / §8.2.2 字段表小修 | §8.2.1 / §8.2.2 |
| **16.B.3** | audit `extra` 是否扩展 `surface: 'app'` 字段以区分 App 与 v2 me path | ⏳ **默认不扩展**(沿 §12.4;`actorRoleSnap` + `auditMeta.ua` 已可区分);若审计运营需要,P2.x 单独立项 | §12.4 + §14.20 + Phase 2 review §11.3 |
| **16.B.4** | `/my/registrations` 是否支持 `activityId` filter | ⏳ **默认不支持**(沿 P2-4 query 严格白名单精神);若产品需要"按活动查我的所有报名历史",P2.x 单独立项 | §8.2 + §16.A.4 拆分精神 |
| **16.B.5** | `extras` 是否在本期对常见敏感字段名(`password*` / `secret*` / `token*`)做 audit mask | ⏳ **默认不做**(沿 D-P2-5-12 / §12.3;v2 Q-A13 用户自定义 JSON 不嵌套校验);仅作 P2.x 风险记录(§14.9)| D-P2-5-12 + §12.3 + §14.9 |
| **16.B.6** | `assertActivityPublishedOrThrow` 放 `ActivityRegistrationsService` 的 public method 还是薄壳 `AppMyRegistrationsService` 内 inline | ⏳ **默认薄壳内 inline 校验**(不污染既有 `ActivityRegistrationsService` 公共 API);P2-5b PR 评审稿最终决议 | §6.4 推荐方案 B + §9.4 |
| **16.B.7** | **`isPublicRegistration=false` 是否也统一抛 `ACTIVITY_NOT_FOUND=20001`**(SHOULD-FIX #4 新增)| ⏳ **默认 ❌ 不统一,保留 `ACTIVITY_NOT_PUBLIC_REGISTRATION=20120`**(沿 §9.3 边界说明;`isPublicRegistration=false` 的 published 活动 App 端仍可见,返 20120 不泄漏额外可观测性);若用户要求进一步收窄 App 可观测性,可改为统一 20001 让 App 完全看不到此类活动差别 | §9.3 边界说明 + SHOULD-FIX #4 |

---

## 17. implementation 拆 PR 建议

### 17.1 PR 串(承接 [phase-2-review.md §8.1 P2-5 行](app-api-phase-2-review.md))

| PR | 范围 | 档位 | 依赖 | 预估 diff |
|---|---|---|---|---|
| **本 PR(P2-5 docs review)** | 本评审稿落地 `docs/app-api-p2-5-registrations-review.md` v0(单文档)| **A 档** | 本评审稿冻结后由 P2-5a impl PR 引用 | ~1500-2000 行(纯 docs)|
| **P2-5a impl** | `/my/registrations` × 2(GET list + detail)+ `/my/activities`(GET)+ `AppMyRegistrationsController`(读 3 methods)+ `AppMyRegistrationsService`(薄壳;读 3 methods)+ `AppMyActivitiesService`(新建)+ **5 个新 DTO 文件 = 3 核心(`AppMyRegistrationListItemDto` / `AppMyRegistrationDto` / `AppMyActivityListItemDto`)+ 2 Query(`ListAppMyRegistrationsQueryDto` / `ListAppMyActivitiesQueryDto`)** + e2e + contract | **C 档** | P2-4a + P2-4b impl 全合入 + 本评审稿冻结 | < 500 行 |
| **P2-5b impl** | `POST /my/registrations` + `PATCH /my/registrations/:id/cancel` + `AppMyRegistrationsController`(写 2 methods)+ `AppMyRegistrationsService`(扩展 + `assertActivityPublishedOrThrow` inline)+ **2 个新核心 DTO 文件**(`CreateAppMyRegistrationDto` / `CancelAppMyRegistrationDto`)+ e2e + contract | **C 档** | P2-5a impl 全合入 | < 500 行 |
| **P2-6 evaluation review** | 独立 PR(沿 P2-6 评审稿命名)| **A 档** | P2-1 已合入(已满足)— 可与 P2-5a / P2-5b 并行起草 | 待估算 |
| **P2-7 evaluation review** | 独立 PR | **A 档** | 同上 | 待估算 |
| **P2-8 收尾**(沿 phase-2-review.md §8.1)| `docs/current-state.md` 回填 + handoff 段(若到 release 节奏)+ `CHANGELOG.md` Unreleased + Swagger Tag 复核 | **A 档** | P2-1 ~ P2-7 全合入 | < 200 行(docs)|

### 17.2 PR 串铁律

1. **本评审稿 docs PR 不动代码**:仅落 `docs/app-api-p2-5-registrations-review.md` 单文档;A 档
2. **P2-5a / P2-5b 各自独立评审稿不再起草**(本评审稿同时覆盖);P2-5a / P2-5b 实施 PR 启动前**仅**需:
   - 复核本评审稿 + Phase 0.5 §10.2 + Phase 0.6 + Phase 0.7 + P2-4 review
   - 列出 OpenAPI snapshot diff 摘要(沿 Phase 1 review §5 范式)
   - 列出**严格不做**清单(沿本评审稿 §15)
   - 用户拍板范围,不夹带
3. **P2-5b 不得在 P2-5a 合入前立项**(沿 §4.5)
4. **每 PR 完成后必须用户拍板才进下一个**(沿 [`process.md §7`](process.md))
5. **P2-5a / P2-5b 各自 PR 评审稿(若起草)不修订本评审稿**;若实施过程发现本评审稿与代码冲突,**暂停**并向用户汇报

### 17.3 PR 描述模板(参考 [Phase 1 review §2.2.4 / §2.3.5](api-client-boundary-phase-1-review.md))

```markdown
## P2-5a(或 P2-5b)— PR

档位:**C 档**(沿 docs/app-api-p2-5-registrations-review.md §17.1)

## 范围
- 新增 endpoint(列表):...
- 新增 App DTO(列表):...
- 新增 service method(列表):...
- 新增 controller 文件(列表):...

## 严格不做
- 不动 prisma/schema.prisma
- 不动 migration
- 不动旧 /api/v2/* 行为
- 不动 /api/v2/users/me/* / /api/v2/activities/:id/registrations/* 任何 path
- 不动 Role / UserStatus / MemberStatus enum
- 不新增 Permission seed / RbacRole
- 不引入 Redis / queue / cron
- 不引入新依赖
- 不动 Phase 1A Swagger Tag
- 不实施 registrationDeadline / cancelWindow / genderRequirement 校验
- 不实施 P2-6 / P2-7 / Phase 1B 任何范围

## 准入校验
- 沿 docs/app-api-p2-5-registrations-review.md §7.1 / §7.2
- 5 endpoint 全部前置 AppIdentityResolver.resolve + assertCanUseApp

## 数据可见性 / DTO 隔离
- 沿 docs/app-api-p2-5-registrations-review.md §8
- 严禁 extends / Pick / Omit / IntersectionType / PartialType / OmitType admin DTO 构造 App DTO

## 验收命令
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm test:e2e

## OpenAPI snapshot diff 摘要
- 新增 path(P2-5a):[3 完整列表]
- 新增 path(P2-5b):[2 完整列表]
- 删除 path:**0**
- 修改 path:**0**(旧 path 全不动)
- 新增 tag:[Mobile - My Registrations / Mobile - My Activities]

## E2E 覆盖
- 沿 docs/app-api-p2-5-registrations-review.md §13.3 / §13.4 / §13.5 / §13.6 全套用例

## 回退方案
git revert 即可;新增 path 删除不影响旧 path
```

---

## 修订历史

| 日期 | 版本 | 摘要 |
|---|---|---|
| 2026-05-20 | v0 | 本评审稿 v0 创建;P2-5a + P2-5b 5 endpoint 评审稿;13 项 D-P2-5-N 决议锁定;沿 Phase 0.5 §10.2 D-1~D-4 + Phase 0.6 + Phase 0.7 + Phase 2 review + P2-2/P2-3/P2-4 范式继承;13 项待决议项留 §16 |
| 2026-05-20 | v0.1 | 5 项 SHOULD-FIX 小修(沿只读核验报告):**#1** 统一 DTO 数量口径(TL;DR #5 / §4.2 / §17.1 均明确"7 个新 DTO 文件 = 5 核心 + 2 Query");**#2** §16 拆为 §16.A 已默认锁定(7 项)+ §16.B 真正待用户拍板(7 项);**#3** 消除 §16.1 与 D-P2-5-11 冗余(并入 §16.A.6 作为复审项);**#4** §9.3 增补 `isPublicRegistration=false` 边界说明 + §16.B.7 新增"是否统一抛 20001"决议项;**#5** §8.1 提前说明 `extends PaginationQueryDto` 唯一允许例外(避免 §8.2.4 query DTO 误判为违规)|

---

> **本评审稿生效时间**:2026-05-20(P2-5 实施前评审稿 v0)。
> **当前状态**:⏳ 待用户拍板冻结。
> **过期条件**:P2-5a + P2-5b 实施 PR 均合入后,本评审稿降为"历史评审"性质,不回改,沿 [`docs/V2红线与复活路径.md §5.1`](V2红线与复活路径.md) handoff 历史规则。
