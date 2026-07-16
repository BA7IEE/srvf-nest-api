---
name: srvf-release-closeout
description: Use when closing a release, merging PRs, syncing main, tagging releases, creating GitHub Releases, or cleaning up squash-merged branches/worktrees in srvf-nest-api.
---

# srvf-release-closeout

## Purpose

SRVF Nest API 项目的 **release 收口 + PR squash merge + main 同步 + branch/worktree 清理 + patch-equivalence 回收** 跨阶段工作流。本 skill 只**薄编排**"先核验什么 / 按什么顺序走 / 哪些绝不能做 / 怎么报告",**不**复制流程正文、**不**新增流程。完整 SOP 在权威源,改 SOP 去那里,不在本 skill 维护第二份。

## When to use

任务涉及以下任一即启用:

- 收口一个 release(bump / handoff / tag / GitHub Release / current-state 回填)
- `gh pr merge`(尤其 `--squash --delete-branch`)收一个 CI 全绿、已评审的 PR
- squash merge 后同步 main / 清理本地 + 远端 branch / 移除 Claude Code worktree
- `git branch -d` 报 `not fully merged`,需走 patch-equivalence 判定
- release 后远端 / 本地 `claude/*` 残留核验与清理

## Authority

冲突时按此优先级,**不自行调和,停止并报告**:

1. 用户本轮明确指令
2. [`docs/process.md §5`](../../../docs/process.md) — release 收口分阶段(feature → CHANGELOG → landing → bump → handoff → tag → Release → current-state 回填 → 清理)
3. [`docs/process.md §5.4`](../../../docs/process.md) — squash merge + main 同步 + 远端/worktree/本地分支清理 + patch-equivalence + 禁止动作 + 报告格式(§5.4.1–§5.4.8)
4. [`AGENTS.md §1` git 安全行](../../../AGENTS.md) + `docs/process.md §5.4` — worktree / 并行协作硬约束(§5.4 是其展开版)
5. [`docs/current-state.md §1`](../../../docs/current-state.md) — 版本 / tag / HEAD / open PR 当前事实
6. [`CHANGELOG.md`](../../../CHANGELOG.md) — release notes 唯一来源(`## vX.Y.Z` 对应段)

## Required first checks

先**只读**调研,不动文件、不合并(沿 [`process.md §5.4.1`](../../../docs/process.md)),必须确认:

- 主仓在 `main` 且 `git status --short` 为空
- `gh pr list --state open` 只剩目标 PR(或为空)
- 目标 PR:`state=OPEN` / `isDraft=false` / `mergeable=MERGEABLE` / `mergeStateStatus=CLEAN`
- `gh pr checks <PR>` 全绿;`gh pr diff <PR> --name-only` 落在本任务白名单内
- 记录目标 `headRefName`(后续清理**仅**作用于它)
- release 场景:`package.json` / `apply-swagger.ts setVersion` / 最新 tag 三方一致

任一不满足 → 停止报告,**不**"先合再修"。

## Release closeout workflow

沿 [`process.md §5.1`](../../../docs/process.md),**逐阶段独立 PR、不混不夹带**(0.x 默认 minor):

1. feature PR → 2. CHANGELOG `## Unreleased` 增量 → 3. landing docs PR → 4. **bump PR**(仅 `package.json` / `apply-swagger.ts` / `CHANGELOG.md` 折叠 3 文件)→ 5. **handoff PR**(新建 `docs/archive/handoff/vX.Y.Z.md`,合入后**不回改**)→ 6. **tag**(指向 handoff squash commit;AI 以 `git tag` + push 执行,维护者亦可手动)→ 7. **GitHub Release**(Notes 抽自 CHANGELOG 对应段;AI 以 `gh release create` 执行并输出 `gh release list` 证据,维护者亦可手动)→ 8. **current-state 回填**(§1 HEAD/tag/release/open PR;§2/§4 若变)→ 9. 分支清理。

## Squash merge + cleanup workflow

沿 [`process.md §5.4.2–§5.4.5`](../../../docs/process.md),顺序严格:

