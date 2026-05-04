# 安全说明

> 本文记录当前版本已落地的安全策略,以及刻意未实现、留待 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §9 升级条件触发后再做的能力的**升级路径**。
>
> AI 二开时务必读完本文,不得擅自把"升级路径"段落里的能力直接落到代码里。

---

## 已落地策略

| 能力 | 实现位置 | 说明 |
|---|---|---|
| 防账号枚举 | `auth.service.ts` | 四场景(`username` 不存在 / `password` 错 / 已禁用 / 已软删除)统一 `LOGIN_FAILED` + HTTP 401,`username` 不存在路径仍跑 `bcrypt.compare(dummyHash)` 抹平 timing |
| 密码哈希 | `auth.service.ts` / `users.service.ts` | `bcryptjs`,salt rounds=10;响应 DTO 永不含 `passwordHash`(`userSafeSelect` 排除) |
| 字段白名单 | `*.dto.ts` + 全局 `forbidNonWhitelisted: true` | 入参 DTO 不声明的字段直接 422;`UpdateMyProfileDto` 仅 `nickname/avatarKey`,`UpdateUserDto` 不接受 `role/password/status` |
| 角色策略集中 | `src/modules/users/users.policy.ts` | 4 个纯函数(`canViewUser` / `canManageUser` / `canCreateRole` / `canChangeRole`),双层校验:Guard 管入口、policy 管业务 |
| 自我保护 | `users.service.ts` | 自删 / 自禁 / 自改角色一律 `CANNOT_OPERATE_SELF` |
| 最后一个 SUPER_ADMIN 保护 | `users.service.ts` `assertNotLastSuperAdmin` | 在事务内 `count` 剩余活跃 super admin,< 1 抛 `LAST_SUPER_ADMIN_PROTECTED` |
| helmet HTTP 安全头 | `bootstrap/apply-global-setup.ts` | 默认开启,Swagger UI 局部放开 CSP |
| 登录限流 | `@nestjs/throttler` 内存 storage | 仅 `POST /api/auth/login`,IP 维度 5 次 / 60 秒(可配),不暴露阈值 |
| 日志敏感字段 redact | `bootstrap/logger-options.ts` | 命中字段日志显示为 `[REDACTED]`,**不仅仅是长度截断** |
| 启动强校验 | `config/app.config.ts` + `prisma/seed.ts` | `APP_ENV=production` 下拒绝默认值的 `JWT_SECRET` / `APP_CORS_ORIGIN=*` / `SUPER_ADMIN_PASSWORD` / `SUPER_ADMIN_USERNAME=admin` |

### 日志 redact 清单

```
req.headers.authorization
req.headers.cookie
res.headers["set-cookie"]
req.body.password
req.body.newPassword
req.body.token
req.body.accessToken
req.body.refreshToken
*.password
*.newPassword
*.passwordHash
*.token
*.accessToken
*.refreshToken
*.secret
```

新增字段时同步追加,不能只在某条日志手工裁剪。

---

## 软删除策略

- **当前版本支持软删除**:`DELETE /api/users/:id` 走 `update({ deletedAt: new Date(), status: DISABLED })`,从不调用 `prisma.user.delete()`
- 所有非"管理员看回收站"查询经 `notDeletedWhere()` 过滤,业务接口看不到已删用户
- `username` / `email` 唯一性预检查走 `findUnique`(包含软删记录),软删后这两个字段**不复用**——避免身份冒用
- **当前版本不提供 restore 接口**;误删恢复需数据库管理员人工操作:
  ```sql
  UPDATE "User" SET "deletedAt" = NULL, "status" = 'ACTIVE' WHERE id = '...';
  ```
- 后续若实现 restore,接口契约预定义为:
  - `PATCH /api/users/:id/restore`
  - **仅 `SUPER_ADMIN` 可用**(`@Roles(Role.SUPER_ADMIN)`)
  - 入参为空,出参与其他用户接口一致(`UserResponseDto`)
  - 同样要在事务里检查 `username` / `email` 是否被新用户占用,若占用则要求先重命名旧记录或拒绝恢复
  - **本节属于升级路径,AI 不得在 V1.2 范围内实现**

---

## Token 吊销升级路径

当前版本 **不实现 refresh token,不引入 Redis blacklist**:JWT 一经签发即在 `JWT_EXPIRES_IN` 内有效;管理员重置密码后**不主动**吊销旧 token,只能通过把目标用户 `status` 改 `DISABLED` 间接阻断(`JwtStrategy.validate()` 每请求查库)。

后续真出现"重置密码 / 强制下线必须立即生效"诉求时,**推荐升级路径**(按顺序施工):

1. **schema**:`User` 增加 `tokenVersion Int @default(0)`,迁移已存在用户为 `0`
2. **JWT payload**:增加 `tv: number` 字段,签发时取自 `user.tokenVersion`
3. **JwtStrategy.validate()**:除现有 `deletedAt === null && status === ACTIVE` 校验外,追加 `payload.tv === user.tokenVersion`,不一致抛 `UNAUTHORIZED`
4. **吊销触发点**:重置密码、禁用用户、显式"踢下线"等场景,在写库事务内 `tokenVersion: { increment: 1 }`
5. **不引入 Redis**:每请求多读一个字段,与现有 `JwtStrategy` 单次查库合并,无新增 IO
6. **升级条件**:见 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §9。**AI 不得在 V1.2 范围内实现**,需用户明确确认升级后单独立项

为什么不直接做:JWT 简单可用、`status=DISABLED` 已能覆盖"封禁账号"主路径,refresh token + tokenVersion 增加状态管理复杂度,与 v1 "简单、显式、强约束" 的设计目标冲突。
