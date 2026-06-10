# CODEMAP(harness 版)— 全仓导航与读写分区

> **性质**:derived 导航文档,非规则源。`src/` 模块级地图(体量 / 职责 / 本地铁律)的权威是根 [`CODEMAP.md`](../../CODEMAP.md)(由 `pnpm docs:codemap:check` 防漂移),本文件**不重复维护**那张表。
> 本文件补两件事:**全仓目录全景**(根 CODEMAP 不覆盖 docs / test / scripts / .claude / .github)与 **AI 读写分区**。
> 数据快照:2026-06-10,HEAD `18229ed`(post-v0.15.0)。与磁盘冲突时以磁盘为准。

---

## 1. 全仓目录全景

```text
srvf-nest-api/
├── AGENTS.md                 # 🔴 长期 AI 协作铁律主入口(非用户授权不动)
├── ARCHITECTURE.md           # 🔴 架构蓝图(先读顶部"当前阶段说明")
├── CLAUDE.md                 # 🔴 Claude Code 入口转发(≤80 行;非用户授权不动)
├── CODEMAP.md                # 🟡 src 模块地图(改动后跑 pnpm docs:codemap:check)
├── CHANGELOG.md              # 🟡 已发布段不改;## Unreleased 可改
├── TASKS.md                  # 🟡 历史任务入口索引(166 行;锚点供历史引用)
├── README.md                 # 🟡 项目概览 / 路由总览 / 文档地图
├── package.json              # 🟡 scripts 可读;依赖项变更 = D 档
├── docker-compose.yml        # 🟡 本地 PostgreSQL 16(e2e 依赖)
├── Dockerfile                # 🟡 多阶段构建;变更走 D 档(docker-smoke 影响)
├── eslint.config.mjs / .prettierrc / tsconfig*.json / nest-cli.json
│                             # 🟡 工具链配置;变更影响所有 PR,谨慎
├── .env.example              # 🟡 新增环境变量必须同步(AGENTS §14)
├── .env.test                 # 🟡 e2e 专用(DATABASE_URL 必须含 app_test)
├── .github/workflows/
│   ├── ci.yml                # 🔴 lint+typecheck+build+unit+contract+e2e(改 = D 档)
│   └── docker-smoke.yml      # 🔴 真实容器启动回归(改 = D 档)
├── prisma/
│   ├── schema.prisma         # 🔴 数据模型唯一权威源(改 = D 档,先评审)
│   ├── migrations/           # 🔴 12 个 migration;禁止删改历史、禁止自动 migrate dev
│   ├── seed.ts               # 🔴 super admin + 76 条 Permission + RBAC 绑定(改 = D 档)
│   └── CLAUDE.md             # 本地铁律(必读后再动 prisma/)
├── scripts/
│   ├── agent-preflight.sh    # 🟢 开工只读门禁(pnpm agent:preflight)
│   └── check-codemap.ts      # 🟢 CODEMAP 漂移检查(pnpm docs:codemap:check)
├── src/
│   ├── main.ts / app.module.ts   # 🟡 全局装配(APP_GUARD 顺序固定,改 = D 档)
│   ├── bootstrap/            # 🟡 main.ts 与 test/setup/test-app.ts 共用;改前确认双边
│   │                         #    apply-swagger.ts 的 setVersion = E 档(版本 bump)
│   ├── config/               # 🟡 env 归属铁律见 AGENTS §14
│   ├── common/               # 🟡 全局基础设施(guards/filters/interceptors 改 = D 档)
│   │   └── storage/          # 🟡 完整 storage module(凭证加密;改 = D 档)
│   ├── database/             # 🟡 PrismaService 注入
│   └── modules/              # 🟢/🟡 19 个业务模块,平铺(模块表见根 CODEMAP.md)
├── test/
│   ├── e2e/                  # 🟢 72 个 *.e2e-spec.ts(删除既有 spec = 🔴)
│   ├── contract/             # 🟡 openapi.contract-spec.ts(148 条 EXPECTED_ROUTES)
│   │   └── __snapshots__/    # 🟡 OpenAPI snapshot(~1 MB;只允许随 C/D 档接口 PR 更新)
│   ├── fixtures/ helpers/ setup/  # 🟢 测试工具(新 e2e 必须复用,见 TEST_MATRIX §5)
│   └── jest-*.config.ts      # 🟡 三套 jest 配置
├── docs/                     # 见 docs/README.md(文档地图);archive/** = 🔴 历史快照不回改
│   └── ai-harness/           # 🟢 本目录(维护权见 ./README.md §2)
└── .claude/skills/           # 🟡 5 个项目 skills(api-surface / auth-security /
                              #    god-service-refactor / prisma-change / release-closeout)
```

## 2. 读写分区定义

| 分区 | 含义 | AI 行为 |
|---|---|---|
| 🟢 自由区 | docs(非权威源)/ 测试新增 / 本目录地图 | 可直接修改,按 PR 档位走检查 |
| 🟡 谨慎区 | 业务代码 / 配置 / contract snapshot / 工具链 | 按 [`process.md §3`](../process.md) 定档;C 档以上动手前用户拍板 |
| 🔴 红区 | 五大权威源文档 / CI / prisma schema·migrations·seed / 全局 Guard·Filter·Interceptor / auth·JWT / storage 凭证 / audit 不可变性 / archive/** | **非用户授权不动**;触碰即 D/E 档降速(评审稿 + 拍板) |

红区精确清单(逐文件):`AGENTS.md` / `ARCHITECTURE.md` / `CLAUDE.md` / `docs/srvf-foundation-baseline.md` / `docs/V2红线与复活路径.md` / `docs/api-surface-policy.md`(以上 6 个 = AGENTS.md 顶部铁律点名)+ `.github/workflows/**` + `prisma/schema.prisma` + `prisma/migrations/**` + `prisma/seed.ts` + `src/common/guards/**` + `src/common/filters/**` + `src/common/interceptors/**` + `src/modules/auth/**`(行为契约,P0-E 冻结)+ `src/common/storage/storage-crypto.service.ts` + `docs/archive/**`(只读)。

## 3. AI 读取优先级(最少必要阅读)

1. [`docs/current-state.md`](../current-state.md) — 当前事实(必读)
2. 任务说明 + `pnpm agent:preflight` 输出
3. 根 [`CODEMAP.md`](../../CODEMAP.md) → 定位目标模块 → 该模块局部 `CLAUDE.md`(7 个模块有:activities / activity-registrations / attendances / attachments / auth / permissions / common/storage)
4. 按任务类型读本目录对应地图(见 [`README.md §3`](./README.md))
5. **仅在相关时**才读 AGENTS.md 对应小节全文与 archive/**(历史证据)

## 4. 不建议 AI 读取的内容

- `docs/archive/**` 正文(只在权威源未覆盖具体场景时作辅助;它们是冻结快照)
- `test/contract/__snapshots__/*.snap` 全文(~36k 行;用 diff 看变更,不要整读)
- `pnpm-lock.yaml`
