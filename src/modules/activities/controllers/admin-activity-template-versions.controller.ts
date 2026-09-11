import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import { IdParamDto } from '../../../common/dto/id-param.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityTemplateVersionService } from '../activity-template-version.service';
import { ActivityTemplateVersionQueryService } from '../activity-template-version-query.service';
import {
  AdminCreateActivityTemplateVersionDto,
  AdminUpdateActivityTemplateVersionDto,
  AdminActivityTemplateVersionCommandDto,
  AdminListActivityTemplateVersionsQueryDto,
  AdminActivityTemplateVersionCommandResultDto,
  AdminActivityTemplateVersionSummaryDto,
  AdminActivityTemplateVersionResponseDto,
} from '../dto/admin/activity-template-version.dto';

@ApiTags('Admin - Activity Template Versions')
@ApiBearerAuth()
@Controller('admin/v1/activity-template-versions')
export class AdminActivityTemplateVersionsController {
  constructor(
    private readonly service: ActivityTemplateVersionService,
    private readonly queries: ActivityTemplateVersionQueryService,
  ) {}
  @Get()
  @RequiresPermission('activity-template.read.catalog', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '分页读取全局模板版本目录 [rbac: activity-template.read.catalog]' })
  @ApiWrappedPageResponse(AdminActivityTemplateVersionSummaryDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @Query() query: AdminListActivityTemplateVersionsQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.queries.list(query, user);
  }
  @Get(':id')
  @RequiresPermission('activity-template.read.catalog', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '读取精确模板版本定义 [rbac: activity-template.read.catalog]' })
  @ApiWrappedOkResponse(AdminActivityTemplateVersionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND,
    BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID,
  )
  get(@Param() params: IdParamDto, @CurrentUser() user: CurrentUserPayload) {
    return this.queries.get(params.id, user);
  }
  @Post()
  @RequiresPermission('activity-template.manage.version', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary: '新建全局模板 V3/V4 或从精确版本复制 [rbac: activity-template.manage.version]',
  })
  @ApiWrappedCreatedResponse(AdminActivityTemplateVersionCommandResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID,
    BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND,
    BizCode.ACTIVITY_TEMPLATE_VERSION_ALREADY_EXISTS,
    BizCode.ACTIVITY_TEMPLATE_VERSION_STALE,
    BizCode.ACTIVITY_TEMPLATE_COMMAND_CONFLICT,
    BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_RECEIPT_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE,
    BizCode.ACTIVITY_TYPE_CODE_INVALID,
  )
  create(
    @Body() dto: AdminCreateActivityTemplateVersionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.create(dto, user, this.meta(req));
  }
  @Put(':id/draft')
  @RequiresPermission('activity-template.manage.version', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '整份更新 draft V3/V4 定义 [rbac: activity-template.manage.version]' })
  @ApiWrappedOkResponse(AdminActivityTemplateVersionCommandResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID,
    BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND,
    BizCode.ACTIVITY_TEMPLATE_VERSION_STALE,
    BizCode.ACTIVITY_TEMPLATE_COMMAND_CONFLICT,
    BizCode.ACTIVITY_METRIC_STATUS_INVALID,
    BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_RECEIPT_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE,
    BizCode.ACTIVITY_TYPE_CODE_INVALID,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: AdminUpdateActivityTemplateVersionDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.change('update', params.id, dto, user, this.meta(req));
  }
  @Post(':id/activate')
  @HttpCode(200)
  @RequiresPermission('activity-template.manage.version', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '复验并激活 draft V3/V4 [rbac: activity-template.manage.version]' })
  @ApiWrappedOkResponse(AdminActivityTemplateVersionCommandResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_TEMPLATE_DEFINITION_INVALID,
    BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND,
    BizCode.ACTIVITY_TEMPLATE_VERSION_STALE,
    BizCode.ACTIVITY_TEMPLATE_COMMAND_CONFLICT,
    BizCode.ACTIVITY_METRIC_STATUS_INVALID,
    BizCode.ACTIVITY_METRIC_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_RECEIPT_INVALID,
    BizCode.ACTIVITY_TIME_POLICY_SELECTION_POLICY_UNAVAILABLE,
    BizCode.ACTIVITY_TYPE_CODE_INVALID,
  )
  activate(
    @Param() params: IdParamDto,
    @Body() dto: AdminActivityTemplateVersionCommandDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.change('activate', params.id, dto, user, this.meta(req));
  }
  @Post(':id/retire')
  @HttpCode(200)
  @RequiresPermission('activity-template.manage.version', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary: '退役 active V3/V4，保留历史引用 [rbac: activity-template.manage.version]',
  })
  @ApiWrappedOkResponse(AdminActivityTemplateVersionCommandResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_TEMPLATE_VERSION_NOT_FOUND,
    BizCode.ACTIVITY_TEMPLATE_VERSION_STALE,
    BizCode.ACTIVITY_TEMPLATE_COMMAND_CONFLICT,
    BizCode.ACTIVITY_METRIC_STATUS_INVALID,
    BizCode.ACTIVITY_METRIC_RECEIPT_INVALID,
  )
  retire(
    @Param() params: IdParamDto,
    @Body() dto: AdminActivityTemplateVersionCommandDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.change('retire', params.id, dto, user, this.meta(req));
  }
  private meta(req: Request) {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
