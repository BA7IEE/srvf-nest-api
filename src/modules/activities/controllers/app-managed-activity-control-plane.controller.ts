import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { LoginScoped } from '../../../common/decorators/route-authz.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import { AppIdentityResolver } from '../../users/app-identity.resolver';
import { ActivityControlPlaneGate } from '../activity-control-plane.gate';
import { AppActivityControlPlaneStatusDto } from '../dto/app/app-managed-activity-control-plane.dto';

@ApiTags('Mobile - Managed Activities')
@ApiBearerAuth()
@Controller('app/v1/my/managed-activities/control-plane')
export class AppManagedActivityControlPlaneController {
  constructor(
    private readonly identity: AppIdentityResolver,
    private readonly gate: ActivityControlPlaneGate,
  ) {}

  @Get('status')
  @LoginScoped({ admission: 'app-member', require: 'all', engine: 'none' })
  @ApiOperation({ summary: 'App 新创建控制面状态（非创建权限证明） [auth]' })
  @ApiWrappedOkResponse(AppActivityControlPlaneStatusDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  async status(@CurrentUser() user: CurrentUserPayload): Promise<AppActivityControlPlaneStatusDto> {
    const access = await this.identity.resolve(user);
    if (!access.canUseApp || !access.member) throw new BizException(BizCode.FORBIDDEN);
    return this.gate.status();
  }
}
