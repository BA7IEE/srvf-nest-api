# 企业微信消息链失败注入剧本(T6)

> **谁在什么时候读它**:维护者(或代维护者跑演练的运维/开发),在消息链试点的 B 步之后、签署扩大范围之前。冻结稿 §15.2 条 8 要求「Provider 故障、token 失效、DB 故障、Worker crash 注入完成」——这份文档就是把那一句变成四套可执行的演练。
> **读完要能做成什么**:在**非生产**环境把四类故障真造出来一遍,亲眼看到每一类的终态是什么;并且知道生产环境里哪几类**可以**安全演练、哪几类**不能**,以及不能的那几类靠什么替代证据。
>
> **需求真相源**:冻结稿 [`wecom-integration-t0-terminal-review.md`](../archive/reviews/wecom-integration-t0-terminal-review.md) §15.2 条 8 / §10.7(投递结果分类)。

---

## 0. 这份剧本要回答的唯一问题

> **每一类故障发生之后,那条消息的终态对不对 —— 尤其是「有没有被误记成 SENT」。**

`SENT` 在本系统里是一条**跨 generation 的永久去重事实**:一旦记了 `sent`,那个人**再也不会**收到这条通知
(即便他其实一个字都没看到)。所以每一项演练的核心断言都是同一个:

| 断言 | 怎么查 |
|---|---|
| **没有误记 SENT** | 见 §1.3 的通用 SQL,`status='sent'` 的行数必须与「真的发出去了的人数」一致 |
| 终态分类正确 | `reasonCode` 落在 §10.7 规定的那一格 |
| 该重试的重试了、该终止的终止了 | `attempts` 与 `status` 的组合 |

---

## 1. 通用准备

### 1.1 环境选择

| 类别 | 非生产(dev / 本地 / 预发) | 生产 |
|---|---|---|
| A. Provider 故障 | ✅ DEV_STUB 注入 | ❌ **做不了**(见 §6) |
| B. token 失效 | ✅ DEV_STUB 注入 | ❌ **做不了**(见 §6) |
| C. DB 故障 | ✅ 真断连接 | ❌ **不该做**(见 §6) |
| D. Worker crash | ✅ kill 进程 | ✅ **可以安全做**(见 §5.3) |

> 🔴 **四类里只有 Worker crash 能在生产安全演练。** 另外三类必须在非生产环境用 DEV_STUB 完成,
> 生产侧靠 §6 列出的替代证据。**这不是偷懒,是这三类在生产没有安全的注入手段** —— 详见 §6。

### 1.2 非生产环境的注入机制:DEV_STUB 的 `wecomerr-*` 前缀

`DevStubWecomProvider.sendTextCard` 按 **`toUser`**(也就是绑定时写进 `wecom_identities.wecomUserId`
的那个值)提供投递语义故障注入 —— 这套机制 **T5B 已经实现好了,不要另造**
([`dev-stub-wecom.provider.ts`](../../src/modules/wecom/providers/dev-stub-wecom.provider.ts)):

| `wecomUserId` 含这个子串 | stub 返回 | 对应真实场景 |
|---|---|---|
| `wecomerr-invaliduser` | `errcode=0` 但该 userid 在 `invaliduser` 里 | userid 无效 / 不在应用可见范围 |
| `wecomerr-unlicensed` | `errcode=0` 但该 userid 在 `unlicenseduser` 里 | 该成员缺基础接口许可 |
| `wecomerr-81013` | `errcode=81013` | 全部收件人无效 |
| `wecomerr-ratelimit` | `errcode=45009` | 官方频率限制 |
| `wecomerr-party` | `INVALID_PARTY_OR_TAG` | 单 touser 却收到 invalidparty/invalidtag(契约错) |
| `wecomerr-net` | `FETCH_ERROR` | 网络 / 超时 / 5xx |
| `wecomerr-token` | `errcode=42001` | access_token 失效 |

> ⚠️ 注入前缀一律 `wecomerr-`,与真实企业微信 userid 命名空间不重叠;
> 且 DEV_STUB 在 production / smoke **物理不可达**(写入口 + 运行时双重拒绝),不构成生产风险。

**怎么让一个测试账号的 `wecomUserId` 含这些前缀**:DEV_STUB 的 `exchangeOAuthCode` 返回的是
`dev-wecom-<sha256(code) 前 24 位>`,你没法通过走登录流程凑出想要的字符串。
**非生产环境直接写 identity 行**:

