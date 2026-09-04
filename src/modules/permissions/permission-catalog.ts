/**
 * 权限目录 —— seed 事实闭包内**权限定义**的单一事实源(P1-32 PR 1)。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 这个文件是什么
 *
 * 系统拥有的每一条权限码,连同它的 module / action / resourceType / description,
 * 都定义在这里。本刀(P1-32 PR 1)把它们从两处旧位置**原样搬来**,一个字面量都没改:
 *   · `prisma/seed.ts` 里的 58 个 `*_PERMISSION_SEED` 数组与权限码常量;
 *   · `src/modules/permissions/rbac-seed-facts.ts`(该文件已删除,内容并入本文件)。
 *
 * 搬家前后的四条等式已实测成立(比集合不比计数):权限码全集 / Permission 表行 /
 * 内建角色集合 / RolePermission (role, permission) 对,全部逐元素一致。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 这个文件**不是**什么:它不装角色映射
 *
 * 「哪个内建角色持有哪些码」属于 seed 的角色装配,仍在 `prisma/seed.ts`:
 * `OPS_ADMIN_PERMISSION_SEED` / `BIZ_ADMIN_PERMISSION_SEED` / `ORG_ADMIN_PERMISSION_SEED`
 * 与各 `*_PERMISSION_CODES` 清单、各排除集,以及 `RBAC_SEED_CATALOG` 本身。
 * 分界线是「定义一条码」与「把码发给谁」——后者是策略,会随组织调整而变;
 * 前者是系统能力的清单,PR 2 起要往上挂中文名 / 分类 / 风险 / 授予策略等元数据。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 🔴 权限码书写契约:只能是 `code: '<literal>'` 或 `*_CODE = '<literal>'`
 *
 * 禁止模板串、拼接、变量或任何计算构造。三个解析器按这个形态读本文件:
 * `docs-counts` 的 typed-AST 提取器(权限码全集真源)、`check-rbac-map` 的镜像正则
 * (第二口径交叉校验)、`generate-rbac-map` 的生成器正则。写成别的形态,
 * 全集会**静默缩水**——而缩水后的全集恒是各桶并集的子集,
 * `check-permission-catalog-closure` 的方向 (a) 反而全绿。改形态必须同步三处解析器并重新拍板。
 *
 * ──────────────────────────────────────────────────────────────────────────
 * 本文件在 seed 事实闭包内(`SEED_FACTS_CLOSURE`)
 *
 * 闭包 = `prisma/seed.ts` + 本文件,三份逐字副本分居
 * `scripts/docs-counts.ts` / `scripts/generate-rbac-map.ts` / `scripts/check-rbac-map.ts`,
 * 三处都调 `assertSeedFactsClosure()` 交叉核验 ⇒ 漏改一处即抛错,不会静默。
 * **新增权限数组时**:在本文件加数组,并在 `prisma/seed.ts` 的
 * `RBAC_SEED_CATALOG.permissions` 里加一个桶(不要往 `bootstrap` 之类的现有桶里塞),
 * 否则「各桶并集 == 权限码全集」当场红并点名。
 *
 * 方向恒为 seed → src:本文件不得 import `prisma/seed.ts`(那是循环依赖,
 * 且会把整个 seed 程序拖进 API 进程)。运行时要判「某码是不是系统拥有的」,
 * 读 [`seed-permission-codes.ts`](seed-permission-codes.ts) —— 那份清单靠三段链钉死在本文件上。
 */

// V2.x C-6 RBAC 实施 PR #8(2026-05-14):14 条 rbac.* 权限点全集(沿 D7 v1.1 §10.2)。
// 跳过 4 条 attachment.*(沿用户拍板方案 A;留 C-7 attachments)。
// 注:code 必须满足 PR #2 实装的 Permission code 正则 `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$`
// (固定 3 段;首段小写字母开头);本表全部 14 条均符合。
export interface RbacPermissionSeed {
  readonly code: string;
  readonly module: string;
  readonly action: string;
  readonly resourceType: string;
  readonly description: string;
}

// Integration Foundation v1 PR2(P1-30;规格书 §35):ServicePrincipal 控制面权限 6 码。
// 全部绑 ops-admin;ServicePrincipal 自身永远不能持有(§15.3 第 7 条 —— 控制面禁授)。
// delegation-grant.* 3 码是 PR5 的(§36),本刀不 seed。
// Integration Foundation v1 PR5(规格书 §36):Delegation 控制面 3 码。绑 ops-admin。
export const DELEGATION_GRANT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'delegation-grant.create.record',
    module: 'delegation-grant',
    action: 'create',
    resourceType: 'record',
    description: '创建委托(允许某 SP 在指定权限/范围/期限内代表指定 User)',
  },
  {
    code: 'delegation-grant.read.record',
    module: 'delegation-grant',
    action: 'read',
    resourceType: 'record',
    description: '查看委托列表与详情',
  },
  {
    code: 'delegation-grant.revoke.record',
    module: 'delegation-grant',
    action: 'revoke',
    resourceType: 'record',
    description: '撤销委托',
  },
];

export const SERVICE_PRINCIPAL_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'service-principal.create.record',
    module: 'service-principal',
    action: 'create',
    resourceType: 'record',
    description: '创建服务主体(机器身份)',
  },
  {
    code: 'service-principal.read.record',
    module: 'service-principal',
    action: 'read',
    resourceType: 'record',
    description: '查看服务主体列表与详情',
  },
  {
    code: 'service-principal.update.record',
    module: 'service-principal',
    action: 'update',
    resourceType: 'record',
    description: '修改服务主体名称/描述/属主组织',
  },
  {
    code: 'service-principal.update.status',
    module: 'service-principal',
    action: 'update',
    resourceType: 'status',
    description: '启用/停用服务主体',
  },
  {
    code: 'service-principal.create.credential',
    module: 'service-principal',
    action: 'create',
    resourceType: 'credential',
    description: '为服务主体新建凭证(原始 Secret 只返回一次)',
  },
  {
    code: 'service-principal.revoke.credential',
    module: 'service-principal',
    action: 'revoke',
    resourceType: 'credential',
    description: '撤销服务主体凭证',
  },
];

export const RBAC_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'rbac.permission.read',
    module: 'rbac',
    action: 'read',
    resourceType: 'permission',
    description: '查看权限点',
  },
  {
    code: 'rbac.permission.create',
    module: 'rbac',
    action: 'create',
    resourceType: 'permission',
    description: '创建权限点',
  },
  {
    code: 'rbac.permission.update',
    module: 'rbac',
    action: 'update',
    resourceType: 'permission',
    description: '更新权限点',
  },
  {
    code: 'rbac.permission.delete',
    module: 'rbac',
    action: 'delete',
    resourceType: 'permission',
    description: '删除权限点',
  },
  {
    code: 'rbac.role.read',
    module: 'rbac',
    action: 'read',
    resourceType: 'role',
    description: '查看角色',
  },
  {
    code: 'rbac.role.create',
    module: 'rbac',
    action: 'create',
    resourceType: 'role',
    description: '创建角色',
  },
  {
    code: 'rbac.role.update',
    module: 'rbac',
    action: 'update',
    resourceType: 'role',
    description: '更新角色',
  },
  {
    code: 'rbac.role.delete',
    module: 'rbac',
    action: 'delete',
    resourceType: 'role',
    description: '软删角色',
  },
  {
    code: 'rbac.role-permission.create',
    module: 'rbac',
    action: 'create',
    resourceType: 'role-permission',
    description: '角色加权限点',
  },
  {
    code: 'rbac.role-permission.delete',
    module: 'rbac',
    action: 'delete',
    resourceType: 'role-permission',
    description: '撤角色权限点',
  },
  {
    code: 'rbac.user-role.read',
    module: 'rbac',
    action: 'read',
    resourceType: 'user-role',
    description: '查看用户角色',
  },
  {
    code: 'rbac.user-role.create',
    module: 'rbac',
    action: 'create',
    resourceType: 'user-role',
    description: '分配用户角色',
  },
  {
    code: 'rbac.user-role.delete',
    module: 'rbac',
    action: 'delete',
    resourceType: 'user-role',
    description: '撤用户角色',
  },
  {
    code: 'rbac.config.reload',
    module: 'rbac',
    action: 'reload',
    resourceType: 'config',
    description: '触发 RBAC 缓存失效',
  },
];

// P0-F PR-2A(2026-05-18):配置类接口 RBAC 接入第一批(19 条)。
// 沿评审稿 [`docs/first-release-p0f-pr2-config-rbac-review.md`](../docs/first-release-p0f-pr2-config-rbac-review.md)
// §4.2 + 用户拍板 D1=A / D3=A / D4=A。
//
// **code 命名规则**:3 段 kebab-case `module.action.resource_type`;沿 D7-RBAC v1.2 正则
// `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/`(3-4 段;PR-2A 全 3 段无 scope)。
//
// **D3=A**:dict.delete.type / dict.delete.item / org.delete.node 放宽给 ops-admin
// (v1 原 @Roles(SUPER_ADMIN) 单角色;sub-protection 仍在 service 内:DICT_TYPE_IN_USE /
// ORGANIZATION_HAS_CHILDREN / LAST_ROOT_ORGANIZATION_PROTECTED 等不变)。
//
// **D4=A**:member-department 采用 set.current / clear.current 自定义动词
// (沿 PR-1 rbac.config.reload 范式;业务语义清晰优先)。

export const DICT_READ_ITEM_CODE = 'dict.read.item';

// dict.* 8 条(dict_types 4 + dict_items 4)
export const DICT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'dict.read.type',
    module: 'dict',
    action: 'read',
    resourceType: 'type',
    description: '查看字典类型(列表 / 详情)',
  },
  {
    code: 'dict.create.type',
    module: 'dict',
    action: 'create',
    resourceType: 'type',
    description: '创建字典类型',
  },
  {
    code: 'dict.update.type',
    module: 'dict',
    action: 'update',
    resourceType: 'type',
    description: '更新字典类型(含启停)',
  },
  {
    code: 'dict.delete.type',
    module: 'dict',
    action: 'delete',
    resourceType: 'type',
    description: '软删字典类型(D3=A 放宽至 ops-admin)',
  },
  {
    code: DICT_READ_ITEM_CODE,
    module: 'dict',
    action: 'read',
    resourceType: 'item',
    description: '查看字典项(列表 / 树形 / 详情)',
  },
  {
    code: 'dict.create.item',
    module: 'dict',
    action: 'create',
    resourceType: 'item',
    description: '创建字典项',
  },
  {
    code: 'dict.update.item',
    module: 'dict',
    action: 'update',
    resourceType: 'item',
    description: '更新字典项(含启停)',
  },
  {
    code: 'dict.delete.item',
    module: 'dict',
    action: 'delete',
    resourceType: 'item',
    description: '软删字典项(D3=A 放宽至 ops-admin)',
  },
];

// org.* 4 条(organizations R/C/U/D)
export const ORG_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'org.read.node',
    module: 'org',
    action: 'read',
    resourceType: 'node',
    description: '查看组织节点(列表 / 树形 / 详情)',
  },
  {
    code: 'org.create.node',
    module: 'org',
    action: 'create',
    resourceType: 'node',
    description: '创建组织节点',
  },
  {
    code: 'org.update.node',
    module: 'org',
    action: 'update',
    resourceType: 'node',
    description: '更新组织节点(含启停)',
  },
  {
    code: 'org.delete.node',
    module: 'org',
    action: 'delete',
    resourceType: 'node',
    description: '软删组织节点(D3=A 放宽至 ops-admin)',
  },
  {
    // 终态 scoped-authz PR1(2026-07-01 goal「组织基座」;冻结稿 §8.3/§11 PR1):reparent 重挂父级。
    // 沿 org.*.node 现绑(绑 ops-admin);service 层 rbac.can('org.move.node'),0 @Roles。
    code: 'org.move.node',
    module: 'org',
    action: 'move',
    resourceType: 'node',
    description: '重挂组织节点父级(reparent;环 / 受限位置守卫)',
  },
];

// member-department.* 3 条(member-departments read / set / clear;D4=A)
export const MEMBER_DEPARTMENT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'member-department.read.current',
    module: 'member-department',
    action: 'read',
    resourceType: 'current',
    description: '查队员当前部门归属',
  },
  {
    code: 'member-department.set.current',
    module: 'member-department',
    action: 'set',
    resourceType: 'current',
    description: '幂等设置队员正式部门',
  },
  {
    code: 'member-department.clear.current',
    module: 'member-department',
    action: 'clear',
    resourceType: 'current',
    description: '解除队员当前部门归属',
  },
];

// membership.* 4 条(终态 scoped-authz PR2;冻结稿 §4.3 / §7.1;member-department.* 的升级面,旧 3 码保留 deprecated)。
// 端点映射(§7.1):GET list→list / POST 新增+PATCH 改 共用 set / DELETE 结束→end。
// read.record 按 §4.3 seed 并绑 ops-admin(→168/68),本刀无端点承接(为未来 GET :id 预留)= 刻意预埋孤码
//(docs:rbacmap:check 记 WARN 不记 FAIL;不违反 DoD「0-FAIL」)。全 4 码绑 ops-admin(沿 member-department.* 现绑)。
export const MEMBERSHIP_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'membership.list.record',
    module: 'membership',
    action: 'list',
    resourceType: 'record',
    description: '列出队员全部组织归属(主/兼/临时/支援 + 任期)',
  },
  {
    code: 'membership.read.record',
    module: 'membership',
    action: 'read',
    resourceType: 'record',
    description: '读取单条组织归属(预留;本刀无端点承接)',
  },
  {
    code: 'membership.set.record',
    module: 'membership',
    action: 'set',
    resourceType: 'record',
    description: '新增 / 修改组织归属(类型 / 任期)',
  },
  {
    code: 'membership.end.record',
    module: 'membership',
    action: 'end',
    resourceType: 'record',
    description: '结束组织归属',
  },
];

// contribution.* 4 条(contribution-rules R/C/U/D)
export const CONTRIBUTION_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'contribution.read.rule',
    module: 'contribution',
    action: 'read',
    resourceType: 'rule',
    description: '查看贡献值规则(列表 / 详情)',
  },
  {
    code: 'contribution.create.rule',
    module: 'contribution',
    action: 'create',
    resourceType: 'rule',
    description: '创建贡献值规则',
  },
  {
    code: 'contribution.update.rule',
    module: 'contribution',
    action: 'update',
    resourceType: 'rule',
    description: '更新贡献值规则',
  },
  {
    code: 'contribution.delete.rule',
    module: 'contribution',
    action: 'delete',
    resourceType: 'rule',
    description: '软删贡献值规则',
  },
];

// position.* 4 + position-rule.* 4(终态 scoped-authz PR3;冻结稿 §4.3 / §7.2;职务定义 + 职务规则
// 纯配置面 CRUD;沿 dict / org / contribution 配置码现绑 ops-admin)。**Position/Rule 绝不进判权路径**。
export const POSITION_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'position.read.definition',
    module: 'position',
    action: 'read',
    resourceType: 'definition',
    description: '查看职务定义(列表 / 详情)',
  },
  {
    code: 'position.create.definition',
    module: 'position',
    action: 'create',
    resourceType: 'definition',
    description: '创建职务定义',
  },
  {
    code: 'position.update.definition',
    module: 'position',
    action: 'update',
    resourceType: 'definition',
    description: '更新职务定义(含启停)',
  },
  {
    code: 'position.delete.definition',
    module: 'position',
    action: 'delete',
    resourceType: 'definition',
    description: '软删职务定义(被职务规则引用时禁删)',
  },
  {
    code: 'position-rule.read.record',
    module: 'position-rule',
    action: 'read',
    resourceType: 'record',
    description: '查看职务规则(按 nodeTypeCode 过滤)',
  },
  {
    code: 'position-rule.create.record',
    module: 'position-rule',
    action: 'create',
    resourceType: 'record',
    description: '创建职务规则(某类组织可设哪些职务)',
  },
  {
    code: 'position-rule.update.record',
    module: 'position-rule',
    action: 'update',
    resourceType: 'record',
    description: '更新职务规则(含启停)',
  },
  {
    code: 'position-rule.delete.record',
    module: 'position-rule',
    action: 'delete',
    resourceType: 'record',
    description: '软删职务规则',
  },
];

// position-assignment.* 4(终态 scoped-authz PR4「任职」;冻结稿 §4.3 / §7.3;任职管理 + 历史;
// 沿组织归属域配置/管理码现绑 ops-admin)。**任职 = 数据 + 任命校验,绝不进判权路径**(判权是 PR8)。
// 双轴读(组织轴列 + 队员轴列)共用 position-assignment.read.record;历史链单独 read.history。
export const POSITION_ASSIGNMENT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'position-assignment.read.record',
    module: 'position-assignment',
    action: 'read',
    resourceType: 'record',
    description: '查看任职(组织轴在任列表 / 队员轴任职含历史)',
  },
  {
    code: 'position-assignment.create.record',
    module: 'position-assignment',
    action: 'create',
    resourceType: 'record',
    description: '任命(校验职务适配 / 单人独占 / 兼任 / 归属要求 / 任期)',
  },
  {
    code: 'position-assignment.revoke.record',
    module: 'position-assignment',
    action: 'revoke',
    resourceType: 'record',
    description: '撤销任职(status=REVOKED + 撤销人 + endedAt)',
  },
  {
    code: 'position-assignment.read.history',
    module: 'position-assignment',
    action: 'read',
    resourceType: 'history',
    description: '查看任职变更/历史链',
  },
];

// supervision-assignment.* 4(终态 scoped-authz PR5「分管」;冻结稿 §4.3 / §7.4;分管管理 + 分管范围/被谁分管查询;
// 沿组织归属域配置/管理码现绑 ops-admin)。**分管 = 数据 + 展示,绝不进判权路径**(判权是 PR8)。
// 三读端点(列 / 某人分管范围 / 某组织被谁分管)共用 supervision-assignment.read.record,无孤码。
export const SUPERVISION_ASSIGNMENT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'supervision-assignment.read.record',
    module: 'supervision-assignment',
    action: 'read',
    resourceType: 'record',
    description: '查看分管(在任列表 / 某人分管范围 / 某组织被谁分管)',
  },
  {
    code: 'supervision-assignment.create.record',
    module: 'supervision-assignment',
    action: 'create',
    resourceType: 'record',
    description: '建分管(supervisor × org × scopeMode + 任期;与职务正交,不要求持职务)',
  },
  {
    code: 'supervision-assignment.update.record',
    module: 'supervision-assignment',
    action: 'update',
    resourceType: 'record',
    description: '改分管(scopeMode / 任期 / note)',
  },
  {
    code: 'supervision-assignment.revoke.record',
    module: 'supervision-assignment',
    action: 'revoke',
    resourceType: 'record',
    description: '撤销分管(status=REVOKED + 撤销人 + endedAt)',
  },
];

// role-binding.* 4(终态 scoped-authz PR6「RoleBinding」;冻结稿 §4.3 / §7.5;带 scope 的角色绑定管理面;
// 沿组织归属域配置/管理码现绑 ops-admin)。**scoped 绑定入库即止,RbacService 只读 GLOBAL、绝不判 scoped**(判权是 PR8)。
export const ROLE_BINDING_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'role-binding.read.record',
    module: 'role-binding',
    action: 'read',
    resourceType: 'record',
    description: '查看角色绑定(principal × role × scope × 任期;含 scoped 各型)',
  },
  {
    code: 'role-binding.create.record',
    module: 'role-binding',
    action: 'create',
    resourceType: 'record',
    description:
      '建角色绑定(principal × role × scope + 任期;GLOBAL/ORGANIZATION/TREE/ACTIVITY/RESOURCE/SELF)',
  },
  {
    code: 'role-binding.update.record',
    module: 'role-binding',
    action: 'update',
    resourceType: 'record',
    description: '改角色绑定(任期 / 状态 / note)',
  },
  {
    code: 'role-binding.delete.record',
    module: 'role-binding',
    action: 'delete',
    resourceType: 'record',
    description: '软删角色绑定(status=ENDED + endedAt + deletedAt)',
  },
];

// 终态 scoped-authz PR10「authz/explain 端点」(2026-07-02;冻结稿 §7.6):权限解释诊断码(1 条)。
// POST admin/v1/authz/explain 的调用者判权码(goal 决断①:R 模式 rbac.can 单轨;绑 ops-admin,非 reserved);
// deny 是数据不是错误 —— 入参合法即 200 返 decision(goal 决断②),端点无 audit(决断④)。
// F3「C 组」(2026-07-04;冻结路线图 admin-api-fe-integration-roadmap.md §4 C2/C3 + §6.2 D8):
// +2 诊断码(explain-batch 批量壳 / action-state 批量业务态闸;均绑 ops-admin,镜像单条 explain;1→3 条)。
export const AUTHZ_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'authz.explain.decision',
    module: 'authz',
    action: 'explain',
    resourceType: 'decision',
    description:
      '权限解释(诊断读):目标用户对 action(+可选资源)的 allow/deny + reason + matchedGrant',
  },
  {
    code: 'authz.explain-batch.decision',
    module: 'authz',
    action: 'explain-batch',
    resourceType: 'decision',
    description:
      '批量权限解释(诊断读,≤200):逐条 allow/deny + reason(同单条 11 值枚举)+ matchedGrant',
  },
  {
    code: 'authz.action-state.decision',
    module: 'authz',
    action: 'action-state',
    resourceType: 'decision',
    description:
      '批量业务态闸(诊断读,≤200):调用者对 action×资源 的 allowed(判权 ∧ 状态机只读)+ reason',
  },
];

// 终态 scoped-authz PR11「公告导入」(2026-07-02;冻结稿 §8.4 / §11 PR11):公告任职/分管/组节点
// preview/execute 两段式导入工具判权码(2 条,均绑 ops-admin,非 reserved)。preview 零写入诊断、
// execute 幂等落库,两者都只做锚定解析 + 编排,复用 organizations/position-assignments/
// supervision-assignments 既有 create() 校验与 audit(dryRun 沙箱哨兵驱动零写入)。
export const ANNOUNCEMENT_IMPORT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'announcement-import.preview.record',
    module: 'announcement-import',
    action: 'preview',
    resourceType: 'record',
    description: '公告导入预览(零写入):逐行回显 ok/blocked/already-exists/needs-manual + 原因',
  },
  {
    code: 'announcement-import.execute.record',
    module: 'announcement-import',
    action: 'execute',
    resourceType: 'record',
    description: '公告导入执行:逐行落库(组节点/任职/分管),幂等可重跑,单行失败不影响其它行',
  },
];

// F1「A 组:搜索 & 选择器 + resolve-labels」(2026-07-04;冻结路线图
// admin-api-fe-integration-roadmap.md §4 A7 / §6.2 D5):批量 id→label 诊断读码(1 条,
// 绑 ops-admin,非 reserved)。入口码门控"能否调用本工具",各 type 实际可解析范围仍由
// 各资源自身既有 .read.* 码 per-type 过滤(D2),两层权限互不替代。
export const META_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'meta.resolve.label',
    module: 'meta',
    action: 'resolve',
    resourceType: 'label',
    description: '批量 id→label 跨资源解析(per-type 读权限过滤 + 无权/不存在静默省略)',
  },
];

// PR-2A 聚合(44 条:dict 8 + org 5〔终态 scoped-authz PR1 +org.move.node〕+ member-department 3 +
// ===== 证书标准库 PR-2(冻结稿 §16.1 / §16.2)=====
//
// Standard / Policy 是**全局主数据配置面**(§16.4:走 `RbacService.can()`,不是
// Certificate 实例的 scoped Authz),所以两族码跟 `dict.*` / `position.*` /
// `role-binding.*` 一样进 `PR_2A_PERMISSION_SEED` → 全绑 ops-admin。
//
// 另外把两条 **read** 码也列进 `BIZ_PERMISSION_SEED`(§16.4 表格:biz-admin
// Standard read = 是 / Policy read = 是;写码一律不给)。同一码出现在两张 seed 列表里
// 是**结构性必需**而非笔误:ops-admin 只从 `OPS_ADMIN_PERMISSION_SEED` 取绑定、
// biz-admin 只从 `BIZ_ADMIN_PERMISSION_SEED` 取,两边都要的码就必须两边都在
// (Permission 行本身是 upsert,重复列出不会建两行)。
// biz-admin 拿到读码后 org-admin 按既有派生规则自动继承 —— 这是需要的:
// org-admin 持 certificate.create/verify,建证时要靠 Standard options 下拉。
export const CERTIFICATE_STANDARD_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'certificate-standard.read.record',
    module: 'certificate-standard',
    action: 'read',
    resourceType: 'record',
    description: '查看通用证书标准(列表 / 详情 / options 建证与审核下拉)',
  },
  {
    code: 'certificate-standard.create.record',
    module: 'certificate-standard',
    action: 'create',
    resourceType: 'record',
    description: '新建通用证书标准(初始 DRAFT;code 创建后不可改不可复用)',
  },
  {
    code: 'certificate-standard.update.record',
    module: 'certificate-standard',
    action: 'update',
    resourceType: 'record',
    description: '修改通用证书标准(ACTIVE 后仅名称 / 说明 / 排序 / 状态可改)',
  },
  {
    code: 'certificate-standard.delete.record',
    module: 'certificate-standard',
    action: 'delete',
    resourceType: 'record',
    description: '软删通用证书标准(被 Policy / Claim / Certificate 引用时拒绝)',
  },
];

export const CERTIFICATE_RECOGNITION_POLICY_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'certificate-recognition-policy.read.record',
    module: 'certificate-recognition-policy',
    action: 'read',
    resourceType: 'record',
    description: '查看队内证书认定规则(版本历史 + 当前生效摘要 + 认可机构)',
  },
  {
    code: 'certificate-recognition-policy.create.record',
    module: 'certificate-recognition-policy',
    action: 'create',
    resourceType: 'record',
    description: '新建认定规则版本(DRAFT;issuer 集合随 DRAFT 整体提交)',
  },
  {
    code: 'certificate-recognition-policy.update.record',
    module: 'certificate-recognition-policy',
    action: 'update',
    resourceType: 'record',
    description: '修改 DRAFT 认定规则 / 激活或退役(生效与退役后规则永久只读)',
  },
  {
    code: 'certificate-recognition-policy.delete.record',
    module: 'certificate-recognition-policy',
    action: 'delete',
    resourceType: 'record',
    description: '软删 DRAFT 认定规则(ACTIVE / RETIRED 不可删)',
  },
];

