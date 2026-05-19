# SRVF Data Access & Lifecycle Boundary Review

> **状态**:**Phase 0.6 专项评审 v0**(2026-05-19)
> **定位**:[Phase 0 客户端边界](api-client-boundary.md) + [Phase 0.5 App 身份 / 权限](app-permission-boundary-review.md) 之后,**Phase 1A / 1B / Phase 2 之前**的"数据治理"专项 — 锁定 endpoint surface 分类、字段敏感等级、数据范围(scope)、状态机、User / Member 生命周期。
> **配套实施边界**:[`docs/code-architecture-boundary-review.md`](code-architecture-boundary-review.md) — **Phase 0.7 代码架构边界专项评审**;承载本评审稿规则的代码分层方案(Controller / DTO / Presenter / QueryService / CommandService / PolicyService / StateMachine / AuditRecorder / Effect / Reporting),**Phase 2 实施前必读**。两份文档关系:**本评审稿定义"是什么 / 谁能看到什么",Phase 0.7 定义"代码如何承载这些规则"**。
> **配套设计文档**:
>   - [`docs/api-client-boundary.md`](api-client-boundary.md)
>   - [`docs/api-client-boundary-inventory.md`](api-client-boundary-inventory.md)
>   - [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md)
>   - [`docs/api-client-boundary-phase-1-review.md`](api-client-boundary-phase-1-review.md)
>   - [`docs/app-permission-boundary-review.md`](app-permission-boundary-review.md)
> **冲突优先级**:本评审稿优先级**最低**;冲突时让步给 [`ARCHITECTURE.md`](../ARCHITECTURE.md) / [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) / [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) / [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) / 既有批次评审稿,以及 [Phase 0.5 §10.2 D-1 ~ D-4 已锁决策](app-permission-boundary-review.md)。
> **生效条件**:本评审稿经用户拍板后,Phase 2 立项必须**先**对齐本评审稿 + Phase 0.5 §10.2。
> **本评审稿不实施任何东西**:不改 schema / Role / MemberStatus / Permission seed / 任何 endpoint / 任何 DTO / 任何 controller / 任何测试。

---

## 0. TL;DR

1. **Surface 分类**:沿 [Phase 0 盘点表](api-client-boundary-inventory.md);约 140 endpoint → `public` 3 / `mobile` 10 / `admin` ~73 / `ops` ~47 / `mixed` ~4 / `unknown` 0;**`ops` = System API**;**`/api/v2/*` 默认 Admin Legacy**,但其中字典 / RBAC / 审计 / 存储 / 附件配置 / 贡献规则全部属于 `ops`(沿 Phase 3 方案 C + Phase 0.5 §10.2 D-1 ~ D-4)
2. **字段敏感等级**:`L0 Public` / `L1 PII` / `L2 Highly Sensitive` / `L3 Credential` — 4 档;App / Admin / System 各自有"默认可见上限",**违规 = 安全事故**
3. **数据范围 scope**:`self` / `department` / `activity` / `managed` / `all` / `custom` — 6 档;**RBAC 决定动作能力,scope 决定数据集,field classification 决定字段集,state machine 决定流转合法性**,四个维度正交
4. **状态机**:6 个核心状态机文档化(`UserStatus` / `MemberStatus` / `ActivityStatus` / `RegistrationStatus` / `AttendanceSheetStatus` / `CertificateStatus`)+ Storage credential 凭据状态;**当前代码状态机校验是部分实施**(`schema 不固化,由 service 层映射`),本文档是 design baseline 不是 implementation proof
5. **User / Member 生命周期**:`User`(登录账号)与 `Member`(队员档案)是两条**独立**生命周期;`User.memberId` 是唯一关联点;离队 / 退队 / 归队、临时编号转正、Admin 不绑 member 等场景对 `CanLogin` / `CanUseApp` 的影响在 §5 矩阵中明确

---

## 1. API Surface Matrix

### 1.1 Surface 分类定义

| Surface | 等价 / 来源 | 客户端 | 鉴权预期 | 数据范围 |
|---|---|---|---|---|
| `public` | Public API(沿 [boundary §2.2](api-client-boundary.md)) | 浏览器 / App / 小程序 / 巡检 / K8s | `@Public()` | 无 |
| `mobile` | App API(沿 [boundary §2.2](api-client-boundary.md) + Phase 0.5 §10.2 D-4 `/me/*` + `/my/*`) | App / 小程序 / 队员 H5 | 登录后 + `MemberStatus.ACTIVE` + capability | `self`(沿 Phase 0.5 §10.2 D-1) |
| `admin` | Admin API + Admin Legacy(`/api/v2/*` 中的业务管理类) | PC 管理后台 | 登录 + `rbac.can(...)` / `@Roles(SUPER_ADMIN, ADMIN)` | `all` 或权限点限定 |
| `ops` | System API(= 系统治理;沿 [boundary §2.2 System](api-client-boundary.md);**本评审稿明确 `ops` 与 `system` 同义**) | PC 管理后台的"超级管理员页"或独立运维控制台 | 登录 + 高危权限点(默认仅 `SUPER_ADMIN` 或 `ops-admin`) | `all` + 全局配置 |
| `internal` | 仅服务间或定时任务内部触发 / 不对外暴露(当前 SRVF **无**此类 endpoint) | 无 | 无 | 无 |
| `mixed` | 同 endpoint 给 USER + ADMIN 共用,service 内按角色裁字段 / 限范围 | 多客户端共用 | 按调用上下文 | 按角色 |
| `unknown` | 分类不清(本盘点 **0** 个) | — | — | — |

**铁律**:
- `public` 全部 `@Public()`;**禁止**靠角色二次限制
- `mobile` 不允许返回 `L2` / `L3`(沿 §2),不允许 `scope > self`(沿 §3)
- `admin` 默认 `scope = all`,字段可见 `L2` / 部分 `L3`(脱敏后)
- `ops` 默认仅 `SUPER_ADMIN`,**禁止** raw `L3` secret 返回
- `mixed` **是过渡态**,Phase 5 前拆完;**Phase 2 禁止**新增 endpoint 进入 `mixed` 状态
- `internal` 当前为空;若未来引入定时任务 / 服务间调用,**必须**新分类不混入其它

### 1.2 Surface 分类盘点(140 endpoint 摘要 — 详见 [inventory §2](api-client-boundary-inventory.md))

> **不重新发明分类**,本节 surface 直接映射 inventory §2 各模块的 `Class` 字段。

