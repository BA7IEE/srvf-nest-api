# AGENTS.md — 通用 AI Agent 项目协作铁律

> 给所有 **AI 编码助手 / Agent**(Cursor、GitHub Copilot Chat、Continue、Cline、其他 CLI / IDE Agent)看的项目工作铁律,从 `ARCHITECTURE.md` §7 与附录抽取。
> 修改本仓库代码前必须读完:`ARCHITECTURE.md`(v1 蓝图)+ `AGENTS.md`;如使用 Claude Code,还必须读 `CLAUDE.md`。
> 本文与 `CLAUDE.md` 内容**保持同步、并存**,差异仅在入口表述。如本文与 `ARCHITECTURE.md` 表述冲突,**以 `ARCHITECTURE.md` 为准**。
> 除非用户明确要求,AI 不得修改 `ARCHITECTURE.md`;实现过程中发现文档与代码冲突时,必须先暂停并说明。

---

## SRVF 派生项目规则解释(v0.13.0 适用)

> 本仓库 `srvf-nest-api` 是 `u-nest-api-starter` 的派生项目,**当前已演进到 v0.13.0**(first-release 起步包 51 路由)。
>
> **当前事实优先读** [`docs/current-state.md`](docs/current-state.md) / [`docs/process.md`](docs/process.md) / [`docs/handoff/v0.13.0.md`](docs/handoff/v0.13.0.md) / first-release 系列(`docs/first-release-*.md`)/ 批次评审稿(`docs/批次N_*.md`)。本文 §0-§18 的母模板原文,只作为**历史来源与通用工程参考**。
>
> §1 的"v1 不做清单" **不是永久禁令**——按 §1 内 A / B / C 三档读取。
>
> 当用户提出**真实业务需求 / 联调需求 / 上线风险 / 安全风险**时,AI **不得仅凭旧条目直接拒绝**,应进入评审解锁(说明状态 → 列出影响面 → 判断档位 → 给出最小评审方案 → 等用户拍板)。
>
> 本节与 [`CLAUDE.md`](CLAUDE.md) 同步;冲突按 `ARCHITECTURE.md` > `CLAUDE.md` / `AGENTS.md` > 本节 顺序处理。

---

## 0. 修改代码前必读

- 通用 Agent 必读:`ARCHITECTURE.md` / `AGENTS.md`;如使用 Claude Code,还必须读 `CLAUDE.md`
- 任何不在 v1 范围内的新增功能(见 §1),**必须先暂停并说明原因,不得擅自实现**
- 执行 `prisma migrate dev` 前必须先说明将生成 / 执行的迁移内容并等待确认;生产环境只允许 `prisma migrate deploy` 已审查 migration
- **pnpm-only**:依赖安装与脚本执行统一使用 `pnpm`,禁止 `npm` / `yarn` / `bun`,避免 lockfile 漂移
- `@nestjs/swagger` 必须按其 `peerDependencies` 选择与当前 NestJS 主版本兼容的版本,**禁止手动钉死主版本号**(如硬写 `^7.x`),否则会出现 peer 警告并隐藏 schema bug
- 每次只实现一个阶段,不跨阶段提前写;每个阶段完成后必须 lint / typecheck / test,或至少启动服务验证

---

## 1. v1 不做的事(刻意砍,需要时再加)

> **SRVF 三档读取**:本节"v1 不做"在 SRVF 中按 A / B / C 分类,不再是永久禁令。详细评审流程见顶部"SRVF 派生项目规则解释"段;升级触发条件见 `ARCHITECTURE.md` §9。

### A. 已解锁(可正常使用与扩展)

- `audit_logs`(批次 6 已落地;`AuditLogEvent` 已接入多个写路径)
- attachments / COS / signed URL(批次 7 + v0.11.0 / v0.12.0;`common/storage/` Provider 已实装)
- RBAC 部分(批次 8;attachments 已接 `rbac.can()`,其它最小权限闭环归 P0-F)
- 本人自助改密 `PUT /api/users/me/password`(P0-D + v0.13.0;详细铁律见 §9)
- first-release 前端联调包(起步包 51 路由;见 [`docs/first-release-frontend-scope.md`](docs/first-release-frontend-scope.md))
- refresh token / logout / logout-all(P0-E + 评审稿 v1 已冻结于 [`docs/first-release-p0e-refresh-token-review.md`](docs/first-release-p0e-refresh-token-review.md);代码实现仍待 PR-3 落地,**所有实现必须严格遵守评审稿 + §9 P0-E 铁律子节**)

### B. 默认不做,可评审解锁(真实需求触发评审)

- `tokenVersion` 字段(P0-E v1 D-4 已明确**本期不做**;沿 [`docs/security.md` Token 吊销升级路径](docs/security.md);access token 即时吊销诉求出现时单独立项)
- access token blacklist / JWT revoke list(P0-E v1 已明确**本期不做**;沿 D-4 改密 / 禁用 / 删除事件靠 refresh 撤销 + 15m access TTL 自然过期承接)
- RBAC 全面收紧(关键接口最小权限闭环归 **P0-F**)
- 上传下载真实闭环(运维验收归 **P0-B**)
- 微信登录 / 小程序登录(业务明确需要时单独评审)
- 多租户(真实业务出现跨队隔离诉求时单独架构评审)
- Redis / queue / cron(异步任务诉求触发时评审,需评估运维承接;**P0-E refresh token 撤销不引入 Redis**,沿 DB 主键索引 sub-ms 查询承接)

### C. 当前阶段仍不做

- LLM / 向量检索 / pgvector(`modules/ai/` 保持 README 占位)
- 完整动态权限平台(permission 表 + 后台可配权限点 + casl)
- 复杂 session 管理 UI(多设备登录列表 / 强制下线某设备 / device fingerprint;沿 P0-E v1 D-9)
- refresh_tokens 查询接口(`GET /api/auth/refresh-tokens` 列本人活跃 token;沿 P0-E v1 D-9)
- 完整 OAuth 2.0 / OIDC / refresh token tree 复杂度(沿 P0-E v1 D-9)
- 无真实需求的多租户提前设计
- 无运维承接能力的基础设施提前引入(Redis / queue / cron)

**永久铁律(不解锁)**:不引入 `LocalStrategy`(`username + password` 校验在 `auth.service.ts` 内手写)、不创建 `*.entity.ts`(本项目不是 TypeORM 项目)、不使用 Prisma 全局软删中间件 / client extension、不主动加用户状态缓存"优化"(未触发 `ARCHITECTURE.md` §9 升级条件前)。

---

## 2. 模块结构

业务模块固定 4 文件:

```
modules/<name>/
├── <name>.module.ts
├── <name>.controller.ts
├── <name>.service.ts
└── <name>.dto.ts
```

- 例外:`health/` 只有 `health.module.ts` + `health.controller.ts`
- 单个 dto 文件超 300 行,允许拆同模块内 `dto/` 目录,**禁止跨模块公共目录**
- 禁止 `*.entity.ts`

新业务模块平铺加在 `src/modules/` 下,**不要嵌套** `system/` 子目录。

---

## 3. 命名铁律

| 场景 | 错误 | 正确 |
|---|---|---|
| 密码字段 | `password`(model / response DTO) | `passwordHash`(仅 Prisma model 与 service 内部) |
| 文件标识 | `path` / `filename` / `url` | `key` |
| 角色判断 | `if (user.role === 'admin')` | `if (user.role === Role.ADMIN)` |
| 角色装饰器 | `@Roles('admin')` | `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` |
| 错误抛出 | `throw new Error('用户不存在')` | `throw new BizException(BizCode.USER_NOT_FOUND)` |
| 时间字段 | `create_time` / `createTime` | `createdAt` |
| 主键 | 自增 int | `cuid()` 字符串 |
| 角色 / 状态枚举 | 手写 `users.enum.ts` | 从 `@prisma/client` 导入 `Role` / `UserStatus` |

`Role` / `UserStatus` 唯一来源是 Prisma schema:

```typescript
import { Role, UserStatus } from '@prisma/client';
```

### 字段校验铁律(DTO 层硬约束)

| 字段 | 入参 DTO 校验 | 入库前归一化 |
|---|---|---|
| `username` | `@Matches(/^[a-z0-9_-]{3,32}$/)`(小写字母+数字+下划线+中横线,3-32) | `trim()` + `toLowerCase()` |
| `email` | `@IsOptional()` + `@IsEmail()` | `trim()` + `toLowerCase()`;空字符串按未填写处理(写入前置 `null`,**不要**写空字符串入库) |
| `password` / `newPassword` | `@MinLength(8)`,必须含数字 + 字母 | 落库前必须 `bcrypt.hash()`,绝不裸传 Prisma |
| `nickname` | `@MaxLength(50)` | — |
| `avatarKey` | `@MaxLength(255)` | — |

`username` / `email` 的 `trim()` + `toLowerCase()` 必须在**入库前**和**所有查询前**统一执行,避免大小写账号或首尾空格账号并存(`Admin` 与 `admin` 同账号)。

---

## 4. 统一返回格式

所有接口经 `ResponseInterceptor` 包装为 `{ code: 0, message: 'ok', data }`。业务代码**只 `return data`**,永远不要手动包外层结构。

### 分页

入参固定使用 `PaginationQueryDto`,`page` / `pageSize` 命名固定,默认 `page=1` / `pageSize=20`,`pageSize` 最大 100。**禁止 `limit/offset` / `skip/take` / `cursor`**。Prisma 查询时换算 `skip = (page - 1) * pageSize`,`take = pageSize`。

出参固定 `PageResultDto<T>`(`items` / `total` / `page` / `pageSize`),禁止 `{ list, count }` / `{ rows, total }` 等变体。默认排序 `orderBy: { createdAt: 'desc' }`。

### `ResponseInterceptor` 跳过路径

用 `startsWith` 匹配以下前缀,匹配则不动响应体:

- `/api/docs`(自动覆盖 `/api/docs-json` / `/api/docs-yaml`)
- `/favicon.ico`
- `/metrics`
- 文件下载流响应

**铁律:Swagger UI 与 OpenAPI JSON/YAML 永远不能被业务响应包装。** 实现完成后必须实际访问 `/api/docs` 与 `/api/docs-json` 验收。

`/api/health` **走包装**,不在跳过列表;controller 返回 `{ status: 'ok' }`,最终响应 `{ code: 0, message: 'ok', data: { status: 'ok' } }`。

---

## 5. 错误处理

### `BizCode` 三字段对象

集中维护在 `common/exceptions/biz-code.constant.ts`,**每个 BizCode 必须同时携带 `code` / `message` / `httpStatus`**:

