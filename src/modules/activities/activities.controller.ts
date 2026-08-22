import {
  HttpStatus,
  HttpCode,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiWrappedCreatedResponse,
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
  PublishActivityWithAudienceTagsDto,
  CreateActivityDto,
  ListActivitiesQueryDto,
  SetActivityCoverDto,
  SetActivityGalleryDto,
  UpdateActivityDto,
} from './activities.dto';
import { ActivitiesService } from './activities.service';
import { ActivityCoverService } from './activity-cover.service';
import { LoginScoped, RequiresPermission } from '../../common/decorators/route-authz.decorator';

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
  constructor(
    private readonly service: ActivitiesService,
    // P2-14 刀 A:封面 / 图集的唯一写入口;Admin 与 App 两条 surface 委托同一个它。
    private readonly covers: ActivityCoverService,
  ) {}

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
  @LoginScoped('activity-visibility', { require: 'all', engine: 'authz-scoped' })
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
  @LoginScoped('activity-visibility', { require: 'all', engine: 'authz-scoped' })
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
  @RequiresPermission('activity.create.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '创建活动(initial statusCode=draft;禁 statusCode / audit 字段) [rbac: activity.create.record]',
  })
  @ApiWrappedCreatedResponse(ActivityResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
    BizCode.ACTIVITY_INITIATOR_NOT_FORMAL,
    BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN,
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
  @LoginScoped('activity-visibility', { require: 'all', engine: 'authz-scoped' })
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
  @RequiresPermission('activity.update.record', { require: 'all', engine: 'rbac-global' })
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
    BizCode.ORGANIZATION_INACTIVE,
    BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN,
    BizCode.ACTIVITY_INITIATOR_NOT_FORMAL,
    BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN,
    BizCode.ACTIVITY_TYPE_CODE_INVALID,
    BizCode.ACTIVITY_GENDER_REQUIREMENT_CODE_INVALID,
    BizCode.ACTIVITY_START_END_INVALID,
    BizCode.ACTIVITY_REGISTRATION_DEADLINE_INVALID,
    BizCode.ACTIVITY_CAPACITY_INVALID,
    BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdateActivityDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponseDto> {
    return this.service.update(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  // ============ P2-14 刀 A:设 / 清封面与图集 ============
  //
  // 复用既有 `activity.update.record` 权限码 —— **不新增权限码**:改封面在语义上就是一次
  // 活动更新,它此前也确实是 PATCH :id 的一个字段。新开端点是因为附件必须先归属本活动
  // (create 那一刻活动还不存在),不是因为它变成了另一种权限。
  //
  // ⚠️ 刻意**不加状态闸**:改造前 coverImageUrl / galleryImageUrls 同时落在
  // PUBLISHED_ACTIVITY_DISPLAY_FIELDS(已发布可直改)与 TERMINAL_ACTIVITY_UPDATE_FIELDS
  // (终态仍可改)两个白名单里。加闸会是本刀夹带的行为收窄。

  @Put(':id/cover')
  @RequiresPermission('activity.update.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '设 / 清活动封面(attachmentId 须为本活动的 activity 类型附件;传 null 清空) [rbac: activity.update.record]',
  })
  @ApiWrappedOkResponse(ActivityResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING,
  )
  setCover(
    @Param() params: IdParamDto,
    @Body() dto: SetActivityCoverDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponseDto> {
    return this.covers.setCoverAdmin(
      params.id,
      dto.attachmentId,
      currentUser,
      this.buildAuditMeta(req),
    );
  }

  @Put(':id/gallery')
  @RequiresPermission('activity.update.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '设 / 清活动图集(每个 attachmentId 须为本活动的 activity 类型附件;传 [] 清空) [rbac: activity.update.record]',
  })
  @ApiWrappedOkResponse(ActivityResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING,
  )
  setGallery(
    @Param() params: IdParamDto,
    @Body() dto: SetActivityGalleryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponseDto> {
    return this.covers.setGalleryAdmin(
      params.id,
      dto.attachmentIds,
      currentUser,
      this.buildAuditMeta(req),
    );
  }

  @Delete(':id')
  @RequiresPermission('activity.delete.record', { require: 'all', engine: 'rbac-global' })
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
  @RequiresPermission('activity.publish.record', { require: 'all', engine: 'rbac-global' })
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
    BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT,
  )
  publish(
    @Param() params: IdParamDto,
    @Body() dto: PublishActivityDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponseDto> {
    return this.service.publish(params.id, dto, currentUser, this.buildAuditMeta(req));
  }

  @Patch(':id/publish-with-audience-tags')
  @RequiresPermission('activity.publish.record', { require: 'all', engine: 'rbac-global' })
  @ApiOperation({
    summary:
      '按会员受众标签发布活动(空数组面向全部有效会员；开关关闭时 503) [rbac: activity.publish.record]',
  })
  @ApiWrappedOkResponse(ActivityResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED,
    BizCode.ACTIVITY_ALLOCATION_MODE_INCONSISTENT,
    BizCode.SERVICE_UNAVAILABLE,
  )
  publishWithAudienceTags(
    @Param() params: IdParamDto,
    @Body() dto: PublishActivityWithAudienceTagsDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponseDto> {
    return this.service.publishWithAudienceTags(
      params.id,
      dto,
      currentUser,
      this.buildAuditMeta(req),
    );
  }

  @Patch(':id/cancel')
  @RequiresPermission('activity.cancel.record', { require: 'all', engine: 'rbac-global' })
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
  @RequiresPermission('activity.complete.record', { require: 'all', engine: 'rbac-global' })
  @HttpCode(HttpStatus.OK)
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
