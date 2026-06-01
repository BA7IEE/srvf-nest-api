import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { IdParamDto } from '../../../common/dto/id-param.dto';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { AppMyActivityListItemDto } from '../../activities/dto/app/app-my-activity-list-item.dto';
import { ListAppMyActivitiesQueryDto } from '../../activities/dto/app/list-app-my-activities-query.dto';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppMyRegistrationsService } from '../app-my-registrations.service';
import { CancelAppMyRegistrationDto } from '../dto/app/cancel-app-my-registration.dto';
import { CreateAppMyRegistrationDto } from '../dto/app/create-app-my-registration.dto';
import { AppMyRegistrationListItemDto } from '../dto/app/app-my-registration-list-item.dto';
import { AppMyRegistrationDto } from '../dto/app/app-my-registration.dto';
import { ListAppMyRegistrationsQueryDto } from '../dto/app/list-app-my-registrations-query.dto';

// Phase 2 P2-5a/P2-5b App /api/app/v1/my/* registrations Mobile Controller(5 endpoint)。
// 沿 docs/app-api-p2-5-registrations-review.md §6.1 + §6.4 + D-P2-5-5:
//   - **新建** @Controller('app/v1/my');物理路径 src/modules/activity-registrations/controllers/
//   - 5 endpoint 都挂此 controller(P2-5a 3 个只读;P2-5b 2 个写,沿 §17.1 PR 串)
//   - **不**挂 @Roles(沿 P2-2 / P2-3 / P2-4 范式;App 不用 Role 短路);ADMIN 兼队员
//     可用走 AppIdentityResolver(§7.5 + D-5.2 self perspective)
//   - **不**挂 @Public(全部要登录);依赖全局 JwtAuthGuard
//   - **不**挂限流装饰器(沿 default throttler;§6.1 + D-P2-5-7.3)
//   - App 自助端点只落本 controller(`app/v1/my`);**不**混入 Admin controller(沿 D-P2-5-5;
//     原 `/v2/users/me/*` legacy controller 已于 Route B Phase 4d2 删除)
//
// 准入沿 §7.1 / §7.3:canUseApp=false → 403 FORBIDDEN(member 未关联 / INACTIVE / 软删 /
// Admin 无 member);**不**沿 D-P2-3-1 admin-without-member 例外(沿 §7.4)。
// 全部前置在薄壳 AppMyRegistrationsService 内统一做。
//
// 数据范围沿 §7.6 / §11.6:where 永远含 memberId = currentUser.memberId(由 thin-wrap
// ActivityRegistrationsService.listMy / findMy / createMy / cancelMy 现状保证;
// **禁止** role 短路 / 接收 body memberId)。
//
// Phase 2 P2-5b(2026-05-20)追加 2 写 endpoint(沿 §17.1 + §13.5):
//   - POST   /registrations             报名(薄壳 inline `assertActivityPublishedOrThrow` 前置)
//   - PATCH  /registrations/:id/cancel  取消本人报名(状态机 pending|pass → cancelled)
// 复用既有 audit event(registration.create + viaPath='self' / registration.review +
// action='cancel';沿 §12.1);零新 BizCode(沿 D-P2-5-10);零 schema 变更(沿 §15.2)。
@ApiTags('Mobile - My Registrations')
@ApiBearerAuth()
@Controller('app/v1/my')
export class AppMyRegistrationsController {
  constructor(private readonly appMyRegistrations: AppMyRegistrationsService) {}

  // ============ GET /api/app/v1/my/registrations(P2-5a)============

  @Get('registrations')
  @ApiOperation({
    summary: '我的报名列表(分页 + 可选 statusCode 过滤;sensitive admin 字段不返)',
  })
  @ApiWrappedPageResponse(AppMyRegistrationListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  listMy(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ListAppMyRegistrationsQueryDto,
  ): Promise<PageResultDto<AppMyRegistrationListItemDto>> {
    return this.appMyRegistrations.listMyForApp(query, currentUser);
  }

  // ============ GET /api/app/v1/my/registrations/:id(P2-5a)============

  @Get('registrations/:id')
  @ApiOperation({
    summary: '我的报名详情(owner 校验:memberId !== currentUser.memberId 统一返 404 防侧信道)',
  })
  @ApiWrappedOkResponse(AppMyRegistrationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
  )
  findMy(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() { id }: IdParamDto,
  ): Promise<AppMyRegistrationDto> {
    return this.appMyRegistrations.findMyForApp(id, currentUser);
  }

  // ============ GET /api/app/v1/my/activities(P2-5a)============

  @Get('activities')
  @ApiTags('Mobile - My Activities')
  @ApiOperation({
    summary:
      '我已建立 registration 关系的活动汇总(分页 + 可选 registrationStatusCode 过滤;每活动一行,含本人最新有效 registration 摘要)',
  })
  @ApiWrappedPageResponse(AppMyActivityListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  listMyActivities(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ListAppMyActivitiesQueryDto,
  ): Promise<PageResultDto<AppMyActivityListItemDto>> {
    return this.appMyRegistrations.listMyActivitiesForApp(query, currentUser);
  }

  // ============ POST /api/app/v1/my/registrations(P2-5b)============

  @Post('registrations')
  @ApiOperation({
    summary:
      '本人报名活动(入参 activityId + 可选 extras;前置 published 校验,非 published 统一返 404 防侧信道)',
  })
  @ApiWrappedOkResponse(AppMyRegistrationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_NOT_PUBLIC_REGISTRATION,
    BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS,
    BizCode.ACTIVITY_CAPACITY_EXCEEDED,
  )
  createMy(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: CreateAppMyRegistrationDto,
    @Req() req: Request,
  ): Promise<AppMyRegistrationDto> {
    return this.appMyRegistrations.createMyForApp(currentUser, dto, this.buildAuditMeta(req));
  }

  // ============ PATCH /api/app/v1/my/registrations/:id/cancel(P2-5b)============

  @Patch('registrations/:id/cancel')
  @ApiOperation({
    summary:
      '取消本人报名(pending|pass → cancelled;reject / cancelled / 他人 / 软删 / 不存在统一返 404 防侧信道或 21030)',
  })
  @ApiWrappedOkResponse(AppMyRegistrationDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
  )
  cancelMy(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() { id }: IdParamDto,
    @Body() dto: CancelAppMyRegistrationDto,
    @Req() req: Request,
  ): Promise<AppMyRegistrationDto> {
    return this.appMyRegistrations.cancelMyForApp(currentUser, id, dto, this.buildAuditMeta(req));
  }

  // P2-5b 私有 helper(沿 P2-3 决议 α 第三次复用仍复制不抽;字面 = app-me.controller.ts:200-206
  // / activity-registrations.controller.ts:50-56)。
  // 从 @Req() 构造 AuditMeta 显式传给薄壳 service(D6 v1.1 §11.2 / D8 拍板;
  // 不引入 cls-rs / AsyncLocalStorage)。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
