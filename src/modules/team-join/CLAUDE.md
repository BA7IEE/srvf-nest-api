# team-join — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md)；上下文边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md)。本文件只记录本目录当前事实与 D-INSURANCE v3 分阶段边界。

## Scope 与当前行为

- 本模块负责入队轮、申请、gate/综合评估、贡献值进度与最终入队；既有状态机、锁序、权限与审计均不因保险 PR1 改变。
- D-INSURANCE v3 PR1 仅给 `TeamJoinCycle` 增加 `requiresInsurance @default(false)`，并给 `TeamJoinApplication` 增加 Evidence 反向 relation；没有 runtime consumer，现有轮次与旧 binary 行为不变。
- `InsuranceEligibilityEvidence.teamJoinApplicationId` 是 nullable `ON DELETE RESTRICT` owner FK；PR1 不创建 evidence，也不在 application 增加 `evidenceId`。

## Risk points

- ❌ PR3 单 gate cutover 前不得读取或执行 `requiresInsurance`，不得改变 final join 资格计算/锁序/写集。
- ❌ PR1 不接 review/CAS/verified-only，不新增 route/DTO/permission/BizCode/AuditLogEvent/config/seed/RBAC。
- ❌ Evidence 不得出现保单号、图片/附件、key/URL、note/reason 或自由文本。
- ❌ PR4 前不得加入 exactly-one、同 member、single-owner、immutable trigger 等最终约束。

## Validation

- 无 DB/Jest 阶段：`pnpm prisma:validate`、`pnpm typecheck`、`pnpm lint`、`pnpm build`。
- migration review 放行后才运行保险 migration/reset e2e 与受影响 characterization。
