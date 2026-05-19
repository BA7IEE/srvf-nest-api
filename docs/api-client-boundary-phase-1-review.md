# Phase 1 执行评审稿:Swagger Tag 整理 + Public/Auth v1 path alias

> **状态**:**执行评审稿 v0**(2026-05-19)
> **配套文档**:
>   - [`docs/api-client-boundary.md`](api-client-boundary.md)(顶层规范)
>   - [`docs/api-client-boundary-inventory.md`](api-client-boundary-inventory.md)(现状盘点)
>   - [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md)(分阶段路线)
> **冲突优先级**:见 [`docs/api-client-boundary.md` 头部](api-client-boundary.md);本评审稿优先级**最低**,冲突让步给上方。
> **生效条件**:本评审稿**经用户拍板**后,Phase 1A / 1B 才允许各自单独立项 + 单独 PR。
> **本评审稿不是开发授权**:即使评审通过,具体 PR 实施时仍需按 [`docs/process.md §3-§4`](process.md) 档位判定。

---

## 0. TL;DR

Phase 1 把 25 个 Controller 的 `@ApiTags` 改名为"客户端边界 - 模块"语义(Phase 1A),同时为 `/api/health/*` 与 `/api/auth/*` 加 `/api/public/v1/*` 与 `/api/auth/v1/*` 路径别名(Phase 1B)。
**必须拆成两个 PR**,因为它们是**不同档位**:
- **Phase 1A** = **C 档**(改 `@ApiTags` 改了 OpenAPI snapshot 里 `tags` 字段;不增删 path)
- **Phase 1B** = **C 档**(新增 alias path 是 API 合同变更;旧 path 严格不动)

**绝对禁止**把 Phase 1 误判为 A 档 docs-only 然后跳过 contract / e2e 检查直接 commit。

---

## 1. Phase 1 档位判断

### 1.1 档位归属表

| Phase | 改动内容 | 档位 | 必跑检查 | 用户拍板 |
|---|---|---|---|---|
| **Phase 1A** | 改 25 Controller 的 `@ApiTags(...)` 命名 + `apply-swagger.ts` 内 `addTag(...)` 顺序;**不**新增 path / **不**改 path / **不**改 DTO / **不**改 Guard | **C 档**(OpenAPI snapshot 内 `tags` 字段变化) | `pnpm lint` + `pnpm typecheck` + `pnpm test` + `pnpm test:contract` + `pnpm test:e2e` | ✅ 单 PR 评审 |
| **Phase 1B** | 新增 `/api/public/v1/health*` × 3 与 `/api/auth/v1/*` × 4 路径别名(同 handler 双 path);**不**删旧 path / **不**改旧 path response schema / **不**改 DTO / **不**改 Guard | **C 档**(API 合同变更:新增 endpoint path) | A 档全部 + `pnpm test:contract` + `pnpm test:e2e` + 新增 alias smoke E2E | ✅ 单 PR 评审 |

### 1.2 档位判断铁律

> **必读**:[`docs/process.md §3`](process.md) — A/B/C/D/E 档定义。

- **Phase 1 不是 A 档 docs-only**。原因:
   1. 修改 `*.controller.ts` 的 `@ApiTags(...)` 是**代码变动**(`.ts` 文件改),不是纯文档
   2. OpenAPI snapshot 是仓库内构建产物,tag 改名会让 snapshot diff 出现
   3. 沿 [`docs/process.md §3` 档位归属规则](process.md):"一个 PR 同时改 `.md` + `.ts` 实现 → 按更高档位算";Phase 1 不存在纯 `.md` 改动情形

- **Phase 1 不是 B 档**。原因:
   1. B 档要求"无 OpenAPI 合同变化",而 Phase 1A 改 Tag、Phase 1B 加 path,**都会**改 OpenAPI snapshot
   2. Phase 1B 新增 path 即"新 endpoint"(就算 handler 复用旧的,OpenAPI 里就是新 path);沿 process.md C 档定义"新 endpoint"

