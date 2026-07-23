import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { IdParamDto } from '../../../common/dto/id-param.dto';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import {
  ApproveActivityPublishReviewDto,
  ActivityPublishReviewResponseDto,
  ListActivityPublishReviewsQueryDto,
  ReturnActivityPublishReviewDto,
} from '../activity-publish-review.dto';
import { ActivityPublishReviewQueryService } from '../activity-publish-review-query.service';
import { ActivityPublishReviewService } from '../activity-publish-review.service';

@ApiTags('Admin - Activity Publish Reviews')
@ApiBearerAuth()
@Controller('admin/v1/activity-publish-reviews')
export class AdminActivityPublishReviewsController {
  constructor(
    private readonly queryService: ActivityPublishReviewQueryService,
    private readonly reviewService: ActivityPublishReviewService,
  ) {}

  private auditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get()
  @ApiOperation({
    summary:
      '发布审核工作台(按显式 reviewer RoleBinding 的组织范围过滤) [rbac: activity-review.read.request]',
  })
  @ApiWrappedPageResponse(ActivityPublishReviewResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @Query() query: ListActivityPublishReviewsQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityPublishReviewResponseDto>> {
    return this.queryService.list(query, user);
  }

  @Get(':id')
  @ApiOperation({
    summary: '发布审核详情 [rbac: activity-review.read.request]',
  })
  @ApiWrappedOkResponse(ActivityPublishReviewResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND,
  )
  findOne(
    @Param() params: IdParamDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ActivityPublishReviewResponseDto> {
    return this.queryService.findOne(params.id, user);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '通过待处理发布审核并发布活动 [rbac: activity.publish.record]',
  })
  @ApiWrappedOkResponse(ActivityPublishReviewResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND,
    BizCode.ACTIVITY_PUBLISH_REVIEW_STATUS_INVALID,
    BizCode.ACTIVITY_PUBLISH_REVIEW_SNAPSHOT_INVALID,
  )
  approve(
    @Param() params: IdParamDto,
    @Body() dto: ApproveActivityPublishReviewDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityPublishReviewResponseDto> {
    return this.reviewService.approve(params.id, dto, user, this.auditMeta(req));
  }

  @Post(':id/return')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '退回待处理发布审核 [rbac: activity-review.return.request]',
  })
  @ApiWrappedOkResponse(ActivityPublishReviewResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND,
    BizCode.ACTIVITY_PUBLISH_REVIEW_NOTE_REQUIRED,
    BizCode.ACTIVITY_PUBLISH_REVIEW_STATUS_INVALID,
  )
  returnReview(
    @Param() params: IdParamDto,
    @Body() dto: ReturnActivityPublishReviewDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityPublishReviewResponseDto> {
    return this.reviewService.returnReview(params.id, dto, user, this.auditMeta(req));
  }
}
