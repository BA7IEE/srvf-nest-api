# NEXT_TASKS — 后续任务拆解(P0 / P1 / P2)

> **性质**:任务提案清单(2026-06-10 Review 产出)。**每项任务仍须按 [`process.md`](../process.md) 单独立项,AI 不自动启动**(process §7)。状态列可由 AI 在 docs PR 中更新。
> P0 = 不解决阻碍 AI Harness 落地;P1 = 影响长期维护;P2 = 可优化。

---

## P0(harness 落地链路)

(P0-1 / P0-2 / P0-3 均已完成,见文末归档区。)

## P1(长期维护)

### P1-3 业务面 RBAC 接入(Slow-4)— **挂起,等业务拍板**
- **目标**:7 个 G 模式模块(members / member-profiles / emergency-contacts / certificates / activities / activity-registrations / attendances)接入 `rbac.can()`。
- **前置**:Slow-3(ADMIN 内置角色边界)业务决议——**这是业务方决策,不是工程任务**。
- **范围**(届时):新权限码 seed(D 档)+ 7 模块 service + e2e。**验收**:按届时评审稿。
- **人工确认**:✅ 全程(评审稿冻结 + 分 PR)。AI 在拍板前**不得**预实现任何部分。

(P1-4 已于 2026-06-10 调研收口,见文末归档区。)

## P2(可优化)

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

- **P1-4 god-service 拆分系列** ✅ 收口(2026-06-10,用户逐项拍板;沿 `srvf-god-service-refactor` skill 全流程):
  - **第一刀 attendances Presenter** ✅ PR #280(C 档方案 A 拍板):4 个序列化方法 + `decimalToString` 抽至 `attendance-presenter.ts`(137L),service 1157→1100L;零漂移三证 = 716L characterization 断言零改动 + presenter unit spec 6 用例 + contract snapshot 零 diff;事务归属未下放,select 查询策略留 service。
  - **attendances 第二刀(QueryService)**:只读调研判定触发不足——4 个读方法净查询构造仅 ~40L、filter 分支 1-2 个、抽离需事务壳传参或读事务下放,命中 [`architecture-boundary.md §6`](../architecture-boundary.md) Do-not-extract("hide the transaction boundary")→ 拍板收刀。
  - **attachments(827L)**:调研结论**无合规可抽边界**——纯规则历史已抽完(audit-recorder #203 / `attachment-validation.ts` PR #6b / `mime-to-ext.ts`);余量为 signed-URL L3 红线(`resolveAccessUrl`)+ RBAC self/other scope 判定(Hard stop 区)+ 配置三表读点(boundary 文档锁"不抽 facade")+ 本职编排 → 拍板收刀。
  - **activity-registrations(750L)**:仅剩 `formatRowsAsCsv`(~54L,单点调用)低价值 Presenter 候选 → 拍板不立项。
  - **终态认知**:3 个 ⚠G 模块均已达 architecture-boundary 政策下合理形态,`docs:codemap:check` 的 god-service WARN 仅作体量观察,不再视为"待拆"队列;重开任何一刀需出现 §6 新触发条件并单独立项。`current-state.md §3/§4` 已同步本结论。
  - **伴随产出**:participation 5 个纯组件 unit 全矩阵(#278 time-overlap-policy + contribution-calculator / #279 三个 state-machine)+ attendance-presenter spec(#280);src 内 unit spec 20→26 个。

- **P1-5 部门级权限(finalReviewer 终审)业务确认** ✅(2026-06-10 用户拍板**方案 A**):维持 ADMIN 级终审,`finalReviewerUserId` 仅审计记录不参与授权;部门级细分挂 Slow-3 子议题,未立项前不实现、不新增权限码、不补部门级 e2e。现状已正式标注于 [`participation-bounded-context.md §4`](../participation-bounded-context.md) 关键 invariant;`current-state.md §3` Slow-3 行同步登记。
- **P2-1 member-profiles dto 拆分(harness 验证任务)** ✅(2026-06-10,用户指定"选一个真实小任务验证 Harness"):**原任务前提修正**——769L 文件内并无 enum(Review 扫描代理误报,亲核仅 4 个 DTO class + 1 共享正则),改按 AGENTS §2 既有解锁例外(单 dto 文件 >300L 允许拆 `dto/` 目录)执行物理拆分:`dto/member-profile.shared.dto.ts`(PHONE_PATTERN + MedicalNoteItemDto)+ response / create / update 三个 per-class 文件,sed 逐字节搬移零改写;importer 仅 controller / service 两处。验收:quick 绿 + contract snapshot **零 diff**(snapshot 未触碰,由 CI 契约锁证明)+ codemap / rbacmap 双检查 0 FAIL。
- **P0-1 合入 ai-harness 文档层** ✅ PR #272(2026-06-10):9 文档 + 3 模板 + `docs/README.md §1` 登记;CI 全绿。
- **P0-3 测试环境双侧验证** ✅ 随 PR #272 CI 完成:contract + e2e 在 CI 通过,TEST_MATRIX §1 无 Docker 降级路径成立。
- **P0-2 入口接线** ✅ PR #273(2026-06-10,用户拍板授权):`CLAUDE.md §1` 表追加 ai-harness 行;CLAUDE.md 66 行,仍 ≤80。
- **P1-2 `docs/testing.md` 漂移 true-up** ✅(2026-06-10 用户立项,同日落地):覆盖表 `users-me` 行(死链,Route B Phase 4 删除)替换为 `app-me` / `app-me-password` 承接行;全文 20 个相对链接复核,其余 19 个均有效。
- **P1-1 RBAC_MAP 自动漂移检查脚本** ✅ PR #274(2026-06-10 用户立项,同日落地):`scripts/check-rbac-map.ts` + `pnpm docs:rbacmap:check`(沿 check-codemap 范式,零新依赖;6 检查项:seed 码提取 / 码数对账 / controller 数对账 / canonical 前缀 / 直调码必在 seed / 孤码 WARN + 动态前缀 INFO)。验收达成:当前仓库 0 FAIL;负向测试(删 seed 码 → FAIL 75≠76;篡改声明数 → FAIL)通过。已知边界写在脚本头部(helper 间接调用走全源字面量扫描;仅剥 // 行注释)。
