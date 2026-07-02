# authz — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);权限地图读 [`/docs/ai-harness/RBAC_MAP.md`](../../../docs/ai-harness/RBAC_MAP.md)。**设计权威源 = T0 冻结评审稿 [`/docs/reviews/org-position-scoped-authz-terminal-design-review.md`](../../../docs/reviews/org-position-scoped-authz-terminal-design-review.md) §5.1/§5.2/§5.3**。本文件只记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **统一判权大脑(终态 scoped-authz PR8,2026-07-02)**:`AuthzService.can/explain(user, action, ref?)` —— 三源 grant 归集(直接 RoleBinding ∪ 职务 policy 推导 ∪ 分管推导)+ `covers()` scope 覆盖判定 + `ActionConstraint` 域不变量否决
- **`ResourceResolverService`**:11 类资源归属解析(activity / attendance_sheet / attendance_record / activity_registration / member / member_profile / certificate / team_join_application / recruitment_application / notification / attachment〔按 ownerType 委派〕),输出统一 `ResolvedResource`;解析失败一律 null → deny(resource_not_found)fail-close
- **0 controller / 0 端点 / 0 权限码 / 0 schema / 0 BizCode**:纯 service 模块;explain 端点是 PR10
- **不负责**:全局判权入口仍是 [`/src/modules/permissions/`](../permissions/) 的 `RbacService`(业务面现全部走它);列表读 scope 下推(QueryService 过滤)按 architecture-boundary 决议 deferred,不在本模块

## Local facts

- **🔴 消费者接线进度(改本模块前先核对)**:PR8 落地时**全仓零业务调用点**(仅模块自身 + 测试);第一个消费者 = PR9 考勤终审;逐面迁移 = PR12。在消费者接上之前,本模块任何行为调整都不影响现网,但**等价矩阵行为锁必须始终成立**
- **🔴 无 ref 退化 = 行为锁(goal 决断①)**:`authz.can(user, action)`〔无 ref〕**逐字复用 `RbacService.judge`** —— 与 `rbac.can` 逐项一致(SUPER_ADMIN 短路 / GLOBAL 码集走缓存 / `.self` 无 resource fail-close);scoped grant 无 ref 一律不 covers。等价矩阵锁在 `test/e2e/authz-rbac-equivalence.e2e-spec.ts`,改判权流程必跑
- **🔴 R5 安全红线(冻结稿 §5.2)**:副职(vice-captain / dept-deputy / deputy-group-leader)不自动推导管理角色 —— 由数据保证(seed 副职零 policy 行),3b 职务推导对副职天然零产出;**代码里不写副职特判,也绝不为"方便"给 3b 加头衔兜底**。全局/全树管辖只能来自显式 RoleBinding(3a)或分管(3c)
- **BD-2 终审中枢不 hardcode**:终审身份只认 `RoleBinding(principalType=POSITION_ASSIGNMENT, …)` 配置行;本模块禁止出现任何 "APD" / 部门字面量门控。分管监督角色锚点 = 常量 `SUPERVISOR_ROLE_CODE`('org-supervisor',BD-3)
- **POSITION_ASSIGNMENT 主体绑定随任职失效**:底层 assignment 非 ACTIVE / 出任期 / 软删 → 该绑定不产权(换届即失权,无需清绑定行)
- **conditionJson 保守跳过**:`OrganizationPositionRolePolicy.conditionJson` 非 null 的行本刀不评估、直接跳过(fail-close 不越权;seed 全 null)。首个真实条件需求出现时再落评估器,禁止"忽略条件当无条件"的过渡实现
- **ActionConstraint 对 SUPER_ADMIN 也生效**(域不变量非权限):注册表只有 `attendance.final-approve.sheet` 两条(自审禁止 + 同人终审禁止〔默认禁,常量 `ATTENDANCE_FINAL_APPROVE_ALLOW_SAME_REVIEWER` 可配〕);未注册 action 零约束;`sensitive_denied` 是保留 reason(敏感分级由 §4.2 独立权限码承载,不在此双轨)
- **resolver 口径**:member 的归属组织 = active PRIMARY membership;recruitment_application 恒无 org/owner(D-R-1);notification 广播态 org=null(多组织「任一覆盖」covers 留消费面迁移时扩展);attachment 仅委派 member/certificate/activity 三类 ownerType,其余(content-*)null fail-close;链上父资源软删不阻断解析,scope org 的 ACTIVE 闸门在 `covers()`
- **性能口径(goal 决断④)**:三源每 decision 现查、无新缓存层;`RbacService.getRoleIdsWithPermission` 是 PR8 additive(批量角色含码,RolePermission roleId 索引);优化留口 = 角色→码集合 TTL 缓存,做之前先看真实 QPS
- **deny reason 归因优先级**:resource_not_found > 约束否决 >(covers 失败后)inactive_org > expired_grant > out_of_[supervised_]scope > no_permission;失效 grant 只参与归因**绝不参与 allow**

## Risk points (不要做)

- ❌ **不**给 `covers()` 的 GLOBAL 之外任何 scope 在「无 ref」时放行(等价矩阵行为锁会红)
- ❌ **不**在 3b 给副职加任何推导兜底 / 不评估却放行非 null conditionJson(两者都是越权面)
- ❌ **不**把 `RbacService.can/judge` 的调用改成绕过(无 ref 路径必须持续复用,防两套全局语义漂移)
- ❌ **不**在本模块写 "APD" / 具体部门 / 具体职务的字面量判权门控(BD-2;配置行决定一切)
- ❌ **不**建 authz explain HTTP 端点(PR10 goal)/ 不接任何业务消费者(PR9+ 各自 goal)/ 不做列表 scope 下推
- ❌ **不**引入新缓存层 / 不把 `RbacCacheService`(per-user 权限点缓存)错用成 per-role 缓存
- ❌ **不**让 ActionConstraint 豁免 SUPER_ADMIN(它是数据完整性不变量;场景 4「SA 亦拒自审」是拍板)
- ❌ **不**把 resolver 的 fail-close(null → resource_not_found)改成"解析失败按无 scope 资源放行"
- ❌ **不**在 legacy `.self` 后缀语义上创新:无 ref fail-close(镜像 rbac),带 ref 属主硬门;attachments 现网 `.self` 路径到 PR12 前仍走 rbac.can,不迁

## Validation

- `pnpm lint` + `pnpm typecheck`
- `pnpm test` — `action-constraints.spec.ts`(约束注册表)
- `pnpm test:e2e` — **三件套必跑**:`authz-rbac-equivalence`(🔴 等价矩阵行为锁)/ `authz-three-source`(崔广庆/黄勇/BD-2 终审+自审/R5 副职/失效族/SELF)/ `authz-resource-resolver`(11 类逐类 + 软删 fail-close + attachment 委派)
- 改判权流程 / covers / 三源归集 → 三件套全跑 + `pnpm test:contract`(0 端点不变式:路由 289 恒定)
