# SRVF App API P2-2 Profile Review

> **状态**:**P2-2 实施前评审稿 v0**(2026-05-19)
> **性质**:**implementation review**(沿 [`docs/process.md §6`](process.md))。**不是代码改造,不是 migration,不是 endpoint 增减**。
> **范围**:仅评审 `GET /api/app/v1/me/profile` 与 `PATCH /api/app/v1/me/profile` 两个 endpoint 的字段集 / DTO / 数据源 / Presenter / 测试 / 风险。**不**起草任何代码。
> **前置必读**:
>   - [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md) §2 + §3 + §5 + §6 + §8(本评审稿是 P2-2 PR 的具体化)
>   - [`docs/app-permission-boundary-review.md`](app-permission-boundary-review.md) §10.2 D-1 ~ D-4(身份准入)
>   - [`docs/data-access-lifecycle-boundary-review.md`](data-access-lifecycle-boundary-review.md) §2(L0-L3 字段分级)+ §5(User/Member 生命周期)
>   - [`docs/code-architecture-boundary-review.md`](code-architecture-boundary-review.md) §2(DTO/Presenter)+ §3(三层授权)
>   - [`CLAUDE.md §9 / §11 / §19.7 D-5 ~ D-8`](../CLAUDE.md)
> **冲突优先级**:本评审稿优先级**最低**;冲突时让步给上述所有评审稿与 `CLAUDE.md` / `AGENTS.md` / `ARCHITECTURE.md` / `srvf-foundation-baseline.md` / V2 红线。
> **解除条件**:本评审稿经用户拍板冻结后,P2-2 实施 PR 允许在 [`docs/process.md`](process.md) §3 + §4 流程内立项。

---

## 0. TL;DR

