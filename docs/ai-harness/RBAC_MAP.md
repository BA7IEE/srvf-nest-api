# RBAC_MAP — 权限体系地图与对照表

> **性质**:derived 地图,非规则源。权限**事实**权威源:权限码与绑定 → [`prisma/seed.ts`](../../prisma/seed.ts);判权实现 → [`src/modules/permissions/rbac.service.ts`](../../src/modules/permissions/rbac.service.ts);铁律 → [`auth-jwt-refresh`](../reference/auth-jwt-refresh.md) + [`roles-admin-protection §13`](../reference/roles-admin-protection.md)。

> 历史逐 PR 戳(75 行)已归档至 [`archive/ai-harness/rbac-map-stamps.md`](../archive/ai-harness/rbac-map-stamps.md);
> 派生对照表改为生成物(`pnpm docs:rbacmap`),本文件只保留人类知识与生成段。

## 1. 双轨架构现状(一句话版)

三层 `Role` enum(SUPER_ADMIN > ADMIN > USER,Guard 链全局注册:`ThrottlerBizGuard → JwtAuthGuard → RolesGuard`)是**身份层**；授权事实统一落 RBAC 4 表(`RbacRole` / `Permission` / `RolePermission` / `RoleBinding`〔终态 scoped-authz PR6 起取代旧 `UserRole` 表,已 DROP〕)，运行时有两个有意并存的服务入口：旧 `RbacService.can()` 只认 USER+GLOBAL（兼容锁），`AuthzService.explain/getVisibleOrganizationScope/getEffectivePermissionCodes` 聚合 direct RoleBinding + 职务 policy + 分管三源并做 resource/scope 判定。

- **管理面 / 配置面 / System surface**:controller 不标 `@Roles`，入口仅要求登录；未接线面继续 Service 层 `rbac.can('<code>')`，SUPER_ADMIN 短路。授权诊断、考勤终审、participation 与 v0.49.0 队员轴/扁平列表改走 `AuthzService`；不能把“全仓判权入口”再简化成只有 `RbacService.can()`。
- **业务面**:Slow-4 已摘清全部 `@Roles`；v0.49.0 当前 scoped 消费者 = participation 点动作 + 两条扁平列表 + 三条 member-axis 查询、members 列表/options/detail/写、certificates/member-profiles/emergency-contacts/member-insurances。列表级组织范围由 `getVisibleOrganizationScope` 下推；member/certificate 只认 active PRIMARY membership，participation 取 activity.organizationId。users/content/notifications/audit-logs、Recruitment、team-join 仍按各自既有 GLOBAL/显式授权语义。**全仓活跃 `@Roles` = 0**；`RolesGuard` 机制与装饰器保留 Guard 链。
- **App surface:不走 RBAC**——仅 JwtAuthGuard + Service 层 `where: { memberId: currentUser.memberId }` self-scope + 准入语义(`memberId != null && User.ACTIVE && Member.ACTIVE`);capabilities 返回产品级能力而非 raw permission code(D-5.3)。
- **没有 `@Permissions` 装饰器 / PermissionsGuard**(已核实不存在)。`RbacService` 的 GLOBAL permission resolution 每请求从 PostgreSQL 解析当前在期 USER RoleBinding → RolePermission → Permission；`AuthzService` 同样不缓存判权/可见范围结果。

<!-- rbac:begin -->
<!-- 由 `pnpm docs:rbacmap` 生成;禁止手改。新鲜度由 `pnpm docs:rbacmap:check` 守护。 -->

## 派生对照表(生成物)

### 权限码全集(222 条,按一级域分组)

> 权威源 `prisma/seed.ts`(幂等 upsert)。本表由 `pnpm docs:rbacmap` 生成,**禁手改**。