```typescript
import { HttpStatus } from '@nestjs/common';

export const BizCode = {
  BAD_REQUEST:    { code: 40000, message: '请求参数错误',   httpStatus: HttpStatus.BAD_REQUEST },
  UNAUTHORIZED:   { code: 40100, message: '未登录或登录已失效', httpStatus: HttpStatus.UNAUTHORIZED },
  FORBIDDEN:      { code: 40300, message: '无权限访问',     httpStatus: HttpStatus.FORBIDDEN },
  NOT_FOUND:      { code: 40400, message: '资源不存在',     httpStatus: HttpStatus.NOT_FOUND },
  INTERNAL_ERROR: { code: 50000, message: '服务器内部错误', httpStatus: HttpStatus.INTERNAL_SERVER_ERROR },

  USER_NOT_FOUND:           { code: 10001, message: '用户不存在',     httpStatus: HttpStatus.NOT_FOUND },
  USERNAME_ALREADY_EXISTS:  { code: 10002, message: 'username 已存在', httpStatus: HttpStatus.CONFLICT },
  EMAIL_ALREADY_EXISTS:     { code: 10003, message: 'email 已存在',    httpStatus: HttpStatus.CONFLICT },
  LOGIN_FAILED:             { code: 10004, message: '账号或密码错误',  httpStatus: HttpStatus.UNAUTHORIZED },
  FORBIDDEN_ROLE_OPERATION: { code: 10101, message: '无权对该用户执行此操作', httpStatus: HttpStatus.FORBIDDEN },
  CANNOT_OPERATE_SELF:      { code: 10102, message: '不能对自己执行此操作',   httpStatus: HttpStatus.FORBIDDEN },
  LAST_SUPER_ADMIN_PROTECTED:{ code: 10103, message: '系统必须保留至少一个活跃超级管理员', httpStatus: HttpStatus.CONFLICT },
} as const;
```

### `BizException` 类型签名锁死

构造参数类型必须为 BizCode 联合类型,**不接收裸数字 / 字符串 / 临时对象**:

```typescript
type BizCodeEntry = (typeof BizCode)[keyof typeof BizCode];

export class BizException extends Error {
  constructor(public readonly biz: BizCodeEntry) {
    super(biz.message);
  }
}

throw new BizException(BizCode.USER_NOT_FOUND);  // ✓
throw new BizException(10001);                    // ✗
throw new BizException('USER_ERROR');             // ✗
throw new BizException({ code: 10099, ... });     // ✗ 临时对象禁止
```

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

**P0-E refresh token 段位登记**(2026-05-17 由评审稿 v1 锁定):`100xx` 段位实数已用 10001-10006(P0-D 占 10005 / 10006);P0-E 占 **`REFRESH_TOKEN_INVALID = 10007`**(HTTP 401;沿 [`docs/first-release-p0e-refresh-token-review.md §5.7`](docs/first-release-p0e-refresh-token-review.md))。P0-E v1 D-6 已明确**仅占 1 个号位**:refresh 失败的 4 种子原因(不存在 / 已撤销 / 已过期 / 重放命中)统一返 `10007`,**禁止**拆 `REFRESH_TOKEN_EXPIRED` / `REFRESH_TOKEN_REVOKED` / `REFRESH_TOKEN_REPLAY`(沿 v1 §8 防账号枚举铁律精神;细分让攻击者据错误码反推 token 状态)。

新增 BizCode 必须先说明使用场景与前端提示价值,确认后加入,显式声明 `httpStatus`。

### Prisma 错误转换

`P2002` 唯一约束错误必须显式捕获 `PrismaClientKnownRequestError`,根据 `error.meta?.target` 转为对应 `BizException`(`USERNAME_ALREADY_EXISTS` / `EMAIL_ALREADY_EXISTS`),不要丢给全局过滤器兜底。

**注意 `error.meta?.target` 是 `string[]` 而非 `string`**,判断时必须用数组方法:

```typescript
import { Prisma } from '@prisma/client';

try {
  await this.prisma.user.create({ data });
} catch (err) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = (err.meta?.target as string[] | undefined) ?? [];
    if (target.includes('username')) throw new BizException(BizCode.USERNAME_ALREADY_EXISTS);
    if (target.includes('email'))    throw new BizException(BizCode.EMAIL_ALREADY_EXISTS);
  }
  throw err;
}
```

禁止写 `target === 'username'`,在多列复合唯一约束场景会漏判。

---

## 6. Swagger 100% 覆盖

- 每个 Controller 方法必须 `@ApiOperation({ summary })`
- 每个 DTO 字段必须 `@ApiProperty({ description })`
- 需鉴权方法必须 `@ApiBearerAuth()`
- 响应类型按返回结构选用,**禁止裸写** `@ApiOkResponse({ type: Dto })`:
  - 单对象:`@ApiWrappedOkResponse(Dto)`
  - 数组:`@ApiWrappedArrayResponse(Dto)`
  - **分页:`@ApiWrappedPageResponse(Dto)`**(必须用此装饰器)
- 三个装饰器集中放在 `common/decorators/api-response.decorator.ts`
- `PageResultDto<T>` 是 TS 泛型,`@nestjs/swagger` 无法 reflect 泛型参数,因此分页接口**必须**用 `@ApiWrappedPageResponse(Dto)`,装饰器内部用 `getSchemaPath(Dto)` + `allOf` 显式描述 `data: { items, total, page, pageSize }`,否则前端 SDK 生成器拿到的是单对象 schema。需要在 controller 类上配套 `@ApiExtraModels(Dto, PageResultDto)`

---

## 7. 全局 ValidationPipe

`main.ts` 注册全局:

```typescript
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
}));
```

- `forbidNonWhitelisted` 保证 DTO 未声明字段直接报错
- 禁止 controller 重复配置局部 `ValidationPipe`

---

## 8. 权限与鉴权

### Guard 全局注册

`JwtAuthGuard` + `RolesGuard` 通过 `AppModule.providers` 中 `APP_GUARD` 全局注册,顺序固定 `JwtAuthGuard` → `RolesGuard`(先验登录,再验角色)。**禁止在 controller 上 `@UseGuards(...)`**。

```typescript
providers: [
  { provide: APP_GUARD, useClass: JwtAuthGuard },
  { provide: APP_GUARD, useClass: RolesGuard },
]
```

### `@Public()` / `@Roles(...)` 互斥

- 未标 `@Public()` 默认要登录
- `@Public()` 与 `@Roles(...)` 互斥
- `RolesGuard` 看到 `@Roles(...)` 但 `request.user` 为空 → **拒绝访问**(抛 `BizException(BizCode.UNAUTHORIZED)`),不要因没拿到 user 就放行

### `JwtAuthGuard` 通过 `Reflector` 识别 `@Public()`

```typescript
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) { super(); }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
```

`@Public()` 装饰器使用 `SetMetadata(IS_PUBLIC_KEY, true)`,常量与装饰器同文件导出。

### 登录

- v1 入参固定 `username + password`(不支持 email / 手机号 / 验证码登录)
- `username` 入库与查询前统一 `trim()` + `toLowerCase()`
- 校验在 `auth.service.ts` 内手写:`findFirst` → `bcrypt.compare` → `JwtService.sign`
- **不引入 `LocalStrategy`**
- 登录成功后**顺手更新** `lastLoginAt = new Date()`;更新失败只 `logger.warn`,**不阻断登录响应**(避免一次写库失败把登录链路挂掉);v1 不做 `login_logs` 表
- `userSafeSelect` 与 `UserResponseDto` 必须包含 `lastLoginAt` 字段,管理后台用于查看账号活跃度

### 登录失败防账号枚举

四场景统一抛 `BizException(BizCode.LOGIN_FAILED)`,响应 `{ code: 10004, message: '账号或密码错误', data: null }` + HTTP 401,**完全相同**:

- `username` 不存在
- `password` 错误
- 账号已禁用(`status=DISABLED`)
- 账号已软删除(`deletedAt != null`)

禁止在登录接口区分提示"账号不存在""密码错误""账号被禁用",任何字段差异(包括 message 文案、错误码细分、响应耗时显著差异)都视为枚举漏洞。

**Timing 防御铁律**:`username` 不存在时**也必须**跑一次 `bcrypt.compare(password, dummyHash)`(用一个预先生成、模块级常量化的固定 dummy hash),保证四场景的响应耗时一致。**禁止** `if (!user) throw LoginFailed` 这类早返回——`bcrypt.compare` 是慢操作(~50ms 量级),早返回会让"账号不存在"明显比"密码错误"快几十毫秒,攻击者据此可枚举有效账号(timing oracle 攻击)。

### JwtPayload 最小

```typescript
export interface JwtPayload {
  sub: string;      // user.id
  username: string;
}
```

**不塞 `role`,不塞完整用户对象。**

### 查库唯一位置

`JwtStrategy.validate()` 每次请求根据 `payload.sub` 查库,校验 `deletedAt === null && status === UserStatus.ACTIVE`。校验失败(token 无效 / 已过期 / 用户不存在 / 用户被禁用 / 用户已软删除)统一抛 `BizException(BizCode.UNAUTHORIZED)`。

`validate()` 返回的对象由 passport 自动挂到 `request.user`。`JwtAuthGuard` 不要再写一份查库逻辑。

### 两阶段错误码区分

| 阶段 | 触发位置 | 错误码 | code | message |
|---|---|---|---|---|
| 登录阶段 | `auth.service.ts` 校验 `username + password` 失败 | `LOGIN_FAILED` | 10004 | 账号或密码错误 |
| 已登录请求 | `JwtStrategy.validate()` token / 用户状态失败 | `UNAUTHORIZED` | 40100 | 未登录或登录已失效 |

两者 HTTP status 都是 401,**前端必须按 `code` 区分**(避免管理员重置密码后旧 token 失效被前端当成"登录表单密码错")。

### `CurrentUser` 类型

```typescript
export interface CurrentUser {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
}
```

**权限判断必须使用本次查库得到的 `role`,不得信任 token payload 中的角色信息。**

### 不主动加缓存"优化"

每请求查库是有意设计:主键索引 sub-millisecond 级,远不是瓶颈;换来"被禁用户即时失效"。升级条件见 `ARCHITECTURE.md` §9(用户校验耗时 >20% 或单表 QPS > 1000 才考虑 Redis 短 TTL 缓存)。

---

## 9. 密码处理铁律

| 出现位置 | `password` | `passwordHash` |
|---|---|---|
| Prisma model | ❌ | ✅ 唯一允许 |
| 响应 DTO | ❌ | ❌ |
| 请求 DTO | ✅ (`password` / `newPassword`) | ❌ |
| service 内部 | ✅(只能从请求 DTO 读取,落库前必须哈希) | ✅ |

