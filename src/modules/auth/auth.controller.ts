import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
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
import { LoginWechatThrottle } from '../../common/decorators/login-wechat-throttle.decorator';
import { LoginWecomThrottle } from '../../common/decorators/login-wecom-throttle.decorator';
import { PasswordChangeThrottle } from '../../common/decorators/password-change-throttle.decorator';
import { PasswordResetThrottle } from '../../common/decorators/password-reset-throttle.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RefreshThrottle } from '../../common/decorators/refresh-throttle.decorator';
import { SmsSendThrottle } from '../../common/decorators/sms-send-throttle.decorator';
import { SmsVerifyThrottle } from '../../common/decorators/sms-verify-throttle.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthService } from './auth.service';
import {
  LoginDto,
  LoginResponseDto,
  LoginSmsDto,
  LoginWechatDto,
  LoginWecomDto,
  LogoutAllResponseDto,
  LogoutDto,
  RefreshTokenDto,
  ResetPasswordBySmsDto,
  SendLoginSmsCodeDto,
  SendPasswordResetCodeDto,
  SendPasswordResetCodeResponseDto,
  SendStepUpSmsCodeDto,
  SendWechatBindCodeDto,
  SendWecomBindCodeDto,
  StepUpPasswordDto,
  StepUpResponseDto,
  StepUpSmsDto,
  StepUpWechatDto,
  WechatBindDto,
  WechatLoginResponseDto,
  WecomAuthorizeDto,
  WecomAuthorizeResponseDto,
  WecomBindDto,
  WecomLoginResponseDto,
} from './auth.dto';
import { LoginSmsService } from './login-sms.service';
import { LoginWechatService } from './login-wechat.service';
import { LoginWecomService } from './login-wecom.service';
import { PasswordResetService } from './password-reset.service';
import { IdentityStepUpService } from './identity-step-up.service';
import {
  clearWecomBrowserNonceCookie,
  readWecomBrowserNonce,
  setWecomBrowserNonceCookie,
  WECOM_BIND_NONCE_COOKIE,
  WECOM_LOGIN_NONCE_COOKIE,
} from './wecom-browser-nonce';

