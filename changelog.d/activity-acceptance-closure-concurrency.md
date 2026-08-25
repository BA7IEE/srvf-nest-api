### 活动 v1.1 验收编号「只清缺测试那批」—— **写成 1 条 / 补测 1 条不结案 / 退回 2 条**(todo 19 → 18,9a 仍红且是预期)

接 `#1182` 的分拣结论,把「功能已在、只缺测试」那一类的 4 条候选**逐条动手实测**
(不是读卡点文本推断)。`cutover:check` 9a 从 `84 通 / 19 待 / 0 败 / 103 总`
变成 `85 通 / 18 待 / 0 败 / 103 总`。

⚠️ **9a 仍红,这是预期的**:只要还有一条 `it.todo` 就红。**没有为了让它变绿硬写任何一条。**
本刀 `src/` 业务代码零改动 —— 只写测试。

#### 写成 1 条:AC-063「关账与最后一次终审、最后一个更正并发时按活动锁串行,不漏检查、不重复关闭」

新增 `test/e2e/activity-settlement-closure-concurrency.e2e-spec.ts`(与既有
`activity-settlement-review-concurrency` 同形):两套 Nest / 两套 Prisma pool,
让赢家事务停在最后一步(spy 审计记录器)攥住 Activity 行锁,再用 `pg_stat_activity`
的 `wait_event_type='Lock'` **正面数出**关账确实在排队。合同这句拆四格,逐格给判据:

| 合同里的哪一句 | 用例 | 正 / 反 / 边界 |
|---|---|---|
| 「关账 × 最后一个更正 按活动锁串行」+「不漏检查」 | 更正 `commit` 在关账等锁期间落地 | ⭐**判决翻转**:关账发起那一刻,入口世界同时有 `closure_already_active`(rev 1 仍 active)与 `pending_work_exists`(更正仍 `applying`)两类缺口 ⇒ **锁前判必然 blocked**;实际返回 `closed` / revision 2 ⇒ 只可能是锁后复判。把 `evaluateChecks` 挪到取锁之前,这条当场红 |
| 「不重复关闭」 | 两条关账真并发(不同 key) | 恰 1 成功;败者缺口清单**恰等于** `['closure_already_active']`(混进 settlement / ledger 噪声即说明读的不是赢家提交后的状态);库里恰 1 张 active |
| 「关账 × 最后一次终审 按活动锁串行」 | 终审 `commit` 在关账等锁期间落地 | (a) 锁等待者读数;(b) 缺口**只差**结算未生效那一类,其余六类**逐条断言不在里面**(反面样本在被测那一维上单独不同);(c) 零部分写入(closure 零行 + `Activity.currentClosureRevision` 仍 null);(d) 同一夹具把账走完 ⇒ 关账**成功**的正对照,证明 (b) 不是恒红 |

⭐ **顺带推翻 `#1182` 那条退回理由**:原文说「要**合并两套夹具体系**才写得出关账 × 终审」——
实测只需在**同一个**夹具构造器上加一个 `stage` 参数(`submitted` / `posted` / `closed`),
三站共用一条链;既有关账 spec **一个字未动**。
原卡点里「先给 `activity-settlement-closure.e2e-spec.ts` 加第二实例」同样已过期
(更正 spec 在 ADV-011 那一刀已把双实例手法立住)。

#### ⭐ 变异对拍读数(本机连库实测,回答 `#1182` 留下的问号)

`#1182` 实测过「这类竞态用例的独占红集往往为空」⇒ 本条立项时就带着「会不会是假闸」的问号。
变异 = 「八类检查在取锁**之后**重跑」的等价否定:把 `pendingWork.pendingCorrection` 与
`closure.activeClosure` 两类决定性计数换成**取锁之前**的快照(**锁照取** ⇒ 屏障读数不变,
单独隔离「锁后复判」这一维)。

| 用例 | 变异后 |
|---|---|
| 两套 pool 前提 | 绿(与被测维无关) |
| 关账 × 更正 锁后复判 | 🔴 **红** —— 关账被挡,缺口**恰是**预测的两条:`pending_work_exists`(`pendingCorrection: 1`)+ `closure_already_active`(`activeClosure: 1`) |
| 两条关账真并发 | 🔴 **红** —— 败者不再是 `blocked`(两条都过了第 ⑧ 类,撞 DB partial unique 抛异常)|
| 关账 × 终审 | 绿(该维度锁前锁后读数相同,与下面的诚实标注一致)|

⇒ 红集**精确**(2/4),不是"一改就全红";更正那条的红**落在判决翻转那一行**而不是屏障上,
说明判别力真的来自「锁后复判」。还原后 4/4 复绿,`git status --porcelain` 零残留。

