import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  CreateOrganizationDto,
  ListOrganizationsQueryDto,
  OrganizationResponseDto,
  OrganizationTreeNodeDto,
  OrganizationTreeQueryDto,
  UpdateOrganizationDto,
  UpdateOrganizationStatusDto,
} from './organizations.dto';
import { OrganizationsService } from './organizations.service';

// /api/admin/v1/organizations(7 接口);路径前缀:全局 /api(main.ts)+ 'v2/organizations'。
//
// **权限标注**(P0-F PR-2A,2026-05-18):入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;
// 全部判权迁移到 OrganizationsService 内 `rbac.can()`,失败抛
// BizException(BizCode.RBAC_FORBIDDEN)(30100)。沿 PR-1 attachments F3 v1.0 范本。
// 映射 seed 新增 4 条权限点:org.{read,create,update,delete}.node。
// D3=A:org softDelete 从 v1 仅 SUPER_ADMIN 放宽至 ops-admin 可调
// (sub-protection 仍在 service 内:HAS_CHILDREN / HAS_MEMBERS / LAST_ROOT_PROTECTED)。

@ApiTags('Admin - Organizations')
@ApiBearerAuth()
@Controller('admin/v1/organizations')
export class OrganizationsController {
  constructor(private readonly service: OrganizationsService) {}

  @Get()
  @ApiOperation({ summary: '列出组织节点(分页;parentId=null 过滤根节点)' })
  @ApiWrappedPageResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: ListOrganizationsQueryDto,
  ): Promise<PageResultDto<OrganizationResponseDto>> {
    return this.service.list(user, query);
  }

  // /tree 必须**先于** /:id 定义(specific-before-dynamic;沿用 dictionaries 经验)。
  @Get('tree')
  @ApiOperation({ summary: '组织树形(从根开始嵌套;深度无限制)' })
  @ApiWrappedArrayResponse(OrganizationTreeNodeDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  tree(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: OrganizationTreeQueryDto,
  ): Promise<OrganizationTreeNodeDto[]> {
    return this.service.getTree(user, query);
  }

  @Post()
  @ApiOperation({
    summary: '创建组织节点(parentId 不传 = 根节点;V2 第一阶段单根上限 1)',
  })
  @ApiWrappedOkResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_PARENT_NOT_FOUND,
    BizCode.ORGANIZATION_NODE_TYPE_INVALID,
    BizCode.ORGANIZATION_PARENT_CYCLE,
    BizCode.ORGANIZATION_ROOT_ALREADY_EXISTS,
  )
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    return this.service.create(user, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '组织节点详情' })
  @ApiWrappedOkResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
  )
  findOne(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<OrganizationResponseDto> {
    return this.service.findOne(user, params.id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: '更新组织节点(name / sortOrder / nodeTypeCode;**禁止改 parentId**)',
  })
  @ApiWrappedOkResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_NODE_TYPE_INVALID,
    BizCode.ORGANIZATION_PARENT_CHANGE_FORBIDDEN,
  )
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateOrganizationDto,
  ): Promise<OrganizationResponseDto> {
    return this.service.update(user, params.id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: '启停组织节点(只改 status;停用唯一活跃根 → LAST_ROOT_PROTECTED)',
  })
  @ApiWrappedOkResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.LAST_ROOT_ORGANIZATION_PROTECTED,
  )
  updateStatus(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateOrganizationStatusDto,
  ): Promise<OrganizationResponseDto> {
    return this.service.updateStatus(user, params.id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '软删组织节点(P0-F PR-2A D3=A 放宽:ops-admin 可调;有子节点 / 成员归属 / 唯一活跃根则拒绝)',
  })
  @ApiWrappedOkResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_HAS_CHILDREN,
    BizCode.ORGANIZATION_HAS_MEMBERS,
    BizCode.LAST_ROOT_ORGANIZATION_PROTECTED,
  )
  softDelete(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<OrganizationResponseDto> {
    return this.service.softDelete(user, params.id);
  }
}
