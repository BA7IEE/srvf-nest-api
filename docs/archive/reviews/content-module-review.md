# 内容发布模块(CMS)评审稿(修订版 T0,冻结)

> **性质**:本文件是 CMS 内容发布模块(第 28 模块)T0 评审冻结档,记录开工前所有已拍板决策、字段/状态机/可见性/附件集成/号段全量,供 T1–T5 执行对照。
> **冻结时刻**:2026-06-21(维护者「按推荐 + α 确认」+ 两处冻结前修订)。
> **权威分层**:本文件是**冻结时刻**的决策依据,非当前事实源;落地后当前事实以 [`docs/current-state.md`](../../current-state.md) 为准,字段以 [`prisma/schema.prisma`](../../../prisma/schema.prisma) 为准,接口以 OpenAPI contract 为准。
> **基线**:main HEAD = `ee180f06`(v0.26.1 后最新 main,worktree HEAD==origin/main 已核);0 open PR / 工作树 clean。

---

## 0. 决策摘要(全部已拍板)

| # | 决策 | 取值 |
|---|---|---|
| 正文 | Markdown,存原始 MD + DTO 长度上限;服务端不解析/不消毒 HTML,渲染安全交前端 | 上版拍板,沿用 |
| 可见性 | 5 档(每篇选一):public / member / formal_member / department / management | 上版拍板,沿用 |
| 公示 | v1 手动(admin 发一篇内容);**不**与招新轮自动桥接 | 沿用 |
| 发布 | v1 立即生效,无 cron | 沿用 |
| D1 | `visibleOrganizationIds` 用 PG 原生 `String[]`(非 `Json?`),为 department 档 `hasSome` 过滤 | 拍板接受 |
| **A 正文图** | 上传 + 服务端读时改写(占位 `![](attachment:<id>)` → 签名 URL,随文章可见级) | 增量包拍板 |
| **B 附件** | 封面/正文图/文件附件统一为 **Attachment 行**(ownerType=`content-image`/`content-file`,ownerId=content.id),复用 attachments 机制 | 增量包拍板,**推翻原「storage key 不进 Attachment」** |
| **α 权限模型** | 写(上传/删附件)复用 `AttachmentsService` 的 `rbac.can()`(加 4 个 coarse `attachment.{upload,delete}.content-*` 码);读自签 + 文章可见级闸 | **维护者 α 确认** |
| 命名 | kebab:`content-image` / `content-file`(对齐既有 attachment code/权限码体系;非增量包草拟的 snake) | 拍板接受 |
| 封面 | contents 表反范式双指针 `coverImageKey`(列表缩略图直签)+ `coverAttachmentId`(标记/换/清) | 决定② |
| **C 阅读量** | `viewCount Int @default(0)`,仅详情(可见级通过的 published)原子 `{increment:1}`;列表/admin 预览/404 不计;v1 累计 PV | 增量包拍板 |
| **D 搜索** | 读取面 `keyword` 参数,Postgres `ILIKE` 标题+正文,**AND 可见性**(绝不旁路 5 级可见) | 增量包拍板 |
| **E 标签** | `tags String[]`,读取面 `hasSome` 筛选,**AND 可见性** | 增量包拍板 |
| 例外(a) | content-* 签名 URL 在过文章可见级后**允许**在 open/v1 + app/v1 返回(范围例外,见 §5.7);已 true-up [`attachments/CLAUDE.md`](../../../src/modules/attachments/CLAUDE.md) | **冻结前修订②** |
| BizCode 基数 | **164**(2026-06-21 亲核;非陈旧的 141)→ content +5 → **169**;已 true-up biz-code 文件头 | **冻结前修订①** |

**重要更正(影响工作量)**:`AttachmentOwnerType` **不是 Prisma enum**——是 TS 常量数组 `ATTACHMENT_OWNER_TYPES`([`attachment-validation.ts:18`](../../../src/modules/attachments/attachment-validation.ts:18)),`Attachment.ownerType` 是 `String` 列。**故加 content-image/content-file 无 enum migration**,仅改 TS 数组 + service 两处分支 + seed 配置行。唯一 migration = `contents` 新表。

---

## 1. 背景与范围

