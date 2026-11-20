# T33 草稿指标与初审根因

**结论为有适用前提的合法首发路径。** 普通发起人走旧 managed 入口会遇到真实的发布前阻断。草稿标题可由本人修改，指标写入有单独的权限要求。发布后才产生的 owner 权限无法替首次发布补指标。仓库已为常规单场次首版定义另一条路径：Simple 从已批准模板在创建事务初始化指标，再提交独立审核。首发合同不要求让每个草稿发起人事后自行决定免填指标。本轮没有发现应当放宽鉴权的代码依据。

## 同一普通 USER 的负例（本轮）

在 108feebb84b85c7e4955c5af8bbfc016702e4529 的临时归档运行 python3 run.py，exit 0。一次性 PG16 装载迁移、候选有效 ACL 快照，以及仅用于到达业务判权点的既有实验草稿列权限。目录以审后定义装入隔离库，业务调用走 lab_runtime；level-1 发起人与活跃组织关联，用户/角色绑定总数为零。只读对账使用实验所有者。通过 Nest service 调用，未经过公网登录或 HTTP。

| 步骤 | 身份、授权来源 | 实际状态 |
|---|---|---|
| 传统 managed 创建 | 普通发起人，组织成员及责任制发起资格 | 创建 draft；指标字段 NULL，revision 0 |
| 修改标题 | 同一发起人，本人草稿资格 | 成功；另一普通主体修改同一草稿返回 20001 |
| 配置指标 | 同一发起人，显式选择 not_required，expectedRevision=0 | 30100。进入 authorizeWrite 时须先通过 activity.update.record 的活动范围授权，随后 writable 才检验草稿及发起人。零绑定；活动仍为 draft |
| 提交初审 | 同一发起人，合法确认和操作键 | 20174。buildInitial 取得当前指标选择为 null，无法构造初审提案。审核记录 0 |
| 审核、发布、owner 投影 | 无待审对象 | NOT_RUN。失败前后状态、指标版本、绑定数与审核数一致 |

30100 对应“谁能写指标”，20174 对应“是否存在合规选择”。两者在这条流程前后相连，却有各自独立的判断条件。缺目录曾是现场问题；在有相应目录且没有授予普通主体更新权限的实验中，同样两次拒绝均可复现。源码见 src/modules/activities/activity-metric-selection-access.ts 的 authorizeWrite、writable、authorizeSimpleCreation；activity-publish-proposal-v2.service.ts 的 buildInitial；activity-responsibility.service.ts 的 projectOwner 调用以及 activity-business-overhaul-acceptance.spec.ts 的批准后投影断言。

## 正向对照与适用条件

复用 T29c/T30 同版本非所有者连接的实跑。普通发起人持本组织 activity.create.record；从合法单场次 V3 模板创建时，明确的 not_required 随模板写入，revision=1。发起人在 draft 阶段没有得到 activity-owner。本人提交后初审 pending；独立组织审核员批准后 published，才出现一条 MEMBER 活动级 owner 投影。审核员替发起人提交变更为 30100，本人提交为 change/pending。该实证没有验证发起人对已建草稿另行更换指标。

这组正例额外装配了模板、组织范围创建权、完整审核角色职责及试运行模式，隔离库另有整链列权限。主体为相同业务类型，各次一次性库的账号各自创建。它证明创建时初始化路径有效，不能说明原 managed 草稿已获修复。固定隔离证据见 [T29c](https://github.com/BA7IEE/srvf-nest-api/tree/6371d8c55874277e1e47a544b2bffe501b495776/docs/ops/runtime-acl/t29c) 与 [T30](https://github.com/BA7IEE/srvf-nest-api/tree/fb90a2d647d0af9c1f2c4d29673fa9f726180c42/docs/ops/runtime-acl/t30)。

本轮 SSH 只读预检 exit 0：候选责任制 true、控制面 off、V1.1 false，可用模板初筛数与创建码数均 0，三条真实外发条件 false。公网审核发布 NOT_RUN。实验中的额外前提没有装到候选，候选新 GRANT=0。

## 已有实现及处置

GitHub main 2b3eee0a954ea65abaef3edb35fd391eaa1567e9 相对运行版的文件差异仅 scripts/cutover-check.ts。已合并 #1282 实现模板 V3/指标选择，#1284 实现提案 readiness。docs/handoff/miniapp.md 区分 unconfigured 与明确的 not_required；docs/handoff/activity-os-simple-activities.md 与常规活动首版执行台账区分创建权限、保存权限及独立审核。#1416 的缺失对象错误与本次组装初审提案是不同场景。

既定首发范围可继续沿用模板路径，无需新业务决定，无代码修复 PR。若未来要求没有显式指标编辑权的成员也能从空白 managed 草稿发起到发布，才需明确谁能决定指标要求；不能从“能改标题”推出这项权力。本轮到此停等独审。T32 试运行装配包和 Draft PR 未完成，不计作本轮交付。
