# 审计事件登记表(AUDIT_EVENT_REGISTRY)

> **`AuditLogEvent` union 的对外登记表** —— P2-23 剩余半(Audit events)的落点,2026-08-27 交付。
> 合同 ④「字典、Audit events … 生成并对账」在此半上此前**零判据**:事件名虽已被
> `src/modules/audit-logs/audit-logs.types.ts` 的闭 union 收编(TS 静态锁调用点),
> 但「union 里有哪些事件」没有任何对外清单 —— ④-b 的签字只能「接受现状」。
> 本表把那半变成**逐条点名、机器核对**的清单。
>
> **机器核对**(判据本体在 `scripts/check-audit-event-registry.ts`(红区);薄运行器 `src/modules/audit-logs/audit-event-registry.spec.ts`;双向集合相等):
> union 里每个事件都必须登记在册(**漏登记 ⇒ 红**);本表每条都必须真在 union 里
> (**多登记 / 已消失 ⇒ 红**);每条的「仓内出现次数」与 AST 全仓扫描**逐条相等**
> (**漂移 ⇒ 红**);零产出事件必须显式标注(**静默死事件 ⇒ 红**)。
> ⇒ 改 union(审计事件的新增/退役)= 同一 PR 必须同步改本表,否则 CI 红。
>
> **计数口径**:「仓内出现次数」= AST 字符串字面量在 `src/**`(排除本登记表引用的
> `audit-logs.types.ts` 与所有 `.spec.ts`)中出现的次数 —— 含常量定义与三元分支,
> **不含注释**。它是「事件被代码点名」的计数,不是运行时写入量的计数。
>
> **三条写库漏斗**(全部 `event: AuditLogEvent` 类型锁,新增事件不进 union 编译不过):
> `AuditLogsService.log()` · `writeConfigAudit()`(permissions)· `user-roles.service` 内联薄封装。

**审计事件(机器核对):157 个 · 活跃(≥1 次出现):152 · 已退役/零产出:5**


## profile

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `profile.read.other` | 1 |  |

## emergency-contact

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `emergency-contact.read.other` | 1 |  |
| `emergency-contact.write` | 4 |  |

## certificate

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `certificate.read.other` | 5 |  |
| `certificate.read.qualification-flag` | 1 |  |
| `certificate.create` | 1 |  |
| `certificate.update` | 1 |  |
| `certificate.delete` | 1 |  |
| `certificate.verify` | 1 |  |
| `certificate.reject` | 1 |  |
| `certificate.expire` | 1 |  |

## certificate-standard

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `certificate-standard.change` | 1 |  |

## certificate-recognition-policy

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `certificate-recognition-policy.change` | 1 |  |

## recruitment-certificate-claim

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `recruitment-certificate-claim.submit` | 3 |  |
| `recruitment-certificate-claim.review` | 1 |  |
| `recruitment-certificate-claim.review-revoke` | 1 |  |

## contribution-rule

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `contribution-rule.create` | 1 |  |
| `contribution-rule.update` | 1 |  |
| `contribution-rule.delete` | 1 |  |

## activity

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `activity.publish` | 22 | AC-010 改期联动 +1(2026-08-28,extra.operation=activity-session-reschedule)；A7 生成独立 Activity 复用该事件，以 `extra.operation=generate_series_instance` 区分 |

## activity-series

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `activity-series.change` | 1 | Activity OS R1 / A7：Series 创建、Revision 追加、生命周期变更与按需生成的安全审计；实例 Activity 仍使用 `activity.publish` |

## registration

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `registration.create` | 3 |  |
| `registration.review` | 9 |  |

## invitation

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `invitation.change` | 1 |  |

## visitor

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `visitor.create` | 1 |  |

## attendance-sheet

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `attendance-sheet.submit` | 1 |  |
| `attendance-sheet.edit` | 3 |  |
| `attendance-sheet.delete` | 1 |  |
| `attendance-sheet.review` | 1 |  |
| `attendance-sheet.final-review` | 1 |  |
| `attendance-sheet.reopen` | 1 |  |
| `attendance-sheet.read.other` | 1 |  |

## attachment

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `attachment.upload` | 1 |  |
| `attachment.delete` | 1 |  |
| `attachment.config.change` | 11 |  |

## password

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `password.change.self` | 1 |  |
| `password.reset.by-admin` | 1 |  |
| `password.reset.by-sms` | 1 |  |

## auth

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `auth.login` | 2 |  |
| `auth.login.sms` | 2 |  |
| `auth.refresh` | 3 |  |
| `auth.logout` | 1 |  |
| `auth.logout-all` | 1 |  |
| `auth.login.wechat` | 3 |  |
| `auth.step-up` | 1 |  |
| `auth.login.wecom` | 3 |  |

## integration

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `service-principal.create` | 1 |  |
| `service-principal.update` | 1 |  |
| `service-principal.status-change` | 1 |  |
| `service-principal.credential-create` | 1 |  |
| `service-principal.credential-revoke` | 1 |  |
| `delegation-grant.create` | 1 |  |
| `delegation-grant.revoke` | 1 |  |
| `auth.service-token` | 1 |  |
| `auth.delegated-token` | 1 |  |

## phone

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `phone.bind.self` | 1 |  |
| `phone.rebind.self` | 1 |  |
| `phone.clear.by-admin` | 1 |  |

## wechat

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `wechat.bind.self` | 2 |  |
| `wechat.rebind.self` | 2 |  |
| `wechat.clear.by-admin` | 1 |  |

