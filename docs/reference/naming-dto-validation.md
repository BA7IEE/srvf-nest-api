# 模块结构 · 命名 · 校验 · DTO 边界(reference · 触碰才读)

> Harness 2.0 细则层:承接 harness v1 `AGENTS.md` §2 / §3 / §7 / §11 **原文逐字搬家(零放宽;唯一机械改写=相对链接前缀)**;恒读入口与速查见根 [`AGENTS.md`](../../AGENTS.md),原文快照 [`archive/harness-v1/AGENTS.md`](../archive/harness-v1/AGENTS.md)。
> 机器锁定:全局 ValidationPipe + contract snapshot + lint/typecheck。

## 2. 模块结构:默认 4 文件基线 + 已解锁例外

业务模块**默认**以 4 文件为基线:

```
modules/<name>/
├── <name>.module.ts
├── <name>.controller.ts
├── <name>.service.ts
└── <name>.dto.ts
```

SRVF 派生项目已解锁以下例外。**执行细节以 [`docs/api-surface-policy.md`](../api-surface-policy.md)(surface 边界 / Mixed Controller 存量 / mobile-like endpoint 处置)+ [`docs/architecture-boundary.md`](../architecture-boundary.md)(职责类抽离触发条件)为长期权威**;本节只保留例外名称 + 不可变铁律。

**已解锁例外**:

- **Surface-specific Controller / DTO**:App / Mobile surface 用 `controllers/app-*.controller.ts` + `dto/app/` 子目录;Legacy 兼容入口用 `controllers/*-legacy.controller.ts`。新移动端 endpoint **只能**落 `/api/app/v1/*` 且必须建独立 Mobile Controller(详 [`api-surface-policy.md §2.1`](../api-surface-policy.md))
- **同模块内职责类抽出**(Presenter / QueryService / PolicyService / StateMachine / AuditRecorder / Effect 6 类):触发条件与边界规则见 [`architecture-boundary.md §3 / §6`](../architecture-boundary.md)
- **DTO 子目录**:单个 dto 文件超 300 行,允许拆同模块内 `dto/` 目录
- **health/ 例外**:`health/` 只有 `health.module.ts` + `health.controller.ts`

**不可变铁律**(违反任一视作越权):

- ❌ **禁止** `*.entity.ts`(本项目不是 TypeORM 项目)
- ❌ **禁止**跨模块公共目录(`common/utils/` / `shared-services/` / 任何 "common util grab-bag")
- ❌ **禁止**用 `extends` / `Pick` / `Omit` / `IntersectionType` / `PartialType` / `OmitType` 从 Admin DTO 派生 App DTO(沿 §19.7 D-6)
- ❌ **禁止**在未补 characterization tests 前拆 god-service(沿 [`api-surface-policy.md §7 P1-B`](../api-surface-policy.md) + [`current-state.md §4 P2`](../current-state.md))
- ❌ **不再新增 Mixed Controller**(class-level + 方法级双 `@ApiTags`);现存 6 处存量保留不扩展,详 [`api-surface-policy.md §5.1`](../api-surface-policy.md)
- ✅ 新业务模块**平铺**加在 `src/modules/` 下,**禁止**嵌套 `system/` / `business/` / `core/` 子目录

> **冲突顺序**:本节与 [`api-surface-policy.md`](../api-surface-policy.md) / [`architecture-boundary.md`](../architecture-boundary.md) 冲突时,以后者为准并回头同步本节;**不**允许"按 4 文件基线读"否决 surface 拆分既成事实。


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


## 7. 全局 ValidationPipe

`main.ts` 注册全局 `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })`。`forbidNonWhitelisted` 保证 DTO 未声明字段直接报错;**禁止** controller 重复配置局部 `ValidationPipe`。


## 11. DTO 与 Prisma 类型严格分离

- 入参 DTO 带 `class-validator` 装饰器
- 出参 DTO `UserResponseDto` 显式列出对外字段(永不含 `passwordHash`,**必须包含** `lastLoginAt`)
- Prisma 生成的 `User` 类型仅在 service 内部用,**绝不直接返给 controller / 前端**
- `User` 对外返回必须使用集中定义的 `userSafeSelect`(在 `modules/users/users.select.ts`)
- `UserResponseDto` 与 `userSafeSelect` **必须同步维护**:增删字段时同时改两边
- 禁止 `*.entity.ts`

### 入参 DTO 字段白名单(纵深防御)

`forbidNonWhitelisted: true` 是兜底,DTO 自身白名单是第一道防线;一旦 DTO 多声明一个字段,纵深防御直接破口。

- **`UpdateMyProfileDto`**(`PATCH /api/app/v1/me/profile`):仅允许 `nickname` / `avatarKey`。**禁止**包含 `username` / `email` / `password` / `newPassword` / `oldPassword` / `passwordHash` / `role` / `status` / `deletedAt` / `id` / `lastLoginAt` 等任何字段;本人自助改密必须走独立接口 `PUT /api/app/v1/me/password`(铁律见 §9)
- **`UpdateUserDto`**(`PATCH /api/admin/v1/users/:id`,管理员改用户资料):**禁止**包含 `role` / `password` / `passwordHash` / `status` / `deletedAt` / `id`。角色修改走 `PATCH /api/admin/v1/users/:id/role`,密码重置走 `PUT /api/admin/v1/users/:id/password`,启用 / 禁用走 `PATCH /api/admin/v1/users/:id/status`,软删除走 `DELETE /api/admin/v1/users/:id`,**绝不在更新资料接口里夹带**
- **`CreateUserDto.role`** 可选,**禁止**直接透传给 Prisma;必须经业务层根据当前用户角色校验后再决定写入值(见 §13)

### `IdParamDto` 字符串校验

所有 `:id` 路径参数都通过 `IdParamDto` 校验:`@IsString()` + `@Length(8, 64)`(长度校验,不写死 cuid 正则)+ `@ApiProperty({ example: 'cl9z3a8b00000abcd1234efgh' })`。**禁止** `@Param('id', ParseIntPipe)` / `id: number` / `@IsInt()`。

