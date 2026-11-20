# T29b 创建时初始化指标

**产品路径已在隔离库走通。** 108feebb84b85c7e4955c5af8bbfc016702e4529 的 ActivitySimpleDraftService.create 在隔离 shadow 模式支持使用 V3 模板创建活动。发起人是有本组织 activity.create.record 的 level-1 USER，归属活跃非根组织，全程未给他 activity.update.record 或手工绑定 owner。V3 训练模板包含单场次岗位，指标选择为 not_required，指标指针为 null。创建后读回发起人、组织和 metricSelectionRevision=1。该普通队员提交初审得到 pending，另一个仅在该组织持有既定活动发布审核角色的普通 USER 独立批准，PG 状态为 published。此后审核员替发起人提交变更得到 30100，原发起人的变更提案返回 change/pending。#1416 缺失资源沿用 T29 的 20001。均为隔离服务/控制器结果，无公网 HTTP 断言。

**当前候选条件尚不满足。** 现场只读查询显示控制面 off、V1.1 false，活跃 V3 以上版本模板 0 个、activity.create.record 目录行 0 个。即使在隔离库预置组织范围、创建码及模板，对应 off 下的普通 Simple 发起仍为 20163；不传组织给入口判权的 quick 和传统 from-template 均为 30100。0 个活动、0 个初审。仅在一次性数据库作 shadow 功能对照，所有实验均设置 V1.1=false，未开启 Human。

**审批边界。** 三码三角色目录工具保持 T29 原范围。成功实验另用测试夹具装配了创建码、组织范围、发布后责任投影所需的角色及发布审核映射；三项目录修复不能独立提供这些条件。模板已给出有效选择时，无须让发起人在草稿后补指标，也无须更改 owner 投影时机。这仅针对已验证的模板流程；启用候选控制面以及装配模板、授权主体均未实施。

**数据库权限仍需独立验证。** 成功对照的应用主体是普通 USER，后端数据库连接是一次性 PG 的所有者。使用候选有效 ACL 副本 + T27 草稿实验增量时，同一 V3 simple 创建在 Activity INSERT 被拒。与原 26 列相比，实际 SQL 还包含 selectedTemplateVersionId、metricRequirementCode、selectedMetricSetVersionId、selectedMetricSetDefinitionHash、createFromTemplateOperationKey、createFromTemplateRequestHash、capacity。该七列仅是首个失败语句的差额。整链最小授权、撤权复测及公网发布均 NOT_RUN。未建议零散 GRANT。V5 的显式时长政策另要求组织范围的 activity.time-policy.select，只有创建权限的相同主体在该分支得到 40300；成功路径使用不依赖该选择的 V3 模板。

复现使用 T27 的 acl.jsonl 与固定版本独立归档路径 srcpath。run.py/lab.ts 为隔离 shadow 路径；functional.py 使用一次性 PG 所有者对照。有界实验中每次使用新库，同一场景内发起人保持相同身份，审核人为独立主体。off.py 搭配 off.ts（复制为实验目录 lab.ts）可复核关闭态。命令 python3 functional.py exit 0，结果见 functional-result.log。候选只读聚合见 site.sql 和 site.log，顺序为活跃模板数与创建码行数。候选业务实施 NOT_RUN、新增 GRANT 0。
