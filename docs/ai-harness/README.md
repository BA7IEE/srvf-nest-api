# docs/ai-harness/ — AI Harness 操作页

> **性质**:derived 操作层,**非规则源**;规则入口 / 铁律速查 / 决策锁 / 触发即停全部在根 [`AGENTS.md`](../../AGENTS.md)(冲突时本页让步并回头修本页)。
> 恒读三件套 = 根 [`AGENTS.md`](../../AGENTS.md) → [`current-state.md`](../current-state.md) → [`process.md §2/§3`](../process.md)(唯一权威表述在 AGENTS §0)。v1 版本冻结于 [`../archive/harness-v1/ai-harness-README.md`](../archive/harness-v1/ai-harness-README.md)。

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

**自测(证明防线真的存在)**:`pnpm harness:selftest` = 守护不变式 94 项 + lint 阳性对照 30 例 + hook 行为 31 例。
中间那份专防「selector 写错导致规则永不触发」,最后那份专防「hook 用了 `exit 1`」——
⚠️ Claude Code 只把 **exit 2** 当阻断,`exit 1` 会被当成非阻断错误**直接放行**,那样拦截只存在于纸面。

## 2. 守护命令(全部挂 CI)

`pnpm docs:readtax:check`(恒读层体积预算)· `pnpm docs:counts:check`(current-state §1 事实计数)· `pnpm docs:codemap:check` · `pnpm docs:rbacmap:check`;CHANGELOG fragment 归并:`pnpm changelog:merge`(bump 前,总控执行)。

## 3. 定位路径

[`current-state.md`](../current-state.md) →(领任务)→ 根 [`CODEMAP.md`](../../CODEMAP.md)(src 模块地图)→ 模块级 `CLAUDE.md`(`src/modules` 20 个 + `prisma` 1 个,动模块时顺手校准)→ 改权限再读 [`RBAC_MAP.md`](./RBAC_MAP.md)。读写分区 / 红区清单 / 触发即停见 `AGENTS.md §3`;细则按 `AGENTS.md §6` 索引触碰才读。**勿整读**:`docs/archive/**` 正文、contract snapshot(~3.6 万行,用 diff)、`pnpm-lock.yaml`。

## 4. 目录说明

本目录恰 4 文件:**README.md**(本页)/ **codex-review-sop.md**(跨模型评审 SOP,沿 process §8.3)/ **RBAC_MAP.md**(权限地图,`docs:rbacmap:check` 守护)/ **NEXT_TASKS.md**(后续任务清单;逐项单独立项,AI 不自动启动)。

本目录更新一律走 A 档 PR(权限**事实**变更本身是 D 档,本目录只能事后 true-up);沿 process §6"无守护不留",不再新增无守护的派生地图。2026-06-10 Review 冻结档在 [`../archive/ai-harness/`](../archive/ai-harness/)。