// membership 4〔终态 scoped-authz PR2〕+ contribution 4 + position 4 + position-rule 4〔终态 scoped-authz PR3〕
// + position-assignment 4〔终态 scoped-authz PR4〕+ supervision-assignment 4〔终态 scoped-authz PR5〕
// + role-binding 4〔终态 scoped-authz PR6〕)。
// member-department 与 membership 同"组织归属"域,membership 为 member-department 的升级面(旧 3 码保留 deprecated);
// position / position-rule 为职务定义配置面;position-assignment 为任职管理面;supervision-assignment 为分管管理面;
// role-binding 为带 scope 的角色绑定管理面(scoped 入库即止,RbacService 只读 GLOBAL,判权是 PR8)
//(冻结稿 §4.3;全绑 ops-admin,沿配置/管理码现绑)。
export const PR_2A_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  ...DICT_PERMISSION_SEED,
  ...ORG_PERMISSION_SEED,
  ...MEMBER_DEPARTMENT_PERMISSION_SEED,
  ...MEMBERSHIP_PERMISSION_SEED,
  ...CONTRIBUTION_PERMISSION_SEED,
  ...POSITION_PERMISSION_SEED,
  ...POSITION_ASSIGNMENT_PERMISSION_SEED,
  ...SUPERVISION_ASSIGNMENT_PERMISSION_SEED,
  ...ROLE_BINDING_PERMISSION_SEED,
  // 证书标准库 PR-2:证书标准 4 + 认定规则 4 = 8,配置面全绑 ops-admin(同 dict / position)。
  ...CERTIFICATE_STANDARD_PERMISSION_SEED,
  ...CERTIFICATE_RECOGNITION_POLICY_PERMISSION_SEED,
];

// P0-F PR-2B(2026-05-18):配置类接口 RBAC 接入第二批(15 条)。
// 沿评审稿 [`docs/first-release-p0f-pr2-config-rbac-review.md`](../docs/first-release-p0f-pr2-config-rbac-review.md)
// §4.3 + 用户拍板 D1=A / D2=A。
//
// **code 命名规则**:3 段 kebab-case `module.action.resource_type`;沿 D7-RBAC v1.2 正则
// `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/`(3-4 段;PR-2B 全 3 段无 scope)。
//
// **D2=A 凭证收紧**:`storage-setting.reset.credentials` 仅 SUPER_ADMIN 短路通过;
// 该 permission **加入 Permission 全集 upsert**(供未来真实需求触发解锁),
// 但**不绑** `ops-admin`(沿 §5.2 + §6.2 ops-admin 最终绑定矩阵)。

// attachment-config.* 12 条(type 4 + mime 4 + size-limit 4)
export const ATTACHMENT_CONFIG_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'attachment-config.read.type',
    module: 'attachment-config',
    action: 'read',
    resourceType: 'type',
    description: '查看附件类型配置(列表 / 详情)',
  },
  {
    code: 'attachment-config.create.type',
    module: 'attachment-config',
    action: 'create',
    resourceType: 'type',
    description: '创建附件类型配置',
  },
  {
    code: 'attachment-config.update.type',
    module: 'attachment-config',
    action: 'update',
    resourceType: 'type',
    description: '更新附件类型配置(含启停)',
  },
  {
    code: 'attachment-config.delete.type',
    module: 'attachment-config',
    action: 'delete',
    resourceType: 'type',
    description: '软删附件类型配置',
  },
  {
    code: 'attachment-config.read.mime',
    module: 'attachment-config',
    action: 'read',
    resourceType: 'mime',
    description: '查看附件 MIME 配置(列表 / 详情)',
  },
  {
    code: 'attachment-config.create.mime',
    module: 'attachment-config',
    action: 'create',
    resourceType: 'mime',
    description: '创建附件 MIME 配置',
  },
  {
    code: 'attachment-config.update.mime',
    module: 'attachment-config',
    action: 'update',
    resourceType: 'mime',
    description: '更新附件 MIME 配置(含启停)',
  },
  {
    code: 'attachment-config.delete.mime',
    module: 'attachment-config',
    action: 'delete',
    resourceType: 'mime',
    description: '软删附件 MIME 配置',
  },
  {
    code: 'attachment-config.read.size-limit',
    module: 'attachment-config',
    action: 'read',
    resourceType: 'size-limit',
    description: '查看附件尺寸限制配置(列表 / 详情)',
  },
  {
    code: 'attachment-config.create.size-limit',
    module: 'attachment-config',
    action: 'create',
    resourceType: 'size-limit',
    description: '创建附件尺寸限制配置',
  },
  {
    code: 'attachment-config.update.size-limit',
    module: 'attachment-config',
    action: 'update',
    resourceType: 'size-limit',
    description: '更新附件尺寸限制配置',
  },
  {
    code: 'attachment-config.delete.size-limit',
    module: 'attachment-config',
    action: 'delete',
    resourceType: 'size-limit',
    description: '软删附件尺寸限制配置',
  },
];

// storage-setting.* 3 条(read / update singleton + reset credentials)
export const STORAGE_SETTING_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'storage-setting.read.singleton',
    module: 'storage-setting',
    action: 'read',
    resourceType: 'singleton',
    description: '读 Storage Settings singleton row',
  },
  {
    code: 'storage-setting.update.singleton',
    module: 'storage-setting',
    action: 'update',
    resourceType: 'singleton',
    description: '更新 Storage Settings(upsert;不含凭证)',
  },
  {
    code: 'storage-setting.reset.credentials',
    module: 'storage-setting',
    action: 'reset',
    resourceType: 'credentials',
    description: '重置 COS SecretId / SecretKey(D2=A 仅 SUPER_ADMIN;不绑 ops-admin)',
  },
];

// PR-2B 聚合(15 条:attachment-config 12 + storage-setting 3)
// 注意:全部 15 条 upsert 进 Permission 表;但 ops-admin 仅绑 14 条
//(`storage-setting.reset.credentials` 沿 D2=A 跳过)。
export const PR_2B_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  ...ATTACHMENT_CONFIG_PERMISSION_SEED,
  ...STORAGE_SETTING_PERMISSION_SEED,
];

// D2=A:`storage-setting.reset.credentials` 不绑 ops-admin(凭证仅 SUPER_ADMIN 短路)
export const PR_2B_RESET_CREDENTIALS_CODE = 'storage-setting.reset.credentials';

// =========================================================================
// P0-F PR-3B(2026-05-18):users 模块 RBAC 接入新增 7 条 user.* permission。
// 沿评审稿 docs/first-release-p0f-pr3-users-rbac-review.md §4.2 + §6.2 + D1=A / D2=B / D3=A。
//
// 端点 → permission 映射(沿评审稿 §4 / §6 / §8):
//   GET    /api/users              → user.read.account
//   POST   /api/users              → user.create.account
//   GET    /api/users/:id          → user.read.account(list / findOne 共享)
//   PATCH  /api/users/:id          → user.update.account
//   PUT    /api/users/:id/password → user.reset.password
//   PATCH  /api/users/:id/role     → user.update.role(D1=A:不绑 ops-admin,仅 SA 短路)
//   PATCH  /api/users/:id/status   → user.update.status
//   DELETE /api/users/:id          → user.delete.account
//
// ops-admin 绑定(D1=A / D2=B / D3=A):6 条(过滤 user.update.role)。
// service 内 6 项业务护栏全保留:canViewUser / canManageUser / canCreateRole /
// canChangeRole / assertNotSelf / assertNotLastSuperAdmin(沿评审稿 §8.3)。
// =========================================================================

// D1=A:`user.update.role` 不绑 ops-admin(角色修改仅 SUPER_ADMIN 短路;
// service 层 canChangeRole 仍要求 actor=SA + 永禁升 SA)
export const PR_3B_USER_UPDATE_ROLE_CODE = 'user.update.role';

export const USER_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'user.read.account',
    module: 'user',
    action: 'read',
    resourceType: 'account',
    description: '查看用户列表与详情(list + findOne 共享;service 内 canViewUser 收窄范围)',
  },
  {
    code: 'user.create.account',
    module: 'user',
    action: 'create',
    resourceType: 'account',
    description: '创建用户(service 内 canCreateRole 永禁创建 SUPER_ADMIN)',
  },
  {
    code: 'user.update.account',
    module: 'user',
    action: 'update',
    resourceType: 'account',
    description: '修改用户资料(email / nickname / avatarKey;service 内 assertCanManageUser)',
  },
  {
    code: 'user.reset.password',
    module: 'user',
    action: 'reset',
    resourceType: 'password',
    description:
      '管理员重置用户密码(D2=B 绑 ops-admin;service 内 assertCanManageUser + 撤 refresh)',
  },
  {
    code: PR_3B_USER_UPDATE_ROLE_CODE,
    module: 'user',
    action: 'update',
    resourceType: 'role',
    description:
      '修改用户角色(D1=A:仅 SUPER_ADMIN 短路;不绑 ops-admin;service 内 canChangeRole 永禁升 SA + assertNotSelf + assertNotLastSuperAdmin)',
  },
  {
    code: 'user.update.status',
    module: 'user',
    action: 'update',
    resourceType: 'status',
    description:
      '启用 / 禁用用户(service 内 assertCanManageUser + assertNotSelf(DISABLED) + assertNotLastSuperAdmin + 撤 refresh)',
  },
  {
    code: 'user.delete.account',
    module: 'user',
    action: 'delete',
    resourceType: 'account',
    description:
      '软删除用户(service 内 assertNotSelf + assertCanManageUser + assertNotLastSuperAdmin + 撤 refresh)',
  },
];

// =========================================================================
// P0-F PR-4B(2026-05-18):audit-logs 模块 RBAC 接入新增 1 条 audit-log.* permission。
// 沿评审稿 docs/first-release-p0f-pr4-audit-logs-rbac-review.md §4.2 + §6.2 + D1=A / D2=B / D3=A / D4=A / D5=A。
//
// 端点 → permission 映射(沿评审稿 §4 / §7):
//   GET /api/v2/audit-logs        → audit-log.read.entry(list)
//   GET /api/v2/audit-logs/:id    → audit-log.read.entry(findOne;list / findOne 共享 read,D4=A)
//
// ops-admin 绑定(D2=B):整条加入,不过滤(沿评审稿 §5.2 推荐;数据范围 service 层兜底)。
// service 内现有数据范围 + assertCanReadAuditLog + 14101 越级码全部保留(沿评审稿 §8.3)。
// =========================================================================

export const AUDIT_LOG_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'audit-log.read.entry',
    module: 'audit-log',
    action: 'read',
    resourceType: 'entry',
    description:
      '查看审计记录(list + findOne 共享;service 内 list ADMIN where 注入 + detail assertCanReadAuditLog + 14101 越级码全部保留)',
  },
];

// =========================================================================
// SMS 基础设施 T2(2026-06-10):+5 条权限码(76→81;冻结评审稿
// docs/archive/reviews/sms-verification-infra-review.md §3.4 / E-3)。
//
// 端点 → permission 映射(评审稿 §3.2):
//   GET    /api/system/v1/sms-settings                    → sms-setting.read.singleton
//   PATCH  /api/system/v1/sms-settings                    → sms-setting.update.singleton
//   POST   /api/system/v1/sms-settings/reset-credentials  → sms-setting.reset.credentials
//   GET    /api/system/v1/sms-send-logs                   → sms-send-log.read.list
//   DELETE /api/admin/v1/users/:id/phone(T3 实装)        → user.phone.clear
//
// ops-admin 绑定:4 条;`sms-setting.reset.credentials` **不绑**(镜像 storage D2=A,
// 仅 SUPER_ADMIN 短路)。`user.phone.clear` code 字符串按 goal 原文(module=user /
// action=clear / resourceType=phone 仅元数据描述);其端点 T3 落地,T2 期间为孤码
// (rbacmap 检查预期 WARN,非 FAIL)。
// =========================================================================

// 镜像 PR_2B_RESET_CREDENTIALS_CODE:凭证 reset 不绑 ops-admin
export const SMS_RESET_CREDENTIALS_CODE = 'sms-setting.reset.credentials';

export const SMS_INFRA_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'sms-setting.read.singleton',
    module: 'sms-setting',
    action: 'read',
    resourceType: 'singleton',
    description: '读 SMS Settings singleton row',
  },
  {
    code: 'sms-setting.update.singleton',
    module: 'sms-setting',
    action: 'update',
    resourceType: 'singleton',
    description: '更新 SMS Settings(upsert;不含凭证;production-like 禁 DEV_STUB)',
  },
  {
    code: SMS_RESET_CREDENTIALS_CODE,
    module: 'sms-setting',
    action: 'reset',
    resourceType: 'credentials',
    description:
      '重置腾讯云 SMS SecretId / SecretKey(镜像 storage D2=A 仅 SUPER_ADMIN;不绑 ops-admin)',
  },
  {
    code: 'sms-send-log.read.list',
    module: 'sms-send-log',
    action: 'read',
    resourceType: 'list',
    description: '分页查看短信发送日志(响应手机号一律掩码)',
  },
  {
    code: 'user.phone.clear',
    module: 'user',
    action: 'clear',
    resourceType: 'phone',
    description:
      '管理员清除用户绑定手机号(T3 实装端点;service 内 rbac.can + assertCanManageUser;幂等)',
  },
];

// =========================================================================
// 微信小程序登录 T2(2026-06-12):+4 条权限码(117→121;冻结评审稿
// docs/archive/reviews/wechat-mini-login-review.md §3.4 / E-22)。
//
// 端点 → permission 映射(评审稿 §3.2):
//   GET    /api/system/v1/wechat-settings                    → wechat-setting.read.singleton
//   PATCH  /api/system/v1/wechat-settings                    → wechat-setting.update.singleton
//   POST   /api/system/v1/wechat-settings/reset-credentials  → wechat-setting.reset.credentials
//   DELETE /api/admin/v1/users/:id/wechat(T3 实装)          → user.wechat.clear
//
// ops-admin 绑定:3 条;`wechat-setting.reset.credentials` **不绑**(镜像 storage/sms D2=A,
// 仅 SUPER_ADMIN 短路)。`user.wechat.clear` 端点 T3 落地,T2 期间为孤码
// (rbacmap 检查预期 WARN,非 FAIL;镜像 user.phone.clear 先例)。
// =========================================================================

// 镜像 SMS_RESET_CREDENTIALS_CODE:凭证 reset 不绑 ops-admin
export const WECHAT_RESET_CREDENTIALS_CODE = 'wechat-setting.reset.credentials';

export const WECHAT_INFRA_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'wechat-setting.read.singleton',
    module: 'wechat-setting',
    action: 'read',
    resourceType: 'singleton',
    description: '读 WeChat Settings singleton row',
  },
  {
    code: 'wechat-setting.update.singleton',
    module: 'wechat-setting',
    action: 'update',
    resourceType: 'singleton',
    description: '更新 WeChat Settings(upsert;不含凭证;production-like 禁 DEV_STUB)',
  },
  {
    code: WECHAT_RESET_CREDENTIALS_CODE,
    module: 'wechat-setting',
    action: 'reset',
    resourceType: 'credentials',
    description: '重置微信小程序 AppSecret(镜像 storage/sms D2=A 仅 SUPER_ADMIN;不绑 ops-admin)',
  },
  {
    code: 'user.wechat.clear',
    module: 'user',
    action: 'clear',
    resourceType: 'wechat',
    description:
      '管理员清除用户绑定微信 openid(T3 实装端点;service 内 rbac.can + assertCanManageUser;幂等)',
  },
];

// =========================================================================
// 企业微信接入 T2(2026-08-01):+4 条权限码(222→226;冻结评审稿
// docs/archive/reviews/wecom-integration-t0-terminal-review.md §11.1)。
//
// 端点 → permission 映射(冻结稿 §6.1):
//   GET    /api/system/v1/wecom-settings                    → wecom-setting.read.singleton
//   PATCH  /api/system/v1/wecom-settings                    → wecom-setting.update.singleton
//   POST   /api/system/v1/wecom-settings/reset-credentials  → wecom-setting.reset.credentials
//   POST   /api/system/v1/wecom-settings/test-connection    → wecom-setting.test.connection
//
// ops-admin 绑定:3 条;`wecom-setting.reset.credentials` **不绑**(冻结稿 §11.1,
// 镜像 storage/sms/wechat D2=A,仅 SUPER_ADMIN 短路)。
//
// 企业微信接入 T3(2026-08-02):+1 条 `user.wecom.clear`(226→227),连端点一起落 ——
// DELETE /api/admin/v1/users/:id/wecom,**0 孤码**。
// ⚠️ T2 这里原写「它的端点在 T4」,是笔误:冻结稿 §13 的 T3 清单明写
// 「Admin clear;Permission `user.wecom.clear`」,T4 只做 User 生命周期联动
// (softDelete / reopen 撤销身份)。以冻结稿 §13 为准。
// ops-admin 绑定:整条加入(镜像 user.wechat.clear / user.phone.clear 同族,归系统/账号面)。
// =========================================================================

// 镜像 WECHAT_RESET_CREDENTIALS_CODE:凭证 reset 不绑 ops-admin
export const WECOM_RESET_CREDENTIALS_CODE = 'wecom-setting.reset.credentials';

export const WECOM_INFRA_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'wecom-setting.read.singleton',
    module: 'wecom-setting',
    action: 'read',
    resourceType: 'singleton',
    description: '读 WeCom Settings singleton row(不回显凭证;corpId 仅掩码)',
  },
  {
    code: 'wecom-setting.update.singleton',
    module: 'wecom-setting',
    action: 'update',
    resourceType: 'singleton',
    description:
      '更新 WeCom Settings(upsert;不含凭证;production-like 禁 DEV_STUB;corpId 仅 active identity=0 时可改)',
  },
  {
    code: 'wecom-setting.test.connection',
    module: 'wecom-setting',
    action: 'test',
    resourceType: 'connection',
    description: '企业微信连接诊断(只读;只返计数,不返任何成员/部门/标签 ID;不写 audit)',
  },
  {
    code: WECOM_RESET_CREDENTIALS_CODE,
    module: 'wecom-setting',
    action: 'reset',
    resourceType: 'credentials',
    description:
      '重置企业微信 CorpSecret(镜像 storage/sms/wechat D2=A 仅 SUPER_ADMIN;不绑 ops-admin)',
  },
  {
    code: 'user.wecom.clear',
    module: 'user',
    action: 'clear',
    resourceType: 'wecom',
    description:
      '管理员清除用户企业微信身份(解除绑定的唯一显式路径,D-WC-9;service 内 rbac.can + assertCanManageUser;幂等)',
  },
];

// =========================================================================
// 招新一期 · 实名核验通道 T1(2026-06-18):+3 条 settings 权限码(冻结评审稿
// docs/archive/reviews/recruitment-phase1-review.md §3.4 / E-R-19)。
//
// 端点 → permission 映射(评审稿 §3.2;端点 T2 实装):
//   GET    /api/system/v1/realname-settings                    → realname-setting.read.singleton
//   PATCH  /api/system/v1/realname-settings                    → realname-setting.update.singleton
//   POST   /api/system/v1/realname-settings/reset-credentials  → realname-setting.reset.credentials
//
// ops-admin 绑定:2 条;`realname-setting.reset.credentials` **不绑**(镜像 storage/sms/wechat
// D2=A,仅 SUPER_ADMIN 短路)。3 码端点 T2 实装,T1 期间为孤码(rbacmap F 项 WARN 预期,
// 非 FAIL;镜像保险 T1 / wechat T2 先例)。
// =========================================================================

// 镜像 WECHAT_RESET_CREDENTIALS_CODE:凭证 reset 不绑 ops-admin
export const REALNAME_RESET_CREDENTIALS_CODE = 'realname-setting.reset.credentials';

export const REALNAME_INFRA_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'realname-setting.read.singleton',
    module: 'realname-setting',
    action: 'read',
    resourceType: 'singleton',
    description: '读 Realname Verification Settings singleton row',
  },
  {
    code: 'realname-setting.update.singleton',
    module: 'realname-setting',
    action: 'update',
    resourceType: 'singleton',
    description: '更新实名核验设置(upsert;不含凭证;production-like 禁 DEV_STUB)',
  },
  {
    code: REALNAME_RESET_CREDENTIALS_CODE,
    module: 'realname-setting',
    action: 'reset',
    resourceType: 'credentials',
    description:
      '重置腾讯云实名核验 secretId/secretKey(镜像 storage/sms/wechat D2=A 仅 SUPER_ADMIN;不绑 ops-admin)',
  },
];

// =========================================================================
// 队员账号闭环 v1(MVP)(2026-07-07):+1 条权限码(94→95;goal「队员账号闭环 v1(MVP)」)。
//
// 端点 → permission 映射:
//   POST admin/v1/members/:id/account → member.grant.account
//
// 归属代决(goal §工程代决):账号铸造 = 系统/账号面,绑 **ops-admin**(与 user.*.account
// 族一致),**不**绑 biz-admin(维护者可后续单独把该码也授予 biz-admin,仅一行绑定、不改代码)。
// 整条绑 ops-admin,无过滤;实装即用 0 孤码。
//
// 队员账号闭环 v2(2026-07-07;冻结评审稿 docs/archive/reviews/member-account-loop-v2-review.md
// §3.2 / D-9):+1 条权限码(95→96)。端点映射:
//   POST admin/v1/members/:id/account/bind   → member.bind.account
//   POST admin/v1/members/:id/account/unbind → member.bind.account(与 bind 共用同一码)
//   POST admin/v1/members/:id/account/reopen → member.grant.account(复用)
//   PATCH admin/v1/members/:id/account/status → user.update.status(复用,见 USER_PERMISSION_SEED)
// 归属沿 member.grant.account 同族(账号铸造/链管理归系统面),绑 ops-admin,不绑 biz-admin。
// =========================================================================

export const MEMBER_ACCOUNT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'member.grant.account',
    module: 'member',
    action: 'grant',
    resourceType: 'account',
    description: '给已存在队员开通登录账号(手机验证码登录,不设密码;绑 ops-admin,不绑 biz-admin)',
  },
  {
    code: 'member.bind.account',
    module: 'member',
    action: 'bind',
    resourceType: 'account',
    description: '绑定既有悬空账号到队员 / 解绑(队员账号闭环 v2;绑 ops-admin,不绑 biz-admin)',
  },
];

// 企业微信 T6-1(2026-08-03;第二轮外部评审 SHOULD-FIX 3 收口):系统定向通知的企业微信 replay
// 运维入口判权码 1 条。归属**运维面**(沿 wecom-setting.* / user.wecom.clear 同族)⇒ 整条绑 ops-admin、
// **不**绑 biz-admin —— 故进 ALL_PERMISSION_SEED + OPS_ADMIN_PERMISSION_SEED,而**不**进
// BIZ_PERMISSION_SEED(notification.* 其余 6 条在那边,是业务面;这一条不是)。
// 端点 POST admin/v1/notifications/:id/replay-wecom 同刀落地 ⇒ 0 孤码。
export const NOTIFICATION_REPLAY_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'notification.replay.wecom',
    module: 'notification',
    action: 'replay',
    resourceType: 'wecom',
    description:
      '重发系统定向通知的企业微信投递(建新 child + 新 eventKey;默认只放行上次是 rate-limited / provider-contract-error 的,越界需显式 overrideReason;绑 ops-admin,不绑 biz-admin)',
  },
];

// Permission 全集(用于 step 1 upsert;14 rbac.* + 32 PR-2A + 15 PR-2B + 7 PR-3B + 1 PR-4B + 5 SMS + 4 WECHAT + 3 REALNAME = 81 条
// + F1「A 组」1 META + 队员账号闭环 v1+v2 2 MEMBER-ACCOUNT + 企业微信 T6-1 1 NOTIFICATION-REPLAY
// = 见 ALL_PERMISSION_SEED.length 运行时校验为准)
export const ALL_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  ...RBAC_PERMISSION_SEED,
  ...PR_2A_PERMISSION_SEED,
  ...PR_2B_PERMISSION_SEED,
  ...USER_PERMISSION_SEED,
  ...AUDIT_LOG_PERMISSION_SEED,
  ...SMS_INFRA_PERMISSION_SEED,
  ...WECHAT_INFRA_PERMISSION_SEED,
  ...WECOM_INFRA_PERMISSION_SEED,
  ...REALNAME_INFRA_PERMISSION_SEED,
  ...AUTHZ_PERMISSION_SEED,
  ...ANNOUNCEMENT_IMPORT_PERMISSION_SEED,
  ...META_PERMISSION_SEED,
  ...MEMBER_ACCOUNT_PERMISSION_SEED,
  ...NOTIFICATION_REPLAY_PERMISSION_SEED,
  ...SERVICE_PRINCIPAL_PERMISSION_SEED,
  ...DELEGATION_GRANT_PERMISSION_SEED,
];

