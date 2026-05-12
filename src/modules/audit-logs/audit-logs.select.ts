import { Prisma } from '@prisma/client';

// V2 第一阶段批次 6 audit_logs 模块对外字段集中 select(D6 v1.1 §15.3 模块 6 文件之一)。
// 沿 v1 users.select.ts / batch 5-A contribution-rules.select.ts 范式。
//
// 对外字段必须与 AuditLogResponseDto 严格同步:增删字段两边同时改。
// 暴露全部 9 个业务字段;**不暴露 actorUser relation 详情**(避免循环 / 信息冗余;
// 调用方按需用 actorUserId 二次查 users.service.findOne)。

export const auditLogSafeSelect = {
  id: true,
  createdAt: true,
  actorUserId: true,
  actorRoleSnap: true,
  resourceType: true,
  resourceId: true,
  event: true,
  context: true,
  success: true,
} as const satisfies Prisma.AuditLogSelect;

export type SafeAuditLog = Prisma.AuditLogGetPayload<{
  select: typeof auditLogSafeSelect;
}>;
