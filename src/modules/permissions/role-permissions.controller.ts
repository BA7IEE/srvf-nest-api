import { Body, Controller, Delete, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { PermissionResponseDto } from './permissions.dto';
import { RbacRoleDetailResponseDto, RbacRoleResponseDto } from './rbac-roles.dto';
import { AssignRolePermissionsDto, RevokeRolePermissionParamDto } from './role-permissions.dto';
import { RolePermissionsService } from './role-permissions.service';

// V2.x C-6 RBAC 实施 PR #4:RolePermission 关联表 Controller。
// 2 个端点(沿 D7 v1.1 §5.1 端点 10-11):
//   POST   /api/v2/roles/:id/permissions       批量授权(幂等)
//   DELETE /api/v2/roles/:id/permissions/:permissionId  撤权(精确)
//
// **路径参数语义**(沿 D7 v1.1 §5.1):
// - `:id` = roleId(cuid 字符串)
// - `:permissionId` = permission.id(cuid 字符串;**不**是 permission.code;
//   有意设计:POST 批量授权用 codes 易读,DELETE 单条撤权用 id 精确)
//
// **出参**:两端点统一返 RbacRoleDetailResponseDto(沿 RbacRole detail 接口),
// 调用者一次拿到该角色当前完整 permissions 列表,前端"保存当前选中"语义友好。
//
// **权限标注**(任务边界 #8):沿 @Roles(Role.SUPER_ADMIN, Role.ADMIN);
// 不接 RBAC 判权(rbac.can() 留 PR #6)。D7 §6.1 决议"运营管理员管 role_permissions"
// 由 PR #6 实施,本 PR 暂用入口 Guard。

@ApiTags('role-permissions')
@ApiBearerAuth()
@ApiExtraModels(RbacRoleResponseDto, RbacRoleDetailResponseDto, PermissionResponseDto)
@Controller('v2/roles/:id/permissions')
export class RolePermissionsController {
  constructor(private readonly service: RolePermissionsService) {}

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '批量给角色加权限点(幂等:已存在的 (roleId, permissionId) 静默跳过;入参 permissionCodes[],非 ids)',
  })
  @ApiWrappedOkResponse(RbacRoleDetailResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ROLE_NOT_FOUND,
    BizCode.ROLE_DELETED,
    BizCode.PERMISSION_NOT_FOUND,
  )
  assign(
    @Param() params: IdParamDto,
    @Body() dto: AssignRolePermissionsDto,
  ): Promise<RbacRoleDetailResponseDto> {
    return this.service.assign(params.id, dto);
  }

  @Delete(':permissionId')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary:
      '撤销角色的某个权限点(精确路径 :permissionId 是 permission.id 非 code;关系不存在返 30011)',
  })
  @ApiWrappedOkResponse(RbacRoleDetailResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ROLE_NOT_FOUND,
    BizCode.ROLE_DELETED,
    BizCode.PERMISSION_NOT_FOUND,
    BizCode.ROLE_PERMISSION_NOT_FOUND,
  )
  revoke(@Param() params: RevokeRolePermissionParamDto): Promise<RbacRoleDetailResponseDto> {
    return this.service.revoke(params.id, params.permissionId);
  }
}
