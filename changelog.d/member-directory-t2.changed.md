### Changed

- **MemberDirectory「给人找人」(issue #1048 T2)**:`GET admin/v1/members` 与
  `GET admin/v1/members/options` 的关键字搜索扩为 `memberNo + realName + nickname`,
  两端空白统一 trim(memberNo 侧复用写路径同源的 `normalizeMemberNo`),并按五级相关性排序:
  **memberNo 完全 > realName 完全 > memberNo 前缀 > realName 部分 > nickname**。
  列表与选择器共用同一套排序 —— 同一个 `q` 在两处给出同序。
- 第一版**刻意不做**拼音猜测 / 错别字纠正 / 相似度绑定;重名、重外号**正常返回多条**由人去挑
  (issue §5.2 规则 4:外号永远不能自动确认身份)。
- 不带 `q` 时**逐字保持旧行为**(`createdAt desc`)—— 目录排序只在搜索语境下有意义。

### 实现说明(为什么不是一条带 CASE 的裸 SQL)

五级相关性 Prisma 的 `orderBy` 表达不了,直觉做法是改 `$queryRaw` 写 `ORDER BY CASE …`。
**本仓刻意不那么做**:队员列表的 where 里带着 scoped authz 的组织范围腿
(`MemberOrganizationMembership` 在册谓词)。一旦改裸 SQL,那条谓词就要在 SQL 里重写一遍,
于是授权判定有了**第二份真相**,两份各自演化;而漂移的表现是「多返了本不该看见的人」,
不会有任何东西报错。

现在的做法是按级切分:每一级都只是一个 `Prisma.MemberWhereInput`,与调用方算好的
base where 用 `AND` 合并 —— 授权腿**原封不动地被复用**,不存在可漂移的第二份实现。
过滤/排序/分页仍全部落在 SQL(每级一条 count + skip/take),没有内存 filter/sort。
代价是每次搜索多 5 条 count 查询。

级间用 `NOT(前序并集)` 保证互斥:否则同一人会在多级里各被数一次,分页 total 虚高、翻页出现重复行。

### 判据

- 单测:五级顺序逐字锁定 / 级间互斥(第 i 级恰好排除前 i 级)/ trim / 级内 `memberNo asc,id asc` 定序 /
  不带 q 时不进相关性路径。
- 🔴 授权判据(DoD 3):五级 count 与每次 findMany 的 **每一条** where 都必须 AND 上带组织腿的 base;
  探测器自带正对照(对缺腿的 where 必须报阳)。
- e2e 反面样本**只在授权这一维上不同**:两人 realName / nickname / status 逐字相同,
  仅 PRIMARY 组织不同;先用 GLOBAL 调用者证明两人都能被同一个 `q` 命中(正对照),
  再断言 scoped 调用者只见树内那个、且 `total` 也只数树内(授权腿漏在 count 上会让行数对但总数泄露)。
- 两处都做过**变异对拍**:把 `AND: [base, level]` 改成 `AND: [level]` 后,单测 7 条红、
  e2e 恰好 1 条红且失败理由正是「树外那个人泄露进来」。
  ⚠️ 同一次变异下,**其余 9 条既有范围用例一条都没红**(它们不带 `q`,走不到相关性路径)——
  没有这条新判据,授权腿在排序路径上被删掉是完全不可见的。

### 契约

`gate:contract:semantic` 判定 **breaking=0 / additive=0** —— 本刀只改 `q` 的**语义与排序**,
不动任何字段形状,openapi 的 diff 只有描述文本。
