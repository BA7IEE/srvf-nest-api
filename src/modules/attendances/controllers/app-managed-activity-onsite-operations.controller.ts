import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Param,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { LoginScoped } from '../../../common/decorators/route-authz.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { AttendancePunchCommandService } from '../attendance-punch-command.service';
import { AttendanceOnsiteBatchJobService } from '../attendance-onsite-batch-job.service';
import { AttendanceImportPreviewService } from '../attendance-import-preview.service';
import { AppActivityPunchReceiptDto } from '../dto/app/app-activity-punch.dto';
import { AppManagedOnsiteSessionParamsDto } from '../dto/app/app-managed-onsite-punch.dto';
import {
  AppManagedProxyPunchDto,
  AppManagedBulkPunchJobDto,
  AppManagedImportPreviewFormDto,
  AppManagedImportExecuteDto,
  AppManagedImportPreviewDto,
  AppManagedImportPreviewParamsDto,
  AppManagedImportPreviewQueryDto,
  AppManagedOnsiteBatchJobParamsDto,
  AppManagedOnsiteBatchJobReceiptDto,
  AppManagedStaffScanDto,
} from '../dto/app/app-managed-onsite-operations.dto';

type MultipartImportFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

const IMPORT_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

@Catch(PayloadTooLargeException)
class ImportPreviewFileSizeFilter implements ExceptionFilter<PayloadTooLargeException> {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(BizCode.ATTACHMENT_SIZE_EXCEEDED.httpStatus).json({
      code: BizCode.ATTACHMENT_SIZE_EXCEEDED.code,
      message: BizCode.ATTACHMENT_SIZE_EXCEEDED.message,
      data: null,
    });
  }
}

