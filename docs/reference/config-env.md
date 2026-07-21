# 配置归属与启动强校验(reference · 触碰才读)

> Harness 2.0 细则层:承接 harness v1 `AGENTS.md` §14 **原文逐字搬家(零放宽;唯一机械改写=相对链接前缀)**;恒读入口与速查见根 [`AGENTS.md`](../../AGENTS.md),原文快照 [`archive/harness-v1/AGENTS.md`](../archive/harness-v1/AGENTS.md)。
> 机器锁定:启动 fail-fast 强校验 + docker-smoke CI。

## 14. 配置文件归属

**归属铁律**:`APP_PORT` / `APP_ENV` / `APP_CORS_ORIGIN` / `APP_TRUSTED_PROXY_CIDRS` / `ENABLE_SWAGGER` → `src/config/app.config.ts`;`DATABASE_URL` → `src/config/database.config.ts`;`JWT_SECRET` / `JWT_EXPIRES_IN` → `src/config/jwt.config.ts`;`SUPER_ADMIN_*` **不进 config**,仅 `prisma/seed.ts` 内 `process.env` 直读(显式例外)。

- 业务代码与 service **不直接 `process.env.XXX`**,统一通过对应 `*.config.ts` 注入(`SUPER_ADMIN_*` 是唯一例外)
- 不为 CORS / Swagger / 单一开关再单建 `cors.config.ts` / `swagger.config.ts`
- 新增环境变量先决定归属,再同步加进 `.env.example` 与启动强校验
- **业务判断只用 `APP_ENV`,禁止混用 `NODE_ENV`** 做业务配置判断;`NODE_ENV` 只留给框架与工具链(NestJS / Prisma / Webpack)内部使用
- `INSURANCE_ENFORCEMENT_ENABLED` 归 `app.config.ts` 的 `insurance.enforcementEnabled`；只接受精确小写 `true|false`。development/test/smoke 缺失或空值默认 false；production 缺失/空值/非法值必须在启动装配期 fail-fast，显式 false 是合法兼容档位。该单 gate 同时控制 App CAS、verified-only consumer、Activity/Team Join evidence 与 final join 保险闸，禁止拆分
- `APP_TRUSTED_PROXY_CIDRS` 归 `app.config.ts` 的 `trustedProxyCidrs`；只接受精确小写 `none` 或逗号分隔、无空项/首尾空白的 canonical IPv4/IPv6 network CIDR(host bits 必须全 0)。development/test 缺失、空值或纯空白默认 `none`，production/smoke 必须显式配置；`none` 必须独占且仅适用于 backend 真实直连。拒绝 boolean、hop 数、裸 IP、hostname、wildcard、任意 `/0`、非法前缀、三个完整 RFC1918 aggregation root（`10/8`、`172.16/12`、`192.168/16`）以及包含 loopback/link-local/IPv6 unique-local 的网段；更小私网代理 CIDR仍须由现场拓扑与 backend ACL 证据确认，不在 parser 发明任意 `/24` 下限。配置校验与运行时 client identity normalization 都使用 Node 内置网络 API，不引入依赖；后者在 CORS preflight/pino/throttler/controller 前把 mapped IPv4 归 native、IPv6 归 lowercase 压缩，并将非法 token/getter 异常或配置非 `none` 时仍属于 trusted proxy 的最终 identity 统一收口为 40000

### 启动强校验铁律(production fail-fast,禁止 fallback 默认值兜底)

应用启动时必须强校验,任一不满足直接抛错退出:

- `APP_ENV` 必须 ∈ `{ development, test, production, smoke }`；`smoke` 仅供 Docker Smoke CI，禁止真实部署
- `JWT_SECRET` 至少 32 字符;**production 下不允许等于 `.env.example` 默认值** `please-change-me-in-production-min-32-chars`(推荐 `openssl rand -base64 48` 生成);**密钥绝不进日志 / audit / 响应**
- `APP_CORS_ORIGIN` production 下**禁止**为空 / **禁止** `*`,必须显式列出前端域名;解析支持英文逗号分隔多 origin(`split(',').map(trim).filter(Boolean)`)
- `APP_TRUSTED_PROXY_CIDRS` production/smoke 下缺失、空值、纯空白或非法值必须在 ConfigModule 装配期 fail-fast；`.env.test` 显式设置 `none`，避免测试隐式依赖 default。反代部署不得用 `none` 启动承流实例，否则全部客户端会退化为同一个 proxy socket IP
- `ENABLE_SWAGGER` **必须严格字符串判断 `=== 'true'`**(**禁止** `Boolean(process.env.ENABLE_SWAGGER)` 或 truthy 判断,否则字符串 `'false'` 会被误判为开启);Swagger 开关公式 `APP_ENV !== 'production' || ENABLE_SWAGGER === 'true'`
- production 切换保险 single gate 前必须先 drain 旧 server 与旧事务；同一 fleet 禁止 true/false 混跑。配置代码可交付而不等于已 deploy/enable，文档不得用“旧客户端未上线”替代“旧 server=0”运行证据
- `prisma/seed.ts` 额外校验:`SUPER_ADMIN_USERNAME` 必须符合 username 格式(小写字母+数字+下划线+中横线,3-32);**production 下禁止** `SUPER_ADMIN_USERNAME=admin` 或 `SUPER_ADMIN_PASSWORD=ChangeMe123456`(`.env.example` 默认值);对应用户已存在时**不覆盖**密码 / 角色 / 邮箱,只打印提示
