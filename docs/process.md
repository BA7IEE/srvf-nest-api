# SRVF API 开发流程与协作制度

> 本文件规定 **AI / Claude Code / 维护者** 在本仓库内如何开工、分级、降速、收口、release。
> 不重述架构铁律(见 [`ARCHITECTURE.md`](../ARCHITECTURE.md) / [`CLAUDE.md`](../CLAUDE.md));不重述当前事实(见 [`docs/current-state.md`](current-state.md))。
> 与上述文档冲突时,**架构铁律优先**;本文件让步。

---

## 1. 本文用途

- 本文**不是**架构设计文档(那是 [`ARCHITECTURE.md`](../ARCHITECTURE.md))
- 本文**不是** handoff(那是 [`docs/handoff/v*.md`](handoff/))
- 本文**不是**当前状态(那是 [`docs/current-state.md`](current-state.md))
- 本文规定:**怎么开工、怎么分级 PR、怎么降速、怎么收口 release、怎么处理文档权威源、AI 怎么协作**

---

## 2. 开工前 checklist

任何新任务开始前(无论 AI 自动启动还是用户驱动),**必须**依次确认:

```bash
# 1. 工作树 clean
git status --short

# 2. 当前分支(期望 main / claude-* worktree)
git branch --show-current

# 3. open PR 数
gh pr list --state open --limit 20

# 4. 最新 release
gh release list --limit 3

# 5. 版本三方一致
grep '"version"' package.json
grep 'setVersion' src/bootstrap/apply-swagger.ts
git tag --sort=-creatordate | head -1

# 6. README 启动入口
grep -n "current-state" README.md

# 7. CHANGELOG Unreleased 状态
grep -A 3 "^## Unreleased" CHANGELOG.md
```

判断:

- **open PR ≠ 0** → 不开新功能(先合并 / 关闭 / 与维护者对齐);release 收口阶段除外(见 §5)
- **工作树不 clean** → 不开新功能(先 commit / stash / 与维护者对齐)
- **版本三方不一致**(`package.json` / Swagger / git tag) → 进入 release 收口或修正,不开新功能
- **CHANGELOG `## Unreleased` 段仍有未释放变更而 main HEAD 已超过该 release** → 进入 release 收口
- **没有 `docs/current-state.md`** → 先建立,再开始任何任务

---

## 3. PR 分级制度

每个 PR 在打开前先判定档位,**不混档**。

| 档位 | 范围 | 例子 | 必跑检查 | 用户拍板 | 连续推进 |
|---|---|---|---|---|---|
| **A 档** | docs-only;无 `.ts` / `.prisma` / `.yml` / `.json` 变动 | 改 README / 加 `docs/process.md` / 改 CHANGELOG Unreleased | (可省) | ❌ | ✅(一次会话多 A 档可串行) |
| **B 档** | 代码小修(无新 endpoint / 无 DTO 字段增减 / 无 schema / 无 enum / 无 error code 增减) | 内部重构 / 注释 / 私有方法签名 / 单测补强 | `pnpm lint` + `pnpm typecheck` + 受影响范围测试 | ❌(常规) | ✅ |
| **C 档** | API 行为变化(新 endpoint / DTO 字段增减 / 错误码增减 / 响应字段语义变化 / 新 Guard 装饰器) | 加新接口 / 错误码段扩展 / 接口入参变更 | A 档全部 + `pnpm test` + `pnpm test:contract` + `pnpm test:e2e` | ✅(动手前确认范围) | ⚠ 单 PR 评审 |
| **D 档** | schema / migration / permission seed / Role enum / 鉴权 / 存储 / 凭证 / audit / 不可逆变更 / 安全相关 | 新建表 / 加 unique / Permission seed 改动 / 加密策略 / 软删除策略 | C 档全部 + 评审稿 / 立项 / 影响面分析 + handoff 段落 | ✅ + 评审稿冻结 + 立项记录 | ❌ 必须分 PR |
| **E 档** | release / handoff / tag / GitHub Release / version bump | bump PR / handoff PR / 维护者打 tag + release | C 档全部 + handoff 验收锚点 | ✅ | ❌ 强串行 |

