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

## 1.7 生成物刷新:**实测**依赖图与一次性全刷入口

> 2026-08-24 一天内同一形态复发 **7 次**:改了源、只刷了一部分生成物,剩下的到 CI 才红 ——
> ①改 catalog 一行中文字符串(两份过期)②改 DTO 文案只刷了 openapi(三份)③刷完 contract 快照没刷下游(三份)
> ④ v0.68.0 发版脚本刷版本号(两份)⑤ PR 8 刷完生成物又改 catalog(authz)
> ⑥改 `src/modules/**/CLAUDE.md`(当时判成 authz 过期)⑦ v0.69.0 发版刷版本号(两份)。
> 当时的补救办法只是一句口诀「顺序是 openapi → clients → authz → codemap」——
> **本节的全部内容是实测出来的,不是那句口诀。口诀经实测有错,逐条见下。**

**入口**:`pnpm docs:refresh`(= `tsx scripts/refresh-generated-docs.ts`;刷新集合从 `package.json` **现算**,不维护第二份名单)
`pnpm docs:refresh --dry-run` 只打印计划并跑自证①,不写任何文件。

### 实测出的图(不是一条链,是**一棵共源的树**)

| 刷新器 | 产物 | 实测输入 | 读别人的产物吗 |
|---|---|---|---|
| `docs:openapi` | `docs/handoff/openapi.json` | `src/` 全量(经 ts-node 模块图 809 份)| 否 |
| `docs:feclient` | `docs/handoff/clients/` | **只有** `docs/handoff/openapi.json` | ⭐ **是 —— 全仓唯一一条** |
| `docs:authz` | `ROUTE_AUTHZ.md` + `harness/authz-assertion-patterns.json` | `src` 下全部 `.ts`(**排除 `*.spec.ts`**)+ `test/contract/openapi.contract-spec.ts` | 否 |
| `docs:codemap` | `CODEMAP.md` | `src/` + `prisma/migrations/` 与 `test/e2e/` 的**目录枚举**(只数不读内容) | 否 |
| `docs:rbacmap` | `RBAC_MAP.md` 生成段 | `src` 下 `*.controller.ts` + `prisma/seed.ts` | 否 |
| `docs:counts` | `current-state.md` 计数块 | `src/` + `prisma/seed.ts` + `prisma/migrations/` + `test/contract/openapi.contract-spec.ts` | 否 |

⇒ **偏序只有一条边**:`docs:openapi` ▶ `docs:feclient`。其余五个共用上游 `src/`,**彼此无序**。
⇒ 所以真缺陷**不是「顺序记错」,是「改了 `src/` 却只刷了一部分」** —— 该做的是「一次性全刷」。

**口诀错在哪(两处)**:① `docs:authz` 与 `docs:codemap` **不在 openapi 的下游** ——
实测把 `openapi.json` 改坏,这两条守护纹丝不动(只有 openapi + feclient 红);
它们常跟着一起红是因为**共用上游 `src/`**,同源不是串联。
② 发版刷版本号那次判成「openapi 刷了、authz 没跟上」,真因是 `src/bootstrap/apply-swagger.ts`
的 `.setVersion(...)` 属于 authz 的 `inputDigest` 覆盖面 —— **`src/` 变了,与 openapi 无关**。

### ⭐ 上游没刷时,下游守护是**假绿**(这才是 7 次复发的机制)

实测因果链(改一个 DTO 字段,逐段读数):

| 阶段 | `docs:openapi:check` | `docs:feclient:check` |
|---|---|---|
| 只改了 `src` 的 DTO | **红** | 绿 ← ⭐ 假绿 |
| 跑完 `pnpm docs:openapi` | 绿 | **红** ← 这时才看得见 |
| 再跑 `pnpm docs:feclient` | 绿 | 绿(clients 实际改了 23 行) |

