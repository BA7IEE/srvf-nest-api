import {
  HttpStatus,
  HttpCode,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
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
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  AddAllActiveCoverageResultDto,
  AddTeamInsuranceCoverageDto,
  CreateTeamInsurancePolicyDto,
  ListTeamInsuranceCoverageQueryDto,
  ListTeamInsurancePoliciesQueryDto,
  TeamInsuranceCoverageResponseDto,
  TeamInsurancePolicyResponseDto,
  UpdateTeamInsurancePolicyDto,
} from './insurances.dto';
import { TeamInsurancePoliciesService } from './team-insurance-policies.service';

// 保险模块 T2:队统一保单 + 覆盖名单 admin controller(2026-06-13)。
// 冻结评审稿 docs/archive/reviews/insurance-module-review.md §3.2 端点 5-13。
//
// 权限:入口仅 JwtAuthGuard(不标 @Roles,沿 Slow-4 单轨),判权下沉 service 层
// rbac.can('team-insurance-policy.*')(SUPER_ADMIN 短路;biz-admin 绑全部;
// list/detail/覆盖名单共用 read)。
//
// 路由声明顺序(NestJS 优先级要求):
//   1. GET ''                                  list
//   2. POST ''                                 create
//   3. GET ':id'                               findOne
//   4. PATCH ':id'                             update
//   5. DELETE ':id'                            softDelete
//   6. GET ':id/members'                       listCoverage
//   7. POST ':id/members'                      addMember(单加)
//   8. POST ':id/members/add-all-active'       addAllActiveMembers(一键加;字面段与 7 不同 path 不遮蔽)
//   9. DELETE ':id/members/:memberId'          removeMember
@ApiTags('Admin - Team Insurance Policies')
@ApiBearerAuth()
@ApiExtraModels(TeamInsurancePolicyResponseDto, TeamInsuranceCoverageResponseDto, PageResultDto)
@Controller('admin/v1/team-insurance-policies')
export class TeamInsurancePoliciesController {
  constructor(private readonly service: TeamInsurancePoliciesService) {}

  // 沿 V2 批次 6 PR #2 范式:从 @Req() 构造 AuditMeta 显式传给 service(写操作)。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get()
  @ApiOperation({
    summary: '队保单分页列表(软删过滤;createdAt desc) [rbac: team-insurance-policy.read.record]',
  })
  @ApiWrappedPageResponse(TeamInsurancePolicyResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @Query() query: ListTeamInsurancePoliciesQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<TeamInsurancePolicyResponseDto>> {
    return this.service.list(query, currentUser);
  }

  @Post()
  @ApiOperation({
    summary:
      '创建队保单(一张 = 一条;起保 ≤ 到期否则 26010) [rbac: team-insurance-policy.create.record]',
  })
  @ApiWrappedCreatedResponse(TeamInsurancePolicyResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.INSURANCE_COVERAGE_DATE_RANGE_INVALID,
  )
  create(
    @Body() dto: CreateTeamInsurancePolicyDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<TeamInsurancePolicyResponseDto> {
    return this.service.create(dto, currentUser, this.buildAuditMeta(req));
  }

  @Get(':id')
  @ApiOperation({
    summary:
      '队保单详情(不含覆盖名单,名单走 :id/members) [rbac: team-insurance-policy.read.record]',
  })
  @ApiWrappedOkResponse(TeamInsurancePolicyResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.TEAM_INSURANCE_POLICY_NOT_FOUND,
  )
  findOne(
    @Param('id') id: string,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<TeamInsurancePolicyResponseDto> {
    return this.service.findOne(id, currentUser);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '部分更新队保单(终态起保 ≤ 到期否则 26010;note 传空串清空) [rbac: team-insurance-policy.update.record]',
  })
  @ApiWrappedOkResponse(TeamInsurancePolicyResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.TEAM_INSURANCE_POLICY_NOT_FOUND,
    BizCode.INSURANCE_COVERAGE_DATE_RANGE_INVALID,
  )
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTeamInsurancePolicyDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<TeamInsurancePolicyResponseDto> {
    return this.service.update(id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '软删队保单(不级联覆盖行,门槛查询对被删保单自然失效) [rbac: team-insurance-policy.delete.record]',
  })
  @ApiWrappedOkResponse(TeamInsurancePolicyResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.TEAM_INSURANCE_POLICY_NOT_FOUND,
  )
  softDelete(
    @Param('id') id: string,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<TeamInsurancePolicyResponseDto> {
    return this.service.softDelete(id, currentUser, this.buildAuditMeta(req));
  }

  @Get(':id/members')
  @ApiOperation({
    summary: '保单覆盖名单分页列表(含队员编号/姓名摘要) [rbac: team-insurance-policy.read.record]',
  })
  @ApiWrappedPageResponse(TeamInsuranceCoverageResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.TEAM_INSURANCE_POLICY_NOT_FOUND,
  )
  listCoverage(
    @Param('id') id: string,
    @Query() query: ListTeamInsuranceCoverageQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<TeamInsuranceCoverageResponseDto>> {
    return this.service.listCoverage(id, query, currentUser);
  }

  @Post(':id/members')
  @ApiOperation({
    summary:
      '覆盖名单单加队员(重复 → 26004;队员须存在未软删) [rbac: team-insurance-policy.add.member]',
  })
  @ApiWrappedCreatedResponse(TeamInsuranceCoverageResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.TEAM_INSURANCE_POLICY_NOT_FOUND,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.TEAM_INSURANCE_COVERAGE_ALREADY_EXISTS,
  )
  addMember(
    @Param('id') id: string,
    @Body() dto: AddTeamInsuranceCoverageDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<TeamInsuranceCoverageResponseDto> {
    return this.service.addMember(id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Post(':id/members/add-all-active')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '全体在册一键加入覆盖名单(仅 ACTIVE 未软删队员;幂等,已在名单跳过,二跑 addedCount=0) [rbac: team-insurance-policy.add.member]',
  })
  @ApiWrappedOkResponse(AddAllActiveCoverageResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.TEAM_INSURANCE_POLICY_NOT_FOUND,
  )
  addAllActiveMembers(
    @Param('id') id: string,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AddAllActiveCoverageResultDto> {
    return this.service.addAllActiveMembers(id, currentUser, this.buildAuditMeta(req));
  }

  @Delete(':id/members/:memberId')
  @ApiOperation({
    summary:
      '覆盖名单移除队员(软删覆盖行;partial unique 允许重新加入;不在名单 → 26003) [rbac: team-insurance-policy.remove.member]',
  })
  @ApiWrappedOkResponse(TeamInsuranceCoverageResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.TEAM_INSURANCE_POLICY_NOT_FOUND,
    BizCode.TEAM_INSURANCE_COVERAGE_NOT_FOUND,
  )
  removeMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<TeamInsuranceCoverageResponseDto> {
    return this.service.removeMember(id, memberId, currentUser, this.buildAuditMeta(req));
  }
}
