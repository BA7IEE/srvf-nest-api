import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { RbacService } from '../permissions/rbac.service';
import { ActivityInvitationAuditRecorder } from './activity-invitation-audit-recorder';
import type {
  AppActivityVisitorDto,
  AppManagedActivityVisitorsQueryDto,
  CreateAppManagedActivityVisitorDto,
} from './dto/app/app-activity-visitor.dto';

type PrismaTx = Prisma.TransactionClient;

const visitorSelect = {
  id: true,
  activityId: true,
  sessionId: true,
  name: true,
  organization: true,
  invitedByMemberId: true,
  note: true,
  createdAt: true,
} as const satisfies Prisma.ActivityVisitorSelect;

type VisitorRow = Prisma.ActivityVisitorGetPayload<{ select: typeof visitorSelect }>;

@Injectable()
export class ActivityVisitorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly rbac: RbacService,
    private readonly audit: ActivityInvitationAuditRecorder,
  ) {}

  async list(
    activityId: string,
    query: AppManagedActivityVisitorsQueryDto,
    currentUser: CurrentUserPayload,
  ): Promise<PageResultDto<AppActivityVisitorDto>> {
    await this.assertAction(currentUser, 'activity-registration.read.record', activityId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivity(tx, activityId);
      await this.assertManagedResponsibility(tx, activityId, currentUser);

      const where = { activityId };
      const rows = await tx.activityVisitor.findMany({
        where,
        select: visitorSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      });
      const total = await tx.activityVisitor.count({ where });
      return {
        items: rows.map((row) => this.toDto(row)),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  async create(
    activityId: string,
    dto: CreateAppManagedActivityVisitorDto,
    currentUser: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppActivityVisitorDto> {
    await this.assertAction(currentUser, 'activity-registration.create.record', activityId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivity(tx, activityId);
      await this.assertManagedResponsibility(tx, activityId, currentUser);
      await this.assertLiveSession(tx, activityId, dto.sessionId);
      const invitedByMemberId = dto.invitedByMemberId ?? null;
      if (invitedByMemberId !== null) {
        const member = await tx.member.findFirst({
          where: { id: invitedByMemberId, deletedAt: null },
          select: { id: true },
        });
        if (member === null) throw new BizException(BizCode.MEMBER_NOT_FOUND);
      }

      // This writer deliberately touches only ActivityVisitor plus the same-transaction audit row.
      // attendanceCode remains null until the separately authorized registration contract exists.
      const visitor = await tx.activityVisitor.create({
        data: {
          activityId,
          sessionId: dto.sessionId,
          name: dto.name,
          organization: dto.organization ?? null,
          invitedByMemberId,
          note: dto.note ?? null,
          attendanceCode: null,
        },
        select: visitorSelect,
      });
      await this.audit.logVisitorCreate({
        visitorId: visitor.id,
        activityId,
        sessionId: visitor.sessionId,
        invitedByMemberProvided: invitedByMemberId !== null,
        actorUserId: currentUser.id,
        actorRoleSnap: currentUser.role,
        auditMeta,
        tx,
      });
      return this.toDto(visitor);
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

  private async assertLiveSession(
    tx: PrismaTx,
    activityId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await tx.activitySession.findFirst({
      where: { id: sessionId, activityId, deletedAt: null },
      select: { id: true },
    });
    // Existing/cross/deleted sessions all collapse to BAD_REQUEST: the caller learns no foreign id.
    if (session === null) throw new BizException(BizCode.BAD_REQUEST);
  }

  private toDto(row: VisitorRow): AppActivityVisitorDto {
    return {
      visitorId: row.id,
      activityId: row.activityId,
      sessionId: row.sessionId,
      name: row.name,
      organization: row.organization,
      invitedByMemberId: row.invitedByMemberId,
      note: row.note,
      createdAt: row.createdAt,
    };
  }
}
