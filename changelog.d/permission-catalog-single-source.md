### 重构

- **Permission Catalog 单一事实源**(P1-32 PR 1;纯重构,零行为改变)。权限**定义**从两处旧位置合并进 `src/modules/permissions/permission-catalog.ts`:`prisma/seed.ts` 里的 58 个声明(52 个 `*_PERMISSION_SEED` 数组中的 49 个 + 9 个权限码常量)与 `rbac-seed-facts.ts` 全文(该文件已删除)。字面量原样搬运,一个字符没改。

  **搬了什么、没搬什么**:搬的是「定义一条码」,留在 `prisma/seed.ts` 的是「把码发给谁」—— `OPS_ADMIN_/BIZ_ADMIN_/ORG_ADMIN_PERMISSION_SEED`(三个按角色过滤出来的派生数组)、各 `*_PERMISSION_CODES` 清单、各排除集,以及 `RBAC_SEED_CATALOG` 本身。这条分界线不是随手划的:PR 2 起要往权限定义上挂中文名 / 分类 / 风险 / 授予策略,那些元数据是**每条码**的属性,不是每个角色的。

  四条等式实测成立,**比集合不比计数**(计数相等掩盖得了内容互换):权限码全集 237 · Permission 表 237 行(含 module/action/resourceType/description 逐字段)· 内建角色 15 个 · RolePermission `(role.code, permission.code)` 337 对,搬家前后逐元素一致;同一个探针库上连跑两次 seed 零差异。

  ⚠️ **搬家最容易造成的是假绿而不是红**:权限码全集由 `SEED_FACTS_CLOSURE` 具名的文件决定,把定义搬走而不同步这个闭包,全集会**静默缩水** —— 而缩水后的全集恒是 `RBAC_SEED_CATALOG` 各桶并集的子集,`check-permission-catalog-closure` 的方向 (a) 反而全绿。本刀同步了三份闭包副本(`docs-counts` / `generate-rbac-map` / `check-rbac-map`,三处都调 `assertSeedFactsClosure` 交叉核验),并实测了反向:把权限目录从闭包里摘掉后,五个消费者(闭包闸 · 两个 rbac-map 脚本 · 「码必须有持有人」闸 · `docs:counts`)**全部变红**,没有一个静默通过。

### Harness / 执法层

- 🔴 **红区 `permission-seed-facts` 规则跟着事实走**(`harness/redzone.json`)。glob 由 `rbac-seed-facts.ts` 改指 `permission-catalog.ts` —— 不改的话,这次纯搬家会把一道 D 档护栏**拆掉**:今天要维护者授权才能动的权限定义,搬完就变成谁都能写。护栏该守的是「权限定义」这件事,不是某个文件名。

- **闭包自测的不变量换了形状**(`scripts/harness-guards.selftest.ts`)。搬家前权限定义分居两处,不变量是「剔除 `rbac-seed-facts.ts` 后码数正好少 14(= 它独有的 14 条 `rbac.*`)」。搬家后 237 条全在权限目录、`prisma/seed.ts` 里一条不剩,于是换成更强的一对:**权限目录独自装着全部 237 条**(正向)+ **剔除权限目录后恰剩 0 条**(反向)。后者正是「seed.ts 里没有第二处权限定义」的机器形式 —— 有人图省事在角色装配旁边补一条 `code: 'x.y.z'`,它当场红。

  ⚠️ 反向那条的期望值是 **0**,单独看会踩本仓登记的「空集恒等于空集静默变绿」陷阱,所以它必须与正向那条**成对读**:一条钉住总量非空,一条钉住分布只有一处。

- **`*.reset.credentials` 家族闸的自证锚点补齐**(`reserved-super-admin-permission-codes.spec.ts`)。原锚点断言「storage 那条码出现在 `prisma/seed.ts`」,用来证明扫描器真的走完了 `src` + `prisma` 两个根、不是只扫了一半。搬家后 `prisma/**` 里**一条权限码都不剩**,该锚点在结构上不可能再成立 —— 但它守的性质仍要守,拆成三条各守一半:① walker 仍走到 `prisma/`(锚文件本身,哪天有人把码写回 seed.ts,扫描面还在);② **定义侧**被解析到(权限目录里那条 `code:`);③ **消费侧**也被解析到(判权装饰器所在的 controller)。③ 是新增的:少了它,「扫描器只认目录文件」这种缩窄会静默通过,而新 provider 漏登记时最先出现那条码的地方恰恰是消费侧。三条各自做过变异对拍,均真红。
