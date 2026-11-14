---
name: srvf-auth-security
description: 修改 SRVF 登录、refresh、密码、JWT、限流、Guard 或安全敏感访问行为时使用。
---

# 鉴权变更

路径均相对仓库根。按触碰读取 `src/modules/auth/CLAUDE.md`、
`src/modules/permissions/CLAUDE.md`、`docs/reference/auth-jwt-refresh.md` 与 `docs/security.md`。

- 对照现有 payload、验证/撤销顺序、限流分配、审计字段及 E2E；跨模块变更先确认调用链。
- JwtPayload 保持 `{ sub, username }`；每请求查用户有效性，不缓存身份/权限。
- refresh 只存 hash，保持 rotation/absolute expiry/family revoke 和统一失败码；
  九种联动撤销与主写同事务。不新增 access blacklist、tokenVersion 或 Redis。
- 密码登录四场景统一响应和 dummy bcrypt；SMS/微信泛化失败，耗时边界沿根规则。
  不让码预检前的密码校验成为 oracle。找回密码不返回 token 或用户字段。
- 运行相关 auth/users/permissions 单测、定向 E2E 和涉及的 contract；
  说明真实第三方链是否实际验证。生产开关需要维护者另行授权。
