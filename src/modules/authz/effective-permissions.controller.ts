import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { AuthzService } from './authz.service';
import { EffectivePermissionsResponseDto } from './effective-permissions.dto';

// v0.49 前端有效权限出口:独立 System Controller,不混入 Admin AuthzController,
// 也不改既有 system/v1/rbac/me/permissions 的 GLOBAL USER-binding 语义。
@ApiTags('Ops - Authz')
@ApiBearerAuth()
@Controller('system/v1/authz')
export class EffectivePermissionsController {
  constructor(private readonly authz: AuthzService) {}

  @Get('me/effective-permissions')
  @ApiOperation({
    summary:
      '查当前用户三源授权合并后的有效权限码(直接绑定 + 职务策略 + 分管;SUPER_ADMIN 返全集) [auth]',
  })
  @ApiWrappedOkResponse(EffectivePermissionsResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED)
  async getEffectivePermissions(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<EffectivePermissionsResponseDto> {
    return { permissions: await this.authz.getEffectivePermissionCodes(user) };
  }
}
