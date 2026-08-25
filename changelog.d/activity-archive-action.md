### 活动归档动作 —— 同一个标记、两套开工条件、可撤销且留痕(AC-004 结案;AC-064 / ADV-022 收窄)

维护者 2026-08-25 三问拍板:①「草稿归档」与「结算完归档」是**同一个标记、两套开工条件**;
②归档后列表**默认不显示**,可勾「显示已归档」看到;③**能取消归档,但要留痕**(谁归的、谁撤的、什么时候)。
合同落点 §6.6 + 验收 AC-004 / AC-064 / ADV-022。

#### 数据模型(D 档;expand-only,十列全部可空)

`Activity` 加 `archivedAt` / `archivedByUserId` / `archivedFromStatusCode` / `archiveReasonCode` /
`archiveOperationKey`(单列 unique)/ `archiveRequestHash` + 对称的 `unarchived*` 四列,
migration `20260825140000_activity_archive_action`。零 default、零回填、零 DROP、零 RENAME、
零既有行重解释 —— 存量活动十列一律 NULL,读作「从未归档过」。
两条 FK(`archivedByUserId` / `unarchivedByUserId` → `User`,`onDelete: Restrict`)与既有
canceller / terminatedBy 逐字同形。**生产未 deploy。**

⭐ **「同一个标记」= `statusCode` 闭集第 6 值 `archived`,不是第二个布尔位。**
理由不是省列:全仓活动读面里有 **6 处硬写 `statusCode: 'published'`**(App 活动广场 / available /
dashboard 两处计数 / 活动开始前提醒 / 报名对账入队),它们靠**状态值**天然把已归档挡在外面;
换成正交布尔位,这 6 处每一处都要记得再加 `archivedAt IS NULL`,漏一处就是「归档了还在列表里」。
执行位放在值域上,比放在「每个调用点都要记得加过滤」上硬。

⚠️ **归档不改任何结算语义**:关账的「已结束 / 已终止」判据是
`terminatedAt !== null || now > endAt`(`activity-closure.service.ts` `evaluateChecks` ①),
一个字都不读 `statusCode`。⇒ `completed → archived` 不会让已关账活动在关账链里变形。

#### 两套开工条件:各自可判 + **结构性**互不越界

新 `ActivityArchivePolicy`(纯决策,不查库不抛异常,`now` 由调用方从**同事务** `now()` 传入):

| 归档谁 | 条件 | 不满足时的具名码 |
|---|---|---|
| 草稿 | `now - updatedAt ≥ 30 天` | `20155 ACTIVITY_ARCHIVE_DRAFT_NOT_STALE` |
| 办完的活动 | 存在生效 closure | `20156 ACTIVITY_ARCHIVE_NOT_CLOSED` |
| 同上 | 且 `now ≥ closedAt + archiveWaitingDays` | `20157 ACTIVITY_ARCHIVE_WAITING_PERIOD_NOT_ELAPSED` |

🔴 **三条各给一个具名码,不合并成一个「不满足归档条件」** —— 运营最常问的恰恰是这三个不同问题:
草稿还太新 / 账还没关 / 关了但还在等待期。前两个要去做事,第三个只能等。

🔴 **两套条件不可能互相越界,是结构性的不是靠测试兜的**:走哪条路只由 `statusCode` 决定,
且草稿分支**一个字都不读** `activeClosure`、结算分支**一个字都不读** `updatedAt`。
判据因此给得出两条交叉反向:已办完 + 陈旧 400 天 + 无 closure ⇒ 拒 20156;
草稿 + 有 closure + 等待期早过 ⇒ 拒 20155。

⚠️ **草稿阈值 30 天是提议值,待维护者裁定** —— 合同 §6.6 只写「长期无人处理」,**没给数**。
依据三条:①7 天(= 现成的 `archiveWaitingDays` 默认值)会把正常在筹备中、两周没动的草稿
判成「无人处理」,是可证伪的误报;②30 天是仓内已有量级(评价自最新关账开放 30 天),不新造数量级;
③归档可撤销 ⇒ 阈值取偏的代价可逆。**刻意不落成 DB 列**:合同没定义、维护者没拍板,落列就是「先占位以后再用」。