⇒ **「把全部 `docs:*:check` 跑一遍、把红的刷掉」在一趟里必然漏**:feclient 一个 `src/` 文件都不读,
它在 `openapi.json` 刷新前**结构上不可能**看见源码改动。入口因此固定跑两趟并自证第二趟零改动。

### 两种新鲜度机制(混为一谈会误判)

- **字节 digest 型**(`docs:authz`):`src` 下任一 `.ts` 改一个字节就红,**哪怕产物不会变**。
- **重生成比对型**(其余五个):只有产物真的会变才红。
  实测对照:同一文件加一行注释 ⇒ authz 红 + codemap 红;**等行数**原地改注释文字 ⇒ 只有 authz 红。

### 已被实测**否掉**的说法

- ❌「`.md` 躺在 `src/` 里照样进 `inputDigest`」:`generate-authz-manifest.ts` 的 `sourceFiles()` 只收 `.ts`。
  实测给 `src/modules/members/CLAUDE.md` 追加一行 ⇒ **八条守护全绿**。
  (`src` 下的 `CLAUDE.md` 确实被 `docs:readtax:check` 与 `check-codemap.ts` 碰,但前者只量字符预算、
  后者**只查存在性** —— 实测 53 份全是 `existsSync`;`check-codemap.ts` 唯一读内容的 `CLAUDE.md` 是
  `prisma/CLAUDE.md`,取的是里面**人手写的** migration 数。)
- ❌「`*.spec.ts` 也算」:实测给 `member-grade.spec.ts` 追加一行 ⇒ 全绿。

### ⚠️ 这套闸买不到什么:**一致性 ≠ 正确性**

全部 `docs:*:check` 判的都是「生成物与源**同步没同步**」,**不是「源里该不该有这东西」**。
⇒ 只要源里多出一个假字段、而生成物**正确地跟着更新了**,**八条守护一条都不会红**。

⭐ 尤其阴的一种形状:给某个 DTO 加一个**可选**字段 —— 它不改端点数、不改权限码、不改路由,
于是 `docs:counts` 的 9 个计数、`ROUTE_AUTHZ` 的端点数、contract 的 `EXPECTED_ROUTES`
**没有任何一个会动**;而它长得就像一个正常业务字段。假 controller 会被端点数抓到,这个不会。

⇒ 两条实操结论:① 本节这套东西**不替代**代码评审;
② 用「加一个 DTO 字段」当变异探针时,**变异对拍的最后一步不是把读数记下来,是确认树回到了变异前**
—— 读数与还原是两件事,做完前者很容易以为已经结束;而在多 lane 并行下,探针在树里的那段窗口
别人也看得见(本刀实测踩过:总控在 M2/M3 阶段查树,抓到了正在生效的探针,虽然脚本收尾时已逐字节还原)。

### 取证方法(三法交叉,单用一种会漏)

1. **运行期 fs 追踪** —— `--require` 预加载包住 `fs.*` / `child_process.*`,记录每个生成器**真正打开**了哪些文件(这是唯一能穷举输入面的一种)。
   ⚠️ 读文件与**枚举目录**要分开记:上表 codemap 那一行的 `prisma/migrations/` 与 `test/e2e/` 就只出现在 `readdirSync` 里,只按 `readFileSync` 统计会整类漏掉。
2. **扰动矩阵** —— 逐类改一个输入(`src` 的 `.ts` / `.spec.ts` / `.md`、生成物本身),八条守护逐条记红绿。
3. **读常量** —— 读每个生成器的 `OUT` / `CONTRACT` / `sourceFiles()` 定义。
   ⚠️ 只用第 3 种会失败:多数 `readFileSync` 读的是变量。

### 刻意不进入口的两份生成物

- **contract 快照**(`pnpm test:contract -u`):要**连数据库**起 Nest;且「盲 `-u` 更新快照」在 deny 清单里。
- **service 尺寸基线**(`pnpm harness:servicesize:write`):它是**棘轮**,整体重算会把上限一起调高。

