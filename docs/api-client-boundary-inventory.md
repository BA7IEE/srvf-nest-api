# SRVF API 客户端边界盘点(Phase 0)

> **状态**:设计期 v0(2026-05-19 盘点;仓库 HEAD = v0.14.0)
> **配套文档**:[`docs/api-client-boundary.md`](api-client-boundary.md)(顶层规范)/ [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md)(迁移路线)
> **范围**:本文档是**只读盘点**,**不**做改造、不改路由、不改 DTO。
> **分类口径**:`Auth` / `Public` / `App` / `Admin` / `System` / **`Mixed`(同端点既给 USER 又给 ADMIN 用,或同 Controller/DTO 混用)** / `Unknown`(未拍板,默认按 Mixed 处理)
>
> 当本文档的盘点与代码不一致时,**以代码为准**;本文档过期请按本节末尾"复核命令"重新生成。

---

## 0. 复核命令

```bash
# 列出所有 controller
find src -name "*.controller.ts" | sort

# 列出每个 controller 的 @Controller 前缀
grep -rn "^@Controller" src --include="*.controller.ts" | sort

# 列出每个 controller 的 HTTP method 装饰器
grep -rnE "@(Get|Post|Patch|Put|Delete)\\s*\\(" src --include="*.controller.ts" | sort

# 列出 Role 标注
grep -rn "@Roles" src --include="*.controller.ts" | sort

# 列出 Public 标注
grep -rn "@Public" src --include="*.controller.ts" | sort
```

---

## 1. 总览统计

| 项 | 数量 |
|---|---|
| Controller 文件 | **25** |
| HTTP endpoint(全量) | **约 140** |
| 全局前缀 | `/api`(`setGlobalPrefix('/api')`,见 [src/bootstrap/apply-global-setup.ts:37](../src/bootstrap/apply-global-setup.ts)) |
| v1 legacy 前缀(不带 v2) | `/api/auth/*`(4)/ `/api/users/*`(11)/ `/api/health/*`(3),共 **18** |
| v2 前缀 | `/api/v2/*`,共 **约 122** |

### 1.1 按客户端边界分类(目标态视角)

| 分类 | endpoint 数 | 备注 |
|---|---|---|
| **Auth** | 4 | `/api/auth/*`(已独立) |
| **Public** | 3 | `/api/health/*`(已独立) |
| **App**(`/me` 语义) | **10** | 散落在 5 个 Controller(详见 §5) |
| **Admin**(资源管理) | **约 73** | 大部分挂在 `/api/v2/*` |
| **System**(系统治理) | **约 47** | 字典 / RBAC / 审计 / 存储 / 附件配置 / contribution-rules |
| **Mixed / Unknown** | **约 4** | activities `list` / `findOne` 含 USER 角色;详见 §3 |

> **注**:Mixed 是过渡态。当 endpoint 含 `@Roles(SUPER_ADMIN, ADMIN, USER)` 且 service 内按角色分支裁字段 / 限范围时,记为 Mixed。

---

## 2. 完整盘点表(按 Controller 文件)

> **列定义**:
> - **HTTP**:HTTP method
> - **Path**:完整路径(`/api` + `@Controller(...)` + method path)
> - **Tag**:`@ApiTags(...)` 内容
> - **Guard**:`@Public()` / `@Roles(...)` / `JwtAuthGuard + rbac.can()` 三类
> - **Req DTO**:method 入参主 DTO
> - **Resp**:响应 DTO 形态
> - **Service**:`*.service.ts` 内调用的方法名
> - **Class**:**客户端边界分类**(本盘点结论)
> - **风险**:若有特别说明则列出(否则空)

---

### 2.1 `auth.controller.ts`(4 endpoint) — `@ApiTags('auth')` — Class:**Auth**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| POST | `/api/auth/login` | `@Public()` + `@LoginThrottle()` | `LoginDto` | `LoginResponseDto` | `login` |
| POST | `/api/auth/refresh` | `@Public()` + `@RefreshThrottle()` | `RefreshTokenDto` | `RefreshResponseDto` | `refresh` |
| POST | `/api/auth/logout` | `@Public()` + `@PasswordChangeThrottle()` | `LogoutDto` | `LogoutResponseDto` | `logout` |
| POST | `/api/auth/logout-all` | `JwtAuthGuard` + `@PasswordChangeThrottle()` | — | `LogoutResponseDto` | `logoutAll` |

**目标态**:**Auth**(`/api/auth/v1/*`)— 沿 [§2.2 Auth API](api-client-boundary.md)。
**风险**:无 — Auth 已经天然独立,P0-E 落地后契约稳定。

---

### 2.2 `health.controller.ts`(3 endpoint) — `@ApiTags('health')` — Class:**Public**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/health` | `@Public()` | — | `HealthCheckResult` | `check` |
| GET | `/api/health/live` | `@Public()` | — | `HealthCheckResult` | `checkLive` |
| GET | `/api/health/ready` | `@Public()` | — | `HealthCheckResult` | `checkReady` |

**目标态**:**Public**(`/api/public/v1/health*`)
**风险**:无 — `/api/health` 沿 v1 兼容性铁律(baseline §11)**必须保留**;Phase 1+ 若新增 `/api/public/v1/health` 视为别名,**不能下线** `/api/health`。

---

### 2.3 `users.controller.ts`(11 endpoint) — `@ApiTags('users')` — Class:**Mixed**(强烈)

| HTTP | Path | Guard | Req DTO | Resp | Service | 子分类 |
|---|---|---|---|---|---|---|
| GET | `/api/users/me` | `JwtAuthGuard`(默认登录) | — | `UserResponseDto` | `findMe` | **App** |
| PATCH | `/api/users/me` | `JwtAuthGuard` | `UpdateMyProfileDto` | `UserResponseDto` | `updateMyProfile` | **App** |
| PUT | `/api/users/me/password` | `JwtAuthGuard` + `@PasswordChangeThrottle()` | `ChangeMyPasswordDto` | `UserResponseDto` | `changeMyPassword` | **App**(P0-D) |
| GET | `/api/users` | `JwtAuthGuard` + `rbac.can(user.read.account)` | `ListUsersQueryDto` | `PageResultDto<UserResponseDto>` | `list` | **Admin** |
| POST | `/api/users` | `JwtAuthGuard` + `rbac.can(user.create.account)` | `CreateUserDto` | `UserResponseDto` | `create` | **Admin** |
| GET | `/api/users/:id` | `JwtAuthGuard` + `rbac.can(user.read.account)` | `IdParamDto` | `UserResponseDto` | `findOne` | **Admin** |
| PATCH | `/api/users/:id` | `JwtAuthGuard` + `rbac.can(user.update.account)` | `UpdateUserDto` | `UserResponseDto` | `update` | **Admin** |
| PUT | `/api/users/:id/password` | `JwtAuthGuard` + `rbac.can(user.reset.password)` | `ResetUserPasswordDto` | `UserResponseDto` | `resetPassword` | **Admin** |
| PATCH | `/api/users/:id/role` | `JwtAuthGuard` + SUPER_ADMIN 短路 | `UpdateUserRoleDto` | `UserResponseDto` | `updateRole` | **Admin** |
| PATCH | `/api/users/:id/status` | `JwtAuthGuard` + `rbac.can(user.update.status)` | `UpdateUserStatusDto` | `UserResponseDto` | `updateStatus` | **Admin** |
| DELETE | `/api/users/:id` | `JwtAuthGuard` + `rbac.can(user.delete.account)` | `IdParamDto` | `UserResponseDto` | `softDelete` | **Admin** |

