import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { EffectiveRoleDto, MyPermissionsResponseDto } from './rbac.dto';
import { RbacService } from './rbac.service';

// V2.x C-6 RBAC 实施 PR #6:RBAC 判权能力对外接口。
// 沿 D7 v1.1 §5.1 端点 15 + §5.3 详解。
//
// 1 个端点(本 PR):
//   GET /api/v2/rbac/me/permissions    当前用户的有效权限点集 + 业务角色摘要
//
// **权限标注**(沿 D7 §5.3):任何登录用户(USER / ADMIN / SUPER_ADMIN)均可访问。
// 入口 Guard `@Roles(USER, ADMIN, SUPER_ADMIN)`,Service 内部不再判权
// (me/permissions 是"返自己的有什么",不涉及业务资源访问)。
//
// **不实施**(留后续 PR):
// - POST /api/v2/rbac/reload(端点 16)→ 留 PR #7
// - GET /api/v2/users/:userId/permissions(管理员查他人)→ 非 D7 §5.1 端点,不实施

@ApiTags('rbac')
@ApiBearerAuth()
@ApiExtraModels(MyPermissionsResponseDto, EffectiveRoleDto)
@Controller('v2/rbac')
export class RbacController {
  constructor(private readonly service: RbacService) {}

  @Get('me/permissions')
  @Roles(Role.USER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      '查当前用户的有效权限点集 + 业务角色摘要(SUPER_ADMIN 返 Permission.code 全集;沿 D7 v1.1 §5.3)',
  })
  @ApiWrappedOkResponse(MyPermissionsResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  getMyPermissions(@CurrentUser() user: CurrentUserPayload): Promise<MyPermissionsResponseDto> {
    return this.service.getMyPermissions(user);
  }
}