| Surface | endpoint 数 | 主要 controller / 路径段 |
|---|---|---|
| `public` | 3 | `health.controller.ts`(`/api/health*`)|
| `mobile` | 10 | 散落:`users.controller.ts` 3 + `activity-registrations.controller.ts` 4 + `attendances.controller.ts` 1 + `rbac.controller.ts` 1 + `attachments.controller.ts` 1 |
| `admin` | ~60 | `members` / `member-profiles` / `member-departments` / `emergency-contacts` / `certificates` / `organizations` / `users`(管理段 × 8)/ `activity-registrations`(admin block × 6)/ `attendances`(admin block × 10)/ `activities`(非 Mixed 段 × 5) |
| `ops` | ~53 | `dictionaries` / `permissions` / `rbac-roles` / `role-permissions` / `user-roles` / `audit-logs` / `storage-settings` / `attachment-mime-configs` / `attachment-size-limit-configs` / `attachment-type-configs` / `contribution-rules`(沿 [§19.7 D-1](../CLAUDE.md))/ `rbac/reload` |
| `mixed` | 4 | `activities` `list` + `findOne`(`@Roles(SUPER_ADMIN, ADMIN, USER)` 三角色共用,service 按 role 裁字段);**Phase 2 启动前不拆,Phase 5 优先拆** |
| `internal` | 0 | — |
| `unknown` | 0 | — |
| `auth` | 4 | `auth.controller.ts`(沿 boundary §2.2 Auth 独立段;本评审稿 surface 表把 auth 视为 `public`-but-throttled 子类,不单列) |

> **完整逐 endpoint 表**:沿 [`docs/api-client-boundary-inventory.md §2`](api-client-boundary-inventory.md);本节**不**复制,避免双权威源漂移。
> **复核命令**:沿 inventory §0。

### 1.3 Mixed 接口风险清单(强约束)

> 详见 [inventory §3 Mixed 风险清单](api-client-boundary-inventory.md);本节锁 Phase 2 硬约束:

| 模块 | Mixed 表现 | **Phase 2 硬约束** |
|---|---|---|
| `users` | 单 Controller + 单 `UserResponseDto` 同时服务 App `/me` 与 Admin `/:id` | **Phase 2 禁止**在 App 实施时复用 `UserResponseDto`;必须新建 `AppSelfUserDto`(沿 Phase 0.5 §6) |
| `activities` `list` / `findOne` | `@Roles(SUPER_ADMIN, ADMIN, USER)` 三角共用,service 按角色裁字段 | **Phase 2 禁止**新 App 接口复用 `ActivityResponseDto`;必须新建 `AppActivityListDto` / `AppActivityDetailDto`(脱敏) |
| `attachments` | 上传链路 + `me/uploaded` + admin 列表 / 操作全部同 Controller 同 DTO | **Phase 2 禁止**复用 `AttachmentResponseDto`;App `/my/attachments` 必须新建 `AppMyAttachmentDto` |
| `activity-registrations` / `attendances` | 文件已物理拆 controller,但 DTO 共用 | **Phase 2 实施 App 端必须**为这两类新建 `AppMyRegistrationDto` / `AppMyAttendanceRecordDto`,**禁止**复用 admin DTO |

**Phase 2 铁律(沿 Phase 0.5 §6 + 本节)**:**App API 在任何情况下都不得复用 Mixed DTO 或 Admin DTO**。违反 = §6 数据可见性返工风险。

### 1.4 `/api/v2/*` 与 surface 的关系

沿 [Phase 3 方案 C 锁定](api-client-boundary-migration-plan.md):

- `/api/v2/*` **本身不等于** `admin`;它是 **路径段历史**(Admin Legacy)
- `/api/v2/*` 下面的 `dictionaries` / `permissions` / `rbac-*` / `audit-logs` / `storage-settings` / `attachment-*-configs` / `contribution-rules` **surface = `ops`**(沿 [`CLAUDE.md §19.7 D-1`](../CLAUDE.md))
- `/api/v2/users/me/*` + `/api/v2/rbac/me/permissions` + `/api/v2/attachments/me/uploaded` **surface = `mobile`**(虽然挂在 v2 前缀下)
- 其余 `/api/v2/*` **surface = `admin`**

**铁律**:**不能仅根据路径前缀判 surface**;必须看 controller + endpoint 的业务语义。

### 1.5 Future Action(Phase 2 / 3 / 4 / 5 对应动作)

| Surface | Future Action |
|---|---|
| `public` | Phase 1B 增 `/api/public/v1/*` 别名(沿 [Phase 1 评审稿 §2.3](api-client-boundary-phase-1-review.md))|
| `mobile` | Phase 2 增 `/api/app/v1/me/*` + `/api/app/v1/my/*`(沿 Phase 0.5 §10.2 D-4 物理拆分);沿 §3 默认 `scope = self` |
| `admin` | Phase 3 新接口默认走 `/api/admin/v1/*`(方案 C);**旧 `/api/v2/*` 不动** |
| `ops` | Phase 4 双写迁 `/api/system/v1/*`;权限收紧(默认 `SUPER_ADMIN` 或显式 `xxx.system.xxx` 权限点) |
| `mixed` | Phase 5 物理拆分 Controller + DTO 隔离;**Phase 2 不要扩大 Mixed** |
| `internal` | 触发条件出现时新分类 |

---

## 2. Sensitive Field Classification

### 2.1 4 档敏感等级

| 等级 | 标签 | 定义 | 示例 |
|---|---|---|---|
| **L0** | Public / Normal | 业务展示可见,无 PII 性质 | `displayName` / `nickname` / `avatarKey` / `createdAt` / `activity.title` / 字典 `code` |
| **L1** | Personal Information | 个人信息;非紧急情况不主动外露 | `email` / `realName`(本人可见,他人脱敏) / `volunteerNo` / `gradeCode` |
| **L2** | Highly Sensitive | 高敏感个人信息 / 健康 / 联系方式 | `mobile` / `landline` / 紧急联系人 `phone` / `bloodTypeCode` / `medicalNotes` / `birthDate` / 内部备注 |
| **L3** | Credential / Secret | 凭据 / 密钥 / 可重放令牌 | `passwordHash` / `refreshToken` / `tokenHash` / `accessToken` / `secretIdEncrypted` / `secretKeyEncrypted` / signed URL 完整字符串 |

### 2.2 字段敏感等级分类表

> 表中 **AppSelf 默认** / **AppPeer 默认** 等列是"该视角默认是否可见";**特殊场景**(本人完整资料导出 / 救援现场救援人员查健康)走独立审计接口,**不**默认开放。

