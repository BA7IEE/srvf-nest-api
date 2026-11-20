# T42 独立只读审查

**活动交叉验收 PASS；普通报名写入 FAIL；包含正常报名的首发链路 BLOCK。** `GATE.md` 准确区分了活动功能交付、报名故障和公网部署。现有证据足以确认隔离运行角色存在行锁权限缺口，尚不足以把该次 HTTP 500 唯一归因于 `42501`。[固定证据树](https://github.com/BA7IEE/srvf-nest-api/tree/2f310d71feb92fb56ecc65d01739373935febd79/docs/ops/runtime-acl/t42)

## 版本与活动验收

GitHub 实时核对，正式前端 #172 的 HEAD 仍为 `104e524c0b76826a79b1d48fad37fb07dcdfb8e8`，后端 #1444 仍为 `713d3416830d897852929731ff7f9b638038ab7c`。两份 PR 均为开放的 Draft，未合并。本次对 **T42 新增证据**做了只读重算：四张审核单、12 条活动写请求及对应审计、容量快照和逐列时间读回均与归档一致。[前端 PR](https://github.com/BA7IEE/srvf-admin-web/pull/172) · [后端 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1444) · [对账结果](/private/tmp/srvf-t42/reconciled.json)

| 审查项 | 独立判定 |
|---|---|
| 五类必填 × 活动变更 | 四张审核单均绑定 `t37_full_set@1`，布尔、非负整数、非负小数、短文本和单选五项全部必填，冻结摘要一致。四个审核页都有逐项展示记录。普通发起人与独立普通审核人走通初审发布、改期＋地点文字＋扩容联合批准，以及单独改为不限额。 |
| 实际生效值 | 活动与场次均改至北京时间 12 月 3 日 10:00–12:00。签到开放、签到截止、签退开放、签退截止逐列读回为 10:00、10:20、11:40、12:00，与冻结快照一致。活动与场次地点文字同步，原结构化地点保留。活动、场次、岗位三层容量均经历 `2 → 12 → null`。 |
| 拒绝与半写 | 非法时段、场次越界、空地点分别返回 `400/20015`、`400/20134`、`400/40000`。审核响应缺一项指标定义、藏入额外地点差异时，批准请求均为 0。夹具建立两人占用后，降容至 1 的申请成功，批准返回 `409/20147`；第四张单仍待审、无批准人，三类桶各占 2，六条占位和既有批准记录在失败前后一致。 |

这补齐了 T41 尚缺的“五类指标 × 三字段”组合和本场景签到、签退窗口的逐列 SQL 回执。范围限单场次、单默认岗位；多场次联动、岗位独立改期、真实坐标或围栏迁移仍为 `NOT_RUN`。草稿冲突 `409/20255` 本轮未重跑。[四单指标读回](/private/tmp/srvf-t42/all-five.jsonl) · [逐层与逐列读回](/private/tmp/srvf-t42/final-layers.jsonl) · [页面记录](/private/tmp/srvf-t42/final-layout.log)

## 报名失败与归因边界

**报名 FAIL 有直接证据。** 添加占位夹具前，普通账号报名请求 `cmwnruxx748535b00a72ab1c329a8c304` 预期 `201`，实际为 `500/50000`，驱动退出 1。前后快照相同：报名头为空，版本和参与身份均为 0，三个容量桶的占用数均为 0。后续使用夹具验证了本人可读、交叉读取返回 `404/21001`；正常报名后的幂等重试、取消、签到与结算仍为 `NOT_RUN`。[报名请求](/private/tmp/srvf-t42/registration-enroll.log) · [报名前](/private/tmp/srvf-t42/registration-before.jsonl) · [报名后](/private/tmp/srvf-t42/registration-after-enroll.jsonl)

**`42501` 是可信的故障线索，唯一根因未证实。** 同时窗 PG 日志记录了对 `ActivityParticipationIdentity` 的权限拒绝，但 `request_id_match=false`，原日志行也没有 SQLSTATE。精确的 `42501` 来自独立对照：同一运行角色执行普通查询成功，增加行锁后失败。ACL 取样与之吻合，该角色具有 13 列 SELECT，未见 INSERT 或 UPDATE 权限。报告和 GATE 将 HTTP 失败与行锁对照分开表述，归因强度合适。当前材料不足以确定整笔报名事务所需的最小授权，也不足以支持共享库 GRANT。[同时窗诊断](/private/tmp/srvf-t42/diagnosis.jsonl) · [行锁对照](/private/tmp/srvf-t42/lock-control.log) · [有效权限取样](/private/tmp/srvf-t42/enrollment-acl.jsonl)

## GATE 与公网边界

**GATE 材料 PASS，适用于维护者判断两条固定 PR 的活动功能交付。** 包内列明实际差异、CI、独审范围、业务影响和配对回退条件，也单列了报名失败。后端红区裁判为 `REQUIRED=false`，人工步骤 `skipped`，没有待点的该项审批。前端主分支另前进一笔仅改 README 的提交，现有 CI 仍按已记录的 HEAD 和运行结果解读。[GATE.md](/private/tmp/srvf-t42/GATE.md) · [红区裁判](/private/tmp/srvf-t42/redzone-verdict.log) · [前端主分支差额](/private/tmp/srvf-t42/front-main-delta.json)

本轮实施记录支持共享候选新增 `GRANT=0`。公网仍使用旧配对；回退资产和配置语法已预检，公网新配对认证业务、实际切换与回退、真实用户开放及供应商投递均为 `NOT_RUN`。[配对与回退边界](/private/tmp/srvf-t42/PAIR.md)

**活动 PASS；报名 FAIL；含报名首发 BLOCK。**