**目标态**:`/me` 3 个 → **App**(`/api/app/v1/me/*`),其余 8 个 → **Admin**(`/api/admin/v1/users/*`)
**风险**:**高**
- 单 Controller 类同时承载 App 与 Admin 边界
- 同一个 `UserResponseDto` 既给 App 用(`GET /me`)也给 Admin 用(`GET /:id` / `list`)— **DTO 混用风险**
- App 视角不需要 `lastLoginAt` / `deletedAt` / `role` 等字段,Admin 视角需要

---

### 2.4 `members.controller.ts`(6 endpoint) — `@ApiTags('members')` — Class:**Admin**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/members` | `@Roles(SUPER_ADMIN, ADMIN)` | `ListMembersQueryDto` | `PageResultDto<MemberResponseDto>` | `list` |
| POST | `/api/v2/members` | `@Roles(SUPER_ADMIN, ADMIN)` | `CreateMemberDto` | `MemberResponseDto` | `create` |
| GET | `/api/v2/members/:id` | `@Roles(SUPER_ADMIN, ADMIN)` | `IdParamDto` | `MemberResponseDto` | `findOne` |
| PATCH | `/api/v2/members/:id` | `@Roles(SUPER_ADMIN, ADMIN)` | `UpdateMemberDto` | `MemberResponseDto` | `update` |
| PATCH | `/api/v2/members/:id/status` | `@Roles(SUPER_ADMIN, ADMIN)` | `UpdateMemberStatusDto` | `MemberResponseDto` | `updateStatus` |
| DELETE | `/api/v2/members/:id` | `@Roles(SUPER_ADMIN)` | `IdParamDto` | `MemberResponseDto` | `softDelete` |

**目标态**:**Admin**(`/api/admin/v1/members/*`)
**风险**:**中** — App 端缺"我的 member 详情"接口(`GET /api/app/v1/me/member`),Phase 2 必须新增,不能让 App 调 `/api/v2/members/:id`。

---

### 2.5 `member-profiles.controller.ts`(3 endpoint) — `@ApiTags('member-profiles')` — Class:**Admin(敏感)**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/members/:memberId/profile` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `MemberProfileResponseDto` | `getProfile` |
| POST | `/api/v2/members/:memberId/profile` | `@Roles(SUPER_ADMIN, ADMIN)` | `CreateMemberProfileDto` | `MemberProfileResponseDto` | `createProfile` |
| PATCH | `/api/v2/members/:memberId/profile` | `@Roles(SUPER_ADMIN, ADMIN)` | `UpdateMemberProfileDto` | `MemberProfileResponseDto` | `updateProfile` |

**目标态**:**Admin(敏感)**(`/api/admin/v1/members/:memberId/profile`)
**风险**:**高(敏感字段)** — `member_profiles` 含敏感字段(沿 [批次 1 业务确认稿] / [V2 数据模型 §6.2]);**禁止**直接搬到 `/api/app/v1/me/profile`,App 端"本人详细资料"应是独立 DTO,只暴露用户视角可见字段。

---

### 2.6 `emergency-contacts.controller.ts`(4 endpoint) — `@ApiTags('emergency-contacts')` — Class:**Admin(敏感)**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/members/:memberId/emergency-contacts` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `PageResultDto<EmergencyContactResponseDto>` | `list` |
| POST | `/api/v2/members/:memberId/emergency-contacts` | `@Roles(SUPER_ADMIN, ADMIN)` | `CreateEmergencyContactDto` | `EmergencyContactResponseDto` | `create` |
| PATCH | `/api/v2/members/:memberId/emergency-contacts/:id` | `@Roles(SUPER_ADMIN, ADMIN)` | `UpdateEmergencyContactDto` | `EmergencyContactResponseDto` | `update` |
| DELETE | `/api/v2/members/:memberId/emergency-contacts/:id` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `EmergencyContactResponseDto` | `delete` |

**目标态**:**Admin(敏感)**(`/api/admin/v1/members/:memberId/emergency-contacts/*`)
**风险**:**高(敏感字段)** — 紧急联系人含手机号、关系等 PII;App 端如需"看 / 改自己的紧急联系人"应另立 `/api/app/v1/me/emergency-contacts/*`,**入参 DTO 严格白名单**,不复用 Admin DTO。

---

### 2.7 `certificates.controller.ts`(8 endpoint) — `@ApiTags('certificates')` — Class:**Admin**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/members/:memberId/certificates` | `@Roles(SUPER_ADMIN, ADMIN)` | `ListCertificatesQueryDto` | `PageResultDto<CertificateResponseDto>` | `list` |
| POST | `/api/v2/members/:memberId/certificates` | `@Roles(SUPER_ADMIN, ADMIN)` | `CreateCertificateDto` | `CertificateResponseDto` | `create` |
| GET | `/api/v2/members/:memberId/certificates/qualification-flag` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `QualificationFlagResponseDto` | `getQualificationFlag` |
| GET | `/api/v2/members/:memberId/certificates/:id` | `@Roles(SUPER_ADMIN, ADMIN)` | `IdParamDto` | `CertificateResponseDto` | `findOne` |
| PATCH | `/api/v2/members/:memberId/certificates/:id` | `@Roles(SUPER_ADMIN, ADMIN)` | `UpdateCertificateDto` | `CertificateResponseDto` | `update` |
| DELETE | `/api/v2/members/:memberId/certificates/:id` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `CertificateResponseDto` | `delete` |
| PATCH | `/api/v2/members/:memberId/certificates/:id/verify` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `CertificateResponseDto` | `verify` |
| PATCH | `/api/v2/members/:memberId/certificates/:id/reject` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `CertificateResponseDto` | `reject` |

**目标态**:**Admin**(`/api/admin/v1/members/:memberId/certificates/*`)
**风险**:**中** — App 端需"看本人证书"(`GET /api/app/v1/me/certificates`),Phase 2 新增;Admin 视角 DTO 含 `reviewerNote` 等字段,App 视角应隐藏。

---

