# docs/ai-harness/ — AI Harness 操作层入口

> **性质**:本目录是给 AI Agent(Claude Code / 其他编码 Agent)与维护者用的**操作层**——导航地图、检查矩阵、修改边界、反馈闭环、报告模板。
> **本目录不是规则源**。铁律 → [`AGENTS.md`](../../AGENTS.md);当前事实 → [`current-state.md`](../current-state.md);流程 → [`process.md`](../process.md);surface 边界 → [`api-surface-policy.md`](../api-surface-policy.md)。
> 本目录任何内容与上述权威源冲突时,**本目录让步**,且应回头修正本目录(不得反向"调和"权威源)。

---

## 1. 这个目录解决什么问题

仓库的"规则面"已经完备(AGENTS.md 21 节铁律 + process.md PR 五档 + current-state.md 事实入口 + 根 CODEMAP.md 模块地图 + 5 个 `.claude/skills/srvf-*` 任务剧本 + `agent:check:*` 命令)。本目录补"操作面"——AI Agent 开工时需要、但此前散落各处或不存在的四类东西:

1. **地图**(去哪改):[`CODEMAP.md`](./CODEMAP.md)(全仓读写分区)/ [`MODULE_MAP.md`](./MODULE_MAP.md)(模块依赖与风险)/ [`RBAC_MAP.md`](./RBAC_MAP.md)(权限对照,此前不存在)
2. **矩阵**(改完跑什么):[`TEST_MATRIX.md`](./TEST_MATRIX.md)(任务档位 × 必跑检查 × 模块 spec 对照)
3. **边界**(什么不能自动改):[`PROJECT_RULES.md`](./PROJECT_RULES.md)(铁律索引 + AI 修改权限三档)/ [`HUMAN_REVIEW_RULES.md`](./HUMAN_REVIEW_RULES.md)(人工确认点全集)
4. **闭环**(怎么循环):[`AI_HARNESS_DESIGN.md`](./AI_HARNESS_DESIGN.md)(任务类型 + Loop 设计)/ [`templates/`](./templates/)(progress / risk-register / decisions 模板)

设计原则(沿本次 Review 任务规则 14):**复用优先,不重复造轮子**——本目录只做"索引 + 补缺",不复制权威源正文;凡可指向既有文件的,一律指向。

## 2. 文件清单与维护权

| 文件 | 用途 | 主要读者 | 维护者 | AI 可自动更新? | 更新时机 |
|---|---|---|---|---|---|
| [`README.md`](./README.md)(本文件) | 目录入口与维护协议 | AI + 人 | 维护者拍板 | ❌(A 档 PR 提案) | 目录结构变化时 |
| [`REVIEW_REPORT.md`](./REVIEW_REPORT.md) | 2026-06-10 全仓 Review 总报告 | 人 | **历史快照,合入后不回改** | ❌ | 不更新(下次 Review 另开文件) |
| [`CODEMAP.md`](./CODEMAP.md) | 全仓目录导航 + 读写分区 | AI | AI 提案 + 人审 | ✅(A 档 PR) | 目录/分区变化时 |
| [`MODULE_MAP.md`](./MODULE_MAP.md) | 模块依赖 / 风险 / 入口 / spec 对照 | AI | AI 提案 + 人审 | ✅(A 档 PR) | 新模块 / 依赖变化 / release true-up |
| [`RBAC_MAP.md`](./RBAC_MAP.md) | 权限码 / controller 鉴权模式对照 | AI + 人 | AI 提案 + 人审 | ✅(A 档 PR;**权限事实变更本身是 D 档**) | RBAC 相关 PR 合入后 |
| [`TEST_MATRIX.md`](./TEST_MATRIX.md) | 命令清单 + 档位测试矩阵 | AI | AI 提案 + 人审 | ✅(A 档 PR) | 测试命令 / 配置变化时 |
| [`PROJECT_RULES.md`](./PROJECT_RULES.md) | 铁律索引 + AI 修改权限三档 | AI | 维护者拍板 | ❌(规则变更走 AGENTS.md) | 权威源变化后同步 |
| [`HUMAN_REVIEW_RULES.md`](./HUMAN_REVIEW_RULES.md) | 人工确认点全集 | AI + 人 | 维护者拍板 | ❌ | 权威源变化后同步 |
| [`AI_HARNESS_DESIGN.md`](./AI_HARNESS_DESIGN.md) | 任务类型 / Loop / 目录决策 | AI + 人 | 维护者拍板 | ❌ | 流程演进时 |
| [`NEXT_TASKS.md`](./NEXT_TASKS.md) | P0/P1/P2 后续任务清单 | 人 | AI 提案 + 人拍板 | ✅(状态行可更新) | 任务完成 / 立项时 |
| [`templates/progress.md`](./templates/progress.md) | 会话进度模板 | AI | 模板冻结 | 模板 ❌ / 实例 ✅ | — |
| [`templates/risk-register.md`](./templates/risk-register.md) | 风险登记模板 | AI + 人 | 模板冻结 | 模板 ❌ / 实例 ✅ | — |
| [`templates/decisions.md`](./templates/decisions.md) | 会话内决策记录模板 | AI + 人 | 模板冻结 | 模板 ❌ / 实例 ✅ | — |