| 一级域 | 条数 | 权限码 |
|---|---|---|
| `attachment` | 24 | `attachment.delete.activity` · `attachment.delete.certificate.other` · `attachment.delete.certificate.self` · `attachment.delete.content-file` · `attachment.delete.content-image` · `attachment.delete.member.other` · `attachment.delete.member.self` · `attachment.update.activity` · `attachment.update.certificate.other` · `attachment.update.certificate.self` · `attachment.update.member.other` · `attachment.update.member.self` · `attachment.upload.activity` · `attachment.upload.certificate.other` · `attachment.upload.certificate.self` · `attachment.upload.content-file` · `attachment.upload.content-image` · `attachment.upload.member.other` · `attachment.upload.member.self` · `attachment.view.activity` · `attachment.view.certificate.other` · `attachment.view.certificate.self` · `attachment.view.member.other` · `attachment.view.member.self` |
| `rbac` | 14 | `rbac.config.reload` · `rbac.permission.create` · `rbac.permission.delete` · `rbac.permission.read` · `rbac.permission.update` · `rbac.role-permission.create` · `rbac.role-permission.delete` · `rbac.role.create` · `rbac.role.delete` · `rbac.role.read` · `rbac.role.update` · `rbac.user-role.create` · `rbac.user-role.delete` · `rbac.user-role.read` |
| `attachment-config` | 12 | `attachment-config.create.mime` · `attachment-config.create.size-limit` · `attachment-config.create.type` · `attachment-config.delete.mime` · `attachment-config.delete.size-limit` · `attachment-config.delete.type` · `attachment-config.read.mime` · `attachment-config.read.size-limit` · `attachment-config.read.type` · `attachment-config.update.mime` · `attachment-config.update.size-limit` · `attachment-config.update.type` |
| `attendance` | 11 | `attendance.approve.sheet` · `attendance.create.sheet` · `attendance.delete.sheet` · `attendance.final-approve.sheet` · `attendance.final-reject.sheet` · `attendance.final-return.sheet` · `attendance.read.sheet` · `attendance.reject.sheet` · `attendance.reopen.sheet` · `attendance.return.sheet` · `attendance.update.sheet` |
| `recruitment-application` | 9 | `recruitment-application.evaluate.assessment` · `recruitment-application.mark.threshold` · `recruitment-application.promote.member` · `recruitment-application.promote.single` · `recruitment-application.read.record` · `recruitment-application.read.sensitive` · `recruitment-application.resolve.manual` · `recruitment-application.review.certificate` · `recruitment-application.update.record` |
| `user` | 9 | `user.create.account` · `user.delete.account` · `user.phone.clear` · `user.read.account` · `user.reset.password` · `user.update.account` · `user.update.role` · `user.update.status` · `user.wechat.clear` |
| `dict` | 8 | `dict.create.item` · `dict.create.type` · `dict.delete.item` · `dict.delete.type` · `dict.read.item` · `dict.read.type` · `dict.update.item` · `dict.update.type` |
| `member` | 8 | `member.bind.account` · `member.create.record` · `member.delete.record` · `member.grant.account` · `member.offboard.record` · `member.read.record` · `member.update.record` · `member.update.status` |
| `activity` | 7 | `activity.cancel.record` · `activity.complete.record` · `activity.create.cross-org` · `activity.create.record` · `activity.delete.record` · `activity.publish.record` · `activity.update.record` |
| `certificate` | 7 | `certificate.create.record` · `certificate.delete.record` · `certificate.read.record` · `certificate.read.sensitive` · `certificate.reject.record` · `certificate.update.record` · `certificate.verify.record` |
| `notification` | 7 | `notification.create.record` · `notification.delete.record` · `notification.publish.record` · `notification.read.record` · `notification.send.sms` · `notification.update.record` · `notification.update.template` |
| `activity-registration` | 6 | `activity-registration.approve.record` · `activity-registration.cancel.record` · `activity-registration.create.record` · `activity-registration.read.record` · `activity-registration.reject.record` · `activity-registration.reopen.record` |
| `team-insurance-policy` | 6 | `team-insurance-policy.add.member` · `team-insurance-policy.create.record` · `team-insurance-policy.delete.record` · `team-insurance-policy.read.record` · `team-insurance-policy.remove.member` · `team-insurance-policy.update.record` |
| `content` | 5 | `content.create.record` · `content.delete.record` · `content.publish.record` · `content.read.record` · `content.update.record` |
| `emergency-contact` | 5 | `emergency-contact.create.record` · `emergency-contact.delete.record` · `emergency-contact.read.record` · `emergency-contact.read.sensitive` · `emergency-contact.update.record` |
| `membership` | 5 | `membership.end.record` · `membership.list.record` · `membership.read.record` · `membership.set.record` · `membership.transfer.record` |
| `org` | 5 | `org.create.node` · `org.delete.node` · `org.move.node` · `org.read.node` · `org.update.node` |
| `certificate-recognition-policy` | 4 | `certificate-recognition-policy.create.record` · `certificate-recognition-policy.delete.record` · `certificate-recognition-policy.read.record` · `certificate-recognition-policy.update.record` |
| `certificate-standard` | 4 | `certificate-standard.create.record` · `certificate-standard.delete.record` · `certificate-standard.read.record` · `certificate-standard.update.record` |
| `contribution` | 4 | `contribution.create.rule` · `contribution.delete.rule` · `contribution.read.rule` · `contribution.update.rule` |
| `member-profile` | 4 | `member-profile.create.record` · `member-profile.read.record` · `member-profile.read.sensitive` · `member-profile.update.record` |
| `position` | 4 | `position.create.definition` · `position.delete.definition` · `position.read.definition` · `position.update.definition` |
| `position-assignment` | 4 | `position-assignment.create.record` · `position-assignment.read.history` · `position-assignment.read.record` · `position-assignment.revoke.record` |
| `position-rule` | 4 | `position-rule.create.record` · `position-rule.delete.record` · `position-rule.read.record` · `position-rule.update.record` |
| `role-binding` | 4 | `role-binding.create.record` · `role-binding.delete.record` · `role-binding.read.record` · `role-binding.update.record` |
| `supervision-assignment` | 4 | `supervision-assignment.create.record` · `supervision-assignment.read.record` · `supervision-assignment.revoke.record` · `supervision-assignment.update.record` |
| `team-join-application` | 4 | `team-join-application.evaluate.assessment` · `team-join-application.join.member` · `team-join-application.mark.gate` · `team-join-application.read.record` |
| `authz` | 3 | `authz.action-state.decision` · `authz.explain-batch.decision` · `authz.explain.decision` |
| `member-department` | 3 | `member-department.clear.current` · `member-department.read.current` · `member-department.set.current` |
| `realname-setting` | 3 | `realname-setting.read.singleton` · `realname-setting.reset.credentials` · `realname-setting.update.singleton` |
| `recruitment-cycle` | 3 | `recruitment-cycle.create.record` · `recruitment-cycle.read.record` · `recruitment-cycle.update.record` |
| `sms-setting` | 3 | `sms-setting.read.singleton` · `sms-setting.reset.credentials` · `sms-setting.update.singleton` |
| `storage-setting` | 3 | `storage-setting.read.singleton` · `storage-setting.reset.credentials` · `storage-setting.update.singleton` |
| `team-join-cycle` | 3 | `team-join-cycle.create.record` · `team-join-cycle.read.record` · `team-join-cycle.update.record` |
| `wechat-setting` | 3 | `wechat-setting.read.singleton` · `wechat-setting.reset.credentials` · `wechat-setting.update.singleton` |
| `activity-review` | 2 | `activity-review.read.request` · `activity-review.return.request` |
| `announcement-import` | 2 | `announcement-import.execute.record` · `announcement-import.preview.record` |
| `member-insurance` | 2 | `member-insurance.read.other` · `member-insurance.review.record` |
| `activity-responsibility` | 1 | `activity-responsibility.override.record` |
| `audit-log` | 1 | `audit-log.read.entry` |
| `meta` | 1 | `meta.resolve.label` |
| `sms-send-log` | 1 | `sms-send-log.read.list` |

