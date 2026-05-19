import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { AppCapabilityService } from '../app-capability.service';
import { AppIdentityResolver } from '../app-identity.resolver';
import { AppProfileService } from '../app-profile.service';
import { AppCapabilityResponseDto } from '../dto/app/app-capability-response.dto';
import { AppMeAccountDto } from '../dto/app/app-me-account.dto';
import { AppMeResponseDto } from '../dto/app/app-me-response.dto';
import { AppSelfProfileDto } from '../dto/app/app-self-profile.dto';
import { UpdateAppSelfProfileDto } from '../dto/app/update-app-self-profile.dto';

// Phase 2 P2-1 App /api/app/v1/me* Mobile Controller。
// 沿 docs/app-api-phase-2-review.md §2 + §6.1 + §7.1;migration-plan §5 方案 C;
// code-architecture §1.1(mobile- / app- 前缀);Phase 1A Swagger Tag 命名。
// 三 endpoint 全部 capability-aware(canUseApp 通过派生字段表达,**不**走拒绝路径)。
// 旧 /api/users/me* 行为**逐字不变**(沿 §3.2 + §9.2 #9);本 Controller 与 UsersController 共存。
//
// Phase 2 P2-2(2026-05-20):追加 GET / PATCH /profile 两 endpoint(沿
// docs/app-api-p2-2-profile-review.md §7.3)。与 P2-1 三 endpoint 不同的是:
// /profile 是**业务 endpoint**,canUseApp=false 走**显式拒绝路径**抛 FORBIDDEN(沿 §5.4);
// 不返"空 profile"。**沿 §6.1 不新增 BizCode**(empty body / forbidden field / canUseApp=false
// 全部复用 BAD_REQUEST=40000 / FORBIDDEN=40300)。
@ApiTags('Mobile - Me')
@ApiBearerAuth()
@Controller('app/v1/me')
export class AppMeController {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly appCapability: AppCapabilityService,
    private readonly appProfile: AppProfileService,
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
}
