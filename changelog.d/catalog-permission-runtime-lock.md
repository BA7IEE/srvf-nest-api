### Changed

- **🔴 `PATCH /permissions/:id` 对 seed 闭包内的权限码一律拒(P1-32 PR 3b,新 `30110`)—— 这是推翻一条刻意设计,不是补一道漏接的闸。**

  先说清被推翻的是什么。`prisma/seed.ts` 的 Permission upsert 用 `update: {}`,注释逐字写着「已存在不覆盖 description / module / action / resourceType(防止运营运行时调整被 seed 回退;沿 V2 dictionaries seed 范式)」—— 也就是说,**「运行时可以改 description、而且 seed 不会把它冲掉」是当年故意做的**,不是遗漏。

  改立场的理由是 P1-32 PR 0(`ac4f3b08`)之后事实变了:权限码的 `description` 有了代码侧权威源(`permission-catalog.ts` 各 `*_PERMISSION_SEED` 条目的 `description` 字段)。于是同一件事有了两份副本 —— DB 行一份、代码常量一份 —— 而 `update: {}` 保证 seed 永远不会把 DB 那份拉回来。**两份可以各自漂移,且没有任何东西在比对它们**,也没有任何入口能把漂移修回去。本刀关掉运行时写入口,等于让代码常量单向成为唯一写者(seed 的 `create` 是唯一写路径)。

  ⚠️ 因此那条 seed 注释在本刀之后成了半句假话(回退确实不会发生,但**改本身**已被禁),已一并改准 —— 仓内铁律:**护栏守的条件必须与注释是同一件事**。

  ⚠️ 237 条码**全部**在闭包内 ⇒ 该端点**不再存在成功路径**。这与 `POST /permissions` 同型且**刻意**:端点保留是为了给出一个明确的「不能这么干、该去哪」,而不是静默接受一次什么都不会发生的写入。闭包**外**的码(历史遗留的惰性码)改动行为一字不变 —— 与 `delete` 侧同一口径,给历史脏数据留清理路。

  ⚠️ 闸放在存在性检查**之后**:不存在的 id 继续返 `30001`,不被这道闸抢答成 `30110`。

  ⚠️ **`30110` 而不是 `30109`** —— `30109` 已被 `RESERVED_PERMISSION_NOT_ROLE_GRANTABLE`(PR 3a)占用。本段位不连续,下一个人别按「上一条 +1」推。

- **🔴 本刀只关了漂移的两条路里的一条 —— 另一条仍然开着,别读成「漂移问题已解决」。**

  `Permission.description` 与代码常量之间有**两条**分叉路径:

  | | 怎么发生 | 本刀 |
  |---|---|---|
  | **V1** | 运行时经 `PATCH` 改 DB 行,`update: {}` 保证 seed 永不拉回 | ✅ **关上了**(`30110`) |
  | **V2** | 有人改**代码里**某条 `description` 字符串,`update: {}` 保证**既有库永远收不到这次改动** | ❌ **仍开着** |

  V2 与 `PATCH` 无关,关掉写入口对它一点作用都没有。任何长期存活的库,在第一次「有人改了某条 description 的文案」之后就会与代码分叉,而且没有任何东西会报警。**生产库目前不存在(卡域名,仍 NO-GO),所以现在还没有受害者 —— 这是把它单独立项、而不是就地硬修的唯一理由。**

  堵 V2 的做法是让 seed 变成权威写者(`update: { description }`)。它此前被否掉的理由是「会静默改写运营手工调过的文案」—— ⭐ **那条理由在本刀之后就不成立了**:`PATCH` 关上后根本不存在「运营手工调过的文案」。即 V1 与 V2 的处置**不是二选一,是先后关系**。V2 另行立项,由维护者重新拍板。

- **刻意**没有加「DB 里每条 `Permission.description` 必须等于 Catalog 对应值」这条判据(原 goal §3 选项 A),两个独立理由:

  1. ⭐ **原方案比错了字段。** goal 把 `Permission.description` 与 `PERMISSION_CATALOG_METADATA.businessDescription` 列为同一件事的两份副本。实测:`businessDescription` 是面向后台编辑器的**长句业务说明**,**从不写进 DB**(`prisma/` + `scripts/` 全仓 0 命中);DB 那份的权威源是 `RbacPermissionSeed.description`(短技术标签)。115 条有 seed description 的码里 **0 条相等**(例:`org.create.node` → `'创建组织节点'` vs `'在组织架构里加一个新的分队、部门或小组…'`)。照字面建,判据一落地就红在几乎每一条上 —— 那不是暴露漂移,是拿两个不同用途的字段在比。
  2. **换成正确字段后它在 CI 里恒绿。** e2e / CI 的库是「空库 → 跑 seed → 比对」,而 seed 的 `create` 写进去的就是那个常量 ⇒ 两边**构造上必然相等**,判据永远不会红。它只对「长期存活且被 `PATCH` 过的库」有牙,而这种库不存在(生产未上线)。加它 = 多一个连库测试 + 零执法收益。

  真正的执行位是上面那条**可达性判据**(源码侧、静态、四条变异都对拍过)。漂移的**当期读数未实测** —— 本机 Postgres 未启动,且仓内纪律禁止在本机跑连库的东西;生产库不存在。此处如实记为未测量,不假装它被证明为 0。