// V2.x C-7 attachments 实施 PR #6a(2026-05-15):20 条 attachment.* 权限点全集
// (沿 D7-attachments v1.0 §6.1 + Q11 v1.0 锁清单 + 用户 PR #6a 拍板)。
//
// **code 格式**:沿 D7-RBAC v1.2 修订正则 `/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,3}$/`
// (3-4 段;scope 可选;PR #70 实装);本表 4 段 16 条 + 3 段 4 条 = 20 条全部合法。
//
// **scope 语义**:`.self` / `.other` 后缀触发 RbacService.judge() 的 ownership 判定
// (`action.endsWith('.self')` 触发 `checkOwnership(user, resource)`);3 段 activity 无 scope。
//
// **不实装的项**(沿用户 PR #6a 拍板):
// - ADMIN 内置角色(Q12 v1.0 沿用挂起;不创建)
// - 自动给 user 绑定 member 角色(Q2 v1.0:仍走 POST /api/v2/users/:userId/roles 显式)
// - .other 给 member 角色(member 仅持 .self + activity.view)
// - activity.upload / .update / .delete 给 member 角色(member 仅 view activity)
export const ATTACHMENT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  // ============ member 8 条(4 段) ============
  {
    code: 'attachment.upload.member.self',
    module: 'attachment',
    action: 'upload',
    resourceType: 'member',
    description: '上传本人的身份证类附件',
  },
  {
    code: 'attachment.upload.member.other',
    module: 'attachment',
    action: 'upload',
    resourceType: 'member',
    description: '上传他人的身份证类附件',
  },
  {
    code: 'attachment.view.member.self',
    module: 'attachment',
    action: 'view',
    resourceType: 'member',
    description: '查看本人身份证类附件',
  },
  {
    code: 'attachment.view.member.other',
    module: 'attachment',
    action: 'view',
    resourceType: 'member',
    description: '查看他人身份证类附件',
  },
  {
    code: 'attachment.update.member.self',
    module: 'attachment',
    action: 'update',
    resourceType: 'member',
    description: '更新本人身份证类附件元数据',
  },
  {
    code: 'attachment.update.member.other',
    module: 'attachment',
    action: 'update',
    resourceType: 'member',
    description: '更新他人身份证类附件元数据',
  },
  {
    code: 'attachment.delete.member.self',
    module: 'attachment',
    action: 'delete',
    resourceType: 'member',
    description: '删除本人身份证类附件',
  },
  {
    code: 'attachment.delete.member.other',
    module: 'attachment',
    action: 'delete',
    resourceType: 'member',
    description: '删除他人身份证类附件',
  },
  // ============ certificate 8 条(4 段) ============
  {
    code: 'attachment.upload.certificate.self',
    module: 'attachment',
    action: 'upload',
    resourceType: 'certificate',
    description: '上传本人的证书类附件',
  },
  {
    code: 'attachment.upload.certificate.other',
    module: 'attachment',
    action: 'upload',
    resourceType: 'certificate',
    description: '上传他人证书类附件',
  },
  {
    code: 'attachment.view.certificate.self',
    module: 'attachment',
    action: 'view',
    resourceType: 'certificate',
    description: '查看本人证书附件',
  },
  {
    code: 'attachment.view.certificate.other',
    module: 'attachment',
    action: 'view',
    resourceType: 'certificate',
    description: '查看他人证书附件',
  },
  {
    code: 'attachment.update.certificate.self',
    module: 'attachment',
    action: 'update',
    resourceType: 'certificate',
    description: '更新本人证书附件元数据',
  },
  {
    code: 'attachment.update.certificate.other',
    module: 'attachment',
    action: 'update',
    resourceType: 'certificate',
    description: '更新他人证书附件元数据',
  },
  {
    code: 'attachment.delete.certificate.self',
    module: 'attachment',
    action: 'delete',
    resourceType: 'certificate',
    description: '删除本人证书附件',
  },
  {
    code: 'attachment.delete.certificate.other',
    module: 'attachment',
    action: 'delete',
    resourceType: 'certificate',
    description: '删除他人证书附件',
  },
  // ============ activity 4 条(3 段;粗粒度,无 self/other;沿 D7 v1.0 Q10) ============
  {
    code: 'attachment.upload.activity',
    module: 'attachment',
    action: 'upload',
    resourceType: 'activity',
    description: '上传活动现场照 / 封面',
  },
  {
    code: 'attachment.view.activity',
    module: 'attachment',
    action: 'view',
    resourceType: 'activity',
    description: '查看活动现场照 / 封面',
  },
  {
    code: 'attachment.update.activity',
    module: 'attachment',
    action: 'update',
    resourceType: 'activity',
    description: '更新活动附件元数据',
  },
  {
    code: 'attachment.delete.activity',
    module: 'attachment',
    action: 'delete',
    resourceType: 'activity',
    description: '删除活动附件',
  },
];

// Slow-4 业务面 RBAC 接入(2026-06-11,goal「权限双轨收口」T1;
// 冻结评审稿 docs/archive/reviews/slow4-rbac-business-face-review.md §4 / §5):
// 43 条业务面权限码 + `biz-admin` 内置角色(Slow-3 决议:ADMIN 内置角色边界 = 全量业务权限;
// 2026-06-13 保险模块 +7；D-INSURANCE v3 PR2 再 +1 review.record：
// team-insurance-policy 6 + member-insurance 2,全绑,
// 冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.4 / E-6)。
//
// **不绑项**(评审稿 §6):
// - `member.delete.record`:members DELETE 今天仅 SUPER_ADMIN(@Roles(SUPER_ADMIN)),
//   码进 Permission 表但不绑 biz-admin(镜像 PR-3 D1=A `user.update.role` 收紧范式);
// - attachment 存量 20 码:attachments 已是 R 模式,未持 RBAC 角色的 ADMIN 今天即 30100;
//   绑入 = ADMIN 凭空获权,违零行为漂移 → 一条不绑。
//
// **幂等不变式**(评审稿 D-S4-7):每个 `role=ADMIN && deletedAt=null` 用户持有 biz-admin,
// 每次 seed 自动补挂 + 强校验(镜像 seedRbac「至少 1 个 ops-admin」强校验范式);
// 含 DISABLED(禁用→重启用周期内无需重跑 seed 即保持零漂移);
// 运行时新建的 ADMIN 不自动持有,走既有 POST /api/system/v1/users/:userId/roles 显式授予。

export const MEMBER_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'member.read.record',
    module: 'member',
    action: 'read',
    resourceType: 'record',
    description: '查看队员(列表 + 详情共用 read,沿 PR-4B D4=A)',
  },
  {
    code: 'member.create.record',
    module: 'member',
    action: 'create',
    resourceType: 'record',
    description: '创建队员(memberNo 全局唯一不复用)',
  },
  {
    code: 'member.update.record',
    module: 'member',
    action: 'update',
    resourceType: 'record',
    description: '更新队员(displayName / gradeCode;禁改 memberNo / status)',
  },
  {
    code: 'member.update.status',
    module: 'member',
    action: 'update',
    resourceType: 'status',
    description: '切换队员 status(ACTIVE↔INACTIVE;镜像 user.update.status 命名)',
  },
  {
    // 第七轮评审 R7-A-01(2026-08-21):队员身份主档订正入口。
    //
    // 此前 memberNo / memberSinceDate / memberOriginCode 录错**只能直接改库** ——
    // 实测全仓 member delegate 8 处写调用里,这三个字段只出现在 3 处 create,零订正路径。
    //
    // 持有人与 `member.create.record` 一致(biz-admin + org-admin;维护者 2026-08-21 拍板):
    // 能建档就该能订正建档时录错的事实 —— 与创建同权是最小且自洽的口径。本码**不**入
    // BIZ_ADMIN_EXCLUDED_CODES / ORG_ADMIN_EXCLUDED_CODES,靠既有派生链自动挂上;
    // 副职只读投影结构上取不到它(isReadonlyProjectionCode 只认 `.read.` 与 attachment.view.)。
    //
    // ⚠️ memberNo 刻意**不**单发第二个码:单发码多出一处「可能漏发给角色」的失败形态,
    // 那正是 R7-D-01 修的那一类。改编号改用请求体里的二次确认参数 —— 同一处代码里的
    // 显式入参,结构上不存在「码没发给人」这种形态。
    code: 'member.correct.identity',
    module: 'member',
    action: 'correct',
    resourceType: 'identity',
    description:
      '订正队员身份事实(memberNo / 发号日 / 来源;必填订正理由 + 独立审计事件,不混进日常改资料)',
  },
  {
    // 一键离队关闭队员身份及全部当前授权来源。绑 biz-admin。
    code: 'member.offboard.record',
    module: 'member',
    action: 'offboard',
    resourceType: 'record',
    description: '一键离队(单事务关闭归属、关联账号/refresh、任职、分管与直接角色绑定)',
  },
  {
    code: 'member.delete.record',
    module: 'member',
    action: 'delete',
    resourceType: 'record',
    description: '软删队员(仅 SUPER_ADMIN 短路;不绑 biz-admin,D1=A 镜像;评审稿 §6)',
  },
];

// issue #1055 T1(视觉身份终态升级):队员标准照两条业务码。
//
// ⚠️ **本刀只登记码,不绑任何角色** —— 两条都进 BIZ_ADMIN_EXCLUDED_CODES。
// 不是保守,是有实质理由的:issue §8.1 明写
// 「`member-portrait.manage.record` **必须支持组织数据范围,不能只做 GLOBAL RBAC**」。
// biz-admin 的绑定是 **GLOBAL** 的;在 T1 顺手绑上去,等于在 scoped 设计落地之前
// 先给出一个全局管辖的既成事实,T4 再想收回就是**缩小既有角色权限**(要另走一轮拍板)。
// 绑定与 scoped 判权一起在 T4 做。
//
// 先登记不先接线的先例:证书标准库 PR-2 的 4 个审计事件同样是「事件名先落,消费方后到」——
// 让 counts / 契约一次到位,不必在后续刀里再动跨模块枚举。
export const MEMBER_PORTRAIT_MANAGE_RECORD_CODE = 'member-portrait.manage.record';

export const MEMBER_PORTRAIT_READ_HISTORY_CODE = 'member-portrait.read.history';

export const MEMBER_PORTRAIT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: MEMBER_PORTRAIT_MANAGE_RECORD_CODE,
    module: 'member-portrait',
    action: 'manage',
    resourceType: 'record',
    description:
      '管理队员标准照(上传 / 替换 / 作废;须走组织数据范围判权,不是 GLOBAL。当前标准照的**读取**复用 member.read.record)',
  },
  {
    code: MEMBER_PORTRAIT_READ_HISTORY_CODE,
    module: 'member-portrait',
    action: 'read',
    resourceType: 'history',
    description: '查看队员标准照的版本历史(含已顶替 / 已作废版本;历史不可直接修改)',
  },
];

export const MEMBER_PROFILE_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'member-profile.read.record',
    module: 'member-profile',
    action: 'read',
    resourceType: 'record',
    description:
      '查看队员扩展档案(1:1 子资源;documentNumber / mobile 默认掩码,明文走 read.sensitive)',
  },
  {
    code: 'member-profile.create.record',
    module: 'member-profile',
    action: 'create',
    resourceType: 'record',
    description: '创建队员扩展档案',
  },
  {
    code: 'member-profile.update.record',
    module: 'member-profile',
    action: 'update',
    resourceType: 'record',
    description: '部分更新队员扩展档案',
  },
  // 第三轮全仓 review(v0.38.0)§F&A-3 收口:管理档案面敏感字段分级。read.record 语义收窄为
  // 脱敏(documentNumber / mobile 掩码);明文两字段切出独立更严的 read.sensitive(镜像
  // recruitment-application.read.sensitive 先例)。默认绑 biz-admin(不入 BIZ_ADMIN_EXCLUDED_CODES);
  // org-admin 派生排除(入 ORG_ADMIN_EXCLUDED_CODES,与 recruitment sensitive 同款「敏感码不下放」)。
  {
    code: 'member-profile.read.sensitive',
    module: 'member-profile',
    action: 'read',
    resourceType: 'sensitive',
    description:
      '敏感查看:队员扩展档案明文 documentNumber(证件号)/ mobile(从 read.record 切出;§F&A-3 分级)',
  },
];

export const EMERGENCY_CONTACT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'emergency-contact.read.record',
    module: 'emergency-contact',
    action: 'read',
    resourceType: 'record',
    description: '查看队员紧急联系人',
  },
  {
    code: 'emergency-contact.create.record',
    module: 'emergency-contact',
    action: 'create',
    resourceType: 'record',
    description: '新增队员紧急联系人',
  },
  {
    code: 'emergency-contact.update.record',
    module: 'emergency-contact',
    action: 'update',
    resourceType: 'record',
    description: '更新队员紧急联系人',
  },
  {
    code: 'emergency-contact.delete.record',
    module: 'emergency-contact',
    action: 'delete',
    resourceType: 'record',
    description: '软删队员紧急联系人',
  },
  // 十项收口一刀 刀D(2026-07-11):紧急联系人面此前 4 出口全明文且 read.record 下放到
  // org-admin / group-manager(组长可见全队联系人姓名/电话/住址)——与同为电话类的
  // member-profile.mobile 掩码分级口径倒挂。read.record 语义收窄为脱敏(contactName /
  // phonePrimary / phoneBackup / address 掩码);明文切出独立更严的 read.sensitive
  // (镜像 member-profile.read.sensitive §F&A-3 先例)。默认绑 biz-admin;org-admin 派生
  // 排除(入 ORG_ADMIN_EXCLUDED_CODES),group-manager 不绑——带队应急需要者按人 role-binding。
  {
    code: 'emergency-contact.read.sensitive',
    module: 'emergency-contact',
    action: 'read',
    resourceType: 'sensitive',
    description:
      '敏感查看:紧急联系人明文 contactName / phonePrimary / phoneBackup / address(从 read.record 切出;十项收口刀D分级)',
  },
];

export const CERTIFICATE_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'certificate.read.record',
    module: 'certificate',
    action: 'read',
    resourceType: 'record',
    description:
      '查看队员证书(列表 + 详情 + qualification-flag 共用 read;证书编号默认掩码、' +
      '审核备注与审核人不返,明文走 read.sensitive)',
  },
  // 证书标准库 PR-1(冻结稿 §15.3):证书编号(L2,可用于外部查询或冒用)、自由审核备注与
  // 审核人身份(L2,跨成员信息)从 read.record 切出,收进独立更严的 read.sensitive ——
  // 镜像 member-profile.read.sensitive / emergency-contact.read.sensitive 先例。
  // 默认绑 biz-admin(不入 BIZ_ADMIN_EXCLUDED_CODES);**必须**入 ORG_ADMIN_EXCLUDED_CODES,
  // 否则 org-admin 会随 biz-admin 码集自动继承(敏感明文码不随「本组织业务管理」下放)。
  {
    code: 'certificate.read.sensitive',
    module: 'certificate',
    action: 'read',
    resourceType: 'sensitive',
    description:
      '查看证书敏感明文(完整证书编号 + 审核备注 + 审核人 id;仍按 Certificate 资源走 scoped Authz,非全局裸开)',
  },
  {
    code: 'certificate.create.record',
    module: 'certificate',
    action: 'create',
    resourceType: 'record',
    description: '新增队员证书(初始 pending)',
  },
  {
    code: 'certificate.update.record',
    module: 'certificate',
    action: 'update',
    resourceType: 'record',
    description: '部分更新队员证书(禁系统字段)',
  },
  {
    code: 'certificate.delete.record',
    module: 'certificate',
    action: 'delete',
    resourceType: 'record',
    description: '软删队员证书',
  },
  {
    code: 'certificate.verify.record',
    module: 'certificate',
    action: 'verify',
    resourceType: 'record',
    description: '证书核验通过(pending → verified)',
  },
  {
    code: 'certificate.reject.record',
    module: 'certificate',
    action: 'reject',
    resourceType: 'record',
    description: '证书核验拒绝(pending → rejected)',
  },
];

export const ACTIVITY_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'activity.create.record',
    module: 'activity',
    action: 'create',
    resourceType: 'record',
    description: '创建活动(initial draft;列表/详情无码仅登录,评审稿 §3.5)',
  },
  // Activity OS R2 / B6 D1:紧急创建必须显式再持有这一枚码；不因普通创建权限自动取得。
  // D1 只 seed 受控能力，实际紧急创建 / 呼叫 / 发布防线均留待后续 D2 根事务接线。
  {
    code: 'activity.create.emergency.record',
    module: 'activity',
    action: 'create',
    resourceType: 'emergency',
    description: '受控创建紧急活动草稿并发起紧急呼叫(仅 SUPER_ADMIN;不等同正式发布)',
  },
  {
    code: 'activity.update.record',
    module: 'activity',
    action: 'update',
    resourceType: 'record',
    description: '部分更新活动(cancelled 拒改)',
  },
  {
    code: 'activity.delete.record',
    module: 'activity',
    action: 'delete',
    resourceType: 'record',
    description: '软删活动(D3:删除 ≠ 取消)',
  },
  {
    code: 'activity.publish.record',
    module: 'activity',
    action: 'publish',
    resourceType: 'record',
    description: '发布活动(draft → published)',
  },
  {
    code: 'activity.cancel.record',
    module: 'activity',
    action: 'cancel',
    resourceType: 'record',
    description: '取消活动(* → cancelled)',
  },
  // 参与域生命周期收口③(v0.40.0):管理端手动完结活动(published → completed)。绑 biz-admin。
  {
    code: 'activity.complete.record',
    module: 'activity',
    action: 'complete',
    resourceType: 'record',
    description: '完结活动(published → completed;考勤首提亦自动完结)',
  },
];

export const ACTIVITY_REGISTRATION_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'activity-registration.read.record',
    module: 'activity-registration',
    action: 'read',
    resourceType: 'record',
    description: '查看活动报名(列表 + CSV 导出共用 read)',
  },
  {
    code: 'activity-registration.create.record',
    module: 'activity-registration',
    action: 'create',
    resourceType: 'record',
    description: 'ADMIN 代报名(Q-A3)',
  },
  {
    code: 'activity-registration.approve.record',
    module: 'activity-registration',
    action: 'approve',
    resourceType: 'record',
    description: '报名审核通过(pending → pass)',
  },
  {
    code: 'activity-registration.reject.record',
    module: 'activity-registration',
    action: 'reject',
    resourceType: 'record',
    description: '报名审核拒绝(pending → reject)',
  },
  {
    code: 'activity-registration.cancel.record',
    module: 'activity-registration',
    action: 'cancel',
    resourceType: 'record',
    description: '管理员代取消报名(pending|pass → cancelled)',
  },
  // 参与域生命周期收口②(v0.40.0):审批后悔药。撤销驳回、回待审(reject → pending)。绑 biz-admin。
  {
    code: 'activity-registration.reopen.record',
    module: 'activity-registration',
    action: 'reopen',
    resourceType: 'record',
    description: '撤销驳回、回待审(reject → pending;审批后悔药)',
  },
];

export const ATTENDANCE_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'attendance.create.sheet',
    module: 'attendance',
    action: 'create',
    resourceType: 'sheet',
    description: '提交考勤单据(Sheet + N records)',
  },
  {
    code: 'attendance.read.sheet',
    module: 'attendance',
    action: 'read',
    resourceType: 'sheet',
    description: '查看考勤单据(列表 + 详情 + review-detail 共用 read)',
  },
  {
    code: 'attendance.update.sheet',
    module: 'attendance',
    action: 'update',
    resourceType: 'sheet',
    description: '编辑 pending 考勤单据(D38 snapshot + version+1)',
  },
  {
    code: 'attendance.delete.sheet',
    module: 'attendance',
    action: 'delete',
    resourceType: 'sheet',
    description: '软删 pending 考勤单据(级联软删 records)',
  },
  {
    code: 'attendance.approve.sheet',
    module: 'attendance',
    action: 'approve',
    resourceType: 'sheet',
    description: 'APD 一级通过(pending → pending_final_review)',
  },
  {
    code: 'attendance.reject.sheet',
    module: 'attendance',
    action: 'reject',
    resourceType: 'sheet',
    description: 'APD 一级驳回(pending → rejected)',
  },
  {
    code: 'attendance.final-approve.sheet',
    module: 'attendance',
    action: 'final-approve',
    resourceType: 'sheet',
    description: '终审通过(pending_final_review → approved;贡献值生效;ADMIN 级终审沿 P1-5 方案 A)',
  },
  {
    code: 'attendance.final-reject.sheet',
    module: 'attendance',
    action: 'final-reject',
    resourceType: 'sheet',
    description: '终审驳回(pending_final_review → final_rejected)',
  },
  {
    code: 'attendance.reopen.sheet',
    module: 'attendance',
    action: 'reopen',
    resourceType: 'sheet',
    description: '撤回终审通过(approved → pending;保留 records,清空审核责任字段)',
  },
];

// v0.61.0 活动责任闭环 expand：十二项权限只由下方显式 reviewer / 发起 /
// 系统投影角色承载。本阶段不把它们并入 BIZ_PERMISSION_SEED，避免在 contract 摘权前
// 意外给旧通用角色扩大权限面；SUPER_ADMIN 仍由 RbacService 固有短路。
export const ACTIVITY_RESPONSIBILITY_WORKFLOW_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'activity.create.cross-org',
    module: 'activity',
    action: 'create-cross-org',
    resourceType: 'record',
    description: '为本人非当前归属组织发起活动',
  },
  {
    code: 'activity.settlement-generate.record',
    module: 'activity',
    action: 'settlement-generate',
    resourceType: 'record',
    description: '生成或刷新活动结算草稿',
  },
  {
    code: 'activity.settlement-update-draft.record',
    module: 'activity',
    action: 'settlement-update-draft',
    resourceType: 'record',
    description: '编辑活动结算 working draft 单项',
  },
  {
    code: 'activity.settlement-submit.record',
    module: 'activity',
    action: 'settlement-submit',
    resourceType: 'record',
    description: '固化活动结算草稿为不可变送审版本',
  },
  {
    code: 'activity.settlement-first-review.record',
    module: 'activity',
    action: 'settlement-first-review',
    resourceType: 'record',
    description: '一审活动结算版本',
  },
  {
    code: 'activity.settlement-final-review.record',
    module: 'activity',
    action: 'settlement-final-review',
    resourceType: 'record',
    description: '终审活动结算版本并准备账本批次',
  },
  {
    code: 'activity.settlement-close.record',
    module: 'activity',
    action: 'settlement-close',
    resourceType: 'record',
    description: '申请活动结算机器关账',
  },
  {
    code: 'activity-review.read.request',
    module: 'activity-review',
    action: 'read',
    resourceType: 'request',
    description: '查看活动发布审核请求',
  },
  {
    code: 'activity-review.return.request',
    module: 'activity-review',
    action: 'return',
    resourceType: 'request',
    description: '退回活动发布审核请求',
  },
  {
    code: 'activity-responsibility.override.record',
    module: 'activity-responsibility',
    action: 'override',
    resourceType: 'record',
    description: '管理旧活动认领、管理员强制移交',
  },
  {
    code: 'attendance.return.sheet',
    module: 'attendance',
    action: 'return',
    resourceType: 'sheet',
    description: '考勤一审退回修改',
  },
  {
    code: 'attendance.final-return.sheet',
    module: 'attendance',
    action: 'final-return',
    resourceType: 'sheet',
    description: '考勤终审退回修改',
  },
];

// 保险模块 T1(2026-06-13;冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.4):
// 队保单 6 码 + 队员自购保险 2 码(read.other + PR2 review.record),全部绑 biz-admin;
// review.record 同步由动态映射下放 org-admin，不下放 group-manager / 两类 readonly / org-supervisor。
// App 自助端点(app/v1/me/insurances)走 self-scope,**无 RBAC 码**(goal §1 拍板)。
export const TEAM_INSURANCE_POLICY_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'team-insurance-policy.read.record',
    module: 'team-insurance-policy',
    action: 'read',
    resourceType: 'record',
    description: '查看队统一保单(列表 + 详情 + 覆盖名单共用 read)',
  },
  {
    code: 'team-insurance-policy.create.record',
    module: 'team-insurance-policy',
    action: 'create',
    resourceType: 'record',
    description: '创建队统一保单(一张 = 一条)',
  },
  {
    code: 'team-insurance-policy.update.record',
    module: 'team-insurance-policy',
    action: 'update',
    resourceType: 'record',
    description: '部分更新队统一保单',
  },
  {
    code: 'team-insurance-policy.delete.record',
    module: 'team-insurance-policy',
    action: 'delete',
    resourceType: 'record',
    description: '软删队统一保单(不级联覆盖行,评审稿 E-4)',
  },
  {
    code: 'team-insurance-policy.add.member',
    module: 'team-insurance-policy',
    action: 'add',
    resourceType: 'member',
    description: '保单覆盖名单加人(单加 + 全体在册一键加共用;一键加幂等仅 active 未软删)',
  },
  {
    code: 'team-insurance-policy.remove.member',
    module: 'team-insurance-policy',
    action: 'remove',
    resourceType: 'member',
    description: '保单覆盖名单移除队员(软删覆盖行;partial unique 允许重新加入)',
  },
];

export const MEMBER_INSURANCE_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'member-insurance.read.other',
    module: 'member-insurance',
    action: 'read',
    resourceType: 'other',
    description: 'admin 查看队员自购保险(本人侧走 App self-scope 无码;评审稿 E-7)',
  },
  {
    code: 'member-insurance.review.record',
    module: 'member-insurance',
    action: 'review',
    resourceType: 'record',
    description: 'admin 记录队员自购保险审核结论(expectedVersion 必填;仅 pending 可审)',
  },
];

// 招新一期 T1(2026-06-18;冻结评审稿 docs/archive/reviews/recruitment-phase1-review.md §3.4):
// recruitment-cycle 3 码 + recruitment-application 2 码,全部绑 biz-admin(E-R-19,无例外);
// 公开报名/查询走 open/v1 无账号 pre-auth,**无 RBAC 码**(分叉①/②);取证件照 signed-URL 复用
// recruitment-application.read.record(不另加码,配套②)。5 码端点 T3 实装,T1 期间孤码(WARN 预期)。
// 招新二期 T1(2026-06-19;冻结评审稿 recruitment-phase2-review.md §3.4 / E-R2-11):recruitment-application
// +3 码(mark.threshold / evaluate.assessment / promote.member),全绑 biz-admin;公示名单复用 read.record;
// 端点 T2/T3 实装,T1 期间孤码(WARN 预期)。
// 招新闭环优化 S3(2026-06-24;评审稿 recruitment-phase4-loop-optimization-review.md §11 / Q-P4-10):
// recruitment-application +1 码 read.sensitive(敏感查看),全绑 biz-admin 无例外;read.record 语义收窄为脱敏。
// 实装即用(详情明文闸 + 证件照 signed-URL),无孤码;上文「signed-URL 复用 read.record」自本切片起改判 read.sensitive。
export const RECRUITMENT_CYCLE_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'recruitment-cycle.read.record',
    module: 'recruitment-cycle',
    action: 'read',
    resourceType: 'record',
    description: '查看招新轮次(列表 + 详情共用 read)',
  },
  {
    code: 'recruitment-cycle.create.record',
    module: 'recruitment-cycle',
    action: 'create',
    resourceType: 'record',
    description: '创建招新轮次(默认 closed,显式开)',
  },
  {
    code: 'recruitment-cycle.update.record',
    module: 'recruitment-cycle',
    action: 'update',
    resourceType: 'record',
    description: '更新招新轮次(开/关 + 容量 + 通知配置;service 强校验至多一个 open 轮)',
  },
];

