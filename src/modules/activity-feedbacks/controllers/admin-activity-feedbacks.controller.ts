import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { PageResultDto, PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import {
  ActivityFeedbackActivityIdParamDto,
  AdminActivityFeedbackListItemDto,
  AdminActivityFeedbackSummaryDto,
} from '../activity-feedback.dto';
import { ActivityFeedbacksQueryService } from '../activity-feedbacks-query.service';

@ApiTags('Admin - Activities')
@ApiBearerAuth()
@ApiExtraModels(AdminActivityFeedbackListItemDto, PageResultDto)
@Controller('admin/v1/activities/:activityId')
export class AdminActivityFeedbacksController {
  constructor(private readonly feedbacks: ActivityFeedbacksQueryService) {}

  @Get('feedbacks')
  @ApiOperation({
    summary: '分页查看活动评价与评价人摘要 [rbac: attendance.read.sheet]',
  })
  @ApiWrappedPageResponse(AdminActivityFeedbackListItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  list(
    @Param() { activityId }: ActivityFeedbackActivityIdParamDto,
    @Query() query: PaginationQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminActivityFeedbackListItemDto>> {
    return this.feedbacks.list(activityId, query, currentUser);
  }

  @Get('feedback-summary')
  @ApiOperation({
    summary: '查看活动评价均分、直方图与评价率 [rbac: attendance.read.sheet]',
  })
  @ApiWrappedOkResponse(AdminActivityFeedbackSummaryDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  summary(
    @Param() { activityId }: ActivityFeedbackActivityIdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AdminActivityFeedbackSummaryDto> {
    return this.feedbacks.summary(activityId, currentUser);
  }
}