### 2.8 `activities.controller.ts`(7 endpoint) — `@ApiTags('activities')` — Class:**Mixed**(中)

| HTTP | Path | Guard | Req DTO | Resp | Service | 子分类 |
|---|---|---|---|---|---|---|
| GET | `/api/v2/activities` | `@Roles(SUPER_ADMIN, ADMIN, USER)` | `ListActivitiesQueryDto` | `PageResultDto<ActivityResponseDto>` | `list` | **Mixed** |
| POST | `/api/v2/activities` | `@Roles(SUPER_ADMIN, ADMIN)` | `CreateActivityDto` | `ActivityResponseDto` | `create` | **Admin** |
| GET | `/api/v2/activities/:id` | `@Roles(SUPER_ADMIN, ADMIN, USER)` | `IdParamDto` | `ActivityResponseDto` | `findOne` | **Mixed** |
| PATCH | `/api/v2/activities/:id` | `@Roles(SUPER_ADMIN, ADMIN)` | `UpdateActivityDto` | `ActivityResponseDto` | `update` | **Admin** |
| DELETE | `/api/v2/activities/:id` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `ActivityResponseDto` | `softDelete` | **Admin** |
| PATCH | `/api/v2/activities/:id/publish` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `ActivityResponseDto` | `publish` | **Admin** |
| PATCH | `/api/v2/activities/:id/cancel` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `ActivityResponseDto` | `cancel` | **Admin** |

**目标态**:list / detail → **拆**(`/api/app/v1/activities*` + `/api/admin/v1/activities*`);其余 → **Admin**
**风险**:**高(典型 Mixed)** — `list` / `findOne` 三种角色都能调,service 内按 `currentUser.role` 决定数据范围(USER 只看 published;ADMIN 看全部)与字段裁剪。**这是 Mixed 风险的最典型样例**,Phase 5 优先拆。

---

### 2.9 `activity-registrations.controller.ts`(10 endpoint) — `@ApiTags('activity-registrations')` — Class:**已部分拆分**

> 文件已经物理拆分为两个 `@Controller` 类:Admin block + Me block。**架构上良性**,但同一文件同一 module。

