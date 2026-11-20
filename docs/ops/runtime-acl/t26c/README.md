# 普通队员创建训练草稿并读取详情

建议将两个增量作为一张候选测试环境审批卡。目标为 srvf_staging 的 srvf_dp_acceptance_runtime。第一个增量为 grant.sql 中完整列举的 Activity 26 列 INSERT。第二个增量为 activity_responsibility_assignments 七列 SELECT，即 id、activityId、memberId、status、responsibilityType、canManageRegistrations、canManageAttendance。Prisma 为加载关系额外投影了 id。任何使用同一数据库角色的作业均能使用这些权限，包括读取其他活动的上述关系字段；应用按当前主体和活动范围执行的判权仍是独立边界。

现场仅执行 snapshot.sql，采样 PostgreSQL 有效表和列权限。13 张实际访问表的投影见 chain-acl.json，责任人关系 SELECT 和 Activity INSERT 均为零。其余实际详情读取包括发布审核、活动岗位、报名与考勤聚合。其余 12 张表的 SELECT 均为整表有效。没有为这些读操作申请额外授权。

隔离环境从 108feebb84b85c7e4955c5af8bbfc016702e4529 的归档与迁移创建独立 PG16，使用和该版本 schema 摘要一致的生成客户端。普通 USER、成员、组织、临时实验数据由实验库所有者创建。实际业务调用使用单独的非超级用户连接，按现场的有效表和列权限重建。该实验还原链上使用的权限，未复制真实用户、角色密码或业务数据。run.py 编排独立容器，lab.ts 通过 Nest 真实服务调用 AppManagedActivitiesService.create，参数对应 T26b 普通训练草稿。服务返回含详情对象，此处不计为公网 HTTP 201。

| 检查 | 结果 |
|---|---|
| 基线创建 | PG 拒绝，活动 0 行 |
| 只补 26 列 | 详情被拒，但同一标记已有 1 个草稿。此状态重试前应先核对数据 |
| 再补 7 列 | 创建和详情返回成功，普通发起人、组织、draft 状态、唯一标记草稿及唯一 activity.publish 审计读回一致 |
| 强制审计写失败 | 事务回滚，该标记草稿 0 行 |
| 无正式等级的普通主体 | 现行发起策略拒绝，草稿 0 行 |
| 撤回两个增量 | 重新创建被拒，新标记 0 行。原有 UPDATE 有效列集在补权限前后相同 |
| 草案防误用 | 独立库中首次授予和首次撤回均 exit 0，重复授予和重复撤回均 exit 3 |

trace.sql 是 Prisma query 事件的 SQL 模板，省略绑定参数，含事务边界。检查包含实际 INSERT、详情 SELECT、聚合及审计写入。本次服务路径没有显式 FOR UPDATE。无需 Organization INSERT。该卡仅覆盖上述 DTO 与空责任人列表的首次详情，发布、更正、#1416/#1417 和其他可选字段未测。

正式部署由数据库角色契约维护方按目标环境的真实 API 连接身份、启用面和有效 ACL 复核并持久化。两份草案限定库名、角色及列权限基线，事务中锁定目标表。实施方应记录 grantor 与实施前后 ACL，撤回时使用原授予身份并复核来源。撤权仅作用于本次新增列，保留草稿与审计数据。此批候选 GRANT 次数为零。

复现时将目标 revision 的独立源码归档绝对路径写入本目录 srcpath，装好锁定版本依赖并执行 prisma generate。执行 python3 run.py 使用本机 Docker，仅绑定回环端口，生成 trace.sql。提交的驱动使用 chain-acl.json 中已触达的 13 张表，其他对象保持实验库迁移默认。完整现场快照保存在本地证据目录。validation.log 取最终独立运行的断言和 SQL 退出码。
