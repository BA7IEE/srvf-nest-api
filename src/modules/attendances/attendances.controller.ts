import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
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
import { Roles } from '../../common/decorators/roles.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ActivityIdParamDto,
  ApproveAttendanceSheetDto,
  AttendanceSheetListItemDto,
  AttendanceSheetResponseDto,
  AttendanceSheetReviewDetailDto,
  CreateAttendanceSheetDto,
  FinalApproveAttendanceSheetDto,
  FinalRejectAttendanceSheetDto,
  ListAttendanceSheetsQueryDto,
  RejectAttendanceSheetDto,
  UpdateAttendanceSheetDto,
} from './attendances.dto';
import { AttendancesService } from './attendances.service';

// V2 批次 6 PR #6 共享 helper:从 @Req() 构造 AuditMeta(D6 v1.1 §11.2 / D8 拍板;
// 不引入 cls-rs / AsyncLocalStorage)。
//
// P1-C step 4(2026-05-26):Mobile class `AttendanceRecordsMeController` 已物理拆出到
// `controllers/attendances-me-records-legacy.controller.ts`(该端点为纯读路径,不引用
// buildAuditMeta;沿 "物理拆分零跨文件耦合" 原则,不跨文件共享 audit helper)。本文件
// 保留此模块级函数供 Admin 两 class 使用(共 6 处调用)。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

// V2 第一阶段批次 3B attendances admin controllers(8 路由)。
//
// 两组路径前缀:
//   1. /v2/activities/:activityId/attendance-sheets(提交 + 列表;2 路由)
//   2. /v2/attendance-sheets/:id(详情 / review-detail / edit / delete / approve / reject /
//      final-approve / final-reject;6 路由)
//
// 路由声明顺序(NestJS 字面段优先于 :id 占位段):
//   sheet controller:list / create / review-detail(字面)/ detail / edit / softDelete /
//   approve / reject / final-approve / final-reject
//
// P1-C step 4(2026-05-26):队员端 1 路由(`GET /v2/users/me/attendance-records`)已物理
// 迁出到 `controllers/attendances-me-records-legacy.controller.ts`;endpoint path / DTO /
// service / Guard / RBAC / Swagger Tag 全部 zero drift(沿 docs/api-surface-policy.md §5 项
// 2 + §6 项 6 + §7 P1-C step 4 + §8 P1 禁止事项)。
//
// 权限策略(沿决议表 v1.0):
// - 全部管理端 8 路由:ADMIN / SUPER_ADMIN(D16 兜底业务角色)

// ============ 管理端 Controller(挂 /v2/activities/:activityId/attendance-sheets)============

@ApiTags('Admin - Attendances')
@ApiBearerAuth()
@Controller('v2/activities/:activityId/attendance-sheets')
export class AttendanceSheetsCollectionController {
  constructor(private readonly service: AttendancesService) {}

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '提交考勤单据(事务内一次性 create Sheet + N records;初始 statusCode=pending,version=1;Activity cancelled 拒绝)',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '列出该活动所有考勤单据(分页 + 可选 statusCode 过滤)' })
  @ApiWrappedPageResponse(AttendanceSheetListItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  list(
    @Param() params: ActivityIdParamDto,
    @Query() query: ListAttendanceSheetsQueryDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AttendanceSheetListItemDto>> {
    return this.service.list(params.activityId, query, currentUser);
  }
}

// ============ 管理端 Controller(挂 /v2/attendance-sheets/:id)============

@ApiTags('Admin - Attendances')
@ApiBearerAuth()
@Controller('v2/attendance-sheets')
export class AttendanceSheetsResourceController {
  constructor(private readonly service: AttendancesService) {}

  // review-detail 必须先于 :id 声明(字面段优先于占位段)
  @Get(':id/review-detail')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: 'APD 审核完整视图(R25):Activity 摘要 + Sheet 详情 + Records[含 Member 嵌套]',
  })
  @ApiWrappedOkResponse(AttendanceSheetReviewDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  reviewDetail(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AttendanceSheetReviewDetailDto> {
    return this.service.reviewDetail(params.id, currentUser);
  }

  @Get(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Sheet 简化详情(不含 records 数组;不返 previousSnapshot)' })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
  )
  findOne(
    @Param() params: IdParamDto,
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AttendanceSheetResponseDto> {
    return this.service.findOne(params.id, currentUser);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '编辑 pending Sheet(D38:后端生成 previousSnapshot + version+1;旧 records 软删 + 新 records 创建;approved/rejected/pending_final_review/final_rejected 拒绝)',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '软删 pending Sheet(事务内级联软删 records;approved/rejected/pending_final_review/final_rejected 拒绝)',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      'APD 一级通过(pending → pending_final_review;批次 4-B 升级,沿 D-S6;R31 所有 records.contributionPoints 必填;**不再触发** attendance.recorded — 触发位置移到 final-approve;待终审)',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'APD 一级驳回(pending → rejected;reviewNote 必填)' })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  // 沿 D-A2(沿 baseline §4.4 敏感操作必须独立接口);权限沿 RolesGuard(ADMIN / SUPER_ADMIN),
  // 不开 22044 模块码(沿 D-S2 / batch 3A 不开 FORBIDDEN_*);终审权限不足走通用 FORBIDDEN(40300)。

  @Patch(':id/final-approve')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '终审通过(当前沿用管理权限,细分权限后置;pending_final_review → approved;贡献值正式生效;**触发** attendance.recorded;沿 D-S5 / D-S7)',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '终审驳回(当前沿用管理权限,细分权限后置;pending_final_review → final_rejected;finalReviewNote 必填;records 跟随软删;**不触发** attendance.recorded)',
  })
  @ApiWrappedOkResponse(AttendanceSheetResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
}
