import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { AuthzService } from '../authz/authz.service';

@Injectable()
export class ActivityResponsibilityPolicy {
  constructor(private readonly authz: AuthzService) {}

  async assertOwner(
    tx: Prisma.TransactionClient,
    activityId: string,
    user: CurrentUserPayload,
  ): Promise<void> {
    if (!user.memberId) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
    const owner = await tx.activityResponsibilityAssignment.findFirst({
      where: {
        activityId,
        memberId: user.memberId,
        responsibilityType: 'owner',
        status: 'active',
      },
      select: { id: true },
    });
    if (!owner) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
  }

  async assertOwnerOrOverride(
    tx: Prisma.TransactionClient,
    activityId: string,
    user: CurrentUserPayload,
  ): Promise<void> {
    if (user.memberId) {
      const owner = await tx.activityResponsibilityAssignment.findFirst({
        where: {
          activityId,
          memberId: user.memberId,
          responsibilityType: 'owner',
          status: 'active',
        },
        select: { id: true },
      });
      if (owner) return;
    }
    await this.assertOverride(activityId, user);
  }

  async assertOverride(activityId: string, user: CurrentUserPayload): Promise<void> {
    const decision = await this.authz.explain(user, 'activity-responsibility.override.record', {
      type: 'activity',
      id: activityId,
    });
    if (!decision.allow) {
      throw new BizException(
        decision.reason === 'resource_not_found'
          ? BizCode.ACTIVITY_NOT_FOUND
          : BizCode.RBAC_FORBIDDEN,
      );
    }
  }
}
