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
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
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
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import { IdParamDto } from '../../../common/dto/id-param.dto';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityTimePolicyService } from '../activity-time-policy.service';
import { ActivityTimePolicyCatalogueQueryService } from '../activity-time-policy-catalogue-query.service';
import {
  AdminListTimePoliciesQueryDto,
  AdminListTimePolicyVersionsQueryDto,
  AdminTimePolicyResponseDto,
  AdminTimePolicyVersionSummaryDto,
  AdminTimePolicyVersionResponseDto,
  TimePolicyVersionParamDto,
} from '../dto/admin/activity-time-policy.dto';
import {
  AdminCreateTimePolicyDto,
  AdminCreateTimePolicyVersionDto,
  AdminActivateTimePolicyVersionDto,
  AdminRetireTimePolicyVersionDto,
  AdminTimePolicyCommandResponseDto,
} from '../dto/admin/activity-time-policy-command.dto';

@ApiTags('Admin - Activity Time Policies')
@ApiBearerAuth()
@ApiExtraModels(PageResultDto, AdminTimePolicyResponseDto, AdminTimePolicyVersionSummaryDto)
@Controller('admin/v1/activity-time-policies')
export class AdminActivityTimePoliciesController {
  constructor(
    private readonly service: ActivityTimePolicyService,
    private readonly queries: ActivityTimePolicyCatalogueQueryService,
  ) {}

  @Get('')
  @RequiresPermission('activity-time-policy.read.catalog', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '分页查询时长政策 [rbac: activity-time-policy.read.catalog]' })
  @ApiWrappedPageResponse(AdminTimePolicyResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID,
  )
  list(@Query() query: AdminListTimePoliciesQueryDto, @CurrentUser() user: CurrentUserPayload) {
    return this.queries.list(query, user);
  }

  @Get(':id')
  @RequiresPermission('activity-time-policy.read.catalog', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '查看时长政策 [rbac: activity-time-policy.read.catalog]' })
  @ApiWrappedOkResponse(AdminTimePolicyResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID,
  )
  get(@Param() params: IdParamDto, @CurrentUser() user: CurrentUserPayload) {
    return this.queries.get(params.id, user);
  }

  @Get(':id/versions')
  @RequiresPermission('activity-time-policy.read.catalog', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '分页查询时长政策版本 [rbac: activity-time-policy.read.catalog]' })
  @ApiWrappedPageResponse(AdminTimePolicyVersionSummaryDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID,
  )
  listVersions(
    @Param() params: IdParamDto,
    @Query() query: AdminListTimePolicyVersionsQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.listVersions(params.id, query, user);
  }

  @Get(':id/versions/:versionId')
  @RequiresPermission('activity-time-policy.read.catalog', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '查看时长政策版本 [rbac: activity-time-policy.read.catalog]' })
  @ApiWrappedOkResponse(AdminTimePolicyVersionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID,
  )
  getVersion(@Param() params: TimePolicyVersionParamDto, @CurrentUser() user: CurrentUserPayload) {
    return this.queries.getVersion(params.id, params.versionId, user);
  }

  @Post('')
  @RequiresPermission('activity-time-policy.manage.version', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: 'createPolicy 时长政策 [rbac: activity-time-policy.manage.version]' })
  @ApiWrappedCreatedResponse(AdminTimePolicyCommandResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_TIME_POLICY_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_TIME_POLICY_CODE_EXISTS,
    BizCode.ACTIVITY_TIME_POLICY_STALE,
    BizCode.ACTIVITY_TIME_POLICY_STATUS_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_COMMAND_CONFLICT,
    BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_VERSION_LIMIT,
  )
  createPolicy(
    @Body() input: AdminCreateTimePolicyDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.createPolicy(input, user, {
      requestId: typeof req.id === 'string' ? req.id : '',
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Post(':id/versions')
  @RequiresPermission('activity-time-policy.manage.version', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: 'createVersion 时长政策 [rbac: activity-time-policy.manage.version]' })
  @ApiWrappedCreatedResponse(AdminTimePolicyCommandResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_TIME_POLICY_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_TIME_POLICY_CODE_EXISTS,
    BizCode.ACTIVITY_TIME_POLICY_STALE,
    BizCode.ACTIVITY_TIME_POLICY_STATUS_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_COMMAND_CONFLICT,
    BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_VERSION_LIMIT,
  )
  createVersion(
    @Param() params: IdParamDto,
    @Body() input: AdminCreateTimePolicyVersionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.createVersion(params.id, input, user, {
      requestId: typeof req.id === 'string' ? req.id : '',
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Post(':id/versions/:versionId/activate')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission('activity-time-policy.manage.version', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: 'activate 时长政策 [rbac: activity-time-policy.manage.version]' })
  @ApiWrappedOkResponse(AdminTimePolicyCommandResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_TIME_POLICY_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_TIME_POLICY_CODE_EXISTS,
    BizCode.ACTIVITY_TIME_POLICY_STALE,
    BizCode.ACTIVITY_TIME_POLICY_STATUS_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_COMMAND_CONFLICT,
    BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_VERSION_LIMIT,
  )
  activate(
    @Param() params: TimePolicyVersionParamDto,
    @Body() input: AdminActivateTimePolicyVersionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.transition('activate', params.id, params.versionId, input, user, {
      requestId: typeof req.id === 'string' ? req.id : '',
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Post(':id/versions/:versionId/retire')
  @HttpCode(HttpStatus.OK)
  @RequiresPermission('activity-time-policy.manage.version', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: 'retire 时长政策 [rbac: activity-time-policy.manage.version]' })
  @ApiWrappedOkResponse(AdminTimePolicyCommandResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PRINCIPAL_KIND_FORBIDDEN,
    BizCode.ACTIVITY_TIME_POLICY_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_NOT_FOUND,
    BizCode.ACTIVITY_TIME_POLICY_CODE_EXISTS,
    BizCode.ACTIVITY_TIME_POLICY_STALE,
    BizCode.ACTIVITY_TIME_POLICY_STATUS_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_COMMAND_CONFLICT,
    BizCode.ACTIVITY_TIME_POLICY_RECEIPT_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_VERSION_LIMIT,
  )
  retire(
    @Param() params: TimePolicyVersionParamDto,
    @Body() input: AdminRetireTimePolicyVersionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.transition('retire', params.id, params.versionId, input, user, {
      requestId: typeof req.id === 'string' ? req.id : '',
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }
}
