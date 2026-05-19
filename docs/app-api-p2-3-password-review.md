# SRVF App API P2-3 Password Review

> **状态**:**P2-3 实施前评审稿 v0**(2026-05-20)
> **性质**:**implementation review**(沿 [`docs/process.md §6`](process.md))。**不是代码改造,不是 migration,不是 endpoint 增减**。
> **范围**:仅评审 `PUT /api/app/v1/me/password` 一个 endpoint 的入参 / 返回 / 鉴权 / 数据源 / token 联动 / audit / 限流 / 测试 / 风险。**不**起草任何代码。
> **前置必读**:
>   - [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md) §2(P2-3 在 PR Batch 列锁定)+ §6(准入)+ §8.1(PR 串)+ §9.3 #14(测试)+ §10(风险)
>   - [`docs/app-api-p2-2-profile-review.md`](app-api-p2-2-profile-review.md) §7.4(显式 safeDto 范式)+ §11(风险表 10.11a 反模式)
>   - [`docs/app-permission-boundary-review.md`](app-permission-boundary-review.md) §10.2 D-1 / D-2 / D-4(身份准入 + 路径分层)
>   - [`docs/data-access-lifecycle-boundary-review.md`](data-access-lifecycle-boundary-review.md) §2(L0-L3 字段分级)+ §5(User/Member 生命周期)
>   - [`docs/code-architecture-boundary-review.md`](code-architecture-boundary-review.md) §2(DTO/Presenter)+ §3(三层授权)+ §13(P0/P1 触发不立即抽 service)
>   - [`docs/first-release-p0d-change-my-password-review.md`](first-release-p0d-change-my-password-review.md) §3 / §5 / §7(P0-D 全套 zero drift)
>   - [`docs/first-release-p0e-refresh-token-review.md`](first-release-p0e-refresh-token-review.md) §3 / §4 / §7.1(refresh token rotation + 联动撤销 + access 行为锁定)
>   - [`CLAUDE.md §9 P0-D / P0-E 子节`](../CLAUDE.md) + [`CLAUDE.md §19.7 D-5 ~ D-8`](../CLAUDE.md)
> **冲突优先级**:本评审稿优先级**最低**;冲突时让步给上述所有评审稿与 `CLAUDE.md` / `AGENTS.md` / `ARCHITECTURE.md` / `srvf-foundation-baseline.md` / V2 红线。
> **解除条件**:本评审稿经用户拍板冻结后,P2-3 实施 PR 允许在 [`docs/process.md`](process.md) §3 + §4 流程内立项。

---

## 0. TL;DR

1. **范围严格**:仅 1 个 endpoint(`PUT /api/app/v1/me/password`),**0 个新 DTO**(沿 Phase 2 review §2 + P0-D zero drift,直接复用 `ChangeMyPasswordDto`),**0 个新 service**(直接复用 `UsersService.changeMyPassword`),**0 个新 BizCode**,**0 个新 audit event**,**0 个新 throttler 实例**。
2. **入参 DTO 零漂移**:复用 `ChangeMyPasswordDto { oldPassword, newPassword }`(沿 Phase 2 review §2 line 97 + [`users.dto.ts:176-200`](../src/modules/users/users.dto.ts) zero drift)。**禁止**新建 `UpdateAppSelfPasswordDto` / `AppChangePasswordDto`;**禁止**从 `ChangeMyPasswordDto` `extends` / `Pick` / `Omit` 衍生 App DTO(P2-2 §7.4 范式适用前提是 Admin DTO,本 DTO 是 Mixed 共享 P0-D DTO,沿 zero drift 直接复用)。
3. **返回沿 P0-D zero drift**:返回 `UserResponseDto`(由 `userSafeSelect` 保证永不含 `passwordHash`)。**不**新建 `AppPasswordChangeResponseDto`(沿 §3);**不**返 204 No Content(P0-D 已锁定为 200 + UserResponseDto,zero drift)。
4. **准入决策(✅ 2026-05-20 v0.1 用户拍板锁定 D-P2-3-1 = X)**:`PUT /me/password` 是 Phase 2 P0 范围内**唯一****不**强约 `canUseApp=true` 的端点 — `memberId != null` 与 `Member.status=ACTIVE` 均 ⚠️ 可选;**Admin without member 允许通过 App endpoint 改密码**(沿 P0-D zero drift + Phase 2 review §6.2)。理由:**改密是账号级自助操作,不是 member-domain 数据访问;不暴露 member 业务数据;安全由旧密码校验 + `@PasswordChangeThrottle()` + refresh token 撤销 + `password.change.self` audit 四道闭合控制**。**例外边界严格**:该豁免**仅**适用于 `PUT /api/app/v1/me/password`,**禁止**被 `/me/profile` / `/activities/*` / `/my/*` / `/tasks/*` / `/managed/*` 复用(沿 §4.6 锁定列表)。
5. **复用 P0-E PR-3 全套联动撤销**:撤销该 user 全部 refresh token(`revokedReason='self-password-change'`)+ 写 audit `password.change.self`(含 `extra.refreshTokensRevoked` count);**access token 不主动吊销**(沿 P0-D §5.7 + P0-E v1 D-4)。e2e 必须沿 [`users-change-my-password.e2e-spec.ts`](../test/e2e/users-change-my-password.e2e-spec.ts) §7.5 反向锁定断言"改密后旧 access 仍可调 `/me`"逐字复制到 App 路径,**不**破。
6. **限流复用 P0-D**:`@PasswordChangeThrottle()` + `password-change` throttler 实例(5/60 IP);**不**新建 `'app-password-change'` throttler。**严禁**与 `'refresh'` / `default`(login)/ `'logout-all'` 混用。
7. **Controller 落地**:在已有 [`AppMeController`](../src/modules/users/controllers/app-me.controller.ts) 增加 `@Put('password')` method,**不**新建 `AppPasswordController`;controller 内**必须显式构造 safeDto**(沿 P2-2 §7.4 风险表 10.11a 范式)再传给 `UsersService.changeMyPassword`,**禁止**透传 raw request body。
8. **测试**:新增 `test/e2e/app-me-password.e2e-spec.ts`(独立 e2e 文件,沿 P0-D `users-change-my-password.e2e-spec.ts` 范式逐项移植),覆盖 Phase 2 review §9.2 9 类 + §9.3 #14 P0-D 全套 + Path stability(旧 `/api/users/me/password` 行为逐字不变)。
9. **PR 大小**:预计 < 300 行 diff(1 endpoint + 0 新 DTO + 0 新 service + 20-25 e2e + contract snapshot 增量;沿 Phase 2 review §8.1 P2-3 < 500 行);**不**触发拆分。
10. **未启动**:P2-3 implementation / P2-4(`/activities/available` / `/activities/:id`)/ P2-5+ / Phase 1B(`/api/auth/v1/*` / `/api/public/v1/*` alias)/ 旧 `/api/users/me/password` 行为变更 — 全部留独立评审稿或后续 PR 串。

---

## 1. P2-3 最终 endpoint 设计

### 1.1 接口表

| Method | Path | Purpose | Surface | Scope | Auth | DTO | Service / Resolver reuse | Risk |
|---|---|---|---|---|---|---|---|---|
| PUT | `/api/app/v1/me/password` | App 视角本人自助改密(P0-D / P0-E 全套行为继承) | mobile | self | `JwtAuthGuard` + `@PasswordChangeThrottle()`(5/60 IP);**不**强约 `canUseApp=true`(沿 §4 + Phase 2 review §6.2 line 340) | `ChangeMyPasswordDto`(入参;**直接复用** [`users.dto.ts:176-200`](../src/modules/users/users.dto.ts))+ `UserResponseDto`(出参;**直接复用** [`users.dto.ts:19-49`](../src/modules/users/users.dto.ts);永不含 `passwordHash`)| **直接复用** `UsersService.changeMyPassword(currentUser, safeDto, auditMeta)`([`users.service.ts:211-270`](../src/modules/users/users.service.ts));controller 内**必须显式构造 safeDto**(沿 §6.4) | **高(沿 P0-D + P0-E 安全敏感面)** |

### 1.2 路径归属(沿 D-5.4 / Phase 2 review §2.1)

```txt
/api/app/v1/me/password  ← identity / account / password;归 me/* 段(沿 Phase 0.5 §10.2 D-4)
```

**不**归 `my/*`(`my/*` = "我的业务记录";password 是 account 安全敏感操作,不是业务记录)。

### 1.3 实施可行性

