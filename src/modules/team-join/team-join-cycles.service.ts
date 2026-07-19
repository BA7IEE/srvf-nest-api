import { Injectable } from '@nestjs/common';
import { OrganizationStatus, Prisma, type TeamJoinCycle } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { CYCLE_STATUS_CLOSED, CYCLE_STATUS_OPEN } from './team-join.constants';
import type {
  CreateTeamJoinCycleDto,
  TeamJoinCycleResponseDto,
  UpdateTeamJoinCycleDto,
} from './team-join.dto';

// 招新三期(入队)T2(2026-06-19):入队轮 admin CRUD(评审稿 §3.2;R 模式判权)。
// 至多一个 open 轮(镜像 recruitment E-R-11);贡献值 cutoff 绑入队轮 year。审计 cycle.create / cycle.update。

const AUDIT_RESOURCE_TYPE = 'team_join_cycle';

@Injectable()
export class TeamJoinCyclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private async assertCanOrThrow(user: CurrentUserPayload, action: string): Promise<void> {
    if (!(await this.rbac.can(user, action))) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  async create(
    dto: CreateTeamJoinCycleDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<TeamJoinCycleResponseDto> {
    await this.assertCanOrThrow(user, 'team-join-cycle.create.record');
    return this.prisma.$transaction(async (tx) => {
      const openOrganizationIds = await this.validateOpenOrganizationIds(
        dto.openOrganizationIds,
        tx,
      );
      // 默认 closed,显式开轮(开轮走 update 的至多一个 open 校验)
      const row = await tx.teamJoinCycle.create({
        data: {
          year: dto.year,
          name: dto.name,
          statusCode: CYCLE_STATUS_CLOSED,
          requiresInsurance: dto.requiresInsurance ?? false,
          openOrganizationIds: openOrganizationIds === null ? Prisma.DbNull : openOrganizationIds,
          maxTargetOrgs: dto.maxTargetOrgs ?? null,
        },
      });
      await this.auditLogs.log({
        event: 'team-join-cycle.create',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: row.id,
        meta,
        after: {
          year: row.year,
          name: row.name,
          statusCode: row.statusCode,
          requiresInsurance: row.requiresInsurance,
          openOrganizationCount: openOrganizationIds?.length ?? 0,
          maxTargetOrgs: row.maxTargetOrgs,
        },
        tx,
      });
      return this.toResponseDto(row);
    });
  }

  async list(
    query: PaginationQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<TeamJoinCycleResponseDto>> {
    await this.assertCanOrThrow(user, 'team-join-cycle.read.record');
    const where: Prisma.TeamJoinCycleWhereInput = { deletedAt: null };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.teamJoinCycle.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.teamJoinCycle.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.toResponseDto(r)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async detail(id: string, user: CurrentUserPayload): Promise<TeamJoinCycleResponseDto> {
    await this.assertCanOrThrow(user, 'team-join-cycle.read.record');
    const row = await this.findOrThrow(id, this.prisma);
    return this.toResponseDto(row);
  }

  async update(
    id: string,
    dto: UpdateTeamJoinCycleDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<TeamJoinCycleResponseDto> {
    await this.assertCanOrThrow(user, 'team-join-cycle.update.record');
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.lockApplicationsThenCycleForUpdate(id, tx);

      const data: Prisma.TeamJoinCycleUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.requiresInsurance !== undefined) {
        data.requiresInsurance = dto.requiresInsurance;
      }
      if (dto.openOrganizationIds !== undefined) {
        const openOrganizationIds = await this.validateOpenOrganizationIds(
          dto.openOrganizationIds,
          tx,
        );
        data.openOrganizationIds =
          openOrganizationIds === null ? Prisma.DbNull : openOrganizationIds;
      }
      if (dto.maxTargetOrgs !== undefined) data.maxTargetOrgs = dto.maxTargetOrgs;

      if (dto.statusCode !== undefined && dto.statusCode !== existing.statusCode) {
        if (dto.statusCode === CYCLE_STATUS_OPEN) {
          // 至多一个 open 轮——count 预检仅友好快速失败(READ COMMITTED 下并发开两轮可穿透);
          // 权威兜底 = team_join_cycles_single_open_unique partial unique,update 处捕 P2002
          // 同转 28231(十项收口刀B,镜像 recruitment-cycles)。
          const otherOpen = await tx.teamJoinCycle.count({
            where: { statusCode: CYCLE_STATUS_OPEN, deletedAt: null, id: { not: id } },
          });
          if (otherOpen > 0) {
            throw new BizException(BizCode.TEAM_JOIN_CYCLE_OPEN_CONFLICT);
          }
          data.statusCode = CYCLE_STATUS_OPEN;
          data.openedAt = new Date();
        } else if (dto.statusCode === CYCLE_STATUS_CLOSED) {
          data.statusCode = CYCLE_STATUS_CLOSED;
          data.closedAt = new Date();
        } else {
          throw new BizException(BizCode.BAD_REQUEST);
        }
      }

      let row;
      try {
        row = await tx.teamJoinCycle.update({ where: { id }, data });
      } catch (err) {
        // 并发开轮穿透被 partial unique 兜底(本表唯一的 unique 面即单 open 索引)
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new BizException(BizCode.TEAM_JOIN_CYCLE_OPEN_CONFLICT);
        }
        throw err;
      }
      await this.auditLogs.log({
        event: 'team-join-cycle.update',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: row.id,
        meta,
        before: {
          statusCode: existing.statusCode,
          requiresInsurance: existing.requiresInsurance,
          name: existing.name,
          openOrganizationCount: ((existing.openOrganizationIds as string[] | null) ?? []).length,
          maxTargetOrgs: existing.maxTargetOrgs,
        },
        after: {
          statusCode: row.statusCode,
          requiresInsurance: row.requiresInsurance,
          name: row.name,
          openOrganizationCount: ((row.openOrganizationIds as string[] | null) ?? []).length,
          maxTargetOrgs: row.maxTargetOrgs,
        },
        tx,
      });
      return this.toResponseDto(row);
    });
  }

