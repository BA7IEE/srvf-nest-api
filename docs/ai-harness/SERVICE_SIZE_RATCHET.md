# 大 service 尺寸棘轮(Phase 6-A · report)

> 权威源:`docs/archive/reviews/architecture-governance-v4/README.md` §11 Phase 6 + 终审【九】。
> 本文只覆盖 **6-A 立闸**。**6-B「按触碰拆分」与转 blocking 都不在本刀内**,见文末「本次未做」。
>
> 判据实现:`scripts/check-codemap.ts --service-size`;基线:`harness/service-size-baseline.json`;
> 阳性对照:`scripts/harness-guards.selftest.ts`(尺寸段 22 条)。

## 1. 度量口径

| 项 | 取值 |
|---|---|
| 度量 | **非注释非空行**(NCLOC),用 TypeScript scanner 剥注释后统计 |
| 阈值 | **700**(复用既有 god-service 阈值) |
| 发现面 | `src/**` 下的 `*.service.ts` / `*-orchestrator.ts` / `*.handlers.ts`,递归,排除 `*.spec.ts` |
| 基线条目身份 | **文件路径**(数值是属性,不是身份 —— 终审【九】「count 永不作为最终棘轮身份」) |

### 1.1 为什么不用物理行

两条理由,**第二条才是决定性的**:

1. 物理行会把「注释详尽」读成「文件臃肿」。实测全仓中位数 净/物理 ≈ 91%,不算高;但离群显著 ——
   `certificates.service.ts` 66%(物理 1122 → 净 739)、`users.service.ts` 75%、
   `recruitment-certificate-claims.service.ts` 78%。仅此一条,只影响少数文件的排序。
2. **反向激励**:物理行棘轮下,**删掉文件头的模块级铁律注释就能「达标」**。
   本仓恰恰把模块铁律写在文件头注释里,那是约束 AI 的主要载体 ——
   一条会奖励「删注释」的棘轮是在拆自己的地基。这条与第 1 条无关,且无法通过调阈值绕开。

剥注释用 TypeScript **parser**(取真实 token 的字符区间,注释按定义落在区间外)而非正则、
也不再用裸 scanner:字符串里的 `//`、正则字面量里的 `/*`、模板串里的换行,正则一律会数错;
裸 scanner 则会在带替换的模板串处脱锁 —— 那是 2026-08-15 修掉的一个真缺陷,见 §8。
selftest 尺寸段有 `const s = '// not a comment';` 计 1 行等 **13** 条口径对照。

### 1.2 与旧口径的差异(D1 要求逐条写明)

旧 `service-loc-godservice` 检查:物理行 > 700,发现面 `src/modules/<模块>/*.service.ts`(**不递归、只认 `.service.ts`**)。
本刀把两者统一到一套,`service-loc-*` 与尺寸棘轮从此**共用同一份计算**(§0「不得另立第二套标准」)。差异实测:

**新口径多抓 2 个 —— 旧发现面在结构上就看不见它们:**

| 文件 | 净行 | 说明 |
|---|---|---|
| `attachments/attachment-storage-orchestrator.ts` | 2518 | **全仓最大的代码文件,此前不在任何检查视野内** |
| `notifications/notification-outbox.handlers.ts` | 1331 | 同上 |

**新口径剔掉 5 个 —— 它们只是被注释撑过线:**

| 文件 | 净 / 物理 | 比值 |
|---|---|---|
| `organizations/organizations.service.ts` | 548 / 710 | 77% |
| `recruitment/recruitment-identity.service.ts` | 622 / 773 | 80% |
| `member-departments/memberships.service.ts` | 594 / 729 | 81% |
| `activity-registrations/activity-qualification-evaluator.service.ts` | 674 / 722 | 93% |
| `activities/settlement-review.service.ts` | 679 / 746 | 91% |

阈值语义随之从 `> 700` 改为 `>= 700`(边界在 selftest 有 699/700 两侧对照)。

### 1.3 阈值依据

