# 《C-7 attachments V2.x 立项记录(批次 7)》

> **状态(2026-05-14 立项)**:🎯 **D7 v1.0 冻结完成,V2.x implementation track 启动**。
> 本 PR 仅完成立项记录登记;**实施 PR #1 仍需单独启动 + 用户授权**;立项 PR 合并即解除 C-7 attachments 的 V2 §18 调研期硬禁止。
>
> **批次号**:C-7 attachments(批次 7)
> **撰写日期**:2026-05-14(立项)
> **接续(设计阶段)**:
> - PR #44 业务访谈提纲(squash commit `08aa4d7`)
> - PR #45 D6 业务确认稿(squash commit 沿 PR #44 之后续,11 题 + 5 决议)
> - PR #65 D7 v0.1 草稿(squash commit `ebb530e`,5 项 F + 9 项 B 锁 + 16 项 Q 待评审)
> - PR #66 D7-RBAC v1.2 修订(squash commit `2b934c5`,Permission code 正则 3 段 → 3-4 段;为本批次提供文档先决条件)
> - PR #67 D7 v0.2 局部收口(squash commit `e4ff48f`,锁定 13 项 Q + 挂起 3 项 + 建议 1 项)
> - PR #68 D7 v1.0 冻结(squash commit `5da801f`,27 项锁 + 1 挂起 + 2 挂起待 Provider + 1 不冻结 + 2 v1.1)
>
> **本立项 PR 边界**:仅文档 4 处(本立项记录 + TASKS.md + V2 红线 + CHANGELOG)。**不动代码 / schema / migration / 依赖 / 版本号**。

---

## 一、立项背景

### 1.1 已完成的设计阶段

