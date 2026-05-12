# Changelog

本仓库版本号在 `package.json#version` 与 Swagger `setVersion(...)` 同步维护;tag 由维护者按需打。

## Unreleased

## v0.7.0 - 2026-05-12

V2 第一阶段在 v0.6.0(批次 5-A 落地,V2 77 接口)基础之上,完成 SRVF 业务 **批次 6 PR #1 + PR #2**
(`audit_logs` 基础设施 + 第一批 8 处写操作迁移落库),**累计 V2 79 接口**(原 77 + audit-logs
查询 2);**累计 93 接口** contract snapshot 保护;v1 14 + V2 既有 77 接口 schema + paths
严格 **zero drift**。

**SemVer 预判**(下一独立 PR `chore: bump version to 0.7.0` 时拍板):0.6.0 → 0.7.0 **minor**
(向后兼容的功能新增:`audit_logs` 表 + 2 个查询接口 + 8 处写操作改记审计;沿 v0.5.0 → v0.6.0 风格)。

**重要业务能力**(前端 / 运营 / 接入方必读):

- 新增 `/api/v2/audit-logs` 2 个查询接口,统一 `@Roles(SUPER_ADMIN, ADMIN)`;
  `ADMIN` 仅能看自己操作 OR 操作对象是 `USER` 的审计记录(`list` where 注入 +
  `detail` 二次校验,越级查 `SUPER_ADMIN` 的详情 → `14101 FORBIDDEN_AUDIT_LOG_READ` / 403)
- 紧急联系人(`emergency-contacts`)与证书(`certificates`)的 **8 个写操作**
  (`create` / `update` / `softDelete` × 3 + `verify` / `reject` × 2)自动写入 `audit_logs`;
  返回结构、HTTP status、路径**完全不变**,前端无需调整
- 敏感字段(紧急联系人 `contactName` / `phonePrimary` / `phoneBackup` / `address`)
  在审计上下文中**已打码**(`张*` / `138****1111` / `广东省深圳市******`);
  证书字段全部非敏感,**原值入审计**(沿 Q4 业务确认稿打码矩阵)
- **不记录查看行为**(Q1=A 业务决议):列表 / 详情 / 资质查询接口**不写** `audit_logs`,
  仅 pino 结构化日志保留(`auditPlaceholder` 28 项 union 中 22 项**继续 pino-only**;
  本批次仅 6 项落库,后续批次按需迁出)
- **不做失败操作审计**(D-B fail-fast):业务 `BizException` 回滚整个 `prisma.$transaction`,
  `audit_logs` 与业务表同时入 / 同时不入,**不存在"操作失败但审计成功"的中间态**
- **不做 audit_logs 自身审计**(F6):查询 `/api/v2/audit-logs` 不会产生新审计记录
- **写入后不可改不可删**(R1 红线):`AuditLog` model 无 `updatedAt` / `deletedAt`;
  controller 不开放 `POST` / `PATCH` / `PUT` / `DELETE`(框架返 404);测试库**豁免**(`TRUNCATE` 仅 `test/helpers/audit-logs-cleanup.ts` 双保险 helper 可调用)

详见 [`docs/批次6_audit_logs_API前评审.md`](docs/批次6_audit_logs_API前评审.md) v1.1 D6 评审稿
(25 项决议:B1-B5 / D1-D10 / F1-F10)与下方批次 6 子段。

### V2 Batch 6 PR #1 Implementation(2026-05-12)

- `9aac9d0` feat(audit-logs): add schema + module + AuditLogsService + maskPii util (#29) —
  **新增 `prisma/migrations/20260512140546_v2_batch6_audit_logs/migration.sql`**:`audit_logs`
  表 9 业务字段 + `actorUser` FK Restrict + 3 复合索引(`(resourceType, resourceId)` /
  `(actorUserId, createdAt)` / `(event, createdAt)`),**无 `updatedAt` / `deletedAt`**(R1 红线);
  **新增 `src/modules/audit-logs/` 模块**(主体 4 文件 + `audit-logs.select.ts` 安全字段 select
  + `audit-logs.types.ts` 6 项 `AuditLogEvent` union + 6 字段 `AuditContext` 锁形 + `AuditMeta`
  3 字段,共 6 文件,D6 v1.1 §15.3);
  **新增 2 接口**(全部 `@Roles(SUPER_ADMIN, ADMIN)`):`GET /api/v2/audit-logs`(分页 +
  6 字段过滤:`resourceType` / `resourceId` / `event` / `actorUserId` / `startDate` /
  `endDate`)/ `GET /api/v2/audit-logs/:id`(`assertCanReadAuditLog` 二次校验,越级 403);
  **新增 `src/common/audit/mask-pii.util.ts`** 4 函数(`maskName` / `maskPhone` /
  `maskAddress` / `maskIdCard`;空字符串 / null / undefined 统一短路返 `null`,D6 v1.1 §7.1);
  **新增 BizCode `140xx + 141xx`** 段位 2 码:`14001` `AUDIT_LOG_NOT_FOUND` / `14101`
  `FORBIDDEN_AUDIT_LOG_READ`;**不开**(沿 D6 v1.1 §9):`14002+`(无唯一约束)/ `14010+`
  (无业务级输入校验)/ `14102+`(沿 baseline,USER 越权走通用 `FORBIDDEN` / 40300);
  **`AuditLogsService.log()`** 落库入口,接受 `tx?: Prisma.TransactionClient` 透传
  (D9 同事务保证;不引入 cls-rs / AsyncLocalStorage,D8 显式 meta 路径);
  **`AuditEvent`(28 项)与 `AuditLogEvent`(6 项)物理隔离**(D2):前者留 pino-only 占位
  在 `src/common/audit/audit-placeholder.ts`,后者走 DB 落库在 `src/modules/audit-logs/audit-logs.types.ts`;
  事件名同值,后续批次迁移**仅是把字符串从一个 union 挪到另一个**;
  **`test/helpers/audit-logs-cleanup.ts`** `truncateAuditLogsTestOnly` helper:
  `assertTestDatabaseUrl` 强制 `app_test` 子串 + `APP_ENV !== 'production'` 双保险防御,
  仅 `test/` 引用,生产代码绝不可调用(F10 红线);
  **unit**:`mask-pii.util.spec.ts` 30 + `audit-logs.service.spec.ts` 15(`log` 7 + `findOne`
  权限矩阵 8) = 45 新增;**e2e**:`test/e2e/audit-logs.e2e-spec.ts` 38 用例覆盖 D6 v1.1 §12
  PR #1 矩阵(权限边界 4 + list where 注入 4 + detail 权限 7 + list 过滤 + 排序 7 + 分页 2 +
  不可改不可删 4 + AuditContext 锁形 5 + 不审计自身 2 + DTO 白名单 2 + cleanup helper 1);
  **OpenAPI contract snapshot 更新**:新增 2 paths(`/api/v2/audit-logs` × 2)+ 2 named schemas
  (`AuditContextDto` / `AuditLogResponseDto`);`AuditLogQueryDto` 沿 batch 3 `@Query` 内联范式
  不入 `components.schemas`;v1 14 + V2 既有 77 schemas / paths **零漂移**

### V2 Batch 6 PR #2 Implementation(2026-05-12)

