# AI_HARNESS_DESIGN — AI Harness 底座设计

> **性质**:设计文档(本次 2026-06-10 Review 的核心产物),经维护者合入即生效;流程类条款与 [`process.md`](../process.md) 冲突时以 process.md 为准。
> 设计目标:让任意 AI Agent 在本仓库**安全、可验证、可中断**地持续开发——理解结构 → 定位模块 → 按档执行 → 自动检查 → 生成报告 → 在人工确认点停下。

---

## 1. 设计原则:复用优先

本仓库在本设计之前**已经拥有**一套事实上的 harness 资产。本设计的第一结论是:**不另起炉灶**,新增层只做"索引 + 补缺"。

### 1.1 已有资产盘点(复用,不重建)

| 能力 | 已有承载 | 状态 |
|---|---|---|
| 当前事实入口 | `docs/current-state.md` | ✅ 成熟(每 release 回填) |
| 长期铁律 | `AGENTS.md`(21 节)+ baseline + V2 红线 + api-surface-policy | ✅ 成熟 |
| 流程与档位 | `docs/process.md`(开工 checklist / PR 五档 / D 档降速 / release 收口 / 收尾报告格式) | ✅ 成熟 |
| 源码地图 | 根 `CODEMAP.md` + 7 个模块级 `CLAUDE.md` + `prisma/CLAUDE.md` | ✅ 成熟 + 漂移检查 |
| 任务剧本(goals/checks) | `.claude/skills/srvf-{api-surface, auth-security, god-service-refactor, prisma-change, release-closeout}` | ✅ 5 类高危任务已覆盖 |
| 门禁命令 | `pnpm agent:preflight` / `agent:check:{quick,api,full}` / `docs:codemap:check` | ✅ 本次实测可用 |
| 自动验收反馈 | CI(lint+typecheck+build+unit+contract+e2e+docker-smoke)+ contract snapshot + 148 条路由白名单 + Route B 终态断言 | ✅ 成熟 |
| 行为护栏测试 | 72 e2e suites / 1664 tests + 6 个 service characterization spec + 防枚举/保护逻辑反向锁定断言 | ✅ 成熟 |

### 1.2 本设计补的缺口(全部落在 `docs/ai-harness/`)

| 缺口 | 新文件 |
|---|---|
| 全仓读写分区(哪里能改、哪里红区)此前散落在多文档 | [`CODEMAP.md`](./CODEMAP.md) |
| 跨模块依赖 / 鉴权模式 / spec 对照无单页地图 | [`MODULE_MAP.md`](./MODULE_MAP.md) |
| controller → 权限码对照表**不存在**(权限双轨期最大误判源) | [`RBAC_MAP.md`](./RBAC_MAP.md) |
| "任务档位 × 必跑测试"矩阵未成文 | [`TEST_MATRIX.md`](./TEST_MATRIX.md) |
| 铁律按"AI 开工视角"的索引 + 修改权限三档 | [`PROJECT_RULES.md`](./PROJECT_RULES.md) |
| 人工确认点全集单页化 | [`HUMAN_REVIEW_RULES.md`](./HUMAN_REVIEW_RULES.md) |
| 会话状态 / 风险 / 决策模板 | [`templates/`](./templates/) |
| 后续任务拆解 | [`NEXT_TASKS.md`](./NEXT_TASKS.md) |

### 1.3 刻意不做的目录(与任务原始提案的差异)

原始提案建议新建 `.ai/goals/ + .ai/checks/ + .ai/memory/` 三层。**本设计否决新建 `.ai/` 平行树**,理由:

1. `goals/` 与 `checks/` 的职能已由 `.claude/skills/srvf-*`(可执行剧本,含触发条件与检查清单)+ `agent:check:*` 脚本承载;再建一层必然产生双源漂移——这正是本仓库 docs 治理刚刚收口掉的问题。
2. `memory/progress|decisions|risk` 的**长期态**已有权威承载:进度 → `current-state.md` §1/§4;决策 → `AGENTS.md §19.7/§21` D-locks + 批次评审稿;风险 → `current-state.md §4` 债务表。会话级**短期态**用 `docs/ai-harness/templates/` 三个模板,在会话/PR 描述中实例化,不落仓库根。
3. 新任务类型若需要剧本,**新增一个 `.claude/skills/srvf-*` skill**,不是建 `.ai/goals/`。

## 2. 任务类型设计(11 类)

每类:输入 → 允许范围 → 禁止范围 → 必跑检查 → 人工确认 → 交付物 → 停止条件。档位定义沿 [`process.md §3`](../process.md)。

