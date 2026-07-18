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
  ActivityIdParamDto,
  AdminAttendanceSheetListItemDto,
  ApproveAttendanceSheetDto,
  AttendanceSheetListItemDto,
  AttendanceSheetResponseDto,
  AttendanceSheetReviewDetailDto,
  CreateAttendanceSheetDto,
  FinalApproveAttendanceSheetDto,
  FinalRejectAttendanceSheetDto,
  ListAttendanceSheetsQueryDto,
  ReopenAttendanceSheetDto,
  RejectAttendanceSheetDto,
  UpdateAttendanceSheetDto,
} from './attendances.dto';
import { AttendancesService } from './attendances.service';

// V2 批次 6 PR #6 共享 helper:从 @Req() 构造 AuditMeta(D6 v1.1 §11.2 / D8 拍板;
// 不引入 cls-rs / AsyncLocalStorage)。
//
// buildAuditMeta:本模块级 helper,供 Admin 两 class 使用。队员自助考勤记录流
// 已收口到 App surface(`controllers/app-my-attendance-records.controller.ts`,`@Controller('app/v1/my')`);
// 历史 `/v2/users/me/attendance-records` legacy controller 已于 Route B Phase 4d2 删除。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

// V2 第一阶段批次 3B attendances admin controllers(v0.47.0 +reopen)。
//
// 两组路径前缀:
//   1. admin/v1/activities/:activityId/attendance-sheets(提交 + 列表;2 路由)
//   2. admin/v1/attendance-sheets/:id(详情 / review-detail / edit / delete / approve / reject /
//      final-approve / final-reject / reopen)
//
// 路由声明顺序(NestJS 字面段优先于 :id 占位段):
//   sheet controller:list / create / review-detail(字面)/ detail / edit / softDelete /
//   approve / reject / final-approve / final-reject / reopen
//
// 队员自助考勤记录(原 `GET /v2/users/me/attendance-records` 1 路由)现位于
// `controllers/app-my-attendance-records.controller.ts`(`GET /api/app/v1/my/attendance-records`);
// 历史 legacy controller 已于 Route B Phase 4d2 删除(沿 docs/api-surface-migration-plan.md §6 Phase 4)。
//
// 权限(Slow-4 T3,2026-06-11,评审稿 §3.7;取代决议表 v1.0 @Roles 策略):
// 入口仅 JwtAuthGuard,判权下沉 service 层 `rbac.can('attendance.*.sheet')`
// (SUPER_ADMIN 短路;biz-admin 绑全部 8 码;list / detail / review-detail 共用 read,
// D4=A 判例;终审仍 ADMIN 级,沿 P1-5 方案 A,部门级细分挂 Slow-3 子议题)。

// ============ 管理端 Controller(挂 admin/v1/activities/:activityId/attendance-sheets)============

@ApiTags('Admin - Attendances')
@ApiBearerAuth()
@Controller('admin/v1/activities/:activityId/attendance-sheets')
export class AttendanceSheetsCollectionController {
  constructor(private readonly service: AttendancesService) {}