**复用既有 god-service 阈值 700**,而不是另取一个数。理由:仓库里若同时存在
「WARN 用 700 / 棘轮用 X」两个尺寸数字,那本身就是 §0 要避免的第二套标准。
(v4 §11 Phase 6 的行文是「11 个千行 service」—— 那是**当时**的规模速写,不是阈值拍板;
按 1000 取阈值会得到 13 个文件、106 个历史 PR 摩擦,结论与 700 完全一致,见 §3。)

### 1.4 inputDigest 覆盖面

`inputDigest` **只摄入口径本身**(度量名 / 阈值 / 发现面后缀 / 根目录 / 生成器版本),
**刻意不摄入 `src/**` 的内容**。摄入源码会让基线在每个业务 PR 都「过期」一次,噪声淹没信号;
而「基线值 vs 磁盘」本来就由棘轮判据本身回答,再用 digest 查一遍是重复且更弱的判据。
它回答的是另一个问题:**这份基线是不是用当前这套口径算出来的**。
无时间戳、无 git SHA(v4 §9 勘误①)。

## 2. 当前分布(基线,26 个文件 / 共 31165 净行)

> 2026-08-15 按修正后的度量重算(§8)。此前记为「31 个文件 / 36685 净行」,其中
> **5 个是度量缺陷造成的假阳性**(纯靠注释被误计才越过阈值),已移出;0 个新入册。

| 文件(`src/modules/` 起) | 域 | 净行 |
|---|---|---|
| `attachments/attachment-storage-orchestrator.ts` | attachments | 2472 |
| `activity-registrations/activity-allocation.service.ts` | activity-registrations | 2379 |
| `activities/activity-publish-proposal-v2.service.ts` | activities | 1817 |
| `activity-registrations/activity-registrations.service.ts` | activity-registrations | 1761 |
| `activities/correction-application.service.ts` | activities | 1704 |
| `attendances/attendances.service.ts` | attendances | 1699 |
| `attachments/attachments.service.ts` | attachments | 1519 |
| `storage/storage-object-ledger.service.ts` | storage | 1398 |
| `activities/activity-publish-review.service.ts` | activities | 1335 |
| `activities/activities.service.ts` | activities | 1254 |
| `notifications/notification-outbox.handlers.ts` | notifications | 1171 |
| `activities/activity-settlement-http.service.ts` | activities | 1133 |
| `activities/activity-draft.service.ts` | activities | 954 |
| `activity-registrations/capacity-reservation.service.ts` | activity-registrations | 921 |
| `users/users.service.ts` | users | 891 |
| `activity-registrations/registration-command.service.ts` | activity-registrations | 880 |
| `notifications/notification-outbox.service.ts` | notifications | 876 |
| `role-bindings/role-bindings.service.ts` | role-bindings | 827 |
| `members/members.service.ts` | members | 817 |
| `activities/settlement-draft.service.ts` | activities | 808 |
| `activities/activity-responsibility.service.ts` | activities | 787 |
| `activities/activity-closure.service.ts` | activities | 784 |
| `recruitment/recruitment-applications.service.ts` | recruitment | 763 |
| `recruitment/recruitment-certificate-claims.service.ts` | recruitment | 750 |
| `certificates/certificates.service.ts` | certificates | 739 |
| `activity-registrations/onsite-participation-command.service.ts` | activity-registrations | 726 |

按域(文件数 / 净行合计):`activities` 9 / 10576 · `activity-registrations` 5 / 6667 ·
`attachments` 2 / 3991 · `notifications` 2 / 2047 · `attendances` 1 / 1699 ·
`recruitment` 2 / 1513 · `storage` 1 / 1398 · `users` 1 / 891 · `role-bindings` 1 / 827 ·
`members` 1 / 817 · `certificates` 1 / 739。

**移出的 5 个**(旧值 → 修正值):`activities/ledger-posting.service.ts` 751 → 593 ·
`activities/ledger-preparation.service.ts` 827 → 681 · `activities/settlement-submit.service.ts` 789 → 616 ·
`notifications/notification.service.ts` 706 → 644 · `recruitment/recruitment-promotion.service.ts` 817 → 666。
它们**本就不该在基线里**;将来若真长过阈值,会按「基线外文件达到阈值」被当新违规拦下 —— 这是正确行为。

