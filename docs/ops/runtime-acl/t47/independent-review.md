# T47 独立只读审查

**结论：CONDITIONAL。** 隔离栈中，同一活动已从管理端发布走到 H5 需保险报名、图片扫码签到和本人状态读回。组合业务验收通过。**后端 #1445 的红区人工作业实时仍为 `waiting`**，手机实机、微信和公网业务均未验收。[固定证据树](https://github.com/BA7IEE/srvf-nest-api/tree/929f33cdd77aa2a0c7207c43161c8aa9deeb9ad3/docs/ops/runtime-acl/t47) · [本次红区作业](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44667827144/job/136061481394)

## 版本与组合

实时核对，以下三份 PR 均为 Draft、未合并。

| 对象 | 实时 HEAD |
|---|---|
| 后端 #1445 | `dd62ce308f9142e8b3be04e9c4d52f548c0ebb17` |
| H5 #5 | `529ee3a3c441eaaf992049cbbe6ee32f1414fa63` |
| 管理端 #172 | `104e524c0b76826a79b1d48fad37fb07dcdfb8e8` |

独立执行祖先检查，后端 main `2b3eee0a…`、Cookie #1439 `47959402…`、活动 #1444 `713d3416…` 均为 #1445 的祖先。H5 #5 的实时 base 是 #4 `5e5be8dc…`。后端合并确实发生了路由清单、生成客户端与契约快照冲突，材料记录了按组合代码重新生成并核对原生契约测试的过程。**分别测试不足以覆盖组合**：实际模板活动允许公开报名但 `registrationModeCode` 为空，旧 H5 会关闭入口；本轮还补齐了本人保险预检和场次定位要求。[合并记录](/private/tmp/srvf-t47/join.log) · [后端 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1445) · [H5 PR](https://github.com/BA7IEE/SRVFMobileWeb/pull/5)

## 同源会话与业务结果

- **代理与 P0-E。** 隔离代理对直接 HTTP 和另一 Origin 均返回 `403/40300`，受信同源 HTTPS 返回 `200/0`。Access 只在页面内存，Refresh 使用 `HttpOnly`、`Secure`、`SameSite=Strict` Cookie；页面断言无法从 `document.cookie` 读取它。IndexedDB 仅保存跨标签状态和随机代际。最终 15m/90d 配置下，新 family 轮换两次，绝对期限保持不变；有 Access 到期恢复和跨标签退出回执。禁用与重放沿用 T46 证据。抽查本轮本地归档日志与 JSON，未发现实际 Token 值。[代理对照](/private/tmp/srvf-t47/proxy.jsonl) · [期限与落库](/private/tmp/srvf-t47/db90.jsonl)
- **发布、报名与签到。** 管理端使用 #172 静态产物，在后端中间提交 `137518b0…` 发布。最终后端相较该提交仅活动详情 service、DTO 两份运行时 JS 改变，其余 1,042 份相同；H5 在最终产物上操作同一条活动。最终 90 天配置下，零业务角色绑定的队员以合成团险完成报名 `201/0`，再从页面选取二维码图片、解码确认并签到 `201/0`。无保险报名为 `409/26030`，本人读回 `200/0`，读他人报名 `404/21001`。保险正例使用隔离环境的兼容配置，未覆盖严格保险模式。[构建差额](/private/tmp/srvf-t47/runtime-delta.json) · [最终页面回执](/private/tmp/srvf-t47/business90.jsonl) · [负例](/private/tmp/srvf-t47/boundary.jsonl)
- **审计证据有一处粒度差异。** 只读重算通过。最终报名 reqId `cmwofny7i152d96eaa6da211745484013` 对应 `registration.create` 和 `registration.review`。最终签到 reqId `cmwofnzad874d08ee89a5f6c822ccc7df` 匹配成功审计和主体，DB 另有一条本人 `self_qr` 事件及关联开放时段。最终审计投影只导出通用事件名 `activity.publish`；明确导出 `operation=attendance-punch.create` 和 `event_link=true` 的是首轮签到记录。两轮都支持签到成功，但最终轮不宜写成已单独复核审计到事件的直接链接。[最终轮 DB](/private/tmp/srvf-t47/db90.jsonl) · [首轮 DB](/private/tmp/srvf-t47/db.jsonl)

## 门禁与未运行项

**#1445 确需维护者处理其自身的红区门禁。** 实时作业 `136061481394` 的状态为 `waiting`，结论为空。#1439 的 `SUCCESS` 绑定旧 SHA，不能转移；#1444 的 `REQUIRED=false`、审批步骤 `skipped` 也不能套用于组合提交。本轮实施记录支持共享候选新增 `GRANT=0`。[红区作业](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44667827144/job/136061481394)

**`locationRequired=true` 正向场景标为 `NOT_RUN` 合理。** 固定后端的 Simple 模板解析器明确拒绝该值，直到模板支持所需坐标；这次成功活动使用无需定位的场次。390×844 桌面 Chromium 验证了图片选择和解码。手机相机、设备定位、微信 WebView 及公网登录、报名、签到均为 `NOT_RUN`，公网入口和 ready 的 TLS 健康检查不能替代这些验收。[模板校验源码](/private/tmp/srvf-t47/backend/src/modules/activities/activity-template-definition-v1.ts:301) · [设备记录](/private/tmp/srvf-t47/devices.json)

**CONDITIONAL：隔离组合链通过，#1445 红区人工审批待处理。**