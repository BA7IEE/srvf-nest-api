# SRVF API Client Boundary(顶层规范 / 设计期 v0)

> **状态**:**设计期 v0**(2026-05-19)。**仅文档锁定,不是开发执行约束。**
> **生效范围**:`srvf-nest-api` 派生项目;不回流 `u-nest-api-starter`。
> **解除条件**:本文档 + [`docs/api-client-boundary-inventory.md`](api-client-boundary-inventory.md) + [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md) 评审通过,
> 且后续 Phase 1+ 任务在 [`docs/process.md`](process.md) 流程内单独立项后,本文档才作为正式蓝图引用。
> **冲突优先级**:
>   1. [`ARCHITECTURE.md`](../ARCHITECTURE.md) v1 §1-§10 / V1.1 §11 / V2 §12 铁律
>   2. [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) §1-§18
>   3. [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) 13 项基线
>   4. [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) A/B/C/D/E 五档红线
>   5. 各批次评审稿 `docs/批次*.md` / `docs/first-release-*.md`
>   6. **本文档(client boundary 设计期 v0)**
>
> 当本文档与上方任何源冲突时,**让步给上方,不擅自调和**。

---

## 0. TL;DR(给三分钟时间的读者)

SRVF API 现在已经客观上分流向**至少三类客户端**:
PC 管理后台 / 移动端(队员 App / 小程序) / 系统配置控制台。
当前所有业务接口仍统一挂在 `/api/v2/*` 资源路径下,长期会同时承担"管理别人"和"管理我"两种语义。

本文档**只锁定目标架构**(`/api/auth/v1` / `/api/public/v1` / `/api/app/v1` / `/api/admin/v1` / `/api/system/v1`)
与 **8 条客户端边界铁律**。**不**改任何代码、路径、Prisma、权限、DTO 行为。

实际迁移按 [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md) 分 5 阶段执行;
**本轮(Phase 0)**只完成"现状盘点 + 顶层规范 + 迁移路线"。

---

## 1. 背景

### 1.1 当前真实分流

| 客户端 | 用途 | 调用边界 |
|---|---|---|
| **PC 管理后台**(已联调) | 管理队员 / 组织 / 活动 / 考勤 / 证书 / 字典 / 权限 / 审计 | 当前直接调 `/api/v2/*` 全量接口 |
| **移动端 / 小程序 / 队员端**(规划中) | 队员自助:看活动、报名、看本人考勤 / 证书 / 报名记录 / 改资料 | 待新增 |
| **系统配置控制台**(已部分联调) | 字典 seed、permission/role 管理、storage 配置、audit-logs | 当前混在 `/api/v2/*` 内,只靠角色 / RBAC 区分 |
| **公开页**(规划中) | 健康检查 / 公开公告 / 招新页 / App 版本信息 | 当前仅 `/api/health/*` 在用 |
| **认证端点** | login / refresh / logout / logout-all | 当前在 `/api/auth/*`(无版本号) |

### 1.2 不分边界的长期代价

继续维持"统一 `/api/v2/*` 资源 API"路线,**对短期能跑通联调没影响**,但中长期会出现:

1. **DTO 混用**:后台详情 DTO 含敏感字段(身份证、紧急联系人、医疗等);移动端如果复用,前端必须自己裁字段。一旦哪天前端"懒"把详情 DTO 整段渲染,**敏感字段泄漏**。
2. **权限判断复杂化**:同一接口要 `if (role===USER) {...} else {...}` 分支返回不同范围,service 内业务逻辑被权限分支污染。
3. **Swagger 合同语义不清**:OpenAPI tag 是 `members`、`activities`,前端 SDK 拿到的是混合方法集,无法靠 tag 路由到 App / Admin / System SDK。
4. **小程序 / App 发布后接口变更成本陡升**:一旦 App 上架,接口契约需向后兼容数月;后台接口想加字段、改语义没成本,但同一接口给 App 用就变成"必须保留旧字段"。
5. **测试边界模糊**:E2E 测试不知道该按"角色场景"还是"客户端场景"组织。
6. **Mixed 接口 (USER + ADMIN 共用) 难审计**:权限点判定散在 service 内 if/else,审计与回归都难。

