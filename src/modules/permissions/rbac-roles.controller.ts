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
import { PermissionResponseDto } from './permissions.dto';
import {
  CreateRbacRoleDto,
  ListRbacRolesQueryDto,
  RbacRoleDetailResponseDto,
  RbacRoleResponseDto,
  RoleOptionsQueryDto,
  RoleOptionsResponseDto,
  UpdateRbacRoleDto,
} from './rbac-roles.dto';
import { RbacRolesService } from './rbac-roles.service';

// V2.x C-6 RBAC 实施 PR #3:RbacRole 模块 Controller。
// 5 个端点(沿 D7 v1.1 §5.1 5-9):
//   GET    /api/system/v1/roles          列表(分页 + code 模糊过滤)
//   GET    /api/system/v1/roles/:id      详情(含已分配 permissions 数组)
//   POST   /api/system/v1/roles          创建
//   PATCH  /api/system/v1/roles/:id      更新(仅 displayName / description)
//   DELETE /api/system/v1/roles/:id      软删(D4 v1.0;deletedAt;user_roles 不联动)
//
// **权限标注**(P0-F PR-1,2026-05-18):入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;
// 全部判权迁移到 RbacRolesService 内 `rbac.can()`,失败抛
// BizException(BizCode.RBAC_FORBIDDEN)(30100)。沿 attachments F3 v1.0 范本。
// 映射 seed 现有 4 条权限点:rbac.role.{read,create,update,delete}(read 复用 GET 列表 + GET 详情)。
//
// **30003 / 30005 区分**(沿用户拍板):
// - GET /:id:不存在返 30003 / 已软删返 30005(410 Gone)
// - PATCH / DELETE /:id:不存在 + 已软删统一返 30003(信息泄漏防御)

@ApiTags('Ops - Roles')
@ApiBearerAuth()
@ApiExtraModels(RbacRoleResponseDto, RbacRoleDetailResponseDto, PermissionResponseDto)
@Controller('system/v1/roles')
export class RbacRolesController {
  constructor(private readonly service: RbacRolesService) {}

  @Get()
  @ApiOperation({ summary: '列出角色(分页;按 code 模糊过滤;排除已软删) [rbac: rbac.role.read]' })
  @ApiWrappedPageResponse(RbacRoleResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: ListRbacRolesQueryDto,
  ): Promise<PageResultDto<RbacRoleResponseDto>> {
    return this.service.list(user, query);
  }

  // F1/A4(路线图 §4;D2/D3/D4 拍板):选择器投影,必须先于 /:id 定义(specific-before-dynamic)。
  @Get('options')
  @ApiOperation({
    summary: '角色选择器投影(q 模糊 code+displayName;limit≤100,默认 20) [rbac: rbac.role.read]',
  })
  @ApiWrappedOkResponse(RoleOptionsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  options(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: RoleOptionsQueryDto,
  ): Promise<RoleOptionsResponseDto> {
    return this.service.options(user, query);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      '角色详情(含已分配 permissions 数组;不存在返 30003 / 已软删返 30005) [rbac: rbac.role.read]',
  })
  @ApiWrappedOkResponse(RbacRoleDetailResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ROLE_NOT_FOUND,
    BizCode.ROLE_DELETED,
  )
  findOne(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<RbacRoleDetailResponseDto> {
    return this.service.findOne(user, params.id);
  }

  @Post()
  @ApiOperation({
    summary:
      '创建角色(code 格式 kebab-case 3-32 字符;失败抛 30009;含软删历史撞唯一抛 30004) [rbac: rbac.role.create]',
  })
  @ApiWrappedOkResponse(RbacRoleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.INVALID_ROLE_CODE_FORMAT,
    BizCode.ROLE_CODE_ALREADY_EXISTS,
  )
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateRbacRoleDto,
  ): Promise<RbacRoleResponseDto> {
    return this.service.create(user, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary:
      '更新角色(仅 displayName / description;code 不可改;不存在或已软删返 30003) [rbac: rbac.role.update]',
  })
  @ApiWrappedOkResponse(RbacRoleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ROLE_NOT_FOUND,
  )
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateRbacRoleDto,
  ): Promise<RbacRoleResponseDto> {
    return this.service.update(user, params.id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '软删角色(D4 v1.0;update deletedAt;user_roles / role_permissions 不联动;不存在或已软删返 30003) [rbac: rbac.role.delete]',
  })
  @ApiWrappedOkResponse(RbacRoleResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ROLE_NOT_FOUND,
  )
  delete(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<RbacRoleResponseDto> {
    return this.service.softDelete(user, params.id);
  }
}
