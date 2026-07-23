import { Injectable } from '@nestjs/common';
import { MemberStatus, MembershipStatus, OrganizationStatus, Prisma } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import type { PageResultDto } from '../../common/dto/pagination.dto';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import type {
  CreateActivityPositionDto,
  UpdateActivityPositionDto,
} from './activity-positions.dto';
import { ActivityPositionsService } from './activity-positions.service';
import { ActivityPublishReviewService } from './activity-publish-review.service';
import type {
  CreateActivityCollaboratorDto,
  TransferActivityOwnerDto,
} from './activity-responsibility.dto';
import { ActivityResponsibilityService } from './activity-responsibility.service';
import type { CreateActivityDto, UpdateActivityDto } from './activities.dto';
import { ActivitiesService } from './activities.service';
import type {
  AppActivityChangePositionDto,
  AppActivityInitiationOrganizationOptionDto,
  AppCollaboratorOptionsResponseDto,
  AppManagedActivitiesQueryDto,
  AppManagedActivityDetailDto,
  AppManagedActivityListItemDto,
  AppManagedActivityProjectionDto,
} from './dto/app/app-managed-activity.dto';

const FORMAL_GRADES = new Set([
  'level-1',
  'level-2',
  'level-3',
  'level-4',
  'level-5',
  'level-6',
  'level-7',
]);

const managedActivitySelect = {
  id: true,
  title: true,
  activityTypeCode: true,
  organizationId: true,
  startAt: true,
  endAt: true,
  location: true,
  description: true,
  capacity: true,
  statusCode: true,
  workflowRevision: true,
  requiresInsurance: true,
  isPublicRegistration: true,
  attendanceDeclaredCompleteAt: true,
  createdAt: true,
  updatedAt: true,
  initiator: {
    select: { id: true, memberNo: true, displayName: true, gradeCode: true },
  },
  responsibilityAssignments: {
    where: { status: 'active' },
    select: {
      memberId: true,
      responsibilityType: true,
      canManageRegistrations: true,
      canManageAttendance: true,
      member: {
        select: { id: true, memberNo: true, displayName: true, gradeCode: true },
      },
    },
  },
  publishReviews: {
    orderBy: [{ requestVersion: 'desc' }],
    take: 1,
    select: {
      id: true,
      requestType: true,
      status: true,
      reviewNote: true,
    },
  },
  _count: {
    select: {
      registrations: { where: { deletedAt: null } },
      attendanceSheets: { where: { deletedAt: null } },
    },
  },
} as const satisfies Prisma.ActivitySelect;

type ManagedActivityRow = Prisma.ActivityGetPayload<{ select: typeof managedActivitySelect }>;