```sql
-- 仅限非生产!先确认 SELECT current_database(); 不是生产库
INSERT INTO wecom_identities (id, "userId", "corpId", "wecomUserId", status, "bindingSource", "boundAt", "createdAt", "updatedAt")
VALUES ('drill-invaliduser', '<测试 User.id>', '<当前 corpId>', 'wecomerr-invaliduser-001',
        'active', 'me', now(), now(), now());
```

每类故障建一个专用测试 User + 一行 identity,演练完整批删掉。

### 1.3 通用观察 SQL(每次演练后都跑)

```sql
-- ① 该通知的投递分类全貌
SELECT status, "reasonCode", "errCode", count(*)
FROM notification_deliveries
WHERE channel = 'wecom' AND "notificationId" = '<通知 id>'
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

```sql
-- ② 该通知的 intent 状态与重试次数
SELECT status, attempts, "lastErrorClass", "lastErrorCode", "availableAt", "deadAt"
FROM notification_outbox_intents
WHERE "eventType" LIKE 'notification.wecom-%'
  AND payload::text LIKE '%<通知 id>%'
ORDER BY "createdAt";
```

```sql
-- ③ 🔴 核心反向断言:有没有误记 SENT
SELECT count(*) FROM notification_deliveries
WHERE channel = 'wecom' AND "notificationId" = '<通知 id>' AND status = 'sent';
-- 期望:等于「本次演练中真的应该发成功的人数」,注入的故障账号一个都不在里面
```

### 1.4 基线常量(判据要用)

| 常量 | 值 | 出处 |
|---|---|---|
| 暂态失败最大重试 | **8 次**后 `dead` | `OUTBOX_MAX_ATTEMPTS` |
| 退避基数 / 上限 | 1s / 15 分钟 | `OUTBOX_BACKOFF_BASE_MS` / `_MAX_MS` |
| `-1` 系统繁忙 | 最多 **3** 次 | 冻结稿 §10.7 |
| `40014`/`42001` token 失效 | **单次 attempt 内**强刷后只再发一次;attempt 本身仍算暂态走 8 次退避(⚠️ 两层,见 §3.1) | 冻结稿 §10.7 |
| `45009` 限流 | **不重试**,直接 dead | 冻结稿 §10.7 |

---

## 2. A. Provider 故障注入

Provider 故障分两类,**必须分开做** —— 它们的终态完全相反。

### 2.1 A-1:成功回执里带坏消息(`errcode=0` 但 invaliduser / unlicenseduser)

**这是最容易被写错的一类**:上游说「成功」,但那个人其实没收到。

**注入**:给两个测试账号分别造 `wecomerr-invaliduser-001` 和 `wecomerr-unlicensed-001` 的 identity,
把它们放进一条 wecom 通知的受众里,publish。

**期望终态**:

| 账号 | `status` | `reasonCode` |
|---|---|---|
| `wecomerr-invaliduser-*` | `skipped` | `recipient-unavailable` |
| `wecomerr-unlicensed-*` | `skipped` | `recipient-unlicensed` |
| 正常账号 | `sent` | `null` |

🔴 **怎么确认没有误记 SENT**:跑 §1.3 的 ③。
`sent` 计数**必须只等于正常账号数**。若两个注入账号里有任何一个记了 `sent`,
说明「`errcode=0` 仍必须逐条查 invaliduser / unlicenseduser」这条判据没生效 —— **严重,停止并上报**。

**不符怎么办**:两个注入账号落成了同一个 `reasonCode` ⇒ 分类合并了。
这两者的处置完全不同(`recipient-unavailable` 查可见范围;`recipient-unlicensed` 是采购决策),
合并即失去可操作性,上报。

### 2.2 A-2:上游直接失败(81013 / 45009 / invalidparty / 网络)

**注入**:四个测试账号,分别 `wecomerr-81013` / `wecomerr-ratelimit` / `wecomerr-party` / `wecomerr-net`。

**期望终态**:

| 账号 | `status` | `reasonCode` | intent | 为什么 |
|---|---|---|---|---|
| `wecomerr-81013` | `skipped` | `recipient-unavailable` | 终态 | 与 invaliduser 归同一格:官方无法可靠区分「userid 不存在」与「不在可见范围」,**第一版不伪造更细原因** |
| `wecomerr-ratelimit` | `failed` | `rate-limited` | **`dead`,`attempts` 不应涨到 8** | 45009 **不盲重试** —— 官方拦截窗口内重试只会延长拦截 |
| `wecomerr-party` | `failed` | `provider-contract-error` | **`dead`** | 单 touser 请求收到 invalidparty ⇒ 请求契约错,**这是 bug 信号** |
| `wecomerr-net` | 先 `pending` 重试,耗尽后 `failed` | `api-failed` | 重试到 **8 次**后 `dead` | 暂态,走既有退避 |

🔴 **`wecomerr-net` 这一项要看重试**有没有**真的发生** —— 有两个独立观察点,**都要看**:

```sql
-- ① intent 侧:attempts 递增,availableAt 按退避往后推
SELECT attempts, status, "availableAt" FROM notification_outbox_intents
WHERE "eventType" = 'notification.wecom-delivery' AND status IN ('pending','failed','dead')
ORDER BY "updatedAt" DESC LIMIT 5;
```

```sql
-- ② delivery 侧:暂态行**不占 intent.id**,所以每次 attempt 累积一行 —— 行数就是重试次数
SELECT count(*) FROM notification_deliveries
WHERE channel = 'wecom' AND "memberId" = '<注入账号的 memberId>'
  AND status = 'failed' AND "reasonCode" = 'api-failed';
