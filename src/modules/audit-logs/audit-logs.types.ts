// V2 第一阶段批次 6 audit_logs 模块类型契约(D6 v1.1 §8 / §10 / §11)。
//
// 本文件承载 3 个类型契约,与 audit-logs.service.ts 同进同退:
//   1. AuditLogEvent  — 落库入口 union(首批 6 项起渐进迁入;2026-06-13 保险 T2 后共 43 项)
//   2. AuditContext   — Prisma AuditLog.context Json 字段的运行时锁形(6 字段:3 必填 + 3 可选)
//   3. AuditMeta      — controller 层从 @Req() 构造,显式传给 service
//
// 与 src/common/audit/audit-placeholder.ts(AuditEvent,29 项)的关系(D-A 修订核心):
// - 两套 union 物理隔离(D2):AuditEvent 留 pino-only 占位,AuditLogEvent 走 DB 落库
// - 事件名同值:AuditLogEvent ⊆ AuditEvent(同字符串值,后续批次迁移时**仅是把字符串从一个 union 挪到另一个**)
// - 第一波(PR #2)6 项落库:emergency-contact.write × 3 service 上下文 + certificate.{create,update,delete,verify,reject}
// - 第二波第一步(PR #3)+3 项落库:contribution-rule.{create,update,delete};沿 D-A 修订渐进迁出
// - 第二波第二步(PR #4)+1 项落库:activity.publish(activities.service: create / update / softDelete / publish / cancel 共 5 处共用同一事件名,operation 在 extra 区分,沿 batch3 草案有意设计)
// - 第二波第三步(PR #5)+2 项落库:registration.create / registration.review(activity-registrations.service: 6 处写;2 个事件名共用,extra.viaPath / extra.action 区分;exportCsv 仍 pino-only 不迁移)
// - 第二波最后一批(PR #6)+5 项落库:attendance-sheet.{submit,edit,delete,review,final-review}(attendances.service: 8 处写;5 个事件名共用,extra.operation / extra.action 区分;3 处 read.other 仍 pino-only)
// - 其余继续 pino-only,等后续批次按需迁出(D1 决议)
// - **绝对禁止**:在本 union 自行新增字符串值;新增审计事件必须先经评审稿决议(D6 v1.1 §8.1 / §16)

