### Changed

- **🔴 `prisma/seed.ts` 的四处 `permission.upsert` 改为覆写 `description`,代码常量单向成为权威(P2-15)—— 这是 PR 3b 留下的第二条漂移路,现在关上了。**

  `Permission.description` 与代码常量分叉有**两条**路,至此**两条都关**:

  | | 怎么发生 | 状态 |
  |---|---|---|
  | **V1** | 运行时经 `PATCH /permissions/:id` 改 DB 行 | ✅ P1-32 PR 3b(`9cbb0c52`,`30110`) |
  | **V2** | 改**代码里**那个字符串,而 seed 的 `update: {}` 保证**既有库永远收不到** | ✅ **本刀** |

  V1 关闭是 V2 能这么做的**前提**,不是可以二选一:`PATCH` 关上后运行时**不再存在**任何改这四个字段的入口 ⇒ 覆写不可能踩掉「运营手工调过的文案」,因为不存在这种文案。PR 3b 的 fragment 把这层先后关系写清楚了,本刀是那次立项的落地。

  **为什么是现在改**:今天不存在任何长期存活的库(生产仍 NO-GO,卡域名;真机只跑过 `APP_ENV=smoke`)⇒ 覆写不会碰到任何真实运营数据。**首次上线之后同样的改动就变成「可能静默改写运营数据」**,届时要么不敢做,要么得先做一轮数据比对与迁移。

- **⭐ V2 不是假想缺陷 —— 实测本机开发库 `app` 已漂 4 条。**

  PR 3b 的 fragment 当时如实记为「漂移的当期读数未实测(本机 Postgres 未启动)」。本刀补测了(只读,未改任何数据):

  | 权限码 | 库里(旧) | 代码里(新) |
  |---|---|---|
  | `recruitment-application.mark.threshold` | …**红十字**/BSAFE… | …**急救资质**/BSAFE… |
  | `certificate.read.record` | 查看队员证书(列表 + 详情…) | …**+ 证书编号默认掩码、审核备注与审核人不返** |
  | `member-profile.read.record` | …(含敏感字段) | …**documentNumber / mobile 默认掩码,明文走 read.sensitive** |
  | `member.offboard.record` | …不级联撤任职/分管 | …**含任职、分管与直接角色绑定** |

  ⚠️ 读数**只代表本机库**(测试库 `app_test` 为 0 条);生产库不存在。四条形状完全一致:**代码后来改对了、库停在旧文案** ⇒ 覆写方向是**修复**,不是丢数据。⚠️ 这类漂移**零症状** —— 修前没有任何测试、任何检查会因它变红,这正是它能安静存在这么久的原因。

  ⚠️ 顺带订正 P2-15 goal §0 的一句话:它断言「今天不存在长期存活的库 ⇒ 没有任何东西会被覆盖」。**后半句是错的**,本机 `app` 就有 4 条会被覆盖。结论(该做)不变,但理由要换成上面这个实测,别沿用原话。

- **只覆写 `description`,`module` / `action` / `resourceType` 刻意不动。**

  那三个是**结构字段**(被查询与索引使用,`@@index([module])` / `@@index([resourceType])`),覆写它们的打击面与本刀不同族 ⇒ 另立项。已在 seed 注释里写明这是刻意的范围收窄,**判据也刻意不断言「update 里只能有 description」** —— 否则那个后续立项会先撞判据。

- **⚠️ 一个 goal 没预料到的副作用,如实记:`Permission.updatedAt` 现在每次 seed 都跳。**

  `updatedAt` 是 `@updatedAt`,而 Prisma 的 upsert 在行已存在时**恒执行 UPDATE**,不会因为新值与旧值相同而跳过 ⇒ 237 行的 `updatedAt` 每跑一次 seed 变一次。已做 A/B 对照证明是本刀引入的:两个全新库各连跑两次,**改动前** `updatedAt` 哈希稳定、**改动后**变化;两者的行数(237)与 `description` 内容哈希都逐字相同。

  **为什么不修**:消除抖动需要把 `update` 写成条件表达式(或改走 guarded `updateMany`),而那与本刀判据要求的**字面量对象**形状**结构上不兼容** —— 判据一读到 `ConditionalExpression` 就判「不是对象字面量」变红。⇒ 「字面量判据」与「逐字节幂等」二选一。按 goal 的 DoD 保留字面量形状。

  **影响评估**:`permissionSelect` 确实对外返回 `updatedAt`,但 PR 3b 之后 Permission **没有任何运行时写入口** ⇒ 该字段本来就只能记「seed 何时碰过它」;仓内无任何测试或业务逻辑依赖它(既有断言只有 `toBeDefined()` 与一条「PATCH 不得改它」的字段黑名单)。仓内既有幂等标准是**逐表行数 IDENTICAL**(见 `prisma/CLAUDE.md`),本刀满足。要不要改成 guarded 写法,留给维护者另行拍板。

### Added

