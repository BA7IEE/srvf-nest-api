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
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import {
  ActivityResponsibilitiesResponseDto,
  ActivityResponsibilityAssignmentDto,
  ActivityResponsibilityAssignmentParamsDto,
  ActivityResponsibilityParamsDto,
  AssignLegacyActivityInitiatorDto,
  ClaimLegacyActivityDto,
  CreateActivityCollaboratorDto,
  TransferActivityOwnerDto,
} from '../activity-responsibility.dto';
import { ActivityResponsibilityService } from '../activity-responsibility.service';

@ApiTags('Admin - Activity Responsibilities')
@ApiBearerAuth()
@Controller('admin/v1/activities/:activityId/responsibilities')
export class AdminActivityResponsibilitiesController {
  constructor(private readonly service: ActivityResponsibilityService) {}

  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  @Get()
  @ApiOperation({
    summary: '查看活动当前负责人和协办人 [rbac: activity-responsibility.override.record]',
  })
  @ApiWrappedOkResponse(ActivityResponsibilitiesResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  list(
    @Param() params: ActivityResponsibilityParamsDto,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<ActivityResponsibilitiesResponseDto> {
    return this.service.list(params.activityId, user);
  }

  @Post('collaborators')
  @ApiOperation({
    summary:
      '新增活动协办人(owner 或 override；至少一项管理能力) [rbac: activity-responsibility.override.record]',
  })
  @ApiWrappedCreatedResponse(ActivityResponsibilityAssignmentDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS,
    BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID,
  )
  addCollaborator(
    @Param() params: ActivityResponsibilityParamsDto,
    @Body() dto: CreateActivityCollaboratorDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponsibilityAssignmentDto> {
    return this.service.addCollaborator(params.activityId, dto, user, this.buildAuditMeta(req));
  }

  @Delete('collaborators/:assignmentId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '结束活动协办职责并同步摘除 scoped RoleBinding [rbac: activity-responsibility.override.record]',
  })
  @ApiWrappedOkResponse(ActivityResponsibilityAssignmentDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_RESPONSIBILITY_NOT_FOUND,
  )
  endCollaborator(
    @Param() params: ActivityResponsibilityAssignmentParamsDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponsibilityAssignmentDto> {
    return this.service.endCollaborator(
      params.activityId,
      params.assignmentId,
      user,
      this.buildAuditMeta(req),
    );
  }

  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '移交活动负责人并原子切换 scoped RoleBinding [rbac: activity-responsibility.override.record]',
  })
  @ApiWrappedOkResponse(ActivityResponsibilitiesResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_LEGACY_OWNER_REQUIRED,
    BizCode.ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS,
    BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID,
  )
  transfer(
    @Param() params: ActivityResponsibilityParamsDto,
    @Body() dto: TransferActivityOwnerDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponsibilitiesResponseDto> {
    return this.service.transferOwner(params.activityId, dto, user, this.buildAuditMeta(req));
  }

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '为 legacy published 活动认领当前负责人 [rbac: activity-responsibility.override.record]',
  })
  @ApiWrappedOkResponse(ActivityResponsibilityAssignmentDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS,
    BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID,
  )
  claim(
    @Param() params: ActivityResponsibilityParamsDto,
    @Body() dto: ClaimLegacyActivityDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponsibilityAssignmentDto> {
    return this.service.claimLegacy(params.activityId, dto, user, this.buildAuditMeta(req));
  }

  @Post('assign-initiator')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '为 legacy draft 活动补录正式发起人 [rbac: activity-responsibility.override.record]',
  })
  @ApiWrappedOkResponse(ActivityResponsibilitiesResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS,
    BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID,
  )
  assignInitiator(
    @Param() params: ActivityResponsibilityParamsDto,
    @Body() dto: AssignLegacyActivityInitiatorDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<ActivityResponsibilitiesResponseDto> {
    return this.service.assignLegacyInitiator(
      params.activityId,
      dto,
      user,
      this.buildAuditMeta(req),
    );
  }
}
