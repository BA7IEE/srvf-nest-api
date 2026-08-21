# R15 —— `src/common` 治理(架构治理 v4 终审【七】)

> 立项:v4 终审【七】把 `src/common` 纳入治理,规则数 15。规则表见
> [`archive/reviews/architecture-governance-v4/README.md`](../archive/reviews/architecture-governance-v4/README.md) §R15,
> 禁 `common/utils` grab-bag 的口径见 [`architecture-boundary.md`](../architecture-boundary.md) §7。
> 本刀**恒 report**、**零 `src/**` 改动**(不搬任何文件)。写就即固定,不再生。

## 1. 为什么现在堵:它是所有边界规则的共同逃生通道

R2(依赖边界)/ R5(跨域写)越接近 blocking,这个洞越危险 —— 把业务 helper 搬进
`src/common/foo.ts`,两边就都能合法 import,**边界规则整体被绕开**。

### 1.1 根因是结构性零执法,不是"规则写了但漏判"

`scripts/check-boundaries.ts` 的主循环第一步就是 `moduleOf(file)`:

- `scripts/check-boundaries.ts:1242` —— `walk('src', …)` 走查**整个** `src`;
- `scripts/check-boundaries.ts:1256-1257` —— `const moduleName = moduleOf(file); if (moduleName === null) continue;`
- `scripts/check-boundaries.ts:645-648` —— `moduleOf` 只认 `^src/modules/([^/]+)/`。

⇒ **`src/common/**` 的每个文件在循环第一行就被 `continue` 掉**。违规检测、
`raw-cross-domain-table`、以及 import 边收集(`moduleDependency`,在同一循环体内)
**全部够不到它**。

这条比三个发现数本身更重要:它解释了为什么这个洞十几轮治理都没被任何闸看见 ——
不是哪条判据判错了,是那片代码**结构上不在任何判据的视野里**。R15 之前,
`src/common` 在边界治理上是一块盲区。

## 2. 三条判据(恒 report;存量入基线,新增才是将来 blocking 的对象)

实现在 `scripts/check-boundaries.ts` 的 `scanCommon()`,输出在 `--violations` 的
`commonGovernance` 块。刻意**不并进**既有 `findings` 数组:那个数组喂着
`edgeUsage` / `readTiers` / `byKind`,而 `common` 不是 `domains` 里的域,混进去
会凭空多出一条 undeclared direction,把既有读数搅浑。

| 判据 | finding kind | 当前发现数 |
|---|---|---|
| ① common 禁业务 Prisma 访问(**delegate ∪ raw 物理表**) | `common-business-table-access` | **6** |
| ② common 禁业务谓词(状态 ∧ 时间窗内联组合) | `common-business-predicate` | **0** |
| ③ `common → src/modules/**` 入边(结构判据,最硬) | `common-to-module-import` | **0** |
| (附)common 内非字面 SQL,无法证明它没碰业务表 | `common-raw-sql-dynamic` | **1** |
| (附)kernel 白名单内的事实读,合法 | `common-kernel-fact-read`(allow) | 0 |

### 2.1 判据① 为什么必须覆盖 raw,而不只是 delegate

goal 原文写的是「出现业务 model 的 **delegate** 访问即违规」。**实测这是个设计缺陷**:
`src/common/**` 的 delegate 访问 = **0**,6 条真实命中**全是 `$queryRaw` 打物理表**。
照字面实现 ⇒ 判据恒 0 命中、CI 恒绿,而真正的洞原封不动。
维护者 2026-08-15 拍板改为 **delegate ∪ raw 物理表**,复用 `check-boundaries.ts:1332`
既有的 `raw-cross-domain-table` 物理表匹配逻辑(`@@map` 与 Prisma 默认表名都认)。

### 2.2 判据① 的 6 条存量:登记债务,**不给白名单**

6 条全部在 `src/common/prisma/claim-at-status.util.ts`,形态是 `$queryRaw` 硬编码
业务物理表名,跨**三个域**:

| 行 | 物理表 | model | 属主域 |
|---|---|---|---|
| `claim-at-status.util.ts:39` | `Activity` | Activity | participation |
| `claim-at-status.util.ts:46` | `ActivityRegistration` | ActivityRegistration | participation |
| `claim-at-status.util.ts:53` | `AttendanceSheet` | AttendanceSheet | participation |
| `claim-at-status.util.ts:60` | `Certificate` | Certificate | credentials |
| `claim-at-status.util.ts:67` | `recruitment_applications` | RecruitmentApplication | engagement |
| `claim-at-status.util.ts:74` | `team_join_applications` | TeamJoinApplication | engagement |