#### 状态机与端点

`ACTIVITY_STATE_ACTIONS` 6 → 8(`archive` / `unarchive`);`archived` 的入边四条
(draft / published / completed / terminated),出边由 `archivedFromStatusCode` 决定 ——
**拿不到就拒,不猜一个常量回退**(猜错就是静默改写活动状态)。`cancelled` **刻意不可归档**:
维护者只拍了两套条件,取消掉的活动两套都不属于。`archived` 上 update / publish / cancel /
terminate / complete 全拒 —— 要改先撤销归档。

新增 2 个端点(路由足迹 552 → 554):
`POST /api/app/v1/my/managed-activities/{activityId}/archive` 与 `…/unarchive`,
判权与 cancel / terminate 逐字同形(responsibility scope + `activity-responsibility.override.record`)
—— **零新增权限码,`prisma/seed.ts` 一个字未动**。锁序、幂等重放、`claimAtStatus` 条件锁
全部照抄 `activity-lifecycle.service.ts` 的 cancel / terminate 骨架。

#### 留痕成对

**撤销归档时刻意不清空归档三件事实**(`archivedAt` / `archivedByUserId` / `archiveReasonCode`),
只追加 `unarchivedAt` / `unarchivedByUserId`。⇒ 「这个活动被归档过又撤销过」=
两侧时刻同时非 NULL,**一条 `where` 就查得出来**。当前是否处于归档态由 `statusCode` 单独承载,
不靠「`archivedAt` 有没有被抹掉」去推 —— 抹掉它就等于把留痕删了。

#### 「按状态筛活动」的连坐面:16 个读面逐个数过,3 个要改

全仓 `Activity` 的 `findMany` / `count` 共 **16 个逻辑查询**。逐个分类:

- **会漏出、已改(3)**:管理端 `GET /admin/v1/activities`、`GET /admin/v1/activities/options`、
  App 负责人工作台 `GET /app/v1/my/managed-activities` —— 三者此前在「不传 statusCode」时不加任何状态过滤。
  三处统一加**默认排除 archived** + `includeArchived` 开关(只在未传 `statusCode` 时生效;
  显式 `statusCode=archived` 是「只看已归档」的独立视图,不需要再勾一次)。
- **结构性安全(6)**:App 活动广场 / available / dashboard 两处计数 / 活动开始前提醒 / 报名对账入队 ——
  全部硬写 `statusCode: 'published'`,新状态值天然不匹配。
- **刻意不改(7)**:按 id 反查派生字段的三处 join(我的报名 / 我的考勤 / 我报名的活动第二段)、
  标签解析、能力位计数、**退队影响面**(它必须看得见已归档活动,漏掉是安全倒退)、
  参与概览统计(改它 = 动统计口径,不在本刀范围)。

`ActivityClosurePolicy` 补 `archived` 分支,且**排在考勤分支之前** —— 否则已归档、
未声明考勤完成的活动会掉进兜底格,被显示成「等待考勤声明 / 等待活动完结」,归档后还催人干活。

#### 🔴 e2e 首跑推翻了一条自己的前提:**撤销归档会重置「无人处理」时钟**

首跑 14/15,唯一失败的那条**独立失败**(不是五条齐卡在同一前置 ⇒ 排除夹具嫌疑),
取证结论是**用例的前提错了、实现是对的**:

`Activity.updatedAt` 是 Prisma `@updatedAt` ⇒ **归档与撤销归档这两个动作自己也会推它**
(它们都走 `activity.update`)。所以一份被归档过又撤销的草稿,**当场就不再"陈旧"**,
立刻再归档会被 `20155` 拒,要重新放满 30 天。

