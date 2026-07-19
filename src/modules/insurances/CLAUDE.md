# insurances — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md)；参与域边界读 [`/docs/participation-bounded-context.md`](../../../docs/participation-bounded-context.md)。本文件只记录保险模块当前代码事实与 D-INSURANCE v3 分阶段边界。

## Scope 与当前行为

- App 自助 `app/v1/me/insurances`、Admin 队保单/覆盖名单与队员保险查询沿既有 surface；`InsuranceRequirementService` 是 Activity/Team Join 的唯一保险资格与 evidence 出口。
- D-INSURANCE v3 PR2 增加唯一审核动作 `POST admin/v1/members/:memberId/insurances/:insuranceId/review`：body 仅 `decision=verified|rejected` + 必填 `expectedVersion`；Service 只走 `rbac.can('member-insurance.review.record')`。
- 审核锁序固定 Authz → Member `FOR UPDATE` → live 且属于该 member 的 MemberInsurance `FOR UPDATE NOWAIT` → audit；版本冲突/NOWAIT 分别统一 `26011`，非 pending 为 `26012`。mutation 与 `member-insurance.review` audit 同事务；audit before/after 仅 status+version，extra 仅 memberId/insuranceId/decision。
- PR3 客户端契约把 App PATCH body / DELETE query 的 `expectedVersion` 标为 required；single gate=true 时缺失/null/空白在事务前统一 40000 且零写/审计，显式 stale 仍 26011。gate=false 保留 PR2 optional runtime compatibility。实质 PATCH `version+1` 并回 pending/清 reviewer-time，DELETE `version+1` 但保留审核结论，等值 PATCH 是真 no-op。
- App/Admin 保险响应只 additive 暴露 `reviewStatusCode`、`version`、`reviewedAt`；不得暴露 reviewer 身份或新增 insurer/policy/note/image/key/URL 等审核审计内容。
- single gate=true 的来源固定 verified live self → live Team Policy+Coverage；self 排序 `coverageEnd DESC,coverageStart DESC NULLS LAST,reviewedAt DESC,id ASC`，team 排序 `policy.coverageEnd DESC,coverageStart DESC NULLS LAST,policy.id ASC,coverage.id ASC`。source 锁保持 self `FOR SHARE` 或 Policy→Coverage，覆盖写固定 Policy→稳定 Coverage 集→稳定 Member。
- `InsuranceEligibilityEvidence` 使用 PR1 nullable 双 source×双 owner骨架；producer 在最终 create 前复核区间、覆盖、source/member 与 self revision/reviewer/reviewedAt，owner/来源任一异常 fail-closed。只保存 source/owner/revision/review snapshot、required interval 与 coverage snapshot；禁止保险公司、保单号、note/reason、图片/key/URL/自由文本。
- gate=false 时 Activity 保留旧 consumer、Team Join 不查资格，二者均 0 evidence；gate=true 时 Activity 无来源仍 26030，Team Join final join 无来源仅用 26031。

## 分阶段硬边界

- `INSURANCE_ENFORCEMENT_ENABLED` 必须保持单 gate，归 `app.config.ts`；production 显式配置且上线先 drain 旧 server/旧事务、禁止混档。本 PR 只交付可切换代码，不表示已部署或旧 server=0 已验证。
- PR4 才加 exactly-one、kind 对齐、区间、review snapshot、同 member、global single-owner 与 immutable DB 约束；PR3 应用层必须在这些约束缺席时 fail-closed。
- Evidence 不得存 insurer/policy number、note/reason、图片/附件、key/URL/signed URL、reviewer name 或任何自由文本；不得在 owner 表增加 `evidenceId`。
- 不得拆 gate、增加第二 review route/permission/AuditLogEvent，或把 26031 用到 Team Join final join 之外；不得在 PR4 前模拟/新增 schema 约束。

## Validation

- 先跑 insurances unit/characterization，再跑派生 PostgreSQL 的 App CAS、review、Activity 与 Team Join suites；竞态必须两 Nest/两 Prisma pool + `pg_stat_activity/pg_blocking_pids` barrier，contract snapshot diff 必须逐行解释。
- 常规静态门禁：`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test:contract`、`pnpm docs:rbacmap:check`。
- 独立 review P0–P3 清零后才由总控安排独占 full。
- 禁止自动运行 `prisma migrate dev|reset|db push`；默认/生产 DB 永不触碰。
