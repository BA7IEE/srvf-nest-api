# docs/ai-harness/ — AI Harness 操作页

> **性质**:derived 操作层,**非规则源**;规则入口 / 铁律速查 / 决策锁 / 触发即停全部在根 [`AGENTS.md`](../../AGENTS.md)(冲突时本页让步并回头修本页)。
> 恒读 = 根 [`AGENTS.md`](../../AGENTS.md) → [`current-state.md`](../current-state.md)(唯一权威表述在 AGENTS §0;[`process.md`](../process.md) 触碰才读)。v1 版本冻结于 [`../archive/harness-v1/ai-harness-README.md`](../archive/harness-v1/ai-harness-README.md)。

## 1. 开工命令

- **global**:`pnpm agent:preflight`(clean tree / 0 open PR / 未落后 origin/main 三硬判;**E 档收口必须用本形态**)
- **lane**:`pnpm agent:preflight --lane <lane名>`(lane 名必填,无名 / 非法名 exit 1;open PR 降为清单研判,写集冲突由总控裁;检测到 bump 特征硬拒走 global;协议全文 [`process §8`](../process.md))
- fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`;e2e 测试库两级派生:worktree 模板(`app_test_<slug>_<hash6>`,主仓恒 `app_test`)+ jest worker 克隆(`_w<N>`,并行隔离);孤儿库 `pnpm db:test:prune` 回收

## 1.5 机器执法层(Harness 3.0 P2;Claude 侧 hooks + 全执行体 lint)

> **规则语义零放宽,只换执法方式**。以下都是「物理上做不出来」,不是「文字上不许做」。

| 层 | 载体 | 覆盖执行体 | 违反时 |
|---|---|---|---|
| 语法级铁律(17 条 + 2 组禁引) | `eslint.harness.mjs` | **双模型**(任何人跑 `pnpm lint` / CI 都判) | lint error,文案含正确做法 |
| 红区路径写前拦截 | `.claude/hooks/redzone-guard.sh` | 仅 Claude(Codex 侧由 P2c 的 CI 守护兜底) | 拒绝写入 + 说明命中哪条 |
| Bash 写侧旁路 | `.claude/hooks/bash-write-guard.sh` | 仅 Claude | 拒绝 `sed -i` / `>` / `cp` 等绕道 |
| 开工门禁 | `preflight-gate.sh`(SessionStart 写通行标记)+ `preflight-required.sh`(PreToolUse 校验) | 仅 Claude | **硬条件**未过则写操作被拒(只读不受限);咨询条件只提示 |

**门禁的两类条件**(process §2 的三硬判是「开工前别在这些状态下**开新功能**」,不是「每次写文件都查」——把它们一律升为拦写会让连续开发从第二次写入起卡死):

| 条件 | 判定 | 理由 |
|---|---|---|
| 依赖 / Prisma 生成物陈旧 | **拦写** | 会爆几百个 unsafe-* 假错,此时写代码必然踩坑 |
| 落后 origin/main | **拦写** | 在过时的基础上改代码 |
| preflight 脚本不可用 | **拦写**(fail-closed) | 无法验证 ≠ 通过 |
| 工作树非 clean | 提示 | 开发中本来就脏 |
| 存在 open PR | 提示 | 连续推进的常态(与 lane 模式语义一致) |

标记过期按**分支名**判(会话内提交会改 HEAD,按 sha 判则每 commit 一次全线卡死);仓库外文件不受本仓门禁管。

**红区清单唯一机读源**:[`harness/redzone.json`](../../harness/redzone.json)(hook / 未来 CI 守护 / CODEOWNERS 三处共享;自身在裁判保护内)。

**触碰红区时的正确流程**:出人话简报 → 维护者拍板 → **由维护者**执行

```bash
pnpm harness:grant '<glob>' --reason "<拍板出处>"   # 授权(令牌在 .git/ 内,本 worktree 私有、不入库)
pnpm harness:grant --list                          # 查看当前授权
pnpm harness:grant --clear                         # 用完撤销
```

AI 不得自行发放授权 —— 自己给自己开通行证,这道闸就没有意义。**本地令牌只解开「能不能写」,不解开「能不能合」**:改动执法层的 PR 另需 GitHub `harness-review` 环境审批。

**自测(证明防线真的存在)**:`pnpm harness:selftest` = 守护不变式 + lint 阳性对照 + hook 行为三份(条数以实际输出为准,不在此重复以免漂移)。
中间那份专防「selector 写错导致规则永不触发」,最后那份专防「hook 用了 `exit 1`」——
⚠️ Claude Code 只把 **exit 2** 当阻断,`exit 1` 会被当成非阻断错误**直接放行**,那样拦截只存在于纸面。
三份都遵循同一原则:**喂必定违规的样例断言真被拦 + 喂合法样例断言不误杀**。只测前者会漏掉误伤,而误伤到让人绕过的程度,防线同样失效。

## 1.6 派生文档:生成而非手维(Harness 3.0 P4)

> **镜像反转**:过去是「人写镜像给 AI 读 + 脚本检测漂移」;现在是「AI 从代码生成给人看 + CI 强制新鲜度」。
> 「检测漂移」本身是在给一个不该存在的问题打补丁 —— 派生文档只是代码的视图,不该是独立事实源。

| 文档 | 生成命令 | 新鲜度守护 | 人类保留部分 |
|---|---|---|---|
| [`RBAC_MAP.md`](RBAC_MAP.md) 派生段 | `pnpm docs:rbacmap` | `pnpm docs:rbacmap:check`(重新生成并比对) | 双轨架构叙事 / 保护不变式 / 缺口与冻结存量 / AI 硬规则 |
| [`ROUTE_AUTHZ.md`](ROUTE_AUTHZ.md) **整份** | `pnpm docs:authz` | `pnpm docs:authz:check`(重新生成并比对) | 无 —— 头注即写 "Do not hand-edit" |

RBAC_MAP 的生成段夹在 `<!-- rbac:begin -->` / `<!-- rbac:end -->` 之间,**禁手改**(改了新鲜度校验当场红,并提示跑生成命令);ROUTE_AUTHZ 没有人类保留段,任何手改都会被 `docs:authz:check` 判红。
权威源:权限码 → `prisma/seed.ts`;controller 前缀 → `@Controller` 装饰器;路由授权声明 → controller 内的规范化声明(`normalizeRouteAuthzDeclaration`)。

RBAC_MAP 的 75 行逐 PR 历史「戳」已归档至 [`archive/ai-harness/rbac-map-stamps.md`](../archive/ai-harness/rbac-map-stamps.md) —— 那是与 CHANGELOG 重复的历史叙事,读者要得出「现在权限长什么样」却必须在脑内折叠全部戳;现状已可直接生成,故戳不再占据理解路径。

## 2. 守护命令

以下十二条同挂 CI 的 **Fast checks** job,且**不随 docs-only 短路**(lint / typecheck / build / unit 会因 docs-only 跳过,守护步骤不会 —— 否则 docs PR 恰好绕开了守 docs 的那些检查):

| 命令 | 守什么 | 阻断 |
|---|---|---|
| `pnpm docs:readtax:check` | 恒读层体积预算 | ✅ |
| `pnpm docs:counts:check` | current-state §1 事实计数 | ✅ |
| `pnpm docs:codemap:check` | CODEMAP 新鲜度(逐字 diff)+ 结构漂移 | ✅ |
| `pnpm docs:rbacmap:check` | RBAC_MAP 生成段新鲜度 + 结构 | ✅ |
| `pnpm docs:openapi:check` | `docs/handoff/openapi.json` 契约新鲜度 | ✅ |
| `pnpm docs:feclient:check` | `docs/handoff/clients/**` FE client 新鲜度 | ✅ |
| `pnpm docs:boundaries:check` | A 类 metadata 完整性(R1/R4/R7/R10) | ✅ |
| `pnpm docs:boundaries:ids:check` | 已登记债务的 call-site 身份仍解析得开 | ✅ |
| `pnpm docs:authz:check` | ROUTE_AUTHZ manifest 新鲜度 | ✅ |
| `pnpm gate:authz:graph:check` | R14 蕴含图注册表完整性 | ✅ |
| `pnpm docs:boundaries` | R5/R6 边界违规观察(B 类) | ❌ report |
| `pnpm harness:servicesize` | 大 service 尺寸棘轮(Phase 6-A) | ❌ report |

末两条是 report 期项目,各由**一个** `|| true` 兜住(全 workflow 恰这两处);脚本本身有发现即退出 1,所以转 blocking = 删掉那一行,一行,且不可能只翻一半。

守卫的守卫(`pnpm harness:selftest` / `pnpm harness:replay`)同在该 job,见 §1.5。

**不在 Fast checks 的两类**(把它们并进上表就是假读数):

- **base-trusted 语义门**:`pnpm gate:authz:semantic`(R14 授权)/ `pnpm gate:contract:semantic`(R11 契约)。本地形态只是**自查**;权威裁决恒在 `.github/workflows/redzone-trusted.yml`,用 **base 分支**的判据跑 —— PR 改不动自己的裁判,代价是新门合入后的下一个 PR 才真跑。详见 [`SEMANTIC_GATES.md`](SEMANTIC_GATES.md)。
- **本地专用,未接 CI**:`pnpm docs:boundaries:debt:check`(债务台账语义字段完整性)。

CHANGELOG fragment 归并:`pnpm changelog:merge`(bump 前,总控执行;是流程步骤,不是守护)。

## 3. 定位路径

[`current-state.md`](../current-state.md) →(领任务)→ 根 [`CODEMAP.md`](../../CODEMAP.md)(src 模块地图)→ 模块级 `CLAUDE.md`(`src/modules` 20 个 + `prisma` 1 个,动模块时顺手校准)→ 改权限再读 [`RBAC_MAP.md`](./RBAC_MAP.md)。读写分区 / 红区清单 / 触发即停见 `AGENTS.md §3`;细则按 `AGENTS.md §6` 索引触碰才读。**勿整读**:`docs/archive/**` 正文、contract snapshot(~3.6 万行,用 diff)、`pnpm-lock.yaml`。

## 4. 目录说明

本目录按**维护方式**分三组 —— 三组的写入权、更新时机、能不能手改各不相同,动手前先认组。
(不写"恰 N 文件":那个数字本身会漂,而且漂了没人知道 —— 2026-08-15 本节从"恰 4 文件"true-up 时,实际已是 11 个。)

### 4.1 操作页(人手维护,读者入口)

| 文件 | 内容 |
|---|---|
| [`README.md`](README.md) | 本页:开工命令 / 执法层 / 派生文档 / 守护命令 / 定位路径 / 目录说明 |
| [`codex-review-sop.md`](codex-review-sop.md) | 跨模型评审 SOP(何时评审 / 投放模板 / findings 处置);协议条文在 [`process §8.3`](../process.md) |
| [`NEXT_TASKS.md`](NEXT_TASKS.md) | 后续任务清单(P0/P1/P2);逐项单独立项,**AI 不自动启动**(process §7) |
| [`FROZEN_DRAFTS.md`](FROZEN_DRAFTS.md) | **冻结稿落地台账**:已拍板冻结的施工依据还欠多少 —— §1 逐项欠账 / §2 机器读数(生成块,手改即红)/ §3 归档评审稿全量四值分类。判据 `scripts/check-frozen-drafts-ledger.ts` 守「不许有未分类项」+「读数不过期」(`src/frozen-drafts-ledger.criteria.spec.ts` 是薄运行器);刷新读数 `pnpm exec tsx scripts/check-frozen-drafts-ledger.ts --write` |
| [`CAPABILITIES.md`](CAPABILITIES.md) | 能力台账(各能力终态摘要 + **已部署/未部署**);2026-08-20 从 `current-state.md` §2 迁出 —— 那份在恒读层、每字符付恒定成本,本份不付。**新增能力条目写这里** |
| [`SIXTH_REVIEW_SCOPE.md`](SIXTH_REVIEW_SCOPE.md) | 第六轮全仓评审的**范围切分与投放包**(`v0.66.0..main` 切 6 包,含投放顺序与逐包「重点问过」);**工作计划非冻结件**,评审结论产出后另立冻结件入 `archive/reviews/` |

### 4.2 派生地图(生成物,手改即红)

| 文件 | 生成 / 守护 |
|---|---|
| [`RBAC_MAP.md`](RBAC_MAP.md) | 派生段 `pnpm docs:rbacmap` 生成 · `docs:rbacmap:check` 守护;人类保留段见 §1.6 |
| [`ROUTE_AUTHZ.md`](ROUTE_AUTHZ.md) 🔒 | **整份**由 `pnpm docs:authz` 生成 · `docs:authz:check` 守护;同时是 R14 授权语义门的比对对象 |

### 4.3 治理报告(架构治理 v4 各 Phase 的取证留痕;写就即固定,不再生)

| 文件 | 阶段 / 内容 |
|---|---|
| [`BASELINE_HEALTH.md`](BASELINE_HEALTH.md) 🔒 | Phase 0:main 一次冷跑的健康基线,后续 "zero-new-red" 的对照起点 |
| [`EXTERNAL_IO_INVENTORY.md`](EXTERNAL_IO_INVENTORY.md) 🔒 | Phase 0:外部 I/O 盘点(宪法 C7 观察表) |
| [`BOUNDARY_OBSERVATIONS.md`](BOUNDARY_OBSERVATIONS.md) | Phase 2:R5/R6 边界观察 + 跨属主写债务台账(report-only) |
| [`SCANNER_AST_MIGRATION.md`](SCANNER_AST_MIGRATION.md) | Phase 3 前置:三扫描器 typed-AST 化的能力对比与 R8 重扫 |
| [`SEMANTIC_GATES.md`](SEMANTIC_GATES.md) | Phase 5:R14 / R11 / FE client 三道语义门收口 |
| [`SERVICE_SIZE_RATCHET.md`](SERVICE_SIZE_RATCHET.md) | Phase 6-A:大 service 尺寸棘轮立闸(NCLOC 口径 / 基线 / Exit Criteria) |
| [`SERVICE_SIZE_GROWTH_ATTRIBUTION.md`](SERVICE_SIZE_GROWTH_ATTRIBUTION.md) | Phase 6-B 诊断:增长按 D-7 六类 / 事务编排层归因(逐域表 / members 对照组 / 拆分收益结论) |
| [`STATE_MACHINE_INVENTORY.md`](STATE_MACHINE_INVENTORY.md) | Phase 4-1a:R10 状态机登记完备化(56 列三层分布 / governedBlockers 聚合 / 8 机形状差异 / 老表零 CHECK) |
| [`COMMON_GOVERNANCE.md`](COMMON_GOVERNANCE.md) | R15:`src/common` 治理(结构性零执法根因 / 三条判据与发现数 / 12 子目录定性 / 存量三件复核) |

🔒 = 该文件在 [`redzone.json`](../../harness/redzone.json) 的 `selfGuard` 内,改动需维护者 `pnpm harness:grant` + `harness-review` 环境审批。

**往本目录放新文件的义务**:同一个 PR 里把它加进上面三张表之一 —— 这条**有执行位**,不是文字要求:`pnpm docs:codemap:check` 的 `ai-harness-index-complete` 双向比对本节清单与目录实际文件,任一方向不符即 **FAIL**(它跑在 CI Fast checks 里,且不随 docs-only 短路)。§4 标题被改名或删除同样 FAIL —— 无法验证 ≠ 通过。

治理报告是本目录增长最快的一类(Phase 0→6 六份),本节此前正是这样漂成"恰 4 文件"的:少登记一条**不产生任何坏链接**,所以既有的 `referenced-paths-exist` 十一次都没响。

本目录更新一律走 A 档 PR(权限**事实**变更本身是 D 档,本目录只能事后 true-up);沿 process §6"无守护不留",不再新增无守护的派生地图。2026-06-10 Review 冻结档在 [`../archive/ai-harness/`](../archive/ai-harness/)。