- **目标**:新增 `content/` 第 28 模块,提供公告/公示/简报/推文的发布与多级可见消费,平铺加,复用 dictionaries / attachments / storage / RBAC / audit / 软删 / 统一返回。
- **触及既有模块(均为增量、不改既有行为)**:`attachments`(+2 owner 类型分支 + 1 可信只读方法 + export service)、`prisma/seed.ts`(+content_type 字典 + content.* 权限码 + attachment.content-* 权限码 + 2 条 AttachmentTypeConfig)、`biz-code.constant.ts`(+290xx 段 5 码)、`audit-logs.types.ts`(+4 事件)、throttler config(+1 实例)。
- **本期不做(§10)**:content_reads 已读回执 / 点赞·评论 / 定时发布·cron / UV·时序分析 / 部长角色·部门级内容权限细分 / 招新公示自动桥接 / attachment Mime·SizeLimit override 行 / 正文图 client 端 key 解析。

---

## 2. schema:`contents` 表(冻结)

```prisma
model Content {
  id        String    @id @default(cuid())
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?

  title           String   // DTO ≤ 200
  summary         String?  // DTO ≤ 500
  body            String   // PG text;Markdown 原文,含 ![](attachment:<attachmentId>) 占位;DTO ≤ 50000
  contentTypeCode String   // ∈ content_type 字典 item(announcement/publicity/briefing/post)
  statusCode      String   // draft / published / archived(String 常量,无 enum)
  visibilityCode  String   // public / member / formal_member / department / management

  visibleOrganizationIds String[]  @default([]) // department 档可见部门 orgId 数组(D1:String[] 非 Json,为 hasSome)
  tags                   String[]  @default([]) // E:标签,hasSome 筛选

  coverImageKey     String? // 封面反范式 storage key(列表缩略图直签,免 per-row Attachment 查询)
  coverAttachmentId String? // 封面对应 content-image 附件 id(标记/换/清;不建 FK)

  viewCount Int @default(0) // C:累计 PV

  pinned       Boolean   @default(false)
  publishedAt  DateTime? // publish 时置 now;unpublish 保留;draft 从未发布则 null
  authorUserId String?   // 创建/操作 admin;不建 FK(沿招新 reviewedByUserId 惯例)

  @@index([statusCode])
  @@index([visibilityCode])
  @@index([contentTypeCode])
  @@index([publishedAt])
  @@index([pinned])
  @@index([deletedAt])
  @@index([createdAt])
  @@index([statusCode, publishedAt]) // 公开/会员列表常用:published 按发布时间序
  // tags 的 GIN 索引在 migration.sql 末尾手写(Prisma DSL 不直接表达 String[] GIN)
  @@map("contents")
}
```

要点:
- `body` 用 plain `String`(PG 下即 `text`,无长度限制;`@db.Text` 在 PG 是 no-op,沿仓内长文本惯例,长度交 DTO)。
- 软删沿仓内 `deletedAt` 惯例;所有读 where 显式 `deletedAt: null`。
- 附件**不在** contents 表(走 Attachment 行 ownerType+ownerId);`coverImageKey`/`coverAttachmentId` 是封面的反范式指针(决定②)。
- migration:仅新增 `contents` 表 + 末尾手写 `tags` GIN 索引;**无** attachment enum migration(ownerType 是 TS 常量 + String 列)。

---

## 3. 状态机(admin 动作,立即生效无 cron)

```
create ──▶ draft
draft ──publish──▶ published        // 置 publishedAt = now
published ──unpublish──▶ draft       // publishedAt 保留(= 上次发布时刻)
published ──archive──▶ archived      // 终态,不可逆(除软删)
update(标题/正文/摘要/类型/可见性/标签/封面): 允许 draft + published;archived 冻结禁改
delete(软删): 任意态
```
- 非法跃迁(如 archive 一个 draft、unpublish 一个 draft、改 archived)→ `29030 CONTENT_INVALID_STATUS_TRANSITION`。
- 无 unarchive;archived 仅可软删。
- 状态机内嵌 service(沿招新范式,statusCode 为 String,无需独立 StateMachine 类;若 T2 实装时复杂度超招新可抽 `content.state-machine.ts` 纯函数)。

---

## 4. 可见性模型 + 读取过滤(冻结)

