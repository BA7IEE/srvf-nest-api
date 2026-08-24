import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiWrappedCreatedResponse,
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { RequiresPermission } from '../../common/decorators/route-authz.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CreatePermissionDto,
  ListPermissionsQueryDto,
  PermissionCatalogGroupDto,
  PermissionCatalogItemDto,
  PermissionCatalogResponseDto,
  PermissionCatalogSectionDto,
  PermissionResponseDto,
  UpdatePermissionDto,
} from './permissions.dto';
import { PermissionsService } from './permissions.service';

// 从 @Req() 构造 AuditMeta(沿 user-roles.controller 范式)。第三轮 review §F&A-2:
// Permission CRUD 写 audit(resourceType='permission')。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

// V2.x C-6 RBAC 实施 PR #2:permissions 模块 Controller。
// 4 个端点(沿 D7 v1.1 §5.1 1-4):
//   GET    /api/system/v1/permissions      列表(分页)
//   POST   /api/system/v1/permissions      创建
//   PATCH  /api/system/v1/permissions/:id  更新(仅 description)
//   DELETE /api/system/v1/permissions/:id  物理删(D4 v1.0)
//
// **权限标注**(P0-F PR-1,2026-05-18):入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;
// 全部判权迁移到 PermissionsService 内 `rbac.can()`,失败抛
// BizException(BizCode.RBAC_FORBIDDEN)(30100)。沿 attachments F3 v1.0 范本。
// 映射 seed 现有 4 条权限点:rbac.permission.{read,create,update,delete}。

@ApiTags('Ops - Permissions')
@ApiBearerAuth()
@ApiExtraModels(
  PermissionResponseDto,
  PermissionCatalogResponseDto,
  PermissionCatalogSectionDto,
  PermissionCatalogGroupDto,
  PermissionCatalogItemDto,
)
@Controller('system/v1/permissions')
export class PermissionsController {
  constructor(private readonly service: PermissionsService) {}

  @Get()
  @RequiresPermission('rbac.permission.read')
  @ApiOperation({
    summary: '列出权限点(分页;按 module / resourceType 过滤) [rbac: rbac.permission.read]',
  })
  @ApiWrappedPageResponse(PermissionResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: ListPermissionsQueryDto,
  ): Promise<PageResultDto<PermissionResponseDto>> {
    return this.service.list(user, query);
  }

  // P1-32 PR 2(冻结稿 §9.1):权限目录只读投影。
  //
  // 🔴 **不分页,一次返回全部 237 条** —— 冻结稿 §9.1 逐字「返回完整目录,不分页」。
  //    这是对分页铁律的**已登记例外**,登记在
  //    docs/reference/response-pagination-errors.md §4「已登记例外」表(不是默默不分页)。
  //    理由:目录是**固定参考集合**不是业务流水,前端权限编辑器要按业务区渲染整棵树;
  //    分页会让「按 sortOrder 分组」这件事在客户端拼不齐。本端点新增、无存量调用方,
  //    不存在「老调用方从 N 条掉到 20 条」那类破坏。
  //
  // ⚠️ 路由次序:本 controller 没有 `@Get(':id')`,`catalog` 不会被动态段吃掉;
  //    将来若新增 `@Get(':id')`,必须排在本方法**之后**(specific-before-dynamic)。
  @Get('catalog')
  @RequiresPermission('rbac.permission.read')
  @ApiOperation({
    summary:
      '权限目录(只读;按业务区 / 分组两级返回全部权限码的中文名、人话说明、风险等级与授予策略;**不分页**,已登记例外) [rbac: rbac.permission.read]',
  })
  @ApiWrappedOkResponse(PermissionCatalogResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  catalog(@CurrentUser() user: CurrentUserPayload): Promise<PermissionCatalogResponseDto> {
    return this.service.catalog(user);
  }

  @Post()
  @RequiresPermission('rbac.permission.create')
  @ApiOperation({
    summary:
      '创建权限点(权限码由 seed 定义,此处不能凭空造 —— 闭包外的码抛 30106,闭包内的码 seed 后已存在抛 30002;实际不存在可成功路径) [rbac: rbac.permission.create]',
  })
  @ApiWrappedCreatedResponse(PermissionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.INVALID_PERMISSION_CODE_FORMAT,
    BizCode.PERMISSION_CODE_ALREADY_EXISTS,
    BizCode.PERMISSION_CODE_NOT_IN_SEED_CATALOG,
  )
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreatePermissionDto,
    @Req() req: Request,
  ): Promise<PermissionResponseDto> {
    return this.service.create(user, dto, buildAuditMeta(req));
  }

  @Patch(':id')
  @RequiresPermission('rbac.permission.update')
  @ApiOperation({
    summary:
      '更新权限点(description 由 seed 定义,此处不能改 —— 闭包内的码抛 30110;而闭包外的码又造不出来(30106);实际不存在可成功路径) [rbac: rbac.permission.update]',
  })
  @ApiWrappedOkResponse(PermissionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PERMISSION_NOT_FOUND,
    BizCode.SEED_PERMISSION_UPDATE_FORBIDDEN,
  )
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdatePermissionDto,
    @Req() req: Request,
  ): Promise<PermissionResponseDto> {
    return this.service.update(user, params.id, dto, buildAuditMeta(req));
  }

  @Delete(':id')
  @RequiresPermission('rbac.permission.delete')
  @ApiOperation({
    summary:
      '物理删除权限点(seed 事实闭包内的系统权限码一律拒绝,抛 30105 —— 删码会经 RolePermission FK Cascade 一次性撤销所有角色对它的授权;仅闭包外的历史码可删) [rbac: rbac.permission.delete]',
  })
  @ApiWrappedOkResponse(PermissionResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.PERMISSION_NOT_FOUND,
    BizCode.SEED_PERMISSION_DELETE_FORBIDDEN,
  )
  delete(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Req() req: Request,
  ): Promise<PermissionResponseDto> {
    return this.service.delete(user, params.id, buildAuditMeta(req));
  }
}
