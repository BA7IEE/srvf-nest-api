# attachments — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);配置三表边界读 [`/docs/attachment-config-boundary.md`](../../../docs/attachment-config-boundary.md);Provider / storage 见 [`/src/modules/storage/`](../storage/) 与 [`/docs/security.md`](../../../docs/security.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## 本地事实

- `attachments.service.ts` 是 **god-service(826 行)**;`attachment-audit-recorder.ts` / `attachment-validation.ts` / `mime-to-ext.ts` 已抽离。
- 多态附件主模块;`@unique key` 已加。
- **首个业务模块接入 `rbac.can()`**(管理面 rbac / config / users / audit-logs 已于 P0-F / v0.15.0 收紧;业务面除本模块外细粒度 RBAC 仍归 Slow-4;接入边界以 [`/docs/current-state.md`](../../../docs/current-state.md) §3 / §4 为准)。
- 配置三表在独立模块 `attachment-configs/`:`AttachmentTypeConfig` / `AttachmentMimeConfig` / `AttachmentSizeLimitConfig`。
- **上传内容校验(v0.44.0 findings #22/#23/#24)**:`image/svg+xml` / `text/html` / `application/xhtml+xml` 属系统永久黑名单;confirm-upload 对 JPG/PNG/WEBP/GIF/PDF 回读最多 12 字节核对魔数,不符返 `13016`;签名表外的既有 Office MIME 保持原契约。

## 不要做(踩雷区)

- ❌ **不**合并配置三表 / **不**抽 facade 层(沿 [`/docs/attachment-config-boundary.md`](../../../docs/attachment-config-boundary.md));三表保留 **override-with-default** 模式,运行时各自读点已锁定。
- ❌ **永不返回** L3 字段:`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / **完整 signed URL**(`accessUrl`);App API 任何路径都不许暴露。
  - ⚠️ **范围例外(a)——CMS 内容发布模块**(2026-06-21 维护者拍板;理由见 [`/docs/archive/reviews/content-module-review.md`](../../../docs/archive/reviews/content-module-review.md) §5.7):owner 为 `content-image` / `content-file` 两类的 `accessUrl`(签名下载 URL)**允许**在 `open/v1/contents/*`(公开)与 `app/v1/contents/*`(会员)内容读取面返回,但**仅在调用者已通过该文章的可见级校验之后**(public 档 = published+public;member / formal_member / department / management 档 = 对应可见级);短 TTL、随文章可见级。**理由**:content-\* 附件是「随文章展示的素材」(封面 / 正文图 / 公开附件),其访问由**文章可见级**闸控,而非 member / certificate 那类 owner-scoped 敏感 PII 的附件自身 RBAC。**其余 owner 类型(member / certificate / activity)维持本铁律不变**;content **写**路径(上传 / 删附件)仍走 attachments `rbac.can()`(α 决议:`attachment.{upload,delete}.content-image|content-file` coarse 码),只有**读**路径自签且仅在可见级通过后。
- ❌ **不**主动拆 `attachments.service.ts`(沿 [`/docs/current-state.md §3`](../../../docs/current-state.md))。
- ❌ **不**绕过 `attachment-validation.ts` 写入(mime / size / type 校验必经路径)。
- ❌ **不**把 `StorageProvider.readObjectPrefix` 用作文件下载/全量读取,也不因 COS `Content-Type` 声明正确而跳过 confirm-upload 魔数校验。
- ❌ **不**新增 Mixed Controller(class-level + 方法级双 `@ApiTags`)。历史 mobile-like `GET /me/uploaded`(原 `Mobile - Attachments`)已于 Route B Phase 4e 删除,未建 App 替代;`listMyUploaded` service 保留为未来 `app/v1/my/attachments` building block(沿 [`/docs/api-surface-migration-plan.md §3.3`](../../../docs/api-surface-migration-plan.md))。
- ❌ **不**把 attachment 写路径绕过 `attachment-audit-recorder.ts`。
