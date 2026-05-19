import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { AppIdentityResolver } from './app-identity.resolver';
import { AppCapabilityResponseDto } from './dto/app/app-capability-response.dto';

// Phase 2 P2-1 App /me/capabilities 业务 service。
// 沿 docs/app-api-phase-2-review.md §4 + D-5.3(不暴露 raw RBAC code)+ Phase 0.7 §3.2
// (capability ≠ 授权证明;后端写端点必须重新做四维校验)。
// canUseApp=false 时所有业务 capability 强制 false(§4.3 #4);
// tasks / managed 是 Phase 2 不实施的命名空间预留,恒 false(§3.1 / §4.2)。
// canChangePassword 当前与 canUseApp 同步保守 false(P2-3 评审稿再决议是否对 admin 无 member 解锁;
// 沿 §6.2 准入表 PUT /me/password 行 ⚠️ "可选")。

@Injectable()
export class AppCapabilityService {
  constructor(private readonly appIdentity: AppIdentityResolver) {}

  async resolve(currentUser: CurrentUserPayload): Promise<AppCapabilityResponseDto> {
    const access = await this.appIdentity.resolve(currentUser);
    const canUseApp = access.canUseApp;

    return {
      account: {
        canUseApp,
        reason: access.reason,
        canEditProfile: canUseApp,
        canChangePassword: canUseApp,
      },
      activities: {
        canViewAvailableActivities: canUseApp,
        canRegisterActivity: canUseApp,
        canCancelOwnRegistration: canUseApp,
      },
      attendance: { canViewOwnAttendance: canUseApp },
      certificates: { canViewOwnCertificates: canUseApp },
      tasks: { canViewTasks: false },
      managed: {
        canViewManagedActivities: false,
        canReviewManagedRegistrations: false,
        canReviewManagedAttendance: false,
      },
    };
  }
}
