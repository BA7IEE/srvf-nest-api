# E4 来源复用实施及验证记录

基线 `b7f5940434ba4b7084b998b4b86ae5b18af22ef2`；[Draft PR1380](https://github.com/BA7IEE/srvf-nest-api/pull/1380)。用户 `Sentinel_78d00b72fa5881918ba902157ccc9484` 已明确批准附件 `libfile_b2c74d8512d481918fb849db830afc91` 的47个精确路径整批实施、必要的精确代理grant、普通提交推送及GitHub独占临时PG16验证。授权不含最终SQL签字、trusted审批、合并、生产执行或放宽预算。

## 改动与等价目标

新增 `20261013000000_activity_contribution_assert_source_reuse`（143），仅替换 `public.e4_assert_complete(text,boolean)`。完整SQL SHA256：`e1403f8aefb8e41bf050b4355551c42f3c7a889723782ce4b362ffc740c1d15b`；静态正文MD5：`59a9bc7d7c0c3b38df982536a2632b15`。服务和精确pin回归同步更新，不接受旧新二选一，也不从live DB学习pin。旧1–142不改。

非unchanged_time分支内，来源合法性检查与expected全集比较共用同一SQL作用域的关系型MATERIALIZED来源，不构造JSON/数组缓存，不跨调用复用。expected构造复制140最新版，其余canonical快路保留。来源非法时CASE阻止expected/day构造。原错误优先级、SQLSTATE、constraint、消息与cast/溢出保持；FULL JOIN/IS DISTINCT FROM、排序、全文哈希、规模限制与全部前后检查保留。public来源/expected函数、所有触发器、OID/owner/ACL/default/security/search_path不改。

137固定前缀显式接受143后继；142历史测试固定deployUnitMigrations，不误跑当前143。30份CURRENT_MIGRATION_COUNT仅142→143。CI仅新增离线前缀回归一步，不改workflow权限、secret、环境、审查或合并门。

## 证据与验证状态

既有run38457728710业务prepare在诊断预算内39.656秒，事务39.361秒，COMMIT1/ROLLBACK0，完整oracle与正常清理。E4评价写入14.347秒（INSERT13.765秒）与屏障9.869秒不重叠，占事务61.5%。计划观测UNKNOWN/LOG/OUTPUT，不把观测失败说成业务失败；来源展开单独成本尚未测。

新增回归覆盖非空142→143、noop、全部业务行/目录/trigger/constraint/index/旧checksum保留，冻结独立根哈希/来源分母/跨日oracle，真实来源链→评价→根双错顺序、最终版本/result校验、真实INSERT后独立deferred失败与全事务回滚、观察到实际锁等待后的同语句快照及下一调用新可见性、143真实prepare/submit。

未解析来源与day构造双错用私有SQL函数副本及一个NULL来源字段/固定异常构造器测试；不改变公共函数或绕过前置数据库guard。它验证SQL控制流，不声称真实业务可持久化这种无效来源。完整现有并发与正式满额测试交由GitHub既有五分片；原2000 identities /10000 segments /50000 slices /8000 units和事务30秒标准保持。

当前轻检查：前缀10项PASS；首审服务72项PASS；完整类型检查与定向lint最终PASS；readtax/counts/codemap/authz/migcount检查PASS。47路径边界核验PASS，30个e2e仅计数变更，旧142份迁移字节及完整guard前后段保留。所有新SQL、迁移、e2e、正式满额GitHub结果为NOT_RUN，等待本次提交后的真实运行；无本地DB重测试。

## 收口边界

CUTOVER_SIGNOFF仍签历史136而实际目录143，不借用旧签字、不代填。trusted审批留给维护者，不代点批准。最终SQL签字、主干合并、生产迁移/部署、业务标准修改均本次未做。额外诊断、SQL_LENGTH5缺口与工作流扩建不在本批。结束核对并撤销仅本批4项grant，其他授权保留；GitHub失败如需清单外改动则报告精确阻塞。
