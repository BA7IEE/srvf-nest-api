import { Controller, Get, Param } from '@nestjs/common';
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
import {
  ActivityParticipationIdParamDto,
  ActivityParticipationSummaryDto,
  ActivityReconciliationDto,
} from '../activity-participation.dto';
import { ActivityParticipationQueryService } from '../activity-participation-query.service';

// 审计刀 5 F1/F2：活动级跨子表只读投影。独立 Controller + QueryService，保持
// ActivitiesService 零增长；两端点都在 service 逐一校验 attendance.read.sheet 与
// activity-registration.read.record，并带 activity ref。
@ApiTags('Admin - Activities')
@ApiBearerAuth()
@Controller('admin/v1/activities/:activityId')
export class AdminActivityParticipationController {
  constructor(private readonly query: ActivityParticipationQueryService) {}

  @Get('reconciliation')
  @ApiOperation({
    summary:
      '活动报名×实到核对(completed only；pass 逐人 attended/no-show + 临时参加名单；需同时持两项参与域读权限) [auth]',
  })
  @ApiWrappedOkResponse(ActivityReconciliationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
  )
  reconciliation(
    @Param() params: ActivityParticipationIdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<ActivityReconciliationDto> {
    return this.query.reconciliation(params.activityId, currentUser);
  }

  @Get('participation-summary')
  @ApiOperation({
    summary:
      '活动参与合计(报名状态/实到/到场率/approved 时长与贡献/固定时长桶；需同时持两项参与域读权限) [auth]',
  })
  @ApiWrappedOkResponse(ActivityParticipationSummaryDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  participationSummary(
    @Param() params: ActivityParticipationIdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<ActivityParticipationSummaryDto> {
    return this.query.participationSummary(params.activityId, currentUser);
  }
}
