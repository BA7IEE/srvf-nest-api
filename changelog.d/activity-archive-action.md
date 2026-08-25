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

#### AC-004 结案(todo 17 → 16);AC-064 / ADV-022 收窄不结案

AC-004 四格逐条对上:工作台 `staleDraft` 提示(与归档闸**共用同一个 `isStaleDraft`** ——
两处各写一遍必漂移成「亮着可归档、点下去被拒」)/ 人工归档端点 / 归档只改状态零删除 / 零新增 cron。

🔴 **AC-064 / ADV-022 刻意不结案**:前者只剩「关账满等待期**可以归档**」这一半没有 HTTP 证据
(要一条真 `ActivitySettlementClosureRevision`,该表三条必填外键 ⇒ 应在
`activity-settlement-closure.e2e-spec.ts` 里接续链,不在归档 spec 里复制第二份关账夹具);
后者只剩两条**真并发**用例(能力已具备 —— 归档取的是与关账 / 终审 / 更正同一把 Activity 行锁)。
两条的卡点说明已就地收窄,不拿「动作做出来了」冒充「那一格证到了」。

#### ⭐ 变异对拍读数(纯 AST / 纯函数判据,本机跑;基线 153 通过 / 0 失败)

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

九次变异红集**两两不相交**,每次还原后复绿。
🔴 判据形状上做了两件事保证它不恒真:①**每一维各自成一个 `it`**(jest 首个失败即停,
七八格塞一个 `it` 会让后面的反向断言一条都跑不到,而基线全绿时完全看不出来);
②列表类判据断言的是**交给 Prisma 的 `where`**、写路径类断言的是**交给 Prisma 的 `data`**,
不是返回值 —— 恒定返回固定行的 mock 会把「查询被收窄」「留痕被抹」整类变异藏住。