@Injectable()
export class AppManagedActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly activities: ActivitiesService,
    private readonly positions: ActivityPositionsService,
    private readonly reviews: ActivityPublishReviewService,
    private readonly responsibilities: ActivityResponsibilityService,
  ) {}

  async organizationOptions(
    user: CurrentUserPayload,
    memberId: string,
  ): Promise<AppActivityInitiationOrganizationOptionDto[]> {
    await this.assertFormalMember(memberId);
    const now = new Date();
    const [memberships, crossOrgScope] = await Promise.all([
      this.prisma.memberOrganizationMembership.findMany({
        where: {
          memberId,
          status: MembershipStatus.ACTIVE,
          deletedAt: null,
          startedAt: { lte: now },
          OR: [{ endedAt: null }, { endedAt: { gt: now } }],
          organization: {
            status: OrganizationStatus.ACTIVE,
            deletedAt: null,
            parentId: { not: null },
          },
        },
        select: {
          organizationId: true,
          membershipType: true,
          organization: { select: { id: true, name: true, parentId: true } },
        },
      }),
      this.authz.getVisibleOrganizationScope(user, 'activity.create.cross-org'),
    ]);
    const membershipByOrg = new Map(memberships.map((row) => [row.organizationId, row]));
    const crossOrgIds = crossOrgScope.hasPermission
      ? crossOrgScope.global
        ? undefined
        : crossOrgScope.organizationIds
      : [];
    const organizations = await this.prisma.organization.findMany({
      where: {
        status: OrganizationStatus.ACTIVE,
        deletedAt: null,
        parentId: { not: null },
        ...(crossOrgIds === undefined
          ? {}
          : { id: { in: [...new Set([...membershipByOrg.keys(), ...crossOrgIds])] } }),
      },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    const closureRows =
      organizations.length === 0
        ? []
        : await this.prisma.organizationClosure.findMany({
            where: { descendantId: { in: organizations.map((organization) => organization.id) } },
            select: {
              descendantId: true,
              depth: true,
              ancestor: { select: { name: true } },
            },
            orderBy: [{ descendantId: 'asc' }, { depth: 'desc' }],
          });
    const pathPartsByOrg = new Map<string, string[]>();
    for (const row of closureRows) {
      const parts = pathPartsByOrg.get(row.descendantId) ?? [];
      parts.push(row.ancestor.name);
      pathPartsByOrg.set(row.descendantId, parts);
    }
    return organizations
      .filter((organization) => membershipByOrg.has(organization.id) || crossOrgScope.hasPermission)
      .map((organization) => {
        const membership = membershipByOrg.get(organization.id);
        return {
          organizationId: organization.id,
          name: organization.name,
          pathLabel: (pathPartsByOrg.get(organization.id) ?? [organization.name]).join(' / '),
          source: membership ? 'membership' : 'cross-org-grant',
          membershipType: membership?.membershipType ?? null,
        };
      });
  }

  async list(
    memberId: string,
    query: AppManagedActivitiesQueryDto,
  ): Promise<PageResultDto<AppManagedActivityListItemDto>> {
    const where: Prisma.ActivityWhereInput = {
      deletedAt: null,
      ...(query.statusCode ? { statusCode: query.statusCode } : {}),
      OR: [
        { initiatorMemberId: memberId },
        { responsibilityAssignments: { some: { memberId, status: 'active' } } },
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.activity.findMany({
        where,
        select: managedActivitySelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.activity.count({ where }),
    ]);
    const activityIds = rows.map((row) => row.id);
    const [registrationCounts, unresolvedAttendanceCounts] =
      activityIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.prisma.activityRegistration.groupBy({
              by: ['activityId', 'statusCode'],
              where: {
                activityId: { in: activityIds },
                deletedAt: null,
                statusCode: { in: ['pending', 'waitlisted'] },
              },
              _count: { _all: true },
            }),
            this.prisma.attendanceSheet.groupBy({
              by: ['activityId'],
              where: {
                activityId: { in: activityIds },
                deletedAt: null,
                statusCode: { notIn: ['approved', 'rejected', 'final_rejected'] },
              },
              _count: { _all: true },
            }),
          ]);
    const pendingByActivity = new Map<string, number>();
    for (const group of registrationCounts) {
      if (group.statusCode === 'pending') {
        pendingByActivity.set(group.activityId, group._count._all);
      }
    }
    const unresolvedByActivity = new Map(
      unresolvedAttendanceCounts.map((group) => [group.activityId, group._count._all]),
    );
    return {
      items: rows.map((row) => {
        const assignment = row.responsibilityAssignments.find((item) => item.memberId === memberId);
        const relationship =
          assignment?.responsibilityType === 'owner'
            ? 'owner'
            : assignment?.responsibilityType === 'collaborator'
              ? 'collaborator'
              : 'initiator';
        return {
          activityId: row.id,
          title: row.title,
          statusCode: row.statusCode,
          startAt: row.startAt,
          endAt: row.endAt,
          relationship,
          pendingRegistrations: pendingByActivity.get(row.id) ?? 0,
          unresolvedAttendanceSheets: unresolvedByActivity.get(row.id) ?? 0,
          nextAction: this.deriveNextAction(row, unresolvedByActivity.get(row.id) ?? 0),
        };
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async detail(
    activityId: string,
    memberId: string,
    user: CurrentUserPayload,
  ): Promise<AppManagedActivityDetailDto> {
    const row = await this.loadManaged(activityId, memberId);
    const [pendingRegistrations, waitlistedRegistrations, unresolvedAttendanceSheets, canPublish] =
      await Promise.all([
        this.prisma.activityRegistration.count({
          where: { activityId, statusCode: 'pending', deletedAt: null },
        }),
        this.prisma.activityRegistration.count({
          where: { activityId, statusCode: 'waitlisted', deletedAt: null },
        }),
        this.prisma.attendanceSheet.count({
          where: {
            activityId,
            deletedAt: null,
            statusCode: { notIn: ['approved', 'rejected', 'final_rejected'] },
          },
        }),
        this.authz.can(user, 'activity.publish.record', { type: 'activity', id: activityId }),
      ]);
    const owner = row.responsibilityAssignments.find(
      (assignment) => assignment.responsibilityType === 'owner',
    );
    const mine = row.responsibilityAssignments.find(
      (assignment) => assignment.memberId === memberId,
    );
    const latest = row.publishReviews[0] ?? null;
    return {
      activity: this.toProjection(row),
      initiator: row.initiator,
      owner: owner?.member ?? null,
      myResponsibility: mine
        ? {
            responsibilityType: mine.responsibilityType === 'owner' ? 'owner' : 'collaborator',
            canManageRegistrations: mine.canManageRegistrations,
            canManageAttendance: mine.canManageAttendance,
          }
        : null,
      publishReview: {
        latestRequestId: latest?.id ?? null,
        requestType:
          latest?.requestType === 'initial' || latest?.requestType === 'change'
            ? latest.requestType
            : null,
        status:
          latest?.status === 'pending' ||
          latest?.status === 'approved' ||
          latest?.status === 'returned' ||
          latest?.status === 'withdrawn' ||
          latest?.status === 'cancelled'
            ? latest.status
            : null,
        reviewNote: latest?.reviewNote ?? null,
        canDirectPublish: row.initiator?.id === memberId && canPublish,
      },
      counts: {
        pendingRegistrations,
        waitlistedRegistrations,
        attendanceSheets: row._count.attendanceSheets,
        unresolvedAttendanceSheets,
      },
      closure: {
        attendanceDeclaredCompleteAt: row.attendanceDeclaredCompleteAt,
        status: this.deriveClosureStatus(row, unresolvedAttendanceSheets),
        nextAction: this.deriveNextAction(row, unresolvedAttendanceSheets),
      },
    };
  }

  async create(
    dto: CreateActivityDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivityDetailDto> {
    if (!user.memberId) throw new BizException(BizCode.FORBIDDEN);
    const created = await this.activities.create(dto, user, auditMeta, 'managed');
    return this.detail(created.id, user.memberId, user);
  }

  async update(
    activityId: string,
    dto: UpdateActivityDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivityDetailDto> {
    if (!user.memberId) throw new BizException(BizCode.FORBIDDEN);
    await this.activities.update(activityId, dto, user, auditMeta, 'managed');
    return this.detail(activityId, user.memberId, user);
  }

  async softDelete(
    activityId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivityProjectionDto> {
    const deleted = await this.activities.softDelete(activityId, user, auditMeta, 'managed');
    return {
      id: deleted.id,
      title: deleted.title,
      activityTypeCode: deleted.activityTypeCode,
      organizationId: deleted.organizationId,
      startAt: deleted.startAt,
      endAt: deleted.endAt,
      location: deleted.location,
      description: deleted.description,
      capacity: deleted.capacity,
      statusCode: deleted.statusCode,
      workflowRevision: deleted.workflowRevision,
      requiresInsurance: deleted.requiresInsurance,
      isPublicRegistration: deleted.isPublicRegistration,
      createdAt: deleted.createdAt,
      updatedAt: deleted.updatedAt,
    };
  }

  async submitInitial(activityId: string, user: CurrentUserPayload, auditMeta: AuditMeta) {
    return this.reviews.submitInitial(activityId, user, auditMeta);
  }

  async submitChange(
    activityId: string,
    activityPatch: UpdateActivityDto,
    positions: AppActivityChangePositionDto[] | undefined,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.reviews.submitChange(activityId, activityPatch, positions, user, auditMeta);
  }

  async directPublish(
    activityId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivityDetailDto> {
    if (!user.memberId) throw new BizException(BizCode.FORBIDDEN);
    await this.reviews.compatibilityPublish(
      activityId,
      { requiresInsuranceConfirmed: true },
      user,
      auditMeta,
    );
    return this.detail(activityId, user.memberId, user);
  }

  async withdraw(activityId: string, user: CurrentUserPayload, auditMeta: AuditMeta) {
    const pending = await this.prisma.activityPublishReview.findFirst({
      where: { activityId, status: 'pending', submittedByUserId: user.id },
      orderBy: { requestVersion: 'desc' },
      select: { id: true },
    });
    if (!pending) throw new BizException(BizCode.ACTIVITY_PUBLISH_REVIEW_NOT_FOUND);
    return this.reviews.withdraw(pending.id, user, auditMeta);
  }

  async listPositions(activityId: string, memberId: string) {
    await this.loadManaged(activityId, memberId);
    return this.positions.list(activityId);
  }

  async createPosition(
    activityId: string,
    dto: CreateActivityPositionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.positions.create(activityId, dto, user, auditMeta, 'managed');
  }

  async updatePosition(
    activityId: string,
    activityPositionId: string,
    dto: UpdateActivityPositionDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.positions.update(activityId, activityPositionId, dto, user, auditMeta, 'managed');
  }

  async deletePosition(
    activityId: string,
    activityPositionId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.positions.softDelete(activityId, activityPositionId, user, auditMeta, 'managed');
  }

  async collaboratorOptions(
    activityId: string,
    memberId: string,
  ): Promise<AppCollaboratorOptionsResponseDto> {
    const activity = await this.loadOwned(activityId, memberId);
    const now = new Date();
    const participantRows = await this.prisma.activityRegistration.findMany({
      where: { activityId, statusCode: 'pass', deletedAt: null },
      select: { memberId: true },
      distinct: ['memberId'],
    });
    const participantMemberIds = new Set(participantRows.map((row) => row.memberId));
    const members = await this.prisma.member.findMany({
      where: {
        status: MemberStatus.ACTIVE,
        deletedAt: null,
        users: { some: { status: 'ACTIVE', deletedAt: null } },
        activityResponsibilities: {
          none: { activityId, status: 'active' },
        },
        OR: [
          {
            activityRegistrations: {
              some: { activityId, statusCode: 'pass', deletedAt: null },
            },
          },
          {
            memberOrganizationMemberships: {
              some: {
                organizationId: activity.organizationId,
                status: MembershipStatus.ACTIVE,
                deletedAt: null,
                startedAt: { lte: now },
                OR: [{ endedAt: null }, { endedAt: { gt: now } }],
              },
            },
          },
        ],
      },
      select: {
        id: true,
        memberNo: true,
        displayName: true,
        gradeCode: true,
      },
      orderBy: [{ memberNo: 'asc' }, { id: 'asc' }],
      take: 200,
    });
    return {
      items: members.map((member) => ({
        id: member.id,
        memberNo: member.memberNo,
        displayName: member.displayName,
        gradeCode: member.gradeCode,
        eligibilitySource: participantMemberIds.has(member.id)
          ? 'participant'
          : 'organization-member',
      })),
    };
  }

  async listResponsibilities(activityId: string, memberId: string) {
    return this.responsibilities.listManaged(activityId, memberId);
  }

  async addCollaborator(
    activityId: string,
    dto: CreateActivityCollaboratorDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.responsibilities.addCollaborator(activityId, dto, user, auditMeta, 'owner');
  }

  async endCollaborator(
    activityId: string,
    assignmentId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.responsibilities.endCollaborator(
      activityId,
      assignmentId,
      user,
      auditMeta,
      'owner',
    );
  }

  async transferOwner(
    activityId: string,
    dto: TransferActivityOwnerDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ) {
    return this.responsibilities.transferOwner(activityId, dto, user, auditMeta, 'owner');
  }

  private async loadOwned(activityId: string, memberId: string): Promise<ManagedActivityRow> {
    const activity = await this.prisma.activity.findFirst({
      where: {
        id: activityId,
        deletedAt: null,
        responsibilityAssignments: {
          some: {
            memberId,
            responsibilityType: 'owner',
            status: 'active',
          },
        },
      },
      select: managedActivitySelect,
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private async loadManaged(activityId: string, memberId: string): Promise<ManagedActivityRow> {
    const activity = await this.prisma.activity.findFirst({
      where: {
        id: activityId,
        deletedAt: null,
        OR: [
          { initiatorMemberId: memberId },
          { responsibilityAssignments: { some: { memberId, status: 'active' } } },
        ],
      },
      select: managedActivitySelect,
    });
    if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);
    return activity;
  }

  private async assertFormalMember(memberId: string): Promise<void> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, status: MemberStatus.ACTIVE, deletedAt: null },
      select: { gradeCode: true },
    });
    if (!member?.gradeCode || !FORMAL_GRADES.has(member.gradeCode)) {
      throw new BizException(BizCode.ACTIVITY_INITIATOR_NOT_FORMAL);
    }
  }

  private toProjection(row: ManagedActivityRow): AppManagedActivityProjectionDto {
    return {
      id: row.id,
      title: row.title,
      activityTypeCode: row.activityTypeCode,
      organizationId: row.organizationId,
      startAt: row.startAt,
      endAt: row.endAt,
      location: row.location,
      description: row.description,
      capacity: row.capacity,
      statusCode: row.statusCode,
      workflowRevision: row.workflowRevision,
      requiresInsurance: row.requiresInsurance,
      isPublicRegistration: row.isPublicRegistration,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private deriveClosureStatus(
    row: ManagedActivityRow,
    unresolvedAttendanceSheets: number,
  ): AppManagedActivityDetailDto['closure']['status'] {
    if (row.statusCode === 'draft') {
      return row.publishReviews[0]?.status === 'pending' ? 'publish-review-pending' : 'draft';
    }
    if (row.statusCode === 'completed') return 'closed';
    if (row.attendanceDeclaredCompleteAt === null) {
      return row.endAt.getTime() < Date.now() ? 'waiting-attendance-declaration' : 'published';
    }
    if (unresolvedAttendanceSheets === 0) return 'closed';
    return 'attendance-first-review';
  }

  private deriveNextAction(
    row: ManagedActivityRow,
    unresolvedAttendanceSheets: number,
  ): string | null {
    if (row.statusCode === 'draft') {
      return row.publishReviews[0]?.status === 'pending' ? '等待发布审核' : '提交发布审核';
    }
    if (
      row.statusCode === 'published' &&
      row.endAt.getTime() < Date.now() &&
      row.attendanceDeclaredCompleteAt === null
    ) {
      return '声明考勤已全部提交';
    }
    if (row.attendanceDeclaredCompleteAt !== null && unresolvedAttendanceSheets > 0) {
      return '跟进未完成考勤单';
    }
    return null;
  }
}
