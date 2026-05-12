import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  ContributionRuleQueryDto,
  ContributionRuleResponseDto,
  CreateContributionRuleDto,
  UpdateContributionRuleDto,
} from './contribution-rules.dto';
import { ContributionRulesService } from './contribution-rules.service';

// V2 第一阶段批次 5-A contribution_rules controller(5 路由)。
// 路径前缀:全局 /api(main.ts)+ 'v2/contribution-rules'(决议 E1)。
//
// 权限统一(决议 E4):所有 5 接口 @Roles(SUPER_ADMIN, ADMIN);
// USER 越权 → 通用 FORBIDDEN(40300),不开 23101 模块码(沿 baseline)。
// APD 部门部长 / 副部长专属权限留 5-B 独立批次(F3)。

@ApiTags('contribution-rules')
@ApiBearerAuth()
@Controller('v2/contribution-rules')
export class ContributionRulesController {
  constructor(private readonly service: ContributionRulesService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '列出贡献值规则(分页 + 过滤 activityTypeCode / attendanceRoleCode / status;沿基础稳定排序)',
  })
  @ApiWrappedPageResponse(ContributionRuleResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  list(
    @Query() query: ContributionRuleQueryDto,
  ): Promise<PageResultDto<ContributionRuleResponseDto>> {
    return this.service.list(query);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '创建贡献值规则(字典校验 + 字段语义 + ACTIVE 唯一性兜底含 NULL durationThreshold)',
  })
  @ApiWrappedOkResponse(ContributionRuleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.CONTRIBUTION_RULE_ACTIVE_DUPLICATE,
    BizCode.CONTRIBUTION_RULE_POINTS_INVALID,
    BizCode.CONTRIBUTION_RULE_ACTIVITY_TYPE_INVALID,
    BizCode.CONTRIBUTION_RULE_ROLE_CODE_INVALID,
  )
  create(
    @Body() dto: CreateContributionRuleDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<ContributionRuleResponseDto> {
    return this.service.create(dto, currentUser);
  }

  @Get(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '贡献值规则详情(含软删返 404)' })
  @ApiWrappedOkResponse(ContributionRuleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.CONTRIBUTION_RULE_NOT_FOUND,
  )
  findOne(@Param() params: IdParamDto): Promise<ContributionRuleResponseDto> {
    return this.service.findOne(params.id);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '部分更新贡献值规则(白名单仅 pointsBelow / pointsAbove / dailyCap / status / remark;禁改 activityTypeCode / attendanceRoleCode / durationThreshold,由 ValidationPipe 拦截抛 40000)',
  })
  @ApiWrappedOkResponse(ContributionRuleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.CONTRIBUTION_RULE_NOT_FOUND,
    BizCode.CONTRIBUTION_RULE_ACTIVE_DUPLICATE,
    BizCode.CONTRIBUTION_RULE_POINTS_INVALID,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateContributionRuleDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<ContributionRuleResponseDto> {
    return this.service.update(params.id, dto, currentUser);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '软删贡献值规则(写 deletedAt + deletedByUserId;不强制改 status;删完该维度 attendance 预填走 22048 不抛错路径)',
  })
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.CONTRIBUTION_RULE_NOT_FOUND,
  )
  softDelete(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<void> {
    return this.service.softDelete(params.id, currentUser);
  }
}
