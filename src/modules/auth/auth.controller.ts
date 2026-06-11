import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  ApiBizErrorResponse,
  ApiWrappedNullResponse,
  ApiWrappedOkResponse,
} from '../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../common/decorators/current-user.decorator';
import { LoginSmsThrottle } from '../../common/decorators/login-sms-throttle.decorator';
import { LoginThrottle } from '../../common/decorators/login-throttle.decorator';
import { PasswordChangeThrottle } from '../../common/decorators/password-change-throttle.decorator';
import { PasswordResetThrottle } from '../../common/decorators/password-reset-throttle.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RefreshThrottle } from '../../common/decorators/refresh-throttle.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthService } from './auth.service';
import {
  LoginDto,
  LoginResponseDto,
  LoginSmsDto,
  LogoutAllResponseDto,
  LogoutDto,
  RefreshTokenDto,
  ResetPasswordBySmsDto,
  SendLoginSmsCodeDto,
  SendPasswordResetCodeDto,
  SendPasswordResetCodeResponseDto,
} from './auth.dto';
import { LoginSmsService } from './login-sms.service';
import { PasswordResetService } from './password-reset.service';

@ApiTags('Auth')
// Route B Phase 4(2026-06-01;沿 docs/api-surface-migration-plan.md §6 Phase 4):
// 老 path 'auth' 已删除(无生产消费者,直接收口);canonical 单一前缀 'auth/v1'。
@Controller('auth/v1')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly passwordReset: PasswordResetService,
    private readonly loginSms: LoginSmsService,
  ) {}

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

  // 找回密码 T2(2026-06-11;冻结评审稿 password-reset-by-sms-review.md §3.2 ① / §4):
  // pre-auth 公开端点;防枚举 = 四种无效号码场景(不存在 / 未绑定 / 被禁用 / 已软删)
  // 返回与有效号**完全相同**的泛化 200(不发码不留痕);有效号限频 / 通道错误照常抛
  // (仅对有效号可达,评审稿 E-4 残余侧信道已接受并成文 R-1)。
  // @PasswordResetThrottle() → 第 6 throttler 实例 'password-reset'(IP 3/60s 默认,
  // 与既有五实例物理隔离;不暴露阈值)。
  @Public()
  @PasswordResetThrottle()
  @Post('password-reset/send-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '发送找回密码短信验证码(防枚举:无效号码返回相同泛化响应) [public]',
  })
  @ApiWrappedOkResponse(SendPasswordResetCodeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.SMS_SEND_INTERVAL_LIMIT,
    BizCode.SMS_PHONE_DAILY_LIMIT,
    BizCode.SMS_CHANNEL_NOT_CONFIGURED,
    BizCode.SMS_SEND_FAILED,
    BizCode.TOO_MANY_REQUESTS,
  )
  sendPasswordResetCode(
    @Body() dto: SendPasswordResetCodeDto,
    @Req() req: Request,
  ): Promise<SendPasswordResetCodeResponseDto> {
    return this.passwordReset.sendCode(dto, req.ip ?? null);
  }

  // 找回密码 T2(评审稿 §3.2 ② / E-5 校验顺序冻结):
  // 解析用户 → 码预检(不消费)→ 10006(不烧码,可换密码同码重试)→ 原子消费 →
  // 事务(改密 + 撤销全部未撤销未过期 refresh 'self-password-reset'〔联动撤销第 5 场景,
  // AGENTS §9〕+ audit password.reset.by-sms)。一切失败统一 24010(10006 仅对已验码者可达);
  // 成功 data:null——不返 token、不自动登录(D-PR-1);access 沿 D-4 不吊销。
  @Public()
  @PasswordResetThrottle()
  @Post('password-reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '短信验证码重置密码(撤销全部 refresh;不自动登录) [public]',
  })
  @ApiWrappedNullResponse()
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.SMS_CODE_INVALID,
    BizCode.NEW_PASSWORD_SAME_AS_OLD,
    BizCode.TOO_MANY_REQUESTS,
  )
  resetPasswordBySms(@Body() dto: ResetPasswordBySmsDto, @Req() req: Request): Promise<null> {
    return this.passwordReset.reset(dto, this.buildAuditMeta(req));
  }

  // OTP 登录 F4-T2(2026-06-11;冻结评审稿 queue-b-otp-birthday-infra-review.md §5.2 ① / E-O4):
  // pre-auth 公开端点;防枚举完全沿找回密码范式 = 四种无效号码场景(不存在 / 未绑定 /
  // 被禁用 / 已软删)返回与有效号**完全相同**的泛化 200(不发码不留痕);
  // 有效号限频 / 通道错误照常抛(仅对有效号可达,残余侧信道沿评审稿 R-10 接受)。
  // @LoginSmsThrottle() → 第 7 throttler 实例 'login-sms'(IP 5/60s 默认 goal 拍板,
  // 与既有六实例物理隔离;不暴露阈值)。
  @Public()
  @LoginSmsThrottle()
  @Post('login-sms/send-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '发送验证码登录短信验证码(防枚举:无效号码返回相同泛化响应) [public]',
  })
  @ApiWrappedOkResponse(SendPasswordResetCodeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.SMS_SEND_INTERVAL_LIMIT,
    BizCode.SMS_PHONE_DAILY_LIMIT,
    BizCode.SMS_CHANNEL_NOT_CONFIGURED,
    BizCode.SMS_SEND_FAILED,
    BizCode.TOO_MANY_REQUESTS,
  )
  sendLoginSmsCode(
    @Body() dto: SendLoginSmsCodeDto,
    @Req() req: Request,
  ): Promise<SendPasswordResetCodeResponseDto> {
    return this.loginSms.sendCode(dto, req.ip ?? null);
  }

  // OTP 登录 F4-T2(评审稿 §5.2 ② / E-O5 校验顺序冻结):
  // 解析用户(四无效场景 → 24010)→ verifyAndConsume(LOGIN 码原子消费)→
  // createSession(与密码登录同构签发,E-O6;audit 'auth.login.sms')。
  // 一切失败统一 24010(不用 10004——两套防枚举体系各自闭合,零新增 BizCode);
  // 成功响应 = LoginResponseDto(与密码登录**同 DTO**;同 refresh family 机制 /
  // lastLoginAt 同步)。AGENTS §8 登录契约行已随本 PR 解锁改写,密码登录契约零变化。
  @Public()
  @LoginSmsThrottle()
  @Post('login-sms')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '手机号 + 短信验证码登录(OTP;与密码登录同构发 token) [public]',
  })
  @ApiWrappedOkResponse(LoginResponseDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.SMS_CODE_INVALID, BizCode.TOO_MANY_REQUESTS)
  loginBySms(@Body() dto: LoginSmsDto, @Req() req: Request): Promise<LoginResponseDto> {
    return this.loginSms.login(dto, this.buildAuditMeta(req));
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
