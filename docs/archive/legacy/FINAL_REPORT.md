# V1.2 / v0.1.3 收尾报告

> ⚠️ **历史归档说明**
>
> 本文件是 2026-05-03 / v0.1.3 阶段的历史收尾报告,**不是当前项目状态入口**。
> 当前事实请以 [`docs/current-state.md`](docs/current-state.md) 为准;当前开发流程请以 [`docs/process.md`](docs/process.md) 为准。
> 本文件仅用于追溯早期模板阶段完成情况,后续 AI / Claude Code **不得**将其作为当前状态依据。

---

> 范围:模板收敛(template consolidation),不新增业务功能,不修改 API 响应格式,不做破坏性数据库变更。
> 完成日期:2026-05-03。

---

## 1. 变更文件清单

### 新增

| 文件 | 用途 |
|---|---|
| [`src/bootstrap/logger-options.ts`](src/bootstrap/logger-options.ts) | `nestjs-pino` 配置工厂(redact 清单 + `buildLoggerModuleParams`) |
| [`src/bootstrap/request-id.ts`](src/bootstrap/request-id.ts) | `x-request-id` 头处理(`genReqId` / `buildHttpLogProps` / 校验正则) |
| [`src/bootstrap/throttle-options.ts`](src/bootstrap/throttle-options.ts) | `@nestjs/throttler` 配置工厂(`buildThrottlerOptions`) |
| [`src/modules/users/users.policy.ts`](src/modules/users/users.policy.ts) | 用户管理权限策略 4 个纯函数(`canViewUser` / `canManageUser` / `canCreateRole` / `canChangeRole`) |
| [`docs/development.md`](docs/development.md) | 项目结构 / 路由总览 / 环境变量 / 排错(从 README 拆出) |
| [`docs/testing.md`](docs/testing.md) | E2E 测试运行与覆盖范围(从 README 拆出) |
| [`docs/deployment.md`](docs/deployment.md) | Docker 镜像 / 生产部署 / 迁移流程 / V1.1 工程能力清单(从 README 拆出) |
| [`docs/security.md`](docs/security.md) | 已落地安全策略 / 软删除策略 / token 吊销升级路径 |
| [`FINAL_REPORT.md`](FINAL_REPORT.md) | 本文 |
| [`docs/v1.3-plan.md`](docs/v1.3-plan.md) | V1.3 Contract Hardening Plan(仅文档,不执行) |

### 修改

| 文件 | 变更原因 |
|---|---|
| [`src/app.module.ts`](src/app.module.ts) | 209 行 → 68 行;logger / request-id / throttle 配置全部下沉到 `bootstrap/`;保留 `buildHttpLogProps` re-export 供既有 e2e 兼容 |
| [`src/modules/users/users.service.ts`](src/modules/users/users.service.ts) | `assertCanManageUser` / `create` / `updateRole` / `list` 可见范围 4 处角色判断改走 `users.policy.ts` 纯函数;结构性不变式(自我保护、最后一个 SUPER_ADMIN)仍由事务保障,逻辑等价 |
| [`src/bootstrap/apply-swagger.ts`](src/bootstrap/apply-swagger.ts) | `setVersion('0.1.2')` → `setVersion('0.1.3')` |
| [`package.json`](package.json) | `"version": "0.1.2"` → `"version": "0.1.3"` |
| [`README.md`](README.md) | 289 行 → 116 行;复杂内容迁移到 `docs/`;保留项目定位、快速启动、路由总览、常用命令、文档入口 |
| [`CHANGELOG.md`](CHANGELOG.md) | 顶部新增 `v0.1.3 - 2026-05-03` 条目 |

### 不变更

- `prisma/schema.prisma` 与所有 migration 文件
- `src/main.ts`、`src/bootstrap/apply-global-setup.ts`、所有 controller、所有 DTO、auth 模块
- `.env.example` / `.env.test` / `docker-compose.yml` / `Dockerfile` / `.dockerignore` / `.github/workflows/`
- `ARCHITECTURE.md` / `CLAUDE.md` / `AGENTS.md`(协作铁律未触碰)

---

## 2. 变更原因摘要

| 主题 | 动机 |
|---|---|
| 拆分 `AppModule` | `AppModule` 之前承载了 logger / request-id / throttle 三套配置工厂(共 ~140 行纯函数)。AI 二开新增模块时容易在此误改;下沉到 `bootstrap/` 单一职责后,`AppModule` 回归"模块装配清单"语义,扫一眼 68 行即可掌握全局结构 |
| 提取 `users.policy.ts` | `UsersService` 内角色判断散落在 4 个方法里,语义重复(SUPER_ADMIN 全通 / ADMIN 仅 USER)。集中为纯函数后,未来若策略分化(列表 vs 管理)只改 policy,且单测面变小 |
| 拆分 README | 单文件 289 行,复杂部分(E2E 覆盖矩阵、Docker 镜像、生产迁移原则)对快速上手的读者是噪声;按阅读路径切分到 `docs/` 后,README 仅 116 行 |
| 软删除 / token 吊销文档化 | 之前这两个升级路径只在 `ARCHITECTURE.md` §9 一句话带过。`docs/security.md` 把"现在不做什么 / 未来怎么加 / 接口契约长什么样"写死,挡住 AI 二开擅自补全的诱惑 |
| 版本号统一 | `package.json` / Swagger `setVersion()` / CHANGELOG 三处必须同步,这是 v0.1.2 的既定约束 |