  @Post()
  @ApiOperation({
    summary:
      '提交考勤单据(事务内一次性 create Sheet + N records;初始 statusCode=pending,version=1;Activity cancelled 拒绝) [rbac: attendance.create.sheet]',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_CANCELLED_ATTENDANCE_FORBIDDEN,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.ATTENDANCE_ROLE_CODE_INVALID,
    BizCode.ATTENDANCE_STATUS_CODE_INVALID,
    BizCode.ATTENDANCE_TIME_OVERLAP,
    BizCode.CHECK_OUT_BEFORE_CHECK_IN,
    BizCode.ATTENDANCE_SERVICE_HOURS_INVALID,
    BizCode.ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN,
    BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH,
    BizCode.ATTENDANCE_REGISTRATION_INVALID,
    BizCode.ATTENDANCE_CHECK_OUT_IN_FUTURE,
  )
  submit(
    @Param() params: ActivityIdParamDto,
    @Body() dto: CreateAttendanceSheetDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttendanceSheetResponseDto> {
    return this.service.submit(params.activityId, dto, currentUser, buildAuditMeta(req));
  }

  @Get()
  @ApiOperation({
    summary: '列出该活动所有考勤单据(分页 + 可选 statusCode 过滤) [rbac: attendance.read.sheet]',
  })
  @ApiWrappedPageResponse(AttendanceSheetListItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  list(
    @Param() params: ActivityIdParamDto,
    @Query() query: ListAttendanceSheetsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<PageResultDto<AttendanceSheetListItemDto>> {
    return this.service.list(params.activityId, query, currentUser, buildAuditMeta(req));
  }
}

// ============ 管理端 Controller(挂 admin/v1/attendance-sheets/:id)============

@ApiTags('Admin - Attendances')
@ApiBearerAuth()
@Controller('admin/v1/attendance-sheets')
export class AttendanceSheetsResourceController {
  constructor(private readonly service: AttendancesService) {}

  // 跨轴只读(2026-06-23 队员/审批跨轴只读查询 goal;审批工作台 Tier2):根 @Get 跨所有活动横扫
  // 考勤单据(脱离 :activityId 路径段)。根路径精确匹配空段,与 :id / :id/review-detail 无声明顺序冲突。
  // 判权复用 attendance.read.sheet;item 自带 activity 上下文(AdminAttendanceSheetListItemDto)。
  @Get()
  @ApiOperation({
    summary:
      '跨活动考勤单据横扫(审批工作台;分页 + 可选 statusCode/q/activityQ/organizationId/includeDescendants/dateFrom/dateTo/expand=activity;脱离 :activityId 路径段;item 带 activity 上下文) [rbac: attendance.read.sheet]',
  })
  @ApiWrappedPageResponse(AdminAttendanceSheetListItemDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  listAll(
    @Query() query: ListAttendanceSheetsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AdminAttendanceSheetListItemDto>> {
    return this.service.listAllSheetsForAdmin(query, currentUser);
  }

  // review-detail 必须先于 :id 声明(字面段优先于占位段)
  @Get(':id/review-detail')
  @ApiOperation({
    summary:
      'APD 审核完整视图(R25):Activity 摘要 + Sheet 详情 + Records[含 Member 嵌套] [rbac: attendance.read.sheet]',
  })
  @ApiWrappedOkResponse(AttendanceSheetReviewDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  reviewDetail(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttendanceSheetReviewDetailDto> {
    return this.service.reviewDetail(params.id, currentUser, buildAuditMeta(req));
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Sheet 简化详情(不含 records 数组;不返 previousSnapshot) [rbac: attendance.read.sheet]',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
  )
  findOne(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttendanceSheetResponseDto> {
    return this.service.findOne(params.id, currentUser, buildAuditMeta(req));
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '编辑 pending Sheet(D38:后端生成 previousSnapshot + version+1;旧 records 软删 + 新 records 创建;approved/rejected/pending_final_review/final_rejected 拒绝) [rbac: attendance.update.sheet]',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
    BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
    BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE,
    BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE,
    BizCode.ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.ATTENDANCE_ROLE_CODE_INVALID,
    BizCode.ATTENDANCE_STATUS_CODE_INVALID,
    BizCode.ATTENDANCE_TIME_OVERLAP,
    BizCode.CHECK_OUT_BEFORE_CHECK_IN,
    BizCode.ATTENDANCE_SERVICE_HOURS_INVALID,
    BizCode.ATTENDANCE_SERVICE_HOURS_EXCEEDS_SPAN,
    BizCode.ATTENDANCE_REGISTRATION_ACTIVITY_MISMATCH,
    BizCode.ATTENDANCE_REGISTRATION_INVALID,
    BizCode.ATTENDANCE_CHECK_OUT_IN_FUTURE,
  )
  edit(
    @Param() params: IdParamDto,
    @Body() dto: UpdateAttendanceSheetDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttendanceSheetResponseDto> {
    return this.service.edit(params.id, dto, currentUser, buildAuditMeta(req));
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '软删 pending Sheet(事务内级联软删 records;approved/rejected/pending_final_review/final_rejected 拒绝) [rbac: attendance.delete.sheet]',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
    BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
    BizCode.ATTENDANCE_SHEET_APPROVED_NOT_EDITABLE,
    BizCode.ATTENDANCE_SHEET_REJECTED_NOT_EDITABLE,
    BizCode.ATTENDANCE_SHEET_FINAL_REJECTED_NOT_EDITABLE,
  )
  softDelete(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttendanceSheetResponseDto> {
    return this.service.softDelete(params.id, currentUser, buildAuditMeta(req));
  }

  @Patch(':id/approve')
  @ApiOperation({
    summary:
      'APD 一级通过(pending → pending_final_review;批次 4-B 升级,沿 D-S6;R31 所有 records.contributionPoints 必填;**不再触发** attendance.recorded — 触发位置移到 final-approve;待终审) [rbac: attendance.approve.sheet]',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
    BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
    BizCode.ATTENDANCE_RECORD_CONTRIBUTION_POINTS_REQUIRED,
  )
  approve(
    @Param() params: IdParamDto,
    @Body() dto: ApproveAttendanceSheetDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttendanceSheetResponseDto> {
    return this.service.approve(params.id, dto, currentUser, buildAuditMeta(req));
  }

  @Patch(':id/reject')
  @ApiOperation({
    summary: 'APD 一级驳回(pending → rejected;reviewNote 必填) [rbac: attendance.reject.sheet]',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
    BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
  )
  reject(
    @Param() params: IdParamDto,
    @Body() dto: RejectAttendanceSheetDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttendanceSheetResponseDto> {
    return this.service.reject(params.id, dto, currentUser, buildAuditMeta(req));
  }

  // ============ 批次 4-B 新增:终审 final-approve / final-reject ============
  // 沿 D-A2(沿 baseline §4.4 敏感操作必须独立接口);Slow-4 T3 起权限走 service 层
  // rbac.can('attendance.final-{approve,reject}.sheet')(ADMIN 级终审沿 P1-5 方案 A),
  // 不开 22044 模块码(沿 D-S2 / batch 3A 不开 FORBIDDEN_*);判权不足走 RBAC_FORBIDDEN(30100)。

  @Patch(':id/final-approve')
  @ApiOperation({
    summary:
      '终审通过(ADMIN 级终审沿 P1-5 方案 A,部门级细分挂 Slow-3;pending_final_review → approved;贡献值正式生效;**触发** attendance.recorded;沿 D-S5 / D-S7) [rbac: attendance.final-approve.sheet]',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
    BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID,
  )
  finalApprove(
    @Param() params: IdParamDto,
    @Body() dto: FinalApproveAttendanceSheetDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttendanceSheetResponseDto> {
    return this.service.finalApprove(params.id, dto, currentUser, buildAuditMeta(req));
  }

  @Patch(':id/final-reject')
  @ApiOperation({
    summary:
      '终审驳回(ADMIN 级终审沿 P1-5 方案 A,部门级细分挂 Slow-3;pending_final_review → final_rejected;finalReviewNote 必填;records 跟随软删;**不触发** attendance.recorded) [rbac: attendance.final-reject.sheet]',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
    BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_STATUS_INVALID,
    BizCode.ATTENDANCE_SHEET_FINAL_REVIEW_NOTE_REQUIRED,
  )
  finalReject(
    @Param() params: IdParamDto,
    @Body() dto: FinalRejectAttendanceSheetDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttendanceSheetResponseDto> {
    return this.service.finalReject(params.id, dto, currentUser, buildAuditMeta(req));
  }

  @Post(':id/reopen')
  @ApiOperation({
    summary:
      '撤回已终审通过的考勤单(approved → pending;保留 records,清空一审/终审责任字段;不发通知) [rbac: attendance.reopen.sheet]',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
    BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
  )
  reopen(
    @Param() params: IdParamDto,
    @Body() dto: ReopenAttendanceSheetDto,
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AttendanceSheetResponseDto> {
    return this.service.reopen(params.id, dto, currentUser, buildAuditMeta(req));
  }
}
