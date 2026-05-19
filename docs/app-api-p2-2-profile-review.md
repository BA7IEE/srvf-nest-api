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
3. **GET 字段建议保守档**:`User + Member` 摘要 + **可选**`MemberProfile` 低敏字段(`email` / `realName`)+ 默认掩码 L2(`mobile` / `documentNumber` 后 4 位);**默认不返**身份证号完整值 / 健康信息 / 紧急联系人 / 组织部门只读字段。
4. **复用 P2-1 准入闭包**:`AppIdentityResolver.resolve(currentUser)` 直接复用;**不**新建 `MemberStatusGuard`;两 endpoint 必须 `canUseApp=true`,否则按拒绝路径走(沿 Phase 2 review §6.3)。
5. **PATCH 复用 P0-D `UsersService.updateMyProfile`**:`nickname` / `avatarKey` 是 `User` 表字段,沿用 P0-D 现有 method;**不**改 `UsersService` 签名;**不**走 `MemberProfile` 写路径。
6. **GET 在 `canUseApp=false` 时**:沿 P2-1 capability-aware 拒绝路径**反例** — 业务 endpoint 必须**显式拒绝**(走 `FORBIDDEN` 临时复用 + reason 文案;P2-2 评审稿明确**不**改业务 endpoint 返"空 profile")。
7. **不新增 BizCode**:`MEMBER_NOT_LINKED` / `MEMBER_INACTIVE` / `MEMBER_DELETED` 沿 Phase 2 review §6.3 临时复用 `FORBIDDEN=40300` + reason 字符串;若 P2-2 评审稿决议升正式 BizCode,沿 100xx 段位 10008 / 10009 / 10010(需用户拍板,详见 §6)。
8. **PR 大小**:预计 < 400 行 diff(2 endpoint + 2 DTO + 1 service + e2e + contract snapshot);**不**触发 P2-5 拆分级别。
9. **未启动**:P2-2 implementation / P2-3(`/me/password`)/ Phase 1B(`/api/auth/v1` / `/api/public/v1` alias)/ Phase 2.x(emergency contacts / member profile 完整改资料)— 全部留独立评审稿。

---

## 1. P2-2 最终 endpoint 设计

### 1.1 接口表

| Method | Path | Purpose | Surface | Scope | Auth | DTO | Service / Resolver reuse | Risk |
|---|---|---|---|---|---|---|---|---|
| GET | `/api/app/v1/me/profile` | 本人 member 摘要 + User 资料(沿 §3 字段集) | mobile | self | `JwtAuthGuard` + `canUseApp=true` | `AppSelfProfileDto`(出参) | `AppIdentityResolver`(P2-1)+ 新 `AppProfileService` 私有方法(可调 Prisma 拼字段 / 可选调 `MemberProfilesService.findOne` 仅读) | **高(L2 掩码)** |
| PATCH | `/api/app/v1/me/profile` | 本人改 `nickname` / `avatarKey`(严格 2 字段白名单) | mobile | self | `JwtAuthGuard` + `canUseApp=true` | `UpdateAppSelfProfileDto`(入参)+ `AppSelfProfileDto`(出参) | `AppIdentityResolver`(P2-1)+ 新 `AppProfileService.updateMyProfile()`(内部调 `UsersService.updateMyProfile`) | 中(白名单严格) |

### 1.2 路径归属(沿 D-5.4)

```txt
/api/app/v1/me/profile  ← identity / profile;归 me/* 段(沿 Phase 0.5 §10.2 D-4)
```

**不**归 `my/*`(`my/*` = "我的业务记录";profile 是 identity)。

### 1.3 实施可行性

- **GET**:`AppIdentityResolver.loadUserForApp` + `AppIdentityResolver.resolve` 已在 P2-1 提供 User 安全字段 + Member 完整字段。若 §3 决议 B 档(含 MemberProfile),需新读 `MemberProfile`(通过 `notDeletedWhere({ memberId })`)
- **PATCH**:`nickname` / `avatarKey` 是 `User` 表字段(沿 [schema.prisma:20-21](../prisma/schema.prisma)),复用 `UsersService.updateMyProfile`(沿 [users.service.ts:findMe / updateMyProfile](../src/modules/users/users.service.ts))
- **响应**:PATCH 成功后**返新的 `AppSelfProfileDto`**(与 GET 字段集一致,前端方便单次响应即可刷新本地缓存)

---

## 2. GET `/me/profile` 返回字段设计

### 2.1 字段集 3 档对比

> 字段分类标 `(L0/L1/L2/L3)` 沿 [Phase 0.6 §2.1](data-access-lifecycle-boundary-review.md);AppSelf 默认上限 = L2 本人 + 掩码(沿 [Phase 0.6 §2.3](data-access-lifecycle-boundary-review.md))。

#### A 档 — 极小返(沿 P2-2 范围最保守)

```txt
userId                     L0
memberId                   L0
username                   L1(账号名)
nickname                   L0(可空)
avatarKey                  L0(可空;沿 P2-1 现状不返 signed URL)
memberNo                   L1
displayName                L1
gradeCode                  L1(队员等级 dict code)
memberStatus               L0(枚举)
canUseApp                  L0(派生)
hasMemberProfile           L0(派生;指示 MemberProfile 是否存在)
```

