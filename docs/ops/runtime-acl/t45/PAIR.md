# 冻结配对与试验回退

沿用 #172 的静态文件、#1444 的 API 镜像 `sha256:826cd1241eef6e31d3925d4af80b2d1b6830c687d2cc37b67c1123fb9a433f75`。隔离 PG 为独立 tmpfs，156 个迁移，API 与 PG 没有宿主机端口；账号、活动、二维码均为本批合成夹具。短信、企微、微信外发预检均为 false。[配对复核](pair.log) · [前置身份](identity.json) · [外发开关](outbound.json)

## 复用装配

在同型 T45 一次性服务器试验目录中放入 acl.py 和三个 *-contract.json。逐一使用独立核对的 cluster ID。入口校验隔离目录与网络、API 镜像、tmpfs、迁移数、非所有者身份、目标表及固定清单 SHA256。preview 回显当前有效权限与缺口，apply 仅补缺口，在事务提交前持久化精确回执。相同清单可重复 apply。withdraw 只撤回本次实加项并原子复核既有项。保留同一目录中的回执；收到部分状态或清单摘要不匹配时停止。

```sh
python3 acl.py preview read --expected-cluster "$verified_trial_cluster"
python3 acl.py apply read --expected-cluster "$verified_trial_cluster"
python3 prove-reads.py "$verified_trial_cluster" read
```

read 适用于本次尚无官方时长切换回执、无结算 run 的读面。仅在全隔离 V1.1 测试进程中另外装配 ledger-on 读面或 punch 首次签到，并用相应回执验证。三个包分别撤回，撤回后 preview 的现有与缺失列集合须逐项匹配初始状态。[读面清单](read-contract.json) · [新轨计数差额](ledger-on-contract.json) · [首次签到差额](punch-contract.json) · [撤回后预检](restored-acl.jsonl)

## 本次退役

成功签到后通过负责人接口作废二维码。事务审计和打卡事件通过相同请求 ID、活动、事件和发起人核对。撤回三包后，再次访问两条读面均回到 500，普通队员拒权仍在，已提交的事实与审计保持相同。接着撤回 T44 报名前置装配及其组织写保护。内部 Worker 在相同测试配置下排空本站意图并停止；封存合成审计仅保留摘要作为证据。此前关闸的 API 容器始终停机，新轨写过事实后直接退役整套一次性栈。共享候选运行配置和公网路由未触碰。[业务核对](punch-after-withdraw.jsonl) · [Worker](worker.log) · [退役](retired.log)

候选部署及回滚仍沿用原维护者决策与固定配对。数据库中新产生的考勤事实需单独对账，不能用回退镜像或撤 ACL 当作数据回滚。[T44 配对记录](https://github.com/BA7IEE/srvf-nest-api/blob/860533d1425d5f7c38dddf8641bc8df2f98ffa3a/docs/ops/runtime-acl/t44/PAIR.md)