@ApiTags('Mobile - Managed Activity Onsite Operations')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities/:activityId/onsite')
export class AppManagedActivityOnsiteOperationsController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly command: AttendancePunchCommandService,
    private readonly batchJobs: AttendanceOnsiteBatchJobService,
    private readonly importPreviews: AttendanceImportPreviewService,
  ) {}

  @Post('sessions/:sessionId/staff-scan')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '考勤责任人以受控人工确认追加工作人员现场签到/签退事实 [auth]' })
  @ApiWrappedCreatedResponse(AppActivityPunchReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ATTENDANCE_REGISTRATION_INVALID,
    BizCode.ATTENDANCE_QR_NOT_FOUND,
    BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT,
    BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW,
    BizCode.ATTENDANCE_PUNCH_LOCATION_REQUIRED,
    BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE,
    BizCode.ATTENDANCE_PUNCH_OPEN_SEGMENT_EXISTS,
    BizCode.ATTENDANCE_PUNCH_CHECK_OUT_REQUIRES_OPEN_SEGMENT,
    BizCode.ATTENDANCE_PUNCH_MIN_DURATION_NOT_REACHED,
  )
  async staffScan(
    @Param() params: AppManagedOnsiteSessionParamsDto,
    @Body() dto: AppManagedStaffScanDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppActivityPunchReceiptDto> {
    await this.assertAppAccess(user);
    const hasManualConfirmation = dto.manualConfirmation !== undefined;
    const hasMemberCredential = dto.memberCredential !== undefined;
    if (hasManualConfirmation === hasMemberCredential) throw new BizException(BizCode.BAD_REQUEST);
    return this.command.managedPunch({
      activityId: params.activityId,
      sessionId: params.sessionId,
      participationIdentityId: dto.manualConfirmation?.participationIdentityId ?? null,
      memberCredential: dto.memberCredential ?? null,
      actionCode: dto.actionCode,
      sourceCode: 'staff_scan',
      eventKey: dto.eventKey,
      reason: dto.manualConfirmation?.reason ?? null,
      deviceId: null,
      longitude: dto.location?.longitude ?? null,
      latitude: dto.location?.latitude ?? null,
      accuracy: dto.location?.accuracy ?? null,
      currentUser: user,
      auditMeta: this.auditMeta(req),
    });
  }

  @Post('sessions/:sessionId/proxy-punch')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '考勤责任人以明确原因代为追加单人现场签到/签退事实 [auth]' })
  @ApiWrappedCreatedResponse(AppActivityPunchReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ATTENDANCE_REGISTRATION_INVALID,
    BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT,
    BizCode.ATTENDANCE_PUNCH_OUTSIDE_WINDOW,
    BizCode.ATTENDANCE_PUNCH_LOCATION_REQUIRED,
    BizCode.ATTENDANCE_PUNCH_LOCATION_OUT_OF_RANGE,
    BizCode.ATTENDANCE_PUNCH_OPEN_SEGMENT_EXISTS,
    BizCode.ATTENDANCE_PUNCH_CHECK_OUT_REQUIRES_OPEN_SEGMENT,
    BizCode.ATTENDANCE_PUNCH_MIN_DURATION_NOT_REACHED,
  )
  async proxyPunch(
    @Param() params: AppManagedOnsiteSessionParamsDto,
    @Body() dto: AppManagedProxyPunchDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppActivityPunchReceiptDto> {
    await this.assertAppAccess(user);
    return this.command.managedPunch({
      activityId: params.activityId,
      sessionId: params.sessionId,
      participationIdentityId: dto.participationIdentityId,
      memberCredential: null,
      actionCode: dto.actionCode,
      sourceCode: 'proxy',
      eventKey: dto.eventKey,
      reason: dto.reason,
      deviceId: null,
      longitude: dto.location?.longitude ?? null,
      latitude: dto.location?.latitude ?? null,
      accuracy: dto.location?.accuracy ?? null,
      currentUser: user,
      auditMeta: this.auditMeta(req),
    });
  }

  @Post('sessions/:sessionId/bulk-punch-jobs')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '考勤责任人创建可重放的现场批量代签任务 [auth]' })
  @ApiWrappedCreatedResponse(AppManagedOnsiteBatchJobReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ATTENDANCE_REGISTRATION_INVALID,
    BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT,
  )
  async createBulkPunchJob(
    @Param() params: AppManagedOnsiteSessionParamsDto,
    @Body() dto: AppManagedBulkPunchJobDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppManagedOnsiteBatchJobReceiptDto> {
    await this.assertAppAccess(user);
    return this.batchJobs.createBulkPunchJob(
      {
        activityId: params.activityId,
        sessionId: params.sessionId,
        operationKey: dto.operationKey,
        actionCode: dto.actionCode,
        reason: dto.reason,
        participationIdentityIds: dto.participationIdentityIds,
        longitude: dto.location?.longitude ?? null,
        latitude: dto.location?.latitude ?? null,
        accuracy: dto.location?.accuracy ?? null,
      },
      user,
      this.auditMeta(req),
    );
  }

  @Post('sessions/:sessionId/import-previews')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @UseFilters(ImportPreviewFileSizeFilter)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: IMPORT_PREVIEW_MAX_BYTES + 1, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['operationKey', 'reason', 'file'],
      properties: {
        operationKey: {
          type: 'string',
          minLength: 1,
          maxLength: 96,
          pattern: '^[A-Za-z0-9_-]+$',
        },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
        file: { type: 'string', format: 'binary', description: 'UTF-8 CSV，最大 10 MiB' },
      },
    },
  })
  @ApiOperation({ summary: '考勤责任人上传并冻结 CSV 现场导入预览 [auth]' })
  @ApiWrappedCreatedResponse(AppManagedOnsiteBatchJobReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ATTENDANCE_REGISTRATION_INVALID,
    BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT,
    BizCode.ATTACHMENT_MIME_NOT_ALLOWED,
    BizCode.ATTACHMENT_SIZE_EXCEEDED,
    BizCode.ATTACHMENT_PII_DETECTED,
    BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING,
  )
  async createImportPreview(
    @Param() params: AppManagedOnsiteSessionParamsDto,
    @Body() dto: AppManagedImportPreviewFormDto,
    @UploadedFile() file: MultipartImportFile | undefined,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppManagedOnsiteBatchJobReceiptDto> {
    if (file === undefined) throw new BizException(BizCode.BAD_REQUEST);
    await this.assertAppAccess(user);
    return this.importPreviews.createPreview(
      {
        activityId: params.activityId,
        sessionId: params.sessionId,
        operationKey: dto.operationKey,
        reason: dto.reason,
        file: {
          originalName: file.originalname,
          mime: file.mimetype,
          size: file.size,
          buffer: file.buffer,
        },
      },
      user,
      this.auditMeta(req),
    );
  }

  @Post('import-previews/:previewId/execute')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '考勤责任人按已冻结摘要排队执行 CSV 现场导入 [auth]' })
  @ApiWrappedCreatedResponse(AppManagedOnsiteBatchJobReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ATTENDANCE_PUNCH_IDEMPOTENCY_CONFLICT,
    BizCode.ATTENDANCE_IMPORT_PREVIEW_MISMATCH,
    BizCode.ATTACHMENT_STORAGE_OPERATION_PENDING,
  )
  async executeImportPreview(
    @Param() params: AppManagedImportPreviewParamsDto,
    @Body() dto: AppManagedImportExecuteDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppManagedOnsiteBatchJobReceiptDto> {
    await this.assertAppAccess(user);
    return this.importPreviews.executePreview(
      {
        activityId: params.activityId,
        previewId: params.previewId,
        operationKey: dto.operationKey,
        fileDigest: dto.fileDigest,
        parserVersion: dto.parserVersion,
        previewHash: dto.previewHash,
      },
      user,
      this.auditMeta(req),
    );
  }

  @Get('import-previews/:previewId')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '读取负责人可见的 CSV 导入预览安全摘要与分页行状态 [auth]' })
  @ApiWrappedOkResponse(AppManagedImportPreviewDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
  )
  async getImportPreview(
    @Param() params: AppManagedImportPreviewParamsDto,
    @Query() query: AppManagedImportPreviewQueryDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AppManagedImportPreviewDto> {
    await this.assertAppAccess(user);
    return this.importPreviews.getPreview({
      activityId: params.activityId,
      previewId: params.previewId,
      page: query.page,
      pageSize: query.pageSize,
      currentUser: user,
    });
  }

  @Get('bulk-punch-jobs/:jobId')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: '读取负责人可见的现场批量代签任务安全进度 [auth]' })
  @ApiWrappedOkResponse(AppManagedOnsiteBatchJobReceiptDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
  )
  async getBulkPunchJob(
    @Param() params: AppManagedOnsiteBatchJobParamsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AppManagedOnsiteBatchJobReceiptDto> {
    await this.assertAppAccess(user);
    return this.batchJobs.getBulkPunchJob({
      activityId: params.activityId,
      jobId: params.jobId,
      currentUser: user,
    });
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
