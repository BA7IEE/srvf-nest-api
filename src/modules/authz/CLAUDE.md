# authz — 本地铁律

> 全局规则读 [`/AGENTS.md`](../../../AGENTS.md);架构边界读 [`/docs/architecture-boundary.md`](../../../docs/architecture-boundary.md);权限地图读 [`/docs/ai-harness/RBAC_MAP.md`](../../../docs/ai-harness/RBAC_MAP.md)。**设计权威源 = T0 冻结评审稿 [`/docs/archive/reviews/org-position-scoped-authz-terminal-design-review.md`](../../../docs/archive/reviews/org-position-scoped-authz-terminal-design-review.md) §5.1/§5.2/§5.3**。本文件只记录在本目录工作时容易踩雷的本地铁律。

## Scope

- **统一判权大脑(终态 scoped-authz PR8,2026-07-02)**:`AuthzService.can/explain(user, action, ref?)` —— 三源 grant 归集(直接 RoleBinding ∪ 职务 policy 推导 ∪ 分管推导)+ `covers()` scope 覆盖判定 + `ActionConstraint` 域不变量否决
- **`ResourceResolverService`**:11 类资源归属解析(activity / attendance_sheet / attendance_record / activity_registration / member / member_profile / certificate / team_join_application / recruitment_application / notification / attachment〔按 ownerType 委派〕),输出统一 `ResolvedResource`;解析失败一律 null → deny(resource_not_found)fail-close
- **explain 诊断端点(终态 scoped-authz PR10,2026-07-02;冻结稿 §7.6)**:`AuthzController` — `POST admin/v1/authz/explain`(1 码 `authz.explain.decision` 绑 ops-admin;0 schema / 0 BizCode);薄编排 `AuthzExplainService` = 调用者 `rbac.can` → 目标用户加载 → **纯消费** `AuthzService.explain` 原样返 `{targetUser, decision}`,不改判权语义
- **批量诊断面(F3「C 组」,2026-07-04;v0.47.0 F2 additive)**:`POST admin/v1/authz/explain-batch`(扩 `AuthzController`;单条的批量壳 ≤200,**同一套 11 值 reason 枚举不扩值**,任一 userId 不存在 → 整请求 10001)+ `POST admin/v1/authz/action-state/batch`(**模块第二个 controller** `ActionStateController` + `ActionStateService`;判定对象 = 调用者本人,`allowed = authz.explain ∧ 已注册 action 的状态机只读校验`,reason ∈ 11 值 ∪ `state_forbidden` 入 OpenAPI;注册表 [`action-state-checks.ts`](action-state-checks.ts) 13 项 = attendance_sheet 7 + activity 3 + activity_registration 3);+2 码 `authz.{explain-batch,action-state}.decision` 绑 ops-admin;**两批量面都是 AuthzService.explain 的纯消费者,判权语义零新增**
- **D8 模块环规避(F3 落地方式)**:三个业务 StateMachine(attendance-sheet / activity / activity-registration)是零依赖纯决策类,以 **providers 直列**进 authz.module(TS 类 import,非 Nest module import)——本模块**不** import 任何业务 module(它们反向依赖本模块,import 即成环);若未来某状态机长出依赖,回 D8 mini-T0 重议,禁止顺手 import 业务 module
- **不负责**:全局判权入口仍是 [`/src/modules/permissions/`](../permissions/) 的 `RbacService`(业务面现全部走它);列表读 scope 下推(QueryService 过滤)按 architecture-boundary 决议 deferred,不在本模块

## Local facts

