import { Injectable } from '@nestjs/common';
import type { Member } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { notDeletedWhere } from '../../common/prisma/soft-delete.util';
import { PrismaService } from '../../database/prisma.service';
import type { AppAccessResult } from './app-identity.resolver';
import { AppIdentityResolver } from './app-identity.resolver';
import { AppSelfProfileDto } from './dto/app/app-self-profile.dto';
import { UpdateAppSelfProfileDto } from './dto/app/update-app-self-profile.dto';
import { UpdateMyProfileDto } from './users.dto';
import { UsersService } from './users.service';

// Phase 2 P2-2 App /me/profile GET / PATCH 业务 service。
// 沿 docs/app-api-p2-2-profile-review.md §7;
// 准入沿 P2-1 AppIdentityResolver(沿 Phase 0.7 §13.2 不抽 AppIdentityService);
// PATCH 复用 P0-D UsersService.updateMyProfile(字段都是 User 表;不动 P0-D 行为)。
// GET 仅派生 hasMemberProfile(单字段 select);**不**读 MemberProfile 任何业务字段。
//
// 铁律(沿评审稿 §7.4 + §11):
// - canUseApp=false → throw BizException(BizCode.FORBIDDEN)(P2-2 不新增 BizCode;沿 §6.1)
// - empty body → throw BizException(BizCode.BAD_REQUEST)(§3.4 A 档)
// - **禁止**透传 raw body / dto 给 UsersService;必须显式构造 safeDto = { nickname, avatarKey }
type ResolvedAppAccess = AppAccessResult & { canUseApp: true; member: Member };

@Injectable()
export class AppProfileService {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly usersService: UsersService,
    // 仅用于派生 hasMemberProfile(单字段 select);不读 MemberProfile 业务字段;不写。
    private readonly prisma: PrismaService,
  ) {}

  async getMyProfile(currentUser: CurrentUserPayload): Promise<AppSelfProfileDto> {
    const access = await this.appIdentity.resolve(currentUser);
    this.assertCanUseApp(access);

    const user = await this.appIdentity.loadUserForApp(currentUser.id);
    if (user === null) {
      // JwtStrategy 已挡;此处兜底并发软删窗口
      throw new BizException(BizCode.UNAUTHORIZED);
    }

    const hasMemberProfile = await this.deriveHasMemberProfile(access.member.id);

    return this.buildDto(user, access.member, hasMemberProfile);
  }

  async updateMyProfile(
    currentUser: CurrentUserPayload,
    dto: UpdateAppSelfProfileDto,
  ): Promise<AppSelfProfileDto> {
    // 1) 准入校验(沿 §5.2)
    const access = await this.appIdentity.resolve(currentUser);
    this.assertCanUseApp(access);

    // 2) 空 body 拦截(沿 §3.4 A 档 / 评审稿 §6.1)
    if (dto.nickname === undefined && dto.avatarKey === undefined) {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    // 3) 白名单显式重构(沿 §7.4 铁律 + §11.2 风险表):
    //    从 dto **逐字段**取 nickname / avatarKey 重组传给 UsersService;
    //    **禁止** `dto as UpdateMyProfileDto` / `{ ...dto }` / `as unknown` 透传 raw body。
    const safeDto: UpdateMyProfileDto = {
      nickname: dto.nickname,
      avatarKey: dto.avatarKey,
    };
    await this.usersService.updateMyProfile(currentUser, safeDto);

    // 4) 返新 AppSelfProfileDto(沿 §3.5;PATCH 与 GET 字段集一致由 getMyProfile 保证)
    return this.getMyProfile(currentUser);
  }

  // canUseApp=false → FORBIDDEN(40300);沿评审稿 §6.1 P2-2 不新增 BizCode。
  // reason 由前端凭 /me/capabilities 缓存判断;message 不注入(沿 §5.4 BizException 类型签名锁死)。
  private assertCanUseApp(access: AppAccessResult): asserts access is ResolvedAppAccess {
    if (!access.canUseApp) {
      throw new BizException(BizCode.FORBIDDEN);
    }
  }

  // 派生 hasMemberProfile:**单字段** select { id: true } 白名单;不读任何业务字段。
  // 沿 §8.2 + CLAUDE.md §10 软删除显式封装。
  private async deriveHasMemberProfile(memberId: string): Promise<boolean> {
    const probe = await this.prisma.memberProfile.findFirst({
      where: notDeletedWhere({ memberId }),
      select: { id: true },
    });
    return probe !== null;
  }

  // 拼装 AppSelfProfileDto(9 字段;沿 §2.4 v0.1 字段集冻结)。
  // GET / PATCH 共用,字段集严格一致。
  private buildDto(
    user: { id: string; username: string; nickname: string | null; avatarKey: string | null },
    member: Member,
    hasMemberProfile: boolean,
  ): AppSelfProfileDto {
    return {
      userId: user.id,
      memberId: member.id,
      username: user.username,
      nickname: user.nickname,
      avatarKey: user.avatarKey,
      memberNo: member.memberNo,
      displayName: member.displayName,
      memberStatus: member.status,
      hasMemberProfile,
    };
  }
}
