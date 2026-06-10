# TEST_MATRIX — 命令清单与任务档位测试矩阵

> **性质**:derived 操作文档。测试 SOP 权威 → [`docs/testing.md`](../testing.md);PR 档位与必跑检查权威 → [`docs/process.md §3`](../process.md);本文件把两者合成 AI 可直接执行的矩阵。
> 数据快照:2026-06-10,HEAD `ccd8817`(post-P2-2 #287 + 检查项 G #288)。✅ = 实测通过;🔶 = 需本地 Docker;本地 daemon 未启动时降级路径见 §1 末尾,CI 等价覆盖。

---

## 1. 命令清单(全部 pnpm-only,禁 npm/yarn/bun)

```bash
# ── 环境准备(fresh worktree 必做;否则 typecheck 报 Prisma 假错误)──
pnpm install --frozen-lockfile        # ✅
pnpm prisma:generate                  # ✅ 生成 Prisma Client

# ── 开工门禁(只读)──
pnpm agent:preflight                  # ✅ git status / branch / open PR / 版本三方一致

# ── 静态检查 ──
pnpm lint                             # ✅ eslint --max-warnings 0(src + test + prisma)
pnpm typecheck                        # ✅ tsc --noEmit ×2(src + test 两套 tsconfig)
pnpm build                            # nest build(CI 必跑)
pnpm docs:codemap:check               # ✅ CODEMAP 漂移检查(0 FAIL 才算过;WARN/INFO 不阻塞)
pnpm docs:rbacmap:check               # ✅ RBAC_MAP 漂移检查(seed 码/controller 数/canonical 前缀对账)

# ── 测试三件套 ──
pnpm test                             # ✅ unit(jest-unit.config.ts;无 DB 依赖;26 specs)
pnpm test:contract                    # 🔶 OpenAPI snapshot + 148 条 EXPECTED_ROUTES(需 DB)
pnpm test:e2e                         # 🔶 72 suites / 1664 tests,串行 --runInBand(需 DB)

# ── 组合命令(按档位选用)──
pnpm agent:check:quick                # ✅ lint + typecheck + test
pnpm agent:check:api                  # 🔶 quick + test:contract
pnpm agent:check:full                 # 🔶 api + test:e2e

# ── 测试数据库(e2e/contract 前置;PostgreSQL 16)──
docker compose up -d postgres         # 起容器(容器名 u-nest-api-postgres)
pnpm db:test:init                     # 幂等创建 app_test 库
pnpm db:test:reset                    # 脏数据重置(护栏:URL 不含 app_test 即拒绝)

# ── Prisma(危险命令,见 §6)──
pnpm prisma:migrate                   # ⛔ migrate dev:先说明迁移内容并等用户确认
pnpm prisma:deploy                    # 生产/CI 用,只跑已审查 migration
pnpm prisma:seed                      # seed(幂等;生产强校验)
```

**环境前置事实**:e2e / contract **必须**真实 PostgreSQL(`.env.test` → `app_test` 库;globalSetup 断言 URL 含 `app_test` 防误打开发库,自动 migrate deploy)。unit 与 lint/typecheck **无** DB 依赖。本机无 Docker 时的降级路径:跑 `agent:check:quick` + 声明"contract/e2e 留给 CI",**不得**谎报全绿。

## 2. PR 档位 × 必跑检查(与 process.md §3 一一对应)

| 档位 | 典型任务 | 必跑 | 补充 |
|---|---|---|---|
| A(docs-only) | 文档 / 地图 true-up | 可省 | 动了 CODEMAP/链接 → `docs:codemap:check`;动本目录 → 自查快照戳 |
| B(代码小修) | 重构 / 注释 / 单测补强 / 非破坏 bug fix | `agent:check:quick` + 受影响模块 e2e(`pnpm test:e2e -- <spec名>`) | 不新增 endpoint / DTO 字段 / 错误码 |
| C(API 行为) | 新 endpoint / DTO 字段 / 错误码 / 响应语义 | `agent:check:full`(= lint+typecheck+unit+contract+e2e) | contract snapshot 必然变 → diff 必须逐行可解释;范围已含于用户任务说明 / goal → 免二次确认,AI 自行发起仍须拍板 |
| D(schema/权限/安全) | migration / seed / RBAC / auth / storage / audit / CI / 依赖 | C 档全部 + 评审稿/立项 + 影响面分析 | 分 PR 串行,禁夹带;对应 skill 必读 |
| E(release) | bump / handoff / tag | C 档全部 + handoff 锚点 | `srvf-release-closeout` skill |

## 3. 模块 × spec 对照

模块对应 e2e spec 清单见 [`MODULE_MAP.md §1`](./MODULE_MAP.md) "主要 e2e spec" 列。**受影响范围判断**:改哪个模块跑哪组 + 永远附带横切组(response-format / bizcode-http-status / request-id);改依赖枢纽(permissions / audit-logs / common/*)→ 直接 `agent:check:full`。

单测(26 个 `*.spec.ts`)关键资产——6 个 service-level characterization spec(attendances 716L / users 799L / attachments 850L / certificates 695L / activities 628L / activity-registrations 430L):纯构造注入 mock,不起 Nest 不连库,锁定 service 编排契约。**拆 service / 改内部编排前必须先跑;行为差异 = 停下报告,不是改断言。** 另有 participation 6 个纯组件 spec(#278/#279/#280:time-overlap-policy / contribution-calculator / 3 state-machine 全矩阵 / attendance-presenter),秒级锁组件内部矩阵。

## 4. 高风险模块的最低测试集

| 改动涉及 | 最低必跑 |
|---|---|
| auth / JWT / throttle | auth-* 全组(8 spec)+ users-password-reset + `test:contract` |
| users 管理 / 保护逻辑 | users-* 全组(7 spec)+ user-roles + rbac-me-permissions |
| RBAC(permissions 模块 / seed) | permissions / rbac-roles / role-permissions / user-roles / rbac-reload / seed-rbac / users-role-boundary + **全量 e2e**(权限是横切面) |
| schema / migration | `agent:check:full` + `pnpm prisma:deploy` 在干净 app_test 重放 + seed 幂等二跑(沿 docker-smoke 范式) |
| 状态机(activities / registrations / attendances) | 对应 *-state-transition + *-status-guards + *-audit-characterization |
| 附件 / 存储 | attachments* 全组 + storage-settings + attachment-configs 三组 |
| 全局 bootstrap / interceptor / filter | **全量 e2e**(横切面无局部豁免) |

## 5. 新写 e2e 的复用清单(禁止重复造轮子)

```typescript
import { createTestApp } from '../setup/test-app';        // 与 main.ts 共用 bootstrap 装配
import { resetDb } from '../setup/reset-db';              // beforeAll TRUNCATE(24 表,依赖序)
import { loginAs } from '../fixtures/auth.fixture';       // 真实登录拿 token
import { createTestUser, TEST_PASSWORD } from '../fixtures/users.fixture';
import { seedRbacPermissionsAndOpsAdmin, grantOpsAdminToUser } from '../fixtures/rbac.fixture';
import { httpServer } from '../helpers/http-server';
import { expectBizError } from '../helpers/biz-code.assert';  // 同时断言 HTTP status 与 BizCode
import { callEndpoint } from '../helpers/call-endpoint';      // it.each 跨端点参数化
import { waitFor } from '../helpers/wait-for';                // 轮询替代 sleep
```

硬约束(AGENTS §16 + testing.md):断言统一响应格式;错误响应同时断言 HTTP status 与 `BizCode.httpStatus`;登录类必须覆盖防枚举四场景;破坏性 SQL 统一走 `test/setup/test-db.ts`(app_test 护栏);spec 自建数据(beforeAll 直接 prisma 造),不依赖全局 seed。

## 6. Snapshot 与危险命令 SOP

- **contract snapshot 更新**:仅当接口契约变更属于本 PR 拍板范围 → `pnpm test:contract -u` → `git diff` 逐行检视(新增路由/Schema 必须与拍板范围一致)→ 随 PR 提交。**禁止**为了"让测试过"盲目 `-u`。L3 字段出现在 snapshot = 直接拒合并(D-6)。
- **EXPECTED_ROUTES / EXPECTED_SCHEMAS**:新 endpoint 必须显式登记,删除路由必须显式移除——这是 Route B 终态断言(全部路由仅落 4 canonical 前缀)的锁。
- **禁止自动执行**:`prisma migrate dev` / `prisma migrate reset` / `prisma db push` / 改 `migrations/**` 历史(prisma/CLAUDE.md)。
- **e2e 全量时长**:分钟级(72 suites 串行)。B 档优先跑受影响子集;C 档以上必须全量。

## 7. 已知测试缺口(2026-06-10 Review 发现;当前处置状态)

1. 部门级权限场景(部长 / `finalReviewerUserId` 终审矩阵)无专项 e2e——**✅ 已拍板不补**(2026-06-10 P1-5 方案 A:维持 ADMIN 级终审,`finalReviewerUserId` 仅审计记录;部门级细分挂 Slow-3 子议题,未立项前不实现、不补部门级 e2e,详 [`participation-bounded-context.md §4`](../participation-bounded-context.md))。
2. `docs/testing.md` 覆盖表引用已删除的 `users-me.e2e-spec.ts`——**✅ 已修**(2026-06-10 P1-2:替换为 `app-me` / `app-me-password` 承接行,全文 20 个相对链接复核)。
3. unit 覆盖率 ~11.8%(26 spec / 221 源文件,2026-06-10 实测)——刻意策略(e2e 为主 + 6 个 god/large service characterization 全覆盖 + participation 5 纯组件 unit 矩阵 + presenter spec),不是缺陷;新增 service 编排逻辑时按 architecture-boundary 触发条件补。
