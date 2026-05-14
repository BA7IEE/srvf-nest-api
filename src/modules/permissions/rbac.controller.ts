import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
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
// **权限标注**:
// - GET /me/permissions:任何登录用户(USER / ADMIN / SUPER_ADMIN);D7 §5.3 锁定
// - POST /reload:沿用户拍板,本 PR 入口 `@Roles(SUPER_ADMIN, ADMIN)`;
//   D7 §5.4 描述的 `rbac.config.reload` 权限点接入 留后续 PR(seed + 业务模块判权)
//
// **不实施**(沿用户拍板任务边界):
// - GET /api/v2/users/:userId/permissions(管理员查他人)→ 非 D7 §5.1 端点,不实施
// - 14 个 RBAC CRUD 端点接入 `rbac.can()` → 留 seed PR #8 后另起 PR

@ApiTags('rbac')
@ApiBearerAuth()
@ApiExtraModels(MyPermissionsResponseDto, EffectiveRoleDto, ReloadRbacResponseDto)
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

  @Post('reload')
  // POST 默认 201,这里 reload 是"清缓存动作"(无资源创建),沿 v1 / V2 同类动作端点
  // (verify / approve / publish / cancel 等)统一用 HTTP 200
  @HttpCode(HttpStatus.OK)
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '触发 RBAC 缓存失效(沿 D7 v1.1 §5.4 + F4 v1.0 三档 scope:all / user(+userId) / role(+roleId))',
  })
  @ApiWrappedOkResponse(ReloadRbacResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  reload(@Body() dto: ReloadRbacDto): Promise<ReloadRbacResponseDto> {
    return this.service.reload(dto);
  }
}
