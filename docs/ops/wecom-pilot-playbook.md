# 企业微信 10–30 人分层试点执行手册(T6)

> **谁在什么时候读它**:维护者,在 [`wecom-backend-configuration-sop.md`](wecom-backend-configuration-sop.md) §14 的十五条身份链 GO 全部勾上之后,到「签署扩大企业微信应用可见范围」之前的整个试点期。
> **读完要能做成什么**:选出一份合格的 10–30 人试点名单、按 A→B→C 三步把功能放出去、把十项留证逐条做完并留下可复核的证据,最后拿到一个**能签字的**扩大决定 —— 或者一个**明确不能扩大**的结论。
>
> **需求真相源**:冻结稿 [`wecom-integration-t0-terminal-review.md`](../archive/reviews/wecom-integration-t0-terminal-review.md) §15.3。冲突以冻结稿为准。

---

## 0. 一句话:这份手册在防什么

> **§15.3 原文:「不能以『接口能通』或『试用了几天没报错』代替上述验收。」**

这两句话描述的是同一类失败:**用「没看见坏事」冒充「验过了好事」。**

- 「接口能通」证明的是 HTTP 200,不是「该收到的人收到了、不该收到的人没收到」;
- 「试了几天没报错」证明的是**没人报告**,不是**没发生** —— 试点期最危险的三种故障
  (发错人、该发没发、回滚后迟到补发)全都**不会报错**,现场看起来一切正常。

所以本手册的每一项留证都必须包含**一条正向断言和一条反向断言**:
不仅「A 收到了」,还要「B 在同样条件下确实没收到,且 B 的站内信仍然可读」。
只有一半的证据,这一项**不算过**。

---

## 1. 前置(全部满足才开始选名单)

- [ ] [`wecom-backend-configuration-sop.md`](wecom-backend-configuration-sop.md) §14 十五条身份链 GO **全部勾上**;
- [ ] 当前状态:`enabled=true` / `loginEnabled=true` / **`messageEnabled=false`**;
- [ ] 你已经知道 §15.4 的两条回滚怎么按(身份链见 SOP §13,消息链见
      [`wecom-message-channel-rollout.md`](wecom-message-channel-rollout.md) §7)。
      **不知道怎么关就不要开** —— 这是本仓的一贯纪律,不是客套话。

---

## 2. 试点名单(§15.3 六类构成)

### 2.1 规模

**固定 10–30 人。** 不足 10 人覆盖不全六类角色;超过 30 人则出问题时的人工兜底成本超过试点收益。

🔴 **应用可见范围不得先开全员**(冻结稿 §15.3)。名单确定后按 SOP §4 逐人加进企业微信应用可见范围。

### 2.2 六类必须覆盖的人

| # | 类别 | 至少几人 | 为什么这一类不能少 |
|---|---|---|---|
| 1 | 普通队员 | ≥3 | 绝大多数真实用户是这一类;也是「有资格看某条通知」的最小权限基线 |
| 2 | 活动发起人 / 活动责任人 | ≥1 | 活动类通知的受众判定走的是另一条路径(活动轴),普通队员测不到 |
| 3 | 考勤一级审核人和/或终审人 | ≥1 | 考勤退回 / 终审通知是定向通知,收件人从 assignment 解析 |
| 4 | 部门负责人 / 组织管理员 | ≥1 | 部门广播认四类当前有效 Membership + Organization ACTIVE,是最容易配错的一档可见性 |
| 5 | `SUPER_ADMIN` | ≥1 | management 档只认 SUPER_ADMIN 或当前 GLOBAL `notification.read.record` |
| 6 | **至少一个未绑定手机号的专用测试账号**(或等价测试夹具) | **=1(必须有)** | 见 §2.3 |

> ⚠️ 一个人可以同时满足多类(例如维护者本人既是 SUPER_ADMIN 又是部门负责人),
> 但**第 6 类必须是独立账号** —— 它的定义就是「`User.phone` 为空」,不可能和别人合并。

### 2.3 为什么第 6 类是硬性的

冻结稿 §0.5 条 2:**没有绑定系统手机号的人,系统不能按姓名或部门猜测绑定。**
这类用户只能走「原账号登录 → step-up → self-bind」这条兜底路径。

如果试点名单里没有这样一个人:

- 留证 ② 根本做不了;
- 而真实队伍里**一定存在**这类人(新队员、只用工号登录的人、手机号换了没更新的人);
- 于是你会在扩大范围之后才第一次发现这条路走不通,那时受影响的是几百人而不是一个测试账号。