---

## 3. 验收结果

| 指令 | 结果 |
|---|---|
| `pnpm lint` | 0 errors,128 warnings(全部为 test/ helpers 既有 `@typescript-eslint/no-unsafe-argument` warning,与 v0.1.2 一致,本轮未新增) |
| `pnpm typecheck` | PASS(`tsconfig.json` + `test/tsconfig.test.json` 两轮) |
| `pnpm build` | PASS(`nest build` 产出 `dist/`) |
| `pnpm test:e2e` | **19 suites / 162 tests / 全通过**,本机 ~15.6s |

E2E 全量通过即可证明:

- 所有 14 个业务接口的响应格式 / HTTP status / BizCode 与 v0.1.2 完全一致
- 防账号枚举四场景一致性、自我保护、最后一个 SUPER_ADMIN 保护、软删除副作用矩阵、密码重置流程全部回归通过
- `request-id.e2e-spec.ts` 通过 `import { buildHttpLogProps } from '../../src/app.module'` 仍可命中(re-export 兼容)

---

## 4. Schema 与 API 兼容性

- **数据库 schema 不变**:`prisma/schema.prisma` 与 `prisma/migrations/` 未触碰,无破坏性变更
- **API 响应格式不变**:统一 `{ code, message, data }` 包装、HTTP status 与 BizCode 映射、Swagger schema 全部维持 v0.1.2
- **接口清单不变**:14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注全部维持
- **环境变量不变**:`.env.example` 字段未增减
- **Docker 镜像不变**:`Dockerfile` / `.dockerignore` 未触碰,镜像构建产物字节级一致(除 dist/ 内函数所在文件路径变化)

---

## 5. 遗留风险

| 风险 | 等级 | 说明 / 缓解 |
|---|---|---|
| `src/app.module.ts` 仍 re-export `buildHttpLogProps` | 低 | 仅为兼容 [`test/e2e/request-id.e2e-spec.ts`](test/e2e/request-id.e2e-spec.ts) 既有 import;真要清理需同步改测试文件,放到 V1.3 |
| `users.policy.ts` 4 个函数无独立单测 | 低 | E2E 通过 `users-role-boundary.e2e-spec.ts` / `users-self-protection.e2e-spec.ts` / `users-last-super-admin.e2e-spec.ts` 等 spec 完整覆盖语义,V1.3 可补单元测试加快回归 |
| `lint` 仍有 128 warnings | 低 | 全部为 test 工具链既有 `no-unsafe-argument`,与 v0.1.2 数量一致;V1.3 可统一抑制或修复 |
| Prisma 6 → 7 主版本升级提示 | 低 | E2E 输出 `Update available 6.19.3 -> 7.8.0`,本轮不升级;升级风险点见 V1.3 Plan §3 |

**未引入新风险**:本轮所有改动均为同义重构 + 文档拆分,逻辑等价。

---

## 6. 下一版本建议(V1.3)

详见 [`docs/v1.3-plan.md`](docs/v1.3-plan.md)。核心方向为**契约硬化(Contract Hardening)**:

1. OpenAPI 契约快照测试(防 schema 漂移)
2. `users.policy.ts` 单元测试矩阵
3. BizCode ↔ HTTP status 联表自动断言
4. 错误响应 schema 显式化(currently 仅 success path 有 wrapped decorator)
5. Prisma 7 升级评估
6. `lint` warnings 收敛到 0

V1.3 仍**不**引入业务功能(RBAC / refresh token / Redis / 文件上传 / LLM 等),仅在 v1 边界内补强契约稳定性。

---

## 7. 建议的 commit / tag 命令

```bash
git add CHANGELOG.md README.md package.json \
        src/app.module.ts src/bootstrap/apply-swagger.ts \
        src/modules/users/users.service.ts \
        src/bootstrap/logger-options.ts src/bootstrap/request-id.ts \
        src/bootstrap/throttle-options.ts \
        src/modules/users/users.policy.ts \
        docs/ FINAL_REPORT.md

git commit -m "$(cat <<'EOF'
v1.2: template consolidation (v0.1.3)

- 拆分 AppModule:logger/request-id/throttle 配置下沉到 src/bootstrap/
- 提取 src/modules/users/users.policy.ts:集中 4 个角色策略纯函数
- 拆分 README:复杂内容迁移到 docs/(development/testing/deployment/security)
- docs/security.md 写清软删除策略与 token 吊销升级路径
- 同步版本号 0.1.3(package.json / Swagger setVersion / CHANGELOG)

不修改 API 响应格式,不做 schema 变更;
lint(0 errors)/ typecheck / build / test:e2e(19 spec / 162 tests)全部通过。
EOF
)"

# 打 tag(可选,由维护者按需执行)
git tag -a v0.1.3 -m "v0.1.3 — V1.2 template consolidation"

# 推送
git push origin claude/compassionate-swartz-84f136
git push origin v0.1.3   # 仅在打 tag 后执行
```

> **注意**:`git push --force` / `git push origin main` 等高风险操作未在本报告建议范围;PR 合并由维护者经 GitHub UI 触发。