**这是对的语义,不是缺陷**:撤销归档本来就是一次真实的人为处理(有人把草稿从抽屉里拿了回来),
时钟理应在那一刻重置 —— 否则「长期无人处理」会退化成一次性条件:归过一次以后,
任何时候都能随手再归一次。⚠️ 运营上的意思是:**归错了撤回来的草稿,一个月内归不了第二次。**

订正方向是**加强不是放宽**:该用例现在同时钉「重置」与「重新陈旧后仍可再归」两侧,
断言数 4 → 7;语义写进 `activity-archive-policy.ts` 头注。
⚠️ 夹具改 `updatedAt` 必须走 `$executeRaw` —— `update` 路径上 `@updatedAt` 由 Prisma 接管,
显式传值会被覆盖成 now,夹具会**静默失效**(测试照绿,但测的不是你以为的那件事)。
订正后 **15/15 绿(8.2s)**。

#### AC-004 结案(todo 17 → 16);AC-064 / ADV-022 收窄不结案

AC-004 四格逐条对上:工作台 `staleDraft` 提示(与归档闸**共用同一个 `isStaleDraft`** ——
两处各写一遍必漂移成「亮着可归档、点下去被拒」)/ 人工归档端点 / 归档只改状态零删除 / 零新增 cron。

🔴 **AC-064 / ADV-022 刻意不结案**:前者只剩「关账满等待期**可以归档**」这一半没有 HTTP 证据
(要一条真 `ActivitySettlementClosureRevision`,该表三条必填外键 ⇒ 应在
`activity-settlement-closure.e2e-spec.ts` 里接续链,不在归档 spec 里复制第二份关账夹具);
后者只剩两条**真并发**用例(能力已具备 —— 归档取的是与关账 / 终审 / 更正同一把 Activity 行锁)。
两条的卡点说明已就地收窄,不拿「动作做出来了」冒充「那一格证到了」。

#### ⭐ 变异对拍读数(纯函数 / 纯 mock 判据,本机跑,不连库)

基线:M1–M8 量于「归档五 spec 共 **138 通过 / 0 失败**」那一刻;M9 量于补上工作台提示后的
**153 通过 / 0 失败**(两次基线的差 = `staleDraft` 那批新用例,与 M1–M8 的红集不相交)。
每次变异后**逐条还原**并复绿,`git status --porcelain` 零残留。

| 变异 | 打掉什么 | 红集 | 是否只落在对应维 |
|---|---|---|---|
| M1 | 草稿陈旧度判断 | **4** | ✅ 草稿维 3 条 + 交叉反向「结算条件撬草稿」1 条 |
| M2 | 等待期判断 | **2** | ✅ 全在等待期维(含差 1ms 边界) |
| M3 | 「未关账」判断 | **4** | ✅ 未关账维 2 条 + 两条交叉反向 |
| M4 | App 工作台列表排除已归档 | **2** | ✅ findMany 与 count 各一条 |
| M5 | 管理端 list / options 排除已归档 | **2** | ✅ list 一条 + options 一条 |
| M6 | 撤销归档时清空归档留痕 | **5** | ✅ 四列各一条 + 「归过又撤过可查」一条 |
| M7 | unarchive 复原目标用常量兜底 | **3** | ✅ 状态机 2 条 + service 1 条 |
| M8 | `archived` 上放行 update | **1** | ✅ 终止编辑维 |
| M9 | 工作台 `staleDraft` 恒 false | **1** | ✅ 提示维 |

九次变异红集**两两不相交**。
🔴 判据形状上做了两件事保证它不恒真:①**每一维各自成一个 `it`**(jest 首个失败即停,
七八格塞一个 `it` 会让后面的反向断言一条都跑不到,而基线全绿时完全看不出来);
②列表类判据断言的是**交给 Prisma 的 `where`**、写路径类断言的是**交给 Prisma 的 `data`**,
不是返回值 —— 恒定返回固定行的 mock 会把「查询被收窄」「留痕被抹」整类变异藏住。

#### 🔴 契约破坏申报(R11):`closure.status` 响应枚举加值 `archived`