### 4.1 caller context(读取面一次性解析,async)
- `isMember` = canUseApp(`currentUser.memberId != null` && User ACTIVE && Member ACTIVE,沿 `AppIdentityResolver`)
- `isFormalMember` = 存在活跃 `member_department`(`deletedAt: null` 且 org ACTIVE 且 org 未软删)
- `activeOrgIds` = 上述活跃 `member_department.organizationId` 数组
- `isManagement` = `rbac.can(currentUser, 'content.read.record')` ∨ role ∈ {SUPER_ADMIN, ADMIN}

### 4.2 纯函数(单测靶子,`content.visibility.ts`)
```ts
// app/v1 详情:仅 published 可见,再按 visibilityCode 分档
canSeeContent(ctx, c): boolean =>
  c.statusCode === 'published' && (
    c.visibilityCode === 'public'        ? true :
    c.visibilityCode === 'member'        ? ctx.isMember :
    c.visibilityCode === 'formal_member' ? ctx.isFormalMember :
    c.visibilityCode === 'department'    ? ctx.activeOrgIds.some(id => c.visibleOrganizationIds.includes(id)) :
    c.visibilityCode === 'management'    ? ctx.isManagement :
    false /* 未知档 fail-close */
  )
```

### 4.3 list where(分页正确性靠 DB 过滤,不靠读后内存过滤)
- **app/v1**(准入 = canUseApp,否则 403):
```ts
where: {
  deletedAt: null,
  statusCode: 'published',
  OR: [
    { visibilityCode: 'public' },
    ...(ctx.isMember        ? [{ visibilityCode: 'member' }] : []),
    ...(ctx.isFormalMember  ? [{ visibilityCode: 'formal_member' }] : []),
    ...(ctx.activeOrgIds.length ? [{ visibilityCode: 'department', visibleOrganizationIds: { hasSome: ctx.activeOrgIds } }] : []),
    ...(ctx.isManagement    ? [{ visibilityCode: 'management' }] : []),
  ],
  // D 搜索:AND { OR:[{title contains insensitive},{body contains insensitive}] }
  // E 标签:AND { tags: { hasSome: [...] } }
}
```
- **open/v1**(`@Public`):`{ deletedAt: null, statusCode: 'published', visibilityCode: 'public' }`(+ keyword/tags AND);detail 命中非 published+public → `NOT_FOUND`(不区分「存在但不可见」,防枚举)。
- **admin/v1**:无可见性过滤,见全部状态+全部可见档,支持 status/type/visibility/keyword/tags/pinned 过滤。

> `management` 档主要由 admin/v1 承载;app/v1 仅「既是 app 会员、又持 `content.read.record`」的边角能见(已文档化,非 bug)。

---

## 5. 附件集成(A/B,α 决议,核心)

### 5.1 owner 类型(kebab,拆两类)
- `content-image`:封面 + 正文图;默认 MIME `image/jpeg`,`image/png`,`image/webp`;默认上限 ~10 MB。
- `content-file`:文件附件;默认 MIME `application/pdf` + docx/xlsx(`application/vnd.openxmlformats-officedocument.*`);默认上限 ~20 MB。
- 两者 `ownerId` = `content.id`(同 `contents` 表)。

### 5.2 attachments 模块的增量改动(全部新增分支,既有 owner 行为零变,由其既有 e2e 锁定)
1. [`attachment-validation.ts`](../../../src/modules/attachments/attachment-validation.ts):`ATTACHMENT_OWNER_TYPES` += `'content-image'`,`'content-file'`。
2. [`attachments.service.ts`](../../../src/modules/attachments/attachments.service.ts) `assertOwnerExists`:+ content 分支 → 查 `prisma.content`(存在且 `deletedAt: null`)。
3. `attachments.service.ts` `buildRbacResourceAndScope`:content-* 走 coarse(`{ resource: undefined, scope: null }`,同 activity)→ action = `attachment.upload.content-image` 等。
4. **新增** `resolveOwnerAttachments(ownerType, ownerId)`:**可信只读**(无 RBAC),返回 `{ id, kind, mime, originalName, size, accessUrl(签名) }[]`,供 content 读取面在**可见级通过后**调用(reuse `resolveAccessUrl` 签名)。
5. `AttachmentsModule` **export** `AttachmentsService`;content 模块 import 之。

