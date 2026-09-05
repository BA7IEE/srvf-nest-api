import { Body, Controller, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedCreatedResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { LoginScoped, RequiresPermission } from '../../../common/decorators/route-authz.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { ActivityCreationService } from '../activity-creation.service';
import {
  mapQuickCreation,
  mapProfessionalCreation,
  mapEmergencyCreation,
} from '../activity-creation-command';
import {
  AppQuickActivityCreationDto,
  AppEmergencyActivityCreationDto,
  AppActivityCreationResultDto,
} from '../dto/app/app-managed-activity-creation.dto';
import { AppProfessionalActivityCreationDto } from '../dto/app/app-managed-activity-creation-professional.dto';

@ApiTags('Mobile - Managed Activities')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities')
export class AppManagedActivityCreationController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly service: ActivityCreationService,
  ) {}

  @Post('from-template')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @RequiresPermission(
    'activity.create.record',
    'activity.create.cross-org',
    'activity-responsibility.override.record',
  )
  @ApiOperation({ summary: 'App 从精确模板创建草稿（含地点快照、幂等） [auth]' })
  @ApiWrappedCreatedResponse(AppActivityCreationResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_CREATE_FROM_TEMPLATE_OPERATION_KEY_CONFLICT,
    BizCode.ACTIVITY_CONTROL_PLANE_UNAVAILABLE,
  )
  async quick(
    @Body() dto: AppQuickActivityCreationDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppActivityCreationResultDto> {
    await this.assertAppMember(user);
    return this.service.createQuick(mapQuickCreation(dto), user, this.auditMeta(req));
  }

  @Post('professional')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @RequiresPermission(
    'activity.create.record',
    'activity.create.cross-org',
    'activity-responsibility.override.record',
  )
  @ApiOperation({ summary: 'App 原子创建专业活动草稿（场次、岗位、地点、表单、资格） [auth]' })
  @ApiWrappedCreatedResponse(AppActivityCreationResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_CONTROL_PLANE_UNAVAILABLE,
  )
  async professional(
    @Body() dto: AppProfessionalActivityCreationDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppActivityCreationResultDto> {
    await this.assertAppMember(user);
    return this.service.createProfessional(mapProfessionalCreation(dto), user, this.auditMeta(req));
  }

  @Post('emergency')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['responsibility'],
    engine: 'authz-scoped',
  })
  @RequiresPermission(
    'activity.create.record',
    'activity.create.emergency.record',
    'activity.create.cross-org',
    'activity-responsibility.override.record',
  )
  @ApiOperation({ summary: 'App 创建紧急草稿并冻结呼叫受众（不正式发布） [auth]' })
  @ApiWrappedCreatedResponse(AppActivityCreationResultDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.FORBIDDEN,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ACTIVITY_STATUS_INVALID,
    BizCode.ACTIVITY_CONTROL_PLANE_UNAVAILABLE,
  )
  async emergency(
    @Body() dto: AppEmergencyActivityCreationDto,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<AppActivityCreationResultDto> {
    await this.assertAppMember(user);
    return this.service.createEmergency(mapEmergencyCreation(dto), user, this.auditMeta(req));
  }

  private async assertAppMember(user: CurrentUserPayload): Promise<void> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);
  }

  private auditMeta(req: Request) {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