### 1.3 现状关键事实

> 来自 [`docs/current-state.md`](current-state.md) v0.14.0 与本批盘点(`docs/api-client-boundary-inventory.md`):

- 全局 prefix:`app.setGlobalPrefix('/api')`(见 [src/bootstrap/apply-global-setup.ts:37](../src/bootstrap/apply-global-setup.ts))
- 25 个 Controller / **约 140 个 HTTP endpoint**(以盘点表为准)
- 3 个"v1 legacy"前缀:`/api/auth/*`(4 路由)/ `/api/users/*`(11 路由)/ `/api/health/*`(3 路由)
- 22 个 Controller 全部挂在 `/api/v2/*`
- 权限标注存在**双轨**:`@Roles(...)` Guard 路径 + `rbac.can()` Service 路径
- 已经存在的"App 雏形":`/api/users/me*` / `/api/v2/users/me/*` / `/api/v2/rbac/me/permissions` / `/api/v2/attachments/me/uploaded`,**共 10 个 `/me` 端点**(详见 [`docs/api-client-boundary-inventory.md §5`](api-client-boundary-inventory.md)),但散落在 5 个 Controller / 5 种前缀里,**没有统一边界**

---

## 2. 目标架构

### 2.1 顶层前缀方案

最终 API 顶层前缀按"客户端边界"分类,**5 个并列段**:

| 前缀 | 用途 | 鉴权预期 | 客户端 |
|---|---|---|---|
| `/api/auth/v1/*` | 认证(login / refresh / logout / 短信 / 找回密码) | 部分 Public(login / refresh)+ 部分需 access token(logout-all) | 全部客户端共用 |
| `/api/public/v1/*` | 公开能力:健康检查 / 公开公告 / 招新页 / App 版本 | `@Public()`,**不需要 token** | 浏览器 / App / 小程序 / 巡检 / K8s |
| `/api/app/v1/*` | 移动端 / 小程序 / 队员端 | 任意登录用户(`me` 语义) | RN App / 微信小程序 / 队员 H5 |
| `/api/admin/v1/*` | PC 管理后台 | 登录 + 业务权限点(`rbac.can(...)` / role 短路) | PC Web |
| `/api/system/v1/*` | 系统治理:permission / role / 字典 / 审计 / 短信配置 / 存储配置 / app-config | 登录 + 高危权限点(默认仅 `ops-admin` 或 `SUPER_ADMIN`) | PC Web 的"超级管理员页"或独立运维控制台 |

> **版本号语义**:`/v1` 是**客户端边界版本**,不是数据模型版本。
> Prisma schema / 数据模型版本(v1 / V1.1 / V2 / V2.x)在 [`ARCHITECTURE.md`](../ARCHITECTURE.md) 内继续维护,**与本文档客户端边界版本号互不绑定**。
> 客户端边界 v1 上线后,若将来 App 协议需要不兼容升级,**新增** `/api/app/v2/*`,**老的不动**。

### 2.2 五段语义边界

#### Auth API(`/api/auth/v1/*`)

**用途**:身份认证与会话管理。
**典型端点**:

```txt
POST /api/auth/v1/login              # 账号 + 密码登录(沿现状,LoginDto 字段 zero drift)
POST /api/auth/v1/refresh            # refresh token 轮换(沿 P0-E)
POST /api/auth/v1/logout             # 单 token logout(幂等,沿 P0-E)
POST /api/auth/v1/logout-all         # 撤销当前 user 全部 refresh token(沿 P0-E)
POST /api/auth/v1/sms-code           # 短信验证码下发(未实现;待立项)
POST /api/auth/v1/password-reset     # 通过短信 / 邮件找回密码(未实现;待立项)
```

**铁律**:Auth API **不允许**包含"获取本人信息""改本人资料"这类已登录后操作 — 那些归 `/api/app/v1/me`。

#### Public API(`/api/public/v1/*`)

**用途**:**未登录即可访问**的能力。
**典型端点**:

