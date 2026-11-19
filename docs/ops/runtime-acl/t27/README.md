# T27 活动审批及更正详情审查材料

**整链暂不建议发卡。** 服务源码 108feebb84b85c7e4955c5af8bbfc016702e4529。候选只读，本轮共享 ACL 写入零次。隔离 PG16 使用该提交真实迁移、同 schema 生成的 Prisma 客户端和 Nest 服务。普通 USER 编入指定非根组织，另一独立 USER 作为负例。根据 snapshot.sql 现场读取 public 普通表的有效列/表 SELECT、INSERT、UPDATE、REFERENCES，等效授给隔离运行角色；该复制仅用于本次调用。原始权限快照不含业务行。

| 路径 | 隔离服务结果 | 证据边界 |
|---|---|---|
| 普通队员草稿与详情 | 成功 | 复用 T26c e436aa52f95655b3e9b9e1caf1d951bf9de54d77 的 26+7 作为实验起点 |
| 非发起人改同一草稿 | 20001 | 第二个真实隔离 USER，目标未改变 |
| 发起人修改标题 | 在 26+7 上 PG 42501；另补 Activity UPDATE(title,updatedAt) 后成功 | 现有 UPDATE(id) 保留。实际 SQL 包含 FOR NO KEY UPDATE、修改、审计与详情。撤回两列后同路径再次被拒，原标题保留 |
| 发起人配置活动指标 | 30100 | 正常 ActivityMetricSelectionService.select 在 app 面要求 activity.update.record。候选权限目录查询该码 0 行、关联角色 0 个。普通帐号无法通过正常角色分配获得该码 |
| 提交初审 | 20174 活动指标选择无效 | 当前活动未有有效选择。核验 review 行数 0，活动仍为 draft。直接更新指标选择字段会跳过正常应用判权 |
| 审核发布、#1416 已发布变更正向和跨对象 | NOT_RUN | 没有已走完前置规则的发布对象。草稿跨主体负例仅归入草稿路径 |
| #1417 更正详情 | 实际服务返回 HumanCorrectionAuthorityUnavailableError | 普通 Prisma 连接调用 detail 首句即校验受信连接，尚未访问业务任务。既有任务正向、错误资源及跨对象 NOT_RUN。结算更正写入另受 V1.1 门禁。未装配受保护调用方或伪造任务 |

候选核验活动责任制为 true，作用于整个候选 API，V1.1 为 false。恢复文件 /var/tmp/srvf-t26b.fMwTQBTr/restore.sh 经 sh -n，enabled.sha 校验现行 Compose 通过，原配置 SHA256 为 ffb34312c222c68a6d2d65b114672a48ae88a78bc639f82cb9ada2cecf791c59。恢复运行和恢复后健康 NOT_RUN。短信、企业微信消息和微信订阅三条已知真实通知出口按开关、提供商及配置组合均为 false。未发送通知。member.bind.account 内置码删除受限，本批未改目录。

两个部分 SQL 仅用于审查已走通的草稿和修改路径。隔离库使用精确库/角色名验证重复实施、重复撤回及 UPDATE(id) 保留。实施前后须留存直接 ACL 来源与 grantor，撤权须与实际新增回执相匹配；若其他作业同时改变权限，应停止自动撤权。共享角色获得的 UPDATE 可改其他活动的标题和更新时间，责任人 SELECT 对该角色的全部连接可用。撤权不能恢复已改标题，按标记盘点实际写入；若返回失败仍须先查草稿与审计再重试。T26c 已证仅补 INSERT 时详情失败仍留下草稿，本次初审失败保留此前成功的草稿修改。所有 T27 实验业务数据随一次性实例回收。

正式修复归属分为三处：部署权限目录维护方修复受保护目录的定向装配与回退；受信更正作业维护方提供可验证的正式调用身份；数据库部署契约维护方在上述条件满足后补全后半程实际投影并一次审查。部分 SQL 不包括发布、结算、Organization INSERT 或未观测字段。现有材料不支持直接审批整链。

复核驱动 run.py 读取 srcpath 中指定的固定版本源码归档和 acl.jsonl，只在独立容器内迁移及授予实验权限。候选采样命令使用 snapshot.sql、catalog.sql、site.sql。trace.sql 仅存 Prisma SQL 模板；validation.log 为服务结果及断言。所有业务验收结果均来自隔离环境，公网业务请求次数为零。
