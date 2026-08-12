# Boundary observations — Architecture Governance Phase 2

> 状态：拍板材料，未改变任何边界声明。扫描与所有规则仍为 **report-only**；本文件不构成 allowlist、public surface 或跨域写的合法出口。

## 1. 本期结论

- R5/R6 扫描保持 report-only，现输出 528 条观察，其中 443 条报告项、85 条已登记的事实读观察。
- 原 125 条跨属主写台账语义字段已 100% 填充；W1 98 条均写明“按域重划自动合法、Phase 7 无需清偿”。W2/W3/W4 共 27 条均有逐条属主出口与偿还路径。
- R5/R6 静态复扫审核并新增历史债 76 条：raw 30、predicate 46；每条都有 scanner 版本与 `git blame` 引入证据。本登记没有改任何命中的 `src/**` 行。
- `crossDomainReadAllowlist` 从 0 条初版为 59 条精确调用点；第三档语义查询 8 条仍单列为属主谓词候选，未进入 allowlist。
- `allowedEdges` 与 `publicSurface` 仍是未拍板状态：`confirmed:false`，`decisionsPending=["allowedEdges","publicSurface"]`。本期在此停住，等待维护者决定。

## 2. 观察计数：Phase 1 收口基线 vs 本次

基线取 10bc5840 的 report 输出；本次为当前 runner 实测。读档重分会改变类别分布，不代表业务代码新增或清偿。

| 观察项 | Phase 1 基线 | 本次 | 说明 |
| --- | --- | --- | --- |
| 总 findings / report / allow | 443 / 371 / 72 | 528 / 443 / 85 | 扫描仍为 report-only |
| 跨属主写 | 125 | 125 | 业务代码未改；既有 125 条仍在台账 |
| raw SQL 物理表命中 | 30 | 30 | 30 条被审核登记为历史 raw 债 |
| 语义查询候选 | 135 | 8 | 旧宽口径经三档重分后为 8 条静态语义候选 |
| kernel 事实读（allow） | 72 | 22 | 显式 select 与 kernelPredicateFields 双重校验 |
| 二档事实读（allow） | 0 | 63 | 59 条精确 allowlist 产生 63 次实测观察 |
| kernel 谓词违规 | 0 | 38 | 38 条，已登记 predicate 历史债 |
| 动态读形状 | 4 | 117 | 117 条仍是已知缺口，不当作已证实债 |
| 观察子域间写 | 0 | 48（identity-org 13 / participation 35） | 只积累拆域证据，不改变域边界 |
| 二档 allowlist 精确条目 | 0 | 59 | 语义查询不入表 |
| 债务台账 | 125；pending 125 | 201；pending 0 | 125 条完成语义；新增 76 条历史债 |
| R8 首扫 | T1=4（全部 mismatch）/ T2=2（全部 mismatch）/ T3=113 / N/A=9 | T1=4（全部 mismatch）/ T2=2（全部 mismatch）/ T3=113 / N/A=9 | T3=113 是 Phase 3 前置标注工作量，不在本期补齐 |

### 已知缺口

- Prisma aliases, destructuring, wrappers and variable forwarding are not proven.
- Dynamic delegates and computed property access stay report-only unknowns.
- tsconfig aliases, re-exports and runtime module loading are not resolved.
- Dynamic select/include/where shapes cannot be proven into a read tier.
- Semantic-read detection only recognises a static time-window plus status-predicate combination.
- Raw SQL only matches literal physical table names derived from Prisma @@map or Prisma default table names.

## 3. 跨域读三档与登记口径

- 第一档：22 次 kernel 事实读已同时满足显式 `select ⊆ kernelReadFields` 和 `where ⊆ kernelPredicateFields`。
- 第二档：63 次跨域事实读由 59 条精确 allowlist 覆盖；未出现静态的二档待登记候选。
- 第三档：8 条时间窗加状态组合仍要求消费属主谓词；不因当前存在 allowlist 而豁免。
- 不合规：38 条 kernel 谓词越界、30 条 raw SQL 物理表命中均入历史债；117 条动态形状只报告。
- `omit`、裸 `include` 和无 `select` 均不作为 kernel 读出口；自测包含每类正反例。

## 4. 27 条域级真违规：偿还路径

以下是 W2/W3/W4 的逐条路径；“拟建”只表示 Phase 7 的属主出口候选，绝非本期实现或已确认 public surface。

