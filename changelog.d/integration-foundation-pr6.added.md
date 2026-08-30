新增第六类 Integration API surface、SERVICE / DELEGATED 主体准入、机器主体 `/me`，并落地同事务持久化的 Integration 命令幂等地基。

`POST /api/auth/v1/delegated-token` 对“有效但主体类型错误”的 Delegated Token 改返已批准的 `37017 PRINCIPAL_KIND_FORBIDDEN`；合法 Service Token 调用、请求体与成功响应不变。Swagger 的 403 契约同时保留 Grant 无效的 `37016`。Integration Foundation 尚未部署且生产 gate 保持关闭，当前无线上调用方。
