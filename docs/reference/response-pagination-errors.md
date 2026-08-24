# 统一返回 · 分页 · 错误处理与 BizCode(reference · 触碰才读)

> Harness 2.0 细则层:承接 harness v1 `AGENTS.md` §4 / §5 **原文逐字搬家(零放宽;唯一机械改写=相对链接前缀)**;恒读入口与速查见根 [`AGENTS.md`](../../AGENTS.md),原文快照 [`archive/harness-v1/AGENTS.md`](../archive/harness-v1/AGENTS.md)。
> 机器锁定:response-format 与 bizcode e2e 横切组 + biz-code.constant.spec + contract snapshot。

## 4. 统一返回格式

所有接口经 `ResponseInterceptor` 包装为 `{ code: 0, message: 'ok', data }`。业务代码**只 `return data`**,永远不要手动包外层结构。

### 分页

入参固定使用 `PaginationQueryDto`,`page` / `pageSize` 命名固定,默认 `page=1` / `pageSize=20`,`pageSize` 最大 100。**禁止 `limit/offset` / `skip/take` / `cursor`**。Prisma 查询时换算 `skip = (page - 1) * pageSize`,`take = pageSize`。

出参固定 `PageResultDto<T>`(`items` / `total` / `page` / `pageSize`),禁止 `{ list, count }` / `{ rows, total }` 等变体。默认排序 `orderBy: { createdAt: 'desc' }`。

#### 已登记例外:`pageSize` 默认值 / 上限(恰 1 处)

| 端点 | 默认 | 上限 | 立项出处与理由 |
|---|---|---|---|
| `GET /api/app/v1/my/managed-activities/:activityId/collaborator-options` | 200 | 200 | 活动 v1.1 AC-030(合同追踪矩阵 E07)。该端点改造前恒返回**前 200 条**(`take: 200` 硬截);若改吃本节默认值 20,所有不传参的既有调用方会从 200 条掉到 20 条 —— 那是破坏性变更而不是扩面。**只偏离这两个数值**:字段名、禁用 `limit`/`offset`/`cursor`、出参四件套全部照守,且偏离方向只会「不缩小既有页」。判据见 `test/e2e/activity-scale-usability.e2e-spec.ts` 的不变量 4。 |

新增例外必须进上表并写明立项出处 —— 空着的例外等于没有规则。本表之外的分页入参一律吃 `PaginationQueryDto`(默认 20 / 上限 100)。

#### 已登记例外:整取型只读目录(**完全不分页**)

> 上一张表是「分了页但两个数值不同」;本表是**根本不分页**,是另一类偏离,必须分开登记。
> **判据不同**:够格的只有「固定参考集合 + 客户端必须整取才能用」,不是「数据量看起来不大」。

| 端点 | 规模 | 立项出处与理由 |
|---|---|---|
| `GET /api/system/v1/permissions/catalog` | 237 条(9 业务区 / 46 分组) | P1-32 PR 2;冻结稿 [`rbac-permission-catalog-t0-review.md`](../archive/reviews/rbac-permission-catalog-t0-review.md) §9.1 逐字:「**返回完整目录,不分页**。236 条规模适合一次加载」。① 目录是**固定参考集合**(权限码定义),不是会增长的业务流水 —— 条数随版本发布变,不随用户操作变;② 响应是**两级分组树**(业务区 → 分组 → 条目),后台权限编辑器要整棵树才能渲染,按页切会让树在客户端拼不齐;③ 端点**新增、零存量调用方**,不存在「老调用方从 N 条掉到 20 条」那类破坏。**只偏离「分不分页」这一件事**:统一返回外层 `{ code, message, data }` 照守,禁用 `limit`/`offset`/`cursor` 照守。执行位见 `scripts/check-role-classification.ts`(条目数地板 `CATALOG_ITEM_FLOOR`,扫描面塌到地板以下当场红)。 |

新增整取型端点同样必须进本表。⚠️ **「不分页」不等于「无上界」** —— 上界由**代码事实**兜住(目录条数只能靠改 `permission-catalog.ts` 增长,而它在红区);靠运行时数据决定条数的读面**没有资格**进本表,只能分页。

### `ResponseInterceptor` 跳过路径

用 `startsWith` 匹配以下前缀,匹配则不动响应体:`/api/docs`(自动覆盖 `/api/docs-json` / `/api/docs-yaml`)/ `/favicon.ico` / `/metrics` / 文件下载流响应。

**铁律:Swagger UI 与 OpenAPI JSON/YAML 永远不能被业务响应包装。** 实现完成后必须实际访问 `/api/docs` 与 `/api/docs-json` 验收。