## member-insurance

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `member-insurance.read.other` | 11 |  |
| `member-insurance.review` | 1 |  |
| `member-insurance.create.self` | 1 |  |
| `member-insurance.update.self` | 1 |  |
| `member-insurance.delete.self` | 1 |  |

## team-insurance-policy

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `team-insurance-policy.create` | 1 |  |
| `team-insurance-policy.update` | 1 |  |
| `team-insurance-policy.delete` | 1 |  |

## team-insurance-coverage

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `team-insurance-coverage.add` | 2 |  |
| `team-insurance-coverage.remove` | 1 |  |

## recruitment-cycle

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `recruitment-cycle.create` | 1 |  |
| `recruitment-cycle.update` | 1 |  |

## recruitment-application

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `recruitment-application.submit` | 1 |  |
| `recruitment-application.realname-verify` | 1 |  |
| `recruitment-application.resolve-manual` | 1 |  |
| `recruitment-application.read.other` | 7 |  |
| `recruitment-application.id-card-image.read` | 1 |  |
| `recruitment-application.update` | 1 |  |
| `recruitment-application.mark-threshold` | 1 |  |
| `recruitment-application.threshold-recompute` | 1 |  |
| `recruitment-application.evaluate` | 1 |  |
| `recruitment-application.promote` | 1 |  |
| `recruitment-application.rebind-wechat` | 1 |  |
| `recruitment-application.rebind-phone` | 1 |  |
| `recruitment-application.withdraw` | 1 |  |
| `recruitment-application.certificate-upload` | 0 | 已退役(#830 PR-4a-2,2026-07-30 删旧 category 端点;词条刻意保留,union 已补标注) |
| `recruitment-application.certificate-review` | 0 | 已退役(同上,随 #830 退役;union 已补标注) |

## team-join-cycle

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `team-join-cycle.create` | 1 |  |
| `team-join-cycle.update` | 1 |  |

## team-join-application

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `team-join-application.mark-gate` | 1 |  |
| `team-join-application.evaluate` | 1 |  |
| `team-join-application.submit` | 1 |  |
| `team-join-application.update-targets` | 1 |  |
| `team-join-application.join` | 1 |  |
| `team-join-application.supersede` | 1 |  |

## content

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `content.create` | 1 |  |
| `content.update` | 2 |  |
| `content.delete` | 1 |  |
| `content.publish` | 1 |  |

## notification

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `notification.create` | 1 |  |
| `notification.update` | 1 |  |
| `notification.delete` | 1 |  |
| `notification.publish` | 4 |  |

## position-assignment

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `position-assignment.create` | 1 |  |
| `position-assignment.revoke` | 1 |  |

## supervision-assignment

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `supervision-assignment.create` | 1 |  |
| `supervision-assignment.revoke` | 1 |  |

## role-binding

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `role-binding.create` | 2 |  |
| `role-binding.update` | 1 |  |
| `role-binding.revoke` | 2 |  |

## membership

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `membership.set` | 2 |  |
| `membership.end` | 2 |  |
| `membership.transfer` | 1 |  |

## organization

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `organization.create` | 1 |  |
| `organization.move` | 1 |  |
| `organization.status-change` | 1 |  |
| `organization.delete` | 1 |  |

## member

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `member.account-granted` | 1 |  |
| `member.account-bound` | 1 |  |
| `member.account-unbound` | 1 |  |
| `member.account-reopened` | 1 |  |
| `member.account.status-change` | 1 |  |
| `member.audience-tags.update` | 1 |  |
| `member.identity.correct` | 1 |  |
| `member.offboard` | 1 |  |
| `member.official-portrait.activate` | 1 |  |
| `member.official-portrait.replace` | 1 |  |
| `member.official-portrait.void` | 1 |  |
| `member.official-portrait.purge` | 0 | 零产出:预留事件(#1106 T1 未接,合规清理流程 issue #1055 §5.2 未建;union 已补标注,接通时本表计数自动跟走) |

## rbac-role

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `rbac-role.create` | 1 |  |
| `rbac-role.update` | 1 |  |
| `rbac-role.delete` | 1 |  |

## role-permission

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `role-permission.grant` | 0 | 已退役(union 标注〔已退役 · 无产出者〕;词条刻意保留) |
| `role-permission.revoke` | 0 | 已退役(union 标注〔已退役 · 无产出者〕;词条刻意保留) |
| `role-permission.replace` | 1 |  |

## permission

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `permission.create` | 1 |  |
| `permission.update` | 1 |  |
| `permission.delete` | 1 |  |

## user

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `user.role.update` | 1 |  |
| `user.status.update` | 1 |  |
| `user.soft-delete` | 1 |  |
| `user.avatar.change.self` | 1 |  |
| `user.avatar.clear.self` | 1 |  |

## storage-setting

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `storage-setting.update` | 1 |  |
| `storage-setting.reset-credentials` | 1 |  |

## sms-setting

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `sms-setting.update` | 1 |  |
| `sms-setting.reset-credentials` | 1 |  |

## wechat-setting

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `wechat-setting.update` | 1 |  |
| `wechat-setting.reset-credentials` | 1 |  |

## wecom-setting

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `wecom-setting.update` | 1 |  |
| `wecom-setting.reset-credentials` | 1 |  |

## wecom

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `wecom.bind.self` | 2 |  |
| `wecom.rebind.self` | 2 |  |
| `wecom.clear.by-admin` | 1 |  |

## realname-setting

| event | 仓内出现次数 | 备注 |
|---|---|---|
| `realname-setting.update` | 1 |  |
| `realname-setting.reset-credentials` | 1 |  |