- **Phase 1 不是 D 档**。原因:
   1. 不动 `prisma/schema.prisma`
   2. 不动 migration / permission seed / Role enum
   3. 不动鉴权 / 存储 / 凭证 / audit / 安全策略
   4. 不动 `package.json` 依赖

- **Phase 1 不是 E 档**。原因:不涉及 release / handoff / tag / version bump。

### 1.3 OpenAPI snapshot 影响预期

> 实施 PR 时必须在 description 内显式列出 snapshot diff 摘要。

| Phase | snapshot 预期 diff | 禁止出现的 diff |
|---|---|---|
| **Phase 1A** | `tags[*].name` 与 `paths[*][*].tags` 名称变化;Tag 在 `tags[]` 数组中的顺序变化 | `paths[*]` 键新增 / 删除 / 重命名;任何 `paths[*][*].requestBody` 或 `responses` 内字段变化 |
| **Phase 1B** | `paths` 内**新增** `/api/public/v1/health` × 3 + `/api/auth/v1/login` / `refresh` / `logout` / `logout-all` × 4 共 **7 个新 path** key | 任何旧 path 键删除 / 重命名 / response schema 字段变化 / request DTO 字段变化 |

---

## 2. Phase 1 推荐拆分

### 2.1 为什么必须拆 1A / 1B 两个 PR

