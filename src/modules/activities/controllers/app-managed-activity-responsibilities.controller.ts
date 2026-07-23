import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { AppManagedActivitiesService } from '../app-managed-activities.service';
import {
  AppCollaboratorOptionsResponseDto,
  AppManagedActivityAssignmentParamsDto,
  AppManagedActivityParamsDto,
  AppManagedResponsibilitiesDto,
  AppManagedResponsibilityAssignmentDto,
  CreateAppManagedCollaboratorDto,
  TransferAppManagedActivityOwnerDto,
} from '../dto/app/app-managed-activity.dto';

@ApiTags('Mobile - Managed Activity Responsibilities')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities/:activityId')
export class AppManagedActivityResponsibilitiesController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly service: AppManagedActivitiesService,
  ) {}

  @Get('responsibilities')
  @ApiOperation({ summary: 'App 查看我管理活动的负责人和协办人 [auth]' })
  @ApiWrappedOkResponse(AppManagedResponsibilitiesDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
  ): Promise<AppManagedResponsibilitiesDto> {
    return this.service.listResponsibilities(params.activityId, await this.resolveMemberId(user));
  }

  @Get('collaborator-options')
  @ApiOperation({ summary: 'App 获取本活动可选协办人（到场者或活动组织有效成员） [auth]' })
  @ApiWrappedOkResponse(AppCollaboratorOptionsResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async collaboratorOptions(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
  ): Promise<AppCollaboratorOptionsResponseDto> {
    return this.service.collaboratorOptions(params.activityId, await this.resolveMemberId(user));
  }

  @Post('collaborators')
  @ApiOperation({ summary: 'App 活动负责人新增协办人 [auth]' })
  @ApiWrappedCreatedResponse(AppManagedResponsibilityAssignmentDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS,
    BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID,
  )
  async addCollaborator(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: CreateAppManagedCollaboratorDto,
    @Req() req: Request,
  ): Promise<AppManagedResponsibilityAssignmentDto> {
    await this.resolveMemberId(user);
    return this.service.addCollaborator(
      params.activityId,
      {
        memberId: dto.memberId,
        canManageRegistrations: dto.canManageRegistrations,
        canManageAttendance: dto.canManageAttendance,
        ...(dto.reason === undefined ? {} : { reason: dto.reason }),
      },
      user,
      this.auditMeta(req),
    );
  }

  @Delete('collaborators/:assignmentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 活动负责人结束协办职责 [auth]' })
  @ApiWrappedOkResponse(AppManagedResponsibilityAssignmentDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_RESPONSIBILITY_NOT_FOUND,
  )
  async endCollaborator(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityAssignmentParamsDto,
    @Req() req: Request,
  ): Promise<AppManagedResponsibilityAssignmentDto> {
    await this.resolveMemberId(user);
    return this.service.endCollaborator(
      params.activityId,
      params.assignmentId,
      user,
      this.auditMeta(req),
    );
  }

  @Post('transfer-owner')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 活动负责人移交责任并原子切换授权 [auth]' })
  @ApiWrappedOkResponse(AppManagedResponsibilitiesDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_LEGACY_OWNER_REQUIRED,
    BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID,
  )
  async transferOwner(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: TransferAppManagedActivityOwnerDto,
    @Req() req: Request,
  ): Promise<AppManagedResponsibilitiesDto> {
    await this.resolveMemberId(user);
    return this.service.transferOwner(
      params.activityId,
      {
        newOwnerMemberId: dto.newOwnerMemberId,
        reason: dto.reason,
        retainPreviousOwnerAsCollaborator: dto.retainPreviousOwnerAsCollaborator,
      },
      user,
      this.auditMeta(req),
    );
  }

  private async resolveMemberId(user: CurrentUserPayload): Promise<string> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);
    return access.member.id;
  }

  private auditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
