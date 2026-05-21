# Attachment Config Boundary Note

> 本文是 `attachment-configs/` 三表族的**轻量边界说明**,不是设计修复稿,也不是 migration 计划。
> 用于让未来的 AI / 维护者**一眼看清"为什么是三表"**,避免把三表误判为简单冗余而提出"合表"或"抽 facade"。

---

## 1. Purpose

- 本文**只描述**当前 `attachment-configs/` 三表族的边界与运行时消费方式
- 本文**不**改变 `prisma/schema.prisma`、`src/modules/attachment-configs/`、`src/modules/attachments/` 任何代码
- 本文**不**要求把 `AttachmentTypeConfig` / `AttachmentMimeConfig` / `AttachmentSizeLimitConfig` 合并成一张 rule table
- 本文**不**要求抽 `AttachmentConfigPolicyService` facade
- 本文**仅**用于:把"三表是 override-with-default、不是冗余"这件事从代码注释和归档评审稿(`docs/archive/batches/批次7_*`)挪进 active docs,降低未来 AI 误判
- 如果未来真的要改 schema / 抽 facade / 合表,必须**先**评审并独立立项,本文不作为实施依据

---

## 2. Current model

```
AttachmentTypeConfig                       (父配置;parent)
  ├─ code                  @unique        (业务标识 kebab-case 3-32;如 'member' / 'certificate' / 'activity')
  ├─ ownerTable                            (业务表名;Service 层 ownerId 真实性校验用)
  ├─ defaultMimeWhitelist  String[]       (默认允许 MIME 列表;PG 原生数组)
  ├─ defaultMaxSizeBytes   Int?           (默认单文件大小上限;null 走全局兜底)
  ├─ status                ACTIVE/INACTIVE
  ├─ deletedAt             DateTime?      (软删)
  │
  ├─ AttachmentMimeConfig[]                (MIME whitelist override;n:1)
  │    ├─ typeConfigId                    (FK Restrict)
  │    ├─ mime                            (Service 层 regex 校验;如 'image/jpeg' / 'image/*')
  │    ├─ status         ACTIVE/INACTIVE  (单条 mime 启停)
  │    ├─ remark         String?
  │    ├─ deletedAt      DateTime?        (软删)
  │    └─ @@unique([typeConfigId, mime])
  │
  └─ AttachmentSizeLimitConfig?            (size limit override;1:1)
       ├─ typeConfigId    @unique         (每 type 至多一条 override)
       ├─ maxSizeBytes
       ├─ remark          String?
       ├─ (无 status 字段)                 (显式 schema 差异,不要补齐)
       └─ deletedAt       DateTime?       (软删)
```

要点:

- **`AttachmentTypeConfig` 是父配置**,内嵌 `defaultMimeWhitelist` + `defaultMaxSizeBytes`,作为兜底
- **`AttachmentMimeConfig` 是 n:1 MIME override**,按 `(typeConfigId, mime)` 复合唯一,可以为单条 mime 切 status
- **`AttachmentSizeLimitConfig` 是 1:1 size override**,每 type 至多一条 (`typeConfigId @unique`)
- **`SizeLimitConfig` 当前无 `status` 字段**是当前 schema 差异(MimeConfig 需要为单条 mime 启停,SizeLimit 单条全局阈值无需 status)。**不要补齐**;除非有明确产品语义触发,补 status 属于 schema 变更,走独立评审
- **三表均有 `deletedAt` 软删**;具体字段以 [`prisma/schema.prisma`](../prisma/schema.prisma) 为准
- **子表 FK 是 `onDelete: Restrict`**:TypeConfig 软删时不级联;in-use 守卫见 BizCode 13030 / 13031 / 13032(由 attachments 主表反向引用触发)

---

## 3. Runtime behavior

`src/modules/attachments/attachments.service.ts` 在上传校验链(D7 v1.0 §6.2 9 步)中**直接读三表**,集中于 3 个 private 校验方法:

| 校验维度 | 读取顺序 | 失败 BizCode |
|---|---|---|
| **owner type 允许** | `AttachmentTypeConfig.findFirst({ code, status: ACTIVE, deletedAt: null })` | 13010 `ATTACHMENT_OWNER_TYPE_INVALID` |
| **MIME 允许** | 1) 系统黑名单(`isMimeBlocked`)→ 2) `AttachmentMimeConfig` override(`typeConfigId + mime + status: ACTIVE`)→ 3) `AttachmentTypeConfig.defaultMimeWhitelist` 兜底 | 13033 系统黑名单 / 13012 未命中白名单(**fail-close**:无任何配置时拒) |
| **size 允许** | 1) `AttachmentSizeLimitConfig` override(`typeConfigId`)→ 2) `AttachmentTypeConfig.defaultMaxSizeBytes` 兜底 | 13013 超限(**fail-open**:两者均 `null` 时不限大小) |