## 2. 守护命令

以下十五条同挂 CI 的 **Fast checks** job,且**不随 docs-only 短路**(lint / typecheck / build / unit 会因 docs-only 跳过,守护步骤不会 —— 否则 docs PR 恰好绕开了守 docs 的那些检查):

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
| `pnpm docs:boundaries:debt:check` | 债务台账 7 个语义字段完整性(不留 `pending-phase2` 占位) | ✅ |
| `pnpm docs:boundaries:newdebt:check` | **禁新增代码债**:每条 finding 的 call-site 身份必须已在基线里 | ✅ |
| `pnpm docs:authz:check` | ROUTE_AUTHZ manifest 新鲜度 | ✅ |
| `pnpm gate:authz:graph:check` | R14 蕴含图注册表完整性 | ✅ |
| `pnpm ops:required:check` | 生产必填 env / worker 脚本必须在部署 runbook 里有条目 | ✅ |
| `pnpm docs:boundaries` | R5/R6 边界违规观察(B 类) | ❌ report |
| `pnpm harness:servicesize` | 大 service 尺寸棘轮(Phase 6-A) | ❌ report |

末两条是 report 期项目,各由**一个** `|| true` 兜住(全 workflow 恰这两处);脚本本身有发现即退出 1,所以转 blocking = 删掉那一行,一行,且不可能只翻一半。

守卫的守卫(`pnpm harness:selftest` / `pnpm harness:replay`)同在该 job,见 §1.5。

**不在 Fast checks 的两类**(把它们并进上表就是假读数):

- **base-trusted 语义门**:`pnpm gate:authz:semantic`(R14 授权)/ `pnpm gate:contract:semantic`(R11 契约)。本地形态只是**自查**;权威裁决恒在 `.github/workflows/redzone-trusted.yml`,用 **base 分支**的判据跑 —— PR 改不动自己的裁判,代价是新门合入后的下一个 PR 才真跑。详见 [`SEMANTIC_GATES.md`](SEMANTIC_GATES.md)。
- **挂在 `Diff guards`(`redzone-scan`)job 的三条台账/流程闸**:`pnpm exec tsx scripts/check-changelog-fragment.ts` · `scripts/check-next-tasks-state.ts` · `scripts/check-frozen-drafts-ledger.ts`。放那里而不是 Fast checks 是因为它们要 `fetch-depth: 0`(读 main 的 commit),且**必须对 docs-only PR 生效** —— 改台账的 PR 大多是 docs-only。

