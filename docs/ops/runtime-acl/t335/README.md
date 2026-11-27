# t335：review 角色对 RegistrationFormField 的列级 SELECT

冻结 8a 批准路径（`@ActivityCommand('review')`）会按 `formVersionSelect` 读取 `public."RegistrationFormVersion"` 及其子表 `public."RegistrationFormField"`。官方 `grant-review.sql` 只给 `srvf_activity_review` 授了 Version 的列级 SELECT，没有授 Field。验收库因此在批准时出现 SQLSTATE 42501（permission denied for table RegistrationFormField），过滤器映射为 503／50300。同一秒报名表 PUT 成功，是因为 PUT 没有 `@ActivityCommand`，走 `srvf_t68_api` 的表级 DML。

本目录与 Prisma 迁移 `20261128080000_review_registration_form_field_select` 只持久化 **review 角色、Field 表、21 列 SELECT**。列集来自冻结 8a 实际 STATEMENT：`id`、`fieldCode`、`typeCode`、`label`、`helpText`、`required`、`visibilityCode`、`exportable`、`sortOrder`、`minValue`、`maxValue`、`minLength`、`maxLength`、`maxSelections`、`optionsJson`、`purposeCode`、`dataClassCode`、`retentionPolicyCode`、`maskingPolicyCode`、`prefillSourceCode`、`formVersionId`。不带 GRANT OPTION，不授 INSERT／UPDATE／DELETE，不授其他表或 PUBLIC。

## 现网与仓库的关系

验收库已在 2026-11-28 07:24:07 Asia/Shanghai 按同一语句手工授过权（widget t335s2292 授权，最小可逆）。本迁移是仓库里的持久修复，供其他环境和以后部署使用。在已经授过相同列特权的库上重复执行是幂等的。本 PR 不得自行合并，也不得部署或重启验收站 API 容器；现网 API 仍冻结 8a。

对应 REVOKE 见 `revoke-review-formfield-select.sql`。不要把它当作常规部署步骤。

## draft 角色缺口（未授权，不得随迁移自动应用）

同窗报名表 GET（`@ActivityCommand('draft')`）也曾以 `srvf_activity_draft` 在同一张表上 42501。`draft-role-not-authorized.sql` 只记录若将来单独授权时的最小语句，**没有**写入 Prisma 迁移，也尚未在验收库执行。

## 一次批准复测（未再打、未扩权）

对审核单 `cmwz26jnx02b0ny01itbub0fm`（隔离草稿 `cmwz1vy7f02a1ny01xuigxskj`）只批准一次。GRANT 之后不再出现 42501。结果是 HTTP 409／业务码 20030：活动仍为 draft，但 `endAt` 已过（2026-11-28 02:02:11.001 Asia/Shanghai），冻结 8a `ensureInitialPublishable` 拒绝发布。审核单仍 pending，Issue 8 未走。