@ApiTags('Auth')
// Route B Phase 4(2026-06-01;沿 docs/api-surface-migration-plan.md §6 Phase 4):
// 老 path 'auth' 已删除(无生产消费者,直接收口);canonical 单一前缀 'auth/v1'。
@Controller('auth/v1')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly passwordReset: PasswordResetService,
    private readonly loginSms: LoginSmsService,
    private readonly loginWechat: LoginWechatService,
    private readonly loginWecom: LoginWecomService,
    private readonly identityStepUp: IdentityStepUpService,
  ) {}

  // POST /api/auth/v1/login(@Public 跳过 JwtAuthGuard)。
  // 默认 POST 返回 201,登录场景没有创建资源,显式 200。
  // docs/reference/auth-jwt-refresh.md §9「限流契约」:
  // 加 @LoginThrottle() 启用 IP 维度限流(参数走 app.config),
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
  // 任一可识别且未过期 row 只用于定位 family；撤销该 family 全部 active 未过期 token。
  // 其他 family 不动；不吊销 access token。
  // **不限流**(刻意;避免攻击者吃光合法用户 logout 配额;沿评审稿 §3.7 D-7)。
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '撤销该 refresh family 内全部未过期且未撤销 token(幂等;不吊销 access) [public]',
  })
  @ApiWrappedNullResponse()
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

  @PasswordChangeThrottle()
  @Post('step-up/password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: '使用当前密码签发 5 分钟身份绑定 step-up proof [auth]' })
  @ApiWrappedOkResponse(StepUpResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.STEP_UP_PROOF_INVALID,
    BizCode.TOO_MANY_REQUESTS,
  )
  stepUpWithPassword(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: StepUpPasswordDto,
    @Req() req: Request,
  ): Promise<StepUpResponseDto> {
    const safeDto: StepUpPasswordDto = { action: dto.action, password: dto.password };
    return this.identityStepUp.stepUpWithPassword(currentUser, safeDto, this.buildAuditMeta(req));
  }

  @SmsSendThrottle()
  @Post('step-up/sms/send-code')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: '向当前绑定手机号发送 identity step-up 验证码 [auth]' })
  @ApiWrappedOkResponse(SendPasswordResetCodeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.STEP_UP_FACTOR_UNAVAILABLE,
    BizCode.SMS_SEND_INTERVAL_LIMIT,
    BizCode.SMS_PHONE_DAILY_LIMIT,
    BizCode.SMS_CHANNEL_NOT_CONFIGURED,
    BizCode.SMS_SEND_FAILED,
    BizCode.TOO_MANY_REQUESTS,
  )
  sendStepUpSmsCode(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: SendStepUpSmsCodeDto,
    @Req() req: Request,
  ): Promise<SendPasswordResetCodeResponseDto> {
    return this.identityStepUp.sendSmsCode(currentUser, dto.action, req.ip ?? null);
  }

  @SmsVerifyThrottle()
  @Post('step-up/sms')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: '使用当前手机号验证码签发 5 分钟身份绑定 step-up proof [auth]' })
  @ApiWrappedOkResponse(StepUpResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.STEP_UP_FACTOR_UNAVAILABLE,
    BizCode.SMS_CODE_INVALID,
    BizCode.TOO_MANY_REQUESTS,
  )
  stepUpWithSms(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: StepUpSmsDto,
    @Req() req: Request,
  ): Promise<StepUpResponseDto> {
    const safeDto: StepUpSmsDto = { action: dto.action, code: dto.code };
    return this.identityStepUp.stepUpWithSms(currentUser, safeDto, this.buildAuditMeta(req));
  }

  @LoginWechatThrottle()
  @Post('step-up/wechat')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: '使用当前微信 openid 签发 5 分钟身份绑定 step-up proof [auth]' })
  @ApiWrappedOkResponse(StepUpResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.STEP_UP_FACTOR_UNAVAILABLE,
    BizCode.WECHAT_CODE_INVALID,
    BizCode.WECHAT_CHANNEL_NOT_CONFIGURED,
    BizCode.WECHAT_API_FAILED,
    BizCode.TOO_MANY_REQUESTS,
  )
  stepUpWithWechat(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: StepUpWechatDto,
    @Req() req: Request,
  ): Promise<StepUpResponseDto> {
    const safeDto: StepUpWechatDto = { action: dto.action, code: dto.code };
    return this.identityStepUp.stepUpWithWechat(currentUser, safeDto, this.buildAuditMeta(req));
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
  // reference/auth-jwt-refresh〕+ audit password.reset.by-sms)。一切失败统一 24010(10006 仅对已验码者可达);
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
  // lastLoginAt 同步)。docs/reference/auth-jwt-refresh.md §8 登录契约已随本 PR 解锁改写,密码登录契约零变化。
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

  // 微信小程序登录 T3(2026-06-12;冻结评审稿 wechat-mini-login-review.md §4.2 / E-16):
  // 第三个独立认证端点;`{code}`→code2session→已绑 createSession 同构签发 /
  // 未绑返 `{bindingRequired:true, session:null}`(非枚举面:openid 必须经持有微信账号的
  // wx.login code 换取);命中但账号 DISABLED / 软删 → 统一 25010(防侧写,镜像 login-sms 范式)。
  // @LoginWechatThrottle() → 第 8 throttler 实例 'login-wechat'(IP 5/60 默认,
  // 与既有七实例物理隔离;不暴露阈值)。
  @Public()
  @LoginWechatThrottle()
  @Post('login-wechat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '微信小程序 code 登录(已绑同构发 token;未绑返 bindingRequired) [public]',
  })
  @ApiWrappedOkResponse(WechatLoginResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.WECHAT_CODE_INVALID,
    BizCode.WECHAT_CHANNEL_NOT_CONFIGURED,
    BizCode.WECHAT_API_FAILED,
    BizCode.TOO_MANY_REQUESTS,
  )
  loginByWechat(@Body() dto: LoginWechatDto, @Req() req: Request): Promise<WechatLoginResponseDto> {
    return this.loginWechat.login(dto, this.buildAuditMeta(req));
  }

  // 微信绑定发码(评审稿 §4.3 send-code):purpose=WECHAT_BIND(手机短信锚点,D-W1);
  // 防枚举沿 login-sms 范式 = 四种无效号码场景泛化 200 零留痕;
  // 有效号限频 / 通道错误照常抛(残余侧信道沿 R-1 接受)。
  @Public()
  @LoginWechatThrottle()
  @Post('wechat-bind/send-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '发送微信绑定短信验证码(防枚举:无效号码返回相同泛化响应) [public]',
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
  sendWechatBindCode(
    @Body() dto: SendWechatBindCodeDto,
    @Req() req: Request,
  ): Promise<SendPasswordResetCodeResponseDto> {
    return this.loginWechat.sendBindCode(dto, req.ip ?? null);
  }

  // 微信首绑/换绑 + 登录(评审稿 §4.3 七步校验顺序冻结):
  // ① code2session(最前,失败不烧 SMS 码)② 解析手机号(四无效 → 24010)
  // ③ 码预检不消费 ④ openid 占用(他人 → 25002,仅对已证手机控制权者可达)
  // ⑤ 原子消费 ⑥ 绑定事务 + audit wechat.{bind,rebind}.self ⑦ createSession 同构签发。
  @Public()
  @LoginWechatThrottle()
  @Post('wechat-bind')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '手机短信锚点绑定微信 openid 并登录(验码即消费;绑定后同构发 token) [public]',
  })
  @ApiWrappedOkResponse(LoginResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.SMS_CODE_INVALID,
    BizCode.WECHAT_CODE_INVALID,
    BizCode.WECHAT_ALREADY_BOUND,
    BizCode.WECHAT_CHANNEL_NOT_CONFIGURED,
    BizCode.WECHAT_API_FAILED,
    BizCode.TOO_MANY_REQUESTS,
  )
  bindWechat(@Body() dto: WechatBindDto, @Req() req: Request): Promise<LoginResponseDto> {
    return this.loginWechat.bind(dto, this.buildAuditMeta(req));
  }

  // ===== 企业微信接入 T3(2026-08-02;冻结稿 §6.2)=====
  //
  // 五个端点全部挂 @LoginWecomThrottle() → throttler 实例 'login-wecom'
  // (第 11 个,IP 5/60 默认,与既有十实例物理隔离;不暴露阈值)。
  // 三条 pre-auth 端点标 @Public();wecom-bind/authorize **不标** —— 它是登录态自助绑定的
  // 第一步,必须知道 subjectUserId 才能把 state 锚到本人。
  //
  // ⚠️ 开关关闭(loginEnabled=false,D-WC-24 默认即关)时五个端点一律 36030,
  // 由 WecomService 的闸门链判定,不在 controller 复制一份开关判断。

  @Public()
  @LoginWecomThrottle()
  @Post('login-wecom/authorize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '签发企业微信 OAuth 登录授权 URL(snsapi_base;state 一次性 5 分钟) [public]',
  })
  @ApiWrappedOkResponse(WecomAuthorizeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.WECOM_CHANNEL_NOT_CONFIGURED,
    BizCode.TOO_MANY_REQUESTS,
  )
  async authorizeWecomLogin(
    @Body() dto: WecomAuthorizeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WecomAuthorizeResponseDto> {
    // B1:同一次 authorize 产出两个原值,去向严格分开 ——
    // `state` 进 URL(会经企业微信重定向暴露),nonce 只进 `__Host-` Cookie。
    // 响应体里没有 nonce,也不该有(见 IssuedWecomAuthorize 的注释)。
    const issued = await this.loginWecom.authorizeForLogin({ returnPath: dto.returnPath });
    setWecomBrowserNonceCookie(res, WECOM_LOGIN_NONCE_COOKIE, issued.browserNonce);
    return issued.dto;
  }

  // 已绑定 → 同构签发 session;未绑定 → `{bindingRequired:true, bindingTicket}`。
  // 未绑定响应**不含** hasPhone / 手机号尾号 / 账号状态 / wecomUserId / corpId(§6.2 规则 9)。
  // 绑定指向 DISABLED / 软删 User → 与 code 无效同码同形 36010(防侧写)。
  @Public()
  @LoginWecomThrottle()
  @Post('login-wecom')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '企业微信 OAuth code 登录(已绑同构发 token;未绑返 bindingRequired + ticket) [public]',
  })
  @ApiWrappedOkResponse(WecomLoginResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.WECOM_LOGIN_CREDENTIAL_INVALID,
    BizCode.WECOM_CHANNEL_NOT_CONFIGURED,
    BizCode.WECOM_API_FAILED,
    BizCode.TOO_MANY_REQUESTS,
  )
  async loginByWecom(
    @Body() dto: LoginWecomDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WecomLoginResponseDto> {
    const safeDto: LoginWecomDto = { code: dto.code, state: dto.state };
    // B1:浏览器归属证据来自 `__Host-` Cookie,不是 body ——
    // 放 body 里等于让攻击者连这一半也能自己填。
    const browserNonce = readWecomBrowserNonce(req, WECOM_LOGIN_NONCE_COOKIE);
    // state 是一次性的,对应的 nonce 无论本次成败都不该再留在浏览器里
    // (成功 = 已消费;失败 = 这个浏览器本来就配不上它)。
    // 放在 await 之前:失败路径会抛异常,写在后面就只有成功路径清得掉。
    clearWecomBrowserNonceCookie(res, WECOM_LOGIN_NONCE_COOKIE);
    return this.loginWecom.login(safeDto, browserNonce, this.buildAuditMeta(req));
  }

  // 同时挂 login-wecom 与 SMS send 两个限流器(§6.2:"同时挂登录 WeCom 限流和既有 SMS send 限流")。
  // 防枚举:五种无效场景返回与有效号逐字段相同的泛化 200,不发码不留痕。
  @Public()
  @LoginWecomThrottle()
  @SmsSendThrottle()
  @Post('wecom-bind/send-code')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '发送企业微信绑定短信验证码(ticket 只校验不消费;防枚举泛化响应) [public]',
  })
  @ApiWrappedOkResponse(SendPasswordResetCodeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.WECOM_BINDING_TICKET_INVALID,
    BizCode.SMS_SEND_INTERVAL_LIMIT,
    BizCode.SMS_PHONE_DAILY_LIMIT,
    BizCode.SMS_CHANNEL_NOT_CONFIGURED,
    BizCode.SMS_SEND_FAILED,
    BizCode.TOO_MANY_REQUESTS,
  )
  sendWecomBindCode(
    @Body() dto: SendWecomBindCodeDto,
    @Req() req: Request,
  ): Promise<SendPasswordResetCodeResponseDto> {
    return this.loginWecom.sendBindCode(dto, req.ip ?? null);
  }

  // 首次绑定(D-WC-6:锚点 = 已验证的账号控制权 = 现有 User.phone + 短信码;禁目录猜人)。
  // 七步校验顺序冻结(§6.2),实施不得调换。
  @Public()
  @LoginWecomThrottle()
  @SmsVerifyThrottle()
  @Post('wecom-bind')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '手机短信锚点绑定企业微信身份并登录(验码即消费;绑定后同构发 token) [public]',
  })
  @ApiWrappedOkResponse(LoginResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.SMS_CODE_INVALID,
    BizCode.WECOM_IDENTITY_ALREADY_BOUND,
    BizCode.WECOM_LOGIN_CREDENTIAL_INVALID,
    BizCode.WECOM_BINDING_TICKET_INVALID,
    BizCode.WECOM_CHANNEL_NOT_CONFIGURED,
    BizCode.WECOM_API_FAILED,
    BizCode.TOO_MANY_REQUESTS,
  )
  bindWecom(@Body() dto: WecomBindDto, @Req() req: Request): Promise<LoginResponseDto> {
    return this.loginWecom.bind(dto, this.buildAuditMeta(req));
  }

  // 本人绑定 / 换绑前签发 purpose=bind_self 的 state(D-WC-8)。
  // **需登录**:attempt 固定 subjectUserId=currentUser.id,随后 PUT app/v1/me/wecom
  // 会校验消费到的 state 属于本人 —— "拿别人的 state 绑自己"在消费那步就断掉。
  @LoginWecomThrottle()
  @Post('wecom-bind/authorize')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '签发本人企业微信绑定 / 换绑授权 URL(state 锚定当前登录用户) [auth]',
  })
  @ApiWrappedOkResponse(WecomAuthorizeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.WECOM_CHANNEL_NOT_CONFIGURED,
    BizCode.TOO_MANY_REQUESTS,
  )
  async authorizeWecomBindSelf(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: WecomAuthorizeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WecomAuthorizeResponseDto> {
    // B1:登录态换绑同样绑定发起浏览器。Cookie 名与登录流程**刻意不同** ——
    // 同一浏览器里两条流程并存时不该互相冲掉(purpose 在台账层本来就是隔离的)。
    const issued = await this.loginWecom.authorizeForBindSelf(currentUser, {
      returnPath: dto.returnPath,
    });
    setWecomBrowserNonceCookie(res, WECOM_BIND_NONCE_COOKIE, issued.browserNonce);
    return issued.dto;
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