| # | 任务类型 | 档位 | 允许修改 | 禁止修改 | 必跑检查 | 人工确认点 | 交付物 | 停止条件 |
|---|---|---|---|---|---|---|---|---|
| 1 | repo review / 调研 | 只读 | 无(可产出报告文件) | 一切代码 | 可选 `docs:codemap:check` | 发现的问题**不顺手修** | 报告 + 风险登记 | 发现红区冲突即停 |
| 2 | docs update | A | docs(权威 6 文件除外)/ 本目录地图 | 红区文档 / archive | 链接自查;动 CODEMAP → drift check | ❌ | docs PR | 涉 `.ts/.prisma/.yml` 即升档 |
| 3 | test addition | B | `test/**` / `src/**/*.spec.ts` / fixtures | 生产代码;**删除/放宽既有断言** | `agent:check:quick` + 新增 spec 本体 | ❌ | 测试 PR | 需改生产代码才能过 → 停,报告 |
| 4 | bug fix(非破坏) | B | 单模块 service/controller 局部 | endpoint/DTO 字段/错误码/schema | `agent:check:quick` + 受影响 e2e | ❌(常规) | 修复 PR + 回归测试 | 修复需要改契约 → 升 C 档停 |
| 5 | feature(新 endpoint) | C | 目标模块 + dto + spec + snapshot | 跨模块 / schema / 权限码 | `agent:check:full` | ✅ 动手前圈范围 | 实现 PR(含 contract diff 解释) | snapshot 出现范围外 diff → 停 |
| 6 | Swagger/DTO 注解修正 | B/C | 注解层 | 字段集语义 | quick;snapshot 变 → full | snapshot 变 → ✅ | PR | — |
| 7 | RBAC change | **D** | 拍板范围内 seed/permissions 模块 | 保护不变式([`RBAC_MAP §4`](./RBAC_MAP.md)) | full + RBAC spec 组 + 全量 e2e | ✅ 评审稿冻结 | 评审稿 + 实施 PR | 任何未拍板的权限语义变化 |
| 8 | Prisma schema change | **D** | 拍板范围内 schema/migration/seed | migration 历史 / 自动 migrate dev | full + 干净库 deploy 重放 + seed 幂等二跑 | ✅ 评审稿冻结(`srvf-prisma-change`) | 评审稿 + 实施 PR | 不可逆操作未确认回退方案 |
| 9 | refactor(拆分/跨模块) | **D** | 立项范围 | 行为契约(characterization 断言) | full;characterization **先行** | ✅ 单独立项 | 立项记录 + 分步 PR | characterization 红 → 停 |
| 10 | dependency update | **D** | package.json + lockfile | 大型新依赖(评审制) | full + build + (CI docker-smoke) | ✅ | PR + 影响说明 | peer 警告 / 行为变化 → 停 |
| 11 | release preparation | **E** | bump 3 文件 / handoff / current-state 回填 | 一切业务代码 | full + handoff 锚点 | ✅ 全程;tag/Release 维护者手动 | 沿 `srvf-release-closeout` | 任何阶段验收不过 |

## 3. 反馈闭环(最小可行 Loop)

```text
① 读取任务 ──► ② 开工门禁 ──► ③ 理解与定位 ──► ④ 定档与计划 ──► (C/D/E: 用户拍板)
                                                                        │
⑧ 收尾报告/PR ◄── ⑦ 失败修复循环 ◄── ⑥ 运行检查 ◄── ⑤ 实施(范围白名单内) ◄──┘
        │
        └──► 需要人工确认 → 按 HUMAN_REVIEW_RULES §4 格式提交,停
```

| 步 | 输入 | 输出 | 检查方式 | 失败规则 |
|---|---|---|---|---|
| ① 读取任务 | 用户任务说明 | 任务理解复述 | 与用户说明一致 | 含混 → 提问,不猜 |
| ② 门禁 | — | preflight 输出 | `pnpm agent:preflight` 全项满足 | 任一不满足 → 停,对齐 |
| ③ 定位 | current-state → CODEMAP → MODULE_MAP → 模块 CLAUDE.md | 目标文件清单 + 引用链 | 符号/引用确认(AGENTS §0) | 定位不到 → 标不确定项 |
| ④ 定档计划 | 任务 + [`PROJECT_RULES §3`](./PROJECT_RULES.md) | 档位 + 修改白名单 + 测试集([`TEST_MATRIX §2`](./TEST_MATRIX.md)) | 对照 process §3 档位归属规则 | 拿不准 → 按高档处理 |
| ⑤ 实施 | 白名单 | diff | `git diff --stat` 落在白名单内 | 范围外 diff → 回退该部分 |
| ⑥ 检查 | 档位测试集 | 测试结果 | quick / api / full + 漂移检查 | 红 → 进 ⑦ |
| ⑦ 修复循环 | 失败输出 | 修复 diff | 重跑失败子集后重跑全集 | **最多 2 轮**;仍红或需改契约/断言才能绿 → 停,报告原文 |
| ⑧ 报告 | 全程记录 | process §8 标准段落 + progress 实例 | 含"本次未做"段;证据齐 | 不得自报完成未验证项 |

**停止条件总表**:触发 [`HUMAN_REVIEW_RULES §1`](./HUMAN_REVIEW_RULES.md) 任一行 / 修复循环超 2 轮 / 发现文档-代码冲突 / 范围外 diff 无法解释 / 用户拍板点未决。

## 4. 模板使用(templates/)

- [`progress.md`](./templates/progress.md):会话开始时实例化(贴进会话或 PR 描述),每个阶段切换时更新;**不**提交实例进仓库(避免与 current-state 双源)。
- [`risk-register.md`](./templates/risk-register.md):调研/实施中发现的风险逐条登记;会话结束随报告输出;被采纳的长期风险由维护者转入 `current-state.md §4`。
- [`decisions.md`](./templates/decisions.md):会话内拍板记录;**长期决策必须由维护者转入 `AGENTS.md §19.7/§21` D-lock 或批次评审稿**,模板实例不是决策权威源。

## 5. 维护与漂移防护

1. 地图四件套带数据快照戳;release 收口(E 档第 8 步 current-state 回填)时同批 true-up。
2. `pnpm docs:codemap:check` 守根 CODEMAP;本目录地图的同类自动校验(controller→权限码对照、surface 前缀统计)是 [`NEXT_TASKS.md`](./NEXT_TASKS.md) P1 提案(扩展 `scripts/check-codemap.ts` 范式,**不引入新依赖**)。
3. 本目录文件的"AI 可自动更新"矩阵见 [`README.md §2`](./README.md);全部更新走 PR,无直改通道。
4. 入口接线现状:`docs/README.md §1` 已登记本目录(随本次 PR);**根 `CLAUDE.md` / `AGENTS.md` 是否增加指向本目录的一行,留维护者拍板**(二者非用户授权不动,见 NEXT_TASKS P0-2)。
