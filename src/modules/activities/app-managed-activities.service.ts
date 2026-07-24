import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { MemberStatus, MembershipStatus, OrganizationStatus } from '@prisma/client';
import type { CurrentUserPayload } from '../../common/decorators/current-user.decorator';
import { BizCode } from '../../common/exceptions/biz-code.constant';
import { BizException } from '../../common/exceptions/biz.exception';
import { PrismaService } from '../../database/prisma.service';
import appConfig from '../../config/app.config';
import type { AuditMeta } from '../audit-logs/audit-logs.types';
import { AuthzService } from '../authz/authz.service';
import { ActivityAuditRecorder } from './activity-audit-recorder';
import type {
  CreateActivityPositionDto,
  UpdateActivityPositionDto,
} from './activity-positions.dto';
import { ActivityPositionsService } from './activity-positions.service';
import { ActivityPublishReviewService } from './activity-publish-review.service';
import { ActivityWorkflowQueryService } from './activity-workflow-query.service';
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

@Injectable()
export class AppManagedActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthzService,
    private readonly activities: ActivitiesService,
    private readonly positions: ActivityPositionsService,
    private readonly reviews: ActivityPublishReviewService,
    private readonly responsibilities: ActivityResponsibilityService,
    private readonly workflowQuery: ActivityWorkflowQueryService,
    private readonly auditRecorder: ActivityAuditRecorder,
    @Inject(appConfig.KEY)
    private readonly config: ConfigType<typeof appConfig>,
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

  async list(memberId: string, query: AppManagedActivitiesQueryDto) {
    return this.workflowQuery.list(memberId, query);
  }

  async detail(
    activityId: string,
    memberId: string,
    user: CurrentUserPayload,
  ): Promise<AppManagedActivityDetailDto> {
    return this.workflowQuery.detail(activityId, memberId, user);
  }

  async create(
    dto: CreateActivityDto,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivityDetailDto> {
    if (!this.config.activityResponsibilityWorkflow.enabled) {
      throw new BizException(BizCode.ACTIVITY_ATTENDANCE_DECLARATION_INVALID);
    }
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

  async declareAttendanceComplete(
    activityId: string,
    user: CurrentUserPayload,
    auditMeta: AuditMeta,
  ): Promise<AppManagedActivityDetailDto> {
    if (!user.memberId) throw new BizException(BizCode.FORBIDDEN);
    const memberId = user.memberId;
    await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Activity"
        WHERE id = ${activityId} AND "deletedAt" IS NULL
        FOR UPDATE
      `;
      if (locked.length === 0) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

      const activity = await tx.activity.findFirst({
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
        select: {
          statusCode: true,
          endAt: true,
          attendanceDeclaredCompleteAt: true,
        },
      });
      if (!activity) throw new BizException(BizCode.ACTIVITY_NOT_FOUND);

      const declaredAt = new Date();
      if (
        !['published', 'completed'].includes(activity.statusCode) ||
        activity.endAt.getTime() >= declaredAt.getTime() ||
        activity.attendanceDeclaredCompleteAt !== null
      ) {
        throw new BizException(BizCode.ACTIVITY_ATTENDANCE_DECLARATION_INVALID);
      }

      await tx.activity.update({
        where: { id: activityId },
        data: {
          attendanceDeclaredCompleteAt: declaredAt,
          attendanceDeclaredCompleteByUserId: user.id,
        },
      });
      await this.auditRecorder.logAttendanceDeclaration({
        activityId,
        actorUserId: user.id,
        actorRoleSnap: user.role,
        declaredAt,
        auditMeta,
        tx,
      });
    });
    return this.detail(activityId, memberId, user);
  }

  async listPositions(activityId: string, memberId: string) {
    await this.workflowQuery.loadManaged(activityId, memberId);
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
    const activity = await this.workflowQuery.loadOwned(activityId, memberId);
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

  private async assertFormalMember(memberId: string): Promise<void> {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, status: MemberStatus.ACTIVE, deletedAt: null },
      select: { gradeCode: true },
    });
    if (!member?.gradeCode || !FORMAL_GRADES.has(member.gradeCode)) {
      throw new BizException(BizCode.ACTIVITY_INITIATOR_NOT_FORMAL);
    }
  }
}
