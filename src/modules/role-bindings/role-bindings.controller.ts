import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CreateRoleBindingDto,
  ListRoleBindingsQueryDto,
  RoleBindingResponseDto,
  UpdateRoleBindingDto,
} from './role-bindings.dto';
import { RoleBindingsService } from './role-bindings.service';

// 终态 scoped-authz PR6「RoleBinding」(2026-07-01;冻结稿 §7.5):带 scope 的角色绑定管理面 controller(4 路由)。
// @Controller('admin/v1') + 完整子路径 role-bindings[/:id];判权单轨 service 层 rbac.can(role-binding.*);
// 入口仅全局 JwtAuthGuard,**不**挂 @Roles。
// **🔴 scoped 绑定入库即止,RbacService 只读 GLOBAL、绝不判 scoped**(判权是 PR8 AuthzService)。

// 从 @Req() 构造 AuditMeta(沿 supervision-assignments / content 范式;D8 拍板不引入 ALS)。
function buildAuditMeta(req: Request): AuditMeta {
  return {
    requestId: req.id as string,
    ip: req.ip ?? null,
    ua: req.headers['user-agent'] ?? null,
  };
}

@ApiTags('Admin - Role Bindings')
@ApiBearerAuth()
@Controller('admin/v1')
export class RoleBindingsController {
  constructor(private readonly service: RoleBindingsService) {}

  @Get('role-bindings')
  @ApiOperation({
    summary:
      '列角色绑定(可按 principalType × principalId × role × scopeType × status 过滤;含 scoped 各型) [rbac: role-binding.read.record]',
  })
  @ApiWrappedArrayResponse(RoleBindingResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: ListRoleBindingsQueryDto,
  ): Promise<RoleBindingResponseDto[]> {
    return this.service.list(user, query);
  }

  @Post('role-bindings')
  @ApiOperation({
    summary:
      '建角色绑定(principal × role × scope + 任期;GLOBAL/ORGANIZATION/TREE/ACTIVITY/RESOURCE/SELF;scoped 入库不判,判权是 PR8) [rbac: role-binding.create.record]',
  })
  @ApiWrappedOkResponse(RoleBindingResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ROLE_BINDING_SCOPE_INVALID,
    BizCode.ROLE_BINDING_PRINCIPAL_INVALID,
    BizCode.ROLE_BINDING_TENURE_INVALID,
    BizCode.ROLE_BINDING_ALREADY_EXISTS,
    BizCode.USER_NOT_FOUND,
    BizCode.MEMBER_NOT_FOUND,
    BizCode.POSITION_ASSIGNMENT_NOT_FOUND,
    BizCode.ROLE_NOT_FOUND,
    BizCode.ROLE_DELETED,
    BizCode.ORGANIZATION_NOT_FOUND,
    BizCode.ACTIVITY_NOT_FOUND,
  )
  create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: CreateRoleBindingDto,
    @Req() req: Request,
  ): Promise<RoleBindingResponseDto> {
    return this.service.create(user, dto, buildAuditMeta(req));
  }

  @Patch('role-bindings/:id')
  @ApiOperation({
    summary:
      '改角色绑定(状态 / 任期 / note;不可改 principal/role/scope) [rbac: role-binding.update.record]',
  })
  @ApiWrappedOkResponse(RoleBindingResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ROLE_BINDING_NOT_FOUND,
    BizCode.ROLE_BINDING_TENURE_INVALID,
    BizCode.ROLE_BINDING_ALREADY_EXISTS,
  )
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateRoleBindingDto,
  ): Promise<RoleBindingResponseDto> {
    return this.service.update(user, id, dto);
  }

  @Delete('role-bindings/:id')
  @ApiOperation({
    summary:
      '软删角色绑定(status=ENDED + endedAt + deletedAt;保历史) [rbac: role-binding.delete.record]',
  })
  @ApiWrappedOkResponse(RoleBindingResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ROLE_BINDING_NOT_FOUND,
  )
  remove(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<RoleBindingResponseDto> {
    return this.service.remove(user, id, buildAuditMeta(req));
  }
}