export type AuditLogEvent =
  | 'emergency-contact.write' // PR #2 接入(emergency-contacts.service: create / update / softDelete 共 3 处)
  | 'certificate.create' // PR #2 接入(certificates.service: create)
  | 'certificate.update' // PR #2 接入(certificates.service: update)
  | 'certificate.delete' // PR #2 接入(certificates.service: softDelete)
  | 'certificate.verify' // PR #2 接入(certificates.service: verify)
  | 'certificate.reject' // PR #2 接入(certificates.service: reject)
  | 'contribution-rule.create' // PR #3 接入(contribution-rules.service: create)
  | 'contribution-rule.update' // PR #3 接入(contribution-rules.service: update)
  | 'contribution-rule.delete' // PR #3 接入(contribution-rules.service: softDelete)
  | 'activity.publish' // PR #4 接入(activities.service: create / update / softDelete / publish / cancel 共 5 处;5 个 operation 通过 extra.operation 区分,沿 batch3 草案 §20.2 A1 同名设计)
  | 'registration.create' // PR #5 接入(activity-registrations.service: create [ADMIN 代报名] / createMy [USER 自助] 共 2 处;extra.viaPath ∈ {admin, self} 区分)
  | 'registration.review' // PR #5 接入(activity-registrations.service: approve / reject / cancelAdmin / cancelMy 共 4 处写;extra.action ∈ {approve, reject, cancel} 区分;cancel 再用 extra.cancelledByPath ∈ {admin, self} 细分;exportCsv 仍 pino-only,read 不迁移)
  | 'attendance-sheet.submit' // PR #6 接入(attendances.service: submit 1 处;Sheet+N records 一次性入库,D11 推动 Activity completed)
  | 'attendance-sheet.edit' // PR #6 接入(attendances.service: edit 2 处共用;extra.operation ∈ {edit, edit-no-records} 区分;version+1 + previousSnapshot)
  | 'attendance-sheet.delete' // PR #6 接入(attendances.service: softDelete 1 处;pending Sheet 软删 + records 级联软删)
  | 'attendance-sheet.review' // PR #6 接入(attendances.service: approve / reject 共 2 处;extra.action ∈ {approve, reject} 区分;approve 走 pending → pending_final_review)
  | 'attendance-sheet.final-review' // PR #6 接入(attendances.service: finalApprove / finalReject 共 2 处;extra.action ∈ {final-approve, final-reject} 区分;final-approve 触发 attendance.recorded 业务事件,final-reject records 跟随软删;APD 细分权限后置)
  | 'attachment.upload' // V2.x C-7 PR #6c 接入(attachments.service: create 1 处;沿 D7-attachments v1.0 §7.1)
  | 'attachment.delete' // V2.x C-7 PR #6c 接入(attachments.service: delete 1 处;extra.deletedByPath ∈ {owner, admin} 区分;沿 D7-attachments v1.0 §7.1)
  | 'attachment.config.change' // V2.x C-7 PR #6d 接入(配置三表 11 处写共用单事件;沿 D7-attachments v1.0 §7.1 路线 A:extra.configType ∈ {type, mime, sizeLimit} + extra.operation ∈ {create, update, update-status, delete} 区分;updateStatus 沿 Q1 PR #6d 拍板细分独立 operation)
  | 'password.change.self' // P0-D PR-3(2026-05-17)接入(users.service: changeMyPassword 1 处;沿 docs/first-release-p0d-change-my-password-review.md §5.6 + §9.1 复核 #1:与现有 kebab-case `<res>.<action>.<scope>` 风格对齐 + 与 `profile.update.self` 对称)。resourceType='user' / resourceId=currentUser.id;不写 oldPassword / newPassword / passwordHash 任何明文或 hash
  // P0-E PR-3(2026-05-18)接入(沿 docs/first-release-p0e-refresh-token-review.md §3.8 D-8 + §5.9 audit 写入表)。
  // 5 项命名沿 P0-D `password.change.self` kebab-case `<resource>.<action>` / `<resource>.<action>.<scope>` 范式;
  // `auth.logout-all` action 段含 dash 沿 `attendance-sheet.final-review` 范式。
  // `extra` 禁止写:refresh token 明文 / `tokenHash` / `passwordHash` / IP 完整段(IP 已在 AuditContext.ip 字段)。
  // `extra` 允许写:`familyId`(cuid)/ `replayDetected: boolean` / `familyRevoked?: boolean` /
  //   `revokedCount: number` / `found: boolean` / `refreshTokensRevoked: number`。
  | 'auth.login' // P0-E PR-3 接入(auth.service.login 成功路径 1 处;resourceType='user' / resourceId=user.id;extra.familyId)
  | 'auth.login.sms' // B 队列 F4-T2(2026-06-11)接入(login-sms.service.login 成功路径经 AuthService.createSession 1 处;extra.familyId + phone 掩码 + codeId;评审稿 queue-b-otp-birthday-infra-review.md E-O7;登录失败不写,镜像密码登录)
  | 'auth.refresh' // P0-E PR-3 接入(auth.service.refresh 成功 + family revoke 路径共 1 处;extra.familyId / replayDetected / familyRevoked?)
  | 'auth.logout' // P0-E PR-3 接入(auth.service.logout 含幂等命中均写;extra.found: boolean)
  | 'auth.logout-all' // P0-E PR-3 接入(auth.service.logoutAll 1 处;extra.revokedCount: number)
  | 'password.reset.by-admin' // P0-E PR-3 隐含范围扩展(users.service.resetPassword 1 处;沿 P0-D `password.change.self` 对称范式;extra.refreshTokensRevoked: number)
  // SMS 基础设施 T3(2026-06-10)接入(冻结评审稿 sms-verification-infra-review.md §3.5 / D-SMS-9)。
  // 3 项命名沿 kebab-case `<resource>.<action>.<scope>` 范式(对称 password.change.self / password.reset.by-admin)。
  // detail(before / after / extra)中手机号**一律掩码** 138****1234(maskPhone,评审稿 E-21/E-24);
  // **禁止**写入:明文验证码 / codeHash / 完整手机号。SmsSettings 变更不写 audit(沿 L-3 挂起)。
  | 'phone.bind.self' // T3 接入(users.service.bindMyPhone 首绑路径;after.phone 掩码;extra.codeId)
  | 'phone.rebind.self' // T3 接入(users.service.bindMyPhone 换绑路径;before/after.phone 掩码;extra.codeId)
  | 'phone.clear.by-admin' // T3 接入(users.service.clearUserPhone;仅实际清除时写〔幂等空清不写〕;before.phone 掩码)
  // 找回密码 T2(2026-06-11)接入(冻结评审稿 password-reset-by-sms-review.md §3.4 / D-PR-3)。
  // 命名沿 password.change.self / password.reset.by-admin 对称范式;actor = 本人(pre-auth 下
  // actor 即被重置账号本人);手机号一律掩码;禁明文码 / codeHash / 完整号码 / 密码任何形态。
  | 'password.reset.by-sms' // T2 接入(auth/password-reset.service.reset 成功事务内 1 处;extra.refreshTokensRevoked + phone 掩码 + codeId)
  // 微信小程序登录 T3(2026-06-12)接入(冻结评审稿 wechat-mini-login-review.md §3.5 / E-23)。
  // 4 项命名沿 kebab-case 既有范式(auth.login.sms / phone.{bind,rebind}.self / phone.clear.by-admin 对称)。
  // detail(before / after / extra)中 openid **一律掩码**(maskOpenid,前 4 后 4;openid 非 L3
  // 但不滥回显);**禁止**写入:wx code / session_key / appSecret / 完整 openid 任何形态。
  // wechat.bind.self / wechat.rebind.self 双写入路径 extra.viaPath ∈ {'pre-auth','me'} 区分
  // (沿 registration.create viaPath 范式);pre-auth 路径另含 phone 掩码 + codeId。
  | 'auth.login.wechat' // T3 接入(AuthService.createSession 经 login-wechat 两调用方;extra.familyId + openid 掩码;登录失败不写,镜像密码登录)
  | 'wechat.bind.self' // T3 接入(auth/login-wechat.service.bind 首绑 + users.service.bindMyWechat 首绑;after.openid 掩码;extra.viaPath)
  | 'wechat.rebind.self' // T3 接入(同上双路径换绑;before/after.openid 掩码;extra.viaPath)
  | 'wechat.clear.by-admin' // T3 接入(users.service.clearUserWechat;仅实际清除时写〔幂等空清不写〕;before.openid 掩码)
  // 保险模块 T2(2026-06-13)接入(冻结评审稿 insurance-module-review.md §3.5 / E-9)。
  // 8 项命名沿 kebab-case 既有范式(自助三事件 <resource>.<action>.self 对称 phone.bind.self;
  // 队保单三事件 <resource>.<action> 对称 certificate.create)。
  // snapshot 沿 certificates 全量不打码(保单号/保险公司中敏感非 L3,audit_logs 自身 RBAC 保护);
  // 本域无 L3 字段。admin 读他人自购保险走 auditPlaceholder pino('member-insurance.read.other'),
  // 不进本 union(镜像 certificate.read.other);App self 读不写 audit(D-P2-7-16)。
  | 'member-insurance.create.self' // T2 接入(app-me-insurances.service.create;after snapshot;extra.memberId)
  | 'member-insurance.update.self' // T2 接入(app-me-insurances.service.update;before/after;extra.memberId)
  | 'member-insurance.delete.self' // T2 接入(app-me-insurances.service.softDelete;before;extra.memberId)
  | 'team-insurance-policy.create' // T2 接入(team-insurance-policies.service.create;after)
  | 'team-insurance-policy.update' // T2 接入(team-insurance-policies.service.update;before/after)
  | 'team-insurance-policy.delete' // T2 接入(team-insurance-policies.service.softDelete;before;不级联覆盖行 E-4)
  | 'team-insurance-coverage.add' // T2 接入(单加 + 一键加共用;resourceId=policyId;extra.mode ∈ {single, all-active},single 带 memberId / all-active 带 addedCount)
  | 'team-insurance-coverage.remove' // T2 接入(覆盖行软删;resourceId=policyId;extra.memberId)
  // 招新一期 T3 追加 5 项(2026-06-18;冻结评审稿 recruitment-phase1-review.md §3.5;
  // 自助 submit / realname-verify 的 actorUserId 置空——无账号报名者,沿 AuditLogInput actorUserId:null):
  | 'recruitment-cycle.create' // admin 建轮;after
  | 'recruitment-cycle.update' // admin 开关/容量/通知配置;before/after
  | 'recruitment-application.submit' // 公开提交(自助;actor 置空);after〔状态〕;手机/openid/身份证号一律掩码
  | 'recruitment-application.realname-verify' // 每次提交端付费 OCR 调用(OCR 改造 2026-06-22 语义重定;配套③;建终态记录同事务写;actor 置空);idCard/name 掩码 + documentType + outcome(matched/mismatch/forgery_warning/ocr_unclear/ocr_error)
  | 'recruitment-application.resolve-manual' // admin 人工 resolve;before/after status;extra tempNo?/eliminationStage?
  // 招新二期(后段)T2/T3(2026-06-19;评审稿 recruitment-phase2-review.md §3.5 / E-R2-12):
  | 'recruitment-application.mark-threshold' // admin 标/清门槛;before/after status;extra {thresholdCode, completed, allComplete}
  | 'recruitment-application.evaluate' // admin 综合评定/淘汰;before/after status;extra {approved, eliminationStage?}
  | 'recruitment-application.promote' // admin 一键发号(逐报名一条);before/after status;extra {memberNo, memberId, tempNo, openid:掩码}
  // 招新四期 S4a(H5 + 手机身份链)T1(2026-06-24;评审稿 recruitment-phase4-loop-optimization-review.md §3.4):
  // 申请人自助换绑(actor 置空;手机/openid 一律掩码,沿 phone.rebind.self / wechat.rebind.self 范式):
  | 'recruitment-application.rebind-wechat' // 自助换微信换绑;before/after.openid 掩码;extra {phone:掩码}
  | 'recruitment-application.rebind-phone' // 自助换手机换绑;before/after.phone 掩码;extra {method, reason}
  // 招新三期(入队:志愿者→队员)T2(2026-06-19;评审稿 recruitment-phase3-review.md §3.5 / E-J-8;
  // 本 PR 仅 admin 4 项,自助 submit〔T3〕/ join〔T4〕后续追加):
  | 'team-join-cycle.create' // admin 建入队轮;after
  | 'team-join-cycle.update' // admin 开/关/改名;before/after
  | 'team-join-application.mark-gate' // admin 标 gate;before/after status;extra {gateCode, passed, generalGatesSatisfied, contributionSatisfied}
  | 'team-join-application.evaluate' // admin 综合评估/淘汰;before/after status;extra {approved, eliminationStage?}
  // 招新三期(入队)T3(2026-06-19;评审稿 §3.5):App 自助发起 / 改候选部门(actorUserId = 本人 User):
  | 'team-join-application.submit' // 自助发起入队申请(after status/cycle/targetCount)+ 改候选部门复用(before/after targetCount)
  // 招新三期(入队)T4(2026-06-19;评审稿 §4.5):admin 一键入队(志愿者→队员;设部门 + 级别 level-1):
  | 'team-join-application.join' // before/after status;extra {organizationId, gradeCode, memberId}
  // CMS 内容发布模块(第 28 模块)T2(2026-06-21;评审稿 content-module-review.md §7):admin 内容写 4 事件。
  // content.publish 为伞事件,覆盖 publish / unpublish / archive(extra.operation 区分 + before/after statusCode,
  // 沿 activity.publish 一事件多 operation 范式)。读取面 / viewCount 自增不写 audit;附件上传/删复用 attachment.{upload,delete}。
  | 'content.create' // admin 建内容草稿(after 快照)
  | 'content.update' // admin 更新内容(before/after;set-cover 复用,extra.operation='set-cover')
  | 'content.delete' // admin 软删内容(before)
  | 'content.publish' // admin 状态机;extra.operation ∈ {publish, unpublish, archive} + before/after statusCode
  // 统一通知模块 S1 站内信渠道(第 28 模块 notifications 扩 controller)T1(2026-06-25;评审稿
  // unified-notification-dispatcher-review.md §13 + member-notification-review.md §2⑩):admin 写 4 事件。
  // notification.publish 为伞事件,覆盖 publish / unpublish / archive(extra.operation 区分 + before/after statusCode,
  // 沿 content.publish / activity.publish 一事件多 operation 范式)。会员 mark-read / 阅读不写 audit(运营触达阅读侧,
  // 镜像生日批 + content viewCount + App self 读不写;评审稿 §13 / D-P2-7-16)。
  // 统一通知 S5 短信兜底渠道(2026-06-27;评审稿 §4 / §13.2「admin 入 audit;逐条投递不入 audit」):admin 显式发起
  // 短信(紧急召集)复用本伞事件,extra.operation='send-sms' + extra.{recipientCount,sent,failed,skipped}(收件人计数,
  // **无新增 audit 事件串**——沿伞事件多 operation 范式,不破 D6 v1.1 §8.1 闭 union 铁律);逐条投递落 NotificationDelivery
  // / sms_send_logs 不入 audit(手机号经 maskPhone,audit 仅计数无明文)。
  | 'notification.create' // admin 建通知草稿(after 快照)
  | 'notification.update' // admin 更新通知(before/after)
  | 'notification.delete' // admin 软删通知(before)
  | 'notification.publish' // admin 状态机 + S5 短信发起;extra.operation ∈ {publish, unpublish, archive, send-sms}
  // 终态 scoped-authz PR4「任职」(2026-07-01;冻结评审稿 org-position-scoped-authz-terminal-design-review.md
  // §1.7〔"任命/撤销...审计...复用本表,resourceType 扩 position_assignment"〕/ §11 PR4 决议):任职写 2 事件。
  // resourceType='position_assignment';create 写 after 快照 / revoke 写 before+after(status ACTIVE→REVOKED)。
  // 命名沿 kebab-case `<resource>.<action>` 既有范式(对称 certificate.create / team-insurance-policy.create)。
  | 'position-assignment.create' // admin 任命(position-assignments.service: create 1 处;extra.operation='create' + organizationId + targetMemberId)
  | 'position-assignment.revoke' // admin 撤销任职(position-assignments.service: revoke 1 处;before/after status;extra.operation='revoke' + targetMemberId)
  // 终态 scoped-authz PR5「分管」(2026-07-01;冻结评审稿 org-position-scoped-authz-terminal-design-review.md
  // §3.5 / §7.4 / §4.3 / §11 PR5):分管写 2 事件。resourceType='supervision_assignment';
  // create 写 after 快照 / revoke 写 before+after(status ACTIVE→REVOKED)。命名沿 kebab-case `<resource>.<action>` 既有范式。
  | 'supervision-assignment.create' // admin 建分管(supervision-assignments.service: create 1 处;extra.operation='create' + organizationId + supervisorMemberId)
  | 'supervision-assignment.revoke' // admin 撤销分管(supervision-assignments.service: revoke 1 处;before/after status;extra.operation='revoke' + supervisorMemberId)
  // 终态 scoped-authz PR6「RoleBinding」(2026-07-01;冻结评审稿 org-position-scoped-authz-terminal-design-review.md
  // §3.6 / §7.5 / §10.6 / §11 PR6):角色绑定写 2 事件(伞事件,一事件多来源,沿 registration.create viaPath 范式)。
  // resourceType='role_binding';create 写 after 快照 / revoke 写 before+after(status ACTIVE→ENDED)。
  // extra.viaPath ∈ {'role-binding','user-role'} 区分来源:'role-binding' = role-bindings CRUD 面(scoped 各型);
  //   'user-role' = 兼容面 user-roles CRUD(现经 global RoleBinding;UserRolesService 直写 auditLog,避免模块环)。
  | 'role-binding.create' // admin 建角色绑定(role-bindings.service: create + user-roles.service: assign;extra.viaPath 区分)
  | 'role-binding.revoke' // admin 撤销 / 软删角色绑定(role-bindings.service: remove + user-roles.service: revoke;before/after status)
  // 审计留痕批(2026-07-03;review #484 G5):memberships 双入口写路径补齐 audit。resourceType='membership'。
  // 两个写入口共用同一张 member_organization_memberships 表,伞事件 + extra.viaPath ∈ {'membership','department'}
  // 区分入口(沿 role-binding.* extra.viaPath 范式)。PATCH(memberships.update)不写 audit——沿 role-binding.update /
  // supervision-assignment.update 均不审计的既有先例(仅改 status/note 等非建/终字段,不构成建/终事件)。
  | 'membership.set' // 建 / 设归属(memberships.service: create;member-departments.service: set 幂等分支〔同 org 无变更〕不写);extra.viaPath ∈ {membership, department}
  | 'membership.end' // 结束归属(memberships.service: end;member-departments.service: remove〔软删旧 PRIMARY 行〕);extra.viaPath ∈ {membership, department}
  // organizations 写面审计留痕补齐(2026-07-03;review #484 G18 → NEXT_TASKS P1-16)。resourceType='organization'。
  // PR1(2026-07-01)遗留缺口:OrganizationsService 写路径全程无 audit;PR11 announcement-import 把
  // create() 推到单请求最多 200 行的批量规模,放大"谁在何时批量建了哪些组"缺失审计轨迹的暴露面。
  // 审计范围收窄至「建 / 树结构变更 / 授权相关状态变更 / 终」四类,沿 role-binding.*/supervision-assignment.*
  // 均不审计纯 cosmetic update 的既有先例:update(name/sortOrder/nodeTypeCode)**不写 audit**——非建/终
  // 字段变更,不构成审计事件(详见 src/modules/organizations/CLAUDE.md)。
  | 'organization.create' // admin 建组织节点(organizations.service: create 1 处;含 announcement-import 批量复用同一方法;after 快照,无 before)
  | 'organization.move' // admin 重挂父级/reparent(organizations.service: move 1 处;before/after.parentId;树结构 + scoped 判权范围变更;同父幂等 no-op 分支不写)
  | 'organization.status-change' // admin 启停(organizations.service: updateStatus 1 处;before/after.status;INACTIVE 会使 covers() 拒绝 scoped grant)
  | 'organization.delete'; // admin 软删组织节点(organizations.service: softDelete 1 处;仅 before 快照,沿 certificate.delete/content.delete 纯删除既有先例)

