# 共享运行角色的账本只读边界

含本人账本的共享候选 H5 部署仍为 BLOCK。共享候选维持既有授权。本轮验证使用未连接业务网络的一次性 PostgreSQL，完成后释放试验容器。

若以后需要投用，审批对象为已核验集群的 srvf_staging 数据库和 srvf_dp_acceptance_runtime 角色。本次保存的 T49 基线中，public."ParticipationLedgerEntry" 缺以下 13 列 SELECT。

`entryKey, postingBatchId, memberId, activityId, sessionId, participationIdentityId, resultRevisionId, ledgerDate, entryTypeCode, serviceHoursDelta, recognizedPointsDelta, creditedPointsDelta, cappedOutPointsDelta`

public."LedgerPostingBatch" 的 id 和 statusCode 已可读。T45 隔离装配先行具备七列读权，因此在那套独立装配上差六列。复核时须固定实际集群、数据库、应用运行角色和当时有效 ACL，保留逐列回执。此次加固也会验证该角色的数据库 CONNECT 和 public.USAGE。这两项缺失时预检返回非零，即使逐列 SELECT 均已具备。若由运维账号代查，回执的 observer_is_runtime 为 false。

同角色的所有进程都能直接读取覆盖多名队员和多个活动的上述数据，包括未提交批次关联。正常 H5 查询依赖本人身份校验和已提交批次过滤。拟议授权仅限基线上确实缺的列，表级 SELECT、写权限、B130 以及公开部署都在范围外。将来如实施，记录同一事务实际新增的直接授权，仅对本次新增执行对应 REVOKE。有效权限来源或依赖变化时重新核对。保留业务行、审计及原有角色授权。公网流量、实机和非空业务账本保持各自验收状态。

[T49 共享采样](https://github.com/BA7IEE/srvf-nest-api/blob/669fe55c9473a30a7a67d94f9ed0a7ba2d07372b/docs/ops/runtime-acl/t49/shared-check.json) · [拟议差额和回退](https://github.com/BA7IEE/srvf-nest-api/blob/669fe55c9473a30a7a67d94f9ed0a7ba2d07372b/docs/ops/runtime-acl/t49/future-delta.json)

T49 同次只读采样还记录了两表 RLS 均为 false、各自策略数为零。批次的 SELECT 来自直接角色授权。T48 非公网 H5 在隔离基线补齐后通过本人参与记录读回，撤回后再现失败，已结算的非空账本仍待验证。[T49 行级范围](./t49-row-scope.jsonl) · [T48 非公网证据](https://github.com/BA7IEE/srvf-nest-api/tree/a66932f4eb68ab4a140ba0702de4607937ccf61c/docs/ops/runtime-acl/t48)
