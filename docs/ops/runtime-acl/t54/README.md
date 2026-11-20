# T54 结算终审到 H5 本人账本

修复在 [#1447](https://github.com/BA7IEE/srvf-nest-api/pull/1447) 的提交 [65d1d6ea](https://github.com/BA7IEE/srvf-nest-api/commit/65d1d6ea4caaa815faac0e79ead8846b6cc3ade9)。旧库的普通终审在 COMMIT 时因调用受保护更正函数而失败。仅区分函数调用仍不足，真实角色还无法读取更正证明。两份追加迁移分别隔开受保护调用，以及在行可见性允许时提前识别无关联申请的普通批次。关联更正继续执行原完整性校验。原迁移与角色权限未在产品代码中修改。

srvf 的内网试验以同一项活动完成升级前后终审、过账 Worker、关账、H5 本人两条记录和他人零条。匿名 401、普通队员越权 403、隔离撤权后账本 500，各项均有回执。两条新增分录累计 0.67 小时、1.5 分。上游是合成历史考勤。隔离数据库另为实际 Worker 与关账查询准备了相应列权限，成员没有新增业务角色绑定。共享授权为 0。公网、实机、微信、正式安装均为 NOT_RUN。

[同活动状态、HTTP 与逐请求审计](journey.json) · [隔离关账与 Worker 列权限差额](isolated-only-acl.json) · [迁移与回滚实证](migration-evidence.json) · [逐字节复核两处函数变化](verify-function-delta.py) · [原生受信回归回执](native-correction.json) · [原生 CI 明细](ci.json)

## 最终 SHA 的原生 CI 与受信更正

GitHub 在 2026-11-20T08:14:36 UTC 报告 16 个成功检查，红区审批为 **SUCCESS**。该提交已获红区批准，独审与部署状态单列。新 SHA 的独立审查待开发返回后由原会话串行执行。

| 非所有者场景 | 判定与证据 |
|---|---|
| 普通终审、过账、结案、本人 H5 新增 | **PASS**，本批 srvf 隔离现场；同一活动升级前 500、升级后 200，同活动有数据库回执。[新增事务提交回归所在原生分片](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44696120601/job/136153355336) |
| 合法受信更正 | **PASS**，该 SHA 的 Authenticated Human V3 使用真实 PostgreSQL 身份和 HTTP 业务链。D7 用例执行提交、退回重提、审核、prepare、commit，断言 HTTP 200、application committed、correction applied，并验证重放。四个原生套件均 exit 0。[业务链断言](https://github.com/BA7IEE/srvf-nest-api/blob/65d1d6ea4caaa815faac0e79ead8846b6cc3ade9/test/e2e/activity-os-r4-d7-time-correction.e2e-spec.ts#L2859) |
| 普通或未受信身份误用更正 | **PASS**，srvf 的普通 API 连接收到 SQLSTATE 42501；独立 CI 实例另证未受信 provider 拒绝，实际普通连接身份核验通过。 |

第 1 次原生运行中，2,000 人的账本 prepare 在 60 秒事务上限下用时 66.183 秒，Prisma P2028，HTTP 500/50000。失败发生在该活动创建过账批次之前。随后只重试失败作业和汇总，同一 SHA、同一负载、同一时限和断言通过。该准备操作的总耗时在 T53 为 8.908 秒，本次首轮 66.296 秒，复测 9.820 秒。首轮与复测分别有 63.914 秒、7.848 秒处于 Prisma 请求中，具体数据库或主机原因仍未证实。[三次原生诊断计数](ci-attempt1.json) · [首次失败](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44696120601/job/136153355396) · [原生复测](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44696120601/job/136161756937)

普通活动走 srvf 隔离栈；受信更正使用该提交的 GitHub Actions 专用隔离实例，未为 srvf 部署受信更正通道。原生 CI 源工件号为 `14611117220`。[受信作业](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44696120601/job/136153355319) · [精确红区作业](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44696116951/job/136153250156) · [原生检查](https://github.com/BA7IEE/srvf-nest-api/pull/1447/checks)