| # | 字段 | 模型字段 / 来源 | 等级 | AppSelf 默认 | AppPeer 默认 | AppManaged 默认 | Admin 默认 | Ops/System 默认 |
|---|---|---|---|---|---|---|---|---|
| 2.1 | 姓名 | `MemberProfile.realName` | **L1** | ✅ | ⚠️ 显示 displayName / 队员等级 | ✅(任务范围内) | ✅ | ✅ |
| 2.2 | 手机号 | `MemberProfile.mobile` | **L2** | ✅(本人)| ❌ | ⚠️(救援现场可见,平时不可见;待业务确认) | ✅ | ✅ |
| 2.3 | 身份证号 | `MemberProfile.documentNumber` | **L2** | ⚠️ 默认后 4 位掩码;完整号走独立审计接口 | ❌ | ❌ | ⚠️ 默认掩码,完整号走独立审计接口 | ⚠️ 同 Admin |
| 2.4 | 志愿者编号 | `MemberProfile.volunteerNo` | **L1** | ✅ | ⚠️ 可视为半公开编号(待业务确认) | ✅ | ✅ | ✅ |
| 2.5 | 临时编号 | ❌ **当前未建模** | **L1**(预设) | N/A(沿 Phase 0.5 §10.2 D-1)| N/A | N/A | N/A | N/A |
| 2.6 | 组织 / 中队 | `MemberDepartment.organizationId` / `Organization.*` | **L0**(组织名)/ **L1**(组织内部架构) | ✅ | ⚠️ 仅本人所在中队名 | ✅ | ✅ | ✅ |
| 2.7 | 职务 / 岗位 | ❌ **当前未建模** | **L1**(预设) | ⚠️(Phase 0.5 §10.1 待业务决议) | ⚠️ | ⚠️ | ✅ | ✅ |
| 2.8 | 紧急联系人(姓名 / 关系) | `EmergencyContact.contactName` / `relation` | **L1** | ✅(本人) | ❌ | ⚠️(待业务确认)| ✅ | ✅ |
| 2.8.1 | 紧急联系人手机号 | `EmergencyContact.phone` | **L2** | ✅(本人) | ❌ | ⚠️(救援现场可见) | ✅ | ✅ |
| 2.9 | 血型 | `MemberProfile.bloodTypeCode` | **L2** | ✅ | ❌ | ⚠️(救援现场可见) | ✅ | ✅ |
| 2.10 | 健康信息 / 医疗备注 | `MemberProfile.medicalNotes` | **L2** | ✅ | ❌ | ❌(默认) | ✅ | ✅ |
| 2.11 | 证书 | `Certificate.*` | **L1** | ✅(本人;含未通过) | ⚠️ 仅"已通过 + 已公示" | ✅(任务范围内) | ✅ | ✅ |
| 2.12 | 证书附件 | `Attachment` via `Certificate` | **L1** + signed URL = **L3** | ✅(本人;附件 URL 现签现给) | ⚠️ 仅"已公示";URL 现签 | ⚠️(任务范围内);URL 现签 | ✅;URL 现签 | ✅;URL 现签 |
| 2.13 | 活动报名状态 | `ActivityRegistration.statusCode` | **L0** + 备注字段 **L1** | ✅(本人) | ⚠️ 仅"已确认参与者" | ✅(任务范围内) | ✅ | ✅ |
| 2.14 | 考勤记录 | `AttendanceRecord.*` | **L1** | ✅(本人) | ❌ | ✅(同队 / 同活动任务范围内) | ✅ | ✅ |
| 2.15 | 贡献值汇总 | 未实装聚合查询 | **L0**(本人) / **L1**(他人粒度) | ✅(本人完整) | ⚠️ 仅排行榜公开维度(待业务确认) | ✅ | ✅ | ✅ |
| 2.16 | 审核备注 | `Certificate.reviewerNote` / `Registration.rejectReason` | **L1**(对本人)/ **L2**(对他人) | ⚠️ 看自己被 reject 原因 | ❌ | ⚠️(任务范围内) | ✅ | ✅ |
| 2.17 | 内部备注 | 若 schema 加管理私有字段 | **L2** | ❌ | ❌ | ❌ | ✅(按 RBAC) | ✅ |
| 2.18 | 系统角色 | `User.role` | **L1**(对本人;UI 展示用) | ⚠️ 仅本人 role name | ❌ | ❌ | ✅ | ✅ |
| 2.19 | RBAC permission code | `Permission.code` / `UserRole[].role.permissions[].code` | **L1**(对本人;但**禁止** App 直接暴露 raw code,沿 Phase 0.5 §10.2 D-3) | ❌ raw code;**只**经 `/capabilities` 转 product-level | ❌ | ❌ | ✅(管理用) | ✅(管理用) |
| 2.20 | COS / SMS / Storage 凭证(明文)| `StorageSettings.secretId` / `secretKey`(明文)| **L3** | ❌ | ❌ | ❌ | ❌ | ❌ **永远不**明文返回;DB 内 AES-256-GCM 加密,API 返回脱敏标记 |
| 2.21 | signed URL(下载链接)| `getUploadUrl` / `getDownloadUrl` 响应 | **L3**(可重放令牌)| ⚠️ **现签现给**;响应体出现 1 次,**禁止**入日志 / audit context | ⚠️ 同 AppSelf 但**仅**已授权资源 | ⚠️ 同上 | ⚠️ 同上 | ⚠️ 同上 |
| 2.22 | refresh token(raw 明文)| login / refresh 响应体 | **L3** | ⚠️ 响应体出现 1 次;DB 仅存 sha256 hash(沿 [`CLAUDE.md §9 P0-E`](../CLAUDE.md))| N/A | N/A | N/A | N/A |
| 2.23 | password hash | `User.passwordHash` | **L3** | ❌ | ❌ | ❌ | ❌ | ❌ **永远不返回**(沿 [`CLAUDE.md §9` 密码处理铁律](../CLAUDE.md))|

### 2.3 视角默认上限铁律

| 视角 | 默认最高可见等级 | 例外 |
|---|---|---|
| **AppSelf** | **L2(本人字段)**;**L3 永远不可见** | refresh token / signed URL 在响应体出现 1 次,**不**入日志 |
| **AppPeer** | **L1(脱敏后)**;L2 / L3 **永远不可见** | 救援现场场景沿 §2.2 / §2.8.1 / §2.9 待业务确认 |
| **AppManaged** | **任务必要字段**(可含 L1,极少数 L2 如紧急联系人 / 血型救援场景);L3 不可见 | 各 managed 端点单独评审,**不**默认开放任何 L2 |
| **Admin** | **L2 必须有显式权限点**(沿 RBAC);L3 永远不返回明文 | 身份证号 / 内部备注等 L2 字段 admin 视角**默认掩码**,完整号走独立审计接口 |
| **Ops / System** | **L2 同 Admin**;L3 secret **永远不**明文返回;管理凭据走"加密 DB + 脱敏 API + 重置端点" 三件套 | StorageSettings reset-credentials 是写端点,**不**返回明文 |