| ID | 类 | 调用域 → 属主 | 模型.操作 | 偿还路径 | 属主出口候选 |
| --- | --- | --- | --- | --- | --- |
| XW-0004 | W3 | activities → role-bindings | RoleBinding.create | 由 role-bindings 导出 projectActivityResponsibilitiesInTx(tx) 原语；activities 域仅提交投影事实。 | src/modules/role-bindings/role-binding-projection.primitive.ts（拟建） |
| XW-0005 | W3 | activities → role-bindings | RoleBinding.updateMany | 由 role-bindings 导出 projectActivityResponsibilitiesInTx(tx) 原语；activities 域仅提交投影事实。 | src/modules/role-bindings/role-binding-projection.primitive.ts（拟建） |
| XW-0058 | W2 | attachments → activity-registrations | RegistrationUploadSession.updateMany | 由 activity-registrations 导出 manageRegistrationUploadSessionUpdateManyInTx(tx) 原语；不要求同事务时改走其公开 service API，调用域仅传业务事实。 | src/modules/activity-registrations/registration-upload-session.primitive.ts（拟建） |
| XW-0080 | W2 | members → activities | ActivityResponsibilityAssignment.updateMany | 由 activities 导出 manageActivityResponsibilityAssignmentUpdateManyInTx(tx) 原语；不要求同事务时改走其公开 service API，调用域仅传业务事实。 | src/modules/activities/activity-responsibility-assignment.primitive.ts（拟建） |
| XW-0081 | W3 | members → role-bindings | RoleBinding.updateMany | 由 role-bindings 导出 endBindingsForOffboardingInTx(tx) 原语；members 域仅提交投影事实。 | src/modules/role-bindings/role-binding-projection.primitive.ts（拟建） |
| XW-0082 | W4 | notifications → activities | Activity.updateMany | 短期由 activities 导出 manageActivityUpdateManyInTx(tx) 认领/到期原语；长期经 D 档迁移为 notifications 交付回执，或维护者批准持证长存。 | src/modules/activities/activity.primitive.ts（拟建） |
| XW-0083 | W4 | notifications → certificates | Certificate.updateMany | 短期由 certificates 导出 manageCertificateUpdateManyInTx(tx) 认领/到期原语；长期经 D 档迁移为 notifications 交付回执，或维护者批准持证长存。 | src/modules/certificates/certificate.primitive.ts（拟建） |
| XW-0084 | W4 | notifications → certificates | Certificate.updateMany | 短期由 certificates 导出 manageCertificateUpdateManyInTx(tx) 认领/到期原语；长期经 D 档迁移为 notifications 交付回执，或维护者批准持证长存。 | src/modules/certificates/certificate.primitive.ts（拟建） |
| XW-0085 | W4 | notifications → insurances | MemberInsurance.updateMany | 短期由 insurances 导出 manageMemberInsuranceUpdateManyInTx(tx) 认领/到期原语；长期经 D 档迁移为 notifications 交付回执，或维护者批准持证长存。 | src/modules/insurances/member-insurance.primitive.ts（拟建） |
| XW-0086 | W4 | notifications → insurances | TeamInsurancePolicy.updateMany | 短期由 insurances 导出 manageTeamInsurancePolicyUpdateManyInTx(tx) 认领/到期原语；长期经 D 档迁移为 notifications 交付回执，或维护者批准持证长存。 | src/modules/insurances/team-insurance-policy.primitive.ts（拟建） |
| XW-0091 | W2 | permissions → audit-logs | AuditLog.create | 由 audit-logs 导出 manageAuditLogCreateInTx(tx) 原语；不要求同事务时改走其公开 service API，调用域仅传业务事实。 | src/modules/audit-logs/audit-log.primitive.ts（拟建） |
| XW-0092 | W2 | permissions → audit-logs | AuditLog.create | 由 audit-logs 导出 manageAuditLogCreateInTx(tx) 原语；不要求同事务时改走其公开 service API，调用域仅传业务事实。 | src/modules/audit-logs/audit-log.primitive.ts（拟建） |
| XW-0095 | W2 | recruitment → members | Member.create | 由 identity-org 导出 MemberOnboarding.createFromRecruitmentInTx(tx) 原语，统一完成建号聚合。 | src/modules/members/member-onboarding.primitive.ts（拟建；identity-org） |
| XW-0096 | W2 | recruitment → member-departments | MemberOrganizationMembership.create | 由 identity-org 导出 MemberOnboarding.createFromRecruitmentInTx(tx) 原语，统一完成建号聚合。 | src/modules/member-departments/member-onboarding.primitive.ts（拟建；identity-org） |
| XW-0097 | W2 | recruitment → users | User.create | 由 identity-org 导出 MemberOnboarding.createFromRecruitmentInTx(tx) 原语，统一完成建号聚合。 | src/modules/users/member-onboarding.primitive.ts（拟建；identity-org） |
| XW-0098 | W2 | recruitment → member-profiles | MemberProfile.create | 由 identity-org 导出 MemberOnboarding.createFromRecruitmentInTx(tx) 原语，统一完成建号聚合。 | src/modules/member-profiles/member-onboarding.primitive.ts（拟建；identity-org） |
| XW-0099 | W2 | recruitment → emergency-contacts | EmergencyContact.create | 由 identity-org 导出 MemberOnboarding.createFromRecruitmentInTx(tx) 原语，统一完成建号聚合。 | src/modules/emergency-contacts/member-onboarding.primitive.ts（拟建；identity-org） |
| XW-0100 | W2 | recruitment → certificates | Certificate.create | 由 certificates 导出 issueFromRecruitmentClaimInTx(tx) 原语，招新域只传已锁定的 claim 事实。 | src/modules/certificates/certificate-issue.primitive.ts（拟建） |
| XW-0101 | W2 | team-join → member-departments | MemberOrganizationMembership.update | 由 member-departments 导出 manageMemberOrganizationMembershipUpdateInTx(tx) 原语；不要求同事务时改走其公开 service API，调用域仅传业务事实。 | src/modules/member-departments/member-organization-membership.primitive.ts（拟建） |
| XW-0102 | W2 | team-join → member-departments | MemberOrganizationMembership.create | 由 member-departments 导出 manageMemberOrganizationMembershipCreateInTx(tx) 原语；不要求同事务时改走其公开 service API，调用域仅传业务事实。 | src/modules/member-departments/member-organization-membership.primitive.ts（拟建） |
| XW-0103 | W2 | team-join → members | Member.update | 由 members 导出 manageMemberUpdateInTx(tx) 原语；不要求同事务时改走其公开 service API，调用域仅传业务事实。 | src/modules/members/member.primitive.ts（拟建） |
| XW-0114 | W4 | wecom → auth | WecomAuthAttempt.create | 由 auth 导出 manageWecomAuthAttemptCreateInTx(tx) 原语或公开 API；wecom 通道仅传 attempt 输入或消费结果。 | src/modules/auth/wecom-auth-attempt-lifecycle.primitive.ts（拟建） |
| XW-0115 | W4 | wecom → auth | WecomAuthAttempt.updateMany | 由 auth 导出 manageWecomAuthAttemptUpdateManyInTx(tx) 原语或公开 API；wecom 通道仅传 attempt 输入或消费结果。 | src/modules/auth/wecom-auth-attempt-lifecycle.primitive.ts（拟建） |
| XW-0116 | W4 | wecom → auth | WecomAuthAttempt.updateMany | 由 auth 导出 manageWecomAuthAttemptUpdateManyInTx(tx) 原语或公开 API；wecom 通道仅传 attempt 输入或消费结果。 | src/modules/auth/wecom-auth-attempt-lifecycle.primitive.ts（拟建） |
| XW-0117 | W4 | wecom → auth | WecomAuthAttempt.updateMany | 由 auth 导出 manageWecomAuthAttemptUpdateManyInTx(tx) 原语或公开 API；wecom 通道仅传 attempt 输入或消费结果。 | src/modules/auth/wecom-auth-attempt-lifecycle.primitive.ts（拟建） |
| XW-0118 | W4 | wecom → auth | WecomAuthAttempt.updateMany | 由 auth 导出 manageWecomAuthAttemptUpdateManyInTx(tx) 原语或公开 API；wecom 通道仅传 attempt 输入或消费结果。 | src/modules/auth/wecom-auth-attempt-lifecycle.primitive.ts（拟建） |
| XW-0119 | W4 | wecom → auth | WecomAuthAttempt.updateMany | 由 auth 导出 manageWecomAuthAttemptUpdateManyInTx(tx) 原语或公开 API；wecom 通道仅传 attempt 输入或消费结果。 | src/modules/auth/wecom-auth-attempt-lifecycle.primitive.ts（拟建） |