### 5.3 写路径(上传/确认/删,admin)— 复用 `AttachmentsService` RBAC 强制
- 上传走 Mode B presigned 两步:`createUploadUrl` → `confirmUpload`(reuse 全套 9 步校验:ownerType / owner 存在 / MIME / size / PII / key 生成 / uploadToken / provider / Attachment 行 + audit `attachment.upload`)。
- 删走 `delete`(物理删 + audit `attachment.delete`)。
- 这些方法在 Service 层判 `attachment.{upload,delete}.content-image|content-file`(coarse,绑 biz-admin)。
- **owner 先存在**:上传前 content 草稿必须已建(`assertOwnerExists` 查 `prisma.content`)→ 「先建草稿拿 content.id,再传图/附件」流程;`confirmUpload` 再次 `assertOwnerExists`(F10 防 owner 间隔软删)。

### 5.4 读路径(open/app/admin)— content 自签 + 文章可见级
- content 读取面**不走** attachments 自带鉴权下载端点;调用 `resolveOwnerAttachments` 拿已签 URL,**仅在文章可见级通过后**返回 → 公开读者(零权限)也能看公开文章的图/附件,附件继承文章可见级。

### 5.5 正文图占位 + 读时改写(wrinkle A)
- 占位:`![alt](attachment:<attachmentId>)`。
- 改写纯函数 `rewriteBody(body, idToUrlMap)`:把 `attachment:<id>` 替换为签名 URL;`idToUrlMap` 来自 `resolveOwnerAttachments('content-image', contentId)`。
- **安全**:只改写**属于本文章**的 content-image 附件 id;外来/未知 id 原样保留(渲染坏图,零越权)。

### 5.6 封面(决定②)
- 上传为一条 content-image 附件;`PUT admin/v1/contents/:id/cover {attachmentId|null}` 把该附件设/清为封面 → 写 `coverImageKey`(直签,列表缩略图免查 Attachment)+ `coverAttachmentId`(管理)。
- 列表回显封面缩略图:对每行 `coverImageKey` 本地签名(presigned 是本地 crypto,无网络,无 N+1 DB 查询)。

### 5.7 范围例外(a)——「App 不返 signed URL」铁律的 content-* 豁免
- **铁律**(现状,[`attachments/CLAUDE.md`](../../../src/modules/attachments/CLAUDE.md) / [`current-state.md §2.1`](../../current-state.md)):App API 永不返回完整 signed URL(`accessUrl`)。
- **例外(a)**(本模块,2026-06-21 拍板):owner = `content-image` / `content-file` 的 `accessUrl` **允许**在 `open/v1/contents/*` + `app/v1/contents/*` 内容读取面返回,**仅在调用者已过该文章可见级校验之后**(public 档 = published+public;其余档 = 对应可见级),短 TTL、随文章可见级。
- **理由**:content-* 附件是「随文章展示的素材」(封面/正文图/公开附件),非 member/certificate 那类 owner-scoped 敏感 PII;其访问由**文章可见级**闸控,而非附件自身 RBAC。`passwordHash`/token/secret/其余 owner signed URL 维持永不暴露;content **写**路径仍走 attachments RBAC。
- **落点**:已 true-up `attachments/CLAUDE.md`;T5 docs 收尾把 `current-state.md §2.1` 的「完整 signed URL」铁律行加 content-* 例外交叉引用(AGENTS / api-surface-policy 若有同义铁律一并 T5 交叉引用)。

### 5.8 已知 v1 限制
- content 软删**不级联**附件:attachments 是物理删(Q11),content 软删后其 content-* 附件 blob 成孤儿(无害,文章已从读查询消失)→ 走 retention SOP 手动清(镜像招新证件照口径,不解锁 cron)。

---

## 6. C 阅读量 / D 搜索 / E 标签

- **C viewCount**:详情端点(open/v1 + app/v1,可见级通过的 published)在**返回前**对该行 `viewCount: { increment: 1 }`(非事务,独立 update;失败不阻断返回);列表 / admin 预览 / 可见级不通过(404)/ draft·archived **不计**;admin 列表+详情回显 `viewCount`。v1 = 累计 PV,无去重/UV/时序。
- **D 搜索**:list DTO `keyword?`(限长,如 ≤ 64);Prisma `OR:[{title:{contains,mode:'insensitive'}},{body:{contains,mode:'insensitive'}}]`,与可见性 where **AND**;无新依赖、不上 FTS。性能:body ILIKE 无专用索引顺扫,v1 体量可接受(NEXT_TASKS 标性能观察)。
- **E 标签**:`tags String[]`;list DTO `tags?: string[]` → `{ tags: { hasSome } }` 与可见性 **AND**;admin create/update 设标签(DTO 限每标签长度 + 数量,如 ≤ 16 个 / 每个 ≤ 32 字)。

