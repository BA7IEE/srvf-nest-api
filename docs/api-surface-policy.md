# API Surface Policy

> **目的**:锁定 SRVF API 当前对外提供的 surface(客户端面)分类与新增规则。
> **配套文档**:[`api-client-boundary.md`](./api-client-boundary.md)(顶层规范) / [`current-state.md`](./current-state.md)(当前事实)。
> **本 PR 不修改 controller 路径、不删 v2、不动 OpenAPI snapshot;仅以文档形式登记长期边界**。

---

## 1. 当前 surface 分类

| Surface | 当前路径前缀 | 状态 | 用途 |
|---|---|---|---|
| **Mobile App** | `/api/app/v1/*` | 新增唯一入口 | 移动端(队员视角)接口;面向 App / 小程序 / Mobile Web |
| **Admin Legacy** | `/api/v2/*` | 长期保留,不强制迁移 | PC 管理后台接口;v0.13.0 起按此前缀落地的 V2 业务接口集合 |
| **Root Legacy** | `/api/auth/*` / `/api/users/*` / `/api/health/*` | 兼容入口长期保留 | v1 阶段已锁定的 14 路由及 P0-D / P0-E 在 `/api/users/me/*` / `/api/auth/*` 下的扩展 |
| **Public / Auth** | 当前与 Root Legacy 重合(无独立前缀) | Phase 1B path alias 暂缓 | `/api/auth/login` / `/api/auth/refresh` / `/api/auth/logout` / `/api/auth/logout-all` / `/api/health/*` |

具体每个 endpoint 的归属与 Swagger Tag(`App` / `Admin` / `System` / `Public` × module)分类,沿 v0.15.0 Phase 1A 重命名后的状态;细节查 `/api/docs` 与 `docs/current-state.md`。

---

## 2. 新增规则(长期生效)

### 2.1 移动端

- ✅ 新移动端接口**只能**落在 `/api/app/v1/*`,且必须新建独立的 Mobile Controller(允许文件位于 `src/modules/<module>/controllers/app-*.controller.ts`)
- ✅ 新移动端 DTO **必须**独立定义在 `src/modules/<module>/dto/app/` 子目录,**禁止** `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 一个 Admin DTO 构造 App DTO
- ✅ App API where 子句永远使用 `currentUser.memberId` 锁定本人(`scope = self`);**禁止**用 `role` 短路决定数据范围
- ❌ App API **永远不返回** L3 凭证字段:`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / 完整 signed URL
- ❌ 不在 Admin / System / Public controller 内新增 Mobile-only 方法
- ❌ **不再新增 "Mixed Controller"**(class-level `@ApiTags('Admin - X')` 同时在方法级追加 `@ApiTags('Mobile - X')`);已存在的(如 `users.controller.ts` 中 `/me` 三端点)作为**历史存量**保留,不再扩展

### 2.2 管理面

- ✅ 新 PC 管理后台接口默认落在 `/api/v2/*`(沿现状;短期内不再新建别的管理前缀)
- ✅ 管理面 DTO 与移动端 DTO **物理分离**,即使字段集相同,也不共用 class
- ❌ 不在管理面接口中夹带"顺手满足 Mobile"的字段语义

### 2.3 兼容入口

- ✅ `/api/auth/*` / `/api/users/*` / `/api/health/*` 保留作为 Root Legacy,**不强制迁移**到任何带版本号的前缀
- ✅ 已存在的"双端点"模式(如 `PUT /api/users/me/password` 与 `PUT /api/app/v1/me/password` 共存)**只维护兼容、不扩展新字段**;两端点共享同一 service 与同一 DTO 的现状沿用,未来如要拆分,**必须单独立项**

### 2.4 迁移与别名

- ✅ 若需迁移旧 endpoint(例如 `/api/auth/login` → `/api/auth/v1/login`),**必须单独立项**(C/D 档评审稿 + 双写 alias + 灰度切流 + 旧 endpoint deprecated 公告)
- ❌ **不**在常规 PR 中"顺手"添加路径别名
- ❌ **不**在常规 PR 中"顺手" deprecate 现有 endpoint

---

## 3. 本 PR(docs governance consolidation)明确不做

- ❌ **不改** controller path(任何 `@Controller(...)` 字符串)
- ❌ **不删** `/api/v2/*` 任何 endpoint
- ❌ **不改** `/api/auth/*` / `/api/users/*` / `/api/health/*` 根路径
- ❌ **不改** OpenAPI snapshot 或任何 contract 测试
- ❌ **不改**前端联调口径
- ❌ **不改** E2E / unit 测试
- ❌ **不启动** Phase 1B path alias(`/api/auth/v1/*` + `/api/public/v1/*`)
- ❌ **不**物理拆分已存在的 Mixed Controller

---

## 4. 与 `api-client-boundary.md` 的关系

- `api-client-boundary.md`:顶层规范("Surface × Module × Resource" 三元组分类原则、Phase 0/1 设计意图、Phase 1A Swagger Tag 改名结论)
- `api-surface-policy.md`(本文件):**长期生效的新增/扩展铁律**,无须依赖任何具体 Phase 评审稿即可独立适用
- 旧 Phase 评审稿(`api-client-boundary-inventory.md` / `-migration-plan.md` / `-phase-1-review.md`)已归档到 [`archive/reviews/`](./archive/reviews/) 与 [`archive/plans/`](./archive/plans/),作为历史证据保留

冲突时:**本文件 > 归档评审稿**;**当前事实(`current-state.md`) > 本文件**(若现状已超出本文件锁定的边界,先以 current-state 描述为准并升级本文件)。

---

## 5. 历史 Mixed Controller 存量(仅作登记,不作扩展依据)

以下属于 v0.15.0 之前已经落地的"混合 surface controller",**只维护、不扩展、不复制范式**:

- `src/modules/users/users.controller.ts`:class-level `@ApiTags('Admin - Users')`,内含 `/me`、`/me/password`、`PATCH /me` 三个 method-level 追加 `Mobile - Me` Tag 的端点
- `src/modules/activity-registrations/activity-registrations.controller.ts`:同文件内含两个 `@Controller(...)` 类(`v2/activities/:activityId/registrations` 与 `v2/users/me`)
- `src/modules/dictionaries/dictionaries.controller.ts`:同文件内含两个 `@Controller(...)` 类(`v2/dict-types` 与 `v2/dict-items`)

未来 Mixed Controller 物理拆分如需启动,**走独立立项**;本 PR 不动。
