import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
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
// **权限标注**(沿任务边界 #5):**先沿用现有 @Roles(Role.SUPER_ADMIN, Role.ADMIN)**,
// 不接 RBAC 判权(rbac.can() / @RbacRequired);RBAC judge 由后续 PR #6 实施。
// 本 PR 仅落地 CRUD,judge 接入是独立 PR。

@ApiTags('permissions')
@ApiBearerAuth()
@ApiExtraModels(PermissionResponseDto)
@Controller('v2/permissions')
export class PermissionsController {
  constructor(private readonly service: PermissionsService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '列出权限点(分页;按 module / resourceType 过滤)' })
  @ApiWrappedPageResponse(PermissionResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  list(@Query() query: ListPermissionsQueryDto): Promise<PageResultDto<PermissionResponseDto>> {
    return this.service.list(query);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '创建权限点(code 格式 <module>.<action>.<resource_type>;失败抛 30008)',
  })
  @ApiWrappedOkResponse(PermissionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.INVALID_PERMISSION_CODE_FORMAT,
    BizCode.PERMISSION_CODE_ALREADY_EXISTS,
  )
  create(@Body() dto: CreatePermissionDto): Promise<PermissionResponseDto> {
    return this.service.create(dto);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '更新权限点(仅 description;code / module / action / resourceType 不可改)',
  })
  @ApiWrappedOkResponse(PermissionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.PERMISSION_NOT_FOUND,
  )
  update(
    @Param() params: IdParamDto,
    @Body() dto: UpdatePermissionDto,
  ): Promise<PermissionResponseDto> {
    return this.service.update(params.id, dto);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '物理删除权限点(D4 v1.0;RolePermission FK Cascade 自动联级清理)',
  })
  @ApiWrappedOkResponse(PermissionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.PERMISSION_NOT_FOUND,
  )
  delete(@Param() params: IdParamDto): Promise<PermissionResponseDto> {
    return this.service.delete(params.id);
  }
}
