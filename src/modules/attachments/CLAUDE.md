# attachments — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);配置三表边界读 [`/docs/attachment-config-boundary.md`](../../../docs/attachment-config-boundary.md);Provider / storage 见 [`/src/common/storage/`](../../common/storage/) 与 [`/docs/security.md`](../../../docs/security.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## 本地事实

- `attachments.service.ts` 是 **god-service(826 行)**;`attachment-audit-recorder.ts` / `attachment-validation.ts` / `mime-to-ext.ts` 已抽离。
- 多态附件主模块;`@unique key` 已加。
- **业务级 `rbac.can()` 接入的首批(且目前唯一)模块**。
- 配置三表在独立模块 `attachment-configs/`:`AttachmentTypeConfig` / `AttachmentMimeConfig` / `AttachmentSizeLimitConfig`。

## 不要做(踩雷区)

- ❌ **不**合并配置三表 / **不**抽 facade 层(沿 [`/docs/attachment-config-boundary.md`](../../../docs/attachment-config-boundary.md));三表保留 **override-with-default** 模式,运行时各自读点已锁定。
- ❌ **永不返回** L3 字段:`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*` / **完整 signed URL**(`accessUrl`);App API 任何路径都不许暴露。
- ❌ **不**主动拆 `attachments.service.ts`(沿 [`/docs/current-state.md §3`](../../../docs/current-state.md))。
- ❌ **不**绕过 `attachment-validation.ts` 写入(mime / size / type 校验必经路径)。
- ❌ **不**新增 Mixed Controller;Mobile / App 兼容入口走 `controllers/attachments-me-legacy.controller.ts`(已拆,沿 P1-C step 2)。
- ❌ **不**把 attachment 写路径绕过 `attachment-audit-recorder.ts`。
