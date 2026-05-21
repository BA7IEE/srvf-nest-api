import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
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
import { Roles } from '../../../common/decorators/roles.decorator';
import { IdParamDto } from '../../../common/dto/id-param.dto';
import { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import {
  ActivityIdParamDto,
  ActivityRegistrationListItemDto,
  ActivityRegistrationResponseDto,
  CancelRegistrationDto,
  CreateMyRegistrationDto,
  ListMyRegistrationsQueryDto,
} from '../activity-registrations.dto';
import { ActivityRegistrationsService } from '../activity-registrations.service';

// P1-C step 3(2026-05-21)Mixed Controller 物理拆分:
//   把 activity-registrations.controller.ts 中同文件第二 class
//   `ActivityRegistrationsMeController` 物理迁出到独立 Controller 文件。
//   沿 docs/api-surface-policy.md §5 项 3 + §7 P1-C step 3;P1-B 第四单(PR #173)已在
//   test/e2e/activity-registrations-me-legacy.e2e-spec.ts 中锁定 13 项现状行为。
//
// 拆分硬约束(沿 docs/api-surface-policy.md §8 P1 禁止事项):
//   ❌ 不改 endpoint path(@Controller('v2/users/me') + 4 个方法 path 全部 zero drift)
//   ❌ 不改 DTO 字段
//   ❌ 不改 service 行为(全部委托 activityRegistrationsService.createMy / listMy / findMy / cancelMy)
//   ❌ 不改 Guard / RBAC / @Roles(USER, ADMIN, SUPER_ADMIN)
//   ❌ 不改 audit 行为(buildAuditMeta 私有副本沿用原模块级函数同语义)
//
// 端点列表(全部 path 与 HTTP method 与拆分前 zero drift):
//   POST  /api/v2/users/me/activities/:activityId/registration — USER 自助报名
//   GET   /api/v2/users/me/registrations                       — 我的报名列表
//   GET   /api/v2/users/me/registrations/:id                   — 我的报名详情
//   PATCH /api/v2/users/me/registrations/:id/cancel            — 我取消报名
//
// sub-helper:`buildAuditMeta` 在原 activity-registrations.controller.ts 是模块级函数,
// Admin 与 Mobile 共用。本 PR 沿"物理拆分零跨文件耦合"原则,在本文件持有独立副本
// (同语义);Admin 文件仍持有自己的副本。沿 PR #169 users.controller / users-me-legacy
// 复制 buildAuditMeta 范式。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

// 沿 P0-F PR-3B 评审稿 §2.2 范式:本 Controller 4 个 `/me/*` 端点保持任意登录用户可访问
// (USER/ADMIN/SUPER_ADMIN 均可调),**不进 RBAC.can()**;按 `currentUser.user.memberId`
// 锁本人数据范围;拆分后仅 JwtAuthGuard(全局 APP_GUARD)+ RolesGuard 兜底。
@ApiTags('Mobile - Registrations')
@ApiBearerAuth()
@Controller('v2/users/me')
export class ActivityRegistrationsMeController {
  constructor(private readonly service: ActivityRegistrationsService) {}

  @Post('activities/:activityId/registration')
  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'USER 自助报名(Q-A3 与 ADMIN 代报名拆开;单数 registration;memberId 强制注入 currentUser.user.memberId)',
  })
  @ApiWrappedOkResponse(ActivityRegistrationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.ACTIVITY_NOT_PUBLIC_REGISTRATION,
    BizCode.ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN,
    BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS,
    BizCode.ACTIVITY_CAPACITY_EXCEEDED,
  )
  createMy(
    @Param() params: ActivityIdParamDto,
    @Body() dto: CreateMyRegistrationDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityRegistrationResponseDto> {
    return this.service.createMy(params.activityId, dto, currentUser, buildAuditMeta(req));
  }

  @Get('registrations')
  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: '我的报名列表(分页;含 cancelled)' })
  @ApiWrappedPageResponse(ActivityRegistrationListItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
  )
  listMy(
    @Query() query: ListMyRegistrationsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityRegistrationListItemDto>> {
    return this.service.listMy(query, currentUser);
  }

  @Get('registrations/:id')
  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: '我的报名详情(强制 memberId === currentUser.user.memberId,否则 404)',
  })
  @ApiWrappedOkResponse(ActivityRegistrationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
  )
  findMy(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<ActivityRegistrationResponseDto> {
    return this.service.findMy(params.id, currentUser);
  }

  @Patch('registrations/:id/cancel')
  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: '我取消报名(pending|pass → cancelled)' })
  @ApiWrappedOkResponse(ActivityRegistrationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
  )
  cancelMy(
    @Param() params: IdParamDto,
    @Body() dto: CancelRegistrationDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityRegistrationResponseDto> {
    return this.service.cancelMy(params.id, dto, currentUser, buildAuditMeta(req));
  }
}