1. **Tag 改名**影响整个 OpenAPI 文档分组语义,**path alias** 影响路径合同 — 两者审查重点不同
2. PR diff 控制在可审查范围(单 PR < 500 行)
3. 回退粒度细化:1A 失败不影响 1B,反之亦然
4. 沿 [`docs/process.md §4` D 档降速规则](process.md) 与 [`docs/api-client-boundary-migration-plan.md §0` 总体迁移原则 #8](api-client-boundary-migration-plan.md):"禁止在一次 PR 内同时做路径迁移 + 权限重构 + DTO 重构"— Phase 1A / 1B 同理,**不混档**

### 2.2 Phase 1A:Swagger Tag 语义整理

#### 2.2.1 范围

- **修改** 25 个 `*.controller.ts` 的 `@ApiTags(...)` 参数为 [`docs/api-client-boundary.md §5.1`](api-client-boundary.md) 列出的目标 tag 名称
- **修改** [`src/bootstrap/apply-swagger.ts`](../src/bootstrap/apply-swagger.ts)(若存在 tag 显式排序逻辑)的 `addTag(...)` 顺序,按 Auth / Public / App / Admin / System 分组排
- **同步** 各 controller 文件顶部注释中提到的 tag 名称(若有)

#### 2.2.2 严格不做清单(Phase 1A 内)

- ❌ 不新增 path
- ❌ 不改 path
- ❌ 不改 DTO(任何字段不动)
- ❌ 不改 `@Roles(...)` / `@Public()` / `@RequirePermission(...)` / RBAC `rbac.can(...)`
- ❌ 不改 Guard
- ❌ 不动 service
- ❌ 不动 Prisma / migration
- ❌ 不新增 / 删除 controller 文件
- ❌ 不移动 controller 文件物理位置
- ❌ 不实现多份 Swagger(`/api-docs/app` 等)
- ❌ 不标记旧 path 为 `@ApiDeprecated`

#### 2.2.3 Tag 命名映射(参考 — 实施 PR 时再次对齐 [`docs/api-client-boundary.md §5.1`](api-client-boundary.md))

| 现有 `@ApiTags` | 目标 `@ApiTags` |
|---|---|
| `auth` | `Auth` |
| `health` | `Public` |
| `users`(`/me` 3 个) | `App - Me`(注:同 controller 内分两个 tag 需评估是否需要 NestJS 多 tag 写法支持) |
| `users`(`/:id` 8 个) | `Admin - Users` |
| `members` | `Admin - Members` |
| `member-profiles` | `Admin - Member Profiles` |
| `emergency-contacts` | `Admin - Emergency Contacts` |
| `member-departments` | `Admin - Member Departments` |
| `certificates` | `Admin - Certificates` |
| `activities` | `Admin - Activities`(注:`list` / `findOne` 含 USER 角色,实施 PR 时评估是否拆同 controller 不同 tag) |
| `activity-registrations`(admin block) | `Admin - Registrations` |
| `activity-registrations`(me block) | `App - Registrations` |
| `attendances`(admin block × 2) | `Admin - Attendance` |
| `attendances`(me block) | `App - Attendance` |
| `organizations` | `Admin - Organizations` |
| `attachments`(`/me/uploaded`) | `App - Attachments`(或 `App - Me - Attachments`) |
| `attachments`(其他) | `Admin - Attachments` |
| `dictionaries` | `System - Dictionaries` |
| `permissions` | `System - Permissions` |
| `rbac-roles` | `System - Roles` |
| `role-permissions` | `System - Role Permissions` |
| `user-roles` | `System - User Roles` |
| `rbac`(`/me/permissions`) | `App - Me`(沿 [`docs/api-client-boundary.md §8 Q6`](api-client-boundary.md)) |
| `rbac`(`/reload`) | `System - RBAC` |
| `audit-logs` | `System - Audit Logs` |
| `storage-settings` | `System - Storage Settings` |
| `attachment-configs`(3 controller) | `System - Attachment Configs` |
| `contribution-rules` | `System - Contribution Rules`(沿 2026-05-19 拍板归 System) |

> **实施提示**:一个 controller 内不同 endpoint 用不同 tag,需评估 `@nestjs/swagger` 是否支持 method 级 `@ApiTags(...)` 覆盖。若不支持,**Phase 1A 内不强行拆**,留给 Phase 2/5 物理拆 controller 时再分。

#### 2.2.4 PR 描述模板(Phase 1A)

```markdown
## Phase 1A: Swagger Tag Semantic Rename

档位:**C 档**(沿 docs/api-client-boundary-phase-1-review.md §1.1)

## 范围
- 修改 25 个 *.controller.ts 的 @ApiTags(...)
- 修改 src/bootstrap/apply-swagger.ts tag 顺序

## 不做
- 不增删 path / 不改 DTO / 不改 Guard / 不改 service / 不动 schema / 不实现多份 Swagger

## 验收命令
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm test:e2e

## OpenAPI snapshot diff 摘要
- `tags[*].name` 改名 X 项
- `paths[*][*].tags` 内引用同步改名
- `paths` 内 key 数量不变(=N)
- 任何 path / requestBody / responses schema 字段变化:**0**

## 回退方案
git revert 即可。Tag 名称回到原状不影响接口行为。
```

### 2.3 Phase 1B:Public/Auth v1 path alias

#### 2.3.1 范围

- **新增** `/api/public/v1/health` / `/api/public/v1/health/live` / `/api/public/v1/health/ready` × 3
- **新增** `/api/auth/v1/login` / `/api/auth/v1/refresh` / `/api/auth/v1/logout` / `/api/auth/v1/logout-all` × 4
- 实现方式:**同 handler 双 path** — 在现有 controller 上**追加**装饰器(NestJS `@Controller([path1, path2])` 数组形式或在 handler 上加 `@Get('alias-path')` 第二装饰器),让同一 handler 响应两个路径
- **新增** 7 个新 alias path 的 smoke E2E,每个断言"行为等价于旧 path"
- **不删** 任何旧 path
- **不改** 旧 path 的 response schema / DTO / Guard

#### 2.3.2 严格不做清单(Phase 1B 内)

- ❌ 不删 `/api/health` / `/api/health/live` / `/api/health/ready`
- ❌ 不删 `/api/auth/login` / `/api/auth/refresh` / `/api/auth/logout` / `/api/auth/logout-all`
- ❌ 不改任何旧 path 的 response schema 字段
- ❌ 不改任何旧 path 的 DTO 字段(`LoginDto` / `RefreshTokenDto` / `LogoutDto` zero drift,沿 [`CLAUDE.md §9 P0-E 子节`](../CLAUDE.md))
- ❌ 不改 `@Public()` / `@Roles(...)` / `@LoginThrottle()` / `@RefreshThrottle()` / `@PasswordChangeThrottle()`
- ❌ 不实现 `/api/app/v1/*` / `/api/admin/v1/*` / `/api/system/v1/*`
- ❌ 不拆 DTO
- ❌ 不拆 Controller 文件
- ❌ 不改权限
- ❌ 不动 Prisma / migration
- ❌ 不标记旧 path 为 `@ApiDeprecated`(沿 Phase 3 方案 C:旧 path 不主动 deprecated)
- ❌ 不动 `setGlobalPrefix('/api')`
- ❌ 不实现多份 Swagger 拆分

#### 2.3.3 Smoke E2E 要求

为 7 个 alias path 各加 1 个 smoke 用例,**最少**断言:

| Path | smoke 断言 |
|---|---|
| `GET /api/public/v1/health` | HTTP 200 + 响应体 `{ code: 0, message: 'ok', data: { status: 'ok' } }`,与 `GET /api/health` 等价 |
| `GET /api/public/v1/health/live` | HTTP 200 + 响应体形态等价于 `GET /api/health/live` |
| `GET /api/public/v1/health/ready` | HTTP 200(DB 连通)+ 响应体形态等价于 `GET /api/health/ready` |
| `POST /api/auth/v1/login` | 正常 LoginDto 入参返 HTTP 200 + 含 `accessToken` / `refreshToken` / `refreshExpiresAt`;`@LoginThrottle()` 生效(沿 P0-E 限流测试) |
| `POST /api/auth/v1/refresh` | 正常 refresh token 入参返 HTTP 200 + rotation 后新 token;`@RefreshThrottle()` 生效 |
| `POST /api/auth/v1/logout` | 幂等返 HTTP 200;`@Public()` 生效 |
| `POST /api/auth/v1/logout-all` | 需 access token 才能调;返 HTTP 200 + `{ revokedCount: number }` |

**禁止**复制旧 path 的全套 E2E(成功 + 失败 + 边界 + 限流)到新 path —— Phase 1B 仅 smoke 验证别名生效,**深度行为**由旧 path 既有 E2E 保证(因为 handler 是同一个)。

#### 2.3.4 实施细节(参考,不锁实现)

NestJS 11 支持以下两种"同 handler 双 path"实现:

**方式 A:Controller 级数组前缀**

```typescript
@Controller(['health', 'public/v1/health'])
export class HealthController { ... }
```

> 风险:Controller 级数组前缀对所有 method 生效;若 controller 内有 method 不需要双 path,这种方式不灵活。

**方式 B:method 级多装饰器**

```typescript
@Public()
@Get('login')
@Post('v1/login')   // 不能这样写,@Get/@Post 装饰器不能堆叠改 method
```

> 不可行。NestJS 不允许同一 handler 同时被 `@Get` 和 `@Post` 装饰。

**方式 C:method 级数组路径(推荐)**

```typescript
@Public()
@Post(['login', 'v1/login'])  // 一个 method 响应两个 path
login(...) { ... }
```

> NestJS 11 支持 `@Post([...])`(若版本支持)。实施 PR 启动前**必须**先 grep 现有代码确认支持。

**实施 PR 启动前必须先决定**:方式 A 还是 C。本评审稿**不**锁实现方式;PR 描述里必须明确并附 1 个 method 级 smoke 验证。

#### 2.3.5 PR 描述模板(Phase 1B)

```markdown
## Phase 1B: Public/Auth v1 Path Alias

档位:**C 档**(沿 docs/api-client-boundary-phase-1-review.md §1.1)

## 范围
- 新增 7 个 alias path(/api/public/v1/health* × 3 + /api/auth/v1/* × 4)
- 实现方式:[方式 A / 方式 C — 选择并说明理由]
- 新增 7 个 smoke E2E

## 严格不做
- 不删任何旧 path
- 不改任何旧 path 的 response / DTO / Guard
- 不实现 /api/app/v1/* / /api/admin/v1/* / /api/system/v1/*
- 不动 schema / migration

## 验收命令
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm test:e2e

## OpenAPI snapshot diff 摘要
- 新增 path:`/api/public/v1/health`, `/api/public/v1/health/live`, `/api/public/v1/health/ready`, `/api/auth/v1/login`, `/api/auth/v1/refresh`, `/api/auth/v1/logout`, `/api/auth/v1/logout-all`(共 7 个)
- 删除 path:**0**
- 修改 path response / request schema:**0**
- 修改 Guard / `@Public()` / `@Roles(...)`:**0**

## E2E 覆盖
- 旧 path 既有 E2E:**0 修改**,**全绿**
- 新增 7 个 alias smoke E2E:全绿

## 回退方案
git revert 即可。删除新增 alias path 与对应 E2E,不影响任何旧 path。
```

---

## 3. Phase 1 不做清单(汇总)

> 横跨 1A + 1B 的"绝对不做"。

- ❌ 不实现 `/api/app/v1/*`(留给 Phase 2)
- ❌ 不实现 `/api/admin/v1/*`(留给 Phase 3 — 沿方案 C,新 Admin 接口立项时才走新前缀)
- ❌ 不实现 `/api/system/v1/*`(留给 Phase 4)
- ❌ 不拆 DTO(留给 Phase 2 新增 App DTO + Phase 5 拆 Admin DTO)
- ❌ 不拆 controller 文件物理位置(留给 Phase 5)
- ❌ 不改权限(沿 P0-F RBAC 收紧的独立通道)
- ❌ 不动 `prisma/schema.prisma`
- ❌ 不生成 migration
- ❌ 不标记旧接口 `@ApiDeprecated`(沿 Phase 3 方案 C:旧 path 长期保留)
- ❌ 不实现多份 Swagger(`/api-docs/app` / `/api-docs/admin` / `/api-docs/system`;留给 Phase 1 末期或 Phase 4)
- ❌ 不动 `apply-global-setup.ts` 的 `setGlobalPrefix('/api')`
- ❌ 不引入新依赖
- ❌ 不修改 `package.json` / `pnpm-lock.yaml`

---

## 4. Phase 1 验收命令

> **实际脚本名以 [`package.json`](../package.json) 为准**(2026-05-19 仓库 HEAD 验证)。

```bash
# 1. 静态检查
pnpm lint
pnpm typecheck

# 2. 单元测试(unit;package.json 实际脚本名为 test,不是 test:unit)
pnpm test

# 3. 契约测试(OpenAPI snapshot)
pnpm test:contract

# 4. E2E 测试(含新增 alias smoke E2E,Phase 1B 才有新增)
pnpm test:e2e

# 5. 启动服务实际看 Swagger UI(B 档手工验证;沿 V1.1 §17.10 B 档)
pnpm start
# 浏览器打开:
#   http://localhost:3000/api/docs
#   http://localhost:3000/api/docs-json
# 验证:
#   - Tag 分组按 Auth / Public / App / Admin / System 排序(1A)
#   - 新 alias path 在文档中可见(1B)
#   - 旧 path 仍可见、行为不变(1A + 1B)
```

**门槛**:任一未通过 → **不算完成**,**不能 commit**,**不能向用户报告"任务完成"**。

---

## 5. OpenAPI diff 验收规则

### 5.1 Phase 1A snapshot diff 验收

| 允许 | 禁止 |
|---|---|
| `tags[*].name` 改名 | `paths` key 数量变化 |
| `tags[]` 数组中元素顺序变化 | 任何 `paths[*][*].requestBody` 字段变化 |
| `paths[*][*].tags` 引用同步改名 | 任何 `paths[*][*].responses` 字段变化 |
| `paths[*][*].summary` 微调以匹配新 tag 语义(可选) | `paths[*][*].operationId` 变化(操作 ID 与 SDK 生成代码绑定) |

**实施 PR 必须在描述里列出 snapshot diff 摘要**(沿 §2.2.4 模板)。
**评审拒绝信号**:snapshot diff 出现"路径键消失"或"responses 字段消失" → 立即停下,**不**合并。

### 5.2 Phase 1B snapshot diff 验收

| 允许 | 禁止 |
|---|---|
| 新增 7 个 path key(沿 §2.3.5 列出) | 任何旧 path key 删除 |
| 新增 path 的 schema **等价于**对应旧 path | 任何旧 path response schema 字段变化 |
| 新增 path 的 `tags` 字段引用 Phase 1A 整理后的 tag | 任何旧 path `requestBody` DTO 字段变化 |
| 新增 path 出现在 `paths[*][*].operationId` 中(NestJS 自动生成) | 任何旧 path `@Public()` / `@Roles(...)` 装饰器引发的 `security` 字段变化 |

**实施 PR 必须验证**:旧 path 的 OpenAPI fragment 与改造前**逐字相等**(snapshot diff 工具如 `jq` / `openapi-diff` 验证)。

### 5.3 snapshot diff 报告格式

PR 描述里**强制**写以下表格(沿 §2.2.4 / §2.3.5 模板):

```markdown
## OpenAPI snapshot diff 摘要

- 新增 path:[完整列表 或 "无"]
- 删除 path:[完整列表 或 "无"]
- 改名 tag:[完整映射 或 "无"]
- 修改 path 内字段:[详细 diff 或 "无"]
- 修改 path Guard 引发的 security 字段变化:[详细 diff 或 "无"]
```

---

## 6. 回退方案

### 6.1 Phase 1A 回退

**触发条件**:
- snapshot diff 出现意外的 path 增删
- Swagger UI 启动后无法渲染
- 既有 E2E 因 tag 引用错误失败

**回退步骤**:
1. `git revert <Phase 1A PR commit>`
2. 验收 `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm test:contract` / `pnpm test:e2e` 全绿
3. 启动 `pnpm start` 验证 `/api/docs` 可访问、原 tag 名称恢复
4. 在 [`CHANGELOG.md`](../CHANGELOG.md) `## Unreleased` 段记录回退

**风险**:tag 名称回到原状不影响任何接口行为;Phase 1A 回退是**纯文档语义回退**,**不**影响业务。

### 6.2 Phase 1B 回退

**触发条件**:
- 新增 alias path 在 NestJS 路由层报冲突 / 404
- alias smoke E2E 失败
- 旧 path 行为意外受影响(同 handler 双 path 引发的副作用)
- snapshot diff 出现旧 path key 异常变化

**回退步骤**:
1. `git revert <Phase 1B PR commit>`
2. 验收新增的 7 个 alias path 在 OpenAPI / curl 检查中**完全消失**
3. 验收 7 个旧 path(`/api/health*` × 3 + `/api/auth/*` × 4)行为**完全等价于** Phase 1B 实施前
4. 删除新增的 7 个 smoke E2E 文件 / 用例(若 revert 已包含,跳过)
5. 在 [`CHANGELOG.md`](../CHANGELOG.md) `## Unreleased` 段记录回退

**风险**:新增 alias path 删除**不**影响旧 path;Phase 1B 回退**不**破坏 PC 后台联调(PC 后台前端调旧 path,与 alias 无关)。

### 6.3 回退后必须做

- [ ] 用户拍板下一步:是修 bug 重做 Phase 1A/1B,还是无限期搁置
- [ ] 若搁置,本评审稿状态在 [`docs/process.md`](process.md) 流程中标 "Phase 1 暂停",原因记录在 [`docs/current-state.md §3`](current-state.md) "当前明确未做" 列表

---

## 7. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| Phase 1A 的 Tag 改名导致前端 SDK 生成代码方法名变化 | **中** | 评审 PR 前先用 `gh pr diff` 看 OpenAPI snapshot 完整 diff;PR 描述里提示 PC 后台前端"SDK 重新生成"风险 |
| Phase 1B 同 handler 双 path 在 NestJS 路由表注册引发冲突 | **中** | 实施前 grep `@Controller([` 或 `@Get([` 在仓库中现有用法;若无先例,在 PR 早期用 1 个 method 做 spike 验证 |
| Phase 1B 新 alias path 没复用 `@LoginThrottle()` / `@RefreshThrottle()` 等限流装饰器 | **高** | smoke E2E 必须包含 1 个限流触发用例(如 31 次连续调 `/api/auth/v1/refresh` 期待 429);**禁止** alias path 绕过限流 |
| Phase 1B 新 alias path 没复用 `@Public()` 装饰器 | **高** | smoke E2E 必须包含"无 token 直接调 `/api/public/v1/health`"返 200;`/api/auth/v1/login` 无 token 应 200(沿 `@Public()`)|
| 实施 PR 内 commit 同时含 1A + 1B | **中** | 沿 [`docs/process.md §3` 不混档](process.md);PR review 时拒绝合并 |
| 实施 PR 顺手加 `/api/app/v1/*` 或拆 DTO | **高** | 沿 [`CLAUDE.md §19.1`](../CLAUDE.md) 设计期硬禁止;PR review 时拒绝合并 |
| 实施 PR 把 `setGlobalPrefix('/api')` 改成 `/api/v2` 或动 `apply-global-setup.ts` | **高** | sentinel:bootstrap 文件不在 Phase 1 范围内;PR review 强制检查 |
| Phase 1B 新 alias path 在 contract snapshot 显示为"新 endpoint" 引发"是否要走 P0-* 流程"的争议 | **低** | 本评审稿 §1.1 已明确 Phase 1B = C 档,新增 path 是预期内;PR 描述明确引用本节 |

---

## 8. 实施前置门槛(每个 1A / 1B PR 启动前必须满足)

- [ ] 本评审稿(`docs/api-client-boundary-phase-1-review.md`)经用户拍板**通过**
- [ ] `git status --short` 工作树 clean
- [ ] `gh pr list --state open` 输出为空(无 open PR)
- [ ] [`docs/current-state.md`](current-state.md) `§1` 当前版本一致(`v0.14.0`)
- [ ] [`CHANGELOG.md`](../CHANGELOG.md) `## Unreleased` 段无残留
- [ ] 实施者已读完:
   - [ ] [`docs/api-client-boundary.md`](api-client-boundary.md) §1-§8
   - [ ] [`docs/api-client-boundary-inventory.md`](api-client-boundary-inventory.md) §1 / §2 / §3
   - [ ] [`docs/api-client-boundary-migration-plan.md`](api-client-boundary-migration-plan.md) §0 / §3 / §5
   - [ ] [`CLAUDE.md §19`](../CLAUDE.md) / [`AGENTS.md §19`](../AGENTS.md) 设计期约束
   - [ ] [`docs/process.md §3-§4`](process.md) 档位定义与降速规则
- [ ] 实施者已确认 Phase 1A 与 1B 拆两个 PR,**不**混档
- [ ] PR 描述使用本评审稿 §2.2.4 / §2.3.5 模板

---

## 9. FAQ

**Q1:为什么 Phase 1A 也是 C 档?Tag 改名似乎不改 API 行为。**
A:沿 [`docs/process.md §3` 档位归属规则](process.md),改 `.ts` 文件就不是 A 档;改 OpenAPI snapshot tag 字段是合同变更(前端 SDK 生成代码会变方法名),归 C 档。
**反向问题**:如果 Phase 1A 跳 `pnpm test:contract`,snapshot 校验跳过,可能合并后才发现某 tag 拼写错。

**Q2:Phase 1B 新增 7 个 alias path,旧 path 还在,客户端怎么选?**
A:**新客户端用新 path,老客户端用老 path,两者等价**。
PC 后台前端**不需要**为 Phase 1B 改任何代码(继续用 `/api/auth/login` / `/api/health`)。
未来 App / 小程序前端在 Phase 2 立项时,**优先**使用 `/api/auth/v1/*` 与 `/api/public/v1/*`(语义清晰)。

**Q3:Phase 1B 既然有旧 path,为什么不直接跳到 Phase 2 新建 App API?**
A:Phase 1B 仅 7 个 path(健康 + 认证),实现成本极小;先把 Public / Auth 这两个"全客户端共用"的边界整理出来,Phase 2 新建 App API 时**直接基于** `/api/auth/v1/login` 写"登录后查 `/api/app/v1/me`"的联调闭环,语义更清晰。
若跳过 Phase 1B,Phase 2 App API 仍需调 `/api/auth/login` —— 路径段不对齐。

**Q4:Phase 1B 的限流装饰器(`@LoginThrottle` 等)在 alias path 上还生效吗?**
A:**必须生效**。同 handler 双 path 复用同一装饰器栈;`@LoginThrottle()` 是 method 级装饰器,作用在 handler 上,与 path 数量无关。但 smoke E2E 必须**显式**验证(沿 §7 风险表)。

**Q5:Phase 1A 改 `@ApiTags` 会不会触发 contract snapshot 大变化?**
A:**会**。snapshot 内 `tags[*].name` + `paths[*][*].tags` 全部改名。属于 Phase 1A 预期内,PR 描述里必须列出 diff 摘要。
**风险**:若 snapshot 因"无关字段"也变化(如 NestJS 版本升级),应在 Phase 1A PR 之前先排除环境噪音(如固定 NestJS / `@nestjs/swagger` 版本)。

**Q6:Phase 1 完成后,Phase 2 立项是必然吗?**
A:**不是**。Phase 1 完成后,用户可选:
- 立即进 Phase 2(`/api/app/v1/me/*` 新增 P0 接口)
- 暂停,先完成 P0-F RBAC 收紧等其它优先级任务
- 暂停 Phase 1-5 整体,把客户端边界作为"已设计但未实施"长期搁置

沿 [`docs/api-client-boundary-migration-plan.md §10`](api-client-boundary-migration-plan.md) — Phase 1+ **不**由 AI 自行启动。

---

## 10. 验收 / 决策记录

> 本节随着评审过程滚动更新。

| 日期 | 决策 | 决策者 | 来源 |
|---|---|---|---|
| 2026-05-19 | 本评审稿 v0 创建 | AI(待用户拍板) | 用户任务"Phase 0 修正 + Phase 1 评审稿" |
| 待定 | 评审稿冻结 / Phase 1A 立项 | 用户 | 评审通过后 |
| 待定 | Phase 1A 落地 | — | 单 PR |
| 待定 | Phase 1B 立项 | 用户 | 1A 落地后 |
| 待定 | Phase 1B 落地 | — | 单 PR |

---

> **本评审稿生效时间**:2026-05-19(执行评审稿 v0)。
> **冻结条件**:用户拍板后,本评审稿进入 "Phase 1 实施前置文档" 状态,修订必须记录。
> **过期条件**:Phase 1A + 1B 均落地后,本评审稿降为"历史评审"性质,不回改,沿 [`docs/V2红线与复活路径.md §5.1`](V2红线与复活路径.md) handoff 历史规则。