> "AI 可自动更新 = ✅"含义:AI 可以在 docs-only(A 档)PR 中提交更新,**仍需 PR 评审合入**,不存在"不经 PR 直接改"的通道。
> 地图类文件均带"数据快照"戳;**地图与代码冲突时以代码为准**,并回头修地图。

## 3. 按任务的阅读顺序

任何任务先跑 `pnpm agent:preflight`(开工门禁),再按 [`current-state.md §6`](../current-state.md) 全局阅读顺序;本目录的接入点:

| 任务类型 | 在全局顺序之后追加读 |
|---|---|
| 代码定位 / 调研 | [`CODEMAP.md`](./CODEMAP.md) → [`MODULE_MAP.md`](./MODULE_MAP.md) |
| 改接口 / DTO / Swagger | [`MODULE_MAP.md`](./MODULE_MAP.md) + `.claude/skills/srvf-api-surface` |
| 改权限 / Guard / seed | [`RBAC_MAP.md`](./RBAC_MAP.md) + [`HUMAN_REVIEW_RULES.md`](./HUMAN_REVIEW_RULES.md) + `.claude/skills/srvf-auth-security` |
| 改 schema / migration | [`HUMAN_REVIEW_RULES.md`](./HUMAN_REVIEW_RULES.md) + `.claude/skills/srvf-prisma-change` + [`prisma/CLAUDE.md`](../../prisma/CLAUDE.md) |
| 写测试 / 修测试 | [`TEST_MATRIX.md`](./TEST_MATRIX.md) |
| 拆 service / 重构 | [`architecture-boundary.md`](../architecture-boundary.md) + `.claude/skills/srvf-god-service-refactor` |
| release 收口 | [`process.md §5`](../process.md) + `.claude/skills/srvf-release-closeout` |

## 4. 维护协议(防漂移)

- 地图类文件(`CODEMAP` / `MODULE_MAP` / `RBAC_MAP` / `TEST_MATRIX`)头部必须带 `数据快照:日期 + HEAD sha`;读者发现快照落后 ≥1 个 release 时,应触发 true-up(A 档 docs PR)。
- src 模块结构漂移由 `pnpm docs:codemap:check`(校验根 `CODEMAP.md`)部分覆盖;本目录地图的自动化校验是 [`NEXT_TASKS.md`](./NEXT_TASKS.md) P1 提案。
- **禁止**把本目录当 `current-state.md` 用:版本号 / open PR / 能力清单等易变事实**不**写进本目录。
- release 收口(E 档)流程中,本目录地图的 true-up 与 `current-state.md` 回填同批执行(沿 [`process.md §5.3`](../process.md))。