C-7 attachments 的设计阶段已**全部完成**(沿 PR #44 → #45 → #65 → #66 → #67 → #68 六段)。

| 阶段 | PR | squash commit | 状态 |
|---|---|---|---|
| 业务访谈提纲 | #44 | `08aa4d7` | ✅ 已合并 |
| D6 业务确认稿 | #45 | 沿 PR #44 后续 | ✅ 已合并(11 题逐项拍板 + 5 决议) |
| D7 v0.1 草稿 | #65 | `ebb530e` | ✅ 已合并(5 项 F 锁 + 9 项 B 锁 + 16 项 Q 待评审) |
| D7-RBAC v1.2 修订(Permission code 正则 3-4 段) | #66 | `2b934c5` | ✅ 已合并(为本批次提供文档先决条件) |
| D7 v0.2 局部收口 | #67 | `e4ff48f` | ✅ 已合并(13 项 Q 锁 + 1 挂起 + 2 挂起待 Provider + 1 不冻结) |
| **D7 v1.0 冻结** | **#68** | **`5da801f`** | ✅ **已合并;27 项锁定 + 1 挂起(Q12)+ 2 挂起待 Provider 选型(Q14/Q15)+ 1 建议不冻结(Q16)+ 2 v1.1 由业务方提供(B8 同意书正式文本 / Q8 N 具体值)** |

### 1.2 已锁定的 27 项决议(沿 D7 v1.0)

完整决议表见 [`docs/批次7_attachments_API前评审.md §16`](批次7_attachments_API前评审.md)。

**F 类(框架级骨架,5 项;v0.1 用户拍板)**:

- F1 Permission code 正则放宽到 3-4 段(`/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/`;D7-RBAC v1.2 PR #66 已合;实际 `CODE_PATTERN` 代码常量放宽留 C-7 实施 PR #1)
- F2 Provider **不实装**;D7 仅覆盖元数据 + API 契约 + RBAC + audit + 配置三表
- F3 attachments 入口 Guard = **仅 `JwtAuthGuard`**;判权全部在 Service 层 `rbac.can()`;attachments 是 **0 → 1 接入 RBAC 的业务范本**
- F4 配置三表 CRUD 入口 = **`@Roles(SUPER_ADMIN, ADMIN)`**(不为配置三表新增 `rbac.config.*` 权限点)
- F5 BizCode 段位 = **`130xx` + `131xx`**(沿 baseline §1.1 v0.5.0 预留)

**B 类(沿 D6,9 项)**:

- B1 启用场景 1-4(队员证件 + 证书 + 活动现场照 + 活动封面);场景 5-6(培训资料 / 装备图)延后
- B2 单归属 1:N
- B3 多态外键 `ownerType` + `ownerId`(Service 层手写校验;无 DB FK)
- B4 硬删除(沿 D6 Q5 B;删除矩阵见 §6.4)
- B5 13 字段全加(沿 D6 Q2)
- B6 不做病毒扫描(沿 D6 Q8c A)
- B7 配置三表与 attachments 主模块同批次
- B8 最低合规版(v1.0 锁四锚点;⏳ 正式条款文本 v1.1 由业务方提供)
- B9 Provider 选型独立评审

**Q 类(v0.2/v1.0 锁定 13 项)**:

- Q1 活动封面 = **复用 attachments + ownerType=activity + subType 标识 cover**;不改 Activity schema
- Q2 accessLevel = **hint + 索引**(实际权限走 RBAC 单一权威源)
- Q3 tags = **`String[]` PG 原生数组**(不建关联表)
- Q4 uploadedBy = **User.id**
- Q5 ownerType **双层校验**:业务层 `AttachmentOwnerType` TS enum 作为代码防错边界 + 配置表 `attachment_type_config.code` 作为运行时可配置白名单
- Q6 checksum / etag **不进普通出参 DTO**
- Q7 PATCH metadata **不审计**
- Q8 退队清理 = **`Member.status=DISABLED ≥ N + 后台提示`**;系统不自动删除;**N 不在 schema 硬编码,⏳ 具体值 v1.1 由业务方确认**
- Q9 PII BizCode = **预留 `ATTACHMENT_PII_DETECTED=13015`**
- Q10 activity 场景 **不分 self/other**(粗粒度活动级权限)
- Q11 **20 条 `attachment.*` 权限点清单**(沿 §6.1 表;实际 seed 落地由 C-7 实施 PR 完成)
- Q13 系统级 MIME 黑名单(D7 设计清单;后续 Provider 选型 / 安全评审可追加)

### 1.3 挂起 / 不冻结 / v1.1 待业务方项

| 类别 | 项 | 状态 |
|---|---|---|
| 🔄 沿用挂起(留独立专项评审 PR) | Q12 ADMIN 内置角色自动持所有 `.other` | 不阻塞 attachments 主体冻结;实施期默认按方案 B(沿 v0.9.0 §5 现状)走 |
| ⏸ 挂起待 Provider 选型评审 | Q14 Provider 上传策略 | Provider 选型决定签名 URL / STS / 中转代理 |
| ⏸ 挂起待 Provider 选型评审 | Q15 Provider 删除策略 | Provider 选型决定删除失败处理 + 生命周期策略 |
| 📋 建议不冻结 | Q16 PR 拆分顺序 | 沿 §13 建议 9-11 PR;实施期允许按风险拆分或合并 |
| ⏳ v1.0 锁最低原则,正式文本 v1.1 由业务方提供 | B8 入队同意书正式条款 | v1.0 锁四锚点(上传授权 / 用途 / 保存 / 访问);正式文本**不写入本系统仓库** |
| ⏳ v1.0 锁配置项语义,具体值 v1.1 由业务方提供 | Q8 退队清理 N 具体值 | v1.0 锁配置项语义(N 不在 schema 硬编码);具体值由队里管理层 / 合规口径确认 |

### 1.4 已建立的基础设施

- [`docs/srvf-foundation-baseline.md §1.1`](srvf-foundation-baseline.md):段位 `130xx + 131xx` `attachments` 模块预留(早于 v0.5.0)
- [`docs/批次8_RBAC_API前评审.md §10.2`](批次8_RBAC_API前评审.md)(v1.2 修订后):4 段 `attachment.*` 权限点示例在文档层面合法
- [`ARCHITECTURE.md §9`](../ARCHITECTURE.md):升级路径条目(C-7 attachments + 文件上传 Provider)

---

## 二、立项内容(C-7 attachments 实施范围)

### 2.1 attachments 主表(B3 / B4 / B5 + Q1-Q11 / Q13)

| 表 | 用途 | 软删策略 |
|---|---|---|
| `Attachment` | 多态附件元数据(13 业务字段 + 主键 + 时间戳;沿 D7 v1.0 §4.1)| **物理删**(沿 D6 Q5 B + §6.4 删除矩阵;业务对象软删时 attachment 不动) |
| `AttachmentTypeConfig` | 附件类型注册 + ownerType 白名单(沿 D7 v1.0 §4.2) | 软删(`deletedAt`)|
| `AttachmentMimeConfig` | MIME 白名单覆盖(沿 D7 v1.0 §4.3) | 软删 |
| `AttachmentSizeLimitConfig` | 单文件尺寸上限覆盖(沿 D7 v1.0 §4.4) | 软删 |

**Certificate.attachmentKey 字段废弃**(沿 D6 Q10 B / D7 v1.0 §4.6):attachments 主模块同 PR 末尾追加 `ALTER TABLE certificates DROP COLUMN attachment_key`;`Certificate` 出参 DTO + `certificates.select.ts` 同步删除字段。

### 2.2 BizCode 段位(F5)

| 段位 | 用途 | 容量 |
|---|---|---|
| `130xx` | attachments + 配置三表实体级错误(NOT_FOUND / 唯一约束 / mime / size / ownerType / PII) | 100 |
| `131xx` | attachments + 配置三表权限 / 操作 / 完整性错误(沿 baseline §1.3 子段位风格) | 100 |

子段位预算(沿 D7 v1.0 §8.1):约 16 条 BizCode(`13001-13031` + `13101`);实施期可微调。

### 2.3 RBAC 接入(F3 / F9 + Q11 + Q12 挂起)

- **入口 Guard 仅 `JwtAuthGuard`**(全局);**不**加 `@Roles(SUPER_ADMIN, ADMIN)` 兜底
- **Service 层显式 `rbac.can()`**(沿 D7-RBAC F5):attachments 是 **0 → 1 接入业务范本**
- **20 条 `attachment.*` 权限点清单**(Q11 v1.0 已锁;实际 seed 由 C-7 实施 PR 完成)
- **Q12 ADMIN 内置角色挂起**:留独立"RBAC 内置角色 / ADMIN 默认附件权限"专项评审 PR;实施期默认按方案 B(ADMIN 默认无 RBAC 业务角色;需 ops-admin 显式分配)
- **沿 F9 红线**:不动 v1 14 + V2 79 + RBAC 16 既有接口;attachments 是首批接入 `rbac.can()` 的业务模块

### 2.4 audit_logs 集成(沿 A-17)

`AuditLogEvent` union 新增 3 项(沿 D7 v1.0 §7.1):

- `attachment.upload`(单事件 + `extra.attachmentType` / `extra.ownerType` / `extra.size` / `extra.mime` 区分)
- `attachment.delete`(单事件 + `extra.deletedByPath ∈ {owner, admin}`)
- `attachment.config.change`(配置三表通用事件 + `extra.configType ∈ {type, mime, sizeLimit}` + `extra.operation ∈ {create, update, delete}`)

**不审计**:view / list / PATCH metadata(Q7 v1.0 锁)/ Provider 真上传 / 真下载(F2 Provider 不实装)。

---

## 三、实施前置硬约束

### 3.1 不引入(沿 V1.1 §17.3 + D7 §3)

- ❌ **不引入 Provider 实装**(F2 锁;沿 D6 决议 5;Provider 选型独立评审稿同期推进)
- ❌ **不实装真上传 / 真下载**(D7 实施期 attachments 接口落库元数据 + 占位 URL;Provider 接通后由独立 PR 接入)
- ❌ **不做病毒扫描**(沿 D6 Q8c A)
- ❌ **不做加密 KMS**(沿 D6 Q9 决议 4 最低合规版)
- ❌ **不做自动清理脚本**(沿决议 4;ADMIN 手动清理)
- ❌ **不做 OCR**(沿 Q7 合规;身份证号永远图像形态)
- ❌ **不做秒传 / checksum 唯一约束**(checksum 字段存,但本期不开 unique index)
- ❌ **不引入 Redis / 队列 / 定时任务**(沿 V1.1 §17.3)

### 3.2 不改 v1 / V2 / RBAC 既有接口(沿 A-2 红线)

- ❌ **不改 v1 14 接口**(路径 / HTTP 方法 / 入参 DTO / 出参 DTO / 错误码 / 权限标注 / 响应包装 全部 zero drift)
- ❌ **不改既有 V2 79 接口**(同 A-2)
- ❌ **不改 RBAC 16 接口**(沿 v0.9.0 收口现状;入口仍 `@Roles(SUPER_ADMIN, ADMIN)`,业务模块判权迁出留独立 PR)
- ❌ **不动 `users.policy.ts`**(沿 D7-RBAC D12 永久共存)
- ❌ **不修改 `JwtStrategy.validate()` 查库逻辑**(沿 v1 §8)
- ❌ **不动 `prisma/schema.prisma`**(本立项 PR 边界);schema 变更由实施 PR #1 落地

### 3.3 v1.0 冻结后才允许进入实施

- ✅ D7 v1.0 已冻结(PR #68)
- ✅ D7-RBAC v1.2 已合(PR #66;Permission code 正则 3-4 段文档先决条件)
- ✅ 本 V2.x 立项 PR 合并 → **解除 V2 §18 调研期硬禁止**
- ⏳ 实施 PR #1 启动前必须:**先展示 schema diff + migration SQL**,等用户明确确认后才执行 `prisma migrate dev`(沿 CLAUDE.md §0 铁律)

---

## 四、实施 PR 拆分(建议,Q16 不冻结)

> **📋 Q16 v1.0 沿用建议不冻结**:沿 [D7 v1.0 §13](批次7_attachments_API前评审.md) 表 **建议 9-11 PR**;**实施期允许按风险拆分或合并**;**只锁实施顺序原则,不锁死 PR 数量**。

| PR | 类型 | 主题(建议) | 关键变更 |
|---|---|---|---|
| **1** | `chore(prisma)` | **add Attachment schema + Permission code regex relax** | 4 model(`Attachment` + 3 配置表)+ migration + Certificate.attachmentKey drop column + `permissions.service.ts` `CODE_PATTERN` 放宽 `{2}$/` → `{2,3}$/` + 加 e2e 4 段用例 |
| 2 | `feat(attachments)` | attachments 主模块 CRUD(端点 1-7) | DTO + service + controller + select + Swagger;Service 层显式 `rbac.can()` |
| 3 | `feat(attachment-configs)` | AttachmentTypeConfig CRUD(端点 8-12)| `@Roles(SUPER_ADMIN, ADMIN)` 入口;沿 baseline §2.2.3 启停字段命名 |
| 4 | `feat(attachment-configs)` | AttachmentMimeConfig CRUD(端点 13-17)| 同上 |
| 5 | `feat(attachment-configs)` | AttachmentSizeLimitConfig CRUD(端点 18-22)| 同上 |
| 6 | `feat(attachments)` | RBAC 集成 + `attachment.*` 权限点 seed + USER 内置角色 placeholder seed | 20 条 Permission upsert + RolePermission 映射;`role-a..role-f` 真实角色 + dept-chief / dept-deputy seed 仍走 `.env.seed.local`(沿 D7-RBAC F6 / R13) |
| 7 | `feat(attachments)` | audit_logs 集成(3 项 union + 同事务 wrap)| 沿 A-17 红线;每个写接口 wrap `prisma.$transaction` 内调 `AuditLogsService.log({ tx })` |
| 8 | `feat(certificates)` | Certificate.attachmentKey 字段废弃(出参 DTO / select / e2e 同步删除引用)| 沿 D6 Q10 B(若已在 PR #1 内 drop column,本 PR 只清理引用)|
| 9 | `docs(v2-batch7-landing)` | 收口 docs(类比 PR #62 / #29-#41 风格)| 更新本立项记录 + V2 红线 + TASKS.md + CHANGELOG |
| 10 | `chore` | bump version 0.9.0 → 0.10.0(SemVer minor;新模块 + 4 表 + 22 接口) | `package.json` + Swagger `setVersion(...)` |
| 11 | `docs(v2)` | v0.10.0 handoff(类比 v0.8.0 / v0.8.1 / v0.9.0 handoff)| 13 章节范式 + 下一会话提示词 |

**实施周期**(沿 D7-RBAC 实际节奏参考):预估 1-3 天(C-6 RBAC 实际 1 天落地 8 PR;C-7 attachments 范围相当)。

**新增依赖**:**预期 0 个**(不引入 Provider 实装;config 缓存沿 D7-RBAC `RbacCacheService` Map + setTimeout 范式 / 自实现)。

---

## 五、本立项 PR 边界

### 5.1 本 PR 做(仅文档 4 处)

- ✅ 新增本文件 [`docs/批次7_attachments_V2x立项记录.md`](批次7_attachments_V2x立项记录.md)
- ✅ 更新 [`TASKS.md`](../TASKS.md) §8 V2.x C-7 attachments 立项准备(短摘要 + 链回本文件)
- ✅ 更新 [`docs/V2红线与复活路径.md`](V2红线与复活路径.md):C-7 行从"D7 attachments 评审 → V2.x 立项"更新为"D7 v1.0 已冻结,V2.x implementation track 启动";明确 Provider 仍挂起;明确 attachments 作为业务判权接入首个范本
- ✅ 更新 [`CHANGELOG.md`](../CHANGELOG.md) Unreleased 追加一行

### 5.2 本 PR 不做(全部沿 V2.x 立项 ≠ 实施 红线)

- ❌ **不动代码**:`src/**` / `prisma/**` / `test/**` 零触碰
- ❌ **不动 schema**:`prisma/schema.prisma` 不动,**不新增 migration**
- ❌ **不改 seed**:`prisma/seed.ts` 不动
- ❌ **不动依赖**:`package.json` / `pnpm-lock.yaml` 不动
- ❌ **不放宽 `CODE_PATTERN` 常量**(沿 D7-RBAC v1.2 + D7 v1.0 锁:文档层已打开 3-4 段;实际代码常量放宽留实施 PR #1)
- ❌ **不 bump version**:`package.json#version` 仍 `0.9.0` / Swagger `setVersion(...)` 仍 `0.9.0`
- ❌ **不打 tag** / **不发 GitHub Release**
- ❌ **不启动 C-7 attachments 实施**(实施 PR #1 仍需单独启动 + 用户授权)
- ❌ **不启动 Provider 选型评审稿**(独立 PR;沿 D6 决议 5)
- ❌ **不启动"RBAC 内置角色 / ADMIN 默认附件权限"专项评审 PR**(独立 PR;Q12 留待业务方确认)
- ❌ **不改 baseline / ARCHITECTURE.md**(段位早已预留)
- ❌ **不改 docs/批次7_attachments_API前评审.md**(D7 v1.0 已冻结,本立项 PR 不回改)
- ❌ **不改 docs/批次8_RBAC_API前评审.md**(D7-RBAC v1.2 已合,本立项 PR 不回改)
- ❌ **不改 docs/handoff/v0.9.0.md** / 其他历史 handoff(沿 V2 红线 §5.1 历史 handoff 不回改)
- ❌ **不把入队同意书正式文本写入仓库**(沿 D7 v1.0 §9.6 + B8)
- ❌ **不在 schema 硬编码退队清理 N 时长**(沿 D7 v1.0 §9.5 + Q8)

---

## 六、合并后的下一步

### 6.1 立项 PR(本 PR)合并 → 实施 PR #1 启动条件就位

- ✅ D7 v1.0 已冻结(PR #68)
- ✅ D7-RBAC v1.2 文档先决条件已合(PR #66)
- ✅ 本立项 PR 合并 → 解除 V2 §18 调研期硬禁止
- ⏳ 实施 PR #1 启动前必须:**先展示 schema diff + migration SQL**,等用户明确确认(沿 CLAUDE.md §0 铁律)

### 6.2 实施 PR #1 内容范围(建议;Q16 不冻结)

实施 PR #1 主题:**`chore(prisma): add Attachment schema + Permission code regex relax`**(沿 §四 PR #1 拆分建议)

**预期变更范围**:

- `prisma/schema.prisma`:新增 4 个 model(`Attachment` + `AttachmentTypeConfig` + `AttachmentMimeConfig` + `AttachmentSizeLimitConfig`)+ User 反向 relation `attachmentsUploaded`(沿 D7 v1.0 §4.1-§4.4)
- `prisma/schema.prisma`:`Certificate.attachmentKey` 字段删除(沿 D6 Q10 B / D7 v1.0 §4.6)
- `prisma/migrations/<timestamp>_add_attachments/migration.sql`:新增 4 张表 + drop column 命令
- `src/modules/permissions/permissions.service.ts`:`CODE_PATTERN` 常量放宽 `{2}$/` → `{2,3}$/`(沿 D7-RBAC v1.2 文档先决条件)
- `src/modules/permissions/permissions.dto.ts`:Swagger example 同步(沿 D7-RBAC v1.2)
- `test/permissions.e2e-spec.ts`:加 4 段权限点验证用例
- `src/modules/certificates/*`:删除 `attachmentKey` 字段引用(`certificates.select.ts` + `CertificateResponseDto`)
- 不动 src/modules/attachments / src/modules/attachment-configs(留 PR #2-#5)

**实施 PR #1 启动前必须停下确认**:

- ✅ schema diff(本立项 PR 合并后,实施 PR #1 撰写时展示)
- ✅ migration SQL(本立项 PR 合并后,实施 PR #1 撰写时展示)
- ✅ Certificate 出参 contract snapshot 预期变更
- ⏳ 等用户明确"绿灯"后才执行 `prisma migrate dev`

### 6.3 并行可启动的独立 PR(不阻塞实施)

| PR | 性质 | 用途 |
|---|---|---|
| Provider 选型独立评审稿 | docs-only | 与 attachments 实施期同期推进;决议 Q14 / Q15;沿 D6 决议 5 |
| "RBAC 内置角色 / ADMIN 默认附件权限"专项评审 PR | docs-only | 决议 Q12;不阻塞 attachments 主体实施 |

两项均**独立 PR**,均需**用户明确授权**才启动;不在本立项 PR 范围。

### 6.4 v1.1 修订 PR(等业务方提供)

待业务方提供以下两项后,启动 D7-attachments v1.1 修订 PR:

- B8 入队同意书正式条款文本(**不写入本系统仓库**;保存在队组织自有合规文档系统;系统侧仅链接 URL)
- Q8 退队清理 N 具体值(身份证类 / 其他证件类)

---

## 七、风险与边界声明

### 7.1 立项 ≠ 实施

**本 PR 仅完成 V2.x 立项准备**;C-7 实施需单独 PR 推进。AI / 维护者**不得**在本 PR 合并后"顺手"启动实施 PR #1,必须等用户明确授权 + 展示 schema diff + migration SQL 双确认。

### 7.2 D7 v1.0 决议不可绕过

实施 PR 必须**严格遵循** D7 v1.0 冻结的 27 项决议(沿 [`docs/批次7_attachments_API前评审.md §16`](批次7_attachments_API前评审.md))。任何"实施时发现需要调整决议"的情况,必须**暂停 + 向用户说明**,不得擅自调整。如确需调整决议,需另起 D7 v1.x 修订 PR + 用户拍板,再启动实施。

### 7.3 不引入未登记新依赖

实施 PR 中如需引入新依赖,必须在对应 PR 任务卡中显式登记,沿 baseline `不得引入未在任务卡声明的新依赖` 纪律。**预期 0 个新依赖**(沿 §四 PR 拆分注释)。

### 7.4 contract snapshot 守护

实施 PR 必须保证 **v1 14 + V2 79 + RBAC 16 接口 schema + paths zero drift**(沿 A-2 红线);新增 22 attachments 接口加入 snapshot;`Certificate.attachmentKey` 字段从 OpenAPI 消失(预期变更;Q10 v1.0 锁)。任何 v1 / 既有 V2 / 既有 RBAC 接口字段变化视作 A-2 红线破口,**不可合并**。

### 7.5 段位预留 ≠ 段位实装

baseline §1.1 已预留 `130xx + 131xx`,但约 16 条 BizCode **尚未实装**;实装由实施 PR 完成(主要在 PR #2-#7 各模块加 BizCode)。

### 7.6 Provider 实装仍在 V2 §18 调研期约束之外

虽然本立项 PR 合并解除 attachments 主体的调研期硬禁止,但**Provider 实装仍未脱出"暂不做"边界**(沿 F2 + B9 + D6 决议 5)。Provider 实装需独立 Provider 选型评审稿 → Provider 实装 PR;沿 ARCHITECTURE.md §9 升级路径。

### 7.7 实施 PR #1 涉及破坏性 schema 变更

`Certificate.attachmentKey DROP COLUMN` 是破坏性 schema 变更:
- 历史数据全 NULL(沿 v0.3.0 批次 2 R12 锁定 `attachmentKey` 始终 NULL)
- migration 零数据迁移成本
- e2e 需更新 1-2 处对 `attachmentKey` 字段的断言
- contract snapshot 预期变更(Certificate 出参 - 1 字段)

**实施 PR #1 启动前**:必须先展示 migration SQL + e2e diff,等用户明确"破坏性变更已经过评审"后才执行。

---

## 八、参考引用

### 主要引用

- [`docs/批次7_attachments_API前评审.md`](批次7_attachments_API前评审.md):D7 v1.0 冻结稿(27 项决议、4 表 schema、22 端点、RBAC 集成、audit 集成、合规口径)
- [`docs/批次7_attachments_业务确认稿.md`](批次7_attachments_业务确认稿.md):D6 业务方 11 题拍板 + 5 决议
- [`docs/批次7_attachments_业务访谈提纲.md`](批次7_attachments_业务访谈提纲.md):访谈提纲
- [`docs/批次8_RBAC_API前评审.md`](批次8_RBAC_API前评审.md):D7-RBAC v1.2 修订(Permission code 正则 3-4 段;本批次文档先决条件)
- [`docs/批次8_RBAC_V2x立项记录.md`](批次8_RBAC_V2x立项记录.md):C-6 立项记录范本(本立项 PR 风格参照)

### 红线 / 复活路径

- [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) **A-2**:v1 14 + V2 79 + RBAC 16 接口 zero drift
- [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) **A-17**:audit_logs 同事务 fail-fast
- [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) **C-7 / Slow-2**:attachments 复活硬前置(本立项启动)
- [`docs/V2红线与复活路径.md`](V2红线与复活路径.md) **C-10**:文件上传 Provider 实装(仍挂起;本批次不做)

### 基线 / 段位

- [`docs/srvf-foundation-baseline.md §1.1`](srvf-foundation-baseline.md):BizCode 段位 `130xx + 131xx` `attachments` 模块预留

### 升级路径 / 架构

- [`ARCHITECTURE.md §9`](../ARCHITECTURE.md):升级路径(C-7 attachments + 文件上传 Provider)
- [`ARCHITECTURE.md §12.11.2`](../ARCHITECTURE.md):V2.x 复活路径

### 阶段交接

- [`docs/handoff/v0.9.0.md`](handoff/v0.9.0.md):C-6 RBAC 全模块实施收口 + C-7 前置门槛(v0.9.0 tag + Release 已就位)

---

## 九、撰写元信息

- **状态标签**:V2.x 立项准备(等用户授权启动实施 PR #1)
- **commit message**:`docs(v2-design): start C-7 attachments V2.x implementation track`
- **PR 标题**:同 commit message
- **未做项**(本 PR 边界):
  - 不动 `src/**` / `prisma/**` / `test/**` / `package.json` / `pnpm-lock.yaml`
  - 不新增 migration
  - 不改 seed
  - 不放宽 `CODE_PATTERN` 常量
  - 不 bump version / 不打 tag / 不发 Release
  - **不启动 C-7 attachments 实施 PR**
  - 不启动 Provider 选型评审稿(独立 PR)
  - 不启动 Q12 ADMIN 内置角色专项评审 PR(独立 PR)
  - 不改 D7-RBAC / D7-attachments 已冻结文档
- **本 PR 修订范围**(4 处文档):
  - 新增本文件 `docs/批次7_attachments_V2x立项记录.md`
  - `TASKS.md` 追加 §8 V2.x C-7 attachments 立项准备(短摘要 + 链回本文件)
  - `docs/V2红线与复活路径.md` 更新 C-7 行(状态从"D7 attachments 评审 → V2.x 立项"改为"D7 v1.0 已冻结,V2.x implementation track 启动");明确 Provider 仍挂起;明确 attachments 作为业务判权接入首个范本
  - `CHANGELOG.md` Unreleased 追加一行
- **撰写者签名**:Claude Code(基于 D7 v1.0 冻结 PR #68 `5da801f` + 用户立项指令 + D7-RBAC 立项记录 PR #52 风格参照;**未动任何代码 / schema / migration**)
