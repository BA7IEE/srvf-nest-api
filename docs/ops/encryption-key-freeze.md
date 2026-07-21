# Production encryption key 冻结与变更边界

> 适用：`STORAGE_ENCRYPTION_KEY`、`SMS_ENCRYPTION_KEY`、`WECHAT_ENCRYPTION_KEY`、`REALNAME_ENCRYPTION_KEY`。
> 当前版本的四个 CryptoService 都在进程启动时从单一 env key 派生并缓存 AES-256-GCM key；数据库密文没有 key version，也没有 old/new 双 key。

## 首发冻结

1. 四把 key 分别生成，至少 32 字符，值互不相同；推荐 `openssl rand -base64 32`。
2. 在任何 settings 凭证写入数据库之前确定最终值，并存入受控 secret manager。
3. API、worker、migration/bootstrap 辅助进程及蓝绿新旧实例必须注入同一代值。
4. key 与数据库备份/凭证密文分离存放，不进入 git、工单、日志、audit、响应或截图。
5. 发布票只记录 secret version/指纹或 secret-manager 引用，不记录 key 本身。

## 当前明确不支持

- 不支持在线 rotation。
- 不支持先 reset-credentials 再改 key：reset 使用当前进程缓存的旧 key 加密，新进程无法解密。
- 不支持先改 key 再靠普通 API 自动迁移：已有密文仍由旧 key 加密；Storage production bootstrap 会直接拒绝启动，其余通道会进入 `credentialStatus=invalid`。
- 不支持新旧 key 实例混跑；同一数据库上的不同 key 会产生互相不可解密的新密文。

因此，一旦任一对应密文存在，**不得直接修改 env key**。reset-credentials 只允许在 key 不变时替换上游 provider credential。

## 需要轮换时

停止常规发布，单独立 D 档设计与授权。正式方案至少必须具备：

- old key 与 new key 分离输入，均不回显。
- dry-run 解密全部目标行；任一失败则零写入。
- 用 new key 重加密并原子记录去敏证据。
- 不输出明文、密文或完整连接信息。
- 在隔离恢复副本上完成重加密、新 key production boot、API/worker smoke 与回退演练。
- 所有实例停止使用 old key 后才切生产 secret；禁止混代。

当前仓库尚未实现该工具或双-key 机制，不能把手工 SQL、临时脚本或普通 reset API 写成可用 SOP。

## 丢失或疑似泄露

- 立即按安全事件处理，停止受影响通道或使用其显式 kill switch，限制数据库与 secret-manager 访问。
- key 仍可用时先保全当前可解密能力和证据，不做即兴替换。
- key 已丢失时，旧密文不可恢复；Storage 不能用 LOCAL/smoke 绕过 production fail-fast。
- 由维护者另行批准离线重加密/凭证重建方案，并在恢复副本验证后执行。

## Release 证据

- [ ] 四把 key 的 secret-manager 版本已冻结，值互不相同。
- [ ] 所有承流 API/worker 使用同一代 key，旧实例为 0。
- [ ] Storage 离线 bootstrap 与 production boot 使用相同 key。
- [ ] 没有任何文档、日志、响应、audit 或 CI output 泄露 key/凭证。
- [ ] 本次若无轮换需求，发布票明确记录“key frozen; rotation unsupported”。