档位归属规则:

- 一个 PR 同时改 `.md` + `.ts` 实现 → 按更高档位算
- 改 `prisma/schema.prisma` 或 `prisma/migrations/**` 或 `prisma/seed.ts` → **必然是 D 档**
- 改 `.github/workflows/**` → **必然是 D 档**(CI / smoke 影响所有 PR)
- 改 `package.json` 依赖项 → **必然是 D 档**(运行时 / 构建影响)
- 改 `src/bootstrap/apply-swagger.ts` 的 `setVersion(...)` → **E 档**(版本 bump)

---

## 4. D 档降速规则

遇到以下**任一**特征,必须降速:

- 修改 `prisma/schema.prisma` / 增加 `migrations/`
- 修改 `Role` / `Permission` / seed 中任何 Permission code / RolePermission 映射
- 修改登录 / JWT / `auth.service.ts` / `JwtStrategy`
- 修改 `StorageProvider` / COS / 凭证加密 / `STORAGE_ENCRYPTION_KEY`
- 修改 `audit_logs` 任何字段 / 任何 `AuditLogEvent` union 项
- 物理删除任何业务数据 / 批量回填 / 数据迁移脚本
- release / tag / GitHub Release
- 跨模块大范围重构 / 拆分 service
- 改全局 Guard / Interceptor / Filter / ValidationPipe / `ResponseInterceptor` 跳过列表
- 修改 `BizCode` 段位语义(新增 BizCode 仍要登记段位,但不视作降速)

降速流程:

1. **只读调研**:用 Bash / Grep / Read 收集影响面;**不动代码**
2. **风险表**:列出"会影响哪些模块 / 测试 / 已发版本 / 用户可见行为"
3. **方案 A / B 对比**:至少给出两种实施方案与回退条件
4. **用户拍板**:把"风险表 + 方案"提交对话,等用户回话
5. **(必要时)评审稿冻结 + 立项记录**:沿 `docs/批次X_*.md` 范式(批次评审稿一旦冻结不回改)
6. **再实施**:按拍板方案动手;实施 PR 范围与拍板范围完全一致;**不夹带**

**铁律**:D 档**禁止** "顺手做"——任何超出本 PR 范围的"看起来该一并修的小问题",必须另开 PR(可立项后再做)。

---

## 5. release 收口制度

> 默认节奏:**0.x 阶段一律 minor**(沿 v0.4.0 → v0.5.0 → ... → v0.12.0 全部 minor)。
> 真正的 breaking change 或 1.0 进入再考虑 major / patch。

### 5.1 收口分阶段(逐步推进,**不混 PR**)

| 阶段 | PR / 动作 | 谁来做 | 是否会动代码 |
|---|---|---|---|
| 1 | feature PR(本期所有业务变更) | AI + 维护者授权 | ✅ |
| 2 | CHANGELOG Unreleased 增量登记 | 随 feature PR 或独立 docs PR | ❌(仅 CHANGELOG) |
| 3 | landing PR(把本期跨文档的事实同步) | AI | ❌(仅 docs) |
| 4 | **bump PR** | AI | ✅(仅 3 文件:`package.json` / `apply-swagger.ts` / `CHANGELOG.md` 折叠) |
| 5 | **handoff PR**(新建 `docs/handoff/v0.X.0.md`) | AI | ❌(仅 docs) |
| 6 | **git tag**(`v0.X.0`) | 维护者手动 | — |
| 7 | **GitHub Release**(标 Latest) | 维护者手动 | — |
| 8 | **current-state 回填** + README 入口对齐 | AI | ❌(仅 docs) |
| 9 | open PR / 远端分支 清理 | AI + 维护者 | — |

### 5.2 关键约束

