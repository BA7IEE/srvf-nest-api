### Fixed

- 通知派发、SMS 与微信直接 Effect 的普通日志改为后端闭集错误分类，不再记录第三方 raw message、stack、cause、手机号、openid、URL、object key、secret、token 或 Authorization；delivery/outbox/sms_send_logs 持久化诊断与 retry/dead 行为不变。
- 校正 current-state 与前端 canonical handoff 的 durable outbox 当前事实，并记录业务负责人于 2026-07-27 最终确认 Decision 15.1=B、Decision 15.2=B。