### controller × surface 对照(84 个 @Controller)

> 权威源:`src/**/*.controller.ts` 的 `@Controller(...)` 装饰器。本表由 `pnpm docs:rbacmap` 生成,**禁手改**。
> 鉴权模式(R / A / P)与业务语义属人类知识,见本文件标记之外的章节。

#### admin/v1(45 个 controller)

| 路由前缀 | 文件 |
|---|---|
| `admin/v1` | `src/modules/announcement-import/announcement-import.controller.ts` |
| `admin/v1` | `src/modules/authz/action-state.controller.ts` |
| `admin/v1` | `src/modules/authz/authz.controller.ts` |
| `admin/v1` | `src/modules/certificates/certificate-recognition-policies.controller.ts` |
| `admin/v1` | `src/modules/member-departments/memberships-admin.controller.ts` |
| `admin/v1` | `src/modules/position-assignments/position-assignments.controller.ts` |
| `admin/v1` | `src/modules/role-bindings/role-bindings.controller.ts` |
| `admin/v1` | `src/modules/supervision-assignments/supervision-assignments.controller.ts` |
| `admin/v1/activities` | `src/modules/activities/activities.controller.ts` |
| `admin/v1/activities` | `src/modules/activities/controllers/admin-activity-positions.controller.ts` |
| `admin/v1/activities/:activityId` | `src/modules/activities/controllers/admin-activity-participation.controller.ts` |
| `admin/v1/activities/:activityId` | `src/modules/activity-feedbacks/controllers/admin-activity-feedbacks.controller.ts` |
| `admin/v1/activities/:activityId` | `src/modules/attendances/controllers/admin-activity-check-ins.controller.ts` |
| `admin/v1/activities/:activityId/attendance-sheets` | `src/modules/attendances/attendances.controller.ts` |
| `admin/v1/activities/:activityId/registrations` | `src/modules/activity-registrations/activity-registrations.controller.ts` |
| `admin/v1/activities/:activityId/responsibilities` | `src/modules/activities/controllers/admin-activity-responsibilities.controller.ts` |
| `admin/v1/activity-publish-reviews` | `src/modules/activities/controllers/admin-activity-publish-reviews.controller.ts` |
| `admin/v1/attachments` | `src/modules/attachments/attachments.controller.ts` |
| `admin/v1/attendance-sheets` | `src/modules/attendances/attendances.controller.ts` |
| `admin/v1/certificate-standards` | `src/modules/certificates/certificate-standards.controller.ts` |
| `admin/v1/contents` | `src/modules/content/content-admin.controller.ts` |
| `admin/v1/me` | `src/modules/users/controllers/admin-me.controller.ts` |
| `admin/v1/members` | `src/modules/members/members.controller.ts` |
| `admin/v1/members/:memberId` | `src/modules/attendances/controllers/admin-member-attendance.controller.ts` |
| `admin/v1/members/:memberId/certificates` | `src/modules/certificates/certificates.controller.ts` |
| `admin/v1/members/:memberId/department` | `src/modules/member-departments/member-departments.controller.ts` |
| `admin/v1/members/:memberId/emergency-contacts` | `src/modules/emergency-contacts/emergency-contacts.controller.ts` |
| `admin/v1/members/:memberId/insurances` | `src/modules/insurances/admin-member-insurances.controller.ts` |
| `admin/v1/members/:memberId/memberships` | `src/modules/member-departments/memberships.controller.ts` |
| `admin/v1/members/:memberId/profile` | `src/modules/member-profiles/member-profiles.controller.ts` |
| `admin/v1/members/:memberId/registrations` | `src/modules/activity-registrations/controllers/admin-registrations.controller.ts` |
| `admin/v1/meta` | `src/modules/meta/meta.controller.ts` |
| `admin/v1/notification-wechat-templates` | `src/modules/notifications/notification-wechat-template.admin.controller.ts` |
| `admin/v1/notifications` | `src/modules/notifications/notification-admin.controller.ts` |
| `admin/v1/organizations` | `src/modules/organizations/organizations.controller.ts` |
| `admin/v1/position-rules` | `src/modules/positions/position-rules.controller.ts` |
| `admin/v1/positions` | `src/modules/positions/positions.controller.ts` |
| `admin/v1/recruitment` | `src/modules/recruitment/recruitment-certificate-claims.admin.controller.ts` |
| `admin/v1/recruitment/applications` | `src/modules/recruitment/recruitment-applications.admin.controller.ts` |
| `admin/v1/recruitment/cycles` | `src/modules/recruitment/recruitment-cycles.controller.ts` |
| `admin/v1/registrations` | `src/modules/activity-registrations/controllers/admin-registrations.controller.ts` |
| `admin/v1/team-insurance-policies` | `src/modules/insurances/team-insurance-policies.controller.ts` |
| `admin/v1/team-join/applications` | `src/modules/team-join/team-join-applications.admin.controller.ts` |
| `admin/v1/team-join/cycles` | `src/modules/team-join/team-join-cycles.controller.ts` |
| `admin/v1/users` | `src/modules/users/users.controller.ts` |

