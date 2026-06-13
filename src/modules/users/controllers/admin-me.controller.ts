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
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import { BizException } from '../../../common/exceptions/biz.exception';
import { AdminMeResponseDto } from '../dto/admin/admin-me-response.dto';
import { UsersService } from '../users.service';

// Admin surface 本人身份只读端点(GET /api/admin/v1/me;2026-06-14)。
// 管理后台登录后显示当前管理员昵称/头像/角色的 canonical 身份 bootstrap。
//
// 镜像 app-me.controller.ts 的位置范式(controllers/ 子目录)与 getMe 拼装范式,但物理隔离:
// **单一** @ApiTags('Admin - Me')(非 Mixed Controller)+ 独立 @Controller('admin/v1/me'),
// 不复用 AppMeController / AppMeResponseDto(沿 api-surface-policy §2.1 四 surface DTO 不派生)。
//
// 准入(沿 goal D3,对齐 rbac/me/permissions):入口仅全局 JwtAuthGuard,**不**挂 @Roles;
// service 内**不**做 rbac.can() / role 判定——任意登录用户只返本人无越权面。
// 单一职责(沿 goal D2):只返身份 9 字段,**不**内联角色/权限——
// 权限仍走 GET /api/system/v1/rbac/me/permissions(api-surface-policy §9.4)。
@ApiTags('Admin - Me')
@ApiBearerAuth()
@Controller('admin/v1/me')
export class AdminMeController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({
    summary:
      'Admin 视角本人身份摘要(只读 bootstrap;不内联角色/权限——权限走 rbac/me/permissions) [auth]',
  })
  @ApiWrappedOkResponse(AdminMeResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED)
  async getMe(@CurrentUser() currentUser: CurrentUserPayload): Promise<AdminMeResponseDto> {
    const user = await this.usersService.getMyAdminIdentity(currentUser);

    // JwtStrategy 已挡 status!=ACTIVE / deletedAt!=null;此处仅兜底并发软删窗口
    // (逐字镜像 app-me.controller.ts:81)
    if (user === null) {
      throw new BizException(BizCode.UNAUTHORIZED);
    }

    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      nickname: user.nickname,
      avatarKey: user.avatarKey,
      role: user.role,
      status: user.status,
      lastLoginAt: user.lastLoginAt === null ? null : user.lastLoginAt.toISOString(),
      memberId: user.memberId,
    };
  }
}
