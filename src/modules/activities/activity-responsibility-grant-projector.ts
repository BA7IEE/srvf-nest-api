import { Injectable } from '@nestjs/common';
import { BindingScopeType, BindingStatus, PrincipalType, Prisma } from '@prisma/client';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';

type PrismaTx = Prisma.TransactionClient;

const OWNER_ROLE = 'activity-owner';
const REGISTRATION_COLLABORATOR_ROLE = 'activity-registration-collaborator';
const ATTENDANCE_COLLABORATOR_ROLE = 'activity-attendance-collaborator';

@Injectable()
export class ActivityResponsibilityGrantProjector {
  private async roleIds(tx: PrismaTx, codes: string[]): Promise<Map<string, string>> {
    const roles = await tx.rbacRole.findMany({
      where: { code: { in: codes }, deletedAt: null },
      select: { id: true, code: true },
    });
    const ids = new Map(roles.map((role) => [role.code, role.id]));
    if (ids.size !== new Set(codes).size) {
      throw new BizException(BizCode.ROLE_NOT_FOUND);
    }
    return ids;
  }

  private async createBindings(args: {
    tx: PrismaTx;
    assignmentId: string;
    activityId: string;
    memberId: string;
    actorUserId: string;
    roleCodes: string[];
    now: Date;
  }): Promise<void> {
    const ids = await this.roleIds(args.tx, args.roleCodes);
    for (const code of args.roleCodes) {
      await args.tx.roleBinding.create({
        data: {
          principalType: PrincipalType.MEMBER,
          principalId: args.memberId,
          roleId: ids.get(code)!,
          scopeType: BindingScopeType.ACTIVITY,
          scopeActivityId: args.activityId,
          status: BindingStatus.ACTIVE,
          startedAt: args.now,
          createdByUserId: args.actorUserId,
          note: `system:activity-responsibility:${args.assignmentId}`,
        },
      });
    }
  }

  async projectOwner(args: {
    tx: PrismaTx;
    assignmentId: string;
    activityId: string;
    memberId: string;
    actorUserId: string;
    now: Date;
  }): Promise<void> {
    await this.createBindings({ ...args, roleCodes: [OWNER_ROLE] });
  }

  async projectCollaborator(args: {
    tx: PrismaTx;
    assignmentId: string;
    activityId: string;
    memberId: string;
    actorUserId: string;
    canManageRegistrations: boolean;
    canManageAttendance: boolean;
    now: Date;
  }): Promise<void> {
    const roleCodes: string[] = [];
    if (args.canManageRegistrations) roleCodes.push(REGISTRATION_COLLABORATOR_ROLE);
    if (args.canManageAttendance) roleCodes.push(ATTENDANCE_COLLABORATOR_ROLE);
    await this.createBindings({ ...args, roleCodes });
  }

  async endAssignmentBindings(args: {
    tx: PrismaTx;
    activityId: string;
    memberId: string;
    responsibilityType: string;
    canManageRegistrations: boolean;
    canManageAttendance: boolean;
    now: Date;
  }): Promise<number> {
    const roleCodes =
      args.responsibilityType === 'owner'
        ? [OWNER_ROLE]
        : [
            ...(args.canManageRegistrations ? [REGISTRATION_COLLABORATOR_ROLE] : []),
            ...(args.canManageAttendance ? [ATTENDANCE_COLLABORATOR_ROLE] : []),
          ];
    const ids = await this.roleIds(args.tx, roleCodes);
    const ended = await args.tx.roleBinding.updateMany({
      where: {
        principalType: PrincipalType.MEMBER,
        principalId: args.memberId,
        roleId: { in: [...ids.values()] },
        scopeType: BindingScopeType.ACTIVITY,
        scopeActivityId: args.activityId,
        status: BindingStatus.ACTIVE,
        deletedAt: null,
      },
      data: {
        status: BindingStatus.ENDED,
        endedAt: args.now,
        deletedAt: args.now,
      },
    });
    if (ended.count !== roleCodes.length) {
      throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_NOT_FOUND);
    }
    return ended.count;
  }
}