export const RECRUITMENT_APPLICATION_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'recruitment-application.read.record',
    module: 'recruitment-application',
    action: 'read',
    resourceType: 'record',
    description:
      '普通查看:脱敏列表 + 脱敏详情 + 公示名单 + 工作台 stats(明文证件号/手机 + 证件照 signed-URL 走 read.sensitive;读记 placeholder 审计)',
  },
  // 招新闭环优化 S3(2026-06-24;评审稿 recruitment-phase4-loop-optimization-review.md §11.1 / Q-P4-10):
  // 敏感查看从 read.record 切出。read.record 语义收窄为脱敏;明文证件号/手机(详情)+ 证件照 signed-URL 改判此码。
  // 默认绑 biz-admin(沿 BIZ_ADMIN_PERMISSION_SEED 过滤;§11.2 迁移:现持 read.record 的 biz-admin 补挂本码 → 明文行为不回退)。
  {
    code: 'recruitment-application.read.sensitive',
    module: 'recruitment-application',
    action: 'read',
    resourceType: 'sensitive',
    description:
      '敏感查看:详情明文证件号/手机 + 取证件照 signed-URL(从 read.record 切出;招新闭环优化 S3 §11.1)',
  },
  {
    code: 'recruitment-application.resolve.manual',
    module: 'recruitment-application',
    action: 'resolve',
    resourceType: 'manual',
    description: '人工待核 resolve(外籍等;通过→发临时编号 / 不通过→未通过;评审稿分叉④)',
  },
  // 招新二期 +3(2026-06-19;评审稿 recruitment-phase2-review.md §3.4 / E-R2-11,全绑 biz-admin 无例外)
  {
    code: 'recruitment-application.mark.threshold',
    module: 'recruitment-application',
    action: 'mark',
    resourceType: 'threshold',
    description:
      '标/清门槛完成(巡山×2/培训/急救资质/BSAFE;幂等;末次完成自动推进待综合评定;评审稿 E-R2-2)',
  },
  {
    code: 'recruitment-application.evaluate.assessment',
    module: 'recruitment-application',
    action: 'evaluate',
    resourceType: 'assessment',
    description:
      '综合评定/淘汰(单一人工闸;通过→公示 / 不通过→未通过;门槛超期 verified 态淘汰;评审稿 D-R2-3)',
  },
  {
    code: 'recruitment-application.promote.member',
    module: 'recruitment-application',
    action: 'promote',
    resourceType: 'member',
    description:
      '一键发号:公示报名按拼音序批量发永久编号 + 建 User+Member+档案+紧急联系人(评审稿 D-R2-5)',
  },
  // 招新可用性收口 F2(2026-07-11;评审稿 recruitment-usability-closeout-review.md §3 R1,绑 biz-admin):
  {
    code: 'recruitment-application.update.record',
    module: 'recruitment-application',
    action: 'update',
    resourceType: 'record',
    description:
      'admin 改报名资料(R1 白名单:非身份字段恒可改;身份字段仅 manual_review 或外籍;必落 audit)',
  },
  // 招新可用性收口 F3(2026-07-11;评审稿 §3 R3 / §6.1 E-U-3/E-U-4,绑 biz-admin):
  {
    code: 'recruitment-application.promote.single',
    module: 'recruitment-application',
    action: 'promote',
    resourceType: 'single',
    description:
      '单人手动建档(批量 skip 项收尾:与批量共用建档内核/原子号段;放行外籍;锚点择优 openid→phone)',
  },
  {
    code: 'recruitment-application.review.certificate',
    module: 'recruitment-application',
    action: 'review',
    resourceType: 'certificate',
    description: '审核申请人证书(通过自动标门槛;驳回清图并取消门槛)',
  },
];

// 招新三期(入队:志愿者→队员)T2(2026-06-19;冻结评审稿 recruitment-phase3-review.md §3.4 / E-J-8):
// team-join-cycle 3 码 + team-join-application 3 码(read / mark.gate / evaluate.assessment),全绑 biz-admin。
// app/v1 自助面 self-scope **无 RBAC 码**(镜像 insurances me)。join.member(一键入队)随 T4 controller 落
// (避免 rbacmap 孤码:本 PR 码全有 admin controller call-site)。
export const TEAM_JOIN_CYCLE_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'team-join-cycle.read.record',
    module: 'team-join-cycle',
    action: 'read',
    resourceType: 'record',
    description: '查看入队轮(列表 + 详情共用 read)',
  },
  {
    code: 'team-join-cycle.create.record',
    module: 'team-join-cycle',
    action: 'create',
    resourceType: 'record',
    description: '创建入队轮(默认 closed,显式开)',
  },
  {
    code: 'team-join-cycle.update.record',
    module: 'team-join-cycle',
    action: 'update',
    resourceType: 'record',
    description: '更新入队轮(开/关 + 轮次名;service 强校验至多一个 open 轮)',
  },
];

export const TEAM_JOIN_APPLICATION_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'team-join-application.read.record',
    module: 'team-join-application',
    action: 'read',
    resourceType: 'record',
    description: 'admin 查看入队申请(列表 + 详情;详情含各 gate 实况 + 实时贡献值汇总)',
  },
  {
    code: 'team-join-application.mark.gate',
    module: 'team-join-application',
    action: 'mark',
    resourceType: 'gate',
    description:
      '标 gate(8 通用 + 4 专业队;通过/未通过 + 完成日 + dept-assessment 可延长期;幂等;末次 8 通用全过 + 贡献值≥5 自动→待综合评估;评审稿 §4.1)',
  },
  {
    code: 'team-join-application.evaluate.assessment',
    module: 'team-join-application',
    action: 'evaluate',
    resourceType: 'assessment',
    description:
      '综合评估/淘汰(单一人工闸;通过→待入队 / 不通过→未通过;joining 门槛超期淘汰;评审稿 §4.5)',
  },
  // 招新三期入队 T4(2026-06-19;评审稿 §4.5):一键入队(志愿者→队员;设部门 + 级别 level-1),全绑 biz-admin。
  {
    code: 'team-join-application.join.member',
    module: 'team-join-application',
    action: 'join',
    resourceType: 'member',
    description:
      '一键入队:approved 申请单事务设部门 + 级别 level-1 → joined(原子/幂等;两层身份转换;评审稿 §4.5)',
  },
];

// CMS 内容发布模块(第 28 模块,2026-06-21;评审稿 §7):content.* 5 码,全绑 biz-admin。
export const CONTENT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'content.read.record',
    module: 'content',
    action: 'read',
    resourceType: 'record',
    description:
      'admin 查看内容(列表 + 详情;全状态全可见档);亦作 app/v1 management 可见档判定信号(评审稿 §4.1)',
  },
  {
    code: 'content.create.record',
    module: 'content',
    action: 'create',
    resourceType: 'record',
    description: '新建内容草稿(先草稿拿 id 再上传封面 / 正文图 / 附件;评审稿 §5.3)',
  },
  {
    code: 'content.update.record',
    module: 'content',
    action: 'update',
    resourceType: 'record',
    description: '更新内容(draft / published 可改,archived 冻结);设 / 清封面',
  },
  {
    code: 'content.delete.record',
    module: 'content',
    action: 'delete',
    resourceType: 'record',
    description: '软删内容(任意态)',
  },
  {
    code: 'content.publish.record',
    module: 'content',
    action: 'publish',
    resourceType: 'record',
    description: '内容状态机:publish / unpublish / archive(立即生效无 cron;评审稿 §3)',
  },
];

// CMS 附件 owner(content-image / content-file)写路径 coarse 权限码(沿 attachment.*.activity 粗粒度范式;
// 全绑 biz-admin;α 决议)。读路径由 content 自签 + 文章可见级闸控,不走这些码(评审稿 §5.2 / §5.4)。
// 注:这 4 码 module='attachment' 但归入 BIZ_PERMISSION_SEED 绑 biz-admin —— 内容写路径授权,
// 演进 Slow-4「biz-admin 不含 attachment.* 码」不变式为「仅含 CMS content-* 4 码」(评审稿 §7;
// seed-biz-admin.e2e 的 attachment.* 断言同步 true-up)。
export const CONTENT_ATTACHMENT_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'attachment.upload.content-image',
    module: 'attachment',
    action: 'upload',
    resourceType: 'content-image',
    description: '上传内容图片(封面 / 正文图;经 AttachmentsService 写路径判权)',
  },
  {
    code: 'attachment.delete.content-image',
    module: 'attachment',
    action: 'delete',
    resourceType: 'content-image',
    description: '删除内容图片附件',
  },
  {
    code: 'attachment.upload.content-file',
    module: 'attachment',
    action: 'upload',
    resourceType: 'content-file',
    description: '上传内容文件附件',
  },
  {
    code: 'attachment.delete.content-file',
    module: 'attachment',
    action: 'delete',
    resourceType: 'content-file',
    description: '删除内容文件附件',
  },
];

// 统一通知模块 S1 站内信渠道(2026-06-25;冻结评审稿
// docs/archive/reviews/unified-notification-dispatcher-review.md §9.2 + member-notification-review.md §4):
// notification.* 5 码,全绑 biz-admin(镜像 content;app 会员读取面零码 = canUseApp 闸 + 可见级)。
// 不开 read.other / publish.emergency(通知是广播无 owner-scope;紧急召集仍是 publish 一种;沿原 T0 §4)。
export const NOTIFICATION_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'notification.read.record',
    module: 'notification',
    action: 'read',
    resourceType: 'record',
    description: 'admin 查看通知(列表 + 详情;全状态全可见档;回显已读人数)',
  },
  {
    code: 'notification.create.record',
    module: 'notification',
    action: 'create',
    resourceType: 'record',
    description: '新建通知草稿',
  },
  {
    code: 'notification.update.record',
    module: 'notification',
    action: 'update',
    resourceType: 'record',
    description: '更新通知(draft / published 可改,archived 冻结)',
  },
  {
    code: 'notification.delete.record',
    module: 'notification',
    action: 'delete',
    resourceType: 'record',
    description: '软删通知(任意态)',
  },
  {
    code: 'notification.publish.record',
    module: 'notification',
    action: 'publish',
    resourceType: 'record',
    description: '通知状态机:publish(推送)/ unpublish(撤回)/ archive(立即生效无 cron)',
  },
  // 统一通知 S2(2026-06-25;微信订阅 quota 渠道):模板配置写权(运营改 templateId 不重部署,D-N3)。
  // 读模板配置复用 notification.read.record(不另开 read 码,§9.2「至多 +1」预算);全绑 biz-admin。
  {
    code: 'notification.update.template',
    module: 'notification',
    action: 'update',
    resourceType: 'template',
    description: '配置通知类型 → 微信订阅模板 ID + 启用态(upsert;运营可配)',
  },
  // 统一通知 S5(2026-06-27;短信兜底渠道):admin 显式发起短信(紧急召集)成本动作单独 gating
  // (评审稿 §9.2 / D-N4;计费确认必需;全绑 biz-admin)。
  {
    code: 'notification.send.sms',
    module: 'notification',
    action: 'send',
    resourceType: 'sms',
    description: 'admin 显式发起短信兜底(紧急召集;计费确认必需,confirmed=true 才真发)',
  },
];

// F4「D 组」memberships(2026-07-04;冻结路线图 admin-api-fe-integration-roadmap.md §4 / §6.2):
// 归属迁移(transfer)业务写码(1 条,绑 biz-admin —— 组织变更业务写,区别于 membership.{list,read,set,end}
// 4 条 ops-admin 管理面码;POST admin/v1/memberships/transfer 单事务 end 旧 + create 新)。
export const MEMBERSHIP_TRANSFER_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  {
    code: 'membership.transfer.record',
    module: 'membership',
    action: 'transfer',
    resourceType: 'record',
    description: '归属迁移(单事务:结束源组织 ACTIVE 归属 + 在目标组织建同类型新归属)',
  },
];

// D1=A 镜像:members DELETE 仅 SUPER_ADMIN 短路;码进 Permission 表但不绑 biz-admin(评审稿 §6)
export const MEMBER_DELETE_RECORD_CODE = 'member.delete.record';
// Activity OS R2 / B6 D1:紧急创建同样只留 SUPER_ADMIN 直通,绝不随默认业务角色下放。
export const ACTIVITY_CREATE_EMERGENCY_RECORD_CODE = 'activity.create.emergency.record';

// 业务面权限码全集(各子数组求和,当前 89 条;运行期日志用 `.length` 输出为准,本注释不逐项维护数字,
// 组成明细见下方 BIZ_ADMIN_DESCRIPTION。第三轮 review〔v0.38.0〕§F&A-3 使 member-profile 3→4、总 76→77;
// v0.40.0 参与域收口 +3〔已并入各子数组〕;招新可用性收口 F2/F3 使 recruitment-application 6→8、总 80→82;
// 十项收口刀D〔2026-07-11〕使 emergency-contact 4→5、总 82→83;十三项收口刀G 证书审核 +1 →84;
// v0.47.0 F2 attendance.reopen.sheet +1 →85;D-INSURANCE PR2 review.record +1 →86;
// 〔实测口径〕本注释的历史累加与运行期 `.length` 早已对不上(累加到 86 时实际是 87)——
// 以运行期日志为准,别照这串加减推算。issue #1055 T1 member-portrait +2 ⇒ 实测 89)
export const BIZ_PERMISSION_SEED: ReadonlyArray<RbacPermissionSeed> = [
  ...MEMBER_PERMISSION_SEED,
  ...MEMBER_PORTRAIT_PERMISSION_SEED,
  ...MEMBER_PROFILE_PERMISSION_SEED,
  ...EMERGENCY_CONTACT_PERMISSION_SEED,
  ...CERTIFICATE_PERMISSION_SEED,
  ...ACTIVITY_PERMISSION_SEED,
  ...ACTIVITY_REGISTRATION_PERMISSION_SEED,
  ...ATTENDANCE_PERMISSION_SEED,
  ...TEAM_INSURANCE_POLICY_PERMISSION_SEED,
  ...MEMBER_INSURANCE_PERMISSION_SEED,
  ...RECRUITMENT_CYCLE_PERMISSION_SEED,
  ...RECRUITMENT_APPLICATION_PERMISSION_SEED,
  ...TEAM_JOIN_CYCLE_PERMISSION_SEED,
  ...TEAM_JOIN_APPLICATION_PERMISSION_SEED,
  ...CONTENT_PERMISSION_SEED,
  ...CONTENT_ATTACHMENT_PERMISSION_SEED,
  ...NOTIFICATION_PERMISSION_SEED,
  ...MEMBERSHIP_TRANSFER_PERMISSION_SEED,
];

// ---------------------------------------------------------------------------
// 控制面契约:仅 SUPER_ADMIN 可授予的权限码
// ---------------------------------------------------------------------------

/**
 * 控制面仅 SUPER_ADMIN 可授予的权限码;ops-admin / biz-admin 均不得绑定。
 *
 * ⚠️ `*.reset.credentials` 是一个**家族**,不是一串互不相干的码:每接入一个新 provider
 * 的凭证重置端点,那条码都必须同步登记进本表,否则持 `rbac.role-permission.create` 的
 * ops-admin 可把它自授给任意角色,再调对应 reset 端点覆盖该 provider 的 secret。
 * 第六轮评审 E-B1 实测:`wecom-setting.reset.credentials` 就是这样漏的(T2 后加,没同步)。
 * 现由 `reserved-super-admin-permission-codes.spec.ts` 的「家族全登记」判据机器执法 ——
 * 该判据从 src/ + prisma/ 动态扫 `*.reset.credentials`,漏一条即红并点名。
 */
export const RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES: readonly string[] = Object.freeze([
  'user.update.role',
  'storage-setting.reset.credentials',
  'sms-setting.reset.credentials',
  'wechat-setting.reset.credentials',
  'realname-setting.reset.credentials',
  'wecom-setting.reset.credentials',
  'member.delete.record',
  'activity.create.emergency.record',
]);

// ===========================================================================
// 权限元数据(P1-32 PR 0 决策锁)
// ===========================================================================
//
// 这一段装的是**人做出的决定**,不是代码里能推出来的事实:
// 每条权限码叫什么中文名、一句人话说明、归在后台哪个分区/分组、有多危险、
// 带哪些风险性质、允不允许放进自定义角色、退没退役、在角色编辑器里露不露面。
//
// ──────────────────────────────────────────────────────────────────────────
// 为什么这些字段必须进代码,而不是写成一份文档
//
// 冻结稿 `docs/archive/reviews/rbac-permission-catalog-t0-review.md` 把 PR 0 定性为
// 「设计/文档,不改运行行为」。但本仓的铁律是「能做成机器检查的,就不要只写成文字要求」
// —— 维护者看不懂代码,无法当兜底审查者,纯文档的决策记录**会漂**。
// 而 PR 3 之后权限元数据变成 Catalog-owned、禁运行时增删改,**填错的代价那时才显现**。
// 所以决策落在这里,并由
// [`permission-catalog-metadata.criteria.spec.ts`](permission-catalog-metadata.criteria.spec.ts)
// 执法:目录里每一条 ACTIVE 码都必须有完整元数据,缺一条即红并点名是哪条。
//
// ⚠️ **本段仍然零运行行为改变** —— PR 2 之前没有任何生产代码读这些字段。
//
// ──────────────────────────────────────────────────────────────────────────
// 维护者 2026-08-22 拍板(六项;详见 `docs/ai-harness/NEXT_TASKS.md` P1-32 段)
//
// ① CRITICAL 的定义 = 出错后「救不回来」或「能把权力给出去」。**判据用标签,不写死清单**,
//    这样将来新增的控制面码会自动落进 CRITICAL(IF v1 PR2 会 +9 条)。五族:
//      提权(CONTROL_PLANE)· 凭证(CREDENTIAL)· 身份(发错编号救不回)·
//      账本(LEDGER,关账只能冲正)· 硬删(DESTRUCTIVE,附件真删无回收站)。
//    ⚠️ `CONTROL_PLANE` **只贴给写侧**:`role-binding.read.record` 之类纯查看码贴上去
//    会变成最高危,与「能把权力给出去」这条定义对不上。
// ② 7 条保留码:**收紧口径 —— 一条都不该进任何角色**,只走 SUPER_ADMIN 身份短路
//    (记为 `grantPolicy: 'SUPER_ADMIN_ONLY'` + `uiVisibility: 'HIDDEN'`)。
//    ✅ **执行位已补齐(P1-32 PR 3a,2026-08-23)**:授码侧对这 7 条码任何身份都拒,
//    含 SUPER_ADMIN(返 `30109`)。判据仍守住「内建角色一条都不持有」。
//    ⚠️ 收紧**只覆盖本条这 7 条**,不覆盖 `rbac.*` / `role-binding.*` 前缀族 ——
//    与上面①末尾那条「纯查看码不该按最高危对待」是同一个道理:前缀族里有
//    `rbac.permission.read` 这类只读码,拦住 SA 会取消「SA 建 RBAC 只读观察员角色」
//    这个合法能力。非 SA 碰整个控制面族仍返 `30103`,语义一字未变。
//    ⚠️ 撤码侧**刻意没有这一层**(历史脏数据的唯一清理路),不是漏改;
//    理由见 role-permissions.service.ts 的 assertControlPlaneCodesOrThrow 头注。
// ③ Scope 首版**只提示不强校验** ⇒ 本段刻意**不出** `scopeProfile` 字段(没有就不会被误当强校验依据)。
// ④ step-up **不在本刀绑定任何 action**:今天 step-up 只覆盖「本人绑手机/微信/企微」三个动作,
//    管理端一条都没绑,「绑 CRITICAL 全集」是另立一刀的事,不是翻个开关。本段只记 riskLevel。
// ⑤ 旧 Permission 写 CRUD(`rbac.permission.create/update/delete`)**不定退役日期**,
//    仍为 `ACTIVE`;退役由冻结稿 PR 8 的前提触发(访问日志零调用 + 前端已切 + deprecated 满一个发布周期)。
// ⑥ 15 个内建角色全部「系统角色 · 权限集只读」——**角色侧的决定,不落在本段**
//    (本段按权限码组织),记在 NEXT_TASKS 并由 seed 侧判据守。
//
// ──────────────────────────────────────────────────────────────────────────
// 🔴 两条残留风险(不许在别处被转述成「已全面复核」)
//
// 1. 风险分档的**第二套判据覆盖 213/237**。初稿按命名规律推,2026-08-22 用
//    「每条码实际守着的端点(ROUTE_AUTHZ Permission code surface)」重推并对拍,改档 9 条。
//    另 24 条(`attachment.*` 与 2 条 `*.read.sensitive`)权限码是**动态拼**的
//    (`` `attachment.upload.${ownerType}` ``)或在 service 内 `rbac.can()` 判权,
//    路由声明里看不见 ⇒ 它们改用**第二种独立判据**核过:附件 4 个通配入口的 HTTP 方法
//    (GET=看 / POST=传 / PATCH=改元数据 / DELETE=删)+ `model Attachment` 无 `deletedAt`
//    与 `deleteObjectAt` 真删对象;两条 `*.read.sensitive` 在 service 里恒为
//    `masked = !can(...)` 的脱敏开关,不写任何东西。
// 2. **三档 → 四档是新决策,不是搬运**。初稿只有低/中/高三档(刻意的:档位越多越难拍板),
//    冻结稿的枚举是四档,`HIGH` 与 `CRITICAL` 的分界冻结稿**没有定义** —— 由上面 ① 补齐。

/** 风险等级。`CRITICAL` 的判据见上方 ①。取值恒等于冻结稿 §4.2,一个字都不许改。 */
export const PERMISSION_RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type PermissionRiskLevel = (typeof PERMISSION_RISK_LEVELS)[number];

/** 授予策略:这条码允许被放进什么样的角色。 */
export const PERMISSION_GRANT_POLICIES = [
  'CUSTOM_ROLE_ALLOWED',
  'SUPER_ADMIN_ONLY',
  'ROLE_ALLOWLIST_ONLY',
  'SYSTEM_ROLE_ONLY',
] as const;
export type PermissionGrantPolicy = (typeof PERMISSION_GRANT_POLICIES)[number];

/** 生命周期。只有 `ACTIVE` 受「元数据必须完整」判据管辖 —— 否则退役码永远删不掉。 */
export const PERMISSION_CATALOG_STATUSES = ['ACTIVE', 'DEPRECATED', 'INTERNAL'] as const;
export type PermissionCatalogStatus = (typeof PERMISSION_CATALOG_STATUSES)[number];

/** 角色编辑器里的露面程度。 */
export const PERMISSION_UI_VISIBILITIES = ['DEFAULT', 'ADVANCED', 'HIDDEN'] as const;
export type PermissionUiVisibility = (typeof PERMISSION_UI_VISIBILITIES)[number];

/**
 * 风险性质标签(多值)。描述「这个动作是什么性质」,与 `riskLevel`(有多危险)分工不同:
 * 等级供 UI 排序与告警强度,标签供判据推等级、也供将来 step-up / 审批链按性质选靶子。
 */
export const PERMISSION_RISK_TAGS = [
  'READ',
  'WRITE',
  'DESTRUCTIVE',
  'SENSITIVE_DATA',
  'ACCOUNT_SECURITY',
  'CREDENTIAL',
  'CONTROL_PLANE',
  'FINAL_APPROVAL',
  'MASS_EFFECT',
  'LEDGER',
  'WORKFLOW_INTERNAL',
] as const;
export type PermissionRiskTag = (typeof PERMISSION_RISK_TAGS)[number];

/** 一级业务区(后台权限编辑器的第一层)。 */
export interface PermissionCatalogSection {
  readonly code: string;
  readonly displayName: string;
  readonly sortOrder: number;
}

/** 二级分组(挂在某个一级业务区下)。 */
export interface PermissionCatalogGroup {
  readonly code: string;
  readonly sectionCode: string;
  readonly displayName: string;
  readonly sortOrder: number;
}

/**
 * 一条权限码的元数据。字段集沿冻结稿 §4.2 的 `PermissionCatalogEntry`,
 * 去掉与 `RbacPermissionSeed` 重复的 `code` / `module` / `action` / `resourceType`
 * (那四项的单一事实源是上方各 `*_PERMISSION_SEED` 数组,不在这里再抄一份)。
 *
 * ⚠️ 全部字段**必填** —— 冻结稿把 `technicalDescription` / `allowedRoleCodes` /
 * `replacementCodes` / `scopeProfile` 列为可选,本期一条都不出:
 * 可选字段进不了「一个空值都不许有」的判据,等真有用途时再加并同步判据。
 */
export interface PermissionCatalogMetadata {
  readonly displayName: string;
  readonly businessDescription: string;
  readonly sectionCode: string;
  readonly groupCode: string;
  readonly sortOrder: number;
  readonly riskLevel: PermissionRiskLevel;
  readonly riskTags: readonly PermissionRiskTag[];
  readonly grantPolicy: PermissionGrantPolicy;
  readonly status: PermissionCatalogStatus;
  readonly uiVisibility: PermissionUiVisibility;
}

export const PERMISSION_CATALOG_SECTIONS: ReadonlyArray<PermissionCatalogSection> = Object.freeze([
  { code: 'organization-people', displayName: '组织与人员', sortOrder: 100 },
  { code: 'activity-participation', displayName: '活动与参与', sortOrder: 200 },
  { code: 'certificate-qualification', displayName: '证书与资质', sortOrder: 300 },
  { code: 'recruitment-enrollment', displayName: '招新与入队', sortOrder: 400 },
  { code: 'insurance', displayName: '保险', sortOrder: 500 },
  { code: 'content-notification', displayName: '内容与通知', sortOrder: 600 },
  { code: 'attachment-storage', displayName: '附件与存储', sortOrder: 700 },
  { code: 'system-security', displayName: '系统与安全', sortOrder: 800 },
  { code: 'master-data', displayName: '基础数据', sortOrder: 900 },
]);