- **tag 默认指向 handoff PR 的 squash merge commit**,除非用户另行拍板
- **handoff 是历史快照,合入后不回改**;如发现内容过时(例如 release 已打但 handoff 仍写"未打"),不要回改 handoff,而是更新 [`docs/current-state.md`](current-state.md)
- **`docs/current-state.md` 是当前事实入口**,release 后必须回填:`§1 当前版本表`、`§2 当前已具备能力`(若有变化)、`§4 风险债务`(若有变化)
- **README 启动入口应保持指向 `docs/current-state.md`**,不再每次 release 都改 README 指向新 handoff
- **bump PR 只允许动 3 文件**:`package.json#version` / `src/bootstrap/apply-swagger.ts` `setVersion` / `CHANGELOG.md` `## Unreleased` 折叠为 `## v0.X.0 - YYYY-MM-DD`;**禁止**夹带任何其他改动
- **GitHub Release Notes 来源**:从 `CHANGELOG.md` 中对应 `## v0.X.0` 段抽取(handoff §6 提供 awk 命令示例,沿 v0.11.0 / v0.12.0 范式)

### 5.3 release 后回填 checklist

release 与 tag 完成后,**必须**(由 AI 在下一个 docs PR 内执行,或维护者亲自):

- [ ] 更新 [`docs/current-state.md §1`](current-state.md):main HEAD short sha / tag / release Latest / open PR
- [ ] 更新 [`docs/current-state.md §2`](current-state.md):若本期新增能力,加 1-2 行清单
- [ ] 更新 [`docs/current-state.md §4`](current-state.md):若有新债务或既有债务消解
- [ ] **不**回改 [`docs/handoff/v0.X.0.md`](handoff/)(它就是阶段快照)
- [ ] 检查 [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) 顶部"基线版本"是否需要刷新
- [ ] `git ls-remote --heads origin` 与 main 对齐;无残留分支

---

## 6. 文档权威源制度

| 类型 | 文件 | 允许回改? | 用途 |
|---|---|---|---|
| **当前状态入口** | [`docs/current-state.md`](current-state.md) | ✅ 滚动维护 | AI / 维护者进入仓库的第一读物 |
| **架构铁律(蓝图)** | [`ARCHITECTURE.md`](../ARCHITECTURE.md) | ⚠ 谨慎改,用户拍板 | v1 / V1.1 / V2 §12 完整蓝图 |
| **AI 铁律** | [`CLAUDE.md`](../CLAUDE.md) / [`AGENTS.md`](../AGENTS.md) | ⚠ 与 ARCHITECTURE 同步;非用户授权不动 | Claude Code / 通用 Agent 协作铁律 |
| **V2 基线** | [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) | ⚠ 13 项 A 档基线;非用户授权不动 | V2 派生项目通用基线 |
| **V2 红线** | [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) | ✅ 滚动维护 | A/B/C/D/E 五档红线快照 |
| **历史 handoff** | [`docs/handoff/v*.md`](handoff/) | ❌ 合入后不改 | release 时刻阶段快照 |
| **冻结批次评审稿** | `docs/批次*.md` | ❌ 冻结版后不改 | 各批次决议依据 |
| **release 记录** | [`CHANGELOG.md`](../CHANGELOG.md) | ❌ 已发布段不改;`## Unreleased` 可改 | 版本变更追踪 |
| **运行 SOP** | [`docs/development.md`](development.md) / [`testing.md`](testing.md) / [`deployment.md`](deployment.md) / [`security.md`](security.md) / [`docs/ops/*.md`](ops/) | ✅ 按现实维护 | 运行 / 部署 / 测试操作手册 |
| **历史立项 / 评估** | [`docs/archive/plans/v1.3-plan.md`](archive/plans/v1.3-plan.md) / [`docs/archive/plans/v1.4-prisma7-evaluation.md`](archive/plans/v1.4-prisma7-evaluation.md) / [`docs/archive/plans/v2-design-phase/srvf-foundation-data-model-draft.md`](archive/plans/v2-design-phase/srvf-foundation-data-model-draft.md) | ❌ 归档,不回改 | 历史决策依据 |
| **本文件** | `docs/process.md` | ✅ 滚动维护 | 流程与协作制度 |

冲突优先级(沿 [baseline §14.4](srvf-foundation-baseline.md) / [V2 红线 §0.3](V2红线与复活路径.md)):

