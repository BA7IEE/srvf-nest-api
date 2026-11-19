# T39 独立只读审查

**结论：PASS，限于隔离栈的两项新增组合：单一必填布尔 × 标题和说明变更、五类必填指标 × 标题和说明变更。** 两组都有页面操作、独立审核、成功与拒绝请求、业务审计和数据库终态相互印证。本次只读重算了 16 条请求与审计的关联，结果与归档一致；未重跑会产生写入的浏览器流程。[T39 固定证据](https://github.com/BA7IEE/srvf-nest-api/tree/060d78d74b0331bc29626ef469a8d4b5b82f0107/docs/ops/runtime-acl/t39)

## 版本与实际增量

审查开始时，GitHub 实时返回后端 Draft #1444 HEAD `713d3416830d897852929731ff7f9b638038ab7c`，前端私有源码 Draft #2 HEAD `eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64`。两者均开放、未合并。核对两个固定证据提交的实际变更路径，公开提交只改 `docs/ops/runtime-acl/t39/`，私有提交只改 `t39/` 下的回归补丁、夹具、运行脚本和核验材料。配对复核记录也确认保留镜像与完整静态清单匹配。**“本轮只扩回归证据，无新业务或红区源码 SHA”的表述成立。** T38 的 PASS 只作为版本基线，本轮两项新增组合分别按 T39 证据判定。[后端 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1444) · [前端源码 PR](https://github.com/BA7IEE/srvf-test-archive/pull/2) · [固定回归入口](https://github.com/BA7IEE/srvf-test-archive/tree/a9fa1c71f65c03d8b1d3c4278007cef619c619b2/t39)

## 两组页面全链路

| 场景 | 页面、审计与 DB 交叉结果 |
|---|---|
| 单一必填布尔 | 创建 `201/0`。初审和变更审核页均显示冻结的布尔定义；审核人看见标题、说明各自的原值和新值，独立批准后，发起人刷新读回两项新值。初审批准 `cmwnq01u5efe558adc9336822fc5a1cd5`、变更批准 `cmwnq04mx47bbeccfcd452366022b2c5d` 均匹配审核人审计。 |
| 五类必填组合 | 同一路径走通。两次审核页均核对布尔、非负整数、非负小数、短文本和单选，包括小数上限、文本长度和两个选项。初审批准 `cmwnq21kgbf43c23889a186e4ebdd5e4b`、变更批准 `cmwnq255v04ddb8c17a49b0c0f245ab1f` 均匹配审核人审计。首次登录遇到 `429/42900`，成功证据取自限流窗口过后从登录开始的完整重跑。 |

两份活动各有一份 `approved` 初审和一份 `approved` 变更。提交人、审核人是不同的普通账号。DB 读回的指标集均为 v1，分别有 1 项、5 项，全部必填，冻结引用匹配。两份活动最终均为 `published`、流程修订 2；两条变更记录的标题和说明都发生了变化，库内当前值分别等于获批目标。[布尔页面记录](/private/tmp/srvf-t39/boolean.log) · [五类成功重跑](/private/tmp/srvf-t39/five-retry.log) · [数据库读回](/private/tmp/srvf-t39/readback.jsonl)

## 拒绝路径

- **过期确认。** 两组均由同一发起人的另一浏览器上下文先保存说明，再放行已经产生的旧提审请求。旧摘要均返回 `409/20255`，无对应成功业务审计；重新读取后以不同摘要提审均为 `200/0`，各只有一条初审记录。实测覆盖请求交错，PG 内两事务同时等锁为 `NOT_RUN`。[请求与审计关联](/private/tmp/srvf-t39/correlations.json)
- **残缺定义和额外容量。** 两个初审页各测一次缺定义，两个变更页各测一次额外容量差异，五类变更页再测一次五份定义中仅缺一份。五次均禁用批准，分别计得批准请求 **0**。恢复服务器原始响应后才完成合法批准。容量和残缺定义均为浏览器响应拦截负例。[布尔记录](/private/tmp/srvf-t39/boolean.log) · [五类记录](/private/tmp/srvf-t39/five-retry.log)
- **审核人代提。** 两组均返回 `404/20001`，符合非负责人访问该对象时的隐藏约定；按 reqId 和身份核对，均无成功业务审计。[请求与审计关联](/private/tmp/srvf-t39/correlations.json)

## 未运行项与交付边界

- **时间、地点的发布后正向变更为 `NOT_RUN`。** 后端 DTO 可接收 `startAt`、`endAt`、`location`，当前发布后页面只提交标题和说明，审核页要求其余冻结字段保持一致。草稿页能编辑部分日程，不能据此验收发布后变更。容量、场次、岗位的正向申请及批准也均为 `NOT_RUN`。[字段与源码范围](/private/tmp/srvf-t39/field-scope.md)
- **业务仓正式 PR 仍缺。** 交付查询记录显示原业务仓为 `PUBLIC`，查不到该前端提交；仓内规则要求私有。源码和回归材料复用了既有 `PRIVATE` 归档仓的 Draft #2 和材料 PR。未见本轮新建仓库或修改可见性的操作。前端远程 CI 为 `NOT_RUN`；后端固定 SHA 的人工红区审批为 `SKIPPED`，不构成人工批准。[交付状态](/private/tmp/srvf-t39/delivery.json) · [业务仓规则](/private/tmp/srvf-t38/front/AGENTS.md:35) · [后端检查](/private/tmp/srvf-t39/backend-ci.json)
- **候选和公网。** 实施与配对记录支持共享候选本轮新增 `GRANT=0`。公网健康检查返回 200，记录中的 API 仍为旧版 `108feebb…`。公网认证业务、真实用户开放、实际切换与回退均为 `NOT_RUN`。[配对材料](/private/tmp/srvf-t39/PAIR.md) · [退役后配对复核](/private/tmp/srvf-t39/pair-after.log) · [公网健康记录](/private/tmp/srvf-t39/public-health.txt)

**PASS（T39 两项隔离回归）。**