### 2.4 字段分级铁律(Phase 2 实施时强约束)

1. **DTO 字段集必须按等级隔离**:`AppSelf*Dto` 字段集 ≤ L2(本人);`AppPeer*Dto` 字段集 ≤ L1(脱敏);`Admin*Dto` 字段集 ≤ L2(脱敏)+ 显式 L2(权限点);**所有 DTO** 字段集 **不**含 L3
2. **L3 字段在日志 / audit / OpenAPI 示例 / 测试 fixture / 文档示例中绝对禁出现**(沿 [`CLAUDE.md §9 P0-E refresh token 铁律`](../CLAUDE.md));审计 redact 清单沿 [`CLAUDE.md §17.4` 日志屏蔽清单](../CLAUDE.md)
3. **L2 字段默认掩码**;完整内容走独立审计接口 + audit_logs 写入
4. **L0 字段**不需要权限点保护,但**仍需** `JwtAuthGuard`(除非显式 `@Public()`)
5. **DTO 类型隔离**(沿 Phase 0.5 §6.2):**禁止** `extends` / `Pick` / `Omit` 一个 Admin DTO 构造 App DTO;**禁止**单 service 用同 DTO 给 App + Admin 两端返

---

## 3. Data Scope Policy

### 3.1 6 档 scope 定义

| scope | 数据范围 | 适用 surface | 当前 schema 支撑 |
|---|---|---|---|
| `self` | 仅本人(`currentUser.id` + `currentUser.memberId`)的数据 | `mobile` 默认 | ✅ 完全支撑 |
| `department` | 本部门 + 子部门(`MemberDepartment` 链路) | 未来"部门负责人" | ⚠️ 沿 [批次 8 RBAC Q8 = A 不切片](批次8_RBAC_业务确认稿.md);**当前不实施** |
| `activity` | 本活动的所有报名 / 考勤(`Activity.id` 范围) | 未来"活动负责人" 移动端 | ⚠️ `Activity` schema 无 `leaderId`,沿 Phase 0.5 §1.3 缺口 |
| `managed` | 当前登录人**被授权管理**的局部集合(交集 `department` ∪ `activity` ∪ 任务指派) | `mobile` 的 `/managed/*`(Phase 0.5 §3.2 预留)| ❌ 当前未实施 |
| `all` | 全量数据(默认 admin 视角) | `admin` 默认 / `ops` 默认 | ✅ 完全支撑 |
| `custom` | 由 RBAC permission code 显式限定的非默认范围 | `admin` / `ops` 内特殊端点 | ⚠️ 当前仅 `attachments.by-owner`(`attachment.read.by-owner` 权限点)走该模式 |

### 3.2 四个维度正交(铁律)

```txt
RBAC(动作能力)       回答"我能不能做这个动作?"      由 rbac.can(<code>) / @Roles(...) 决定
scope(数据范围)      回答"这个动作能作用于哪批数据?"  由 service 内 assertCanXxx + where 子句决定
field(字段集)        回答"返回时能看到哪些字段?"      由 DTO 类型 + select(...) 决定
state(状态机)        回答"当前状态下能不能做这个动作?" 由 service 内状态机检查 + 字典 code 决定
```

**铁律**:**四个维度全部通过**,动作才允许;**任一不通过**,拒绝。
任何 endpoint 实现 = 4 个维度组合表达式,**不能**合并为单一 `@Roles(...)` 判定。

### 3.3 surface × scope 默认值

| surface | 默认 scope | 例外 |
|---|---|---|
| `public` | N/A(无登录身份)| 无 |
| `mobile` | **`self`**(沿 Phase 0.5 §10.2 D-1) | `/managed/*` 走 `managed` scope(Phase 0.5 §3.2 预留;Phase 2 不实施) |
| `admin` | `all`(默认) | 部门级 RBAC 上线时走 `custom`(沿 §3.1 / 批次 8 Q8=A 不实施)|
| `ops` | `all`(全局配置)| 无 |

**铁律**:**Mobile API 默认 `self`,禁止默认 `all`**。任何 Mobile endpoint 必须显式声明 scope;无声明视作 `self`。

### 3.4 Phase 2 实施 scope 检查清单

> 每个 `/api/app/v1/*` endpoint 在 service 内必须执行以下 4 步,缺一不可:

1. **RBAC 检查**:`rbac.can(currentUser, 'app.<capability>')` 或 capability 表(沿 Phase 0.5 §10.2 D-3)
2. **scope 限定**:where 子句**必须**含 `memberId = currentUser.memberId`(self)或 `activityId IN (managedActivityIds)`(managed)
3. **field 限定**:返回 DTO 类型严格匹配 surface(沿 §2.4)
4. **state 检查**:依赖业务状态机的动作(报名 / 取消 / 改资料)必须先校验当前状态允许此动作(沿 §4)

**Phase 2 PR review 拒绝信号**:service 实现中**缺少**上面任一步 → **不**合并。

---

## 4. State Machine Matrix

> **当前代码实现说明**:SRVF 业务状态机**以字典 code 字符串 + service 层校验**实施(沿 schema 注释 `schema 不固化,由 service 层映射代码常量与 cert_status 字典 code`)。本节表格是 **design baseline**,**不是** implementation proof;实际状态流转的强制度由 service 层每个动作单独决定。
> 沿 [`docs/srvf-foundation-baseline.md §13`](srvf-foundation-baseline.md):**未来 Phase 2 / Phase 5 实施时,本表是评审稿底线**。

### 4.1 UserStatus(账号状态;**当前 schema 强约束**)

| Current State | Action | Next State | Actor / Permission | Scope | Audit | Reversible | Failure BizCode | Notes |
|---|---|---|---|---|---|---|---|---|
| `ACTIVE` | 管理员禁用 | `DISABLED` | `rbac.can(user.update.status)` + 沿 [`CLAUDE.md §13`](../CLAUDE.md) 自我保护 + 最后 super admin 保护 | `all` 或目标 USER | ✅ `user.status.disabled` | ✅(可改回 ACTIVE)| `RBAC_FORBIDDEN` / `LAST_SUPER_ADMIN_PROTECTED` / `CANNOT_OPERATE_SELF` | 联动撤 refresh token(沿 P0-E §7.3)|
| `DISABLED` | 管理员启用 | `ACTIVE` | 同上 | 同上 | ✅ `user.status.enabled` | ✅ | 同上 | 不自动恢复 refresh(用户需重新登录)|
| `ACTIVE` / `DISABLED` | 管理员软删 | (`deletedAt != null`) | `rbac.can(user.delete.account)` + 自我保护 + 最后 super admin 保护 | `all` | ✅ `user.delete.account` | ⚠️ schema 上保留软删;v1 不提供恢复接口 | `RBAC_FORBIDDEN` / `LAST_SUPER_ADMIN_PROTECTED` | 联动撤 refresh token(沿 P0-E §7.4)|