> ⚠️ **v4 终审「`claim-at-status` = 技术件白名单」按实测修正**(维护者 2026-08-15)。
> 那句话是在**不知道该文件打 6 张业务物理表**的前提下写的。
> 语义区别是承重的:**白名单 = 「这样做是对的」;基线 = 「这是历史债、只减不增」。**
> 这 6 条是真实的跨域耦合,不该被追认为正确 —— 正确终态是**表名由调用方传入、
> common 里不留业务表知识**,归 Phase 7 偿还项。
>
> 若改判成白名单,判据①的活跃发现数立刻变 0 —— 那正是 §2.1 要避免的空闸,
> 只是换了条路走回去。

`soft-delete.util.ts` 的技术件定性**成立不变**:纯函数、22 行、零 Prisma 访问、
零 model 知识(`src/common/prisma/soft-delete.util.ts:15-22`)。

### 2.3 判据② 复用 R6 三档读的语义读口径

判定 = `predicates.statusFields.length > 0 && predicates.timeWindowFields.length > 0`,
与 `check-boundaries.ts:1383` 的 `cross-domain-semantic-read-candidate` 同一口径
(`stateLikeString` 认状态列、`hasTimeWindowOperator` 认 `gt/gte/lt/lte`)。

## 3. `src/common/**` 子目录逐个定性

> **取数时点:2026-08-21(`73eb9178`)。** 原文标题写「十二个子目录」,复核时实际 **14** 个 —— 见 §3.1。

扫描面 = **41** 个非 `.spec.ts` 文件(原文 36,复核订正;见 §3.1)。**剥掉注释后**全仓 `src/common` 中引用业务 Prisma
model 名的文件**只有 1 个**(`claim-at-status.util.ts`)。

| 子目录 | 文件数 | 定性 | 依据 |
|---|---|---|---|
| `audit` | 1 | 技术件 | `mask-pii.util.ts` 纯 in/out 打码;文件头自述「本工具不做业务字段是否敏感的判断」 |
| `authz` | 1 | 技术件(平台) | `authz-context.ts` = 路由授权**词汇表** + ALS 上下文;无业务 model 知识 |
| `csv` | 1 | 技术件 | 纯编码工具 |
| `datetime` | 1 | 技术件 | `date-only.util.ts` 日期原语 |
| `decorators` | 17 | 技术件(**灰**) | 多个限流装饰器按业务流命名(`recruitment-` / `login-sms-` 等),**命名带业务、实体是限流配置**;零 model 引用、零谓词 |
| `dto` | 3 | 技术件 | 分页 / id param / expand query |
| `event` | 1 | 技术件 | `event-placeholder.ts` |
| `exceptions` | 2 | 技术件载体(**灰**) | `biz-code.constant.ts` 3233 行业务错误码登记表:载体是技术件,**承载大量业务知识**;它是全仓错误码单一真源,搬走会造第二份真相 ⇒ 维持现状,标灰留痕 |
| `filters` | 1 | 技术件 | 全局异常过滤器 |
| `guards` | 4 | 技术件 | 全局守卫 |
| `interceptors` | 1 | 技术件 | 响应包装 |
| `prisma` | 3 | **1 技术件 + 1 承重债 + 1 业务内核** | 见 §2.2 与 §4 |
| `activity-workflow` | 3 | ⏳ **待定性(维护者拍板)** | 2026-08-21 复核发现:本刀之后新增,从未定性。见 §3.1 |
| `identity` | 2 | ⏳ **待定性(维护者拍板)** | 同上 |

### 3.1 两个未定性子目录(2026-08-21 复核发现)

原文写「十二个子目录逐个定性」并列了 12 行,而 `src/common` 现有 **14** 个子目录 ——
`activity-workflow`(3 文件)与 `identity`(2 文件)是本刀之后新增的,**从未经过 R15 定性**。
扫描面随之由 36 个非 `.spec.ts` 文件变为 **41**,§3 末段「其余 34 个文件干净」应为 **39**。

⚠️ 这不是数字漂移,是**覆盖缺口**:R15 要求 `src/common` 每个子目录被定性为技术件 / 业务内核,
而这两个从未被问过。三条自动判据(业务表访问 / 业务谓词 / 模块入边)对它们照常生效且当前全绿,
所以**没有任何机器告警** —— 缺的正是"人得看一眼"的那一步。

**为什么不由我直接定性**(§4 那三件是维护者 2026-08-15 拍板的,同理):

| 子目录 | 我读到的事实 | 为什么需要拍板 |
|---|---|---|
| `activity-workflow` | `ActivityWorkflowGate` 读 `appConfig` 决定「活动 v1.1 新旧真相链走哪条」;`*.criteria.ts` 766 行是它的结构判据。零 Prisma、零 model 名 | 它编码的是**业务真相切换**,不是技术横切。放 common 的理由是刻意的(activities 与 attendances 需共用同一实例,见该模块文件头),但「合理的理由」不等于「定性为技术件」 |
| `identity` | `member-label.util.ts` 纯函数拼队员展示名;`member-origin.constant.ts` 是 `Member.memberOriginCode` 的字典码常量 | 前者是**业务展示格式**、后者是**业务词汇表**。都不碰 Prisma,但 R15 禁的是「业务谓词」不只是「业务表访问」 |

