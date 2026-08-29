# Integration API 运行手册

> 适用范围：Integration Foundation v1 的机器认证、Delegated Token、`/api/integration/v1/*` 与幂等回执。PR6 只开放 `GET /api/integration/v1/me`，业务命令从 PR7 起逐项接入。

## 1. 上线前置

1. 保持 `INTEGRATION_API_ENABLED=false` 完成部署，确认 Human 登录与既有五个 surface 无漂移。
2. 配置独立的 Integration JWT secret；不得复用 Human JWT secret，不得在工单、日志或命令输出中粘贴密钥。
3. 由控制面创建 Service Principal、绑定允许机器主体使用的角色，并创建凭证。凭证 secret 只在创建响应中出现一次，应立即交给受控的 secret manager。
4. 如需委托，以控制面创建 Delegation Grant；subject 只能来自 Grant，调用方不得提交 userId 代替。
5. 在受控环境开启 `INTEGRATION_API_ENABLED`，先完成 §2 的只读探针，再接入写命令。

## 2. 最小探针

- Client Credentials 调用 `POST /api/auth/v1/service-token`，应取得短期 Service Token；该链不签发 refresh token。
- 用 Service Token 调用 `GET /api/integration/v1/me`，应只返回 `principalKind`、`servicePrincipal.clientId/name` 与 `delegated`。
- 如启用委托，用 Service Token 调用 `POST /api/auth/v1/delegated-token`，再用 Delegated Token 调 `/me`；服务端必须按 Grant 当前事实即时复查 subject，最小响应本身不回显 subject。
- 用 Human JWT 调 `/api/integration/v1/me` 应被拒绝；用 Service Token 调 Human-only 路由也应被拒绝。
- 撤销凭证、停用 Service Principal 或撤销 Grant 后，旧 token 的下一次请求必须立即失败。

## 3. 幂等命令约定

- 写命令必须携带 `Idempotency-Key`，长度 8–128，只允许字母、数字、下划线、点、冒号和短横线。
- 幂等域固定为 `servicePrincipalId + operation + Idempotency-Key`。Credential 轮换不改变幂等域；Delegated 请求的 Grant 与 subject 会进入 request hash。
- 传给幂等服务的 request 必须覆盖所有会改变业务结果的 path、query 与 body 语义；不得纳入 credential 或请求头。
- 同 key、同 hash 返回首次持久化的响应；同 key、不同 hash 返回 `37023 IDEMPOTENCY_KEY_CONFLICT`。
- 领域写、response snapshot 与 receipt 必须在同一个数据库事务内完成。不得在事务外补写 receipt，也不得把 token、secret、手机号等敏感字段写入 snapshot。

## 4. 常见错误

| BizCode | 含义                                  | 处置                                                               |
| ------- | ------------------------------------- | ------------------------------------------------------------------ |
| `37010` | Client Credentials 校验失败的统一出口 | 检查 clientId、secret、主体/凭证状态；不要根据响应猜测具体失败分支 |
| `37011` | Integration Token 无效                | 重新签发；同时核查主体、凭证或 Grant 是否已撤销/过期               |
| `37017` | token 主体类型不适用于当前路由        | 改用该路由允许的 Service 或 Delegated Token，不要改路由声明绕过    |
| `37023` | 同一幂等 key 被用于不同请求           | 保留原请求重试，或为新业务意图生成新的 key                         |
| `37030` | Integration API 总开关关闭            | 先完成上线审批与只读探针，再由维护者开启开关                       |

## 5. 观测与止损

- 日志只记录 Service Principal ID，以及 Delegated 场景下的 on-behalf-of User ID；不得记录 Authorization、JWT 内容、client secret 或完整响应快照。
- 异常增长优先按 `requestId`、主体 ID、operation 与 BizCode 聚合；不要把 Idempotency-Key 当成身份凭证。
- 需要紧急止损时先关闭 `INTEGRATION_API_ENABLED`。该动作会同时阻止 token 签发与 Integration surface 请求，不影响 Human Auth surface。
- 单个调用方泄露时，撤销对应 credential；需要整体隔离时停用 Service Principal。Delegated 风险还应撤销相关 Grant。
- 回滚应用版本前先确认新版本尚未开放业务命令。本 PR 无 schema / migration，关闭总开关后可回滚代码；已写入的 receipt 保留，不做物理删除。