- v1 默认 `bcryptjs`,salt rounds 固定 `10`
- 安装:`pnpm add bcryptjs` + 类型 `pnpm add -D @types/bcryptjs`
- 统一 import:`import * as bcrypt from 'bcryptjs'`
- DTO 校验:密码至少 8 位 + 含数字 + 字母
- service 接收 `password` 后**入库前必须** `bcrypt.hash()`,绝不裸传 Prisma
- 响应 DTO 通过 `userSafeSelect` 排除 `passwordHash`,任何接口响应里都不应出现该字段
- `POST /api/users` **必须由调用方传 `password`**,禁止后端生成默认密码或留空
- `PUT /api/users/:id/password` 接收 `ResetUserPasswordDto { newPassword }`,**不需要 `oldPassword`**,但必须走 `assertCanManageUser`
- 管理员重置密码后**不主动吊销 access token**(access ≤ 15m 自然过期);**必须主动撤销目标用户全部 refresh token**(`revokedReason='admin-password-reset'`,P0-E PR-3 落地;沿 [`docs/first-release-p0e-refresh-token-review.md §7.2`](docs/first-release-p0e-refresh-token-review.md));如需立即阻断 access token,由管理员把目标用户 `status` 改 `DISABLED`(经每请求查库即时生效)
- **本人自助改密只能通过独立接口** `PUT /api/users/me/password`,**不得**在 `PATCH /api/users/me` 或其他资料更新接口里夹带"顺手改密码"逻辑
- `PUT /api/users/me/password` 仅允许在 P0-D 评审稿 `docs/first-release-p0d-change-my-password-review.md` 冻结后由独立 PR 实现,**实现必须严格遵守该评审稿**(行为契约 / 错误码 / 鉴权 / 限流 / audit 全部以评审稿为准);**不接管理员重置他人密码接口** `PUT /api/users/:id/password`,该接口契约保持不变
- 本人改密接口入参固定 `ChangeMyPasswordDto { oldPassword, newPassword }`,`oldPassword` 必填(与管理员重置无 `oldPassword` 的语义对称区分);`newPassword` 校验沿 `ResetUserPasswordDto.newPassword` 范式(至少 8 位 + 含数字 + 含字母);严格白名单,**禁止**夹带 `username` / `email` / `role` / `status` / `passwordHash` / `id` 等任何其他字段
- 本人改密接口新增 BizCode:`OLD_PASSWORD_INVALID = 10005`(`当前密码不正确`,HTTP 401)、`NEW_PASSWORD_SAME_AS_OLD = 10006`(`新密码不能与当前密码相同`,HTTP 400);**禁止**复用 `LOGIN_FAILED` 或 `BAD_REQUEST` 兜底语义
- 本人改密接口必须挂 `@PasswordChangeThrottle()`:5 次 / 60 秒,第一版固定 IP 维度;沿 V1.1 §17.7 `@nestjs/throttler` 内存 storage,**禁止** Redis storage;限流参数从 `src/config/app.config.ts` 注入,**禁止**硬编码在装饰器
- 本人改密成功必须写 audit:`AuditLogEvent.UserPasswordChangedSelf`(命名风格代码 PR 前与既有事件逐字对齐);**禁止**把 `oldPassword` / `newPassword` / `passwordHash` 任何明文或 hash 写入 audit log
- 本人改密成功后**不主动吊销 access token**(沿 P0-E v1 D-4;access ≤ 15m 自然过期);**必须主动撤销该用户全部 refresh token**(`revokedReason='self-password-change'`,P0-E PR-3 落地;沿 [`docs/first-release-p0e-refresh-token-review.md §7.1`](docs/first-release-p0e-refresh-token-review.md));`tokenVersion` 仍**本期不做**,沿 P0-E v1 D-4
- 用户被 `DISABLED`(`PATCH /api/users/:id/status` → `DISABLED`)或被软删(`DELETE /api/users/:id`)时,**必须**主动撤销目标用户全部 refresh token(`revokedReason='admin-disable'` / `'admin-delete'`,P0-E PR-3 落地;沿 P0-E v1 §7.3 / §7.4);access token 由 `JwtStrategy.validate` 每请求查库即时失效(沿现状)
- 本人改密接口**不做**首次登录强制改密、忘记密码 / 邮箱找回、user-member 绑定能力,这些越界诉求出现时必须暂停说明

### P0-E refresh token 鉴权铁律(2026-05-17 由 P0-E 评审稿 v1 解锁)

> 本子节是 P0-E 代码 PR-3 实施的硬约束。任何偏离视为越权。详细设计见 [`docs/first-release-p0e-refresh-token-review.md`](docs/first-release-p0e-refresh-token-review.md);冲突时以评审稿为准,本节让步。

**refresh token 生成与存储**:
- refresh token 必须由 `crypto.randomBytes(32).toString('base64url')` 生成(256 bit 熵);**禁止**用 JWT、UUID、自增 ID、`Math.random`
- refresh token 是 **opaque random token**,**不是 JWT**;客户端不应也不能解析其中信息
- refresh token **明文绝不入库**;DB 仅存 `tokenHash = crypto.createHash('sha256').update(raw).digest('hex')`(64 字符 hex);字段 `tokenHash @unique`
- **禁止**用 bcrypt / argon2 哈希 refresh token(高熵随机串无暴破语义,sha256 sub-ms 性能远优)
- refresh token 明文**绝不**进入:日志、audit `context.*`、OpenAPI 示例(`@ApiProperty` example 字段)、测试 fixture、测试快照、文档示例、handoff、release notes;只在 login / refresh 接口响应体 `data.refreshToken` 中出现一次

**JWT payload 严格 zero drift**:
- `JwtPayload` 严格保持 `{ sub, username }`(`+iat / +exp / +nbf` 标准字段);**禁止**新增 `role` / `permissions` / `tokenVersion` / `tv` / `jti` / `email` / 任何业务字段
- `auth-login.e2e-spec.ts` 已硬断言 payload 字段集恰好为 `{ sub, username, iat, exp, nbf }`(沿评审稿 §1.1);P0-E PR-3 实施**禁止**改此断言
- `JwtStrategy.validate` 严格保持 `select: { id, username, role, status, memberId }`;**禁止**读 `passwordHash` / `tokenVersion`(后者本期不存在);校验仅 `deletedAt === null && status === ACTIVE`

**DTO / Response 契约**:
- `LoginDto` 入参 schema 严格 **zero drift**(字段名 / 类型 / `@Matches` / `@MinLength` / `@MaxLength` 全保留);**禁止**新增任何字段(包括 `rememberMe` / `deviceId` / `clientId` / `keepSignedIn`)
- `LoginResponseDto` 允许扩展 `refreshToken: string` + `refreshExpiresAt: string`(向后兼容);字段集变为恰好 5 项;扩展后**禁止**再增字段
- `refreshExpiresAt` 是 **ISO 8601 UTC 时间字符串**(`new Date(...).toISOString()` 输出格式,带毫秒 + `Z` 后缀;示例 `"2026-08-16T00:00:00.000Z"`),**不是 TTL 字符串**(如 `"90d"`);语义是 **refresh token family 的 absolute expiration 时刻**;rotation 后新 refresh token **继承同一个 `refreshExpiresAt`**,响应里返回**相同的 ISO 时刻字符串**,**禁止** sliding expiration / refresh-on-use 延期(沿评审稿 §3.1 D-1 + §4.2);客户端读 `refreshExpiresAt` 即知 family 何时过期,**无需**信任本地时钟做 `now + TTL` 计算
- **TTL 配置 ≠ 响应字段**:服务端 env `JWT_REFRESH_EXPIRES_IN`(代表 TTL,如 `"90d"`)与 `jwt.config.ts` 内部 TTL 字段沿 v1 `expiresIn` 范式;**响应字段**叫 `refreshExpiresAt`(ISO 8601 UTC),在 service 内 `new Date(now + ttlMs).toISOString()` 计算后返给客户端;两者职责分离
- `RefreshTokenDto` / `LogoutDto` 严格白名单 1 字段(`refreshToken`);**禁止**夹带 `deviceId` / `userId` / 任何其他字段

**rotation 与 expiration 三不变式**:
- **rotation always**:每次 `POST /api/auth/refresh` 必发新 refresh token + 旧 refresh 同事务内标 `rotatedAt + revokedAt + replacedById`
- **absolute expiration**:rotation 产生的新 refresh token `expiresAt` **不延长**,严格继承原 family 首个 token 的 `expiresAt`;refresh TTL `90d`(P0-E v1 docs hotfix 2026-05-18 由 30d 调整,降低内部系统低频用户频繁重登的不便;沿评审稿 §3.5 D-5);**禁止** sliding expiration / refresh-on-use 延期;**达到 `refreshExpiresAt` 后必须重新登录**(`POST /api/auth/login`),refresh 接口对已过期 family 返 `REFRESH_TOKEN_INVALID=10007`
- **reuse detection 触发 family revoke**:`refresh` 接口收到 `rotatedAt != null` 的 row(旧 raw 被重放)→ 同事务内 `updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now(), revokedReason: 'family-revoked' } })`,然后抛 `REFRESH_TOKEN_INVALID`

**logout 行为契约**:
- `POST /api/auth/logout` 只撤销**当前** refresh token(`revokedReason='logout'`);同 family 其他 rotation 链 token 不动
- `POST /api/auth/logout` 走 `@Public()`(refresh token 自身即凭证;允许 access token 过期后 logout 自己)
- `POST /api/auth/logout` **幂等**:不存在 / 已撤销 / 已过期 → 仍返 200(沿 RFC 7009 §2.2);**不**抛业务码
- `POST /api/auth/logout` access token 若随头传入,**不**校验、**不**消费、**不**吊销
- `POST /api/auth/logout-all` 走 `JwtAuthGuard`,撤销当前 user **全部**未过期且未撤销的 refresh token(`updateMany revokedReason='logout'`);返 `{ revokedCount }`

**联动撤销四场景(沿 §9 主条目)**:
- 本人改密(`PUT /api/users/me/password`)→ 撤销该 user 全部 refresh,`revokedReason='self-password-change'`
- 管理员重置(`PUT /api/users/:id/password`)→ 撤销目标 user 全部 refresh,`revokedReason='admin-password-reset'`
- 用户禁用(`PATCH /api/users/:id/status` → `DISABLED`)→ 撤销目标 user 全部 refresh,`revokedReason='admin-disable'`
- 用户软删(`DELETE /api/users/:id`)→ 撤销目标 user 全部 refresh,`revokedReason='admin-delete'`
- 上述四场景的 `updateMany` 必须在**同事务**内与主写操作执行(沿 P0-D `prisma.$transaction` 范式);audit `extra.refreshTokensRevoked: count` 必写

**access token 行为锁定**:
- access token **本期不主动吊销**(沿 P0-E v1 D-4);依赖 `JWT_EXPIRES_IN=15m` 自然过期 + `JwtStrategy.validate` 每请求查库阻断 `DISABLED` / 软删用户
- `JWT_EXPIRES_IN` 由当前 `7d` 收敛到 `15m`(P0-E PR-3 改 `.env.example`;运维侧上线时同步)
- access token blacklist / JWT revoke list **本期不做**(§1 C 档);未来真出现"改密后所有 access 立即失效"诉求时,沿 §1 B 档 `tokenVersion` 路径单独评审
- e2e `users-change-my-password.e2e-spec.ts` §7.5 "改密后旧 access token 仍可调 `/me`" 反向锁定断言**继续保留**(P0-E 不破)

**限流契约(refresh / logout / logout-all)**:
- `POST /api/auth/refresh`:**新建独立 throttler 实例** `'refresh'`,IP 维度 **30 次 / 60 秒**;装饰器 `@RefreshThrottle()`(沿 `@PasswordChangeThrottle` 范式实现:纯 metadata 标记,limit / ttl 在 `throttle-options.ts` 从 `app.config.ts` 注入)
- `POST /api/auth/logout`:**无限流**(刻意;避免攻击者吃光合法用户 logout 配额)
- `POST /api/auth/logout-all`:**复用** P0-D `'password-change'` throttler(IP 维度 5/60);沿"高危操作低频限流"语义
- 三 throttler 实例(`default` / `password-change` / `refresh`)在 `throttle-options.ts` `throttlers[]` 注册,**物理隔离**:登录失败爆破不消耗 refresh / logout-all 配额,反之亦然
- 全部命中走统一 `BizException(BizCode.TOO_MANY_REQUESTS)` + HTTP 429;**不暴露** `Retry-After` / `X-RateLimit-*` 头(沿 [`src/bootstrap/throttle-options.ts`](src/bootstrap/throttle-options.ts) `setHeaders: false`)