```txt
GET /api/public/v1/health            # 进程存活(沿现状 /api/health)
GET /api/public/v1/health/live       # K8s liveness(沿现状)
GET /api/public/v1/health/ready      # K8s readiness + DB 连通(沿现状)
GET /api/public/v1/announcements     # 公开公告(未实现;待立项)
GET /api/public/v1/recruitment       # 公开招新页(未实现;待立项)
GET /api/public/v1/app-version       # App / 小程序最新版本号 + 强制升级标志(未实现;待立项)
```

**铁律**:Public API **必须全部** `@Public()`,**不允许**通过角色 / 权限点二次限制;Public API 也**不允许**消费 `request.user`。

#### App API(`/api/app/v1/*`)

**用途**:移动端 / 小程序 / 队员端 — "**当前登录人视角**"。
**核心语义**:**永远是"我"的资源**,前端**不传** memberId / userId / participantId,身份完全来自 access token。

**典型端点**(命名提案 — 实际命名以后续 Phase 2+ 评审稿为准):

```txt
GET   /api/app/v1/me                      # 本人 user + member 摘要
PATCH /api/app/v1/me/profile              # 改 nickname / avatarKey 等非敏感字段
PUT   /api/app/v1/me/password             # 本人改密(沿 P0-D)
GET   /api/app/v1/me/member               # 本人 member 详情(不含 ADMIN 视角字段)
GET   /api/app/v1/me/department           # 本人当前部门
GET   /api/app/v1/me/certificates         # 本人证书列表(过滤掉未通过的不一定可见,见 Phase 2 评审)
GET   /api/app/v1/me/registrations        # 本人活动报名记录
GET   /api/app/v1/me/registrations/:id    # 本人某条报名详情
PATCH /api/app/v1/me/registrations/:id/cancel  # 取消本人某条报名
GET   /api/app/v1/me/attendance-records   # 本人考勤记录
GET   /api/app/v1/me/contribution-points  # 本人贡献值汇总(未实现)
GET   /api/app/v1/me/permissions          # 本人权限点(沿 v0.x.x 已有 /api/v2/rbac/me/permissions)
GET   /api/app/v1/me/notifications        # 本人消息(未实现;待立项)

GET   /api/app/v1/activities              # 我可参加的活动列表(过滤 published 状态;不含草稿)
GET   /api/app/v1/activities/:id          # 活动详情(App 视角字段,**不**含 ADMIN 内部字段)
POST  /api/app/v1/activities/:id/registrations  # 本人报名某活动
```

**App 视角字段铁律**:

- 任何 App API 响应**不允许**返回:`deletedAt`、`reviewerNote` 等内部审批记录、其他 member 的身份证号 / 紧急联系人 / 医疗信息、未通过的证书细节
- 任何 App API 响应**不允许**返回内部审批流程的状态机字段名(如 `PENDING_FINAL_REVIEW`),应转为面向用户的语义(如"审核中""已通过")— **具体映射本文档不锁,由各 Phase 2+ 评审稿单独决议**
- App API **不允许**响应 `null` 字段拼接客户端 ID(如不允许 `{ memberId: null, isMe: true }` 这种奇怪结构);返回**结构化**业务对象

#### Admin API(`/api/admin/v1/*`)

**用途**:PC 管理后台 — "**资源管理视角**"。
**核心语义**:**别人的资源**(队员、活动、考勤、证书)、**全量数据**、筛选、分页、审批、导出、配置。

**典型端点**(命名提案):

