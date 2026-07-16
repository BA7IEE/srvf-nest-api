---
name: srvf-auth-security
description: Use when changing authentication, login, logout, refresh token rotation, password change/reset, JWT strategy/payload, throttling, guards, roles, or security-sensitive user access behavior in srvf-nest-api.
---

# srvf-auth-security

## Purpose

SRVF Nest API 项目所有 auth / token / 密码 / 限流 / Guard / 审计跨模块变更的工作流。本 skill 只编排"何时触发 / 先核验什么 / 哪些不能碰 / 怎么验证 / 怎么报告",**不**复制权威源细节;具体阈值 / 字段 / 错误码 / 事件名 / e2e 覆盖查:

- [`src/modules/auth/CLAUDE.md`](../../../src/modules/auth/CLAUDE.md) — auth 模块本地铁律
- [`src/modules/permissions/CLAUDE.md`](../../../src/modules/permissions/CLAUDE.md) — RBAC / capability vs raw permission
- [`AGENTS.md §2/§3`](../../../AGENTS.md) + `docs/reference/{auth-jwt-refresh,roles-admin-protection,api-client-boundary}.md` — auth/token/密码长期铁律与 D-series decision lock
- [`docs/security.md`](../../../docs/security.md)
- [`docs/process.md §3 / §4`](../../../docs/process.md) — PR 分级 / D 档降速
- [`docs/current-state.md`](../../../docs/current-state.md)

冲突时:用户本轮指令 → 模块本地 CLAUDE → `docs/reference/auth-jwt-refresh.md` + `AGENTS.md §2` → `docs/security.md` → 其它。规则冲突**停止并报告**,不自行调和。

## When to use

任务涉及以下任一情况即启用:

- 修改 `src/modules/auth/**` 任何文件
- 修改 login / refresh / logout / logout-all 任一 endpoint 或 service
- 修改本人改密 / 管理员重置 / 任何与密码相关流程
- 修改 `JwtPayload` / `JwtStrategy` / JWT 签发 / token TTL 配置
- 修改全局 Guard(JwtAuthGuard / RolesGuard / ThrottlerBizGuard)/ `@Public()` / `@Roles(...)`
- 修改 throttle 装饰器 / 阈值 / 装饰器到 endpoint 的分配
- 修改 refresh token 生成 / 存储 / rotation / reuse detection / family revoke 任一环节
- 修改 auth audit event 命名 / `extra` 字段 / writer 路径
- 修改 `assertCanManageUser` / 自我保护 / 最后一个 SUPER_ADMIN 保护

## Required first checks

先**只读**调研,不动任何文件。必须确认并记录:

- 当前 `JwtPayload` 字段集与 `JwtStrategy.validate` 行为(每请求查库,不可弱化)
- 当前 refresh token 存储字段与 rotation / revoke 字段
- 当前限流装饰器分配与 throttler 物理隔离
- 当前 auth audit event 集合与 `extra` 允许字段
- 当前 auth / users / permissions 相关 e2e 覆盖
- 是否触发联动撤销(本人改密 / 本人短信重置〔找回密码〕/ 管理员重置 / 用户禁用 / 用户软删)

## Security invariants

以下不变式**严禁弱化**;具体字段 / 阈值 / 错误码 / 事件名查模块本地 CLAUDE 或代码:

- **`JwtPayload` 保持当前 `{ sub, username }`**;不得随意扩展(`role` / `permissions` / `tokenVersion` / 其它业务字段),除非已有设计决议
- **`JwtStrategy.validate` 每请求查用户有效性**(`deletedAt === null && status === ACTIVE`);**不**引入长期身份缓存
- **refresh token hash-only**:明文绝不入库 / 日志 / audit / OpenAPI 示例 / e2e fixture
- **refresh rotation / absolute expiration / reuse detection family revoke** 三不变式不得弱化;判断顺序不得调换
- **login 失败不得泄露账号是否存在**:所有失败场景同响应体 + 同 HTTP status + 同 timing(命中 / 未命中均跑一次 `bcrypt.compare`)
- **refresh 失败统一一个错误码**;不得拆分子原因(`EXPIRED` / `REVOKED` / `REPLAY`)
- **password change / logout-all 与 refresh token 撤销关系不得弱化**:联动撤销五场景(自助改密 / 本人短信重置〔找回密码〕/ 管理员重置 / 用户禁用 / 用户软删)必须同事务内完成
- **找回密码防枚举不得弱化**:无效号码四场景 send-code 同泛化 200 零留痕;reset 一切失败统一 24010;10006 检查不得挪到码预检之前(密码 oracle);reset 不得返回 token / 用户字段
- **access token 当前不主动吊销**:依赖 token TTL + 每请求查库阻断;blacklist / Redis / `tokenVersion` 属设计决议,不在常规改动中引入
- **不引入 `LocalStrategy`** / OAuth / 第三方登录,除非已有设计决议
- **不暴露 token / password / hash / secret / 完整 signed URL** 到 audit / log / client / OpenAPI / e2e fixture / 文档
- **raw permission ≠ app capability**:RBAC 原始权限码与 App capability 输出语义不等价,不得 alias / 合并

## Risk grade

| 档 | 范围 | 用户拍板 |
|---|---|---|
| **A** | docs-only / 注释 / 本 skill / 测试措辞不动断言 | ❌ |
| **B** | 内部重构 / 不触 e2e 断言 / 不触 contract | ❌(常规) |
| **C** | auth 行为变化 / 限流调整 / Guard 链调整 / audit event 字段 | ✅ |
| **D** | `JwtPayload` 变化 / refresh 语义 / 密码策略 / public-auth boundary / token 吊销策略 / 联动撤销变化 | ✅ + 评审稿 |

## Validation

按档位选择:

- **A**:`pnpm agent:preflight`
- **B**:`pnpm lint && pnpm typecheck && pnpm test`
- **C**:B 全部 + 相关 auth / users / permissions e2e pattern;触 contract 时加 `pnpm test:contract`
- **D**:`pnpm agent:check:full`,且必须先评审稿冻结

本地缺 `node_modules` 或 `eslint command not found` 时:**不要** `pnpm install` / 改 lockfile;如实报告环境阻塞并继续 diff 报告。

## Output report

提交前必须列出:

- 修改文件清单
- 触及的 security invariants
- 是否变 `JwtPayload` / refresh / password / throttle / Guard / audit
- 验证命令与结果
- 档位判定
- residual risk(未跑的 e2e / 未补的 characterization / 已识别但未处理的风险)
- 是否建议 commit

## Hard stops

下列情况**立即停止并报告**:

- 未授权但需要变 `JwtPayload` / refresh token 语义 / 密码策略 / 联动撤销 / token 吊销策略
- 需要引入 access token blacklist / Redis 撤销 / `tokenVersion`
- 需要引入 `LocalStrategy` / OAuth / 第三方登录
- 需要让 login 失败响应使任一场景可区分(message / status / timing / errorCode)
- 需要拆 refresh 失败码为多个子原因
- 需要在 audit / log / client 暴露 token / password / hash / secret
- 需要弱化 `JwtStrategy.validate` 每请求查库
- 任务诉求与 `AGENTS.md §2` D-series 决策锁冲突
- 任务超出本 PR 白名单
