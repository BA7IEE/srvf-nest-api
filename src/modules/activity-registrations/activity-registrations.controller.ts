import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Request, Response } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ActivityIdParamDto,
  ActivityRegistrationIdParamDto,
  ActivityRegistrationListItemDto,
  ActivityRegistrationResponseDto,
  ApproveRegistrationDto,
  CancelRegistrationDto,
  CreateMyRegistrationDto,
  CreateRegistrationDto,
  ExportRegistrationsQueryDto,
  ListMyRegistrationsQueryDto,
  ListRegistrationsQueryDto,
  RejectRegistrationDto,
} from './activity-registrations.dto';
import { ActivityRegistrationsService } from './activity-registrations.service';

// V2 批次 6 PR #5 共享 helper:从 @Req() 构造 AuditMeta(D6 v1.1 §11.2 / D8 拍板;
// 不引入 cls-rs / AsyncLocalStorage)。两个 controller 共用此函数(模块级私有,沿
// contribution-rules / activities 单 controller 类内私有方法的范式;activity-registrations
// 模块有 2 个 controller 同需此 helper,提到模块级以避免重复)。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

// V2 第一阶段批次 3A activity-registrations controllers(10 路由)。
//
// 管理端(/v2/activities/:activityId/registrations,6 路由):
//   GET '' list / POST '' 代报名 / GET 'export' / PATCH ':id/approve' /
//   PATCH ':id/reject' / PATCH ':id/cancel'
//
// 队员端(/v2/users/me,4 路由,Q-A2 + Q-A3 拆开):
//   POST 'activities/:activityId/registration'(USER 自助;单数 registration)
//   GET  'registrations'(我的报名列表)
//   GET  'registrations/:id'(我的报名详情)
//   PATCH 'registrations/:id/cancel'(我取消报名)
//
// 路由声明顺序(NestJS 字面段优先于 :id 占位段):
//   admin controller:list / create / export(字面)/ approve / reject / cancel(均挂 :id/<action>)
//   me controller:POST 单数 registration / GET list / GET detail / PATCH cancel
//
// Q-A6 CSV export:
//   - Controller 返回 StreamableFile;ResponseInterceptor 已自动跳过(instanceof 判断)
//   - 不需要扩展 SKIP_PREFIXES(沿 response.interceptor.ts:34)
//   - Service 已加 BOM 前缀让 Excel 自动识别 UTF-8

// ============ 管理端 Controller ============

@ApiTags('Admin - Registrations')
@ApiBearerAuth()
@Controller('v2/activities/:activityId/registrations')
export class ActivityRegistrationsAdminController {
  constructor(private readonly service: ActivityRegistrationsService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '列出该活动所有报名(分页;含已取消 / 已拒绝)' })
  @ApiWrappedPageResponse(ActivityRegistrationListItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  list(
    @Param() params: ActivityIdParamDto,
    @Query() query: ListRegistrationsQueryDto,
  ): Promise<PageResultDto<ActivityRegistrationListItemDto>> {
    return this.service.list(params.activityId, query);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: 'ADMIN 代报名(Q-A3 与 USER 自助拆开;必填 memberId;校验 capacity + 公开报名 + 未重复)',
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
  create(
    @Param() params: ActivityIdParamDto,
    @Body() dto: CreateRegistrationDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityRegistrationResponseDto> {
    return this.service.create(params.activityId, dto, currentUser, buildAuditMeta(req));
  }

  // 必须先于 :id/<action> 声明:export 是字面段。
  @Get('export')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '名单导出 CSV(Q-A6:第一版仅 CSV;默认 scope=pass,可选 scope=all;XLSX 不支持 → 400)',
  })
  @ApiProduces('text/csv')
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async exportRegistrations(
    @Param() params: ActivityIdParamDto,
    @Query() query: ExportRegistrationsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const csv = await this.service.exportCsv(params.activityId, query, currentUser);
    const fileName = `registrations-${params.activityId}.csv`;
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });
    // UTF-8 BOM(让 Excel 自动识别中文)。
    return new StreamableFile(Buffer.from('﻿' + csv, 'utf8'));
  }

  @Patch(':id/approve')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '审核通过(pending → pass;capacity 复核)' })
  @ApiWrappedOkResponse(ActivityRegistrationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
    BizCode.ACTIVITY_CAPACITY_EXCEEDED,
  )
  approve(
    @Param() params: ActivityRegistrationIdParamDto,
    @Body() dto: ApproveRegistrationDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityRegistrationResponseDto> {
    return this.service.approve(
      params.activityId,
      params.id,
      dto,
      currentUser,
      buildAuditMeta(req),
    );
  }

  @Patch(':id/reject')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '审核拒绝(pending → reject;reviewNote 必填)' })
  @ApiWrappedOkResponse(ActivityRegistrationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
  )
  reject(
    @Param() params: ActivityRegistrationIdParamDto,
    @Body() dto: RejectRegistrationDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityRegistrationResponseDto> {
    return this.service.reject(params.activityId, params.id, dto, currentUser, buildAuditMeta(req));
  }

  @Patch(':id/cancel')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '管理员代取消(pending|pass → cancelled;cancelled 释放名额)',
  })
  @ApiWrappedOkResponse(ActivityRegistrationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
  )
  cancel(
    @Param() params: ActivityRegistrationIdParamDto,
    @Body() dto: CancelRegistrationDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityRegistrationResponseDto> {
    return this.service.cancelAdmin(
      params.activityId,
      params.id,
      dto,
      currentUser,
      buildAuditMeta(req),
    );
  }
}

// ============ 队员端 Controller(/v2/users/me)============

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
