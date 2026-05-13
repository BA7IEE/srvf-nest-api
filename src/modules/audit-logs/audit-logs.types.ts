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
  | 'registration.review'; // PR #5 接入(activity-registrations.service: approve / reject / cancelAdmin / cancelMy 共 4 处写;extra.action ∈ {approve, reject, cancel} 区分;cancel 再用 extra.cancelledByPath ∈ {admin, self} 细分;exportCsv 仍 pino-only,read 不迁移)

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