`AppManagedActivityClosureDto.status` 从 9 值扩到 10 值(新值**追加在末尾**,既有 9 值顺序一格未动)。
`docs/handoff/openapi.json` 的 base↔head 语义比对判为 **B6 / response-enum-value-added**:
老客户端若对该字段写了穷尽 `switch`,会撞到一个它没有分支的值。**7 个 operation 都返回这个字段**,故**逐条**申报。

⚠️ **这一格没有兼容写法可选**:归档态必须能被工作台表达。不加这个枚举值,已归档活动会掉进
`ActivityClosurePolicy` 的兜底分支、被显示成「等待活动完结」—— 归档完还催人干活,比枚举加值坏得多。
⇒ 属「确需破坏」,不是「没想到可以 additive」。

⭐ **同一把闸对本刀另外三处判的是 additive 并放行**(`includeArchived` 可选 query ×3 面、
`staleDraft` 新增响应字段、两个新端点)—— 说明这 7 条阻断**不是误报泛滥**,
而是精确命中「响应枚举加值」这一种,分类是细的。

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities
reason: 建单返回体带 closure 投影。归档态必须能在工作台表达;不加该枚举值,已归档活动会掉进 ActivityClosurePolicy 兜底分支被显示成「等待活动完结」。该字段是单值状态投影,无法用「新增可选字段」改写成 additive。
impact: 事实读数 —— 前端 srvf-admin-web 尚未上线,当前**无任何线上客户端**消费本端点,实际影响面为 0。这不是免申报的理由,是本行要记录的事实。潜在影响面 = 将来对 closure.status 写穷尽 switch 且无 default 的调用方;新值仅在活动真的被归档后才可能出现,存量活动一律取不到。
migration: 调用方给 closure.status 补 archived 分支(渲染为「已归档」,无下一步动作),或补 default 兜底。新值恒追加在枚举末尾,按下标读的实现不受影响。
rollback: 真回滚 = revert 本 PR(代码 + migration 一并回退);不设 feature gate —— 端点在而枚举不在会造出「归档完还催人干活」的更坏状态。⚠️ 存量数据读数:本 migration **生产从未 deploy**(prisma/CLAUDE.md 逐字记「生产未 deploy」),故生产库里 statusCode='archived' 的行数**恒为 0**,revert 不产生孤儿状态;测试库由 resetDb + migrate deploy 每次重建,revert 后重跑即回到 9 值闭集。⚠️ 若将来已 deploy 再 revert,DROP 那十列之前必须先跑一条回填(按 archivedFromStatusCode 把 archived 行复原到原状态)—— 那一步是**不可逆数据变更,须维护者单独拍板**,不在本申报的自动射程内。
-->

<!-- contract-breaking
operation: PUT /api/app/v1/my/managed-activities/{activityId}/cover
reason: 换封面成功后回吐活动详情(含 closure 投影),因此连坐同一处枚举加值。本端点自身语义未变。
impact: 事实读数 —— 前端未上线,无任何线上客户端,实际影响面为 0。潜在影响 = 换完封面后据 closure.status 刷新状态条、且写了穷尽 switch 的调用方。
migration: 同族处置 —— 补 archived 分支或 default 兜底;枚举新值在末尾,不影响按下标读的实现。
rollback: revert 本 PR。存量数据读数:生产未 deploy ⇒ archived 行恒为 0,无需回填;已 deploy 后再 revert 须先按 archivedFromStatusCode 回填再 DROP 列,那步须维护者单独拍板。
-->

<!-- contract-breaking
operation: PUT /api/app/v1/my/managed-activities/{activityId}/gallery
reason: 换图集成功后回吐活动详情(含 closure 投影),因此连坐同一处枚举加值。本端点自身语义未变。
impact: 事实读数 —— 前端未上线,无任何线上客户端,实际影响面为 0。潜在影响 = 换完图集后据 closure.status 刷新状态条、且写了穷尽 switch 的调用方。
migration: 同族处置 —— 补 archived 分支或 default 兜底;枚举新值在末尾,不影响按下标读的实现。
rollback: revert 本 PR。存量数据读数:生产未 deploy ⇒ archived 行恒为 0,无需回填;已 deploy 后再 revert 须先按 archivedFromStatusCode 回填再 DROP 列,那步须维护者单独拍板。
-->

