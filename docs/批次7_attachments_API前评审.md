# 《批次7_attachments_API前评审稿》(D7-attachments v0.2 局部收口稿)

> **状态**:**v0.2 局部收口稿**(2026-05-14)— **修订原因**:v0.1 草稿([PR #65](https://github.com/BA7IEE/srvf-nest-api/pull/65),squash commit `ebb530e`,2026-05-14)落地 5 项 F 锁 + 9 项 B 锁(沿 D6)+ 16 项 Q 以"本稿建议 / 待评审"形式承载;用户在 v0.1 合并后逐项拍板 16 项,**v0.2 局部收口**结果:**13 项 Q 锁定 / 1 项 Q 挂起(Q12 ADMIN 内置角色)/ 2 项 Q 挂起待 Provider 选型评审(Q14 / Q15)/ 1 项 Q 不冻结建议(Q16 PR 拆分)**;**v1.0 暂不冻结**(留入队同意书条款 / N 时长等业务方进一步澄清后再冻结)。**本 PR 同时修订** `docs/批次7_attachments_API前评审.md` + `CHANGELOG.md` Unreleased 追加一行(沿 D7-RBAC v0.2 / v1.0 / v1.1 收口类 PR 范式;PR #66 未记 CHANGELOG 视为小疏漏不在本 PR 顺手补,避免混入 D7-RBAC 历史修正)。
> **性质**:**D7-attachments 评审稿 v0.2 局部收口**(基于 [批次7_attachments_业务确认稿](批次7_attachments_业务确认稿.md) 11 题 + 5 决议 + C-6 RBAC 已落地能力 + v0.1 草稿撰写 + v0.2 用户逐项拍板 Q1-Q16,锁定 13 项 / 挂起 3 项 / 建议 1 项)。
> **批次号**:批次 7 暂定;正式编号以 **C-7 V2.x 立项 commit** 为准。
> **撰写日期**:2026-05-14(v0.1 / **v0.2**)
> **修订历程**(只在本说明区出现历史措辞):v0.1 草稿(PR #65,squash commit `ebb530e`,2026-05-14)→ **v0.2 局部收口稿**(本 PR,锁定 13 项 Q / 挂起 3 项 / 建议 1 项;不冻结 v1.0)。
> **拍板准绳**:沿 D6 业务确认稿"**不考虑时间周期,只考虑项目稳定和长久**"(D6 §1.2)。
> **接续**:
> - [D6 业务确认稿(PR #45, squash commit `08aa4d7` 的延续)](批次7_attachments_业务确认稿.md)
> - [批次7 业务访谈提纲(PR #44, squash commit `08aa4d7`)](批次7_attachments_业务访谈提纲.md)
> - [批次8 D7-RBAC v1.2 评审稿](批次8_RBAC_API前评审.md)(C-6 已落地;v1.2 Permission code 正则 3-4 段已为本批次提供文档先决条件;PR #66, squash commit `2b934c5`)
> - [v0.9.0 handoff §7.2 / §10.2](handoff/v0.9.0.md)(C-7 启动前置条件)
> - [V2 红线 C-7 / Slow-2](V2红线与复活路径.md)(attachments 复活硬前置)
> - [docs/srvf-foundation-baseline.md §1.1](srvf-foundation-baseline.md)(BizCode 段位 `130xx` + `131xx` 已预留)
> - [ARCHITECTURE.md §9 / §12](../ARCHITECTURE.md)(升级路径与 V2 蓝图)
> **风格参照**:[批次8_RBAC_API前评审.md](批次8_RBAC_API前评审.md)(D7 评审稿正典)/ [批次6_audit_logs_API前评审.md](批次6_audit_logs_API前评审.md)
> **核心**(v0.2 局部收口;5 项 F + 9 项 B + 13 项 Q 已锁;3 项 Q 挂起;1 项 Q 建议不冻结):
> - **F1 锁** Permission code 正则放宽到 **3-4 段**(`/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/`);D7-RBAC v1.2 修订 PR 已合入(PR #66, squash commit `2b934c5`);**本稿不改代码**(实际 `CODE_PATTERN` 放宽留 C-7 实施 PR #1)
> - **F2 锁** Provider **不实装**(D7 仅落地元数据 + API 契约;Provider 选型独立评审稿同期推进)
> - **F3 锁** attachments 入口 Guard = **仅 `JwtAuthGuard`**;判权全部在 Service 层 `rbac.can()`(attachments 是 0 → 1 接入 RBAC 的范本)
> - **F4 锁** 配置三表 CRUD 入口 = **`@Roles(SUPER_ADMIN, ADMIN)`**(不为配置三表新增 `rbac.config.*` 权限点)
> - **F5 锁** 段位沿 baseline §1.1 = **`130xx` + `131xx`**(attachments 主模块 + 配置三表共用 200 个号位)
> - **v0.2 新锁 13 项 Q**:Q1 复用 attachments + ownerType=activity + subType 标识 cover(不改 Activity schema)/ Q2 accessLevel = hint+索引(RBAC 单一权威)/ Q3 tags = `String[]`(不建关联表)/ Q4 uploadedBy = User.id / Q5 ownerType 双层校验(**业务层 enum 硬编码作为代码防错边界 + 配置表作为运行时可配置白名单**)/ Q6 checksum/etag 不进普通出参 / Q7 PATCH metadata 不审计 / Q8 退队 `status=DISABLED ≥ N + 后台提示`(**N 待业务确认**,不自动删除)/ Q9 `ATTACHMENT_PII_DETECTED=13015` 预留 / Q10 activity 不分 self/other / Q11 **20 条 `attachment.*` 权限点清单 v0.2 锁定**(实际 seed 留实施 PR)/ Q13 系统级 MIME 黑名单(**D7 设计清单,不在 v0.2 承诺最终安全清单;后续 Provider 选型/安全评审可追加**)
> - **v0.2 挂起 1 项**:Q12 ADMIN 内置角色自动持所有 `.other`(影响 RBAC seed/bootstrap + 业务管理员默认能力,待权限点清单 + 业务管理员边界确认后再锁)
> - **v0.2 挂起待 Provider 选型 2 项**:Q14 上传策略 / Q15 删除策略
> - **v0.2 不冻结 1 项**:Q16 PR 拆分(沿 §13 9-11 PR 建议,不冻结最终数量)

---

## 0. 前置启动门槛(已通过)

沿 [v0.9.0 handoff §7.2 / §0 / §10.2](handoff/v0.9.0.md) 与 PR #45 决议 1:

| 前置项 | 状态 |
|---|---|
| C-6 RBAC PR #1-#11 全部合入 main | ✅(v0.9.0 已收口,2026-05-14) |
| `package.json` / Swagger `setVersion('0.9.0')` | ✅ |
| `v0.9.0` git tag 已打 | ✅(tag 指向 squash commit `27b6fcd`,2026-05-14) |
| GitHub Release `v0.9.0` Latest 已发 | ✅(`v0.9.0 — C-6 RBAC V2.x full implementation`,2026-05-14T13:33:38Z) |

**结论**:C-7 attachments D7 v0.1 启动门槛**全部通过**,本稿可正式撰写。

---

## 1. 前置业务确认结果(沿 D6 §二 11 题 + §三 5 决议)

### 1.1 D6 11 题拍板汇总(沿 [批次7_attachments_业务确认稿.md §二](批次7_attachments_业务确认稿.md))

| Q | 内容 | 拍板 | 本稿落地章节 |
|---|---|---|---|
| 1 | 第一批附件场景 | A(队员证件照) + 增"活动发布封面" | §2.1 启用场景 1-4 / 延后 5-6 |
| 2 | 附件元数据字段集 | 13 字段全加(基础 8 + 额外 7;实际 Prisma 列 17-18 含主键时间戳) | §4.1 attachments 主表 schema |
| 3 | 附件归属对象数 | A 单归属 1:N | §4.1 / §4.7(无单议题) |
| 4 | 附件归属实现 | A 多态外键(`ownerType` + `ownerId`) | §4.1 / §6.3 Service 层校验 |
| 5 | 附件删除策略 | B 硬删除 | §4.1 无 deletedAt / §6.4 删除矩阵 |
| 6 | 谁能上传 | 走 RBAC(三轮澄清后) | §6.1 权限点 / §6.2 调用点 |
| 7 | 谁能查看(三问) | 走 RBAC + 最低合规版 | §6.1 / §9 合规口径 |
| 8a | 单文件最大尺寸 | F 按附件类型分级 | §4.4 attachment_size_limit_config |
| 8b | 允许的 MIME | DB 表 + CRUD API | §4.3 attachment_mime_config |
| 8c | 病毒扫描 | A 不做 | §3 本批次不做 / §11 风险声明 |
| 9 | 保存期限/合规/加密 | 最低合规版 | §9 合规口径 |
| 10 | Certificate.attachmentKey 占位字段 | B 废弃 | §4.6 废弃 migration |
| 11 | 与 member_profiles / events 耦合 | A 三者独立 | §3 本批次不做 / §15 关联说明 |

### 1.2 D6 5 条新增决议(沿 [批次7_attachments_业务确认稿.md §三](批次7_attachments_业务确认稿.md))

| # | 决议 | 本稿处理 |
|---|---|---|
| 1 | C-6 RBAC 先行 → C-7 attachments 跟进 | ✅ 已达成(v0.9.0 收口);本稿是 C-6 落地后第一个业务接入 |
| 2 | RBAC 模型 = 完整 4 表(`RbacRole` + `Permission` + `RolePermission` + `UserRole`) | ✅ 已落地;本稿沿 D7-RBAC v1.1 接入(§6 RBAC 集成方案) |
| 3 | 配置三表(`attachment_type_config` / `attachment_mime_config` / `attachment_size_limit_config`)+ CRUD API 与 attachments 同批次 | §4.2-§4.4 schema 草案 + §5.2 配置三表 CRUD 路径 |
| 4 | 最低合规版 | §9 合规口径(Provider SSE-S3 默认透明加密 + ADMIN 手动清理 + 同意书措辞 + 救援派遣) |
| 5 | Provider 选型独立评审 | ✅ 本稿不决议 Provider;§3 本批次不做 / §17 与 Provider 选型评审稿同期推进 |

### 1.3 D6 留 D7 细化项(v0.2 状态)

| D6 留项 | 本稿落地章节 | v0.2 状态 |
|---|---|---|
| Q1:活动封面是复用 attachments 还是单独 Activity.coverImageUrl | §15.2 | 🔒 v0.2 锁(Q1):**复用 attachments + ownerType=activity + subType 标识 cover**;**不改 Activity schema**(沿 A-2) |
| Q2:每字段可空性 / 默认值 / 是否进入入参 DTO | §4.1 attachments 主表逐字段表 | 🔒 v0.2 锁字段集 + 字段细节;v1.0 实施期可再微调 |
| Q2:`accessLevel` 与 RBAC 关系 | §6.5 | 🔒 v0.2 锁(Q2):**hint + 索引,实际权限走 RBAC 单一权威源** |
| Q2:`tags` 实现方式 | §4.1 / §15.3 | 🔒 v0.2 锁(Q3):**`String[]` PG 原生数组**(不建关联表) |
| Q2:`uploadedBy` 指向 User.id / Member.id | §4.1 / §15.4 | 🔒 v0.2 锁(Q4):**User.id** |
| Q4:ownerType 枚举来源(配置表 vs 业务层 enum) | §4.2 / §6.3 | 🔒 v0.2 锁(Q5):**业务层 enum 硬编码作为代码防错边界 + 配置表作为运行时可配置白名单**;二层校验 |
| Q5:业务对象软/硬删 + 附件主动删的三场景矩阵 | §6.4 删除矩阵 | 🔒 v0.2 锁矩阵 |
| Q5:`attachment.delete` audit_logs 事件命名 | §7 audit 集成 | 🔒 v0.2 锁(沿路线 A 单事件名 + extra) |
| Q5:Provider versioning 启用方案 | §3 本批次不做(留 Provider 选型评审);§9.3 合规口径占位 | ⏸ 挂起待 Provider 选型(沿 v0.1 决议 5) |
| Q7:身份证 OCR 不调用的技术保证 | §9.4 技术承诺 | 🔒 v0.2 锁(不调用 OCR;Service 层 PII 检测拒绝) |
| Q7:退队"6 个月 / 2 年"触发条件 | §9.5 | 🔒 v0.2 锁(Q8):**`Member.status=DISABLED` ≥ N + 后台提示;不自动删除**;**N 待业务确认** |
| Q7:ADMIN 手动清理 UI 路径 | §9.5(后端 API 即 `DELETE /api/v2/attachments/:id`;后台 UI 由独立前端项目对接) | 🔒 v0.2 锁 |
| Q8a:各类型初始默认尺寸阈值 | §4.4 / §10 配置三表初始 seed(沿 D6 表初始候选阈值;运行时可改) | 🔒 v0.2 锁初始候选;运行时由配置三表 CRUD 调整 |
| Q8b:`attachment_mime_config` 表 schema | §4.3 | 🔒 v0.2 锁 schema 草案;具体字段 v1.0 / 实施期细化 |
| Q8b:"永久禁"清单 | §6.6 系统级 MIME 黑名单(代码硬编码) | 🔒 v0.2 锁(Q13):D7 设计清单;Provider 选型 / 安全评审可追加 |
| Q9:入队同意书条款草案 | §9.6(v0.1 占位;v1.0 由维护者提供后冻结) | ⏳ 留 v1.0 冻结(维护者提供条款) |
| Q10:Certificate.attachmentKey 废弃 migration | §4.6 | 🔒 v0.2 锁(沿 D6 Q10 B) |
| Q11:attachments 不为 `member_profiles` / `events` 预留特殊字段 | ✅ 沿决议(§3 本批次不做;`ownerType` 通过配置表扩展) | 🔒 v0.2 锁(沿 D6 Q11 A) |

---

## 2. 本批次目标

### 2.1 启用场景 1-4(沿 D6 Q1)

| # | 场景 | ownerType 候选 | 说明 |
|---|---|---|---|
| 1 | 队员证件照(身份证) | `member` | 高敏感;沿 Q7 三问表(本人 + ADMIN + APD 部长可见) |
| 2 | 队员证件照(急救/潜水/培训证) | `certificate` | 中敏感;沿 Q7 三问表;与 `Certificate` 模型关联(替代废弃的 `Certificate.attachmentKey`) |
| 3 | 活动现场照 | `activity` | 低敏感;本队队员可见 |
| 4 | 活动发布封面 | `activity` | 低敏感;本质公开展示 |

**延后场景**(沿 D6 Q1 AI 建议 a + 决议 5):
- 5. 培训资料:`TrainingMaterial` 业务模型未建,延后
- 6. 装备图:`Equipment` 业务模型未建,延后

### 2.2 实施物清单

1. 新增 1 个主表:`Attachment`(§4.1)
2. 新增 3 个配置表:`AttachmentTypeConfig` / `AttachmentMimeConfig` / `AttachmentSizeLimitConfig`(§4.2-§4.4)
3. 新增 1 个 migration 废弃字段:`Certificate.attachmentKey` 删除列(§4.6)
4. 新增 1 个 NestJS 模块 `attachments/`:8 文件(主体 4 + select + types + storage interface 引用 + DTO 子目录)
5. 新增 1 个 NestJS 模块 `attachment-configs/`(或并入 `attachments/`,**v1.0 实施期决定**):配置三表 CRUD
6. 新增 22 个 API 端点(attachments × 7 + 配置三表 × 5 × 3;沿 §5.3 总计)
7. 新增 attachment 权限点 **20 条**(沿 §6.1;**Q11 v0.2 已锁清单,实际 seed 落地由 C-7 实施 PR 完成**)
8. 新增 BizCode 段位 `130xx` + `131xx` 子段(§8)
9. 新增 `AuditLogEvent` union +3 项:`attachment.upload` / `attachment.delete` / `attachment.config.change`(§7)
10. **v1 14 接口 + V2 79 接口 + RBAC 16 接口 zero drift**(A-2 红线)
11. **Permission code 正则放宽** 3-4 段;**实施 PR #1 内变更**;本稿基于 D7-RBAC v1.2 修订 PR(纯 docs)先行的前提

### 2.3 不动 RBAC 14 RBAC CRUD 接口

C-6 RBAC 落地 16 个 RBAC CRUD 端点入口仍 `@Roles(SUPER_ADMIN, ADMIN)`(沿 v0.9.0 §5);**本稿不接入**这 14 个端点到 `rbac.can()`。RBAC CRUD 自身判权迁出留独立 PR(沿 v0.9.0 §7.3 Slow-3 / Slow-4)。

---

## 3. 本批次不做

沿 D6 §五 + v0.9.0 §5 + V2 §18,以下事项 **v0.1 / 实施期不做**:

- ❌ **不实装 Provider**(F2 锁;沿 D6 决议 5):不实装 LocalStorageProvider / S3 / OSS / R2 / 七牛 / MinIO / Garage 等;`src/common/storage/` 保持仅 interface + types
- ❌ **不实装真上传 / 真下载**:attachments 实施期上传接口落库元数据 + 返签名 URL 占位 / 直传 URL 占位(Provider 接通后由独立 PR 接入);下载接口返 metadata + 占位 URL
- ❌ **不做病毒扫描**(沿 D6 Q8c A)
- ❌ **不做加密 KMS**(沿 D6 Q9 决议 4 最低合规版;Provider SSE-S3 默认透明加密由 Provider 选型评审决议)
- ❌ **不做自动清理脚本**(沿决议 4;ADMIN 手动清理)
- ❌ **不做 OCR**(沿 Q7 合规;身份证号永远图像形态,DB / API 不出现字符串)
- ❌ **不做秒传 / checksum 唯一约束**(checksum 字段存,但本期不开 unique index)
- ❌ **不做附件本身有效期触发清理**(`expireAt` 字段存,但 v1 不做主动过期清理 / 不做提醒 hook)
- ❌ **不做 tags 关联表 / tags 全局 CRUD**(沿 Q6 推荐 `String[]`)
- ❌ **不修改 `prisma/seed.ts` 加 attachment 真实业务角色权限映射**:`attachment.*` 权限点 seed 由 attachments 实施期 PR 落地;`role-a..role-f` 真实业务角色仍走 `.env.seed.local`(沿 v0.9.0 §5 + D7-RBAC F6 / R13)
- ❌ **不动 v1 14 接口 / V2 79 接口 / RBAC 16 接口的任何字段 / 路径 / 权限标注 / 出参 DTO**(A-2 红线)
- ❌ **不动 RBAC 14 RBAC CRUD 入口 Guard**(沿 §2.3;留独立 PR)
- ❌ **不为 attachments / 配置三表写真实角色 seed**(沿 D6 决议 1 / R13)
- ❌ **不引入 Redis / 队列 / 定时任务**(沿 V1.1 §17.3)
- ❌ **不动 `prisma/schema.prisma`**(本 v0.1 阶段仅 markdown 中展示 Prisma DSL 草案;v0.2 / v1.0 冻结后由 attachments 实施 PR #1 落 schema)
- ❌ **不修改 baseline §1.1**(`130xx + 131xx` v0.5.0 段位早已预留,本稿仅引用并细化子段位)
- ❌ **不修改 D7-RBAC v1.1 评审稿**(正则放宽走 D7-RBAC **v1.2** 独立修订 PR 先行;本稿不动该评审稿)
- ❌ **不为 attachments 模块新增 Redis / cluster / 分布式锁**

---

## 4. schema 草案

> **注意**:本节 Prisma DSL 仅作 v0.1 设计展示;**不修改** `prisma/schema.prisma` 文件本身。v1.0 冻结 + 实施 PR 才会动 schema 文件。

### 4.1 Attachment 主表(13 字段;沿 D6 Q2 全字段)

```prisma
model Attachment {
  id        String    @id @default(cuid())
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  // 沿 D6 Q5 B 硬删除:无 deletedAt;§6.4 矩阵明确"业务对象软删时 attachment 不动 / 主动删 = 物理删"

  // ===== 基础字段(沿 research §2.4 + D6 Q2) =====
  key                   String   // Provider 侧文件唯一引用;长度 ≤ 256
  originalName          String   // 原始文件名(带扩展名);长度 ≤ 255
  mime                  String   // MIME 类型;长度 ≤ 128;走 attachment_mime_config 白名单
  size                  Int      // 文件大小(字节);非负;走 attachment_size_limit_config 上限
  uploadedBy            String   // v0.2 锁(Q4):User.id(沿 V2 createdBy / publishedBy 风格;管理员账号上传时也能落库)
  uploadedAt            DateTime @default(now())

  // ===== 多态归属(沿 D6 Q3 A + Q4 A) =====
  ownerType             String   // 归属业务对象类型;走 attachment_type_config 白名单
  ownerId               String   // 归属对象 cuid

  // ===== 额外字段(沿 D6 Q2"全部加上") =====
  checksum              String?  // SHA-256(64 hex 字符);本期不做 unique index
  etag                  String?  // Provider 侧版本号;本期仅存,不约束格式
  description           String?  // 用户备注;长度 ≤ 500
  accessLevel           AttachmentAccessLevel?  // v0.2 锁(Q2):hint + 索引;实际权限走 RBAC 单一权威源
  tags                  String[] // v0.2 锁(Q3):PG 原生数组;本期不做关联表 / tag 全局 CRUD
  originalUploaderName  String?  // 冗余存上传者人名;长度 ≤ 50
  expireAt              DateTime?  // 附件本身有效期;本期不做主动清理 / 提醒

  uploader User @relation("AttachmentUploader", fields: [uploadedBy], references: [id], onDelete: Restrict)

  @@index([ownerType, ownerId])  // 业务查询主路径:列出某业务对象的所有附件
  @@index([uploadedBy])
  @@index([mime])                 // 按 MIME 筛选(后台用)
  @@index([createdAt])
  @@index([accessLevel])          // v0.2 锁(Q2):hint 索引保留
  @@map("attachments")
}

enum AttachmentAccessLevel {
  PUBLIC     // 公开;沿 Q7 活动封面 / 培训资料
  INTERNAL   // 内部;沿 Q7 活动现场照
  SENSITIVE  // 敏感;沿 Q7 队员证件照
}
```

**逐字段说明 + 校验铁律**(配套 DTO 层 class-validator;沿 baseline §6):

| 字段 | 入参 DTO 校验 | 出参可见性 |
|---|---|---|
| `key` | `@IsString() @MaxLength(256)`;Provider 命名规范由 Provider 选型评审决议 | 受限(仅 ADMIN / 本人 / RBAC `attachment.view.*.{self,other}` 命中者) |
| `originalName` | `@IsString() @MaxLength(255)`;不强制 trim(保留用户原名带空格场景) | 公开(配套 RBAC view) |
| `mime` | `@IsString() @MaxLength(128)` + Service 层走 `attachment_mime_config` 白名单 | 公开 |
| `size` | `@IsInt() @Min(0)` + Service 层走 `attachment_size_limit_config` 上限 | 公开 |
| `uploadedBy` | **不入入参 DTO**;Service 层从 `currentUser.id` 注入 | 公开 |
| `uploadedAt` | **不入入参 DTO**;`@default(now())` | 公开 |
| `ownerType` | `@IsString() @MaxLength(64)` + Service 层走 `attachment_type_config` 白名单 + 系统级业务 enum 二层兜底 | 公开 |
| `ownerId` | `@IsString() @Length(8, 64)`(沿 v1 §11 IdParamDto 风格)+ Service 层校验真实指向 | 公开 |
| `checksum` | `@IsOptional() @IsString() @Length(64, 64)`;客户端可不传(本期不强制) | **v0.2 锁(Q6)**:内部字段,不进普通出参 DTO;管理员详情 / 调试接口若需可见,**留 v1.0 实施期再评审** |
| `etag` | `@IsOptional() @IsString() @MaxLength(128)` | **v0.2 锁(Q6)**:内部字段,同 `checksum` |
| `description` | `@IsOptional() @IsString() @MaxLength(500)` | 公开 |
| `accessLevel` | `@IsOptional() @IsEnum(AttachmentAccessLevel)` | 公开 |
| `tags` | `@IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(32, { each: true })` | 公开 |
| `originalUploaderName` | **不入入参 DTO**;Service 层从 `currentUser` 注入(优先 displayName / fallback username) | 公开 |
| `expireAt` | `@IsOptional() @IsISO8601()` | 公开 |

### 4.2 AttachmentTypeConfig(沿决议 3)

```prisma
model AttachmentTypeConfig {
  id           String                       @id @default(cuid())
  code         String                       @unique  // ownerType code;如 'member' / 'certificate' / 'activity'
  displayName  String                       // 后台 UI 显示名
  description  String?
  // ===== 关联业务表名(用于 Service 层 ownerId 真实性校验) =====
  ownerTable   String                       // Prisma model 名小写;如 'member' / 'certificate' / 'activity'
  // ===== 默认配置(覆盖至 mime / size 表为空时的兜底) =====
  defaultMaxSizeBytes  Int?                 // 默认单文件大小上限;null 走全局兜底
  defaultMimeWhitelist String[]             // 默认允许 MIME 列表
  // ===== 启停 =====
  status    AttachmentTypeConfigStatus      @default(ACTIVE)
  createdAt DateTime                        @default(now())
  updatedAt DateTime                        @updatedAt
  deletedAt DateTime?                       // 沿 baseline §2.1 软删

  mimeOverrides AttachmentMimeConfig[]
  sizeOverrides AttachmentSizeLimitConfig[]

  @@index([status])
  @@index([deletedAt])
  @@map("attachment_type_configs")
}

enum AttachmentTypeConfigStatus {
  ACTIVE
  INACTIVE
}
```

**初始 seed 候选**(沿 D6 Q1 启用场景 1-4;`.env.seed.local` 不需要,公开 seed 即可):

| code | displayName | ownerTable | defaultMaxSizeBytes | defaultMimeWhitelist |
|---|---|---|---|---|
| `member` | 队员证件照(身份证) | `member` | 5_242_880 (5 MiB) | `['image/jpeg', 'image/png', 'image/heic', 'image/webp']` |
| `certificate` | 队员证件照(急救/潜水/培训证) | `certificate` | 5_242_880 | `['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf']` |
| `activity` | 活动现场照 / 活动封面 | `activity` | 10_485_760 (10 MiB) | `['image/jpeg', 'image/png', 'image/heic', 'image/webp']` |

### 4.3 AttachmentMimeConfig(覆盖默认白名单)

```prisma
model AttachmentMimeConfig {
  id             String   @id @default(cuid())
  typeConfigId   String
  mime           String   // 如 'image/jpeg' / 'application/pdf'
  status         AttachmentMimeConfigStatus @default(ACTIVE)
  remark         String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  deletedAt      DateTime?

  typeConfig AttachmentTypeConfig @relation(fields: [typeConfigId], references: [id], onDelete: Restrict)

  @@unique([typeConfigId, mime])  // 同一 type 下 mime 不重复
  @@index([typeConfigId])
  @@index([status])
  @@index([deletedAt])
  @@map("attachment_mime_configs")
}

enum AttachmentMimeConfigStatus {
  ACTIVE
  INACTIVE
}
```

**说明**:此表覆盖 `AttachmentTypeConfig.defaultMimeWhitelist`;运行时白名单 = `mimeOverrides` 中 status=ACTIVE 的 mime 集合(若该 type 有 override);否则用 `defaultMimeWhitelist`。具体查询语义在 §10 attachments 实施 PR 期决议。

### 4.4 AttachmentSizeLimitConfig(覆盖默认尺寸)

```prisma
model AttachmentSizeLimitConfig {
  id             String   @id @default(cuid())
  typeConfigId   String   @unique  // 1:1 with AttachmentTypeConfig(每 type 至多一条 override)
  maxSizeBytes   Int      // 覆盖 AttachmentTypeConfig.defaultMaxSizeBytes
  remark         String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  deletedAt      DateTime?

  typeConfig AttachmentTypeConfig @relation(fields: [typeConfigId], references: [id], onDelete: Restrict)

  @@index([deletedAt])
  @@map("attachment_size_limit_configs")
}
```

**说明**:1:1 关系简化语义;若运营需要"按 MIME 子分类设不同上限"(如 image vs PDF),走 §17 升级路径。

### 4.5 与现有 User / Certificate / Activity / Member 的关系

```prisma
model User {
  // 现有字段不变(A-2 红线)
  // 新增反向 relation(仅 Prisma DSL,DB schema 无新字段)
  attachmentsUploaded Attachment[] @relation("AttachmentUploader")
}
```

`Certificate` / `Activity` / `Member` **不加反向 relation**:多态外键无 DB FK,业务对象侧通过 Service 层 `attachments.findByOwner(ownerType, ownerId)` 查询(避免 4 处反向 relation 膨胀 + 与多态语义冲突)。

### 4.6 Certificate.attachmentKey 字段废弃 migration(沿 D6 Q10 B)

实施 PR(attachments 主模块同 PR 末尾;沿 D6 Q10 时机):

```sql
-- 同 PR 的 migration.sql:
ALTER TABLE "certificates" DROP COLUMN "attachment_key";
```

Prisma schema 同步删除:

```prisma
model Certificate {
  // ... 现有字段 ...
  // attachmentKey String?  // ← 删除此行(CT-10 v0.3.0 占位字段)
}
```

`certificates.select.ts` / `CertificateResponseDto` 同步删除 `attachmentKey` 字段(沿 D6 Q10 影响范围;contract snapshot 预期变更:`Certificate.attachmentKey` 从 OpenAPI 消失)。

**迁移成本**:历史数据全 NULL(沿 v0.3.0 批次 2 R12 锁定 attachmentKey 始终 NULL),drop column 零数据迁移;e2e 需更新 1-2 处对 `attachmentKey` 字段的断言(沿 batch 2 收口测试)。

### 4.7 索引 / FK / 约束总结

| Prisma model | DB 表名 | 索引 | UNIQUE | FK |
|---|---|---|---|---|
| `Attachment` | `attachments` | `(ownerType, ownerId)` / `uploadedBy` / `mime` / `createdAt` / `accessLevel` | — | `uploadedBy → User.id` Restrict;**无 ownerType+ownerId FK**(多态;Service 校验) |
| `AttachmentTypeConfig` | `attachment_type_configs` | `status` / `deletedAt` | `code` | — |
| `AttachmentMimeConfig` | `attachment_mime_configs` | `typeConfigId` / `status` / `deletedAt` | `(typeConfigId, mime)` | `typeConfigId → AttachmentTypeConfig.id` Restrict |
| `AttachmentSizeLimitConfig` | `attachment_size_limit_configs` | `deletedAt` | `typeConfigId` | `typeConfigId → AttachmentTypeConfig.id` Restrict |

---

## 5. API 草案

### 5.1 attachments 主模块路径清单(7 端点)

| # | 方法 | 路径 | 用途 | 入口 Guard | Service 层判权 |
|---|---|---|---|---|---|
| 1 | POST | `/api/v2/attachments` | 创建附件元数据(Provider 接通前)/ 上传(Provider 接通后) | `JwtAuthGuard` | `rbac.can('attachment.upload.<type>.{self,other}', resource)` |
| 2 | GET | `/api/v2/attachments` | 列表(分页;管理后台用;按 ownerType / ownerId / uploadedBy / mime / accessLevel / tags 筛) | `JwtAuthGuard` | `rbac.can('attachment.view.<type>.{self,other}', resource)`;non-RBAC 用户走 self 路径 |
| 3 | GET | `/api/v2/attachments/:id` | 单条详情(含签名 URL 占位 / 实际 URL 由 Provider 接通后接通) | `JwtAuthGuard` | 同上 |
| 4 | PATCH | `/api/v2/attachments/:id` | 更新元数据(允许字段:`description` / `accessLevel` / `tags` / `expireAt`) | `JwtAuthGuard` | `rbac.can('attachment.update.<type>.{self,other}', resource)`(v0.2 沿 §6.1 20 条权限点穷举;具体角色映射 v1.0 实施期细化) |
| 5 | DELETE | `/api/v2/attachments/:id` | 硬删除(沿 Q5 B);Provider 接通后联动删物理文件 | `JwtAuthGuard` | `rbac.can('attachment.delete.<type>.{self,other}', resource)` |
| 6 | GET | `/api/v2/attachments/by-owner` | 列出某业务对象的全部附件;query: `ownerType`+`ownerId`(业务模块常用入口) | `JwtAuthGuard` | 同 GET 列表(逐条 ownership 过滤) |
| 7 | GET | `/api/v2/attachments/me/uploaded` | 本人上传的附件列表 | `JwtAuthGuard` | 自动按 `uploadedBy = currentUser.id` 筛(不需要 RBAC;沿"本人查自己"豁免) |

**入口 Guard 统一 `JwtAuthGuard`**(F3 锁;**不加** `@Roles(...)`);**所有判权在 Service 层 `rbac.can()`**。

### 5.2 配置三表 CRUD 路径清单(每表 5 端点 × 3 = 15 端点)

#### 5.2.1 AttachmentTypeConfig × 5

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| 8  | GET    | `/api/v2/attachment-type-configs` | 列表(分页) |
| 9  | GET    | `/api/v2/attachment-type-configs/:id` | 详情 |
| 10 | POST   | `/api/v2/attachment-type-configs` | 创建 |
| 11 | PATCH  | `/api/v2/attachment-type-configs/:id` | 更新 |
| 12 | DELETE | `/api/v2/attachment-type-configs/:id` | 软删(沿 baseline §2.1) |

#### 5.2.2 AttachmentMimeConfig × 5

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| 13 | GET    | `/api/v2/attachment-mime-configs` | 列表(分页;可按 typeConfigId 筛) |
| 14 | GET    | `/api/v2/attachment-mime-configs/:id` | 详情 |
| 15 | POST   | `/api/v2/attachment-mime-configs` | 创建 |
| 16 | PATCH  | `/api/v2/attachment-mime-configs/:id` | 更新 |
| 17 | DELETE | `/api/v2/attachment-mime-configs/:id` | 软删 |

#### 5.2.3 AttachmentSizeLimitConfig × 5

| # | 方法 | 路径 | 用途 |
|---|---|---|---|
| 18 | GET    | `/api/v2/attachment-size-limit-configs` | 列表(分页;可按 typeConfigId 筛) |
| 19 | GET    | `/api/v2/attachment-size-limit-configs/:id` | 详情 |
| 20 | POST   | `/api/v2/attachment-size-limit-configs` | 创建 |
| 21 | PATCH  | `/api/v2/attachment-size-limit-configs/:id` | 更新 |
| 22 | DELETE | `/api/v2/attachment-size-limit-configs/:id` | 软删 |

**配置三表入口 Guard 统一 `@Roles(SUPER_ADMIN, ADMIN)`**(F4 锁)。

### 5.3 端点总计

| 模块 | 端点数 |
|---|---|
| attachments 主模块 | 7 |
| 配置三表 CRUD | 15 |
| **总计** | **22** |

实施 PR 完成后 contract snapshot 增量:**+22 路由 + ~20 DTO**(粗估;具体由实施 PR 落地)。

### 5.4 入参 / 出参 DTO 框架(关键字段;v0.2 细化)

#### 5.4.1 CreateAttachmentDto

```typescript
export class CreateAttachmentDto {
  @ApiProperty() @IsString() @MaxLength(256)
  key!: string;

  @ApiProperty() @IsString() @MaxLength(255)
  originalName!: string;

  @ApiProperty() @IsString() @MaxLength(128)
  mime!: string;

  @ApiProperty() @IsInt() @Min(0)
  size!: number;

  @ApiProperty() @IsString() @MaxLength(64)
  ownerType!: string;

  @ApiProperty() @IsString() @Length(8, 64)
  ownerId!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Length(64, 64)
  checksum?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128)
  etag?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: AttachmentAccessLevel })
  @IsOptional() @IsEnum(AttachmentAccessLevel)
  accessLevel?: AttachmentAccessLevel;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(20)
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional() @IsOptional() @IsISO8601()
  expireAt?: string;
}
```

**禁止字段**(白名单严格):`id` / `uploadedBy` / `uploadedAt` / `originalUploaderName` / `createdAt` / `updatedAt`(沿 baseline §4.1;`forbidNonWhitelisted` 兜底)。

#### 5.4.2 UpdateAttachmentDto(PATCH /:id)

仅允许字段:`description` / `accessLevel` / `tags` / `expireAt`(沿 §5.1 PATCH 路由说明)。

#### 5.4.3 ListAttachmentsQueryDto

```typescript
export class ListAttachmentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64)
  ownerType?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Length(8, 64)
  ownerId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Length(8, 64)
  uploadedBy?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(128)
  mime?: string;

  @ApiPropertyOptional({ enum: AttachmentAccessLevel })
  @IsOptional() @IsEnum(AttachmentAccessLevel)
  accessLevel?: AttachmentAccessLevel;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];  // 含任意 tag 即命中(OR 语义;v0.2 决议)
}
```

#### 5.4.4 AttachmentResponseDto(出参)

```typescript
export class AttachmentResponseDto {
  id!: string;
  key!: string;
  originalName!: string;
  mime!: string;
  size!: number;
  uploadedBy!: string;
  uploadedAt!: string;
  ownerType!: string;
  ownerId!: string;
  description!: string | null;
  accessLevel!: AttachmentAccessLevel | null;
  tags!: string[];
  originalUploaderName!: string | null;
  expireAt!: string | null;
  createdAt!: string;
  updatedAt!: string;
  // **不出参**(v0.2 锁(Q6)):checksum / etag 为内部字段;管理员详情 / 调试接口若需可见,留 v1.0 实施期再评审
}
```

#### 5.4.5 配置三表 DTO

沿 §5.4.1 风格,字段简单。v0.2 细化。

### 5.5 上传接口契约(Provider 接通前)

**v0.1 锁定**:`POST /api/v2/attachments` 入参不含文件二进制流;**仅落库元数据**。Provider 接通后由独立 PR 接入实际上传策略(multipart / 直传 / 中转;v0.2 / v1.0 不锁)。

**伪流程**(Provider 接通前):

1. 前端预生成 `key`(或调 Provider 选型评审决定的"申请上传 URL"接口拿到 `key`)
2. 前端直传 Provider(Provider 接通后)/ 占位行为:本期跳过
3. 前端调 `POST /api/v2/attachments` 落库元数据,Service 层做:
   - DTO 校验(`forbidNonWhitelisted` + class-validator)
   - `ownerType` 走 `attachment_type_config` 白名单
   - `ownerId` 真实指向 ownerType 对应业务表的活跃记录(未软删)
   - `mime` 走 `attachment_mime_config` / `defaultMimeWhitelist` 白名单
   - `size` 走 `attachment_size_limit_config` / `defaultMaxSizeBytes` 上限
   - `rbac.can(currentUser, 'attachment.upload.<type>.{self,other}', { ownerType, ownerId })`
   - audit 同事务落库(沿 A-17)
4. 返 `AttachmentResponseDto` + 占位 URL 字段(`accessUrl: string | null`;Provider 接通前为 null)

### 5.6 下载接口契约(Provider 接通前)

`GET /api/v2/attachments/:id` 返 metadata + 占位 `accessUrl`(Provider 接通前 null)。Provider 接通后该字段返签名短链(签名机制由 Provider 选型评审决议)。

---

## 6. RBAC 接入方案(沿 F3 + D7-RBAC F5)

### 6.1 attachment.* 权限点穷举(🔒 v0.2 锁定 20 条;Q11)

> **v0.2 锁定**(Q11):**20 条权限点清单冻结**(下表);**实际 seed 落地由 C-7 实施 PR 完成**(沿 D7-RBAC §10.2 范式)。落地启用场景 1-4 的完整穷举;场景 5-6(培训资料 / 装备图)延后。下面按 §2.1 4 场景 × {upload / view / update / delete} × {self / other} 展开。

**说明**:权限点 code 命名沿 D7-RBAC D2 修订后形态 `<module>.<action>.<resource_type>[.<scope>]`,3-4 段;`.self` / `.other` 作为可选 scope 后缀。

| # | 权限点 code | 段数 | module | action | resourceType | scope | 描述 |
|---|---|---|---|---|---|---|---|
| 1 | `attachment.upload.member.self` | 4 | attachment | upload | member | self | 上传本人(member)的身份证类附件 |
| 2 | `attachment.upload.member.other` | 4 | attachment | upload | member | other | 上传他人(member)的身份证类附件 |
| 3 | `attachment.view.member.self` | 4 | attachment | view | member | self | 查看本人身份证类附件 |
| 4 | `attachment.view.member.other` | 4 | attachment | view | member | other | 查看他人身份证类附件 |
| 5 | `attachment.update.member.self` | 4 | attachment | update | member | self | 更新本人身份证类附件元数据(description/tags/...) |
| 6 | `attachment.update.member.other` | 4 | attachment | update | member | other | 更新他人 |
| 7 | `attachment.delete.member.self` | 4 | attachment | delete | member | self | 删除本人身份证类附件 |
| 8 | `attachment.delete.member.other` | 4 | attachment | delete | member | other | 删除他人 |
| 9 | `attachment.upload.certificate.self` | 4 | attachment | upload | certificate | self | 上传本人的证书类附件 |
| 10 | `attachment.upload.certificate.other` | 4 | attachment | upload | certificate | other | 上传他人证书类附件 |
| 11 | `attachment.view.certificate.self` | 4 | attachment | view | certificate | self | 查看本人证书附件 |
| 12 | `attachment.view.certificate.other` | 4 | attachment | view | certificate | other | 查看他人证书附件 |
| 13 | `attachment.update.certificate.self` | 4 | attachment | update | certificate | self | 更新本人证书附件元数据 |
| 14 | `attachment.update.certificate.other` | 4 | attachment | update | certificate | other | 更新他人 |
| 15 | `attachment.delete.certificate.self` | 4 | attachment | delete | certificate | self | 删除本人证书附件 |
| 16 | `attachment.delete.certificate.other` | 4 | attachment | delete | certificate | other | 删除他人证书附件 |
| 17 | `attachment.upload.activity` | 3 | attachment | upload | activity | — | 上传活动现场照 / 封面(活动级,无 self/other 区分;创建者自动可上传) |
| 18 | `attachment.view.activity` | 3 | attachment | view | activity | — | 查看活动现场照 / 封面 |
| 19 | `attachment.update.activity` | 3 | attachment | update | activity | — | 更新活动附件元数据 |
| 20 | `attachment.delete.activity` | 3 | attachment | delete | activity | — | 删除活动附件 |

**段数分布**:4 段 16 条 + 3 段 4 条 = **20 条**;全部能通过修订后正则 `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/`。

**activity 场景为何无 self/other**:活动现场照 / 封面是"组织级"附件,不挂在某个 member 上;ownership 不是"附件本身的归属人",而是"附件归属的业务对象 = Activity";Q4 C 混合 ownership 模型下,Activity 的"本人"语义是"创建者",但实际业务中**任何参加活动的队员**都可能上传现场照、**任何用户**都可能查看封面 — 走粗粒度活动级权限即可,不细化 self/other。

**RBAC 角色映射 placeholder**(v0.2 锁清单,真实角色名仍走 `.env.seed.local`;沿 D7-RBAC F6 / R13):

| 角色 placeholder | 持有权限点 |
|---|---|
| `member`(USER 内置角色 placeholder)| `attachment.upload.member.self` / `attachment.view.member.self` / `attachment.update.member.self` / `attachment.delete.member.self` / `attachment.upload.certificate.self` / `attachment.view.certificate.self` / `attachment.update.certificate.self` / `attachment.delete.certificate.self` / `attachment.view.activity`(8+1=9 条) |
| `role-a`(部门部长 placeholder)| 其本部门下属 member 的 `.other` 权限点(16 条 `.other` 的子集);具体映射沿 .env.seed.local |
| `role-b`(部门副部长 placeholder)| `role-a` 子集(只读) |
| `ops-admin`(运营管理员)| 不持业务权限点(沿 D7-RBAC §10.3;ops-admin 只配 RBAC 自身) |
| `SUPER_ADMIN`(系统级 Role)| 短路通过任何 RBAC 判权 |

`ADMIN`(系统级 Role)默认无 RBAC 角色;**Q12 v0.2 挂起**:是否让 ADMIN 自动持有所有 `.other`(沿 D7-RBAC §7.1 step 2 通过 seed 给 ADMIN 内置角色配 `.other` 权限点)— 此项影响 RBAC seed/bootstrap 与业务管理员默认能力,**等 attachment 权限点清单 + 业务管理员边界进一步确认后再锁**;v0.2 不锁,v1.0 / 实施期再决议。

### 6.2 Service 层 rbac.can() 调用点

每个 Controller 方法在 Service 层入口必调 `await this.rbac.can(currentUser, action, resource)`,失败抛 `BizException(BizCode.RBAC_FORBIDDEN)`(30100;已有)。

**示例:POST /api/v2/attachments(上传)**:

```typescript
async create(dto: CreateAttachmentDto, currentUser: CurrentUserPayload) {
  // 1. 校验 ownerType 在白名单
  const typeConfig = await this.assertOwnerTypeAllowed(dto.ownerType);

  // 2. 校验 ownerId 真实指向 ownerType 对应业务表
  await this.assertOwnerExists(typeConfig.ownerTable, dto.ownerId);

  // 3. 构造 RbacResource(沿 §6.3)
  const resource = this.buildRbacResource(dto.ownerType, dto.ownerId);

  // 4. 判断 scope(self / other)
  const scope = this.detectScope(currentUser, dto.ownerType, dto.ownerId);
  const action = `attachment.upload.${dto.ownerType}${scope ? '.' + scope : ''}`;

  // 5. rbac.can() 判权(自动走 .self 后缀 ownership)
  const allowed = await this.rbac.can(currentUser, action, resource);
  if (!allowed) throw new BizException(BizCode.RBAC_FORBIDDEN);

  // 6. mime / size 白名单校验
  await this.assertMimeAllowed(dto.ownerType, dto.mime);
  await this.assertSizeAllowed(dto.ownerType, dto.size);

  // 7. 事务内:写入 + audit
  return this.prisma.$transaction(async (tx) => {
    const attachment = await tx.attachment.create({ data: { ...dto, uploadedBy: currentUser.id, originalUploaderName: currentUser.displayName ?? currentUser.username } });
    await this.auditLogs.log({
      tx,
      event: 'attachment.upload',
      actorUserId: currentUser.id,
      resourceType: 'attachment',
      resourceId: attachment.id,
      context: { ...meta, extra: { ownerType: dto.ownerType, attachmentType: dto.ownerType, mime: dto.mime, size: dto.size } },
    });
    return this.toResponseDto(attachment);
  });
}
```

### 6.3 RbacResource 构造(沿 D7-RBAC §8.3)

| ownerType | RbacResource | 数据源 |
|---|---|---|
| `member` | `{ ownerType: 'member', ownerId: <Member.id> }` | dto.ownerId 直接传 |
| `certificate` | `{ ownerType: 'member', ownerId: certificate.memberId }` | 先查 Certificate.memberId,再传 |
| `activity` | 无需(`.self` 不触发;走粗粒度判权) | — |

**注意**:RBAC 的 `ownerType: 'user' \| 'member'`(`rbac.service.ts:41`)与 attachment 的 ownerType(`'member' / 'certificate' / 'activity'`)是**不同语义**两套 enum,**禁止复用**。Service 层构造 RbacResource 时显式映射(certificate / activity 都映射到 RBAC `member` 或不传)。

**Q5 v0.2 锁双层校验**(ownerType 枚举来源):
- **业务层 enum 硬编码作为代码防错边界**:`AttachmentOwnerType` TS enum 枚举值(如 `'member' | 'certificate' | 'activity'`),编译期已知,Service 层 + DTO 层引用此 enum,防止程序员误传非法字符串
- **配置表(`attachment_type_config.code`)作为运行时可配置白名单**:权威源,运营可通过 CRUD API 启停 / 新增 type;Service 层校验时**先查配置表**,再用 enum 做二层兜底
- 两者必须**保持同步**:新增业务 ownerType 时,**同时**修改 enum 常量 + 配置表 seed;CI 阶段可写脚本校验"enum 值集合 ⊆ 配置表 code 集合"(实施期 v1.0 决议)

### 6.4 删除矩阵(沿 D6 Q5 + AI 注释)

| 场景 | 行为 |
|---|---|
| `Member.deletedAt` 设置(软删) | attachment **不动**;通过 ownerId 关联仍能查;沿 Q5 AI 建议 |
| `Certificate.deletedAt` 设置(软删) | attachment **不动** |
| `Activity.deletedAt` 设置(软删) | attachment **不动** |
| 业务对象**硬删**(v2 尚无此操作) | 未来若开:attachment **同步硬删**(由业务模块触发) |
| `DELETE /api/v2/attachments/:id`(用户/ADMIN 主动) | DB 元数据物理删 + Provider 文件物理删(**Q15 v0.2 挂起待 Provider 选型评审**:同步阻塞 / 异步重试 / 仅记录告警) |
| audit 行为 | `attachment.delete` 同事务 fail-fast;Provider 删失败的处理策略 **Q15 挂起** |

误删兜底走 Provider versioning(沿 Q5 AI 注释);**versioning 配置 v0.2 不锁**(挂起待 Provider 选型评审)。

### 6.5 accessLevel 与 RBAC 的关系(🔒 Q2 v0.2 锁定)

**v0.2 锁定(Q2)**:`accessLevel` 仅作 **hint + 索引**,实际权限**完全走 RBAC** 单一权威源。

- `accessLevel = SENSITIVE`:不代表"任何人禁查",而代表"业务侧把它标为高敏感";RBAC 配置可决定哪些角色可看
- `accessLevel = PUBLIC`:不代表"无需 RBAC",而代表"业务侧标为公开";Service 层仍调 `rbac.can('attachment.view.<type>')`,但 RBAC 角色配 USER 默认有此权限
- 不存在"`accessLevel = PUBLIC` → 跳过 RBAC"短路,避免双轨制冲突

### 6.6 系统级 MIME 黑名单(🔒 Q13 v0.2 锁:D7 设计清单 / 非配置表)

**v0.2 锁定(Q13)**:**作为 D7 设计清单**承载;**不在 v0.2 承诺最终完整安全清单**;后续 Provider 选型 / 安全评审可追加。沿 D6 Q8b "永久禁"清单 — 即使后台配置也不允许加入白名单。代码硬编码常量:

```typescript
const SYSTEM_MIME_BLOCKLIST = new Set([
  'application/x-msdownload',
  'application/x-executable',
  'application/x-dosexec',
  'application/x-sh',
  'application/x-bat',
  'application/x-rar-compressed',  // v0.2 设计清单;运营如需开 zip / rar 走单独评审
  'application/zip',
  'application/x-zip-compressed',
  'video/*',  // 完整禁视频;走"独立多媒体管理评审"
]);
```

通配符匹配(如 `video/*`)由 Service 层手写而非 Set 自动;实施 PR 期决议;**Provider 选型评审 / 安全评审落地时可追加或调整本清单**。

---

## 7. audit_logs 集成(沿 A-17 + D7-RBAC §11)

### 7.1 新增 AuditLogEvent union 项(+3)

```typescript
export type AuditLogEvent =
  | ...  // 现有 22 项(v0.9.0 收官:批次 6 第二波 17 项 + RBAC 9 项,实际 union 在 audit-logs.types.ts 维护)
  | 'attachment.upload'           // 沿路线 A:单事件名 + extra.attachmentType / extra.ownerType / extra.size / extra.mime 区分
  | 'attachment.delete'           // 单事件;extra.deletedByPath ∈ {owner, admin}
  | 'attachment.config.change';   // 配置三表通用事件;extra.configType ∈ {type, mime, sizeLimit} + extra.operation ∈ {create, update, delete}
```

**说明**:
- **不审计 view / list**(沿 D6 v1.1 R4:read 不审计)
- **不审计 PATCH 元数据更新**(🔒 Q7 v0.2 锁:沿"只审高价值写操作"原则;`description` / `tags` 这类元数据变更价值低)
- **不审计 Provider 真上传 / 真下载**(本批次 Provider 不实装)
- **路线 A 多 operation 共用单一事件名 + extra 区分**(沿 audit_logs v0.8.0 收官 + D7-RBAC D11)

### 7.2 同事务 wrap(沿 A-17)

每个写接口必须 wrap `prisma.$transaction`,内部调 `AuditLogsService.log({ tx })`;沿 §6.2 示例。RBAC 判权失败(`RBAC_FORBIDDEN`)在 audit 之前抛出,**不**落 audit(沿 F6 不做失败操作审计)。

### 7.3 不审计自身

- 配置三表读 / 列表不审计(沿 R4)
- 配置三表 CRUD 写操作走 `attachment.config.change`,**不审计 `audit_logs` 自身**(沿 A-18)
- attachments 列表 / 详情读不审计

---

## 8. BizCode 段位(`130xx` + `131xx`;沿 baseline §1.1)

### 8.1 子段位细分(v0.2 已展开;实施 PR 期微调)

#### `130xx`(attachments + 配置三表 实体级错误)

| code | name | message | httpStatus | 用途 |
|---|---|---|---|---|
| 13001 | `ATTACHMENT_NOT_FOUND` | 附件不存在 | 404 | — |
| 13002 | `ATTACHMENT_KEY_ALREADY_EXISTS` | 附件 key 已存在 | 409 | 防 Provider 侧 key 撞库;v1 仅 P2002 兜底,checksum unique 不实装 |
| 13010 | `ATTACHMENT_OWNER_TYPE_INVALID` | 附件归属类型不合法 | 400 | 不在 `attachment_type_config` 白名单或 status=INACTIVE |
| 13011 | `ATTACHMENT_OWNER_NOT_FOUND` | 附件归属对象不存在或已软删 | 400 | ownerId 不指向 ownerType 对应业务表活跃记录 |
| 13012 | `ATTACHMENT_MIME_NOT_ALLOWED` | 附件 MIME 类型不在白名单 | 400 | mime 不在该 ownerType 的 mime 白名单(含 system blocklist 命中) |
| 13013 | `ATTACHMENT_SIZE_EXCEEDED` | 附件大小超过上限 | 400 | size > 该 ownerType 配置的 maxSizeBytes |
| 13014 | `ATTACHMENT_TAG_TOO_LONG` | 附件 tag 长度超限 | 400 | tag 单项 > 32 字符;数组 > 20 项已由 DTO 拦截走 `40000`(可不开此码;v0.2 决议) |
| 13020 | `ATTACHMENT_TYPE_CONFIG_NOT_FOUND` | 附件类型配置不存在 | 404 | — |
| 13021 | `ATTACHMENT_TYPE_CONFIG_CODE_ALREADY_EXISTS` | 附件类型配置 code 已存在 | 409 | — |
| 13022 | `ATTACHMENT_MIME_CONFIG_NOT_FOUND` | 附件 MIME 配置不存在 | 404 | — |
| 13023 | `ATTACHMENT_MIME_CONFIG_DUPLICATE` | 同一附件类型下 MIME 已存在 | 409 | `(typeConfigId, mime)` UNIQUE 撞库 |
| 13024 | `ATTACHMENT_SIZE_LIMIT_CONFIG_NOT_FOUND` | 附件尺寸限制配置不存在 | 404 | — |
| 13025 | `ATTACHMENT_SIZE_LIMIT_CONFIG_ALREADY_EXISTS` | 该类型已有尺寸限制配置 | 409 | `typeConfigId` UNIQUE 撞库(1:1) |
| 13030 | `ATTACHMENT_TYPE_IN_USE` | 附件类型仍被 attachment 引用,无法删除 | 409 | 软删 `AttachmentTypeConfig` 时仍有活跃 attachment 引用 |
| 13031 | `ATTACHMENT_SYSTEM_MIME_BLOCKED` | 该 MIME 在系统级黑名单,不允许加入白名单 | 400 | 沿 §6.6 SYSTEM_MIME_BLOCKLIST |

#### `131xx`(权限 / 操作 / 完整性)

| code | name | message | httpStatus | 用途 |
|---|---|---|---|---|
| 13101 | `FORBIDDEN_ATTACHMENT_OPERATION` | 无权对该附件执行此操作 | 403 | **可选**;沿 baseline §1.3 风格;实际 RBAC 拒绝优先抛 `RBAC_FORBIDDEN=30100`;若 attachments 引入 RBAC 之外的兜底拒绝路径(如"对方账号软删后某些 admin 路径"),用此码;**v0.1 建议保留段位预留,实施期实际未必用** |

**v0.1 建议合计 ~16 条 BizCode**(`130xx` 15 + `131xx` 1);v0.2 细化精确数字。

### 8.2 不与现有段位冲突

- `130xx` / `131xx` baseline 早已预留(v0.5.0 起;沿 [docs/srvf-foundation-baseline.md §1.1](srvf-foundation-baseline.md))
- 不与 `140xx`(audit_logs)/ `300xx`(permissions)冲突
- 实施 PR 入 BizCode 常量按 code 数值排序(沿 baseline §1.4)

---

## 9. 合规口径(沿决议 4 最低合规版)

### 9.1 加密

- **Provider 侧 SSE-S3 等价默认透明加密**:Provider 接通后启用(具体配置由 Provider 选型评审决议)
- **DB 元数据不加密**:`attachments` 表所有字段均明文存储;`originalName` / `description` 等可能含敏感信息但不属"个人信息"范畴(沿《个人信息保护法》第 4 条 / 第 28 条解释)

### 9.2 自动清理

- **不做自动清理脚本**(沿决议 4)
- ADMIN 手动清理路径:调用 `DELETE /api/v2/attachments/:id`;后台 UI 由独立前端项目对接

### 9.3 保存期限

| 场景 | 期限 | 触发清理条件(🔒 Q8 v0.2 锁:`status=DISABLED ≥ N` + 后台提示;N 待业务确认) |
|---|---|---|
| 队员证件照(身份证) | 在队期间永久 + 退队后 N(暂候 6 个月)由 ADMIN 触发清理评估 | `Member.status=DISABLED` ≥ N → 后台 UI 提示 ADMIN 清理;**N 配置项 / 待业务确认**,不自动删除 |
| 队员证件照(急救/潜水/培训证) | 在队期间永久 + 退队后 N(暂候 2 年)由 ADMIN 触发清理评估 | `Member.status=DISABLED` ≥ N → 后台 UI 提示;**N 配置项 / 待业务确认** |
| 活动现场照 | 永久(队组织数据资产) | 不清理 |
| 活动封面 | 永久(跟随 Activity 生命周期) | Activity 软删时附件不动(沿 §6.4 矩阵) |

### 9.4 OCR 与身份证号(沿 Q7 AI 建议 a)

**技术承诺**:本批次**不调用 OCR 服务**;身份证图像永远以**图像形态**存储于 Provider 侧物理文件;DB / API / 日志 / audit_logs **永不出现身份证号字符串**。

**Service 层校验铁律**:`originalName` / `description` 字段如检测含身份证号正则模式(`\d{17}[\dXx]`),Service 层**拒绝**入库;🔒 Q9 v0.2 锁:**预留 `ATTACHMENT_PII_DETECTED=13015` BizCode**(沿 §8.1 子段位预留;实施期落地)。

### 9.5 退队触发清理(🔒 Q8 v0.2 锁)

**v0.2 锁定(Q8)**:`Member.status=DISABLED` ≥ N + 后台提示,**不自动删除**;**N 按附件类型分级,作为配置项,待业务方进一步确认**(沿 §9.3 表)。

- 主触发条件:**`Member.status=DISABLED` 且持续 ≥ N 时长**(N 按附件类型表;**N 配置项 / 待业务确认**)
- 备用触发条件:**`Member.deletedAt` 设置**(立即提示)
- 实现方式:后台 UI 提示 ADMIN 手动清理(**不主动执行**)
- 具体后台 UI 行为由后台对接前端项目决定;本期后端 API **仅提供** `GET /api/v2/attachments?ownerType=member&ownerId=<退队 member.id>` 列表能力

### 9.6 入队同意书条款(v0.1 占位)

> **v0.1 占位**;具体条款 **v0.2 由维护者提供** 后冻结。

候选措辞框架(沿决议 4):

> "本人同意贵会(深圳市公益救援志愿者联合会)出于队员管理、活动派遣、资质核验、应急联络等合理目的,采集、存储、使用本人提供的身份证图像、证书图像、紧急联系人信息、医疗信息等个人信息。
>
> 本人理解:
> - 此类信息储存于贵会自营 / 委托第三方云存储服务,经服务端透明加密保护;
> - 查看权限仅授予 SUPER_ADMIN / ADMIN / 业务相关部门部长(如 APD)等经贵会授权的角色;
> - 退队后,身份证类附件由 ADMIN 在 6 个月内手动清理;其他证件类附件由 ADMIN 在 2 年内手动清理;
> - 本同意符合《中华人民共和国个人信息保护法》第 13 条规定的'订立、履行个人作为一方当事人的合同所必需'与'救援活动派遣合理范围'的合法性基础。"

具体措辞维护者 v0.2 提供。

---

## 10. 初始 seed migration

### 10.1 `attachment_type_configs` 公开 seed(3 条)

沿 §4.2 候选;不含真实部门 / 角色名,公开 seed 即可:

```typescript
await prisma.attachmentTypeConfig.createMany({
  data: [
    { code: 'member', displayName: '队员证件照(身份证)', ownerTable: 'member', defaultMaxSizeBytes: 5_242_880, defaultMimeWhitelist: ['image/jpeg', 'image/png', 'image/heic', 'image/webp'] },
    { code: 'certificate', displayName: '队员资质证件', ownerTable: 'certificate', defaultMaxSizeBytes: 5_242_880, defaultMimeWhitelist: ['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf'] },
    { code: 'activity', displayName: '活动现场照 / 封面', ownerTable: 'activity', defaultMaxSizeBytes: 10_485_760, defaultMimeWhitelist: ['image/jpeg', 'image/png', 'image/heic', 'image/webp'] },
  ],
});
```

### 10.2 attachment.* 权限点 seed(🔒 v0.2 锁定 20 条清单;沿 §6.1)

**Q11 v0.2 锁定 20 条权限点清单**(沿 §6.1 表);**实际 seed 代码由 attachments 实施 PR 完成 Permission upsert**(沿 D7-RBAC §10.2 范式)。本 v0.2 不列具体 `createMany` 代码,留实施期。

### 10.3 attachment.* 角色权限映射(USER 内置 placeholder)

- USER 内置角色 placeholder("member"):配 9 条 `.self` 权限点 + `attachment.view.activity`(沿 §6.1 表)
- `role-a..role-f` 真实角色的 `.other` 映射走 `.env.seed.local`(沿 D7-RBAC F6 / R13)

### 10.4 ADMIN 内置角色(🔄 Q12 v0.2 挂起)

**Q12 v0.2 挂起**:沿 v0.9.0 §5"未创建 ADMIN 内置角色";attachments 实施期是否创建 ADMIN 内置角色映射所有 `.other` 权限点 — 此项影响 RBAC seed/bootstrap 与业务管理员默认能力;**等 attachment 权限点清单(已锁,§6.1)+ 业务管理员边界进一步确认后再锁**。v0.2 不锁,v1.0 / 实施期再决议。

候选方案(挂起,供后续评审参考):

- 方案 A:创建 ADMIN 内置角色,自动持所有 `.other` 权限点;ADMIN 默认可全权管理任何成员附件(沿 D7-RBAC §7.1 step 2 ADMIN 自动继承 USER 权限的延伸)
- 方案 B:不创建 ADMIN 内置角色,ADMIN 默认无业务权限,需运营管理员通过 `POST /api/v2/users/:userId/roles` 显式分配(沿 v0.9.0 §5 现状)
- 方案 C:创建 ADMIN 内置角色,但仅持 `.view.*` / `.delete.*`,不持 `.upload.*` / `.update.*`(读写分离)

---

## 11. 风险声明(沿 D6 §六 + 业务方知情承担)

| # | 风险 | 业务方决议 | 沿用 |
|---|---|---|---|
| 1 | 硬删除不可恢复 | 接受;Provider versioning 技术兜底 | D6 §六 1 |
| 2 | 无病毒扫描的恶意文件上传 | 接受;升级路径留 V3+ | D6 §六 2 |
| 3 | 无 KMS 主动加密 | 接受;走 Provider SSE-S3 默认透明加密 | D6 §六 3 |
| 4 | 无自动清理脚本 | 接受;ADMIN 手动清理 | D6 §六 4 |
| 5 | 多态外键牺牲 DB FK 完整性 | 接受;Service 层手写校验 | D6 §六 6 |
| 6 | v0.1 阶段 Provider 不实装,上传仅落库元数据 | 接受;Provider 选型评审稿同期推进 | 本稿决议 F2 |
| 7 | accessLevel 仅作 hint,实际权限走 RBAC | 🔒 v0.2 锁(Q2) | 沿决议 Q2 |
| 8 | tags 用 `String[]` 不支持 tag 全局 CRUD | 🔒 v0.2 锁(Q3) | 沿决议 Q3 |
| 9 | uploadedBy 指向 User.id 而非 Member.id;管理员账号上传时无 Member 关联 | 🔒 v0.2 锁(Q4) | 沿决议 Q4 |

---

## 12. 测试覆盖建议

### 12.1 e2e(目标 ~40-60 用例)

- attachments 主模块 × 7 端点 × {成功 / 权限不足 / 不存在 / 重复 / mime 拒绝 / size 拒绝 / ownerType 拒绝 / ownerId 不存在}:**~30 用例**
- 配置三表 × 5 端点 × 3 表 × {成功 / 不存在 / 重复 / 撞约束 / 系统级 MIME 黑名单拒绝}:**~25 用例**
- RBAC 集成:`.self` ownership 匹配 / 不匹配 / `.other` 走 RBAC 角色 / SUPER_ADMIN 短路 / RBAC_FORBIDDEN 拒绝:**~10 用例**
- audit 集成:每个写接口 → audit 落库 + 失败 audit 不落库:**~10 用例**
- 合规:身份证号检测拒绝 / 多态 ownerType 切换 / accessLevel hint 不影响判权:**~5 用例**

### 12.2 单元测试

- `assertOwnerTypeAllowed` / `assertOwnerExists` / `assertMimeAllowed` / `assertSizeAllowed` / `detectScope` / `buildRbacResource` 各场景

### 12.3 contract snapshot

- v1 14 + V2 79 + RBAC 16 接口 schema **保持不变**(A-2 红线)
- 新增 22 attachments 接口 + ~20 DTO 入 snapshot
- `Certificate.attachmentKey` 字段从 OpenAPI 消失(预期变更;沿 §4.6)

---

## 13. PR 拆分建议

预估 **9-11 个 PR**(沿 batch6 audit_logs / batch8 RBAC 范式):

| PR | 类型 | 主题 | 改动量 |
|---|---|---|---|
| 0 | `docs(v2-design)` | **D7-RBAC v1.2 修订**(Permission code 正则 3 段 → 3-4 段;纯 docs)| 小 |
| 1 | `chore(prisma)` | 4 个 model(Attachment + 3 配置表)+ migration(含 Certificate.attachmentKey drop column;含 Permission code 正则放宽 1 行代码改动) | 中-大 |
| 2 | `feat(attachments)` | attachments 主模块 CRUD(端点 1-7)| 大 |
| 3 | `feat(attachment-configs)` | AttachmentTypeConfig CRUD(端点 8-12) | 中 |
| 4 | `feat(attachment-configs)` | AttachmentMimeConfig CRUD(端点 13-17)| 中 |
| 5 | `feat(attachment-configs)` | AttachmentSizeLimitConfig CRUD(端点 18-22)| 中 |
| 6 | `feat(attachments)` | RBAC 集成 + Service 层 `rbac.can()` + `attachment.*` 权限点 seed + USER 内置角色 placeholder seed | 大 |
| 7 | `feat(attachments)` | audit_logs 集成(3 项 union + 同事务 wrap)| 中 |
| 8 | `feat(certificates)` | Certificate.attachmentKey 字段废弃(出参 DTO / select / e2e 同步删除引用)| 小 |
| 9 | `docs(v2-batch7-landing)` | 收口 docs(类比 PR #62 / #29-#41 风格)| 小 |
| 10 | `chore` | bump version 0.9.0 → 0.10.0(SemVer minor;新模块 + 4 表 + 22 接口,但 v1 14 + V2 79 + RBAC 16 接口 zero drift)| 极小 |
| 11 | `docs(v2)` | v0.10.0 handoff | 小 |

PR #0 应在 PR #1 之前合并(纯 docs 修订;为 PR #1 中 1 行 regex 代码变更提供评审依据)。

---

## 14. 验收门槛(沿 baseline §14)

### 14.1 A 档(必跑)

- `pnpm lint` 通过
- `pnpm typecheck` 通过
- `pnpm test:e2e` 全部通过(v1 137 + V2 既有 + RBAC ~40 + 新增 attachments ~40-60)
- `pnpm build` 通过
- `pnpm test:contract` 通过(v1 14 + V2 79 + RBAC 16 接口 zero drift;**新增 22 attachments 接口 + Certificate.attachmentKey 删除入 snapshot**)
- 任务卡声明的所有验收标准

### 14.2 B 档(HTTP / 中间件 / Guard / Swagger 改动时)

- `/api/docs` 完整可用,**22 个新 attachments 端点全部展示**
- attachments 主模块上传:成功 / RBAC 拒绝 / mime 拒绝 / size 拒绝四路径验证
- 配置三表 CRUD:成功 / 权限不足(USER 调用)/ 重复约束撞库
- audit_logs 落库:成功 attachment.upload / 同事务 fail-fast(RBAC 拒绝时不落 audit)
- v1 `GET /api/health` 仍按 v1 契约
- v1 14 + V2 79 + RBAC 16 接口 schema / paths 不变

---

## 15. 关联说明 / 边界澄清

### 15.1 与 D7-RBAC v1.2 修订 PR 的关系(已合入)

D7-RBAC v1.2 修订 PR(纯 docs;Permission code 正则放宽到 3-4 段)已于 PR #66(squash commit `2b934c5`,2026-05-14)合入 main。本 v0.2 建立在该文档先决条件之上。后续顺序:

1. ✅ D7-RBAC v1.2 修订 PR(纯 docs)→ 已合入 main(PR #66)
2. ✅ D7-attachments v0.1 草稿 → 已合入 main(PR #65)
3. 🔄 **本 D7-attachments v0.2 局部收口 PR**(本 PR)→ 等合入
4. ⏳ D7-attachments v1.0 冻结 PR(等入队同意书条款 + N 时长等业务方确认 + Q12 决议后)→ 用户授权
5. ⏳ C-7 attachments V2.x 立项 PR → 用户授权
6. ⏳ 实施 PR #1 ~ #11(沿 §13 拆分)→ 逐 PR 用户授权

### 15.2 活动封面与 Activity 模型的字段关联(🔒 Q1 v0.2 锁定)

**v0.2 锁定(Q1)**:**复用 attachments 模型,Activity 不加 `coverAttachmentId` 字段**(沿 A-2 红线)。通过 attachments 表 `(ownerType='activity', ownerId=activity.id)` + `accessLevel=PUBLIC` + **`attachmentSubType` 字段标识 `'cover' | 'gallery'`**(具体字段实现 v1.0 / 实施期细化:可选 `String?` 字段 / 走 tags `'cover'` 标签 / 走 metadata JSON 字段)。

**理由**:
- 不动 v0.4.0 已交付的 Activity schema(A-2 红线;`coverImageUrl` 字段已存在并已被使用)
- attachments 与 Activity.coverImageUrl 双轨制:Activity.coverImageUrl 是历史 URL 字段,新建活动时由 attachments 系统生成 URL 后**回填**到 Activity.coverImageUrl(沿用现有展示链路);或前端直接读 attachments 列表(v1.0 / 实施期决议)

### 15.3 tags 实现(🔒 Q3 v0.2 锁定)

**v0.2 锁定(Q3)**:`String[]` PG 原生数组(沿 MemberProfile.exerciseMethods / firstAidSkills 范式)。

**不选 关联表 的理由**:
- 关联表带来 tag CRUD / tag 全局唯一 / tag 重命名联动等复杂性
- v1 不需要"全局 tag 管理后台 UI"
- 沿决议 4 最低工作量

**升级路径**:若未来真需 tag 全局 CRUD,沿 §17 升级路径迁 tags → 独立表。

### 15.4 uploadedBy 指向(🔒 Q4 v0.2 锁定)

**v0.2 锁定(Q4)**:`User.id`。

**理由**:
- 沿 V2 现有 createdBy / publishedBy / cancelledBy 风格(均指 User.id)
- Member 维度通过 `User.memberId` 关联查
- 管理员账号(无 Member 关联)上传时仍能落 `uploadedBy = adminUser.id`
- `originalUploaderName` 字段已冗余存人名,uploader 软删后仍能显示

### 15.5 与 member_profiles / events 复活的耦合(沿 D6 Q11 A)

- attachments 主表 schema **不为** member_profiles / events 预留特殊字段
- member_profiles / events 复活时,attachments 仅扩 `attachment_type_config` 表注册新 `ownerType`(如 `member_profile` / `event`),**不动**主模块 schema / 路径 / DTO

### 15.6 不动 RBAC 14 RBAC CRUD 入口 Guard

本 D7(含 v0.1 / v0.2)范围**不包含** RBAC 14 RBAC CRUD 端点入口接入 `rbac.can()`。沿 v0.9.0 §7.3 Slow-4 留独立 PR;attachments 接入是 **0 → 1 业务范本**,RBAC 自身判权迁出是另一独立动作。

---

## 16. 决议表(D7-attachments v0.2 局部收口;5 项 F + 9 项 B + 13 项 Q 已锁 + 1 项 Q 挂起 + 2 项 Q 挂起待 Provider + 1 项 Q 建议不冻结)

> **状态历程**(修订日志,只在本说明区出现历史措辞):
> - **v0.1 草稿**(PR #65,2026-05-14):5 项 F 锁(用户拍板 Q0-Q5)+ 9 项 B 锁(沿 D6 业务确认稿)+ 16 项 Q 以"本稿建议 / 待评审"承载
> - **v0.2 局部收口**(本 PR,2026-05-14):用户逐项拍板 Q1-Q16;**13 项 Q 锁定**(Q1 / Q2 / Q3 / Q4 / Q5 / Q6 / Q7 / Q8 / Q9 / Q10 / Q11 / Q13;**注意**:仅 12 项是"AI 推荐照单全锁",Q11 是"锁清单但 seed 留实施 PR")+ **1 项 Q 挂起**(Q12 ADMIN 内置角色:影响 RBAC seed/bootstrap + 业务管理员默认能力,待权限点清单 + 业务管理员边界确认)+ **2 项 Q 挂起待 Provider 选型评审**(Q14 上传策略 / Q15 删除策略)+ **1 项 Q 建议不冻结**(Q16 PR 拆分:沿 §13 9-11 PR 建议,实施期微调)
> - 🔒 = v0.1 / v0.2 冻结决议;🔄 = v0.2 挂起;⏸ = v0.2 挂起待 Provider 选型;📋 = v0.2 建议不冻结
> - **v1.0 暂不冻结**:留入队同意书条款 + N 时长 + Q12 ADMIN 内置角色等业务方 / 评审进一步澄清后再冻结

| # | 决议 | v0.2 状态 | 来源 / 章节 |
|---|---|---|---|
| F1 | Permission code 正则放宽到 **3-4 段**(`/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/`);D7-RBAC v1.2 修订 PR 已合入(PR #66, squash commit `2b934c5`);本稿不改代码,实际 `CODE_PATTERN` 放宽留 C-7 实施 PR #1 | 🔒 v0.1 锁(用户拍板)| 用户拍板 |
| F2 | Provider **不实装**;D7 仅覆盖元数据 + API 契约 + RBAC + audit + 配置三表 | 🔒 v0.1 锁(用户拍板) | 用户拍板 |
| F3 | attachments 入口 Guard = **仅 `JwtAuthGuard`**;判权全部在 Service 层 `rbac.can()`;attachments 是 0 → 1 接入 RBAC 的范本 | 🔒 v0.1 锁(用户拍板) | 用户拍板 |
| F4 | 配置三表 CRUD 入口 = **`@Roles(SUPER_ADMIN, ADMIN)`**;不为配置三表新增 `rbac.config.*` 权限点 | 🔒 v0.1 锁(用户拍板) | 用户拍板 |
| F5 | BizCode 段位 = **`130xx` + `131xx`**(沿 baseline §1.1 v0.5.0 预留;子段位 §8.1 v0.2 已展开,实施期微调)| 🔒 v0.1 锁 | baseline §1.1 |
| B1 | 启用场景 1-4(沿 D6 Q1);场景 5-6 延后 | 🔒 v0.1 锁(沿 D6) | D6 Q1 |
| B2 | 单归属 1:N(沿 D6 Q3 A)| 🔒 v0.1 锁(沿 D6) | D6 Q3 |
| B3 | 多态外键 `ownerType` + `ownerId`(沿 D6 Q4 A);Service 层手写校验;无 DB FK | 🔒 v0.1 锁(沿 D6) | D6 Q4 |
| B4 | 硬删除(沿 D6 Q5 B);删除矩阵沿 §6.4 | 🔒 v0.1 锁(沿 D6) | D6 Q5 |
| B5 | 13 字段全加(沿 D6 Q2);具体字段细节沿 §4.1 | 🔒 v0.1 锁字段集;字段细节(可空性 / 默认值)v1.0 / 实施期细化 | D6 Q2 |
| B6 | 不做病毒扫描(沿 D6 Q8c A);本批次不做 | 🔒 v0.1 锁(沿 D6) | D6 Q8c |
| B7 | 配置三表与 attachments 主模块同批次(沿 D6 决议 3)| 🔒 v0.1 锁(沿 D6) | D6 决议 3 |
| B8 | 最低合规版(沿 D6 决议 4 + §9)| 🔒 v0.1 锁措辞框架;入队同意书具体条款 v1.0 由维护者提供 | D6 决议 4 |
| B9 | Provider 选型独立评审(沿 D6 决议 5)| 🔒 v0.1 锁(沿 D6) | D6 决议 5 |
| Q1 | 活动封面与 Activity 模型字段关联方案 | 🔒 **v0.2 锁**:**复用 attachments + ownerType=activity + `attachmentSubType` 标识 cover**;**不改 Activity schema**(沿 A-2);Activity.coverImageUrl 现有字段保留,新建活动时由 attachments 系统生成 URL 后回填(v1.0 / 实施期细化具体回填路径) | §15.2 |
| Q2 | accessLevel 与 RBAC 关系 | 🔒 **v0.2 锁**:**hint + 索引**,实际权限**完全走 RBAC 单一权威源** | §6.5 |
| Q3 | tags 实现 | 🔒 **v0.2 锁**:`String[]` PG 原生数组(沿 MemberProfile.exerciseMethods 范式);**不建 tag 关联表**;不开 tag 全局 CRUD | §15.3 |
| Q4 | uploadedBy 指向 | 🔒 **v0.2 锁**:**User.id**(沿 V2 createdBy / publishedBy 风格;管理员账号上传时也能落库;`originalUploaderName` 冗余存人名) | §15.4 |
| Q5 | ownerType 枚举来源 | 🔒 **v0.2 锁**:**双层校验** — 业务层 `AttachmentOwnerType` TS enum **作为代码防错边界**(编译期已知);配置表 `attachment_type_config.code` **作为运行时可配置白名单**(权威源);两者必须保持同步,新增 ownerType 需同时改 enum + 配置表 seed | §4.2 / §6.3 |
| Q6 | checksum / etag 出参可见性 | 🔒 **v0.2 锁**:**不进普通出参 DTO**;作为内部字段保留;管理员详情 / 调试接口若需可见,**留 v1.0 / 实施期再评审** | §5.4.4 |
| Q7 | PATCH 元数据更新是否审计(`attachment.update` 是否进 audit union)| 🔒 **v0.2 锁**:**不审计 PATCH metadata**(沿"只审高价值写操作"原则;`description` / `tags` 等元数据变更价值低)| §7.1 |
| Q8 | 退队触发清理条件 | 🔒 **v0.2 锁**:**`Member.status=DISABLED` ≥ N + 后台提示**;**不自动删除**;**N 配置项 / 待业务确认**(暂候身份证类 6 个月、其他证件类 2 年) | §9.3 / §9.5 |
| Q9 | 身份证号 PII 检测拒绝是否专门开 BizCode | 🔒 **v0.2 锁**:**预留 `ATTACHMENT_PII_DETECTED=13015`**(沿 §8.1 子段位;实施期落地) | §9.4 |
| Q10 | activity 场景是否要 self/other 区分 | 🔒 **v0.2 锁**:**不区分**(粗粒度活动级权限;沿 §6.1 设计) | §6.1 |
| Q11 | attachment.* 权限点完整穷举 | 🔒 **v0.2 锁清单**:**20 条**(沿 §6.1 表);**实际 seed 落地由 C-7 实施 PR 完成**(不在 v0.2 PR 内 seed) | §6.1 |
| Q12 | 是否在 attachments 实施期创建 "ADMIN 内置角色" 自动持所有 `.other` 权限点 | 🔄 **v0.2 挂起**:影响 RBAC seed/bootstrap + 业务管理员默认能力;**等 attachment 权限点清单(已锁,§6.1)+ 业务管理员边界进一步确认后再锁**;候选方案 A/B/C 见 §10.4 | §10.4 |
| Q13 | 系统级 MIME 黑名单完整清单(代码硬编码) | 🔒 **v0.2 锁(D7 设计清单)**:沿 §6.6 候选;**不在 v0.2 承诺最终安全清单**;后续 Provider 选型 / 安全评审可追加 | §6.6 |
| Q14 | Provider 接通后上传策略(multipart / 直传签名 URL / 中转)| ⏸ **v0.2 挂起待 Provider 选型评审**;沿 D6 决议 5 独立评审稿同期推进 | §5.5 |
| Q15 | Provider 接通后删除策略(同步阻塞 / 异步重试 / 仅记录告警)| ⏸ **v0.2 挂起待 Provider 选型评审** | §6.4 |
| Q16 | PR 拆分顺序(9-11 PR;§13) | 📋 **v0.2 建议不冻结**:沿 §13 表作为 v0.2 建议,**不冻结最终数量**(实施期可微调) | §13 |

**总计**:**F 5 + B 9 + Q 16 = 30 项**
- **🔒 v0.2 已锁**:**F 5 + B 9 + Q 13 = 27 项**(Q1 / Q2 / Q3 / Q4 / Q5 / Q6 / Q7 / Q8 / Q9 / Q10 / Q11 / Q13 共 12 项 AI 推荐照单全锁 + Q11 锁清单但 seed 留实施 PR)
- **🔄 v0.2 挂起**:**1 项**(Q12 ADMIN 内置角色)
- **⏸ v0.2 挂起待 Provider 选型**:**2 项**(Q14 / Q15)
- **📋 v0.2 建议不冻结**:**1 项**(Q16 PR 拆分)
- **v1.0 暂不冻结**(留入队同意书条款 + N 时长 + Q12 决议)

---

## 17. 落地节奏

1. ~~**D7-attachments v0.1 草稿 PR**~~ → ✅ 已落地(PR #65,squash commit `ebb530e`,2026-05-14)
2. ~~**D7-RBAC v1.2 修订 PR**(纯 docs;Permission code 正则 3 段 → 3-4 段)~~ → ✅ 已落地(PR #66,squash commit `2b934c5`,2026-05-14)
3. **本 PR(D7-attachments v0.2 局部收口)** → 🔄 锁定 13 项 Q + 挂起 3 项 + 不冻结 1 项;v1.0 暂不冻结
4. **D7-attachments v1.0 冻结 PR**(剩余项全部冻结;含入队同意书条款 + N 时长 + Q12 决议)→ 用户授权
5. **C-7 attachments V2.x 立项 PR**(沿 D7-RBAC 立项 PR #52 风格)→ 用户授权
6. **实施 PR #1 ~ #11**(沿 §13)→ 逐 PR 用户授权
7. **Provider 选型独立评审稿**(与 attachments 实施期同期推进;沿 D6 决议 5)→ 独立评审
8. **C-7 上线 / bump version 0.9.0 → 0.10.0** → 沿 batch6 / batch8 收口范式

### 17.1 v0.2 局部收口结论(本 PR 新增)

- **触发**:v0.1 草稿(PR #65)合并后,用户按"一次性批量拍板"模式逐项拍板 Q1-Q16
- **决议结果**(沿 §16 总计):
  - **锁定 13 项 Q**:Q1 / Q2 / Q3 / Q4 / Q5 / Q6 / Q7 / Q8 / Q9 / Q10 / Q11 / Q13(其中 Q11 锁清单但 seed 留实施 PR)
  - **挂起 1 项**:Q12 ADMIN 内置角色(影响 RBAC seed/bootstrap + 业务管理员默认能力)
  - **挂起待 Provider 选型 2 项**:Q14 上传策略 / Q15 删除策略
  - **建议不冻结 1 项**:Q16 PR 拆分(沿 §13 9-11 PR)
- **v1.0 暂不冻结**:留入队同意书条款 + N 时长 + Q12 ADMIN 内置角色 + 其他业务方进一步澄清后再冻结
- **本 PR 仅文档修订**,不动代码 / schema / migration / 测试 / package.json / pnpm-lock.yaml
- **不启动 C-7 attachments 实施**(实施 PR 在 v1.0 冻结 + 立项 PR 后才允许启动)

---

## 18. 撰写元信息

- **状态标签**:**v0.2 局部收口稿**;5 项 F 锁 + 9 项 B 锁 + 13 项 Q 锁定 + 1 项 Q 挂起(Q12)+ 2 项 Q 挂起待 Provider 选型(Q14/Q15)+ 1 项 Q 建议不冻结(Q16);**v1.0 暂不冻结**
- **commit 风格**(两段历史):
  - v0.1:`docs(v2-design): add attachments API review draft v0.1`(已落地 PR #65,squash commit `ebb530e`)
  - v0.2:`docs(v2-design): refine attachments API review decisions v0.2`(本 PR)
- **未做项**(v0.2 沿 v0.1 + 强化):
  - 不动 `prisma/schema.prisma` 文件本身(本稿 Prisma DSL 仅 markdown 草案)
  - 不动 `src/**` / `prisma/**` / `prisma/migrations/**` / `test/**` / `package.json` / `pnpm-lock.yaml`
  - 不新增 migration
  - **特别强调**:不动 `src/modules/permissions/permissions.service.ts` 中 `CODE_PATTERN`(实际放宽留 C-7 实施 PR #1;D7-RBAC v1.2 已在 PR #66 文档层面打开)
  - 不修改 `docs/批次8_RBAC_API前评审.md`(D7-RBAC v1.2 已合入 PR #66;v0.2 不补 PR #66 漏记 CHANGELOG 的小疏漏,避免混入历史修正)
  - 不修改 `docs/srvf-foundation-baseline.md`(段位早已预留)
  - 不修改 `docs/V2红线与复活路径.md`(留本评审稿 v1.0 冻结后由立项 PR 更新)
  - 不修改 `docs/handoff/v0.9.0.md` / 其他历史 handoff(沿 V2 红线 §5.1 历史 handoff 不回改)
  - 不 bump version / 不打 tag / 不发 Release
  - 不启动 attachments 实施(实施 PR 在 v1.0 冻结 + 立项 PR 后才允许启动)
  - 不启动 Provider 选型评审稿(独立 PR;沿 D6 决议 5)
  - 不动 RBAC 14 RBAC CRUD 入口 Guard(沿 v0.9.0 §7.3 Slow-4)
- **v0.2 修订范围**(本 PR;纯文档措辞修订):
  - 本评审稿:状态升 v0.1 → v0.2;顶部 metadata + 修订历程 + 核心一句话同步 + §1.3 D6 留 D7 细化项表 + §2.2 实施物清单 + §4.1 字段注释 + §4.1 校验铁律表 checksum/etag 行 + §5.1 PATCH 行 + §5.4.4 出参注释 + §6.1 标题(Q11 锁清单)+ §6.1 RBAC 角色映射 placeholder 说明 + §6.3 加 Q5 双层校验段 + §6.4 删除矩阵 Provider 删失败处理标 Q15 挂起 + §6.5 标题(Q2 锁)+ §6.6 标题与正文(Q13 锁 + 设计清单措辞)+ §7.1 PATCH 审计标 Q7 锁不审计 + §8.1 标题(实施期微调)+ §9.3 保存期限表头(Q8 锁)+ §9.4 PII BizCode(Q9 锁)+ §9.5 退队清理(Q8 锁)+ §10.2 标题(Q11 锁清单)+ §10.4 改为 ADMIN 内置角色挂起(Q12 + 候选 ABC 方案)+ §11 风险表(7/8/9 v0.2 锁)+ §15.1 D7-RBAC v1.2 改为已合入 + §15.2 标题(Q1 锁)+ §15.3 标题(Q3 锁)+ §15.4 标题(Q4 锁)+ §15.6 D7 v0.1 → v0.2 沿用 + §16 决议表整段重写(状态历程 + 表格 + 总计)+ §17 落地节奏 + §17.1 加 v0.2 局部收口结论 + §18 元信息
  - `CHANGELOG.md` Unreleased:追加一行 v0.2 局部收口说明(沿 D7-RBAC v0.2 / v1.0 / v1.1 收口类 PR 范式)
  - **不**修订 `docs/批次8_RBAC_API前评审.md`(D7-RBAC v1.2 修订属独立 PR;PR #66 漏记 CHANGELOG 视为小疏漏不在本 PR 顺手补)
  - **不**修订 `docs/srvf-foundation-baseline.md` / `ARCHITECTURE.md` / 任何 handoff / V2 红线 / 立项记录
- **本评审稿 v0.2 修订后的下一动作**(由用户拍板):
  - 启动 **D7-attachments v1.0 冻结 PR**(等入队同意书条款 + N 时长 + Q12 ADMIN 内置角色等业务方 / 评审进一步澄清后)
  - **不**自动启动实施 PR;实施 PR 在 v1.0 冻结 + 立项 PR 后才允许启动
- **撰写者签名**:Claude Code(v0.1 基于 D6 业务确认稿 11 题 + 5 决议 + 5 项用户 v0.1 拍板 Q0-Q5 + C-6 RBAC 已落地能力 + v0.9.0 收口现状;v0.2 基于用户一次性批量拍板 Q1-Q16(13 锁 + 1 挂起 + 2 挂起待 Provider + 1 不冻结)的纯文档措辞修订;**v0.1 / v0.2 均未动任何代码 / schema / migration**)

---

**End of D7-attachments v0.2 draft.** 下一动作请按 §17 推进。