### Added

- **可达性判据扩到第三份 service**(`role-permissions-control-plane-gate.spec.ts`,**原地扩展、不另造第二份**)。

  **为什么能共用而不是新建**:那份 spec 守的不是「角色」这个主题,而是一个**缺陷类** —— 「同一条不变量有多条写路径,只有其中一部分挂了强制闸」。本刀是该类的**第三个实例**,形状逐字相同:`PermissionsService` 的 `create()` 查 `assertPermissionCodeCreatable`、`delete()` 查 `assertSeedPermissionDeletable`,两者都锚在同一个谓词 `isSeedPermissionCode` 上,而 `update()` 一个都不查。spec 的机制(`SCAN_TARGETS` × `GATES` × `WRITE_SURFACES` + `this.<x>()` 传递闭包)本来就是按「登记一个写面」泛化的,接第三个写面只是加三条登记项;另造一份会把约 450 行 walker 复制一遍,而两份 walker 会各自漂移 —— 那正是本 spec 存在的理由。文件名保持不变:它被 9 处引用(含 CHANGELOG / 归档 handoff / 本目录 CLAUDE.md),改名的代价远大于名字略窄的代价。

  新写面 `permissionRow` 的口径**认全部写方法(含 `create` 家族)**,与 `rbacRole` 面**刻意相反**,理由是结构性的:`rbacRole.create` 撞内建 code 会先被 unique 预检查判掉,结构上改不到内建角色,拉进来只产生恒定误红;而 `permission.create` 恰恰**只对闭包内的码有意义**(闭包外的码是惰性的,`30106`),它必须查同一个谓词才知道该拒哪边 —— 现网三条腿确实都查它。

  另加一条自证钉住表名正则不串面:`\bPermission\b|\bpermissions\b` 必须**不**匹配 `RolePermission` / `role_permissions`(词内相邻,`\b` 不成立)。写成 `/Permission|permissions/i` 会把映射面的 raw SQL 误算成本面的写点,产出恒定误红,而止血手法通常是把闸削软。取样一律用 raw SQL 里真会出现的形态 —— 这个正则只被喂 `$executeRaw*` / `$queryRaw*` 的正文。

  **变异对拍读数** —— ⚠️ **出处:以下四条均为本机跑**(`jest-unit.config.ts` 纯静态 typed-AST,不起 Nest、不连 Postgres,单文件 ~0.4s,故按仓内纪律可本机执行);**未经 CI 复跑**,以 PR 上的 check run 为准。基线 `6 passed`:
  1. 摘掉 `update()` 上的闸 → **红**,且点名 `PermissionsService.update()` 与它的写点 `permission.update() @ …:235`,并给出该漏哪道谓词、后果是什么、怎么修。
  2. ⭐ 把闸往下埋两跳(`update()` 既不引用谓词也不直接调闸,经 `mutationHop1 → mutationHop2 → assertSeedPermissionUpdatable` 到达)→ **仍绿**,**且自证里 `toContain('update')` 同时通过** —— 两个条件必须一起读:说明这个绿不是「判据不看它了」,而是「闸被认出来了」。这是判据跟调用闭包而非字面量的直接证据。
  3. ⭐ 新增一个写 `Permission` 的公开方法(`renameDescriptionInBulk`,用 `permission.updateMany` —— 一个本文件此前没出现过的写方法)但不调闸 → **红**并点名它。这条验的是判据**未来唯一要干的活**;少了它,判据只是当期快照。
  4. 反向:闭包**外**的码不受影响 —— 由 `permissions-config-audit-characterization` 的 `C2` 覆盖(改由 prisma 直建一条 `audit-c.update.thing` 再走 `update`,仍成功且 audit 形状不变)。该用例连库,**本机未跑,推 CI 裁决**。

### Fixed

- **`permissions-config-audit-characterization` 的 `C2` 刻画点保住了,没有被删**(DoD 要求「改成断言现在被拒」,此处做得更多一点):
  - `C2` 仍刻画 `permission.update` 的 audit 形状,只是被改对象改由 prisma 直建一条**闭包外**的码 —— 与同文件 `C3` 处理 delete 时**同一手法**,不是新发明的。
  - 新增 `C2b` 保住「这条路曾经通」这个事实:同样的动作、同样的**闭包内**码(`member.update.record`,正是 `C2` 原本用的那条),现在必须被拒 `30110`,并额外断言**真的没写**(行未改 + 无 audit 残留)。

- **补一笔欠账(维护者 2026-08-22 定「并进下一刀」)**:`changelog.d/system-role-runtime-readonly.md` 的「变异对拍读数」段缺出处标注,已补明那三条读数是**本机跑**、未经 CI 复跑。补在 fragment 里而非 PR body —— 后者发版时不带走。
