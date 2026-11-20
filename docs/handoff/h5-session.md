# H5 同源 HTTPS 会话

这是后端 Draft PR 的对接说明，不代表已上线。字段和错误响应见 [OpenAPI](openapi.json)；
现有 JSON 登录客户端和 `open/v1` 无账号链均无需改动。

| 操作 | 相对路径 | 前端处理 |
|---|---|---|
| 密码登录 | `POST /api/auth/v1/h5/login` | 用现有密码登录字段提交 JSON。成功后只把短期 access JWT 放在内存，浏览器自行接收 Cookie。 |
| 启动或续登 | `POST /api/auth/v1/h5/refresh` | 无请求体，无需 access JWT。成功后替换内存中的 access；HTTP 401 / `10007` 清 Cookie，转登录页，不盲目重试。 |
| 退出 | `POST /api/auth/v1/h5/logout` | 无请求体，无需 access JWT。成功时撤销该续登 family 并清 Cookie。无 Cookie 或已撤销也成功；网络错误或 5xx 不代表服务端已退出。 |

- 使用相对 URL 和 `credentials: 'same-origin'`（`fetch` 默认值）。不要手动设置 `Origin`、`Cookie` 或尝试读 `Set-Cookie`；这些由浏览器处理。业务 API 仍用 `Authorization: Bearer …`。不把 access 或续登凭证写进 Web Storage、URL 或日志。
- `__Host-srvf_h5_refresh` 始终为 `HttpOnly; Secure; SameSite=Strict; Path=/`，无 `Domain`。`Expires` 对齐 family 的原始绝对到期时间（HTTP 日期为秒级）；每次续登轮换凭证，不延长到期。Cookie 因 `__Host-` 必须覆盖整个 host，但只有新增 H5 入口会使用它。退出不会主动吊销已签发的 access，H5 应丢弃内存 JWT。
- 同一浏览器的登录、续登和退出须跨标签串行（例如统一用同一个 Web Lock）；不要让多个标签对同一 Cookie 同时续登，也不要在退出进行中自动续登。服务端保留既有重放撤销，且 `10007` 会清 Cookie。旧 access 只有自然到期或账号失效才失效。
- H5 页面与 API 的 scheme、host、port 必须相同。后端要求 HTTPS 和精确匹配的 `Origin`，拒绝缺失、`null` 和不匹配的 Origin；若有 `Sec-Fetch-Site`，也必须为 `same-origin`。被拒绝时返回 `40300`，不写或清 Cookie。不加 credentialed CORS，不提供 HTTP 调试例外。
- TLS 反代必须保留浏览器所见的 canonical `Host`（非默认端口不能丢），覆盖而非透传客户端的 `X-Forwarded-Proto`，按现有配置只信任实际直连代理 CIDR，并拒绝未知 Host、避免直连绕过反代。网关不得记录或缓存 Cookie、Set-Cookie 或含 JWT 的响应。
- 接入验收需在实际同源 HTTPS 上检查浏览器存储/清除 Cookie 和多标签串行。后端测试或生成的契约不能替代真实 ingress 和浏览器验证。
