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
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

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
  BatchMarkThresholdDto,
  BatchMarkThresholdResultDto,
  BatchMarkThresholdRowResultDto,
  EvaluateRecruitmentApplicationDto,
  ExportRecruitmentApplicationsDto,
  IdCardImageUrlResponseDto,
  MarkThresholdDto,
  RecruitmentApplicationAdminDto,
  ResolveRecruitmentApplicationDto,
} from './recruitment.dto';
import { RecruitmentApplicationReviewService } from './recruitment-application-review.service';
import { RecruitmentApplicationsQueryService } from './recruitment-applications-query.service';
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
@ApiExtraModels(
  RecruitmentApplicationAdminDto,
  IdCardImageUrlResponseDto,
  BatchMarkThresholdResultDto,
  BatchMarkThresholdRowResultDto,
)
@Controller('admin/v1/recruitment/applications')
export class RecruitmentApplicationsAdminController {
  // god-service 拆分(2026-06-28):读面 → queryService、评审写动作 → reviewService、
  // 人工 resolve(共享发号 FM-C)仍在 service。端点 path/DTO/guard/契约零变,仅内部派发分流。
  constructor(
    private readonly service: RecruitmentApplicationsService,
    private readonly queryService: RecruitmentApplicationsQueryService,
    private readonly reviewService: RecruitmentApplicationReviewService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      '招新报名分页列表(可按 cycleId / statusCode / riskLevel〔S4b 人工队列三栏 normal/high/system〕过滤;身份证号/手机列表掩码) [rbac: recruitment-application.read.record]',
  })
  @ApiWrappedPageResponse(RecruitmentApplicationAdminDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: CurrentUserPayload,
    @Query('cycleId') cycleId?: string,
    @Query('statusCode') statusCode?: string,
    @Query('riskLevel') riskLevel?: string,
  ) {
    return this.queryService.listForAdmin(query, { cycleId, statusCode, riskLevel }, user);
  }

  // 招新闭环优化 S6:批量标门槛 / 批量导出。字面段 export / batch-mark-threshold 在 :id 路由**之前**声明
  // (沿 activity-registrations export 路由顺序铁律;防 Nest 把字面段解析为 :id 参数)。
  @Post('batch-mark-threshold')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '批量标门槛(匹配键 临时编号/手机/姓名+手机,签到记录导入由前端解析为数组;逐行复用单行 markThreshold = 逐行幂等 + 逐行容错〔某行匹配不上/状态非法不整批回滚〕+ 自动推进;返回 per-row 结果 + 批次汇总) [rbac: recruitment-application.mark.threshold]',
  })
  @ApiWrappedOkResponse(BatchMarkThresholdResultDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  batchMarkThreshold(
    @Body() dto: BatchMarkThresholdDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<BatchMarkThresholdResultDto> {
    return this.reviewService.batchMarkThreshold(dto, user, buildAuditMeta(req), new Date());
  }

  @Post('export')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '批量导出 CSV(按筛选 全部/待人工/已初审/门槛未完成/待评定/公示/发号/淘汰;持 read.sensitive → 明文证件号/手机列 / 仅 read.record → 脱敏列〔S3 分级,脱敏复用 toAdminDto〕;读操作记审计) [rbac: recruitment-application.read.record]',
  })
  @ApiProduces('text/csv')
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  async export(
    @Body() dto: ExportRecruitmentApplicationsDto,
    @CurrentUser() user: CurrentUserPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const csv = await this.queryService.exportApplicationsCsv(dto, user);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="recruitment-applications.csv"',
    });
    // UTF-8 BOM(让 Excel 自动识别中文)。
    return new StreamableFile(Buffer.from('﻿' + csv, 'utf8'));
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
    return this.queryService.detailForAdmin(id, user);
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
    return this.queryService.getIdCardImageUrl(id, user);
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
    return this.reviewService.markThreshold(id, dto, user, buildAuditMeta(req), new Date());
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
    return this.reviewService.evaluate(id, dto, user, buildAuditMeta(req), new Date());
  }
}
