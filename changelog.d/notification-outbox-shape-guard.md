### 修复

- 🔴 **通知 outbox envelope 闸不再随机误判合法通知**(P2-9,由 CI flake 反查出)。
  `notification-outbox.types.ts` 里同一条为**键名黑名单**设计的正则被拿去测 `eventKey` /
  `aggregateType` / `aggregateId` / `destinationType` / `destinationRef` 五个字段的**值** ——
  而其中三个装的是 cuid 这类不透明 id。⇒ id 文本里恰好出现 `token` / `phone` 等子串时,
  完全合法的通知被硬抛 `NotificationOutboxInvariantError: … contains forbidden sensitive material`。
  **实测 200 万条 cuid 形状 id 命中 1 条**(seed=20260822,命中样本 `c8ob12qafrq354c5ptvjtoken`);
  每条 intent 查 5 个字段,实际更高。因为非确定性 + 错误消息对着随机 id 谁也看不懂,
  现场只会被当成 flake 重跑掉,而不是当成 bug。

  修法**不是删掉那半个条件** —— 它拦的是「值的**形状**像在传敏感物料」(`token:abc123`),
  与 `containsSensitiveValue`(值**本身**是敏感物料)不重合,两条都要。改成值侧另立
  `FORBIDDEN_PAYLOAD_SHAPE`:只把**字母数字**当词内字符,`_` / `-` / `.` / `:` / `=` 一律算分隔符。
  同一份样本改后误判 **0**,而 `token:abc123` / `phone=13900001111` / `openid_wx123` /
  `provider-response body` / `signed-url=https://x` / `TOKEN` / `x.token.y` 逐条仍被拦。

  ⚠️ **NEXT_TASKS 当时建议的 `\b(...)\b` 方案是错的**(本次实测推翻):`_` 是 word 字符,
  `\bopenid\b` 匹配不上 `openid_wx123` —— 误判是归零了,防御同时被削弱。

  ⚠️ **键名侧刻意保持裸子串不动**:键名恒是 camelCase / snake_case 短标识符,
  `accessToken` / `userPhone` / `phoneNumber` 的词首前挨着字母,套上值侧那套边界会把它们
  整片放过去(实测)。所以是**另立常量**,不是给现有常量加边界。

  ⚠️ 该处此前**零测试覆盖**。补 `notification-outbox.metadata-guard.spec.ts`(38 条,id 全写字面量);
  键名侧谓词为此导出成 `isForbiddenNotificationOutboxPayloadKey` —— `walkPayload` 的键名分支跑在
  `exactKeys` 之后,从公开入口黑盒测「塞了 accessToken ⇒ 红」测到的是 `exactKeys`,
  把这条谓词整个删掉那种测试照样全绿。