两者与 §4 的 `member-advisory-lock.util.ts` 是同一类问题(技术形态、业务语义),
那件当时的处置是**登记 owner 而非搬走**;这两个是否照此办理,请维护者拍板。

**已加机器守护**:`harness-guards.selftest.ts` 断言「本表列出的子目录集合 ==
`src/common` 实际子目录集合」。新增一个 common 子目录而不定性,selftest 当场红 ——
这正是本次缺口三个月无人发现的原因(三条自动判据只看内容,不看"有没有人定性过")。

## 4. D2 存量三件定性(实测复核)

| 文件 | 定性 | 实测依据 |
|---|---|---|
| `soft-delete.util.ts` | **技术件白名单**(维持) | 纯函数,零 Prisma、零 model 知识 |
| `claim-at-status.util.ts` | **技术件载体,但携 6 条跨域债** | 见 §2.2;**白名单定性已按实测修正为债务基线** |
| `member-advisory-lock.util.ts` | **业务内核**,owner = `identity-org` | 见下 |

`member-advisory-lock.util.ts` 已登记进 `harness/domain-map.json` 的 `kernel.primitives`
(第 5 条,`ownerDomain: identity-org`)。判据:它编码的是「同一队员」维度的**跨行
不变量**(考勤时间不重叠 / 贡献值跨 Sheet 汇总过门槛 / 同时只能有一条入队通路,
`member-advisory-lock.util.ts:112-115`)、**全仓取锁次序约定**(`:146-149`,含
team-join 唯一例外)、以及 40901 / 40902 两个业务码 —— 都是 identity-org 的领域知识。
`Member` 的 `modelOwnership.domain` = `identity-org`,与登记一致。

⚠️ 登记它需要同步改 `check-boundaries.ts` 的 `expectedPrimitives`(原先硬判「恰四条
Phase 0 primitives」)。顺手把该判据从**比个数**改成**比集合**并报出具体缺/多项 ——
散文里写死「恰 N 个」会随登记表增长变成假话,且失败时说不出是哪一条。

### 有没有第四件?

按我跑的两种测量(引用业务 model / 物理表名;内联业务谓词),`src/common` 的业务
耦合**只集中在 `prisma/` 的这两个文件**,其余 **39** 个文件干净(原文 34,随扫描面订正)。

**但这不等于「确定无第四件」**:`member-advisory-lock.util.ts` 一个 model 名都不引用
却是业务内核 ⇒ **「引用 model 名」不是业务内核的完备判据**。§3 已标出两处灰色
(`decorators` 的业务命名、`exceptions` 的业务码登记表),它们按当前口径不构成违规,
定性靠人工判断兜底,不由机器闸声称。

## 5. 阳性对照:三条探针都不是死探针

本仓在「0 发现」上吃过亏(读数恰好印证预期),故三条判据均做了阳性对照:

- **同一探针**对 `src/modules` 跑:判据① 出 **2022** 条(delegate 与 raw 两种形态都命中,
  如 `members-query.service.ts:132` 的 `member.findMany`)、判据② 出真实命中
  (如 `activity-batch.worker.ts:383` `ActivityBatchJob status=statusCode window=1`)。
  ⇒ `src/common` 的 0 是**真 0**,不是探针没跑。
- **selftest 阳性对照**:`harness-guards.selftest.ts` 内九条断言,三条判据各一正一负,
  **负样例是「形似但合法」**(与正样例只差一处语义):
  - ① 负例 = 读 `kernelReadFields` 白名单内字段的显式 select ⇒ 记 `common-kernel-fact-read`(allow),不得报违规;
  - ② 负例 = 只有状态谓词、**无时间窗**(与正例只差 `createdAt` 一项);
  - ③ 负例 = common 内部相对 import(同样是相对路径,但不落在 `src/modules`)。
- **变异对拍**:实现先提交,再逐条拿掉判据;每次变异 grep 校验命中数 = 1、还原后 = 0。
  四组(①raw / ①delegate / ② / ③)的红集:**跨判据两两不重叠**;
  ①raw 与 ①delegate 共享「① 存量基线」一条 —— 那是**同一条判据的两种形态**,共享基线计数符合预期。
  每组的**负样例在任何一次变异下都没红** ⇒ 判据没有过度绑定。
