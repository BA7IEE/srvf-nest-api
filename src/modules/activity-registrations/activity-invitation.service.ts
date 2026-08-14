import { Injectable } from '@nestjs/common';
import { MemberStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { ActivityInvitationAuditRecorder } from './activity-invitation-audit-recorder';
import { hashActivityInvitationDecline } from './activity-invitation-request-hash';
import { hashRegistrationCommand } from './registration-command-hash';
import {
  RegistrationCommandService,
  type RegistrationCommandReceipt,
} from './registration-command.service';
import type {
  ActivityInvitationScope,
  AppActivityInvitationDto,
  AppManagedActivityInvitationsQueryDto,
  CreateAppManagedActivityInvitationDto,
  DeclineAppMyActivityInvitationDto,
  RevokeAppManagedActivityInvitationDto,
} from './dto/app/app-activity-invitation.dto';
import type { AppActivityRegistrationCommandDto } from './dto/app/app-activity-registration-command.dto';

type PrismaTx = Prisma.TransactionClient;

const invitationSelect = {
  id: true,
  activityId: true,
  memberId: true,
  sessionId: true,
  positionId: true,
  statusCode: true,
  expiresAt: true,
  respondedAt: true,
  revokedAt: true,
  createdAt: true,
} as const satisfies Prisma.ActivityInvitationSelect;

type InvitationRow = Prisma.ActivityInvitationGetPayload<{ select: typeof invitationSelect }>;
type LockedDeclineInvitation = InvitationRow & {
  operationKey: string | null;
  requestHash: string | null;
};

@Injectable()
export class ActivityInvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly audit: ActivityInvitationAuditRecorder,
    private readonly registrationCommands: RegistrationCommandService,
  ) {}

  async list(
    activityId: string,
    query: AppManagedActivityInvitationsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AppActivityInvitationDto>> {
    await this.assertAction(currentUser, 'activity-registration.read.record', activityId);
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      await this.lockActivity(tx, activityId);
      await this.assertManagedResponsibility(tx, activityId, currentUser);

      const where = { activityId };
      const rows = await tx.activityInvitation.findMany({
        where,
        select: invitationSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      });
      const total = await tx.activityInvitation.count({ where });
      return {
        items: rows.map((row) => this.toDto(row, now)),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  async create(
    activityId: string,
    dto: CreateAppManagedActivityInvitationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppActivityInvitationDto> {
    await this.assertAction(currentUser, 'activity-registration.create.record', activityId);
    const now = new Date();
    const expiresAt = new Date(dto.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    const sessionId = dto.sessionId ?? null;
    const positionId = dto.positionId ?? null;
    if (positionId !== null && sessionId === null) {
      throw new BizException(BizCode.BAD_REQUEST);
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockActivity(tx, activityId);
        await this.assertManagedResponsibility(tx, activityId, currentUser);
        await this.assertActiveTargetMember(tx, dto.memberId);
        await this.assertInvitationScope(tx, activityId, sessionId, positionId);

        const pending = await this.lockPendingForScope(tx, activityId, dto.memberId, sessionId);
        const expired = pending.filter(
          (invitation) => invitation.expiresAt.getTime() <= now.getTime(),
        );
        if (expired.length > 0) {
          await tx.activityInvitation.updateMany({
            where: { id: { in: expired.map((invitation) => invitation.id) } },
            data: { statusCode: 'expired' },
          });
          for (const invitation of expired) {
            await this.audit.logInvitationChange({
              invitation: { ...invitation, statusCode: 'expired' },
              before: invitation,
              actorUserId: currentUser.id,
              actorRoleSnap: currentUser.role,
              operation: 'expire',
              auditMeta,
              tx,
            });
          }
        }
        if (pending.some((invitation) => invitation.expiresAt.getTime() > now.getTime())) {
          throw new BizException(BizCode.ACTIVITY_INVITATION_ALREADY_PENDING);
        }

        const created = await tx.activityInvitation.create({
          data: {
            activityId,
            memberId: dto.memberId,
            sessionId,
            positionId,
            statusCode: 'pending',
            expiresAt,
            invitedByUserId: currentUser.id,
          },
          select: invitationSelect,
        });
        await this.audit.logInvitationChange({
          invitation: created,
          actorUserId: currentUser.id,
          actorRoleSnap: currentUser.role,
          operation: 'create',
          auditMeta,
          tx,
        });
        return this.toDto(created, now);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BizException(BizCode.ACTIVITY_INVITATION_ALREADY_PENDING);
      }
      throw error;
    }
  }

  async revoke(
    activityId: string,
    invitationId: string,
    dto: RevokeAppManagedActivityInvitationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppActivityInvitationDto> {
    await this.assertAction(currentUser, 'activity-registration.cancel.record', activityId);
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      await this.lockActivity(tx, activityId);
      await this.assertManagedResponsibility(tx, activityId, currentUser);
      const invitation = await this.lockInvitationForManagedAction(tx, activityId, invitationId);
      if (invitation.statusCode !== 'pending' || invitation.expiresAt.getTime() <= now.getTime()) {
        throw new BizException(BizCode.ACTIVITY_INVITATION_STATUS_INVALID);
      }

      const updated = await tx.activityInvitation.update({
        where: { id: invitation.id },
        data: { statusCode: 'revoked', revokedAt: now, reason: dto.reason },
        select: invitationSelect,
      });
      await this.audit.logInvitationChange({
        invitation: updated,
        before: invitation,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        operation: 'revoke',
        auditMeta,
        tx,
      });
      return this.toDto(updated, now);
    });
  }

  async decline(
    invitationId: string,
    dto: DeclineAppMyActivityInvitationDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppActivityInvitationDto> {
    if (currentUser.memberId === null) {
      throw new BizException(BizCode.FORBIDDEN);
    }
    const reason = dto.reason ?? null;
    const requestHash = hashActivityInvitationDecline({
      actorUserId: currentUser.id,
      memberId: currentUser.memberId,
      invitationId,
      reason,
    });
    const invitationRoot = await this.prisma.activityInvitation.findFirst({
      where: { id: invitationId },
      select: { activityId: true },
    });
    if (invitationRoot === null) {
      throw new BizException(BizCode.ACTIVITY_INVITATION_NOT_FOUND);
    }
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      // The first read only establishes the Activity root.  The write path itself is always
      // Activity -> Invitation, and rechecks the member predicate after both locks are held.
      await this.lockActivity(tx, invitationRoot.activityId);
      const invitation = await this.lockInvitationForDecline(
        tx,
        invitationRoot.activityId,
        invitationId,
        currentUser.memberId!,
      );
      if (invitation.operationKey === dto.operationKey) {
        if (invitation.requestHash !== requestHash) {
          throw new BizException(BizCode.ACTIVITY_INVITATION_OPERATION_KEY_CONFLICT);
        }
        return this.toDto(invitation, now);
      }
      if (invitation.statusCode !== 'pending' || invitation.expiresAt.getTime() <= now.getTime()) {
        throw new BizException(BizCode.ACTIVITY_INVITATION_STATUS_INVALID);
      }

      const updated = await tx.activityInvitation.update({
        where: { id: invitation.id },
        data: {
          statusCode: 'declined',
          respondedAt: now,
          reason,
          operationKey: dto.operationKey,
          requestHash,
        },
        select: invitationSelect,
      });
      await this.audit.logInvitationChange({
        invitation: updated,
        before: invitation,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        operation: 'decline',
        auditMeta,
        tx,
      });
      return this.toDto(updated, now);
    });
  }

  /**
   * Invitation acceptance owns only the invitation state transition and its immutable audit fact.
   * The registration itself deliberately goes through the canonical command, so it cannot bypass
   * Form, qualification, insurance, permanent identity, capacity or allocation mode behavior.
   */
  async accept(
    invitationId: string,
    dto: AppActivityRegistrationCommandDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<RegistrationCommandReceipt> {
    if (currentUser.memberId === null) throw new BizException(BizCode.FORBIDDEN);
    const invitationRoot = await this.prisma.activityInvitation.findFirst({
      where: { id: invitationId },
      select: { activityId: true },
    });
    if (invitationRoot === null) throw new BizException(BizCode.ACTIVITY_INVITATION_NOT_FOUND);
    const requestHash = hashRegistrationCommand({
      actorUserId: currentUser.id,
      memberId: currentUser.memberId,
      activityId: invitationRoot.activityId,
      source: 'invitation',
      invitationId,
      formVersion: dto.formVersion,
      answers: dto.answers,
      preferences: dto.preferences,
    });

    return this.prisma.$transaction(async (tx) => {
      // Fixed order remains Activity -> Invitation -> canonical registration facts.
      await this.lockActivity(tx, invitationRoot.activityId);
      const invitation = await this.lockInvitationForDecline(
        tx,
        invitationRoot.activityId,
        invitationId,
        currentUser.memberId!,
      );
      if (invitation.operationKey === dto.operationKey) {
        if (invitation.requestHash !== requestHash) {
          throw new BizException(BizCode.ACTIVITY_INVITATION_OPERATION_KEY_CONFLICT);
        }
        return this.registrationCommands.submitInTransactionTrusted({
          tx,
          activityId: invitation.activityId,
          dto,
          currentUser,
          memberId: currentUser.memberId!,
          requestHash,
          auditMeta,
          source: 'invitation',
        });
      }
      const now = new Date();
      if (invitation.statusCode !== 'pending' || invitation.expiresAt.getTime() <= now.getTime()) {
        throw new BizException(BizCode.ACTIVITY_INVITATION_STATUS_INVALID);
      }
      this.assertAcceptanceScope(invitation, dto);
      const receipt = await this.registrationCommands.submitInTransactionTrusted({
        tx,
        activityId: invitation.activityId,
        dto,
        currentUser,
        memberId: currentUser.memberId!,
        requestHash,
        auditMeta,
        source: 'invitation',
      });
      const updated = await tx.activityInvitation.update({
        where: { id: invitation.id },
        data: {
          statusCode: 'accepted',
          respondedAt: receipt.submittedAt,
          operationKey: dto.operationKey,
          requestHash,
        },
        select: invitationSelect,
      });
      await this.audit.logInvitationChange({
        invitation: updated,
        before: invitation,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        operation: 'accept',
        auditMeta,
        tx,
      });
      return receipt;
    });
  }

  private async assertAction(
    currentUser: CurrentUserPayload,
    action: string,
    activityId: string,
  ): Promise<void> {
    const decision = await this.authz.explain(currentUser, action, {
      type: 'activity',
      id: activityId,
    });
    if (decision.allow) return;
    if (decision.reason === 'resource_not_found' && (await this.rbac.can(currentUser, action))) {
      return;
    }
    throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private assertAcceptanceScope(
    invitation: Pick<InvitationRow, 'sessionId' | 'positionId'>,
    dto: AppActivityRegistrationCommandDto,
  ): void {
    if (invitation.sessionId === null) return;
    if (dto.preferences.length !== 1 || dto.preferences[0]?.sessionId !== invitation.sessionId) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
    if (invitation.positionId === null) return;
    const positionIds = dto.preferences[0]?.positionIds;
    if (
      !Array.isArray(positionIds) ||
      positionIds.length !== 1 ||
      positionIds[0] !== invitation.positionId
    ) {
      throw new BizException(BizCode.BAD_REQUEST);
    }
  }

  private async lockActivity(tx: PrismaTx, activityId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Activity"
      WHERE "id" = ${activityId} AND "deletedAt" IS NULL
      FOR UPDATE
    `);
    if (rows.length !== 1) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
  }

  private async assertManagedResponsibility(
    tx: PrismaTx,
    activityId: string,
    currentUser: CurrentUserPayload,
  ): Promise<void> {
    if (currentUser.memberId === null) {
      throw new BizException(BizCode.RBAC_FORBIDDEN);
    }
    const activity = await tx.activity.findFirst({
      where: {
        id: activityId,
        deletedAt: null,
        responsibilityAssignments: {
          some: {
            memberId: currentUser.memberId,
            status: 'active',
            canManageRegistrations: true,
          },
        },
      },
      select: { id: true },
    });
    if (activity === null) throw new BizException(BizCode.RBAC_FORBIDDEN);
  }

  private async assertActiveTargetMember(tx: PrismaTx, memberId: string): Promise<void> {
    const member = await tx.member.findFirst({
      where: { id: memberId, deletedAt: null },
      select: { status: true },
    });
    if (member === null) throw new BizException(BizCode.MEMBER_NOT_FOUND);
    if (member.status !== MemberStatus.ACTIVE) throw new BizException(BizCode.MEMBER_INACTIVE);
  }

  private async assertInvitationScope(
    tx: PrismaTx,
    activityId: string,
    sessionId: string | null,
    positionId: string | null,
  ): Promise<void> {
    if (sessionId !== null) {
      const session = await tx.activitySession.findFirst({
        where: {
          id: sessionId,
          activityId,
          deletedAt: null,
          statusCode: { not: 'cancelled' },
        },
        select: { id: true },
      });
      if (session === null) throw new BizException(BizCode.ACTIVITY_INVITATION_NOT_FOUND);
    }
    if (positionId !== null) {
      const position = await tx.activitySessionPosition.findFirst({
        where: { id: positionId, activityId, sessionId: sessionId!, deletedAt: null },
        select: { id: true },
      });
      if (position === null) throw new BizException(BizCode.ACTIVITY_INVITATION_NOT_FOUND);
    }
  }

  private async lockPendingForScope(
    tx: PrismaTx,
    activityId: string,
    memberId: string,
    sessionId: string | null,
  ): Promise<InvitationRow[]> {
    return tx.$queryRaw<InvitationRow[]>(Prisma.sql`
      SELECT
        "id", "activityId", "memberId", "sessionId", "positionId", "statusCode", "expiresAt",
        "respondedAt", "revokedAt", "createdAt"
      FROM "ActivityInvitation"
      WHERE "activityId" = ${activityId}
        AND "memberId" = ${memberId}
        AND "sessionId" IS NOT DISTINCT FROM ${sessionId}
        AND "statusCode" = 'pending'
      FOR UPDATE
    `);
  }

  private async lockInvitationForManagedAction(
    tx: PrismaTx,
    activityId: string,
    invitationId: string,
  ): Promise<InvitationRow> {
    const rows = await tx.$queryRaw<InvitationRow[]>(Prisma.sql`
      SELECT
        "id", "activityId", "memberId", "sessionId", "positionId", "statusCode", "expiresAt",
        "respondedAt", "revokedAt", "createdAt"
      FROM "ActivityInvitation"
      WHERE "id" = ${invitationId} AND "activityId" = ${activityId}
      FOR UPDATE
    `);
    const invitation = rows[0];
    if (invitation === undefined) throw new BizException(BizCode.ACTIVITY_INVITATION_NOT_FOUND);
    return invitation;
  }

  private async lockInvitationForDecline(
    tx: PrismaTx,
    activityId: string,
    invitationId: string,
    memberId: string,
  ): Promise<LockedDeclineInvitation> {
    const rows = await tx.$queryRaw<LockedDeclineInvitation[]>(Prisma.sql`
      SELECT
        "id", "activityId", "memberId", "sessionId", "positionId", "statusCode", "expiresAt",
        "respondedAt", "revokedAt", "createdAt", "operationKey", "requestHash"
      FROM "ActivityInvitation"
      WHERE "id" = ${invitationId}
        AND "activityId" = ${activityId}
        AND "memberId" = ${memberId}
      FOR UPDATE
    `);
    const invitation = rows[0];
    if (invitation === undefined) throw new BizException(BizCode.ACTIVITY_INVITATION_NOT_FOUND);
    return invitation;
  }

  private toDto(row: InvitationRow, now: Date): AppActivityInvitationDto {
    return {
      invitationId: row.id,
      activityId: row.activityId,
      memberId: row.memberId,
      sessionId: row.sessionId,
      positionId: row.positionId,
      scope: this.scopeOf(row),
      status:
        row.statusCode === 'pending' && row.expiresAt.getTime() <= now.getTime()
          ? 'expired'
          : row.statusCode,
      expiresAt: row.expiresAt,
      respondedAt: row.respondedAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    };
  }

  private scopeOf(row: Pick<InvitationRow, 'sessionId' | 'positionId'>): ActivityInvitationScope {
    if (row.positionId !== null) return 'position';
    if (row.sessionId !== null) return 'session';
    return 'activity';
  }
}
