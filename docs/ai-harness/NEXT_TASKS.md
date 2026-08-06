# NEXT_TASKS — 后续任务拆解(P0 / P1 / P2)

> **性质**:任务提案清单(2026-06-10 Review 产出)。**每项任务仍须按 [`process.md`](../process.md) 单独立项,AI 不自动启动**(process §7)。状态列可由 AI 在 docs PR 中更新。
> P0 = 不解决阻碍 AI Harness 落地;P1 = 影响长期维护;P2 = 可优化。

---

## P0(harness 落地链路)

(P0-1 / P0-2 / P0-3 均已完成,见[已收口项归档](../archive/ai-harness/next-tasks-completed.md)。)

### P1-27 v0.66.0 外部评审 —— **两轮 findings 全关 + T6-1 运维闭环已交付**(#897/#898/#901/#903);⏸ **剩两笔全部卡在「域名未下来」** + T6 后总评审 🟡

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

(P1-3〔Slow-4〕/ P1-7〔SMS 消费者三项〕/ P1-8〔微信小程序登录〕均已完成,P1-4 已于 2026-06-10 调研收口 —— 均见[已收口项归档](../archive/ai-harness/next-tasks-completed.md)。)

### P1-28 活动业务全流程改造(批次 0–7) — **第 0 批 + 第 1 批 + 第 2 批 ✅ 代码面已齐；第 3 批第一刀 ✅ 已合 main [#952](https://github.com/BA7IEE/srvf-nest-api/pull/952)，①.5 模板两表／幂等列 D 档 schema 本分支待 PR CI / `harness-review`；合同已修订至 v1.1.1**

