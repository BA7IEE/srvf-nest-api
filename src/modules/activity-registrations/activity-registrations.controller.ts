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
import { Readable } from 'node:stream';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
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
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ActivityIdParamDto,
  ActivityRegistrationIdParamDto,
  ActivityRegistrationListItemDto,
  ActivityRegistrationResponseDto,
  ApproveRegistrationDto,
  BulkReviewRegistrationsDto,
  BulkReviewRegistrationsResponseDto,
  CancelRegistrationDto,
  CreateRegistrationDto,
  ExportRegistrationsQueryDto,
  ListRegistrationsQueryDto,
  RejectRegistrationDto,
} from './activity-registrations.dto';
import { ActivityRegistrationBulkService } from './activity-registration-bulk.service';
import { ActivityRegistrationsService } from './activity-registrations.service';

// V2 批次 6 PR #5 helper:从 @Req() 构造 AuditMeta(D6 v1.1 §11.2 / D8 拍板;
// 不引入 cls-rs / AsyncLocalStorage)。
//
// buildAuditMeta:本模块级 helper,供 Admin class 使用。队员自助报名流已收口到 App surface
// (`controllers/app-my-registrations.controller.ts`,`@Controller('app/v1/my')`);
// 历史 `/v2/users/me/*` legacy controller 已于 Route B Phase 4d2 删除。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

// V2 第一阶段批次 3A activity-registrations admin controller(审计刀 5 后 9 路由)。
//
// 管理端(admin/v1/activities/:activityId/registrations,9 路由):
//   GET '' list / POST '' 代报名 / GET 'export' / PATCH ':id/approve' /
//   PATCH ':id/reject' / PATCH ':id/cancel' / POST ':id/reopen'(v0.40.0 审批后悔药) /
//   PATCH 'bulk-approve' / PATCH 'bulk-reject'(审计刀 5,逐条独立事务 + 部分成功)
//
// 权限(Slow-4 T3,2026-06-11,评审稿 §3.6;取代批次 3A @Roles 策略):
// 入口仅 JwtAuthGuard,判权下沉 service 层 `rbac.can('activity-registration.*')`
// (SUPER_ADMIN 短路;biz-admin 绑全部 6 码;list / export 共用 read,D4=A 判例)。
//
// 队员自助报名流(原 `/v2/users/me/*` 4 路由:POST 报名 / GET list / GET detail / PATCH cancel)
// 现位于 `controllers/app-my-registrations.controller.ts`(`@Controller('app/v1/my')`);
// 历史 legacy controller 已于 Route B Phase 4d2 删除(沿 docs/api-surface-migration-plan.md §6 Phase 4)。
//
// 路由声明顺序(NestJS 字面段优先于 :id 占位段):
//   list / create / export(字面) / bulk-approve / bulk-reject(字面) /
//   approve / reject / cancel / reopen(均挂 :id/<action>)
//
// Q-A6 CSV export:
//   - Controller 返回 StreamableFile;ResponseInterceptor 已自动跳过(instanceof 判断)
//   - 不需要扩展 SKIP_PREFIXES(沿 response.interceptor.ts:34)
//   - Service 已加 BOM 前缀让 Excel 自动识别 UTF-8

// ============ 管理端 Controller ============

@ApiTags('Admin - Registrations')
@ApiBearerAuth()
@Controller('admin/v1/activities/:activityId/registrations')
export class ActivityRegistrationsAdminController {
  constructor(
    private readonly service: ActivityRegistrationsService,
    private readonly bulk: ActivityRegistrationBulkService,
  ) {}

