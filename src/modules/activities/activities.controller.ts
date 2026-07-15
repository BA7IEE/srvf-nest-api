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
  PublishActivityDto,
  CreateActivityDto,
  ListActivitiesQueryDto,
  UpdateActivityDto,
} from './activities.dto';
import { ActivitiesService } from './activities.service';

// V2 第一阶段批次 3A activities controller(8 路由;v0.40.0 +complete)。
// 路径前缀:全局 /api(main.ts)+ 'admin/v1/activities'。
//
// 权限(Slow-4 T3,2026-06-11,评审稿 §3.5;取代批次 3A @Roles 策略):
// - GET list / GET detail:无码化,仅登录(`[auth]`;原 @Roles 含 USER = 全角色放行,
//   等价仅登录;service 内 Q-A7 USER 过滤逻辑原样保留)
// - POST / PATCH / DELETE / publish / cancel / complete:判权下沉 service 层
//   `rbac.can('activity.*.record')`(SUPER_ADMIN 短路;biz-admin 绑全部 6 码)
//
// 路由声明顺序(NestJS 优先级要求,字面段优先于 :id 占位段):
//   list / create / detail / update / softDelete / publish / cancel / complete(后三个挂 :id/<action>)

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
    BizCode.ACTIVITY_REGISTRATION_DEADLINE_INVALID,
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
      '部分更新活动(completed/cancelled 仅展示字段可改;事实字段锁定) [rbac: activity.update.record]',
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
    BizCode.ACTIVITY_REGISTRATION_DEADLINE_INVALID,
    BizCode.ACTIVITY_CAPACITY_INVALID,
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
      '软删活动(存在 pending/pass 报名或未软删考勤单时拒绝，须先取消活动) [rbac: activity.delete.record]',
  })
  @ApiWrappedOkResponse(ActivityResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_PARTICIPATION_EXISTS_DELETE_FORBIDDEN,
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
      '发布活动(draft → published;请求体须显式确认保险，且活动/报名截止时间有效) [rbac: activity.publish.record]',
  })
  @ApiWrappedOkResponse(ActivityResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED,
  )
  publish(
    @Param() params: IdParamDto,
    @Body() dto: PublishActivityDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponseDto> {
    return this.service.publish(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Patch(':id/cancel')
  @ApiOperation({
    summary:
      '取消活动(draft|published → cancelled；pending 报名联动取消，pass 保留) [rbac: activity.cancel.record]',
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

  // 参与域生命周期收口③(v0.40.0):管理端手动完结活动。POST(action 非幂等更新语义,沿 goal 指定动词)。
  @Post(':id/complete')
  @ApiOperation({
    summary:
      '手动完结活动(published → completed；唯一完结通路，非 published → 20030) [rbac: activity.complete.record]',
  })
  @ApiWrappedOkResponse(ActivityResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
  )
  complete(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponseDto> {
    return this.service.complete(params.id, currentUser, this.buildAuditMeta(req));
  }
}
