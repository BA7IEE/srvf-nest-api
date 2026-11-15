# authz — 授权解析边界

设计来源为 `docs/archive/reviews/org-position-scoped-authz-terminal-design-review.md`
与 `department-data-scope-v0.49.0-review.md`（同目录，后者覆盖副职/可见范围旧约定）。
Authz 解析 direct RoleBinding、职务 policy、分管三源 grant，判 scope 与域约束；
业务列表由各模块把 organizationIds 下推到自己的查询，不在此编排列表。

- **无 ref 必须复用 RbacService.judge**：SA 短路、当前 GLOBAL 码集、`.self` 缺资源拒绝均保持；
  scoped grant 无 ref 不覆盖。GLOBAL 任期共用 role-binding-validity，起止含边界，
  每 decision/请求现查 PostgreSQL，不恢复 Map/TTL/invalidate cache。
- 显式 tx 贯穿三源、角色含码、组织闭包与全部资源解析（含 attachment 递归）。
  未传仍用原客户端；本层不新建事务、不隐式取锁，也不代替业务锁后 User/Member 身份复验。
  getExplicitVisibleOrganizationScope 必传 tx，只认实际 grant，SA 不自动取得 GLOBAL；
  旧 getVisibleOrganizationScope 的管理员语义不变，不混用两入口。
- 副职只经 seed policy 推导 org-readonly/group-readonly；写码、read.sensitive、
  recruitment/team-join family 为零，不以头衔硬编码兜底。
  终审中枢由 POSITION_ASSIGNMENT RoleBinding 配置，不写 APD/部门字面量；
  分管角色用 SUPERVISOR_ROLE_CODE。
- assignment 非 ACTIVE、过任期或软删立即使其 binding 失权；
  policy.conditionJson 非 null 直接跳过，不把未实现条件当无条件允许。
- ActionConstraint 对 SA 同样生效：一级审核/退回与 settlement-first-review 禁提交人自审；
  终审/退回与 settlement-final-review 再禁一级和终审同人。
  settlement 复用 submitterUserId/reviewerUserId；ATTENDANCE_ALLOW_SAME_REVIEWER 仅配置兼容，
  true/false 都不解除该约束。未注册 action 无约束，sensitive_denied 仍是保留 reason。
- 资源解析失败 null→resource_not_found，不能降级成无 scope 放行。
  member 组织只取有效 PRIMARY（ACTIVE、startedAt<=now、endedAt=null、未删）；
  recruitment 无 org/owner；广播 notification 的 org=null；
  attachment 只委派 member/certificate/activity，其余 ownerType fail-closed。
  父资源软删不阻断既有解析，scope org ACTIVE 在 covers 判断。
- deny 归因顺序：resource_not_found → 约束否决 → inactive_org → expired_grant →
  out_of_[supervised_]scope → no_permission。失效 grant 只参与归因、不参与 allow。

## 诊断与状态提示

explain/explain-batch 是 AuthzService.explain 的纯消费者：先验证调用者权限，再加载目标。
deny 是200数据，资源不存在也是 reason；目标不存在/软删10001，DISABLED 目标可解释并原样返状态。
非法 type/action400；matchedGrant 内部ID可返回 ops-admin；不新增 audit/deny采样或第二份授权逻辑。
批量最多200，任一 user 不存在整批失败。action-state 只判断调用者本人，
allowed=explain∧已注册状态机只读校验，仅在既有 reason 闭集上加 state_forbidden。

AUTHZ_REASON_VALUES、GRANT_SOURCE_VALUES、EXPLAINABLE_RESOURCE_TYPES 与类型/resolver/contract
必须同步。状态机以零依赖纯类直列 providers，不 import 业务 Nest module；长出依赖须重新设计边界。
System effective-permissions 聚合三源，不改变 legacy rbac/me/permissions 语义。

改判权流程/covers/三源归集，验证 authz-rbac-equivalence、authz-three-source、
authz-resource-resolver、authz-explain 与 contract；改批量壳另跑 explain-batch/action-state。
不据历史消费者清单批迁调用方；用实际引用链确定受影响业务面。