<!-- contract-breaking
operation: GET /api/app/v1/my/managed-activities/{activityId}
reason: 活动详情是 closure.status 的**主读面** —— 归档态必须在这里能被表达,否则负责人打开一个已归档活动会看到「等待活动完结」。这是本次枚举加值的直接目的地,不是连坐。
impact: 事实读数 —— 前端未上线,无任何线上客户端,实际影响面为 0。潜在影响面里这条最大:详情页状态条最可能写成穷尽 switch。
migration: 调用方给 closure.status 补 archived 分支(渲染「已归档」+ 提供「撤销归档」入口),或补 default 兜底。
rollback: revert 本 PR。存量数据读数:生产未 deploy ⇒ archived 行恒为 0,无需回填;已 deploy 后再 revert 须先按 archivedFromStatusCode 回填再 DROP 列,那步须维护者单独拍板。
-->

<!-- contract-breaking
operation: PATCH /api/app/v1/my/managed-activities/{activityId}
reason: 改单成功后回吐活动详情(含 closure 投影),因此连坐同一处枚举加值。⚠️ 本端点另有一条相关行为变更:archived 态下改单会被 20030 拒(要改先撤销归档)—— 那是新状态值带来的,不是本枚举项。
impact: 事实读数 —— 前端未上线,无任何线上客户端,实际影响面为 0。潜在影响 = 改完单据 closure.status 刷新状态条、且写了穷尽 switch 的调用方。
migration: 同族处置 —— 补 archived 分支或 default 兜底;另建议把「activity 处于 archived 时禁用编辑入口」一并接上,避免用户提交后才吃 20030。
rollback: revert 本 PR。存量数据读数:生产未 deploy ⇒ archived 行恒为 0,无需回填;已 deploy 后再 revert 须先按 archivedFromStatusCode 回填再 DROP 列,那步须维护者单独拍板。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/direct-publish
reason: 直接发布返回体带 closure 投影,因此连坐同一处枚举加值。本端点自身语义未变(它本就只能从 draft 出发,archived 会被状态机拒)。
impact: 事实读数 —— 前端未上线,无任何线上客户端,实际影响面为 0。潜在影响 = 发布后据 closure.status 跳转/刷新、且写了穷尽 switch 的调用方。
migration: 同族处置 —— 补 archived 分支或 default 兜底;枚举新值在末尾,不影响按下标读的实现。
rollback: revert 本 PR。存量数据读数:生产未 deploy ⇒ archived 行恒为 0,无需回填;已 deploy 后再 revert 须先按 archivedFromStatusCode 回填再 DROP 列,那步须维护者单独拍板。
-->

<!-- contract-breaking
operation: POST /api/app/v1/my/managed-activities/{activityId}/declare-attendance-complete
reason: 声明考勤完成后回吐活动详情(含 closure 投影),因此连坐同一处枚举加值。⚠️ 本端点与归档语义相邻:归档态在 ActivityClosurePolicy 里被**排在考勤分支之前**返回,正是为了不让已归档活动继续催考勤声明。
impact: 事实读数 —— 前端未上线,无任何线上客户端,实际影响面为 0。潜在影响 = 声明后据 closure.status 决定下一步待办、且写了穷尽 switch 的调用方。
migration: 同族处置 —— 补 archived 分支或 default 兜底(archived 的 nextAction 恒为 null,前端应据此隐藏待办)。
rollback: revert 本 PR。存量数据读数:生产未 deploy ⇒ archived 行恒为 0,无需回填;已 deploy 后再 revert 须先按 archivedFromStatusCode 回填再 DROP 列,那步须维护者单独拍板。
-->
