import { Injectable } from '@nestjs/common';
import { Prisma, type TeamJoinCycle } from '@prisma/client';

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
      // 默认 closed,显式开轮(开轮走 update 的至多一个 open 校验)
      const row = await tx.teamJoinCycle.create({
        data: { year: dto.year, name: dto.name, statusCode: CYCLE_STATUS_CLOSED },
      });
      await this.auditLogs.log({
        event: 'team-join-cycle.create',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: row.id,
        meta,
        after: { year: row.year, name: row.name, statusCode: row.statusCode },
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
      const existing = await this.findOrThrow(id, tx);

      const data: Prisma.TeamJoinCycleUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name;

      if (dto.statusCode !== undefined && dto.statusCode !== existing.statusCode) {
        if (dto.statusCode === CYCLE_STATUS_OPEN) {
          // 至多一个 open 轮——开本轮前确认无其它 open 轮
          const otherOpen = await tx.teamJoinCycle.count({
            where: { statusCode: CYCLE_STATUS_OPEN, deletedAt: null, id: { not: id } },
          });
          if (otherOpen > 0) {
            throw new BizException(BizCode.BAD_REQUEST);
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

      const row = await tx.teamJoinCycle.update({ where: { id }, data });
      await this.auditLogs.log({
        event: 'team-join-cycle.update',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: row.id,
        meta,
        before: { statusCode: existing.statusCode, name: existing.name },
        after: { statusCode: row.statusCode, name: row.name },
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

  private toResponseDto(row: TeamJoinCycle): TeamJoinCycleResponseDto {
    return {
      id: row.id,
      year: row.year,
      name: row.name,
      statusCode: row.statusCode,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      createdAt: row.createdAt,
    };
  }
}
