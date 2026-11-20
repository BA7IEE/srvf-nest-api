# T40 独立只读审查

**结论：PASS。** 正式前端业务仓 `BA7IEE/srvf-admin-web` 已收到 Draft PR #172，实时 HEAD 与 T38、T39 隔离验收使用的前端提交完全相同。业务仓自己的必需检查 `verify` 已成功。本结论单独针对 #172 的正式交付、同版本证据复用和检查结果；公网业务验收仍为 `NOT_RUN`。[正式前端 PR](https://github.com/BA7IEE/srvf-admin-web/pull/172) · [T40 固定证据](https://github.com/BA7IEE/srvf-nest-api/tree/da3a8dd202c435e992d931d9bbd741fdc214fba0/docs/ops/runtime-acl/t40)

## 1. 正式仓、提交与保护规则

先用 `gh pr view` 查询两份 PR，沙箱无法直连 GitHub API，随后通过 GitHub 连接器取得实时状态。

| 对象 | 实时 HEAD | 状态 |
|---|---|---|
| 前端业务仓 #172 | `eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64` | OPEN、Draft、未合并 |
| 后端 #1444 | `713d3416830d897852929731ff7f9b638038ab7c` | OPEN、Draft、未合并 |

#172 的 base 为 `6375148a61445972e792ce37cb401fd8e5162538`。正式仓 HEAD、隔离验收源码和本次 GitHub 合并预览的 tree 均为 `43fbfef8080b7958d3a0ea448b521f749ac258a8`。合并预览只是 GitHub 生成的比较对象。实际差额为八个文件，覆盖前端 API 适配、活动与审核页面、浏览器驱动；未改 `AGENTS.md` 或 workflow。[正式仓 Git 对象](/private/tmp/srvf-t40/official-tree.json) · [合并预览](/private/tmp/srvf-t40/merge-preview.json) · [文件清单](/private/tmp/srvf-t40/changed-files.tsv)

原业务仓仍为 PUBLIC，`AGENTS.md` 中的私有约束仍在；开发报告将此次提交依据记为维护者对现有公开仓的单独授权。分支保护回执显示 `protected=true`，`verify` 对所有人强制执行。现有材料支持本次提交沿用既有可见性和保护，未见修改设置的操作；本审查未取得仓库设置的完整历史审计。[分支保护回执](/private/tmp/srvf-t40/front-branch.json) · [业务仓规则](/private/tmp/srvf-t38/front/AGENTS.md:35)

## 2. 正式业务仓原生 CI

**`verify SUCCESS` 属实。** 原生运行 `44561763088` 的仓库为 `BA7IEE/srvf-admin-web`，事件为 `pull_request`，`headSha` 精确匹配 #172。作业 `135692656191` 已完成，必需检查回执为 `SUCCESS`，`gh run watch --exit-status` 退出码为 0。步骤覆盖项目守护检查、依赖安装、lint、格式零漂移、类型检查和构建。本判定使用业务仓运行记录；私有 archive 的空检查列表没有计入。该工作流没有运行服务器 Chromium。[正式仓原生作业](https://github.com/BA7IEE/srvf-admin-web/actions/runs/44561763088/job/135692656191) · [必需检查回执](/private/tmp/srvf-t40/required-ci.json)

## 3. T37–T39 可复用的范围

- **T38、T39 与 #172 同 SHA。** `not_required`、单必填布尔、五类必填组合均有标题＋说明的页面申请、独立批准和读回证据。相应场景还覆盖过期确认 `409/20255`、审核人代提拒绝，以及残缺定义或额外容量差异时批准请求为 0。T40 核对了源码树和前后端配对，没有重新执行这些业务操作。[T38 证据](https://github.com/BA7IEE/srvf-nest-api/tree/805ccde613f808ba4fa2ab18e63eb687e7be35d8/docs/ops/runtime-acl/t38) · [T39 证据](https://github.com/BA7IEE/srvf-nest-api/tree/060d78d74b0331bc29626ef469a8d4b5b82f0107/docs/ops/runtime-acl/t39)
- **T37 的未配置指标 `400/20174` 保留为历史合同负例。** 当时前端为 `40ec9d7c…`，后端与本轮相同。该项不能登记成 `eb587bd2…` 上重新跑过。正式 PR 对应的后端仍提供授权范围内的 `frozenMetricSets`，Simple 提审仍在活动锁内复核 `expectedDraftHash`。[T37 证据](https://github.com/BA7IEE/srvf-nest-api/tree/f1e409d481a25dc9225cf84c2d18a6962e950b02/docs/ops/runtime-acl/t37) · [固定后端源码](https://github.com/BA7IEE/srvf-nest-api/tree/713d3416830d897852929731ff7f9b638038ab7c)

## 4. 时间、地点与容量

报告的缺口与源码合同一致。发布后表单和 API 适配器只发变化的标题、说明，审核页继续核对其余冻结字段。后端 DTO 能接收某字段，只能证明存在服务端入口，不能证明页面已完成申请、批准和读回。[前端审核逻辑](https://github.com/BA7IEE/srvf-admin-web/blob/eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64/src/views/srvf/workbench/publish-review/state.ts#L112) · [后端提案校验](https://github.com/BA7IEE/srvf-nest-api/blob/713d3416830d897852929731ff7f9b638038ab7c/src/modules/activities/activity-publish-proposal-v2.service.ts#L4887)

| 字段 | 已核边界与 `NOT_RUN` |
|---|---|
| 起止时间 | 活动时间和场次时间分别校验。合法改期及非法时间、场次越界的发布后页面正反例均为 `NOT_RUN`。 |
| 地点 | 主地点文本、场次地点和结构化地点有各自的含义。发布后页面申请、审核展示、批准和分层读回均为 `NOT_RUN`。 |
| 容量 | T39 已测浏览器收到额外容量差异时会阻止批准。真实容量提案、有界与不限之间的变更、低于已占用时的拒绝及无半写验证均为 `NOT_RUN`。 |

## 5. 合并与公网边界

后端 #1444 的固定 SHA 检查记录中，14 项已运行检查成功，单列的 `Red-zone trusted approval` 为 `SKIPPED`，未形成该作业的人工批准。两份正式 PR 均未合并。T40 的配对复核通过，共享候选本轮新增 `GRANT=0` 按实施记录成立；公网认证业务、实际切换、回退演练、真实用户开放和供应商投递均为 `NOT_RUN`。[后端 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1444) · [后端检查记录](/private/tmp/srvf-t40/back-ci.json) · [配对复核](/private/tmp/srvf-t40/pair-readonly.log)

**PASS（正式前端 PR #172，同 SHA 交付及原生 CI）。**