1. **范围严格**:仅 2 个 endpoint(`GET /api/app/v1/me/profile` + `PATCH /api/app/v1/me/profile`),仅 2 个新 DTO(`AppSelfProfileDto` + `UpdateAppSelfProfileDto`),仅 1 个新 service(`AppProfileService`)。
2. **PATCH 白名单恰好 2 字段**:`nickname` + `avatarKey`(沿 Phase 2 review §5.2 #5 锁定字段集 + §10.11a 风险表)。**禁止**任何 Member 业务字段 / Emergency contacts / Organization / Department / Role / Permission / Status / 账号字段 / 审批字段进入入参 DTO。
3. **GET 字段恰好 9 个**(v0.1 收窄):`userId / memberId / username / nickname / avatarKey / memberNo / displayName / memberStatus / hasMemberProfile`;**P2-2 不读 `MemberProfile` 任何字段**,`email` 由 `/api/app/v1/me/account` 承载不重复返;`gradeCode` / `joinedDate` / `realName` / `mobileMasked` / `documentNumberMasked` 全部**移出 P2-2**,留独立评审稿。
4. **复用 P2-1 准入闭包**:`AppIdentityResolver.resolve(currentUser)` 直接复用;**不**新建 `MemberStatusGuard`;两 endpoint 必须 `canUseApp=true`,否则按拒绝路径走(沿 Phase 2 review §6.3)。
5. **PATCH 复用 P0-D `UsersService.updateMyProfile`**:`nickname` / `avatarKey` 是 `User` 表字段,沿用 P0-D 现有 method;**不**改 `UsersService` 签名;**不**走 `MemberProfile` 写路径。**`AppProfileService` 必须**先用 `UpdateAppSelfProfileDto` 把 body 限制为 `nickname` / `avatarKey` 两字段后**再传给** `UsersService.updateMyProfile`;**禁止**把原始 request body 透传到 `UsersService`(沿 §7.4)。
6. **GET 在 `canUseApp=false` 时**:沿 P2-1 capability-aware 拒绝路径**反例** — 业务 endpoint 必须**显式拒绝**(走 `FORBIDDEN` 临时复用 + reason 文案;P2-2 评审稿明确**不**改业务 endpoint 返"空 profile")。
7. **P2-2 不新增 BizCode**(锁定):
   - `canUseApp=false` → `FORBIDDEN=40300`(沿 Phase 2 review §6.3;reason 由 message 文案区分)
   - 空 body → `BAD_REQUEST=40000`
   - forbidden field → `BAD_REQUEST=40000`(`forbidNonWhitelisted: true` 自动生成 class-validator message)
   - 不开 `MEMBER_NOT_LINKED` / `APP_MEMBER_INACTIVE` / `APP_MEMBER_DELETED` / `APP_PROFILE_UPDATE_EMPTY` / `APP_PROFILE_FIELD_FORBIDDEN` 任一新号位;真业务诉求出现时独立立项(沿 [`CLAUDE.md §5`](../CLAUDE.md))
8. **PR 大小**:预计 < 300 行 diff(2 endpoint + 2 DTO + 1 service + 20-25 e2e + contract snapshot;沿 v0.1 收窄);**不**触发 P2-5 拆分级别。
9. **未启动**:P2-2 implementation / P2-3(`/me/password`)/ Phase 1B(`/api/auth/v1` / `/api/public/v1` alias)/ Phase 2.x(emergency contacts / member profile 完整 read 含 realName / mobileMasked / documentNumberMasked / gradeCode / joinedDate)— 全部留独立评审稿。

---

## 1. P2-2 最终 endpoint 设计

### 1.1 接口表

| Method | Path | Purpose | Surface | Scope | Auth | DTO | Service / Resolver reuse | Risk |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/app/v1/me/profile` | 本人 User + Member 基础摘要(9 字段;沿 §2.4 v0.1 收窄基线) | mobile | self | `JwtAuthGuard` + `canUseApp=true` | `AppSelfProfileDto`(出参) | `AppIdentityResolver`(P2-1)+ 新 `AppProfileService.getMyProfile`(纯派生,不读 MemberProfile)| 中(派生 `hasMemberProfile` 标志) |
| PATCH | `/api/app/v1/me/profile` | 本人改 `nickname` / `avatarKey`(严格 2 字段白名单) | mobile | self | `JwtAuthGuard` + `canUseApp=true` | `UpdateAppSelfProfileDto`(入参)+ `AppSelfProfileDto`(出参) | `AppIdentityResolver`(P2-1)+ 新 `AppProfileService.updateMyProfile`(内部**先**用 DTO 限制 body 后**再**调 `UsersService.updateMyProfile`;沿 §7.4)| 中(白名单严格) |

### 1.2 路径归属(沿 D-5.4)

```txt
/api/app/v1/me/profile  ← identity / profile;归 me/* 段(沿 Phase 0.5 §10.2 D-4)
```

**不**归 `my/*`(`my/*` = "我的业务记录";profile 是 identity)。

### 1.3 实施可行性

- **GET**:`AppIdentityResolver.loadUserForApp` + `AppIdentityResolver.resolve` 已在 P2-1 提供 User 安全字段 + Member 完整字段;P2-2 v0.1 收窄后**不**读 `MemberProfile`,`hasMemberProfile` 通过 `prisma.memberProfile.findFirst({ where: notDeletedWhere({ memberId }), select: { id: true } })` 仅读派生(单字段 select)
- **PATCH**:`nickname` / `avatarKey` 是 `User` 表字段(沿 [schema.prisma:20-21](../prisma/schema.prisma)),复用 `UsersService.updateMyProfile`(沿 [users.service.ts:findMe / updateMyProfile](../src/modules/users/users.service.ts));**`AppProfileService` 必须**用 `UpdateAppSelfProfileDto` 把 body 拦下后**显式构造** `{ nickname, avatarKey }` 再传入,**禁止**透传原始 request body(沿 §7.4)
- **响应**:PATCH 成功后**返新的 `AppSelfProfileDto`**(与 GET 字段集一致,前端方便单次响应即可刷新本地缓存)

---

## 2. GET `/me/profile` 返回字段设计

### 2.1 v0.1 收窄基线(2026-05-19 用户拍板)

> 字段分类标 `(L0/L1/L2/L3)` 沿 [Phase 0.6 §2.1](data-access-lifecycle-boundary-review.md)。

**P2-2 GET /profile 字段恰好 9 个**:

```txt
userId                     L0
memberId                   L0
username                   L1(账号名)
nickname                   L0(可空)
avatarKey                  L0(可空;沿 P2-1 现状不返 signed URL)
memberNo                   L1
displayName                L1
memberStatus               L0(枚举;P2-2 进入时强约 ACTIVE)
hasMemberProfile           L0(派生;`MemberProfile` 是否存在)
```

**字段总数:9**。

**为什么是这 9 个 / 不是更多**:

- `email`:**已由** `/api/app/v1/me/account` 承载,P2-2 profile 不重复返回(沿 v0.1 修订)
- `gradeCode`:暂不进入 P2-2 — 队员等级语义涉及 dict code 字典依赖,留独立评审
- `joinedDate`:暂不进入 P2-2 — `MemberProfile` 字段,需读 `MemberProfile`,留独立评审
- `realName` / `mobileMasked` / `documentNumberMasked`:**全部暂不进入** P2-2 — `MemberProfile` L1 / L2 字段,涉及掩码语义 / 完整号决议(沿 [Phase 0.6 §2.3](data-access-lifecycle-boundary-review.md) 铁律 5),留 Phase 2.x 完整 member profile read PR
- `canUseApp`:**不在** GET /profile 返回 — P2-2 走显式拒绝路径(沿 §5.4),已是 200 即表示 `canUseApp=true`;前端可继续依赖 `/api/app/v1/me` / `/api/app/v1/me/account` / `/api/app/v1/me/capabilities` 拿 `canUseApp` 标志

### 2.2 历史 3 档参考(分析过程,**不再为推荐档**)

> v0 初稿曾对比 A / B / C 三档;v0.1 收窄后,**实际基线**比 v0 初稿 A 档**还窄**(剔除 `gradeCode` / `canUseApp`)。
> 三档定义保留作为"为什么不更多"的分析过程参考,**不再**用作"推荐档"。

#### A 档(v0 初稿;含 `gradeCode` / `canUseApp`)

```txt
userId / memberId / username / nickname / avatarKey
memberNo / displayName / gradeCode / memberStatus
canUseApp / hasMemberProfile
```

**v0.1 调整**:剔除 `gradeCode`(独立评审)/ `canUseApp`(其它 me/* endpoint 已承载)→ **v0.1 基线 9 字段(沿 §2.1)**。

#### B 档(v0 初稿;含 MemberProfile 低敏摘要)

```txt
A 档全部 + email / realName / mobileMasked / documentNumberMasked / joinedDate
```

**v0.1 拒绝**:`MemberProfile` 字段全部移出 P2-2,留 Phase 2.x 完整 member profile read PR 独立评审。

#### C 档(v0 初稿;含 MemberProfile 完整资料)

```txt
B 档全部 +
完整 mobile(L2) / 完整 documentNumber(L2) /
documentTypeCode / genderCode / birthDate(L1) /
ethnicityCode / politicalStatusCode / educationCode / maritalStatusCode(L1) /
workNatureCode / residenceArea / workArea(L1) /
landline / qq / wechat(L1) /
heightCm / weightKg(L2 医疗) /
bloodTypeCode(L2 医疗) /
eyesight / medicalNotes(L2 医疗) /
hasVehicle / vehicleType(L1)
+ exerciseFrequencyCode / exerciseSportCode / exerciseMethods / firstAidKnowledgeCode / firstAidSkills(L1)
+ otherSkills(L1)
+ noCriminalRecordSigned / privacyConsentSigned / privacyConsentSignedAt(L0/L1)
+ volunteerNo(L1)
```

**结论**:**C 档不在 P2-2 范围**。沿 v0.1 收窄,**B 档也不在 P2-2 范围**;若业务要求实现"App 端完整 member 资料查看"(含 `realName` / `mobileMasked` / `documentNumberMasked` / `gradeCode` / `joinedDate` 等),**必须**单独立项 Phase 2.x 评审稿,届时一并决议:身份证号 / 手机号默认掩码 vs 完整、医疗信息可见性、紧急联系人在何处暴露、记录"查看完整资料"的 audit 行为。

### 2.3 未来扩展字段决议(均不在 P2-2)

> 本节字段**全部移出** P2-2;每条说明字段在未来评审稿中的预期归属与默认建议。
> 决议:Phase 2.x 完整 member profile read PR 启动时一并对齐;P2-2 范围拒绝。

#### 2.3.1 `realName` — **不在 P2-2**

- L1(本人可见;沿 Phase 0.6 §2.2 #2.1)
- 留 Phase 2.x 完整 member profile read PR

#### 2.3.2 `mobileMasked`(手机号后 4 位掩码)— **不在 P2-2**

- 沿 Phase 0.6 §2.2 #2.2(L2);沿 §2.3.3 同款掩码语义
- 未来字段名:`mobileMasked`(明确语义,与 PATCH 白名单 `mobile` 严禁字段名错开)
- 掩码格式建议:示例 `"***5678"`(后 4 位 + 前置 `***`);若原值长度 < 4,统一 `"****"`(避免漏 timing)
- **完整号永不在任何 me/profile 视角返回**;走独立审计接口(Phase 2 范围全不实施)

#### 2.3.3 `documentNumberMasked`(身份证号后 4 位掩码)— **不在 P2-2**

- 沿 Phase 2 review §5.2 #4 / §10.11 / Phase 0.6 §2.3 铁律 5
- 未来字段名:`documentNumberMasked`
- 掩码格式:示例 `"***1234"`;短值兜底 `"****"`
- **完整号永不在 P2-2 / Phase 2.x 完整 read 视角返回**;走独立审计接口

#### 2.3.4 `gradeCode` / `joinedDate` — **不在 P2-2**

- `gradeCode` L1(Member 表;队员等级 dict code);P2-2 收窄拒绝
- `joinedDate` L0(MemberProfile 表);需读 MemberProfile,P2-2 不读 MemberProfile 整字段
- 留 Phase 2.x 一并评审

#### 2.3.5 `bloodTypeCode`(血型)— **不在 P2-2**

- 沿 Phase 0.6 §2.2 #2.9:L2;AppSelf 本人可见 ✅,但救援场景对 AppManaged 有特殊语义
- 留 Phase 2.x 完整资料接口

#### 2.3.6 `medicalNotes` / `eyesight` / `heightCm` / `weightKg` — **永禁 P2-2**

- 沿 Phase 0.6 §2.2 #2.10:L2 + JSON / L2 医疗
- **P2-2 拒绝任何医疗字段返回**;留 Phase 2.x

#### 2.3.7 `emergencyContacts` / `contactName` / `contactPhone` 等 — **永禁 P2-2**

- 沿 Phase 0.6 §2.2 #2.8 / #2.8.1:L1 / L2
- **P2-2 拒绝紧急联系人字段**;**App 端紧急联系人独立 endpoint** `/api/app/v1/me/emergency-contacts/*` 留 Phase 2.x 单独立项(沿 Phase 2 review §5.2 #5 中段)

#### 2.3.8 `organizationName` / `departmentName` 等只读组织信息 — **不在 P2-2**

- 沿 Phase 0.6 §2.2 #2.6:L0(组织名)+ L1(组织架构);本人可见 ✅
- 数据源跨表(`MemberDepartment` + `Organization`),实施复杂度增加;留 Phase 2.x 评审时一并决议(配合"我的部门" `/api/app/v1/me/department` 端点设计)

#### 2.3.9 `profileCompletion`(派生指标 0-100)— **不在 P2-2**

- 沿 Phase 0.7 §10 派生指标边界
- 派生指标需明确口径(哪些字段计入 / 权重),需独立设计;留 Phase 2.x

#### 2.3.10 `internalNote` / `reviewerNote` / `verifiedBy` / `verifiedAt` — **永禁**

- 沿 Phase 0.6 §2.2 #2.17 + Phase 2 review §5.2 #9 / #10:Admin 内部审批字段
- **任何视角下** AppSelf 都**不可见**;PR review 强制 grep 拒绝

#### 2.3.11 `email` — **不在 P2-2 profile**(由 `/me/account` 承载)

- 沿 v0.1 收窄;P2-1 `/api/app/v1/me/account` `AppMeAccountDto.email` 已承载
- 不在 P2-2 profile 重复返回,避免双数据源(沿 [Phase 0.7 §2.2 #6](code-architecture-boundary-review.md) DTO 类型隔离)

### 2.4 v0.1 字段集冻结(基线)

```txt
AppSelfProfileDto {
  userId:                    string                 // User.id
  memberId:                  string                 // User.memberId(canUseApp=true 保证非空)
  username:                  string                 // User.username
  nickname:                  string | null          // User.nickname(P2-2 PATCH 可改)
  avatarKey:                 string | null          // User.avatarKey(P2-2 PATCH 可改;沿 P2-1 不返 signed URL)

  memberNo:                  string                 // Member.memberNo(终身不变)
  displayName:               string                 // Member.displayName
  memberStatus:              MemberStatus           // Member.status(枚举;P2-2 GET 进入时强约 ACTIVE)

  hasMemberProfile:          boolean                // 派生;MemberProfile 是否存在(单字段 select 派生)
}
```

**字段总数:9**(沿 §2.1 v0.1 收窄基线)。

**严禁出现的字段(snapshot 拒合并信号)**:
- L3:`passwordHash` / `refreshToken` / `tokenHash` / `secretId*` / `secretKey*` / 完整 signed URL
- 完整 L2:**完整** `mobile` / **完整** `documentNumber`
- L2 字段(掩码版本):`mobileMasked` / `documentNumberMasked`(沿 §2.3.2 / §2.3.3 移出 P2-2)
- L1 摘要字段:`realName` / `gradeCode` / `joinedDate` / `email`(沿 §2.3.1 / §2.3.4 / §2.3.11 移出 P2-2)
- L2 医疗:`bloodTypeCode` / `eyesight` / `heightCm` / `weightKg` / `medicalNotes`
- 紧急联系人:任何 `emergencyContact*` 字段
- 组织部门:`organizationId` / `organizationName` / `departmentId` / `departmentName` / `memberDepartments`
- Admin 内部审批:`reviewerNote` / `verifiedBy` / `verifiedAt` / `internalNote`
- 系统字段:`deletedAt` / `role` / `status`(User.status;沿 P2-1 `me/account` 已返,profile 不重复)/ `permissions[]` / `permissionCodes[]` / `roles[]`
- 审计内部:`createdAt` / `updatedAt`
- 派生字段:`canUseApp`(`/me` / `/me/account` / `/me/capabilities` 已承载;profile 200 即表示 `canUseApp=true`,沿 §2.1)/ `appAccessReason` / `profileCompletion`

### 2.5 数据源决议表

| 字段 | 数据源 | 备注 |
|---|---|---|
| userId / username / nickname / avatarKey | `User` 表 | 沿 P2-1 `loadUserForApp` 现有 select(`email` / `role` / `status` / `lastLoginAt` / `memberId` 已 select 但本 DTO 不返) |
| memberId / memberNo / displayName / memberStatus | `Member` 表 | 沿 P2-1 `AppIdentityResolver.resolve` 返回的 `member` |
| hasMemberProfile | 派生 | 单字段 select `prisma.memberProfile.findFirst({ where: notDeletedWhere({ memberId }), select: { id: true } })`,结果非 null 即派生 true;**不**读其它字段 |

**MemberProfile 查询失败处理**:
- `findFirst` 返 null(member 存在但无 profile)→ `hasMemberProfile=false`
- **不**抛 `MEMBER_PROFILE_NOT_FOUND`(16001);该错误码语义是"管理后台读队员 profile 失败",P2-2 App 视角应 graceful degrade 显示 `hasMemberProfile=false`

---

## 3. PATCH `/me/profile` 入参白名单

### 3.1 仅允许 2 字段(沿 Phase 2 review §5.2 #5)

```ts
UpdateAppSelfProfileDto {
  nickname?:  string  // @IsOptional() @IsString() @MaxLength(50)
  avatarKey?: string  // @IsOptional() @IsString() @MaxLength(255)
}
```

字段集**恰好 2 个**;PR review 强制断言(沿 §10.11a 风险表)。

### 3.2 校验细节

| 字段 | 校验装饰器 | 备注 |
|---|---|---|
| `nickname` | `@IsOptional()` + `@IsString()` + `@MaxLength(50)` | 沿 [CLAUDE.md §3 字段校验铁律](../CLAUDE.md);**禁止**加 `@MinLength()`(允许清空昵称;但沿现状 `UpdateMyProfileDto` 范式不加) |
| `avatarKey` | `@IsOptional()` + `@IsString()` + `@MaxLength(255)` | 沿 [CLAUDE.md §3](../CLAUDE.md);**不**校验 key 格式(由后续 attachment 模块判定 ownership) |

**不**新增 `@Matches(...)` 等强校验;沿现状 `UpdateMyProfileDto` 风格(沿 [users.dto.ts:UpdateMyProfileDto](../src/modules/users/users.dto.ts))。

### 3.3 明确禁止字段清单(逐字锁定)

以下字段**任一**出现在 `UpdateAppSelfProfileDto` 类定义 → **PR review 拒合并**;运行时由 `forbidNonWhitelisted: true` 兜底返 400。

**Member 业务字段**:
```txt
realName / mobile / documentNumber / documentTypeCode
bloodType / bloodTypeCode
medicalNotes / heightCm / weightKg / eyesight
memberNo / displayName / gradeCode
genderCode / birthDate / ethnicityCode / politicalStatusCode / isVeteran
maritalStatusCode / educationCode / major / workNatureCode
residenceArea / workArea / landline / qq / wechat
hasVehicle / vehicleType / exerciseFrequencyCode / exerciseSportCode / exerciseMethods
firstAidKnowledgeCode / firstAidSkills / otherSkills
noCriminalRecordSigned / privacyConsentSigned / privacyConsentSignedAt
volunteerNo / joinedDate / joinSourceCode
```

**Emergency contacts**:
```txt
任何 emergencyContact* / contactName / contactPhone / phonePrimary / phoneBackup
relation / relationCode / emergencyContacts[]
```

**Organization / Department**:
```txt
organizationId / departmentId / organizationName / departmentName
memberDepartment* / memberDepartments[]
```

**Account 字段(走独立 endpoint)**:
```txt
username / email / password / newPassword / oldPassword / passwordHash
lastLoginAt / id / memberId / userId
```

**Role / Permission / Status**:
```txt
role / roles[] / permissions[] / permissionCodes[]
status / deletedAt
```

**审批 / 内部字段**:
```txt
reviewerNote / verifiedBy / verifiedAt / internalNote
cancelledBy* / publishedBy*
createdAt / updatedAt
```

### 3.4 空 body 行为

**两档选择**(本评审稿决议项 §6.D2):

| 档位 | 行为 | 优点 | 缺点 |
|---|---|---|---|
| **A 档**(推荐)| 空 body 返 **400 BAD_REQUEST** | 防 noise 调用 / 防前端意外触发 / 与"PATCH 至少改 1 字段"语义匹配 | 破坏与旧 `PATCH /api/users/me` 行为(旧接口空 body 返 200) |
| B 档 | 空 body 返 200 + 不改字段 | 与旧 `PATCH /api/users/me` 对称(向后兼容感) | 增加无效调用流量;前端测试时容易误以为"已改"|

**推荐 A 档**:
- 实施方式:`UpdateAppSelfProfileDto` 加 `@ValidateNested` + 自定义 class-validator validator,或在 controller 入口 service 内 `if (dto.nickname === undefined && dto.avatarKey === undefined) throw BAD_REQUEST`(沿 [`CLAUDE.md §5`](../CLAUDE.md) BizException 范式)
- 不沿用旧 `PATCH /api/users/me` 范式的理由:新接口 P2-2 是新契约,无向后兼容包袱;空 body 在 App 端属于 frontend bug

### 3.5 PATCH 后返回值

PATCH 成功后**返新的 `AppSelfProfileDto`**(字段集与 GET 完全一致;由 `AppProfileService.updateMyProfile` 内部调 GET 路径拼字段并返回)。

理由:
- 单次响应即可让前端刷新本地缓存,避免多一次 GET
- 沿 [P0-D PATCH /api/users/me](../src/modules/users/users.controller.ts) 范式(返 `UserResponseDto`)

---

## 4. DTO 设计(完整草案)

### 4.1 物理目录

```txt
src/modules/users/dto/app/
├── app-self-profile.dto.ts                # 新;含 AppSelfProfileDto
└── update-app-self-profile.dto.ts          # 新;含 UpdateAppSelfProfileDto
```

**复用** P2-1 已建立的 `src/modules/users/dto/app/` 目录(沿 Phase 0.7 §2.3);**禁止**新建 `src/modules/member-profiles/dto/app/`(P2-2 GET 数据源虽涉 MemberProfile,但 DTO 归属 users 模块 — 因 `AppSelfProfileDto` 是 "本人 me/profile 视角",不是 member-profiles 管理视角)。

### 4.2 命名与结构

```ts
// src/modules/users/dto/app/app-self-profile.dto.ts
//
// Phase 2 P2-2 App /me/profile GET / PATCH 共用出参。
// 沿 docs/app-api-p2-2-profile-review.md §2.4 v0.1 字段集**恰好 9 个**;
// **严禁**继承 / Pick / Omit / Mapped Types Admin DTO(沿 Phase 0.7 §2.2 + Phase 2 review §5.2 #1)。
// 不含 MemberProfile 任何字段(P2-2 v0.1 收窄;沿 §2.3 决议);
// 不含 email(由 /api/app/v1/me/account 承载);
// 不含 medical / emergency contacts / organization / department / role / permissions /
// gradeCode / joinedDate / realName / mobileMasked / documentNumberMasked / canUseApp / appAccessReason。
export class AppSelfProfileDto {
  @ApiProperty({ description: '当前登录用户 id', example: 'cl9z3a8b00000abcd1234efgh' })
  userId!: string;

  @ApiProperty({ description: '已绑定 member id(canUseApp=true 时非空)', example: 'cl9z3a8b00000mxxxxxxxxxx' })
  memberId!: string;

  @ApiProperty({ description: '账号名', example: 'volunteer001' })
  username!: string;

  @ApiProperty({ description: '昵称', nullable: true, example: '阿明' })
  nickname!: string | null;

  @ApiProperty({ description: '头像 attachment key(不返 signed URL)', nullable: true })
  avatarKey!: string | null;

  @ApiProperty({ description: '队员编号(终身不变)', example: 'V0001' })
  memberNo!: string;

  @ApiProperty({ description: '队员展示名', example: '王小明' })
  displayName!: string;

  @ApiProperty({ description: '队员状态(P2-2 进入时强约 ACTIVE)', enum: MemberStatus })
  memberStatus!: MemberStatus;

  @ApiProperty({ description: '是否已有 MemberProfile 档案(派生;单字段 select)', example: true })
  hasMemberProfile!: boolean;
}
```

```ts
// src/modules/users/dto/app/update-app-self-profile.dto.ts
//
// Phase 2 P2-2 App PATCH /me/profile 入参。
// 沿 docs/app-api-p2-2-profile-review.md §3 严格 2 字段白名单;
// **严禁**继承 / Pick / Omit / Mapped Types Admin DTO;
// **严禁**夹带 Member 业务 / Emergency contacts / Organization / Department / Role / Permission / Account / 审批字段(沿 §3.3);
// forbidNonWhitelisted: true 兜底,DTO 自身白名单是第一道防线(沿 CLAUDE.md §11)。
export class UpdateAppSelfProfileDto {
  @ApiPropertyOptional({ description: '昵称', maxLength: 50 })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  nickname?: string;

  @ApiPropertyOptional({ description: '头像 attachment key', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  avatarKey?: string;
}
```

### 4.3 命名铁律复核

- ✅ `AppSelfProfileDto` 沿 [Phase 0.5 §6.1](app-permission-boundary-review.md) `AppSelf*Dto` 命名规范
- ✅ `UpdateAppSelfProfileDto` 沿"动作 + 视角 + 资源 + Dto"风格
- ✅ **不**继承任何 Admin DTO(`MemberProfileResponseDto` / `UpdateMemberProfileDto` / `UserResponseDto` / `UpdateUserDto` / `UpdateMyProfileDto`)
- ✅ **不**继承 Prisma 类型
- ✅ 字段集与 PATCH 入参字段集**不一致**(GET 9 字段 > PATCH 2 字段;这是 AppSelf 视角"可读 ≠ 可写"的语义,正确)

---

## 5. Identity / Access 复用与准入校验

### 5.1 P2-1 复用

```txt
AppIdentityResolver(已在 P2-1 提供)
├─ resolve(currentUser): Promise<{ canUseApp, reason, member }>
└─ loadUserForApp(userId): Promise<UserForApp | null>
```

**复用方式**(沿 [Phase 0.7 §13.2 P0/P1 过渡](code-architecture-boundary-review.md)):
- P2-2 是 `AppIdentityResolver.resolve` 的**第二次复用**(P2-1 是首次);沿 §13.2 决议:**不**抽 `AppIdentityService`,继续保留 `AppIdentityResolver` 单 class 内嵌于 `users` 模块
- P2-2 的 `AppProfileService` 通过 `constructor(private readonly appIdentity: AppIdentityResolver, ...)` 注入

### 5.2 准入闭包(沿 Phase 2 review §6.1)

两 endpoint 在 controller / service 内执行:

```txt
读 currentUser(由 JwtAuthGuard 注入)
  ↓
JwtStrategy.validate 已挡 User.status!=ACTIVE / deletedAt!=null
  ↓
const access = await this.appIdentity.resolve(currentUser);
  ↓
if (!access.canUseApp) {
  → 沿 §6.3 拒绝路径
  → 抛 BizException(BizCode.FORBIDDEN) + message 区分 reason
}
  ↓
继续业务逻辑(GET 拼字段 / PATCH 写)
```

### 5.3 三类失败场景(沿 §6 / Phase 0.6 §5.4 L1-L8 矩阵)

| reason | User 状态 | Member 状态 | P2-2 GET 行为 | P2-2 PATCH 行为 |
|---|---|---|---|---|
| `MEMBER_NOT_LINKED`(L1 / L8)| ACTIVE | `User.memberId=null` | 走拒绝路径(沿 §5.4) | 走拒绝路径 |
| `MEMBER_INACTIVE`(L3)| ACTIVE | linked + `Member.status=INACTIVE` | 走拒绝路径 | 走拒绝路径 |
| `MEMBER_DELETED`(L4)| ACTIVE | linked + `Member.deletedAt!=null` | 走拒绝路径 | 走拒绝路径 |
| (canUseApp=true)| ACTIVE | linked + ACTIVE + deletedAt=null | 200 + AppSelfProfileDto | 200 + AppSelfProfileDto |

### 5.4 拒绝路径设计(本评审稿明确)

> 与 P2-1 的"capability-aware 返 200 + canUseApp=false"**不同**;P2-2 是**业务 endpoint**,无 capability 路径,必须显式拒绝。

#### 方案 A:复用 `FORBIDDEN`(40300)(**推荐**;沿 Phase 2 review §6.3 临时方案)

| reason | HTTP | code | message |
|---|---|---|---|
| `MEMBER_NOT_LINKED` | 403 | 40300 | `"App 功能不可用:未绑定队员档案"` |
| `MEMBER_INACTIVE` | 403 | 40300 | `"App 功能不可用:队员档案已停用"` |
| `MEMBER_DELETED` | 403 | 40300 | `"App 功能不可用:队员档案不存在"` |

**优点**:
- 不新增 BizCode,段位干净(沿 [`CLAUDE.md §5`](../CLAUDE.md)"新增 BizCode 必须先说明使用场景")
- 前端通过 `/me/capabilities` 提前规避,极少触发 GET / PATCH 拒绝路径
- HTTP status 语义正确(403 = "已认证但不允许")

**缺点**:
- 三种 reason 共用一个 code,前端难直接区分(但 message 文案不同,差异可解析)
- 不符合"每业务 reason 独立 BizCode"风格(沿 SRVF baseline)

**实现细节**:
- 在 `AppProfileService` 内定义私有 helper:`assertCanUseApp(access: AppAccessResult): asserts access is { canUseApp: true; ... }`
- helper 内根据 `access.reason` 切换 BizException message:
  ```ts
  if (!access.canUseApp) {
    const messageByReason = {
      MEMBER_NOT_LINKED: 'App 功能不可用:未绑定队员档案',
      MEMBER_INACTIVE:   'App 功能不可用:队员档案已停用',
      MEMBER_DELETED:    'App 功能不可用:队员档案不存在',
    };
    throw new BizException({
      ...BizCode.FORBIDDEN,
      message: messageByReason[access.reason!],
    });
  }
  ```
- 但**注意**:这违反 `BizException` 类型签名锁死(沿 [`CLAUDE.md §5`](../CLAUDE.md)"`BizException` 类型签名锁死;构造参数类型必须为 BizCode 联合类型,不接收裸数字 / 字符串 / 临时对象")
- **替代实现**:不动 message,只抛 `BizException(BizCode.FORBIDDEN)`,前端凭 HTTP 403 + 之前 `/me/capabilities` 缓存的 reason 字段判断;P2-2 PR 评审稿落地时确认

#### 方案 B:新增 3 个 BizCode(沿 100xx 段位)

| BizCode | code | HTTP | message |
|---|---|---|---|
| `MEMBER_NOT_LINKED` | **10008** | 403 | 未绑定队员档案 |
| `APP_MEMBER_INACTIVE` | **10009** | 403 | 队员档案已停用 |
| `APP_MEMBER_DELETED` | **10010** | 403 | 队员档案不存在 |

**优点**:
- 前端凭 `code` 直接区分,无需解析 message
- 沿 100xx users 模块业务级段位习惯(`MEMBER_INACTIVE=17030` 已被 member_departments 占用;**不复用**)
- 符合 `BizException` 类型签名锁死

**缺点**:
- 新增 3 个 BizCode,需用户决议(沿 [`CLAUDE.md §5`](../CLAUDE.md)"新增 BizCode 必须先说明使用场景与前端提示价值")
- 段位 10008 / 10009 / 10010 当前已确认未占用(沿 §6.D1)

**注意 `MEMBER_INACTIVE=17030` 命名冲突**:已存在的 17030 message 是"队员状态非活跃,不能挂部门"(member_departments 模块业务码);若新增 `APP_MEMBER_INACTIVE=10009`,需:
- 用新名字 `APP_MEMBER_INACTIVE`(避免 enum key 冲突);**禁止**复用 `MEMBER_INACTIVE` 名字改 message(沿 baseline "BizCode key 改名不向后兼容")
- 或**不**新增,沿方案 A 复用 FORBIDDEN

#### 推荐:**方案 A**(沿 Phase 2 review §6.3 临时方案;P2-2 不新增 BizCode)

**理由**:
1. P2-2 范围最小化;BizCode 段位归属是跨 PR 决策面,留 Phase 2 整体收尾时一并决议(沿 Phase 2 review §12.2.5 "P2-1 评审稿决议"已明确留给后续)
2. P2-1 已建立"`AppIdentityResolver` + capability-aware 拒绝路径"范式;P2-2 是首个**业务 endpoint** 拒绝路径,作为试点验证方案 A;若方案 A 上线后前端反馈"message 解析不便",再立独立 PR 升 BizCode
3. 沿"不预先新增"原则(沿 [`CLAUDE.md §5`](../CLAUDE.md))

---

## 6. BizCode 策略(v0.1 锁定)

### 6.1 P2-2 不新增 BizCode

**P2-2 实施 PR 严格遵守以下 4 条策略**:

```txt
P2-2 不新增 BizCode
canUseApp=false   → FORBIDDEN=40300
empty body        → BAD_REQUEST=40000
forbidden field   → BAD_REQUEST=40000
```

详细说明:

| 场景 | HTTP | code | 处理路径 |
|---|---|---|---|
| `canUseApp=false`(3 种 reason 任一)| 403 | `FORBIDDEN=40300` | service 入口 `assertCanUseApp` 抛 `BizException(BizCode.FORBIDDEN)`;reason 由 message 文案区分(沿 §5.4 方案 A;**不**改 `BizException` 类型签名,沿用现有 `BizCode.FORBIDDEN` 入参,**不**注入自定义 message) |
| empty body(`nickname` / `avatarKey` 都 undefined)| 400 | `BAD_REQUEST=40000` | `AppProfileService.updateMyProfile` 入口校验后抛 `BizException(BizCode.BAD_REQUEST)`(沿 §3.4 A 档) |
| forbidden field(传 `realName` / `mobile` / `role` / 任一禁止字段)| 400 | `BAD_REQUEST=40000` | 全局 `ValidationPipe` `forbidNonWhitelisted: true` 自动生成 message(沿 [`CLAUDE.md §7`](../CLAUDE.md));`AppProfileService` 不参与 |

### 6.2 不开任何新号位的候选 BizCode

| 候选 BizCode | 状态 |
|---|---|
| `APP_ACCESS_DENIED` | ❌ 不开;与 `FORBIDDEN` 重叠 |
| `MEMBER_NOT_LINKED` | ❌ 不开;沿 §6.1 复用 `FORBIDDEN` |
| `APP_MEMBER_INACTIVE` | ❌ 不开;**不**复用既有 `MEMBER_INACTIVE=17030`(member_departments 模块语义,不通用) |
| `APP_MEMBER_DELETED` | ❌ 不开;沿 §6.1 |
| `APP_PROFILE_UPDATE_EMPTY` | ❌ 不开;沿 §3.4 A 档,空 body 复用 `BAD_REQUEST=40000`(可在 BizException 抛出时 message 文案明确"至少需要 1 个字段") |
| `APP_PROFILE_FIELD_FORBIDDEN` | ❌ 不开;沿 `forbidNonWhitelisted: true` 自动兜底 |

### 6.3 锁定理由

1. P2-2 v0.1 范围最小化;BizCode 段位归属是跨 PR 决策面,留 Phase 2 整体收尾时一并决议(沿 Phase 2 review §12.2.5)
2. P2-1 已建立"`AppIdentityResolver` + capability-aware 拒绝路径"范式;P2-2 是首个**业务 endpoint** 拒绝路径,作为试点验证 §6.1 策略
3. 沿"不预先新增"原则(沿 [`CLAUDE.md §5`](../CLAUDE.md) "新增 BizCode 必须先说明使用场景与前端提示价值")
4. **若**方案 A 上线后前端反馈"message 解析不便",再立独立 PR 升 BizCode(沿 100xx 段位 10008 / 10009 / 10010,**不**复用 17030);此为 P2-2 之外的独立决策面

### 6.4 决议项汇总(v0.1 已锁定)

| 决议项 | v0.1 锁定 | v0 备选(历史)| 状态 |
|---|---|---|---|
| **D1**:GET /profile 字段档位 | **9 字段基线**(沿 §2.1) | A 档 11 字段 / B 档 16 字段 / C 档 30+ 字段 | ✅ v0.1 锁定 |
| **D2**:PATCH /profile 空 body 行为 | **400 BAD_REQUEST=40000** | 200 沿旧 | ✅ v0.1 锁定 |
| **D3**:拒绝路径 BizCode 策略 | **复用 FORBIDDEN=40300** | 新增 10008-10010 | ✅ v0.1 锁定 |
| **D4**:`hasMemberProfile` 派生字段保留 | **保留** | 移除 | ✅ v0.1 锁定 |
| **D5**:GET 返 `bloodTypeCode` | **不返**(留 Phase 2.x) | 返 | ✅ v0.1 锁定 |
| **D6**:GET 返 `organizationName` / `departmentName` | **不返**(留 Phase 2.x) | 返 | ✅ v0.1 锁定 |
| **D7**:PATCH 后返新 `AppSelfProfileDto` | **返**(单响应) | 204 NoContent | ✅ v0.1 锁定 |
| **D8**:PR 是否拆 P2-2a / P2-2b | **不拆**(单 PR) | 拆 | ✅ v0.1 锁定 |

---

## 7. Presenter / Service 落地建议

### 7.1 4 档备选

| 档位 | 实施 | 优点 | 缺点 |
|---|---|---|---|
| **A** | 新增 `AppProfileService`(独立 service,含 GET + PATCH 两个 method) | 沿 Phase 0.7 §11 Refactor Trigger;清晰边界 | 文件数 +1 |
| B | 新增 `AppSelfProfilePresenter`(纯 mapper)+ Controller 内直接调 Prisma | 极简 | Controller 拼业务逻辑(违反 Phase 0.7 §5.2);拒绝路径散落 Controller |
| C | 不新建 service / presenter,在 `AppMeController` 内私有 method 拼字段 | 最简 | 违反 Phase 0.7 §5.2(controller 不直接拼业务逻辑);P2-2 之后再扩 endpoint 时需重构 |
| D | 复用 `UsersService.updateMyProfile`,在 controller 内 mapper 转 DTO | 沿用 P0-D 现成 method | GET 路径无法复用(没有"GET self profile" method);拒绝路径散落 Controller |

### 7.2 推荐 A 档:`AppProfileService`

**目录与文件**:
```txt
src/modules/users/
├── app-profile.service.ts                     # 新;含 AppProfileService
├── (P2-1 已有)app-identity.resolver.ts
├── (P2-1 已有)app-capability.service.ts
├── controllers/
│   └── app-me.controller.ts                   # 在 P2-1 已有文件追加 2 个 method(不开新 controller)
└── dto/app/
    ├── app-self-profile.dto.ts                # 新
    ├── update-app-self-profile.dto.ts         # 新
    └── (P2-1 已有)app-access-reason.ts / app-me-response.dto.ts / app-me-account.dto.ts / app-capability-response.dto.ts
```

**`AppProfileService` 接口**:

```ts
// src/modules/users/app-profile.service.ts
//
// Phase 2 P2-2 App /me/profile GET / PATCH 业务 service。
// 沿 docs/app-api-p2-2-profile-review.md §7;
// 准入沿 P2-1 AppIdentityResolver(沿 Phase 0.7 §13.2 不抽 AppIdentityService);
// PATCH 复用 P0-D UsersService.updateMyProfile(字段都是 User 表;不动 P0-D 行为)。
// GET 仅派生 hasMemberProfile(单字段 select);**不**读 MemberProfile 任何业务字段。
@Injectable()
export class AppProfileService {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,  // 仅用于派生 hasMemberProfile(单字段 select);不读 MemberProfile 业务字段;不写
  ) {}

  async getMyProfile(currentUser: CurrentUserPayload): Promise<AppSelfProfileDto> { /* ... */ }

  async updateMyProfile(
    currentUser: CurrentUserPayload,
    dto: UpdateAppSelfProfileDto,
  ): Promise<AppSelfProfileDto> {
    // 1) 准入校验
    const access = await this.appIdentity.resolve(currentUser);
    this.assertCanUseApp(access);

    // 2) 空 body 拦截(沿 §3.4 A 档)
    if (dto.nickname === undefined && dto.avatarKey === undefined) {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    // 3) **白名单显式重构**:从 dto **逐字段**取 nickname / avatarKey 重组,
    //    **禁止**透传 raw `dto` / `req.body` 给 UsersService(沿 §7.4 铁律)
    const safeDto: UpdateMyProfileDto = {
      nickname: dto.nickname,
      avatarKey: dto.avatarKey,
    };
    await this.usersService.updateMyProfile(currentUser, safeDto);

    // 4) 返新 AppSelfProfileDto(沿 §3.5)
    return this.getMyProfile(currentUser);
  }

  private assertCanUseApp(access: AppAccessResult): asserts access is { canUseApp: true; member: Member } {
    if (!access.canUseApp) {
      throw new BizException(BizCode.FORBIDDEN);  // §6.1 复用 FORBIDDEN
    }
  }
}
```

**Module 注入**(沿 [users.module.ts](../src/modules/users/users.module.ts) 现有结构):

```ts
@Module({
  imports: [DatabaseModule, AuditLogsModule, PermissionsModule],
  controllers: [UsersController, AppMeController],
  providers: [
    UsersService,
    AppIdentityResolver,
    AppCapabilityService,
    AppProfileService,  // 新增
  ],
})
export class UsersModule {}
```

**注意**:
- `AppProfileService` 注入 `UsersService` 时,**只调** `updateMyProfile`(已有 P0-D method);**不**调 admin 路径 method(`list` / `findOne` / `update` / `resetPassword` / `updateRole` / `updateStatus` / `softDelete` / `create`)
- `AppProfileService` 不写 `MemberProfile`(P2-2 PATCH 仅改 User);**仅派生** `MemberProfile.id` 单字段(无业务字段读取)
- 不引入 `MemberProfilesService` 注入(避免跨模块耦合;`MemberProfile.id` 派生走 `PrismaService` 直读;`select: { id: true }` 白名单)
- 沿 v0.1 收窄,**不**实现 `maskTail4` 等掩码 helper(P2-2 范围零 L2 字段返回;留 Phase 2.x 完整 read PR)

### 7.3 AppMeController 追加 2 个 method(沿 P2-1 文件)

```ts
// src/modules/users/controllers/app-me.controller.ts(P2-1 已存在文件,追加方法)

