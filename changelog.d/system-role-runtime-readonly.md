### Fixed

- **15 个系统内建角色改为运行时只读**(P1-32 PR 3a):此前 `PROTECTED_ROLE_CODE_SET` 全仓**只被 `RbacRolesService.softDelete()` 查过一次** —— 内建角色删不掉,但**改名、加权限、减权限一个拦阻都没有**。这不是理论敞口:持 `rbac.role-permission.create` 的 `ops-admin` 可以把 `member-profile.read.sensitive`(明文证件号 / 手机)加到 `member` 角色上,控制面闸拦不住它(它不是那 7 条保留码),于是**全体队员当场能看彼此明文 PII**。现在删返 `30104`、改名/改描述返 `30107`(新)、加/减权限返 `30108`(新),自定义角色的增删改查一字不变。

  **对 `SUPER_ADMIN` 同样关闭**,理由不是「权限过宽」而是「运行时可改本身就是设计错误」:`org-readonly`(副队长/副部长)与 `group-readonly`(副组长)的码集**不是手工清单,是从正职角色过滤派生的**(`isReadonlyProjectionCode`),手改必被下次 seed 覆盖,或造出一份与派生链打架的第二份真相 —— 给 SA 开口子等于允许他造一份注定被冲掉的假配置。四道闸一律锚在新增的共享谓词 `isProtectedRoleCode()` 上,禁止各处自己 `PROTECTED_ROLE_CODE_SET.has(...)`。

- **控制面保留码不再能沉淀成角色的常驻权限**(P1-32 PR 3a):`assign()` 侧的 `SUPER_ADMIN` 短路已摘掉 —— 把控制面码(SA-only 保留码 ∪ `rbac.*` ∪ `role-binding.*`)写进某角色的 `role_permissions`,就是让**持有该角色的非 SA** 永久拥有控制面能力,由谁按下按钮不改变结果。SA 依然能用 SA 身份直接做任何控制面操作(他走身份短路,根本不查 `role_permissions`),本次关掉的只是「沉淀成角色常驻权限」这条路。

  ⚠️ **`revoke()` 侧刻意保留 SA 短路,这个不对称不是漏改**:seed 出来的角色本就不含控制面码(P1-32 PR 0 实测交集为 0),SA 可撤是给**历史脏数据**留的唯一清理路;非 SA 仍拒(E-B2 的「一侧有闸一侧没有」已收口)。下一个人不要把它当漏接闸补成对称 —— 收死之后最后一条清理入口就没了。判定收在同一个 `assertControlPlaneCodesOrThrow(user, codes, direction)` 里,两侧共用谓词、只有 `direction` 不同。

### Added

- **两道闸的可达性判据扩到两份 service**(`role-permissions-control-plane-gate.spec.ts`,原地扩展、不另造第二份):此前它只问「`RolePermissionsService` 里会写 `rolePermission` 的公开方法过没过控制面闸」。现在同时覆盖 `RbacRolesService`,并对每个写面要求**该写面的全部闸**:`rolePermission` 面要过控制面闸 + 内建角色闸,`rbacRole` 面要过内建角色闸。发现侧与满足侧走**同一个** `this.<x>()` 传递闭包 —— 把写操作或把闸搬进私有 helper 都不改变判定(重构时最自然的动作,不能因此漏抓或误红)。

  两个写面的口径**刻意不同**:`rolePermission` 认全部写方法(含 `create` 家族),`rbacRole` **只认改既有行的**(`update` / `upsert` / `delete` 家族)—— 新建角色时 code 撞上任何内建角色都会先被 code unique 预检查判成 `30004`,结构上不可能用 `create` 改到内建角色,把它拉进来只会产出恒定误红。判据里为此单钉一条自证:`create` 必须**出现在**「任意写」探针面、且**不出现在**受闸名单里 —— 少了它,口径退化成「认所有写方法」时全套判据照样绿。其余自证一律用地板锚点(`toContain` / `≥N`)而非「恰 N 个」,新增写方法只会多一个、不会误红。
