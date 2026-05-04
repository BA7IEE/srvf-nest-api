import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
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
import { Roles } from '../../common/decorators/roles.decorator';
import { IdParamDto } from '../../common/dto/id-param.dto';
import { PageResultDto } from '../../common/dto/pagination.dto';
import {
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

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ===== /me(本人接口,不标 @Roles,任何登录用户均可访问)=====

  @Get('me')
  @ApiOperation({ summary: '获取本人资料' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED)
  findMe(@CurrentUser() currentUser: CurrentUserPayload): Promise<UserResponseDto> {
    return this.usersService.findMe(currentUser);
  }

  @Patch('me')
  @ApiOperation({ summary: '修改本人非敏感资料(仅 nickname / avatarKey)' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED)
  updateMyProfile(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: UpdateMyProfileDto,
  ): Promise<UserResponseDto> {
    return this.usersService.updateMyProfile(currentUser, dto);
  }

  // ===== 管理接口 =====

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '用户列表(分页;ADMIN 仅能看到 USER)' })
  @ApiWrappedPageResponse(UserResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  list(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Query() query: ListUsersQueryDto,
  ): Promise<PageResultDto<UserResponseDto>> {
    return this.usersService.list(currentUser, query);
  }

  @Post()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: '创建用户;SUPER_ADMIN 可创建 ADMIN/USER,ADMIN 只能创建 USER',
  })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '用户详情(ADMIN 仅能查看 USER)' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '修改用户资料(不含 username / 密码 / 角色 / 状态)' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '管理员重置用户密码(无需 oldPassword)' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.FORBIDDEN_ROLE_OPERATION,
    BizCode.USER_NOT_FOUND,
  )
  resetPassword(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Param() params: IdParamDto,
    @Body() dto: ResetUserPasswordDto,
  ): Promise<UserResponseDto> {
    return this.usersService.resetPassword(currentUser, params.id, dto);
  }

  @Patch(':id/role')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: '修改用户角色(只有 SUPER_ADMIN 能调用)' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '启用/禁用用户(只改 status)' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: '软删除用户(同时置 deletedAt 与 status=DISABLED)' })
  @ApiWrappedOkResponse(UserResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
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
