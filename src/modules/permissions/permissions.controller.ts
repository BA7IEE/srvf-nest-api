import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  CreatePermissionDto,
  ListPermissionsQueryDto,
  PermissionResponseDto,
  UpdatePermissionDto,
} from './permissions.dto';
import { PermissionsService } from './permissions.service';

// V2.x C-6 RBAC 实施 PR #2:permissions 模块 Controller。
// 4 个端点(沿 D7 v1.1 §5.1 1-4):
//   GET    /api/v2/permissions      列表(分页)
//   POST   /api/v2/permissions      创建
//   PATCH  /api/v2/permissions/:id  更新(仅 description)
//   DELETE /api/v2/permissions/:id  物理删(D4 v1.0)
//
// **权限标注**(P0-F PR-1,2026-05-18):入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;
// 全部判权迁移到 PermissionsService 内 `rbac.can()`,失败抛
// BizException(BizCode.RBAC_FORBIDDEN)(30100)。沿 attachments F3 v1.0 范本。
// 映射 seed 现有 4 条权限点:rbac.permission.{read,create,update,delete}。

@ApiTags('Ops - Permissions')
@ApiBearerAuth()
@ApiExtraModels(PermissionResponseDto)
@Controller(['v2/permissions', 'system/v1/permissions'])
export class PermissionsController {
  constructor(private readonly service: PermissionsService) {}

  @Get()
  @ApiOperation({ summary: '列出权限点(分页;按 module / resourceType 过滤)' })
  @ApiWrappedPageResponse(PermissionResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: ListPermissionsQueryDto,
  ): Promise<PageResultDto<PermissionResponseDto>> {
    return this.service.list(user, query);
  }

  @Post()
  @ApiOperation({
    summary: '创建权限点(code 格式 <module>.<action>.<resource_type>;失败抛 30008)',
  })
  @ApiWrappedOkResponse(PermissionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.INVALID_PERMISSION_CODE_FORMAT,
    BizCode.PERMISSION_CODE_ALREADY_EXISTS,
  )
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreatePermissionDto,
  ): Promise<PermissionResponseDto> {
    return this.service.create(user, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: '更新权限点(仅 description;code / module / action / resourceType 不可改)',
  })
  @ApiWrappedOkResponse(PermissionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PERMISSION_NOT_FOUND,
  )
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdatePermissionDto,
  ): Promise<PermissionResponseDto> {
    return this.service.update(user, params.id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: '物理删除权限点(D4 v1.0;RolePermission FK Cascade 自动联级清理)',
  })
  @ApiWrappedOkResponse(PermissionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PERMISSION_NOT_FOUND,
  )
  delete(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<PermissionResponseDto> {
    return this.service.delete(user, params.id);
  }
}
