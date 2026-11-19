# T29c 隔离验证与审批边界

运行源码 108feebb84b85c7e4955c5af8bbfc016702e4529。候选端只读采样有效权限。候选实施 NOT_RUN，新增授权 0。

**A 目录工具**可单独送审，沿用 T29 reconcile.sql 与原材料校验清单，范围为更新、发布、结算终审三码及对应三个预置角色的映射。恢复目录后仍需独立的业务主体授权。此卡不包含 PG 权限。

**B V3 活动链**可单独送审。五表八组共 130 个“列 × 权限”差额。grant.sql 与 rollback.sql 为本卡唯一授权与撤权清单。未纳入其他模板、结算或全库盘点差额。

|表|相对基线新增|
|---|---|
|Activity|INSERT 30，UPDATE 29|
|ActivityRuleSnapshot|INSERT 10，SELECT 10|
|activity_responsibility_assignments|INSERT 12，SELECT 13|
|notification_outbox_intents|INSERT 14|
|role_bindings|INSERT 12|

复制有效表列权限后，用非所有者、非超级用户运行 Nest 业务服务。实验所有者仅装配模板、测试主体、目录和角色夹具，执行对账及权限管理。固定 V3，shadow，V1.1=false。普通发起人创建后指标为 not_required、revision=1；初审 pending；另一名本组织审核人批准后活动 published。该审核人替发起人提交变更收到 30100；原发起人提交后为 change/pending。这里验证的是他人活动上的操作，未覆盖跨组织和公网 HTTP。

在一次性 PG16 执行 python3 run.py，exit 0。trace.sql 记录业务连接 SQL，不含绑定参数。column-proofs.json 逐项记录从完整拟议集合单独去掉一项时，在原本可规划的真实 SQL 上取得 42501，共 130/130。随后执行完整 rollback.sql，新建调用被拒；历史活动仍为 published，两个审核记录的 ID、类型和状态一致，五条审计记录计数一致。未逐条比对审计内容。实验容器随运行退出清理。

共享运行角色取得的是列权限，数据库不按测试账号或活动行隔离。尤其 role_bindings 可新增绑定，outbox 可新增待投递意图；撤权保留此前写入的绑定、草稿及待投递记录。实施前需按操作标记核对并安排正常退役、投递隔离。正式部署由数据库权限契约维护方版本化交付，逐环境核对源码、角色、基线和集群标识。T29b 记录的候选控制面 off、缺模板和创建码仍是独立的业务前置条件；本卡不批准启用开关、配置模板、分配业务角色或公网执行。

复现需在固定版本的临时归档中准备项目依赖与 Prisma Client，将归档绝对路径写入 srcpath；实验材料中的 acl.jsonl 是复制有效权限所用的只读快照。执行目录中保留同名文件。SQL 材料指纹见 SHA256SUMS。
