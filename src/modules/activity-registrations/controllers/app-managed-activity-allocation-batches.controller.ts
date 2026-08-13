import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { LoginScoped } from '../../../common/decorators/route-authz.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { ActivityAllocationService } from '../activity-allocation.service';
import {
  AppActivityAllocationBatchDto,
  AppActivityAllocationCommandReceiptDto,
  AppManagedActivityAllocationBatchParamsDto,
  AppManagedActivityAllocationParamsDto,
  CommitAppManagedActivityAllocationBatchDto,
  PrepareAppManagedActivityAllocationBatchDto,
  VoidAppManagedActivityAllocationBatchDto,
} from '../dto/app/app-activity-allocation-batch.dto';

@ApiTags('Mobile - Managed Activity Allocation Batches')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities/:activityId/allocation-batches')
export class AppManagedActivityAllocationBatchesController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly allocations: ActivityAllocationService,
  ) {}

  @Post()
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '负责人冻结资格排序或抽签候选批次 [auth]' })
  @ApiWrappedOkResponse(AppActivityAllocationCommandReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED,
    BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT,
    BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED,
    BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID,
  )
  async prepare(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityAllocationParamsDto,
    @Body() dto: PrepareAppManagedActivityAllocationBatchDto,
    @Req() req: Request,
  ): Promise<AppActivityAllocationCommandReceiptDto> {
    await this.assertAppAccess(user);
    return this.allocations.prepare(params.activityId, dto, user, this.auditMeta(req));
  }

  @Post(':batchId/commit')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '负责人提交已冻结的资格排序或抽签批次 [auth]' })
  @ApiWrappedOkResponse(AppActivityAllocationCommandReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT,
    BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED,
    BizCode.ACTIVITY_QUALIFICATION_CONFIGURATION_INVALID,
  )
  async commit(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityAllocationBatchParamsDto,
    @Body() dto: CommitAppManagedActivityAllocationBatchDto,
    @Req() req: Request,
  ): Promise<AppActivityAllocationCommandReceiptDto> {
    await this.assertAppAccess(user);
    return this.allocations.commit(params.activityId, params.batchId, dto, user, this.auditMeta(req));
  }

  @Post(':batchId/void')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '负责人作废已冻结或未漂移的已提交批次 [auth]' })
  @ApiWrappedOkResponse(AppActivityAllocationCommandReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT,
    BizCode.ACTIVITY_CAPACITY_RECONCILIATION_FAILED,
  )
  async void(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityAllocationBatchParamsDto,
    @Body() dto: VoidAppManagedActivityAllocationBatchDto,
    @Req() req: Request,
  ): Promise<AppActivityAllocationCommandReceiptDto> {
    await this.assertAppAccess(user);
    return this.allocations.void(params.activityId, params.batchId, dto, user, this.auditMeta(req));
  }

  @Get(':batchId')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '负责人读取安全的分配批次与结果 [auth]' })
  @ApiWrappedOkResponse(AppActivityAllocationBatchDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async get(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityAllocationBatchParamsDto,
  ): Promise<AppActivityAllocationBatchDto> {
    await this.assertAppAccess(user);
    return this.allocations.get(params.activityId, params.batchId, user);
  }

  private async assertAppAccess(user: CurrentUserPayload): Promise<void> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);
  }

  private auditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
