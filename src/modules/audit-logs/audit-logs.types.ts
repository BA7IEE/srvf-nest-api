// V2 第一阶段批次 6 audit_logs 模块类型契约(D6 v1.1 §8 / §10 / §11)。
//
// 本文件承载 3 个类型契约,与 audit-logs.service.ts 同进同退:
//   1. AuditLogEvent  — 第一批落库入口 union(6 项)
//   2. AuditContext   — Prisma AuditLog.context Json 字段的运行时锁形(6 字段:3 必填 + 3 可选)
//   3. AuditMeta      — controller 层从 @Req() 构造,显式传给 service
//
// 与 src/common/audit/audit-placeholder.ts(AuditEvent,28 项)的关系(D-A 修订核心):
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
  | 'phone.clear.by-admin'; // T3 接入(users.service.clearUserPhone;仅实际清除时写〔幂等空清不写〕;before.phone 掩码)

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
