# AI 友好的 TypeScript API 底座 — v1 蓝图

> NestJS + Prisma + PostgreSQL 的 API-only 后端底座,为 AI 辅助开发优化。
>
> 未来承载:公益救援队内部管理系统、U Studio 内部系统、客户项目二开、各类小程序后台。

---

## 目录

1. [设计原则](#1-设计原则)
2. [技术栈](#2-技术栈)
3. [项目结构](#3-项目结构)
4. [v1 范围:做什么、不做什么](#4-v1-范围)
5. [数据模型](#5-数据模型)
6. [API 接口清单](#6-api-接口清单)
7. [命名与编码约定(AI 铁律)](#7-命名与编码约定)
8. [环境变量](#8-环境变量)
9. [升级路径(什么时候加什么)](#9-升级路径)
10. [部署](#10-部署)
11. [V1.1 Engineering Hardening](#11-v11-engineering-hardening)

---

## 1. 设计原则

底座的存在意义是"让 AI 在新业务场景下少出错、少返工"。所有决策围绕这条主线:

- **API-only**:前端永远独立项目,绝不混在一起。AI 在全栈混合项目里最容易搞蒙。
- **v1 极致精简**:任何"未来可能用到"的功能先砍掉,需要时再加。复杂度上去,AI 改起来就慢、错、乱。
- **接口稳定先于实现完整**:storage 先定极简接口不实现;ai 模块先占位且 v1 不接 LLM。命名签名一次到位,免得后面改 API 牵动全身。
- **强约定 > 灵活配置**:统一返回格式、统一错误处理、统一模块结构、统一命名。让 AI 不靠猜。
- **命名即文档**:`passwordHash` 不叫 `password`,`key` 不叫 `path`,`@Roles(Role.SUPER_ADMIN)` 不写 `'admin'` 字符串。读代码不用猜语义。
- **不预先做 RBAC、多租户、刷新 token**:它们都是"以为以后用得到"的过度设计。真到那一步,看具体业务再加才合身。

---

## 2. 技术栈

| 层 | 选型 | 版本 | 理由 |
|---|---|---|---|
| 框架 | **NestJS** | ^11 | 强约定,AI 不会乱写;模块化天然适合"底座+业务"复用 |
| 运行时 | **Node.js** | 22 LTS | 稳,生态全。Bun 暂不上,免兼容坑 |
| 数据库 | **PostgreSQL** | 16 | 关系数据 + JSON + 向量(pgvector)一把梭,未来 AI 不用换库 |
| ORM | **Prisma** | ^6 | schema-first,类型安全,AI 训练语料最多 |
| 鉴权 | **@nestjs/jwt** + **passport-jwt** | — | JWT 登录与请求鉴权;v1 只实现账号密码登录 + JWT 校验,不预留多策略抽象 |
| 密码哈希 | **bcryptjs** | 当前稳定版 | v1 默认 bcryptjs,优先保证跨平台部署稳定;正式生产、用户规模扩大或安全要求提高时优先评估 argon2;native bcrypt 只在部署环境完全可控时使用 |
| API 文档 | **@nestjs/swagger** | peer dependency 兼容版本 | 按 `@nestjs/swagger` 的 `peerDependencies` 选择与当前 NestJS 主版本兼容的版本,不要手动钉死主版本号 |
| 校验 | **class-validator** + **class-transformer** | — | NestJS 标配 |
| 容器化 | **Docker Compose** | — | 本地一键起 PostgreSQL |
| 包管理 | **pnpm** | 固定版本 | pnpm-only,在 `packageManager` 中固定具体版本(如 `pnpm@9.x.x`);禁止使用 npm / yarn / bun,避免不同工具生成不一致 lockfile |

---

## 3. 项目结构

```
u-nest-api-starter/                  # 项目根
├── ARCHITECTURE.md                  # ⬅ 本文档,AI 协作的锚点
├── README.md                        # 快速开始(代码完成后再写)
├── CLAUDE.md                        # Claude Code 协作铁律(从本文档第 7 节抽取)
├── AGENTS.md                        # 通用 AI Agent 协作铁律(与 CLAUDE.md 并存)
├── docker-compose.yml               # 本地 PostgreSQL
├── .env.example                     # 环境变量模板
├── .env                             # 本地环境变量(gitignore)
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── nest-cli.json
│
├── prisma/                          # Prisma 工具链地盘
│   ├── schema.prisma                # 数据模型
│   ├── migrations/                  # 迁移文件(自动生成)
│   └── seed.ts                      # 数据库初始化脚本
│
└── src/
    ├── main.ts                      # 应用入口
    ├── app.module.ts                # 根模块
    │
    ├── config/                      # 集中配置
    │   ├── app.config.ts
    │   ├── database.config.ts
    │   └── jwt.config.ts
    │
    ├── common/                      # 跨模块基础设施
    │   ├── decorators/
    │   │   ├── public.decorator.ts          # @Public
    │   │   ├── current-user.decorator.ts    # @CurrentUser
    │   │   ├── roles.decorator.ts           # @Roles(Role.SUPER_ADMIN, Role.ADMIN)
    │   │   └── api-response.decorator.ts    # Swagger 统一响应包装
    │   ├── filters/
    │   │   └── all-exceptions.filter.ts     # 全局异常 → 统一返回格式
    │   ├── guards/
    │   │   ├── jwt-auth.guard.ts
    │   │   └── roles.guard.ts
    │   ├── interceptors/
    │   │   └── response.interceptor.ts      # { code, message, data } 包装
    │   ├── exceptions/
    │   │   ├── biz.exception.ts             # BizException
    │   │   └── biz-code.constant.ts         # 错误码集中
    │   ├── dto/
    │   │   ├── pagination.dto.ts
    │   │   └── id-param.dto.ts
    │   └── storage/                         # ⬅ v1 只放极简接口,不实现 Provider,不需要 .module.ts
    │       ├── storage.interface.ts         #    等 §9 升级路径触发后再补 storage.module.ts 与 providers/
    │       └── storage.types.ts
    │
    ├── database/                    # 运行时数据库代码
    │   ├── database.module.ts
    │   └── prisma.service.ts
    │
    └── modules/
        ├── auth/                    # 认证
        │   ├── auth.module.ts
        │   ├── auth.controller.ts
        │   ├── auth.service.ts
        │   ├── auth.dto.ts
        │   └── strategies/
        │       └── jwt.strategy.ts
        │
        ├── health/                  # 健康检查
        │   ├── health.module.ts
        │   └── health.controller.ts
        │
        ├── users/                   # 用户(本人 + 管理员)
        │   ├── users.module.ts
        │   ├── users.controller.ts
        │   ├── users.service.ts
        │   ├── users.dto.ts
        │   └── users.select.ts       # userSafeSelect,统一控制对外字段
        │
        └── ai/                      # ⬅ v1 占位,只 README.md,不注册模块/Provider
            └── README.md
```

**模块扩展原则**:未来加新业务模块,**平铺**加在 `src/modules/` 下,**不要嵌套**进 `system/` 子目录。如:

- `src/modules/orgs/` — 救援队/组织(救援队系统启动时)
- `src/modules/files/` — 文件管理(接 OSS 时启用)
- `src/modules/missions/` — 任务(救援队业务)
- `src/modules/devices/` — 装备(救援队业务)

---

## 4. v1 范围

### 做(只做这些)

- NestJS 项目骨架 + Prisma + PostgreSQL + Docker Compose 本地起
- 全局基础件:统一返回格式、全局异常、`BizException` + 错误码常量
- 全局 API 前缀固定为 `/api`,健康检查接口 `/api/health`
- JWT 登录策略(v1 仅支持 `username + password`)
- `modules/users` — 基础 CRUD,粗粒度 `role: SUPER_ADMIN | ADMIN | USER`,软删除
- `common/storage/` — 只放 `storage.interface.ts` 和 `storage.types.ts`;v1 不定义注入 token,不注册 `StorageModule`,不实现任何 Provider,不做签名 URL、分片上传、直传策略等高级能力
- `modules/ai/` — 只放 `README.md` 占位,v1 不注册 NestJS module,不实现 Provider,禁止实现 AI 能力
- Swagger 装饰器全覆盖,开发环境默认可用;生产环境仅 `ENABLE_SWAGGER=true` 时 `/api/docs` 可用
- `prisma/seed.ts` 写默认 super admin 账号(从 `.env` 读凭据)

### 不做(刻意砍,需要时再加)

| 砍掉的功能 | 什么时候再加 |
|---|---|
| RBAC(permission 表 / 按钮级权限 / casl) | 真出现"按钮级 / 资源级权限"诉求时(三层 Role 不算 RBAC,详见 §7.11) |
| 文件上传具体实现(本地/OSS/R2) | 第一个产品真要传文件时 |
| Redis / 队列 / 定时任务 | 真有异步任务、限流、缓存需求时 |
| 注册接口 | 几乎不会加(都是管理员创建账号) |
| 刷新 token | 真有"无感续期"诉求时 |
| **本人改密码接口**(`PUT /api/users/me/password`) | 真出现"普通用户用账密登录、需要自助改密码"产品时 |
| 微信小程序登录 | 第一个小程序产品要接时 |
| 多租户、组织树 | 救援队系统启动时 |
| LLM/向量检索 | 第一个用到 AI 的产品启动时 |
| 操作日志 / 登录日志 | 真有审计需求时 |
| 字典管理 | 真有"前端枚举要后台可配"诉求时 |

---

## 5. 数据模型

v1 只有一张表:`User`。

```prisma
// prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id           String     @id @default(cuid())
  username     String     @unique
  email        String?    @unique
  passwordHash String                                  // ⬅ 永远是 bcryptjs 哈希
  nickname     String?
  avatarKey    String?                                 // ⬅ 对齐 storage.key 命名
  role         Role       @default(USER)
  status       UserStatus @default(ACTIVE)             // ⬅ 启用/禁用,与软删独立
  deletedAt    DateTime?                               // ⬅ 软删除,不物理删
  lastLoginAt  DateTime?                               // ⬅ 最近一次登录成功时间
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt

  @@index([deletedAt])
  @@index([status])
}

enum Role {
  SUPER_ADMIN
  ADMIN
  USER
}

enum UserStatus {
  ACTIVE
  DISABLED
}
```

**字段约定**:

- 主键统一用 `cuid()`,不用自增整数(分布式友好,前端展示也不暴露记录数量)
- 时间戳统一 `createdAt` / `updatedAt`,不用 `created_at`(Prisma 默认 camelCase)
- `username` 格式固定为小写字母、数字、下划线、中横线,长度 3-32;入库前和登录查询前统一 `trim()` + `toLowerCase()`,禁止大小写账号或首尾空格账号并存
- `email String? @unique` 在 PostgreSQL 中允许多条 `NULL`,所以 email 可为空;email 入库前统一 `trim()` + `toLowerCase()`,空字符串按未填写处理;如未来切 MySQL,必须重新确认唯一索引对 `NULL` 的行为
- 软删除后 `username` / `email` 不复用。即使 `deletedAt != null`,原账号标识仍视为被占用,避免审计、恢复和历史引用混乱
- `SUPER_ADMIN_EMAIL` 可选;为空字符串时 seed 不写入 email 字段,不要写成空字符串入库
- `lastLoginAt` 登录成功后顺手更新,用于管理后台查看账号活跃度;更新失败只记录日志,不阻断登录;v1 不做 `login_logs` 表
- `nickname` DTO 使用 `@MaxLength(50)`,`avatarKey` DTO 使用 `@MaxLength(255)`,禁止接收超长字符串塞入数据库
- 软删除统一 `deletedAt: DateTime?`,所有查询**显式过滤**(详见 §7.8)
- `status` 与 `deletedAt` 语义独立:
  - `deletedAt != null` = 逻辑删除,不出现在正常列表里
  - `status = DISABLED` = 临时禁用,仍在列表中但无法登录
  - `DELETE /api/users/:id` 同时置二者(纵深防御);`PATCH /api/users/:id/status` 只动 status
  - 登录校验:`deletedAt = null AND status = ACTIVE`
- 字段命名忠诚于业务语义,密码字段叫 `passwordHash` 强提醒"绝非明文"

---

## 6. API 接口清单

全局 API 前缀固定为 `/api`,业务 controller 不要重复写 `/api`。

| 方法 | 路径 | 说明 | 权限 | 模块 |
|---|---|---|---|---|
| `GET` | `/api/health` | 健康检查,返回服务状态,必须 `@Public()` | 公开 | health |
| `POST` | `/api/auth/login` | `username + password` 登录,返回 JWT | 公开 | auth |
| `GET` | `/api/users/me` | 获取本人资料 | 登录 | users |
| `PATCH` | `/api/users/me` | 修改本人非敏感资料(昵称、头像 key) | 登录 | users |
| `GET` | `/api/users` | 用户列表(分页,返回 `PageResultDto<UserResponseDto>`) | super admin / admin(按角色层级过滤可见范围) | users |
| `POST` | `/api/users` | 创建用户 | super admin / admin(v1 只有 seed 能创建 SUPER_ADMIN;业务 API 禁止创建 SUPER_ADMIN;SUPER_ADMIN 可创建 ADMIN / USER;ADMIN 只能创建 USER) | users |
| `GET` | `/api/users/:id` | 用户详情 | super admin / admin(ADMIN 只能查看 USER) | users |
| `PATCH` | `/api/users/:id` | 修改用户资料(**不含密码、不含角色**) | super admin / admin(ADMIN 只能操作 USER) | users |
| `PUT` | `/api/users/:id/password` | 管理员重置用户密码 | super admin / admin(ADMIN 只能操作 USER) | users |
| `PATCH` | `/api/users/:id/role` | 修改用户角色 | super admin(只有 SUPER_ADMIN 能修改角色) | users |
| `PATCH` | `/api/users/:id/status` | 启用/禁用用户(只改 `status`) | super admin / admin(ADMIN 只能操作 USER) | users |
| `DELETE` | `/api/users/:id` | 软删除用户(同时置 `deletedAt` 和 `status=DISABLED`) | super admin / admin(ADMIN 只能删除 USER) | users |
| `GET` | `/api/docs` | Swagger 文档 | 开发环境默认公开;生产环境仅 `ENABLE_SWAGGER=true` 时公开 | — |

`PATCH /api/users/me` 的 `UpdateMyProfileDto` 字段白名单固定为 `nickname`、`avatarKey`;`username` / `email` / `passwordHash` / `role` / `status` / `deletedAt` 一律不接受。`email` 属于账号信息修改,需要验证邮箱归属、防止抢注等配套风控,不在 v1 范围。

**HTTP 方法选择规则**:

- `POST` — 创建新资源 / 不易归类的操作(如 login)
- `GET` — 读取
- `PATCH` — 部分更新(改昵称等单字段或局部字段)
- `PUT` — 完全替换(如密码,本质是用新值替换旧值)
- `DELETE` — 删除(本项目里恒为软删除)

**v1 故意不提供"本人改密码"接口**(`PUT /api/users/me/password`),**不是漏掉**。任何 AI 或新加入者看到这条都不要"补全":

- 内部管理系统的密码运维由管理员承担,用户忘密码走 `PUT /api/users/:id/password` 让管理员重置
- 小程序后台用 `wx.login`,本来就无密码概念
- 加这一个接口要带 `oldPassword` 校验、防爆破、密码复杂度二次提醒、修改后是否吊销其他设备 token 等配套决策,不属于 v1 极简骨架的范围

未来出现"普通用户用账密登录、需要自助改密码"的产品时再加,见 §9 升级路径。

管理员重置密码固定使用 `PUT /api/users/:id/password`。本项目把 `password` 视为一个独立子资源,因此使用 `PUT` 表示整体替换该子资源;不要混用 `PATCH`,也不要在其他用户资料接口里夹带修改密码。

管理员重置密码后,v1 **不主动吊销目标用户旧 token**,接受旧 token 在过期前继续可用的窗口期。若管理员需要立即阻断目标用户访问,必须同时调用 `PATCH /api/users/:id/status` 将其改为 `DISABLED`;后续由管理员重新启用后,目标用户再重新登录。只有当真实产品不能接受该窗口期时,才按 §9 升级路径引入 token 吊销机制。

---

## 7. 命名与编码约定

> 这一节是 AI 协作的核心。每条都是"AI 容易写错的地方提前写死"。
> 实施时要把这一节抽到 `CLAUDE.md` 里,让 AI 每次读 session 就能看到。

### 7.1 模块结构(业务模块固定 4 文件)

```
modules/<name>/
├── <name>.module.ts        # NestJS 模块声明
├── <name>.controller.ts    # HTTP 路由层
├── <name>.service.ts       # 业务逻辑层
└── <name>.dto.ts           # 请求/响应数据结构
```

例外:`health/` 只保留 `health.module.ts` 和 `health.controller.ts`,不要为了凑齐结构硬造 `health.service.ts` 或 `health.dto.ts`。

Prisma 项目不引入 Entity 概念,不要创建 `<name>.entity.ts`。复制粘贴一个模块改改就是新业务模块。AI 不会迷路。

DTO 文件升级规则:`<name>.dto.ts` 第一版允许集中放;当单个 DTO 文件超过 300 行时,允许拆成同模块内的 `dto/` 目录,但必须保持模块内聚,不要把 DTO 放到跨模块公共目录。

### 7.2 命名铁律

| 场景 | 错误示范 | 正确做法 | 原因 |
|---|---|---|---|
| 密码字段 | `password` | `passwordHash` | 防止误泄、误存明文 |
| 文件标识 | `path` / `filename` / `url` | `key` | 对齐 S3 生态,本地实现内部转 path |
| 角色判断 | `if (user.role === 'admin')` | `if (user.role === Role.ADMIN)` / `Role.SUPER_ADMIN` | 单一来源,改一个地方 |
| 角色装饰器 | `@Roles('admin')` | `@Roles(Role.SUPER_ADMIN, Role.ADMIN)` | 同上 |
| 错误抛出 | `throw new Error('用户不存在')` | `throw new BizException(BizCode.USER_NOT_FOUND)` | 错误码集中,前端可枚举 |
| 时间字段 | `create_time` / `createTime` | `createdAt` | Prisma 默认 + JS 惯例 |
| ID 类型 | 自增 int | `cuid()` 字符串 | 分布式友好,不暴露记录量 |
| 角色/状态枚举 | 手写 `users.enum.ts` | 从 `@prisma/client` 导入 `Role` / `UserStatus` | Prisma schema 是唯一来源,避免 TS enum 与 DB enum 漂移 |

**Role / UserStatus 统一从 Prisma 导出,禁止手写 enum**:

```typescript
import { Role, UserStatus } from '@prisma/client';
```

Prisma schema 是角色和状态枚举的唯一来源。业务代码、DTO、guard、seed 都使用 `@prisma/client` 生成的 `Role` / `UserStatus`,不要再创建 `modules/users/users.enum.ts`。

### 7.3 统一返回格式

所有接口经 `ResponseInterceptor` 包装为:

```json
{
  "code": 0,
  "message": "ok",
  "data": { ... }
}
```

业务代码只 `return data`,**永远不要**手动包 `{ code, message, data }`。

分页接口统一使用 `PaginationQueryDto` 接收入参,并返回 `PageResultDto<T>` 作为 `data`:

```typescript
// common/dto/pagination.dto.ts
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

export class PageResultDto<T> {
  items!: T[];
  total!: number;
  page!: number;
  pageSize!: number;
}
```

分页入参固定使用 `page` / `pageSize`;默认 `page=1`,`pageSize=20`,`pageSize` 最大 100。禁止在 v1 中使用 `limit` / `offset`、`skip` / `take`、`cursor` 等分页参数变体。Prisma 查询时统一换算为 `skip = (page - 1) * pageSize`,`take = pageSize`。

例如 `GET /api/users` 的业务返回值必须是 `PageResultDto<UserResponseDto>`,不要返回裸数组,也不要使用 `{ list, count }`、`{ rows, total }` 等变体。分页列表默认排序固定为 `orderBy: { createdAt: 'desc' }`,除非接口文档明确声明其他排序。

`GET /api/health` 必须标记 `@Public()`,并且也走统一响应包装。controller 只返回 `{ status: 'ok' }`,最终响应为 `{ code: 0, message: 'ok', data: { status: 'ok' } }`。不要为了健康检查绕过 `ResponseInterceptor`。

错误经 `AllExceptionsFilter` 包装为:

```json
{
  "code": 10001,
  "message": "用户不存在",
  "data": null
}
```

`code = 0` 表示成功,非 0 都是错误。具体错误码在 `common/exceptions/biz-code.constant.ts` 集中维护,每个 BizCode 必须是一个对象,**同时携带 `code`、`message`、`httpStatus` 三个字段**:

```typescript
// common/exceptions/biz-code.constant.ts
import { HttpStatus } from '@nestjs/common';

export const BizCode = {
  BAD_REQUEST:              { code: 40000, message: '请求参数错误',   httpStatus: HttpStatus.BAD_REQUEST },
  UNAUTHORIZED:             { code: 40100, message: '未登录或登录已失效', httpStatus: HttpStatus.UNAUTHORIZED },
  FORBIDDEN:                { code: 40300, message: '无权限访问',     httpStatus: HttpStatus.FORBIDDEN },
  NOT_FOUND:                { code: 40400, message: '资源不存在',     httpStatus: HttpStatus.NOT_FOUND },
  INTERNAL_ERROR:           { code: 50000, message: '服务器内部错误', httpStatus: HttpStatus.INTERNAL_SERVER_ERROR },

  USER_NOT_FOUND:           { code: 10001, message: '用户不存在',     httpStatus: HttpStatus.NOT_FOUND },
  USERNAME_ALREADY_EXISTS:  { code: 10002, message: 'username 已存在', httpStatus: HttpStatus.CONFLICT },
  EMAIL_ALREADY_EXISTS:     { code: 10003, message: 'email 已存在',    httpStatus: HttpStatus.CONFLICT },
  LOGIN_FAILED:             { code: 10004, message: '账号或密码错误',  httpStatus: HttpStatus.UNAUTHORIZED },
  FORBIDDEN_ROLE_OPERATION: { code: 10101, message: '无权对该用户执行此操作', httpStatus: HttpStatus.FORBIDDEN },
  CANNOT_OPERATE_SELF:      { code: 10102, message: '不能对自己执行此操作',   httpStatus: HttpStatus.FORBIDDEN },
  LAST_SUPER_ADMIN_PROTECTED:{ code: 10103, message: '系统必须保留至少一个活跃超级管理员', httpStatus: HttpStatus.CONFLICT },
} as const;
```

`BizException` 接收一个 BizCode 对象,**不接收裸数字 / 字符串**。构造参数类型必须锁死为 `BizCode` 联合类型,不要写成宽泛的 `{ code: number; message: string; httpStatus: number }`,否则临时对象也能通过类型检查:

```typescript
type BizCodeEntry = (typeof BizCode)[keyof typeof BizCode];

export class BizException extends Error {
  constructor(public readonly biz: BizCodeEntry) {
    super(biz.message);
  }
}

// 正确
throw new BizException(BizCode.USER_NOT_FOUND);

// ❌ 禁止
throw new BizException(10001);
throw new BizException('USER_ERROR');
throw new BizException({ code: 10099, message: '临时错误' });
```

`AllExceptionsFilter` 的处理规则:

- 捕获到 `BizException` 时,从其携带的 BizCode 对象读 `httpStatus`,以该 HTTP 状态码返回;响应体写 `{ code, message, data: null }`
- 捕获到 NestJS `HttpException`(如 `UnauthorizedException`、`ForbiddenException`、`BadRequestException`、`NotFoundException`)时,沿用其 HTTP status,响应体的 `code` 字段使用约定的通用错误码(参数错误 / 未登录 / 无权限 / 不存在 / 服务错误各对应一个固定 BizCode,放在 `BizCode` 顶部)
- 捕获到其他未知异常时,HTTP status `500`,响应体 `code` 为通用 `INTERNAL_ERROR`,生产环境不暴露原始 `error.message`

业务响应体始终是 `{ code, message, data }` 三字段;HTTP status 始终保持语义(参数错误 400 / 未登录 401 / 无权限 403 / 不存在 404 / 冲突 409 / 服务错误 500),禁止为了"统一"把所有错误返回 HTTP 200。

BizCode v1 控制在十几个以内,只覆盖真实会被前端识别和提示的稳定业务错误;不要为每个临时分支都新增错误码。AI 禁止自创 BizCode:任何新增错误码必须先说明使用场景、前端提示价值和是否已有错误码可复用,确认后再加入 `biz-code.constant.ts`,且必须显式声明对应的 `httpStatus`。

BizCode 编码分段固定如下,后续新增模块按段位平铺递增,禁止随手编 `99999`、`10500` 这类无归属编号:

| 段位 | 用途 |
|---|---|
| `4xxxx` / `5xxxx` | 通用错误,与 HTTP status 段对齐:`40xxx` 对应 4xx,`50xxx` 对应 5xx |
| `100xx` | `users` 模块普通业务错误 |
| `101xx` | `users` 模块权限 / 操作边界错误 |
| `110xx` | `orgs` 模块普通业务错误 |
| `111xx` | `orgs` 模块权限 / 操作边界错误 |
| `120xx` | `missions` 模块普通业务错误 |
| `121xx` | `missions` 模块权限 / 操作边界错误 |
| `130xx` | `files` 模块普通业务错误 |
| `131xx` | `files` 模块权限 / 操作边界错误 |
| `140xx` | `devices` 模块普通业务错误 |
| `141xx` | `devices` 模块权限 / 操作边界错误 |

每个业务模块预留 200 个号段:前 100 个用于普通业务错误,后 100 个用于权限 / 操作边界错误。新增模块时按 `15xxx` 起继续平铺递增。

`auth` 模块**不单开段**。`auth` **业务级**错误(登录失败、密码冲突等)归入 `users` 段:普通业务归 `100xx`,权限 / 边界归 `101xx`(如 `LOGIN_FAILED=10004`)。

但**通用 token / 鉴权失败**(token 无效 / 已过期 / 用户被禁 / 用户被软删)统一复用通用 `UNAUTHORIZED=40100`,**不在 `100xx` 自创新码**。这类是 HTTP 401 通用语义,不是业务级错误;与 `LOGIN_FAILED` 同 HTTP 401 但 `code` 不同,前端按 `code` 区分(详见 §7.6 两阶段错误码)。

只有真出现"必须给前端区分细分原因"的需求(如 refresh token 接口需明确 `REFRESH_TOKEN_EXPIRED` vs `REFRESH_TOKEN_REVOKED`)时,才在 `100xx` 段新增,而不是为每个 token 失败原因都自创编号。

Prisma `P2002` 唯一约束错误必须转换为业务错误,禁止把 Prisma 原始错误直接返回给前端:

- `username` 冲突:`BizException(BizCode.USERNAME_ALREADY_EXISTS)`
- `email` 冲突:`BizException(BizCode.EMAIL_ALREADY_EXISTS)`

v1 优先在 `users.service.ts` 的创建/更新逻辑里显式捕获 `PrismaClientKnownRequestError`,根据 `error.meta?.target` 判断冲突字段后转换为对应 `BizException`;不要把这类用户可预期错误留给全局异常过滤器兜底。

**注意 `error.meta?.target` 是 `string[]` 而非 `string`**,判断时必须用数组方法,禁止写 `target === 'username'`(在多列复合唯一约束场景会漏判):

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

**ResponseInterceptor 必须跳过的路径**——以下路径返回非业务 JSON(HTML、OpenAPI spec、二进制流等),无差别包装会破坏内容:

| 路径前缀 | 内容类型 | 跳过原因 |
|---|---|---|
| `/api/docs` | HTML(Swagger UI) | 包装后 HTML 被塞进 `data` 字段,UI 直接坏掉 |
| `/api/docs-json` | JSON(OpenAPI spec) | OpenAPI 规范不允许外层包装,前端 SDK 生成器读不了 |
| `/api/docs-yaml` | YAML(OpenAPI spec) | OpenAPI 规范不允许外层包装 |
| `/favicon.ico` | image/x-icon | 浏览器自动请求,不属于业务响应 |
| `/metrics` | text/plain(Prometheus) | 指标采集格式不能套业务 JSON |
| 文件下载流响应 | binary / octet-stream | 流式响应不能 `JSON.stringify` |

实现思路:`ResponseInterceptor` 内判断 `request.url` 是否对跳过前缀命中 `startsWith(prefix)`,匹配则 `return next.handle()` 不动响应体。表中 `/api/docs`、`/api/docs-json`、`/api/docs-yaml` 分开列出仅为说明影响范围;代码里既可以只写 `/api/docs` 一条(自动覆盖 JSON / YAML),也可以分开三条提高可读性,效果等价。**铁律是 Swagger UI 与 OpenAPI JSON / YAML 永远不能被业务响应包装**——实现完成后必须实际访问 `/api/docs` 与 `/api/docs-json` 验收,响应体不能套外层 `{ code, message, data }`。后续加 metrics 等非业务 JSON 端点时同此处理。

### 7.4 Swagger 装饰器 100% 覆盖

- 每个 Controller 方法必须有 `@ApiOperation({ summary: '...' })`
- 每个 DTO 字段必须有 `@ApiProperty({ description: '...' })`
- 需鉴权的方法加 `@ApiBearerAuth()`
- 响应类型统一用自定义包装装饰器,根据返回结构选用:
  - 单对象:`@ApiWrappedOkResponse(UserResponseDto)`
  - 数组:`@ApiWrappedArrayResponse(UserResponseDto)`
  - **分页:`@ApiWrappedPageResponse(UserResponseDto)`**(必须使用,见下)
  - 不要直接裸写 `@ApiOkResponse({ type: UserResponseDto })`
- 自定义包装装饰器集中放在 `common/decorators/api-response.decorator.ts`,负责把 Swagger schema 描述成 `{ code, message, data }` 外层结构
- `PageResultDto<T>` 是 TS 泛型,`@nestjs/swagger` 无法 reflect 泛型参数,因此分页接口**必须**使用 `@ApiWrappedPageResponse(Dto)`。装饰器内部用 `getSchemaPath(Dto)` + `allOf` 显式描述 `data: { items: Dto[], total, page, pageSize }`,否则前端 SDK 生成器拿到的是单对象 schema,Swagger UI 也显示错。所有用了 `@ApiWrappedPageResponse(Dto)` 的接口,在主类上还需要 `@ApiExtraModels(Dto, PageResultDto)` 才能让 Swagger 找到泛型实参 schema

不达标的接口,等于没写。

### 7.5 全局 ValidationPipe 铁律

`main.ts` 必须注册全局 `ValidationPipe`,配置固定如下:

```typescript
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
);
```

铁律:

- `whitelist: true`:DTO 未声明字段自动剔除
- `forbidNonWhitelisted: true`:请求包含多余字段时直接报错,防止 AI 或前端悄悄传入未设计字段
- `transform: true`:启用 DTO 类型转换,配合分页参数等基础 DTO 使用
- 禁止在单个 controller 里重复配置局部 `ValidationPipe`,除非有明确例外并写清原因

### 7.6 权限标注

```typescript
@Roles(Role.SUPER_ADMIN, Role.ADMIN)
@Get()
async list() { ... }

@Public()                    // 不需要登录
@Post('login')
async login() { ... }
```

未标注 `@Public()` 的接口默认需要登录(全局 `JwtAuthGuard`)。

`JwtAuthGuard` 与 `RolesGuard` 都必须通过 `AppModule.providers` 中的 `APP_GUARD` 全局注册,顺序固定为 `JwtAuthGuard` → `RolesGuard`:先验证登录,再验证角色。禁止在每个 controller 上重复写 `@UseGuards(JwtAuthGuard)` 或 `@UseGuards(RolesGuard)`;`@Public()` / `@Roles(...)` 通过 `Reflector` 读取 metadata 决定是否放行。

```typescript
providers: [
  {
    provide: APP_GUARD,
    useClass: JwtAuthGuard,
  },
  {
    provide: APP_GUARD,
    useClass: RolesGuard,
  },
]
```

`@Public()` 与 `@Roles(...)` **互斥**:标了 `@Public()` 的接口不应再标 `@Roles(...)`,语义上自相矛盾。`RolesGuard` 的实现规则:

- 接口未标 `@Roles(...)` → 直接放行(只要 `JwtAuthGuard` 通过即可)
- 接口标了 `@Roles(...)` 但 `request.user` 为空 → **拒绝访问**(抛 `BizException(BizCode.UNAUTHORIZED)`),不要因为没拿到 user 就放行,避免 `@Public()` + `@Roles(...)` 的错配组合默默泄露权限接口

`POST /api/auth/login` 的 v1 入参固定为 `username + password`,不支持 email 登录、手机号登录、验证码登录或注册式字段。`username` 入库和登录查询前都统一 `trim()` + `toLowerCase()`。

登录失败统一抛 `BizException(BizCode.LOGIN_FAILED)`。`username` 不存在、`password` 错误、用户已禁用、用户已软删除都返回同一个错误:HTTP 401,响应体 `{ code: 10004, message: '账号或密码错误', data: null }`。禁止在登录接口区分提示“账号不存在”“密码错误”“账号被禁用”,避免账号枚举;管理员需要查看账号状态时走后台用户列表。

**Timing 防御铁律**:`username` 不存在时**也必须**跑一次 `bcrypt.compare(password, dummyHash)`(用一个预先生成、模块级常量化的固定 dummy hash),保证四场景的响应耗时一致。**禁止** `if (!user) throw LoginFailed` 这类早返回——`bcrypt.compare` 是慢操作(~50ms 量级),早返回会让"账号不存在"明显比"密码错误"快几十毫秒,攻击者据此可枚举有效账号(timing oracle 攻击)。E2E 不一定能稳定捕获 timing 差异,但代码层面必须按"无早返回"模式实现。

登录成功后**顺手更新** `lastLoginAt = new Date()`;更新失败只 `logger.warn`,**不阻断登录响应**(避免一次写库失败把登录链路挂掉);v1 不做 `login_logs` 表。`userSafeSelect` 与 `UserResponseDto` 必须包含 `lastLoginAt` 字段,管理后台用于查看账号活跃度。

v1 **不引入** `LocalStrategy`: `username + password` 校验在 `auth.service.ts` 内手写(`findFirst` → `bcrypt.compare` → `JwtService.sign`),`strategies/` 目录只放 token 校验策略。`passport-local` 只为统一接口而存在,对单一登录方式是无谓的间接层,不要主动新增 `local.strategy.ts`。

JWT payload 固定为最小结构,不要塞完整用户对象,也不要塞 `role`:

```typescript
export interface JwtPayload {
  sub: string;      // user.id
  username: string;
}
```

查库的唯一位置是 `JwtStrategy.validate()`:每次请求都必须根据 `payload.sub` 查库,并校验 `deletedAt === null` 且 `status === UserStatus.ACTIVE`。`validate()` 返回的对象会被 passport 自动挂到 `request.user`,`JwtAuthGuard` 只负责把 `@Public()` 标记的接口放行、未通过校验的请求拒绝,**不要**在 Guard 里再写一份查库逻辑。

`JwtStrategy.validate()` 校验失败(token 无效 / 已过期 / 用户不存在 / 用户被禁用 / 用户已软删除)统一抛 `BizException(BizCode.UNAUTHORIZED)`,响应 `{ code: 40100, message: '未登录或登录已失效', data: null }` + HTTP 401。这与登录阶段的 `LOGIN_FAILED`(`10004`,HTTP 401)是**不同错误码**:

| 阶段 | 触发位置 | 错误码 | message | 前端处理 |
|---|---|---|---|---|
| 登录阶段 | `auth.service.ts` 校验 `username + password` 失败 | `LOGIN_FAILED` (10004) | 账号或密码错误 | 留在登录页,提示密码错 |
| 已登录请求 | `JwtStrategy.validate()` 校验 token / 用户状态失败 | `UNAUTHORIZED` (40100) | 未登录或登录已失效 | 跳回登录页,清掉本地 token |

两者 HTTP status 都是 401,但 `code` 不同。前端必须按 `code` 区分,避免"已登录用户密码被管理员重置后旧 token 失效"被前端当成"登录表单密码错"处理。

`JwtAuthGuard` 通过 `Reflector` 识别 `@Public()`,override `canActivate()` 实现:

```typescript
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

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

`@Public()` 装饰器使用 `SetMetadata(IS_PUBLIC_KEY, true)` 写入 metadata,`IS_PUBLIC_KEY` 常量与装饰器同文件导出。`getAllAndOverride` 同时读 method 与 class 级 metadata,允许在 controller 类上整类标注 `@Public()`。

JWT 只证明"令牌由本系统签发过",不能替代当前用户状态校验;被禁用或软删除的用户即使 token 未过期也必须返回未登录或无效 token 错误。权限判断必须使用本次查库得到的用户 `role`,不得信任 token payload 中的角色信息。

查库结果通过 `@CurrentUser()` 装饰器注入 controller / service,类型固定为:

```typescript
export interface CurrentUser {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
}
```

**关于"每请求查库"的明确声明**:v1 选择每请求查库是**有意设计,不是没考虑性能**。AI 或新人看到这条不要主动加缓存"优化":

- 主键索引查询在低 QPS 场景(内部管理系统、小型小程序)是 sub-millisecond 级别,远不是瓶颈
- 换来的是"被禁用户即时失效"的强一致性保证,审计无窗口期
- 任何缓存方案都会引入"用户被禁但 token 还能用 X 秒"的窗口,需要配套设计主动失效逻辑,不属于 v1 范围

升级条件量化在 §9:用户校验耗时占请求 >20% 或单表 QPS > 1000,才考虑引入 Redis 短 TTL 缓存。

### 7.7 密码处理铁律

按"出现位置"分四层管控,执行起来不别扭:

| 出现位置 | 是否允许 `password` 字段名 | 是否允许 `passwordHash` |
|---|---|---|
| Prisma model | ❌ 禁止 | ✅ 唯一允许 |
| 响应 DTO | ❌ 禁止 | ❌ 禁止 |
| 请求 DTO | ✅ 允许(`password` / `newPassword`) | ❌ 禁止 |
| service 内部 | ✅ 允许(只能从请求 DTO 读取,落库前必须哈希) | ✅ 允许 |

配套规则:

- v1 默认使用 `bcryptjs`,salt rounds 固定 10,优先保证跨平台部署稳定
- 安装命令:`pnpm add bcryptjs`
- 如 TypeScript 提示缺少类型,再执行:`pnpm add -D @types/bcryptjs`
- 统一 import:`import * as bcrypt from 'bcryptjs'`
- 如系统进入正式生产、用户规模扩大或安全要求提高,优先评估 `argon2`
- `native bcrypt` 只在部署环境完全可控时使用;不要在 v1 默认实现里为了“更专业”提前切换
- DTO 校验:密码至少 8 位,需含数字 + 字母
- service 接收 `password` 后,**入库前必须**调用 `bcrypt.hash()` 转为 `passwordHash`,绝不裸传 Prisma
- 响应必须通过 Prisma `userSafeSelect` 显式排除 `passwordHash`,**禁止依赖 `class-transformer` 的 `@Exclude()` 作为主要防泄漏手段**(`@Exclude()` 只在 service 错传整条 Prisma `User` 时兜底,且容易被 `JSON.stringify` 直接绕过);任何接口响应里都不应出现 `passwordHash` 字段,详见 §7.9
- **`POST /api/users` 必须由调用方传 `password` 字段**,不允许后端生成默认密码或留空。理由:默认密码是漏洞高发区,后端生成又没有邮件通道告知用户,任何"省事"的做法都比强制传更糟
- **管理员重置 `PUT /api/users/:id/password`**:`ResetUserPasswordDto { newPassword: string }`,不需要 `oldPassword`(管理员重置就是为"用户忘密码"场景设计),但必须走 §7.11 `assertCanManageUser()` 角色边界校验
- 管理员重置密码后 v1 不主动吊销旧 token;如需立即阻断访问,由管理员把目标用户 `status` 改为 `DISABLED`
- **v1 不实现"本人改密码"接口**,详见 §6 说明。AI 不要主动补这个接口,更不要在其他接口里夹带"顺手改密码"的逻辑

### 7.8 软删除(显式过滤,不用全局中间件)

**v1 不使用 Prisma 全局软删除中间件 / client extension**。原因:

- 软删除中间件通常需要拦截 `findUnique` / `findFirst` / `findMany` 等查询并改写 `where` 条件,容易破坏原本清晰的查询语义
- 在 relation、唯一查询、管理员回收站等场景里容易产生隐藏行为,AI 后续维护时不容易看出来
- 管理员要看"已删除用户"时,反而要绕过中间件,设计变扭

替代方案:在 `users.service.ts` 内封装基础 where,所有查询显式过滤:

```typescript
// users.service.ts
private notDeletedWhere<T extends object>(where: T = {} as T) {
  return { ...where, deletedAt: null };
}

async findById(id: string) {
  return this.prisma.user.findFirst({
    where: this.notDeletedWhere({ id }),
  });
}
```

铁律:

- **禁止调用 `prisma.user.delete()`**,删除接口只能 `update({ deletedAt: new Date(), status: UserStatus.DISABLED })`
- v1 不提供恢复接口;如未来增加恢复接口,恢复时只清空 `deletedAt`,不自动把 `status` 改回 `ACTIVE`,必须由管理员显式启用
- 所有非"管理员看回收站"类查询都必须经 `notDeletedWhere()` 过滤
- 用户正常业务查询禁止使用 `prisma.user.findUnique()`,统一使用 `findFirst({ where: notDeletedWhere(...) })`,避免绕过 `deletedAt` 过滤
- `seed`、创建 / 更新用户时的 `username` / `email` 唯一性预检查**必须**使用 `findUnique`(包含软删记录),**禁止**使用 `findFirst + notDeletedWhere`——软删后 `username` / `email` 不复用(见 §5),唯一性预检查的目的就是检测**包含软删在内**的全部占用;若用 `notDeletedWhere` 过滤,会让软删占用通过预检查,落库时撞 unique index 报 P2002,前端会拿到一个本可前置友好提示的服务器侧异常
- `findById` 找不到(包括已软删)统一抛 `BizException(BizCode.USER_NOT_FOUND)`
- 访问已删除用户的详情、修改、重置密码、改角色、改状态、删除接口,统一表现为用户不存在,抛 `BizException(BizCode.USER_NOT_FOUND)`
- 登录路径额外校验 `user.status === UserStatus.ACTIVE`,不只是 `deletedAt === null`

### 7.9 DTO 与 Prisma 类型严格分离

- **入参 DTO**:`CreateUserDto`、`UpdateUserDto`、`ResetUserPasswordDto`、`UpdateUserRoleDto` 等,带 `class-validator` 装饰器
- **出参 DTO**:`UserResponseDto`,显式列出对外暴露的字段(永不含 `passwordHash`)
- Prisma 生成的 `User` 类型仅在 service 内部用,**绝不直接返给 controller / 前端**
- 禁止任何 controller / service 直接返回未 `select` 的 Prisma `User` 对象,尤其禁止 `return this.prisma.user.findMany()` 这类写法
- `User` 对外返回必须使用集中定义的 `userSafeSelect`,禁止在多个 service 方法里手写不同的 `select`
- `userSafeSelect` 至少排除 `passwordHash`,并作为 `UserResponseDto` 字段来源的唯一依据
- `UserResponseDto` 与 `userSafeSelect` 必须同步维护:新增、删除或重命名任何对外用户字段时,必须同时修改 DTO 和 select,禁止出现 DTO 声明了但 select 不返回、或 select 返回了但 DTO 未声明的字段
- **禁止**创建 `*.entity.ts`;本项目不是 TypeORM 项目,不要引入 Entity 概念

```typescript
// modules/users/users.select.ts
import { Prisma } from '@prisma/client';

export const userSafeSelect = {
  id: true,
  username: true,
  email: true,
  nickname: true,
  avatarKey: true,
  role: true,
  status: true,
  createdAt: true,
  lastLoginAt: true,
  updatedAt: true,
} as const satisfies Prisma.UserSelect;
```

#### IdParamDto 必须按字符串校验,不要写死 cuid 正则

主键当前用 `cuid()` 字符串(见 §5),但路径参数 `:id` 的校验只约束为合理长度的字符串,避免把 DTO 和具体 ID 生成算法过度绑定;同时**绝不能**写成 int:

```typescript
// common/dto/id-param.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class IdParamDto {
  @ApiProperty({ example: 'cl9z3a8b00000abcd1234efgh' })
  @IsString()
  @Length(8, 64, { message: 'id 必须是 8-64 位字符串' })
  id!: string;
}
```

铁律:

- **禁止** `@Param('id', ParseIntPipe)`、`id: number`、`@IsInt()`——NestJS 教程里大量这种写法,AI 容易直接抄
- **禁止**在 `IdParamDto` 中写过死的 cuid 正则;优先使用字符串长度校验,或只在确有必要时使用宽松正则
- 所有 `:id` 路径参数都通过 `IdParamDto` 校验,不要每个 controller 重写一遍
- 校验失败由全局异常过滤器统一处理,返回 `code != 0` 的标准错误格式

### 7.10 事务使用规则

v1 不滥用事务,但涉及一致性边界时必须使用 `prisma.$transaction`。

必须使用事务的场景:

- 涉及多个写操作
- 先检查再写入的关键业务
- 管理员保护类操作,例如删除 super admin、禁用 super admin、把 super admin 降级为 ADMIN 或 USER

管理员保护类操作必须把“检查剩余活跃 super admin 数”和“执行更新”放在同一个 transaction 中完成,避免并发请求同时通过检查后破坏“至少一个活跃 super admin”的不变式。

不需要事务的场景:

- 单表单次只读查询
- 单条普通资料更新,且不依赖更新前检查结果维护业务不变式

### 7.11 角色层级与管理员保护

> **重要声明:本项目的三层角色是"粗粒度角色等级",不是 RBAC(基于角色的访问控制)。**
>
> AI 或新人看到 `Role` 枚举不要把它当作"已经在做 RBAC 的起点"逐步扩展(加 permission 表、加 user_roles 多对多、加 casl/ability 库),也不要追加按钮级、字段级、资源级权限点。这是一次架构升级,不是渐进改造,触发条件见 §9 升级路径。
>
> | 维度 | 本项目(角色等级) | RBAC |
> |---|---|---|
> | 角色定义 | Prisma `enum Role` 三层固定 | `roles` 表 + 数据库可配 |
> | 用户-角色关系 | `User.role` 单值字段 | `user_roles` 多对多表,可多角色 |
> | 权限粒度 | 接口级(`@Roles(...)`)+ service 层目标用户校验 | 按钮级 / 字段级 / 资源级权限点 |
> | 权限存储 | 硬编码在 `users.service.ts`(`assertCanManageUser`) | `permissions` 表 + 角色-权限映射 |
> | 适用场景 | 内管系统"管理员管员工"这种简单层级 | 复杂多团队、多产品、多租户、按钮可配的中后台 |
>
> 之所以选这条路:99% 的内部管理系统、小程序后台、客户项目二开都不需要 RBAC,Role 三层够用且 AI 写起来不会乱。

角色层级固定为:`SUPER_ADMIN > ADMIN > USER`。

管理边界:

- `SUPER_ADMIN` 可以管理 `SUPER_ADMIN`、`ADMIN`、`USER`,但受自我保护和最后一个 SUPER_ADMIN 保护约束
- v1 只有 `prisma/seed.ts` 能创建 `SUPER_ADMIN`;所有业务 API 都禁止创建 `SUPER_ADMIN`
- `CreateUserDto.role` 可选;不传默认 `USER`,禁止把 role 从 DTO 直接透传给 Prisma
- `SUPER_ADMIN` 通过业务 API 创建用户时只允许 `role=ADMIN` 或 `role=USER`
- `ADMIN` 调用创建接口时,不论传不传 `role`,最终只能创建 `USER`;若显式传 `ADMIN` / `SUPER_ADMIN`,抛 `BizException(BizCode.FORBIDDEN_ROLE_OPERATION)`
- `ADMIN` 只能管理 `USER`,只能创建 `USER`,不能查看、修改、禁用、删除、降级或创建 `ADMIN` / `SUPER_ADMIN`;违反时抛 `BizException(BizCode.FORBIDDEN_ROLE_OPERATION)`
- `USER` 只能访问本人接口,不能访问管理接口

v1 不做复杂 permission 表,所有管理边界集中写在 `users.service.ts`,不要提前引入 Ability / CASL。只有真出现按钮级、资源级权限需求时,才按升级路径评估权限模块。

权限分层铁律:

- Guard 管入口权限:`@Roles(Role.SUPER_ADMIN, Role.ADMIN)` 只表示谁能进入管理接口
- Service 管业务权限:`users.service.ts` 必须根据当前用户角色和目标用户角色再次校验“能操作谁”
- 禁止只写 `@Roles` 就直接执行管理操作;所有读取详情、修改资料、重置密码、启用/禁用、软删除等管理接口都必须先校验目标用户角色

```text
SUPER_ADMIN: 可以操作 SUPER_ADMIN / ADMIN / USER
ADMIN: 只能操作 USER
USER: 不能进入管理接口
```

`users.service.ts` 必须集中实现目标用户权限判断,不要在各方法里散写 if:

```typescript
private assertCanManageUser(currentUser: CurrentUser, targetUser: User) {
  if (currentUser.role === Role.SUPER_ADMIN) return;

  if (currentUser.role === Role.ADMIN && targetUser.role === Role.USER) return;

  throw new BizException(BizCode.FORBIDDEN_ROLE_OPERATION);
}
```

以下接口必须先查出目标用户,再调用 `assertCanManageUser(currentUser, targetUser)`:

- `GET /api/users/:id`
- `PATCH /api/users/:id`
- `PUT /api/users/:id/password`
- `PATCH /api/users/:id/role`
- `PATCH /api/users/:id/status`
- `DELETE /api/users/:id`

用户列表必须按当前用户角色过滤可见范围:

```text
SUPER_ADMIN: 可看 SUPER_ADMIN / ADMIN / USER
ADMIN: 只能看 USER
USER: 不能进入管理列表
```

系统必须始终保证至少有一个**活跃超级管理员**(`role=SUPER_ADMIN` AND `status=ACTIVE` AND `deletedAt=null`)。最后一个 SUPER_ADMIN 保护必须保留。

#### 第一层:自我保护

超级管理员和管理员**不允许**对自己执行以下操作,触发即抛 `BizException(BizCode.CANNOT_OPERATE_SELF)`。

角色修改必须走 `PATCH /api/users/:id/role`,且禁止自改 role;`PATCH /api/users/:id` 永远不接受 role 字段。

| 接口 | 拦截条件 | 防止的事故 |
|---|---|---|
| `DELETE /api/users/:id` | `id === currentUser.id` | 误删自己,丢失访问 |
| `PATCH /api/users/:id/status` | `id === currentUser.id` 且改成 DISABLED | 把自己禁用,无人能再启用 |
| `PATCH /api/users/:id/role` | `id === currentUser.id` | 自改角色,失去当前管理权限或制造权限语义混乱 |

#### 第二层:最后一个 SUPER_ADMIN 保护

任何"剥夺超级管理员权限"类操作前,必须在同一个 `prisma.$transaction` 中查询剩余活跃 super admin 数并执行更新,确保**操作后剩余 ≥ 1**,否则抛 `BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED)`。

适用接口:`DELETE /api/users/:id`、`PATCH /api/users/:id/status`(改 DISABLED)、`PATCH /api/users/:id/role`(role 改 ADMIN 或 USER)——当且仅当目标用户当前是 super admin 时检查。

```typescript
// users.service.ts(示意)
private async assertNotLastSuperAdmin(userIdAffected: string) {
  const remaining = await this.prisma.user.count({
    where: this.notDeletedWhere({
      role: Role.SUPER_ADMIN,
      status: UserStatus.ACTIVE,
      id: { not: userIdAffected },
    }),
  });
  if (remaining === 0) {
    throw new BizException(BizCode.LAST_SUPER_ADMIN_PROTECTED);
  }
}
```

#### 为什么两层都要

- 自我保护是"防误操作"——挡住 99% 因匆忙点错按钮的事故
- 最后一个 SUPER_ADMIN 保护是"防代码漏洞"——以后某个新接口、迁移脚本、批量操作可能绕过自我保护,这层还能兜底
- 业务正确的不变式表述是"系统永远至少有一个活跃 super admin",而不是"不能操作自己"。后者只是前者在单 super admin 场景下的特例

#### SUPER_ADMIN 之间的互操作(v1 设计选择)

v1 允许 `SUPER_ADMIN` **互相管理**:重置密码、禁用、改角色、软删除均可,仅受**自我保护**和**最后一个 SUPER_ADMIN 保护**两层约束。

| 场景 | v1 行为 | 命中保护 |
|---|---|---|
| `SUPER_ADMIN A` 重置 `SUPER_ADMIN B` 的密码 | ✅ 允许 | 不命中(密码重置不剥夺权限) |
| `SUPER_ADMIN A` 把 `SUPER_ADMIN B` 改成 `DISABLED` | ✅ 允许(剩余活跃 super admin ≥ 1) | 命中最后一个保护 |
| `SUPER_ADMIN A` 把 `SUPER_ADMIN B` 降级为 `ADMIN` / `USER` | ✅ 允许(剩余活跃 super admin ≥ 1) | 命中最后一个保护 |
| `SUPER_ADMIN A` 软删 `SUPER_ADMIN B` | ✅ 允许(剩余活跃 super admin ≥ 1) | 命中最后一个保护 |
| `SUPER_ADMIN A` 对自己执行上述任一操作 | ❌ 拒绝 | 命中自我保护 |

这是 v1 的**明确选择,不是疏漏**:

- v1 默认只有一个 SUPER_ADMIN(`prisma/seed.ts` 创建),互操作是低频运维场景
- 若禁止互操作,会出现"前任 SUPER_ADMIN 离职后无法被接任者接管"的死锁
- 真出现"SUPER_ADMIN 互不可操作"诉求(如多团队联合管理同一系统、多组织间相互隔离)时按 §9 升级路径处理,**作为权限模型升级**,不是渐进改造

AI 实施时不要凭直觉额外加一层"SUPER_ADMIN 互不可操作"校验,也不要在 `assertCanManageUser` 里把 `targetUser.role === Role.SUPER_ADMIN` 列为禁止条件。

---

## 8. 环境变量

```bash
# .env.example

# 数据库
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app

# JWT
JWT_SECRET=please-change-me-in-production-min-32-chars
JWT_EXPIRES_IN=7d

# 默认超级管理员(仅首次 seed 使用)
SUPER_ADMIN_USERNAME=admin
SUPER_ADMIN_PASSWORD=ChangeMe123456
SUPER_ADMIN_EMAIL=admin@example.com

# 应用
APP_PORT=3000
# APP_ENV 可选值: development | test | production
APP_ENV=development
# 多个 origin 用英文逗号分隔
APP_CORS_ORIGIN=http://localhost:5173
# 留空表示:开发环境开启,生产环境关闭;production 下设 true 才开启 /api/docs
ENABLE_SWAGGER=
```

**安全约定**:

- `.env` 必须 gitignore,只提交 `.env.example`
- `seed.ts` 必须从 env 读超级管理员凭据,**不允许硬编码**
- `seed.ts` 只在不存在 `SUPER_ADMIN_USERNAME` 对应用户时创建;如果用户已存在,不覆盖密码、不覆盖角色、不覆盖邮箱,只打印提示
- `prisma/seed.ts` 启动时必须强校验:`SUPER_ADMIN_USERNAME` 必须符合 username 格式(小写字母、数字、下划线、中横线,长度 3-32);`APP_ENV=production` 时禁止 `SUPER_ADMIN_USERNAME=admin`,也禁止 `SUPER_ADMIN_PASSWORD` 为 `.env.example` 中的默认值(`ChangeMe123456`),否则直接抛错退出,不写入数据库
- 本项目只使用 `APP_ENV` 表示应用运行环境,不要混用 `NODE_ENV` 做业务配置判断;`NODE_ENV` 只留给框架和工具链内部使用
- 应用启动时强校验(任一不满足直接抛错退出):
  - `APP_ENV` 仅允许 `development` / `test` / `production`
  - `JWT_SECRET` 至少 32 字符
  - 当 `APP_ENV=production` 时:
    - `JWT_SECRET` 不允许为 `.env.example` 中的默认值(`please-change-me-in-production-min-32-chars`)
    - `JWT_SECRET` 推荐用 `openssl rand -base64 48` 生成
  - `test` 环境允许使用默认 `JWT_SECRET`;`production` 必须使用随机强密钥
- 默认值刻意写成 `ChangeMe...` 形式,既能本地直接跑,又自带"必须改"的视觉提醒
- `APP_CORS_ORIGIN` 配置允许访问 API 的前端 origin;本地默认 Vite 端口 `http://localhost:5173`,生产必须改成真实前端域名
- `APP_CORS_ORIGIN` 支持英文逗号分隔多个 origin,启动时按 `split(',').map(trim).filter(Boolean)` 解析
- `APP_ENV=production` 时,`APP_CORS_ORIGIN` 禁止为空,禁止使用 `*`;不要为了方便把生产 CORS 全放开
- Swagger 开关逻辑固定为:`APP_ENV !== 'production' || ENABLE_SWAGGER === 'true'`
- `ENABLE_SWAGGER` 必须用严格字符串判断 `=== 'true'`,禁止用 `Boolean(process.env.ENABLE_SWAGGER)` 或 truthy 判断,否则字符串 `'false'` 会被误判为开启
- `.env.example` 中 `ENABLE_SWAGGER` 留空,避免写成 `false` 后让人误以为开发环境也会关闭 Swagger
- 生产环境默认不注册 `/api/docs` 和 `/api/docs-json`;如需临时开放,显式设置 `ENABLE_SWAGGER=true`
- 如生产需要给前端生成 SDK,优先在 CI 中导出 `openapi.json`,不建议长期开放 `/api/docs-json`

**配置文件归属(避免 AI 新建无谓的 config 文件)**:

| 环境变量 | 归属 | 说明 |
|---|---|---|
| `APP_PORT` / `APP_ENV` / `APP_CORS_ORIGIN` / `ENABLE_SWAGGER` | `src/config/app.config.ts` | 应用层运行参数,集中读取并做启动强校验 |
| `DATABASE_URL` | `src/config/database.config.ts` | 仅暴露给 `PrismaService` / `DatabaseModule` |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | `src/config/jwt.config.ts` | 仅暴露给 `auth/` 模块 |
| `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD` / `SUPER_ADMIN_EMAIL` | **不进 config**,仅在 `prisma/seed.ts` 内 `process.env` 直读 | 避免运行时被业务代码误读,也避免默认凭据在生产环境意外暴露到 ConfigService |

铁律:

- 不要为 CORS / Swagger / 单一开关再单独建 `cors.config.ts`、`swagger.config.ts`,统一归 `app.config.ts`
- 业务代码和 service 不直接 `process.env.XXX`,统一通过对应 `*.config.ts` 注入(`SUPER_ADMIN_*` 是显式例外,因为只 seed 用一次)
- 新增环境变量时,先决定归属哪个 `*.config.ts`,再同步加进 `.env.example` 和启动强校验

---

## 9. 升级路径

底座是活的,但不要预先做。下表是"何时该加什么":

**路径写法约定**:本节"加在哪里"列统一使用 `src/` 开头的完整路径,避免脱离上下文歧义。新加目录或文件都落在 `src/` 下,不要在项目根新建 `auth/`、`common/` 等目录。

| 触发信号 | 该加什么 | 加在哪里 |
|---|---|---|
| 第一个产品要传文件 | 再注册 storage provider,实现 `LocalStorageProvider` 或 `OssStorageProvider` | `src/common/storage/providers/` |
| 救援队系统启动 | `modules/orgs/`(组织/部门),`User` 加 `orgId` 字段 | `src/modules/orgs/` |
| 出现"A 队不能看 B 队数据" | 引入 `tenantId`,所有 service 显式按租户过滤 | 各业务 `src/modules/<name>/<name>.service.ts` |
| 真要做"权限点到按钮级" | 加 `permissions` 表 + `casl` 库 | `src/modules/permissions/` |
| 第一个小程序产品要接 | 加微信登录策略 | `src/modules/auth/strategies/wechat-mini.strategy.ts` |
| 真有"无感续期"诉求 | 加 refresh token 表 + 接口 | `src/modules/auth/` |
| 出现"普通用户自助改密码"产品 | 加 `PUT /api/users/me/password` + `ChangeMyPasswordDto` + 防爆破;是否吊销其他设备 token 由该产品安全策略决定 | `src/modules/auth/` + `src/modules/users/` |
| 真有异步任务 / 限流 | 加 Redis + BullMQ | 新增 `src/modules/queue/` 模块 |
| 第一个 AI 产品启动 | 再注册 `AiModule`,填充 `modules/ai/`,接 Vercel AI SDK,加 pgvector | `src/modules/ai/` |
| 真有审计需求 | 加 `operation_logs` 表 + 全局拦截器 | `src/common/interceptors/audit.interceptor.ts` |
| JWT 每请求查库成为瓶颈(用户校验耗时占请求 >20%,或单表 QPS > 1000) | 引入 Redis 缓存用户状态(短 TTL,如 30s),禁用/软删时主动失效缓存 | `src/modules/auth/user-state.cache.ts`(用户状态缓存属于鉴权热路径,先归属 auth;若后续出现通用缓存需求再抽 `src/common/cache/`) |

**判定原则**:不是"觉得以后会用",而是"现在的产品需求里出现了这个明确诉求"。

---

## 10. 部署

### v1 默认:本地 Docker Compose

```yaml
# docker-compose.yml(简化示意)
services:
  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: app
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  postgres_data:
```

v1 的 `docker-compose.yml` **只起 PostgreSQL,不构建应用镜像**;应用本身用 `pnpm run start:dev` 跑在宿主机,数据库跑在容器里,开发调试最快。`Dockerfile` 与应用容器化在首次生产部署前再补,避免 v1 阶段维护一份从未被实际验证过的 Dockerfile 配置。

### 生产部署

v1 不预先决定,但 Dockerfile 会写得通用,以下任一方式可直接部:

- 自己买云服务器(阿里云 / 腾讯云)+ Docker Compose
- 托管平台:Railway / Sealos / Zeabur
- 容器服务:阿里云 ACK / 腾讯云 TKE

v1 开发阶段不强制提供应用 `Dockerfile`;进入首次生产部署前再补 `Dockerfile` 和 `docker-compose.prod.yml`。

生产数据库迁移必须独立、克制执行。生产环境禁止使用 `prisma migrate dev`,只能执行已提交、已审查 migration 文件对应的 `prisma migrate deploy`。如果没有 CI/CD 流水线,也必须把迁移作为单独步骤处理:先备份数据库,确认目标环境和 `DATABASE_URL`,查看待执行 migration,再手动运行 deploy。AI 不得建议直接连接生产库执行开发态迁移命令。

---

## 11. V1.1 Engineering Hardening

> **定位**:V1.1 是 v1 完成后的"工程加固增量",不是新版本的功能升级,也不是 §9 升级路径的提前触发。本章节给出的能力**全部围绕底座侧的可观测性、运维基础、安全加固**展开,不新增任何业务接口、不修改任何业务路由、不改动业务数据模型。
>
> **与 v1 的关系**:§1-§10 是 v1 蓝图,**保持不变**;V1.1 只在底座之上增量补充。任何 V1.1 条目与 v1 已有铁律冲突时,**以 v1 铁律为准**,V1.1 让步。
>
> **与 §9 升级路径的关系**:§9 列出的所有"升级触发条件"在 V1.1 阶段**仍然不触发**;V1.1 不引入 Redis、不引入 BullMQ、不引入 RBAC、不引入 refresh token、不引入文件上传 Provider、不引入 LLM、不引入审计日志表、不引入用户状态缓存。

### 11.1 V1.1 目标

为 v1 骨架补足"能上生产"的最小工程基线,具体覆盖三件事:

1. **可观测性**:把"出了问题查不到"变成"出了问题能在 5 分钟内定位"——结构化日志 + 请求 ID 贯通。
2. **运维基础**:把"本地能跑"变成"容器能起、CI 能跑、SIGTERM 能优雅退出"——Dockerfile + GitHub Actions + graceful shutdown + 健康检查分层。
3. **安全加固**:把"裸跑在公网会被扫死"变成"基线防护到位"——helmet HTTP 头 + 登录接口限流。

V1.1 不追求完备,只求把"裸 v1 直接上线"的几个最常见塌方点补上。任何超出这三件事的能力(指标采集、APM 接入、tracing、审计日志持久化、性能 profile)都不属于 V1.1。

### 11.2 V1.1 允许做的事

| 能力 | 选型 | 范围 |
|---|---|---|
| **结构化日志** | `nestjs-pino` + `pino`(开发可叠 `pino-pretty`) | 替换 NestJS 默认 Logger;输出 JSON;**自动屏蔽敏感字段** `password` / `newPassword` / `passwordHash` / `authorization` / `cookie` / `token` / `accessToken` / `refreshToken` / `secret` |
| **请求 ID 追踪** | `nestjs-pino` 内置或自写中间件 | 读 `x-request-id` 请求头,缺失则用 `cuid()` 生成;同时写回响应头 `x-request-id`;贯穿同一请求所有日志的 `requestId` 字段 |
| **优雅关闭** | NestJS `app.enableShutdownHooks()` + `OnModuleDestroy` | `PrismaService` 实现 `OnModuleDestroy`,在 `onModuleDestroy()` 内 `await this.$disconnect()`;监听 SIGTERM / SIGINT 后等待 in-flight 请求完成 |
| **HTTP 安全头** | `helmet` | `app.use(helmet())`,默认配置;若与 Swagger UI 的 inline script CSP 冲突,**仅对 `/api/docs` 路径**关闭 `contentSecurityPolicy`,**禁止全局关闭** |
| **登录接口限流** | `@nestjs/throttler` 内存 storage | **仅作用于 `POST /api/auth/login`**(基于路径或 controller 装饰器);默认 `5 次 / 60 秒 / per IP`(具体参数走 `app.config.ts`);超限抛新增的 `BizException(BizCode.TOO_MANY_REQUESTS)` |
| **健康检查升级** | `@nestjs/terminus` | 在 `health/` 模块下新增 `GET /api/health/live`(进程存活)与 `GET /api/health/ready`(DB 连通);保留原 `GET /api/health` 作向后兼容,响应等同 `/live`;三者都 `@Public()`,都走统一响应包装 |
| **Dockerfile** | 多阶段:deps → builder → runner | 基于 `node:22-alpine`;runner 阶段切换到非 root 用户(优先用 `node` 用户);`prisma migrate deploy` 在容器入口 entrypoint 里显式执行,**不能**在镜像构建阶段执行 |
| **CI 流水线** | GitHub Actions(`.github/workflows/ci.yml`) | 触发:`push` 到 `main` + 所有 PR;步骤:checkout → setup-node 22 → pnpm install(带 store 缓存)→ lint → typecheck → 起 PostgreSQL service container → `db:test:init` → `test:e2e` |
| **新增错误码** | `BizCode.TOO_MANY_REQUESTS` | `code: 42900`,`message: '请求过于频繁，请稍后再试'`,`httpStatus: HttpStatus.TOO_MANY_REQUESTS`(429);**不暴露阈值数字、剩余配额、重置时间到 message** |
| **新增环境变量** | 见 §11.5 | `LOG_LEVEL` / `LOGIN_THROTTLE_LIMIT` / `LOGIN_THROTTLE_TTL_SECONDS`;统一归 `app.config.ts`,启动强校验 |

### 11.3 V1.1 禁止做的事

V1.1 仍然**不做**以下事项,任何 AI 看到 V1.1 章节不要把它当成"放开口子"的信号:

- 不引入 Redis(包括限流的 Redis storage、用户状态缓存、JWT 黑名单)——限流只用 `@nestjs/throttler` 内存 storage
- 不引入 BullMQ / 任务队列 / 定时任务
- 不做操作日志 / 审计日志的**数据库持久化**——只做结构化日志输出到 stdout
- 不接入 OpenTelemetry / Jaeger / Zipkin 等 tracing 系统
- 不接入 Sentry / Datadog / New Relic 等 APM
- 不暴露 Prometheus `/metrics` 端点(若未来需要,按 §9 升级路径处理,且 `/metrics` 必须加入 `ResponseInterceptor` 跳过列表)
- 不做 refresh token / 本人改密码接口 / 微信小程序登录 / RBAC 权限表 / 多租户 / 文件上传 Provider / pgvector / LLM
- 不在 v1 业务模块(`auth` / `users` / `health`)里夹带新业务字段、新业务路由
- 不修改 §6 API 接口清单中已有接口的入参 / 出参 / HTTP 方法 / 权限标注
- 不修改 Prisma `User` 模型(不加日志相关字段、不加请求统计字段)
- 不修改 §1-§10 任何 v1 铁律的语义;V1.1 只能在已有铁律之上**追加**约束,不能**放宽**已有约束

### 11.4 V1.1 与 v1 铁律的衔接

V1.1 新增能力必须复用 v1 已建立的基础设施,**禁止另起炉灶**:

- **错误处理**:限流、健康检查 ready 失败等异常**必须**走 `BizException` + `AllExceptionsFilter`,响应体仍然是 `{ code, message, data: null }`,HTTP status 由 BizCode 的 `httpStatus` 决定;**禁止**直接 `throw new HttpException` 绕过统一错误码
- **响应格式**:健康检查升级后的三个端点(`/api/health` / `/api/health/live` / `/api/health/ready`)**继续走** `ResponseInterceptor` 包装,响应体形如 `{ code: 0, message: 'ok', data: { status: 'ok', ... } }`;**不要**为了对齐 `@nestjs/terminus` 的原生输出绕过包装
- **Swagger 覆盖**:`/api/health/live` 与 `/api/health/ready` 必须 `@ApiOperation` + `@ApiWrappedOkResponse(...)`,与 v1 的 Swagger 100% 覆盖铁律一致
- **配置归属**:V1.1 新增的 `LOG_LEVEL` / `LOGIN_THROTTLE_LIMIT` / `LOGIN_THROTTLE_TTL_SECONDS` 全部归 `src/config/app.config.ts`,**禁止**为日志或限流单独建 `logger.config.ts` / `throttler.config.ts`
- **错误码段位**:`TOO_MANY_REQUESTS = 42900` 落在 `4xxxx` 通用 HTTP 段,**不**占用业务模块的 `100xx` / `110xx` 段位
- **日志屏蔽**:敏感字段屏蔽列表必须与 §7.7 / §9 密码处理铁律对齐,至少包含 `password` / `newPassword` / `passwordHash` / `authorization` / `cookie` / `token` / `accessToken` / `refreshToken` / `secret`;DTO 字段一旦命中此清单,日志中**必须**显示为 `[REDACTED]`,**不能**仅做长度截断
- **限流防绕过**:`POST /api/auth/login` 限流后,**不要**在 `auth.service.ts` 内自写 `setTimeout` 之类的伪限流;限流统一由 `@nestjs/throttler` 提供,绕过它就等于关掉限流

### 11.5 V1.1 新增环境变量

| 变量 | 默认值 | 归属 | 说明 |
|---|---|---|---|
| `LOG_LEVEL` | `info`(生产) / `debug`(非生产) | `src/config/app.config.ts` | pino 日志级别;允许值 `fatal` / `error` / `warn` / `info` / `debug` / `trace` |
| `LOGIN_THROTTLE_LIMIT` | `5` | `src/config/app.config.ts` | `POST /api/auth/login` 每 TTL 窗口允许的最大尝试次数 |
| `LOGIN_THROTTLE_TTL_SECONDS` | `60` | `src/config/app.config.ts` | `POST /api/auth/login` 限流 TTL,单位秒;最小 1,最大 3600 |

启动强校验追加:

- `LOG_LEVEL` 必须 ∈ `{ fatal, error, warn, info, debug, trace }`
- `LOGIN_THROTTLE_LIMIT` 必须为正整数,推荐范围 `[1, 100]`
- `LOGIN_THROTTLE_TTL_SECONDS` 必须为正整数,推荐范围 `[1, 3600]`
- 任一不满足直接抛错退出,**禁止**用 fallback 默认值在生产环境兜底

`.env.example` 必须同步追加以上三项,值留空或写注释默认,**不允许**在 `.env.example` 中写敏感值。

### 11.6 V1.1 与 §9 升级路径的边界声明

V1.1 完成后,以下场景**仍然走 §9 升级路径**,V1.1 不替代:

| 真实诉求 | V1.1 是否解决 | 应走的升级路径 |
|---|---|---|
| 单实例 QPS 上升后限流要在多实例间共享配额 | ❌ 不解决(V1.1 用内存 storage,多实例不共享) | §9 引入 Redis + `@nestjs/throttler` Redis storage |
| 用户登录被禁用后,旧 token 必须立即失效 | ❌ 不解决 | §9 引入用户状态 Redis 缓存 + 主动失效 |
| 需要把所有 4xx / 5xx 异常上报到 Sentry | ❌ 不解决 | §9 升级条目"接入 APM" |
| 需要查"某次错误对应的完整调用链" | ❌ 不解决(V1.1 只有日志,没 tracing) | §9 升级条目"引入 OpenTelemetry" |
| 需要按用户 / 接口维度采集 P95 / P99 延迟 | ❌ 不解决 | §9 升级条目"引入 Prometheus / Grafana" |

V1.1 完成后,**不要**因为"日志已经接进来了"就顺手把上面任一条带做;每一条都需要重新评估业务诉求与 §9 升级路径。

---

### 11.7 ESLint TypeScript Project 覆盖规则

项目使用显式 `parserOptions.project` 列表覆盖 `src` / `test` / `prisma` 三处 TypeScript 源码(不使用 `projectService` 自动发现,因为 `prisma/` 目录不在任何运行时 tsconfig 的 `include` 中)。

新增任何 TypeScript 源码目录(如 `scripts/`、`tools/`、`migrations/` 等)时,维护者必须按以下顺序执行:

1. 为新目录新增或更新对应的 `tsconfig` 文件(若不希望进入运行时构建,参考 `prisma/tsconfig.eslint.json` 模式,只供 ESLint 解析使用)
2. 在 `eslint.config.mjs` 的 `parserOptions.project` 数组中追加新 `tsconfig` 路径
3. 确认 `pnpm lint` 通过

**禁止**新增 TypeScript 目录但不同步更新 ESLint project 覆盖 — 未覆盖的 `.ts` 文件会被 typescript-eslint 抛 `was not found by the project service` 解析错误,直接破坏 lint 闭环。

---

## 附录:实施顺序

### 实施规则

- 每次只实现一个阶段,不跨阶段提前写后续模块。
- 每个阶段完成后必须运行 lint、typecheck、test,或至少启动服务验证。
- pnpm-only:所有依赖安装和脚本执行都使用 `pnpm`;禁止使用 `npm`、`yarn`、`bun`。
- 执行 Prisma Migrate 前必须先说明将生成/执行的迁移内容并等待确认,不得直接运行迁移命令。本规则适用于 AI 本地开发和人工协作场景;CI/CD 中的 `prisma migrate deploy` 只允许执行已提交、已审查的 migration 文件。
- AI 修改代码前必须先读取 `ARCHITECTURE.md`、`CLAUDE.md` 和 `AGENTS.md`。
- 任何新增功能如果不在 v1 范围内,必须先暂停并说明原因,不得擅自实现。

### 测试策略

- v1 初始搭建不强制引入 E2E 测试,不因 E2E 缺失阻塞骨架搭建。
- `auth` / `users` 稳定后优先引入 E2E 测试。
- 不追求单元测试覆盖率数字,只测试关键接口行为。
- E2E 优先覆盖登录、JWT 鉴权、用户 CRUD、角色边界、软删除、禁用用户、最后一个 SUPER_ADMIN 保护、唯一约束冲突。
- 登录失败必须覆盖**防账号枚举四场景**:`username` 不存在、`password` 错误、账号已禁用(`status=DISABLED`)、账号已软删除(`deletedAt != null`)。四个场景的响应体与 HTTP status 必须**完全相同**——`{ code: 10004, message: '账号或密码错误', data: null }` + HTTP 401,任何字段差异(包括 message 文案、错误码细分、响应耗时显著差异)都视为账号枚举漏洞。
- E2E 必须断言统一响应格式:成功响应检查 `{ code: 0, message: 'ok', data }`,错误响应检查 `{ code, message, data: null }`;分页接口额外检查 `data.items` / `data.total` / `data.page` / `data.pageSize` 结构,避免 controller 绕过 `ResponseInterceptor` 或返回裸数组。
- 错误响应必须**同时断言** HTTP status code 与 `BizCode.httpStatus` 一致(例如 `USER_NOT_FOUND` → `expect(res.status).toBe(404)`,`LOGIN_FAILED` → `expect(res.status).toBe(401)`,`USERNAME_ALREADY_EXISTS` → `expect(res.status).toBe(409)`),防止 `AllExceptionsFilter` 漏读 `httpStatus` 后退化为统一 500 或 200。

确认后按此顺序搭建,每一步都能跑、能验:

1. **项目初始化**:`pnpm` + NestJS CLI 起骨架,配 `tsconfig`、`eslint`、`prettier`
2. **Docker Compose**:本地 PostgreSQL 跑起来
3. **Prisma 接入**:`schema.prisma` + 第一次 migration + `PrismaService`
4. **公共基础件**:全局 `/api` 前缀、CORS、异常过滤器、响应拦截器、`BizException`、`@Public`、`@CurrentUser`、`@Roles`
5. **`health/` 健康检查**:`GET /api/health` 必须 `@Public()`,并能返回服务状态
6. **Swagger 接入**:开发环境 `/api/docs` 能打开,生产环境默认不注册
7. **`auth/` 登录**:`POST /api/auth/login`,返回 JWT,Swagger 上能调通
8. **`users/` 模块**:本人接口 + 管理员接口,分页返回 `PageResultDto<T>`,对外返回统一走 `userSafeSelect`,显式软删除过滤(`notDeletedWhere()` 帮助方法),管理员自我保护拦截 + 最后一个 SUPER_ADMIN 保护
9. **`prisma/seed.ts`**:从 `.env` 读 `SUPER_ADMIN_*`,bcryptjs 哈希后写入默认 super admin
10. **`common/storage/` 接口落地**:只放 `storage.interface.ts` 和 `storage.types.ts`;v1 不定义注入 token,不注册 `StorageModule`,不实现任何 Provider,不做签名 URL、分片上传、直传策略等高级能力
11. **`modules/ai/README.md`** 占位,不注册 `AiModule`,不实现 Provider,明确 v1 禁止实现 AI 能力,等第一个 AI 产品启动时再填
12. **`CLAUDE.md` + `AGENTS.md`**:从本文档第 7 节抽出 AI 协作铁律,两者并存
13. **`README.md`**:写"如何启动本地开发"

完成标准:本地 Docker PostgreSQL + NestJS 服务能一键启动;Swagger 上能完整验证 v1 所有接口;`GET /api/health`、登录、用户 CRUD、管理员保护、统一异常与统一响应格式都能按预期工作。

---

## 12. V2 派生项目方向(srvf-nest-api 基础数据底座)

> **适用范围**:本节**仅适用于派生项目 `srvf-nest-api`(深圳公益救援队内部系统)**,不是 `u-nest-api-starter` 模板仓的强制升级。
> **不破坏** `u-nest-api-starter` v0.1.6 起的 main 分支 template-freeze 约束(只允许 docs / CI 触发路径变更)。
> **状态**:**调研与设计阶段**,**未进入开发**。
> **本节定位**:**仅引用边界**,不锁 schema、不锁字段、不锁 API 路径、不锁实施顺序。具体边界以 [`docs/srvf-foundation-research.md`](./docs/srvf-foundation-research.md) 为准。

### 12.1 一句话目标

为 `srvf-nest-api` 沉淀**人员主数据 / 组织 / 字典 / 附件元数据 / 审计**五大基建,**不预先实现**任何具体救援业务流程。

### 12.2 与 v1 / V1.1 / 模板 freeze 的关系

- **v1**(本文 §1-§10):全部保留生效
- **V1.1**(本文 §11):全部保留生效
- **模板 freeze**(`u-nest-api-starter` v0.1.6):派生项目的 V2 工作**不回流**到模板仓 main 分支
- **本节(§12)**:派生项目侧的扩张登记,与模板仓解耦

### 12.3 V2 解锁项(相对 v1 §1)

以下四项在 v1 §1 的"v1 不做的事"中被冻结,V2 在派生项目侧**有限解锁**(具体边界见研究文档对应章节):

- **字典管理**(参考 [`docs/srvf-foundation-research.md`](./docs/srvf-foundation-research.md) §2.3 / §5.1)
- **操作日志的"基础设施"**(表与写入入口,**不**强制全模块覆盖,参考研究文档 §2.5)
- **组织树**(单一层级根,**不**做多租户;参考研究文档 §2.2)
- **通用附件元数据表**(**仅元数据**,**不**实装 Provider;参考研究文档 §2.4 / §3.10)

### 12.4 V2 仍不做项(继承 v1 §1,完整清单见研究文档 §3)

V2 第一阶段的"暂不做清单"由 [`docs/srvf-foundation-research.md`](./docs/srvf-foundation-research.md) §3.1 - §3.16 共 16 条统一锁定,本节不重复罗列。任何与该清单冲突的诉求,必须先回到研究文档评审,再决定是否调整。

要点提示(完整清单以研究文档为准):

- 不做装备 / 仓库 / 车辆 / 船艇管理(§3.1)
- 不做财务 / 报销 / 捐赠(§3.2)
- 不做救援任务调度 / 实时定位(§3.3)
- 不做大屏 / BI / 复杂报表(§3.4)
- 不做积分 / 评优 / 奖惩(§3.5)
- 不做通用审批流引擎(§3.6)
- 不做微信 / 公众号 / 企业微信深度集成(§3.7)
- 不做短信 / 邮件 / 站内消息(§3.8)
- 不做证件 / 保险自动校验与到期提醒(§3.9)
- 不做文件上传 Provider 实装(§3.10)
- 不做 RBAC / 通用数据范围权限引擎(§3.11)
- 不做 Redis / 队列 / 定时任务(§3.12)
- 不做 LLM / 向量检索(§3.13)
- 不做多租户(§3.14)
- 不做历史数据导入工具(§3.15)
- 考勤业务流程 / 训练业务模块**业务实现**暂不做(§3.16),但允许研究 events / event_participants 是否能作为底座承载

### 12.5 V2 设计阶段产物

- [`docs/srvf-foundation-research.md`](./docs/srvf-foundation-research.md) — 边界文档(已通过评审,V2 设计阶段冻结)
- [`docs/srvf-foundation-baseline.md`](./docs/srvf-foundation-baseline.md) — **V2 通用基线规范**(BizCode 段位 / 命名 / DTO / 软删除 / 验收门槛等 13 项 A 档约定);所有 V2 草案与开发的**隐含约束**,**不是数据模型草案**
- `ARCHITECTURE.md §12` — 本节,蓝图侧的轻量登记
- `CLAUDE.md §18` / `AGENTS.md §18` — V2 调研 / 设计阶段约束(非执行约束)
- `TASKS.md` V2 设计任务卡 — 调研 / 建模 / 评审任务,**不含**开发任务
- `docs/srvf-foundation-data-model-draft.md` — **候选模型草案**(待第二步通过后,作为第三步产出)

### 12.6 进入开发的前置条件(硬约束)

V2 任何 Prisma schema 变更、migration、新建 `src/modules/<业务>` 之前,**必须**完成:

1. `docs/srvf-foundation-research.md` 评审通过 ✅(已通过)
2. `ARCHITECTURE.md §12` 追加(本节)+ `CLAUDE.md §18` + `AGENTS.md §18` + `TASKS.md` V2 设计任务卡 同步追加(第二步产物)
3. `docs/srvf-foundation-data-model-draft.md` 候选模型草案完成并评审通过(第三步产物)
4. 本节(§12)升级为带 schema 锁定的开发蓝图(届时另起 §12.7+ 子节,**不破坏** §12.1-§12.6 的边界声明)

未走完上述四步 → **禁止**任何 schema / migration / 业务模块代码 / 新依赖动作。

### 12.7 与 v1 §6 接口清单的关系

V2 **不修改** v1 §6 已交付的 14 个接口的路径 / HTTP 方法 / 入参 / 出参 / 权限标注。V2 仅**追加**新模块的接口;具体接口清单在本节**不锁定**,留给未来开发蓝图与 v2-api-contract.md。

兼容性红线见研究文档 §5.6:不删 / 不改 / 不重命名 v1 `users` 已有字段,不破坏 `UserResponseDto`,不在 v1 接口响应中新增"必返"字段。

### 12.8 V2 第一阶段开发蓝图(自 D8 决议起锁定)

> **状态**:**V2-D8 立项中**(2026-05-07);本节自 D8 决议起锁定 V2 第一阶段开发范围与红线。
> **依据**:`docs/srvf-foundation-data-model-draft.md` v0.3 D7-min 决议版(commit `4333c31`)+ `TASKS.md` D7-min 同步(commit `281abc0`)+ baseline(commit `16876fe`)。
> **本节性质**:开发蓝图,**仅锁范围与红线**;具体计划 / 模型 / 接口契约由 `docs/v2-plan.md` / `docs/v2-data-model.md` / `docs/v2-api-contract.md` 承载,本节不重抄。

#### 12.8.1 V2 第一阶段开发范围

V2 第一阶段开发范围由 D7-min 决议锁定为 **4 个模型 + 1 项 v1 兼容性追加**:

| # | 模型 | 决议(D7-min,commit `4333c31`)| 草案对应章节 |
|---|---|---|---|
| 1 | `dictionaries`(`dict_types` + `dict_items`)| ✅ 进入 V2 第一阶段 | data-model-draft v0.3 §3.1.10 |
| 2 | `organizations` | ✅ 进入 V2 第一阶段 | §3.2.10 |
| 3 | `members` | ✅ 进入 V2 第一阶段 — 含 `memberNo` 业务唯一标识(非敏感、必填、全局唯一、不允许 PATCH;支持登录回退查找)| §3.3.10 + memberNo 决议(2026-05-08) |
| 4 | `member_departments` | ✅ 进入 V2 第一阶段 | §3.5.10 |
| — | v1 `users` 表追加 `memberId` 可空外键 | M-2 决议的不可避免后果 | §3.3.10 / §4.2.6 |
| — | v1 `auth.service.ts` 登录查找扩展支持 `memberNo` 回退 | memberNo 决议(2026-05-08)| §12.8.2.3 / §12.8.2.4 / `docs/v2-api-contract.md §6.6` |

**第一阶段不开发**(全部延后到 V2.x,无砍掉):

| # | 模型 | 决议(D7-min)| V2.x 复活触发条件 |
|---|---|---|---|
| 5 | `member_profiles` | ⏸️ 延后 | 合规依据补齐(详见 `TASKS.md §5.5.4.3`) |
| 6 | `attachments` | ⏸️ 延后 | profiles / events 解锁 / 用户拍板独立诉求(任一即可)|
| 7 | `audit_logs` | ⏸️ 延后 | V2.x 第一个增量,接入 V2 第一阶段 4 模型关键写操作 |
| 8 | `events` | ⏸️ 延后 | 用户拍板需求 → D7-4 评审 |
| 9 | `event_participants` | ⏸️ 延后(跟随 events)| 跟随 events 复活路径 |

V2.x 复活触发条件清单见 `TASKS.md §5.5.4.3`,本节不重抄。

#### 12.8.2 v1 兼容性红线(开发期硬约束)

V2 第一阶段开发**全程**遵守以下兼容性红线(对齐 baseline §11):

##### 12.8.2.1 v1 接口契约

- v1 §6 已交付的 14 个接口的**路径 / HTTP 方法 / 入参 DTO / 出参 DTO / 错误码 / 权限标注 / 响应包装**全部保留不变
- v1 `UserResponseDto` **不**新增必返字段
- `memberId` 是否作为 v1 接口的**可选返回**字段,留到具体开发任务中再评估;**默认不改 v1 出参**

##### 12.8.2.2 v1 表与 Prisma model 兼容性

- v1 `users` 表新增**可空** `memberId` 字段(unique 约束)— 为 M-2 决议的不可避免后果
- v1 `users` 已有字段 / 已有索引 / 已有外键**不动**
- Prisma `User` model 仅追加 `memberId` 可空字段 + 关系到 `Member` model;**不改**已有字段类型 / 命名 / 默认值

##### 12.8.2.3 v1 业务逻辑兼容性

- v1 用户登录路径(`POST /api/auth/login`)**对外契约不动**:HTTP 路径 / 方法 / `LoginDto` schema(`username` + `password` 字段名 / 类型 / 校验装饰器不变)/ 出参 / 错误码(`LOGIN_FAILED = 10004`)/ 响应包装 / Timing 防御机制 全部保留;OpenAPI 快照中 v1 `LoginDto` schema **零漂移**
  - v1 `LoginDto.username` 字段在 V2 第一阶段的**服务端查找语义**允许扩展为"username 或 memberNo"(由 `auth.service.ts` 内部回退查找实现;详见 §12.8.2.4 受限放开条款 + `docs/v2-api-contract.md §6.6`)
  - 扩展**仅在服务端**:不改字段名 / 类型 / 入参 schema;不新增 `/api/v2/auth/login` 路径;前端登录入口仍是单一的 `POST /api/auth/login`
  - 账号枚举防护场景**扩展**:输入值在 `username` 与 `memberNo` 两条查找路径下均未命中 / `memberNo` 命中但未绑定 user / 账号已禁用或已软删除 / 密码错误 — 全部统一抛 `LOGIN_FAILED`,响应包装 / 错误码 / message / HTTP status / Timing 防御机制保持一致;**禁止**暴露"编号存在但无账号"等可区分提示
- v1 用户创建 / 查询 / 更新 / 软删除路径**不动**
- v1 `seed.ts` 创建 SUPER_ADMIN 的逻辑**不动**(SUPER_ADMIN 默认 `memberId = null`,不强制绑 member)
- v1 既有 e2e 用例(19 suites / 162 tests,A4-1 时确认基线)**全部保留**且全部通过

##### 12.8.2.4 v1 已交付 src/ 文件修改限制

按 `CLAUDE.md §18.1` / D7-min 决议授权 + memberNo 登录回退决议(2026-05-08):

- ✅ **可以**修改 `prisma/schema.prisma` 追加 `memberId` 可空外键(M-2 决议授权)+ `Member.memberNo` 全局唯一字段
- ✅ **可以**修改 v1 `users.service.ts` / `users.dto.ts` 追加 `memberId` 字段处理逻辑(若开发任务需要)
- ⚠️ **受限放开** v1 `auth.service.ts`:**唯一**允许的扩展是登录查找路径追加 `memberNo` 回退(`username` 查找失败后,按 `memberNo` 在 `member` 表精确匹配,再通过 `users.memberId` 反查 user,照常走 `bcrypt.compare`)。**严格禁止**修改:
  - 入参 / 出参 DTO 字段集(`LoginDto` / 登录响应 schema 必须零漂移)
  - 错误码常量与文案(`LOGIN_FAILED = 10004` 等)
  - 响应包装链路 / `JwtService.sign` 调用方式 / `lastLoginAt` 顺手更新策略
  - Timing 防御机制 — 现有 dummy `bcrypt.compare` 必须保留,且**强制扩展**到新增 `memberNo` 路径,确保账号枚举相关失败场景(见 §12.8.2.3 + `docs/v2-api-contract.md §6.6.3`)耗时一致
  - 实现层依赖关系 — `auth.service` 必须通过 `PrismaService` 直读 `member` 表(`this.prisma.member.findUnique({ where: { memberNo } })`),**禁止** import `MembersModule` / `MembersService` 或任何 V2 业务层符号(避免 v1 → V2 循环依赖)
- ❌ **禁止**修改 v1 `auth.controller.ts` / `auth.dto.ts`(`LoginDto` 字段名 / 类型 / 校验装饰器 / 路径全保留)
- ❌ **禁止**修改 v1 `health/` 模块
- ❌ **禁止**修改 v1 `bootstrap/` 模块的全局中间件 / 拦截器 / 异常过滤器
- ❌ **禁止**修改 v1 `config/` 模块(除非新增 V2 配置文件)
- ❌ **禁止**修改 v1 `database/prisma.service.ts`

每次修改 v1 已交付 src/ 文件**必须**在 commit message 显式说明涉及哪个 v1 文件 + 跑完整 baseline §13 A 档 + B 档。`auth.service.ts` 受限放开属于**唯一破口**,Step 5 实施时必须独立 commit(`feat(auth): support memberNo login fallback`),单 commit 仅含 `auth.service.ts` 改动 + 配套 e2e + OpenAPI 快照对比证据;**严禁**与 members CRUD 揉进同一 commit。

##### 12.8.2.5 v1 OpenAPI 契约快照

沿用 V1.3 已建立的 `test/contract/openapi.contract-spec.ts` 快照机制:

- V2 4 模块开发后,**新增**接口的 schema 进入快照
- v1 14 接口 schema 在快照中**保持不变**(若发生变化,视作 v1 兼容性破坏,等同于 §12.8.2.1 红线违反)

#### 12.8.3 跨模型形态约束(对齐 baseline + D7-min)

V2 第一阶段 4 模型**全程**遵守以下跨模型形态约束:

| # | 约束 | 来源 |
|---|---|---|
| **X-1** | 字典引用方式**全模块统一**为 `<concept>Code` 字符串字段(如 `gradeCode` / `nodeTypeCode`)| D-2 / O-2 / M-4 决议(data-model-draft v0.3 §3.1.10 / §3.2.10 / §3.3.10) |
| **X-2** | 软删除按 baseline §10:`deletedAt: Date \| null` + `notDeletedWhere` helper(commit `d8fd444` 已就位) | baseline §10 |
| **X-3** | 启停字段命名按 baseline §2.2.3:统一 `status` enum | baseline §2.2.3 |
| **X-4** | 多对多中间表命名按 baseline §2.2.2:`member_departments` 业务序 | baseline §2.2.2 |
| **X-5** | 通用字段全模块一致:`id`(cuid)/ `createdAt` / `updatedAt` / `deletedAt` | baseline §2.1 |
| **X-6** | BizCode 段位:`organizations`=`110xx`/`111xx` / `dictionaries`=`120xx`/`121xx` / `members`=`150xx`/`151xx` / `member_profiles`=`160xx`/`161xx`(本阶段不用,保留)/ `member_departments`=`170xx`/`171xx`| baseline §1.1 |
| **X-7** | 命名遵守 baseline §2.1 / §2.2 全部红线(时间字段 / 主键 / 软删标记 / 文件 key 等)| baseline §2 |
| **X-8** | 响应包装 / 异常 / Swagger 100% 覆盖 / DTO 白名单 / 模块结构 / 错误码命名规范 / 配置归属 / Guard 链 全部沿用 baseline §3-§9 | baseline §3-§9 |
| **X-9** | 时区全栈 UTC,前端转本地;**禁止**后端按"中国时区"提前转换 | baseline §12 |
| **X-10** | 验收按 baseline §13 A 档 + B 档(涉及 HTTP 行为 / 全局中间件 / 拦截器 / Guard / Controller / Swagger 时追加 B 档)| baseline §13 |

#### 12.8.4 第一阶段绝对禁止清单(继承 + 强化)

V2 第一阶段开发期间**严禁**:

- ❌ 开发 `member_profiles`(任何敏感字段 — 身份证 / 紧急联系人 / 医疗 / 出生日期 / 住址 / 性别 / 第三方账号 / 凭证标识 等)
- ❌ 开发 `events` / `event_participants`(活动事件 / 参与状态)
- ❌ 开发 `attachments`(附件元数据 / 上传 Provider)
- ❌ 开发 `audit_logs`(审计基础设施 / 任何接入)
- ❌ 实装文件上传 Provider(本地 / OSS / R2 / 其他;沿用 `research.md §3.10`)
- ❌ 引入 RBAC / permission 表 / casl(沿用 v1 §1)
- ❌ 引入 Redis / 队列 / 定时任务(沿用 v1 §1 / V1.1 §11.3)
- ❌ 实现读审计 / 完整状态机 / 流程引擎(沿用 `research.md §3.6` / §3.16)
- ❌ 引入新依赖(除非 v2-plan 任务卡显式登记)
- ❌ 修改 `docker-compose.yml` / `.github/workflows/ci.yml`(除非 D8 立项后单独评估)

---

### 12.9 V2 第一阶段开发顺序

V2 第一阶段开发按 7 步顺序推进,**逐步独立交付,逐步独立 commit**;具体任务卡见 `TASKS.md §6` / 计划详情见 `docs/v2-plan.md`。

#### 12.9.1 7 步开发顺序

| Step | 内容 | 关键依赖 |
|---|---|---|
| **Step 1** | Prisma schema + migration:4 模型 + `users.memberId` 可空外键 | baseline + v1 schema 不破坏 |
| **Step 2** | seed neutral-demo 字典类型(节点类别 / 队员等级 2 类),**仅占位**;真实取值不进 git history(R13)| Step 1 完成 |
| **Step 3** | `dictionaries` 模块(`dict_types` + `dict_items` controller / service / dto / e2e)| Step 1-2 完成 |
| **Step 4** | `organizations` 模块(树形 controller / service / dto / e2e)| Step 1-3 完成(依赖字典) |
| **Step 5** | `members` 模块(controller / service / dto / e2e)+ v1 `users` 服务侧追加 `memberId` 关系处理 | Step 1-4 完成 |
| **Step 6** | `member_departments` 归属能力(嵌套或独立 controller / service / dto / e2e + 单归属约束业务规则)| Step 1-5 完成 |
| **Step 7** | E2E 全量回归 + 契约快照更新 + 文档收口(README / CHANGELOG / TASKS.md 收尾)| Step 1-6 全部完成 |

#### 12.9.2 每步必须交付物

| Step | 交付物清单 |
|---|---|
| Step 1 | Prisma schema 改动 + migration 文件 + `pnpm prisma:generate` 通过 + `pnpm prisma:migrate dev`(本地)/ `pnpm prisma:deploy`(CI)通过 |
| Step 2 | `prisma/seed.ts` 改动 + neutral-demo 字典类型 + 幂等(跑两次结果一致)|
| Step 3-6 | 4 文件结构(`<name>.module.ts` / `.controller.ts` / `.service.ts` / `.dto.ts`)+ `<name>.e2e-spec.ts` + Swagger 100% 覆盖 |
| Step 7 | OpenAPI 契约快照更新 + e2e 全量通过 + README / CHANGELOG 增量 + TASKS.md §6 状态收尾 |

#### 12.9.3 每步验收门槛(对齐 baseline §13)

每步完成前必须跑:

**A 档(必跑)**:

- `pnpm lint`(0 warnings / 0 errors)
- `pnpm typecheck`
- `pnpm test`(unit)
- `pnpm test:e2e`(v1 既有 19 suites / 162 tests **零退化** + V2 新增 e2e 通过)
- `pnpm test:contract`(若涉及 OpenAPI schema 变更,显式更新快照)

**B 档(涉及 HTTP 行为 / 全局中间件 / 拦截器 / Guard / Controller / Swagger 时追加)**:

- 启动服务,确认 `/api/docs` 仍正常打开
- 确认 v1 `GET /api/health` / `/api/health/live` / `/api/health/ready` 三端点向后兼容
- 任意 v1 14 接口典型路径不退化(管理员可手工 spot check)
- V2 新接口典型成功路径 + 典型错误路径

任一未通过 → **不算完成,不能 commit,不能向用户报告"任务完成"**(沿用 V1.1 §17.10 末尾纪律)。

---

### 12.10 V2 第一阶段开发产出物清单

#### 12.10.1 必须产出

| # | 产出物 | 状态 |
|---|---|---|
| 1 | `ARCHITECTURE.md §12.8-§12.11`(本节及后续)| ⏳ 待 D8 立项首批 commit 后落地 |
| 2 | `docs/v2-plan.md`(开发执行计划)| ⏳ 待 D8 立项中产出 |
| 3 | `docs/v2-data-model.md`(4 模型 + `users.memberId` 数据模型说明)| ⏳ 待 D8 立项中产出 |
| 4 | `docs/v2-api-contract.md`(接口契约草案)| ⏳ 待 D8 立项中产出 |
| 5 | `TASKS.md §6` V2 第一阶段开发任务卡(7 个 Step 任务卡)| ⏳ 待 D8 立项中产出 |
| 6 | Prisma schema + migration(4 模型 + `users.memberId`)| 由 Step 1 交付,**不在本节范围** |
| 7 | 4 个 NestJS 模块代码 + e2e | 由 Step 3-6 交付,**不在本节范围** |
| 8 | OpenAPI 契约快照更新 | 由 Step 7 交付,**不在本节范围** |

#### 12.10.2 不在产出范围

- ❌ `member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants` 任何代码 / schema / 测试
- ❌ 文件上传 Provider 实装
- ❌ RBAC / permission 表 / casl
- ❌ Redis / 队列 / 定时任务
- ❌ AI / 向量检索
- ❌ 多租户 / 复杂审批流 / 通知系统
- ❌ 任何 v1 §1 / V2 §3 已锁定的"不做"项的破口

---

### 12.11 D8 解除条件与 V2.x 路径

#### 12.11.1 D8 解除条件(进入 V2 第一阶段开发的硬前置)

V2 第一阶段开发(Step 1-7 任一启动)前**必须**完成以下立项产出物:

1. ✅ `ARCHITECTURE.md §12.8-§12.11`(本节)— D8 立项首批 commit
2. ⏳ `docs/v2-plan.md` — D8 立项第 2 批 commit
3. ⏳ `docs/v2-data-model.md` — D8 立项第 3 批 commit
4. ⏳ `docs/v2-api-contract.md` — D8 立项第 4 批 commit
5. ⏳ `TASKS.md §6` — D8 立项第 5 批 commit

5 份产出物**全部就位**后,V2-D8 标记为 ✅ 已完成,V2 第一阶段开发(Step 1-7)进入待启动状态。

每份产出物**单独 commit**;每份完成后**单独审过**;沿用 V2-D5 三阶段拆分模式。

#### 12.11.2 V2.x 复活路径

5 个延后模型(`member_profiles` / `attachments` / `audit_logs` / `events` / `event_participants`)的 V2.x 复活触发条件锁定在 `TASKS.md §5.5.4.3`,本节不重抄。

V2.x 启动节奏由用户拍板;**禁止**在 V2 第一阶段开发期间偷偷把延后模型的代码 / schema / 测试塞进 commit。

#### 12.11.3 边界声明

V2 第一阶段开发完成后,**不自动**进入 V2.x;V2.x 启动需用户单独拍板,**等同于 D8 第二轮立项决策**。

V2 第一阶段开发期间发现的任何"看起来该顺手做"事项(包括延后模型 / 暂不做项 / 未登记新依赖等),**全部**走 `TASKS.md §6.4` 范围外统一处理流程,**禁止**未经用户确认就动作。
