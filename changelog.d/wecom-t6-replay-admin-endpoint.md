### Added

- **企业微信定向通知 replay 运维入口**(T6-1;第二轮外部评审 SHOULD-FIX 3 的收口,零 schema)。
  第三刀(#901)把「只放行上次是 `rate-limited` / `provider-contract-error` 的重发」做成了代码判据,
  但它只是**服务层原语** —— 没有入口、没有 RBAC、没有审计,runbook 只能写"需维护者在应用上下文中调用",
  对本项目维护者而言那不是可执行路径。本刀把它做成运维点得到的东西:
  - **新端点** `POST admin/v1/notifications/:id/replay-wecom`(逐字镜像 `send-sms` 的形状:
    同 controller、同 surface、R 模式判权、同 audit 范式;body `{ overrideReason?: boolean }`,
    返 `{ replayed, skipped, results[] }`)。**恒返 200**,结局在 `outcome` 十值闭集里 ——
    这是诊断端点,"为什么没重发"比"HTTP 几"更该一眼看到。
  - **新权限码** `notification.replay.wecom`,归 **ops-admin**(运维面,与 `wecom-setting.*` /
    `user.wecom.clear` 同族),**不**绑 biz-admin;SUPER_ADMIN 经 `RbacService` 自然短路。
  - **审计**复用 `notification.publish` 伞事件 + `extra.operation='replay-wecom'`
    (**零新增 AuditLogEvent**,沿 send-sms 同一范式)。每一次通过判权的调用都记(含被拒的),
    `extra` 含 `overrideReason` / `replayed` / `skipped` / `outcomes` / `newIntentIds` ——
    **「谁绕过了允许集」可按 `extra.overrideReason=true` 直接筛出来**。
    `wecomUserId` / 深链 / 凭证一概不入(§5.5)。
  - **端点层零第二份判据**:允许集与「已 SENT / 在途 attempt / 非系统定向 / never-attempted」
    全部由原语裁决,端点只做判权 + 参数 + 记账。连"通知存不存在"都不预检 ——
    那会是原语已经拥有的判断的第二份拷贝,而**判据长出第二份正是本 finding 的成因类型**。
  - **做端点不做 CLI**(2026-08-03 拍板):CLI 拿不到真实登录 actor,审计归属会变弱,
    而 replay 恰恰是最需要"谁在什么时候重发了什么"的动作。
  - runbook §6.2 从"需在应用上下文中调用"改成真实操作步骤(端点 / 权限 / 允许集 /
    override 的后果 / audit 怎么查);`docs/handoff/admin-web.md` 登记 FE **可选**适配
    (试点期维护者手动调用即可,本期不要求前端做按钮)。
  - footprint:Endpoint 450→**451** · 权限码 227→**228**;
    BizCode / AuditLogEvent / Migration / Cron / throttler **恒等**;零 schema。
