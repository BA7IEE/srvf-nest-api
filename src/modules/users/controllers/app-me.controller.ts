import {
  type ArgumentsHost,
  Body,
  Catch,
  Controller,
  Delete,
  type ExceptionFilter,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  PayloadTooLargeException,
  Post,
  Put,
  Req,
  Res,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { formatMemberLabel } from '../../../common/identity/member-label.util';
import { BizException } from '../../../common/exceptions/biz.exception';
import { BizCode } from '../../../common/exceptions/biz-code.constant';
import {
  ApiBizErrorResponse,
  ApiWrappedOkResponse,
} from '../../../common/decorators/api-response.decorator';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../../../common/decorators/current-user.decorator';
import { PasswordChangeThrottle } from '../../../common/decorators/password-change-throttle.decorator';
import { SmsSendThrottle } from '../../../common/decorators/sms-send-throttle.decorator';
import { SmsVerifyThrottle } from '../../../common/decorators/sms-verify-throttle.decorator';
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import {
  clearWecomBrowserNonceCookie,
  readWecomBrowserNonce,
  WECOM_BIND_NONCE_COOKIE,
} from '../../auth/wecom-browser-nonce';
import { AppCapabilityService } from '../app-capability.service';
import { AppIdentityResolver } from '../app-identity.resolver';
import { AppAvatarService } from '../app-avatar.service';
import { AppProfileService } from '../app-profile.service';
import { AccountAvatarDto } from '../dto/app/account-avatar.dto';
import { AppCapabilityResponseDto } from '../dto/app/app-capability-response.dto';
import { AppMeAccountDto } from '../dto/app/app-me-account.dto';
import { AppMeResponseDto } from '../dto/app/app-me-response.dto';
import {
  AppMePhoneDto,
  BindMyPhoneDto,
  SendMyPhoneCodeDto,
  SendMyPhoneCodeResponseDto,
} from '../dto/app/app-me-phone.dto';
import { AppMeWechatDto, BindMyWechatDto } from '../dto/app/app-me-wechat.dto';
import { AppMeWecomDto, BindMyWecomDto } from '../dto/app/app-me-wecom.dto';
import { AppSelfProfileDto } from '../dto/app/app-self-profile.dto';
import { UpdateAppSelfProfileDto } from '../dto/app/update-app-self-profile.dto';
import { UserWecomBindingService } from '../user-wecom-binding.service';
import { ChangeMyPasswordDto, UserResponseDto } from '../users.dto';
import { UsersService } from '../users.service';
import { LoginScoped } from '../../../common/decorators/route-authz.decorator';

// Phase 2 P2-1 App /api/app/v1/me* Mobile Controller。
// 沿 docs/app-api-phase-2-review.md §2 + §6.1 + §7.1;migration-plan §5 方案 C;
// code-architecture §1.1(mobile- / app- 前缀);Phase 1A Swagger Tag 命名。
// 三 endpoint 全部 capability-aware(canUseApp 通过派生字段表达,**不**走拒绝路径)。
// 本 Controller 是 App 自助身份/资料的唯一入口(`app/v1/me`),与 UsersController
// (`admin/v1/users`)前缀独立、职责分离;队员自助流(原 `/api/users/me*`)已于 Route B Phase 4d 收口至本 Controller。
//
// Phase 2 P2-2(2026-05-20):追加 GET / PATCH /profile 两 endpoint(沿
// docs/app-api-p2-2-profile-review.md §7.3)。与 P2-1 三 endpoint 不同的是:
// /profile 是**业务 endpoint**,canUseApp=false 走**显式拒绝路径**抛 FORBIDDEN(沿 §5.4);
// 不返"空 profile"。**沿 §6.1 不新增 BizCode**(empty body / forbidden field / canUseApp=false
// 全部复用 BAD_REQUEST=40000 / FORBIDDEN=40300)。
//
// Phase 2 P2-3(2026-05-20):追加 PUT /password endpoint(沿
// docs/app-api-p2-3-password-review.md §9.2 + §15.1)。与 /me/profile 不同:
// **D-P2-3-1 = X 已锁定**:改密是账号级自助操作,不读 / 不写 member 业务字段,
// admin without member **允许**使用;**不**调 appIdentity.resolve + assertCanUseApp。
// 该豁免**严格仅本端点**适用,不得复用于 /me/profile / /activities/* / /my/* /
// /tasks/* / /managed/*(沿评审稿 §4.6 例外边界)。
// 复用:UsersService.changeMyPassword(P0-D + P0-E)/ ChangeMyPasswordDto / UserResponseDto /
// @PasswordChangeThrottle()(throttler 实例 'password-change')/
// password.change.self audit / refresh token 撤销(revokedReason='self-password-change')。
// **零新增**:0 DTO / 0 service / 0 BizCode / 0 audit event / 0 throttler 实例。
// `Express.Multer.File` 需要 `@types/multer` 的全局命名空间;仓内既有做法是**各自局部声明
// 只用到的那四个字段**(见 `app-registration-upload-sessions.controller.ts:43`),
// 不引入一个只为类型服务的全局依赖。这里沿用同一形状。
type AvatarMultipartFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

// issue #1055 T3:头像 multipart 的体积上限。
// Busboy 在「已解析字节数等于配置值」时才发 limit 事件,故配置值取上限 +1 ——
// 对外接受的最大值仍是 10 MiB,而第 1 个超出字节在进路由之前就被拒。
const AVATAR_MULTIPART_FILE_SIZE_LIMIT = 10 * 1024 * 1024 + 1;

// 全局 filter 刻意把通用 multipart 413 保持在 40000。本路由有固定的附件契约,
// 解析层的体积拒绝必须保住 13013,否则客户端拿到的错误码会随「在哪一层被拒」漂移。
//
// ⚠️ 与 `app-registration-upload-sessions.controller.ts` 里那个是**同形的两份**。
// 刻意不抽公共:共享处只能落在 `src/common/filters/**`,那是 `global-pipeline` 红区
// (全局 Guard/Filter/Interceptor 影响每个请求)。两个 10 行、无共享清单的 filter
// 各自漂移也不会互相影响,代价小于动红区。
@Catch(PayloadTooLargeException)
class AvatarUploadFileSizeFilter implements ExceptionFilter<PayloadTooLargeException> {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(BizCode.ATTACHMENT_SIZE_EXCEEDED.httpStatus).json({
      code: BizCode.ATTACHMENT_SIZE_EXCEEDED.code,
      message: BizCode.ATTACHMENT_SIZE_EXCEEDED.message,
      data: null,
    });
  }
}

