# 权限事实入口与既定边界

不再维护生成的权限码/角色/controller 对照表。事实来源为
`src/modules/permissions/permission-catalog.ts`、`prisma/seed.ts`、路由访问声明及 service 判权。
`pnpm check:rbac` 保留代码不变量校验。旧对照表可从 `harness-v3-final` 标签读取。

## 判权

Role enum 是身份层；授权事实为 RbacRole/Permission/RolePermission/RoleBinding。
旧 RbacService 只读 USER+GLOBAL；AuthzService 聚合 direct binding、职务 policy 与分管，
并按资源/scope 判定。两种入口有意并存，不因文档精简合并语义。

管理/System 入口已登录，service 显式判权；App 默认 self-scope，不以 role 短路 scope。
不新增活跃 `@Roles`，不移除最后 SUPER_ADMIN/ops-admin 保护、防枚举或 `assertCanManageUser`。
终审自审 22074 对 SA 也拒绝；一级同人默认拒绝 22075，沿现有配置。
biz-admin 不持有终审两码；任职绑定或 SA 的既有授权路径保持。

## 保留决策

- BD-2：终审中枢由 POSITION_ASSIGNMENT 的 RoleBinding 表达，不硬编码个人或组织。
- BD-3：`activity.read.record` / `attendance-record.read.record` 两候选码已决定不做；
  活动详情沿既有 login-only 语义，考勤明细通过 `attendance.read.sheet` 的 scoped ref。
- System `me/permissions` 返回 raw code，App `me/capabilities` 返回能力，两者不可互替。
- 既有 Mixed Controller 与字典同文件双 controller 为存量，不扩展范式。
- 权限拒绝使用 40100/40300、30100 段或既有业务护栏码，不自创 token 类 100xx。

改 enum、权限 seed、角色绑定或鉴权行为须在明确授权内。
业务细则见 permissions 当地规则、`docs/reference/roles-admin-protection.md` 和相关 E2E。
