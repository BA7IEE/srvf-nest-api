---
name: srvf-lane-orchestrator
description: 当本会话要充当 SRVF 并行开发「总控」时使用:为执行 lane 立项出 goal、按写集声明排班、授予 migration token、串行集成合并、聚合唯一人话简报。中文触发:总控、lane、并行开发、排班、多窗口协作、集成收口。
---

# srvf-lane-orchestrator — 总控行为清单(Harness 2.0)

> 协议权威源 [`docs/process.md §8`](../../../docs/process.md);公理与设计 [`harness-2.0-t0-review.md`](../../../docs/archive/reviews/harness-2.0-t0-review.md)。本 skill 是操作 checklist,**非规则源**,冲突时让步 process。

## 0. 角色边界

- 总控**不写业务代码**;只做立项 / 排班 / 集成 / 收口 / 简报。
- 执行体必须是维护者可见的会话窗口(公理 A4);**禁止**总控派后台子代理写码(只读检索子代理不限)。

## 1. 开工(每批)

1. `pnpm agent:preflight`(global)看全局;`gh pr list --state open` 盘点在飞 lane。
2. 每个任务委托 `srvf-goal-author` 起草 goal(五要素:DoD / 探针队列 / 授权清单 / 禁止域 / **写集声明**)。
3. 排班判定:写集相交或同 bounded context → 不并行(合并 goal 或排队);涉 schema → 授 **migration token**(至多 1 条 lane 持有);执行 lane 总数 ≤3。
4. 输出各 lane goal 文本,交维护者贴进新窗口(总控不自开执行会话)。

## 2. 运行期

- lane 的 D 档新发现 → 汇总进总控简报,**不**让 lane 直接找维护者(公理 A2)。
- lane 卡死 / 跑偏 / 失忆 → 指示弃 worktree、新窗口重贴同一 goal(公理 A3,探针幂等保证可重入)。
- 补充指令经维护者转贴,不绕过可见性。

## 3. 集成(逐 PR 串行)

1. `gh pr view` = OPEN / 非 draft / MERGEABLE;CI 绿(或 --auto 挂绿后自动)。
2. `gh pr diff --name-only` **逐文件核对落在该 lane 写集声明内**;越集 → 退回 lane。
3. contract snapshot 有 diff → 逐行可解释才放行。
4. `gh pr merge --squash --delete-branch`;合并后通知其余 lane rebase(lane preflight 会硬判落后)。
5. Codex findings(PR 评论)逐条消化;分歧不调和,升级简报(沿 [`codex-review-sop`](../../../docs/ai-harness/codex-review-sop.md))。

## 4. 收口(E 档)

global preflight 全过(全仓 0 open PR)→ `pnpm changelog:merge` 归并 fragment → 沿 `srvf-release-closeout` 九阶段。

## 5. 简报(唯一出口)

全批**一份**,沿 process §4.1 人话简报;附 lane 状态表(lane / goal / PR / CI / 阻塞)+ 需拍板项(含跨模型分歧,两边理由人话化)。
