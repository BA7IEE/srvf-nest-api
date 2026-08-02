# 企业微信应用消息通道上线 runbook(草案 · T5B)

> **状态:草案。生产未部署,`messageEnabled` 未开启。**
> 需求真相源:[`wecom-integration-t0-terminal-review.md`](../archive/reviews/wecom-integration-t0-terminal-review.md)
> §10.4 / §10.7 / §10.8 + D-WC-24 / D-WC-27。真机联调、后台配置、试点名单归 **T6**,不在本文范围。
> 本文只回答一件事:**代码已经合入之后,怎么把这条通道安全地打开、观察和关掉。**

---

## 0. 一句话

企业微信消息通道出厂 `enabled=false && messageEnabled=false`,**合入代码不等于开始发消息**。
打开它需要三步:①确认 fleet 只剩新版本 → ②开总闸做 smoke → ③开二级闸并盯运营五指标。
任何一步不确定,就停在上一步 —— 通道关着的代价是"没发消息",打开错了的代价是"发错人"。

---

## 1. 前置硬门(全部满足才进入第 2 节)

| # | 条件 | 怎么验 |
|---|---|---|
| 1 | 第 69 migration 已在生产 deploy | `SELECT indexname FROM pg_indexes WHERE indexname='notification_outbox_wecom_delivery_active_unique';` 返回 1 行 |
| 2 | **所有**旧 worker 已退出 | 见 §2,这是本次最大的风险点 |
| 3 | 新 API 与新 worker 使用**同一审核 digest** | 部署记录比对 image digest,不看 tag |
| 4 | `wecom_settings` 已由维护者填 CorpID / AgentId / CorpSecret / webBaseUrl | `credentialStatus=configured`;走 `POST /system/v1/wecom-settings/test-connection` 验 |
| 5 | `webBaseUrl` 是 **https origin**(无 path/query) | 同上端点的 `redirectDomainConfigured=true`;深链拼装还会再判一次 |
| 6 | 应用可见范围只含已确认的试点成员 | 企业微信后台;T6 范围 |

> ⚠️ 第 4/6 条属于 T6 的后台配置工作,列在这里只是提醒"没有它们通道也开不了",
> 本 runbook 不复制 T6 的操作步骤。

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

## 7. 关闭与回滚(D-WC-24)

回滚**不删表、不删历史、不移动身份**,只关开关:

1. 先 `messageEnabled=false`(停止产生新 intent)。
2. 用**新** worker 排空或终结所有 WeCom intent —— **绝不允许旧 worker 接触新事件**(§10.8)。
3. 确认无 active 后再回滚二进制:

```sql
SELECT count(*) FROM notification_outbox_intents
WHERE "eventType" LIKE 'notification.wecom-%' AND status IN ('pending','processing');
-- 必须为 0 才能回滚
```

4. 第 69 migration(partial unique index)**保留不删**。它是 additive 的,留着无副作用;
   真要回滚是 `DROP INDEX "notification_outbox_wecom_delivery_active_unique";`,
   但那会失去"同人同时只一条 active"的保证,除非重新部署否则不要动。

---

## 8. 明确不承诺的事

- **不承诺 exactly-once**。企业微信侧的 1800 秒重复检查只是第二层保险;
  Provider 已接受但本地 ack 之前崩溃的窗口依然存在,同一条卡片可能重复推送。
  卡片始终指向同一条 notification,重复点击幂等 —— 这是我们能给的保证。
- **SENT ≠ 已读**,也 ≠ 已送达。它只表示"接口接受了且没报告该收件人无效"。
- **不预测接口许可**。没有任何接口能提前精确判断每个成员的基础接口许可,
  覆盖率只能由逐人回执事后裁决。

---

## 9. 相关文档

- 冻结稿 §10:[`wecom-integration-t0-terminal-review.md`](../archive/reviews/wecom-integration-t0-terminal-review.md)
- 通道配置与凭证:`src/modules/wecom/CLAUDE.md`
- Outbox 不变量:`src/modules/notifications/CLAUDE.md`
