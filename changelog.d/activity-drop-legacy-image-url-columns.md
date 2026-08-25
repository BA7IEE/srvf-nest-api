### DROP `Activity` 的两个裸 URL 遗留列 —— 把「永远无法满足的前置条件」换成此刻可判的三条

P2-14 刀 B(维护者 2026-08-25 拍板「现在就删」)。刀 A(#1146)只 expand:加了四个附件制列、
把旧列 `Activity.coverImageUrl` / `galleryImageUrls` 的写入口拆掉,**列本身原样留着**。
本刀把列删掉,🔴 **不可逆**(`ALTER TABLE "Activity" DROP COLUMN …`,无 down migration)。

#### ⭐ 真正的收获不是删了两列,是**换掉了一条分母恒 0 的前置条件**

台账 `NEXT_TASKS.md` 原写:

> 须先确认刀 A 已在 `main` 上**稳定运行一段时间**、且**无人报告**封面异常

这条**永远无法满足**:本项目无生产库、无真实用户 ⇒「无人报告」的分母恒 0,
既不可能满足也不可能证伪。写下它的时候它就已经是一张空头支票 ——
再等三个月,读数还是同一个 0。这是本仓已登记的缺陷形状:
**前置条件是照着「已上线系统」写的,而系统还没上线**。

正解不是破例放行,是**换成此刻可判的等价条件**。维护者拍板换成 E1/E2/E3 三条,
全部是代码事实与当日读数,**不含任何时间量**:

| | 条件 | 复核结论(起刀当日实测,不沿用 goal 里的读数) |
|---|---|---|
| E1 | 无新值注入 | ✅ 创建口全文零该键;唯二 update 是**回声写**(值来自同一行刚 select 出的自己);克隆口写字面 `null` / `Prisma.JsonNull`;可写 DTO 零 `*ImageUrl` 字段;全局 `whitelist` + `forbidNonWhitelisted` ⇒ 请求体塞该键是 **400 不是静默落库**;结构判据 `scripts/check-activity-image-reference.ts` 退 0(扫描面 269 个 class,地板 50) |
| E2 | 无语义读 | ✅ 12 个响应 schema 上的 `coverImageUrl` / `galleryImageUrls` **字段名**仍在,但取值一律来自 `resolveSignedUrlTrusted(coverImageKey)` / `galleryImageKeys`;presenter 只读 `images.*`,旧列的值不进任何类型化出参;单测负例「往旧列塞 `evil.example.com` ⇒ `JSON.stringify(res)` 不得含该串」在守 |
| E3 | 存量为零 | ✅ 起刀当日本机全库只读复测(纯 `SELECT count(...)`):**99 个库,97 个可测**(含 `Activity` 表与两列),`Activity` 行合计 **64**,`coverImageUrl` / `galleryImageUrls` 非空计数**均为 0**。⭐ 同一条 SQL 带**仪器自证** `count("title")` = **64**(= 行数)⇒ 计数器看得见非空值,那两个 0 是「没有」不是「没看见」。⚠️ 测不了的 2 个库逐个点名:`postgres`(PG 维护库,无 `Activity` 表)与 `app_test_…_w86`(**invalid database**,PG 直接拒连 ⇒ 既读不出也存不下数据) |

⚠️ **判「一列还有没有人用」不能用 grep 字符串。** `coverImageUrl` 全仓 69 命中,
其中绝大多数是 **API 出参字段名**(`@ApiProperty() coverImageUrl!: string \| null`)
与局部变量。只有四条通路真能读写一列:

| 通路 | 形状 | emit | 本刀实测处数 |
|---|---|---|---|
| a | `prisma.activity.*({ select / include })` | `SELECT` | 9 个 select 块(17 个键) |
| b | `prisma.activity.{create,update,…}({ data })` | `INSERT` / `UPDATE SET` | 3 处 |
| c | 已 select 出的行的属性访问 | 无(a 的下游) | 4 处显式 + **1 处 spread**(`buildProposalSnapshot` 的 `...row`,grep 按名字找不到) |
| d | `$queryRaw` / `$executeRaw` 裸列名 | 直接 SQL | **0 处** |

顺带订正一条曾经的错误说法:**`Content` 模型没有同名列**(只有 `coverImageKey`)——
全仓 Prisma 列声明里 `coverImageUrl` 只属 `Activity`(`schema.prisma` 实测两处声明)。

#### ⭐ 这一刀自带执行位:`prisma generate` 就是判据发放器

DROP 后 `prisma generate` 把两列从 `ActivitySelect` / `ActivityUpdateInput` /
`ActivityCreateInput` 里删掉 ⇒ **所有 a/b 类触点当场编译不过**。

| | `pnpm typecheck` |
|---|---|
| 只改 schema、一处调用点都不改 | ❌ **18 条 TS 错**,横跨 **6 个生产文件**(`activity-lifecycle` 6 · `activity-publish-review-access` 4 · `activity-proposal-applier` 3 · `activity-access` 2 · `activity-publish-proposal-v2` 2 · `activity-proposal-validator` 1) |
| src 全改完 | ❌ 第二个 tsc project 再吐 **1 条**(`activity-cover-attachment.e2e-spec.ts:161`)—— ⚠️ `typecheck` 串了三个 project 且 `&&` 短路,**第一轮读数看不到 test 侧**,别把首轮 18 当全集 |
| 逐处改完 | ✅ 退 0 |
| 变异 M1:留一处 `select: { coverImageUrl: true }` | ❌ 红,**恰好点名那一处**(`activity-access.service.ts:113`) |
| 变异 M1 还原 | ✅ 退 0 |

**全刀零 `as any` / 零 `@ts-expect-error` / 零类型断言**(`git diff` 实测无一处)——
那些写法等于把这个执行位关掉。

#### ⚠️ 执行位的**两个洞**(如实登记,比这一刀本身重要)

漏改并不总是会红。凡是**不经 Prisma 生成物**的那一侧,typecheck 结构上抓不到:

| 洞 | 形状 | 实测 |
|---|---|---|
| ① `activity-proposal-applier.ts` 的 `changedActivityFields` | 手搓 `Record<string, unknown>` 对照表 + `before[field as keyof typeof before]` 索引访问,**两侧都绕开生成物** | 变异 M2(把两个键留在对照表里)⇒ `typecheck` **退 0,不红** |
| ② 单测行夹具 | `activities.service.spec.ts` 的 `ActivityRow` 是手写 interface、`activity-archive.service.spec.ts` 的干脆是 `Record<string, unknown>` | 两处都还写着已删的列名而 typecheck 全绿 |

洞①**有真实后果**:`before['coverImageUrl']` 恒 `undefined`、快照侧恒 `null`,
比较器走 `JSON.stringify(undefined) !== JSON.stringify(null)` ⇒ 每次变更审核落库
都会把这两个键误报进 audit 的 `changedFields`。本刀已人工摘掉并在原处留注释;
**删列时这一类必须人工跟上,不能只信 typecheck**。

> 🔴 **一句大白话**:这次删列,「有没有漏改」本来是**编译器**替我们把关的 ——
> 漏一处就编译不过。但**有一类写法能绕开编译器**(把字段名写成字符串塞进一张手搓表里,
> 编译器看不懂那是列名)。**这两处是人工逮到的,不是机器。** 也就是说:
> 这一刀的「保险」覆盖了绝大部分,但**不是 100%**,而缺口的位置现在是已知的、写在这里的。

#### 🔴 刻意**不删**的三处同名键:审批快照的哈希兼容

维护者拍板「留着不动」。`ActivityProposalActivity`(`activity-proposal.types.ts`)、
`ProposalActivity`(`activity-publish-proposal-v2.service.ts`)两个 TS 接口上的同名键**保留**,
构造时改写字面 `null`;`activity-publish-review-access.ts` 的 `buildProposalSnapshot`
在 spread 之后**补回**两个 `null` 键。

理由是审批快照的完整性判据:

| 快照版本 | 比对方式 | 少两个键的后果 |
|---|---|---|
| v1 | 批准时**重建**一份,与库里那份做 `canonicalJson(…) === canonicalJson(…)` | 规范化串不等 ⇒ 在途 initial 审核单全部 `SNAPSHOT_INVALID` |
| v2–v5 | `sha256(unsigned)` 重算比对 | 哈希不等,同上 |

`canonicalJson` 把 null 值原样写成 `"key":null`(**不省略键**),所以「键在、值为 null」
与「键不在」是两个不同的串。而写死 `null` 与删列前的取值**逐字相同**(E1+E3),
因此这是行为等价变换。

⚠️ ⇒ 本刀之后仓里会出现「**DB 列删了、TS 接口键还在**」的形状。
**那是拍板结果,不是漏改** —— 三处都已在代码里写了注释说明,免得下一个人当成残留去删。
(goal 只点名了前两处;第三处 `buildProposalSnapshot` 是本刀复核时发现的 ——
它走的是 `canonicalJson` 相等而不是 `sha256`,但会坏在同一件事上。)

#### 其余连坐面

- ⭐ **删列时「哪些同名键该留、哪些该删」的判别式**(比记住「是哪三处」有用得多):

  > **这份结构会不会被重新推导出来、再跟已经存下来的那份逐字比对?**
  > **会** ⇒ 键必须留(值写死成它原本恒等于的那个常量);**不会** ⇒ 该删。

  按这条:审批快照**会**(v1 走 `canonicalJson` 相等、v2–v5 走 `sha256` 重算)⇒ 三处全留;
  **审计快照不会**(`activity-audit-recorder.ts` 写一次就是历史,没有任何东西会重推它再比对)
  ⇒ 那两个键**删掉**,连同只服务其中一个的私有 `jsonAsStringArray` 一起。
  列没了就不该继续记一个恒 null 的幽灵键。
- ⚠️ **顺带订正一句既有的假注解**(这属于「本刀的改动让这句话必须重新求值」,**不是顺手修**):
  `activities.service.spec.ts` 原写着「该收窄行为仍在 `activity-audit-recorder.ts` 的私有副本里,
  由 audit characterization 覆盖」。本刀要删那个私有副本,于是必须先确认这句话真不真 ——
  全仓实测**没有任何测试**断言过审计快照里的这两个键,**那句话当时就不成立**。
- **e2e 负对照改法**:`activity-cover-attachment.e2e-spec.ts` 原本在「PATCH 塞裸 URL → 400」
  之后查 `select: { coverImageUrl: true }` 断言那一列没被写。列没了 ⇒ 换成查此刻真正承载封面的
  `coverImageKey` / `coverAttachmentId` 两列均为 `null`。**不是放宽**:守的仍是「这个被拒的请求
  没在库里留下任何封面痕迹」,而且从看一列变成看两列。
- 6 份冷库重放 spec 的 `CURRENT_MIGRATION_COUNT` 97 → 98(`pnpm docs:migcount:check` 退 0)。
- **契约零漂移**:响应 DTO 的字段一个没动(出参字段名保留,值本就来自现签),
  OpenAPI 快照因此**无变化**;唯一变形的是 `ActivityPublishReviewResponseDto.snapshot`
  那个 `additionalProperties: true` 的不透明 JSON 块 —— 而本刀刻意让它**逐字不变**(见上)。

---

## 🔴 CI 冷跑逼出的第二件事:一条**书面上刻意严格**的判据与本刀的授权相撞

`Contract + E2E (2)` 红在 `test/e2e/activity-v11-batch4-allocation-mode-migration.e2e-spec.ts`:

```
● 第 84 migration activity allocation mode › upgrades a true 83 database …
  expectExistingColumnsUnchanged (:244)   expect(drifted).toEqual([])
  - Array []
  + Array [ "coverImageUrl", "galleryImageUrls" ]
```

它守的是「从**真 83 库**升到 HEAD,既有列一个都不许漂移」。本刀在第 98 条删了两列 ⇒ 它红。

### ⭐ 先取证「这条严格是不是刻意的」,再决定怎么改

`git log -S'expectExistingColumnsUnchanged'` 实测:**这个 helper 是 P2-14 刀 A 自己**
(`d8e557d7` / #1146)引入的 —— 它把原来的整串 `toBe(rowBefore)` 换成「只比对 `before` 里出现过的键」,
因为刀 A 加的 4 列当场打挂了整串比对。而它的 docstring 逐字写着:

> 收窄不削弱:既有列被改值 → 键值不同,红;**既有列被删 → after 里 undefined,红**;
> 物理行被重写 → 由紧随其后的 xmin 断言兜住。

⇒ **「能抓到删列」不是副作用,是当初论证「收窄不削弱」时点名保住的三条能力之一。**
⚠️ 更要命的是**同一个 commit 的 message** 里还写着「旧列保留零写入路径,**刀 B 才 DROP**」——
收窄这条判据、宣称删列仍会红、预告刀 B 会删这两列,**三件事写在同一次提交里**。

⇒ 这不是「判据没想到」,是「判据想到了、并且当时就把删列列为必须红的情形」。
所以处置方式必须由人拍,不能由实施方顺手放宽。

### 处置:具名白名单 + **防腐自证**;三条否掉的路都写下来

| 方案 | 裁定 |
|---|---|
| 放宽 `toEqual([])`(改成「只要没新增就行」) | ❌ **禁止**。实测本函数是全仓**唯一**能发现「`Activity` 表少了一列」的探测器 —— 另两处碰 `Activity` 列的断言(`activity-batch3-1p5-schema-constraints` / `activity-responsibility-workflow-expand-migration`)都是 `column_name IN (显式清单)`,清单里没有这些列,对「列消失」结构性失明。放宽 = 以后**任何** DROP 都不会被发现,是半瞎不是收窄 |
| 裸白名单 | ❌ 仓内刚修过这个形态(`C1_EXEMPT` 指着一个已被删掉的文件,**不生效、不报错、没人发现**) |
| 把 `before` 快照改成「只取该用例真正关心的列集」 | ❌ 那会把「哪些列该被守」从**全集**变成**某人当时想到的子集**,保护面损失更大且更难发现 |
| ✅ **具名白名单 `COLUMNS_DROPPED_SINCE_83` + 两条防腐自证** | 保护面**恰好只缩两个具名列**;白名单条目一旦变假,**自己就红** |

自证①「豁免项必须真的在 83 库上存在过」(否则是列名写错 / 条目过期)·
自证②「豁免项必须真的在 HEAD 上消失了」(否则说明列被加回来了,该撤豁免)。
docstring 里那句「既有列被删 → 红」已**同步**改成「除具名两列外……」并写清出处 ——
不同步就成了「散文与机器字段互相矛盾」。

⚠️ 该 helper **定义 1 处、调用 1 处**,**不是** 6 份计数 spec 共用的:`to_jsonb(activity)`
(`Activity` 表)全仓只有这一处,其余 5 份的漂移断言打在别的表上。⇒ 只需改一处,
也不存在「6 处各写一份白名单」的第二份真相。

### 变异对拍(6 轮,真跑冷库 83→98 重放;每轮约 20 s)

| # | 变异 | 读数 |
|---|---|---|
| 1 | 修复后基线 | ✅ **绿**(1 passed / 6 skipped) |
| 2 | 🔴 **多删一个不在白名单的列**(`Activity.cancelReason`) | ❌ **红**,`drifted` **恰是** `["cancelReason"]`(`:286`)—— 这是「只缩两列、没缩成半瞎」的**唯一**证据 |
| 3 | 还原 | ✅ **绿**(证明不是恒红) |
| 4 | 白名单列名写错(`coverImageUrlTYPO`) | ❌ **红**,**自证①** 开火:`existedAt83: true → false`(`:274`) |
| 5 | 清空白名单 | ❌ **红**,`drifted` = `["coverImageUrl","galleryImageUrls"]` —— **逐字复现今天 CI 那个红**,证明白名单真的在起作用,不是摆设 |
| 6 | 把一个**至今仍存在**的列(`cancelReason`)塞进白名单 | ❌ **红**,**自证②** 开火:`goneAtHead: false → true`(`:280`) |

⚠️ 第 2 轮的注入方式是「`deployCurrentMigrations` 之后直接对 scratch 库跑一条 `ALTER TABLE … DROP COLUMN`」,
**没有**去 `prisma/migrations/` 造第 99 条 migration:判据只看 `before` / `after` 两串 JSON,
列是怎么消失的对它不可见 ⇒ 两种注入在**被测的那个量**上等价;而造真 migration 会把
migration 数变成 99、先打挂 6 份计数 spec 的 `CURRENT_MIGRATION_COUNT`,红在别处、归因不清。
六轮跑完 `git status --porcelain` 只剩那一份 spec 的 `M`,`prisma/migrations/` 仍是 **98** 个。
