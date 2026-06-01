# attachments — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);配置三表边界读 [`/docs/attachment-config-boundary.md`](../../../docs/attachment-config-boundary.md);Provider / storage 见 [`/src/common/storage/`](../../common/storage/) 与 [`/docs/security.md`](../../../docs/security.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## 本地事实

- `attachments.service.ts` 是 **god-service(826 行)**;`attachment-audit-recorder.ts` / `attachment-validation.ts` / `mime-to-ext.ts` 已抽离。
- 多态附件主模块;`@unique key` 已加。
- **首个业务模块接入 `rbac.can()`**(管理面 rbac / config / users / audit-logs 已于 P0-F / v0.15.0 收紧;业务面除本模块外细粒度 RBAC 仍归 Slow-4;接入边界以 [`/docs/current-state.md`](../../../docs/current-state.md) §3 / §4 为准)。
- 配置三表在独立模块 `attachment-configs/`:`AttachmentTypeConfig` / `AttachmentMimeConfig` / `AttachmentSizeLimitConfig`。

## 不要做(踩雷区)

- ❌ **不**合并配置三表 / **不**抽 facade 层(沿 [`/docs/attachment-config-boundary.md`](../../../docs/attachment-config-boundary.md));三表保留 **override-with-default** 模式,运行时各自读点已锁定。
- ❌ **永不返回** L3 字段:`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / **完整 signed URL**(`accessUrl`);App API 任何路径都不许暴露。
- ❌ **不**主动拆 `attachments.service.ts`(沿 [`/docs/current-state.md §3`](../../../docs/current-state.md))。
- ❌ **不**绕过 `attachment-validation.ts` 写入(mime / size / type 校验必经路径)。
- ❌ **不**新增 Mixed Controller(class-level + 方法级双 `@ApiTags`)。历史 mobile-like `GET /me/uploaded`(原 `Mobile - Attachments`)已于 Route B Phase 4e 删除,未建 App 替代;`listMyUploaded` service 保留为未来 `app/v1/my/attachments` building block(沿 [`/docs/api-surface-migration-plan.md §3.3`](../../../docs/api-surface-migration-plan.md))。
- ❌ **不**把 attachment 写路径绕过 `attachment-audit-recorder.ts`。
