import { Body, Controller, Get, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityFeedbacksService } from '../activity-feedbacks.service';
import {
  AppActivityFeedbackActivityIdParamDto,
  AppActivityFeedbackResponseDto,
  UpsertActivityFeedbackDto,
} from '../dto/app/activity-feedback.dto';

// 全新 canonical App self surface：只走全局 JwtAuthGuard + AppIdentityResolver；无 RBAC / @Roles / alias。
@ApiTags('Mobile - My Activity Feedback')
@ApiBearerAuth()
@Controller('app/v1/my/activities/:activityId/feedback')
export class AppActivityFeedbacksController {
  constructor(private readonly feedbacks: ActivityFeedbacksService) {}

  @Put()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '窗口内创建或更新本人活动评价 [auth]' })
  @ApiWrappedOkResponse(AppActivityFeedbackResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_FEEDBACK_ALREADY_EXISTS,
    BizCode.ACTIVITY_FEEDBACK_ACTIVITY_NOT_COMPLETED,
    BizCode.ACTIVITY_FEEDBACK_WINDOW_CLOSED,
    BizCode.ACTIVITY_FEEDBACK_ATTENDANCE_REQUIRED,
  )
  upsertMine(
    @Param() { activityId }: AppActivityFeedbackActivityIdParamDto,
    @Body() dto: UpsertActivityFeedbackDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AppActivityFeedbackResponseDto> {
    return this.feedbacks.upsertMine(activityId, dto, currentUser);
  }

  @Get()
  @ApiOperation({ summary: '读取本人活动评价与当前提交按钮态 [auth]' })
  @ApiWrappedOkResponse(AppActivityFeedbackResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  getMine(
    @Param() { activityId }: AppActivityFeedbackActivityIdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AppActivityFeedbackResponseDto> {
    return this.feedbacks.getMine(activityId, currentUser);
  }
}