### 4.2 MemberStatus(队员状态;**当前 schema 强约束**)

| Current State | Action | Next State | Actor / Permission | Scope | Audit | Reversible | Failure BizCode | Notes |
|---|---|---|---|---|---|---|---|---|
| `ACTIVE` | 离队 / 退队 | `INACTIVE` | `@Roles(SUPER_ADMIN, ADMIN)` + 沿 [`docs/v2-data-model.md`](v2-data-model.md) | 目标 Member | ⚠️ 当前未必全审计;Phase 2 评审时确认 | ✅(归队可回 ACTIVE)| `MEMBER_NOT_FOUND` / `RBAC_FORBIDDEN` | **不**软删档案;`memberNo` 仍占位 |
| `INACTIVE` | 归队 | `ACTIVE` | 同上 | 同上 | ⚠️ 同上 | ✅ | 同上 | 归队后 `User.memberId` 关联**可能**需手工恢复(沿 [v2-data-model.md §5.277](v2-data-model.md))|
| `ACTIVE` / `INACTIVE` | 管理员软删 | (`deletedAt != null`) | `@Roles(SUPER_ADMIN)`(沿 inventory members DELETE)| 目标 Member | ⚠️ 当前未必全审计 | ⚠️ v1 不提供恢复接口 | `RBAC_FORBIDDEN` | 仅"档案误录"清理时使用;离队**不**用软删 |

### 4.3 ActivityStatus(活动状态;**当前 schema 用 `statusCode` 字典字符串**)

> 沿 schema 注释 `// statusCode 字典(activity_status);schema 不固化由 service 层映射`。
> **当前代码实施**:`PATCH /api/v2/activities/:id/publish` / `cancel` 两个独立动作端点;publish / cancel 字段 + 时间戳 + actor 字段 schema 已落地;**4 态闭集字典 code 待业务方与运营拍板**(本节表格列出常见 4 态作为基线提案,**不**作为 v0.14.0 落地证据)。

| Current State | Action | Next State | Actor / Permission | Scope | Audit | Reversible | Failure BizCode | Notes |
|---|---|---|---|---|---|---|---|---|
| `draft`(提案)| publish | `published` | `@Roles(SUPER_ADMIN, ADMIN)` + 报名期 / 时间字段非空 | `all`(admin)| ⚠️ Phase 2 评审时确认 | ❌(已 publish 不允许回 draft;评审时可再议)| 活动相关业务码 | `publishedBy` / `publishedAt` 填入 |
| `published` | cancel | `cancelled` | 同上 + `cancelReason` 非空 | `all` | ⚠️ 同上 | ❌ | 同上 | `cancelledBy` / `cancelledAt` / `cancelReason` 填入 |
| `published` | 自然完成(时间过)/ 终审通过 | `completed` | 系统 / cron(当前不做)/ 终审动作触发 | `all` | ⚠️ 同上 | ❌ | — | 当前无自动 cron;沿 [`CLAUDE.md §1`](../CLAUDE.md) v1 不引入 cron |
| `draft` / `published` | 软删 | (`deletedAt != null`) | `@Roles(SUPER_ADMIN, ADMIN)` | `all` | ⚠️ 同上 | ⚠️ v1 不提供恢复 | — | DELETE `/api/v2/activities/:id` |

> **Current code has partial state transition enforcement**;本表 4 态是 design baseline,**不是** implementation proof。Phase 2 / Phase 5 实施前需与业务方对齐字典 code 真实取值。

### 4.4 RegistrationStatus(报名状态;**当前字典 4 态闭集**)

> 沿 schema 注释 `// statusCode 字典 4 态(Q-D15 v0.3):pending / pass / reject / cancelled`。

| Current State | Action | Next State | Actor / Permission | Scope | Audit | Reversible | Failure BizCode | Notes |
|---|---|---|---|---|---|---|---|---|
| (新增) | 报名(本人 / 代报名)| `pending` | `mobile` `self` 或 `admin` 代报名 | `self`(App)/ `all`(admin) | ⚠️ Phase 2 评审时确认 | — | 沿现状 activity-registrations BizCode | partial unique 约束(`status_code != 'cancelled'`)|
| `pending` | approve | `pass` | `admin` + `rbac.can(activity-registration.review)` 或活动负责人 managed | `all` 或 `activity` managed | ⚠️ | ⚠️ 评审时可再议是否允许回 pending | — | `reviewedBy` / `reviewedAt` 填入 |
| `pending` | reject | `reject` | 同上 | 同上 | ⚠️ | ⚠️ | — | reject 原因字段 |
| `pending` / `pass` | cancel(本人撤回 / admin 撤销)| `cancelled` | `self`(本人取消)或 `admin` | `self` 或 `all` | ⚠️ | ❌ | — | `cancelledByUserId` / `cancelledAt` 填入(Q-D16 v0.3)|
| `reject` / `cancelled` | (终态;无后续 action)| — | — | — | — | ❌ | — | partial unique 允许同活动重新报名(因 `status_code != 'cancelled'` 不冲突)|

### 4.5 AttendanceSheetStatus(考勤表状态;**当前字典 3 态 + 终审**)

> 沿 schema 注释 `// statusCode 字典 3 态(D18):pending / approved / rejected;APD 一级 approve 时 statusCode 进入 pending_final_review`。
> **实际**:3 态 + `pending_final_review` 中间态 = **5 态**(沿 inventory §2.10 `approve` / `reject` / `final-approve` / `final-reject` 4 个独立动作端点)。

| Current State | Action | Next State | Actor / Permission | Scope | Audit | Reversible | Failure BizCode | Notes |
|---|---|---|---|---|---|---|---|---|
| (新增 submit)| submit(创建)| `pending` | `admin` + `rbac.can(attendance-sheet.create)` | `all` | ⚠️ | — | 沿 attendances BizCode | `submitterUserId` 填入 |
| `pending` | approve(一级) | `pending_final_review` | `admin` + `rbac.can(attendance-sheet.review)` | `all` | ⚠️ | ⚠️ Phase 2 评审时可再议 | — | 一级审批通过 |
| `pending` | reject | `rejected` | 同上 | `all` | ⚠️ | ⚠️ | — | reject 原因字段 |
| `pending_final_review` | final-approve(终审) | `approved`(终态)| `admin` + `rbac.can(attendance-sheet.final-review)` | `all` | ⚠️ | ❌ | — | `reviewedBy` / `reviewedAt` 填入;后续触发贡献值规则 |
| `pending_final_review` | final-reject | `rejected`(终态)| 同上 | `all` | ⚠️ | ❌ | — | reject 原因字段 |
| `pending` / `pending_final_review` | 软删 / `update` 限制 | — | 终态前可改;终态后不可 | `all` | ⚠️ | ⚠️ | — | 沿 schema previousSnapshot Json 字段(D38)|

