# 开发指南

> 本文聚焦"日常开发要怎么做",不重复 [`README.md`](../README.md) 的快速启动步骤。

---

## 项目结构

```
.
├── ARCHITECTURE.md           # v1 蓝图(详版结构见 §3),所有规则的唯一来源
├── CLAUDE.md / AGENTS.md     # AI 协作铁律
├── docker-compose.yml        # 本地 PostgreSQL
├── Dockerfile                # 多阶段生产镜像
├── prisma/
│   ├── schema.prisma         # 数据模型(User + Role + UserStatus)
│   ├── migrations/           # 自动生成的迁移文件
│   └── seed.ts               # 默认 super admin 种子
├── docs/                     # 拆分自 README 的详细文档
└── src/
    ├── main.ts               # 应用入口
    ├── app.module.ts         # 模块注册 + 全局 Guard 注册(纯结构)
    ├── bootstrap/            # 启动期纯函数(global setup / swagger / logger / throttle / request-id)
    ├── config/               # app / database / jwt 三份 config
    ├── common/               # 公共基础件:decorators / dto / exceptions / filters / guards / interceptors / storage(占位)
    ├── database/             # PrismaService + DatabaseModule
    └── modules/
        ├── health/           # GET /api/health(三层)
        ├── auth/             # POST /api/auth/login
        ├── users/            # users.controller / .service / .dto / .select / .policy
        └── ai/               # README.md 占位,v1 不实现
```

`bootstrap/`、`users.policy.ts` 在 V1.2 引入,详见 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §11。

---

## 路由总览

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| `GET` | `/api/health` | 公开 | 服务健康检查(向后兼容) |
| `GET` | `/api/health/live` | 公开 | K8s liveness — 进程存活 |
| `GET` | `/api/health/ready` | 公开 | K8s readiness — DB 连通(失败时 HTTP 500 + `code: 50000`) |
| `POST` | `/api/auth/login` | 公开 | `username + password` 登录,返回 JWT;**默认 IP 维度限流 5 次 / 60 秒** |
| `GET` | `/api/users/me` | 登录 | 获取本人资料 |
| `PATCH` | `/api/users/me` | 登录 | 修改本人非敏感资料(昵称、头像 key) |
| `GET` | `/api/users` | super admin / admin | 用户列表(分页) |
| `POST` | `/api/users` | super admin / admin | 创建用户 |
| `GET` | `/api/users/:id` | super admin / admin | 用户详情 |
| `PATCH` | `/api/users/:id` | super admin / admin | 修改用户资料 |
| `PUT` | `/api/users/:id/password` | super admin / admin | 重置用户密码 |
| `PATCH` | `/api/users/:id/role` | **super admin only** | 修改用户角色 |
| `PATCH` | `/api/users/:id/status` | super admin / admin | 启用/禁用用户 |
| `DELETE` | `/api/users/:id` | super admin / admin | 软删除用户 |
| `GET` | `/api/docs` | 开发环境默认开启 | Swagger UI(生产需 `ENABLE_SWAGGER=true`) |

完整字段、入参 / 出参 DTO、错误码归属详见 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §6。

---

## 认证示例

```bash
# 1. 登录拿 token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"ChangeMe123456"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['accessToken'])")

# 2. 用 token 访问受保护接口
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/users/me
```

成功响应统一为 `{ "code": 0, "message": "ok", "data": ... }`,错误响应为 `{ "code": <BizCode>, "message": <提示>, "data": null }`。详见 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §7.3。

---

## 环境变量

完整字段与默认值见 [`.env.example`](../.env.example)。已落地字段:

| 字段 | 用途 | 阶段 |
|---|---|---|
| `DATABASE_URL` | PostgreSQL 连接串(Prisma CLI 自动读取) | v1 第 3 阶段 |
| `APP_PORT` / `APP_ENV` / `APP_CORS_ORIGIN` / `ENABLE_SWAGGER` | 应用层运行参数 | v1 第 4 阶段 |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | JWT 签发参数 | v1 第 7 阶段 |
| `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD` / `SUPER_ADMIN_EMAIL` | seed 默认账号 | v1 第 9 阶段 |
| `LOG_LEVEL` | pino 日志级别(`fatal`/`error`/`warn`/`info`/`debug`/`trace`),留空时按 `APP_ENV` 自动推断 | V1.1 §15.2 |
| `LOGIN_THROTTLE_LIMIT` / `LOGIN_THROTTLE_TTL_SECONDS` | 登录接口 IP 维度限流参数,留空默认 `5` / `60` | V1.1 §15.7 |

启动强校验细则见 [`ARCHITECTURE.md`](../ARCHITECTURE.md) §8 / §11.5 + [`CLAUDE.md`](../CLAUDE.md) §14 / §17。

---

## 排错

- **启动时抛 `JWT_SECRET 长度不足` / `APP_CORS_ORIGIN 不能为空`**:`.env` 缺字段或值不符合启动强校验,按提示修。
- **`pnpm prisma:migrate` 报连接错误**:确认 `docker compose ps` 中 `u-nest-api-postgres` 已 `healthy`。
- **`/api/docs` 返回 404**:检查 `APP_ENV` 与 `ENABLE_SWAGGER`,生产环境必须显式 `ENABLE_SWAGGER=true` 才注册 Swagger。
- **`pnpm prisma:seed` 提示 `already exists; skipping`**:这是预期行为(seed 幂等,不会覆盖已存在用户)。