**怎么造这个账号**:建一个专用 User(`POST admin/v1/users`),**不设手机号**,分配普通队员角色。

✅ **判据**:

```sql
SELECT id, username, phone IS NULL AS no_phone
FROM users WHERE username = '<测试账号用户名>';
-- 期望:no_phone = true
```

❌ **不符怎么办**:`no_phone=false` ⇒ 这个账号有手机号,它会走路径 A 而不是兜底路径,
留证 ② 会**假绿**。清掉手机号(`DELETE admin/v1/users/{id}/phone`)或换一个账号。

### 2.4 名单登记

🔴 **名单本身不写进本仓库任何文件**(R13 红线:真实姓名 / 手机号 / `memberNo` 的对照关系
一律不入仓库,含 issue、PR 描述、commit message、AI 会话记录)。
名单由维护者线下保存;本文件只记录**人数与类别覆盖**,不记录人。

| 类别 | 计划人数 | 实际人数 | 已加入应用可见范围 |
|---|---|---|---|
| 普通队员 | | | ☐ |
| 活动发起人 / 责任人 | | | ☐ |
| 考勤审核人 | | | ☐ |
| 部门负责人 / 组织管理员 | | | ☐ |
| SUPER_ADMIN | | | ☐ |
| 无手机号测试账号 | | 1 | ☐ |
| **合计** | | **(10–30)** | |

---

## 3. 三步启用(§15.3;顺序不可跳)

### A 步:`messageEnabled=false`,只验身份链

**做什么**:全部试点成员在企业微信工作台完成首次绑定与重复免密登录;完成留证 ①–⑥。

**这一步的通道状态**:`enabled=true` / `loginEnabled=true` / `messageEnabled=false`。

✅ **进入 B 步的判据**:留证 ①–⑥ **全部**完成且无未关闭问题。
❌ **不符怎么办**:任一项不过就停在 A 步。A 步的问题在 B 步只会被消息链的噪声盖住,不会自己消失。

### B 步:先向 1–3 人发定向消息

**做什么**:

1. 按 [`wecom-message-channel-rollout.md`](wecom-message-channel-rollout.md) §1–§4 打开消息链
   (**那份文档的前置硬门必须先过**,尤其混版本那条);
2. 发**一条**勾了 `wecom` 的通知,受众收窄到 **1–3 名**试点人员;
3. 逐人核对企业微信终端**真的收到了**,并与 `notification_deliveries` 的记录对照;
4. **记录是否出现 `invaliduser` / `unlicenseduser`** —— 这是 B 步存在的主要理由。

**为什么先只发 1–3 人**:`unlicenseduser`(缺基础接口许可)是一个**运营/采购**问题,
不是系统故障。它只能由逐人回执事后裁决 —— 没有任何接口能提前预测。
先发 3 个人,你花 3 条回执就知道「这个企业的许可覆盖是什么情况」;
直接发 30 个人,你会在一堆噪声里同时处理许可、可见范围、绑定率三件事。

✅ **进入 C 步的判据**:

- 1–3 人**全部**在企业微信终端实际看到了卡片(不是「Delivery 记了 sent」——见 §5 ⑦ 的双断言);
- `notification_deliveries` 的分类与终端事实一致;
- 若出现 `recipient-unlicensed`:已确认**站内信仍可读**,且已记录该成员编号交运营决定是否补许可
  —— **不修代码、不重试、不在系统里做任何采购动作**。

❌ **不符怎么办**:出现 `recipient-unavailable` ⇒ 回 SOP §4 查应用可见范围;
出现 `provider-contract-error` ⇒ **这是 bug 信号,停止试点并上报**。

### C 步:扩到全部试点人员

**做什么**:同样的通知发给全部试点成员,完成留证 ⑦–⑩。

🔴 **仍然不扩大企业微信应用可见范围。** C 步扩的是「发给多少试点人」,不是「多少人能看见这个应用」。

✅ **判据**:留证 ⑦–⑩ 全部完成。

---

## 4. 十项留证(§15.3;逐条「怎么做 + 期望结果 + 不符怎么办」)

> **通用规则**:每项做完把「谁(用编号不用姓名)/ 什么时候 / 观察到什么」记在维护者线下的试点记录里。
> 🔴 记录里**不写**完整 `wecomUserId`、手机号、真实姓名 —— 需要指人时用 `Member.memberNo` 或试点编号。

