- **整批复审收口 M1–M6(2026-08-01;两份独立评审去重 6 P1 + 2 P2,无 P0;零 schema,Migration 恒 67)**:

  ① **team-join 全部写路径 member-first**(M1 + M5)—— `submit` / `updateTargets` / `markGate` / `evaluate` / final join
  五条 surface 一律先取队员 advisory 键、再锁 Application 行。admin 两条抽唯一入口
  `lockMemberThenApplication`;`evaluate` 因此不再用 `claimAtStatus`(锁后读即 authoritative,
  「与锁前读数一致」的断言没有对象了)。**反序即死锁**:final join 持键并在终态级联里反向争同人
  sibling 行锁,反序实现两进程互等,`40P01` 可稳定复现。
  M5 的双向 barrier 另**新查出一个真死锁**:App 自助 `updateTargets` 持 sibling 行锁后写 audit,
  而 `audit_logs.actorUserId` 的外键要在**本人 User 行**上取 `FOR KEY SHARE` —— 那一行正被 final join 的
  `lockLinkedUserLifecycle` 攥着,而 final join 又在等 sibling 行锁。同一条修法一并收口。

  ② **⚠️ 行为变更 · 入队身份收口到唯一 transition**(M2,新码 **`28211`**)—— 「未入队志愿者」是一条 live 入队申请
  **唯一**的走通前提;把它改掉,那条申请就成了没有终态通路的死行。sweep 出 8 个能翻掉它的写方
  (`members.update(gradeCode)` / `updateStatus(INACTIVE)`、`member-departments.set|remove`、
  `memberships.create(PRIMARY)|update(type)|end|transfer(PRIMARY)`),按维护者拍板**一律拒绝**
  ——不自动终结、不静默放行,把「一键入队还是综合评估淘汰」交回管理员。
  闸在 `team-join/team-join-enrollment-invariant.ts`,必须排在 `lockMemberLifecycle` 之前。
  前端清单见 [`handoff/admin-web.md`](docs/handoff/admin-web.md) §3 第 12 条。

  ③ **考勤终审批量化 + 隔离级别显式化 + 有界锁等待**(M3,新码 **`40901`**)—— before/after 贡献值快照与逐条
  outbox intent 全部批量化(封顶核 `capByBeijingDay` 单人/批量共用,不复制 cap 算法);
  200 人考勤单实测 **810 → <40 次 SQL**,与人数无关(**不是**靠调大事务 timeout)。
  取队员键的 8 个事务改走 `runMemberLinearizedTransaction`:显式 `ReadCommitted`
  ——**RR 是真前提**,把库默认改成 `repeatable read` 后去掉那一行,里程碑 intent 由 1 条变 **0 条**,
  write skew 完整复活;外加 `SET LOCAL lock_timeout`,排队超时返可重试的 `40901` 而不再是 `50000`。

  ④ **棘轮注册表 + 三洞封堵**(M4)—— 新增 `harness/ratchet-registry.json`,base-trusted 裁判改为**遍历注册表**
  (上一版把唯一那条基线的路径写死,新棘轮一落地就默认不受保护);**基线被删/改名 = 硬失败**
  (上一版判成「HEAD = ∅ ⊆ BASE 成立」,理由是 lint 会红 —— 而 lint 跑在 PR 自己的树上);
  **注册表自身只可增不可删**。别名解析下沉 `eslint-rules/decorator-identity.mjs`,补齐 namespace
  (`@CV.IsOptional()`)/ 局部中转(`const Opt = IsOptional`)/ re-export 三种此前静默放行的写法。
  第 17 条 `@Param('id')` 升格为自定义规则 `srvf/no-param-id-string`,存量 **70 处 / 19 文件**
  (原注释写的「71」已漂)按「类名.方法名.参数名」逐条冻结 —— 原先是整文件豁免 +
  一句**没有执行位**的「只减不增」,往名单内 controller 新增一个照样全绿。

  ⑤ **Swagger 文案订正**(M5)—— `POST admin/v1/team-join/applications/:id/join` 的 summary 删掉已废止的
  「综合评估本轮有效/延长期」:`approved` 资格不随轮关闭失效,一键入队不消费 `evaluationExtendedUntil`。
  contract snapshot 与 openapi 同步;**行为一字未变**。

  执行位:新增 `team-join-gate-evaluate-member-lock-concurrency` · `team-join-enrollment-identity-invariant` ·
  `attendance-final-approve-scale-isolation` 三个并发 spec,并给
  `team-join-enrollment-lifecycle-concurrency` 补 `join × updateTargets|markGate|evaluate` 双向 barrier。
  既有白盒 barrier 的**观测点随锁序翻面**(`FOR NO KEY UPDATE` → `FOR UPDATE` / `pg_advisory_xact_lock`),
  **结果断言一字未动**。🔴 Release NO-GO 不解除。
