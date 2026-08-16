### Added

- 活动业务改造 v1.1 第 5 批接通场次自助二维码和现场服务段：考勤责任人可签发、作废并受保护渲染签到/签退二维码；本人可扫码签到、签退和读取安全服务段状态。
- QR 与 PunchEvent 统一按 Activity 根事务、canonical request hash 和 append-only 事实链处理；支持责任人早退闭合、void、replace，并将有效 PunchEvent 作为整单取消的零写闸门。

### Changed

- 二维码 render 只返回 `Cache-Control: no-store` 的 SVG 二进制内容；任何 JSON 读面、回执和审计 extra 都不回显扫码 token、token digest 或 request hash。