```txt
GET    /api/admin/v1/members
POST   /api/admin/v1/members
GET    /api/admin/v1/members/:id
PATCH  /api/admin/v1/members/:id
PATCH  /api/admin/v1/members/:id/status
DELETE /api/admin/v1/members/:id

GET    /api/admin/v1/members/:memberId/profile
PATCH  /api/admin/v1/members/:memberId/profile
GET    /api/admin/v1/members/:memberId/emergency-contacts
POST   /api/admin/v1/members/:memberId/emergency-contacts
PATCH  /api/admin/v1/members/:memberId/emergency-contacts/:id
DELETE /api/admin/v1/members/:memberId/emergency-contacts/:id

GET    /api/admin/v1/members/:memberId/certificates
POST   /api/admin/v1/members/:memberId/certificates
PATCH  /api/admin/v1/members/:memberId/certificates/:id/verify
PATCH  /api/admin/v1/members/:memberId/certificates/:id/reject

GET    /api/admin/v1/activities
POST   /api/admin/v1/activities
PATCH  /api/admin/v1/activities/:id
PATCH  /api/admin/v1/activities/:id/publish
PATCH  /api/admin/v1/activities/:id/cancel
DELETE /api/admin/v1/activities/:id

GET    /api/admin/v1/activities/:activityId/registrations
GET    /api/admin/v1/activities/:activityId/registrations/export
PATCH  /api/admin/v1/activities/:activityId/registrations/:id/approve
PATCH  /api/admin/v1/activities/:activityId/registrations/:id/reject
PATCH  /api/admin/v1/activities/:activityId/registrations/:id/cancel

GET    /api/admin/v1/attendance-sheets
GET    /api/admin/v1/attendance-sheets/:id
GET    /api/admin/v1/attendance-sheets/:id/review-detail
PATCH  /api/admin/v1/attendance-sheets/:id/approve
PATCH  /api/admin/v1/attendance-sheets/:id/reject
PATCH  /api/admin/v1/attendance-sheets/:id/final-approve
PATCH  /api/admin/v1/attendance-sheets/:id/final-reject

GET    /api/admin/v1/organizations
GET    /api/admin/v1/organizations/tree
POST   /api/admin/v1/organizations
...

GET    /api/admin/v1/users
POST   /api/admin/v1/users
PATCH  /api/admin/v1/users/:id/role
PATCH  /api/admin/v1/users/:id/status
PUT    /api/admin/v1/users/:id/password
DELETE /api/admin/v1/users/:id

GET    /api/admin/v1/attachments
GET    /api/admin/v1/attachments/by-owner
PATCH  /api/admin/v1/attachments/:id
DELETE /api/admin/v1/attachments/:id
```

**Admin API 铁律**:

- Admin API **必须**全部走业务权限点(`rbac.can(...)`)或角色短路(`@Roles(SUPER_ADMIN, ADMIN)`),**禁止** `@Public()`
- Admin API 响应可以包含完整字段,包括 `deletedAt`、内部状态名、审批人备注等
- Admin API **不要求**自动隐藏其他 member 的敏感字段 — 字段可见性由 RBAC 权限点控制(已有 `rbac.can()` 体系)

#### System API(`/api/system/v1/*`)

**用途**:系统治理 / 平台配置 / 审计 / 极高危操作。
**核心语义**:**默认仅 `SUPER_ADMIN` 或显式 ops-admin 权限点可访问**。

**典型端点**(命名提案):

```txt
GET   /api/system/v1/dict-types               # 字典类型 CRUD
POST  /api/system/v1/dict-types
...
GET   /api/system/v1/dict-items
POST  /api/system/v1/dict-items
GET   /api/system/v1/dict-items/tree

GET   /api/system/v1/permissions              # RBAC permission code 配置
POST  /api/system/v1/permissions
PATCH /api/system/v1/permissions/:id
DELETE /api/system/v1/permissions/:id

GET   /api/system/v1/roles                    # RBAC role 配置
POST  /api/system/v1/roles
GET   /api/system/v1/roles/:id
PATCH /api/system/v1/roles/:id
DELETE /api/system/v1/roles/:id
POST  /api/system/v1/roles/:id/permissions
DELETE /api/system/v1/roles/:id/permissions/:permissionId

GET   /api/system/v1/users/:userId/roles      # user-role 关联
POST  /api/system/v1/users/:userId/roles
DELETE /api/system/v1/users/:userId/roles/:roleId

POST  /api/system/v1/rbac/reload              # 强制热更新 RBAC 缓存
GET   /api/system/v1/audit-logs               # 审计日志查询(只读)
GET   /api/system/v1/audit-logs/:id

GET   /api/system/v1/storage-settings         # 对象存储配置(AES-256-GCM 加密)
PATCH /api/system/v1/storage-settings
POST  /api/system/v1/storage-settings/reset-credentials

GET   /api/system/v1/attachment-type-configs  # 附件类型配置
POST  /api/system/v1/attachment-type-configs
... (mime / size-limit / type 三套配置表)

GET   /api/system/v1/contribution-rules       # 贡献值规则(无 CRUD 流水表)
POST  /api/system/v1/contribution-rules
PATCH /api/system/v1/contribution-rules/:id
DELETE /api/system/v1/contribution-rules/:id

GET   /api/system/v1/sms-settings             # 短信通道配置(未实现)
GET   /api/system/v1/app-config               # App 版本控制(未实现)
GET   /api/system/v1/message-templates        # 消息模板(未实现)
```