---

## 7. 号段全量(从零重算,冻结)

| 维度 | 增量 | 终值 | 落点 |
|---|---|---|---|
| **权限码** | **+9** | 146 → **155** | content.* **5**(`content.{read,create,update,delete,publish}.record`)+ `attachment.{upload,delete}.content-image` 2 + `attachment.{upload,delete}.content-file` 2;**全绑 biz-admin**(57 → **66**);ops-admin 63 / member 9 不变;app/open 读零码 |
| **BizCode** | **+5** | 164 → **169**,290xx 段 | 29001 NOT_FOUND / 29010 TYPE_INVALID / 29011 VISIBILITY_INVALID / 29012 VISIBLE_ORG_INVALID / 29030 INVALID_STATUS_TRANSITION;291xx 权限边界预留(暂不用,RBAC 统一 30100);**附件错误复用 13xxx**(13010/11/12/13/15/33);搜索/标签非法走 400 无码 |
| **Audit DB union** | **+4** | 57 → **61** | `content.create` / `content.update`(含 set-cover via extra.operation)/ `content.delete` / `content.publish`(伞:publish/unpublish/archive via extra.operation + before/after statusCode);**附件上传/删复用 `attachment.upload`/`attachment.delete`**;无新 placeholder;读取/viewCount 不写 audit |
| **字典** | +1 type | — | content_type(label「内容类型」)+ 4 items announcement/publicity/briefing/post(label 占位待运营);sortOrder 取下一空位(T1 亲核) |
| **attachment config** | +2 TypeConfig | — | content-image(jpeg/png/webp,~10MB)+ content-file(pdf/docx/xlsx,~20MB);默认值写 TypeConfig.defaultMimeWhitelist/defaultMaxSizeBytes,v1 不开 Mime/SizeLimit override 行 |
| **Throttler** | +1 | 第 10 实例 | content-public(open/v1 读,建议 IP 60/60s) |
| **controller** | +3 | 46 → **49** | ContentAdminController / ContentAppController / ContentPublicController(附件端点挂 ContentAdminController) |
| **endpoint** | **+16** | 212 → **228** | admin 12 + app 2 + open 2(见 §8) |
| **migration** | +1 | 21 → **22** | 仅 `contents` 表(+ tags GIN);无 attachment enum migration |
| **CODEMAP 模块** | +1 | 27 → **28** | `content/` |
| **e2e 附件权限计数** | +4 | 20 → **24** | `seed-attachment-permissions.e2e`(content-image 2 + content-file 2);`attachments.e2e` + 2 content type config fixture |

> 落地时以 `pnpm test` / `docs:rbacmap:check`(155)/ `docs:codemap:check`(28)/ contract 路由数实跑亲核为准;本表为冻结预算。RBAC_MAP.md + check-rbac-map 须为 4 个 `attachment.content-*` 码 true-up(镜像既有 activity coarse 码的动态构造处理)。

---

## 8. 端点清单(冻结预算,实装亲核)

**Admin `admin/v1/contents`(ContentAdminController,12)**
| 方法 路径 | 用途 | 权限 |
|---|---|---|
| POST `/` | 建草稿 | content.create.record |
| GET `/` | 列表(status/type/visibility/keyword/tags/pinned 过滤) | content.read.record |
| GET `/:id` | 详情(含附件签名 URL + 正文改写预览 + viewCount,不增) | content.read.record |
| PATCH `/:id` | 更新 | content.update.record |
| DELETE `/:id` | 软删 | content.delete.record |
| POST `/:id/publish` | 发布 | content.publish.record |
| POST `/:id/unpublish` | 撤回 | content.publish.record |
| POST `/:id/archive` | 归档 | content.publish.record |
| POST `/:id/attachments/upload-url` | 取上传 URL(kind=image\|file) | attachment.upload.content-*(service) |
| POST `/:id/attachments/confirm` | 确认上传 | uploadToken match(service) |
| DELETE `/:id/attachments/:attachmentId` | 删附件 | attachment.delete.content-*(service) |
| PUT `/:id/cover` | 设/清封面 {attachmentId\|null} | content.update.record |