## 3. 转闸摩擦评估(D4)

方法:把棘轮回放到 `main` 的全部 first-parent 提交(本仓 squash merge,一提交 ≈ 一 PR)。
基线取**今天**的文件集与今天的值 —— 即棘轮即将冻结的那一份。

> 2026-08-15 按修正后的度量 + 重算后的 26 文件基线复测(§8)。立闸当时(1016 个提交 / 31 文件 /
> 有缺陷的度量)记为 **宽 182(17.9%)· 严 106(10.4%)**;两个口径变量同时变了,故新旧不可逐位相比,
> **但结论方向完全一致**。
⚠️ 本仓总历史只有 **101 天**(2026-05-05 起),比 goal 说的 180 天窗口还短,故窗口 = 全部历史。

| 口径 | 会被拦下的 PR | 占比 |
|---|---|---|
| 宽:任何增长了基线文件的 PR | **161** / 1029 | 15.6% |
| 严:增长时该文件**已经**超阈值 | **92** / 1029 | 8.9% |

两者的差 = 「文件初建或尚小时的增长」,那类增长今天不会再发生一次,故**严口径更贴近未来实况**。

**严口径按月**:5月 4 · 6月 13 · **7月 69** · 8月 20(8 月仅过半)。
7、8 月都稳定在 ~17.5% 的月度 PR 量级 —— **摩擦不是历史遗留,是当前速率**。

### 3.1 复测(2026-08-17,6-B 第三域七刀后)

七刀按**摩擦归因**(不是"当时最大的文件")依次拆分,每刀让一个热点跌破 700 并退出基线:

| 刀 | 文件 | NCLOC | 复测后严口径 |
|---|---|---|---|
| — | (起点) | — | **93** |
| 第一刀 | `attendances.service.ts` | 1481 → 619 | 77 |
| 第二刀 | `activity-registrations.service.ts` | 1470 → 374 | 63 |
| 第三刀 | `activities.service.ts` | 1263 → 200 | 52 |
| 第四刀 | `recruitment-applications.service.ts` | 763 → 507 | 42 |
| 第五刀 | `members.service.ts` | 817 → 417 | 36 |
| 第六刀 | `role-bindings.service.ts` | 827 → 574 | 31 |
| 第七刀 | `attachments.service.ts` | 1781 → 387 | **27** |

