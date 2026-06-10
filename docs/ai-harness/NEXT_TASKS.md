# NEXT_TASKS — 后续任务拆解(P0 / P1 / P2)

> **性质**:任务提案清单(2026-06-10 Review 产出)。**每项任务仍须按 [`process.md`](../process.md) 单独立项,AI 不自动启动**(process §7)。状态列可由 AI 在 docs PR 中更新。
> P0 = 不解决阻碍 AI Harness 落地;P1 = 影响长期维护;P2 = 可优化。

---

## P0(harness 落地链路)

### P0-1 合入本 ai-harness 文档层 ✅(本 PR)
- **目标**:`docs/ai-harness/` 9 文档 + 3 模板 + `docs/README.md §1` 登记合入 main。
- **范围**:docs-only(A 档)。**验收**:CI 绿;`docs:codemap:check` 0 FAIL;docs/README §1 可发现本目录。
- **风险**:低(纯新增 + 1 个索引文件追加)。**人工确认**:PR 评审本身。

### P0-2 入口接线:根 `CLAUDE.md` / `AGENTS.md` 是否指向 ai-harness
- **目标**:让以 `CLAUDE.md` / `AGENTS.md` 为入口的会话能发现本目录(当前仅 `docs/README.md` 可达)。
- **范围**:`CLAUDE.md` §1 表追加 1 行(或 AGENTS.md 权威源分层表追加 1 行)。
- **验收**:入口表含 `docs/ai-harness/README.md` 行;CLAUDE.md 仍 ≤80 行。
- **风险**:低,但**两文件均为"非用户授权不动"** → **必须人工拍板**(A 档 PR,但授权先行)。

### P0-3 测试环境说明落地验证(无 Docker 降级路径)
- **目标**:确认 [`TEST_MATRIX §1`](./TEST_MATRIX.md) 环境前置在维护者机器与 CI 双侧成立;本次 Review 本地未跑 contract/e2e(Docker daemon 未启动),由本 PR 的 CI 补验。
- **范围**:无代码;若 CI 红则按失败输出修文档或报告。
- **验收**:本 PR CI 全绿(= contract 148 路由 + e2e 72 suites 在 CI 通过)。
- **人工确认**:仅在 CI 红时需要。

## P1(长期维护)

### P1-1 RBAC_MAP 自动漂移检查脚本
- **目标**:把 [`RBAC_MAP.md §7`](./RBAC_MAP.md) 重新生成口径固化为 `scripts/check-rbac-map.ts`(沿 `check-codemap.ts` 范式:只读、零新依赖、PASS/WARN/FAIL),校验:seed 权限码集合 ↔ 代码 `rbac.can()` 调用集合 ↔ RBAC_MAP 文档表;controller 前缀 ↔ 4 canonical 前缀。
- **范围**:`scripts/` 新文件 + `package.json` 加 1 个 script(**注意:改 package.json scripts 段不属于依赖变更,但仍建议按 B 档走**)+ 本目录文档登记。
- **验收**:`pnpm docs:rbac:check` 当前仓库 0 FAIL;故意改坏 seed 一条码能 FAIL。
- **风险**:低。**人工确认**:立项即可,无业务决策。

### P1-2 `docs/testing.md` 漂移 true-up
- **目标**:修正覆盖表中已删除的 `users-me.e2e-spec.ts` 引用(Route B Phase 4 删除队员流 spec 后未回填);顺带核对该表其余行。
- **范围**:docs-only(A 档,单文件)。**验收**:表内引用的 spec 文件全部存在。
- **风险**:无。**人工确认**:❌。

### P1-3 业务面 RBAC 接入(Slow-4)— **挂起,等业务拍板**
- **目标**:7 个 G 模式模块(members / member-profiles / emergency-contacts / certificates / activities / activity-registrations / attendances)接入 `rbac.can()`。
- **前置**:Slow-3(ADMIN 内置角色边界)业务决议——**这是业务方决策,不是工程任务**。
- **范围**(届时):新权限码 seed(D 档)+ 7 模块 service + e2e。**验收**:按届时评审稿。
- **人工确认**:✅ 全程(评审稿冻结 + 分 PR)。AI 在拍板前**不得**预实现任何部分。

### P1-4 god-service 拆分立项(逐个,characterization 已就绪)
- **目标**:attendances(1157L)→ attachments(827L)→ activity-registrations(750L)按 [`architecture-boundary.md`](../architecture-boundary.md) 抽 QueryService / Presenter。
- **前置**:6 个 characterization spec 已全覆盖(#241/#243/#246/#247/#251/#253)——护栏已就位。
- **范围**:单模块单 PR,D 档。**验收**:characterization + 全量 e2e 零行为漂移;`docs:codemap:check` god-service WARN 递减。
- **人工确认**:✅ 逐个立项(current-state §3 明确"不自动拆")。

### P1-5 部门级权限(finalReviewer 终审矩阵)业务确认
- **目标**:确认"部长/副部长终审"是否属当前业务范围;若是 → 补权限语义 + 专项 e2e;若否 → 在 participation 文档标注"字段预留,无权限语义"。
- **范围**:先 0 代码(业务问答);**验收**:结论落入 `participation-bounded-context.md` 或新评审稿。
- **人工确认**:✅(业务方)。

## P2(可优化)

### P2-1 `member-profiles.dto.ts`(769L)enum 抽离
- 把 DTO 内大量字典 enum 常量抽到同模块 `.constants.ts`(B 档;不改字段集与 snapshot)。验收:snapshot zero diff + quick 绿。人工确认:❌。

### P2-2 Swagger 权限要求文本化惯例补全
- 现状:权限要求靠 `@ApiOperation` 文案,无统一格式。提案:统一 summary 后缀约定(如 `[rbac: dict.read.type]` / `[roles: SA,ADMIN]`),**仅注解文案,零行为变更**(B 档,snapshot 会变 → 实际按 C 档拍板)。低优先;若 P1-1 脚本落地,此项价值上升(可机读校验)。

### P2-3 分页 skip/take 换算的轻度重复
- 各 service 手写 `skip=(page-1)*pageSize`;现状可接受(逻辑两行,已验证)。仅当后续出现第 3 处分页 bug 时再考虑收敛;**不建议**主动抽 util(避免 grab-bag 违反 AGENTS §2)。

### P2-4 `common/storage/` 迁往 `src/modules/storage/`
- current-state §4 已登记 P3;长期可做,本期不动(D 档,涉及 import 链 + e2e)。

### P2-5 contract snapshot 单文件 ~1MB
- current-state §4 已接受("PR review 用 diff 看");无动作,仅提醒勿整读。

---

## 已完成项归档区

(任务完成后把对应小节移到此处并标注 PR 号,保持上方清单只含 open 项。)