**优点**:零 `MemberProfile` 依赖;不触 §10.1.5 / §10.1.6 任何决议;PR 实施风险最低。
**缺点**:与 `GET /me` 字段重叠度高(P2-1 已返 userId / memberId / username / nickname / avatarKey / memberNo / displayName / gradeCode / memberStatus / canUseApp),P2-2 唯一新增的只有 `hasMemberProfile`,**业务价值低**。

#### B 档 — 含 MemberProfile 低敏摘要(**推荐**)

```txt
A 档全部字段
+ email                    L1   ← 数据源:User.email(P2-1 已返 User.email,可视为对齐)
                                   或 MemberProfile.email(若 §2.3 决议优先取该处)
+ realName                 L1   ← 数据源:MemberProfile.realName;无 profile 时 null
+ mobileMasked             L2 masked  ← 数据源:MemberProfile.mobile;后 4 位掩码(如 `***1234`)
+ documentNumberMasked     L2 masked  ← 数据源:MemberProfile.documentNumber;后 4 位掩码
+ joinedDate               L0   ← 数据源:MemberProfile.joinedDate;ISO 字符串
```

**优点**:与 PATCH 字段集对偶(PATCH 仅 `nickname` / `avatarKey`,GET 多展示几个常用低敏字段);掩码 L2 字段满足"本人可见但默认不暴露完整"的合规要求;字段数 12 + 5 = 17,体积合理。
**缺点**:需要决议:`mobile` 完整号 / 完整身份证号是否需要 — 推荐**不**返(沿 §2.3.1);需要决议 `email` 数据源(User.email vs MemberProfile.email — 推荐 User.email,P2-1 已返,语义一致)。

#### C 档 — 含 MemberProfile 完整资料

```txt
B 档全部字段
+ 完整 mobile(L2)
+ 完整 documentNumber(L2)
+ documentTypeCode(L1)
+ genderCode(L1)
+ birthDate(L1)
+ ethnicityCode / politicalStatusCode / educationCode / maritalStatusCode(L1)
+ workNatureCode / residenceArea / workArea(L1)
+ landline / qq / wechat(L1)
+ heightCm / weightKg(L2 医疗)
+ bloodTypeCode(L2 医疗)
+ eyesight / medicalNotes(L2 医疗)
+ hasVehicle / vehicleType(L1)
+ exerciseFrequencyCode / exerciseSportCode / exerciseMethods / firstAidKnowledgeCode / firstAidSkills(L1)
+ otherSkills(L1)
+ noCriminalRecordSigned / privacyConsentSigned / privacyConsentSignedAt(L0/L1)
+ volunteerNo(L1)
```

**优点**:本人可看到自己的完整档案。
**缺点**:**大量 L2 字段触发 §10.1.6 决议**(身份证号 / 手机号是否对本人完整可见 / 健康信息是否对本人可见 / 紧急联系人是否在 profile 接口暴露);触发"完整资料导出走独立审计接口"决策(沿 Phase 0.6 §2.3 铁律 5);**P2-2 范围拒绝**。
**结论**:**C 档不在 P2-2 范围**。若业务要求实现"App 端完整 member 资料查看",**必须**单独立项 Phase 2.x 评审稿,届时一并决议:身份证号 / 手机号默认掩码 vs 完整、医疗信息可见性、紧急联系人在何处暴露、记录"查看完整资料"的 audit 行为。

### 2.2 推荐档:B 档(可降为 A 档)

| 决议项 | 推荐 | 备选 |
|---|---|---|
| GET /profile 字段档位 | **B 档(含 MemberProfile 低敏摘要 + 掩码 L2)** | A 档(零 MemberProfile);C 档拒绝 |

**降为 A 档的条件**:用户在评审时认为 P2-2 不应触 `MemberProfile` 任何字段,GET 只是 `GET /me` 的扩展视角。**实施 PR 评审稿启动时再次确认**。

### 2.3 单字段决议(B 档前提下)

#### 2.3.1 `documentNumber`(身份证号)— **默认掩码后 4 位**

- 沿 Phase 2 review §5.2 #4 / §10.11 / Phase 0.6 §2.3 铁律 5
- 字段名:`documentNumberMasked`(明确语义)
- 掩码格式:示例 `"***1234"`(原值后 4 位 + 前置 `***` 占位);若原值长度 < 4,统一 `"****"`(避免漏 timing)
- **完整号永不在 P2-2 返回**;走独立审计接口(Phase 2 不实施)

#### 2.3.2 `mobile`(手机号)— **默认掩码后 4 位**

- 沿 Phase 0.6 §2.2 #2.2(L2);沿 §2.3.1 同款掩码风格
- 字段名:`mobileMasked`
- 掩码格式:示例 `"***5678"`
- **完整号永不在 P2-2 返回**;Phase 2.x 单独决议

#### 2.3.3 `bloodTypeCode`(血型)— **B 档不返,留 C 档**

- 沿 Phase 0.6 §2.2 #2.9:L2;AppSelf 本人可见 ✅,但救援场景对 AppManaged 有特殊语义
- P2-2 评审:本人对自己血型可见无合规问题,但**P2-2 范围以"摘要"为主,血型属于医疗维度**,留给 Phase 2.x 完整资料接口
- 结论:**B 档不返**;若用户决议强制要求 P2-2 返,字段名 `bloodTypeCode`(只读;沿 PATCH 白名单**严禁** `bloodType*`)

#### 2.3.4 `medicalNotes` / `medicalNotesEnabled` — **不返**

