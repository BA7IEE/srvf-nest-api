import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  AssignUserRoleDto,
  RevokeUserRoleParamDto,
  UserIdParamDto,
  UserRoleResponseDto,
} from './user-roles.dto';
import { UserRolesService } from './user-roles.service';

// V2.x C-6 RBAC 实施 PR #5:UserRole 模块 Controller。
// 3 个端点(沿 D7 v1.1 §5.1 端点 12-14):
//   GET    /api/v2/users/:userId/roles                  查用户角色列表
//   POST   /api/v2/users/:userId/roles                  分配角色(入参 roleCode)
//   DELETE /api/v2/users/:userId/roles/:roleId          撤销角色
//
// **权限标注**(任务边界 #6):沿 @Roles(Role.SUPER_ADMIN, Role.ADMIN);
// 不接 RBAC 判权(@RbacRequired 留 PR #6)。D7 §5.1 写"`rbac.user-role.read` 或本人"
// 留 PR #6 实施 me/permissions 时一并加 me/roles 接口,本 PR 暂用入口 Guard。
//
// **Q7 角色分级**(沿用户拍板 C2 中庸方案):
// Service 层 canAssignRole 私有 helper 显式判定(沿任务 #8;不引入 Guard 装饰器)。

@ApiTags('user-roles')
@ApiBearerAuth()
@ApiExtraModels(UserRoleResponseDto)
@Controller('v2/users/:userId/roles')
export class UserRolesController {
  constructor(private readonly service: UserRolesService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '查用户角色列表(排除已软删 RBAC 角色)' })
  @ApiWrappedArrayResponse(UserRoleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.USER_NOT_FOUND,
  )
  list(@Param() params: UserIdParamDto): Promise<UserRoleResponseDto[]> {
    return this.service.list(params.userId);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '给用户分配角色(入参 roleCode;Q7 角色分级 C2 中庸:SUPER_ADMIN 通过任何 / 持 ops-admin 通过非 ops-admin / 其他 30102;重复分配 30006)',
  })
  @ApiWrappedOkResponse(UserRoleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.USER_NOT_FOUND,
    BizCode.ROLE_NOT_FOUND,
    BizCode.CANNOT_ASSIGN_HIGHER_ROLE,
    BizCode.USER_ROLE_ALREADY_EXISTS,
  )
  assign(
    @CurrentUser() actor: CurrentUserPayload,
    @Param() params: UserIdParamDto,
    @Body() dto: AssignUserRoleDto,
  ): Promise<UserRoleResponseDto> {
    return this.service.assign(actor, params.userId, dto);
  }

  @Delete(':roleId')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '撤销用户角色(路径 :roleId 是 RbacRole.id;Q7 角色分级判定;撤 ops-admin 时事务内"最后一个 ops-admin 保护"30101;关系不存在 30007)',
  })
  @ApiWrappedOkResponse(UserRoleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.USER_NOT_FOUND,
    BizCode.ROLE_NOT_FOUND,
    BizCode.ROLE_DELETED,
    BizCode.CANNOT_ASSIGN_HIGHER_ROLE,
    BizCode.USER_ROLE_NOT_FOUND,
    BizCode.LAST_OPS_ADMIN_PROTECTED,
  )
  revoke(
    @CurrentUser() actor: CurrentUserPayload,
    @Param() params: RevokeUserRoleParamDto,
  ): Promise<UserRoleResponseDto> {
    return this.service.revoke(actor, params.userId, params.roleId);
  }
}
