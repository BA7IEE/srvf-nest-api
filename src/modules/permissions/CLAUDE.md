# permissions — 判权与权限写入

负责权限/角色配置、legacy GLOBAL 判权及 System raw permission 出口。
登录归 auth，App capability 出口归 users。事实以 permission-catalog、seed、service 和行为测试为准；
历史 PR 进度从 `harness-v3-final` 取回，不在此重复累计计数。

## 读取与身份

- RbacService 的 can/judge/getUserPermissionCodes/getEffectiveRoles 只读当前有效
  USER+GLOBAL+ACTIVE、未删 RoleBinding 和未删角色；startedAt/endedAt 两端含边界，
  共用 `role-binding-validity.ts`。不查询已 DROP 的 UserRole 表、不接 scoped 绑定判权。
  scoped 三源解析归 AuthzService；两套语义不能合并。
- SUPER_ADMIN 在 judge 短路；ADMIN 的 USER 权限来自 seed，不在 service 特判。
  每请求读 PG，无 Map/TTL、Redis/pub-sub 或提交后 invalidate 正确性链。
  显式 tx 参数必须贯穿本次查询；未传保持原 PrismaService，不批量改写无关调用。
- `.self`：user owner 对 user.id，member owner 对 user.memberId；
  缺 member/resource 或未知 ownerType fail-closed。
- System me/permissions 返回 raw code/角色摘要，SA 返回 Permission.code 全集，不返 `["*"]`；
  App capabilities 不是后端授权证明，不新增管理员查别人 permissions 的端点。
  `/reload` 只保留 all/user/role 参数校验和 `{ reloaded:true }`，缺必填拒绝、不存在对象静默成功。

## 委派、末位管理员与生命周期

- RoleDelegationPolicy 是 binding create/preview、兼容 user-role assign/revoke 的唯一委派闸；
  update/remove 也须先检查 system-managed。非 SA actor 先验证 ACTIVE/未删 User
  与当前 GLOBAL ops-admin，写路径先取 `role-bindings:last-ops-admin` advisory，
  锁后复核 actor，再读取/锁 target，持锁到 audit 提交；preview 只读但同样 actor-first。
- 末位 SA 用 `users:last-super-admin`；ops-admin 同时保留至少一个当前有效 holder
  和至少一个 endedAt=null 的当前常驻 holder。共用 LastAdminProtectionPolicy，
  任期、User/role/binding 状态过滤不能缺；失效 binding 清理放行，归零统一30101。
  lifecycle 削权锁序固定 advisory invariant → Member → User，锁后重读重算，不另造锁键/计数。
- legacy UserRolesService 实际读写 GLOBAL RoleBinding，契约不变；
  linked 账号恢复授权按 Member→User 行锁并复核 ACTIVE。
  revoke 是 ENDED+endedAt+deletedAt 软撤销，audit 记 role-binding.* + viaPath=user-role；
  直写 auditLog 避免模块环，不引 forwardRef。
- system-managed 三个活动责任角色只由 ActivityResponsibilityGrantProjector 业务事务写入，
  人工入口含 SA 均拒34006；非 SA 不得委派特权角色（30102）。
- Role 删除与 SERVICE_PRINCIPAL binding 创建/恢复共用 lockRbacRoleLifecycle。
  锁后只要有未软删服务主体 binding 即30113，含 SUSPENDED、未来或过期未撤销行；
  不隐式撤销。先显式撤销才可删角色，不扩大到其他主体删除语义。

## 唯一权限集写原语

- 写入口仅 PUT replace；previewReplace 复用同一判定但零写。
  `replaceRolePermissionSet()` 是唯一 role_permissions writer；所有可达写路径必须可达 step-up。
  不复活旧 POST assign/DELETE revoke，不新增旁路。
- 同事务锁 roles 行 FOR UPDATE → 重读角色三态/permissionRevision →
  expectedRevision 比对（30111）→ 锁内集合差分 → grant/revoke 各自控制面闸 →
  删增、revision+1、audit。相同集合不写、不加版本、不审计；不能按计数判断相同。
  updatedAt 不代替 permissionRevision。若重引增量操作必须传意图、锁内解算，
  不用锁外读取现状拼 targetCodes，否则会丢并发更新。
- 入口仍检查目标全集的控制面码，且早于 Permission 存在性查询；不改成只检查差集。
  非 SA 对含控制面码的目标集合保持拒绝。撤码的 step-up（30112）先于事务内控制面闸（30103），
  测后者必须先提供真 proof，不能以为只收到上层错误就是下层已验证。

## 目录与控制面

- `isControlPlanePermissionCode()` 覆盖 rbac.*、role-binding.* 和 SA-only 保留码；
  grant/revoke 共用 assertControlPlaneCodesOrThrow，非 SA 两方向均30103。
  保留码是控制面真子集，不能合并两谓词：SA 可以给角色授普通 RBAC 只读码，
  但任何身份都不能授 SA-only 保留码（30109）。撤除历史保留码刻意允许，不能补成对称禁令。
  凭证 reset 家族必须被 reserved-super-admin-permission-codes 的动态检查覆盖。
- 内建角色清单唯一来源 protected-role-codes/isProtectedRoleCode；
  含 SA 的运行时删/更新/改权限分别30104/30107/30108。派生只读角色随 seed 生成，
  不在 service/测试/文档复制角色或权限清单。
- Permission 写入共用 seed-permission-codes 谓词：闭包内删30105、闭包外造30106、
  闭包内改30110（含 SA）。闭包外历史惰性码的删除仍保留；不要扩大为全禁。
  Permission 物理删可经 FK Cascade 清除自定义角色映射，不将它当成可无损恢复。
- 权限定义在 permission-catalog.ts，角色映射在 prisma/seed.ts；两者职责分开。
  seed-permission-codes 是运行时唯一允许的闭包副本，源码 AST/桶并集和 seed 后 DB 分别验证。
  RbacPermissionSeed.description 才是 DB 描述权威源，metadata.businessDescription 是另一个字段，
  不互相比较或覆写。运行时 PATCH 被禁不证明既有库已同步，seed 的描述同步另按现行实现和测试核对。
- 指标目录三权限与模板目录两权限只认 Human GLOBAL，machine/delegation eligibility=false，
  可人工授自定义角色但不自动授内建角色；read/manage 不隐含，精确人工授码例外不扩成整族。
  模板管理不授活动创建/修改权；选择仍遵守活动 scope/属主。
  紧急创建权限维持 SUPER_ADMIN_ONLY、角色不可授，不能因创建入口接入而扩大授权。

新增角色、映射或 Permission writer 须满足 `role-permissions-control-plane-gate.spec.ts`
的动态可达性检查；映射面覆盖全部写，角色面覆盖修改既有行，Permission 面覆盖全部写含 create，
不把发现面退化成固定方法名单。保留错误码和身份三层边界，不引 CASL/新权限 DSL。
改判权跑 rbac.service、authz-rbac-equivalence 及受影响业务 E2E；
改写面跑角色控制面、impact/step-up、生命周期与 seed runtime 用例；契约变化再跑 contract。
