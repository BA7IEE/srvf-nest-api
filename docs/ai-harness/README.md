# docs/ai-harness/ — AI Harness 操作页

> **性质**:derived 操作层,**非规则源**;规则入口 / 铁律速查 / 决策锁 / 触发即停全部在根 [`AGENTS.md`](../../AGENTS.md)(冲突时本页让步并回头修本页)。
> 恒读三件套 = [`current-state.md`](../current-state.md) → 根 `AGENTS.md` → [`process.md §2/§3`](../process.md)。v1 版本冻结于 [`../archive/harness-v1/ai-harness-README.md`](../archive/harness-v1/ai-harness-README.md)。

## 1. 开工命令

- **global**:`pnpm agent:preflight`(clean tree / 0 open PR / 未落后 origin/main 三硬判;**E 档收口必须用本形态**)
- **lane**:`pnpm agent:preflight --lane`(open PR 降为清单研判,写集冲突由总控裁;协议全文 [`process §8`](../process.md))
- fresh worktree 先 `pnpm install --frozen-lockfile && pnpm prisma:generate`;e2e 测试库按 worktree 自动派生(`app_test_<slug>`,主仓恒 `app_test`)

## 2. 守护命令(全部挂 CI)

`pnpm docs:readtax:check`(恒读层体积预算)· `pnpm docs:counts:check`(current-state §1 事实计数)· `pnpm docs:codemap:check` · `pnpm docs:rbacmap:check`;CHANGELOG fragment 归并:`pnpm changelog:merge`(bump 前,总控执行)。

## 3. 定位路径

[`current-state.md`](../current-state.md) →(领任务)→ 根 [`CODEMAP.md`](../../CODEMAP.md)(src 模块地图)→ 模块级 `CLAUDE.md`(12 个,动模块时顺手校准)→ 改权限再读 [`RBAC_MAP.md`](./RBAC_MAP.md)。读写分区 / 红区清单 / 触发即停见 `AGENTS.md §3`;细则按 `AGENTS.md §6` 索引触碰才读。**勿整读**:`docs/archive/**` 正文、contract snapshot(~3.6 万行,用 diff)、`pnpm-lock.yaml`。

## 4. 目录说明

本目录恰 4 文件:**README.md**(本页)/ **codex-review-sop.md**(跨模型评审 SOP,沿 process §8.3)/ **RBAC_MAP.md**(权限地图,`docs:rbacmap:check` 守护)/ **NEXT_TASKS.md**(后续任务清单;逐项单独立项,AI 不自动启动)。

本目录更新一律走 A 档 PR(权限**事实**变更本身是 D 档,本目录只能事后 true-up);沿 process §6"无守护不留",不再新增无守护的派生地图。2026-06-10 Review 冻结档在 [`../archive/ai-harness/`](../archive/ai-harness/)。
