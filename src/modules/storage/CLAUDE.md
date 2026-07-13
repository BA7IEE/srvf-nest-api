# modules/storage — 本地铁律(2026-06-11 自 src/common 区旧址全量迁入,B 队列评审稿 §3;纯搬迁零行为)

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);附件配置三表边界读 [`/docs/attachment-config-boundary.md`](../../../docs/attachment-config-boundary.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);安全章节读 [`/docs/security.md`](../../../docs/security.md)。本文件**只**记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **storage 抽象层**:`StorageProvider` 接口(6 方法:putObject / deleteObject / generateUploadUrl / generateDownloadUrl / headObject / `readObjectPrefix`)+ `LocalStorageProvider` + `CosStorageProvider`(腾讯云 COS);`readObjectPrefix` 仅供 confirm-upload 魔数校验,固定小前缀,COS 必须 ranged getObject,不得扩成通用下载面(finding #23)
- **动态路由** `StorageProviderRouter`:每次方法调用 `resolve()` 根据 `storage_settings.providerType` 切换 provider;`STORAGE_PROVIDER` DI token = `useExisting StorageProviderRouter`(沿 [`storage.module.ts:37`](storage.module.ts:37))
- **配置 singleton** `storage_settings` row(沿 §6.5.4)+ `StorageSettingsService` 60s 缓存 + 主动 invalidate
- **凭证加密** `StorageCryptoService`(AES-256-GCM)+ **uploadToken HMAC-SHA256**(`upload-token.util.ts`,签名 key 由 `STORAGE_ENCRYPTION_KEY` scrypt 派生)
- **Storage Settings admin**:`GET / PATCH / POST reset-credentials` 三端点,经 `rbac.can()` 判权
- **不负责**:附件业务流(在 [`/src/modules/attachments/`](../../modules/attachments/));附件配置三表(在 [`/src/modules/attachment-configs/`](../../modules/attachment-configs/))

## Local facts

- **production fail-fast 5 项严格校验**(`onApplicationBootstrap`,仅 `env === 'production'` 触发 — smoke / dev / test 全部跳过):settings 存在 / `enabled=true` / `providerType='COS'`(production 拒绝 LOCAL) / `bucket+region` 非空 / `credentialStatus=CONFIGURED`(沿 [`storage-settings.service.ts:84`](storage-settings.service.ts:84))
- **凭证加密 算法/key 派生**:AES-256-GCM + `scrypt(envKey, fixedSalt, 32)` 派生 32 字节 key;序列化 `base64(iv:12B || authTag:16B || ciphertext)`(沿 [`storage-crypto.service.ts:19`](storage-crypto.service.ts:19))
- **`credentialStatus` 三档**:`MISSING`(无凭证字段)/ `CONFIGURED`(解密成功)/ `INVALID`(解密失败 / `STORAGE_ENCRYPTION_KEY` 被轮换)
- **`StorageSettingsService` 是凭证读取唯一出口**:`getActiveSettings()` 60s 内存缓存 + DB > 1 条时 WARN + 取 createdAt 最早一条(singleton 由 PR #11 后台 CRUD 守护;DB 层不强制)
- **`CosStorageProvider` 4 档守护**(每次方法调用):settings null / providerType ≠ COS / credentialStatus ≠ CONFIGURED / bucket+region 缺失 → 抛 `CosProviderUnavailableError`(沿 [`providers/cos.provider.ts:158`](providers/cos.provider.ts:158))
- **`LocalStorageProvider.resolveKey`** 防 `../` 逃逸 root(沿 Q-88-6;[`providers/local.provider.ts:113`](providers/local.provider.ts:113));dev/test 默认 fallback,production 启动期被 fail-fast 拒绝
- **signed URL**:COS PUT 上传约定客户端必须带 `Content-Type` 与签名一致;`response-content-disposition` 通过 query 参数附加(沿 §6.4.6 CORS);Local provider 返非路由 stub URL(`/internal/storage/local-stub-upload/...`;接口对称用,不会被实际命中)
- **uploadToken** 紧凑格式 `<base64url(claims)>.<base64url(hmac)>`,**不**引 jsonwebtoken;HMAC key 由 `STORAGE_ENCRYPTION_KEY` 经 scrypt 派生(单独 salt);验签 `timingSafeEqual`;失败统一映射 `13001`(信息泄漏防御)
- **入口判权当前事实**:`StorageSettingsController` 三端点入口仅 `JwtAuthGuard`,**不**挂 `@Roles`,经 Service 内 `rbac.can()`;`storage-setting.reset.credentials` 当前**未**绑 `ops-admin`,仅 SUPER_ADMIN 经 `RbacService.can` 短路通过(沿 P0-F PR-2B D2=A);此处仅作为当前事实记录,**不得**在 docs-only PR 中改变权限策略
- **credential write audit 当前事实(2026-07-13 第六刀)**:`PATCH` 与 `reset-credentials` 均与 settings 行写入在同一事务记录 `storage-setting.update` / `storage-setting.reset-credentials`;update 只记非敏感 `changedFields` 字段名,reset context 严格只有请求元数据,**不**传 before/after/extra,明文 / 密文 / SecretId / SecretKey / signed URL 永不入 audit。
- **`accessUrl` 字段语义**:`attachments` 模块的 response field;Provider 接通后由 `generateDownloadUrl` 生成,解析失败统一**降级返 null**,不向 client 抛凭证状态;**不**写入 audit snapshot(沿 [`attachments.service.ts:93`](../../modules/attachments/attachments.service.ts:93))
- **0 新依赖**:仅 `crypto` 原生 + `cos-nodejs-sdk-v5`(已在 package.json);**不**新增 lru-cache / node-cache / jsonwebtoken / ms

## Risk points (不要做)

- ❌ **不**把 `secretId` / `secretKey` / `credentials` / 完整 signed URL / `accessUrl` 写入日志 / audit / OpenAPI 示例 / e2e fixture / 文档示例 / pino logger fields
- ❌ **不**把 `accessUrl` / signed URL 写入 audit `extra` / snapshot;`accessUrl` 解析失败必须**降级 null**,不向 client 抛凭证状态
- ❌ **不**绕过 `StorageProviderRouter.resolve()` 直接注入 `CosStorageProvider` / `LocalStorageProvider` 到业务模块(动态路由是显式拍板,沿 Q-89-1 A);上游业务请走 `STORAGE_PROVIDER` token
- ❌ **不**绕过 `onApplicationBootstrap` production fail-fast 5 项校验(允许 LOCAL 在 prod / 跳过 `credentialStatus=CONFIGURED` 校验等都不行)
- ❌ **不**替换 AES-256-GCM 算法 / 改 scrypt 派生参数 / 改固定 salt — 改动会让既有 ciphertext 全部转 `INVALID`,需独立设计 PR + 凭证迁移 SOP
- ❌ **不**自动引入 multipart upload(Q13)/ STS(Q19)/ 跨 provider migration / test-connection 端点 / queue/cron 清理任务 — 任一需独立设计决议
- ❌ **不**对 COS / Local 行为差异做"对称化"假定:Local `generateUploadUrl` 返 stub URL 不会被实际命中;Local `headObject` 不返 etag / contentType(未持久化)
- ❌ **不**给 `storage-settings` GET / PATCH response **回显**任何凭证字段(`secretIdEncrypted` / `secretKeyEncrypted` / `credentials` 均不出参,沿 §6.6.2 / §6.6.5)
- ❌ **不**缓存 COS 客户端实例(沿 Q-89-2 A;每次方法调用新建 SDK 实例,settings cache 已削减 DB 压力)
- ❌ **不**新建非 `app.config.ts` 的 storage env 读取点 — 唯一入口是 `appConfig.storage.encryptionKey` / `appConfig.storage.localRoot`
- ❌ 改 storage 行为通常影响 attachments / attachment-configs / production safety,按 D 档降速;**任何凭证 / 加密 / fail-fast 改动都不是 docs-only**

## Validation

- `pnpm lint` + `pnpm typecheck`
- `pnpm test` — 覆盖 `storage-crypto.service.spec.ts` / `storage-provider.router.spec.ts` / `storage-settings.service.spec.ts` / `upload-token.util.spec.ts` / `providers/*.spec.ts`
- `pnpm test:e2e -- attachments` — 覆盖经 `STORAGE_PROVIDER` 的附件上传 / 下载 / 删除路径
- 涉及 Storage Settings 端点 → 还需跑 storage-settings 相关 e2e(若存在)+ `pnpm test:contract`
- 改 DTO 字段 / endpoint path / Swagger schema / 错误码 → 必须再跑 `pnpm test:contract`