- 沿 Phase 0.6 §2.2 #2.10:L2 + JSON
- **P2-2 拒绝任何医疗字段返回**(包括 `eyesight` / `heightCm` / `weightKg`);留 Phase 2.x

#### 2.3.5 `emergencyContacts` / `contactName` / `contactPhone` 等 — **不返**

- 沿 Phase 0.6 §2.2 #2.8 / #2.8.1:L1 / L2
- **P2-2 拒绝紧急联系人字段**;**App 端紧急联系人独立 endpoint** `/api/app/v1/me/emergency-contacts/*` 留 Phase 2.x 单独立项(沿 Phase 2 review §5.2 #5 中段)

#### 2.3.6 `organizationName` / `departmentName` 等只读组织信息 — **不返**

- 沿 Phase 0.6 §2.2 #2.6:L0(组织名)+ L1(组织架构);本人可见 ✅
- **P2-2 拒绝**:数据源跨表(`MemberDepartment` + `Organization`),实施复杂度增加;留 Phase 2.x 评审时一并决议(配合"我的部门" `/api/app/v1/me/department` 端点设计)
- 若用户决议 P2-2 必须返,字段名 `organizationName: string | null`(只读;只显示当前 active 部门所属组织名)

#### 2.3.7 `profileCompletion`(派生指标 0-100)— **不返**

- 沿 Phase 0.7 §10 派生指标边界
- **P2-2 拒绝**:派生指标需明确口径(哪些字段计入 / 权重),需独立设计;留 Phase 2.x

#### 2.3.8 `internalNote` / `reviewerNote` / `verifiedBy` / `verifiedAt` — **永禁**

- 沿 Phase 0.6 §2.2 #2.17 + Phase 2 review §5.2 #9 / #10:Admin 内部审批字段
- **任何视角下** AppSelf 都**不可见**;PR review 强制 grep 拒绝

### 2.4 推荐 B 档字段集(冻结草案)

```txt
AppSelfProfileDto {
  userId:                    string                 // User.id
  memberId:                  string                 // User.memberId(canUseApp=true 保证非空)
  username:                  string                 // User.username
  nickname:                  string | null          // User.nickname(P2-2 PATCH 可改)
  avatarKey:                 string | null          // User.avatarKey(P2-2 PATCH 可改;沿 P2-1 不返 signed URL)
  email:                     string | null          // User.email(沿 P2-1 现状)

  memberNo:                  string                 // Member.memberNo(终身不变)
  displayName:               string                 // Member.displayName
  gradeCode:                 string | null          // Member.gradeCode(可空)
  memberStatus:              MemberStatus           // Member.status(枚举;P2-2 GET 进入时强约 ACTIVE)

  realName:                  string | null          // MemberProfile.realName;无 profile 时 null
  mobileMasked:              string | null          // MemberProfile.mobile 后 4 位掩码;无 profile 时 null
  documentNumberMasked:      string | null          // MemberProfile.documentNumber 后 4 位掩码;无 profile 时 null
  joinedDate:                string | null          // MemberProfile.joinedDate ISO 字符串;无 profile 时 null

  hasMemberProfile:          boolean                // 派生;MemberProfile 是否存在
}
```

**字段总数:15**。

**严禁出现的字段(snapshot 拒合并信号)**:
- L3:`passwordHash` / `refreshToken` / `tokenHash` / `secretId*` / `secretKey*` / 完整 signed URL
- 完整 L2:**完整** `mobile` / **完整** `documentNumber`
- L2 医疗:`bloodTypeCode` / `eyesight` / `heightCm` / `weightKg` / `medicalNotes`
- 紧急联系人:任何 `emergencyContact*` 字段
- 组织部门:`organizationId` / `organizationName` / `departmentId` / `departmentName` / `memberDepartments`
- Admin 内部审批:`reviewerNote` / `verifiedBy` / `verifiedAt` / `internalNote`
- 系统字段:`deletedAt` / `role` / `status`(User.status;沿 P2-1 `me/account` 已返,profile 不重复;若必须返 status 沿 P2-1 范式)/ `permissions[]` / `permissionCodes[]` / `roles[]`
- 审计内部:`createdAt` / `updatedAt`(P2-2 范围内不返;若用户决议必返,沿 P2-1 现状)

### 2.5 数据源决议表

| 字段 | 数据源 | 备注 |
|---|---|---|
| userId / username / nickname / avatarKey / email | `User` 表 | 沿 P2-1 `loadUserForApp` 现有 select |
| memberId / memberNo / displayName / gradeCode / memberStatus | `Member` 表 | 沿 P2-1 `AppIdentityResolver.resolve` 返回的 `member` |
| realName / joinedDate | `MemberProfile` 表 | **新增**;通过 `prisma.memberProfile.findFirst({ where: notDeletedWhere({ memberId }) })` |
| mobileMasked | `MemberProfile.mobile` + 掩码函数 | **新增**;在 `AppProfileService` 内私有 helper `maskTail4(value)` |
| documentNumberMasked | `MemberProfile.documentNumber` + 掩码函数 | 同上 |
| hasMemberProfile | 派生 | `MemberProfile` 查询结果非 null 即 true |

**MemberProfile 查询失败处理**:
- `findFirst` 返 null(member 存在但无 profile)→ `hasMemberProfile=false`;`realName` / `mobileMasked` / `documentNumberMasked` / `joinedDate` 全部 `null`
- **不**抛 `MEMBER_PROFILE_NOT_FOUND`(16001);该错误码语义是"管理后台读队员 profile 失败",P2-2 App 视角应 graceful degrade 显示空字段

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
// 沿 docs/app-api-p2-2-profile-review.md §2.4 字段集(15 字段);
// **严禁**继承 / Pick / Omit / Mapped Types Admin DTO(沿 Phase 0.7 §2.2 + Phase 2 review §5.2 #1)。
// L2 字段(mobile / documentNumber)默认掩码后 4 位;完整值 P2-2 范围**永不返回**。
// 不含 medical / emergency contacts / organization / department / role / permissions(沿 §2.3 决议)。
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

  @ApiProperty({ description: '邮箱(数据源:User.email)', nullable: true })
  email!: string | null;

  @ApiProperty({ description: '队员编号(终身不变)', example: 'V0001' })
  memberNo!: string;

  @ApiProperty({ description: '队员展示名', example: '王小明' })
  displayName!: string;

  @ApiProperty({ description: '队员等级 dict code', nullable: true, example: 'L1' })
  gradeCode!: string | null;

  @ApiProperty({ description: '队员状态(P2-2 进入时强约 ACTIVE)', enum: MemberStatus })
  memberStatus!: MemberStatus;

  @ApiProperty({ description: '真实姓名(数据源:MemberProfile.realName;无 profile 时 null)', nullable: true })
  realName!: string | null;

  @ApiProperty({
    description: '手机号后 4 位掩码(L2 默认掩码;完整号 P2-2 范围不返;无 profile 时 null)',
    nullable: true,
    example: '***5678',
  })
  mobileMasked!: string | null;

  @ApiProperty({
    description: '证件号后 4 位掩码(L2 默认掩码;完整号 P2-2 范围不返;无 profile 时 null)',
    nullable: true,
    example: '***1234',
  })
  documentNumberMasked!: string | null;

  @ApiProperty({ description: '加入日期 ISO 字符串(无 profile 时 null)', nullable: true })
  joinedDate!: string | null;

  @ApiProperty({ description: '是否已有 MemberProfile 档案', example: true })
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
- ✅ 字段集与 PATCH 入参字段集**不一致**(GET 15 字段 > PATCH 2 字段;这是 AppSelf 视角"可读 ≠ 可写"的语义,正确)

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

## 6. 是否新增 BizCode

### 6.1 评估表

| 候选 BizCode | 推荐 | 备注 |
|---|---|---|
| `APP_ACCESS_DENIED` | **不新增** | 与 `FORBIDDEN` 语义重叠;沿 §5.4 方案 A 复用 `FORBIDDEN=40300` |
| `MEMBER_NOT_LINKED` | **不新增** | 沿 §5.4 方案 A;message 文案区分 |
| `APP_MEMBER_INACTIVE` | **不新增** | 沿 §5.4 方案 A;**不**复用 `MEMBER_INACTIVE=17030`(member_departments 模块语义) |
| `APP_MEMBER_DELETED` | **不新增** | 沿 §5.4 方案 A |
| `APP_PROFILE_UPDATE_EMPTY` | **不新增** | 沿 §3.4 A 档;空 body 复用 `BAD_REQUEST=40000` + message `"PATCH 请求至少需要 1 个字段"` |
| `APP_PROFILE_FIELD_FORBIDDEN` | **不新增** | 禁止字段由 `forbidNonWhitelisted: true` 兜底返 `BAD_REQUEST=40000` + class-validator 自动生成 message |

### 6.2 决议项汇总

| 决议项 | 推荐 | 备选 | 待用户拍板 |
|---|---|---|---|
| **D1**:GET /profile 字段档位 | **B 档(含 MemberProfile 低敏摘要)** | A 档(零 MemberProfile)/ C 档(拒绝) | ⚠️ 是 |
| **D2**:PATCH /profile 空 body 行为 | **A 档(400)** | B 档(200 沿旧) | ⚠️ 是 |
| **D3**:拒绝路径方案 | **方案 A(复用 FORBIDDEN)** | 方案 B(新增 10008-10010 BizCode) | ⚠️ 是 |
| **D4**:`hasMemberProfile` 字段是否保留 | **保留** | 移除(简化) | ⚠️ 是 |
| **D5**:GET 是否返 `bloodTypeCode` | **不返**(留 Phase 2.x) | 返(只读) | 推荐不返;若用户决议需返,字段名 `bloodTypeCode` 只读 |
| **D6**:GET 是否返 `organizationName` / `departmentName` | **不返**(留 Phase 2.x) | 返(只读) | 推荐不返;若返,字段名 `organizationName: string \| null` |
| **D7**:PATCH 后是否返新 `AppSelfProfileDto` | **返**(单次响应) | 返 204 NoContent | 推荐返;沿 [users.controller.ts updateMyProfile](../src/modules/users/users.controller.ts) |

**若 D3 选方案 B,10008 / 10009 / 10010 段位锁定**(沿 [`CLAUDE.md §5` 段位登记](../CLAUDE.md);P0-E refresh token 已占 10007,下一可用 10008)。

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
// PATCH 复用 P0-D UsersService.updateMyProfile(字段都是 User 表;不动 P0-D 行为);
// GET 自读 MemberProfile(若 D1 选 B 档);掩码 helper 在本 service 内私有。
@Injectable()
export class AppProfileService {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly usersService: UsersService,
    private readonly prisma: PrismaService,  // 仅用于读 MemberProfile;不写
  ) {}

  async getMyProfile(currentUser: CurrentUserPayload): Promise<AppSelfProfileDto> { /* ... */ }

  async updateMyProfile(
    currentUser: CurrentUserPayload,
    dto: UpdateAppSelfProfileDto,
  ): Promise<AppSelfProfileDto> { /* ... */ }

  private assertCanUseApp(access: AppAccessResult): asserts access is { canUseApp: true; member: Member } {
    if (!access.canUseApp) {
      throw new BizException(BizCode.FORBIDDEN);  // §5.4 方案 A
    }
  }

  private maskTail4(value: string | null): string | null {
    if (value === null) return null;
    if (value.length < 4) return '****';
    return `***${value.slice(-4)}`;
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
- `AppProfileService` 不写 `MemberProfile`(P2-2 PATCH 仅改 User);**只读** `MemberProfile`(GET 拼字段)
- 不引入 `MemberProfilesService` 注入(避免跨模块耦合;`MemberProfile` 数据走 `PrismaService` 直读;读 select 字段集白名单在 `AppProfileService` 内私有)

### 7.3 AppMeController 追加 2 个 method(沿 P2-1 文件)

```ts
// src/modules/users/controllers/app-me.controller.ts(P2-1 已存在文件,追加方法)

@Get('profile')
@ApiOperation({ summary: 'App 视角本人 profile(member 摘要 + L2 掩码;canUseApp=true 必要)' })
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

### 7.4 PATCH 中复用 `UsersService.updateMyProfile` 的注意

[`UsersService.updateMyProfile`](../src/modules/users/users.service.ts):
- 入参 `currentUser: CurrentUserPayload` + `dto: UpdateMyProfileDto`(P0-D 现成 DTO)
- 返回 `UserResponseDto`
- 内部:`prisma.user.update({ where: { id: currentUser.id, deletedAt: null }, data: { nickname, avatarKey }, select: userSafeSelect })`

P2-2 复用时需要:
- **类型转换**:`UpdateAppSelfProfileDto` 字段集 `{nickname, avatarKey}` 与 `UpdateMyProfileDto` 完全一致 — **直接传值**;`as unknown as UpdateMyProfileDto` 类型 cast(或 explicit literal `{ nickname: dto.nickname, avatarKey: dto.avatarKey }`)
- **不**新建 service method(`UsersService.updateMyProfileFromApp` 之类);沿用现有 `updateMyProfile`,体现"业务能力跨 surface 复用"(沿 Phase 0.7 §1.2 #1)
- **不**改 `UsersService.updateMyProfile` 签名 / 行为(沿 Phase 2 review §3.2 不动 P0-D 行为)
- PATCH 完成后,丢弃 `UserResponseDto`(P0-D 返的),用 `AppProfileService.getMyProfile()` 再拼一次 `AppSelfProfileDto`(避免 DTO 跨视角混用;沿 Phase 0.7 §2.2 #6)

---

## 8. 数据源判断

### 8.1 字段 × 数据源 × 是否新增 select

| 字段 | 数据源 | P2-1 已有? | P2-2 新读? |
|---|---|---|---|
| userId | `User.id` | ✅(P2-1 `loadUserForApp`) | 复用 |
| username | `User.username` | ✅ | 复用 |
| nickname | `User.nickname` | ✅ | 复用 |
| avatarKey | `User.avatarKey` | ✅ | 复用 |
| email | `User.email` | ✅ | 复用 |
| memberId | `User.memberId` | ✅(`AppAccessResult.member.id`) | 复用 |
| memberNo | `Member.memberNo` | ✅(`AppAccessResult.member`) | 复用 |
| displayName | `Member.displayName` | ✅ | 复用 |
| gradeCode | `Member.gradeCode` | ✅ | 复用 |
| memberStatus | `Member.status` | ✅ | 复用 |
| realName | `MemberProfile.realName` | ❌ | **新读** |
| mobileMasked | `MemberProfile.mobile` + 掩码 | ❌ | **新读** |
| documentNumberMasked | `MemberProfile.documentNumber` + 掩码 | ❌ | **新读** |
| joinedDate | `MemberProfile.joinedDate` | ❌ | **新读** |
| hasMemberProfile | 派生 | ❌ | **新读**(任一 MemberProfile select 非空即派生) |

### 8.2 MemberProfile 查询策略

```ts
const profile = await this.prisma.memberProfile.findFirst({
  where: notDeletedWhere({ memberId: access.member.id }),
  select: {
    realName: true,
    mobile: true,
    documentNumber: true,
    joinedDate: true,
  },
});
// profile === null 即 hasMemberProfile = false
```

**关键约束**:
- `select` 字段集**白名单**;**禁止** `select: undefined`(防全字段泄露 L2 / L3)
- **沿 `notDeletedWhere`**(沿 [`CLAUDE.md §10`](../CLAUDE.md) 软删除)
- **不**读 emergency contacts / certificates / member-departments(沿 §2.3)
- **不**在 `AppIdentityResolver` 内引入 MemberProfile join(避免 P2-1 已冻结的 resolve 签名变化;沿 Phase 2 review §3.2)

---

## 9. 测试要求

### 9.1 GET `/api/app/v1/me/profile` e2e 用例

> 沿 Phase 2 review §9.2 9 类用例 + 本评审稿补充:

| # | 用例 | 期待 |
|---|---|---|
| 9.1.1 | success: linked active member + 有 MemberProfile | 200 + 字段集 15 + `hasMemberProfile=true` + `realName` 非空 + `mobileMasked` / `documentNumberMasked` 带 `***` 前缀 |
| 9.1.2 | success: linked active member + 无 MemberProfile(member 存在但 profile 未创建)| 200 + `hasMemberProfile=false` + `realName / mobileMasked / documentNumberMasked / joinedDate` 全 null |
| 9.1.3 | unauthenticated: 无 token | 401 + `UNAUTHORIZED=40100` |
| 9.1.4 | unauthenticated: 错误 token | 401 + `UNAUTHORIZED=40100` |
| 9.1.5 | member not linked: User 无 memberId | 403 + `FORBIDDEN=40300`(沿 §5.4 方案 A);message 含 "未绑定" 关键字 |
| 9.1.6 | member inactive: linked + `Member.status=INACTIVE` | 403 + `FORBIDDEN=40300`;message 含 "停用" 关键字 |
| 9.1.7 | member deleted: linked + `Member.deletedAt!=null` | 403 + `FORBIDDEN=40300`;message 含 "不存在" 关键字 |
| 9.1.8 | admin-as-member: ADMIN + linked active member | 200 + 字段集与 USER 视角**完全一致**(沿 D-5.2 不扩大);特别断言 response **不**含 `role` / `permissions[]` / `permissionCodes[]` |
| 9.1.9 | sensitive field not returned: 任何返回都不含 `mobile`(完整)/ `documentNumber`(完整)/ `passwordHash` / `refreshToken` / `tokenHash` / `medicalNotes` / `emergencyContacts` / `bloodTypeCode` / `organizationName` / `departmentName` | 沿 P2-1 `assertNoForbiddenKeys` helper 复用 |
| 9.1.10 | scope self: 制造另一个 active member B(memberNo=V-OTHER),登录人 A 调 `/me/profile` 期待返 A 的数据,**不**返 B | 验证 `where memberId = currentUser.memberId` 隔离 |
| 9.1.11 | masked format: `documentNumber='110105199001011234'`(18 位)→ `documentNumberMasked='***1234'` | 掩码格式断言 |
| 9.1.12 | masked format short value: `mobile='123'`(< 4)→ `mobileMasked='****'` | 沿 §2.3.1 短值兜底 |

### 9.2 PATCH `/api/app/v1/me/profile` e2e 用例

| # | 用例 | 期待 |
|---|---|---|
| 9.2.1 | update nickname success | 200 + 返新 AppSelfProfileDto + `nickname` 已更新 + DB user.nickname 已写入 |
| 9.2.2 | update avatarKey success | 200 + `avatarKey` 已更新 |
| 9.2.3 | update both success | 200 + 两字段都已更新 |
| 9.2.4 | empty body | **400 + `BAD_REQUEST=40000`**(沿 §3.4 A 档) |
| 9.2.5 | forbidden field: `realName` | 400 + `BAD_REQUEST=40000` + class-validator forbidden message |
| 9.2.6 | forbidden field: `mobile` | 同上 |
| 9.2.7 | forbidden field: `documentNumber` | 同上 |
| 9.2.8 | forbidden field: `role` | 同上 |
| 9.2.9 | forbidden field: `password` / `newPassword` | 同上 |
| 9.2.10 | forbidden field: `email` | 同上(P2-2 不允许改 email;P0-D `UpdateMyProfileDto` 也不允许) |
| 9.2.11 | forbidden field: `id` / `userId` / `memberId` | 同上 |
| 9.2.12 | forbidden field: `status` / `deletedAt` | 同上 |
| 9.2.13 | forbidden field: `lastLoginAt` | 同上 |
| 9.2.14 | forbidden field: `emergencyContacts[]` | 同上 |
| 9.2.15 | forbidden field: `organizationId` / `departmentId` | 同上 |
| 9.2.16 | forbidden field: `bloodTypeCode` / `medicalNotes` | 同上 |
| 9.2.17 | unauthenticated | 401 |
| 9.2.18 | member not linked | 403(同 §9.1.5) |
| 9.2.19 | member inactive | 403(同 §9.1.6) |
| 9.2.20 | admin-as-member: ADMIN + linked → 改 nickname / avatarKey 成功 | 200;sensitive 字段不返;Admin 不扩大字段集 |
| 9.2.21 | old /api/users/me PATCH 行为不变:对**同一 user** 调旧 `PATCH /api/users/me` 改 nickname → 仍然 200 + `UserResponseDto` | 沿 Phase 2 review §9.2 #9 path stability;**逐字不变** |
| 9.2.22 | scope: 攻击者 A 调 PATCH /me/profile 改 `nickname='hack'` → 仅 A 的 user.nickname 改变,B / C 的 user 不动 | 验证 `where userId = currentUser.id` 隔离(实际由 P0-D `UsersService.updateMyProfile` 现有逻辑保证) |
| 9.2.23 | sensitive field not returned in PATCH response | 沿 §9.1.9 |

### 9.3 Contract snapshot

| 变更 | 期待 |
|---|---|
| 新增 path `GET /api/app/v1/me/profile` | 出现在 OpenAPI snapshot |
| 新增 path `PATCH /api/app/v1/me/profile` | 出现 |
| 新增 schema `AppSelfProfileDto` | 字段集恰好 15 个(沿 §2.4) |
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

| 维度 | 数量 |
|---|---|
| GET 用例 | 12 |
| PATCH 用例 | 23 |
| Contract 断言 | 9 项 |
| **合计** | **44 个 e2e + 9 contract 断言** |

---

## 10. PR 拆分与大小

### 10.1 PR 范围

| 范围 | 行数估计 |
|---|---|
| `AppSelfProfileDto` + `UpdateAppSelfProfileDto` | ~80 |
| `AppProfileService` | ~120 |
| `AppMeController` 追加 2 method | ~30 |
| `UsersModule` providers 注入 | ~5 |
| `test/e2e/app-me-profile.e2e-spec.ts` | ~280(44 用例) |
| `test/contract/openapi.contract-spec.ts` 改 + snapshot diff | ~30 |
| docs 同步引用 / `current-state.md` / `CHANGELOG.md`(P2-8 收尾) | 不计 |
| **合计** | **~545 行** |

### 10.2 是否拆 PR

| 选项 | 备注 |
|---|---|
| **不拆**(推荐)| 545 行接近 500 行阈值但仍可控;GET + PATCH 强语义耦合(同 DTO 同 service 同 controller);拆开评审反而增加 review 负担 |
| 拆 P2-2a(GET)+ P2-2b(PATCH)| 优点:每 PR < 300 行;缺点:GET 完成后 DTO 已冻结,PATCH 又改一次 contract snapshot,review 噪音大 |

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

| # | 风险 | 触发条件 | 影响 | 缓解 | 阻塞 P2-2? |
|---|---|---|---|---|---|
| 11.1 | **PATCH 白名单放宽** | 实施者在 `UpdateAppSelfProfileDto` 加除 `nickname` / `avatarKey` 之外的字段 | **极高(合规 + 越权)**;一旦 App 上线本人可改自己 身份证 / 部门 / 角色,**安全事故**;`forbidNonWhitelisted` 兜底**不**足以挡住已声明白名单字段 | PR review 强制 grep `class UpdateAppSelfProfileDto`,断言字段集恰好 `{nickname, avatarKey}`;contract snapshot 强断言 schema 字段数 = 2;e2e §9.2.5 ~ §9.2.16 全部覆盖 forbidden 字段反例 | ✅ 是 |
| 11.2 | **GET 返完整 `documentNumber` / `mobile`** | 实施者直接 `select: { documentNumber, mobile }` + 返完整值 | **极高(合规)**;身份证号 / 手机号是 L2 高敏字段;一旦 App 客户端缓存可重放 | 沿 §2.3.1 / §2.3.2 + §10.11(Phase 2 风险表);`AppSelfProfileDto` 类型字段名**显式**带 `Masked` 后缀;`AppProfileService` 内**集中**掩码,**禁止** Controller / DTO 内直接拼字段;e2e §9.1.11 / §9.1.12 强断言掩码格式 | ✅ 是 |
| 11.3 | **GET 返 `medicalNotes` / `emergencyContacts` / `bloodTypeCode`** | 实施者认为本人对自己医疗信息可见,**自行**扩字段集 | **极高(合规);**沿 §2.3.3 ~ §2.3.5 拒绝 | DTO 字段集 §2.4 冻结;PR review 强制检查 `AppSelfProfileDto` 字段集**恰好 15 个**;e2e §9.1.9 反向断言 response 不含禁字段 | ✅ 是 |
| 11.4 | **复用 Admin DTO** | 实施者 `class AppSelfProfileDto extends MemberProfileResponseDto`(裁剪)/ `PickType MemberProfileResponseDto` / `OmitType UpdateMemberProfileDto` | **极高(合规 + 字段集污染)** | 沿 Phase 0.5 §6.2 + Phase 0.7 §2.2 + Phase 2 review §5.2 #1;PR review 强制 grep `extends.*Dto` / `PickType\|OmitType\|IntersectionType\|PartialType.*Dto` 全模式 | ✅ 是 |
| 11.5 | **Admin-as-member 越权看他人数据** | service 内 `if (user.role === ADMIN) return prisma.memberProfile.findMany(...)` 短路 | **极高(越权)** | 沿 Phase 0.5 §10.2 D-5.2;`AppProfileService` 内**永远**用 `currentUser.id` / `currentUser.memberId`,**禁止** `role` 短路;e2e §9.1.8 / §9.2.20 admin-as-member 自视角断言 | ✅ 是 |
| 11.6 | **member inactive 仍可改资料** | service 内未拦 `Member.status=INACTIVE` 路径 | 高(数据合规);离队队员仍可改本人资料违反 Phase 0.6 §5.4 L3 行 | `AppProfileService.assertCanUseApp` 在所有 method 入口调用;e2e §9.1.6 / §9.2.19 反向断言 | ✅ 是 |
| 11.7 | **空 body 行为不清** | 实施者沿用旧 `PATCH /api/users/me` 200 行为 | 中(语义不清) | 沿 §3.4 A 档;`AppProfileService.updateMyProfile` 入口先校验 `dto.nickname === undefined && dto.avatarKey === undefined` 抛 BAD_REQUEST;e2e §9.2.4 断言 400 | ⚠️ 由 D2 决议 |
| 11.8 | **新增 BizCode 破坏段位** | 实施者私自新建 `MEMBER_NOT_LINKED=10008` / `APP_MEMBER_INACTIVE=10009` 等 | 中(段位规划) | 沿 §5.4 方案 A 推荐**不新增**;若用户拍板 D3 选方案 B,P2-2 PR 中**显式**在 [`CLAUDE.md §5`](../CLAUDE.md) 段位登记表追加新行;PR review 强制对齐 | ⚠️ 由 D3 决议 |
| 11.9 | **修改旧 `/api/users/me` 行为** | 实施者图省事改 `UsersService.updateMyProfile` 签名 / 返回类型 / 内部逻辑 | 高(向后兼容破坏) | 沿 Phase 2 review §3.2;PR review 强制 git diff 中**无** `users.service.ts` / `users.controller.ts` / `users.dto.ts` 业务逻辑改动(仅允许 import 新增);e2e §9.2.21 path stability 用例 | ✅ 是 |
| 11.10 | **直接操作 MemberProfile 敏感字段** | PATCH 路径意外触及 `prisma.memberProfile.update(...)` | **极高(写敏感数据)** | `AppProfileService.updateMyProfile` **只**调 `UsersService.updateMyProfile`(改 User 表);**禁止**调 `prisma.memberProfile.*` 任何写方法;PR review 强制 grep `prisma.memberProfile.update\|create\|delete` 在 `AppProfileService` 内**不出现** | ✅ 是 |
| 11.11 | **`hasMemberProfile` 派生字段误判** | helper 内逻辑判断 `null` / `undefined` 不一致 | 低(展示错) | 沿 §8.2 `findFirst select 白名单` 范式;返回 `profile === null` 即派生 false;e2e §9.1.2 反向断言 | 否 |
| 11.12 | **`UpdateAppSelfProfileDto` 字段 type cast 错** | 实施者用 `as unknown as UpdateMyProfileDto` 跳过 strict mode | 低(typecheck 兜底) | 推荐 explicit literal `{ nickname: dto.nickname, avatarKey: dto.avatarKey }`(沿 §7.4);PR review 检查 cast 写法 | 否 |
| 11.13 | **PATCH 后 GET 字段不一致** | PATCH 返 `AppSelfProfileDto`,GET 也返 `AppSelfProfileDto`,但 PATCH 内私自拼字段,字段集与 GET 不同 | 中(契约破坏) | `AppProfileService.updateMyProfile` 内部先调 `UsersService.updateMyProfile` 完成写入,然后调 `this.getMyProfile(currentUser)` 拼返;两路径共享 DTO 构造 helper | ✅ 是 |
| 11.14 | **e2e 路径稳定性测试缺失** | PR 未覆盖旧 `/api/users/me*` / `/api/v2/members/:memberId/profile*` 路径回归 | 中(契约破坏)| sequence:e2e 必须包含 §9.2.21 + 旧 contract snapshot 通过 | ✅ 是 |
| 11.15 | **PR 行数超 500** | DTO 校验装饰器 + Service 完整版 + e2e 44 用例 + contract 累计可能 > 500 | 中(review 质量)| 沿 §10.2 推荐不拆;若实际 > 600 行考虑拆 P2-2a(GET + DTO + GET 用例)+ P2-2b(PATCH + UpdateDto + PATCH 用例);PR 启动前 estimate 一次 | ⚠️ PR 启动前再评估 |
| 11.16 | **掩码 helper 行为不一致** | 实施者对 `null` / `undefined` / 短值处理不一致 | 低(展示错)| 沿 §2.4 + §7.2 helper:`null → null` / 短值 → `'****'` / 正常 → `'***' + slice(-4)`;e2e §9.1.11 / §9.1.12 双向覆盖 | 否 |
| 11.17 | **跨模块耦合 MemberProfilesService** | `AppProfileService` 注入 `MemberProfilesService`,触发"管理后台 admin 路径在 App service 内可调用"风险 | 中(架构污染)| 沿 §7.2:`AppProfileService` 注入 `PrismaService` 直读 MemberProfile,**不**注入 `MemberProfilesService`;PR review 强制 import 检查 | ✅ 是 |
| 11.18 | **D1 选 A 档但 DTO 仍声明 5 个 MemberProfile 字段(null)** | 用户决议 A 档但实施者照 §2.4 B 档写 DTO | 中(契约不一致) | D1 决议在评审稿冻结前明确;DTO 实施按决议结果重写;contract snapshot 字段数据 D1 选档动态 | ⚠️ 由 D1 决议 |

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

### 13.2 本评审稿决议项(用户拍板)

| # | 决议项 | 推荐 | 备选 |
|---|---|---|---|
| **D1** | GET /profile 字段档位 | **B 档**(15 字段含 MemberProfile 低敏摘要 + 掩码) | A 档(10 字段);C 档拒绝 |
| **D2** | PATCH /profile 空 body 行为 | **A 档**(400) | B 档(200 沿旧) |
| **D3** | 拒绝路径方案 | **方案 A**(复用 FORBIDDEN=40300) | 方案 B(新增 10008/10009/10010) |
| **D4** | `hasMemberProfile` 派生字段保留? | **保留** | 移除 |
| **D5** | GET 返 `bloodTypeCode`? | **不返** | 返(只读) |
| **D6** | GET 返 `organizationName` / `departmentName`? | **不返** | 返(只读) |
| **D7** | PATCH 后返新 `AppSelfProfileDto`? | **返**(单响应) | 204 NoContent |
| **D8** | PR 是否拆 P2-2a / P2-2b? | **不拆**(单 PR ~545 行) | 拆(GET / PATCH 各一个 PR) |

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
