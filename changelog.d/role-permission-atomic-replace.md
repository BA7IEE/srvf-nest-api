### Added

- **角色权限集原子替换 `PUT /api/system/v1/roles/{id}/permissions`**(P1-32 PR 4a):一次请求把某角色的权限点改成**恰好**是提交的那一组(传 `[]` 即清空),取代「先 POST 加几条、再 DELETE 撤几条」那种半路可见中间态的改法。入参必带 `expectedRevision`;新增响应字段 `RbacRoleResponseDto.permissionRevision`(角色列表 / 详情 / 建 / 改四处响应 additive 多这一个整数)供客户端取版本号。判权要 `rbac.role-permission.create` **与** `rbac.role-permission.delete` **两个**码(`require: 'all'`)—— 一次替换可能同时授与撤,只拿其中一个就是绕过另一半闸。**不新增任何权限码**。

- **`RbacRole.permissionRevision Int @default(0)`**(第 95 条 migration,additive、零回填、零 DROP):每次**成功且有实际变化**的权限集写入 `+1`,与映射写入、audit 同一事务。⚠️ 与 `updatedAt` 不是一回事:改角色显示名动 `updatedAt` 不动它;而权限集写入两者都动(`@updatedAt` 顺带,**刻意接受** —— 权限集就是这个角色的配置)。

- **角色行锁(`SELECT … FROM "roles" … FOR UPDATE`)**:替换、版本号自增、audit 三件事在同一事务内、锁之后完成。锁的是**角色行**不是权限行 —— 整集替换的临界区是「这个角色的权限集」,锁映射行只能挡住「改同一条映射」,挡不住「A 删 x 加 y、B 删 y 加 z」这类交错。版本号在**取到锁之后**才复读比对:锁前读到的值在锁等待期间可能已被前一个写者 `+1`(`wecom-settings` S1 就是被「锁前读 + 锁后用」破掉的)。

  🔴 **行锁与版本号不是给现状补的洞,是 `PUT` 这个新语义自带的必需品 —— 请不要把本条读成「原来一直有并发 bug」**。旧 `POST`(加码)与 `DELETE`(减码)在语义上**可交换**:两个管理员同时各加一条码,结果是两条都在,谁的改动都没丢。整集替换**不可交换** —— 它是「读现状 → 算目标 → 整体写回」,两个并发替换会后写覆盖先写,先写那次的改动**静默消失**而两边都拿到 200。所以窗口是这一刀带进来的,同一刀把它焊死;新错误码 `30111`(`ROLE_PERMISSION_REVISION_CONFLICT`,HTTP 409)是这条语义的配套,不是既有缺陷的补丁。

- **`role-permission.replace` 审计事件**(本刀 goal 显式授权的唯一 +1 `AuditLogEvent`):`extra` 记 `{operation, addedCodes, removedCodes, resultCodes, fromRevision, toRevision}`。**事件名按入口分而不是合并**:旧 `POST` / `DELETE` 仍写 `role-permission.grant` / `.revoke` 且 `extra` 形状逐字不变(`permissions-config-audit-characterization` B1/B2 钉着),一次替换同时含增与减,套 grant 或 revoke 都是说谎。

### Changed