## 5. 新发现历史债清单（76）

登记依据：静态命中后逐条读取当前源码定位，并以 `git blame` 保存引入证据；本 PR 的变更清单不含任何 `src/**` 文件。分类 `raw` 是 Phase 2 对物理表通道的显式记录，`predicate` 覆盖 kernel 谓词越界和第三档语义查询候选。

| ID | 分类 | 位置 | 访问 | introducedAt 证据 |
| --- | --- | --- | --- | --- |
| XW-0129 | raw | src/modules/activities/activity-closure.service.ts:796 | participation → identity-org / Member | git blame 44e66db300a3（2026-08-05；Phase 2 登记 PR 未改违规代码行） |
| XW-0130 | predicate | src/modules/activities/activity-draft.service.ts:663 | participation → identity-org / Member | git blame bf9188a28b78（2026-08-06；Phase 2 登记 PR 未改违规代码行） |
| XW-0131 | predicate | src/modules/activities/activity-initiation-policy.ts:58 | participation → identity-org / Organization | git blame 2e0256ff7914（2026-07-24；Phase 2 登记 PR 未改违规代码行） |
| XW-0132 | predicate | src/modules/activities/activity-initiation-policy.ts:73 | participation → identity-org / Member | git blame 2e0256ff7914（2026-07-24；Phase 2 登记 PR 未改违规代码行） |
| XW-0133 | predicate | src/modules/activities/activity-initiation-policy.ts:81 | participation → identity-org / User | git blame 2e0256ff7914（2026-07-24；Phase 2 登记 PR 未改违规代码行） |
| XW-0134 | predicate | src/modules/activities/activity-initiation-policy.ts:86 | participation → identity-org / MemberOrganizationMembership | git blame fa12f57dbf5c（2026-07-23；Phase 2 登记 PR 未改违规代码行） |
| XW-0135 | predicate | src/modules/activities/activity-proposal-validator.ts:340 | participation → identity-org / Organization | git blame 3ceff3081f92（2026-07-23；Phase 2 登记 PR 未改违规代码行） |
| XW-0136 | raw | src/modules/activities/activity-responsibility.service.ts:91 | participation → identity-org / Member | git blame 51807777586f（2026-07-23；Phase 2 登记 PR 未改违规代码行） |
| XW-0137 | predicate | src/modules/activities/activity-responsibility.service.ts:118 | participation → identity-org / Member | git blame 51807777586f（2026-07-23；Phase 2 登记 PR 未改违规代码行） |
| XW-0138 | predicate | src/modules/activities/activity-responsibility.service.ts:122 | participation → identity-org / User | git blame 51807777586f（2026-07-23；Phase 2 登记 PR 未改违规代码行） |
| XW-0139 | predicate | src/modules/activities/activity-responsibility.service.ts:155 | participation → identity-org / MemberOrganizationMembership | git blame 51807777586f（2026-07-23；Phase 2 登记 PR 未改违规代码行） |
| XW-0140 | predicate | src/modules/activities/app-managed-activities.service.ts:73 | participation → identity-org / MemberOrganizationMembership | git blame 3ceff3081f92（2026-07-23；Phase 2 登记 PR 未改违规代码行） |
| XW-0141 | predicate | src/modules/activities/app-managed-activities.service.ts:575 | participation → identity-org / Member | git blame 3ceff3081f92（2026-07-23；Phase 2 登记 PR 未改违规代码行） |
| XW-0142 | predicate | src/modules/activities/ledger-query.service.ts:115 | participation → identity-org / Member | git blame 8a4ecff8da9b（2026-08-06；Phase 2 登记 PR 未改违规代码行） |
| XW-0143 | predicate | src/modules/activity-registrations/activity-invitation.service.ts:320 | participation → identity-org / Member | git blame 5a3098830272（2026-08-08；Phase 2 登记 PR 未改违规代码行） |
| XW-0144 | predicate | src/modules/activity-registrations/activity-visitor.service.ts:83 | participation → identity-org / Member | git blame 5a3098830272（2026-08-08；Phase 2 登记 PR 未改违规代码行） |
| XW-0145 | raw | src/modules/activity-registrations/onsite-participation-command.service.ts:616 | participation → identity-org / Member | git blame 807d09aa2e79（2026-08-09；Phase 2 登记 PR 未改违规代码行） |
| XW-0146 | raw | src/modules/activity-registrations/onsite-participation-command.service.ts:624 | participation → identity-org / User | git blame 807d09aa2e79（2026-08-09；Phase 2 登记 PR 未改违规代码行） |
| XW-0147 | predicate | src/modules/activity-registrations/onsite-participation-command.service.ts:720 | participation → identity-org / Member | git blame 807d09aa2e79（2026-08-09；Phase 2 登记 PR 未改违规代码行） |
| XW-0148 | raw | src/modules/activity-registrations/registration-command.service.ts:583 | participation → identity-org / Member | git blame 7b12f1ef949d（2026-08-08；Phase 2 登记 PR 未改违规代码行） |
| XW-0149 | raw | src/modules/activity-registrations/registration-command.service.ts:591 | participation → identity-org / User | git blame 7b12f1ef949d（2026-08-08；Phase 2 登记 PR 未改违规代码行） |
| XW-0150 | raw | src/modules/attachments/attachment-storage-orchestrator.ts:1900 | platform-core → content / Content | git blame faabbdcc0cfe（2026-07-26；Phase 2 登记 PR 未改违规代码行） |
| XW-0151 | raw | src/modules/attachments/attachment-storage-orchestrator.ts:2263 | platform-core → content / Content | git blame f04729d75adf（2026-07-19；Phase 2 登记 PR 未改违规代码行） |
| XW-0152 | raw | src/modules/attachments/attachment-storage-orchestrator.ts:2282 | platform-core → participation / RegistrationUploadSession | git blame 960d206aea6b（2026-08-07；Phase 2 登记 PR 未改违规代码行） |
| XW-0153 | raw | src/modules/attachments/attachment-storage-orchestrator.ts:2295 | platform-core → identity-org / Member | git blame b2ba9cfa79a4（2026-07-18；Phase 2 登记 PR 未改违规代码行） |
| XW-0154 | raw | src/modules/attachments/attachment-storage-orchestrator.ts:2300 | platform-core → credentials / Certificate | git blame b2ba9cfa79a4（2026-07-18；Phase 2 登记 PR 未改违规代码行） |
| XW-0155 | raw | src/modules/attachments/attachment-storage-orchestrator.ts:2305 | platform-core → participation / Activity | git blame b2ba9cfa79a4（2026-07-18；Phase 2 登记 PR 未改违规代码行） |
| XW-0156 | raw | src/modules/attachments/attachments.service.ts:553 | platform-core → participation / RegistrationUploadSession | git blame 7b12f1ef949d（2026-08-08；Phase 2 登记 PR 未改违规代码行） |
| XW-0157 | predicate | src/modules/attachments/attachments.service.ts:642 | platform-core → participation / RegistrationUploadSession | git blame 7b12f1ef949d（2026-08-08；Phase 2 登记 PR 未改违规代码行） |
| XW-0158 | raw | src/modules/attachments/attachments.service.ts:1175 | platform-core → content / Content | git blame f04729d75adf（2026-07-19；Phase 2 登记 PR 未改违规代码行） |
| XW-0159 | raw | src/modules/attachments/attachments.service.ts:1535 | platform-core → content / Content | git blame faabbdcc0cfe（2026-07-26；Phase 2 登记 PR 未改违规代码行） |
| XW-0160 | predicate | src/modules/attendances/participation-summary-query.service.ts:81 | participation → identity-org / Member | git blame 90fc41d0cf5b（2026-07-15；Phase 2 登记 PR 未改违规代码行） |
| XW-0161 | raw | src/modules/auth/login-wecom.service.ts:455 | identity-org → comms / WecomSettings | git blame 74067bf125cb（2026-08-02；Phase 2 登记 PR 未改违规代码行） |
| XW-0162 | predicate | src/modules/authz/resource-resolver.service.ts:295 | platform-access → identity-org / User | git blame 812cf53ba6e9（2026-07-07；Phase 2 登记 PR 未改违规代码行） |
| XW-0163 | raw | src/modules/insurances/insurance-requirement.service.ts:604 | insurance → participation / ActivityRegistration | git blame 6c0d55d8e1af（2026-07-19；Phase 2 登记 PR 未改违规代码行） |
| XW-0164 | raw | src/modules/insurances/insurance-requirement.service.ts:641 | insurance → engagement / TeamJoinApplication | git blame 6c0d55d8e1af（2026-07-19；Phase 2 登记 PR 未改违规代码行） |
| XW-0165 | raw | src/modules/insurances/member-insurances.service.ts:126 | insurance → identity-org / Member | git blame a538d2dda837（2026-07-19；Phase 2 登记 PR 未改违规代码行） |
| XW-0166 | raw | src/modules/insurances/team-insurance-policies.service.ts:123 | insurance → identity-org / Member | git blame 6c0d55d8e1af（2026-07-19；Phase 2 登记 PR 未改违规代码行） |
| XW-0167 | raw | src/modules/insurances/team-insurance-policies.service.ts:131 | insurance → identity-org / Member | git blame 6c0d55d8e1af（2026-07-19；Phase 2 登记 PR 未改违规代码行） |
| XW-0168 | raw | src/modules/insurances/team-insurance-policies.service.ts:142 | insurance → identity-org / Member | git blame 6c0d55d8e1af（2026-07-19；Phase 2 登记 PR 未改违规代码行） |
| XW-0169 | predicate | src/modules/meta/meta.service.ts:247 | platform-core → identity-org / Member | git blame f6525cd8ebd7（2026-07-04；Phase 2 登记 PR 未改违规代码行） |
| XW-0170 | predicate | src/modules/meta/meta.service.ts:260 | platform-core → identity-org / User | git blame f6525cd8ebd7（2026-07-04；Phase 2 登记 PR 未改违规代码行） |
| XW-0171 | predicate | src/modules/meta/meta.service.ts:270 | platform-core → identity-org / Organization | git blame f6525cd8ebd7（2026-07-04；Phase 2 登记 PR 未改违规代码行） |
| XW-0172 | predicate | src/modules/notifications/expiry-reminder.service.ts:88 | comms → participation / Activity | git blame f73ac8e96454（2026-07-15；Phase 2 登记 PR 未改违规代码行） |
| XW-0173 | predicate | src/modules/notifications/expiry-reminder.service.ts:151 | comms → credentials / Certificate | git blame d5693fa96a46（2026-07-14；Phase 2 登记 PR 未改违规代码行） |
| XW-0174 | predicate | src/modules/notifications/expiry-reminder.service.ts:208 | comms → credentials / Certificate | git blame d5693fa96a46（2026-07-14；Phase 2 登记 PR 未改违规代码行） |
| XW-0175 | predicate | src/modules/notifications/expiry-reminder.service.ts:221 | comms → credentials / Certificate | git blame d5693fa96a46（2026-07-14；Phase 2 登记 PR 未改违规代码行） |
| XW-0176 | raw | src/modules/notifications/notification-recipient-authorization.service.ts:237 | comms → identity-org / User | git blame 804572fb2d4c（2026-08-02；Phase 2 登记 PR 未改违规代码行） |
| XW-0177 | raw | src/modules/notifications/notification-recipient-authorization.service.ts:276 | comms → platform-access / RoleBinding | git blame 804572fb2d4c（2026-08-02；Phase 2 登记 PR 未改违规代码行） |
| XW-0178 | raw | src/modules/notifications/notification-recipient-authorization.service.ts:276 | comms → identity-org / User | git blame 804572fb2d4c（2026-08-02；Phase 2 登记 PR 未改违规代码行） |
| XW-0179 | raw | src/modules/notifications/notification-recipient-authorization.service.ts:292 | comms → platform-access / RbacRole | git blame 804572fb2d4c（2026-08-02；Phase 2 登记 PR 未改违规代码行） |
| XW-0180 | raw | src/modules/notifications/notification-recipient-authorization.service.ts:305 | comms → platform-access / Permission | git blame 804572fb2d4c（2026-08-02；Phase 2 登记 PR 未改违规代码行） |
| XW-0181 | raw | src/modules/notifications/notification-recipient-authorization.service.ts:314 | comms → platform-access / RolePermission | git blame 804572fb2d4c（2026-08-02；Phase 2 登记 PR 未改违规代码行） |
| XW-0182 | raw | src/modules/notifications/notification-wecom-dispatch.service.ts:301 | comms → identity-org / WecomIdentity | git blame b44f4ea0e3e0（2026-08-02；Phase 2 登记 PR 未改违规代码行） |
| XW-0183 | predicate | src/modules/permissions/last-admin-protection.policy.ts:196 | platform-access → identity-org / User | git blame d9d71cf82de4（2026-07-13；Phase 2 登记 PR 未改违规代码行） |
| XW-0184 | predicate | src/modules/permissions/role-delegation.policy.ts:121 | platform-access → identity-org / User | git blame 7208f43ad3cb（2026-07-25；Phase 2 登记 PR 未改违规代码行） |
| XW-0185 | predicate | src/modules/permissions/user-roles.service.ts:99 | platform-access → identity-org / User | git blame 7208f43ad3cb（2026-07-25；Phase 2 登记 PR 未改违规代码行） |
| XW-0186 | predicate | src/modules/permissions/user-roles.service.ts:236 | platform-access → identity-org / User | git blame 36532e5b573e（2026-07-18；Phase 2 登记 PR 未改违规代码行） |
| XW-0187 | predicate | src/modules/permissions/user-roles.service.ts:254 | platform-access → identity-org / User | git blame 36532e5b573e（2026-07-18；Phase 2 登记 PR 未改违规代码行） |
| XW-0188 | predicate | src/modules/permissions/user-roles.service.ts:260 | platform-access → identity-org / Member | git blame 36532e5b573e（2026-07-18；Phase 2 登记 PR 未改违规代码行） |
| XW-0189 | predicate | src/modules/recruitment/recruitment-applications.service.ts:697 | engagement → identity-org / Member | git blame adcacb1fbe64（2026-07-11；Phase 2 登记 PR 未改违规代码行） |
| XW-0190 | predicate | src/modules/recruitment/recruitment-identity.service.ts:732 | engagement → identity-org / Member | git blame adcacb1fbe64（2026-07-11；Phase 2 登记 PR 未改违规代码行） |
| XW-0191 | predicate | src/modules/recruitment/recruitment-promotion.service.ts:416 | engagement → identity-org / User | git blame 9b11babc025c（2026-07-11；Phase 2 登记 PR 未改违规代码行） |
| XW-0192 | predicate | src/modules/recruitment/recruitment-promotion.service.ts:422 | engagement → identity-org / User | git blame 9b11babc025c（2026-07-11；Phase 2 登记 PR 未改违规代码行） |
| XW-0193 | predicate | src/modules/recruitment/recruitment-promotion.service.ts:863 | engagement → identity-org / Organization | git blame 4a9e7ff319be（2026-06-24；Phase 2 登记 PR 未改违规代码行） |
| XW-0194 | predicate | src/modules/role-bindings/role-bindings.service.ts:127 | platform-access → identity-org / User | git blame 36532e5b573e（2026-07-18；Phase 2 登记 PR 未改违规代码行） |
| XW-0195 | predicate | src/modules/role-bindings/role-bindings.service.ts:138 | platform-access → identity-org / User | git blame 00ca96489397（2026-07-01；Phase 2 登记 PR 未改违规代码行） |
| XW-0196 | predicate | src/modules/role-bindings/role-bindings.service.ts:144 | platform-access → identity-org / Member | git blame 36532e5b573e（2026-07-18；Phase 2 登记 PR 未改违规代码行） |
| XW-0197 | predicate | src/modules/role-bindings/role-bindings.service.ts:177 | platform-access → identity-org / Member | git blame 36532e5b573e（2026-07-18；Phase 2 登记 PR 未改违规代码行） |
| XW-0198 | predicate | src/modules/role-bindings/role-bindings.service.ts:360 | platform-access → identity-org / User | git blame 444ee4a80782（2026-07-04；Phase 2 登记 PR 未改违规代码行） |
| XW-0199 | predicate | src/modules/team-join/team-join-applications.app.service.ts:127 | engagement → identity-org / Organization | git blame 65c142156a99（2026-07-12；Phase 2 登记 PR 未改违规代码行） |
| XW-0200 | predicate | src/modules/team-join/team-join-cycles.service.ts:239 | engagement → identity-org / Organization | git blame 65c142156a99（2026-07-12；Phase 2 登记 PR 未改违规代码行） |
| XW-0201 | predicate | src/modules/team-join/team-join-enrollment-invariant.ts:49 | engagement → identity-org / Member | git blame 46f927d8d48c（2026-08-01；Phase 2 登记 PR 未改违规代码行） |
| XW-0202 | predicate | src/modules/team-join/team-join-enrollment.service.ts:179 | engagement → identity-org / Organization | git blame fe3501bdb1dc（2026-06-20；Phase 2 登记 PR 未改违规代码行） |
| XW-0203 | predicate | src/modules/team-join/team-join-enrollment.service.ts:214 | engagement → identity-org / Member | git blame fe3501bdb1dc（2026-06-20；Phase 2 登记 PR 未改违规代码行） |
| XW-0204 | raw | src/modules/users/user-wecom-binding.service.ts:264 | identity-org → comms / WecomSettings | git blame 74067bf125cb（2026-08-02；Phase 2 登记 PR 未改违规代码行） |

