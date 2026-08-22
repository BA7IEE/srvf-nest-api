// 由 scripts/generate-fe-client.ts 生成,请勿手改。
// surface: Auth 登录/令牌(admin 与 app 共用)
// contractVersion: 0.67.0
// generatorVersion: 1.0.0
// inputDigest: sha256:8644abdaaa458e7d39f2dcfd0f72bb29242ddeee04ae3eb06b0bca0b94e1376a
//
// ⚠️ 本文件**只有类型与调用签名**:不含 baseURL、不含令牌、不含任何鉴权逻辑。
//    登录态怎么带、令牌怎么刷新,由消费方在注入的 Fetcher 里自理
//    (登录/刷新的三步接线见 docs/handoff/admin-web.md §3.1)。

import type {
  ApiEnvelope,
  PageResult,
  FetchRequest,
  Fetcher,
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
} from './types';

export type { ApiEnvelope, PageResult, FetchRequest, Fetcher };

export function createAuthClient(fetcher: Fetcher) {
  return {
    /** 用户名 + 密码登录,返回 JWT + refresh token(family absolute expiration) [public] */
    AuthControllerLogin(body: LoginDto): Promise<ApiEnvelope<LoginResponseDto>> {
      return fetcher<LoginResponseDto>({ method: "POST", path: "/api/auth/v1/login", body });
    },
    /** 手机号 + 短信验证码登录(OTP;与密码登录同构发 token) [public] */
    AuthControllerLoginBySms(body: LoginSmsDto): Promise<ApiEnvelope<LoginResponseDto>> {
      return fetcher<LoginResponseDto>({ method: "POST", path: "/api/auth/v1/login-sms", body });
    },
    /** 发送验证码登录短信验证码(防枚举:无效号码返回相同泛化响应) [public] */
    AuthControllerSendLoginSmsCode(body: SendLoginSmsCodeDto): Promise<ApiEnvelope<SendPasswordResetCodeResponseDto>> {
      return fetcher<SendPasswordResetCodeResponseDto>({ method: "POST", path: "/api/auth/v1/login-sms/send-code", body });
    },
    /** 微信小程序 code 登录(已绑同构发 token;未绑返 bindingRequired) [public] */
    AuthControllerLoginByWechat(body: LoginWechatDto): Promise<ApiEnvelope<WechatLoginResponseDto>> {
      return fetcher<WechatLoginResponseDto>({ method: "POST", path: "/api/auth/v1/login-wechat", body });
    },
    /** 企业微信 OAuth code 登录(已绑同构发 token;未绑返 bindingRequired + ticket) [public] */
    AuthControllerLoginByWecom(body: LoginWecomDto): Promise<ApiEnvelope<WecomLoginResponseDto>> {
      return fetcher<WecomLoginResponseDto>({ method: "POST", path: "/api/auth/v1/login-wecom", body });
    },
    /** 签发企业微信 OAuth 登录授权 URL(snsapi_base;state 一次性 5 分钟) [public] */
    AuthControllerAuthorizeWecomLogin(body: WecomAuthorizeDto): Promise<ApiEnvelope<WecomAuthorizeResponseDto>> {
      return fetcher<WecomAuthorizeResponseDto>({ method: "POST", path: "/api/auth/v1/login-wecom/authorize", body });
    },
    /** 撤销该 refresh family 内全部未过期且未撤销 token(幂等;不吊销 access) [public] */
    AuthControllerLogout(body: LogoutDto): Promise<ApiEnvelope<Record<string, unknown> | null>> {
      return fetcher<Record<string, unknown> | null>({ method: "POST", path: "/api/auth/v1/logout", body });
    },
    /** 撤销该用户全部未过期且未撤销的 refresh token(本人调;不吊销 access) [auth] */
    AuthControllerLogoutAll(): Promise<ApiEnvelope<LogoutAllResponseDto>> {
      return fetcher<LogoutAllResponseDto>({ method: "POST", path: "/api/auth/v1/logout-all" });
    },
    /** 短信验证码重置密码(撤销全部 refresh;不自动登录) [public] */
    AuthControllerResetPasswordBySms(body: ResetPasswordBySmsDto): Promise<ApiEnvelope<Record<string, unknown> | null>> {
      return fetcher<Record<string, unknown> | null>({ method: "POST", path: "/api/auth/v1/password-reset", body });
    },
    /** 发送找回密码短信验证码(防枚举:无效号码返回相同泛化响应) [public] */
    AuthControllerSendPasswordResetCode(body: SendPasswordResetCodeDto): Promise<ApiEnvelope<SendPasswordResetCodeResponseDto>> {
      return fetcher<SendPasswordResetCodeResponseDto>({ method: "POST", path: "/api/auth/v1/password-reset/send-code", body });
    },
    /** refresh access token(rotation always;family revoke;absolute expiration;返回新 access + 新 refresh) [public] */
    AuthControllerRefresh(body: RefreshTokenDto): Promise<ApiEnvelope<LoginResponseDto>> {
      return fetcher<LoginResponseDto>({ method: "POST", path: "/api/auth/v1/refresh", body });
    },
    /** 使用当前密码签发 5 分钟身份绑定 step-up proof [auth] */
    AuthControllerStepUpWithPassword(body: StepUpPasswordDto): Promise<ApiEnvelope<StepUpResponseDto>> {
      return fetcher<StepUpResponseDto>({ method: "POST", path: "/api/auth/v1/step-up/password", body });
    },
    /** 使用当前手机号验证码签发 5 分钟身份绑定 step-up proof [auth] */
    AuthControllerStepUpWithSms(body: StepUpSmsDto): Promise<ApiEnvelope<StepUpResponseDto>> {
      return fetcher<StepUpResponseDto>({ method: "POST", path: "/api/auth/v1/step-up/sms", body });
    },
    /** 向当前绑定手机号发送 identity step-up 验证码 [auth] */
    AuthControllerSendStepUpSmsCode(body: SendStepUpSmsCodeDto): Promise<ApiEnvelope<SendPasswordResetCodeResponseDto>> {
      return fetcher<SendPasswordResetCodeResponseDto>({ method: "POST", path: "/api/auth/v1/step-up/sms/send-code", body });
    },
    /** 使用当前微信 openid 签发 5 分钟身份绑定 step-up proof [auth] */
    AuthControllerStepUpWithWechat(body: StepUpWechatDto): Promise<ApiEnvelope<StepUpResponseDto>> {
      return fetcher<StepUpResponseDto>({ method: "POST", path: "/api/auth/v1/step-up/wechat", body });
    },
    /** 手机短信锚点绑定微信 openid 并登录(验码即消费;绑定后同构发 token) [public] */
    AuthControllerBindWechat(body: WechatBindDto): Promise<ApiEnvelope<LoginResponseDto>> {
      return fetcher<LoginResponseDto>({ method: "POST", path: "/api/auth/v1/wechat-bind", body });
    },
    /** 发送微信绑定短信验证码(防枚举:无效号码返回相同泛化响应) [public] */
    AuthControllerSendWechatBindCode(body: SendWechatBindCodeDto): Promise<ApiEnvelope<SendPasswordResetCodeResponseDto>> {
      return fetcher<SendPasswordResetCodeResponseDto>({ method: "POST", path: "/api/auth/v1/wechat-bind/send-code", body });
    },
    /** 手机短信锚点绑定企业微信身份并登录(验码即消费;绑定后同构发 token) [public] */
    AuthControllerBindWecom(body: WecomBindDto): Promise<ApiEnvelope<LoginResponseDto>> {
      return fetcher<LoginResponseDto>({ method: "POST", path: "/api/auth/v1/wecom-bind", body });
    },
    /** 签发本人企业微信绑定 / 换绑授权 URL(state 锚定当前登录用户) [auth] */
    AuthControllerAuthorizeWecomBindSelf(body: WecomAuthorizeDto): Promise<ApiEnvelope<WecomAuthorizeResponseDto>> {
      return fetcher<WecomAuthorizeResponseDto>({ method: "POST", path: "/api/auth/v1/wecom-bind/authorize", body });
    },
    /** 发送企业微信绑定短信验证码(ticket 只校验不消费;防枚举泛化响应) [public] */
    AuthControllerSendWecomBindCode(body: SendWecomBindCodeDto): Promise<ApiEnvelope<SendPasswordResetCodeResponseDto>> {
      return fetcher<SendPasswordResetCodeResponseDto>({ method: "POST", path: "/api/auth/v1/wecom-bind/send-code", body });
    },
  };
}
