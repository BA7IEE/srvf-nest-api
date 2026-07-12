import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CreateAppTeamJoinApplicationDto,
  AppTeamJoinApplicationDto,
  UpdateAppTeamJoinTargetsDto,
} from './dto/app/app-team-join.dto';
import { GateStatusDto } from './team-join.dto';
import { AppMeTeamJoinService } from './team-join-applications.app.service';

// 招新三期(入队)T3(2026-06-19):App 自助面 Mobile Controller(评审稿 §3.2 / E-J-5)。
// 入口仅全局 JwtAuthGuard;**不**挂 @Roles / @Public / RBAC / 限流;准入 + self-scope 全前置在 service;
// 永不返回 L3。发起入队申请 / 查进度 / 改候选部门;一键入队走 admin T4。

function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Mobile - My Team Join')
@ApiBearerAuth()
@ApiExtraModels(AppTeamJoinApplicationDto, GateStatusDto)
@Controller('app/v1/me/team-join')
export class TeamJoinApplicationsAppController {
  constructor(private readonly service: AppMeTeamJoinService) {}

  @Post('applications')
  @ApiOperation({
    summary:
      '发起入队申请(候选须属于本轮开放清单且不超过轮上限;需有 open 入队轮 + 本人未入队;同轮防重) [auth]',
  })
  @ApiWrappedOkResponse(AppTeamJoinApplicationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.TEAM_JOIN_MEMBER_ALREADY_ENROLLED,
    BizCode.TEAM_JOIN_CYCLE_NOT_OPEN,
    BizCode.TEAM_JOIN_DUPLICATE_APPLICATION,
    BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
  )
  submit(
    @Body() dto: CreateAppTeamJoinApplicationDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppTeamJoinApplicationDto> {
    return this.service.submit(dto, currentUser, buildAuditMeta(req), new Date());
  }

  @Get('applications/current')
  @ApiOperation({
    summary: '查本人当前入队进度(状态 / 各 gate 实况 / 实时贡献值 / 候选部门;无申请→404) [auth]',
  })
  @ApiWrappedOkResponse(AppTeamJoinApplicationDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND,
  )
  current(@CurrentUser() currentUser: CurrentUserPayload): Promise<AppTeamJoinApplicationDto> {
    return this.service.getCurrent(currentUser);
  }

  @Patch('applications/:id/targets')
  @ApiOperation({
    summary:
      '改候选目标部门(仅本人 + joining 态;每个 org 须存在+ACTIVE、属于本轮开放清单且不超过轮上限) [auth]',
  })
  @ApiWrappedOkResponse(AppTeamJoinApplicationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND,
    BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE,
    BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
  )
  updateTargets(
    @Param('id') id: string,
    @Body() dto: UpdateAppTeamJoinTargetsDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppTeamJoinApplicationDto> {
    return this.service.updateTargets(id, dto, currentUser, buildAuditMeta(req), new Date());
  }
}
