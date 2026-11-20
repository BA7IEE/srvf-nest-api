# T48 独立只读审查

**非公网配对验收 PASS；共享候选部署包含本人账本的 H5 仍为 BLOCK。** #1445 的红区等待已解除。隔离栈的发布、严格保险报名、图片签到和读回均通过；共享候选运行角色缺少账本查询所需的 13 列 SELECT。本次只读重算了固定回执，断言通过。[固定证据树](https://github.com/BA7IEE/srvf-nest-api/tree/a66932f4eb68ab4a140ba0702de4607937ccf61c/docs/ops/runtime-acl/t48) · [复算入口](/private/tmp/srvf-t48/receipts/verify.py)

| 审查项 | 独立判定 |
|---|---|
| **红区与版本** | GitHub 实时返回 #1445 HEAD `dd62ce308f9142e8b3be04e9c4d52f548c0ebb17`，仍为 Draft、未合并。T47 等待的同一作业 `136061481394` 现为 `completed/success`，该 SHA 的红区条件已闭。[PR](https://github.com/BA7IEE/srvf-nest-api/pull/1445) · [红区作业](https://github.com/BA7IEE/srvf-nest-api/actions/runs/44667827144/job/136061481394) |
| **非公网业务链** | 本轮在最终配对上完成管理端独立发布。严格保险开启，有合成团险的普通队员报名 `201/0`，从 H5 图片入口签到 `201/0`，随后读回本人在场。签到 reqId `cmwogsl54ec9218bd3037f0db9fcbb513` 与审计操作、事件、本人、活动及开放时段联查命中 1 条，错 reqId 对照为 0 条。T47 提出的最终轮审计关联缺口已由新实测补齐。[业务回执](/private/tmp/srvf-t48/receipts/trial.json) · [联查 SQL](/private/tmp/srvf-t48/receipts/audit.sql) |
| **备份与回退** | 合成库备份已恢复至新空库，业务、审计投影及账本 ACL 对账一致。隔离服务实际退回旧配对，H5 显示“服务尚未接通”、API 调用为 0。恢复最终制品后，原队员重新登录并读回原签到。该次浏览器读回连接的是**原隔离业务库**；新恢复库完成的是数据与权限核验。[恢复回执](/private/tmp/srvf-t48/receipts/trial.json) |
| **账本部署阻断** | 诊断复测 reqId `cmwogvx1rd15c390e3f51be894bf4ed5b` 同时对应 `500/50000`、Prisma `P2010`、SQLSTATE `42501` 和 `ParticipationLedgerEntry`。卸载观察器后，仅补隔离基线缺少的 6 列，列表即返回 `200/0`；撤权后再次 `500/50000`。成功读回覆盖未结算的空账本。共享候选只读取样显示 **13 个分录列均缺 SELECT**，两个批次列可读，本轮新增 `GRANT=0`。六列差额只适用于隔离基线；共享角色契约仍是包含该页面的部署阻断项。[账本回执](/private/tmp/srvf-t48/receipts/trial.json) · [权限取样 SQL](/private/tmp/srvf-t48/receipts/aclcheck.sql) |

**条件拆分合理。** 红区、非公网配对和恢复演练已有各自回执。USB 与 `xcdevice` 均未识别到可用实机，手机、微信和公网认证业务为 `NOT_RUN`；公网 TLS 健康检查只覆盖入口可达。核查固定归档的字段及常见凭证格式，未发现实际 Token 值。[设备回执](/private/tmp/srvf-t48/receipts/devices.json) · [归档回执](/private/tmp/srvf-t48/receipts/trial.json)

**非公网配对 PASS；共享账本部署 BLOCK；真机、公网 NOT_RUN。**