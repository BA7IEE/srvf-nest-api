import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { OmittableOnly } from '../../common/decorators/omittable-only.decorator';
import { MAINLAND_PHONE_PATTERN, SMS_CODE_LENGTH } from '../sms/sms.constants';
import { WECOM_RETURN_PATH_MAX_LENGTH } from '../wecom/wecom.constants';

// 登录入参严格按 ARCHITECTURE.md §6 / §7.6:仅 username + password,
// 不支持 email / 手机号 / 验证码登录。
//
// username 校验策略:
// - DTO 层做格式与长度校验(3-32,字母/数字/下划线/中横线),允许大小写
// - service 内部统一 trim() + toLowerCase() 后用于查询
//
// password 校验策略:
// - 仅 @IsString + @IsNotEmpty,不做 @MinLength
// - 登录阶段不应通过密码长度规则区分失败原因(防泄漏密码强度规则)
export class LoginDto {
  @ApiProperty({
    description:
      '用户名(允许字母 / 数字 / 下划线 / 中横线,长度 3-32);' +
      'service 内部统一 trim + lowercase 后用于查询',
    example: 'admin',
    minLength: 3,
    maxLength: 32,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'username 只允许字母 / 数字 / 下划线 / 中横线',
  })
  username!: string;

  @ApiProperty({
    description: '密码(明文,服务端用 bcrypt 比对);此接口刻意不做长度规则校验',
    example: 'YourPassword123',
    format: 'password',
  })
  @IsString()
  @IsNotEmpty()
  password!: string;
}

// P0-E PR-3(2026-05-18):LoginResponseDto 扩展 refreshToken + refreshExpiresAt 2 字段
// (向后兼容;旧前端忽略未知字段;字段集恰好 5 项;扩展后禁止再增字段)。
// 沿 docs/first-release-p0e-refresh-token-review.md §3.1 D-1。
export class LoginResponseDto {
  @ApiProperty({ description: 'JWT access token,前端拼 Authorization: Bearer <token>' })
  accessToken!: string;

  @ApiProperty({ description: 'token 类型', example: 'Bearer' })
  tokenType!: 'Bearer';

  @ApiProperty({
    description: '过期时间,原样回传 JWT_EXPIRES_IN 配置值',
    example: '15m',
  })
  expiresIn!: string;

  // P0-E PR-3:refresh token(opaque random 256bit base64url;不是 JWT)。
  // 客户端不应也不能解析其中信息;明文绝不入日志 / audit / OpenAPI 示例 / 测试快照。
  // 前端调 POST /api/auth/v1/refresh 用此 token 换取新的 access + refresh(rotation always)。
  @ApiProperty({
    description: 'refresh token(opaque random;不是 JWT);用于 POST /api/auth/v1/refresh 换 access',
  })
  refreshToken!: string;

  // P0-E PR-3:refresh token family absolute expiration 时刻
  // (ISO 8601 UTC 字符串;new Date(...).toISOString() 格式)。
  // rotation 后所有新 refresh token 继承同一个 refreshExpiresAt,不延长;
  // 达到此时刻后必须重新登录(POST /api/auth/v1/login);refresh 接口对已过期 family
  // 返 REFRESH_TOKEN_INVALID=10007。客户端无需信任本地时钟做 now + TTL 计算。
  @ApiProperty({
    description:
      'refresh token family absolute expiration 时刻(ISO 8601 UTC);rotation 后新 token 继承同一时刻;' +
      '达到此时刻后必须重新登录;客户端读此字段即知 family 何时过期,无需本地时钟参与',
    example: '2026-08-16T00:00:00.000Z',
  })
  refreshExpiresAt!: string;
}