### 4.6 CertificateStatus(证书状态;**当前字典 4 态闭集**)

> 沿 schema 注释 `// 状态机:4 态闭集 (pending / verified / expired / rejected);schema 不固化由 service 层映射代码常量与 cert_status 字典 code`。

| Current State | Action | Next State | Actor / Permission | Scope | Audit | Reversible | Failure BizCode | Notes |
|---|---|---|---|---|---|---|---|---|
| (新增 create)| create | `pending` | `admin` + `rbac.can(certificate.create)` | 目标 member | ⚠️ | — | 沿 certificates BizCode | service 填 `pending` |
| `pending` | verify | `verified` | `admin` + `rbac.can(certificate.verify)` | 目标 member | ⚠️ | ⚠️ Phase 2 评审时可再议 | — | `verifiedBy` / `verifiedAt` 填入 |
| `pending` | reject | `rejected` | 同上 | 同上 | ⚠️ | ⚠️ | — | reject 原因 |
| `verified` | 过期(系统 / 时间触发)| `expired` | 系统(当前无 cron;沿 v1 不做)| `all` | — | ❌ | — | `expiredAt` 时间字段 + 业务层离线检查 |
| `rejected` / `expired` | (终态)| — | — | — | — | ❌ | — | — |

### 4.7 Storage credential / config status(**当前未状态机化,沿 StorageSettings singleton + AES-256-GCM**)

> 沿 schema `StorageSettings` 注释 `加密字段 secretIdEncrypted / secretKeyEncrypted 由 StorageCryptoService 处理`。
> **当前 schema 无 status enum**;Provider 切换 / 凭据重置由 3 个独立动作端点驱动(沿 inventory §2.21 storage-settings 3 endpoint)。

| 动作 | 当前实施 | Surface | Audit | Notes |
|---|---|---|---|---|
| GET `/api/v2/storage-settings` | 返回脱敏后的 settings(**不**含明文 secret) | `ops` | ✅ 沿 baseline | 凭据字段返回脱敏标记(`secretIdMasked` / `lastResetAt`) |
| PATCH `/api/v2/storage-settings` | 更新 provider / endpoint / 加密凭据 | `ops` + 高危权限点 | ✅ 必写 audit | 加密在 `StorageCryptoService` 内做,**禁止**接口返回明文 |
| POST `/reset-credentials` | 重置凭据(写入新的 AES-encrypted secret) | `ops` + 高危权限点 | ✅ 必写 audit | 入参为新 secret;响应**不**返回 secret 明文 |

**铁律**:`StorageSettings` 的 `secretIdEncrypted` / `secretKeyEncrypted` 是 **L3** Credential;**任何**响应体 / 日志 / audit context **不得**含明文。

### 4.8 状态机实施基线声明

> **重要**:本节 4.1 ~ 4.7 表格中,**仅 UserStatus(§4.1)和 MemberStatus(§4.2)由 Prisma enum 强约束**。
> 其余(Activity / Registration / AttendanceSheet / Certificate)**当前由字典 code 字符串 + service 层校验**,**未在 schema enum 强约束**。
>
> **Current code has partial state transition enforcement**;本表是 **design baseline**,**不是** implementation proof。
> Phase 2 / Phase 5 实施前需:
>
> 1. 与业务方对齐每个状态机的字典 code 真实取值
> 2. 在 service 层补齐"非法状态转移拒绝"的 BizException 抛出
> 3. 在 contract / E2E 测试中覆盖每条非法转移路径
> 4. **不**自动升级为 Prisma enum(沿 [`docs/V2红线与复活路径.md` A-3](V2红线与复活路径.md) schema 改动是 D 档,需单独立项)

---

## 5. User / Member Lifecycle

### 5.1 双实体定义

```txt
User    = 登录账号(authentication 主体)
        - 必有 username + passwordHash
        - 必有 role(SUPER_ADMIN / ADMIN / USER)
        - 必有 status(ACTIVE / DISABLED)
        - 可能有 deletedAt(软删)
        - 可能有 memberId(关联到 Member;可空)

Member  = 队员业务档案(authorization / 业务 主体)
        - 必有 memberNo(全局唯一,终身不变)
        - 必有 displayName + gradeCode + status(ACTIVE / INACTIVE)
        - 可能有 deletedAt(软删,仅"档案误录清理"才用)
        - 可能有反向 User?(1-to-1 可选关联)
```

### 5.2 关联关系铁律

1. **关联点唯一**:`User.memberId`(可空)是账号到正式队员档案的唯一关联;**禁止**反向关联(`Member.userId`),沿 [`docs/v2-data-model.md §5.263`](v2-data-model.md)
2. **User 可以没有 Member**:管理员账号(`Role.ADMIN` / `SUPER_ADMIN`)默认无 `memberId`;沿 Phase 0.5 §10.2 D-2,**这种账号不能完整使用 App 队员功能**(`canUseApp = false`)
3. **Member 可以暂时没有 User**:业务允许"线下入队但暂未注册账号"(由业务方决议);Phase 2 App login 范围内,**没有 User 的 Member 无法登录 App**
4. **memberNo 终身不变**:**禁止**复用编号;离队 / 退队 / 软删后编号仍占位(沿 [`docs/v2-data-model.md §5.276`](v2-data-model.md))
5. **临时编号 ≠ memberNo**:沿 Phase 0.5 §10.2 D-1,临时编号(`Txxx`)**当前未建模**;若未来落地,**禁止**与正式 `memberNo` 共字段;转正后临时编号**作废**,不作为正式身份保留
6. **User.role 不进入 Member 字段**:`User.role`(系统角色)与 `Member.gradeCode`(队员等级)是两个正交概念;**禁止**互通

### 5.3 三条独立生命周期

```txt
User Lifecycle:
  CREATE → status=ACTIVE
       └─→ DISABLED ↔ ACTIVE(可逆;管理员动作)
       └─→ DELETED(deletedAt != null;v1 不可逆;沿 §4.1)

Member Lifecycle:
  CREATE → status=ACTIVE
       └─→ INACTIVE(离队 / 退队;可逆,归队回 ACTIVE)
       └─→ DELETED(deletedAt != null;仅档案误录清理用)

Linkage(User.memberId):
  null → linked(管理员绑定;沿 v2-data-model.md §5.373)
  linked → null(管理员解绑;场景:Member 软删时可选)
```

