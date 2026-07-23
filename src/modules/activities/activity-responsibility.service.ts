import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { MemberStatus, MembershipStatus, Prisma, UserStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import appConfig from '../../config/app.config';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { ActivityResponsibilityAuditRecorder } from './activity-responsibility-audit-recorder';
import {
  ActivityResponsibilitiesResponseDto,
  ActivityResponsibilityAssignmentDto,
  AssignLegacyActivityInitiatorDto,
  ClaimLegacyActivityDto,
  CreateActivityCollaboratorDto,
  TransferActivityOwnerDto,
} from './activity-responsibility.dto';
import { ActivityResponsibilityGrantProjector } from './activity-responsibility-grant-projector';
import { ActivityResponsibilityPolicy } from './activity-responsibility-policy';

type PrismaTx = Prisma.TransactionClient;

const assignmentSelect = {
  id: true,
  activityId: true,
  memberId: true,
  responsibilityType: true,
  canManageRegistrations: true,
  canManageAttendance: true,
  status: true,
  startedAt: true,
  endedAt: true,
  assignedByUserId: true,
  endedByUserId: true,
  source: true,
  reason: true,
  member: {
    select: {
      id: true,
      memberNo: true,
      displayName: true,
      gradeCode: true,
    },
  },
} as const satisfies Prisma.ActivityResponsibilityAssignmentSelect;

type AssignmentView = Prisma.ActivityResponsibilityAssignmentGetPayload<{
  select: typeof assignmentSelect;
}>;

interface ResponsibilityEffect {
  memberId: string;
  title: string;
  body: string;
}

@Injectable()
export class ActivityResponsibilityService {
  private readonly logger = new Logger(ActivityResponsibilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: ActivityResponsibilityPolicy,
    private readonly projector: ActivityResponsibilityGrantProjector,
    private readonly audit: ActivityResponsibilityAuditRecorder,
    private readonly notifications: NotificationDispatcher,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
  ) {}

  private assertWorkflowEnabled(): void {
    if (!this.config.activityResponsibilityWorkflow.enabled) {
      throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
    }
  }

  private toAssignmentDto(row: AssignmentView): ActivityResponsibilityAssignmentDto {
    return row;
  }

  private async lockActivity(activityId: string, tx: PrismaTx): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Activity"
      WHERE id = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `;
    if (rows.length === 0) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }

  private async lockMembers(memberIds: string[], tx: PrismaTx): Promise<void> {
    const ids = [...new Set(memberIds)].sort();
    if (ids.length === 0) return;
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM "Member"
      WHERE id IN (${Prisma.join(ids)}) AND "deletedAt" IS NULL
      ORDER BY id
      FOR UPDATE
    `);
    if (rows.length !== ids.length) {
      throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID);
    }
  }

  private async lockAssignment(assignmentId: string, tx: PrismaTx): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM activity_responsibility_assignments
      WHERE id = ${assignmentId}
      FOR UPDATE
    `;
    if (rows.length === 0) {
      throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_NOT_FOUND);
    }
  }

  private async assertActiveTarget(
    memberId: string,
    tx: PrismaTx,
    options?: { formal?: boolean },
  ): Promise<void> {
    const target = await tx.member.findFirst({
      where: { id: memberId, deletedAt: null, status: MemberStatus.ACTIVE },
      select: {
        gradeCode: true,
        users: {
          where: { deletedAt: null, status: UserStatus.ACTIVE },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (
      !target ||
      target.users.length === 0 ||
      (options?.formal && !/^level-[1-7]$/.test(target.gradeCode ?? ''))
    ) {
      throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID);
    }
  }

  private async assertCollaboratorEligible(
    activityId: string,
    memberId: string,
    organizationId: string,
    tx: PrismaTx,
  ): Promise<void> {
    const now = new Date();
    const [registration, membership] = await Promise.all([
      tx.activityRegistration.findFirst({
        where: {
          activityId,
          memberId,
          statusCode: 'pass',
          deletedAt: null,
        },
        select: { id: true },
      }),
      tx.memberOrganizationMembership.findFirst({
        where: {
          memberId,
          organizationId,
          status: MembershipStatus.ACTIVE,
          deletedAt: null,
          startedAt: { lte: now },
          OR: [{ endedAt: null }, { endedAt: { gte: now } }],
        },
        select: { id: true },
      }),
    ]);
    if (!registration && !membership) {
      throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID);
    }
  }

  private async createOwner(
    tx: PrismaTx,
    args: {
      activityId: string;
      memberId: string;
      actorUserId: string;
      source: 'publish' | 'transfer' | 'legacy-claim';
      reason?: string;
      now: Date;
    },
  ): Promise<AssignmentView> {
    await this.assertActiveTarget(args.memberId, tx, { formal: true });
    const assignment = await tx.activityResponsibilityAssignment.create({
      data: {
        activityId: args.activityId,
        memberId: args.memberId,
        responsibilityType: 'owner',
        canManageRegistrations: true,
        canManageAttendance: true,
        status: 'active',
        startedAt: args.now,
        assignedByUserId: args.actorUserId,
        source: args.source,
        reason: args.reason,
      },
      select: assignmentSelect,
    });
    await this.projector.projectOwner({
      tx,
      assignmentId: assignment.id,
      activityId: args.activityId,
      memberId: args.memberId,
      actorUserId: args.actorUserId,
      now: args.now,
    });
    return assignment;
  }

  private async createCollaborator(
    tx: PrismaTx,
    args: {
      activityId: string;
      memberId: string;
      actorUserId: string;
      canManageRegistrations: boolean;
      canManageAttendance: boolean;
      reason?: string;
      source: 'delegation' | 'transfer' | 'admin';
      now: Date;
    },
  ): Promise<AssignmentView> {
    const assignment = await tx.activityResponsibilityAssignment.create({
      data: {
        activityId: args.activityId,
        memberId: args.memberId,
        responsibilityType: 'collaborator',
        canManageRegistrations: args.canManageRegistrations,
        canManageAttendance: args.canManageAttendance,
        status: 'active',
        startedAt: args.now,
        assignedByUserId: args.actorUserId,
        source: args.source,
        reason: args.reason,
      },
      select: assignmentSelect,
    });
    await this.projector.projectCollaborator({
      tx,
      assignmentId: assignment.id,
      activityId: args.activityId,
      memberId: args.memberId,
      actorUserId: args.actorUserId,
      canManageRegistrations: args.canManageRegistrations,
      canManageAttendance: args.canManageAttendance,
      now: args.now,
    });
    return assignment;
  }

  private async endAssignment(
    tx: PrismaTx,
    assignment: AssignmentView,
    actorUserId: string,
    now: Date,
    status: 'ended' | 'revoked' = 'ended',
  ): Promise<void> {
    await tx.activityResponsibilityAssignment.update({
      where: { id: assignment.id },
      data: { status, endedAt: now, endedByUserId: actorUserId },
    });
    await this.projector.endAssignmentBindings({
      tx,
      activityId: assignment.activityId,
      memberId: assignment.memberId,
      responsibilityType: assignment.responsibilityType,
      canManageRegistrations: assignment.canManageRegistrations,
      canManageAttendance: assignment.canManageAttendance,
      now,
    });
  }

  private async dispatch(effect: ResponsibilityEffect): Promise<void> {
    try {
      await this.notifications.dispatchTargeted({
        recipientMemberId: effect.memberId,
        notificationTypeCode: 'general',
        title: effect.title,
        body: effect.body,
      });
    } catch (error) {
      this.logger.error(
        `activity responsibility notification failed (member=${effect.memberId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async createOwnerForPublish(
    tx: PrismaTx,
    activityId: string,
    initiatorMemberId: string | null,
    actorUserId: string,
    now: Date,
    actorRoleSnap: CurrentUserPayload['role'],
    auditMeta: AuditMeta,
  ): Promise<void> {
    this.assertWorkflowEnabled();
    if (!initiatorMemberId) throw new BizException(BizCode.ACTIVITY_LEGACY_OWNER_REQUIRED);
    await this.lockMembers([initiatorMemberId], tx);
    try {
      const assignment = await this.createOwner(tx, {
        activityId,
        memberId: initiatorMemberId,
        actorUserId,
        source: 'publish',
        now,
      });
      await this.audit.log({
        activityId,
        operation: 'responsibility-owner-create',
        assignmentId: assignment.id,
        targetMemberId: initiatorMemberId,
        source: 'publish',
        actorUserId,
        actorRoleSnap,
        auditMeta,
        tx,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS);
      }
      throw error;
    }
  }

  async list(
    activityId: string,
    user: CurrentUserPayload,
  ): Promise<ActivityResponsibilitiesResponseDto> {
    this.assertWorkflowEnabled();
    const activity = await this.prisma.activity.findFirst({
      where: { id: activityId, deletedAt: null },
      select: {
        id: true,
        statusCode: true,
        initiator: {
          select: { id: true, memberNo: true, displayName: true, gradeCode: true },
        },
      },
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    await this.policy.assertOwnerOrOverride(this.prisma, activityId, user);
    const assignments = await this.prisma.activityResponsibilityAssignment.findMany({
      where: { activityId, status: 'active' },
      orderBy: [{ responsibilityType: 'asc' }, { startedAt: 'asc' }, { id: 'asc' }],
      select: assignmentSelect,
    });
    const owner = assignments.find((item) => item.responsibilityType === 'owner') ?? null;
    return {
      activityId,
      initiator: activity.initiator,
      owner: owner ? this.toAssignmentDto(owner) : null,
      collaborators: assignments
        .filter((item) => item.responsibilityType === 'collaborator')
        .map((item) => this.toAssignmentDto(item)),
      legacyUnassigned:
        (activity.statusCode === 'draft' && activity.initiator === null) ||
        (activity.statusCode === 'published' && owner === null),
    };
  }

  async addCollaborator(
    activityId: string,
    dto: CreateActivityCollaboratorDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponsibilityAssignmentDto> {
    this.assertWorkflowEnabled();
    if (!dto.canManageRegistrations && !dto.canManageAttendance) {
      throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_TARGET_INVALID);
    }
    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await this.lockActivity(activityId, tx);
        await this.policy.assertOwnerOrOverride(tx, activityId, user);
        await this.lockMembers([dto.memberId], tx);
        await this.assertActiveTarget(dto.memberId, tx);
        const activity = await tx.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: { organizationId: true, title: true },
        });
        await this.assertCollaboratorEligible(
          activityId,
          dto.memberId,
          activity.organizationId,
          tx,
        );
        const now = new Date();
        const assignment = await this.createCollaborator(tx, {
          activityId,
          memberId: dto.memberId,
          actorUserId: user.id,
          canManageRegistrations: dto.canManageRegistrations,
          canManageAttendance: dto.canManageAttendance,
          reason: dto.reason?.trim() || undefined,
          source: 'delegation',
          now,
        });
        await this.audit.log({
          activityId,
          operation: 'responsibility-collaborator-create',
          assignmentId: assignment.id,
          targetMemberId: dto.memberId,
          canManageRegistrations: dto.canManageRegistrations,
          canManageAttendance: dto.canManageAttendance,
          source: 'delegation',
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        return {
          assignment,
          effect: {
            memberId: dto.memberId,
            title: '你已被指定为活动协办人',
            body: `你已成为「${activity.title}」的活动协办人。`,
          },
        };
      });
      await this.dispatch(result.effect);
      return this.toAssignmentDto(result.assignment);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS);
      }
      throw error;
    }
  }

  async endCollaborator(
    activityId: string,
    assignmentId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponsibilityAssignmentDto> {
    this.assertWorkflowEnabled();
    const seed = await this.prisma.activityResponsibilityAssignment.findFirst({
      where: { id: assignmentId, activityId, responsibilityType: 'collaborator' },
      select: { memberId: true },
    });
    if (!seed) throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_NOT_FOUND);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockActivity(activityId, tx);
      await this.policy.assertOwnerOrOverride(tx, activityId, user);
      await this.lockMembers([seed.memberId], tx);
      await this.lockAssignment(assignmentId, tx);
      const assignment = await tx.activityResponsibilityAssignment.findFirst({
        where: {
          id: assignmentId,
          activityId,
          responsibilityType: 'collaborator',
          status: 'active',
        },
        select: assignmentSelect,
      });
      if (!assignment) throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_NOT_FOUND);
      const activity = await tx.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { title: true },
      });
      const now = new Date();
      await this.endAssignment(tx, assignment, user.id, now);
      await this.audit.log({
        activityId,
        operation: 'responsibility-collaborator-end',
        assignmentId,
        targetMemberId: assignment.memberId,
        actorUserId: user.id,
        actorRoleSnap: user.role,
        auditMeta,
        tx,
      });
      return {
        assignment: { ...assignment, status: 'ended', endedAt: now, endedByUserId: user.id },
        effect: {
          memberId: assignment.memberId,
          title: '活动协办职责已结束',
          body: `你在「${activity.title}」中的活动协办职责已结束。`,
        },
      };
    });
    await this.dispatch(result.effect);
    return this.toAssignmentDto(result.assignment);
  }

  async transferOwner(
    activityId: string,
    dto: TransferActivityOwnerDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponsibilitiesResponseDto> {
    this.assertWorkflowEnabled();
    const effect = await this.prisma.$transaction(async (tx) => {
      await this.lockActivity(activityId, tx);
      await this.policy.assertOwnerOrOverride(tx, activityId, user);
      const currentOwnerSeed = await tx.activityResponsibilityAssignment.findFirst({
        where: { activityId, responsibilityType: 'owner', status: 'active' },
        select: { memberId: true },
      });
      if (!currentOwnerSeed) throw new BizException(BizCode.ACTIVITY_LEGACY_OWNER_REQUIRED);
      if (currentOwnerSeed.memberId === dto.newOwnerMemberId) {
        throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS);
      }
      await this.lockMembers([currentOwnerSeed.memberId, dto.newOwnerMemberId], tx);
      await this.assertActiveTarget(dto.newOwnerMemberId, tx, { formal: true });
      const currentOwner = await tx.activityResponsibilityAssignment.findFirst({
        where: { activityId, responsibilityType: 'owner', status: 'active' },
        select: assignmentSelect,
      });
      if (!currentOwner) throw new BizException(BizCode.ACTIVITY_LEGACY_OWNER_REQUIRED);
      const newOwnerCollaborator = await tx.activityResponsibilityAssignment.findFirst({
        where: { activityId, memberId: dto.newOwnerMemberId, status: 'active' },
        select: assignmentSelect,
      });
      const now = new Date();
      if (newOwnerCollaborator) {
        await this.endAssignment(tx, newOwnerCollaborator, user.id, now);
      }
      await this.endAssignment(tx, currentOwner, user.id, now);
      const newOwner = await this.createOwner(tx, {
        activityId,
        memberId: dto.newOwnerMemberId,
        actorUserId: user.id,
        source: 'transfer',
        reason: dto.reason.trim(),
        now,
      });
      if (dto.retainPreviousOwnerAsCollaborator) {
        await this.createCollaborator(tx, {
          activityId,
          memberId: currentOwner.memberId,
          actorUserId: user.id,
          canManageRegistrations: true,
          canManageAttendance: true,
          reason: dto.reason.trim(),
          source: 'transfer',
          now,
        });
      }
      await this.audit.log({
        activityId,
        operation: 'responsibility-transfer',
        assignmentId: newOwner.id,
        targetMemberId: dto.newOwnerMemberId,
        source: 'transfer',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        auditMeta,
        tx,
      });
      const activity = await tx.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: {
          title: true,
          statusCode: true,
          initiator: {
            select: { id: true, memberNo: true, displayName: true, gradeCode: true },
          },
        },
      });
      const activeAssignments = await tx.activityResponsibilityAssignment.findMany({
        where: { activityId, status: 'active' },
        orderBy: [{ responsibilityType: 'asc' }, { startedAt: 'asc' }, { id: 'asc' }],
        select: assignmentSelect,
      });
      const responseOwner =
        activeAssignments.find((item) => item.responsibilityType === 'owner') ?? null;
      return {
        oldOwner: {
          memberId: currentOwner.memberId,
          title: '活动负责人已移交',
          body: `你已不再是「${activity.title}」的活动负责人。`,
        },
        newOwner: {
          memberId: dto.newOwnerMemberId,
          title: '你已成为活动负责人',
          body: `你已成为「${activity.title}」的活动负责人。`,
        },
        response: {
          activityId,
          initiator: activity.initiator,
          owner: responseOwner ? this.toAssignmentDto(responseOwner) : null,
          collaborators: activeAssignments
            .filter((item) => item.responsibilityType === 'collaborator')
            .map((item) => this.toAssignmentDto(item)),
          legacyUnassigned:
            (activity.statusCode === 'draft' && activity.initiator === null) ||
            (activity.statusCode === 'published' && responseOwner === null),
        } satisfies ActivityResponsibilitiesResponseDto,
      };
    });
    await Promise.all([this.dispatch(effect.oldOwner), this.dispatch(effect.newOwner)]);
    return effect.response;
  }

  async claimLegacy(
    activityId: string,
    dto: ClaimLegacyActivityDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponsibilityAssignmentDto> {
    this.assertWorkflowEnabled();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockActivity(activityId, tx);
        await this.policy.assertOverride(activityId, user);
        const activity = await tx.activity.findUniqueOrThrow({
          where: { id: activityId },
          select: { statusCode: true },
        });
        if (activity.statusCode !== 'published') {
          throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
        }
        await this.lockMembers([dto.ownerMemberId], tx);
        const existing = await tx.activityResponsibilityAssignment.count({
          where: { activityId, status: 'active' },
        });
        if (existing > 0) {
          throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS);
        }
        const now = new Date();
        const assignment = await this.createOwner(tx, {
          activityId,
          memberId: dto.ownerMemberId,
          actorUserId: user.id,
          source: 'legacy-claim',
          reason: dto.reason.trim(),
          now,
        });
        await this.audit.log({
          activityId,
          operation: 'responsibility-legacy-claim',
          assignmentId: assignment.id,
          targetMemberId: dto.ownerMemberId,
          source: 'legacy-claim',
          actorUserId: user.id,
          actorRoleSnap: user.role,
          auditMeta,
          tx,
        });
        return this.toAssignmentDto(assignment);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS);
      }
      throw error;
    }
  }

  async assignLegacyInitiator(
    activityId: string,
    dto: AssignLegacyActivityInitiatorDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<ActivityResponsibilitiesResponseDto> {
    this.assertWorkflowEnabled();
    await this.prisma.$transaction(async (tx) => {
      await this.lockActivity(activityId, tx);
      await this.policy.assertOverride(activityId, user);
      await this.lockMembers([dto.memberId], tx);
      await this.assertActiveTarget(dto.memberId, tx, { formal: true });
      const activity = await tx.activity.findUniqueOrThrow({
        where: { id: activityId },
        select: { statusCode: true, initiatorMemberId: true },
      });
      if (activity.statusCode !== 'draft') {
        throw new BizException(BizCode.ACTIVITY_STATUS_INVALID);
      }
      if (activity.initiatorMemberId !== null) {
        throw new BizException(BizCode.ACTIVITY_RESPONSIBILITY_ALREADY_EXISTS);
      }
      await tx.activity.update({
        where: { id: activityId },
        data: { initiatorMemberId: dto.memberId },
      });
      await this.audit.log({
        activityId,
        operation: 'responsibility-assign-initiator',
        targetMemberId: dto.memberId,
        source: 'admin',
        actorUserId: user.id,
        actorRoleSnap: user.role,
        auditMeta,
        tx,
      });
    });
    return this.list(activityId, user);
  }
}
