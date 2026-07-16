# Harness 2.0 全量重构 — T0 评审稿(已冻结)

> 状态:**已冻结**(2026-07-16 维护者拍板「按推荐」,§7 细项 d1-d10 随之生效;本文件随 PR1 入库,冻结后不回改)。
> 立项依据:维护者 2026-07-16 会话明示"当前项目整个 harness 都需要重构",并完成四项顶层拍板(见 §0.3)。
> 分析底稿:会话内底座再评估报告(artifact `4ef7c889`,五层判决 + 公理 A1-A5 + 并行化设计)。

---

## 0. 背景与动因

### 0.1 问题(实测)

- 恒读成本:按现行"必读三件套"协议,会话开工前需消化 ≈6.5 万 token,其中 ~90% 来自 `docs/current-state.md`(151 行 ≈5.9 万 token,§2 历史能力叙事占约八成体积);任务涉 RBAC / schema 再叠 RBAC_MAP、AGENTS 选节,轻松 8~10 万 token。后果:挤占工作上下文 → 提早 compact → 细节丢失;硬性不变式被教学性条款稀释。
- 人工镜像漂移:手工维护的计数已有三次在案漂移(migration"恒 49 实为 50";RBAC_MAP 权限码"76"true-up 为"191";模块 CLAUDE.md"9 个"true-up 为"11 个")。
- 串行制度:`agent:preflight` 硬判"全仓 0 open PR",把多 lane 并行判了死刑;CHANGELOG 单一追加点、共享 e2e 库为并行的物理障碍。
- 规则系统过载信号:权威源冲突表在 CLAUDE.md / AGENTS.md 头部 / process §6 存在三份近似副本。

### 0.2 设计公理(A1-A5,维护者已确认)

- **A1** 信任来自门禁,不来自盯梢(维护者不读代码;信任建立在机器门禁与独立复核上)。
- **A2** 维护者注意力是最稀缺资源(全系统唯一简报流、最少拍板点,收敛于总控)。
- **A3** 会话是牲口、状态在仓库(git + GitHub + goal 文本承载全部状态;goal=进程镜像,可弃性优于可修性)。
- **A4** 执行体必须是一等可见公民(一个写码执行体 = 一个可见会话窗口 + 一条 PR;禁止嵌套后台写码代理;只读检索子代理不受限)。
- **A5** 错误靠跨模型不相关性稀释(写者唯一;Claude 写 → Codex 查,Codex 写 → Claude 查;分歧不内部调和,升级进简报)。

### 0.3 已完成的顶层拍板(2026-07-16)