**audit 写入(4 新事件 + 1 隐含新增)**:
- `auth.login`(login 成功路径写入;`resourceType='user'`,`extra.familyId`)
- `auth.refresh`(refresh 成功 + family revoke 路径;`resourceType='refresh_token'`,`extra.familyId / replayDetected / familyRevoked?`)
- `auth.logout`(logout 含幂等命中均写;`extra.found: boolean`)
- `auth.logout-all`(logout-all;`extra.revokedCount: number`)
- `password.reset.by-admin`(管理员重置今未写 audit,P0-E PR-3 顺手补;命名 PR-3 启动前与既有 18 项事件逐字复核)
- 命名风格沿 P0-D `password.change.self` kebab-case `<resource>.<action>` / `<resource>.<action>.<scope>`;PR-3 启动前再次 grep [`src/modules/audit-logs/audit-logs.types.ts`](src/modules/audit-logs/audit-logs.types.ts) 复核 `logout-all` 段内 dash 是否符合 `attendance-sheet.final-review` 范式
- audit `extra` **禁止**写:refresh token 明文 / `tokenHash` / `passwordHash` / IP 完整段(IP 已在 `AuditContext.ip` 字段)
- audit `extra` **允许**写:`familyId`(cuid,不是凭证)/ `replayDetected: boolean` / `revokedCount: number` / `revokedReason` 字符串 / `found: boolean`

**BizCode 段位(锁死)**:
- 仅新增 `REFRESH_TOKEN_INVALID = 10007`(HTTP 401);沿 100xx users 段,LOGIN_FAILED=10004 / OLD_PASSWORD_INVALID=10005 / NEW_PASSWORD_SAME_AS_OLD=10006 之后下一可用号位
- **禁止**拆 `REFRESH_TOKEN_EXPIRED` / `REFRESH_TOKEN_REVOKED` / `REFRESH_TOKEN_REPLAY`;沿评审稿 v1 D-6 + §5 BizCode 段位登记段
- logout / logout-all 接口**不**抛业务码(logout 幂等;logout-all 走通用 40100 / 42900)

**不做清单(沿 P0-E v1 D-9)**:
- ❌ `tokenVersion` 字段(§1 B 档;改 `User` schema 风险与回报不匹配)
- ❌ access token blacklist / JWT revoke list(§1 C 档)
- ❌ refresh_tokens 查询接口(§1 C 档)
- ❌ 已登录设备列表 UI / 单设备管理 / device fingerprint(§1 C 档)
- ❌ Redis / Queue / Cron(§1 B 档;refresh token 撤销靠 DB 主键索引 sub-ms 查询)
- ❌ 完整 OAuth 2.0 / OIDC / refresh token tree(§1 C 档)
- ❌ httpOnly cookie 传 refresh token(多端 Web + 小程序 + APP 统一 body 传)
- ❌ 改 `LoginDto` 入参 schema / `JwtPayload` / `JwtStrategy` 查库字段(沿 v2-api-contract §6.5 + 本节铁律)
- ❌ refresh token 失败码细分 / 微信小程序 / OAuth 第三方登录(沿评审稿 v1 D-9)

**实施前置(沿 P0-D 4-PR 串行范式)**:
- P0-E PR-3 代码 PR 在 `prisma migrate dev` 前**必须**先 `--create-only` 生成 SQL,贴回对话等用户拍板再 apply(沿 §0)
- PR-3 启动前必须按评审稿 §11 5 项复核点逐项 grep:`AuditLogEvent` 命名、throttler 实例风格、`@ApiBizErrorResponse` 风格、10007 段位无抢号、`prisma migrate dev` 预生成 SQL

---

## 10. 软删除

不使用 Prisma 全局软删除中间件。在 `users.service.ts` 内封装:

```typescript
private notDeletedWhere<T extends object>(where: T = {} as T) {
  return { ...where, deletedAt: null };
}
```

- **禁止** `prisma.user.delete()`,删除走 `update({ deletedAt: new Date(), status: UserStatus.DISABLED })`
- 所有非"管理员看回收站"查询经 `notDeletedWhere()` 过滤
- 业务详情查询禁用 `prisma.user.findUnique()`,统一 `findFirst({ where: notDeletedWhere(...) })`
- `seed` / 创建 / 更新用户的 `username` / `email` 唯一性预检查**必须**用 `findUnique`(包含软删记录),**禁止**用 `findFirst + notDeletedWhere`——软删后 `username` / `email` 不复用,唯一性预检查的目的就是检测包含软删在内的全部占用;若用 `notDeletedWhere` 过滤,软删占用会通过预检查,落库时撞 unique index 报 P2002,前端拿到一个本可前置友好提示的服务器侧异常
- `findById` 找不到(含已软删)统一抛 `BizException(BizCode.USER_NOT_FOUND)`
- 访问已删除用户的详情 / 修改 / 重置密码 / 改角色 / 改状态 / 删除接口,统一表现为用户不存在
- 登录路径额外校验 `status === ACTIVE`,不只 `deletedAt === null`
- v1 不提供恢复接口

---

## 11. DTO 与 Prisma 类型严格分离

- 入参 DTO 带 `class-validator` 装饰器
- 出参 DTO `UserResponseDto` 显式列出对外字段(永不含 `passwordHash`,**必须包含** `lastLoginAt`)
- Prisma 生成的 `User` 类型仅在 service 内部用,**绝不直接返给 controller / 前端**
- `User` 对外返回必须使用集中定义的 `userSafeSelect`(在 `modules/users/users.select.ts`)
- `UserResponseDto` 与 `userSafeSelect` **必须同步维护**:增删字段时同时改两边
- 禁止 `*.entity.ts`

### 入参 DTO 字段白名单(纵深防御)

`forbidNonWhitelisted: true` 是兜底,DTO 自身白名单是第一道防线;一旦 DTO 多声明一个字段,纵深防御直接破口。

- **`UpdateMyProfileDto`**(`PATCH /api/users/me`):仅允许 `nickname` / `avatarKey`。**禁止**包含 `username` / `email` / `password` / `newPassword` / `oldPassword` / `passwordHash` / `role` / `status` / `deletedAt` / `id` / `lastLoginAt` 等任何字段;本人自助改密必须走独立接口 `PUT /api/users/me/password`(铁律见 §9)
- **`UpdateUserDto`**(`PATCH /api/users/:id`,管理员改用户资料):**禁止**包含 `role` / `password` / `passwordHash` / `status` / `deletedAt` / `id`。角色修改走 `PATCH /api/users/:id/role`,密码重置走 `PUT /api/users/:id/password`,启用 / 禁用走 `PATCH /api/users/:id/status`,软删除走 `DELETE /api/users/:id`,**绝不在更新资料接口里夹带**
- **`CreateUserDto.role`** 可选,**禁止**直接透传给 Prisma;必须经业务层根据当前用户角色校验后再决定写入值(见 §13)

### `IdParamDto` 字符串校验

```typescript
export class IdParamDto {
  @ApiProperty({ example: 'cl9z3a8b00000abcd1234efgh' })
  @IsString()
  @Length(8, 64, { message: 'id 必须是 8-64 位字符串' })
  id!: string;
}
```

- **禁止** `@Param('id', ParseIntPipe)` / `id: number` / `@IsInt()`
- **禁止**写死 cuid 正则,优先长度校验
- 所有 `:id` 路径参数都通过 `IdParamDto` 校验

---

## 12. 事务

`prisma.$transaction` 必须用于:

- 多个写操作
- 先检查再写入的关键业务
- 管理员保护类操作(删除 / 禁用 / 降级 super admin)

**"检查剩余活跃 super admin 数 + 执行更新" 必须在同一事务内**,避免并发请求破坏"至少一个活跃 super admin"的不变式。

不需要事务:单表只读、单条普通资料更新且不依赖检查结果维护不变式。

---

## 13. 角色层级与管理员保护

层级固定:`SUPER_ADMIN > ADMIN > USER`。三层 Role **不是 RBAC**,不要扩展 permission 表 / `user_roles` 多对多 / `casl`。

### 管理边界

- v1 只有 `prisma/seed.ts` 能创建 `SUPER_ADMIN`;业务 API **禁止**创建 `SUPER_ADMIN`
- `SUPER_ADMIN` 业务 API 创建用户只允许 `role=ADMIN | USER`
- `ADMIN` 调用创建接口最终只能创建 `USER`;显式传 `ADMIN` / `SUPER_ADMIN` 抛 `FORBIDDEN_ROLE_OPERATION`
- `ADMIN` 只能管理 `USER`,不能查看 / 修改 / 禁用 / 删除 / 降级 / 创建 `ADMIN` / `SUPER_ADMIN`
- `USER` 只能访问本人接口

### 双层校验

**Guard 管入口,Service 管业务**:

- Guard 层 `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` 只决定谁能进管理接口
- Service 层 `assertCanManageUser(currentUser, targetUser)` 必须按当前角色与目标角色再次校验"能操作谁"

```typescript
private assertCanManageUser(currentUser: CurrentUser, targetUser: User) {
  if (currentUser.role === Role.SUPER_ADMIN) return;
  if (currentUser.role === Role.ADMIN && targetUser.role === Role.USER) return;
  throw new BizException(BizCode.FORBIDDEN_ROLE_OPERATION);
}
```

以下接口必须先 `findFirst` 查出目标用户,再 `assertCanManageUser`:

- `GET /api/users/:id`
- `PATCH /api/users/:id`
- `PUT /api/users/:id/password`
- `PATCH /api/users/:id/role`
- `PATCH /api/users/:id/status`
- `DELETE /api/users/:id`

### 自我保护(防误操作)

`id === currentUser.id` 时拒绝以下操作,抛 `BizException(BizCode.CANNOT_OPERATE_SELF)`:

- `DELETE /api/users/:id`
- `PATCH /api/users/:id/status`(改成 `DISABLED`)
- `PATCH /api/users/:id/role`

`PATCH /api/users/:id` 永远不接受 `role` 字段;角色修改必须走 `PATCH /api/users/:id/role`。

### 最后一个 SUPER_ADMIN 保护(防代码漏洞)

任何"剥夺超级管理员权限"操作前,在同一 `prisma.$transaction` 内查询剩余活跃 super admin 数并执行更新,确保操作后剩余 ≥ 1,否则抛 `BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED)`。

适用接口(当且仅当目标用户当前是 super admin 时检查):

- `DELETE /api/users/:id`
- `PATCH /api/users/:id/status`(改 `DISABLED`)
- `PATCH /api/users/:id/role`(role 改 `ADMIN` 或 `USER`)

### 用户列表可见范围

- `SUPER_ADMIN`:可看 `SUPER_ADMIN` / `ADMIN` / `USER`
- `ADMIN`:只能看 `USER`
- `USER`:不能进入管理列表