**铁律**:这**三条**生命周期是**独立**的;**禁止**因"User 停用"自动触发"Member 离队",反之亦然。
联动逻辑(如:Member 离队时是否自动解绑 User.memberId / 撤 RBAC roles)**留给 Phase 2 评审稿决议**;**本评审稿不锁**。

### 5.4 生命周期矩阵(User × Member × Linkage × Capability)

> 表中 `?` 表示**当前不能完整判定**(沿 Phase 0.5 §10.1.2 / 本评审稿 §5.3)。
> ✅ = 当前必须支持;❌ = 当前明确拒绝;⚠️ = 受限 / 待业务决议。

| # | User.status | User.deletedAt | User.memberId | Member.status | CanLogin | CanUseApp | CanViewHistory(App 端读历史) | CanRegisterActivity |
|---|---|---|---|---|---|---|---|---|
| L1 | ACTIVE | null | null | N/A(无关联)| ✅ | ❌ `canUseApp = false`(沿 D-2)| N/A | N/A |
| L2 | ACTIVE | null | linked | ACTIVE | ✅ | ✅ | ✅ | ✅ |
| L3 | ACTIVE | null | linked | INACTIVE | ✅ | ⚠️(`canUseApp` 待业务决议:允许看历史档案 vs 拒登)| ⚠️ | ❌ |
| L4 | ACTIVE | null | linked | DELETED(deletedAt 非空)| ✅ | ❌(Member 档案不存在;走 D-2 `MEMBER_NOT_LINKED` 类逻辑)| ❌ | ❌ |
| L5 | DISABLED | null | (任)| (任)| ❌(沿 [`CLAUDE.md §8`](../CLAUDE.md))| ❌ | ❌ | ❌ |
| L6 | (任) | non-null(软删)| (任)| (任)| ❌(沿 [`CLAUDE.md §8`](../CLAUDE.md))| ❌ | ❌ | ❌ |
| L7 | ACTIVE | null | linked | ACTIVE,**Admin 兼队员** | ✅ | ✅(沿 Phase 0.5 §10.2 D-2,只用 linked-member self perspective)| ✅(本人范围)| ✅(本人,沿 D-2 不扩大可见性)|
| L8 | ACTIVE | null | null,**Admin 不绑 Member** | N/A | ✅ | ❌(沿 D-2)| N/A | N/A |
| L9 | ACTIVE | null | linked → 后被解绑 | ACTIVE | ✅ | ❌(解绑后 = L1)| N/A | N/A |
| L10 | ACTIVE | null | null → 后被绑定到 Member | ACTIVE | ✅ | ✅(绑定后 = L2)| ✅(从绑定时刻起)| ✅ |

### 5.5 临时编号 / 候选志愿者(沿 Phase 0.5 §10.2 D-1 锁定)

```txt
临时编号志愿者:
  - 当前 schema 未建模(沿 Phase 0.5 §1.3)
  - 不进入 Phase 2 App login 范围
  - 转正后:临时编号作废,生成新的正式 memberNo,memberNo 终身不变
  - 未来 Recruiting / Onboarding 设计线建模,独立 D 档专项

候选志愿者:
  - 同上;不进入 Phase 2 范围
```

**Phase 2 App API 实施铁律**(沿 Phase 0.5 §10.2 D-1):
- 所有 `/api/app/v1/*` endpoint 在认证后**必须**校验:
  ```ts
  if (
    !currentUser.memberId ||
    currentUser.status !== 'ACTIVE' ||
    currentUser.deletedAt !== null ||
    member.status !== 'ACTIVE'
  ) {
    // canUseApp = false 路径
  }
  ```
- 校验失败 → 走 capability 端点(`/me/capabilities` 返 `canUseApp: false`);**不**直接 403,**不**直接报错(沿 Phase 0.5 §10.2 D-2 user 友好)
- `MEMBER_NOT_LINKED`-style BizCode 是否新建,**留给 Phase 2 实现评审**(沿 Phase 0.5 §10.2 D-2)

### 5.6 离队 / 归队场景

| 场景 | User 字段变化 | Member 字段变化 | Linkage 变化 |
|---|---|---|---|
| Member 离队(正常)| 无 | `status = INACTIVE` | 不动 |
| Member 归队 | 无 | `status = ACTIVE` | 不动 |
| Member 离队 + 管理员主动撤 User 关联 | 无 | `status = INACTIVE` | `User.memberId = null` |
| Member 软删(档案误录)| 无 | `deletedAt = now()` | **建议**同步 `User.memberId = null`(Phase 2 评审稿决议)|
| User 禁用 | `status = DISABLED` + 撤 refresh | 不动 | 不动 |
| User 软删 | `deletedAt = now()` + `status = DISABLED` + 撤 refresh | 不动 | 不动(账号删除 ≠ 队员档案删除)|
| User 重建(同一队员重新发账号)| 新 `User` row 写入 | 不动(同一 Member)| 新 `User.memberId = oldMember.id` |

**铁律**:Member 软删后,该 `memberNo` **仍然占位**;**禁止**复用编号给新队员。

---

## 6. 高风险返工点

> 按"返工成本 + 安全 / 合规风险"排序;每项**对应** Phase 2 PR review 拒绝信号。