#### app/v1(17 个 controller)

| 路由前缀 | 文件 |
|---|---|
| `app/v1/activities` | `src/modules/activities/controllers/app-activities.controller.ts` |
| `app/v1/contents` | `src/modules/content/content-app.controller.ts` |
| `app/v1/me` | `src/modules/users/controllers/app-me.controller.ts` |
| `app/v1/me/insurances` | `src/modules/insurances/controllers/app-me-insurances.controller.ts` |
| `app/v1/me/team-join` | `src/modules/team-join/team-join-applications.app.controller.ts` |
| `app/v1/my` | `src/modules/activity-registrations/controllers/app-my-registrations.controller.ts` |
| `app/v1/my` | `src/modules/attendances/controllers/app-my-attendance-records.controller.ts` |
| `app/v1/my` | `src/modules/attendances/controllers/app-my-participation-summary.controller.ts` |
| `app/v1/my` | `src/modules/certificates/controllers/app-my-certificates.controller.ts` |
| `app/v1/my/activities/:activityId` | `src/modules/attendances/controllers/app-activity-check-ins.controller.ts` |
| `app/v1/my/activities/:activityId/feedback` | `src/modules/activity-feedbacks/controllers/app-activity-feedbacks.controller.ts` |
| `app/v1/my/managed-activities` | `src/modules/activities/controllers/app-managed-activities.controller.ts` |
| `app/v1/my/managed-activities/:activityId` | `src/modules/activities/controllers/app-managed-activity-responsibilities.controller.ts` |
| `app/v1/my/managed-activities/:activityId` | `src/modules/attendances/controllers/app-managed-activity-attendances.controller.ts` |
| `app/v1/my/managed-activities/:activityId/positions` | `src/modules/activities/controllers/app-managed-activity-positions.controller.ts` |
| `app/v1/my/managed-activities/:activityId/registrations` | `src/modules/activity-registrations/controllers/app-managed-activity-registrations.controller.ts` |
| `app/v1/notifications` | `src/modules/notifications/notification-app.controller.ts` |

