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
import { PaginationQueryDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CreateRecruitmentCycleDto,
  PromotePrecheckResultDto,
  PromotePrecheckRowDto,
  PromoteResultDto,
  PromoteSkippedItemDto,
  PromotedItemDto,
  PublicityListItemDto,
  PublicityListResponseDto,
  RecruitmentCycleResponseDto,
  RecruitmentCycleStatsDto,
  RecruitmentStatsEvaluationDto,
  RecruitmentStatsIssuanceDto,
  RecruitmentStatsPendingDto,
  RecruitmentStatsThresholdDto,
  RecruitmentStatsThresholdItemDto,
  RecruitmentStatsTodayDto,
  UpdateRecruitmentCycleDto,
} from './recruitment.dto';
import { RecruitmentApplicationsService } from './recruitment-applications.service';
import { RecruitmentCyclesService } from './recruitment-cycles.service';
import { RecruitmentPromotionService } from './recruitment-promotion.service';
import { RecruitmentStatsService } from './recruitment-stats.service';

// 招新一期 T3(2026-06-18):招新轮次 admin surface(评审稿 §3.2 端点 6-9)。
// 入口仅 JwtAuthGuard,**不**挂 @Roles;判权全在 service rbac.can()(R 模式)。
// 审计 cycle.create / cycle.update 由 service 写。至多一个 open 轮(E-R-11,service update 校验)。

function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin - Recruitment Cycles')
@ApiBearerAuth()
@ApiExtraModels(
  RecruitmentCycleResponseDto,
  PublicityListResponseDto,
  PublicityListItemDto,
  PromoteResultDto,
  PromotedItemDto,
  PromoteSkippedItemDto,
  PromotePrecheckResultDto,
  PromotePrecheckRowDto,
  RecruitmentCycleStatsDto,
  RecruitmentStatsTodayDto,
  RecruitmentStatsPendingDto,
  RecruitmentStatsThresholdDto,
  RecruitmentStatsThresholdItemDto,
  RecruitmentStatsEvaluationDto,
  RecruitmentStatsIssuanceDto,
)
@Controller('admin/v1/recruitment/cycles')
export class RecruitmentCyclesController {
  constructor(
    private readonly service: RecruitmentCyclesService,
    private readonly applicationsService: RecruitmentApplicationsService,
    private readonly promotionService: RecruitmentPromotionService,
    private readonly statsService: RecruitmentStatsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: '创建招新轮次(默认 closed,需显式开轮) [rbac: recruitment-cycle.create.record]',
  })
  @ApiWrappedOkResponse(RecruitmentCycleResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  create(
    @Body() dto: CreateRecruitmentCycleDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<RecruitmentCycleResponseDto> {
    return this.service.create(dto, user, buildAuditMeta(req));
  }

  @Get()
  @ApiOperation({ summary: '招新轮次分页列表 [rbac: recruitment-cycle.read.record]' })
  @ApiWrappedPageResponse(RecruitmentCycleResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(@Query() query: PaginationQueryDto, @CurrentUser() user: CurrentUserPayload) {
    return this.service.list(query, user);
  }

  @Get(':id')
  @ApiOperation({ summary: '招新轮次详情 [rbac: recruitment-cycle.read.record]' })
  @ApiWrappedOkResponse(RecruitmentCycleResponseDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_CYCLE_NOT_FOUND,
  )
  detail(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<RecruitmentCycleResponseDto> {
    return this.service.detail(id, user);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '更新招新轮次(开/关轮、容量、见面会/QQ群/通知模板;开 open 轮要求当前无其它 open 轮) [rbac: recruitment-cycle.update.record]',
  })
  @ApiWrappedOkResponse(RecruitmentCycleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_CYCLE_NOT_FOUND,
  )
  update(
    @Param('id') id: string,
    @Body() dto: UpdateRecruitmentCycleDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<RecruitmentCycleResponseDto> {
    return this.service.update(id, dto, user, buildAuditMeta(req));
  }

  @Get(':id/publicity-list')
  @ApiOperation({
    summary:
      '公示名单(姓名 + 拟发编号,拼音序,零敏感;外籍 needsManualBuild=true 不占号、一键发号不含) [rbac: recruitment-application.read.record]',
  })
  @ApiWrappedOkResponse(PublicityListResponseDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_CYCLE_NOT_FOUND,
  )
  publicityList(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<PublicityListResponseDto> {
    return this.applicationsService.publicityList(id, user);
  }

  @Get(':id/stats')
  @ApiOperation({
    summary:
      '招新工作台聚合 stats(今日数据/待处理事项/门槛进度/综合评定/公示发号 五组;纯读零写;各业务态计数与 stage 派生同源) [rbac: recruitment-application.read.record]',
  })
  @ApiWrappedOkResponse(RecruitmentCycleStatsDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_CYCLE_NOT_FOUND,
  )
  stats(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<RecruitmentCycleStatsDto> {
    return this.statsService.getCycleStats(id, user, new Date());
  }

  @Get(':id/promote-precheck')
  @ApiOperation({
    summary:
      '一键发号前预检(纯读;复用 decidePromotionIssuance 结构性保证「预检=实发」;逐行可发/跳过 + 六类跳过原因 + 重复 openid 高亮 + 缺手机/生日/性别 + 特殊证件标识 + 汇总) [rbac: recruitment-application.promote.member]',
  })
  @ApiWrappedOkResponse(PromotePrecheckResultDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_CYCLE_NOT_FOUND,
  )
  promotePrecheck(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<PromotePrecheckResultDto> {
    return this.promotionService.promotePrecheck(id, user);
  }

  @Post(':id/promote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '公示结束一键发号:对公示报名按拼音序批量发永久编号 {YY}{NNN} + 建 User+Member+档案+紧急联系人(单事务原子/幂等;外籍 skip+report 不 block;空集零发) [rbac: recruitment-application.promote.member]',
  })
  @ApiWrappedOkResponse(PromoteResultDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_CYCLE_NOT_FOUND,
    BizCode.RECRUITMENT_APPLICATION_NOT_PROMOTABLE,
    BizCode.RECRUITMENT_MEMBER_NO_EXHAUSTED,
    // S5(评审稿 §5.2a):promote 现建 VOL 归口部门;该部门缺失/非 ACTIVE → 事务前清晰失败
    BizCode.RECRUITMENT_VOLUNTEER_ORG_UNAVAILABLE,
    // F3(#399):展开报名 JSON → emergency_contacts 行时校验 relation 字典码
    BizCode.EMERGENCY_CONTACT_RELATION_CODE_INVALID,
  )
  promote(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<PromoteResultDto> {
    return this.promotionService.promote(id, user, buildAuditMeta(req), new Date());
  }
}
