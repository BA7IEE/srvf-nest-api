# insurances — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md)；参与域边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md)。本文件只记录保险模块当前代码事实与 D-INSURANCE v3 分阶段边界。

## Scope 与当前行为

- App 自助 `app/v1/me/insurances`、Admin 队保单/覆盖名单与队员保险查询仍沿既有行为；`InsuranceRequirementService` 是 activity-registration 的唯一跨模块保险出口。
- D-INSURANCE v3 PR1 只扩数据骨架：`MemberInsurance.reviewStatusCode` 默认 `pending`、`version` 默认 `0`、reviewer/time 可空；所有 legacy（含软删）统一 pending/v0/null reviewer，不猜测 verified。
- `InsuranceEligibilityEvidence` 是兼容期 nullable 双 source（self/team coverage）× 双 owner（activity registration/team join application）骨架，全部 FK `ON DELETE RESTRICT`；PR1 不生成、不读取 evidence。
- 现有 consumer 仍按旧语义：任意 live self 或既有 live team coverage 可满足活动保险要求。PR1 **不宣称** stale-write、审核真实性或资格来源风险关闭。

## 分阶段硬边界

- PR2 才能增加审核 route/CAS compatibility；PR3 客户端与旧 server 证据齐全后，单 gate 同时切 required CAS、verified-only、evidence 与 Team Join；PR4 才加 exactly-one、kind 对齐、区间、review snapshot、同 member、global single-owner 与 immutable DB 约束。
- Evidence 不得存 insurer/policy number、note/reason、图片/附件、key/URL/signed URL、reviewer name 或任何自由文本；不得在 owner 表增加 `evidenceId`。
- 不得在 PR1 修改 controller/DTO/permission/BizCode/AuditLogEvent/config/seed/RBAC/runtime consumer 或 contract。

## Validation

- 无 DB/Jest 阶段：`pnpm prisma:validate`、`pnpm typecheck`、`pnpm lint`、`pnpm build`。
- 独立 migration review 放行后才运行 `insurance-expand-migration.e2e-spec.ts`、`insurance-reset-db.e2e-spec.ts` 与 full gate。
- 禁止自动运行 `prisma migrate dev|reset|db push`；默认/生产 DB 永不触碰。
