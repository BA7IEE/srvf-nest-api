# T45 独立只读审查

**隔离读面与首次签到 PASS；队员 H5 仍 BLOCKED。** 只读重算 T45 回执通过。开发报告中“已交维护者”的说法缺少交付凭据，应改为“ADR 已记录，用户审批卡交付未证实，凭证方案待决定”。[固定证据树](https://github.com/BA7IEE/srvf-nest-api/tree/19f2a7cf9236d44f341a94365b97d90787e74ba0/docs/ops/runtime-acl/t45)

| 分项 | 独立判定 |
|---|---|
| 汇总与工作台 | **PASS。** 默认轨新增 22 项 SELECT 后，本人汇总、负责人工作台均由 `500/50000` 变为 `200/0`。切到 V1.1 后，汇总还需账本的 `activityId`、`resultRevisionId` 两列。补齐后两条读面均为 200，无权队员访问工作台仍为 `403/30100`。覆盖的是零账本、无结算运行的状态。[读面回执](/private/tmp/srvf-t45/read-on-after.jsonl) |
| 首次签到 | **PASS。** 78 项列权限中，76 项按实际应用 SQL 验证，2 项按触发器分支的等价查询验证。逐列撤权是 SQL 规划级对照；完整 HTTP 按整包实测。两次失败后事件、时段和证据版本均为零。补齐后返回 `201/0`，本人状态为已签到，DB 恰有一条事件和一个关联的开放时段。reqId `cmwnu41p4f49014edc35e1ca6173caa74` 与成功审计的主体、事件均匹配。[签到请求](/private/tmp/srvf-t45/punch-trial.log) · [DB 与审计](/private/tmp/srvf-t45/punch-committed.jsonl) |
| 撤权复现 | **两条读面已复现。** 撤权后汇总、负责人工作台均回到 `500/50000`，无权队员仍为 403。签到包已核对 ACL 恢复，既有签到事件、时段和审计保留；撤权后重新发起一次签到的 HTTP 结果为 `NOT_RUN`。[撤权后读面](/private/tmp/srvf-t45/read-withdrawn.jsonl) · [撤权后签到状态](/private/tmp/srvf-t45/punch-after-withdraw.jsonl) |

**环境与版本。** V1.1 仅在一次性 `APP_ENV=test` 栈从 `false` 切至 `true`，先停旧实例，再启动唯一写入者；产生新轨事实后直接退役。实施记录支持共享候选新增 `GRANT=0`，公网写入 `NOT_RUN`。GitHub 实时核对三个 HEAD 均未变、未合并：管理前端 `104e524c0b76826a79b1d48fad37fb07dcdfb8e8`，后端 `713d3416830d897852929731ff7f9b638038ab7c`，队员 H5 `ce14f84b5add85de11816136a0ef975a28ff7b7e`。[开关回执](/private/tmp/srvf-t45/gate-on.jsonl) · [管理前端 PR](https://github.com/BA7IEE/srvf-admin-web/pull/172) · [后端 PR](https://github.com/BA7IEE/srvf-nest-api/pull/1444) · [H5 PR](https://github.com/BA7IEE/SRVFMobileWeb/pull/3)

**H5 的决定尚未闭合。** ADR 001 记录了真实凭证存储方案待批准，正式构建仍关闭真实接线。此前材料说明了选项与风险，但本次可核材料中未见面向用户的独立审批卡、送达回执或用户决定。真实 H5 报名、手机相机签到均为 `NOT_RUN`。[ADR 001](https://github.com/BA7IEE/SRVFMobileWeb/blob/ce14f84b5add85de11816136a0ef975a28ff7b7e/docs/adr-001-credentials.md) · [T45 GATE](/private/tmp/srvf-t45/GATE.md)

**隔离读面、首次签到 PASS；H5 BLOCKED，审批卡送达未证实。**