## 6. allowedEdges 拍板表

计数定义：**import** = `cross-domain-import` 实测条数；**跨域访问** = 非 import/cycle 的跨域 DB 读、写与 raw 命中条数。直接 DB 访问只证明存量依赖存在，**不**证明该边应被批准，也不豁免任何债务。

| 声明边 | kind | 实际 import | 跨域访问 | 建议 |
| --- | --- | --- | --- | --- |
| identity-org→platform-core | public-surface | 0 | 5 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| identity-org→platform-access | public-surface | 0 | 1 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| identity-org→comms | public-surface | 0 | 2 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| engagement→identity-org | declared-business | 0 | 35 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| engagement→credentials | declared-business | 0 | 5 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| engagement→participation | declared-business | 0 | 2 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| engagement→platform-core | public-surface | 0 | 3 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| engagement→platform-access | public-surface | 0 | 0 | 疑似冗余：建议删除，除非维护者给出未来设计依据 |
| engagement→comms | public-surface | 0 | 0 | 疑似冗余：建议删除，除非维护者给出未来设计依据 |
| participation→identity-org | declared-business | 0 | 55 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| participation→credentials | declared-business | 0 | 0 | 疑似冗余：建议删除，除非维护者给出未来设计依据 |
| participation→insurance | declared-business | 0 | 0 | 疑似冗余：建议删除，除非维护者给出未来设计依据 |
| participation→platform-core | public-surface | 0 | 10 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| participation→platform-access | public-surface | 0 | 3 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| participation→comms | public-surface | 0 | 0 | 疑似冗余：建议删除，除非维护者给出未来设计依据 |
| insurance→identity-org | declared-business | 0 | 6 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| insurance→credentials | declared-business | 0 | 0 | 疑似冗余：建议删除，除非维护者给出未来设计依据 |
| insurance→platform-core | public-surface | 0 | 0 | 疑似冗余：建议删除，除非维护者给出未来设计依据 |
| insurance→platform-access | public-surface | 0 | 0 | 疑似冗余：建议删除，除非维护者给出未来设计依据 |
| credentials→identity-org | declared-business | 0 | 2 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| credentials→platform-core | public-surface | 0 | 4 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| credentials→platform-access | public-surface | 0 | 0 | 疑似冗余：建议删除，除非维护者给出未来设计依据 |
| content→platform-core | declared-business | 0 | 2 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| content→platform-access | public-surface | 0 | 0 | 疑似冗余：建议删除，除非维护者给出未来设计依据 |
| content→comms | public-surface | 0 | 0 | 疑似冗余：建议删除，除非维护者给出未来设计依据 |
| comms→identity-org | read-only-query | 0 | 39 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| comms→platform-core | public-surface | 0 | 2 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| comms→platform-access | public-surface | 0 | 4 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |
| platform-access→platform-core | public-surface | 0 | 3 | 有实测访问：仅作拍板依据，不等于豁免直接 DB 访问 |

