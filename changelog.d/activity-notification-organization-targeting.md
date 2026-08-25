### 活动通知按**组织**定向 —— 勾上级含下级、与受众标签取交集(AC-066 的组织那一格)

维护者 2026-08-25 拍板三问:发活动通知**要能**勾某个大队/分队;勾了上级,下面分队**算**;
既勾组织又勾标签**两个都满足才发**(交集,AND)。

#### schema(D 档,expand-only)

`activity_publish_reviews` 加**一列**可空 `audienceOrganizationIds JSONB`,与同表
`audienceTagCodes`(20260817100000)**逐字同形**:零 default、零回填、零 DROP、零 RENAME、
零既有行重解释。存量 review 一律取 NULL,读作「未按组织定向」,行为与本刀之前逐字相同。
回滚 = `ALTER TABLE "activity_publish_reviews" DROP COLUMN "audienceOrganizationIds";`

#### 语义三分支(与 `audienceTagCodes` 同构)

| 值     | 含义                                        |
| ------ | ------------------------------------------- |
| `null` | 不按组织定向(存量行 + 不勾组织的新行)       |
| `[]`   | 该维度**不设限** —— ⚠️ **空数组不是空交集** |
| 非空   | 该组织**及其全部后代**中有有效任职的会员    |

「空数组不是空交集」这条单独立了判据:把它当交集会让「没勾组织」静默变成「谁都不发」。

#### ⭐「含下级」走真子树,不是编码前缀

`organization_closure`(`ancestorId ∈ 勾选组织 → descendantId`,含 depth-0 自身行),
**复用**全仓既有的同一条子树口径 —— `OrganizationsService.queryDescendantOrgIds`、
发布审核列表 / 任职 / 分管三处 `includeDescendants`、`AuthzService` 的 `ORGANIZATION_TREE`
展开,查询形状逐字相同(`where: { ancestorId: { in } }, select: { descendantId }`)。
仓内**只有这一套**子树口径(`member-qualification-facts` 那条走的是反方向:
`descendantId → ancestorId` 求祖先集,是另一个问题不是第二套口径)。

⚠️ 明确**不用** `Organization.code` 前缀匹配:编码前缀是命名约定不是树结构,
改名 / 跨父移动 / 同前缀兄弟三种情况下都会静悄悄给出错答案。判据里有一条禁止型结构断言
(冻结模块内零 `startsWith` / `endsWith` / `contains:` / `$queryRaw`)把它钉死。

有效任职复用 `MembershipTermStateMachine.effectiveWhere(at)`,时刻取**业务事件时刻**
不取新墙钟 —— 否则同一事件重放会算出另一批人,收件人冻结的第 3 条锁当场失效。

#### 不收窄时盖章逐字节不变

收件人冻结加了**第 6 个**依据常量 `audience-organizations`,但它**只在真的按组织收窄时**出现。
`null` / `[]` 时 `basisKind` 仍是 `audience-tags` / `all-active-members`、`basisRef` 仍是裸标签码、
幂等 `requestHash` 的 payload 形状也不变 —— 否则在飞的 intent 重放会带着不同 payload 撞上
`sameIntent`,当场抛 `NotificationOutboxInvariantError`。audit 的 `audienceOrganizationIds` 键
同理**空数组时整个键不进 `extra`**,不按组织发的审计形状与本刀之前逐字相同。

真收窄时 `basisRef` 用 `tag:` / `org:` 前缀区分两个维度 —— 混在一个数组里事后没人分得清哪个是哪个。

#### 判据:正向 + **两个**反向 + 边界(⭐变异对拍读数)

一个共用世界,四个人**各自只在一个维度上**与 `m-both` 不同(否则上层边界会遮蔽下层边界):

| 成员         | 组织              | 标签   | 期望                             |
| ------------ | ----------------- | ------ | -------------------------------- |
| `m-both`     | org-a(直属)       | 有     | 收到(正向)                       |
| `m-org-only` | org-a(直属)       | **无** | 不收到(反向①,只差标签这一维)     |
| `m-tag-only` | **org-b**(无关)   | 有     | 不收到(反向②,只差组织这一维)     |
| `m-sub`      | **org-a-1**(下级) | 有     | 收到(只差「直属 vs 下级」这一维) |

三次变异对拍(单 spec 27 例,红集互不相同且逐条点在被变异的那一维上):

| 变异                  | 红 / 总    | 红集                                        |
| --------------------- | ---------- | ------------------------------------------- |
| **交集 → 并集**       | **4 / 27** | 反向① · 反向② · 交集全集 · 边界「只勾组织」 |
| **真子树 → 只取直属** | **3 / 27** | 子树用例 · 交集全集 · 边界「只勾组织」      |
| **空数组当成空交集**  | **3 / 27** | 边界「只勾标签」 · B7 既有三分支两条        |

⚠️ **对拍夹具本身先修过一次**:第一版 mock 只硬编码解释 `ancestorId.in`,于是「子树改成只取直属」
(给闭包查询多加一个 `descendantId.in` 收窄)只剩 **1 例红,而且是 `toHaveBeenCalledWith` 的
结构断言 —— 行为侧一例都没红**:问的条件变了,mock 的答案却没变。改成「把 `where` 里每一个
`{ 列: { in } }` 都真的施加到夹具上」之后同一变异才升到 3 例红。
**恒返回固定行的 mock 会让「查询被收窄」这一整类变异隐身**,选对拍仪器时必须先验这一点。

#### 顺带补上的判据缺口

「producer 不得自己算收件人」那条禁表此前只列本刀之前的四张表。组织定向带进来两个新的
收件人来源(`organizationClosure` / `memberOrganizationMembership`)—— 一并补进禁表,
否则这条判据只对旧来源有效,**后来的每一个来源都从它底下溜过去**。

#### 入参校验

勾选的组织解析不出未软删行即**整批 400**,与标签码解析失败同处置:
打错一个 org id 会让交集为空、通知一个人都不发,却照样返回 200 —— 那是「静默少发一整批人」。
只校验**勾选的**组织,后代由闭包表负责(重复校验会造出第二份真相)。