### 字段透传安全

`CreateUserDto.role` 可选,不传默认 `USER`,**禁止把 role 从 DTO 直接透传给 Prisma**;必须经业务层根据当前用户角色校验后再决定写入值。

### SUPER_ADMIN 之间互操作(v1 设计选择)

v1 允许 `SUPER_ADMIN` **互相管理**:重置密码、禁用、改角色、软删除均可,仅受**自我保护**和**最后一个 SUPER_ADMIN 保护**两层约束。

| 场景 | v1 行为 | 命中保护 |
|---|---|---|
| `SUPER_ADMIN A` 重置 `SUPER_ADMIN B` 的密码 | ✅ 允许 | 不命中(密码重置不剥夺权限) |
| `SUPER_ADMIN A` 把 `SUPER_ADMIN B` 改成 `DISABLED` | ✅ 允许(剩余活跃 super admin ≥ 1) | 命中最后一个保护 |
| `SUPER_ADMIN A` 把 `SUPER_ADMIN B` 降级为 `ADMIN` / `USER` | ✅ 允许(剩余活跃 super admin ≥ 1) | 命中最后一个保护 |
| `SUPER_ADMIN A` 软删 `SUPER_ADMIN B` | ✅ 允许(剩余活跃 super admin ≥ 1) | 命中最后一个保护 |
| `SUPER_ADMIN A` 对自己执行上述任一操作 | ❌ 拒绝 | 命中自我保护 |

这是 v1 的**明确选择,不是疏漏**:v1 默认只有一个 SUPER_ADMIN(`prisma/seed.ts` 创建),互操作是低频运维场景;若禁止互操作,会出现"前任 SUPER_ADMIN 离职后无法被接任者接管"的死锁。真出现"SUPER_ADMIN 互不可操作"诉求时按 `ARCHITECTURE.md` §9 升级路径处理,**作为权限模型升级**,不是渐进改造。

AI 实施时**不要**凭直觉额外加一层"SUPER_ADMIN 互不可操作"校验,也**不要**在 `assertCanManageUser` 里把 `targetUser.role === Role.SUPER_ADMIN` 列为禁止条件。

---

## 14. 配置文件归属

| 环境变量 | 归属 |
|---|---|
| `APP_PORT` / `APP_ENV` / `APP_CORS_ORIGIN` / `ENABLE_SWAGGER` | `src/config/app.config.ts` |
| `DATABASE_URL` | `src/config/database.config.ts` |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | `src/config/jwt.config.ts` |
| `SUPER_ADMIN_*` | **不进 config**,仅 `prisma/seed.ts` 内 `process.env` 直读 |

- 不为 CORS / Swagger / 单一开关再单建 `cors.config.ts` / `swagger.config.ts`
- 业务代码与 service **不直接 `process.env.XXX`**,统一通过对应 `*.config.ts` 注入(`SUPER_ADMIN_*` 是显式例外)
- 新增环境变量先决定归属,再同步加进 `.env.example` 与启动强校验
- **业务判断只用 `APP_ENV`,禁止混用 `NODE_ENV`** 做业务配置判断;`NODE_ENV` 只留给框架与工具链(NestJS / Prisma / Webpack)内部使用

### 启动强校验铁律

应用启动时必须强校验,任一不满足直接抛错退出,**禁止用 fallback 默认值兜底**:

| 校验项 | 要求 |
|---|---|
| `APP_ENV` | 必须 ∈ `{ development, test, production }` |
| `JWT_SECRET` | 至少 32 字符 |
| `JWT_SECRET`(production) | **不允许**等于 `.env.example` 默认值 `please-change-me-in-production-min-32-chars`;推荐用 `openssl rand -base64 48` 生成 |
| `APP_CORS_ORIGIN`(production) | **禁止**为空,**禁止** `*`,必须显式列出前端域名 |
| `APP_CORS_ORIGIN` 解析 | 支持英文逗号分隔多个 origin,`split(',').map(trim).filter(Boolean)` |
| `ENABLE_SWAGGER` | **必须严格字符串判断 `=== 'true'`**,**禁止** `Boolean(process.env.ENABLE_SWAGGER)` 或 truthy 判断,否则字符串 `'false'` 会被误判为开启 |
| Swagger 开关公式 | `APP_ENV !== 'production' \|\| ENABLE_SWAGGER === 'true'` |

`prisma/seed.ts` 额外强校验:

- `SUPER_ADMIN_USERNAME` 必须符合 username 格式(小写字母+数字+下划线+中横线,3-32)
- `APP_ENV=production` 下**禁止** `SUPER_ADMIN_USERNAME=admin`
- `APP_ENV=production` 下**禁止** `SUPER_ADMIN_PASSWORD=ChangeMe123456`(`.env.example` 默认值)
- `SUPER_ADMIN_USERNAME` 对应用户已存在时,**不覆盖**密码 / 角色 / 邮箱,只打印提示

---

## 15. 实施顺序

按 `ARCHITECTURE.md` 附录执行,逐步推进:

1. 项目初始化(`pnpm` + NestJS CLI + tsconfig / eslint / prettier)
2. Docker Compose 起 PostgreSQL
3. Prisma 接入(schema + 第一次 migration + `PrismaService`)
4. 公共基础件(全局 `/api` 前缀、CORS、异常过滤器、响应拦截器、`BizException`、`@Public` / `@CurrentUser` / `@Roles`)
5. `health/`(`GET /api/health` + `@Public()`)
6. Swagger 接入
7. `auth/` 登录
8. `users/` 模块(本人 + 管理员接口、分页、`userSafeSelect`、`notDeletedWhere`、自我保护 + 最后一个 SUPER_ADMIN 保护)
9. `prisma/seed.ts`
10. `common/storage/` 接口落地(只 interface + types,不实现 Provider)
11. `modules/ai/README.md` 占位
12. `CLAUDE.md` + `AGENTS.md`(本文件)
13. `README.md`

---

## 16. 测试策略

- v1 初始搭建不强制 E2E,不阻塞骨架
- `auth` / `users` 稳定后优先引入 E2E
- E2E 必须断言统一响应格式;错误响应必须**同时断言 HTTP status code 与 `BizCode.httpStatus` 一致**
- 登录失败必须覆盖**防账号枚举四场景**(`username` 不存在 / `password` 错 / 已禁用 / 已软删除),响应体与 HTTP status 完全相同
- E2E 优先覆盖:登录、JWT 鉴权、用户 CRUD、角色边界、软删除、禁用用户、最后一个 SUPER_ADMIN 保护、唯一约束冲突

---

## 17. V1.1 AI 执行规则

> **SRVF v0.13.0 注**:本节是母模板 V1.1 工程加固阶段历史段,SRVF 当前已进入 v0.13.0。后续 schema / API / 业务模块变更**以 [`docs/process.md`](docs/process.md) / [`docs/current-state.md`](docs/current-state.md) / 最新 handoff / 对应评审稿为准**,不再以本节直接判断。工程加固技术选型铁律(pino / throttler / helmet / terminus 等)仍生效。

> 本节是 V1.1 工程加固阶段的 AI 协作铁律,与 `ARCHITECTURE.md` §11 同步。**修改 V1.1 相关代码前,必须先读完 `ARCHITECTURE.md` §11 和 `TASKS.md`**。
> V1.1 与 v1 铁律冲突时,**以 v1 铁律为准**(§1-§16 全部保留生效)。

### 17.1 V1.1 阶段判定与必读

进入 V1.1 工程加固任何任务前必须做完以下三步:

1. 读 `ARCHITECTURE.md` §11(V1.1 Engineering Hardening 范围与禁止项)
2. 读 `TASKS.md`(V1.1 任务清单 + 依赖顺序 + 验收标准)
3. 在 `TASKS.md` 找到当前任务编号,确认其前置任务已经完成

未完成上述三步直接动手 → 视为擅自实现,需要回滚。

### 17.2 V1.1 允许项(必须按 §11.2 选型)

| 能力 | 必须使用的库 | 不允许的替代方案 |
|---|---|---|
| 结构化日志 | `nestjs-pino` + `pino` | winston / bunyan / 自写 logger / `console.log` |
| 限流 | `@nestjs/throttler` 内存 storage | Redis storage / 自写 rate limiter / 在 service 里 `setTimeout` |
| 安全头 | `helmet` | `cors` 中间件配置头 / 自写中间件 |
| 健康检查升级 | `@nestjs/terminus` | 自写 controller / 直接查 `prisma.$queryRaw('SELECT 1')` |
| 优雅关闭 | NestJS `app.enableShutdownHooks()` + `OnModuleDestroy` | `process.on('SIGTERM', ...)` 自写 handler |
| 请求 ID | `nestjs-pino` 内置 genReqId,或自写中间件用 `cuid()` | `uuid` / 自增计数器 / Math.random |
| CI | GitHub Actions | CircleCI / Jenkins / Travis / 本地脚本替代 |
| 容器化 | Dockerfile 多阶段构建 | 单阶段构建 / Buildpacks / 直接打包 dist |

选型一旦在 `TASKS.md` 中确认,后续 AI **不得擅自改换**。

### 17.3 V1.1 禁止项(全部沿用 v1 + 追加)

V1.1 阶段**仍然不做**(等价于 §1 v1 不做的事 + ARCHITECTURE.md §11.3):

- 不引入 Redis(包括限流 Redis storage、用户状态缓存、JWT 黑名单)
- 不引入 BullMQ / 任务队列 / 定时任务
- 不做操作日志 / 审计日志的**数据库持久化**
- 不接入 OpenTelemetry / Tracing / Sentry / Datadog / APM
- 不暴露 `/metrics` 端点(若未来需要,必须同步加入 `ResponseInterceptor` 跳过列表)
- 不做微信登录 / RBAC / 多租户 / 文件上传 Provider / pgvector / LLM(本人自助改密 `PUT /api/users/me/password` 由 P0-D 评审稿冻结后开放,铁律见 §9;**refresh token / logout / logout-all** 由 P0-E 评审稿 v1 冻结后开放,铁律见 §9 P0-E 子节;**两者均不通过** V1.1 工程加固通道实现)
- 不修改 `prisma/schema.prisma`(不加日志字段、不加请求统计字段)
- 不修改 `src/modules/auth/` 与 `src/modules/users/` 的业务路由、入参、出参、HTTP 方法、权限标注
- 不修改 §6 接口清单的任何已有接口
- 不为日志 / 限流 / helmet 单建 `*.config.ts`,统一归 `src/config/app.config.ts`

发现需求与禁止项冲突时,**必须暂停并说明**;不得"先实现再回滚"。

### 17.4 与 v1 铁律的复用约束

V1.1 新增能力**必须**复用 v1 已建立的基础设施:

- **错误处理**:限流命中、健康检查 ready 失败等异常必须经 `BizException` + `AllExceptionsFilter`,响应体仍是 `{ code, message, data: null }`,HTTP status 由 BizCode `httpStatus` 决定;**禁止**直接 `throw new HttpException(...)` 绕过统一错误码
- **响应格式**:`/api/health` / `/api/health/live` / `/api/health/ready` 三个端点继续走 `ResponseInterceptor` 包装,**不得**为对齐 `@nestjs/terminus` 原生输出绕过包装;Swagger 装饰器使用 `@ApiWrappedOkResponse(...)` 而非裸 `@ApiOkResponse`
- **错误码段位**:`TOO_MANY_REQUESTS = 42900` 落在 `4xxxx` 通用 HTTP 段,**不**占用业务模块的 `100xx` / `110xx` 段位;`message` 固定为 `请求过于频繁，请稍后再试`,**不暴露阈值数字、剩余配额、重置时间**
- **配置归属**:`LOG_LEVEL` / `LOGIN_THROTTLE_LIMIT` / `LOGIN_THROTTLE_TTL_SECONDS` 全部归 `src/config/app.config.ts`,启动强校验,默认值在 `app.config.ts` 内统一处理,业务代码不直读 `process.env.XXX`
- **日志屏蔽清单**:`password` / `newPassword` / `passwordHash` / `authorization` / `cookie` / `token` / `accessToken` / `refreshToken` / `secret` 命中字段在日志中**必须显示为 `[REDACTED]`**,不能仅做长度截断;v1 已有的 `userSafeSelect` 不能因为日志接入而被绕过——日志屏蔽是兜底,DTO 白名单仍是第一道防线
- **限流作用范围**:`@nestjs/throttler` 当前**只**作用于 `POST /api/auth/login`,**不**全局开启,**不**对其他业务接口加限流;若未来需扩展,必须先更新 `TASKS.md` 与 `ARCHITECTURE.md` §11.2

### 17.5 健康检查三端点契约

V1.1 完成后,健康检查端点契约固定为:

| 端点 | 检查内容 | 响应 |
|---|---|---|
| `GET /api/health` | 进程存活(向后兼容入口,实现等同 `/live`) | `{ code: 0, message: 'ok', data: { status: 'ok' } }` |
| `GET /api/health/live` | 进程存活(K8s liveness probe) | `{ code: 0, message: 'ok', data: { status: 'ok' } }` |
| `GET /api/health/ready` | DB 连通(`@nestjs/terminus` 的 `PrismaHealthIndicator` 或等价 `SELECT 1`) | 成功:`{ code: 0, message: 'ok', data: { status: 'ok', db: 'up' } }`;失败:**HTTP 500** + `{ code: 50000, message: '服务器内部错误', data: null }` |

铁律:

- 三端点都必须 `@Public()`,都走统一响应包装
- 三端点都必须有 `@ApiOperation({ summary })` + 包装响应装饰器
- `/api/health/ready` DB 连通失败时,**必须**抛 `BizException(BizCode.INTERNAL_ERROR)`,由 `AllExceptionsFilter` 按 `BizCode.INTERNAL_ERROR.httpStatus` 输出 **HTTP 500**;**禁止**直接 `throw new ServiceUnavailableException()` 绕过统一错误处理
- v1 已有的 `/api/health` E2E 必须继续通过,**不能**因升级 `@nestjs/terminus` 而破坏向后兼容

**关于 ready 失败 HTTP status 的最终决策(方案 A,优先级以 `ARCHITECTURE.md` §11.4 为最高)**:

- `ARCHITECTURE.md` §11.4 规定"HTTP status 由 `BizCode` 的 `httpStatus` 决定";`BizCode.INTERNAL_ERROR.httpStatus` 是 **500**,因此 ready 失败实际响应为 HTTP 500 + `code: 50000`,这是**有意为之**,不是 K8s 标准的 503 readiness 语义
- V1.1 阶段**不**新增 `BizCode.SERVICE_UNAVAILABLE`、**不**修改 `AllExceptionsFilter`、**不**对 ready 路径做特判;以最小改动半径与最高文档优先级为准
- AI 代理**不得**在 15.5 范围内自行新增 `BizCode.SERVICE_UNAVAILABLE` 或在 `AllExceptionsFilter` 内对 ready 路径做特殊映射;若未来确需标准 HTTP 503,作为独立任务在 V1.2+ 启动,届时同步更新本节、`CLAUDE.md` §17.5、`TASKS.md` §15.5 三处描述
- K8s readiness probe 对 5xx 一律视作 unready,500 与 503 在容器编排层面行为一致,生产可用性不受影响

### 17.6 优雅关闭契约

`PrismaService` 必须实现 `OnModuleDestroy`:

```typescript
async onModuleDestroy() {
  await this.$disconnect();
}
```

`main.ts` 必须 `app.enableShutdownHooks()`。

铁律:

- 不要在 `main.ts` 自写 `process.on('SIGTERM', ...)`;NestJS 已经处理
- 不要 `process.exit(0)` 强制退出;让 NestJS lifecycle hook 走完
- 关闭顺序由 NestJS 控制:HTTP 停接 → 等 in-flight 请求 → `OnModuleDestroy` → `OnApplicationShutdown`

### 17.7 限流契约

- 仅 `POST /api/auth/login` 走限流
- 限流 storage **必须**是 `@nestjs/throttler` 内存 storage(默认),**禁止**配置 Redis storage
- 限流参数从 `app.config.ts` 注入,**不**硬编码在装饰器里
- 超限抛 `BizException(BizCode.TOO_MANY_REQUESTS)`,经 `AllExceptionsFilter` 返回 HTTP 429 + 统一响应体
- 限流命中后**不返回** `Retry-After` 头,**也不返回** `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` 头;阈值数字、剩余配额、重置时间**一律不暴露**到响应体或响应头(包括日志的 message 字段)

### 17.8 V1.1 禁止"顺手做"清单

进入 V1.1 后 AI 容易"顺手"扩展的反模式,**全部禁止**:

| 反模式 | 为什么禁止 |
|---|---|
| "既然接了 pino,顺手把请求 body 全打日志" | 日志膨胀 + 敏感数据泄漏风险;只打必要字段(method、url、status、duration、requestId、userId) |
| "既然接了 throttler,顺手对所有接口加限流" | 限流参数未经业务评估,容易把正常用户挡掉 |
| "既然接了 terminus,顺手加 Redis / 外部 API 健康检查" | V1.1 不引入 Redis,也不依赖外部 API |
| "既然有 Dockerfile,顺手写 docker-compose.prod.yml" | 用户明确要求 V1.1 不修改 docker-compose.yml,且生产 compose 需要按真实部署环境定制 |
| "既然有 CI,顺手加发布到 npm / Docker Hub 的 job" | 发布流程超出 V1.1 范围,需要单独评估凭据管理与版本号策略 |
| "既然有日志,顺手把 BizException 写一条 ERROR 级日志" | BizException 是预期业务错误(如登录失败、用户已存在),应是 INFO 或 WARN;ERROR 留给未捕获异常和 5xx,否则告警噪音爆炸 |
| "既然有限流,顺手在 service 里加二次防护" | 防护重复,且 service 层难以正确实现 IP 维度限流;限流统一交给 `@nestjs/throttler` |
| "既然有请求 ID,顺手把它塞进 JWT payload" | JWT 是签发时确定的,请求 ID 是每请求生成的,语义不匹配 |

### 17.9 V1.1 阶段验收门槛

每个 V1.1 任务完成后,**必须**按以下两档逐项验证:

#### A 档 — 基础验收(每个任务都必须跑)

1. `pnpm lint` 通过
2. `pnpm typecheck` 通过
3. `pnpm test:e2e` 全部通过(含 v1 已有的 137 用例)
4. 该任务自身在 `TASKS.md` 列出的验收标准全部满足
5. 不得引入新的依赖到 `package.json`,除非该依赖已在 `TASKS.md` 对应任务中显式声明

#### B 档 — 手工验证(仅当任务涉及 HTTP 行为、全局中间件、拦截器、Guard、Controller、Swagger 时,在 A 档基础上追加)

启动服务,逐项确认:

- `/api/docs` 能正常打开,Swagger UI 完整可用
- `GET /api/health` 仍按 v1 契约返回(向后兼容,响应体为 `{ code: 0, message: 'ok', data: { status: 'ok' } }`)
- 本任务**新增或影响的接口**能按预期返回,覆盖典型成功路径与典型错误路径

#### 档位归属说明

- **必须跑 B 档**的任务示例:接入 `nestjs-pino`(影响全局日志中间件)、请求 ID 中间件、健康检查升级(新增 controller / 改 Swagger)、helmet(全局响应头)、登录限流(影响 Guard / Controller / Swagger 错误响应)
- **只跑 A 档即可**的任务示例:GitHub Actions CI 流水线(不动运行时)、Dockerfile 镜像构建(交付物层面变更,运行时行为不变)、优雅关闭(改 lifecycle 但 HTTP 契约不变;若改动确实可能影响请求收尾,可补 B 档观察一次)

任一未通过 → 不算完成,不能 commit。

### 17.10 边界声明

V1.1 完成后,**不要**自动触发 §9 升级路径。任何"日志接进来了顺手接 APM""限流接进来了顺手上 Redis""健康检查接进来了顺手暴露 metrics"的延伸,都需要重新评估业务诉求并经用户明确确认,而不是 AI 自行判定。

---

## 18. V2 调研/设计阶段约束(srvf-nest-api 派生项目专属)

> **SRVF v0.13.0 注**:本节是 SRVF V2 早期调研期约束;当前已进入开发期(批次 5-A / 6 / 7 / 8 + P0-* 已落地),"禁止 schema / migration / 新模块"设计期禁令**不再作为当前直接禁令**。§18.4 / §18.4.1 敏感信息字段治理要求(业务用途 + 查看角色 + 保存期限三问)**仍有效**。

> **状态**:**仅调研与设计阶段**,**不是开发执行约束**。
> **生效范围**:仅 `srvf-nest-api` 派生项目;不回流 `u-nest-api-starter` 模板仓。
> **与 v1 / V1.1 的关系**:与 §1-§17 同时生效;冲突以 §1-§17 为准。
> **解除条件**:`docs/srvf-foundation-research.md` + `docs/srvf-foundation-data-model-draft.md` 评审通过,且 `ARCHITECTURE.md §12` 升级为带 schema 锁定的开发蓝图。
> **边界依据**:本节所有"不做""暂不做""禁止"项,以 [`docs/srvf-foundation-research.md`](./docs/srvf-foundation-research.md) §3 / §6 为权威源,本节不重复罗列具体清单,只锁"调研/设计阶段的行为铁律"。
> **适用对象**:**任何** AI agent / 自动化工具 / 助手类程序 — 不限于 Claude Code,涵盖 Cursor / Cline / Aider / Continue / Copilot 等同类工具,以及未来可能接入的任意 agent 框架。

### 18.1 调研期硬禁止(行为级)

V2 调研 / 设计阶段,**禁止**以下任意一项动作,即使"看起来顺手就能做":

