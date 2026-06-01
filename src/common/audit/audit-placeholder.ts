import { Logger } from '@nestjs/common';

// V2 第一阶段批次 1 审计占位函数(详见 docs/批次1_API前评审... §6)。
//
// 设计:批次 1 不建 audit_logs 表,所有敏感读 / 写位置必须经统一函数转 pino 结构化日志;
// 批次 7 接入审计时,**仅替换本函数实现**为"写库 + 触发告警",业务代码零修改。
// 详见批次 1 Plan §6 + schema 草案 §14。
//
// 事件名锁死为 union type,新增审计事件须先经 Plan / 草案 / API 前评审,**禁止**自行扩展。
//
// 批次 1 实际调用 3 个事件(A2 / A5 / A6),其余 3 个(A1 / A3 / A4)留 type 但不调用:
//   - A1 profile.read.self / A3 profile.update.self:无 USER 自助接口,本批次不调用
//   - A4 profile.update.review:永久占位(不实现审批流)
//
// 批次 2 追加 10 项(详见 docs:批次2_API前评审_certificates.md §6 + Q-A5 / Q-I1 决议):
//   B1 certificate.read.self                  占位(无 USER 路由)
//   B2 certificate.read.other                 实装(GET list / detail)
//   B3 certificate.read.qualification-flag    实装(Q-I1:沿 batch 1 风格 <res>.<action>.<scope>)
//   B4 certificate.create                     实装
//   B5 certificate.update                     实装(不含 verify / reject / softDelete / expire)
//   B5b certificate.delete                    实装(softDelete 独立事件;Q-A5 决议)
//   B6.verify certificate.verify              实装(Q-A5:与 reject 拆分)
//   B6.reject certificate.reject              实装(Q-A5:与 verify 拆分)
//   B7 certificate.expire                     占位(系统任务,本批次不实装)
//   B8 certificate.attachment.read            占位(批次 6a 接入)
//
// 批次 3 追加 8 项(详见 docs:批次3_schema草案_activities_attendances.md §20.2 + 决议表 v1.4):
//   A1 activity.publish                     实装(活动发布 / 修改 / 撤销)
//   A2 registration.create                  实装(队员报名)
//   A3 registration.review                  实装(报名审核 pending → pass/reject;沿 Q-D15 v0.3 含 cancel 流转留 service 决定)
//   A4 attendance-sheet.submit              实装(录入员提交 Sheet)
//   A5 attendance-sheet.edit                实装(编辑 pending Sheet;version+1,沿 D38)
//   A6 attendance-sheet.delete              实装(软删 Sheet)
//   A7 attendance-sheet.read.other          实装(高级管理员查他人考勤)
//   A8 attendance-sheet.review              实装(APD 审核 approve/reject;触发业务事件 attendance.recorded,沿 §19)
//
// 禁止散落 TODO 注释,禁止业务代码内裸 console.log;所有审计意图必须经本函数。
export type AuditEvent =
  | 'profile.read.self'
  | 'profile.read.other'
  | 'profile.update.self'
  | 'profile.update.review'
  | 'emergency-contact.read.other'
  | 'emergency-contact.write'
  // batch 2 新增 10 项
  | 'certificate.read.self'
  | 'certificate.read.other'
  | 'certificate.read.qualification-flag'
  | 'certificate.create'
  | 'certificate.update'
  | 'certificate.delete'
  | 'certificate.verify'
  | 'certificate.reject'
  | 'certificate.expire'
  | 'certificate.attachment.read'
  // batch 3 新增 8 项
  | 'activity.publish'
  | 'registration.create'
  | 'registration.review'
  | 'attendance-sheet.submit'
  | 'attendance-sheet.edit'
  | 'attendance-sheet.delete'
  | 'attendance-sheet.read.other'
  | 'attendance-sheet.review'
  // batch 4-B 新增 1 项(沿 D-S11 / 业务规则文档 §8.4):
  //   终审 final-approve / final-reject;
  //   action='final-approve' / 'final-reject' 在 context 中区分;
  //   触发位置:AttendancesService.finalApprove / finalReject(同事务内)。
  //   注:终审业务角色为"APD 部门部长 / 副部长",当前实装权限仍沿用管理权限
  //   (ADMIN / SUPER_ADMIN),细分终审权限将在后续批次实现。
  | 'attendance-sheet.final-review'
  // batch 5-A 新增 3 项(沿 D6 v1.1 §2.2 E6 / §4.7;沿 batch 2 / batch 3 写操作 hook 范式):
  //   contribution-rule.create  实装(POST /api/system/v1/contribution-rules)
  //   contribution-rule.update  实装(PATCH /api/system/v1/contribution-rules/:id)
  //   contribution-rule.delete  实装(DELETE /api/system/v1/contribution-rules/:id)
  // list / findOne 不 hook(规则是配置数据,非个人敏感信息)。
  // auditPlaceholder 实现仍是 pino log,不落 audit_logs 表(D6 v1.1 F7 留独立批次)。
  | 'contribution-rule.create'
  | 'contribution-rule.update'
  | 'contribution-rule.delete';

const auditLogger = new Logger('Audit');

export function auditPlaceholder(event: AuditEvent, context: Record<string, unknown>): void {
  auditLogger.log({ audit: true, event, ...context });
}