#### Admin block(`@Controller('v2/activities/:activityId/registrations')`)

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/activities/:activityId/registrations` | `@Roles(SUPER_ADMIN, ADMIN)` | `ListRegistrationsQueryDto` | `PageResultDto<ActivityRegistrationResponseDto>` | `list` |
| POST | `/api/v2/activities/:activityId/registrations` | `@Roles(SUPER_ADMIN, ADMIN)` | `CreateActivityRegistrationDto` | `ActivityRegistrationResponseDto` | `create` |
| GET | `/api/v2/activities/:activityId/registrations/export` | `@Roles(SUPER_ADMIN, ADMIN)` | — | CSV stream | `exportCsv` |
| PATCH | `/api/v2/activities/:activityId/registrations/:id/approve` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `ActivityRegistrationResponseDto` | `approve` |
| PATCH | `/api/v2/activities/:activityId/registrations/:id/reject` | `@Roles(SUPER_ADMIN, ADMIN)` | `RejectRegistrationDto` | `ActivityRegistrationResponseDto` | `reject` |
| PATCH | `/api/v2/activities/:activityId/registrations/:id/cancel` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `ActivityRegistrationResponseDto` | `cancel` |

子分类:**Admin** × 6

#### Me block(`@Controller('v2/users/me')`)

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| POST | `/api/v2/users/me/activities/:activityId/registration` | `@Roles(USER, ADMIN, SUPER_ADMIN)` | `CreateActivityRegistrationDto` | `ActivityRegistrationResponseDto` | `registerMe` |
| GET | `/api/v2/users/me/registrations` | `@Roles(USER, ADMIN, SUPER_ADMIN)` | `ListMyRegistrationsQueryDto` | `PageResultDto<ActivityRegistrationResponseDto>` | `listMyRegistrations` |
| GET | `/api/v2/users/me/registrations/:id` | `@Roles(USER, ADMIN, SUPER_ADMIN)` | `IdParamDto` | `ActivityRegistrationResponseDto` | `findMyRegistration` |
| PATCH | `/api/v2/users/me/registrations/:id/cancel` | `@Roles(USER, ADMIN, SUPER_ADMIN)` | — | `ActivityRegistrationResponseDto` | `cancelMyRegistration` |

子分类:**App** × 4

**目标态**:Admin block → `/api/admin/v1/activities/:activityId/registrations/*`;Me block → `/api/app/v1/me/registrations/*` + `/api/app/v1/me/activities/:activityId/registration`
**风险**:**中** — 已经物理拆分;但 DTO 仍共用 `ActivityRegistrationResponseDto` / `CreateActivityRegistrationDto`,Phase 2/3 需要拆 DTO 出 `App*Dto`。

---

### 2.10 `attendances.controller.ts`(11 endpoint) — `@ApiTags('attendances')` — Class:**已部分拆分**

> 文件已经物理拆分为三个 `@Controller` 类:Activity-scope sheet + Sheet detail + Me records。

#### Activity-scope sheets(`@Controller('v2/activities/:activityId/attendance-sheets')`)

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| POST | `/api/v2/activities/:activityId/attendance-sheets` | `@Roles(SUPER_ADMIN, ADMIN)` | `CreateAttendanceSheetDto` | `AttendanceSheetResponseDto` | `createSheet` |
| GET | `/api/v2/activities/:activityId/attendance-sheets` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `PageResultDto<AttendanceSheetResponseDto>` | `listSheets` |

子分类:**Admin** × 2

#### Sheet management(`@Controller('v2/attendance-sheets')`)

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/attendance-sheets/:id/review-detail` | `@Roles(SUPER_ADMIN, ADMIN)` | `IdParamDto` | `AttendanceSheetReviewDetailDto` | `getReviewDetail` |
| GET | `/api/v2/attendance-sheets/:id` | `@Roles(SUPER_ADMIN, ADMIN)` | `IdParamDto` | `AttendanceSheetResponseDto` | `findOne` |
| PATCH | `/api/v2/attendance-sheets/:id` | `@Roles(SUPER_ADMIN, ADMIN)` | `UpdateAttendanceSheetDto` | `AttendanceSheetResponseDto` | `update` |
| DELETE | `/api/v2/attendance-sheets/:id` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `AttendanceSheetResponseDto` | `delete` |
| PATCH | `/api/v2/attendance-sheets/:id/approve` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `AttendanceSheetResponseDto` | `approve` |
| PATCH | `/api/v2/attendance-sheets/:id/reject` | `@Roles(SUPER_ADMIN, ADMIN)` | `RejectAttendanceSheetDto` | `AttendanceSheetResponseDto` | `reject` |
| PATCH | `/api/v2/attendance-sheets/:id/final-approve` | `@Roles(SUPER_ADMIN, ADMIN)` | — | `AttendanceSheetResponseDto` | `finalApprove` |
| PATCH | `/api/v2/attendance-sheets/:id/final-reject` | `@Roles(SUPER_ADMIN, ADMIN)` | `RejectAttendanceSheetDto` | `AttendanceSheetResponseDto` | `finalReject` |

子分类:**Admin** × 8

#### My attendance records(`@Controller('v2/users/me/attendance-records')`)

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/users/me/attendance-records` | `@Roles(USER, ADMIN, SUPER_ADMIN)` | `ListMyAttendanceQueryDto` | `PageResultDto<AttendanceRecordResponseDto>` | `listMyRecords` |

子分类:**App** × 1

**目标态**:前两 block → `/api/admin/v1/...`;Me block → `/api/app/v1/me/attendance-records`
**风险**:**中** — DTO 共用 `AttendanceRecordResponseDto`,Phase 3 拆。

---

### 2.11 `organizations.controller.ts`(7 endpoint) — `@ApiTags('organizations')` — Class:**Admin**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/organizations` | `JwtAuthGuard` + `rbac.can(org.read)` | `ListOrganizationsQueryDto` | `PageResultDto<OrganizationResponseDto>` | `list` |
| GET | `/api/v2/organizations/tree` | `JwtAuthGuard` + `rbac.can(org.read)` | — | `OrganizationTreeNodeDto[]` | `getTree` |
| POST | `/api/v2/organizations` | `JwtAuthGuard` + `rbac.can(org.create)` | `CreateOrganizationDto` | `OrganizationResponseDto` | `create` |
| GET | `/api/v2/organizations/:id` | `JwtAuthGuard` + `rbac.can(org.read)` | `IdParamDto` | `OrganizationResponseDto` | `findOne` |
| PATCH | `/api/v2/organizations/:id` | `JwtAuthGuard` + `rbac.can(org.update)` | `UpdateOrganizationDto` | `OrganizationResponseDto` | `update` |
| PATCH | `/api/v2/organizations/:id/status` | `JwtAuthGuard` + `rbac.can(org.update)` | `UpdateOrganizationStatusDto` | `OrganizationResponseDto` | `updateStatus` |
| DELETE | `/api/v2/organizations/:id` | `JwtAuthGuard` + `rbac.can(org.delete)` | `IdParamDto` | `OrganizationResponseDto` | `softDelete` |

**目标态**:**Admin**(`/api/admin/v1/organizations/*`)
**风险**:**低** — 全部走 RBAC,边界清晰。可考虑 `/api/admin/v1/organizations/tree` 是否给 App 用(选部门时);如给 App 用,新增 `/api/app/v1/organizations/tree` 别名,**不让** App 走 admin 前缀。

---

### 2.12 `member-departments.controller.ts`(3 endpoint) — `@ApiTags('member-departments')` — Class:**Admin**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/members/:memberId/department` | `JwtAuthGuard` + `rbac.can(member-department.read)` | — | `MemberDepartmentResponseDto` | `getDepartment` |
| PUT | `/api/v2/members/:memberId/department` | `JwtAuthGuard` + `rbac.can(member-department.assign)` | `AssignMemberDepartmentDto` | `MemberDepartmentResponseDto` | `assignDepartment` |
| DELETE | `/api/v2/members/:memberId/department` | `JwtAuthGuard` + `rbac.can(member-department.remove)` | — | `MemberDepartmentResponseDto` | `removeDepartment` |

**目标态**:**Admin**(`/api/admin/v1/members/:memberId/department`)
**风险**:**低**

---

### 2.13 `attachments.controller.ts`(9 endpoint) — `@ApiTags('attachments')` — Class:**Mixed**(高)

| HTTP | Path | Guard | Req DTO | Resp | Service | 子分类 |
|---|---|---|---|---|---|---|
| POST | `/api/v2/attachments` | `JwtAuthGuard` + `rbac.can(attachment.create)` | `CreateAttachmentDto` | `AttachmentResponseDto` | `create` | **Mixed** |
| GET | `/api/v2/attachments` | `JwtAuthGuard` + `rbac.can(attachment.read.all)` | `ListAttachmentsQueryDto` | `PageResultDto<AttachmentResponseDto>` | `list` | **Admin** |
| POST | `/api/v2/attachments/upload-url` | `JwtAuthGuard` + `rbac.can(attachment.create)` | `GetUploadUrlDto` | `GetUploadUrlResponseDto` | `getUploadUrl` | **Mixed** |
| POST | `/api/v2/attachments/confirm-upload` | `JwtAuthGuard` + `rbac.can(attachment.create)` | `ConfirmUploadDto` | `AttachmentResponseDto` | `confirmUpload` | **Mixed** |
| GET | `/api/v2/attachments/by-owner` | `JwtAuthGuard` + `rbac.can(attachment.read.by-owner)` | `ListByOwnerQueryDto` | `PageResultDto<AttachmentResponseDto>` | `listByOwner` | **Admin** |
| GET | `/api/v2/attachments/me/uploaded` | `JwtAuthGuard`(任意登录) | — | `PageResultDto<AttachmentResponseDto>` | `listMyUploaded` | **App** |
| GET | `/api/v2/attachments/:id` | `JwtAuthGuard` + `rbac.can(attachment.read.one)` | `IdParamDto` | `AttachmentResponseDto` | `findOne` | **Mixed** |
| PATCH | `/api/v2/attachments/:id` | `JwtAuthGuard` + `rbac.can(attachment.update)` | `UpdateAttachmentDto` | `AttachmentResponseDto` | `update` | **Admin** |
| DELETE | `/api/v2/attachments/:id` | `JwtAuthGuard` + `rbac.can(attachment.delete)` | `IdParamDto` | `AttachmentResponseDto` | `delete` | **Admin** |

**目标态**:`/me/uploaded` → **App**(`/api/app/v1/me/attachments`);其余按主调用方拆,**上传链路**(`upload-url` + `confirm-upload` + `create`)**双端可用**,Phase 3 单独评审是 `/api/app/v1/me/attachments/upload-url` 还是 `/api/admin/v1/attachments/upload-url` 各起一份。
**风险**:**高** — 附件上传链路是 App 与 Admin 都要用的能力;Phase 3 拆分时务必两端都覆盖 + 共用 service。

---

### 2.14 `dictionaries.controller.ts`(11 endpoint) — `@ApiTags('dictionaries')` — Class:**System**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/dict-types` | `JwtAuthGuard` + `rbac.can(dict.read)` | `ListDictTypesQueryDto` | `PageResultDto<DictTypeResponseDto>` | `listTypes` |
| POST | `/api/v2/dict-types` | `JwtAuthGuard` + `rbac.can(dict.create)` | `CreateDictTypeDto` | `DictTypeResponseDto` | `createType` |
| GET | `/api/v2/dict-types/:id` | `JwtAuthGuard` + `rbac.can(dict.read)` | `IdParamDto` | `DictTypeResponseDto` | `findOneType` |
| PATCH | `/api/v2/dict-types/:id` | `JwtAuthGuard` + `rbac.can(dict.update)` | `UpdateDictTypeDto` | `DictTypeResponseDto` | `updateType` |
| DELETE | `/api/v2/dict-types/:id` | `JwtAuthGuard` + `rbac.can(dict.delete)` | `IdParamDto` | `DictTypeResponseDto` | `deleteType` |
| GET | `/api/v2/dict-items` | `JwtAuthGuard` + `rbac.can(dict.read)` | `ListDictItemsQueryDto` | `PageResultDto<DictItemResponseDto>` | `listItems` |
| POST | `/api/v2/dict-items` | `JwtAuthGuard` + `rbac.can(dict.create)` | `CreateDictItemDto` | `DictItemResponseDto` | `createItem` |
| GET | `/api/v2/dict-items/tree` | `JwtAuthGuard` + `rbac.can(dict.read)` | `DictTreeQueryDto` | `DictTypeTreeResponseDto[]` | `getTree` |
| GET | `/api/v2/dict-items/:id` | `JwtAuthGuard` + `rbac.can(dict.read)` | `IdParamDto` | `DictItemResponseDto` | `findOneItem` |
| PATCH | `/api/v2/dict-items/:id` | `JwtAuthGuard` + `rbac.can(dict.update)` | `UpdateDictItemDto` | `DictItemResponseDto` | `updateItem` |
| DELETE | `/api/v2/dict-items/:id` | `JwtAuthGuard` + `rbac.can(dict.delete)` | `IdParamDto` | `DictItemResponseDto` | `deleteItem` |

**目标态**:**System**(`/api/system/v1/dict-types/*` + `/api/system/v1/dict-items/*`)
**风险**:**低 / 但需评估** — App 客户端有可能需要"读字典 items"(如下拉选项),应在 Phase 4 评审时确认是给 App 暴露**只读**视图(`GET /api/app/v1/dict-items` / `tree`)还是依赖 PC 后台预拉 + 缓存到客户端。

---

### 2.15 `permissions.controller.ts`(4 endpoint) — `@ApiTags('permissions')` — Class:**System**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/permissions` | `JwtAuthGuard` + `rbac.can(rbac.permission.read)` | `ListPermissionsQueryDto` | `PageResultDto<PermissionResponseDto>` | `list` |
| POST | `/api/v2/permissions` | `JwtAuthGuard` + `rbac.can(rbac.permission.create)` | `CreatePermissionDto` | `PermissionResponseDto` | `create` |
| PATCH | `/api/v2/permissions/:id` | `JwtAuthGuard` + `rbac.can(rbac.permission.update)` | `UpdatePermissionDto` | `PermissionResponseDto` | `update` |
| DELETE | `/api/v2/permissions/:id` | `JwtAuthGuard` + `rbac.can(rbac.permission.delete)` | `IdParamDto` | `PermissionResponseDto` | `delete` |

**目标态**:**System**(`/api/system/v1/permissions/*`)
**风险**:**低**

---

### 2.16 `rbac-roles.controller.ts`(5 endpoint) — `@ApiTags('rbac-roles')` — Class:**System**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/roles` | `JwtAuthGuard` + `rbac.can(rbac.role.read)` | `ListRolesQueryDto` | `PageResultDto<RbacRoleResponseDto>` | `list` |
| GET | `/api/v2/roles/:id` | `JwtAuthGuard` + `rbac.can(rbac.role.read)` | `IdParamDto` | `RbacRoleDetailResponseDto` | `findOne` |
| POST | `/api/v2/roles` | `JwtAuthGuard` + `rbac.can(rbac.role.create)` | `CreateRbacRoleDto` | `RbacRoleResponseDto` | `create` |
| PATCH | `/api/v2/roles/:id` | `JwtAuthGuard` + `rbac.can(rbac.role.update)` | `UpdateRbacRoleDto` | `RbacRoleResponseDto` | `update` |
| DELETE | `/api/v2/roles/:id` | `JwtAuthGuard` + `rbac.can(rbac.role.delete)` | `IdParamDto` | `RbacRoleResponseDto` | `softDelete` |

**目标态**:**System**(`/api/system/v1/roles/*`)
**风险**:**低**

---

### 2.17 `role-permissions.controller.ts`(2 endpoint) — `@ApiTags('role-permissions')` — Class:**System**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| POST | `/api/v2/roles/:id/permissions` | `JwtAuthGuard` + `rbac.can(rbac.role-permission.create)` | `AssignRolePermissionsDto` | `RbacRoleDetailResponseDto` | `assign` |
| DELETE | `/api/v2/roles/:id/permissions/:permissionId` | `JwtAuthGuard` + `rbac.can(rbac.role-permission.delete)` | `RevokeRolePermissionParamDto` | `RbacRoleDetailResponseDto` | `revoke` |

**目标态**:**System**(`/api/system/v1/roles/:id/permissions/*`)
**风险**:**低**

---

### 2.18 `user-roles.controller.ts`(3 endpoint) — `@ApiTags('user-roles')` — Class:**System**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/users/:userId/roles` | `JwtAuthGuard` + `rbac.can(rbac.user-role.read)` | `UserIdParamDto` | `UserRoleResponseDto[]` | `list` |
| POST | `/api/v2/users/:userId/roles` | `JwtAuthGuard` + `rbac.can(rbac.user-role.create)` + Q7 二次判定 | `AssignUserRoleDto` | `UserRoleResponseDto` | `assign` |
| DELETE | `/api/v2/users/:userId/roles/:roleId` | `JwtAuthGuard` + `rbac.can(rbac.user-role.delete)` + Q7 二次判定 + "最后一个 ops-admin 保护" | `RevokeUserRoleParamDto` | `UserRoleResponseDto` | `revoke` |

**目标态**:**System**(`/api/system/v1/users/:userId/roles/*`)
**风险**:**低**

---

### 2.19 `rbac.controller.ts`(2 endpoint) — `@ApiTags('rbac')` — Class:**Mixed**(轻)

| HTTP | Path | Guard | Req DTO | Resp | Service | 子分类 |
|---|---|---|---|---|---|---|
| GET | `/api/v2/rbac/me/permissions` | `JwtAuthGuard`(任意登录) | — | `MyPermissionsResponseDto` | `getMyPermissions` | **App** |
| POST | `/api/v2/rbac/reload` | `JwtAuthGuard` + `rbac.can(rbac.reload)` | `ReloadRbacDto` | `ReloadRbacResponseDto` | `reload` | **System** |

**目标态**:`/me/permissions` → **App**(`/api/app/v1/me/permissions`);`reload` → **System**(`/api/system/v1/rbac/reload`)
**风险**:**中** — 同一 Controller 跨 App + System,**且 service 是同一个 RbacService**;Phase 4 拆 Controller,service 保留。

---

### 2.20 `audit-logs.controller.ts`(2 endpoint) — `@ApiTags('audit-logs')` — Class:**System**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/audit-logs` | `JwtAuthGuard` + `rbac.can(audit-log.read)` | `ListAuditLogsQueryDto` | `PageResultDto<AuditLogResponseDto>` | `list` |
| GET | `/api/v2/audit-logs/:id` | `JwtAuthGuard` + `rbac.can(audit-log.read)` | `IdParamDto` | `AuditLogResponseDto` | `findOne` |

**目标态**:**System**(`/api/system/v1/audit-logs/*`)
**风险**:**低**

---

### 2.21 `storage-settings.controller.ts`(3 endpoint) — `@ApiTags('storage-settings')` — Class:**System(极高危)**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/storage-settings` | `JwtAuthGuard` + `rbac.can(storage.read)` | — | `StorageSettingsResponseDto` | `getSettings` |
| PATCH | `/api/v2/storage-settings` | `JwtAuthGuard` + `rbac.can(storage.update)` | `UpdateStorageSettingsDto` | `StorageSettingsResponseDto` | `updateSettings` |
| POST | `/api/v2/storage-settings/reset-credentials` | `JwtAuthGuard` + `rbac.can(storage.reset)` | — | `StorageSettingsResponseDto` | `resetCredentials` |

**目标态**:**System(极高危)**(`/api/system/v1/storage-settings/*`)
**风险**:**低 / 但语义极高危** — 已用 AES-256-GCM 加密凭据;响应**不**返回明文 SecretKey。Phase 4 务必保留这层防御。
**结构特殊**:位于 `src/common/storage/`,不是 `src/modules/`。Phase 3+ 目录搬迁时考虑是否迁到 `src/system/storage/`。

---

### 2.22 `attachment-mime-configs.controller.ts`(6 endpoint) — `@ApiTags('attachment-configs')` — Class:**System**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/attachment-mime-configs` | `JwtAuthGuard` + `rbac.can(attachment-config.read)` | `ListMimeConfigsQueryDto` | `PageResultDto<...>` | `list` |
| POST | `/api/v2/attachment-mime-configs` | `JwtAuthGuard` + `rbac.can(attachment-config.create)` | `CreateAttachmentMimeConfigDto` | `AttachmentMimeConfigResponseDto` | `create` |
| GET | `/api/v2/attachment-mime-configs/:id` | `JwtAuthGuard` + `rbac.can(attachment-config.read)` | `IdParamDto` | `AttachmentMimeConfigResponseDto` | `findOne` |
| PATCH | `/api/v2/attachment-mime-configs/:id` | `JwtAuthGuard` + `rbac.can(attachment-config.update)` | `UpdateAttachmentMimeConfigDto` | `AttachmentMimeConfigResponseDto` | `update` |
| PATCH | `/api/v2/attachment-mime-configs/:id/status` | `JwtAuthGuard` + `rbac.can(attachment-config.update)` | `UpdateAttachmentMimeConfigStatusDto` | `AttachmentMimeConfigResponseDto` | `updateStatus` |
| DELETE | `/api/v2/attachment-mime-configs/:id` | `JwtAuthGuard` + `rbac.can(attachment-config.delete)` | `IdParamDto` | `AttachmentMimeConfigResponseDto` | `delete` |

### 2.23 `attachment-size-limit-configs.controller.ts`(5 endpoint) — `@ApiTags('attachment-configs')` — Class:**System**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/attachment-size-limit-configs` | `JwtAuthGuard` + `rbac.can(attachment-config.read)` | `ListSizeLimitConfigsQueryDto` | `PageResultDto<...>` | `list` |
| POST | `/api/v2/attachment-size-limit-configs` | `JwtAuthGuard` + `rbac.can(attachment-config.create)` | `CreateAttachmentSizeLimitConfigDto` | `AttachmentSizeLimitConfigResponseDto` | `create` |
| GET | `/api/v2/attachment-size-limit-configs/:id` | `JwtAuthGuard` + `rbac.can(attachment-config.read)` | `IdParamDto` | `AttachmentSizeLimitConfigResponseDto` | `findOne` |
| PATCH | `/api/v2/attachment-size-limit-configs/:id` | `JwtAuthGuard` + `rbac.can(attachment-config.update)` | `UpdateAttachmentSizeLimitConfigDto` | `AttachmentSizeLimitConfigResponseDto` | `update` |
| DELETE | `/api/v2/attachment-size-limit-configs/:id` | `JwtAuthGuard` + `rbac.can(attachment-config.delete)` | `IdParamDto` | `AttachmentSizeLimitConfigResponseDto` | `delete` |

### 2.24 `attachment-type-configs.controller.ts`(6 endpoint) — `@ApiTags('attachment-configs')` — Class:**System**

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/attachment-type-configs` | `JwtAuthGuard` + `rbac.can(attachment-config.read)` | `ListTypeConfigsQueryDto` | `PageResultDto<...>` | `list` |
| POST | `/api/v2/attachment-type-configs` | `JwtAuthGuard` + `rbac.can(attachment-config.create)` | `CreateAttachmentTypeConfigDto` | `AttachmentTypeConfigResponseDto` | `create` |
| GET | `/api/v2/attachment-type-configs/:id` | `JwtAuthGuard` + `rbac.can(attachment-config.read)` | `IdParamDto` | `AttachmentTypeConfigResponseDto` | `findOne` |
| PATCH | `/api/v2/attachment-type-configs/:id` | `JwtAuthGuard` + `rbac.can(attachment-config.update)` | `UpdateAttachmentTypeConfigDto` | `AttachmentTypeConfigResponseDto` | `update` |
| PATCH | `/api/v2/attachment-type-configs/:id/status` | `JwtAuthGuard` + `rbac.can(attachment-config.update)` | `UpdateAttachmentTypeConfigStatusDto` | `AttachmentTypeConfigResponseDto` | `updateStatus` |
| DELETE | `/api/v2/attachment-type-configs/:id` | `JwtAuthGuard` + `rbac.can(attachment-config.delete)` | `IdParamDto` | `AttachmentTypeConfigResponseDto` | `delete` |

**目标态(2.22 / 2.23 / 2.24)**:**System**(`/api/system/v1/attachment-*-configs/*`)
**风险**:**低**

---

### 2.25 `contribution-rules.controller.ts`(5 endpoint) — `@ApiTags('contribution-rules')` — Class:**System**(已拍板)

| HTTP | Path | Guard | Req DTO | Resp | Service |
|---|---|---|---|---|---|
| GET | `/api/v2/contribution-rules` | `JwtAuthGuard` + `rbac.can(contribution-rule.read)` | `ListContributionRulesQueryDto` | `PageResultDto<ContributionRuleResponseDto>` | `list` |
| POST | `/api/v2/contribution-rules` | `JwtAuthGuard` + `rbac.can(contribution-rule.create)` | `CreateContributionRuleDto` | `ContributionRuleResponseDto` | `create` |
| GET | `/api/v2/contribution-rules/:id` | `JwtAuthGuard` + `rbac.can(contribution-rule.read)` | `IdParamDto` | `ContributionRuleResponseDto` | `findOne` |
| PATCH | `/api/v2/contribution-rules/:id` | `JwtAuthGuard` + `rbac.can(contribution-rule.update)` | `UpdateContributionRuleDto` | `ContributionRuleResponseDto` | `update` |
| DELETE | `/api/v2/contribution-rules/:id` | `JwtAuthGuard` + `rbac.can(contribution-rule.delete)` | `IdParamDto` | `ContributionRuleResponseDto` | `delete` |

**目标态**:**System**(`/api/system/v1/contribution-rules/*`)— 2026-05-19 由用户拍板。

**归属理由**(锁定写入):

- `contribution_rules` 是**贡献值计算 / 预填规则**(D14 范围;无 CRUD 流水表)
- 它影响**未来活动、考勤、贡献值换算**全链路 — 改一条规则,后续所有报名 / 出勤的换算口径都受影响
- **本质是平台级规则配置**,**不是**单次活动业务数据;与 `dictionaries` / `permissions` / `attachment-configs` 同档
- UI 上可以放在"运营 / 活动配置"菜单下,但 **API 边界归 System**,前端 SDK 走 system 通道
- 普通 ADMIN 如需使用,应通过**明确权限点授权**(`contribution-rule.read/create/update/delete` 已存在),**不**归入普通 Admin API
- 与 [`docs/api-client-boundary.md §2.2 System API 铁律 + §3 铁律 5`](api-client-boundary.md) 对齐:System API 默认高危,影响面是"全平台"

---

## 3. Mixed API 风险清单(按风险等级)

| 排序 | 模块 | Controller | 风险描述 | 优先级 |
|---|---|---|---|---|
| 1 | **users** | `users.controller.ts` | 单 Controller 类 + 单 DTO 同时服务 App `/me` 与 Admin `/:id` 管理 | **P0** |
| 2 | **activities** | `activities.controller.ts` | `list` / `findOne` 三角色共用,service 内按角色裁字段;DTO 单一 | **P0** |
| 3 | **attachments** | `attachments.controller.ts` | 上传链路 + `me/uploaded` + admin 列表 / 操作全部同 Controller 同 DTO | **P0** |
| 4 | **activity-registrations** | `activity-registrations.controller.ts` | 文件内已物理拆 2 Controller;**但** `ActivityRegistrationResponseDto` / `CreateActivityRegistrationDto` 共用 | **P1** |
| 5 | **attendances** | `attendances.controller.ts` | 文件内已物理拆 3 Controller;**但** `AttendanceRecordResponseDto` 共用 | **P1** |
| 6 | **rbac** | `rbac.controller.ts` | 同 Controller 同 service 跨 App `/me/permissions` 与 System `/reload` | **P2** |
| 7 | ~~**contribution-rules**~~ | ~~`contribution-rules.controller.ts`~~ | ~~归属 System / Admin 二选一未拍板~~ | ✅ **已拍板 System**(2026-05-19;见 §2.25) |
| 8 | **dictionaries** | `dictionaries.controller.ts` | App 是否需要 `dict-items/tree` 只读视图未决议 | **P3**(增量决策) |

---

## 4. App 端缺失接口清单

以下接口在 App 客户端上线时**必须**补齐,Phase 0 不实现:

| 优先级 | 接口 | 来源 / 拆出自 |
|---|---|---|
| **P0** | `GET /api/app/v1/me` | 沿现状 `/api/users/me` |
| **P0** | `PATCH /api/app/v1/me/profile` | 沿现状 `PATCH /api/users/me` |
| **P0** | `PUT /api/app/v1/me/password` | 沿 P0-D `PUT /api/users/me/password` |
| **P0** | `GET /api/app/v1/me/permissions` | 沿现状 `GET /api/v2/rbac/me/permissions` |
| **P0** | `GET /api/app/v1/activities` | 从 `/api/v2/activities`(USER 视角)拆 |
| **P0** | `GET /api/app/v1/activities/:id` | 从 `/api/v2/activities/:id`(USER 视角)拆 |
| **P0** | `POST /api/app/v1/me/activities/:id/registrations` | 沿现状 `POST /api/v2/users/me/activities/:activityId/registration` |
| **P0** | `GET /api/app/v1/me/registrations` | 沿现状 `GET /api/v2/users/me/registrations` |
| **P0** | `GET /api/app/v1/me/registrations/:id` | 沿现状 |
| **P0** | `PATCH /api/app/v1/me/registrations/:id/cancel` | 沿现状 |
| **P0** | `GET /api/app/v1/me/attendance-records` | 沿现状 `GET /api/v2/users/me/attendance-records` |
| **P1** | `GET /api/app/v1/me/member` | 新增(App 视角的 member 摘要,不复用 Admin DTO) |
| **P1** | `GET /api/app/v1/me/certificates` | 新增(过滤未公示状态) |
| **P1** | `GET /api/app/v1/me/department` | 新增 |
| **P1** | `GET /api/app/v1/me/emergency-contacts` | 新增 |
| **P1** | `PATCH /api/app/v1/me/emergency-contacts` | 新增(本人改自己紧急联系人) |
| **P2** | `GET /api/app/v1/me/attachments` | 沿现状 `GET /api/v2/attachments/me/uploaded` |
| **P2** | `POST /api/app/v1/me/attachments/upload-url` | 拆现状(双端通用接口要分别提供) |
| **P2** | `GET /api/app/v1/me/contribution-points` | 新增(汇总贡献值) |
| **P2** | `GET /api/app/v1/me/notifications` | 新增(消息) |

---

## 5. 当前 API 已经"接近 App / Me" 的接口

**好消息**:以下 10 个接口已经天然属于 App 客户端,Phase 2 只需要"改前缀 + 拆 DTO":

| 路径 | 文件 | 说明 |
|---|---|---|
| `GET /api/users/me` | `users.controller.ts` | 本人 user |
| `PATCH /api/users/me` | `users.controller.ts` | 本人改资料 |
| `PUT /api/users/me/password` | `users.controller.ts` | 本人改密(P0-D) |
| `POST /api/v2/users/me/activities/:activityId/registration` | `activity-registrations.controller.ts` | 本人报名 |
| `GET /api/v2/users/me/registrations` | `activity-registrations.controller.ts` | 本人报名列表 |
| `GET /api/v2/users/me/registrations/:id` | `activity-registrations.controller.ts` | 本人报名详情 |
| `PATCH /api/v2/users/me/registrations/:id/cancel` | `activity-registrations.controller.ts` | 本人取消报名 |
| `GET /api/v2/users/me/attendance-records` | `attendances.controller.ts` | 本人考勤 |
| `GET /api/v2/rbac/me/permissions` | `rbac.controller.ts` | 本人权限点 |
| `GET /api/v2/attachments/me/uploaded` | `attachments.controller.ts` | 本人上传的附件 |

> 共 10 个。本表是 App `/me` 端点的权威清单;§1.1 总览统计与本表一致。

---

## 6. 当前 API 已经"天然属于 Admin" 的接口

以下接口稳定属于 Admin 客户端,Phase 3 改前缀即可:

- `members.controller.ts` × 6
- `member-profiles.controller.ts` × 3
- `member-departments.controller.ts` × 3
- `emergency-contacts.controller.ts` × 4
- `certificates.controller.ts` × 8
- `organizations.controller.ts` × 7
- `users.controller.ts` 中的 8 个非 `/me` 端点
- `activity-registrations.controller.ts` Admin block × 6
- `attendances.controller.ts` Activity + Sheet block × 10
- `activities.controller.ts` 中的 5 个非 list/findOne 端点

合计:**约 60 个**纯 Admin 接口。

---

## 7. 当前 API 已经"天然属于 System" 的接口

以下接口稳定属于 System 客户端,Phase 4 改前缀即可:

- `dictionaries.controller.ts` × 11
- `permissions.controller.ts` × 4
- `rbac-roles.controller.ts` × 5
- `role-permissions.controller.ts` × 2
- `user-roles.controller.ts` × 3
- `rbac.controller.ts` 中的 `/reload` × 1
- `audit-logs.controller.ts` × 2
- `storage-settings.controller.ts` × 3
- `attachment-mime-configs.controller.ts` × 6
- `attachment-size-limit-configs.controller.ts` × 5
- `attachment-type-configs.controller.ts` × 6
- `contribution-rules.controller.ts` × 5(已拍板 System;见 §2.25)

合计:**53 个**(System 已锁定包含 contribution-rules)。

---

## 8. 推荐优先拆分模块(优先级)

| 优先级 | 模块 | 拆分动作 | 拆分理由 |
|---|---|---|---|
| P0 | **users** | 拆 `users.controller.ts` 为 `me` + `admin-users` 两 Controller;`UserResponseDto` 拆 `AppMyUserResponseDto` + `AdminUserResponseDto` | 单文件混 App + Admin 是最大违规;P0-D 已经依赖 `/me/password` 独立路径 |
| P0 | **activities** | 拆 `list` / `findOne` 双 Controller;`ActivityResponseDto` 拆 `AppActivity*Dto` + `AdminActivity*Dto` | 三角色 + 字段裁剪是典型 Mixed |
| P0 | **attachments** | 拆 `/me/uploaded` 与 upload 链路,DTO 拆 App + Admin | App 端必用 |
| P1 | **activity-registrations** | DTO 拆 App + Admin(controllers 已分);me 路径迁 `/api/app/v1/me/registrations` | 文件已分但 DTO 共用 |
| P1 | **attendances** | DTO 拆 App + Admin;me 路径迁 `/api/app/v1/me/attendance-records` | 文件已分但 DTO 共用 |
| P2 | **certificates** | App 视角 `GET /me/certificates` 新增 | App 必用 |
| P2 | **member-profiles** + **emergency-contacts** | App 视角 `GET / PATCH /me/profile` + `/me/emergency-contacts` 新增 | 敏感字段隔离 |
| P3 | **dictionaries** | 评估 App 是否需要只读视图 | 增量决策 |

---

## 9. 暂时不应该动的接口

以下接口建议**保持原状**直到 Phase 4+,**避免**在 Phase 1/2 改造范围内:

- **`/api/health/*`** 3 个 — v1 兼容性铁律(baseline §11)**禁止改路径**;Phase 1 仅新增 `/api/public/v1/health*` 别名
- **`/api/auth/*`** 4 个 — P0-E v0.14.0 刚冻结契约,**禁止**在 Phase 0/1 改 path;Phase 1 末期评估迁 `/api/auth/v1/*` 别名
- **System 类的 `contribution-rules`** — 归属已锁 System(2026-05-19);**保持** `/api/v2/contribution-rules` 路径不动,沿 Phase 3 方案 C(Admin Legacy 长期保留)
- **System 类的所有 RBAC 配置接口**(`permissions` / `rbac-roles` / `role-permissions` / `user-roles` / `audit-logs` / `storage-settings` / `attachment-configs`)— 它们已经语义清晰(System),前缀改不改对前端联调影响小,**Phase 4** 统一动
- **member-profiles / emergency-contacts** 中的 Admin 接口 — 敏感字段在 service 内已有保护;Phase 3 前**不**改路径,**不**改 DTO

---

## 10. 暂未确定 Class 的接口(Unknown)

**无**。本盘点 25 个 Controller 全部完成分类;`contribution-rules` 2026-05-19 拍板 **System**(沿 §2.25)。

---

## 11. 下一步动作

Phase 0 完成后,**不**自动启动任何代码改造。已锁定决策:

- ✅ `contribution-rules` 归 **System**(2026-05-19;沿 §2.25)
- ✅ Phase 3 路径策略 = **方案 C**(`/api/v2/*` 长期保留为 Admin Legacy;新接口走 `/api/{app,admin,system}/v1/*`;沿 [`docs/api-client-boundary-migration-plan.md §5`](api-client-boundary-migration-plan.md))

下一步用户拍板:

1. 是否接受 [§3 Mixed 风险清单](#3-mixed-api-风险清单按风险等级) 的优先级排序
2. 是否进入 Phase 1(Swagger Tag 整理 / Public + Auth path alias — 详见 [`docs/api-client-boundary-phase-1-review.md`](api-client-boundary-phase-1-review.md))
3. 是否需要先扩充 [`docs/api-client-boundary.md`](api-client-boundary.md) 的某节(如对"App 视角字段铁律"做字段级清单)

详细推进路线见 [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md);Phase 1 执行评审稿见 [`docs/api-client-boundary-phase-1-review.md`](api-client-boundary-phase-1-review.md)。

---

> **本盘点生效时间**:2026-05-19(Phase 0)。
> **更新规则**:每次新增 / 修改 Controller / endpoint / @Roles / DTO 时,**必须**回填本表;若超过一个 release 未回填,视作过期,以 §0 复核命令重新生成为准。