---

### ① 首次短信绑定与重复免密登录

**怎么做**:

1. 一名**有手机号**的试点成员在企业微信工作台打开 SRVF → 拿到 `bindingRequired:true` + `bindingTicket`;
2. `POST /api/auth/v1/wecom-bind/send-code`(`{bindingTicket, phone}`)→ 收到短信;
3. `POST /api/auth/v1/wecom-bind`(`{bindingTicket, phone, smsCode}`)→ 拿到 `session`;
4. **退出后再进一次**同一入口。

**期望结果**:

- 第 3 步返回的 `session` 与密码登录**同形**(同一个 `LoginResponseDto`,双计时器语义一致);
- 第 4 步**不再要求短信**,直接 `bindingRequired:false` + `session` —— 这就是「免密登录」;
- 绑定落库:

```sql
SELECT status, "bindingSource", "boundAt"
FROM wecom_identities WHERE "userId" = '<试点 User.id>';
-- 期望:恰好 1 行,status='active',bindingSource='pre-auth'
```

**不符怎么办**:

- 第 2 步返回 200 但收不到短信 ⇒ ⚠️ **这不一定是故障**。`send-code` 对
  「手机号不存在 / 不是本人 / 账号停用或软删」**逐字段返回完全相同的 200 且不发短信**(防枚举)。
  先确认这个手机号确实是**该 User 自己**的 `User.phone`;
- 第 3 步返 `24010` ⇒ 号码或验证码问题(同样是归一码,不细分);
- 第 4 步仍要求短信 ⇒ 第一次绑定其实没落库,回上面的 SQL 查。

---

### ② 无手机号用户通过原账号登录后 self-bind

**怎么做**(用 §2.3 那个专用测试账号):

1. **先确认走不通短信路**:在工作台拿到 `bindingTicket` 后调 `wecom-bind/send-code`
   —— 期望**200 但收不到短信**(账号无手机号);
2. 改走兜底路径:用**用户名 + 密码**在原有登录入口登录,拿到会话;
3. `POST /api/auth/v1/step-up/password`,body 的 `action` 固定为 **`WECOM_BIND`** → 拿 `stepUpToken`;
4. `POST /api/auth/v1/wecom-bind/authorize`(**需登录**)→ 拿 `authorizeUrl` → 在企业微信客户端里跳转 → 回跳拿 `code` + `state`;
5. `PUT /api/app/v1/me/wecom`,body `{code, state, stepUpToken}` → 返 `AppMeWecomDto`。

**期望结果**:第 5 步成功,`GET /api/app/v1/me/wecom` 返回 `bound:true`(`wecomUserId` 只出掩码)。

**不符怎么办**:

- 第 1 步**居然收到了短信** ⇒ 这个账号有手机号,不是合格的第 6 类账号,回 §2.3;
- 第 3 步没有 `WECOM_BIND` 这个 action ⇒ 部署的版本没有 T3,回 SOP §1;
- 第 5 步返 `36002` ⇒ 该企业微信身份已绑在**别人**账号上(见留证 ⑥ 的清除路径);
- ⚠️ **本项的价值不在「能绑上」,而在「第 1 步那条路确实走不通,而这条路走得通」。**
  只做第 2–5 步不做第 1 步,就没有证明兜底路径是必要的。

---

### ③ User disable / enable

**怎么做**:

1. `PATCH /api/admin/v1/users/{id}/status` 把一名已绑定试点成员置为停用;
2. 该成员在企业微信工作台重新登录;
3. 恢复启用,再登录一次。

**期望结果**:

- 停用期间登录返 **`36010`**(与「code 无效」等六种原因**逐字段同形**);
- 停用**不撤销**企业微信绑定:

```sql
SELECT status FROM wecom_identities WHERE "userId" = '<该 User.id>';
-- 期望:仍是 active
```

- 恢复启用后能正常免密登录。

**不符怎么办**:

- 停用期间**还能登录** ⇒ 严重问题,立刻停止试点并上报;
- 停用后 identity 变成 `revoked` ⇒ 与冻结稿 §8 的生命周期矩阵不符,上报(disable 是**保留**身份的)。

---

### ④ Member offboard / 恢复

**怎么做**:

1. `POST /api/admin/v1/members/{id}/offboard` 让一名已绑定试点成员离队;
2. 该成员登录;
3. `PATCH /api/admin/v1/members/{id}/status` 恢复 + 确认 User 为启用状态,再登录。