| 维度 | 复用项 | 来源 | 备注 |
|---|---|---|---|
| Controller class | `AppMeController` | [`controllers/app-me.controller.ts`](../src/modules/users/controllers/app-me.controller.ts) | P2-1 + P2-2 已建;新增 1 个 `@Put('password')` method;沿 P2-2 同 controller 内 helper 范式 |
| Controller helper | `buildAuditMeta(req)` | [`users.controller.ts:121-127`](../src/modules/users/users.controller.ts) | P0-D 已建;复制到 `AppMeController` 私有 helper(沿 `emergency-contacts.controller.ts` 范式 + P0-D PR-3 D6 v1.1 §11.2 显式 AuditMeta 范式;**不**引入 `cls-rs` / AsyncLocalStorage)|
| Input DTO | `ChangeMyPasswordDto` | [`users.dto.ts:176-200`](../src/modules/users/users.dto.ts) | P0-D 已建;字段集严格 `{ oldPassword, newPassword }`;**直接复用** zero drift |
| Output DTO | `UserResponseDto` | [`users.dto.ts:19-49`](../src/modules/users/users.dto.ts) | P0-D 已建;沿 `userSafeSelect` 永不含 `passwordHash`;**直接复用** zero drift |
| Service method | `UsersService.changeMyPassword(currentUser, dto, auditMeta)` | [`users.service.ts:211-270`](../src/modules/users/users.service.ts) | P0-D + P0-E 已建;完整闭包:findFirst → bcrypt.compare → `===` check → bcrypt.hash → tx.update + refresh revoke + audit;**直接复用**(沿 Phase 2 review §2)|
| Throttle decorator | `@PasswordChangeThrottle()` | [`password-change-throttle.decorator.ts`](../src/common/decorators/password-change-throttle.decorator.ts) | P0-D 已建;throttler 实例 `password-change` 已注册于 [`throttle-options.ts:28-31`](../src/bootstrap/throttle-options.ts) |
| BizCode | `BAD_REQUEST` / `UNAUTHORIZED` / `USER_NOT_FOUND` / `OLD_PASSWORD_INVALID` / `NEW_PASSWORD_SAME_AS_OLD` / `TOO_MANY_REQUESTS` | [`biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) | 全部已建;**零新增** |
| AuditLogEvent | `password.change.self` | [`audit-logs.types.ts:40`](../src/modules/audit-logs/audit-logs.service.ts) | P0-D 已建;**零新增** |
| Capability | `account.canChangePassword` | [`app-capability.service.ts`](../src/modules/users/app-capability.service.ts)(P2-1 已实装) | P2-1 已建为 capability map 字段;P2-3 是该 capability 对应的后端 endpoint;前端按该字段控 UI 入口 |

**关键**:**P2-3 与 P2-1 / P2-2 同等地位是 "code-thin" PR** — 几乎全部能力在 P0-D + P0-E + P2-1 已就位,P2-3 仅:
- 加 1 个 controller method
- 加 1 段 controller 私有 helper(`buildAuditMeta`;或新建共享 `app-controller-helpers.ts`,沿 §6.3 决议)
- 加 1 个 e2e 文件

---

## 2. 入参 DTO 设计

### 2.1 复用 vs 新建分析

**两条路线**:

| 路线 | 行为 | 利 | 弊 |
|---|---|---|---|
| **A(本评审稿推荐)**:复用 `ChangeMyPasswordDto` | App endpoint 接受字面相同的 `{ oldPassword, newPassword }` | 沿 Phase 2 review §2 line 97 锁定 + P0-D zero drift;contract 简单(0 新 DTO);前端 SDK 复用类型 | 与 Phase 0.7 §2.2 "App DTO 不复用 Admin DTO" 原则的**字面**冲突 |
| B:新建 `UpdateAppSelfPasswordDto` | App endpoint 接受**独立** App DTO | 字面满足 Phase 0.7 §2.2 隔离;App / 旧 path 演化解耦 | 字段集与 `ChangeMyPasswordDto` 完全相同(`extends` / `Pick` / `Omit` 全部被 Phase 0.7 §2.2 + Phase 2 review §5.2 #1 禁止);只能完全独立写 2 个相同字段 DTO,纯仪式;Phase 2 review §2 line 97 已锁推荐 A |

### 2.2 推荐:路线 A(复用)

**为什么 `ChangeMyPasswordDto` 复用不违反 Phase 0.7 §2.2 / Phase 2 review §5.2 #1**:

1. **`ChangeMyPasswordDto` 不是 Admin DTO**:它服务于 v1 P0-D `/api/users/me/password`,而后者**鉴权 = 任意登录用户**(沿 [`users.controller.ts:111-117`](../src/modules/users/users.controller.ts),无 `@Roles(...)`),**不**归 Admin Surface。它是 **"v1 me/* mixed shared DTO"**,沿 Phase 0.6 §1.3 Mixed Surface 分类。
2. **字段集恰好对齐 App 视角**:仅 `oldPassword` + `newPassword`,**完全不含**任何需要 App 视角脱敏 / 字段裁剪的语义(沿 Phase 0.6 §2.3 字段分级);两个字段都是入参 L0(临时 plaintext;非持久化)。
3. **沿 Phase 2 review §2 line 97 明文锁定**:"`ChangeMyPasswordDto`(沿 P0-D zero drift)" — P2-3 设计起点即"沿 P0-D"。
4. **新建独立 DTO 是纯仪式**:`UpdateAppSelfPasswordDto` 字段集**只能**与 `ChangeMyPasswordDto` 完全等价(`extends` / `Pick` / `Omit` 被 Phase 0.7 §2.2 / Phase 2 review §5.2 #1 / §10.1 风险表禁用 → 只能从头复制 4 行装饰器),增加 OpenAPI snapshot 噪音,**不**提供任何安全或解耦价值。

### 2.3 字段白名单铁律(沿 P0-D §5.1)

`ChangeMyPasswordDto` 字段集**严格 2 项**(`{ oldPassword, newPassword }`)。**禁止**在 P2-3 实施 PR 中向该 DTO 加任何字段(即使是 App-only 字段):

- ❌ `confirmPassword` / `newPasswordConfirm`(沿 P0-D §3 不引入,与 v1 一致)
- ❌ `passwordHash`(沿 P0-D §5.1;**禁止**前端发 hash)
- ❌ `userId` / `memberId` / `id`(本人改密永远靠 `currentUser`,**不**接他人 ID)
- ❌ `role` / `permissions` / `status`(沿 P0-D §3 + v1 §13;**禁止**通过改密接口提权)
- ❌ `refreshToken` / `accessToken` / `token`(沿 P0-E §5.2;**禁止**前端传任何 token 字段)
- ❌ `deviceId` / `clientId` / `keepSignedIn` / `rememberMe`(沿 P0-E §5.1 D-2 LoginDto zero drift;**禁止**夹带设备维度)
- ❌ `oldPasswordConfirmHash` / `pinCode` / `mfaCode`(P2-3 不含二因子;若未来需要 MFA 单独立项)

所有 DTO 外字段由全局 `forbidNonWhitelisted: true` 兜底 → `BAD_REQUEST=40000`(沿 [`CLAUDE.md §7`](../CLAUDE.md))。

### 2.4 不与 `LoginDto` / `RefreshTokenDto` / `LogoutDto` 互通

`LoginDto`(`{ username, password }`)/ `RefreshTokenDto`(`{ refreshToken }`)/ `LogoutDto`(`{ refreshToken }`)是**入参 schema zero drift**(沿 P0-E v1 §5.1 / §5.2 / §5.3);本 `ChangeMyPasswordDto` 与三者**字段集严格不相交**,**禁止**复用任何 LoginDto / Refresh / Logout 字段做密码改造。

---

## 3. 返回 DTO 设计

### 3.1 三档候选

| 档 | 返回 | 评估 | Phase 2 P2-3 是否推荐 |
|---|---|---|---|
| **A 档(推荐)**:沿 P0-D zero drift | HTTP 200 + `{ code: 0, message: 'ok', data: UserResponseDto }`;`data.id` / `data.username` / `data.role` 等沿 [`users.dto.ts:19-49`](../src/modules/users/users.dto.ts) | 与 v1 `/api/users/me/password` 行为字面对齐;前端单次响应即可刷新本地缓存 user 摘要(沿 P0-D §3 / §5.2 步骤 7)| ✅ 是 |
| B 档:`AppMeAccountDto` | HTTP 200 + `data: AppMeAccountDto`(P2-1 已建;含 `canUseApp` / `appAccessReason` 派生字段) | App 视角"账号"对象更贴近 me 段语义;但与 P0-D 旧 path 返回不一致,需在 controller 内做投影 + 增加 PR diff | ⚠️ 备选 |
| C 档:204 No Content | HTTP 204(无 body) | 最小化响应;但与 P0-D 200 + UserResponseDto **行为漂移**,沿 ResponseInterceptor 范式与全局响应包装契约冲突([`CLAUDE.md §4`](../CLAUDE.md))| ❌ 否 |

### 3.2 推荐:A 档(沿 P0-D zero drift)

**理由**:

1. **P0-D zero drift**:Phase 2 review §2 line 97 + P0-D §3.1 已锁定 `UserResponseDto`;P2-3 沿用,**不**新建 `AppPasswordChangeResponseDto`。
2. **与 PATCH `/me/profile`(P2-2)行为对称差异是 P0-D 已锁**:P2-2 `/me/profile` 返 `AppSelfProfileDto`(App DTO 隔离),P2-3 `/me/password` 返 `UserResponseDto`(沿 P0-D zero drift)。差异源于历史 — P2-2 是 P2-2 新建的 App 视角,P2-3 是 P0-D 沿用的 v1 Mixed DTO。**Phase 2 P2-3 不为求"齐整"打破 P0-D zero drift**。
3. **永不返敏感字段**:`UserResponseDto` 经 `userSafeSelect` 保证永不含 `passwordHash` / `deletedAt`;此为 P0-D / P0-E e2e 强断言(沿 [`users-change-my-password.e2e-spec.ts:67-68`](../test/e2e/users-change-my-password.e2e-spec.ts))。P2-3 e2e 沿用该反向断言。

### 3.3 响应**绝对不**包含的字段

无论决议哪档,P2-3 响应**禁止**包含:

- ❌ `passwordHash`(沿 [`CLAUDE.md §9`](../CLAUDE.md) + `userSafeSelect`)
- ❌ `accessToken` / `refreshToken` / `tokenHash`(沿 P0-E §5.4 + L3 字段;改密**不**返新 token,前端继续用旧 access token 或重新登录获取)
- ❌ `oldPasswordHash` / `newPasswordHash`(沿 P0-D §5.6 audit 不写 hash 同理)
- ❌ 任何 `refreshTokenRotated` / `secretKey*` / `secretId*` / 完整 signed URL(沿 L3 字段)
- ❌ `refreshTokensRevokedCount`(沿 P0-E §5.9 — 撤销 count 进 audit `extra`,**不**进 response body;前端不需要)

### 3.4 与 PATCH `/me/profile`(P2-2)的对称选择

如果未来用户在 PR-Z 决议把 P0-D `/api/users/me/password` 也升级为 App DTO(沿 Phase 5 Mixed 物理拆分),那是**独立立项**。**Phase 2 P2-3 不做该升级**;沿 §4.5 锁定。

---

## 4. Identity / Access 规则

### 4.1 准入要求矩阵(沿 Phase 2 review §6.2 line 340)

| 准入项 | 要求 | 来源 |
|---|---|---|
| `JwtAuthGuard` | ✅ 必需(沿全局 APP_GUARD 注册) | [`CLAUDE.md §8`](../CLAUDE.md) |
| `User.status = ACTIVE` + `deletedAt = null` | ✅ 必需(沿 `JwtStrategy.validate`) | [`jwt.strategy.ts`](../src/modules/auth/strategies/jwt.strategy.ts) |
| `User.memberId != null` | ⚠️ **可选**(沿 Phase 2 review §6.2 line 340 表格 `PUT /me/password` 行)| Phase 2 review §6.2 |
| `Member.status = ACTIVE` + `deletedAt = null` | ⚠️ **可选** | 同上 |
| `canUseApp = true` | ⚠️ **不强约** | 同上 |

### 4.2 决议项 D-P2-3-1:Admin without member 是否允许通过 `/api/app/v1/me/password` 改密?

**这是本评审稿必须用户拍板的核心决策**。

**两个候选**:

#### 4.2.1 选项 X(推荐;沿 Phase 2 review §6.2 line 340)

**Admin / SUPER_ADMIN without member 允许通过 `/api/app/v1/me/password` 改密**。

**理由**:

1. **沿 P0-D zero drift**:[`users-change-my-password.e2e-spec.ts:272-308`](../test/e2e/users-change-my-password.e2e-spec.ts) 已硬断言"SUPER_ADMIN / ADMIN 走 `/api/users/me/password` 改自己 → 成功"。若 App endpoint 收紧为"必须 `canUseApp=true`",将出现**两套行为**:
   - `PUT /api/users/me/password`(任意登录用户;含 admin without member ✅)
   - `PUT /api/app/v1/me/password`(必须 `canUseApp=true`;admin without member ❌)
   
   两套行为对运维 / 前端联调极不友好,违反 [`CLAUDE.md §0`](../CLAUDE.md) "稳定、清晰、可维护、AI 友好"。
2. **改密是账号级操作,不是业务级操作**:`canUseApp=false` 拒绝是为了防止"队员档案失效但仍调业务接口"(读 / 写 member / activity / registration 数据)。改自己的账号密码**不涉及任何业务字段**,**不读 member 表业务字段**,**不写 member 表**,**不写 activity / registration / attendance 任何表**。
3. **Phase 2 review §6.2 已锁定**:line 340 表格 `PUT /me/password` 一行的"`User.memberId != null` **必填**?" 与 "`Member.status=ACTIVE` + `deletedAt=null`?" 两列**均**标 ⚠️ 可选,**附注**"admin 无 member 也允许改密"。本评审稿**沿用**该锁定,**不**翻案。
4. **Admin without member 的 App 使用场景明确**:运维 ops-admin 账号 / 临时调试账号 / 新建未绑 member 的 admin 账号都需要在 App / Web 任一处改自己密码。若 App 收紧,运维必须切回 PC 后台旧路径,前端必须区分两套 path,**用户体验断裂**。
5. **不破 D-5.2**(Admin 兼队员走 linked-member self perspective)语义:D-5.2 锁定**"业务字段可见性"**(member / activity / registration / attendance 等)**不因 role 扩大**;改密接口**不涉及业务字段可见性**,与 D-5.2 严格正交。

#### 4.2.2 选项 Y(用户 prompt 起初建议)

**Admin without member 不允许通过 `/api/app/v1/me/password` 改密;必须走 PC 后台旧 `/api/users/me/password`**。

**理由**(仅供对照):

1. App endpoint 默认要求 linked active member,严格遵守 D-5.2 字面 "App self perspective" 语义。
2. 行为面向"队员 App",理论上 admin 不应在 App 上做高敏操作。

**为什么本评审稿不推荐 Y**:

1. **与 P0-D 行为不一致**:P0-D `/api/users/me/password` 已支持 admin without member;P2-3 路径收紧会让运维误以为"App 路径就是新规则",对照下来反而困惑。
2. **Phase 2 review §6.2 锁定就是为了避免该错误**:review 文档在锁定该端点准入时**已**显式开特例 ⚠️ 可选,说明评审者已识别该陷阱。
3. **若强制走旧 path 改密**:意味着 admin 必须先有 PC 端访问能力 → 与"我们要给运维 mobile-friendly 体验"的初衷冲突。
4. **审计审查不增益**:audit `password.change.self` 已包含 actor 完整身份(`actorUserId` / `actorRoleSnap`);限流由 `@PasswordChangeThrottle` 兜底;无额外越权面。

### 4.3 决议结果:✅ **D-P2-3-1 = X(2026-05-20 v0.1 用户拍板锁定)**

**最终决策**:

```txt
D-P2-3-1 = X
Admin without member is allowed to use PUT /api/app/v1/me/password.
```

**锁定理由(写入正文,不再开放重评估)**:

- Password change is **account-level self-service**, not member-domain access.
- It **does not expose member business data**.
- Security is controlled by **old password verification, `@PasswordChangeThrottle()`, refresh-token revocation, and `password.change.self` audit**.

**未来会话铁律**:本决策**已锁定**;P2-3 实施 PR 与后续会话**禁止**自行重新评估、建议回滚、或以"App 端默认要求 linked active member"为由收紧 `/api/app/v1/me/password` 准入。若用户主动要求重开,**必须**先暂停说明本节存在再讨论。

### 4.4 拒绝路径(实施选项 X;选项 Y 列保留作历史对照,**不实施**)

> **状态**:D-P2-3-1 = X 已锁(§4.3)。"选项 Y 行为" 列仅作历史评估对照保留,**不**作为 P2-3 实施目标;P2-3 e2e **只**断言"选项 X 行为"列。

| 场景 | 选项 X 行为(✅ 实施) | 选项 Y 行为(❌ 不实施,历史对照) |
|---|---|---|
| 未登录 / 过期 token | `UNAUTHORIZED=40100` + HTTP 401(`JwtStrategy.validate`) | 同 X |
| `User.status=DISABLED` 或软删 | `UNAUTHORIZED=40100` + HTTP 401(`JwtStrategy.validate` 阻断) | 同 X |
| `User.memberId=null`(admin / 未绑队员)| ✅ **通过**(沿 §4.2.1 / §4.3 锁定) | (历史对照)`FORBIDDEN=40300` + message "App 功能不可用:未绑定队员档案" |
| `Member.status=INACTIVE` | ✅ **通过** | (历史对照)`FORBIDDEN=40300` + message "App 功能不可用:队员档案已停用" |
| `Member` 软删 | ✅ **通过** | (历史对照)`FORBIDDEN=40300` + message "App 功能不可用:队员档案已删除" |
| `oldPassword` 错误 | `OLD_PASSWORD_INVALID=10005` + HTTP 401(沿 P0-D §5.3) | 同 X |
| `oldPassword === newPassword`(严格 `===`,**不** trim / toLowerCase)| `NEW_PASSWORD_SAME_AS_OLD=10006` + HTTP 400(沿 P0-D §5.3 + [`users.service.ts:226-232`](../src/modules/users/users.service.ts))| 同 X |
| `newPassword` 弱(< 8 / 缺字母 / 缺数字)| `BAD_REQUEST=40000` + HTTP 400 + message 含 `password` 关键词(沿 `ChangeMyPasswordDto` 装饰器)| 同 X |
| 缺 `oldPassword` / `newPassword` | `BAD_REQUEST=40000` + HTTP 400 + message 含字段名 | 同 X |
| 额外字段(`role` / `passwordHash` / `userId` 等)| `BAD_REQUEST=40000` + HTTP 400 + message 含字段名(`forbidNonWhitelisted`)| 同 X |
| 限流命中 | `TOO_MANY_REQUESTS=42900` + HTTP 429;**不**暴露 `Retry-After` / `X-RateLimit-*` 头(沿 P0-D §5.4)| 同 X |

### 4.5 旧 `/api/users/me/password` 行为锁定(沿 §10)

- 旧 path 行为**逐字不变**(沿 Phase 2 review §3.2 不动旧 path + §9.2 #9 path stability)
- e2e [`users-change-my-password.e2e-spec.ts`](../test/e2e/users-change-my-password.e2e-spec.ts) 全部 21 用例**继续通过**(`pnpm test:e2e` 验收强约)
- 旧 path **不** deprecate / **不** 加 301 redirect / **不** 加 dual-write 兼容层(沿 Phase 3 方案 C);两 path 并存

### 4.6 例外边界:`canUseApp=true` 豁免**仅**适用本端点(沿 D-P2-3-1 锁定)

> **核心铁律**:D-P2-3-1 = X 锁定的"Admin without member 允许使用"**仅**是 `PUT /api/app/v1/me/password` **单一端点**的特例豁免;**不是** App API 整体准入规则的松绑。任何把该豁免外推到其他 App endpoint 的行为**均视作越权**,PR review 强制拒绝。

**This exception applies only to** `PUT /api/app/v1/me/password`.

**It must not be reused by**:

- ❌ `/api/app/v1/me/profile`(GET + PATCH;P2-2 已锁 `canUseApp=true` 必需;沿 [`docs/app-api-p2-2-profile-review.md §5.4`](app-api-p2-2-profile-review.md))
- ❌ `/api/app/v1/activities/*`(P2-4 范围;`activities/available` + `activities/:id`;沿 Phase 2 review §6.2 `Member.status=ACTIVE` **必填**)
- ❌ `/api/app/v1/my/*`(P2-5 / P2-6 / P2-7 范围;`my/activities` + `my/registrations*` + `my/attendance-records` + `my/certificates`;沿 Phase 2 review §6.2 `Member.status=ACTIVE` **必填** + scope owner 双重校验)
- ❌ `/api/app/v1/tasks/*`(Phase 2 不实施;命名空间预留;沿 Phase 0.5 §3.2 / §4.1;未来实施时**必须** `canUseApp=true`)
- ❌ `/api/app/v1/managed/*`(Phase 2 不实施;命名空间预留;沿 Phase 0.5 §3.2 / §4.4;未来实施时**必须** `canUseApp=true` + 业务级负责人身份校验)

**为什么仅本端点豁免**:

1. **改密不读 / 不写 member 业务字段**:`UsersService.changeMyPassword` 的 service 闭包([`users.service.ts:211-270`](../src/modules/users/users.service.ts))**仅**访问 `User.passwordHash` 与 `RefreshToken` 表,**完全不**触碰 `Member` / `MemberProfile` / `MemberDepartment` / `Activity` / `ActivityRegistration` / `AttendanceRecord` / `Certificate` 等业务表 — 与 D-5.2 字段可见性铁律严格正交。
2. **改密的安全闭环已就位且独立**:旧密码 `bcrypt.compare` + `@PasswordChangeThrottle()` IP 限流(5/60)+ refresh token 全部撤销(P0-E)+ `password.change.self` audit(含 actor + `extra.refreshTokensRevoked`)四道控制完全在账号层闭合,不依赖 member 状态。
3. **其他 App endpoint 都触及 member-domain 数据**:`/me/profile` 读 member 摘要;`/activities/*` 读活动可参加性(依赖 member 在岗状态);`/my/*` 读 member 持有的业务对象;`/tasks/*` 与 `/managed/*` 触发管理 / 负责场景 — 全部**必须** `Member.status=ACTIVE`。
4. **若未来出现新"账号级自助"端点**(如绑定 / 解绑 OAuth 账号 / 改 username / 改 email),**必须**单独立项评审,**禁止**默认继承本豁免;每个新账号级端点都要独立论证"不读 / 不写 member 业务字段"才能复用本豁免语义。

**PR review 强制检查**:

P2-3 实施 PR 内,reviewer **必须** grep 确认:

- ✅ controller 内**仅** `PUT /me/password` method**不**调 `appIdentity.resolve + assertCanUseApp`(沿选项 X)
- ❌ 其他任何 App method(`getMe` / `getMeAccount` / `getMeCapabilities` / `getMyProfile` / `updateMyProfile` / 未来 P2-4+ 端点)**仍必须**保留各自的 `canUseApp` 判定路径(P2-2 `AppProfileService.assertCanUseApp` 等)
- ❌ **禁止**为图省事抽 `AppAccessOptional` / `AppAccessSkipped` 等公共 helper 把本豁免泛化为可复用机制

---

## 5. 错误码策略

### 5.1 复用现有 BizCode(零新增)

P2-3 涉及的全部 BizCode 均已在 [`biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) 实装:

| BizCode | code | message | httpStatus | 来源 PR | 触发位置 |
|---|---|---|---|---|---|
| `BAD_REQUEST` | 40000 | 请求参数错误 | 400 | v1 | DTO 校验(class-validator + `forbidNonWhitelisted`)|
| `UNAUTHORIZED` | 40100 | 未登录或登录已失效 | 401 | v1 | `JwtStrategy.validate` 失败 |
| `FORBIDDEN` | 40300 | 无权限访问 | 403 | v1 | (仅选项 Y;`canUseApp=false` 时)|
| `TOO_MANY_REQUESTS` | 42900 | 请求过于频繁,请稍后再试 | 429 | V1.1 §11.4 | `@PasswordChangeThrottle()` 命中 |
| `USER_NOT_FOUND` | 10001 | 用户不存在 | 404 | v1 | `findFirst + notDeletedWhere` 并发软删窗口兜底 |
| `OLD_PASSWORD_INVALID` | 10005 | 当前密码不正确 | 401 | P0-D #115 | `bcrypt.compare` 失败 |
| `NEW_PASSWORD_SAME_AS_OLD` | 10006 | 新密码不能与当前密码相同 | 400 | P0-D #115 | 严格 `===` 比较命中 |

### 5.2 不新增任何 BizCode

**P2-3 严禁新增以下任何 BizCode**(违反 = PR review 强制拒绝):

- ❌ `APP_PASSWORD_CHANGE_FORBIDDEN`(沿 P0-D §5.3 防细码段位破坏;选项 Y 直接复用 `FORBIDDEN`)
- ❌ `APP_MEMBER_NOT_LINKED` / `APP_MEMBER_INACTIVE`(沿 Phase 2 review §4.3 #8 + §6.3 临时复用 `FORBIDDEN`;P2-1 评审时已留待后续决议是否新增,P2-3 **不**抢号位)
- ❌ `OLD_PASSWORD_REQUIRED` / `NEW_PASSWORD_REQUIRED`(沿 `forbidNonWhitelisted` 兜底)
- ❌ `PASSWORD_CHANGE_RATE_LIMITED`(沿 `TOO_MANY_REQUESTS` zero drift)
- ❌ `APP_PASSWORD_CHANGE_DISABLED`(本期不引入"按账号禁用改密"语义;若未来运维诉求,独立立项)
- ❌ `REFRESH_TOKEN_INVALID` 在改密路径的额外触发(沿 P0-E §5.7 不细分,**禁止**在改密 service 内新增 refresh 相关码)

### 5.3 BizCode 段位现状(P2-3 启动前复核点)

沿 P0-D §9.4 + P0-E §10:`100xx` users 段已用 **10001-10007**(LOGIN_FAILED=10004 / OLD_PASSWORD_INVALID=10005 / NEW_PASSWORD_SAME_AS_OLD=10006 / REFRESH_TOKEN_INVALID=10007)。P2-3 实施 PR 前**必须**复核:

```bash
grep 'code: 1000[8-9]' src/common/exceptions/biz-code.constant.ts
```

应**无命中**(确认 P2-3 启动前无第三方 PR 抢号 10008 / 10009)。若抢号,**暂停**并向用户汇报。

P2-3 实施**不**占用任何新号位。

---

## 6. Token / refresh token 策略

### 6.1 P2-3 复用 P0-E PR-3 全套联动撤销(零新增)

[`users.service.ts:234-265`](../src/modules/users/users.service.ts) 已实装"本人改密 → 撤销该 user 全部 refresh token + 写 audit"事务闭包:

```ts
// (引用现有代码,沿 P0-D + P0-E PR-3)
return this.prisma.$transaction(async (tx) => {
  const updated = await tx.user.update({ where: { id }, data: { passwordHash }, select: userSafeSelect });
  const refreshRevoke = await tx.refreshToken.updateMany({
    where: { userId: currentUser.id, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { revokedAt: new Date(), revokedReason: 'self-password-change' },
  });
  await this.auditLogs.log({
    event: 'password.change.self',
    actorUserId: currentUser.id,
    actorRoleSnap: currentUser.role,
    resourceType: 'user',
    resourceId: currentUser.id,
    meta: auditMeta,
    extra: { refreshTokensRevoked: refreshRevoke.count },
    tx,
  });
  return updated;
});
```

**P2-3 直接复用此 service method**,**禁止**:

- ❌ 在 App controller 内再写一遍撤销 refresh 逻辑(违反 DRY + 与 P0-D / P0-E 行为漂移)
- ❌ 改 `revokedReason` 值(zero drift `'self-password-change'`;沿 [`schema.prisma:1055`](../prisma/schema.prisma) 枚举注释)
- ❌ 漏掉 audit `extra.refreshTokensRevoked` 字段(P0-E e2e 强约;沿 [`users-change-my-password.e2e-spec.ts:151-167`](../test/e2e/users-change-my-password.e2e-spec.ts))

### 6.2 Access token 行为锁定(沿 P0-D §5.7 + P0-E v1 D-4)

**P2-3 不主动吊销当前 access token**:

- 沿 P0-D §5.7 + P0-E v1 D-4:`JwtStrategy.validate` 不读 `passwordHash`,仅看 `deletedAt + status`;改密后旧 access 仍可调任意接口直至自然过期(`JWT_EXPIRES_IN=15m`,沿 P0-E PR-3 .env.example)。
- 反向锁定 e2e([`users-change-my-password.e2e-spec.ts:314-338`](../test/e2e/users-change-my-password.e2e-spec.ts) §7.5 "改密后旧 token 仍有效"):**逐字复制**到 App 路径,**不**破。
- **未来若有人"顺手加吊销 access token 逻辑"**,沿 P0-D §5.7:必须先改 [`security.md` Token 吊销升级路径](security.md),走 §1 B 档 `tokenVersion` 路径单独评审;**P2-3 不预实现**。

### 6.3 Refresh token rotation 行为(沿 P0-E §3.5 D-5 + §4.2)

P2-3 改密**触发主动撤销**,但**不**触发 rotation:

- `revokedReason='self-password-change'`(沿 P0-E §7.1)
- `replacedById = null`(不是 rotation 产物;rotation 仅由 `POST /api/auth/refresh` 触发)
- `rotatedAt = null`(同上)
- **被撤销 family 的 absolute `expiresAt` 不变**(沿 P0-E §3.5 + §4.2 D-1 absolute expiration 铁律;撤销与过期是正交的)

### 6.4 改密后用户的 token 重新获取流程(前端行为,**沿 P0-E zero drift**)

| 时序 | 客户端动作 | 后端行为 |
|---|---|---|
| t=0 | 前端调 `PUT /api/app/v1/me/password` 成功 | access token 仍有效;旧 refresh **全部撤销** |
| t=1 | 前端用 access token 继续调业务接口(GET / POST / PATCH) | 全部通过(沿 §6.2 zero drift)|
| t=2 | 前端用 access token 调成功,但本地缓存的 refresh 已不可用(API 不告诉前端) | (前端必须知道:改密后**必须**重新调 `POST /api/auth/login` 获取新 refresh;否则 access 过期后无法续期) |
| t=3 | 前端用旧 refresh 调 `POST /api/auth/refresh` | `REFRESH_TOKEN_INVALID=10007`(沿 P0-E §5.7;e2e 锁定 [`users-change-my-password.e2e-spec.ts:131-149`](../test/e2e/users-change-my-password.e2e-spec.ts))|
| t=4 | access 自然过期 | (前端 401 → 跳登录页;沿 P0-E 文档 § 客户端联调)|

**P2-3 不**改变上述时序(沿 P0-D + P0-E zero drift);**不**新增"改密返新 refresh token"等新行为(沿 §3.3 响应禁返 token)。

### 6.5 与 `/api/auth/logout-all` 的边界

`POST /api/auth/logout-all`(P0-E PR-3 已实装)是**主动**撤销该 user 全部 refresh;P2-3 改密是**被动**触发(改密成功后自动撤销)。两条路径**不重叠**:

- 用户改密 + 不调 logout-all → 全部 refresh 被撤(沿 P2-3)
- 用户不改密 + 调 logout-all → 全部 refresh 被撤(沿 P0-E)
- 用户改密 + 紧接着调 logout-all → 第二次 logout-all 返 `revokedCount=0`(已撤,沿 P0-E `updateMany` 幂等);**不**抛错

P2-3 实施**不**触碰 logout-all。

---

## 7. 审计策略

### 7.1 沿用 P0-D `password.change.self`(零新增)

[`audit-logs.types.ts:40`](../src/modules/audit-logs/audit-logs.service.ts) 已定义 `AuditLogEvent = 'password.change.self'`,P0-D + P0-E PR-3 已接入。P2-3 复用 `UsersService.changeMyPassword` → **自动**沿用该 audit 写入;**不**新增 event。

### 7.2 审计字段(沿 P0-D §5.6 + P0-E §5.9 zero drift)

| 字段 | 值 | 来源 |
|---|---|---|
| `event` | `'password.change.self'` | [`users.service.ts:255`](../src/modules/users/users.service.ts) |
| `actorUserId` | `currentUser.id` | 同上 |
| `actorRoleSnap` | `currentUser.role`(`SUPER_ADMIN` / `ADMIN` / `USER`)| 同上 |
| `resourceType` | `'user'` | 同上 |
| `resourceId` | `currentUser.id`(改自己) | 同上 |
| `context.requestId` | `req.id`(cuid;沿 V1.1 §11.3) | controller `buildAuditMeta` |
| `context.ip` | `req.ip ?? null` | 同上 |
| `context.ua` | `req.headers['user-agent'] ?? null` | 同上 |
| `extra.refreshTokensRevoked` | `refreshRevoke.count`(撤销 refresh token 数;P0-E PR-3 隐含范围扩展)| [`users.service.ts:264`](../src/modules/users/users.service.ts) |
| `success` | `true`(失败路径**不**写 audit;沿 P0-D §5.6 + P0-E §5.9)| 自动 |

### 7.3 审计字段绝对不包含

**P2-3 必须严守**(沿 P0-D §5.6 + P0-E §5.9 + e2e [`users-change-my-password.e2e-spec.ts:381-390`](../test/e2e/users-change-my-password.e2e-spec.ts)):

- ❌ `oldPassword`(任何明文)
- ❌ `newPassword`(任何明文)
- ❌ `passwordHash`(任何 hash 子串,含 `$2a$` / `$2b$` 前缀)
- ❌ `accessToken` / `refreshToken` / `tokenHash` / 任何 token 值
- ❌ `bcrypt.compare` 结果或中间态
- ❌ DTO 序列化对象本身

### 7.4 失败路径不写审计(沿 P0-D §5.6)

以下场景**不**写 audit(沿 P0-D 现状;P2-3 不破):

- `OLD_PASSWORD_INVALID` → service 抛 BizException 中断事务,无 audit 写入
- `NEW_PASSWORD_SAME_AS_OLD` → 同上
- DTO 校验失败 → 在 ValidationPipe 阶段抛,**未**进 service
- 限流命中 → 在 ThrottlerBizGuard 阶段抛,**未**进 service
- 选项 Y 拒绝路径(`canUseApp=false` → FORBIDDEN)→ 在 controller 阶段抛(选项 Y 才有)

如果未来引入"改密失败也写 audit"(防爆破信号),独立立项,沿 V2 红线 D 档评审(**P2-3 不预实现**)。

---

## 8. 限流策略

### 8.1 复用 P0-D `@PasswordChangeThrottle()`(零新增)

[`password-change-throttle.decorator.ts`](../src/common/decorators/password-change-throttle.decorator.ts) + [`throttle-options.ts:28-31`](../src/bootstrap/throttle-options.ts):

- **throttler 实例名**:`'password-change'`(沿 `PASSWORD_CHANGE_THROTTLER_NAME`)
- **参数**:`PASSWORD_CHANGE_THROTTLE_LIMIT=5` / `PASSWORD_CHANGE_THROTTLE_TTL_SECONDS=60`(沿 `app.config.ts`;**禁止**硬编码)
- **维度**:IP(沿 V1.1 §11.4 + P0-D §5.4 第一版)
- **storage**:内存(沿 V1.1 §17.2 + P0-D §5.4;**禁止** Redis storage)

### 8.2 与 `'default'`(login)/ `'refresh'` / `'logout-all'` 物理隔离

| Throttler | 接口 | Limit / TTL | 与 P2-3 关系 |
|---|---|---|---|
| `'default'`(login) | `POST /api/auth/login` | `LOGIN_THROTTLE_LIMIT` / `LOGIN_THROTTLE_TTL_SECONDS`(默认 5/60)| 物理隔离;登录失败爆破**不**消耗 P2-3 配额 |
| `'password-change'` | `PUT /api/users/me/password` + **`PUT /api/app/v1/me/password`**(P2-3 新增)| 5/60 | **两 path 共享同一 throttler 实例**(沿 §8.3 决议)|
| `'refresh'` | `POST /api/auth/refresh` | `REFRESH_THROTTLE_LIMIT` / `REFRESH_THROTTLE_TTL_SECONDS`(默认 30/60)| 物理隔离 |
| `'password-change'`(复用)| `POST /api/auth/logout-all` | 同 5/60(沿 P0-E v1 §5.8)| 物理共享 |

### 8.3 决议项 D-P2-3-2:两 path 共享 `'password-change'` throttler 实例 vs 新建 `'app-password-change'` 实例?

| 选项 | 行为 | 利 | 弊 |
|---|---|---|---|
| **A 档(推荐)**:共享 `'password-change'` | 同一 IP 在 60 秒内 5 次改密**无论走哪 path 都计入同一计数器** | 沿 V1.1 §17.9 反模式禁止"接了 throttler 就顺手对所有接口加限流" + Phase 2 review §3.2 不引入新 throttler;实施零增量 | 攻击者可在 PC + App 两 path 间分摊配额(各 5 次)需要客观看是单一计数器;**共享下不存在**该问题 |
| B 档:新建 `'app-password-change'` | App path 独立 5/60 配额 | 与 PC path 物理隔离 | 攻击者**可获得双倍配额**(PC 5 次 + App 5 次 = 10 次 / 60 秒,IP 维度);新增 `app.config.ts` 字段 + `throttle-options.ts` 数组项 + `app-password-change-throttle.decorator.ts` 全部仪式代码,纯仪式 |

**推荐 A**:共享 `'password-change'` throttler **物理上**是同一计数器(`@nestjs/throttler` IP 维度),无论 path 怎么分都按"该 IP 在 60 秒内改密尝试总数"计算,**直接挡爆破**。

### 8.4 限流响应行为锁定(沿 V1.1 §17.7 + P0-D §5.4 zero drift)

- 命中 → `BizException(BizCode.TOO_MANY_REQUESTS)` → HTTP 429 + `{ code: 42900, message: '请求过于频繁,请稍后再试', data: null }`
- **不**暴露 `Retry-After` / `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` / `Retry-After-password-change` / `X-RateLimit-Limit-password-change` 任何头(沿 [`throttle-options.ts:38`](../src/bootstrap/throttle-options.ts) `setHeaders: false`)
- e2e 必须强约 4-6 个响应头**缺失**断言(沿 [`users-change-my-password.e2e-spec.ts:454-470`](../test/e2e/users-change-my-password.e2e-spec.ts))

---

## 9. Service / Controller 落地建议

### 9.1 不新建 `AppPasswordService`(沿 Phase 0.7 §13.2 P1 触发不立即抽 service)

**4 档候选**:

| 档 | 落地形态 | 推荐? |
|---|---|---|
| **A 档(推荐)**:在 `AppMeController` 新增 `@Put('password')` method;**直接复用** `UsersService.changeMyPassword`;controller 内构造 safeDto | 0 个新 service / 0 个新 file / 0 个新模块依赖 | ✅ 是 |
| B 档:新建 `AppPasswordService` wrapping `UsersService.changeMyPassword` | 在 P2-2 `AppProfileService` 后再加一个;但 `AppPasswordService` 唯一职责是"转发 + 构造 safeDto",几乎是空壳;沿 Phase 0.7 §13.2 P1 触发条件"该 service 累计 ≥ 5 个 method 时考虑抽 service" — P2-3 是 0 个 method(全部转发),**不**触发 | ⚠️ 备选 |
| C 档:直接调用 `UsersService.changeMyPassword` 不构造 safeDto | 破 P2-2 §7.4 显式 safeDto 范式;违反风险表 10.11a;**禁止** | ❌ 否 |
| D 档:新建 App DTO + service safe wrapper | 全套仪式;**纯增 diff 无安全增益**(沿 §2.2 / §3.2 复用决议)| ❌ 否 |

### 9.2 推荐 A 档实施草图(**不是代码**,仅说明形态)

```
// AppMeController 内追加(沿 P0-D users.controller.ts:97-117 范式):

@PasswordChangeThrottle()
@Put('password')
@HttpCode(HttpStatus.OK)
@ApiOperation({ summary: 'App 视角本人改密(P0-D / P0-E 全套行为继承;不主动吊销 access)' })
@ApiWrappedOkResponse(UserResponseDto)
@ApiBizErrorResponse(
  BizCode.BAD_REQUEST,
  BizCode.UNAUTHORIZED,
  BizCode.USER_NOT_FOUND,
  BizCode.OLD_PASSWORD_INVALID,
  BizCode.NEW_PASSWORD_SAME_AS_OLD,
  BizCode.TOO_MANY_REQUESTS,
  // (若决议选项 Y,追加 BizCode.FORBIDDEN)
)
async changeMyPassword(
  @CurrentUser() currentUser: CurrentUserPayload,
  @Body() dto: ChangeMyPasswordDto,
  @Req() req: Request,
): Promise<UserResponseDto> {
  // (若决议选项 Y,在此**先**调 appIdentity.resolve + assertCanUseApp;A 档跳过)

  // P2-2 §7.4 显式 safeDto 范式:禁止透传 raw body
  const safeDto: ChangeMyPasswordDto = {
    oldPassword: dto.oldPassword,
    newPassword: dto.newPassword,
  };
  return this.usersService.changeMyPassword(currentUser, safeDto, this.buildAuditMeta(req));
}
```

### 9.3 模块依赖(沿 Phase 2 review §7.1)

`AppMeController` 已注入(沿 [`users.module.ts:33`](../src/modules/users/users.module.ts)):

- `AppIdentityResolver`(P2-1)
- `AppCapabilityService`(P2-1)
- `AppProfileService`(P2-2)

**P2-3 需新增注入**:

- `UsersService`(P0-D / P0-E PR-3 已实装 `changeMyPassword`)

`UsersService` 已被 `UsersController` 注入([`users.controller.ts:68`](../src/modules/users/users.controller.ts)),P2-3 仅在 `AppMeController` constructor 追加一个参数 → `users.module.ts` 提供者列表已含 `UsersService`,**不**改 providers 数组。

### 9.4 显式 safeDto 范式(必须严守;沿 P2-2 §7.4 + 风险表 10.11a)

**禁止**(以下任一写法 PR review 拒绝):

```
// ❌ 1. raw body 透传
return this.usersService.changeMyPassword(currentUser, dto, this.buildAuditMeta(req));

// ❌ 2. spread 透传
return this.usersService.changeMyPassword(currentUser, { ...dto }, this.buildAuditMeta(req));

// ❌ 3. as cast 透传
return this.usersService.changeMyPassword(currentUser, dto as ChangeMyPasswordDto, this.buildAuditMeta(req));

// ❌ 4. unknown 中转
const d = dto as unknown as ChangeMyPasswordDto;
return this.usersService.changeMyPassword(currentUser, d, this.buildAuditMeta(req));
```

**必须**:

```
// ✅ 显式逐字段重组
const safeDto: ChangeMyPasswordDto = {
  oldPassword: dto.oldPassword,
  newPassword: dto.newPassword,
};
return this.usersService.changeMyPassword(currentUser, safeDto, this.buildAuditMeta(req));
```

**理由**:即使 DTO 字段集严格 2 项被 `forbidNonWhitelisted` 兜底,显式重组提供:

1. **第二道防线**:若 `forbidNonWhitelisted` 未来被误关 / 漏配,显式重组仍能挡住额外字段
2. **代码读者立即看到字段集**:阅读 controller 即知 P2-3 路径接受的字段集恰好 2 项;无需翻 DTO 文件
3. **PR review 易审**:`safeDto` 出现在 git diff 中,reviewer 能直接断言字段集

### 9.5 `buildAuditMeta` helper 归属(沿 P2-2 同 controller 内 helper 范式)

P2-2 `AppMeController` 当前**没有** `buildAuditMeta` private method(因为 P2-2 GET / PATCH /profile 不写 audit);P2-3 实施 PR 新增此 helper 时:

| 选项 | 落地 | 推荐? |
|---|---|---|
| α(推荐) | 在 `AppMeController` 内 private method,与 `UsersController.buildAuditMeta`([`users.controller.ts:121-127`](../src/modules/users/users.controller.ts)) **逐字相同**;沿 P0-D PR-3 D6 v1.1 §11.2 显式 AuditMeta 范式 + emergency-contacts.controller.ts 范式 | ✅ |
| β | 抽 `app-controller-helpers.ts` 共享 `buildAuditMeta` | 沿 Phase 0.7 §13.2 P1 触发不立即抽;**P2-3 不**做 |

**推荐 α**:复制 helper 视为 P0-D PR-3 范式的延续(2 个 controller 各有一份字面相同 helper),沿 baseline §1 "字面对齐既有范式优先";若未来出现第 3 个 controller 需要 audit meta,届时一起立项抽。

---

## 10. 测试计划

### 10.1 新增 e2e 文件:`test/e2e/app-me-password.e2e-spec.ts`

**沿** [`test/e2e/users-change-my-password.e2e-spec.ts`](../test/e2e/users-change-my-password.e2e-spec.ts) 范式逐项移植(沿 Phase 2 review §9.3 #14)。所有 21 用例逐字复制 + path 改 `/api/users/me/password` → `/api/app/v1/me/password`。

### 10.2 用例分组与覆盖

| 分组 | 用例数 | 移植自 P0-D 哪段 | App-特殊增量 |
|---|---|---|---|
| 10.2.1 核心成功路径 + DB 状态 | 3 | 7.1 + 7.7 | 无 |
| 10.2.2 P0-E PR-3 改密联动 refresh 撤销 | 3 | 7.2 + 7.4 §P0-E | 无 |
| 10.2.3 错误码 | 2 | 7.2 | 无 |
| 10.2.4 DTO 校验 | 6(parametrized: 缺 oldPassword / 缺 newPassword / 3 类弱密码 / 4 类额外字段)| 7.2 | 增加"额外字段反向"用例覆盖 App-特定字段名(`memberId` / `userId` / `appAccessReason` 等);沿 §2.3 锁定 |
| 10.2.5 鉴权与跨角色 | 3 | 7.3 | 无 |
| 10.2.6 反向锁定:旧 token 不吊销 | 1 | 7.5 | 必须**逐字复制**到 App 路径(沿 §6.2)|
| 10.2.7 audit log | 1 | 7.6 | 验 `event='password.change.self'` 同 P0-D;**不**新增 App-only audit 字段 |
| 10.2.8 限流(独立 describe + 独立 createTestApp)| 2 | 7.4 | 限流 path 改为 App;throttler 实例名相同 |
| 10.2.9 path stability(新增 App-特殊用例) | **1** | 无 | 改密成功后**旧 `/api/users/me/password` 行为逐字不变**;打一个并行成功用例(在两 path 各发一次成功改密,断言两 path 返回字段集完全等价 + DB 状态字面对齐) |
| 10.2.10 Admin without member 行为锁定(沿 §4.3 决议)| **2-3** | 无 | 沿决议项 D-P2-3-1: 选 X 时验"admin without member → 200"; 选 Y 时验"admin without member → FORBIDDEN=40300";SUPER_ADMIN without member 同上 |

**预计 e2e 用例总数:22-24**。

### 10.3 关键反向断言(逐字复制 P0-D)

- response body **不含** `passwordHash`(沿 [`users-change-my-password.e2e-spec.ts:67`](../test/e2e/users-change-my-password.e2e-spec.ts) `not.toHaveProperty('passwordHash')`)
- response body **不含** `deletedAt`(沿 line 68)
- response body **不含** `accessToken` / `refreshToken`(P2-3 新增反向断言;沿 §3.3)
- audit `serialized` **不含** `TEST_PASSWORD` / `NEW_PASSWORD` / `'$2'` / `dbUser.passwordHash`(沿 line 381-390)
- 限流响应**不含** 6 类 throttler 头(沿 line 463-469)
- 改密后旧 access 调 `/api/app/v1/me` **仍返 200**(P2-3 新增 App 路径反向锁定;沿 §6.2)

### 10.4 测试基础设施复用

| 复用项 | 来源 | 用途 |
|---|---|---|
| `createTestApp()` | `test/setup/test-app.ts` | 标准测试 app 启动 |
| `resetDb(app)` | `test/setup/reset-db.ts` | DB reset |
| `createTestUser(app, { username, role? })` | `test/fixtures/users.fixture.ts` | 标准 user fixture |
| `TEST_PASSWORD` | 同上 | seed 密码常量 |
| `loginAs(app, username)` | `test/fixtures/auth.fixture.ts` | 标准登录 fixture(返 `{ authHeader, accessToken, refreshToken }`)|
| `expectBizError(res, BizCode.X)` | `test/helpers/biz-code.assert.ts` | 标准 BizCode 断言 |
| `httpServer(app)` | `test/helpers/http-server.ts` | supertest agent |
| `truncateAuditLogsTestOnly(app)` | `test/helpers/audit-logs-cleanup.ts` | audit clean 范式(沿 P0-D)|
| Member fixture | `test/fixtures/members.fixture.ts` 等 | 选项 X / Y 决议下"member linked / inactive / 无 member" 三种状态构造 |

### 10.5 contract test(沿 [`test/contract/openapi.contract-spec.ts`](../test/contract/openapi.contract-spec.ts))

新增 1 行 path 期望(沿 line 305-314 P2-1 / P2-2 范式):

```
['put', '/api/app/v1/me/password'],
```

OpenAPI snapshot diff 摘要:

- **新增 path**:1(`PUT /api/app/v1/me/password`)
- **新增 DTO schema**:**0**(沿 §2 复用 `ChangeMyPasswordDto` / `UserResponseDto`)
- **修改 path**:**0**(旧 `/api/users/me/password` 行为 zero drift)
- **删除 path**:**0**

### 10.6 全套 CI 验收(沿 Phase 2 review §9.1)

```bash
pnpm lint
pnpm typecheck
pnpm test              # unit
pnpm test:contract     # OpenAPI snapshot
pnpm test:e2e          # 含本 PR 新增 e2e + P0-D 旧 e2e 全部通过
```

任一未通过 → **不**合并。

---

## 11. Contract / OpenAPI 影响

### 11.1 OpenAPI snapshot 增量

```
新增 path:
  PUT /api/app/v1/me/password

新增 DTO schema:
  (无)

修改 path:
  (无)

删除 path:
  (无)

修改 DTO schema:
  (无)

修改 BizCode:
  (无)
```

### 11.2 旧 path 行为锁定(沿 §4.5)

- `PUT /api/users/me/password` 行为**逐字不变**
- 旧 21 用例 e2e **逐字通过**

### 11.3 与 P2-1 / P2-2 contract 不重叠

P2-3 contract 增量**严格独立**于 P2-1 / P2-2:

- P2-1 新增 3 path + 3 DTO + 1 reason enum(`AppAccessReason`)
- P2-2 新增 2 path + 2 DTO
- **P2-3 新增 1 path + 0 DTO + 0 enum** ← 本评审稿范围

---

## 12. PR 大小与拆分

### 12.1 P2-3 是独立 PR(沿 Phase 2 review §8.1 v0.1 修订)

Phase 2 review §8.1 v0.1 已明文锁定:

> **v0.1 修订(2026-05-19)**:`PUT /me/password` 从原 P2-1 中**拆出**为**独立 PR P2-3**;原 P2-3 ~ P2-7 编号顺延一位为 P2-4 ~ P2-8。
>
> **拆分理由**:改密涉及限流(`@PasswordChangeThrottle()`)/ access token 行为 / 联动撤本人全部 refresh token / audit(`password.change.self`)/ 错误码 10005 / 10006 / P0-E zero drift 等**安全敏感面**,必须**独立评审 + 独立 e2e + 独立 contract snapshot**,**不**与基础身份 / 资料 endpoint 混在同一 PR。

P2-3 **不**夹带以下任一项(违反 = PR review 拒绝):

- ❌ token 策略大改(沿 §6 zero drift)
- ❌ audit 体系重构(沿 §7 zero drift)
- ❌ 限流体系重构 / 新建 throttler 实例(沿 §8 zero drift)
- ❌ BizCode 大改 / 新增 BizCode(沿 §5 zero drift)
- ❌ 旧 `/api/users/me/password` 行为变更(沿 §4.5 + §11.2 zero drift)
- ❌ 改 LoginDto / JwtPayload / JwtStrategy(沿 P0-E v1 §6.5 + §1.3 + CLAUDE.md §9 P0-E 子节)
- ❌ 改 schema / migration(沿 §3.2 / Phase 2 review §3.2)
- ❌ 新增 App DTO(沿 §2 推荐 A 档)
- ❌ 新建 service(沿 §9 推荐 A 档)
- ❌ Phase 1B alias / `/api/auth/v1/*` / `/api/public/v1/*`(独立 PR)

### 12.2 预估 diff(< 300 行)

| 文件 | 增量 | 行数估算 |
|---|---|---|
| `src/modules/users/controllers/app-me.controller.ts` | 新增 1 method + 1 helper(若 §9.5 选 α)+ 1 import(`UsersService`)+ 1 constructor param + 1 `ChangeMyPasswordDto` import + 1 `Request` import | ~40 行 |
| `src/modules/users/users.module.ts` | (无变更;`UsersService` 已注册) | 0 |
| `test/e2e/app-me-password.e2e-spec.ts` | 新建,沿 P0-D 范式逐项移植 22-24 用例 | ~250 行 |
| `test/contract/openapi.contract-spec.ts` | 追加 1 行 expected path + snapshot diff | ~2 行 |
| `test/contract/__snapshots__/openapi.contract-spec.ts.snap` | 自动生成,新增 1 个 path entry | ~30-50 行 |

**总计**:**~280 行(< 300)**;**不**触发 Phase 2 review §8.1 PR-5 / PR-7 级拆分。

### 12.3 提交后续(沿 process.md §4)

- P2-3 PR merge 后:不触发 P2-4 / P2-5 自动启动
- P2-4 / P2-5 启动**仍需**用户拍板单独立项
- 沿 P2-N 单独评审稿范式(沿 Phase 2 review §8.2 #7)

---

## 13. 风险表

> 风险等级:**极高** / **高** / **中** / **低**。P2-3 启动前必须每条逐项确认缓解措施已就位;沿 Phase 2 review §10 + P0-D §7 + P0-E §10。

| # | 风险 | 触发条件 | 影响 | 缓解 | 阻塞 P2-3? |
|---|---|---|---|---|---|
| 13.1 | 旧密码校验绕过 | service 内 `if (dto.oldPassword === dto.newPassword) early-return` 等优化跳过 `bcrypt.compare` | **极高(账户接管)**;攻击者用任意 token 改任意 user 密码 | 沿 P0-D §5.5 + [`users.service.ts:226-232`](../src/modules/users/users.service.ts) 现状:`bcrypt.compare` **必跑**完整;严格 `===` 比较**在** `bcrypt.compare` 通过**后**执行;P2-3 复用此 service method,**禁止**新写 service 逻辑 | ✅ 是 |
| 13.2 | raw body 透传 | controller 内 `this.usersService.changeMyPassword(currentUser, dto, ...)` 透传 | **极高(将来扩展 ChangeMyPasswordDto 字段时 App path 失去白名单防御)**;沿 P2-2 风险表 10.11a 同款风险 | 沿 §9.4 显式 safeDto 范式;PR review **强制** grep `app-me.controller.ts` 中 `changeMyPassword` 调用点是否走 safeDto | ✅ 是 |
| 13.3 | 修改密码后 token 未处理 | controller / service 漏调 refresh revoke / audit 写入 | 高(改密无效);旧 refresh 仍可换 access | 沿 §6.1 复用 P0-D / P0-E PR-3 service method;**禁止**新写;e2e §10.2.2 全 3 用例锁定 | ✅ 是 |
| 13.4 | 审计缺失 / 漂移 | 实施者在 P2-3 path 新写 audit event `password.change.app.self` / 漏写 / 改 event 名 | 高(合规告警 / 数据治理)| 沿 §7.1 复用 P0-D `password.change.self`;**禁止**新增 event;PR review 强制 grep `audit-logs.types.ts` 无新增 | ✅ 是 |
| 13.5 | 限流缺失 / 漂移 | controller 漏挂 `@PasswordChangeThrottle()` / 新建 `'app-password-change'` 实例 | 高(爆破面)| 沿 §8.1 复用 `@PasswordChangeThrottle()`;**禁止**新建 throttler 实例;e2e §10.2.8 限流强约 | ✅ 是 |
| 13.6 | Admin without member 越界(选项 Y 一致性破)| 选项 Y 决议后,实施者**漏**实现 `canUseApp=false → FORBIDDEN`;或选项 X 决议后,实施者**多**实现该拒绝 | 中(契约漂移)| 沿 §4 + §10.2.10 决议:e2e 明确锁定;PR review 强制对照决议项 D-P2-3-1 | ✅ 是 |
| 13.7 | Member inactive 仍可改密码(选项 Y 一致性破)| 选项 Y 决议后,实施者漏判 `Member.status=INACTIVE` | 中 | 同 13.6 | ✅ 是 |
| 13.8 | 密码值进入日志 / audit | service 内或 audit `extra` 写入 raw oldPassword / newPassword / passwordHash | **极高(安全事故)**| 沿 §7.3 + e2e §10.3 `serialized.not.toContain(TEST_PASSWORD / NEW_PASSWORD / '$2' / passwordHash)` 强约;[`logger-options.ts`](../src/bootstrap/logger-options.ts) redact 列表已含 `password` / `newPassword` / `oldPassword` / `passwordHash`(沿 V1.1) | ✅ 是 |
| 13.9 | 新增 BizCode 破坏段位 | 实施者新增 `APP_PASSWORD_CHANGE_FORBIDDEN=10008` 等抢号 | 中(段位规划)| 沿 §5.2 + §5.3;PR review 强制 grep `1000[8-9]` 无新增 | ✅ 是 |
| 13.10 | 修改旧 `/api/users/me/password` 行为 | 实施者顺手调整 `UsersController.changeMyPassword` / `UsersService.changeMyPassword` 签名 / 返回 / 装饰器 | 高(向后兼容)| 沿 §4.5 + Phase 2 review §3.2 + §9.2 #9 path stability;PR review 强制 grep `git diff` 仅含 `app-me.controller.ts` 不含 `users.controller.ts` / `users.service.ts` 实质变更;旧 21 用例**必须**逐字通过 | ✅ 是 |
| 13.11 | 返回 token / hash / sensitive data | response DTO 含 `accessToken` / `refreshToken` / `passwordHash` | **极高(安全事故)**| 沿 §3.3 + e2e §10.3 反向断言 | ✅ 是 |
| 13.12 | contract diff 超范围 | PR 内意外改 admin DTO / 旧 path schema / 多 path | 高(契约破坏)| 沿 §11.1 OpenAPI snapshot diff 摘要;PR review 强制对照只**新增 1 path / 0 DTO** | ✅ 是 |
| 13.13 | App DTO 复用 Admin DTO(沿 Phase 2 review 10.1 同款风险) | 实施者**误将** `ChangeMyPasswordDto` 当作 "Admin DTO" 而触发 §10.1 风险 | 低(本评审稿 §2.2 已明确该 DTO 是 Mixed shared,不归 Admin)| 沿 §2.2 论证 + PR review reviewer 阅读本评审稿 | ⚠️ 部分(纯认知风险)|
| 13.14 | 沿 P2-2 风险表 10.11a "PATCH /me/profile 入参夹带" 同款风险 | 实施者把 `nickname` / `avatarKey` / `role` / `permissions` 等夹带进 `ChangeMyPasswordDto` | **极高(合规 + 越权)**| 沿 §2.3 字段白名单铁律 + §9.4 显式 safeDto + e2e §10.2.4 额外字段反向断言 | ✅ 是 |
| 13.15 | 顺手做 Phase 1B alias | 实施者觉得 `/api/auth/v1/*` 自然在 P2-3 一起做 | 中(范围扩张)| 沿 Phase 2 review §10.14;P2-3 **不**碰 `/api/auth/*` 任何 path | ✅ 是 |
| 13.16 | 顺手做 P2-4 / P2-5(activities / registrations)| 实施者觉得"反正都改 App 了一起做" | 高(范围扩张 + PR > 500 行)| 沿 §12.1;PR review 强制 grep `git diff --name-only` 仅含 `app-me*` 路径文件 | ✅ 是 |
| 13.17 | 改 LoginDto / JwtPayload | 实施者觉得"改密成功返新 token 更方便"加 schema 字段 | **极高(P0-E v1 §6.5 zero drift 破)**| 沿 §3.3 + §6.4;PR review 强制 grep `auth.dto.ts` / `jwt.strategy.ts` 无变更 | ✅ 是 |

---

## 14. 同步引用与文档归属

### 14.1 本评审稿被引用

本评审稿 v0 用户拍板冻结后,以下文档**必须**在 P2-3 PR 内增加 "P2-3 implementation must read `docs/app-api-p2-3-password-review.md`" 提示(沿 P2-2 §13.1 范式 — 不重写既有设计,仅追加引用):

- [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md) §11.3 节末加一行引用("**P2-3** `/api/app/v1/me/password` → [`docs/app-api-p2-3-password-review.md`](app-api-p2-3-password-review.md)")

可选(若用户认为必要):

- `CLAUDE.md` / `AGENTS.md` §19.7 增补 D-9(沿 Phase 2 review §11.1 锁定:**若 D-8 已覆盖 Phase 2 review chain,可不再膨胀**)。本评审稿**默认建议不**加 D-9,沿 D-8 现状。

### 14.2 本评审稿引用

本评审稿生效后,与以下文档形成 "P2-3 实施前必读" 矩阵:

- [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md) — P2-3 在 §2 / §8.1 / §9.3 #14 / §10 锁定
- [`docs/app-api-p2-2-profile-review.md`](app-api-p2-2-profile-review.md) — §7.4 显式 safeDto 范式 / 风险表 10.11a 反模式
- [`docs/app-permission-boundary-review.md`](app-permission-boundary-review.md) — Phase 0.5 §10.2 D-1 / D-2 / D-4(身份 / 路径分层)
- [`docs/data-access-lifecycle-boundary-review.md`](data-access-lifecycle-boundary-review.md) — Phase 0.6 §2 / §5 字段 / 生命周期
- [`docs/code-architecture-boundary-review.md`](code-architecture-boundary-review.md) — Phase 0.7 §2 / §3 / §13(代码分层)
- [`docs/first-release-p0d-change-my-password-review.md`](first-release-p0d-change-my-password-review.md) — P0-D 完整评审 / §5 安全规则 / §7 验收
- [`docs/first-release-p0e-refresh-token-review.md`](first-release-p0e-refresh-token-review.md) — P0-E v1 §3 / §4 / §7.1 token 行为
- [`docs/process.md`](process.md) — PR 分级 + D 档降速规则

---

## 15. 决策记录 / 验收 / 修订

### 15.1 已锁定决策(沿前序评审稿 + 本评审稿 v0.1)

- ✅ 候选 / 临时编号志愿者**不进** Phase 2 App 登录范围(D-5.1)
- ✅ Admin 兼队员走 linked-member self perspective(D-5.2)
- ✅ App 暴露 capability,不暴露 raw RBAC permission code(D-5.3)
- ✅ `/me/*` 与 `/my/*` 物理拆分(D-5.4)
- ✅ App DTO 禁止 `extends` / `Pick` / `Omit` Admin DTO(Phase 0.7 §2.2)
- ✅ Mobile API 默认 `scope = self`(Phase 0.6 §3.3)
- ✅ L3 字段永不返回(Phase 0.6 §2.3)
- ✅ Phase 2 不动 schema / migration / Role / MemberStatus / Permission seed(Phase 2 review §3.2)
- ✅ `PUT /me/password` 独立 PR(P2-3;沿 Phase 2 review §8.1 v0.1)
- ✅ P0-D zero drift(DTO / service / audit / throttle / BizCode / token 行为全沿用)
- ✅ P0-E zero drift(refresh 撤销 / access 行为锁定)
- ✅ **D-P2-3-1 = X**(2026-05-20 v0.1 用户拍板):Admin without member 允许使用 `PUT /api/app/v1/me/password`;**例外边界严格**仅本端点(沿 §4.3 / §4.6 锁定列表)

### 15.2 本评审稿决议项(用户拍板时回答)

| # | 决议项 | 状态 | 阻塞 P2-3 启动? |
|---|---|---|---|
| **D-P2-3-1** | **Admin / SUPER_ADMIN without member 是否允许通过 `/api/app/v1/me/password` 改密?** | **✅ 已锁定 = X**(2026-05-20 v0.1 用户拍板;沿 §4.3 + §4.6 例外边界)| ✅ 是(已解锁,P2-3 e2e §10.2.10 按 X 锁定;选项 Y 不实施)|
| **D-P2-3-2** | 限流 throttler 实例归属:共享 `'password-change'` vs 新建 `'app-password-change'` | ⏳ 待拍板(默认 A 档共享;沿 §8.3)| ⚠️ 影响代码(若选 B 档,需新增 `app.config.ts` + `throttle-options.ts` + decorator)|
| D-P2-3-3 | `buildAuditMeta` helper 归属:`AppMeController` 内复制 vs 抽 `app-controller-helpers.ts` | ⏳ 待拍板(默认 α 复制;沿 §9.5)| ⚠️ 影响代码(若选 β,需新增 1 个 file)|
| D-P2-3-4 | `CLAUDE.md` / `AGENTS.md` §19.7 是否增补 D-9 | ⏳ 待拍板(默认不增补;沿 §14.1)| ⚠️ 影响 PR-0 docs PR diff 行数 |
| D-P2-3-5 | OpenAPI snapshot 旧 path `PUT /api/users/me/password` 是否在 P2-3 PR 描述中显式列为"行为锁定"对照 | ⏳ 待拍板(默认是;沿 §11.2 + Phase 2 review §9.2 #9 path stability)| ⚠️ 影响 PR 描述模板;**不**影响代码 |

### 15.3 修订规则

- 本评审稿 v0 用户拍板冻结后,**就地**修订(沿 Phase 2 review §12.3 + P2-2 §13.3)
- 每次修订记录修订时间 + 变更摘要(在本节 §15.5 追加)
- 若 P2-3 实施过程发现本评审稿与代码冲突,**暂停**并向用户汇报

### 15.4 验收锚点

| 锚点 | 状态 |
|---|---|
| 本评审稿 v0 用户拍板冻结 | ⏳ 待 |
| `docs/app-api-phase-2-review.md` §11.3 同步引用 1 行 | ⏳ 与本 PR(docs-only)同 PR |
| P2-3 实施 PR(独立 D 档代码 PR)| ⏳ 待用户单独立项 |
| P2-8 收尾(`docs/current-state.md` / `CHANGELOG.md` 回填)| ⏳ Phase 2 全部 PR 合入后 |

### 15.5 修订历史

| 日期 | 版本 | 摘要 |
|---|---|---|
| 2026-05-20 | v0 | 本评审稿 v0 创建;1 个 endpoint + 0 新 DTO + 0 新 service + 0 新 BizCode + 0 新 audit + 0 新 throttler;沿 Phase 2 review §8.1 v0.1 P2-3 独立 PR 决议 + P0-D / P0-E zero drift;13 节(范围 / DTO / 返回 / identity / BizCode / token / audit / throttle / service / 测试 / contract / PR / 风险 + 引用 + 决议);5 个决议项(D-P2-3-1 ~ D-P2-3-5);17 条风险表 |
| 2026-05-20 | v0.1 | **D-P2-3-1 用户拍板锁定 = X**:Admin without member 允许使用 `PUT /api/app/v1/me/password`。理由:改密是账号级自助操作,不是 member-domain 数据访问;不暴露 member 业务数据;安全由旧密码校验 + `@PasswordChangeThrottle()` + refresh-token 撤销 + `password.change.self` audit 四道闭合控制。**新增 §4.6 例外边界**:豁免严格仅适用 `PUT /api/app/v1/me/password`,**禁止**被 `/me/profile` / `/activities/*` / `/my/*` / `/tasks/*` / `/managed/*` 复用;PR review 强制 grep 检查。同步更新 §0 TL;DR #4 / §4.3(锁定 X + 三条理由 + 未来会话铁律)/ §4.4(选项 Y 列降级为"历史对照,不实施")/ §15.1(添加 D-P2-3-1 = X 到锁定列表)/ §15.2(D-P2-3-1 状态从"默认建议"改"✅ 已锁定")/ 文末"当前状态"段落。保留:`ChangeMyPasswordDto` / `UsersService.changeMyPassword` / `@PasswordChangeThrottle()` / `password.change.self` audit / 现有 BizCode 不新增 / refresh revoke 现有行为 / safeDto 强制不透传 raw body 全部不变 |

---

## 16. 不在本文范围 / 边界声明

### 16.1 不在本文范围

| 类别 | 权威源 |
|---|---|
| 接口字段详情 / OpenAPI | [`docs/v2-api-contract.md`](v2-api-contract.md) + Swagger `/api/docs` |
| 完整 BizCode 翻译 | [`docs/first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md) |
| P0-D 完整评审 | [`docs/first-release-p0d-change-my-password-review.md`](first-release-p0d-change-my-password-review.md) |
| P0-E 完整评审 | [`docs/first-release-p0e-refresh-token-review.md`](first-release-p0e-refresh-token-review.md) |
| Phase 2 接口清单 / PR 串 / 风险表 | [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md) |
| Phase 0.5 / 0.6 / 0.7 三大边界评审稿 | 各自文档 |
| 协作流程 / D 档降速 / PR 拆分 | [`docs/process.md`](process.md) |
| Token 吊销升级路径(未来 access token blacklist / tokenVersion 评审依据)| [`docs/security.md`](security.md) Token 吊销升级路径段 |
| 当前事实 / 风险账单 | [`docs/current-state.md`](current-state.md) |

### 16.2 边界声明

- 本评审稿**不引入新事实**;所有引用均来自已合入 main 的代码与文档(HEAD = `5b5d59e`)
- 本评审稿**不调和**与既有评审稿的措辞偏差;沿 process.md §6 不重写既有设计
- 本评审稿**不**承诺 P2-3 实施 PR 的具体实现细节(如 service method 签名、controller method 名、装饰器命名等);仅锁定行为契约 / 错误码 / 鉴权 / 限流 / audit / 验收用例 / 风险表
- 本评审稿**不**改 schema / migration / endpoint / DTO / Guard / 权限逻辑 / 测试代码 / `package.json` / `pnpm-lock.yaml`
- 本评审稿**不**启动:P2-3 implementation / P2-4+ / Phase 1B / `/api/auth/v1/*` / `/api/public/v1/*`

---

> **本评审稿生效时间**:2026-05-20(P2-3 实施前评审稿 v0 / v0.1)。
> **当前状态**:✅ **D-P2-3-1 已锁定为 X**(2026-05-20 v0.1;沿 §4.3 + §4.6);⏳ §15.2 中余 4 项决议(D-P2-3-2 ~ D-P2-3-5)默认建议待用户拍板;**不**阻塞 P2-3 启动(余 4 项均为代码 / PR 描述层级,可在 P2-3 PR 启动评审时一并决议)。
> **过期条件**:P2-3 实施 PR 合并后,本评审稿降为"历史评审"性质;沿 Phase 2 review §12.3 修订规则。