| # | 风险 | 影响 | Phase 2 缓解 |
|---|---|---|---|
| **6.1** | **App DTO 复用 Admin DTO** → 敏感字段返工 + **合规风险** | **极高** | 严禁 `extends` / `Pick` / `Omit` Admin DTO;DTO 类型隔离(沿 §1.3 + §2.4 + Phase 0.5 §6.2);PR review 拒绝信号:diff 出现 `class AppXxxDto extends AdminXxxDto` |
| **6.2** | **scope 不清** → department / activity / managed 权限返工 | **高** | 每个 App / Admin endpoint 在 service 内显式声明 scope;Mobile 默认 `self`,无声明视作 `self`(沿 §3.3);PR review 拒绝信号:where 子句**无** `memberId = currentUser.memberId` 限制但 endpoint 在 `mobile` surface |
| **6.3** | **User / Member 生命周期混淆** → `/me` 与 App 登录返工 | **高** | Phase 2 实施 `/api/app/v1/me*` 前必须先实现 5.5 校验闭包;无 memberId 的 Admin 账号必须走 `canUseApp = false` 路径(沿 §5.5 + Phase 0.5 §10.2 D-2);E2E 覆盖 L1 / L2 / L3 / L4 / L7 / L8 矩阵行 |
| **6.4** | **状态机不清** → 审核 / 报名 / 考勤逻辑返工 + **数据一致性风险** | **高** | Phase 2 / Phase 5 实施前必须先与业务方对齐每个状态机的字典 code 真实取值;service 内**必须**抛 `INVALID_STATE_TRANSITION` 类 BizException;contract / E2E 覆盖每条非法转移路径 |
| **6.5** | **L3 secret 字段误返** → **安全事故** | **极高** | 每个 PR 在 review 前**强制** grep 响应 DTO 是否含 `passwordHash` / `secretKey` / `secretId` / `refreshToken` / `tokenHash`;沿 [`CLAUDE.md §9` 密码处理铁律](../CLAUDE.md) + [`CLAUDE.md §17.4` 日志屏蔽清单](../CLAUDE.md);snapshot 测试若出现这些字段直接拒合并 |
| **6.6** | **临时编号 / 候选志愿者**字段进入 schema 而不走 Recruiting 设计线 | **中** | 沿 Phase 0.5 §10.2 D-1 + §19.7 D-5.1;**禁止**在 `MemberStatus` enum 新增值 / **禁止**在 `Member` / `MemberProfile` 新增字段处理候选状态;独立 D 档评审 |
| **6.7** | **Mobile API 默认 scope 错误**(误设 `all`)→ 信息泄漏 | **极高** | 每个 Mobile endpoint service 实现首行**必须**显式 `const scope = 'self'` 注释 + where 子句强约束;Phase 2 评审稿 §X 锁定 |
| **6.8** | **signed URL 入日志 / audit** → 可重放令牌泄漏 | **高** | 沿 §2.2 + [`CLAUDE.md §17.4`](../CLAUDE.md);log 中间件 redact 清单**必须**含 signed URL pattern;auditMeta context 字段**禁止**写入 raw URL |
| **6.9** | **Admin 兼队员** 在 App 看到非本人数据 | **极高** | 沿 Phase 0.5 §10.2 D-2;App API where 子句**永远**用 `currentUser.memberId`,**禁止** `role` 短路放过;E2E 必含"Admin 登录 App 调 `/my/registrations` 期待空列表 / 仅本人"用例 |
| **6.10** | **状态机仅在 service 层判定,无 DB 约束** → 并发场景双写 | **中** | 沿 [`CLAUDE.md §12` 事务](../CLAUDE.md);状态转移**必须**在 `prisma.$transaction` 内;partial unique index 防并发(沿 schema `activity_registrations_activity_member_active_unique`)|

---

## 7. 与既有铁律的衔接

| 既有铁律 | 与本评审稿关系 |
|---|---|
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) A-2 / A-3 / A-4 | ✅ 本评审稿不动 Role enum / schema / migration |
| [`CLAUDE.md §1`](../CLAUDE.md) v1 不做清单 | ✅ 不引入 casl / Redis / 多租户 |
| [`CLAUDE.md §9` P0-D / P0-E 密码 / refresh 铁律](../CLAUDE.md) | ✅ 沿 L3 凭据规则(§2.2 #2.22)|
| [`CLAUDE.md §13` 角色层级](../CLAUDE.md) | ✅ Role 三层不变(§5.1)|
| [`CLAUDE.md §17.4` 日志屏蔽](../CLAUDE.md) | ✅ L3 字段不入日志(§2.4 #2)|
| [`CLAUDE.md §19.7 D-1 ~ D-5`](../CLAUDE.md) | ✅ 全部沿用;本评审稿不重复决议 |
| [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) 13 项 | ✅ 不触发任何基线变更 |
| [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) | ✅ A-2 / A-3 / A-4 / Slow-3 / Slow-4 沿用 |
| [`docs/批次8_RBAC_业务确认稿.md`](批次8_RBAC_业务确认稿.md) Q8=A 不切片 | ✅ 本评审稿 §3.1 `department` scope 标"当前不实施" |
| [Phase 0 / Phase 1 / Phase 0.5 评审稿](api-client-boundary.md) | ✅ 本评审稿是补充,**不**替代 |

---

## 8. 解除时机与下一步

### 8.1 本评审稿生效顺序

1. **2026-05-19 v0 创建**:本评审稿 v0 创建;**不**改任何代码
2. **用户拍板**:用户接受本评审稿 §1 ~ §6;**无需**新增 D-N 锁定决议(沿用 Phase 0.5 §10.2 D-1 ~ D-4)
3. **Phase 2 立项评审稿启动**:沿 [migration-plan.md §4](api-client-boundary-migration-plan.md) 单独立项;本评审稿与 [Phase 0.5 §10.2](app-permission-boundary-review.md) 共同作为 Phase 2 实施硬约束

### 8.2 本评审稿不解决的问题

- 不解决"候选 / 临时编号志愿者"schema 建模 → 独立 D 档 Recruiting / Onboarding 设计线
- 不解决"活动负责人 / 考勤负责人 / 部门负责人"schema 字段建模 → 独立 D 档专项
- 不解决"部门级数据范围权限"(`department` scope)→ 沿 [`ARCHITECTURE.md §9` 升级路径](../ARCHITECTURE.md);多组织诉求触发时启动
- 不锁状态机字典 code 真实取值(`activity_status` 4 态 / `cert_status` 4 态 / `attendance_sheet_status` 5 态) → Phase 2 / Phase 5 启动前与业务方对齐
- 不锁 `MEMBER_NOT_LINKED` BizCode 段位 → 沿 Phase 0.5 §10.2 D-2 留 Phase 2 实施评审

### 8.3 修订规则

- 本评审稿评审通过后,修订必须**记录修订时间 + 变更摘要**
- §4 状态机表格在 Phase 2 / Phase 5 实施时**就地**补充字典 code 真实取值,**不**新建 v1 / v2 文档(沿 [Phase 1 评审稿 §10](api-client-boundary-phase-1-review.md))

### 8.4 Phase 2 实施引用

**Phase 2 implementation must read** [`docs/app-api-phase-2-review.md`](app-api-phase-2-review.md) **before any `/api/app/v1/*` endpoint PR**。本评审稿 §1(surface)/ §2(field)/ §3(scope)/ §4(state)/ §5(lifecycle)/ §6(高风险返工点)由该评审稿在 Phase 2 范围内具体化为 endpoint 表 / DTO 命名 / identity-access 矩阵 / 风险表。

---

> **本评审稿生效时间**:2026-05-19(Phase 0.6 v0)。
> **当前状态**:Phase 2 前置文档之一(与 Phase 0.5 §10.2 共同作用)。
> **过期条件**:Phase 2 + Phase 5 全部落地后,本评审稿降为"历史评审"。
