# 测试纪律(reference · 触碰才读)

> Harness 2.0 细则层:承接 harness v1 `AGENTS.md` §16 **原文逐字搬家(零放宽;唯一机械改写=相对链接前缀)**;恒读入口与速查见根 [`AGENTS.md`](../../AGENTS.md),原文快照 [`archive/harness-v1/AGENTS.md`](../archive/harness-v1/AGENTS.md)。
> 机器锁定:CI 全量(agent:check:full)。

## 16. 测试策略

- v1 初始搭建不强制 E2E,不阻塞骨架
- `auth` / `users` 稳定后优先引入 E2E
- E2E 必须断言统一响应格式;错误响应必须**同时断言 HTTP status code 与 `BizCode.httpStatus` 一致**
- 登录失败必须覆盖**防账号枚举四场景**(`username` 不存在 / `password` 错 / 已禁用 / 已软删除),响应体与 HTTP status 完全相同
- E2E 优先覆盖:登录、JWT 鉴权、用户 CRUD、角色边界、软删除、禁用用户、最后一个 SUPER_ADMIN 保护、唯一约束冲突