**App `app/v1/contents`(ContentAppController,2;准入 canUseApp,可见性过滤)**
| GET `/` 列表 / GET `/:id` 详情(+viewCount 自增) | 无码,可见级闸 |

**Open `open/v1/contents`(ContentPublicController,2;`@Public` + content-public throttle)**
| GET `/` 列表(published+public) / GET `/:id` 详情(published+public,+viewCount 自增,否则 NOT_FOUND) | 无码 |

---

## 9. DoD → e2e 映射(自证锚点)

- migration 干净库重放 + seed 二跑幂等(含 content_type 字典 + 9 权限码 + 2 attachment config)。
- admin CRUD + 状态机各分支(publish/unpublish/archive + 非法跃迁 29030)。
- **附件**:Mode B 上传/confirm/删;content type config MIME/size 闸(命中/超限/黑名单)+ PII 闸(13015)+ owner 先存在(先草稿后传,无草稿 13011)。
- **正文图**:占位读时改写(本文章命中替换 / 外来 id 不泄露);封面 key 反范式 + 列表缩略图签名。
- open/v1:只见 published+public;detail 防枚举(非命中 NOT_FOUND);防注入(DTO 白名单 + 分页上限);零敏感(无 authorUserId/草稿/内部字段)。
- **app/v1 五可见档**:public/member/volunteer(无部门)/formal_member/department 命中/department 不命中/management 边角——命中可见、**不命中看不到**(看不到不该看的)。
- **viewCount**:详情 +1 / 列表·404·draft·archived 不计。
- **搜索 + 标签**:与可见性 AND,绝不旁路(公开面搜不到非 public、会员面搜不到越档)。
- **范围例外(a)**:content-* 签名 URL 仅在可见级通过后出现;其余 owner 仍不在 App 出 signed URL。
- 现有模块零行为漂移:attachments 既有三类型 e2e 全绿;全绿(unit / e2e / contract / rbacmap 155 / codemap 28)。

---

## 10. 本期不做(明确划出)

content_reads 已读回执 · 点赞 / 评论 · 定时发布 / 新 cron · UV / 时间序列分析 · 部长角色 / 部门级内容权限细分 · 招新公示自动桥接 · attachment Mime/SizeLimit override 行(v1 用 TypeConfig 默认值)· 正文图 client 端 key 解析(v1 服务端改写)· content 软删级联附件(走 retention SOP)· 小程序前端。

---

## 11. 授权与红线

- **授权**:schema/migration/seed(D 档,解除 A-3/A-4)+ 新 `content/` 模块 + `open/v1/contents` 公开面(open/v1 已解锁,本模块加端点;api-surface §0 随 PR true-up)+ **attachments 集成**(增量包推翻原「不进 Attachment」,授权 +2 owner 类型分支 + 可信只读方法 + export + attachment-config seed + 4 attachment.content-* 权限码)+ 范围例外(a)+ 相关文档 true-up。
- **红线(不破)**:定时发布 / 新 cron;部长角色 / 部门级内容权限;招新公示自动桥接;评论 / 统计(viewCount 除外,已授权);**改既有 owner 类型(member/certificate/activity)行为**(仅新增分支);合并 attachment 配置三表 / 抽 facade / 新增第二处直读三表(content 经 AttachmentsService,不直读三表);为 AttachmentSizeLimitConfig 补 status。
- **偏离/遇未决** → 人话简报停(process §4.1)。

---

## 12. 执行顺序(T1–T5)

- **T1** schema:`contents` 表 + migration(+tags GIN)+ seed(content_type 字典 + 5 content.* + 4 attachment.content-* 全绑 biz-admin + 2 AttachmentTypeConfig)+ attachments 模块 owner 分支/可信只读/export。干净库重放 + seed 二跑幂等。
- **T2** admin 面:CRUD + 状态机 + 附件(upload-url/confirm/删 + cover)+ audit。
- **T3** open 面:list + detail(published+public,@Public + content-public throttle,防注入/防枚举/零敏感)。
- **T4** app 面 + 可见性:list + detail(canUseApp 准入 + 5 档过滤纯函数 + 正文改写 + 附件签名 + viewCount)。
- **T5** docs 收尾:current-state §2/§2.1(含例外 a 交叉引用)/§3 + CHANGELOG + NEXT_TASKS + 本评审稿引用 + api-surface §0(open/v1 含 content)+ RBAC_MAP(155)+ CODEMAP(28)。
