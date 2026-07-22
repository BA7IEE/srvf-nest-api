import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiWrappedCreatedResponse,
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CreateTeamJoinCycleDto,
  TeamJoinCycleResponseDto,
  UpdateTeamJoinCycleDto,
} from './team-join.dto';
import { TeamJoinCyclesService } from './team-join-cycles.service';

// 招新三期(入队)T2(2026-06-19):入队轮 admin surface(评审稿 §3.2)。
// 入口仅 JwtAuthGuard,**不**挂 @Roles;判权全在 service rbac.can()(R 模式)。
// 至多一个 open 轮(service update 校验);审计 cycle.create / cycle.update 由 service 写。

function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin - Team Join Cycles')
@ApiBearerAuth()
@ApiExtraModels(TeamJoinCycleResponseDto)
@Controller('admin/v1/team-join/cycles')
export class TeamJoinCyclesController {
  constructor(private readonly service: TeamJoinCyclesService) {}

  @Post()
  @ApiOperation({
    summary:
      '创建入队轮(默认 closed;可配置开放候选部门清单与候选数上限,清单 org 须 ACTIVE) [rbac: team-join-cycle.create.record]',
  })
  @ApiWrappedCreatedResponse(TeamJoinCycleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
  )
  create(
    @Body() dto: CreateTeamJoinCycleDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<TeamJoinCycleResponseDto> {
    return this.service.create(dto, user, buildAuditMeta(req));
  }

  @Get()
  @ApiOperation({ summary: '入队轮分页列表 [rbac: team-join-cycle.read.record]' })
  @ApiWrappedPageResponse(TeamJoinCycleResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(@Query() query: PaginationQueryDto, @CurrentUser() user: CurrentUserPayload) {
    return this.service.list(query, user);
  }

  @Get(':id')
  @ApiOperation({ summary: '入队轮详情 [rbac: team-join-cycle.read.record]' })
  @ApiWrappedOkResponse(TeamJoinCycleResponseDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.TEAM_JOIN_CYCLE_NOT_FOUND,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
  )
  detail(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<TeamJoinCycleResponseDto> {
    return this.service.detail(id, user);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '更新入队轮(开/关轮、轮次名、开放候选部门清单与候选数上限;开 open 轮要求当前无其它 open 轮) [rbac: team-join-cycle.update.record]',
  })
  @ApiWrappedOkResponse(TeamJoinCycleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.TEAM_JOIN_CYCLE_NOT_FOUND,
  )
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTeamJoinCycleDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<TeamJoinCycleResponseDto> {
    return this.service.update(id, dto, user, buildAuditMeta(req));
  }
}
