### Fixed

- **企业微信消息链 —— 外部评审 F2 四条 BLOCKER + 两条 SHOULD-FIX**(P1-27 第二刀,零 schema)。
  评审的批次级根因是"多个局部状态机各自严谨,彼此却缺少同一代际",故按状态机接口而非局部补丁修:
  - **锁序统一(B4)**:Provider 前最终闸把 `wecom_settings`(FOR SHARE)提到 `User` 之前,
    共同实体相对锁序全仓统一为 `settings → User → identity`,与绑定 / 换绑路径逐字一致。
    上一版把 settings 追加在尾部时**漏枚举了绑定路径**(它持 settings 共享锁的同时取 User 排他锁)。
    锁与判据分离:资格失效仍然赢过 channel-disabled,退队 / 停用者不会平白多一条 delivery 行。
  - **同代配置(B5)**:新增 `WecomService.resolveMessageContext()`,一次返回
    `provider + corpId + configurationGeneration + webBaseUrl`;最终闸锁后校验 corpId 与 generation
    仍与之一致,identity 查询用同一个 corpId,提交后只用此前那个 Provider。
    `deliverWecom` **不再**调 `resolveRoute()` —— 此前它会在闸后重读配置,
    换 CorpID 的窗口里能把 A 企业的 `wecomUserId` 发去 B 企业。
  - **fence 与重试归属(B6)**:`beforeEffect` 下沉到 `request()` 内**每次 fetch 紧前**
    (此前传输层重试的第 2、3 次完全没有 fence);`message/send` 的物理尝试预算收为 1,
    退避归 Outbox 一家(此前 Provider 3 次 × token 强刷 2 轮 × Outbox 8 次 = 最多 48 次物理发送);
    `forceRefresh` 只绕缓存 token,**不再**绕过在途 `refreshPromise`(此前并发 token 失效会各起一次 gettoken)。
  - **类型化错误(B7)**:Provider 抛出与返回的每个失败都带 `kind` 闭集
    (rate-limited / config-fatal / http-4xx / http-5xx / network / timeout / invalid-response /
    token-invalid / channel-disabled / system-busy / upstream-rejected / provider-contract),
    Outbox 只认 `kind`。退避集收窄为 network / timeout / http-5xx / system-busy / token-invalid;
    **gettoken 阶段的 45009 与 HTTP 4xx 现为终态**,不再被压成 `TOKEN_FAILED` 白退避 8 次。
  - **严格回执解析(SF1)**:`invaliduser` / `unlicenseduser` / `invalidparty` / `invalidtag`
    四个名单字段三分 —— 缺席或空串 = 空名单,字符串 = 解析,**其它类型一律 `INVALID_RESPONSE`**。
    此前 `{errcode:0, invaliduser:123}` 会被读成"没有无效收件人"并记 **SENT**。
    另补 `errcode != 0` 与 invalidparty/invalidtag 同时出现的分支。
  - **定向通知 replay(SF2)**:新增 `NotificationOutboxService.replayDirectedWecomDelivery()`,
    建新 child id + 新 eventKey(v1 定向键允许 `:r{n}` nonce)。此前系统定向通知撞 45009 dead 之后
    **没有任何重发路径**(它没有 publish 状态机,eventKey 是确定性的)。
    跨 attempt 去重仍用 `notificationId + memberId + channel + SENT`,已 SENT 者不被重复打扰。

  `messageEnabled` 保持出厂 false;零 schema、零新 BizCode、零新权限码、零新端点、零新 cron;
  微信小程序 / 短信 / 站内三条链逐字不变。上线与 replay 口径见
  [`docs/ops/wecom-message-channel-rollout.md`](docs/ops/wecom-message-channel-rollout.md) §5.1 / §6.2。