**System API 铁律**:

- System API **默认**只有 `SUPER_ADMIN` 或显式 `rbac.can('xxx.system.xxx')` 权限点可访问,**不允许**简单 `@Roles(ADMIN)` 短路放过
- System API 响应**不允许**返回明文凭据(如 storage SecretKey、SMS AppSecret)— 应返回脱敏标记 + 重置端点
- System API **必须**写 audit_logs(沿 [批次 6 红线 A-1](../docs/批次6_audit_logs_API前评审.md))
- System API 的"反向影响面"必须明确(如 reload RBAC 会影响所有在线用户),应在 Swagger summary 中显式说明

### 2.3 Mixed 与 Unknown 不是边界

**Mixed**(混用):同一 endpoint 既给 USER 又给 ADMIN 用,**是过渡态**,**不是目标态**。所有 Mixed 接口应在 Phase 5 之前拆完。
**Unknown**(未知):分类不清的接口,**视作 Mixed 处理**,在 Phase 0 盘点表中显式标注,等业务方决议。

---

## 3. 8 条客户端边界铁律

> **优先级**:本节铁律的优先级在 [`ARCHITECTURE.md`](../ARCHITECTURE.md) / [`CLAUDE.md`](../CLAUDE.md) / [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) **之下**。
> 冲突时本节让步,不擅自调和。

### 铁律 1:客户端边界优先于数据库表

**移动端不是数据库表的镜像。**

错误:

```txt
GET /api/app/v1/members/:memberId/profile  # 让 App 客户端自己传 memberId
```

正确:

```txt
GET /api/app/v1/me/profile                 # 身份来自 token
```

**Why**:数据库设计的多对一外键(`member.userId`)不是 API 设计的复用理由。App 客户端的语义是"我",不是"某个 member 实例"。

### 铁律 2:App API 不允许依赖前端传 memberId / userId 判断本人

**本人身份必须来自 token / `request.user`。**

错误:

```typescript
@Get('me/registrations')
list(@Param('userId') userId: string) { ... }   // ✗ 前端可伪造
```

正确:

```typescript
@Get('me/registrations')
list(@CurrentUser() user: CurrentUserPayload) { return service.list(user.id); }
```

**Why**:前端传 userId 等同于完全放弃身份校验 — 任何客户端都能假装别人。即使前端"信得过",一旦 App 被反编译,这一条立刻成漏洞。

### 铁律 3:App API 不允许复用后台 DTO

**移动端 DTO 必须单独定义,放在 `dto/app/` 目录,禁止直接返回后台详情 DTO。**

后台 `MemberResponseDto` 含:`deletedAt`、`reviewerNote`、`internalLevel`、`birthRegion`、`idCardEncrypted`(脱敏前)、`emergencyContactSnapshot` 等。
App `AppMyMemberResponseDto` 只含:`nickname` / `avatarKey` / `level` / `joinedAt` 等用户视角字段。

**Why**:复用 DTO 等于在 service 层做字段裁剪(`omit({ ... })`),裁剪集中维护一处时容易漏。一旦后台 DTO 加新字段(如 `salaryGrade`),App 自动暴露。**纵深防御**:DTO 不同,自然不可能共用。

### 铁律 4:Admin API 服务资源管理

Admin API 可以查别人、筛选、分页、审批、导出,**但必须受权限点控制**。
**禁止**通过 `@Roles(SUPER_ADMIN, ADMIN, USER)` 让 USER 进 Admin API "顺便看看自己"— 那是 App API 的事。

**Why**:权限分支污染 service 业务逻辑,后期改一个权限规则要改 10 处 if/else。

### 铁律 5:System API 默认高危