1. `ARCHITECTURE.md`
2. `CLAUDE.md` / `AGENTS.md` §1-§18
3. `docs/srvf-foundation-baseline.md`
4. `docs/V2红线与复活路径.md`
5. 单批次评审稿
6. `docs/handoff/v*.md`(历史快照,不抢现状)
7. `docs/current-state.md`(指针文档,只反映当前事实,不抢铁律)
8. 本文件 `docs/process.md`(流程制度,不抢架构)

发现高优先级文档与低优先级文档冲突 → 低优先级让步;不擅自调和,**暂停并向用户汇报**。

---

## 7. AI 协作规则

以下规则**优先级高于 AI 默认行为**,任何会话内都生效:

- **不把历史 handoff 当作"当前事实"** — 它们是 release 时刻快照,合入后即可能过期;当前事实以 [`docs/current-state.md`](current-state.md) + 代码 + GitHub 当前状态为准
- **open PR ≠ 0 时不开新任务**(release 收口阶段除外) — 先看 `gh pr list --state open` 是否为空
- **不自动启动下一 PR** — 每完成一份工作 / 一个 PR,必须停下等用户拍板下一动作
- **必须输出"本次未做"段** — 每次任务收尾必须显式列出"我没做的范围",防止 AI 自报完成
- **遇到 D / E 档必须降速** — 沿 §4 流程;**禁止**"顺手做"
- **不擅自修复审计 / 调研发现的问题** — 即使发现明显 bug 也不动手,除非本任务明确授权;先汇报
- **所有判断必须给证据** — 文件路径 / 行号 / 命令输出 / commit / PR 链接;**不要**凭印象
- **不擅自调和文档冲突** — 见 §6 冲突优先级;有疑问先暂停汇报
- **不主动展开未授权的次要任务** — 例如:本任务是"加 current-state",不要顺手归档 `FINAL_REPORT.md`;那是下一个 PR 的事
- **不输出任何 secret** — 不打印 `.env` 内容、不暴露真实 bucket / APPID / SecretId / SecretKey / signed URL / JWT 内容,即使在调研 / 审计 / 报告中

---

## 8. 收尾报告格式

每个任务结束,AI **必须**输出以下内容(简短即可,不重复写正文):

```markdown
## 修改文件清单
- 文件 1(新增 / 修改 / 删除;行数变化)
- 文件 2(...)

## 本次做了什么
- 简短列点,1-5 条

## 本次未做什么
- 显式列出"刻意没做的范围",例如:未打 tag / 未发 release / 未启动 RBAC / 未改 src/* / 未改 prisma/*

## 验证命令
- `pnpm lint` 结果(若跑)
- `pnpm typecheck` 结果(若跑)
- `pnpm test:e2e` 结果(若跑;说明跑或不跑的原因)
- `git diff --stat` / `git diff --check`

## 当前 open PR / Release 状态
- `gh pr list --state open` 结果
- `gh release list --limit 1` 是否需要变化

## 建议下一步(不自动启动)
- 是否需要创建 PR(给建议的 PR 标题,不自动创建)
- 是否需要 release / handoff / current-state 回填
- 是否需要用户拍板下一动作
```

---

## 9. 流程之外

本文件**不**承载:

- 接口契约(见 [`docs/v2-api-contract.md`](v2-api-contract.md))
- 数据模型(见 [`prisma/schema.prisma`](../prisma/schema.prisma) + [`docs/v2-data-model.md`](v2-data-model.md))
- 错误码段位(见 [`src/common/exceptions/biz-code.constant.ts`](../src/common/exceptions/biz-code.constant.ts) + [`docs/srvf-foundation-baseline.md §1.1`](srvf-foundation-baseline.md))
- 测试策略(见 [`docs/testing.md`](testing.md) + [`ARCHITECTURE.md §16`](../ARCHITECTURE.md))
- 部署策略(见 [`docs/deployment.md`](deployment.md) + [`docs/ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md))
- 安全策略(见 [`docs/security.md`](security.md))

如果本文件与上述权威源冲突,**本文件让步**。
