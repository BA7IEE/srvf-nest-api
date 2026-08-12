import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  EvaluateTeamJoinApplicationDto,
  GateStatusDto,
  JoinTeamJoinApplicationDto,
  ListTeamJoinApplicationsQueryDto,
  MarkGateDto,
  TeamJoinApplicationAdminDto,
} from './team-join.dto';
import { TeamJoinApplicationsService } from './team-join-applications.service';
import { TeamJoinEnrollmentService } from './team-join-enrollment.service';
import { RequiresPermission } from '../../common/decorators/route-authz.decorator';

// 招新三期(入队)T2/T4(2026-06-19):入队申请 admin surface(评审稿 §3.2)。
// 入口仅 JwtAuthGuard,判权全在 service rbac.can()。标 gate(幂等;末次全过 + 贡献值≥5 自动推进)/
// 综合评估(单一人工闸)/ 一键入队(T4:设部门 + 级别 level-1,单事务原子)。app 自助发起/查进度在 T3。

function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin - Team Join Applications')
@ApiBearerAuth()
@ApiExtraModels(TeamJoinApplicationAdminDto, GateStatusDto)
@Controller('admin/v1/team-join/applications')
export class TeamJoinApplicationsAdminController {
  constructor(
    private readonly service: TeamJoinApplicationsService,
    private readonly enrollment: TeamJoinEnrollmentService,
  ) {}

  @Get()
  @RequiresPermission('team-join-application.read.record', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({
    summary:
      '入队申请分页列表(可按 cycleId / statusCode 过滤;贡献值列表不算) [rbac: team-join-application.read.record]',
  })
  @ApiWrappedPageResponse(TeamJoinApplicationAdminDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(@Query() query: ListTeamJoinApplicationsQueryDto, @CurrentUser() user: CurrentUserPayload) {
    return this.service.listForAdmin(
      query,
      { cycleId: query.cycleId, statusCode: query.statusCode },
      user,
    );
  }

  @Get(':id')
  @RequiresPermission('team-join-application.read.record', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({
    summary:
      '入队申请详情(含各 gate 实况 + 实时贡献值汇总) [rbac: team-join-application.read.record]',
  })
  @ApiWrappedOkResponse(TeamJoinApplicationAdminDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND,
  )
  detail(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<TeamJoinApplicationAdminDto> {
    return this.service.detailForAdmin(id, user);
  }

  @Patch(':id/gates')
  @RequiresPermission('team-join-application.mark.gate', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '标 gate(8 通用 + 4 专业队;通过/未通过 + 完成日 + dept-assessment 可延长期;幂等;仅 joining/pending_evaluation 态;末次 8 通用全过 + 贡献值≥5 自动→待综合评估) [rbac: team-join-application.mark.gate]',
  })
  @ApiWrappedOkResponse(TeamJoinApplicationAdminDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND,
    BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE,
  )
  markGate(
    @Param('id') id: string,
    @Body() dto: MarkGateDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<TeamJoinApplicationAdminDto> {
    return this.service.markGate(id, dto, user, buildAuditMeta(req), new Date());
  }

  @Post(':id/evaluate')
  @RequiresPermission('team-join-application.evaluate.assessment', {
    require: 'all',
    engine: 'rbac-global',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '综合评估/淘汰(单一人工闸;pending_evaluation 通过→待入队·不通过→未通过;joining approved=false→门槛超期淘汰;他态或门槛未齐 approve→冲突) [rbac: team-join-application.evaluate.assessment]',
  })
  @ApiWrappedOkResponse(TeamJoinApplicationAdminDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND,
    BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE,
  )
  evaluate(
    @Param('id') id: string,
    @Body() dto: EvaluateTeamJoinApplicationDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<TeamJoinApplicationAdminDto> {
    return this.service.evaluate(id, dto, user, buildAuditMeta(req), new Date());
  }

  @Post(':id/join')
  @RequiresPermission('team-join-application.join.member', {
    require: 'all',
    engine: 'rbac-global',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    // ⚠️ 「综合评估本轮有效 / 延长期」那句已于 2026-07-31 并发审计 S5 废止:
    // approved 资格**不随轮关闭失效**,final join 不消费评估延长期
    // (运行时事实见 team-join-enrollment.service 步骤 2;canonical 见 docs/handoff/admin-web.md:528,
    // 边界由 team-join-enrollment-lifecycle-concurrency e2e 锁住)。
    // 留着它就是让 OpenAPI 契约替一条不存在的行为背书 —— 前端据此做 UI 会做错。
    summary:
      '一键入队(志愿者→队员):approved 申请选定单一部门 → 单事务设部门 + 级别 level-1 → joined(原子/幂等;专业队需对应 gate 过;选定部门须在候选;approved 资格不随轮关闭失效) [rbac: team-join-application.join.member]',
  })
  @ApiWrappedOkResponse(TeamJoinApplicationAdminDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.TEAM_JOIN_APPLICATION_NOT_FOUND,
    BizCode.TEAM_JOIN_APPLICATION_WRONG_STATE,
    BizCode.TEAM_JOIN_MEMBER_ALREADY_ENROLLED,
    BizCode.TEAM_JOIN_GATES_NOT_SATISFIED,
    BizCode.TEAM_JOIN_DEPARTMENT_NOT_ELIGIBLE,
    BizCode.TEAM_JOIN_INSURANCE_REQUIRED,
  )
  join(
    @Param('id') id: string,
    @Body() dto: JoinTeamJoinApplicationDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<TeamJoinApplicationAdminDto> {
    return this.enrollment.join(id, dto, user, buildAuditMeta(req), new Date());
  }
}
