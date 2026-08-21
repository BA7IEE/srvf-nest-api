### Security

- **`RolePermissionsService.revoke()` 补上控制面闸,与 `assign()` 对称**(第六轮全仓评审包 E · E-B2)。
  授码侧自 #399 F1 起就调 `assertNoControlPlaneCodesOrThrow()`,撤码侧**一个控制面判定都没有** ——
  它只查了三件事:`rbac.role-permission.delete` 权限、角色存在且未软删、绑定存在。于是持
  `rbac.role-permission.delete` 的 ops-admin **授不了**控制面码(`rbac.*` ∪ `role-binding.*` ∪ 7 条
  SA-only 保留码),**却撤得掉** —— 包括把某个角色的 `rbac.*` / `role-binding.*` 权限一路撤空。
  damage 方向与 F1 相反(F1 是提权,这里是拆权),但同属「控制面权限映射被非 SUPER_ADMIN 改动」,
  是同一条不变量的两条腿。修复复用**同一个** `assertNoControlPlaneCodesOrThrow()` 与同一个 SoT 谓词
  `isControlPlanePermissionCode()`,不另造判定,错误码同为 `30103`。
  与 E-B1(#1115)同属一个缺陷家族:**一侧有闸、另一侧没有**;不同的只是「另一侧」这次是一条方法,上次是一条码。
- **次序差是签名决定的,不是漏拦**。`assign()` 的入参本来就是 codes,故能在 Permission 存在性查询**之前**
  拦下(未 seed 的保留码也返 `30103`,不退化成 `30001` 泄漏存在性);`revoke()` 的路径参数是 permissionId,
  不查库拿不到 code,只能先查后判。permissionId 不存在时本就无绑定可撤,先返 `30001` 不缩小闸的覆盖面。

### Added

- **「成对操作只有一侧有闸」缺陷类的执行位**(`role-permissions-control-plane-gate.spec.ts`)。
  修实例不修类,下一条写路径还会漏 —— RBAC 终态方案 PR 4 计划加原子 `PUT`(整体替换某角色的权限集合),
  那是第三条腿。新判据按 TypeScript AST **动态现取** `RolePermissionsService` 里所有会改写 `rolePermission`
  映射的**公开**方法,逐个要求能到达控制面谓词 `isControlPlanePermissionCode`,漏一个即红并**点名是哪个方法、
  写点在哪一行、后果是什么**。
  三处刻意设计:① **不写死 `['assign','revoke']`** —— 写死名单时新方法与它漏掉的闸会一起不在名单里,
  判据当场变摆设且**全绿**;② 「会改写」与「过了闸」都走**传递闭包**(经 `this.<私有方法>()` 一路跟下去),
  否则「把写操作搬进一个私有 helper」就能绕过,而那恰恰是重构时最自然的动作;
  ③ 闸锚在**共享谓词**而非私有 helper 名上 —— helper 可改名可拆分,谓词是 SoT,换掉它就是「另造判定」,本该红。
  判据自带自证断言(类解析到了、方法非空、谓词确实 import 自 `role-delegation.policy`、`assign`/`revoke`
  都在发现集里),防扫描器坏掉时「空集 == 空集」静默变绿。
  四条变异对拍实测:摘掉 `assign` 的闸 → 红并点名 `assign`;摘掉 `revoke` 的闸(= 本刀修复前的状态)→
  红并点名 `revoke`;注入两个不调闸的公开写方法(一个直接写、一个把写藏进私有 helper)→ 两个都被点名;
  注入一个**经私有 helper 到达闸**的公开写方法 → 保持绿(不误伤合法重构)。

### Tests

- **`role-permissions.e2e-spec.ts` 补 E-B2 三条行为用例**:ops-admin 撤销普通码 → 200 且真删了;
  ops-admin 撤销控制面码 → `30103` 且绑定原样还在;SUPER_ADMIN 撤销同一码 → 200(短路语义不变)。
  第一条**不能省** —— 只验「被拒」的话,一个「一律拒绝」的实现也会全绿,那不是修洞,
  是把 ops-admin 的 `rbac.role-permission.delete` 整个废掉。
  控制面码刻意取 `rbac.role.read`(前缀型)而非保留集成员,与 F1 既有用例合起来把
  `isControlPlanePermissionCode()` 的两半定义域都钉在行为面上。