### 已发生但尚未声明的方向

这些方向不应由本期擅自补进 `allowedEdges`；其中的 import/访问可能是历史债、平台反向依赖或后续拆解对象，留给维护者逐项决定。

| 方向 | 实际 import | 跨域访问 |
| --- | --- | --- |
| comms→content | 3 | 0 |
| comms→credentials | 0 | 5 |
| comms→insurance | 0 | 4 |
| comms→participation | 1 | 3 |
| content→identity-org | 4 | 2 |
| credentials→engagement | 0 | 2 |
| engagement→insurance | 2 | 0 |
| identity-org→engagement | 3 | 0 |
| identity-org→participation | 2 | 3 |
| insurance→engagement | 0 | 1 |
| insurance→participation | 0 | 3 |
| participation→engagement | 7 | 2 |
| platform-access→comms | 0 | 1 |
| platform-access→credentials | 0 | 1 |
| platform-access→engagement | 0 | 2 |
| platform-access→identity-org | 3 | 34 |
| platform-access→participation | 9 | 15 |
| platform-core→content | 2 | 7 |
| platform-core→credentials | 0 | 4 |
| platform-core→identity-org | 2 | 10 |
| platform-core→participation | 3 | 22 |
| platform-core→platform-access | 17 | 1 |

**建议拍板方式**：保留有非零实测的声明边，但明确“只允许将来经确认的 public surface / 属主谓词 / tx 原语”；11 条 0/0 声明边建议删除，除非维护者给出明确的未来设计依据。确认前不改 `domain-map.json`。

