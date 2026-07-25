import { Prisma, Role } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { SafeAuditLog } from './audit-logs.select';

export type AuditLogReadScope = { kind: 'all' } | { kind: 'self-or-user'; currentUserId: string };

type AuditLogScopeRow = Pick<SafeAuditLog, 'actorUserId' | 'actorRoleSnap'>;

/**
 * AuditLog list/detail 共用的数据范围策略。
 *
 * RBAC 只回答账号能否进入读取面；本策略继续收紧具体可见行：
 * - SUPER_ADMIN：全部；
 * - 其他已通过 RBAC 的账号：本人操作，或操作时角色快照为 USER。
 */
export class AuditLogReadScopePolicy {
  resolve(currentUser: CurrentUserPayload): AuditLogReadScope {
    if (currentUser.role === Role.SUPER_ADMIN) return { kind: 'all' };
    return { kind: 'self-or-user', currentUserId: currentUser.id };
  }

  toWhere(scope: AuditLogReadScope): Prisma.AuditLogWhereInput | null {
    if (scope.kind === 'all') return null;
    return {
      OR: [{ actorUserId: scope.currentUserId }, { actorRoleSnap: Role.USER }],
    };
  }

  includes(scope: AuditLogReadScope, row: AuditLogScopeRow): boolean {
    if (scope.kind === 'all') return true;
    return row.actorUserId === scope.currentUserId || row.actorRoleSnap === Role.USER;
  }
}

export const auditLogReadScopePolicy = new AuditLogReadScopePolicy();