export const PERMISSION_CATALOG_GROUPS: ReadonlyArray<PermissionCatalogGroup> = Object.freeze([
  {
    code: 'organization-structure',
    sectionCode: 'organization-people',
    displayName: '组织架构',
    sortOrder: 10,
  },
  { code: 'member', sectionCode: 'organization-people', displayName: '队员', sortOrder: 20 },
  {
    code: 'member-profile',
    sectionCode: 'organization-people',
    displayName: '队员档案',
    sortOrder: 30,
  },
  {
    code: 'emergency-contact',
    sectionCode: 'organization-people',
    displayName: '紧急联系人',
    sortOrder: 40,
  },
  {
    code: 'member-affiliation',
    sectionCode: 'organization-people',
    displayName: '组织归属',
    sortOrder: 50,
  },
  { code: 'position', sectionCode: 'organization-people', displayName: '职务', sortOrder: 60 },
  {
    code: 'position-assignment',
    sectionCode: 'organization-people',
    displayName: '任职',
    sortOrder: 70,
  },
  { code: 'supervision', sectionCode: 'organization-people', displayName: '分管', sortOrder: 80 },
  {
    code: 'member-portrait',
    sectionCode: 'organization-people',
    displayName: '标准照',
    sortOrder: 90,
  },
  { code: 'activity', sectionCode: 'activity-participation', displayName: '活动', sortOrder: 10 },
  {
    code: 'activity-publish-review',
    sectionCode: 'activity-participation',
    displayName: '发布审核',
    sortOrder: 20,
  },
  {
    code: 'activity-responsibility',
    sectionCode: 'activity-participation',
    displayName: '活动责任',
    sortOrder: 30,
  },
  {
    code: 'activity-registration',
    sectionCode: 'activity-participation',
    displayName: '报名',
    sortOrder: 40,
  },
  { code: 'attendance', sectionCode: 'activity-participation', displayName: '考勤', sortOrder: 50 },
  {
    code: 'attendance-review',
    sectionCode: 'activity-participation',
    displayName: '考勤审核',
    sortOrder: 60,
  },
  {
    code: 'activity-settlement',
    sectionCode: 'activity-participation',
    displayName: '活动结算',
    sortOrder: 70,
  },
  {
    code: 'contribution-rule',
    sectionCode: 'activity-participation',
    displayName: '贡献值规则',
    sortOrder: 80,
  },
  {
    code: 'certificate',
    sectionCode: 'certificate-qualification',
    displayName: '证书',
    sortOrder: 10,
  },
  {
    code: 'certificate-standard',
    sectionCode: 'certificate-qualification',
    displayName: '证书标准',
    sortOrder: 20,
  },
  {
    code: 'certificate-recognition',
    sectionCode: 'certificate-qualification',
    displayName: '资质认定规则',
    sortOrder: 30,
  },
  {
    code: 'recruitment-cycle',
    sectionCode: 'recruitment-enrollment',
    displayName: '招新轮次',
    sortOrder: 10,
  },
  {
    code: 'recruitment-application',
    sectionCode: 'recruitment-enrollment',
    displayName: '招新报名',
    sortOrder: 20,
  },
  {
    code: 'team-join-cycle',
    sectionCode: 'recruitment-enrollment',
    displayName: '入队轮次',
    sortOrder: 30,
  },
  {
    code: 'team-join-application',
    sectionCode: 'recruitment-enrollment',
    displayName: '入队申请',
    sortOrder: 40,
  },
  {
    code: 'team-insurance-policy',
    sectionCode: 'insurance',
    displayName: '团队保单',
    sortOrder: 10,
  },
  { code: 'member-insurance', sectionCode: 'insurance', displayName: '队员投保', sortOrder: 20 },
  { code: 'content', sectionCode: 'content-notification', displayName: '内容', sortOrder: 10 },
  { code: 'notification', sectionCode: 'content-notification', displayName: '通知', sortOrder: 20 },
  {
    code: 'announcement-import',
    sectionCode: 'content-notification',
    displayName: '公告导入',
    sortOrder: 30,
  },
  { code: 'attachment', sectionCode: 'attachment-storage', displayName: '附件', sortOrder: 10 },
  {
    code: 'attachment-config',
    sectionCode: 'attachment-storage',
    displayName: '附件类型配置',
    sortOrder: 20,
  },
  { code: 'user-account', sectionCode: 'system-security', displayName: '用户账号', sortOrder: 10 },
  { code: 'role', sectionCode: 'system-security', displayName: '角色', sortOrder: 20 },
  { code: 'permission', sectionCode: 'system-security', displayName: '权限点', sortOrder: 30 },
  { code: 'integration', sectionCode: 'system-security', displayName: '系统集成', sortOrder: 45 },
  { code: 'user-role', sectionCode: 'system-security', displayName: '用户角色', sortOrder: 40 },
  {
    code: 'rbac-runtime',
    sectionCode: 'system-security',
    displayName: '权限运行时',
    sortOrder: 50,
  },
  { code: 'role-binding', sectionCode: 'system-security', displayName: '角色绑定', sortOrder: 60 },
  {
    code: 'authz-diagnostics',
    sectionCode: 'system-security',
    displayName: '权限诊断',
    sortOrder: 70,
  },
  { code: 'audit', sectionCode: 'system-security', displayName: '审计', sortOrder: 80 },
  { code: 'sms', sectionCode: 'system-security', displayName: '短信', sortOrder: 90 },
  { code: 'wechat', sectionCode: 'system-security', displayName: '微信', sortOrder: 100 },
  { code: 'wecom', sectionCode: 'system-security', displayName: '企业微信', sortOrder: 110 },
  {
    code: 'realname-verification',
    sectionCode: 'system-security',
    displayName: '实名核验',
    sortOrder: 120,
  },
  {
    code: 'storage-setting',
    sectionCode: 'system-security',
    displayName: '存储设置',
    sortOrder: 130,
  },
  { code: 'dict', sectionCode: 'master-data', displayName: '字典', sortOrder: 10 },
  { code: 'meta', sectionCode: 'master-data', displayName: '元数据', sortOrder: 20 },
]);

/**
 * 「身份签发」族 —— 维护者 2026-08-22 定案 ① 的第三族,恒 `CRITICAL`。
 *
 * 🔴 **为什么这一族只能写成清单,而另外四族是标签**:另外四族(提权 / 凭证 / 账本 / 硬删)
 * 各自对应一个冻结稿枚举里的 `riskTag`,新码贴上标签就自动进 CRITICAL;
 * 而「发错编号救不回」这件事在 11 个冻结标签里**没有对应项**,最近的 `ACCOUNT_SECURITY`
 * 覆盖面又太宽(`user.update.status` 停用账号、`user.phone.clear` 解绑手机都带它,
 * 但那两个都能改回来)—— 拿它当判据会把一批可逆动作误升到最高危。
 *
 * ⚠️ 因此这份清单是**已知的执法缺口**:新增身份签发类权限码时必须手工补进来,
 * 漏补不会有任何症状(新码照样有元数据、照样过完整性判据,只是档位低了一级)。
 * 真正的修法是给冻结稿的标签集加一个 `IDENTITY_ISSUANCE`,那要动 PR 2 的枚举,已登记 NEXT_TASKS。
 *
 * 为什么这几条是「救不回来」:`memberNo` 是登录识别锚(auth 侧「编号即身份」),
 * 且由 [`MemberNoReservation`](../../../prisma/schema.prisma) 台账**只增不删**地永久占号 ——
 * 号一旦发出去就烧掉了,发错了只能换一个新号,旧号永远躺在台账里。
 */
export const IDENTITY_ISSUANCE_PERMISSION_CODES: readonly string[] = Object.freeze([
  'member.create.record',
  'member.correct.identity',
  'member.bind.account',
  'member.grant.account',
  'recruitment-application.promote.member',
  'recruitment-application.promote.single',
]);

/**
 * 「出错救不回 / 能把权力给出去」= `CRITICAL` 的标签族(维护者 2026-08-22 定案 ①)。
 * 与上方 `IDENTITY_ISSUANCE_PERMISSION_CODES` 合起来构成 CRITICAL 的**完整判据**。
 * 用标签而不是清单,是为了让将来新增的控制面 / 凭证 / 账本 / 硬删码自动落进 CRITICAL。
 */
export const CRITICAL_RISK_TAGS: readonly PermissionRiskTag[] = Object.freeze([
  'CONTROL_PLANE',
  'CREDENTIAL',
  'LEDGER',
  'DESTRUCTIVE',
] as const);