**期望结果**:

- offboard **保留 identity 但登录失败**(冻结稿 §15.1 条 13 / §8);
- 恢复 + enable 之后可以登录;
- 全程 identity 行 `status='active'` 不变。

**不符怎么办**:offboard 后 identity 被撤销 ⇒ 与矩阵不符,上报。
**⚠️ 注意这一项与 ③ 的区别**:两者都「保留身份」,但触发的是不同链路(User 状态 vs Member 状态),
**必须分别做,不能只做一个** —— 它们在代码里是两条独立判据。

---

### ⑤ User soft-delete 与 member-account reopen 不继承旧身份

**怎么做**:

1. `DELETE /api/admin/v1/users/{id}` 软删一名已绑定试点成员的 User;
2. 查 identity;
3. `POST /api/admin/v1/members/{id}/account/reopen` 给同一 Member 开一个**新** User(需新手机号);
4. 新 User 在工作台登录。

**期望结果**:

- 第 2 步:**identity 已被撤销**(与 ③④ 相反):

```sql
SELECT status, "revokedAt" IS NOT NULL AS revoked
FROM wecom_identities WHERE "userId" = '<被软删的 User.id>';
-- 期望:status='revoked' 且 revoked=true
```

- 第 4 步:新 User **不继承**旧身份,走的是**首次绑定**流程(`bindingRequired:true`);
- 旧 identity 行**仍然在表里**(撤销不是删除)。

**不符怎么办**:

- 第 2 步 identity 仍 `active` ⇒ 软删没撤身份,**严重**:意味着被软删账号的企业微信号还能签会话,上报;
- 第 4 步新 User 直接免密进去了 ⇒ 身份被转移到了新 User,**严重**,上报。
  冻结稿 §8 明确:旧 User soft-delete 同事务撤销,**不自动转移**。

---

### ⑥ 管理员清除绑定及旧 proof 失效

**怎么做**:

1. 一名试点成员先完成一次 self-bind(留下一个 `WECOM_BIND` 的 step-up proof,**不要用掉**);
2. `DELETE /api/admin/v1/users/{id}/wecom` 清除该成员绑定;
3. 该成员用**第 1 步那个旧 proof** 再调一次 `PUT /api/app/v1/me/wecom`;
4. 再调一次第 2 步的清除接口(幂等性)。

**期望结果**:

- 第 2 步:200,identity 变 `revoked`,**该账号全部未过期 refresh token 被撤销**
  (旧 access 按 15 分钟自然到期);
- 第 3 步:**失败,返 `10008`**(step-up proof 无效 / 过期 / 身份状态已变)——
  `WECOM_BIND` 的 proof 里带着身份 fingerprint,身份被清后 proof 自动失效。
  🔴 **这一条是本项的核心**:如果旧 proof 还能用,「管理员清除」就形同虚设(清完立刻被绑回去)。
  ⚠️ proof 本身只有 5 分钟有效期,所以第 1→3 步要**连着做**,否则你测到的是「过期」不是「身份变更」
  —— 两者同码,分不出来。慢了就重来一遍;
- 第 4 步:**200(幂等)**,且**不写审计、不撤 refresh**(本来就没绑的对象不产生副作用)。

**不符怎么办**:第 3 步**成功了** ⇒ 严重安全问题,立刻停止试点并上报。

> ⚠️ **这是解除绑定的唯一路径**:App 侧**没有** `DELETE me/wecom`,用户不能自助裸解绑。
> 也**不能**用它做「转移绑定」—— 接口没有目标用户入参;换人只能「先清除,再让对方自己走一遍绑定」。

---

### ⑦ 已绑定且有资格者收到消息

**怎么做**:发一条勾了 `wecom` 的通知,受众包含若干已绑定试点成员。

**期望结果 —— 必须两条都有**:

1. **终端事实**:该成员在企业微信里**真的看到了卡片**(截图或口头确认皆可,但必须是人看到的);
2. **系统记账**:

```sql
SELECT status, "reasonCode", count(*)
FROM notification_deliveries
WHERE channel = 'wecom' AND "notificationId" = '<通知 id>'
GROUP BY 1, 2 ORDER BY 1, 2;
-- 该成员应落在 status='sent'
```

