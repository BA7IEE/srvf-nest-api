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
  Put,
  Query,
  Req,
} from '@nestjs/common';
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
import { PasswordChangeThrottle } from '../../common/decorators/password-change-throttle.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import {
  ChangeMyPasswordDto,
  CreateUserDto,
  ListUsersQueryDto,
  ResetUserPasswordDto,
  UpdateMyProfileDto,
  UpdateUserDto,
  UpdateUserRoleDto,
  UpdateUserStatusDto,
  UserResponseDto,
} from './users.dto';
import { UsersService } from './users.service';

// **权限标注**(P0-F PR-3B,2026-05-18):8 个管理端点入口仅 JwtAuthGuard,**不**挂 `@Roles(...)`;
// 全部判权迁移到 Service 内 `rbac.can()`,失败抛 `RBAC_FORBIDDEN(30100)`。
// 沿评审稿 docs/first-release-p0f-pr3-users-rbac-review.md §4 / §8 + D1=A / D2=B / D3=A:
//   GET    /api/users              → user.read.account     (绑 ops-admin)
//   POST   /api/users              → user.create.account   (绑 ops-admin)
//   GET    /api/users/:id          → user.read.account     (绑 ops-admin)
//   PATCH  /api/users/:id          → user.update.account   (绑 ops-admin)
//   PUT    /api/users/:id/password → user.reset.password   (绑 ops-admin;D2=B)
//   PATCH  /api/users/:id/role     → user.update.role      (**不绑 ops-admin**;D1=A,仅 SA 短路)
//   PATCH  /api/users/:id/status   → user.update.status    (绑 ops-admin)
//   DELETE /api/users/:id          → user.delete.account   (绑 ops-admin)
// service 内 6 项业务护栏全保留:canViewUser / canManageUser / canCreateRole /
// canChangeRole / assertNotSelf / assertNotLastSuperAdmin(沿评审稿 §8.3)。
// `/me` 3 端点保持任意登录用户可访问,**不**进 RBAC 范围(沿评审稿 §2.2)。
//
// Phase 1A(2026-05-19):Mixed Controller — class-level @ApiTags 用占多数的 surface
// ('Admin - Users';8/11 端点为管理面);3 个 /me 端点 method-level 追加 'Mobile - Me'。
// 因 NestJS Swagger 11 method-level @ApiTags 是 append 不是 replace,/me 端点最终
// 会被同时归入 ['Admin - Users', 'Mobile - Me'] 两个 tag(dual tag),这是预期内的
// Mixed 边界视觉信号;物理拆 Controller 留 Phase 5(沿 docs/api-client-boundary-phase-1-review.md §2.2)。
@ApiTags('Admin - Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ===== /me(本人接口,任何登录用户均可访问;**不**进 RBAC 范围)=====

  @Get('me')
  @ApiTags('Mobile - Me')
  @ApiOperation({ summary: '获取本人资料' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED)
  findMe(@CurrentUser() currentUser: CurrentUserPayload): Promise<UserResponseDto> {
    return this.usersService.findMe(currentUser);
  }

  @Patch('me')
  @ApiTags('Mobile - Me')
  @ApiOperation({ summary: '修改本人非敏感资料(仅 nickname / avatarKey)' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED)
  updateMyProfile(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: UpdateMyProfileDto,
  ): Promise<UserResponseDto> {
    return this.usersService.updateMyProfile(currentUser, dto);
  }

  // P0-D PR-3(2026-05-17):本人自助改密。
  // 沿 docs/first-release-p0d-change-my-password-review.md §3.1 / §5;
  // @PasswordChangeThrottle 启用独立 throttler `password-change` 限流(5 次 / 60 秒 IP 维度)。
  // 与管理员重置接口 PUT /:id/password 行为对称区分:本接口需 oldPassword,管理员重置不需。
  @PasswordChangeThrottle()
  @Put('me/password')
  @ApiTags('Mobile - Me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '本人自助改密(需 oldPassword);不主动吊销旧 token' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.USER_NOT_FOUND,
    BizCode.OLD_PASSWORD_INVALID,
    BizCode.NEW_PASSWORD_SAME_AS_OLD,
    BizCode.TOO_MANY_REQUESTS,
  )
  changeMyPassword(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: ChangeMyPasswordDto,
    @Req() req: Request,
  ): Promise<UserResponseDto> {
    return this.usersService.changeMyPassword(currentUser, dto, this.buildAuditMeta(req));
  }

  // P0-D PR-3:从 @Req() 构造 AuditMeta 显式传给 service(D6 v1.1 §11.2 / D8 拍板;
  // 不引入 cls-rs / AsyncLocalStorage)。沿 emergency-contacts.controller.ts 范式。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }

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
}