短信配置、权限配置、存储配置、审计日志属于系统治理能力,**默认只允许** `SUPER_ADMIN` 或明确权限点(`rbac.can('xxx.system.xxx')`)访问。
即使 `ops-admin` 角色,也应**显式**绑定到对应 permission code,不能"凡是 ops-admin 就放过"。

**Why**:System API 一旦被低权限角色误访问,影响面是"全平台",不是"一条记录"。

### 铁律 6:Controller 可以拆,Service 可以复用

**Controller 按客户端边界拆,Service 按业务能力复用,Repository / Prisma 按数据模型复用。**

```txt
src/modules/activities/
├── controllers/
│   ├── app-activities.controller.ts        # /api/app/v1/activities*
│   └── admin-activities.controller.ts      # /api/admin/v1/activities*
├── activities.service.ts                    # 业务能力(状态机、报名上限等),App + Admin 都调
├── activities.repository.ts                 # Prisma 数据访问层
└── dto/
    ├── app/
    │   ├── app-activity-list.dto.ts
    │   └── app-activity-detail.dto.ts
    ├── admin/
    │   ├── admin-create-activity.dto.ts
    │   └── admin-update-activity.dto.ts
    └── internal/
        └── activity.entity-shape.ts        # 内部 service 用,不出 controller
```

**Why**:Controller 是"客户端契约层",必须按客户端拆;Service 是"业务能力层",应跨客户端复用,否则两份 controller 调两份 service,业务规则就有可能漂移。

### 铁律 7:移动端接口稳定性优先

App / 小程序一旦发布,接口变更成本**高于** PC 管理后台。
即使发现 App API 字段名不优雅 / 多余,**不要**急着改名;先评估发布周期、客户端版本占比、强制升级机制。

**Why**:PC Web 可以一键全量更新;App 上架审核 + 用户更新 = 数周到数月长尾期。

### 铁律 8:禁止在一次 PR 内同时做路径迁移 + 权限重构 + DTO 重构 + 数据库改造

**必须分批**。
路径迁移单独 1 PR(只搬路径,不改语义);DTO 拆分单独 1 PR;权限点收紧单独 1 PR;数据库改造在 Phase 0/Phase 1 范围内**不做**(沿 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §1 v1 不做清单 + V2 升级路径)。

**Why**:混合 PR 难审查 / 难回滚 / 难定位回归;一次只动一个维度,review 成本可控。

---

## 4. 推荐代码结构(目标态;**Phase 0 不要求落地**)

```txt
src/modules/activities/
├── controllers/
│   ├── app-activities.controller.ts        # @Controller('app/v1/activities')
│   └── admin-activities.controller.ts      # @Controller('admin/v1/activities')
├── activities.module.ts
├── activities.service.ts                    # 跨客户端复用
├── activities.repository.ts                 # Prisma 访问层(可选;现状 service 内直读 prisma 也 OK)
└── dto/
    ├── app/                                 # App 视角入参 / 出参
    ├── admin/                               # Admin 视角入参 / 出参
    └── internal/                            # service 内部 shape(可选)
```

同理适用于:`members` / `activities` / `activity-registrations` / `attendances` / `certificates` / `attachments` / `emergency-contacts` / `member-profiles` / `member-departments`。

System 模块可放入 `src/system/`(目录改名是大动作,本文档**不强制**):

```txt
src/system/
├── dictionaries/
├── permissions/
├── audit-logs/
├── storage/
├── attachment-configs/
├── contribution-rules/
└── ...
```

**如果当前代码结构暂时不适合立即迁移,这是目标结构,不要求本轮(Phase 0)改造完成。**
具体目录搬迁时机见 [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md) Phase 3+。

---

## 5. Swagger / OpenAPI 规划

### 5.1 Tag 规范(目标态)

```txt
Auth
Public

App - Me
App - Activities
App - Registrations
App - Attendance
App - Certificates
App - Messages
App - Notifications

Admin - Users
Admin - Members
Admin - Member Profiles
Admin - Emergency Contacts
Admin - Member Departments
Admin - Organizations
Admin - Activities
Admin - Registrations
Admin - Attendance
Admin - Certificates
Admin - Attachments

System - Dictionaries
System - Permissions
System - Roles
System - Role Permissions
System - User Roles
System - RBAC
System - Audit Logs
System - Storage Settings
System - Attachment Configs
System - Contribution Rules
System - SMS Settings
System - App Config
```