| # | 拍板点 | 结果 |
|---|---|---|
| P1 | 开工时序 | v0.55.0 收口由另一会话执行中(PR #650);本重构全部仓库写操作待收口终态(0 open PR + tag)后启动 |
| P2 | 重构形态 | **原位重构**:入口文件名全保留(`AGENTS.md` / `CLAUDE.md` / `docs/current-state.md` / `docs/process.md`),内容重写;细则拆 `docs/reference/`;v1 全文归档 |
| P3 | 事实源 | **current-state 全指针化**:§2 历史能力段全部删除(事实=CHANGELOG + handoff + live swagger);§1 计数脚本生成+守护 |
| P4 | 实施授权 | **T0 拍板 + 关键点头**:T0 冻结拍一次;此后连发,仅 PR2(机器层,D 档)与 PR4+PR5(AGENTS/process 重写,红区)各一次人话简报点头,其余 CI 绿即合 |

### 0.4 一句话主张

规则按"谁执行"重新分装:**机器执行的进脚本/CI,AI 执行的进"不变式+决策锁"(短),人执行的进流程(短);散文不再做机器的活;事实镜像要么脚本守护要么删除。**

---

## 1. 终态设计

### 1.1 恒读层(每会话必读;字符预算守护)

| 文件 | 终态 | 预算(字符) |
|---|---|---|
| `AGENTS.md` | 重写 ~200 行,结构见下 | ≤ 18,000 |
| `docs/current-state.md` | 重写 ~50 行,全指针化 | ≤ 4,500 |
| `CLAUDE.md` | 转发 + Claude 专属事项 | ≤ 2,500 |

预算以**字符数**计(工具无关,不依赖特定 tokenizer),由 `pnpm docs:readtax:check` 守护,超限即红。预算数值本身写入脚本常量,调整=改脚本=有 diff 可审。

**`AGENTS.md` 新结构**(文件名与入口地位不变——它同时是 Claude / Codex / 其他 AI 工具的原生规则入口):

- §0 读取协议 + 权威源冲突表(**全仓唯一副本**,CLAUDE.md 与 process 只留指针)
- §1 铁律速查表(现 ai-harness §1 升级版,主题 → 一句话 → 出处,~25 行)
- §2 决策锁与行为冻结索引(D-1~D-9、P0-E、判权单轨、防枚举、软删语义、Route B 终态、BizCode 段位等——一行一条,链接冻结稿/reference;**语义逐字继承,零放宽**)
- §3 红区与触发即停(收敛为不可逆项清单:schema/migration/seed、权限码与 Guard 语义、auth/JWT/refresh、storage 凭证、audit 不可变、release/tag、物理删数据、敏感字段三问、红区文档、危险 git 操作;**红区文件集合与现行完全一致,一个不减**)
- §4 lane 并行协议摘要(总控/执行角色、写者唯一、写集声明、migration token、跨模型互查;全文在 process §8)
- §5 档位与流程指针(指 process.md,不复述)
- §6 `docs/reference/` 主题索引 + **v1 节号重定向表**(v1 §3→reference/naming…,防旧引用断链)

### 1.2 触碰层(改到才读)

**新建 `docs/reference/`**,承接 AGENTS v1 教学细则,每篇头部标注"由哪些测试/守卫锁定":

| 新文件 | 承接 v1 内容 |
|---|---|
| `reference/naming-dto-validation.md` | §3 命名 / §7 ValidationPipe / §11 DTO 分离与白名单 |
| `reference/response-pagination-errors.md` | §4 统一返回与分页 / §5 错误处理与 BizCode 段位细则 |
| `reference/swagger.md` | §6 Swagger 100% 覆盖 |
| `reference/auth-jwt-refresh.md` | §8 鉴权 / §9 密码与 P0-E refresh token 全文(行为冻结细则) |
| `reference/soft-delete-transactions.md` | §10 软删 / §12 事务 |
| `reference/roles-admin-protection.md` | §13 角色层级与管理员保护 |
| `reference/config-env.md` | §14 配置归属 |
| `reference/testing-discipline.md` | §16 测试纪律(docs/testing.md 运行 SOP 保持独立) |
| `reference/api-client-boundary.md` | §18 / §19 / §21 细则(决策锁条目本身留 AGENTS §2) |

v1 §15 / §17(历史归档节)不迁移,随 v1 快照归档。**保留原样**:模块级 CLAUDE.md ×12、CODEMAP、RBAC_MAP、NEXT_TASKS、边界四篇(api-surface-policy / architecture-boundary / participation-bounded-context / attachment-config-boundary)、handoff 层、ops/、security/deployment/development/testing SOP。

### 1.3 背景层

`ARCHITECTURE.md` / `docs/srvf-foundation-baseline.md` / `docs/V2红线与复活路径.md`:顶部各加 ≤3 行"背景层"横幅(本文件不在任何默认必读路径;活条款已由 AGENTS §1/§2 与 reference 承接;正文冻结为背景),**正文一字不动**。属红区文档 surgical 改动,本 T0 即授权凭据,PR body 标注(有既例:protected-docs-goal-authorization)。

### 1.4 机器层(新脚本;全部挂进现有 CI Lint job)

现状盘点:`scripts/` 现有 3 件——`agent-preflight.sh`(**本次重设计**,加 lane 模式)、`check-codemap.ts` / `check-rbac-map.ts`(机器守卫,**行为零变化**,是被扩编的家族,不是被推翻的对象)。新增 4 件见下表;**全部新命令同 PR 加入 `.claude/settings.json` allow 白名单(与 `settings.example.json` 同步)**,避免执行弹窗。

| 脚本 | 行为 |
|---|---|
| `docs:counts` / `docs:counts:check` | 从真源数出计数并生成/校验 current-state §1 计数块(锚 `<!-- counts:begin/end -->`)。真源:module=src/modules 一级目录;controller=`*.controller.ts` 计数;endpoint=EXPECTED_ROUTES 长度;migration=prisma/migrations 目录数;BizCode=biz-code.constant 键数;Permission 码=seed 权限数组;AuditLogEvent=事件常量成员数;role=seed 内建角色数;cron=`@Cron(` 计数。**首跑若与现值不符=发现存量漂移,单独上报,不悄悄改。** |
| `docs:readtax:check` | 校验恒读层三文件字符预算(§1.1 表) |
| `agent:preflight --lane` | lane 模式:保留 clean tree + 未落后 origin/main 硬判;"全仓 0 open PR"由硬判改为**打印清单供总控研判**。无参 global 模式行为逐字不变;**E 档收口必须用 global 模式**。 |
| `changelog:merge` + `changelog.d/` | fragment 文件 `changelog.d/<branch>.md`(内容=可直并 Unreleased 的条目);归并脚本按文件名序并入 `## Unreleased` 并删除 fragment,由总控在 bump 前执行。过渡期单 lane 直接编辑 CHANGELOG 的旧路径**不废除**。 |
| e2e 库派生 | 测试库名:主仓=`app_test`(零变化);worktree=`app_test_<worktree目录slug>`;`db:test:init` 与 jest globalSetup 共用同一推导函数。 |

### 1.5 协作层

**`docs/process.md` 重写**(~160 行):§1 用途 / §2 开工门禁(global 与 lane 两形态)/ §3 五档(**逐字不变**)/ §4 D 档降速与人话简报(**逐字不变**)/ §5 release 收口(不变,+changelog:merge 一步;§5.4 squash 清理八条**逐字保留**)/ §6 权威源制度(冲突表改为指针指 AGENTS §0)/ §7 AI 协作与 goal(goal 升默认:**C 档及以上 feature 默认以 goal 形态立项**;四要素升五要素:DoD / 探针队列 / 授权清单 / 禁止域 / **写集声明**)/ **§8 lane 并行协议全文** / §9 收尾报告(不变)。

**§8 lane 并行协议要点**:总控职责(出 goal、按写集排班、持 migration token、串行集成 rebase→snapshot 复核→`agent:check:full`→diff 白名单核对→auto-squash merge→通知其余 lane rebase、独占 E 档、唯一简报流、不写业务代码);执行职责(一 lane 一窗口一 worktree 一 PR,B/C 档 goal 内自治,D 档新发现上报总控不顺手修,changelog 走 fragment);排班规则(写集不相交才并行;同 bounded context 不并行;schema lane ≤1;执行 lane ≤3);跨模型互查(写者唯一;Codex 评审由维护者投放,findings 落 PR 评论;分歧升级简报)。

**skills**:新增 `srvf-lane-orchestrator`(总控行为清单:开工检查、排班判定、集成 SOP、简报模板);更新 `srvf-goal-author`(五要素);sweep 修正其余 `srvf-*` skill 中的 AGENTS 节号引用。

**Codex**:`docs/ai-harness/codex-review-sop.md`(评审提示词模板 / 投放方式 / findings 处置 / 分歧升级);ai-harness 目录约束由"恰 3 文件"更新为"恰 4 文件"。

**`docs/ai-harness/README.md`** 减为纯操作页(preflight 两形态用法 / lane 用法 / 读写分区表);铁律速查表移入 AGENTS §1 后本页去重。

**`CLAUDE.md`**:~40 行,转发 AGENTS §0 + Claude 专属(skills 指针、worktree 注意事项)。

### 1.6 skills 与配置层(全量重审,逐个处置)

| 资产 | 处置 |
|---|---|
| `srvf-goal-author` | **重设计**:goal 五要素(+写集声明)、"C 档及以上默认 goal 立项"条款、lane 模式下的 goal 范式 |
| `srvf-release-closeout` | **更新**:+`changelog:merge` 步骤;E 档强制 global preflight;收口前 lane 清场(全 lane 已合并或显式挂起)要求 |
| `srvf-prisma-change` | **更新**:+migration token 语义(schema lane ≤1);AGENTS 节号引用重定向至 reference/ |
| `srvf-auth-security` | **更新**:引用重定向至 `reference/auth-jwt-refresh.md`;判据本体不变 |
| `srvf-api-surface` | **更新**:引用重定向;判据本体不变 |
| `srvf-god-service-refactor` | **更新**:引用重定向;characterization 先行铁律不变 |
| `srvf-fe-be-handoff` | **更新**:引用重定向;handoff 层本体不在本次范围 |
| `srvf-lane-orchestrator` | **新增**:总控行为清单(开工检查 / 排班判定 / 集成 SOP / 简报聚合模板) |
| `.claude/settings.json` + `settings.example.json` | **true-up**:新脚本命令入 allow 白名单;两文件保持同步;deny>ask>allow 语义不动 |
| `.claude/CLAUDE.md`(项目背景) | **微调口径**:使命陈述保留;"AI 必须先读项目规则"表述更新为新读取协议 |
| `.claude/launch.json` | 不动(dev 预览配置,非规则资产) |
| `scripts/check-codemap.ts` / `check-rbac-map.ts` | 不动(行为零变化,diff 证明) |

---

## 2. 行为契约(重构不改变什么)

1. **0 改 `src/**`、0 改 `prisma/**`、0 删/放宽既有测试**;API 行为、契约快照、EXPECTED_ROUTES 零变化。
2. PR 五档判定结果、D 档降速语义、§5.4 git 安全铁律、红区文件集合:**逐字/等价保留**。
3. 决策锁与行为冻结(P0-E、防枚举、判权单轨、软删、Route B、段位):**语义零放宽**,仅位置与表述收敛。
4. 已发布 CHANGELOG 段、`docs/archive/**`:不动(新增归档除外)。
5. handoff 层(admin-web / miniapp / openapi.json):本次不在范围。

## 3. PR 切片计划(待 v0.55.0 收口终态后启动)

| PR | 内容 | 档位 | 拍板 |
|---|---|---|---|
| PR1 | T0 冻结稿入 archive/reviews + `docs/archive/harness-v1/` 快照(AGENTS / process / current-state / ai-harness-README 四份 v1 全文) | A | T0 拍板即含 |
| PR2 | 机器层:counts / readtax / preflight lane / changelog.d + merge / e2e 库派生 + CI 接线(.github/workflows)+ settings 白名单 true-up(+可选 PR 模板,见 d9) | **D** | **点头 #1** |
| PR3 | current-state 全指针化 + counts 块接线(依赖 PR2) | B | 绿即合 |
| PR4 | AGENTS.md 重写 + `docs/reference/` 九篇拆分 + 三份背景层横幅 + CLAUDE.md 重写 + 全仓节号引用 sweep | 红区 | **点头 #2(与 PR5 同简报)** |
| PR5 | process.md 重写(§8 lane 协议 / goal 五要素 / changelog 步骤) | 红区 | 同点头 #2 |
| PR6 | skills 全量重审(§1.6:7 存量逐个处置 + lane-orchestrator 新增)+ codex-review-sop + `.claude/CLAUDE.md` 口径微调 | A/B | 绿即合 |
| PR7 | ai-harness README 减薄 + 死链与引用终扫 + 收尾 true-up | A | 绿即合 |

试点(不在本串):双 lane 验收(候选:第四轮全仓 review report-only lane × 一条 NEXT_TASKS C 档 feature lane),独立 goal 立项。

## 4. 风险表

| 风险 | 缓解 |
|---|---|
| R1 节号引用断链(skills / 模块 CLAUDE / RBAC_MAP 引"AGENTS §x") | PR4 全仓 `grep -rn "AGENTS §"` sweep + AGENTS §6 重定向表;codemap/rbacmap check 全绿为验收 |
| R2 重构窗口期其他会话读到半新半旧 | PR 串短窗口连发;AGENTS 重写与 reference 拆分同一 PR 原子落地;重构期间不开其他 feature lane |
| R3 教学条款搬家后被漏读导致回归 | 条款不消失只搬家;reference 每篇标注"由哪些测试/守卫锁定";主防线本就是 e2e/contract/CI |
| R4 与 v0.55.0 收口会话相撞 | 本串等收口终态(0 open PR + tag v0.55.0)后启动;收口刚回填的 current-state §2 段会被 PR3 指针化删除——预期内,已拍板 P3 |
| R5 新机制自身 bug(lane preflight / changelog.d) | global preflight 与直接编辑 CHANGELOG 旧路径均不废除;新机制先在本串与双 lane 试点吃狗粮 |
| R6 counts 首跑发现存量计数漂移 | 定义为"发现",单独上报拍板,不悄悄改(沿"审计发现不顺手修") |

回退:每 PR 独立 revert;v1 全文快照在 archive;git 历史完整。

## 5. DoD(逐条可核验)

- [ ] `docs:readtax:check` 绿:AGENTS ≤18,000 字符、current-state ≤4,500、CLAUDE ≤2,500
- [ ] `docs:counts:check` 绿;current-state §1 计数块为脚本生成物;人工维护计数归零
- [ ] `agent:preflight` global 模式行为与 v1 逐字一致;`--lane` 模式可用且已写入 process §2
- [ ] `changelog.d/` + `changelog:merge` 可用;本串 PR 自身即用 fragment(吃狗粮)
- [ ] 双 worktree 并行 `test:e2e` 互不干扰(演练一次)
- [ ] 全仓 AGENTS 节号引用 sweep 完成;`docs:codemap:check` / `docs:rbacmap:check` 0 FAIL
- [ ] 7 个存量 skill 逐个重审并在 PR6 body 留痕(重设计/更新/不动 + 理由);`srvf-lane-orchestrator` 新增
- [ ] `.claude/settings.json` 与 `settings.example.json` 同步;新增脚本命令全部免弹窗可执行
- [ ] `scripts/check-codemap.ts` / `check-rbac-map.ts` 行为零变化(diff 证明)
- [ ] harness v1 四份快照在 `docs/archive/harness-v1/`
- [ ] `git diff` 证明 `src/**` 与 `prisma/**` 零改动;CI 全绿
- [ ] Codex 至少完成一次对 PR4 的评审(需维护者投放一次,findings 落 PR 评论)
- [ ] 收尾报告含"本次未做"段(至少:未跑双 lane 试点、未动 handoff、未动业务代码)

## 6. 禁止域

`src/**`、`prisma/**`、`test/**` 既有断言、已发布 CHANGELOG 段、`docs/archive/**` 既有内容、handoff 三文件、生产配置、任何 migration/seed、任何依赖项变更。baseline / V2 红线 / ARCHITECTURE 仅允许 §1.3 所述 ≤3 行横幅。

## 7. T0 内细项拍板点(默认按推荐,随 T0 一并生效)

| # | 细项 | 推荐值 |
|---|---|---|
| d1 | 恒读层字符预算 | 18,000 / 4,500 / 2,500(见 §1.1) |
| d2 | counts 真源与锚点机制 | 见 §1.4;首跑漂移=上报不悄改 |
| d3 | preflight lane 判据 | 见 §1.4;E 档强制 global |
| d4 | changelog.d 机制与旧路径保留 | 见 §1.4 |
| d5 | e2e 库命名派生 | `app_test_<worktree slug>`,主仓零变化 |
| d6 | ai-harness 目录约束 3→4 文件 | 新增 codex-review-sop.md |
| d7 | CI 接线位置 | readtax + counts 挂现有 Lint job(随 PR2 D 档点头) |
| d8 | goal 默认化条款 | "C 档及以上 feature 默认以 goal 形态立项" |
| d9 | PR 模板(`.github/pull_request_template.md`:收尾报告 + 写集声明骨架) | 推荐**做**,随 PR2(同属 .github,D 档一次点头覆盖) |
| d10 | skills 与配置层处置 | 按 §1.6 表执行;launch.json 与两 checker 不动 |

---

*T0 拍板后冻结;实施与本稿不一致处以本稿为准,偏离须另行拍板。*
