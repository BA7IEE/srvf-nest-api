# 常规单场次活动试运行审批单

**建议批准一套独立、非公网的验收栈，供两名标记普通主体完成一次从创建到发布后变更待审的闭环。** 使用固定业务版本、一次性数据库和专用组织，仅测试客户端可访问。在线候选的 api、数据库、消费者和公网域名均在此实施范围之外。独立栈若要让人交互试用，须在该栈自己的入口落实访问限制；本包实际运行到本地 Nest 服务层，交互入口及公网验收 NOT_RUN。

## 实施边界

1. 版本固定为 108feebb84b85c7e4955c5af8bbfc016702e4529。创建一支标记组织、两名活跃正式成员及其 USER 账号。本地夹具密码字段不可用于登录。初始化操作者仅在独立库装配，业务调用使用非所有者连接。创建目录从固定源码的 ACTIVITY_PERMISSION_SEED 取 activity.create.record。授权策略允许自定义角色；单码发起角色 lab-scope-create 是测试专用。独立审核角色 activity-publish-reviewer 的权限码逐条来自同版本 RBAC_SEED_CATALOG。两次组织级 USER 绑定均在 trial.ts 明示，目录恢复与人员分配分开。候选若涉及账号授权须由有权的管理人经正规角色绑定入口处理。测试中发起人与审核人为不同 USER；发布前活动级绑定 0。
2. 合成模板由 trial.ts 中的完整 definition 生成。训练、一个场次、一个默认参与岗位、容量 2、first_come；显式选择 not_required，指标集指针为 null。模板 schemaVersion=3、version=1。用项目函数校验完整定义哈希 0d2438eabcd7e6e872b054c401879dec0be6eb97368b04ceb4bb52951a73781d，装配到一次性库内的独立模板家族。测试活动时间为 2099 年，不能作为实际招募模板。
3. 隔离试运行用 shadow，责任制 true，V1.1 false，Human 未启用。实测 shadow 支持创建、本人提交、独立批准发布和 #1416 change/pending。off 在创建阶段拒绝 20163。生产/smoke 模式下 active 要求 V1.1=true，当前目标用不到 active。shadow 作用于整台 API，前端受众控制仅影响入口展示。组织绑定限制本人的业务操作，其他已有权限的主体仍按自身授权调用；全局模板家族也可能被其他合格主体看到。因此现有公网共享栈不能承诺仅标记人可见。
4. 实验使用 T29c 固定证据树的候选 ACL 快照及 grant.sql/rollback.sql，仅在新 PG 中施加。五表八组共 130 项，精确列清单及逐列移除记录随引用固定。role_bindings INSERT 可写其他主体与范围，通知 outbox INSERT 可产生后续投递，列 ACL 无法限定标记活动。同角色的所有连接共享能力。实施边界只涵盖独立栈。正式部署角色契约由部署维护方版本化，关联 Draft #1442；正式权限目录、业务分配与模板发布仍由各自负责人维护。一次性库装配不能作为正式 seed 或迁移。
5. 独立栈从空数据启动，数据库只绑定本机回环端口。不得挂载候选数据卷、供应商凭据、共享队列或连接外部消费者。实验只调用业务服务，没有启动投递 Worker。创建/批准同键重试后数量不变，注入审批审计错误后状态与数量不变。发布后生成一个活动级 owner 和两条 pending 意图。逐项验证这些意图属于本活动或审核、零 attempts、无租约、未发送；若出现其他记录、在途或派生任务，断言失败，停止对外消费，按来源及发送回执另行对账。按事件键领取后使用 lease fence 置 dead，再领为空。不重放退役记录。
6. 退役时结束活动 owner 与两条组织绑定、禁用两名测试主体、退役模板。重复运行组织绑定/账号/模板退役的增量为零。实验保留 published 活动与 pending 提案作为历史至测试库销毁，不假造取消业务事件。执行精确 B 撤权、导出五条合成审计、停止并销毁一次性 PG 容器及 tmpfs。下次从空库重建，旧意图不能被新 Worker 消费。普通审核员替发起人提交变更得到 30100；本人变更为 pending。隔离实跑未覆盖登录、真实外发、生产恢复与完整 UI。

## 实际执行

在临时工作树使用已冻结安装、已生成对应 Prisma Client 的 node_modules，Docker 本机已有 postgres:16-alpine。repo 需要包含运行提交及 T29c 证据提交，可从仓库获取 ops/t25-runtime-acl-preflight 分支。运行者用新的输出目录保留 SQL 轨迹和隔离库审计。

    python3 run.py --repo /path/to/repository --dependencies /path/to/node_modules --output /tmp/srvf-trial-new

脚本从 Git 对象导出固定源码，创建带随机密码的一次性容器，打印脱敏结果。线上只读脚本 preflight.sh、worker.sh 和 page.py 独立执行。证据请见 verified.log、preflight.log、worker.log、page.log。页面标识按资源内容摘要记录；浏览器本地桥报 -1728，未登录浏览器进行页面操作。实际登录后的后台操作与前端 Git SHA 未验证。

[精确 SQL 与逐列验证](https://github.com/BA7IEE/srvf-nest-api/tree/6371d8c55874277e1e47a544b2bffe501b495776/docs/ops/runtime-acl/t29c) · [T30 试运行控制与原退役证据](https://github.com/BA7IEE/srvf-nest-api/tree/fb90a2d647d0af9c1f2c4d29673fa9f726180c42/docs/ops/runtime-acl/t30) · [T33 状态机独审及复现](https://github.com/BA7IEE/srvf-nest-api/tree/62d7fdde6f36a400723413a9097bc4ac7b976cfe/docs/ops/runtime-acl/t33)
