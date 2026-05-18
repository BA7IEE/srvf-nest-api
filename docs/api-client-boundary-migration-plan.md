# SRVF API Client Boundary Migration Plan(分阶段迁移路线 / 设计期 v0)

> **状态**:设计期 v0(2026-05-19)。
> **配套文档**:[`docs/api-client-boundary.md`](api-client-boundary.md)(顶层规范)/ [`docs/api-client-boundary-inventory.md`](api-client-boundary-inventory.md)(现状盘点)
> **本文档不是开发执行任务卡**。每个 Phase 进入执行时,必须**单独立项**、单独评审稿、单独 PR。
> **冲突优先级**:见 [`docs/api-client-boundary.md` §0 头部](api-client-boundary.md)。

---

## 0. 总体迁移原则(Phase 1+ 全程约束)

> 这 8 条是 Phase 1 以后任何 PR 都必须满足的硬约束。

1. **不一次性重命名所有现有接口**:每个 Phase 只动一个维度
2. **不破坏现有 PC 管理后台联调口径**:Phase 0/1 期间 PC 后台前端**不需要**改任何代码
3. **不破坏现有 OpenAPI snapshot**:契约快照变更必须在 PR 内显式列出并经评审
4. **先文档锁定,再新增 App API,再逐步 deprecate 老接口**:**不**先删后建
5. **每一步必须有测试和合同更新**:E2E + contract snapshot + unit 三件套必须同步
6. **App API 优先围绕移动端真实场景**:**不**照搬后台资源接口形态;入参 DTO 严格白名单
7. **每个 Phase 完成后,docs 与代码同步落地**:`current-state.md` / handoff / CHANGELOG 三件套同步回填
8. **任何 D 档(schema / migration / 权限 / 安全 / 存储 / audit / 不可逆)操作必须降速**:沿 [`docs/process.md §4`](process.md);Phase 0/1 严格**不引入** D 档动作

---

## 1. 阶段总览

| Phase | 阶段名 | 范围 | 风险 | 产物 |
|---|---|---|---|---|
| **0** | **现状盘点 + 顶层规范锁定**(✅ 进行中) | 仅文档 | 极低 | 本仓 3 份文档 |
| **1** | **Swagger Tag 语义整理 + Public/Auth 文档别名**(规划中) | 文档 + Swagger tag 改名 + `/api/public/v1/health` 新增别名 | 低 | Tag 标签语义化 |
| **2** | **新增 `/api/app/v1/me/*` 队员端基础接口**(规划中) | 新增 App Controller(双写,不删旧) | 中 | App 端 SDK 可用 |
| **3** | **Admin API 收口 + 评估迁 `/api/admin/v1/*`**(规划中) | 评估保留 / 迁移决策 + 路径别名 | **高** | 决策稿 + 部分迁移 |
| **4** | **System API 独立 + 高危权限收紧**(规划中) | 迁 `/api/system/v1/*` + 强制 SUPER_ADMIN 短路审视 | 中 | System 端独立 |
| **5** | **清理 Mixed API + 老 `/api/v2/*` 下线评估**(规划中) | 拆 Mixed Controller / DTO + 老路径标 deprecated | **高** | 边界完成 |

> Phase 1-5 是**串行**关系;**不允许跳阶段**(如直接 Phase 5 不 Phase 1)。
> 每个 Phase 完成后必须用户拍板才进下一个 Phase。

---

## 2. Phase 0:现状盘点 + 顶层规范锁定(✅ 本轮)

### 2.1 目标

- 锁定客户端边界**目标架构** + **8 条铁律**
- 完整盘点现有 25 Controller / ~140 endpoint 的客户端归属
- 给出**分阶段迁移路线**(本文件)

### 2.2 产物

| 产物 | 文件 |
|---|---|
| 顶层规范 | [`docs/api-client-boundary.md`](api-client-boundary.md) |
| 现状盘点 | [`docs/api-client-boundary-inventory.md`](api-client-boundary-inventory.md) |
| 迁移路线 | [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md)(本文件) |
| CLAUDE.md / AGENTS.md 增补 | 新增 §19 "API Client Boundary 设计期约束"(纯增补,不改既有规则) |

### 2.3 硬约束(本 Phase 不做)

