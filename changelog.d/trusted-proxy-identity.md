## Changed

- 新增单一 `APP_TRUSTED_PROXY_CIDRS` 配置边界：仅接受精确小写 `none` 或 canonical IPv4/IPv6 network CIDR 列表；拒绝非零 host bits、整个 RFC1918 聚合根及既有危险范围。production/smoke 缺失、空白或非法值在配置装配期 fail-fast，development/test 缺失默认 `none`。
- `applyGlobalSetup` 先设置 Express 原生 `trust proxy` 并建立唯一 request ID，再在 Helmet 后、CORS preflight/pino/throttler/controller 前统一校验与固化 Express 选出的 `req.ip/req.ips`：IPv4-mapped 归 native IPv4，IPv6 归 lowercase 压缩形式；port/bracket/zone/空白/任意字符串、getter 异常，以及配置非 `none` 时最终 identity 仍属于 trusted proxy 的缺失客户端链，统一 fail-closed 为 `BAD_REQUEST=40000`。拒绝响应保留 request ID/Helmet/允许 Origin 的 CORS 头，并只写 event+reqId 的安全边界日志；仍不自行解析 XFF，也不新增 `Forwarded` / `X-Real-IP` 身份来源。
- HTTP 日志 redact 增加三类代理头与 pino 标准 request remote peer 路径；招新 OCR 日封顶 warning 不再写原始 IP。
- Docker Smoke 因测试容器真实直连而显式使用 `APP_TRUSTED_PROXY_CIDRS=none`；生产运维文档补齐反代下禁止 `none`、精确直连代理信任、edge 覆盖、backend ACL、同代切流/回退与旧限流/OCR 键自然过期口径。

## Tests

- 增加配置 parser、production/smoke fail-fast 与 bootstrap 首操作单元探针。
- 增加 Node socket E2E harness：none/未信任伪造 XFF、trusted proxy 缺失/空/全 trusted XFF、单层、两个实际 Node HTTP proxy 的双层覆盖/追加、缺 edge trust 与 IPv4-mapped socket；锁定 native IPv4/mapped/IPv6 canonical identity，并以不同 Prisma pool/storage、同 database 与实际 SHA-256 key 证明等价文本跨实例共享同一 PostgreSQL bucket。port/bracket/zone/任意字符串及 malformed 中间 hop 在 CORS preflight/pino/throttler/controller 与 DB/audit/SMS/OCR 写前以 40000 拒绝；真实 LoggerModule 探针只锁 request ID/pino middleware 兼容，安全拒绝日志则由 Logger call-shape 断言锁定固定 event+reqId 且零 IP/header/path，不宣称观测最终 pino JSON。另验证两个 client 独立 PostgreSQL login bucket、同 client 跨两 Nest 实例共享额度，以及 refresh/audit、SMS code、OCR counter 的最终 IP 消费链。该 harness 不替代上线前真实 ingress/ACL 现场证据。

## Not shipped

- 本变更不包含生产 CIDR、release/tag/version bump 或部署；生产生效前仍须以真实 ingress 与 backend ACL 证据验证现场拓扑。