- **三条写路径合并成一条写原语**(本刀**不能**拆到下一刀的原因):`assign()` / `revoke()` / `replace()` 现在全部经私有 `replaceRolePermissionSet()` 落库,它是全类**唯一**会改写 `role_permissions` 的地方。留两条写路径就是「一侧有闸、另一侧裸奔」—— E-B1(#1115)、E-B2 的授撤不对称都是这个形态,本仓已经吃过三次。对外契约(路径、请求体、响应形状、错误码)一字未变。

  实现上原语收的是**意图**(`add` / `remove` / `set`)而不是「目标全集」,这一点别改回去:旧 POST/DELETE 是增量语义,若让它们在锁**外**先读现状、算出目标全集再交进来,那份快照会在锁等待期间过期,于是「减掉 x」会顺手把别人刚加的 y 一起抹掉 —— 本刀本来是来消灭丢更新的,那样写反而给两条旧路径**各造一个新的**。`PUT` 的 `set` 相反:调用者的全集就是权威,过期风险由 `expectedRevision` 兜。

- **空转不再留痕**:目标集合与现状**相同**时不写、不 `+1`、不产生 audit。判据比的是**集合**不是计数(计数相等会掩盖内容互换,而那正是最危险的漏写)。⚠️ 这条对旧 `POST` 也生效 —— **重复授权(纯空转)从此不再写 audit 行**,请求 / 响应形状仍是 201 + detail 一字未变。这是本刀唯一一处对外可观测的行为变化,已由 e2e 正面钉住,不是漂移。

- **`revoke()` 撤一条不存在的映射**仍返 `30011`(存在性检查在事务外,契约不变);但「检查通过、取锁前被别人撤掉」这个窄窗口现在退化成 no-op(200 + 当前 detail),而不是像以前那样抛 Prisma `P2025` 变 500。

### Fixed

- **PR 3a 的两层控制面闸在新入口原样生效,且授撤不对称没有被抹平**:非 `SUPER_ADMIN` 碰控制面码一律 `30103`(授撤同口径);7 条 SA-only 保留码在**授码侧**连 `SUPER_ADMIN` 也拒 `30109`;**撤码侧刻意仍无第 2 层**(SA 可撤,给历史脏数据留唯一清理路)。原语内部按**方向**判差集(进来的码走 grant、出去的码走 revoke),没动的码不判 —— 判了会把「这次没碰它」误伤成越权,而任何真的改动都落在差集里,所以按差集判不比按全集判弱。

  ⚠️ `replace()` 入口另有一道**判目标全集**的前置闸(与 `assign()` 逐字同一句,好保住 PR 3a 那条「早于 Permission 存在性查询拦下、未 seed 的保留码也返拒绝码而非 `30001` 泄漏存在性」的刻意设计)。**代价写在这里免得被当 bug 修**:非 SA 对「已含控制面码的自定义角色」用不了 `PUT`(保留它触第 1 层、去掉它触撤码方向),得退回 POST / DELETE 逐条改。这类角色只可能由 SA 亲手造出来、极少;判差集虽然更好用,但那是**放宽**,而本刀的要求是两层闸「原样保留」不是顺手调松。

### 判据与变异对拍

- **可达性判据原地扩展**(`role-permissions-control-plane-gate.spec.ts`,**没有**另造第二份):该判据 2026-08-21 立下的那句预告 —— 「写死 `['assign','revoke']` 的话,PR 4 的原子 `PUT` 与它漏掉的闸会一起不在名单里,判据当场变摆设而且全绿」—— 今天兑现了:`replace()` 落地,判据**一行没改**就把它收进了判定范围,自证里只多加了地板锚点。

  同一刀还新增一条**常驻自证**:`assign` / `revoke` / `replace` 三个公开方法身上**一个直接写点都没有**(全部落在私有原语上),于是「发现侧」完全靠 `this.<x>()` 传递闭包成立。传递闭包从此不是纸面性质而是**唯一**在起作用的机制 —— 若有人把它退化成「只看方法体字面量」,发现侧会当场空掉,而空掉的发现侧会让主断言在空集上循环、**全绿**。有了这条自证,退化会先在这里红。

- **变异对拍读数(四条全部实跑,无一条只写预期)** —— ⚠️ **出处**:静态两条走 `jest-unit`(纯 typed-AST,不起 Nest、不连 Postgres,单文件 ~0.4s);运行时两条走**定向单 spec e2e**(仓内入口文档明文允许「定向 e2e 单 spec ~24s;全量恒由 PR CI 冷跑裁决,本机勿跑全量」),跑前 `pgrep -fl jest` 确认无并发。**全量仍以 PR 上的 check run 为准**。

  静态基线 `7 passed`;运行时基线 `role-permissions.e2e 53 passed` + `role-permissions-replace-concurrency.e2e 3 passed`。

  | # | 变异 | 读数 | 说明 |
  |---|---|---|---|
  | ① | 摘掉 `SELECT … FOR UPDATE` 角色行锁 | 并发 spec **2 failed / 1 passed** | 两个序都红,症状**逐字**是预测的那个:`[200, 409]` → `[200, 200]`(两个写者都以为自己成功了,先写那次静默消失)。**1 passed 的正是反向对照**(两个并发 POST 双双成功)—— 红是「PUT 丢更新」这一维,不是屏障编排整体崩了 |
  | ② | 摘掉 `expectedRevision` 校验 | `role-permissions` 两 spec 合计 **5 failed / 51 passed** | 红集恰好是全部依赖冲突判定的用例(落后 / 超前 / 「POST·DELETE 也 +1」三条顺序用例 + 两条并发用例),**其余 51 条一条没动** |
  | ③ | 旧 `POST` 改回自己开事务直写、且不调任何闸 | 静态判据 **3 failed** | 主断言点名 `RolePermissionsService.assign()`,并**分别**报它漏了 `isControlPlanePermissionCode` 与 `isProtectedRoleCode` —— 两道闸各自独立跟踪,不是一锅端 |
  | ④ | ⭐ 把原语再往下埋一跳(`assign` → `applyAddViaHelper` → `replaceRolePermissionSet`) | 静态判据 **仍 7 passed** | 且自证里 `toContain('assign')` 同时通过 ⇒ 这个绿不是「判据不看它了」而是「闭包认出来了」。判据跟的是**调用闭包**不是字面量,直接证据 |

  ①②的红集**不重叠**(①只红并发那两条,②多红三条顺序用例)—— 行锁与版本号是两个独立机制,各自有各自的执行位,不是一个机制被测了两遍。

  **另测一条 goal 没要求、但值得记的**:③ 的变体「旧 `POST` 绕开原语但**保留**两道闸」→ 主断言**绿**。这是判据 2026-08-21 立下的既有射程(它问的是「过没过闸」,不是「有没有经过原语」),如实记下不粉饰;但**本刀新增的那条常驻自证红**并点名 `assign` 多了一个直接写点、且从 `roleRow` 面消失(版本号不再 `+1`)。⇒ 「旧写路径偷偷绕开原语」这件事从今天起**有执行位**,落在自证而不是主断言上。

### 语义门与回归读数

- **契约语义门**(`contract-semantic-diff --base origin/main`):`breaking=0 additive=8` —— 8 项全是 `[response-field-added]` × 7(`permissionRevision` 出现在 roles 的列表 / 建 / 详情 / 改 / 删 / 授权 / 撤权七处响应)+ `[endpoint-added]` × 1。⇒ **无需契约破坏申报**,也没有任何一处需要维护者点批的降级。
- **授权语义门**(`authz-semantic-diff --base origin/main`):`BROADER=0 INCOMPARABLE=0 NARROWER=0 ADDED=1 EQUIVALENT=549`(共 550 端点)。新端点策略 `codes=all:rbac.role-permission.create,rbac.role-permission.delete`,**零权限码新增**,既有 549 个端点授权语义逐个不变。
- **相邻 e2e 回归**(定向):`permissions-config-audit-characterization` + `rbac-delegation-safety` + `rbac-roles` 共 **131 passed**(旧 audit 契约 B1/B2、PR 3a 两层闸、角色 DTO 三面都没被动);`rbac-multi-instance-consistency` + `seed-rbac` + `rbac-me-permissions` + `rbac-reload` + `permissions` 共 **147 passed**。
- `pnpm agent:check:quick` 全绿(lint / typecheck / **6304 unit** / **138 harness 自测**);`pnpm harness:replay` 真触发 9/9 + 结构断言 12/12;八条 `docs:*:check` 与 `boundaries:{debt,newdebt,ids}:check` 全绿;契约快照 `947 passed`。
- ⚠️ `pnpm harness:servicesize` 有 WARN,但**与本刀无关**:飘的 9 个基线文件与 1 个新超阈值文件(`attachment-storage-orchestrator.ts` 711)**没有一个在本刀写集内**,是既有漂移;该步骤在 CI 侧带 `|| true`,report 期不阻断。本刀刻意**不**跑 `harness:servicesize:write` —— 整体重算会把那 9 个文件的基线**上调**,而尺寸棘轮只降不升。
