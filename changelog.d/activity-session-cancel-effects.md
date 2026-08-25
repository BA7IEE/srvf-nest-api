### 单场次取消的四格联动接线 —— **ADV-018 结案 / AC-010 收窄到只剩「改期」**(todo 18 → 17)

合同 AC-010 / ADV-018:「取消单个未来场次只影响该场次的名额、二维码、人员、通知和结算人口」。
名额那格第 4 批⑤已落;本刀接的是剩下四格。**这是接线不是造零件** —— 四格全部复用既有原语。

第 5 批交付了二维码链却没回来接 `applyQrCredentialsPlaceholder` 那个空桩,本刀把它换成真联动。

#### 四格各自复用了什么

| 格 | 复用的既有原语 | 新增的是什么 |
|---|---|---|
| 人员 | `activity-cancellation-lifecycle.ts`(整活动取消)的状态口径与全部不变量断言 | 它的**场次级兄弟** `cancelSessionParticipationLifecycle`,区别只在查询按 `sessionId` 收窄 + 全程批量写 |
| 二维码 | `AttendanceQrCredential` 的写形态与 `issue()` 里「顶掉上一条 active 凭证」同形 | 同模块内的批量兄弟原语 `revokeSessionQrCredentialsInTransactionTrusted` |
| 通知 | `freezeRegistrationRoster` + `ActivityNotificationProducer`(**不新增**第 7 个 `FREEZE_BASIS` 常量) | `enqueueSessionCancellation`,走 `enqueueMany` 批量 |
| 结算人口 | §3.17 既有的 `ActivityEvidenceState.populationRevision` 指针 | 把递增逻辑抽成共用原语 `activity-population-revision.ts`(原方法委托过去,零语义变化) |

#### ⭐ 为什么二维码不是直接调既有的 `revoke()`

`revoke()` 的能力**确实完整存在**(Activity 行锁 + 权限断言 + 凭证行锁 + `operationKey/requestHash`
幂等 + 状态守卫 + 审计),但它是**人工单条**命令,四条前提对「场次取消联动」逐条不成立:

1. 它体内自己开 `this.prisma.$transaction(...)` ⇒ 从审批事务里调会开出**另一条独立事务**,
   外层回滚时凭证已作废且撤不回来 —— **原子性直接破掉**。这条是结构性的,不是「不好用」。
2. 它有 `assertManagedAttendance(currentUser)`:发布审核的审批人不必然是考勤管理员 ⇒ 会把正常审批打回。
3. 凭证已是 `revoked` 时它抛 `ATTENDANCE_QR_REVOKED` ⇒ 联动必须幂等,不能因此打回整笔审批。
4. 它按 `credentialId` 单条取锁 + 单条更新 ⇒ 逐条调就是 N+1。

因此新增的是**同模块内的批量兄弟原语**,凭证行的写形态与 `revoke()` 逐字一致,
并沿用 `issue()` 里已有的同形写法(那里同样没有绕回 `revoke()`)。

#### ⭐ 两处「零红区」逼出来的形状(实测,不是偏好)

1. **联动写成「函数 + 显式依赖」而不是新的 `@Injectable()` provider**:新 provider 要登进
   `activities.module.ts`,而 `harness/domain-map.json` 的 `inputDigest` **覆盖全部 `*.module.ts`**
   (`scripts/check-boundaries.ts` 的 `metadataInputs()`)⇒ 动一行 module 就要改红区里的 domain-map。
   改成注在既有 provider 上,零 module 改动。
2. **人员那格按属主拆成两个文件**:`harness/domain-map.json` 把 `ActivityParticipation*`
   判给 `activities`、`ActivityRegistration*` 判给 `activity-registrations`。
   合在一个文件里时其中一侧必然跨属主写,`docs:boundaries:newdebt:check` 当场判**新增架构债**
   (实测 6 条);拆开后两边都是属主写 ⇒ `unknownCount: 0`。
   同理,人口版本递增**没有**从 `ActivityRegistrationLifecycleService` 抽走 ——
   那两处是登记在案的 `XW-0126 / XW-0127`,挪走会让 `docs:boundaries:ids:check` 判
   「登记在案的 call site 不再存在」而红,修它要改债务台账 = 红区。留给清那两条债的刀。