- ❌ 不改 `prisma/schema.prisma`
- ❌ 不生成 migration
- ❌ 不修改任何 Controller 路径
- ❌ 不修改任何 DTO 行为 / 字段
- ❌ 不修改任何权限标注
- ❌ 不删除接口
- ❌ 不移动 Controller 文件
- ❌ 不安装新依赖 / 修改 package.json / pnpm-lock.yaml

### 2.4 验收

- [ ] 3 份文档评审通过
- [ ] CLAUDE.md / AGENTS.md 增补段评审通过(纯增补,不修改既有规则语义)
- [ ] `git diff --stat` 仅显示 `docs/*.md` + `CLAUDE.md` + `AGENTS.md` 变化
- [ ] `find src -name "*.controller.ts"` 数量与盘点表 §1.1 完全一致(=25)
- [ ] 用户拍板进入 Phase 1

---

## 3. Phase 1:Swagger Tag 语义整理 + Public/Auth 文档别名(规划中)

### 3.1 目标

- 把现有 Swagger Tag 从"模块名"语义改为"客户端边界 - 模块"语义
- 把 `/api/health` / `/api/auth/login` 等以"文档别名"形式同时挂到 `/api/public/v1/health` / `/api/auth/v1/login`(实现上是同一个 controller handler,路径列表里**新增**一份,**不删**旧的)
- **不影响**前端联调 / 不破坏 OpenAPI snapshot(只新增 path,不删 path)

### 3.2 范围

- Swagger `@ApiTags(...)` 改为 [`docs/api-client-boundary.md §5.1`](api-client-boundary.md) 列出的目标 tag 体系
- 路径**只允许**:在原 controller 内**追加**装饰器(如 NestJS 的多 `@Controller([path1, path2])` 形式),让同一个 handler 响应两个路径
- 风险**低**:tag 改名 / 路径双写**不**破坏现有契约;PC 后台前端调旧路径仍然 200 OK

### 3.3 不做清单

- ❌ 不动 controller 文件物理位置
- ❌ 不动 DTO
- ❌ 不动权限标注
- ❌ 不动 service
- ❌ 不实现 `/api/app/v1/*` / `/api/admin/v1/*` / `/api/system/v1/*`(留给 Phase 2/3/4)
- ❌ 不删旧 path
- ❌ 不实现"多份 Swagger"(`/api-docs/app` / `/api-docs/admin` / `/api-docs/system`)— 留给后续阶段

### 3.4 验收