> **需求口径变更(2026-08-04)**:**= v1.1 四份 + [`AMENDMENTS-v1.1.1`](../archive/reviews/activity-business-overhaul-v1.1/AMENDMENTS-v1.1.1.md),冲突以后者为准。**
> 第 1 批建表过程中实测撞到**五处合同内部不一致**,维护者当日**全部接受**并发布修订件。原件与 SHA256 一字未动(校验仍过)。
> 五条现状:②已生效(快照锚点可空)· ④已解决(加开第五刀 #915)· **①归第 4 批**(`CapacityReservation` 补
> `memberId`/`activityId` + partial unique,走 DB 保证不降级为服务层)· **⑤第 4 批开工前需业务方定四处取值集**
> (`resultCode` / 候选唯一 / `scopeTypeCode`+`fallbackMode` / `preferenceOrder` 起点)· **③是第 6 批开工硬门**
> (`OfflinePackage`、`OfflinePunchReviewItem` 被引用却从未定义,**禁止从 §5.7 散文推导**,已用 e2e 判据钉死)。
> **五条均不阻塞第 2 批。**
> **待折进下一版修订件的已知合同缺口(#6–#14；#14 已裁定，其余未裁定)**:#6 `workflowRevision` 来源未定义 ·
> #7 `resultCode` 无「未定」取值 · #8 关账幂等列缺失 · #9 `requestedChangeJson` 结构未定义 ·
> #10 无人触发 `commitBatch` · **#11** §6.1/§6.2 要求草稿动作携带 `operationKey`，但 §10.3 必须覆盖闭集不含它、§3 也没有持久化落点；本刀按 §10.3 不接收该字段 ·
> **#12** §3.1 的 `cancelOperationKey` 提到“全历史操作记录另表保存”，但该表全合同未定义，禁止从散文自造 ·
> **#13** §3.4 `ActivityTemplate.statusCode` 取值集未定义；①.5 只落 `String`，刻意不加 CHECK，待合同修订件 ·
> **#14** §3.4 将 `ActivityRuleSnapshot.templateVersionId` 写成必填，却没有 `Activity` 模板绑定列，且 `ActivityTemplate` 按零 seed 原则无数据；三者合取会令无模板活动在审核通过时无法生成快照。**裁定（维护者 2026-08-06「同意」）**：无模板活动合法，按活动自身值 + 系统默认解析；第 77 migration 放开该列可空并保留可选 FK，待修订件更正原文。
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
- **排班约束**:schema-touching lane ≤1(合同 §14.1 与仓库 lane 协议一致);
  第 1、2 批未完成前禁止把二维码 / 批量代签 / 离线入口开放到真实环境(修订说明 §10)。

### Content / Notification 可见性业务 Decision — **✅ 已最终拍板(2026-07-27)**

- **业务负责人最终确认日期：2026-07-27**。
- **Decision 15.1=B**：management 只认 SUPER_ADMIN 或明确持有对应 GLOBAL `content.read.record` / `notification.read.record` 的账号；Role.ADMIN 不自动放行。
- **Decision 15.2=B**：department 认当前有效 PRIMARY / SECONDARY / TEMPORARY / SUPPORT Membership，且 Organization 必须 ACTIVE、未软删；适用于 App Content、App Notification、SMS/WeChat 根受众及微信实际 Effect 前最终收件人复核。
- **非阻断待评审**：考勤审核自由备注是否永久原文进入不可变审计，待独立隐私口径确认；本项不是已确认漏洞，不在当前 hardening Goal 修改。

> ⚠️ 本条虽已拍板收口,**刻意留在活跃区**:`notification-canonical-docs.spec.ts` 把它钉成契约
> (与 `current-state.md` / `notifications/CLAUDE.md` 三处互证)。它是**当前生效的业务决议**,不是完成的任务。

### P1-10 D-INSURANCE v3 顺序四 PR 收口 — **PR1–PR4 代码均已交付；PR3 runtime enable 与 PR4 migration deploy 待后续运维窗口**

- **PR1 expand-only(已交付)**:`MemberInsurance` pending/v0/nullable reviewer + nullable 双 source/双 owner Evidence RESTRICT FK 骨架 + `TeamJoinCycle.requiresInsurance=false`；约束刻意留 PR4。
- **PR2 compatibility window(已交付)**:唯一 review route + optional App expectedVersion + telemetry；consumer 保持旧语义、0 evidence。
- **PR3 enforcement cutover(本次代码交付，不含部署)**:`INSURANCE_ENFORCEMENT_ENABLED` 单 gate 同时切 App required CAS、verified-only、Activity/Team Join 最小 evidence 与 final join 保险闸；production missing/empty/invalid fail-fast，显式 false 可启动。维护者于 2026-07-19 逐字确认“旧客户端都没上线，放心操作执行”，仅解除客户端兼容等待，**不构成旧 server=0 运行证据**；真正 enable 前仍须 drain 旧 server 且禁止 true/false fleet 混跑。
- **PR4 DB closeout(代码已交付，不含部署)**:migration 已实现完整性扫描、exactly-one/kind/interval/review snapshot、全局单 owner、同 member 与 immutable trigger；任一脏数即失败且零修数/删数。生产约束尚未生效，deploy 前仍须沿 PR3 SOP 确认旧 server=0、排空旧事务并禁止混合 gate。
- Admin 队员 360 的团队保险覆盖安全投影已交付；小程序/App 端保险展示仍不在本任务范围。理赔、到期主动提醒(新增 cron 须 D 档)与保单图 attachments 接线也仍须真实诉求触发后另立项。

### P1-14 GAP-005 统一通知模块后续(S1–S5 已发,余项 ⏸ 诉求触发再立项)

- **真·全员短信批处理异步**(S5 末位切片经 D-Outbox 收口):admin `confirmed=true` 现先持久化逐收件人 generation intent，再由 HTTP 做首轮、独立 worker 续跑失败项；跨进程 active-slot 防并发重复，真实 `NotificationDelivery SENT` 才是永久去重事实。实现未新增 cron/Redis/queue/事件总线；若未来受众规模需要分片、吞吐控制或专用队列，仍须另立 D 档，不在 durable outbox 基础能力中暗增。
- **报名前 openid 非会员推送路**(S3/S5 均标注另立项):招新报名前 5 触发(报名受理/转人工/门槛/评定/公示)申请人**非队员**,站内/微信/短信(均需 member)够不着 → 现维持**查询进度 pull**;若需主动推送给未入队报名人(微信 openid 锚点),单独立项。
- **短信 admin 投递查询端点**(可选):当前 `NotificationDelivery`(channel=sms)+ `sms_send_logs` 落库,admin 查投递成败靠 `sms-send-logs` 列表(已有)/ 运维看库;若需「按通知查短信投递明细」admin 端点,诉求触发再加(沿 S2 微信 delivery 无专属查询端点的口径)。

(P1-11 招新一期〔招新前段〕+ P1-12 招新二期〔招新后段〕+ **P1-13 招新三期〔入队:志愿者→队员〕** 均已完成,见[已收口项归档](../archive/ai-harness/next-tasks-completed.md);**招新业务域三段闭环**:报名前段〔临时编号〕→ 转正后段〔建 User+Member,无部门无级别〕→ 入队〔10 项考核 + 综合评估 → 设部门 + 级别 level-1〕。**P1-12 当时拍板的「admin 手工建档 = v1 边界外」已由 v0.41.0 招新可用性收口还账关闭**:F2 admin 改资料〔PATCH,R1 白名单〕+ F3 单人手动建档〔promote-single,放行外籍+锚点择优〕——批量发号全部 skip 类自此有出路;冻结评审稿 [`recruitment-usability-closeout-review.md`](../archive/reviews/recruitment-usability-closeout-review.md)。)

### P1-20 app 侧证书图暴露给队员本人 — **⏸ 诉求触发再立项**

- **背景**:v0.41.0 招新可用性收口 F7(评审稿 §2.9 R6)落地了证书图长期档案:申请人公开上传(`certificateImages`)→ promote 建 pending `Certificate` + 图 key 搬 `Certificate.imageKeys Json`。**app 侧 `GET app/v1/my/certificates` 的 `AppMyCertificateDto` v1 刻意不含 imageKeys/图 URL**(v1 契约不动,goal 拍板另议)。
- **候选方案**:若队员需要在小程序回看本人证书图,镜像 admin 取图口径加 `GET app/v1/my/certificates/:id/image-urls`(self-scope 锁本人 memberId;短 TTL signed-URL;L3 不入日志)——须先过 App surface 语义评审(api-surface-policy §9)。
- **触发条件**:小程序前端出现真实页面诉求时单独立项(C 档;0 schema——列已在)。

### P1-15 存量队员批量导入工具 — **⏸ 不自动启动,诉求触发再立项**

- **背景**:终态 scoped-authz 序列(GAP-007,PR1–PR12 + 摘码微刀,已全量落地)的 PR11 只建了 `announcement-import`(preview/execute 两段式,导组织/任职/分管),**不建 `Member`**——双锚铁律(R7)要求执行前每条行都能按 `memberNo` 命中已存在的队员。当前给全新队员群体(如整队历史存量数据)批量建 `Member` 记录尚无专用端点,只能逐个 `POST admin/v1/members` 或运维 `psql` 直灌([`ops/scoped-authz-go-live-checklist.md` §3`](../ops/scoped-authz-go-live-checklist.md) 已登记此缺口)。
- **候选方案**:镜像 `announcement-import` 的 preview/execute 两段式设计(零写入诊断 + 幂等落库 + 逐行 `ok`/`blocked`/`already-exists` 结果),但目标表是 `Member`(可能含基础档案字段)而非组织/任职/分管;**同样受 R13 约束**——测试与文档示例一律用假数据,真实姓名/证件信息不进本仓库任何位置。
- **触发条件**:出现批量导入存量队员(> 逐个可接受量级)的真实诉求时单独立项评审(D 档,涉及 schema 是否需要新增批量端点、字段集范围、与 `POST admin/v1/members` 单条端点的关系)。
- **与 P1-18(队员账号闭环,✅ 已完成)关系**:P1-15 解决"批量把队员**档案**（`Member`)灌进来";P1-18 解决"给**已存在**队员开**登录账号**(`User`)"。两者正交——P1-15 若落地,批量导入出的 `Member` 仍可用 P1-18 已交付的 `POST admin/v1/members/accounts/bulk-grant` 批量开号能力。

### P1-24 通用证书标准库 + 队内认定规则 + 招新证书闭环 — **✅ 已交付并随 v0.65.0 发版(2026-08-02);剩首批初始化(生产 runbook)**

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
  - **首批标准与认定规则未建**(刻意不 seed:认定口径是维护者拍板,不由 AI 内置)。按 [`初始化 runbook`](../ops/certificate-standard-library-initialization.md);⚠️ `code` 打错不可挽回。
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

- **背景**(招新/入队十三项收口问题⑨):`PROFESSIONAL_GATE_CODES` / `GATE_VALIDITY` / `PROFESSIONAL_TEAM_GATE_BY_NODE_TYPE` 当前在 `team-join.constants.ts` 硬编码 4 种专业队及全部 gate 有效期;新增专业队、改 gate 或调整有效期都必须发后端版本。P⑦ 已拍板本 goal 只挂账,不顺手扩动态配置面。
- **候选方案**:D 档新增 gate 定义表(建议字段:`code`/`professional`/`validityType`/`validityYears`/`extendable`/`status`) + 专业队 nodeType→gate 映射表(建议字段:`nodeTypeCode`/`gateCode`/`status`),由 Query/Policy 层一次加载后供标 gate、进度派生与一键入队重校验共用;须同步设计 admin 配置端点、RBAC、audit、缓存失效与存量常量迁移/回滚方案,禁止只把其中一个消费者改成读表造成双轨。
- **触发条件**:业务提出新增第 5 种专业队、运营需自行调整 gate/有效期,或 node_type 约定开始跨版本频繁变化时单独立项。

### P1-23 `recruitment_applications.isForeigner` 历史 DB 列改名 — **⏸ 数据治理诉求触发再立项**

- **背景**(招新/入队十三项收口刀C2 遗留):API DTO/CSV/stats/audit 对外已统一改为 `isNonMainlandDocument` / `is_non_mainland_document`,含义锁定为「非大陆证件,不代表国籍」;仅 Prisma/DB 历史列仍名 `isForeigner`。直接 rename 属 D 档破坏性 schema 变更,本 goal 明确禁区,故不改列名。
- **候选方案**:先盘点所有 SQL/报表/导出/备份消费者,再做 Prisma field 映射过渡或单次 rename + 存量验证;同步 current-state/CODEMAP/留存 SOP 与回滚 SQL。不得先新增第二列长期双写。
- **触发条件**:外部 BI/报表开始直读该列,或合规审查要求物理字段名也去除“外籍”误述时单独立项。

### P1-26 并发写路径审计 findings 修复 — **6 🔴 + 2 🟡 已修 · A-R2 方案乙 · 整批复审 M1–M6 已收口 · S6 三处分叉 + GPS 审计口径已按拍板落地(全条关闭)**

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

> #399 全仓 review P2 六项已修(#400-#404,见 [`current-state §4`](../current-state.md) + 冻结报告顶部 ✅);以下为修复时显式接受、留待后续的残余:

- **F2 残余:attachment key owner-绑定**(P3)— F2 现把 create() 的 key 约束到 `attachments/<envPrefix>/` 派生格式正则,关闭「任意 COS 路径」面;残余 = 命名空间内、已知**完整 96-bit 随机段** key 仍可签(已知即已有权)。彻底闭合 = key↔owner 派生绑定 / 弃用模式 A 全量走模式 B(upload-url + HMAC token)。**COS 休眠,运维接通前非紧急**。
- **F1 关联:attachment.`*.other` 接 enforcement 时复核保留集**(P3)— **8 条**(review #484 G26 true-up:实测非「11」)`attachment.*.other` 权限码(member/certificate 两 owner × upload/view/update/delete 四动作);**PR7 起 `group-manager` 已绑其中 4 条**(`upload`/`view` × member/certificate,设计内决定非疏漏——绑了也不授能力因全 8 条均无 enforcement,scoping 对);余 4 条(`update`/`delete` × member/certificate)当前 seed 不绑任何 meta 角色。**将来 attachment.other 接线启用 enforcement 时**,需复核是否纳入 F1 `RESERVED_SUPER_ADMIN_ONLY_PERMISSION_CODES`(`seed-rbac.e2e` 漂移哨兵 + 常量 completeness 测试会抓不一致)。
- **F5/F6 关联:dev-only 依赖 CVE**(P3)— ~~`fast-uri`(`@nestjs/cli>…>ajv`,path-traversal/host-confusion high)~~ **✅ 已随 review #484 G25 批的全局 `fast-uri` override 一并解决(2026-07-03;见下)**;~~`@types/supertest>…>form-data`(CRLF high)~~ **✅ 已修复**:当前 `@types/supertest@7.2.0 → @types/superagent@8.1.9 → form-data@4.0.5`,`pnpm why form-data` 可复核该 dev 链已解析到修复版。**+ `cos>fast-xml-parser` <5.7.0 moderate**(XMLBuilder 注入;需 4→5 **breaking major**,cos 仅解析腾讯云响应、不以不可信输入构造 XML,低危,本批拍板范围外,现状不变)。
- **F18(报告 §3):CI `pnpm audit` 门禁** ✅(2026-07-23)— 已有独立 `Production dependency audit` workflow，支持最终 SHA 手工 dispatch 与 `v*` tag 自动触发，固定执行 `pnpm audit:production` 并以 high/critical 为硬门；#750 移除无依赖安装场景下的无效 pnpm cache，确保 audit 成功后 post-job 仍整体绿色。moderate/low 继续逐条登记，不以 exit code 静默接受。
- **review #484 G10/G25:生产可达依赖 CVE overrides 收口** ✅(本 PR,2026-07-03;`pnpm audit -P` **9 → 3**)——**G10(已修)**:`qs`(经 `@nestjs/platform-express>express`,DoS)+ `js-yaml`(经 `@nestjs/swagger`,DoS)两条生产可达 moderate CVE 已通过 `pnpm.overrides` 收口(`qs` 全局 `^6.15.2` 同时覆盖 COS `request>qs` 路径;`js-yaml` 因树上另有不相关 `3.14.2` 消费者,改用 `@nestjs/swagger>js-yaml` scoped `^4.2.0` 避免误伤)。**G25(best-effort,部分收口)**:COS `request` 传递链——`tough-cookie`(`request>tough-cookie` `^4.1.3`)/ `ajv`(`conf>ajv` `^8.18.0`)/ `uuid`(仅 `tencentcloud-sdk-nodejs-common>uuid` `^11.1.1` 路径)三项已 override 收口。**残留(逐条注明,均非本批可解)**:① `request` 本体(SSRF,`.>cos-nodejs-sdk-v5>request`)——advisory 明示 patched 版本 `<0.0.0`(即无解),upstream 已弃用永不再发版,**等 COS SDK 换传输层**(或弃用 `cos-nodejs-sdk-v5`)才可能消除;② `uuid` 经 `request>uuid` 路径——**曾尝试 override 到 `^11.1.1` 但导致 2 个 unit 测试套件(`attachments.service.spec.ts` / `storage-provider.router.spec.ts`)整体加载失败**,根因是 `request` 自身冻结代码 `lib/auth.js` 用旧式深路径 `require('uuid/v4')`(uuid 7.x 起废弃该子路径导出),与 CVE patched 下限 `>=11.1.1` **结构性不可兼容**(无论选哪个 ≥11.1.1 版本都会炸),已撤销该条 override,不硬上;③ `fast-xml-parser`(`.>cos-nodejs-sdk-v5>fast-xml-parser`)——现状不变,见上 F5/F6 行(4→5 major,本批范围外)。**副作用(已处理)**:`ajv` override 到 8.x 后,ajv 自身传递依赖 `fast-uri` 引入 2 条**更高severity**(high)的新 CVE(path-traversal + host-confusion);已追加全局 `fast-uri: ^3.1.2` override 一并解决(全树仅此一个 fast-uri 消费来源 `ajv`,零冲突),此举同时消除了上面 F5/F6 登记的 dev-only fast-uri 项。回归自证:build/lint/typecheck 0 错误,unit 71 suites/2140 全绿,contract 525 全绿(snapshot 零 diff),full e2e 123 suites/2438 全绿。

- **v0.61.0 `fast-uri` 安全补丁** ✅(2026-07-23,#749)— 上述 `^3.1.2` 是 2026-07-03 初次 override 的历史值；当前已提升为 `^3.1.4`，production graph 唯一解析到 `fast-uri@3.1.4`，消除 `cos-nodejs-sdk-v5 > conf > ajv` 链的 `GHSA-v2hh-gcrm-f6hx` High。COS SDK/conf/ajv 未升级；审计仍仅有与 v0.60.0 完全相同的 3 个 COS 传递链 moderate。

### P2-7 #399 review P3 处理残余(接受+登记 2 项;**均无当前运行时危害**) — 2026-06-20 收口登记

> #399 §3 的 13 项 P3:**9 项已修**(#409-#413,见归档区 + 冻结报告 ✅ P3 处理状态)、**1 项已完成**(F18 CI audit gate,见上 P2-6 末项)、**1 项已完成移入已完成项归档区**(F13,见文末;review #484 G27),以下 2 项 R0 triage 复核后**接受+登记**:

- **F7 付费核验 cost-DoS**(P3)— 同 openid 可用不同伪造身份证号无限提交、每条直达付费实名核验(去重键 `(cycleId,idCardNumber)` 无 per-openid 上限),与已接受的 28003 枚举面**同源**(current-state §4)。**真实腾讯云实名核验休眠(DevStub 免费)→ 今日零成本**;接通才激活(类 F2/COS 接通前非紧急)。彻底修 = per-openid 配额(改报名去重语义,属产品决策)→ **真实通道接通触发再评**。
- **F8 promote 写字典码契约**(P3)— promote 写 `MemberProfile.genderCode`/`documentTypeCode` 不经 canonical 字典校验。**R0 复核降级**:`isForeignDocument` 令非 `mainland_id` 即 foreign(不进一键发号),故 promote 只写固定 canonical 码 `mainland_id`/`male`/`female`(身份证派生 / 非用户可控,**无 F3 式注入污染**),且 profile 码当前无字典校验消费点 → **零运行时危害**。真修 = 保证 prod 字典 seed 含 `male`/`female`/`mainland_id` item code(**seed/ops 不变量**;加 promote 断言反会把潜在不一致硬化成 promote 失败、且 demo seed `demo-*` 会打挂既有 e2e)→ seed/字典治理时一并保障。

## 已收口项

全部移至 [`docs/archive/ai-harness/next-tasks-completed.md`](../archive/ai-harness/next-tasks-completed.md)(冻结,不再增长)。

**本文件只留还没做完的事。** 台账一旦开始沉淀历史,就会退化成没人读得完的流水账 ——
2026-07-29 搬出时,15 条活跃条目里有 7 条已完成或已判定不做,另有一个占全文件 60% 的归档区。
