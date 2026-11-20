# T25 首发运行角色权限集中审计

运行 revision 108feebb84b85c7e4955c5af8bbfc016702e4529。build-audit.py 从该 Git 对象读取 Prisma 模型映射与业务代码，对成员组织、活动、岗位场次、报名、打卡考勤、结算贡献和通知等模块中直接出现的 Prisma 委托读写建立清单，再通过只读事务与实际应用数据库角色的有效权限比对。surface.jsonl 给出所有匹配项及代表性调用点。

共 199 个表/操作组合，41 项没有任何一列的对应权限。这是跨模块的部署配置不一致信号。列权限非空仍可能不足；间接委托、原始 SQL、数据库函数、触发器、其他角色和未命中命名模式的模型没有完全覆盖。清单不能推导出应给共享运行角色 41 项授权，也未证明 41 个公网故障。

| 无对应权限的表 | 操作 | 运行版本源码取样 |
|---|---|---|
| Activity | INSERT | src/modules/activities/activity-from-template.service.ts:759 |
| ActivityBatchJob | INSERT | src/modules/activities/activity-time-correction-background.service.ts:157 |
| ActivityContributionPolicySelectionItem | INSERT | src/modules/activities/activity-contribution-policy-selection.service.ts:797 |
| ActivityContributionPolicySelectionItem | SELECT | src/modules/activities/activity-contribution-policy-selection-query.service.ts:160 |
| ActivityContributionPolicySelectionRevision | INSERT | src/modules/activities/activity-contribution-policy-selection.service.ts:300 |
| ActivityContributionPolicySelectionRevision | SELECT | src/modules/activities/activity-contribution-policy-selection-query.service.ts:141 |
| ActivityEvidenceState | INSERT | src/modules/activities/activity-session-cancellation-effects.ts:211 |
| ActivityEvidenceState | UPDATE | src/modules/activities/activity-session-cancellation-effects.ts:217 |
| ActivityParticipationIdentity | INSERT | src/modules/activities/legacy-ledger-conversion.service.ts:258 |
| ActivityParticipationIdentity | UPDATE | src/modules/activity-registrations/activity-allocation.service.ts:444 |
| ActivityRuleSnapshot | INSERT | src/modules/activities/activity-publish-review.service.ts:1342 |
| ActivityRuleSnapshot | SELECT | src/modules/activities/activity-contribution-settlement-query.service.ts:442 |
| ActivitySettlementClosureRevision | INSERT | src/modules/activities/activity-closure.service.ts:1032 |
| ActivitySettlementClosureRevision | SELECT | src/modules/activities/activity-archive.service.ts:271 |
| ActivitySettlementClosureRevision | UPDATE | src/modules/activities/correction-application.service.ts:3271 |
| ActivitySettlementContributionRevision | INSERT | src/modules/activities/activity-contribution-settlement.service.ts:530 |
| ActivitySettlementTimeCommandReceipt | INSERT | src/modules/activities/activity-time-settlement.service.ts:660 |
| ActivitySettlementTimeCommandReceipt | SELECT | src/modules/activities/activity-time-settlement.service.ts:252 |
| ActivitySettlementTimeRevision | INSERT | src/modules/activities/activity-time-settlement.service.ts:399 |
| ActivityTimeCutoverReceipt | SELECT | src/modules/activities/activity-time-cutover.service.ts:44 |
| ActivityTimePolicySelectionItem | INSERT | src/modules/activities/activity-time-policy-selection.service.ts:287 |
| ActivityTimePolicySelectionItem | SELECT | src/modules/activities/activity-time-policy-selection-query.service.ts:112 |
| ActivityTimePolicySelectionRevision | INSERT | src/modules/activities/activity-time-policy-selection.service.ts:256 |
| ActivityTimePolicySelectionRevision | SELECT | src/modules/activities/activity-publish-proposal-v2.service.ts:1989 |
| AttendanceCorrectionRequest | INSERT | src/modules/attendances/attendance-correction-write.service.ts:80 |
| AttendanceCorrectionRequest | UPDATE | src/modules/attendances/attendance-correction-write.service.ts:105 |
| AttendancePunchEvent | INSERT | src/modules/attendances/attendance-punch-command.service.ts:283 |
| AttendancePunchEvent | SELECT | src/modules/activities/activity-contribution-settlement-query.service.ts:375 |
| AttendanceSettlementRun | INSERT | src/modules/activities/legacy-ledger-conversion.service.ts:361 |
| AttendanceSettlementRun | UPDATE | src/modules/activities/activity-closure.service.ts:373 |
| AttendanceSettlementVersion | INSERT | src/modules/activities/correction-application.service.ts:2197 |
| AttendanceSettlementVersion | UPDATE | src/modules/activities/activity-contribution-settlement.service.ts:622 |
| ContributionPolicyVersion | INSERT | src/modules/activities/activity-contribution-policy-command.ts:178 |
| ContributionPolicyVersion | SELECT | src/modules/activities/activity-contribution-policy-catalogue-query.service.ts:84 |
| ContributionPolicyVersion | UPDATE | src/modules/activities/activity-contribution-policy.service.ts:239 |
| Organization | INSERT | src/modules/organizations/organizations.service.ts:336 |
| Organization | UPDATE | src/modules/organizations/organizations.service.ts:425 |
| activity_responsibility_assignments | INSERT | src/modules/activities/activity-responsibility.service.ts:207 |
| activity_responsibility_assignments | SELECT | src/modules/activities/activity-closure.service.ts:1066 |
| activity_responsibility_assignments | UPDATE | src/modules/activities/activity-responsibility.service.ts:281 |
| notification_outbox_intents | INSERT | src/modules/notifications/notification-outbox.service.ts:123 |

本轮实证的最小 SQL 边界为两表各八列 SELECT。已批准的成员创建与行锁列权限另有独立验证。对 Activity 创建，应用存在直接 create 路径，现有角色连一列 INSERT 都没有；对签到事件、结算版本、贡献政策及通知 outbox，还应确认实际执行身份、启用模式、受控写入器及真实 SQL 列集，再在隔离库验证拒绝、写入读回和撤权。尚不具备审批这些新增写权限的逐列证据。部署包本轮对其他表拟实施的增量为空。正式环境应独立绑定库、角色、功能范围，变更前保存来源与回滚差额。权限目录缺少 member.bind.account 属应用配置；SQL GRANT 不会创建业务授权。

独立 PG16 运行 isolated.py：不满足必要列权限，预检 exit 3；具备已验证的必要列权限，预检 exit 0。当前候选相同只读预检 exit 0。实验没有覆盖 41 项业务分支；这些项为静态筛查，待按业务路径验证。Draft PR #1442 提供部署预检和本清单，候选热补丁独立于部署代码。待同 SHA 双轮独审，未合并、未部署。
