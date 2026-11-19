# T38 活动变更与并发提审

**隔离服务器 PASS。** 普通发起人在一份申请中修改标题和活动说明。独立审核人在真实页面核对四个值后批准，发起人刷新后看见两项新值。最终活动为 published、流程修订 2，库内仅一份初审和一份变更，两份均已批准。公网认证后业务 NOT_RUN。

## 普通身份与实际结果

最终活动 ID 为 cmwnpj1d60021lc01glbd0w3t。发起人与审核人均为普通 USER，沿组织范围创建和审核职责工作。两个独立浏览器上下文登录的是同一发起人，编辑方从浏览器通过现有 App PATCH 保存草稿说明。提审、初审、发布后变更及其批准均操作真实页面。

| 场景 | HTTP / 业务码 | 状态与判定 |
|---|---|---|
| 从无需指标的 V3 Simple 模板创建 | 201/0 | PASS。模板创建后才取得该草稿 ID |
| 编辑与提审交错 | 编辑 200/0，旧提审 409/20255 | PASS。测试驱动在前端完成最后一次读取并发出 POST 后暂停转发；等另一上下文的修改提交后，原样放行。服务器拒绝过期确认，页面显示版本变化。无对应成功业务审计，DB 未多出初审行 |
| 新会话按实际新版本重新确认，独立初审发布 | 200/0、200/0 | PASS。浏览器断言两次提交的草稿摘要不同。批准 reqId cmwnpj654520ae9a72c19d2fb38e69dca 对应审核人审计 |
| 发布后两字段变更 | 申请 200/0、批准 200/0 | PASS。页面提交的 activityPatch 恰有标题和说明。冻结基线与目标均匹配；审核页显示两项的旧值和新值。批准 reqId cmwnpj8hvf72e8237cd3a1fb082f19971 与审核人审计、最终数据库字段、发起人页面读回一致 |
| 同一份详情额外出现容量差异 | 浏览器拦截测试，批准请求数 0 | PASS。页内显示无法核对的字段，禁止批准。恢复服务器真实响应后完成上述合法批准。该负例未写入数据库 |
| 审核人代替负责人提变更 | 404/20001 | PASS。服务按对象隐藏合同拒绝；无对应成功审计 |
| 站内 Worker | 进程退出 0 | PASS。含开发验证和最终构建两份活动，广播 2 条、定向 4 条，各尝试 1 次，全部 succeeded。退役时积压 0，合成审计导出权限 0600。短信、企微、微信出口关闭 |
| 公网 | 正规 ready 200，当前 JS 指纹匹配 | 仍运行旧配对。公网业务、切换与回退演练、供应商外发及真人开放 NOT_RUN |

本批选取现行 DTO 与在线 OpenAPI 均明确支持的 title、description，两个标量共用已有 V7 变更审核事务。当前页面可识别这两项以外的差异并阻止批准。场次、岗位、时间、容量等多字段组合的真实审批 NOT_RUN。必填指标单布尔、五类共存和未配置负例沿用 T37 独审覆盖；本次新增多字段闭环用 not_required。其他指标组合与两字段的交叉测试 NOT_RUN。本次确定性调度的是请求到达服务前的先后顺序，未观测 PostgreSQL 内两个事务同时排队等锁。

## 源码交付、复审和可逆部署六项材料

1. **源码与目的地。** GitHub 实时显示原前端业务仓为 PUBLIC，其 AGENTS.md 第 35、53 行要求私有。我选择同维护者的 PRIVATE 仓 srvf-test-archive，将实际前端基线分支 frontend/base-6375148 与业务分支 frontend/simple-review 建成源码 Draft PR #2。GitHub compare 显示仅有两项提交，第一项正是 T37 原始 40ec9d7c0bc77cb6dc4a849071c081479e3cf055，第二项为 T38 eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64。基线 6375148a61445972e792ce37cb401fd8e5162538，T38 源码树 43fbfef8080b7958d3a0ea448b521f749ac258a8。这条私有分支可以继续常规提交、审查、取回。原材料 Draft #1 留作历史证据。[私有源码 PR](https://github.com/BA7IEE/srvf-test-archive/pull/2) · [固定前端源码](https://github.com/BA7IEE/srvf-test-archive/tree/eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64)
2. **实际改动。** 负责人表单仅发送发生变化的文本，发送前重新读取身份、职责、原值和待审状态。审核页逐字段展示冻结的前后值，其余快照字段继续做完整比较。既有版本确认、判权、数据库和审批流程均沿用。后端固定在已独审的 713d3416830d897852929731ff7f9b638038ab7c。[T38 前端增量](https://github.com/BA7IEE/srvf-test-archive/compare/40ec9d7c0bc77cb6dc4a849071c081479e3cf055...eb587bd2c82a96cd1b6fc77ae428ae7d894fbf64) · [后端 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1444)
3. **回归可复现。** 前端 tests/render/simple_freeze_server.cjs 已入上述私有源码分支，新增 text_change_race 场景。它在隔离 Chromium 内用真实登录和服务请求覆盖并发、两字段和额外差异拦截。后端草稿摘要锁内复核在 activity-simple-draft.service.ts，测试在同模块的 .spec.ts。定向开发时发现 TypeScript 对冻结说明的类型收窄不足，修正后最终 lint、typecheck、build、提交钩子通过。harness 回归 82 项通过。命令、exit、请求与审计映射见 commands.tsv、final-browser.log、correlations.json、readback.log。
4. **检查与独审。** #1444 再核仍为 713d3416，实际运行 14 项全绿，含五个 Contract + E2E 分片。人工 Red-zone trusted approval 为 SKIPPED，没有待处理 review thread。私有前端 PR 当前 GitHub 检查为空，归档仓 API 返回已登记 workflow 数 0；远程前端 CI 为 NOT_RUN。前端沿原 CI 运行的本地守护、lint 后零漂移、类型和构建均通过。T37 独审判定覆盖至 40ec9d7c；T38 新前端 SHA 待独立会话复审。[后端固定 CI](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44548708050) · [T37 独审证据](https://github.com/BA7IEE/srvf-nest-api/tree/21a495c7c1509d6fbe57e65d8861f87075314dfa/docs/ops/runtime-acl/t37)
5. **配对与影响。** 服务器保留 T38 静态产物和后端镜像。verify-pair.sh 已逐项验证完整新静态清单、两份 OCI revision、原站点静态入口、原配置、四处上游及 OpenResty 自检。共享 B130 未批。共享候选本轮新增 GRANT=0。隔离 PG 非所有者身份、156 个迁移，公网配置和模板与隔离栈有差异。详见 PAIR.md。
6. **回退。** T38 执行前的公网配置已在服务器留存 mode 0600 副本，SHA256 与原文件一致，可找回原前后端配对。退役时只处理本次生成的四个容器、临时数据库、内部网络和测试登录文件。合成审计 SHA256 为 89dea4a3f4defa69d8253d1070fdc0dd6d5a496ed7faf60088abe0e3a22371f8。退役后再次执行配对核验 exit 0。公网部署还取决于适用的授权、版本与装配；本次无合并或公网变更。
