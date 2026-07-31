# team-join — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md)；上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md)。本文件只记录本目录当前事实与 D-INSURANCE v3 分阶段边界。

## Scope 与当前行为

- 本模块负责入队轮、申请、gate/综合评估、贡献值进度与 final join；`requiresInsurance` 已进入 Cycle create/update/response，create 缺省 false。
- `computeContribution`/`computeCappedContribution` 是 approved-only、北京时间自然日封顶 3、按 cycle.year cutoff 的唯一贡献值真值；考勤终审达标通知只允许在同一事务内分别于 approved 前后调用该真值，不得复制 cap 算法或用原始分反推。
- single gate=false 时该 flag 仅配置/回显，不查询保险、不生成 evidence；gate=true 且 cycle=true 时只在 **final join** 捕获一次 now，以北京日 `requiredFrom=requiredThrough` 校验 verified self → live Team Policy+Coverage，无来源 26031。
- final join 根锁序固定 Application→Cycle→source(self 或 Policy→Coverage)→Member→linked User→join writes→Evidence→Audit/outbox；evidence 绑定 TeamJoinApplication 且只含最小 snapshot，任一失败全回滚。申请创建/评估阶段绝不提前生成。
- Cycle update 固定先按 `id ASC` 锁该 cycle 全部 live Application，再锁/重读 Cycle 后 update/audit，与 final join 同向；禁止退回无锁 `findFirst`。
- **member 线性化键(并发审计 K2,2026-07-31)**:App `submit` 与 final join 都在事务第一步调用 `common/prisma/member-advisory-lock.util.ts` 的 `lockMembersForWrite`。「这个人是否已入队」是跨行事实(`Member.gradeCode` + 归属任期),没有任何单行锁能锁住它;submit 不取键时,一键入队可以整个跑在它的「读」与「建行」之间,写入发生时人已经是队员却仍新增申请。final join 必须在**任何 Application 行锁之前**取键 —— 同一队员可同时存在两条 approved 申请,两个终审各锁一条再反向争 Member,加上同人终态级联就是 40P01。行锁图 Application→Cycle→source→Member **逐字不变**,这把键只是最外层线性化。
- **final join 终态级联**:同事务内按 `id ASC` 锁并终结该队员其它 live 申请(`joining`/`pending_evaluation`/`approved`)为 `rejected` + `eliminationStage='already-enrolled'`,逐条写 `team-join-application.supersede` audit;刻意不写 `evaluatedByUserId`/`evaluatedAt`(没有人评估过它)。⚠️ 终结依据是「这个人已经是队员了」,**不是**「轮关闭了」——关轮不使 approved 资格失效(`docs/handoff/admin-web.md:528`)那条契约不受本刀影响,边界由 e2e 锁住。
- **全部写路径 member-first(M1/M5,2026-08-01)**:`submit` / `updateTargets` / `markGate` / `evaluate` / final join
  **五条 surface 一律**先取 `lockMembersForWrite`,再锁 Application 行。admin 侧两条共用唯一入口
  `TeamJoinApplicationsService.lockMemberThenApplication`(预读 memberId → 键 → `FOR UPDATE` → 复读复核);
  `evaluate` 因此**不再用 `claimAtStatus`** —— 锁后读即 authoritative,那句「与锁前读数一致」的断言没有对象了。
  ❌ **不得**把键挪到行锁之后:final join 持键并在步骤 9 反向争同人 sibling 行锁,反序稳定 40P01(已有可复现用例)。
  `updateTargets` 曾是唯一漏网的一条,实测与 final join 死锁 —— 环是
  「它持 sibling 行锁 → 写 audit 要在本人 User 行取 `FOR KEY SHARE` → 那一行被 final join 的
  `lockLinkedUserLifecycle` 攥着 → final join 又要 sibling 行锁」。
- **入队身份闸(M2)**:`isUnenrolledVolunteer` 是 live 申请**唯一**的走通前提,唯一 transition 落在
  [`team-join-enrollment-invariant.ts`](team-join-enrollment-invariant.ts)。除 final join 外的写方要改这个身份,
  必须先过它;有 live 申请就返 **28211**(拍板:不自动终结、不静默放行)。闸内**先取 member 键**,
  所以调用方必须把它排在 `lockMemberLifecycle` **之前**。
- **事务开法(M3)**:凡事务内会取队员键的,一律走 `runMemberLinearizedTransaction`
  (显式 `ReadCommitted` + 有界锁等待)。❌ 不得退回裸 `prisma.$transaction`:
  库默认若是 REPEATABLE READ,快照停在取键之前,排到队也读不到刚提交的事实,write skew 原样复活(有实测用例)。
- E2E 执行位:`test/e2e/team-join-enrollment-lifecycle-concurrency.e2e-spec.ts`(真双连接;含「已入队队员名下不得有 live 申请」的全库巡检断言 + `join × updateTargets|markGate|evaluate` 双向 barrier)·
  `team-join-gate-evaluate-member-lock-concurrency.e2e-spec.ts`(M1 锁序与 write skew)·
  `team-join-enrollment-identity-invariant.e2e-spec.ts`(M2 八个写方 + 反向不误伤)。

## Risk points

- ❌ 不拆 single gate、不在 final join 之前生成/消费 evidence、不改变 Application→Cycle→source→Member 锁图；gate=false 不得留下资格查询或 evidence。
- ❌ 不新增 route/permission/AuditLogEvent/schema/seed/RBAC；26031 只用于 Team Join final join 无合格保险。
- ❌ Evidence 不得出现保单号、图片/附件、key/URL、note/reason 或自由文本。
- ❌ PR4 最终 exactly-one、kind/interval/review snapshot、同 member、single-owner、immutable migration 代码已交付于本 PR但尚未 deploy、生产未生效；应用层 fail-closed 仍保留，禁止新增 Evidence 改删路径或把约束错误映射成新 BizCode。

## Validation

- 运行 team-join focused E2E，覆盖 flag false/true、自购/队保、owner/source 复核、audit rollback 与双请求；final join↔cycle update、review↔final join、coverage remove↔final join 必须两 Nest/两 Prisma pool + `pg_stat_activity/pg_blocking_pids` barrier。
- 常规门禁：`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test:contract`；禁止自动 `prisma migrate dev|reset|db push`。
