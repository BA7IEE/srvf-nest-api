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
  EvaluateRecruitmentApplicationDto,
  IdCardImageUrlResponseDto,
  MarkThresholdDto,
  RecruitmentApplicationAdminDto,
  ResolveRecruitmentApplicationDto,
} from './recruitment.dto';
import { RecruitmentApplicationsService } from './recruitment-applications.service';

// 招新一期 T3(2026-06-18):招新报名 admin surface(评审稿 §3.2 端点 10-13)。
// 入口仅 JwtAuthGuard,判权全在 service rbac.can();读 PII 记 placeholder 审计。
// 证件照取图走短 TTL signed-URL + L3 不入日志(配套②);人工 resolve 走 manual_review / pending_verification 闸
// (分叉④A + 核验中断卡死态恢复,FM-A;系统性审查 §1;2026-06-19 收紧:仅 verifyOutcome 已落的真卡死行可解,
// 核验在途行不可碰、mismatch 卡死行只能 reject)。

function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin - Recruitment Applications')
@ApiBearerAuth()
@ApiExtraModels(RecruitmentApplicationAdminDto, IdCardImageUrlResponseDto)
@Controller('admin/v1/recruitment/applications')
export class RecruitmentApplicationsAdminController {
  constructor(private readonly service: RecruitmentApplicationsService) {}

  @Get()
  @ApiOperation({
    summary:
      '招新报名分页列表(可按 cycleId / statusCode 过滤;身份证号/手机列表掩码) [rbac: recruitment-application.read.record]',
  })
  @ApiWrappedPageResponse(RecruitmentApplicationAdminDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: CurrentUserPayload,
    @Query('cycleId') cycleId?: string,
    @Query('statusCode') statusCode?: string,
  ) {
    return this.service.listForAdmin(query, { cycleId, statusCode }, user);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      '招新报名详情(敏感分级 S3:持 read.sensitive 看明文身份证号/手机,仅 read.record 看脱敏;字段集不变;读 PII 记审计) [rbac: recruitment-application.read.record]',
  })
  @ApiWrappedOkResponse(RecruitmentApplicationAdminDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
  )
  detail(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<RecruitmentApplicationAdminDto> {
    return this.service.detailForAdmin(id, user);
  }

  @Get(':id/id-card-image-url')
  @ApiOperation({
    summary:
      '取证件照短 TTL signed-URL(L3;不入日志/snapshot;读图记审计;敏感分级 S3) [rbac: recruitment-application.read.sensitive]',
  })
  @ApiWrappedOkResponse(IdCardImageUrlResponseDto)
  @ApiBizErrorResponse(
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
  )
  idCardImageUrl(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<IdCardImageUrlResponseDto> {
    return this.service.getIdCardImageUrl(id, user);
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '人工 resolve(manual_review 或 pending_verification 真卡死态〔verifyOutcome 已落库;核验在途态不可碰〕;approved→verified 发临时编号〔受容量限;mismatch 卡死态只能 reject〕/ 否→rejected;不可解或在途→28040) [rbac: recruitment-application.resolve.manual]',
  })
  @ApiWrappedOkResponse(RecruitmentApplicationAdminDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    BizCode.RECRUITMENT_APPLICATION_NOT_PENDING_MANUAL,
  )
  resolve(
    @Param('id') id: string,
    @Body() dto: ResolveRecruitmentApplicationDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<RecruitmentApplicationAdminDto> {
    return this.service.resolveManual(id, dto, user, buildAuditMeta(req), new Date());
  }

  @Patch(':id/thresholds')
  @ApiOperation({
    summary:
      '标/清门槛(巡山×2/培训/红十字/BSAFE;幂等;仅 verified/pending_evaluation 态;末次完成自动→待综合评定) [rbac: recruitment-application.mark.threshold]',
  })
  @ApiWrappedOkResponse(RecruitmentApplicationAdminDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
  )
  markThreshold(
    @Param('id') id: string,
    @Body() dto: MarkThresholdDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<RecruitmentApplicationAdminDto> {
    return this.service.markThreshold(id, dto, user, buildAuditMeta(req), new Date());
  }

  @Post(':id/evaluate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '综合评定/淘汰(单一人工闸;pending_evaluation 通过→公示·不通过→未通过;verified approved=false→门槛超期淘汰;他态或门槛未齐 approve→28041) [rbac: recruitment-application.evaluate.assessment]',
  })
  @ApiWrappedOkResponse(RecruitmentApplicationAdminDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.RECRUITMENT_APPLICATION_NOT_FOUND,
    BizCode.RECRUITMENT_APPLICATION_WRONG_STATE,
  )
  evaluate(
    @Param('id') id: string,
    @Body() dto: EvaluateRecruitmentApplicationDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<RecruitmentApplicationAdminDto> {
    return this.service.evaluate(id, dto, user, buildAuditMeta(req), new Date());
  }
}
