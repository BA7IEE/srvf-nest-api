# T35 服务器页面验收

**首发阻断已复现。** 使用公网实际静态目录的只读挂载和运行中的同一 API 镜像，在 srvf 内部 Docker 网络上经真实 Chromium 输入两个普通 USER 的独立登录会话。页面发起的是 Simple 模板创建。创建、读回成功，版本确认提审失败。当前部署组合无法从页面到达待审核，故本批未形成发布闭环。

| 操作 | 结果 | 证据 |
|---|---|---|
| 公网 dp.srvf.team 首屏及健康 | PASS，真实 Chromium 到 #/login，出现密码框和登录按钮；正式 live/ready 均 200 | public-page.log、public-health.log |
| 服务器隔离发起人及审核人页面登录 | 两次 200/0，各自 /me、effective-permissions 成功。活动列表分别显示和隐藏创建按钮；系统字典后台读均 403/30100 | ui.log、final-db.log |
| 发起人选本组织、单场次模板、标题、日期、地点，创建 | POST from-template 201/0，详情 GET 200/0。创建 reqId cmwnmmzfq19dc20935681f3810ee26ebb 与 audit_logs 中相同，成员关系、draft、revision=1 均读回 | create.log、final-db.log |
| 本人核对勾选并确认提审 | **FAIL**。POST publish-reviews 两次 400/40000。定向复核 reqId cmwnmrv8u026419b1b3db58cdbc2ce8b0；请求字段 confirmation、expectedDraftHash、operationKey，响应明确点名 expectedDraftHash；审核记录 0 | confirm.log、final-db.log |
| 独立审核员批准、发布后本人提交 #1416 变更 | NOT_RUN，缺待审及已发布对象。独立审核员仅有种子目录规定的组织级审核职责。发布后 App 入口页面仍未验证 | final-db.log |
| 指标 | not_required V3 模板初始选择和草稿读回 PASS，提审 FAIL。required 需要有效指标集及版本指针，页面创建/发布均 NOT_RUN。未配置属于缺少选择 | 模板定义 hash 0d2438eabcd7e6e872b054c401879dec0be6eb97368b04ceb4bb52951a73781d |
| 隔离 Worker | 同 API 镜像运行 notification-outbox-worker，观察到通知和活动两个循环启动，观测窗内无 ACL 错误。队列 0，任务处理及供应商投递 NOT_RUN | worker.log、final-db.log |
| 公网认证后最终业务闭环 | NOT_RUN。同版本隔离页面已经失败，公网仍为 true/off/false，模板与创建码均 0；未变更公网路由、共享权限或配置 | public-config.log |

**部署身份。** 公网 OpenResty 的 dp 站点 root 指向 releases/b7f3dac00a860e32c0cbc220f29da0755bce024b/webroot；GitHub 可解析该前端提交。入口包 index-B9y9s-Nz.js 的磁盘 SHA256 与公网此前取样一致，为 28cd1e9ad7eb6c5ae7dc28d3c364b8f61671729c503ee8bfa228b3c5dc8b86fd。未取得可重现构建签名。普通用户本次从这套后台页面真实登录；独立 H5 部署版本 UNKNOWN。API 源码 108feebb84b85c7e4955c5af8bbfc016702e4529，镜像 1eb4e3ca…，完整 ID 见 final-db.log。隔离 PG 156 项迁移，按 T29c 有效 ACL 副本和 130 项差额装配，API 用非所有者；共享候选新 GRANT=0。无预绑 owner。

**版本缺口。** 部署前端的 simple/review-state.ts 构造 expectedDraftHash，交接合同明确要求保留版本确认。108feebb 的 AdminSubmitSimpleActivityReviewDto 仅接受 operationKey 和 confirmation。已有后端 Draft #1404 加入该字段及锁内确认保护，head 为 53d2de0d9d26341a9605fdb002a3fcab5fd7143e，base 为 fix/activity-r04a-review。该 head 与运行版迁移树不同；同版本修复上线和同场景复测 NOT_RUN。本轮没有重复开前端修复 PR。[后端 Draft](https://github.com/BA7IEE/srvf-nest-api/pull/1404) · [前端交接契约](https://github.com/BA7IEE/srvf-admin-web/blob/b7f3dac00a860e32c0cbc220f29da0755bce024b/tests/fixtures/simple-review.candidate-contract.md)

**执行与退役。** 服务器私网 docker network create --internal、同版本 tools 执行 prisma migrate deploy、组织夹具装配、浏览器登录、最后的 curl 健康检查和 DB 对账 exit 0。首次浏览器创建步骤点击隐藏 checkbox 超时 exit 1，已从同一份草稿恢复，点击可见标签后取得真实 HTTP 错误。confirm.cjs 收集响应 exit 0，业务判定 FAIL。隔离栈未发布宿主端口；消费者已停止，未发送意图 0。在受限服务器目录保存合成审计，将临时容器、内存卷、网络及生成的凭据文件退役，exit 0。retired.log 留有审计导出摘要。现场验收停在固定组合的接口不兼容。