#### auth/v1(1 个 controller)

| 路由前缀 | 文件 |
|---|---|
| `auth/v1` | `src/modules/auth/auth.controller.ts` |

#### open/v1(2 个 controller)

| 路由前缀 | 文件 |
|---|---|
| `open/v1/contents` | `src/modules/content/content-public.controller.ts` |
| `open/v1/recruitment` | `src/modules/recruitment/recruitment-public.controller.ts` |

#### system/v1(19 个 controller)

| 路由前缀 | 文件 |
|---|---|
| `system/v1/attachment-mime-configs` | `src/modules/attachment-configs/attachment-mime-configs.controller.ts` |
| `system/v1/attachment-size-limit-configs` | `src/modules/attachment-configs/attachment-size-limit-configs.controller.ts` |
| `system/v1/attachment-type-configs` | `src/modules/attachment-configs/attachment-type-configs.controller.ts` |
| `system/v1/audit-logs` | `src/modules/audit-logs/audit-logs.controller.ts` |
| `system/v1/authz` | `src/modules/authz/effective-permissions.controller.ts` |
| `system/v1/contribution-rules` | `src/modules/contribution-rules/contribution-rules.controller.ts` |
| `system/v1/dict-items` | `src/modules/dictionaries/dictionaries.controller.ts` |
| `system/v1/dict-types` | `src/modules/dictionaries/dictionaries.controller.ts` |
| `system/v1/health` | `src/modules/health/health.controller.ts` |
| `system/v1/permissions` | `src/modules/permissions/permissions.controller.ts` |
| `system/v1/rbac` | `src/modules/permissions/rbac.controller.ts` |
| `system/v1/realname-settings` | `src/modules/realname/realname-settings.controller.ts` |
| `system/v1/roles` | `src/modules/permissions/rbac-roles.controller.ts` |
| `system/v1/roles/:id/permissions` | `src/modules/permissions/role-permissions.controller.ts` |
| `system/v1/sms-send-logs` | `src/modules/sms/sms-send-logs.controller.ts` |
| `system/v1/sms-settings` | `src/modules/sms/sms-settings.controller.ts` |
| `system/v1/storage-settings` | `src/modules/storage/storage-settings.controller.ts` |
| `system/v1/users/:userId/roles` | `src/modules/permissions/user-roles.controller.ts` |
| `system/v1/wechat-settings` | `src/modules/wechat/wechat-settings.controller.ts` |

<!-- rbac:end -->

## 4. 保护不变式(改 users / permissions 前必读)

