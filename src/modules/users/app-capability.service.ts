import { Injectable } from '@nestjs/common';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { AppIdentityResolver } from './app-identity.resolver';
import { AppCapabilityResponseDto } from './dto/app/app-capability-response.dto';

// Phase 2 P2-1 App /me/capabilities 业务 service。
// 沿 docs/app-api-phase-2-review.md §4 + D-5.3(不暴露 raw RBAC code)+ Phase 0.7 §3.2
// (capability ≠ 授权证明;后端写端点必须重新做四维校验)。
// canUseApp=false 时所有业务 capability 强制 false(§4.3 #4);
// tasks 仍为预留；managed 已由活动责任闭环 PR-6 落地，按当前数据库责任与 authz scope 投影。
// canChangePassword 当前与 canUseApp 同步保守 false(P2-3 评审稿再决议是否对 admin 无 member 解锁;
// 沿 §6.2 准入表 PUT /me/password 行 ⚠️ "可选")。

@Injectable()
export class AppCapabilityService {
  constructor(
    private readonly appIdentity: AppIdentityResolver,
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
  ) {}

  async resolve(currentUser: CurrentUserPayload): Promise<AppCapabilityResponseDto> {
    const access = await this.appIdentity.resolve(currentUser);
    const canUseApp = access.canUseApp;
    const formalGrades = new Set([
      'level-1',
      'level-2',
      'level-3',
      'level-4',
      'level-5',
      'level-6',
      'level-7',
    ]);
    const canInitiateActivity =
      canUseApp &&
      access.member?.gradeCode !== null &&
      access.member?.gradeCode !== undefined &&
      formalGrades.has(access.member.gradeCode);
    const [
      publishScope,
      reviewScope,
      firstReviewScope,
      finalReviewScope,
      responsibilityCapabilities,
      initiatedCount,
    ] =
      canUseApp && access.member
        ? await Promise.all([
            this.authz.getVisibleOrganizationScope(currentUser, 'activity.publish.record'),
            this.authz.getVisibleOrganizationScope(currentUser, 'activity-review.read.request'),
            this.authz.getVisibleOrganizationScope(currentUser, 'attendance.approve.sheet'),
            this.authz.getVisibleOrganizationScope(currentUser, 'attendance.final-approve.sheet'),
            this.prisma.activityResponsibilityAssignment.findMany({
              where: { memberId: access.member.id, status: 'active' },
              select: {
                canManageRegistrations: true,
                canManageAttendance: true,
              },
            }),
            this.prisma.activity.count({
              where: { initiatorMemberId: access.member.id, deletedAt: null },
            }),
          ])
        : [
            { hasPermission: false },
            { hasPermission: false },
            { hasPermission: false },
            { hasPermission: false },
            [],
            0,
          ];
    const activeResponsibilities = responsibilityCapabilities as Array<{
      canManageRegistrations: boolean;
      canManageAttendance: boolean;
    }>;

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
        canInitiateActivity,
        canDirectPublishOwnActivity: canUseApp && publishScope.hasPermission,
      },
      attendance: { canViewOwnAttendance: canUseApp },
      certificates: { canViewOwnCertificates: canUseApp },
      tasks: { canViewTasks: false },
      managed: {
        canViewManagedActivities:
          canUseApp &&
          (canInitiateActivity || initiatedCount > 0 || activeResponsibilities.length > 0),
        canManageManagedRegistrations:
          canUseApp && activeResponsibilities.some((item) => item.canManageRegistrations),
        canSubmitManagedAttendance:
          canUseApp && activeResponsibilities.some((item) => item.canManageAttendance),
        canReviewActivityPublication: canUseApp && reviewScope.hasPermission,
        canFirstReviewAttendance: canUseApp && firstReviewScope.hasPermission,
        canFinalReviewAttendance: canUseApp && finalReviewScope.hasPermission,
      },
    };
  }
}