`/api/system/v1/health` **走包装**,不在跳过列表;controller 返回 `{ status: 'ok' }`,最终响应 `{ code: 0, message: 'ok', data: { status: 'ok' } }`。


## 5. 错误处理

### `BizCode` 三字段对象 + `BizException` 类型签名

- 集中维护在 `common/exceptions/biz-code.constant.ts`,每个 BizCode 必须同时携带 `code` / `message` / `httpStatus` 三字段,定义为 `as const`(示例:`USER_NOT_FOUND: { code: 10001, message: '用户不存在', httpStatus: HttpStatus.NOT_FOUND }`)
- `BizException` 构造参数类型锁死为 `(typeof BizCode)[keyof typeof BizCode]` 联合类型;**禁止**接收裸数字 / 字符串 / 临时对象(必须 `throw new BizException(BizCode.USER_NOT_FOUND)` 形式,不接受 `10001` / `'USER_ERROR'` / `{ code: 10099, ... }`)
- BizException 内 `super(biz.message)`,自动同步 message 到 Error.message

### `AllExceptionsFilter` 处理规则

- `BizException` → 读 `httpStatus`,响应 `{ code, message, data: null }` + 对应 HTTP status
- NestJS `HttpException` → 沿用其 HTTP status,`code` 用通用 BizCode(`BAD_REQUEST` / `UNAUTHORIZED` / `FORBIDDEN` / `NOT_FOUND` / `INTERNAL_ERROR`)
- 未知异常 → HTTP 500,`code` 为 `INTERNAL_ERROR`,生产环境不暴露 `error.message`

业务响应体始终 `{ code, message, data }` 三字段;HTTP status 始终保持语义。**禁止为了"统一"返回 HTTP 200。**

### BizCode 编码段

- `4xxxx` / `5xxxx`:**通用 HTTP 级错误**,与 HTTP status 段对齐(未登录 / 无权限 / 资源不存在 / 服务器错误)
- `100xx`:`users` 模块**业务级错误**(包含 `auth`,**`auth` 不单开段**;如登录失败 `LOGIN_FAILED=10004`、用户名 / 邮箱冲突)
- `101xx`:`users` 权限 / 操作边界错误
- `110xx`+:后续业务模块按 `orgs:110xx/111xx` / `missions:120xx/121xx` 平铺,每模块 200 个号段

**通用 token / 鉴权失败统一复用 `UNAUTHORIZED=40100`,不另起编号**:`JwtStrategy.validate()` 中 token 无效 / 已过期 / 用户被禁 / 用户被软删全部抛 `UNAUTHORIZED`。这类是 HTTP 401 通用语义,不是业务级错误;AI **禁止**为 `TOKEN_INVALID` / `TOKEN_EXPIRED` 之类自创 `100xx` 业务码。

**`100xx` 段位实数(锁死)**:10001 USER_NOT_FOUND / 10002 USERNAME_ALREADY_EXISTS / 10003 EMAIL_ALREADY_EXISTS / 10004 LOGIN_FAILED / 10005 OLD_PASSWORD_INVALID(P0-D) / 10006 NEW_PASSWORD_SAME_AS_OLD(P0-D) / **10007 REFRESH_TOKEN_INVALID**(P0-E,HTTP 401,详 [`auth-jwt-refresh §9`](auth-jwt-refresh.md) P0-E 子节 + [评审稿 §5.7](../archive/reviews/first-release-p0e-refresh-token-review.md))。10007 **仅占 1 个号位**:refresh 失败 4 种子原因统一返;**禁止**拆 `REFRESH_TOKEN_EXPIRED` / `REFRESH_TOKEN_REVOKED` / `REFRESH_TOKEN_REPLAY`(沿 [`auth-jwt-refresh §8`](auth-jwt-refresh.md) 防账号枚举铁律精神)。

新增 BizCode 必须先说明使用场景与前端提示价值,确认后加入,显式声明 `httpStatus`。

### Prisma 错误转换

`P2002` 唯一约束错误必须显式捕获 `Prisma.PrismaClientKnownRequestError`(`err.code === 'P2002'`),根据 `err.meta?.target` 转为对应 `BizException`(`USERNAME_ALREADY_EXISTS` / `EMAIL_ALREADY_EXISTS`),不丢给全局过滤器兜底。**`err.meta?.target` 是 `string[]` 而非 `string`**,必须用 `target.includes('username')` 数组方法判断;**禁止** `target === 'username'`(多列复合唯一约束场景会漏判)。