### 5.2 多份 Swagger(可选,**Phase 0 不实现**)

未来可拆出独立 OpenAPI 文档,便于前端 SDK 生成:

```txt
/api-docs/app          # 仅 App API
/api-docs/admin        # 仅 Admin API
/api-docs/system       # 仅 System API
/api-docs              # 全量(沿现状 /api/docs)
```

实现方式:`@nestjs/swagger` 的 `include` 选项按 module 过滤,或按 `@ApiTags` 前缀过滤。

**本文档不强制**;实际拆分时机见 [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md) Phase 1。

---

## 6. 与现有铁律的衔接

### 6.1 与 [`ARCHITECTURE.md`](../ARCHITECTURE.md) / [`CLAUDE.md`](../CLAUDE.md) §1-§18 关系

| 现有铁律 | 与本文档关系 |
|---|---|
| v1 §1 "不做清单" | **不冲突**。本文档不引入任何 v1 "不做" 的能力。 |
| v1 §4 统一返回格式 | **完全兼容**。`/api/app/v1/*` / `/api/admin/v1/*` / `/api/system/v1/*` 全部继续走 `ResponseInterceptor`(`/api/docs` 跳过列表保留)。 |
| v1 §5 BizCode | **完全兼容**。BizCode 段位继续按业务模块编号,不按客户端边界分段。 |
| v1 §6 Swagger 100% | **完全兼容**。新增 tag 命名规范,装饰器规则不变。 |
| v1 §8 权限与鉴权 | **完全兼容**。Guard 全局注册 / `@Public()` / `@Roles(...)` 语义不变;新增"客户端边界 != 权限边界"约束(铁律 4 / 铁律 5)。 |
| v1 §13 角色层级 | **完全兼容**。`SUPER_ADMIN > ADMIN > USER` 三层不变;客户端边界**不替代**角色,而是与角色**正交**(`/api/app/v1` 仍然要登录;`/api/admin/v1` 仍然要权限点)。 |
| V1.1 §17 | **完全兼容**。helmet / throttler / health checks 在新前缀下继续生效。 |
| V2 §18 调研期约束 | **不冲突**。本文档是设计文档,不动 schema / migration / 业务代码。 |
| baseline 13 项 | **完全兼容**。BizCode 段位、命名、响应包装、DTO 白名单、模块结构、错误码命名、配置归属、日志屏蔽、Guard、软删除、v1 兼容性、时区、验收门槛**全部继续生效**。 |

### 6.2 与 P0-E refresh token / P0-D 改密铁律关系

- **P0-D 本人改密** `PUT /api/users/me/password` 在 Phase 2 时**迁**到 `PUT /api/app/v1/me/password`;P0-D 评审稿冻结的所有铁律(`@PasswordChangeThrottle` / `OLD_PASSWORD_INVALID=10005` / `NEW_PASSWORD_SAME_AS_OLD=10006` / 撤销 refresh token 联动等)**全部继承**,**仅改 path**
- **P0-E refresh token** `/api/auth/login` / `/api/auth/refresh` / `/api/auth/logout` / `/api/auth/logout-all` 在 Phase 1 时**统一**迁到 `/api/auth/v1/*`;P0-E v1 评审稿冻结的 BizCode `REFRESH_TOKEN_INVALID=10007` / family revoke / rotation always / absolute expiration / `LoginResponseDto` 5 字段 zero drift / payload zero drift 等**全部继承**,**仅改 path**
- 上述迁移的 path 改造**必须**双写(旧 + 新)+ deprecated 标记,**禁止**直接重命名打破前端联调

### 6.3 与"V2 调研期" §18 关系

V2 调研期 §18 的核心铁律是"**禁止在草案阶段动 schema / 新模块 / 安装依赖**"。
本文档是 API 边界设计稿,**不动数据库**,**不安装新依赖**,**不新增业务模块** — 严格遵守 §18.1 / §18.2 / §18.3 / §18.5 / §18.6。
冲突点:无。

### 6.4 历史草案文档关系

