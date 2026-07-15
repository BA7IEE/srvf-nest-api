import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
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
import { AppActivityCheckInsService } from '../app-activity-check-ins.service';
import { AppActivityCheckInDto } from '../dto/app/app-activity-check-in.dto';
import {
  ActivityCheckInLocationDto,
  AppActivityCheckInActivityIdParamDto,
} from '../dto/app/activity-check-in-location.dto';

// 活动 GPS 自助签到是全新 canonical App self surface：无 @Roles / @Public / legacy alias。
// AppIdentityResolver 与 service 内 memberId 锁定共同保证 linked-member self perspective。
@ApiTags('Mobile - My Activity Check-ins')
@ApiBearerAuth()
@Controller('app/v1/my/activities/:activityId')
export class AppActivityCheckInsController {
  constructor(private readonly checkIns: AppActivityCheckInsService) {}

  @Post('check-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '本人 GPS 签到（首次与合法重试均返回当前证据） [auth]' })
  @ApiWrappedOkResponse(AppActivityCheckInDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN,
    BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN,
    BizCode.ATTENDANCE_REGISTRATION_INVALID,
    BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW,
  )
  checkIn(
    @Param() { activityId }: AppActivityCheckInActivityIdParamDto,
    @Body() dto: ActivityCheckInLocationDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AppActivityCheckInDto> {
    return this.checkIns.checkIn(activityId, dto, currentUser);
  }

  @Post('check-out')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '本人 GPS 签退（首次与合法重试均返回当前证据） [auth]' })
  @ApiWrappedOkResponse(AppActivityCheckInDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN,
    BizCode.ACTIVITY_NOT_PUBLISHED_PARTICIPATION_FORBIDDEN,
    BizCode.ATTENDANCE_REGISTRATION_INVALID,
    BizCode.ATTENDANCE_OUTSIDE_ACTIVITY_WINDOW,
    BizCode.ATTENDANCE_SERVICE_HOURS_INVALID,
    BizCode.ACTIVITY_CHECK_OUT_REQUIRES_CHECK_IN,
  )
  checkOut(
    @Param() { activityId }: AppActivityCheckInActivityIdParamDto,
    @Body() dto: ActivityCheckInLocationDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AppActivityCheckInDto> {
    return this.checkIns.checkOut(activityId, dto, currentUser);
  }

  @Get('check-in')
  @ApiOperation({ summary: '读取本人当前审核通过报名的打卡状态 [auth]' })
  @ApiWrappedOkResponse(AppActivityCheckInDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_CHECK_IN_NOT_FOUND,
  )
  getCurrent(
    @Param() { activityId }: AppActivityCheckInActivityIdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AppActivityCheckInDto> {
    return this.checkIns.getCurrent(activityId, currentUser);
  }
}
