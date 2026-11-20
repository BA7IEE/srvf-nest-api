# T38 独立只读审查

**结论：PASS，限于隔离栈中 `not_required` 活动的标题＋说明变更。** 页面申请、独立批准、两字段读回、审计和数据库终态相互吻合。旧草稿摘要被拒绝，额外容量差异也使页面停止批准。前端业务仓正式 PR、远程前端 CI 和公网业务验收仍未完成。[T38 固定证据树](https://github.com/BA7IEE/srvf-nest-api/tree/805ccde613f808ba4fa2ab18e63eb687e7be35d8/docs/ops/runtime-acl/t38)

## 版本与配对

审查开始时通过 GitHub 实时核对，私有源码 Draft #2 的 HEAD 为 `eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64`，后端 Draft #1444 的 HEAD 为 `713d3416830d897852929731ff7f9b638038ab7c`，两者均开放、未合并。前端相对基线 `6375148a61445972e792ce37cb401fd8e5162538` 有两次提交。本次审查的是 T37 提交 `40ec9d7c0bc77cb6dc4a849071c081479e3cf055` 之后的增量，结论来自 T38 的源码和证据。[前端 Draft #2](https://github.com/BA7IEE/srvf-test-archive/pull/2) · [后端 Draft #1444](https://github.com/BA7IEE/srvf-nest-api/pull/1444)

后端 SHA 未变，本轮只复核联测绑定。`PAIR.md` 将新前端静态清单与 `713d3416…` 的 OCI 镜像配对。退役后的核验记录确认保留镜像、新静态文件完整清单、旧配置逐字节一致及四处旧上游，OpenResty 配置自检通过。公网读回的 JS 摘要仍匹配旧版，公网后端记录仍为 `108feebb…`。[配对清单](/private/tmp/srvf-t38/PAIR.md) · [退役后核验](/private/tmp/srvf-t38/verify-after-retirement.log) · [公网读回](/private/tmp/srvf-t38/public-readback.txt)

## 两字段页面闭环

最终活动为 `cmwnpj1d60021lc01glbd0w3t`。页面请求的 `activityPatch` 恰含 `title`、`description`。审核页展示两项各自的原值与新值，独立审核人批准后，发起人刷新页面读回两项新值。[页面驱动](/private/tmp/srvf-t38/front/tests/render/simple_freeze_server.cjs:403) · [最终浏览器记录](/private/tmp/srvf-t38/final-browser.log)

| 核对点 | 结果 |
|---|---|
| 发起人申请 | `200/0`，reqId `cmwnpj6imbb576282e9d7d12c562cfc7e`，匹配业务审计 |
| 独立审核人批准 | `200/0`，reqId `cmwnpj8hvf72e8237cd3a1fb082f19971`，匹配审核人审计 |
| 数据库读回 | 变更为 `approved`，活动为 `published`、流程修订 2。冻结前后两字段均有变化，库内当前两值分别等于冻结目标。提交人与审核人不同，该活动仅有一条初审记录 |
| 审核人代提 | `404/20001`，符合对象隐藏约定，无对应成功业务审计 |

这些断言同时核对了身份、字段值和持久化结果。[请求与审计关联](/private/tmp/srvf-t38/correlations.json) · [只读查询](/private/tmp/srvf-t38/readback.sql) · [查询结果](/private/tmp/srvf-t38/readback.log)

## 过期确认与额外差异

**过期确认拒绝成立。** 驱动在页面完成最后一次读取、发出提审 POST 后暂停转发；同一发起人的另一浏览器上下文先保存草稿说明，返回 `200/0`。原请求未经改写放行后返回 `409/20255`，reqId `cmwnpj2m8fac7e1d65f95d80cb73fc183`，无对应成功业务审计。新会话按新摘要重新确认，返回 `200/0`，随后独立初审批准。该实测覆盖了“确认后、服务收到请求前，草稿被改”的窗口。PG 内两事务同时排队等锁为 `NOT_RUN`。[浏览器记录](/private/tmp/srvf-t38/final-browser.log) · [请求与审计关联](/private/tmp/srvf-t38/correlations.json)

**额外容量差异阶段的批准请求为 0。** 驱动仅在浏览器收到的同一份审核详情中加入容量变化，检查批准按钮禁用并统计批准 POST。恢复真实响应后，原申请才获批准。源码对标题和说明以外的冻结内容继续比较，表单也只发送发生变化的文本字段。结合过期摘要负例，没有发现删除版本保护或放开不可核对字段来取得通过的情形。容量负例没有向数据库写入容量变化。[审核页比较逻辑](/private/tmp/srvf-t38/front/src/views/srvf/workbench/publish-review/state.ts:122) · [容量负例驱动](/private/tmp/srvf-t38/front/tests/render/simple_freeze_server.cjs:429)

## 交付、CI 与未运行项

- **前端交付路径。** 实时仓库元数据确认 `srvf-admin-web` 为 **PUBLIC**、`srvf-test-archive` 为 **PRIVATE**；业务仓 `AGENTS.md` 明文要求保持私有。T38 复用了 T37 已存在的私有归档仓，#2 内是可逐提交审查的实际源码。材料未显示本轮新建仓库或更改可见性。该 PR 的作用限于私有存放与复审，业务仓正式 PR 仍缺。[业务仓规则](/private/tmp/srvf-t38/front/AGENTS.md:35) · [私有源码 PR](https://github.com/BA7IEE/srvf-test-archive/pull/2)
- **检查与批准。** 前端记录显示 PR 检查列表为空、归档仓登记 workflow 数为 0，远程前端 CI 应记 `NOT_RUN`。本地 lint、类型检查、构建及 82 项 harness 回归有成功记录。后端固定 SHA 的 14 项已运行检查成功，`Red-zone trusted approval` 为 `SKIPPED`，未取得该项人工批准。[前端检查](/private/tmp/srvf-t38/frontend-ci.json) · [命令与退出码](/private/tmp/srvf-t38/commands.tsv) · [后端检查](/private/tmp/srvf-t38/backend-ci.json)
- **权限与公网。** 本轮实施记录支持共享候选新增 `GRANT=0`，共享 B130 仍未获批。两份 Draft 均未合并，配对核验和公网旧静态指纹支持未切换。公网认证业务、实际切换与回退演练、供应商外发、真人开放均为 `NOT_RUN`。[配对及实施边界](/private/tmp/srvf-t38/PAIR.md)
- **场景范围。** 场次、岗位、时间、容量等多字段合法申请与批准均为 `NOT_RUN`。单一必填布尔或五类必填组合与本次“两字段变更”的交叉同样为 `NOT_RUN`。T37 的必填场景记录仅覆盖其当时提交和已测组合。

当前沙箱只读，未写入 `/private/tmp/srvf-t38-independent-review.md`；本回复为完整独审正文。

**PASS（T38 隔离栈已测范围）。**