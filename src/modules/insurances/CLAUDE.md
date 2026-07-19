# insurances — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md)；参与域边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md)。本文件只记录保险模块当前代码事实与 D-INSURANCE v3 分阶段边界。

## Scope 与当前行为

- App 自助 `app/v1/me/insurances`、Admin 队保单/覆盖名单与队员保险查询仍沿既有行为；`InsuranceRequirementService` 是 activity-registration 的唯一跨模块保险出口。
- D-INSURANCE v3 PR2 增加唯一审核动作 `POST admin/v1/members/:memberId/insurances/:insuranceId/review`：body 仅 `decision=verified|rejected` + 必填 `expectedVersion`；Service 只走 `rbac.can('member-insurance.review.record')`。
- 审核锁序固定 Authz → Member `FOR UPDATE` → live 且属于该 member 的 MemberInsurance `FOR UPDATE NOWAIT` → audit；版本冲突/NOWAIT 分别统一 `26011`，非 pending 为 `26012`。mutation 与 `member-insurance.review` audit 同事务；audit before/after 仅 status+version，extra 仅 memberId/insuranceId/decision。
- App PATCH/DELETE 在 PR2 的 `expectedVersion` 仍 optional；有版本则锁后 CAS，实质 PATCH `version+1` 并回 pending/清 reviewer-time，DELETE `version+1` 但保留审核结论，空/trim 等值/北京 date-only 等值 PATCH 是真 no-op。缺/带版本只记无 PII/ID 的结构化使用事实。
- App/Admin 保险响应只 additive 暴露 `reviewStatusCode`、`version`、`reviewedAt`；不得暴露 reviewer 身份或新增 insurer/policy/note/image/key/URL 等审核审计内容。
- `InsuranceEligibilityEvidence` 是兼容期 nullable 双 source（self/team coverage）× 双 owner（activity registration/team join application）骨架，全部 FK `ON DELETE RESTRICT`；PR1 不生成、不读取 evidence。
- 现有 consumer 仍按旧语义：任意 live self 或既有 live team coverage 可满足活动保险要求；不生成 evidence，`TeamJoinCycle.requiresInsurance` 仍不生效。PR2 **不宣称**资格真实性或来源风险关闭。

## 分阶段硬边界

- PR3 只有在 App/Admin build 与旧 server 清零证据齐全后，才能用单 gate 同时切 App required CAS、verified-only、evidence 与 Team Join；PR4 才加 exactly-one、kind 对齐、区间、review snapshot、同 member、global single-owner 与 immutable DB 约束。
- Evidence 不得存 insurer/policy number、note/reason、图片/附件、key/URL/signed URL、reviewer name 或任何自由文本；不得在 owner 表增加 `evidenceId`。
- PR2 不得增加第二 route/permission/AuditLogEvent，不得提前增加 `26031`，不得改 schema/migration/config gate/activity/team-join consumer，也不得把 App `expectedVersion` 提前切 required。

## Validation

- 先跑 insurances unit/characterization，再跑派生 PostgreSQL 的 `app-me-insurances.e2e-spec.ts`、`admin-member-insurances-review.e2e-spec.ts` 与必要 team/activity consumer 回归；contract snapshot diff 必须逐行解释。
- 常规静态门禁：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test:contract`、`pnpm docs:rbacmap:check`。
- 本 lane 停在独立 review 前，不自行运行全仓 full；review 修正全零后由总控安排独占 full。
- 禁止自动运行 `prisma migrate dev|reset|db push`；默认/生产 DB 永不触碰。