- 禁止运行 `prisma migrate dev` / `prisma migrate deploy` / `prisma db push`
- 禁止修改 `prisma/schema.prisma`(包括添加注释、调整字段顺序、加 `@@map` 等任何写入)
- 禁止修改 `prisma/seed.ts`(包括为 V2 字典 / 组织 / 队员预留 seed 代码骨架)
- 禁止新建 `src/modules/<业务>/` 任何目录与文件(members / organizations / dictionaries / attachments / audit-logs / events / event-participants / member-profiles / member-departments 等一律不建)
- 禁止新建 `src/common/<新基建>/`(audit / dict / 任何新 Provider 实装目录)
- 禁止安装新依赖(包括看似"早晚要装"的 `@nestjs/event-emitter` / 任何字典缓存库)
- 禁止修改 `package.json` / `pnpm-lock.yaml`
- 禁止修改 `Dockerfile` / `docker-compose.yml` / `.github/workflows/*`
- 禁止编写 V2 相关 unit / E2E / contract / smoke 测试草案
- 禁止修改 v1 已交付的任何 `src/` 文件(auth / users / health / config / common / database / bootstrap)
- 禁止生成 OpenAPI 契约快照变更

### 18.2 设计期内容禁止(草案表达级)

V2 草案文档 / 评审讨论中,**禁止**以下表达:

- 禁止把深圳救援队**真实**部门名(如"水域""山地""绳索""通信"等具体节点)写进任何文档或 seed 示例
- 禁止预先写死队员等级的具体取值
- 禁止预先写死活动类型 / 事件类型的具体取值
- 禁止预先写死证书 / 资质 / 装备类别的具体取值
- 禁止把 `users` 与 `members` 合并为一张表的设计(违反研究文档 §6.1)
- 禁止把"紧急联系人 / 医疗信息 / 装备 / 证件附件"等扩展字段堆入 `members` 主表(违反研究文档 §6.2)
- 禁止把 v1 系统级枚举(`Role` / `UserStatus`)或软删除标记字典化(违反研究文档 §6.3)
- 禁止用 JSON 数组 / 逗号分隔字符串 / `department1` `department2` 并列字段表达多对多(违反研究文档 §6.4)
- 禁止在草案文档中画"最终 ER 图"或写完整 Prisma DSL
- 禁止在敏感信息字段上跳过研究文档 §4.3 的"业务用途 / 查看角色 / 保存期限"三问就纳入 V2 草案
- 禁止在 V2 草案里"顺手"实现研究文档 §3 任一暂不做项

### 18.3 设计期表达要求(措辞级)

- 每个候选模型必须显式列出"待确认清单",空清单视作未完成
- 每个跨模型模式(字典 / 软删 / 审计 / 附件归属)必须列出**至少一个备选方案与回退条件**,不留单选独裁
- "已确认 / 当前倾向 / 待调研 / 暂不做"四档标签强制使用,**禁止**模糊措辞("应该""可能""差不多""一般来说")
- "倾向方案"**不等于**"已拍板",草案措辞必须区分;一段话同时出现"倾向"与"将实现"视作越权
- 涉及 `events` / `event_participants` 时必须援引研究文档 §2.6 的"通用化失败回退三档"(最小骨架 / 延后参与表 / 整体砍掉),不得强行通用化做大宽表

### 18.4 与用户的协作纪律

- 用户未对某节确认前,**不要**把该节内容回写到 `ARCHITECTURE.md §12` 的开发蓝图段
- 涉及敏感信息字段(身份证 / 紧急联系人 / 医疗 / 证件照)**必须**单独提问,不假设合规方案
- 发现 v1 / V1.1 铁律与 V2 草案冲突,**必须暂停说明**,不擅自调和
- 发现研究文档 §3 / §4 / §6 与新诉求冲突,**必须**回到研究文档先决策,再回到草案
- 字典 seed 真实内容由用户**私下提供**,不进公共仓库历史(对应研究文档 §5.1 / §7-R13)
- 任何"先占位以后再用""先存着规则以后补"的措辞,在敏感信息场景下视作越权(研究文档 §4.3)
- 任何 agent 在 V2 设计阶段以非 Claude Code 工具链切入(Cursor / Cline / Aider / API 直调 / 自建 agent 等),**亦受本节全部约束**;工具不同,边界一致

### 18.4.1 baseline 规范的强制读取与遵守

任何 Agent 在 V2 草案 / 开发场景下动手之前,**必须**读取并遵守 [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md)(自 commit `16876fe` 起锁定)。该文档承载 13 项 A 档基线规范(BizCode 段位、命名、响应包装、DTO 白名单、模块结构、错误码命名、配置归属、日志屏蔽、Guard、软删除、v1 兼容性、时区、验收门槛),与本节(§18)是**互补关系**:

- 本节(§18)= **过程性约束**(调研 / 设计阶段不能做什么)
- baseline = **规范性约束**(无论何时,V2 代码 / 文档必须如何写)

冲突优先级见 baseline §14.4(v1 §1-§17 > V1.1 §17 > baseline > 草案 > 任务卡)。

**违反 baseline 任一项视作越权**,必须暂停并向用户说明,**禁止**自行调和。

**适用对象**:任何 AI Agent / 自动化工具(Claude Code / Cursor / Cline / Aider / Continue / Copilot / API 直调 / 自建 Agent),不限工具链。

### 18.5 通用 agent 工具调用约束

不同 agent 工具链有不同动作原语,但 V2 调研期对工具调用的约束按"动作语义"统一:

| 动作语义 | V2 调研期允许? | 备注 |
|---|---|---|
| 读文件 / 列目录 / 搜索 / 查 Git 历史 | ✅ 允许 | 用于调研既有代码与历史决策 |
| 写文档(`docs/*.md` / `*.md` 顶层文档) | ✅ 允许 | 仅本节列出的 4 处文档 + 研究 / 草案文档 |
| 写代码(`src/**` / `prisma/**` / `test/**` 等) | ❌ 禁止 | 含新建空文件 / 占位目录 |
| 修改依赖(`package.json` / lockfile) | ❌ 禁止 | 含 `--dry-run` 类预演也禁止 |
| 运行 prisma 任何写命令(migrate / db push / seed) | ❌ 禁止 | `prisma generate` 同样禁止以避免隐式同步 |
| 运行测试 / lint / typecheck | ✅ 只读式允许 | 不允许带 `--write` / `--fix` 类自动修复 |
| 调用外部网络 / 拉取文档 | ✅ 允许 | 调研用途;结论必须落到文档 |
| 提交 commit / push 远程 | ⚠️ 仅含文档变更才允许 | commit 内容混入代码 / schema / 依赖即视作越权 |

### 18.6 V2 调研期"顺手做"反模式清单

| 反模式 | 为什么禁止 |
|---|---|
| 写 research / draft 时顺手补一个最小 `members` 表 | 违反 §18.1;草案是形态讨论,不是 schema 落地 |
| 看到 v1 `users` 缺 `memberId` → 顺手加可空外键 | 违反研究文档 §5.6;关联方案是 [当前倾向] 候选,未拍板 |
| 调研字典模式时顺手装字典缓存 / i18n 包 | 违反 §18.1 + 研究文档 §3.12 |
| 讨论审计时顺手在 `PrismaService` 加全局 hook | 违反 §18.1;审计写入策略是 [待调研] |
| 觉得"反正要做" → 先建 `src/modules/dictionaries/` 占位 | 违反 §18.1;占位目录是隐性范围扩张 |
| 草案里画"最终版" Prisma schema 块 | 违反 §18.2;草案不是 schema |
| 把"水域 / 山地 / 绳索"作为字典示例值写进文档 | 违反 §18.2 + 研究文档 §5.1 / R13 |
| 把"紧急联系人 / 医疗信息"加进 `members` 字段草案 | 违反 §18.2 + 研究文档 §6.2 / §4.3 |

### 18.7 解除时机与边界声明

V2 调研 / 设计阶段完成 → **不自动**进入开发阶段。开发阶段的执行铁律(类比 §1-§17)在草案评审通过后**另起新章节**(`ARCHITECTURE.md §12.7+` / 本文 §19+)落地,**不**通过修订本节(§18)实现。本节(§18)在开发阶段开始后保留作为"V2 调研期历史约束"不删除,但效力被新章节覆盖。

---

## 19. API Client Boundary 设计期约束(srvf-nest-api 派生项目专属)

> **状态**:**设计期 v0**(2026-05-19 起)。
> **生效范围**:仅 `srvf-nest-api`;不回流 `u-nest-api-starter`。
> **配套设计文档**:[`docs/api-client-boundary.md`](docs/api-client-boundary.md)(顶层规范)+ [`docs/api-client-boundary-inventory.md`](docs/api-client-boundary-inventory.md)(现状盘点)+ [`docs/api-client-boundary-migration-plan.md`](docs/api-client-boundary-migration-plan.md)(分阶段路线)。
> **与既有规则关系**:本节是**纯增补**,**不修改** §1-§18 任何既有规则语义。冲突时本节让步给 §1-§18 + baseline + V2 红线;冲突顺序见 §18.4.1 / [`docs/srvf-foundation-baseline.md §14.4`](docs/srvf-foundation-baseline.md)。
> **解除条件**:三份设计文档评审通过且后续 Phase 1+ 任务在 [`docs/process.md`](docs/process.md) 流程内**单独立项**后,本节作为正式蓝图引用。
> **与 [`CLAUDE.md §19`](CLAUDE.md) 同步**:两份文档 §19 内容应保持等价;冲突时以 `CLAUDE.md §19` 为准(沿仓库历史习惯,Claude Code 视角铁律优先)。

### 19.1 客户端边界设计期硬禁止(行为级)

本设计期(Phase 0)**禁止**以下任意一项动作,即使"看起来顺手就能做":

- ❌ 修改任何 `*.controller.ts` 的 `@Controller(...)` 前缀
- ❌ 修改任何 controller 的 HTTP method 装饰器 path 参数
- ❌ 新增 / 修改 / 删除任何 HTTP endpoint
- ❌ 新增 `app-*.controller.ts` / `admin-*.controller.ts` / `system-*.controller.ts`
- ❌ 修改任何 `@ApiTags(...)` / `@Roles(...)` / `@Public()` / `@RequirePermission(...)`
- ❌ 修改任何入参 DTO / 响应 DTO 字段
- ❌ 新增 `dto/app/` / `dto/admin/` / `dto/internal/` 目录与文件
- ❌ 移动 controller 文件物理位置(如 `src/common/storage/` → `src/system/storage/`)
- ❌ 修改 `prisma/schema.prisma` / 生成 migration / 执行 `prisma migrate dev`(沿 §0 + §18.1)
- ❌ 安装新依赖 / 修改 `package.json` / `pnpm-lock.yaml`
- ❌ 修改 `apply-swagger.ts` / `apply-global-setup.ts` 等 bootstrap 文件
- ❌ 编写本设计期相关 unit / E2E / contract / smoke 测试代码
- ❌ 修改 `CHANGELOG.md` / `docs/current-state.md` / `docs/handoff/*` 写"v0.15.0 计划做 client boundary 改造"等任何前瞻性内容

### 19.2 客户端边界设计期允许的动作(动作级白名单)

不同 AI Agent 工具链有不同动作原语,但本设计期对工具调用的约束按"动作语义"统一:

| 动作语义 | 允许? | 备注 |
|---|---|---|
| 读 `*.controller.ts` / `*.dto.ts` / `*.service.ts` / `src/bootstrap/*` | ✅ | 调研用途 |
| 读 / 写 `docs/api-client-boundary*.md` | ✅ | 本设计期核心产物 |
| 读 / 增补 `CLAUDE.md §19+` / `AGENTS.md §19+` | ✅ | 仅增补,不修改 §1-§18 |
| 修改 `CLAUDE.md` / `AGENTS.md` §1-§18 任何字符 | ❌ | 沿 §18 不动既有规则 |
| 写代码(`src/**` / `prisma/**` / `test/**`) | ❌ | 含新建空文件 / 占位目录 |
| 修改依赖(`package.json` / lockfile) | ❌ | 含 `--dry-run` 类预演也禁止 |
| 运行 prisma 任何写命令(migrate / db push / seed) | ❌ | `prisma generate` 同样禁止以避免隐式同步 |
| 运行 `find` / `grep` / `git log` / `git diff` | ✅ | 只读盘点 |
| 运行 `pnpm lint` / `pnpm typecheck` / `pnpm test:*` | ✅ | 只读式验收,不允许 `--write` / `--fix` |
| 调用外部网络 / 拉取文档 | ✅ | 调研用途;结论必须落到文档 |
| 提交 commit / push 远程 | ⚠️ | 仅 `docs/api-client-boundary*.md` + 本节 §19+ 增补;混入其它视作越权 |

### 19.3 与既有铁律的关系(冲突时让步表)

| 维度 | 优先级 |
|---|---|
| v1 §1-§16 / V1.1 §17 / V2 §18 | **最高**;本节让步 |
| `docs/srvf-foundation-baseline.md` 13 项基线 | **第二**;本节让步 |
| `docs/V2红线与复活路径.md` 五档红线 A/B/C/D/E | **第三**;本节让步 |
| 各批次评审稿(`docs/批次*.md` / `docs/first-release-*.md`)| **第四**;本节让步 |
| 本节(§19 API Client Boundary 设计期约束) | **第五**;让步给上方 |
| 设计文档(`docs/api-client-boundary*.md`) | 同上 |

**冲突铁律**:发现本节(§19)与上方任意一档冲突 → **必须暂停说明**,不擅自调和。

### 19.4 客户端边界设计期 Agent 工具链约束

- **TodoList / 任务记录**:任务内容只能是"读 / 写 / 评审 / 提问 / 文档增补"类动作;**禁止**出现"实现 controller / 改 path / 改 DTO / 新增 endpoint"等执行词
- **Plan / 计划模式**:任何**疑似越界**到代码改动的动作(改 controller / 新增 endpoint / 拆 DTO)**必须**先出 Plan 经用户确认,且默认应当被否决到 Phase 1+ 立项
- **Sub-agent / 调研代理**:允许做只读调研,产出必须落到 [`docs/api-client-boundary-inventory.md`](docs/api-client-boundary-inventory.md) 或对话总结,**不得**直接产出代码
- **Skill / 内置技能**:本设计期不调用任何会修改仓库代码的 skill
- **Commit**:本设计期每次 commit 仅含 `docs/api-client-boundary*.md` + `CLAUDE.md §19+` + `AGENTS.md §19+` 增补;**禁止**把文档与代码 / schema / 依赖变更混进同一 commit;commit message 前缀建议 `docs(boundary): <章节> <简述>`

### 19.5 客户端边界设计期"顺手做"反模式清单

| 反模式 | 为什么禁止 |
|---|---|
| 写规范文档时顺手新建一个 `src/modules/xxx/controllers/app-*.controller.ts` 空文件 | 违反 §19.1;占位文件是隐性范围扩张 |
| 看到 `UserResponseDto` 含 `lastLoginAt` → 顺手 omit 出 `AppMyUserResponseDto` | 违反 §19.1 + §18.1;DTO 拆分是 Phase 5 范围 |
| 看到 `/api/users/me` 与 `/api/v2/users/me/*` 双前缀不统一 → 顺手统一改一个 | 违反 §19.1;路径迁移是 Phase 2+ 范围 |
| 看到 `activities` `list` 含 `@Roles(USER)` → 顺手改 `@Roles(SUPER_ADMIN, ADMIN)` "收紧" | 违反 §19.1 + §1 v1 不做清单;权限收紧是 Phase 5 范围 |
| 写盘点表时顺手"修正"某个 `@ApiOperation` summary 文案 | 违反 §19.1;非设计期产物变更 |
| 顺手在 `apply-swagger.ts` 加 `/api-docs/app` 拆分 | 违反 §19.1;多份 Swagger 是 Phase 1 末期或 Phase 4 范围 |
| 在草案文档里画"App 视角 `MemberDto`" 字段全表 | 违反 §19.1 间接;字段级 DTO 设计是 Phase 2 评审稿范围,设计期 v0 只锁顶层规范 |
| 看到 P0-E refresh token `/api/auth/login` 没在 `/v1` 前缀下 → 顺手加双 path 别名 | 违反 §19.1;双写 path 是 Phase 1 范围 |

### 19.6 解除时机与边界声明

设计期 v0(Phase 0)完成 → **不自动**进入 Phase 1+ 任何代码改造阶段。
Phase 1+ 任务必须**单独立项**、**单独评审稿**、**单独 PR**(沿 [`docs/api-client-boundary-migration-plan.md §1 + §10`](docs/api-client-boundary-migration-plan.md))。

Phase 1+ 开始后,本节(§19)**继续生效**作为"客户端边界长期约束";后续若需新增"客户端边界执行铁律"(类比 v1 §1-§17 / V1.1 §17),应**新增** §20+,**不**修订本节(§19)。

### 19.7 已锁定决策(不再重开讨论)

> 本子节记录 2026-05-19 设计期 v0 + Phase 1 评审稿轮中**用户已拍板**的决策。
> AI 在未来会话中**禁止**重新质疑、重新评估、或建议变更以下决策;若用户主动要求重开,**必须**先暂停说明本节存在再讨论。
> 与 [`CLAUDE.md §19.7`](CLAUDE.md) 同步;冲突时以 `CLAUDE.md §19.7` 为准。

**D-1**:`contribution-rules` 客户端边界归 **System**(2026-05-19 拍板)
- 详细理由见 [`docs/api-client-boundary-inventory.md §2.25`](docs/api-client-boundary-inventory.md)
- 目标路径 `/api/system/v1/contribution-rules/*`
- 普通 ADMIN 如需使用,通过 `contribution-rule.*` 权限点明确授权,**不**归 Admin API

**D-2**:Phase 3 路径策略 = **方案 C**(`/api/v2/*` 长期保留为 Admin Legacy)(2026-05-19 拍板)
- 旧 `/api/v2/*` **不**主动 deprecated,**不**强制迁移,**不**做大面积老接口双写
- 新 App API 默认 `/api/app/v1/*`;新 System API 默认 `/api/system/v1/*`;新 Admin API 默认 `/api/admin/v1/*`
- PC 管理后台联调口径**不**因 Phase 3 破坏
- 详细理由见 [`docs/api-client-boundary-migration-plan.md §5`](docs/api-client-boundary-migration-plan.md)

**D-3**:Phase 1 拆分 = **1A(Tag 改名)+ 1B(Public/Auth path alias)两个独立 PR**(2026-05-19 评审稿)
- Phase 1 整体为 **C 档**(不是 A 档 docs-only);1A 与 1B 各自单独走 C 档验收
- 详细评审稿见 [`docs/api-client-boundary-phase-1-review.md`](docs/api-client-boundary-phase-1-review.md)
- AI **禁止**自行启动 Phase 1A / 1B 代码改造;必须用户在 [`docs/process.md`](docs/process.md) 流程内单独立项

**D-4**:Phase 0.5 App 身份 / 权限 / 数据可见性专项评审是 **Phase 2 启动的硬前置**(2026-05-19 立项)
- 详细评审稿见 [`docs/app-permission-boundary-review.md`](docs/app-permission-boundary-review.md)
- Phase 2 立项评审稿启动前,业务方**必须**先决议该专项 §10.1 标记 ✅ 阻塞的事项(候选 / 临时编号 App 登录策略、Admin 兼队员 `/me` 行为、`/me/permissions` 返 capability vs permission code、`me/*` 与 `my/*` 是否拆等)
- AI **禁止**在没有该专项决议结果的情况下启动 Phase 2 任何 P0 接口代码实施
- 该专项**不**改 schema / migration / Role enum / Permission seed / 任何 endpoint / 任何 DTO,严格沿 §19.1 设计期硬禁止

**D-5**:App permission decisions are locked before Phase 2(2026-05-19 用户拍板)

Before implementing any `/api/app/v1/*` endpoint, agents must respect [`docs/app-permission-boundary-review.md §10.2`](docs/app-permission-boundary-review.md) 的 4 条决策:

- **D-5.1(对应 §10.2 D-1)**:Candidate / temporary-number volunteers are **out of Phase 2 App login scope**;Phase 2 App APIs only support users with `User.memberId != null` AND `User.status = ACTIVE` AND `User.deletedAt IS NULL` AND `Member.status = ACTIVE`
- **D-5.2(对应 §10.2 D-2)**:Admin-as-member uses **linked-member self perspective**;`ADMIN` / `SUPER_ADMIN` role must not expand AppSelf field visibility;account without `memberId` → `canUseApp = false`
- **D-5.3(对应 §10.2 D-3)**:App exposes **capabilities** (`GET /api/app/v1/me/capabilities` 返 `canUseApp` / `canRegisterActivity` 等 product-level 字段),**not raw RBAC permission codes**;backend 仍必须在每个写端点重新做授权校验,capabilities **不是**授权证明
- **D-5.4(对应 §10.2 D-4)**:`/me/*`(identity / account / profile / capability) 与 `/my/*`(business records owned by current member)**physically separated** in path segments

Agents must **not reintroduce** `/api/app/v1/me/permissions` as a raw RBAC code endpoint **unless the user explicitly reopens this decision**.

**D-6**:Data access and lifecycle boundary is a Phase 2 precondition(2026-05-19 立项)

Before implementing any `/api/app/v1/*` endpoint, agents **must read and respect both**:

- [`docs/app-permission-boundary-review.md`](docs/app-permission-boundary-review.md)
- [`docs/data-access-lifecycle-boundary-review.md`](docs/data-access-lifecycle-boundary-review.md)

Agents must **not** implement App DTOs, data scopes, or lifecycle checks by:

- Reusing Admin DTOs(沿 Phase 0.6 §6.1 高风险返工点;`extends` / `Pick` / `Omit` 一个 Admin DTO 构造 App DTO 视作越权)
- Assuming `Role.USER` equals "mobile access"(沿 Phase 0.5 §1.4 + §10.2 D-2;Admin 兼队员也走 App self perspective)
- 在 Mobile endpoint 内默认 `scope = all`(沿 Phase 0.6 §3.3;Mobile 默认 `scope = self`)
- 跳过状态机校验直接执行写动作(沿 Phase 0.6 §4 + §6.4)
- 在响应 DTO 中暴露 **L3 Credential** 字段(`passwordHash` / `refreshToken` / `tokenHash` / `secretKey*` / `secretId*`)— 任何 PR snapshot 测试出现这些字段直接拒合并(沿 Phase 0.6 §2.2 + §6.5)

**违反铁律**:发现本节决策与新任务诉求冲突 → **必须暂停说明**,不擅自调和;不主动建议"重新评估方案 A/B"或"把 contribution-rules 改归 Admin"等回滚动作。