#### 事务与幂等

四件事在**同一把 Activity 根锁、同一笔事务**内(发布审核 approve 那条 `$transaction`),
要么全成要么全不成。幂等两层:①审批入口的 `operationKey` 重放守卫在进 `apply()` 之前就返回;
②「本次刚从 scheduled 变成 cancelled」的场次集合取自 **DB 现状**而不是快照 ——
快照每次都带全量场次,只看快照会把上次就取消掉的场次当成「又取消了一次」重复发通知。

⚠️ **该链路的事务预算是 Prisma 默认 5s,不是 `MEMBER_TX_TIMEOUT_MS` 的 7000ms** ——
`activity-publish-review.service.ts` 的 `$transaction` 不带 options,也不走 `withMemberAdvisoryLock`。
因此:两次 `createMany` + 两条 `UPDATE ... FROM (VALUES ...)`(行级 CAS 塞进 VALUES),
**零逐条 await**;也不用 advisory lock 逐人取锁(PG 共享锁表保底 12800,万人级会 `out of shared memory`)。
原生 UPDATE 绕过 Prisma 的 `@updatedAt` ⇒ 两条都显式写 `updatedAt`。

#### ⭐ 判据形状:每格正向 + **反向**,反向是「正面数出 B 场次纹丝不动」

`test/e2e/activity-session-cancel-effects.e2e-spec.ts`:同一个活动两个场次 A / B,三个队员
(只报 A / 只报 B / 两场都报),**反面样本只在 sessionId 这一维上不同** ——
换成两个活动,活动级隔离会把场次级收窄整片遮住(「上层边界遮蔽下层边界」)。

| 格 | 正向 | 反向 |
|---|---|---|
| 人员 | 报 A 的两个身份 → `cancelled` / `currentRevision 2` / `version 1`,修订带 `cancelledByUserId` 与原因 | B 的两行**逐字段**(含 `updatedAt` / `version`)与取消前完全相等;且 B 的身份**一条新修订都不许多出来**(只断言「没变 cancelled」不够);只报 B 的人**连报名头都不许被碰** |
| 二维码 | A 的凭证 → `revoked` + 撤销人 + 原因 | B 的凭证**整行不变**(含 `updatedAt`) |
| 通知 | 收件人恰为 {只报 A, 两场都报};冻结 `basisRef` = `['session:<A>']` | 只报 B 的那个人的 intent 数**正面数出 0**,再加总数恰为 2 |
| 结算人口 | `ActivityEvidenceState.populationRevision` +1 | 重放同一 `operationKey` 时四格读数逐条不变 |

活动级报名头的投影也一并验:只报 A 的人 → 头变 `cancelled`;两场都报的人 → 头仍 `pending`(B 还在)。

#### 第四格(结算人口)的判定:**不动 schema**

合同 §3.17 逐字把「场次取消／终止」列为 `ActivityEvidenceState` 的递增来源,而该表定义就是
「**一活动一行**」的人口版本指针;场次维度的人口事实由 `EvidenceSeal.populationCountBySession`
(Json 快照)承载。**全仓没有场次级人口版本列,合同也没有要求有** ⇒ 不新增列,
只把 §3.17 已经写明、但从没有人接的那个递增来源接上。

#### AC-010 为什么不结案

合同原文是「取消**或改期**」。改期那一格全套用例从未覆盖:`sessions.update` 的既有用例只出现过
`name` / `locationText` / `capacity`,**没有任何用例改过 `startAt` / `endAt`**。
而且改期不是取消的同形 —— 二维码的 `validFrom` / `validUntil` 是签发时从场次时间窗**冻下来的**,
改期后旧码的有效期与新窗口不一致,「改期是否作废旧码」要先裁定再补测。卡点文本已收窄到这一句。
