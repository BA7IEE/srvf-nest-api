# T41 独立只读审查

**结论：PASS，限于本次隔离栈已测的 Simple 单场次、默认岗位、必填布尔指标活动。** 改期、修改地点文字、调整三层容量均有页面申请、独立批准和读回证据。降容至低于实际占用时，审批被拒，已生效数据与历史批准记录保持一致，新提案仍待审。[T41 固定证据树](https://github.com/BA7IEE/srvf-nest-api/tree/219d0129e64aa3bedf9ffd7dc8198164dd61ede0/docs/ops/runtime-acl/t41)

## 版本与原生 CI

审查开始时从 GitHub 实时核对，前端业务仓 #172 的 HEAD 为 `104e524c0b76826a79b1d48fad37fb07dcdfb8e8`，配套后端 #1444 的 HEAD 为 `713d3416830d897852929731ff7f9b638038ab7c`。两份 PR 均为开放的 Draft，未合并。前端原生作业 `verify` 的回执绑定本次新 SHA，运行 `44565714648`、作业 `135706747311` 均来自 `BA7IEE/srvf-admin-web`，结果为 `SUCCESS`。后端单列的 `Red-zone trusted approval` 为 `SKIPPED`，没有该项人工批准记录。[前端原生 CI](https://github.com/BA7IEE/srvf-admin-web/actions/runs/44565714648/job/135706747311) · [前端 PR](https://github.com/BA7IEE/srvf-admin-web/pull/172) · [后端 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1444)

T40 只覆盖父提交 `eb587bd2…`。本次对新 SHA 的八文件增量和新证据单独审查，并从浏览器日志、数据库前后快照重新计算了 12 条请求与业务审计的关联，结果与归档一致。正向审批的提交人和审核人是不同的普通 `USER`。[实际增量](https://github.com/BA7IEE/srvf-admin-web/compare/eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64...104e524c0b76826a79b1d48fad37fb07dcdfb8e8) · [核对结果](/private/tmp/srvf-t41/reconciled.json)

## 时间、地点与容量

| 项目 | 正向证据 | 拒绝与边界 |
|---|---|---|
| 时间 | 北京时间 12 月 1 日 09:00–11:00 改为 12 月 3 日 10:00–12:00。待审时原时间有效，审核页展示原新时间及联动场次、签到窗口，批准后详情和冻结提案一致。 | 页面拦截开始晚于结束。以负责人身份调用同一接口，起止相等返回 `400/20015`，原场次越出新活动范围返回 `400/20134`。两次拒绝均无成功业务审计。签到窗口逐列独立 SQL 读回为 `NOT_RUN`。 |
| 地点 | 活动主地点和场次地点文字改为“东侧训练区”标记值；批准后页面读回新文字，冻结的结构化地点和可见范围保持原值。 | 页面拦截空白，API 对空字符串返回 `400/40000`。在浏览器响应中加入未展示的地址差异后，批准按钮禁用、批准请求为 0。真实结构化地址、坐标和签到围栏迁移均为 `NOT_RUN`。 |
| 容量 | 同一组合提案将上限从 2 调到 12，随后另一提案从 12 调为不限。活动、场次、默认岗位三层目标一致，两次均由独立审核人批准。 | 页面拦截零容量。已有两人占用时，降至 1 的申请提交成功，独立审批返回 `409/20147`。占用通过隔离库夹具建立，报名页面全链为 `NOT_RUN`。 |

组合变更批准的 reqId 为 `cmwnresr5e9df015acdecf75d6bce4d5a`，改为不限的批准为 `cmwnrevcg5222b6f7d63af43a2ed4dc2d`，均匹配成功业务审计。非法时间、场次越界和空地点的请求均能按各自 reqId 核对。[页面记录](/private/tmp/srvf-t41/final-layout.log) · [请求与审计](/private/tmp/srvf-t41/reconciled.json)

## 半写与既有保护

**降容失败后的半写检查通过。** 降至 1 的提交 `cmwnrh40x81ac6d12071d7d4e7ca2bd8f` 合法产生一条待审提案。随后的批准请求 `cmwnrh5sm06fb8e05b1c96f625340f8fc` 被拒，无成功业务审计。前后快照中，六条有效预约仍在，三个容量桶均为不限、各占用 2；活动、场次、岗位和地点的聚合摘要一致。前三条已批准记录相同，第四条仍待审、无审核人。由此可以区分合法的“提交待审”写入与失败审批应回滚的写入。[审批前快照](/private/tmp/srvf-t41/final-before.jsonl) · [审批后快照](/private/tmp/srvf-t41/final-after.jsonl) · [失败审批记录](/private/tmp/srvf-t41/final-occupied-retry.log)

无需指标模板的定向回归也保留了原有保护：另一浏览器上下文保存改稿后，旧确认返回 `409/20255`，重新确认后通过；与摘要不一致的额外容量差异触发零批准请求；审核人代负责人申请返回 `404/20001`。五类必填指标与本次三个新字段的组合仍为 `NOT_RUN`。[定向回归](/private/tmp/srvf-t41/text-retry.log)

本轮实施记录支持共享候选新增 `GRANT=0`。隔离产物与配套后端镜像已核对，公网仍保留旧配对。公网认证业务、实际切换与回退、供应商外发均为 `NOT_RUN`。[隔离配对](/private/tmp/srvf-t41/final-pair.log) · [公网配对记录](/private/tmp/srvf-t41/public-pair.log)

**PASS（T41 固定 SHA，隔离已测范围）。**