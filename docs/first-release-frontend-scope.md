# 第一版前端联调范围清单(P0-A 起步包)

> 用途:列出第一版前端**联调起步阶段**先接哪些接口、第一版后续阶段(P1)再接哪些、第一版完全不接哪些。
>
> 联调包齐备判定见 §11。本文与 [`first-release-readiness-plan.md`](first-release-readiness-plan.md) §3.1 P0-A 项对齐。
>
> 冲突优先级(沿 [`process.md §6`](process.md)):`ARCHITECTURE.md` > `CLAUDE.md` / `AGENTS.md` > `srvf-foundation-baseline.md` > `V2红线与复活路径.md` > 单批次评审稿 > handoff > `current-state.md` > `process.md` > 本文。冲突时本文让步。
>
> 本文不承载契约字段细节(回 [`v2-api-contract.md`](v2-api-contract.md))、数据模型(回 [`prisma/schema.prisma`](../prisma/schema.prisma))、完整 BizCode 翻译(留 P0-G)、字典 item 内容与测试账号凭据(留 P0-C)。

---

## 1. 用途与定位

第一版前端联调起步阶段(本起步包)目标是跑通"登录 → 看见基础数据 → 创建/编辑核心资源 → 上传附件 → 提交并审核报名"端到端最小闭环。

起步包**刻意不含**管理员重置密码 / 改角色 / 改状态 / 软删除 / 证书审核 / 活动取消 / 报名取消导出 / 考勤录入与审核等"完整管理动作",这些在 P1 阶段联调接入(§5)。

第一版**完全不接**:RBAC CRUD、storage-settings 凭证、attachment 配置三表、audit-logs 后台、contribution-rules、health 端点等(§6)。

