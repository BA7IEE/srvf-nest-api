import { Injectable } from '@nestjs/common';
import {
  BindingScopeType,
  DelegationGrantStatus,
  Prisma,
  Role,
  ServicePrincipalStatus,
  UserStatus,
} from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { DelegationPermissionEligibilityService } from '../permissions/delegation-permission-eligibility.service';
import { RbacService } from '../permissions/rbac.service';
import {
  CreateDelegationGrantDto,
  DelegationGrantResponseDto,
  type ListDelegationGrantsQueryDto,
  type RevokeDelegationGrantDto,
} from './delegation-grants.dto';

const delegationGrantSelect = {
  id: true,
  servicePrincipalId: true,
  subjectUserId: true,
  status: true,
  scopeType: true,
  scopeOrgId: true,
  scopeActivityId: true,
  scopeResourceType: true,
  scopeResourceId: true,
  startedAt: true,
  endedAt: true,
  createdByUserId: true,
  createdAt: true,
  revokedAt: true,
  revokedByUserId: true,
  revokeReason: true,
} as const satisfies Prisma.DelegationGrantSelect;

type DelegationGrantRow = Prisma.DelegationGrantGetPayload<{
  select: typeof delegationGrantSelect;
}>;

/**
 * Integration Foundation v1 PR5(规格书 §19/§36/§61):DelegationGrant 控制面。
 *
 * 创建时锁定并复核 Permission eligibility；撤销保留历史行，供双主体审计与后续追溯。
 */
