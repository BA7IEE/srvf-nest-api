# T37 独立只读审查

**结论：PASS，限本轮隔离栈和已测业务范围。** T36 停在必填指标审核页的问题，已在 T37 的前后端组合上闭合。单一必填布尔、五类必填指标组合、明确无需指标三种场景，都有独立审核发布、页面申请标题变更、独立批准和发起人读回的证据。冻结详情残缺时，页面仍禁止批准。公网认证业务和前端业务仓发布仍待验收。[固定证据树](https://github.com/BA7IEE/srvf-nest-api/tree/f1e409d481a25dc9225cf84c2d18a6962e950b02/docs/ops/runtime-acl/t37)

## 版本核对

启动时先执行了 `gh pr view`，沙箱无法直连 GitHub API，随后通过 GitHub 连接器实时读取了两份 PR。后端 #1444 仍为 **OPEN、Draft、未合并**，HEAD 精确为 `713d3416830d897852929731ff7f9b638038ab7c`，与隔离镜像记录的 revision 一致。本结论针对该 SHA 单独作出。前端业务源码提交为 `40ec9d7c0bc77cb6dc4a849071c081479e3cf055`，基线为 `6375148a61445972e792ce37cb401fd8e5162538`。私有材料 Draft #1 的实时 HEAD 是 `0d0cae03d7eb076562051d05ee8decc4bcc7de54`，其中 bundle 的提交与所需基线均吻合。[后端 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1444) · [私有材料 PR](https://github.com/BA7IEE/srvf-test-archive/pull/1) · [镜像和静态产物记录](/private/tmp/srvf-t37/identity.log)

## 页面、审计与数据库

| 场景 | 独立核对结果 |
|---|---|
| 单一必填布尔 | 页面提交后，独立审核人查看冻结指标并发布。初审批准 reqId `cmwnoj448b5fad13f3a9ce1b669d588f0`、标题变更批准 reqId `cmwnoj67dc8c6c29b984f8fbdb53f0cf5` 均对应审核人业务审计。DB 为 `published`、流程修订 2、指标集 v1、冻结指针匹配，页面读回批准后的标题。 |
| 五类必填组合 | 初审和标题变更审批页各断言一次布尔、非负整数、非负小数、短文本及单选的两个选项。两次批准 reqId `cmwnou6x5f83515786f9da05ef66f9147`、`cmwnou93g7866c2b426e7099030cc8c96` 对应同一活动的独立审核人审计。DB 逐项读回五项必填、v1、摘要匹配，活动已发布、流程修订 2。覆盖的是五类共存于同一集合。 |
| 明确无需指标 `not_required` | 单独活动走完发布和标题变更。DB 保留 `not_required` 和空指标集指针，流程修订 2；变更批准 reqId `cmwnol2d5dde38201504f6057115a1439` 与审计一致。 |
| 历史未配置 | 创建返回 `201/0`，携带正确草稿摘要提审返回 `400/20174`。DB 仍为草稿、指标修订 0，无审核行。通过的是**合同拒绝负例**；批准、发布及后续变更均为 `NOT_RUN`。 |

依据为浏览器逐请求记录、业务审计及按活动 ID 的 DB 读回。五类组合的首份夹具因摘要不符未被模板选中，成功结果来自另建且摘要匹配的版本，两次结果可以区分。[请求与审计关联](/private/tmp/srvf-t37/db-correlations.json) · [第一栈 DB](/private/tmp/srvf-t37/db.log) · [五类页面记录](/private/tmp/srvf-t37/kinds/verified.log) · [五类审计](/private/tmp/srvf-t37/kinds/db.log) · [逐项读回](/private/tmp/srvf-t37/kinds/set-readback.log)

## 拒绝路径与回归入口

**残缺响应阶段批准请求为 0，证据充分。** 驱动拦截真实详情响应并截去指标定义，同时监听 `POST …/approve`，断言按钮禁用、请求计数为零。恢复完整详情后，同一流程可以批准。源码也能解释这个结果：后端从已获准读取的申请快照解析冻结引用，前端重新计算指标集及逐项定义的 SHA-256。该负例验证了页面遇到残缺响应时的行为，数据库中的定义始终完整。[浏览器驱动](/private/tmp/srvf-t37/front/tests/render/simple_freeze_server.cjs:219) · [前端摘要校验](/private/tmp/srvf-t37/front/src/views/srvf/workbench/publish-review/metrics.ts:100) · [后端冻结引用读取](/private/tmp/srvf-t37/back/src/modules/activities/activity-review-metrics.ts)

**`expectedDraftHash` 与锁内确认保留。** 正常页面请求携带摘要，三类配置各有格式合法但内容错误的摘要被 `409/20255` 拒绝，关联表中无对应成功业务审计。当前后端源码先取得活动锁，再在同一事务调用 `confirmation.assertCurrent(tx)`。前端提交已加入可重复运行的服务器浏览器入口，五类逐项断言另有专用驱动。浏览器并发改稿竞态为 `NOT_RUN`。本次实际 diff 和负例均不支持删字段、去锁或解除禁用取得通过的说法。[锁与事务内确认](/private/tmp/srvf-t37/back/src/modules/activities/activity-publish-review-submit.service.ts:498) · [通用回归入口](/private/tmp/srvf-t37/front/tests/render/simple_freeze_server.cjs) · [五类专用断言](/private/tmp/srvf-t37/kinds/browser/simple_freeze_server.cjs:133)

**发布后变更仅验收单项标题。** 发起人从页面通过 `…/change-reviews` 提交完整冻结申请，另一账号核对原值、新值后批准，发起人刷新读回。审核人代提在该入口得到 `404/20001`，符合隐藏非负责人对象的行为。旧 #1416 `…/submit-change-review` 对审核人返回 `403/30100`，对合法用户请求缺失活动返回 `404/20001`。旧入口生成的 V1 快照缺少冻结前值，试验申请未获页面批准并已撤回；最终成功链使用 V7 完整入口。多字段变更为 `NOT_RUN`。[页面记录](/private/tmp/srvf-t37/required-final.log) · [旧入口缺失对象负例](/private/tmp/srvf-t37/issue1416.log) · [申请及撤回记录](/private/tmp/srvf-t37/db.log)

## 部署边界与人工 gate

- **候选与公网。** 隔离 API 无宿主发布端口。材料支持本轮共享候选新增 `GRANT=0`，其证明范围限于本轮实施记录。公网记录仍为 `108feebb84b85c7e4955c5af8bbfc016702e4529`，ready 返回 200；公网认证后业务、供应商外发和公网回退演练均为 `NOT_RUN`。两份 PR 均未合并，无公网切换记录。[环境身份](/private/tmp/srvf-t37/identity.log) · [公网配置](/private/tmp/srvf-t37/public-config.log)
- **前端交付。** 前端 `AGENTS.md` 明确要求业务仓保持私有，开发材料如实披露了其查询到的公开可见性。本轮独立核实了本地规则、补丁、bundle 和材料 PR；业务仓当前可见性未独立实时复核。私有材料足以复审固定源码，前端业务仓远程 CI 和正式交付仍未完成。[前端仓规则](/private/tmp/srvf-t37/front/AGENTS.md) · [bundle 核对](/private/tmp/srvf-t37/bundle-verify.log)
- **六项材料齐备，可供人工审阅。** 固定 SHA、实际 diff、开发验证、本次独审、部署影响、配对回退均已覆盖。后端本轮增量集中在冻结指标详情读取、DTO、测试与契约生成物，未新增迁移。回退须核对前端静态版本与后端镜像的组合；恢复现行旧组合会重新遇到 T35 的提审不兼容，已完成的业务、审计与通知记录仍须保留。绑定 `713d3416…` 的 CI 记录中，实际运行的 14 项成功，`Red-zone trusted approval` 为 `SKIPPED`，没有本提交的人工批准。[CI 记录](/private/tmp/srvf-t37/back-ci.json) · [影响与回退材料](/private/tmp/srvf-t37-dev-report.md)

当前沙箱只读，未写入 `/private/tmp/srvf-t37-independent-review.md`；完整独审正文以上述回复为准。

**PASS（隔离栈已测范围）。**