## 7. publicSurface 拍板提案

下表仅列目前 Nest `@Module({ exports })` 的真实导出；它们是候选面，不自动等于跨域可用面。未发现 exports 的域/模块不因目录存在而获得公开资格。

| 域 | 现有模块 exports（实测） | 提案边界 |
| --- | --- | --- |
| comms | notifications/notifications.module.ts: NotificationOutboxService<br>sms/sms.module.ts: SmsSettingsService, SmsProviderRouter, SmsCodeService<br>wechat/wechat.module.ts: WechatService, WechatSettingsService<br>wecom/wecom.module.ts: WecomService, WecomSettingsService, WecomAuthAttemptService | 确认 outbox、SMS、微信、企微现有 exports；不得作为业务表写入口。 |
| content | （未发现 @Module exports） | 当前未见 Nest exports；保持待定。 |
| credentials | certificates/certificates.module.ts: CertificateRecognitionResolver, CertificateEvidenceSigner, CertificateQualificationService | 确认现有 recognition/evidence/qualification exports；发号原语待 Phase 7。 |
| engagement | （未发现 @Module exports） | 当前未见 Nest exports；不因业务编排债默认开放。 |
| identity-org | auth/auth.module.ts: IdentityStepUpService<br>member-profiles/member-profiles.module.ts: MemberQualificationFactsService<br>members/members.module.ts: MembersService<br>organizations/organizations.module.ts: OrganizationsService<br>position-assignments/position-assignments.module.ts: PositionAssignmentsService<br>realname/realname.module.ts: RealnameVerificationService, RealnameSettingsService<br>supervision-assignments/supervision-assignments.module.ts: SupervisionAssignmentsService<br>users/users.module.ts: AppIdentityResolver | 确认现有身份/组织 services；单独列 users/wecom-identity-revoke.ts 的 InTx 原语。 |
| insurance | insurances/insurances.module.ts: InsuranceRequirementService | 仅确认 InsuranceRequirementService；提醒认领原语待 D 档/Phase 7。 |
| participation | activities/activities.module.ts: ActivitiesService, EvidenceSealService, SettlementDraftService, SettlementDraftDispatchService, SettlementSubmitService, SettlementReviewService, LedgerPreparationService, ActivityBatchWorker, LedgerPostingService, LedgerQueryService, ActivityClosureService, CorrectionApplicationService, AppMyActivitiesService, ActivityParticipationPolicy, ActivityPublishReviewService, ActivityResponsibilityPolicy, ActivityResponsibilityService, AppManagedActivitiesService, ActivityWorkflowQueryService, ActivityMemberOffboardImpactService, ActivityQualificationEvaluatorService<br>activities/activity-batch-worker.module.ts: ActivityBatchWorker<br>activity-feedbacks/activity-feedbacks.module.ts: ActivityFeedbacksQueryService | 确认活动/反馈现有 exports；报名/考勤原语待 Phase 7 实现后再进入 surface。 |
| platform-access | authz/authz.module.ts: AuthzService<br>permissions/permissions.module.ts: RbacService, RoleDelegationPolicy, LastAdminProtectionPolicy | 确认 AuthzService / RbacService 等稳定 token；role-bindings 未见 Nest exports，不新增暗门。 |
| platform-core | attachments/attachments.module.ts: AttachmentsService, AttachmentContentValidator<br>audit-logs/audit-logs.module.ts: AuditLogsService<br>storage/storage.module.ts: StorageSettingsService, StorageCryptoService, StorageProviderRouter, StorageObjectLedgerService, STORAGE_PROVIDER | 仅确认现有模块 exports；禁止将 raw SQL 视为 public surface。 |

