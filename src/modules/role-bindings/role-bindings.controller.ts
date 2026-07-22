import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiWrappedCreatedResponse,
  ApiBizErrorResponse,
  ApiWrappedArrayResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  BatchCreateRoleBindingsDto,
  BatchCreateRoleBindingsResponseDto,
  CreateRoleBindingDto,
  ListRoleBindingsQueryDto,
  PageRoleBindingsQueryDto,
  PreviewRoleBindingQueryDto,
  RoleBindingPreviewResponseDto,
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

  // F3/C1(路线图 §4;D9 拍板):/page 兄弟路由 —— 旧 bare 数组端点逐字不动。
  // 静态段路由(page / preview)须先于下方 GET :id 声明(Nest 按声明序注册,后声明的 :id 才不吞静态段)。
  @Get('role-bindings/page')
  @ApiOperation({
    summary:
      '分页列角色绑定(既有 5 过滤 + scopeOrgId/roleCode/principalQ/includeExpired/q + expand=role,principal;默认仅当前生效) [rbac: role-binding.read.record]',
  })
  @ApiWrappedPageResponse(RoleBindingResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  page(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: PageRoleBindingsQueryDto,
  ): Promise<PageResultDto<RoleBindingResponseDto>> {
    return this.service.page(user, query);
  }

  @Get('role-bindings/preview')
  @ApiOperation({
    summary:
      '预检待建角色绑定(dry-run:与 create 同参同校验,零写入;冲突/非法逐项返 conflicts,deny 是数据) [rbac: role-binding.read.record]',
  })
  @ApiWrappedOkResponse(RoleBindingPreviewResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  preview(
    @CurrentUser() user: CurrentUserPayload,
    @Query() query: PreviewRoleBindingQueryDto,
  ): Promise<RoleBindingPreviewResponseDto> {
    return this.service.preview(user, query);
  }

  @Get('role-bindings/:id')
  @ApiOperation({
    summary: '查单条角色绑定(detail;找不到未软删记录 → 34001) [rbac: role-binding.read.record]',
  })
  @ApiWrappedOkResponse(RoleBindingResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.ROLE_BINDING_NOT_FOUND,
  )
  findOne(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
  ): Promise<RoleBindingResponseDto> {
    return this.service.findOne(user, id);
  }

  // F3/C1:批量建绑定(逐条独立;单条失败不影响其它条,镜像 announcement-import 幂等范式)。
  // 显式 @HttpCode(200):blocked/already-exists 是数据不是错误(沿 announcement-import 决断④范式)。
  @Post('role-bindings/batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '批量建角色绑定(≤200 条,逐条 ok/blocked/already-exists;already-exists=幂等 skip,重跑同批不报错) [rbac: role-binding.create.record]',
  })
  @ApiWrappedOkResponse(BatchCreateRoleBindingsResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  createBatch(
    @CurrentUser() user: CurrentUserPayload,
    @Body() dto: BatchCreateRoleBindingsDto,
    @Req() req: Request,
  ): Promise<BatchCreateRoleBindingsResponseDto> {
    return this.service.createBatch(user, dto, buildAuditMeta(req));
  }

  @Post('role-bindings')
  @ApiOperation({
    summary:
      '建角色绑定(principal × role × scope + 任期;GLOBAL/ORGANIZATION/TREE/ACTIVITY/RESOURCE/SELF;scoped 入库不判,判权是 PR8) [rbac: role-binding.create.record]',
  })
  @ApiWrappedCreatedResponse(RoleBindingResponseDto)
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
    BizCode.CANNOT_ASSIGN_HIGHER_ROLE,
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
    BizCode.LAST_OPS_ADMIN_PROTECTED,
  )
  update(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() dto: UpdateRoleBindingDto,
    @Req() req: Request,
  ): Promise<RoleBindingResponseDto> {
    return this.service.update(user, id, dto, buildAuditMeta(req));
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
    BizCode.LAST_OPS_ADMIN_PROTECTED,
  )
  remove(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<RoleBindingResponseDto> {
    return this.service.remove(user, id, buildAuditMeta(req));
  }
}