| 不变式 | 实现位置 | 铁律 |
|---|---|---|
| 自我保护 | `users.service.ts` `assertCanManageUser`(删/禁/改角色拒绝 self) | [`roles-admin-protection`](../reference/roles-admin-protection.md) |
| 最后一个活跃 SUPER_ADMIN ≥ 1 | 同上,**事务内计数 + 更新** | [`soft-delete-transactions`](../reference/soft-delete-transactions.md) / [`roles-admin-protection`](../reference/roles-admin-protection.md);**禁止** AI 增加"SA 互不可操作"校验 |
| ops-admin 当前有效与常驻 holder 各 ≥ 1 | `LastAdminProtectionPolicy`（role-bindings / user-roles / users / members） | seed 与只读 preflight 同谓词；统一 advisory 后重读 |
| ADMIN 只能管 USER | `assertCanManageUser` 统一入口;**禁止** service 内散落 `role ===` 比较(已核实 0 处) | [`roles-admin-protection`](../reference/roles-admin-protection.md) |
| 身份有效性不缓存 | `JwtStrategy.validate` 每请求查库(`deletedAt + status`) | [`auth-jwt-refresh`](../reference/auth-jwt-refresh.md);GLOBAL 权限解析亦由 `RbacService` 每请求读 DB，无缓存例外 |
| 防账号枚举 | 登录四场景统一 10004 + dummy bcrypt timing 防御 | [`auth-jwt-refresh`](../reference/auth-jwt-refresh.md) |
| Guard 全局注册 | `app.module.ts` APP_GUARD ×3,顺序固定;**全仓 0 处 `@UseGuards`**(已核实) | [`auth-jwt-refresh`](../reference/auth-jwt-refresh.md) |

## 5. 缺口与冻结存量(AI 不得"顺手修")