- `aeb2ea8` feat(audit-logs): migrate emergency-contacts + certificates write events to AuditLogsService (#30) —
  **8 处写操作迁移**(D6 v1.1 §8.2 D-A 修订核心):
  - `emergency-contacts.service.ts` 3 处:`create` / `update` / `softDelete`(事件 `emergency-contact.write`)
  - `certificates.service.ts` 5 处:`create` / `update` / `softDelete` / `verify` / `reject`
    (事件 `certificate.create` / `.update` / `.delete` / `.verify` / `.reject`)
  - 调用样式从 `auditPlaceholder(event, ctx)` 改为 `await this.auditLogs.log({ ..., tx })`,
    `tx` 来自业务 `prisma.$transaction` 内,**audit 与业务同事务、同回滚**(D-B fail-fast,D9);
  **8 处 controller 改造**:`emergency-contacts.controller.ts` 3 个 + `certificates.controller.ts`
  5 个写方法各加 `@Req() req: Request` 参数,通过 controller 内 `buildAuditMeta(req)` 私有方法
  从 nestjs-pino `req.id` + `req.ip` + `req.headers['user-agent']` 显式构造 `AuditMeta` 传给
  service(D8:不引入 cls-rs / AsyncLocalStorage);
  **2 个 module 改造**:`emergency-contacts.module.ts` + `certificates.module.ts` 各 `imports:
  [DatabaseModule, AuditLogsModule]`,注入 `AuditLogsService`;
  **service 内部 select 扩展**:`findContactInMemberOrThrow` / `findCertificateInMemberOrThrow`
  的 `select` 由 `{ id, memberId[, certStatusCode] }` 扩展为完整 `*SafeSelect`(全字段),
  让 `update` / `softDelete` / `verify` / `reject` 一次 query 即可拿到 `before` 数据,无需额外
  round-trip(D6 v1.1 §8.2);返回类型变为 `Safe*` 类型,调用方仅取 `id` / `memberId` /
  `certStatusCode` 的语义**完全兼容**(类型是超集);
  **打码矩阵实施**(D6 v1.1 §7.3 / Q4 业务确认稿):紧急联系人 4 字段经 `maskName` /
  `maskPhone` / `maskAddress` 打码后入 `audit.context.before` / `after`;证书字段全部非敏感
  原值入审计;`Date` 字段统一 `.toISOString()` 避免 Prisma `InputJsonValue` 拒 `Date` 对象
  (D6 v1.1 §R5);`verify` / `reject` 的 `before` / `after` 仅状态相关字段(`status` /
  `verifyNote`),非完整快照;
  **22 处未迁移 `auditPlaceholder` 调用零修改**(F2 / D1 决议):member-profiles 1 / emergency-contacts
  `read.other` 1 / certificates `read.other` × 2 + `read.qualification-flag` 1 / activities 5 /
  registrations 7 / attendances 12 / contribution-rules 3 = 32 处其它调用全部继续 pino-only,
  后续批次按需迁出;**事件名同步,迁移成本极低**;
  **e2e**:新增 `test/e2e/audit-logs-migrations.e2e-spec.ts` 25 用例覆盖 D6 v1.1 §12 PR #2 矩阵
  (8 处迁移 hook 触发 + 5 before/after 结构 + 6 打码生效 + 2 同事务行为 + 4 未迁移路径不入库);
  **既有 e2e 零退化**:emergency-contacts(33 用例)/ certificates(50 用例)/ v1 + V2 既有
  661 用例 100% 通过(D6 v1.1 §15.1 A 档门槛);
  **OpenAPI contract snapshot 零漂移**:`@Req()` 不污染 OpenAPI,170 / 170 contract + 2 / 2
  snapshots 全过(本批次的核心契约保护)

### Docs(2026-05-12)

- `e8819f0` docs(v2-batch-6): archive audit_logs business confirmation (#27) —
  归档 D6 业务确认稿(Q1=A 不记查看 / Q2=A 永久保留 / Q3=B 管理员看自己 + 超管看全部 /
  Q4 打码 4 字段 / Q5=B 第一批接 EC + 证书写操作)
- `06796df` docs(v2-batch-6): archive audit_logs API review (#28) — 归档 D6 v1.1 评审稿
  (25 项决议:B1-B5 / D1-D10 / F1-F10;D-A 拍板"不升级 `auditPlaceholder` 函数体"为本批次核心)
- (本 PR)`docs(v2-batch-6): record audit_logs first-wave landing` — CHANGELOG `Unreleased`
  段批次 6 落地记录 + `docs/srvf-foundation-baseline.md §1.1` v0.6 修订(`140xx + 141xx`
  `audit_logs` 段位收口,2 个 BizCode 已实装)

### 本批次不包含(沿 D6 v1.1 §3 F1-F10 + 业务确认稿 Q1-Q5)

- **F1** 不升级 `auditPlaceholder` 函数体(D-A 拍板核心:`auditPlaceholder` 保留 pino-only
  占位实现,**永不写库**,与 `AuditLogsService.log` 物理隔离)
- **F2** 不迁移 22 处之外的 `auditPlaceholder` 调用(member-profiles / EC / certificates read
  类 / activities / registrations / attendances / contribution-rules 等 32 处其它继续 pino-only)
- **F3** 不记录任何查看行为(Q1=A 决议;list / detail / qualification-flag 接口**不写**
  `audit_logs`,仅 pino 结构化日志)
- **F4** 不接 `activities` / `activity-registrations` / `attendances` / `contribution-rules` 写事件
  (Q5=B 范围外;后续批次按需迁出)
- **F5** 不做 `audit_logs` 的 export / 复杂搜索 / 归档 / 清理 / 删除 / 编辑接口
  (R1 红线:写入后不可改不可删)
- **F6** 不做失败操作审计(D-B fail-fast:`success` 默认 `true`,`BizException` 回滚整事务,
  审计与业务同生同灭;后续不开 `success=false` 写入路径)
- **F7** 不审计 `audit_logs` 自身(避免循环;`list` / `detail` 调用不调 `log()`)
- **F8** 不引入队列 / Redis / 定时任务 / cls-rs / AsyncLocalStorage(D8:`AuditMeta` 由 controller
  层从 `@Req()` 构造显式传给 service)
- **F9** 不改 v1 任何接口 / 表 / 测试(零漂移红线)
- **F10** 不改 `prisma/seed.ts`(`audit_logs` seed 数据由 e2e 测试自行造,生产无种子)

### 验证基线(本 Unreleased 段)

| 维度 | v0.6.0 | 批次 6 PR #1 后 | 批次 6 PR #2 后(当前) |
|---|---|---|---|
| `pnpm test`(unit) | 557 / 4 suites | 612 / 6 suites(+ mask-pii 30 + audit-logs.service 15)| **612** / 6 suites |
| `pnpm test:e2e` | 661 / 31 suites | 699 / 32 suites(+ audit-logs 38)| **724** / 33 suites(+ audit-logs-migrations 25) |
| `pnpm test:contract` | 166 + 2 snapshots | 170 + 2 snapshots(+ 2 paths + 2 schemas)| **170** + 2 snapshots(零漂移) |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | 0 warnings / PASS / PASS | 0 warnings / PASS / PASS | **0 warnings / PASS / PASS** |
| CI(PR #29 / #30) | — | 3 jobs 全绿:Lint/Typecheck/E2E ~2m51s + Docker image build ~1m10s + Container boot + API smoke ~1m39s | 2 jobs 全绿:Lint/Typecheck/E2E ~2m46s + Docker image build ~1m6s(Docker Smoke paths filter 未触发,符合预期) |

### 非阻塞事项(转交后续 PR)

- **NB-1** PR #4 `chore: bump version to 0.7.0`:`package.json#version` 0.6.0 → 0.7.0 +
  `src/bootstrap/apply-swagger.ts:20` `setVersion('0.6.0' → '0.7.0')`;merge 后维护者
  手动打 `v0.7.0` tag + GitHub Release
- **NB-2** `docs/handoff/v0.6.0.md` 新建:批次 6 落地后下一会话交接 markdown,可作为
  PR #4 顺手做或独立小 PR;沿 batch 5-A `v0.5.0.md` 范式
- **NB-3** 22 处未迁移 `auditPlaceholder` 调用的批量迁出:**不立即做**,等具体业务方对
  这些 hook 提出"需要查证据 / 审计"诉求时,按事件名同步范式逐批迁出(评审稿 §8.4)
- **NB-4** `AuditLog.actorUserId` `onDelete: Restrict` 在 v1 user 软删契约下**不会触发**
  (v1 user 永远软删 `deletedAt`,不物理删除);若未来引入 user 物理删除,需要单独评审
  审计悬空策略
- **NB-5** Swagger UI 手工验收(`/api/docs` 打开试调 2 个查询接口 + 8 个写接口的典型成功 /
  错误路径)在 **PR #4 `chore: bump version to 0.7.0`** 或 **v0.7.0 release 前**补一次记录
  (B 档 baseline §14 验收门槛)

## v0.6.0 - 2026-05-12

V2 第一阶段在 v0.5.0(批次 4 全部落地,V2 72 接口)基础之上,完成 SRVF 业务 **批次 5-A**
(ContributionRule CRUD:5 个管理接口 + 230xx BizCode 段位收口 + AuditEvent +3 +
attendance e2e P2-1 缺口补齐),**累计 V2 77 接口**(原 72 + 批次 5-A 5);**累计 91 接口**
contract snapshot 保护;v1 14 + V2 既有 72 接口 schema + paths 严格 **zero drift**。

**SemVer 预判**(下一独立 PR `chore: bump version to 0.6.0` 时拍板):0.5.0 → 0.6.0 **minor**
(向后兼容的功能新增,沿 v0.4.0 → v0.5.0 风格)。

**重要业务能力**(前端 / 接入方必读):

- 新增 `/api/v2/contribution-rules` 5 个 CRUD 接口,统一 `@Roles(SUPER_ADMIN, ADMIN)`;
  APD 部门部长 / 副部长专属权限**未做**(留 5-B 独立批次)
- `durationThreshold = NULL` 多条 ACTIVE 由 service 层在 create / update 时**直接拒绝**抛
  `23002 CONTRIBUTION_RULE_ACTIVE_DUPLICATE`(DB partial unique 在 PG NULL 行为下不约束 NULL
  多条,**业务层兜底是唯一来源**)
- PATCH 禁改 `activityTypeCode` / `attendanceRoleCode` / `durationThreshold` 三元组,改维度
  必须停用旧规则后新建;由 `UpdateContributionRuleDto` 白名单 + 全局 `ValidationPipe
  forbidNonWhitelisted` 拦截抛 `BAD_REQUEST` / 40000(**不开** `23030`)
- 规则修改**只影响新提交** AttendanceSheet,**不重算**历史 / pending / pending_final_review
  / rejected / final_rejected Sheet(沿 batch 4-B "submit 时同事务内预填,之后不再读" 语义)
- `softDelete` 写 `deletedAt + deletedByUserId`(schema 已在 batch 4-A 包含字段),
  `status` 不强制改 `INACTIVE`;**注意**:`AttendanceRecord` 的软删字段集与
  `ContributionRule` 不同,5-A 不复用 / 不混淆 / 不抽公共工具

详见 [`docs/批次5-A_贡献值规则CRUD_API前评审.md`](docs/批次5-A_贡献值规则CRUD_API前评审.md) v1.1
(D6 评审稿,33 项决议)与下方批次 5-A 子段。

### V2 Batch 5-A Implementation(2026-05-12)

- `cfa396d` feat(contribution-rules): add v2 batch5-A contribution rule CRUD (#24) —
  **新增 `src/modules/contribution-rules/` 模块**(主体 4 文件 +
  `contribution-rules.select.ts` 安全字段 select 辅助文件,共 5 文件;沿 v1
  `users.select.ts` 范式,D6 v1.1 决议 E2);
  **新增 5 接口**(全部 `@Roles(SUPER_ADMIN, ADMIN)`):`GET /api/v2/contribution-rules` /
  `GET /api/v2/contribution-rules/:id` / `POST /api/v2/contribution-rules` /
  `PATCH /api/v2/contribution-rules/:id` / `DELETE /api/v2/contribution-rules/:id`;
  **新增 BizCode `230xx`** 段位 5 码:`23001` `CONTRIBUTION_RULE_NOT_FOUND` /
  `23002` `CONTRIBUTION_RULE_ACTIVE_DUPLICATE` / `23010` `CONTRIBUTION_RULE_POINTS_INVALID` /
  `23011` `CONTRIBUTION_RULE_ACTIVITY_TYPE_INVALID` / `23012` `CONTRIBUTION_RULE_ROLE_CODE_INVALID`;
  **不开**(沿 D6 v1.1 §5 / §2.2 E8 锁定):`23030` `KEY_FIELDS_NOT_EDITABLE`(PATCH 维度
  禁改交给 DTO 白名单 + ValidationPipe `forbidNonWhitelisted` 拦截)/ `23101~23104`
  `FORBIDDEN_*`(沿 baseline,Guard 拒绝走通用 `40300`)/ `23103` `LAST_RULE_PROTECTED`
  (无最后一条规则保护需求,沿 batch 4-B `22048` 不抛错路径);
  **service 行为**:`create` / `update` 同事务 ACTIVE 唯一性兜底(含 `durationThreshold = NULL`
  维度;`excludeId` 排除自身);Prisma P2002 兜底转 `23002`(沿 member-departments /
  member-profiles 范式,Prisma 6.x P2002 `meta.target` 不可靠 → 直接抛 `ACTIVE_DUPLICATE`);
  字典 `activity_type` + `attendance_role` active 校验沿 batch 3 activities 范式 inline
  `assertDictItemValid`;`update` 仅传 `pointsBelow` / `pointsAbove` / `dailyCap` / `status` /
  `remark` 5 字段(白名单 + ValidationPipe `forbidNonWhitelisted` 双重防护);`softDelete`
  写 `deletedAt + deletedByUserId`,`status` 不强制改(沿 D6 v1.1 E5);
  **AuditEvent union 新增 3 项**:`contribution-rule.create` / `contribution-rule.update` /
  `contribution-rule.delete`(`list` / `findOne` 不 hook,沿 batch 3 写操作 hook 范式;
  `auditPlaceholder` 实现仍为 pino log,**不落 `audit_logs` 表**,沿 D6 v1.1 F7);
  **e2e**:新增 `test/e2e/contribution-rules.e2e-spec.ts` 43 用例覆盖 D6 §7.1 全矩阵
  (list 7 / detail 3 / create 17 / update 10 / delete 4 / perm 2);
  **补 attendance e2e** `contributionPoints: null` 显式入参跳过预填用例(P2-1 缺口收口,
  沿 PR #22 范式;`test/e2e/attendances.e2e-spec.ts:1816`);
  **OpenAPI contract snapshot 更新**:新增 5 paths + 3 named schemas
  (`CreateContributionRuleDto` / `UpdateContributionRuleDto` / `ContributionRuleResponseDto`);
  `ContributionRuleQueryDto` 沿 batch 3 `@Query` 内联范式不入 `components.schemas`;
  v1 14 + batch 1-4 既有 schemas / paths **零漂移**

### Docs(2026-05-12)

- `1e09135` docs(v2-batch-5a): archive contribution rule CRUD API review (D6 v1.1) (#23) —
  `docs/批次5-A_贡献值规则CRUD_API前评审.md` v1.1 评审稿归档,作为 5-A 实施 PR 的前置依据
- (本 PR)`docs(v2-batch5a-landing)`:CHANGELOG `Unreleased` 段批次 5-A 落地记录 +
  `docs/srvf-foundation-baseline.md §1.1` v0.5 修订(`230xx` `contribution_rules` 段位收口,
  未规划模块从 `240xx` 起)+ `docs/handoff/v0.5.0.md` 新建(批次 5-A 落地后下一会话交接)

### 本批次不包含(沿 D6 v1.1 §2.4 F1-F10)

- **F1** 不改 `prisma/schema.prisma`(ContributionRule schema 与 partial unique 已在 batch 4-A 落地)
- **F2** 不新增 migration
- **F3** 不做 APD 部门部长 / 副部长权限细分(留 5-B)
- **F4** 5-A 不做 `dryRun` / 试算接口;若运营强需求,**作为独立批次评审立项后再做**
- **F5** 5-A 不做批量重算 attendance Sheet;默认不做,除非后续独立评审
- **F6** 不做 `contribution_points` 独立流水表 / cron-job(handoff §7.1 / `ARCHITECTURE.md §9` 升级路径锁定,**永久不做**)
- **F7** 不做 `audit_logs` 落库(留独立形态评审)
- **F8** 不改 attendance 状态机(5 态闭集 + APD 终审流程不动)
- **F9** 不改 `attendance.recorded` 触发点(仍仅 final-approve)
- **F10** 不改 v1 14 接口 + batch 1-4 schemas / paths(零漂移)

### 验证基线(本 Unreleased 段)

| 维度 | v0.5.0 | 批次 5-A 后 |
|---|---|---|
| `pnpm test`(unit) | 532 / 4 suites | **557** / 4 suites |
| `pnpm test:e2e` | 617 / 30 suites(含 PR #22 +1) | **661** / 31 suites |
| `pnpm test:contract` | 158 + 2 snapshots | **166** + 2 snapshots |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | 0 warnings / PASS / PASS | 0 warnings / PASS / PASS |
| CI(PR #24) | — | 3 jobs 全绿:Lint/Typecheck/E2E ~2m47s + Docker image build ~1m7s + Container boot + API smoke + graceful shutdown ~1m37s |

### 非阻塞事项(转交后续 PR)

- **NB-1** `detail` / `create` / `update` 出参字段保护断言可后续增强:显式断言
  `expect(res.body.data).not.toHaveProperty('deletedAt' / 'deletedByUserId')`,沿
  `detail-1` 既有模式(可放 v0.6.x 小 PR 或 5-B 实施 PR 顺手补)
- **NB-2** `audit-1` 用例:`create` / `update` / `delete` 触发 `auditPlaceholder` log 的硬验证
  (沿 batch 2 / 3 e2e audit 测法)可后续增强
- **NB-3** Swagger UI 手工验收(`/api/docs` 打开试调 5 接口的典型成功 / 错误路径)在
  **下一独立 PR `chore: bump version to 0.6.0`** 或 **v0.6.0 release 前**补一次记录
  (B 档 baseline §14 验收门槛)

## v0.5.0 - 2026-05-12

V2 第一阶段在 v0.4.0(批次 3A + 批次 3B,V2 70 接口)基础之上,完成 SRVF 业务**批次 4**
(贡献值业务规则:ContributionRule schema + AttendanceSheet 终审 3 字段 + 终审 service /
API + ContributionRule 系统预填 + Activity.completed 单向推动),**累计 V2 72 接口**
(原 70 + 批次 4-B 终审 2);v1 14 + V2 既有 70 接口 schema + paths 严格 **zero drift**;
**累计 86 接口** contract snapshot 保护。

**SemVer 判断**:0.4.0 → 0.5.0 选 **minor**(向后兼容的功能新增 + 文档语义升级)。沿 v0.3.0 → v0.4.0
风格(批次 3 26 接口 minor);批次 4 在 SemVer 0.x.x 阶段属于"开发期未稳定",minor 可包含
状态机扩展与事件触发位置切换(详见批次 4-B 段)— 维护者已知,前端需配套升级。

**重要语义变更**(前端 / 接入方必读):

- `AttendanceSheet.statusCode` 状态机由 **3 态扩展为 5 态**:新增 `pending_final_review` /
  `final_rejected`;`approved` 语义由"APD approve 后即 approved"升级为 **"终审通过"**
  (贡献值正式生效);中间态 `pending_final_review` = "APD 一级通过,待 APD 终审"
- `PATCH .../attendance-sheets/:id/approve` 流转由 `pending → approved` 改为
  `pending → pending_final_review`,**不再触发** `attendance.recorded`
- 新增 `PATCH .../attendance-sheets/:id/final-approve` 与 `.../final-reject` 终审接口;
  `attendance.recorded` 触发位置**移到** `final-approve`
- `POST .../attendance-sheets` 创建时事务内按 `ContributionRule` 预填 `contributionPoints`;
  无匹配规则保持 `null`,APD 终审仍是最终裁定
- 首张 AttendanceSheet 提交时事务内 `Activity.statusCode published → completed`,单向不可逆;
  `completed` 在批次 4 语义 = "活动已进入考勤提交阶段",**不**代表"全部终审通过"
- 终审权限当前沿 `ADMIN / SUPER_ADMIN`(沿 D-S2 不开 `22044`);APD 部门部长 / 副部长专属权限
  留后续 RBAC 批次

详见 [`docs/handoff/v0.4.0.md`](docs/handoff/v0.4.0.md) §12 批次 4 已落地段(9 项核心语义)
与下方批次 4-A / 4-B / 4-C 子段。

### Docs(v0.4.0 release 之后,2026-05-11 ~ 2026-05-12)
- `dd13291` docs(handoff): add v0.4.0 stage handoff for next AI session — `docs/handoff/v0.4.0.md` 落档,
  作为 v0.4.0 release 后"下一会话交接"入口;后续在批次 4-C 中追加批次 4 完成事实
- `0cde221` docs(baseline): fix certificates BizCode segment ownership (#17) — `docs/srvf-foundation-baseline.md`
  §1.1 段位归属修正

### V2 Batch 4-A Schema(ContributionRule + AttendanceSheet 终审 3 字段;2026-05-11)
- `2190803` chore(prisma): add batch4 contribution rule schema (#18) —
  **新增 `ContributionRule` model**(13 字段:`activityTypeCode` / `attendanceRoleCode` /
  `durationThreshold` Decimal(5,2) 可空 / `pointsBelow` Decimal(5,2) / `pointsAbove` Decimal(5,2) 可空 /
  `dailyCap` Decimal(5,2) 可空 / `note` / `status` ContributionRuleStatus enum / `createdByUserId` /
  `updatedByUserId` / `deletedByUserId` 3 个审计 FK + `createdAt` / `updatedAt` / `deletedAt`)+
  **新增 `ContributionRuleStatus` enum**(`ACTIVE` / `INACTIVE`,baseline §2.2.3 ENUM 命名)+
  **AttendanceSheet 加 3 字段终审**(`finalReviewerUserId?` / `finalReviewedAt?` / `finalReviewNote?`,
  D-S5;`SheetFinalReviewer` relation 反挂 User)+
  **partial unique index `contribution_rules_activity_role_threshold_active_unique`**
  (手工 SQL 追加:`WHERE deletedAt IS NULL AND status = 'ACTIVE'`;
  注:PostgreSQL NULL 语义不阻止 `durationThreshold = NULL` 多条 ACTIVE 并存,
  service 层按 `ORDER BY createdAt ASC LIMIT 1` 兜底,见 §6 已知缺口)+
  **3 个新 BizCode**(`220xx` attendances 段位补 3 项,**复用 batch 3B 段位,不新开模块码**):
  `22043 ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE` /
  `22045 ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID` /
  `22046 ATTENDANCE_SHEET_FINAL_REVIEW_NOTE_REQUIRED`(沿 D-S2 / batch 3A 不开 `FORBIDDEN_*` 模块码,
  权限不足走通用 `40300`)+
  **`attendance_sheet_status` 字典扩展为 5 态**(原 `pending` / `approved` / `rejected` +
  新 `pending_final_review` / `final_rejected`;字段层仍是 `String`,**未引 Prisma enum**)+
  本 PR 不动 service / DTO / controller / e2e / contract / OpenAPI snapshot,**纯 schema + BizCode 落地**

### V2 Batch 4-B Service / API(终审 + 贡献值预填 + Activity 推动;2026-05-12)
- `6812db9` feat(attendances): add v2 batch4-B final review and contribution prefill (#19) —
  **2 个新路由**(累计 attendances 9 → 11,V2 接口 84 → 86):
  - `PATCH /api/v2/attendance-sheets/:id/final-approve` — APD 终审通过
    (`pending_final_review → approved`;**触发** `attendance.recorded`;沿 D-S5 / D-S7)
  - `PATCH /api/v2/attendance-sheets/:id/final-reject` — APD 终审驳回
    (`pending_final_review → final_rejected`;`finalReviewNote` 必填;records **跟随软删**;
    **不触发** `attendance.recorded`)
  - 两路由 Swagger summary 文案:"终审通过 / 驳回(当前沿用管理权限,细分权限后置;...)" —
    避免暗示已实装 "APD 部门部长 / 副部长" 专属权限(沿 D-S2 不开 `22044`,见 §8 权限边界)
  - **状态机 3 态 → 5 态**(D-S6):
    `pending → rejected`(一级驳回)/ `pending → pending_final_review → approved`(终审通过)/
    `pending → pending_final_review → final_rejected`(终审驳回);
    `pending_final_review` / `final_rejected` 一律不可 `edit` / `softDelete`
    (沿 §2.1 业务规则,`22030` / `22043`)
  - **`approved` 语义升级**:v0.4.0 之前 = "APD approve 后即 approved";
    批次 4 后 = **"终审通过"**(贡献值正式生效);
    `pending_final_review` = "APD 一级审核通过,待 APD 部门部长 / 副部长终审"
  - **`attendance.recorded` 触发位置切换**(沿 D-S7):
    从 `approve` 后移到 `final-approve`;
    `approve` / `reject` / `final-reject` / `submit` / `edit` / `delete` **均不触发**
  - **D14 ContributionRule 预填**(沿 D-A8 候选 5.B):
    POST `/attendance-sheets` 事务内按 `(activityTypeCode, attendanceRoleCode, durationMinutes)` 匹配规则,
    预填 `contributionPoints`;调用方传值**不覆盖**;
    无匹配规则 → 保持 `null`(不抛错;沿 D-S11 `22048` 不开);
    每日上限 `dailyCap` 默认 1.5(沿 Q-OPEN-7 锁定);
    **不暴露** `ContributionRule` CRUD 接口,**不引** `contribution_points` 流水表(均留后续批次)
  - **D11 Activity.completed 推动**(沿 D-S10 / 业务规则文档 §3):
    首张 AttendanceSheet 提交时,事务内 `Activity.statusCode published → completed`,
    单向不可逆;后续 Sheet 提交幂等(已 completed → 无操作);
    `approve` / `reject` / `final-reject` 均**不回退** `Activity.completed`;
    `completed` 在批次 4 语义 = "活动已进入考勤提交阶段",**不**代表"全部终审通过"
    (沿业务规则文档 §3.4:运营可通过 `AttendanceSheet` 列表观察"虽 completed 但无通过考勤")
  - **DTO 变更**:
    新增 `FinalApproveAttendanceSheetDto`(optional `finalReviewNote`,@MaxLength 500)+
    `FinalRejectAttendanceSheetDto`(required `finalReviewNote`,@MinLength 1 / @MaxLength 500);
    `AttendanceSheetResponseDto` 追加 3 字段(`finalReviewerUserId?` / `finalReviewedAt?` /
    `finalReviewNote?`);`reviewNote` / `reviewedAt` / `reviewerUserId` 描述加 "APD 一级" 前缀;
    `statusCode` 描述升级为 5 态文字(注:字段仍是 OpenAPI `string` 类型,**非 enum 数组**,
    见 §6 已知缺口)
  - **AuditEvent union 追加 1 项**:`attendance-sheet.final-review`
    (`action='final-approve' | 'final-reject'`,触发于 finalApprove / finalReject service 同事务内)
  - **e2e 累计**:attendances 69 → 93(+24 用例:终审 / D14 预填 / D11 推动 / 5 态边界);
    全量 e2e 592 → **616**;无 v1 / batch 1 / batch 2 / batch 3 退化
  - **contract 累计**:154 + 2 snapshots → **158 + 2 snapshots**(routes +2 + DTO +2 +
    AttendanceSheetResponseDto +3 字段 + summary 文案锁定);v1 14 + V2 86 接口 zero drift
  - **本 PR 边界**:
    - 不动 `prisma/schema.prisma`(批次 4-A 已一次入库)
    - 不动 migration / seed / reset-db
    - 不暴露 `ContributionRule` CRUD 接口
    - 不引入 `contribution_points` 流水表
    - 不复活 `audit_logs` 表
    - 不引入新依赖
    - APD 部门部长 / 副部长**专属权限未实装**(沿 ADMIN / SUPER_ADMIN;细分权限后置)

### V2 Batch 4-C Docs Release Prep(批次 4 文档收口;2026-05-12)
- `a463fb9` docs(v2-batch-4c): record batch 4-A/4-B landing and 9-point semantics (#20) —
  `CHANGELOG.md` Unreleased 段全量补齐批次 4 三子段(本段)+ `README.md` V2 attendances 行
  更新(3 态 → 5 态,9 → 11 接口,累计 84 → 86 V2)+ `docs/srvf-foundation-baseline.md`
  §1.1 段位表 `220xx` 行追加批次 4-A "3 BizCode" 事实 + `docs/handoff/v0.4.0.md` 追加
  批次 4 完成状态与 9 项核心语义清单;**未** bump version(留独立 PR;由本 `chore: bump
  version to 0.5.0` PR 落地)+ **未** 改 src / prisma / e2e / contract / OpenAPI snapshot
  (本 PR contract zero drift 验证通过)

### Boundaries / Validation(Unreleased 累计;批次 4-A + 4-B 后)
- v1 14 接口 + V2 first stage 29 + 批次 1 7 + 批次 2 8 + 批次 3A 17 + 批次 3B 9 +
  **批次 4-B 2** 接口 schema + paths **zero drift**;累计 **86 接口** 进入 contract snapshot
- v1 14 接口 schema + paths 严格 zero drift(LoginDto / UserResponseDto 不漂移)
- 批次 4-A schema(commit `2190803`)+ 批次 4-B service/API(commit `6812db9`)+ 批次 4-C docs(本 PR)
  形成 **schema → service → docs** 三 PR 拆分,沿 v0.3.0 / v0.4.0 节奏
- 累计验收(merge 时本地 + CI 全绿):
  - `pnpm test` unit 532 / 4 suites(原 517 + 批次 4-A 15 BizCode 元属性遍历自动覆盖)
  - `pnpm test:e2e` **616** / 30 suites(原 592 + 批次 4-B **24**;无退化)
  - `pnpm test:contract` **158 + 2 snapshots**(累计 86 接口 contract zero drift)
  - `pnpm lint` 0 warnings / `pnpm typecheck` PASS / `pnpm build` PASS
  - 批次 4-A PR #18 CI 全绿;批次 4-B PR #19 CI 全绿(Docker + Lint/Typecheck/E2E 双绿)
- **批次 4 永久不做 / 留后续批次**(沿决议表 v1.0):
  - **不暴露** `ContributionRule` CRUD 接口(留运营后台或单独管理 PR)
  - **不引** `contribution_points` 独立流水表 / cron-job(D49 / R32 永久不做,沿 v0.4.0 / 业务规则文档)
  - **不复活** `audit_logs` 表(沿 batch 1 占位)
  - **不实装** APD 部门部长 / 副部长专属权限(沿 D-S2 不开 `22044`;留后续 RBAC 批次)
  - **不开** `BizCode 22044`(权限不足走通用 `40300`)
  - **不引** Prisma enum 锁 `attendance_sheet_status`(字段仍是 `String`,5 态走字典闭集)
  - **`Activity.complete` 独立接口形态**(Q-A11 永久不做;推动机制由 D11 在 `submit` 内触发)

## v0.4.0 - 2026-05-11

V2 第一阶段在 v0.3.0(批次 1 + 批次 2)基础之上,完成 SRVF 业务**批次 3**(activities +
activity-registrations + attendances 共 3 模块,**26 接口**:批次 3A 17 + 批次 3B 9),
**v1 14 接口 + 既有 V2 52 接口 schema + paths 严格 zero drift**;**累计 84 接口**
进入 contract snapshot 保护范围。

### V2 Batch 3 Schema(activities + attendances 共享 schema;2026-05-10)
- `31c8187` chore(prisma): add v2 batch3 activities attendances schema (#9) —
  Activity / ActivityRegistration / AttendanceSheet / AttendanceRecord **4 model** 一次入库
  (共享 schema,3A / 3B PR 不再动 schema)+ User / Organization / Member 9 反向 relation
  (沿批次 1 / 批次 2 R2 范式)+ partial unique index
  `activity_registrations_activity_member_active_unique`
  (`WHERE deleted_at IS NULL AND statusCode != 'cancelled'`,手工 SQL 追加)+
  显式 `@db.Decimal` 注解(`AttendanceRecord.serviceHours / contributionPoints` `Decimal(5,2)`,
  `Activity.locationLongitude / locationLatitude` `Decimal(10,7)`)+ 5 个闭集字典 seed
  (`activity_status` 4 态 / `registration_status` 4 态 / `attendance_sheet_status` 3 态 /
  `attendance_status` 3 态 / `attendance_role` 7 项)+ `activity_type` 2 级树占位(3 父 + 4 子;
  `seedActivityTypeHierarchy`)+ `reset-db.ts` TRUNCATE 顺序更新(孙→子→父依赖)+
  `AuditEvent` union 追加批次 3 8 项(`activity.publish` / `registration.create` /
  `registration.review` / `attendance-sheet.{submit,edit,delete,read.other,review}`)+
  新增 `BusinessEvent` union(`attendance.recorded`;3A 暂不调用,留 3B)

### V2 Batch 3A API(activities + activity-registrations + CSV export;2026-05-11)
- `6a9339b` feat(activities): add v2 batch3A activities and registrations (#10) —
  **17 接口**(activities 7 + registrations 管理端 6 + 队员端 4;
  Q-A3 USER 自助 `POST /api/v2/users/me/activities/:activityId/registration` 与
  ADMIN 代报名 `POST /api/v2/activities/:activityId/registrations` 拆开)+
  **118 e2e**(activities 57 + registrations 61)+
  **13 BizCode**(activities `200xx` 9 个 + registrations `210xx` 4 个;不开 `FORBIDDEN_*`
  模块码;USER 越权一律 404 沿 §1.7 风格)+
  AuditEvent 3 类调用(`activity.publish` / `registration.create` / `registration.review`)+
  Q-A6 CSV 名单导出走 `StreamableFile`(`ResponseInterceptor` 已通过 `instanceof` 自动跳过,
  **未改 interceptor**;默认 `scope=pass` 仅返审核通过 / 可选 `scope=all` 返全部;
  XLSX 直接 400;**不落 export_logs / 不生成 AttendanceRecord;副作用 0**)+
  Q-A12 cancelled Activity 拒改(`update` / `publish` 抛 20030;`delete` 允许,沿 D3)+
  Q-A7 USER + ADMIN `activities` 同路由 service 按 Role 过滤(USER 列表强制
  `statusCode ∈ {published, completed}` 并忽略入参 `statusCode`;USER detail
  draft/cancelled → 404)+ partial unique 防重复报名(`取消后允许重报`)+
  capacity 仅统计 `pass`(`cancelled` 自动释放名额)

### V2 Batch 3A Docs(README + CHANGELOG;2026-05-11)
- `dd040fb` docs(v2-batch-3a): record batch 3 schema + 3A API in README and CHANGELOG (#11) —
  README V2 路由表接口总数 44 → 61;新增 activities(7)/ activity-registrations(10)两行;
  CHANGELOG Unreleased 段追加 batch 3 schema(`31c8187`)+ 3A API(`6a9339b`)子段 +
  Boundaries / Validation 段;3B 落地前的 docs 收口

### V2 Batch 3B Docs(README + CHANGELOG;2026-05-11)
- `c1606e8` docs(v2-batch-3b): record attendance API completion (#13) —
  README V2 路由表接口总数 61 → 70;新增 attendances(批次 3B)9 接口行;
  落地总结段补充 attendance_sheets / attendance_records 已落地 + 累计 84 接口 zero drift;
  CHANGELOG Unreleased 段追加 batch 3A docs(`dd040fb`)+ batch 3B API(`5dbd230`)子段;
  Boundaries / Validation 段累计 75 → 84 接口、unit 452 → 517 / e2e 523 → 592 /
  contract 136 → 154 + 永久不做清单(`/me/service-hours` / `contribution_points` 流水表 /
  rejected clone / `Activity.complete` / XLSX / 动态表单引擎);v0.4.0 release 前最后 docs 收口

### V2 Batch 3B API(attendances + APD review + /me/attendance-records;2026-05-11)
- `5dbd230` feat(attendances): add v2 batch3B attendance sheets and review (#12) —
  **9 接口**(管理端 8 + 队员端 1):
  - 管理端:`POST /activities/:activityId/attendance-sheets`(事务内 create Sheet + N records)/
    `GET /activities/:activityId/attendance-sheets`(列表)/ `GET /attendance-sheets/:id`(简化详情)/
    **`GET /attendance-sheets/:id/review-detail`**(R25:Activity 8 + Sheet + Records[含 Member 嵌套]
    APD 完整审核视图)/ `PATCH /attendance-sheets/:id`(D38:后端事务内生成 Q-S16 完整快照
    `previousSnapshot` + `version+1`;旧 records 软删 + 新 records 创建)/
    `DELETE /attendance-sheets/:id`(级联软删 records)/ `PATCH /attendance-sheets/:id/approve`
    (`pending → approved`;R31 所有 records.contributionPoints 必填;**同事务内触发
    `eventPlaceholder('attendance.recorded')` approved-only**)/ `PATCH /attendance-sheets/:id/reject`
    (`pending → rejected`;reviewNote 必填)
  - 队员端:**`GET /api/v2/users/me/attendance-records`**(Q-A14 / R29 / R33 仅 approved Sheet 内
    records;分页 + 可选 activityId 过滤;不返他人)
  - **14 BizCode**:`20122 ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN`(activities 段补充)+
    `220xx` attendances 13 项(22001 NOT_FOUND / 22030 STATUS_INVALID /
    22040 APPROVED_NOT_EDITABLE / 22041 REJECTED_NOT_EDITABLE / 22051 ROLE_CODE_INVALID /
    22052 STATUS_CODE_INVALID / 22060 TIME_OVERLAP / 22061 CHECK_OUT_BEFORE_CHECK_IN /
    22070 SERVICE_HOURS_INVALID / 22071 SERVICE_HOURS_EXCEEDS_SPAN /
    22072 CONTRIBUTION_POINTS_REQUIRED / 22073 REGISTRATION_ACTIVITY_MISMATCH);不开
    `FORBIDDEN_*` 模块码(沿基线)/ 22042 VERSION_CONFLICT(D37 暂不启用乐观锁)/
    22050 RECORD_NOT_FOUND(Q-A9 不暴露独立 Record 查询)
  - **69 e2e**(attendances.e2e-spec.ts;权限 / 状态机 / 时间不重叠 / serviceHours / R23 / R28
    previousSnapshot / R31 contributionPoints / Q-A14 /me-records / DTO 白名单 / approved-only 事件)
  - **65 unit**(BizCode 元属性遍历自动覆盖 14 项新条目)
  - AuditEvent 5 类调用(`attendance-sheet.submit` / `attendance-sheet.edit` /
    `attendance-sheet.delete` / `attendance-sheet.read.other` / `attendance-sheet.review`;
    union 已在 commit `31c8187` 落地,3B 启用其余 5 项,**未动 audit-placeholder.ts**)
  - BusinessEvent 1 类调用(`attendance.recorded` approved-only;sheet 级 + records 数组
    9 字段 context;**未动 event-placeholder.ts**;触发位置:approve service 事务内,
    rejected / submit / edit / delete 均不触发)
  - 时间不重叠校验(R16 / Q-S15):同 memberId × `[checkInAt, checkOutAt)` 左闭右开;
    跨 Sheet / 跨 Activity 全局;service 层 `assertNoTimeOverlap` 实装;**不**做 PG EXCLUDE 约束
  - serviceHours 规则(D14 / D45 / D46 / D51):未传自动 `(checkOut-checkIn)/3600` /
    `<= 0` 拒(`@Min(0.01)` DTO 兜底 + service 兜底)/ `> 跨度` 拒(22071)/
    允许 `< 跨度`(D46 吃饭休息不计入)
  - R23 跨表:`registrationId !== null` 时校验 `registration.activityId === sheet.activityId`;
    失败 → 22073(`mismatch` 与 `not found` 走同码,沿 §1.7 风格)
  - 3B PR 未引入新依赖;**未动** schema / migration / seed / reset-db / 3A 模块 /
    response interceptor / event-placeholder / audit-placeholder / package.json

### Boundaries / Validation(Unreleased 累计)
- v1 14 接口 + V2 first stage 29 + 批次 1 7 + 批次 2 8 + 批次 3A 17 + **批次 3B 9** 接口
  schema + paths **zero drift**;累计 **84 接口** 进入 contract snapshot 保护范围
- 批次 3 schema(commit `31c8187`)含 4 model + partial unique + 反向 relation,
  **3A + 3B 共享同一份 schema**;3A / 3B PR **均未动 schema / migration / seed / reset-db**
- 3A + 3B PR 均**未引入新依赖**(CSV 手写 `escapeCsvField`;previousSnapshot Json passthrough)
- 累计验收(merge 时本地 + CI 全绿):
  - `pnpm test` unit **517** / 4 suites(原 452 + 批次 3B 65 BizCode 自动遍历)
  - `pnpm test:e2e` **592** / 30 suites(原 523 + 批次 3B **69**;无 v1 / batch 1 / batch 2 /
    batch 3A 退化)
  - `pnpm test:contract` **154** + 2 snapshots(累计 84 接口 contract zero drift)
  - `pnpm lint` 0 warnings / `pnpm typecheck` PASS / `pnpm build` PASS
  - **批次 3B PR #12 CI 3 jobs 全绿**(Lint/Typecheck/E2E 2m47s + Docker build 56s +
    Container smoke 1m42s)
- **永久不做 / 不在批次 3 范围**(沿决议表):
  - `GET /api/v2/users/me/service-hours` **服务时长汇总统计接口**(Q-A5 永久不做,
    留后续"数据统计 / APP 数据"模块或批次 4 贡献值核算)
  - `contribution_points` **独立流水表 / cron-job**(D49 / R32;留批次 4 决议)
  - `POST /attendance-sheets/:id/clone` **rejected Sheet 复制接口**(Q-A4 不实装;
    前端从 `review-detail` 取字段组装新 POST)
  - `PATCH /activities/:id/complete` **Activity.complete 接口**(Q-A11 不实装;
    `completed` 留字典占位,推动机制留批次 4)
  - **XLSX 名单导出**(Q-A6 第一版仅 CSV;`format=xlsx` 入参直接 400)
  - **动态表单引擎**(R19;`extras` / `previousSnapshot` / `registrationSchema` 仅
    `@IsObject()` / Json passthrough,不做嵌套 schema 校验)
  - 独立 `AttendanceRecord` CRUD 路径(Q-A9 不暴露;通过 Sheet `review-detail` 一次返回)
  - `220xx` `ATTENDANCE_RECORD_NOT_FOUND` / `22042` `VERSION_CONFLICT` 不开(沿决议表)

## v0.3.0 - 2026-05-10

V2 第一阶段在 v0.2.0 基础数据底座之上,完成 SRVF 业务批次 1 + 批次 2,共新增 15 接口
(累计 V2 第一阶段 44 接口),**v1 14 接口 schema + paths 严格 zero drift**。

### V2 Batch 1(member_profiles + emergency_contacts;2026-05-10)
- `dbfca6a` chore(prisma): add batch 1 member profile schema —
  MemberProfile(40 字段,1:1 with Member)+ EmergencyContact(8 字段,N:1)+ 6 个字典 seed
- `5d540ce` feat(v2-batch-1): add member-profiles + emergency-contacts modules (#2) —
  7 接口(3 profile + 4 emergency-contact)+ 57 e2e + 10 BizCode(160xx / 190xx)+ AuditEvent 6 项
- `32b03c8` docs(v2-batch-1): correct stale post-merge claims (#4)

### V2 Batch 2(certificates;2026-05-10)
- `8c86aac` chore(prisma): add v2 batch 2 certificates schema (#5) —
  Certificate(18 字段,N:1 + 3 ON DELETE Restrict FK;状态机闭集 4 态)+ 3 个字典 seed
- `ce56018` feat(certificates): add v2 batch 2 certificates module (#6) —
  8 接口(嵌套子资源 + verify / reject / qualification-flag 动作)+ 66 e2e +
  5 BizCode(180xx / 181xx)+ AuditEvent 10 项
- `74f72b4` docs(v2-batch-2): sync facts after schema + API merge (#7)

### CI / Testing
- `6637733` ci: fix docker smoke compose network name (#3)
- `2fdf1fc` test(e2e): stabilize supertest server lifecycle
- `4f4283d` chore: clean up v0.2.0 release housekeeping

### Docs
- `e68c177` docs: add SRVF business docs pointer

### Boundaries / Validation
- v1 14 接口 + V2 first stage 29 接口 + 批次 1 7 接口 schema + paths **zero drift**
- 全部新接口 ADMIN / SUPER_ADMIN 兜底;**未开放** USER 自助路由
- 软删走 `deletedAt`;禁用 hard delete;FK 全部 ON DELETE Restrict
- DTO 严格白名单 + 全局 `ValidationPipe`(forbidNonWhitelisted)+ 统一响应包装 + `BizException`
- AuditEvent union 严格锁死(批次 1 / 批次 2 共 16 项,含 4 项占位)
- 未实装:attachments / audit_logs 表 / RBAC 表 / 60 天提醒任务 / 自动失效 job /
  applicants / activities / attendances / honors / USER 自助路由
- 验收(release 前 main 上 commit `74f72b4` 全量回归):
  - `pnpm test` unit **387**
  - `pnpm test:e2e` **405** / 27 suites(v1 162 + 批次 1 57 + V2 first stage 120 + 批次 2 66;零退化)
  - `pnpm test:contract` **107 + 2 snapshots**(v1 14 + V2 first stage 29 + 批次 1 7 + 批次 2 8 = 58 接口 contract zero drift)
  - `pnpm lint` 0 warnings / `pnpm typecheck` PASS / `pnpm build` PASS

## v0.2.0 - 2026-05-09

### V2 First Stage (srvf-foundation Step 1-7) — 2026-05-08

V2-D8 第一阶段开发已完成,等待维护者按需 release / tag。基础数据底座 4 模型 + v1 兼容性追加 + auth memberNo 登录回退 全部交付,共 29 个新接口。

#### Schema + Seed(Step 1-2)
- `36c0837` chore(prisma): add V2 foundation schema (4 models + users.memberId)
- `53c9a03` chore(seed): add V2 neutral demo dictionary seeds

#### 业务模块(Step 3-6,共 29 接口)
- `33dbd69` feat(dictionaries) — `dict_types` + `dict_items` 双表 13 接口(父子树形 / 启停 / 软删显式封装)
- `da54cf3` feat(organizations) — 树形 7 接口(单根上限 + last-root 保护 + `nodeTypeCode` 走字典)
- `1baa6c6` feat(members) — `memberNo` 全局唯一不复用 6 接口(严禁敏感字段;`gradeCode` 字典校验)
- `c8bc4fd` feat(auth) — `memberNo` 登录回退(`LoginDto` schema **零漂移**;`PrismaService` 直读 member 表;Timing dummy bcrypt 强制扩展;统一抛 `LOGIN_FAILED` 防账号枚举)
- `54a14e0` feat(member-departments) — 一人一部门 3 接口(partial unique `WHERE deletedAt IS NULL` + PUT 幂等 + 软删旧 + 创建新单事务)

#### V2 第一阶段铁律
- v1 14 接口 schema + paths **严格 zero drift**(`LoginDto` / `LoginResponseDto` / `UserResponseDto` 不变)
- 4 个新模块 schema + paths 在 OpenAPI 快照中锁定(31 schemas + 25 paths)
- 字典 / 组织 / 队员 / 归属 全部走软删显式封装(`notDeletedWhere` helper;详情查询禁 `findUnique`)
- 4 个新 enum status 由 Prisma 控制(`DictTypeStatus` / `DictItemStatus` / `OrganizationStatus` / `MemberStatus`)
- BizCode 4 段位:`110xx` organizations / `120xx` dictionaries / `150xx` members / `170xx` member-departments
- 引用约束 + 软删 全部包在 `prisma.$transaction` 原子完成

#### 验收(Step 7 收口)
- `pnpm lint` / `pnpm typecheck` / `pnpm test`(312)/ `pnpm test:e2e`(24 suites / 282 tests;两次稳定,v1 162 零退化)/ `pnpm test:contract`(78 + 2 snapshots)/ `pnpm build`(首次跑过,`dist/` 生成)
- B 档:`pnpm start:dev` / `/api/docs` 200 / `/api/health/live`/`/ready` 200 + `db: up` / `/api/docs-json` v1 10 + V2 15 paths(dict 7 + org 4 + members 3 + member-dept 1)/ v1 admin 登录 200 / V2 各模块贯通流(GET dict-types / GET org tree / GET members / PUT 部门 / GET 部门 / DELETE 部门)/ SIGTERM 优雅关闭

#### V2.x 复活路径(已延后,不在本阶段)
- `member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants`

#### 不在本阶段范围
- 一人多部门 / `isPrimary` / `joinedAt` / `endedAt` / 进出原因 / 部门变更历史 / RBAC / Redis / 队列 / 文件上传 Provider / LLM / pgvector / 多租户

#### 后续 housekeeping(已记录,非阻塞)
- e2e 间歇性 v1 `auth-login.e2e-spec.ts` `'nonexistentuser'` 收到 HTTP 404 而非 401(LOGIN_FAILED)现象;Step 7 两次重跑稳定 282/282;根因可能是 `ThrottlerStorage` 跨 spec 累计或 NestJS 路由初始化 race;独立 task 跟进
- `ORGANIZATION_ROOT_ALREADY_EXISTS` message 措辞优化候选(当前"活跃根节点" vs 实现 `deletedAt=null` 不区分 status,语义略有歧义)

### Docs
- 模板 freeze 文档收口:`README.md` 顶部新增一行说明,声明 `Template baseline: v0.1.6`、`main` 分支进入 template-freeze 模式(仅允许 docs / CI 触发路径变更),新业务模块应在派生项目(例如 `u-rescue-api`)中开发,不在本模板仓库继续堆叠。中英混排,方便 AI 与开源用户理解
- `docs/docker-smoke-test.md` 标题与开头说明改为 "v0.1.5 首轮手动报告(v0.1.6 已修复其中 logger WARN)",显式声明本文档定位为历史快照、v0.1.6 已修复 §6.1 的 WARN、当前自动化以 `.github/workflows/docker-smoke.yml` 为准并列出最新触发路径。smoke 结果本身一行未动
- `docs/deployment.md` 末尾新增 "Branch protection / required checks" 章节:列出建议的 required checks(`Lint / Typecheck / E2E`、`Docker image build`),说明 Docker Smoke 当前建议 non-required(容器启动级 smoke,受 runner / docker / network 时序影响更高,失败应人工查看而非默认阻塞所有 PR),并给出后续提升为 required 的触发条件(连续观察 ≥4 周无假阳性 / 进入正式生产部署前 / 引入显著放大启动差异的变更)
- `README.md` "常用命令"段补充 `pnpm test`(unit:不启动 Nest、不连数据库)与 `pnpm test:contract`(OpenAPI 契约快照,锁 14 接口 schema)两条护栏命令的简短说明,原"E2E 测试"段重命名为"测试(三档)",`pnpm test:e2e` 与 `pnpm db:test:init` / `pnpm db:test:reset` 的语义保持不变;补齐意图是避免新用户只跑 e2e 而忽略 unit / contract 两层快速反馈。仅 README 文案补充,无 API / Prisma schema / 依赖 / Dockerfile / docker-compose.yml / CI workflow / `src/**` 变更
- `docs/docker-smoke-test.md` §6.1 修正启动期 WARN(`[LegacyRouteConverter] Unsupported route path: "/api/*"`)的根因描述。v0.1.5 报告时初步判断与 Swagger 静态资源 / fallback route 有关,**该判断不准确**;v0.1.6 已定位真实根因为 `nestjs-pino` 的 `LoggerModule.configure()` 默认 `forRoutes: [{ path: '*', method: ALL }]` 与 `app.setGlobalPrefix('/api')` 拼接成 `/api/*`,触发 NestJS 11 + path-to-regexp v8 的 `LegacyRouteConverter`,因为 LoggerModule 注册两个 middleware 所以 WARN 重复一次。已在 `src/bootstrap/logger-options.ts` 中通过显式 `forRoutes: [{ path: '*path', method: RequestMethod.ALL }]` 修复。文档同步更新结论行(§9 摘要)标注"已在 v0.1.6 修复",并指明 v0.1.6 之后 smoke 复测应不再出现该 WARN。仅文档修正,smoke test 结果与判定不变,无 API / Prisma schema / 依赖 / Dockerfile / CI / src 变化

### Changed
- `.github/workflows/docker-smoke.yml` 的 `pull_request.paths` 在原 `Dockerfile` / `package.json` / `pnpm-lock.yaml` / `prisma/**` / 自身之外,先后两次扩展:(1) 增加 `docker-compose.yml`(Docker Smoke workflow 依赖其中的 Postgres service / `container_name: u-nest-api-postgres` / 网络名 `u-nest-api-starter_default`,原 paths 未覆盖会导致 `docker-compose.yml` 变更不触发 smoke);(2) 增加 production boot 敏感路径 `src/main.ts` / `src/app.module.ts` / `src/bootstrap/**` / `src/config/**` / `src/database/**`(Docker Smoke 依赖容器在 production 模式下的真实启动行为:config validation、global prefix、logger 初始化、Prisma graceful shutdown)。**不**纳入整个 `src/**`,业务模块改动仍走 `ci.yml` 的 e2e。该 workflow 仍是 non-required check

### Added
- 新增 `.github/workflows/docker-smoke.yml`,作为对 `docs/docker-smoke-test.md` §7 第二轮自动化的最小落地。独立于 `ci.yml`,触发范围限定 `Dockerfile` / `package.json` / `pnpm-lock.yaml` / `prisma/**` / 该 workflow 自身,只在 `pull_request` 触发,不绑 `push: main`。job 串行覆盖:`docker compose up -d postgres` → 创建独立 `app_smoke` DB → host 侧 `pnpm prisma:generate` / `pnpm prisma:deploy` / `pnpm prisma:seed`(跑两次验证幂等)→ `docker build` 生产镜像 → 以 `APP_ENV=production` + `ENABLE_SWAGGER=false` 启动 app 容器(加入 `u-nest-api-starter_default` 网络,host 端口 `13000` → 容器 `3000`)→ 轮询 `/api/health/live` ready → smoke 检查 `/api/health` `/api/health/live` `/api/health/ready` `/api/docs`(404)`/api/docs-json`(404)、登录正确凭据 / 用户不存在 / 错密码三场景(用户不存在与错密码响应体用 `jq -S | diff` 强制完全一致)、`/api/users/me` 无 token / 带 token(断言不含 `passwordHash`)→ `docker stop -t 10` 后断言 exit code = 0 验证 graceful shutdown。`JWT_SECRET` / `SUPER_ADMIN_PASSWORD` 由 step 内 `openssl rand` 临时生成 + `::add-mask::`,不进 GitHub Secrets。失败时统一 dump `docker ps -a` / app container logs / postgres logs 尾部 / `/tmp/smoke-*.json` 响应体;`if: always()` 清理 app container 与 docker compose。**non-required check**(不进 branch protection),失败不阻塞合并,只作早期告警

### Not changed
- `.github/workflows/ci.yml` / `Dockerfile` / `docker-compose.yml` / `prisma/schema.prisma` / `package.json` / `pnpm-lock.yaml` / `src/**` / `docs/docker-smoke-test.md` 一行未动
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注 / HTTP status / 错误码 / 响应体格式与 v0.1.6 完全一致
- 依赖版本未变更,未引入新依赖

## v0.1.6 - 2026-05-03

Docker smoke test documentation and startup warning cleanup.

### Added
- 新增 `docs/docker-smoke-test.md`,记录基于 v0.1.5 镜像 (HEAD `0826787`) 的第一轮手动 Docker smoke test:production 模式启动、独立 `app_smoke` DB、`prisma migrate deploy` + `prisma db seed`(幂等)、`/api/health` / `/api/health/live` / `/api/health/ready`、production 下 Swagger 关闭(404)、登录三场景统一错误码、`/api/users/me`、非 root + helmet + 优雅关闭 (exit 0) 全部验证通过。文档同时给出第二轮自动化进 CI 的最小方案建议(独立 `.github/workflows/docker-smoke.yml`,只在影响 Dockerfile / Prisma / lockfile 的 PR 触发,非 required check)

### Fixed
- 启动期消除 `[LegacyRouteConverter] Unsupported route path: "/api/*"` WARN(原本打两次)。根因:`nestjs-pino` 的 `LoggerModule.configure()` 默认 `forRoutes: [{ path: '*', method: ALL }]`,与 `app.setGlobalPrefix('/api')` 拼接后变成 `/api/*`,触发 NestJS 11 / path-to-regexp v8 的 legacy 路由自动转换并 warn(LoggerModule 注册 pino-http + bindLoggerMiddleware 两个 middleware,因此 warn 重复一次)。修复:在 `src/bootstrap/logger-options.ts` 显式声明 `forRoutes: [{ path: '*path', method: RequestMethod.ALL }]`,使用 path-to-regexp v8 命名 wildcard 跳过 legacy 转换路径,与 `LegacyRouteConverter` 错误信息推荐写法一致。语义不变,仍匹配全部以 `/api` 开头的请求;无 API / Prisma schema / 依赖 / Dockerfile / CI 变化

### Not changed
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注 / HTTP status / 错误码 / 响应体格式与 v0.1.5 完全一致
- `prisma/schema.prisma` 与已存在 migration 不变
- 依赖版本未变更,`pnpm-lock.yaml` 未变化
- Dockerfile / `.github/workflows/ci.yml` / 其他 `src/**/*.ts` 未动

## v0.1.5 - 2026-05-03

V1.4 template maintenance — zero lint warnings, Prisma 7 upgrade evaluation, and prisma.config.ts migration.

V1.4-1 Lint 严格模式 — 不新增功能,不改 API / Prisma schema / 依赖版本;只把 `test/` 中遗留的 128 个 `@typescript-eslint/no-unsafe-argument` warning 收敛到 0,并在 `pnpm lint` 启用 `--max-warnings 0` 严格模式,封堵后续 lint 漂移。

### Added
- 新增 `test/helpers/http-server.ts`,提供 `httpServer(app: INestApplication): App` helper,把 `app.getHttpServer()` 的 `any` 返回值集中收敛为 supertest 的 `App` 类型;test 调用点统一改为 `request(httpServer(app))`,消除 125 处 `no-unsafe-argument` warning

### Changed
- `test/**/*.ts` 中所有 `request(app.getHttpServer())` 调用改为 `request(httpServer(app))`,涉及 19 个 e2e spec、`test/contract/openapi.contract-spec.ts`、`test/fixtures/auth.fixture.ts`、`test/helpers/call-endpoint.ts`
- `Object.keys(res.body.data)` 三处改为 `Object.keys(res.body.data as object)`(`users-me` / `users-admin-crud` / `users-admin-list`),在调用点显式收紧 supertest `Response.body: any` 的类型,消除 4 处 `no-unsafe-argument` warning
- `package.json#scripts.lint` 加上 `--max-warnings 0`,本地与 CI 共用同一入口;`.github/workflows/ci.yml` 的 `Lint` 步骤新增注释说明严格模式来源,避免未来误删 flag
- `docs/v1.3-plan.md` §6 标记 `[done — V1.4-1]`
- V1.4-2 Prisma 7 升级评估:新增 `docs/v1.4-prisma7-evaluation.md`,基于 Prisma 官方升级指南与本仓库源码 / Dockerfile / CI 触点,系统评估 Prisma 6.19.3 → 7.x 的影响面、风险矩阵、推荐升级步骤、回滚方案,以及拆分 PR 建议;结论:**当前不建议升级**(`prisma-client-js` → `prisma-client` generator 迁移会联动改写 Dockerfile §80-§150 的 prod 子集裁剪逻辑,投入产出比低,7.x 仍兼容 deprecated generator);唯一可考虑现在做的最小化收敛是 `package.json#prisma` → `prisma.config.ts` 迁移(独立任务,不在本评估内执行)。本任务**不升级依赖**、不改运行时代码、不动 Dockerfile / CI / Prisma schema
- V1.4-3 Prisma 配置迁移到 `prisma.config.ts`(对应评估文档 §6.1 / §7 PR A):新增 `prisma.config.ts`(`defineConfig({ migrations: { seed: 'tsx prisma/seed.ts' } })`),删除 `package.json#prisma` 配置块;为还原 Prisma CLI 检测到 `prisma.config.ts` 后**关闭**自动 `.env` 加载的副作用,在 config 顶部 `import 'dotenv/config'`(`dotenv` 已是 devDependency,无新增依赖,lockfile 无漂移)。仍在 Prisma 6.19.3,**不升级 prisma / @prisma/client**,**不改 schema.prisma**(datasource / generator 仍是 schema 内事实源),不改 Dockerfile / CI / 运行时代码。验证:`pnpm prisma:generate` / `prisma:deploy` / `prisma:seed`(含幂等)三命令均输出 `Loaded Prisma config from prisma.config.ts.` 并按预期完成

### Not changed
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注 / HTTP status / 错误码 / 响应体格式与 v0.1.4 完全一致
- `prisma/schema.prisma` 与已存在 migration 不变
- 依赖版本未变更(未升级 Prisma 6 → 7,未引入新依赖)
- `pnpm-lock.yaml` 未变化(V1.4-3 使用的 `dotenv` 已是 devDependency)
- 业务模块未新增,RBAC / refresh token / 文件上传 Provider 仍未实现
- `eslint.config.mjs` 规则未调整(未对 `test/**/*.ts` 关闭 `no-unsafe-argument`,而是从源头补类型)
- Prisma Client generator 仍是 `prisma-client-js`(deprecated 但兼容,未迁到 `prisma-client`)
- Dockerfile / `.github/workflows/ci.yml` / `src/**/*.ts` / `prisma/seed.ts` 一行未动

## v0.1.4 - 2026-05-03

V1.3 Contract Hardening — 不新增业务功能,不修改 API 响应格式,不改 Prisma schema;只把"模板的契约面"(API schema、错误码 ↔ HTTP status、权限策略)从"E2E 顺带覆盖"升级为"独立断言 + 自动化 CI 护栏"。

V1.3 子任务一览:

- **V1.3-1** users.policy 单测矩阵(3×3 角色 × 4 函数 = 36 个判定点),`UsersService.findOne()` 拆出 `canViewUser` 语义
- **V1.3-2** BizCode 元属性单测断言(key 命名 / code 段位 / message / httpStatus 全量遍历)
- **V1.3-3** OpenAPI 快照测试(14 路由白名单 + 11 核心 DTO + `paths` / `components.schemas` 两段快照)
- **V1.3-4** 错误响应 Swagger schema 显式化(`ApiBizErrorResponse` 装饰器 + 14 路由错误码 schema 全量补全)
- **V1.3-5** CI 跑 unit + contract tests(`pnpm test` / `pnpm test:contract` 进 `Lint / Typecheck / E2E` job)

### Added
- V1.3-1 Contract Hardening:新增 `src/modules/users/users.policy.spec.ts`,以 `it.each` 表格化覆盖 `canViewUser` / `canManageUser` / `canCreateRole` / `canChangeRole` 的 3×3 角色矩阵(36 个判定点)
- 新增 `test/jest-unit.config.ts` 与 `pnpm test` 脚本(只跑 `src/**/*.spec.ts`,不启动 NestJS / 不连库),与 `pnpm test:e2e` 解耦
- `tsconfig.json` 排除 `src/**/*.spec.ts`,避免 spec 文件被 `nest build` 打入 `dist/`
- V1.3-2 Contract Hardening:新增 `src/common/exceptions/biz-code.constant.spec.ts`,`Object.entries(BizCode)` 遍历断言每个条目的 key(大写 SNAKE_CASE)、`code`(正整数 + 全局唯一 + 落在已分段范围内)、`message`(非空 string + 已 trim)、`httpStatus`(合法 `HttpStatus` 枚举值);避免新增 BizCode 漏掉基本约束
- V1.3-3 Contract Hardening:新增 `test/contract/openapi.contract-spec.ts` + Jest 原生快照,从 `/api/docs-json` 抓取 OpenAPI v3 文档并锁定:14 个业务接口 + 3 个健康检查 + auth/login 共 14 条路由的存在性、HTTP 方法集合与白名单一致(防漏增 / 漏删)、核心 11 个 DTO schema 仍存在、`paths` 与 `components.schemas` 两段快照保护字段级漂移
- 新增 `test/jest-contract.config.ts` 与 `pnpm test:contract` 脚本(复用 e2e 的 globalSetup,串行执行,与 `pnpm test:e2e` 解耦),首次快照已入 git;后续 schema 变更需显式 `pnpm test:contract -u` 在 PR diff 中 review
- V1.3-4 Contract Hardening:新增 `ApiBizErrorResponse(...bizCodes)` 装饰器(`src/common/decorators/api-response.decorator.ts`),按 `httpStatus` 自动分组、合并相同 status 下的多个业务码到一条 `@ApiResponse`,响应 schema 结构与 `AllExceptionsFilter` 真实输出 `{ code, message, data: null }` 一致,`code.enum` 列出全部可能业务码、`description` 列出每个 code 的语义
- 给所有 controller 方法补全错误响应 Swagger 装饰器:`auth/login`(400/401/429,替换原裸 `@ApiResponse`)、`health/ready`(500)、`users/me` 系列(401 / 400)、`users` 管理系列(覆盖 400/401/403/404/409 + `FORBIDDEN_ROLE_OPERATION`/`CANNOT_OPERATE_SELF`/`LAST_SUPER_ADMIN_PROTECTED`/`USER_NOT_FOUND`/`USERNAME_ALREADY_EXISTS`/`EMAIL_ALREADY_EXISTS` 等业务码)
- 同步刷新 `test/contract/__snapshots__/openapi.contract-spec.ts.snap`,新增的错误响应 schema 进入快照保护范围
- V1.3-5 Contract Hardening:`.github/workflows/ci.yml` 在 `Lint / Typecheck / E2E` job 内新增 `Run unit tests`(`pnpm test`)与 `Run contract tests`(`pnpm test:contract`)两步,顺序为 lint → typecheck → build → db setup → prisma:deploy → unit → contract → e2e。补全 V1.3-1(`users.policy.spec.ts`)/ V1.3-2(`biz-code.constant.spec.ts`)/ V1.3-3 + V1.3-4(OpenAPI 契约快照含错误响应 schema)在 CI 内的真实护栏覆盖

### Changed
- 同步项目版本号到 `0.1.4`(`package.json#version` + Swagger `setVersion('0.1.4')`)
- `UsersService.findOne()` 改为通过新增的 `assertCanViewUser` 走 `canViewUser` 策略;管理 / 删除 / 重置密码 / 改角色 / 改状态等"修改类"操作继续走 `canManageUser`。当前两者判定相同,仅区分语义,API 行为不变

### Not changed
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注 / HTTP status / 错误码 / 响应体格式与 v0.1.3 完全一致
- `prisma/schema.prisma` 与已存在 migration 不变
- 业务模块未新增,RBAC / refresh token / 文件上传 Provider 仍未实现

## v0.1.3 - 2026-05-03

V1.2 模板收敛 — 不新增业务功能,不修改 API 响应格式,不做破坏性数据库变更;只提升长期可维护性、AI 二开稳定性和文档可读性。

### Changed
- 同步项目版本号到 `0.1.3`(`package.json#version`、Swagger `setVersion('0.1.3')`)
- 拆分 `src/app.module.ts`:logger / request-id / throttle 配置抽到 `src/bootstrap/`(`logger-options.ts` / `request-id.ts` / `throttle-options.ts`),`AppModule` 仅保留模块注册与全局 Guard 注册
- 新增 `src/modules/users/users.policy.ts`:集中 `canViewUser` / `canManageUser` / `canCreateRole` / `canChangeRole` 4 个纯函数;`UsersService` 不再散落角色判断,SUPER_ADMIN 结构性不变式(自我保护、最后一个 SUPER_ADMIN 保护)仍由 service 内事务保障
- 拆分 `README.md`:复杂内容迁移到 `docs/development.md` / `docs/testing.md` / `docs/deployment.md` / `docs/security.md`,`README.md` 仅保留项目定位、快速启动、路由总览、常用命令、文档入口
- `docs/security.md` 显式记录:当前版本支持软删除但不提供 restore 接口、误删恢复需 DBA 人工处理、未来 restore 接口契约预定义为 `PATCH /api/users/:id/restore`(仅 SUPER_ADMIN);token 吊销不实现 refresh token / Redis blacklist,仅记录未来 `tokenVersion` 升级路径
- 新增 `FINAL_REPORT.md`:本轮变更文件 / 原因 / 验收 / 遗留风险 / 建议 commit 命令
- 新增 `docs/v1.3-plan.md`:V1.3 Contract Hardening Plan(仅文档,不执行)

### Not changed
- API 响应格式、HTTP status、错误码、Swagger schema 与 v0.1.2 完全一致
- `prisma/schema.prisma` 与已存在 migration 不变
- 14 个业务接口路径 / 方法 / 入参 / 出参 / 权限标注与 v0.1.2 完全一致
- `.env.example` / `Dockerfile` / `.dockerignore` / `docker-compose.yml` / `.github/workflows/` 未触碰
- E2E 全量 19 spec / 162 用例继续通过(本机 ~15.6s)

## v0.1.2 - 2026-05-03

V1.1.1 工程收口修补 — 不引入新业务,不重构架构,只对 V1.1 之后暴露的版本一致性、生产迁移命令、CI 闭环、lint/typecheck 覆盖范围、README 残留表述做最小修补,并作为 patch release 正式发布。

### Fixed
- 同步项目版本号到 `0.1.2`(`package.json#version`、Swagger `setVersion('0.1.2')`),与本次 `v0.1.2` patch release 对齐
- 新增 `pnpm prisma:deploy` 脚本,作为生产数据库迁移固定入口(等价 `prisma migrate deploy`);保留 `pnpm prisma:migrate` 作为开发态入口
- CI 在 `typecheck` 之后、E2E 之前新增 `pnpm build` 步骤,显式验证 `tsconfig.build.json` 与 nest 构建产物链路
- CI 新增独立 `docker-build` job,验证多阶段 `Dockerfile` 在 CI 环境可成功构建出生产镜像(不做容器启动 / smoke test)
- CI 在数据库初始化之后、E2E 之前显式跑一次 `pnpm prisma:deploy`,验证生产迁移命令可执行(已迁移环境下为 no-op)
- `pnpm lint` 覆盖范围扩展为 `src/**/*.ts` + `test/**/*.ts` + `prisma/**/*.ts`
- `pnpm typecheck` 在原有 `tsconfig.json` 基础上追加 `test/tsconfig.test.json`,让测试代码也进入类型检查
- ESLint 显式 `project` 列表覆盖 `src` / `test` / `prisma` 三处源码;新增 `prisma/tsconfig.eslint.json` 仅供 ESLint 解析使用,不进入运行时构建链路;规则写入 `ARCHITECTURE.md` §11.7
- README 修正 V1.1 之后已不再准确的表述(Docker 用途、生产迁移策略、`prisma:deploy` 入口、runner 镜像不含 Prisma CLI 的说明)
- 新增 `CHANGELOG.md` 跟踪发布历史

## v0.1.1

- V1.1 engineering hardening
- Added GitHub Actions CI(lint / typecheck / E2E,基于 `docker compose` 启动 `postgres:16-alpine`)
- Added 多阶段 Dockerfile(`deps` → `builder` → `runner`,`node:22-alpine`,以非 root 用户运行)
- 接入结构化日志(`nestjs-pino`)与请求 ID(`x-request-id`,`cuid()` 兜底生成),敏感字段日志显示为 `[REDACTED]`
- 优雅关闭(`app.enableShutdownHooks()` + `PrismaService.onModuleDestroy()`)
- 健康检查分层(`/api/health` / `/api/health/live` / `/api/health/ready`,基于 `@nestjs/terminus`)
- helmet HTTP 安全头(Swagger UI 局部禁用 CSP)
- 登录接口限流(`@nestjs/throttler` 内存 storage,默认 IP 维度 5 次 / 60 秒)
- 扩展 E2E 覆盖(当前 19 spec / 162 用例)

## v0.1.0

- v1 基础闭环:NestJS + Prisma + PostgreSQL + Docker Compose + Swagger + JWT 登录 + 用户 CRUD + 简单角色权限 + 统一异常与返回格式