- **🔴 消费者接线进度(改本模块前先核对)**:**PR9(2026-07-02)起首个消费者 = attendances 终审两方法**(`finalApprove`/`finalReject` 走 `authz.explain` + deny→BizCode 映射〔22074/22075/30100,见 attendances/CLAUDE.md〕);**PR12(2026-07-02)起 activities / activity-registrations / attendances 三模块(participation 首批,共 24 处调用位点)全量切 `authz.can`/`authz.explain`**(ref 矩阵见各模块 CLAUDE.md;当前在期 GLOBAL 行为不变,未来/过期 GLOBAL 在 rbac/authz 两引擎均失效;scoped 持有者树内获新点动作能力);members / certificates / content / notifications 等其余业务面仍走 rbac.can,逐面迁移留后续批。**本模块行为调整自 PR9 起影响现网终审面,PR12 起影响 participation 三模块管理端全部动作**;等价矩阵行为锁必须始终成立
- **🔴 无 ref 退化 = 行为锁(goal 决断①)**:`authz.can(user, action)`〔无 ref〕**逐字复用 `RbacService.judge`** —— 与 `rbac.can` 逐项一致(SUPER_ADMIN 短路 / GLOBAL 码集走缓存 / `.self` 无 resource fail-close);scoped grant 无 ref 一律不 covers。等价矩阵锁在 `test/e2e/authz-rbac-equivalence.e2e-spec.ts`,改判权流程必跑
- **GLOBAL 任期真值单一来源(2026-07-13 第二档安全收口)**:`AuthzService` 与 `RbacService` 共用 [`../permissions/role-binding-validity.ts`](../permissions/role-binding-validity.ts);`startedAt<=now` 且 `endedAt=null|>=now` 才有效,边界时刻有效。未来/过期/在期三族在 `authz-rbac-equivalence` 具名 e2e 中同时断言 `rbac.can` / `getEffectiveRoles` / `authz.explain`,禁止两套谓词再次漂移
- **🔴 R5 安全红线(冻结稿 §5.2)**:副职(vice-captain / dept-deputy / deputy-group-leader)不自动推导管理角色 —— 由数据保证(seed 副职零 policy 行),3b 职务推导对副职天然零产出;**代码里不写副职特判,也绝不为"方便"给 3b 加头衔兜底**。全局/全树管辖只能来自显式 RoleBinding(3a)或分管(3c)
- **BD-2 终审中枢不 hardcode**:终审身份只认 `RoleBinding(principalType=POSITION_ASSIGNMENT, …)` 配置行;本模块禁止出现任何 "APD" / 部门字面量门控。分管监督角色锚点 = 常量 `SUPERVISOR_ROLE_CODE`('org-supervisor',BD-3)
- **POSITION_ASSIGNMENT 主体绑定随任职失效**:底层 assignment 非 ACTIVE / 出任期 / 软删 → 该绑定不产权(换届即失权,无需清绑定行)
- **conditionJson 保守跳过**:`OrganizationPositionRolePolicy.conditionJson` 非 null 的行本刀不评估、直接跳过(fail-close 不越权;seed 全 null)。首个真实条件需求出现时再落评估器,禁止"忽略条件当无条件"的过渡实现
- **ActionConstraint 对 SUPER_ADMIN 也生效**(域不变量非权限):注册表只有 `attendance.final-approve.sheet` 两条(自审禁止〔永不可配〕 + 同人终审禁止〔默认禁;PR9 起经 `ActionConstraintContext` 从 app.config 注入 env `ATTENDANCE_ALLOW_SAME_REVIEWER`,严格 === 'true' 才放开,PR8 代码常量已移除〕);**final-reject 不在注册表 = 无自审/同人约束(e2e 锁不对称语义,扩注册面是行为变更须 goal 授权)**——安全依据(review #484 §6 known-dup 补充论证,2026-07-03):驳回自己提交的单据不存在自肥式利益冲突方向(不像批准那样有直接得利动机),`test/e2e/attendances-final-review-authz.e2e-spec.ts` 已有具名用例锁定该不对称行为;未注册 action 零约束;`sensitive_denied` 是保留 reason(敏感分级由 §4.2 独立权限码承载,不在此双轨)
- **resolver 口径**:member 的归属组织 = active PRIMARY membership;recruitment_application 恒无 org/owner(D-R-1);notification 广播态 org=null(多组织「任一覆盖」covers 留消费面迁移时扩展);attachment 仅委派 member/certificate/activity 三类 ownerType,其余(content-\*)null fail-close;链上父资源软删不阻断解析,scope org 的 ACTIVE 闸门在 `covers()`
- **性能口径(goal 决断④)**:三源每 decision 现查、无新缓存层;`RbacService.getRoleIdsWithPermission` 是 PR8 additive(批量角色含码,RolePermission roleId 索引);优化留口 = 角色→码集合 TTL 缓存,做之前先看真实 QPS
- **deny reason 归因优先级**:resource*not_found > 约束否决 >(covers 失败后)inactive_org > expired_grant > out_of*[supervised_]scope > no_permission;失效 grant 只参与归因**绝不参与 allow**
- **explain 端点契约(PR10 拍板)**:**deny 是数据不是错误** —— 入参合法即 200 返 decision,`resource_not_found` 亦是 decision reason;仅输入错误走异常(目标用户不存在/已软删 → 10001;type/action 白名单不过 → 通用 400,BizCode +0);DISABLED 目标可 explain(status 原样返,决断③);matchedGrant 内部 id 原样返 ops-admin 面(不脱敏);**无 audit**(决断④;deny 采样 = 冻结稿 §10.6 可选项,做须 goal)。`authz.dto.ts` 的 `AUTHZ_REASON_VALUES`(11 值)/`GRANT_SOURCE_VALUES`/`EXPLAINABLE_RESOURCE_TYPES`(= resolver 11 类)是 OpenAPI 契约锁:改 `authz.types` 联合或 resolver 支持面时**必须同步**(`satisfies` 编译锁 + authz-explain e2e Record 完备锁双向兜底)

## Risk points (不要做)

- ❌ **不**给 `covers()` 的 GLOBAL 之外任何 scope 在「无 ref」时放行(等价矩阵行为锁会红)
- ❌ **不**在 3b 给副职加任何推导兜底 / 不评估却放行非 null conditionJson(两者都是越权面)
- ❌ **不**把 `RbacService.can/judge` 的调用改成绕过(无 ref 路径必须持续复用,防两套全局语义漂移)
- ❌ **不**在本模块写 "APD" / 具体部门 / 具体职务的字面量判权门控(BD-2;配置行决定一切)
- ❌ **不**接新的业务消费者(逐面迁移 = PR12 各自 goal)/ 不做列表 scope 下推
- ❌ **不**给 explain 端点加 audit / deny 采样(§10.6 可选项须 goal)/ **不**把 explain 的 deny 改成抛错(deny 是 200 数据 = PR10 决断②)/ **不**在 explain 薄编排里叠加自己的判权逻辑(它必须始终是 `AuthzService.explain` 的纯消费面)
- ❌ **不**引入新缓存层 / 不把 `RbacCacheService`(per-user 权限点缓存)错用成 per-role 缓存
- ❌ **不**让 ActionConstraint 豁免 SUPER_ADMIN(它是数据完整性不变量;场景 4「SA 亦拒自审」是拍板)
- ❌ **不**把 resolver 的 fail-close(null → resource_not_found)改成"解析失败按无 scope 资源放行"
- ❌ **不**在 legacy `.self` 后缀语义上创新:无 ref fail-close(镜像 rbac),带 ref 属主硬门;attachments 现网 `.self` 路径到 PR12 前仍走 rbac.can,不迁

## Validation

- `pnpm lint` + `pnpm typecheck`
- `pnpm test` — `action-constraints.spec.ts`(约束注册表)
- `pnpm test:e2e` — **四件套必跑**:`authz-rbac-equivalence`(🔴 等价矩阵行为锁)/ `authz-three-source`(队长甲/副队长乙/BD-2 终审+自审/R5 副职/失效族/SELF)/ `authz-resource-resolver`(11 类逐类 + 软删 fail-close + attachment 委派)/ `authz-explain`(PR10 端点:五 allow 形态 + 四 deny-as-data + 10001/400/30100 + reason 枚举完备锁);改 F3 批量面另跑 `authz-explain-batch` + `authz-action-state`(壳行为 + state_forbidden 矩阵 + 枚举完备锁)
- 改判权流程 / covers / 三源归集 → 四件套全跑 + `pnpm test:contract`(端点不变式:路由 306 恒定〔F3「C 组」起;此前 292→F1 300→F3 306〕,authz 面 = explain + explain-batch + action-state/batch 三路)