// Prisma AuditLog.context Json 字段的运行时锁形(D7 拍板)。
// 共 6 字段:3 必填 + 3 可选。AuditLogsService.log() 内部构造,e2e 强断言每条 audit
// 必含 `requestId` / `ip` / `ua` 三字段(ip / ua 可为 null,但字段必须存在;requestId 必为非空字符串)。
//
// 字段语义(D6 v1.1 §10.3):
// - requestId:nestjs-pino `req.id`(V1.1 §17.4 已接),用于跨日志关联。必为非空字符串
// - ip:request.ip,可为 null(测试环境无来源 IP)
// - ua:request.headers['user-agent'],可为 null(curl / 内部调用可能缺)
// - before:service 调用方构造,敏感字段已打码;create 场景无
// - after:service 调用方构造,敏感字段已打码;softDelete 场景无
// - extra:调用方自定义 metadata(targetMemberId / operation / verifierMemberId 等),不打码字段
export interface AuditContext {
  requestId: string;
  ip: string | null;
  ua: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

// AuditMeta 由 controller 层从 @Req() 构造,显式传给 service(D8 拍板:不引入 cls-rs / AsyncLocalStorage)。
// 实施路径(D6 v1.1 §11.2):每个写操作 controller 方法从 req 构造 AuditMeta 后传给 service,
// service 在 log() 内部把 AuditMeta 的 3 字段合并到 AuditContext 的 3 必填字段。
//
// PR #1 范围内:本类型已就绪;但 8 处 service / controller 实际迁移调用方为 PR #2 范围。
export interface AuditMeta {
  requestId: string;
  ip: string | null;
  ua: string | null;
}