### tx 原语文件

- 现有、具名且导出的 tx 原语：`src/modules/users/wecom-identity-revoke.ts` → `revokeActiveWecomIdentityInTx`。
- §4 中列出的 `*.primitive.ts（拟建）` 都是偿债候选，需在对应 Phase 7 目标实际实现、带事务语义说明和验证后，才可加入 `publicSurface`；本期不创建文件、不开放出口。

**建议拍板方式**：先确认“现有 module exports + `revokeActiveWecomIdentityInTx`”为初版 public surface；所有新增 tx 原语随 Phase 7 偿债 PR 逐条扩面。确认前不把任何拟建文件写入 domain-map。

## 8. D5 hooks 环境耦合修复

- 修复前：干净 detached worktree（无 token、复用 node_modules）因 Prisma 生成物 mtime 早于 checkout 的 schema，四个 fake-preflight 对照在环境检查阶段提前退出，读数为 **52 passed / 4 failed**；带维护者 token 的当前 worktree 为绿，形成环境依赖。
- 修复后：selftest 启动时隔离 red-zone token 和 preflight marker；仅对 fake-preflight 对照临时固定 Prisma 生成物时间戳，结束恢复原值。
- 验证：干净 detached worktree（无 token）与当前带维护者 token worktree 均为 **56 passed / 0 failed**，token 已恢复。未改 hook/Guard 实现。