- **⭐ `seed-description-authority.criteria.spec.ts` —— 本刀主交付物,含一条**反向**锚点。**

  纯静态 typed-AST(不起 Nest、不连库,~0.4s)。三块:

  1. **正向**:结构性扫**全部** `prisma.permission.upsert(` 调用,每一处的 `update` 都必须含取自常量的 `<x>.description`。**不写死 4 处、不按行号** —— 第 5 处 upsert 加进来时判据必须看见它。只认 `<对象>.description`,写死字面量 `description: 'xxx'` 不算(那不是让代码常量成为权威)。
  2. **⭐ 反向锚点**:`dictType` / `dictItem` 的 **7 处** upsert 必须**仍是** `update: {}`。
  3. **自证**:两族各自地板锚点(≥4 / ≥7,防「扫描面塌了 ⇒ 零命中 ⇒ 自动全绿」)+ **合成样本对拍**(正样本 / `update:{}` / 写死字面量 / 注释与字符串里的同名文本**不得**被计入)。最后一条不是摆设:本刀找行号时 `awk` 就匹配到了 `seed.ts` 注释里反引号包着的 `update: {}`,typed-AST 不会中招。

- **⭐ 字典(`dictType` / `dictItem`)刻意不跟着改 —— 这条最需要被将来的人读到。**

  改完之后 `seed.ts` 里两处形状不同,**这是刻意的,不是漏改**。两者语义已经分岔:

  | | 运行时可改吗 | `update: {}` 的含义 |
  |---|---|---|
  | **Permission** | ❌ PR 3b 之后已关(PATCH 一律拒) | 「代码改了库收不到」= **缺陷** |
  | **DictType / DictItem** | ✅ 运营本就该能改(**是功能**) | 「不回退运营的调整」= **正确** |

  🔴 把字典也改成覆写 = **悄悄打掉字典的运营编辑功能**(后台改过的文案下次 seed 就被刷回),而 `recruitment_stage` 这类字典**存在的全部意义就是「改文案不发版」**。⚠️ 更要命的是它**零症状**:正向那条被破坏了还会有人发现(文案不更新),反向这条被破坏**不会有任何测试变红**。所以反向锚点比正向那条更重要,不是补充。seed 的三个字典函数处各加了注释说明为何不跟着改,并指向该锚点。

  ⚠️ **goal §2 的 P4 读数是错的**:它说字典 `update: {}` 有 3 处(`526/539/575`),实测是 **7 处**(另有 `600/707/752/760`)。反向锚点按实测 7 处做 —— 照 goal 字面做,另外 4 处被顺手统一时会**静默放过**。

- **变异对拍三条(本机跑,纯静态判据)**:⚠️ 出处标注 —— 判据是 `jest-unit.config.ts` 下的纯静态 typed-AST,不起 Nest、不连 Postgres,单文件 ~0.4s,故按仓内纪律可本机执行;**未经 CI 单独复跑**,以 PR 上的 check run 为准。基线先验 `6 passed`:

  1. 任一处改回 `update: {}` → **红**并点名 `prisma/seed.ts:1223`。
  2. ⭐ **新增一处 `permission.upsert` 而不带 description** → **红**并点名 `prisma/seed.ts:2875`。这条验的是判据**未来唯一要干的活**;少了它,判据只是当期快照。
  3. ⭐ 把字典那处改成 `update: { label: … }` → **反向锚点红**并点名 `prisma/seed.ts:543`,失败信息里直接写明「字典的 `update: {}` 是功能不是缺陷」。

  每次变异前先 `diff` 确认文件真的变了(防空变异退 0 被读成「判据没牙」);回滚后复验全绿。

### Fixed

- **三处注释改准 —— 仓内铁律:护栏守的条件必须与注释是同一件事。**
  - `seedRbac` 处那段 PR 3b 写的「**待维护者另行拍板,不要顺手改**」说明**已过期**(拍板已落地),重写为新语义,并把「为什么现在能这么做」「刻意的范围收窄」「字典为何不跟着改」一并写进去。
  - 文件头第 7 条「全部 upsert 幂等:重复跑不重复创建 / **不覆盖运营运行时调整**」与 `seedBizAdminRbac` docblock 的同款表述,在本刀之后各成了半句假话,已补上例外(并点明字典 / 组织 / 职务仍是 `update: {}`)。

- **判据落点刻意选 `*.criteria.spec.ts`,不进 `scripts/`。**
  `.spec.ts` 被 `check-boundaries.ts:1942` 显式排出 ROUTE_AUTHZ digest 的输入闭包(已实测:`docs:counts` / `rbacmap` / `boundaries` / `codemap` / `authz` 五道生成物守护全绿)⇒ **不改写 digest、不占串行道**。AST 扫描**内联进 spec** 而不是加进 `scripts/docs-counts.ts`,省掉第二条 enforcement-layer 红区授权 ⇒ 本刀红区预算只有 `prisma/seed.ts` 一条。