  @Get()
  @ApiOperation({
    summary: '列出该活动所有报名(分页;含已取消 / 已拒绝) [rbac: activity-registration.read.record]',
  })
  @ApiWrappedPageResponse(ActivityRegistrationListItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  list(
    @Param() params: ActivityIdParamDto,
    @Query() query: ListRegistrationsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<ActivityRegistrationListItemDto>> {
    return this.service.list(params.activityId, query, currentUser);
  }

  @Post()
  @ApiOperation({
    summary:
      'ADMIN 代报名(Q-A3 与 USER 自助拆开;必填 memberId;校验 capacity + 公开报名 + 未重复) [rbac: activity-registration.create.record]',
  })
  @ApiWrappedOkResponse(ActivityRegistrationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.ACTIVITY_NOT_PUBLIC_REGISTRATION,
    BizCode.ACTIVITY_CANCELLED_REGISTRATION_FORBIDDEN,
    BizCode.ACTIVITY_REGISTRATION_DEADLINE_PASSED,
    BizCode.ACTIVITY_REGISTRATION_ALREADY_EXISTS,
    BizCode.ACTIVITY_POSITION_NOT_FOUND,
    BizCode.ACTIVITY_POSITION_REQUIRED,
    BizCode.ACTIVITY_REGISTRATION_GENDER_MISMATCH,
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
  @ApiOperation({
    summary:
      '名单导出 CSV(Q-A6:第一版仅 CSV;默认 scope=pass,可选 scope=all;XLSX 不支持 → 400) [rbac: activity-registration.read.record]',
  })
  @ApiProduces('text/csv')
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async exportRegistrations(
    @Param() params: ActivityIdParamDto,
    @Query() query: ExportRegistrationsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const csv = await this.service.exportCsv(
      params.activityId,
      query,
      currentUser,
      buildAuditMeta(req),
    );
    const fileName = `registrations-${params.activityId}.csv`;
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });
    return new StreamableFile(Readable.from(csv));
  }

  // 字面段必须先于 :id/<action>，防止 bulk-approve/bulk-reject 被解析为报名 id。
  @Patch('bulk-approve')
  @ApiOperation({
    summary:
      '批量审核通过(ids 1–100；逐条独立事务/判权/capacity/audit/通知；部分成功) [rbac: activity-registration.approve.record]',
  })
  @ApiWrappedOkResponse(BulkReviewRegistrationsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED)
  bulkApprove(
    @Param() params: ActivityIdParamDto,
    @Body() dto: BulkReviewRegistrationsDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<BulkReviewRegistrationsResponseDto> {
    return this.bulk.approve(params.activityId, dto, currentUser, buildAuditMeta(req));
  }

  @Patch('bulk-reject')
  @ApiOperation({
    summary:
      '批量审核拒绝(ids 1–100；逐条独立事务/判权/audit/通知；部分成功；空备注默认“批量驳回”) [rbac: activity-registration.reject.record]',
  })
  @ApiWrappedOkResponse(BulkReviewRegistrationsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED)
  bulkReject(
    @Param() params: ActivityIdParamDto,
    @Body() dto: BulkReviewRegistrationsDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<BulkReviewRegistrationsResponseDto> {
    return this.bulk.reject(params.activityId, dto, currentUser, buildAuditMeta(req));
  }

  @Patch(':id/approve')
  @ApiOperation({
    summary: '审核通过(pending → pass;capacity 复核) [rbac: activity-registration.approve.record]',
  })
  @ApiWrappedOkResponse(ActivityRegistrationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
    BizCode.ACTIVITY_ENDED_OR_CANCELLED_APPROVE_FORBIDDEN,
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
  @ApiOperation({
    summary:
      '审核拒绝(pending → reject;reviewNote 必填) [rbac: activity-registration.reject.record]',
  })
  @ApiWrappedOkResponse(ActivityRegistrationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
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
  @ApiOperation({
    summary:
      '管理员代取消(pending|pass → cancelled;cancelled 释放名额;已有考勤记录 → 拒) [rbac: activity-registration.cancel.record]',
  })
  @ApiWrappedOkResponse(ActivityRegistrationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
    BizCode.ACTIVITY_REGISTRATION_HAS_ATTENDANCE,
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

  // 参与域生命周期收口②(v0.40.0):审批后悔药。撤销驳回、回待审(reject → pending)。
  // POST(action 非幂等创建/更新语义,沿 goal 指定动词);置 pending 同时清空审核三字段;不发通知。
  @Post(':id/reopen')
  @ApiOperation({
    summary:
      '撤销驳回、回待审(reject → pending;清空审核字段;不发通知) [rbac: activity-registration.reopen.record]',
  })
  @ApiWrappedOkResponse(ActivityRegistrationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_NOT_FOUND,
    BizCode.ACTIVITY_REGISTRATION_STATUS_INVALID,
  )
  reopen(
    @Param() params: ActivityRegistrationIdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityRegistrationResponseDto> {
    return this.service.reopen(params.activityId, params.id, currentUser, buildAuditMeta(req));
  }
}

// 队员自助报名 Controller(原 `/v2/users/me/*` 4 路由)现位于
// `controllers/app-my-registrations.controller.ts`(`@Controller('app/v1/my')`);
// 历史 legacy controller 已于 Route B Phase 4d2 删除。