## 9. Phase 3 Exit Criteria 现状

| 规则 | 当前状态 | 尚缺，不得翻 blocking |
| --- | --- | --- |
| R2/R3 | ☐ | `allowedEdges` 尚未拍板；依赖/环 baseline 与 ratchet、误报处理、稳定性、回滚和 AI 反馈闭环均未验收。 |
| R5 | 🟡 | 台账语义 100%、raw 通道、typed-AST 自测已具备；但 architecture-debt 尚未接入 ratchet-registry，属主原语各域验证样例、嵌套自开事务阳性对照、稳定期/Journey/一键回退均未完成。 |
| R6 | ☐（设计决定） | v4 决定长期 report-only；若日后升级，另需谓词规则与误报率专项评审。 |
| R8 T1/T2 | ☐ | 当前 T3=113 未完成显式标注；其余可判范围、稳定期、回滚与完整 EC 尚未逐项验收。 |
| R9 | ☐ | Guard 仍 report；Phase 1D 六条件、本期未复验的 Journey 与 red-first 证据不可省略。 |
| R11/R14 | ☐ | 本期禁区；语义 diff、Environment 审批与阳性对照由独立目标处理。 |
| R12/R13/R15 | ☐ | Journey、聚合 required、common 治理均不在本期范围，未作升级验收。 |

## 10. 本次未做

- 未修改 `src/**`、`prisma/**`、既有测试断言、业务行为、schema/migration 或任何 blocking 开关。
- 未补 R8 T3 的 113 条标注；未做 R11/R14、FE codegen、状态机、authz 倒置、大 service 拆分或物理目录治理。
- 未把任何第三档语义查询塞入 allowlist；未把历史直接 DB 访问宣布为合法边。
- 未拍板 `allowedEdges` / `publicSurface`，未改其 `confirmed` 或 `decisionsPending`。

## 11. 维护者待拍事项

1. `allowedEdges`：是否按 §6 的保留/删除建议确认 29 条声明边，特别是 11 条 0/0 疑似冗余声明。
2. `publicSurface`：是否确认 §7 的“现有 module exports + `revokeActiveWecomIdentityInTx`”最小面，并规定新增 tx 原语随 Phase 7 偿债 PR 单独拍板。

维护者确认后，才将对应对象 `confirmed` 置为 true，并清空 `decisionsPending`。
