# 《C-7 attachments V2.x 立项记录(批次 7)》

> **状态(2026-05-15 实施收口)**:✅ **C-7 attachments 实施已完成**。9 个实施 PR 全部 squash merge(#70-#78);主模块 7 端点 + 配置三表 15 端点 + RBAC + audit 全部就位;**版本号 bump / git tag / GitHub Release / handoff 留独立 PR**。
>
> **历史状态(2026-05-14 立项)**:🎯 D7 v1.0 冻结完成,V2.x implementation track 启动。立项 PR #69 合并即解除 C-7 attachments 的 V2 §18 调研期硬禁止。
>
> **批次号**:C-7 attachments(批次 7)
> **撰写日期**:2026-05-14(立项;PR #69 squash commit `e620a2c`)/ 2026-05-15(实施收口;本 landing PR)
> **接续(设计阶段)**:
> - PR #44 业务访谈提纲(squash commit `08aa4d7`)
> - PR #45 D6 业务确认稿(squash commit `0642d36`,11 题 + 5 决议)
> - PR #65 D7 v0.1 草稿(squash commit `ebb530e`,5 项 F + 9 项 B 锁 + 16 项 Q 待评审)
> - PR #66 D7-RBAC v1.2 修订(squash commit `2b934c5`,Permission code 正则 3 段 → 3-4 段;为本批次提供文档先决条件)
> - PR #67 D7 v0.2 局部收口(squash commit `e4ff48f`,锁定 13 项 Q + 挂起 3 项 + 建议 1 项)
> - PR #68 D7 v1.0 冻结(squash commit `5da801f`,27 项锁 + 1 挂起 + 2 挂起待 Provider + 1 不冻结 + 2 v1.1)
> - PR #69 V2.x 立项 PR(squash commit `e620a2c`,本文件初始版本)
>
> **接续(实施阶段;9 PR 累计;2026-05-15 同日全部 squash merge)**:
> - PR #70 适配 PR:`feat(permissions): support 4-segment permission codes`(squash commit `4d9332e`;F1 落地)
> - PR #71 实施 #2:`chore(prisma): add attachments schema and config tables`(squash commit `ce37ffe`)
> - PR #72 实施 #3:`feat(attachments): add attachment type config module`(squash commit `663506d`)
> - PR #73 实施 #4:`feat(attachments): add attachment mime config module`(squash commit `579429b`)
> - PR #74 实施 #5:`feat(attachments): add attachment size limit config module`(squash commit `81c9bff`)
> - PR #75 实施 #6a:`feat(permissions): seed attachment permissions and member role`(squash commit `ff34616`)
> - PR #76 实施 #6b:`feat(attachments): add attachments main module with RBAC integration`(squash commit `308d6d9`)
> - PR #77 实施 #6c:`feat(attachments): integrate audit logs`(squash commit `abd9b32`)
> - PR #78 实施 #6d:`feat(attachments): integrate attachment config audit logs`(squash commit `8ee24e2`)
>
> **本 landing PR 边界**:仅文档 4 处(本立项记录 §一时间线 + §四 PR 拆分实际完成 + §六合并后的下一步状态更新 + TASKS.md §8 + V2 红线 §4.3 C-7 行 + CHANGELOG `Unreleased` `### Added` + `### Docs`)。**不动代码 / schema / migration / 依赖 / 版本号 / git tag / Release**。

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

## 四、实施 PR 拆分(实际完成清单)

> **📋 Q16 v1.0 沿用建议不冻结 → 实际落地 9 个实施 PR**(原建议 9-11 PR;Certificate.attachmentKey drop column 合并到 PR #71 schema 一起;collateral PR #70 拆出适配 Permission code 正则)。
>
> **状态约定**:✅ 已落地(含 squash commit) / ⏳ 留独立后续 PR(version bump / handoff)。

| 实施 PR # | GitHub PR | squash commit | 类型 | 主题 | 状态 |
|---|---|---|---|---|---|
| **collateral** | #70 | `4d9332e` | `feat(permissions)` | support 4-segment permission codes(`CODE_PATTERN` 放宽到 3-4 段;F1 落地) | ✅ 已合并 |
| **1**(原建议合并) | #71 | `ce37ffe` | `chore(prisma)` | add attachments schema and config tables(4 model + migration + Certificate.attachmentKey drop column) | ✅ 已合并 |
| 2 | #72 | `663506d` | `feat(attachments)` | add attachment type config module(端点 8-12;6 端点含独立 status;BizCode 13020/13021/13023)| ✅ 已合并 |
| 3 | #73 | `579429b` | `feat(attachments)` | add attachment mime config module(端点 13-17;6 端点含独立 status;BizCode 13022/13024/13025)| ✅ 已合并 |
| 4 | #74 | `81c9bff` | `feat(attachments)` | add attachment size limit config module(端点 18-22;**5 端点无 status**;BizCode 13026/13027)| ✅ 已合并 |
| 5a | #75 | `ff34616` | `feat(permissions)` | seed 20 条 `attachment.*` Permission + `member` 内置 RbacRole + 9 条 RolePermission | ✅ 已合并 |
| 5b | #76 | `308d6d9` | `feat(attachments)` | attachments 主模块 7 端点 + RBAC 集成(首次业务模块 `rbac.can()`;PermissionsModule export RbacService;BizCode 13001 / 13010-13013 / 13015)| ✅ 已合并 |
| 6 | #77 | `abd9b32` | `feat(attachments)` | attachments 主模块 audit_logs 集成(`attachment.upload` + `attachment.delete` 2 events;同事务 fail-fast;扩 19 个 audit e2e)| ✅ 已合并 |
| 6+ | #78 | `8ee24e2` | `feat(attachments)` | 配置三表 audit_logs 集成(`attachment.config.change` 1 event;11 写端点;扩 21 个 audit e2e)| ✅ 已合并 |
| **landing**(本 PR) | TBD | TBD | `docs(v2)` | record C-7 attachments implementation landing(本立项记录 + V2 红线 + TASKS + CHANGELOG)| ⏳ 进行中 |
| 后续 1 | TBD | TBD | `chore` | bump version(SemVer 待维护者拍板:0.9.0 → 0.9.1 patch 或 0.10.0 minor;参考新增 22 接口 + 4 表 + 1 migration + 3 audit events)| ⏳ 留独立 PR |
| 后续 2 | TBD | TBD | `docs(v2)` | 新版本 handoff(类比 v0.8.0 / v0.8.1 / v0.9.0 范式) | ⏳ 留独立 PR |

**实际实施周期**:**1 天**(2026-05-15 同日 9 PR 全部 squash merge;沿 D7-RBAC v0.9.0 段同天落地 8 PR 节奏)。

**实际新增依赖**:**0 个**(沿 v1 §1 + V1.1 §17 严控;不引入 Provider 实装 / Redis / 队列;config 缓存沿 `RbacCacheService` Map + setTimeout 范式;`@nestjs/throttler` 内存 storage 等既有依赖未变)。

**实际偏离建议清单**:

- **建议 PR #1 拆出 collateral PR #70**:把 `CODE_PATTERN` 放宽单独成 PR,与 schema PR 解耦,沿 D7-RBAC v1.2 文档先决条件
- **建议 PR #6 拆出 #75 / #76**:seed 与主模块 + RBAC 拆开,避免单 PR 跨 permissions / attachments 两模块;沿用户路径 C 拍板
- **建议 PR #7 拆出 #77 / #78**:主模块 audit 与配置三表 audit 拆开,边界更清(主模块改 attachments/**;配置三表改 attachment-configs/**)
- **建议 PR #8 Certificate.attachmentKey 清理合并到 PR #71**:同 migration 内 drop column;沿 D7 v1.0 §4.6 + 用户拍板提前清理
- **建议 PR #9 = 本 landing PR**(对应)
- **建议 PR #10 / #11 留独立后续 PR**(SemVer / handoff 由维护者评估)

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

## 六、合并后的下一步(landing 后状态)

### 6.1 C-7 implementation landing 已完成 ✅

| 阶段 | 状态 | 备注 |
|---|---|---|
| D7 v1.0 冻结(PR #68 `5da801f`) | ✅ 已合 | 2026-05-14 |
| D7-RBAC v1.2 文档先决条件(PR #66 `2b934c5`) | ✅ 已合 | 2026-05-14 |
| 立项 PR(PR #69 `e620a2c`) | ✅ 已合 | 2026-05-14 |
| 实施 PR #70-#78(9 PR) | ✅ 全部已合 | 2026-05-15 同日落地 |
| Landing PR(本 PR `docs(v2): record C-7 attachments implementation landing`) | ⏳ 进行中 | 4 处 docs 修订(本立项记录 + V2 红线 + TASKS + CHANGELOG) |

### 6.2 后续 PR(留独立 PR;不在本 landing PR 范围)

| PR | 性质 | 用途 | 时机 |
|---|---|---|---|
| **版本号 bump** | `chore` | bump `package.json#version` + Swagger `setVersion(...)`;**SemVer 由维护者拍板**:`0.9.0 → 0.9.1`(若按 patch 解读 docs-only 增量)或 `0.9.0 → 0.10.0`(若按 minor 解读 +22 接口 / +4 表 / +1 migration / +3 audit events) | landing 合并后由维护者评估 |
| **GitHub Release / git tag** | 维护者手动 | 沿 v0.9.0 终态范式(handoff 后维护者打 tag + 发 Release) | 跟随 bump |
| **新版本 handoff** | `docs(v2)` | 类比 v0.8.0 / v0.8.1 / v0.9.0 13 章节范式;**下一会话启动必读** | bump 之后 |

**Claude Code 在 landing 合并后不应自动启动**版本 bump / handoff;由用户明确授权后再开。

### 6.3 并行可启动的独立 PR(不阻塞 C-7 收口;由用户授权)

| PR | 性质 | 用途 | 状态 |
|---|---|---|---|
| Provider 选型独立评审稿 | docs-only | 决议 Q14 / Q15;沿 D6 决议 5;Provider 实装挂起项之解锁条件 | ⏳ 用户未授权 |
| "RBAC 内置角色 / ADMIN 默认附件权限"专项评审 PR | docs-only | 决议 Q12;实施期默认按方案 B(沿 v0.9.0 现状) | ⏳ 用户未授权 |

### 6.4 v1.1 修订 PR(等业务方提供)

待业务方提供以下两项后,启动 D7-attachments v1.1 修订 PR(C-7 主体已落地,**仅是补充挂起项**,不算 C-7 范围扩张):

- B8 入队同意书正式条款文本(**不写入本系统仓库**;保存在队组织自有合规文档系统;系统侧仅链接 URL)
- Q8 退队清理 N 具体值(身份证类 / 其他证件类)

### 6.5 跨表引用约束 / Provider 实装 / 业务模块全面 RBAC 接入(超 C-7 范围)

以下三项**不在 C-7 范围内**,landing 后视具体诉求另起评审:

- **跨表引用约束**:`13030 ATTACHMENT_TYPE_IN_USE` 等(Q2 / Q6 / Q7 v1.0:本 C-7 不查跨表);留独立"配置三表跨表引用约束"评审 PR
- **Provider 实装**:本地 / OSS / R2 / 其他;待 Provider 选型独立评审稿决议
- **业务模块全面接入 `rbac.can()`**:14 个 RBAC CRUD 自身接入 + 79 个 V2 接口接入;超 C-7 范围,留独立"V2 全面 RBAC 接入"评审 PR

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
