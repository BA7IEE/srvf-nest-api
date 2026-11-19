# T33 独立只读审查

**结论：PASS。** `30100` 和 `20174` 已在隔离库用同一普通发起人、同一份 managed 草稿逐步复现。结果符合运行版本 `108feebb84b85c7e4955c5af8bbfc016702e4529` 的判权和初审规则。既定常规单场次首发已有 Simple 模板路径，本轮没有发现需要修复的代码缺陷，也没有证据要求用户改变业务规则。

## 1．两次拒绝的原因可以分开判定

隔离驱动先执行目录恢复，日志记录 `apply app_test exit 0`。随后通过受限 `lab_runtime` 连接调用真实 Nest 服务。发起人是已关联活跃组织的 `level-1` 普通 USER；写指标前，库内活动是 `draft`，`metricRequirementCode=null`、`metricSelectionRevision=0`，角色绑定和该活动审核记录均为零。[运行驱动](/private/tmp/srvf-t33/run.py) · [复现日志](/private/tmp/srvf-t33/lab.log)

| 操作 | 实测结果 | 判定 |
|---|---|---|
| 修改草稿标题 | 发起人成功；另一普通主体收到 `20001` | 发起人具备本次标题修改资格，不能据此推导指标编辑权。 |
| 显式把指标设为 `not_required` | 使用 `expectedRevision=0`，返回 `30100` | `authorizeWrite` 先检查目标活动上的 `activity.update.record`，之后才检查草稿是否可写及操作者身份。目录中有码，但这名发起人没有相应授权；此时也没有发布产生的 owner 绑定。 |
| 提交初审 | 返回 `20174`，仍为 `draft`，审核记录为零 | `buildInitial` 要求已有有效指标选择。上一步未写入，`null` 仍表示“尚未选择”，不能当作已明确选择 `not_required`。 |

因此，**补回目录行不足以让普通发起人写指标；明确选择 `not_required` 又是一个需要授权的业务动作。** `30100` 解释谁能写，`20174` 解释现有草稿能否提交。驱动比较了失败前后的活动状态、指标版本、角色绑定数及审核数，结论不只依赖错误文案。[指标写入顺序](https://github.com/BA7IEE/srvf-nest-api/blob/108feebb84b85c7e4955c5af8bbfc016702e4529/src/modules/activities/activity-metric-selection.service.ts#L59) · [初审条件](https://github.com/BA7IEE/srvf-nest-api/blob/108feebb84b85c7e4955c5af8bbfc016702e4529/src/modules/activities/activity-publish-proposal-v2.service.ts#L868) · [状态断言](/private/tmp/srvf-t33/lab.ts)

## 2．Simple 正例成立，前提与候选现状不同

仓库的常规单场次契约区分了创建、保存和审核：创建使用目标组织范围的 `activity.create.record`；保存另查更新权限和本人草稿资格；发布由独立审核人完成。这与 AGENTS 规定的服务层业务判权一致。[接口契约](https://github.com/BA7IEE/srvf-nest-api/blob/108feebb84b85c7e4955c5af8bbfc016702e4529/docs/handoff/activity-os-simple-activities.md) · [项目规则](/Users/dengwang/Documents/coding/srvf-nest-api/AGENTS.md:34)

T29c/T30 的隔离正例使用 `shadow` 模式、有效 V3 单场次模板、组织范围创建权、独立审核人和已验证的数据库列权限。模板在创建时明确写入 `not_required`，读回指标版本为 `1`；发起人提交后进入 `pending`，独立审核人批准后进入 `published`，此时才有活动级 owner 投影。**没有手工预绑 `activity-owner`、以超级管理员代发，或直接修改草稿指标来绕过判权。** 隔离库所有者准备了模板和授权夹具，实际业务调用走非所有者连接。[T29c 正例](https://github.com/BA7IEE/srvf-nest-api/tree/6371d8c55874277e1e47a544b2bffe501b495776/docs/ops/runtime-acl/t29c) · [T30 发布与绑定读回](/private/tmp/srvf-t29-approval-pack/t30/lab.log)

T33 的候选只读输出仍是责任制 `true`、创建控制面 `off`、V1.1 `false`，模板初筛数和 `activity.create.record` 目录行数均为 `0`。本轮没有候选公网初审或发布。隔离结果证明了既定路径可行，也解释了空白草稿的两次拒绝；**候选环境尚未完成该正向链路的验收。** [候选采样](/private/tmp/srvf-t33/candidate.log)

## 3．处置判断

**现有首发范围无需代码修复 PR，也无需用户重新决定指标规则。** 若要在共享候选开放 Simple，仍需另行决定试运行受众、模板、授权主体和部署范围。只有当产品要求扩展为“没有指标编辑权的普通成员也能从空白 managed 草稿一路提交到发布”时，才需要业务方决定**谁有权声明该活动无需指标**，再据此评审实现。

**PASS｜隔离根因成立；候选正向未验；现行规则无需改动。**
