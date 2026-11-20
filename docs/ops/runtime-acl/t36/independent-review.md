# T36 独立只读审查

**结论：CONDITIONAL_PASS。** T35 的 `expectedDraftHash` 不兼容已在隔离栈得到修复。用首发静态前端和修复后端，指标非必填场景已从页面登录、Simple 创建、确认提审走到独立审核发布，并通过 App 接口提交了 #1416 变更。必填指标场景只通过提审，审核页仍阻止发布。公网业务验收仍为 `NOT_RUN`。[固定证据](https://github.com/BA7IEE/srvf-nest-api/tree/b41d9bf588b802257e3ff193651468c30e9c1e1f/docs/ops/runtime-acl/t36)

## 1. 隔离栈与业务闭环

复核时，Draft #1444 的 HEAD 精确为 `629956260a44acf3a40a6dc7ab26728583b05140`。隔离栈实际构建自 `1f234b50b5614216429ec42433a1fffae636c27e`，其基线是公网运行版本 `108feebb84b85c7e4955c5af8bbfc016702e4529`。独立比较得到，隔离构建提交与 PR HEAD 的 `src` 树相同，均为 `2561cbe27a8d4185a75fca789c6eba719827593e`。前端只读挂载首发版本 `b7f3dac00a860e32c0cbc220f29da0755bce024b`，已核对 bundle 摘要。这个对应关系支持把隔离业务结果归到本次源码修复。[PR #1444](https://github.com/BA7IEE/srvf-nest-api/pull/1444) · [环境记录](/private/tmp/srvf-t36/identity.log)

| 指标非必填场景 | 交叉核对结果 |
|---|---|
| 登录、Simple 创建 | 浏览器使用普通业务账号走 Simple 入口，创建返回 HTTP `201`、业务码 `0`。 |
| 确认提审 | 页面请求携带 `expectedDraftHash`，返回 `200/0`，reqId `cmwnn2lg965b8d0076006cd77d06a0e47`，与审计相符。 |
| 独立审核发布 | 另一普通账号在浏览器审核，返回 `200/0`，reqId `cmwnn2n8xbe6e2d3c836b3bca799ae2f7`。同一 reqId 下有两条关联审计，数据库显示初审通过、活动已发布。 |
| #1416 变更 | 经认证的 App HTTP 请求覆盖了正负例。审核人提交得到 `403/30100`，发起人得到 `200/0`，reqId `cmwnn2nkyf35651e33e5460dc1a5b150e`。数据库留下 v2 待审变更。此步覆盖到提交，未验证变更审批，也未验证页面操作。 |

浏览器记录、审计 reqId 和数据库终态相互吻合，足以支持上述边界内的 PASS。[浏览器记录](/private/tmp/srvf-t36/not-required.log) · [数据库与审计](/private/tmp/srvf-t36/db-final.log)

## 2. 错误摘要与锁内确认

**PASS。** 两个指标场景都用格式合法、内容错误的摘要得到 `409/20255`，随后正确摘要可以提审。这排除了仅从请求中删掉字段、让旧 DTO 放行的解释。锁内顺序另有源码依据：提交服务先取得活动锁，再在同一事务中调用 `confirmation.assertCurrent(tx)`，比较当前草稿摘要，通过后才写提审状态。浏览器并发改稿与提审的竞态实测为 `NOT_RUN`。[固定 SHA 提交服务源码](https://github.com/BA7IEE/srvf-nest-api/blob/629956260a44acf3a40a6dc7ab26728583b05140/src/modules/activities/activity-publish-review-submit.service.ts) · [实际补丁](/private/tmp/srvf-t36/backport.diff)

## 3. 必填指标与未配置指标

**必填指标提审 PASS，页面审核发布 BLOCK。** 该场景已经创建必填布尔指标及 v1 指标集，草稿版本为 1。正确摘要提审返回 `200/0`，reqId `cmwnn6r40c94fbcf7861f61026300adad`。审核账号读取审核数据返回 `200`，但该版前端无法完整呈现非空的冻结指标集指针，审批按钮保持禁用。浏览器没有发出批准请求，数据库仍是草稿、初审待审、审核人为空。中途登录 `429` 后复用了原草稿。[重试记录](/private/tmp/srvf-t36/required-resume.log) · [数据库终态](/private/tmp/srvf-t36/db-final.log)

证据足以把**本次实际停点**定位在前端审核页。必填场景的后端批准、发布后 #1416，以及完全未配置指标的场景均为 `NOT_RUN`。如果首发范围包含必填指标，当前仍缺一次页面独立审核发布验收。

## 4. 公网、授权、Worker 与退役

- **公网业务 `NOT_RUN`。** 核对到的公网运行 revision 仍是 `108feebb…`，健康检查返回 `200`。本轮没有合并 #1444，也没有切换公网流量。候选本轮新增 `GRANT=0`，隔离库使用的 ACL 不能计为候选授权。[公网配置](/private/tmp/srvf-t36/public-config.log) · [健康记录](/private/tmp/srvf-t36/public-health.log)
- **Worker 证据限于隔离栈。** 两条意图各尝试一次，由待处理转为成功，隔离 Worker 随后正常停止。该结果覆盖内部消费，不覆盖外部服务送达或公网 Worker 在线情况。退役记录保留了导出摘要。[Worker 记录](/private/tmp/srvf-t36/worker.log) · [退役记录](/private/tmp/srvf-t36/retired.log)

## 5. 实际 diff、迁移兼容与回退

**后端修复范围与 T35 故障相符。** 业务源码涉及六个文件，覆盖 DTO、错误码、Simple 草稿确认、审核配置、提审事务和管理端控制器。完整 PR 还包含测试、重新生成的接口契约及此前 T34 的试运行工具和文档，人工审阅须看完整 diff。该补丁将确认提审行为移植到 `108feebb…` 基线，未整体引入 #1404。PR HEAD 与运行基线的迁移树相同，均为 `9010ebb00fd38a493f6d122063dd7492031d8cb5`，共 156 项。[完整 PR diff](https://github.com/BA7IEE/srvf-nest-api/pull/1444/files) · [补丁文件清单](/private/tmp/srvf-t36/name-status)

回退边界清楚：可恢复旧后端镜像，无需逆向迁移。恢复后首发前端会再次遇到 T35 的确认提审不兼容。切回镜像也不会撤销已经提交的业务状态、审计或已消费意图。本轮没有公网部署，现场镜像回退为 `NOT_RUN`。

## 6. 人工 gate

精确 SHA、实际 diff、开发验证、独立审查、影响范围、回退边界六项均已具备，可供维护者审阅。定向单测 `49/49` 通过；本地契约测试在全局初始化阶段退出，定向 E2E 在容器准备阶段退出，两者均未执行到用例。复核时，GitHub 快速检查、golden journeys、diff guards、Docker 构建已成功，仍有契约及 E2E 等检查运行中。红区扫描和汇总成功，人工审批步骤显示 `skipped`。这些状态均不能代替维护者的合并决定。[CI 运行](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44543534151) · [定向单测](/private/tmp/srvf-t36/unit.log) · [本地契约日志](/private/tmp/srvf-t36/contract.log)

受本会话只读沙箱限制，未写入 `/private/tmp/srvf-t36-independent-review.md`。本回复为完整独审正文。

**CONDITIONAL_PASS。**