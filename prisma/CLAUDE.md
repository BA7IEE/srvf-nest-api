# prisma — 本地铁律

> 全局规则读 [`/AGENTS.md`](../AGENTS.md);部署 / 迁移流程读 [`/docs/deployment.md`](../docs/deployment.md);开工门禁读 [`/docs/current-state.md §5`](../docs/current-state.md)。

## 本地事实

- `schema.prisma` 是**数据模型唯一权威源**(字段 / 类型 / 约束 / 索引);Swagger / DTO / docs 任何与之冲突,**以 schema.prisma 为准**。
- `migrations/` 累计 33 个 migration(2026-05-02 `init` → 2026-07-01 终态 scoped-authz PR2 Membership:净新表 `member_organization_memberships`〔+2 枚举 `MembershipType`/`MembershipStatus` + 末尾 2 手写 partial unique:`primary_active_unique` (memberId) WHERE deletedAt IS NULL AND status='ACTIVE' AND membershipType='PRIMARY' / `active_unique` (memberId,organizationId,membershipType) WHERE deletedAt IS NULL AND status='ACTIVE'〕 + 回填每条 active `MemberDepartment`→PRIMARY membership〔复用 id、startedAt=createdAt、createdAt/updatedAt 原样〕,纯加、可逆、旧表冻结不删;前一为 2026-07-01 终态 scoped-authz PR1 组织基座:新表 `organization_closure` 闭包表〔`(ancestorId,descendantId,depth)`,末尾 `WITH RECURSIVE` 从现有 `parentId` 树一次性回填含 depth-0 自身行〕 + `Organization` 两 additive 可空列 `establishmentStatusCode?`/`groupFunctionCode?`〔纯加、无 default、无 enum、无回填、无不可逆〕;再前为 2026-06-29 招新实名 OCR 鉴伪版充分利用:`recruitment_applications` +6 列〔`ocrAddress`/`ocrNation`/`ocrAuthority`/`ocrValidDate` OCR 扩展字段顾问式存档 + `idCardCropImageKey`/`idCardPortraitImageKey` 主体框/头像裁剪图 key;全可空 TEXT additive,无 enum、无不可逆、无回填〕;再前为 2026-06-27 统一通知模块 S5 短信兜底 `sms_settings.templateIdNotification` 1 列 / S3 `notifications.recipientMemberId` 1 列 / S2 三表 / S1 两表)。
- migration 命名格式:`YYYYMMDDHHMMSS_<可读描述_下划线分隔>`(例 `20260510193742_v2_batch3_activities_attendances`);**不**允许 `auto` / `tmp` / `wip` 命名。
- 生产环境只允许 `prisma migrate deploy` 跑**已审查**的 migration(沿 `AGENTS.md §0`)。

## 不要做(踩雷区)

- ❌ **不**自动执行 `prisma migrate dev` — 必须先**说明将生成 / 执行的 migration 内容**并等待用户确认。
- ❌ **不**自动执行 `prisma db push`(绕过 migration,不可回溯)。
- ❌ **不**自动执行 `prisma migrate reset`(销毁全部数据)。
- ❌ **不**手动改 `migrations/**/migration.sql` 已合入历史(沿 A-3 / A-4 红线)。
- ❌ **不**使用 Prisma **全局软删中间件 / client extension**(沿 `AGENTS.md §1 永久铁律`)。
- ❌ **不**在 schema 上加 `@map` / `@@map` 改库表名(命名约定锁定)。
- ❌ 修改 schema 前**必须先**说明:影响哪些 service / DTO / Swagger / OpenAPI snapshot / contract test;以及是否触发 D 档(沿 [`/docs/process.md §4`](../docs/process.md))。

## seed.ts

- 默认 super admin + bootstrap user_role;生产启动强校验 `SUPER_ADMIN_*` / `JWT_SECRET` / `APP_CORS_ORIGIN`,任一不满足直接抛错退出。