1. `gh pr merge <PR> --squash --delete-branch`
2. **判定成败看 PR state,不只看 exit code**:exit≠0 时先 `gh pr view <PR> --json state,mergedAt,mergeCommit`。`state=MERGED` → squash 已成,**不重跑 merge**,进清理;`state=OPEN` → 排查 CI/冲突后重试,不强合。
3. main 同步:`git -C <main> pull --ff-only origin main`(**只接受 fast-forward**)。
4. 远端分支:`git ls-remote --heads origin <head>` **看 stdout**(空=已删;非空才 `git push origin --delete <head>`)。
5. worktree-bound 分支:先 `git -C <worktree> status --short` 确认 clean → `git worktree remove <path>`(**无** `--force`)→ 再删本地分支。

## Patch-equivalence rules

squash merge 后 `git branch -d <head>` 报 `not fully merged` 属正常(squash 产生新 commit,原 tip 不在 main 祖先链)。**禁止直接 `-D`**;先全过 [`process.md §5.4.6`](../../../docs/process.md) 5 项(缺一不可):

1. PR `state=MERGED`
2. `git diff --stat main..<head>` 为空 / 仅 main 多 commit(本分支 0 新增)
3. `git diff main..<head> -- <changed-files>` 语义无差
4. `git log --left-right --cherry-pick main...<head>` 无 `>` 独有 commit(或都有等价 patch)
5. changed-files blob hash 一致互证

5 项全过才 `git branch -D <head>`(**仅**本任务目标分支)。`>` 方向含真实未推改动 → 停止报告,不强删。

## Risk grade

| 档 | 范围 | 用户拍板 |
|---|---|---|
| **A** | 本 skill / landing docs / current-state 回填(仅 docs) | ❌ |
| **D / E** | bump / handoff / tag / GitHub Release / version;或合并任何 D/E 档目标 PR | ✅(沿 [`process.md §3`](../../../docs/process.md)) |

merge / 清理动作本身不改代码,但**整体档位随目标 PR 升档**;合并 D/E 档 PR 前用户必须已拍板。

## Validation

- merge 前:`gh pr view` + `gh pr checks`(§5.4.1 全过)
- merge 后:`git -C <main> log -1 --oneline`(应为新 squash commit)+ `git status --short`(clean)+ 残留核验四连(`worktree list` / 本地 `claude/*` / 远端 `claude/*` / open PR)
- release 收口:版本三方一致 + `gh release list --limit 1`
- 缺 `node_modules`:**不** `pnpm install` / 改 lockfile;如实报告环境阻塞

## Output report

沿 [`process.md §5.4.8`](../../../docs/process.md) 合并/清理专项段,必须含:合并前确认 / 合并结果(exit + PR state + mergeCommit)/ main 同步 / 远端分支 / 本地 worktree+branch / patch-equivalence 核验 / 后置状态 / 未触碰项 / 是否触发任何禁止动作授权。

## Hard stops

下列**立即停止并报告**(沿 [`process.md §5.4.7`](../../../docs/process.md)):

- 跳过 CI / `mergeStateStatus` 检查直接合
- 对已 `MERGED` 的 PR 重跑 `gh pr merge`
- `gh pr merge` exit≠0 或本地 worktree 报错时,未先查 server-side PR state 就处置
- main 同步走非 ff(`pull --rebase` / 默认 merge / `reset --hard origin/main`)
- 未过 patch-equivalence 5 项就 `branch -D`
- 通配符 / 批量删分支(`branch -D claude/*` / `for` / `xargs`)
- `git reset --hard` / `git push --force[-with-lease]` / `git worktree remove --force`
- 清理非本任务的 worktree / 本地孤立 / 远端 `claude/*` 分支
- 把 release bump / handoff / current-state 回填夹进无关 PR
- tag 未指向正确的 release / handoff squash commit
- GitHub Release notes 临场编造,而非抽自 CHANGELOG 对应段

未授权例外 → 回对话等用户看到具体风险后**再次**明确授权(沿 [`process.md §5.4.7`](../../../docs/process.md)),并在报告中记录授权证据。
