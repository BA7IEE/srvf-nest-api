import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
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
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CreateOrganizationDto,
  ListOrganizationsQueryDto,
  MoveOrganizationDto,
  OrganizationResponseDto,
  OrganizationTreeNodeDto,
  OrganizationTreeQueryDto,
  UpdateOrganizationDto,
  UpdateOrganizationStatusDto,
} from './organizations.dto';
import { OrganizationsService } from './organizations.service';

// /api/admin/v1/organizations(7 接口);路径前缀:全局 /api(main.ts)+ 'admin/v1/organizations'。
//
// **权限标注**(P0-F PR-2A,2026-05-18):入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;
// 全部判权迁移到 OrganizationsService 内 `rbac.can()`,失败抛
// BizException(BizCode.RBAC_FORBIDDEN)(30100)。沿 PR-1 attachments F3 v1.0 范本。
// 映射 seed 新增 4 条权限点:org.{read,create,update,delete}.node。
// D3=A:org softDelete 从 v1 仅 SUPER_ADMIN 放宽至 ops-admin 可调
// (sub-protection 仍在 service 内:HAS_CHILDREN / HAS_MEMBERS / LAST_ROOT_PROTECTED)。

// 审计留痕批(2026-07-03;review #484 G18 → NEXT_TASKS P1-16):从 @Req() 构造 AuditMeta
//(沿 position-assignments / content-admin 范式;D8 拍板不引入 ALS)。create/updateStatus/move/
// softDelete 4 个写点传给 service;update(PATCH)不审计,不需要 AuditMeta。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin - Organizations')
@ApiBearerAuth()
@Controller('admin/v1/organizations')
export class OrganizationsController {
  constructor(private readonly service: OrganizationsService) {}

  @Get()
  @ApiOperation({ summary: '列出组织节点(分页;parentId=null 过滤根节点) [rbac: org.read.node]' })
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
  @ApiOperation({ summary: '组织树形(从根开始嵌套;深度无限制) [rbac: org.read.node]' })
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
    summary: '创建组织节点(parentId 不传 = 根节点;V2 第一阶段单根上限 1) [rbac: org.create.node]',
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
    BizCode.ORGANIZATION_CODE_ALREADY_EXISTS,
  )
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateOrganizationDto,
    @Req() req: Request,
  ): Promise<OrganizationResponseDto> {
    return this.service.create(user, dto, buildAuditMeta(req));
  }

  @Get(':id')
  @ApiOperation({ summary: '组织节点详情 [rbac: org.read.node]' })
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
    summary:
      '更新组织节点(name / sortOrder / nodeTypeCode;**禁止改 parentId**) [rbac: org.update.node]',
  })
  @ApiWrappedOkResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_NODE_TYPE_INVALID,
    BizCode.ORGANIZATION_PARENT_CHANGE_FORBIDDEN,
    BizCode.ORGANIZATION_CODE_ALREADY_EXISTS,
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
    summary:
      '启停组织节点(只改 status;停用唯一活跃根 → LAST_ROOT_PROTECTED) [rbac: org.update.node]',
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
    @Req() req: Request,
  ): Promise<OrganizationResponseDto> {
    return this.service.updateStatus(user, params.id, dto, buildAuditMeta(req));
  }

  // 终态 scoped-authz PR1(2026-07-01 goal「组织基座」;冻结稿 §8.3/§11 PR1):reparent 重挂父级。
  // 命令式(沿 promote/join/send-sms 现役 POST 范式);判权 service 层 rbac.can('org.move.node'),0 @Roles。
  @Post(':id/move')
  @ApiOperation({
    summary:
      '重挂组织节点父级(reparent;禁改根节点父级 / 目标父=自身或后代成环 → 拒;事务内重算 closure) [rbac: org.move.node]',
  })
  @ApiWrappedOkResponse(OrganizationResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ORGANIZATION_PARENT_NOT_FOUND,
    BizCode.ORGANIZATION_PARENT_CYCLE,
    BizCode.ORGANIZATION_PARENT_CHANGE_FORBIDDEN,
  )
  move(
    @CurrentUser() user: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: MoveOrganizationDto,
    @Req() req: Request,
  ): Promise<OrganizationResponseDto> {
    return this.service.move(user, params.id, dto, buildAuditMeta(req));
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '软删组织节点(P0-F PR-2A D3=A 放宽:ops-admin 可调;有子节点 / 成员归属 / 唯一活跃根则拒绝) [rbac: org.delete.node]',
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
    @Req() req: Request,
  ): Promise<OrganizationResponseDto> {
    return this.service.softDelete(user, params.id, buildAuditMeta(req));
  }
}