后端真实总路由数 **139**;本文分类:起步包 **51** / P1 后接 **42** / 第一版不接 **46**(51 + 42 + 46 = 139)。P0-D PR-3(#117)新增 `PUT /api/users/me/password`(沿 [P0-D 评审稿](first-release-p0d-change-my-password-review.md)),纳入起步包 §4.2。

---

## 2. 第一版前端联调目标

- 队员账号 / 管理员账号能在生产环境登录,字段不再大改
- 管理员能管基础数据(用户、组织、队员、活动、报名、附件)
- 队员能登录看见自己资料,能报名活动,能查看自己考勤记录
- 上传 / 下载链路在生产 Storage Provider 上跑通
- 前端联调期前后端契约不漂移;BizCode 一一映射前端提示(完整 BizCode 翻译表见 P0-G)

---

## 3. 全局约定

### 3.1 base URL 与全局前缀

- 全局前缀 `/api`,在 v1 接口与 V2 接口下保留
- v1 接口路径:`/api/<resource>`(`auth` / `users` / `health`)
- V2 接口路径:`/api/v2/<resource>`(其余全部业务模块)
- 不同环境 base URL 由环境变量决定(dev / staging / prod);前端从环境配置读,**不硬编码**

### 3.2 鉴权

- 鉴权方式:`Authorization: Bearer <jwt>`(沿 [`CLAUDE.md §8`](../CLAUDE.md))
- `JWT_EXPIRES_IN` 默认 7d;过期后必须重新登录(第一版**不**做 refresh token,沿 [`readiness-plan §3.1 P0-E`](first-release-readiness-plan.md))
- HTTP 401 两阶段错误码区分:
  - `LOGIN_FAILED`(10004):登录失败(账号/密码 / 状态 / 软删四场景统一返;沿 [`CLAUDE.md §8`](../CLAUDE.md) 防账号枚举)
  - `UNAUTHORIZED`(40100):已登录但 token 无效 / 已过期 / 用户被禁用 / 已软删
- 前端**必须**按 `code` 区分二者(管理员重置密码后旧 token 失效,前端不能误判为登录表单密码错)
- 本人改密走独立接口 `PUT /api/users/me/password`(需 `oldPassword`;沿 §4.2);改密成功后**旧 token 仍有效**,前端**不需要**强制重登(沿 [P0-D 评审稿 §5.7](first-release-p0d-change-my-password-review.md));`tokenVersion` / refresh token / token revoke 仍归 [P0-E](first-release-readiness-plan.md) 统一评审

### 3.3 统一响应格式

成功:`{ code: 0, message: 'ok', data: <T> | null }`,HTTP status 200(沿 [`CLAUDE.md §4`](../CLAUDE.md))。

业务/HTTP 错误:`{ code: <BizCode.code>, message: '<biz message>', data: null }`,HTTP status 由 BizCode `httpStatus` 决定(不为"统一"返 200)。

`/api/docs` / `/api/docs-json` / `/favicon.ico` / `/metrics` / 文件下载流不走包装(沿 [`CLAUDE.md §4`](../CLAUDE.md))。

### 3.4 分页约定

入参 `PaginationQueryDto`(沿 [`ARCHITECTURE.md §7.3`](../ARCHITECTURE.md)):

- `page` 默认 `1`,最小 `1`
- `pageSize` 默认 `20`,最小 `1`,**最大 100**
- **禁止变体**:`limit` / `offset` / `skip` / `take` / `cursor`

出参 `PageResultDto<T>`,固定四字段:

```json
{ "items": [...], "total": <n>, "page": <n>, "pageSize": <n> }
```

默认排序 `orderBy: createdAt DESC`(各 service 实现保证);其它排序由查询 DTO 显式声明。

起步包内**分页接口清单**(共 12 个):users `GET /api/users`、organizations `GET /api/v2/organizations`、members `GET /api/v2/members`、emergency-contacts `GET /api/v2/members/:memberId/emergency-contacts`、certificates `GET /api/v2/members/:memberId/certificates`、activities `GET /api/v2/activities`、activity-registrations admin `GET /api/v2/activities/:activityId/registrations`、me `GET /api/v2/users/me/registrations`、attendances `GET /api/v2/activities/:activityId/attendance-sheets`、`GET /api/v2/users/me/attendance-records`、attachments `GET /api/v2/attachments/by-owner`、dict-items `GET /api/v2/dict-items`。

### 3.5 时间 / 日期格式

沿 [`baseline §12`](srvf-foundation-baseline.md):

- DB 存 UTC(`timestamptz`)
- API 响应字段为 ISO 8601 带 `Z` 后缀(UTC),例 `2026-05-07T08:30:00.000Z`
- 前端展示层负责本地时区转换(后端**不**预转 +08:00)
- 入参时间字段必须 ISO 8601 格式

---

## 4. 联调起步包接口清单(51 路由)

> 字段稳定标:✅ 稳定(契约 zero drift,字段不变)| ⚠️ 需前端联调复核(可能微调字段语义或扩展可选项)
> 分页:Y/N。鉴权:`PUB`(无需登录)/ `USER`(任意登录)/ `ADMIN`(`@Roles(SUPER_ADMIN, ADMIN)`)
> 路径中省略 `/api` 前缀。

### 4.1 auth(1)

| Method | Path | 描述 | 分页 | 鉴权 | 稳定 |
|---|---|---|---|---|---|
| POST | `/auth/login` | 登录(`username + password`;`memberNo` 也可作为 username 兜底) | N | PUB | ✅ |

### 4.2 users(7)

| Method | Path | 描述 | 分页 | 鉴权 | 稳定 |
|---|---|---|---|---|---|
| GET | `/users/me` | 本人资料 | N | USER | ✅ |
| PATCH | `/users/me` | 本人改资料(仅 `nickname` / `avatarKey`) | N | USER | ✅ |
| PUT | `/users/me/password` | 本人自助改密(需 `oldPassword`;改密后旧 token 仍有效;独立 throttler `password-change` 5/60 IP 维度;P0-D 评审稿) | N | USER | ✅ |
| GET | `/users` | 用户列表 | Y | ADMIN | ✅ |
| POST | `/users` | 创建用户(role 透传受边界保护) | N | ADMIN | ✅ |
| GET | `/users/:id` | 用户详情 | N | ADMIN | ✅ |
| PATCH | `/users/:id` | 改用户资料(**不含** role/status/password) | N | ADMIN | ✅ |

### 4.3 dict(只读 3)

| Method | Path | 描述 | 分页 | 鉴权 | 稳定 |
|---|---|---|---|---|---|
| GET | `/v2/dict-types` | 字典类型列表 | N | USER | ✅ |
| GET | `/v2/dict-items` | 字典项列表(可按 `dictTypeCode` 过滤) | Y | USER | ✅ |
| GET | `/v2/dict-items/tree` | 字典项树(父子) | N | USER | ✅ |

### 4.4 organizations(5)

| Method | Path | 描述 | 分页 | 鉴权 | 稳定 |
|---|---|---|---|---|---|
| GET | `/v2/organizations` | 组织列表 | Y | USER | ✅ |
| GET | `/v2/organizations/tree` | 组织树 | N | USER | ✅ |
| GET | `/v2/organizations/:id` | 组织节点详情 | N | USER | ✅ |
| POST | `/v2/organizations` | 新建节点(根节点 / 子节点) | N | ADMIN | ✅ |
| PATCH | `/v2/organizations/:id` | 改节点(**不**改 parent) | N | ADMIN | ✅ |

### 4.5 members + 子资源(12)

| Method | Path | 描述 | 分页 | 鉴权 | 稳定 |
|---|---|---|---|---|---|
| GET | `/v2/members` | 队员列表 | Y | ADMIN | ✅ |
| POST | `/v2/members` | 创建队员(全局 `memberNo` 不复用) | N | ADMIN | ✅ |
| GET | `/v2/members/:id` | 队员详情 | N | ADMIN | ✅ |
| PATCH | `/v2/members/:id` | 改队员基本资料(**不**含 status) | N | ADMIN | ✅ |
| GET | `/v2/members/:memberId/department` | 队员当前部门归属 | N | ADMIN | ✅ |
| PUT | `/v2/members/:memberId/department` | 设置队员部门(一人一部门 partial unique) | N | ADMIN | ✅ |
| GET | `/v2/members/:memberId/profile` | 队员档案(1:1;敏感字段) | N | ADMIN | ⚠️ |
| POST | `/v2/members/:memberId/profile` | 创建队员档案 | N | ADMIN | ⚠️ |
| PATCH | `/v2/members/:memberId/profile` | 改队员档案 | N | ADMIN | ⚠️ |
| GET | `/v2/members/:memberId/emergency-contacts` | 紧急联系人列表(N:1 + priority) | Y | ADMIN | ✅ |
| POST | `/v2/members/:memberId/emergency-contacts` | 新建紧急联系人 | N | ADMIN | ✅ |
| PATCH | `/v2/members/:memberId/emergency-contacts/:id` | 改紧急联系人 | N | ADMIN | ✅ |

> ⚠️ `member_profiles` 敏感字段在前端展示边界(身份证 / 政治面貌 / 血型等)需前端联调时按 RBAC / 业务场景再次确认;字段名稳定,展示策略**可能**微调。

### 4.6 certificates(4)

| Method | Path | 描述 | 分页 | 鉴权 | 稳定 |
|---|---|---|---|---|---|
| GET | `/v2/members/:memberId/certificates` | 队员证书列表 | Y | ADMIN | ✅ |
| POST | `/v2/members/:memberId/certificates` | 新建证书(进入 4 态起点) | N | ADMIN | ✅ |
| GET | `/v2/members/:memberId/certificates/:id` | 证书详情 | N | ADMIN | ✅ |
| PATCH | `/v2/members/:memberId/certificates/:id` | 改证书 | N | ADMIN | ✅ |

> 起步包阶段证书可完成创建与基础编辑;`verify` / `reject` 审核闭环在 P1 接入,因此证书可能停留在 `pending` 状态。

### 4.7 activities(5)

| Method | Path | 描述 | 分页 | 鉴权 | 稳定 |
|---|---|---|---|---|---|
| GET | `/v2/activities` | 活动列表 | Y | USER | ✅ |
| POST | `/v2/activities` | 新建活动 | N | ADMIN | ✅ |
| GET | `/v2/activities/:id` | 活动详情 | N | USER | ✅ |
| PATCH | `/v2/activities/:id` | 改活动 | N | ADMIN | ✅ |
| PATCH | `/v2/activities/:id/publish` | 发布活动(`draft` → `published`;开放报名) | N | ADMIN | ✅ |

### 4.8 activity-registrations(6)

| Method | Path | 描述 | 分页 | 鉴权 | 稳定 |
|---|---|---|---|---|---|
| GET | `/v2/activities/:activityId/registrations` | 报名列表(管理员视角) | Y | ADMIN | ✅ |
| PATCH | `/v2/activities/:activityId/registrations/:id/approve` | 通过报名 | N | ADMIN | ✅ |
| PATCH | `/v2/activities/:activityId/registrations/:id/reject` | 驳回报名 | N | ADMIN | ✅ |
| POST | `/v2/users/me/activities/:activityId/registration` | 本人报名 | N | USER | ✅ |
| GET | `/v2/users/me/registrations` | 本人报名列表 | Y | USER | ✅ |
| PATCH | `/v2/users/me/registrations/:id/cancel` | 本人取消报名 | N | USER | ✅ |

### 4.9 attendances 查看(3)

| Method | Path | 描述 | 分页 | 鉴权 | 稳定 |
|---|---|---|---|---|---|
| GET | `/v2/activities/:activityId/attendance-sheets` | 活动考勤单列表(查看) | Y | USER | ⚠️ |
| GET | `/v2/attendance-sheets/:id` | 考勤单详情 | N | USER | ⚠️ |
| GET | `/v2/users/me/attendance-records` | 本人考勤记录 | Y | USER | ✅ |

> ⚠️ 考勤起步包仅查看入口;创建 / 编辑 / 审核 / 终审在 P1 接入(§5)。考勤单的 USER 视角字段过滤策略可能微调。

### 4.10 attachments 上传与下载(5)

| Method | Path | 描述 | 分页 | 鉴权 | 稳定 |
|---|---|---|---|---|---|
| POST | `/v2/attachments/upload-url` | 申请签名上传 URL(模式 B 上传第 1 步) | N | USER | ✅ |
| POST | `/v2/attachments/confirm-upload` | 确认上传完成(模式 B 上传第 3 步) | N | USER | ✅ |
| GET | `/v2/attachments/by-owner` | 按 `ownerType + ownerId` 列附件 | Y | USER | ✅ |
| GET | `/v2/attachments/:id` | 附件详情(响应含签名 `accessUrl`;Provider 未接通 / 未配置时 `accessUrl` 可能为 null,见 §7.1) | N | USER | ✅ |
| DELETE | `/v2/attachments/:id` | 删附件(物理删元数据) | N | USER | ✅ |

> 起步包**只走模式 B**(预签名上传链);模式 A(`POST /v2/attachments` 直接创建元数据)在 P1 后接(§5)。

**起步包小计:1+7+3+5+12+4+5+6+3+5 = 51**(P0-D PR-3 #117 新增 `PUT /users/me/password`,users 段从 6 扩至 7)。

---

## 5. P1 后接接口清单(40 路由)

> 起步包跑通后,第一版上线前需要补接的剩余业务接口。按模块汇总,**不再逐行展开**;前端联调时按本表清单回头逐个接。

| 模块 | 路由数 | 接口 | 推到 P1 原因 |
|---|---|---|---|
| users 管理 | 4 | `PUT /users/:id/password` / `PATCH /users/:id/role` / `PATCH /users/:id/status` / `DELETE /users/:id` | role/status 变更与软删属"高危管理动作";本人改密接口 `PUT /users/me/password` 已落地于起步包 §4.2(P0-D PR-3 #117) |
| dict-types 余下端点 | 5 | `POST` / `GET :id` / `PATCH :id` / `PATCH :id/status` / `DELETE :id` | 字典初始化由 P0-C 运维侧 seed 完成;前端写字典在 P1 视后台需求决定是否接入。`GET :id` 详情接口前端高频度低,起步包靠 list 已覆盖 |
| dict-items 余下端点 | 5 | `POST` / `GET :id` / `PATCH :id` / `PATCH :id/status` / `DELETE :id` | 同上。`GET :id` 详情接口前端高频度低,起步包靠 list/tree 已覆盖 |
| organizations 管理 | 2 | `PATCH /v2/organizations/:id/status` / `DELETE /v2/organizations/:id` | last-root 保护 + 子树存在保护属高危;P1 视后台需求接入 |
| members 管理 | 2 | `PATCH /v2/members/:id/status` / `DELETE /v2/members/:id` | 队员软删与停用属高危;P1 接入 |
| member-departments | 1 | `DELETE /v2/members/:memberId/department` | 解绑动作 |
| emergency-contacts | 1 | `DELETE .../emergency-contacts/:id` | 删除动作 |
| certificates | 4 | `GET /v2/members/:memberId/certificates/qualification-flag` / `DELETE` / `PATCH :id/verify` / `PATCH :id/reject` | qualification-flag 为聚合查询(P1 视前端需求接);verify/reject 是审核动作(评审场景在 P1 闭环) |
| activities | 2 | `PATCH :id/cancel` / `DELETE :id` | 取消活动 + 软删 |
| activity-registrations admin | 3 | `POST` / `GET export` / `PATCH :id/cancel` | 代报 + CSV 导出 + admin 主动取消 |
| activity-registrations me | 1 | `GET /v2/users/me/registrations/:id` | 报名详情(列表已在起步包) |
| attendances 写+审 | 8 | `POST` / `GET :id/review-detail` / `PATCH :id` / `DELETE :id` / `PATCH :id/approve` / `PATCH :id/reject` / `PATCH :id/final-approve` / `PATCH :id/final-reject` | 考勤录入 + 5 态审核闭环 + 终审,前端用例多,集中在 P1 联调 |
| attachments | 4 | `POST /v2/attachments`(模式 A)/ `GET /v2/attachments`(管理列表)/ `GET .../me/uploaded` / `PATCH :id` | 起步包只走模式 B 与 by-owner;模式 A / admin list / 我上传的 / 元数据编辑在 P1 |

**P1 后接小计:4+5+5+2+2+1+1+4+2+3+1+8+4 = 42**

---

## 6. 第一版不接接口清单(46 路由)

> 这些接口当前后端已有,但第一版**整个生命周期**前端都不接(留给运维 / 后台 / Slow 等后续阶段)。

| 模块 | 路由数 | 不接原因 |
|---|---|---|
| audit-logs | 2 | 审计后台读端;沿 [`current-state §3`](current-state.md) ADMIN 边界未定义,留 Slow-3 / Slow-4 接入 RBAC 后再做前端 |
| attachment-type-configs | 6 | 配置三表 CRUD;由运维通过后台 / DB 维护,前端不接 |
| attachment-mime-configs | 6 | 同上 |
| attachment-size-limit-configs | 5 | 同上 |
| storage-settings | 3 | 凭证管理(`GET` / `PATCH` / `POST reset-credentials`);只允许运维操作,**不开放前端调用** |
| contribution-rules | 5 | D14 预填规则;无前端 CRUD 需求(沿 [`current-state §2`](current-state.md)) |
| permissions | 4 | RBAC 权限点 CRUD;沿 Slow-3 / Slow-4 未拍板 |
| rbac-roles | 5 | RBAC 角色 CRUD;同上 |
| role-permissions | 2 | 角色-权限授权;同上 |
| user-roles | 3 | 用户-角色绑定;同上 |
| rbac | 2 | `GET me/permissions` / `POST reload`;v1 阶段前端不依赖 RBAC 视图 |
| health | 3 | `GET /health` / `/health/live` / `/health/ready` 为 K8s / 运维端点,浏览器不直接调 |

**第一版不接小计:2+6+6+5+3+5+4+5+2+3+2+3 = 46**

> 第一版完全不做的能力(装备 / 数据统计 / 报表 / 大屏 / 事件 / 派遣 / 多租户 / 小程序登录 / Redis / queue / LLM 等)见 [`first-release-readiness-plan §3.3 / §7`](first-release-readiness-plan.md),不在本文重复列出。

---

## 7. 上传 / 下载流程

### 7.1 上传(模式 B 预签名链路)

```mermaid
sequenceDiagram
    actor U as 用户
    participant FE as 前端
    participant API as 后端 API
    participant SP as Storage Provider<br/>(Local / COS)

    U->>FE: 选择文件 + 业务场景(ownerType/ownerId)
    FE->>API: POST /api/v2/attachments/upload-url<br/>{ ownerType, ownerId, mime, size, ... }
    Note over API: 校验 ownerType / ownerId / RBAC<br/>系统黑名单 13033 / 白名单未命中 13012<br/>size 上限 13013 / PII 13015
    API-->>FE: { uploadUrl, uploadToken, key, expiresIn }
    FE->>SP: PUT uploadUrl<br/>(二进制 body;不经后端)
    SP-->>FE: 200 OK / etag
    FE->>API: POST /api/v2/attachments/confirm-upload<br/>{ uploadToken, ... }
    Note over API: 验 uploadToken + headObject<br/>校验 size 一致 → 落库 + audit
    API-->>FE: AttachmentResponseDto<br/>(id / key / accessUrl=null 占位)
    FE->>API: GET /api/v2/attachments/:id<br/>(后续读取签名 URL)
    API-->>FE: { ..., accessUrl }(签名 URL,带过期时间)
    FE->>SP: GET accessUrl
    SP-->>FE: 文件内容
```

### 7.2 ownerType / ownerId 约定

- `ownerType`:走 `attachment_type_configs.code` 白名单;前端按业务场景填(常见取值如 `member` / `certificate` 等,**仅占位示例,实际白名单见 P0-C bootstrap SOP 落地清单**)
- `ownerId`:目标业务对象的 `id`(cuid);必须存在且未软删
- 起步包不接 `POST /v2/attachments`(模式 A);前端**只走 upload-url + confirm-upload**

### 7.3 上传失败路径(文字补充 Mermaid)

| 阶段 | 典型失败 | BizCode | HTTP |
|---|---|---|---|
| `upload-url` | `ownerType` 不在白名单 | `ATTACHMENT_OWNER_TYPE_INVALID` 13010 | 400 |
| `upload-url` | `ownerId` 不存在或已软删 | `ATTACHMENT_OWNER_NOT_FOUND` 13011 | 400 |
| `upload-url` | MIME 在系统黑名单 | `ATTACHMENT_SYSTEM_MIME_BLOCKED` 13033 | 400 |
| `upload-url` | MIME 不在白名单 | `ATTACHMENT_MIME_NOT_ALLOWED` 13012 | 400 |
| `upload-url` | size 超过上限 | `ATTACHMENT_SIZE_EXCEEDED` 13013 | 400 |
| `upload-url` | 元数据含身份证号等 PII | `ATTACHMENT_PII_DETECTED` 13015 | 400 |
| `upload-url` / `confirm-upload` | RBAC 拒绝 | `RBAC_FORBIDDEN` 30100 | 403 |
| `PUT uploadUrl` 直传 | CORS / 凭证 / 网络 | (Provider 侧错误,非后端 BizCode) | 由 Provider 决定 |
| `confirm-upload` | `uploadToken` 失效 / size 不一致 | `BAD_REQUEST` 40000 | 400 |
| `confirm-upload` | 主键定位不到附件 | `ATTACHMENT_NOT_FOUND` 13001 | 404 |
| `GET /:id` | 不存在 / 无权统一返 | `ATTACHMENT_NOT_FOUND` 13001 | 404 |

### 7.4 Provider 差异(给前端预期)

- `LocalProvider`:`uploadUrl` / `accessUrl` 指向本机/反代域名;CORS 必须与前端域名匹配
- `CosProvider`(腾讯云):`uploadUrl` 指向腾讯云 COS bucket 域名;签名 URL 带过期时间(分钟级);bucket / IAM / CORS / lifecycle / SSE 由运维侧配置
- 前端**不应**依赖 URL 的具体形态;`uploadUrl` 与 `accessUrl` 都是黑盒,直接 PUT / GET 即可

---

## 8. BizCode 起步包子集

> 仅列起步包接口范围内会撞到的 BizCode;完整翻译表与前端文案映射留 [`readiness-plan P0-G`](first-release-readiness-plan.md)。
>
> **本节为起步包子集;完整 124 条 BizCode 翻译表(含 P1 后接 / 暂不接段)见 [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md)**(P0-G 撰写时为 122 条;经 P0-D PR-3 #117 新增 10005 / 10006 后实数 124)。

### 8.1 通用段(`4xxxx` / `5xxxx`)

| BizCode | code | message | HTTP |
|---|---|---|---|
| `BAD_REQUEST` | 40000 | 请求参数错误 | 400 |
| `UNAUTHORIZED` | 40100 | 未登录或登录已失效 | 401 |
| `FORBIDDEN` | 40300 | 无权限访问 | 403 |
| `NOT_FOUND` | 40400 | 资源不存在 | 404 |
| `TOO_MANY_REQUESTS` | 42900 | 请求过于频繁,请稍后再试 | 429 |
| `INTERNAL_ERROR` | 50000 | 服务器内部错误 | 500 |

### 8.2 模块业务段(只列起步包会撞的)

| 模块 | 段位 | 起步包会撞的码举例 |
|---|---|---|
| users | `100xx` / `101xx` | `LOGIN_FAILED`(10004) / `USERNAME_ALREADY_EXISTS`(10002) / `EMAIL_ALREADY_EXISTS`(10003) / `USER_NOT_FOUND`(10001) / `OLD_PASSWORD_INVALID`(10005;PUT `/users/me/password` 时 oldPassword 错)/ `NEW_PASSWORD_SAME_AS_OLD`(10006;新密码与当前密码相同) |
| organizations | `110xx` / `111xx` | `ORGANIZATION_NOT_FOUND`(11001) / `ORGANIZATION_PARENT_NOT_FOUND`(11010) / `ORGANIZATION_NODE_TYPE_INVALID`(11011) / `ORGANIZATION_ROOT_ALREADY_EXISTS`(11032) |
| dictionaries | `120xx` | 起步包只读;主要可能撞 `DICT_TYPE_NOT_FOUND`(12001) / `DICT_ITEM_NOT_FOUND`(12010) |
| attachments | `130xx` | 详见 §7.3 失败路径表 |
| members | `150xx` | `MEMBER_NOT_FOUND`(15001) / `MEMBER_NO_ALREADY_EXISTS`(15002) / `MEMBER_GRADE_CODE_INVALID`(15010) |
| member-profiles | `160xx` | `MEMBER_PROFILE_NOT_FOUND`(16001) / `MEMBER_PROFILE_ALREADY_EXISTS`(16002) / 字典字段 invalid 16010-16014 |
| member-departments | `170xx` | `MEMBER_DEPARTMENT_NOT_FOUND`(17001) / `MEMBER_DEPARTMENT_ALREADY_EXISTS`(17002) / `MEMBER_INACTIVE`(17030) / `ORGANIZATION_INACTIVE`(17031) |
| certificates | `180xx` / `181xx` | `CERTIFICATE_NOT_FOUND`(18001) / `CERTIFICATE_TYPE_CODE_INVALID`(18010) / `CERTIFICATE_SUB_TYPE_CODE_INVALID`(18011) |
| emergency-contacts | `190xx` / `191xx` | `EMERGENCY_CONTACT_NOT_FOUND`(19001) / `EMERGENCY_CONTACT_RELATION_CODE_INVALID`(19010) |
| activities | `200xx` / `201xx` | `ACTIVITY_NOT_FOUND`(20001) / `ACTIVITY_TYPE_CODE_INVALID`(20012) / `ACTIVITY_START_END_INVALID`(20015) / `ACTIVITY_STATUS_INVALID`(20030) / `ACTIVITY_NOT_PUBLIC_REGISTRATION`(20120) |
| activity-registrations | `210xx` | `ACTIVITY_REGISTRATION_NOT_FOUND`(21001) / `ACTIVITY_REGISTRATION_ALREADY_EXISTS`(21002) / `ACTIVITY_REGISTRATION_STATUS_INVALID`(21030) / `ACTIVITY_CAPACITY_EXCEEDED`(21032) |
| attendances 查看 | `220xx` | `ATTENDANCE_SHEET_NOT_FOUND`(22001) — 起步包只 GET,其它 22xxx 在 P1 |

---

## 9. dict_type key 依赖(只列 key,不列 item 内容)

> 字典 `code` 命名是前后端契约;**字典 item 真实取值由 P0-C 运维 seed,本文不列出**(沿 [`CLAUDE.md §18`](../CLAUDE.md) / 研究文档 §5.1 / R13)。

前端联调起步包内**会撞到**的 `dict_types.code`(14 个):

| code | 用途模块 | 引用字段 |
|---|---|---|
| `node_type` | organizations | `nodeTypeCode` |
| `member_grade` | members | `gradeCode` |
| `gender` | member-profiles | `genderCode` |
| `document_type` | member-profiles | `documentTypeCode` |
| `political_status` | member-profiles | `politicalStatusCode` |
| `blood_type` | member-profiles | `bloodTypeCode` |
| `work_nature` | member-profiles | `workNatureCode` |
| `emergency_relation` | emergency-contacts | `relationCode` |
| `cert_type` | certificates | `certTypeCode` |
| `cert_sub_type` | certificates | `certSubTypeCode` |
| `activity_type` | activities | `activityTypeCode` |
| `gender_requirement` | activities | `genderRequirementCode` |
| `attendance_role` | attendances(查看时显示) | `attendanceRoleCode` |
| `attendance_status` | attendances(查看时显示) | `attendanceStatusCode` |

前端从 `GET /api/v2/dict-items?dictTypeCode=<code>` 拉取候选项;不应硬编码 item code 字面值。

---

## 10. 测试账号矩阵依赖(只列角色,不列凭据)

> 真实账号 username / 初始密码由 P0-C bootstrap SOP 落地;**本文不写凭据**(沿 [`process.md §7`](process.md) 不输出 secret)。

第一版前端联调起步阶段**最少**需要的账号:

| 角色 | `users.role` | 起步包用途 | 数量 |
|---|---|---|---|
| 超级管理员 | `SUPER_ADMIN` | 全功能验证 / 管理员后台首次进入 | ≥ 1 |
| 普通管理员 | `ADMIN` | 验证 ADMIN 边界(不能管理 SUPER_ADMIN / ADMIN) | ≥ 1 |
| 队员(关联 member) | `USER` + 绑定 `memberId` | 队员侧本人接口(me / registrations / attendance-records) | ≥ 1 |
| 队员(未绑定 member) | `USER` | 验证 user 与 member 解耦行为 | 可选 |

测试账号创建流程见 P0-C bootstrap SOP;运维侧在生产环境**必须**改掉默认 `SUPER_ADMIN` 密码(沿 [`CLAUDE.md §14`](../CLAUDE.md))。

---

## 11. 前端联调包齐备判定

第一版"前端联调包"由以下文档与产物共同构成,**全部齐备**前端才宜大规模接入起步包:

- [x] **本文档**(P0-A:起步包 51 + P1 后接 42 + 第一版不接 46;P0-D PR-3 #117 后)
- [x] **P0-G** BizCode 完整翻译表 — [`first-release-bizcode-mapping.md`](first-release-bizcode-mapping.md)(#111,2026-05-17;P0-G 撰写时覆盖 122 条,P0-D PR-3 #117 新增 10005 / 10006 后实数 124,P0-D PR-4 同步)
- [x] **P0-C** bootstrap SOP — [`first-release-bootstrap-sop.md`](first-release-bootstrap-sop.md)(#113,2026-05-17;含字典 `dict_type` 清单 + 测试账号矩阵创建路径 + dev/staging/prod 三档差异 + 5 分钟 dry-run)
- [ ] **运营 / 维护者侧 SOP 执行**:按 SOP §6 / §8.2 / §9 录入字典真实 items + 三张附件配置表 + 创建测试账号矩阵(SOP 已落地,实际录入与账号创建仍待运维侧执行)
- [ ] **P0-B** 上传下载闭环验收(真实 Storage Provider 上 5 步流程跑通;沿 [`ops/cos-production-rollout-checklist.md §9`](ops/cos-production-rollout-checklist.md))

齐备前,前端可对照本文 §3 / §4 做接口契约 review 与本地 mock 联调,**但不大规模铺设业务接入**。

---

## 附录:本文不承载

| 类型 | 权威源 |
|---|---|
| 接口字段详情 / OpenAPI | [`docs/v2-api-contract.md`](v2-api-contract.md) + Swagger `/api/docs` |
| 数据模型 | [`prisma/schema.prisma`](../prisma/schema.prisma) + [`docs/v2-data-model.md`](v2-data-model.md) |
| 完整 BizCode 翻译 | P0-G(待立项)+ [`src/common/exceptions/biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) |
| 字典 item 真实取值 | P0-C bootstrap SOP(待立项)+ 运维侧 seed |
| 测试账号真实凭据 | P0-C bootstrap SOP(待立项;凭据**不进仓库**) |
| 上传下载真实 COS 凭证 / bucket | [`docs/ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md) |
| 部署 / 反代 / CORS / 域名 | [`docs/deployment.md`](deployment.md) + P0-C / P0-H |
| 错误响应详细字段 / `path` / `requestId` | [`docs/security.md`](security.md) + Swagger |
| 安全策略 / refresh token / logout | [`docs/security.md`](security.md) + P0-D / P0-E 评审 |
| 测试策略 | [`docs/testing.md`](testing.md) |
| 当前状态 / 流程制度 | [`docs/current-state.md`](current-state.md) + [`docs/process.md`](process.md) |

冲突时按本文开头冲突优先级处理;本文让步。
