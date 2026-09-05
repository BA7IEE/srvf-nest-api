import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityMetricCatalogueQueryService } from '../activity-metric-catalogue-query.service';
import { ActivityMetricDefinitionService } from '../activity-metric-definition.service';
import {
  AdminActivityMetricCommandResponseDto,
  AdminActivityMetricVersionCommandDto,
} from '../dto/admin/activity-metric-command.dto';
import {
  AdminActivityMetricDefinitionResponseDto,
  AdminCreateActivityMetricDefinitionDto,
  AdminUpdateActivityMetricDefinitionDto,
  AdminListActivityMetricDefinitionsQueryDto,
} from '../dto/admin/activity-metric-definition.dto';

@ApiTags('Admin - Activity Metric Definitions')
@ApiBearerAuth()
@Controller('admin/v1/activity-metric-definitions')
export class AdminActivityMetricDefinitionsController {
  constructor(
    private readonly service: ActivityMetricDefinitionService,
    private readonly queryService: ActivityMetricCatalogueQueryService,
  ) {}
  @Get()
  @RequiresPermission('activity-metric.read.catalog', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '分页查询指标定义 [rbac: activity-metric.read.catalog]' })
  @ApiWrappedPageResponse(AdminActivityMetricDefinitionResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @Query() query: AdminListActivityMetricDefinitionsQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queryService.listDefinitions(query, user);
  }

  @Get(':id')
  @RequiresPermission('activity-metric.read.catalog', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '查看指标定义版本 [rbac: activity-metric.read.catalog]' })
  @ApiWrappedOkResponse(AdminActivityMetricDefinitionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_METRIC_DEFINITION_NOT_FOUND,
  )
  get(@Param() params: IdParamDto, @CurrentUser() user: CurrentUserPayload) {
    return this.queryService.getDefinition(params.id, user);
  }

  @Post()
  @RequiresPermission('activity-metric.manage.definition', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: 'create 指标定义版本 [rbac: activity-metric.manage.definition]' })
  @ApiWrappedCreatedResponse(AdminActivityMetricCommandResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_METRIC_DEFINITION_INVALID,
    BizCode.ACTIVITY_METRIC_DEFINITION_NOT_FOUND,
    BizCode.ACTIVITY_METRIC_VERSION_ALREADY_EXISTS,
    BizCode.ACTIVITY_METRIC_COMMAND_CONFLICT,
    BizCode.ACTIVITY_METRIC_VERSION_STALE,
    BizCode.ACTIVITY_METRIC_STATUS_INVALID,
    BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_RECEIPT_INVALID,
  )
  create(
    @Body() dto: AdminCreateActivityMetricDefinitionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.execute('create', null, dto, user, {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Put(':id/draft')
  @HttpCode(200)
  @RequiresPermission('activity-metric.manage.definition', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: 'update 指标定义版本 [rbac: activity-metric.manage.definition]' })
  @ApiWrappedOkResponse(AdminActivityMetricCommandResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_METRIC_DEFINITION_INVALID,
    BizCode.ACTIVITY_METRIC_DEFINITION_NOT_FOUND,
    BizCode.ACTIVITY_METRIC_VERSION_ALREADY_EXISTS,
    BizCode.ACTIVITY_METRIC_COMMAND_CONFLICT,
    BizCode.ACTIVITY_METRIC_VERSION_STALE,
    BizCode.ACTIVITY_METRIC_STATUS_INVALID,
    BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_RECEIPT_INVALID,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: AdminUpdateActivityMetricDefinitionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.execute('update', params.id, dto, user, {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequiresPermission('activity-metric.manage.definition', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: 'activate 指标定义版本 [rbac: activity-metric.manage.definition]' })
  @ApiWrappedOkResponse(AdminActivityMetricCommandResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_METRIC_DEFINITION_INVALID,
    BizCode.ACTIVITY_METRIC_DEFINITION_NOT_FOUND,
    BizCode.ACTIVITY_METRIC_VERSION_ALREADY_EXISTS,
    BizCode.ACTIVITY_METRIC_COMMAND_CONFLICT,
    BizCode.ACTIVITY_METRIC_VERSION_STALE,
    BizCode.ACTIVITY_METRIC_STATUS_INVALID,
    BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_RECEIPT_INVALID,
  )
  activate(
    @Param() params: IdParamDto,
    @Body() dto: AdminActivityMetricVersionCommandDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.execute('activate', params.id, dto, user, {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Post(':id/retire')
  @HttpCode(200)
  @RequiresPermission('activity-metric.manage.definition', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: 'retire 指标定义版本 [rbac: activity-metric.manage.definition]' })
  @ApiWrappedOkResponse(AdminActivityMetricCommandResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_METRIC_DEFINITION_INVALID,
    BizCode.ACTIVITY_METRIC_DEFINITION_NOT_FOUND,
    BizCode.ACTIVITY_METRIC_VERSION_ALREADY_EXISTS,
    BizCode.ACTIVITY_METRIC_COMMAND_CONFLICT,
    BizCode.ACTIVITY_METRIC_VERSION_STALE,
    BizCode.ACTIVITY_METRIC_STATUS_INVALID,
    BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_RECEIPT_INVALID,
  )
  retire(
    @Param() params: IdParamDto,
    @Body() dto: AdminActivityMetricVersionCommandDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.execute('retire', params.id, dto, user, {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }
}
