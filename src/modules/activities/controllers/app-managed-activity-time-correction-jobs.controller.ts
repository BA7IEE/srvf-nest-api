import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import { ActivityTimeCorrectionBackgroundService } from '../activity-time-correction-background.service';
import {
  AppActivityTimeCorrectionParamsDto,
  AppCommitActivityTimeCorrectionDto,
} from '../dto/app/app-activity-time-correction.dto';
import {
  AppActivityTimeCorrectionJobDto,
  AppActivityTimeCorrectionJobParamsDto,
} from '../dto/app/app-activity-time-correction-job.dto';
import { HumanCorrectionAuthorityUnavailableError } from '../human-correction-intent';

async function translateAuthority<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HumanCorrectionAuthorityUnavailableError) {
      throw new BizException(BizCode.SERVICE_UNAVAILABLE);
    }
    throw error;
  }
}

const ERRORS = [
  BizCode.ACTIVITY_V11_WORKFLOW_NOT_ENABLED,
  BizCode.ACTIVITY_WORKFLOW_READONLY_MAINTENANCE,
  BizCode.BAD_REQUEST,
  BizCode.UNAUTHORIZED,
  BizCode.FORBIDDEN,
  BizCode.NOT_FOUND,
  BizCode.SERVICE_UNAVAILABLE,
  BizCode.RBAC_FORBIDDEN,
  BizCode.CORRECTION_OPERATION_KEY_CONFLICT,
  BizCode.CORRECTION_APPLY_STATUS_INVALID,
  BizCode.CORRECTION_CHANGE_SET_INVALID,
  BizCode.ACTIVITY_TIME_SETTLEMENT_REFERENCE_UNAVAILABLE,
] as const;

@ApiTags('Mobile - Managed Activity Fact Corrections')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities/:activityId/time-corrections/:requestId/commit-jobs')
export class AppManagedActivityTimeCorrectionJobsController {
  constructor(private readonly jobs: ActivityTimeCorrectionBackgroundService) {}

  @Post()
  @RequiresPermission('activity.settlement-final-review.record', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['org-scope'],
  })
  @ApiOperation({
    summary:
      '后台受理精确 prepared 更正；受理不代表已生效 [rbac: activity.settlement-final-review.record]',
  })
  @ApiWrappedCreatedResponse(AppActivityTimeCorrectionJobDto)
  @ApiBizErrorResponse(...ERRORS)
  enqueue(
    @Param() params: AppActivityTimeCorrectionParamsDto,
    @Body() dto: AppCommitActivityTimeCorrectionDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return translateAuthority(() =>
      this.jobs.enqueue(params.activityId, params.requestId, dto, user),
    );
  }

  @Get(':jobId')
  @RequiresPermission('activity.settlement-final-review.record', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['org-scope'],
  })
  @ApiOperation({
    summary:
      '原准备人查询后台更正进度和权威生效结果 [rbac: activity.settlement-final-review.record]',
  })
  @ApiWrappedOkResponse(AppActivityTimeCorrectionJobDto)
  @ApiBizErrorResponse(...ERRORS)
  detail(
    @Param() params: AppActivityTimeCorrectionJobParamsDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return translateAuthority(() =>
      this.jobs.detail(params.activityId, params.requestId, params.jobId, user),
    );
  }

  @Post(':jobId/retry')
  @HttpCode(200)
  @RequiresPermission('activity.settlement-final-review.record', {
    admission: 'app-member',
    require: 'all',
    engine: 'authz-scoped',
    scopes: ['org-scope'],
  })
  @ApiOperation({
    summary:
      '重新判权后重试已确认未生效的原任务；未知结果拒绝 [rbac: activity.settlement-final-review.record]',
  })
  @ApiWrappedOkResponse(AppActivityTimeCorrectionJobDto)
  @ApiBizErrorResponse(...ERRORS)
  retry(
    @Param() params: AppActivityTimeCorrectionJobParamsDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return translateAuthority(() =>
      this.jobs.retry(params.activityId, params.requestId, params.jobId, user),
    );
  }
}
