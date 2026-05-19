import { Injectable } from '@nestjs/common';
import { Member, MemberStatus, User, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../database/prisma.service';
import type { AppAccessReason } from './dto/app/app-access-reason';

// Phase 2 P2-1 App API 准入闭包。沿 docs/app-api-phase-2-review.md §6.1 + §6.4;
// docs/app-permission-boundary-review.md §10.2 D-5.1 / D-5.2;
// docs/data-access-lifecycle-boundary-review.md §5.4 L1-L8。
//
// 顺序(**禁止** role 短路 / 沿 Phase 0.7 §3.3):
//   - JwtStrategy 已挡 User.status!=ACTIVE / deletedAt!=null,本 resolver 不重复
//   - memberId=null → MEMBER_NOT_LINKED(含 admin 不绑 / 用户未绑;L1 / L8)
//   - member 不存在 || deletedAt!=null → MEMBER_DELETED(L4)
//   - member.status!=ACTIVE → MEMBER_INACTIVE(L3)
//   - 否则 canUseApp=true(L2 / L7;Admin-as-member 同走 self perspective,**不**扩大字段)

export interface AppAccessResult {
  canUseApp: boolean;
  reason: AppAccessReason | null;
  member: Member | null;
}

@Injectable()
export class AppIdentityResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(currentUser: CurrentUserPayload): Promise<AppAccessResult> {
    if (currentUser.memberId === null) {
      return { canUseApp: false, reason: 'MEMBER_NOT_LINKED', member: null };
    }

    const member = await this.prisma.member.findUnique({
      where: { id: currentUser.memberId },
    });

    if (member === null || member.deletedAt !== null) {
      return { canUseApp: false, reason: 'MEMBER_DELETED', member: null };
    }

    if (member.status !== MemberStatus.ACTIVE) {
      return { canUseApp: false, reason: 'MEMBER_INACTIVE', member };
    }

    return { canUseApp: true, reason: null, member };
  }

  // 读 user 安全字段供 /me 拼装;字段白名单不含 passwordHash / deletedAt。
  // 不复用 userSafeSelect:Prisma model 不直接给 controller(沿 §5.2 #2)。
  async loadUserForApp(userId: string): Promise<UserForApp | null> {
    return this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        username: true,
        email: true,
        nickname: true,
        avatarKey: true,
        role: true,
        status: true,
        memberId: true,
        lastLoginAt: true,
      },
    });
  }
}

export type UserForApp = Pick<
  User,
  | 'id'
  | 'username'
  | 'email'
  | 'nickname'
  | 'avatarKey'
  | 'role'
  | 'status'
  | 'memberId'
  | 'lastLoginAt'
> & { status: UserStatus };
