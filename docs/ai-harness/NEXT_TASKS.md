# NEXT_TASKS — 后续任务拆解(P0 / P1 / P2)

> **性质**:任务提案清单(2026-06-10 Review 产出)。**每项任务仍须按 [`process.md`](../process.md) 单独立项,AI 不自动启动**(process §7)。状态列可由 AI 在 docs PR 中更新。
> P0 = 不解决阻碍 AI Harness 落地;P1 = 影响长期维护;P2 = 可优化。

<!-- status-legend:begin -->

## 状态字段(机器执法)

**每条 `### Pn-m` 恰有一行状态**,形如 `**状态**:<取值>`,紧跟在标题下方。执法在
[`scripts/check-next-tasks-state.ts`](../../scripts/check-next-tasks-state.ts),挂在 CI 的
`Diff guards` job(**不是** unit 轮 —— 改台账的 PR 大多是 docs-only,那一轮会被短路掉)。
四种情形会红并点名条目:缺行 / 多行 · 取值不在白名单 · 声称已合的 PR 号在 main 上找不到 ·
**写着「待办」却已有交付类 commit 点名它**。

⭐ **读法:状态描述的是「剩余部分」,不是已完成部分。**
代码全交付、只剩维护者跑 runbook ⇒ `⏸ 挂起`;8 个 PR 合了 5 个 ⇒ `进行中`。

| 取值 | 什么时候用 | 形态要求 |
|---|---|---|
| `待办` | 剩余没人认领,无阻塞、无待拍板项 | 裸词,不带括号 |
| `进行中(…)` | 多刀条目已合若干 / 有刀在做,剩余仍要做 | 括号内必须带 ≥1 个**已合入** `#PR 号` |
| `待拍板(…)` | 取证 / 读数已交,选哪种做法在维护者 | 括号内写清等谁定什么 |
| `⏸ 挂起(…)` | 有明确阻塞条件或触发条件,当前刻意不做 | 括号内写清原因 |
| `已收口(…)` | 剩余为零 | 括号内必须带 ≥1 个**已合入** `#PR 号` |

⚠️ **射程**:那条闸只管「commit subject 点名了编号」的那批 —— 实测(`3948ccbc`)近 40 个 commit 里
**20** 个带 `Pn-m`。它管住的是「点名了却仍写待办」,漏的是「压根没点名」。
**闸绿 ≠ 台账准**;另外状态是**条目级**的,多刀条目里新增的那一刀它也看不见。

<!-- status-legend:end -->

---

## P0(harness 落地链路)

(P0-1 / P0-2 / P0-3 均已完成,见[已收口项归档](../archive/ai-harness/next-tasks-completed.md)。)

### P1-27 v0.66.0 外部评审 —— **两轮 findings 全关 + T6-1 运维闭环已交付**(#897/#898/#901/#903);⏸ **剩两笔全部卡在「域名未下来」** + T6 后总评审 🟡

**状态**:⏸ 挂起(两轮 findings 全关、T6-1 运维闭环已交付;剩两笔全在 T6 真机与其后的总评审,卡在域名备案未落地,AI 无可做之事)

> **2026-08-03 交付状态**:第一刀 [#897](https://github.com/BA7IEE/srvf-nest-api/pull/897)(B1/B2/B3,第 70 migration)
>
> - 第二刀 [#898](https://github.com/BA7IEE/srvf-nest-api/pull/898)(B4–B7 + SF1/SF2,零 schema)**均已合入 main**,
>   顺序 #897 → #898(#898 的 B4 对齐的是 bind 锁序,而 bind 在 #897 写集内)。
>   六/三条**全部有 red-first 成对证据**。
>
> ⚠️ **本行原先写的「既有 spec 零修改(两刀的测试文件全是新增)」是事实错误,由第二轮评审抓出**。
> 真实情况:#898 的 4 个测试文件确实全是新增,但 **#897 改了 7 个既有测试文件**。
> 错因是主会话核验时**只跑了 #898**(`4 A / 0 M`),把结论写成覆盖两刀 ——
> 「挑着验 = 没验」这句刚写进本条目当教训,当天就以同一种方式复发。
>
> 七个被改文件的独立定性(第二轮评审逐个判,主会话接受):
>
> - 5 个 e2e(`app-me-wecom` / `auth-wecom` / `wecom-binding-concurrency` /
>   `wecom-lifecycle-concurrency` / `wecom-user-lifecycle`)= **中性连坐修正**,
>   只加 Cookie 捕获与发送,原业务断言未放宽;
> - `identity-step-up.service.spec.ts` = **收紧**(新增 version ABA / 必填 binding / 非 WECOM action 零漂移);
> - `wecom-schema.e2e-spec.ts` = **不是单向收窄**,而是「用一个具名例外替换旧不变量 + 强化形态」。
>   已在 PR body 明确揭示,不是暗改;但主会话原先"只收窄不放宽"的措辞**数学上不成立** ——
>   旧断言禁止的一个东西现在被允许了。**描述行为契约变化时不要用会掩盖性质的措辞。**
>
> #### 第二轮评审结论(2026-08-03):**GO WITH CONDITIONS**
>
> 直接安全 BLOCKER **0** —— 未再发现账号接管 / 跨 CorpID 错投 / 可兑现死锁 / SENT 误记 / P0-E 破坏。
> 上一轮 B1 / B2 / B5 / B6 / B7 判**真修好**;SF1 修好;**B4 的机制被评审方正式撤回**。
> 新增 **3 SHOULD-FIX + 1 NIT**,逐条见下方「剩余账」。
>
> ⚠️ **证据链要说准**:PG 那条是**两次独立实测(lane + 主会话)+ 一次文档核读同意**。
> 第二轮评审**诚实声明沙箱无 PG/Docker/网络,没有冒充实测** ——
> 它做的是读 PG16 tuple-lock 实现说明 + 逐行审我们的三连接用例有没有踩
> `SELECT 'literal'` 不锁行的坑。**这个自我约束比它的结论更值得信。**
>
> #### 第三刀已交付(#901,2026-08-03)—— 剩余账的 1/2/3 全部关闭
>
> - **① pre-auth 代际**:`login-wecom.service.ts` `runBindTransaction` 步骤 6b 补 `+1`,
>   走步骤 3 **已持有的那把 User `FOR UPDATE`**(不开第二把锁,不引入新的 `User → …` 边);
>   同目标 no-op 提前 return 故不递增。四条真实 DB 断言全过。
>   ⚠️ 交付方自报:四条里「no-op +0」「后腿失败回滚」在未修代码上是**空绿** ——
>   用变异 A(无条件递增)/ B(事务外递增)证明它们真会咬;B 的现象是 **500**
>   (事务自己持着该 User 的 `FOR UPDATE`,事务外连接永远等不到)。
>   **空绿用例在报告里和真判据长得一模一样**,这是本轮最值得记的取证纪律。
> - **② 错注释**:三处订正(`notification-wecom-dispatch` / 并发 spec 前提 / `notifications/CLAUDE.md`);
>   护栏断言从单格扩成**四格相容矩阵**。
> - **③ replay 终态判据**:默认只放行上次是 `rate-limited` / `provider-contract-error`
>   (intent dead 过 **且** 最后那条 delivery 的 reasonCode 在允许集内);
>   新增 `never-attempted` / `last-attempt-not-replayable` 两个 reason;
>   越界需显式 `{ overrideReason: true }`,**只绕这一条**。入口/RBAC/Audit 仍归 T6。
>
> **🔴 交付中抓到的最重要一件事:上一版护栏是假的。**
> 第三刀的 red-first 显示:把闸的 settings 改成 `FOR UPDATE`(评审称"会让护栏红"的那个改动)
> → **护栏照绿** ⇒ 假护栏坐实。**主会话已独立复核**:把锁序挪回 `User → settings` 后,
> 主用例当场红(1 failed / 6 passed),而 PG 相容矩阵那 6 条全绿 ——
> 印证交付方对自己护栏的定性(**矩阵守 PG 语义,主用例守应用锁序;矩阵用手写 SQL 造锁,
> 改应用代码不会让它红**)是准的。
> ⇒ `AGENTS §1` 早就写着「结构断言发现不了『代码还在但不起作用』」——
> 这次那个"还在但不起作用"的东西**就是守护自己**;而主会话在前两轮报告里**两次**夸过它,
> 第二轮外部评审也认可了它,**三方都没验它会不会咬**。
>
> **⚠️ 交付方还自报又写错一条机制描述**:初版订正说"应用侧锁模式改动由主用例负责",
> 跑变异才发现主用例也不红。真相是 **做功的是顺序,不是模式** —— 修完两条路径同为
> `settings → User`,顺序一致就没有反向边,此时改锁模式构不成环。同一天同一主题第二次栽在
> "推理链很顺但没跑"。
>
> #### SOP §1.6 的一处**已拍板豁免**(2026-08-03)
>
> 按 §1.6,第三刀这批修复自己也该再投一轮。**维护者拍板:并进 T6 之后的那一轮总评审,不单独投。**
> 理由:本批仅 3 条 SHOULD-FIX、零 schema、且交付方自己跑了变异证伪(含主动推翻自己的机制描述),
> 主会话另做了独立变异复核;而 T6 完成后本来就要有一轮覆盖真机的总评审,合并投放注意力更集中。
> ⇒ **豁免的是"单独投一轮",不是"免评审"** —— 开 `loginEnabled` / `messageEnabled` 之前,
> 那轮总评审仍是硬门。
>
> #### T6-1 已交付(#903,2026-08-03)—— replay 运维闭环补齐
>
> `POST /api/admin/v1/notifications/:id/replay-wecom`,**逐字镜像 `send-sms` 的形状**
> (既有 admin controller,零新 controller / 零新 surface)。新权限码
> **`notification.replay.wecom`** 绑 ops-admin **不绑 biz-admin**(运维面 ≠ 业务面)。
> **Audit 复用 `notification.publish` 伞事件 + `extra.operation='replay-wecom'`**
> ⇒ **AuditLogEvent 恒等 136**(零新事件串);`overrideReason` 单独成布尔字段,
> 「谁绕过了允许集」可按 extra 直接筛出来。
> 计数:Endpoint **450→451**、权限码 **227→228**;BizCode / AuditLogEvent / Migration /
> Cron / Controller **恒等**;零 schema。
>
> **判据零第二份**(主会话亲核):`NotificationService.replayWecom()` 里唯一提到允许集的是
> 一句注释「**本方法零判据**」,方法体是 `rbac.can` → `replayDirectedWecomDelivery()`
> → `auditLogs.log` 的真转调 —— 允许集与终态检查全在 #901 的 outbox 原语里。
>
> **交付方自报的两条**:①既有 spec 连坐是**三处**不是两处(漏的
> `seed-position-role-policies.e2e-spec.ts` 由 CI 抓出)——
> **新增权限码必须按常量名全仓 grep + `seed-*.e2e-spec.ts` 整族跑**,凭印象 grep 文件名会漏;
> ②三件复现不出来的机制(真实上游行为 / 多收件人形态 / CLI-vs-端点的审计归属对比)已如实列出。
>
> ⚠️ **一处交付方未申报的写集偏离**(主会话核出,不返工,记录在案):
> `src/modules/audit-logs/audit-logs.types.ts` **不在 goal 声明的写集内**。
> 改动本身**是对的**(给既有 `notification.publish` 那行的 `extra.operation ∈ {…}` 补上
> `replay-wecom`,**零新增 union 项**)—— 不补反而会变成"注释与代码不符"。
> 但它没进偏离清单。**写集是排班与集成核对的依据,漏报一次就少一次核对机会。**
>
> #### 剩余账(开 `loginEnabled` / `messageEnabled` 前必须关掉)—— 只剩 **T6 两笔**,全部要真机
>
> ⏸ **当前阻塞 = 域名未注册下来**(2026-08-03)。下面两笔与 §15.1 身份链 GO 的 OAuth 回跳全链
> 都要真实 HTTPS 域名;`webBaseUrl` 必须是 HTTPS origin,且按已拍板的**同源部署**,
> 前端与 API 要落在同一个 origin —— 域名/证书规划时就要按这个来,别等下来了才发现拓扑对不上。
>
> | #       | 项                                                                                                                                                                                | 归属                                       |
> | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
> | ~~1–3~~ | ~~pre-auth 代际 / 错注释 / replay 终态判据~~ —— **#901 已关**;~~3 的运维闭环(入口+RBAC+Audit)~~ —— **#903 已关**                                                                  | ✅                                         |
> | ~~4~~   | ~~B3 真实上游耗时残余~~ —— 规则已按 2026-08-03 拍板收窄(AGENTS §3),**残余经维护者明确接受**;真实分布并入下方第 6 笔一起实测                                                       | ✅ 已拍板                                  |
> | 5       | **NIT**:同 purpose 只有一个固定 Cookie,同一浏览器并发两个 login flow 会互相覆盖 → 两个都 36010(可用性,非安全)。既有 e2e 的「按 state 索引 cookie jar」更像多个独立浏览器,发现不了 | **T6**(真浏览器双标签页)/ FE single-flight |
> | 6       | 真浏览器 Cookie 行为(`__Host-` 防子域投毒、`SameSite=Lax` 拦跨站 XHR)—— supertest **不执行**这些属性,只断言了 `Set-Cookie` 字符串                                                 | **T6**                                     |
>
> **部署拓扑已拍板 = 同源**(2026-08-03),故第二轮评审提的「credentialed CORS 生产 BLOCKER」**不成立**,
> `enableCors` 保持不开 `credentials`。⚠️ 改跨 origin 部署前禁开 `loginEnabled`,见 `current-state` §1。
>
> #### ⚠️ 一条必须让下轮评审复核的**反转结论**
>
> 评审给的「三事务死锁」**双方独立实测均复现不出来**。
> 环依赖第 ④ 步「最终闸的 `settings FOR SHARE` 会排在 PATCH 的 `FOR UPDATE` 等待者身后」——
> **PG 行锁没有这种 FIFO**:后到的 `FOR SHARE` 只与**持有者**比相容性,与既有 SHARE 持有者相容
> 就立即获准,直接越过排队中的 `FOR UPDATE`。
>
> - lane 用三条 psql 连接实测(PG 16);
> - **主会话独立复跑**:A 持 `FOR SHARE` → B 要 `FOR UPDATE`(`pg_locks` 确认 1 条未授予、
>   `transactionid/ShareLock`)→ C 后到要 `FOR SHARE` **0ms 拿到**。读数一致。
>
> ⇒ **锁序倒置属实且已修**(bind 是 `settings→User`,旧闸是 `User→settings`),
> 但性质是**结构隐患**而非已兑现的死锁 —— 当前锁模式下没有第三方能让它兑现。
> 该 PG 语义已做成**可执行护栏**(`notifications-wecom-lock-order-concurrency.e2e-spec.ts` 第三条)。
>
> > ⚠️ **本段原写「升级 PG、或把闸的 User 升成 `FOR UPDATE`、或把 bind 的 settings 改成
> > `FOR UPDATE`,它就会红 —— 那正是这个环重新可兑现的时刻」。第三刀(#901)实测证明这句话错两层**:
> >
> > 1. **那条护栏全程用自己手写的 SQL 造锁**,不经过最终闸也不经过 bind ——
> >    **改应用代码不会让它红**。实测把闸的 settings 改成 `FOR UPDATE`,本文件 7 条**全绿**。
> >    它红只意味着一件事:**PG 的行锁相容/排队语义变了**。
> > 2. **「把闸的 User 升成 `FOR UPDATE`」本来就补不上那条边** —— 缺的边在 `settings` 上,
> >    User 那半边早已冲突,升它改变不了 settings 两侧都是 `FOR SHARE` 这件事。
> >    旧序下要兑现,得**任一侧**把 settings 升成 `FOR NO KEY UPDATE`/`FOR UPDATE`,
> >    或新增一条「持 User 后申请 settings 写锁」的路径(与上表第 2 行同义)。
> >
> > **而修完之后**两条路径同为 `settings → User`,**顺序一致就没有反向边** ——
> > 此时再怎么调锁模式也构不成环。**做功的是顺序,不是模式。**
> > 会让它重新可兑现的只有「把 settings 挪回 User 之后」,守这条的是该 spec 的**主用例**,
> > 不是那条 PG 矩阵护栏。判据与四格相容矩阵见 #901。
>
> #### 取证方法论:三次「仪器撒谎且读数印证预期」(同一天,三个不同的人/环节)
>
> 1. lane 的 B3 计时探针把**自己的 authorize 往返**算进被测分支(实参在 `Date.now()` 之后求值),
>    读数 A=27/B=94/C=85/D=100ms **与评审的「四条路径各自可分」严丝合缝** —— 差点直接写进报告。
>    修正后真相是「A vs 其余」可分,B/C/D 彼此几乎分不开。
> 2. lane 的 PG 探针写成 `SELECT 'literal' … FOR SHARE` —— **目标列表不含该表任何列时 `FOR SHARE` 静默不加锁**,
>    读数完全反了。换 `SELECT id` + `pg_locks`/`lock_timeout` 正面确认才敢下结论。
> 3. 主会话复跑时 `sed` 未给 `3s` 加引号 → psql 语法错误 → **错误文案里含 `lock_timeout`**
>    → 检测器判成「被挡住,评审对」。**破绽是 `0ms`**(真被挡会等满 3 秒)。
>
> ⇒ **读数印证预期的那一刻,正是最该怀疑仪器的时刻。** 三次都是。
>
> #### 原始 findings(保留归档;逐条落点与修复方向见下)
>
> 范围 `b6a2f9d8..b97ef4a6`(19 个 PR);外部跨模型批次评审,2026-08-03 判 **NO-GO**。
> 写集核对:19 个 PR **零越集**。身份占用并发、User 生命周期矩阵、P0-E refresh 联动 **通过**。
> ⚠️ **评审未动态跑测试** —— 给的是确定性 barrier 调度与完整请求时序,自述"不表述成已跑红"。
> **修前每条必须先写出真会红的用例**(SOP §1.5 末条:结论属实 ≠ 机制正确,照错机制修会修错地方)。

**批次级根因(单 PR 视角看不见)**:多个局部状态机各自写得严谨,**但彼此之间缺少同一"代际"** ——
浏览器代际、身份代际、配置代际、Worker 租约代际。齿轮单看都圆,装在一起开始咬错齿。

#### 第一刀:#882 账号接管面(最急;与 wecom 两个开关**无关**)

| #   | BLOCKER                                                                                                                                              | 落点                                                                                                                   | 修复方向                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | OAuth `state` **未绑定发起浏览器** → 登录 CSRF;未绑定分支可升级为**完整账号接管**(受害者输入自己手机号后,攻击者的企微身份被绑到受害者 User)          | `auth.controller.ts:425-449` · `login-wecom.service.ts:63-73,119-129,296-320` · `wecom-auth-attempt.service.ts:51-119` | authorize 时另发浏览器关联 nonce,`Secure+HttpOnly+SameSite` Cookie 存原值、attempt 只存 hash;callback 必须同时携带匹配 Cookie;state/Cookie/attempt 三者原子一次性消费。**须补双 user-agent E2E**                         |
| B2  | `WECOM_BIND` proof **ABA 回环**:无绑定态指纹是字面 `null`,`null→bind→admin clear→null` 后旧 proof 复活(注释只分析了 `active→clear→null`,漏了这条)    | `identity-step-up.service.ts:218-279` · `user-wecom-binding.service.ts:251-282,378-426`                                | 加**单调身份代际**(如 `User.wecomIdentityVersion`,bind/rebind/clear/softDelete/reopen 同事务递增),proof snapshot 纳入 version。⚠️ **不要**改 P0-E(立即吊销 access / tokenVersion)—— 15 分钟自然到期本身是对的,缺的是代际 |
| B3  | 36010 **码形归一成立、耗时不归一**(state 无效 / code 格式无效 / OAuth 拒绝 / 停用软删,四条路径查询长度不同),违反防枚举决策锁「任何耗时差异都算漏洞」 | `login-wecom.service.ts:119-169,326-346`                                                                               | 所有 36010 走统一出口 + 补齐固定本地开销 + 有界最小响应时长 + 小扰动;**测试用分支 instrumentation 断言都进同一出口**,别写脆弱的毫秒阈值 E2E                                                                              |

> ⚠️ 评审同时**纠正了下发方的错误判据**:「未绑定」按冻结行为应返 **200 `bindingRequired`**,不是 36010。
> 原「三者同码同形」测试矩阵本身写错了。

#### 第二刀:T5B 信任根(在 `messageEnabled` 仍为 false 时一次性修)

| #   | BLOCKER                                                                                                                                                                                                                | 落点                                                                                                                                                                       | 修复方向                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B4  | **三事务死锁**:`bind` 取 `settings→User`,T5B 最终闸取 `User→settings`,叠加 settings PATCH 的 `FOR UPDATE` 成环(PG 为防写者饿死,新 SHARE 会排在已等待的 UPDATE 之后)                                                    | `notification-wecom-dispatch.service.ts:202-249` · `user-wecom-binding.service.ts:251-282` · `login-wecom.service.ts:393-430` · `wecom-settings.service.ts:98-119,259-278` | 最终闸把 **settings SHARE 提前到 User 之前**,共同实体相对锁序统一为 `settings→User→identity`。**须补真实三连接 barrier 测试**,不接受"跑一百次没遇到"                                                                      |
| B5  | 最终闸锁的是**旧配置下的身份**,handler 事务外又 `resolveRoute()` 取最新 settings → 可**跨 CorpID 错投**(Corp A 的 userid 发进 Corp B)                                                                                  | `notification-wecom-dispatch.service.ts:202-249` · `notification-outbox.handlers.ts:724-807` · `wecom.service.ts:99-127`                                                   | 新增不可拆分的 `resolveMessageContext()` 返回 `provider+corpId+configurationGeneration+webBaseUrl`;闸内校验 generation 未变;提交后**只能用此前那个 Provider**。`resolveLoginContext()` 早已写明这条原则,消息链没遵守      |
| B6  | `beforeEffect` **只包 Provider 外壳**,`request()` 内部最多 3 次 `fetch` 全无 fence;且尝试预算 3×8=24 未统一;`forceRefresh` 绕过 `refreshPromise`,并发 40014 会各自强刷                                                 | `wecom.provider.ts:290-375,387-500` · `notification-outbox.worker.ts:246-334`                                                                                              | `beforeEffect` 下沉到每个 `fetch` 紧前;物理尝试预算贯通(或干脆移除 Provider transport retry 全交 Outbox);`forceRefresh` 只绕缓存不绕 singleflight。**并发 40014 须断言 gettoken 实际请求数 = 1**                          |
| B7  | Provider 错误类型**在 Outbox 边界被擦除**:非 lease-lost 异常一律记 `TOKEN_FAILED` + Transient;`isTransientWecomError('HTTP_ERROR')` 不分 4xx/5xx ⇒ **gettoken 阶段的 45009、错误 CorpSecret、HTTP 4xx 全被当暂态退避** | `notification-outbox.handlers.ts:754-807,1283-1327` · `wecom.provider.ts:420-500`                                                                                          | Provider→Outbox 保留**类型化错误**(rate-limited / config-fatal / http-4xx / http-5xx / network / timeout / invalid-response / token-invalid / channel-disabled);Outbox 只对 network/timeout/5xx/允许的 token-invalid 退避 |
| SF1 | 畸形回执被当空名单:`splitUserList` 对 number/array/object/null 返 `[]` ⇒ `{errcode:0, invaliduser:123}` 会**误记 SENT**                                                                                                | `wecom.provider.ts:334-366,502-505` · `notification-outbox.handlers.ts:811-858`                                                                                            | 严格三分:缺席/空串=空名单;字符串=解析;**其它类型 = `INVALID_RESPONSE`,不得 SENT**。另补 `errcode!=0` 同时带 invalidparty/invalidtag 的情形                                                                                |
| SF2 | **系统定向通知无 replay 路径**:v1 eventKey 固定 `wecom-delivery:{nid}:{mid}` + terminal delivery 占 `intent.id`,撞 45009 后人工改回 pending 也会被幂等判据直接短路;且它没有 publish generation                         | `notification-outbox.handlers.ts:201-267,650-660,900-930` · `docs/ops/wecom-message-channel-rollout.md §6`                                                                 | 给系统定向 child 加 replay generation / nonce,或提供显式 replay 建新 child id + 新 eventKey;跨 attempt 去重继续用 `notificationId+memberId+channel+SENT`                                                                  |

**⚠️ 修法纪律(评审原话,采纳)**:「不要先对某个 catch 打补丁或只调换一行 SQL。
这里的问题都是**状态机接口错误**,局部胶带会让下一种交错从旁边钻出来。」

**两刀各自修完须再投一轮评审**(SOP §1.6:修复批次是整个改造里最危险的代码)。

#### 下发方(本仓 AI)在本轮的三处失手 —— 留痕,别重犯

1. **注释与代码不符,且骗过了自己的审计**:锁序注释写 `identities→settings`,实际是 `settings→identity`。
   而 S1–S7 自审**声称 S5(注释无执行位)已查** —— 实际只机核了 `toparty/totag` 与 `wecomUserId` 两条。
   **挑着验 = 没验**;声称查过某一形状,就要把该形状的**全部**载荷点列出来逐条过。
2. **"不可能成环"的推理只枚举了写者**:只想了 settings PATCH 只锁自己那行,
   **从未枚举"还有谁持 settings 锁"** —— 而 bind 路径就持。**判环必须枚举全部持锁者,不是只看 writer。**
3. **递给评审的重点清单本身带错**(把「未绑定」写成应返 36010)。下发包里的判据也会错,
   评审纠正下发方的判据是**正常且必要**的,不要把它当噪音。

## P1(长期维护)

### P1-30 通用系统集成地基 Integration Foundation v1 — **T0 已于 2026-08-19 拍板冻结(「按推荐」);PR1–PR8 一行未实施,⏸ 队首前置②已满足(2026-08-27 复测),开工等维护者拍板 + 基线漂移重跑**

**状态**:进行中(维护者 2026-08-28 拍板开工并提供规格书;基线漂移重跑 #1214 已合,**PR1 schema 地基已交付**;下一步 PR2 控制面 + RoleBinding 支持 —— 严格串行,每刀改 ROUTE_AUTHZ 红区生成物)

- **拍板**:2026-08-19 维护者回复**「按推荐」**,冻结稿 §2.1 决策表 `D-IF-1 … D-IF-12` **全部按推荐值(全 =A)整体冻结,无逐项调整**([#1086](https://github.com/BA7IEE/srvf-nest-api/pull/1086))。
- **依据**:[`integration-foundation-v1-t0-terminal-review.md`](../archive/reviews/integration-foundation-v1-t0-terminal-review.md)
  (冻结稿,不回改;偏离须另出 superseding / amendments)。上游权威设计基线 = 维护者提供的《SRVF Integration Foundation v1 终态架构与分阶段落地实施规格》。
- **要解决什么**:外部系统(ICC / 车辆 / 物资 / 无人机 / 值班 / 大屏 / AI Agent / 其他部门自研)如何安全接入 —— 既不开放 PostgreSQL,也不给它们真人账号密码。
  终态 = **ServicePrincipal**(机器身份)+ **ServicePrincipalCredential**(可轮换凭证)+ **DelegationGrant**(受控代人)+ 第六 canonical surface `/api/integration/v1/*`。
  **通用基础设施,不得以任何部门命名核心表 / 模块 / 权限 / 路由 / 通用 DTO。**
- **序列**:`T0 ✅ → PR1 schema → PR2 控制面+RoleBinding → PR3 机器认证/Token/Gate/第 12 throttler → PR4 Principal-neutral Authz
  → PR5 Delegation + 双主体 Audit → PR6 第六 surface + /me + 幂等 → PR7 首个真实业务接入 → PR8 runbook/release`。
  **全部 D 档、单独 CI、单独人审、严格串行**(冻结稿 §18 已论证为什么不能并行)。
- **⛔ 三条硬约束(实施前先读冻结稿对应节)**:
  1. **PR7 不做考勤写接口**(§6 C-ATT-1)—— `ACTIVITY_V11_WORKFLOW_ENABLED` 已合入但真相链仍在切换中;
     待生产做出并稳定选择后另立 PR7'。任何 PR 禁止新增绕过 `assertLegacyWriteAllowed()` / `assertV11WriteAllowed()` 的通路。
  2. **Integration principal 绝不能挂 `request.user`**(§5.3 F-1)—— 生产代码里只有 2 处读它,一挂上就等于让 503 个 `@CurrentUser()` 与 `RolesGuard` 把机器当人。
  3. **PR2–PR7 每个都会改写红区生成物 `ROUTE_AUTHZ.md`**(F-2,其 `inputDigest` 覆盖全部 `src/**/*.ts`)⇒ 一次只能有一条在飞;合并用 merge 不用 rebase。
- **⛔ 开工触发条件(2026-08-20 复核后重定;**取代 08-19 那版**)**:**T0 已合并、板已拍完,都不构成开 PR1 的授权。**
  四条齐了才可以开工,缺一即停:

  | # | 条件 | 硬度 | 现状(2026-08-20 实测 `403fd27e`) |
  |---|---|---|---|
  | ① | **无任何 schema-touching lane 在飞** | **硬**([`process.md §8`](../process.md) 同一时刻至多一条) | 🟡 此刻空窗(0 open PR),但队列非空 —— 见② |
  | **②** | **P1-32 的 PR 1(Permission Catalog 单一事实源)已落地** | **硬**(维护者 2026-08-20 拍板「A」) | ❌ 未开始;P1-32 的 PR 0 需维护者逐条分类 **236 条权限**,是人工长杆 |
  | ③ | 不在 release 收口窗口 | **硬**(E 档要 global preflight 全过 = 0 open PR) | ✅ **已满足** —— v0.67.0 已发(Latest)、0 open PR |
  | ④ | 首次上线用的 release tag **已切并钉死**,或生产已部署完成 | 建议(满足其一即可) | 🟡 前进中 —— 真机部署第一阶段 2026-08-20 PASS(`APP_ENV=smoke` 非生产态);发布边界仍 🟡 NO-GO(卡备案) |

  **② 是当前真正卡住 PR1 的那条。** 叠加上面第 3 条硬约束 ⇒ **PR1–PR8 之间也一次只能有一条在飞**。

  > ⭐ **2026-08-27 复测(`743abb5b`,docs 对齐刀,上表 08-20 读数自此为历史快照)**:
  > **② 已满足** —— P1-32 的 PR 1(Permission Catalog 单一事实源)随 [#1143](https://github.com/BA7IEE/srvf-nest-api/pull/1143)
  > 于 2026-08-22 合入 main(P1-32 现已完整落地 7/9,PR 0 的 236 条分类早已完成);
  > ① ✅(0 open PR 实测);③ ✅(v0.69.0 已发 2026-08-24,0 open PR);④ 仍 🟡(真机第一阶段
  > 为 `APP_ENV=smoke` 非生产态;发布边界 🟡 NO-GO 卡备案)。
  > ⇒ **上一段「② 是当前真正卡住 PR1 的那条」自此订正:三条硬条件已齐,开工现在只差
  > ①维护者拍板 ②按冻结稿 §1 体例重跑基线漂移** —— T0 冻结 `48637fab` 后 main 已前移 **117 笔**、
  > 连发 v0.67 / v0.68 / v0.69 三版;当前计数 Endpoint **554** / Migration **99** / BizCode **470** /
  > 权限码 **237** / AuditLogEvent **147**(对 T0 的 Δ = +17 / +10 / +21 / +3 / +8,比 08-20 表里的
  > +8 / +3 / +9 / +3 / +7 继续扩大),冻结稿承重事实逐条复验仍待重跑。
  > 第 3 条硬约束(ROUTE_AUTHZ 红区生成物)不变 ⇒ PR1–PR8 仍严格串行。

  > ⭐ **2026-08-28 基线漂移重跑(冻结稿 §1 体例,`4d2792fc`;取代上方 08-20 漂移表
  > 为最新读数,那张表自此为历史快照)** —— **结论:承重事实全部成立,不需要
  > superseding;PR1 可在维护者拍板后直接开工**:
  >
  > | 计数项 | T0 冻结(`48637fab`) | 2026-08-28(`4d2792fc`) | Δ |
  > |---|---:|---:|---:|
  > | Endpoint | 537 | **554** | +17 |
  > | Migration | 89 | **99** | +10 |
  > | BizCode | 449 | **472** | +23 |
  > | 权限码 | 234 | **237** | +3 |
  > | AuditLogEvent | 139 | **147** | +8 |
  >
  > | 冻结项 | 2026-08-28 逐条复验 |
  > |---|---|
  > | `D-IF-3` BizCode 段位 37xxx | ✅ 仍全仓零占用 |
  > | `D-IF-10` `PrincipalType` 恰 4 值 | ✅ USER / MEMBER / POSITION_ASSIGNMENT / SYSTEM,未变(IF 落地时按拍板⑩增 `SERVICE_PRINCIPAL`) |
  > | **F-1** `request.user` 生产读取点 | ✅ 仍恰 2 文件(`current-user.decorator.ts` / `roles.guard.ts`;全仓 6 处命中 = 2 文件的 4 代码点 + 2 注释) |
  > | **D-IF-5** 前缀族 | ✅ 仍是 `rbac.*` / `role-binding.*` 两前缀,结构未扩宽;**保留码 6→7**(2026-08-22 #1115 wecom 凭证重置码入 SA-only 保留集,第六轮 E-B1 + 机器闸,显性扩集非静默漂移 —— 记录在案,不构成重开 D-IF-5 的理由) |
  > | `Permission` 模型 | ✅ 仍未被加列(eligibility 两字段落点干净) |
  >
  > 开工四条件现值:① ✅(0 open PR)· **② ✅(#1143 已合)** · ③ ✅(v0.69.0 后非收口窗)·
  > ④ 🟡 建议级(真机 smoke 非生产态)。⇒ **只差维护者开工拍板**;PR1 起每刀改
  > ROUTE_AUTHZ 红区生成物,严格串行(第 3 条硬约束)。

  **✅ PR1 已交付(2026-08-28,维护者拍板「6 开」+ 提供规格书 + schema/migrations 红区令牌)**:
  第 100 条 migration(六新表 + SERVICE_PRINCIPAL + 资格门两列 + 双主体审计四列;
  全部 CHECK 双向变异对拍,e2e 15 用例;干净库全量重放;零回填;drift 对拍仅索引名
  截断类装饰性差异与存量同类)。domain-map 新域 integration-foundation + 空壳属主模块
  (PR2 按规格书 §41 拆四实体模块)。**下一步 PR2(控制面 + RoleBinding 支持,
  改写 ROUTE_AUTHZ 红区生成物,严格串行)。**

  > ⚠️ **订正 08-19 那版条件①的表述错误(2026-08-20 实测)**:原文写「等 **P1-28 活动线** 让出 migration token」,
  > 把当时的队首误当成了结构性约束。实测:活动线近 40 笔里只有 **3 笔**相关、基本已静;
  > migration 90/91/92 全属**别的线**(队员身份主档 [#1096](https://github.com/BA7IEE/srvf-nest-api/pull/1096) /
  > 视觉身份资产 [#1106](https://github.com/BA7IEE/srvf-nest-api/pull/1106) / 第六轮 prisma 锚点 [#1125](https://github.com/BA7IEE/srvf-nest-api/pull/1125))。
  > ⇒ 正确表述是「**无任何** schema lane 在飞」,不点名任何一条线。
  > 账本桥(终审改提交 `LedgerPostingBatch`)仍未搭(`attendance-review.service.ts` 仍写 `pending_final_review → approved`),
  > 但它已不是 PR1 的队首前置。

- **⛔ 与 [P1-32](#p1-32-rbac-权限目录与角色权限管理终态--8-个-pr已抽-1-条实施余-7-条待排) 的关系:重叠,不是排队(2026-08-20 维护者拍板「A」)**

  两者**碰同一张表、同一件事**,不是先来后到的档期问题:

  | 碰撞点 | 本项目(IF) | P1-32 |
  |---|---|---|
  | `prisma/seed.ts`(红区) | PR2 新增 9 条控制面权限码 | PR 1 重构权限事实位置 |
  | `rbac-seed-facts.ts`(红区) | PR2 | PR 1 |
  | `prisma/schema.prisma` + migration | PR1(`Permission` +2 列、新表、`PrincipalType` 枚举) | PR 4(`RbacRole.permissionRevision`) |
  | **`Permission` 元数据归属** | 挂 `servicePrincipalAllowed` / `delegatedAccessAllowed` | Catalog 成为**单一事实源**,Catalog-owned Permission 禁运行时增删改 |

  最后一行是要害:**两边各自给 `Permission` 挂元数据 = 给权限元数据造第二份真相**,正是本仓一贯反对的形状。
  另有计数连带:P1-32 的 PR 0 要维护者给 **236 条**权限逐条定分类且 DoD 明写「不许有未分类 active 权限」;
  IF PR2 会 +9 条 —— 先做 IF 则那张表变 245,先做 Catalog 则 IF 那 9 条须从 Catalog 进。

  **⇒ 拍板结果(A):先让 P1-32 走到 PR 1(Catalog 落地),IF PR1 再上。**
  这样 IF 的两个 eligibility 字段有正确归属位置,不用事后返工。
  代价是 P1-32 PR 0 卡在维护者逐条分类,IF 要多等一程 —— 已接受。

  > ⚠️ **纠正一处此前的错误理由(2026-08-19 实测)**:冻结稿 §3.3 与本条原文都写过
  > 「PR1 合入 main 就会随首发进生产」—— **本仓不是这么部署的**。
  > [`deployment.md`](../deployment.md) §「生产 migration」明确:上线 SOP 先核对**当前批准的 release tag**、
  > 绑定不可变 SHA / image digest,migration 通过条件是**该 tag 的已审查 migration 均已部署**,
  > 并专门禁止「用会随版本增长的累计数量作门槛」。
  > ⇒ 合进 main ≠ 进生产;真实风险只在「go-live tag 恰好在 PR1 之后切」这一种情形,
  > 故上表把它降为条件 ③(可用「先把 tag 钉死」消解)。
  > **`D-IF-2`=A 的结论不变**(PR1 仍不现在开),变的只是理由:从 migration 论证换成上表四条。
  > 冻结稿正文按 `D-IF-12` **不回改**,该修正待出 `integration-foundation-v1-t0-amendments.md` 时正式落文;
  > 在此之前**以本条为准**。

- **📉 冻结稿基线漂移(2026-08-20 实测 `403fd27e`;开工前须按冻结稿 §1 体例重跑)**

  T0 冻结在 `48637fab`(v0.66.0),此后 main 前移 **47 笔**并发布 **v0.67.0**(现为 Latest,不再 pre-release):

  | 计数项 | T0 冻结时 | 现在 | Δ |
  |---|---:|---:|---:|
  | Endpoint | 537 | **545** | +8 |
  | Migration | 89 | **92** | +3 |
  | BizCode | 449 | **458** | +9 |
  | 权限码 | 234 | **237** | +3 |
  | AuditLogEvent | 139 | **146** | +7 |

  **但冻结稿的承重事实逐条复验仍成立**,不需要 superseding:

  | 冻结项 | 2026-08-20 复验 |
  |---|---|
  | `D-IF-3` BizCode 段位 37xxx | ✅ 仍全仓零占用(新增 9 码未碰) |
  | `D-IF-10` `PrincipalType` 恰 4 值 | ✅ 未变 |
  | **F-1** `request.user` 恰 2 处生产读取点 | ✅ 仍是 `current-user.decorator.ts` + `roles.guard.ts` |
  | `D-IF-5` `isControlPlanePermissionCode()` | ✅ 仍是 `['rbac.','role-binding.']` ∪ 6 保留码,未被扩宽 |
  | `Permission` 模型 | ✅ 未被任何人加列 —— 两个 eligibility 字段落点仍干净 |
- **拍板冻结值速查**(`D-IF-1..12` 全 =A;权威原表见冻结稿 §2.1,冲突以冻结稿为准):
  ① 采纳终态方向 · ② **PR1 不现在开**(触发条件见上表,理由已换) · ③ BizCode 37xxx 并补登漏登的 36xxx · ④ 新增第六 surface ·
  ⑤ **不动 `isControlPlanePermissionCode()`,只加单向 seed 自检** · ⑥ eligibility 两字段不开放 HTTP 修改 ·
  ⑦ 仅 `ServicePrincipal → 固定 User` · ⑧ 审批/终审永久 Direct User Only · ⑨ 禁部分成功批量导入 ·
  ⑩ 枚举值命名 `SERVICE_PRINCIPAL` · ⑪ `allowedPrincipalKinds` 默认值省略序列化 · ⑫ 本稿为冻结稿。
- **不阻塞首次上线**的三条可核验判据见冻结稿 §3.2(B-1 / B-2 / B-3)。
- **本项目当前状态**:仅冻结稿一份 docs;`src/` 与 Prisma 侧 **零改动**。`current-state.md §3`「暂不启动清单」中的
  「新 schema / migration / Permission seed / Role 扩展」由本 T0 解锁**立项**,**不等于解锁开工** —— 开工另需上面**四条**触发条件全齐,
  其中②(P1-32 PR 1 落地)是当前队首前置。

(P1-3〔Slow-4〕/ P1-7〔SMS 消费者三项〕/ P1-8〔微信小程序登录〕均已完成,P1-4 已于 2026-06-10 调研收口 —— 均见[已收口项归档](../archive/ai-harness/next-tasks-completed.md)。)

### P1-28 活动业务全流程改造(批次 0–8) — **第 0–3 批 ✅ 全收口(2026-08-07;第 3 批五刀 [#952](https://github.com/BA7IEE/srvf-nest-api/pull/952)/[#953](https://github.com/BA7IEE/srvf-nest-api/pull/953)/[#954](https://github.com/BA7IEE/srvf-nest-api/pull/954)/[#955](https://github.com/BA7IEE/srvf-nest-api/pull/955)/[#956](https://github.com/BA7IEE/srvf-nest-api/pull/956));第 4 批前置微刀①✅(第 78 migration `20260807154000_activity_v11_batch4_capacity_reservation_member_activity_unique`，[#959](https://github.com/BA7IEE/srvf-nest-api/pull/959))、②✅(第 79 migration Form 闭集/单会话单附件，[#960](https://github.com/BA7IEE/srvf-nest-api/pull/960))、③ Form runtime / 一次性附件会话([#961](https://github.com/BA7IEE/srvf-nest-api/pull/961))、④ canonical 报名命令主链([#962](https://github.com/BA7IEE/srvf-nest-api/pull/962))、⑤分配/预留名额 DB guards([#963](https://github.com/BA7IEE/srvf-nest-api/pull/963))、发布审核容量桶投影([#964](https://github.com/BA7IEE/srvf-nest-api/pull/964))、三层 CapacityReservation 内核([#965](https://github.com/BA7IEE/srvf-nest-api/pull/965) 已合 main)、⑨永久报名头 DB 地基与 onsite 历史头 fail-closed([#968](https://github.com/BA7IEE/srvf-nest-api/pull/968))、⑩永久头 runtime/个人取消闭环、⑯分配与邀请 C runtime、⑰资格配置/发布激活（managed RuleSet/Rule typed configuration、V5 审核冻结/activation）、⑱活动到点 expiry（既有 worker + PG reconciliation、无新 cron）；合同已修订至 v1.1.1,缺口台账累计 #28**

**状态**:进行中(第 0–3 批已收口 #952 #956;第 4 批多刀已合 #959 #965 #968;第 6 批代码面收口宣告 + 第 7 批②账本桥交付 #1211 + D11 定案(均 2026-08-28);剩余:第 8 批与 9a 的 5 条 C 档能力缺口(AC-010 改期刀已交付 2026-08-28:作废旧码重签;余 AC-013/AC-020/AC-025 大刀后议、AC-017 搁置、ADV-010 卡 P2-21;todo 6→5),合同缺口台账见正文)

> **需求口径变更(2026-08-04)**:**= v1.1 四份 + [`AMENDMENTS-v1.1.1`](../archive/reviews/activity-business-overhaul-v1.1/AMENDMENTS-v1.1.1.md),冲突以后者为准。**
> 第 1 批建表过程中实测撞到**五处合同内部不一致**,维护者当日**全部接受**并发布修订件。原件与 SHA256 一字未动(校验仍过)。
> **2026-08-09 维护者 A–I 拍板（第 4 批⑨，第 81 migration）**：ActivityRegistration 已在 DB 层成为
> 跨 cancelled / soft-deleted 全历史的永久报名头；migration 单事务锁表、先全历史查重复组，任一组
> 仅报组数并以 23505 fail-closed，零删数/合并/修数，再把旧 active partial 换成普通 unique。
> 第 4 批⑩已接 legacy/canonical/onsite 同头复用与个人取消闭环；soft-deleted 头仍不复活。
> **2026-08-09 维护者裁定（第 82 migration，仅兼容地基）**：每次报名/重报的保险 evidence
> 绑定当次 `ActivityRegistrationRevision`；旧 header-only evidence 不改、不回填。第 82 仅落 nullable
> composite FK 与 legacy/revision 两类 partial unique；第 4 批⑩已将报名 producer 与审核切到 currentRevision。
>
> - **A 资格**：上级是底线、下级只能收紧；规则间 AND、规则内 OR；结果分 block/warn。年龄按活动开始日，
>   证书须 approved 且覆盖活动，保险须覆盖全程，组织认直属或子树，培训可复用证书/结业证明；warn score
>   为 0–100，发布时冻结。
> - **B 分配**：每活动唯一方式；新活动显式选择，存量为 first_come。first_come 以服务器受理时间排序；
>   rank/lottery 截止后冻结，rank 同分按 acceptedAt 再按永久 identity，lottery 必须可复查重放，并保存批次和候补顺序。
> - **C 永久报名头**：取消/重报/拒绝后重报只追加版本，永不建第二头。
> - **D onsite**：不得绕过硬资格、保险、性别或名额；warn 留痕。普通题可代录，文件与本人同意不得代办；
>   必记批准人、原因、时间。
> - **E 职责与 scope**：沿七职责，分别覆盖活动、场次、岗位三层 scope。
> - **F 离线**：维护者第 6 批补充合同 v2 已逐字批准六条 package issue/revoke/upload/review wire；B6-2 子刀已实现并保留 22097 零写、22098/22099 staging、唯一 PunchCommand 与安全读面证据。交付判定必须另绑 Draft PR exact-SHA 普通 CI 与独立核验，不能把本子刀局部完成写成完整第 6 批完成。
> - **G visitor**：attendanceCode 永远为 null，且无写入口。
> - **H 更正**：追认现有严格版本化更正 JSON。
> - **I reservation pointer**：capacityReservationId 固定指向 session reservation；释放时清空，不一致为 20147。
>
> **D85 / 第 4 批⑬ 已落可重放分配 DB 地基**：Batch 冻结算法版本、候选 SHA-256 与 lottery commitment/reveal；Candidate 冻结永久头/revision、acceptedAt、资格快照 SHA-256、分数/结果/排名/对象解释，并由两条复合 FK 和同批唯一序号防错锚。migration 仅接受双表为空，旧行 23514 原子失败；第 4 批⑯已作为 writer、实际分配、容量/候补 caller 消费该地基。
> **D86 / 第 4 批⑭ 已落 command/replay 与 applied projection DB 地基**：immutable `prepare/commit/void` receipt 有 activity/batch 复合锚和双唯一；void reason/time 成为 Batch 事实；每 candidate 一条 immutable committed application projection，identity 冻结 `id+activity+session+member`，activity-person reservation 以 `id+member+activity+bucket` 锚定（同 member 跨 session 可复用），session/position reservation 保持 `id+identity+bucket`，均非 JSON 且由复合 FK/shape CHECK 固定。`responseHash` 必取 UTF-8 canonical payload（`activityId`,`allocationBatchId`,`batchStatusCode`,`commandCode`,`responseSchemaVersion`，排除自身）的 SHA-256；JSONB 不保序，DB 仅验传输 envelope shape 和列/JSON 一致。第 4 批⑯在 Activity 根锁内重算 hash、same-key 精确回执/异 hash 冲突分流，复核 Batch/Candidate/Revision/reservation type/Identity pointer，以 20147 完成 0%/100% 命令与实际 caller。
> **D87 / 第 4 批⑮ 已落 Candidate 候补岗位锚**：Candidate 新增必填 activity/session 与可空 waitlist position；candidate→batch、waitlist position 均以完整复合 FK 同锚。result/rank/position 已闭成两值形状，只有 waitlisted 同时携带 position+rank；D85 的全 batch rank unique 改为 `(allocationBatchId,waitlistPositionId,waitlistRank)` partial unique，允许 session-level batch 内不同岗位各自 rank=1，同岗位重复 rank 仍拒绝，lotteryOrder/tieBreakKey 不变。migration 仅接受 Candidate 空表，count-only 23514、零回填；第 4 批⑯只读本 batch 同 session+position 队列递补，绝不跨岗位。
> **第 4 批⑯（分配与邀请 C runtime，本 PR）**：`POST /my/activity-invitations/:invitationId/accept` 复用 canonical Form、资格、保险、身份、容量与分配链。first_come 以服务器受理时间和 identity 稳定处理每个场次，满员只使该场次候补且不建 batch；qualification_rank/lottery 在截止后 `prepare → commit`，冻结 candidate/revision/qualification snapshot/hash，lottery 直到 commit 才揭示 seed，commit 一次性写结果、三层容量、pointer/population、audit/outbox。作废只在所有 D86 live facts 精确一致时释放并重置，任一漂移 20147 零写；后续递补只在原 session+position。
> **第 4 批⑱（活动到点 expiry）**：复用两个既有 worker context 和 `ActivityBatchJob` 的 PostgreSQL `SKIP LOCKED + lease/fence`，无新 cron/queue/进程。仅已到最早 live session start（无 live session 才回退 Activity.startAt）、且仍有 canonical `pending|waitlisted` 或 pending invitation 的 published 活动补建 reconciliation job；执行固定 Activity 根锁 → job fence → headers/identities/current revisions → invitations，一笔事务追加 `review_expired`/`waitlist_expired` system revision、清 pointer/population、投影 header、复用 `registration.review`/`invitation.change` audit。pass 与 active capacity 不动；任何 current revision/status/pointer/population/active reservation 漂移为 20147，canonical/audit 零写，job 仅按既有 lease 协议退避。
> **第 4 批⑲（整单取消/legacy waitlist lifecycle）**：`ActivitiesService.cancel` 在既有 Activity 根事务内调用 canonical lifecycle helper。它按 header→永久 identity→current revision 锁定后，仅把 canonical `pending|waitlisted` 关闭为 cancelled，追加 admin Registration/Participation revision 并 CAS 头投影；无 identity 的 legacy pending/waitlisted 也按已有或新建 RegistrationRevision 链关闭。混合头的 pass 与 active reservation 保留。旧 `promoteActivityWaitlist` 只匹配无 identity 的 legacy header，canonical 候补仍只由 allocation caller 递补。current revision/status/pointer/population/active reservation 漂移统一 20147 整笔零写，且不复制 capacity DML、不新增路由或 audit action。
> **第 6 批已接 ADV-014**：CSV preview 固定 attachment owner、file digest、parserVersion、rowHash 与 previewHash；execute 必须重读同一 pinned object 并重新解析，任一不符为 `ATTENDANCE_IMPORT_PREVIEW_MISMATCH` 且零 PunchEvent。
> **当前行为**：live cancelled/reject 头按入口同头追加 immutable revision；soft-deleted 头的新请求仍按入口
> 21002/21003/21030 fail-closed，旧 operationKey+hash 精确回执保持优先重放。legacy 若已存在永久 identity
> 则 21038，不制造头/身份投影裂缝。AC-021、ADV-005 已由十轮真实 HTTP 链转 destination。
>
> 五条现状:②已生效(快照锚点可空)· ④已解决(加开第五刀 #915)· **①已由第 4 批前置微刀兑现**
> (第 78 migration `20260807154000_activity_v11_batch4_capacity_reservation_member_activity_unique`，[#959](https://github.com/BA7IEE/srvf-nest-api/pull/959)：`CapacityReservation` 补
> `memberId`/`activityId` + partial unique,走 DB 保证不降级为服务层)· **⑤已由维护者 2026-08-07「按推荐」拍板**:
> `resultCode` 闭集=`allocated/waitlisted/not_selected`;同一 `(allocationBatchId, participationIdentityId)` 唯一;
> `scopeTypeCode` 沿 §3.10 容量桶口径,`fallbackMode` 仅「到期释放公共池/到期作废」且默认释放;
> `preferenceOrder` 从 1 起算· **③曾是第 6 批开工硬门**
> (`OfflinePackage`、`OfflinePunchReviewItem` 当时被引用却从未定义；维护者随后以第 6 批补充合同 v1 给出字段表、migration 88 已落，并以补充合同 v2 锁定六条 HTTP wire。新增或改写 wire 仍须另行审批，禁止从旧 §5.7 散文扩面)。
> **第 4 批缺口⑤已兑现（第 80 migration `20260808133500_activity_v11_batch4_allocation_contract_guards`）**：
> `preferenceOrder >= 1` CHECK；candidate 的 nullable `resultCode` 三值闭集和同批次 identity 普通 unique；
> quota 的四值 `scopeTypeCode` CHECK、二值 `fallbackMode` CHECK 与 DB 默认。工程编码固定为
> `activity_person` / `session_participation` / `position_participation` / `reserve_group`，以及
> `release_to_public_pool` / `void_on_expiry`，默认 `release_to_public_pool`。canonical 报名命令已有
> 从 1 开始写入 `preferenceOrder` 的生产 writer；本刀不改该 writer。
> **五条均不阻塞第 2 批。**
> **待折进下一版修订件的已知合同缺口(#6–#28；#7、#14、#16–#18、#23–#25、#27 已裁定，#19–#21 为本刀保守工程裁定，#22、#28 未裁定)**:#6 `workflowRevision` 来源未定义；**本刀局部执行口径**：draft FormVersion 取创建时 Activity 当前值，initial/change 审批激活取该次审批产生的新值；这不代表 #6 已整体解决 ·
> #7 `resultCode` 无「未定」取值（2026-08-07 已裁定：preparing=`null`，非空为三值闭集，待折进修订件）· #8 关账幂等列缺失 · #9 `requestedChangeJson` 结构未定义 ·
> #10 无人触发 `commitBatch` · **#11** §6.1/§6.2 要求草稿动作携带 `operationKey`，但 §10.3 必须覆盖闭集不含它、§3 也没有持久化落点；本刀按 §10.3 不接收该字段 ·
> **#12** §3.1 的 `cancelOperationKey` 提到“全历史操作记录另表保存”，但该表全合同未定义，禁止从散文自造 ·
> **#13** §3.4 `ActivityTemplate.statusCode` 取值集未定义；①.5 只落 `String`，刻意不加 CHECK，待合同修订件 ·
> **#14** §3.4 将 `ActivityRuleSnapshot.templateVersionId` 写成必填，却没有 `Activity` 模板绑定列，且 `ActivityTemplate` 按零 seed 原则无数据；三者合取会令无模板活动在审核通过时无法生成快照。**裁定（维护者 2026-08-06「同意」）**：无模板活动合法，按活动自身值 + 系统默认解析；第 77 migration 放开该列可空并保留可选 FK，待修订件更正原文。
> **#16（维护者 2026-08-07「按推荐」裁定）**：§3.12 未定义 `RegistrationFormField.visibilityCode` 闭集；固定为 `self_and_registration_staff` / `self_and_owner` / `self_only`，第 79 migration 已以 CHECK 落库。
> **#17（同上）**：§3.12 未定义 `RegistrationUploadSession.statusCode` 闭集及 `consumedAt` 双向形状；固定为 `active` / `consumed` / `revoked`，过期由 `expiresAt` 推导、零 cron，`consumed` 当且仅当 `consumedAt` 非空；第 79 migration 已加双 CHECK，保留第 72 migration 的既有单向 CHECK。
> **#18（同上）**：报名附件 MIME / 大小 / 单会话附件数未定义；固定 JPEG/PNG/WebP/PDF、单文件 10 MiB、每会话最多一个完成附件。第 79 migration 落实 `registration-upload-session` 的单附件 partial unique；本刀完成 MIME / 10 MiB seed 与 runtime。
> **#19（本刀保守工程裁定）**：合同未逐字规定 managed Form 的 wire/null/no-op 口径；固定 `form:null|{fields}`、object 的非空 fields、canonical SHA-256 与相同 canonical PUT 无写入/无新版本/无 audit。该裁定可逆，不能表述为原合同已有明文。
> **#20（本刀保守工程裁定）**：第 79 migration 注释的“token 不进任何响应”按同段“原始 token 只返回一次”收窄为“除创建响应外不再返回”；上传路由、后端中转 multipart、30 分钟 TTL 与复用 `attachment_legacy` storage source 均为未逐字规定的执行口径，且不改 schema 注释。
> **#21（本刀保守工程裁定）**：合同未逐字定义 canonical 报名 wire 的 `preferences[].positionIds[]` 顺序如何落库、file 题最终附件 owner；固定按数组顺序派生从 1 开始的 `preferenceOrder`，最终 owner 固定 `registration-form-answer`。两者均可逆，不宣称为原合同明文。
> **#22（第 83 migration + 第 4 批⑪/⑰已兑现）**：资格规则 wire 固定为 `grade/gender=in+codes`、`organization=in_subtree+organizationIds`、`certificate/training=has_any+standardIds`、`insurance=covers_activity`（无 `valueJson`）和 `age=between+minYears/maxYears`（可单边、数组去重）；作用域双向复合 FK、版本/active NULL 去重与冻结快照合同已落。统一 evaluator 与 display/submit/review snapshot writer 已接 App detail、canonical submit、managed onsite 与 approve；managed `GET/PUT qualification-rules` 仅对 draft 全量替换、canonical no-op 零写，initial 与显式 `qualificationRuleSets` change review 以 V5 冻结，审批才激活/退役 RuleSet；published direct PUT 固定 `20037`。
> **#23（第 84–87 migration + 第 4 批⑫–⑯）**：`Activity.allocationModeCode` 是每活动唯一权威标量，DB 仅接受 `first_come/qualification_rank/lottery`；存量/旧 server 仍兼容 default，新 Admin/App create 必须显式选择，draft 可改、published 走 change review。v4 发布快照纳入 mode，v1/v2/v3 历史行为不漂移；Activity 根锁内所有写入口对历史 batch mode 不一致返回 `409/20152`。D85 冻结算法版本、候选/资格哈希、server seed commitment/reveal、永久头/revision/acceptedAt 与稳定顺序；D86 增三阶段 immutable receipt、void 事实和 committed applied projection；D87 把 Candidate 与 batch/候补岗位复合锚定，并把 waitlist rank 从全 batch 改为 batch+position 分区。第 4 批⑯已实现 replay/hash 复算/20147、按场次 first_come、rank/lottery 执行、容量和同岗位候补 caller；第 4 批⑲已将 legacy writer 收窄到无 identity 的兼容头，canonical 候补仍不走它。
> **#24（维护者 2026-08-09 已裁定，实施待后续 caller）**：`capacityReservationId` 固定指向 session reservation；释放清空，不一致为 20147。
> **#25（维护者 2026-08-09 已裁定）**：visitor `attendanceCode` 恒为 null，且无写入口。
> **#27（维护者 2026-08-09 已裁定；第 82 migration + 第 4 批⑩已兑现）**：每次报名/重报的保险 evidence 绑定当次 `ActivityRegistrationRevision`；旧 header-only evidence 不改不回填。第 82 以 nullable composite FK + legacy/revision 两类 partial unique 落兼容地基；runtime producer 已写当次 revision，approval 对 currentRevision>0 只认对应 evidence，currentRevision=0 才兼容唯一 legacy NULL evidence。上线须 drain→独立 deploy D81/D82+探针→保持 drain 切整批 runtime exact SHA，禁新旧混跑或旧版回滚。
> **#28（第 7 批第 ②-a 刀登记，未裁定 —— 留白，不是违反）**：§3.22 只规定了**分录级**可见性
> (「准备中和 ready **分录**必须对所有正常读面不可见。只允许通过 `batch.statusCode='committed'`
> join 后读取。」),**对「账本聚合口径能不能统计未 committed 批次」全合同没有表态**。
> **为何不构成冲突**:②-a 新增的 `LedgerQueryService.sumInFlightTotalsForMember` 返回的是
> **标量小计**——SQL 里只有两个 `COALESCE(SUM(...))::text`,零 entryKey、零 ledgerDate、
> 零逐条金额,调用方拿不到任何可枚举的行;三条分录读面仍是全仓唯一出口且仍钉死 committed
> (代码 7 处 committed 过滤一处未改,执行位在 `activity-batch7-in-flight-display.e2e-spec.ts`
> 不变量 3 / 3b)。⇒ §3.22 管的是分录、本刀给的是聚合,两者不相交。
> ⚠️ **本条不主张「活文档拍板可以压过冻结合同」** —— 覆盖冻结稿的正式机制只有修订件
> (`AMENDMENTS-v1.1.1.md` 即此范式);本条是登记**留白**待合同方定稿,不是自行裁定。
> 关联:AC-054(「页面和统计只能看见 0%/100% 的正式结果」)约束的是**正式结果**原子性,
> 已生效那一轴仍只有 0%/100%,在途轴按定义不是正式结果;但 `preparing` 期间分录逐条 INSERT,
> 故在途小计在准备期会逐步长大,做 10000 人规模用例时须按轴分别断言(已写进 AC-054 blocker)。

> **账本读面权限口径（维护者 2026-08-06 拍板）**：复用 `attendance.read.sheet`；合同 §6.11
> 未规定，若日后要收紧需另立权限码 + 三处 seed spec 连坐。
>
> **第 1 批五刀**(全部 expand-only、零 runtime、零端点):
> [#911](https://github.com/BA7IEE/srvf-nest-api/pull/911) 场次/岗位/参与身份/容量(71)·
> [#912](https://github.com/BA7IEE/srvf-nest-api/pull/912) 报名表/资格/邀请(72)·
> [#913](https://github.com/BA7IEE/srvf-nest-api/pull/913) 打卡/证据(73)·
> [#914](https://github.com/BA7IEE/srvf-nest-api/pull/914) 结算/账本/更正/关账/任务(74)·
> [#915](https://github.com/BA7IEE/srvf-nest-api/pull/915) 分配/志愿/候补/预留名额(75)。
> **两组 append-only trigger**(`AttendancePunchEvent` / `ParticipationLedgerEntry`),
> 四条判据含「**TRUNCATE 放行且 trigger 存活**」—— 挡住即 e2e 地基塌方。
> 39 张新表**零调用方是预期状态**,消费方自第 2 批起。
>
> **第 2 批代码面切片（⑧b 前九刀 + ⑨a / ⑨b / ⑩ 收尾）**:
> [#917](https://github.com/BA7IEE/srvf-nest-api/pull/917) 北京日历收口 + 封场算法 ·
> [#918](https://github.com/BA7IEE/srvf-nest-api/pull/918) 结算草稿生成 + 服务段重建 ·
> [#919](https://github.com/BA7IEE/srvf-nest-api/pull/919) 提交不可变 `SettlementVersion` ·
> [#920](https://github.com/BA7IEE/srvf-nest-api/pull/920) 结算一审/终审 ·
> [#921](https://github.com/BA7IEE/srvf-nest-api/pull/921) 账本分块准备 + 短事务统一生效 ·
> [#922](https://github.com/BA7IEE/srvf-nest-api/pull/922) 机器关账 ·
> [#923](https://github.com/BA7IEE/srvf-nest-api/pull/923) 更正应用 ·
> [#924](https://github.com/BA7IEE/srvf-nest-api/pull/924) 账本自动提交者 + worker 接线 ·
> [#925](https://github.com/BA7IEE/srvf-nest-api/pull/925) 结算 HTTP 入口(7 端点 / 5 权限码)。
> ⑨a 负责人结算工作台 · ⑨b 审核／账本读面 · ⑩ 结算审核入口层 `ActionConstraint`（本分支，待 PR CI / `harness-review`）。
>
> **第 2 批验收回填（⑩ 复核）**：0 条已转真用例 / 10 条已标注去向 / 18 条仍 todo = 28。
> 本刀强化 AC-053 的入口层／锁后层独立短路探针；未出现新增可覆盖的 ADV，已知合同缺口 #6–#10 仍原样（#11/#12 见下方第 3 批裁定）。

> **第 3 批第一刀（已合 main #952，草稿地基）**：App `managed-activities` 建草稿、草稿 PATCH/DELETE、
> `sessions` 与新表 `ActivitySessionPosition` 的嵌套 CRUD 已实现；所有直写以
> `statusCode !== 'draft'` 正向白名单收口，published 返回既有专门码
> `ACTIVITY_CHANGE_REVIEW_REQUIRED`，跨 activity/session/position 与非发起人一律
> `ACTIVITY_NOT_FOUND` 式隐藏。草稿锚定 `Activity.initiatorMemberId`，**零写
> `ActivityResponsibilityAssignment`**；既有发布链仍在发布时创建 active owner，未改。
> 三枚 revision 计数器写次数恒 0 的 transaction spy、正对照和新表 CHECK/P2002/P2004
> 映射均由独立测试锁定。为保持已冻结的既有 App POST 行为，旧负载缺省时仅在服务端收敛为
> `open_apply / internal / false`，新落库行仍不留空值。
>
> **第 3 批①.5（本分支，模板／快照 schema）**：仅新增 `ActivityTemplate` / 不可变
> `ActivityRuleSnapshot`，以 `(code,version)` 和 `(activityId,workflowRevision)` 锚定版本，
> 以 DB trigger 禁 snapshot `UPDATE/DELETE`（TRUNCATE 保持放行）；补
> `ActivityAllocationBatch.ruleSnapshotId` 可空 FK，以及 §10.3 闭集内发布提交、审核、取消、
> 提前终止的 key/hash 落点。零 seed、零回填、零 endpoint、零 runtime；模板解析／消费仍归第二刀。
>
> **明确不做的接缝**：①.5 已补 `ActivityTemplate` / `ActivityRuleSnapshot` 两张缺表，
> `template-resolution` 与 `templateId` 仍归第二刀；发布/变更 proposal、删除 `directPublish`
> 归第二刀；cancel/terminate/clone 归第三刀；registration form/qualification rules 归第四批。
> §3.5 的 `draft_editor` 七值责任模型及两布尔退场另立 **D 档责任模型刀**；在它落地前仅发起人
> （及 SUPER_ADMIN 兜底）可编辑草稿，不能用伪 collaborator 行占位。
>
> **第 3 批验收回填（第一刀）**：2 条已转真用例 / 2 条已标注去向 / 17 条仍 todo = 19。
> AC-001、AC-002 已分别绑定真实发起人/代建审计与跨组织授权证据；其余 todo 的逐条卡点见
> `activity-business-overhaul-acceptance.spec.ts`，其中模板两表已落、解析项仍卡 **第二刀读面**。
>
> **第 3 批第二刀（本分支，发布 proposal／审批闭环）**：App 初次发布与关键变更统一在
> Activity 锁内重建 canonical 快照；变更请求覆盖 Session／Position 的 create/update/cancel 完整集合。
> 审批重锁并比对 `workflowRevision + snapshotHash`，同事务按固定顺序应用 Activity → Sessions →
> Positions → 第 4/5 批显式空占位 → population revision，并为每次通过写入一条不可变 RuleSnapshot。
> 旧 direct-publish 兼容入口只会创建 pending review，绝不直接 approved；已发布根 PATCH 仅保留显式
> 展示白名单，其余关键变更强制走 change review。Form/Rules、capacity 桶、QR 与收件人冻结仍未实装。
>
> **第 3 批验收回填（第二刀）**：5 条已转真用例 / 5 条已标注去向 / 14 条仍 todo = 19。
> AC-006、AC-007、AC-008 分别绑定自审禁令与退回幂等、directPublish 封死、锁后 stale CAS；AC-009、
> AC-010 仍因表单/资格、容量桶/二维码/通知/结算接缝保持 todo。
>
> **第 3 批第三刀（本分支，生命周期／队员读面）**：App 负责人锚新增首场开始前的
> cancel（沿 v0.62.0 既有取消闭环，cancelled/null 终态语义不变）与已开始 published
> 活动的 terminate（服务端 `terminatedAt`）；两者分别复用 ①.5 的 key/hash 落点并各自
> 做同 key 同载荷重放、异载荷冲突。clone 仅复制活动配置、场次和 `ActivitySessionPosition`
> 到新 draft，发起人固定为操作者，事实表零写；机器封场 HTTP 层透传既有 `seal()` 结果。
> App 根列表和详情仅向队员投影 published，`invitation` 需本人 pending/accepted 邀请，未获邀及
> draft/cancelled/terminated 均为 404 式隐藏；详情的 `formVersion` 本刀恒为 null。
>
> **第三刀 AC／接缝登记**：AC-003（clone）已由配置复制与事务事实表零写 spy 真用例接住。
> AC-004 的准确卡点为**归档端点尚未排批，且没有 `archivedAt` 等事实列**，本刀不建端点或
> 占位；其余验收项仍按原分区守卫计数，不翻面既有断言。`completed` 仍保留既有 21 个依赖面
> （含 feedback 资格窗），本刀只加 `terminated`；报名／邀请申请与真实 formVersion 绑定归第
> 4 批。clone 的 operationKey 因 §10.3 闭集与存储均无落点，按缺口 #15 不接收、不伪造。

> **第 4 批③（[#961](https://github.com/BA7IEE/srvf-nest-api/pull/961)，Form runtime / 一次性附件会话）**：managed Form 定义、draft/active 版本、初发/变更审核/clone 与 App detail 安全读面已接通；v3 proposal 把 canonical Form 纳入 stale hash，历史 v2 审批逐字兼容。附件会话只存 token SHA-256、创建响应明文仅一次；后端中转 multipart 固定 JPEG/PNG/WebP/PDF、10 MiB、单会话单附件和安全重放，不返回 provider signed upload URL 或内部存储字段。

> **第 4 批④（[#962](https://github.com/BA7IEE/srvf-nest-api/pull/962)，报名命令主链）**：App canonical `POST /api/app/v1/activities/:activityId/registrations` 已在 Activity 锁内完成 D-5 重验、Form/八题型答案、session/position、一次性附件与 immutable registration/participation revision 链；同 key+hash 在 consumed session 前安全重放，不同 hash `21003`，附件最终转内部 `registration-form-answer` owner。旧 App/Admin create 在 v1.1 live session 或 active Form 统一 `21038`，没有后台代报名/导入替代口；canonical pending 不占容量。第 81 migration 已落全局永久 `ActivityRegistration` 头唯一；第 4 批⑩补取消/拒绝后的同头复用与 revision-bound evidence。
>
> **第 4 批⑤（[#964](https://github.com/BA7IEE/srvf-nest-api/pull/964)，发布审核容量桶真实投影）**：已 squash merge 至 main `a6904b84e8077cbeb20b6234ec23cd07fb763d4a`，final-main CI [31252496260](https://github.com/BA7IEE/srvf-nest-api/actions/runs/31252496260) success。`ActivityCapacityBucketProjector` 在既有 Activity → review 锁序内、Form/Rules 后且 QR/population revision 前，重读已应用的 Activity / scheduled Session / live Position，稳定投影 `activity_person`、`session_participation`、`position_participation` 三类目标桶；不建 `reserve_group`。缺桶仅建 `occupied=0/version=0`，同容量零 UPDATE，变容只以锁后 CAS 递增 version 一次；任何 `occupied` 与 active `CapacityReservation` 数量漂移、错误锚定、历史取消 scope 仍有占用、或降容低于占用，均以 `20147` fail-closed 并回滚整笔 approve。新桶仅初始化 `occupied=0`；既有 `occupied` 不修改、不增加、不减少、不重算；生产代码零 `CapacityReservation` DML，占位/释放留下一刀。
>
> **第 4 批⑥（[#965](https://github.com/BA7IEE/srvf-nest-api/pull/965) 已合 main，CapacityReservation 内核）**：`CapacityReservationService` 只接 caller 提供的同一外层 transaction，固定 `Activity → identity(id ASC) → bucket(scopeTypeCode,scopeId,id) → active reservation(id ASC)`；预检三层 bucket/active 行对账后，reserve 以 `activity_person`（活动按 member 去重）＋每个 identity 的 `session_participation`＋可选 `position_participation` 原子占位，release 先释放 position/session，最后一个 active session 才释放 activity-person。有限容量不足仅返回稳定 `capacity_unavailable`，其余不可解释形态/CAS miss 均 `20147` fail-closed；只写 `CapacityReservation` 与 bucket `occupied/version`，零 `CapacityReservation` 以外的报名状态、pointer、revision、audit/outbox DML。新 activity-person 取本批稳定排序的最小 identityId 作锚，已有锚保留至最后释放。⑧已将其作为 managed onsite caller 接入；第 4 批⑯已接 canonical first_come 与 allocation caller，仍不把旧 approve/legacy waitlist writer 混入本刀。

> **第 4 批⑦/⑯（邀请与分配 runtime）**：managed create/list/revoke、本人 decline 与过期 pending 可见性已接；访客真实 HTTP E2E 对报名、参与、预留、考勤、服务段、结算、账本、贡献、批任务前后快照均零串入，AC-027 转 destination。AC-019 的 accept 已接，且复用 canonical 资格、保险/容量 caller，不留邀请旁路；活动开始批量 expiry 仍归 AC-028。
>
> **第 4 批⑧/⑪（managed 现场临时参加 + 资格 runtime）**：新增 `POST /api/app/v1/my/managed-activities/:activityId/onsite-participations`，只走 D-5 + `activity-registration.create.record` + 当前活动 active `canManageRegistrations=true` 三重门；Activity 根锁后先重读 actor D-5/责任，新事实固定锁序为 Activity → 同一 member/activity 全部报名头（含 soft-deleted）→ member/activity 全部 identity → session/position/requirements/保险 → 三层容量 → revision/pointer → population → audit。无历史头才建新头；第 4 批⑩起 live cancelled/reject 头和 identity 可同头复用，soft-deleted 仍 21030。精确同 key+hash 旧成功回执在 D-5/责任复读后、mutable finality 闸前返回；仅新 key 在 `now > endAt`、posting/posted/current posted/active closure 时 21030。Form 含字段仍为 21039；合法 active RuleSet 已接统一 evaluator，block=21040 零写、warn 可继续，空/重复/错配 RuleSet=21041。canonical submit 与 approve 同样在锁内按最新事实重评；legacy 只要存在 active 场次/岗位规则仍为 21038，绝不猜场次；**旧 legacy pending 在创建后才激活 scoped RuleSet 且仍无 identity/preference 时，approve 同样 21038，绝不猜目标，registration/audit/outbox/snapshot 均零写。** **第 4 批⑪保守工程裁定**：aggregate=fail（包括 detail display）不追加任何 snapshot；display/submit/review 只在 aggregate pass 或 warn 后追加不可变 snapshot；block 请求不创建报名头、revision、identity、snapshot、容量、audit 或 outbox，display 同一次命中 RuleSet 只写一份。仅 single gate=true 且活动 `requiresInsurance=true` 时，每次成功报名/重报均重验并写当次 revision evidence，否则保持 0 evidence。容量不足 21032；session reservation↔pointer/桶锚/当前 revision 任一漂移均 20147。Form 现场补录仍未做；邀请 accept、分配与同岗位候补排序已由第 4 批⑯接通，AC-019、022、023 翻为 runtime 证据待冷 CI 裁决。

> **第 4 批⑩（永久报名头 runtime + 参与投影闭环）**：legacy/canonical/onsite 首报及 cancelled/reject 重报均复用唯一 head；有 session 的流程复用唯一 identity，追加不可变 Registration/Participation revision 并以 CAS 推 current pointer。canonical/onsite 从 legacy 头切源时清旧岗位/extras并刷新报名时间。报名/重报 evidence 精确绑定当次 RegistrationRevision；approval 只审核当前 revision。onsite pointer 固定为 active session reservation；cancel、reject、reopen 均在同一 Activity 事务核三层容量、pointer/current revision/status-population，按动作释放容量、追加 ParticipationRevision、清或恢复 current projection；人口真变化只 bump 一次，reject/reopen 同步 summary=`not_selected/active`，审核动作不新增 RegistrationRevision/evidence。十轮 managed cancel→onsite 重报终态为 head/identity 各1、两类 revision/current pointer/populationRevision 各21、evidence11、reservation 历史33（active3/released30）、三桶 occupied1/version21；双 pool replay/竞争无部分写。**第三刀收口**：`ActivitiesService` 整单 cancel 已在 Activity 根事务内接 canonical lifecycle helper；只关闭 pending/waitlisted、追加 immutable revision/CAS 投影，pass 与 active reservation 留作历史。旧 `activity-waitlist-promotion` writer 仅服务无 identity 的 legacy header；本刀不搬/复制 capacity 原语，也不宣称 canonical approve 已接资格/岗位分配。
>
> **第 4 批验收回填**：AC-016、AC-029 已各有真实 canonical App E2E；AC-017 继续 todo（后台代报名与导入未接入）。ADV-017 已绑定 activity/session 降容 HTTP 针；AC-019、AC-022、AC-023、AC-024、AC-025 已由 `activity-batch4-allocation-runtime.e2e-spec.ts` 的真实 HTTP/PostgreSQL destination 覆盖，最终仍须冷启动 CI 新库裁决；AC-026/027 已有 managed onsite/访客真实 HTTP destination。AC-021、ADV-005 已绑定十轮永久 head/identity/revision/capacity/pointer/population/evidence 完整链；**AC-018 已翻为 `activity-batch4-qualification-runtime.e2e-spec.ts` 的真实 display/submit/onsite/review destination，最终只能由冷启动 CI 新库裁决；旧 `app_test` 的 23514 不是绿。** AC-028、ADV-014 仍 todo。

> **第 4 批⑫（分配方式显式选择、发布快照冻结与父子一致性）**：新建/草稿/读面、v4 proposal 与历史 v1/v2/v3 兼容、`20152` fail-closed 和两套 Nest/Prisma pool 的根锁交错均已落真实测试；第 4 批⑯在该模式根锁上接入 first_come、资格排序、抽签、candidate、capacity caller、候补排序与递补。资格配置/发布激活和既有 legacy writer 不在本刀扩大。

> **第 4 批⑬（D85 可重放分配合同地基）**：双表空库门、两条同头复合 FK、64 位小写十六进制 hash/seed、算法版本、acceptedAt、score/result/rank/tie-break/explanation 形状与同批唯一顺序已由真实 84→85、空库重放、非空 fail-fast、late rollback 和五组独立变异锁定。第 4 批⑯用真实 HTTP/PostgreSQL 写路消费该地基，AC-022/023/025 的 cold-CI 结论留本 PR。

> **第 4 批⑭（D86 command 精确回执、作废事实与 committed applied projection）**：D85→86、空库重放、nonempty count-only fail-fast、late rollback、11 组独立变异锁定 receipt key/activity-batch FK、void shape、projection 一对一/candidate anchor/allocated pointer-reservation/inactive residual/identity-member anchor/activity-person member-activity anchor/session identity anchor/immutable。真实 DB 正例已证明同一 member 的两个 session identity 共用一条 activity-person reservation、各自保留 session reservation；错 member/错 activity 均精确 `23503`。physical constraint 名均实测 ≤ PG 63 bytes。DB 边界明确：receipt JSON 仅安全固定 envelope；第 4 批⑯在 Activity 根锁事务中完成 canonical SHA-256 重算、same key/hash 回放、异 hash 拒绝及 Identity live pointer/Batch committed/Candidate/Revision/reservationType 复核，并开放 5 条 canonical endpoint；AC-022/023/025 的最终判定仍留 cold CI。

> **第 5 批（本分支，自助二维码和现场主链）**：复用已存在的 `AttendanceQrCredential`、`AttendancePunchEvent`、`ActivityEvidenceState`、`EvidenceSeal` 与服务段 revision 地基；负责人可签发、作废、受保护渲染场次 QR，本人可扫码签到/签退并读取安全服务段状态，责任人可早退闭合、void、replace。QR token 仅为请求输入，render 只返不可缓存 SVG；所有写命令走 Activity 根事务、canonical request hash 与 append-only PunchEvent/segment projector。第 5 批只覆盖 AC-031–042、AC-046、ADV-001/002/004/005/006/007/020，不带入工作人员代扫、代理、批量、导入或离线（第 6 批）。
>
> **第 6 批收口刀（读面 + 验收接通）**：补齐合同 §6.13 后台任务统一读面 5 端点(Endpoint 532→537),
> 判权按 `job.activityId` + 当前责任范围、越权与不存在同码 40400、重试与取消在事务内取责任行
> `FOR SHARE` 重新判权;`retry-failed` 只动 failed 项并同额扣减 job 计数,`cancel` 拒绝
> succeeded/cancelled/dead。五条不变量各有独占变异红集(M1×不变量1、M2×不变量2 对角线成立)。
> 验收接通:ADV-003 / ADV-023 转真用例(既有同名/近似用例经复核**不满足合同口径**,详见
> `activity-business-overhaul-acceptance.spec.ts` 的第 6 批注释),ADV-013(六子形态)/ADV-014
> 标注去向,ADV-009 复核确认第 2 批已接通且口径正确、保持原样。另补一条接线守护:
> 登记表没接进查表链会让编号**静默退回 todo**、整套仍全绿,现已成为可失败判据。
>
> **第 6 批（B6-2 子刀，尚未整体交付）**：B6-1 的成员凭证、`staff-scan`、`proxy-punch`、bulk 与 CSV import 已接真实 PunchCommand/Activity 根锁/责任重验/worker lease-fence；B6-2 按补充合同 v2 接入 package issue/revoke/单事件 upload、安全 review list/approve/reject。packageToken 仅首次签发与精确重放返回，正式离线事件继续复用唯一 PunchCommand；22097 零写，22098/22099 只 staging。PR/CI/独立核验/合并状态必须按对应 exact SHA 另行核对；不得写成完整第 6 批或部署完成。
  **✅ 2026-08-28 代码面收口宣告（D13，转换刀同刀核对）**：逐项实证 —— 22097–22099 段位
  在册（biz-code「第 6 批 offline/import 专用四码」）；staff-scan / proxy-punch 在
  `app-managed-activity-onsite-operations.controller.ts`；OfflinePackage 服务族
  （access / writer / punch-command / request-hash）齐；专属 e2e 三份
  （`activity-batch6-offline-writer` / `activity-batch6-staff-import-offline` /
  `activity-v11-batch6-staff-import-offline-schema-constraints`）随 main 的
  Contract + E2E 分片恒绿（#1211 CI 亦全绿）。**代码与判据面自此宣告第 6 批收口；
  部署仍未发生（生产未部署任何 v1.1），§16.3 顺序不变。**

- **合同**:[`archive/reviews/activity-business-overhaul-v1.1/`](../archive/reviews/activity-business-overhaul-v1.1/README.md) 四份共同生效
  (业务方案 / 详细开发文档 / 355 项追踪矩阵 / 修订说明),SHA256 入仓时原位校验全过。
  维护者 2026-08-03 下发,基线为 `0.66.0` 快照(`47c4987514fef3772efb95a78adcd73dbd81c89c`)。
- **合同自述状态**:业务合同 GO;详细开发合同「**有条件 GO** —— 仓库预检 + 维护者授权后开工」。
  12 项一级阻断的修正方案、AC-001..072 + ADV-001..023 已写死在合同里。
  开发文档 §3 以小节标题定义 **42 个具名数据对象**(亲核:逐个与 `schema.prisma` 比对,
  其中 `Activity` / `ActivityRegistration` 两个是**改既有表**,其余 40 个当前仓内不存在)。
- **第 0 批 ✅ 全部交付**(2026-08-03/04):合同入仓 [#905](https://github.com/BA7IEE/srvf-nest-api/pull/905)
  · AC/ADV 编号骨架 #905(95 条 `it.todo` 由合同原文解析生成 + 5 条合同完整性断言,逐条变异验证)
  · **10000 member lock 短事务可行性原型 [#906](https://github.com/BA7IEE/srvf-nest-api/pull/906)**
  (探针 `scripts/probe-member-lock-scale.ts` + 报告 [`lock-probe`](../archive/reviews/activity-business-overhaul-v1.1-lock-probe.md))。
- **原型判词:时间预算这一条通过。** 10000 人在现有 7 秒预算内稳定完成 —— 360 轮零失败,
  整事务 P95 **197.7ms** / P99 **286.8ms**(约 24× 余量);终写占 70%,advisory 取锁只占 8%
  ⇒ **万人 member lock 本身不是瓶颈**。未改任何预算常量、未改 `lockMembersForWrite` 本体、未建新锁域。
  ⚠️ 读数取自**零锁竞争**、**单日账期**、**合成表**;7s = 4s 锁等待 + 3s 业务工作,测的是后者。
- **⛔ 第 1 批 schema lane 开工前的三条(主会话已逐条独立复核,不是转述)**:
  1. **【已有解,不必再拍板】bind 参数上限 = 32767(Prisma 查询引擎,非协议 65535)**。
     ⇒ 逐行 `VALUES` 写法下 day-state 批量 UPDATE 每人 4 参数即 **8191 < 10000 确定性失败**。
     **出路已实测可行:改 `unnest($1::text[], $2::timestamptz[], …)` —— bind 参数恒为列数、与人数无关**
     (主会话独立复核:10000 / 30000 / 100000 行均通过,连带解决跨天活动「行数 = 人数 × 天数」的放大器)。
     分块写与本仓「SQL 次数固定」批量化判据冲突,**不取**。第 1 批照 unnest 写即可。
  2. **【必须拍板】共享锁表容量**。advisory 锁占 PG **共享**锁表,公式保底
     `max_locks_per_transaction × (max_connections + max_prepared_transactions)` = 64 × 200 = **12800**
     (主会话查 `pg_settings` 核实);一场万人生效实占 **10000 把**(主会话在 10000 规模上数 `pg_locks` 证实),
     占保底 **78%** ⇒ **两场万人并发即越过文档保证线,三场必然 `out of shared memory`**
     —— 那是硬 ERROR,**不走 `lock_timeout` → 55P03 → 40901 的可重试路径**。
     三条候选:①提高 `max_locks_per_transaction`(生产库配置 + 重启,运维决策)
     ②接受「同一时刻只允许一场万人活动统一生效」的业务约束 ③重新设计锁粒度(动合同)。
     ✅ **已定:采用 ②(2026-08-04)**。**决策来源要说准** —— 维护者当日明示
     「我看不懂呀,你建议怎么做就怎么做」,即**授权按 AI 推荐执行**,不是维护者独立比选后拍板;
     后来者若要重开这条,不必把它当既成事实,按下面的理由重新评估即可。
     理由:本队真实规模远低于万人(合同 §13 规模门里 30 人是真人档,500/2000/10000 全是模拟),
     两场万人同时结算在可预见期内不会发生;而 ① 要动生产库配置并重启、③ 要动合同,
     ② 零成本且**可逆** —— 将来真需要并发万人生效时再走 ①,那时本条作废。
     ⚠️ **② 必须带执行位,不能只写成文字约束**(本仓核心原则:能做成机器检查的不要只写成要求)。
     纯散文的「同一时刻只允许一场」等于没有约束 —— 第二场照样能开始,然后在
     `out of shared memory` 上炸掉,而那是不可重试的硬 ERROR。
     执行位的具体形态(全局 advisory 互斥键 / 按人数阈值触发 / 锁预算信号量)**留给第 2 批
     账本关账的实施 goal 设计**,本条只钉死「必须有」。设计时注意:简单的人数阈值 T 并不严格
     成立 —— 4999 + 8000 两场都在阈值下却合计 12999 > 12800,判据得按**并发总量**而不是单场人数。
  3. **【另立 goal】`hashtext` 碰撞造成取锁反序 = 真实死锁边**。`lockMembersForWrite`
     按 `ORDER BY member_id` 定序但锁键是 `hashtext(member_id)`,**排序键 ≠ 锁键**:
     存在 a<c<b 且 key(a)==key(b) 时两批次反序。已用真实碰撞对显式交错**实测触发 40P01**,
     自然并发 60 次未复现 ⇒ **结构隐患非活 bug**。碰撞率 10000 人 **0.90%**(理论 1.157%),
     但**今天代码最多锁一张考勤单 200 人 ⇒ 碰撞概率 ≈ 0.00046%,对现有代码近似为零**
     ⇒ 不急,但万人落地前必须先修(改按锁键排序,或对 40P01 补有界重试;
     40P01 目前不在 `withBoundedMemberLockWait` 的翻译范围内)。
     ⚠️ `member-advisory-lock.util.ts` 注释里「两层同向 ⇒ 不会反向取锁」的论证**在碰撞下不成立**。
     合同 §16:另立 goal 改,不在活动 PR 顺手改。
- **未解锁项(AI 不得自启动)**:第 1 批起每批新 schema / migration / Permission seed 均落
  `current-state` §3「暂不启动清单」的评审解锁制,**合同 GO ≠ 该清单自动解锁**,逐批人话简报 + 拍板。
- **已知行为契约冲突**(实施期逐条走 §4.1 简报,禁止在实施 PR 内顺手改断言):
  删 `directPublish` 成功路径 · 普通签退 36 秒 → 30 分钟 · 终审从写 `approved` 改为提交
  `LedgerPostingBatch` · 统计读面从实时 approved 改为 committed batch。
  **⇒ 维护者 2026-08-19 拍板:「改口径 + 加在途显示」**(第 7 批第二刀)。
  影响面(主会话实测):7 个端点 —— `app/v1/my/participation-summary` ·
  `admin/v1/members/:id/{participation-summary,contribution-summary,attendance-records}` ·
  `admin/v1/activities/:id/{participation-summary,reconciliation,participation-ledger}`;
  四个数字(总服务时长 / 参与活动数 / 记录条数 / 贡献值)取数从
  `attendanceRecord + sheet.statusCode='approved'` 改为 committed 账本分录。
  **⇒ 2026-08-19 二次拍板(主会话查出连坐后追加):切成两半。**
  **②-a 先只加「在途」显示,不动任何取数**(零风险,用户先看得见);
  **②-b 真正切换取数口径 —— 另需拍板,因为它会连坐「入队资格」**:
  `computeCappedContribution`(`team-join/team-join-progress.ts:77`)被 team-join 用来判
  `satisfied: points.gte(CONTRIBUTION_THRESHOLD)` ⇒ 改口径后贡献值变小,
  **原本够门槛的申请人会突然不够,是资格判定翻面而非显示问题**。
  **拍板:入队门槛恒按「已审批考勤」算**(2026-08-19)——
  入队审核关心「这个人真的参与了多少」,结算入账走多久是队内财务流程,不该拖累申请人。
  ⇒ **同一个「贡献值」两个场景两套口径是刻意的**:展示用账本(严谨),资格用考勤(不误伤)。
  ⚠️ 后人若见此不一致,**先读本条再动手** —— 那不是 bug。
  ⚠️ 落差不是几秒:审核通过 → 结算生成/提交 → 一审 → 终审 → 批次 preparing/ready → committed,
  每步都可能停在人手里数天 ⇒ **队员会看到「考勤批了但时长不涨」**,故须同时给出
  「已生效 / 在途」两个口径,**数字不合并、但让人看得见**。
  **⇒ 2026-08-19 三次拍板(②-b 交付方实测出前提不成立后):②-b 暂不换源,并入
  「终审改为提交 `LedgerPostingBatch`」那一刀,读写同批翻面。**

  **⇒ 2026-08-27 四次拍板(桥形状,维护者「按推荐」= A 案)**:闸关期间 runtime 零改动;
  §16.3 停写窗口内一次性「存量账本化」转换刀(D 档)为存量 approved 合成 v1.1 事实链
  并提交真账本批次;②-b 四数字换源随闸翻面。双写案(B)被锚点证据否决 ——
  `LedgerPostingBatch.settlementVersionId` 必填、分录锚 `(activityId,sessionId,memberId)` +
  identity + resultRevision,而 `AttendanceRecord` 无 sessionId / identity / resultRevision;
  读面并集案(C)不达合同终态「统计只读 committed batch」。评审稿草案(锚点证据 +
  设计决策 D1–D13 + SOP 集成,未冻结):[`LEGACY_LEDGER_CONVERSION_DRAFT.md`](LEGACY_LEDGER_CONVERSION_DRAFT.md)。
  P0 基线复跑(本机 Docker PG,`9c8be487`):`activity-full-chain` + `attendance-final-approve-*`
  3 套件 11 用例全过。
  **⇒ 同日两问两答签收(维护者逐项「按推荐」)**:Q1=D1 场次归属(时间窗 + 最早 live 场兜底 +
  兜底记标记,分数时长不动);Q2=D2 无报名头存量(补「历史转换」来源报名头,非真报名)。
  其余 D3–D13:D3 为实施首日技术复核点(失败即停上报),D4–D13 按保守工程裁定自理
  (可逆、不改业务语义、逐条写进实施 PR)。设计自此定稿,施工依据即该稿。
  **2026-08-28 实施前取证(施工面缩小)**:①②-b 换源**已交付** ——
  `participation-summary-query.service.ts` 已闸控取数(闸关 approved / 闸开 committed,
  贡献值恒 approved 封顶,C4),D10 剩余为零、不变量 2 spec 无需改;②封顶碰撞消解 ——
  转换分录 `recognized=原始日和 / credited=min(日和,3) / cappedOut=超出`,不改任何用户可见数字,
  DB magnitude CHECK 恰好承载该形状。P2 characterization 基线:`attendance-sheet|attendance-record`
  28 用例全过。剩余施工面 = 转换刀本体 + CLI + SOP + 判据。

  **✅ 转换刀已交付([#1211](https://github.com/BA7IEE/srvf-nest-api/pull/1211),2026-08-28 合入,CI 17/17 全绿含 Red-zone trusted)**:
  `LegacyLedgerConversionService` + `commitConvertedBatchWithin`(第五刀协议体逐字抽用,
  判闸位换转换窗口断言、跳过 settlement-posted 通知)+ 闸第三写方
  `assertLegacyLedgerConversionAllowed()`(20159,三态:常规闸关拒/闸开拒/只读维护窗放行)
  + CLI(`scripts/legacy-ledger-conversion.ts`,幂等 requestKey)+ SOP
  (`docs/ops/legacy-attendance-ledger-conversion.md`)+ e2e 三用例(三态闸/转换本体含
  6.50→3.00+3.50 封顶分账/幂等重跑零新增)。D2 建头经归属域导出
  `LegacyConversionRegistrationHeadService`(架构债棘轮判红后的正确解法);C2 收编
  `callsConversionAssert` 第三判闸位(红区令牌,v11/legacy 判据零放宽)。
  **2026-08-19 那座「终审改为提交 LedgerPostingBatch」的桥自此闭合** —— 开闸前的仓内
  硬前置只剩 9a(验收 9 条 todo,全部 C 档能力缺口)与 §16.3 顺序本身。

  **⇒ 2026-08-28 六项拍板(维护者,合并 #1214 后一次回齐)**:① AC-009 永久豁免
  (D-1 结构性排除);② AC-067 永久豁免(拉取式即满足,推送归未来新 D 档);
  ③ AC-017 搁置(上线后按诉求立项,保持 todo);④ AC-010 改期刀开做(作废旧二维码重签);
  ⑤ P1-30 开工(基线重跑 #1214 已合,PR1 待专注起跑);⑥ 9a 读数 todo 8→6
  (AC-047 执行位 #1213 + 两条豁免;剩 AC-010 在做 / AC-013 / AC-020 / AC-025 / AC-017 搁置 / ADV-010 卡 P2-21)。

  **⇒ D1 悬案定案(维护者 2026-08-28 拍板「按推荐」)**:开闸后「参与活动数 / 记录条数」
  的账本口径 = **有 committed 分录的活动数 / 账本日行数(身份×北京日 去重)**;
  「记录条数」刻意**不**取分录条数(每人每日两条,开闸后会数值跳变)——这是与旧
  「考勤记录条数」最贴近的粒度,等价锚在 `legacy-ledger-conversion.e2e-spec.ts`
  (转换后 committed 计数 == approved 计数,逐人)。实现落点
  `LedgerQueryService.countCommittedParticipationForMember`(同 PR)。

  🔴 **实测结论:两条流水线目前人群完全不相交,换源不是「数字变小」而是「数字归零」。**
  交付方用**真实写链**各跑一遍(非静态推理,非直插夹具):

  | 探针 | 走的链路 | 已生效账本 | 已审批考勤 |
  |---|---|---|---|
  | ① | `activity-full-chain` 14 站全链路(发布→打卡→结算→终审→入账→关账) | 1 人 / 2 分录 / 3.75 h / 2.00 分 | **0 行**(连 `AttendanceSheet` 都是 0) |
  | ② | `attendance-final-approve` 真实终审链 | **0 行** | 2 人:2 条 / 2.00 h;3 条 / 3.00 h(分数为未封顶原始和) |

  两侧互为镜像 —— **没有任何一个队员同时出现在两侧**。根因:
  `settlement-draft.service.ts` / `ledger-preparation.service.ts` 读的是
  `attendancePunchEvent` 那一支,**零处读 `attendanceRecord`**;账本建表 migration
  (`20260804080000_...slice4_settlement_ledger...`)**无任何 backfill INSERT**。
  ⇒ 本条上面四条「已知行为契约冲突」里的**第三条(终审改提交 `LedgerPostingBatch`)正是那座桥,
  而它尚未实施**(`attendance-review.service.ts:345` 仍写 `pending_final_review → approved`)。
  **②-b(第四条)不能跑在第三条之前**:读面改去查一张生产数据从未进入的表,
  今天能看到服务时长的队员会全部变成 `0 / 0 / 0 / 0`。

  ⚠️ 连带订正两处 goal 前提:①「账本侧封顶已算完 ⇒ 只需换取数源」—— 封顶确实算完了,
  但换源换的是**人群**不是算法;②「committed 过滤三处」—— 实测基线是 **7 处**
  (②-a 不变量 3 已按 7 钉住)。
  ⇒ D1 里「参与活动数 / 记录条数在账本口径下如何定义」的悬案**一并顺延**:
  等写路径搬完再对着真实数据定,不在无数据时凭空发明语义。
  ⇒ ②-a 立的**不变量 2**(「四个数字整包不变,改成 committed 取数当场红」)是这条的执行位:
  将来真要换源时它会先红,提醒来人先读本条。

  **⇒ 第 ③ 刀已交付(2026-08-19):`ACTIVITY_V11_WORKFLOW_ENABLED` 单一 cutover gate**
  (合同 §16.2)。②-b 之所以「实测停工」,根因不是它自己做错了,而是**换读面本来就不是
  一把独立的刀** —— 它是这个总闸的第三项。闸开之前换源必然归零(上表两条真实写链人群零交集);
  闸开之后写路径全部改走新链,账本才有数据。故三项(新写放行 / 旧写拒绝 / 读面取数)
  必须同闸同轨,这正是合同「业务真相切换必须单轨」的意思。

  - **②-a 不变量 2 一字未改且仍绿**:该 spec 不设 env 覆盖 ⇒ 跑在闸关(默认)下 ⇒
    读面仍是 approved 口径,四个数字逐字不变。**反向闸继续有效** —— 它现在守的是
    「没开闸就别换源」,而不是「永远别换源」。
  - **闸控范围经拍板收窄为「结算真相链」**(Punch / 服务段 / 封场 / 结算 / 账本 / 关账 / 更正),
    **不含 Session / Participation / Registration**。实测理由:发布活动硬性要求 live session,
    而旧 AttendanceSheet 链只能在已发布活动上跑 ⇒ 连 Session 一起闸掉会让旧写路径也死,
    违反「闸关 = 今天的行为」。合同点名要防的「新打卡＋旧结算」两端都在收窄后的范围内。
  - **入队门槛与 `computeCappedContribution` 恒按 approved 算,不随闸切换**(维护者已拍板)。
    这条刻意的不一致由判据 **C4 反向闸**锁住:那两处文件一旦引用闸就红。
  - 尚未实施的仍是「终审改为提交 `LedgerPostingBatch`」那座桥;它与本闸互不阻塞 ——
    本闸只决定**读哪一侧**,那座桥决定**旧终审链是否往账本里写**。
- **排班约束**:schema-touching lane ≤1(合同 §14.1 与仓库 lane 协议一致);
  第 1、2 批未完成前禁止把二维码 / 批量代签 / 离线入口开放到真实环境(修订说明 §10)。

- **§16.1 第 ⑤ 条(五端同一 contract version)的两笔遗留** —— 2026-08-20 交付「客户端打戳 +
  回执登记表 + 5b 计算式取证指引」后剩下的部分。**5b 仍是 ⏸ 且本仓无法使其变绿**:
  它的证据必须来自别的仓库。
  - **(a) 运行时版本端点** —— 让生产上的后端自报正在提供哪一版契约,补上**部署期轴**
    (四端可以全编译在同一版,而生产还跑着上一版,纸面五方一致、实际照炸)。
    本刀未做的理由:要动 `src/` ⇒ 翻 `docs/ai-harness/ROUTE_AUTHZ.md` 的 inputDigest
    (`sourceFiles()` 递归全部 `src`)⇒ 红区令牌 + CI 环境审批;且 `src/` 目前**无处读
    `package.json`**,而 `start:prod = node dist/main` 使路径解析依赖部署形态;
    另注意 `apply-swagger.ts` 的 `.setVersion('…')` 被 `release-prepare.ts` 与
    `cutover-check.ts` 5a **两处正则**匹配,**不可**改写成共享常量。
    其价值要等 (c) 落地(有人轮询)才兑现 ⇒ 排在 (c) 之后更划算。
  - **(c) 各端 CI 自查** —— 各前端仓比对「自己引入的 client 戳」与后端 live 版本,不一致即红。
    **要改别的仓库,不在本仓职权内**,由维护者线下推动;推动前 (b) 登记表就是人工版替代。
  - 现状读数随时可查:`pnpm cutover:check` 的 5b(登记表在
    [`docs/handoff/contract-version-registry.md`](../handoff/contract-version-registry.md))。

#### 验收编号分拣(2026-08-24)+ A 档实施(2026-08-25;§16.1 第 ⑨ 条)—— **分拣不是清零,实施也不是清零**

`cutover:check` 的 A 类唯一硬失败是 9a(还有 `it.todo`)。

- **分拣刀(2026-08-24)**把「32 条待办」这个不可行动的数字,变成 **A 14 / B 4 / C 14 且逐条有依据**,
  并接通其中 2 条(证据已在、只差接线);todo **32 → 30**。
- **实施刀(2026-08-25)**把 A 档剩下的 12 条逐条动手:**写完 11 条**(全部连库跑绿 + 逐条变异对拍),
  **退回 1 条**(AC-063 → B 档);todo **30 → 19**。
  顺带查出一条运行中缺陷(`eligibilityCorrected` 在真更正链上恒 false,未修待裁定)。

⚠️ **9a 仍红,这是预期的** —— 只要还有一条 todo 就红,剩下的 19 条 = B 档 5 + C 档 14。
**数量不是目标,别为了让它变绿而硬写用例。**

> 🔴 **本刀查出的缺陷类:卡点说明会过期,而没有任何人回头重判。**
> 32 条里有 7 条写着「卡第 N 批 / 卡第 N 刀」,**全部写于对应批次交付之前**:
> 「卡第 3 刀 clone / archive / 邀请可见性 / cancel / 可见性组合」五条写于 `#952`(第 3 批第一刀),
> 而第 3 刀是 `#955`;「卡第 5 批最后一次合法签退 / 跨北京零点」两条写于 `#949`,第 5 批是 `#1032`。
> 另有 3 条(AC-019 / AC-060 / ADV-012)的卡点理由**今天是错的**,其中 AC-060 / ADV-012 写着
> 「卡合同缺口 #9 `requestedChangeJson` 结构」,而那个结构由 `correction-change-set.ts`
> (第 2 批第七刀 `#923`)补齐并生产接线 —— **它比那条卡点还早合入**。
> ⇒ 与 `#1166` 治的「活干完了台账仍写待办」是**同一形态**,换了一份台账。
> **本刀只订正卡点文本、不改判定口径,也不新建闸**(新判据要落 `scripts/check-*.ts` = selfGuard 红区)。

**A · 能写且不重(14)** —— **2026-08-25 实施刀已把其中 11 条写完并连库跑绿**(见下表状态列);
剩 1 条(AC-063)动手后**退回 B 档**,理由见 B 档表。

> ⭐ **实施刀的读数**:todo **30 → 19**,`cutover:check` 9a 从「73 通 / 30 待」变成
> 「84 通 / 19 待 / 0 败 / 103 总」。⚠️ **9a 仍红**(只要还有一条 todo 就红)—— 这是预期的,
> 剩下的 19 条是 B 档 4(含新退回的 AC-063)+ C 档 14 + 本表最后那条。
> 每条新用例都做了**变异对拍**,读数逐条写在
> `src/modules/activities/activity-business-overhaul-acceptance.spec.ts` 的去向表注释里
> (**含三次诚实的阴性结果**,见下)。

> ⭐ **2026-08-27 对齐刀读数(实跑 `pnpm cutover:check`,`743abb5b`)**:todo 19 → **9**
> (`103 通 / 9 待 / 0 败 / 112 总`;A 类 12/13 过,9a 仍是唯一硬红)。接通链:
> AC-063(关账 × 终审/更正真竞态,双 pool + 闸门事务)[#1185](https://github.com/BA7IEE/srvf-nest-api/pull/1185)·
> AC-064 / AC-066 / ADV-022 [#1194](https://github.com/BA7IEE/srvf-nest-api/pull/1194)·
> 万人档 4 条(AC-054 / AC-055 / AC-068 / ADV-008)转永久豁免真用例
> [#1196](https://github.com/BA7IEE/srvf-nest-api/pull/1196)(19 → 18 → 16 → 13 → 9)。
> **剩 9 条全部是 C 档能力缺口,不再有 B 档**:AC-009 / AC-010 / AC-013 / AC-017 / AC-020 /
> AC-025 / AC-047 / AC-067 + ADV-010(卡 [P2-21](#p2-21-入队进度看不见活动结算记的分--目标形状账本是唯一真相上线前必做不是先不做) 的分账本合并)。
> 下方「剩 B 档 5 + C 档 14」的分档自此为历史读数。

| 编号 | 状态 | 一句话依据 |
|---|---|---|
| AC-012 | ✅ 分拣刀接通 | 同一夹具里两格都有:未受邀活动不进目录(有邀请的那条**在**列表里,判据非恒真)+ 直接拿 id 请求详情得 `ACTIVITY_NOT_FOUND` |
| AC-023 | ✅ 分拣刀接通 | 100 条真 HTTP 并发争 capacity=1:恰 1 成功 / 99 条容量码,桶停在 `occupied=1`,不超卖不负数另有 DB CHECK 双向反例 |
| AC-003 | ✅ 实施刀接通 | 九类历史**逐类**在源活动上真的建出来再断言克隆件逐类 0(此前只建了一条报名 ⇒ 另外八类恒真);事实表 spy 面 11 → 24 个 delegate,另加「名字必须是真 delegate」的地板 |
| AC-014 | ✅ 实施刀接通 | 场次留在未来使时间闸开着 ⇒ 20030 只能来自事实闸;void 掉那条事实后取消放行(「**有效**」限定的首个 HTTP 证据);同一活动续 terminate → 封场 |
| AC-019 | ✅ 实施刀接通 | accept 入口上硬资格 21040 / 保险 26030 / 表单 21036+21037 三格负例 + 表单答齐 201 正对照;每条负例回读「邀请仍 pending + 零身份行」 |
| AC-022 | ✅ 实施刀接通 | 100×3 的**绝对数字**仍由既有 service 级用例承担;新增 HTTP 级「一人报三场 ⇒ 活动位 1 / 人次 3」,第二人加入 ⇒ 2 / 6(两个方向各堵一种坏实现) |
| AC-049 | ✅ 实施刀接通 | 一夹具三人(出勤 / 缺席 / 早退零时长):后两位零 day 行、零分录、零 day-state,读面只出现出勤那位;另加同版本同身份第二条结果行 ⇒ P2002 |
| AC-056 | ✅ 实施刀接通 | 同一北京日**两场不同活动**各 2.00 ⇒ 第二场 credited 1.00 / cappedOut 1.00、日合计恰 3.00;顺序那格按 `sequenceStartAt` 逐行断言(既有那条用 `.sort()` 洗掉了顺序) |
| AC-057 | ✅ 实施刀接通 | 段 15:00Z→次日 03:00Z、认定 4.00 ⇒ 两日 0.33 / 3.00,**两日计入合计 3.33 > 3.00** —— 只有按日分别设限才可能出现这个数 |
| AC-060 | ✅ 实施刀接通 | 出勤改缺席 + 缺席改出勤**两向**各一条,同夹具前后各读五格,另带未被更正者的正对照 |
| ADV-012 | ✅ 实施刀接通 | 与 AC-060 共用那段,绑「缺席改出勤」那一向 |
| AC-063 | ⛔ **退回 B 档** | 动手后发现:合同这句点名**两个**并发对象,而关账 spec 的夹具族只产出「终审之后」的状态,「终审待审」那半边只存在于另一族夹具里 ⇒ 要合并两套夹具体系。详见 B 档表 |
| ADV-011 | ✅ 实施刀接通 | 给更正 spec 加第二套 Nest/pool + 闸门事务,`pg_stat_activity` **正面数到 2 个锁等待者**;同 target 恰 1 成功 / 20101 / 库里恰 1 行,不同 target 双双成功作正对照 |
| ADV-019 | ✅ 实施刀接通 | 六个人 × 两个活动的完整矩阵,目录与详情**各走一遍**;停用两条路分码断言(账号停用 40100 / 队员停用 40300),另有「非正式 × 受邀」这一格跨轴组合 |

##### 🔴 实施刀查出的一条**运行中缺陷**(未修,待裁定)

`eligibilityCorrected`(App 评价面 `feedback.eligibilityCorrected`,DTO 描述逐字是
「最新结算纠错是否已撤销本人的当前评价资格;历史评价仍保留」)**在真更正链上恒为 `false`**:

| 处 | 逐字 |
|---|---|
| `activity-feedbacks.service.ts` `wasEligibleBeforeLatestClosure()` | 找旧 closure 上的结果行时带 **`statusCode: 'committed'`** |
| `correction-application.service.ts` commit 事务 | 把旧结果行一律 **`SET "statusCode" = 'superseded'`**(§5.14 ⑥ 明文要求) |

两者对不上 ⇒ 更正一旦生效,那次查询在生产路径上永远查不到东西。
⭐ **为什么一直没被发现**:既有 `AC-065` 用例(`activity-feedbacks.e2e-spec.ts`)**读到过 `true`**,
但它的夹具 `createFeedbackSettlement()` 是**手写**两版结果行、两版都留在 `committed`、旧 closure 只改
`statusCode` —— **真更正链从不产出那个形态**。同「夹具造了一个从没在生产出现过的世界」那一类。
⇒ 实施刀**不修**(AGENTS §2:调研中发现的问题不顺手修,先汇报),
**也不把 `false` 断言进用例**(断言 false = 给缺陷发一张契约);AC-060 那条用例里逐字写明少了哪一格。
~~**修法(改判据 vs 改投影)与优先级待维护者裁定。**~~
✅ **2026-08-25 已裁定,单独立条:见本文件 `P2-19`**
(拍板:现在不修,等前端要用评价面时再修;建议修法 = 改判据,让查询接受 `superseded`)。

##### ⭐ 三次**诚实的阴性变异**(比阳性更值得记)

| 变异 | 读数 | 结论 |
|---|---|---|
| `planReserveCreates` 的活动位意图搬进逐场次循环(两种写法) | **全绿** | 意图与 delta 都按 `target` 归并 ⇒ 这一类坏实现**在本仓写不出来**;一人一活动位由三处独立执行位守着 |
| 只卸掉 `assertNoBlock(qualification)` | **全绿** | 硬资格在邀请 accept 这条路上有**两处**执行位(canonical 命令 + first_come 落位前再冻一次);两处一起卸才红 |
| 只卸掉更正的 service 侧 `assertNoOpenRequest`(或只卸 P2002 翻译) | **全绿** | Activity 行锁把第二条提交推到第一条 commit 之后 ⇒ **「同时申请两个更正」在当前锁协议下退化成串行情形**,DB partial unique 在竞态里够不到 |

⇒ 这三条都写进了去向表注释,**不许把它们说成"新增一道执法"**。

**B · 能写但太重(2026-08-24 分拣 4 条 + 2026-08-25 实施刀退回 1 条 = 5)—— 需专门的规模 / 耐久 / 夹具方案,不要顺手写进普通 e2e**

| 编号 | 为什么重 |
|---|---|
| **AC-063**(2026-08-25 退回;✅ **同日 #1185 已接通**,见上方 08-27 读数) | ⭐ **动手才知道的**:合同这句点名**两个**并发对象(「最后一次终审」与「最后一个更正」),而 `activity-settlement-closure.e2e-spec.ts` 的夹具族只产出「**终审之后**」的状态(`run.statusCode='posting'`,批次 `preparing`);「终审**待审**」那半边只存在于 `activity-settlement-review-concurrency` 的另一族夹具里,两族的活动形状不同 ⇒ 要把两套夹具体系合并才写得出「关账 × 终审」的真竞态。**「关账 × 更正」那半边是便宜的**(同刀已验证同一手法在更正 spec 上可行),但本文件的纪律是「未达到合同完整口径的一律仍为 todo」,不拿一半结案。<br>⚠️ 另一条实测理由:同刀在 ADV-011 上量到「Activity 行锁把并发推成串行」⇒ 这类竞态用例的**独占红集往往为空**(与既有串行用例同红),而屏障 + 5s 事务预算带来的**假红风险是真的**。⇒ 立项时先想清楚它要多守住什么,别为了一个编号造 flake 机器。<br>**下一个人的起点**:更正 spec 的第二实例 + 闸门事务已经落在 `activity-settlement-correction.e2e-spec.ts` ⑪ 段,照抄即可 |
| AC-054 | 10000 人统一生效**恰好用尽**全局槽位预算(`LEDGER_COMMIT_LOCK_SLOT_COUNT 10` × `MEMBERS_PER_SLOT 1000`),`>10000` 由 `ledgerCommitExceedsTotalBudget` 恒拒 |
| ADV-008 | 同上天花板,且 6 个检查点要把同规模夹具重建 6 次 |
| AC-055 | 三轴 × 100 轮完整事务链(**耗时是估计不是实测**:本刀无连库权限;可比读数是同仓 8192 人 spec 自述单跑 1–2 分钟) |
| AC-068 | 10000 档读数需规模测试环境;顺带订正:**500 档也没有正读数**(现有是对 501 条伪造 id 的拒绝) |

> 🔴 **10000 人这档的真天花板不是墙钟,是 PostgreSQL 共享锁表。** 一场万人生效实占 **10000 把**
> 队员 advisory 锁,而公式保底 `max_locks_per_transaction × (max_connections + max_prepared_transactions)`
> = 64 × 200 = **12800**(第 0 批 lock-probe §6 实测)。那张表是**整个实例共享**的,不是每库一份;
> 而 e2e 各 worker 只是**派生独立库、共用同一个 PostgreSQL 实例** ⇒ 一条 10000 人的用例会占掉全实例
> 78% 的锁表条目,把 `out of shared memory`(硬 ERROR、不可重试)撒到**别的 spec** 上。
> ⇒ **写 10000 人的普通 e2e 就是在造 flake 机器**,必须另立规模方案(独立实例 / 串行道 / 或按拍板降档)。
> ⚠️ **两个「事务预算」别混用**:统一生效走 `MEMBER_TX_TIMEOUT_MS` = 4000 锁等待 + 3000 业务 = **7000ms**;
> AC-068 卡点里那个 **5000ms** 是批量入队路径吃 Prisma 默认值,两者不是同一个数。

**C · 真做不了(13)** —— 卡的是**能力**不是测试;逐条卡点已写进
`src/modules/activities/activity-business-overhaul-acceptance.spec.ts` 的卡点表(缺哪一格写在那里)。

> ⭐ **2026-08-25 归档刀:AC-004 已从本表移出并结案**(todo 17 → 16)。它此前是标准的 C 档
> (「三格全缺,不是缺测试」),归档动作落地后四格逐条对上:工作台 `staleDraft` 提示 /
> `POST …/archive` 人工归档 / 归档只改 statusCode 零删除 / 零新增 cron。
> 同刀把 **AC-064 与 ADV-022 的卡点收窄但不结案** —— 前者只剩「关账满等待期**可以归档**」
> 这一半没有 HTTP 证据(要一条真 closure,三条必填外键),后者只剩两条**真并发**用例
> (能力已具备:归档与关账取同一把 Activity 行锁)。两条仍留在本表。

AC-009(✅ **2026-08-28 永久豁免**:被决策锁 D-1 结构性排除,全局化即合同意图;登记 CUTOVER_SIGNOFF §5)·
AC-010(✅ **2026-08-28 拍板开做改期刀**:改期 = 动四时间窗 + 旧二维码**作废重签**;余五格已落)·
AC-013(责任模型仍是 2 值 + 2 布尔;两布尔全 false ⇒ **零 RoleBinding**,不是「只读」)·
AC-017(⏸ **2026-08-28 拍板搁置**:上线后按真实运营诉求再立项,保持 todo 不豁免)·
AC-020 / AC-025(⚠️ AC-047 已于 2026-08-28 结案:提交侧补 20160 独立执行位 + 真空形态负例 + 草稿仍可整理的正向,red-first 卸闸 2 红;封场侧刻意不加闸)· AC-064 · AC-066 ·
AC-067(⭐ 真约束是 **cron 终态恰 2 的决策锁**,加第三个要新 D 档)· ADV-010(新账本与入队进度读两张不相交的表)·
ADV-018(实现层就是活动级广播,与「只影响该场次」相反)· ADV-022。

**⏭ 顺带登记(本刀刻意不做)**:「卡点写着『卡第 N 批』而该批已合」这一类,今天**零执行位**。
做成闸要落 `scripts/check-*.ts`(selfGuard 红区,需维护者授权),且判据形态不好定
(不是所有「卡第 N 批」都随该批交付而失效,AC-003 就是批次合了但缺口换了一个)。
**下次谁改这份登记表,先按上表复核一遍卡点是否仍然成立。**

### P1-29 架构治理 v4 全 11 阶段 — **已落 7 阶段;剩 Phase 3 / 4 / 6-B / 7,翻闸项见 B 档三条**

**状态**:进行中(11 阶段落 7:Phase 0 / 1A / 1J / 1D / 2 / 5 / 6-A;最近两刀 #1009 债务台账闸、#1131 债务棘轮执行位。未完 Phase 3 / 4 / 6-B / 7,Phase 8 条件触发。2026-08-24 翻闸取证已完成 —— 结论是**剩下的都翻不动**,逐条见下方 B-1 / B-2 / B-3)

> ⚠️ **本条标题原写「Phase 0 — 拍照·登记·健康基线(执行中)」,状态行是裸 `待办`** ——
> 与标题自述的「执行中」自相矛盾,且 Phase 0 早已收口。既有台账状态闸对它**结构性失明**:
> 判据 C 只对「有交付类 commit 点名本条编号」的条目开火,而实测**点名 `P1-29` 的 commit 数 = 0**
> (v4 各阶段的提交写的是 `feat(harness)` / `ci(governance)`,从不带编号)。
> 这正是那条闸自己登记的已知缺口①「漏的是压根没点名的那一类」的实例。2026-08-24 订正。

- **依据**：[v4 冻结方案](../archive/reviews/architecture-governance-v4/README.md)(11 阶段;§7 是 report→blocking 的 Exit Criteria)。
- **载体**：`harness/domain-map.json`、`architecture-debt.json`、`architecture-debt-baseline.json`、
  `state-machines.json`、`service-size-baseline.json`、`ratchet-registry.json` 与
  `scripts/check-boundaries.ts` / `check-codemap.ts` / Route Authorization Policy 生成器。
- **边界**：仅治理登记、报告与基线;不改 `src/**`、Prisma schema/migration、测试行为。

#### 2026-08-24 翻闸取证:**授权预算内零个 CI 侧闸可翻**

逐条判据是「**这条规则失败时 CI 那一步会不会让 PR 变红**」,不是「文件里有没有 `report` 字样」。

| 规则 / 判据 | CI 会不会红 | 翻成执法后当前违规数 | 档 |
|---|---|---|---|
| A 类元数据 `docs:boundaries:check`(R1/R4/R7/R10 登记闸) | ✅ 已阻断 | — | 已执法 |
| 债务台账语义完整性 `docs:boundaries:debt:check` | ✅ 已阻断(#1009) | — | 已执法 |
| call-site 身份 `docs:boundaries:ids:check` | ✅ 已阻断 | — | 已执法 |
| **架构债棘轮 `docs:boundaries:newdebt:check`** | ✅ 已阻断(#1131,无 `\|\| true`);实测 `scanned 641 / unknown 0` | — | 已执法 ⇒ **R2/R3/R5/R15 的「新增违规才阻断」已有执行位** |
| `pnpm docs:boundaries`(`--violations`)的 `\|\| true` | ❌ —— 但**它是空开关**:`runViolations()` 从不设 exitCode,634 条 finding 实测仍 `EXIT=0` | 删掉 = 零行为变化 | 无收益,不翻 |
| R6 跨域语义读三档 | ❌ report | 8 条 semantic-predicate 候选 + 119 条 dynamic | **B** —— v4 §5.2 明写「**长期 report**,升级须单独拍板」,不是欠账 |
| R8 声明↔实现闭环 | ❌ 规则默认 `'off'`,只有 `SRVF_AUTHZ_R8_REPORT=1` 才 `'warn'`;而 `lint:authz:report` **未接任何 CI** | **160 条 warning**(实测) | **B** |
| Phase 6-B 尺寸棘轮 `harness:servicesize \|\| true` | ❌ report(真开关) | **14 条**(13 个基线文件变大 + 1 个基线外新超阈值) | **B-1** |
| Phase 4 状态列 `governed` 晋升 | A 类声明闸已阻断;50/58 仍 `inventory` | 真实升格候选 **0 条**(唯一那条是假读数,已订正) | **B-2** |
| Phase 7 债务清偿 229 / 641 | 台账完整性已执法;清偿是内容工作 | — | 非执行位问题 |

**两个必须记下的形态**:

1. ⭐ **「看起来像逃生门、实际什么都没关」**。全仓 workflow 恰两处 `|| true`
   (`ci.yml:253` / `:271`),而 `:253` 那处**兜的脚本根本不会失败** ——
   `runViolations()` 只 `process.stdout.write` 不设 `exitCode`。
   `docs/ai-harness/README.md` §2 末句写「末两条……脚本本身有发现即退出 1」,
   对 `:271` 成立、对 `:253` **不成立**。读代码相信 ≠ 实跑退出码。
2. ⭐ **两处 `|| true` 都在 `.github/workflows/ci.yml`(红区 `ci-workflows`)**,
   且 `:253` 那处被 `scripts/harness-guards.selftest.ts:1121` 逐字钉住
   (`ci.includes('pnpm docs:boundaries || true')`)。
   ⇒ **翻任何一个 CI 侧闸都至少要两条红区授权**,本刀两条授权
   (`check-boundaries.ts` + `state-machines.json`)一条也不覆盖它们。
   **开关不在被授权的那两个文件里** —— 这是本刀 goal 的前提缺口,如实记下。

#### B-1 Phase 6-B 尺寸棘轮转 blocking(`ci.yml:271` 删 `|| true`)

**翻不动的理由**:实测 14 条违规 —— 13 个基线文件比基线大
(`activity-responsibility` +40 / `attendance-onsite-batch-job` +76 等,合计 +171 NCLOC),
外加 `attachments/attachment-storage-orchestrator.ts` 净 711 越过阈值 700 却不在基线。
且 [`SERVICE_SIZE_RATCHET.md`](SERVICE_SIZE_RATCHET.md) §4 的**专属 EC**
(「6-B 拆分已把摩擦压到可接受区间」)2026-08-21 复测 **❌ 严口径 35 > 判据线 30**。
**代价**:先还这 14 条(或经拍板重算基线),再删 `|| true`;需 `ci.yml` 红区授权 + 环境审批。
⚠️ `pnpm harness:servicesize:write` **不是棘轮安全的**(整体重算会新增 + 上调条目,
而裁判那条硬失败**审批盖不掉**:scan 失败 ⇒ approval job 被 skip,没有可点的按钮),
见 `SERVICE_SIZE_RATCHET.md` §3.2。

#### B-2 Phase 4 晋升棘轮接执行位 + 去掉 `governed` 条数的硬编码

v4 §5.2 R10 写着「存量按棘轮晋升」「Phase 4 起新建 stateful 实体必须直接 governed」——
**这两句今天零执法**:`upgradeCandidates`(零 blocker 却仍 `inventory` 的条目)只出现在
`--violations` 的 B 类报告块里,恒 report。把它搬进已阻断的 `--metadata` 即为执行位,
形态与台账状态闸同源(**治「沉默」不治「没做完」**:如实写下 blocker 即放行)。

**为什么本刀不做**:
- 常驻阳性对照必须写进 `scripts/harness-guards.selftest.ts`(红区,本刀无授权)。
  **没有常驻阳性对照的新闸是在给债务台账添条目,不是还债。**
- 同一份 selftest 的 `:1817` 断言 `governedEntries.length === 8` —— **把 governed 条数硬编码**。
  ⇒ **任何一条状态列升格都必然打红它**,与该条能否过闸无关。这是「写死 N」缺陷类
  (`docs/ai-harness/README.md` §4 刚因同一形态从「恰 4 文件」true-up 过),该一并去掉。

**前置读数**(本刀已订正,见 [`STATE_MACHINE_INVENTORY.md`](STATE_MACHINE_INVENTORY.md) §10.7):
`ParticipantSettlementResultRevision.statusCode` 的 `governedBlockers: []` 是**假读数** ——
实测升格被 L2 闸当场拒(状态机物理散在 4 个文件),已补 `impl-scattered`。
⇒ 真实升格候选从 1 变 0,**该闸落地即零违规**。

#### B-3 ⭐ 边界扫描面漏掉 `src/modules/**` 与 `src/common/**` 之外的 19 个文件

`scan()` 主循环第一步是 `moduleOf(file)`,而它**只认 `^src/modules/([^/]+)/`** ——
R15 当年建立就是为了堵这条「把业务 helper 搬出 modules 就免于一切边界规则」的逃生通道,
但**只堵了 `src/common/` 一个目录**。`src/bootstrap/` · `src/config/` · `src/database/`
与 src 根下的 worker / fixture 文件(共 **19 个非 spec `.ts`**)**结构上够不到任何边界判据**,
也因此永远不会进 `architecture-debt-baseline.json`,连棘轮都看不见它们。

**摩擦实测极小**:19 个里真有 Prisma / 裸 SQL 触点的只有 2 个 ——
`src/local-activity-frontend-fixture.ts`(23 处,本地夹具)与
`src/bootstrap/postgresql-throttler-storage.ts`(5 处,技术件)。

**代价**(所以不在本刀内):扩扫描面 = **改判定口径**(本刀禁区),
且新发现的存量违规必须登记进 `harness/architecture-debt-baseline.json`(红区,本刀无授权),
而基线是 `set-monotonic` 棘轮、由 base-trusted 裁判守「只减不增」⇒ 新增条目须环境审批。
**三条里这条最值钱**:它是结构性零执法,不是「存量多」。

### Content / Notification 可见性业务 Decision — **✅ 已最终拍板(2026-07-27)**

- **业务负责人最终确认日期：2026-07-27**。
- **Decision 15.1=B**：management 只认 SUPER_ADMIN 或明确持有对应 GLOBAL `content.read.record` / `notification.read.record` 的账号；Role.ADMIN 不自动放行。
- **Decision 15.2=B**：department 认当前有效 PRIMARY / SECONDARY / TEMPORARY / SUPPORT Membership，且 Organization 必须 ACTIVE、未软删；适用于 App Content、App Notification、SMS/WeChat 根受众及微信实际 Effect 前最终收件人复核。
- **非阻断待评审**：考勤审核自由备注是否永久原文进入不可变审计，待独立隐私口径确认；本项不是已确认漏洞，不在当前 hardening Goal 修改。

> ⚠️ 本条虽已拍板收口,**刻意留在活跃区**:`notification-canonical-docs.spec.ts` 把它钉成契约
> (与 `current-state.md` / `notifications/CLAUDE.md` 三处互证)。它是**当前生效的业务决议**,不是完成的任务。

### P1-10 D-INSURANCE v3 顺序四 PR 收口 — **PR1–PR4 代码均已交付；PR3 runtime enable 与 PR4 migration deploy 待后续运维窗口**

**状态**:⏸ 挂起(PR1–PR4 代码均已交付;PR3 runtime enable 与 PR4 migration deploy 等运维窗口 —— 须先 drain 旧 server,AI 对部署恒无权)

- **PR1 expand-only(已交付)**:`MemberInsurance` pending/v0/nullable reviewer + nullable 双 source/双 owner Evidence RESTRICT FK 骨架 + `TeamJoinCycle.requiresInsurance=false`；约束刻意留 PR4。
- **PR2 compatibility window(已交付)**:唯一 review route + optional App expectedVersion + telemetry；consumer 保持旧语义、0 evidence。
- **PR3 enforcement cutover(本次代码交付，不含部署)**:`INSURANCE_ENFORCEMENT_ENABLED` 单 gate 同时切 App required CAS、verified-only、Activity/Team Join 最小 evidence 与 final join 保险闸；production missing/empty/invalid fail-fast，显式 false 可启动。维护者于 2026-07-19 逐字确认“旧客户端都没上线，放心操作执行”，仅解除客户端兼容等待，**不构成旧 server=0 运行证据**；真正 enable 前仍须 drain 旧 server 且禁止 true/false fleet 混跑。
- **PR4 DB closeout(代码已交付，不含部署)**:migration 已实现完整性扫描、exactly-one/kind/interval/review snapshot、全局单 owner、同 member 与 immutable trigger；任一脏数即失败且零修数/删数。生产约束尚未生效，deploy 前仍须沿 PR3 SOP 确认旧 server=0、排空旧事务并禁止混合 gate。
- Admin 队员 360 的团队保险覆盖安全投影已交付；小程序/App 端保险展示仍不在本任务范围。理赔、到期主动提醒(新增 cron 须 D 档)与保单图 attachments 接线也仍须真实诉求触发后另立项。

### P1-14 GAP-005 统一通知模块后续(S1–S5 已发,余项 ⏸ 诉求触发再立项)

**状态**:⏸ 挂起(S1–S5 已发;余项〔报名前 openid 推送路 / 短信投递查询端点〕诉求触发再立项)

- **真·全员短信批处理异步**(S5 末位切片经 D-Outbox 收口):admin `confirmed=true` 现先持久化逐收件人 generation intent，再由 HTTP 做首轮、独立 worker 续跑失败项；跨进程 active-slot 防并发重复，真实 `NotificationDelivery SENT` 才是永久去重事实。实现未新增 cron/Redis/queue/事件总线；若未来受众规模需要分片、吞吐控制或专用队列，仍须另立 D 档，不在 durable outbox 基础能力中暗增。
- **报名前 openid 非会员推送路**(S3/S5 均标注另立项):招新报名前 5 触发(报名受理/转人工/门槛/评定/公示)申请人**非队员**,站内/微信/短信(均需 member)够不着 → 现维持**查询进度 pull**;若需主动推送给未入队报名人(微信 openid 锚点),单独立项。
- **短信 admin 投递查询端点**(可选):当前 `NotificationDelivery`(channel=sms)+ `sms_send_logs` 落库,admin 查投递成败靠 `sms-send-logs` 列表(已有)/ 运维看库;若需「按通知查短信投递明细」admin 端点,诉求触发再加(沿 S2 微信 delivery 无专属查询端点的口径)。

(P1-11 招新一期〔招新前段〕+ P1-12 招新二期〔招新后段〕+ **P1-13 招新三期〔入队:志愿者→队员〕** 均已完成,见[已收口项归档](../archive/ai-harness/next-tasks-completed.md);**招新业务域三段闭环**:报名前段〔临时编号〕→ 转正后段〔建 User+Member,无部门无级别〕→ 入队〔10 项考核 + 综合评估 → 设部门 + 级别 level-1〕。**P1-12 当时拍板的「admin 手工建档 = v1 边界外」已由 v0.41.0 招新可用性收口还账关闭**:F2 admin 改资料〔PATCH,R1 白名单〕+ F3 单人手动建档〔promote-single,放行外籍+锚点择优〕——批量发号全部 skip 类自此有出路;冻结评审稿 [`recruitment-usability-closeout-review.md`](../archive/reviews/recruitment-usability-closeout-review.md)。)

### P1-20 app 侧证书图暴露给队员本人 — **⏸ 诉求触发再立项**

**状态**:⏸ 挂起(诉求触发再立项:小程序前端出现真实页面诉求时另立 C 档)

- **背景**:v0.41.0 招新可用性收口 F7(评审稿 §2.9 R6)落地了证书图长期档案:申请人公开上传(`certificateImages`)→ promote 建 pending `Certificate` + 图 key 搬 `Certificate.imageKeys Json`。**app 侧 `GET app/v1/my/certificates` 的 `AppMyCertificateDto` v1 刻意不含 imageKeys/图 URL**(v1 契约不动,goal 拍板另议)。
- **候选方案**:若队员需要在小程序回看本人证书图,镜像 admin 取图口径加 `GET app/v1/my/certificates/:id/image-urls`(self-scope 锁本人 memberId;短 TTL signed-URL;L3 不入日志)——须先过 App surface 语义评审(api-surface-policy §9)。
- **触发条件**:小程序前端出现真实页面诉求时单独立项(C 档;0 schema——列已在)。

### P1-15 存量队员批量导入工具 — **⏸ 不自动启动,诉求触发再立项**

**状态**:⏸ 挂起(不自动启动;出现批量导入存量队员的真实诉求时另立 D 档)

- **背景**:终态 scoped-authz 序列(GAP-007,PR1–PR12 + 摘码微刀,已全量落地)的 PR11 只建了 `announcement-import`(preview/execute 两段式,导组织/任职/分管),**不建 `Member`**——双锚铁律(R7)要求执行前每条行都能按 `memberNo` 命中已存在的队员。当前给全新队员群体(如整队历史存量数据)批量建 `Member` 记录尚无专用端点,只能逐个 `POST admin/v1/members` 或运维 `psql` 直灌([`ops/scoped-authz-go-live-checklist.md` §3`](../ops/scoped-authz-go-live-checklist.md) 已登记此缺口)。
- **候选方案**:镜像 `announcement-import` 的 preview/execute 两段式设计(零写入诊断 + 幂等落库 + 逐行 `ok`/`blocked`/`already-exists` 结果),但目标表是 `Member`(可能含基础档案字段)而非组织/任职/分管;**同样受 R13 约束**——测试与文档示例一律用假数据,真实姓名/证件信息不进本仓库任何位置。
- **触发条件**:出现批量导入存量队员(> 逐个可接受量级)的真实诉求时单独立项评审(D 档,涉及 schema 是否需要新增批量端点、字段集范围、与 `POST admin/v1/members` 单条端点的关系)。
- **与 P1-18(队员账号闭环,✅ 已完成)关系**:P1-15 解决"批量把队员**档案**（`Member`)灌进来";P1-18 解决"给**已存在**队员开**登录账号**(`User`)"。两者正交——P1-15 若落地,批量导入出的 `Member` 仍可用 P1-18 已交付的 `POST admin/v1/members/accounts/bulk-grant` 批量开号能力。

### P1-24 通用证书标准库 + 队内认定规则 + 招新证书闭环 — **✅ 已交付并随 v0.65.0 发版(2026-08-02);剩首批初始化(生产 runbook)**

**状态**:⏸ 挂起(代码随 v0.65.0 全交付;剩「**队内认定**标准的初始化」「第 67 migration 生产部署」「前端适配」三项 —— 前两项是维护者动作,AI 对 migrate deploy 恒无权。**法规定义**的那批标准已内置 seed:业余无线电 A/B/C,2026-08-25 拍板)

- **交付**:PR-0(冻结)→ PR-1 → PR-2 → PR-3 → PR-4a(拆三刀)+ PR-4b → PR-5 → PR-6 全部合入 main([#826–#834](https://github.com/BA7IEE/srvf-nest-api/pull/834));**Endpoint 435→438 · Migration 66→67 · 权限码 214→222**。
- **⚠️ 交付后跨模型评审判 NO-GO → findings 修复批次 F1–F6**(2026-07-30):两个外部模型对 `main@bc300a66` 独立评审,21 条 findings 主会话逐条复现。修复见 [#835](https://github.com/BA7IEE/srvf-nest-api/pull/835)(并发四处统一收口)· [#836](https://github.com/BA7IEE/srvf-nest-api/pull/836)(证据授权按状态分流)· [#837](https://github.com/BA7IEE/srvf-nest-api/pull/837)(PATCH 三态 + 日期真实性 + 核验落点)· [#838](https://github.com/BA7IEE/srvf-nest-api/pull/838)(§12 资质判断)· [#839](https://github.com/BA7IEE/srvf-nest-api/pull/839)(主数据契约与审计)· F6(SOP / 初始化 / 台账)。
- **post-freeze 修正记录**:[`archive/reviews/certificate-standard-library-t0-amendments.md`](../archive/reviews/certificate-standard-library-t0-amendments.md) —— 冻结稿正文不回改,修正逐条记在这里。**冻结稿 + amendments 两份合起来才是当前需求。**

#### 第四轮独立评审当时未通过(`main@7b0f5c25`)—— 4 条已修完(J1/J3);**后经五轮/整批/Q 复核链条终局通过(2026-08-02 GO)**

判 NO-GO,**2 P1 + 2 P2,无 P0**;主会话逐条复现,**全部属实**(含 `new Date(null) → 1970-01-01` 实测)。

**本轮与前三轮的关键区别**:前三轮修「被点名的实例」,下一轮评审就在邻居文件找到同类
(H3 修了 `certificate-standards.dto.ts`,第四轮立刻在隔壁三个证书域 DTO 找到同一形状)。
本轮改成**修「类」+ 留机器守护** —— 判据从「还有没有漏的实例」变成「这个类有没有执法位」。

**P1-① `@IsOptional()` 的 null 语义错位(证书域全清)**

`@IsOptional()` 对 `null` 与 `undefined` **都**跳过后续校验,而本仓 service 判「传没传」
一律用 `=== undefined` / `!== undefined` / `??`。语义错位 ⇒ 显式 `null` 穿过契约层抵达 service。
三种后果,**都已在真 HTTP e2e 上复现**(修复前实测,括号内是实际返回):

| 后果             | 落点                                                                                                                                                                         | 修复前实测      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **静默写错事实** | Claim 审核 `issuedAt: null` → `new Date(null)` = **1970-01-01**(不是 Invalid Date,躲得过任何 NaN 检查),被「不得晚于今天」放行,作为正式审核事实落库并**照常参与资质门槛派生** | **200**(应 400) |
| **500 而非 400** | Policy PATCH `issuerPolicy: null` / `certNumberMode: null` → `?? locked.x` 先当没传算出合法最终态,`!== undefined` 又判成传了 ⇒ `data.x = null` 进 Prisma 非空列              | **500**         |
| 同上             | Certificate PATCH `standardId: null`                                                                                                                                         | **500**         |

⚠️ 两条**与报告原文不同**,复审时请重点看:

- **`validityMode: null` 修复前返 400 而不是 500** —— `assertValidityCombination(FIXED_MONTHS, null)`
  顺手把它拒掉了。那道闸不是为 null 设的,只是**撞上了**。同理 `issuers: null`:
  `dto.issuers ?? []` 把 null 折成空数组,让 null 成为「清空」的隐式同义词,但
  issuer 数量检查(FIXED 恰好 1 / ALLOWLIST ≥1)顺手挡住了,**所以它当前不是可达的静默清空**
  —— 报告与本仓早前注释都把这条写得比事实严重,已订正。两条仍一并收口:
  依赖「恰好被别的规则挡住」正是本轮在修的形状。
- **`validityMonths` 判定为「仅可省略」而非「可清空」**:它的 null 由 `validityMode` 派生
  (改 mode 时 service 自动归零),不由客户端独立指定;保持 FIXED_MONTHS 却清掉 months
  本就是非法组合。DTO 里那句「本 DTO 不接受 null」以前**只是一句话**,现在有执行位了。

**逐字段分类**(证书域四个 DTO,实测 **47** 处真装饰器 —— goal 写的 51 里有 4 处是
注释中提到 `@IsOptional()` 的文字,不是装饰器):

| 文件                                      | 真可空(留 `@IsOptional()` + `T \| null`)                                 | 仅可省略(改 `@OmittableOnly()`)                 |
| ----------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------- |
| `recruitment-certificate-claims.dto.ts`   | 0                                                                        | 16                                              |
| `certificate-recognition-policies.dto.ts` | 0                                                                        | 7                                               |
| `certificates.dto.ts`                     | 4(Update 的 `recognitionIssuerId`/`issuingOrg`/`certNumber`/`expiredAt`) | 6 + 1(`issuedAt` 原为手写 `@ValidateIf`,改具名) |
| `certificate-standards.dto.ts`            | 4(两处 `description` + Update 的 `levelCode`/`parentId`)                 | 10(两个 query DTO;H3 已做的 9 处不回退)         |

**两道防御,不只 DTO**:`@OmittableOnly()` 是第一道;service 侧换成**正向类型检查**
(`typeof dto.issuedAt !== 'string'` 而不是 `=== undefined`)是第二道。最深的一道放在
`CertificateRecognitionResolver.resolveDates` —— 它是**建证 / 审核通过 / 改证三个入口共用**
的那一段,少写一处就是一个新的 1970 入口。配套新增 `parseDateOnlyStrict`
(`src/common/datetime/date-only.util.ts`),因为 `new Date(null|true|[])` 全都给 1970 而非
Invalid Date,「先 new Date 再判 NaN」这种写法拦不住。

**P1-② 这个类没有执法位**(见下方 J2,**已落地**)。

**P2-① 注释与执行位相反**:`review()` / `revokeReview()` 的注释写「⚠️ 本刀**不重算门槛**」,
而两个方法结尾都明确调用 `recomputeCertificateThresholds()`;文件头「也不接门槛派生……
三者必须在 4a-2 一次原子切换」描述的是一个**已经发生过**的未来(4a-2 早已接线)。
改注释、**不改代码**(代码是对的)。这是本项目**第五次**抓到「注释≠执行位」。

**P2-② 台账过期**:`current-state.md` §4 仍挂第三轮的 H1–H5,而它们已修完关闭 ——
继续挂着会让下一个会话去重修。已换成本轮。

**修复落点**(零 schema,**Migration 恒 67**):

| #   | 落地内容                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1  | 证书域四 DTO 47 处逐条分类;`OmittableOnly` 提到 `src/common/decorators/` 成全仓唯一定义处;service 三处正向类型检查 + resolver 兜底;新 e2e `certificate-null-contract.e2e-spec.ts`(A 段该 400 的必须 400 + B 段反向数据断言 + C 段 5 条正向可 null,防矫枉过正) |
| J2  | `eslint.harness.mjs` 第 18 条 selector + 641 条具名基线(棘轮);selftest 加阳性对照 / 反向用例 / 「只减不增」检查                                                                                                                                               |
| J3  | 清掉 `recruitment-certificate-claims.service.ts` 三处过期注释;台账换本轮                                                                                                                                                                                      |

**修完仍须第五轮跨模型评审**(SOP [§1.6](codex-review-sop.md)),门禁由维护者解除 ——
本批次**未**触碰 `current-state.md` 的 🔴 NO-GO。

---

#### ✅ 整批评审(N+R+W)+ Q 复核终局通过(2026-08-02 GO,冻结范围 `56ea8480..b6a2f9d8`)—— NO-GO 已解除,v0.65.0 已发版

**终局**:Q1(共享父预算批量递补,精确反例 e2e)/ Q2(rule-config 逃生门,4/4 真变异)/ Q3(企微 null≠缺席)
全部关闭([#874](https://github.com/BA7IEE/srvf-nest-api/pull/874));[#875](https://github.com/BA7IEE/srvf-nest-api/pull/875)
拆除当日引爆的 e2e 日期炸弹(既存类,守护另立);P2-②(多次锁等待撞总预算)**维持登记不入批**(见下表)。
评审确认修复未引入回归、终树完整机器门禁全过。以下为该轮历史记录:

#### 整批评审(N+R+W,`43f63624..56ea8480`)当时未通过 —— 上轮 5 P1 全 PASS,2 新 P1 归 Q goal(已按上述终局关闭)

**先记账**:上轮 5 条 P1 **全部 PASS 关闭**(裁判四元组冻结 + 别名/namespace/computed 解析 +
`no-decorator-realias` · 显式 ReadCommitted/4s lock/7s tx 三层预算 · 企微 Settings 锁后复读 ·
核心协议严格解析 · Provider 无状态化);R1 真触发已补(#870 对抗 PR,裁判 7s 硬红,run 链接见 #868 评论)。
**#866 台账与 #869 企微核心 PASS;#867 与 #868 各留一条组合缺口:**

| #        | 归属        | 机制(主会话已复现)                                                                                                                                                                                                                                                                                      | 修复                                                                                                                                                           |
| -------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1-①** | #867 递补   | Proposal 多岗位同时扩容:applier 逐岗位循环调 `promoteActivityWaitlistWithinCapacity`,helper 每轮重数全活动 PASS,而递补只写 PENDING 不涨 PASS ⇒ **每个岗位都领到全额父预算**。可达数据:历史 null-position PASS + 双岗位扩容 + 岗位 headroom 之和 > 父 headroom ⇒ 多递补超父余量(错误移出候补 + 误导通知) | Q1:共享事务内父预算,按**实际 promoted 数**扣减(跳过的候选人预算留给下一岗);抽批量入口防调用方自维护第二套容量算法;e2e 覆盖该精确组合                           |
| **P1-②** | #868 扫描器 | `/* eslint srvf/no-param-id-string: "off" */` 是 ESLint **规则配置注释**,不是 disable 指令 —— 扫描器入口闸 `if (!text.includes('eslint-disable')) return []`([selftest:789](../../scripts/harness-eslint.selftest.ts))直接跳过;探针实测 lint 0 命中。可一次关掉 `srvf/*` 全部与 `no-restricted-syntax`  | Q2:业务源文件禁一切 `/* eslint ... */` 配置注释(与合法的具名 `// eslint-disable-next-line ... -- 理由` 语法不同,不误伤);四组**真实 lint** 变异(不许只测纯函数) |
| P2-①     | #869 企微   | 可见范围 outer/inner 显式 `null` 被当"缺席"计 0,违反自己写的铁律「键出现但结构不对 → 36031」                                                                                                                                                                                                            | Q3:null=INVALID_RESPONSE,补 outer/inner null 用例                                                                                                              |
| P2-②     | #868 预算   | `lock_timeout` 4s 按**每次**等待计,两次 3.5s 等待合计可先撞 7s 总预算 → P2028 而非 40901。代码注释已诚实登记                                                                                                                                                                                            | **不入 Q**,登记为「下次触碰该事务框架时处理」(传递剩余 wall-clock / 受控映射 P2028 / 或证明至多一次长等待)                                                     |

**双 PASS 先记账**:**M 并发运行时收口全过**(markGate/evaluate 锁序、入队唯一闸、finalApprove 批量化+RC+有界等待、
edit 状态机执行位 —— 0 P0 0 P1)· **企微 T1 schema 全过**(身份不进 User.openid、双 partial unique、
hash-only 凭证、singleton、additive 第 68 migration)。**业务运行时首次两批同轮零 finding。**

**5 P1(主会话逐条复现属实,含探针实测)**:

| #   | 归属    | 机制(已验)                                                                                                                                                                                              | 修复归 |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| ①   | M 棘轮  | 裁判只冻结 ratchet **id**,同 id 可换 `baseline/rule/symbolShape` 载体(judge 无四元组比较,grep 证实)                                                                                                     | R      |
| ②   | M 规则  | controller 里 `// eslint-disable-next-line srvf/no-param-id-string` **有效**(noInlineConfig 只盖 DTO;探针 0 命中无警告);`CV['IsOptional']` 计算属性与 `const X = CV.IsOptional` 中转不识别(探针 0 命中) | R      |
| ③   | 企微 T2 | `updateSettings` **锁前读、锁后不复读**(`:97` 读→`:109` 锁→`:115` 用锁前值)⇒ 并发可写出 `enabled=false + loginEnabled=true` —— **正是并发审计 S1 形状在全新代码里重生**                                 | W      |
| ④   | 企微 T2 | `agent/get` 解析用默认值兜底:**`errcode` 缺失默认 0(=成功,比报告更糟)**、`agentid` 缺失填本地配置 ⇒ 上游返回 `{}` 也算"连接正常"                                                                        | W      |
| ⑤   | 企微 T2 | `WecomRealProvider` 是 @Injectable 单例却 `this.settings = settings`(`:86`,注释自承)⇒ 并发请求串配置快照;**注释称镜像 wechat provider —— 同形状需顺查**                                                 | W      |

**P2**:lock_timeout 4s 与事务 ~5s 预算之间缺「等 3.8s 后跑完整 200 人终审」的临界证据(归 R)。

**教训(比 findings 值钱)**:③⑤ 说明**形状表没有进入新代码的出生检查** —— S1 清了三轮,新模块第一版又写出来。
R/W 两 goal 的 DoD 均含「对照 S1–S7 形状表自审并留记录」;长期解法是把形状表挂进 goal 模板。

---

<details><summary>第五轮(J2 棘轮加固,已交付并经本轮复核 —— 本轮 ① ② 是其纵深遗留)</summary>

#### 第五轮独立评审:J1 / J3 PASS,**J2 FAIL** → 棘轮加固已交付(`main@99e7d8ca` 起 K1–K3)

**J1 / J3 复核通过**:运行时 null 契约已全关闭,注释与执行位已对齐 —— 这两条不再是 open 项。

**J2 判 FAIL:3 P1 + 1 P2,无 P0**,主会话全部复现(其中嵌套 null 与 inline disable
用一份探针实测,`pnpm lint` **RC=0** 通过 —— 即绕过成立)。四条的共同形状是:
**棘轮的判据本身是 PR 可以改的东西**,于是「防线」在最需要它的那一刻恰好失效。

| #   | 缺口                                              | 修复前实测                                                                                               | 现在拦在哪                                                                |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| L1  | 基线是 `.mjs` 里的字面量,零格式校验               | 一条 `src/**` 混进去就能整目录静默豁免                                                                   | 抽成 `harness/is-optional-null-baseline.json`,六条约束(E1–E6)**加载即抛** |
| L2  | 新增违规 + **同 PR 加基线** / 修 A 加 B(总数不变) | 🟢 全绿 —— lint 与 selftest 读的都是 PR 自己的基线                                                       | base-trusted 裁判硬判 `HEAD ⊆ BASE`,**审批盖不掉**                        |
| L3  | inline disable(文件级 / 行级)、嵌套 null 冒充可空 | 🟢 RC=0 —— 18 条共用一个 ruleId,一句 disable 全关;`:not(:has(TSNullKeyword))` 把 `Array<T\|null>` 当可空 | 独立 ruleId 自定义规则判**顶层**类型 + DTO 范围 `noInlineConfig`          |
| L4  | 对账用 `Set`,同一身份命中 2 次与 1 次**读数相同** | 🟢 一行基线同时豁免两个字段,完全不可见                                                                   | 判据换成「每条身份**恰好**命中 1 个 AST 节点」                            |

**十项变异测试全建档**,索引在 `scripts/harness-eslint.selftest.ts` 顶部(唯一目录,
含每项「修复前是否绕过」与断言落点)。修复前后对照用
`git show HEAD:eslint.harness.mjs` 的**真实旧配置**实跑,不是重建的等价物:
M6/M7 inline disable、M8 嵌套 null 三种写法、import 别名 —— 六项修复前全部 🟢 放行,
修复后全部 🔴 拦下;`T | null` / `@OmittableOnly()` / 已冻结字段三条反向控制不误杀。

**顺手关闭的一条 known-gap**:自定义规则拿得到 scope,`import { IsOptional as Opt }`
已被识破(按**导入原名**判,所以 `IsString as IsOptional` 不误报)。
⚠️ **只关了第 18 条这一条** —— 其余 17 条 `no-restricted-syntax` 选择器的同类缺口
(`UseGuards as UG` / 变量中转 / `PickType as PT` 等 5 条)**原样存在**,继续登记为
knownGap,不因为「自定义规则这件事发生过了」就算解决。

**两处结构性收益**(换独立 ruleId 的直接结果,不是顺手):
① 56 个基线块从「必须重列完整规则集,漏一条把其余 17 条对这些文件静默关掉」
变成只碰自己那一个 ruleId —— **那个排序陷阱结构性消失**(补两条回归用例钉成事实);
② 删掉自测里「报告行号 → 反查 AST 取名」的平行实现,改由规则自己吐身份串,
少一把可能刻错的尺子(`eslint.harness.mjs` 51KB → 27KB)。

`eslint-rules/**` 同 PR 纳入 `harness/redzone.json` 的 `enforcement-layer`:规则体是
**新的执法体**,不纳入保护等于把防线搬到闸门外。加 glob 当场被仓库自己的 F4 闭环
拦下(`缺样例的 glob:eslint-rules/**`)—— 守护正常工作,期望值表 + P2b 覆盖断言一并补。

**L2 的两条真触发证据**(不是结构断言 —— 本仓明确区分这两者):

| 实跑                                                                                                                                              | 结果                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 新 judge 合入 main 后首次运行([run](https://github.com/BA7IEE/srvf-nest-api/actions/runs/30634899615/job/91169893305))                            | `✓ 第 18 条棘轮单调性:baseline ⊆ base(未改动(HEAD == BASE);base 641 条)`                                         |
| 一次性对抗 PR:往基线加一行 `PaginationQueryDto.pageFAKE`([run](https://github.com/BA7IEE/srvf-nest-api/actions/runs/30635176939/job/91170830920)) | `✗ 第 18 条棘轮被破坏`,scan **fail**、approval **skipping** —— **没有可点的审批按钮**(探针 PR 已关闭删除,不合并) |

第二条同时把「取 head 版本的 GitHub API 路径」也走通了 —— 第一条只走了「基线未改动」的
快路,不足以证明整条链路。**只有第二条能证明这道闸真的会拦。**

(当时)仍未解除 🔴 NO-GO,等第六轮跨模型评审 —— **后续:第六轮=整批评审(N+R+W)发现下方残留之一
成真(rule-config 逃生门),归 Q2 修复;终局 Q 复核 2026-08-02 判 GO,NO-GO 已解除**。

**已知残留**(当时留给第六轮;其中 inline-config 缺口已由 Q2 关闭):

- 非 `.dto.ts` 文件里的第 18 条**仍可被 inline disable 关掉** —— `noInlineConfig` 刻意
  只配到 DTO 范围(`src/` 现有 7 处 inline disable 全是 service 侧硬删的正当具名豁免,
  扩到全仓会误伤,而一次误伤会让下一个人来把整条 `linterOptions` 删掉)。
  全仓实测该范围外目前 **0 处**真装饰器 —— 是零暴露,不是无风险。
- `scripts/tsconfig.json` 仍把 `harness-eslint.selftest.ts` 放在 `exclude`(既有缺口,
  见下方 J2 段落说明;需第三份授权,不在本 goal 范围)。

##### ✅ J2 · 立守护 + 全仓基线(**已落地**;红区授权 2026-07-31 由维护者发放)

**规则(`eslint.harness.mjs` 第 18 条 `no-nullable-is-optional`)**:凡带 `@IsOptional()` 的属性,
其 TS 类型必须含 `| null`;否则必须改用 `@OmittableOnly()`。默认对全仓生效(含 `test/` 与
`prisma/` —— 两处实测零违规,所以是白拿的)。

**棘轮的两道执行位,各管一半 —— 少任何一道都只剩单向**:

| 情形                             | 谁拦                    | 为什么不是另一个                                   |
| -------------------------------- | ----------------------- | -------------------------------------------------- |
| 往**已在基线的文件**新增违规字段 | `pnpm lint`             | 豁免精确到 `类名.字段名`,新字段不在名单里 → 当场红 |
| 修好了却**忘删基线行**           | `pnpm harness:selftest` | 一条用不上的豁免对 lint **静默无害**,lint 拦不到   |

**基线键为什么是「类名.字段名」而不是行号**:行号一改基线就变噪音;而 `description` 这类
字段名在同一文件的多个 DTO 类里各出现一次,只写字段名**区分不开**「已冻结的那个」和
「新加的那个」—— 后者正是棘轮要拦的东西。

**阳性对照与反向用例**(`scripts/harness-eslint.selftest.ts`,选择器覆盖闭环 17 → **18**):

```
✓ @IsOptional() 但类型不含 | null 被禁(null 会穿过契约层)      ← 阳性对照
✓ 真可空字段放行(@IsOptional() + `string | null`)              ← 反向
✓ 仅可省略字段放行(@OmittableOnly())                          ← 反向
✓ baseline 内已冻结的字段暂免第 18 条(PaginationQueryDto.page) ← 反向
✓ 选择器覆盖闭环:18/18 条均有正向用例真实触发
✓ 第 18 条棘轮:基线与现状逐条一致(641 处 / 56 文件,只减不增)
```

**棘轮双向变异测试**(故意改坏基线,断言它确实会红 —— 不是推断):

```
基线多一条陈旧行 → ✗ 已修好但基线行还在(删掉这几行):PaginationQueryDto.alreadyFixed
基线少一条       → ✗ 新增违规未登记(基线只能缩不能涨):PaginationQueryDto.page
往基线文件新增一个违规字段 → pnpm lint 当场红
同名字段挪到另一个类里     → 当场红(豁免绑类名,不是全文件通配)
```

**⚠️ `pnpm typecheck` 覆盖不到这个 selftest**:`scripts/tsconfig.json` 把
`./harness-eslint.selftest.ts` 放在 `exclude` 里(**既有缺口,非本刀引入**)。理由写在该文件
注释内:它 import `eslint.harness.mjs`,而后者顶部有 `// @ts-check`,拉进 TS 程序会暴露
2 处 implicit-any。**所以 typecheck 绿 ≠ 这个文件被检查过。** 该注释写的解除条件
(「拿到授权 → 注解那两行 → 从 exclude 删掉」)现已具备前两项,但删 exclude 需要
`scripts/tsconfig.json` 的**第三份授权**(redzone `ci-control-plane`),且不在第四轮 findings
范围内 —— **另立一小刀**,不混进本批(J2 已 +275 行,混进来会让跨模型评审更难做)。

**全仓实测规模**(本批次 J1 修完后):**641 处 / 56 文件**,全部在 `src/`(`test/` 与
`prisma/` 零违规)。两套独立实现(esquery selector + 直接走 AST)结果逐字一致。
分布前十(供后续按批次排期):

| 模块            | 处  | 模块                   | 处  |
| --------------- | --- | ---------------------- | --- |
| activities      | 95  | activity-registrations | 29  |
| member-profiles | 67  | content                | 26  |
| role-bindings   | 36  | announcement-import    | 25  |
| recruitment     | 33  | member-departments     | 23  |
| positions       | 32  | attendances            | 22  |

(J1 修完后 certificates 40→17、recruitment 49→33;全仓 680→641,恰好等于本批次收口的 39 处。)

**为什么用棘轮而不是一次改完**:641 处 = 一个没人能评审的超大 diff,而跨模型评审是本仓
唯一兜底。棘轮让「新写的代码不能再犯」立刻生效,存量按批次还 —— 上表就是排期依据。

#### ✅ 第三轮独立评审 findings 已全部关闭(`main@1560c761`;H1–H5 = [#848](https://github.com/BA7IEE/srvf-nest-api/pull/848)–[#852](https://github.com/BA7IEE/srvf-nest-api/pull/852))

**第二轮 4 条已全部修复并经第三轮复核关闭**(G1–G4 = [#843](https://github.com/BA7IEE/srvf-nest-api/pull/843)–[#846](https://github.com/BA7IEE/srvf-nest-api/pull/846),零 schema,Migration 恒 67)。
本轮 5 条**无 P0**,主会话逐条复现,**全部属实**;其中第 ④ 条主会话判定比外部报告**更严重**(P2 → P1)。

**修复已于 2026-07-31 全部合入**(H1–H5 = [#848](https://github.com/BA7IEE/srvf-nest-api/pull/848)–[#852](https://github.com/BA7IEE/srvf-nest-api/pull/852),零 schema,**Migration 恒 67**,`handoff/admin-web.md` 与 `current-state.md` 零改动)。
两处**修复结果与报告原文不同**,已在各自 PR body 展开,复审时请重点看:

- **③ 的实际范围更宽**:不止 create 的 4 个字段、也不止 500。Update DTO 有同一形状,且
  `kind` / `categoryCode` 传 `null` 返 **200 且什么都没改**(`dto.kind ?? before.kind` 把 null 当没传吞掉)——
  静默忽略比 500 更难查。共 9 个字段收口([#850](https://github.com/BA7IEE/srvf-nest-api/pull/850))。
- **④ 的可达路径不成立**(实测,非推断):报告给的「建 DRAFT FAMILY A → 建 DRAFT FAMILY B 挂 A →
  改 A 挂 B」第二步就撞 `assertParentUsable` 的**父不能是 DRAFT**(18034,既有 e2e 一直锁着);
  报告只核了「父必为 FAMILY」「同 categoryCode」两条。进一步:**通过 API 构造不出环** ——
  设边要求父已启用、子从未启用,沿环一圈得到首次启用时刻严格递减又必须回到自己,矛盾。
  **但那是三条互不相关的规则撞出来的涌现性质**,三处代码里没有一个字提到「环」,
  放松任一条(例如允许 DRAFT 父)环即刻可达且无测试会红 —— 故仍补了显式祖先链遍历 +
  6 条单测,并删掉失效论证([#851](https://github.com/BA7IEE/srvf-nest-api/pull/851))。
  **若维护者认为「为不可达场景加防」不值得,可只保留删注释那一半。**

| #                                | 落点                                       | 机制(已复现)                                                                                                                                                                                                                                                   | 后果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1**                           | `evaluate(false)` / `resolveManual(false)` | 只写 `recruitment_applications.statusCode = rejected`,**零 Claim 级联**。而 `APP_INACTIVE_STATUS_CODES` 含 `REJECTED` ⇒ `lockActiveApplicationOrThrow` 之后拒绝一切 Claim 写路径                                                                               | 该报名下的 `APPROVED` Claim **永久卡在非终态**:不能撤回审核 / 拒绝 / 重传 / 撤回 / 转 PROMOTED。留存 SOP 只扫 `status IN ('REJECTED','WITHDRAWN')` ⇒ **永远清理不到**;证据闸 `CLAIM_EVIDENCE_DENIED` 只含 `{WITHDRAWN, PROMOTED}` ⇒ **图片仍可签 URL**。⚠️ 与既有全库不变量**直接矛盾** —— `recruitment-certificate-concurrency` 断言「`a.statusCode IN ('promoted','withdrawn','rejected')` 下不得有非终态 Claim」,而 G1 新增的正常淘汰用例正好造出 `rejected + APPROVED`。两份 spec 在各自派生库里都绿,**合起来系统规则不能同时成立** |
| **P1**                           | `updateApplication()`                      | G2 改用 `lockActiveApplicationOrThrow`,该函数把 `rejected / withdrawn / promoted` 一律视为终态返 28041                                                                                                                                                         | canonical [`handoff/admin-web.md`](../handoff/admin-web.md) 仍写「非身份字段**恒可改**…promoted/已脱敏行 → 28041」,**没说 rejected/withdrawn**。运行时与 canonical 契约分叉。**需要维护者在 A(恢复可改,仅按 promoted + sensitivePurgedAt 拒)/ B(终态一律不可改,同步改 handoff+DTO+前端+CHANGELOG breaking)之间拍板** —— 「实现变了」不自动等于「契约变了」                                                                                                                                                                              |
| **P1**                           | `POST /certificate-standards`              | `CreateCertificateStandardDto` 的 `levelCode`/`parentId`(以及 `isInternal`/`sortOrder`)仍是 `@IsOptional() @IsString()`;`@IsOptional()` 对 `null` 与 `undefined` 都跳过校验,而 service 判据是 `!== undefined` ⇒ 显式 `null` 穿过 DTO 后进入字典 / 父节点查询   | **500 而非 400**。G4 只改了文档示例不再发 `null`,没修接口本身。修法:`@ValidateIf((_o, v) => v !== undefined)` 让 `null` 落进 `@IsString()`                                                                                                                                                                                                                                                                                                                                                                                              |
| **P1**(外部报告列 P2,主会话上调) | `certificate-standards.service.ts:297`     | 注释写「`parentId` 只在 create 期可设、Update DTO 不含它 —— 因此循环在结构上不可能形成」。**这是一条安全论证**,而 [`amendments A-3`](../archive/reviews/certificate-standard-library-t0-amendments.md) 已放开 DRAFT 改 `parentId`,论证失效。全文件**零环检查** | 冻结稿 §5.2「禁止形成父子循环」**零执法**且可达(建 FAMILY A → 建 FAMILY B 挂 A → DRAFT 期改 A 挂 B;父必为 FAMILY ✓、同 categoryCode ✓ 两条约束都过)。成环后两节点互为子节点 ⇒ 删除守卫恒非零 ⇒ **谁都删不掉**(与第 ① 条同一「冻死」形状);admin-web 要渲染树,递归渲染会挂。**后端本身是扁平一层、不递归,所以不会挂服务** —— 但注释会阻止下一个人补上这道校验                                                                                                                                                                             |
| **P2**                           | 同文件 `:30` / `:373-376`                  | 「Update DTO 刻意不含 kind/categoryCode/levelCode/parentId/isInternal」「update(仅文案与排序)」「身份字段不在白名单」—— 而紧接着的执行代码正在完整处理这五个字段                                                                                               | 本仓维护者看不懂代码、长期由 AI 维护,**错误注释会指挥下一个模型删掉正确实现**。这是本项目第四次抓到「注释≠执行位」                                                                                                                                                                                                                                                                                                                                                                                                                      |

**修复落点**(零 schema,逐条对齐上表):

| #   | PR                                                       | 落地内容                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①   | [#848](https://github.com/BA7IEE/srvf-nest-api/pull/848) | 抽 `withdrawClaimsOnApplicationTerminal`,**写终态的 4 条路径全部共用**(sweep 结果:评定淘汰 / 人工核验不通过此前零级联,整份撤销与发号各有一份内联实现,已收编)。同事务锁 Claim(id ASC)转 `WITHDRAWN`、保留 `PROMOTED`、审计只记条数。**曾矛盾的两条不变量现同时绿**:全库巡检已进 G1 那一组 |
| ②   | [#849](https://github.com/BA7IEE/srvf-nest-api/pull/849) | **拍板方案 A** —— `updateApplication` 改用 `lockApplicationRow`,只按 `promoted` + `sensitivePurgedAt` 两道锁后守卫 + CAS 拒。`rejected`/`withdrawn` 恢复可改非身份字段。**canonical handoff 零改动**(运行时回到它已写着的契约,净变化为零);G2 的「改资料 vs 发号」并发用例仍绿            |
| ③   | [#850](https://github.com/BA7IEE/srvf-nest-api/pull/850) | `@OmittableOnly()`(= `@ValidateIf(v !== undefined)`)收口 **9 个字段** × 真 HTTP `null → 400`;`description` 单独判定为**允许 null**(DB 可空、运行时一直如此,只是让 DTO/OpenAPI 说出来,行为零变化);ops 初始化文档同步订正                                                                  |
| ④   | [#851](https://github.com/BA7IEE/srvf-nest-api/pull/851) | 祖先链遍历 `assertParentChainAcyclic`(纯算法 + 注入式加载器,policy 文件仍零 DB)接进 create/update 两条路径,**排在父级校验之前**以保住 18019 错码;删失效论证;6 单测 + 3 e2e                                                                                                               |
| ⑤   | [#852](https://github.com/BA7IEE/srvf-nest-api/pull/852) | 清掉两处「注释≠执行位」;`certificate-standards.service.ts` **全部 18 段注释逐条核过**,其余每条描述约束的注释都对上了执行位与执行它的测试(对照表在 PR body)                                                                                                                               |

**修完仍须第四轮跨模型评审**(SOP [§1.6](codex-review-sop.md)),门禁由维护者解除 —— 本批次**未**触碰 `current-state.md` 的 🔴 NO-GO。

<details><summary>第二轮 findings(已全部关闭,保留作历史)</summary>

#### 第二轮独立评审(2026-07-30,`main@2998a708`)

四条 findings 主会话**已逐条复现机制,全部属实**。**根因一句话**:证书相关的新写路径已经统一使用报名锁
(`lockApplicationRow` / `lockOwnActiveApplicationOrThrow`),但**评定、换绑、后台改资料这些旧入口还没接入同一串行点**。
发号内核本身在 F1 已修好(`claimAtStatus` + `WHERE statusCode='publicity'` 条件行锁 + 锁后复读 + CAS),
**这轮不是上轮问题反复**。

| #      | 落点                                                                                              | 机制(已复现)                                                                                                                                                                   | 后果                                                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | `recruitment-application-review.service.ts` `evaluate()`                                          | `findFirst`(无 `FOR UPDATE`)读 `statusCode` → 算 `nextStatus` → `update({ where: { id } })` 无条件写。无锁、无锁后复读、无 CAS                                                 | 可把并发提交的 `withdrawn`、或证书门槛回退后的 `verified`,**覆盖回 `publicity`**。发号内核只复核「当前是不是 publicity」,且**不要求存在 APPROVED Claim** ⇒ **已撤销的报名仍可能被建 Member/User 并发出永久编号**        |
| **P1** | 同文件 `updateApplication()`;`recruitment-identity.service.ts` `rebindWechat()` / `rebindPhone()` | 三处都未接入 `lockApplicationRow`。`updateApplication` 的 `promoted` / `sensitivePurgedAt` 守卫建立在**锁前**的 `findFirst` 上;换绑事务内只做冲突查询后按 `id` 无条件 `update` | 发号已脱敏(`sensitivePurgedAt` 非空、PII 已清)之后,等锁的旧请求仍可**把手机 / openid / 地址 / 换绑历史写回**;而 `sensitivePurgedAt` 非空会让留存清理**永远跳过该行**                                                    |
| **P1** | `certificates.service.ts` `verify()`                                                              | `before` 读于 `claimAtStatus()` **之前**,`alreadyExpired` 用的就是这份锁前快照,锁后未复读                                                                                      | 并发 PATCH 改到期日 → 核验写错终态(两个方向都会错)。与 F1 修掉的「发号用锁前快照」是同一个病,只是没修到这儿                                                                                                             |
| **P2** | `ops/certificate-standard-library-initialization.md`                                              | 示例传 `"levelCode": null` / `"parentId": null`,而 `certificate-standards.service.ts` 分支判据是 `!== undefined` —— 显式 `null` 会进字典 / 父节点查询分支                      | 示例**不能按原样执行**。同文档「先建 FAMILY 还是先建 CREDENTIAL」一段仍写「`parentId` 只能创建时设、事后只能删掉重建」,与 [`amendments A-3`](../archive/reviews/certificate-standard-library-t0-amendments.md) 直接冲突 |

**修复范围**(零 schema,Migration 应恒 67):上表四个落点 + 三组真 PostgreSQL 并发 e2e ——
① 评定 vs 报名撤销 / Claim 撤回审核;② 换绑与后台改资料 vs 发号;③ PATCH 到期日 vs 核验(两个方向)。
外加全库巡检断言:`publicity` 报名不得存在证书门槛不完整的状态;`sensitivePurgedAt` 非空的报名不得被写回任何应清 PII。

**修复批次自己也要再过一轮跨模型评审**才允许发版(SOP [§1.6](codex-review-sop.md))。

</details>
- **⏸ 剩余挂账**(不属于本任务的代码范围,但没做完就不能算上线):
  - **发版**:#826–#834 与 F1–F6 全部未随版本发布(tag 仍是 v0.64.0)。
  - **PR-4b 的第 67 个 migration 未部署** —— 不可逆 contract,按 [`go-live runbook`](../ops/certificate-standard-library-go-live.md) 执行(停写 → 备份验证 → 探针 → migrate)。
  - **首批标准与认定规则:法规定义的那批已内置,队内认定的仍未建**(2026-08-25 维护者拍板的判据:「这个证书的内容,队里有得选吗?」有 ⇒ 人工建,没有 ⇒ 可内置)。已内置 = 业余无线电台操作技术能力验证证书 A/B/C(工信部令第 67 号);其余按 [`初始化 runbook`](../ops/certificate-standard-library-initialization.md);⚠️ `code` 打错不可挽回,且已内置的别重复建(撞 unique 会 409)。
  - **前端适配**:对外契约破坏清单见 [`handoff/admin-web.md`](../handoff/admin-web.md) §3.2 / §3.2.1。
- **原立项背景(保留)**:
  [`certificate-standard-library-t0-review.md`](../archive/reviews/certificate-standard-library-t0-review.md)(2026-07-29 拍板;v1.0 / v1.1 **废止**)。
- **要解决什么**:当前系统能录/审/拒/提醒证书,但答不出四个问题 —— 这是什么证 / 本队按什么规则认可 / 申请人交了什么原件 / 审核后确认了什么。四类事实拆为 `CertificateStandard`(证书身份,稳定 code)+ `CertificateRecognitionPolicy`(队内认定规则,可多版本)+ `RecruitmentCertificateClaim`(一证一行的原始申报,可暂不分类)+ `Certificate`(正式档案)。
- **拆分**:PR-0(冻结,本 PR 完成)→ PR-1(日期语义 + `certificate.read.sensitive`)→ PR-2(schema/权限/审计骨架)→ PR-3(Standard/Policy 管理 API)→ **PR-4a(写路径切换)+ PR-4b(删旧事实,同 release)**→ PR-5(证据读取 + 工作台)→ PR-6(前端联调)→ PR-7(release 收口)。
- **⚠️ 单向门**:整套方案「直接删列、不做兼容、不双写」的可行性,建立在 `Certificate = 0 行` 且 `招新证书 JSON = 0 行` 之上,**只在 production 未部署期间成立**。一旦上线跑完一轮招新,PR-4 就退化成 migration + 回填 + 双写兼容期。**这是本任务排在企业微信之前的唯一理由。**
- **⚠️ 跨仓破坏性变更**:门槛 `redCross` / `bsafe` 从「可人工标记」变为 **Claim 的只读派生投影**,`markThreshold` 传这两个 code 将返回业务错误(当前二者在 [`recruitment.constants.ts`](../../src/modules/recruitment/recruitment.constants.ts) `THRESHOLD_CODES` 中与 `patrol1/patrol2/training` 平级)。**`srvf-admin-web` 若已有该按钮,须同批适配**,不得等上线才发现。
- **档位**:C/D 混合;schema / migration / Permission seed / AuditLogEvent / 敏感读语义均须维护者红区授权。**每个 PR 开工前先跑 `pnpm harness:needs <写集>`**,把授权凑成一次请求。

</details>

### P1-25 企业微信接入(身份入口 + 工作台入口 + 通知通道) — **T1–T5B 代码全部合入;T6 文档就绪(2026-08-02);⏸ 剩下的全部是「维护者执行」,AI 无可做之事**

**状态**:⏸ 挂起(T1–T5B 代码全部合入、T6 文档就绪;剩下全是维护者执行〔企微后台配置 / migrate deploy / 开开关 / 工作台实跑 / 签两张 GO 单〕,AI 恒无权执行)

- **T6 纪要**(2026-08-02;**A 档 docs-only,`src/` 零行、`prisma/` 零行、零端点 / 零权限码 / 零 BizCode**):把冻结稿 §15 的生产切换硬门做成四份**带判据**的可执行文档。三条边界拍板:① T6 只出文档 —— §15 硬门绝大多数是维护者在企业微信后台与生产环境的手工动作,AI 物理碰不到;② **试点期运营五指标走 SQL 手查,不做只读 admin 端点**(真要面板等试点跑出结论再另立项);③「Workbench 主页」是企业微信工作台内的 **H5 落地页**,归前端仓 + 后台配置(D-WC-29),后端 OAuth 链 T3 已备齐,本期不新建端点。
  - **四份新文档**(全在 `docs/ops/`,不付恒读层预算):[`wecom-backend-configuration-sop.md`](../ops/wecom-backend-configuration-sop.md)(后台配置 + 身份链启用 + 回滚,含 §15.1 十五条勾选单)· [`wecom-pilot-playbook.md`](../ops/wecom-pilot-playbook.md)(六类构成 + A/B/C 三步 + 十项留证)· [`wecom-failure-injection-drills.md`](../ops/wecom-failure-injection-drills.md)(四类注入,复用 T5B 已有的 DEV_STUB `wecomerr-*` 前缀)· 扩充 [`wecom-message-channel-rollout.md`](../ops/wecom-message-channel-rollout.md)(§15.2 十二条 GO 单 + §15.4 排空回滚四步与判据 SQL)。
  - **写文档时从代码里读出的三条运维事实**(冻结稿没写,但决定操作顺序):① **`test-connection` 自己要求 `enabled=true`**(内部走 `routeFor`),所以「开总闸 → 诊断 → 开 `loginEnabled`」不是习惯而是唯一可行顺序,`enabled=true && loginEnabled=false && messageEnabled=false` 是刻意存在的**安全诊断态**;② **可信 IP 生效的正面判据 = `test-connection` 200 且 `tokenAcquired:true`**(60020 会让 gettoken 失败),反过来不成立;③ ⚠️ **六个配置类 errcode(40001/40013/40056/50001/50003/60020)在 SRVF 侧全部归一成 36030 且 errcode 不进日志** —— 这是刻意的(errmsg 与完整 URL 带凭证),代价是运维分不出是哪一条配错了,SOP 因此改用「逐项配置 + 逐项验证」的执行顺序换回可诊断性。
  - **一处计数订正**:goal 写「§15.2 十三条」,亲核实为 **十二条 bullet + 一句前置门**(「除身份链条件外」)。检查单按「门 + 12」出,不硬凑 13。
  - **诚实边界(写进剧本 §6)**:四类失败注入里**生产只能安全做 Worker crash 一类**;Provider 故障 / token 失效 / DB 故障在生产**没有安全注入手段**,只能在非生产用 DEV_STUB 完成并记录替代证据。签署时按这个口径写,不得写成「四类生产注入完成」。
  - **⏸ 剩余全部是维护者动作**:企业微信后台配置(建应用 / 可见范围 / 可信域名 / 可信 IP / 应用主页 URL)· 凭证获取与录入 · `prisma migrate deploy` · 开任何开关 · 工作台实跑 · 签署两张 GO 单与「扩大可见范围」。**AI 恒无权执行,不要在后续会话里尝试。**

- **T5B 纪要**(2026-08-02,#890;**未发版·未部署·`messageEnabled` 未开**):新增第四条推送渠道 `wecom`,复用既有 durable outbox,受众判定消费 T5A 两入口(第五条 eslint 规则冷 lint 绿即证零第二份口径)。**默认关两层判据各自 red-first 实测**:短路第一层(publish 前判开关)→ 恰好 4 条「默认关」用例红;短路第二层(Provider 前 `FOR SHARE` 锁后复读 `wecom_settings`)→ 恰好 1 条红;**两组红集不重叠**,故是两个独立判据而非同一闸被观测两次。第 69 migration = WeCom 独立 active-slot partial unique(按 `eventType` 分域;干净库重放 + seed 幂等两跑 + **双向阳性对照**:同 pair 第二条 wecom child 被 23505 拒 / 同 pair 的 **wechat** child 放行 —— 后者正是该索引必须独立的理由)。**零新端点 / 零新权限码 / 零新 BizCode / 零新 cron**(450/227/314/136/2 恒等,仅 Migration 68→69);既有 e2e spec 零修改,连坐 6 组 123 tests 全绿。
  - **交付中修掉一个真 bug**:暂态失败原本用 `intent.id` 落 delivery 行 ⇒ 下次重试撞上自己的幂等判据直接返回,「退避重试 8 次」退化成「第一次网络抖动即永久放弃」且现场毫无异常。已改为暂态走自动主键流水、只有终态占 `intent.id`。
  - **一条已记录偏离**(报告口径,非违规):冻结稿 §10.4 写「先按 identity 收窄再判可见性」,实现改成先算完整可见受众再取交集 —— child 集合逐字相同(逐人过滤,交集可交换),但只有后者拿得到运营指标①「SRVF 可见受众数」,而 §10.4 末条恰要求它与「identity 候选数」分开记录。
  - **条件项合规不触发**:goal DoD 写「新 BizCode 带来的契约 diff」,但冻结稿 §11.2 明写发送失败不污染 HTTP 端点 + 不新增 361xx ⇒ **零新 BizCode**,`docs:counts` 的 BizCode 314 恒等即机器自证。
  - **T5A 挂账的执法位已落地**:第五条 eslint 规则(#889)现由 T5B 实证 —— 新渠道全程零直引 `content.visibility` 原语。

- **T5A 纪要**:受众判定归一到 `notification-recipient-authorization.service.ts`(渠道无关批量判定 + Provider 前最终闸两入口,接缝签名在 #887 报告);两 PR 结构 = characterization(553 行矩阵)先合、重构 diff 零测试改动;管理层判定 3→0 处散点、TYPES 消费 3→1;**一条已记录偏离**:导出函数而非冻结稿字面的 @Injectable 类(既有 spec 手搓 new 所迫,文件名照冻结稿)。**三条现状留痕(只钉未修)**:软删闸仅 outbox 一道防线(新服务 :44 注释明载)、根候选含无 ACTIVE User 者(空转 child)、读侧不自查 User.status(闸在 JwtStrategy)。**待拍板执法位**:「新渠道必须消费这两个入口」尚无机器执法(S5 形状),建议第五条 eslint 规则 + 具名基线另立小刀。

- **T4 纪要**:softDelete / reopen 同事务撤销 active 绑定(唯一原语 `wecom-identity-revoke.ts`,三调用点);disable/enable/offboard 保留侧执行位=**整行快照相等含 updatedAt**;umbrella Audit extra 记 `wecomIdentitiesRevoked`;四计数恒等(450/227/314/136)、零 schema、FE 零适配。
- **T3 后置门禁**:可信域名只能由真实 OAuth 回跳验证(test-connection 判不了,§0.5 条 5)——开 `loginEnabled` 前须工作台实跑;FE 待适配(回跳落地页/未绑定页/admin-web 清除按钮)清单在 [`handoff/miniapp.md`](../handoff/miniapp.md) §1.3 与 [`handoff/admin-web.md`](../handoff/admin-web.md) §2.4。
- **已知 CI 竞态(复发即单开一刀,涉 `.github/workflows/**`红区)**:contract 与 e2e 在 shard 1 同 job 共用`app_test` 模板库,contract 侧连接未排空可撞 e2e globalSetup(#884 CI 出现一次假红,重跑即绿);对每个 PR 都潜在。
- **冻结评审稿**:[`archive/reviews/wecom-integration-t0-terminal-review.md`](../archive/reviews/wecom-integration-t0-terminal-review.md)(2026-07-29 维护者「按推荐」整体冻结 `D-WC-1..31`)。
- **终态**:单企业、单自建应用 Agent;`WecomIdentity → User → Member → SRVF Authz`;消息只走既有 Notification Outbox。**企业微信只回答「你是谁」,SRVF 继续回答「你能做什么」**。
- **拆分**:T0(冻结,本 PR 完成)→ T1(schema expand-only)→ T2(通道层 + 设置 + 连接诊断)→ T3(OAuth 登录/绑定/换绑/管理员清除)→ T4(User 生命周期闭环)→ T5A(受众判定重构,行为保持)→ T5B(WeCom 消息通道)→ T6(runbook + 10–30 人分层试点)。
- **⏸ 为什么排在后面**(2026-07-29 拍板):① 与 P1-24 同为 schema-touching,受 [`process.md §8`](../process.md) 「同一时刻至多一条 schema-touching lane」约束,不并行;② 写集在 Permission seed / AuditLogEvent / openapi / CODEMAP / RBAC_MAP / counts 上重叠;③ 本任务 expand-only、开关默认全 false,**何时做成本相同**,而 P1-24 有会关闭的单向门。
- **额外硬门**:身份链(T1–T4)可先落地;**消息链(T5B)的启用**必须等现有 Notification Outbox 在生产完成部署、Worker 同版本切换并通过硬门(见 [`current-state.md §2`](../current-state.md) Outbox 行)。代码可以先写,`messageEnabled` 默认 false。**代码已于 2026-08-02 写完并合入(#890),该硬门原样未解** —— 开启顺序、排空判据与回滚见 [`ops/wecom-message-channel-rollout.md`](../ops/wecom-message-channel-rollout.md);最硬的一条是 §10.8 混版本:旧 worker 会把 `notification.wecom-*` 判成 terminal dead,**dead 是终态,那条通知对那个人永远不会再发**,而现场看起来一切正常。
- **不做清单(节选)**:不写 `User.openid`、不接通讯录同步、不加第 3 个 cron、不引入 Redis/queue、不做 PC 浏览器扫码登录、不承诺 exactly-once。全文见评审稿 §0.3 与 §17。

### P1-22 入队专业队类型 / gate 定义配置化 — **⏸ 诉求触发再立项**

**状态**:⏸ 挂起(诉求触发再立项:新增第 5 种专业队、或运营需自行调 gate 与有效期时另立 D 档)

- **背景**(招新/入队十三项收口问题⑨):`PROFESSIONAL_GATE_CODES` / `GATE_VALIDITY` / `PROFESSIONAL_TEAM_GATE_BY_NODE_TYPE` 当前在 `team-join.constants.ts` 硬编码 4 种专业队及全部 gate 有效期;新增专业队、改 gate 或调整有效期都必须发后端版本。P⑦ 已拍板本 goal 只挂账,不顺手扩动态配置面。
- **候选方案**:D 档新增 gate 定义表(建议字段:`code`/`professional`/`validityType`/`validityYears`/`extendable`/`status`) + 专业队 nodeType→gate 映射表(建议字段:`nodeTypeCode`/`gateCode`/`status`),由 Query/Policy 层一次加载后供标 gate、进度派生与一键入队重校验共用;须同步设计 admin 配置端点、RBAC、audit、缓存失效与存量常量迁移/回滚方案,禁止只把其中一个消费者改成读表造成双轨。
- **触发条件**:业务提出新增第 5 种专业队、运营需自行调整 gate/有效期,或 node_type 约定开始跨版本频繁变化时单独立项。

### P1-23 `recruitment_applications.isForeigner` 历史 DB 列改名 — **⏸ 数据治理诉求触发再立项**

**状态**:⏸ 挂起(数据治理诉求触发再立项:外部 BI 直读该列、或合规要求物理列名也去除「外籍」误述时)

- **背景**(招新/入队十三项收口刀C2 遗留):API DTO/CSV/stats/audit 对外已统一改为 `isNonMainlandDocument` / `is_non_mainland_document`,含义锁定为「非大陆证件,不代表国籍」;仅 Prisma/DB 历史列仍名 `isForeigner`。直接 rename 属 D 档破坏性 schema 变更,本 goal 明确禁区,故不改列名。
- **候选方案**:先盘点所有 SQL/报表/导出/备份消费者,再做 Prisma field 映射过渡或单次 rename + 存量验证;同步 current-state/CODEMAP/留存 SOP 与回滚 SQL。不得先新增第二列长期双写。
- **触发条件**:外部 BI/报表开始直读该列,或合规审查要求物理字段名也去除“外籍”误述时单独立项。

### P1-26 并发写路径审计 findings 修复 — **6 🔴 + 2 🟡 已修 · A-R2 方案乙 · 整批复审 M1–M6 已收口 · S6 三处分叉 + GPS 审计口径已按拍板落地(全条关闭)**

**状态**:已收口(#862 #864 #867)

- **两份独立审计,同一范围、同一 base(`7b0f5c25`),都 report-only、零 `src/` 改动**:
  - **A · Claude 版** [`concurrency-write-path-audit.md`](../archive/reviews/concurrency-write-path-audit.md) —— **56 落点 / 🔴2 / 🟡2 / 🟢52**;
    审计轴 = **逐行锁纪律**(S1「锁后不复读」在四模块**零命中**);S7 定义 = **锁的获取被绑在 authorization 分支上,另一条 surface 裸奔**。
  - **B · codex 版** [`concurrency-write-path-audit-codex.md`](../archive/reviews/concurrency-write-path-audit-codex.md) —— **64 落点 / 🔴5 / 🟡1 / 🟢58**;
    审计轴 = **跨行/跨聚合不变量**;S7 定义 = **跨行/跨聚合不变量没有共同线性化键**。
- ⚠️ **两份不是同一份报告的两个版本,是两次独立审计**。#854 合入了 A,#855 把 B 的摘要写进了指向 A 的台账条目,
  于是台账承诺的五条活 bug 在被链接的报告里一条都找不到;而 **B 的正文当时根本没进仓库**(只存在于一个工作区 stash)。本条目与本 PR 一并修正。
- **两轴都对,但只有 B 那根轴上有活 bug**:A 逐个方法核锁纪律,结论「锁用得对」经复核成立;
  B 问的是「每行都锁了,跨行不变量谁保证」。**主会话已实测确认 B 的 F2**:
  `computeContribution(tx, memberId, cycleYear)` 跨该成员当年**全部 Sheet** 聚合,而 `finalApprove` 只 claim 当前 Sheet ——
  两个并发终审各读 `before=3`、各算 `after=4`,谁都没观察到跨过 5 分,里程碑一条不发(教科书式 write skew)。
  **同一位置 A 标 🟢** —— 因为按「本方法的锁纪律」看它确实没错。
- **唯一被两份独立确认的**:Attendance Admin `edit` 只锁 Sheet、不锁 Activity/Registration(A 的 R1 = B 的 F1)。
  **交叉确认项优先级最高**,建议排在修复第一位。
- **B 的五条活 bug**:Attendance Admin `edit(records)` 可留下 cancelled Registration + live AttendanceRecord;两个不同 Sheet 的 `finalApprove` 可并发跨过 5 分阈值却零 milestone;`cancelMy` 可用锁前旧标题写 durable intent;Team Join `submit` 可在 Member 已入队后 create;final join 不收口同成员其它 live Application,可留下 frozen approved。
- **两份的 S7 定义不同,都是真形状**:A 的「锁绑在 authz 分支、另一 surface 裸奔」需**跨 surface 对照**才暴露;B 的「跨行/跨聚合不变量无共同线性化键」需**跨行**才暴露。两者都不在 S1–S6 里,建议一并纳入形状表。
- **B 的 S5 / S6 扫描**:确认 `attendance.recorded` “随事务回滚”注释没有执行位及 3 组 stale source comment;确认 Activity.capacity 递补、岗位候补隔离、自助取消通知范围共 3 处 canonical/runtime 分叉。方向须维护者拍板,不在并发修复中顺手调和。
- **B 的建议排序(其报告 §8,建议非执行)**:① Attendance Admin edit → ② Team Join submit+final join 同一 goal → ③ finalApprove 聚合 write-skew → ④ cancelMy 锁后 metadata → ⑤ submit 防御性复读。
- **B 的未审点名**(其报告 §9):`auth`/`authz`/限流(红线)· AuditLogs/Notification Outbox/Insurance 的模块内部 · notification worker 消费侧 · **并发 e2e 未跑**(5 条红均给出源码可复核交错;真实双连接 barrier spec 留给后续获授权修复 goal)。

#### 修复进度(2026-07-31;修复范围已由维护者以 goal 形式下达)

**6 条 🔴 逐条 —— 每条都先写 red-first 并发 e2e 复现交错,再修**(去重后 A-R1 = B-F1):

| 编号                                    | 复现结论                              | 修复落点                                                                                                                                                | red-first 证据                                                                           |
| --------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A-R1 = B-F1 · Admin `edit(records)`     | ✅ 交错成立                           | `attendances.service.ts` `edit`/`softDelete` **两条 surface 都取** Activity 聚合锁 + `claimAndRecheckRegistrations`(认领后复读复判)                     | 修复前:取消**成功提交**,edit 随后写入引用它的 live record → `cancelled 报名 + live 记录` |
| A-Y1 · Admin `softDelete` 缺锁          | ✅ 形状成立(后果止于误报 21033)       | 同上,与 `edit`/`resubmit` 收敛为同一写法                                                                                                                | 修复前:占住 Activity 行锁时 `softDelete` **不等待**,径直提交                             |
| B-Y1 · `submit` claim 后不复读          | ✅ 形状成立(当前被 Activity 根锁挡住) | 与 `edit` 共用 `claimAndRecheckRegistrations`,claim 后按同一批 id 复读并重判归属/状态/岗位时段                                                          | 防御性加固,无独立红(阻断条件见 B 报告 §5)                                                |
| B-F2 · `finalApprove` 里程碑 write skew | ✅ 交错成立(**已实测**)               | `finalApprove`/`reopen` 在读贡献快照前取共享 member 键 `lockMembersForWrite`                                                                            | 修复前:正式总分 **5 分**、milestone intent **0 条**                                      |
| B-F3 · `cancelMy` 锁前 metadata         | ✅ 交错成立                           | 活动标题/发布人改到 claim + 证据守卫**之后**读                                                                                                          | 修复前:intent body 落的是**旧标题**                                                      |
| B-F4 · Team Join `submit`               | ✅ 交错成立                           | `submit` 事务第一步取 member 键后再判「未入队」                                                                                                         | 修复前:一键入队在途时 submit **建行成功**,写入时人已是队员                               |
| B-F5 · final join 不级联同人申请        | ✅ 成立(不需并发)                     | final join 同事务按 `id ASC` 终结同人其它 live 申请为 `rejected` + `eliminationStage='already-enrolled'`,逐条写 `team-join-application.supersede` audit | 修复前:残留申请仍是 `joining`,全库巡检断言直接红                                         |

- **共同线性化键**:新增 `src/common/prisma/member-advisory-lock.util.ts` 的 `lockMembersForWrite` —— 队员维度**唯一**一把键(单参数 `hashtext(memberId)` advisory 空间);`TimeOverlapPolicy.lockMembersForOverlapCheck` 改为委托它,语义与调用位置零变化。
- **锁序**(修完后各路径持锁顺序,证明无环):
  - 考勤写:`Activity 行锁 → Sheet claim → Registration claim → member 键`(`submit`/`edit`/`softDelete`/`resubmit` 同向)
  - 考勤终审:`Sheet claim → member 键`(与考勤写同向:聚合行锁在前、member 键在后)
  - 入队:`member 键 → Application 行锁 → Cycle → source → Member 行锁 → 同人残留 Application`
    (键必须在**任何 Application 行锁之前**取:同一队员可同时有两条 approved 申请,两个终审各锁一条再反向争 Member + 同人级联 = 40P01;行锁图本身逐字不变)
  - 无环依据:入队路径从不请求 Activity/Sheet/Registration 行锁;考勤路径从不请求 Application/Cycle/Member 行锁。两族唯一的交点是 member 键,而任一族内取键顺序都由排序去重固定。
- **并发 e2e(全部真双 app 双连接 + 「两条独立连接」元断言)**:
  `attendance-admin-edit-registration-concurrency` · `team-join-enrollment-lifecycle-concurrency` ·
  `attendance-final-approve-contribution-milestone-concurrency` · `registration-cancel-my-locked-snapshot-concurrency`。
  含两条**全库巡检不变量**:① live 考勤记录不得挂在非 pass / 已软删报名上;② 已入队队员名下不得有 live 入队申请。
- **S5 已收口**:`attendance.recorded`「随事务回滚」是**错的**(它只是一次 Logger 输出,DB 回滚撤不回日志),注释已改正并指向 outbox 才是可回滚事件的落点;另 3 组 stale comment(App 报名「容量满拒绝」/「仅 pending|pass 可取消」、final join「消费评估延长期」)已按运行时改正。

##### A-R2 已拍板并落地 —— **方案乙:放行存量、掐断增量**(维护者 2026-07-31)

- **原缺陷**:`activities.cancel` 只把 `pending`/`waitlisted` 报名改 `cancelled`,**完全不碰 AttendanceSheet**;
  `submit` 有活动状态闸(20122),但 `edit`/`approve`/`finalApprove` 等九个写方法**从不读** `Activity.statusCode` ——
  已取消活动上的考勤单能一路走完审批并结算贡献值,喂进入队门槛。**不需要并发也可达**。
- **拍板语义(两半,缺一半就不是方案乙)**:
  - **放行存量** —— 取消前已提交的考勤单仍可 `approve → finalApprove` 并结算(工是真做了的,
    作废队员已提交的贡献代价更大);`resubmit`/`reopen`/`approve`/`finalApprove` 刻意**不**加活动状态闸。
  - **掐断增量** —— 贡献值的增量只有两条来源:新建 Sheet(`submit`,既有 20122 已拦)与
    改写既有 Sheet 的 records(`edit` 的 records 分支,本次新拦,**复用同一个 20122,零新增 BizCode**)。
- **落点**:`ActivityParticipationPolicy.canChangeAttendanceRecords`(唯一判定出口,**只拦 `cancelled`**,
  draft/published/completed 编辑行为逐字不变)+ `attendances.service.ts` `edit` records 分支;
  该读位于 K1 的 Activity `FOR UPDATE` 之内,并发 cancel 挤不进闸旁。
- **契约变化(前端需知)**:`PATCH /api/admin/v1/attendance-sheets/:id` 与
  `PATCH /api/app/v1/my/managed-activities/:activityId/attendance-sheets/:sheetId`
  在活动已取消时**新增返回 20122**(仅当请求体带 `records`);两处 `@ApiBizErrorResponse` 与 openapi 已同步。
- **执行位**:`test/e2e/attendance-cancelled-activity-increment-gate.e2e-spec.ts`(5 条,含全库巡检:
  已取消活动上的考勤单 records 数不得增长)。修复前「掐断增量②」与巡检两条**都红**。
- **刻意未做**:`cancel` **不**级联终结既有考勤单(那是方案甲),`pass` 报名也仍留在 `pass`。

##### ✅ S6 分叉与 GPS 口径已拍板并落地(2026-08-01,维护者「都按推荐」)

1. **S6 四处 canonical/runtime 分叉**(逐处「改文档还是改代码」):
   | # | canonical | runtime | 现状 |
   |---|---|---|---|
   | A-S6 | `handoff/admin-web.md:80` / `miniapp.md:30`:有未撤销考勤记录的报名一定取消不了(21033) | 曾可被 Admin `edit` 并发绕过 | ✅ **已随 K1 核销**(运行时现已兑现文档,文档未改) |
   | B-D1 | `admin-web.md:73`:有 live Position 时编辑 `Activity.capacity` **不再**触发递补 | `activities.service.ts` 仍算 delta 并调跨岗位递补 | ✅ **按文档改代码** —— 有 live 岗位时 `update` 不再算 delta、不再递补;无岗位活动逐字保持。App change-proposal `applier` 同口径(它原先也全局一把梭) |
   | B-D2 | `admin-web.md:73` / `miniapp.md:108-111`:A 岗释放/扩容只递补 A 岗 | `activity-waitlist-promotion.ts` preferred 队列空后进入其它有余量岗位的全局 FIFO fallback | ✅ **按文档改代码** —— fallback 整体删除;`promoteActivityWaitlist` 成为全仓唯一出队循环，capacity 版只多算预算后委托它 |
   | B-D3 | `admin-web.md:198,460` / `miniapp.md:65`:只有「取消**已通过**报名」才发 `activity-changed` | pending/pass/waitlisted 自助取消都无条件 enqueue owner intent | ✅ **按文档改代码** —— `cancelMy` 只在 `pass` 时 enqueue;取消 pass 的 intent 形状逐字不变 |
2. **canonical 缺定义 → 已定义并落执行位**:签到/签退**成功豁免** AuditLog(事实记录 = `ActivityCheckIn` 行本身),
   **管理端改/删必审**。定义已写入 `docs/handoff/miniapp.md` + `admin-web.md` 与 `attendances/CLAUDE.md`。
   **sweep 结论:`ActivityCheckIn` 全仓恰 2 处写调用,都在 `app-activity-check-ins.service.ts`(自助 create / updateMany);
   管理端零写路径**(只经 `activity-check-in-query.service.ts` 只读)—— 故**无审计缺口可补,AuditLogEvent 恒 132 不变(+0)**。
   两侧执行位:豁免钉在 `app-activity-check-ins.e2e-spec.ts`(合法打卡前后 `auditLog.count()` 不变,**本就已存在**);
   写路径集合钉在新增 `activity-check-in-audit-policy.spec.ts`(出现第三处写调用或裸 SQL 写即红,已用一次性探针实测触发)。

- **本次未做**:`cancel` 不级联既有考勤单、`pass` 报名仍留 `pass`(方案乙刻意)· `certificates`/`recruitment`/`auth`/`authz`/限流未碰(goal 禁区)· 零 schema(Migration 恒 67)。
- **S6 收口刀本次未做**:有 live 岗位活动上的**历史无岗位候补会滞留**(拍板接受:队员可自行取消后重报并选岗，21035 会逼他选)——
  不做存量数据订正,也不新开"手动安排候补"端点(本仓「候补不开手动端点」铁律未松)。`activity-positions.service.ts` 的岗位扩容递补**本就只认本岗**,零改动。

##### 整批复审收口 M1–M6(2026-08-01;两份独立评审去重 6 P1 + 2 P2,无 P0)

- **M1 · markGate / evaluate 接 member-first 锁序**:两者都按 `computeContribution` 的读数做状态迁移,
  而那是**跨 Sheet 的 member 聚合** —— 与 attendances 的 `finalApprove`/`reopen` 是同一份事实的三个写方。
  抽唯一入口 `lockMemberThenApplication`(预读 memberId → `lockMembersForWrite` → Application `FOR UPDATE` →
  复读复核),`claimAtStatus` 随之退场(锁后读即 authoritative,它的「与锁前读数一致」断言没有对象了)。
  **反序实测就是 40P01**:`test/e2e/team-join-gate-evaluate-member-lock-concurrency.e2e-spec.ts` 用例 ⑤ ——
  把键挪到行锁之后,final join 持键在步骤 9 反向争同人 sibling 行锁,两进程互等,两条参数化用例全红。
- **M2 · 入队身份收口到唯一 transition**:`isUnenrolledVolunteer` 是 live 申请**唯一**的走通前提。
  sweep 出 8 个能把它翻 false 的写方(`members.update(gradeCode)`/`updateStatus(INACTIVE)`、
  `member-departments.set|remove`、`memberships.create(PRIMARY)|update(type)|end|transfer(PRIMARY)`),
  按拍板一律**拒绝**(新码 **28211**,不自动终结、不静默放行)。闸落在
  `src/modules/team-join/team-join-enrollment-invariant.ts`,必须排在 `lockMemberLifecycle` 之前(锁序理由见文件注释)。
  ⚠️ **行为变更**,已登记 handoff。
- **M3 · finalApprove 批量化 + 隔离级别显式化 + 有界锁等待**:
  贡献值快照与 outbox intent 全部批量(封顶核抽 `capByBeijingDay`,单人 / 批量共用,**不复制 cap 算法**);
  200 人考勤单实测 **810 → <40 次 SQL**(与人数无关)。`lockMembersForWrite` 所在的 8 个事务改走
  `runMemberLinearizedTransaction`:显式 `ReadCommitted` + `SET LOCAL lock_timeout`(超时 → **40901**,不再 P2028→50000)。
  **RR 是真前提**:把库默认改成 `repeatable read` 后去掉那一行,milestone intent 由 1 条变 **0 条** —— write skew 完整复活。
- **M4 · 棘轮注册表 + 三洞封堵**:新增 `harness/ratchet-registry.json`,裁判改为**遍历注册表**;
  基线被删 / 改名 = 硬失败(上一版判成「HEAD = ∅ ⊆ BASE 成立」,而 lint 跑在 PR 自己的树上);
  注册表自身只可增不可删。别名解析下沉 `eslint-rules/decorator-identity.mjs`,补齐 namespace /
  局部中转 / re-export 三种写法。第 17 条 `@Param('id')` 升格为自定义规则 `srvf/no-param-id-string`,
  存量 **70 处 / 19 文件**(评审说的 70 是对的,原注释「71」已漂)按「类名.方法名.参数名」逐条冻结 ——
  原先是整文件豁免 + 一句没有执行位的「只减不增」。
- **M5 · 两条 P2**:F5 双向 barrier(`join × updateTargets|markGate|evaluate` × 两个方向)——
  **它抓到了一个真 40P01**:App 自助 `updateTargets` 持 sibling 行锁后写 audit,而 `audit_logs.actorUserId`
  的 FK 要在**本人 User 行**上取 `FOR KEY SHARE`,那一行正被 final join 的 `lockLinkedUserLifecycle` 攥着;
  final join 又在步骤 9 反向争 sibling 行锁。修法同 M1:`updateTargets` 也走 member-first,
  **至此全部 team-join 写路径同序**。另删 `join` 端点 Swagger 里已废止的「综合评估本轮有效/延长期」
  (approved 资格不随轮关闭失效),contract snapshot 与 openapi 同步。
- **M6**:本条 + `current-state §4`。
- **测试**:新增 3 个并发 spec(M1 7 例 / M2 11 例 / M3 4 例)+ F5 6 例;
  既有白盒 barrier 的**观测点随锁序翻面**(`team-join.e2e` / `team-join-app.e2e`:
  `FOR NO KEY UPDATE` → `FOR UPDATE` / `pg_advisory_xact_lock`),**结果断言一字未动**;
  outbox 回滚用例的打桩位置随批量化下移到 `enqueueMany`,回滚不变式不变。
- **变异对照(每刀都做,修复前后各跑一次)**:M1 去键 6/7 红、反序 2/2 红 · M2 去闸 9/11 红 ·
  M3 去批量 810 次 SQL、去 RC 0 条 intent、去有界等待挂死 · M4 四种绕过全被裁判拒 + 名单内新增裸 `:id` lint 红。
- **状态**:**6 P1 + 2 P2 已修并有 red-first 证据;M5 顺带修掉一个新发现的 40P01**。
  🔴 **NO-GO 不解除**,本条目关闭前仍须过跨模型评审(SOP §1.6)。

- **状态**:**6 🔴 + 2 🟡 已修并有 red-first 证据;A-R2 已按方案乙落地;S6 三处分叉 + GPS 审计口径已按拍板落地(均改代码兑现文档,⚠️行为变更)**。本条目**关闭前须过跨模型评审**(SOP §1.6)。

### P2-6 #399 review P2 修复残余(4 项;**均无当前运行时危害,诉求/接线时处理**) — 2026-06-20 收口登记

**状态**:⏸ 挂起(4 项残余均无当前运行时危害,已「接受+登记」;COS / 腾讯云实名核验等外部通道接通、或 attachment.other 接 enforcement 时再处理)

> #399 全仓 review P2 六项已修(#400-#404,见 [`current-state §4`](../current-state.md) + 冻结报告顶部 ✅);以下为修复时显式接受、留待后续的残余:

- **F2 残余:attachment key owner-绑定**(P3)— F2 现把 create() 的 key 约束到 `attachments/<envPrefix>/` 派生格式正则,关闭「任意 COS 路径」面;残余 = 命名空间内、已知**完整 96-bit 随机段** key 仍可签(已知即已有权)。彻底闭合 = key↔owner 派生绑定 / 弃用模式 A 全量走模式 B(upload-url + HMAC token)。**COS 休眠,运维接通前非紧急**。
- **F1 关联:attachment.`*.other` 接 enforcement 时复核保留集**(P3)— **8 条**(review #484 G26 true-up:实测非「11」)`attachment.*.other` 权限码(member/certificate 两 owner × upload/view/update/delete 四动作);**PR7 起 `group-manager` 已绑其中 4 条**(`upload`/`view` × member/certificate,设计内决定非疏漏——绑了也不授能力因全 8 条均无 enforcement,scoping 对);余 4 条(`update`/`delete` × member/certificate)当前 seed 不绑任何 meta 角色。**将来 attachment.other 接线启用 enforcement 时**,需复核是否纳入 F1 `RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES`(`seed-rbac.e2e` 漂移哨兵 + 常量 completeness 测试会抓不一致)。
- **F5/F6 关联:dev-only 依赖 CVE**(P3)— ~~`fast-uri`(`@nestjs/cli>…>ajv`,path-traversal/host-confusion high)~~ **✅ 已随 review #484 G25 批的全局 `fast-uri` override 一并解决(2026-07-03;见下)**;~~`@types/supertest>…>form-data`(CRLF high)~~ **✅ 已修复**:当前 `@types/supertest@7.2.0 → @types/superagent@8.1.9 → form-data@4.0.5`,`pnpm why form-data` 可复核该 dev 链已解析到修复版。**+ `cos>fast-xml-parser` <5.7.0 moderate**(XMLBuilder 注入;需 4→5 **breaking major**,cos 仅解析腾讯云响应、不以不可信输入构造 XML,低危,本批拍板范围外,现状不变)。
- **F18(报告 §3):CI `pnpm audit` 门禁** ✅(2026-07-23)— 已有独立 `Production dependency audit` workflow，支持最终 SHA 手工 dispatch 与 `v*` tag 自动触发，固定执行 `pnpm audit:production` 并以 high/critical 为硬门；#750 移除无依赖安装场景下的无效 pnpm cache，确保 audit 成功后 post-job 仍整体绿色。moderate/low 继续逐条登记，不以 exit code 静默接受。
- **review #484 G10/G25:生产可达依赖 CVE overrides 收口** ✅(本 PR,2026-07-03;`pnpm audit -P` **9 → 3**)——**G10(已修)**:`qs`(经 `@nestjs/platform-express>express`,DoS)+ `js-yaml`(经 `@nestjs/swagger`,DoS)两条生产可达 moderate CVE 已通过 `pnpm.overrides` 收口(`qs` 全局 `^6.15.2` 同时覆盖 COS `request>qs` 路径;`js-yaml` 因树上另有不相关 `3.14.2` 消费者,改用 `@nestjs/swagger>js-yaml` scoped `^4.2.0` 避免误伤)。**G25(best-effort,部分收口)**:COS `request` 传递链——`tough-cookie`(`request>tough-cookie` `^4.1.3`)/ `ajv`(`conf>ajv` `^8.18.0`)/ `uuid`(仅 `tencentcloud-sdk-nodejs-common>uuid` `^11.1.1` 路径)三项已 override 收口。**残留(逐条注明,均非本批可解)**:① `request` 本体(SSRF,`.>cos-nodejs-sdk-v5>request`)——advisory 明示 patched 版本 `<0.0.0`(即无解),upstream 已弃用永不再发版,**等 COS SDK 换传输层**(或弃用 `cos-nodejs-sdk-v5`)才可能消除;② `uuid` 经 `request>uuid` 路径——**曾尝试 override 到 `^11.1.1` 但导致 2 个 unit 测试套件(`attachments.service.spec.ts` / `storage-provider.router.spec.ts`)整体加载失败**,根因是 `request` 自身冻结代码 `lib/auth.js` 用旧式深路径 `require('uuid/v4')`(uuid 7.x 起废弃该子路径导出),与 CVE patched 下限 `>=11.1.1` **结构性不可兼容**(无论选哪个 ≥11.1.1 版本都会炸),已撤销该条 override,不硬上;③ `fast-xml-parser`(`.>cos-nodejs-sdk-v5>fast-xml-parser`)——现状不变,见上 F5/F6 行(4→5 major,本批范围外)。**副作用(已处理)**:`ajv` override 到 8.x 后,ajv 自身传递依赖 `fast-uri` 引入 2 条**更高severity**(high)的新 CVE(path-traversal + host-confusion);已追加全局 `fast-uri: ^3.1.2` override 一并解决(全树仅此一个 fast-uri 消费来源 `ajv`,零冲突),此举同时消除了上面 F5/F6 登记的 dev-only fast-uri 项。回归自证:build/lint/typecheck 0 错误,unit 71 suites/2140 全绿,contract 525 全绿(snapshot 零 diff),full e2e 123 suites/2438 全绿。

- **v0.61.0 `fast-uri` 安全补丁** ✅(2026-07-23,#749)— 上述 `^3.1.2` 是 2026-07-03 初次 override 的历史值；当前已提升为 `^3.1.4`，production graph 唯一解析到 `fast-uri@3.1.4`，消除 `cos-nodejs-sdk-v5 > conf > ajv` 链的 `GHSA-v2hh-gcrm-f6hx` High。COS SDK/conf/ajv 未升级；审计仍仅有与 v0.60.0 完全相同的 3 个 COS 传递链 moderate。

### P2-7 #399 review P3 处理残余(接受+登记 2 项;**均无当前运行时危害**) — 2026-06-20 收口登记

**状态**:⏸ 挂起(2 项残余均无当前运行时危害,已「接受+登记」;真实实名核验通道接通 / seed 字典治理时一并处理)

> #399 §3 的 13 项 P3:**9 项已修**(#409-#413,见归档区 + 冻结报告 ✅ P3 处理状态)、**1 项已完成**(F18 CI audit gate,见上 P2-6 末项)、**1 项已完成移入已完成项归档区**(F13,见文末;review #484 G27),以下 2 项 R0 triage 复核后**接受+登记**:

- **F7 付费核验 cost-DoS**(P3)— 同 openid 可用不同伪造身份证号无限提交、每条直达付费实名核验(去重键 `(cycleId,idCardNumber)` 无 per-openid 上限),与已接受的 28003 枚举面**同源**(current-state §4)。**真实腾讯云实名核验休眠(DevStub 免费)→ 今日零成本**;接通才激活(类 F2/COS 接通前非紧急)。彻底修 = per-openid 配额(改报名去重语义,属产品决策)→ **真实通道接通触发再评**。
- **F8 promote 写字典码契约**(P3)— promote 写 `MemberProfile.genderCode`/`documentTypeCode` 不经 canonical 字典校验。**R0 复核降级**:`isForeignDocument` 令非 `mainland_id` 即 foreign(不进一键发号),故 promote 只写固定 canonical 码 `mainland_id`/`male`/`female`(身份证派生 / 非用户可控,**无 F3 式注入污染**),且 profile 码当前无字典校验消费点 → **零运行时危害**。真修 = 保证 prod 字典 seed 含 `male`/`female`/`mainland_id` item code(**seed/ops 不变量**;加 promote 断言反会把潜在不一致硬化成 promote 失败、且 demo seed `demo-*` 会打挂既有 e2e)→ seed/字典治理时一并保障。

### P2-8 `storage-settings-bootstrap` 报错文案把权限错误说成 JSON 语法错误 — 2026-08-20 真机实测查出 ✅ 已收口(2026-08-23)

**状态**:已收口(#1162)

> 第二阶段真机部署(维护者实测,`docs/ops/server-deployment-runbook-stage2.md` §2 D-2)踩出。
> **零运行时危害**(只影响一次性离线运维动作),但**实付了一轮白查的时间**。

- **缺陷**:`src/modules/storage/storage-settings-bootstrap.ts:215-217` 把 `readFileSync()` 与 `JSON.parse()` 放在同一个 `try`、共用一个 `catch`,统一抛「`config-file 不是合法 JSON`」。⇒ 配置文件按安全要求设为 `600 root:root`、而 runner 镜像是 `USER node`(uid 1000)读不了时,**权限错误被报成 JSON 语法错误**。实测方在服务器上 `python3 -m json.tool` 验 JSON 完全合法,于是照着错误信息白查一轮。
- **已做的**:runbook §2 D-2 已补 `--user 0:0` 与「报 JSON 错先怀疑权限」的对照表,运维侧不再被绊住。
- **~~待做(本条)~~ ✅ 已做**:两种失败已拆成两段两句话 —— 读失败报「无法读取 config-file(检查权限 / 属主 / 路径)」,解析失败才报「不是合法 JSON」。同文件 `new URL()` 那处按本条原文**刻意未动**(只有一个失败原因),并被当作判据的假阳性对照样本。
- **~~为什么登记而不是当场修~~**:#1048 已落地,串行道空(收口时 open PR = 0),前提解除。
- **缺陷类**:「把不同失败原因合并成一句话」。**已做成机器闸** —— `src/modules/storage/merged-failure-diagnostics.criteria.spec.ts`(11 条):结构性扫 AST,断言本模块内没有 `catch` 同时盖住「环境类失败」与「内容类失败」。变异对拍:合回一个 `catch` ⇒ 类闸 + 定点锚双双红;`new URL()` 那处保持原样 ⇒ 两条假阳性对照全程绿。

- 🔴 **扫描面只到 `src/modules/storage/**`,全仓是已知敞口(本条留给后来人的账)**。收口时对 `src/` 全仓 991 个 `.ts` 实测了三种判据形状,读数如下 —— **扩面前请重测,别照抄结论**:

  | 判据形状 | 全仓命中 | 结论 |
  |---|---|---|
  | 一个 `try` 里有 ≥2 个调用 | **131** | 粗到没有意义(链式调用、spec 里的 `expect` 全算进去) |
  | + `catch` 丢弃 error 且只抛一句固定话 | **15** | 仍含大量**故意**合并的路径 |
  | + 跨「环境类」与「内容类」两类失败 | 本模块 **1**(即本条) | ✅ 已采用,只在 storage 模块执法 |

  ⚠️ **那 15 处的大多数是「故意合并且合并是对的」** —— `attendance-qr-token` / `attendance-member-credential-token` / `attendance-offline-package-token` / `identity-step-up` 全是**令牌校验路径**:把「base64 坏了」和「签名不对」分开报 = 给攻击者送一个预言机。**合并在那里是安全特性,不是缺陷。** 谁要扩面,第一件事是让判据认得出这条界线,否则会把安全设计当缺陷「修」掉。

  **当前未被任何闸管住的跨类命中**(第三种形状在全仓的残余,均**非**令牌路径,值得将来看一眼):
  `src/local-activity-frontend-fixture.ts:1995`(`fetch` + `new URL`,网络与内容跨类)、
  `src/modules/attachments/attachment-upload.service.ts` 与 `attachment-storage-orchestrator.ts` 四处(DB 取数 + locator 映射,统一抛 `ATTACHMENT_STORAGE_OPERATION_PENDING`)。
  **本刀刻意不动它们**(A 档微刀,不做全仓同形状重构);登记在此,免得下次有人以为全仓已被守住。

(P2-9〔通知 outbox 守卫把「键名黑名单」用在不透明 id 上 ⇒ 合法通知随机被判成泄露〕**已收口** ——
值侧另立 `FORBIDDEN_PAYLOAD_SHAPE`(只把字母数字当词内字符),同一份 200 万条 cuid 样本误判 1 → **0**,
七条防御样例逐条仍被拦;补 38 条判据,此前该处零覆盖。
⚠️ 本条原先建议的 `\b(...)\b` 修法**已被实测推翻**:`_` 是 word 字符,`\bopenid\b` 匹配不上 `openid_wx123`,
误判归零的同时把防御一起削弱了 —— 详见 `src/modules/notifications/notification-outbox.types.ts` 值侧常量处的注释。)

### P2-10 `sms_send_logs.status=SENT` 是「已提交 Provider」而非「已送达终端」,当前无从区分 — 2026-08-20 真机实测拿到反例

**状态**:⏸ 挂起(项 1〔文案统一 + 判据钉死〕已交付;剩余的项 2〔三态细化 + 腾讯云状态回调〕是**对外契约变更 + 新增外部入站端点**,须独立立项评审,当前刻意不做)

> 短信通知模板真机验发时暴露。**零运行时故障**(发送逻辑本身正确),
> 但**运营口径有误判风险**:运营看到 `SENT` 会以为用户收到了。

**实证反例**(2026-08-20,维护者实测):

| 系统侧留痕 | 腾讯云控制台 |
|---|---|
| `status=SENT` · `providerMsgId=99:2507238470…` **非空** · `errCode=null` · `errMsg=null` | 提交状态**成功** / 送达状态**失败** / 原因:**运营商免打扰名单** |

**手机始终没收到。** 换第二个号码后正常收到,证明链路本身没问题 —— 问题在**状态语义**。

**现状**:`SmsSendStatus` 只有 `SENT` / `FAILED` 两态(`prisma/schema.prisma`),
全仓**无任何送达回执 / 状态回调链路**。
⚠️ 本条原文把出参 DTO 写成 `SmsSendLogItemDto` —— **仓内没有这个类**,
真名是 `SmsSendLogResponseDto`(`src/modules/sms/sms.dto.ts`)。已订正。

**待做(按代价排序,不必一次做完)**:
1. ✅ **最小改动(A 档,先做)—— 已交付**:把 DTO 描述、后台 UI 文案、运维文档统一改成
   「`SENT` = 已提交 Provider,**不代表终端已送达**」。⇒ 消除运营误判,零架构变更。
   口径由 `scripts/check-sms-sent-semantics.ts` 钉住(薄运行器
   `src/modules/sms/sms-sent-semantics.criteria.spec.ts`):五处面向人的描述逐处纳管,
   **并冻结「枚举仍是两态」** —— 项 2 一落地这条就红,逼人回来重写这批已过期的免责说明。
2. **状态细化(需评审)**:引入 `SUBMITTED`/`ACCEPTED` · `DELIVERED` · `DELIVERY_FAILED` 三态,
   接腾讯云短信状态回调同步终态。⚠️ 这是**对外契约变更 + 新增外部入站端点**(回调要验签、
   要防重放、要幂等),属独立立项,不要顺手做。
   ⇒ 真动手时**先看那条 `enum-arity` 红**给出的清单,别只改枚举。

**为什么当初登记而不是当场修**:第 1 项落在 `src/`,与当时在飞的 #1055 撞 ROUTE_AUTHZ digest
(同 P2-8/P2-9);第 2 项本就该单独评审。

⚠️ **这条同时订正了本仓文档的一处错误说法** —— `sms-closed-loop-test.md` 原文把
`providerMsgId` 非空写成「最硬的一条」,措辞暗示它能证明送达。**它只证明到腾讯云那一段。**
文档已改,并写明**验收必须同时确认真机响了**。

**缺陷类**:「把上游系统的**受理**当成业务的**完成**」。
判据是「这个状态字段的名字,承诺的是不是它实际能保证的?」——
仓内凡是跨外部供应商的状态字段都值得照此过一遍。

### P2-11 用 `onUpdate: CASCADE` 的外键去守「副本与源一致」= 装了个会自己抹掉证据的报警器 — 2026-08-21 登记

**状态**:进行中(三问取证已合 #1164;Q3 已拍板走 **A 档「只锁编号」**,实施刀 + 机器闸已合 **#1195**(2026-08-26);剩 D 档 append-only trigger,维护者明确列为独立一刀)

> 出处:A-2+B-03([#1125](https://github.com/BA7IEE/srvf-nest-api/pull/1125))实施方留的第二笔账。
> 该刀把 `ActivityRuleSnapshot.snapshotHash` 判为「不补」,理由是:本批复合 FK 的 `onUpdate`
> **恒为 CASCADE**,源一变,CASCADE 就把引用侧一起改掉 —— 不一致的证据被外键自己抹平了。

**这是缺陷类,不是实例。** 一句话:**完整性不变量不能用可级联的外键来守。**
外键保证的是「引用存在」,不是「引用的内容没变过」;`onUpdate: CASCADE` 更进一步 ——
它主动把引用侧改成与源一致,于是「副本应当等于当初那一份源」这个不变量,
在被破坏的那一刻就自动被"修复"成看起来成立。判据永远是绿的,因为反例被删掉了。

⚠️ **零当期实例已知。** 这属于**判据缺口**,不是风险敞口 —— 两本账别混:
目前没有任何一条已知的生产数据因此出错,`ActivityRuleSnapshot` 那处也只是"守不住",
不是"已经错了"。登记它是为了下次有人想用 FK 守一致性时能先看到这一条。

> ⚠️ **上面这段有一处已被 2026-08-23 的取证推翻**:`ActivityRuleSnapshot` 那处
> **连"守不住"都不是** —— 它挂着 append-only trigger,结构上不可能被 CASCADE 改写。
> 详见下面「顺带订正」。**缺陷类本身依然成立**(已用 probe 复现),只是首个举例举错了。

**三问已答**(2026-08-23 取证,A 档零代码改动;基线 `b30b0cd8`)。
读数如下,**守法未选 —— 等维护者看完 Q3 对照表再拍板**。

#### 判别法:五路信号取样,交叉核对(不能只用一种)

先按台账要求「按用途数」而不是「按 FK 总数数」。全仓 FK(有 `fields:` 的持有侧)
共 **283 条** —— 这个数**没有意义**,先记在这里只为当分母。五种信号各自命中:

| 信号 | 判别式 | 命中 | 其中 CASCADE |
|---|---|---|---|
| S1 模型名 | 模型名含 `Snapshot`/`Revision`/`Version`/`Evidence`/`Seal`/`Frozen` | 45 | 44 |
| S2 字段名 | FK 列名含 `snapshot`/`frozen`/`sealed`/`revision`/`version`/`baseline` | 30 | 27 |
| S3 配套哈希 | owner 模型有**内容型** `*Hash` 列(已剔除幂等型 `requestHash` 等) | 66 | 62 |
| S4 注释词表 | 字段/模型注释含 快照 / 冻结 / 不可变 / 固化 / 不得修改 | 151 | 132 |
| S5 复合 FK | FK 列数 > 1(带了一份被复制的锚) | 59 | 42 |

⭐ **五路并集 196 / 283(69%)—— 这个数是错的**,只是没人会信 69% 的外键都在守不可变。
这正是 P2-8 那个坑的同构复现:**信号是发现网,不是判据**。单用 S4 会报 151 条,
据此得出的任何归因(「全仓普遍存在」)都是判据太粗造成的假象。

#### Q1 = **28 条**(按用途数,非按 FK 总数数)

把发现网收敛成机制判据,两个条件同时成立才算数:

1. **持有侧是冻结记录** —— 证据三选一取并集:无 `updatedAt` 列 / 有 append-only DB trigger /
   模型名自称快照类;**再逐个反证**:生产代码若真的 `update()` 它,就不是冻结记录,剔除。
2. **FK 是复合的** —— ⭐ 这一条是机制决定的,不是偏好:`ON UPDATE CASCADE`
   **只传播被引用列的变化**。全仓 283 条 FK 的被引用列**无一例外全是 `id` 型代理键**
   (`id` 283 次,其余只有 `activityId`/`sessionId`/`memberId` 等锚列,**没有任何一条引用业务内容列**)。
   单列 FK 指向 cuid 主键 ⇒ 那个值永不变 ⇒ CASCADE 结构上**无物可抹**。
   只有复合 FK 才在自己列里存了一份**被复制的锚**,那份副本才是 CASCADE 能改写的东西。

逐条清单(28 条 / 7 个模型):

| 模型(持有侧) | 条数 | `onUpdate` | DB trigger | FK(relation 字段) |
|---|---|---|---|---|
| `ActivityAllocationApplicationProjection` | 11 | Restrict | ✅ | `allocationBatch` `allocationCandidate` `participationIdentity` `appliedParticipationRevision` `position` `activityPersonReservation` `sessionReservation` `positionReservation` `activityPersonBucket` `sessionBucket` `positionBucket` |
| `AttendancePunchEvent` | 6 | **CASCADE** | ✅ | `session` `position` `participationIdentity` `qrCredential` `offlinePackage` `supersedesEvent` |
| `OfflinePackageParticipant` | 4 | **CASCADE** | ❌ **无** | `offlinePackage` `session` `participationIdentity` `position` |
| `ParticipationLedgerEntry` | 3 | **CASCADE** | ✅ | `session` `identity` `reversesEntry` |
| `ActivityQualificationRuleSet` | 2 | **CASCADE** | ⚠️ 条件性 | `session` `position` |
| `ActivityAllocationCommandReceipt` | 1 | Restrict | ✅ | `allocationBatch` |
| `InsuranceEligibilityEvidence` | 1 | Restrict | ✅ | `activityRegistrationRevision` |

**假阳性:做的是普查不是抽查。** 32 个候选模型逐个反证(生产代码是否真的 update 它),
**11 个被剔除,假阳性率 34%**:

- **模型名信号(S1)最差 —— 7 个假阳性**:`EvidenceSeal` / `ActivityEvidenceState` /
  `RegistrationFormVersion` / `AttendanceSettlementVersion` / `ParticipantServiceSegmentRevision` /
  `ParticipantSettlementResultRevision` / `ActivitySettlementClosureRevision`。
  ⭐ 名字里写着 `Seal`(封存)`Evidence`(存证)的模型**照样天天被 update** ——
  「名字听起来不可变」与「真的不可变」是两件事。
- **无 `updatedAt` 信号 —— 4 个假阳性**:`RefreshToken`(21 处 update)/ `OrganizationClosure` /
  `RecruitmentIdentitySession` / `MemberAudienceTagAssignment`。
- ⚠️ **反向也查了(假阴性)**:9 张有 DB trigger 的表里,`ActivityQualificationRuleSet` 与
  `ActivityQualificationRule` **带 `updatedAt`**,只用「无 `updatedAt`」会漏掉 **2/9**。
  Q1 用并集正是为了接住这两条 —— **只用一种信号两个方向都会错**。

#### Q2 = **15 条**;真正无遮挡的残余 = **4 条**

先把默认值坐实(台账要求实测,不许假设):

- ⭐ **Prisma 未写 `onUpdate` 时,默认落到 `CASCADE`** —— 由
  `prisma migrate diff --from-empty --to-schema-datamodel` 生成的规范 DDL 实测:
  283 条 FK 里 **264 条 `ON UPDATE CASCADE`**(= schema 中未写 `onUpdate` 的 264 条)、
  **19 条 `ON UPDATE RESTRICT`**(= 显式写了 `onUpdate: Restrict` 的 19 条),**逐条一一对应**。
- ⚠️ **该默认值与可空性无关**:264 条里 111 条可选 + 153 条必填,**全部** CASCADE。
  这一点必须单独实测 —— 因为 `onDelete` 的默认值**是**看可空性的(必填 `Restrict` / 可选 `SetNull`),
  照着推 `onUpdate` 会推错。
- 读数按「显式 + 默认落到 CASCADE」算(即实际 DDL 口径),不是只数显式写了 CASCADE 的
  —— 全仓**没有任何一处显式写 `onUpdate: Cascade`**,只数显式的会得到 0,那是假读数。
- 本机库(容器 `u-nest-api-postgres` 的 `app`)只跑到 **67/95** 个 migration,已陈旧,
  **不作为读数来源**;仅作方向性佐证:其 `information_schema` 为 98 CASCADE / 1 RESTRICT。

于是:Q1 的 28 条里,`onUpdate` 为 CASCADE 的 = **15 条**(其余 13 条已是 `Restrict`)。

⭐ **但 15 条不是真子集,4 条才是。** 15 条里有 11 条的持有表挂着 DB trigger。
**实测**(一次性 probe 库,已删):FK 的级联更新会**触发持有侧的行级 BEFORE UPDATE trigger** ——
报错上下文里能看到 PostgreSQL 内部发出的
`UPDATE ONLY "public"."child_b" SET "pid" = $1, "anchor" = $2`,整个事务回滚,副本保持原值。
⇒ **行级 BEFORE UPDATE trigger 会把 `ON UPDATE CASCADE` 就地废掉。**

⚠️ 那 11 条**不是同一种 trigger**,逐个读过函数体后要分开算:

- **9 条无条件挡**:`AttendancePunchEvent`(6)与 `ParticipationLedgerEntry`(3)的
  `*_append_only_guard()` 函数体是**无条件 `RAISE EXCEPTION`**,没有任何 `IF` 分支。
- **2 条按状态挡**:`ActivityQualificationRuleSet`(2)的 `freeze_guard()` 是**条件性**的 ——
  `retired` 全拒;`active` 只放行「转 retired」且**显式点名拒绝**改
  `activityId` / `sessionId` / `positionId`(恰好就是级联够得着的那几列);
  `draft` 则完全放行。⭐ **但这不是缺口**:`draft` 阶段该规则集本就还在可变期,
  没有「副本等于当初那份源」的不变量可违反 —— **保护范围与不变量的生效范围恰好对齐**。

| | 条数 |
|---|---|
| Q1 承担不可变职责的 FK | 28 |
| Q2 其中 `onUpdate` = CASCADE | **15** |
| ├ 被无条件 append-only trigger 挡住 | 9 |
| ├ 被条件性 freeze trigger 挡住(条件与不变量对齐) | 2 |
| └ **Q2\* 无任何遮挡 = 真残余** | **4** |

**4 条全部在 `OfflinePackageParticipant`**(离线打卡包的参与者名册快照:
只有 `createdAt` 无 `updatedAt`、无 trigger、生产代码从不 update 它):
`offlinePackage` / `session` / `participationIdentity` / `position`。
它的四个父表(`OfflinePackage` / `ActivitySession` / `ActivityParticipationIdentity` /
`ActivitySessionPosition`)**都是可变模型**(都带 `updatedAt`)。

⚠️ **这 4 条当前打不响,但拦住它的不是任何执法位** —— 实测全仓
**没有任何一条代码路径写被引用的锚列**:993 个 `src/**.ts` 里,typed Prisma 的
`update/updateMany/upsert` 的 `data` 负载命中锚列的只有 1 处
(`recruitment-certificate-claims.service.ts:594` 的 `standardId: null`,
那是**持有侧**清空自己的 FK 列,不是改被引用侧,不会触发级联);
9 条裸 SQL `UPDATE ... SET` 里命中锚列的 **0 处**。
⇒ 拦住它的只是「碰巧没人写」这条**无人守的代码纪律**,而不是 schema 或闸。

#### 机制实测(一次性 probe 库,已删,不碰 `app`)

| 用例 | 结果 |
|---|---|
| A 复合 FK + CASCADE + 无 trigger,改父锚 | 子表副本**被静默改写** `A-OLD`→`A-NEW`,而记录当初值的旁列纹丝不动 ⇒ **缺陷类可复现** |
| B 同上但子表有 append-only trigger | trigger **照常触发**,级联被拒、事务回滚,副本保持原值 ⇒ trigger 能遮挡 CASCADE |
| C 把被引用列改写成**同一个值** | 级联**不触发**(PostgreSQL 只在值真变了才级联)|

#### ⚠️ 顺带订正:本条出处引文里的理由,对 `ActivityRuleSnapshot` **不成立**

上面引的「该刀把 `snapshotHash` 判为不补,理由是本批复合 FK 恒为 CASCADE」——
**结论(不补)是对的,但理由是错的**,而被推广成缺陷类的恰恰是那个错理由:

- `snapshotHash` **根本不是任何 FK 的列**,`ON UPDATE CASCADE` 结构上碰不到它;
- `ActivityRuleSnapshot` 自己的 3 条 FK **全是单列指向 `id`**,不是复合 FK;
- 它挂着 `trg_activity_rule_snapshot_10_append_only`(`BEFORE UPDATE OR DELETE` 无条件 RAISE),
  ⇒ 它**永远不能被 UPDATE**,其 `id`/`activityId` 永不变,
  因此**指向它**的那些复合 FK(`OfflinePackage.ruleSnapshot` 等)的级联也永远不会发生。

⇒ 该处不补哈希是对的(trigger 已经比哈希更强),但不是因为「CASCADE 会抹掉证据」。
**缺陷类本身依然成立**(用例 A 已复现),只是它的**首个举例举错了**。

#### Q3 三种守法的代价对照(**不替维护者选**)

⭐ 台账原列三种候选,实测发现**仓内已经在用第四种**,且它比前三种都强,故一并列出:

| 候选 | 代价 | 适用条件 | 与本仓现状 |
|---|---|---|---|
| **A. 改 `onUpdate: Restrict`** | 1 个 migration(4 条约束 DROP/ADD);打掉合法级联更新路径的风险**实测为零**(全仓无任何代码写被引用锚列) | 持有侧是冻结记录、且父表锚列本就不该改 | ⭐ **已是本仓既有范式**:19 条显式 `Restrict` 全部落在冻结类模型上(`ActivityAllocationApplicationProjection` 11 条等),说明后续批次**已经自发在这么做**,只是 `OfflinePackageParticipant` 那批漏了 |
| **B. 存哈希 + DB CHECK** | 加列 + 回填历史行 + **所有写入路径都要算哈希**;CHECK 无法跨表比对,实际要落成 trigger | 需要证明的是「整行内容」没变,而不只是锚列没变 | 成本最高;`ActivityRuleSnapshot` 的先例是**没走这条**(改用 trigger) |
| **C. 应用层事务断言** | 无 migration;但**离开 DB 就没有强制力**,任何绕过服务层的写入(seed / 运维 SQL / 未来新路径)都不受约束 | 不变量依赖业务上下文、DB 表达不了 | 与本仓「能做成机器检查的就不要只写成文字要求」相冲 |
| **D. append-only trigger**(台账未列) | 1 个 migration + 配套 spec(须验 INSERT 放行 / UPDATE 拒 / DELETE 拒 / TRUNCATE 放行且 trigger 存活四件事) | 整行都不该再变 | ⭐ **已是本仓房规**:9 张表 10 个 trigger 在跑;**实测能同时遮挡 CASCADE**(用例 B) |

**取舍要点(供拍板参考,不构成结论)**:

- A 与 D **不是二选一**:A 只锁锚列、D 锁整行;`AttendancePunchEvent` 等 11 条是
  「D 已有、A 没做」,`ActivityAllocationApplicationProjection` 是「A、D 都做了」。
  真残余的 4 条是**两样都没有**。
- ⚠️ **若判定「4 条不值得动」也是一个合法结论** —— 但那要写成「已知敞口、接受风险」,
  而不是留着当「无人知道的缺口」。
- ⚠️ **Q2 ≠ 0,但也不等于「有 bug」**:4 条是**暴露形状**,当前**不可能被触发**
  (无任何代码写被引用锚列)。这仍是**判据缺口不是风险敞口**,两本账别混 ——
  没有任何一条生产数据因此出错。缺口在于:让它保持安全的是「碰巧没人写」,
  **没有任何机器执法位**会在有人第一次写锚列时红。
- ⭐ **若要建闸,别建在「数 CASCADE 有几条」上** —— 那是 283 那个无意义分母的变体。
  按本刀的机制判据,闸的形状应是:**「冻结记录 + 复合 FK」的集合里,不允许出现
  既无 `onUpdate: Restrict` 又无 append-only trigger 的成员**(当前该集合有 4 个成员)。
  ⚠️ 但**闸的形状要等 Q3 拍板之后才定**,本刀不建闸。

#### 进度(2026-08-25 拍板 → 实施刀在飞)

维护者 2026-08-25 拍板:**走 A 档,先只锁编号**;D 档 append-only trigger 是**独立一刀**,本次不做。

实施刀交付([#1195](https://github.com/BA7IEE/srvf-nest-api/pull/1195),2026-08-26 合入;状态仍为 `进行中` —— D 档未做):

1. **4 条真残余全部收掉**:`OfflinePackageParticipant` 的 `offlinePackage` / `session` /
   `participationIdentity` / `position` 四条复合外键补 `onUpdate: Restrict`,
   配第 99 条 migration `20260826090000_offline_package_participant_lock_anchor_renumbering`
   (DROP + ADD CONSTRAINT,**四条约束名逐字不变**;不加列、不改可空性;回滚 SQL 写在头注)。
2. **接闸**(照上面那句机制话建,**没有**建在「数 CASCADE 有几条」上):
   `scripts/check-composite-anchor-closure.ts` 增规则 ② —— 冻结记录(持 ≥2 业务锚点 ·
   有 `createdAt` 无 `updatedAt`)上的**复合**外键,必须要么写 `onUpdate: Restrict`、
   要么其表挂着 **BEFORE UPDATE 触发器**;两样都没有即红并点名到表 + 关系 + 外键列。
   扫描面动态取自 `schema.prisma` 与 `prisma/migrations/**`(触发器索引现算、且处理 `DROP TRIGGER`),
   **不写死表名单**;起刀当日读数:4 张冻结多锚点表 / 24 条复合外键 / 10 条 BEFORE UPDATE 触发器。
   本规则**没有白名单** —— 要放宽只能改那个文件本身,而它在红区 selfGuard 内。
3. **豁免名单防腐自证**:同文件既有的 `ANCHOR_CLOSURE_EXEMPTIONS` 补一条对拍 ——
   往名单里塞一条**指着不存在的表**的豁免,`staleExemptions` 必须当场报出来。
   补的是 #1184 那个形状(名单指着已删掉的东西,不生效、不报错、没人发现)。

### P2-12 golden journey 有两条链**从未被自动化穿过**(直写库绕过去了)— 2026-08-21 由新建的 journey 直写纪律闸逼出

**状态**:已收口(#1159 #1163)

> 出处:`scripts/harness-guards.selftest.ts` 的「journey 直写库接缝纪律」闸。
> 立项时 `test/support/journey-*.ts` 共 **46 处**直接写库,逐条分类后
> **`ambient` 31 · `gate-unreachable` 10 · `mid-chain-start` 4 · `time-compression` 1**。
> 前两类是合法的(环境底座 / 闸后本就无 API 路径),**后面这两条是真接缝**:
>
> **进度(2026-08-23)**:① 已接通(P2-12a),读数降到 **44 处 / `mid-chain-start` 2**;
> ② 已接通(P2-12b),读数 **46 处 / `mid-chain-start` 0**
> (`ambient` 35 · `gate-unreachable` 10 · `time-compression` 1)。
>
> ⚠️ **总数是升的,别读反** —— 抵掉的 2 处 `mid-chain-start` 被 4 处新 `ambient` 盖过
> (1 条 `ContributionRule` 档位规则 + 3 处 RBAC 判权底座)。**`mid-chain-start` 归零才是本条的量**:
> 该分类的语义是「属于被验链、有 API,却刻意从中间态起步」,归零 = journey 里**再没有一处**
> 从被验链的中间态起步;新增那 4 处本就不在任何一条被验链上。总数当分母看会把这件事读反。

#### ① 招新实名入口:✅ 已接通(P2-12a,2026-08-23)

~~`RecruitmentIdentitySession` 的生产创建路径要**真实短信验证码往返**,自动化跨不过去~~ ——
**实测跨得过去**:`sms-code.service.ts` 在 `providerType === 'DEV_STUB'` 时签发固定码
`SMS_DEV_STUB_FIXED_CODE`,而 `journey-runtime.ts` 早已把 smsSettings 置成 DEV_STUB。
两条 journey 的起步已改走真 HTTP 入口(`identity/send-code` → `identity/verify-code`),
共用 `test/support/journey-recruitment-identity.ts` 一份实现;**既不手算验证码哈希也不直插 codes 表**。

⭐ 同时补了一道「**已接通的接缝不许接回去**」闸(封口模型登记表):
原有「逐条交代」闸对这类回退**完全失明** —— 实测把 journey 改回直插并配一条**合法**分类标注,
旧闸**仍全绿**,新闸红并点名 `file:line`。表内当前只有 `recruitmentIdentitySession`;
12b 接通考勤链后 `attendanceSheet` / `attendanceRecord` 按同一形状进表。

#### ② 入队门槛的贡献值:✅ 已接通(P2-12b,2026-08-23)

~~`journey-recruitment-team-join.ts` 直接建 `statusCode: 'approved'` 的
`AttendanceSheet` + `AttendanceRecord`(分值手填 `3.00` / `2.00`),目的是凑出贡献值过入队门槛~~ ——
已改走**真 HTTP 入口 + 真角色**:
`POST admin/v1/activities/:id/attendance-sheets` → `PATCH .../attendance-sheets/:id/approve`
→ `PATCH .../attendance-sheets/:id/final-approve`。

⭐ **三个身份缺一不可,是审核链自己钉的**:submitter == 审核人 → 22073 / 22074
(`SELF_{FIRST,FINAL}_REVIEW_FORBIDDEN`,SUPER_ADMIN 亦拒);一审人 == 终审人 → 22075
(`SAME_REVIEWER_FORBIDDEN`)。故 submitter = journey SUPER_ADMIN、一审 = `attendance-first-reviewer`、
终审 = `attendance-final-reviewer`(后两个是 `prisma/seed.ts` 的真生产角色码)。
用同一身份走完全程一条 22075 都碰不到,而单据终态长得一模一样 ⇒ 等于没测角色隔离。

⭐ **顺带接通了分值来源**:submit 的 `contributionPoints` 由 `ContributionRule` 按**时长档位**
权威计算(`contribution-calculator.ts`;请求体里传了也不作数),直插版那两个字面量正是绕过了它。
夹具建一条档位规则(阈值 3h / 档下 2 分 / 档上 3 分),两条记录 4h 与 2h 分别取到 3 与 2 分,
跨两个北京自然日避开 3 分/日封顶 ⇒ **门槛读数仍是 5,产出路径换成真的**。

⭐ `attendanceSheet` / `attendanceRecord` 已按 ① 同一形状进**封口模型登记表**
(不新建第二套判据 —— 12a 选登记表形态正是为此)。

### P2-13 权限说明与「管辖面」之间没有绑定 —— 码复用导致说明过期,机器发现不了 — 2026-08-22 第三轮跨模型复核逼出

**状态**:⏸ 挂起(主体已收口 #1161;残 P2-13a〔`Permission code surface` 节自述已过期〕等下一把本就要动 ROUTE_AUTHZ 的刀顺手带走,单独起会平白占串行道)

> **缺陷类**:**总数不变 ≠ 说明没过期。** 一条已有权限码可以长出第二、第三个消费入口,
> 而权限码总数纹丝不动 —— 现有全部判据(码数 237 / 四桶闭包 / 角色持有人)照绿。

**真实实例**:B7 受众标签那批加了 **3 个新端点、零个新权限码**,
`member.read.record` / `member.update.record` / `activity.publish.record` 三条说明当场过期,
**没有任何机器发现** —— 是第三轮人工复核抓到的。

**为什么现有检测不够**(起草时口径对照实测):
「码长出新端点」**确实**会让 `docs:authz:check` 变红(`## All endpoints` 会跟着变),
B7 当时也确实红过 —— 但**重新生成不碰任何说明**,红一消,说明照旧过期。
⇒ 缺的不是检测,是**说明与管辖面之间没有绑定**。

**规模**(实测 `91d3a384`):**217 个有端点的码里,70 个(32%)守多于一个端点**。
前几名 `attendance.read.sheet` 19 个 · `activity-responsibility.override.record` 18 个。
⇒ 说明过期是**结构上必然持续发生**,不是偶发。

**已铺的地基**:`ROUTE_AUTHZ.md` 新增 `## Permission code surface` 聚合节
(每条码 → 它守的端点集合)。它**只做归因不做检测**,自述里写明了这一点;
存在的意义是**给未来的绑定提供指纹源**。

**该怎么做**(等 PR 0 的说明进仓后):
每条码的说明旁存一个「管辖面指纹」(端点集合的摘要);
**面变了而说明没改 → 红**。与 ROUTE_AUTHZ 自己的 `inputDigest` 同范式。

⚠️ **前置**:说明必须先进仓(P1-32 PR 0 的产出)。在那之前没有东西可绑,
本条**做不了**,不是没排期。

> ✅ **前置已解除**(2026-08-22,P1-32 PR 0 `ac4f3b08`):237 条说明已入 Catalog。本条现在可做。

> ✅ **已收口**(2026-08-23):`scripts/check-permission-surface-binding.ts` +
> 基线 `harness/permission-surface-baseline.json`,由 `permission-surface-binding.spec.ts` 在 unit 轮执法。
> **面变了而说明没改 ⇒ 红并点名该码**;`--write` 同样**拒绝**推进这种码(少了这条拒绝,
> 顺手重跑写入就是 B7「红一消」的复刻),确实复核过的用 `--acknowledge-unchanged <码>` 显式放行。
>
> ⭐ **立项断言已变成读数**(上面「为什么现有检测不够」那段此前是推断):变异 = 给
> `GET /members/:id/audience-tags` 加已有码 `org.read.node`(管辖面 6→7,零新码,说明一字未动)——
> `docs:authz:check` 绿→**红**→(重新生成后)**绿**,而码数 / 四桶闭包 / 角色持有人**三条全程绿**;
> 全程说明摘要恒为 `9ed0661c…`。**断言成立,不需要修正立项前提。**
>
> ⚠️ 起草时表格里的 `217 / 70` 已漂到 **`218 / 72`**(实测 `ce5fc66a`,两周内)—— 佐证「结构上必然持续发生」。
> ⚠️ **B7 那三条说明现在已不是过期状态**:PR 0 写 237 条说明时已把受众标签写进去了
> (`member.read.record` 等三条均含「受众标签…复用同一条权限」),**没有存量不符待拍板**。
> 基线**不断言当前说明准确**,只钉住「从今天起面变了必须有人重看」。

#### P2-13a `## Permission code surface` 节的自述已过期(小,收口即可)

该节自述里写着「🔴 **真正的执行位还不存在**…等说明进仓后按码绑本表做指纹才是执行位。已登记 NEXT_TASKS」——
P2-13 落地后这句话**已经不成立**(执行位就是 `check-permission-surface-binding.ts`)。

⚠️ **刻意没在 P2-13 里顺手改**:那段文案在 `scripts/generate-authz-manifest.ts`(红区 `scripts/generate-*.ts`)里,
改它要重新生成 `ROUTE_AUTHZ.md` ⇒ 改写 inputDigest ⇒ **占串行道**,而 P2-13 的排期明确是「零 `src/`、不占串行道」。
留给下一个本来就要动 ROUTE_AUTHZ 的刀顺手带走。

### P2-14 ✅ 活动封面 / 图集改附件制 —— 刀 A / 刀 B 均已合入 **(已收口 2026-08-26)** — 2026-08-22 / 08-25 维护者拍板

**状态**:已收口(#1146 #1191 —— 刀 B 2026-08-26 合入;衍生债务 P2-20 另立待办,不在本条内)

**刀 A**(`d8e557d7` / [#1146](https://github.com/BA7IEE/srvf-nest-api/pull/1146))已合:
`Activity` 加 `coverImageKey` / `coverAttachmentId` / `galleryImageKeys` / `galleryAttachmentIds` 四列,
写入必须给**本活动的 `activity` 类型附件 id**,读出一律现签;与 `Content` 逐字同形。
旧列 `coverImageUrl` / `galleryImageUrls` **保留但已零写入路径**。

**刀 B**([#1191](https://github.com/BA7IEE/srvf-nest-api/pull/1191),已合 2026-08-26):DROP 那两个旧列
(migration `20260825170000_activity_drop_legacy_image_url_columns`,🔴 不可逆)。

🔴 **前置条件被换过 —— 这一条比结论本身重要。** 本条目原文写的是
「须先确认刀 A 已在 `main` 上**稳定运行一段时间**、且**无人报告**封面异常」。
该条件**永远无法满足**:本项目无生产库、无真实用户 ⇒ 分母恒 0,既不可能满足也不可能证伪。
维护者 2026-08-25 拍板**换成三条此刻可判的等价条件**(不是破例,是把不可判条件翻译成可判条件):

| | 条件 | 判法 |
|---|---|---|
| E1 | 无新值注入 | 创建口零该键;唯二 update 是**回声写**(值来自同一行刚 select 出的自己);克隆口写字面 `null`;可写 DTO 零 `*ImageUrl` 字段且有结构判据 `scripts/check-activity-image-reference.ts` 把关;全局 `forbidNonWhitelisted` 让请求体塞该键变 400 |
| E2 | 无语义读 | 对外封面 / 图集一律来自 `resolveSignedUrlTrusted(row.coverImageKey)`;旧列的**值**不进任何类型化 API 出参(presenter 只读 `images.*`,并有「塞 evil.example.com 不得泄漏」的单测负例) |
| E3 | 存量为零 | 起刀当日本机全库复测两列非空计数(读数写在 migration 头注与刀 B PR body) |

⚠️ **判「一列还有没有人用」不能用 grep 字符串**:`coverImageUrl` 全仓 69 命中里绝大多数是
**API 出参字段名**与局部变量。只有四条通路真能读写一列:`prisma.activity.*` 的
`select`/`include` 块 · 同族的 `data` 块 · 已 select 出的行的属性访问 · `$queryRaw` 裸列名。
(顺带订正一条曾经的错误说法:`Content` 模型**没有**同名列,只有 `coverImageKey`;
全仓 Prisma 列声明里 `coverImageUrl` 只属 `Activity`。)

⚠️ **刀 B 之后会出现「DB 列删了、TS 接口键还在」的形状** —— 维护者拍板「留着不动」,
**不是漏改**:那两个键进了审批快照的 `canonicalJson` / `snapshotHash`,删掉会让**在途**
审核单全部当场 `SNAPSHOT_INVALID`。类型定义处已写注释说明。

### P2-15 ✅ `description` 漂移还有第二条路 —— 关掉 `PATCH` 只堵了一半 **(已收口 2026-08-23)** — 由 PR 3b 实施方逼出

**状态**:已收口(#1153)

> ✅ **V2 已关**([#1153](https://github.com/BA7IEE/srvf-nest-api/pull/1153),`ff604d39`):四处 `permission.upsert` 全部改为覆写 `description`,代码常量单向成为权威;
> 判据 `seed-description-authority.criteria.spec.ts` 结构性扫全部 upsert 调用(不写死处数),并含**反向锚点**——字典 7 处必须仍是 `update: {}`。
> ⭐ **立项时的假设被实测推翻**:goal 断言「今天不存在长期存活的库 ⇒ 没有任何东西会被覆盖」,而本机 `app` 库**实测已漂 4 条**;
> 好在漂移方向是「库陈旧、代码正确」⇒ 覆写是**修复**不是丢数据,结论不变但理由换了。
> ⚠️ **副作用如实登记**:覆写型 upsert 恒执行 UPDATE ⇒ `Permission.updatedAt` 每次 seed 都跳;消除抖动与「字面量对象」判据形状**结构上二选一**,已按后者保留(详见 CHANGELOG)。

> **缺陷类**:**关掉写入口 ≠ 关掉漂移。** 同一份事实有两个写者时,堵住其中一个,
> 另一个照样让两边分叉 —— 而且这一侧**零症状**。

`Permission.description`(DB)与它的权威源 `RbacPermissionSeed.description`(代码)之间,
漂移有**两条**路:

| | 怎么发生 | 状态 |
|---|---|---|
| **V1** | 运行时 `PATCH /permissions/:id` 改 DB | ✅ **已关**(P1-32 PR 3b `9cbb0c52`,30110) |
| **V2** | 有人改**代码里**那个 `description` 字符串;seed 的 `update: {}` 保证**既有库永远收不到这次改动** | ❌ **仍开着** |

V2 与 `PATCH` 无关,PR 3b 一点没动它。**任何长期存活的库,第一次遇到「有人改了某条 description 的文案」就会与代码分叉,而且没有任何东西会发现。**

⭐ **堵 V2 的做法恰好是当初被否掉的那个**(seed 改成 `update: { description }`)。
⚠️ **否掉它的理由在 PR 3b 之后已不成立** —— 当时的理由是「会静默改写运营手工调过的文案」,
而 `PATCH` 关上之后,**根本不存在「运营手工调过的文案」**。
⇒ **A(关写入口)与 B(seed 变权威写者)不是二选一,是先后关系**;A 已落,B 现在可以重新评估。

⚠️ **不要重复 PR 3b goal 踩过的坑**:`Permission.description`(短技术标签,来自 seed 常量)
与 Catalog 的 `businessDescription`(长句业务说明,**从不写进 DB**)是**两个不同字段**。
实测 115 条 seed description 与对应 businessDescription **零条相等** ——
拿它们做对照的判据会在几乎每条上红。

⚠️ **别再加「DB vs Catalog 常量」那种对照判据**:CI / e2e 的库是空库 → 跑 seed → 比对,
而 seed 的 `create` 用的就是那个常量 ⇒ 两边**构造上必然相等**,判据**恒绿、零执法收益**。
它只对「长期存活且被改过的库」有牙,而那种库当前不存在(生产未上线)。

### P2-16 ✅ e2e 提速刀③ —— 加权分片的上限已被证伪,真余量在单 spec **(已收口 2026-08-23)**

**状态**:已收口(#1155 #1157)

> ✅ **已收口(2026-08-23)**:走的是「消除子进程编译突刺」而非「拆分 spec」。
> `notification-outbox` 的真 OS worker child 从 ts-node+tsc 切到 **ts-node+SWC**
> (`test/tsconfig.test.json` 加 `"ts-node": { "swc": true }` + devDependency `@swc/core`)。
> 该 spec 经 `spawnWorkerChild()` 起 **18 次**子进程(12 `runChild` + 6 `startChild`,无循环放大),
> 每次都从头转译整张 worker module 图。本机实测:jest Time 189.7s → 141.6s/143.1s(−25%),
> **user CPU 115.8s → 35.1s/47.4s(−59%~−70%)**,39/39 用例不变全过、零断言改动。
> ⭐ **突刺的机制是「宽」不只是「长」**:基线单次 spawn 的 user CPU(5.5s)高于其墙钟(3.4s)
> ⇒ tsc 转译期间占着约 1.6 个核;SWC 侧 user≈wall≈1.5s。
> ⭐ **刀①刻意留的 tsx/esbuild 边界没有被推翻,反而被复测钉死**:真判据是「转译器 emit 不 emit
> `emitDecoratorMetadata`」,不是「必须是 TypeScript compiler」。实测同一张 module 图下
> tsx(esbuild)产出的 `design:paramtypes` **5/5 全为 undefined**,SWC 与 tsc **逐字节相同**。
> 理由与反向对照写在 `spawnWorkerChild()` 上方与 `test/tsconfig.test.json` 内,勿两处漂移。
> ⚠️ **本 spec 落在 shard 3/5**,而 shard 3 在三个五分片基线里两次是最慢的那片
> (7m50s/6m57s/8m29s)⇒ 主指标是 **shard 3 耗时 + 最慢片**,本 spec 自身耗时只作次指标;
> baseline = main run `32623363505`(`ff604d39`)。⚠️ `d1cd99f9` 那个 run **不可用于对照**
> —— docs-only 提交,五片 e2e 全 0m00s 未跑。
>
> 🔴 **CI 收口(合并后受控 A/B,结论与立项预期相反 —— 后来者务必读这段)**:
> 对照组 = main run `32634300577`(`d1adf853`)vs `32634521271`(`5a0adf2f`),**只差本刀一个
> commit**、相隔 5 分钟(`#1156` 影响两侧抵消;噪声核对:非 shard3 四片 −1.5%)。
> - ⭐ **被改的 spec 在 CI 确实快 34.1%**(207.7s → 136.9s,逐 spec 归因自 job 日志)。
> - ❌ **但 shard 3 墙钟 7m52s → 8m01s(+1.9%),无提速;goal 预期的「再 −2~3m」没有兑现。**
> - ⭐ **省下的 ~71s 被同片邻居原样吃掉**(其余 37 条 540.7s → 613.1s,+13.4%;shard3 合计
>   748.3s → 750.0s,+0.2%)。变慢最多的恰是刀② 点名的三个「受害者」。旁证:jest 只给 ≥5s
>   的 suite 打计时,两侧都是 61 条 spec,**带计时的从 39 条涨到 45 条**。
> - ⭐⭐ **结论:在 CPU 饱和的分片里省 CPU 不会缩短分片墙钟,只会被邻居吸收。**
>   刀② 的「共调度污染」模型据此修正:邻居不是被这条 spec 的**转译**特异性毒害,而是对
>   **任何并发**都有弹性 ⇒ **消除单条 spec 的 CPU 突刺 ≠ 兑换成墙钟收益**。
>   **e2e 墙钟的杠杆仍然只有分片数**(刀② 结论第三次被复证)。⇒ **不要再立「优化某条重 spec
>   来降 e2e 墙钟」的项**;要降墙钟只剩分片数,而那条路已被账号 20 并发 job 上限封顶。
> - ⚠️ **方法论负面教训**:PR 那轮曾用「未受影响分片做噪声归一化」把 raw −14.0% 推成 −24.4%
>   当方向证据 —— 受控读数证明那 −14% 就是噪声本身。**<20% 的单轮读数做归一化推断不可当证据。**
> - ✅ **仍然成立的收益**:本机可用性(user CPU 115.8s → 35.1s/47.4s);**nightly 串行泄漏线与
>   本地定向 e2e 是单跑/串行,拿到全额收益**,不受「被邻居吸收」限制;零回归。
> ⚠️ **踩坑留档**:`TS_NODE_SWC=true` **这个环境变量根本不存在**(ts-node 只认 tsconfig 的
> `ts-node.swc` 键)。误用它会得到「SWC 毫无提升」的**假读数**,差点据此否掉整条路 ——
> 换转译器前先自证 `options.swc` 真的翻了。

刀①(`1462b528`)+ 刀②(`c0f0a69c`)之后,e2e 全 run 墙钟 **14m06s → 11m17s(−20%)**。
刀②的实测同时**证伪了两条原以为成立的判断**,刀③必须建立在修正后的认识上:

1. ⭐ **「按 spec 耗时独立求和」的分片墙钟预测模型,在小分片下系统性偏低。**
   它在三分片上验到误差 ≤0.2m,**只是因为重 spec 被大片稀释**,不是模型无条件成立。
   **勿外推到 6 / 8 片。**
2. ⭐ **共调度污染是真实且可测的**:`notification-outbox` 内含 ts-node 子进程全量编译(CPU 突刺),
   把同 worker 的一切拖慢 —— 实测同片伙伴 `ops-admin` 46s→119s(**+156%**)、
   `wecom` 34s→86s(+155%)、`slice5` 54s→115s(+112%),而它自己只 +13%。
   旁证:五片 e2e 总 worker 时间 35m17s vs 三片 31m11s(**+13%**)。

⇒ **纯按耗时重分箱的上限不再是原先估的 ~1.2m**(共调度会双向搅动)。
**真余量在 `notification-outbox` 自身**:拆分它、或消除那个子进程编译突刺,预期再 **−2~3m**
(fast 线 ~6m 是下一个地板)。

⚠️ **立项理由不要只写「CI 再省 2–3 分钟」**:那个 CPU 突刺在**本机**同样存在,
而所有会话共用维护者那一台机器(2026-08-22 曾被并行测试跑到死机)。
**「本机可用性」是同等分量的收益**,也是「本机不跑重型测试」那条纪律的成因之一。

证据链全在 [#1150](https://github.com/BA7IEE/srvf-nest-api/pull/1150) body,**不必重测**。
是否立项按需求定。

### P2-17 门禁 hook 的仓根反推不认 worktree —— 同一缺陷造出**四面**故障(含本地红区整片漏放) — 2026-08-24 实施期取证

**状态**:⏸ 挂起(**修法本体 + 5 条回放用例 + 2 道自测闸已合入 `#1172`(`9659a4a7`)**;合入后总控实测复核:worktree 内绝对路径写 `prisma/schema.prisma` / `AGENTS.md` 由修复前 `rc=0 放行` 变为 `rc=2 拦截`,四面故障已闭。⚠️ **此处仍挂起而不写 `已收口`**,因为登记的剩余部分是下面三条**刻意不做**的射程外项,各自触发条件已写明 —— 写 `已收口` 会把这三条抹掉)

四个 hook 都用 `REPO_ROOT="$(cd "$HOOK_DIR/../.." && pwd)"` 从**脚本自身位置**反推仓根,
而 hook 以 `$CLAUDE_PROJECT_DIR/.claude/hooks/…` 注册、该变量**恒指主仓** ⇒ 在任何 worktree 里
仓根都指向主仓。**同一条推导错误造出四面故障,方向还相反**(①② 立项时已知,**③④ 是实施期取证才发现的**):

| # | 形态 | 性质 |
|---|---|---|
| ① | worktree 内**绝对**路径被当成「仓外」→ 门禁放行 | fail-open |
| ② | **相对**路径去查**主仓**的通行标记 → 主仓没标记就拒(连往仓外写都被拦) | fail-closed |
| ③ | 🔴 **红区同理漏放**:绝对路径剥不掉主仓前缀 ⇒ 命中「仓库外文件不归红区管」 | **安全敞口** |
| ④ | `harness:grant` 的令牌写在本 worktree 的 git 目录,guard 却去主仓找 | 授权空转 |

🔴 **③ 的分量与另外三条不同**:①②④ 是工程摩擦(有人喊、看得见),③ 是
**本地红区在每一棵 worktree 里整片为空** —— 无授权也能用 Write/Edit 改 `prisma/schema.prisma`、`AGENTS.md`。
⚠️ **但不要读成「护栏塌了」**:CI 侧 `Red-zone trusted scan` 与 harness-review 环境审批**独立有效、一直没塌**。
**塌的是本地那一层纵深防御**(AGENTS §1 本就写明本地 guard 是「提前反馈,不是最终边界」)。

**已交付**:仓根推导拆成两件事 —— `REPO_ROOT` 继续只定位**执法层自己的资产**,
另按**被操作文件**(拿不到路径时按 payload `.cwd`)解析它所属工作树,归属判据是 `git-common-dir`;
定位不出一律回落 `REPO_ROOT`(= 修复前行为),**绝不因判不出而放行**。
回放用例 5 条(INC-19/20/21 + INV-07/08,真触发 9→14,各自写死两棵树的四个状态位、不继承本机环境);
自测新增「三份推导块逐字一致」与「禁止回退到按 `REPO_ROOT` 查标记/令牌/相对化」两道闸。
变异对拍:改回旧规则 ⇒ **恰 INC-19/20/21 三条转红**;还原后 `git diff` 空、指纹复原、replay 复绿。

**射程外(刻意不做,合入后仍然成立)**:

1. **`WRITE-GUARD-LITERAL-ONLY` 缺口未覆盖** —— `bash-write-guard` 按**命令文本里的字面路径**匹配,
   路径拼接构造 / 藏在被调用程序里就看不见。既有已知缺口(维护者 2026-08-13 定性为
   **已知性质、非漏洞**),本刀不碰。
2. **引号剥离把目标变成 `QUOTED`** —— `strip_noise` 为治误伤会把引号内容整体替换,于是
   `cp "$A" "$B"` 这类命令交给下游判定的是字面量 `QUOTED` 而不是真实路径。
   ⚠️ 本刀开工时**当场被这条咬过**(`cp` 四个 hook 去备份被拦,判的就是 `QUOTED`)。
   它与第 1 条同源(字面拦截 ≠ 数据流执法),**要治得连着一起治**,单独修一半只会换个形态漏。
   ⇒ 触发条件:再出现一次因它而起的误拦 / 漏放,或第 1 条立项时并案。
3. **`.cwd` 这个 payload 字段没被端到端实测** —— 相对路径的归属靠它定位。
   ⚠️ **从 lane worktree 里测不到**:实际运行的是**主仓那份** hook,改 worktree 里的副本对本会话不生效。
   本刀用「payload `.cwd` → 进程 cwd → `REPO_ROOT`」三级回落兜住:
   即使该字段不存在,行为也**不劣于修复前**(自测已按三条路径分别钉住)。
   ⇒ 触发条件:下次在**主仓**开会话时顺手验一次即可闭合。

### P2-18 生成物刷新顺序只活在口口相传里 —— 实测图 + `pnpm docs:refresh` 入口已全部交付 — 2026-08-24 同形态一天复发 7 次逼出

**状态**:已收口(#1181)

> **已做**(见 README §1.7 与 changelog fragment):
>
> - 实测出真实依赖图:六个刷新器**只有一条**生成物→生成物的边(`docs:openapi` ▶ `docs:feclient`),
>   其余五个共用上游 `src/`、彼此无序 ⇒ 真缺陷是「改了 `src/` 只刷了一部分」,不是「顺序记错」。
> - 实测否掉了此前流传的口诀两处错(authz / codemap 不在 openapi 下游;发版那次 authz 红的真因是 `src/` 变了)。
> - 入口两条自证各做过变异对拍(漏登记刷新器 / 漏登记依赖边,各自会让入口自己红;反向对照不误杀)。
>
> - 入口短名 `pnpm docs:refresh` 已进 `package.json`。⚠️ 那是 `ci-control-plane` 红区,
>   **由维护者 2026-08-24 跑 `pnpm harness:grant 'package.json'` 发放**(理由逐字:
>   「生成物一次性全刷入口起短名 docs:refresh / PR #1181」)——**AI 未自行发放**。
>   为什么值得占一次红区授权:没有短名时入口也能用(`pnpm exec tsx scripts/refresh-generated-docs.ts`),
>   但少了「记得住」这一半,而这类缺陷的根因恰恰是**人记不住**,所以短名不是纯装饰。
>
> ⚠️ **两个已知射程缺口**(登记在案,本刀不扩范围):
>
> 1. 自证①认的是 `docs:*:check` 这个命名约定。**新守护若叫 `gate:*` / `harness:*` 就照不到**
>    —— 当前七条守护全部遵循 `docs:*:check`,靠约定不靠执法。
> 2. 入口自身**不在红区**(文件名不匹配 `check-*` / `generate-*` 等 selfGuard glob)⇒
>    PR 可以把某个刷新器从登记表里删掉,自证①不会响(它比的是「有没有漏」,不是「有没有被删」)。
>    ⇒ 它是**编排工具不是判据**,执法仍全在 CI 的 `docs:*:check`;要把它升成判据得连名字一起搬。
>
> ⭐ 另一条同族缺陷**一并登记、未处理**:`pnpm test:e2e <pattern>` 匹配的是**绝对路径**,
> 于是 worktree 目录名里的任何一个词都会把定向 e2e 变成全量(本刀实测:worktree
> `gen-chain-probe-5d45d1` 下 `gen` / `chain` / `probe` **三个词各匹配 306 个 spec = 全量**;
> 同树下 `artifact` 1 个、`order` 2 个)。
> 「起个好名字就安全」已被证伪 —— 换名只降低概率,不是防线。是否做成机器闸(如「危险的本机命令」这一族)待判。

### P2-19 `feedback.eligibilityCorrected` 在真更正链上**结构性恒 `false`** —— 说明文字永不显示 — 2026-08-25 由 A 档验收实施刀查出,维护者当日拍板「现在不修」

**状态**:⏸ 挂起(维护者 2026-08-25 拍板:前端未上线 ⇒ 收益为零,且它在活动结算核心链上;**等前端真要用评价面那一页时再修**)

> 本条是 P1-28「A 档验收编号实施」顺带查出的一条**运行中缺陷**,原先只记在 P1-28 的
> 验收分拣小节里等裁定。2026-08-25 裁定已下 ⇒ 单独立条,P1-28 那段保留原文并指回这里。

- **症状**:App 评价面的 `feedback.eligibilityCorrected`(DTO 描述逐字是「最新结算纠错是否已撤销
  本人的当前评价资格;历史评价仍保留」)在生产路径上**永远是 `false`** ⇒ 那句说明文字**永不显示**。
- **真因**(两处对不上,各自都符合自己那侧的规格):

  | 处 | 逐字 |
  |---|---|
  | `src/modules/activity-feedbacks/activity-feedbacks.service.ts` 的 `wasEligibleBeforeLatestClosure()` | 找**旧** closure 上的结果行时带 `statusCode: 'committed'` |
  | `correction-application.service.ts` 的 commit 事务 | 把旧结果行一律置 `superseded`(合同 §5.14 ⑥ 明文要求) |

  ⇒ 更正一旦生效,那次查询在生产路径上永远查不到东西。
- **建议修法 = 改判据,不是改投影**:让 `wasEligibleBeforeLatestClosure()` 的查询接受
  `superseded`(旧 closure 上的结果行本来就该是 superseded —— 那正是「它是旧的」的定义)。
  改投影会动结算真相链的状态机,风险不对等。
- ⚠️ **不是安全问题,别按安全优先级排**:真正的闸是同一个方法旁边的 `canSubmit`
  (`hasSettlementEligibility()` 查的是**当前** active closure 上的 `committed` 行),**工作正常**。
  失效的只是那句解释性文案的显示条件 —— 「不能提交」这件事本身照旧被正确拦住。
- ⭐ **为什么一直没被发现**:既有 `AC-065` 用例(`activity-feedbacks.e2e-spec.ts`)**读到过 `true`**,
  但它的夹具 `createFeedbackSettlement()` 是**手写**两版结果行、两版都留在 `committed`、
  旧 closure 只改 `statusCode` —— **真更正链从不产出那个形态**。
  同「夹具造了一个从没在生产出现过的世界」那一类。
- 修的时候一并处理:`AC-060` 那条用例里逐字写明「少了 `eligibilityCorrected` 这一格」的注释
  (`src/modules/activities/activity-business-overhaul-acceptance.spec.ts`),以及
  **不要把 `false` 断言进用例**(断言 `false` = 给缺陷发一张契约)。

### P2-20 三处 Swagger `description` 指着一个已经不存在的列 —— 「join `Activity.coverImageUrl`、裸 URL 字符串」 — 2026-08-25 由 P2-14 刀 B 复核逼出

**状态**:待办

> **缺陷类**:**说明文字与它描述的事实之间没有绑定。** 事实换了实现(甚至换掉了整根列),
> 说明文字照旧躺在那里,**没有任何机器会发现它开始说谎**。与 P2-13(权限说明 ↔ 管辖面)同型。

- **症状**:三处响应 DTO 的 Swagger `description` 逐字写着「活动封面图片 URL(join
  `Activity.coverImageUrl`;裸 URL 字符串)」:
  - `src/modules/activity-registrations/dto/app/app-my-registration-list-item.dto.ts:33`
  - `src/modules/attendances/dto/app/app-my-attendance-record.dto.ts:19` / `:20` / `:55`

  这些字符串进了 `docs/handoff/openapi.json`,是**前端唯一能读到的口径**。
- **真因**:两句话都已成假,而且**成假的时间不同**:
  - 「裸 URL 字符串」在 **P2-14 刀 A(#1146)** 之后就是假的 —— 值早已改成
    `resolveSignedUrlTrusted()` 现签的**短时效签名 URL**;
  - 「join `Activity.coverImageUrl`」在 **P2-14 刀 B** 之后连指代对象都没了 —— 那一列已 DROP。

  ⚠️ **不是刀 B 造成的**:刀 B 只是让它从「说错了」变成「指着不存在的东西」。
  前端若照着这句话缓存 / 拼接封面地址,会得到一个**会过期**的链接。
- **代价**:改 `description` 会动 **OpenAPI 契约快照**(`test/contract/__snapshots__/…`,红区)。
  刀 B 刻意没顺手改:那会把一刀不可逆 DROP 的改动面撑大,**红了就分不清是哪半引起的**;
  且仓内铁律是「调研中发现的问题不顺手修,先汇报」。
- **落点**:**下一次本就要动契约快照的刀顺带做**(改一行文案 + `-u` 刷快照 + 同步
  `docs/handoff/`)。单独为它开一刀不值,但**不要再让它跨过第三个版本**。
- ⚠️ 修的时候顺手把口径写成**不点名具体列**的形式(例如「活动封面签名 URL(短时效;未设或
  附件已失效则为 null)」)—— 点名列名正是它会过期的原因。

### P1-31 ✅ 开工门禁没挂 Bash matcher —— 用 `python3` / `sed -i` 写文件 **(已收口 2026-08-22)100% 绕过**,而那正是默认路径

**状态**:已收口(#1142)

> ✅ **已收口(2026-08-22)**:`bash-write-guard.sh` 判出写侧后增查开工门禁标记,
> **直接调用 `preflight-required.sh` 本体**(零份重复判定),写侧动词表做成单一来源函数。
> hook 自测新增 10 条断言,含**一致性对照**(同一写操作两侧结论必须相同)。
>
> ⚠️ **不覆盖** `WRITE-GUARD-LITERAL-ONLY`(路径拼接构造仍看不见)—— 那是另一条已知缺口,仍开着。

> 2026-08-20 由 E-B1 修复会话报出;主会话**实测坐实,并确认自己当天全程在犯**。
> **不是「已知性质」,是接线缺失** —— 与已登记的 `WRITE-GUARD-LITERAL-ONLY`(红区守卫的匹配精度)
> 不是同一件事。

**实测读数**(`.claude/settings.json` 的 `PreToolUse`):

| matcher | 挂了哪些 hook |
|---|---|
| `Edit\|Write\|MultiEdit\|NotebookEdit` | `preflight-required.sh` · `redzone-guard.sh` |
| `Bash` | `bash-write-guard.sh` |

⇒ **红区守卫有 Bash 侧对应件,开工门禁没有。** 这个不对称本身就是它是遗漏而非设计取舍的证据。

**为什么这不是边缘情况**:bypass 权限模式的会话指令**明确要求优先用 Bash 改文件**
(`sed`、heredoc、短脚本),Edit/Write 只在 Bash 做不到时才用。
⇒ **被门禁拦住的是少数路径,绕过的是多数路径。**

**已实测的后果**(主会话 2026-08-20 当天):门禁因「Prisma 生成物比 schema 新」判定未通过时,
`Write` 被正确拒绝;但同一时刻的 `python3 -c "pathlib.Path(...).write_text(...)"` **全部放行落盘**。
门禁想拦的正是「基于陈旧生成物写出错代码」,而这条路径完全没被拦。

**待做**:给 `Bash` matcher 补挂开工门禁(或在 `bash-write-guard.sh` 内合并该判定,
沿它已有的「解释器内联代码 fail-closed」范式 —— 那套机制已经能识别 heredoc / `-c` 正文)。

⚠️ **补挂前必须做正对照**:构造一个门禁未通过的状态,用 `python3` 写文件,**必须被拒**;
只验「Edit 被拒」不算 —— 那条本来就没坏。

**缺陷类**:「同一条规则在 A 通道有闸、B 通道没有,而 B 是默认通道」。
判据是「这条 hook 挂了哪些 matcher?写文件还有别的通道吗?」——
仓内每条 PreToolUse hook 都值得照此对一遍。

### P1-32 RBAC 权限目录与角色权限管理终态 —— 9 个 PR,**PR 0/1/2/3a/3b/4a/4b/5/8 九刀已合(按 PR 编号完整落地 7/9),余 PR 6–7 等前端**

**状态**:进行中(7/9 完整落地;PR 0/1/3a/3b/4a 已合 #1145 #1143 #1147 #1151 #1156,PR 2 已合 #1170,PR 4b 已合 #1171 —— **PR 4 两半齐全**;PR 5「影响预览与 Step-up」已合 **#1175**;PR 8「旧增量写端点退役」本刀交付 —— ⚠️ **只做了 PR 8 的一半**,见下方「PR 8 拆刀」;余 PR 6–7,两条都依赖前端投用)

> ⚠️ **读数沿革(2026-08-24)**:本行一度长期写着「5/9,PR 5 在飞」—— PR 5 已于 `507d2bd3`(#1175)合入,
> 但那刀按「在飞的 PR 号不写进状态行」的规矩没写号,合入后一时没人回填。
> **`#1178` 已把 5/9 补成 6/9**(两份台账同步);本刀在 6/9 基础上正常前进一格到 **7/9**。
> ⚠️ 起初 PR 8 这刀是按「一次补两笔 5/9 → 7/9」写的,`#1178` 先合之后那句就不再成立,已改写 ——
> **台账注释也会因为别人先落地而变成假话**,合并冲突时别只挑版本号、要重读这类叙述句。

> ⚠️ **PR 5 落地后「step-up 已生效」不是一句完整为真的话**:闸挂在 `runReplaceSet()`
> (`PUT` + `preview`),**旧增量端点 `POST` / `DELETE /roles/:id/permissions` 不受管辖** ——
> 持 `rbac.role-permission.create` 的人仍可用 `POST` 加一条 CRITICAL 码而不触二次验证。
> 这是 goal「不改 replace 原语的判定」的直接后果;缺口窗口 = 「PR 5 合入 → **PR 8** 退役旧端点」。
> ✅ **窗口已于 2026-08-24 关闭(PR 8)**:两条旧增量端点与 `assign()` / `revoke()` 已删,
> 写面只剩 `replace` / `previewReplace`,两者都在闸内。射程登记从「标注型」换成**禁止型**
> 不变量(「凡能到达唯一写原语的方法都必须能到达 step-up 闸」,动态发现不写死名单),
> 变异对拍实测有执行位。下面那句「持 create 的人仍可用 POST……」自本日起是**历史记录**。
> ⭐ 而 **PR 8 恰好就是下一刀**(2026-08-24 维护者把 PR 6 改判为与 PR 7 同批,见上方第四梯队)
> ⇒ 这个窗口很短,但**不是零** —— 别在 PR 5 合入后就把「step-up 已生效」当成完整为真的话。
> ⭐ 缺口已做成机器可见:`scripts/check-role-permission-impact.ts` 的 `stepup-scope-*` 把当前射程
> 登记在案,**PR 8 删掉那两条端点时判据会红并要求重看登记**,不会悄悄失效。

> 方案冻结件:[`archive/reviews/rbac-permission-catalog-t0-review.md`](../archive/reviews/rbac-permission-catalog-t0-review.md)
> (3,006 行,维护者 2026-08-20 提供,逐字入仓)。
> **本条只做排期登记,不复述方案内容** —— 细节读冻结件。

⚠️ **下游依赖(2026-08-20 维护者拍板「A」)**:[P1-30](#p1-30-通用系统集成地基-integration-foundation-v1--t0-已于-2026-08-19-拍板冻结按推荐pr1pr8-一行未实施-开工排在-p1-32-的-pr-1catalog-落地之后)
(Integration Foundation v1)的 **PR1 排在本项目 PR 1(Catalog 单一事实源)之后**,原因是两者碰同一张表:
IF 要给 `Permission` 挂 `servicePrincipalAllowed` / `delegatedAccessAllowed` 两个「能不能给机器用」的字段,
而本方案要把权限元数据收进 Catalog 单一事实源 —— **各干各的就是造第二份真相**。
另有计数连带:本项目 PR 0 要逐条分类 **236 条**权限且 DoD 不许留未分类项,而 IF PR2 会 **+9 条**控制面权限码;
先 Catalog 则那 9 条从 Catalog 进,顺序已定,**实施 PR 0/PR 1 时不必为 IF 预留**,但**别把 236 这个数字写死成常量**。
详见 P1-30 的「与 P1-32 的关系」表。

**方案的核心判断**(主会话认同):当前权限底座本身不弱
(`Permission → RbacRole → RolePermission → RoleBinding` + GLOBAL/scoped 双轨 +
三种授权来源 + explain + 审计 + 末位管理员保护 + 控制面防委派 + 每请求直读 PG),
**真正缺的是授权管理产品层** —— 管理员面对的是机器权限码,不是人类可理解、可安全操作的权限目录。

⚠️ 方案自己点破的一句,**值得当排期铁律**:

> 只做中文展示而不做第一优先级,会让「更好用的后台」**反而更容易把现有控制面改坏**。

#### PR 0 决策拍板 —— ✅ **维护者 2026-08-22 逐项答复,已落地(决策锁)**

> 冻结稿 §25 列的六项「必须由维护者明确拍板的事项」,答复原文见 PR body。
> **结论不只写在这里** —— 每一项能做成闸的都接了执行位,见右列。

| # | 事项 | 维护者答复(2026-08-22) | 执行位 |
|---|---|---|---|
| ① | `HIGH` 与 `CRITICAL` 怎么分 | 「CRITICAL 就按你的推荐分」= **出错后救不回来,或能把权力给出去**;五族:提权 / 凭证 / 身份 / 账本 / 硬删。**判据用标签不写死清单**,新控制面码自动进 CRITICAL | `permission-catalog-metadata.criteria.spec.ts`「① CRITICAL 恰好等于五族」(双向:该升没升 / 升了没依据) |
| ② | 7 条保留码能否由 SA 授给角色 | **B 收紧:一条都不进任何角色**,只走 SA 身份短路 | 元数据 `grantPolicy: 'SUPER_ADMIN_ONLY'` + `uiVisibility: 'HIDDEN'`,并与 `RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODE_SET` 双向钉死;seed 侧「这 7 条零角色持有」的执行位**早已在** `permission-code-holders.spec.ts`,不重复造 |
| ③ | Scope 首版提示还是强校验 | **只提示** | 本期刻意**不出** `scopeProfile` 字段;判据反向断言「元数据里不许出现 scopeProfile」 |
| ④ | step-up 绑哪些 action | **只记 `CRITICAL`,本刀不承诺绑定** | —(见下方「已知缺口」第 2 条) |
| ⑤ | 旧 Permission 写 CRUD 退役时间线 | **不定死日期**,由冻结稿 PR 8 的前提触发 | 判据断言 `rbac.permission.create/update/delete` 仍为 `ACTIVE` |
| ⑥ | 15 个内建角色是否全部只读 | **全部 15 个「系统角色 · 权限集只读」**,含 `member` / `group-readonly` / `org-readonly` | 见下方「⑥ 的执行位还不存在」 |

**⑥ 为什么单独点出那三个**:起草时以为 `member` / `group-readonly` / `org-readonly`「是给普通队员的、可能要区别对待」。
实测结论**相反,而且理由更硬** —— `org-readonly`(副队长/副部长)与 `group-readonly`(副组长)的码集
**不是手工清单,是从正职角色自动过滤生成的**(`isReadonlyProjectionCode`:只留 `.read.` / `attachment.view.`,
恒排除 `*.read.sensitive` 与所有写码),手改必被下次 seed 覆盖,或造出与派生链打架的第二份真相;
`member` 的 9 条码同样是 seed 写死的自助码。

##### ⚠️ PR 0 之后仍然存在的缺口(**别读成「决策已全部生效」**)

1. ~~**⑥ 的执行位还不存在**~~ → ✅ **已关(P1-32 PR 3a,2026-08-23)**。15 个内建角色现在
   删(`30104`)/ 改名(`30107`)/ 加减权限(`30108`)全部拒绝,**含 SUPER_ADMIN**,
   四道闸共用谓词 `isProtectedRoleCode()`;可达性判据
   `src/modules/permissions/role-permissions-control-plane-gate.spec.ts` 现取两份 service
   的写方法逐个要求过闸。
2. **④ 的靶子还没有枪**:今天 step-up 只覆盖 `PHONE_BIND` / `WECHAT_BIND` / `WECOM_BIND`
   三个**本人绑定**动作,管理端一条都没绑。「绑 CRITICAL 全集」= 新增 StepUpAction + 给管理端接口加闸,
   是独立一刀,不是翻开关。**本条仍未关。**
3. ~~**② 只关了一半**~~ → ✅ **已关(P1-32 PR 3a,2026-08-23)**。授码侧对那 **7 条保留码**
   连 SUPER_ADMIN 也拒(新 `30109`),沿拍板②「一条都不该进任何角色」。
   ⚠️ **收紧只覆盖保留码,不覆盖 `rbac.*` / `role-binding.*` 前缀族** ——
   前缀族里有纯只读码,拦 SA 会取消「SA 建 RBAC 只读观察员角色」这个合法能力,
   拍板②没说过要禁它。(起草本刀时曾把两者当成一回事,是 rbac-multi-instance-consistency
   e2e 在 CI 上把它顶出来的。)
   ⚠️ **撤码侧刻意没有这一层** —— 给历史脏数据留唯一清理路(seed 角色本就不含保留码,
   交集为 0)。两侧不同**不是漏改**,别当漏接闸补上。

##### ⚠️ 元数据自身的一处已知执法缺口

CRITICAL 五族里,提权 / 凭证 / 账本 / 硬删各自对应一个冻结稿 `riskTag`,新码贴标签就自动进 CRITICAL;
**唯独「身份签发」族在 11 个冻结标签里没有对应项**,只能写成
`IDENTITY_ISSUANCE_PERMISSION_CODES` 清单(6 条)。⇒ **新增身份签发类权限码时必须手工补,漏补零症状**
(新码照样有元数据、照样过完整性判据,只是档位低了一级)。
真正的修法是给标签集加一个 `IDENTITY_ISSUANCE`,要动 PR 2 的枚举 —— **本条即为该登记**。

#### 已抽出实施

- ✅ **PR 4a 角色权限原子替换已落地**(2026-08-23):冻结稿 PR 4 的九项**按不变量族切成两半**,
  4a 拿「写路径的原子性与唯一性」—— `RbacRole.permissionRevision`(第 95 条 migration,additive)
  + `PUT /roles/:id/permissions` 整集替换 + 角色行锁 + no-op + revision 冲突(新 `30111`)
  + **旧 `POST` / `DELETE` 内部改走同一条 replace 原语** + 统一 audit(新事件 `role-permission.replace`)。
  ⚠️ 「旧 POST/DELETE 改走原语」**刻意留在 4a 不推到 4b**:留两条写路径就是「一侧有闸、另一侧裸奔」,
  E-B1(#1115)与 E-B2 的授撤不对称都是同族形态。
  ⚠️ 行锁与版本号**不是补旧洞**:旧 POST(加码)/ DELETE(减码)语义可交换,没有丢更新;
  窗口是 `PUT` 这个读-改-写语义带进来的,同刀焊死。别把 changelog 读成「原来一直有并发 bug」。

- ✅ **PR 2 Catalog 只读 API 与角色分类已落地**(2026-08-24):`GET /api/system/v1/permissions/catalog`
  (只读,复用 `rbac.permission.read`,**零新增权限码**;两级分组树、237 条中文说明一次返回、**不分页**
  —— 分页铁律的例外已登记进 [`response-pagination-errors.md §4`](../reference/response-pagination-errors.md))
  + 角色响应 additive 三字段 `kind` / `permissionManagementMode` / `bindingManagementMode`。
  ⭐ **三字段选「派生」不存库** —— 冻结稿 §6.3 标题逐字「不必立即给 Role 表增加 kind 字段」,
  理由里最硬的一条是**「不会出现 DB 字段被改成 CUSTOM 逃逸保护」**:分类回答的正是「这个角色能不能改」,
  存库等于给它开一个可写的第二真相。⇒ 零 migration、零 schema、不占 schema lane
  (也就不碰那 6 份 e2e 里的 `CURRENT_MIGRATION_COUNT`)。
  ⚠️ **本刀刻意不出** `catalogVersion` / `catalogHash`:前者仓内无事实源,后者的消费方(变更预览)在 PR 4b/5,
  那时再加是 additive。同理 `technicalDescription` / `replacementCodes` —— PR 0 一条都没落地,没有东西可返。
  ⚠️ **`bindingManagementMode` 本期只产出 `SYSTEM_ONLY` / `MANUAL_ALLOWED` 两值**。冻结稿 §6.2 对其余系统角色
  写的是「`MANUAL_ALLOWED` / `POLICY_DERIVED` **或二者并存**」,而单值枚举表达不了「并存」;
  且「有没有职务策略映射」是 `organization_position_role_policies` 的**逐行数据事实**,不是角色级分类。
  枚举仍声明满三值 —— 首版声明全集,将来加值才不算响应枚举加值(契约语义门 B6)。
  执行位:selfGuard 内的 `check-role-classification` 裁判 + 薄运行器
  `src/modules/permissions/role-classification.criteria.spec.ts`;判据**两向**都钉
  (内建角色全只读 / 自定义角色不许被标只读),并扫分类派生处**不许抄角色 code 字面量**。

- ⏭ **登记(PR 2 顺带发现,本刀刻意不动)**:`FROZEN_DRAFTS.md` §2 那条生成读数的**标签**写着
  「**P1-32 PR1**:`permission-catalog*` 运行时文件数」,而 PR 2 新增的 `permission-catalog.presenter.ts`
  也匹配那个 glob ⇒ 读数已从 **1 变 2**,**数是对的、闸也绿,但标签把 PR2 的文件算在了 PR1 名下**。
  改标签要动 `check-frozen-drafts-ledger.ts`(红区判据),与本刀的写集无关,故不顺手改 —— 另起一刀。

- ✅ **PR 4b 已交付**(冻结稿 PR 4 的另一半,**读 / 预览面**):`GET` permission set + `preview`。
  前置确实已在 4a 就绪(版本号、原语、闸)。
  ⚠️ **「零红区(预估)」是错的** —— 实测 **7 条**红区路径:contract spec 本体 + 快照、`ROUTE_AUTHZ`、
  新建判据、`permission-catalog.ts`、P2-13 基线、以及 **P2-13 判据本体**(见下)。
  ⇒ **加端点类的刀不存在「零红区」**;红区预算一律用 `harness:needs` 喂「改动的后果」现算,别预估。
- 🔴 **PR 4b 顺带修了一个缺陷类:P2-13 闸对通配码的结构性死路。**
  `<family>.*` 不是权限码,是 `[rbac: <family>.*]` 后缀约定的产物(`check-rbac-map.ts:381` 把
  `[rbac: ` 之后整串当一个码 ⇒ 一个端点要两条码时只能退化成通配族)。通配码**没有说明可改**,
  而补一条会打红 P2-13 自己的 `describedButUnknown` 自证 ⇒ 原口径下它恒被拒且无路可走。
  基线里**有 5 条**通配码(`attachment.{delete,update,upload,view}.*` + `rbac.role-permission.*`)
  ⇒ 是缺陷类不是单点,**没走 `--acknowledge-unchanged`**,改的是判定口径:
  两侧都无说明的通配码,**复核责任委派给族成员**,并保留「零成员 ⇒ 仍拒绝」「成员未复核 ⇒ 仍拒绝」两道守法。
  ⏭ **登记未做**:更深的根因在 `check-rbac-map.ts:381` 的 `const code = rm[1]`
  ——「端点要多条码」本该能逗号分隔而不必退化成通配族。改解析口径打击面大,单独立项。

- ⭐ **授撤对称收口**(方案 PR 3 的安全部分)—— 8 条缺陷里**唯一「现在就存在的、可被利用的安全缺口」**:
  `assign` 有控制面闸、`revoke` **一个都没有** ⇒ 非 SUPER_ADMIN 授不了控制面码**但可以撤**。
  与 E-B1(#1115)同族:**一侧有闸、另一侧没有**。已单独立项下发(C 档,无需红区授权)。

#### 余 7 条的建议排期(四档)

| 档 | 内容 | 前置 |
|---|---|---|
| **第一** | 发版 **v0.67.0** —— 182 个提交 / 128 份 fragment 该收口 | 第六轮四刀落完 |
| **第二** | PR 0 **决策拍板** → PR 1 Catalog 单一事实源 → PR 2 只读 API | ⚠️ PR 0 要维护者给 **236 条权限**逐条定中文名/分类/风险/授予策略,DoD 明写「**没有『以后再说』的未分类 active 权限**」—— 建议照字典定稿单的做法,先拉成可过目清单分批确认 |
| **第三** | ~~PR 3a 系统角色只读 + 保留码对 SA 也关上~~ ✅ 已落(2026-08-23)· PR 3b Catalog-owned Permission 禁运行时增删改 · PR 4 原子 `PUT` + `permissionRevision` · PR 5 影响预览 + step-up | 依赖 Catalog 落地 |
| **第四** | ~~PR 6 scope 兼容提示~~ **与 PR 7 一起做** · PR 7 Admin Web 接入 · ~~PR 8 旧接口退役~~ ✅ **前一半已落(2026-08-24)**,后一半拆出见下 | ⚠️ PR 7 依赖前端;`srvf-admin-web` 目前**尚未真正投用** |

> 🔴 **PR 6 改判为「与 PR 7 同批」(维护者 2026-08-24 拍板)** —— 它不是「还没排到」,是**排它现在没有意义**:
> - 它的两个产出是 `Catalog scopeProfile`(数据)与 `RoleBinding preview` 返 warning(API 字段),
>   而冻结稿 DoD 逐字是「**UI 能提示『该角色绑定在这个范围可能无效』**」⇒ **价值全部落在 UI 上,而 PR 7 已决定跳过** ⇒ 做完没有任何消费方。
> - `permission-catalog.ts:2376` 记着 PR 0 **刻意不出** `scopeProfile`(「没有就不会被误当」)⇒ PR 6 要为 **237 条各判一次「这条权限在哪些范围下有意义」**,
>   那是**判断题不是机械题**,需要维护者逐条拍板。⭐ **等前端投用时再判会准得多** —— 那时有真实场景可参照,现在是凭空判。
>
> ⇒ **RBAC 这条线在前端投用之前,PR 8 是最后一件真正有意义的活。**

#### ⭐ PR 8 拆刀 —— 前一半已落,后一半「Permission 写 CRUD 退役」**单独立项待拍板**

**已落(2026-08-24)**:删 `POST /api/system/v1/roles/{id}/permissions`(assign)与
`DELETE /api/system/v1/roles/{id}/permissions/{permissionId}`(revoke),路由 **554 → 552**,
2 块契约破坏申报,53 处 e2e 调用点全部改打 `PUT`(零删除),step-up 射程登记换成禁止型不变量。

**未做(本条)**:冻结稿同句的另一半 ——
`POST` / `PATCH` / `DELETE /api/system/v1/permissions` 三条 Permission 写 CRUD。

##### ① 为什么拆

**替代品成熟度差一个量级**。`PUT`(整集替换)是 `assign` / `revoke` 的**完整**替代 ——
「加 N 条」= 目标集 ∪ N,「撤一条」= 目标集 \ 它,语义逐条对得上。
而 Permission 写 CRUD **没有任何替代端点**:删完 `permissions.controller.ts` 只剩两个 `@Get`
(列表 + `/catalog`),写面归零 —— 迁移文档里没有「改成打谁」这一栏可填。

##### ② 代价清单(实测,不是估算)

| 项 | 读数 |
|---|---|
| 失去被测对象的断言 | **~34 条** = `permission-catalog-guardrail.e2e-spec.ts` **9 条整份** + `permissions.e2e-spec.ts` **10 个 `it`** + 两个 `it.each`(13 + 9 = **22 例**) |
| 变不可达的 BizCode | **5 条**:`30002` PERMISSION_CODE_ALREADY_EXISTS · `30008` INVALID_PERMISSION_CODE_FORMAT · `30105` SEED_PERMISSION_DELETE_FORBIDDEN · `30106` PERMISSION_CODE_NOT_IN_SEED_CATALOG · `30110` SEED_PERMISSION_UPDATE_FORBIDDEN(唯一 throw 点全在 `permissions.service.ts`) |
| service 层连坐 | `permissions-config-audit-characterization.e2e-spec.ts` 的 **C1 / C2 / C2b / C3 / D2** 五条直调 `PermissionsService.create/update/delete` |
| 判据连坐 | `scripts/check-permission-catalog-metadata.ts:75` 的 `LEGACY_PERMISSION_CRUD_CODES` 把 `rbac.permission.{create,update,delete}` 钉成 `ACTIVE`(PR 0 决策⑤的执行位,红区 selfGuard 内,动它要新授权) |

🔴 **最要命的一条**:`permission-catalog-guardrail.e2e-spec.ts:146` 那条 ⭐ **反面样本**
(绕过 HTTP 直发 SQL 删码 → 两条角色授权跟着 CASCADE 消失,证明护栏挡的就是这个)
在语法上还能跑,但**失去正面对照后它证明不了任何东西** —— 变成一条自说自话的 SQL 演示。

##### ③ 三条候选路(**登记 ≠ 批准**,要维护者单独拍板)

| 路 | 做法 | 代价 |
|---|---|---|
| **A** | 冻结稿的另一半措辞:**永久封闭**而不是删除 —— 三条路由保留、恒返固定拒绝码 | 断言全部原样活着、端点数不变;但成功状态码变了,`gate:contract:semantic` 的 `B9/success-status-changed` 照样判 breaking,且与「整洁」这个目标背道而驰 |
| **B** ⭐ | **全删 + 另立结构性禁止闸**:新写一条判据断言「全仓不存在 Permission 的写路由 / 写 service 方法」 | **结构上不存在 > 运行时拒绝**,比原来的 30105/30106/30110 更强,也正是仓内「接通接缝后必须另立**禁止型**闸」的形态。⚠️ 但字面上是「删掉 ~34 条 e2e 断言换一条静态判据」——**行为契约变更,必须维护者点头**;且要新开 `scripts/check-*.ts` 的红区授权 |
| **C** | 维持现状,不动 | 三条端点继续存在但**实际写不动任何码**(PR 3b 起 237 条全被护栏挡住),是一组「只会失败的端点」 |

⭐ **起草方倾向 B** —— 理由是结构性否定强于运行时拒绝,且它把「Permission 只能由 seed 定义」
这条铁律从「运行时会拒」升级成「代码里根本没有那条路」。
⚠️ **但这条倾向不构成批准**:它是行为契约变更(AGENTS §2「改既有 e2e 断言 = 改行为契约 → 停下报告」),
必须由维护者单独拍板,并单独发放红区授权。

##### ④ 顺带登记的两笔小账(本刀产生,择机清理,不阻塞任何东西)

- `role-permissions.e2e-spec.ts` 的「权限边界」describe 与 `PUT` describe 的边界用例
  **落在同一根轴上**(写面收成一条之后)⇒ 有 3 条冗余。本刀**刻意保留不删**(删测试是硬红线),
  留待整理刀按「先合并再删」的流程处理。
- 孤儿码 `30011 ROLE_PERMISSION_NOT_FOUND` 与孤儿 audit 事件
  `role-permission.grant` / `role-permission.revoke`:词条**刻意保留**(历史 audit 行里有这些字符串,
  号段 / 名字一律不回收复用),全仓已零产出者。计数因此仍是 BizCode 466 / AuditLogEvent 147。

#### 体量提示

8 个 PR,动 schema、动 236 条权限元数据、动控制面策略、动前端 ——
**比 issue #1048 与 #1055 加起来还大**。不要一次性启动;逐档立项,每档单独 goal。

### P1-33 Activity OS 终态边界、数据所有权、Integration 安全与 AI 独立性 —— **T0-A / T0-B 与 Release 1 A1、A2、A3、A4、A5、A6 已通过；A7 待独立立项**

**状态**:进行中(T0-B #1236、A1 #1237、A2 #1239、A3 #1241、A4 #1244、A5 #1246 与 A6 #1248 已合；A6 的严格 Definition V1、同事务 copy-on-create、持久化幂等与安全审计、单元 / PostgreSQL E2E、PR CI 与红区审批均已收口；A7 起仍按单轴独立立项)

> 冻结稿：[Activity OS T0-A 终态合同](../archive/reviews/activity-os-t0-terminal-review.md)。

- **已冻结**:main@3cf3786 的引用链、六层真相、Activity / Incident / Resource 边界、31 个旧类型迁移矩阵、模板/地点/表单/Readiness/Snapshot v6、时长/贡献/成果、Application Facade、Integration 授权和 AI/外部故障/迁移/cutover/Release 边界，共 24 项。
- **T0-A 不做**:schema、migration、AiModule、AI SDK、pgvector、权限码、Integration 业务端点、运行时 Gate、生产 cutover 和部署。
- **T0-B 已通过并合入 #1236**:AI README 与 active reference/boundary 文档改为“可选 Assist、核心零依赖”；已修正 `ARCHITECTURE.md` 的旧预设；红区裁判 `scripts/check-ai-dependency-boundary.ts` 加上已接线的 `src/ai-dependency-boundary.criteria.spec.ts`，用源码扫描和四个正对照守住 Provider、AI 模块、AppModule 注册与依赖声明；`test/journeys/activity-os-no-ai.e2e-spec.ts` 以真实 Nest 启动跑现有创建、发布、报名、审批、签到手工链。
- **T0-B 不做**:业务 schema、migration、AiModule、AI SDK、pgvector、Integration 业务端点、运行时行为、Gate 或生产入口。
- **A1 已交付并合入 #1237**:新增 `activity_category` / `activity_semantic_facet` 受控字典、唯一 `LEGACY_ACTIVITY_TYPE_MIGRATION_REGISTRY` 与 31/31 漏重映射 CI；只做 additive seed，不建 schema/migration，不新建模板、政策、Outcome 或 `ActivitySemanticAssignment`，不改变旧 `activityTypeCode`、API、权限、Gate、统计、时长或贡献运行时行为。
- **A2 已交付并合入 #1239**:方案 A 只新增 TemplateFamily 稳定身份，并把既有 ActivityTemplate 以六个可空元数据列扩展为未来 Version 存储行；schema/migration、独立数据库约束证明、非空库 rehearsal、PR CI 与红区审批均已完成。未改 legacy resolver、Activity 选定 Version、canonical JSON/hash/lifecycle、API/DTO/权限/Gate、seed、回填或生产部署。
- **A3 已交付并合入 #1241**:future Family Version 的 canonical JSON/hash 工具、`draft → active → retired` 存储约束和第 102 条 migration 的 PostgreSQL 回归证明均已完成；全套 PR CI 与红区审批通过。legacy resolver、Activity 指针、业务 writer、API/DTO、权限、Gate、seed、回填和部署均未改，DB 不重算 hash；未来 writer 必须独立接入纯函数复验、授权与审计。
- **A4 已交付并合入 #1244**:Activity 新增可空 `selectedTemplateVersionId` 显式指针及 ActivityTemplate 反向关系；第 103 条 migration 仅增加可空文本列、非唯一索引与 `ON DELETE RESTRICT / ON UPDATE CASCADE` 外键。legacy NULL 兼容、冷库 103 replay、非空库 rehearsal、DDL/FK 回归证明、全套 PR CI 与红区审批均已收口；legacy resolver、业务 writer、API/DTO、权限、Gate、seed、回填和生产部署均未改。
- **A5 已交付并合入 #1246**:既有模板解析改为非空 `selectedTemplateVersionId` 按 id 精确读取、NULL 时逐字保留 legacy active fallback；已选 future Version 后来 retired 仍保持可读，缺行 fail-closed。template-resolution、initial/change proposal、`rebuildCurrent` 与 v2–v5 RuleSnapshot 共用同一解析，原始指针与最终 `templateVersionId` 分离；schema、migration、seed、writer、API/DTO、权限、Gate、回填和生产部署均未改。
- **A6 已交付并合入 #1248**:内部从模板创建 façade 以 operationKey 重放优先，首次调用锁定精确 Template Version、复验 A3 canonical/hash 与严格 Definition V1，并在同一事务物化草稿 Activity、Session、Position 和安全审计；第 104 条 migration 只增加两个 nullable 幂等列及唯一索引。Definition V1 不含坐标，要求定位或半径的场次 / 岗位 fail-closed；不新增 HTTP、DTO、Swagger、路由、权限、Gate、seed、回填或生产部署。
- **后续 Goal / lane / PR 顺序**:Release 1 `A1 → A8` → Release 2 `B1 → B7` → Release 3 `C1 → C5` → Release 4 `D1 → D8` → Release 5 `E1 → E5` → Release 6 Incident / Resource 按真实优先级各自另立目标 → Release 7 可永久不开。每一箭头都是独立 PR；Activity 同一 bounded context 串行，schema lane 同时至多一条，前一 PR 合入和验收完成前不启动后一条。
- **串行约束**:A1、A2、A3、A4、A5、A6 已完成独立评审、实现与 PR 验收；A7 及以后仍须按一条业务轴、additive、gate-off、shadow 对账和独立 handoff 收口，且不得沿用 A6 的 D 档授权。

### P2-21 入队进度看不见活动结算记的分 —— **目标形状:账本是唯一真相**(⚠️ **上线前必做**,不是「先不做」)

**状态**:⏸ 挂起(⚠️ **这不是「不做」,是「必须在首次生产上线之前做完,现在时机不对」** —— 触发条件三条见正文「什么时候必须做」;三条齐了就立刻立项,不必再问维护者要不要做,只需拍板合并口径)

> **缺陷类**:**同一个业务量(队员的贡献分)有两个来源,而下游只认其中一个。**
> 每新增一种「能挣分的活动类型」,都要重新问一次「入队进度看不看得见」——
> 而**默认答案是看不见**,因为进度只读考勤表。**这类缺陷随时间恶化,不随时间暴露。**

- **症状**:队员参加活动、结算给他记了分 ⇒ **那个分不会计入他的入队进度**。
- **真因**(2026-08-25 实测):
  - 入队进度:`src/modules/team-join/team-join-progress.ts:83` 的 `computeCappedContribution`
    读 **`attendanceRecord.contributionPoints`**(按北京日封顶汇总)。
  - 活动结算:分落在 **`MemberContributionDayState.committedCreditedPoints`**
    (每人每天一行,已带物化日合计)+ `ParticipationLedgerEntry`。
  - 两条链**唯一的交集**是常量 `GLOBAL_DAILY_CONTRIBUTION_CAP`(`team-join.constants.ts`);
    ⭐ 实测活动结算**不写** `AttendanceRecord.contributionPoints`(零命中)⇒ 两个来源真的不相交。

- 🔴 **不要把它读成「新旧两套账,删掉旧的」** —— 2026-08-25 总控正是这么误判过,
  差点建议删掉在用的东西。**`AttendanceRecord` 与 `ParticipationLedgerEntry` 是两件不同的事**:
  前者是「谁签到签退、服务几小时」,后者是「这场活动结算完给多少分」。
  ⇒ 本条要做的是**合并两个来源**,不是**淘汰其中一个**。

- ⭐ **目标形状**(维护者 2026-08-25 认可,按成熟系统倒推):
  ```
  考勤(签到签退)   ─┐
  活动结算          ─┼→ 唯一的「分账本」 → 入队进度 / 排行 / 任何要用分的地方
  将来:培训/值班等  ─┘
  ```
  `MemberContributionDayState`(每人每天一行 + 已确认分)**本就是为当唯一真相设计的**,
  只是现在没有下游读它。⇒ 终态是**下游改读账本**,而不是让账本回写考勤表。

- 🔴 **为什么现在不做**(三条,缺一不可):
  1. **没有真实数据可验** —— 合并对不对只有真跑过才知道;现在合并了也验不了。
  2. **结算链还在动** —— 活动 v1.1 的结算/关账链 2026-08-25 仍在改(#1188 / #1190),地基未稳。
  3. **这是数据口径迁移不是加功能** —— 上线后再改,**老队员的进度会当场变**,那才是真麻烦。
  ⇒ ⭐ **反过来说:上线前做,代价最小。这正是它必须在上线前做完的理由。**

- 🔴 **什么时候必须做**(触发条件,三条齐了就立项):
  1. 活动 v1.1 结算链**稳定**(`cutover:check` 的 9a 转绿,或维护者宣布结算链冻结);
  2. **首次生产上线之前**(⚠️ 硬边界 —— 上线后再做要处理存量进度);
  3. 有一次**可验证的合并样本**(哪怕 seed 造的),能回答下面那个必答问题。

- 🔴 **立项时必须先拍板的一件事**(现在答不了,别提前拍):
  > **同一天、同一场活动,考勤记了一次、结算账本又记了一次 —— 会不会被算两遍?**
  三种口径各有后果:①两边都算 ⇒ 可能翻倍;②只认账本 ⇒ 老队员按旧考勤攒的分归零;
  ③按天取大值 ⇒ 不翻倍但口径要写死并加判据。**这一条没有默认答案。**

- ⚠️ **顺带**:`ADV-010`(两场活动同日记分并发)的卡点正是本条 —— 它写着
  「不是缺用例,是能力缺口:没有可并发的接缝可测」。**本条落地后 ADV-010 才写得了。**

### P2-22 「旧读者清单」没有登记表 —— C8 已经在算闭包,但只导出**计数**不导出**名字** — 2026-08-26 由签字刀实测逼出

**状态**:待办

> **缺陷类**:**闭包是机器算出来的,但对外只剩一个数字** —— 于是「这几个就是全部」这句话
> 无法与任何一份人可读的清单双向比对,维护者只能选择相信那个数字。

- **由来**:`pnpm cutover:check` 的 ⑥-b 逐字写着「仓内**没有一份「旧读者清单」登记表**
  ⇒ 机器能证明「这几个接了闸」,证明不了「这几个就是全部」」。
- 🔴 **那句话在 2026-08-26 已经**部分**过时**(本刀实测,并已在 ⑥-b 的证据里订正):
  `scripts/check-activity-workflow-gate.ts` 的 **C8**(2026-08-24 / #1165 加入)
  正是「这几个是不是全部」那一半 —— 它**不硬编码文件名**,按 `collectProdFiles()` 现取 +
  AST 判「select 里有没有 `serviceHours` / `contributionPoints`」,逐个要求问闸。
  当日读数:C3 文件粒度 **3**,C8 函数粒度 **4**。
- **真缺口因此有两条,都不是「写一份手写文档」能填的**:
  1. **名字导不出来** —— `runCriteria()` 只返回 `counts`,`analyzeSettlementReadFaces` **未导出**。
     要做双向比对的登记表,必须让它把**发现到的读面身份**吐出来;
     ⚠️ 那要动 `scripts/check-activity-workflow-gate.ts`,它在 selfGuard(`scripts/check-*.ts`)内
     ⇒ **红区,需维护者发令牌**。本刀是零红区刀,故不做。
  2. **口径要维护者定** —— 「旧读者」是否只等于「读 `attendanceRecord` 的结算列并对外产出」?
     还是应含任何读 `ActivityCheckIn` / `AttendanceSheet` 的地方、含 `$queryRaw` 裸列名?
     ⚠️ 口径定窄了,C8 对定义外的读者**结构性失明**,而登记表会显得「全都登记了」。
- ⭐ **正确形状**(立项时按此做,别做成静态文档):登记表 ↔ C8 发现面**双向集合相等** ——
  漏登记一个真读者 ⇒ 红;登记了一个已消失的读者 ⇒ 也红。
  单向的「至少登记了 N 个」等于没守(本仓 README 清单那次就是这么漂的)。
- **不做的代价**:⑥-b 恒为 ⏸,⑥ 这一条开不了闸;而它**不影响**其余九条。
- ⚠️ **顺带(同一个红区文件,开了就一起做)—— 2026-08-26 只读维护态刀留下的债**:
  把 `ACTIVITY_WORKFLOW_READONLY` / `readonlyMaintenance` 两个标识符并进
  `scripts/check-activity-workflow-gate.ts` **C1 的令牌表**(那里已经钉着
  `ACTIVITY_V11_WORKFLOW_ENABLED` / `activityV11Workflow`)。
  现状:那条「只读位只许在 app.config.ts 与闸文件里出现」的结构断言住在
  `src/common/activity-workflow/activity-workflow-readonly.spec.ts` ——
  **无红区保护,任何 PR 可零授权删掉**。之所以没直接放进 C1,是因为那个文件在
  selfGuard(`scripts/check-*.ts`)内而那一刀是零红区刀。
  ⭐ 缓解已在:只读位住在 `activityV11Workflow` 这个 C1 已钉住的命名空间里
  ⇒ 别的生产文件想读**配置**必然触 C1;裸露的只有「直接读 `process.env`」这一条路。

### P2-23 字典项与 Audit events 没有登记表 —— 合同 ④ 的「对账」在这两半上**零判据** — 2026-08-26 由第二批签字逼出

**状态**:已收口(#1202 #1203 #1205 #1206 —— 字典/audit 两半登记表 + 红区判据 + ④-c A 类 + ④-b 重签,全链闭合)

> **收口链**:#1202(字典登记表 + 判据)→ #1203(审计登记表 + 判据,摸底修正「无落点」前提)
> → #1205(三个零产出事件拍板处置)→ #1206(判据收编红区 scripts + `cutover:check` ④-c
> A 类 + 四个对拍读数)→ ④-b 重签刀 #1207(理由行升「已逐条核对」,五读数锚定;
> 签字生效以其合入为准)。
> 台账原判「比字典严重一档」的 Audit events 半:落点(闭 union + TS 静态锁)历史上已有,
> 缺的对外清单与对拍由 #1203/#1206 补齐。原设想的「第一刀收枚举」无需做。

> **缺陷类**:**同一条合同要求里,一半有生成物、另一半连落点都没有** ——
> 于是「已对账」这句话在两半上的可信度天差地别,而清单上它们长得一样。

- **症状**:`pnpm cutover:check` 的 ④ 拆成 4a / 4b 两半。
  **4a(权限 + 合同快照)是 A 类硬判据**:8 条生成器重跑与仓内产物逐字节对账,差一个字节就红。
  **4b(字典 + Audit events)只能靠人签**,而 2026-08-26 签下去的那一条,理由行里逐字写着
  「本条签的是『维护者接受当前状态』,**不是『已逐条核对』**」。
  ⇒ 合同 ④ 表面上收口了,实际上有一半**从来没有被任何机器看过**。
- 🔴 **真因(两条,性质不同)**:
  1. **字典**:seed 在 `prisma/seed.ts` 里,是**代码**不是**清单** ——
     它能被执行,不能被逐条比对。签字目前只锚了这个文件的**摘要**
     (`seed-sha256-12`),那只证明「你签字时看的那份 seed 还是这一份」,
     **不证明里面有哪些字典项、更不证明它们与合同 v1.1 点名的那些对得上**。
  2. **Audit events**:**连一个可摘要的落点都没有** —— 事件名散在各 service 的调用点里,
     无枚举、无常量表、无登记文件。⇒ 新增一个 audit event **不会让任何读数动一下**,
     4b 的对拍对这一半**结构性零覆盖**。这一条比字典那条严重一档。
- **落点**(两份登记表,形状不同,别做成一份):
  - 字典:一份可解析的登记表 + 一条判据,与 seed 里真正 upsert 的字典项**双向集合相等**
    (登记表多一条 ⇒ 红;seed 多一条 ⇒ 也红)。⚠️ 判据要读 seed 的 **AST**,不是 grep ——
    字典项在 seed 里是数据字面量,文本匹配会把注释和示例一起吃进来。
  - Audit events:先**造出落点**(枚举 / 常量表),再做登记表。
    ⭐ 顺序不能反 —— 没有落点的登记表只能靠人手抄,抄漏了机器发现不了,
    那就退化成「装了个没验过的报警器」(本仓 #1184 的形状)。
- 🔴 **正确形状**:登记表 ↔ 真源**双向集合相等**,与 P2-22 同一条纪律。
  单向的「至少登记了 N 条」等于没守。
- **代价**:
  - 字典那半要动 `prisma/seed.ts` 的**读取侧**(判据),不改 seed 本身 ⇒ 判据文件若落在
    `scripts/check-*.ts` 就进 selfGuard **红区**,需维护者发令牌;
    落在 `src/**/*.spec.ts` 则免授权(本仓既有先例:`activity-workflow-gate.criteria.spec.ts`)。
  - Audit events 那半要动**生产代码**(把散落的事件名收进枚举),打击面按调用点数量走,
    属**先做重构再做判据**的两刀活,不是一刀。
- **不做的代价**:④-b 的签字**永远只能是「接受现状」**;合同 ④「所有新权限、字典、
  Audit events 和合同快照生成并对账」这句话里的「字典、Audit events」两个词,
  在机器侧**没有任何对应物**。⚠️ 它**不影响**其余九条。

#### 字典半交付读数(2026-08-27;P2-23a)

- **登记表**:`docs/ai-harness/DICTIONARY_SEED_REGISTRY.md` —— seed 内置字典 28 type / 242 item
  逐条点名;两个 seed 不预置 items 的字典(group_function / member_audience_tag)显式标注,
  空表不许静默。声明行「字典 type(机器核对):28 个 · item(机器核对):242 项」与解析数对拍。
- **判据**:`src/modules/dictionaries/seed-dictionary-registry.spec.ts`(unit 轮,不连库、零红区)。
  AST 读 `prisma/seed.ts`(纯数据字面量,grep 会吃注释;import 只看得见已导出的 V2_DICT_SEED)。
  七维:**D0** 仪器健康 · **D1** upsert 站点闭集(3 函数 7 站点,item code 非字面量)·
  **D2** 声明行对拍 · **D3** 正向漏登记 · **D4** 反向多登记 · **D5** label 逐字镜像 ·
  **D6** 空表标注。常驻变异对拍 M1–M6(红集精确、两两不相交),含「攻击者同步改计数」的
  外科变异(M1/M2)。join_source 族的 4 个常量引用经**活 import 绑定表**解析
  (常量改值判据跟着走;闭集外新标识符 fail-closed 红)。
- ✅ **形态收编(2026-08-27,维护者令牌,随 ④-c 接线同刀)**:判据本体已挪进
  `scripts/check-dictionary-seed-registry.ts`(selfGuard 红区,`scripts/check-*.ts` glob
  自动覆盖,无需改 redzone 清单),spec 降薄运行器(真读数 + 常驻变异对拍 M1–M6)。
  P2-23a 首发时的零红区形态(逻辑留 spec)自此闭坑;P2-22 那刀同款升级仍待其自身立项。
- ⚠️ 本刀不碰 4b 签字与 `seed-sha256-12` 锚(内容没变,锚不过期);
  **Audit events 半原样未动**(两刀活,等立项)。

#### Audit events 半交付读数(2026-08-27;P2-23b)

- **摸底修正台账前提**:「连一个可摘要的落点都没有」**已过时** —— 事件名早已被
  `src/modules/audit-logs/audit-logs.types.ts` 的闭 union `AuditLogEvent`(147 项)收编;
  三条写库漏斗(`AuditLogsService.log()` / `writeConfigAudit()`(permissions)/
  `user-roles.service` 内联薄封装)全部 `event: AuditLogEvent` 类型锁,
  TS 已静态保证「新增事件不进 union 编译不过」(全仓无 `as any` 逃逸)。
  ⇒ 台账设想的「第一刀:先把散落事件名收进枚举」**无需再做**;缺的是对外清单与双向对拍。
- **登记表**:`docs/ai-harness/AUDIT_EVENT_REGISTRY.md` —— 147 个事件逐条点名
  (AST 提取生成后人工复核),每条带「仓内出现次数」(口径:src 下 AST 字符串字面量,
  排除 union 宿主与 spec,含常量定义与三元分支,不含注释);147 = 活跃 142 + 零产出 5。
- **判据**:`src/modules/audit-logs/audit-event-registry.spec.ts`(unit 轮,零红区,
  形态沿 P2-23a 先例不带 `.criteria.spec.ts` 后缀)。六维:D0 仪器健康 ·
  D1 union 提取闭集(非字面量成员 fail-closed 红)· D2 声明行三段数字对拍 ·
  D3 漏登记 · D4 多登记 · D5 出现次数逐条镜像 · D6 零产出闭集(死事件必须标注)。
  常驻变异对拍 M1–M6(红集精确、两两不相交),含「只改计数让总数对上」的外科变异(M3)。
- **摸底新发现(2026-08-27 git 考古定位成因,维护者同日拍板处置完毕)**:
  3 个 union 成员零产出且注释未标注 ——
  `recruitment-application.certificate-upload` / `.certificate-review`
  (**生产者随 #830 / PR-4a-2「删旧 category 端点」消失,2026-07-30**)⇒ 拍板:
  **补〔已退役 · 无产出者〕标注、词条保留**(同批已发布错误码「保留不删」同款;
  库中存在历史行,union 是「库里可能出现什么事件」的清单);
  `member.official-portrait.purge`(#1106 / T1 刻意未接,合规清理流程见 issue #1055 §5.2)
  ⇒ 拍板:**保留,补〔预留 · 未接〕标注**,建流程时接通、登记表计数自动跟走。
  登记表备注与 union 注释均已同步;D6 对「已退役」「零产出」两种标注都认。
- ✅ **判据收编 + ④-c 接线(2026-08-27,维护者令牌,同刀落地)**:判据本体已挪进
  `scripts/check-audit-event-registry.ts`(selfGuard 红区),spec 降薄运行器;
  `cutover-check.ts` 新增 **④-c(A 类)**「字典与 Audit events 登记表双向对拍」+ 四个对拍读数
  (`dict-registry-types/items`、`audit-event-registry-total/active`,计数型,提取塌了给 -1 当场红)
  + 正对照 4c/4c′(变异审计计数 ⇒ 必红且点名;真源 ⇒ 必绿)。全量与 `--signoff` 双模式本地绿。
- ✅ **4b 重签(2026-08-27,随 ④-c 合入落地)**:登记表条目理由行升级「已逐条核对」,
  对拍行扩为五读数(`seed-sha256-12` + 两个登记表四读数);`--signoff` 与全量双模式本地验证绿。
  4b 证据行同步改写(过时的「待重签」提示移除)。

## 已收口项

全部移至 [`docs/archive/ai-harness/next-tasks-completed.md`](../archive/ai-harness/next-tasks-completed.md)(冻结,不再增长)。

**本文件只留还没做完的事。** 台账一旦开始沉淀历史,就会退化成没人读得完的流水账 ——
2026-07-29 搬出时,15 条活跃条目里有 7 条已完成或已判定不做,另有一个占全文件 60% 的归档区。