  private async findOrThrow(id: string, client: PrismaService | Prisma.TransactionClient) {
    const row = await client.teamJoinCycle.findFirst({ where: { id, deletedAt: null } });
    if (!row) {
      throw new BizException(BizCode.TEAM_JOIN_CYCLE_NOT_FOUND);
    }
    return row;
  }

  private async lockApplicationsThenCycleForUpdate(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<TeamJoinCycle> {
    // 与 final join 的 Application→Cycle 根锁序同向。稳定锁住本轮全部 live application，
    // 再锁并重读 cycle，避免 requiresInsurance 更新与最终消费形成反向锁边或读到旧 flag。
    await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "team_join_applications"
      WHERE "cycleId" = ${id}
        AND "deletedAt" IS NULL
      ORDER BY "id" ASC
      FOR UPDATE
    `);
    const lockedCycles = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "team_join_cycles"
      WHERE "id" = ${id}
        AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (!lockedCycles[0]) {
      throw new BizException(BizCode.TEAM_JOIN_CYCLE_NOT_FOUND);
    }
    const row = await tx.teamJoinCycle.findUnique({ where: { id } });
    if (!row || row.deletedAt !== null) {
      throw new BizException(BizCode.TEAM_JOIN_CYCLE_NOT_FOUND);
    }
    return row;
  }

  private async validateOpenOrganizationIds(
    orgIds: string[] | null | undefined,
    client: PrismaService | Prisma.TransactionClient,
  ): Promise<string[] | null> {
    if (orgIds == null || orgIds.length === 0) return null;
    const unique = [...new Set(orgIds)];
    const rows = await client.organization.findMany({
      where: { id: { in: unique }, deletedAt: null },
      select: { id: true, status: true },
    });
    if (rows.length !== unique.length) {
      throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
    }
    if (rows.some((row) => row.status !== OrganizationStatus.ACTIVE)) {
      throw new BizException(BizCode.ORGANIZATION_INACTIVE);
    }
    return unique;
  }

  private toResponseDto(row: TeamJoinCycle): TeamJoinCycleResponseDto {
    return {
      id: row.id,
      year: row.year,
      name: row.name,
      statusCode: row.statusCode,
      requiresInsurance: row.requiresInsurance,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      openOrganizationIds: (row.openOrganizationIds as string[] | null) ?? null,
      maxTargetOrgs: row.maxTargetOrgs,
      createdAt: row.createdAt,
    };
  }
}
