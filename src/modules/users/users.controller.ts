import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
  ApiWrappedPageResponse,
} from '../../common/decorators/api-response.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  CreateUserDto,
  ListUsersQueryDto,
  ResetUserPasswordDto,
  UpdateUserDto,
  UpdateUserRoleDto,
  UpdateUserStatusDto,
  UserResponseDto,
} from './users.dto';
import { UsersService } from './users.service';

// **权限标注**(P0-F PR-3B,2026-05-18):8 个管理端点入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;
// 全部判权迁移到 Service 内 `rbac.can()`,失败抛 `RBAC_FORBIDDEN(30100)`。
// 沿评审稿 docs/archive/reviews/first-release-p0f-pr3-users-rbac-review.md §4 / §8 + D1=A / D2=B / D3=A:
//   GET    /api/admin/v1/users              → user.read.account     (绑 ops-admin)
//   POST   /api/admin/v1/users              → user.create.account   (绑 ops-admin)
//   GET    /api/admin/v1/users/:id          → user.read.account     (绑 ops-admin)
//   PATCH  /api/admin/v1/users/:id          → user.update.account   (绑 ops-admin)
//   PUT    /api/admin/v1/users/:id/password → user.reset.password   (绑 ops-admin;D2=B)
//   PATCH  /api/admin/v1/users/:id/role     → user.update.role      (**不绑 ops-admin**;D1=A,仅 SA 短路)
//   PATCH  /api/admin/v1/users/:id/status   → user.update.status    (绑 ops-admin)
//   DELETE /api/admin/v1/users/:id          → user.delete.account   (绑 ops-admin)
// service 内 6 项业务护栏全保留:canViewUser / canManageUser / canCreateRole /
// canChangeRole / assertNotSelf / assertNotLastSuperAdmin(沿评审稿 §8.3)。
//
// 本 Controller 仅承载 Admin 管理端点(`@Controller('admin/v1/users')`),class-level
// @ApiTags = 'Admin - Users'。队员自助端点(GET / PATCH /me + PUT /me/password)现位于
// AppMeController(`@Controller('app/v1/me')`,controllers/app-me.controller.ts);
// 历史过渡 UsersMeLegacyController 已于 Route B Phase 4d 删除(沿 docs/api-surface-migration-plan.md §6 Phase 4)。
@ApiTags('Admin - Users')
@ApiBearerAuth()
@Controller('admin/v1/users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ===== 管理接口(P0-F PR-3B:走 rbac.can();失败 30100)=====

  @Get()
  @ApiOperation({ summary: '用户列表(分页;ADMIN 仅能看到 USER)' })
  @ApiWrappedPageResponse(UserResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.RBAC_FORBIDDEN)
  list(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ListUsersQueryDto,
  ): Promise<PageResultDto<UserResponseDto>> {
    return this.usersService.list(currentUser, query);
  }

  @Post()
  @ApiOperation({
    summary: '创建用户;SUPER_ADMIN 可创建 ADMIN/USER,ADMIN 只能创建 USER',
  })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.FORBIDDEN_ROLE_OPERATION,
    BizCode.USERNAME_ALREADY_EXISTS,
    BizCode.EMAIL_ALREADY_EXISTS,
  )
  create(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: CreateUserDto,
  ): Promise<UserResponseDto> {
    return this.usersService.create(currentUser, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '用户详情(ADMIN 仅能查看 USER)' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.FORBIDDEN_ROLE_OPERATION,
    BizCode.USER_NOT_FOUND,
  )
  findOne(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<UserResponseDto> {
    return this.usersService.findOne(currentUser, params.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '修改用户资料(不含 username / 密码 / 角色 / 状态)' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.FORBIDDEN_ROLE_OPERATION,
    BizCode.USER_NOT_FOUND,
    BizCode.EMAIL_ALREADY_EXISTS,
  )
  update(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    return this.usersService.update(currentUser, params.id, dto);
  }

  @Put(':id/password')
  @ApiOperation({ summary: '管理员重置用户密码(无需 oldPassword)' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.FORBIDDEN_ROLE_OPERATION,
    BizCode.USER_NOT_FOUND,
  )
  resetPassword(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: ResetUserPasswordDto,
    @Req() req: Request,
  ): Promise<UserResponseDto> {
    return this.usersService.resetPassword(currentUser, params.id, dto, this.buildAuditMeta(req));
  }

  @Patch(':id/role')
  @ApiOperation({
    summary: '修改用户角色(D1=A:仅 SUPER_ADMIN 短路;ops-admin 不绑 user.update.role)',
  })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.FORBIDDEN_ROLE_OPERATION,
    BizCode.CANNOT_OPERATE_SELF,
    BizCode.USER_NOT_FOUND,
    BizCode.LAST_SUPER_ADMIN_PROTECTED,
  )
  updateRole(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateUserRoleDto,
  ): Promise<UserResponseDto> {
    return this.usersService.updateRole(currentUser, params.id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: '启用/禁用用户(只改 status)' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.FORBIDDEN_ROLE_OPERATION,
    BizCode.CANNOT_OPERATE_SELF,
    BizCode.USER_NOT_FOUND,
    BizCode.LAST_SUPER_ADMIN_PROTECTED,
  )
  updateStatus(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: UpdateUserStatusDto,
  ): Promise<UserResponseDto> {
    return this.usersService.updateStatus(currentUser, params.id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '软删除用户(同时置 deletedAt 与 status=DISABLED)' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.RBAC_FORBIDDEN,
    BizCode.FORBIDDEN_ROLE_OPERATION,
    BizCode.CANNOT_OPERATE_SELF,
    BizCode.USER_NOT_FOUND,
    BizCode.LAST_SUPER_ADMIN_PROTECTED,
  )
  softDelete(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
  ): Promise<UserResponseDto> {
    return this.usersService.softDelete(currentUser, params.id);
  }

  // P0-D PR-3:从 @Req() 构造 AuditMeta 显式传给 service(D6 v1.1 §11.2 / D8 拍板;
  // 不引入 cls-rs / AsyncLocalStorage)。沿 emergency-contacts.controller.ts 范式。
  // 本 helper 服务 resetPassword(管理员重置密码端点)。队员自助改密走 AppMeController
  // (`app/v1/me`,PUT /me/password);沿 emergency-contacts.controller.ts 范式。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