-- 期望:随时间涨到 8
```

期望 `attempts` **随时间递增**(1 → 2 → 3 …),②的行数同步增长。

⚠️ **这一项是有历史的**:T5B 交付中修掉的真 bug 正是——暂态失败的 delivery 行占了 `intent.id`,
于是下次重试撞上自己的幂等判据直接返回,**「退避重试 8 次」退化成「第一次网络抖动即永久放弃」,
而且现场看起来一切正常**(intent 有终态、worker 不报错)。
**所以这一项不能只看最终状态,必须看 `attempts` 有没有真的涨过。**

**不符怎么办**:

- `wecomerr-net` 的 `attempts` 停在 1 就 dead ⇒ 上面那个 bug 复发,**严重**,停止并上报;
- `wecomerr-ratelimit` 的 `attempts` 涨到了 8 ⇒ 45009 被当成暂态盲重试了,上报;
- `wecomerr-party` 被忽略(记了 sent 或 skipped)⇒ 契约错被吞,上报。

---

## 3. B. token 失效注入

**注入**:测试账号 `wecomerr-token-001`(stub 恒返 `errcode=42001`)。

### 3.1 先分清两个「重试一次」—— 它们是不同层级的东西

冻结稿 §10.7 的「`40014/42001` 强刷 Token 后仅重试一次」说的是**单次 attempt 内部**的行为,
**不是** outbox 的重试次数。两层各管各的:

| 层级 | 行为 | 出处 |
|---|---|---|
| **单次 attempt 内** | `send(false)` → 收到 42001 → **强刷 token 后 `send(true)` 一次**,就到此为止。**禁止刷新循环** —— 一次配置错误会变成对上游的持续打点,而 `45009` 正是这么被触发的 | [`notification-outbox.handlers.ts`](../../src/modules/notifications/notification-outbox.handlers.ts) 的 `deliverWecom` |
| **outbox 层** | `42001` 被归为**暂态**(`isTransientWecomError`),所以整个 attempt 走**通用退避,最多 8 次**后 dead | 同文件 `isTransientWecomError` |

🔴 **所以本项的期望不是「attempts=1」。** 期望是:**每次 attempt 只发两次请求,而 attempt 本身重试到 8 次。**

### 3.2 期望终态

| 观察点 | 期望 |
|---|---|
| `notification_deliveries` | 每次 attempt 落**一行** `status='failed'` / `reasonCode='token-failed'` / `errCode='42001'` |
| 行数 | 随重试累积,最终 **8 行**(暂态行**不占 `intent.id`**,所以会累积而不是覆盖) |
| `notification_outbox_intents` | `attempts` 涨到 **8**,最终 `status='dead'` |
| 🔴 SENT | **0 行** |

```sql
-- 暂态行按 attempt 累积:行数就是重试次数
SELECT status, "reasonCode", "errCode", count(*)
FROM notification_deliveries
WHERE channel = 'wecom' AND "memberId" = '<注入账号的 memberId>'
GROUP BY 1, 2, 3;
-- 期望:failed / token-failed / 42001,count 随时间涨到 8
```

### 3.3 ⚠️ 哪一半验得了、哪一半验不了

- ✅ **验得了**:分类是 `token-failed`(不是 `api-failed`)、走的是退避重试(不是一次就死)、没有误记 SENT。
- ❌ **验不了**:「单次 attempt 内只刷了一次 token」——**每次 attempt 只写一行 delivery 记录**,
  所以数据库分不出这次 attempt 内部发了 1 次还是 10 次请求。
  这条性质由单测钉住,不由本演练证明。**不要**把「8 行记录」读成「刷了 8 次 token」——
  那是 8 次 attempt,每次 attempt 内部最多两次请求。

**不符怎么办**:

- 分类落成 `api-failed` ⇒ token 失效和普通上游失败被混为一类,处置方向会错(前者查凭证/时钟,后者查网络),上报;
- 第一次失败就 `dead` ⇒ token 恰好过期这种**正常**情况会把本来能发成功的消息判死,上报;
- 出现 `sent` ⇒ 严重,停止并上报。

> ℹ️ **这一项在生产做不了**:让生产的 access_token 真的失效,唯一办法是改凭证或等它自然过期 ——
> 前者会打断所有试点成员,后者不可控。生产侧的替代证据见 §6。

---

## 4. C. DB 故障注入

**注入**(非生产):在 worker 正在跑一批 wecom intent 时,**切断 worker 到 PostgreSQL 的连接**。
可选做法(按环境挑一个):

- 停掉数据库容器几十秒后再起(`docker compose stop postgres` → `start`);
- 或在 DB 侧 `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name LIKE '%outbox%';`

**期望终态**:

| 现象 | 期望 |
|---|---|
| worker 进程 | **不崩**,只记安全 errorClass 并退避续跑 |
| 在途 intent | **不 ack / 不 nack / 不 dead**;旧 owner 的 lease 到期后被别人 reclaim |
| DB 恢复后 | intent 被重新领走并继续推进 |
| 🔴 SENT | **不得凭空出现**;也不得把已经 `sent` 的改回 pending |

**怎么验**:

```sql
-- 恢复后:没有 intent 卡在 processing 且 lease 已过期还没人接手
SELECT status, count(*), min("leaseExpiresAt"), max("leaseExpiresAt")
FROM notification_outbox_intents
WHERE "eventType" LIKE 'notification.wecom-%'
GROUP BY 1;
```

- 断连期间:允许有行卡在 `processing`(lease 还没过期);
- 恢复后**再等一个 lease 周期**:`processing` 应当归零或被重新推进;
- 全程 §1.3 的 ③ 计数**只增不减,且每一次增加都对应一个真的发出去了的人**。

**不符怎么办**:

- worker 进程直接退出 ⇒ 与「单轮 DB 异常只记 errorClass 并退避续跑」不符,上报;
- 断连期间有 intent 被判 `dead` ⇒ DB 抖动导致真消息永久丢失,**严重**,上报;
- 恢复后 `processing` 长期不归零 ⇒ lease 没被回收,查 `leaseExpiresAt` 是否在过去。

> ℹ️ **这一项在生产不该做**:主动切断生产数据库会影响全部业务(不只是企业微信)。
> 生产侧的替代证据见 §6。

---

## 5. D. Worker crash 注入

### 5.1 非生产:kill -9

**注入**:在 worker 正在处理一批 wecom intent 时 `kill -9 <worker pid>`(**不是** `SIGTERM` ——
`SIGTERM` 走的是优雅关停路径,那测的是另一件事,见 §5.2)。

**期望终态**:

- 被 kill 的那一刻正在处理的 intent 停在 `processing`,`leaseOwner` 是死掉的那个 worker;
- **lease 过期后**被新 worker reclaim 并重新执行;
- 🔴 **可能出现重复推送** —— 这是**已知且不承诺消除**的窗口:Provider 已接受但本地 ack 之前崩溃。
  期望的是「卡片重复,但都指向同一条 notification,点开幂等」,**不是**「不重复」。

```sql
-- crash 之后:有行卡在 processing,leaseOwner 是死进程
SELECT status, "leaseOwner", "leaseExpiresAt", attempts
FROM notification_outbox_intents
WHERE "eventType" LIKE 'notification.wecom-%' AND status = 'processing';
-- 等 lease 过期后重查:应被新 worker 接手(leaseOwner 变了)或已推进到终态
```

**不符怎么办**:

- lease 过期后**没人接手**,行永久卡在 `processing` ⇒ reclaim 没工作,上报;
- crash 之后该行直接变 `dead` ⇒ 崩溃被当成永久失败,上报。

### 5.2 非生产:优雅关停(SIGTERM)

**注入**:`kill -TERM <worker pid>`。

**期望终态**:worker **先停止领新的**,再把在途 attempt 与 heartbeat 排空,然后退出。
排空期间不应出现新的 claim。

**为什么这一项也要做**:§15.4 的消息链回滚第 2 步「用**新** worker 排空或终结所有 WeCom intent」
依赖的正是这条路径。它没验过,回滚时的排空就是没验过的。

### 5.3 ✅ 生产:这一类可以安全演练

**唯一可以在生产安全做的注入**:在**没有 wecom intent 在途**的时刻(§1.3 ② 查一下,
`pending`/`processing` 都是 0),对 worker 做一次**正常的滚动重启**。

**期望**:

- 重启前后 §1.3 ③ 的 `sent` 计数**完全不变**(没有凭空补发、也没有丢);
- 重启后发一条测试通知能正常投递。

🔴 **不要在生产用 `kill -9`,也不要在有 intent 在途时重启**:那会真的造出重复推送,
打扰试点成员且没有额外信息量(重复窗口的存在是**设计事实**,不需要在生产上再证明一次)。

---

## 6. 生产环境:哪些做不了,以及靠什么替代

冻结稿 §15.2 条 8 要求四类注入「完成」,但没有要求**在生产**完成。下面逐条说清楚。

| 类别 | 生产能不能做 | 为什么 | 替代证据 |
|---|---|---|---|
| **A. Provider 故障** | ❌ **做不了** | 让真实企业微信按需返回 `invaliduser` / `81013` / `45009`,需要故意搞坏可见范围或故意触发限流 —— 前者影响试点成员,后者会让整个企业被官方拦截一段时间 | ① 非生产 DEV_STUB 全类跑通(§2);② **试点期真实回执**:B 步 1–3 人试发时若自然出现 `unlicenseduser`,那就是一次真实的 A-1 演练,如实记入 playbook 留证 ⑦ |
| **B. token 失效** | ❌ **做不了** | 唯一手段是改凭证(打断所有试点成员)或等自然过期(不可控) | ① 非生产 DEV_STUB(§3);② 生产上 `test-connection` **每次强制跳过缓存取新 token**,反复跑它就是在真实验证「取 token 这条路是通的」——它验不了 42001 分支,但验得了 token 获取本身 |
| **C. DB 故障** | ❌ **不该做** | 主动切断生产数据库影响全部业务,风险远超收益 | ① 非生产真断连(§4);② 生产上任何一次**计划内**的数据库维护 / 主备切换,事后按 §4 的 SQL 复查一遍,就是一次免费的真实演练 —— **把它记下来当证据** |
| **D. Worker crash** | ✅ **可以做** | 重启 worker 是常规运维动作,且有 §5.3 的安全前提 | 直接做,见 §5.3 |

🔴 **诚实边界**:本剧本**不声称**「生产环境已完成四类注入」。它声称的是:
**四类在非生产环境真造出来过,生产环境完成了其中可安全完成的一类,其余三类有替代证据。**
签署扩大范围时按这个口径记录,不要写成「四类生产注入完成」——那是假话。

---

## 7. 演练结果登记表

| 类别 | 环境 | 日期 | 终态是否符合期望 | 🔴 有无误记 SENT | 备注 |
|---|---|---|---|---|---|
| A-1 invaliduser | 非生产 | | ☐ | ☐ 无 | |
| A-1 unlicensed | 非生产 | | ☐ | ☐ 无 | |
| A-2 81013 | 非生产 | | ☐ | ☐ 无 | |
| A-2 45009 | 非生产 | | ☐ | ☐ 无 | |
| A-2 invalidparty | 非生产 | | ☐ | ☐ 无 | |
| A-2 网络失败(看 `attempts` 递增) | 非生产 | | ☐ | ☐ 无 | |
| B token 失效(分类 `token-failed` + 走退避,§3.1 两层) | 非生产 | | ☐ | ☐ 无 | |
| C DB 故障 | 非生产 | | ☐ | ☐ 无 | |
| D worker `kill -9` | 非生产 | | ☐ | ☐ 无 | |
| D 优雅关停排空 | 非生产 | | ☐ | ☐ 无 | |
| D worker 重启 | **生产** | | ☐ | ☐ 无 | |
| A/B/C 生产替代证据已记录 | 生产 | | ☐ | — | |

**演练后清理**(非生产):删除本次为注入建的测试 User 与 `wecom_identities` 行。

---

## 8. 相关文档

- 冻结稿 §15.2 / §10.7:[`wecom-integration-t0-terminal-review.md`](../archive/reviews/wecom-integration-t0-terminal-review.md)
- 消息链上线与回滚:[`wecom-message-channel-rollout.md`](wecom-message-channel-rollout.md)
- 试点执行与十项留证:[`wecom-pilot-playbook.md`](wecom-pilot-playbook.md)
- 后台配置与身份链:[`wecom-backend-configuration-sop.md`](wecom-backend-configuration-sop.md)
- Outbox 不变量:[`src/modules/notifications/CLAUDE.md`](../../src/modules/notifications/CLAUDE.md)
- DEV_STUB 注入实现:[`dev-stub-wecom.provider.ts`](../../src/modules/wecom/providers/dev-stub-wecom.provider.ts)