| 文档 | 关系 |
|---|---|
| [`docs/v2-api-contract.md`](v2-api-contract.md)(55k) | v2 现状契约;本文档是它的"客户端边界视角分类",**不**替代它 |
| [`docs/first-release-frontend-scope.md`](first-release-frontend-scope.md) | 第一版前端联调起步包 51 路由(实际 PC 后台);本文档把这 51 路由归为 **Admin** 视角并标记 Mixed 风险 |
| [`docs/first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md) | BizCode → 前端文案;本文档**不**改 BizCode,沿用 |
| [`docs/first-release-p0d-change-my-password-review.md`](first-release-p0d-change-my-password-review.md) | P0-D 评审稿;本文档**继承**全部铁律(见 §6.2)|
| [`docs/first-release-p0e-refresh-token-review.md`](first-release-p0e-refresh-token-review.md) | P0-E 评审稿;本文档**继承**全部铁律(见 §6.2)|

---

## 7. 解除时机与生效顺序

- Phase 0 完成 = 本文档 + [`docs/api-client-boundary-inventory.md`](api-client-boundary-inventory.md) + [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md) 评审通过
- Phase 1+ 落地 = 后续每个阶段在 [`docs/process.md`](process.md) 流程内**单独立项**,**单独评审**,**单独 PR**
- 本文档作为**设计期 v0** 落地后:
   - **不**自动触发任何代码迁移
   - **不**改变现有路径 / DTO / 权限
   - 仅作为"客户端边界规划"的权威设计稿,供后续阶段引用

---

## 8. FAQ

**Q1:为什么不直接复用现有 `/api/v2/*` 前缀,在 service 里靠角色分支?**
A:见 §1.2 与铁律 3。短期能跑,长期 DTO 混用 + 权限分支污染。

**Q2:`/api/v2/*` 会废弃吗?**
A:**不会**(2026-05-19 Phase 3 拍板方案 C)。`/api/v2/*` 长期作为 **Admin Legacy API** 保留:
- **不**主动标 deprecated
- **不**强制 PC 后台前端迁移
- **不**做大面积老接口双写
- 仅**新立项**的 Admin 接口走 `/api/admin/v1/*`
- 个别老接口若确需迁,**单独立项 + 单 PR**,不在 Phase 3 整体范围
详见 [`docs/api-client-boundary-migration-plan.md §5`](api-client-boundary-migration-plan.md)。

**Q3:Auth API 为什么独立于 App / Admin?**
A:Auth 是**所有客户端共用**的能力。如果挂在 `/api/app/v1/auth/login`,Admin 端登录也得走 App 前缀,语义错乱。Auth 独立是**唯一不与客户端绑定的能力**。

**Q4:为什么 Health 归 Public,不归 System?**
A:Health 端点的目的是**让运维系统 / K8s 不登录访问**;System API 的语义是"登录后高危治理操作"。语义完全不同。

**Q5:小程序 / App / 队员端 H5 是不是要各自一个前缀?**
A:**不要**。三者用户视角相同(都是"队员看自己"),**共用** `/api/app/v1/*`。前端差异在 SDK 层处理(UA / X-Client-Id 头),不在 URL 层。
如果将来出现"小程序专有 / App 专有"的场景(如 App 上的离线缓存预拉接口),再用 `/api/app/v1/native/*` 子前缀解决,**不**另起顶级前缀。

**Q6:`/me/permissions` 应该归 App 还是 System?**
A:**App**。`/me/permissions` 是"我看我有什么权限点",PC 后台进入后**也调这个接口**显示菜单(因为后台前端也是"以当前用户身份"查权限);它不是 System 治理操作。

**Q7:Mixed API 在过渡期怎么处理?**
A:**不要急着拆**。在 Phase 0 完成盘点 + Phase 1 完成 Swagger Tag 整理后,**优先**新增 App API(Phase 2);老 `/api/v2/*` 继续给 PC 后台用,沿 Phase 3 方案 C 长期保留为 Admin Legacy(不强制迁移)。

---

> **本文档生效时间**:2026-05-19 起,作为设计期 v0 锁定;**不**自动启动任何代码改造。
> 后续修订必须经过用户拍板,本文档迭代时记录修订时间与变更摘要。
