import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { LoginScoped } from '../../../common/decorators/route-authz.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { AppMyActivityBatchJobsService } from '../app-my-activity-batch-jobs.service';
import {
  AppMyActivityBatchJobDetailDto,
  AppMyActivityBatchJobItemDto,
  AppMyActivityBatchJobListItemDto,
  AppMyActivityBatchJobParamsDto,
  ListAppMyActivityBatchJobItemsQueryDto,
  ListAppMyActivityBatchJobsQueryDto,
} from '../dto/app/app-my-activity-batch-job.dto';

/**
 * 合同 §6.13「后台任务」统一读面(路径逐字照合同)。
 *
 * 与 `/managed-activities/:activityId/onsite/bulk-punch-jobs/:jobId` 的区别:
 * 那条只看 `bulk_proxy` 一种类型、只回执进度;本控制器是**跨活动跨类型**的统一读面,
 * 按 §9.9 出 job type / activity / 创建人 / 计数 / lease 与重试人话状态 / 失败项分页。
 *
 * 判权全部落在 Service(§7.1「Controller 只挂 JwtAuthGuard;业务权限在 Service 调用 Authz」),
 * 本文件只做 App 准入(canUseApp + 有队员身份)与 memberId 解析。
 */
@ApiTags('Mobile - My Activity Batch Jobs')
@ApiBearerAuth()
@Controller('app/v1/my/activity-batch-jobs')
export class AppMyActivityBatchJobsController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly batchJobs: AppMyActivityBatchJobsService,
  ) {}

  @Get()
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: 'App 分页查看当前责任范围内的后台批任务 [auth]' })
  @ApiWrappedPageResponse(AppMyActivityBatchJobListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: ListAppMyActivityBatchJobsQueryDto,
  ) {
    return this.batchJobs.list(await this.resolveMemberId(user), query);
  }

  @Get(':jobId')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: 'App 查看单个后台批任务详情 [auth]' })
  @ApiWrappedOkResponse(AppMyActivityBatchJobDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.NOT_FOUND,
  )
  async detail(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppMyActivityBatchJobParamsDto,
  ): Promise<AppMyActivityBatchJobDetailDto> {
    return this.batchJobs.detail(await this.resolveMemberId(user), params.jobId);
  }

  @Get(':jobId/items')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: 'App 分页查看后台批任务逐项(失败项即 status=failed) [auth]' })
  @ApiWrappedPageResponse(AppMyActivityBatchJobItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.NOT_FOUND,
  )
  async listItems(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppMyActivityBatchJobParamsDto,
    @Query() query: ListAppMyActivityBatchJobItemsQueryDto,
  ) {
    return this.batchJobs.listItems(await this.resolveMemberId(user), params.jobId, query);
  }

  @Post(':jobId/retry-failed')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: 'App 重试后台批任务的失败项(重新判权) [auth]' })
  @ApiWrappedCreatedResponse(AppMyActivityBatchJobDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
  )
  async retryFailed(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppMyActivityBatchJobParamsDto,
  ): Promise<AppMyActivityBatchJobDetailDto> {
    return this.batchJobs.retryFailed(await this.resolveMemberId(user), params.jobId);
  }

  @Post(':jobId/cancel')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: 'App 取消后台批任务(重新判权;已完成不可取消) [auth]' })
  @ApiWrappedCreatedResponse(AppMyActivityBatchJobDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
  )
  async cancel(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppMyActivityBatchJobParamsDto,
  ): Promise<AppMyActivityBatchJobDetailDto> {
    return this.batchJobs.cancel(await this.resolveMemberId(user), params.jobId);
  }

  private async resolveMemberId(user: CurrentUserPayload): Promise<string> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);
    return access.member.id;
  }
}
