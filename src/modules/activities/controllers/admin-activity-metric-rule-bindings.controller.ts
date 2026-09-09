import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import { PageResultDto, PaginationQueryDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { ActivityMetricRuleBindingService } from '../activity-metric-rule-binding.service';
import {
  AdminActivityMetricRuleBindingResultDto,
  AdminCreateActivityMetricRuleBindingDto,
} from '../dto/admin/activity-metric-rule-binding.dto';

@ApiTags('Admin - Activity Metric Rule Bindings')
@ApiBearerAuth()
@ApiExtraModels(PageResultDto, AdminActivityMetricRuleBindingResultDto)
@Controller('admin/v1/activity-metric-rule-bindings')
export class AdminActivityMetricRuleBindingsController {
  constructor(private readonly service: ActivityMetricRuleBindingService) {}

  @Post()
  @RequiresPermission('activity-metric.manage.rule-binding', {
    require: 'all',
    engine: 'rbac-global',
  })
  @ApiOperation({ summary: '创建不可变的指标规则绑定 [rbac: activity-metric.manage.rule-binding]' })
  @ApiWrappedCreatedResponse(AdminActivityMetricRuleBindingResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_METRIC_CANDIDATE_INVALID,
    BizCode.ACTIVITY_METRIC_CANDIDATE_COMMAND_CONFLICT,
    BizCode.ACTIVITY_METRIC_CANDIDATE_REFERENCE_UNAVAILABLE,
    BizCode.ACTIVITY_METRIC_CANDIDATE_RECEIPT_INVALID,
  )
  create(
    @Body() dto: AdminCreateActivityMetricRuleBindingDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ) {
    return this.service.create(dto, user, {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
  }

  @Get()
  @RequiresPermission('activity-metric.read.catalog', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({ summary: '分页读取安全规则绑定 [rbac: activity-metric.read.catalog]' })
  @ApiWrappedPageResponse(AdminActivityMetricRuleBindingResultDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(@Query() query: PaginationQueryDto, @CurrentUser() user: CurrentUserPayload) {
    return this.service.list(user, query.page, query.pageSize);
  }
}
