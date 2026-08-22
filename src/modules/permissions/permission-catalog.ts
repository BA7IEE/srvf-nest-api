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
    code: 'dict.read.item',
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
]);
