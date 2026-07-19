# team-join — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md)；上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md)。本文件只记录本目录当前事实与 D-INSURANCE v3 分阶段边界。

## Scope 与当前行为

- 本模块负责入队轮、申请、gate/综合评估、贡献值进度与 final join；`requiresInsurance` 已进入 Cycle create/update/response，create 缺省 false。
- single gate=false 时该 flag 仅配置/回显，不查询保险、不生成 evidence；gate=true 且 cycle=true 时只在 **final join** 捕获一次 now，以北京日 `requiredFrom=requiredThrough` 校验 verified self → live Team Policy+Coverage，无来源 26031。
- final join 根锁序固定 Application→Cycle→source(self 或 Policy→Coverage)→Member→linked User→join writes→Evidence→Audit/outbox；evidence 绑定 TeamJoinApplication 且只含最小 snapshot，任一失败全回滚。申请创建/评估阶段绝不提前生成。
- Cycle update 固定先按 `id ASC` 锁该 cycle 全部 live Application，再锁/重读 Cycle 后 update/audit，与 final join 同向；禁止退回无锁 `findFirst`。

## Risk points

- ❌ 不拆 single gate、不在 final join 之前生成/消费 evidence、不改变 Application→Cycle→source→Member 锁图；gate=false 不得留下资格查询或 evidence。
- ❌ 不新增 route/permission/AuditLogEvent/schema/seed/RBAC；26031 只用于 Team Join final join 无合格保险。
- ❌ Evidence 不得出现保单号、图片/附件、key/URL、note/reason 或自由文本。
- ❌ PR4 前不得加入 exactly-one、kind/interval/review snapshot、同 member、single-owner、immutable trigger 等最终 DB 约束；应用层仍须 fail-closed。

## Validation

- 运行 team-join focused E2E，覆盖 flag false/true、自购/队保、owner/source 复核、audit rollback 与双请求；final join↔cycle update、review↔final join、coverage remove↔final join 必须两 Nest/两 Prisma pool + `pg_stat_activity/pg_blocking_pids` barrier。
- 常规门禁：`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm test:contract`；禁止自动 `prisma migrate dev|reset|db push`。
