# CLAUDE.md — Claude Code 入口(Harness 2.0)

> 恒读三件套 = 根 [`AGENTS.md`](./AGENTS.md)(唯一恒读规则入口:读取协议 §0 / 铁律速查 §1 / 决策锁 §2 / 红区与触发即停 §3 / lane 协议 §4)→ [`docs/current-state.md`](./docs/current-state.md)(当前事实)→ [`docs/process.md §2/§3`](./docs/process.md)(唯一权威表述在 AGENTS §0)。本文件只承载 Claude Code 专属事项;体积由 `pnpm docs:readtax:check` 守护(≤2,500 字符);v1 版本冻结于 [`docs/archive/harness-v1/`](./docs/archive/harness-v1/)。

## Claude Code 专属

- **skills**:仓库内置 `srvf-*` skill(goal 起草 / lane 总控 / prisma 变更 / auth 安全 / api-surface / god-service 重构 / 前后端交接 / release 收口)——任务命中主题时**先调对应 skill 再动手**。
- **开工**:`pnpm agent:preflight`(并行 lane 会话用 `--lane <lane名>`);fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`。
- **权限白名单**:`.claude/settings.json`(deny > ask > allow,先匹配先赢;修改时不得把文件头注 never-allow 列表中的模式移入 allow;与 `settings.example.json` 保持同步)。
- **memory**:Claude Code 自身 `memory/` 持久化机制与仓库铁律无关;仓库内协作约束**只**写在权威源文档里。
- 本文件与 `AGENTS.md` 冲突时,以 `AGENTS.md` 为准。

## 项目性质(给每个新会话的一句话)

维护者是非职业程序员,依靠 AI 完成长期维护;项目优先级是**稳定、清晰、可维护、AI 友好**,不是功能堆叠——按规范平铺加模块、避免过度工程化、决策锁不重开(AGENTS §2)。