基线条目 **27 → 22**:六个文件退出(`attachment-storage-orchestrator` 已于 #1049 更早退出),
但同期**新进来一条** —— `attendances/attendance-offline-package.service.ts`(1373,由 #1052 引入)。

⚠️ 这条新入册**正是 report 期的代价的实证**:#1052 合入时闸两条都报了
(`service-size-new-above-threshold` + 基线文件 `attendance-punch-command` +210),
退出码 1,被 `|| true` 吞掉。同一天里 6-B 七刀从这些文件砍掉约 5300 NCLOC,
而单个业务 PR 净加回约 1580 —— **闸不接执法位时,拆分速度与增长速度是两条独立的曲线**。

⚠️ **归因先于体量**:前八刀(attachments 存储层)把当时全仓最大的文件从 2472 降到 677,
而摩擦 **92 → 93 纹丝未动** —— 因为那个文件在历史上几乎没被增长过。
换成按「参与被挡次数」归因后,七刀把 93 压到 27。**降的必须是最挡路的,不是最大的。**

⚠️ 本节数字**依赖基线已重算**:文件跌破 700 但基线仍记旧值时,它仍被当作基线成员参与统计。
七刀期间基线一直未重算,故中途各刀的"预计值"是贪心预测;上表是逐刀实测。

**热点文件**(被增长次数,宽口径):
`activity-registrations.service.ts` 33 · `attendances.service.ts` 28 ·
`recruitment-applications.service.ts` 26 · `activities.service.ts` 25 ·
`members.service.ts` 20 · `recruitment-promotion.service.ts` 19 ·
`certificates.service.ts` 16 · `attachments.service.ts` 16。

**按 goal 自己定的判据**(<10 个 PR ⇒ 可较快转闸;>30 ⇒ 必须先做 6-B 拆分):
92(严)与 161(宽)**都远超 30** ⇒ **必须先做 6-B 拆分才谈转 blocking**。
换阈值不改变结论;修正度量口径同样不改变结论(106 → 92,仍是判据线的 3 倍)。

> **2026-08-17 更新**:6-B 第三域七刀后严口径降至 **27**(见 §3.1),已低于判据线 30。
> 本段保留立闸当时的判断作历史 —— 它当时是对的,且正是它把 6-B 拆分列为转闸前置。

## 4. 转 blocking 的 Exit Criteria

沿 EC-COMMON(v4 §7)相关条。**未逐条打勾前不得转闸**;转闸动作 = 删掉 `ci.yml` 里
`pnpm harness:servicesize || true` 的那个 `|| true`,一行。

| # | 条件 | 现状 |
|---|---|---|
| EC-1 | 历史 baseline 已冻结并**接入 ratchet-registry、base-trusted 裁决** | ✅ **已达成(2026-08-17,PR#1054 + #1056)** —— 裁判加 `kind` 两态与 `judgeNumericMonotonicity`,尺寸基线以 `numeric-monotonic` 登记入册。§5 记录的三条结构原因均已解除,该节保留作历史。 |
| EC-2 | 扫描器覆盖范围与已知缺口成文 | ✅ 本文 §1;已知缺口:发现面按**文件名后缀**认定,叫别的名字的大文件(如 `*.util.ts`)不计入 |
| EC-3 | blocking 版已 typed-AST 化(正则版仅限 report) | ✅ 度量走 TS parser,非正则、非裸 scanner(§8) |
| EC-4 | 绕过样例在 selftest 全绿(阳性对照) | ✅ **29 条**(§8 新增 7 条口径对照);5 组变异对拍红集互不重叠(见 §6) |
| EC-6 | report 期误报逐条处理完毕,残余误报率维护者书面接受 | ⏳ 需 report 期真实流量 |
| EC-7 | CI 检查连续稳定(≥10 个 PR 或 ≥2 周无 infra 抖动) | ⏳ 需 report 期观察 |
| EC-9 | 回滚路径成文且为一行开关 | ✅ 加回 `\|\| true` |
| EC-10 | 错误信息达到 §10 AI 反馈五要素 | ✅ 输出含「当前值 vs 基线值 vs 增量 + 所属域 + 下一步命令」 |
| **专属** | **6-B 拆分已把摩擦压到可接受区间**(重跑本文 §3 复测) | ✅ **已达成(2026-08-17)** —— 严口径 **93 → 27**,判据线 30。逐刀实测见 §3.1。 |

EC-5(`$queryRaw` 通道)、EC-8(Journey + zero-new-red)不适用:本规则不涉数据访问、不涉业务行为。

## 5. 为什么此刻**没有**接进 `harness/ratchet-registry.json`

goal 的 D5 要求登记入册。实测**登记不进去**,且硬试会出事 —— 三条结构原因(2026-08-15 实测):

1. 注册表的 `rule` 字段必须是**真实 ESLint 规则名**:`eslint.harness.mjs` 末尾按注册表遍历,
   为基线里**每个文件**生成 `rules: { [rule]: ['error', { exempt }] }`。
   「文件多大」没有对应的 ESLint 规则;随便指一条现有 `srvf/` 规则,
   副作用是**真的把这 31 个源文件从那条规则里豁免掉**。
2. `entries[].symbol` 必须匹配 `BASELINE_SYMBOL_SHAPES` 三种形状之一
   (`类名.字段名` / `类名.方法名.参数名` / `YYYY-MM-DD`)。文件路径一种都不匹配 ⇒
   `parseRatchetBaseline` **加载期直接抛**,`pnpm lint` 本身起不来。
3. 修 ①② 必须改 `eslint.harness.mjs` 与 `.github/workflows/redzone-trusted-judge.mjs`
   两个红区执法文件,而它们正是本刀禁区(「Phase 0-5 的任何执法实现」)。

另:裁判侧 `judgeBaselineMonotonicity` 只比 `(file, symbol)` 集合、**不认数值** ——
数值若编进 `symbol`,合法的「变小」也会造出新 key 而硬失败,**语义正好反了**。
正确形状是**身份=文件、数值=属性**(本基线即如此),与终审【九】同向。

⇒ 结论:`ratchet-registry.json` 的 `_comment` 自称「全仓所有单调基线的唯一登记处」是**过度承诺**,
它实际只装得下 ESLint 规则型基线。**让它容纳非 ESLint 型棘轮(加 `kind` 判别的两态)
是转 blocking 的前置工作**,已列为 EC-1。维护者 2026-08-15 拍板:本刀不登记,写明原因。

## 6. 判据可信度证据(变异对拍)

5 组变异,每组的红集**互不重叠**(证明每条断言绑的是自己那个条件,不是一块笼统的绿):

| 变异 | 红条数 | 该变异**独有**的红 |
|---|---|---|
| 度量退回物理行(注释不剥离) | 3 | 纯注释膨胀不改变度量值 · 整行注释不计入 |
| 阈值语义 `>=` 退回 `>` | 1 | 基线外新文件达到阈值即报 |
| 发现面缩回只认 `.service.ts` | 3 | orchestrator/handlers 计入 · 落盘 inputDigest 一致 |
| 棘轮方向:持平也算增长 | 2 | 基线文件持平不报 |
| CI 偷偷删 `\|\| true` | 1 | CI 此刻是 report 模式 |

## 7. 本次未做(明确不在本刀内)

- **6-B 按触碰拆分**:随业务触碰渐进进行,按 D-7 六类(QueryService / Presenter / Policy /
  StateMachine / AuditRecorder / Calculator)拆。**另议,未立项。**
- **转 blocking**:§4 的 EC 未逐条达成,尤其 EC-1(注册表)与摩擦线。本刀恒 report。
- **注册表扩成两态**:需改两个红区执法文件,超出本刀写集与禁区。
- **非 service 类大文件**:`biz-code.constant.ts`(净 2718)、`local-activity-frontend-fixture.ts`
  (净 2192)、`recruitment.dto.ts`(净 1103)等不在发现面内 —— 它们不适用 D-7 拆法,
  且尺寸对 AI 理解面的影响与 service 不同类。**未纳入,未立项。**

## 8. 度量缺陷与修复(2026-08-15)

立闸后由 6-B 归因诊断([`SERVICE_SIZE_GROWTH_ATTRIBUTION.md`](SERVICE_SIZE_GROWTH_ATTRIBUTION.md) §7)
发现:**度量函数把注释算成了代码**。本节记录取证与处置。

### 8.1 现象与根因

`measureNcloc()` 原用裸 `ts.createScanner` + `scan()` 循环剥注释。scanner 是**有状态**的,
若干 token 必须由调用方按上下文主动重扫,原实现从不重扫,于是遇 `` `…${…}` `` 即**脱锁**:

`TemplateHead` 之后停在 `${`,本应在配对的 `}` 处调 `reScanTemplateToken()` 续出
`TemplateMiddle`/`TemplateTail`;不调 ⇒ 那个 `}` 被当成普通 `CloseBraceToken`,
**收尾反引号于是开启了一个新的模板串**,把其后正文(含整行 `//` 注释)一路吞成字符串内容。

最小复现(`` const a = `${1}`; `` + 两行 `//` 注释 + 一行代码):修复前 **4**,正确 **2**。

### 8.2 影响面(实测)

| 项 | 读数 |
|---|---|
| 发现面文件总数 | 150 |
| 读数被抬高的文件 | **71 = 47.3%** |
| 原 31 个基线文件合计虚高 | **2503 行 = 6.9%** |
| **修正后跌破阈值 700 的基线文件** | **5 个**(见 §2) |
| 现口径未入基线、修正后 ≥700 的文件 | **0 个** ⇒ 缺陷是**单向虚高**,不会漏收 |

**对既有结论的影响**:严口径摩擦 106 → 92,**仍是判据线 30 的 3 倍**,
§3/§4 的判断与「必须先做 6-B」不变;变的只是基线的**成员集合**(31 → 26)。
6-B 归因诊断的可搬/不可搬占比与本缺陷**正交**(已用修正口径重跑复核,热点域读数逐位一致)。

### 8.3 为什么 22 条对照一条都没抓到

尺寸段原有 22 条对照里**没有一条喂过模板串** —— 「纯注释膨胀」「字符串里的 `//`」
都不触发重扫,于是缺陷在结构上**不可能被现有对照看见**。
这是「加守护前先问『缺口长什么样』」的又一个实例:守护存在 ≠ 守护覆盖。

### 8.4 修复与新增对照

改用 **parser**:取真实 token(叶子节点)的字符区间,注释按定义落在区间外。
这不是补一个 `reScanTemplateToken()` 调用,而是**把整个「重扫脱锁」缺陷类一次关掉**
(模板串 / 正则 `reScanSlashToken` / `>>` `reScanGreaterToken` / JSX;本仓无 `.tsx`,末项不适用)——
补调用需要自己维护花括号深度栈处理嵌套模板,那正是产生本缺陷的同一类手写状态机。

⚠️ **修复过程中当场引入并抓到一个同类缺陷**:`setParentNodes: true` 之下 `getChildren()`
会把 `/** … */` 作为 **JSDoc 节点**挂在声明下(普通 `/* */` 与 `//` 是 trivia,不在任何 token 区间内),
不显式跳过就会**又一次把注释算成代码**;本仓 JSDoc 密度极高,影响比原缺陷更大
(基线因此再从 27 收到 26,原 31 个基线文件的虚高从 1746 行修正为 2503 行)。
它是被「`ts.createScanner` 应只出现在散文里」的结构自检抓到的 —— **剥注释后再判执行位**,
而不是靠读代码相信。

selftest 尺寸段由 22 条增至 **29 条**,新增 7 条:

| 新增对照 | 守什么 |
|---|---|
| 带替换模板串之后的整行注释仍不计入 | **本缺陷本体** |
| 嵌套模板串之后的整行注释仍不计入 | 前向回归护栏 |
| 多行模板串内的 `//` 是内容,不得剥离 | **反向** —— 防「把模板串整段当注释剥掉」也能让上两条变绿 |
| 正则字面量里的 `/*` 不是注释起点 | 同类(`reScanSlashToken`)前向护栏 |
| 单行 / 多行 JSDoc 不计入(2 条) | §8.4 的 JSDoc 缺陷 |
| JSDoc 内的 `${}` 与 `//` 不影响其后代码计数 | JSDoc 与模板串缺陷的交叉 |

**变异对拍**(红分布本身是判据,不假装安全):把实现退回裸 scanner,红集**恰 1 条** ——
「带替换模板串之后的整行注释仍不计入」。其余 6 条在该变异下**不红**:实测裸 scanner 对
嵌套模板串 / 多行模板串 / 正则 `/*` 恰好给出正确读数,它们是**前向回归护栏而非缺陷复现**,
本文如实标注,不把 7 条都说成「各抓到一个缺陷」。

### 8.5 口径版本

`SERVICE_SIZE_GENERATOR_VERSION` 1 → **2**。实现换代必须 bump ——
`inputDigest` 摄入该值,不 bump 则用旧口径算出的基线会被当成「口径一致」放行。
selftest 的「落盘 inputDigest 与当前口径一致」这条在重算前**确实转红**,重算后回绿:
这正是该断言存在的理由(它是本次唯一一条自动发现「基线该重算了」的判据)。
