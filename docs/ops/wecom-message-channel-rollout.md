# 企业微信应用消息通道上线 runbook(T5B 交付 · T6 收口)

> **谁在什么时候读它**:维护者,在身份链试点已经跑通(见
> [`wecom-backend-configuration-sop.md`](wecom-backend-configuration-sop.md) §14 十五条全绿)、
> 准备把 `messageEnabled` 打开的那一刻;以及此后每次需要观察指标、人工 replay 或回滚消息链时。
> **读完要能做成什么**:按不可颠倒的顺序把消息通道打开、读懂五个运营指标各自的含义、
> 在出事时按 §7 干净地排空并回滚。
>
> **状态:生产未部署,`messageEnabled` 未开启。**
> 需求真相源:[`wecom-integration-t0-terminal-review.md`](../archive/reviews/wecom-integration-t0-terminal-review.md)
> §10.4 / §10.7 / §10.8 / **§15.2 / §15.4** + D-WC-24 / D-WC-27。
> **分工**:企业微信后台配置与身份链启用归 [`wecom-backend-configuration-sop.md`](wecom-backend-configuration-sop.md);
> 试点名单与十项留证归 [`wecom-pilot-playbook.md`](wecom-pilot-playbook.md);
> 四类失败注入归 [`wecom-failure-injection-drills.md`](wecom-failure-injection-drills.md)。本文不重复它们。

---

## 0. 一句话

企业微信消息通道出厂 `enabled=false && messageEnabled=false`,**合入代码不等于开始发消息**。
打开它需要三步:①确认 fleet 只剩新版本 → ②开总闸做 smoke → ③开二级闸并盯运营五指标。
任何一步不确定,就停在上一步 —— 通道关着的代价是"没发消息",打开错了的代价是"发错人"。

