import { Injectable } from '@nestjs/common';
import { Prisma, type RecruitmentCycle } from '@prisma/client';

import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PageResultDto } from '../../common/dto/pagination.dto';
import type { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { RbacService } from '../permissions/rbac.service';
import { CYCLE_STATUS_CLOSED, CYCLE_STATUS_OPEN } from './recruitment.constants';
import type {
  CreateRecruitmentCycleDto,
  RecruitmentCycleResponseDto,
  UpdateRecruitmentCycleDto,
} from './recruitment.dto';

// 招新一期 T3(2026-06-18):招新轮次 admin CRUD(评审稿 §3.2 端点 6-9;R 模式判权)。
// 至多一个 open 轮(E-R-11);提交报名落当前唯一 open 轮。审计 cycle.create / cycle.update。

const AUDIT_RESOURCE_TYPE = 'recruitment_cycle';

@Injectable()
export class RecruitmentCyclesService {
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
    dto: CreateRecruitmentCycleDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<RecruitmentCycleResponseDto> {
    await this.assertCanOrThrow(user, 'recruitment-cycle.create.record');
    return this.prisma.$transaction(async (tx) => {
      // 默认 closed,显式开(评审稿 §3.2 端点 7);开轮走 update 走唯一性校验
      const row = await tx.recruitmentCycle.create({
        data: {
          year: dto.year,
          name: dto.name,
          statusCode: CYCLE_STATUS_CLOSED,
          ...(dto.capacity !== undefined ? { capacity: dto.capacity } : {}),
        },
      });
      await this.auditLogs.log({
        event: 'recruitment-cycle.create',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: row.id,
        meta,
        after: {
          year: row.year,
          name: row.name,
          statusCode: row.statusCode,
          capacity: row.capacity,
        },
        tx,
      });
      return this.toResponseDto(row);
    });
  }

  async list(
    query: PaginationQueryDto,
    user: CurrentUserPayload,
  ): Promise<PageResultDto<RecruitmentCycleResponseDto>> {
    await this.assertCanOrThrow(user, 'recruitment-cycle.read.record');
    const where: Prisma.RecruitmentCycleWhereInput = { deletedAt: null };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.recruitmentCycle.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.recruitmentCycle.count({ where }),
    ]);
    return {
      items: rows.map((r) => this.toResponseDto(r)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async detail(id: string, user: CurrentUserPayload): Promise<RecruitmentCycleResponseDto> {
    await this.assertCanOrThrow(user, 'recruitment-cycle.read.record');
    const row = await this.findOrThrow(id, this.prisma);
    return this.toResponseDto(row);
  }

  async update(
    id: string,
    dto: UpdateRecruitmentCycleDto,
    user: CurrentUserPayload,
    meta: AuditMeta,
  ): Promise<RecruitmentCycleResponseDto> {
    await this.assertCanOrThrow(user, 'recruitment-cycle.update.record');
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.findOrThrow(id, tx);

      const data: Prisma.RecruitmentCycleUpdateInput = {};
      if (dto.capacity !== undefined) data.capacity = dto.capacity;
      if (dto.meetingInfo !== undefined) data.meetingInfo = dto.meetingInfo;
      if (dto.qqGroup !== undefined) data.qqGroup = dto.qqGroup;
      if (dto.notifyTemplate !== undefined) {
        data.notifyTemplate = dto.notifyTemplate as Prisma.InputJsonValue;
      }

      if (dto.statusCode !== undefined && dto.statusCode !== existing.statusCode) {
        if (dto.statusCode === CYCLE_STATUS_OPEN) {
          // E-R-11:至多一个 open 轮——开本轮前确认无其它 open 轮
          const otherOpen = await tx.recruitmentCycle.count({
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

      const row = await tx.recruitmentCycle.update({ where: { id }, data });
      await this.auditLogs.log({
        event: 'recruitment-cycle.update',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: row.id,
        meta,
        before: { statusCode: existing.statusCode, capacity: existing.capacity },
        after: { statusCode: row.statusCode, capacity: row.capacity },
        tx,
      });
      return this.toResponseDto(row);
    });
  }

  private async findOrThrow(id: string, client: PrismaService | Prisma.TransactionClient) {
    const row = await client.recruitmentCycle.findFirst({ where: { id, deletedAt: null } });
    if (!row) {
      throw new BizException(BizCode.RECRUITMENT_CYCLE_NOT_FOUND);
    }
    return row;
  }

  private toResponseDto(row: RecruitmentCycle): RecruitmentCycleResponseDto {
    return {
      id: row.id,
      year: row.year,
      name: row.name,
      statusCode: row.statusCode,
      capacity: row.capacity,
      issuedCount: row.tempNoSeq,
      meetingInfo: row.meetingInfo,
      qqGroup: row.qqGroup,
      notifyTemplate: row.notifyTemplate as Record<string, unknown> | null,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
      createdAt: row.createdAt,
    };
  }
}
