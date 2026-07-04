import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ActivityListItemDto,
  ActivityOptionsQueryDto,
  ActivityOptionsResponseDto,
  ActivityResponseDto,
  CancelActivityDto,
  CreateActivityDto,
  ListActivitiesQueryDto,
  UpdateActivityDto,
} from './activities.dto';
import { ActivitiesService } from './activities.service';

// V2 第一阶段批次 3A activities controller(7 路由)。
// 路径前缀:全局 /api(main.ts)+ 'admin/v1/activities'。
//
// 权限(Slow-4 T3,2026-06-11,评审稿 §3.5;取代批次 3A @Roles 策略):
// - GET list / GET detail:无码化,仅登录(`[auth]`;原 @Roles 含 USER = 全角色放行,
//   等价仅登录;service 内 Q-A7 USER 过滤逻辑原样保留)
// - POST / PATCH / DELETE / publish / cancel:判权下沉 service 层
//   `rbac.can('activity.*.record')`(SUPER_ADMIN 短路;biz-admin 绑全部 5 码)
//
// 路由声明顺序(NestJS 优先级要求,字面段优先于 :id 占位段):
//   list / create / detail / update / softDelete / publish / cancel(后两个挂 :id/<action>)

@ApiTags('Admin - Activities')
@ApiBearerAuth()
@Controller('admin/v1/activities')
export class ActivitiesController {
  constructor(private readonly service: ActivitiesService) {}

  // V2 批次 6 PR #4:从 @Req() 构造 AuditMeta 显式传给 service(D6 v1.1 §11.2 / D8 拍板;
  // 不引入 cls-rs / AsyncLocalStorage)。仅供本 controller 写操作内部复用。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get()
  @ApiOperation({
    summary:
      '列出活动(分页 + 多字段过滤;Q-A7 USER 强制只见 published/completed,忽略入参 statusCode) [auth]',
  })
  @ApiWrappedPageResponse(ActivityListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED)
  list(
    @Query() query: ListActivitiesQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityListItemDto>> {
    return this.service.list(query, currentUser);
  }

  // F1/A6(路线图 §4;D2/D3 拍板):选择器投影,必须先于 /:id 定义(specific-before-dynamic)。
  // 无码仅登录(镜像 list/findOne 现状;RBAC_MAP §2.4 BD-3 已决 won't-do 新增 activity.read.* 码)。
  @Get('options')
  @ApiOperation({
    summary: '活动选择器投影(q 模糊 title;USER 强制只见 published/completed) [auth]',
  })
  @ApiWrappedOkResponse(ActivityOptionsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED)
  options(
    @Query() query: ActivityOptionsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<ActivityOptionsResponseDto> {
    return this.service.options(query, currentUser);
  }

  @Post()
  @ApiOperation({
    summary:
      '创建活动(initial statusCode=draft;禁 statusCode / audit 字段) [rbac: activity.create.record]',
  })
  @ApiWrappedOkResponse(ActivityResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
    BizCode.ACTIVITY_TYPE_CODE_INVALID,
    BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
    BizCode.ACTIVITY_START_END_INVALID,
  )
  create(
    @Body() dto: CreateActivityDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponseDto> {
    return this.service.create(dto, currentUser, this.buildAuditMeta(req));
  }

  @Get(':id')
  @ApiOperation({
    summary: '活动详情(Q-A7 USER 仅可见 published/completed,其他 → 404) [auth]',
  })
  @ApiWrappedOkResponse(ActivityResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.ACTIVITY_NOT_FOUND)
  findOne(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<ActivityResponseDto> {
    return this.service.findOne(params.id, currentUser);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '部分更新活动(Q-A12 cancelled 拒改;禁 statusCode / publishedBy/At / cancelledBy/At/Reason) [rbac: activity.update.record]',
  })
  @ApiWrappedOkResponse(ActivityResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
    BizCode.ACTIVITY_TYPE_CODE_INVALID,
    BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
    BizCode.ACTIVITY_START_END_INVALID,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateActivityDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponseDto> {
    return this.service.update(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '软删活动(写 deletedAt;D3:删除 ≠ 取消;cancelled 仍允许软删) [rbac: activity.delete.record]',
  })
  @ApiWrappedOkResponse(ActivityResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  softDelete(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponseDto> {
    return this.service.softDelete(params.id, currentUser, this.buildAuditMeta(req));
  }

  @Patch(':id/publish')
  @ApiOperation({
    summary:
      '发布活动(draft → published;写 publishedBy/At;非 draft → 20030) [rbac: activity.publish.record]',
  })
  @ApiWrappedOkResponse(ActivityResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
  )
  publish(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponseDto> {
    return this.service.publish(params.id, currentUser, this.buildAuditMeta(req));
  }

  @Patch(':id/cancel')
  @ApiOperation({
    summary:
      '取消活动(* → cancelled;写 cancelledBy/At/Reason;已 cancelled → 20030) [rbac: activity.cancel.record]',
  })
  @ApiWrappedOkResponse(ActivityResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
  )
  cancel(
    @Param() params: IdParamDto,
    @Body() dto: CancelActivityDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponseDto> {
    return this.service.cancel(params.id, dto, currentUser, this.buildAuditMeta(req));
  }
}