> 📋 **要签 GO 的人直接翻 [§9 消息链 GO 检查单](#9-152-消息链-go-检查单十二条)** ——
> 那是冻结稿 §15.2 十二条的逐条勾选版,每一条都指回本文对应小节,**不重复内容**。

---

## 1. 前置硬门(全部满足才进入第 2 节)

| # | 条件 | 怎么验 |
|---|---|---|
| 1 | 第 69 migration 已在生产 deploy | `SELECT indexname FROM pg_indexes WHERE indexname='notification_outbox_wecom_delivery_active_unique';` 返回 1 行 |
| 2 | **所有**旧 worker 已退出 | 见 §2,这是本次最大的风险点 |
| 3 | 新 API 与新 worker 使用**同一审核 digest** | 部署记录比对 image digest,不看 tag |
| 4 | `wecom_settings` 已由维护者填 CorpID / AgentId / CorpSecret / webBaseUrl | `credentialStatus=configured`;走 `POST /system/v1/wecom-settings/test-connection` 验 |
| 5 | `webBaseUrl` 是 **https origin**(无 path/query) | 同上端点的 `redirectDomainConfigured=true`;深链拼装还会再判一次 |
| 6 | 应用可见范围只含已确认的试点成员 | 企业微信后台;见 SOP §4(`parties=0` / `tags=0`) |
| 7 | **身份链已 GO 且试点已跑通 A 步** | [SOP §14](wecom-backend-configuration-sop.md) 十五条全绿 + [playbook](wecom-pilot-playbook.md) 留证 ①–⑥ 全完成 |
| 8 | 当前 Notification Outbox 生产基线已部署并通过现有 runbook | 既有 outbox 在生产已稳定跑过一个周期(站内信 / 微信 / 短信三条渠道正常) |

> ⚠️ 第 4/6/7 条的操作步骤在 [`wecom-backend-configuration-sop.md`](wecom-backend-configuration-sop.md)
> 与 [`wecom-pilot-playbook.md`](wecom-pilot-playbook.md),列在这里只是提醒"没有它们通道也开不了",
> 本 runbook 不复制那两份的步骤。
>
> ⚠️ 第 7 条是**顺序约束不是建议**:身份链没跑通就开消息链,等于同时放两个变量出去 ——
> 有人没收到消息时,你分不清是"他没绑定"还是"消息链有问题"。

---

## 2. 混版本风险(§10.8)—— 本次上线**唯一**的不可逆坑

**旧 worker 不认识 `notification.wecom-broadcast` / `notification.wecom-delivery`。**
它会走 `assertStoredNotificationOutboxIntentSafe` 的 unknown-event 分支,把 intent 判成
**unsupported terminal dead**。dead 是终态:那条通知对那个人**永远不会再发**,而且现场看起来
"worker 正常工作、intent 有终态、没有报错堆栈"。

因此顺序**不可颠倒**:

1. 停掉全部旧 worker 进程,确认进程数归零(不是"滚动更新中",是**零**)。
2. 部署新 API + 新 worker(同 digest)。
3. **此时 `messageEnabled` 仍为 false** —— 完成 smoke(§3)。
4. 确认 fleet 只剩新版本后,再开 `messageEnabled`(§4)。

排空判据(SQL,任一非零就不要往下走):

```sql
-- 还在跑的 wecom intent(理论上此刻应为 0,因为通道还没开过)
SELECT count(*) FROM notification_outbox_intents
WHERE "eventType" LIKE 'notification.wecom-%'
  AND status IN ('pending','processing');

-- 被旧 worker 误杀的证据:dead 且错误类是 unsupported
SELECT count(*) FROM notification_outbox_intents
WHERE "eventType" LIKE 'notification.wecom-%'
  AND status = 'dead'
  AND "lastErrorClass" = 'UnsupportedNotificationOutboxEventError';
```

第二条查询若非零 ⇒ **混版本已经发生过**。停下来上报;这些 intent 不能靠重启恢复,
需要人工决定是否以新 generation 重新 publish(见 §6)。

---

## 3. Smoke(`messageEnabled` 仍为 false)

目的:证明"新代码跑起来了"且"通道确实关着"。

1. 发一条勾了 wecom 的通知并 publish。
2. 断言 **零** wecom intent:

```sql
SELECT count(*) FROM notification_outbox_intents WHERE "eventType" LIKE 'notification.wecom-%';
-- 期望 0
```

3. 断言站内信照常可见(通道关闭**不影响**任何既有渠道)。

这一步的意义:第一层闸(publish 时判开关)是在生产上被验证过的,而不是只在测试里。

---

## 4. 开启(维护者执行)

`PATCH /api/system/v1/wecom-settings`,先 `enabled=true`,观察一轮后再 `messageEnabled=true`。
**两个开关分两次开** —— 一次开完就分不清"通道通了"和"消息发出去了"分别是哪一步生效的。

开启后发第一条试点通知,并按 §5 读五指标。

---

## 5. 运营五指标(§10.4 末条:**不得混为同一指标**)

| # | 指标 | 从哪读 |
|---|---|---|
| ① | SRVF 可见受众数 | root intent 执行结果 `visibleAudience`(worker 日志 / drain 返回值) |
| ② | active identity 候选数 | 同上 `identityCandidates`;也等于本次新建的 child intent 数 |
| ③ | SENT 数 | `notification_deliveries` 中 `channel='wecom' AND status='sent'` |
| ④ | recipient-unavailable 数 | 同表 `status='skipped' AND "reasonCode"='recipient-unavailable'` |
| ⑤ | recipient-unlicensed 数 | 同表 `status='skipped' AND "reasonCode"='recipient-unlicensed'` |

```sql
SELECT status, "reasonCode", count(*)
FROM notification_deliveries
WHERE channel = 'wecom' AND "notificationId" = :id
GROUP BY 1, 2 ORDER BY 1, 2;
```

**怎么读**:

- ①-② 的差 = **没绑企业微信的人**。这不是故障,是覆盖率的真实上限;
  想缩小它只能靠推动绑定,**不能**改用 `toparty/totag` 群发(§10.4 明令禁止,且会绕过 SRVF 受众判断)。
- ④ = 企业微信认为这个 userid 无效**或**不在应用可见范围。官方**无法可靠区分**这两者,
  第一版不伪造更细原因。排查方向:后台可见范围、userid 是否仍在职。
- ⑤ = 该成员没有基础接口许可。**这是采购决策,不是系统故障**;站内信继续可用。
  系统内不做采购、不做激活、不自动重试。
- ②-③-④-⑤ 若对不上,差额在 `channel-disabled` / `no-wecom-identity` / `token-failed` /
  `provider-contract-error` 里 —— 那四类是**配置或链路故障**,不属于覆盖率,别混进 ④⑤。

其余 reasonCode 的含义:

| reasonCode | 含义 | 处置 |
|---|---|---|
| `no-wecom-identity` | 建 child 之后身份被撤销/换绑 | 正常,无需处理 |
| `channel-disabled` | 投递前开关被关 / webBaseUrl 不可用 | 检查是不是误关;**不会**等开关恢复后补发 |
| `token-failed` | 取 token 失败或通道不可用 | 暂态,自动退避重试;持续出现查凭证与出口 IP |
| `rate-limited` | 45009 | **intent 已 dead**,等官方拦截窗口结束后人工 replay(§6) |
| `provider-contract-error` | 单 touser 却收到 invalidparty/invalidtag | **intent 已 dead**,这是 bug 信号,上报 |
| `api-failed` | 其余上游失败 | 看 `errCode` 列 |

---

## 6. 人工 replay(仅 `rate-limited` / `provider-contract-error`)

这两类 intent 是 **dead** 终态,**不会**自动重试。replay 的正确做法**不是**手改 intent 状态,
而是:确认官方拦截窗口已结束 → 对该通知执行 unpublish + publish(产生新 generation)→
新 root 会为**尚未 SENT** 的人重新建 child。

已 SENT 的人不会被重复打扰:`NotificationDelivery` 的 SENT 是**跨 generation 的永久去重事实**。

---

## 7. 关闭与回滚(D-WC-24 / §15.4)

回滚**不删表、不删历史、不移动身份**,只关开关。**顺序不可颠倒**:

```text
messageEnabled=false
  → 停止创建新 WeCom intent
  → 新 Worker 排空 / 终结现有 WeCom intent
  → 确认 pending/processing = 0
  → 再回滚 API/Worker 二进制
```

### 7.1 第一步:关二级闸

```bash
curl -X PATCH https://<API_HOST>/api/system/v1/wecom-settings -H "Authorization: Bearer <SA_TOKEN>" -H "Content-Type: application/json" -d '{"messageEnabled":false}'
```

`enabled` 与 `loginEnabled` **可以保留** —— 消息链回滚不影响身份链(要连身份链一起关见 SOP §13)。

✅ **判据**:`GET wecom-settings` ⇒ `messageEnabled:false`。此后 publish **不再创建**新的 wecom root intent。

### 7.2 第二步:用**新** worker 排空

🔴 **绝不允许旧 worker 接触新事件**(§10.8)。排空必须由认识 `notification.wecom-*` 的新版本 worker 做;
让旧 worker 去"清理"会把它们判成 **unsupported terminal dead** —— 那是终态,
**那些通知对那些人永远不会再发**,而且现场看起来一切正常。

排空就是让新 worker 正常跑完在途 intent。**不要**手改状态、**不要**为了清空队列删记录
(§15.4 明令禁止「为清空队列物理删除未审计数据」)。

### 7.3 第三步:确认 pending / processing = 0

```sql
-- 主判据:没有在途的 wecom intent
SELECT count(*) FROM notification_outbox_intents
WHERE "eventType" LIKE 'notification.wecom-%' AND status IN ('pending', 'processing');
-- 必须为 0 才能回滚
```

```sql
-- 辅助判据:看清楚剩下的是什么终态,顺便确认没有 unsupported dead(混版本证据)
SELECT status, "lastErrorClass", count(*)
FROM notification_outbox_intents
WHERE "eventType" LIKE 'notification.wecom-%'
GROUP BY 1, 2 ORDER BY 1, 2;
-- 期望:只有 succeeded / dead / failed 之类终态;
--       lastErrorClass = 'UnsupportedNotificationOutboxEventError' 必须为 0 行
```

```sql
-- 关闭之后新产生的应当是 terminal skipped/channel-disabled,不是"等着补发"
SELECT status, "reasonCode", count(*)
FROM notification_deliveries
WHERE channel = 'wecom' AND "createdAt" > '<关闭时刻>'
GROUP BY 1, 2 ORDER BY 1, 2;
-- 期望:出现 skipped / channel-disabled;不应出现 pending
```

**主判据长期不归零怎么办**:

| 现象 | 指向 | 处置 |
|---|---|---|
| 有行卡在 `processing`,`leaseExpiresAt` 在过去 | worker 挂了或 lease 没回收 | 确认新 worker 进程还活着;等一个 lease 周期后重查 |
| 有行卡在 `pending`,`availableAt` 在未来 | 正常退避中 | 等到 `availableAt` 之后再查;别急着回滚 |
| 有行卡在 `pending`,`availableAt` 在过去但没人领 | 没有 worker 在跑 | 起一个**新版本** worker(🔴 不是旧的) |

### 7.4 第四步:回滚二进制

主判据为 0 之后才回滚 API / Worker。

⚠️ **第 69 migration(partial unique index)保留不删**。它是 additive 的,留着无副作用;
真要回滚是 `DROP INDEX "notification_outbox_wecom_delivery_active_unique";`,
但那会失去"同人同时只一条 active"的保证 —— 除非重新部署否则不要动。

### 7.5 排空演练(§15.2 条 9 要求「rollback 前排空策略已演练」)

**回滚不是等出事那天才第一次做。** 在试点期内演练一次,演练即 playbook 留证 ⑩:

1. 造几条在途的 wecom intent(发一条受众较多的测试通知);
2. **立刻** `messageEnabled=false`;
3. 按 §7.2 → §7.3 走一遍,记录**从关闸到主判据归零花了多久**(这个数字就是将来真回滚时的预算);
4. 等 ≥30 分钟后重新 `messageEnabled=true`;
5. 🔴 **确认没有迟到补发** —— 关闭期间落 `skipped/channel-disabled` 的那些人**不会**在重开后收到。
   这是刻意行为(§10.7 末条),不是缺陷。

### 7.6 🔴 回滚时明令禁止的四件事(§15.4)

- ❌ 删表、删 identity 历史、移动 tag;
- ❌ 让旧 Worker 处理新 eventType;
- ❌ 把失败 intent 直接改成 `SENT`;
- ❌ 为清空队列物理删除未审计数据。

---

## 8. 明确不承诺的事

- **不承诺 exactly-once**。企业微信侧的 1800 秒重复检查只是第二层保险;
  Provider 已接受但本地 ack 之前崩溃的窗口依然存在,同一条卡片可能重复推送。
  卡片始终指向同一条 notification,重复点击幂等 —— 这是我们能给的保证。
- **SENT ≠ 已读**,也 ≠ 已送达。它只表示"接口接受了且没报告该收件人无效"。
- **不预测接口许可**。没有任何接口能提前精确判断每个成员的基础接口许可,
  覆盖率只能由逐人回执事后裁决。

---

## 9. §15.2 消息链 GO 检查单(十二条)

> 冻结稿 §15.2 的开头一句是**前置条件而不是第 0 条**:「**除身份链条件外**,还必须……」
> —— 所以先有一行"门",再有十二条。**十二条 + 那道门 = 全部**。
> 每一条只写「怎么验」并指回本文对应小节,**不重复内容**(细节都在上面 §1–§8)。

**门**:[`wecom-backend-configuration-sop.md`](wecom-backend-configuration-sop.md) §14
的**十五条身份链 GO 全部勾上**。→ ☐

| # | §15.2 条件 | 怎么验 / 去哪做 | ☐ |
|---|---|---|---|
| 1 | 当前 Notification Outbox 生产基线已部署并通过现有 runbook | §1 第 8 行 | ☐ |
| 2 | 旧 API / Worker 全部退出 | §2(**本次上线唯一的不可逆坑**);进程数**归零**,不是"滚动更新中" | ☐ |
| 3 | API 与 Worker digest 一致 | §1 第 3 行(比对 image digest,**不看 tag**) | ☐ |
| 4 | WeCom handler、strict parser、active-slot migration 均存在 | §1 第 1 行的索引 SQL(第 69 migration);handler/parser 随同 digest 一起到位 | ☐ |
| 5 | `messageEnabled=false` 状态下完成 no-effect smoke | §3(断言**零** wecom intent + 站内信照常) | ☐ |
| 6 | 单人定向消息试发成功,Delivery 与企业微信终端一致;`unlicenseduser` 正确降级为 `recipient-unlicensed` 而非 SENT | [playbook](wecom-pilot-playbook.md) B 步 + 留证 ⑦(**终端事实 + 系统记账双断言**) | ☐ |
| 7 | 撤权、离队、解绑的 Provider 前最终闸演练成功 | [playbook](wecom-pilot-playbook.md) 留证 ⑨ | ☐ |
| 8 | Provider 故障、token 失效、DB 故障、Worker crash 注入完成 | [`wecom-failure-injection-drills.md`](wecom-failure-injection-drills.md) §7 登记表;⚠️ **生产只能安全做 Worker crash 一类**,其余三类在非生产完成 + 记录替代证据(该文 §6) | ☐ |
| 9 | rollback 前排空策略已演练 | §7.5(并记下"关闸到归零"的实测耗时) | ☐ |
| 10 | 监控可区分 `sent` / `recipient-unavailable` / `recipient-unlicensed` / `rate-limited` / `failed` / `dead`,但不记录敏感目标 | §5 的分组 SQL 能把六类分开;且 `recipientRef` 只出掩码、payload/日志无 `wecomUserId` | ☐ |
| 11 | 同一 SRVF 可见通知下:已绑定试点成员收到 WeCom,未绑定成员不收 WeCom 但仍可读站内信 | [playbook](wecom-pilot-playbook.md) 留证 ⑦ + ⑧(**两条都要**,只有一条不算过) | ☐ |
| 12 | 未使用企业微信部门、标签或群聊作为业务消息绕过路径 | 代码层已不可能(请求体只有 `touser`);**运维侧另需确认没有人在企业微信后台用群发助手 / 群机器人手工推同样内容** —— 那会绕过全部受众判定且不留痕([playbook](wecom-pilot-playbook.md) 留证 ⑩ 末条) | ☐ |

签署(维护者):______________  日期:____________

> 🔴 与 §15.3 同一条纪律:**不能以「接口能通」或「试用了几天没报错」代替上述验收。**

---

## 10. 相关文档

- 冻结稿 §10 / §15.2 / §15.4:[`wecom-integration-t0-terminal-review.md`](../archive/reviews/wecom-integration-t0-terminal-review.md)
- 后台配置与身份链启用 / 回滚:[`wecom-backend-configuration-sop.md`](wecom-backend-configuration-sop.md)
- 试点执行与十项留证:[`wecom-pilot-playbook.md`](wecom-pilot-playbook.md)
- 失败注入剧本:[`wecom-failure-injection-drills.md`](wecom-failure-injection-drills.md)
- 通道配置与凭证:[`src/modules/wecom/CLAUDE.md`](../../src/modules/wecom/CLAUDE.md)
- Outbox 不变量:[`src/modules/notifications/CLAUDE.md`](../../src/modules/notifications/CLAUDE.md)
