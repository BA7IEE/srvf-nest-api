import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { LoginThrottle } from '../../common/decorators/login-throttle.decorator';
import { PasswordChangeThrottle } from '../../common/decorators/password-change-throttle.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RefreshThrottle } from '../../common/decorators/refresh-throttle.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthService } from './auth.service';
import {
  LoginDto,
  LoginResponseDto,
  LogoutAllResponseDto,
  LogoutDto,
  RefreshTokenDto,
} from './auth.dto';

@ApiTags('Auth')
// Route B Phase 4(2026-06-01;沿 docs/api-surface-migration-plan.md §6 Phase 4):
// 老 path 'auth' 已删除(无生产消费者,直接收口);canonical 单一前缀 'auth/v1'。
@Controller('auth/v1')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // POST /api/auth/v1/login(@Public 跳过 JwtAuthGuard)。
  // 默认 POST 返回 201,登录场景没有创建资源,显式 200。
  // V1.1 §11.4 / TASKS.md 15.7:加 @LoginThrottle() 启用 IP 维度限流(参数走 app.config),
  // 命中后 ThrottlerBizGuard 抛 BizException(BizCode.TOO_MANY_REQUESTS) → HTTP 429 +
  // 统一错误体,不暴露阈值/剩余配额/重置时间(无 X-RateLimit-* / Retry-After 头)。
  //
  // P0-E PR-3(2026-05-18):login 成功路径新增写 audit 'auth.login' + 创建 refresh_tokens 行,
  // 因此需要 @Req() 构造 AuditMeta 显式传给 service(沿 P0-D 范式)。
  // 出参 LoginResponseDto 扩展 refreshToken + refreshExpiresAt 2 字段(沿评审稿 §3.1 D-1)。
  @Public()
  @LoginThrottle()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '用户名 + 密码登录,返回 JWT + refresh token(family absolute expiration) [public]',
  })
  @ApiWrappedOkResponse(LoginResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.LOGIN_FAILED, BizCode.TOO_MANY_REQUESTS)
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<LoginResponseDto> {
    return this.authService.login(dto, this.buildAuditMeta(req));
  }

  // P0-E PR-3:POST /api/auth/v1/refresh(沿评审稿 §4.2)。
  // @Public()(refresh 时 access token 通常已过期,不能走 JwtAuthGuard)。
  // @RefreshThrottle() → throttler 实例 'refresh'(30/60 IP;与 default / password-change 物理隔离)。
  // 失败(不存在 / 已撤销 / 已过期 / 重放)统一返 REFRESH_TOKEN_INVALID=10007(不区分子原因)。
  @Public()
  @RefreshThrottle()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'refresh access token(rotation always;family revoke;absolute expiration;返回新 access + 新 refresh) [public]',
  })
  @ApiWrappedOkResponse(LoginResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.REFRESH_TOKEN_INVALID,
    BizCode.TOO_MANY_REQUESTS,
  )
  refresh(@Body() dto: RefreshTokenDto, @Req() req: Request): Promise<LoginResponseDto> {
    return this.authService.refresh(dto, this.buildAuditMeta(req));
  }

  // P0-E PR-3:POST /api/auth/v1/logout(沿评审稿 §4.3)。
  // @Public()(refresh token 自身即凭证;允许 access token 过期后 logout)。
  // 幂等:不存在 / 已撤销 / 已过期 → 仍返 200 + data:null。
  // 只撤销当前 refresh token,同 family 其他 rotation 链不动;不吊销 access token。
  // **不限流**(刻意;避免攻击者吃光合法用户 logout 配额;沿评审稿 §3.7 D-7)。
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '撤销当前 refresh token(幂等;不吊销 access) [public]' })
  @ApiWrappedOkResponse(LogoutAllResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST)
  logout(@Body() dto: LogoutDto, @Req() req: Request): Promise<null> {
    return this.authService.logout(dto, this.buildAuditMeta(req));
  }

  // P0-E PR-3:POST /api/auth/v1/logout-all(沿评审稿 §4.4)。
  // 走 JwtAuthGuard(需知道哪个 user;controller 不标 @Roles,任意登录用户可调)。
  // 复用 @PasswordChangeThrottle() throttler 'password-change' 5/60 IP(高危操作低频限流);
  // 不吊销 access token(沿 D-4);返 { revokedCount }。
  @PasswordChangeThrottle()
  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '撤销该用户全部未过期且未撤销的 refresh token(本人调;不吊销 access) [auth]',
  })
  @ApiWrappedOkResponse(LogoutAllResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.TOO_MANY_REQUESTS)
  logoutAll(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<LogoutAllResponseDto> {
    return this.authService.logoutAll(currentUser, this.buildAuditMeta(req));
  }

  // P0-E PR-3:从 @Req() 构造 AuditMeta 显式传给 service(D6 v1.1 §11.2 / D8 拍板;
  // 不引入 cls-rs / AsyncLocalStorage)。沿 users.controller.ts 范式(line 100-106)。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
