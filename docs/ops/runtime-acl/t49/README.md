# 本人参与账本的部署合同

**共享候选仍阻断包含“我的参与记录”页的 H5 部署。** T49 用只读预检重查了 `srvf_staging` 的 `srvf_dp_acceptance_runtime`。分页查询依赖 15 个列权限，候选已具备批次表 2 列，仍缺分录表 13 列。预检按预期退出 3。共享授权变更数为 0。[现场逐列回执](shared-check.json)

## 谁读取哪些列

队员登录后，服务端从当前身份解析 memberId，读取本人的分页账本及总数。查询关联批次，只返回已提交分录。部署合同检查 PostgreSQL 运行角色；普通队员的身份、组织和应用权限仍由服务逐请求判断。[固定版本的服务查询](https://github.com/BA7IEE/srvf-nest-api/blob/dd62ce308f9142e8b3be04e9c4d52f548c0ebb17/src/modules/activities/ledger-query.service.ts#L225)

| 表 | 该查询需要的 SELECT | 权限来源和实际差额 |
|---|---|---|
| `public."ParticipationLedgerEntry"` | `memberId, ledgerDate, serviceHoursDelta, creditedPointsDelta, postingBatchId` | T45 的 read 合同在隔离库增加这 5 列；共享候选缺全部 5 列 |
| 同表 | `activityId, resultRevisionId` | T45 的 ledger-on 合同在隔离库增加这 2 列；共享候选缺两列 |
| 同表 | `cappedOutPointsDelta, entryKey, entryTypeCode, participationIdentityId, recognizedPointsDelta, sessionId` | T48 隔离基线尚缺这 6 列；共享候选也缺这 6 列 |
| `public."LedgerPostingBatch"` | `id, statusCode` | 用于批次关联和 committed 过滤。共享候选已有有效表级 SELECT，两列直接列授权均为 false，本合同拟议新增 0 列 |

以上七列解释了隔离与候选差额。T43 处理报名写入、行锁和证据表，T45 为汇总和考勤补过读权。机器合同沿用 T45 的“表 → 操作 → 列”格式及摘要算法。本次隔离见证沿用 T43 的非所有者、事务、变更前后核对和撤回试验，源自旧轮次的写权限不进入账本合同。[T43 工具](../t43/assemble.py) · [五列回执](../t45/read-apply.json) · [两列回执](../t45/ledger-on-apply.json) · [机器合同](ledger-contract.json)

## 部署预检与复算

部署方先通过应用正常连接确认运行角色和库名，并用受信连接指向相同集群。第一条命令只读系统目录，输出目标库、角色、逐列有效 SELECT、直接列授权、表级权限和所有者身份。缺列、库名不符或角色不适合本合同都会得到非零退出。第二条仅从回执生成调整草稿；权限已齐时两份草稿均为空。

```sh
./check-ledger.sh srvf_staging srvf_dp_acceptance_runtime > current-acl.json
python3 preview.py current-acl.json --expected-database srvf_staging
```

在本仓工具目录运行下列命令可复核归档，或在有两份固定工具镜像的试验主机新建一次性 PG16。源码参数指向 #1445 的精确提交。脚本先核 migration、schema、角色夹具和分页方法摘要，通过私有 Unix socket 部署 156 条迁移，再以真实的非所有者登录运行查询。试验容器网络为 none、PG 数据在 tmpfs，完成后回收容器和专属 socket 卷。

```sh
python3 verify.py
./rehearse.sh /path/to/srvf-nest-api-at-dd62ce30 /path/to/new-trial-results
```

| 定向验证 | 结果 |
|---|---|
| 复制共享有效基线，按差额补 13 列；复制 T45 后基线，补 6 列 | 两组的默认 H5 查询、带 activityId 的分页和对应计数均 exit 0。两组分别只撤本次差额，基线逐列一致，读取再次以 42501 拒绝 |
| 15 列逐列省略 | 15/15。对实际 H5 默认分页，每次仅移除一列即得到 42501、psql exit 3；补回该列后逐次 exit 0。批次表的两次见证使用仅有两列 SELECT 的试验角色权限，排除了原表级授权的覆盖 |
| 范围外读取、写入及目标漂移 | 范围外批次 requestKey 和分录 UPDATE 的执行计划均被拒绝。两种完备基线指定错误库名时预检均 exit 3。离线草稿在批次列缺失时拒绝生成 |
| 业务证据 | T48 同 reqId 的 500/50000 对应 P2010、42501、ParticipationLedgerEntry。T48 隔离补齐后 H5 读回 200/0，撤回后恢复 500。本轮使用空的真实迁移表见证列权限，已结算非空账本、完整 H5 业务链、公网 H5、手机及微信均为 NOT_RUN |

`bash rehearse.sh …` 最终 exit 0，数据库报告 PostgreSQL 16.15。收尾检查匹配本次试验标签的容器和卷各为 0。`python3 verify.py` 复核试验、T45 实际增量、T48 事故及 B130 的 130 条证据，exit 0。[逐列与退出码](isolated-result.json) · [独立审查过的 T48 回执](../t48/independent-review.md)

## 将来若批准共享运行角色调整

当前提案只有一个角色、一张表、13 列 SELECT。新权会供所有使用该数据库身份的 API 或作业使用，可直接读取这些列中跨队员、跨活动以及未提交批次的分录。正常 H5 接口继续按本人和 committed 筛选。列内容涉及成员关联、场次、服务时长和贡献分值；共享身份的数据库能力边界应由部署方负责。B130 覆盖活动、规则快照、责任分配、角色绑定和通知 outbox，与本合同的表、权限、列交集为 0。[拟议 GRANT 与对应 REVOKE 全文](future-delta.json) · [B130 逐项记录](../t29c/column-proofs.json)

如将来实施，先固定目标集群、库、角色、业务 SHA、合同摘要、变更前逐列 ACL 和执行授权者。对同一角色的 ACL 变更串行，在事务内复核基线，只授予仍实际缺失且在批准范围内的列，回执记录实际新增列、授予者、提交结果与事后 ACL。重试先比对该回执与当前 ACL，已满足时新增为 0。若基线发生变化，应按实际差额重新生成草稿。

回退时，以**那一次已提交回执**中的实际新增列生成 REVOKE，由原授予者或依法有权的身份执行。先确认这批直接授权未被后续独立变更采用、依赖或替换，以默认 RESTRICT 在事务内撤权，再比对变更前后的有效及直接 ACL。隔离基线已具七列，按回执只撤新增六列。若将来在本次候选基线上实际新增十三列，对应回执应撤这十三列。两种情形都保留批次表原有授权、其他角色权限和历史数据。撤回后，本人账本页可能再次出现 500，需要配合恢复上一个可用 H5 档位。若提交结果未知，应先与 ACL、授予者和审计记录对账。固定草稿只适用于其基线摘要。

维护者可独立决定三个业务交付的合并。公网 H5 建议暂缓至运行角色合同落实并取得实机回执。[GATE 与一次设备接入说明](GATE.md) · [配对与回退](PAIR.md)
