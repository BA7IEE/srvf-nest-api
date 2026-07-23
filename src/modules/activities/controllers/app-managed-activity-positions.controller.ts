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
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
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
import type {
  CreateActivityPositionDto,
  UpdateActivityPositionDto,
} from '../activity-positions.dto';
import {
  AppManagedActivityParamsDto,
  AppManagedActivityPositionDto,
  AppManagedActivityPositionParamsDto,
  CreateAppManagedActivityPositionDto,
  UpdateAppManagedActivityPositionDto,
} from '../dto/app/app-managed-activity.dto';

@ApiTags('Mobile - Managed Activity Positions')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities/:activityId/positions')
export class AppManagedActivityPositionsController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly service: AppManagedActivitiesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'App 查看我管理活动的岗位 [auth]' })
  @ApiWrappedArrayResponse(AppManagedActivityPositionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
  ): Promise<AppManagedActivityPositionDto[]> {
    return this.service.listPositions(params.activityId, await this.resolveMemberId(user));
  }

  @Post()
  @ApiOperation({ summary: 'App 发起人为 draft 活动新增岗位 [auth]' })
  @ApiWrappedCreatedResponse(AppManagedActivityPositionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_NOT_FOUND,
    BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING,
  )
  async create(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityParamsDto,
    @Body() dto: CreateAppManagedActivityPositionDto,
    @Req() req: Request,
  ): Promise<AppManagedActivityPositionDto> {
    await this.resolveMemberId(user);
    return this.service.createPosition(
      params.activityId,
      this.toCreateDto(dto),
      user,
      this.auditMeta(req),
    );
  }

  @Patch(':activityPositionId')
  @ApiOperation({ summary: 'App 发起人修改 draft 活动岗位 [auth]' })
  @ApiWrappedOkResponse(AppManagedActivityPositionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_POSITION_NOT_FOUND,
    BizCode.ACTIVITY_PUBLISH_REVIEW_PENDING,
  )
  async update(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityPositionParamsDto,
    @Body() dto: UpdateAppManagedActivityPositionDto,
    @Req() req: Request,
  ): Promise<AppManagedActivityPositionDto> {
    await this.resolveMemberId(user);
    return this.service.updatePosition(
      params.activityId,
      params.activityPositionId,
      this.toUpdateDto(dto),
      user,
      this.auditMeta(req),
    );
  }

  @Delete(':activityPositionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'App 发起人删除 draft 活动岗位 [auth]' })
  @ApiWrappedOkResponse(AppManagedActivityPositionDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ACTIVITY_POSITION_NOT_FOUND,
    BizCode.ACTIVITY_POSITION_HAS_ACTIVE_REGISTRATIONS,
  )
  async softDelete(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: AppManagedActivityPositionParamsDto,
    @Req() req: Request,
  ): Promise<AppManagedActivityPositionDto> {
    await this.resolveMemberId(user);
    return this.service.deletePosition(
      params.activityId,
      params.activityPositionId,
      user,
      this.auditMeta(req),
    );
  }

  private auditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

  private async resolveMemberId(user: CurrentUserPayload): Promise<string> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);
    return access.member.id;
  }

  private toCreateDto(dto: CreateAppManagedActivityPositionDto): CreateActivityPositionDto {
    return {
      name: dto.name,
      attendanceRoleCode: dto.attendanceRoleCode,
      ...(dto.capacity === undefined ? {} : { capacity: dto.capacity }),
      ...(dto.startAt === undefined ? {} : { startAt: dto.startAt }),
      ...(dto.endAt === undefined ? {} : { endAt: dto.endAt }),
      ...(dto.genderRequirementCode === undefined
        ? {}
        : { genderRequirementCode: dto.genderRequirementCode }),
      ...(dto.description === undefined ? {} : { description: dto.description }),
      ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }),
    };
  }

  private toUpdateDto(dto: UpdateAppManagedActivityPositionDto): UpdateActivityPositionDto {
    return {
      ...(dto.name === undefined ? {} : { name: dto.name }),
      ...(dto.attendanceRoleCode === undefined
        ? {}
        : { attendanceRoleCode: dto.attendanceRoleCode }),
      ...(dto.capacity === undefined ? {} : { capacity: dto.capacity }),
      ...(dto.startAt === undefined ? {} : { startAt: dto.startAt }),
      ...(dto.endAt === undefined ? {} : { endAt: dto.endAt }),
      ...(dto.genderRequirementCode === undefined
        ? {}
        : { genderRequirementCode: dto.genderRequirementCode }),
      ...(dto.description === undefined ? {} : { description: dto.description }),
      ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }),
    };
  }
}
