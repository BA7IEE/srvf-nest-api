# Harness 精简与历史取回

精简前快照：远端标签 `harness-v3-final`，对应提交
`6453ae5c3`。历史全文没有丢弃，按原路径可取回：

```bash
git show harness-v3-final:AGENTS.md
git show harness-v3-final:docs/ai-harness/NEXT_TASKS.md
git show harness-v3-final:scripts/harness-guards.selftest.ts
```

本地另外保存了仓外快照 `srvf-harness-v3-final.tar.gz`；协作者使用远端标签即可，
CI 不依赖本地归档。

## 日常入口

根规则、当前状态、流程和五个技能已压缩。已批准任务直接推进；
不再要求 preflight/grant、固定 Goal/lane、分级简报或每 PR 的计数与台账更新。
Claude settings 保留危险命令限制，不挂写入 hooks；没有跟踪在 Git 中的
本地 Codex/Agents 配置不由这个 PR 自动删除。合并后在相应本地客户端移除旧 hook 配置；
若需技能兼容入口，指向唯一 `.claude/skills`，不要再复制一套。

## 检查边界

保留 lint 及自定义规则、typecheck、build、单测、contract、五分片 E2E、journeys、
Human V3、Docker 构建和 OpenAPI/client/授权清单新鲜度。RBAC 代码校验独立于权限地图。
验收合同、审计/字典注册、cutover 检查及生产签字继续保留。

移除 harness 三套自测、事故回放、preflight/grant/needs；
移除 read-tax、文档计数、CODEMAP、migration 计数同步、运维条目登记、
架构债务/尺寸、NEXT_TASKS/FROZEN_DRAFTS 与 cutover 签字的每 PR 门禁。
最后一项只退出 CI，生产前 `cutover:check` 的校验与人工确认未取消。
两个纯文档治理 spec 退出单测；业务验收覆盖度算法原样从冻结台账检查器抽出，业务断言保留。

trusted 工作流只保留最小路径审批，不再做 authz/contract 语义申报与棘轮单调性裁决。
路由声明 lint、contract 行为测试仍执行；lint 豁免基线的变化转为维护者审批。
因此这不是“所有旧保证都还在”：被移除的静态自测、语义分类和流程登记不再自动裁决。
保留的测试负责其实际覆盖的代码行为，维护者负责保护范围内的变更批准。

## 兼容与保留

`harness/ratchet-registry.json` 及旧 numeric/set 基线暂留：
ESLint 读取该注册表，且本次 PR 仍由 main 上旧 trusted 裁判判断；
旧裁判拒绝删注册项，即使改动已经获批也不能覆盖其失败。
这些旧尺寸/债务条目不再作为本分支 CI 门禁，ESLint 豁免型条目仍使用。
`check-boundaries.ts` 的 SQL 解析被 R5 业务安全测试消费，故保留该实现与相关数据。
`docs-counts.ts` 的 AST/权限解析也被业务检查和发版消费，发版改为直接计算源码事实，
不再从 current-state 读取计数。

历史 harness 设计、评审与详细台账移出工作树；仍作为业务规格、测试输入或运维证据的
archive/plans/handoff 材料保留，并按需读取。原模块规则的全文也由上述标签保存。

四个 required check 名保持不变。本 PR 合并前仍走 main 上的旧审批流程；
新 trusted 工作流只 checkout base SHA，不安装 PR 依赖、不执行 PR 脚本，
文件清单来自分页 API，缺失、截断或版本竞争均失败关闭，rename 检查新旧两条路径。