// P0-E PR-3:POST /api/auth/v1/refresh 入参(沿评审稿 §4.2;严格白名单 1 字段)。
export class RefreshTokenDto {
  @ApiProperty({
    description: 'refresh token 明文(login / 上一次 refresh 接口响应里拿到的 data.refreshToken)',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

// P0-E PR-3:POST /api/auth/v1/logout 入参(沿评审稿 §4.3;严格白名单 1 字段)。
// 与 RefreshTokenDto 字段结构相同;独立类型用于 OpenAPI 区分 + 未来分化可能。
export class LogoutDto {
  @ApiProperty({
    description:
      '用于定位 refresh family 的 token 明文;撤销该 family 全部未过期且未撤销 token;' +
      '幂等(不存在 / 已撤销 / 已过期 → 仍返 200)',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}

// P0-E PR-3:POST /api/auth/v1/logout-all 响应 data(沿评审稿 §4.4)。
export class LogoutAllResponseDto {
  @ApiProperty({
    description: '本次撤销的 refresh token 行数(未过期且未撤销的总数)',
    example: 3,
  })
  revokedCount!: number;
}

export enum StepUpAction {
  PHONE_BIND = 'PHONE_BIND',
  WECHAT_BIND = 'WECHAT_BIND',
  // 企业微信接入 T3(2026-08-02;冻结稿 §7.4)。
  // ⚠️ 只新增 **action**,**不**新增 `IdentityStepUpFactor.WECOM` ——
  // 用户仍用现有 PASSWORD / SMS / WECHAT 因子证明"当前账号控制权"。
  // 拿企业微信本身当因子会绕成一个圈:正要绑的东西不能同时充当"我已经是这个人"的证据。
  WECOM_BIND = 'WECOM_BIND',
  // P1-32 PR 5(2026-08-24;冻结稿 §12.2 逐字的 action 名)。
  //
  // ⚠️ **这一条不是"身份绑定"** —— 前三条都是「本人绑手机 / 微信 / 企微」,
  //    这一条是管理端的高风险配置变更。共用同一套 step-up 机制是刻意的
  //    (冻结稿 §12.2 末句「实际接入必须沿用 auth 模块现有 step-up 机制」),
  //    但它的 proof **额外绑定**一个 (roleId, expectedRevision, payloadHash) 三元组,
  //    见下方 `StepUpRolePermissionSetDto`。
  //
  // ⚠️ 因子仍是 PASSWORD / SMS / WECHAT 三选一。**默认走密码** ——
  //    微信因子依赖企微/微信通道,而企微卡在备案(current-state §4 P0),
  //    默认走它会让整条路在上线前根本走不通。
  RBAC_ROLE_PERMISSION_SET_REPLACE = 'RBAC_ROLE_PERMISSION_SET_REPLACE',
}

/**
 * `RBAC_ROLE_PERMISSION_SET_REPLACE` 的绑定三元组(P1-32 PR 5;冻结稿 §12.2)。
 *
 * 🔴 **proof 不能只证明「刚刚做过一次二次验证」**(冻结稿 §12.2 标题逐字)。
 *    这三项各挡一种滥用,缺一条那一维就形同虚设:
 *      · `roleId`           —— 为角色 A 申请的 proof 用到角色 B
 *      · `expectedRevision` —— revision 变化后复用旧 proof
 *      · `payloadHash`      —— 为低风险差异申请的 proof 换成高风险 payload
 *
 * ⚠️ 三项都**必填**:任一项缺失都会让签发端返 40000,而不是"少绑一维照样发一个 proof"。
 */
export class StepUpRolePermissionSetDto {
  @ApiProperty({
    description: '要改权限集的角色 id(cuid;proof 只对这一个角色有效)',
    example: 'cl9z3a8b00000abcd1234efgh',
    minLength: 8,
    maxLength: 64,
  })
  @IsString()
  @Length(8, 64)
  roleId!: string;

  @ApiProperty({
    description:
      '这次替换携带的 `expectedRevision`(必须与随后 PUT / preview 里的那个逐字相同);' +
      '版本号一变,旧 proof 立刻失效',
    example: 7,
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({
    description:
      '目标权限码集合的规范化指纹(去重 + 升序后 sha256,base64url)。' +
      '与随后提交的 `permissionCodes` 算出来的必须一致 —— 改一个码就对不上。' +
      '前端算法见 `docs/handoff/admin-web.md`;服务端实现是 `rolePermissionSetPayloadHash()`。',
    example: 'Yk9m0Q0nX0f5nUj2mQ0wEXAMPLEEXAMPLEEXAMPLE0',
    minLength: 16,
    maxLength: 128,
  })
  @IsString()
  @Length(16, 128)
  payloadHash!: string;
}

export class StepUpPasswordDto {
  @ApiProperty({ description: '本次 proof 允许执行的身份动作', enum: StepUpAction })
  @IsEnum(StepUpAction)
  action!: StepUpAction;

  @ApiProperty({ description: '当前账号密码', format: 'password' })
  @IsString()
  @IsNotEmpty()
  password!: string;

  @ApiPropertyOptional({
    description:
      '仅 `action=RBAC_ROLE_PERMISSION_SET_REPLACE` 时**必填**:proof 要绑定的角色权限集变更。' +
      '其余 action 传了也不参与签名。缺它而 action 是那一条 → 40000。',
    type: () => StepUpRolePermissionSetDto,
  })
  // ⚠️ `@OmittableOnly()` 而不是 `@IsOptional()`:这个对象业务上**不可清空**,只是可省略。
  //    `@IsOptional()` 会让显式 `null` 跳过全部校验器,而 service 判「传没传」用的是
  //    `=== undefined` —— 于是 `rolePermissionSet: null` 会被当成"没传"、静默退回
  //    「只绑身份」的 proof,正好把冻结稿 §12.2 要挡的复用面重新打开。
  @OmittableOnly()
  @ValidateNested()
  @Type(() => StepUpRolePermissionSetDto)
  rolePermissionSet?: StepUpRolePermissionSetDto;
}

export class SendStepUpSmsCodeDto {
  @ApiProperty({
    description: '随后短信 step-up proof 允许执行的身份动作;验证码只发往当前绑定手机号',
    enum: StepUpAction,
  })
  @IsEnum(StepUpAction)
  action!: StepUpAction;
}

export class StepUpSmsDto {
  @ApiProperty({ description: '本次 proof 允许执行的身份动作', enum: StepUpAction })
  @IsEnum(StepUpAction)
  action!: StepUpAction;

  @ApiProperty({ description: '当前绑定手机号收到的 6 位数字验证码' })
  @IsString()
  @Length(SMS_CODE_LENGTH, SMS_CODE_LENGTH)
  @Matches(/^\d{6}$/, { message: 'code 必须是 6 位数字' })
  code!: string;

  @ApiPropertyOptional({
    description: '同 `StepUpPasswordDto.rolePermissionSet`',
    type: () => StepUpRolePermissionSetDto,
  })
  // ⚠️ `@OmittableOnly()` 而不是 `@IsOptional()`:这个对象业务上**不可清空**,只是可省略。
  //    `@IsOptional()` 会让显式 `null` 跳过全部校验器,而 service 判「传没传」用的是
  //    `=== undefined` —— 于是 `rolePermissionSet: null` 会被当成"没传"、静默退回
  //    「只绑身份」的 proof,正好把冻结稿 §12.2 要挡的复用面重新打开。
  @OmittableOnly()
  @ValidateNested()
  @Type(() => StepUpRolePermissionSetDto)
  rolePermissionSet?: StepUpRolePermissionSetDto;
}

export class StepUpWechatDto {
  @ApiProperty({ description: '本次 proof 允许执行的身份动作', enum: StepUpAction })
  @IsEnum(StepUpAction)
  action!: StepUpAction;

  @ApiProperty({
    description: '微信小程序 wx.login() 产出的一次性 code;解析出的 openid 必须等于当前绑定值',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  code!: string;

  @ApiPropertyOptional({
    description: '同 `StepUpPasswordDto.rolePermissionSet`',
    type: () => StepUpRolePermissionSetDto,
  })
  // ⚠️ `@OmittableOnly()` 而不是 `@IsOptional()`:这个对象业务上**不可清空**,只是可省略。
  //    `@IsOptional()` 会让显式 `null` 跳过全部校验器,而 service 判「传没传」用的是
  //    `=== undefined` —— 于是 `rolePermissionSet: null` 会被当成"没传"、静默退回
  //    「只绑身份」的 proof,正好把冻结稿 §12.2 要挡的复用面重新打开。
  @OmittableOnly()
  @ValidateNested()
  @Type(() => StepUpRolePermissionSetDto)
  rolePermissionSet?: StepUpRolePermissionSetDto;
}

export class StepUpResponseDto {
  @ApiProperty({ description: '5 分钟 action-bound step-up proof;仅用于身份绑定请求' })
  stepUpToken!: string;

  @ApiProperty({ description: 'proof 绝对过期时刻(ISO 8601 UTC)' })
  expiresAt!: string;
}

// ===== 找回密码 T2(2026-06-11;冻结评审稿 password-reset-by-sms-review.md §3.2 / E-8/E-9)=====
//
// pre-auth DTO 纪律:严格字段白名单(forbidNonWhitelisted 兜底);
// phone 沿 MAINLAND_PHONE_PATTERN(SMS 评审稿 E-17),code 沿 6 位数字,
// newPassword **镜像 ChangeMyPasswordDto.newPassword**(8-128 + 字母数字);
// 响应永不含验证码 / token / 用户字段(防枚举 §4 + D-PR-1 不自动登录)。

export class SendPasswordResetCodeDto {
  @ApiProperty({
    description: '账号绑定的大陆手机号(11 位);防枚举:无效号码返回完全相同的泛化响应',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;
}

export class SendPasswordResetCodeResponseDto {
  @ApiProperty({ description: '验证码有效期(秒;固定 300)', example: 300 })
  expiresInSeconds!: number;
}

// ===== OTP 登录 F4-T2(2026-06-11;冻结评审稿 queue-b-otp-birthday-infra-review.md §5.2 / E-O8)=====
//
// pre-auth DTO 纪律同找回密码:严格字段白名单;phone 沿 MAINLAND_PHONE_PATTERN,
// code 沿 6 位数字;登录成功响应**复用 LoginResponseDto**(与密码登录同 DTO,goal 拍板);
// send-code 响应复用 SendPasswordResetCodeResponseDto 形状(同模块内复用,非跨模块)。

export class SendLoginSmsCodeDto {
  @ApiProperty({
    description: '账号绑定的大陆手机号(11 位);防枚举:无效号码返回完全相同的泛化响应',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;
}

export class LoginSmsDto {
  @ApiProperty({
    description: '账号绑定的大陆手机号(11 位;须与 send-code 时一致)',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;

  @ApiProperty({ description: '6 位数字验证码', example: '123456' })
  @IsString()
  @Length(SMS_CODE_LENGTH, SMS_CODE_LENGTH)
  @Matches(/^\d{6}$/, { message: 'code 必须是 6 位数字' })
  code!: string;
}

// ===== 微信小程序登录 T3(2026-06-12;冻结评审稿 wechat-mini-login-review.md §3.2 / §4 / E-16/E-25)=====
//
// pre-auth DTO 纪律同上:严格字段白名单;wx code 为不透明短串(@MaxLength 128,微信 code
// 实际 ~32 字符,留余量不锁死);phone 沿 MAINLAND_PHONE_PATTERN,smsCode 沿 6 位数字;
// 登录/绑定成功的会话部分**复用 LoginResponseDto**(与密码/OTP 登录同 DTO);
// 响应永不含 openid 明文 / session_key / wx code(E-12;openid 仅 me/wechat 掩码后回显)。

const WECHAT_CODE_MAX_LENGTH = 128;

export class LoginWechatDto {
  @ApiProperty({
    description: '微信小程序 wx.login() 产出的一次性 code(5 分钟有效,单次消费)',
    maxLength: WECHAT_CODE_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(WECHAT_CODE_MAX_LENGTH)
  code!: string;
}

export class WechatLoginResponseDto {
  @ApiProperty({
    description:
      '该微信 openid 是否尚未绑定账号:true = 未绑定(session=null,客户端引导走 wechat-bind 流程,届时重新 wx.login 取新 code);false = 已绑定并签发会话',
  })
  bindingRequired!: boolean;

  @ApiProperty({
    description: '已绑定时的会话(与密码登录同 LoginResponseDto / 同 refresh family);未绑定为 null',
    type: LoginResponseDto,
    nullable: true,
  })
  session!: LoginResponseDto | null;
}

export class SendWechatBindCodeDto {
  @ApiProperty({
    description: '账号绑定的大陆手机号(11 位);防枚举:无效号码返回完全相同的泛化响应',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;
}

export class WechatBindDto {
  @ApiProperty({
    description: '微信小程序 wx.login() 产出的一次性 code(放最前换 openid,失败不烧短信验证码)',
    maxLength: WECHAT_CODE_MAX_LENGTH,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(WECHAT_CODE_MAX_LENGTH)
  code!: string;

  @ApiProperty({
    description: '账号绑定的大陆手机号(11 位;须与 send-code 时一致)',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;

  @ApiProperty({ description: '6 位数字短信验证码(purpose=WECHAT_BIND)', example: '123456' })
  @IsString()
  @Length(SMS_CODE_LENGTH, SMS_CODE_LENGTH)
  @Matches(/^\d{6}$/, { message: 'smsCode 必须是 6 位数字' })
  smsCode!: string;
}

// ===== 企业微信接入 T3(2026-08-02;冻结稿 §6.2)=====
//
// 五个 pre-auth / authed 端点的入出参。三条贯穿全组的纪律:
// 1. `state` / `bindingTicket` / `code` 都是**一次性凭证**:DTO 只做形状校验,
//    值本身不进日志、不进 Audit、不落库(state/ticket 只落 SHA-256 hash)。
// 2. 出参**不含** attempt id、wecomUserId、corpId(§5.3 规则 10)。
// 3. 未绑定响应**不含** hasPhone / 手机号尾号 / 账号状态(§6.2 规则 9 防枚举)。

export class WecomAuthorizeDto {
  @ApiProperty({
    description:
      '登录成功后前端回跳的**站内相对路径**;省略则用默认值。' +
      '拒绝绝对 URL / 协议相对 `//` / 反斜杠 / 控制字符 / userinfo / query 里的 token-like key' +
      '(开放重定向防线,冻结稿 §6.2)',
    required: false,
    example: '/activities',
    maxLength: WECOM_RETURN_PATH_MAX_LENGTH,
  })
  // ⚠️ `@OmittableOnly()` 而不是 `@IsOptional()`:returnPath 业务上**不可清空**,
  // 只是可省略(省略时用默认值)。`@IsOptional()` 会让显式 `null` 跳过全部校验器,
  // 穿到 service 后被 `?? default` 当成"没传"吞掉 —— 客户端拿到 200 却不知道
  // 自己发的值被丢了。用 OmittableOnly 后 `null` 稳定 400。
  @OmittableOnly()
  @IsString()
  @MaxLength(WECOM_RETURN_PATH_MAX_LENGTH)
  returnPath?: string;
}

export class WecomAuthorizeResponseDto {
  @ApiProperty({
    description:
      '企业微信网页授权 URL(snsapi_base 静默授权;含固定 redirect_uri 与当前 agentid);' +
      '前端直接跳转,**不要**解析或重写其中任何参数',
  })
  authorizeUrl!: string;

  @ApiProperty({ description: 'state 过期时刻(ISO;默认 5 分钟)', format: 'date-time' })
  expiresAt!: string;
}

export class LoginWecomDto {
  @ApiProperty({
    description:
      '企业微信回跳带回的一次性 code(仅提交给本接口;前端须随即 history.replaceState 清理地址栏,' +
      '禁止进入埋点 / 错误上报 / 浏览器持久存储)',
  })
  @IsString()
  @IsNotEmpty()
  code!: string;

  @ApiProperty({ description: 'authorize 时签发的 state(64 字符 hex;一次性)' })
  @IsString()
  @IsNotEmpty()
  state!: string;
}

export class WecomLoginResponseDto {
  @ApiProperty({
    description:
      '该企业微信身份是否尚未绑定账号:true = 未绑定(session=null,随 bindingTicket 走绑定流程);' +
      'false = 已绑定并签发会话',
  })
  bindingRequired!: boolean;

  @ApiProperty({
    description:
      '未绑定时的一次性绑定票据(默认 10 分钟;**唯一一次**出现在响应里);已绑定为 null。' +
      '响应中不含 wecomUserId / corpId / attempt id',
    nullable: true,
  })
  bindingTicket!: string | null;

  @ApiProperty({
    description: '已绑定时的会话(与密码登录同 LoginResponseDto / 同 refresh family);未绑定为 null',
    type: LoginResponseDto,
    nullable: true,
  })
  session!: LoginResponseDto | null;

  @ApiProperty({ description: 'authorize 时登记的站内回跳路径(已过安全校验)' })
  returnPath!: string;
}

export class SendWecomBindCodeDto {
  @ApiProperty({ description: '未绑定登录返回的 bindingTicket(校验但**不消费**)' })
  @IsString()
  @IsNotEmpty()
  bindingTicket!: string;

  @ApiProperty({
    description:
      '账号绑定的大陆手机号(11 位);防枚举:号码不存在 / 账号无手机号 / 停用 / 软删 / 与账号绑定值不一致,' +
      '五种场景返回与有效号**逐字段相同**的泛化 200 且不发送短信',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;
}

export class WecomBindDto {
  @ApiProperty({ description: '未绑定登录返回的 bindingTicket(本接口原子消费)' })
  @IsString()
  @IsNotEmpty()
  bindingTicket!: string;

  @ApiProperty({
    description: '账号绑定的大陆手机号(11 位;须与 send-code 时一致)',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;

  @ApiProperty({ description: '6 位数字短信验证码(purpose=WECOM_BIND)', example: '123456' })
  @IsString()
  @Length(SMS_CODE_LENGTH, SMS_CODE_LENGTH)
  @Matches(/^\d{6}$/, { message: 'smsCode 必须是 6 位数字' })
  smsCode!: string;
}

export class ResetPasswordBySmsDto {
  @ApiProperty({
    description: '账号绑定的大陆手机号(11 位;须与 send-code 时一致)',
    example: '13800001234',
  })
  @IsString()
  @Matches(MAINLAND_PHONE_PATTERN, { message: 'phone 必须是大陆 11 位手机号' })
  phone!: string;

  @ApiProperty({ description: '6 位数字验证码', example: '123456' })
  @IsString()
  @Length(SMS_CODE_LENGTH, SMS_CODE_LENGTH)
  @Matches(/^\d{6}$/, { message: 'code 必须是 6 位数字' })
  code!: string;

  @ApiProperty({
    description:
      '新密码(至少 8 位,需含字母+数字);与当前密码相同抛 NEW_PASSWORD_SAME_AS_OLD(10006,不消费验证码,可换密码用同码重试)',
    format: 'password',
    minLength: 8,
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/^(?=.*[a-zA-Z])(?=.*\d).+$/, {
    message: 'password 至少 8 位,且必须包含字母和数字',
  })
  newPassword!: string;
}
