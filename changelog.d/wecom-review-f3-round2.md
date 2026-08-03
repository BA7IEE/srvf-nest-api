### Fixed

- **企业微信 —— 第二轮外部评审三条 SHOULD-FIX**(P1-27 第三刀,零 schema / 零端点 / 零 BizCode)。
  第二轮评审判 **GO WITH CONDITIONS**(直接安全 BLOCKER 0),三条均属"文档或注释描述了某个机制,
  但代码里没有对应执行位":
  - **pre-auth 绑定补身份代际(SF1)**:`auth/login-wecom.service.ts` 的 `runBindTransaction`
    在真实 create / rebind 路径递增 `User.wecomIdentityVersion`。此前该代际只有 authed 换绑
    (`users/user-wecom-binding.service.ts`)与撤销原语(`users/wecom-identity-revoke.ts`)两个写入点,
    而第 70 个 migration 的注释写的是"递增方:**两条**绑定事务 + 撤销原语" —— 补的是代码欠注释的那一条。
    递增落在**已持有的那把 User 锁之内**、与 identity 同事务(后腿失败一起回滚),
    **同目标 no-op 不递增**。
  - **锁序机制表述订正(SF2)**:此前 `notification-wecom-dispatch.service.ts` 与并发 spec 称
    "把最终闸的 `User` 升成 `FOR UPDATE`,环立刻成立" —— **不准确**:缺失的边在 `wecom_settings` 上,
    settings 两侧都是 `FOR SHARE`,升 `User` 改变不了它们相容。同库实测 PG 16.13 的相容矩阵后改写为:
    旧序下要兑现,需**任一侧**把 settings 升成 `FOR NO KEY UPDATE` / `FOR UPDATE`,
    或新增"持 User 再申请 settings 写锁"的路径。并同步订正那条 PG 护栏用例的前提
    (它用手写 SQL 造锁,**改应用代码不会让它红**;守应用锁序的是主用例),
    断言从单格扩成**四格相容矩阵**,让它真正守住自称守住的条件。
  - **定向 replay 补历史终态判据(SF3)**:`replayDirectedWecomDelivery` 默认只放行上一次是
    `rate-limited` / `provider-contract-error` 的(intent dead 过 **且** 最后那条 delivery 的
    reasonCode 在允许集内)。此前 runbook §6 写了这条限制但代码只看通知形态,于是
    `channel-disabled` / `recipient-unlicensed` / **从未建过 child** 的通知都能重建 attempt——
    这三类重发解决不了,只会把上游调用量放大一轮。越界需显式 `{ overrideReason: true }`,
    它只绕这一条,其余护栏一概不绕。运维入口与 replay 审计仍归 T6。

  三条各有 red-first 成对证据;既有断言**逐字未改**(三个 spec 全是新增用例)。