@ApiTags('Mobile - Me')
@ApiBearerAuth()
@Controller('app/v1/me')
export class AppMeController {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly appCapability: AppCapabilityService,
    private readonly appProfile: AppProfileService,
    private readonly appAvatar: AppAvatarService,
    private readonly usersService: UsersService,
    private readonly userWecomBinding: UserWecomBindingService,
  ) {}

  @Get()
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: 'App 视角本人 user + member 摘要(含 canUseApp 标志) [auth]' })
  @ApiWrappedOkResponse(AppMeResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.INTERNAL_ERROR)
  async getMe(@CurrentUser() currentUser: CurrentUserPayload): Promise<AppMeResponseDto> {
    const [user, access] = await Promise.all([
      this.appIdentity.loadUserForApp(currentUser.id),
      this.appIdentity.resolve(currentUser),
    ]);

    // JwtStrategy 已挡;此处仅兜底并发软删窗口
    if (user === null) {
      throw new BizException(BizCode.UNAUTHORIZED);
    }

    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      nickname: user.nickname,
      role: user.role,
      status: user.status,
      memberId: user.memberId,
      memberNo: access.member?.memberNo ?? null,
      realName: access.member?.realName ?? null,
      memberLabel: access.member ? formatMemberLabel(access.member) : null,
      gradeCode: access.member?.gradeCode ?? null,
      memberStatus: access.member?.status ?? null,
      canUseApp: access.canUseApp,
      appAccessReason: access.reason,
    };
  }

  @Get('account')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @ApiOperation({
    summary: 'App 视角本人账号信息(username / status / lastLoginAt / canUseApp) [auth]',
  })
  @ApiWrappedOkResponse(AppMeAccountDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.INTERNAL_ERROR)
  async getMeAccount(@CurrentUser() currentUser: CurrentUserPayload): Promise<AppMeAccountDto> {
    const [user, access] = await Promise.all([
      this.appIdentity.loadUserForApp(currentUser.id),
      this.appIdentity.resolve(currentUser),
    ]);

    if (user === null) {
      throw new BizException(BizCode.UNAUTHORIZED);
    }

    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      status: user.status,
      lastLoginAt: user.lastLoginAt === null ? null : user.lastLoginAt.toISOString(),
      linkedMemberId: user.memberId,
      canUseApp: access.canUseApp,
      appAccessReason: access.reason,
    };
  }

  @Get('capabilities')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @ApiTags('Mobile - Capabilities')
  @ApiOperation({ summary: 'App 视角本人 capability map(product-level;非 raw RBAC code) [auth]' })
  @ApiWrappedOkResponse(AppCapabilityResponseDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED)
  async getMeCapabilities(
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AppCapabilityResponseDto> {
    return this.appCapability.resolve(currentUser);
  }

  // Phase 2 P2-2:GET /me/profile(沿评审稿 §7.3 / §2.4 v0.1 字段集恰好 9 个)。
  // canUseApp=false → service 内显式抛 FORBIDDEN(沿 §5.4 + §6.1);不返"空 profile"。
  @Get('profile')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @ApiOperation({
    summary:
      'App 视角本人 profile(User + Member 基础摘要 + hasMemberProfile 派生;canUseApp=true 必要) [auth]',
  })
  @ApiWrappedOkResponse(AppSelfProfileDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  async getMyProfile(@CurrentUser() currentUser: CurrentUserPayload): Promise<AppSelfProfileDto> {
    return this.appProfile.getMyProfile(currentUser);
  }

  // Phase 2 P2-2:PATCH /me/profile(沿评审稿 §3 严格 2 字段白名单)。
  // 空 body → BAD_REQUEST(沿 §3.4 A 档);forbidden field → 全局 ValidationPipe
  // forbidNonWhitelisted: true 自动返 BAD_REQUEST
  // (沿 docs/reference/naming-dto-validation.md §7);
  // canUseApp=false → FORBIDDEN。沿 §6.1 不新增 BizCode。
  @Patch('profile')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: 'App 视角本人改 profile(严格白名单:仅 nickname) [auth]' })
  @ApiWrappedOkResponse(AppSelfProfileDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  async updateMyProfile(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: UpdateAppSelfProfileDto,
  ): Promise<AppSelfProfileDto> {
    return this.appProfile.updateMyProfile(currentUser, dto);
  }

  // ===== issue #1055 T3:账号头像闭环 =====
  //
  // 三个端点,不是 issue §7.1 写的四个 —— 维护者 2026-08-20 拍板走 **multipart 直传服务端**:
  // 服务端要规范化就必须看见字节,而「签名 URL 直传 + confirm 时拉回来规范化」会让
  // **未规范化的原图(带 EXIF/GPS)先落进 storage 并停留一段时间**,正是整套设计要防的泄露。
  // 于是 upload-url 与 confirm-upload 合并成一次 POST。
  //
  // 准入沿本 controller 既有口径:`app-member` + `self`。**不要**任何
  // `attachment.upload.*` 通用权限码(issue §7.1 明写)—— 那是给通用附件面用的,
  // 而这两个 owner type 恰恰在通用面上恒 fail-closed。

  @Get('avatar')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @ApiOperation({ summary: 'App 视角读本人账号头像(短 TTL 签名 URL;无头像返 null) [auth]' })
  @ApiWrappedOkResponse(AccountAvatarDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  async getMyAvatar(
    @CurrentUser() currentUser: CurrentUserPayload,
  ): Promise<AccountAvatarDto | null> {
    return this.appAvatar.getMyAvatar(currentUser);
  }

  @Post('avatar')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.OK)
  @UseFilters(AvatarUploadFileSizeFilter)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: AVATAR_MULTIPART_FILE_SIZE_LIMIT, files: 1 } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'JPEG / PNG 原图,≤10 MiB,短边 ≥512px(服务端会规范化成 512×512 JPEG)',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'App 视角上传 / 替换本人账号头像(multipart;服务端规范化并清除 EXIF/GPS) [auth]',
  })
  @ApiWrappedOkResponse(AccountAvatarDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.FORBIDDEN,
    BizCode.ATTACHMENT_MIME_NOT_ALLOWED,
    BizCode.ATTACHMENT_SIZE_EXCEEDED,
    BizCode.ATTACHMENT_IMAGE_UNDECODABLE,
    BizCode.ATTACHMENT_IMAGE_ANIMATED_NOT_ALLOWED,
    BizCode.ATTACHMENT_IMAGE_TOO_SMALL,
    BizCode.ATTACHMENT_IMAGE_PIXELS_EXCEEDED,
  )
  async uploadMyAvatar(
    @CurrentUser() currentUser: CurrentUserPayload,
    @UploadedFile() file: AvatarMultipartFile | undefined,
    @Req() req: Request,
  ): Promise<AccountAvatarDto> {
    if (file === undefined) throw new BizException(BizCode.BAD_REQUEST);
    return this.appAvatar.replaceMyAvatar(
      currentUser,
      {
        buffer: file.buffer,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
      },
      this.buildAuditMeta(req),
    );
  }

  @Delete('avatar')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'App 视角清空本人账号头像(重复清空幂等) [auth]' })
  // 204 必须显式声明:契约快照有一条判据比对「Nest 的有效状态码」与「OpenAPI 里记录的成功状态码」,
  // 不声明的话文档侧是空的,前端 client 生成器也不知道这条没有响应体。
  @ApiNoContentResponse({ description: '已清空(重复清空同样返 204)' })
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  async clearMyAvatar(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Req() req: Request,
  ): Promise<void> {
    await this.appAvatar.clearMyAvatar(currentUser, this.buildAuditMeta(req));
  }

  // Phase 2 P2-3:PUT /me/password(沿评审稿 §1 + §9.2 + §15.1 + D-P2-3-1 = X)。
  // 复用 UsersService.changeMyPassword(P0-D + P0-E PR-3 全套行为继承):
  //   - bcrypt.compare(oldPassword) → OLD_PASSWORD_INVALID(10005)
  //   - 严格 === 比较 → NEW_PASSWORD_SAME_AS_OLD(10006)
  //   - tx: user.update(passwordHash) + refreshToken.updateMany(revokedReason='self-password-change') + auditLogs.log('password.change.self')
  //   - access token **不**主动吊销(沿 P0-D §5.7 + P0-E v1 D-4;15m 自然过期)
  // D-P2-3-1 = X 锁定:改密是账号级自助操作,**不**调 appIdentity.resolve + assertCanUseApp;
  // admin without member 允许使用(沿评审稿 §4.2.1 / §4.3 锁定理由 + §4.6 例外边界)。
  @PasswordChangeThrottle()
  @Put('password')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'App 视角本人自助改密(需 oldPassword;不主动吊销 access token;撤销全部 refresh) [auth]',
  })
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
    // 显式 safeDto 重组(沿评审稿 §9.4 + P2-2 §7.4 风险表 10.11a 范式):
    // **禁止**透传 raw body / `as` cast / `{ ...dto }` / `as unknown` 任一模式。
    const safeDto: ChangeMyPasswordDto = {
      oldPassword: dto.oldPassword,
      newPassword: dto.newPassword,
    };
    return this.usersService.changeMyPassword(currentUser, safeDto, this.buildAuditMeta(req));
  }

  // SMS 基础设施 T3(2026-06-10):POST /me/phone/send-code + PUT /me/phone(冻结评审稿
  // sms-verification-infra-review.md §3.2 ⑤⑥ / §4 / §7 / E-5)。
  // 准入沿 PUT /me/password 账号级豁免先例(E-5):User.phone 是账号级身份字段,
  // **不**调 appIdentity.resolve + assertCanUseApp,admin without member 允许使用;
  // 豁免仅限本两端点,禁止外溢(沿 P2-3 评审稿 §4.6 例外边界精神)。
  // 防刷三层:同号 60s 间隔 + 同号自然日上限(DB 层,SmsCodeService)+ 本层 IP throttler。
  @SmsSendThrottle()
  @Post('phone/send-code')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'App 发送手机号绑定验证码(目标号已被任何账号绑定则拒;同号限频;响应永不含验证码) [auth]',
  })
  @ApiWrappedOkResponse(SendMyPhoneCodeResponseDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.PHONE_ALREADY_BOUND,
    BizCode.SMS_SEND_INTERVAL_LIMIT,
    BizCode.SMS_PHONE_DAILY_LIMIT,
    BizCode.SMS_CHANNEL_NOT_CONFIGURED,
    BizCode.SMS_SEND_FAILED,
    BizCode.TOO_MANY_REQUESTS,
  )
  sendMyPhoneCode(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: SendMyPhoneCodeDto,
    @Req() req: Request,
  ): Promise<SendMyPhoneCodeResponseDto> {
    // 显式 safeDto 重组(沿 P2-2 §7.4 风险表 10.11a 范式;禁透传 raw body)
    const safeDto: SendMyPhoneCodeDto = { phone: dto.phone };
    return this.usersService.sendMyPhoneBindCode(currentUser, safeDto, req.ip ?? null);
  }

  // 验码绑定 / 换绑一体(⑥;评审稿 §7):错码统一 SMS_CODE_INVALID(24010,防枚举不细分);
  // 绑定成功事务内写 phone.bind.self / phone.rebind.self audit(手机号掩码)。
  @SmsVerifyThrottle()
  @Put('phone')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'App 验码绑定 / 换绑手机号(需 PHONE_BIND step-up proof;真实变更撤销全部 refresh) [auth]',
  })
  @ApiWrappedOkResponse(AppMePhoneDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.USER_NOT_FOUND,
    BizCode.SMS_CODE_INVALID,
    BizCode.PHONE_ALREADY_BOUND,
    BizCode.STEP_UP_PROOF_INVALID,
    BizCode.TOO_MANY_REQUESTS,
  )
  bindMyPhone(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: BindMyPhoneDto,
    @Req() req: Request,
  ): Promise<AppMePhoneDto> {
    const safeDto: BindMyPhoneDto = {
      phone: dto.phone,
      code: dto.code,
      stepUpToken: dto.stepUpToken,
    };
    return this.usersService.bindMyPhone(currentUser, safeDto, this.buildAuditMeta(req));
  }

  // 微信小程序登录 T3(2026-06-12):GET /me/wechat + PUT /me/wechat(冻结评审稿
  // wechat-mini-login-review.md §4.4 / E-13/E-18)。
  // 准入沿 me/phone 账号级豁免先例(E-18):User.openid 是账号级身份字段,
  // **不**调 appIdentity.resolve + assertCanUseApp;豁免仅限本两端点,禁止外溢。
  // openid 仅掩码回显(非 L3 但不滥回显);响应永不含 wx code / session_key。
  @Get('wechat')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @ApiOperation({
    summary: 'App 查询本人微信绑定状态(openid 一律掩码回显) [auth]',
  })
  @ApiWrappedOkResponse(AppMeWechatDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.USER_NOT_FOUND)
  getMyWechat(@CurrentUser() currentUser: CurrentUserPayload): Promise<AppMeWechatDto> {
    return this.usersService.getMyWechat(currentUser);
  }

  // 已登录绑定 / 换绑一体(⑧;评审稿 §4.4):JWT 已证身份,无需再验手机(D-W3);
  // 同 openid 幂等;他人占用(含软删占用)→ 25002;不挂限流(登录态 + wx code 单次有效
  // 天然限频,无可爆破 secret,评审稿 E-17)。
  @Put('wechat')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'App 绑定 / 换绑本人微信(需 WECHAT_BIND step-up proof;真实变更撤销全部 refresh) [auth]',
  })
  @ApiWrappedOkResponse(AppMeWechatDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.USER_NOT_FOUND,
    BizCode.WECHAT_CODE_INVALID,
    BizCode.WECHAT_ALREADY_BOUND,
    BizCode.WECHAT_CHANNEL_NOT_CONFIGURED,
    BizCode.WECHAT_API_FAILED,
    BizCode.STEP_UP_PROOF_INVALID,
  )
  bindMyWechat(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: BindMyWechatDto,
    @Req() req: Request,
  ): Promise<AppMeWechatDto> {
    const safeDto: BindMyWechatDto = { code: dto.code, stepUpToken: dto.stepUpToken };
    return this.usersService.bindMyWechat(currentUser, safeDto, this.buildAuditMeta(req));
  }

  // 企业微信接入 T3(2026-08-02):GET /me/wecom + PUT /me/wecom(冻结稿 §6.3)。
  // 准入沿 me/phone、me/wechat 账号级豁免先例:企业微信身份是**账号级**字段,
  // Admin 无 Member 也需绑定,故**不**调 appIdentity.resolve + assertCanUseApp;
  // 豁免仅限本两端点,禁止外溢。
  // wecomUserId 仅掩码回显(§5.5 L2);响应永不含 OAuth code / state / corpId。
  @Get('wecom')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @ApiOperation({
    summary: 'App 查询本人企业微信绑定状态(wecomUserId 一律掩码回显) [auth]',
  })
  @ApiWrappedOkResponse(AppMeWecomDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.USER_NOT_FOUND)
  getMyWecom(@CurrentUser() currentUser: CurrentUserPayload): Promise<AppMeWecomDto> {
    return this.userWecomBinding.getMyWecom(currentUser);
  }

  // 本人绑定 / 换绑一体(D-WC-8):JWT + action-bound step-up proof + 企业微信 OAuth code。
  // 三者缺一不可 —— 只有 JWT 时,一个被盗的 access token 就能把账号改绑到攻击者的企业微信号。
  // 同目标幂等;他人占用 → 36002;真实变更撤销全部 refresh(access 沿 D-4 自然到期)。
  // **无本人裸解绑**(D-WC-9):释放身份的唯一显式路径是 DELETE admin/v1/users/:id/wecom。
  @Put('wecom')
  @LoginScoped({
    admission: 'app-member',
    require: 'all',
    scopes: ['self'],
    engine: 'authz-scoped',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'App 绑定 / 换绑本人企业微信(需 WECOM_BIND step-up proof;真实变更撤销全部 refresh) [auth]',
  })
  @ApiWrappedOkResponse(AppMeWecomDto)
  @ApiBizErrorResponse(
    BizCode.BAD_REQUEST,
    BizCode.UNAUTHORIZED,
    BizCode.USER_NOT_FOUND,
    BizCode.WECOM_LOGIN_CREDENTIAL_INVALID,
    BizCode.WECOM_IDENTITY_ALREADY_BOUND,
    BizCode.WECOM_CHANNEL_NOT_CONFIGURED,
    BizCode.WECOM_API_FAILED,
    BizCode.STEP_UP_PROOF_INVALID,
  )
  bindMyWecom(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: BindMyWecomDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AppMeWecomDto> {
    const safeDto: BindMyWecomDto = {
      code: dto.code,
      state: dto.state,
      stepUpToken: dto.stepUpToken,
    };
    // P1-27 第一刀 B1:bind_self 的 state 同样绑定发起授权的那个浏览器。
    // 归属证据来自 `__Host-` Cookie(由 `POST auth/v1/wecom-bind/authorize` 下发),
    // 不进 body —— 进了 body 就等于让攻击者把两半都自己填齐。
    const browserNonce = readWecomBrowserNonce(req, WECOM_BIND_NONCE_COOKIE);
    clearWecomBrowserNonceCookie(res, WECOM_BIND_NONCE_COOKIE);
    return this.userWecomBinding.bindMyWecom(
      currentUser,
      safeDto,
      browserNonce,
      this.buildAuditMeta(req),
    );
  }

  // P0-D PR-3 私有 helper(沿 users.controller.ts:121-127 逐字范式):
  // 从 @Req() 构造 AuditMeta 显式传给 service(D6 v1.1 §11.2 / D8 拍板;
  // 不引入 cls-rs / AsyncLocalStorage)。
  // P2-3 评审稿 §9.5 决议 α:复制 helper(2 个 controller 各有一份字面相同 helper),
  // 沿 baseline §1 字面对齐既有范式优先;未来第 3 个 controller 需要 audit meta 时再立项抽。
  private buildAuditMeta(req: Request): AuditMeta {
    return {
      requestId: req.id as string,
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    };
  }
}