@Get('profile')
@ApiOperation({ summary: 'App 视角本人 profile(User + Member 基础摘要 + hasMemberProfile 派生;canUseApp=true 必要)' })
@ApiWrappedOkResponse(AppSelfProfileDto)
@ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
async getMyProfile(@CurrentUser() currentUser: CurrentUserPayload): Promise<AppSelfProfileDto> {
  return this.appProfile.getMyProfile(currentUser);
}

@Patch('profile')
@ApiOperation({ summary: 'App 视角本人改 profile(严格白名单 nickname / avatarKey)' })
@ApiWrappedOkResponse(AppSelfProfileDto)
@ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
async updateMyProfile(
  @CurrentUser() currentUser: CurrentUserPayload,
  @Body() dto: UpdateAppSelfProfileDto,
): Promise<AppSelfProfileDto> {
  return this.appProfile.updateMyProfile(currentUser, dto);
}
```

**Controller 不动**:
- `@ApiTags('Mobile - Me')` 沿 P2-1 class-level tag
- `@ApiBearerAuth()` 沿 P2-1
- `@Controller('app/v1/me')` 沿 P2-1
- **不**新建 `AppMeProfileController`(避免 controller 数膨胀)

### 7.4 PATCH 中复用 `UsersService.updateMyProfile` 的白名单要求(铁律)

[`UsersService.updateMyProfile`](../src/modules/users/users.service.ts):
- 入参 `currentUser: CurrentUserPayload` + `dto: UpdateMyProfileDto`(P0-D 现成 DTO)
- 返回 `UserResponseDto`
- 内部:`prisma.user.update({ where: { id: currentUser.id, deletedAt: null }, data: { nickname, avatarKey }, select: userSafeSelect })`

**白名单铁律**:
即使复用 `UsersService.updateMyProfile`,**P2-2 也必须通过 `UpdateAppSelfProfileDto` 先把 body 限制为 `nickname` / `avatarKey`,再传给 `UsersService`**。
**不得**把原始 request body / `dto` 整体引用透传给 `UsersService`。

实施要求:
- **入参验证两道防线**:
  1. controller `@Body() dto: UpdateAppSelfProfileDto` + 全局 `ValidationPipe` `forbidNonWhitelisted: true` 阻挡禁止字段(沿 [`CLAUDE.md §7`](../CLAUDE.md))
  2. `AppProfileService.updateMyProfile` 内部**显式重构**`safeDto`,逐字段从 `dto.nickname` / `dto.avatarKey` 取值,**禁止** `as unknown as UpdateMyProfileDto` cast 透传,**禁止** `{ ...dto }` 透传,**禁止** `dto as UpdateMyProfileDto` 透传(沿 §7.2 service 代码示例)
- **不**新建 service method(`UsersService.updateMyProfileFromApp` 之类);沿用现有 `updateMyProfile`,体现"业务能力跨 surface 复用"(沿 Phase 0.7 §1.2 #1)
- **不**改 `UsersService.updateMyProfile` 签名 / 行为(沿 Phase 2 review §3.2 不动 P0-D 行为)
- PATCH 完成后,丢弃 `UserResponseDto`(P0-D 返的),用 `AppProfileService.getMyProfile()` 再拼一次 `AppSelfProfileDto`(避免 DTO 跨视角混用;沿 Phase 0.7 §2.2 #6)

**PR review 强断言**:
- grep `AppProfileService` 的 `updateMyProfile` 实现内,**必须**含 `{ nickname: dto.nickname, avatarKey: dto.avatarKey }` 显式字段重构;**禁止**出现 `as unknown` / `as UpdateMyProfileDto` / `{ ...dto }` 任一模式
- e2e `forbidden field` 用例(沿 §9.2 参数化测试)逐字段反向断言:即使绕过 controller 层 `ValidationPipe` 注入 `realName` / `mobile` 等字段,`UsersService.updateMyProfile` 最终也**只**收到 `{ nickname, avatarKey }`(可通过 jest spy 验证)— 这是"DTO 是第一道防线,白名单显式重构是第二道防线"的双重保护(沿 [`CLAUDE.md §11` 纵深防御](../CLAUDE.md))

---

## 8. 数据源判断

### 8.1 字段 × 数据源 × 是否新增 select

| 字段 | 数据源 | P2-1 已有? | P2-2 新读? |
|---|---|---|---|
| userId | `User.id` | ✅(P2-1 `loadUserForApp`) | 复用 |
| username | `User.username` | ✅ | 复用 |
| nickname | `User.nickname` | ✅ | 复用 |
| avatarKey | `User.avatarKey` | ✅ | 复用 |
| memberId | `User.memberId` | ✅(`AppAccessResult.member.id`) | 复用 |
| memberNo | `Member.memberNo` | ✅(`AppAccessResult.member`) | 复用 |
| displayName | `Member.displayName` | ✅ | 复用 |
| memberStatus | `Member.status` | ✅ | 复用 |
| hasMemberProfile | 派生(单字段 select)| ❌ | **新读**(仅 `select: { id: true }`)|

**剔除字段(沿 v0.1 收窄)**:
- `email`(P2-1 `/me/account` 已承载;P2-2 profile 不重复)
- `gradeCode`(留 Phase 2.x)
- `realName` / `mobileMasked` / `documentNumberMasked` / `joinedDate`(留 Phase 2.x 完整 read PR)

### 8.2 MemberProfile 查询策略(派生 `hasMemberProfile`)

```ts
const probe = await this.prisma.memberProfile.findFirst({
  where: notDeletedWhere({ memberId: access.member.id }),
  select: { id: true },  // **单字段**白名单;不读任何业务字段
});
const hasMemberProfile = probe !== null;
```

**关键约束**:
- `select` 严格白名单 `{ id: true }`;**禁止** `select: undefined` / 多字段 select(防全字段或单字段意外暴露 L1 / L2 / L3)
- **沿 `notDeletedWhere`**(沿 [`CLAUDE.md §10`](../CLAUDE.md) 软删除)
- **不**读 `realName` / `mobile` / `documentNumber` / `joinedDate` 等业务字段(沿 v0.1 收窄;留 Phase 2.x)
- **不**读 emergency contacts / certificates / member-departments
- **不**在 `AppIdentityResolver` 内引入 MemberProfile join(避免 P2-1 已冻结的 resolve 签名变化;沿 Phase 2 review §3.2)

---

## 9. 测试要求

### 9.1 GET `/api/app/v1/me/profile` e2e 用例(8 个)

> 沿 Phase 2 review §9.2 9 类用例,但因 v0.1 收窄(无 L2 / L1 摘要字段、无掩码),GET 用例可大幅压缩:
> - 移除"sensitive field not returned"独立用例 → 合并到每个 success 用例的 `assertNoForbiddenKeys` 共享断言
> - 移除"masked format"两个用例(`***1234` / `****` 兜底)→ v0.1 不返 masked 字段
> - 移除"无 MemberProfile 时其他字段为 null"用例 → v0.1 仅 `hasMemberProfile` 派生,无其他依赖

| # | 用例 | 期待 |
|---|---|---|
| 9.1.1 | success(有 MemberProfile) | 200 + 字段集**恰好 9** + `hasMemberProfile=true` + `assertNoForbiddenKeys` 通过 |
| 9.1.2 | success(无 MemberProfile;member 存在但 profile 未创建)| 200 + `hasMemberProfile=false` + 其他 8 字段正常返 |
| 9.1.3 | unauthenticated(无 token / 错 token 合 1 用例,参数化 2 case)| 401 + `UNAUTHORIZED=40100` |
| 9.1.4 | member not linked(`User.memberId=null`)| 403 + `FORBIDDEN=40300` |
| 9.1.5 | member inactive(`Member.status=INACTIVE`)| 403 + `FORBIDDEN=40300` |
| 9.1.6 | member deleted(`Member.deletedAt!=null`)| 403 + `FORBIDDEN=40300` |
| 9.1.7 | admin-as-member(ADMIN + linked active)| 200 + 字段集**与 USER 视角完全一致**;response **不**含 `role` / `permissions[]` / `permissionCodes[]`(沿 D-5.2)|
| 9.1.8 | scope self(造他人 active member B,登录 A 调 `/me/profile` 仅返 A) | 验证 `where memberId = currentUser.memberId` 隔离 |

> 共享断言 `assertNoForbiddenKeys`(沿 P2-1 helper 复用):每个 success 用例的 response **不**含 L3 / L2 完整 / L2 医疗 / 紧急联系人 / 组织部门 / Admin 内部审批 / 系统字段 / 派生 `canUseApp` / `appAccessReason` / `profileCompletion`(完整禁字段沿 §2.4)。

### 9.2 PATCH `/api/app/v1/me/profile` e2e 用例(12 个)

> 沿 Phase 2 review §9.2 + 用户拍板"参数化测试 / 按类别覆盖,不要求每禁止字段单独 e2e":

| # | 用例 | 期待 |
|---|---|---|
| 9.2.1 | success: update nickname | 200 + 返新 `AppSelfProfileDto`(9 字段)+ DB `user.nickname` 已写入 |
| 9.2.2 | success: update avatarKey | 200 + DB `user.avatarKey` 已写入 |
| 9.2.3 | success: update both | 200 + 两字段都已写入 |
| 9.2.4 | empty body | **400 + `BAD_REQUEST=40000`**(沿 §3.4 A 档) |
| 9.2.5 | **参数化** forbidden field by **类别**:Member 业务字段(`realName` / `mobile` / `documentNumber` / `bloodTypeCode` / `medicalNotes` / `memberNo` / `displayName` / `gradeCode` 等)| 400 + `BAD_REQUEST=40000`;Jest `it.each` / `describe.each` 参数化覆盖 ≥ 6 字段 |
| 9.2.6 | **参数化** forbidden field by **类别**:Account 字段(`username` / `email` / `password` / `newPassword` / `id` / `userId` / `memberId` / `lastLoginAt`)| 同上;参数化 ≥ 4 字段 |
| 9.2.7 | **参数化** forbidden field by **类别**:Role / Permission / Status / 审批字段(`role` / `permissions` / `status` / `deletedAt` / `reviewerNote` / `verifiedBy`)| 同上;参数化 ≥ 3 字段 |
| 9.2.8 | **参数化** forbidden field by **类别**:Emergency contacts / Organization / Department(`emergencyContacts` / `contactName` / `organizationId` / `departmentId`)| 同上;参数化 ≥ 3 字段 |
| 9.2.9 | unauthenticated | 401 |
| 9.2.10 | member not linked / inactive / deleted(参数化 3 case)| 403 + `FORBIDDEN=40300` |
| 9.2.11 | admin-as-member: ADMIN + linked → 改 nickname / avatarKey 成功 | 200;sensitive 字段不返;Admin 不扩大字段集(沿 D-5.2) |
| 9.2.12 | path stability:对同一 user 调旧 `PATCH /api/users/me` 改 nickname → 仍然 200 + `UserResponseDto`(沿 Phase 2 review §9.2 #9;**逐字不变**)|

> **参数化策略**(沿用户拍板):
> - §9.2.5 ~ §9.2.8 共 4 个 `describe.each` block,每 block 含 3-6 个参数化 case;**总 e2e block 数 4 个**,**实际 assertion case 数 ~16**
> - 实现 PR 可用 Jest `it.each(forbiddenFieldsTable)` 或 `describe.each(categoryTable)` 实现;PR review 仅断言 4 个类别 block 各自 ≥ 3 个 case 即可
> - **不要求**每个禁止字段单独写 it,**实施 PR 用参数化保证**字段白名单的纵深防御
> - **明确实现 PR 路径**:`UpdateAppSelfProfileDto` 类定义 + Jest 参数化 cases 共同构成"DTO 是第一道防线 + 参数化 e2e 是第二道防线"
>
> **scope self 已合并到 §9.1.8**(GET 验过 scope 后 PATCH 同共享 `where userId = currentUser.id` 由 P0-D 保证,无需重复 e2e)
>
> **sensitive field not returned in PATCH response 已合并**到 §9.2.1 / §9.2.2 / §9.2.3 共享 `assertNoForbiddenKeys`

### 9.3 Contract snapshot

| 变更 | 期待 |
|---|---|
| 新增 path `GET /api/app/v1/me/profile` | 出现在 OpenAPI snapshot |
| 新增 path `PATCH /api/app/v1/me/profile` | 出现 |
| 新增 schema `AppSelfProfileDto` | 字段集**恰好 9 个**(沿 §2.4 v0.1 锁定) |
| 新增 schema `UpdateAppSelfProfileDto` | 字段集**恰好 2 个**(`nickname` / `avatarKey`)— **强断言**;沿 §10.11a 风险表 |
| 旧 path `GET /api/users/me` / `PATCH /api/users/me` schema | **逐字不变** |
| 旧 path `GET /api/v2/members/:memberId/profile` / `PATCH` / `POST` | **逐字不变** |
| 旧 schema `UserResponseDto` / `UpdateMyProfileDto` / `MemberProfileResponseDto` / `UpdateMemberProfileDto` / `CreateMemberProfileDto` | **逐字不变** |
| 现有 route 总数(沿 `test/contract/openapi.contract-spec.ts` EXPECTED_ROUTES)| **+ 2**(GET + PATCH /api/app/v1/me/profile) |

### 9.4 e2e 测试文件归属

```txt
test/e2e/app-me-profile.e2e-spec.ts          # 新;含 §9.1 + §9.2 用例
test/e2e/app-me.e2e-spec.ts                  # P2-1 已存在;不动
test/e2e/users-me.e2e-spec.ts                # P0-D 已存在;不动(path stability)
test/e2e/member-profiles.e2e-spec.ts         # 批次 1 已存在;不动
test/contract/openapi.contract-spec.ts       # P2-1 修改;EXPECTED_ROUTES +2 + snapshot 重生
```

### 9.5 测试用例总数

| 维度 | 数量(v0.1 收窄)|
|---|---|
| GET 用例 | **8** |
| PATCH 用例 block | **12**(含 4 个参数化 block × 3-6 case ≈ 16 assertion cases) |
| Contract 断言 | 8 项 |
| **合计 it block** | **20**(8 GET + 12 PATCH;符合用户拍板 20-25 区间)|
| **合计 assertion cases**(含参数化展开)| **~33**(8 + 25)|

---

## 10. PR 拆分与大小

### 10.1 PR 范围(v0.1 收窄)

| 范围 | 行数估计 |
|---|---|
| `AppSelfProfileDto`(9 字段)+ `UpdateAppSelfProfileDto`(2 字段)| ~55 |
| `AppProfileService`(无掩码 helper,无 MemberProfile 业务读)| ~80 |
| `AppMeController` 追加 2 method | ~30 |
| `UsersModule` providers 注入 | ~5 |
| `test/e2e/app-me-profile.e2e-spec.ts`(20 个 it block + 参数化展开 ~33 cases)| ~170 |
| `test/contract/openapi.contract-spec.ts` 改 + snapshot diff | ~30 |
| docs 同步引用 / `current-state.md` / `CHANGELOG.md`(P2-8 收尾) | 不计 |
| **合计** | **~370 行** |

### 10.2 是否拆 PR

| 选项 | 备注 |
|---|---|
| **不拆**(推荐)| 370 行远低于 500 行阈值;GET + PATCH 强语义耦合(同 DTO 同 service 同 controller);拆开评审反而增加 review 负担 |
| 拆 P2-2a(GET)+ P2-2b(PATCH)| 拒绝;沿 v0.1 收窄,单 PR < 400 行已无拆分必要 |

**推荐:不拆**;P2-2 PR 单 PR 完成。

### 10.3 不夹带清单

P2-2 PR **绝对不**包含:
- ❌ `/api/app/v1/me/password`(P2-3 独立 PR;沿 Phase 2 review §8.1 修订版)
- ❌ `/api/app/v1/me/emergency-contacts/*`(Phase 2.x 单独立项;沿 Phase 2 review §5.2 #5 + §3.1)
- ❌ `/api/app/v1/me/department`(Phase 2.x 或 Phase 0.5 §3.2 `me/*` 段扩展)
- ❌ `/api/app/v1/me/profile/full`(身份证号完整查看接口;Phase 2 不实施;沿 Phase 0.6 §2.3 铁律 5)
- ❌ `/api/app/v1/my/*`(P2-5 / P2-6 / P2-7 范围)
- ❌ `/api/app/v1/activities/*`(P2-4)
- ❌ Phase 1B alias(`/api/auth/v1/*` / `/api/public/v1/*`)
- ❌ 任何 `prisma/schema.prisma` 修改
- ❌ 任何 `MemberProfile` 写路径
- ❌ 任何 `EmergencyContact` 触及
- ❌ 任何 RBAC permission seed
- ❌ `AppCapabilityService` 字段集扩展(沿 P2-1 冻结)
- ❌ `UsersService.updateMyProfile` 签名 / 行为改动
- ❌ `MemberProfilesService` 注入到 `AppProfileService`(避免跨模块耦合)
- ❌ 旧 `PATCH /api/users/me` / `GET /api/users/me` / `PUT /api/users/me/password` 行为 / contract 改动
- ❌ 旧 `GET / PATCH / POST /api/v2/members/:memberId/profile` 任何改动

---

## 11. 风险表

> 风险等级:**极高** / **高** / **中** / **低**。每条对应 P2-2 PR review 拒绝信号 + 缓解方案 + 是否阻塞。
> v0.1 收窄后,GET 字段集 9 个无 MemberProfile / 无掩码,部分原风险已沿决议消除。

| # | 风险 | 触发条件 | 影响 | 缓解 | 阻塞 P2-2? |
|---|---|---|---|---|---|
| 11.1 | **PATCH 白名单放宽** | 实施者在 `UpdateAppSelfProfileDto` 加除 `nickname` / `avatarKey` 之外的字段 | **极高(合规 + 越权)**;一旦 App 上线本人可改自己身份证 / 部门 / 角色,**安全事故**;`forbidNonWhitelisted` 兜底**不**足以挡住已声明白名单字段 | PR review 强制 grep `class UpdateAppSelfProfileDto`,断言字段集恰好 `{nickname, avatarKey}`;contract snapshot 强断言 schema 字段数 = 2;e2e §9.2.5 ~ §9.2.8 4 个参数化 block 共覆盖各类禁止字段 | ✅ 是 |
| 11.2 | **PATCH 服务层透传 raw body** | `AppProfileService.updateMyProfile` 内用 `as unknown as UpdateMyProfileDto` / `{ ...dto }` / `dto as UpdateMyProfileDto` 把入参整体传给 `UsersService` | **极高(纵深防御失守)**;一旦 controller `ValidationPipe` 被绕过(JSON.parse + reflect-metadata 边界情况),禁止字段会落到 P0-D `UsersService.updateMyProfile`,可能写 `User` 任意字段(实际 P0-D `prisma.user.update({ data: { nickname, avatarKey }})` 已限白名单,但 service 层默认应是**纵深第二道防线**)| **沿 §7.4 铁律**:`AppProfileService.updateMyProfile` **必须**显式重构 `safeDto = { nickname: dto.nickname, avatarKey: dto.avatarKey }` 后再传给 `UsersService`;PR review 强制 grep,**禁止**出现 `as unknown` / `as UpdateMyProfileDto` / `{ ...dto }` 任一模式;e2e §9.2.5 ~ §9.2.8 参数化反例兜底 | ✅ 是 |
| 11.3 | **GET 返 MemberProfile 业务字段** | 实施者读 `MemberProfile.realName` / `mobile` / `documentNumber` / `medicalNotes` / `emergencyContacts` / `bloodTypeCode` 任一字段并返出 | **极高(合规)**;P2-2 v0.1 已明确不读 MemberProfile 业务字段 | DTO 字段集 §2.4 冻结**恰好 9 个**;§8.2 MemberProfile 查询 `select` 严格 `{ id: true }` 单字段白名单;PR review 强制 grep `AppProfileService` 内**禁止**出现 `realName` / `mobile` / `documentNumber` / `medicalNotes` / `bloodTypeCode` / `emergencyContact*` 任一标识符;contract snapshot 强断言 schema 字段数 = 9 | ✅ 是 |
| 11.4 | **复用 Admin DTO** | 实施者 `class AppSelfProfileDto extends UserResponseDto`(裁剪)/ `PickType MemberProfileResponseDto` / `OmitType UpdateMemberProfileDto` | **极高(合规 + 字段集污染)** | 沿 Phase 0.5 §6.2 + Phase 0.7 §2.2 + Phase 2 review §5.2 #1;PR review 强制 grep `extends.*Dto` / `PickType\|OmitType\|IntersectionType\|PartialType.*Dto` 全模式 | ✅ 是 |
| 11.5 | **Admin-as-member 越权看他人数据** | service 内 `if (user.role === ADMIN) return prisma.member.findMany(...)` 短路 | **极高(越权)** | 沿 Phase 0.5 §10.2 D-5.2;`AppProfileService` 内**永远**用 `currentUser.id` / `currentUser.memberId`,**禁止** `role` 短路;e2e §9.1.7 / §9.2.11 admin-as-member 自视角断言 | ✅ 是 |
| 11.6 | **member inactive 仍可改资料** | service 内未拦 `Member.status=INACTIVE` 路径 | 高(数据合规);离队队员仍可改本人资料违反 Phase 0.6 §5.4 L3 行 | `AppProfileService.assertCanUseApp` 在所有 method 入口调用;e2e §9.1.5 / §9.2.10 反向断言 | ✅ 是 |
| 11.7 | **空 body 行为不清** | 实施者沿用旧 `PATCH /api/users/me` 200 行为 | 中(语义不清) | 沿 §3.4 / §6.1;`AppProfileService.updateMyProfile` 入口先校验 `dto.nickname === undefined && dto.avatarKey === undefined` 抛 BAD_REQUEST;e2e §9.2.4 断言 400 | ✅ 是(v0.1 锁定) |
| 11.8 | **私自新增 BizCode** | 实施者私自新建 `MEMBER_NOT_LINKED=10008` / `APP_MEMBER_INACTIVE=10009` 等 | 中(段位规划) | 沿 §6.1 锁定:**P2-2 不新增 BizCode**;PR review 强制 grep [`src/common/exceptions/biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) 中**无新增** key | ✅ 是(v0.1 锁定) |
| 11.9 | **修改旧 `/api/users/me` 行为** | 实施者图省事改 `UsersService.updateMyProfile` 签名 / 返回类型 / 内部逻辑 | 高(向后兼容破坏) | 沿 Phase 2 review §3.2;PR review 强制 git diff 中**无** `users.service.ts` / `users.controller.ts` / `users.dto.ts` 业务逻辑改动(仅允许 import 新增);e2e §9.2.12 path stability 用例 | ✅ 是 |
| 11.10 | **直接操作 MemberProfile** | PATCH 路径意外触及 `prisma.memberProfile.update(...)`,或 GET 路径读 `MemberProfile.*` 业务字段 | **极高(写敏感数据 / 越权读)** | `AppProfileService.updateMyProfile` **只**调 `UsersService.updateMyProfile`(改 User 表);`AppProfileService.getMyProfile` 仅派生 `hasMemberProfile`(`select: { id: true }` 单字段);PR review 强制 grep `prisma.memberProfile.update\|create\|delete\|upsert` 在 `AppProfileService` 内**不出现**;`prisma.memberProfile.findFirst` 在 `AppProfileService` 内出现时,`select` 必须严格 `{ id: true }` | ✅ 是 |
| 11.11 | **`hasMemberProfile` 派生字段误判** | 实施者用 `await prisma.memberProfile.count(...)` / `findUnique` 等非 `findFirst + notDeletedWhere` 路径 | 低(展示错;软删 profile 被误计为存在) | 沿 §8.2:严格 `findFirst({ where: notDeletedWhere({ memberId }), select: { id: true } })`;e2e §9.1.2 反向断言 | 否 |
| 11.12 | **PATCH 后 GET 字段不一致** | PATCH 返 `AppSelfProfileDto`,GET 也返 `AppSelfProfileDto`,但 PATCH 内私自拼字段,字段集与 GET 不同 | 中(契约破坏) | `AppProfileService.updateMyProfile` 内部先调 `UsersService.updateMyProfile` 完成写入,然后调 `this.getMyProfile(currentUser)` 拼返;两路径共享 DTO 构造逻辑 | ✅ 是 |
| 11.13 | **e2e 路径稳定性测试缺失** | PR 未覆盖旧 `/api/users/me*` / `/api/v2/members/:memberId/profile*` 路径回归 | 中(契约破坏)| e2e 必须包含 §9.2.12 + 旧 contract snapshot 通过 | ✅ 是 |
| 11.14 | **PR 行数超阈值** | DTO 校验装饰器 + Service 完整版 + e2e + contract 累计可能 > 400 | 低(review 质量;v0.1 收窄后预计 ~370 行,余量充足)| 沿 §10.2 不拆;若实际 > 500 行才考虑拆 P2-2a(GET)+ P2-2b(PATCH)| ⚠️ PR 启动前 estimate |
| 11.15 | **跨模块耦合 MemberProfilesService** | `AppProfileService` 注入 `MemberProfilesService`,触发"管理后台 admin 路径在 App service 内可调用"风险 | 中(架构污染)| 沿 §7.2:`AppProfileService` 注入 `PrismaService` 直读 `MemberProfile.id`,**不**注入 `MemberProfilesService`;PR review 强制 import 检查 | ✅ 是 |
| 11.16 | **canUseApp / appAccessReason 字段意外出现在 profile response** | 实施者从 `AppMeResponseDto` 复制字段时把 `canUseApp` / `appAccessReason` 也带过来 | 中(契约不一致;profile 200 已隐含 canUseApp=true)| 沿 §2.4 字段集**恰好 9 个**;contract snapshot 强断言;PR review 检查 `AppSelfProfileDto` 字段名清单 | ✅ 是 |

---

## 12. 同步引用

### 12.1 必须改的文档

| 文件 | 改动 |
|---|---|
| [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md) | §2 表 P2-2 行的 "Service 复用" 列由 `member-profile self perspective method` 改为 "Phase 2 P2-2 implementation must read `docs/app-api-p2-2-profile-review.md` before code changes" 引用;或在 §11.1 "本评审稿被引用" 段下新增 `docs/app-api-p2-2-profile-review.md`(沿 process.md §6 不重写既有设计) |

### 12.2 不改的文档(沿 Phase 2 review v0.1 / §11)

- [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md)
- [`docs/app-permission-boundary-review.md`](app-permission-boundary-review.md)
- [`docs/data-access-lifecycle-boundary-review.md`](data-access-lifecycle-boundary-review.md)
- [`docs/code-architecture-boundary-review.md`](code-architecture-boundary-review.md)
- `CLAUDE.md` / `AGENTS.md`(D-8 已在 P2-0 PR 中明确"Phase 2 implementation must read `docs/app-api-phase-2-review.md`";本评审稿是 Phase 2 review 的下位文件,沿 D-8 自动覆盖,**无需**新增 D-9)
- [`docs/V2红线与复活路径.md`](V2红线与复活路径.md)
- [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md)

### 12.3 §19.7 D-9 是否新增

**不新增**。理由:
- D-8 已明确 "Before implementing any `/api/app/v1/*` endpoint, agents must read and follow `docs/app-api-phase-2-review.md`";Phase 2 review §11.1 已建议"本评审稿被引用"机制传递给下位评审稿
- 本评审稿(P2-2 review)是 Phase 2 review 的**下位**文档;沿 D-8 引用链自动覆盖(`P2-2 implementation must read this doc before code` 在本文档头明确)
- 避免 §19 章节过度膨胀(沿 [`CLAUDE.md §19.7 D-1 ~ D-8` 编号空间](../CLAUDE.md))

---

## 13. 决策记录 / 验收 / 修订

### 13.1 已沿用决策(沿 Phase 0.5 / 0.6 / 0.7 / Phase 2 review)

- ✅ 候选 / 临时编号志愿者**不进**P2-2 范围(沿 D-5.1)
- ✅ Admin 兼队员走 linked-member self perspective(沿 D-5.2)
- ✅ 不暴露 raw RBAC permission code(沿 D-5.3)— P2-2 GET / PATCH 响应不含 `permissions[]` / `permissionCodes[]`
- ✅ `/me/*` 与 `/my/*` 物理拆分(沿 D-5.4)— `/me/profile` 归 `/me/*`
- ✅ App DTO 禁止 `extends` / `Pick` / `Omit` Admin DTO(沿 Phase 0.7 §2.2)
- ✅ Mobile API 默认 `scope = self`(沿 Phase 0.6 §3.3)
- ✅ L3 字段永不返回(沿 Phase 0.6 §2.3)
- ✅ Phase 2 不动 schema / migration / Role / MemberStatus / Permission seed(沿 Phase 2 review §3.2)
- ✅ 不夹带 P2-3(`/me/password`)/ P2-4 ~ P2-7 / Phase 1B / Phase 2.x 任何 endpoint
- ✅ 不动旧 `/api/users/me*` 行为(沿 Phase 2 review §3.2 + §9.2 #9)

### 13.2 本评审稿决议项(2026-05-19 v0.1 已锁定)

> 沿 §6.4 决议项汇总;v0.1 修订后全部 8 项决议已由用户拍板锁定,**禁止**重开讨论(除非用户主动 reopen)。

| # | 决议项 | v0.1 锁定 | 备选(已拒绝) |
|---|---|---|---|
| **D1** | GET /profile 字段档位 | **v0.1 收窄基线 9 字段**(沿 §2.1) | A 档 11 / B 档 16 / C 档 30+ |
| **D2** | PATCH /profile 空 body 行为 | **400 BAD_REQUEST=40000** | 200 沿旧 |
| **D3** | 拒绝路径 BizCode 策略 | **复用 FORBIDDEN=40300** | 新增 10008-10010 |
| **D4** | `hasMemberProfile` 派生字段保留 | **保留** | 移除 |
| **D5** | GET 返 `bloodTypeCode` | **不返**(留 Phase 2.x) | 返(只读) |
| **D6** | GET 返 `organizationName` / `departmentName` | **不返**(留 Phase 2.x) | 返(只读) |
| **D7** | PATCH 后返新 `AppSelfProfileDto` | **返**(单响应)| 204 NoContent |
| **D8** | PR 是否拆 P2-2a / P2-2b | **不拆**(单 PR ~370 行)| 拆(GET / PATCH) |

### 13.3 修订规则

- 本评审稿 v0 用户拍板冻结后,**就地**修订(沿 [Phase 1 评审稿 §10](api-client-boundary-phase-1-review.md));**不**新建 v1 / v2 文档
- 每次修订记录修订时间 + 变更摘要(在本节末追加)
- P2-2 PR 实施时若发现本评审稿与代码冲突,**暂停**并向用户汇报,**禁止**自行调和

### 13.4 验收锚点

| 锚点 | 状态 |
|---|---|
| 本评审稿 v0 用户拍板冻结 | ⏳ 待 |
| `docs/app-api-phase-2-review.md` 同步引用 | ⏳ 与本评审稿同 PR |
| P2-2 implementation PR | ⏳ 待立项 |

### 13.5 修订历史

| 日期 | 版本 | 摘要 |
|---|---|---|
| 2026-05-19 | v0 | 本评审稿 v0 创建;2 个 endpoint + 2 个 DTO + 1 个 service + 35 e2e 用例 + 18 条风险表;沿 Phase 2 review v0.1 + Phase 0.5 / 0.6 / 0.7 全套约束 |
| 2026-05-19 | v0.1 | **v0.1 收窄修订**(用户拍板锁定 D1 ~ D8 八项决议):① GET 字段集**收窄到 9 个**(剔除 `email` / `gradeCode` / `joinedDate` / `realName` / `mobileMasked` / `documentNumberMasked` / `canUseApp` / `appAccessReason`),`email` 由 `/me/account` 承载,MemberProfile 业务字段全部留 Phase 2.x 完整 read PR;② PATCH 白名单保留 2 字段(`nickname` / `avatarKey`);③ §6 重构为"P2-2 不新增 BizCode"硬锁(`canUseApp=false → FORBIDDEN=40300` / `empty body → BAD_REQUEST=40000` / `forbidden field → BAD_REQUEST=40000`);④ §7.4 强化"`AppProfileService` 必须先用 `UpdateAppSelfProfileDto` 拦截 body 再传给 `UsersService`,禁止透传 raw body";⑤ §9 e2e **压缩到 20 个 it block**(GET 8 + PATCH 12,含 4 个参数化禁字段 block);⑥ §11 风险表沿 v0.1 收窄重组(剔除 mobileMasked / 掩码 helper / D1 备选等;新增 11.2 透传 raw body 风险 + 11.16 canUseApp 字段意外出现);⑦ §10 PR 行数估计从 ~545 行降到 ~370 行 |

---

## 14. 范围审计

### 14.1 P2-2 PR 改动范围(预期)

```txt
新增文件:
  src/modules/users/app-profile.service.ts
  src/modules/users/dto/app/app-self-profile.dto.ts
  src/modules/users/dto/app/update-app-self-profile.dto.ts
  test/e2e/app-me-profile.e2e-spec.ts

改动文件(增量):
  src/modules/users/controllers/app-me.controller.ts        # +2 method
  src/modules/users/users.module.ts                          # +AppProfileService provider
  test/contract/openapi.contract-spec.ts                     # EXPECTED_ROUTES +2
  test/contract/__snapshots__/openapi.contract-spec.ts.snap  # snapshot 重生

不改文件(沿 Phase 2 review §3.2):
  prisma/schema.prisma
  src/modules/users/users.service.ts(行为)
  src/modules/users/users.controller.ts(行为)
  src/modules/users/users.dto.ts(`UpdateMyProfileDto` / `UserResponseDto`)
  src/modules/member-profiles/*
  src/modules/users/app-identity.resolver.ts(P2-1 冻结)
  src/modules/users/app-capability.service.ts(P2-1 冻结)
  src/modules/users/dto/app/app-me-response.dto.ts(P2-1 冻结)
  src/modules/users/dto/app/app-me-account.dto.ts(P2-1 冻结)
  src/modules/users/dto/app/app-capability-response.dto.ts(P2-1 冻结)
  src/modules/users/dto/app/app-access-reason.ts(P2-1 冻结)
  src/common/exceptions/biz-code.constant.ts(沿 D3 推荐方案 A 不新增)
  src/bootstrap/*
  src/main.ts
  package.json / pnpm-lock.yaml
```

### 14.2 P2-2 PR 严格不做

```txt
- 不改 prisma/schema.prisma
- 不生成 prisma migration
- 不改 Role enum / UserStatus enum / MemberStatus enum
- 不新增 Permission seed / RbacRole
- 不修改 src/modules/users/users.service.ts 任何 method 签名 / 行为
- 不修改 src/modules/users/users.controller.ts 行为
- 不修改 src/modules/users/users.dto.ts UpdateMyProfileDto / UserResponseDto / ChangeMyPasswordDto / ResetUserPasswordDto / CreateUserDto / UpdateUserDto / UpdateUserRoleDto / UpdateUserStatusDto
- 不修改 src/modules/member-profiles/* 任何文件
- 不修改 src/modules/users/app-identity.resolver.ts(P2-1 冻结)
- 不修改 src/modules/users/app-capability.service.ts(P2-1 冻结)
- 不修改 P2-1 任何 DTO
- 不修改 src/common/exceptions/biz-code.constant.ts(沿 D3 推荐方案 A;若 D3 选 B,新增 3 个 BizCode 须独立评估段位)
- 不安装新依赖 / 不改 package.json / 不改 pnpm-lock.yaml
- 不改 apply-swagger.ts / apply-global-setup.ts
- 不动旧 path /api/users/me / /api/users/me/password / /api/v2/members/:memberId/profile* / /api/v2/users/me/* 任何行为
- 不实现 /api/app/v1/me/password(P2-3 独立 PR)
- 不实现 /api/app/v1/me/emergency-contacts/*(Phase 2.x)
- 不实现 /api/app/v1/me/department(Phase 2.x 或 Phase 0.5 §3.2)
- 不实现 /api/app/v1/me/profile/full(身份证号完整查看;Phase 2 不实施)
- 不实现 /api/app/v1/my/*(P2-4 ~ P2-7)
- 不实现 /api/app/v1/activities/*(P2-4)
- 不实现 Phase 1B /api/auth/v1/* / /api/public/v1/* alias
- 不修改 Phase 1A Swagger Tag
- 不引入 Redis / queue / cron / outbox / casl
- 不预先建跨模块 dto/ 公共目录
```

---

## 15. 实施引用与下一步

### 15.1 P2-2 implementation 引用

**P2-2 implementation must read** `docs/app-api-p2-2-profile-review.md` **before any `/api/app/v1/me/profile` endpoint PR**。

本评审稿 §1 ~ §14 是 P2-2 PR 的硬约束;任何偏离视为越权,必须暂停并向用户汇报。

### 15.2 解除时机

P2-2 PR 落地合入 main 后,本评审稿降为"历史评审"性质;沿 [Phase 1 评审稿 §10](api-client-boundary-phase-1-review.md) / V2 红线 §5.1 handoff 历史规则。

### 15.3 不解决的问题(留独立评审稿)

- ❌ 不解决 `App 端紧急联系人` schema / endpoint 设计(Phase 2.x `/api/app/v1/me/emergency-contacts/*` 单独立项)
- ❌ 不解决 `App 端我的部门` endpoint 设计(Phase 2.x `/api/app/v1/me/department` 单独立项)
- ❌ 不解决 `App 端完整身份证号查看` endpoint 设计(Phase 2.x 单独立项 + 审计 + 限流)
- ❌ 不解决 `App 端 PATCH realName / mobile / documentNumber` 等 Member 业务字段(Phase 2.x 单独立项;沿 Phase 2 review §5.2 #5 尾段)
- ❌ 不解决 `App 端医疗资料` 暴露策略(Phase 2.x 单独立项)
- ❌ 不解决 `App 端贡献值汇总` 端点(Phase 2 P2-7 `/my/contribution-points` 或更晚)
- ❌ 不解决 `App 端附件 me/uploaded` 端点(Phase 2.x;沿 Phase 2 review §3.2)

---

> **本评审稿生效时间**:2026-05-19(P2-2 实施前评审稿 v0)。
> **当前状态**:⏳ 待用户拍板冻结。
> **过期条件**:P2-2 PR 落地合入 main 后降为历史评审。
