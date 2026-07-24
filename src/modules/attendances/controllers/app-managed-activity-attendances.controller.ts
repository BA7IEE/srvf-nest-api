import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../../common/dto/pagination.dto';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { AppManagedActivityAttendancesService } from '../app-managed-activity-attendances.service';
import {
  AppManagedActivityCheckInDto,
  AppManagedActivityCheckInsQueryDto,
  AppManagedAttendanceActivityParamsDto,
  AppManagedAttendanceSheetDetailDto,
  AppManagedAttendanceSheetDraftDto,
  AppManagedAttendanceSheetDto,
  AppManagedAttendanceSheetListItemDto,
  AppManagedAttendanceSheetParamsDto,
  AppManagedAttendanceSheetsQueryDto,
  CreateAppManagedAttendanceSheetDto,
  ResubmitAppManagedAttendanceSheetDto,
  UpdateAppManagedAttendanceSheetDto,
} from '../dto/app/app-managed-attendance.dto';

@ApiTags('Mobile - Managed Activity Attendances')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities/:activityId')
export class AppManagedActivityAttendancesController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly service: AppManagedActivityAttendancesService,
  ) {}

  @Get('check-ins')
  @ApiOperation({ summary: 'App 活动考勤责任人分页查看 GPS 打卡证据 [auth]' })
  @ApiWrappedPageResponse(AppManagedActivityCheckInDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async listCheckIns(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedAttendanceActivityParamsDto,
    @Query() query: AppManagedActivityCheckInsQueryDto,
  ): Promise<PageResultDto<AppManagedActivityCheckInDto>> {
    await this.assertAppAccess(user);
    return this.service.listCheckIns(params.activityId, query, user);
  }

  @Get('attendance-sheet-draft')
  @ApiOperation({ summary: 'App 活动考勤责任人生成考勤提交草稿（只读不落库） [auth]' })
  @ApiWrappedOkResponse(AppManagedAttendanceSheetDraftDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async draft(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedAttendanceActivityParamsDto,
  ): Promise<AppManagedAttendanceSheetDraftDto> {
    await this.assertAppAccess(user);
    return this.service.attendanceSheetDraft(params.activityId, user);
  }

  @Get('attendance-sheets')
  @ApiOperation({ summary: 'App 活动考勤责任人查看考勤单列表 [auth]' })
  @ApiWrappedPageResponse(AppManagedAttendanceSheetListItemDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async listSheets(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedAttendanceActivityParamsDto,
    @Query() query: AppManagedAttendanceSheetsQueryDto,
    @Req() req: Request,
  ): Promise<PageResultDto<AppManagedAttendanceSheetListItemDto>> {
    await this.assertAppAccess(user);
    return this.service.listSheets(params.activityId, query, user, this.auditMeta(req));
  }

  @Post('attendance-sheets')
  @ApiOperation({ summary: 'App 活动考勤责任人提交考勤单 [auth]' })
  @ApiWrappedCreatedResponse(AppManagedAttendanceSheetDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async submit(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedAttendanceActivityParamsDto,
    @Body() dto: CreateAppManagedAttendanceSheetDto,
    @Req() req: Request,
  ): Promise<AppManagedAttendanceSheetDto> {
    await this.assertAppAccess(user);
    return this.service.submit(params.activityId, dto, user, this.auditMeta(req));
  }

  @Get('attendance-sheets/:sheetId')
  @ApiOperation({ summary: 'App 活动考勤责任人查看考勤单与 records 详情 [auth]' })
  @ApiWrappedOkResponse(AppManagedAttendanceSheetDetailDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
  )
  async detail(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedAttendanceSheetParamsDto,
    @Req() req: Request,
  ): Promise<AppManagedAttendanceSheetDetailDto> {
    await this.assertAppAccess(user);
    return this.service.detail(params.activityId, params.sheetId, user, this.auditMeta(req));
  }

  @Patch('attendance-sheets/:sheetId')
  @ApiOperation({ summary: 'App 活动考勤责任人编辑 pending 或 returned 考勤单 [auth]' })
  @ApiWrappedOkResponse(AppManagedAttendanceSheetDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
    BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
  )
  async edit(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedAttendanceSheetParamsDto,
    @Body() dto: UpdateAppManagedAttendanceSheetDto,
    @Req() req: Request,
  ): Promise<AppManagedAttendanceSheetDto> {
    await this.assertAppAccess(user);
    return this.service.edit(params.activityId, params.sheetId, dto, user, this.auditMeta(req));
  }

  @Delete('attendance-sheets/:sheetId')
  @ApiOperation({ summary: 'App 活动考勤责任人软删 pending 考勤单 [auth]' })
  @ApiWrappedOkResponse(AppManagedAttendanceSheetDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
    BizCode.ATTENDANCE_SHEET_STATUS_INVALID,
  )
  async softDelete(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedAttendanceSheetParamsDto,
    @Req() req: Request,
  ): Promise<AppManagedAttendanceSheetDto> {
    await this.assertAppAccess(user);
    return this.service.softDelete(params.activityId, params.sheetId, user, this.auditMeta(req));
  }

  @Post('attendance-sheets/:sheetId/resubmit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 活动考勤责任人重提 returned 考勤单 [auth]' })
  @ApiWrappedOkResponse(AppManagedAttendanceSheetDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ATTENDANCE_SHEET_NOT_FOUND,
    BizCode.ATTENDANCE_SHEET_RESUBMIT_STATUS_INVALID,
  )
  async resubmit(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedAttendanceSheetParamsDto,
    @Body() dto: ResubmitAppManagedAttendanceSheetDto,
    @Req() req: Request,
  ): Promise<AppManagedAttendanceSheetDto> {
    await this.assertAppAccess(user);
    return this.service.resubmit(params.activityId, params.sheetId, dto, user, this.auditMeta(req));
  }

  private async assertAppAccess(user: CurrentUserPayload): Promise<void> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);
  }

  private auditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
