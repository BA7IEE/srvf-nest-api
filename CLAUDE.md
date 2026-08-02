# CLAUDE.md — Claude Code 入口(Harness 3.0)

> 规则唯一入口是根 [`AGENTS.md`](./AGENTS.md);当前事实与人类决策在 [`docs/current-state.md`](./docs/current-state.md)。
> 本文件只写 **Claude Code 专属**事项。与 `AGENTS.md` 冲突时以 `AGENTS.md` 为准。

## 项目性质(每个新会话先看这一句)

维护者是**非职业程序员**,依靠 AI 完成长期维护,**无法审阅代码** —— 机器执法与独立验证是他唯一可靠的防线。
优先级:稳定、清晰、可维护、AI 友好,不是功能堆叠。背景全文见 [`.claude/CLAUDE.md`](.claude/CLAUDE.md)。

## 会话内自动发生的事(不必手动做)

- **SessionStart**:自动跑开工门禁并把结论注入上下文;依赖 / Prisma 生成物陈旧、落后 `origin/main` 时**写操作被拒**(只读不受限)。
- **写文件前**:红区与执法层路径自动拦截,并告知命中哪条、如何获授权。
- **Bash 写侧命令**:`sed -i` / 重定向 / `cp` 等绕道同样被拦(只拦写入目标,读出放行)。

触碰红区需**维护者**跑 `pnpm harness:grant '<glob>' --reason "<拍板出处>"`。**AI 不得自行发放授权**。

## skills

仓库内置 `srvf-*` skill(goal 起草 / lane 总控 / prisma 变更 / auth 安全 / api-surface /
god-service 重构 / 前后端交接 / release 收口)—— 任务命中主题时**先调对应 skill 再动手**。

## 常用命令

```bash
pnpm agent:check:quick   # lint(缓存)+ typecheck + unit + harness 自测,并行 ~25s
pnpm harness:selftest    # 守护不变式 + lint 阳性对照 + hook 行为
pnpm harness:replay      # 历史事故回放 + 反向案例(改 harness 前后各跑一次对比)
pnpm test:e2e <spec名>   # 定向 e2e(单 spec ~24s);全量恒由 PR CI 冷跑裁决,本机勿跑全量(连跑必榨干假红)
pnpm release:prepare X.Y.Z / release:finish X.Y.Z   # 发版两段式
```

fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`。
权限白名单 `.claude/settings.json`:deny > ask > allow,先匹配先赢;不得把头注 never-allow 模式移入 allow;与 `settings.example.json` 保持逐字节同步(自测守护)。

## memory

Claude Code 自身 `memory/` 与仓库铁律无关;**仓库内协作约束只写在权威源文档里**。