@Injectable()
export class DelegationGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly delegationPermissions: DelegationPermissionEligibilityService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async create(
    currentUser: CurrentUserPayload,
    dto: CreateDelegationGrantDto,
    auditMeta: AuditMeta,
  ): Promise<DelegationGrantResponseDto> {
    await this.assertCanOrThrow(currentUser, 'delegation-grant.create.record');
    const scope = this.normalizeScopeOrThrow(dto);
    const term = this.normalizeTermOrThrow(dto);
    const permissionCodes = [...new Set(dto.permissionCodes)].sort();
    if (permissionCodes.length === 0) throw new BizException(BizCode.BAD_REQUEST);
    if (scope.scopeType === BindingScopeType.GLOBAL && currentUser.role !== Role.SUPER_ADMIN) {
      // §19:GLOBAL 委托需要 SUPER_ADMIN 明确创建，ops-admin 不能把边界扩大成全局。
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const servicePrincipal = await tx.servicePrincipal.findFirst({
        where: {
          id: dto.servicePrincipalId,
          deletedAt: null,
          status: ServicePrincipalStatus.ACTIVE,
        },
        select: { id: true },
      });
      if (servicePrincipal === null) {
        throw new BizException(BizCode.SERVICE_PRINCIPAL_NOT_FOUND);
      }

      const subjectUser = await tx.user.findFirst({
        where: { id: dto.subjectUserId },
        select: { id: true, status: true, deletedAt: true },
      });
      if (
        subjectUser === null ||
        subjectUser.deletedAt !== null ||
        subjectUser.status !== UserStatus.ACTIVE
      ) {
        throw new BizException(BizCode.USER_NOT_FOUND);
      }

      // §31:锁住所有目标 Permission 后再读一遍。这样 Role/Permission 管理面并发改资格门时，
      // 不会在「检查通过 → grant 落库」窗口塞进一条已失效授权。
      const permissions = await this.delegationPermissions.lockAndFindEligibleByCodes(
        tx,
        permissionCodes,
      );
      if (permissions === null) throw new BizException(BizCode.BAD_REQUEST);

      const grant = await tx.delegationGrant.create({
        data: {
          servicePrincipalId: dto.servicePrincipalId,
          subjectUserId: dto.subjectUserId,
          status: DelegationGrantStatus.ACTIVE,
          ...scope,
          startedAt: term.startedAt,
          endedAt: term.endedAt,
          createdByUserId: currentUser.id,
          permissions: {
            create: permissions.map((permission) => ({ permissionId: permission.id })),
          },
        },
        select: delegationGrantSelect,
      });
      const sortedCodes = permissions.map((permission) => permission.code).sort();
      await this.auditLogs.log({
        event: 'delegation-grant.create',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'delegation-grant',
        resourceId: grant.id,
        meta: auditMeta,
        after: {
          status: grant.status,
          scopeType: grant.scopeType,
          startedAt: grant.startedAt.toISOString(),
          endedAt: grant.endedAt?.toISOString() ?? null,
        },
        extra: {
          servicePrincipalId: grant.servicePrincipalId,
          subjectUserId: grant.subjectUserId,
          permissionCodes: sortedCodes,
        },
        tx,
      });
      return { grant, permissionCodes: sortedCodes };
    });

    return this.present(created.grant, created.permissionCodes);
  }

  async list(
    currentUser: CurrentUserPayload,
    query: ListDelegationGrantsQueryDto,
  ): Promise<{
    items: DelegationGrantResponseDto[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    await this.assertCanOrThrow(currentUser, 'delegation-grant.read.record');
    const where: Prisma.DelegationGrantWhereInput = {};
    if (query.status !== undefined) where.status = query.status;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.delegationGrant.findMany({
        where,
        select: delegationGrantSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.delegationGrant.count({ where }),
    ]);
    return {
      items: await this.presentMany(rows),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async findOne(currentUser: CurrentUserPayload, id: string): Promise<DelegationGrantResponseDto> {
    await this.assertCanOrThrow(currentUser, 'delegation-grant.read.record');
    const grant = await this.prisma.delegationGrant.findFirst({
      where: { id: id },
      select: delegationGrantSelect,
    });
    if (grant === null) throw new BizException(BizCode.DELEGATION_GRANT_INVALID);
    return (await this.presentMany([grant]))[0];
  }

  async revoke(
    currentUser: CurrentUserPayload,
    id: string,
    dto: RevokeDelegationGrantDto,
    auditMeta: AuditMeta,
  ): Promise<DelegationGrantResponseDto> {
    await this.assertCanOrThrow(currentUser, 'delegation-grant.revoke.record');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`
          SELECT "id"
          FROM "delegation_grants"
          WHERE "id" = ${id}
          FOR UPDATE
        `,
      );
      const current = await tx.delegationGrant.findFirst({
        where: { id: id },
        select: delegationGrantSelect,
      });
      if (
        current === null ||
        current.status !== DelegationGrantStatus.ACTIVE ||
        current.revokedAt !== null
      ) {
        throw new BizException(BizCode.DELEGATION_GRANT_INVALID);
      }

      const grant = await tx.delegationGrant.update({
        where: { id: id },
        data: {
          status: DelegationGrantStatus.REVOKED,
          revokedAt: new Date(),
          revokedByUserId: currentUser.id,
          revokeReason: dto.reason ?? null,
        },
        select: delegationGrantSelect,
      });
      await this.auditLogs.log({
        event: 'delegation-grant.revoke',
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        resourceType: 'delegation-grant',
        resourceId: grant.id,
        meta: auditMeta,
        before: { status: current.status },
        after: { status: grant.status, revokedAt: grant.revokedAt?.toISOString() ?? null },
        extra: { operation: 'revoke' },
        tx,
      });
      return grant;
    });
    return (await this.presentMany([updated]))[0];
  }

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  private normalizeScopeOrThrow(dto: CreateDelegationGrantDto): {
    scopeType: BindingScopeType;
    scopeOrgId: string | null;
    scopeActivityId: string | null;
    scopeResourceType: string | null;
    scopeResourceId: string | null;
  } {
    const scope = {
      scopeType: dto.scopeType,
      scopeOrgId: dto.scopeOrgId ?? null,
      scopeActivityId: dto.scopeActivityId ?? null,
      scopeResourceType: dto.scopeResourceType ?? null,
      scopeResourceId: dto.scopeResourceId ?? null,
    };
    const noScopeFields =
      scope.scopeOrgId === null &&
      scope.scopeActivityId === null &&
      scope.scopeResourceType === null &&
      scope.scopeResourceId === null;
    const onlyOrg =
      scope.scopeOrgId !== null &&
      scope.scopeActivityId === null &&
      scope.scopeResourceType === null &&
      scope.scopeResourceId === null;
    const onlyActivity =
      scope.scopeOrgId === null &&
      scope.scopeActivityId !== null &&
      scope.scopeResourceType === null &&
      scope.scopeResourceId === null;
    const onlyResource =
      scope.scopeOrgId === null &&
      scope.scopeActivityId === null &&
      scope.scopeResourceType !== null &&
      scope.scopeResourceId !== null;
    const valid =
      (scope.scopeType === BindingScopeType.GLOBAL && noScopeFields) ||
      ((scope.scopeType === BindingScopeType.ORGANIZATION ||
        scope.scopeType === BindingScopeType.ORGANIZATION_TREE) &&
        onlyOrg) ||
      (scope.scopeType === BindingScopeType.ACTIVITY && onlyActivity) ||
      (scope.scopeType === BindingScopeType.RESOURCE && onlyResource);
    if (!valid) throw new BizException(BizCode.BAD_REQUEST);
    return scope;
  }

  private normalizeTermOrThrow(dto: CreateDelegationGrantDto): {
    startedAt: Date;
    endedAt: Date | null;
  } {
    const startedAt = dto.startedAt === undefined ? new Date() : new Date(dto.startedAt);
    const endedAt = dto.endedAt === undefined ? null : new Date(dto.endedAt);
    if (
      Number.isNaN(startedAt.getTime()) ||
      (endedAt !== null &&
        (Number.isNaN(endedAt.getTime()) || endedAt.getTime() <= startedAt.getTime()))
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    return { startedAt, endedAt };
  }

  private async presentMany(
    grants: readonly DelegationGrantRow[],
  ): Promise<DelegationGrantResponseDto[]> {
    if (grants.length === 0) return [];
    const grantIds = grants.map((grant) => grant.id);
    const grantPermissions = await this.prisma.delegationGrantPermission.findMany({
      where: { grantId: { in: grantIds } },
      select: { grantId: true, permissionId: true },
    });
    const permissionIds = [...new Set(grantPermissions.map((row) => row.permissionId))];
    const permissions = await this.delegationPermissions.findCodesByIds(permissionIds);
    const codeByPermissionId = new Map(
      permissions.map((permission) => [permission.id, permission.code]),
    );
    const codesByGrantId = new Map<string, string[]>();
    for (const relation of grantPermissions) {
      const code = codeByPermissionId.get(relation.permissionId);
      if (code === undefined) continue;
      const codes = codesByGrantId.get(relation.grantId) ?? [];
      codes.push(code);
      codesByGrantId.set(relation.grantId, codes);
    }
    return grants.map((grant) => this.present(grant, (codesByGrantId.get(grant.id) ?? []).sort()));
  }

  private present(
    grant: DelegationGrantRow,
    permissionCodes: string[],
  ): DelegationGrantResponseDto {
    return {
      id: grant.id,
      servicePrincipalId: grant.servicePrincipalId,
      subjectUserId: grant.subjectUserId,
      status: grant.status,
      scopeType: grant.scopeType,
      scopeOrgId: grant.scopeOrgId,
      scopeActivityId: grant.scopeActivityId,
      scopeResourceType: grant.scopeResourceType,
      scopeResourceId: grant.scopeResourceId,
      permissionCodes,
      startedAt: grant.startedAt,
      endedAt: grant.endedAt,
      createdByUserId: grant.createdByUserId,
      createdAt: grant.createdAt,
      revokedAt: grant.revokedAt,
      revokedByUserId: grant.revokedByUserId,
      revokeReason: grant.revokeReason,
    };
  }
}
