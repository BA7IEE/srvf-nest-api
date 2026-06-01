import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
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
import type { AuditMeta } from '../../audit-logs/audit-logs.types';
import { AppCapabilityService } from '../app-capability.service';
import { AppIdentityResolver } from '../app-identity.resolver';
import { AppProfileService } from '../app-profile.service';
import { AppCapabilityResponseDto } from '../dto/app/app-capability-response.dto';
import { AppMeAccountDto } from '../dto/app/app-me-account.dto';
import { AppMeResponseDto } from '../dto/app/app-me-response.dto';
import { AppSelfProfileDto } from '../dto/app/app-self-profile.dto';
import { UpdateAppSelfProfileDto } from '../dto/app/update-app-self-profile.dto';
import { ChangeMyPasswordDto, UserResponseDto } from '../users.dto';
import { UsersService } from '../users.service';

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
@ApiTags('Mobile - Me')
@ApiBearerAuth()
@Controller('app/v1/me')
export class AppMeController {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly appCapability: AppCapabilityService,
    private readonly appProfile: AppProfileService,
    private readonly usersService: UsersService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'App 视角本人 user + member 摘要(含 canUseApp 标志)' })
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
      avatarKey: user.avatarKey,
      role: user.role,
      status: user.status,
      memberId: user.memberId,
      memberNo: access.member?.memberNo ?? null,
      displayName: access.member?.displayName ?? null,
      gradeCode: access.member?.gradeCode ?? null,
      memberStatus: access.member?.status ?? null,
      canUseApp: access.canUseApp,
      appAccessReason: access.reason,
    };
  }

  @Get('account')
  @ApiOperation({ summary: 'App 视角本人账号信息(username / status / lastLoginAt / canUseApp)' })
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
  @ApiTags('Mobile - Capabilities')
  @ApiOperation({ summary: 'App 视角本人 capability map(product-level;非 raw RBAC code)' })
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
  @ApiOperation({
    summary:
      'App 视角本人 profile(User + Member 基础摘要 + hasMemberProfile 派生;canUseApp=true 必要)',
  })
  @ApiWrappedOkResponse(AppSelfProfileDto)
  @ApiBizErrorResponse(BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  async getMyProfile(@CurrentUser() currentUser: CurrentUserPayload): Promise<AppSelfProfileDto> {
    return this.appProfile.getMyProfile(currentUser);
  }

  // Phase 2 P2-2:PATCH /me/profile(沿评审稿 §3 严格 2 字段白名单)。
  // 空 body → BAD_REQUEST(沿 §3.4 A 档);forbidden field → 全局 ValidationPipe
  // forbidNonWhitelisted: true 自动返 BAD_REQUEST(沿 CLAUDE.md §7);
  // canUseApp=false → FORBIDDEN。沿 §6.1 不新增 BizCode。
  @Patch('profile')
  @ApiOperation({ summary: 'App 视角本人改 profile(严格白名单 nickname / avatarKey)' })
  @ApiWrappedOkResponse(AppSelfProfileDto)
  @ApiBizErrorResponse(BizCode.BAD_REQUEST, BizCode.UNAUTHORIZED, BizCode.FORBIDDEN)
  async updateMyProfile(
    @CurrentUser() currentUser: CurrentUserPayload,
    @Body() dto: UpdateAppSelfProfileDto,
  ): Promise<AppSelfProfileDto> {
    return this.appProfile.updateMyProfile(currentUser, dto);
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
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'App 视角本人自助改密(需 oldPassword;不主动吊销 access token;撤销全部 refresh)',
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
