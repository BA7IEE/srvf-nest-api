import { Logger } from '@nestjs/common';

// V2 第一阶段批次 1 审计占位函数(详见 docs/批次1_API前评审... §6)。
//
// 设计:批次 1 不建 audit_logs 表,所有敏感读 / 写位置必须经统一函数转 pino 结构化日志;
// 批次 7 接入审计时,**仅替换本函数实现**为"写库 + 触发告警",业务代码零修改。
// 详见批次 1 Plan §6 + schema 草案 §14。
//
// 6 个事件名锁死为 union type,新增审计事件须先经 Plan / 草案评审,**禁止**自行扩展。
//
// 本批次实际调用 3 个事件(A2 / A5 / A6),其余 3 个(A1 / A3 / A4)留 type 但不调用:
//   - A1 profile.read.self / A3 profile.update.self:无 USER 自助接口,本批次不调用
//   - A4 profile.update.review:永久占位(不实现审批流)
//
// 禁止散落 TODO 注释,禁止业务代码内裸 console.log;所有审计意图必须经本函数。
export type AuditEvent =
  | 'profile.read.self'
  | 'profile.read.other'
  | 'profile.update.self'
  | 'profile.update.review'
  | 'emergency-contact.read.other'
  | 'emergency-contact.write';

const auditLogger = new Logger('Audit');

export function auditPlaceholder(event: AuditEvent, context: Record<string, unknown>): void {
  auditLogger.log({ audit: true, event, ...context });
}
