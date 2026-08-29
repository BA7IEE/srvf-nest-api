import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';

type PrismaTx = Prisma.TransactionClient;

export interface DelegationEligiblePermission {
  id: string;
  code: string;
}

export interface DelegationPermissionFlags {
  delegatedAccessAllowed: boolean;
  servicePrincipalAllowed: boolean;
}

/**
 * Delegation 对 Permission 的唯一跨域入口。
 *
 * Permission 资格门及其行锁归 platform-access 所有；调用域只取得最小事实，
 * 不再直接碰 Permission 表，从而避免把跨域 raw SQL 或资格判定扩散到业务域。
 */
@Injectable()
export class DelegationPermissionEligibilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 在调用方事务内锁住目标 Permission 行，随后复读两道资格门。
   * 锁与复读必须同事务，避免 Role/Permission 管理面并发关门后仍落下一条 Grant。
   */
  async lockAndFindEligibleByCodes(
    tx: PrismaTx,
    codes: readonly string[],
  ): Promise<DelegationEligiblePermission[] | null> {
    const uniqueCodes = [...new Set(codes)];
    if (uniqueCodes.length === 0) return [];

    await tx.$queryRaw(
      Prisma.sql`
        SELECT "id"
        FROM "permissions"
        WHERE "code" IN (${Prisma.join(uniqueCodes)})
        ORDER BY "id" ASC
        FOR UPDATE
      `,
    );
    const permissions = await tx.permission.findMany({
      where: { code: { in: uniqueCodes } },
      select: {
        id: true,
        code: true,
        servicePrincipalAllowed: true,
        delegatedAccessAllowed: true,
      },
    });
    if (
      permissions.length !== uniqueCodes.length ||
      permissions.some(
        (permission) => !permission.servicePrincipalAllowed || !permission.delegatedAccessAllowed,
      )
    ) {
      return null;
    }
    return permissions.map(({ id, code }) => ({ id, code }));
  }

  /** Grant allowlist 内某个 action 的即时资格快照。 */
  async findFlagsForGrant(
    permissionIds: readonly string[],
    code: string,
    tx?: PrismaTx,
  ): Promise<DelegationPermissionFlags | null> {
    if (permissionIds.length === 0) return null;
    const db = tx ?? this.prisma;
    return db.permission.findFirst({
      where: { id: { in: [...new Set(permissionIds)] }, code },
      select: { delegatedAccessAllowed: true, servicePrincipalAllowed: true },
    });
  }

  /** Grant 控制面展示所需的最小 Permission 码投影。 */
  async findCodesByIds(
    permissionIds: readonly string[],
  ): Promise<Array<{ id: string; code: string }>> {
    if (permissionIds.length === 0) return [];
    return this.prisma.permission.findMany({
      where: { id: { in: [...new Set(permissionIds)] } },
      select: { id: true, code: true },
    });
  }
}
