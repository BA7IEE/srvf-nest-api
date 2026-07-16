---
name: srvf-api-surface
description: Use when adding, splitting, moving, tagging, or changing HTTP API endpoints, controllers, DTOs, Swagger tags, OpenAPI contract output, or app/admin/public surface boundaries in srvf-nest-api.
---

# srvf-api-surface

## Purpose

SRVF Nest API 项目所有 API surface(controller / path / Swagger tag / DTO 边界 / OpenAPI snapshot)跨模块变更的工作流。本 skill 只编排"何时触发 / 先核验什么 / 哪些不能碰 / 怎么验证 / 怎么报告",**不**复制 surface 细节;细节查权威源:

- [`docs/api-surface-policy.md`](../../../docs/api-surface-policy.md) — surface 边界 / Mixed Controller 存量 / mobile-like endpoint 处置(active)
- [`AGENTS.md §1/§2`](../../../AGENTS.md) + `docs/reference/{naming-dto-validation,swagger,api-client-boundary}.md` — 已有 D-series decision locks
- [`docs/architecture-boundary.md`](../../../docs/architecture-boundary.md) — 职责类抽离触发条件
- [`docs/process.md §3`](../../../docs/process.md) — PR 分级
- [`docs/current-state.md`](../../../docs/current-state.md) — 当前事实

冲突时:用户本轮指令 → `api-surface-policy.md` → `AGENTS.md §2` 决策锁(全文 `docs/reference/api-client-boundary.md`)decision locks → `AGENTS.md` 其它 → `docs/process.md` → 实际代码 / `/api/docs` / contract snapshot。规则冲突**停止并报告**,不自行调和。

## When to use

任务涉及以下任一情况即启用:

- 新增 / 删除 / 移动 / 拆分 controller(含同模块 `controllers/` 子目录文件拆分)
- 修改 `@Controller(...)` path / 方法 path / HTTP method / 响应结构
- 修改 `@ApiTags` / `@ApiOperation` summary / 任何 Swagger metadata
- 新增 / 修改 DTO,尤其涉及 App / Admin / Public surface DTO 边界
- 新增 endpoint 落 `admin/v1` / `app/v1` / `auth/v1` / `system/v1` 任一 canonical surface(Route B 终态;`open/v1` 预留禁占用)
- 拆 Mixed Controller(class-level + 方法级双 `@ApiTags`)
- 修改 OpenAPI snapshot 或 contract test
- 修改方法上 `@Public()` / `@Roles(...)` / `JwtAuthGuard` 入口装饰器组合

## Required first checks

先**只读**调研,不动任何文件。必须确认并记录:

- 目标 endpoint 当前 path / method / Swagger tag / Guard / `@Public()` / `@Roles(...)` / 限流装饰器
- 该 endpoint 所属 surface(Admin / App / Auth / System 四 canonical 之一)
- 是否影响 OpenAPI snapshot / contract test
- 是否会形成 Mixed Controller(**不再新增**)
- 是否触发已有 D-series decision lock(参 `AGENTS.md §2`,全文 `docs/reference/api-client-boundary.md`)

## Surface invariants

以下不变式**严禁弱化**;具体清单 / 存量名单 / 历史例外查 `docs/api-surface-policy.md`:

- **不再新增** Mixed Controller(class-level + 方法级双 `@ApiTags`);现存存量只兼容、不复制范式
- **App / Admin / Public DTO 不得未经确认复用或派生**(`extends` / 任何映射类型工具均视作越权)
- 新移动端 endpoint **只能**落 `/api/app/v1/*`;Mobile / Admin 不混入彼此 surface
- **不**随意改 existing path / method / response shape;改任一项即升档为 C/D
- Controller 物理拆分必须 **endpoint zero drift**:path / method / tag / Guard / `@Roles` / DTO / service 调用全部不变
- **raw permission code ≠ app capability**:RBAC 原始权限码端点与 App capability 端点语义不等价,不得 alias / 合并 / 互替
- Route B 终态(全部路由仅落 4 canonical 前缀)由 contract 断言锁定;**不**顺手加 path alias / 改前缀,任何 surface / path 变更一律 D 档单独立项
- 已有 D-series decision lock 冲突时**停止并报告**

## Risk grade

| 档 | 范围 | 用户拍板 |
|---|---|---|
| **A** | docs-only / 注释 / 本 skill | ❌ |
| **B** | tag-only drift / 物理拆 controller(endpoint zero drift) / DTO 内部重命名不触 contract | ❌(常规) |
| **C** | OpenAPI schema / path / 响应字段语义变化 / 新 endpoint / 新 DTO 字段 | ✅ |
| **D** | breaking API change / surface 互转 / public-auth boundary / 删除或 deprecate legacy / path alias | ✅ + 评审稿 |

Swagger tag / OpenAPI snapshot 出现 drift 时,**必须**在报告中显式说明"是否为 tag-only";tag-only 仍按 B 档,但 contract snapshot 需显式更新而非"漂着"。

## Validation

按档位选择,不要刷全量:

- **A**:`pnpm agent:preflight`
- **B**:`pnpm lint && pnpm typecheck && pnpm test:contract`(snapshot zero drift 或显式更新)
- **C**:B 全部 + 相关 surface e2e
- **D**:C 全部 + `pnpm agent:check:full`,且必须先评审稿冻结

本地缺 `node_modules` 或 `eslint command not found` 时:**不要** `pnpm install` / 改 lockfile;如实报告环境阻塞并继续 diff 报告。

## Output report

提交前必须列出:

- 修改文件清单
- surface before/after:path / method / tag / Guard / `@Roles` / DTO 任一项的变化
- OpenAPI snapshot 是否变化(N / 显式更新 + 范围 / 是否 tag-only)
- contract test 是否变化
- 验证命令与结果
- 档位判定
- 是否建议 commit

## Hard stops

下列情况**立即停止并报告**:

- 未授权但需要改 path / method / Swagger tag / DTO 字段 / 删除或 deprecate endpoint
- 需要新增 Mixed Controller
- 需要把新移动端 endpoint 落到 `/api/app/v1/*` 之外
- 任务诉求与 `AGENTS.md §2` D-series 决策锁任一项冲突
- OpenAPI snapshot 出现非预期 drift
- 任务超出本 PR 白名单(D 档"禁止顺手做")
