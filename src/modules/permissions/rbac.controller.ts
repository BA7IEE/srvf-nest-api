import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  EffectiveRoleDto,
  MyPermissionsResponseDto,
  ReloadRbacDto,
  ReloadRbacResponseDto,
} from './rbac.dto';
import { RbacService } from './rbac.service';

// V2.x C-6 RBAC 实施 PR #6 + PR #7:RBAC 判权能力对外接口。
// 沿 D7 v1.1 §5.1 端点 15-16 + §5.3 + §5.4 详解。
//
// 2 个端点(累计):
//   GET  /api/v2/rbac/me/permissions    当前用户的有效权限点集 + 业务角色摘要 (PR #6)
//   POST /api/v2/rbac/reload            触发 RBAC 缓存失效 (PR #7;沿 D7 §5.4)
//
// **权限标注**(P0-F PR-1,2026-05-18):入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`。
// - GET /me/permissions:任何登录用户(沿 D7 §5.3;RBAC 元接口里**唯一**无 RBAC permission 要求的)
// - POST /reload:RbacService.reload 入口判权 `rbac.config.reload`,失败抛 30100。

@ApiTags('rbac')
@ApiBearerAuth()
@ApiExtraModels(MyPermissionsResponseDto, EffectiveRoleDto, ReloadRbacResponseDto)
@Controller('v2/rbac')
export class RbacController {
  constructor(private readonly service: RbacService) {}

  @Get('me/permissions')
  @ApiOperation({
    summary:
      '查当前用户的有效权限点集 + 业务角色摘要(SUPER_ADMIN 返 Permission.code 全集;沿 D7 v1.1 §5.3)',
  })
  @ApiWrappedOkResponse(MyPermissionsResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED)
  getMyPermissions(@CurrentUser() user: CurrentUserPayload): Promise<MyPermissionsResponseDto> {
    return this.service.getMyPermissions(user);
  }

  @Post('reload')
  // POST 默认 201,这里 reload 是"清缓存动作"(无资源创建),沿 v1 / V2 同类动作端点
  // (verify / approve / publish / cancel 等)统一用 HTTP 200
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '触发 RBAC 缓存失效(沿 D7 v1.1 §5.4 + F4 v1.0 三档 scope:all / user(+userId) / role(+roleId))',
  })
  @ApiWrappedOkResponse(ReloadRbacResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  reload(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: ReloadRbacDto,
  ): Promise<ReloadRbacResponseDto> {
    return this.service.reload(user, dto);
  }
}
