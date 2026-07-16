# SRVF API 开发流程与协作制度

> 本文件规定 **AI / Claude Code / 维护者** 在本仓库内如何开工、分级、降速、收口、release。
> 不重述架构铁律(见 [`ARCHITECTURE.md`](../ARCHITECTURE.md) / [`AGENTS.md`](../AGENTS.md));不重述当前事实(见 [`current-state.md`](current-state.md))。冲突时**架构铁律优先**,本文件让步。

---

## 1. 本文用途

- 本文**不是**架构设计文档 / handoff / 当前状态入口(分别见 `ARCHITECTURE.md` / `docs/archive/handoff/` / `current-state.md`)
- 本文规定:**怎么开工、怎么分级 PR、怎么降速、怎么收口 release、怎么处理文档权威源、AI 怎么协作(含 goal 模式)**

---

## 2. 开工前 checklist

任何新任务开始前(无论 AI 自动启动还是用户驱动),**必须**依次确认:

```bash
pnpm agent:preflight                       # 硬判:工作树 clean / 无 open PR / 未落后 origin/main(任一不过 exit 1);版本三方 / 分支 / worktree 等只读打印供人工研判
grep -n "current-state" README.md          # README 启动入口仍指向 current-state
grep -A 3 "^## Unreleased" CHANGELOG.md    # Unreleased 段状态
```

判断:

- **open PR ≠ 0** → 不开新功能(先合并 / 关闭 / 与维护者对齐);release 收口阶段除外(见 §5)
- **工作树不 clean** → 不开新功能(先 commit / stash / 与维护者对齐)
- **版本三方不一致**(`package.json` / Swagger `setVersion` / git tag)→ 进入 release 收口或修正,不开新功能
- **CHANGELOG `## Unreleased` 段仍有未释放变更而 main HEAD 已超过该 release** → 进入 release 收口
- **没有 `docs/current-state.md`** → 先建立,再开始任何任务

fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`,否则 `typecheck` 报 Prisma 假错误。

**lane 形态**(Harness 2.0):并行执行 lane 会话开工用 `pnpm agent:preflight --lane`(clean tree 与未落后 origin/main 仍硬判;open PR 降为清单打印,写集冲突由总控研判);**E 档 release 收口必须用 global 模式**(全仓 0 open PR)。lane 协议全文见 §8。

---

## 3. PR 分级制度

每个 PR 在打开前先判定档位,**不混档**。

| 档位 | 范围 | 例子 | 必跑检查 | 用户拍板 | 连续推进 |
|---|---|---|---|---|---|
| **A 档** | docs-only;无 `.ts` / `.prisma` / `.yml` / `.json` 变动 | 改 README / CHANGELOG Unreleased | (可省;动地图 / 链接 → `docs:codemap:check` + `docs:rbacmap:check`) | ❌ | ✅(一次会话多 A 档可串行) |
| **B 档** | 代码小修(无新 endpoint / DTO 字段增减 / schema / enum / error code 增减) | 内部重构 / 注释 / 单测补强 | `pnpm agent:check:quick` + 受影响模块 e2e(`pnpm test:e2e -- <spec名>`) | ❌(常规) | ✅ |
| **C 档** | API 行为变化(新 endpoint / DTO 字段增减 / 错误码增减 / 响应语义变化 / 新 Guard 装饰器) | 加新接口 / 接口入参变更 | `pnpm agent:check:full`;snapshot diff 必须逐行可解释 | ✅(范围已含于用户任务说明 / goal → 免二次确认;AI 自行发起仍须动手前确认) | ⚠ 单 PR 评审 |
| **D 档** | schema / migration / permission seed / Role enum / 鉴权 / 存储 / 凭证 / audit / 不可逆变更 / 安全相关 | 新建表 / 加 unique / seed 改动 / 加密策略 | `agent:check:full` + 评审稿 / 立项 / 影响面分析 + handoff 段落;对应 `srvf-*` skill 必读 | ✅ + 评审稿冻结 + 立项记录 | ❌ 必须分 PR |
| **E 档** | release / handoff / tag / GitHub Release / version bump | bump PR / handoff PR / tag + GitHub Release 收口 | `agent:check:full` + handoff 验收锚点;沿 `srvf-release-closeout` skill | ✅ | ❌ 强串行 |

组合命令:`agent:check:quick` = lint + typecheck + unit(无 DB);`api` = quick + `test:contract`;`full` = api + `nest build` + `test:e2e` 全量(`build` 仅 full,typecheck 后串入、与 CI 一致,拦"typecheck 过但 build 挂"的隐性回归)。contract / e2e 需本地 Docker PostgreSQL(`docker compose up -d postgres` + `pnpm db:test:init`);**无 Docker 时跑 quick 并显式声明"contract / e2e 留给 CI",不得谎报全绿**。

档位归属规则:

- 一个 PR 同时改 `.md` + `.ts` 实现 → 按更高档位算
- 改 `prisma/schema.prisma` 或 `prisma/migrations/**` 或 `prisma/seed.ts` → **必然是 D 档**
- 改 `.github/workflows/**` → **必然是 D 档**(CI / smoke 影响所有 PR)
- 改 `package.json` 依赖项 → **必然是 D 档**(运行时 / 构建影响)
- 改 `src/bootstrap/apply-swagger.ts` 的 `setVersion(...)` → **E 档**(版本 bump)

---

## 4. D 档降速规则

遇到以下**任一**特征,必须降速:

- 修改 `prisma/schema.prisma` / 增加 `migrations/`;修改 `Role` / `Permission` / seed 中任何 Permission code / RolePermission 映射
- 修改登录 / JWT / `auth.service.ts` / `JwtStrategy`;修改 `StorageProvider` / COS / 凭证加密 / `STORAGE_ENCRYPTION_KEY`
- 修改 `audit_logs` 任何字段 / 任何 `AuditLogEvent` union 项
- 物理删除任何业务数据 / 批量回填 / 数据迁移脚本
- release / tag / GitHub Release;跨模块大范围重构 / 拆分 service
- 改全局 Guard / Interceptor / Filter / ValidationPipe / `ResponseInterceptor` 跳过列表
- 修改 `BizCode` 段位语义(新增 BizCode 仍要登记段位,但不视作降速)

降速流程:**①只读调研**(不动代码)→ **②风险表**(影响模块 / 测试 / 已发版本 / 用户可见行为)→ **③方案 A / B 对比**(含回退条件)→ **④用户拍板**(按 §4.1 提交)→ **⑤(必要时)评审稿冻结 + 立项**(沿 `docs/archive/batches/` 范式,冻结不回改)→ **⑥再实施**(范围与拍板一致,**不夹带**)。

**铁律**:D 档**禁止**"顺手做"——任何超出本 PR 范围的"看起来该一并修的小问题",必须另开 PR(可立项后再做)。

### 4.1 确认请求标准格式(人话简报)

C / D 档确认、goal 模式中途新发现问题的上报,一律用本格式提交对话:

```markdown
## 需要拍板:<一句话标题>
- 人话简报·做什么:<一句话>
- 人话简报·不做会怎样:<一句话>
- 人话简报·最坏情况与回退:<一句话>
- 推荐方案:<A / B>;用户回**"按推荐"**即生效
- 背景:<现状 + 证据(路径:行号)>;触发规则:<§3 档位 / §4 特征 / current-state §3 某项>
- 影响面:<模块 / 测试 / 已发版本 / 用户可见行为>
- 方案 A(推荐):<内容 + 回退条件>;方案 B:<内容 + 回退条件>
- 不动代码承诺:拍板前仅做只读调研
```

顶部三行 + 推荐方案是维护者的最低阅读量;用户回"按推荐"即为有效拍板;下方各行保留为完整依据。

---

## 5. release 收口制度

> 默认节奏:**0.x 阶段一律 minor**(沿 v0.4.0 → ... 全部 minor)。真正的 breaking change 或 1.0 进入再考虑 major / patch。

### 5.1 收口分阶段(逐步推进,**不混 PR**)

| 阶段 | PR / 动作 | 谁来做 | 是否动代码 |
|---|---|---|---|
| 1 | feature PR(本期所有业务变更) | AI + 维护者授权 | ✅ |
| 2 | CHANGELOG Unreleased 增量登记 | 随 feature PR 或独立 docs PR | ❌ |
| 3 | landing PR(本期跨文档事实同步) | AI | ❌ |
| 4 | **bump PR**(仅 3 文件:`package.json` / `apply-swagger.ts` / `CHANGELOG.md` 折叠) | AI | ✅ |
| 5 | **handoff PR**(新建 `docs/archive/handoff/v0.X.0.md`) | AI | ❌ |
| 6 | **git tag**(`v0.X.0`,指向 handoff squash commit) | AI 执行,维护者亦可手动 | — |
| 7 | **GitHub Release**(标 Latest;Notes 抽自 CHANGELOG 对应段;完成后输出 `gh release list` 证据) | AI 执行,维护者亦可手动 | — |
| 8 | **current-state 回填** + README 入口对齐 | AI | ❌ |
| 9 | open PR / 远端分支清理 | AI + 维护者 | — |

### 5.2 关键约束

- **tag 默认指向 handoff PR 的 squash merge commit**,除非用户另行拍板
- **handoff 是历史快照,合入后不回改**;发现过时 → 更新 `current-state.md`,不回改 handoff
- release 后必须回填 `current-state.md`(§1 / §2 / §4);README 启动入口保持指向 `current-state.md`
- **bump PR 只允许动 3 文件**(`package.json#version` / `apply-swagger.ts` `setVersion` / CHANGELOG 折叠),**禁止**夹带其他改动
- **bump 前**:`changelog.d/` 有 fragment 时先 `pnpm changelog:merge` 归并进 `## Unreleased`(Harness 2.0;单 lane 直接编辑 Unreleased 的旧路径不废除)

### 5.3 release 后回填 checklist

- [ ] 更新 `current-state.md §1`(main HEAD / tag / release Latest / open PR)、§2(新增能力)、§4(债务增减)
- [ ] **不**回改 `docs/archive/handoff/v0.X.0.md`(它就是阶段快照)
- [ ] 检查 [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) 顶部"基线版本"是否需要刷新
- [ ] `git ls-remote --heads origin` 与 main 对齐;无残留分支

### 5.4 Squash merge 与清理硬约束

> 完整教程版(逐步命令 + 原理 + 报告模板)见 git 历史 `git show db68ccd:docs/process.md`;条目 **1-8 与原 §5.4.1-§5.4.8 一一对应**。拿不准 → 停下报告;**禁止**"先合再补审计"。

1. **合并前确认**(全过才许 merge):主仓在 main 且 `status --short` 为空;`gh pr list` 只剩目标 PR;`gh pr view` 为 `OPEN / isDraft=false / MERGEABLE / CLEAN`;`gh pr checks` 全绿;`gh pr diff --name-only` 落在本任务白名单内;记录 headRefName。
2. **执行**:`gh pr merge <PR> --squash --delete-branch`;**禁止**改用 `--merge` / `--rebase` 绕开失败。**可选 auto 形态**(2026-06-11 起,main 已设分支保护):条 1 五项中"`gh pr checks` 全绿"已由 GitHub required status checks(`Lint / Typecheck / E2E` + `Docker image build`,`enforce_admins=true`)强制兜底,**其余四项**确认后可在 CI 进行中即执行 `gh pr merge <PR> --auto --squash --delete-branch`,GitHub 于全绿后自动合并(绿前 `mergeStateStatus=BLOCKED` 属预期,不算条 1 失败);合并达成后**照常执行条 3-6**,不得省略。注记:main 分支保护已启用(2026-06-11),**直推 main 被 GitHub 拒绝属预期**,一切变更必须走 PR;`--admin` 绕过合并要求沿第 7 条禁止清单语义,非用户当次明确授权不得使用。**exit 非 0 ≠ 失败**:先 `gh pr view <PR> --json state,mergedAt,mergeCommit`——`MERGED` = squash 已成功(常为删分支阶段失败),**不得重跑 merge**,直接进第 3 步;`OPEN` = 真失败,按 checks 排查后重跑,不强合。
3. **main 同步**:`git pull --ff-only origin main`;失败说明本地 main 已偏离远端,停下报告;**禁** `pull --rebase` / 默认 merge / `git reset --hard origin/main`。
4. **远端分支核验**:`git ls-remote --heads origin <branch>` **看 stdout 不看 exit code**(无匹配也 exit 0);stdout 非空才 `push origin --delete`,删后复跑确认为空;只许删**本任务目标 head 分支**,禁删 main / 受保护 / 其它任务分支。
5. **worktree 清理**(顺序:确认 clean → remove → 删分支):`status --short` 非空 → 立即停下报告,**禁** `worktree remove --force`;**唯一特例**:输出仅 `?? .DS_Store` 时允许 `rm` 后复查为空再继续,**不得**借此处理任何其它 untracked / dirty 内容;非本任务 worktree 一律不动。
6. **squash 后 `branch -d` 报 `not fully merged` 属预期**(`-d` 判 ancestry 非 patch 等价);**禁止直接 `-D`**,先过 patch-equivalence 五项(缺一即停):① PR `state=MERGED`;② `diff --stat main..<branch>` 本分支 0 新增;③ `diff main..<branch> -- <changed-files>` 无语义差异;④ `log --left-right --cherry-pick main...<branch>` 的 `>` 方向为空或均有等价 patch;⑤ blob hash(`ls-tree`)两侧一致。全过才许对**本任务目标分支**(且仅它)`-D`;`>` 方向含未推送实际改动 → 停下报告,不强删。
7. **禁止清单**(除非用户在本会话内、看到具体风险描述后**再次**明确授权):`git reset --hard`(任意 ref)/ `git push --force` 与 `--force-with-lease` / `git worktree remove --force` / 批量或通配 `git branch -D`(含 `claude/*`、glob、`for` / `xargs` 批删)/ 清理非本任务的 worktree、来源未确认的孤立分支、非本任务远端分支 / 跳过本节任一步骤。
8. **收尾记录**:合并与清理结果(merge state / main HEAD / ls-remote 复核 / worktree 与 branch 处置 / patch-equivalence 输出)及任何第 7 条授权(时点 / 动作 / 结果)记入 §9 收尾报告。

---

## 6. 文档权威源制度

| 类型 | 文件 | 允许回改? |
|---|---|---|
| **当前状态入口** | [`docs/current-state.md`](current-state.md) | ✅ 滚动维护 |
| **架构铁律(蓝图)** | [`ARCHITECTURE.md`](../ARCHITECTURE.md) | ⚠ 谨慎改,用户拍板 |
| **AI 铁律(主入口)** | [`AGENTS.md`](../AGENTS.md)(`CLAUDE.md` 为入口转发,非规则源) | ⚠ 非用户授权不动 |
| **V2 基线** | [`docs/srvf-foundation-baseline.md`](srvf-foundation-baseline.md) | ⚠ 非用户授权不动 |
| **V2 红线** | [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) | ✅ 滚动维护 |
| **历史 handoff / 冻结批次评审稿** | [`archive/handoff/`](archive/handoff/) / `archive/batches/` | ❌ 合入 / 冻结后不改 |
| **harness v1 快照** | [`archive/harness-v1/`](archive/harness-v1/) | ❌ 冻结不回改 |
| **release 记录** | [`CHANGELOG.md`](../CHANGELOG.md) | ❌ 已发布段不改;`## Unreleased` 可改 |
| **运行 SOP** | `docs/{development,testing,deployment,security}.md` / [`ops/*.md`](ops/) | ✅ 按现实维护 |
| **历史立项 / 评估** | `docs/archive/plans/**` | ❌ 归档,不回改 |
| **本文件** | `docs/process.md` | ✅ 滚动维护 |

冲突优先级:**全仓唯一副本在 [`AGENTS.md §0`](../AGENTS.md)**,本文件不再维护第二份;高低冲突低让步、不擅自调和、**暂停汇报**的原则不变。

**派生文档两原则**(2026-06-10 拍板):

- **无守护不留**:长期派生文档(地图 / 对照表 / 矩阵)必须有自动守护(`docs:codemap:check` / `docs:rbacmap:check` / contract 断言等);无守护、靠人肉对账的派生文档**不再新增**,存量裁撤或并入权威源。
- **守护溯及恒读层自身**(Harness 2.0):`docs:readtax:check`(体积预算)与 `docs:counts:check`(事实计数)把"无守护不留"应用到 AGENTS / current-state / CLAUDE 三件恒读文件。
- **模块级 CLAUDE.md 唯一例外**:8 个模块级 `CLAUDE.md`(7 个 src 模块 + `prisma/`)无自动守护但保留;**动到对应模块时顺手校准**,不单独立项。

---

## 7. AI 协作规则

以下规则**优先级高于 AI 默认行为**,任何会话内都生效:

- **不把历史 handoff 当作"当前事实"** — 它们是 release 时刻快照;当前事实以 [`current-state.md`](current-state.md) + 代码 + GitHub 当前状态为准
- **open PR ≠ 0 时不开新任务**(global 语义;并行 lane 形态按 §8 以写集研判;release 收口阶段除外)
- **已立项 / 已授权任务清单内可连续推进下一 PR;清单外不得** — 清单内按序推进不逐项再问;清单外任何新工作停下等拍板
- **必须输出"本次未做"段** — 每次收尾显式列出"没做的范围",防止 AI 自报完成
- **遇到 D / E 档必须降速** — 沿 §4;**禁止**"顺手做"
- **不擅自修复审计 / 调研发现的问题** — 即使发现明显 bug 也不动手,先汇报
- **所有判断必须给证据** — 文件路径 / 行号 / 命令输出 / commit / PR 链接;不凭印象
- **不擅自调和文档冲突**(见 §6 优先级);**不主动展开未授权的次要任务**
- **不输出任何 secret** — 不打印 `.env` / bucket / APPID / SecretId / SecretKey / signed URL / JWT 内容,即使在调研 / 报告中

### 7.1 goal 协作模式(连续推进的授权形态)

- **goal 文本 = 立项 + 拍板凭据**:维护者下发的 goal 同时构成立项记录与档位拍板(含预拍板的 C 档范围);AI 在 goal 清单内沿 §7 连续推进,无须逐 PR 回头确认。
- goal 文本**最低要求**五要素:终态定义(DoD,逐条可核验)+ 探针驱动的幂等任务队列(每项有"探针未满足才做"判据)+ 授权清单 + 禁止域 + **写集声明**(本 goal 允许触碰的模块 / 文件范围;总控排班与集成 diff 白名单核对的依据)。五要素不齐 → 按普通任务说明处理,不享连续推进。
- **C 档及以上 feature 默认以 goal 形态立项**(`srvf-goal-author` 起草;A/B 档小任务可免)。
- **C / D 档确认**:goal 内已写明范围的 C 档免二次确认;goal 外新发现的 C / D 档问题一律按 §4.1 人话简报上报,**不顺手修**。
- **失败与熔断**:同一失败修复 ≤2 轮;需越权才能绿 → 人话简报后转下一项;连续 2 轮零推进 → 熔断停机报告。
- **CI 等待期惯例**:PR 提交后等待 CI 期间不闲等——做下一阶段的只读预研 / 报告草稿(不动代码、不开下一个 PR);`gh pr checks --watch` 早退或 `gh` 401/网络抖动时,先 `gh auth status` 自检,再降级为轮询 `gh pr checks`(间隔 ≥60s)直至终态,不得借等待之名跳过 §5.4 任何一步。
- **报告**:每轮输出轮末报告(含"本次未做"段);终态达成后输出 goal 约定的终版报告;格式沿 §9。

---

## 8. lane 并行协议(Harness 2.0)

> 公理与终态设计见 T0 评审稿 [`harness-2.0-t0-review.md`](archive/reviews/harness-2.0-t0-review.md);恒读摘要在 [`AGENTS.md §4`](../AGENTS.md)。
> 形态:**1 总控 + ≤3 执行 lane,"并行开发、串行集成"**;执行体必须是维护者可见的会话窗口 + 独立 worktree + 独立 PR(**写者唯一**);禁止嵌套后台写码代理(只读检索子代理不限)。

### 8.1 总控职责

- 立项与出 goal(五要素,§7.1);按**写集声明**排班:写集相交或同一 bounded context → 不并行(合并 goal 或排队)
- 持有 **migration token**:同一时刻至多一条 schema-touching lane(随 D 档拍板授予)
- 串行集成,逐 PR:rebase → contract snapshot 复核(diff 逐行可解释)→ `agent:check:full` → `gh pr diff --name-only` 落写集核对 → squash 合并(沿 §5.4)→ 通知其余 lane rebase
- 独占 E 档(release / tag / bump / current-state 回填)与 `pnpm changelog:merge`
- **唯一简报流**:各 lane 拍板项汇总为一份人话简报(§4.1);执行 lane 不直接向维护者请求拍板
- 总控不写业务代码

### 8.2 执行 lane 职责

- 开工 `pnpm agent:preflight --lane`;fresh worktree 先 install + `prisma:generate`;e2e 测试库自动派生 `app_test_<worktree slug>`(主仓恒 `app_test`)
- goal 授权内自治推进 B/C 档;D 档新发现按 §4.1 上报总控,**不顺手修**
- CHANGELOG 登记走 `changelog.d/<branch>.md` fragment(单 lane 场景直接编辑 Unreleased 的旧路径不废除)
- 交付 = 分支 + PR(body 按 `.github/pull_request_template.md`:档位 / 写集声明 / 本次未做 / 验证);沙箱无 `gh` 时交分支与 PR 文案,由总控代开
- lane 卡死 / 跑偏 / 失忆 → 弃 worktree、新窗口重贴同一 goal(探针幂等保证可重入)

### 8.3 跨模型互查

- 写与查跨模型:Claude 写 → Codex 评审;Codex 写(限 A/B 档)→ Claude 评审;操作 SOP 见 [`ai-harness/codex-review-sop.md`](ai-harness/codex-review-sop.md)
- findings 统一落 PR 评论;**分歧不内部调和**,原样升级进总控简报由维护者裁

### 8.4 硬边界

- **E 档收口必须 global preflight 全过**(全仓 0 open PR);schema lane ≤1;执行 lane ≤3
- 某 lane 合入后,其余在飞 lane 必须 rebase 后再推进(lane preflight 会硬判落后)
- 集成合并受 branch protection required checks 兜底;红区 / D 档 PR 仍须维护者拍板,lane 形态不改变档位语义

---

## 9. 收尾报告格式

每个任务结束,AI **必须**输出以下内容(简短即可,不重复写正文):

```markdown
## 修改文件清单(新增 / 修改 / 删除;行数变化)
## 本次做了什么(1-5 条)
## 本次未做什么(显式列出刻意没做的范围,如:未打 tag / 未启动 RBAC / 未改 src/*)
## 验证命令(`agent:check:quick` / `full` 结果;不跑说明原因;`git diff --stat`)
## 当前 open PR / Release 状态(`gh pr list --state open` / `gh release list --limit 1`)
## 建议下一步(不自动启动;是否需要 PR / release / 回填 / 用户拍板)
```

---

## 10. 流程之外

本文件**不**承载:接口契约(Swagger `/api/docs` + contract snapshot)、数据模型(`prisma/schema.prisma`)、错误码段位(`biz-code.constant.ts` + baseline §1.1)、测试 / 部署 / 安全策略([`testing.md`](testing.md) / [`deployment.md`](deployment.md) / [`security.md`](security.md) / [`ops/`](ops/))。

如果本文件与上述权威源冲突,**本文件让步**。