补充:

- **`StorageSettings` / Provider 不直接消费三表**;`storage_settings.mimePolicyMode = INHERIT` 在 v1.0 默认沿用配置三表,但**不**在 Provider 层直接 join,见 [`docs/ops/cos-production-rollout-checklist.md`](ops/cos-production-rollout-checklist.md)
- **App / Mobile 不直接管理三表**;三表 CRUD 都是 Ops surface(`@ApiTags('Ops - Attachment Configs')`,挂 `/api/v2/attachment-*-configs/*`)
- **runtime 读点集中**:全仓只有 `attachments.service.ts` 一处直接 prisma 读三表;无其它模块旁路读取

---

## 4. Why not merge into one rule table now

合并为单表(如 `AttachmentRule { ruleType, valueJson, ... }`)在理论上可表达 MIME + size + 未来可能的 retention/PII/virus-scan policy,但**当前不做**,原因:

1. **schema migration 高风险**:需要 data migration + downtime 窗口或双写;现有 3 表已稳定运行,无故障驱动
2. **3 套 API surface 全废**:`/api/v2/attachment-type-configs/*`(6 端点)/ `attachment-mime-configs/*`(6 端点)/ `attachment-size-limit-configs/*`(5 端点)共 17 个端点全部要重设
3. **OpenAPI / e2e / BizCode / audit `resourceType` 字段含义全变**:
   - e2e ~2476 LOC(`attachment-type-configs.e2e-spec.ts` / `attachment-mime-configs.e2e-spec.ts` / `attachment-size-limit-configs.e2e-spec.ts` / `attachment-configs.audit.e2e-spec.ts` / `attachment-configs.in-use.e2e-spec.ts`)需要重写
   - BizCode 段位 13020-13032 与 audit `resourceType ∈ {attachment_type_config, attachment_mime_config, attachment_size_limit_config}` 现有语义全部失效
4. **`valueJson` / `ruleType` 单表降低类型与索引清晰度**:
   - 当前 `AttachmentMimeConfig.mime: String` 是强类型;合表后变 `valueJson` 字符串,丢失 prisma 层 typing
   - 现有 `@@unique([typeConfigId, mime])` 与 `AttachmentSizeLimitConfig.typeConfigId @unique` 的差异在单表里只能靠应用层守,失去 DB 级约束
5. **当前没有强信号触发**:无新增 rule type、无运行 bug、无性能瓶颈;现有 e2e 已完整覆盖 override-with-default 路径

---

## 5. Why not extract facade now

抽 `AttachmentConfigPolicyService` facade 让 `attachments.service.ts` 不直接读三表,在理论上降低未来 schema 演进成本,但**当前不做**,原因:

- **耦合是真实的,但耦合点集中**:`attachments.service.ts` 直读三表只有 3 个 private 方法(`assertOwnerTypeAllowed` / `assertMimeAllowed` / `assertSizeAllowed`),共 ~60 LOC
- **e2e 覆盖已经足够**:`attachments.upload.e2e-spec.ts`(613 LOC)+ `attachments.e2e-spec.ts`(988 LOC)已 characterize 三表读取 + override + fallback + fail-close MIME + fail-open size 全部路径
- **抽 facade 引入新间接层但当前没有 schema 变更计划**:facade 的价值在 schema 真要演进时才显现;现在抽是预设性工程
- **未来路径**:若未来确实要改 schema / 合表,**先**补 facade characterization(在现有 e2e 之外再加 unit-level pin),**再**抽 facade,**最后**才改 schema;次序不能颠倒

---

## 6. Governance rules

新增附件配置规则前,**先**判断属于哪一类:

| 需求形态 | 落点 |
|---|---|
| 新增一个 owner type(如 `'training-material'`)| 新增一条 `AttachmentTypeConfig` 行(seed 或 admin POST);**不动 schema** |
| 调整某 type 的默认 MIME 白名单 | 更新 `AttachmentTypeConfig.defaultMimeWhitelist` 数组 |
| 为某 type 加单条 MIME override(独立 status / remark)| 新增一条 `AttachmentMimeConfig` 行 |
| 调整某 type 的默认 size 上限 | 更新 `AttachmentTypeConfig.defaultMaxSizeBytes` |
| 为某 type 加 size override | 新增一条 `AttachmentSizeLimitConfig` 行 |
| 出现**新的 rule type**(如 retention / PII / virus-scan policy)| **必须先评审**:加列 TypeConfig vs 新建专表 vs 统一 rule model;**禁止**直接再开第四张配置表 |

铁律:

- **不要把 `AttachmentSizeLimitConfig` 补 `status` 字段**,除非有明确产品语义(单条 size override 全局启停)拍板
- **不要直接把三表合并为 rule table**;走 §4 的独立评审
- **runtime 校验必须保持现状语义**:MIME 是 **fail-close**(无配置即拒),size 是 **fail-open**(两个值均 null 即不限)
- **不要新增第二处旁路直读三表的代码路径**;`attachments.service.ts` 是当前唯一 runtime consumer,新增 consumer 时先评审是否抽 facade
- **audit / BizCode / OpenAPI 变更必须独立评审**:三表 audit 走 `attachment.config.change` event + per-table `resourceType`(沿现状),BizCode 段位 13020-13032 已锁
- **修改 active docs(本文)时**,Source references 必须同步更新

---

## 7. Deferred work

下列项**已知存在但本期不做**:

- **不**合表为单一 `AttachmentRule`(沿 §4)
- **不**抽 `AttachmentConfigPolicyService` facade(沿 §5)
- **不**整理 `src/modules/attachment-configs/` 子目录(13 文件平铺,密度可接受)
- **不**改 controller path / API surface(`/api/v2/attachment-*-configs/*` 不动)
- **不**新增 migration(三表 schema 不动)
- **不**改 BizCode 段位 13020-13032
- **不**为 `AttachmentSizeLimitConfig` 补 status 字段
- **不**改 app/mobile surface(三表本来就是 Ops-only)
- **不**把三表写进 App `/api/app/v1/*` 任何端点

如未来确认要做以上任一项,**走独立立项 + 评审**,本文档不构成实施授权。

---

## 8. Source references

代码与测试(权威源,以代码为准):

- [`prisma/schema.prisma`](../prisma/schema.prisma) — `model AttachmentTypeConfig` / `model AttachmentMimeConfig` / `model AttachmentSizeLimitConfig` 定义
- [`src/modules/attachment-configs/`](../src/modules/attachment-configs/) — 三表 CRUD(3 controller / 3 service / 3 dto / 3 select / 1 module)
- [`src/modules/attachments/attachments.service.ts`](../src/modules/attachments/attachments.service.ts) — runtime 三表读取入口(`assertOwnerTypeAllowed` / `assertMimeAllowed` / `assertSizeAllowed`)
- [`test/e2e/attachment-type-configs.e2e-spec.ts`](../test/e2e/attachment-type-configs.e2e-spec.ts)
- [`test/e2e/attachment-mime-configs.e2e-spec.ts`](../test/e2e/attachment-mime-configs.e2e-spec.ts)
- [`test/e2e/attachment-size-limit-configs.e2e-spec.ts`](../test/e2e/attachment-size-limit-configs.e2e-spec.ts)
- [`test/e2e/attachment-configs.audit.e2e-spec.ts`](../test/e2e/attachment-configs.audit.e2e-spec.ts)
- [`test/e2e/attachment-configs.in-use.e2e-spec.ts`](../test/e2e/attachment-configs.in-use.e2e-spec.ts)

历史背景(**仅作历史来源,不作为当前规则**):

- `docs/archive/batches/批次7_attachments_API前评审.md` §4.2-§4.4 — 三表 schema 草案与决议依据
- `docs/archive/batches/批次7_attachments_业务确认稿.md` — 业务方对附件类型/MIME/size 的拍板
- `docs/archive/batches/批次7_provider选型_API前评审.md` — `StorageSettings.mimePolicyMode = INHERIT` 与三表的关系

active 权威源:

- [`AGENTS.md`](../AGENTS.md) — 长期 AI 协作铁律
- [`docs/current-state.md`](current-state.md) — 当前事实
- [`docs/api-surface-policy.md`](api-surface-policy.md) — `/api/v2/*` 长期边界(三表所在 surface)