export const PERMISSION_CATALOG_METADATA: Readonly<Record<string, PermissionCatalogMetadata>> =
  Object.freeze({
    // ===== 组织与人员 / 组织架构 =====
    'org.create.node': {
      displayName: '新建分队/小组',
      businessDescription:
        '在组织架构里加一个新的分队、部门或小组,挂到指定的上级下面。填了编号就必须全队唯一;不填上级等于建最顶层的总队,而总队只允许有一个,已经有了会被拒绝',
      sectionCode: 'organization-people',
      groupCode: 'organization-structure',
      sortOrder: 10510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'org.delete.node': {
      displayName: '删除分队/小组',
      businessDescription:
        '把一个分队/小组从组织架构里去掉。下面还挂着子级、或者还有人正式归属在里面,就删不掉;删掉之后后台没有恢复入口,它用过的编号也会被永久占住、不能再给新单位用',
      sectionCode: 'organization-people',
      groupCode: 'organization-structure',
      sortOrder: 10520,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'org.move.node': {
      displayName: '调整组织归属',
      businessDescription:
        '把一个分队/小组连同它下面整棵子树挂到另一个上级下面(总队本身不能移,也不能挂进自己的下级里)。下面所有人的归属会跟着变,按组织范围授出的管理权和分管范围也跟着变',
      sectionCode: 'organization-people',
      groupCode: 'organization-structure',
      sortOrder: 10530,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'org.read.node': {
      displayName: '查看组织架构',
      businessDescription:
        '能看到整棵组织树、每个分队/小组的资料,以及各级的人数统计;各种表单里的「所属单位」下拉也走这条',
      sectionCode: 'organization-people',
      groupCode: 'organization-structure',
      sortOrder: 10540,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'org.update.node': {
      displayName: '修改或停用分队小组',
      businessDescription:
        '改分队/小组的名称、编号、类别和排序,或者把它停用(改上级要用「调整组织归属」)。一旦停用,靠这个单位范围拿到权限的人当场就用不了了;全队唯一还在用的总队不允许停用',
      sectionCode: 'organization-people',
      groupCode: 'organization-structure',
      sortOrder: 10550,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 组织与人员 / 队员 =====
    'member.bind.account': {
      displayName: '关联 / 解除登录账号',
      businessDescription:
        '把一个已经建好、还没归到人名下的账号挂给这名队员,或者把已挂的摘下来。只认还没被别人占用、状态正常的普通队员账号;摘下来只是断开关系,账号本身不停用也不删除,还能照常登录。',
      sectionCode: 'organization-people',
      groupCode: 'member',
      sortOrder: 11010,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'ACCOUNT_SECURITY'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member.correct.identity': {
      displayName: '订正队员身份信息',
      businessDescription:
        '改队员编号、入队日期或入队来源这三样「建档时就定死的事实」。必须写订正理由,改编号还要再确认一次,改完单独留一条订正记录。改了编号,他原来的登录名不会跟着变(旧编号本身不再能登录 —— 按编号登录是查当前 Member,订正后没有任何行持有旧号;但原来那个登录名仍然有效)。',
      sectionCode: 'organization-people',
      groupCode: 'member',
      sortOrder: 11020,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'ACCOUNT_SECURITY'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member.create.record': {
      displayName: '建队员档案',
      businessDescription:
        '新建一份队员档案:编号、姓名、入队日期、入队来源、等级。编号历史永不复用(⚠️ 业务目标,尚未被完整保证 —— 身份订正会把旧号放出来,历史占号刀已拍板未落地),哪怕档案后来被删也不能再发给别人。',
      sectionCode: 'organization-people',
      groupCode: 'member',
      sortOrder: 11030,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member.delete.record': {
      displayName: '删除队员档案',
      businessDescription:
        '把整份队员档案作废,这个人不再出现在任何名单里,他的编号永久留着不能再给别人用。还在编部门里、或还绑着登录账号的会被拒绝 —— 正常离队请走「一键离队」,这个入口是给「这份档案根本不该存在」用的。',
      sectionCode: 'organization-people',
      groupCode: 'member',
      sortOrder: 11040,
      riskLevel: 'HIGH',
      riskTags: ['WRITE'],
      grantPolicy: 'SUPER_ADMIN_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'HIDDEN',
    },
    'member.grant.account': {
      displayName: '给队员开登录账号',
      businessDescription:
        '给已建档的队员开一个手机验证码登录的账号(不设密码)。同一条权限还能一次给一批人开号(一次最多 200,某个人失败不影响其他人),以及「退号重开」—— 把原来那个账号作废掉,换新手机号重开一个。',
      sectionCode: 'organization-people',
      groupCode: 'member',
      sortOrder: 11050,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'ACCOUNT_SECURITY', 'MASS_EFFECT'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member.offboard.record': {
      displayName: '一键离队',
      businessDescription:
        '一步办完离队:结束他全部的部门归属、停用登录账号并把已登录的设备踢下线、撤掉职务、分管、活动职责和所有角色。同一条权限也能先看「离队影响预检」。手上还有草稿活动、在带的活动或未来的报名时会被拦下,要先交接。之后把人改回在队,这些都不会自动还回来。',
      sectionCode: 'organization-people',
      groupCode: 'member',
      sortOrder: 11060,
      riskLevel: 'HIGH',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member.read.record': {
      displayName: '查看队员',
      businessDescription:
        '能看到队员名单、每个人的档案,以及队员选择器。还包括队员的当前标准照和受众标签(这两样后来复用了同一条权限,给了这条权限就一并给了)',
      sectionCode: 'organization-people',
      groupCode: 'member',
      sortOrder: 11070,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member.update.record': {
      displayName: '修改队员资料',
      businessDescription:
        '改队员的真实姓名、外号和等级,以及整体替换队员的受众标签(B7 起复用同一条权限)。改不了队员编号,也改不了在队 / 离队状态,那两样各有专门入口。',
      sectionCode: 'organization-people',
      groupCode: 'member',
      sortOrder: 11080,
      riskLevel: 'HIGH',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member.update.status': {
      displayName: '设为在队 / 离队',
      businessDescription:
        '把队员改成「离队」时,系统会当场执行整套离队:结束全部部门归属、停用他的登录账号并踢下线、撤掉职务分管和角色。改回「在队」只是把状态翻回来,上面这些一样都不会自动恢复,得一项项重新给。',
      sectionCode: 'organization-people',
      groupCode: 'member',
      sortOrder: 11090,
      riskLevel: 'HIGH',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 组织与人员 / 队员档案 =====
    'member-profile.create.record': {
      displayName: '建队员详细档案',
      businessDescription:
        '给队员建那份更细的档案:证件、生日、联系方式、学历、工作性质、身体情况、急救技能等。一人只能有一份,建过了再建会被拒。',
      sectionCode: 'organization-people',
      groupCode: 'member-profile',
      sortOrder: 11510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member-profile.read.record': {
      displayName: '查看队员详细档案',
      businessDescription:
        '看队员的详细档案,但只看得到不敏感的那半:证件号和手机是打码的;生日、座机、邮箱、QQ、微信、身高、体重、血型、视力、医疗备注直接看不到(显示为空)。要看这些得另配「看档案敏感信息」。',
      sectionCode: 'organization-people',
      groupCode: 'member-profile',
      sortOrder: 11520,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member-profile.read.sensitive': {
      displayName: '看档案敏感信息',
      businessDescription:
        '把队员详细档案里遮住的部分全部打开:完整证件号、完整手机号,以及生日、座机、邮箱、QQ、微信、身高、体重、血型、视力和医疗备注。这是全队最私密的一批信息,只给确实要用的人。',
      sectionCode: 'organization-people',
      groupCode: 'member-profile',
      sortOrder: 11530,
      riskLevel: 'HIGH',
      riskTags: ['READ', 'SENSITIVE_DATA'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member-profile.update.record': {
      displayName: '修改队员详细档案',
      businessDescription: '改队员详细档案里的内容,可以只改其中几项。改不了这份档案属于谁。',
      sectionCode: 'organization-people',
      groupCode: 'member-profile',
      sortOrder: 11540,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 组织与人员 / 紧急联系人 =====
    'emergency-contact.create.record': {
      displayName: '新增紧急联系人',
      businessDescription:
        '给某个队员加一位出事时能联系上的人:姓名、关系、电话必填,备用电话、住址和先后顺序可填。',
      sectionCode: 'organization-people',
      groupCode: 'emergency-contact',
      sortOrder: 12010,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'emergency-contact.delete.record': {
      displayName: '删除紧急联系人',
      businessDescription: '把某位紧急联系人从队员名下去掉,名单里不再显示。界面上没有恢复入口。',
      sectionCode: 'organization-people',
      groupCode: 'emergency-contact',
      sortOrder: 12020,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'emergency-contact.read.record': {
      displayName: '查看紧急联系人',
      businessDescription:
        '能看到队员填的紧急联系人名单。默认看到的是打过码的姓名、电话和住址(「张*」「138****1234」),要看完整的另有一条权限。',
      sectionCode: 'organization-people',
      groupCode: 'emergency-contact',
      sortOrder: 12030,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'emergency-contact.read.sensitive': {
      displayName: '看紧急联系人明文',
      businessDescription:
        '让紧急联系人的姓名、两个电话和住址不再打码,直接显示完整内容。带队处理事故真要打电话的人才配,平时看打码的就够。',
      sectionCode: 'organization-people',
      groupCode: 'emergency-contact',
      sortOrder: 12040,
      riskLevel: 'HIGH',
      riskTags: ['READ', 'SENSITIVE_DATA'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'emergency-contact.update.record': {
      displayName: '修改紧急联系人',
      businessDescription: '改某位紧急联系人的姓名、关系、电话、住址或先后顺序。',
      sectionCode: 'organization-people',
      groupCode: 'emergency-contact',
      sortOrder: 12050,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 组织与人员 / 组织归属 =====
    'member-department.clear.current': {
      displayName: '解除主部门',
      businessDescription:
        '把队员从他当前的正式(主)部门里摘出来,之后他不属于任何部门。这条归属会留在归属历史里标成「已结束」。',
      sectionCode: 'organization-people',
      groupCode: 'member-affiliation',
      sortOrder: 12510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member-department.read.current': {
      displayName: '查队员主部门',
      businessDescription: '看这名队员现在挂在哪个正式(主)部门下;没有就是空。',
      sectionCode: 'organization-people',
      groupCode: 'member-affiliation',
      sortOrder: 12520,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member-department.set.current': {
      displayName: '设置队员主部门',
      businessDescription:
        '把队员的正式(主)部门定到某个分队 / 小组。原来有主部门的,旧那条会当场结束、换成新的;跟原来是同一个则什么都不做。',
      sectionCode: 'organization-people',
      groupCode: 'member-affiliation',
      sortOrder: 12530,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'membership.end.record': {
      displayName: '结束一条组织归属',
      businessDescription:
        '把队员在某个分队 / 小组的归属结束掉,记上结束时间和是谁办的。记录留在归属历史里,不会消失。',
      sectionCode: 'organization-people',
      groupCode: 'member-affiliation',
      sortOrder: 12540,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'membership.list.record': {
      displayName: '查看组织归属',
      businessDescription:
        '看队员在各分队 / 小组的归属(主职、兼职、临时、支援,带起止时间,含已结束的历史)。同一条权限还能看全队的归属总表、某个分队的成员列表,以及归属数据的体检报告(比如一个人挂了两个主部门)。',
      sectionCode: 'organization-people',
      groupCode: 'member-affiliation',
      sortOrder: 12550,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'membership.read.record': {
      displayName: '查单条组织归属',
      businessDescription:
        '按记录号查看某一条组织归属的详情(哪个人、哪个分队、什么类型、什么任期)。',
      sectionCode: 'organization-people',
      groupCode: 'member-affiliation',
      sortOrder: 12560,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'membership.set.record': {
      displayName: '新增 / 修改组织归属',
      businessDescription:
        '给队员加一条分队 / 小组归属(主职、兼职、临时或支援),或者改已有归属的类型、起止时间和原因。同一个人在同一个组织的同一类归属只能有一条在生效,重复添加会被拒。',
      sectionCode: 'organization-people',
      groupCode: 'member-affiliation',
      sortOrder: 12570,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'membership.transfer.record': {
      displayName: '转队(归属迁移)',
      businessDescription:
        '把队员从一个分队 / 小组转到另一个,一步办完:原来那条归属当场结束,在新组织建一条同类型的新归属。原来的归属留在历史里,不会被抹掉。',
      sectionCode: 'organization-people',
      groupCode: 'member-affiliation',
      sortOrder: 12580,
      riskLevel: 'HIGH',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 组织与人员 / 职务 =====
    'position-rule.create.record': {
      displayName: '新增职务设置规则',
      businessDescription:
        '定一条「某一类单位(比如专业救援队、职能部)可以设哪个职务」的规定,同时定这个职务最多几个人、要不要先归属本单位、能不能兼任。没有这条规定,往这类单位任命这个职务会被直接挡下',
      sectionCode: 'organization-people',
      groupCode: 'position',
      sortOrder: 13010,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'position-rule.delete.record': {
      displayName: '删除职务设置规则',
      businessDescription:
        '取消「这类单位可以设这个职务」的规定,之后就不能再往这类单位任命这个职务了(已经在任的人不受影响)。删掉之后同一个「单位类别 + 职务」的组合再也建不回来了,重新添加会被判成「已存在」',
      sectionCode: 'organization-people',
      groupCode: 'position',
      sortOrder: 13020,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'position-rule.read.record': {
      displayName: '查看职务设置规则',
      businessDescription:
        '看「哪一类单位能设哪些职务、各设几个人」的全部规定,可以按单位类别、按职务、按启停状态筛',
      sectionCode: 'organization-people',
      groupCode: 'position',
      sortOrder: 13030,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'position-rule.update.record': {
      displayName: '修改职务设置规则',
      businessDescription:
        '改一条规定的人数上限、要不要先归属本单位、能不能兼任,或者把它停用。改动只管以后的任命,已经在任的人不会被清退;单位类别和职务这两项定了就不能改',
      sectionCode: 'organization-people',
      groupCode: 'position',
      sortOrder: 13040,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'position.create.definition': {
      displayName: '新增职务名目',
      businessDescription:
        '添加一个岗位名称(比如「装备管理员」),并定下它算正职/副职/干事、同一个单位能不能同时设多个人、能不能一人兼多职。新建的职务本身不带任何权限,而且要先配好「职务设置规则」才能拿它任命人',
      sectionCode: 'organization-people',
      groupCode: 'position',
      sortOrder: 13050,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'position.delete.definition': {
      displayName: '删除职务名目',
      businessDescription:
        '把一个岗位名称从名录里去掉。只要还有职务设置规则用着它就删不掉;删掉后它的标识码被永久占住、建不回同一个码,而已经在任的人不会被撤职、权限也照旧',
      sectionCode: 'organization-people',
      groupCode: 'position',
      sortOrder: 13060,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'position.read.definition': {
      displayName: '查看职务名目',
      businessDescription:
        '能看到全部岗位名称的清单和每个岗位的设置(正职/副职/干事、能不能多人、能不能兼任);表单里的「职务」下拉也走这条',
      sectionCode: 'organization-people',
      groupCode: 'position',
      sortOrder: 13070,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'position.update.definition': {
      displayName: '修改或停用职务',
      businessDescription:
        '改一个岗位的名称、类别、资历排序、多人与兼任开关,或者把它停用(标识码定了就不能改)。停用只挡以后的新任命,已经在任的人不会被撤,权限也照旧',
      sectionCode: 'organization-people',
      groupCode: 'position',
      sortOrder: 13080,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 组织与人员 / 任职 =====
    'position-assignment.create.record': {
      displayName: '任命某人担任职务',
      businessDescription:
        '让某位队员在某个分队/小组担任某个职务;系统会先查这类单位允不允许设这个职务、人数满没满、要不要先归属本单位、有没有兼任冲突。队长、部长、组长这类正职一经任命,本人就自动拿到本单位(含下级)的管理权限;副队长这类副职拿到只读查看权限',
      sectionCode: 'organization-people',
      groupCode: 'position-assignment',
      sortOrder: 13510,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'position-assignment.read.history': {
      displayName: '查看某人任职沿革',
      businessDescription:
        '从一条任职记录点进去,看这个人在这个单位的这个职务上历次任免记录(含已撤销的)。它只串同一个人,看不到这个岗位以前由谁担任过 —— 想看岗位换过哪些人,要去任职列表按单位筛',
      sectionCode: 'organization-people',
      groupCode: 'position-assignment',
      sortOrder: 13520,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'position-assignment.read.record': {
      displayName: '查看任职情况',
      businessDescription:
        '能看到谁在哪个单位担任什么职务:按单位看只列现任,按人看和全局总表会带上已结束、已撤销的记录。任命前的「预检」也归这条 —— 填好人和职务先试算会不会被规则挡下,不会真的写进去',
      sectionCode: 'organization-people',
      groupCode: 'position-assignment',
      sortOrder: 13530,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'position-assignment.revoke.record': {
      displayName: '撤销某人的任职',
      businessDescription:
        '免掉某人在某个单位的某个职务,记录保留成「已撤销」,并记下是谁撤的、什么时候撤的。这个职务带给他的管理权限或只读权限当场失效;已经结束的任职不能再撤第二次',
      sectionCode: 'organization-people',
      groupCode: 'position-assignment',
      sortOrder: 13540,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 组织与人员 / 分管 =====
    'supervision-assignment.create.record': {
      displayName: '指定分管人',
      businessDescription:
        '指派某位队员分管某个单位,默认连它下面全部下级一起管(也可以只管这一个)。被指派的人由此获得这片范围内的只读查看权(队员名单、活动报名、考勤表、证书);他不需要在那儿担任任何职务,也不会因此获得审批或修改的权力',
      sectionCode: 'organization-people',
      groupCode: 'supervision',
      sortOrder: 14010,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'supervision-assignment.read.record': {
      displayName: '查看分管关系',
      businessDescription:
        '看谁分管哪些单位、某个人的分管范围具体展开到哪几个单位、某个单位由谁分管(含从上级继承下来的)。建之前的「覆盖范围预演」也归这条 —— 先算给你看这条分管会罩住哪些单位,不会真的建',
      sectionCode: 'organization-people',
      groupCode: 'supervision',
      sortOrder: 14020,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'supervision-assignment.revoke.record': {
      displayName: '撤销某人的分管',
      businessDescription:
        '解除某人对某个单位的分管,记录保留成「已撤销」,并记下是谁撤的、什么时候撤的。他对这片范围的只读查看权当场失效;已经结束的分管不能再撤第二次',
      sectionCode: 'organization-people',
      groupCode: 'supervision',
      sortOrder: 14030,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'supervision-assignment.update.record': {
      displayName: '修改分管范围或任期',
      businessDescription:
        '调整一条分管管到哪(只管这一个单位,还是连下级一起管)、任期起止和备注。一改完可见范围立刻跟着变,把结束时间改到今天之前等于让这条分管当场失效;换人或换单位做不到,只能撤掉重建',
      sectionCode: 'organization-people',
      groupCode: 'supervision',
      sortOrder: 14040,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 组织与人员 / 标准照 =====
    'member-portrait.manage.record': {
      displayName: '管理队员标准照',
      businessDescription:
        '上传、替换或作废队员的标准照(系统会自动裁成规定尺寸并抹掉照片里的拍摄位置信息)。替换时旧照片留在历史里;作废必须写理由,作废后当前标准照就空着,不会自动退回上一张。只能管自己分管范围内的队员。',
      sectionCode: 'organization-people',
      groupCode: 'member-portrait',
      sortOrder: 14510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member-portrait.read.history': {
      displayName: '查标准照历史版本',
      businessDescription:
        '看这名队员历次的标准照,包括已被换掉和已作废的。看得见当前那张不等于看得见历史 —— 历史是单独一条权限,而且只能看,不能改。',
      sectionCode: 'organization-people',
      groupCode: 'member-portrait',
      sortOrder: 14520,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 活动与参与 / 活动 =====
    'activity.cancel.record': {
      displayName: '取消活动',
      businessDescription:
        '把草稿或已发布的活动撤掉,还在等审核和候补的人会被一起取消并收到通知,已经通过审核的报名保留下来做历史记录。已完结/已终止的活动、以及已经有人打过卡的活动,取消不了。',
      sectionCode: 'activity-participation',
      groupCode: 'activity',
      sortOrder: 20510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity.complete.record': {
      displayName: '完结活动',
      businessDescription:
        '把一场办完的活动标成「已完结」。必须等活动的结束时间过了才点得动;点完不给任何人发通知。',
      sectionCode: 'activity-participation',
      groupCode: 'activity',
      sortOrder: 20520,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity.create.cross-org': {
      displayName: '替别的分队发起活动',
      businessDescription:
        '责任制开启时，允许在获准的其他组织发起活动或调整草稿归属；同样约束模板快速、专业和紧急创建。它扩大的是可选组织范围，不代替普通或紧急创建权，也不免除有效发起人校验。责任制关闭时，旧创建保持兼容，三种新创建入口不受理。',
      sectionCode: 'activity-participation',
      groupCode: 'activity',
      sortOrder: 20530,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity.create.emergency.record': {
      displayName: '发起紧急活动',
      businessDescription:
        '在同时持有普通创建权、通过发起人及组织范围校验后，创建紧急草稿并把一次定向紧急呼叫入队；同键重试不重复呼叫。草稿不能正式发布，补齐事项也不会解除该限制，不代替事故或安全处置。仍仅超级管理员可用，不能下放给角色。',
      sectionCode: 'activity-participation',
      groupCode: 'activity',
      sortOrder: 20535,
      riskLevel: 'HIGH',
      riskTags: ['WRITE', 'MASS_EFFECT'],
      grantPolicy: 'SUPER_ADMIN_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'HIDDEN',
    },
    'activity.create.record': {
      displayName: '新建活动',
      businessDescription:
        '新建活动草稿，供后台或小程序本人管理入口使用，包括模板快速创建和专业创建；紧急创建还须另持紧急创建权。创建成功不等于正式发布，草稿不进入队员活动池。',
      sectionCode: 'activity-participation',
      groupCode: 'activity',
      sortOrder: 20540,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity.delete.record': {
      displayName: '删除活动',
      businessDescription:
        '把一场活动从系统里删掉。只有在没人报名、也没有考勤单的时候才删得掉,已经有人报名的必须先取消活动;删完后台没有恢复入口。',
      sectionCode: 'activity-participation',
      groupCode: 'activity',
      sortOrder: 20550,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity.publish.record': {
      displayName: '发布活动',
      businessDescription:
        '把草稿活动放出去,队员就能看到并报名了(含按受众标签定向发布,B7 起复用同一条权限;审核通过发布也走它)。发布时必须先勾选确认保险要求;如果这场活动是公开报名,全队会收到一条「新活动已发布」。',
      sectionCode: 'activity-participation',
      groupCode: 'activity',
      sortOrder: 20560,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE', 'MASS_EFFECT'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity.update.record': {
      displayName: '修改活动',
      businessDescription:
        '改活动的标题、时间、地点、名额这些,顺带也管活动岗位的增删改。改了时间或地点会给所有在报名的人发通知;调大名额会自动把候补的人递补进来。',
      sectionCode: 'activity-participation',
      groupCode: 'activity',
      sortOrder: 20570,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 活动与参与 / 发布审核 =====
    'activity-review.read.request': {
      displayName: '查看发布审核申请',
      businessDescription:
        '看有哪些活动正等着审批发布,以及每条申请的详情;后台首页那个「待审」的角标数也是按这项权限算的。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-publish-review',
      sortOrder: 21010,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity-review.return.request': {
      displayName: '退回发布审核申请',
      businessDescription:
        '把一条发布申请打回给发起人重改,必须写退回理由,对方会收到通知。不能退自己提交的那条。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-publish-review',
      sortOrder: 21020,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 活动与参与 / 活动责任 =====
    'activity-responsibility.override.record': {
      displayName: '强行接管活动负责人',
      businessDescription:
        '责任制开启后，按既有范围代设活动发起人、换负责人、增撤协办、补认领和归档或撤销归档；三种新创建入口代设发起人也复用此权。它不代替创建权或跨组织范围校验，不解除紧急草稿的正式发布限制。加协办会分出管理权，归档会让活动默认不在列表出现。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-responsibility',
      sortOrder: 21510,
      riskLevel: 'HIGH',
      riskTags: ['WRITE', 'WORKFLOW_INTERNAL'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 活动与参与 / 报名 =====
    'activity-registration.approve.record': {
      displayName: '报名审核通过',
      businessDescription:
        '让一条待审的报名通过,这个人就正式占住名额并收到通知。名额满了会被拦下,要求保险的活动没有有效保险也过不了。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-registration',
      sortOrder: 22010,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE', 'MASS_EFFECT'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity-registration.cancel.record': {
      displayName: '代队员取消报名',
      businessDescription:
        '替队员把他的报名取消掉,名额立刻放出来,候补队列里的下一个人会被自动递补进来。已经有考勤或签到记录的报名取消不了。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-registration',
      sortOrder: 22020,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity-registration.create.record': {
      displayName: '替队员报名',
      businessDescription:
        '以管理员身份把某个队员加进这场活动的报名(名额满了自动排进候补)。不受「是否公开报名」限制 —— 不对外开放的活动也能这样加人。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-registration',
      sortOrder: 22030,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity-registration.read.record': {
      displayName: '查看报名名单',
      businessDescription:
        '看某场活动谁报了名、各自什么状态,也能按队员查他报过哪些活动。还能把名单导出成表格(带真实姓名和队员编号),每次导出都会留痕。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-registration',
      sortOrder: 22040,
      riskLevel: 'LOW',
      riskTags: ['READ', 'MASS_EFFECT'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity-registration.reject.record': {
      displayName: '报名审核驳回',
      businessDescription: '驳回一条报名,必须写驳回理由,对方会收到通知。候补中的报名同样可以驳回。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-registration',
      sortOrder: 22050,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE', 'MASS_EFFECT'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity-registration.reopen.record': {
      displayName: '撤销驳回',
      businessDescription:
        '把误驳回的报名放回待审,原来的审核人、审核时间、驳回理由全部清空,像从没审过一样。不会直接变成通过,还得重新审一遍;这一步不发通知。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-registration',
      sortOrder: 22060,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 活动与参与 / 考勤 =====
    'attendance.create.sheet': {
      displayName: '提交考勤单',
      businessDescription:
        '给一场活动录一份考勤:谁到了、几点到几点、担任什么角色,交上去等审核。分数不用自己填 —— 系统按「活动类型 + 考勤角色」的算分规则自动算好,没有对应规则的就记 0 分;活动一旦取消就不能再交了。',
      sectionCode: 'activity-participation',
      groupCode: 'attendance',
      sortOrder: 22510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attendance.delete.sheet': {
      displayName: '删除待审考勤单',
      businessDescription:
        '把一份还没人审的考勤单连同里面所有到场记录一起撤掉。只有「等一审」的单能删,被退回或已审过的都删不了;删完在后台就找不回来了,只能重新录一份。',
      sectionCode: 'activity-participation',
      groupCode: 'attendance',
      sortOrder: 22520,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attendance.read.sheet': {
      displayName: '查看考勤与贡献数据',
      businessDescription:
        '能看考勤单列表和明细、跨活动的考勤审批工作台、活动的 GPS 打卡证据和评价打分,还有每个队员的考勤记录、服务时长和贡献值累计。这一条开的面比名字看着大得多,给只读岗位时要留意。',
      sectionCode: 'activity-participation',
      groupCode: 'attendance',
      sortOrder: 22530,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attendance.update.sheet': {
      displayName: '修改并重交考勤单',
      businessDescription:
        '改一份还没审完的考勤单(等一审的、被退回的都能改),改完还能把退回的单子重新交上去走审核。每次保存都会把原来那批到场记录整批换掉、分数按当前规则重算一遍;活动已取消就不能再动里面的记录。',
      sectionCode: 'activity-participation',
      groupCode: 'attendance',
      sortOrder: 22540,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 活动与参与 / 考勤审核 =====
    'attendance.approve.sheet': {
      displayName: '考勤一审通过',
      businessDescription:
        '确认一份考勤单没问题,把它送到终审那一步。这一步贡献值还不算数,要等终审通过才真正记到队员头上;单子里只要有一条记录没算出分就通不过,自己交的单也不能自己审。',
      sectionCode: 'activity-participation',
      groupCode: 'attendance-review',
      sortOrder: 23010,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attendance.final-approve.sheet': {
      displayName: '考勤终审通过',
      businessDescription:
        '确认一场活动的考勤无误。通过之后贡献值才真正记到队员头上,每位队员会收到一条写明本次得分的通知;贡献值刚好跨过入队门槛的人还会多收到一条达标提醒。',
      sectionCode: 'activity-participation',
      groupCode: 'attendance-review',
      sortOrder: 23020,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'FINAL_APPROVAL', 'LEDGER'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attendance.final-reject.sheet': {
      displayName: '考勤终审驳回',
      businessDescription:
        '判定这份考勤不成立(必须写理由),流程到此为止、一分贡献值都不记。里面的到场记录会一起删掉,而且这份单子之后再也不能改、不能删、不能重交,只能另起一份;系统不会通知提交人。',
      sectionCode: 'activity-participation',
      groupCode: 'attendance-review',
      sortOrder: 23030,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE', 'FINAL_APPROVAL'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attendance.final-return.sheet': {
      displayName: '考勤终审退回修改',
      businessDescription:
        '终审时觉得单子还得改,打回给提交人重填(必须写退回原因)。到场记录都留着,提交人和这场活动的考勤责任人会收到带原因的通知,改完要重新走一审、终审两道。',
      sectionCode: 'activity-participation',
      groupCode: 'attendance-review',
      sortOrder: 23040,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE', 'FINAL_APPROVAL'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attendance.reject.sheet': {
      displayName: '考勤一审驳回',
      businessDescription:
        '一审就判这份考勤不成立(必须写理由),贡献值不会产生。单子里的到场记录会跟着一起删掉,这些人这段时间随之腾出来,可以另外交一份新的;系统不会通知提交人,得自己去说一声。',
      sectionCode: 'activity-participation',
      groupCode: 'attendance-review',
      sortOrder: 23050,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attendance.reopen.sheet': {
      displayName: '撤回已通过的考勤',
      businessDescription:
        '把一份已经终审通过的考勤打回最初的等一审状态(必须写原因)。队员已经到账的贡献值和考勤记录会立刻消失,要重新走完一审、终审才回来;这一步不发任何通知,已经据此办掉的报名准入、入队晋级也不会跟着退回。',
      sectionCode: 'activity-participation',
      groupCode: 'attendance-review',
      sortOrder: 23060,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attendance.return.sheet': {
      displayName: '考勤一审退回修改',
      businessDescription:
        '一审时把单子打回给提交人重填(必须写退回原因)。到场记录都留着,提交人和这场活动的考勤责任人会收到一条带原因的通知,改完重新交上来再走一遍一审、终审。',
      sectionCode: 'activity-participation',
      groupCode: 'attendance-review',
      sortOrder: 23070,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 活动与参与 / 活动结算 =====
    'activity.settlement-close.record': {
      displayName: '关账(结算收尾)',
      businessDescription:
        '这项功能当前未启用。开启后:对一场活动点关账,系统自动跑一轮检查,全过才把这场的账封存成最终结果 —— 之后统计、评价资格、入队进度都按它算。有一项没过就一个字都不写,直接把缺口列出来给你看。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-settlement',
      sortOrder: 23510,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'LEDGER'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity.settlement-final-review.record': {
      displayName: '结算终审',
      businessDescription:
        '这项功能当前未启用。开启后:对一审通过的结算做最后一道确认,通过之后系统才开始准备把服务时长和贡献值记到每个人账上。不能审自己提交的,也不能审自己一审过的。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-settlement',
      sortOrder: 23520,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'FINAL_APPROVAL', 'LEDGER'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity.settlement-first-review.record': {
      displayName: '结算一审',
      businessDescription:
        '这项功能当前未启用。开启后:对负责人送上来的结算做第一道审,通过就往终审走,退回就让负责人改完重交。不能审自己提交的那一份。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-settlement',
      sortOrder: 23530,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'LEDGER'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity.settlement-generate.record': {
      displayName: '生成并查看结算',
      businessDescription:
        '这项功能当前未启用。开启后:按打卡记录算出一份逐人的服务时长和贡献值草稿(可以反复重算),同时也能看到这场活动每个人算了多少。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-settlement',
      sortOrder: 23540,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'LEDGER'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity.settlement-submit.record': {
      displayName: '提交结算送审',
      businessDescription:
        '这项功能当前未启用。开启后:把当前的结算草稿定稿送审。送出去这一版就锁死了,自己改不动,要改只能等审核的人退回来重走一遍。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-settlement',
      sortOrder: 23550,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'LEDGER'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'activity.settlement-update-draft.record': {
      displayName: '逐人改结算草稿',
      businessDescription:
        '这项功能当前未启用。开启后:在结算草稿里改某个人的认定(到场/请假/缺勤等)和他这次算多少服务时长、多少贡献值,每次改都必须填理由。只有还没送审的草稿改得动。',
      sectionCode: 'activity-participation',
      groupCode: 'activity-settlement',
      sortOrder: 23560,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'LEDGER'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 活动与参与 / 贡献值规则 =====
    'contribution.create.rule': {
      displayName: '新增贡献值算分规则',
      businessDescription:
        '定一条「某类活动 + 某个考勤角色 = 多少分」的算分规则,可以按服务时长分成两档给分。只对以后新交或新改的考勤生效,不会重算已经交上去的单子;同一个「活动类型 + 角色」组合只允许有一条启用中的规则,重复新增会被拒。',
      sectionCode: 'activity-participation',
      groupCode: 'contribution-rule',
      sortOrder: 24010,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'contribution.delete.rule': {
      displayName: '删除贡献值算分规则',
      businessDescription:
        '把一条算分规则撤掉,删完在后台就找不回来了。删掉之后这个「活动类型 + 角色」组合再交考勤会静悄悄按 0 分算,页面上不会有任何报错或提醒。',
      sectionCode: 'activity-participation',
      groupCode: 'contribution-rule',
      sortOrder: 24020,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'contribution.read.rule': {
      displayName: '查看贡献值算分规则',
      businessDescription:
        '看有哪些「活动类型 + 角色 = 多少分」的算分规则、每条是启用还是停用。看的是算分规则本身,不是某个队员现在有多少分。',
      sectionCode: 'activity-participation',
      groupCode: 'contribution-rule',
      sortOrder: 24030,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'contribution.update.rule': {
      displayName: '改贡献值算分规则',
      businessDescription:
        '改一条算分规则的分数、启用/停用状态或备注。只能改这几样 —— 活动类型、考勤角色、时长档位一旦定了就改不了(要换得停用旧的、另建一条);改完同样只影响以后新交的考勤。',
      sectionCode: 'activity-participation',
      groupCode: 'contribution-rule',
      sortOrder: 24040,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 证书与资质 / 证书 =====
    'certificate.create.record': {
      displayName: '录入队员证书',
      businessDescription:
        '给某位队员登记一张证书(急救证、潜水证之类)。刚录进去是「待核验」,核验通过前不算数,队员拿它报不了有资质门槛的活动。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate',
      sortOrder: 30510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'certificate.delete.record': {
      displayName: '删除队员证书',
      businessDescription:
        '把队员名下的一张证书从档案里去掉,以后查不到也用不了。已核验的证书一删,队员立刻失去这项资质,可能因此报不了有门槛的活动;后台没有恢复入口。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate',
      sortOrder: 30520,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'certificate.read.record': {
      displayName: '查看队员证书',
      businessDescription:
        '能看队员的证书列表和详情,也能用全队证书工作台(按状态、快到期、发证机构等条件筛人)。看得到哪些人,按你能管的分队范围来。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate',
      sortOrder: 30530,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'certificate.read.sensitive': {
      displayName: '查看证书原件信息',
      businessDescription:
        '在证书详情里看到完整证书编号、审核备注、审核人,并能打开队员上传的证书照片 / 证据图。每次查看都会记进审计日志。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate',
      sortOrder: 30540,
      riskLevel: 'HIGH',
      riskTags: ['READ', 'SENSITIVE_DATA'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'certificate.reject.record': {
      displayName: '证书核验不通过',
      businessDescription:
        '判定队员交的这张证书不作数,必须写明理由。驳回后这张证书不能直接再点通过 —— 要么改掉它的关键信息(改完会自动回到待核验),要么重新录一张。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate',
      sortOrder: 30550,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'certificate.update.record': {
      displayName: '修改队员证书',
      businessDescription:
        '改一张已登记证书的发证机构、证书编号、发证日期、到期日期。只要这些关键信息真的改动了,原本已核验通过的证书会自动退回「待核验」,得重新核一遍(在这期间队员等于没这项资质)。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate',
      sortOrder: 30560,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'certificate.verify.record': {
      displayName: '证书核验通过',
      businessDescription:
        '确认队员这张证书属实。通过之后这项资质才真正算数,队员才能报名有资质门槛的活动。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate',
      sortOrder: 30570,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 证书与资质 / 证书标准 =====
    'certificate-standard.create.record': {
      displayName: '新建证书标准',
      businessDescription:
        '往全队通用的证书目录里加一种证书(比如「红十字急救员证」)。新建出来是草稿,要启用、并且配好认定规则之后,才能给队员录证书。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate-standard',
      sortOrder: 31010,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'certificate-standard.delete.record': {
      displayName: '删除证书标准',
      businessDescription:
        '删掉一种全队通用的证书标准。只有从没启用过的草稿能删;下面挂了子项、认定规则、队员证书或招新申报的一律删不掉。删掉后它的编码被永久占用。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate-standard',
      sortOrder: 31020,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'certificate-standard.read.record': {
      displayName: '查看证书标准',
      businessDescription:
        '看全队通用的证书种类目录:列表、详情,以及录证书和审核时用的那个下拉选项。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate-standard',
      sortOrder: 31030,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'certificate-standard.update.record': {
      displayName: '修改证书标准',
      businessDescription:
        '改证书标准的名称、说明、排序,或者启用 / 停用它。停用之后不能再拿它录新证书,已经录好的老证书不受影响。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate-standard',
      sortOrder: 31040,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 证书与资质 / 资质认定规则 =====
    'certificate-recognition-policy.create.record': {
      displayName: '新建认定规则草稿',
      businessDescription:
        '给某个证书标准起草一版新的认可规则:认哪几家发证机构、要不要填证书编号、有效期怎么算。起草出来是草稿,不点启用就不生效,现有证书完全不受影响。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate-recognition',
      sortOrder: 31510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'certificate-recognition-policy.delete.record': {
      displayName: '删除认定规则草稿',
      businessDescription:
        '删掉一版还没启用过的规则草稿。已启用过或已退役的版本删不掉 —— 历史证书是按它认定的,删了就说不清当初凭什么认。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate-recognition',
      sortOrder: 31520,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'certificate-recognition-policy.read.record': {
      displayName: '查看证书认定规则',
      businessDescription:
        '看某个证书标准历年的认定规则版本:哪一版正在生效、认可哪些发证机构、有效期怎么算、什么时候启用和退役的。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate-recognition',
      sortOrder: 31530,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'certificate-recognition-policy.update.record': {
      displayName: '改与启用认定规则',
      businessDescription:
        '改规则草稿的内容,或把某一版正式启用 / 退役。一旦启用,原来生效的那一版会同时被自动退役,而且两版从此永久锁死不能再改;退役之后这个证书标准就没有生效规则,新证书录不进去。',
      sectionCode: 'certificate-qualification',
      groupCode: 'certificate-recognition',
      sortOrder: 31540,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 招新与入队 / 招新轮次 =====
    'recruitment-cycle.create.record': {
      displayName: '新建招新轮次',
      businessDescription:
        '开一届新招新,填年份、名称和名额上限。建出来是关着的,要再去开轮才开始收报名。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'recruitment-cycle',
      sortOrder: 40510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'recruitment-cycle.read.record': {
      displayName: '查看招新轮次',
      businessDescription:
        '看历届招新的列表和详情:名额、已发出多少临时编号、见面会信息、QQ 群、通知模板、开关时间。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'recruitment-cycle',
      sortOrder: 40520,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'recruitment-cycle.update.record': {
      displayName: '开关招新轮次',
      businessDescription:
        '打开或关闭一届招新,并改名额上限、见面会信息、QQ 群和通知模板。关掉之后新人就报不了名;同一时间只允许一届开着,要开新的必须先关上一届。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'recruitment-cycle',
      sortOrder: 40530,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 招新与入队 / 招新报名 =====
    'recruitment-application.evaluate.assessment': {
      displayName: '招新综合评定',
      businessDescription:
        '对报名人做最终评定:通过就进公示名单,不通过就淘汰。淘汰是终局 —— 这份报名下还没审完的证书申报会一并作废,人也回不到流程里。 门槛没做完的不能直接判通过。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'recruitment-application',
      sortOrder: 41010,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'recruitment-application.mark.threshold': {
      displayName: '标记招新门槛完成',
      businessDescription:
        '给报名人勾线下门槛完成情况 —— 只能勾巡山第一次、巡山第二次、培训这三项,支持按名单一次勾一批。五项门槛全齐时自动推进到待综合评定。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'recruitment-application',
      sortOrder: 41020,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE', 'MASS_EFFECT'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'recruitment-application.promote.member': {
      displayName: '批量发放队员编号',
      businessDescription:
        '把公示名单上的人按姓名拼音一次性转成正式志愿者:发永久编号、建登录账号和档案、把审核通过的证书搬进证书库,并通知本人。编号发出后不能再经招新流程修改(确属录错只能走独立的「订正队员身份信息」入口);报名表里的姓名、身份证号、手机和证件照会立刻清空,找不回来。 资料不全或微信、手机号已被占用的会自动跳过并列出来。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'recruitment-application',
      sortOrder: 41030,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'recruitment-application.promote.single': {
      displayName: '单人发放队员编号',
      businessDescription:
        '给公示名单里的某一个人单独发编号建档,专门收尾批量发号时被跳过的人。后果与批量发号完全一样:报名表里的证件信息立刻清空、找不回来;编号发出后不能再经招新流程修改,确属录入错误时只能走独立的「订正队员身份信息」入口。 生日性别没补齐、或微信和手机都已被占用的发不出去。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'recruitment-application',
      sortOrder: 41040,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'recruitment-application.read.record': {
      displayName: '查看招新报名',
      businessDescription:
        '看招新报名的名单与详情、公示名单、招新工作台的各项统计,也能把名单导成表格下载。看到的身份证号和手机号是打码的(要看完整的得另有「查看报名敏感信息」),每次查看都会留记录。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'recruitment-application',
      sortOrder: 41050,
      riskLevel: 'MEDIUM',
      riskTags: ['READ', 'MASS_EFFECT'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'recruitment-application.read.sensitive': {
      displayName: '查看报名敏感信息',
      businessDescription:
        '在报名详情和导出表格里看到完整的身份证号、手机号,并能打开身份证照片和证书照片。谁在什么时候看过都会记进审计。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'recruitment-application',
      sortOrder: 41060,
      riskLevel: 'HIGH',
      riskTags: ['READ', 'SENSITIVE_DATA'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'recruitment-application.resolve.manual': {
      displayName: '处理人工待核报名',
      businessDescription:
        '处理堆在人工待核那一栏的报名(港澳台/外籍证件、照片存疑、识别失败等):通过就发临时编号让他进入门槛流程,不通过就淘汰。淘汰是终局,这份报名下的证书申报会一并作废;本轮名额满了临时编号也发不出来。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'recruitment-application',
      sortOrder: 41070,
      riskLevel: 'MEDIUM',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'recruitment-application.review.certificate': {
      displayName: '审核报名人的证书',
      businessDescription:
        '逐张审核报名人上传的证书:通过、驳回、或退回让他补材料。通过会自动把对应的资质门槛勾上;驳回或事后撤回通过,这个门槛会被收回去。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'recruitment-application',
      sortOrder: 41080,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'recruitment-application.update.record': {
      displayName: '修改报名资料',
      businessDescription:
        '帮报名人改资料:住址、所在区、来源渠道、紧急联系人随时能改;姓名、证件号、出生日期、性别只有人工待核的、或用非大陆证件的才能改。手机号和微信绑定不在这里改,已发编号的报名也改不动。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'recruitment-application',
      sortOrder: 41090,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 招新与入队 / 入队轮次 =====
    'team-join-cycle.create.record': {
      displayName: '新建入队轮次',
      businessDescription:
        '开一届新入队,填年份、名称,并指定这一轮开放哪些部门当候选、每人最多能选几个、是否要求先有保险。建出来是关着的,要再开轮才开始收申请。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'team-join-cycle',
      sortOrder: 41510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'team-join-cycle.read.record': {
      displayName: '查看入队轮次',
      businessDescription:
        '看历届入队的列表和详情:开放的候选部门、每人可选部门数上限、是否要求保险、开关时间。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'team-join-cycle',
      sortOrder: 41520,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'team-join-cycle.update.record': {
      displayName: '开关入队轮次',
      businessDescription:
        '打开或关闭一届入队,并改轮次名、开放的候选部门清单、每人可选部门数上限和是否要求保险。关掉之后新人报不了名;同一时间只允许一届开着。 已经评估通过的人不受关轮影响,照样能办入队。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'team-join-cycle',
      sortOrder: 41530,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 招新与入队 / 入队申请 =====
    'team-join-application.evaluate.assessment': {
      displayName: '入队综合评估',
      businessDescription:
        '对志愿者的入队申请做最终评估:通过进「待入队」,不通过就淘汰。通过时会再核一遍八项考核和贡献值是否还在有效期内,过期了判不了通过。淘汰是终局。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'team-join-application',
      sortOrder: 42010,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'team-join-application.join.member': {
      displayName: '办理正式入队',
      businessDescription:
        '把评估通过的志愿者正式收进队伍:挂到选定的部门、级别升为队员、结束原来的志愿者归口,并通知本人。办完之后,这个人名下其它还在走流程的入队申请会被一并作废。 只能选他申请时填的候选部门,选专业队还要对应的专业考核已通过。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'team-join-application',
      sortOrder: 42020,
      riskLevel: 'HIGH',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'team-join-application.mark.gate': {
      displayName: '标记入队考核',
      businessDescription:
        '给入队申请勾考核结果:八项通用考核(体能、初级救援培训、军训、心理测试、部门面试、部门考核、入队普考、中级户外资质)加四支专业队考核,填通过与否和完成日期,部门考核还能另给一个延长期。完成日期不能填将来的;八项全过且贡献值满 5 分时自动推进到待综合评估。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'team-join-application',
      sortOrder: 42030,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'team-join-application.read.record': {
      displayName: '查看入队申请',
      businessDescription:
        '看入队申请的名单和详情,详情里能看到每一项考核的通过情况和有效期,以及这个人此刻实时算出来的贡献值。',
      sectionCode: 'recruitment-enrollment',
      groupCode: 'team-join-application',
      sortOrder: 42040,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 保险 / 团队保单 =====
    'team-insurance-policy.add.member': {
      displayName: '保单名单加人',
      businessDescription:
        '把队员加进某张队统一保单的被保名单,可以一个一个加,也可以「全体在册队员一键加」。加进去且在保单有效期内的人,才算有保险,才能报名要求有保险的活动。',
      sectionCode: 'insurance',
      groupCode: 'team-insurance-policy',
      sortOrder: 50510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE', 'MASS_EFFECT'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'team-insurance-policy.create.record': {
      displayName: '新建队统一保单',
      businessDescription:
        '登记一张队里统一买的保单:保险公司、保单号、起保日、到期日、备注,一张实际保单记一条。刚建好时被保名单是空的,还要把队员加进名单才算真的保上。',
      sectionCode: 'insurance',
      groupCode: 'team-insurance-policy',
      sortOrder: 50520,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'team-insurance-policy.delete.record': {
      displayName: '删除队统一保单',
      businessDescription:
        '把一张队统一保单作废。靠它上保的队员立刻不再算「有保险」 —— 报不了要求有保险的活动,已经交上来还没审的报名也会审不过;后台没有恢复入口。',
      sectionCode: 'insurance',
      groupCode: 'team-insurance-policy',
      sortOrder: 50530,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'team-insurance-policy.read.record': {
      displayName: '查看队统一保单',
      businessDescription: '看队里统一买的保单列表和详情,以及每张保单覆盖了哪些队员。',
      sectionCode: 'insurance',
      groupCode: 'team-insurance-policy',
      sortOrder: 50540,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'team-insurance-policy.remove.member': {
      displayName: '保单名单移人',
      businessDescription:
        '把某位队员从一张队统一保单的名单里去掉。去掉之后他就不再靠这张保单算「有保险」,可能因此报不了要求保险的活动,他待审核的报名也会审不过;需要的话以后还能再加回来。',
      sectionCode: 'insurance',
      groupCode: 'team-insurance-policy',
      sortOrder: 50550,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'team-insurance-policy.update.record': {
      displayName: '修改队统一保单',
      businessDescription:
        '改一张队统一保单的保险公司、保单号、起保 / 到期日期和备注。把保障期改窄,原本在保的人在某些活动上会突然不算有保险,报名审核会卡住。',
      sectionCode: 'insurance',
      groupCode: 'team-insurance-policy',
      sortOrder: 50560,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 保险 / 队员投保 =====
    'member-insurance.read.other': {
      displayName: '查看队员保险',
      businessDescription:
        '看某名队员自己买的保险记录,以及他的保险总览(个人保单 + 队里统一给他上的那份)。队员看自己的不需要这条权限。',
      sectionCode: 'insurance',
      groupCode: 'member-insurance',
      sortOrder: 51010,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'member-insurance.review.record': {
      displayName: '审核队员保险',
      businessDescription:
        '给队员自己传上来的保单记一个「通过」或「不通过」。通过之后这份保险才算数,他才报得了那些要求有保险的活动;审过一次就改不了,除非队员自己回去改保单资料重新提交。',
      sectionCode: 'insurance',
      groupCode: 'member-insurance',
      sortOrder: 51020,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 内容与通知 / 内容 =====
    'content.create.record': {
      displayName: '新建文章草稿',
      businessDescription:
        '建一篇新文章(公告、公示、简报、推文这类),建好先是草稿,队员看不到。必须先建出草稿,才能往里传封面和正文图片。',
      sectionCode: 'content-notification',
      groupCode: 'content',
      sortOrder: 60510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'content.delete.record': {
      displayName: '删除文章',
      businessDescription:
        '把一篇文章从后台和 App 里去掉,草稿 / 已发布 / 已归档都能删。后台没有恢复入口,删了就找不回来了。',
      sectionCode: 'content-notification',
      groupCode: 'content',
      sortOrder: 60520,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'content.publish.record': {
      displayName: '发布 / 撤回 / 归档文章',
      businessDescription:
        '三个动作合用一条权限,都是点完立刻生效:发布 = 让队员看到;撤回 = 变回草稿,队员立刻看不到;归档 = 终点,归档之后既改不了、也发不回去,队员同样看不到。这三个动作不发任何消息和短信。',
      sectionCode: 'content-notification',
      groupCode: 'content',
      sortOrder: 60530,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'content.read.record': {
      displayName: '后台查看文章',
      businessDescription:
        '在后台看全部文章,草稿和已归档的也能看到。另外,持有这条权限的人在 App 里会额外看到「仅管理层可见」那一档文章 —— 给谁这条权限等于给他一层额外的阅读范围。',
      sectionCode: 'content-notification',
      groupCode: 'content',
      sortOrder: 60540,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'content.update.record': {
      displayName: '编辑文章内容',
      businessDescription:
        '改标题、正文、可见范围,以及设置或清掉封面。草稿和已发布的都能改,改完已发布的文章队员马上看到新版本(不需要再点一次发布);已归档的改不了。',
      sectionCode: 'content-notification',
      groupCode: 'content',
      sortOrder: 60550,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 内容与通知 / 通知 =====
    'notification.create.record': {
      displayName: '新建通知草稿',
      businessDescription:
        '写一条新通知,建好是草稿,队员还看不到。建的时候勾要走哪些渠道(站内必发,可另勾微信、企业微信、短信)。勾上渠道不等于已经发了 —— 还要再点「发布」或「群发短信」。',
      sectionCode: 'content-notification',
      groupCode: 'notification',
      sortOrder: 61010,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'notification.delete.record': {
      displayName: '删除通知',
      businessDescription:
        '把一条通知去掉,草稿 / 已发布 / 已归档都能删。后台没有恢复入口。系统自动发给某个人的定向通知不归这里管,删不了。',
      sectionCode: 'content-notification',
      groupCode: 'notification',
      sortOrder: 61020,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'notification.publish.record': {
      displayName: '发布 / 撤回 / 归档通知',
      businessDescription:
        '发布后队员在 App 里就能看到;如果这条通知建的时候勾了微信或企业微信渠道,发布会同时把对应消息推出去(企业微信还得后台开关是开的)。发布不会发短信 —— 短信是另一个单独的动作。撤回 = 变回草稿,队员立刻看不到(谁读过的记录保留);归档是终点,归档后改不回去。',
      sectionCode: 'content-notification',
      groupCode: 'notification',
      sortOrder: 61030,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE', 'MASS_EFFECT'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'notification.read.record': {
      displayName: '后台查看通知',
      businessDescription:
        '在后台看全部通知,草稿和已归档的也能看,并能看到每条被多少人读过。也用来查各类通知配的是哪个微信模板。',
      sectionCode: 'content-notification',
      groupCode: 'notification',
      sortOrder: 61040,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'notification.replay.wecom': {
      displayName: '重发企业微信消息',
      businessDescription:
        '系统自动发给某个人的企业微信消息没送到时,手动再发一次。默认只放行两种失败:被限流、对方接口出错;已经发成功的、正在发的、从来没发过的一律拒绝。要越过这个限制得显式勾「强制重发」,谁强制过会记进操作日志。',
      sectionCode: 'content-notification',
      groupCode: 'notification',
      sortOrder: 61050,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE', 'MASS_EFFECT'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'notification.send.sms': {
      displayName: '群发短信',
      businessDescription:
        '给一批队员发真实短信(紧急召集用)。会产生话费,发之前系统会让你再确认一次人数。',
      sectionCode: 'content-notification',
      groupCode: 'notification',
      sortOrder: 61060,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE', 'MASS_EFFECT'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'notification.update.record': {
      displayName: '修改通知内容',
      businessDescription:
        '改标题、正文、通知类型、可见范围或渠道勾选。如果这条通知已经发布了,一改就会自动退回草稿 —— 队员立刻看不到,必须再点一次「发布」才重新出现。已归档的改不了。',
      sectionCode: 'content-notification',
      groupCode: 'notification',
      sortOrder: 61070,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'notification.update.template': {
      displayName: '配微信通知模板',
      businessDescription:
        '给每种通知类型填上微信小程序那边审批下来的模板 ID,并决定这类通知走不走微信推送。保存时如果不填模板 ID,就等于把原来填的清空了,那一类通知的微信推送随即停掉;备注同理。',
      sectionCode: 'content-notification',
      groupCode: 'notification',
      sortOrder: 61080,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 内容与通知 / 公告导入 =====
    'announcement-import.execute.record': {
      displayName: '执行公告导入',
      businessDescription:
        '按整理好的公告表格真的建组、任命职务、指定分管。同一份表可以重复跑,已经建好的会自动跳过;某一行有问题只有那一行不落库,其它行照常执行。建议先跑一次「预览」再执行。',
      sectionCode: 'content-notification',
      groupCode: 'announcement-import',
      sortOrder: 61510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE', 'MASS_EFFECT'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'announcement-import.preview.record': {
      displayName: '预览公告导入',
      businessDescription:
        '拿公告表格空跑一遍,逐行告诉你「能建 / 已经有了 / 建不了(附原因)/ 要人工确认」。全程不写库,可以放心反复试。',
      sectionCode: 'content-notification',
      groupCode: 'announcement-import',
      sortOrder: 61520,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 附件与存储 / 附件 =====
    'attachment.delete.activity': {
      displayName: '删除活动照片',
      businessDescription:
        '把某场活动的现场照或封面图彻底删掉,文件找不回来。系统不检查这张图是不是正被别处用着,删了就是删了',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70510,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'DESTRUCTIVE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.delete.certificate.other': {
      displayName: '删除他人的证书照片',
      businessDescription:
        '把别人资质证书(急救证等)的照片凭证彻底删掉,文件找不回来,那本证书就没有照片凭证了',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70520,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'DESTRUCTIVE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.delete.certificate.self': {
      displayName: '删除本人的证书照片',
      businessDescription: '把自己资质证书的照片凭证彻底删掉,文件找不回来',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70530,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'DESTRUCTIVE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.delete.content-file': {
      displayName: '删除文章附件文件',
      businessDescription:
        '把文章里挂的 PDF / Word / Excel 等文件彻底删掉,文件找不回来。只有文章还是草稿、且这个文件没被正文引用时才删得掉,另外还得有内容编辑权限',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70540,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'DESTRUCTIVE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.delete.content-image': {
      displayName: '删除文章图片',
      businessDescription:
        '把文章的封面图或正文配图彻底删掉,文件找不回来。只有文章还是草稿、且这张图既没当封面也没插进正文时才删得掉,另外还得有内容编辑权限',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70550,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'DESTRUCTIVE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.delete.member.other': {
      displayName: '删除他人的证件照片',
      businessDescription: '把别人上传的身份证等证件照片彻底删掉,文件找不回来',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70560,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'DESTRUCTIVE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.delete.member.self': {
      displayName: '删除本人的证件照片',
      businessDescription: '把自己上传的身份证等证件照片彻底删掉,文件找不回来',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70570,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'DESTRUCTIVE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.update.activity': {
      displayName: '改活动照片信息',
      businessDescription:
        '改活动照片的说明、标签和有效期,不换文件本身。有效期一旦改到过去的时间,这张图就打不开了(文件还在,只是系统不再给下载链接)',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70580,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.update.certificate.other': {
      displayName: '改他人证书照片信息',
      businessDescription:
        '改别人证书照片的说明、标签和有效期,不换文件本身。有效期改到过去,这张图就打不开了;里面的「访问级别」只是个标记,改它不影响谁能看',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70590,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.update.certificate.self': {
      displayName: '改本人证书照片信息',
      businessDescription:
        '改自己证书照片的说明、标签和有效期,不换文件本身。有效期改到过去,这张图就打不开了',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70600,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.update.member.other': {
      displayName: '改他人证件照片信息',
      businessDescription:
        '改别人证件照片的说明、标签和有效期,不换文件本身。有效期改到过去,这张图就打不开了;「访问级别」只是个标记,改它不影响谁能看',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70610,
      riskLevel: 'HIGH',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.update.member.self': {
      displayName: '改本人证件照片信息',
      businessDescription:
        '改自己证件照片的说明、标签和有效期,不换文件本身。有效期改到过去,这张图就打不开了',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70620,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.upload.activity': {
      displayName: '上传活动照片',
      businessDescription: '给某场活动传现场照或封面图',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70630,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.upload.certificate.other': {
      displayName: '上传他人的证书照片',
      businessDescription: '替别人的资质证书传照片凭证(比如帮队员补传急救证照片)',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70640,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.upload.certificate.self': {
      displayName: '上传本人的证书照片',
      businessDescription: '给自己的资质证书传照片凭证',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70650,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.upload.content-file': {
      displayName: '上传文章附件文件',
      businessDescription: '给文章挂 PDF / Word / Excel 等文件,供读者下载',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70660,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.upload.content-image': {
      displayName: '上传文章图片',
      businessDescription: '给文章传封面图,或正文里要插的配图',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70670,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.upload.member.other': {
      displayName: '上传他人的证件照片',
      businessDescription:
        '替别人往档案里传身份证等证件照片。这是全队最敏感的一类照片,传错人等于把证件挂到了别人名下',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70680,
      riskLevel: 'HIGH',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.upload.member.self': {
      displayName: '上传本人的证件照片',
      businessDescription: '给自己的档案传身份证等证件照片',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70690,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.view.activity': {
      displayName: '查看活动照片',
      businessDescription: '能看到活动的现场照和封面图,并拿到一个有时效的下载链接',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70700,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.view.certificate.other': {
      displayName: '查看他人的证书照片',
      businessDescription:
        '能看到别人资质证书的照片凭证。在证书页面上看证据图,还得另外持有「查看证书敏感信息」那条权限',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70710,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.view.certificate.self': {
      displayName: '查看本人的证书照片',
      businessDescription: '能看到自己资质证书的照片凭证',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70720,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.view.member.other': {
      displayName: '查看他人的证件照片',
      businessDescription: '能看到别人的身份证等证件照片 —— 这是全队最敏感的一类照片,给谁要想清楚',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70730,
      riskLevel: 'LOW',
      riskTags: ['READ', 'SENSITIVE_DATA'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'attachment.view.member.self': {
      displayName: '查看本人的证件照片',
      businessDescription: '能看到自己上传的身份证等证件照片',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment',
      sortOrder: 70740,
      riskLevel: 'LOW',
      riskTags: ['READ', 'SENSITIVE_DATA'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 附件与存储 / 附件类型配置 =====
    'attachment-config.create.mime': {
      displayName: '新增可传的文件格式',
      businessDescription:
        '给某一类附件多开一种能上传的文件格式(比如允许资质证书传 PDF)。可执行文件、压缩包、网页文件、视频是系统写死禁掉的,配了也传不上来',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment-config',
      sortOrder: 71010,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'attachment-config.create.size-limit': {
      displayName: '设置文件大小上限',
      businessDescription:
        '给某一类附件定一个单个文件的大小上限,超过就传不上去。每类附件只能有一条',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment-config',
      sortOrder: 71020,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'attachment-config.create.type': {
      displayName: '新增附件类别',
      businessDescription:
        '新开一类可以挂附件的东西(比如「队员证件照」「活动照片」),同时定好它默认允许的格式和大小',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment-config',
      sortOrder: 71030,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'attachment-config.delete.mime': {
      displayName: '撤掉某种文件格式',
      businessDescription:
        '不再允许某一类附件上传这种格式(除非它本来就写在这类附件的默认格式里)。已经有人用这种格式传过文件时撤不掉',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment-config',
      sortOrder: 71040,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'attachment-config.delete.size-limit': {
      displayName: '撤掉文件大小上限',
      businessDescription:
        '让某一类附件回到类别自带的默认上限。这个类别下只要还有任何一个附件,就撤不掉',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment-config',
      sortOrder: 71050,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'attachment-config.delete.type': {
      displayName: '停用整类附件',
      businessDescription:
        '把一整类附件(比如「队员证件照」)整个停掉。停掉之后这类附件再也传不上来,页面上查这类附件时会直接报错而不是显示「没有」。这类下已经有附件时停不掉',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment-config',
      sortOrder: 71060,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'attachment-config.read.mime': {
      displayName: '查看文件格式规则',
      businessDescription: '看每一类附件各自额外允许了哪些文件格式',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment-config',
      sortOrder: 71070,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'attachment-config.read.size-limit': {
      displayName: '查看文件大小上限',
      businessDescription: '看每一类附件的单个文件大小上限',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment-config',
      sortOrder: 71080,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'attachment-config.read.type': {
      displayName: '查看附件类别',
      businessDescription: '看系统里有哪些附件类别,以及各自默认允许的格式和大小',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment-config',
      sortOrder: 71090,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'attachment-config.update.mime': {
      displayName: '改文件格式规则',
      businessDescription:
        '改一条格式规则的备注,或者把它停用 / 重新启用。停用等于以后这种格式传不上来;已经有人用这种格式传过文件时停不掉',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment-config',
      sortOrder: 71100,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'attachment-config.update.size-limit': {
      displayName: '改文件大小上限',
      businessDescription:
        '把某一类附件的单个文件大小上限调大或调小。调小之后,超过新上限的文件就传不上来了(已经传上去的不受影响)',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment-config',
      sortOrder: 71110,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'attachment-config.update.type': {
      displayName: '改附件类别设置',
      businessDescription:
        '改一类附件的显示名、默认格式、默认大小上限,或者把这一整类停用 / 重新启用。停用之后这类附件就传不上来了;这类下已经有附件时停不掉',
      sectionCode: 'attachment-storage',
      groupCode: 'attachment-config',
      sortOrder: 71120,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 系统与安全 / 用户账号 =====
    'user.create.account': {
      displayName: '新建登录账号',
      businessDescription:
        '开一个新的后台登录账号(用户名 + 初始密码)。新号只是个登录账号,不会自动建队员档案,也不带任何角色和权限,能力要另外发;谁都不能用这个入口造出超级管理员,管理员建号更是只能建普通用户。',
      sectionCode: 'system-security',
      groupCode: 'user-account',
      sortOrder: 80510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE', 'ACCOUNT_SECURITY'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'user.delete.account': {
      displayName: '删除登录账号',
      businessDescription:
        '把一个账号停掉并标记删除:对方立刻登不进来,在线会话当场失效,同时解除他绑定的企业微信(那个企业微信号被释放,可以给别人绑)。账号本身没有还原入口;不能删自己,也不能删掉最后一个超级管理员或最后一个运营管理员。',
      sectionCode: 'system-security',
      groupCode: 'user-account',
      sortOrder: 80520,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE', 'ACCOUNT_SECURITY'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'user.phone.clear': {
      displayName: '解绑他人手机号',
      businessDescription:
        '把某人账号上绑的手机号清掉(验证状态一起清空),之后他不能再用这个手机号登录,要重新绑。清完对方在线会话会失效,得重新登录;本来就没绑手机号时点了不报错。',
      sectionCode: 'system-security',
      groupCode: 'user-account',
      sortOrder: 80530,
      riskLevel: 'HIGH',
      riskTags: ['WRITE', 'ACCOUNT_SECURITY'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'user.read.account': {
      displayName: '查看登录账号',
      businessDescription:
        '能看到后台账号的名单和详情(用户名、邮箱、手机号、状态、关联的队员)。看得到多少取决于自己的级别:管理员只能看到普通用户的账号,超级管理员才看得到全部。',
      sectionCode: 'system-security',
      groupCode: 'user-account',
      sortOrder: 80540,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'user.reset.password': {
      displayName: '重置他人登录密码',
      businessDescription: '把别人的密码改掉。对方原来的密码立刻失效,已登录的设备也会被踢下线',
      sectionCode: 'system-security',
      groupCode: 'user-account',
      sortOrder: 80550,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'ACCOUNT_SECURITY', 'CREDENTIAL'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'user.update.account': {
      displayName: '改他人账号资料',
      businessDescription:
        '改别人的邮箱、昵称、头像。用户名、密码、系统级别、启停状态这四样都改不了,各有各的入口;管理员只能改普通用户的资料。',
      sectionCode: 'system-security',
      groupCode: 'user-account',
      sortOrder: 80560,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'user.update.role': {
      displayName: '改他人的系统级别',
      businessDescription:
        '把一个人在系统里的级别改成「管理员」或「普通用户」。这是全系统最危险的操作之一 —— 只有超级管理员能做,普通角色一律拿不到,连运营管理员也拿不到;系统永远不允许把任何人升成超级管理员,不许改自己,也不许把最后一个超级管理员降下来。',
      sectionCode: 'system-security',
      groupCode: 'user-account',
      sortOrder: 80570,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'ACCOUNT_SECURITY', 'CONTROL_PLANE'],
      grantPolicy: 'SUPER_ADMIN_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'HIDDEN',
    },
    'user.update.status': {
      displayName: '启用 / 停用账号',
      businessDescription:
        '把一个账号停掉或重新启用。一停用,对方立刻登不进来、在线会话当场失效;不能停用自己,也不能停掉最后一个超级管理员或运营管理员,账号关联的队员已离队时也没法把账号改回启用。',
      sectionCode: 'system-security',
      groupCode: 'user-account',
      sortOrder: 80580,
      riskLevel: 'HIGH',
      riskTags: ['WRITE', 'ACCOUNT_SECURITY'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'user.wechat.clear': {
      displayName: '解绑他人微信',
      businessDescription:
        '把某人账号上绑的微信清掉,之后他不能再用微信登录,要重新绑。清完对方在线会话会失效,得重新登录;本来就没绑时点了不报错。',
      sectionCode: 'system-security',
      groupCode: 'user-account',
      sortOrder: 80590,
      riskLevel: 'HIGH',
      riskTags: ['WRITE', 'ACCOUNT_SECURITY'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    'user.wecom.clear': {
      displayName: '解绑他人企业微信',
      businessDescription:
        '解除某人和企业微信账号的绑定 —— 这是唯一的解绑入口,而且不能直接转给别人(只能先解绑,再让新的人自己重新走一遍绑定)。解绑后他不能再用企业微信登录,在线会话当场失效;本来就没绑时点了不报错。',
      sectionCode: 'system-security',
      groupCode: 'user-account',
      sortOrder: 80600,
      riskLevel: 'HIGH',
      riskTags: ['WRITE', 'ACCOUNT_SECURITY'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'DEFAULT',
    },
    // ===== 系统与安全 / 角色 =====
    'rbac.role-permission.create': {
      displayName: '给角色加权限',
      businessDescription:
        '让某个角色多一项能力。加错了等于给一批人开了不该开的口子。⚠️ 现在改角色权限**只有整批保存一种做法**:一次提交这个角色应当拥有的全部能力,系统按差集算出这次加了哪些、撤了哪些(2026-08-24 起,原先那种「单独加一条 / 单独撤一条」的旧做法已停用)。因此本条**必须与「撤销角色的权限」一起持有**才动得了角色权限 —— 只有其中一条的人什么都改不了。另外,「按保存前先看一眼这次改动会加哪些、撤哪些能力」那个**只读预览**也归这条管,同样要两条齐全;它给出的结论与真保存出自同一段判断,不会出现「预览说能过、保存却被拒」。',
      sectionCode: 'system-security',
      groupCode: 'role',
      sortOrder: 81010,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'rbac.role-permission.delete': {
      displayName: '撤销角色的权限',
      businessDescription:
        '把某个角色的能力收回来。这个角色下的所有人立刻少一项能力,撤错了会让一批人当场干不了活。⚠️ 现在改角色权限**只有整批保存一种做法**:「撤一项」= 保存一份不含它的能力清单(2026-08-24 起,原先那种「按权限点单独撤一条」的旧做法已停用)。因此本条**必须与「给角色加权限」一起持有**才动得了角色权限 —— 只有其中一条的人什么都改不了。另外,「按保存前先看一眼这次改动会加哪些、撤哪些能力」那个**只读预览**也归这条管,同样要两条齐全。',
      sectionCode: 'system-security',
      groupCode: 'role',
      sortOrder: 81020,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'rbac.role.create': {
      displayName: '新建一个角色',
      businessDescription:
        '建一个新角色(比如「装备管理员」)。刚建出来是空的,要再给它配权限、再把人绑上去才起作用;角色代号一旦用过就永久占住,哪怕角色后来被删,同一个代号也不能再用。',
      sectionCode: 'system-security',
      groupCode: 'role',
      sortOrder: 81030,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'rbac.role.delete': {
      displayName: '删除一个角色',
      businessDescription:
        '把一个角色标记为已删除。这个角色下所有人立刻失去它带来的全部权限,而且后台没有恢复入口、代号也不能再用。系统内置的 15 个角色(运营管理员、业务管理员、队员等)删不掉,只有运营自己建的角色能删。',
      sectionCode: 'system-security',
      groupCode: 'role',
      sortOrder: 81040,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'rbac.role.read': {
      displayName: '查看角色清单',
      businessDescription:
        '能看到全部角色的清单,以及每个角色具体带了哪些权限。单个角色的权限清单另有一个**专门的只读入口**,一次给出它当前带的全部权限码、权限集的版本号(改权限时要带上它,免得两个人同时改把对方的改动冲掉),以及这个角色的权限能不能在后台改、不能改是什么原因 —— 系统内置的那 15 个角色照样看得到,只是标着不可改。后台各处把「角色 id」显示成角色名,靠的也是这条。只是看,不改。',
      sectionCode: 'system-security',
      groupCode: 'role',
      sortOrder: 81050,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'rbac.role.update': {
      displayName: '改角色名和说明',
      businessDescription:
        '只能改角色的显示名和说明文字。角色代号改不了,它带的权限也不在这里改(那要走「给角色加权限 / 撤销角色的权限」)。',
      sectionCode: 'system-security',
      groupCode: 'role',
      sortOrder: 81060,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 系统与安全 / 权限点 =====
    'rbac.permission.create': {
      displayName: '新增权限项',
      businessDescription:
        '兼容入口,正常情况下用不上。 本系统不允许从后台凭空造新权限码 —— 权限码必须先随代码进入权限目录并发版(#1137 起,目录外的码直接被拒)。目录内的码本来就已经存在,再建会报重复。⇒ 健康的库里这个入口基本不会成功。',
      sectionCode: 'system-security',
      groupCode: 'permission',
      sortOrder: 81510,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'rbac.permission.delete': {
      displayName: '删除权限项',
      businessDescription:
        '只能清理历史遗留的目录外权限项。 系统正式登记的 237 条权限码禁止从后台删除,超级管理员也不能(#1137 起)。〔历史事故留档:此前 Permission 是物理删且级联清 RolePermission —— 实测删掉「查看队员」后 4 个角色同一时刻失去该权限;#1137 已把这条路堵死。〕结果是那个功能对所有人关闭,只剩超级管理员还能用;就算把权限项重新建一遍,原来那些角色授权也补不回来,得一个个重发。',
      sectionCode: 'system-security',
      groupCode: 'permission',
      sortOrder: 81520,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== Integration Foundation v1 PR2(P1-30;规格书 §35):ServicePrincipal 控制面 =====
    'service-principal.create.record': {
      displayName: '创建服务主体',
      businessDescription:
        '新建一个机器身份(代表某个外部系统或自动化任务)。系统自动生成永不复用的 clientId;创建后默认启用,还需要再给它发凭证才能换 Token。这是接入外部系统的第一步。',
      sectionCode: 'system-security',
      groupCode: 'integration',
      sortOrder: 84510,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CREDENTIAL'],
      grantPolicy: 'ROLE_ALLOWLIST_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'service-principal.read.record': {
      displayName: '查看服务主体',
      businessDescription:
        '看服务主体列表和详情,包括它的名称、状态、属主组织;也能看它的凭证元数据列表(只剩创建时间和撤销状态,任何情况下都看不到原始 Secret 或哈希)。',
      sectionCode: 'system-security',
      groupCode: 'integration',
      sortOrder: 84520,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'ROLE_ALLOWLIST_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'service-principal.update.record': {
      displayName: '改服务主体资料',
      businessDescription:
        '修改服务主体的名称、描述或属主组织。不能改 clientId(那个是永久身份标识);也不能在这里改状态(启用/停用走独立的开关)。',
      sectionCode: 'system-security',
      groupCode: 'integration',
      sortOrder: 84530,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'ROLE_ALLOWLIST_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'service-principal.update.status': {
      displayName: '启用/停用服务主体',
      businessDescription:
        '把服务主体在启用和停用之间切换。停用后它持有的所有 Token 立即失效(下一次请求就被拒绝),但绑定和委托关系都保留;重新启用即恢复。这是泄露或误配时的第一道止血开关。',
      sectionCode: 'system-security',
      groupCode: 'integration',
      sortOrder: 84540,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CREDENTIAL'],
      grantPolicy: 'ROLE_ALLOWLIST_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'service-principal.create.credential': {
      displayName: '为服务主体发凭证',
      businessDescription:
        '给服务主体新建一对凭证。原始 Secret 只在创建成功那一次的响应里出现,之后任何接口都看不到;每个服务主体同时最多 2 条有效凭证,支持不停机轮换。',
      sectionCode: 'system-security',
      groupCode: 'integration',
      sortOrder: 84550,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CREDENTIAL'],
      grantPolicy: 'ROLE_ALLOWLIST_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'service-principal.revoke.credential': {
      displayName: '撤销服务主体凭证',
      businessDescription:
        '把某条凭证标记为已撤销。撤销后用它换过的所有 Token 立即失效;已撤销的凭证不能恢复,只能重新发一条新的。怀疑 Secret 泄露时的正确做法就是先撤销凭证。',
      sectionCode: 'system-security',
      groupCode: 'integration',
      sortOrder: 84560,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CREDENTIAL'],
      grantPolicy: 'ROLE_ALLOWLIST_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== Integration Foundation v1 PR5:Delegation 控制面(规格书 §36)=====
    'delegation-grant.create.record': {
      displayName: '创建委托',
      businessDescription:
        '系统委托控制面的创建操作：允许某个服务主体在指定权限、指定范围、指定期限内代表某个真人操作。创建后立即生效;GLOBAL 委托只允许超管创建,普通运营只能授予有边界的组织/活动/资源范围。',
      sectionCode: 'system-security',
      groupCode: 'integration',
      sortOrder: 84570,
      riskLevel: 'CRITICAL',
      riskTags: ['CONTROL_PLANE', 'CREDENTIAL', 'WRITE'],
      grantPolicy: 'ROLE_ALLOWLIST_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'delegation-grant.read.record': {
      displayName: '查看委托',
      businessDescription:
        '系统委托控制面的列表和详情读取：看谁委托谁、哪些权限、什么范围、什么时候到期。只是看,不能改。',
      sectionCode: 'system-security',
      groupCode: 'integration',
      sortOrder: 84580,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'ROLE_ALLOWLIST_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'delegation-grant.revoke.record': {
      displayName: '撤销委托',
      businessDescription:
        '系统委托控制面的撤销操作：把某条委托标记为已撤销。撤销后用它换的 Delegated Token 立即失效;已撤销的不能恢复。人员变动或怀疑滥用时的止血开关。',
      sectionCode: 'system-security',
      groupCode: 'integration',
      sortOrder: 84590,
      riskLevel: 'CRITICAL',
      riskTags: ['CONTROL_PLANE', 'CREDENTIAL', 'WRITE'],
      grantPolicy: 'ROLE_ALLOWLIST_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'rbac.permission.read': {
      displayName: '查看权限清单',
      businessDescription:
        '能看到系统里全部权限项的清单,可以按模块或资源类型筛选;也能打开**权限目录** —— 按业务区分组、带每条权限的中文名、人话说明、风险等级与授予策略,等于一张系统能力全景图。只是看,不改。',
      sectionCode: 'system-security',
      groupCode: 'permission',
      sortOrder: 81530,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'rbac.permission.update': {
      displayName: '改权限项的说明',
      businessDescription:
        '只能改这条权限项的说明文字(就是本表这类文案)。权限码本身、归属模块、动作都改不了,改说明也不影响谁能做什么。',
      sectionCode: 'system-security',
      groupCode: 'permission',
      sortOrder: 81540,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 系统与安全 / 用户角色 =====
    'rbac.user-role.create': {
      displayName: '给某人发角色',
      businessDescription:
        '把一个角色发给某个人,对方立刻拿到这个角色的全部权限。这是旧入口,发出去的角色一律是全系统范围,不能限定分队或活动 —— 要限定范围得用「按范围给人授权」。',
      sectionCode: 'system-security',
      groupCode: 'user-role',
      sortOrder: 82010,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'rbac.user-role.delete': {
      displayName: '收回某人的角色',
      businessDescription:
        '把某人身上的一个角色撤掉,他立刻失去这个角色带来的全部权限。记录会留在历史里标成「已结束」;系统会拦住「撤掉最后一个运营管理员」这种把所有人锁在门外的操作。',
      sectionCode: 'system-security',
      groupCode: 'user-role',
      sortOrder: 82020,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'rbac.user-role.read': {
      displayName: '查某人有哪些角色',
      businessDescription:
        '看某个人当前身上有哪些角色。只列当前生效的全系统角色 —— 按分队 / 活动限定范围的、还没到期的、已过期的,都不在这里显示。',
      sectionCode: 'system-security',
      groupCode: 'user-role',
      sortOrder: 82030,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 系统与安全 / 权限运行时 =====
    'rbac.config.reload': {
      displayName: '重载权限配置',
      businessDescription:
        '早年留下的兼容按钮:点了之后什么都不会发生。系统现在每次请求都直接查库算权限,没有缓存需要刷新 —— 改完角色权限下一次请求就生效,不用点这里。',
      sectionCode: 'system-security',
      groupCode: 'rbac-runtime',
      sortOrder: 82510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 系统与安全 / 角色绑定 =====
    'role-binding.create.record': {
      displayName: '按范围给人授权',
      businessDescription:
        '把一个角色发给某人,可以限定只在某个分队、某棵组织树、某场活动或某条记录上生效,还能设起止日期;对方在这个范围内立刻拿到该角色的全部权限。除了发给个人,还能发给「某个人的一份任职」(任职一到期或被撤,这条授权自动失效);同一条权限还能一次批量发最多 200 条,某条失败不影响其他条。',
      sectionCode: 'system-security',
      groupCode: 'role-binding',
      sortOrder: 83010,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE', 'MASS_EFFECT'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'role-binding.delete.record': {
      displayName: '撤销一条授权',
      businessDescription:
        '把一条已发出的授权收回,对方立刻失去这条授权带来的权限。记录保留在历史里标成「已结束」,不是真删;系统会拦住「撤掉最后一个运营管理员」,活动自动派发的那 3 个角色也不许手动撤。',
      sectionCode: 'system-security',
      groupCode: 'role-binding',
      sortOrder: 83020,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'role-binding.read.record': {
      displayName: '查看授权记录',
      businessDescription:
        '能看到谁在什么范围内拿了什么角色、任期到什么时候,可分页可筛选。同一条权限还带一个「试算」功能:先看看这条授权发下去会不会撞车,不会真发出去。',
      sectionCode: 'system-security',
      groupCode: 'role-binding',
      sortOrder: 83030,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'role-binding.update.record': {
      displayName: '改授权的任期状态',
      businessDescription:
        '只能改一条授权的起止日期、生效状态和备注,改不了发给谁、发的什么角色、管多大范围(那些只能撤掉重发)。把开始日期提前、结束日期推后或重新启用,等于当场把权限还给对方 —— 碰到运营管理员这类高权限角色时,系统会再查一遍你有没有资格发。',
      sectionCode: 'system-security',
      groupCode: 'role-binding',
      sortOrder: 83040,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CONTROL_PLANE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 系统与安全 / 权限诊断 =====
    'authz.action-state.decision': {
      displayName: '批量试算我能做什么',
      businessDescription:
        '一次性问系统「这批活动、这批考勤表,我现在能不能做某个操作」,逐条回「能 / 不能」并说明是没权限还是当前状态不允许。问的是自己,只是查询,不改动任何数据。',
      sectionCode: 'system-security',
      groupCode: 'authz-diagnostics',
      sortOrder: 83510,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'authz.explain-batch.decision': {
      displayName: '批量排查他人权限',
      businessDescription:
        '一次最多问 200 条「某人对某件事有没有权限」,逐条给出能 / 不能和原因。只是查询,不会改动任何人的权限。',
      sectionCode: 'system-security',
      groupCode: 'authz-diagnostics',
      sortOrder: 83520,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'authz.explain.decision': {
      displayName: '排查某人的权限',
      businessDescription:
        '查「某个人对某件事到底有没有权限、是靠哪个角色拿到的」,排查「他为什么点不了」时用。能查任何人,连已被停用的账号都能查,查的时候会一并看到对方的账号名和系统级别。',
      sectionCode: 'system-security',
      groupCode: 'authz-diagnostics',
      sortOrder: 83530,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 系统与安全 / 审计 =====
    'audit-log.read.entry': {
      displayName: '查看操作日志',
      businessDescription:
        '查谁在什么时候改了什么。只有超管能看到全部;其他持有这条权限的人只能看到自己做过的操作,加上普通队员做的操作 —— 别的管理员干了什么是看不到的。日志只能看,不能改也不能删。',
      sectionCode: 'system-security',
      groupCode: 'audit',
      sortOrder: 84010,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 系统与安全 / 短信 =====
    'sms-send-log.read.list': {
      displayName: '查看短信发送记录',
      businessDescription:
        '看系统发过哪些短信、发给谁、成功还是失败、失败原因是什么。列表里手机号是打码的(如 138****1234),但可以用完整手机号去精确搜。记录只增不改,删不掉。',
      sectionCode: 'system-security',
      groupCode: 'sms',
      sortOrder: 84510,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'sms-setting.read.singleton': {
      displayName: '查看短信配置',
      businessDescription:
        '看短信通道现在是怎么配的:服务商、总开关、短信签名、三个模板 ID(验证码 / 生日祝福 / 通知兜底)。密钥本身永远不显示,只显示「已配 / 未配 / 无效」。',
      sectionCode: 'system-security',
      groupCode: 'sms',
      sortOrder: 84520,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'sms-setting.reset.credentials': {
      displayName: '重换短信密钥',
      businessDescription:
        '把腾讯云短信的 SecretId / SecretKey 换成新的一组。要先去腾讯云控制台拿到新密钥再填进来;一保存立刻生效,旧的那组系统从此不再使用。填错了短信马上全停 —— 登录验证码、生日祝福、紧急召集一起停。',
      sectionCode: 'system-security',
      groupCode: 'sms',
      sortOrder: 84530,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CREDENTIAL'],
      grantPolicy: 'SUPER_ADMIN_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'HIDDEN',
    },
    'sms-setting.update.singleton': {
      displayName: '修改短信配置',
      businessDescription:
        '改短信服务商、总开关、签名、地域和三个模板 ID。这里改不了密钥(密钥是另一个动作)。签名和模板必须是腾讯云那边已经审核通过的,填错了短信会发失败。把总开关关掉,所有短信立刻停发;正式环境不允许选「联调假通道」。',
      sectionCode: 'system-security',
      groupCode: 'sms',
      sortOrder: 84540,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 系统与安全 / 微信 =====
    'wechat-setting.read.singleton': {
      displayName: '查看小程序配置',
      businessDescription:
        '看微信小程序接入怎么配的:AppID、总开关、有没有配 AppSecret。AppSecret 永远不显示,只显示「已配 / 未配 / 无效」。',
      sectionCode: 'system-security',
      groupCode: 'wechat',
      sortOrder: 85010,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'wechat-setting.reset.credentials': {
      displayName: '重换小程序密钥',
      businessDescription:
        '把微信小程序的 AppSecret 换成新的一组。要先去微信公众平台重新生成再填进来;一保存立刻生效,旧的从此不再使用。填错了队员就用不了微信一键登录,微信通知也推不出去。',
      sectionCode: 'system-security',
      groupCode: 'wechat',
      sortOrder: 85020,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CREDENTIAL'],
      grantPolicy: 'SUPER_ADMIN_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'HIDDEN',
    },
    'wechat-setting.update.singleton': {
      displayName: '修改小程序配置',
      businessDescription:
        '改小程序 AppID、总开关和运维备注。这里改不了 AppSecret。把总开关关掉,微信一键登录立刻用不了;正式环境不允许选「联调假通道」。',
      sectionCode: 'system-security',
      groupCode: 'wechat',
      sortOrder: 85030,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 系统与安全 / 企业微信 =====
    'wecom-setting.read.singleton': {
      displayName: '查看企业微信配置',
      businessDescription:
        '看企业微信接入怎么配的:总开关、登录开关、消息开关、AgentID、H5 网址。CorpSecret 永远不显示,企业 CorpID 也只给你看打码后的。',
      sectionCode: 'system-security',
      groupCode: 'wecom',
      sortOrder: 85510,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'wecom-setting.reset.credentials': {
      displayName: '重换企业微信密钥',
      businessDescription:
        '把企业微信自建应用的 CorpSecret 换成新的一组。要先去企业微信管理后台拿到新的再填进来;一保存立刻生效,旧的从此不再使用。填错了企业微信登录和企业微信消息都会停。',
      sectionCode: 'system-security',
      groupCode: 'wecom',
      sortOrder: 85520,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CREDENTIAL'],
      grantPolicy: 'SUPER_ADMIN_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'HIDDEN',
    },
    'wecom-setting.test.connection': {
      displayName: '测企业微信连通性',
      businessDescription:
        '拿当前配置去企业微信那边现试一次,回来告诉你能不能换到令牌、应用对不对得上、应用有没有被停用,以及应用可见范围里有多少人 / 多少部门 / 多少标签。只是体检:不发任何消息、不动任何人的绑定、不改配置;只给数量,不会拉出通讯录名单。',
      sectionCode: 'system-security',
      groupCode: 'wecom',
      sortOrder: 85530,
      riskLevel: 'LOW',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'wecom-setting.update.singleton': {
      displayName: '改企业微信配置',
      businessDescription:
        '改总开关、登录开关、消息开关、企业 CorpID、AgentID 和 H5 网址。登录 / 消息开关要打开,必须先打开总开关。只要已经有人绑了企业微信,企业 CorpID 就改不了 —— 换了等于换一套身份,所有人的绑定会集体失配。这里改不了 CorpSecret;正式环境不允许选「联调假通道」。',
      sectionCode: 'system-security',
      groupCode: 'wecom',
      sortOrder: 85540,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 系统与安全 / 实名核验 =====
    'realname-setting.read.singleton': {
      displayName: '查看身份核验设置',
      businessDescription:
        '看身份证照片自动识别现在是开是关、走的哪家、密钥配没配好。密钥本身永远不会显示出来。',
      sectionCode: 'system-security',
      groupCode: 'realname-verification',
      sortOrder: 86010,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'realname-setting.reset.credentials': {
      displayName: '更换身份识别密钥',
      businessDescription:
        '换掉给身份证照片做自动识别用的那对腾讯云密钥。旧密钥当场被覆盖、看不回来;配错了报名人的身份证就识别不出来,连试两次后全部转人工复核。',
      sectionCode: 'system-security',
      groupCode: 'realname-verification',
      sortOrder: 86020,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CREDENTIAL'],
      grantPolicy: 'SUPER_ADMIN_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'HIDDEN',
    },
    'realname-setting.update.singleton': {
      displayName: '改身份核验设置',
      businessDescription:
        '开关身份证自动识别、改服务地域和备注(改密钥不在这里,走「更换身份识别密钥」)。关掉之后新报名的身份证不再自动识别,连试两次后转到人工复核那一栏。',
      sectionCode: 'system-security',
      groupCode: 'realname-verification',
      sortOrder: 86030,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 系统与安全 / 存储设置 =====
    'storage-setting.read.singleton': {
      displayName: '查看文件存储设置',
      businessDescription:
        '看文件都存到哪儿(云存储空间、地域)、下载链接多久过期这些设置,以及密钥有没有配好。看不到密钥本身',
      sectionCode: 'system-security',
      groupCode: 'storage-setting',
      sortOrder: 86510,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'storage-setting.reset.credentials': {
      displayName: '重置云存储密钥',
      businessDescription:
        '换掉腾讯云对象存储的账号密钥。填错了全队立刻传不了也下不了任何文件(证件照、证书、活动照片、文章附件全部打不开),而且旧密钥不留底,改错了退不回去。只有超级管理员能做',
      sectionCode: 'system-security',
      groupCode: 'storage-setting',
      sortOrder: 86520,
      riskLevel: 'CRITICAL',
      riskTags: ['WRITE', 'CREDENTIAL'],
      grantPolicy: 'SUPER_ADMIN_ONLY',
      status: 'ACTIVE',
      uiVisibility: 'HIDDEN',
    },
    'storage-setting.update.singleton': {
      displayName: '修改文件存储设置',
      businessDescription:
        '改下载链接有效期、允许的跨域来源、单文件上限这些存储参数(不含密钥)。把「启用」关掉会立刻停掉全队所有上传和下载;正式环境上,存储空间和地域第一次存好之后就改不动了',
      sectionCode: 'system-security',
      groupCode: 'storage-setting',
      sortOrder: 86530,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 基础数据 / 字典 =====
    'dict.create.item': {
      displayName: '新增下拉选项',
      businessDescription: '给某个下拉框加一个可选值(比如给「活动类型」加一项「山地救援」)。',
      sectionCode: 'master-data',
      groupCode: 'dict',
      sortOrder: 90510,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'dict.create.type': {
      displayName: '新建下拉分类',
      businessDescription:
        '新开一整类下拉选项(比如新建一个「培训科目」分类,再往里加具体选项)。分类的内部代号一旦建好就改不了,只能改显示名。',
      sectionCode: 'master-data',
      groupCode: 'dict',
      sortOrder: 90520,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'dict.delete.item': {
      displayName: '删除下拉选项',
      businessDescription:
        '删掉某个下拉框里的一个可选值。系统内置的选项删不掉(性别、队员级别、活动类型、各种状态这些一律拒绝);还有人在用的也删不掉。后台没有恢复入口。想让它不再被人选到,推荐用「停用」而不是删。',
      sectionCode: 'master-data',
      groupCode: 'dict',
      sortOrder: 90530,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'dict.delete.type': {
      displayName: '删除下拉分类',
      businessDescription:
        '删掉一整类下拉选项。系统内置的分类一律删不掉(几乎所有出厂就有的分类都在保护名单里),底下还有选项、或还有分队 / 队员在引用的也删不掉。后台没有恢复入口。',
      sectionCode: 'master-data',
      groupCode: 'dict',
      sortOrder: 90540,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'dict.read.item': {
      displayName: '查看下拉选项',
      businessDescription:
        '看某个下拉框里都有哪些可选值(列表、层级树、单条详情),比如「活动类型」下面挂了哪几类。',
      sectionCode: 'master-data',
      groupCode: 'dict',
      sortOrder: 90550,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'dict.read.type': {
      displayName: '查看下拉分类',
      businessDescription:
        '看系统里一共有哪些下拉分类(比如「活动类型」「队员级别」「紧急联系人关系」「通知类型」)。',
      sectionCode: 'master-data',
      groupCode: 'dict',
      sortOrder: 90560,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'dict.update.item': {
      displayName: '修改下拉选项',
      businessDescription:
        '改一个可选值的显示名和排序,或把它停用。停用之后新填的表单里就选不到它了,已经填过它的老记录不受影响。选项的内部代号改不了。',
      sectionCode: 'master-data',
      groupCode: 'dict',
      sortOrder: 90570,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    'dict.update.type': {
      displayName: '修改下拉分类',
      businessDescription: '改一类下拉选项的显示名和排序,或把整类停用。分类的内部代号改不了。',
      sectionCode: 'master-data',
      groupCode: 'dict',
      sortOrder: 90580,
      riskLevel: 'MEDIUM',
      riskTags: ['WRITE'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
    // ===== 基础数据 / 元数据 =====
    'meta.resolve.label': {
      displayName: '批量把编号换成名字',
      businessDescription:
        '后台页面用的翻译工具:一次把一堆内部编号换成看得懂的名字(队员、账号、分队 / 小组、角色、职务、活动)。只读,不改任何数据。你没权限看的那一类会直接不返回,不报错。',
      sectionCode: 'master-data',
      groupCode: 'meta',
      sortOrder: 91010,
      riskLevel: 'LOW',
      riskTags: ['READ'],
      grantPolicy: 'CUSTOM_ROLE_ALLOWED',
      status: 'ACTIVE',
      uiVisibility: 'ADVANCED',
    },
  });