🔴 **只有第 2 条不算过。** `sent` 的语义是「企业微信接口接受了,且没报告该收件人无效」——
它**不等于已送达,更不等于已读**。用 `sent` 的条数当作「收到了几个人」,正是 §0 说的那类冒充。

**不符怎么办**:

- 记了 `sent` 但人没收到 ⇒ 记下来,这是**已知的语义边界**不是 bug,但要在扩大决定里如实反映;
- 记了 `skipped` ⇒ 看 `reasonCode`,对照 rollout §5 的处置表。

---

### ⑧ 未绑定者不收 WeCom,但站内信仍可见

**怎么做**:同一条通知的受众里**包含一名未绑定**企业微信的成员(§2.3 的测试账号在做完留证 ② 之前正合适;
做完之后可以用 `admin clear` 造一个)。

**期望结果 —— 必须两条都有**:

1. 该成员**没有**收到企业微信卡片,且投递记录里是 `skipped` / `no-wecom-identity`(或**根本没有** `wecom` 行);
2. 🔴 **该成员在 App 站内信里能正常读到这条通知**。

```sql
-- 反向断言:未绑定成员不应有 wecom 的 sent 行
SELECT count(*) FROM notification_deliveries
WHERE channel = 'wecom' AND "notificationId" = '<通知 id>' AND status = 'sent';
-- 与 ⑦ 中确认收到的人数一致,不应把未绑定者算进去
```

**不符怎么办**:

- 第 2 条不成立(站内信也看不到)⇒ **严重**:企业微信通道**污染**了既有站内信行为。
  这与冻结稿 §14.3 第 1 条「新 channel 不改变现有 in-app 行为」直接冲突,立刻停止并上报;
- 未绑定者**收到了**企业微信 ⇒ 不可能发生(没有 identity 就没有 `touser`),真发生了就是严重 bug。

> ①-② 的差 = **没绑企业微信的人**。这不是故障,是覆盖率的真实上限;
> 想缩小它只能靠推动绑定,**不能**改用部门 / 标签群发(见留证 ⑩ 的最后一条)。

---

### ⑨ Provider 前撤权、离队或解绑阻止发送

**怎么做**(三个子场景,**至少做一个,建议三个都做**):

在通知已 publish、child intent 已建、但 Provider 还没发出去的窗口内,改变收件人资格:

| 子场景 | 怎么造 |
|---|---|
| 撤权 | 摘掉该成员的角色绑定 / 让其失去这条通知的可见档 |
| 离队 | `POST /api/admin/v1/members/{id}/offboard` |
| 解绑 | `DELETE /api/admin/v1/users/{id}/wecom` |

> ⏱ 这个窗口很短(worker 一轮就领走了)。实操上最容易造的是:
> **先把该成员的资格改掉,再 publish** —— 这测的是同一道最终闸,只是时序更好控制。
> 若要精确测「root 之后、child 之前」的窗口,那属于代码级测试(T5B 已有 e2e 覆盖),
> 生产试点**不必**也**不该**去构造。

**期望结果**:该成员落 `skipped`,`reasonCode` 为 `no-wecom-identity`(解绑)或因资格失效不进入受众;
**不得**出现 `sent`。

**不符怎么办**:出现 `sent` ⇒ 最终闸没拦住,**严重**,立刻停止并上报。

---

### ⑩ `messageEnabled` 关闭、Worker 排空和回滚无迟到补发

**怎么做**:

1. 在有 wecom 通知在途时 `PATCH {"messageEnabled": false}`;
2. 按 [`wecom-message-channel-rollout.md`](wecom-message-channel-rollout.md) §7 排空;
3. 确认 `pending`/`processing` 归零;
4. **等一段时间(建议 ≥30 分钟),再重新 `messageEnabled=true`**;
5. 观察有没有「补发」。

**期望结果**:

- 关闭后在途的 intent 落 **terminal `skipped` / `channel-disabled`**;
- 🔴 **第 4 步重新打开之后,那些 `skipped` 的通知不会被补发** —— 这是刻意的行为
  (冻结稿 §10.7 末条:通道关闭时**不允许**「等恢复后迟到补发」);
- 排空判据:

```sql
SELECT count(*) FROM notification_outbox_intents
WHERE "eventType" LIKE 'notification.wecom-%' AND status IN ('pending', 'processing');
-- 必须为 0
```

**不符怎么办**:

- 第 4 步之后**收到了**关闭期间的通知 ⇒ 迟到补发,与冻结稿冲突,上报;
- 排空计数长期不归零 ⇒ 见 rollout §7 与
  [`wecom-failure-injection-drills.md`](wecom-failure-injection-drills.md) 的 Worker crash 一节。

🔴 **顺便验一条否定事实**:全程**不使用**企业微信部门、标签或群聊作为业务消息的绕过路径。
这一条在代码层已经不可能违反(请求体只有 `touser`),但**运维侧仍要确认没有人在企业微信后台
用群发助手/群机器人手工推送同样的内容** —— 那会绕过 SRVF 的全部受众判定,
而且不会在 `notification_deliveries` 里留下任何痕迹。

---

## 5. 十项留证汇总表

| # | 留证项 | 完成 | 日期 | 备注(问题编号 / 处置) |
|---|---|---|---|---|
| ① | 首次短信绑定与重复免密登录 | ☐ | | |
| ② | 无手机号用户原账号登录后 self-bind | ☐ | | |
| ③ | User disable / enable | ☐ | | |
| ④ | Member offboard / 恢复 | ☐ | | |
| ⑤ | soft-delete 与 reopen 不继承旧身份 | ☐ | | |
| ⑥ | 管理员清除绑定及旧 proof 失效 | ☐ | | |
| ⑦ | 已绑定且有资格者收到消息(终端 + 记账双断言) | ☐ | | |
| ⑧ | 未绑定者不收 WeCom 但站内信仍可见(双断言) | ☐ | | |
| ⑨ | Provider 前撤权 / 离队 / 解绑阻止发送 | ☐ | | |
| ⑩ | 关闭 / 排空 / 回滚无迟到补发 | ☐ | | |

**另需完成**(§15.2 条 8,详见 [`wecom-failure-injection-drills.md`](wecom-failure-injection-drills.md)):

| | 项 | 完成 |
|---|---|---|
| A | Provider 故障注入 | ☐ |
| B | token 失效注入 | ☐ |
| C | DB 故障注入 | ☐ |
| D | Worker crash 注入 | ☐ |

---

## 6. 扩大条件与签署

### 6.1 四条扩大条件(§15.3;必须同时满足)

- [ ] **全部场景通过** —— §5 的十项 + 四类注入全部 ☑;
- [ ] **无未关闭的 P0 问题**;
- [ ] **P1 风险有明确处置**(写下来是什么风险、怎么处置、谁负责,不是「知道了」);
- [ ] **维护者签署「扩大企业微信应用可见范围」**。

### 6.2 🔴 不能拿来代替验收的东西

冻结稿 §15.3 末句原文点名了两条,这里补齐同类:

| 说法 | 为什么不算数 |
|---|---|
| 「接口能通」 | 只证明 HTTP 200,不证明受众判定对 |
| 「试用了几天没报错」 | 试点期最危险的三类故障都不报错 |
| 「Delivery 表里 sent 有 N 条」 | `sent` ≠ 送达 ≠ 已读(留证 ⑦) |
| 「没人来投诉」 | 没收到消息的人不知道自己该收到 |
| 「测试环境全绿」 | 可信 IP、可信域名、接口许可、应用可见范围**全都只在生产存在** |

### 6.3 签署位

> 我确认:§5 十项留证与四类注入全部完成;无未关闭 P0;P1 风险已逐条记录处置;
> 同意将企业微信应用可见范围从试点名单扩大到 ____________。

维护者签署:______________  日期:____________

扩大后的范围:______________  扩大后人数:__________

### 6.4 扩大之后立刻要做的一件事

回 [`wecom-backend-configuration-sop.md`](wecom-backend-configuration-sop.md) §10.2 重跑一次 `test-connection`,
确认 `visibilitySummary.directUsers` 等于新范围人数,且 **`parties` / `tags` 仍是 0**
—— 扩大范围时最容易顺手加一个部门进去,那会让「谁在范围内」从此不再由名单决定。

---

## 7. 相关文档

- 冻结稿 §15.3:[`wecom-integration-t0-terminal-review.md`](../archive/reviews/wecom-integration-t0-terminal-review.md)
- 后台配置与身份链启用:[`wecom-backend-configuration-sop.md`](wecom-backend-configuration-sop.md)
- 消息链上线与回滚:[`wecom-message-channel-rollout.md`](wecom-message-channel-rollout.md)
- 失败注入剧本:[`wecom-failure-injection-drills.md`](wecom-failure-injection-drills.md)