> ⚠️ **2026-08-24 订正两处**:① 上表此前漏登 `docs:boundaries:debt:check`,并在下面写着它「本地专用,未接 CI」—— 它自 `#1009`(`dc03e153`)起就在 Fast checks 的 A 类元数据门里**阻断**跑;② 同表还漏登 `docs:boundaries:newdebt:check` 与 `ops:required:check`。
> ⚠️ 同日补上 `check-frozen-drafts-ledger.ts` 的接线:在此之前它**唯一**入口是 unit 轮的薄运行器,而那一步对 docs-only 短路 ⇒ 冻结稿台账的六条判据恰好在最该拦的那批 PR 上一条都不跑。

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
| [`TOOL_TRAPS.md`](TOOL_TRAPS.md) | ⭐ **工具陷阱清单** —— 只收「不报错、退出码正常、读数看着正常,而它测的不是你以为的那个量」这一类。每条附本仓实测读数。**与本仓无关、换任何 AI 都会踩**,故单独成文;规则在 `AGENTS.md`,事实在 `current-state.md`,**本文是教训**。 |
| [`NEXT_TASKS.md`](NEXT_TASKS.md) | 后续任务清单(P0/P1/P2);逐项单独立项,**AI 不自动启动**(process §7) |
| [`FROZEN_DRAFTS.md`](FROZEN_DRAFTS.md) | **冻结稿落地台账**:已拍板冻结的施工依据还欠多少 —— §1 逐项欠账 / §2 机器读数(生成块,手改即红)/ §3 归档评审稿全量四值分类。判据 `scripts/check-frozen-drafts-ledger.ts` 六条:「不许有未分类项」+「读数不过期」+ **「§1 落地度不许对 `NEXT_TASKS` 的状态行沉默地矛盾」**(治沉默不治不一致,逃生门是固定标记 `` `↔另尺(…)` ``);挂 `Diff guards` job(不随 docs-only 短路),`src/frozen-drafts-ledger.criteria.spec.ts` 是 unit 轮薄运行器;刷新读数 `pnpm exec tsx scripts/check-frozen-drafts-ledger.ts --write` |
| [`CAPABILITIES.md`](CAPABILITIES.md) | 能力台账(各能力终态摘要 + **已部署/未部署**);2026-08-20 从 `current-state.md` §2 迁出 —— 那份在恒读层、每字符付恒定成本,本份不付。**新增能力条目写这里** |
| [`SIXTH_REVIEW_SCOPE.md`](SIXTH_REVIEW_SCOPE.md) | 第六轮全仓评审的**范围切分与投放包**(`v0.66.0..main` 切 6 包,含投放顺序与逐包「重点问过」);**工作计划非冻结件**,评审结论产出后另立冻结件入 `archive/reviews/` |
| [`CUTOVER_SIGNOFF.md`](CUTOVER_SIGNOFF.md) | **切换前检查的维护者签字登记**(合同 §16.1 十条里 B/C 类的「下结论」落点)+ **验收编号永久豁免登记**。🔴 **签了 ≠ 过**:签字里要写下当时的机器读数,`pnpm cutover:check` 每次运行重算并逐字比对 —— 矛盾即红并卡退出码;签一条闸里不存在 / 不接受签字(A 类)的编号同样红。判据 `scripts/cutover-check.ts`,自证 `pnpm cutover:check:selftest`(逐维正对照 **69 条**:A 类判据各自的弄假必红 + S 系列签字表 + R 系列读数非退化 + **T 系列规模档登记**)。🔴 **它今天没有执行位** —— `cutover:check` 未接任何 workflow,而本表是 `.md` ⇒ 只改它的 PR 是 docs-only、连 `pnpm test` 都不跑;解锁条件见本表 §3.1(要先把判据收进 selfGuard) |

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
| [`COMMON_GOVERNANCE.md`](COMMON_GOVERNANCE.md) | R15:`src/common` 治理(结构性零执法根因 / 三条判据与发现数 / 子目录逐个定性 / 存量三件复核 / §3.3 有主子目录的文件级闭包与保护面前后对照) |

🔒 = 该文件在 [`redzone.json`](../../harness/redzone.json) 的 `selfGuard` 内,改动需维护者 `pnpm harness:grant` + `harness-review` 环境审批。

**往本目录放新文件的义务**:同一个 PR 里把它加进上面三张表之一 —— 这条**有执行位**,不是文字要求:`pnpm docs:codemap:check` 的 `ai-harness-index-complete` 双向比对本节清单与目录实际文件,任一方向不符即 **FAIL**(它跑在 CI Fast checks 里,且不随 docs-only 短路)。§4 标题被改名或删除同样 FAIL —— 无法验证 ≠ 通过。

治理报告是本目录增长最快的一类(Phase 0→6 六份),本节此前正是这样漂成"恰 4 文件"的:少登记一条**不产生任何坏链接**,所以既有的 `referenced-paths-exist` 十一次都没响。

本目录更新一律走 A 档 PR(权限**事实**变更本身是 D 档,本目录只能事后 true-up);沿 process §6"无守护不留",不再新增无守护的派生地图。2026-06-10 Review 冻结档在 [`../archive/ai-harness/`](../archive/ai-harness/)。