- [ ] 所有 25 Controller 的 `@ApiTags` 已对齐目标命名
- [ ] `/api/health` + `/api/public/v1/health` 双路径在 OpenAPI 内可见,行为完全一致
- [ ] `/api/auth/login` + `/api/auth/v1/login` 双路径在 OpenAPI 内可见
- [ ] OpenAPI snapshot diff 仅新增 path,**无**删除 / 修改
- [ ] 既有 E2E 全绿(沿 v0.14.0 base = 55 spec / 1291 用例)
- [ ] 新增 7 个 E2E:每个新别名 path 一个 smoke 用例(/api/public/v1/health* × 3 + /api/auth/v1/* × 4)

### 3.5 风险

| 风险 | 缓解 |
|---|---|
| Tag 改名导致前端 SDK 生成代码方法名变化 | 评审 PR 前先用 `gh pr diff` 看 OpenAPI snapshot,确认前端 SDK 影响面 |
| 双写 path 在 controller 装饰器层引入 BUG | 每个双写 path 加一个 smoke E2E,断言"行为一致" |
| Swagger UI 群组顺序混乱 | `apply-swagger.ts` 内 `addTag(...)` 顺序明确按 Auth / Public / App / Admin / System 排 |

---

## 4. Phase 2:新增 `/api/app/v1/me/*` 队员端基础接口(规划中)

> **Phase 2 启动前置**:[`docs/app-permission-boundary-review.md`](app-permission-boundary-review.md)(Phase 0.5 App 身份 / 权限 / 数据可见性专项评审)
> **必读**。该专项对本节 P0 接口提出 §8 重新评估建议(`me` 拆 `account`/`profile`、`me/*` 与 `my/*` 拆分、`/me/permissions` 改返 App capability、`tasks/*` 与 `managed/*` 命名空间预留),Phase 2 立项评审稿启动时**必须**先消化该专项,**不**照搬本节 P0 清单字面值。

### 4.1 目标(P0 清单,以 Phase 0.5 评审 §8 调整意见为准)

按 [`docs/api-client-boundary-inventory.md §4`](api-client-boundary-inventory.md) "App 端缺失接口清单 P0 段",新增队员端基础接口:

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

> **共 11 个 P0 接口**,实际拆分时按业务模块组织 PR,**不**一次合并。

### 4.2 范围

- **新增** App-specific Controller(如 `src/modules/users/controllers/app-me.controller.ts`)
- **新增** App-specific DTO(如 `src/modules/users/dto/app/app-my-user.dto.ts`),严格白名单
- **复用** 既有 service 业务能力(`users.service.ts` / `activities.service.ts` 等)
- **不删** 旧 path;`/api/users/me` 等沿现状继续工作
- 每个 App API 必须:
   - currentUser 来自 token,**禁止**前端传 memberId / userId
   - 严格 DTO 白名单
   - E2E 用例覆盖典型成功 / 失败 / 边界
   - 与 Admin DTO 类型隔离(不复用类型)

### 4.3 PR 拆分建议

| PR | 范围 | 依赖 |
|---|---|---|
| PR #N1 | `GET /api/app/v1/me` + DTO + E2E | Phase 1 完成 |
| PR #N2 | `PATCH /api/app/v1/me/profile` | N1 |
| PR #N3 | `PUT /api/app/v1/me/password`(P0-D 沿用全部铁律) | N1 + Phase 1 限流 |
| PR #N4 | `GET /api/app/v1/me/permissions`(沿现状 RBAC service) | N1 |
| PR #N5 | `GET /api/app/v1/activities` + `GET /:id`(App 视角 DTO) | N1 |
| PR #N6 | `/api/app/v1/me/registrations*` 4 个 | N1 + N5 |
| PR #N7 | `GET /api/app/v1/me/attendance-records` | N1 |
| PR #N8 | `POST /api/app/v1/me/activities/:id/registrations` | N5 + N6 |

> 每个 PR **不要超过** 1 个 endpoint 系列(典型 1-2 个 endpoint + DTO + E2E + Swagger);**不超过** 500 lines diff。

### 4.4 不做清单

- ❌ 不在 Phase 2 删任何 `/api/v2/users/me/*` 旧路径
- ❌ 不动 `/api/users/me` 三个老路径
- ❌ 不动 P0-D 旧 `PUT /api/users/me/password`(沿现状 + 新增 `/api/app/v1/me/password`)
- ❌ 不动 Admin 接口
- ❌ 不动 System 接口
- ❌ 不动 schema / migration
- ❌ 不动权限点 seed / 不新增 permission code

### 4.5 验收

- [ ] 11 个 P0 App 接口全部通过 E2E
- [ ] 11 个 App DTO 全部与 Admin DTO 类型隔离(`AppMyUserResponseDto` 与 `UserResponseDto` 不共字段类型)
- [ ] 既有 55 E2E spec 全绿
- [ ] OpenAPI snapshot diff 仅新增,无删除 / 修改
- [ ] P0-E refresh token / P0-D 改密铁律全部继承
- [ ] 用户拍板进入 Phase 3

### 4.6 风险

| 风险 | 缓解 |
|---|---|
| App DTO 与 Admin DTO 漂移 | 评审 PR 时 grep "extends MemberResponseDto" / "extends UserResponseDto" 之类的继承关系,**禁止**继承 |
| Service 方法被 App + Admin 两端调,字段裁剪逻辑漂移 | service 内一律返回完整 entity;字段裁剪在 controller / DTO 转换层做 |
| `/api/users/me` 与 `/api/app/v1/me` 同时存在,前端不知该用哪个 | OpenAPI 旧 path 加 `@ApiDeprecated`(Phase 5 才动);Phase 2 不标 deprecated |
| 测试覆盖率倒退 | 每 PR 至少 +3-5 个 E2E spec |

---

## 5. Phase 3:Admin API 收口 + 新接口走 `/api/admin/v1/*`(方案 C 已拍板)

### 5.1 已拍板:方案 C(2026-05-19)

> **决策**:**采纳方案 C**(`Admin Legacy + 新接口走新前缀` 混合模式)。
> **不再**作为悬而未决项;方案 A / B 仅保留为"历史备选"参考。

```txt
旧 /api/v2/*        长期保留,语义定义为 Admin Legacy API
                    不主动 deprecated,不强制迁移,不进行大面积老接口双写

新 App API          默认使用 /api/app/v1/*
新 System API       默认使用 /api/system/v1/*
新 Admin API        默认使用 /api/admin/v1/*
                    新立项的 Admin 接口才走新前缀,旧接口不动
```

**核心铁律**:

- **`/api/v2/*` ≡ Admin Legacy**,长期可用,**不**标 deprecated
- **PC 管理后台联调口径不破坏**:前端不需要因 Phase 3 改任何 URL
- **不做大面积老接口双写**:仅新接口落 `/api/admin/v1/*`;旧接口**不**自动迁
- **未来若个别老接口确需迁(如 P0-* 联调遇到瓶颈)**,单独立项,**不**作为 Phase 3 整体目标

### 5.2 决策理由

- **零迁移成本**:PC 后台前端无需改 URL,联调口径稳定
- **新接口语义清晰**:Phase 3 后新立项的 Admin 接口走 `/api/admin/v1/*`,路径段直观体现客户端边界
- **OpenAPI snapshot 不翻倍**:旧 path 不双写,新接口才新增
- **方案 B 双写陷阱被规避**:旧 `/api/v2/*` 不强制双写,避免"老 path 与新 path 行为不一致"风险
- **方案 A 缺点(路径段语义不直观)在新接口处被解决**:未来新接口的客户端归属一目了然
- **与 Phase 2 App API(`/api/app/v1/*`)、Phase 4 System API(`/api/system/v1/*`)前缀风格一致**:三段并列,语义对称

### 5.3 历史备选方案(仅参考,不采纳)

> 仅作为决策过程的备忘,**不**作为 Phase 3 执行范围。

| 方案 | 描述 | 不采纳理由 |
|---|---|---|
| 方案 A | 保留 `/api/v2/*` 作为 Admin API,**不**实现 `/api/admin/v1/*` | 长期路径段与客户端边界不对齐;新接口仍要继承"语义不直观"的问题 |
| 方案 B | 全量双写 `/api/v2/*` + `/api/admin/v1/*`,老 path 标 `@ApiDeprecated` | 双写成本高;OpenAPI snapshot 翻倍;PC 后台前端最终要切换;双写漏洞难管 |
| ✅ 方案 C | 旧 `/api/v2/*` 长期保留;新接口走 `/api/admin/v1/*` | **已采纳**(2026-05-19) |

### 5.4 范围

- 后续新立项的 Admin 接口 controller 装饰器**默认**用 `@Controller('admin/v1/...')`
- 旧 `@Controller('v2/...')` 装饰器**全部保留**,**不**新增 `admin/v1/` 别名
- **不**修改任何现有 controller 文件路径 / DTO / 权限标注

### 5.5 不做清单

- ❌ 不大面积双写老 `/api/v2/*` 路径
- ❌ 不标 `/api/v2/*` 为 deprecated
- ❌ 不动 Service / DTO
- ❌ 不动权限点
- ❌ 不删 `/api/v2/*`
- ❌ 不强制 PC 后台前端迁 URL
- ❌ Phase 3 不立项"老接口批量迁 `/api/admin/v1/*`"任务(若个别接口需迁,单独立项)

### 5.6 验收

- [ ] 本节方案 C 已明确写入本文档,A/B 仅作历史备选保留
- [ ] [`docs/api-client-boundary.md`](api-client-boundary.md) §8 FAQ Q2 与本节一致
- [ ] [`docs/api-client-boundary-inventory.md`](api-client-boundary-inventory.md) §9 "暂不动的接口"与方案 C 一致
- [ ] Phase 3 启动时,**新立项**的 Admin 接口确认走 `/api/admin/v1/*`(由各任务卡评审稿验收)

### 5.7 风险

| 风险 | 缓解 |
|---|---|
| 长期存在 `/api/v2/*`(Admin Legacy)+ `/api/admin/v1/*`(Admin New)两套前缀,前端混淆 | 文档明确语义:`/api/v2/*` ≡ Admin Legacy;新接口走新前缀;Swagger Tag 配合分组("Admin Legacy" / "Admin" 区分) |
| 个别 `/api/v2/*` 老接口因业务需要必须迁 | 不在 Phase 3 整体范围内;**单独立项**,**单 PR 单接口**双写 + 评审 |
| 后续若大量新 Admin 接口走 `/api/admin/v1/*`,Admin Legacy 越来越"老" | 接受;Admin Legacy 是稳定历史,不是技术债 |

---

## 6. Phase 4:System API 独立 + 高危权限收紧(规划中)

### 6.1 目标

将以下能力归入 System API(沿 [`docs/api-client-boundary-inventory.md §7`](api-client-boundary-inventory.md) 的 System 清单):

```txt
permissions      → /api/system/v1/permissions/*
roles            → /api/system/v1/roles/*
role-permissions → /api/system/v1/roles/:id/permissions/*
user-roles       → /api/system/v1/users/:userId/roles/*
rbac/reload      → /api/system/v1/rbac/reload
dictionaries     → /api/system/v1/dict-{types,items}/*
audit-logs       → /api/system/v1/audit-logs/*
storage-settings → /api/system/v1/storage-settings/*
attachment-configs → /api/system/v1/attachment-*-configs/*
contribution-rules → /api/system/v1/contribution-rules/*(2026-05-19 拍板 System)
sms-settings     → 未实现
app-config       → 未实现
message-templates → 未实现
```

### 6.2 范围

- 把上述 controller 的 `@Controller(...)` 前缀**追加**(双写)`system/v1/...`
- 同时强制审视权限点配置:
   - System 接口默认只 `SUPER_ADMIN` 或显式 `rbac.can('xxx.system.xxx')` 可访问
   - 现有非 SUPER_ADMIN 短路接口必须显式绑权限点
   - `storage-settings` / `audit-logs` / `permissions` / `rbac/reload` 等极高危接口必须 audit_logs 全覆盖

### 6.3 不做清单

- ❌ 不动 Service
- ❌ 不动 DTO
- ❌ 不动 schema / migration
- ❌ 不新增业务模块
- ❌ 不实现 `sms-settings` / `app-config` / `message-templates` 等未实现接口(留给业务方立项)

### 6.4 验收

- [ ] 所有 System 接口双写完成(`/api/v2/*` + `/api/system/v1/*`)
- [ ] 所有 System 接口权限点已审视、显式绑定
- [ ] 极高危 4 类(storage / audit / permission / rbac reload)audit_logs 全覆盖
- [ ] 既有 E2E 全绿 + 新增双路径 smoke E2E

### 6.5 风险

| 风险 | 缓解 |
|---|---|
| 双写 path 导致 OpenAPI snapshot 翻倍 | 接受;`/api-docs/system` 独立文档延后到 Phase 5+ |
| 权限点收紧导致联调失败 | 收紧前先在评审稿对齐 PC 后台前端,提前下发权限点 seed |

---

## 7. Phase 5:清理 Mixed API + 老 `/api/v2/*` 下线评估(规划中)

### 7.1 目标

逐步拆掉既服务后台又服务移动端的接口,把 Mixed API 拆完:

| 模块 | 拆分动作 |
|---|---|
| **users** | 拆 `/me` × 3 与 `/:id` × 8 到不同 Controller(物理拆分);DTO 拆 App + Admin |
| **activities** | `list` / `findOne` 拆 App + Admin 两份(物理拆分);DTO 拆 |
| **attachments** | 拆 `/me/uploaded` 与 admin 操作到不同 Controller;DTO 拆 |
| **activity-registrations** | DTO 拆 App + Admin(controller 已分) |
| **attendances** | DTO 拆 App + Admin(controller 已分) |
| **certificates** | App 视角 `/me/certificates` 新增 |
| **member-profiles** + **emergency-contacts** | App 视角 `/me/*` 新增 |
| **rbac** | 拆 `/me/permissions`(App) + `/reload`(System)到不同 Controller |

### 7.2 范围

- Mixed Controller 物理拆分
- App / Admin DTO 类型隔离
- 老 `/api/v2/users/me/*` 等过渡路径标 `@ApiDeprecated`
- 老 `/api/v2/*` 资源路径**评估**下线时机(可能拖到 Phase 6+ 或长期不下线)

### 7.3 不做清单

- ❌ 不在 Phase 5 删任何 `/api/v2/*` 路径
- ❌ 不动 schema
- ❌ 不在 Phase 5 内强制 PC 后台前端迁路径

### 7.4 验收

- [ ] [`docs/api-client-boundary-inventory.md §3`](api-client-boundary-inventory.md) Mixed 清单从 8 项收口到 0 项
- [ ] App / Admin DTO 类型隔离覆盖率 100%
- [ ] 老路径标 deprecated 完成

### 7.5 风险

| 风险 | 缓解 |
|---|---|
| Controller 物理拆分破坏 service 依赖注入 | 拆分前先把 service 公共方法用 `export const ... = service.xxx` 暴露,跨 controller 复用 |
| DTO 类型隔离导致大量代码改动 | 每模块单独 1 PR,**禁止**一次拆完所有模块 |
| 老 path 被外部已知客户端依赖 | 评估前先 access log 统计旧 path 真实调用占比;占比为 0 才提议下线 |

---

## 8. 各 Phase 时间预估(参考)

| Phase | 预估工作量 | 时间 |
|---|---|---|
| Phase 0 | 3 份文档 + 增补 | **本轮 1 个 PR** |
| Phase 1 | Tag 改名 + 双 path 别名 + smoke E2E | 1-2 PR / ~1 周 |
| Phase 2 | 11 个 P0 App 接口 + DTO + E2E | 7-8 PR / ~3-4 周 |
| Phase 3 | 方案 C 已锁(2026-05-19);新立项 Admin 接口走 `/api/admin/v1/*`,旧 `/api/v2/*` 不动 | 0 显式 PR(单立项时同步) |
| Phase 4 | 12 个 System Controller 双写 + 权限收紧 | 4-6 PR / ~2-3 周 |
| Phase 5 | Mixed 拆分 8 模块 + DTO 隔离 | 8-12 PR / ~6-8 周 |

> 时间预估**不**作为承诺,只用于规划。实际节奏取决于业务方拍板速度与并行 P0-* 优先级。

---

## 9. 通用质量门槛(每个 Phase 都必须满足)

每个 Phase 完成后,**必须**满足以下门槛(沿 [`docs/srvf-foundation-baseline.md §13`](srvf-foundation-baseline.md) 验收门槛):

- [ ] `pnpm lint` 通过
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿(unit;`package.json` 实际脚本名为 `test`,**不是** `test:unit`)
- [ ] `pnpm test:e2e` 全绿
- [ ] `pnpm test:contract` 全绿
- [ ] OpenAPI snapshot diff 经评审
- [ ] Swagger UI `/api/docs` 实际打开验收
- [ ] 涉及 D 档操作时:`prisma migrate dev --create-only` 先生成 SQL,贴回对话等用户拍板再 apply(沿 §0)
- [ ] [`docs/current-state.md`](current-state.md) + [`CHANGELOG.md`](../CHANGELOG.md) + 对应 handoff 同步回填

---

## 10. 下一步动作(给用户的决策点)

### 10.1 已拍板决策(2026-05-19)

- ✅ `contribution-rules` 归 **System**(沿 [§6.1](#6-phase-4system-api-独立--高危权限收紧规划中) + [`docs/api-client-boundary-inventory.md §2.25`](api-client-boundary-inventory.md))
- ✅ Phase 3 路径策略 = **方案 C**(`/api/v2/*` 长期保留为 Admin Legacy;新接口走 `/api/{app,admin,system}/v1/*`;不双写不 deprecated;沿 [§5](#5-phase-3admin-api-收口--新接口走-apiadminv1方案-c-已拍板))

### 10.2 仍待用户拍板

1. **是否接受顶层规范 [`docs/api-client-boundary.md`](api-client-boundary.md)** 中的目标架构与 8 条铁律
2. **是否接受本文档 Phase 1-5 的阶段划分**
3. **Phase 1 是否立即立项**,还是先继续 P0-F (RBAC 收紧) 等其它优先级任务 — 详细执行评审稿见 [`docs/api-client-boundary-phase-1-review.md`](api-client-boundary-phase-1-review.md)
4. **Phase 1 拆分 1A / 1B 是否接受**(Tag 整理与 path alias 分两 PR 实施)

> Phase 1+ **不**由 AI 自行启动;必须用户在 [`docs/process.md`](process.md) 流程内单独立项。

---

> **本迁移路线生效时间**:2026-05-19(设计期 v0)。
> 任何修订必须经用户拍板,记录修订时间与变更摘要。