🔴 **诚实标注(别把这条读强)**:「不漏检查」在**更正**那一格是判决翻转,
在**终审**那一格做不成 —— `AttendanceSettlementRun.statusCode` 是单值状态机,
「终审可受理」(`pending_final_review`)与「关账可放行」(`posted`/`closed`)**互斥**,
终审在飞时关账在任一交错顺序下都必然 blocked。这条结构性限制写进了 spec 文件头与去向表注释。

#### 补测 1 条但**不结案**:AC-009 的可见性 / 签到规则两格

合同那句列了八格,五格早有真用例,**可见性**与**签到规则**两格此前从没有任何用例把它们发出去过
——「代码会拒」与「证明它拒了」是两件事:谁把 `visibilityCode` 加进
`PUBLISHED_ACTIVITY_DISPLAY_FIELD_SET`,今天全仓一条用例都不会红。
`app-managed-activities.e2e-spec.ts` 新增一条:三个字段(`visibilityCode` /
`defaultLocationRequired` / `defaultCheckInRadiusMeters`)**各自单独**发出去(避免上层边界遮蔽被测维)、
白名单字段混发的边界、`description` 单独发的正对照,每次被拒后**回读库行**证明是拒绝而不是"报了错但已经改了"。
⭐ 首跑当场红了一条,是真读数不是走过场:管理草稿创建路径本就兜底
`visibilityCode ?? 'internal'` / `defaultLocationRequired ?? false`,基线不是"三列全 NULL"。
订正基线的同时把边界那条的混发值从 `'internal'`(= 基线,写进去看不出差别)改成 `'invitation'`,
使三条反向 + 一条边界**每一条发的值都与基线不同**。

⚠️ **AC-009 仍是 todo**:第八格「计分规则」全仓无按活动的写接口,
「无接口算不算满足合同」**须维护者裁定** —— 这一格补测试解决不了。登记表卡点已收窄到这一格。

#### 退回 2 条(两条都是**本来就该看出来的**:卡点文本自己已经写明,只是被前半句「已过期」盖住了)

- **AC-047** —— 合同三个前置里的第一个「**活动未结束**」全链零执行位:
  `settlement-submission-validator.ts` 的拒绝种类闭集恰五条,没有这一条;
  `settlement-submit.service.ts` 与 `evidence-seal.service.ts` 全文零处读 `Activity.endAt`
  (submit 侧 `endAt` 命中全在**场次**上);封场那句 `deadlines.length === 0 ? authoritativeNow`
  就是「零 live 场次时窗口真空成立」的原文。⇒ **功能缺口,补测试关不掉。**
- **AC-010** —— 六格里四格零实现(二维码空桩 / 人员零变更 / 通知不按场次收窄 / 结算人口只有活动级),
  取证落点与 ADV-018 同一组。⇒ **功能缺口。**

#### ADV-018 只取证不修 —— **逐点复核确认属实**

| 合同要求 | 实现 | 落点 |
|---|---|---|
| 只影响该场次的**二维码** | 显式空桩 | `applyQrCredentialsPlaceholder()` 体内是 `void tx; void activityId; return Promise.resolve()` |
| 只影响该场次的**人员** | 零变更 | `applySessions()` 的 `cancelled` 分支只有一句「`deletedAt` 刻意不动」的注释;`activityParticipationIdentity` 在提案应用两个文件里**零次**出现在写路径上 |
| 只影响该场次的**通知** | 按 activityId 广播 | `activity-publish-review.service.ts` 走 `findMany({ where: { activityId, populationIncluded: true } })`;`activity-proposal-applier.ts` 走 `activityRegistration.findMany({ where: { activityId, … } })`,且只在**活动级** startAt/endAt/location 变化时才非空 ⇒ 单场次取消连一条通知都不发 |
| 只影响该场次的**结算人口** | 只 bump 活动级 | `currentPopulationRevision: { increment: 1 }`;全仓无场次级人口版本列 |

⇒ 它是一条**实现缺陷**而不是测试缺口。本刀**不修**(AGENTS §2 授权边界),
结论逐点写进登记表注释,**要单独立项 + 维护者定优先级**。

本机连库读数:`closure-concurrency` 4/4 绿(12s)· `app-managed-activities` 20/20 绿(10s);
两条 pattern 跑前均 `--listTests` 数过,各恰 1 个文件。

零红区(`harness:needs` 实测全部写集免授权)· `src/` 业务代码零改动(变异已还原,`git status --porcelain` 零残留)· 生成物 `CODEMAP.md` 随之刷新。
