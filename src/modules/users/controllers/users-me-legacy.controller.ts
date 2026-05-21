import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { PasswordChangeThrottle } from '../../../common/decorators/password-change-throttle.decorator';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { ChangeMyPasswordDto, UpdateMyProfileDto, UserResponseDto } from '../users.dto';
import { UsersService } from '../users.service';

// P1-C step 1(2026-05-21)Mixed Controller 物理拆分:
//   把 UsersController 中 3 个 Root Legacy mobile-like `/me*` 端点物理迁出到独立 Controller。
//   沿 docs/api-surface-policy.md §5 项 1 + §7 P1-C step 1;P1-B 第一单(PR #168)已在
//   test/e2e/users-me-legacy.e2e-spec.ts 中锁定行为。
//
// 拆分硬约束(沿评审稿与 P1 禁止事项,沿 docs/api-surface-policy.md §8):
//   ❌ 不改任何 endpoint path(@Controller('users') + @Get('me') / @Patch('me') /
//      @Put('me/password') 全部 zero drift)
//   ❌ 不改任何 DTO 字段
//   ❌ 不改任何 service 行为(全部委托 usersService.findMe / updateMyProfile /
//      changeMyPassword)
//   ❌ 不改 Guard / Roles / RBAC / @Public / @PasswordChangeThrottle 语义
//   ❌ 不改任何 BizCode
//   ❌ 不改 OpenAPI snapshot 路径与行为
//
// 端点列表(全部 path 与 HTTP method 与拆分前 zero drift):
//   GET    /api/users/me          — 任意登录用户读本人资料(不进 RBAC 范围)
//   PATCH  /api/users/me          — 任意登录用户改本人非敏感资料(白名单 nickname / avatarKey)
//   PUT    /api/users/me/password — 任意登录用户自助改密(@PasswordChangeThrottle 5/60 IP 维度)
//
// 沿 P0-F PR-3B 评审稿 §2.2:3 个 `/me*` 端点**不**进 RBAC 范围,任何登录用户均可访问;
// 拆分后仅 JwtAuthGuard 兜底(沿 AppModule APP_GUARD 全局注册)。
@ApiTags('Mobile - Me')
@ApiBearerAuth()
@Controller('users')
export class UsersMeLegacyController {
  constructor(private readonly usersService: UsersService) {}

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

  // P0-D PR-3(2026-05-17):本人自助改密。
  // 沿 docs/archive/reviews/first-release-p0d-change-my-password-review.md §3.1 / §5;
  // @PasswordChangeThrottle 启用独立 throttler `password-change` 限流(5 次 / 60 秒 IP 维度)。
  // 与管理员重置接口 PUT /:id/password 行为对称区分:本接口需 oldPassword,管理员重置不需。
  @PasswordChangeThrottle()
  @Put('me/password')
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
  // P1-C step 1:UsersController 中同一 helper 保留以服务 resetPassword;本 Controller
  // 持有独立副本以避免跨文件 private helper 共享(沿"物理拆分零行为变更"原则)。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