| 项 | 状态 | 谁拍板 |
|---|---|---|
| 7 个业务模块接入 `rbac.can()`(Slow-4) | ✅ 已完成(2026-06-11 goal #314-#317;Slow-3 决议 = `biz-admin` 承载全量业务权限) | 已决 |
| `rbac.controller.ts` `GET me/permissions` 方法级 Mixed | 存量冻结(P1-A 不拆),返回 raw code 仅限该 system 端点;App 端能力走 `me/capabilities` | 用户 |
| `dictionaries.controller.ts` 同文件双 controller | 非 surface Mixed,存量冻结不扩展 | 用户 |
| Swagger 不体现权限码要求 | ✅ 已闭环(2026-06-10 P2-2 #287):全部 148 endpoint summary 统一鉴权后缀(`[rbac:]`/`[roles:]`/`[public]`/`[auth]`),`docs:rbacmap:check` 检查项 G(#288)锁后缀↔装饰器/seed 一致性 | 已决;后缀惯例变更走 A/B 档 + 检查项 G 同步 |
| 部门级权限(部长/终审 finalReviewer 细粒度) | ✅ **PR9 已接线(2026-07-02,Slow-3 #277 方案 A 挂账正式解)**:`finalApprove`/`finalReject` 判权走 `authz.explain`(带 ref);真收紧 = 自审禁止 22074(SA 亦拒)+ 一级同人默认禁止 22075(env `ATTENDANCE_ALLOW_SAME_REVIEWER` 可配)+ scoped 通路(attendance-final-reviewer 角色经 POSITION_ASSIGNMENT 主体 RoleBinding);B 方案 biz-admin 终审两码保留(全局终审照旧)。序列前史:T0 冻结稿 [`org-position-scoped-authz-terminal-design-review.md`](../archive/reviews/org-position-scoped-authz-terminal-design-review.md),PR1-7 数据+配置面,PR8 判权大脑,**PR10 explain 端点 / PR11 公告导入 / PR12 逐面迁移第一批(participation:activities/activity-registrations/attendances 三模块 24 处判权切 authz)均已发**。剩余:members/certificates/content/notifications 等业务面逐面迁移(诉求触发再出 goal);摘 biz-admin 终审两码 ✅ **2026-07-03 摘码微刀已摘**(见下行) | 已决 |
| **摘 biz-admin 终审两码**(`attendance.final-{approve,reject}.sheet`;后置独立微刀,PR12(2026-07-02)已改名为「逐面迁移第一批(participation)」,本项非 PR12 范围) | ✅ **已摘(2026-07-03 摘码微刀,goal「终态 scoped-authz 收尾【摘码微刀】」)**:biz-admin 74→**72**(两码保留 Permission 表不删;seed 过滤集 1→3 码 + targeted 幂等清理老库残留)。**挂账解除理由(维护者 2026-07-03 确认)**:项目尚未进入生产 —— 终审真空风险不存在(无现网操作),且 SUPER_ADMIN 经 `super_admin_pass` 恒可终审他人(自审 22074 照拒)= 兜底不断;原前提「运营已实际执行导入 + 已挂绑定」随 pre-production 判定解除,上线初始化顺序(录队员→导公告→BD-2 绑定)归终批 handoff runbook。**⚠️ 判权行为真变**:ADMIN(biz-admin)终审 → 30100;终审权 = scoped 绑定〔任职 + `attendance-final-reviewer`〕或 SUPER_ADMIN;org-admin(派生过滤)码集自动不受影响(本就排除终审两码)。**ops 步骤样例保留(上线后挂 BD-2 绑定用;决断⑥,零代码字面量)**:`POST /api/admin/v1/role-bindings` `{principalType: 'POSITION_ASSIGNMENT', principalId: '<APD 部长任职的 OrganizationPositionAssignment.id>', roleId: '<attendance-final-reviewer 的 RbacRole.id>', scopeType: 'ORGANIZATION_TREE', scopeOrgId: '<总队根组织 id>', startedAt: '<ISO 8601>'}`;该绑定行是终审中枢的唯一真相、可随时换绑(BD-2) | 已决(2026-07-03) |
| **BD-3 两候选码**(`activity.read.record` / `attendance-record.read.record`) | ✅ **PR12(2026-07-02)正式关闭(won't-do,非 defer)**:活动详情 login-only 天然可读、考勤明细经 `attendance.read.sheet` ref 化后即可在分管范围内读单 sheet(含 records);BD-3 读诉求(冻结稿 §2.4)全覆盖,e2e 实证见 `participation-scoped-authz.e2e-spec.ts` org-supervisor 场景。冻结稿 §4.3「实施时二次确认」就此闭环;两码**不加入** §3 权限码全集 | 已决 |

## 6. AI 硬规则(权限相关)

1. 改 `Role` enum / `Permission` seed / `RolePermission` 绑定 / Guard / `JwtStrategy` / throttler → **必然 D 档**:只读调研 → 风险表 → 方案 A/B → 用户拍板 → 评审稿冻结 → 再实施([`process.md §4`](../process.md))。
2. Slow-4 已完成(G 模式清零);**禁止**自行新增权限码 / 调整角色绑定 / 给端点重新挂 `@Roles`(均为 D 档,沿规则 1)。
3. **禁止**绕过 / 弱化:`assertCanManageUser`、最后 SA/ops-admin 保护、防枚举四场景一致性、`@Public` 与 `@Roles` 互斥。
4. 新管理面 endpoint 默认模式 = R 模式(沿既有模块范式);新 App endpoint 默认 self-scope,**禁止**用 `role` 短路 scope。
5. 错误码:权限拒绝只允许既有 `UNAUTHORIZED(40100)` / `FORBIDDEN(40300)` / RBAC 拒绝码(30100 段)/ 业务护栏码;**禁止**自创 token 类 100xx 码([`response-pagination-errors`](../reference/response-pagination-errors.md))。
6. 本文件对照表与代码不一致时:以代码为准,**先报告再 true-up**,不得据本表"纠正"代码。

## 7. 漂移检查与重新生成口径

**首选自动检查**(NEXT_TASKS P1-1 已落地;0 FAIL 才算本表与事实一致):

```bash
pnpm docs:rbacmap:check   # seed 码↔本表计数 / controller 数↔本表 / 5 canonical 前缀 / 直调码必在 seed / 孤码 WARN / summary 鉴权后缀一致(P2-2)
```

手工重新生成口径(true-up 改表时用):

```bash
# 权限码全集(seed)
grep -oE "code: '[a-z][a-z-]*\.[a-z.-]+'" prisma/seed.ts | sort -u   # + 常量声明 PR_3B_USER_UPDATE_ROLE_CODE
# controller 前缀清单
grep -rE "^@Controller\(" src --include="*.ts" -h | sort | uniq -c
# 模块鉴权模式
grep -rl "this\.rbac" src/modules --include="*.service.ts"
grep -rc "@Roles(" src/modules/<module> --include="*.controller.ts"
```
