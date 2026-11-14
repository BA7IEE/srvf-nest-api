# storage — 配置、凭证与 Effect

业务只注入 STORAGE_PROVIDER（useExisting StorageProviderRouter），不直接注入 COS/Local。
附件业务与配置三表分别归 attachments/attachment-configs。

- 每次调用 live-read 一份 settings snapshot，绑定本次 Effect并新建 SDK；
  StorageSettingsService 是凭证读取唯一出口，无跨请求客户端/权限/配置缓存。
  DB constant unique 保证 singleton，首配竞争 P2002 后重跑事务，不“取最早+WARN”。
- production 启动必须 settings 存在、COS、bucket/region 非空、credentialStatus=CONFIGURED。
  enabled=false 只放行控制面启动并 WARN，普通 pinned/non-pinned put/delete/sign/head/read
  （含 worker）全部拒绝；仅人工复核的 manual_relocate 证据采集可显式绕过。
- production 建立 location 后普通 PATCH 不改 providerType/bucket/region；
  同值、enabled/TTL/remarks/同 location credentials 可改。
  relocation 须独立 inventory/copy/hash/cutover/rollback 流程。
- non-pinned COS 每次检查 settings、enabled、COS 类型、凭证状态、bucket/region；
  不满足抛 CosProviderUnavailableError。pinned Provider 用历史 locator，Router 仍先检查 enabled。
  production 运行时 null/LOCAL/unknown fail-closed；dev/test/smoke 的 null/LOCAL 才能 fallback。
- Local resolveKey 防 `../` 逃逸。Local upload URL 是非路由 stub，head 不提供未持久化的 etag/contentType；
  不强行与 COS 对称。COS PUT 的 Content-Type 必须匹配签名，下载 disposition 走 query。
  readObjectPrefix 只读固定小前缀供魔数校验，COS ranged getObject，不扩成下载接口。

## 密钥与审计

AES-256-GCM，scrypt(envKey,fixedSalt,32)，序列化 base64(iv12B+tag16B+ciphertext)。
算法、salt、派生参数或密钥变化可能让旧密文 INVALID，必须带独立凭证迁移方案。
credentialStatus 为 MISSING/CONFIGURED/INVALID；状态来自字段存在及实际解密结果。
uploadToken 使用独立 salt 派生的 HMAC-SHA256，格式 base64url(claims).base64url(hmac)，
timingSafeEqual 验签，失败统一13001，不引 jsonwebtoken 或新缓存依赖。

settings 三端点 service 判权；reset.credentials 仅 SA，不给 ops-admin 自动授码。
PATCH/reset 与行写同事务 audit；update 只记非敏感 changedFields，
reset 仅请求元数据，无 before/after/extra。凭证明文/密文、SecretId/Key、完整 signed URL/accessUrl
不进响应、日志、审计、Swagger 或示例。附件 accessUrl 解析失败降级 null，不暴露凭证状态。

## 离线 bootstrap

只初始化空 COS+enabled singleton，默认不覆盖，dry-run 零写。
窄配置仅复用 app.config 的 APP_ENV/key parser；文件无 group/other 权限，
显式 databaseUrl 只准 public schema，库名与 confirm-database 完全一致；
仅 production 或 test+app_test*。同事务读回并用当前 key 解密验证，输出不含 URL/凭证。
不新增常驻 env 读取点、multipart/STS、test-connection、迁移或清理调度能力。

改此层验证 crypto/router/settings/upload-token/providers 与受影响附件 E2E；
端点/DTO 改动再跑 contract。来源与生产规程见 `docs/security.md`、相关 ops SOP。
