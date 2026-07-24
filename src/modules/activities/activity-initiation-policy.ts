import { Injectable } from '@nestjs/common';
import {
  MemberStatus,
  MembershipStatus,
  OrganizationStatus,
  Role,
  UserStatus,
  type PrismaClient,
} from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';

const FORMAL_GRADES = new Set([
  'level-1',
  'level-2',
  'level-3',
  'level-4',
  'level-5',
  'level-6',
  'level-7',
]);

type InitiationClient = Pick<PrismaClient, 'member' | 'organization'>;

@Injectable()
export class ActivityInitiationPolicy {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
  ) {}

  async resolveInitiator(
    user: CurrentUserPayload,
    targetOrganizationId: string,
    requestedMemberId?: string,
    client: InitiationClient = this.prisma,
  ): Promise<string> {
    const memberId = requestedMemberId ?? user.memberId;
    if (!memberId) throw new BizException(BizCode.ACTIVITY_INITIATOR_NOT_FORMAL);
    if (
      requestedMemberId &&
      requestedMemberId !== user.memberId &&
      user.role !== Role.SUPER_ADMIN &&
      !(await this.rbac.can(user, 'activity-responsibility.override.record'))
    ) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }

    await this.assertInitiatorEligible(user, targetOrganizationId, memberId, client);
    return memberId;
  }

  async assertInitiatorEligible(
    user: CurrentUserPayload,
    targetOrganizationId: string,
    initiatorMemberId: string | null,
    client: InitiationClient = this.prisma,
  ): Promise<void> {
    if (!initiatorMemberId) {
      throw new BizException(BizCode.ACTIVITY_INITIATOR_NOT_FORMAL);
    }
    const organization = await client.organization.findFirst({
      where: { id: targetOrganizationId, deletedAt: null },
      select: { status: true, parentId: true },
    });
    if (!organization) {
      throw new BizException(BizCode.ORGANIZATION_NOT_FOUND);
    }
    if (organization.status !== OrganizationStatus.ACTIVE) {
      throw new BizException(BizCode.ORGANIZATION_INACTIVE);
    }
    if (organization.parentId === null) {
      throw new BizException(BizCode.ACTIVITY_ORGANIZATION_ROOT_FORBIDDEN);
    }

    const now = new Date();
    const member = await client.member.findFirst({
      where: {
        id: initiatorMemberId,
        status: MemberStatus.ACTIVE,
        deletedAt: null,
      },
      select: {
        gradeCode: true,
        users: {
          where: { status: UserStatus.ACTIVE, deletedAt: null },
          select: { id: true },
          take: 1,
        },
        memberOrganizationMemberships: {
          where: {
            deletedAt: null,
            status: MembershipStatus.ACTIVE,
            startedAt: { lte: now },
            OR: [{ endedAt: null }, { endedAt: { gt: now } }],
            organization: {
              status: OrganizationStatus.ACTIVE,
              deletedAt: null,
              parentId: { not: null },
            },
          },
          select: { organizationId: true },
        },
      },
    });
    if (
      !member ||
      !member.gradeCode ||
      !FORMAL_GRADES.has(member.gradeCode) ||
      member.users.length === 0
    ) {
      throw new BizException(BizCode.ACTIVITY_INITIATOR_NOT_FORMAL);
    }
    if (
      member.memberOrganizationMemberships.some(
        (membership) => membership.organizationId === targetOrganizationId,
      )
    ) {
      return;
    }

    const decision = await this.authz.explain(user, 'activity.create.cross-org', {
      type: 'organization',
      id: targetOrganizationId,
    });
    if (!decision.allow) throw new BizException(BizCode.ACTIVITY_INITIATION_ORG_FORBIDDEN);
  }
}