- **零影响实测**:与 `origin/main` 版扫描器逐字节对拍,`--violations` 输出**去掉
  `commonGovernance` 块后完全相同**(`inputDigest` 同值,findings 540 / report 455 /
  allowed 85 / undeclaredDirections 21 全部不变)。

## 6. 已知缺口

- 判据②只认**静态对象字面量**里的「状态 ∧ 时间窗」组合;raw SQL 里的等价谓词判不了
  (沿既有 `Semantic-read detection only recognises a static time-window plus status-predicate combination` 缺口)。
- 判据①的 raw 形态只匹配**字面量**物理表名;模板串拼接的表名落到
  `common-raw-sql-dynamic`(当前 1 条:`member-advisory-lock.util.ts:99` 的
  `SET LOCAL lock_timeout = ${…}`)—— 报成"无法证明",不当作安全。
- delegate 解析继承既有 known gap:别名 / 解构 / 包装器 / computed 访问不保证解得出。
- 判据③只查 `src/modules` 方向的入边;`src/common` → `src/database` 不算违规
  (当前唯一一条:`member-advisory-lock.util.ts:5` 的 type-only import)。

### 6.1 施工中踩到的一次假绿:「闸绿是因为它没在看」

本刀改的是 `scripts/**`,而验证时先跑的是:

```
npx tsc --noEmit -p tsconfig.json   # 退出 0
```

**这个 0 是假的** —— 根 `tsconfig.json` 的 `include` 只有 `["src/**/*.ts"]`,
它**根本没有编译 `scripts/`**。换成本仓 `pnpm typecheck` 真正用的三段之一:

```
npx tsc --noEmit -p scripts/tsconfig.json
```

立刻报出真错:`scan()` 的返回类型声明没跟着新增的 `commonFindings` 同步
(对象字面量多余属性)。之所以第一次能"跑通",是因为 `tsx` 只做类型擦除、不做类型检查 ——
**运行得出正确读数** 与 **类型正确** 是两件事,前者掩护了后者。

留在这里的教训与本文件 §1.1 的根因是**同一个形状**:
`src/common` 十几轮没被治理看见,是因为扫描器的循环第一行把它 `continue` 掉了;
这次假绿,是因为 typecheck 的 `include` 把 `scripts/` 排除在外。
两者都不是"判据判错了",而是**判据的作用域压根没覆盖到目标** ——
⇒ **看到闸绿,先问它的作用域包不包含你刚改的东西**,再问它判得对不对。

## 7. 本次未做

> ⚠️ **2026-08-21 复核:本节第三条已不成立**(6 条债务**已登记**,id `XC-0001`…`XC-0006`,
> `classification: common-business-table`,全部落在 `claim-at-status.util.ts`)。
> 该条以下保留本刀当时的状态留痕,并在原文后标注实况。
>
> 另:「前置 = 6 条债务登记落地」这个转闸前置**已满足**,但转 blocking 仍未做 ——
> 它现在缺的是判据本身的 EC(误报率书面接受 + 观察期),不再是债务登记。

- **未转 blocking**:三条判据恒 report。翻闸是独立一刀,前置 = §2.2 的 6 条债务登记落地
  (**该前置已于其后满足**,见上方复核注)。
- **未搬任何文件**:零 `src/**` 改动、零 prisma、零业务行为、零测试断言变更。
- ~~**6 条债务尚未登记进债务身份证台账**~~ —— **已登记(2026-08-21 复核)**。
  以下是本刀当时的状态留痕:该路径在 goal 写集之外,
  且当前 worktree **无该文件的红区授权**(实测 `check-redzone --hook` 返回 `HIT`)。

  精确说明**现在有什么、缺什么**(别把两者混为一谈):
  - **有**:`harness-guards.selftest.ts` 的「R15 ① 存量基线」断言把
    `commonGovernance.businessTableAccess` 钉在 6(+ 夹具 2)。这是**真执行位** ——
    新增任何一处 common 业务表访问,selftest 当场红。
  - **缺**:①它是**计数钉**不是棘轮 —— 数字变小也红,还债时要显式 true-up
    (可接受,但要知道);②它**没有 per-call-site 身份** —— 删掉一条、又新增另一条时
    计数仍是 6,**换掉**不会被发现。`architecture-debt.json` 的 `callSiteId` 正是
    为堵这个而存在,`scanCommon` 已按同一 `finding()` 身份证 schema 产出
    `callSiteId` / `violationFingerprint` / `shapeDigest`,登记时可直接取用。

  这是本刀最大的一条留口:**增能抓住,换抓不住。**
- §3 两处灰色定性(`decorators` 业务命名、`exceptions` 业务码登记表)**维护者 2026-08-15
  明确暂不拍板,维持标灰** —— 它们不影响三条判据的执法,等将来真有人要往里塞业务逻辑时再拍。
- `common-raw-sql-dynamic` 的那 1 条未做进一步取证。
