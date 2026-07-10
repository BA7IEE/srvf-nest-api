import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { AuditContext, AuditLogEvent, AuditMeta } from '../audit-logs/audit-logs.types';

type PrismaTx = Prisma.TransactionClient;

// 第三轮全仓 review(v0.38.0)§F&A-2 收口:RBAC 授权配置写面(RbacRole / RolePermission /
// Permission CRUD)接入 audit_logs。permissions 模块三服务共用本 helper 直写留痕。
//
// **为何直写而非注入 AuditLogsService**(镜像 user-roles.service.ts:writeRoleBindingAudit 先例):
//   AuditLogsModule 已 import PermissionsModule(取 RbacService 供 audit list/detail 判权);
//   本模块反向 import AuditLogsModule 会成模块环,而本仓 forwardRef 零使用(简单显式原则)。
//   故按 AuditContext 锁形(仅类型 import,无 DI / 无模块依赖)直写 auditLog —— AuditLogsService.log()
//   本就是薄封装(不接 rbac.can),此处等价复刻其 context 构造。event ⊆ 闭 union AuditLogEvent;
//   resourceType 由各服务传入('rbac_role' / 'role_permission' / 'permission')。
//
// 必须在调用方 $transaction 内运行(传 tx):写入与 audit 原子,失败一并回滚,零残留(镜像
// organizations #495 inline-in-tx 先例)。
export async function writeConfigAudit(
  client: PrismaTx,
  input: {
    event: AuditLogEvent;
    actor: CurrentUserPayload;
    resourceType: string;
    resourceId: string;
    meta: AuditMeta;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  const context: AuditContext = {
    requestId: input.meta.requestId,
    ip: input.meta.ip,
    ua: input.meta.ua,
  };
  if (input.before !== undefined) context.before = input.before;
  if (input.after !== undefined) context.after = input.after;
  if (input.extra !== undefined) context.extra = input.extra;
  await client.auditLog.create({
    data: {
      actorUserId: input.actor.id,
      actorRoleSnap: input.actor.role,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      event: input.event,
      context: context as unknown as Prisma.InputJsonValue,
    },
  });
}
